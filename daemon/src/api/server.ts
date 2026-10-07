import { createHash, timingSafeEqual } from "node:crypto"
import { Cause, Data, Effect, Stream } from "effect"
import { Actions } from "../actions/actions.ts"
import { VERSION } from "../config.ts"
import { type DaemonError, errorMessage, NotFound, statusOf } from "../domain/errors.ts"
import { mergeSettings, SettingsPatch } from "../domain/settings.ts"
import { Boards } from "../grafana/board.ts"
import { alertBoard, type BoardSpec, OVERVIEW_VIEWS, type OverviewView, overviewBoard } from "../grafana/boards.ts"
import { Hub } from "../hub.ts"
import { Intake } from "../intake/intake.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { SlackMe } from "../slack/me.ts"
import { Store } from "../store/store.ts"
import { Watcher } from "../watch/watcher.ts"
import { MessageBody, pathId, PauseBody, readBody, ResolveBody } from "./requests.ts"
import { snapshotEvents, SSE_TIMING, type SseTiming } from "./sse.ts"
import { alertDetail, boardView, logSweep, snapshot } from "./views.ts"

type Services = Store | Hub | Actions | Intake | SessionRunner | Boards | SlackMe | Watcher

const isOverviewView = (value: string): value is OverviewView => OVERVIEW_VIEWS.some((view) => view === value)

const TRANSCRIPT_LIMIT = 200

/** Exit status when the port is taken; the app shows it instead of restarting. */
const PORT_IN_USE_EXIT = 98

/** Refused before any service runs: a foreign Host or any Origin (403), a bad token (401), a method no route takes (405). */
class Refused extends Data.TaggedError("Refused")<{ readonly status: 401 | 403 | 405; readonly message: string }> {}

type RouteError = DaemonError | Refused

/** The one place a failed request becomes a status: `statusOf` for service failures, the gate's own for refusals. */
const failure = (error: RouteError): Response => json({ error: error.message }, error._tag === "Refused" ? error.status : statusOf(error))

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const digest = (value: string): Buffer => createHash("sha256").update(value).digest()

/** Constant-time bearer check: hashing first makes both sides the same length. */
export const authorized = (header: string | null, token: string): boolean =>
  header !== null && timingSafeEqual(digest(header), digest(`Bearer ${token}`))

export type BoundServer = ReturnType<typeof Bun.serve>

/**
 * Binds the port before anything touches the store, so a second daemon exits
 * here instead of running recovery on a store another daemon owns. Until
 * `serve` installs the routes, every request gets 503.
 */
export const bind = (port: number): BoundServer => {
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      fetch: () => json({ error: "starting" }, 503),
    })
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE") {
      console.error(`port ${port} in use`)
      process.exit(PORT_IN_USE_EXIT)
    }
    throw cause
  }
}

export interface ServerOptions {
  readonly token: string
  /** Tests shorten the SSE ping. */
  readonly sse?: SseTiming
}

/** Loopback only, no browser: a foreign Host (DNS rebinding) or any Origin is refused, then the bearer token. */
const gate = (request: Request, token: string) =>
  Effect.gen(function* () {
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "")
    if (host !== "127.0.0.1" && host !== "localhost") return yield* new Refused({ status: 403, message: "forbidden host" })
    if (request.headers.get("origin") !== null) return yield* new Refused({ status: 403, message: "cross-origin requests are not accepted" })
    if (!authorized(request.headers.get("authorization"), token)) return yield* new Refused({ status: 401, message: "unauthorized" })
  })

/** The board fetched (or cached) for `spec`, with the prod watcher's judgement of its signals. */
const board = (spec: BoardSpec) =>
  Effect.gen(function* () {
    const fetched = yield* (yield* Boards).build(spec)
    return boardView(fetched, yield* (yield* Watcher).readings, new Date())
  })

/** Runs a mutation, then answers with the fresh snapshot. */
const thenSnapshot = <E, R>(effect: Effect.Effect<unknown, E, R>) => effect.pipe(Effect.andThen(snapshot), Effect.map((body) => json(body)))

const events = (timing: SseTiming) =>
  Effect.gen(function* () {
    const hub = yield* Hub
    const body = yield* snapshotEvents(snapshot, hub.subscribe, timing).pipe(Stream.encodeText, Stream.toReadableStreamEffect())
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } })
  })

const getRoute = (path: string, options: ServerOptions) =>
  Effect.gen(function* () {
    if (path === "/state") return json(yield* snapshot)
    if (path === "/events") return yield* events(options.sse ?? SSE_TIMING)
    if (path === "/logs") return json(yield* logSweep)
    const detail = /^\/alerts\/([^/]+)$/.exec(path)
    if (detail !== null) {
      const found = yield* alertDetail(yield* pathId(detail[1]))
      if (found === undefined) return yield* new NotFound({ message: "unknown alert" })
      return json(found)
    }
    const overview = /^\/boards\/([a-z]+)$/.exec(path)?.[1]
    if (overview !== undefined) {
      if (!isOverviewView(overview)) return yield* new NotFound({ message: "unknown board" })
      return json(yield* board(overviewBoard(overview, new Date())))
    }
    const alertBoardId = /^\/alerts\/([^/]+)\/board$/.exec(path)?.[1]
    if (alertBoardId !== undefined) {
      const alert = yield* (yield* Store).getAlert(yield* pathId(alertBoardId))
      if (alert === undefined) return yield* new NotFound({ message: "unknown alert" })
      const spec = alertBoard(alert, new Date())
      return json(spec === null ? null : yield* board(spec))
    }
    const transcript = /^\/sessions\/([^/]+)\/transcript$/.exec(path)
    if (transcript !== null) {
      const store = yield* Store
      const id = yield* pathId(transcript[1])
      if ((yield* store.getSession(id)) === undefined) return yield* new NotFound({ message: "unknown session" })
      return json(yield* store.transcript(id, TRANSCRIPT_LIMIT))
    }
    return yield* new NotFound({ message: "not found" })
  })

const postRoute = (path: string, request: Request) =>
  Effect.gen(function* () {
    const action = /^\/actions\/([^/]+)\/(resolve|dismiss)$/.exec(path)
    if (action !== null) {
      const actions = yield* Actions
      const id = yield* pathId(action[1])
      if (action[2] === "dismiss") return yield* thenSnapshot(actions.dismiss(id))
      const body = yield* readBody(request, ResolveBody)
      return yield* thenSnapshot(actions.resolve(id, body.response ?? null))
    }
    const alert = /^\/alerts\/([^/]+)\/investigate$/.exec(path)
    if (alert !== null) {
      const id = yield* pathId(alert[1])
      const intake = yield* Intake
      return yield* thenSnapshot(intake.investigate(id))
    }
    const session = /^\/sessions\/([^/]+)\/(stop|message)$/.exec(path)
    if (session !== null) {
      const runner = yield* SessionRunner
      const id = yield* pathId(session[1])
      if (session[2] === "stop") return yield* thenSnapshot(runner.stop(id))
      const body = yield* readBody(request, MessageBody)
      return yield* thenSnapshot(runner.message(id, body.text))
    }
    const hub = yield* Hub
    if (path === "/settings") {
      const patch = yield* readBody(request, SettingsPatch)
      return yield* thenSnapshot(hub.modifySettings((current) => mergeSettings(current, patch)))
    }
    if (path === "/pause") {
      const body = yield* readBody(request, PauseBody)
      return yield* thenSnapshot(hub.patchStatus({ paused: body.paused }))
    }
    return yield* new NotFound({ message: "not found" })
  })

/** Every route but /health requires the bearer token the app generated. */
export const route = (request: Request, options: ServerOptions): Effect.Effect<Response, RouteError, Services> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname
    if (path === "/health") return json({ ok: true, version: VERSION })
    yield* gate(request, options.token)
    if (request.method === "GET") return yield* getRoute(path, options)
    if (request.method === "POST") return yield* postRoute(path, request)
    return yield* new Refused({ status: 405, message: "method not allowed" })
  })

/** Installs the routes on the bound server (Bun HTTP + SSE on loopback). */
export const serve = Effect.fn("serve")(function* (server: BoundServer, options: ServerOptions) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<Services>())
  const handle = (request: Request) =>
    route(request, options).pipe(
      Effect.catch((error) => Effect.succeed(failure(error))),
      Effect.catchCause((cause) =>
        Effect.logError(`${request.method} ${new URL(request.url).pathname} failed`, cause).pipe(
          Effect.as(json({ error: errorMessage(Cause.squash(cause)) }, 500)),
        ),
      ),
    )
  server.reload({ fetch: (request) => runPromise(handle(request)) })
  yield* Effect.logInfo(`Bridgetown daemon listening on http://127.0.0.1:${server.port}`)
  return server
})
