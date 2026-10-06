import { describe, expect, test } from "bun:test"
import type { Action } from "../src/domain/action.ts"
import type { SessionStatus } from "../src/domain/session.ts"
import { planPrune, type PruneRefs, ROWS_MS, worktreeDue } from "../src/housekeeping/retention.ts"
import type { AlertRef, SessionRef } from "../src/store/store.ts"

const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const HOUR = 60 * 60_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const OLD = ago(ROWS_MS + HOUR)
const RECENT = ago(HOUR)

const alert = (id: string, receivedAt: string, sessionId: string | null = null): AlertRef => ({ id, receivedAt, sessionId })
const session = (id: string, alertId: string, status: SessionStatus, updatedAt: string): SessionRef => ({
  id, alertId, status, updatedAt, branch: `fix-bt-${id}`, worktree: null, repoPath: "/r",
})
const card = (id: string, createdAt: string, ids: { readonly sessionId?: string; readonly alertId?: string } = {}): Action => ({
  id, kind: "review", title: "", detail: "", primaryLabel: "", options: [], sessionId: ids.sessionId ?? null, alertId: ids.alertId ?? null,
  fingerprint: null, retry: false, url: null, createdAt,
})

/** Enough newer rows that the snapshot's floors (30 alerts, 20 finished sessions) never keep the ones under test. */
const filler = (): PruneRefs => {
  const sessions = Array.from({ length: 20 }, (_, i) => session(`s_new${i}`, `a_new${i}`, "closed", RECENT))
  const alerts = Array.from({ length: 30 }, (_, i) => alert(`a_new${i}`, RECENT, i < 20 ? `s_new${i}` : null))
  return { alerts, sessions, actions: [] }
}

const plan = (extra: Partial<PruneRefs>) => {
  const base = filler()
  const out = planPrune(
    { alerts: [...base.alerts, ...(extra.alerts ?? [])], sessions: [...base.sessions, ...(extra.sessions ?? [])], actions: extra.actions ?? [] },
    NOW,
  )
  return { sessions: out.sessions.map((s) => s.id).sort(), alerts: [...out.alertIds].sort(), cards: [...out.actionIds].sort() }
}

describe("planPrune", () => {
  test("a month-old finished session goes with its alert", () => {
    expect(plan({ alerts: [alert("a1", OLD, "s1")], sessions: [session("s1", "a1", "resolved", OLD)] })).toEqual({ sessions: ["s1"], alerts: ["a1"], cards: [] })
  })

  test("an active session keeps its alert, and an alert attached to it, however old", () => {
    expect(
      plan({ alerts: [alert("a1", OLD, "s1"), alert("a2", OLD, "s1")], sessions: [session("s1", "a1", "deploying", OLD)] }),
    ).toEqual({ sessions: [], alerts: [], cards: [] })
  })

  test("a session stays while a newer alert attached to it does, and so does its own alert", () => {
    expect(
      plan({ alerts: [alert("a1", OLD, "s1"), alert("a2", RECENT, "s1")], sessions: [session("s1", "a1", "closed", OLD)] }),
    ).toEqual({ sessions: [], alerts: [], cards: [] })
  })

  test("an old alert stays while a newer session it started does", () => {
    expect(
      plan({ alerts: [alert("a1", OLD, "s2")], sessions: [session("s1", "a1", "failed", OLD), session("s2", "a1", "closed", RECENT)] }),
    ).toEqual({ sessions: [], alerts: [], cards: [] })
  })

  test("what a card names survives, even a card expiring now; a month-old card of a finished or missing session expires", () => {
    const alerts = [alert("a1", OLD, "s1"), alert("a2", OLD), alert("a3", OLD)]
    const sessions = [session("s1", "a1", "failed", OLD), session("s2", "a3", "waiting", OLD)]
    const live = [card("c_recent", RECENT, { alertId: "a2" }), card("c_live", OLD, { sessionId: "s2", alertId: "a3" })]
    const retry = card("c_retry", OLD, { sessionId: "s1", alertId: "a1" })
    // Its Retry still works until the card is gone, so the session waits for the next round.
    expect(plan({ alerts, sessions, actions: [...live, retry, card("c_gone", OLD, { sessionId: "s_gone" })] })).toEqual({
      sessions: [],
      alerts: [],
      cards: ["c_gone", "c_retry"],
    })
    expect(plan({ alerts, sessions, actions: live })).toEqual({ sessions: ["s1"], alerts: ["a1"], cards: [] })
  })

  test("a session that still records its worktree waits until housekeeping reclaims it, since your message could reopen it", () => {
    const kept = { ...session("s1", "a1", "closed", OLD), worktree: "/w" }
    expect(plan({ alerts: [alert("a1", OLD, "s1")], sessions: [kept] })).toEqual({ sessions: [], alerts: [], cards: [] })
  })

  test("the newest 30 alerts and 20 finished sessions stay past a month", () => {
    const alerts = Array.from({ length: 31 }, (_, i) => alert(`a${i}`, ago(ROWS_MS + (i + 1) * HOUR)))
    const sessions = Array.from({ length: 21 }, (_, i) => session(`s${i}`, `a_missing${i}`, "closed", ago(ROWS_MS + (i + 1) * HOUR)))
    const out = planPrune({ alerts, sessions, actions: [] }, NOW)
    expect(out.alertIds).toEqual(["a30"])
    expect(out.sessions.map((s) => s.id)).toEqual(["s20"])
  })

  test("nothing younger than a month is planned", () => {
    const fresh = ago(ROWS_MS - HOUR)
    expect(plan({ alerts: [alert("a1", fresh, "s1")], sessions: [session("s1", "a1", "resolved", fresh)] })).toEqual({ sessions: [], alerts: [], cards: [] })
  })
})

describe("worktreeDue", () => {
  const due = (status: SessionStatus, ageMs: number, worktree: string | null = "/w") => worktreeDue({ status, updatedAt: ago(ageMs), worktree }, NOW)

  test("resolved at once; closed, stopped and failed after a day; never while active", () => {
    expect(due("resolved", 0)).toBe(true)
    for (const status of ["closed", "stopped", "failed"] as const) {
      expect(due(status, 23 * HOUR)).toBe(false)
      expect(due(status, 25 * HOUR)).toBe(true)
    }
    expect(due("waiting", 90 * 24 * HOUR)).toBe(false)
  })

  test("a session that never recorded its worktree: due at once unless Retry can still use it", () => {
    expect(due("stopped", 0, null)).toBe(true)
    expect(due("closed", 0, null)).toBe(true)
    expect(due("failed", 23 * HOUR, null)).toBe(false)
    expect(due("failed", 25 * HOUR, null)).toBe(true)
    expect(due("preparing", 0, null)).toBe(false)
  })
})
