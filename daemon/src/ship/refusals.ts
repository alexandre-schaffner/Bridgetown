import { AdapterError, Conflict, GheBlocked, type GitHubError } from "../domain/errors.ts"
import { ciState, type PullRequest, transientGitHub } from "./github.ts"

/**
 * Why a Merge click did not merge, in the words the card shows under the PR: what GitHub says about it
 * now, never a raw `gh` error. A reason the user can act on is a `Conflict`, which leaves the card for
 * the next click.
 */

/** What stops the PR merging as GitHub reads it now, or `null` when nothing does. */
export const notReadyToMerge = (pr: PullRequest, label: string, reviewPassed: boolean): string | null => {
  if (pr.isDraft === true) return `${label} is a draft on GitHub.`
  const ci = ciState(pr)
  if (ci._tag === "Red") return `CI failed on ${label}: ${names(ci.failing.map((check) => check.name))}.`
  if (ci._tag === "Pending") return pr.statusCheckRollup.length === 0 ? `${label} has no checks reported yet.` : `CI is running again on ${label}.`
  if (pr.reviewDecision === "CHANGES_REQUESTED") return `A reviewer requested changes on ${label}.`
  if (pr.reviewDecision === "REVIEW_REQUIRED") return `${label} needs an approving review.`
  if (!reviewPassed) return `${label} changed since the model review passed it.`
  return null
}

/** "lint", "lint and build", "lint, build and 2 more". */
const names = (all: ReadonlyArray<string>): string => {
  const shown = all.slice(0, 2)
  const more = all.length - shown.length
  if (more > 0) return `${shown.join(", ")} and ${more} more`
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : (shown[0] ?? "a check")
}

/** What GitHub said, without `gh`'s wrapping: `exited 1: GraphQL: … (mergePullRequest)`. */
const said = (message: string): string =>
  message.replace(/^exited \d+:\s*/, "").replace(/^GraphQL:\s*/, "").replace(/\s*\(mergePullRequest\)\s*$/, "").trim()

/** A failed merge as the card's reason. A refusal becomes a `Conflict`; GitHub not answering stays what it was. */
export const mergeFailure = (error: GitHubError | Conflict, label: string): GitHubError | Conflict => {
  if (error._tag === "Conflict") return error
  if (error._tag === "GheBlocked") return new GheBlocked({ operation: error.operation, message: "GitHub Enterprise refuses this network (its IP allow list)." })
  const message = said(error.message)
  if (transientGitHub(error)) {
    const answer = `GitHub did not answer the merge (${message.slice(0, 120)}). Merge again in a moment.`
    return new AdapterError({ adapter: error.adapter, operation: error.operation, message: answer, cause: error.cause })
  }
  if (/cannot be cleanly created|merge conflict/i.test(message)) return new Conflict({ message: `${label} has conflicts with its base branch.` })
  if (/Head branch was modified|head commit|expected head/i.test(message)) return new Conflict({ message: `New commits landed on ${label}. Check them, then merge again.` })
  if (/required status check/i.test(message)) return new Conflict({ message: `GitHub is still waiting on a required check for ${label}.` })
  if (/approving review|review is required/i.test(message)) return new Conflict({ message: `GitHub requires an approving review on ${label}.` })
  return new Conflict({ message: `GitHub refused to merge ${label}: ${message.slice(0, 200)}` })
}
