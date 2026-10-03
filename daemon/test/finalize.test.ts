import { describe, expect, test } from "bun:test"
import { type Alert, NO_MILESTONES, type Session, type SessionStatus } from "../src/domain/model.ts"
import { decideOutcome, type FinalizeInput, shipStatus } from "../src/sessions/finalize.ts"
import type { SessionResult } from "../src/sessions/output.ts"
import { makeAlert, makeSession } from "./fixtures/records.ts"

const result = (overrides: Partial<SessionResult> = {}): SessionResult => ({
  outcome: "needs_human", rootCauseFound: true, diagnosis: "vite 6.4 dropped CJS", tried: [], summary: "pin vite",
  prUrl: null, recommendation: null, recommendationDetail: null, releasePrefix: null, ...overrides,
})
const releaseAlert = makeAlert({
  fields: { _tag: "release", image: "merkl-admin", version: "v0.6.0", actor: null, runId: "42", runUrl: null, tag: "admin-v0.6.0", stages: [] },
})
const inboxAlert: Alert = makeAlert({
  source: "inbox",
  fields: { _tag: "inbox", from: "U2", fromName: "Pierre", channelKind: "channel", via: "mention", threadTs: null, prUrl: null },
})
const running = (overrides: Partial<Session> = {}) => makeSession("running", { pushbacks: 1, ...overrides })
const decide = (input: Partial<FinalizeInput> & { readonly result: SessionResult }) =>
  decideOutcome({ session: running(), alert: releaseAlert, pushed: false, ...input })
const cardKinds = (d: ReturnType<typeof decideOutcome>) => d.cards.map((c) => (c._tag === "HandOff" ? `handoff:${c.title}` : c.action.kind))

describe("decideOutcome", () => {
  test("no root cause, first time: sent back, nothing reaches the user", () => {
    const d = decide({ session: running({ pushbacks: 0 }), result: result({ rootCauseFound: false }) })
    expect(d.sendBack).toContain("without a confirmed root cause")
    expect(d.patch).toMatchObject({ pushbacks: 1, activity: "Sent back: no confirmed root cause yet" })
    expect(d.cards).toEqual([])
    expect(d.patch.status).toBeUndefined()
  })

  const rows: ReadonlyArray<readonly [string, SessionResult, SessionStatus | undefined, Array<string>, boolean]> = [
    // label, result → status, cards, posts in the thread
    ["fix PR", result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", releasePrefix: "admin" }), "ci", [], true],
    ["fix without a PR fails", result({ outcome: "fix_pr" }), undefined, [], false],
    ["rerun recommendation", result({ outcome: "recommendation", recommendation: "rerun_failed_jobs" }), "waiting", ["rerun"], true],
    ["other recommendation", result({ outcome: "recommendation", recommendation: "revert" }), "waiting", ["handoff:Recommendation"], true],
    ["verified no-op resolves", result({ outcome: "no_action" }), "resolved", [], true],
    ["unverified no-op waits", result({ outcome: "no_action", rootCauseFound: false }), "waiting", ["handoff:Unverified"], false],
    ["needs you", result(), "waiting", ["handoff:Needs you"], false],
    ["root cause not found", result({ rootCauseFound: false }), "waiting", ["handoff:Root cause not found"], false],
  ]
  for (const [label, r, status, cards, posts] of rows) {
    test(label, () => {
      const d = decide({ result: r })
      expect(d.patch.status).toBe(status)
      expect(cardKinds(d)).toEqual(cards)
      expect(d.post !== null).toBe(posts)
    })
  }

  test("fix PR records the release prefix and the evidence", () => {
    const d = decide({ pushed: true, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", releasePrefix: "admin" }) })
    expect(d.patch).toMatchObject({ prUrl: "https://ghe/pull/1", release: { image: "merkl-admin", tag: "admin" }, milestones: { diagnosed: true, fixed: true, prOpened: true } })
    expect(d.fail).toBeNull()
    expect(decide({ result: result({ outcome: "fix_pr" }) }).fail).toBe("The agent reported a fix but opened no PR")
  })

  test("inbox items get a draft reply and post nothing themselves", () => {
    const d = decide({ alert: inboxAlert, result: result({ outcome: "recommendation" }) })
    expect(cardKinds(d)).toEqual(["reply"])
    expect(d.post).toBeNull()
    expect(cardKinds(decide({ alert: inboxAlert, result: result() }))).toEqual(["handoff:Needs you"])
  })

  test("M6: a side turn on a session with an open PR never resolves it", () => {
    const ci = running({ prUrl: "https://ghe/pull/1", outcome: "fix_pr", milestones: { ...NO_MILESTONES, prOpened: true } })
    const d = decide({ session: ci, alert: inboxAlert, result: result({ outcome: "no_action", rootCauseFound: true, summary: "answered Pierre" }) })
    expect(d.patch).toEqual({ milestones: { ...ci.milestones, diagnosed: true }, status: "ci", activity: "answered Pierre" })
    expect(cardKinds(d)).toEqual(["reply"])
    // …and is not sent back for a missing root cause either.
    expect(decide({ session: { ...ci, pushbacks: 0 }, result: result({ rootCauseFound: false }) }).sendBack).toBeNull()
  })

  test("a CI round on the same PR keeps shipping state and does not re-post the PR", () => {
    const deploying = running({
      prUrl: "https://ghe/pull/1",
      release: { image: "", tag: "admin-v0.6.1", version: "" },
      milestones: { ...NO_MILESTONES, prOpened: true, merged: true, released: true },
    })
    const d = decide({ session: deploying, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", releasePrefix: "admin" }) })
    expect(d.patch).toMatchObject({ status: "deploying", release: { tag: "admin-v0.6.1" } })
    expect(d.post).toBeNull()
  })

  test("a follow-up PR after a failed deploy ships on its own", () => {
    const released = running({
      prUrl: "https://ghe/pull/1",
      mergeRequestedAt: "t",
      releaseTag: "admin-v0.6.1",
      deployStage: { _tag: "Failed", stage: "Build", detail: "" },
      milestones: { ...NO_MILESTONES, prOpened: true, ciGreen: true, merged: true, released: true },
    })
    const d = decide({ session: released, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/2", releasePrefix: "admin" }) })
    expect(d.patch).toMatchObject({
      status: "ci",
      prUrl: "https://ghe/pull/2",
      mergeRequestedAt: null,
      releaseTag: null,
      deployStage: null,
      milestones: { prOpened: true, ciGreen: false, merged: false, released: false },
    })
    expect(d.post).toContain("https://ghe/pull/2")
  })

  test("what the agent tried goes to the transcript", () => {
    expect(decide({ result: result({ tried: ["grafana: nothing"] }) }).notes).toEqual(["Tried:\n· grafana: nothing"])
  })
})

describe("shipStatus", () => {
  test("where a shipping session goes back to", () => {
    expect(shipStatus(makeSession("running"))).toBeUndefined()
    expect(shipStatus(makeSession("running", { prUrl: "u" }))).toBe("ci")
    expect(shipStatus(makeSession("running", { prUrl: "u", release: { image: "", tag: "admin", version: "" }, milestones: { ...NO_MILESTONES, merged: true } }))).toBe("awaiting_release")
    expect(shipStatus(makeSession("running", { prUrl: "u", milestones: { ...NO_MILESTONES, merged: true, released: true } }))).toBe("deploying")
  })
})
