import { Schema } from "effect"
import { AgentProvider, PROVIDER_NAMES } from "./models.ts"

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

export const ReviewerVendor = AgentProvider
export type ReviewerVendor = typeof ReviewerVendor.Type

/** How the reviewer is named in the transcript and status line. */
export const REVIEWER_NAMES: Readonly<Record<ReviewerVendor, string>> = PROVIDER_NAMES

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

/** Its findings that block, and those Jev dropped. */
export const findingCounts = (critique: Critique): { readonly blocking: number; readonly dropped: number } => {
  const blocking = critique.findings.filter((f) => f.blocks).length
  return { blocking, dropped: critique.findings.length - blocking }
}

/** The review sent findings back and the agent has not answered them yet: they wait for (or are in) its next turn. */
export const findingsUnanswered = (critique: Critique | null): boolean =>
  critique !== null && critique.response === null && !critiquePassed(critique)

/** The last review passed, and on this head. */
export const passedAt = (critique: Critique | null, head: string | null): boolean =>
  critique !== null && head !== null && critique.sha === head && critiquePassed(critique)
