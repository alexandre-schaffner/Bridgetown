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

/** A prod signal Bridgetown saw rise in Grafana on its own, with no Slack message behind it. */
export const WatchFields = Schema.TaggedStruct("watch", {
  /** The overview panel's id, e.g. `api_5xx`. */
  signal: Schema.String,
  /** The query that showed it, for the agent to run again through the grafana MCP. */
  query: Schema.String,
  datasource: Schema.Literals(["prom", "logs"]),
  /** Median of the last 15 minutes, and the 90th percentile of the 3 hours before. */
  level: Schema.Number,
  usual: Schema.Number,
  since: Schema.String,
  /** A rise (where the signal sits) or a spike (one step, already over); log patterns are rises. Added later, so defaulted. */
  shape: Schema.Literals(["rise", "spike"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("rise" as const))),
})
export type WatchFields = typeof WatchFields.Type

/** The channel of a watch finding: it comes from Grafana, not a Slack channel. The app shows it without a "#". */
export const WATCH_CHANNEL = { id: "grafana", name: "Grafana" } as const

/** Where an alert came from, as written in text: `#channel`, or "Grafana" for a watch finding. */
export const channelLabel = (alert: { readonly source: AlertSource; readonly channelName: string }): string =>
  alert.source === "watch" ? WATCH_CHANNEL.name : `#${alert.channelName}`

export const AlertFields = Schema.Union([ReleaseFields, UptimeFields, EngineFields, InboxFields, GenericFields, WatchFields])
export type AlertFields = typeof AlertFields.Type

/** `watch`: found by Bridgetown in Grafana, not posted in Slack. */
export const AlertSource = Schema.Literals(["releases", "uptime", "engine", "inbox", "generic", "watch"])
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

/** What became of an alert's last card: you dismissed or opened it, or Bridgetown withdrew it (its signal went back to normal, or a later verdict left nothing to do). */
export const Disposition = Schema.Struct({ kind: Schema.Literals(["dismissed", "opened", "withdrawn"]), at: Schema.String })
export type Disposition = typeof Disposition.Type

/**
 * A teammate on an alert, as its Slack message says: their Bridgetown posted
 * that it is investigating (`agent`), or they reacted 👀 (`eyes`).
 */
export const Claimant = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  via: Schema.Literals(["agent", "eyes"]),
  /** Their Bridgetown's latest post in the thread, without the 🤖. */
  latest: Schema.NullOr(Schema.String),
})
export type Claimant = typeof Claimant.Type

/** "Alice's agent is on it", "Bob is on it": the first claimant, who got there first. */
export const claimHeadline = (claimedBy: ReadonlyArray<Claimant>): string | null => {
  const [first] = claimedBy
  if (first === undefined) return null
  const others = claimedBy.length - 1
  const who = first.via === "agent" ? `${first.name}'s agent` : first.name
  return `${who} is on it${others === 0 ? "" : ` (+${others})`}`
}

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
  /** Teammates on it per Slack, first claim first; never you. Read again whenever the message or its thread changes. */
  claimedBy: Schema.Array(Claimant).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})
export type Alert = typeof Alert.Type

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

/** What the adversarial reviewer reports: where, what, and how it fails. */
export const ReviewFinding = Schema.Struct({
  file: Schema.String,
  line: Schema.NullOr(Schema.Number),
  title: Schema.String,
  failureScenario: Schema.String,
})
export type ReviewFinding = typeof ReviewFinding.Type

/** Only the reviewer's fields, for anything (Jev, a prompt) that must not see Bridgetown's verdict on them. */
export const reviewFindingOf = ({ file, line, title, failureScenario }: ReviewFinding): ReviewFinding => ({ file, line, title, failureScenario })

/** Jev's judgment of one reviewer finding: is it a real defect, would it block the PR, does the author's reply answer it. */
export const FindingVerdict = Schema.Struct({
  realDefect: Schema.Number,
  blocking: Schema.Number,
  /** Only from the second round, when the author has replied. */
  rebutted: Schema.NullOr(Schema.Number),
})
export type FindingVerdict = typeof FindingVerdict.Type

export const Finding = Schema.Struct({
  ...ReviewFinding.fields,
  /** `null` when Jev could not judge it; it then blocks. */
  jev: Schema.NullOr(FindingVerdict),
  blocks: Schema.Boolean,
})
export type Finding = typeof Finding.Type

export const ReviewerVendor = Schema.Literals(["codex"])
export type ReviewerVendor = typeof ReviewerVendor.Type

/** How the reviewer is named in the transcript and status line. */
export const REVIEWER_NAMES: Readonly<Record<ReviewerVendor, string>> = { codex: "Codex" }

export const Critique = Schema.Struct({
  reviewer: ReviewerVendor,
  /** The head the review read. */
  sha: Schema.String,
  findings: Schema.Array(Finding),
  /** The agent's summary after its last fix: its reply to these findings, read by the next round. */
  response: Schema.NullOr(Schema.String),
})
export type Critique = typeof Critique.Type

/** A review passes when nothing it found blocks. */
export const critiquePassed = (critique: Critique): boolean => critique.findings.every((f) => !f.blocks)

/** The review sent findings back and the agent has not answered them yet: they wait for (or are in) its next turn. */
export const findingsUnanswered = (critique: Critique | null): boolean =>
  critique !== null && critique.response === null && !critiquePassed(critique)

/** The last review passed, and on this head. */
export const passedAt = (critique: Critique | null, head: string | null): boolean =>
  critique !== null && head !== null && critique.sha === head && critiquePassed(critique)

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
  claudeSessionId: Schema.NullOr(Schema.String),
  model: Schema.String,
  effort: Schema.String,
  ciRounds: Schema.Number,
  costUsd: Schema.Number,
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

export const ActionKind = Schema.Literals([
  "investigate",
  "merge",
  "release",
  "rerun",
  "answer",
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

/** Where a reviewer finding starts to block: the defaults, and what settings saved before these existed decode to. */
export const FINDING_THRESHOLDS = { findingReal: 0.6, findingBlocking: 0.5, findingRebutted: 0.6 } as const

export const Thresholds = Schema.Struct({
  autoActionable: Schema.Number,
  autoResolvable: Schema.Number,
  autoHumanOnItMax: Schema.Number,
  suggestActionable: Schema.Number,
  suggestResolvable: Schema.Number,
  /** A reviewer finding blocks the PR only above these (and below `findingRebutted`). Added later, so defaulted. */
  findingReal: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(FINDING_THRESHOLDS.findingReal))),
  findingBlocking: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(FINDING_THRESHOLDS.findingBlocking))),
  findingRebutted: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(FINDING_THRESHOLDS.findingRebutted))),
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
  /** A different model reviews each pushed fix before the PR leaves draft. */
  adversarialReview: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** Watch prod signals in Grafana and suggest an investigation when one rises before any alert fires. */
  watchProd: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
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
  "critiquing",
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

/** Marks the review card a failed session gets; resolving it re-queues the same session. */
export const RETRY = "retry"

/**
 * Whether the card still stands: its session is at the stage the card was offered for. A merge card is for
 * `awaiting_merge`, a release card for `awaiting_release`, a re-run or a hand-off for `waiting`, a retry for
 * `failed`. Once the session moved on (finished, back at work, past the gate) the card is dead: it must not act,
 * and it goes (`SessionRepo` withdraws it with the write that moved the session; a gate the session comes back to
 * offers its card again). An answer lasts while its session is active (its `ask` decides). Cards without a session
 * and replies (still sendable after the session ended) always stand.
 */
export const cardStands = (action: Action, session: Session | undefined): boolean => {
  switch (action.kind) {
    case "merge":
      return session?.status === "awaiting_merge"
    case "release":
      return session?.status === "awaiting_release"
    case "rerun":
      return session?.status === "waiting"
    case "review":
      return session?.status === (action.payload === RETRY ? "failed" : "waiting")
    case "answer":
      return session !== undefined && isActive(session)
    case "investigate":
    case "escalate":
    case "reply":
      return true
  }
}

const CLOSING_KINDS: ReadonlyArray<ActionKind> = ["merge", "release", "review", "reply", "rerun"]

/** Dismissing this card leaves its session with nothing left to do, so the session is recorded as closed. A dead card closes nothing. */
export const dismissCloses = (action: Action, session: Session | undefined): boolean =>
  session !== undefined && isStranded(session) && CLOSING_KINDS.includes(action.kind) && cardStands(action, session)

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
