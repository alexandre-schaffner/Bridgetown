import type { Holder, SessionView, Step, StepKey, StepState, Tone } from "../api/wire.ts"
import { plural } from "../lib/text.ts"
import { prNumber } from "../ship/pr.ts"
import { critiquePassed, findingCounts, findingsUnanswered, REVIEWER_NAMES } from "./critique.ts"
import { isActive, type Session, SHIPPING_STATUSES, WORKING_STATUSES } from "./session.ts"

/** A session as the app draws it (wire.ts `SessionView`): its steps, status line, who has its next move, and its review and CI rows. */
export type Progress = Pick<SessionView, "steps" | "headline" | "tone" | "holder" | "reviewerName" | "critiqueLine" | "ciLine">

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
  const stepAt = (key: StepKey, done: boolean, index: number): Omit<Step, "detail"> => {
    if (key === "deploy" && noReleaseNeeded) return { key, label: "No deploy", state: "skipped" }
    if (key === "critique" && noReview) return { key, label: "No review", state: "skipped" }
    if (done) return { key, label: key === "deploy" && m.deployed ? "Deployed" : LABELS[key], state: "done" }
    if (session.status === "resolved") return { key, label: LABELS[key], state: "skipped" }
    if (index !== frontier) return { key, label: LABELS[key], state: "pending" }
    if (active) return { key, label: LABELS[key], state: key === "diagnose" || WORKING_STATUSES.includes(session.status) ? "current" : "pending" }
    const label = key === "diagnose" && session.rootCauseFound === false ? "Root cause?" : key === "pr" ? "No PR" : LABELS[key]
    return { key, label, state: "failed" }
  }
  const shape = achieved.map(([key, done], index) => stepAt(key, done, index))
  const critiqueLine = critiqueLineOf(session, stateOf(shape, "critique"))
  const ciLine = ciLineOf(session, stateOf(shape, "ci"))
  const steps = shape.map((step): Step => ({ ...step, detail: detailOf(session, step.key, step.state, critiqueLine, ciLine) }))
  return { steps, ...headlineOf(session), holder: holderOf(session), reviewerName: reviewerNameOf(session), critiqueLine, ciLine }
}

const stateOf = (steps: ReadonlyArray<Omit<Step, "detail">>, key: StepKey): StepState | undefined => steps.find((step) => step.key === key)?.state

/** What there is to show for a step under its name: only what there is evidence for, and nothing for a step not reached. */
const detailOf = (session: Session, key: StepKey, state: StepState, critiqueLine: string, ciLine: string): string | null => {
  if (state === "pending") return null
  switch (key) {
    case "diagnose":
      return session.rootCauseFound === null ? null : session.rootCauseFound ? "Cause found" : "No root cause"
    case "pr": {
      const number = session.prUrl === null ? null : prNumber(session.prUrl)
      return number === null ? null : `#${number}`
    }
    case "critique":
      return critiqueLine
    case "ci":
      return session.ciRounds > 0 || state === "current" ? ciLine : null
    case "fix":
    case "deploy":
      return null
  }
}

/** Who an active session waits on; `null` once it has ended. The tone can't tell: "In review" is live, yet no agent works on it. */
const holderOf = (session: Session): Holder | null => {
  switch (session.status) {
    case "preparing":
    case "running":
      return "agent"
    case "critiquing":
      // Findings recorded and the agent's turn parked for a free slot: nobody is reviewing.
      return findingsUnanswered(session.critique) ? "queue" : "critic"
    case "waiting":
    case "awaiting_merge":
    case "awaiting_release":
      return "you"
    case "ci":
      // CI green but the review request didn't go out: that is yours to sort out.
      if (session.review === null) return "ci"
      return session.review.posted ? "reviewers" : "you"
    case "deploying":
      return "deploy"
    case "queued":
      return "queue"
    case "resolved":
    case "closed":
    case "failed":
    case "stopped":
      return null
  }
}

/** The CI row, from the CI step and how many rounds CI ran: "Passed · 1 round", "Running", "Not needed", "Not run". */
const ciLineOf = (session: Session, state: StepState | undefined): string => {
  const rounds = session.ciRounds
  const word =
    state === "done" ? "Passed"
    : state === "current" ? "Running"
    : state === "failed" ? "Failed"
    : state === "skipped" ? "Not needed"
    : rounds > 0 ? "Not passed"
    : "Not run"
  return rounds > 0 ? `${word} · ${plural(rounds, "round", "rounds")}` : word
}

const reviewerNameOf = (session: Session): string => REVIEWER_NAMES[session.critique?.reviewer ?? "codex"]

/** From the review step and the last review. The step stays current for the whole loop, so only `critiquing` is a review running now. */
const critiqueLineOf = (session: Session, state: StepState | undefined): string => {
  const critique = session.critique
  if (session.status === "critiquing" && !findingsUnanswered(critique)) return `Reviewing · round ${session.critiqueRounds + 1}`
  const { blocking, dropped } = critique === null ? { blocking: 0, dropped: 0 } : findingCounts(critique)
  const droppedPart = dropped > 0 ? [`${dropped} dropped by Jev`] : []
  switch (state) {
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
