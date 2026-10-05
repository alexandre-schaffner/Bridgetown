import Foundation
import Network
@testable import Bridgetown

/// A daemon on loopback for driving the Store end to end: `/events` sends one snapshot and
/// stays open; every other request is recorded and answered by `answer`, on the main actor.
@MainActor
final class StubDaemon {
    struct Request {
        var method: String
        var path: String
        var body: Data
    }

    struct Answer {
        var status = 200
        var body: Data
        /// Held this long before it is sent.
        var after: Duration = .zero
    }

    private(set) var requests: [Request] = []
    /// "→ POST /settings" as each request arrives, "← POST /settings" as its answer goes.
    private(set) var events: [String] = []
    var answer: (Request) -> Answer
    private let snapshot: Data
    private let listener: NWListener

    init(snapshot: Data, answer: @escaping (Request) -> Answer) throws {
        self.snapshot = snapshot
        self.answer = answer
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    /// Listens, and returns the endpoint for `Store.connect`.
    func start() async throws -> DaemonEndpoint {
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.start(queue: .main)
        }
        return DaemonEndpoint(port: Int(port), token: "stub")
    }

    func stop() {
        listener.cancel()
    }

    /// Waits until `done` holds, up to `seconds`.
    func until(seconds: Double = 5, _ done: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !done(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        read(connection, Data())
    }

    private func read(_ connection: NWConnection, _ buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            MainActor.assumeIsolated {
                guard let self, error == nil else { return connection.cancel() }
                let buffer = buffer + (data ?? Data())
                if let request = Self.parse(buffer) {
                    self.respond(to: request, on: connection)
                } else if !done {
                    self.read(connection, buffer)
                }
            }
        }
    }

    private func respond(to request: Request, on connection: NWConnection) {
        if request.path == "/events" {
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n"
            let event = "event: snapshot\ndata: " + String(decoding: snapshot, as: UTF8.self).replacingOccurrences(of: "\n", with: "") + "\n\n"
            connection.send(content: Data((head + event).utf8), completion: .contentProcessed { _ in })
            return
        }
        requests.append(request)
        events.append("→ \(request.method) \(request.path)")
        let answer = answer(request)
        Task {
            try? await Task.sleep(for: answer.after)
            events.append("← \(request.method) \(request.path)")
            let head = "HTTP/1.1 \(answer.status) Stub\r\nContent-Type: application/json\r\nContent-Length: \(answer.body.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(head.utf8) + answer.body, completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    /// A whole request (head and `Content-Length` body), or nil while more is to come.
    private static func parse(_ data: Data) -> Request? {
        guard let end = data.firstRange(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let line = head.first?.split(separator: " ") ?? []
        guard line.count >= 2 else { return nil }
        let length = head.dropFirst()
            .first { $0.lowercased().hasPrefix("content-length:") }
            .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
        let body = data[end.upperBound...]
        guard body.count >= length else { return nil }
        return Request(method: String(line[0]), path: String(line[1]), body: Data(body.prefix(length)))
    }
}
