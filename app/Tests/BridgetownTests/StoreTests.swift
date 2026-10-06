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
