import { Context, Effect, Layer } from "effect"
import { alertFromParsed, type ParsedAlert } from "../domain/alert.ts"
import type { AdapterError } from "../domain/errors.ts"
import { daysAgo, now as nowIso } from "../domain/ids.ts"
import { type Alert, type AlertKind, type Triage, triageEvent } from "../domain/model.ts"
import { type Board, Boards } from "../grafana/board.ts"
import { alertBoard, type PanelSpec, watchBoard } from "../grafana/boards.ts"
import { Hub } from "../hub.ts"
import { AlertPipeline } from "../pipeline/alerts.ts"
import { Store } from "../store/store.ts"
import { Jev } from "../triage/jev.ts"
import { alertKind } from "../triage/kind.ts"
import { decide } from "../triage/policy.ts"
import { applyRules } from "../triage/rules.ts"
import { type Anomaly, detect, findingOf } from "./detect.ts"

/**
 * Bridgetown's own eyes on prod: every few minutes it reads the overview
 * signals from Grafana and, when one has risen and nothing in Slack covers it,
 * raises a finding that goes through Jev like any alert. Findings are only ever
 * suggested: an agent starts on one when you press Investigate.
 */
export interface WatcherShape {
  readonly tick: Effect.Effect<void, AdapterError>
}

export class Watcher extends Context.Service<Watcher, WatcherShape>()("Watcher") {}

/** One finding per signal in this long: a rise that lasts all afternoon is one card, not twenty. */
const COOLDOWN_HOURS = 6
/** A Slack alert this recent about the same signal already told you. */
const COVERED_HOURS = 2

const hoursAgo = (hours: number) => daysAgo(hours / 24)

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

    return { tick }
  }),
)
