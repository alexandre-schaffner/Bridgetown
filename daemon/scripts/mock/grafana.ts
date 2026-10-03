import { Effect } from "effect"
import { checkRange, type GrafanaShape, type Range, type Series } from "../../src/grafana/client.ts"

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

export const fakeGrafana = (): GrafanaShape => {
  return {
    prom: (expr, range) => checkRange(range).pipe(Effect.as(series(expr, range))),
    logStats: (query, range) => checkRange(range).pipe(Effect.as(series(query, range))),
    logRows: (query, range) =>
      Effect.succeed(
        DEPLOYS.filter((row) => {
          const image = /image:="([^"]+)"/.exec(query)?.[1]
          const at = Date.parse(row._time ?? "")
          return (image === undefined || row.image === image) && at >= range.start.getTime() && at <= range.end.getTime()
        }),
      ),
  }
}
