import { isActive, type Session } from "./model.ts"

export type StepKey = "diagnose" | "fix" | "pr" | "ci" | "deploy"
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
}

const LABELS: Readonly<Record<StepKey, string>> = {
  diagnose: "Diagnose",
  fix: "Fix",
  pr: "PR",
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
  const achieved: ReadonlyArray<readonly [StepKey, boolean]> = [
    ["diagnose", m.diagnosed || m.fixed || m.prOpened],
    ["fix", m.fixed || m.prOpened],
    ["pr", m.prOpened],
    ["ci", m.ciGreen || m.merged],
    ["deploy", m.deployed || noReleaseNeeded],
  ]
  const active = isActive(session)
  const frontier = achieved.findIndex(([, done]) => !done)
  const steps = achieved.map(([key, done], index): Step => {
    if (key === "deploy" && noReleaseNeeded) return { key, label: "No deploy", state: "skipped" }
    if (done) return { key, label: key === "deploy" && m.deployed ? "Deployed" : LABELS[key], state: "done" }
    if (session.status === "resolved") return { key, label: LABELS[key], state: "skipped" }
    if (index !== frontier) return { key, label: LABELS[key], state: "pending" }
    if (active) return { key, label: LABELS[key], state: key === "diagnose" || session.status === "running" || session.status === "ci" || session.status === "deploying" || session.status === "preparing" ? "current" : "pending" }
    const label = key === "diagnose" && session.rootCauseFound === false ? "Root cause?" : key === "pr" ? "No PR" : LABELS[key]
    return { key, label, state: "failed" }
  })
  return { steps, ...headlineOf(session) }
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
    case "ci":
      if (session.review === null) return { headline: "CI running", tone: "live" }
      if (!session.review.posted) return { headline: "CI green · review request not sent", tone: "waiting" }
      return { headline: `In review · #${session.review.channelName}`, tone: "live" }
    case "awaiting_merge":
      return { headline: "Ready to merge", tone: "waiting" }
    case "awaiting_release":
      return { headline: "Merged · ready to release", tone: "waiting" }
    case "deploying":
      return { headline: `Deploying ${session.release?.tag ?? ""}`.trim(), tone: "live" }
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
