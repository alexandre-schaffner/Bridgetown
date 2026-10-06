import Foundation
import Testing
@testable import Bridgetown

@Suite struct SystemActionsTests {
    @Test func onlyWebSlackAndRevvOpen() {
        #expect(SystemActions.openableURL("https://nocturlab.ghe.com/Merkl/monorepo/pull/1") != nil)
        #expect(SystemActions.openableURL("slack://channel?team=T1&id=C1") != nil)
        #expect(SystemActions.openableURL("revv://pr?host=h&repo=r&number=1") != nil)
        #expect(SystemActions.openableURL("HTTPS://example.com") != nil)
        for bad in ["http://example.com", "file:///etc/passwd", "x-apple.systempreferences:", "javascript:alert(1)", "/tmp/x", "", nil] {
            #expect(SystemActions.openableURL(bad) == nil, "\(bad ?? "nil")")
        }
    }

    @Test func aFailedScriptSaysWhy() async {
        #expect(await SystemActions.runAppleScript(#"error "Terminal said no""#) == "Terminal said no")
        #expect(await SystemActions.runAppleScript("return 1") == nil)
        #expect(SystemActions.scriptError("0:83: execution error: Not authorized to send Apple events to Terminal. (-1743)\n")
            == "Not authorized to send Apple events to Terminal.")
        #expect(SystemActions.scriptError("") == "Couldn't open Terminal")
    }

    /// A takeover waits on Terminal, and the first one on the Automation prompt; the island
    /// keeps moving meanwhile.
    @MainActor @Test func aScriptDoesntHoldTheMainActor() async throws {
        let started = Date()
        let script = Task { await SystemActions.runAppleScript("delay 1") }
        try await Task.sleep(for: .milliseconds(50))
        #expect(Date().timeIntervalSince(started) < 0.8)
        #expect(await script.value == nil)
    }
}
