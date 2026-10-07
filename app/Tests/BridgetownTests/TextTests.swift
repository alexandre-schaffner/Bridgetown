import Foundation
import Testing
@testable import Bridgetown

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
