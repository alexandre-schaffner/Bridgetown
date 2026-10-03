import { type Alert, NO_MILESTONES, type Session, type SessionStatus } from "../../src/domain/model.ts"

/** A session with every field set to something plausible; tests override what they are about. */
export const makeSession = (status: SessionStatus, overrides: Partial<Session> = {}): Session => ({
  id: "s", alertId: "C1:1", title: "t", channelName: "alert-releases", status, phase: "diagnose", activity: "",
  diagnosis: null, outcome: null, recommendation: null, prUrl: null, branch: "b", worktree: "/w", repoPath: "/r",
  claudeSessionId: null, model: "m", effort: "high", ciRounds: 0, costUsd: 0, slackThreadUrl: null, release: null,
  milestones: NO_MILESTONES, rootCauseFound: null, resolution: null, pushbacks: 0, component: null, review: null,
  mergeRequestedAt: null, releaseTag: null, deployStage: null, startedAt: "", updatedAt: "", ...overrides,
})

export const makeAlert = (overrides: Partial<Alert> = {}): Alert => ({
  id: "C1:1", channelId: "C1", channelName: "alert-releases", ts: "1", permalink: null, title: "t", summary: "", raw: "",
  source: "releases", fingerprint: "f", fields: { _tag: "generic" }, mentionsMe: false, receivedAt: "",
  triage: { decision: "auto", reason: "because", jev: null }, sessionId: null, feedback: null, events: [], disposition: null,
  ...overrides,
})
