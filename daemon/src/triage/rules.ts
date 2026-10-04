import { type Alert, type Claimant, claimHeadline, type Session } from "../domain/model.ts"
import type { ParsedAlert } from "../domain/alert.ts"
import { releaseState } from "../domain/release.ts"

export type RuleOutcome =
  | { readonly _tag: "Filtered"; readonly reason: string }
  | { readonly _tag: "Attach"; readonly sessionId: string; readonly reason: string }
  | { readonly _tag: "Judge" }

export interface RuleContext {
  /** Sessions still in flight, to dedupe on fingerprint. */
  readonly activeSessions: ReadonlyArray<Session>
  /** Earlier alerts sharing this fingerprint. */
  readonly sameFingerprint: ReadonlyArray<Alert>
  /** Teammates already on this alert, per Slack (`Claims`). */
  readonly claimedBy: ReadonlyArray<Claimant>
}

const filtered = (reason: string): RuleOutcome => ({ _tag: "Filtered", reason })

/**
 * Decisions that need no judgment: success notices, recoveries, pipelines that
 * are still moving, repeats of something a session already owns, and alerts a
 * teammate is on. Everything else goes to Jev.
 */
export const applyRules = (alert: ParsedAlert, ctx: RuleContext): RuleOutcome => {
  if (alert.fromHuman) return filtered("Posted by a person, not an alert")

  const owner = ctx.activeSessions.find((session) =>
    ctx.sameFingerprint.some((earlier) => earlier.sessionId === session.id),
  )
  if (owner !== undefined) {
    return { _tag: "Attach", sessionId: owner.id, reason: "Same alert as a running session" }
  }

  const claimed = claimHeadline(ctx.claimedBy)
  if (claimed !== null) return filtered(claimed)

  const fields = alert.fields
  switch (fields._tag) {
    case "release": {
      switch (releaseState(fields.stages)._tag) {
        case "Failed":
          return { _tag: "Judge" }
        case "Deployed":
          return filtered("Release deployed successfully")
        case "AwaitingApproval":
          return filtered("Waiting for approval")
        case "InProgress":
        case "Starting":
          return filtered("Release in progress")
      }
    }
    case "generic":
    case "engine": {
      const head = alert.title
      if (/\[RESOLVED\]|^:white_check_mark:|^:large_green_circle:|^\**resolved\**$|\b(run finished|has ended|recovered)\b/i.test(head.trim())) {
        return filtered("Recovery or success notice")
      }
      return { _tag: "Judge" }
    }
    case "inbox":
    case "watch":
      return { _tag: "Judge" }
    case "uptime": {
      if (fields.state === "resolved" || fields.state === "recovered") return filtered("Recovery notice")
      return { _tag: "Judge" }
    }
  }
}
