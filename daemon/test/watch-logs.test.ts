import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionQueue } from "../src/actions/queue.ts"
import { AdapterError } from "../src/domain/errors.ts"
import type { GrafanaShape } from "../src/grafana/client.ts"
import { Hub } from "../src/hub.ts"
import { Store } from "../src/store/store.ts"
import type { JevShape } from "../src/triage/jev.ts"
import { logPatternQuestions, type LogPatternInput } from "../src/watch/judge.ts"
import { BATCH, behaviourOf, behaviourText, candidates, linesQuery, logFinding, mergeRows, type PatternRow, rowOf, sweepQuery } from "../src/watch/logs.ts"
import { Watcher } from "../src/watch/watcher.ts"
import { makeWorld, noGrafana } from "./fixtures/world.ts"

const DEADLOCK = "\nInvalid `prisma.nodesSources.upsert()` invocation:\n\nTransaction failed due to a write conflict or a deadlock. Please retry your transaction"
const GOLDSKY = "Error fetching batch <N>/<N>: Rate limited: the preview community blocks subgraphs are being retired, and this shared endpoint is now throttled and will be removed"

/** A sweep row as VictoriaLogs returns it: every value a string, `sample` and `versions` JSON-encoded. */
const raw = (fields: Record<string, string>, recent: number, total: number, sample = fields._msg ?? ""): Record<string, string> => ({
  ...fields,
  recent: String(recent),
  total: String(total),
  sample: JSON.stringify({ sample }),
  versions: JSON.stringify(["v1.62.35"]),
})

const row = (overrides: Partial<PatternRow>): PatternRow => ({
  sweep: "errors", source: "merkl-fetch-nodes", sourceFilter: `merkl.job:~"^merkl-fetch-nodes$"`, message: DEADLOCK, example: DEADLOCK, versions: [], recent: 27, total: 27, ...overrides,
})

describe("a sweep row", () => {
  test("a job's numbers are a wildcard in its name and a digit class in its filter", () => {
    const parsed = rowOf("warnings", raw({ "merkl.job": "merkl-compute-<N>", "k8s.container.name": "main", _msg: GOLDSKY }, 860, 7_000, "Error fetching batch 1/1: Rate limited…"))
    expect(parsed).toMatchObject({
      source: "merkl-compute-*",
      sourceFilter: `merkl.job:~"^merkl-compute-[0-9]+$"`,
      example: "Error fetching batch 1/1: Rate limited…",
      versions: ["v1.62.35"],
      recent: 860,
      total: 7_000,
    })
  })

  test("a deployment, else a container, names a service", () => {
    expect(rowOf("errors", raw({ "k8s.deployment.name": "public-gateway", "k8s.container.name": "envoy", _msg: "upstream reset" }, 12, 40))?.sourceFilter).toBe(`k8s.deployment.name:="public-gateway"`)
    expect(rowOf("errors", raw({ "k8s.container.name": "merkl-api-v4", _msg: "boom" }, 12, 40))?.source).toBe("merkl-api-v4")
  })

  test("a name that cannot be quoted safely gets no filter, and an empty message no row", () => {
    expect(rowOf("errors", raw({ "merkl.job": `x" OR *`, _msg: "boom" }, 12, 40))?.sourceFilter).toBeNull()
    expect(rowOf("errors", raw({ "merkl.job": "x", _msg: "  " }, 12, 40))).toBeUndefined()
  })
})

describe("behaviour, merging and picking", () => {
  test("new, surging or steady over the window", () => {
    expect(behaviourOf("errors", 27, 27).behaviour).toBe("new")
    // 22 lines over the 95 earlier 15-minute steps of the day: 27 now is far above that.
    expect(behaviourOf("errors", 27, 49).behaviour).toBe("surging")
    expect(behaviourOf("errors", 114, 5_472).behaviour).toBe("steady")
    expect(behaviourOf("errors", 15, 16).behaviour).toBe("steady")
  })

  test("the same message from several jobs is one pattern, busiest first", () => {
    const [merged, ...rest] = mergeRows([
      row({ sweep: "warnings", source: "merkl-compute-*", sourceFilter: "A", message: GOLDSKY, recent: 860, total: 7_000 }),
      row({ sweep: "warnings", source: "merkl-precompute-*", sourceFilter: "B", message: GOLDSKY, recent: 953, total: 7_500 }),
    ])
    expect(rest).toHaveLength(0)
    expect(merged).toMatchObject({ sources: ["merkl-precompute-*", "merkl-compute-*"], sourceFilter: "(B OR A)", recent: 1_813, behaviour: "steady" })
  })

  test("one unquotable source drops the source filter for the whole pattern", () => {
    expect(mergeRows([row({ sourceFilter: "A" }), row({ source: "y", sourceFilter: null })])[0]?.sourceFilter).toBeNull()
  })

  test("steady errors are noise, risky warnings count even when steady; judged ones wait a day", () => {
    const patterns = mergeRows([
      row({ message: "new error", recent: 15, total: 15 }),
      row({ message: "steady error", recent: 114, total: 5_472 }),
      row({ message: "surging error", recent: 40, total: 60 }),
      row({ sweep: "warnings", message: GOLDSKY, recent: 900, total: 7_000 }),
      row({ message: "judged", recent: 30, total: 30 }),
    ])
    const judged = new Set(patterns.filter((p) => p.message === "judged").map((p) => p.key))
    expect(candidates(patterns, judged).map((p) => p.message)).toEqual(["new error", "surging error", GOLDSKY])
  })

  test("at most one batch", () => {
    const many = mergeRows(Array.from({ length: BATCH + 5 }, (_, i) => row({ message: `new error ${i}`, recent: 20, total: 20 })))
    expect(candidates(many, new Set())).toHaveLength(BATCH)
  })
})

describe("what Jev and the agent read", () => {
  const [pattern] = mergeRows([row({ sweep: "warnings", message: GOLDSKY, example: "Error fetching batch 1/1: Rate limited…", recent: 900, total: 7_000 })])
  if (pattern === undefined) throw new Error("setup")

  test("behaviour in words, numbers worked out in code", () => {
    expect(behaviourText(pattern)).toBe("Steady: 900 lines in the last 15 minutes, about as often as over the 2 hours before.")
    expect(behaviourText(mergeRows([row({ recent: 40, total: 60 })])[0] ?? pattern)).toBe("Surging: 40 lines in the last 15 minutes, about 190× its usual rate over the day before.")
  })

  test("the lines query keeps whole words and the levels, not the risk words", () => {
    const query = linesQuery(pattern)
    expect(query).toBe(`(severity_text:="WARN" OR severity_text:="WARNING") merkl.job:~"^merkl-fetch-nodes$" "and this shared endpoint is now throttled and will be"`)
  })

  test("the sweep queries are constants with a 15-minute recent count", () => {
    expect(sweepQuery("errors")).toContain(`count() if (_time:15m) recent`)
    expect(sweepQuery("warnings")).toContain(`"will be removed"`)
  })

  test("one batched call: three yes/no questions per pattern, each about its own entry", () => {
    const questions = logPatternQuestions(2)
    expect(Object.keys(questions)).toEqual(["p0_problem", "p0_agent", "p0_users", "p1_problem", "p1_agent", "p1_users"])
    expect(JSON.stringify(questions.p1_problem)).toContain("`patterns[1]`")
  })

  test("the finding", () => {
    const finding = logFinding(pattern, { problem: 0.9, agent: 0.6, users: 0.4 }, new Date("2026-10-04T12:00:00Z"), "https://grafana/explore")
    expect(finding).toMatchObject({ channelName: "Grafana", source: "watch", fields: { _tag: "watch", datasource: "logs", level: 900 } })
    expect(finding.fingerprint).toStartWith("watch:log:")
    expect(finding.title).toStartWith("merkl-fetch-nodes: Error fetching batch 1/1")
    expect(finding.summary).toContain("since 11:45 UTC")
    expect(finding.raw).toContain("Jev: problem 90% · agent 60% · users affected 40%")
  })
})

describe("Watcher.sweepLogs", () => {
  let sweeps = 0
  const grafana: GrafanaShape = {
    ...noGrafana,
    logRows: (query) =>
      Effect.sync(() => {
        sweeps++
        if (query.includes(`severity_text:="ERROR"`)) {
          return [raw({ "merkl.job": "merkl-fetch-nodes", _msg: DEADLOCK }, 27, 27), raw({ "merkl.job": "merkl-compute-<N>", _msg: "Fetched Campaign: undefined" }, 114, 5_472)]
        }
        return [raw({ "merkl.job": "merkl-compute-<N>", _msg: GOLDSKY }, 860, 7_000)]
      }),
  }
  let batches: Array<ReadonlyArray<LogPatternInput>> = []
  let failJev = true
  const jev: JevShape = {
    judge: () => Effect.die("unused"),
    judgeInbox: () => Effect.die("unused"),
    judgeFinding: () => Effect.die("unused"),
    judgeLogPatterns: (patterns) =>
      failJev
        ? Effect.fail(new AdapterError({ adapter: "jev", operation: "systemOne", message: "down", cause: null }))
        : Effect.sync(() => {
            batches.push(patterns)
            // The deadlock is a problem; the retirement notice, here, is called noise.
            return patterns.map((p) => (p.message.includes("deadlock") ? { problem: 0.88, agent: 0.7, users: 0.2 } : { problem: 0.2, agent: 0.5, users: 0.1 }))
          }),
  }
  const world = makeWorld({ jev, grafana })
  afterAll(() => world.dispose())
  const sweep = () => world.runPromise(Watcher.use((watcher) => watcher.sweepLogs))
  const findings = () => world.runPromise(Store.use((store) => store.recentAlerts(50)).pipe(Effect.map((alerts) => alerts.filter((a) => a.source === "watch"))))

  test("nothing while the Grafana MCP is down", async () => {
    await sweep()
    expect(sweeps).toBe(0)
  })

  test("Jev down: nothing raised, nothing remembered", async () => {
    await world.runPromise(Hub.use((hub) => hub.patchStatus({ grafanaMcp: "up" })))
    await sweep()
    expect(sweeps).toBe(2)
    expect(await findings()).toHaveLength(0)
    expect((await world.runPromise(Hub.use((hub) => hub.status))).jev).toBe("error")
  })

  test("one batch for the candidates; only Jev's problems become suggestions", async () => {
    failJev = false
    await sweep()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.map((p) => p.level)).toEqual(["error", "warning"])
    const [finding, ...rest] = await findings()
    expect(rest).toHaveLength(0)
    expect(finding).toMatchObject({ channelName: "Grafana", triage: { decision: "suggest" }, sessionId: null })
    expect(finding?.triage.reason).toStartWith("Jev: likely a real problem (problem 88%")
    expect(finding?.permalink).toStartWith("https://grafana.internal.merkl.xyz/explore?")
    const cards = await world.runPromise(ActionQueue.use((queue) => queue.list))
    expect(cards).toEqual([expect.objectContaining({ kind: "investigate", alertId: finding?.id })])
  })

  test("judged patterns are not asked about again", async () => {
    await sweep()
    expect(batches).toHaveLength(1)
    expect(await findings()).toHaveLength(1)
  })

  test("off in settings: no queries", async () => {
    const before = sweeps
    await world.runPromise(Hub.use((hub) => hub.settings.pipe(Effect.flatMap((s) => hub.updateSettings({ ...s, watchProd: false })))))
    await sweep()
    expect(sweeps).toBe(before)
  })
})
