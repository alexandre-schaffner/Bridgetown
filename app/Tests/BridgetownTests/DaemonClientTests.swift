import Foundation
import Testing
@testable import Bridgetown

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
