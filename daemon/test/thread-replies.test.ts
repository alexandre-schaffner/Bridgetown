import { describe, expect, test } from "bun:test"
import { toThreadReplies } from "../src/slack/text.ts"

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
  test("without an identity nobody is me", () => {
    expect(toThreadReplies([{ ts: "1", text: "hi", user: "UME" }], undefined)).toEqual([{ author: "teammate", text: "hi" }])
  })
})
