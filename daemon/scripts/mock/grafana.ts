import { Effect } from "effect"
import { checkRange, type GrafanaShape, type Range, type Series } from "../../src/grafana/client.ts"
import type { LogPatternVerdict } from "../../src/watch/judge.ts"
import { type Sweep, sweepQuery } from "../../src/watch/logs.ts"

/**
 * Grafana for the mock: deterministic series shaped like Merkl's prod (a daily
 * swell, noise, a 5xx spike lining up with the mock's `5xx rate 3.1%` alert, a
 * rollout from one image tag to the next) and a few deploys.
 * `MOCK_GRAFANA=live` uses the real read-only client instead (see main.ts).
 */

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

const noise = (seed: number, i: number) => {
  const x = Math.sin(seed * 9.17 + i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

const times = (range: Range) => {
  const out: Array<number> = []
  const start = Math.ceil(range.start.getTime() / 1000 / range.stepSeconds) * range.stepSeconds
  for (let t = start; t <= range.end.getTime() / 1000; t += range.stepSeconds) out.push(t)
  return out
}

/** Base level and scale per kind of query, so units look right. */
const levelOf = (query: string): readonly [number, number] => {
  if (query.includes("quantile")) return [380, 120]
  if (query.includes("memory")) return [42e9, 6e9]
  if (query.includes("cpu_usage")) return [3.2, 1.1]
  if (query.includes("rate(erpc")) return [0.4, 0.3]
  if (query.includes("head_lag")) return [2, 3]
  if (query.includes("failed_pods")) return [1, 2]
  if (query.includes("oom")) return [0, 0.6]
  if (query.includes("response_code:>=500")) return [40, 60]
  return [900, 500]
}

const series = (query: string, range: Range): ReadonlyArray<Series> => {
  const seed = hash(query)
  const [base, scale] = levelOf(query)
  const now = Date.now() / 1000
  const spikeAt = now - 10 * 60
  const one = (offset: number, shape: (t: number, i: number) => number) => ({
    labels: {},
    points: times(range).map((t, i): readonly [number, number] => [t, Math.max(0, shape(t, i) + offset)]),
  })
  if (query.includes("container_image_tag")) {
    // A rollout 40 minutes ago: the old tag drains as the new one comes up.
    const cut = now - 40 * 60
    return [
      { labels: { container_image_tag: "v1.35.10" }, points: times(range).map((t): readonly [number, number] => [t, t < cut ? 3 : 0]) },
      { labels: { container_image_tag: "v1.35.11" }, points: times(range).map((t): readonly [number, number] => [t, t < cut ? 0 : 3]) },
    ]
  }
  return [
    one(0, (t, i) => {
      const daily = Math.sin(((t % 86_400) / 86_400) * 2 * Math.PI - 1.2)
      const spike = query.includes("response_code:>=500") && Math.abs(t - spikeAt) < range.stepSeconds * 1.5 ? scale * 6 : 0
      const integer = query.includes("failed_pods") || query.includes("oom") || query.includes("head_lag")
      const value = base + scale * (0.6 * daily + 0.8 * (noise(seed, i) - 0.5)) + spike
      return integer ? Math.round(value) : value
    }),
  ]
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const DEPLOYS: ReadonlyArray<Record<string, string>> = [
  { _time: minutesAgo(41), image: "merkl-api", version: "v1.35.11", stage: "engine", status: "success" },
  { _time: minutesAgo(118), image: "merkl-indexer", version: "v0.9.2", stage: "build", status: "failure" },
  { _time: minutesAgo(290), image: "merkl-admin", version: "v0.6.1", stage: "front-production", status: "success" },
  { _time: minutesAgo(760), image: "merkl-app", version: "v2.14.0", stage: "front-production", status: "success" },
  { _time: minutesAgo(1300), image: "merkl-api", version: "v1.35.9", stage: "engine", status: "success" },
  { _time: minutesAgo(2900), image: "merkl-api", version: "v1.35.8", stage: "build", status: "failure" },
]

/** One row of a log sweep as VictoriaLogs answers it, and what the mock's Jev said about its pattern (null: not asked). */
interface SweepRow {
  readonly sweep: Sweep
  readonly fields: Readonly<Record<string, string>>
  readonly sample: string
  readonly recent: number
  readonly total: number
  readonly verdict: LogPatternVerdict | null
}

const GOLDSKY =
  "Error fetching batch <N>/<N>: Error: Max retries (<N>) exceeded for request: Rate limited: the preview community blocks subgraphs are being retired, and this shared endpoint is now throttled and will be removed without further notice."

/**
 * The log sweep's patterns: a new error, an RPC surge, the day's steady noise, and risky warnings, among them the
 * Goldsky retirement the mock's log finding is about. Every one the sweep would ask about has a verdict already
 * (main.ts stores them), so starting the mock never starts an agent on them.
 */
export const SWEEP_ROWS: ReadonlyArray<SweepRow> = [
  { sweep: "errors", fields: { "merkl.job": "merkl-compute-<N>", _msg: "Campaign <N> has no reward token on chain <N>, skipping" }, sample: "Campaign 48213 has no reward token on chain 59144, skipping", recent: 18, total: 18, verdict: { problem: 0.31, agent: 0.62, users: 0.12 } },
  { sweep: "errors", fields: { "merkl.job": "merkl-compute-<N>", _msg: "RPC call eth_getLogs to https://rpc.ankr.com/base failed with status <N> after <N> attempts" }, sample: "RPC call eth_getLogs to https://rpc.ankr.com/base failed with status 429 after 3 attempts", recent: 220, total: 600, verdict: { problem: 0.46, agent: 0.38, users: 0.21 } },
  { sweep: "errors", fields: { "merkl.job": "merkl-compute-<N>", _msg: "Fetched Campaign: undefined" }, sample: "Fetched Campaign: undefined", recent: 114, total: 5_472, verdict: null },
  { sweep: "errors", fields: { "k8s.deployment.name": "api", _msg: "PrismaClientKnownRequestError: Unique constraint failed on the fields: (`id`)" }, sample: "PrismaClientKnownRequestError: Unique constraint failed on the fields: (`id`)", recent: 40, total: 3_800, verdict: null },
  { sweep: "errors", fields: { "k8s.container.name": "envoy", _msg: "upstream connect error or disconnect/reset before headers. reset reason: connection termination" }, sample: "upstream connect error or disconnect/reset before headers. reset reason: connection termination", recent: 12, total: 1_100, verdict: null },
  { sweep: "warnings", fields: { "merkl.job": "merkl-precompute-<N>", _msg: GOLDSKY }, sample: GOLDSKY.replace("<N>/<N>", "1/1").replace("(<N>)", "(2)"), recent: 953, total: 7_500, verdict: { problem: 0.94, agent: 0.58, users: 0.43 } },
  { sweep: "warnings", fields: { "merkl.job": "merkl-compute-<N>", _msg: GOLDSKY }, sample: GOLDSKY.replace("<N>/<N>", "1/1").replace("(<N>)", "(2)"), recent: 860, total: 7_000, verdict: { problem: 0.94, agent: 0.58, users: 0.43 } },
  { sweep: "warnings", fields: { "k8s.deployment.name": "tx-executor", _msg: "Nonce too low for signer <N>x<N>, resubmitting with nonce <N>" }, sample: "Nonce too low for signer 0x7a3f…c21d, resubmitting with nonce 48212", recent: 31, total: 260, verdict: { problem: 0.35, agent: 0.41, users: 0.08 } },
]

/** A sweep row in VictoriaLogs' shape: every value a string, `sample` and `versions` JSON-encoded. */
const victoriaRow = (row: SweepRow): Record<string, string> => ({
  ...row.fields,
  recent: String(row.recent),
  total: String(row.total),
  sample: JSON.stringify({ sample: row.sample }),
  versions: JSON.stringify(["v1.62.35"]),
})

/** The rows of the sweep `query` is, or undefined for any other query. */
const sweepRows = (query: string) => {
  const sweep = (["errors", "warnings"] as const).find((s) => query === sweepQuery(s))
  return sweep === undefined ? undefined : SWEEP_ROWS.filter((row) => row.sweep === sweep).map(victoriaRow)
}

export const mockGrafana = (): GrafanaShape => {
  return {
    reachable: Effect.succeed(true),
    prom: (expr, range) => checkRange(range).pipe(Effect.as(series(expr, range))),
    logStats: (query, range) => checkRange(range).pipe(Effect.as(series(query, range))),
    logRows: (query, range) =>
      Effect.succeed(
        sweepRows(query) ??
          DEPLOYS.filter((row) => {
            const image = /image:="([^"]+)"/.exec(query)?.[1]
            const at = Date.parse(row._time ?? "")
            return (image === undefined || row.image === image) && at >= range.start.getTime() && at <= range.end.getTime()
          }),
      ),
  }
}
