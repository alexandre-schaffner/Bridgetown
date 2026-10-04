import { Context, Effect, Layer } from "effect"
import { type Alert, type Claimant, threadTsOf } from "../domain/model.ts"
import * as Messages from "../ship/messages.ts"
import { SlackClient, type SlackMessage, type SlackReaction } from "./client.ts"
import { SlackMe } from "./me.ts"
import { BOT_PREFIX, firstLine, plain, truncate } from "./text.ts"
import { SlackThread } from "./thread.ts"

/**
 * Who is on an alert, for a team where several people run Bridgetown. Slack is
 * the only thing every copy reads, so the alert's thread is the record: a
 * `🤖 Investigating with Bridgetown…` post claims it for its author, and a 👀
 * reaction claims it for whoever reacted. The earliest claim post wins.
 */
export interface ClaimsShape {
  /** Teammates on the alert per its reactions and thread replies, first claim first, never you. */
  readonly read: (reactions: ReadonlyArray<SlackReaction> | undefined, replies: ReadonlyArray<SlackMessage>) => Effect.Effect<ReadonlyArray<Claimant>>
  /**
   * Posts the claim in the alert's thread before an agent starts on it. With
   * `yieldTo`, a teammate who is already on it (per the thread now, or the 👀
   * seen at the last poll) wins and nothing is posted; and when two copies
   * claim at once, the later post is deleted and its author steps back.
   * Inbox items are yours alone: nothing to claim.
   */
  readonly take: (alert: Alert, options: { readonly yieldTo: boolean }) => Effect.Effect<Take>
}

export class Claims extends Context.Service<Claims, ClaimsShape>()("Claims") {}

export type Take = { readonly _tag: "Taken" } | { readonly _tag: "TakenBy"; readonly claimedBy: ReadonlyArray<Claimant> }

const CLAIM_PREFIX = `${BOT_PREFIX} ${Messages.investigating.replace(/…$/, "")}`
const LATEST_MAX = 160

/** Posted as a person (a user token), never by an app or a bot. */
const byPerson = (message: SlackMessage): message is SlackMessage & { readonly user: string } =>
  message.user !== undefined && message.bot_id === undefined

const isClaimPost = (message: SlackMessage): boolean => byPerson(message) && (message.text ?? "").trimStart().startsWith(CLAIM_PREFIX)

/** Who posted the first claim in the thread, whoever it is. */
export const firstClaimant = (replies: ReadonlyArray<SlackMessage>): string | undefined =>
  [...replies].filter(isClaimPost).sort((a, b) => Number(a.ts) - Number(b.ts))[0]?.user

/** A user's latest 🤖 post in the thread, readable and on one line. */
const latestPostOf = (replies: ReadonlyArray<SlackMessage>, userId: string): string | null => {
  const post = [...replies]
    .filter((m) => byPerson(m) && m.user === userId && (m.text ?? "").trimStart().startsWith(BOT_PREFIX))
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0]
  if (post === undefined) return null
  return truncate(firstLine(plain(post.text ?? "").trimStart().slice(BOT_PREFIX.length)), LATEST_MAX)
}

/** Claimants without names: claim posts in order, then 👀 reactors not already counted. You are left out. */
export const claimsIn = (
  reactions: ReadonlyArray<SlackReaction> | undefined,
  replies: ReadonlyArray<SlackMessage>,
  me: string | undefined,
): ReadonlyArray<Omit<Claimant, "name">> => {
  const out: Array<Omit<Claimant, "name">> = []
  const seen = new Set(me === undefined ? [] : [me])
  for (const post of [...replies].filter(isClaimPost).sort((a, b) => Number(a.ts) - Number(b.ts))) {
    const userId = post.user ?? ""
    if (seen.has(userId)) continue
    seen.add(userId)
    out.push({ userId, via: "agent", latest: latestPostOf(replies, userId) })
  }
  for (const reaction of reactions ?? []) {
    if (reaction.name !== "eyes") continue
    for (const userId of reaction.users ?? []) {
      if (seen.has(userId)) continue
      seen.add(userId)
      out.push({ userId, via: "eyes", latest: null })
    }
  }
  return out
}

export const ClaimsLive = Layer.effect(Claims)(
  Effect.gen(function* () {
    const slack = yield* SlackClient
    const thread = yield* SlackThread
    const me = yield* SlackMe

    const named = (claims: ReadonlyArray<Omit<Claimant, "name">>) =>
      Effect.forEach(claims, (claim) => me.nameOf(claim.userId).pipe(Effect.map((name): Claimant => ({ ...claim, name }))))

    const read: ClaimsShape["read"] = (reactions, replies) =>
      Effect.gen(function* () {
        return yield* named(claimsIn(reactions, replies, (yield* me.known)?.user_id))
      })

    const repliesOf = (alert: Alert) =>
      slack.replies(alert.channelId, threadTsOf(alert)).pipe(Effect.orElseSucceed((): ReadonlyArray<SlackMessage> => []))

    /** The 👀 seen at the last poll, as reactions again, so `read` treats them like fresh ones. */
    const eyesOf = (alert: Alert): ReadonlyArray<SlackReaction> => {
      const users = alert.claimedBy.filter((c) => c.via === "eyes").map((c) => c.userId)
      return users.length === 0 ? [] : [{ name: "eyes", count: users.length, users }]
    }

    const take: ClaimsShape["take"] = (alert, { yieldTo }) =>
      Effect.gen(function* () {
        const taken: Take = { _tag: "Taken" }
        // Inbox items are yours alone; the prod watcher's findings have no Slack thread to claim in.
        if (alert.fields._tag === "inbox" || alert.source === "watch") return taken
        if (yieldTo) {
          const already = yield* read(eyesOf(alert), yield* repliesOf(alert))
          if (already.length > 0) return { _tag: "TakenBy", claimedBy: already } satisfies Take
        }
        const posted = yield* thread.post(alert, Messages.investigating)
        if (!yieldTo || posted._tag === "NotPosted") return taken
        // Two copies can both find the thread empty and post. Both read it back; the earlier post wins.
        const after = yield* repliesOf(alert)
        const first = firstClaimant(after)
        const mine = (yield* me.known)?.user_id
        if (first === undefined || mine === undefined || first === mine) return taken
        yield* slack.remove(alert.channelId, posted.ts).pipe(Effect.ignore)
        return { _tag: "TakenBy", claimedBy: yield* read(eyesOf(alert), after.filter((m) => m.ts !== posted.ts)) } satisfies Take
      })

    return { read, take }
  }),
)
