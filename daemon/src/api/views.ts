import { Effect } from "effect"
import { Actions } from "../actions/actions.ts"
import { type Action, dismissCloses, openableUrl } from "../domain/action.ts"
import { alertOutcome } from "../domain/alert-outcome.ts"
import { type Alert, channelLabel, triageEvent } from "../domain/alert.ts"
import { progressOf } from "../domain/progress.ts"
import { acceptsMessages, type Session } from "../domain/session.ts"
import type { Settings } from "../domain/settings.ts"
import type { FetchedBoard } from "../grafana/board.ts"
import { Hub, type Status as HubStatus } from "../hub.ts"
import { revvLink } from "../ship/pr.ts"
import { SlackMe } from "../slack/me.ts"
import { fromMrkdwn, mentionedUsers } from "../slack/mrkdwn.ts"
import { Store } from "../store/store.ts"
import { type Reading, readingOnBoard } from "../watch/detect.ts"
import { byConcern, errorsLink, levelOf, type LogPattern, patternLink, shownUsual, suspicious } from "../watch/logs.ts"
import { type Judged, loadJudged, loadSweep, type SweepRecord } from "../watch/sweep-store.ts"
import { watchBlocked } from "../watch/watcher.ts"
import { metricsOf, windowStart } from "./metrics.ts"
import type { ActionView, AlertDetail, AlertView, Board, LogPatternView, LogSweep, Metrics, Panel, SessionView, Snapshot } from "./wire.ts"

/** The wire shapes of wire.ts, built from the store: pure builders, then the effects that gather what they need. */

export const SNAPSHOT_ALERTS = 30
export const SNAPSHOT_FINISHED_SESSIONS = 20

const alertView = (alert: Alert, session: Session | undefined, openCards: number): AlertView => ({
  id: alert.id,
  channelLabel: channelLabel(alert),
  permalink: alert.permalink,
  title: alert.title,
  summary: alert.summary,
  source: alert.source,
  receivedAt: alert.receivedAt,
  triage: alert.triage,
  sessionId: alert.sessionId,
  feedback: alert.feedback,
  outcome: alertOutcome(alert, session, openCards),
})

/** `alert` is the session's own, for where it came from; without it (gone from the store), its channel's name stands. */
const sessionView = (session: Session, alert: Alert | undefined): SessionView => ({
  id: session.id,
  alertId: session.alertId,
  title: session.title,
  channelLabel: alert === undefined ? `#${session.channelName}` : channelLabel(alert),
  status: session.status,
  ...progressOf(session),
  rootCauseFound: session.rootCauseFound,
  activity: session.activity,
  diagnosis: session.diagnosis,
  outcome: session.outcome,
  prUrl: session.prUrl,
  branch: session.branch,
  worktree: session.worktree,
  provider: session.provider,
  agentSessionId: session.agentSessionId,
  agentConfigDir: session.agentConfigDir,
  model: session.model,
  ciRounds: session.ciRounds,
  costUsd: session.costUsd,
  slackThreadUrl: session.slackThreadUrl,
  acceptsMessages: acceptsMessages(session),
  revvUrl: session.prUrl === null ? null : revvLink(session.prUrl),
  reviewChannel: session.review?.posted === true ? session.review.channelName : null,
  reviewUrl: session.review?.permalink ?? null,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
})

const actionView = (action: Action, session: Session | undefined, inFlight: ReadonlySet<string>): ActionView => ({
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

/** What a snapshot is built from: the store's rows (sessions and alerts by id include those the lists refer to) and the hub's state. */
export interface SnapshotParts {
  readonly status: HubStatus
  readonly dryRun: boolean
  readonly settings: Settings
  readonly inFlight: ReadonlySet<string>
  /** Active first, then the recent finished ones. */
  readonly sessions: ReadonlyArray<Session>
  readonly actions: ReadonlyArray<Action>
  readonly alerts: ReadonlyArray<Alert>
  readonly sessionsById: ReadonlyMap<string, Session>
  readonly alertsById: ReadonlyMap<string, Alert>
  readonly metrics: Metrics
}

export const snapshotView = (parts: SnapshotParts): Snapshot => {
  const session = (id: string | null) => (id === null ? undefined : parts.sessionsById.get(id))
  const openCards = (alertId: string) => parts.actions.filter((a) => a.alertId === alertId).length
  return {
    status: { ...parts.status, dryRun: parts.dryRun },
    actions: parts.actions.map((action) => actionView(action, session(action.sessionId), parts.inFlight)),
    sessions: parts.sessions.map((s) => sessionView(s, parts.alertsById.get(s.alertId))),
    alerts: parts.alerts.map((alert) => alertView(alert, session(alert.sessionId), openCards(alert.id))),
    metrics: parts.metrics,
    settings: parts.settings,
  }
}

/** `names`: the display names of the users `raw` mentions (`mentionedUsers`). */
export const alertDetailView = (
  alert: Alert,
  session: Session | undefined,
  actions: ReadonlyArray<Action>,
  sessionsById: ReadonlyMap<string, Session>,
  inFlight: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): AlertDetail => ({
  alert: alertView(alert, session, actions.length),
  raw: fromMrkdwn(alert.raw, names),
  // Alerts stored before history existed still say how they were triaged.
  events: alert.events.length > 0 ? alert.events : [{ at: alert.receivedAt, text: triageEvent(alert.triage) }],
  session: session === undefined ? null : sessionView(session, alert),
  actions: actions.map((action) => actionView(action, action.sessionId === null ? undefined : sessionsById.get(action.sessionId), inFlight)),
})

/** Rows by id, from those already loaded plus any older ones `ids` refer to. */
const byId = <A extends { readonly id: string }, E, R>(
  loaded: ReadonlyArray<A>,
  ids: ReadonlyArray<string | null>,
  get: (id: string) => Effect.Effect<A | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const rows = new Map(loaded.map((row) => [row.id, row]))
    for (const id of ids) {
      if (id === null || rows.has(id)) continue
      const row = yield* get(id)
      if (row !== undefined) rows.set(id, row)
    }
    return rows
  })

export const snapshot = Effect.gen(function* () {
  const store = yield* Store
  const hub = yield* Hub
  const sessions = [...(yield* store.activeSessions()), ...(yield* store.recentSessions(SNAPSHOT_FINISHED_SESSIONS))]
  const actions = yield* store.listActions()
  const alerts = yield* store.recentAlerts(SNAPSHOT_ALERTS)
  const now = new Date()
  return snapshotView({
    status: yield* hub.status,
    dryRun: yield* hub.dryRun,
    settings: yield* hub.settings,
    inFlight: yield* (yield* Actions).inFlight,
    sessions,
    actions,
    alerts,
    sessionsById: yield* byId(sessions, [...alerts.map((a) => a.sessionId), ...actions.map((a) => a.sessionId)], store.getSession),
    alertsById: yield* byId(alerts, sessions.map((s) => s.alertId), store.getAlert),
    metrics: metricsOf(now, yield* store.sessionsUpdatedSince(windowStart(now).toISOString())),
  })
})

export const alertDetail = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const alert = yield* store.getAlert(id)
    if (alert === undefined) return undefined
    const session = alert.sessionId === null ? undefined : yield* store.getSession(alert.sessionId)
    const actions = (yield* store.listActions()).filter((a) => a.alertId === id)
    const sessions = yield* byId(session === undefined ? [] : [session], actions.map((a) => a.sessionId), store.getSession)
    const me = yield* SlackMe
    const names = yield* Effect.forEach(mentionedUsers(alert.raw), (user) => me.nameOf(user).pipe(Effect.map((name) => [user, name] as const)))
    return alertDetailView(alert, session, actions, sessions, yield* (yield* Actions).inFlight, new Map(names))
  })

/** A reading older than this is from a watcher that stopped (watching turned off): the board says nothing then. */
const READING_TTL_MS = 20 * 60_000
/** A board whose window ends this close to now shows how unusual its signals are now. */
const ENDS_NOW_MS = 10 * 60_000

/**
 * The board with the prod watcher's last readings laid over its panels: their usual level and spike line on this
 * board's steps, and on a board that ends now, how unusual each signal is (`Panel.spike`).
 */
export const boardView = (board: FetchedBoard, readings: ReadonlyMap<string, Reading>, now: Date): Board => {
  const endsNow = Math.abs(Date.parse(board.to) - now.getTime()) < ENDS_NOW_MS
  return {
    ...board,
    panels: board.panels.map((panel): Panel => {
      const reading = readings.get(panel.id)
      if (reading === undefined || panel.error !== null || now.getTime() - reading.at > READING_TTL_MS) return { ...panel, usual: null, spikeAbove: null, spike: null }
      return { ...panel, ...readingOnBoard(reading, board.stepSeconds), spike: endsNow ? reading.spike : null }
    }),
  }
}

/**
 * `LogSweep`: the last sweep's patterns, most telling first, each with Jev's verdict, its finding and its lines in
 * Grafana. `blocked` says why no sweep runs (watching off, Grafana MCP down), and comes before a failed query.
 */
export const sweepView = (record: SweepRecord | undefined, judged: Readonly<Record<string, Judged>>, now: Date, blocked: string | null): LogSweep => ({
  sweptAt: record?.at ?? null,
  link: errorsLink(now),
  error: blocked ?? (record === undefined || record.failures.length === 0 ? null : record.failures.join(" · ")),
  patterns: record === undefined ? [] : [...record.patterns].sort(byConcern).map((p) => patternView(p, judged[p.key], new Date(record.at), now)),
})

const patternView = (p: LogPattern, seen: Judged | undefined, sweptAt: Date, now: Date): LogPatternView => ({
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
