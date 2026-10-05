import { Context, Effect, Layer } from "effect"
import { type Alert, threadTsOf } from "../domain/model.ts"
import { Hub } from "../hub.ts"
import { SlackClient } from "./client.ts"
import { BOT_PREFIX, flattenMessage, plain } from "./text.ts"

export interface SlackThreadShape {
  /** Posts `🤖 <text>` in the alert's thread as the user. Never fails; a no-op in dry-run. Says whether it went out. */
  readonly post: (alert: Alert, text: string) => Effect.Effect<ThreadPost>
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
    return {
      post: (alert, text) =>
        Effect.gen(function* () {
          // The prod watcher's findings have no Slack message to reply under.
          if (alert.source === "watch") return { _tag: "NotPosted", reason: "no_thread" } satisfies ThreadPost
          if (yield* hub.dryRun) {
            yield* Effect.logInfo(`[dry-run] would post in ${alert.channelName}/${alert.ts}: ${text}`)
            const skipped: ThreadPost = { _tag: "NotPosted", reason: "dry_run" }
            return skipped
          }
          const ts = yield* slack.post(alert.channelId, threadTsOf(alert), `${BOT_PREFIX} ${text}`)
          yield* hub.problem("post", null)
          const posted: ThreadPost = { _tag: "Posted", ts }
          return posted
        }).pipe(
          Effect.catch((error) =>
            hub.problem("post", `Slack post failed: ${error.message}`).pipe(Effect.as<ThreadPost>({ _tag: "NotPosted", reason: "error" })),
          ),
        ),
      postChannel: (channelId, text) =>
        Effect.gen(function* () {
          if (yield* hub.dryRun) {
            yield* Effect.logInfo(`[dry-run] would post in ${channelId}: ${text}`)
            const skipped: ChannelPost = { _tag: "NotPosted", reason: "dry_run" }
            return skipped
          }
          const ts = yield* slack.post(channelId, undefined, `${BOT_PREFIX} ${text}`)
          yield* hub.problem("post", null)
          const permalink = yield* slack.permalink(channelId, ts).pipe(Effect.orElseSucceed(() => null))
          const posted: ChannelPost = { _tag: "Posted", permalink }
          return posted
        }).pipe(
          Effect.catch((error) =>
            hub.problem("post", `Slack post failed: ${error.message}`).pipe(Effect.as<ChannelPost>({ _tag: "NotPosted", reason: "error" })),
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
