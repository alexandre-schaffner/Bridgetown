import type { Phase, Session } from "../domain/model.ts"
import { type ReleaseState, sameReleaseState } from "../domain/release.ts"
import type { CiState, PullRequest } from "./github.ts"
import { prLabel } from "./review.ts"

/**
 * The ship flow's decisions, pure: given a session and what GitHub or the
 * release tracker says, what happens next. The shipper interprets them (writes,
 * cards, turns, posts); these functions never touch the world, so they are
 * table-tested.
 */

/** Rounds an agent gets to fix CI, requested changes and failed deploys, together. */
export const MAX_CI_ROUNDS = 3
/** A deploy with no tracker progress for this long (outside approval) is handed to you. */
export const DEPLOY_TIMEOUT_MS = 3 * 60 * 60_000
/** Approval is slow by design, but not this slow: a release nobody approved for a day is handed to you. */
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000
/** A merge GitHub took (a merge queue) but has not done in this long is offered to you again. */
export const MERGE_QUEUE_TIMEOUT_MS = 60 * 60_000

/** Another round for the agent, or the user once the budget is spent. */
export type Escalation =
  | { readonly _tag: "SendBack"; readonly round: number; readonly phase: Phase; readonly activity: string }
  | { readonly _tag: "HandOff"; readonly activity: string; readonly title: string; readonly detail: string }

export interface Failure {
  /** Phase for the new round. */
  readonly phase: Phase
  /** Status line while the agent works on round `n`. */
  readonly working: (round: number) => string
  /** What the user sees once the budget is spent. */
  readonly exhausted: { readonly activity: string; readonly title: string; readonly detail: string }
}

/** A round budget: by default the CI one, shared by red CI, requested changes and failed deploys. */
export const sendBackOrHandOff = (rounds: number, failure: Failure, max: number = MAX_CI_ROUNDS): Escalation =>
  rounds >= max
    ? { _tag: "HandOff", ...failure.exhausted }
    : { _tag: "SendBack", round: rounds + 1, phase: failure.phase, activity: failure.working(rounds + 1) }

type Review = PullRequest["latestReviews"][number]

export type CiStep =
  | { readonly _tag: "Merged" }
  | { readonly _tag: "Closed" }
  /** Nothing to do; `activity`, when set, is the new status line. */
  | { readonly _tag: "Wait"; readonly activity: string | null }
  | { readonly _tag: "Red"; readonly failing: Extract<CiState, { _tag: "Red" }>["failing"]; readonly escalation: Escalation }
  | { readonly _tag: "ChangesRequested"; readonly review: Review; readonly escalation: Escalation }
  | { readonly _tag: "ReadyToMerge"; readonly activity: string }
  /** Waiting to merge no longer holds (CI not green, a review that blocks it): back to the CI loop, without its Merge card. */
  | { readonly _tag: "BackToCi"; readonly activity: string }

/** Once CI is green, a review is requested once (and an unsent one retried), unless the PR is already approved. */
export const needsReviewRequest = (session: Session, pr: PullRequest, dryRun: boolean): boolean =>
  session.prUrl !== null &&
  session.review?.posted !== true &&
  pr.reviewDecision !== "APPROVED" &&
  // In dry run the unsent request is recorded once instead of every tick.
  !(dryRun && session.review !== null)

const readyToMerge = (pr: PullRequest): CiStep => ({ _tag: "ReadyToMerge", activity: `#${pr.number} approved and green, ready to merge` })

/**
 * A session waiting to merge, read again every tick: it stays only while CI is green and no review blocks the PR.
 * A merge GitHub took (`mergeRequestedAt`) is GitHub's to finish; one it has plainly dropped is offered again.
 */
const atMergeGate = (session: Session, pr: PullRequest, ci: CiState, nowMs: number): CiStep => {
  if (ci._tag === "Red") return { _tag: "BackToCi", activity: `CI went red on #${pr.number}` }
  if (ci._tag === "Pending") return { _tag: "BackToCi", activity: `CI running again on #${pr.number}` }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { _tag: "BackToCi", activity: `Changes requested on #${pr.number}` }
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { _tag: "BackToCi", activity: `#${pr.number} needs a review again` }
  const queued = session.mergeRequestedAt !== null && nowMs - Date.parse(session.mergeRequestedAt) < MERGE_QUEUE_TIMEOUT_MS
  return queued ? { _tag: "Wait", activity: null } : readyToMerge(pr)
}

/** A session in `ci` or `awaiting_merge`, given its PR and that PR's checks. */
export const ciTransition = (session: Session, pr: PullRequest, ci: CiState, nowMs: number): CiStep => {
  if (pr.mergedAt !== null) return { _tag: "Merged" }
  if (pr.state === "CLOSED") return { _tag: "Closed" }
  if (session.status === "awaiting_merge") return atMergeGate(session, pr, ci, nowMs)
  switch (ci._tag) {
    case "Pending":
      return { _tag: "Wait", activity: `CI running on #${pr.number}` }
    case "Red":
      return {
        _tag: "Red",
        failing: ci.failing,
        escalation: sendBackOrHandOff(session.ciRounds, {
          phase: "ci",
          working: (round) => `CI red — fixing (round ${round})`,
          exhausted: {
            activity: `CI still red after ${MAX_CI_ROUNDS} rounds`,
            title: "CI still red",
            detail: ci.failing.map((f) => f.name).join(", "),
          },
        }),
      }
    case "Green": {
      if (pr.reviewDecision === "CHANGES_REQUESTED") {
        const review = pr.latestReviews.find((r) => r.state === "CHANGES_REQUESTED")
        // Each review goes back to the agent once.
        if (review === undefined || session.review?.handledReviewId === review.id) return { _tag: "Wait", activity: null }
        return {
          _tag: "ChangesRequested",
          review,
          escalation: sendBackOrHandOff(session.ciRounds, {
            phase: "fix",
            working: () => `Addressing ${review.author.login}'s review`,
            exhausted: { activity: "Changes requested — over to you", title: "Changes requested", detail: `${review.author.login}: ${review.body}` },
          }),
        }
      }
      if (pr.reviewDecision === "REVIEW_REQUIRED") {
        return { _tag: "Wait", activity: `CI green — waiting for review in #${session.review?.channelName ?? "approvals"}` }
      }
      return readyToMerge(pr)
    }
  }
}

export type DeployStep =
  /** The tracker changed nothing that matters (a reaction, a reply, a new attempt count). */
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Failed"; readonly stage: string; readonly detail: string; readonly escalation: Escalation }
  | { readonly _tag: "Deployed" }
  | { readonly _tag: "Progress"; readonly activity: string }

/**
 * Whether `tag`'s release tracker reports this session's own deploy: it cut that release (or re-ran it) and the
 * deploy has not landed. Before a release, `release.tag` is only the prefix the agent named, which can be a full tag:
 * the tracker of that tag (the failure being fixed) says nothing about this session. A re-run sent back once it failed
 * again still follows it, until the agent opens a PR of its own: from then on it ships that PR.
 */
export const followsDeploy = (session: Session, tag: string): boolean =>
  session.release?.tag === tag &&
  !session.milestones.deployed &&
  (session.status === "deploying" || session.milestones.released || (session.deployStage !== null && session.prUrl === null))

/** A deploying session, given the tracker's state. Only a changed state moves it: a tracker edit never re-sends the agent. */
export const deployTransition = (session: Session, state: ReleaseState): DeployStep => {
  if (sameReleaseState(session.deployStage, state)) return { _tag: "Unchanged" }
  switch (state._tag) {
    case "Failed":
      return {
        _tag: "Failed",
        stage: state.stage,
        detail: state.detail,
        escalation: sendBackOrHandOff(session.ciRounds, {
          phase: "fix",
          working: () => `${state.stage} failed — investigating`,
          exhausted: { activity: `${state.stage} failed again`, title: "Deploy keeps failing", detail: `${state.stage}: ${state.detail}` },
        }),
      }
    case "Deployed":
      return { _tag: "Deployed" }
    case "AwaitingApproval":
      return { _tag: "Progress", activity: "Waiting for release approval" }
    case "InProgress":
      return { _tag: "Progress", activity: `${state.stage} in progress` }
    case "Starting":
      return { _tag: "Progress", activity: "Deploy in progress" }
  }
}

/**
 * A deploy that went quiet, as the hand-off that says so; `null` while it is moving. Waiting for approval gets a day.
 * A failure the tracker reported is no stall: it sits here only when its send-back never ran (a restart dropped the
 * turn parked for a slot), and the hand-off says that.
 */
export const deployStalled = (session: Session, nowMs: number): Extract<Escalation, { _tag: "HandOff" }> | null => {
  if (session.status !== "deploying") return null
  const tag = session.release?.tag ?? "the release"
  const quiet = nowMs - Date.parse(session.updatedAt)
  const stage = session.deployStage
  switch (stage?._tag) {
    case "AwaitingApproval":
      return quiet > APPROVAL_TIMEOUT_MS
        ? { _tag: "HandOff", activity: "No release approval for 24h", title: "Release not approved", detail: `${tag} has been waiting for approval for a day.` }
        : null
    case "Failed":
      return quiet > DEPLOY_TIMEOUT_MS
        ? { _tag: "HandOff", activity: `${stage.stage} failed, not taken up`, title: "Deploy failed", detail: `${stage.stage} failed for ${tag} (${stage.detail}), and no agent turn took it up.` }
        : null
    default:
      return quiet > DEPLOY_TIMEOUT_MS
        ? { _tag: "HandOff", activity: "No deploy progress for 3h", title: "Deploy stalled", detail: `No tracker update for ${tag} in 3 hours.` }
        : null
  }
}

/** `admin`, `states-exporter`: what may stand before `-vX.Y.Z` in a release tag. */
const RELEASE_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `admin-v0.6.0` → `admin`; a bare prefix stays as it is. */
export const tagPrefix = (tag: string): string => tag.replace(/-v\d+\.\d+\.\d+.*$/, "")

export type AfterMerge =
  | { readonly _tag: "NothingToRelease" }
  | { readonly _tag: "Release"; readonly prefix: string }
  /** The agent named something that cannot be a release prefix; the user decides. */
  | { readonly _tag: "BadPrefix"; readonly prefix: string }

export const afterMerge = (session: Session): AfterMerge => {
  if (session.release === null || session.release.tag === "") return { _tag: "NothingToRelease" }
  const prefix = tagPrefix(session.release.tag)
  return RELEASE_PREFIX.test(prefix) ? { _tag: "Release", prefix } : { _tag: "BadPrefix", prefix }
}

/** "merged #3244" for a merged session with nothing to ship. */
export const mergedResolution = (prUrl: string | null): string => `merged ${prUrl === null ? "" : prLabel(prUrl)}`.trim()
