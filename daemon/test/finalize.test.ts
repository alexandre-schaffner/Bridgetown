import { describe, expect, test } from "bun:test"
import type { Alert } from "../src/domain/alert.ts"
import { NO_MILESTONES, type Session, type SessionStatus, shipStatus } from "../src/domain/session.ts"
import { decideOutcome, type FinalizeInput } from "../src/sessions/finalize.ts"
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
  decideOutcome({ session: running(), alert: releaseAlert, pushed: false, head: null, adversarialReview: false, ...input })
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
    const d = decide({ pushed: true, head: "abc", result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", releasePrefix: "admin" }) })
    expect(d.patch).toMatchObject({ prUrl: "https://ghe/pull/1", releasePrefix: "admin", milestones: { diagnosed: true, fixed: true, prOpened: true } })
    // A full tag is taken for its prefix.
    expect(decide({ result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", releasePrefix: "admin-v0.6.0" }) }).patch.releasePrefix).toBe("admin")
    expect(d.fail).toBeNull()
    expect(decide({ result: result({ outcome: "fix_pr" }) }).fail).toBe("The agent reported a fix but opened no PR")
  })

  test("inbox items get a draft reply", () => {
    expect(cardKinds(decide({ alert: inboxAlert, result: result({ outcome: "recommendation" }) }))).toEqual(["reply"])
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
      releasePrefix: "admin",
      releaseTag: "admin-v0.6.1",
      milestones: { ...NO_MILESTONES, prOpened: true, merged: true, released: true },
    })
    const d = decide({ session: deploying, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", releasePrefix: "api" }) })
    expect(d.patch).toMatchObject({ status: "deploying", releasePrefix: "admin" })
    expect(d.patch.releaseTag).toBeUndefined()
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
      tracker: null,
      milestones: { prOpened: true, ciGreen: false, merged: false, released: false },
    })
    expect(d.post).toContain("https://ghe/pull/2")
  })

  test("so does the first PR after a re-run that failed again: the re-run's deploy is no longer followed", () => {
    const reran = running({ releaseTag: "admin-v0.6.0", tracker: { id: "C1:tracker", applied: "h" }, sentBack: "deploy", deployStage: { _tag: "Failed", stage: "Build", detail: "" } })
    const d = decide({ session: reran, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/9", releasePrefix: "admin-v0.6.0" }) })
    expect(d.patch).toMatchObject({ status: "ci", prUrl: "https://ghe/pull/9", releasePrefix: "admin", releaseTag: null, deployStage: null, tracker: null })
  })

  describe("adversarial review", () => {
    const fix = result({ outcome: "fix_pr", prUrl: "https://ghe/pull/1", summary: "fixed the null check" })
    const passed = { reviewer: "codex" as const, sha: "abc", findings: [], response: null }
    const blocker = { file: "a.ts", line: 1, title: "overflows", failureScenario: "2^60 wei", jev: null, blocks: true }
    const failed = { ...passed, findings: [blocker] }

    test("a pushed fix goes to review before CI, still in draft", () => {
      const d = decide({ head: "abc", adversarialReview: true, result: fix })
      expect(d.patch).toMatchObject({ status: "critiquing", phase: "critique", activity: "Waiting for review", milestones: { critiqued: false, prOpened: true } })
      expect(d.markReady).toBeNull()
      expect(d.post).toContain("https://ghe/pull/1")
    })

    test("a head the review already passed goes straight to CI and leaves draft", () => {
      const d = decide({ session: running({ critique: passed }), head: "abc", adversarialReview: true, result: fix })
      expect(d.patch.status).toBe("ci")
      expect(d.markReady).toBe("https://ghe/pull/1")
    })

    test("new commits after a passed review are reviewed again", () => {
      const d = decide({ session: running({ critique: passed, prUrl: "https://ghe/pull/1" }), head: "def", adversarialReview: true, result: fix })
      expect(d.patch.status).toBe("critiquing")
    })

    test("the agent's summary is its reply to the last findings", () => {
      const d = decide({ session: running({ critique: failed, prUrl: "https://ghe/pull/1" }), head: "def", adversarialReview: true, result: fix })
      expect(d.patch.critique).toEqual({ ...failed, response: "fixed the null check" })
    })

    test("with the setting off a fix goes to CI and leaves draft", () => {
      const d = decide({ head: "abc", adversarialReview: false, result: fix })
      expect(d.patch).toMatchObject({ status: "ci", phase: "ci" })
      expect(d.markReady).toBe("https://ghe/pull/1")
    })

    test("a follow-up PR starts its review afresh", () => {
      const shipped = running({
        prUrl: "https://ghe/pull/1",
        critique: passed,
        critiqueRounds: 2,
        milestones: { ...NO_MILESTONES, prOpened: true, critiqued: true, ciGreen: true, merged: true, released: true },
      })
      const d = decide({ session: shipped, head: "abc", adversarialReview: true, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/2" }) })
      expect(d.patch).toMatchObject({ status: "critiquing", critique: null, critiqueRounds: 0, milestones: { critiqued: false, merged: false } })
    })

    test("a side turn on a draft no review passed goes to review, not CI", () => {
      // Handed back after the rounds ran out; your message gets an answer, not a fix.
      const handedBack = running({ prUrl: "https://ghe/pull/1", critique: failed, critiqueRounds: 4, milestones: { ...NO_MILESTONES, prOpened: true } })
      const d = decide({ session: handedBack, head: "abc", adversarialReview: true, result: result({ outcome: "needs_human", summary: "the finding is wrong because…" }) })
      expect(d.patch).toMatchObject({ status: "critiquing", phase: "critique", milestones: { critiqued: false } })
      // The rebuttal reaches the next round as the agent's reply.
      expect(d.patch.critique?.response).toBe("the finding is wrong because…")
      expect(d.markReady).toBeNull()
    })

    test("a side turn on a reviewed head goes back to CI, out of draft", () => {
      const reviewed = running({ prUrl: "https://ghe/pull/1", critique: passed, milestones: { ...NO_MILESTONES, prOpened: true, critiqued: true } })
      const d = decide({ session: reviewed, head: "abc", adversarialReview: true, result: result({ outcome: "no_action", summary: "answered" }) })
      expect(d.patch.status).toBe("ci")
      expect(d.markReady).toBe("https://ghe/pull/1")
    })

    test("a follow-up PR on another branch is reviewed by its own head", () => {
      const shipped = running({ prUrl: "https://ghe/pull/1", critique: passed, milestones: { ...NO_MILESTONES, prOpened: true, critiqued: true, merged: true, released: true } })
      // Even if the new PR's head happened to equal the old passed sha, a new PR starts its review afresh.
      const d = decide({ session: shipped, head: "abc", adversarialReview: true, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/2" }) })
      expect(d.patch.status).toBe("critiquing")
    })

    test("a later side turn keeps the agent's reply to the findings", () => {
      const answered = { ...failed, response: "the finding is wrong: amounts are bigint" }
      const fixing = running({ prUrl: "https://ghe/pull/1", critique: answered, milestones: { ...NO_MILESTONES, prOpened: true } })
      const d = decide({ session: fixing, head: "abc", adversarialReview: true, result: result({ outcome: "no_action", summary: "thanks, will look" }) })
      expect(d.patch.status).toBe("critiquing")
      expect(d.patch.critique).toBeUndefined()
    })

    test("a PR that went through CI before any review is not pulled into one by a follow-up", () => {
      const green = running({ prUrl: "https://ghe/pull/1", milestones: { ...NO_MILESTONES, prOpened: true, ciGreen: true } })
      const d = decide({ session: green, head: "abc", adversarialReview: true, result: result({ outcome: "no_action", summary: "answered" }) })
      expect(d.patch.status).toBe("ci")
    })

    test("CI and a passed review hold for their head: new commits are reviewed and checked again", () => {
      const green = running({ prUrl: "https://ghe/pull/1", critique: passed, milestones: { ...NO_MILESTONES, prOpened: true, critiqued: true, ciGreen: true } })
      expect(decide({ session: green, head: "def", adversarialReview: true, result: fix }).patch.milestones).toMatchObject({ critiqued: false, ciGreen: false })
      // With the review off, the old pass is no evidence for the new head either.
      expect(decide({ session: green, head: "def", adversarialReview: false, result: fix }).patch).toMatchObject({ status: "ci", milestones: { critiqued: false, ciGreen: false } })
      // The head the review passed: both stand.
      expect(decide({ session: green, head: "abc", adversarialReview: true, result: fix }).patch.milestones).toMatchObject({ critiqued: true, ciGreen: true })
    })

    test("a side turn on a merged session never goes back to review", () => {
      const deploying = running({ prUrl: "https://ghe/pull/1", milestones: { ...NO_MILESTONES, prOpened: true, merged: true, released: true } })
      expect(decide({ session: deploying, head: "new", adversarialReview: true, result: fix }).patch.status).toBe("deploying")
    })
  })

  describe("a send-back answered without a fix comes to you", () => {
    const deployFailed = running({
      prUrl: "https://ghe/pull/1",
      sentBack: "deploy",
      deployStage: { _tag: "Failed", stage: "Production", detail: "ETL deploy failed" },
      milestones: { ...NO_MILESTONES, prOpened: true, ciGreen: true, merged: true, released: true },
    })

    test("a revert recommendation after a failed deploy: handed off, posted, milestones kept", () => {
      const d = decide({ session: deployFailed, result: result({ outcome: "recommendation", recommendation: "revert", recommendationDetail: "Revert #1" }) })
      expect(d.patch).toMatchObject({ status: "waiting", outcome: "recommendation", milestones: { merged: true, released: true, deployed: false } })
      expect(d.cards).toEqual([{ _tag: "HandOff", title: "Deploy failed", detail: "Revert #1" }])
      expect(d.post).toContain("Revert #1")
    })

    for (const [sentBack, title] of [["ci", "CI still red"], ["changes", "Changes requested"]] as const) {
      test(`${sentBack}: needs you, with the diagnosis`, () => {
        const d = decide({ session: running({ prUrl: "https://ghe/pull/1", sentBack }), result: result({ diagnosis: "the runner is out of disk" }) })
        expect(d.patch.status).toBe("waiting")
        expect(d.cards).toEqual([{ _tag: "HandOff", title, detail: "the runner is out of disk" }])
        expect(d.post).toBeNull()
      })
    }

    test("a fix is still a fix: the follow-up PR ships", () => {
      const d = decide({ session: deployFailed, result: result({ outcome: "fix_pr", prUrl: "https://ghe/pull/2" }) })
      expect(d.patch.status).toBe("ci")
    })

    test("a fix with no follow-up PR after a failed deploy ships nothing: handed off, not back to a deploy that will not move", () => {
      for (const prUrl of [null, "https://ghe/pull/1"]) {
        const d = decide({ session: deployFailed, result: result({ outcome: "fix_pr", prUrl, diagnosis: "pushed to the merged branch" }) })
        expect(d.patch.status).toBe("waiting")
        expect(d.cards).toEqual([{ _tag: "HandOff", title: "Deploy failed", detail: "pushed to the merged branch" }])
      }
    })

    test("without a send-back the same answer is a side turn back to the deploy", () => {
      expect(decide({ session: { ...deployFailed, sentBack: null }, result: result({ outcome: "recommendation" }) }).patch.status).toBe("deploying")
    })
  })

  test("what the agent tried goes to the transcript", () => {
    expect(decide({ result: result({ tried: ["grafana: nothing"] }) }).notes).toEqual(["Tried:\n· grafana: nothing"])
  })
})

describe("shipStatus", () => {
  test("where a shipping session goes back to", () => {
    expect(shipStatus(makeSession("running"))).toBeUndefined()
    expect(shipStatus(makeSession("running", { prUrl: "u" }))).toBe("ci")
    expect(shipStatus(makeSession("running", { prUrl: "u", releasePrefix: "admin", milestones: { ...NO_MILESTONES, merged: true } }))).toBe("awaiting_release")
    expect(shipStatus(makeSession("running", { prUrl: "u", milestones: { ...NO_MILESTONES, merged: true, released: true } }))).toBe("deploying")
  })
})
