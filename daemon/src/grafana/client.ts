import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect"
import { AdapterError, attempt, decodeOr, errorMessage } from "../domain/errors.ts"

/**
 * Read-only access to Merkl's Grafana through the shared `grafana/mcp-grafana`
 * container (`bun grafana:mcp` in the monorepo), the same one sessions use. The
 * container holds the read-only service-account token; the daemon never sees it,
 * never calls Grafana itself, and never starts the container.
 *
 * The server also offers write tools. Only the reads below are ever called:
 * `query_prometheus`, and `grafana_api_request` as a GET on the VictoriaLogs
 * datasource proxy's LogsQL read endpoints (the route docs/OBSERVABILITY.md
 * gives for logs, since mcp-grafana's log tools speak Loki).
 */

const GRAFANA_MCP_URL = "http://localhost:8000/mcp"
const METRICS_DATASOURCE = "P4169E866C3094E38"
export const LOGS_DATASOURCE = "PD775F2863313E6C7"

const LOGSQL_PREFIX = `/api/datasources/proxy/uid/${LOGS_DATASOURCE}/select/logsql/`
const ALLOWED_TOOLS = new Set(["query_prometheus", "grafana_api_request"])
/** LogsQL stats over a day of envoy logs take tens of seconds; boards are cached and warmed in the background. */
const CALL_TIMEOUT_MS = 45_000
const MAX_POINTS = 500

export interface Range {
  readonly start: Date
  readonly end: Date
  readonly stepSeconds: number
}

/** One series: its labels and `[unix seconds, value]` points, oldest first. */
export interface Series {
  readonly labels: Readonly<Record<string, string>>
  readonly points: ReadonlyArray<readonly [number, number]>
}

export interface GrafanaShape {
  /** Whether the MCP server answers at all (its container is up), within 2 seconds. */
  readonly reachable: Effect.Effect<boolean>
  /** A PromQL range query against VictoriaMetrics. */
  readonly prom: (expr: string, range: Range) => Effect.Effect<ReadonlyArray<Series>, AdapterError>
  /** A LogsQL `stats` query over time against VictoriaLogs (`stats_query_range`). */
  readonly logStats: (query: string, range: Range) => Effect.Effect<ReadonlyArray<Series>, AdapterError>
  /** Matching log rows as flat string maps, newest first as the query sorts them. */
  readonly logRows: (query: string, range: Range, limit: number) => Effect.Effect<ReadonlyArray<Readonly<Record<string, string>>>, AdapterError>
}

export class Grafana extends Context.Service<Grafana, GrafanaShape>()("Grafana") {}

const failure = (operation: string, message: string) => new AdapterError({ adapter: "grafana", operation, message, cause: null })

/** Fails before any call when a range would ask for too many points. */
export const checkRange = (range: Range): Effect.Effect<Range, AdapterError> => {
  const seconds = (range.end.getTime() - range.start.getTime()) / 1000
  if (!(seconds > 0) || range.stepSeconds < 60 || seconds / range.stepSeconds > MAX_POINTS) {
    return Effect.fail(failure("range", `range of ${seconds}s at ${range.stepSeconds}s steps is out of bounds`))
  }
  return Effect.succeed(range)
}

const Matrix = Schema.Array(
  Schema.Struct({
    metric: Schema.Record(Schema.String, Schema.String),
    values: Schema.Array(Schema.Tuple([Schema.Number, Schema.String])),
  }),
)
const PromResult = Schema.Struct({ data: Schema.optional(Schema.NullOr(Matrix)) })
const ApiResult = Schema.Struct({ status: Schema.Number, data: Schema.Unknown })
const StatsBody = Schema.Struct({ data: Schema.Struct({ result: Matrix }) })
const Row = Schema.Record(Schema.String, Schema.String)

const toSeries = (matrix: typeof Matrix.Type): ReadonlyArray<Series> =>
  matrix.map((s) => ({
    labels: s.metric,
    points: s.values.flatMap(([t, v]): Array<readonly [number, number]> => {
      const n = Number(v)
      return Number.isFinite(n) ? [[t, n]] : []
    }),
  }))

const firstText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (typeof item === "object" && item !== null && "text" in item && typeof item.text === "string") return item.text
  }
  return undefined
}

/**
 * The rows of a LogsQL `query` answer. VictoriaLogs streams one JSON object per
 * line; mcp-grafana hands that back as text, except when the body is a single
 * line, which is valid JSON on its own and comes back already parsed.
 */
export const rowsOf = (data: unknown): ReadonlyArray<unknown> => {
  if (typeof data === "string") return data.split("\n").filter((line) => line.trim() !== "").map((line): unknown => JSON.parse(line))
  if (Array.isArray(data)) return data
  return typeof data === "object" && data !== null ? [data] : []
}

/** The server no longer knows our MCP session (the container restarted): the one failure a fresh session fixes. */
class SessionLost extends Data.TaggedError("SessionLost")<{ readonly method: string }> {}

const LOST = Symbol("session lost")

/** The client of the MCP server at `url`; `GrafanaLive` is the shared container's. */
export const makeGrafana = (url: string) =>
  Effect.gen(function* () {
    /** The MCP session id from `initialize`; dropped when the server forgets it. */
    let session: string | undefined
    let nextId = 1
    const inFlight = yield* Semaphore.make(3)

    /** One JSON-RPC message over streamable HTTP. The answer comes back as JSON or as SSE `data:` lines. */
    const rpc = (method: string, params: Record<string, unknown>, notification = false) =>
      attempt("grafana", method, async (): Promise<unknown> => {
        const id = nextId++
        const sent = session
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(sent === undefined ? {} : { "Mcp-Session-Id": sent }),
          },
          body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
        // A session the server no longer has is answered 404 (MCP), or 400 by some servers.
        if (sent !== undefined && (response.status === 404 || response.status === 400)) return LOST
        if (!response.ok) throw new Error(`MCP ${method} answered HTTP ${response.status}`)
        session = response.headers.get("Mcp-Session-Id") ?? session
        if (notification) return null
        const body = await response.text()
        const messages = (response.headers.get("Content-Type") ?? "").includes("text/event-stream")
          ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
          : [body]
        for (const message of messages) {
          const parsed: unknown = JSON.parse(message)
          if (typeof parsed === "object" && parsed !== null && "id" in parsed && parsed.id === id) {
            if ("error" in parsed && parsed.error !== undefined) throw new Error(`MCP ${method}: ${JSON.stringify(parsed.error)}`)
            return "result" in parsed ? parsed.result : null
          }
        }
        throw new Error(`MCP ${method}: no answer`)
      }).pipe(Effect.flatMap((answer) => (answer === LOST ? Effect.fail(new SessionLost({ method })) : Effect.succeed(answer))))

    const connect = Effect.gen(function* () {
      session = undefined
      yield* rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridgetown", version: "1" } })
      yield* rpc("notifications/initialized", {}, true)
    })

    const callOnce = (name: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        if (session === undefined) yield* connect
        const result = yield* rpc("tools/call", { name, arguments: args })
        const content = typeof result === "object" && result !== null && "content" in result ? result.content : undefined
        const text = firstText(content)
        if (typeof result === "object" && result !== null && "isError" in result && result.isError === true) {
          return yield* failure(name, text ?? "tool error")
        }
        if (text === undefined) return yield* failure(name, "empty response")
        return yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => failure(name, errorMessage(cause)) })
      })

    /**
     * One retry on a fresh MCP session, only when the server lost ours (the container restarted). A timeout or a
     * tool's own error fails at once: a heavy LogsQL query is never run twice on the shared VictoriaLogs.
     */
    const call = (name: string, args: Record<string, unknown>) => {
      if (!ALLOWED_TOOLS.has(name)) return Effect.fail(failure(name, `${name} is not an allowed Grafana tool`))
      return callOnce(name, args).pipe(
        Effect.catchTag("SessionLost", () => {
          session = undefined
          return callOnce(name, args)
        }),
        Effect.catchTag("SessionLost", (lost) => Effect.fail(failure(name, `MCP ${lost.method}: the server lost the session again`))),
        inFlight.withPermits(1),
      )
    }

    /** GET on a LogsQL read endpoint, nothing else. */
    const logsql = (endpoint: "query" | "stats_query_range", params: Record<string, string>) =>
      Effect.gen(function* () {
        const path = `${LOGSQL_PREFIX}${endpoint}?${new URLSearchParams(params).toString()}`
        const raw = yield* call("grafana_api_request", { endpoint: path, method: "GET" })
        const response = yield* decodeOr("grafana", "logsql", ApiResult)(raw)
        if (response.status !== 200) return yield* failure("logsql", `VictoriaLogs answered ${response.status}`)
        return response.data
      })

    const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000))

    return {
      reachable: Effect.tryPromise(() => fetch(url, { method: "GET", signal: AbortSignal.timeout(2_000) })).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      ),
      prom: (expr, range) =>
        checkRange(range).pipe(
          Effect.andThen(
            call("query_prometheus", {
              datasourceUid: METRICS_DATASOURCE,
              expr,
              queryType: "range",
              startTime: range.start.toISOString(),
              endTime: range.end.toISOString(),
              stepSeconds: range.stepSeconds,
            }),
          ),
          Effect.flatMap(decodeOr("grafana", "query_prometheus", PromResult)),
          Effect.map((result) => toSeries(result.data ?? [])),
        ),
      logStats: (query, range) =>
        checkRange(range).pipe(
          Effect.andThen(logsql("stats_query_range", { query, start: seconds(range.start), end: seconds(range.end), step: `${range.stepSeconds}s` })),
          Effect.flatMap(decodeOr("grafana", "stats_query_range", StatsBody)),
          Effect.map((body) => toSeries(body.data.result)),
        ),
      logRows: (query, range, limit) =>
        logsql("query", { query, start: seconds(range.start), end: seconds(range.end), limit: String(Math.min(limit, 100)) }).pipe(
          Effect.flatMap((data) =>
            Effect.try({ try: () => rowsOf(data), catch: (cause) => failure("logsql rows", errorMessage(cause)) }),
          ),
          Effect.flatMap((rows) => Effect.forEach(rows, decodeOr("grafana", "logsql rows", Row))),
        ),
    } satisfies GrafanaShape
  })

export const GrafanaLive = Layer.effect(Grafana)(makeGrafana(GRAFANA_MCP_URL))
