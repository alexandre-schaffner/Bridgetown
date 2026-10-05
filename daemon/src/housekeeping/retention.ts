import { SNAPSHOT_ALERTS, SNAPSHOT_FINISHED_SESSIONS } from "../api/views.ts"
import { type Action, ACTIVE_STATUSES, type SessionStatus } from "../domain/model.ts"
import type { AlertRef, SessionRef } from "../store/store.ts"

const DAY = 24 * 60 * 60_000

/**
 * How long rows are kept: alerts, finished sessions with their transcripts, and cards no live
 * session needs. Nothing reads further back than a week (an alert's fingerprint history, the watch
 * cooldown, Jev's judged patterns, the day of metrics), and the snapshot's newest alerts and
 * finished sessions are kept however old, so the app never empties after a quiet month.
 */
export const ROWS_MS = 30 * DAY

/**
 * How long a finished session keeps its worktree. Nothing resumes a resolved session; within a day
 * your message reopens a closed or stopped one, and Retry is one click on a failed one (which also
 * keeps its branch until its row goes, since Retry rebuilds the worktree from it).
 */
const WORKTREE_GRACE_MS: Readonly<Partial<Record<SessionStatus, number>>> = { resolved: 0, closed: DAY, stopped: DAY, failed: DAY }

const isActiveStatus = (status: SessionStatus): boolean => ACTIVE_STATUSES.includes(status)

/**
 * Whether a session's worktree may go: it is finished and past its grace, or nothing can use it any
 * more. Your message only reopens a session that recorded its worktree, but Retry rebuilds a failed
 * one in place, so what setup left of a session stopped while preparing goes at once, and what it
 * left of one that failed there (a restart mid-setup) waits out the grace like any failed session's.
 */
export const worktreeDue = (session: Pick<SessionRef, "status" | "updatedAt" | "worktree">, nowMs: number): boolean => {
  const grace = WORKTREE_GRACE_MS[session.status]
  if (grace === undefined) return false
  const usable = session.worktree !== null || session.status === "failed"
  return !usable || nowMs - Date.parse(session.updatedAt) >= grace
}

export interface PruneRefs {
  readonly alerts: ReadonlyArray<AlertRef>
  readonly sessions: ReadonlyArray<SessionRef>
  readonly actions: ReadonlyArray<Action>
}

export interface PrunePlan {
  readonly actionIds: ReadonlyArray<string>
  /** Whole refs: what a session left outside the database (its branch, its conversation) goes with it. */
  readonly sessions: ReadonlyArray<SessionRef>
  readonly alertIds: ReadonlyArray<string>
}

const newest = <A>(rows: ReadonlyArray<A>, at: (row: A) => string, count: number): ReadonlySet<A> =>
  new Set([...rows].sort((a, b) => at(b).localeCompare(at(a))).slice(0, count))

const groupBy = <A>(rows: ReadonlyArray<A>, key: (row: A) => string | null): ReadonlyMap<string, ReadonlyArray<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const row of rows) {
    const k = key(row)
    if (k === null) continue
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [row])
    else group.push(row)
  }
  return groups
}

/**
 * The rows to delete, pure. Cards older than `ROWS_MS` whose session is finished or gone expire.
 * Then finished sessions and alerts older than that, past the snapshot's newest, and that no card
 * names, are candidates; the two sets shrink together until nothing kept points at a deleted row:
 * a session goes only with its alert and every alert attached to it, an alert only with every
 * session it started and the session it was attached to. So an active session keeps its alerts
 * however old, and no alert outlives its session to read "Filtered by a rule".
 *
 * A session goes only once nothing can bring it back while its branch and conversation are deleted:
 * no card names it, not even one expiring now (a Retry is one click until the card is gone), and its
 * worktree was reclaimed (so no message reopens it). Either way it goes a round later.
 */
export const planPrune = ({ alerts, sessions, actions }: PruneRefs, nowMs: number): PrunePlan => {
  const cutoff = new Date(nowMs - ROWS_MS).toISOString()
  const sessionById = new Map(sessions.map((s) => [s.id, s]))
  const alertIds = new Set(alerts.map((a) => a.id))
  const sessionsOf = groupBy(sessions, (s) => s.alertId)
  const attachedTo = groupBy(alerts, (a) => a.sessionId)

  const expired = actions.filter((a) => {
    const session = a.sessionId === null ? undefined : sessionById.get(a.sessionId)
    return a.createdAt < cutoff && (session === undefined || !isActiveStatus(session.status))
  })
  const named = new Set(actions.flatMap((a) => [a.sessionId, a.alertId]))

  const finished = sessions.filter((s) => !isActiveStatus(s.status))
  const recentSessions = newest(finished, (s) => s.updatedAt, SNAPSHOT_FINISHED_SESSIONS)
  const recentAlerts = newest(alerts, (a) => a.receivedAt, SNAPSHOT_ALERTS)
  let doomedSessions = finished.filter((s) => s.updatedAt < cutoff && s.worktree === null && !recentSessions.has(s) && !named.has(s.id))
  let doomedAlerts = alerts.filter((a) => a.receivedAt < cutoff && !recentAlerts.has(a) && !named.has(a.id))

  // Each pass only removes candidates, so this ends.
  for (;;) {
    const goingAlerts = new Set(doomedAlerts.map((a) => a.id))
    const nextSessions = doomedSessions.filter(
      (s) => (goingAlerts.has(s.alertId) || !alertIds.has(s.alertId)) && (attachedTo.get(s.id) ?? []).every((a) => goingAlerts.has(a.id)),
    )
    const goingSessions = new Set(nextSessions.map((s) => s.id))
    const nextAlerts = doomedAlerts.filter(
      (a) =>
        (sessionsOf.get(a.id) ?? []).every((s) => goingSessions.has(s.id)) &&
        (a.sessionId === null || goingSessions.has(a.sessionId) || !sessionById.has(a.sessionId)),
    )
    const settled = nextSessions.length === doomedSessions.length && nextAlerts.length === doomedAlerts.length
    doomedSessions = nextSessions
    doomedAlerts = nextAlerts
    if (settled) break
  }
  return { actionIds: expired.map((a) => a.id), sessions: doomedSessions, alertIds: doomedAlerts.map((a) => a.id) }
}
