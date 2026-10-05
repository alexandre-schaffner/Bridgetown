import { Context, Effect, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { alertFromParsed, type ParsedAlert } from "../domain/alert.ts"
import type { AdapterError } from "../domain/errors.ts"
import { now, tsToIso } from "../domain/ids.ts"
import { type Alert, type Session, triageEvent } from "../domain/model.ts"
import { Hub } from "../hub.ts"
import { followUpPrompt } from "../sessions/prompts.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { revvLink } from "../ship/review.ts"
import { type SearchMatch, SlackClient, type SlackMessage } from "../slack/client.ts"
import { type InboxVia, inboxQueries, parseInbox } from "../slack/inbox.ts"
import { SlackMe } from "../slack/me.ts"
import { toThreadReplies } from "../slack/text.ts"
import { Store } from "../store/store.ts"
import { Jev } from "../triage/jev.ts"
import { decideInbox } from "../triage/policy.ts"
import { triageWith } from "../triage/verdict.ts"
import { AlertPipeline, commitHorizon, readHorizon } from "./alerts.ts"

/** Mentions, group mentions and DMs anywhere in Slack, including what people write in alert channels. */
export interface InboxShape {
  readonly poll: Effect.Effect<void, AdapterError>
}

export class Inbox extends Context.Service<Inbox, InboxShape>()("Inbox") {}

const SEARCH_COUNT = 20
const INBOX_HORIZON = "inbox_since"

export const InboxLive = Layer.effect(Inbox)(
  Effect.gen(function* () {
    const store = yield* Store
    const hub = yield* Hub
    const slack = yield* SlackClient
    const me = yield* SlackMe
    const jev = yield* Jev
    const repo = yield* SessionRepo
    const runner = yield* SessionRunner
    const queue = yield* ActionQueue
    const alerts = yield* AlertPipeline

    const escalate = (alert: Alert) => {
      const prUrl = alert.fields._tag === "inbox" ? alert.fields.prUrl : null
      const revv = prUrl === null ? null : revvLink(prUrl)
      return queue.put({
        kind: "escalate",
        title: alert.title,
        detail: alert.triage.reason,
        primaryLabel: revv === null ? "Open in Slack" : "Open in Revv",
        options: [],
        sessionId: null,
        alertId: alert.id,
        payload: alert.fingerprint,
        url: revv ?? alert.permalink,
      })
    }

    /** The active session handling this thread: one started from the same thread, or from the alert the thread hangs off. */
    const ownerOf = (parsed: ParsedAlert, threadTs: string) =>
      Effect.gen(function* () {
        const parentId = `${parsed.channelId}:${threadTs}`
        for (const session of yield* store.activeSessions()) {
          if (session.alertId === parentId) return session
          const owned = yield* store.getAlert(session.alertId)
          if (owned?.fingerprint === parsed.fingerprint) return session
        }
        return undefined
      })

    const followUp = (parsed: ParsedAlert, match: SearchMatch, owner: Session, fromName: string) =>
      Effect.gen(function* () {
        yield* store.putAlert(
          alertFromParsed(parsed, {
            permalink: match.permalink ?? null,
            receivedAt: tsToIso(parsed.ts),
            triage: { decision: "filtered", reason: "Follow-up in a thread an agent is handling", jev: null },
            sessionId: owner.id,
            events: [{ at: now(), text: `Follow-up in a thread session ${owner.id} is handling` }],
          }),
        )
        yield* repo.log(owner.id, "status", `${fromName} followed up in the thread`)
        // Bridgetown's own request, not yours: it never reopens a finished session, and `acceptsMessages` decides.
        const delivery = yield* runner.continueWith(owner.id, followUpPrompt(fromName, parsed.raw))
        if (delivery === "refused") yield* repo.log(owner.id, "status", "The agent cannot take the follow-up right now")
      })

    const ingest = Effect.fn("Inbox.ingest")(function* (match: SearchMatch, via: InboxVia, since: number, alertChannels: ReadonlySet<string>) {
      const identity = yield* me.known
      if (identity === undefined || Number(match.ts) * 1000 < since) return
      const id = `${match.channel.id}:${match.ts}`
      if ((yield* store.getAlert(id)) !== undefined) return
      const fromName = match.user === undefined || match.user === null ? (match.username ?? "Someone") : yield* me.nameOf(match.user)
      const parsed = parseInbox(match, via, { me: identity.user_id, fromName, alertChannels })
      if (parsed === undefined) return
      const threadTs = parsed.fields._tag === "inbox" ? (parsed.fields.threadTs ?? parsed.ts) : parsed.ts
      const owner = yield* ownerOf(parsed, threadTs)
      if (owner !== undefined) {
        yield* followUp(parsed, match, owner, fromName)
        return yield* hub.notify
      }
      const replies = yield* slack.replies(parsed.channelId, threadTs).pipe(Effect.orElseSucceed((): ReadonlyArray<SlackMessage> => []))
      const judging = jev.judgeInbox({ item: parsed, thread: toThreadReplies(replies, identity.user_id), myName: identity.user })
      const triage = yield* triageWith(hub, judging, decideInbox, "escalate")
      const alert = alertFromParsed(parsed, {
        permalink: match.permalink ?? null,
        receivedAt: tsToIso(parsed.ts),
        triage,
        sessionId: null,
        events: [{ at: now(), text: triageEvent(triage) }],
      })
      yield* store.putAlert(alert)
      yield* queue.removeWhere((a) => a.payload === alert.fingerprint && a.kind !== "reply")
      if (triage.decision === "escalate") yield* escalate(alert)
      else yield* alerts.act(alert)
      yield* hub.notify
    })

    return {
      poll: Effect.gen(function* () {
        const identity = yield* me.known
        if ((yield* hub.status).slack !== "ok" || identity === undefined) return
        const settings = yield* hub.settings
        if (!settings.inbox) return
        const since = yield* readHorizon(store, INBOX_HORIZON)
        const readAt = Date.now()
        const alertChannels = new Set(settings.channels.filter((c) => c.enabled).map((c) => c.id))
        let complete = true
        for (const query of inboxQueries(identity.user_id, yield* me.groups)) {
          const matches = yield* slack.search(query.query, SEARCH_COUNT).pipe(
            Effect.tapError((error) => hub.patchStatus({ error: `Slack search: ${error.message} (add the search:read scope)` })),
            Effect.orElseSucceed((): ReadonlyArray<SearchMatch> => {
              complete = false
              return []
            }),
          )
          for (const match of [...matches].reverse()) {
            yield* ingest(match, query.via, since, alertChannels).pipe(Effect.catch((error) => hub.patchStatus({ error: `Inbox: ${error.message}` })))
          }
        }
        // A search that failed leaves the horizon: its mentions are still news next time.
        if (complete) yield* commitHorizon(store, INBOX_HORIZON, since, readAt)
      }),
    }
  }),
)
