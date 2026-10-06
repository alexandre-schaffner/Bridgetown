import Foundation
import Testing
@testable import Bridgetown

@Suite struct MrkdwnTests {
    /// What the app shows for a Slack message: its words, with block and inline syntax gone.
    private func shown(_ s: String) -> String { Markdown.plain(Mrkdwn.markdown(s)) }

    @Test func unterminatedAngleBracketIsKeptOnce() {
        #expect(shown("p95 < 2s") == "p95 < 2s")
        #expect(shown("see <https://x.io|docs> then <oops") == "see docs then <oops")
    }

    @Test func tokens() {
        #expect(Mrkdwn.markdown("<https://x.io|docs>") == "[docs](<https://x.io>)")
        #expect(Mrkdwn.markdown("<https://x.io>") == "<https://x.io>")
        #expect(Mrkdwn.markdown("<#C123|alert-dev>") == "#alert-dev")
        #expect(Mrkdwn.markdown("<!here>") == "@here")
        #expect(Mrkdwn.markdown("<!subteam^S0DEV|dev-product>") == "@dev-product")
        #expect(Mrkdwn.markdown("cc <!subteam^S04ONCALL|@engine-oncall>") == "cc @engine-oncall")
        #expect(Mrkdwn.markdown("<#C123|#alert-dev>") == "#alert-dev")
        #expect(Mrkdwn.markdown("<@U123>") == "@U123")
        #expect(Mrkdwn.markdown("<https://x.io|[RESOLVED] api>") == "[\\[RESOLVED\\] api](<https://x.io>)")
    }

    @Test func entitiesDecodeOnce() {
        #expect(shown("a &lt; b &amp;&amp; c &gt; d") == "a < b && c > d")
        #expect(shown("&amp;lt;") == "&lt;")
        #expect(shown("`a &lt; b`") == "a < b")
    }

    @Test func emphasis() {
        #expect(Mrkdwn.markdown("*Deploy failed* in _prod_ ~maybe~") == "**Deploy failed** in *prod* ~~maybe~~")
        #expect(Mrkdwn.markdown("snake_case_name and 2*3*4") == "snake_case_name and 2*3*4")
        #expect(Mrkdwn.markdown("`*not bold*`") == "`*not bold*`")
        #expect(Mrkdwn.markdown("<https://x.io/_a_b_|_docs_>") == "[_docs_](<https://x.io/_a_b_>)")
        #expect(Mrkdwn.markdown("*see <https://x.io|docs>*") == "**see [docs](<https://x.io>)**")
    }

    @Test func slackHasNoEscapes() {
        #expect(shown("C:\\temp\\*") == "C:\\temp\\*")
    }

    @Test func fencesAndQuotes() {
        let blocks = Markdown.blocks(Mrkdwn.markdown("Error:```panic: &lt;nil&gt;\n  at main.go:12```&gt; quoted *bold*"))
        #expect(blocks == [
            .paragraph("Error:"),
            .code("panic: <nil>\n  at main.go:12"),
            .quote([.paragraph("quoted **bold**")]),
        ])
    }

    @Test func emoji() {
        #expect(Mrkdwn.markdown(":rotating_light: *TX Executor* :+1::skin-tone-3:") == "🚨 **TX Executor** 👍")
        #expect(Mrkdwn.markdown(":merkl-logo: at 10:42:07") == ":merkl-logo: at 10:42:07")
        #expect(Mrkdwn.markdown("`:fire:`") == "`:fire:`")
    }

    @Test func unclosedFenceStaysText() {
        #expect(shown("a ``` b") == "a ``` b")
    }
}

@Suite struct MarkdownTests {
    @Test func blocks() {
        let text = """
        ## Root cause
        The signer's nonce was **never broadcast**.

        - first
          - nested
        - second
          continues

        1. one
        2) two

        ```ts
        const x = 1
        ```
        ---
        > a quote
        """
        #expect(Markdown.blocks(text) == [
            .heading(level: 2, "Root cause"),
            .paragraph("The signer's nonce was **never broadcast**."),
            .list([
                .init(marker: "•", text: "first", depth: 0),
                .init(marker: "•", text: "nested", depth: 1),
                .init(marker: "•", text: "second\ncontinues", depth: 0),
            ]),
            .list([.init(marker: "1.", text: "one", depth: 0), .init(marker: "2.", text: "two", depth: 0)]),
            .code("const x = 1"),
            .rule,
            .quote([.paragraph("a quote")]),
        ])
    }

    @Test func looseListStaysOneList() {
        #expect(Markdown.blocks("- a\n\n- b\n\nafter") == [
            .list([.init(marker: "•", text: "a", depth: 0), .init(marker: "•", text: "b", depth: 0)]),
            .paragraph("after"),
        ])
    }

    @Test func notLists() {
        #expect(Markdown.listItem("2026. was a year") == nil)
        #expect(Markdown.listItem("-5% since deploy") == nil)
        #expect(Markdown.listItem("#hashtag") == nil)
        #expect(Markdown.blocks("#alert-dev fired") == [.paragraph("#alert-dev fired")])
    }

    @Test func tables() {
        #expect(Markdown.blocks("| a | b |\n|---|:-:|\n| 1 | `2` |\n| 3 |") == [
            .table(header: ["a", "b"], rows: [["1", "`2`"], ["3", ""]]),
        ])
        #expect(Markdown.blocks("a | b\nc") == [.paragraph("a | b\nc")])
    }

    @Test func inlineStylesAndBareLinks() {
        let text = Markdown.inline("See **PR** `fix-bt-1` at https://github.com/x/y/pull/3 or [docs](https://d.io)", size: 12)
        let links = text.runs.compactMap(\.link).map(\.absoluteString)
        #expect(links == ["https://github.com/x/y/pull/3", "https://d.io"])
        #expect(String(text.characters) == "See PR fix-bt-1 at https://github.com/x/y/pull/3 or docs")
        #expect(text.runs.contains { $0.inlinePresentationIntent == .code && $0.font != nil })
    }

    @Test func flattened() {
        let md = "## Fix\n- pin **vite**\n- rebuild\n\n```\nbun i\n```"
        #expect(Markdown.plain(md) == "Fix • pin vite • rebuild bun i")
        #expect(String(Markdown.lines(md, size: 11).characters) == "Fix\n• pin vite\n• rebuild\nbun i")
    }
}
