import { Context, Effect, Layer } from "effect"
import { ActionQueue } from "../actions/queue.ts"
import { type ParsedAlert, threadTsOf } from "../domain/alert.ts"
import type { AdapterError } from "../domain/errors.ts"
import { tsToIso } from "../domain/ids.ts"
import { Hub, problemOf } from "../hub.ts"
import { followUpPrompt } from "../sessions/prompts.ts"
import { SessionRepo } from "../sessions/repo.ts"
import { SessionRunner } from "../sessions/runner.ts"
import { type SearchMatch, SlackClient } from "../slack/client.ts"
import { type InboxVia, inboxQueries, parseInbox } from "../slack/inbox-parse.ts"
import { SlackMe } from "../slack/me.ts"
import { toThreadReplies } from "../slack/text.ts"
import { SlackThread } from "../slack/thread.ts"
import { Store } from "../store/store.ts"
import { Jev } from "../jev.ts"
import { decideInbox } from "../triage/policy.ts"
import { triageWith } from "../triage/verdict.ts"
import { commitHorizon, readHorizon } from "./alerts.ts"
import { Intake } from "./intake.ts"

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
    const intake = yield* Intake
    const threads = yield* SlackThread

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

    const ingest = Effect.fn("Inbox.ingest")(function* (match: SearchMatch, via: InboxVia, since: number, alertChannels: ReadonlySet<string>) {
      const identity = yield* me.known
      if (identity === undefined || Number(match.ts) * 1000 < since) return
      const id = `${match.channel.id}:${match.ts}`
      if ((yield* store.getAlert(id)) !== undefined) return
      const fromName = match.user === undefined || match.user === null ? (match.username ?? "Someone") : yield* me.nameOf(match.user)
      const parsed = parseInbox(match, via, { me: identity.user_id, fromName, alertChannels })
      if (parsed === undefined) return
      const threadTs = threadTsOf(parsed)
      const filing = { permalink: match.permalink ?? null, receivedAt: tsToIso(parsed.ts) }
      const owner = yield* ownerOf(parsed, threadTs)
      if (owner !== undefined) {
        yield* intake.file(parsed, filing, {
          _tag: "Attach",
          sessionId: owner.id,
          reason: "Follow-up in a thread an agent is handling",
          note: `${fromName} followed up in the thread`,
        })
        // Bridgetown's own request, not yours: it never reopens a finished session, and `acceptsMessages` decides.
        const delivery = yield* runner.continueWith(owner.id, followUpPrompt(fromName, parsed.raw))
        if (delivery === "refused") yield* repo.log(owner.id, "status", "The agent cannot take the follow-up right now")
        return
      }
      const replies = toThreadReplies(yield* threads.messages(parsed), identity.user_id)
      const judging = jev.judgeInbox({ item: parsed, thread: replies, myName: identity.user })
      const triage = triageWith(hub, judging, decideInbox, "escalate").pipe(
        // A thread is one conversation: its newest message's verdict stands, so whatever an earlier one put up goes.
        Effect.tap(() => queue.removeWhere((a) => a.fingerprint === parsed.fingerprint)),
      )
      yield* intake.file(parsed, filing, { _tag: "Judge", triage })
    })

    return {
      poll: Effect.gen(function* () {
        const identity = yield* me.known
        if ((yield* hub.status).slack !== "ok" || identity === undefined) return
        const settings = yield* hub.settings
        // Turned off: whatever the inbox last ran into no longer stands.
        if (!settings.inbox) return yield* hub.problem("inbox", null)
        const since = yield* readHorizon(store, INBOX_HORIZON)
        const readAt = Date.now()
        const alertChannels = new Set(settings.channels.filter((c) => c.enabled).map((c) => c.id))
        const problems: Array<string> = []
        let complete = true
        for (const query of inboxQueries(identity.user_id, yield* me.groups)) {
          const matches = yield* slack.search(query.query, SEARCH_COUNT).pipe(
            Effect.orElseSucceed((error): ReadonlyArray<SearchMatch> => {
              complete = false
              problems.push(`Slack search: ${error.message} (add the search:read scope)`)
              return []
            }),
          )
          for (const match of [...matches].reverse()) {
            yield* ingest(match, query.via, since, alertChannels).pipe(Effect.catch((error) => Effect.sync(() => void problems.push(`Inbox: ${error.message}`))))
          }
        }
        // A search that failed leaves the horizon: its mentions are still news next time.
        if (complete) yield* commitHorizon(store, INBOX_HORIZON, since, readAt)
        yield* hub.problem("inbox", problemOf(problems))
      }),
    }
  }),
)
