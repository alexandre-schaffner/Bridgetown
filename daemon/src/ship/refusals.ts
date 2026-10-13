import { AdapterError, GheBlocked, type GitHubError, type MergeRefused } from "../domain/errors.ts"
import { ciState, type PullRequest, said, transientGitHub } from "./github.ts"
import { mergeBlock } from "./transitions.ts"

// Why a Merge click did not merge, in the words the card shows under the PR: what GitHub says about it now, never a
// raw `gh` error. A reason the user can act on is a `MergeRefused`, which leaves the card for the next click.

/**
 * What stops the PR merging as GitHub reads it now, or `null` when nothing does: what holds the merge gate
 * (`mergeBlock`), and what only a click checks: a draft (the tick takes a PR out of draft), and a head the model
 * review did not pass.
 */
export const notReadyToMerge = (pr: PullRequest, label: string, reviewPassed: boolean): string | null => {
  if (pr.isDraft === true) return `${label} is a draft on GitHub.`
  const block = mergeBlock(pr, ciState(pr))
  if (block === null) return reviewPassed ? null : `${label} changed since the model review passed it.`
  switch (block._tag) {
    case "CiRed":
      return `CI failed on ${label}: ${names(block.failing.map((check) => check.name))}.`
    case "CiPending":
      return pr.statusCheckRollup.length === 0 ? `${label} has no checks reported yet.` : `CI is running again on ${label}.`
    case "ChangesRequested":
      return `A reviewer requested changes on ${label}.`
    case "ReviewRequired":
      return `${label} needs an approving review.`
  }
}

/** "lint", "lint and build", "lint, build and 2 more". */
const names = (all: ReadonlyArray<string>): string => {
  const shown = all.slice(0, 2)
  const more = all.length - shown.length
  if (more > 0) return `${shown.join(", ")} and ${more} more`
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : (shown[0] ?? "a check")
}

/**
 * A failed merge as the card's reason, once its retries are spent. GitHub's own refusals are `MergeRefused` already
 * (`mergePr`); GitHub not answering, or refusing this network, is said plainly and stays a failure.
 */
export const mergeFailure = (error: GitHubError | MergeRefused): GitHubError | MergeRefused => {
  if (error._tag === "GheBlocked") return new GheBlocked({ operation: error.operation, message: "GitHub Enterprise refuses this network (its IP allow list)." })
  if (error._tag === "AdapterError" && transientGitHub(error)) {
    const answer = `GitHub did not answer the merge (${said(error.message).slice(0, 120)}). Merge again in a moment.`
    return new AdapterError({ adapter: error.adapter, operation: error.operation, message: answer, cause: error.cause })
  }
  return error
}
