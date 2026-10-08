import { Effect, Schema } from "effect"
import { escapeRegExp } from "../lib/text.ts"
import { AgentProvider, ClaudeEffort } from "./models.ts"
import { Critique } from "./critique.ts"
import { ReleaseState } from "./release.ts"
import { nullByDefault } from "./schema.ts"

export const SessionStatus = Schema.Literals([
  "queued",
  "preparing",
  "running",
  "waiting",
  "critiquing",
  "ci",
  "awaiting_merge",
  "awaiting_release",
  "deploying",
  "resolved",
  "closed",
  "failed",
  "stopped",
])
export type SessionStatus = typeof SessionStatus.Type

export const Phase = Schema.Literals(["diagnose", "fix", "pr", "critique", "ci", "deploy", "done"])
export type Phase = typeof Phase.Type

export const Outcome = Schema.Literals(["fix_pr", "recommendation", "no_action", "needs_human"])
export type Outcome = typeof Outcome.Type

export const Recommendation = Schema.Literals(["rerun_failed_jobs", "revert", "no_code_change"])
export type Recommendation = typeof Recommendation.Type

/** How hard the agent thinks, as the Claude SDK takes it. */
export const Effort = ClaudeEffort
export type Effort = typeof Effort.Type

/** What Bridgetown sent the agent back to fix while shipping: red CI, a reviewer's requested changes, a failed deploy. */
export const SentBack = Schema.Literals(["ci", "changes", "deploy"])
export type SentBack = typeof SentBack.Type

export const NO_MILESTONES = {
  diagnosed: false,
  fixed: false,
  prOpened: false,
  critiqued: false,
  ciGreen: false,
  merged: false,
  released: false,
  deployed: false,
}

export const Session = Schema.Struct({
  id: Schema.String,
  alertId: Schema.String,
  title: Schema.String,
  channelName: Schema.String,
  status: SessionStatus,
  phase: Phase,
  activity: Schema.String,
  diagnosis: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Outcome),
  recommendation: Schema.NullOr(Recommendation),
  prUrl: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktree: Schema.NullOr(Schema.String),
  repoPath: Schema.String,
  provider: AgentProvider.pipe(Schema.withDecodingDefaultKey(Effect.succeed("claude"))),
  agentSessionId: nullByDefault(Schema.String),
  agentConfigDir: nullByDefault(Schema.String),
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
  ciRounds: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  slackThreadUrl: Schema.NullOr(Schema.String),
  /** What is known to have happened, each set only on evidence. Drives the stepper. */
  milestones: Schema.Struct({
    diagnosed: Schema.Boolean,
    fixed: Schema.Boolean,
    prOpened: Schema.Boolean,
    /** The current head passed the adversarial review. Added later: old rows decode as not reviewed. */
    critiqued: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    ciGreen: Schema.Boolean,
    merged: Schema.Boolean,
    released: Schema.Boolean,
    deployed: Schema.Boolean,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(NO_MILESTONES))),
  rootCauseFound: nullByDefault(Schema.Boolean),
  /** The honest one-line outcome once the session is over. */
  resolution: nullByDefault(Schema.String),
  /** Times Bridgetown sent the agent back because it handed off without a root cause. */
  pushbacks: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /**
   * The release prefix the agent named for its fix (`admin` for `admin-vX.Y.Z`): what the release gate cuts after the
   * merge, and the team whose approvals channel reviews it. `null`: nothing to release.
   */
  releasePrefix: nullByDefault(Schema.String),
  /** The review request Bridgetown posted in an approvals channel. */
  review: nullByDefault(
    Schema.Struct({
      channelName: Schema.String,
      permalink: Schema.NullOr(Schema.String),
      handledReviewId: Schema.NullOr(Schema.String),
      /** Whether the request actually reached Slack. Unsent requests are retried once posting is possible. */
      posted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
  ),
  /** When GitHub took the merge without merging yet (a merge queue): the PR is GitHub's to merge, and no Merge card is offered again. */
  mergeRequestedAt: nullByDefault(Schema.String),
  /** Adversarial reviews that sent the agent back on this PR. */
  critiqueRounds: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** The last adversarial review of the pushed head, and the agent's reply to it. */
  critique: nullByDefault(Critique),
  reviewProfile: nullByDefault(Schema.Struct({ vendor: AgentProvider, model: Schema.String, effort: Schema.NullOr(Schema.String) })),
  /**
   * The release this session ships: the tag it is cutting or cut (set before `gh release create`, so a repeat reuses
   * it and never cuts a second one; `milestones.released` says it was cut), or the one a re-run it recommended follows.
   */
  releaseTag: nullByDefault(Schema.String),
  /** The release tracker's last state seen for this session's deploy. Only a change moves the session. */
  deployStage: nullByDefault(ReleaseState),
  /**
   * That tracker's alert, edited in place for hours (so the poll reads it on its own, however far down its channel it
   * is), and the version of it this session took in (`applied`, its content hash). A version that came in while the
   * session's agent was busy is applied by the ship loop once it is not.
   */
  tracker: nullByDefault(Schema.Struct({ id: Schema.String, applied: Schema.NullOr(Schema.String) })),
  /** Set with a send-back, cleared by the turn that answers it: a result without a fix then comes to you. */
  sentBack: nullByDefault(SentBack),
  startedAt: Schema.String,
  updatedAt: Schema.String,
})
export type Session = typeof Session.Type

export const TranscriptKind = Schema.Literals(["text", "tool", "result", "status", "error"])
export type TranscriptKind = typeof TranscriptKind.Type

export const TranscriptEntry = Schema.Struct({
  at: Schema.String,
  kind: TranscriptKind,
  text: Schema.String,
})
export type TranscriptEntry = typeof TranscriptEntry.Type

export const ACTIVE_STATUSES: ReadonlyArray<SessionStatus> = [
  "queued",
  "preparing",
  "running",
  "waiting",
  "critiquing",
  "ci",
  "awaiting_merge",
  "awaiting_release",
  "deploying",
]
/** Statuses past the review, on the way to production. */
export const SHIPPING_STATUSES: ReadonlyArray<SessionStatus> = ["ci", "awaiting_merge", "awaiting_release", "deploying"]
/** Statuses where Bridgetown or the agent is working on the session, rather than waiting on someone. */
export const WORKING_STATUSES: ReadonlyArray<SessionStatus> = ["preparing", "running", "critiquing", "ci", "deploying"]

export const isActive = (session: Session): boolean => ACTIVE_STATUSES.includes(session.status)

/** Over: resolved, closed, failed or stopped. Only explicit paths (retry, close, your message) change these. */
export const isFinished = (session: Session): boolean => !isActive(session)

/** Nothing moves it forward but your click: its card is the only way on, so dismissing that card closes it. */
export const isStranded = (session: Session): boolean =>
  session.status === "waiting" || session.status === "awaiting_merge" || session.status === "awaiting_release" || session.status === "failed"

/**
 * Whether the session holds one of the `maxConcurrent` agent slots: preparing,
 * running, or with an SDK process still alive (an agent blocked on `ask` is
 * `waiting` but its process is not gone). `live` is the runner's set of sessions
 * with an SDK query open.
 */
export const holdsSlot = (session: Session, live: ReadonlySet<string>): boolean =>
  session.status === "preparing" || session.status === "running" || live.has(session.id)

/**
 * Whether a message can reach the agent: a turn is running (it waits for the
 * next one), or the session was handed back with its worktree and agent session
 * intact, so a resumed turn picks it up. Queued and preparing sessions have no
 * agent yet; a resolved one is done.
 */
export const acceptsMessages = (session: Session): boolean => {
  switch (session.status) {
    case "queued":
    case "preparing":
    case "resolved":
      return false
    case "running":
      return session.worktree !== null
    default:
      return session.worktree !== null && session.agentSessionId !== null
  }
}

/** The honest one-line outcome of a session you close without a verified fix. Never "resolved". */
export const closedResolution = (session: Session): string =>
  session.status === "failed"
    ? "agent failed"
    : session.rootCauseFound === false
      ? "root cause not found"
      : session.outcome === "recommendation"
        ? "recommendation handed to you"
        : session.milestones.merged
          ? "merged, not released"
          : session.milestones.prOpened
            ? "PR open, not merged"
            : "not fixed"

/**
 * The session's branch, or a follow-up `<branch>-N` (a fix after its first PR merged): the only branches its agent
 * may push, so the only heads a PR of its may have.
 */
export const isOwnBranch = (branch: string, name: string): boolean => name === branch || new RegExp(`^${escapeRegExp(branch)}-\\d+$`).test(name)

/** A patch applied to a session; `milestones` merge instead of replacing. */
export const withPatch = (session: Session, patch: Partial<Session>): Session => ({
  ...session,
  ...patch,
  milestones: { ...session.milestones, ...patch.milestones },
})

/**
 * Where a session with a PR in flight goes back to after a side turn (a
 * teammate's follow-up, your message): the ship flow, which re-checks GitHub
 * and the tracker on its own. `undefined` when nothing is shipping.
 */
export const shipStatus = (session: Session): SessionStatus | undefined => {
  const m = session.milestones
  if (m.released && !m.deployed) return "deploying"
  if (m.merged && !m.released) return session.releasePrefix === null ? undefined : "awaiting_release"
  if (session.prUrl !== null && !m.merged) return "ci"
  return undefined
}

/**
 * Whether a restart cut this session off mid-turn: preparing, running, or
 * waiting on an `ask` (`asking`: its answer card names it; or it has no outcome
 * yet, which only an ask leaves). A waiting session handed back with a result is
 * not: its card still works.
 */
export const wasInterrupted = (session: Session, asking: boolean): boolean =>
  session.status === "preparing" || session.status === "running" || (session.status === "waiting" && (session.outcome === null || asking))

/** What you are told when a session comes back to you: its status line and its card. */
export interface HandOff {
  readonly activity: string
  readonly title: string
  readonly detail: string
}
