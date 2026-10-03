import Foundation

struct DaemonEndpoint: Sendable, Equatable {
    var port: Int
    var token: String

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
}

enum DaemonError: LocalizedError {
    case http(Int, String)
    case badResponse
    case notConnected

    var errorDescription: String? {
        switch self {
        case let .http(code, message): message.isEmpty ? "Daemon returned \(code)" : message
        case .badResponse: "Unexpected response from daemon"
        case .notConnected: "Not connected to the daemon"
        }
    }

    var statusCode: Int? {
        if case let .http(code, _) = self { return code }
        return nil
    }
}

extension Error {
    /// One line for the UI: what went wrong, in the app's words.
    var userMessage: String {
        if let e = self as? URLError {
            switch e.code {
            case .cannotConnectToHost, .networkConnectionLost, .cannotFindHost: return "Daemon not reachable"
            case .timedOut: return "Daemon timed out"
            default: return e.localizedDescription
            }
        }
        if (self as? DaemonError)?.statusCode == 401 { return "Daemon rejected the API token" }
        if self is DecodingError { return "Couldn't read the daemon's response" }
        return localizedDescription
    }

    var isTimeout: Bool { (self as? URLError)?.code == .timedOut }
}

/// Stateless HTTP client for the daemon API (docs/API.md).
struct DaemonClient: Sendable {
    let endpoint: DaemonEndpoint

    private static let rest = session(timeout: 15)

    /// A Grafana board the daemon hasn't cached yet runs a day of LogsQL stats (up to ~45s a query).
    private static let boards = session(timeout: 120)

    /// Resolving can merge a PR or cut a release; the daemon answers when that's done.
    private static let slow = session(timeout: 300)

    private static let streaming: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        // The daemon pings every 15s; treat 45s of silence as a dead stream.
        c.timeoutIntervalForRequest = 45
        c.timeoutIntervalForResource = .infinity
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private static func session(timeout: TimeInterval) -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = timeout
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }

    // MARK: REST

    func transcript(sessionId: String) async throws -> [TranscriptEntry] {
        try await get("/sessions/\(escape(sessionId))/transcript")
    }

    func alertDetail(id: String) async throws -> AlertDetail {
        try await get("/alerts/\(escape(id))")
    }

    /// `incidents` or `infra`.
    func board(view: String) async throws -> Board {
        try await get("/boards/\(escape(view))", session: Self.boards)
    }

    /// Nil when nothing in Grafana tracks what the alert is about.
    func alertBoard(id: String) async throws -> Board? {
        try await get("/alerts/\(escape(id))/board", session: Self.boards)
    }

    func resolve(actionId: String, response: String?) async throws -> Snapshot {
        struct Body: Encodable { let response: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(response, forKey: .response)  // explicit null, never omitted
            }
            enum CodingKeys: String, CodingKey { case response }
        }
        return try await post("/actions/\(escape(actionId))/resolve", Body(response: response), session: Self.slow)
    }

    func dismiss(actionId: String) async throws -> Snapshot {
        try await post("/actions/\(escape(actionId))/dismiss", Empty())
    }

    func investigate(alertId: String) async throws -> Snapshot {
        try await post("/alerts/\(escape(alertId))/investigate", Empty())
    }

    func feedback(alertId: String, label: AlertView.Feedback) async throws -> Snapshot {
        struct Body: Encodable { let label: String }
        return try await post("/alerts/\(escape(alertId))/feedback", Body(label: label.rawValue))
    }

    func stop(sessionId: String) async throws -> Snapshot {
        try await post("/sessions/\(escape(sessionId))/stop", Empty())
    }

    func message(sessionId: String, text: String) async throws -> Snapshot {
        struct Body: Encodable { let text: String }
        return try await post("/sessions/\(escape(sessionId))/message", Body(text: text))
    }

    /// `body` is a `Partial<Settings>` (see `Settings.patchBody`).
    func updateSettings(body: Data) async throws -> Snapshot {
        try await post("/settings", body: body, session: Self.rest)
    }

    func setPaused(_ paused: Bool) async throws -> Snapshot {
        struct Body: Encodable { let paused: Bool }
        return try await post("/pause", Body(paused: paused))
    }

    // MARK: SSE

    /// One connection to `/events`. Calls `onSnapshot` on the main actor for each
    /// `snapshot` event; returns when the stream closes and throws on transport errors.
    /// Reconnection is the caller's job.
    func streamSnapshots(_ onSnapshot: @MainActor @Sendable (Snapshot) -> Void) async throws {
        let request = makeRequest("/events", method: "GET", accept: "text/event-stream")
        let (bytes, response) = try await Self.streaming.bytes(for: request)
        try Self.check(response, body: nil)
        var parser = SSEParser()
        let decoder = JSON.decoder()
        for try await byte in bytes {
            guard let event = parser.feed(byte) else { continue }
            guard event.name == "snapshot", !event.data.isEmpty else { continue }
            let snapshot = try decoder.decode(Snapshot.self, from: Data(event.data.utf8))
            await onSnapshot(snapshot)
        }
    }

    // MARK: Plumbing

    private struct Empty: Encodable {}

    /// One path segment. Alert ids are "<channelId>:<ts>", so ':' is escaped too.
    private func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/:"))) ?? s
    }

    private func makeRequest(_ path: String, method: String, accept: String = "application/json") -> URLRequest {
        // Built from a string so our own percent-escaping of ids is kept as-is.
        var r = URLRequest(url: URL(string: endpoint.baseURL.absoluteString + path)!)
        r.httpMethod = method
        r.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        r.setValue(accept, forHTTPHeaderField: "Accept")
        return r
    }

    private func get<T: Decodable>(_ path: String, session: URLSession = Self.rest) async throws -> T {
        let (data, response) = try await session.data(for: makeRequest(path, method: "GET"))
        try Self.check(response, body: data)
        return try JSON.decoder().decode(T.self, from: data)
    }

    private func post<B: Encodable, T: Decodable>(_ path: String, _ body: B, session: URLSession = Self.rest) async throws -> T {
        try await post(path, body: JSON.encoder().encode(body), session: session)
    }

    private func post<T: Decodable>(_ path: String, body: Data, session: URLSession) async throws -> T {
        var r = makeRequest(path, method: "POST")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        let (data, response) = try await session.data(for: r)
        try Self.check(response, body: data)
        return try JSON.decoder().decode(T.self, from: data)
    }

    private static func check(_ response: URLResponse, body: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw DaemonError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = body.flatMap { try? JSONDecoder().decode(APIErrorBody.self, from: $0).error } ?? ""
            throw DaemonError.http(http.statusCode, message)
        }
    }
}

/// Minimal text/event-stream parser. Fed one byte at a time; returns an event when a
/// blank line terminates it. Comments (`: ping`) and unknown fields are ignored.
struct SSEParser {
    struct Event: Equatable { var name: String; var data: String }

    private var line: [UInt8] = []
    private var eventName = ""
    private var dataLines: [String] = []
    private var lastWasCR = false

    mutating func feed(_ byte: UInt8) -> Event? {
        switch byte {
        case UInt8(ascii: "\n"):
            if lastWasCR { lastWasCR = false; return nil }  // \r\n already handled
            return endLine()
        case UInt8(ascii: "\r"):
            lastWasCR = true
            return endLine()
        default:
            lastWasCR = false
            line.append(byte)
            return nil
        }
    }

    private mutating func endLine() -> Event? {
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            defer { eventName = ""; dataLines.removeAll() }
            guard !dataLines.isEmpty else { return nil }
            return Event(name: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"))
        }
        let text = String(decoding: line, as: UTF8.self)
        if text.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        default: break
        }
        return nil
    }
}
