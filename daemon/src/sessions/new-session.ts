import type { Alert, Depth } from "../domain/alert.ts"
import { now } from "../domain/ids.ts"
import { type Effort, NO_MILESTONES, type Session } from "../domain/session.ts"
import { slug } from "./worktree.ts"

export interface LaunchProfile {
  readonly model: string
  readonly effort: Effort
}

/** Jev answers an abstract tier; only this table names models, so the API can never pick one. */
export const PROFILES: Readonly<Record<Depth, LaunchProfile>> = {
  quick: { model: "claude-sonnet-5-5", effort: "medium" },
  standard: { model: "claude-opus-5-5", effort: "high" },
  deep: { model: "claude-opus-5-5", effort: "max" },
}

/** `fix-bt-<what>-<id tail>`: the only branch the session's guard lets it push. */
export const branchFor = (alert: Alert, id: string): string => {
  const base = alert.fields._tag === "release" ? `${alert.fields.image}-${alert.fields.version}` : alert.title
  return `fix-bt-${slug(base)}-${id.slice(-4)}`
}

/** A queued session for the alert. Jev's depth picks the model and effort; nothing has happened yet. */
export const newSession = (alert: Alert, id: string, repoPath: string): Session => {
  const profile = PROFILES[alert.triage.jev?.depth ?? "standard"]
  return {
    id,
    alertId: alert.id,
    title: alert.title,
    channelName: alert.channelName,
    status: "queued",
    phase: "diagnose",
    activity: "Queued",
    diagnosis: null,
    outcome: null,
    recommendation: null,
    prUrl: null,
    branch: branchFor(alert, id),
    worktree: null,
    repoPath,
    claudeSessionId: null,
    model: profile.model,
    effort: profile.effort,
    ciRounds: 0,
    costUsd: 0,
    // A watch finding's permalink is its Grafana dashboard: there is no Slack thread.
    slackThreadUrl: alert.source === "watch" ? null : alert.permalink,
    milestones: NO_MILESTONES,
    rootCauseFound: null,
    resolution: null,
    pushbacks: 0,
    releasePrefix: null,
    review: null,
    critiqueRounds: 0,
    critique: null,
    mergeRequestedAt: null,
    releaseTag: null,
    deployStage: null,
    tracker: null,
    sentBack: null,
    startedAt: now(),
    updatedAt: now(),
  }
}
