#if DEBUG
import Foundation
import Network

/// `make e2e SERVE=1`: after the suite the app stays up, steered over HTTP on loopback by
/// whoever holds the token in <run>/control.json. Every request carries `X-E2E-Token`.
///
/// - `POST /step` runs one step (the suite's JSON) and answers `{ok, shots, error}`;
///   a `shot` step returns its PNG paths and issues.
/// - `GET /tree` is the current surface's accessibility tree and its lint.
/// - `GET /state` is the route, connection, surface and counts.
/// - `POST /quit` ends the run.
@MainActor
final class E2EControl {
    private let listener: NWListener
    private let token: String
    private let runner: E2ERunner
    private let activity: () -> Void
    private let quit: () -> Void
    /// The last step asked for. Each waits for the one before: two at once would interleave
    /// at every `await`, one's clicks landing between the other's.
    private var lastStep: Task<(Int, E2EJSON), Never>?

    init(runner: E2ERunner, activity: @escaping () -> Void, quit: @escaping () -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = bytes.map { String(format: "%02x", $0) }.joined()
        self.runner = runner
        self.activity = activity
        self.quit = quit
    }

    /// Listens, then writes `control.json` ({url, token}) into `dir`.
    func start(writingTo dir: URL) async throws -> URL {
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            // Cleared on the first answer, so the continuation resumes once.
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
        let url = URL(string: "http://127.0.0.1:\(port)")!
        let info = E2EJSON.object(["url": .string(url.absoluteString), "token": .string(token)])
        try Data(info.line.utf8).write(to: dir.appending(path: "control.json"))
        return url
    }

    func stop() {
        listener.cancel()
    }

    // MARK: HTTP

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(connection, buffered: Data())
    }

    private func receive(_ connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                let buffer = buffered + (data ?? Data())
                let request: Request?
                do {
                    request = try Request(buffer)
                } catch {
                    return self.send(400, .object(["error": .string("not an HTTP request")]), on: connection)
                }
                if let request {
                    Task { @MainActor in
                        let (status, body) = await self.respond(to: request)
                        self.send(status, body, on: connection)
                    }
                } else if complete || error != nil || buffer.count > 4 << 20 {
                    connection.cancel()
                } else {
                    self.receive(connection, buffered: buffer)
                }
            }
        }
    }

    private func respond(to request: Request) async -> (Int, E2EJSON) {
        guard request.headers["x-e2e-token"] == token else { return (401, .object(["error": .string("missing or wrong X-E2E-Token")])) }
        activity()
        switch (request.method, request.path) {
        case ("POST", "/step"):
            let previous = lastStep
            let step = Task { _ = await previous?.value; return await self.step(request.body) }
            lastStep = step
            return await step.value
        case ("GET", "/tree"):
            guard let tree = runner.tree(),
                  let elements = try? JSONDecoder().decode(E2EJSON.self, from: JSONEncoder().encode(tree.elements)),
                  let issues = try? JSONDecoder().decode(E2EJSON.self, from: JSONEncoder().encode(tree.issues))
            else { return (409, .object(["error": .string("no surface yet")])) }
            return (200, .object(["surface": .string(tree.surface), "elements": elements, "issues": issues]))
        case ("GET", "/state"):
            return (200, .object(runner.state))
        case ("POST", "/quit"):
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(100))
                self.quit()
            }
            return (200, .object(["ok": .bool(true)]))
        default:
            return (404, .object(["error": .string("POST /step, GET /tree, GET /state or POST /quit")]))
        }
    }

    private func step(_ body: Data) async -> (Int, E2EJSON) {
        do {
            let step = try JSONDecoder().decode(E2EJSON.self, from: body)
            let shots = try await runner.perform(step, as: "control")
            let encoded = try JSONDecoder().decode(E2EJSON.self, from: JSONEncoder().encode(shots))
            return (200, .object(["ok": .bool(true), "shots": encoded]))
        } catch {
            return (200, .object(["ok": .bool(false), "error": .string("\(error)")]))
        }
    }

    private func send(_ status: Int, _ body: E2EJSON, on connection: NWConnection) {
        let payload = Data(body.line.utf8)
        let head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + payload, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// Enough HTTP/1.1 for curl: a request line, headers, and a body by Content-Length.
    struct Request {
        struct Malformed: Error {}

        var method: String
        var path: String
        var headers: [String: String]
        var body: Data

        /// Nil until the whole request is in; throws once it can't become one.
        init?(_ data: Data) throws {
            guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
            let head = String(decoding: data[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            let line = head.first?.split(separator: " ") ?? []
            guard line.count >= 2 else { throw Malformed() }
            method = String(line[0])
            path = String(line[1].split(separator: "?").first ?? "")
            headers = Dictionary(head.dropFirst().compactMap { field -> (String, String)? in
                guard let colon = field.firstIndex(of: ":") else { return nil }
                return (field[..<colon].lowercased(), field[field.index(after: colon)...].trimmingCharacters(in: .whitespaces))
            }, uniquingKeysWith: { $1 })
            guard let length = Int(headers["content-length"] ?? "0"), length >= 0 else { throw Malformed() }
            let body = data[end.upperBound...]
            guard body.count >= length else { return nil }
            self.body = Data(body.prefix(length))
        }
    }
}
#endif
