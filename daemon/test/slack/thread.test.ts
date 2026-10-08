import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { Effect } from "effect"
import { Hub } from "../../src/hub.ts"
import { Memory } from "../../src/memory/memory.ts"
import type { SlackMessage } from "../../src/slack/client.ts"
import { BOT_PREFIX } from "../../src/slack/mrkdwn.ts"
import { SlackThread } from "../../src/slack/thread.ts"
import { Store } from "../../src/store/store.ts"
import { fakeSlack } from "../support/fakes.ts"
import { makeAlert } from "../support/records.ts"
import { scratchDir } from "../support/tmp.ts"
import { makeWorld } from "../support/world.ts"

const posts: Array<{ readonly channel: string; readonly thread: string | undefined; readonly text: string }> = []
const world = makeWorld({
  env: { forceDryRun: false },
  slack: fakeSlack({ post: (channel, thread, text) => Effect.sync(() => void posts.push({ channel, thread, text })).pipe(Effect.as("2.000001")) }),
})
afterAll(() => world.dispose())

test("thread reads preserve capture failures until an evidence write succeeds", async () => {
  const home = scratchDir("bt-thread-capture-")
  let replies: ReadonlyArray<SlackMessage> = []
  const recovering = makeWorld({ home, slack: fakeSlack({ replies: () => Effect.sync(() => replies) }) })
  let db: Database | undefined
  try {
    await recovering.runPromise(Effect.gen(function* () {
      const hub = yield* Hub
      const memory = yield* Memory
      const thread = yield* SlackThread
      const store = yield* Store
      yield* store.setKv("memory_activated_at", "2026-01-01T00:00:00.000Z")
      db = new Database(join(home, "bridgetown.db"))
      db.exec("CREATE TRIGGER reject_memory BEFORE INSERT ON memory_evidence BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END")
      expect(yield* memory.remember("session", "A durable fact")).toBe(false)
      const failure = yield* hub.problemFor("memory-capture")
      expect(failure).not.toBeNull()
      const alert = makeAlert({ ts: "2000000000.000001" })
      for (const skipped of [
        [],
        [{ ts: alert.ts, text: "The original alert" }],
        [{ ts: "1.000001", text: "An old reply" }],
        [{ ts: "2000000000.000002", text: `${BOT_PREFIX} An agent update` }],
      ]) {
        replies = skipped
        expect(yield* thread.messages(alert)).toEqual(skipped)
        expect(yield* hub.problemFor("memory-capture")).toBe(failure)
      }
      replies = [{ ts: "2000000000.000003", user: "U2", text: "A new durable fact" }]
      expect(yield* thread.messages(alert)).toEqual(replies)
      expect(yield* hub.problemFor("memory-capture")).toBe(failure)
      expect(yield* store.pendingMemoryCount).toBe(0)
      db.exec("DROP TRIGGER reject_memory")
      yield* thread.messages(alert)
      expect(yield* store.pendingMemoryCount).toBe(1)
      expect(yield* hub.problemFor("memory-capture")).toBeNull()
    }))
  } finally { db?.close(); await recovering.dispose() }
})

describe("Bridgetown's updates in a thread", () => {
  test("go under an alert, never into an inbox item's conversation, and nowhere for a watch finding", async () => {
    const alert = makeAlert({ id: "C1:10", channelId: "C1", ts: "10.000001" })
    const inbox = makeAlert({
      id: "D1:11", channelId: "D1", ts: "11.000001", source: "inbox",
      fields: { _tag: "inbox", from: "U2", fromName: "Pierre", channelKind: "dm", via: "dm", threadTs: null, prUrl: null },
    })
    const finding = makeAlert({ id: "watch:api_5xx:1", channelId: "grafana", source: "watch" })
    const out = await world.runPromise(
      Effect.gen(function* () {
        const hub = yield* Hub
        yield* hub.updateSettings({ ...(yield* hub.settings), dryRun: false })
        const thread = yield* SlackThread
        return [
          (yield* thread.postUpdate(alert, "Merged #1"))._tag,
          (yield* thread.postUpdate(inbox, "Merged #1"))._tag,
          (yield* thread.postUpdate(finding, "Merged #1"))._tag,
          // A reply you approved goes into the inbox item's thread.
          (yield* thread.post(inbox, "Done, see #1"))._tag,
        ]
      }),
    )
    expect(out).toEqual(["Posted", "NotPosted", "NotPosted", "Posted"])
    expect(posts).toEqual([
      { channel: "C1", thread: "10.000001", text: "🤖 Merged #1" },
      { channel: "D1", thread: "11.000001", text: "🤖 Done, see #1" },
    ])
  })
})
