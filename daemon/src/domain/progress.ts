import { plural } from "../lib/text.ts"
import { critiquePassed, findingCounts, findingsUnanswered, REVIEWER_NAMES } from "./critique.ts"
import { isActive, type Session, SHIPPING_STATUSES, WORKING_STATUSES } from "./session.ts"

export type StepKey = "diagnose" | "fix" | "pr" | "critique" | "ci" | "deploy"
export type StepState = "done" | "current" | "pending" | "failed" | "skipped"
export type Tone = "live" | "waiting" | "success" | "neutral" | "failure"

export interface Step {
  readonly key: StepKey
  readonly label: string
  readonly state: StepState
}

export interface Progress {
  readonly steps: ReadonlyArray<Step>
  readonly headline: string
  readonly tone: Tone
  /** Who reviews the agent's fixes, and where the review stands ("Passed · 1 round of fixes · 2 dropped by Jev"). */
  readonly reviewerName: string
  readonly critiqueLine: string
}

const LABELS: Readonly<Record<StepKey, string>> = {
  diagnose: "Diagnose",
  fix: "Fix",
  pr: "PR",
  critique: "Review",
  ci: "CI",
  deploy: "Deploy",
}

/**
 * The stepper and status line, from evidence only. A step is done when its
 * milestone happened; the first step that did not happen is where the session
 * is (current) or where it stopped (failed); everything after is pending. A
 * closed or failed session therefore never shows more progress than it made.
 */
export const progressOf = (session: Session): Progress => {
  const m = session.milestones
  const noReleaseNeeded = session.status === "resolved" && m.merged && !m.released
  // Shipped on without an adversarial review: the setting was off, or the session predates it.
  // Skipped only when no review ever ran; a review sending the agent back is still the step in progress.
  const noReview = !m.critiqued && session.critique === null && session.status !== "critiquing" && (m.ciGreen || m.merged || SHIPPING_STATUSES.includes(session.status))
  const achieved: ReadonlyArray<readonly [StepKey, boolean]> = [
    ["diagnose", m.diagnosed || m.fixed || m.prOpened],
    ["fix", m.fixed || m.prOpened],
    ["pr", m.prOpened],
    ["critique", m.critiqued || noReview],
    ["ci", m.ciGreen || m.merged],
    ["deploy", m.deployed || noReleaseNeeded],
  ]
  const active = isActive(session)
  const frontier = achieved.findIndex(([, done]) => !done)
  const steps = achieved.map(([key, done], index): Step => {
    if (key === "deploy" && noReleaseNeeded) return { key, label: "No deploy", state: "skipped" }
    if (key === "critique" && noReview) return { key, label: "No review", state: "skipped" }
    if (done) return { key, label: key === "deploy" && m.deployed ? "Deployed" : LABELS[key], state: "done" }
    if (session.status === "resolved") return { key, label: LABELS[key], state: "skipped" }
    if (index !== frontier) return { key, label: LABELS[key], state: "pending" }
    if (active) return { key, label: LABELS[key], state: key === "diagnose" || WORKING_STATUSES.includes(session.status) ? "current" : "pending" }
    const label = key === "diagnose" && session.rootCauseFound === false ? "Root cause?" : key === "pr" ? "No PR" : LABELS[key]
    return { key, label, state: "failed" }
  })
  return { steps, ...headlineOf(session), reviewerName: reviewerNameOf(session), critiqueLine: critiqueLineOf(session, steps) }
}

const reviewerNameOf = (session: Session): string => REVIEWER_NAMES[session.critique?.reviewer ?? "codex"]

/** From the review step and the last review. The step stays current for the whole loop, so only `critiquing` is a review running now. */
const critiqueLineOf = (session: Session, steps: ReadonlyArray<Step>): string => {
  const critique = session.critique
  if (session.status === "critiquing" && !findingsUnanswered(critique)) return `Reviewing · round ${session.critiqueRounds + 1}`
  const { blocking, dropped } = critique === null ? { blocking: 0, dropped: 0 } : findingCounts(critique)
  const droppedPart = dropped > 0 ? [`${dropped} dropped by Jev`] : []
  switch (steps.find((step) => step.key === "critique")?.state) {
    case "done":
      return ["Passed", ...(session.critiqueRounds > 0 ? [plural(session.critiqueRounds, "round of fixes", "rounds of fixes")] : []), ...droppedPart].join(" · ")
    case "skipped":
      return "Not run"
    default: {
      if (critique === null || critiquePassed(critique)) return "Not run"
      const fixing = session.status === "running" ? ["agent fixing"] : session.status === "critiquing" ? ["waiting for an agent slot"] : []
      return [plural(blocking, "blocking finding", "blocking findings"), ...droppedPart, ...fixing].join(" · ")
    }
  }
}

const headlineOf = (session: Session): { readonly headline: string; readonly tone: Tone } => {
  const outcome = session.resolution
  switch (session.status) {
    case "queued":
      return { headline: "Queued", tone: "neutral" }
    case "preparing":
      return { headline: "Preparing worktree", tone: "live" }
    case "running":
      return { headline: "Agent working", tone: "live" }
    case "waiting":
      return {
        headline: session.rootCauseFound === false ? "Waiting on you · root cause not found" : "Waiting on you",
        tone: "waiting",
      }
    case "critiquing":
      // Findings recorded, the agent's turn parked until a slot frees up: nobody is reviewing.
      if (findingsUnanswered(session.critique)) return { headline: "Review findings wait for a free agent slot", tone: "neutral" }
      return { headline: `${reviewerNameOf(session)} reviewing · round ${session.critiqueRounds + 1}`, tone: "live" }
    case "ci":
      if (session.review === null) return { headline: "CI running", tone: "live" }
      if (!session.review.posted) return { headline: "CI green · review request not sent", tone: "waiting" }
      return { headline: `In review · #${session.review.channelName}`, tone: "live" }
    case "awaiting_merge":
      return { headline: "Ready to merge", tone: "waiting" }
    case "awaiting_release":
      return { headline: "Merged · ready to release", tone: "waiting" }
    case "deploying":
      return { headline: `Deploying ${session.releaseTag ?? ""}`.trim(), tone: "live" }
    case "resolved":
      return { headline: outcome === null ? "Resolved" : `Resolved · ${outcome}`, tone: "success" }
    case "closed":
      return { headline: `Closed · ${outcome ?? "not fixed"}`, tone: "neutral" }
    case "failed":
      return { headline: outcome === null ? "Failed" : `Failed · ${outcome}`, tone: "failure" }
    case "stopped":
      return { headline: "Stopped by you", tone: "neutral" }
  }
}

/** The alert history line for a session just started on it: "Agent session started (claude-opus-5-5, high)". */
export const sessionStartEvent = (session: Session): string => `Agent session started (${session.model}, ${session.effort})`

/** The alert history line for a session that just ended, e.g. "Agent session ended · Closed · root cause not found". */
export const sessionEndEvent = (session: Session): string => `Agent session ended · ${progressOf(session).headline}`

export const SESSION_RESUMED_EVENT = "Agent session resumed"
