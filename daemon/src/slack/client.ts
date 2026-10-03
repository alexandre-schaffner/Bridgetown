import { Context, Data, Effect, Layer, Schedule, Schema } from "effect"
import { type AdapterError, attempt, decodeOr, MissingCredential, SlackApiError } from "../domain/errors.ts"

export const SlackReaction = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
  users: Schema.optional(Schema.Array(Schema.String)),
})

export const SlackMessage = Schema.Struct({
  ts: Schema.String,
  text: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  thread_ts: Schema.optional(Schema.String),
  reply_count: Schema.optional(Schema.Number),
  blocks: Schema.optional(Schema.Unknown),
  attachments: Schema.optional(Schema.Unknown),
  reactions: Schema.optional(Schema.Array(SlackReaction)),
  edited: Schema.optional(Schema.Struct({ ts: Schema.String })),
  bot_profile: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
})
export type SlackMessage = typeof SlackMessage.Type

export const SearchMatch = Schema.Struct({
  ts: Schema.String,
  text: Schema.optional(Schema.String),
  user: Schema.optional(Schema.NullOr(Schema.String)),
  username: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.NullOr(Schema.String)),
  permalink: Schema.optional(Schema.String),
  blocks: Schema.optional(Schema.Unknown),
  attachments: Schema.optional(Schema.Unknown),
  channel: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    is_im: Schema.optional(Schema.Boolean),
    is_mpim: Schema.optional(Schema.Boolean),
  }),
})
export type SearchMatch = typeof SearchMatch.Type

const Search = Schema.Struct({ messages: Schema.Struct({ matches: Schema.Array(SearchMatch) }) })

const UserGroups = Schema.Struct({
  usergroups: Schema.Array(Schema.Struct({ id: Schema.String, handle: Schema.String, users: Schema.optional(Schema.Array(Schema.String)) })),
})

const UserInfo = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    real_name: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.Struct({ display_name: Schema.optional(Schema.String) })),
  }),
})

const Envelope = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) })

const History = Schema.Struct({ messages: Schema.Array(SlackMessage) })
const Permalink = Schema.Struct({ permalink: Schema.String })
const Posted = Schema.Struct({ ts: Schema.String })
const AuthTest = Schema.Struct({ user_id: Schema.String, user: Schema.String, url: Schema.String })
export type SlackIdentity = typeof AuthTest.Type

/** What a Slack call can fail with: no token, Slack saying no (`SlackApiError.code`), or the network / an unreadable body. */
export type SlackError = MissingCredential | SlackApiError | AdapterError

export interface SlackClientShape {
  readonly identity: () => Effect.Effect<SlackIdentity, SlackError>
  readonly latest: (channel: string, limit: number, oldest?: string, latest?: string) => Effect.Effect<ReadonlyArray<SlackMessage>, SlackError>
  readonly replies: (channel: string, ts: string) => Effect.Effect<ReadonlyArray<SlackMessage>, SlackError>
  readonly permalink: (channel: string, ts: string) => Effect.Effect<string, SlackError>
  /** `search.messages`, newest first. Needs the `search:read` user scope. */
  readonly search: (query: string, count: number) => Effect.Effect<ReadonlyArray<SearchMatch>, SlackError>
  /** Ids of the user groups `userId` belongs to. Needs `usergroups:read`. */
  readonly groupsOf: (userId: string) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly handle: string }>, SlackError>
  readonly userName: (userId: string) => Effect.Effect<string, SlackError>
  readonly post: (channel: string, threadTs: string | undefined, text: string) => Effect.Effect<string, SlackError>
}

export class SlackClient extends Context.Service<SlackClient, SlackClientShape>()("SlackClient") {}

const BASE = "https://slack.com/api"
const MAX_RATE_LIMIT_WAIT_MS = 60_000
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000
/** Retries after the first 429; then the call fails with `ratelimited`. */
const RATE_LIMIT_RETRIES = 2
const REQUEST_TIMEOUT_MS = 30_000

/** A 429: Slack says how long to wait in `retry-after` (seconds). */
export class RateLimited extends Data.TaggedError("RateLimited")<{ readonly method: string; readonly waitMs: number }> {}

/** `retry-after` in milliseconds, capped so one call never stalls a loop for long; unreadable means the default. */
export const retryAfterMs = (header: string | null): number => {
  const seconds = Number(header ?? Number.NaN)
  const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_WAIT_MS
  return Math.min(wait, MAX_RATE_LIMIT_WAIT_MS)
}

/** Waits what each 429 asked for, `RATE_LIMIT_RETRIES` times. */
export const rateLimitSchedule = Schedule.recurs(RATE_LIMIT_RETRIES).pipe(
  Schedule.setInputType<RateLimited | AdapterError>(),
  Schedule.modifyDelay(({ input }) => Effect.succeed(input._tag === "RateLimited" ? input.waitMs : 0)),
)

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const makeSlackClient = (token: string | undefined, fetchImpl: Fetch = fetch): SlackClientShape => {
  const call = Effect.fn("SlackClient.call")(function* (method: string, params: Record<string, string | number | boolean>, post = false) {
    if (token === undefined || token === "") return yield* new MissingCredential({ service: "slack", message: "no Slack token" })
    const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))
    const once = attempt("slack", method, () =>
      post
        ? fetchImpl(`${BASE}/${method}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
        : fetchImpl(`${BASE}/${method}?${query}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 429 ? Effect.fail(new RateLimited({ method, waitMs: retryAfterMs(response.headers.get("retry-after")) })) : Effect.succeed(response),
      ),
    )
    const response = yield* once.pipe(
      Effect.retry({ schedule: rateLimitSchedule, while: (error) => error._tag === "RateLimited" }),
      Effect.catchTag("RateLimited", () => Effect.fail(new SlackApiError({ method, code: "ratelimited", message: "ratelimited (HTTP 429)" }))),
    )
    if (!response.ok) return yield* new SlackApiError({ method, code: `http_${response.status}`, message: `HTTP ${response.status}` })
    const body = yield* attempt("slack", method, (): Promise<unknown> => response.json())
    const envelope = yield* decodeOr("slack", method, Envelope)(body)
    if (!envelope.ok) {
      const code = envelope.error ?? "unknown_error"
      return yield* new SlackApiError({ method, code, message: code })
    }
    return body
  })

  return {
    identity: () => call("auth.test", {}).pipe(Effect.flatMap(decodeOr("slack", "auth.test", AuthTest))),
    latest: (channel, limit, oldest, latest) =>
      call("conversations.history", {
        channel,
        limit,
        ...(oldest === undefined ? {} : { oldest }),
        ...(latest === undefined ? {} : { latest, inclusive: true }),
      }).pipe(
        Effect.flatMap(decodeOr("slack", "conversations.history", History)),
        Effect.map((h) => h.messages),
      ),
    replies: (channel, ts) =>
      call("conversations.replies", { channel, ts, limit: 200 }).pipe(
        Effect.flatMap(decodeOr("slack", "conversations.replies", History)),
        Effect.map((h) => h.messages.filter((m) => m.ts !== ts)),
      ),
    permalink: (channel, ts) =>
      call("chat.getPermalink", { channel, message_ts: ts }).pipe(
        Effect.flatMap(decodeOr("slack", "chat.getPermalink", Permalink)),
        Effect.map((p) => p.permalink),
      ),
    search: (query, count) =>
      call("search.messages", { query, count, sort: "timestamp", sort_dir: "desc" }).pipe(
        Effect.flatMap(decodeOr("slack", "search.messages", Search)),
        Effect.map((s) => s.messages.matches),
      ),
    groupsOf: (userId) =>
      call("usergroups.list", { include_users: true }).pipe(
        Effect.flatMap(decodeOr("slack", "usergroups.list", UserGroups)),
        Effect.map((g) => g.usergroups.filter((group) => (group.users ?? []).includes(userId)).map(({ id, handle }) => ({ id, handle }))),
      ),
    userName: (userId) =>
      call("users.info", { user: userId }).pipe(
        Effect.flatMap(decodeOr("slack", "users.info", UserInfo)),
        Effect.map((u) => u.user.profile?.display_name || u.user.real_name || u.user.name),
      ),
    post: (channel, threadTs, text) =>
      call("chat.postMessage", { channel, text, unfurl_links: false, ...(threadTs === undefined ? {} : { thread_ts: threadTs }) }, true).pipe(
        Effect.flatMap(decodeOr("slack", "chat.postMessage", Posted)),
        Effect.map((p) => p.ts),
      ),
  }
}

export const SlackClientLive = (token: string | undefined) => Layer.succeed(SlackClient)(makeSlackClient(token))
