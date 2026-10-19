import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { JevVerdict } from "../../src/domain/alert.ts"
import { SlackApiError } from "../../src/domain/errors.ts"
import { Hub } from "../../src/hub.ts"
import { Inbox } from "../../src/intake/inbox.ts"
import type { SearchMatch } from "../../src/slack/client.ts"
import { SlackMe } from "../../src/slack/me.ts"
import { Store } from "../../src/store/store.ts"
import { fakeJev, fakeSlack, verdict } from "../support/fakes.ts"
import { makeAlert, makeSession } from "../support/records.ts"
import { makeWorld } from "../support/world.ts"

const ME = "UME"
const ago = (minutes: number) => (Date.now() / 1000 - minutes * 60).toFixed(6)
const THREAD = ago(30)
/** Who Slack can name; anyone else is `user_not_found`. */
const NAMES = new Map([[ME, "Alexandre"], ["U2", "Pierre"], ["U3", "Hugo"]])

/** A mention of me in #eng-api's thread `THREAD`, from Pierre. */
const mention = (ts: string, text: string): SearchMatch => ({
  ts, text: `<@${ME}> ${text}`, user: "U2", channel: { id: "C9", name: "eng-api" },
  permalink: `https://merkl.slack.com/archives/C9/p${ts.replace(".", "")}?thread_ts=${THREAD}&cid=C9`,
})

/** Jev reads the message's last words: "answered", "review", "delegate" or anything else (escalate). */
const jevByText = fakeJev({
  judgeInbox: ({ item }): Effect.Effect<JevVerdict> =>
    Effect.succeed(
      item.raw.endsWith("answered")
        ? verdict({ humanOnIt: 0.9, kind: "investigation" })
        : item.raw.endsWith("delegate")
          ? verdict({ actionable: 0.95, agentResolvable: 0.9, kind: "investigation" })
          : verdict({ actionable: 0.9, agentResolvable: 0.1, kind: "decision_or_approval" }),
    ),
})

const setup = () => {
  let matches: ReadonlyArray<SearchMatch> = []
  const world = makeWorld({
    jev: jevByText,
    slack: fakeSlack({
      search: (query) => Effect.succeed(query === `<@${ME}>` ? matches : []),
      userName: (id) => {
        const name = NAMES.get(id)
        return name === undefined ? Effect.fail(new SlackApiError({ method: "users.info", code: "user_not_found", message: "user_not_found" })) : Effect.succeed(name)
      },
    }),
  })
  const poll = (next: ReadonlyArray<SearchMatch>) =>
    world.runPromise(
      Effect.gen(function* () {
        matches = next
        yield* (yield* SlackMe).identity
        yield* (yield* Inbox).poll
        const store = yield* Store
        return { cards: (yield* store.listActions()).map((a) => `${a.kind}:${a.alertId}`) }
      }),
    )
  return { world, poll }
}

describe("an inbox item", () => {
  const { world, poll } = setup()
  afterAll(() => world.dispose())

  test("that needs you is escalated, and a newer message in its thread replaces its card", async () => {
    const first = ago(20)
    expect((await poll([mention(first, "should we ship this today?")])).cards).toEqual([`escalate:C9:${first}`])
    const second = ago(10)
    expect((await poll([mention(second, "or wait for Monday?")])).cards).toEqual([`escalate:C9:${second}`])
  })

  test("a newer message saying it was answered takes the card down", async () => {
    expect((await poll([mention(ago(5), "never mind, answered")])).cards).toEqual([])
  })
})

describe("Slack mentions in notification titles", () => {
  const { world, poll } = setup()
  afterAll(() => world.dispose())

  test("an item filed before names were resolved is named on the first poll: its alert, card and session", async () => {
    const title = "Pierre · #eng-api: <@U3> and <@U404> can you review the quote?"
    const alert = makeAlert({ id: "C9:1", source: "inbox", title, summary: `<@${ME}> <@U3> can you review the quote?`, raw: `<@${ME}> <@U3> can you review the quote?` })
    const elsewhere = makeAlert({ id: "C1:2", title: "Deploy by <@U3> failed" })
    const card = { id: "act_1", kind: "escalate", title, detail: "", primaryLabel: "Open", options: [], sessionId: null, alertId: alert.id, fingerprint: null, retry: false, url: null, createdAt: "" } as const
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(alert)
        yield* store.putAlert(elsewhere)
        yield* store.putAction(card)
        yield* store.putSession(makeSession("waiting", { id: "s1", alertId: alert.id, title }))
        yield* (yield* SlackMe).identity
        yield* (yield* Inbox).poll
        return {
          alert: yield* store.getAlert(alert.id),
          elsewhere: yield* store.getAlert(elsewhere.id),
          actions: yield* store.listActions(),
          session: yield* store.getSession("s1"),
        }
      }),
    )
    const named = "Pierre · #eng-api: @Hugo and @someone can you review the quote?"
    expect(out.alert).toMatchObject({ title: named, summary: "@Alexandre @Hugo can you review the quote?", raw: alert.raw })
    expect(out.actions.map((a) => [a.id, a.title])).toEqual([["act_1", named]])
    expect(out.session?.title).toBe(named)
    // Only the inbox's: an alert channel's title is left as it was filed.
    expect(out.elsewhere?.title).toBe("Deploy by <@U3> failed")
  })

  test("a new item is filed with people named, and the message kept as written", async () => {
    const ts = ago(20)
    await poll([mention(ts, "<@U3> and <@U404> can you review the quote?")])
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        return { actions: yield* store.listActions(), alert: yield* store.getAlert(`C9:${ts}`) }
      }),
    )
    expect(out.actions.find((a) => a.alertId === `C9:${ts}`)?.title).toBe("Pierre · #eng-api: @Hugo and @someone can you review the quote?")
    expect(out.alert?.summary).toBe("@Alexandre @Hugo and @someone can you review the quote?")
    expect(out.alert?.raw).toBe(`<@${ME}> <@U3> and <@U404> can you review the quote?`)
  })
})

describe("an inbox item an agent can do", () => {
  const { world, poll } = setup()
  afterAll(() => world.dispose())

  test("starts an agent of yours, claimed nowhere", async () => {
    const ts = ago(20)
    await poll([mention(ts, "why does /opportunities 500? delegate")])
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const alert = yield* store.getAlert(`C9:${ts}`)
        return { decision: alert?.triage.decision, session: alert?.sessionId === null ? undefined : yield* store.getSession(alert?.sessionId ?? "") }
      }),
    )
    expect(out.decision).toBe("auto")
    expect(out.session?.status).toBe("queued")
  })
})

describe("a follow-up in a thread an agent is handling", () => {
  const { world, poll } = setup()
  afterAll(() => world.dispose())

  test("goes to that session, not to Jev, and says so on both", async () => {
    const parent = `C9:${THREAD}`
    // Its session cannot take a message right now (no agent session to resume): the transcript says so.
    await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putAlert(makeAlert({ id: parent, channelId: "C9", ts: THREAD, sessionId: "s_thread" }))
        yield* store.putSession(makeSession("waiting", { id: "s_thread", alertId: parent, agentSessionId: null }))
      }),
    )
    const ts = ago(5)
    const { cards } = await poll([mention(ts, "any news?")])
    const out = await world.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        return { alert: yield* store.getAlert(`C9:${ts}`), transcript: (yield* store.transcript("s_thread", 10)).map((e) => e.text) }
      }),
    )
    expect(cards).toEqual([])
    expect(out.alert).toMatchObject({ sessionId: "s_thread", triage: { decision: "filtered" } })
    expect(out.transcript).toEqual(["Pierre followed up in the thread", "The agent cannot take the follow-up right now"])
    expect(await world.runPromise(Hub.use((hub) => hub.status.pipe(Effect.map((s) => s.jev))))).toBe("ok")
  })
})

describe("the inbox horizon", () => {
  let failing = true
  const world = makeWorld({
    slack: fakeSlack({
      search: () => (failing ? Effect.fail(new SlackApiError({ method: "search.messages", code: "ratelimited", message: "ratelimited" })) : Effect.succeed([])),
    }),
  })
  afterAll(() => world.dispose())

  test("a search that failed leaves it, so what it missed is still news; one that worked moves it", async () => {
    const out = await world.runPromise(
      Effect.gen(function* () {
        yield* (yield* SlackMe).identity
        const store = yield* Store
        const inbox = yield* Inbox
        const lastGood = String(Date.now() - 2 * 60 * 60_000)
        yield* store.setKv("inbox_since", lastGood)
        yield* inbox.poll
        const afterFailure = yield* store.getKv("inbox_since")
        failing = false
        yield* inbox.poll
        return { lastGood, afterFailure, afterSuccess: Number(yield* store.getKv("inbox_since")) }
      }),
    )
    expect(out.afterFailure).toBe(out.lastGood)
    expect(out.afterSuccess).toBeGreaterThan(Date.now() - 31 * 60_000)
  })
})
