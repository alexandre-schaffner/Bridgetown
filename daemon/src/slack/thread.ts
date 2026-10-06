import { Context, Effect, Layer } from "effect"
import { type Alert, threadTsOf } from "../domain/alert.ts"
import { Hub } from "../hub.ts"
import { SlackClient } from "./client.ts"
import { BOT_PREFIX, flattenMessage, plain } from "./text.ts"

export interface SlackThreadShape {
  /** Posts `🤖 <text>` in the alert's thread as the user. Never fails; a no-op in dry-run. Says whether it went out. */
  readonly post: (alert: Alert, text: string) => Effect.Effect<ThreadPost>
  /**
   * `post` for Bridgetown's own updates (investigating, merged, released, deployed…), which nobody approved one by
   * one. An inbox item's thread is a teammate's conversation (often a DM): only a reply you sent goes there, so
   * updates are not posted in it.
   */
  readonly postUpdate: (alert: Alert, text: string) => Effect.Effect<ThreadPost>
  /** Posts `🤖 <text>` at the top of a channel; returns the message permalink. `null` in dry-run or on failure. */
  readonly postChannel: (channelId: string, text: string) => Effect.Effect<ChannelPost>
  /** Other channel messages within ±`minutes` of the alert, oldest first, readable. Best effort. */
  readonly nearby: (alert: Alert, minutes: number) => Effect.Effect<ReadonlyArray<string>>
  /** Readable thread replies, best effort. */
  readonly replies: (alert: Alert) => Effect.Effect<ReadonlyArray<string>>
}

export class SlackThread extends Context.Service<SlackThread, SlackThreadShape>()("SlackThread") {}

export type ThreadPost = { readonly _tag: "Posted"; readonly ts: string } | { readonly _tag: "NotPosted"; readonly reason: "dry_run" | "error" | "no_thread" }

export type ChannelPost =
  | { readonly _tag: "Posted"; readonly permalink: string | null }
  | { readonly _tag: "NotPosted"; readonly reason: "dry_run" | "error" }

export const SlackThreadLive = Layer.effect(SlackThread)(
  Effect.gen(function* () {
    const slack = yield* SlackClient
    const hub = yield* Hub
    /**
     * `🤖 <text>` as the user, in `channel` (under `threadTs`). Every post goes through here, so Slack posts' problem
     * is set by a failed one and cleared by one that went out, or by dry run: nothing goes out then, so none is failing.
     */
    const send = (channel: string, threadTs: string | undefined, where: string, text: string) =>
      Effect.gen(function* () {
        if (yield* hub.dryRun) {
          yield* Effect.logInfo(`[dry-run] would post in ${where}: ${text}`)
          yield* hub.problem("post", null)
          return { _tag: "NotPosted", reason: "dry_run" } as const
        }
        const ts = yield* slack.post(channel, threadTs, `${BOT_PREFIX} ${text}`)
        yield* hub.problem("post", null)
        return { _tag: "Posted", ts } as const
      }).pipe(
        Effect.catch((error) => hub.problem("post", `Slack post failed: ${error.message}`).pipe(Effect.as({ _tag: "NotPosted", reason: "error" } as const))),
      )
    const post = (alert: Alert, text: string): Effect.Effect<ThreadPost> =>
      // The prod watcher's findings have no Slack message to reply under.
      alert.source === "watch"
        ? Effect.succeed({ _tag: "NotPosted", reason: "no_thread" })
        : send(alert.channelId, threadTsOf(alert), `${alert.channelName}/${alert.ts}`, text)
    return {
      post,
      postUpdate: (alert, text) =>
        alert.fields._tag === "inbox" ? Effect.succeed<ThreadPost>({ _tag: "NotPosted", reason: "no_thread" }) : post(alert, text),
      postChannel: (channelId, text) =>
        send(channelId, undefined, channelId, text).pipe(
          Effect.flatMap(
            (sent): Effect.Effect<ChannelPost> =>
              sent._tag === "NotPosted"
                ? Effect.succeed(sent)
                : slack.permalink(channelId, sent.ts).pipe(
                    Effect.orElseSucceed(() => null),
                    Effect.map((permalink) => ({ _tag: "Posted", permalink })),
                  ),
          ),
        ),
      nearby: (alert, minutes) => {
        if (alert.source === "watch") return Effect.succeed([])
        const at = Number(alert.ts)
        return slack.latest(alert.channelId, 30, String(at - minutes * 60), String(at + minutes * 60)).pipe(
          Effect.map((messages) =>
            [...messages]
              .filter((m) => m.ts !== alert.ts)
              .reverse()
              .map((m) => {
                const when = new Date(Number(m.ts) * 1000).toISOString().slice(11, 16)
                return `[${when} UTC] ${plain(flattenMessage(m)).slice(0, 1_500)}`
              }),
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        )
      },
      replies: (alert) =>
        alert.source === "watch"
          ? Effect.succeed([])
          : slack.replies(alert.channelId, threadTsOf(alert)).pipe(
              Effect.map((messages) => messages.map((m) => plain(flattenMessage(m)))),
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            ),
    }
  }),
)
