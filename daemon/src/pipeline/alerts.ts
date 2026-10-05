import { Context, Effect, Layer, Semaphore } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { alertFromParsed, type ParsedAlert } from "../domain/alert.ts"
import { type AdapterError, NotFound } from "../domain/errors.ts"
import { daysAgo, now, tsToIso } from "../domain/ids.ts"
import { type Alert, type Channel, channelLabel, type Claimant, claimHeadline, isActive, type Triage, triageEvent } from "../domain/model.ts"
import { Hub } from "../hub.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { Shipper } from "../ship/shipper.ts"
import { followsDeploy } from "../ship/transitions.ts"
import { Claims } from "../slack/claims.ts"
import { SlackClient, type SlackError, type SlackMessage } from "../slack/client.ts"
import { SlackMe } from "../slack/me.ts"
import { isHumanMessage, parseMessage } from "../slack/parse.ts"
import { toThreadReplies } from "../slack/text.ts"
import { Store, type StoreShape } from "../store/store.ts"
import { Jev } from "../triage/jev.ts"
import { decide } from "../triage/policy.ts"
import { applyRules } from "../triage/rules.ts"
import { triageWith } from "../triage/verdict.ts"

/** Alert channels: poll, parse, rule out, triage with Jev, then start, suggest or record. */
export interface AlertPipelineShape {
  /** One Slack poll of the alert channels, serialized with the poll loop. */
  readonly pollOnce: Effect.Effect<void, SlackError>
  /** Starts (or suggests) what triage decided for a stored alert. */
  readonly act: (alert: Alert) => Effect.Effect<void, AdapterError>
  /** Starts a session even if Jev said ignore. */
  readonly investigate: (alertId: string) => Effect.Effect<void, AdapterError | NotFound>
  readonly feedback: (alertId: string, label: "good" | "bad") => Effect.Effect<void, AdapterError | NotFound>
}

export class AlertPipeline extends Context.Service<AlertPipeline, AlertPipelineShape>()("AlertPipeline") {}

/** On first run, older history is not news. */
const LOOKBACK_MS = 3 * 60 * 60_000
const HORIZON_MARGIN_MS = 30 * 60_000
/** Newest posts read per channel every poll: enough to see the recent ones edited in place. */
const HISTORY_LIMIT = 15
/** How far one poll pages back, when more than a page arrived since the horizon (an outage, a burst). */
const BACKLOG_LIMIT = 200

const contentHash = (message: SlackMessage): string =>
  String(
    Bun.hash(JSON.stringify([message.text, message.blocks, message.attachments, message.reply_count, message.reactions, message.edited])),
  )

/** A bot's top-level post. People's messages, and every thread reply, are the inbox's to judge. */
export const isAlertMessage = (message: SlackMessage): boolean =>
  (message.subtype === undefined || message.subtype === "bot_message") &&
  (message.thread_ts === undefined || message.thread_ts === message.ts) &&
  !isHumanMessage(message)

/**
 * Only messages newer than a horizon are news. It never reaches further back
 * than the lookback (a weekend asleep must not replay Friday's alerts), and it
 * moves only once a read succeeded (`commitHorizon`): what was posted while
 * Slack could not be read is still news when it can.
 */
export const readHorizon = (store: StoreShape, key: string) =>
  store.getKv(key).pipe(Effect.map((stored) => Math.max(Number(stored ?? 0), Date.now() - LOOKBACK_MS)))

/** After a read that started at `readAt` succeeded: its start, minus a margin for search indexing lag and for a message whose ingest failed to be tried again. */
export const commitHorizon = (store: StoreShape, key: string, floor: number, readAt: number) =>
  store.setKv(key, String(Math.max(floor, readAt - HORIZON_MARGIN_MS)))

export const AlertPipelineLive = Layer.effect(AlertPipeline)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const slack = yield* SlackClient
    const me = yield* SlackMe
    const jev = yield* Jev
    const runner = yield* SessionRunner
    const shipper = yield* Shipper
    const queue = yield* ActionQueue
    const claims = yield* Claims
    /** Held by the poll loop and `POST /poll`, so two polls never ingest the same messages at once. */
    const polling = yield* Semaphore.make(1)

    const reactionsOf = (message: SlackMessage, myId: string | undefined): ReadonlyArray<string> =>
      (message.reactions ?? []).map((r) => {
        const mine = myId !== undefined && (r.users ?? []).includes(myId)
        return `:${r.name}: ×${r.count}${mine ? " (incl. me)" : ""}`
      })

    const triage = Effect.fn("AlertPipeline.triage")(function* (
      parsed: ParsedAlert,
      message: SlackMessage,
      thread: ReadonlyArray<SlackMessage>,
      history: ReadonlyArray<Alert>,
    ) {
      const identity = yield* me.known
      const replies = toThreadReplies(thread, identity?.user_id)
      const mentioned = parsed.mentionsMe || replies.some((r) => identity !== undefined && r.text.includes(identity.user))
      const judging = jev.judge({ alert: { ...parsed, mentionsMe: mentioned }, thread: replies, reactions: reactionsOf(message, identity?.user_id), history })
      return yield* triageWith(hub, judging, decide, "suggest")
    })

    const suggest = (alert: Alert) =>
      Effect.gen(function* () {
        yield* queue.removeWhere((a) => a.kind === "investigate" && a.payload === alert.fingerprint)
        yield* queue.put({
          kind: "investigate",
          title: alert.title,
          detail: `${channelLabel(alert)} · ${alert.triage.reason}`,
          primaryLabel: "Investigate",
          options: [],
          sessionId: null,
          alertId: alert.id,
          payload: alert.fingerprint,
        })
      })

    /** A teammate got there first: their claim goes on the alert, and your card for it goes. */
    const yieldTo = (alert: Alert, claimedBy: ReadonlyArray<Claimant>) =>
      Effect.gen(function* () {
        yield* queue.removeWhere((a) => a.kind === "investigate" && a.alertId === alert.id)
        yield* store.modifyAlert(alert.id, (current) =>
          current === undefined
            ? undefined
            : { ...current, claimedBy, events: [...current.events, { at: now(), text: `Left to a teammate: ${claimHeadline(claimedBy) ?? ""}` }] },
        )
        yield* hub.notify
      })

    const act = (alert: Alert) =>
      Effect.gen(function* () {
        const status = yield* hub.status
        const settings = yield* hub.settings
        if (alert.triage.decision === "auto" && !status.paused && settings.autoStart) {
          const take = yield* claims.take(alert, { yieldTo: true })
          if (take._tag === "TakenBy") return yield* yieldTo(alert, take.claimedBy)
          yield* runner.enqueue(alert)
          return
        }
        if (alert.triage.decision === "auto" || alert.triage.decision === "suggest") yield* suggest(alert)
      })

    const ingest = Effect.fn("AlertPipeline.ingest")(function* (channel: Channel, message: SlackMessage, since: number) {
      if (!isAlertMessage(message)) return
      const hash = contentHash(message)
      const id = `${channel.id}:${message.ts}`
      const knownHash = yield* store.alertHash(id)
      if (knownHash === hash) return
      if (knownHash === undefined && Number(message.ts) * 1000 < since) return
      const identity = yield* me.known
      const parsed = parseMessage(message, { channelId: channel.id, channelName: channel.name, myUserId: identity?.user_id })
      const existing = yield* store.getAlert(id)
      const permalink = existing?.permalink ?? (yield* slack.permalink(channel.id, message.ts).pipe(Effect.orElseSucceed(() => null)))
      /**
       * Every write re-reads the row: a session you started while Jev was
       * thinking keeps its `sessionId`, and history is appended to, never replaced.
       */
      const thread =
        (message.reply_count ?? 0) === 0
          ? []
          : yield* slack.replies(channel.id, message.ts).pipe(Effect.orElseSucceed((): ReadonlyArray<SlackMessage> => []))
      const claimedBy = yield* claims.read(message.reactions, thread)
      const write = (triage: (current: Alert | undefined) => Triage, event: string | null, attachTo: string | null = null) =>
        store.modifyAlert(
          id,
          (current) =>
            alertFromParsed(parsed, {
              permalink,
              receivedAt: current?.receivedAt ?? tsToIso(message.ts),
              triage: triage(current),
              sessionId: current?.sessionId ?? attachTo,
              events: [...(current?.events ?? []), ...(event === null ? [] : [{ at: now(), text: event }])],
              feedback: current?.feedback ?? null,
              disposition: current?.disposition ?? null,
              claimedBy,
            }),
          hash,
        )
      const finish = (alert: Alert | undefined) =>
        Effect.gen(function* () {
          if (alert !== undefined) yield* shipper.trackDeploy(alert)
          yield* hub.notify
        })

      // A known alert whose headline did not change (a reaction, a reply count) keeps its verdict.
      if (existing !== undefined && (existing.title === parsed.title || existing.sessionId !== null)) {
        const keep = (current: Alert | undefined) => current?.triage ?? existing.triage
        const newcomers = claimedBy.filter((c) => !existing.claimedBy.some((e) => e.userId === c.userId))
        const event = existing.title === parsed.title ? null : `Updated in Slack: ${parsed.title}`
        const alert = yield* write(keep, event)
        if (alert !== undefined && newcomers.length > 0) {
          // A card asking you to start an agent is stale once someone else is on it.
          if (alert.sessionId === null) yield* queue.removeWhere((a) => a.kind === "investigate" && a.alertId === id)
          yield* store.modifyAlert(id, (current) =>
            current === undefined ? undefined : { ...current, events: [...current.events, { at: now(), text: `In Slack: ${claimHeadline(newcomers)}` }] },
          )
        }
        return yield* finish(alert)
      }

      const history = (yield* store.alertsByFingerprint(parsed.fingerprint, daysAgo(7))).filter((a) => a.id !== id)
      const active = yield* store.activeSessions()
      const releaseTag = parsed.fields._tag === "release" ? parsed.fields.tag : null
      const shipping = releaseTag === null ? undefined : active.find((s) => followsDeploy(s, releaseTag))
      const outcome =
        shipping !== undefined
          ? { _tag: "Attach" as const, sessionId: shipping.id, reason: `Release cut by session ${shipping.id}` }
          : applyRules(parsed, { activeSessions: active, sameFingerprint: history, claimedBy })
      if (outcome._tag === "Filtered" || outcome._tag === "Attach") {
        const attached = outcome._tag === "Attach"
        const alert = yield* write(
          () => ({ decision: "filtered", reason: outcome.reason, jev: null }),
          attached ? `Attached to a running session: ${outcome.reason}` : `Filtered by a rule: ${outcome.reason}`,
          attached ? outcome.sessionId : null,
        )
        if (attached) yield* store.appendTranscript(outcome.sessionId, { at: now(), kind: "status", text: `Alert repeated: ${parsed.title}` })
        return yield* finish(alert)
      }

      const verdict = yield* triage(parsed, message, thread, history)
      const alert = yield* write(() => verdict, triageEvent(verdict))
      yield* finish(alert)
      if (alert !== undefined && alert.sessionId === null) yield* act(alert)
    })

    /**
     * The trackers of deploys in flight, read on their own. A tracker is edited in place for hours, long after newer
     * posts pushed it out of the channel's newest messages. `seen`: the messages this poll already read.
     */
    const refreshTrackers = (seen: ReadonlySet<string>) =>
      Effect.gen(function* () {
        for (const session of yield* store.activeSessions()) {
          const tracker = session.tracker
          if (tracker === null || seen.has(tracker) || session.release === null || !followsDeploy(session, session.release.tag)) continue
          const alert = yield* store.getAlert(tracker)
          if (alert === undefined) continue
          const channel = { id: alert.channelId, name: alert.channelName, enabled: true }
          // `oldest` and `latest` are both inclusive: exactly that message.
          yield* slack.latest(alert.channelId, 1, alert.ts, alert.ts).pipe(
            Effect.flatMap(([message]) => (message === undefined ? Effect.void : ingest(channel, message, 0))),
            Effect.catch((error) => hub.patchStatus({ error: `#${channel.name} tracker: ${error.message}` })),
          )
        }
      })

    /** A channel's posts back to `since`, newest first: its newest page, and the rest when more than a page arrived since. */
    const postsSince = (channel: Channel, since: number) =>
      Effect.gen(function* () {
        const newest = yield* slack.latest(channel.id, HISTORY_LIMIT)
        const last = newest.at(-1)
        if (newest.length < HISTORY_LIMIT || last === undefined || Number(last.ts) * 1000 <= since) return newest
        // Inclusive at both ends, so the page's last post comes back too.
        const backlog = yield* slack.latest(channel.id, BACKLOG_LIMIT, String(since / 1000), last.ts)
        return [...newest, ...backlog.filter((m) => m.ts !== last.ts)]
      })

    const pollOnce = Effect.gen(function* () {
      if ((yield* hub.status).slack === "missing_token") return
      yield* me.identity
      const enabled = (yield* hub.settings).channels.filter((c) => c.enabled)
      const seen = new Set<string>()
      let failures = 0
      for (const channel of enabled) {
        // One horizon per channel: a channel Slack would not serve keeps its own until it does.
        const key = `since:${channel.id}`
        const since = yield* readHorizon(store, key)
        const readAt = Date.now()
        const read = yield* postsSince(channel, since).pipe(Effect.result)
        if (read._tag === "Failure") {
          failures += 1
          yield* hub.patchStatus({ error: `Slack #${channel.name}: ${read.failure.message}` })
          continue
        }
        for (const message of [...read.success].reverse()) {
          seen.add(`${channel.id}:${message.ts}`)
          yield* ingest(channel, message, since).pipe(Effect.catch((error) => hub.patchStatus({ error: `#${channel.name}: ${error.message}` })))
        }
        yield* commitHorizon(store, key, since, readAt)
      }
      yield* refreshTrackers(seen)
      yield* hub.patchStatus({ slack: failures === enabled.length && failures > 0 ? "error" : "ok", lastPollAt: now() })
    }).pipe(polling.withPermits(1))

    const findAlert = (alertId: string) =>
      Effect.gen(function* () {
        const alert = yield* store.getAlert(alertId)
        if (alert === undefined) return yield* new NotFound({ message: "unknown alert" })
        return alert
      })

    const investigate = Effect.fn("AlertPipeline.investigate")(function* (alertId: string) {
      const alert = yield* findAlert(alertId)
      if (alert.sessionId !== null) {
        const session = yield* store.getSession(alert.sessionId)
        if (session !== undefined && isActive(session)) return
      }
      yield* queue.removeWhere((a) => a.alertId === alertId && a.kind === "investigate")
      // You asked for it: claimed even if a teammate is on it too.
      yield* claims.take(alert, { yieldTo: false })
      yield* runner.enqueue(alert)
    })

    const feedback = Effect.fn("AlertPipeline.feedback")(function* (alertId: string, label: "good" | "bad") {
      yield* findAlert(alertId)
      yield* store.modifyAlert(alertId, (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              feedback: label,
              events: [...current.events, { at: now(), text: label === "good" ? "You marked Jev's call as right" : "You marked Jev's call as wrong" }],
            },
      )
      yield* hub.notify
    })

    return { pollOnce, act, investigate, feedback }
  }),
)
