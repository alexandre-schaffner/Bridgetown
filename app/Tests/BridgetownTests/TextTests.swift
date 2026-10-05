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

@Suite struct SSEParserTests {
    private func feed(_ text: String) -> [SSEParser.Event] {
        var parser = SSEParser()
        return text.utf8.compactMap { parser.feed($0) }
    }

    @Test func snapshotEvent() {
        #expect(feed("event: snapshot\ndata: {\"a\":1}\n\n") == [.init(name: "snapshot", data: "{\"a\":1}")])
    }

    @Test func commentsAndCRLF() {
        let events = feed(": ping\r\n\r\nevent: snapshot\r\ndata: x\r\n\r\n")
        #expect(events == [.init(name: "snapshot", data: "x")])
    }

    @Test func multiLineDataAndDefaultName() {
        #expect(feed("data: a\ndata: b\n\n") == [.init(name: "message", data: "a\nb")])
    }

    @Test func incompleteEventIsHeld() {
        #expect(feed("event: snapshot\ndata: x\n").isEmpty)
    }
}

@Suite struct NewActionsTests {
    @Test func theFirstSnapshotIsTheBaselineThenOnlyNewIdsCount() throws {
        var snap = try Fixture.snapshot()
        snap.settings.quietHours.enabled = false
        var new = NewActions()
        #expect(new.update(snap).isEmpty)
        #expect(new.update(snap).isEmpty)

        var fresh = try #require(snap.actions.first)
        fresh.id = "act_fresh"
        snap.actions.append(fresh)
        #expect(new.update(snap).map(\.id) == ["act_fresh"])
        #expect(new.update(snap).isEmpty)
    }

    /// It keeps the cards standing and no more, so it doesn't grow for as long as the app
    /// runs; the ones gone are the notifications to take back.
    @Test func itRemembersOnlyTheCardsStanding() throws {
        var snap = try Fixture.snapshot()
        snap.settings.quietHours.enabled = false
        var new = NewActions()
        _ = new.update(snap)
        let resolved = try #require(snap.actions.first)
        snap.actions.removeFirst()
        _ = new.update(snap)
        #expect(new.seen == Set(snap.actions.map(\.id)))
        #expect(new.seen?.contains(resolved.id) == false)
    }

    @Test func quietHoursHoldThemBackButStillCountThemSeen() throws {
        var snap = try Fixture.snapshot()
        snap.settings.quietHours = .init(enabled: true, start: "00:00", end: "23:59")
        var new = NewActions()
        _ = new.update(snap)
        var fresh = try #require(snap.actions.first)
        fresh.id = "act_quiet"
        snap.actions.append(fresh)
        #expect(new.update(snap, now: Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: .now)!).isEmpty)
        snap.settings.quietHours.enabled = false
        #expect(new.update(snap).isEmpty)
    }
}

@Suite struct QuietHoursTests {
    private func at(_ hour: Int, _ minute: Int) -> Date {
        var c = DateComponents()
        c.year = 2026; c.month = 10; c.day = 3; c.hour = hour; c.minute = minute
        return Calendar(identifier: .gregorian).date(from: c)!
    }

    private let calendar = Calendar(identifier: .gregorian)

    @Test func wrapsMidnight() {
        let q = Settings.QuietHours(enabled: true, start: "22:00", end: "08:00")
        #expect(QuietHours.isActive(q, at: at(23, 30), calendar: calendar))
        #expect(QuietHours.isActive(q, at: at(7, 59), calendar: calendar))
        #expect(!QuietHours.isActive(q, at: at(8, 0), calendar: calendar))
        #expect(!QuietHours.isActive(q, at: at(12, 0), calendar: calendar))
    }

    @Test func sameDayWindow() {
        let q = Settings.QuietHours(enabled: true, start: "12:00", end: "13:30")
        #expect(QuietHours.isActive(q, at: at(12, 0), calendar: calendar))
        #expect(!QuietHours.isActive(q, at: at(13, 30), calendar: calendar))
    }

    @Test func disabledEmptyOrMalformedIsNeverActive() {
        #expect(!QuietHours.isActive(.init(enabled: false, start: "00:00", end: "23:59"), at: at(12, 0), calendar: calendar))
        #expect(!QuietHours.isActive(.init(enabled: true, start: "09:00", end: "09:00"), at: at(9, 0), calendar: calendar))
        #expect(!QuietHours.isActive(.init(enabled: true, start: "25:00", end: "08:00"), at: at(3, 0), calendar: calendar))
        #expect(QuietHours.minutes("7:05") == 425)
        #expect(QuietHours.minutes("07:60") == nil)
    }
}
