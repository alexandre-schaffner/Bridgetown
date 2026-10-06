import Foundation
import Testing
@testable import Bridgetown

/// The Store against `StubDaemon`, over real HTTP and SSE on loopback.
@MainActor @Suite(.serialized) struct StoreTests {
    private let snapshot: Data

    init() throws { snapshot = try Fixture.data("snapshot") }

    private func connected(_ answer: @escaping (StubDaemon.Request) -> StubDaemon.Answer) async throws -> (Store, StubDaemon) {
        let stub = try StubDaemon(snapshot: snapshot, answer: answer)
        let store = Store()
        store.connect(to: try await stub.start())
        try await stub.until { store.connection == .connected }
        try #require(store.connection == .connected)
        return (store, stub)
    }

    /// The fixture with its status changed, as the daemon sends it after a change.
    private func withStatus(_ edit: (inout [String: Any]) -> Void) throws -> Data {
        var json = try #require(JSONSerialization.jsonObject(with: snapshot) as? [String: Any])
        var status = try #require(json["status"] as? [String: Any])
        edit(&status)
        json["status"] = status
        return try JSONSerialization.data(withJSONObject: json)
    }

    /// No snapshot may come to correct it, so a pause the daemon refused is taken back.
    @Test func aRefusedPauseIsTakenBack() async throws {
        let (store, stub) = try await connected { _ in .init(status: 500, body: Data(#"{"error":"nope"}"#.utf8)) }
        defer { stub.stop() }
        let before = try #require(store.snapshot?.status.paused as Bool?)
        store.setPaused(!before)
        #expect(store.snapshot?.status.paused == !before)
        try await stub.until { store.flash != nil }
        #expect(store.flash == "nope")
        #expect(store.snapshot?.status.paused == before)
    }

    /// A snapshot from before the daemon took the pause in (any change sends one) doesn't
    /// flip the toggle back while the request is out.
    @Test func aPauseHoldsOverAnOlderSnapshotUntilAnswered() async throws {
        let paused = try withStatus { $0["paused"] = true }
        let (store, stub) = try await connected { _ in .init(body: paused, after: .milliseconds(300)) }
        defer { stub.stop() }
        store.setPaused(true)
        try await stub.until { stub.requests.count == 1 }
        stub.push(try withStatus { $0["error"] = "an unrelated change" })
        try await stub.until { store.snapshot?.status.error == "an unrelated change" }
        #expect(store.snapshot?.status.paused == true)
        try await stub.until { !store.isBusy("pause") }
        #expect(store.snapshot?.status.paused == true)
    }

    /// The daemon took the pause in and said so on the stream, but the request's own answer
    /// was lost: the toggle shows what the daemon said, not the click taken back.
    @Test func aPauseWhoseAnswerIsLostShowsWhatTheDaemonSaid() async throws {
        let (store, stub) = try await connected { _ in .init(status: 500, body: Data(#"{"error":"lost"}"#.utf8), after: .milliseconds(300)) }
        defer { stub.stop() }
        store.setPaused(true)
        try await stub.until { stub.requests.count == 1 }
        stub.push(try withStatus { $0["paused"] = true; $0["error"] = "paused by the daemon" })
        try await stub.until { store.snapshot?.status.error == "paused by the daemon" }
        try await stub.until { store.flash != nil }
        #expect(store.flash == "lost")
        #expect(store.snapshot?.status.paused == true)
    }

    /// The second click sends nothing, so it mustn't flip the toggle either: the toggle would
    /// say one thing and the daemon the other.
    @Test func aSecondPauseClickWhileTheFirstIsOutChangesNothing() async throws {
        let (store, stub) = try await connected { [snapshot] _ in .init(body: snapshot, after: .milliseconds(200)) }
        defer { stub.stop() }
        let before = try #require(store.snapshot?.status.paused as Bool?)
        store.setPaused(!before)
        store.setPaused(before)
        #expect(store.snapshot?.status.paused == !before)
        try await stub.until { stub.events.count == 2 }
        #expect(stub.requests.count == 1)
    }

    @Test func aSecondClickWhileTheFirstIsOutSendsNothing() async throws {
        let (store, stub) = try await connected { [snapshot] _ in .init(body: snapshot, after: .milliseconds(200)) }
        defer { stub.stop() }
        let alert = try #require(store.snapshot?.alerts.first)
        store.investigate(alert)
        store.investigate(alert)
        try await stub.until { stub.events.count == 2 }
        let path = try #require(stub.requests.first?.path)
        #expect(path.hasSuffix("/investigate"))
        #expect(stub.events == ["→ POST \(path)", "← POST \(path)"])
    }

    @Test func aRefusedSettingGoesBackToWhatTheDaemonSaid() async throws {
        let (store, stub) = try await connected { _ in .init(status: 500, body: Data(#"{"error":"nope"}"#.utf8)) }
        defer { stub.stop() }
        let before = try #require(store.snapshot?.settings.autoStart as Bool?)
        store.editSettings { $0.autoStart.toggle() }
        #expect(store.snapshot?.settings.autoStart == !before)
        try await stub.until { store.flash != nil }
        #expect(store.snapshot?.settings.autoStart == before)
    }

    /// A second edit while the first is out waits for its answer, rather than calling it off
    /// (which failed it as "cancelled" and took the first edit back).
    @Test func settingsEditsGoOneRequestAtATime() async throws {
        let (store, stub) = try await connected { [snapshot] _ in .init(body: snapshot, after: .milliseconds(150)) }
        defer { stub.stop() }
        store.editSettings { $0.autoStart.toggle() }
        try await stub.until { stub.requests.count == 1 }
        store.editSettings { $0.inbox.toggle() }
        try await stub.until { stub.events.count == 4 }
        #expect(stub.events == ["→ POST /settings", "← POST /settings", "→ POST /settings", "← POST /settings"])
        let second = try #require(JSONSerialization.jsonObject(with: stub.requests[1].body) as? [String: Any])
        #expect(Array(second.keys) == ["inbox"])
        #expect(store.flash == nil)
    }
}
