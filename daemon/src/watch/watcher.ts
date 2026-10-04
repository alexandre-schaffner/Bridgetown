import { Context, Effect, Layer } from "effect"
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
import { decide } from "../triage/policy.ts"
import { applyRules } from "../triage/rules.ts"
import { type Anomaly, detect, findingOf } from "./detect.ts"
import { candidates, judgeInput, linesQuery, logFinding, mergeRows, type PatternRow, rowOf, SWEEPS, type Sweep, sweepQuery } from "./logs.ts"

/**
 * Bridgetown's own eyes on prod: every few minutes it reads the overview
 * signals from Grafana and, when one has risen and nothing in Slack covers it,
 * raises a finding that goes through Jev like any alert. Findings are only ever
 * suggested: an agent starts on one when you press Investigate.
 */
export interface WatcherShape {
  readonly tick: Effect.Effect<void, AdapterError>
  /**
   * Sweeps prod's error and warning logs for patterns that are new, surging or
   * name a risk, asks Jev about the new candidates in one batch, and suggests
   * an investigation for each one Jev calls a real problem.
   */
  readonly sweepLogs: Effect.Effect<void, AdapterError>
}

export class Watcher extends Context.Service<Watcher, WatcherShape>()("Watcher") {}

/** One finding per signal in this long: a rise that lasts all afternoon is one card, not twenty. */
const COOLDOWN_HOURS = 6
/** A Slack alert this recent about the same signal already told you. */
const COVERED_HOURS = 2

const hoursAgo = (hours: number) => daysAgo(hours / 24)

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

    const triage = Effect.fn("Watcher.triage")(function* (finding: ParsedAlert, history: ReadonlyArray<Alert>) {
      const verdict = yield* jev.judge({ alert: finding, thread: [], reactions: [], history }).pipe(Effect.result)
      if (verdict._tag === "Failure") {
        yield* hub.patchStatus({ jev: verdict.failure._tag === "MissingCredential" ? "missing_key" : "error", error: `Jev: ${verdict.failure.message}` })
        const fallback: Triage = { decision: "suggest", reason: "Jev unavailable — your call", jev: null }
        return fallback
      }
      yield* hub.patchStatus({ jev: "ok" })
      const decision = decide(verdict.success, (yield* hub.settings).thresholds)
      // Nobody asked for this one: the most it gets is a suggestion.
      const result: Triage = { decision: decision.decision === "auto" ? "suggest" : decision.decision, reason: decision.reason, jev: verdict.success }
      return result
    })

    /** One risen signal: skipped while cooling down or covered, attached to the session already on it, else judged and acted on. */
    const raise = (anomaly: Anomaly, spec: PanelSpec, board: Board, stepSeconds: number, recent: ReadonlyArray<Alert>, now: Date) =>
      Effect.gen(function* () {
        const fingerprint = `watch:${anomaly.panel.id}`
        if ((yield* store.alertsByFingerprint(fingerprint, hoursAgo(COOLDOWN_HOURS))).length > 0) return
        const covering = coveredBySlack(anomaly.panel.id, recent, now)
        if (covering !== undefined) return yield* Effect.logInfo(`watch: ${anomaly.panel.id} rose, already covered by ${covering.id}`)
        const finding = findingOf(anomaly, spec, stepSeconds, board.deploys, anomaly.panel.link)
        const history = yield* store.alertsByFingerprint(fingerprint, daysAgo(7))
        // A session from an earlier finding is still on this signal: the rise goes to it, not to a second agent.
        const rule = applyRules(finding, { activeSessions: yield* store.activeSessions(), sameFingerprint: history, claimedBy: [] })
        const attachTo = rule._tag === "Attach" ? rule.sessionId : null
        const verdict: Triage = attachTo === null ? yield* triage(finding, history) : { decision: "filtered", reason: "Same signal as a running session", jev: null }
        const alert = alertFromParsed(finding, {
          permalink: anomaly.panel.link,
          receivedAt: nowIso(),
          triage: verdict,
          sessionId: attachTo,
          events: [
            { at: nowIso(), text: `Seen by Bridgetown in Grafana: ${finding.title}` },
            { at: nowIso(), text: attachTo === null ? triageEvent(verdict) : `Attached to a running session: ${verdict.reason}` },
          ],
        })
        yield* store.putAlert(alert)
        yield* hub.notify
        if (attachTo !== null) return yield* store.appendTranscript(attachTo, { at: nowIso(), kind: "status", text: `Signal rose again: ${finding.title}` })
        yield* pipeline.act(alert)
      })

    const tick = Effect.gen(function* () {
      if (!(yield* hub.settings).watchProd || (yield* hub.status).grafanaMcp === "down") return
      const now = new Date()
      const spec = watchBoard(now)
      const board = yield* boards.latest(spec)
      if (board.error !== null) return
      const risen = spec.panels.flatMap((panelSpec) => {
        const panel = board.panels.find((p) => p.id === panelSpec.id)
        const anomaly = panel === undefined ? null : detect(panel, spec.stepSeconds, now, panelSpec.source)
        return anomaly === null ? [] : [{ anomaly, panelSpec }]
      })
      if (risen.length === 0) return
      const recent = yield* store.recentAlerts(200)
      // One signal that cannot be raised (a store or Jev hiccup) leaves the others to be raised this tick.
      for (const { anomaly, panelSpec } of risen) {
        yield* raise(anomaly, panelSpec, board, spec.stepSeconds, recent, now).pipe(
          Effect.catch((error) => Effect.logWarning(`watch: ${anomaly.panel.id} not raised: ${error.message}`)),
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
      if (result._tag === "Failure") {
        // Not marked judged: the next sweep asks again.
        return yield* hub.patchStatus({ jev: result.failure._tag === "MissingCredential" ? "missing_key" : "error", error: `Jev: ${result.failure.message}` })
      }
      yield* hub.patchStatus({ jev: "ok" })
      yield* store.setKv(JUDGED_KEY, JSON.stringify({ ...judged, ...Object.fromEntries(picked.map((p) => [p.key, nowIso()])) }))
      const threshold = (yield* hub.settings).thresholds.suggestActionable
      for (const [i, pattern] of picked.entries()) {
        const verdict = result.success[i]
        if (verdict === undefined || verdict.problem < threshold) continue
        const link = exploreLogsLink(linesQuery(pattern), new Date(now.getTime() - 3 * 3_600_000), now)
        const finding = logFinding(pattern, verdict, now, link)
        const pct = (value: number) => `${Math.round(value * 100)}%`
        // Like every finding, at most a suggestion: an agent starts when you press Investigate.
        const triage: Triage = {
          decision: "suggest",
          reason: `Jev: likely a real problem (problem ${pct(verdict.problem)} · agent ${pct(verdict.agent)} · users ${pct(verdict.users)})`,
          jev: { actionable: verdict.problem, agentResolvable: verdict.agent, humanOnIt: 0, kind: "runtime_error", kindConfidence: 0, depth: "standard", urgency: 3 * verdict.users },
        }
        const alert = alertFromParsed(finding, {
          permalink: link,
          receivedAt: nowIso(),
          triage,
          sessionId: null,
          events: [
            { at: nowIso(), text: `Found by Bridgetown in the logs: ${finding.title}` },
            { at: nowIso(), text: triageEvent(triage) },
          ],
        })
        yield* store.putAlert(alert).pipe(
          Effect.andThen(hub.notify),
          Effect.andThen(pipeline.act(alert)),
          Effect.catch((error) => Effect.logWarning(`watch: log pattern ${pattern.key} not raised: ${error.message}`)),
        )
      }
    })

    return { tick, sweepLogs }
  }),
)
