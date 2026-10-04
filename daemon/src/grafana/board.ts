import { Context, Deferred, Effect, Layer } from "effect"
import { errorMessage } from "../domain/errors.ts"
import { now as nowIso } from "../domain/ids.ts"
import { Hub } from "../hub.ts"
import { type BoardSpec, dashboardLink, OVERVIEW_VIEWS, overviewBoard, type PanelSpec, type Unit } from "./boards.ts"
import { Grafana, type Series } from "./client.ts"

/** The wire shape of a board (docs/API.md `Board`). */
export interface Board {
  readonly title: string
  readonly from: string
  readonly to: string
  readonly stepSeconds: number
  readonly marker: string | null
  readonly panels: ReadonlyArray<Panel>
  readonly deploys: ReadonlyArray<Deploy>
  readonly fetchedAt: string
  /** Why there's nothing to show at all (Grafana MCP down); panels are then empty. */
  readonly error: string | null
}

export interface Panel {
  readonly id: string
  readonly title: string
  readonly unit: Unit
  readonly series: ReadonlyArray<{ readonly label: string; readonly points: ReadonlyArray<readonly [number, number]> }>
  /** The sum of every series' last point (one series: its last value), or null with no data. */
  readonly latest: number | null
  readonly link: string
  readonly error: string | null
}

/** A prod deploy (`engine` / `front-production` succeeded) or a deploy that failed at some stage. */
export interface Deploy {
  readonly at: string
  readonly image: string
  readonly version: string
  readonly stage: string
  readonly status: "deployed" | "failed"
}

export interface BoardsShape {
  /**
   * The board. Fresh from the cache when under a minute old; an older one comes back at
   * once while a new one is fetched; with none, waits for the fetch. One fetch per board
   * at a time, and it outlives the request that started it, so closing the popover
   * mid-fetch still leaves the board cached for the next open.
   */
  readonly build: (spec: BoardSpec) => Effect.Effect<Board>
  /** The board fetched now (or by the fetch already running), never from the cache; it is cached for `build`. */
  readonly latest: (spec: BoardSpec) => Effect.Effect<Board>
  /** Rebuilds the overview boards, so opening the popover never waits on a day of logs. */
  readonly warm: Effect.Effect<void>
}

export class Boards extends Context.Service<Boards, BoardsShape>()("Boards") {}

/** The overview covers an hour, so a minute-old board is as stale as it should get. */
const CACHE_MS = 60_000
const DEPLOY_LIMIT = 40
export const GRAFANA_DOWN = "Grafana MCP is down. Run `bun grafana:mcp` in the monorepo to see prod charts."

/** Only prod deploys and failures: a green build or staging step isn't a deploy. */
export const deploysQuery = (image: string | null) =>
  [
    `event:="deployment.step"`,
    image === null ? "" : `image:="${image}"`,
    `((status:="success" (stage:="engine" OR stage:="front-production")) OR status:="failure")`,
    `| fields _time, image, version, stage, status | sort by (_time) desc`,
  ]
    .filter((part) => part !== "")
    .join(" ")

export const toDeploy = (row: Readonly<Record<string, string>>): Deploy | undefined => {
  // VictoriaLogs stamps nanoseconds ("…35.199941147Z"); the API speaks milliseconds.
  const time = Date.parse((row._time ?? "").replace(/(\.\d{3})\d+/, "$1"))
  const status = row.status === "success" ? "deployed" : row.status === "failure" ? "failed" : undefined
  if (Number.isNaN(time) || status === undefined) return undefined
  return { at: new Date(time).toISOString(), image: row.image ?? "", version: row.version ?? "", stage: row.stage ?? "", status }
}

/**
 * A LogsQL `count()` has no bucket for a step with no matching line: that step
 * is a zero, not a gap. Fills every step of the window on the series' own grid.
 */
export const zeroFilled = (points: ReadonlyArray<readonly [number, number]>, from: Date, to: Date, step: number) => {
  const first = points[0]
  if (first === undefined) return points
  const byTime = new Map(points.map(([t, v]) => [t, v]))
  const start = first[0] - Math.floor((first[0] - from.getTime() / 1000) / step) * step
  const out: Array<readonly [number, number]> = []
  for (let t = start; t <= to.getTime() / 1000; t += step) out.push([t, byTime.get(t) ?? 0])
  return out
}

const seriesOf = (spec: PanelSpec, series: ReadonlyArray<Series>, board: BoardSpec) =>
  series
    .map((s) => ({
      label: spec.seriesLabel === undefined ? spec.title : (s.labels[spec.seriesLabel] ?? "other"),
      points: spec.source === "logs" && spec.unit === "count" ? zeroFilled(s.points, board.from, board.to, board.stepSeconds) : s.points,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

export const BoardsLive = Layer.effect(Boards)(
  Effect.gen(function* () {
    const grafana = yield* Grafana
    const hub = yield* Hub
    const cache = new Map<string, { readonly at: number; readonly board: Board }>()

    const panel = (spec: PanelSpec, board: BoardSpec): Effect.Effect<Panel> => {
      const range = { start: board.from, end: board.to, stepSeconds: board.stepSeconds }
      const query = spec.query(board.stepSeconds)
      const run = spec.source === "prom" ? grafana.prom(query, range) : grafana.logStats(query, range)
      const base = { id: spec.id, title: spec.title, unit: spec.unit, link: dashboardLink(spec.dashboard, board.from, board.to) }
      return run.pipe(
        Effect.map((series): Panel => {
          const shaped = seriesOf(spec, series, board)
          const lasts = shaped.flatMap((s) => s.points.at(-1)?.[1] ?? [])
          return { ...base, series: shaped, latest: lasts.length === 0 ? null : lasts.reduce((a, b) => a + b, 0), error: null }
        }),
        Effect.catch((error) => Effect.succeed<Panel>({ ...base, series: [], latest: null, error: errorMessage(error) })),
      )
    }

    const deploys = (spec: BoardSpec) =>
      grafana.logRows(deploysQuery(spec.deployImage), { start: spec.deploysFrom, end: spec.to, stepSeconds: 60 }, DEPLOY_LIMIT).pipe(
        Effect.map((rows) => rows.flatMap((row) => toDeploy(row) ?? [])),
        Effect.orElseSucceed((): ReadonlyArray<Deploy> => []),
      )

    const fresh = (spec: BoardSpec) =>
      Effect.gen(function* () {
        const envelope = {
          title: spec.title,
          from: spec.from.toISOString(),
          to: spec.to.toISOString(),
          stepSeconds: spec.stepSeconds,
          marker: spec.marker?.toISOString() ?? null,
          fetchedAt: nowIso(),
        }
        if ((yield* hub.status).grafanaMcp === "down") return { ...envelope, panels: [], deploys: [], error: GRAFANA_DOWN }
        const [panels, deployList] = yield* Effect.all(
          [Effect.forEach(spec.panels, (p) => panel(p, spec), { concurrency: "unbounded" }), deploys(spec)],
          { concurrency: 2 },
        )
        // Every panel failing is the connection, not the queries: say that once.
        const allFailed = panels.length > 0 && panels.every((p) => p.error !== null)
        return { ...envelope, panels: allFailed ? [] : panels, deploys: deployList, error: allFailed ? (panels[0]?.error ?? GRAFANA_DOWN) : null }
      })

    const inflight = new Map<string, Deferred.Deferred<Board>>()

    const refresh = (spec: BoardSpec): Effect.Effect<Board> =>
      Effect.gen(function* () {
        const running = inflight.get(spec.key)
        if (running !== undefined) return yield* Deferred.await(running)
        const done = yield* Deferred.make<Board>()
        inflight.set(spec.key, done)
        yield* fresh(spec).pipe(
          Effect.tap((board) =>
            Effect.sync(() => {
              // A failure is not cached, so the next open tries again.
              if (board.error === null) cache.set(spec.key, { at: Date.now(), board })
            }),
          ),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(done, exit)),
          Effect.ensuring(Effect.sync(() => inflight.delete(spec.key))),
          Effect.forkDetach,
        )
        return yield* Deferred.await(done)
      })

    return {
      build: (spec) =>
        Effect.gen(function* () {
          const hit = cache.get(spec.key)
          if (hit === undefined) return yield* refresh(spec)
          if (Date.now() - hit.at >= CACHE_MS) yield* Effect.forkDetach(refresh(spec))
          return hit.board
        }),
      latest: refresh,
      warm: Effect.forEach(OVERVIEW_VIEWS, (view) => refresh(overviewBoard(view, new Date())), { discard: true }),
    }
  }),
)
