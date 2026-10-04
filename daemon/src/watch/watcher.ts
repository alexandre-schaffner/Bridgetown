import { Context, Effect, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { alertFromParsed, type ParsedAlert } from "../domain/alert.ts"
import type { AdapterError } from "../domain/errors.ts"
import { daysAgo, now as nowIso } from "../domain/ids.ts"
import { type Alert, type AlertKind, type Triage, triageEvent } from "../domain/model.ts"
import { type Board, Boards } from "../grafana/board.ts"
import { alertBoard, exploreLogsLink, type PanelSpec, watchBoard } from "../grafana/boards.ts"
import { Grafana } from "../grafana/client.ts"
import { Hub } from "../hub.ts"
import { AlertPipeline } from "../pipeline/alerts.ts"
import { Store } from "../store/store.ts"
import { Jev } from "../triage/jev.ts"
import { alertKind } from "../triage/kind.ts"
import { decideAnomaly } from "../triage/policy.ts"
import { applyRules } from "../triage/rules.ts"
import { reportJev, triageWith } from "../triage/verdict.ts"
import { type Anomaly, anomalyOf, backToUsual, clock, findingOf, formatValue, type Measure, measure, WORSE_FACTOR, watchFingerprint } from "./detect.ts"
import { candidates, judgeInput, linesQuery, logFinding, logTriage, mergeRows, type PatternRow, rowOf, SWEEPS, type Sweep, sweepQuery } from "./logs.ts"

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

/** Investigations one log sweep may start; the rest of its findings are suggested. */
const MAX_LOG_STARTS = 2

/** Log patterns Jev has judged, so the same one is asked about once a day: `{ [key]: ISO time }`, kept across restarts. */
const JUDGED_KEY = "watch_log_judged"
const JUDGED_MS = 24 * 3_600_000

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

/** A recent Slack alert someone is acting on (suggested, escalated or handed to an agent) about this signal. */
export const coveredBySlack = (signal: string, alerts: ReadonlyArray<Alert>, now: Date): Alert | undefined =>
  alerts.find(
    (alert) =>
      alert.source !== "watch" &&
      Date.parse(alert.receivedAt) >= now.getTime() - COVERED_HOURS * 3_600_000 &&
      (alert.sessionId !== null || alert.triage.decision === "auto" || alert.triage.decision === "suggest" || alert.triage.decision === "escalate") &&
      signalOf(alert, now) === signal,
  )

export const WatcherLive = Layer.effect(Watcher)(
  Effect.gen(function* () {
    const hub = yield* Hub
    const store = yield* Store
    const boards = yield* Boards
    const jev = yield* Jev
    const pipeline = yield* AlertPipeline
    const grafana = yield* Grafana
    const queue = yield* ActionQueue

    /**
     * A finding filed: to the session already on its signal if one is running (an earlier finding's), else triaged
     * by `judge` and acted on like a Slack alert. True when it was acted on.
     */
    const file = (
      finding: ParsedAlert,
      permalink: string,
      seen: ReadonlyArray<string>,
      history: ReadonlyArray<Alert>,
      judge: Effect.Effect<Triage, AdapterError>,
    ) =>
      Effect.gen(function* () {
        const rule = applyRules(finding, { activeSessions: yield* store.activeSessions(), sameFingerprint: history, claimedBy: [] })
        const attachTo = rule._tag === "Attach" ? rule.sessionId : null
        const verdict: Triage = attachTo === null ? yield* judge : { decision: "filtered", reason: "Same signal as a running session", jev: null }
        const alert = alertFromParsed(finding, {
          permalink,
          receivedAt: nowIso(),
          triage: verdict,
          sessionId: attachTo,
          events: [
            ...seen.map((text) => ({ at: nowIso(), text })),
            { at: nowIso(), text: attachTo === null ? triageEvent(verdict) : `Attached to a running session: ${verdict.reason}` },
          ],
        })
        yield* store.putAlert(alert)
        yield* hub.notify
        if (attachTo !== null) {
          yield* store.appendTranscript(attachTo, { at: nowIso(), kind: "status", text: `Signal rose again: ${finding.title}` })
          return false
        }
        yield* pipeline.act(alert)
        return true
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
        for (const card of (yield* queue.list).filter((a) => a.kind === "investigate" && a.payload === fingerprint)) {
          const finding = card.alertId === null ? undefined : yield* store.getAlert(card.alertId)
          // A spike was over when it was raised: what it needs is an explanation, not a signal back to normal.
          if (finding === undefined || finding.sessionId !== null || finding.fields._tag !== "watch" || finding.fields.shape === "spike") continue
          if (!backToUsual(measured, finding.fields.usual)) continue
          yield* queue.remove(card.id)
          yield* store.appendAlertEvent(
            finding.id,
            `Back to its usual level at ${clock(now)} (${formatValue(measured.level, measured.panel.unit)}); the suggestion was withdrawn`,
            "withdrawn",
          )
          yield* hub.notify
        }
      })

    const tick = Effect.gen(function* () {
      if (!(yield* hub.settings).watchProd || (yield* hub.status).grafanaMcp === "down") return
      const now = new Date()
      const spec = watchBoard(now)
      const board = yield* boards.latest(spec)
      if (board.error !== null) return
      const measured = spec.panels.flatMap((panelSpec) => {
        const panel = board.panels.find((p) => p.id === panelSpec.id)
        const m = panel === undefined ? null : measure(panel, spec.stepSeconds, now, panelSpec.source)
        return m === null ? [] : [{ m, panelSpec }]
      })
      const recent = measured.some(({ m }) => anomalyOf(m) !== null) ? yield* store.recentAlerts(200) : []
      // One signal that cannot be raised or settled (a store or Jev hiccup) leaves the others to this tick.
      for (const { m, panelSpec } of measured) {
        const anomaly = anomalyOf(m)
        yield* (anomaly !== null ? raise(anomaly, panelSpec, board, spec.stepSeconds, recent, now) : settle(m, now)).pipe(
          Effect.catch((error) => Effect.logWarning(`watch: ${m.panel.id}: ${error.message}`)),
        )
      }
    })

    const loadJudged = (now: Date) =>
      store.getKv(JUDGED_KEY).pipe(
        Effect.map((raw): Record<string, string> => {
          try {
            const parsed: unknown = JSON.parse(raw ?? "{}")
            if (typeof parsed !== "object" || parsed === null) return {}
            return Object.fromEntries(
              Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && now.getTime() - Date.parse(entry[1]) < JUDGED_MS),
            )
          } catch {
            return {}
          }
        }),
      )

    /** One sweep's patterns; a failed query (VictoriaLogs busy) is logged and leaves the other sweep. */
    const patternsOf = (sweep: Sweep, now: Date) =>
      grafana.logRows(sweepQuery(sweep), { start: new Date(now.getTime() - SWEEPS[sweep].windowMinutes * 60_000), end: now, stepSeconds: 60 }, 50).pipe(
        Effect.map((rows) => rows.flatMap((row) => rowOf(sweep, row) ?? [])),
        Effect.catch((error) => Effect.logWarning(`watch: ${sweep} sweep failed: ${error.message}`).pipe(Effect.as<ReadonlyArray<PatternRow>>([]))),
      )

    const sweepLogs = Effect.gen(function* () {
      if (!(yield* hub.settings).watchProd || (yield* hub.status).grafanaMcp === "down") return
      const now = new Date()
      const judged = yield* loadJudged(now)
      // One after the other: each is a heavy query, and VictoriaLogs is shared with everyone.
      const errors = yield* patternsOf("errors", now)
      const warnings = yield* patternsOf("warnings", now)
      const picked = candidates(mergeRows([...errors, ...warnings]), new Set(Object.keys(judged)))
      if (picked.length === 0) return
      const result = yield* jev.judgeLogPatterns(picked.map(judgeInput)).pipe(Effect.result)
      yield* reportJev(hub, result._tag === "Failure" ? result.failure : null)
      // Not marked judged: the next sweep asks again.
      if (result._tag === "Failure") return
      yield* store.setKv(JUDGED_KEY, JSON.stringify({ ...judged, ...Object.fromEntries(picked.map((p) => [p.key, nowIso()])) }))
      const threshold = (yield* hub.settings).thresholds.suggestActionable
      let started = 0
      for (const [i, pattern] of picked.entries()) {
        const verdict = result.success[i]
        if (verdict === undefined || verdict.problem < threshold) continue
        const link = exploreLogsLink(linesQuery(pattern), new Date(now.getTime() - 3 * 3_600_000), now)
        const finding = logFinding(pattern, verdict, now, link)
        // A bad deploy logs many patterns at once: past the first few, they wait in Needs you rather than each start an agent.
        const triage = logTriage(verdict, started < MAX_LOG_STARTS ? "auto" : "suggest")
        const acted = yield* store.alertsByFingerprint(finding.fingerprint, daysAgo(7)).pipe(
          Effect.flatMap((history) => file(finding, link, [`Found by Bridgetown in the logs: ${finding.title}`], history, Effect.succeed(triage))),
          Effect.catch((error) => Effect.logWarning(`watch: log pattern ${pattern.key} not raised: ${error.message}`).pipe(Effect.as(false))),
        )
        if (acted && triage.decision === "auto") started++
      }
    })

    return { tick, sweepLogs }
  }),
)
