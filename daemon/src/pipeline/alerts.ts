import { Context, Effect, Layer, Semaphore } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { alertFromParsed, type ParsedAlert } from "../domain/alert.ts"
import { daysAgo, now, tsToIso } from "../domain/ids.ts"
import { type Alert, type Channel, claimHeadline } from "../domain/model.ts"
import { Hub, problemOf } from "../hub.ts"
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
import { applyRules, type RuleOutcome } from "../triage/rules.ts"
import { triageWith } from "../triage/verdict.ts"
import { Intake, routeOf } from "./intake.ts"

/** Alert channels: poll, parse, and file what is new (`Intake`); a known alert keeps its verdict unless its headline changed. */
export interface AlertPipelineShape {
  /** One Slack poll of the alert channels, serialized with the poll loop. */
  readonly pollOnce: Effect.Effect<void, SlackError>
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
    const intake = yield* Intake
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
      const thread =
        (message.reply_count ?? 0) === 0
          ? []
          : yield* slack.replies(channel.id, message.ts).pipe(Effect.orElseSucceed((): ReadonlyArray<SlackMessage> => []))
      const claimedBy = yield* claims.read(message.reactions, thread)

      // A known alert whose headline did not change (a reaction, a reply count) keeps its verdict.
      if (existing !== undefined && (existing.title === parsed.title || existing.sessionId !== null)) {
        const newcomers = claimedBy.filter((c) => !existing.claimedBy.some((e) => e.userId === c.userId))
        // Re-read under the row's lock: a session you started meanwhile keeps its place, and history is appended to.
        const alert = yield* store.modifyAlert(
          id,
          (current) =>
            alertFromParsed(parsed, {
              permalink,
              receivedAt: current?.receivedAt ?? tsToIso(message.ts),
              triage: current?.triage ?? existing.triage,
              sessionId: current?.sessionId ?? null,
              events: [...(current?.events ?? []), ...(existing.title === parsed.title ? [] : [{ at: now(), text: `Updated in Slack: ${parsed.title}` }])],
              feedback: current?.feedback ?? null,
              disposition: current?.disposition ?? null,
              claimedBy,
            }),
          hash,
        )
        if (alert !== undefined && newcomers.length > 0) {
          // A card asking you to start an agent is stale once someone else is on it.
          if (alert.sessionId === null) yield* queue.removeWhere((a) => a.kind === "investigate" && a.alertId === id)
          yield* store.appendAlertEvent(id, `In Slack: ${claimHeadline(newcomers)}`)
        }
        if (alert !== undefined) yield* shipper.trackDeploy(alert)
        return yield* hub.notify
      }

      const history = (yield* store.alertsByFingerprint(parsed.fingerprint, daysAgo(7))).filter((a) => a.id !== id)
      const active = yield* store.activeSessions()
      const releaseTag = parsed.fields._tag === "release" ? parsed.fields.tag : null
      const shipping = releaseTag === null ? undefined : active.find((s) => followsDeploy(s, releaseTag))
      const rule: RuleOutcome =
        shipping !== undefined
          ? { _tag: "Attach", sessionId: shipping.id, reason: `Release cut by session ${shipping.id}` }
          : applyRules(parsed, { activeSessions: active, sameFingerprint: history, claimedBy })
      const route = routeOf(rule, `Alert repeated: ${parsed.title}`, triage(parsed, message, thread, history))
      const alert = yield* intake.file(parsed, { permalink, receivedAt: tsToIso(message.ts), contentHash: hash, claimedBy }, route)
      if (alert !== undefined) yield* shipper.trackDeploy(alert)
    })

    /**
     * The trackers of deploys in flight, read on their own. A tracker is edited in place for hours, long after newer
     * posts pushed it out of the channel's newest messages. `seen`: the messages this poll already read.
     */
    const refreshTrackers = (seen: ReadonlySet<string>, problems: Array<string>) =>
      Effect.gen(function* () {
        for (const session of yield* store.activeSessions()) {
          const tracker = session.tracker?.id
          if (tracker === undefined || seen.has(tracker) || session.releaseTag === null || !followsDeploy(session, session.releaseTag)) continue
          const alert = yield* store.getAlert(tracker)
          if (alert === undefined) continue
          const channel = { id: alert.channelId, name: alert.channelName, enabled: true }
          // `oldest` and `latest` are both inclusive: exactly that message.
          yield* slack.latest(alert.channelId, 1, alert.ts, alert.ts).pipe(
            Effect.flatMap(([message]) => (message === undefined ? Effect.void : ingest(channel, message, 0))),
            Effect.catch((error) => Effect.sync(() => void problems.push(`#${channel.name} tracker: ${error.message}`))),
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
      const problems: Array<string> = []
      let failures = 0
      for (const channel of enabled) {
        // One horizon per channel: a channel Slack would not serve keeps its own until it does.
        const key = `since:${channel.id}`
        const since = yield* readHorizon(store, key)
        const readAt = Date.now()
        const read = yield* postsSince(channel, since).pipe(Effect.result)
        if (read._tag === "Failure") {
          failures += 1
          problems.push(`Slack #${channel.name}: ${read.failure.message}`)
          continue
        }
        for (const message of [...read.success].reverse()) {
          seen.add(`${channel.id}:${message.ts}`)
          yield* ingest(channel, message, since).pipe(Effect.catch((error) => Effect.sync(() => void problems.push(`#${channel.name}: ${error.message}`))))
        }
        yield* commitHorizon(store, key, since, readAt)
      }
      yield* refreshTrackers(seen, problems)
      yield* hub.patchStatus({ slack: failures === enabled.length && failures > 0 ? "error" : "ok", lastPollAt: now() })
      yield* hub.problem("poll", problemOf(problems))
    }).pipe(polling.withPermits(1))

    return { pollOnce }
  }),
)
