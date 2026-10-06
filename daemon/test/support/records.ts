import type { Alert } from "../../src/domain/alert.ts"
import type { Session, SessionStatus } from "../../src/domain/session.ts"
import { newSession } from "../../src/sessions/new-session.ts"

export const makeAlert = (overrides: Partial<Alert> = {}): Alert => ({
  id: "C1:1", channelId: "C1", channelName: "alert-releases", ts: "1", permalink: null, title: "t", summary: "", raw: "",
  source: "releases", fingerprint: "f", fields: { _tag: "generic" }, mentionsMe: false, receivedAt: "",
  triage: { decision: "auto", reason: "because", jev: null }, sessionId: null, feedback: null, events: [], disposition: null,
  claimedBy: [], ...overrides,
})

/** `makeAlert()`'s session as the daemon creates it, moved to `status` with a worktree and no clock; tests override what they are about. */
export const makeSession = (status: SessionStatus, overrides: Partial<Session> = {}): Session => ({
  ...newSession(makeAlert(), "s", "/r"),
  status, worktree: "/w", startedAt: "", updatedAt: "", ...overrides,
})
