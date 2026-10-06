import { Context, Effect, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import type { Alert, AlertKind, ParsedAlert, Triage } from "../domain/alert.ts"
import type { AdapterError } from "../domain/errors.ts"
import { daysAgo, now as nowIso } from "../domain/ids.ts"
import { type Board, Boards } from "../grafana/board.ts"
import { alertBoard, type PanelSpec } from "../grafana/boards.ts"
import { Grafana } from "../grafana/client.ts"
import { Hub } from "../hub.ts"
import { Intake, routeOf } from "../intake/intake.ts"
import { Store } from "../store/store.ts"
import { Jev } from "../jev.ts"
import { alertKind } from "../triage/kind.ts"
import { decideAnomaly } from "../triage/policy.ts"
import { applyRules } from "../triage/rules.ts"
import { reportJev, triageWith } from "../triage/verdict.ts"
import type { LogPatternVerdict } from "./judge.ts"
import { clock } from "../lib/text.ts"
import { type Anomaly, anomalyOf, backToUsual, findingOf, formatValue, measure, type Measure, watchBoard, watchFingerprint, WORSE_FACTOR } from "./detect.ts"
import { candidates, judgeInput, type LogPattern, logFinding, logTriage, mergeRows, type PatternRow, patternLink, rowOf, SWEEPS, type Sweep, sweepQuery } from "./logs.ts"
import { type Judged, loadJudged, saveJudged, saveSweep, watchBlocked } from "./sweep-store.ts"

/**
 * Bridgetown's own eyes on prod: every few minutes it reads the overview
 * signals from Grafana and, when one has risen or spiked and nothing in Slack
 * covers it, raises a finding and starts an investigation on it, as Auto-start
 * does for an alert (paused or Auto-start off, it waits in Needs you instead).
 * Jev judges each one for the agent's depth; one Jev sees nothing in, or with
 * Jev unavailable, is only suggested (`decideAnomaly`).
 */
export interface WatcherShape {
  readonly tick: Effect.Effect<void, AdapterError>
  /**
   * Sweeps prod's error and warning logs for patterns that are new, surging or
   * name a risk, asks Jev about the new candidates in one batch, and starts
   * an investigation on each one Jev calls a real problem.
   */
  readonly sweepLogs: Effect.Effect<void, AdapterError>
}

export class Watcher extends Context.Service<Watcher, WatcherShape>()("Watcher") {}

/** One finding per signal in this long: a rise that lasts all afternoon is one card, not twenty. */
const COOLDOWN_HOURS = 6
/** A Slack alert this recent about the same signal already told you. */
const COVERED_HOURS = 2

/** One sweep's rows, or why its query failed. */
interface SweepResult {
  readonly rows: ReadonlyArray<PatternRow>
  readonly failure: string | null
}

/** Investigations one log sweep may start; the rest of its findings are suggested. */
const MAX_LOG_STARTS = 2

/** Kinds whose board leads with a general signal (API 5xx for any runtime error), not one the alert is about. */
const VAGUE_KINDS: ReadonlySet<AlertKind> = new Set(["runtime_error", "informational", "build_failure"])

/**
 * The overview signal a Slack alert is about: the first panel of its board, a route's 5xx or p99 counting as the
 * API's. The other panels are background, and a chain's signal never stands for every chain.
 */
const signalOf = (alert: Alert, now: Date): string | undefined => {
  const primary = alertBoard(alert, now)?.panels[0]?.id
  if (primary === undefined) return undefined
  if (primary.startsWith("route_5xx_")) return "api_5xx"
  if (primary.startsWith("route_p99_")) return "api_p99"
  return VAGUE_KINDS.has(alertKind(alert)) ? undefined : primary
}

/** Of the Slack alerts of the last `COVERED_HOURS`, one someone is acting on (suggested, escalated or handed to an agent) about this signal. */
export const coveredBySlack = (signal: string, recent: ReadonlyArray<Alert>, now: Date): Alert | undefined =>
  recent.find(
    (alert) =>
      (alert.sessionId !== null || alert.triage.decision === "auto" || alert.triage.decision === "suggest" || alert.triage.decision === "escalate") &&
      signalOf(alert, now) === signal,
  )

export const WatcherLive = Layer.effect(Watcher)(
  Effect.gen(function* () {
    const hub = yield* Hub
    const store = yield* Store
    const boards = yield* Boards
    const jev = yield* Jev
    const intake = yield* Intake
    const grafana = yield* Grafana
    const queue = yield* ActionQueue

    /**
     * A finding filed: to the session already on its signal if one is running (an earlier finding's), else triaged
     * by `judge` and acted on like a Slack alert. True when it was acted on.
     */
    const file = (finding: ParsedAlert, permalink: string, seen: ReadonlyArray<string>, history: ReadonlyArray<Alert>, judge: Effect.Effect<Triage, AdapterError>) =>
      Effect.gen(function* () {
        const rule = applyRules(finding, { activeSessions: yield* store.activeSessions(), sameFingerprint: history, claimedBy: [] })
        const route = routeOf(rule, `Signal rose again: ${finding.title}`, judge)
        yield* intake.file(finding, { permalink, receivedAt: nowIso(), seen }, route)
        return route._tag === "Judge"
      })

    /** One risen signal: skipped while cooling down or covered, else filed. */
    const raise = (anomaly: Anomaly, spec: PanelSpec, board: Board, stepSeconds: number, recent: ReadonlyArray<Alert>, now: Date) =>
      Effect.gen(function* () {
        const history = yield* store.alertsByFingerprint(watchFingerprint(anomaly.panel.id), daysAgo(7))
        // Cooling down after a finding, unless the signal has since got much worse.
        const cooldownStart = now.getTime() - COOLDOWN_HOURS * 3_600_000
        const levels = history.flatMap((a) => (a.fields._tag === "watch" && Date.parse(a.receivedAt) >= cooldownStart ? [a.fields.level] : []))
        const lastLevel = Math.max(0, ...levels)
        if (lastLevel > 0 && anomaly.level < WORSE_FACTOR * lastLevel) return
        const covering = coveredBySlack(anomaly.panel.id, recent, now)
        if (covering !== undefined) return yield* Effect.logInfo(`watch: ${anomaly.panel.id} rose, already covered by ${covering.id}`)
        const found = findingOf(anomaly, spec, stepSeconds, board.deploys, anomaly.panel.link)
        // Its id is the rise's start; a worse level of the same rise is a finding of its own, never a rewrite of the first.
        const finding = history.some((a) => a.id === found.id) ? { ...found, id: `${found.id}:${Math.floor(now.getTime() / 1000)}` } : found
        yield* file(
          finding,
          anomaly.panel.link,
          [
            `Seen by Bridgetown in Grafana: ${finding.title}`,
            ...(lastLevel > 0 ? [`${Math.round(anomaly.level / lastLevel)}× the level of the last finding, within its ${COOLDOWN_HOURS}-hour cooldown`] : []),
          ],
          history,
          triageWith(hub, jev.judge({ alert: finding, thread: [], reactions: [], history }), decideAnomaly, "suggest"),
        )
      })

    /**
     * A signal back to normal: the Investigate cards of its findings go, since there is nothing left to look at. The
     * finding stays, with why its card left. A finding someone started a session on is left alone.
     */
    const settle = (measured: Measure, now: Date) =>
      Effect.gen(function* () {
        const fingerprint = watchFingerprint(measured.panel.id)
        for (const card of (yield* queue.list).filter((a) => a.kind === "investigate" && a.fingerprint === fingerprint)) {
          const finding = card.alertId === null ? undefined : yield* store.getAlert(card.alertId)
          // A spike was over when it was raised: what it needs is an explanation, not a signal back to normal.
          if (finding === undefined || finding.sessionId !== null || finding.fields._tag !== "watch" || finding.fields.shape === "spike") continue
          if (!backToUsual(measured, finding.fields.usual)) continue
          yield* queue.remove(card.id)
          yield* store.appendAlertEvent(
            finding.id,
            `Back to its usual level at ${clock(now)} (${formatValue(measured.level, measured.panel.unit)}); the suggestion was withdrawn`,
            { disposition: "withdrawn" },
          )
          yield* hub.notify
        }
      })

    const tick = Effect.gen(function* () {
      if ((yield* watchBlocked(hub)) !== null) return
      const now = new Date()
      const spec = watchBoard(now)
      const board = yield* boards.latest(spec)
      if (board.error !== null) return
      const measured = spec.panels.flatMap((panelSpec) => {
        const panel = board.panels.find((p) => p.id === panelSpec.id)
        const m = panel === undefined ? null : measure(panel, spec.stepSeconds, now, panelSpec.source)
        return m === null ? [] : [{ m, panelSpec }]
      })
      const recent = measured.some(({ m }) => anomalyOf(m) !== null)
        ? yield* store.slackAlertsSince(new Date(now.getTime() - COVERED_HOURS * 3_600_000).toISOString())
        : []
      // One signal that cannot be raised or settled (a store or Jev hiccup) leaves the others to this tick.
      for (const { m, panelSpec } of measured) {
        const anomaly = anomalyOf(m)
        yield* (anomaly !== null ? raise(anomaly, panelSpec, board, spec.stepSeconds, recent, now) : settle(m, now)).pipe(
          Effect.catch((error) => Effect.logWarning(`watch: ${m.panel.id}: ${error.message}`)),
        )
      }
    })

    /** One sweep's patterns; a failed query (VictoriaLogs busy) is logged and leaves the other sweep. */
    const patternsOf = (sweep: Sweep, now: Date): Effect.Effect<SweepResult> =>
      grafana.logRows(sweepQuery(sweep), { start: new Date(now.getTime() - SWEEPS[sweep].windowMinutes * 60_000), end: now, stepSeconds: 60 }, 50).pipe(
        Effect.map((rows): SweepResult => ({ rows: rows.flatMap((row) => rowOf(sweep, row) ?? []), failure: null })),
        Effect.catch((error) =>
          Effect.logWarning(`watch: ${sweep} sweep failed: ${error.message}`).pipe(Effect.as<SweepResult>({ rows: [], failure: `The ${sweep} query failed: ${error.message}` })),
        ),
      )

    /** A pattern Jev called a problem, filed as a finding; its id, or null when it could not be filed. */
    const raiseLog = (pattern: LogPattern, verdict: LogPatternVerdict, triage: Triage, now: Date) => {
      const finding = logFinding(pattern, verdict, now)
      const link = patternLink(pattern, now)
      return store.alertsByFingerprint(finding.fingerprint, daysAgo(7)).pipe(
        Effect.flatMap((history) => file(finding, link, [`Found by Bridgetown in the logs: ${finding.title}`], history, Effect.succeed(triage))),
        Effect.map((acted) => ({ acted, alertId: finding.id })),
        Effect.catch((error) => Effect.logWarning(`watch: log pattern ${pattern.key} not raised: ${error.message}`).pipe(Effect.as({ acted: false, alertId: null }))),
      )
    }

    /**
     * Jev's verdicts on the candidates, and an investigation on each one it calls a problem. Returns the judged
     * patterns with this sweep's added; unchanged when Jev is down, so the next sweep asks again.
     */
    const judgeAndRaise = (patterns: ReadonlyArray<LogPattern>, judged: Readonly<Record<string, Judged>>, now: Date) =>
      Effect.gen(function* () {
        const picked = candidates(patterns, new Set(Object.keys(judged)))
        if (picked.length === 0) return judged
        const result = yield* jev.judgeLogPatterns(picked.map(judgeInput)).pipe(Effect.result)
        yield* reportJev(hub, result._tag === "Failure" ? result.failure : null)
        if (result._tag === "Failure") return judged
        const at = nowIso()
        const next: Record<string, Judged> = { ...judged }
        for (const [i, pattern] of picked.entries()) next[pattern.key] = { at, verdict: result.success[i] ?? null, alertId: null }
        // Saved before raising: a restart midway never asks Jev about the same patterns twice.
        yield* saveJudged(store, next)
        const threshold = (yield* hub.settings).thresholds.suggestActionable
        let started = 0
        for (const [i, pattern] of picked.entries()) {
          const verdict = result.success[i]
          if (verdict === undefined || verdict.problem < threshold) continue
          // A bad deploy logs many patterns at once: past the first few, they wait in Needs you rather than each start an agent.
          const triage = logTriage(verdict, started < MAX_LOG_STARTS ? "auto" : "suggest")
          const raised = yield* raiseLog(pattern, verdict, triage, now)
          next[pattern.key] = { at, verdict, alertId: raised.alertId }
          if (raised.acted && triage.decision === "auto") started++
        }
        yield* saveJudged(store, next)
        return next
      })

    const sweepLogs = Effect.gen(function* () {
      if ((yield* watchBlocked(hub)) !== null) return
      const now = new Date()
      const judged = yield* loadJudged(store, now)
      // One after the other: each is a heavy query, and VictoriaLogs is shared with everyone.
      const errors = yield* patternsOf("errors", now)
      const warnings = yield* patternsOf("warnings", now)
      const patterns = mergeRows([...errors.rows, ...warnings.rows])
      yield* judgeAndRaise(patterns, judged, now)
      const failures = [errors.failure, warnings.failure].filter((failure) => failure !== null)
      yield* saveSweep(store, { at: now.toISOString(), patterns, failures })
    })

    return { tick, sweepLogs }
  }),
)
