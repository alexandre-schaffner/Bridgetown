import { Effect, Schema } from "effect"
import { ReleaseState } from "./release.ts"

/** For fields added after rows were first persisted: a missing key decodes as `null`. */
const nullByDefault = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))

export const StageStatus = Schema.Literals(["pending", "in_progress", "success", "failure"])
export type StageStatus = typeof StageStatus.Type

export const Stage = Schema.Struct({
  name: Schema.String,
  status: StageStatus,
  detail: Schema.String,
})
export type Stage = typeof Stage.Type

export const ReleaseFields = Schema.TaggedStruct("release", {
  image: Schema.String,
  version: Schema.String,
  actor: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  runUrl: Schema.NullOr(Schema.String),
  tag: Schema.NullOr(Schema.String),
  stages: Schema.Array(Stage),
})
export type ReleaseFields = typeof ReleaseFields.Type

export const UptimeState = Schema.Literals(["incident", "resolved", "degraded", "recovered", "ssl_expiry", "other"])
export type UptimeState = typeof UptimeState.Type

export const UptimeFields = Schema.TaggedStruct("uptime", {
  target: Schema.String,
  state: UptimeState,
})
export type UptimeFields = typeof UptimeFields.Type

export const EngineFields = Schema.TaggedStruct("engine", {
  subject: Schema.String,
  error: Schema.String,
  txHash: Schema.NullOr(Schema.String),
})
export type EngineFields = typeof EngineFields.Type

export const InboxChannelKind = Schema.Literals(["dm", "group_dm", "channel"])
export type InboxChannelKind = typeof InboxChannelKind.Type

/** A message elsewhere in Slack that tags the user, one of their groups, or reaches them by DM. */
export const InboxFields = Schema.TaggedStruct("inbox", {
  from: Schema.String,
  fromName: Schema.String,
  channelKind: InboxChannelKind,
  via: Schema.Literals(["mention", "group", "dm"]),
  threadTs: Schema.NullOr(Schema.String),
  prUrl: Schema.NullOr(Schema.String),
})
export type InboxFields = typeof InboxFields.Type

export const GenericFields = Schema.TaggedStruct("generic", {})
export type GenericFields = typeof GenericFields.Type

export const AlertFields = Schema.Union([ReleaseFields, UptimeFields, EngineFields, InboxFields, GenericFields])
export type AlertFields = typeof AlertFields.Type

export const AlertSource = Schema.Literals(["releases", "uptime", "engine", "inbox", "generic"])
export type AlertSource = typeof AlertSource.Type

export const Decision = Schema.Literals(["pending", "filtered", "ignore", "suggest", "auto", "escalate"])
export type Decision = typeof Decision.Type

export const Depth = Schema.Literals(["quick", "standard", "deep"])
export type Depth = typeof Depth.Type

export const AlertKind = Schema.Literals([
  "build_failure",
  "deploy_failure",
  "runtime_error",
  "uptime_incident",
  "onchain_or_keeper",
  "infra_or_cert",
  "informational",
])
export type AlertKind = typeof AlertKind.Type

export const InboxKind = Schema.Literals([
  "code_change",
  "investigation",
  "technical_question",
  "test_request",
  "pr_review",
  "decision_or_approval",
  "personal_or_social",
  "fyi",
])
export type InboxKind = typeof InboxKind.Type

/**
 * Jev's answers, shared by alerts and inbox items. For inbox items `actionable` is
 * "this asks something of the user", `agentResolvable` is "an agent could do it",
 * and `humanOnIt` is "it has already been answered".
 */
export const JevVerdict = Schema.Struct({
  actionable: Schema.Number,
  agentResolvable: Schema.Number,
  humanOnIt: Schema.Number,
  kind: Schema.Union([AlertKind, InboxKind]),
  kindConfidence: Schema.Number,
  depth: Depth,
  urgency: Schema.Number,
})
export type JevVerdict = typeof JevVerdict.Type

export const Triage = Schema.Struct({
  decision: Decision,
  reason: Schema.String,
  jev: Schema.NullOr(JevVerdict),
})
export type Triage = typeof Triage.Type

export const Feedback = Schema.Literals(["good", "bad"])
export type Feedback = typeof Feedback.Type

export const AlertEvent = Schema.Struct({ at: Schema.String, text: Schema.String })
export type AlertEvent = typeof AlertEvent.Type

/** One line for the alert's history, from its triage. */
export const triageEvent = (triage: Triage): string => {
  switch (triage.decision) {
    case "filtered":
      return `Filtered by a rule: ${triage.reason}`
    case "ignore":
      return `Ignored by Jev: ${triage.reason}`
    case "suggest":
      return `Suggested to you: ${triage.reason}`
    case "auto":
      return `Handed to an agent: ${triage.reason}`
    case "escalate":
      return `Escalated to you: ${triage.reason}`
    case "pending":
      return "Waiting for triage"
  }
}

export const Disposition = Schema.Struct({ kind: Schema.Literals(["dismissed", "opened"]), at: Schema.String })
export type Disposition = typeof Disposition.Type

export const Alert = Schema.Struct({
  id: Schema.String,
  channelId: Schema.String,
  channelName: Schema.String,
  ts: Schema.String,
  permalink: Schema.NullOr(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  raw: Schema.String,
  source: AlertSource,
  fingerprint: Schema.String,
  fields: AlertFields,
  mentionsMe: Schema.Boolean,
  receivedAt: Schema.String,
  triage: Triage,
  sessionId: Schema.NullOr(Schema.String),
  feedback: Schema.NullOr(Feedback),
  /** What happened to this alert, oldest first: triage, your dismissals and investigations, edits. */
  events: Schema.Array(AlertEvent).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** What you last did to its card when no agent ran: dismissed it, or opened it in Slack or Revv. */
  disposition: nullByDefault(Disposition),
})
export type Alert = typeof Alert.Type

export const SessionStatus = Schema.Literals([
  "queued",
  "preparing",
  "running",
  "waiting",
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

export const Phase = Schema.Literals(["diagnose", "fix", "pr", "ci", "deploy", "done"])
export type Phase = typeof Phase.Type

export const Outcome = Schema.Literals(["fix_pr", "recommendation", "no_action", "needs_human"])
export type Outcome = typeof Outcome.Type

export const Recommendation = Schema.Literals(["rerun_failed_jobs", "revert", "no_code_change"])
export type Recommendation = typeof Recommendation.Type

export const NO_MILESTONES = {
  diagnosed: false,
  fixed: false,
  prOpened: false,
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
  claudeSessionId: Schema.NullOr(Schema.String),
  model: Schema.String,
  effort: Schema.String,
  ciRounds: Schema.Number,
  costUsd: Schema.Number,
  slackThreadUrl: Schema.NullOr(Schema.String),
  release: Schema.NullOr(Schema.Struct({ image: Schema.String, tag: Schema.String, version: Schema.String })),
  /** What is known to have happened, each set only on evidence. Drives the stepper. */
  milestones: Schema.Struct({
    diagnosed: Schema.Boolean,
    fixed: Schema.Boolean,
    prOpened: Schema.Boolean,
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
  /** Release prefix or image that owns the fix; picks the approvals channel and team. */
  component: nullByDefault(Schema.String),
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
  /** When Bridgetown asked GitHub to merge. Set before `gh pr merge`, so a repeat asks GitHub what happened instead of merging again. */
  mergeRequestedAt: nullByDefault(Schema.String),
  /** The tag Bridgetown is cutting or cut. Set before `gh release create`, so a repeat reuses it and never cuts a second one. */
  releaseTag: nullByDefault(Schema.String),
  /** The release tracker's last state seen for this session's deploy. Only a change moves the session. */
  deployStage: nullByDefault(ReleaseState),
  startedAt: Schema.String,
  updatedAt: Schema.String,
})
export type Session = typeof Session.Type

export const ActionKind = Schema.Literals([
  "investigate",
  "merge",
  "release",
  "rerun",
  "answer",
  "grafana",
  "review",
  "reply",
  "escalate",
])
export type ActionKind = typeof ActionKind.Type

export const Action = Schema.Struct({
  id: Schema.String,
  kind: ActionKind,
  title: Schema.String,
  detail: Schema.String,
  primaryLabel: Schema.String,
  options: Schema.Array(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  alertId: Schema.NullOr(Schema.String),
  payload: Schema.NullOr(Schema.String),
  /** Opened by the app when the primary button is pressed (Slack permalink, revv:// link). */
  url: nullByDefault(Schema.String),
  createdAt: Schema.String,
})
export type Action = typeof Action.Type

export const TranscriptKind = Schema.Literals(["text", "tool", "result", "status", "error"])
export type TranscriptKind = typeof TranscriptKind.Type

export const TranscriptEntry = Schema.Struct({
  at: Schema.String,
  kind: TranscriptKind,
  text: Schema.String,
})
export type TranscriptEntry = typeof TranscriptEntry.Type

export const Channel = Schema.Struct({ id: Schema.String, name: Schema.String, enabled: Schema.Boolean })
export type Channel = typeof Channel.Type

export const Thresholds = Schema.Struct({
  autoActionable: Schema.Number,
  autoResolvable: Schema.Number,
  autoHumanOnItMax: Schema.Number,
  suggestActionable: Schema.Number,
  suggestResolvable: Schema.Number,
})
export type Thresholds = typeof Thresholds.Type

export const Settings = Schema.Struct({
  channels: Schema.Array(Channel),
  thresholds: Thresholds,
  autoStart: Schema.Boolean,
  /** Watch mentions, group mentions and DMs across all of Slack, not just alert channels. */
  inbox: Schema.Boolean,
  maxConcurrent: Schema.Number,
  dryRun: Schema.Boolean,
  pollSeconds: Schema.Number,
  monorepoPath: Schema.String,
  deploymentRepoPath: Schema.String,
  quietHours: Schema.Struct({ enabled: Schema.Boolean, start: Schema.String, end: Schema.String }),
})
export type Settings = typeof Settings.Type

export const ACTIVE_STATUSES: ReadonlyArray<SessionStatus> = [
  "queued",
  "preparing",
  "running",
  "waiting",
  "ci",
  "awaiting_merge",
  "awaiting_release",
  "deploying",
]

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
      return session.worktree !== null && session.claudeSessionId !== null
  }
}

const CLOSING_KINDS: ReadonlyArray<ActionKind> = ["merge", "release", "review", "reply", "rerun"]

/** Dismissing this card leaves its session with nothing left to do, so the session is recorded as closed. */
export const dismissCloses = (action: Action, session: Session | undefined): boolean =>
  session !== undefined && isStranded(session) && CLOSING_KINDS.includes(action.kind)

/** The thread an alert lives in: an inbox item's own thread, or the alert message itself. */
export const threadTsOf = (alert: Alert): string => (alert.fields._tag === "inbox" ? (alert.fields.threadTs ?? alert.ts) : alert.ts)

const OPENABLE_SCHEMES = ["https:", "slack:", "revv:"]

/** A link the app may open, or `null`. Agents and Slack messages supply URLs; only these schemes get through. */
export const openableUrl = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  try {
    return OPENABLE_SCHEMES.includes(new URL(value).protocol) ? value : null
  } catch {
    return null
  }
}
