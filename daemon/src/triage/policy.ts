import type { Decision, Depth, FindingVerdict, JevVerdict, ReviewerVendor, Thresholds } from "../domain/model.ts"

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

/**
 * A reviewer finding goes back to the agent only when Jev judges it a real
 * defect that would block the PR and the agent's earlier reply does not already
 * answer it. Everything else (style, speculation, settled arguments) is dropped.
 */
export const decideFinding = (jev: FindingVerdict, t: Thresholds): { readonly blocks: boolean; readonly reason: string } => {
  const scores = `real ${pct(jev.realDefect)} · blocking ${pct(jev.blocking)}${jev.rebutted === null ? "" : ` · rebutted ${pct(jev.rebutted)}`}`
  if (jev.realDefect < t.findingReal) return { blocks: false, reason: `Not a real defect (${scores})` }
  if (jev.blocking < t.findingBlocking) return { blocks: false, reason: `Not worth blocking on (${scores})` }
  if (jev.rebutted !== null && jev.rebutted >= t.findingRebutted) return { blocks: false, reason: `Answered by the agent (${scores})` }
  return { blocks: true, reason: `Blocking (${scores})` }
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

export interface ReviewerProfile {
  readonly vendor: ReviewerVendor
  readonly model: string
  readonly effort: "low" | "medium" | "high" | "xhigh"
}

/**
 * The adversarial reviewer per triage depth, like `PROFILES` for the coder. Never the coder's vendor (every
 * profile above is Claude): a different model has different blind spots.
 */
export const REVIEWERS: Readonly<Record<Depth, ReviewerProfile>> = {
  quick: { vendor: "codex", model: "gpt-5.6-sol", effort: "medium" },
  standard: { vendor: "codex", model: "gpt-5.6-sol", effort: "high" },
  deep: { vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
}

export const reviewerFor = (depth: Depth): ReviewerProfile => REVIEWERS[depth]
