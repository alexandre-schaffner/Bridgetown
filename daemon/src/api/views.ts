import { Effect } from "effect"
import { Actions } from "../actions/actions.ts"
import { type Action, dismissCloses, openableUrl } from "../domain/action.ts"
import { alertOutcome } from "../domain/alert-outcome.ts"
import { type Alert, triageEvent } from "../domain/alert.ts"
import { critiquePassed, findingCounts } from "../domain/critique.ts"
import { progressOf } from "../domain/progress.ts"
import { acceptsMessages, type Session } from "../domain/session.ts"
import { Hub } from "../hub.ts"
import { revvLink } from "../ship/pr.ts"
import { Store } from "../store/store.ts"
import { byConcern, errorsLink, levelOf, type LogPattern, patternLink, shownUsual, suspicious } from "../watch/logs.ts"
import { type Judged, loadJudged, loadSweep, type SweepRecord } from "../watch/sweep-store.ts"
import { watchBlocked } from "../watch/watcher.ts"
import { metricsOf, windowStart } from "./metrics.ts"

/** The wire shapes of docs/API.md, built from the store. */

export const SNAPSHOT_ALERTS = 30
export const SNAPSHOT_FINISHED_SESSIONS = 20

const alertView = (alert: Alert, session: Session | undefined, openCards: number) => ({
  id: alert.id,
  channelId: alert.channelId,
  channelName: alert.channelName,
  ts: alert.ts,
  permalink: alert.permalink,
  title: alert.title,
  summary: alert.summary,
  source: alert.source,
  receivedAt: alert.receivedAt,
  triage: alert.triage,
  sessionId: alert.sessionId,
  feedback: alert.feedback,
  claimedBy: alert.claimedBy,
  outcome: alertOutcome(alert, session, openCards),
})

export const sessionView = (session: Session) => ({
  id: session.id,
  alertId: session.alertId,
  title: session.title,
  channelName: session.channelName,
  status: session.status,
  activity: session.activity,
  diagnosis: session.diagnosis,
  outcome: session.outcome,
  prUrl: session.prUrl,
  branch: session.branch,
  worktree: session.worktree,
  claudeSessionId: session.claudeSessionId,
  model: session.model,
  ciRounds: session.ciRounds,
  critiqueRounds: session.critiqueRounds,
  critique:
    session.critique === null
      ? null
      : {
          reviewer: session.critique.reviewer,
          passed: critiquePassed(session.critique),
          ...findingCounts(session.critique),
        },
  costUsd: session.costUsd,
  slackThreadUrl: session.slackThreadUrl,
  ...progressOf(session),
  resolution: session.resolution,
  rootCauseFound: session.rootCauseFound,
  acceptsMessages: acceptsMessages(session),
  revvUrl: session.prUrl === null ? null : revvLink(session.prUrl),
  reviewChannel: session.review?.posted === true ? session.review.channelName : null,
  reviewUrl: session.review?.permalink ?? null,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
})

const actionView = (action: Action, session: Session | undefined, inFlight: ReadonlySet<string>) => ({
  id: action.id,
  kind: action.kind,
  title: action.title,
  detail: action.detail,
  primaryLabel: action.primaryLabel,
  options: action.options,
  sessionId: action.sessionId,
  alertId: action.alertId,
  url: openableUrl(action.url),
  inFlight: inFlight.has(action.id),
  dismissCloses: dismissCloses(action, session),
  createdAt: action.createdAt,
})

/** Sessions by id, from those already loaded plus any older ones `ids` refer to. */
const sessionsById = (loaded: ReadonlyArray<Session>, ids: ReadonlyArray<string | null>) =>
  Effect.gen(function* () {
    const store = yield* Store
    const byId = new Map(loaded.map((session) => [session.id, session]))
    for (const id of ids) {
      if (id === null || byId.has(id)) continue
      const session = yield* store.getSession(id)
      if (session !== undefined) byId.set(id, session)
    }
    return byId
  })

export const snapshot = Effect.gen(function* () {
  const store = yield* Store
  const hub = yield* Hub
  const status = yield* hub.status
  const settings = yield* hub.settings
  const dryRun = yield* hub.dryRun
  const inFlight = yield* (yield* Actions).inFlight
  const active = yield* store.activeSessions()
  const finished = yield* store.recentSessions(SNAPSHOT_FINISHED_SESSIONS)
  const actions = yield* store.listActions()
  const alerts = yield* store.recentAlerts(SNAPSHOT_ALERTS)
  const sessions = yield* sessionsById([...active, ...finished], [...alerts.map((a) => a.sessionId), ...actions.map((a) => a.sessionId)])
  const of = (id: string | null) => (id === null ? undefined : sessions.get(id))
  const openCards = (alertId: string) => actions.filter((a) => a.alertId === alertId).length

  const metrics = metricsOf(new Date(), yield* store.sessionsUpdatedSince(windowStart(new Date()).toISOString()))
  return {
    status: { ...status, dryRun },
    actions: actions.map((action) => actionView(action, of(action.sessionId), inFlight)),
    sessions: [...active, ...finished].map(sessionView),
    alerts: alerts.map((alert) => alertView(alert, of(alert.sessionId), openCards(alert.id))),
    metrics,
    settings,
  }
})

export const alertDetail = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const alert = yield* store.getAlert(id)
    if (alert === undefined) return undefined
    const session = alert.sessionId === null ? undefined : yield* store.getSession(alert.sessionId)
    const actions = (yield* store.listActions()).filter((a) => a.alertId === id)
    const sessions = yield* sessionsById(session === undefined ? [] : [session], actions.map((a) => a.sessionId))
    const inFlight = yield* (yield* Actions).inFlight
    return {
      alert: alertView(alert, session, actions.length),
      raw: alert.raw,
      // Alerts stored before history existed still say how they were triaged.
      events: alert.events.length > 0 ? alert.events : [{ at: alert.receivedAt, text: triageEvent(alert.triage) }],
      session: session === undefined ? null : sessionView(session),
      actions: actions.map((action) => actionView(action, action.sessionId === null ? undefined : sessions.get(action.sessionId), inFlight)),
    }
  })

/**
 * `LogSweep`: the last sweep's patterns, most telling first, each with Jev's verdict, its finding and its lines in
 * Grafana. `blocked` says why no sweep runs (watching off, Grafana MCP down), and comes before a failed query.
 */
export const sweepView = (record: SweepRecord | undefined, judged: Readonly<Record<string, Judged>>, now: Date, blocked: string | null) => ({
  sweptAt: record?.at ?? null,
  link: errorsLink(now),
  error: blocked ?? (record === undefined || record.failures.length === 0 ? null : record.failures.join(" · ")),
  patterns: record === undefined ? [] : [...record.patterns].sort(byConcern).map((p) => patternView(p, judged[p.key], new Date(record.at), now)),
})

const patternView = (p: LogPattern, seen: Judged | undefined, sweptAt: Date, now: Date) => ({
  key: p.key,
  level: levelOf(p.sweep),
  behaviour: p.behaviour,
  suspicious: suspicious(p),
  sources: p.sources,
  message: p.message,
  example: p.example,
  versions: p.versions,
  recent: p.recent,
  usual: shownUsual(p),
  jev: seen === undefined || seen.verdict === null ? null : { ...seen.verdict, at: seen.at },
  alertId: seen?.alertId ?? null,
  link: patternLink(p, sweptAt, now),
})

export const logSweep = Effect.gen(function* () {
  const store = yield* Store
  const now = new Date()
  return sweepView(yield* loadSweep(store), yield* loadJudged(store, now), now, yield* watchBlocked(yield* Hub))
})
