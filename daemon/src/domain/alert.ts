import { Effect, Schema } from "effect"
import { nullByDefault } from "./schema.ts"

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

/** Where an alert came from, as written: `#channel`, "DM" or "group DM" for an inbox message outside a channel, "Grafana" for a watch finding. */
export const channelLabel = (alert: { readonly source: AlertSource; readonly channelName: string; readonly fields: AlertFields }): string => {
  if (alert.source === "watch") return WATCH_CHANNEL.name
  if (alert.fields._tag === "inbox" && alert.fields.channelKind !== "channel") return alert.fields.channelKind === "dm" ? "DM" : "group DM"
  return `#${alert.channelName}`
}

export const AlertFields = Schema.Union([ReleaseFields, UptimeFields, EngineFields, InboxFields, GenericFields, WatchFields])
export type AlertFields = typeof AlertFields.Type

/** `watch`: found by Bridgetown in Grafana, not posted in Slack. */
export const AlertSource = Schema.Literals(["releases", "uptime", "engine", "inbox", "generic", "watch"])
export type AlertSource = typeof AlertSource.Type

export const Decision = Schema.Literals(["filtered", "ignore", "suggest", "auto", "escalate"])
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
  /** What happened to this alert, oldest first: triage, your dismissals and investigations, edits. */
  events: Schema.Array(AlertEvent).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** What you last did to its card when no agent ran: dismissed it, or opened it in Slack or Revv. */
  disposition: nullByDefault(Disposition),
  /** Teammates on it per Slack, first claim first; never you. Read again whenever the message or its thread changes. */
  claimedBy: Schema.Array(Claimant).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})
export type Alert = typeof Alert.Type

/** The thread an alert (or an item about to be one) lives in: an inbox item's own thread, or the alert message itself. */
export const threadTsOf = (alert: Pick<Alert, "ts" | "fields">): string => (alert.fields._tag === "inbox" ? (alert.fields.threadTs ?? alert.ts) : alert.ts)

/** A Slack message read as an alert or an inbox item, before anything is stored or decided. */
export interface ParsedAlert {
  readonly id: string
  readonly channelId: string
  readonly channelName: string
  readonly ts: string
  readonly title: string
  readonly summary: string
  readonly raw: string
  readonly source: AlertSource
  readonly fingerprint: string
  readonly fields: AlertFields
  readonly mentionsMe: boolean
}

/** One message of a thread, for Jev, labelled by who wrote it. */
export interface ThreadReply {
  readonly author: "bot" | "me" | "teammate"
  readonly text: string
}

export interface AlertRecord {
  readonly permalink: string | null
  readonly receivedAt: string
  readonly triage: Triage
  readonly sessionId: string | null
  readonly events: ReadonlyArray<AlertEvent>
  readonly disposition?: Disposition | null
  readonly claimedBy?: ReadonlyArray<Claimant>
}

/** The stored alert for a parsed message. The one place a `ParsedAlert` becomes an `Alert`. */
export const alertFromParsed = (parsed: ParsedAlert, record: AlertRecord): Alert => ({
  id: parsed.id,
  channelId: parsed.channelId,
  channelName: parsed.channelName,
  ts: parsed.ts,
  permalink: record.permalink,
  title: parsed.title,
  summary: parsed.summary,
  raw: parsed.raw,
  source: parsed.source,
  fingerprint: parsed.fingerprint,
  fields: parsed.fields,
  mentionsMe: parsed.mentionsMe,
  receivedAt: record.receivedAt,
  triage: record.triage,
  sessionId: record.sessionId,
  events: record.events,
  disposition: record.disposition ?? null,
  claimedBy: record.claimedBy ?? [],
})
