import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { alertDetailView, boardView, snapshotView, sweepView } from "../../src/api/views.ts"
import type { MemoryStatus } from "../../src/api/wire.ts"
import type { Action } from "../../src/domain/action.ts"
import type { Session } from "../../src/domain/session.ts"
import { DEFAULT_SETTINGS } from "../../src/domain/settings.ts"
import type { FetchedBoard, FetchedPanel } from "../../src/grafana/board.ts"
import { patternKey } from "../../src/watch/logs.ts"
import { measure, readingOf, type Reading } from "../../src/watch/detect.ts"
import { makeAlert, makeFinding, makeSession } from "../support/records.ts"

/**
 * The app's test fixtures (app/Tests/BridgetownTests/Fixtures) are what these builders send, so the app's tests decode
 * the daemon's real output, never a copy written by hand. A wire change fails here until the fixtures are rewritten
 * (`UPDATE_FIXTURES=1 bun test test/api/contract.test.ts`), and then `make test-app` until the app reads them.
 */

const FIXTURES = join(import.meta.dir, "../../../app/Tests/BridgetownTests/Fixtures")

const pinned = (name: string, wire: unknown) => {
  const path = join(FIXTURES, `${name}.json`)
  const sent: unknown = JSON.parse(JSON.stringify(wire))
  if (process.env.UPDATE_FIXTURES === "1") writeFileSync(path, `${JSON.stringify(sent, null, 2)}\n`)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(sent)
}

const NOW = new Date("2026-10-03T09:42:00.000Z")
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()

const jev = { actionable: 0.94, agentResolvable: 0.81, humanOnIt: 0.05, kind: "build_failure", kindConfidence: 0.9, depth: "standard", urgency: 2.1 } as const

const release = makeAlert({
  id: "C0AUKD42N3U:1790933006.433649", channelId: "C0AUKD42N3U", channelName: "alert-releases", ts: "1790933006.433649",
  permalink: "https://merkl.slack.com/archives/C0AUKD42N3U/p1790933006433649", title: "merkl-admin v0.6.0 · Build failed",
  summary: "vite build failed in the admin app", source: "releases", receivedAt: at(41),
  triage: { decision: "auto", reason: "Build failure an agent can fix without prod access", jev }, sessionId: "ses_running",
})
const engine = makeAlert({
  id: "C0AUK4AUER0:1790930000.000100", channelId: "C0AUK4AUER0", channelName: "alert-engine", ts: "1790930000.000100",
  title: "keeper · RPC timeouts", summary: "Keeper RPC calls timing out on Arbitrum", source: "engine", receivedAt: at(103),
  triage: { decision: "auto", reason: "Runtime error with logs available", jev: null }, sessionId: "ses_closed",
})
const recovered = makeAlert({
  id: "C0B001L8UQ1:1790920000.000300", channelId: "C0B001L8UQ1", channelName: "alert-uptime", ts: "1790920000.000300",
  permalink: "https://merkl.slack.com/archives/C0B001L8UQ1/p1790920000000300", title: "api.merkl.xyz · Recovered", summary: "Uptime check recovered",
  source: "uptime", receivedAt: at(269), triage: { decision: "filtered", reason: "Recovery notice", jev: null },
})
const slow = makeAlert({
  id: "C0B001L8UQ1:1790910000.000400", channelId: "C0B001L8UQ1", channelName: "alert-uptime", ts: "1790910000.000400",
  title: "status page · Slow response", summary: "p95 above 2s for 5 minutes", source: "uptime", receivedAt: at(435),
  raw: ":warning: *status page* p95 &gt; 2s · <https://grafana.merkl.xyz/d/abc|dashboard> cc <!subteam^S0DEV|dev-product> <@U0HUGO>",
  triage: { decision: "suggest", reason: "Might need an agent, not sure it's actionable", jev: { ...jev, actionable: 0.55, agentResolvable: 0.42, humanOnIt: 0.2, kind: "uptime_incident", kindConfidence: 0.7, depth: "quick", urgency: 1 } },
  disposition: { kind: "dismissed", at: at(422) },
  events: [{ at: at(435), text: "Suggested by Jev: Might need an agent, not sure it's actionable" }, { at: at(422), text: "Dismissed by you, no agent started" }],
})
const dm = makeAlert({
  id: "D0HUGO:1790930400.000200", channelId: "D0HUGO", channelName: "DM", ts: "1790930400.000200",
  permalink: "https://merkl.slack.com/archives/D0HUGO/p1790930400000200", title: "Hugo: can you review the fee change?", summary: "PR #3351",
  source: "inbox", receivedAt: at(482), triage: { decision: "escalate", reason: "PR reviews always go to you", jev: null },
  fields: { _tag: "inbox", from: "U0HUGO", fromName: "Hugo", channelKind: "dm", via: "dm", threadTs: null, prUrl: "https://nocturlab.ghe.com/Merkl/monorepo/pull/3351" },
})

const passed = { reviewer: "codex", sha: "4f1c2e9", findings: [makeFinding({ blocks: false }), makeFinding({ blocks: false })], response: null } as const
const running: Session = {
  ...makeSession("awaiting_merge", { id: "ses_running", alertId: release.id, title: release.title, channelName: release.channelName }),
  phase: "ci", activity: "Waiting for you to merge PR #3340", diagnosis: "vite 6.4 dropped `build.cssTarget`; the admin build relies on it.",
  outcome: "fix_pr", prUrl: "https://nocturlab.ghe.com/Merkl/monorepo/pull/3340", branch: "fix-bt-admin-vite",
  worktree: "/Users/alex/code/monorepo/.shared/worktrees/fix-bt-admin-vite", agentSessionId: "4f1c2e9a-0d1b-4c55-9a77-3f0b1e2d9c10",
  model: "claude-opus-5-5", ciRounds: 1, costUsd: 1.42, slackThreadUrl: release.permalink, rootCauseFound: true,
  milestones: { diagnosed: true, fixed: true, prOpened: true, critiqued: true, ciGreen: true, merged: false, released: false, deployed: false },
  review: { channelName: "product-approvals", permalink: "https://merkl.slack.com/archives/C0PRODAPP/p1790933900000100", handledReviewId: null, posted: true },
  critiqueRounds: 1, critique: passed, releasePrefix: "admin", startedAt: at(40), updatedAt: at(12),
}
const closed: Session = {
  ...makeSession("closed", { id: "ses_closed", alertId: engine.id, title: engine.title, channelName: engine.channelName }),
  phase: "done", activity: "Closed by you", outcome: "needs_human", model: "claude-sonnet-5-5", costUsd: 0.31, worktree: null, branch: null,
  rootCauseFound: false, resolution: "root cause not found", startedAt: at(102), updatedAt: at(90),
}

const card = (overrides: Partial<Action> & Pick<Action, "id" | "kind" | "title" | "primaryLabel">): Action => ({
  detail: "", options: [], sessionId: null, alertId: null, fingerprint: null, retry: false, url: null, createdAt: at(0), ...overrides,
})
const actions: ReadonlyArray<Action> = [
  card({ id: "act_merge_1", kind: "merge", title: "Merge fix(app-admin): pin vite to 6.3", detail: "PR #3340 · CI green · review approved in #product-approvals", primaryLabel: "Merge", sessionId: running.id, alertId: release.id, createdAt: at(2) }),
  card({ id: "act_review_1", kind: "review", title: "Agent finished without a fix", detail: "Root cause not found. Leads: the keeper's RPC timed out twice.", primaryLabel: "Close session", sessionId: closed.id, alertId: engine.id, createdAt: at(5) }),
  card({ id: "act_answer_1", kind: "answer", title: "Which environment should I check first?", detail: "The alert fired for both staging and prod.", primaryLabel: "Reply", options: ["prod", "staging"], sessionId: running.id, alertId: release.id, createdAt: at(7) }),
  card({ id: "act_escalate_1", kind: "escalate", title: "Hugo asked you to review the fee change", detail: "PR #3351 in Merkl/monorepo", primaryLabel: "Open in Revv", alertId: dm.id, url: "revv://pr?host=nocturlab.ghe.com&repo=Merkl%2Fmonorepo&number=3351", createdAt: at(12) }),
]

const sessions = [running, closed]
const alerts = [release, engine, recovered, slow, dm]

describe("the wire, as the app's fixtures hold it", () => {
  test("memory.json: local memory status", () => {
    const status: MemoryStatus = { enabled: true, path: "/Users/me/Library/Application Support/Bridgetown/memory", state: "idle", pending: 3, lastLearnedAt: "2026-10-07T10:00:00.000Z", lastDreamedAt: null, error: null }
    pinned("memory", status)
  })
  test("snapshot.json: a snapshot", () => {
    pinned(
      "snapshot",
      snapshotView({
        status: { paused: false, slack: "ok", jev: "ok", grafanaMcp: "down", github: "blocked", lastPollAt: at(0.8), error: null },
        dryRun: false,
        settings: {
          ...DEFAULT_SETTINGS,
          channels: [
            { id: "C0AUKD42N3U", name: "alert-releases", enabled: true },
            { id: "C0B001L8UQ1", name: "alert-uptime", enabled: false },
          ],
          dryRun: false,
          monorepoPath: "~/code/monorepo",
          deploymentRepoPath: "~/code/deployment",
          quietHours: { enabled: true, start: "22:00", end: "08:00" },
        },
        inFlight: new Set(["act_merge_1"]),
        sessions,
        actions,
        alerts,
        sessionsById: new Map(sessions.map((s) => [s.id, s])),
        alertsById: new Map(alerts.map((a) => [a.id, a])),
        metrics: { sessions: { started: 2, resolved: 0 } },
      }),
    )
  })

  test("alert-detail.json: an alert, its message as Markdown with people by name, and its history", () => {
    pinned("alert-detail", alertDetailView(slow, undefined, [], new Map(), new Set(), new Map([["U0HUGO", "Hugo"]])))
  })

  /** The watched API 5xx over the watch window: about 40 per 5 minutes, then 400 in the last three steps. */
  const watched: FetchedPanel = {
    id: "api_5xx", title: "API 5xx", unit: "count", link: "https://grafana.internal.merkl.xyz/d/pihjbxm", latest: 400, error: null,
    series: [{ label: "API 5xx", points: Array.from({ length: 36 }, (_, i) => [NOW.getTime() / 1000 - (36 - i) * 300, i >= 33 ? 400 : 35 + (i % 4) * 3] as const) }],
  }
  const measured = measure(watched, 300, NOW)
  const readings = new Map<string, Reading>(measured === null ? [] : [["api_5xx", readingOf(measured, new Date(NOW.getTime() - 120_000))]])

  test("board.json: a board, judged by the prod watcher's last look", () => {
    const from = new Date(NOW.getTime() - 3 * 3_600_000)
    const step = 1_800
    const points = (values: ReadonlyArray<number>) => values.map((v, i) => [from.getTime() / 1000 + i * step, v] as const)
    const board: FetchedBoard = {
      title: "Incidents", from: from.toISOString(), to: NOW.toISOString(), stepSeconds: step, marker: null, fetchedAt: at(0.5), error: null,
      deploys: [{ at: at(95), image: "merkl-api", version: "v1.35.11", stage: "engine", status: "deployed" }],
      panels: [
        { id: "api_5xx", title: "API 5xx", unit: "count", series: [{ label: "API 5xx", points: points([230, 250, 210, 260, 240, 2400]) }], latest: 2400, link: "https://grafana.internal.merkl.xyz/d/pihjbxm", error: null },
        { id: "api_p99", title: "API p99 latency", unit: "ms", series: [], latest: null, link: "https://grafana.internal.merkl.xyz/d/pihjbxm", error: "timed out" },
        {
          id: "pods", title: "Pods by version", unit: "count", link: "https://grafana.internal.merkl.xyz/d/k8s", error: null, latest: 6,
          series: [{ label: "v1.35.10", points: points([4, 4, 4, 1, 0, 0]) }, { label: "v1.35.11", points: points([0, 0, 0, 3, 6, 6]) }],
        },
      ],
    }
    const wire = boardView(board, readings, NOW)
    pinned("board", wire)
    // Per 5 minutes on the watch board, per 30 minutes on this one.
    expect(wire.panels[0]).toMatchObject({ usual: expect.closeTo(6 * readings.get("api_5xx")!.usual, 6), spike: expect.any(Number) })
    expect(wire.panels.slice(1).map((p) => [p.usual, p.spikeAbove, p.spike])).toEqual([[null, null, null], [null, null, null]])
    // Around an alert long ago, the watcher's look now says nothing about how unusual it was then.
    expect(boardView({ ...board, to: at(600) }, readings, NOW).panels[0]?.spike).toBeNull()
    // A watcher that stopped looking (watching turned off) judges nothing.
    expect(boardView(board, readings, new Date(NOW.getTime() + 3_600_000)).panels[0]?.usual).toBeNull()
  })

  test("log-sweep.json: the last log sweep", () => {
    const message = "RPC call failed with status <N>"
    const pattern = {
      sweep: "errors", key: patternKey("errors", message), sources: ["merkl-compute-*"], sourceFilter: `merkl.job:~"^merkl-compute-[0-9]+$"`, message,
      example: "RPC call failed with status 429", versions: ["v1.62.35"], recent: 220, usual: 4.04, behaviour: "surging",
    } as const
    const warning = {
      ...pattern, sweep: "warnings", key: patternKey("warnings", "Rate limited"), sources: ["merkl-precompute-*", "merkl-compute-*"], message: "Rate limited",
      example: "Rate limited", versions: [], recent: 1813, usual: 1812.44, behaviour: "steady",
    } as const
    const record = { at: at(5), patterns: [warning, pattern], failures: [] }
    const judged = { [pattern.key]: { at: at(5), verdict: { problem: 0.46, agent: 0.38, users: 0.21 }, alertId: null } }
    pinned("log-sweep", sweepView(record, judged, NOW, null))
  })
})
