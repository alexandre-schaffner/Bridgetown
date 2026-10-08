import { describe, expect, test } from "bun:test"
import { acceptsMessages, closedResolution, NO_MILESTONES, type Session, type SessionStatus, shipStatus } from "../../src/domain/session.ts"
import { makeSession } from "../support/records.ts"

const session = (status: SessionStatus, overrides: Partial<Session> = {}): Session =>
  makeSession(status, { prUrl: "https://ghe/pull/1", agentSessionId: "c", ...overrides })

describe("contract rules", () => {
  test("acceptsMessages: live or handed back with a worktree and an agent session", () => {
    expect(acceptsMessages(session("running", { agentSessionId: null }))).toBe(true)
    expect(acceptsMessages(session("waiting"))).toBe(true)
    expect(acceptsMessages(session("ci"))).toBe(true)
    expect(acceptsMessages(session("failed"))).toBe(true)
    expect(acceptsMessages(session("closed"))).toBe(true)
    expect(acceptsMessages(session("queued"))).toBe(false)
    expect(acceptsMessages(session("preparing"))).toBe(false)
    expect(acceptsMessages(session("resolved"))).toBe(false)
    expect(acceptsMessages(session("waiting", { worktree: null }))).toBe(false)
    expect(acceptsMessages(session("failed", { agentSessionId: null }))).toBe(false)
  })
  test("closing without a fix says how far it got, never 'resolved'", () => {
    expect(closedResolution(session("failed"))).toBe("agent failed")
    expect(closedResolution(session("waiting", { rootCauseFound: false }))).toBe("root cause not found")
    expect(closedResolution(session("waiting", { outcome: "recommendation" }))).toBe("recommendation handed to you")
    expect(closedResolution(session("awaiting_release", { milestones: { ...NO_MILESTONES, merged: true } }))).toBe("merged, not released")
    expect(closedResolution(session("awaiting_merge", { milestones: { ...NO_MILESTONES, prOpened: true } }))).toBe("PR open, not merged")
    expect(closedResolution(session("waiting"))).toBe("not fixed")
  })
})

describe("shipStatus", () => {
  test("where a shipping session goes back to", () => {
    expect(shipStatus(makeSession("running"))).toBeUndefined()
    expect(shipStatus(makeSession("running", { prUrl: "u" }))).toBe("ci")
    expect(shipStatus(makeSession("running", { prUrl: "u", releasePrefix: "admin", milestones: { ...NO_MILESTONES, merged: true } }))).toBe("awaiting_release")
    expect(shipStatus(makeSession("running", { prUrl: "u", milestones: { ...NO_MILESTONES, merged: true, released: true } }))).toBe("deploying")
  })
})
