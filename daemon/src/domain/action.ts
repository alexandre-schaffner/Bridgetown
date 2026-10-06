import { Schema } from "effect"
import { nullByDefault } from "./schema.ts"
import { isActive, isStranded, type Session } from "./session.ts"

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
  /** An investigate or escalate card's alert fingerprint: one card per problem, the newest alert's. */
  fingerprint: Schema.NullOr(Schema.String),
  /** A review card whose button retries its failed session, rather than closing it. */
  retry: Schema.Boolean,
  /** Opened by the app when the primary button is pressed (Slack permalink, revv:// link). */
  url: nullByDefault(Schema.String),
  createdAt: Schema.String,
})
export type Action = typeof Action.Type

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
      return session?.status === (action.retry ? "failed" : "waiting")
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
