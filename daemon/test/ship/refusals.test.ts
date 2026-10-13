import { describe, expect, test } from "bun:test"
import { AdapterError, Conflict, GheBlocked } from "../../src/domain/errors.ts"
import type { PullRequest } from "../../src/ship/github.ts"
import { mergeFailure, notReadyToMerge } from "../../src/ship/refusals.ts"

const green: PullRequest = {
  number: 3340, title: "fix", state: "OPEN", mergedAt: null, isDraft: false, headRefOid: "aaaa111", url: "u",
  reviewDecision: "APPROVED", latestReviews: [], statusCheckRollup: [{ name: "checks", status: "COMPLETED", conclusion: "SUCCESS" }],
}
const failed = (name: string) => ({ name, status: "COMPLETED", conclusion: "FAILURE" })
const gh = (message: string) => new AdapterError({ adapter: "subprocess", operation: "gh pr merge", message: `exited 1: ${message}`, cause: null })

describe("why a PR is not ready to merge", () => {
  test("ready: no reason", () => {
    expect(notReadyToMerge(green, "#3340", true)).toBeNull()
  })
  test("each reason says what GitHub shows now", () => {
    expect(notReadyToMerge({ ...green, isDraft: true }, "#3340", true)).toBe("#3340 is a draft on GitHub.")
    expect(notReadyToMerge({ ...green, statusCheckRollup: [failed("lint")] }, "#3340", true)).toBe("CI failed on #3340: lint.")
    expect(notReadyToMerge({ ...green, statusCheckRollup: [failed("lint"), failed("build")] }, "#3340", true)).toBe("CI failed on #3340: lint and build.")
    expect(notReadyToMerge({ ...green, statusCheckRollup: ["a", "b", "c", "d"].map(failed) }, "#3340", true)).toBe("CI failed on #3340: a, b and 2 more.")
    expect(notReadyToMerge({ ...green, statusCheckRollup: [{ name: "checks", status: "IN_PROGRESS" }] }, "#3340", true)).toBe("CI is running again on #3340.")
    expect(notReadyToMerge({ ...green, statusCheckRollup: [] }, "#3340", true)).toBe("#3340 has no checks reported yet.")
    expect(notReadyToMerge({ ...green, reviewDecision: "CHANGES_REQUESTED" }, "#3340", true)).toBe("A reviewer requested changes on #3340.")
    expect(notReadyToMerge({ ...green, reviewDecision: "REVIEW_REQUIRED" }, "#3340", true)).toBe("#3340 needs an approving review.")
    expect(notReadyToMerge(green, "#3340", false)).toBe("#3340 changed since the model review passed it.")
  })
})

describe("a failed merge in the card's words", () => {
  test("GitHub's refusals become reasons, and leave the card for the next click", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["GraphQL: Pull request is not mergeable: the merge commit cannot be cleanly created (mergePullRequest)", "#3340 has conflicts with its base branch."],
      ["GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)", "New commits landed on #3340. Check them, then merge again."],
      ["GraphQL: Required status check \"ci-ok\" is expected. (mergePullRequest)", "GitHub is still waiting on a required check for #3340."],
      ["GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)", "GitHub requires an approving review on #3340."],
      ["GraphQL: Repository rule violations found (mergePullRequest)", "GitHub refused to merge #3340: Repository rule violations found"],
    ]
    for (const [stderr, reason] of cases) {
      const failure = mergeFailure(gh(stderr), "#3340")
      expect(failure._tag).toBe("Conflict")
      expect(failure.message).toBe(reason)
    }
  })
  test("GitHub not answering stays a failure to try again, said plainly", () => {
    const failure = mergeFailure(gh("HTTP 502: Bad Gateway (https://nocturlab.ghe.com/api/graphql)"), "#3340")
    expect(failure._tag).toBe("AdapterError")
    expect(failure.message).toBe("GitHub did not answer the merge (HTTP 502: Bad Gateway (https://nocturlab.ghe.com/api/graphql)). Merge again in a moment.")
  })
  test("the allow list keeps its tag, and a reason already given is kept", () => {
    const blocked = mergeFailure(new GheBlocked({ operation: "gh pr merge", message: "HTTP 403: … IP allow list enabled" }), "#3340")
    expect(blocked._tag).toBe("GheBlocked")
    expect(blocked.message).toBe("GitHub Enterprise refuses this network (its IP allow list).")
    const reason = new Conflict({ message: "CI is running again on #3340." })
    expect(mergeFailure(reason, "#3340")).toBe(reason)
  })
})
