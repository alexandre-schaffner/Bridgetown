import { describe, expect, test } from "bun:test"
import { recommendation } from "../../src/slack/messages.ts"
import { isPerson, toMrkdwn, toThreadReplies } from "../../src/slack/mrkdwn.ts"

describe("toMrkdwn: agent Markdown as Slack mrkdwn", () => {
  test("emphasis and links", () => {
    expect(toMrkdwn("**vite 6.4** broke it, ~~maybe~~ see [PR #3340](https://x.io/pull/3340)")).toBe(
      "*vite 6.4* broke it, ~maybe~ see <https://x.io/pull/3340|PR #3340>",
    )
    expect(toMrkdwn("[docs](<https://x.io/a b>)")).toBe("<https://x.io/a b|docs>")
  })

  test("headings and bullets", () => {
    expect(toMrkdwn("## Root **cause**\n- one\n  * two\n+ three")).toBe("*Root cause*\n• one\n  • two\n• three")
  })

  test("code, fences and Slack tokens pass through", () => {
    expect(toMrkdwn("run `**not** [a](b)` now")).toBe("run `**not** [a](b)` now")
    expect(toMrkdwn("```ts\nconst x = **1**\n```")).toBe("```\nconst x = **1**\n```")
    expect(toMrkdwn("cc <!subteam^S0|@dev> on <https://x.io|**this**>")).toBe("cc <!subteam^S0|@dev> on <https://x.io|**this**>")
  })

  test("Slack-style text is left as written", () => {
    const slack = "*Deploy failed* in _prod_, snake_case_name, 2*3*4 and • a bullet"
    expect(toMrkdwn(slack)).toBe(slack)
  })

  test("thread messages convert the agent's words", () => {
    expect(recommendation("**Flaky** runner", "Re-run `deploy`, then check [logs](https://l.io)")).toBe(
      "*Flaky* runner\nRecommendation: Re-run `deploy`, then check <https://l.io|logs>",
    )
  })
})

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
