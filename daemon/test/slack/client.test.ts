import { describe, expect, test } from "bun:test"
import { Duration, Effect, Schedule } from "effect"
import { type Fetch, makeSlackClient, RateLimited, rateLimitSchedule, retryAfterMs } from "../../src/slack/client.ts"

const ok = (body: object) => new Response(JSON.stringify({ ok: true, ...body }), { status: 200 })
const limited = (retryAfter: string | null) =>
  new Response("", { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } })

/** Answers each call with the next response and records the URLs asked for. */
const scripted = (responses: ReadonlyArray<Response>) => {
  const urls: Array<string> = []
  const fetchImpl: Fetch = async (url) => {
    urls.push(url)
    const next = responses[urls.length - 1]
    if (next === undefined) throw new Error("no more responses")
    return next
  }
  return { urls, fetchImpl }
}

const identity = { user_id: "UME", user: "me", url: "https://merkl.slack.com/" }

describe("Slack 429 handling", () => {
  test("waits and retries, then succeeds", async () => {
    const { urls, fetchImpl } = scripted([limited("0"), limited("0"), ok(identity)])
    const found = await Effect.runPromise(makeSlackClient("xoxp", fetchImpl).identity())
    expect(found).toEqual(identity)
    expect(urls).toHaveLength(3)
  })

  test("gives up after the retries with SlackApiError ratelimited", async () => {
    const { urls, fetchImpl } = scripted([limited("0"), limited("0"), limited("0"), ok(identity)])
    const error = await Effect.runPromise(makeSlackClient("xoxp", fetchImpl).identity().pipe(Effect.flip))
    expect(error).toMatchObject({ _tag: "SlackApiError", method: "auth.test", code: "ratelimited" })
    expect(urls).toHaveLength(3)
  })

  test("retry-after is honoured, capped, and defaults when unreadable", () => {
    expect(retryAfterMs("2")).toBe(2_000)
    expect(retryAfterMs("0")).toBe(0)
    expect(retryAfterMs("3600")).toBe(60_000)
    expect(retryAfterMs(null)).toBe(5_000)
    expect(retryAfterMs("soon")).toBe(5_000)
  })

  test("the schedule waits exactly what each 429 asked for", async () => {
    const delays = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(rateLimitSchedule)
        const first = yield* step(0, new RateLimited({ method: "m", waitMs: 2_000 }))
        const second = yield* step(0, new RateLimited({ method: "m", waitMs: 7_000 }))
        return [Duration.toMillis(first[1]), Duration.toMillis(second[1])]
      }),
    )
    expect(delays).toEqual([2_000, 7_000])
  })
})

describe("Slack errors are typed", () => {
  test("no token is MissingCredential, without a request", async () => {
    const { urls, fetchImpl } = scripted([])
    const error = await Effect.runPromise(makeSlackClient("", fetchImpl).identity().pipe(Effect.flip))
    expect(error._tag).toBe("MissingCredential")
    expect(urls).toHaveLength(0)
  })

  test("ok: false carries Slack's code; an HTTP error its status", async () => {
    const refused = scripted([new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))])
    expect(await Effect.runPromise(makeSlackClient("xoxp", refused.fetchImpl).latest("C1", 10).pipe(Effect.flip))).toMatchObject({
      _tag: "SlackApiError",
      method: "conversations.history",
      code: "channel_not_found",
    })
    const broken = scripted([new Response("", { status: 502 })])
    expect(await Effect.runPromise(makeSlackClient("xoxp", broken.fetchImpl).latest("C1", 10).pipe(Effect.flip))).toMatchObject({
      _tag: "SlackApiError",
      code: "http_502",
    })
  })
})
