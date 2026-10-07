import { describe, expect, test } from "bun:test"
import { recommendation } from "../../src/slack/messages.ts"
import { fromMrkdwn, isPerson, mentionedUsers, toMrkdwn, toThreadReplies } from "../../src/slack/mrkdwn.ts"

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

describe("fromMrkdwn: a Slack message as Markdown, for the app's alert detail", () => {
  test("links, channels, groups and people", () => {
    expect(fromMrkdwn("<https://x.io|docs>")).toBe("[docs](<https://x.io>)")
    expect(fromMrkdwn("<https://x.io>")).toBe("<https://x.io>")
    expect(fromMrkdwn("<https://x.io|[RESOLVED] api>")).toBe("[\\[RESOLVED\\] api](<https://x.io>)")
    expect(fromMrkdwn("<#C123|alert-dev> <#C123|#alert-dev>")).toBe("#alert-dev #alert-dev")
    expect(fromMrkdwn("<!here> cc <!subteam^S0DEV|dev-product> <!subteam^S04|@engine-oncall>")).toBe("@here cc @dev-product @engine-oncall")
    // A person by name when the directory knows them, else by id.
    expect(fromMrkdwn("<@U123> and <@U456>", new Map([["U123", "Hugo"]]))).toBe("@Hugo and @U456")
    expect(mentionedUsers("<@U1> <@U2|hugo> <@U1>")).toEqual(["U1"])
  })

  test("emphasis only at a word's edge, never inside code or a URL", () => {
    expect(fromMrkdwn("*Deploy failed* in _prod_ ~maybe~")).toBe("**Deploy failed** in *prod* ~~maybe~~")
    expect(fromMrkdwn("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4")
    expect(fromMrkdwn("`*not bold*`")).toBe("`*not bold*`")
    expect(fromMrkdwn("<https://x.io/_a_b_|_docs_>")).toBe("[_docs_](<https://x.io/_a_b_>)")
    expect(fromMrkdwn("*see <https://x.io|docs>*")).toBe("**see [docs](<https://x.io>)**")
  })

  test("Slack has no escapes: a backslash, a bare `<` and an unclosed fence stay as written", () => {
    expect(fromMrkdwn("C:\\temp\\*")).toBe("C:\\\\temp\\\\*")
    expect(fromMrkdwn("p95 < 2s")).toBe("p95 \\< 2s")
    expect(fromMrkdwn("see <https://x.io|docs> then <oops")).toBe("see [docs](<https://x.io>) then \\<oops")
    expect(fromMrkdwn("a ``` b")).toBe("a \\`\\`\\` b")
  })

  test("entities are the Markdown parser's to decode, but code is read verbatim", () => {
    expect(fromMrkdwn("a &lt; b &amp;&amp; c")).toBe("a &lt; b &amp;&amp; c")
    expect(fromMrkdwn("`a &lt; b`")).toBe("`a < b`")
    expect(fromMrkdwn("Error:```panic: &lt;nil&gt;\n  at main.go:12```&gt; quoted *bold*")).toBe("Error:\n```\npanic: <nil>\n  at main.go:12\n```\n>quoted **bold**")
  })

  test("known shortcodes become emoji, skin tones go, and the rest stays", () => {
    expect(fromMrkdwn(":rotating_light: *TX Executor* :+1::skin-tone-3:")).toBe("🚨 **TX Executor** 👍")
    expect(fromMrkdwn(":merkl-logo: at 10:42:07")).toBe(":merkl-logo: at 10:42:07")
    expect(fromMrkdwn("`:fire:`")).toBe("`:fire:`")
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
