import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionQueue } from "../src/actions/queue.ts"
import type { Alert } from "../src/domain/model.ts"
import type { Panel } from "../src/grafana/board.ts"
import { watchBoard } from "../src/grafana/boards.ts"
import type { GrafanaShape, Range } from "../src/grafana/client.ts"
import { Hub } from "../src/hub.ts"
import { Store } from "../src/store/store.ts"
import type { JevShape } from "../src/triage/jev.ts"
import { detect, findingOf, formatValue, RECENT_STEPS } from "../src/watch/detect.ts"
import { coveredBySlack, Watcher } from "../src/watch/watcher.ts"
import { makeSession } from "./fixtures/records.ts"
import { makeWorld, noGrafana, verdict } from "./fixtures/world.ts"

const STEP = 300
const NOW = new Date("2026-10-04T12:00:00Z")

/** A panel with one point per step over 3 hours up to `NOW`, the last (in progress) included. */
const panel = (id: string, value: (stepsAgo: number) => number, overrides: Partial<Panel> = {}): Panel => {
  const end = NOW.getTime() / 1000
  const points: Array<readonly [number, number]> = []
  for (let stepsAgo = 36; stepsAgo >= 0; stepsAgo--) points.push([end - stepsAgo * STEP, value(stepsAgo)])
  return { id, title: "API 5xx", unit: "count", series: [{ label: "API 5xx", points }], latest: null, link: "", error: null, ...overrides }
}

describe("detect: a sustained rise over a floor, never one burst", () => {
  test("three complete steps far above the usual level", () => {
    const anomaly = detect(panel("api_5xx", (ago) => (ago >= 1 && ago <= RECENT_STEPS ? 400 : 5)), STEP, NOW)
    expect(anomaly).toMatchObject({ level: 400, usual: 5 })
    expect(anomaly?.since.toISOString()).toBe("2026-10-04T11:45:00.000Z")
  })

  test("the step still in progress does not count", () => {
    expect(detect(panel("api_5xx", (ago) => (ago === 0 ? 9_000 : 5)), STEP, NOW)).toBeNull()
  })

  test("a Prometheus point at now already covers the step before it, so it counts", () => {
    const risen = (ago: number) => (ago <= 1 ? 20 : 1)
    expect(detect(panel("db_waiting", risen), STEP, NOW, "prom")).toMatchObject({ level: 20, since: new Date(NOW.getTime() - 3 * STEP * 1000) })
    expect(detect(panel("db_waiting", risen), STEP, NOW, "logs")).toBeNull()
  })

  test("a single burst, even a huge one, is not a rise", () => {
    expect(detect(panel("api_5xx", (ago) => (ago === 2 ? 5_000 : 5)), STEP, NOW)).toBeNull()
  })

  test("two of three steps up is enough", () => {
    expect(detect(panel("api_5xx", (ago) => (ago === 1 || ago === 3 ? 400 : 5)), STEP, NOW)).not.toBeNull()
  })

  test("below the floor is noise, however many times usual", () => {
    expect(detect(panel("api_5xx", (ago) => (ago <= RECENT_STEPS ? 40 : 1)), STEP, NOW)).toBeNull()
  })

  test("not above factor × the usual p90", () => {
    expect(detect(panel("api_5xx", (ago) => (ago <= RECENT_STEPS ? 300 : ago % 4 === 0 ? 120 : 10)), STEP, NOW)).toBeNull()
  })

  test("no rule, a failed panel, or too little history: nothing", () => {
    const rising = (ago: number) => (ago <= RECENT_STEPS ? 400 : 5)
    expect(detect(panel("route_5xx_/v4/x", rising), STEP, NOW)).toBeNull()
    expect(detect(panel("api_5xx", rising, { error: "boom" }), STEP, NOW)).toBeNull()
    const short = panel("api_5xx", rising)
    expect(detect({ ...short, series: [{ label: "x", points: short.series[0]?.points.slice(-10) ?? [] }] }, STEP, NOW)).toBeNull()
  })
})

describe("the finding", () => {
  test("says what rose, by how much, and that Slack didn't say it", () => {
    const spec = watchBoard(NOW).panels.find((p) => p.id === "api_5xx")
    const anomaly = detect(panel("api_5xx", (ago) => (ago >= 1 && ago <= RECENT_STEPS ? 640 : 40)), STEP, NOW)
    if (spec === undefined || anomaly === null) throw new Error("setup")
    const deploy = { at: "2026-10-04T11:41:00.000Z", image: "merkl-api", version: "v1.35.11", stage: "engine", status: "deployed" as const }
    const finding = findingOf(anomaly, spec, STEP, [deploy], "https://grafana/d/x")
    expect(finding).toMatchObject({
      id: `watch:api_5xx:${NOW.getTime() / 1000 - 15 * 60}`,
      fingerprint: "watch:api_5xx",
      channelName: "Grafana",
      source: "watch",
      title: "API 5xx at 640 per 5 min, usually up to 40",
      fields: { _tag: "watch", signal: "api_5xx", datasource: "logs", level: 640, usual: 40 },
    })
    expect(finding.summary).toContain("16× its usual level")
    expect(finding.summary).toContain("merkl-api v1.35.11 deployed at 11:41 UTC")
    expect(finding.raw).toContain("envoy.response_code:>=500")
  })

  test("values in their unit", () => {
    expect([formatValue(2_400, "ms"), formatValue(410, "ms"), formatValue(41.26, "per_s"), formatValue(1_234, "count")]).toEqual(["2.4s", "410ms", "41/s", "1,234"])
  })
})

describe("coveredBySlack", () => {
  const slackAlert = (overrides: Partial<Alert>): Alert => ({
    id: "C1:1", channelId: "C1", channelName: "alert-dev", ts: "1", permalink: null, title: "merkl-api 5xx on /v4/opportunities", summary: "",
    raw: "", source: "generic", fingerprint: "f", fields: { _tag: "generic" }, mentionsMe: false, receivedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    triage: { decision: "suggest", reason: "", jev: null }, sessionId: null, feedback: null, events: [], disposition: null, claimedBy: [], ...overrides,
  })

  test("a recent alert someone acts on, about the same signal", () => {
    expect(coveredBySlack("api_5xx", [slackAlert({})], NOW)?.id).toBe("C1:1")
  })

  test("not when Jev ignored it, it is old, or it is about something else", () => {
    expect(coveredBySlack("api_5xx", [slackAlert({ triage: { decision: "ignore", reason: "", jev: null } })], NOW)).toBeUndefined()
    expect(coveredBySlack("api_5xx", [slackAlert({ receivedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() })], NOW)).toBeUndefined()
    expect(coveredBySlack("db_waiting", [slackAlert({})], NOW)).toBeUndefined()
  })

  test("only the signal the alert is about, never its board's background panels", () => {
    const jevSays = (kind: "runtime_error" | "deploy_failure" | "onchain_or_keeper") => ({
      decision: "suggest" as const, reason: "", jev: { ...verdict(), kind },
    })
    // A cron that flaked leads with API 5xx on its board, but is not about it.
    expect(coveredBySlack("api_5xx", [slackAlert({ title: "Some cron flaked", triage: jevSays("runtime_error") })], NOW)).toBeUndefined()
    // A failed deploy's board shows API 5xx in the background.
    expect(coveredBySlack("api_5xx", [slackAlert({ title: "Deploy failed", triage: jevSays("deploy_failure") })], NOW)).toBeUndefined()
    // One chain's engine errors do not stand for every chain's.
    expect(coveredBySlack("engine_errors", [slackAlert({ title: "Engine errors on chain 42161", triage: jevSays("onchain_or_keeper") })], NOW)).toBeUndefined()
  })
})

/** API 5xx at 5 per step, then 400 for the last 20 minutes; every other query empty. */
const risingApi5xx = (): GrafanaShape => ({
  ...noGrafana,
  logStats: (query, range: Range) =>
    Effect.sync(() => {
      if (!query.includes("response_code:>=500")) return []
      const end = range.end.getTime() / 1000
      const points: Array<readonly [number, number]> = []
      for (let t = Math.ceil(range.start.getTime() / 1000 / STEP) * STEP; t <= end; t += STEP) points.push([t, t > end - 20 * 60 ? 400 : 5])
      return [{ labels: {}, points }]
    }),
})

describe("Watcher.tick", () => {
  let reads = 0
  const rising: GrafanaShape = { ...risingApi5xx(), logStats: (query, range) => Effect.sync(() => void reads++).pipe(Effect.andThen(risingApi5xx().logStats(query, range))) }
  let judged = 0
  const jev: JevShape = {
    judge: () => Effect.sync(() => void judged++).pipe(Effect.as(verdict({ kind: "runtime_error", actionable: 0.95, agentResolvable: 0.9 }))),
    judgeInbox: () => Effect.die("unused"),
    judgeFinding: () => Effect.die("unused"),
  }
  const world = makeWorld({ jev, grafana: rising })
  afterAll(() => world.dispose())
  const tick = () => world.runPromise(Watcher.use((watcher) => watcher.tick))
  const findings = () => world.runPromise(Store.use((store) => store.recentAlerts(50)).pipe(Effect.map((alerts) => alerts.filter((a) => a.source === "watch"))))
  const setWatch = (watchProd: boolean) => world.runPromise(Hub.use((hub) => hub.settings.pipe(Effect.flatMap((s) => hub.updateSettings({ ...s, watchProd })))))

  test("nothing while the Grafana MCP is down", async () => {
    await tick()
    expect(await findings()).toHaveLength(0)
  })

  test("a rise becomes a suggestion, never an auto-start, even when Jev would hand it off", async () => {
    await world.runPromise(Hub.use((hub) => hub.patchStatus({ grafanaMcp: "up" })))
    await tick()
    const [finding] = await findings()
    expect(finding).toMatchObject({ fingerprint: "watch:api_5xx", channelName: "Grafana", sessionId: null, triage: { decision: "suggest" } })
    expect(finding?.permalink).toContain("/d/pihjbxm")
    expect(finding?.events.map((e) => e.text)).toEqual([expect.stringContaining("Seen by Bridgetown in Grafana"), expect.stringContaining("Suggested to you")])
    const cards = await world.runPromise(ActionQueue.use((queue) => queue.list))
    expect(cards).toEqual([expect.objectContaining({ kind: "investigate", alertId: finding?.id, detail: expect.stringMatching(/^Grafana · /) })])
  })

  test("the same rise is raised once", async () => {
    await tick()
    expect(await findings()).toHaveLength(1)
    expect(judged).toBe(1)
  })

  test("off in settings: no Grafana reads, no findings", async () => {
    await setWatch(false)
    const before = reads
    await tick()
    expect(reads).toBe(before)
  })
})

describe("Watcher.tick with a session already on the signal", () => {
  let judged = 0
  const jev: JevShape = {
    judge: () => Effect.sync(() => void judged++).pipe(Effect.as(verdict())),
    judgeInbox: () => Effect.die("unused"),
    judgeFinding: () => Effect.die("unused"),
  }
  const world = makeWorld({ jev, grafana: risingApi5xx() })
  afterAll(() => world.dispose())

  test("the rise goes to that session, not to a second agent", async () => {
    const earlier: Alert = {
      id: "watch:api_5xx:1", channelId: "grafana", channelName: "Grafana", ts: "1", permalink: null, title: "API 5xx at 640", summary: "", raw: "",
      source: "watch", fingerprint: "watch:api_5xx", fields: { _tag: "watch", signal: "api_5xx", query: "q", datasource: "logs", level: 640, usual: 40, since: "2026-10-04T00:00:00.000Z" },
      mentionsMe: false, receivedAt: new Date(Date.now() - 7 * 3_600_000).toISOString(), triage: { decision: "suggest", reason: "", jev: null },
      sessionId: "s_watch", feedback: null, events: [], disposition: null, claimedBy: [],
    }
    await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putSession(makeSession("awaiting_release", { id: "s_watch", alertId: earlier.id }))
        yield* store.putAlert(earlier)
        yield* (yield* Hub).patchStatus({ grafanaMcp: "up" })
        yield* (yield* Watcher).tick
      }),
    )
    const stored = await world.runPromise(Store.use((store) => store.alertsByFingerprint("watch:api_5xx", new Date(0).toISOString())))
    expect(stored.find((a) => a.id !== earlier.id)).toMatchObject({ sessionId: "s_watch", triage: { decision: "filtered" } })
    expect(judged).toBe(0)
    expect(await world.runPromise(ActionQueue.use((queue) => queue.list))).toEqual([])
    const transcript = await world.runPromise(Store.use((store) => store.transcript("s_watch", 10)))
    expect(transcript.map((e) => e.text)).toContainEqual(expect.stringContaining("Signal rose again"))
  })
})
