import { Context, Effect, Layer } from "effect"
import { ActionQueue, type NewAction } from "../actions/queue.ts"
import type { Action } from "../domain/action.ts"
import { type Alert, alertFromParsed, channelLabel, type Claimant, claimHeadline, type ParsedAlert, type Triage, triageEvent } from "../domain/alert.ts"
import { type AdapterError, NotFound } from "../domain/errors.ts"
import { now } from "../domain/ids.ts"
import { isActive } from "../domain/session.ts"
import { Hub } from "../hub.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { revvLink } from "../ship/pr.ts"
import { Claims } from "../slack/claims.ts"
import { Store } from "../store/store.ts"
import type { RuleOutcome } from "../triage/rules.ts"

/** How a new item is settled before it is stored: by the session already on it, by a rule, or by Jev. */
export type Route =
  /** Another sign of what a running session is on: it goes to that session, whose transcript gets `note`. */
  | { readonly _tag: "Attach"; readonly sessionId: string; readonly reason: string; readonly note: string }
  /** A rule settles it: nothing to do. */
  | { readonly _tag: "Filtered"; readonly reason: string }
  /** Jev's verdict through the policy (`triageWith`). */
  | { readonly _tag: "Judge"; readonly triage: Effect.Effect<Triage, AdapterError> }

/** The rules' outcome as a route: `note` for the running session it attaches to, `judge` when no rule settles it. */
export const routeOf = (rule: RuleOutcome, note: string, judge: Effect.Effect<Triage, AdapterError>): Route =>
  rule._tag === "Attach" ? { ...rule, note } : rule._tag === "Filtered" ? rule : { _tag: "Judge", triage: judge }

export interface Filing {
  readonly permalink: string | null
  /** When it arrived, for a new alert; one stored already keeps its own. */
  readonly receivedAt: string
  /** History lines before the verdict's: how a finding was seen. */
  readonly seen?: ReadonlyArray<string>
  /** The Slack message's, so an unchanged message is skipped next poll. */
  readonly contentHash?: string
  /** Teammates on it per Slack. */
  readonly claimedBy?: ReadonlyArray<Claimant>
}

/**
 * The one way something that may need doing (an alert-channel post, a message to you, a prod finding) becomes a
 * stored alert, what its triage decided gets done, and what you can do about the call.
 */
export interface IntakeShape {
  /**
   * Stores the item as `route` settles it, re-reading the row so a session you started meanwhile keeps its place and
   * history is appended to, then acts on the verdict: an agent, a card, or nothing. An alert stored before and now
   * left with nothing to do loses the card its earlier verdict put up.
   */
  readonly file: (parsed: ParsedAlert, filing: Filing, route: Route) => Effect.Effect<Alert | undefined, AdapterError>
  /** You asked: starts a session on the alert whatever Jev said, claimed in Slack even if a teammate is on it too. */
  readonly investigate: (alertId: string) => Effect.Effect<void, AdapterError | NotFound>
}

export class Intake extends Context.Service<Intake, IntakeShape>()("Intake") {}

export const IntakeLive = Layer.effect(Intake)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const repo = yield* SessionRepo
    const runner = yield* SessionRunner
    const queue = yield* ActionQueue
    const claims = yield* Claims

    /** One card per problem: the newest item's replaces the cards an earlier one with its fingerprint put up. */
    const offer = (alert: Alert, card: Pick<NewAction, "kind" | "title" | "detail" | "primaryLabel" | "url">) =>
      Effect.gen(function* () {
        yield* queue.removeWhere((a) => (a.kind === "investigate" || a.kind === "escalate") && a.fingerprint === alert.fingerprint)
        yield* queue.put({ ...card, options: [], sessionId: null, alertId: alert.id, fingerprint: alert.fingerprint })
      })

    const suggest = (alert: Alert) =>
      offer(alert, { kind: "investigate", title: alert.title, detail: `${channelLabel(alert)} · ${alert.triage.reason}`, primaryLabel: "Investigate" })

    /** Yours to handle: opened where it was asked, or in Revv for a pull request. */
    const escalate = (alert: Alert) => {
      const prUrl = alert.fields._tag === "inbox" ? alert.fields.prUrl : null
      const revv = prUrl === null ? null : revvLink(prUrl)
      return offer(alert, {
        kind: "escalate",
        title: alert.title,
        detail: alert.triage.reason,
        primaryLabel: revv === null ? "Open in Slack" : "Open in Revv",
        url: revv ?? alert.permalink,
      })
    }

    const suggestionOf = (alertId: string) => (a: Action) => a.alertId === alertId && a.kind === "investigate"

    /** A teammate got there first: their claim goes on the alert, and your card for it goes. */
    const yieldTo = (alert: Alert, claimedBy: ReadonlyArray<Claimant>) =>
      Effect.gen(function* () {
        yield* queue.removeWhere(suggestionOf(alert.id))
        yield* store.appendAlertEvent(alert.id, `Left to a teammate: ${claimHeadline(claimedBy) ?? ""}`, { claimedBy })
        yield* hub.notify
      })

    /** Auto-start (unless paused or off), else a suggestion; an escalation is yours; anything else needs nothing. */
    const act = (alert: Alert) =>
      Effect.gen(function* () {
        const decision = alert.triage.decision
        if (decision === "escalate") return yield* escalate(alert)
        if (decision === "auto" && !(yield* hub.status).paused && (yield* hub.settings).autoStart) {
          const take = yield* claims.take(alert, { yieldTo: true })
          if (take._tag === "TakenBy") return yield* yieldTo(alert, take.claimedBy)
          // An agent is on it now: a suggestion an earlier verdict put up is moot.
          yield* queue.removeWhere(suggestionOf(alert.id))
          yield* runner.enqueue(alert)
          return
        }
        if (decision === "auto" || decision === "suggest") yield* suggest(alert)
      })

    /** Re-triaged to nothing to do (a failed build re-run green, a repeat a session now owns): its card goes, and its history says why. */
    const withdraw = (id: string, reason: string) =>
      Effect.gen(function* () {
        if (!(yield* queue.list).some(suggestionOf(id))) return
        yield* queue.removeWhere(suggestionOf(id))
        yield* store.appendAlertEvent(id, `Its card was withdrawn: ${reason}`, { disposition: "withdrawn" })
      })

    const file = Effect.fn("Intake.file")(function* (parsed: ParsedAlert, filing: Filing, route: Route) {
      const known = (yield* store.getAlert(parsed.id)) !== undefined
      const triage: Triage = route._tag === "Judge" ? yield* route.triage : { decision: "filtered", reason: route.reason, jev: null }
      const verdict = route._tag === "Attach" ? `Attached to a running session: ${route.reason}` : triageEvent(triage)
      const alert = yield* store.modifyAlert(
        parsed.id,
        (current) =>
          alertFromParsed(parsed, {
            permalink: filing.permalink,
            receivedAt: current?.receivedAt ?? filing.receivedAt,
            triage,
            sessionId: current?.sessionId ?? (route._tag === "Attach" ? route.sessionId : null),
            events: [...(current?.events ?? []), ...[...(filing.seen ?? []), verdict].map((text) => ({ at: now(), text }))],
            disposition: current?.disposition ?? null,
            claimedBy: filing.claimedBy ?? current?.claimedBy ?? [],
          }),
        filing.contentHash,
      )
      if (route._tag === "Attach") yield* repo.log(route.sessionId, "status", route.note)
      if (known && (triage.decision === "filtered" || triage.decision === "ignore")) yield* withdraw(parsed.id, triage.reason)
      yield* hub.notify
      if (alert !== undefined && alert.sessionId === null) yield* act(alert)
      return alert
    })

    const stored = (alertId: string) =>
      Effect.gen(function* () {
        const alert = yield* store.getAlert(alertId)
        if (alert === undefined) return yield* new NotFound({ message: "unknown alert" })
        return alert
      })

    const investigate = Effect.fn("Intake.investigate")(function* (alertId: string) {
      const alert = yield* stored(alertId)
      if (alert.sessionId !== null) {
        const session = yield* store.getSession(alert.sessionId)
        if (session !== undefined && isActive(session)) return
      }
      yield* queue.removeWhere(suggestionOf(alertId))
      yield* claims.take(alert, { yieldTo: false })
      yield* runner.enqueue(alert)
    })

    return { file, investigate }
  }),
)
