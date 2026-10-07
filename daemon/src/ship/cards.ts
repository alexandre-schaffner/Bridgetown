import { passedAt, REVIEWER_NAMES } from "../domain/critique.ts"
import type { Session } from "../domain/session.ts"
import type { PullRequest } from "./github.ts"
import { prLabel } from "./pr.ts"

/**
 * What the human-gate cards say under their title. A gate card is where the user decides,
 * so it shows the evidence the click rests on (who approved, what passed), never a plan
 * or the diagnosis again, and only what GitHub and the review actually recorded.
 */

/** "#3352 · approved by julien · CI green, 4 checks · Codex passed". */
export const mergeDetail = (session: Session, pr: PullRequest): string => {
  const approvers = [...new Set(pr.latestReviews.filter((r) => r.state === "APPROVED").map((r) => r.author.login))]
  const checks = pr.statusCheckRollup.length
  const critique = session.critique
  return [
    `#${pr.number}`,
    // Ready to merge also covers repos that require no approval: say who only when someone did.
    ...(approvers.length > 0 ? [`approved by ${approvers.join(", ")}`] : []),
    checks > 0 ? `CI green, ${checks === 1 ? "1 check" : `${checks} checks`}` : "CI green",
    // Only a pass on the head being merged: one on an earlier head (pushed again with the review off) is no evidence.
    ...(critique !== null && passedAt(critique, pr.headRefOid) ? [`${REVIEWER_NAMES[critique.reviewer]} passed`] : []),
  ].join(" · ")
}

/** "Merged #3352. Cutting dispute-v0.4.3 starts the deploy; …": the PR by number, not its URL. */
export const releaseDetail = (prUrl: string | null, tag: string, prefix: string): string => {
  const merged = prUrl === null ? "Merged." : `Merged ${prLabel(prUrl)}.`
  const first = tag.endsWith("-v0.1.0") ? ` This is the first ${prefix} release.` : ""
  return `${merged} Cutting ${tag} starts the deploy; approval stays with the reviewers.${first}`
}
