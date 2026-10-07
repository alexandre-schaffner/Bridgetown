import type { Alert, Depth } from "../domain/alert.ts"
import { now } from "../domain/ids.ts"
import { type Effort, NO_MILESTONES, type Session } from "../domain/session.ts"
import { AUTOMATIC, type ModelSelection, type AgentProvider } from "../domain/models.ts"
import { slug } from "./worktree.ts"

export interface LaunchProfile {
  readonly model: string
  readonly effort: Effort
}

/** Automatic monitoring maps Jev's abstract depth to the existing launch profiles. */
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

/** Snapshot the model choice at enqueue so retries and follow-ups retain it. */
export const newSession = (alert: Alert, id: string, repoPath: string, selection: ModelSelection = AUTOMATIC): Session => {
  const profile: { provider: AgentProvider; model: string; effort: string | null } = selection.mode === "automatic" ? { provider: "claude", ...PROFILES[alert.triage.jev?.depth ?? "standard"] } : selection
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
    agentSessionId: null,
    agentConfigDir: null,
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort,
    ciRounds: 0,
    costUsd: profile.provider === "claude" ? 0 : null,
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
    reviewProfile: null,
    mergeRequestedAt: null,
    releaseTag: null,
    deployStage: null,
    tracker: null,
    sentBack: null,
    startedAt: now(),
    updatedAt: now(),
  }
}
