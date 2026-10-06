import Foundation
import Testing
@testable import Bridgetown

/// How the served run reads what curl sends it.
@Suite struct E2EControlRequestTests {
    private func parse(_ text: String) throws -> E2EControl.Request? {
        try E2EControl.Request(Data(text.utf8))
    }

    @Test func aRequestIsReadOnceItIsAllIn() throws {
        let head = "POST /step?x=1 HTTP/1.1\r\nX-E2E-Token: t\r\nContent-Length: 12\r\n\r\n"
        #expect(try parse(head + #"{"shot":"#) == nil)
        let request = try #require(try parse(head + #"{"shot":"a"}"#))
        #expect(request.method == "POST" && request.path == "/step")
        #expect(request.headers["x-e2e-token"] == "t")
        #expect(request.body == Data(#"{"shot":"a"}"#.utf8))
    }

    /// Answered 400 at once, rather than waiting on more of something that can't be a request.
    @Test func whatCantBeARequestIsSaidAtOnce() {
        #expect(throws: E2EControl.Request.Malformed.self) { try parse("hello\r\n\r\n") }
        #expect(throws: E2EControl.Request.Malformed.self) { try parse("POST /step HTTP/1.1\r\nContent-Length: lots\r\n\r\n") }
    }
}
