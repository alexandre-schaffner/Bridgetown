import type { Alert } from "../../src/domain/alert.ts"
import type { Finding } from "../../src/domain/critique.ts"
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

/** A blocking reviewer finding Jev has not judged: pending rewards that overflow through `Number()`. */
export const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  file: "packages/api/src/services/reward.ts", line: 88, title: "pending rewards still go through Number()",
  failureScenario: "a 2^60 wei pending amount overflows and /v4/rewards 502s", jev: null, blocks: true, ...overrides,
})
