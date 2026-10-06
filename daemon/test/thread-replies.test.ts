import { describe, expect, test } from "bun:test"
import { isPerson, toThreadReplies } from "../src/slack/mrkdwn.ts"

describe("toThreadReplies: one author rule", () => {
  test("bot, then Bridgetown's own posts, then me, then teammates", () => {
    const replies = toThreadReplies(
      [
        { ts: "1", text: "Build failed, <@UME> please look", bot_id: "B1" },
        { ts: "2", text: "🤖 Investigating with Bridgetown…", user: "UME" },
        { ts: "3", text: "on it", user: "UME" },
        { ts: "4", text: "I think it is vite", user: "U2" },
        { ts: "5", text: "posted by an app as me", user: "UME", bot_id: "B2" },
      ],
      "UME",
    )
    expect(replies.map((r) => r.author)).toEqual(["bot", "bot", "me", "teammate", "bot"])
    expect(replies[3]?.text).toBe("I think it is vite")
  })
  test("a message no person wrote is a bot's; a person's reply also sent to the channel is still theirs", () => {
    const replies = toThreadReplies(
      [
        { ts: "1", text: "joined", subtype: "channel_join" },
        { ts: "2", text: "see this too", user: "U2", subtype: "thread_broadcast" },
      ],
      "UME",
    )
    expect(replies.map((r) => r.author)).toEqual(["bot", "teammate"])
  })
  test("a person is a user with no app or bot behind it, in history and in search alike", () => {
    expect(isPerson({ user: "U2" })).toBe(true)
    expect(isPerson({ user: "U2", bot_id: null })).toBe(true)
    expect(isPerson({ user: "U2", bot_id: "B1" })).toBe(false)
    expect(isPerson({ user: null })).toBe(false)
    expect(isPerson({ user: "" })).toBe(false)
  })
  test("without an identity nobody is me", () => {
    expect(toThreadReplies([{ ts: "1", text: "hi", user: "UME" }], undefined)).toEqual([{ author: "teammate", text: "hi" }])
  })
})
