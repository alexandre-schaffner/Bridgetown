import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SlackApiError } from "../src/domain/errors.ts"
import { Hub } from "../src/hub.ts"
import { AlertPipeline, commitHorizon, readHorizon } from "../src/pipeline/alerts.ts"
import type { SlackMessage } from "../src/slack/client.ts"
import { Store } from "../src/store/store.ts"
import type { JevShape } from "../src/triage/jev.ts"
import { adminBuildFailed } from "./fixtures/messages.ts"
import { fakeSlack, makeWorld, verdict } from "./fixtures/world.ts"

const CHANNEL = "C0AUKD42N3U"
const recent = (minutesAgo: number) => (Date.now() / 1000 - minutesAgo * 60).toFixed(6)

describe("ingest: dedupe by content hash, and the horizon", () => {
  const ts = recent(5)
  const id = `${CHANNEL}:${ts}`
  let messages: Array<SlackMessage> = []
  let judged = 0
  const jev: JevShape = {
    judge: () => Effect.sync(() => void judged++).pipe(Effect.as(verdict({ actionable: 0.1, agentResolvable: 0.1 }))),
    judgeInbox: () => Effect.succeed(verdict()),
    judgeFinding: () => Effect.die("unused"),
    judgeLogPatterns: () => Effect.die("unused"),
  }
  const world = makeWorld({ jev, slack: fakeSlack((channel) => (channel === CHANNEL ? messages : [])) })
  afterAll(() => world.dispose())
  const poll = () => world.runPromise(AlertPipeline.use((pipeline) => pipeline.pollOnce))
  const stored = () => world.runPromise(Store.use((store) => Effect.all([store.getAlert(id), store.alertHash(id)])))

  test("the same message polled twice is judged once", async () => {
    messages = [{ ts, text: "API 5xx spike on /v4/opportunities", bot_id: "B1" }]
    await poll()
    await poll()
    const [alert] = await stored()
    expect(judged).toBe(1)
    expect(alert?.triage.decision).toBe("ignore")
    expect(alert?.events.map((e) => e.text)).toEqual([expect.stringContaining("Ignored by Jev")])
  })

  test("a reaction changes the hash but keeps the verdict, without a new history line", async () => {
    const [, before] = await stored()
    messages = [{ ts, text: "API 5xx spike on /v4/opportunities", bot_id: "B1", reactions: [{ name: "eyes", count: 1 }] }]
    await poll()
    const [alert, after] = await stored()
    expect(after).not.toBe(before)
    expect(judged).toBe(1)
    expect(alert?.events).toHaveLength(1)
  })

  test("a new headline is triaged again", async () => {
    messages = [{ ts, text: "API 5xx spike on /v4/opportunities and /v4/users", bot_id: "B1" }]
    await poll()
    const [alert] = await stored()
    expect(judged).toBe(2)
    expect(alert?.title).toContain("/v4/users")
  })

  test("an unknown message older than the horizon is not news", async () => {
    const old = recent(4 * 60)
    messages = [{ ts: old, text: "Old outage", bot_id: "B1" }]
    await poll()
    expect(await world.runPromise(Store.use((store) => store.getAlert(`${CHANNEL}:${old}`)))).toBeUndefined()
    expect(judged).toBe(2)
  })

  test("people's messages and thread replies are not alerts", async () => {
    const human = recent(2)
    const reply = recent(1)
    messages = [
      { ts: human, text: "is prod down?", user: "U2" },
      { ts: reply, text: "bot reply", bot_id: "B1", thread_ts: ts },
    ]
    await poll()
    const found = await world.runPromise(Store.use((store) => Effect.all([store.getAlert(`${CHANNEL}:${human}`), store.getAlert(`${CHANNEL}:${reply}`)])))
    expect(found).toEqual([undefined, undefined])
  })

  test("horizon: never further back than the lookback; a successful read moves it to its start minus a margin", async () => {
    const out = await world.runPromise(
      Store.use((store) =>
        Effect.gen(function* () {
          const fromNothing = yield* readHorizon(store, "since:test")
          yield* commitHorizon(store, "since:test", fromNothing, Date.now())
          const written = Number(yield* store.getKv("since:test"))
          const recentSince = Date.now() - 60_000
          yield* store.setKv("since:test", String(recentSince))
          const fromRecent = yield* readHorizon(store, "since:test")
          return { fromNothing, written, recentSince, fromRecent }
        }),
      ),
    )
    const now = Date.now()
    expect(Math.abs(out.fromNothing - (now - 3 * 60 * 60_000))).toBeLessThan(5_000)
    expect(Math.abs(out.written - (now - 30 * 60_000))).toBeLessThan(5_000)
    expect(out.fromRecent).toBe(out.recentSince)
  })
})

describe("the horizon only moves past what was read", () => {
  let down = false
  let messages: Array<SlackMessage> = []
  const backlogAsks: Array<string | undefined> = []
  const world = makeWorld({
    slack: {
      ...fakeSlack(() => []),
      latest: (channel, limit, oldest, latest) => {
        if (channel !== CHANNEL) return Effect.succeed([])
        if (down) return Effect.fail(new SlackApiError({ method: "conversations.history", code: "ratelimited", message: "ratelimited" }))
        if (latest === undefined) return Effect.succeed(messages.slice(0, limit))
        backlogAsks.push(oldest)
        return Effect.succeed(messages.filter((m) => Number(m.ts) <= Number(latest) && Number(m.ts) >= Number(oldest)).slice(0, limit))
      },
    },
  })
  afterAll(() => world.dispose())
  const poll = () => world.runPromise(AlertPipeline.use((pipeline) => pipeline.pollOnce))
  const stored = (ts: string) => world.runPromise(Store.use((store) => store.getAlert(`${CHANNEL}:${ts}`)))
  const error = () => world.runPromise(Hub.use((hub) => hub.status.pipe(Effect.map((s) => s.error))))
  const key = `since:${CHANNEL}`

  test("an alert posted while Slack could not be read is still news once it can", async () => {
    const lastGood = Date.now() - 61 * 60_000
    await world.runPromise(Store.use((store) => store.setKv(key, String(lastGood))))
    down = true
    await poll()
    expect(Number(await world.runPromise(Store.use((store) => store.getKv(key))))).toBe(lastGood)
    expect(await error()).toBe("Slack #alert-releases: ratelimited")
    down = false
    const during = recent(50)
    messages = [{ ts: during, text: "[RESOLVED] posted during the outage", bot_id: "B1" }]
    await poll()
    expect(await stored(during)).toBeDefined()
    // Read again: the problem no longer stands.
    expect(await error()).toBeNull()
  })

  test("more than a page since the horizon: the poll reads back to it instead of skipping the older ones", async () => {
    messages = Array.from({ length: 20 }, (_, i) => ({ ts: recent(10 + i), text: `[RESOLVED] burst ${i}`, bot_id: "B1" }))
    await world.runPromise(Store.use((store) => store.setKv(key, String(Date.now() - 40 * 60_000))))
    await poll()
    const found = await Promise.all(messages.map((m) => stored(m.ts)))
    expect(found.filter((a) => a === undefined)).toHaveLength(0)
    expect(backlogAsks).toHaveLength(1)
  })
})

describe("a known alert re-triaged to nothing to do", () => {
  const ts = recent(5)
  let tracker: SlackMessage = { ...adminBuildFailed, ts }
  const world = makeWorld({ slack: fakeSlack((channel) => (channel === CHANNEL ? [tracker] : [])) })
  afterAll(() => world.dispose())

  test("a failed build re-run green withdraws the card it had put up", async () => {
    const cards = () => world.runPromise(Store.use((store) => store.listActions().pipe(Effect.map((all) => all.map((a) => a.kind)))))
    await world.runPromise(AlertPipeline.use((pipeline) => pipeline.pollOnce))
    // Without Jev the call is yours: a suggestion.
    expect(await cards()).toEqual(["investigate"])
    tracker = {
      ...tracker,
      blocks: JSON.parse(JSON.stringify(adminBuildFailed.blocks).replace(":red_circle:  *Build*\\nBuild failed  ·  _1 attempt failed_", ":large_green_circle:  *Build*\\nImage built")),
    }
    await world.runPromise(AlertPipeline.use((pipeline) => pipeline.pollOnce))
    const alert = await world.runPromise(Store.use((store) => store.getAlert(`${CHANNEL}:${ts}`)))
    expect(await cards()).toEqual([])
    expect(alert?.title).toBe("merkl-admin v0.6.0 · Deployed")
    expect(alert?.events.at(-1)?.text).toBe("Its card was withdrawn: Release deployed successfully")
    expect(alert?.disposition?.kind).toBe("withdrawn")
  })
})
