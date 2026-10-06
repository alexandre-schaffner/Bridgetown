import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SlackApiError } from "../src/domain/errors.ts"
import { Inbox } from "../src/intake/inbox.ts"
import { inboxQueries, parseInbox, threadTsFromPermalink } from "../src/slack/inbox.ts"
import { SlackMe } from "../src/slack/me.ts"
import { Store } from "../src/store/store.ts"
import { decideInbox } from "../src/triage/policy.ts"
import type { JevVerdict } from "../src/domain/alert.ts"
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts"
import { fakeSlack } from "./support/fakes.ts"
import { makeWorld } from "./support/world.ts"

const ctx = { me: "U0ATSF15M4L", fromName: "Pierre", alertChannels: new Set(["C0AUKD42N3U"]) }
const match = (overrides: Record<string, unknown> = {}) => ({
  ts: "1790915239.000100",
  text: "<@U0ATSF15M4L|Alexandre Schaffner> can you test locally the admin without the backoffice token ?",
  user: "U09KC1VCHPU",
  permalink: "https://merkl-adu1009.slack.com/archives/C0AA/p1790915239000100?thread_ts=1790915000.000100&cid=C0AA",
  channel: { id: "C0AA", name: "product-front" },
  ...overrides,
})

describe("inbox", () => {
  test("queries cover mentions, groups and DMs", () => {
    expect(inboxQueries("U1", [{ id: "S1" }]).map((q) => q.query)).toEqual(["<@U1>", "<!subteam^S1>", "is:dm -from:<@U1>"])
  })
  test("parses a mention in a thread", () => {
    const item = parseInbox(match(), "mention", ctx)
    expect(item?.title).toBe("Pierre · #product-front: can you test locally the admin without the backoffice token ?")
    expect(item?.fingerprint).toBe("inbox:C0AA:1790915000.000100")
    expect(item?.fields).toMatchObject({ _tag: "inbox", channelKind: "channel", via: "mention", threadTs: "1790915000.000100", prUrl: null })
  })
  test("skips my own messages, bot posts in alert channels and Bridgetown posts", () => {
    expect(parseInbox(match({ user: "U0ATSF15M4L" }), "mention", ctx)).toBeUndefined()
    const alertChannel = { id: "C0AUKD42N3U", name: "alert-releases" }
    expect(parseInbox(match({ channel: alertChannel, user: null, username: "release-bot" }), "mention", ctx)).toBeUndefined()
    expect(parseInbox(match({ channel: alertChannel, bot_id: "B01" }), "mention", ctx)).toBeUndefined()
    expect(parseInbox(match({ text: "🤖 Fix PR: …" }), "mention", ctx)).toBeUndefined()
  })
  test("M1: a teammate mentioning me in an alert channel reaches the inbox", () => {
    const reply = parseInbox(
      match({
        channel: { id: "C0AUKD42N3U", name: "alert-releases" },
        text: "<@U0ATSF15M4L> can you look at this build?",
        permalink: "https://merkl.slack.com/archives/C0AUKD42N3U/p1790915239000100?thread_ts=1790915000.000100&cid=C0AUKD42N3U",
      }),
      "mention",
      ctx,
    )
    expect(reply?.title).toBe("Pierre · #alert-releases: can you look at this build?")
    expect(reply?.fields).toMatchObject({ threadTs: "1790915000.000100" })
    const topLevel = parseInbox(match({ channel: { id: "C0AUKD42N3U", name: "alert-releases" }, permalink: undefined }), "mention", ctx)
    expect(topLevel?.source).toBe("inbox")
  })
  test("DMs and PR links", () => {
    const item = parseInbox(
      match({ channel: { id: "D1", is_im: true }, text: "review https://nocturlab.ghe.com/Merkl/monorepo/pull/3244 pls", permalink: undefined }),
      "dm",
      ctx,
    )
    expect(item?.title).toBe("Pierre · DM: review https://nocturlab.ghe.com/Merkl/monorepo/pull/3244 pls")
    expect(item?.fields).toMatchObject({ channelKind: "dm", prUrl: "https://nocturlab.ghe.com/Merkl/monorepo/pull/3244" })
    expect(threadTsFromPermalink(undefined)).toBeNull()
  })
})

const verdict = (o: Partial<JevVerdict>): JevVerdict => ({
  actionable: 0.95, agentResolvable: 0.85, humanOnIt: 0.05, kind: "investigation", kindConfidence: 0.9, depth: "standard", urgency: 1, ...o,
})

describe("inbox policy", () => {
  const t = DEFAULT_SETTINGS.thresholds
  test("delegate, suggest, escalate, ignore", () => {
    expect(decideInbox(verdict({}), t).decision).toBe("auto")
    expect(decideInbox(verdict({ agentResolvable: 0.55 }), t).decision).toBe("suggest")
    expect(decideInbox(verdict({ agentResolvable: 0.1, kind: "decision_or_approval" }), t).decision).toBe("escalate")
    expect(decideInbox(verdict({ kind: "pr_review" }), t).decision).toBe("escalate")
    expect(decideInbox(verdict({ actionable: 0.1 }), t).decision).toBe("ignore")
    expect(decideInbox(verdict({ humanOnIt: 0.9 }), t).decision).toBe("ignore")
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
