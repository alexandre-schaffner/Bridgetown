import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AlertPipeline, horizon } from "../src/pipeline/alerts.ts"
import type { SlackMessage } from "../src/slack/client.ts"
import { Store } from "../src/store/store.ts"
import type { JevShape } from "../src/triage/jev.ts"
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

  test("horizon: never further back than the lookback, follows the clock minus a margin", async () => {
    const out = await world.runPromise(
      Store.use((store) =>
        Effect.gen(function* () {
          yield* store.setKv("since", "0")
          const fromNothing = yield* horizon(store, "since")
          const written = Number(yield* store.getKv("since"))
          const recentSince = Date.now() - 60_000
          yield* store.setKv("since", String(recentSince))
          const fromRecent = yield* horizon(store, "since")
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
