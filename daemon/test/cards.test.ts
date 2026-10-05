import { describe, expect, test } from "bun:test"
import type { PullRequest } from "../src/ship/github.ts"
import { mergeDetail, releaseDetail } from "../src/ship/cards.ts"
import { mergedResolution } from "../src/ship/transitions.ts"
import { makeSession } from "./fixtures/records.ts"

const PR = "https://nocturlab.ghe.com/Merkl/monorepo/pull/3352"
const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 3352, title: "fix(api): reject an empty region", state: "OPEN", mergedAt: null, url: PR,
  reviewDecision: "APPROVED", latestReviews: [], statusCheckRollup: [], ...overrides,
})
const review = (login: string, state: string) => ({ id: `r-${login}`, state, body: "", author: { login } })
const check = { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }
const passed = { reviewer: "codex" as const, sha: "abc", findings: [], response: null }

describe("merge card", () => {
  test("names who approved, what passed and the second review", () => {
    const session = makeSession("awaiting_merge", { prUrl: PR, critique: passed })
    const detail = mergeDetail(session, pr({ headRefOid: "abc", latestReviews: [review("julien", "APPROVED")], statusCheckRollup: [check, check, check, check] }))
    expect(detail).toBe("#3352 · approved by julien · CI green, 4 checks · Codex passed")
  })

  test("a pass on an earlier head is not claimed for the one being merged", () => {
    const session = makeSession("awaiting_merge", { prUrl: PR, critique: passed })
    expect(mergeDetail(session, pr({ headRefOid: "def", statusCheckRollup: [check] }))).toBe("#3352 · CI green, 1 check")
  })

  test("claims no approval when nobody approved (a repo that requires none)", () => {
    const session = makeSession("awaiting_merge", { prUrl: PR })
    const detail = mergeDetail(session, pr({ reviewDecision: null, latestReviews: [review("pierre", "COMMENTED")], statusCheckRollup: [check] }))
    expect(detail).toBe("#3352 · CI green, 1 check")
  })

  test("a review that still blocks is not called passed", () => {
    const blocking = { ...passed, findings: [{ file: "a.ts", line: 1, title: "t", failureScenario: "f", jev: null, blocks: true }] }
    const detail = mergeDetail(makeSession("awaiting_merge", { critique: blocking }), pr())
    expect(detail).not.toContain("Codex")
  })
})

describe("release card", () => {
  test("refers to the PR by number, not its URL", () => {
    expect(releaseDetail(PR, "dispute-v0.4.3", "dispute")).toBe(
      "Merged #3352. Cutting dispute-v0.4.3 starts the deploy; approval stays with the reviewers.",
    )
  })

  test("says when it is the first release", () => {
    expect(releaseDetail(PR, "states-exporter-v0.1.0", "states-exporter")).toContain("This is the first states-exporter release.")
  })

  test("a resolution names the PR by number", () => {
    expect(mergedResolution(PR)).toBe("merged #3352")
    expect(mergedResolution(null)).toBe("merged")
  })

  test("keeps a link it can't read a number from", () => {
    expect(releaseDetail("https://example.com/x", "api-v1.0.1", "api")).toStartWith("Merged https://example.com/x.")
  })
})
