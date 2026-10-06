import { describe, expect, test } from "bun:test"
import { recommendation } from "../../src/slack/messages.ts"
import { toMrkdwn } from "../../src/slack/mrkdwn.ts"

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
