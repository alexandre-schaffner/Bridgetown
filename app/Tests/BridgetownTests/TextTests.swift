import Foundation
import Testing
@testable import Bridgetown

@Suite struct MrkdwnTests {
    @Test func unterminatedAngleBracketIsKeptOnce() {
        #expect(Mrkdwn.plain("p95 < 2s") == "p95 < 2s")
        #expect(Mrkdwn.plain("see <https://x.io|docs> then <oops") == "see docs then <oops")
    }

    @Test func tokens() {
        #expect(Mrkdwn.plain("<https://x.io|docs>") == "docs")
        #expect(Mrkdwn.plain("<https://x.io>") == "https://x.io")
        #expect(Mrkdwn.plain("<#C123|alert-dev>") == "#alert-dev")
        #expect(Mrkdwn.plain("<!here>") == "@here")
        #expect(Mrkdwn.plain("<!subteam^S0DEV|dev-product>") == "@dev-product")
        #expect(Mrkdwn.plain("cc <!subteam^S04ONCALL|@engine-oncall>") == "cc @engine-oncall")
        #expect(Mrkdwn.plain("<#C123|#alert-dev>") == "#alert-dev")
        #expect(Mrkdwn.plain("<@U123>") == "@U123")
    }

    @Test func entitiesDecodeOnce() {
        #expect(Mrkdwn.plain("a &lt; b &amp;&amp; c &gt; d") == "a < b && c > d")
        #expect(Mrkdwn.plain("&amp;lt;") == "&lt;")
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
