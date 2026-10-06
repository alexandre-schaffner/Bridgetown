import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Hub } from "../../src/hub.ts"
import { SlackThread } from "../../src/slack/thread.ts"
import { fakeSlack } from "../support/fakes.ts"
import { makeAlert } from "../support/records.ts"
import { makeWorld } from "../support/world.ts"

const posts: Array<{ readonly channel: string; readonly thread: string | undefined; readonly text: string }> = []
const world = makeWorld({
  env: { forceDryRun: false },
  slack: fakeSlack({ post: (channel, thread, text) => Effect.sync(() => void posts.push({ channel, thread, text })).pipe(Effect.as("2.000001")) }),
})
afterAll(() => world.dispose())

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
