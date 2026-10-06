import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { alertOutcome } from "../src/domain/alert-outcome.ts"
import { Hub } from "../src/hub.ts"
import { AlertPipeline } from "../src/pipeline/alerts.ts"
import { claimsIn, firstClaimant } from "../src/slack/claims.ts"
import type { SlackMessage, SlackReaction } from "../src/slack/client.ts"
import { Store } from "../src/store/store.ts"
import type { JevShape } from "../src/triage/jev.ts"
import { fakeSlack, makeWorld, verdict } from "./fixtures/world.ts"

const claim = (ts: string, user: string): SlackMessage => ({ ts, user, text: "🤖 Investigating with Bridgetown…" })

describe("claimsIn: who is on an alert, from Slack", () => {
  test("claim posts first, earliest first, then 👀; never me, never twice", () => {
    const replies: ReadonlyArray<SlackMessage> = [
      claim("3", "U3"),
      claim("2", "U2"),
      { ts: "4", user: "U2", text: "🤖 Fix PR: https://ghe/pull/7\nThe cache key was wrong" },
      claim("1", "UME"),
      { ts: "5", user: "U4", text: "looking too" },
      { ts: "6", user: "U5", bot_id: "B1", text: "🤖 Investigating with Bridgetown…" },
    ]
    const eyes: ReadonlyArray<SlackReaction> = [{ name: "eyes", count: 3, users: ["U2", "U6", "UME"] }, { name: "fire", count: 1, users: ["U7"] }]
    expect(claimsIn(eyes, replies, "UME")).toEqual([
      { userId: "U2", via: "agent", latest: "Fix PR: https://ghe/pull/7" },
      { userId: "U3", via: "agent", latest: "Investigating with Bridgetown…" },
      { userId: "U6", via: "eyes", latest: null },
    ])
    // The race is decided over everyone's posts, mine included.
    expect(firstClaimant(replies)).toBe("UME")
  })

  test("a 👀 without its users list claims nothing", () => {
    expect(claimsIn([{ name: "eyes", count: 1 }], [], "UME")).toEqual([])
  })
})

describe("teammates running Bridgetown", () => {
  const CHANNEL = "C0AUKD42N3U"
  const ts = (Date.now() / 1000 - 60).toFixed(6)
  const id = `${CHANNEL}:${ts}`
  let message: SlackMessage = { ts, text: "API 5xx spike", bot_id: "B1" }
  /** The thread as Slack has it; my posts land in it. */
  let thread: Array<SlackMessage> = []
  const posted: Array<string> = []
  const removed: Array<string> = []
  let judged = 0
  let answer = verdict()
  const jev: JevShape = {
    judge: () => Effect.sync(() => void judged++).pipe(Effect.as(answer)),
    judgeInbox: () => Effect.succeed(verdict()),
    judgeFinding: () => Effect.die("unused"),
    judgeLogPatterns: () => Effect.die("unused"),
  }
  const slack = {
    ...fakeSlack((channel) => (channel === CHANNEL ? [message] : [])),
    replies: () => Effect.sync(() => [...thread]),
    userName: (user: string) => Effect.succeed(user === "U2" ? "Alice" : user),
    post: (_channel: string, _thread: string | undefined, text: string) =>
      Effect.sync(() => {
        const at = `9.${posted.length}`
        posted.push(text)
        thread.push({ ts: at, user: "UME", text })
        return at
      }),
    remove: (_channel: string, at: string) =>
      Effect.sync(() => {
        removed.push(at)
        thread = thread.filter((m) => m.ts !== at)
      }),
  }
  const world = makeWorld({ jev, slack, dryRun: false })
  afterAll(() => world.dispose())

  const run = <A, E>(effect: Effect.Effect<A, E, Store | Hub | AlertPipeline>) => world.runPromise(effect)
  const reset = (next: SlackMessage) =>
    run(
      Effect.gen(function* () {
        const hub = yield* Hub
        yield* hub.updateSettings({ ...(yield* hub.settings), dryRun: false })
        message = next
        thread = []
        posted.length = 0
        removed.length = 0
      }),
    )
  const poll = () => run(AlertPipeline.use((pipeline) => pipeline.pollOnce))
  const state = (alertId = id) =>
    run(
      Effect.gen(function* () {
        const store = yield* Store
        const alert = yield* store.getAlert(alertId)
        const cards = (yield* store.listActions()).filter((a) => a.alertId === alertId)
        return { alert, cards }
      }),
    )

  beforeEach(() => {
    judged = 0
    answer = verdict()
  })

  test("an alert a teammate's agent took is theirs: no Jev, no agent, and their latest post shows", async () => {
    await reset({ ts, text: "API 5xx spike", bot_id: "B1", reply_count: 2 })
    thread = [claim("1.0", "U2"), { ts: "2.0", user: "U2", text: "🤖 Fix PR: https://ghe/pull/9\nRetry the RPC" }]
    await poll()
    const { alert } = await state()
    expect(judged).toBe(0)
    expect(posted).toEqual([])
    expect(alert?.sessionId).toBeNull()
    expect(alert?.triage).toMatchObject({ decision: "filtered", reason: "Alice's agent is on it" })
    expect(alert?.claimedBy).toEqual([{ userId: "U2", name: "Alice", via: "agent", latest: "Fix PR: https://ghe/pull/9" }])
    expect(alert === undefined ? null : alertOutcome(alert, undefined, 0)).toMatchObject({
      kind: "teammate",
      headline: "Alice's agent is on it",
      sentence: expect.stringContaining("Latest from Alice's agent: Fix PR: https://ghe/pull/9"),
    })
  })

  test("two copies claim at once: the later post is deleted and its agent never starts", async () => {
    const at = (Date.now() / 1000 - 50).toFixed(6)
    await reset({ ts: at, text: "Keeper stuck on Arbitrum", bot_id: "B1" })
    // Alice's copy posts between my look at the thread and my own post.
    const post = slack.post
    slack.post = (channel, threadTs, text) =>
      Effect.sync(() => void thread.push(claim("8.0", "U2"))).pipe(Effect.andThen(post(channel, threadTs, text)))
    const restore = () => {
      slack.post = post
    }
    try {
      await poll()
    } finally {
      restore()
    }
    const { alert } = await state(`${CHANNEL}:${at}`)
    expect(judged).toBe(1)
    expect(removed).toEqual(["9.0"])
    expect(alert?.sessionId).toBeNull()
    expect(alert?.claimedBy.map((c) => c.name)).toEqual(["Alice"])
    expect(alert?.events.at(-1)?.text).toBe("Left to a teammate: Alice's agent is on it")
  })

  test("the first claim wins: the agent starts and the claim stays", async () => {
    const at = (Date.now() / 1000 - 40).toFixed(6)
    await reset({ ts: at, text: "Indexer lag on Base", bot_id: "B1" })
    await poll()
    const { alert } = await state(`${CHANNEL}:${at}`)
    expect(posted).toEqual(["🤖 Investigating with Bridgetown…"])
    expect(removed).toEqual([])
    expect(alert?.sessionId).not.toBeNull()
    expect(alert?.claimedBy).toEqual([])
  })

  test("a teammate's 👀 on a suggested alert takes your card away", async () => {
    const at = (Date.now() / 1000 - 30).toFixed(6)
    answer = verdict({ actionable: 0.7, agentResolvable: 0.6 })
    await reset({ ts: at, text: "Campaign APR looks off", bot_id: "B1" })
    await poll()
    expect((await state(`${CHANNEL}:${at}`)).cards.map((c) => c.kind)).toEqual(["investigate"])
    message = { ...message, reactions: [{ name: "eyes", count: 1, users: ["U2"] }] }
    await poll()
    const { alert, cards } = await state(`${CHANNEL}:${at}`)
    expect(cards).toEqual([])
    expect(alert?.claimedBy).toEqual([{ userId: "U2", name: "Alice", via: "eyes", latest: null }])
    expect(alert?.events.at(-1)?.text).toBe("In Slack: Alice is on it")
    expect(judged).toBe(1)
  })
})
