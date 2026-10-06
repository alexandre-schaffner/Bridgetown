import { type Alert, claimHeadline } from "./alert.ts"
import { progressOf, type Tone } from "./progress.ts"
import type { Session } from "./session.ts"

export type OutcomeKind = "pending" | "filtered" | "ignored" | "suggested" | "escalated" | "waiting" | "dismissed" | "opened" | "withdrawn" | "teammate" | "session"

export interface AlertOutcome {
  readonly kind: OutcomeKind
  readonly headline: string
  /** One longer line for the detail view; `null` when the headline says it all. */
  readonly sentence: string | null
  readonly tone: Tone
}

const outcome = (kind: OutcomeKind, headline: string, sentence: string | null, tone: Tone = "neutral"): AlertOutcome => ({
  kind,
  headline,
  sentence,
  tone,
})

/** Everyone on it, and the latest their Bridgetown said in the thread. */
const teammateSentence = (alert: Alert): string => {
  const who = alert.claimedBy.map((c) => (c.via === "agent" ? `${c.name} (Bridgetown)` : `${c.name} (👀)`)).join(", ")
  const latest = alert.claimedBy.find((c) => c.latest !== null)
  const base = `No agent of yours ran. In Slack: ${who}.`
  return latest === undefined ? base : `${base} Latest from ${latest.name}'s agent: ${latest.latest}`
}

/**
 * What happened to an alert, in one honest phrase. A session that owns it wins
 * whatever its status: its headline and tone are the truth, and a running one
 * never reads "Ignored". Without one: a teammate on it per Slack (they own it
 * now, whatever Jev thought), then an open card, then what you did to the
 * last card (stored as data, never read back from history text), then the triage
 * decision. Only a session the daemon verified is ever green.
 */
export const alertOutcome = (alert: Alert, session: Session | undefined, openCards: number): AlertOutcome => {
  if (session !== undefined) {
    const { headline, tone } = progressOf(session)
    return outcome("session", headline, null, tone)
  }
  const claimed = claimHeadline(alert.claimedBy)
  if (claimed !== null) return outcome("teammate", claimed, teammateSentence(alert), "neutral")
  const decision = alert.triage.decision
  switch (decision) {
    case "pending":
      return outcome("pending", "Waiting for triage", "Jev hasn't triaged it yet.")
    case "filtered":
      return outcome("filtered", "Filtered by a rule", "No agent ran. A rule filtered it before triage.")
    case "ignore":
      return outcome("ignored", "Ignored by Jev", "No agent ran. Jev ignored it.")
    case "suggest":
    case "escalate":
    case "auto": {
      const personal = decision === "escalate"
      if (openCards > 0) {
        return outcome(
          "waiting",
          "Waiting on you",
          personal ? "Jev sent it to you personally. It's in Needs you." : "No agent has run. Jev suggested one, and it's waiting in Needs you.",
          "waiting",
        )
      }
      if (alert.disposition?.kind === "opened") {
        return outcome("opened", "Opened by you", "No agent ran. Jev sent it to you, and you opened it.")
      }
      if (alert.disposition?.kind === "dismissed") {
        return outcome(
          "dismissed",
          "Dismissed by you",
          personal ? "No agent ran. Jev sent it to you, and you dismissed it." : "No agent ran. Jev suggested one, and you dismissed it.",
        )
      }
      if (alert.disposition?.kind === "withdrawn") {
        return outcome("withdrawn", "Back to normal", "No agent ran. The signal went back to its usual level, so its suggestion was withdrawn.")
      }
      if (decision === "auto") return outcome("suggested", "Handed to an agent", "Jev handed it to an agent, but no session has started.")
      return personal
        ? outcome("escalated", "Escalated to you", "No agent ran. Jev sent it to you personally.")
        : outcome("suggested", "Suggested to you", "No agent ran. Jev suggested one.")
    }
  }
}
