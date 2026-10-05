import { describe, expect, test } from "bun:test"
import { NO_MILESTONES } from "../src/domain/model.ts"
import { nextTagFrom, type PullRequest } from "../src/ship/github.ts"
import {
  afterMerge,
  APPROVAL_TIMEOUT_MS,
  type CiStep,
  ciTransition,
  DEPLOY_TIMEOUT_MS,
  deployStalled,
  deployTransition,
  followsDeploy,
  MAX_CI_ROUNDS,
  MERGE_QUEUE_TIMEOUT_MS,
  needsReviewRequest,
  sendBackOrHandOff,
} from "../src/ship/transitions.ts"
import { makeSession } from "./fixtures/records.ts"

const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "fix(app-admin): pin vite", state: "OPEN", mergedAt: null, headRefOid: "aaaa111", url: "https://ghe/pull/7",
  reviewDecision: null, latestReviews: [], statusCheckRollup: [], ...overrides,
})
const red = { _tag: "Red" as const, failing: [{ name: "lint", url: "https://x/1" }] }
const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const shipping = (overrides = {}) => makeSession("ci", { prUrl: "https://ghe/pull/7", ...overrides })

describe("CI-round budget", () => {
  const failure = { phase: "ci" as const, working: (n: number) => `round ${n}`, exhausted: { activity: "over", title: "T", detail: "D" } }
  test("sends back while rounds remain, then hands off", () => {
    expect(sendBackOrHandOff(0, failure)).toEqual({ _tag: "SendBack", round: 1, phase: "ci", activity: "round 1" })
    expect(sendBackOrHandOff(MAX_CI_ROUNDS - 1, failure)).toMatchObject({ _tag: "SendBack", round: MAX_CI_ROUNDS })
    expect(sendBackOrHandOff(MAX_CI_ROUNDS, failure)).toEqual({ _tag: "HandOff", activity: "over", title: "T", detail: "D" })
  })
})

describe("ciTransition", () => {
  const review = { id: "r1", state: "CHANGES_REQUESTED", body: "rename it", author: { login: "pierre" } }
  const rows: ReadonlyArray<readonly [string, ReturnType<typeof shipping>, PullRequest, Parameters<typeof ciTransition>[2], CiStep["_tag"], string | null]> = [
    ["merged wins", shipping(), pr({ mergedAt: "now" }), red, "Merged", null],
    ["closed PR", shipping(), pr({ state: "CLOSED" }), { _tag: "Green" }, "Closed", null],
    ["waiting to merge, CI went red", shipping({ status: "awaiting_merge" }), pr({ reviewDecision: "APPROVED" }), red, "BackToCi", "CI went red on #7"],
    ["waiting to merge, CI running again", shipping({ status: "awaiting_merge" }), pr({ reviewDecision: "APPROVED" }), { _tag: "Pending" }, "BackToCi", "CI running again on #7"],
    ["waiting to merge, changes requested", shipping({ status: "awaiting_merge" }), pr({ reviewDecision: "CHANGES_REQUESTED" }), { _tag: "Green" }, "BackToCi", "Changes requested on #7"],
    ["waiting to merge, approval dismissed", shipping({ status: "awaiting_merge" }), pr({ reviewDecision: "REVIEW_REQUIRED" }), { _tag: "Green" }, "BackToCi", "#7 needs a review again"],
    ["waiting to merge, still ready", shipping({ status: "awaiting_merge" }), pr({ reviewDecision: "APPROVED" }), { _tag: "Green" }, "ReadyToMerge", "#7 approved and green, ready to merge"],
    ["waiting to merge, GitHub took it", shipping({ status: "awaiting_merge", mergeRequestedAt: new Date(NOW - 60_000).toISOString() }), pr({ reviewDecision: "APPROVED" }), { _tag: "Green" }, "Wait", null],
    ["waiting to merge, GitHub dropped it", shipping({ status: "awaiting_merge", mergeRequestedAt: new Date(NOW - MERGE_QUEUE_TIMEOUT_MS - 60_000).toISOString() }), pr({ reviewDecision: "APPROVED" }), { _tag: "Green" }, "ReadyToMerge", "#7 approved and green, ready to merge"],
    ["pending", shipping(), pr(), { _tag: "Pending" }, "Wait", "CI running on #7"],
    ["red, round 1", shipping(), pr(), red, "Red", "CI red — fixing (round 1)"],
    ["red, budget spent", shipping({ ciRounds: MAX_CI_ROUNDS }), pr(), red, "Red", "CI still red after 3 rounds"],
    ["green, review required", shipping({ review: { channelName: "product-approvals", permalink: null, handledReviewId: null, posted: true } }), pr({ reviewDecision: "REVIEW_REQUIRED" }), { _tag: "Green" }, "Wait", "CI green — waiting for review in #product-approvals"],
    ["green, changes requested", shipping(), pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [review] }), { _tag: "Green" }, "ChangesRequested", "Addressing pierre's review"],
    ["green, changes already handled", shipping({ review: { channelName: "c", permalink: null, handledReviewId: "r1", posted: true } }), pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [review] }), { _tag: "Green" }, "Wait", null],
    ["green, approved", shipping(), pr({ reviewDecision: "APPROVED" }), { _tag: "Green" }, "ReadyToMerge", "#7 approved and green, ready to merge"],
  ]
  for (const [label, session, pull, ci, tag, activity] of rows) {
    test(label, () => {
      const step = ciTransition(session, pull, ci, NOW)
      expect(step._tag).toBe(tag)
      const shown =
        step._tag === "Wait" || step._tag === "ReadyToMerge" || step._tag === "BackToCi"
          ? step.activity
          : step._tag === "Red" || step._tag === "ChangesRequested"
            ? step.escalation.activity
            : null
      expect(shown).toBe(activity)
    })
  }
  test("changes requested share the CI budget", () => {
    const step = ciTransition(shipping({ ciRounds: MAX_CI_ROUNDS }), pr({ reviewDecision: "CHANGES_REQUESTED", latestReviews: [review] }), { _tag: "Green" }, NOW)
    expect(step).toMatchObject({ _tag: "ChangesRequested", escalation: { _tag: "HandOff", title: "Changes requested" } })
  })
  test("review requested once, unless approved; dry run records it once", () => {
    expect(needsReviewRequest(shipping(), pr(), false)).toBe(true)
    expect(needsReviewRequest(shipping(), pr({ reviewDecision: "APPROVED" }), false)).toBe(false)
    const sent = { channelName: "c", permalink: null, handledReviewId: null, posted: true }
    expect(needsReviewRequest(shipping({ review: sent }), pr(), false)).toBe(false)
    const unsent = { ...sent, posted: false }
    expect(needsReviewRequest(shipping({ review: unsent }), pr(), false)).toBe(true)
    expect(needsReviewRequest(shipping({ review: unsent }), pr(), true)).toBe(false)
  })
})

describe("deployTransition (M3: only a changed release state moves the session)", () => {
  const deploying = (overrides = {}) => makeSession("deploying", { release: { image: "", tag: "admin-v0.6.1", version: "" }, ...overrides })
  const failed = { _tag: "Failed" as const, stage: "Build", detail: "1 attempt failed" }
  test("a first failure sends the agent back", () => {
    expect(deployTransition(deploying(), failed)).toMatchObject({ _tag: "Failed", escalation: { _tag: "SendBack", round: 1, activity: "Build failed — investigating" } })
  })
  test("a reaction or reply on the same failed tracker changes nothing", () => {
    expect(deployTransition(deploying({ deployStage: failed }), { ...failed, detail: "1 attempt failed · 👀" })).toEqual({ _tag: "Unchanged" })
  })
  test("a failure after the budget hands off as 'Deploy keeps failing'", () => {
    expect(deployTransition(deploying({ ciRounds: MAX_CI_ROUNDS }), failed)).toMatchObject({
      escalation: { _tag: "HandOff", title: "Deploy keeps failing", activity: "Build failed again" },
    })
  })
  test("progress, approval and success", () => {
    expect(deployTransition(deploying(), { _tag: "AwaitingApproval" })).toEqual({ _tag: "Progress", activity: "Waiting for release approval" })
    expect(deployTransition(deploying(), { _tag: "InProgress", stage: "ETL" })).toEqual({ _tag: "Progress", activity: "ETL in progress" })
    expect(deployTransition(deploying(), { _tag: "Deployed" })).toEqual({ _tag: "Deployed" })
  })
})

describe("deployStalled reads the stored stage, not the status line", () => {
  const ago = (ms: number) => new Date(NOW - ms - 60_000).toISOString()
  const approval = { _tag: "AwaitingApproval" } as const
  const release = { image: "", tag: "admin-v0.6.1", version: "" }
  test("quiet for 3h outside approval is stalled", () => {
    expect(deployStalled(makeSession("deploying", { updatedAt: ago(DEPLOY_TIMEOUT_MS), release }), NOW)).toMatchObject({ title: "Deploy stalled", detail: "No tracker update for admin-v0.6.1 in 3 hours." })
    expect(deployStalled(makeSession("deploying", { updatedAt: new Date(NOW).toISOString() }), NOW)).toBeNull()
    expect(deployStalled(makeSession("ci", { updatedAt: ago(DEPLOY_TIMEOUT_MS) }), NOW)).toBeNull()
  })
  test("approval gets a day, then it is handed to you too", () => {
    expect(deployStalled(makeSession("deploying", { updatedAt: ago(DEPLOY_TIMEOUT_MS), deployStage: approval, activity: "anything" }), NOW)).toBeNull()
    expect(deployStalled(makeSession("deploying", { updatedAt: ago(APPROVAL_TIMEOUT_MS), deployStage: approval, release }), NOW)).toMatchObject({ title: "Release not approved" })
  })
  test("a failure the tracker reported is not called a silent tracker", () => {
    const failed = { _tag: "Failed", stage: "Production", detail: "2 attempts failed" } as const
    expect(deployStalled(makeSession("deploying", { updatedAt: ago(DEPLOY_TIMEOUT_MS / 2), deployStage: failed, release }), NOW)).toBeNull()
    expect(deployStalled(makeSession("deploying", { updatedAt: ago(DEPLOY_TIMEOUT_MS), deployStage: failed, release }), NOW)).toEqual({
      _tag: "HandOff",
      activity: "Production failed, not taken up",
      title: "Deploy failed",
      detail: "Production failed for admin-v0.6.1 (2 attempts failed), and no agent turn took it up.",
    })
  })
})

describe("followsDeploy: a tracker moves only the session shipping its tag", () => {
  const tag = "admin-v0.6.0"
  const release = { image: "merkl-admin", tag, version: "" }
  test("before a release, an agent-named full tag is only a prefix", () => {
    for (const status of ["ci", "critiquing", "awaiting_merge", "awaiting_release", "waiting"] as const) {
      expect([status, followsDeploy(makeSession(status, { release }), tag)]).toEqual([status, false])
    }
  })
  test("a cut release, a re-run, and a deploy it already followed (handed back meanwhile)", () => {
    expect(followsDeploy(makeSession("deploying", { release }), tag)).toBe(true)
    expect(followsDeploy(makeSession("waiting", { release, milestones: { ...NO_MILESTONES, merged: true, released: true } }), tag)).toBe(true)
    expect(followsDeploy(makeSession("waiting", { release, deployStage: { _tag: "Failed", stage: "Build", detail: "" } }), tag)).toBe(true)
    expect(followsDeploy(makeSession("deploying", { release }), "admin-v0.6.1")).toBe(false)
    expect(followsDeploy(makeSession("waiting", { release, milestones: { ...NO_MILESTONES, released: true, deployed: true } }), tag)).toBe(false)
  })
  test("a re-run whose agent then opened a PR (naming the full tag) ships that PR, not the re-run's deploy", () => {
    const failed = { _tag: "Failed" as const, stage: "Build", detail: "" }
    expect(followsDeploy(makeSession("ci", { release, deployStage: failed, prUrl: "https://ghe/pull/9" }), tag)).toBe(false)
  })
})

describe("after the merge (M2)", () => {
  const merged = (tag: string | null) =>
    makeSession("awaiting_merge", { milestones: { ...NO_MILESTONES, merged: true }, release: tag === null ? null : { image: "", tag, version: "" } })
  test("nothing to ship, a prefix, a full tag, a bad prefix", () => {
    expect(afterMerge(merged(null))).toEqual({ _tag: "NothingToRelease" })
    expect(afterMerge(merged("admin"))).toEqual({ _tag: "Release", prefix: "admin" })
    expect(afterMerge(merged("states-exporter-v0.1.0"))).toEqual({ _tag: "Release", prefix: "states-exporter" })
    expect(afterMerge(merged("Admin App"))).toEqual({ _tag: "BadPrefix", prefix: "Admin App" })
    expect(afterMerge(merged("admin/../x"))).toMatchObject({ _tag: "BadPrefix" })
  })
  test("next tag: a patch bump, or v0.1.0 for a first release", () => {
    expect(nextTagFrom(["admin-v0.6.0", "admin-v0.6.10", "admin-v0.6.9", "api-v9.0.0"], "admin")).toBe("admin-v0.6.11")
    expect(nextTagFrom([], "drip")).toBe("drip-v0.1.0")
    expect(nextTagFrom(["admin-v0.6.0"], "adm")).toBe("adm-v0.1.0")
  })
})
