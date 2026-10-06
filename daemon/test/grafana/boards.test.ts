import { describe, expect, test } from "bun:test"
import type { Alert, JevVerdict } from "../../src/domain/alert.ts"
import { deploysQuery, toDeploy, zeroFilled } from "../../src/grafana/board.ts"
import { alertBoard, chainOf, imageOf, overviewBoard, routeOf, stepFor } from "../../src/grafana/boards.ts"
import { rowsOf } from "../../src/grafana/client.ts"
import { watchBoard } from "../../src/watch/detect.ts"
import { makeAlert } from "../support/records.ts"

const now = new Date("2026-10-04T12:00:00.000Z")
const at = "2026-10-04T09:00:00.000Z"
const verdict = (kind: JevVerdict["kind"]): JevVerdict => ({ actionable: 1, agentResolvable: 1, humanOnIt: 0, kind, kindConfidence: 1, depth: "quick", urgency: 1 })
const alert = (overrides: Partial<Alert>) => makeAlert({ receivedAt: at, ...overrides })
const release = (image: string): Alert["fields"] => ({ _tag: "release", image, version: "v1", actor: null, runId: null, runUrl: null, tag: null, stages: [] })
const queries = (a: Alert) => alertBoard(a, now)?.panels.map((p) => p.query(600)) ?? []

describe("what an alert is about", () => {
  test("a route from the title or an uptime target", () => {
    expect(routeOf(alert({ title: "merkl-api · 5xx rate 3.1% on /v4/opportunities" }))).toBe("/v4/opportunities")
    expect(routeOf(alert({ title: "Incident", fields: { _tag: "uptime", target: "api.merkl.xyz/v4/roots/delay", state: "incident" } }))).toBe("/v4/roots/delay")
    expect(routeOf(alert({ title: "Keeper missed 2 root updates" }))).toBeNull()
  })

  test("a chain from an id or a name", () => {
    expect(chainOf(alert({ title: "Stale price", summary: "chainId: 8453" }))).toBe("8453")
    expect(chainOf(alert({ title: "Keeper missed 2 root updates on Arbitrum" }))).toBe("42161")
    expect(chainOf(alert({ title: "merkl-api build failed", summary: "" }))).toBeNull()
  })

  test("an image only when it looks like one", () => {
    expect(imageOf(alert({ fields: release("merkl-api") }))).toBe("merkl-api")
    expect(imageOf(alert({ fields: release(`api"} or 1=1`) }))).toBeNull()
  })

  test("nothing from Slack text reaches a query unchecked", () => {
    const hostile = alert({ title: `5xx on /v4/x" | delete | "`, summary: `chain: 1"} or vector(1)` })
    for (const q of queries(hostile)) {
      expect(q).not.toContain("delete")
      expect(q).not.toContain("vector(1)")
    }
    // Regex metacharacters in a route are escaped, never interpreted.
    expect(queries(alert({ title: "500s on /v4/a.b" })).join(" ")).toContain("/v4/a[.]b")
  })
})

describe("boards", () => {
  test("a route gets its own 5xx and latency next to the whole API", () => {
    const board = alertBoard(alert({ title: "5xx rate 3.1% on /v4/opportunities" }), now)
    expect(board?.title).toBe("API · /v4/opportunities")
    expect(board?.panels.map((p) => p.id)).toEqual(["route_5xx_/v4/opportunities", "route_p99_/v4/opportunities", "api_5xx", "api_p99"])
  })

  test("a release follows its image: pods by version, memory, CPU, and its own deploys", () => {
    const board = alertBoard(alert({ title: "merkl-api v1.35.10 · Build failed", fields: release("merkl-api") }), now)
    expect(board?.deployImage).toBe("merkl-api")
    expect(board?.panels[0]?.query(600)).toBe(`count by (container_image_tag) (k8s_pod_cpu_usage{k8s_deployment_name=~"(merkl-)?api"})`)
  })

  test("a keeper alert on a chain watches that chain's RPC and jobs", () => {
    const board = alertBoard(alert({ title: "Keeper missed 2 root updates on Arbitrum", triage: { decision: "auto", reason: "", jev: verdict("onchain_or_keeper") } }), now)
    expect(board?.panels.map((p) => p.id)).toEqual(["rpc_errors_42161", "head_lag_42161", "job_errors_42161", "engine_errors_42161"])
  })

  test("a DM about nothing in Grafana has no board", () => {
    const dm = alert({ title: "should we prioritise the sparkline work?", fields: { _tag: "inbox", from: "U1", fromName: "Hugo", channelKind: "dm", via: "dm", threadTs: null, prUrl: null } })
    expect(alertBoard(dm, now)).toBeNull()
  })

  test("the window is 6h either side of the alert, cut at now, with the alert marked", () => {
    const board = alertBoard(alert({ title: "x on /v4/y" }), now)
    expect(board?.from.toISOString()).toBe("2026-10-04T03:00:00.000Z")
    expect(board?.to.toISOString()).toBe(now.toISOString())
    expect(board?.marker?.toISOString()).toBe(at)
  })

  test("about 48 points per window, never under a minute", () => {
    expect(stepFor(new Date(0), new Date(24 * 3_600_000))).toBe(1800)
    expect(stepFor(new Date(0), new Date(60_000))).toBe(60)
    expect(overviewBoard("infra", now).panels.map((p) => p.id)).toEqual(["rpc_errors", "failed_job_pods", "oom_kills", "db_waiting"])
  })

  test("the database board is prod Postgres only, whichever pod is primary", () => {
    const board = overviewBoard("database", now)
    expect(board.title).toBe("Database")
    expect(board.panels.map((p) => p.id)).toEqual(["db_connections", "db_lock_waits", "db_longest_tx", "db_replication_lag"])
    for (const panel of board.panels) expect(panel.query(120)).toContain(`{service_name="cluster-timescaledb"}`)
    expect(board.panels[0]?.seriesLabel).toBe("state")
  })

  test("the prod watcher sweeps incidents and infra, not the database board", () => {
    const ids = watchBoard(now).panels.map((p) => p.id)
    expect(ids).toContain("db_waiting")
    expect(ids.some((id) => id.startsWith("db_") && id !== "db_waiting")).toBe(false)
  })

  test("the overview is the last hour, deploys included", () => {
    const board = overviewBoard("incidents", now)
    expect(board.from.toISOString()).toBe("2026-10-04T11:00:00.000Z")
    expect(board.deploysFrom.toISOString()).toBe("2026-10-04T11:00:00.000Z")
    expect(board.stepSeconds).toBe(120)
  })
})

describe("board data", () => {
  test("missing count buckets are zeros on the series' own grid", () => {
    const from = new Date(1000 * 1000)
    const to = new Date(1000 * 1600)
    expect(zeroFilled([[1150, 3], [1450, 1]], from, to, 150)).toEqual([[1000, 0], [1150, 3], [1300, 0], [1450, 1], [1600, 0]])
    expect(zeroFilled([], from, to, 150)).toEqual([])
  })

  test("only prod deploys and failures count as deploys", () => {
    expect(deploysQuery("merkl-api")).toContain(`image:="merkl-api"`)
    const t = "2026-10-02T15:04:35.199941147Z"
    expect(toDeploy({ _time: t, image: "merkl-api", version: "v1", stage: "engine", status: "success" })).toEqual({
      at: "2026-10-02T15:04:35.199Z", image: "merkl-api", version: "v1", stage: "engine", status: "deployed",
    })
    expect(toDeploy({ _time: t, image: "merkl-api", version: "v1", stage: "build", status: "failure" })?.status).toBe("failed")
    expect(toDeploy({ _time: t, status: "in_progress" })).toBeUndefined()
    expect(toDeploy({ _time: "not a time", status: "success" })).toBeUndefined()
  })
})

describe("LogsQL rows", () => {
  test("several lines come back as text, one line already parsed: both are rows", () => {
    expect(rowsOf('{"n":"1"}\n{"n":"2"}\n')).toEqual([{ n: "1" }, { n: "2" }])
    expect(rowsOf({ n: "2758" })).toEqual([{ n: "2758" }])
    expect(rowsOf("")).toEqual([])
    expect(rowsOf(null)).toEqual([])
  })
})
