import type { Decision, Depth, JevVerdict, Thresholds } from "../domain/model.ts"

const pct = (value: number): string => `${Math.round(value * 100)}%`

/**
 * Thresholds turn Jev's independent judgments into one decision. `human_on_it`
 * only vetoes auto-start: a claimed alert can still be worth suggesting.
 */
export const decide = (jev: JevVerdict, t: Thresholds): { readonly decision: Decision; readonly reason: string } => {
  const scores = `actionable ${pct(jev.actionable)} · agent ${pct(jev.agentResolvable)}`
  if (jev.actionable >= t.autoActionable && jev.agentResolvable >= t.autoResolvable) {
    if (jev.humanOnIt < t.autoHumanOnItMax) return { decision: "auto", reason: `Agent-resolvable ${jev.kind} (${scores})` }
    return { decision: "suggest", reason: `A teammate seems to be on it (${pct(jev.humanOnIt)})` }
  }
  if (jev.actionable >= t.suggestActionable && jev.agentResolvable >= t.suggestResolvable) {
    return { decision: "suggest", reason: `Borderline ${jev.kind} (${scores})` }
  }
  if (jev.actionable < t.suggestActionable) return { decision: "ignore", reason: `Nothing to act on (${scores})` }
  return { decision: "ignore", reason: `Needs a person, not an agent (${scores})` }
}

/**
 * Inbox items have a third way out: escalation. Anything that asks something of
 * the user and is not clearly agent work lands in front of them; reviews always do,
 * since approving is theirs.
 */
export const decideInbox = (jev: JevVerdict, t: Thresholds): { readonly decision: Decision; readonly reason: string } => {
  const scores = `needs you ${pct(jev.actionable)} · agent ${pct(jev.agentResolvable)}`
  if (jev.humanOnIt >= 0.6) return { decision: "ignore", reason: `Already answered (${pct(jev.humanOnIt)})` }
  if (jev.actionable < t.suggestActionable) return { decision: "ignore", reason: `Nothing asked of you (${scores})` }
  if (jev.kind === "pr_review") return { decision: "escalate", reason: "Review request" }
  if (jev.actionable >= t.autoActionable && jev.agentResolvable >= t.autoResolvable) {
    return { decision: "auto", reason: `Delegated: ${jev.kind.replaceAll("_", " ")} (${scores})` }
  }
  if (jev.agentResolvable >= t.suggestResolvable) return { decision: "suggest", reason: `Could delegate (${scores})` }
  return { decision: "escalate", reason: `Needs you: ${jev.kind.replaceAll("_", " ")} (${scores})` }
}

export interface LaunchProfile {
  readonly model: string
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max"
}

/** Jev answers an abstract tier; only this table names models, so the API can never pick one. */
export const PROFILES: Readonly<Record<Depth, LaunchProfile>> = {
  quick: { model: "claude-sonnet-5-5", effort: "medium" },
  standard: { model: "claude-opus-5-5", effort: "high" },
  deep: { model: "claude-opus-5-5", effort: "max" },
}
