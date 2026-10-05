import Foundation
import Observation

/// App-wide state: the latest daemon Snapshot, connection health, navigation and every
/// user action.
@MainActor
@Observable
final class Store {
    enum Connection: Equatable {
        case connecting
        case connected
        case disconnected(String)
        /// The daemon on our port answered 401: it isn't ours, or the token is wrong.
        case rejected
    }

    /// What the open island shows. Back always returns to the overview, so "Back" from a
    /// session opened via an alert doesn't land on the alert.
    enum Route: Equatable {
        case overview
        case session(String)
        case alert(String)
    }

    private(set) var snapshot: Snapshot?
    private(set) var connection: Connection = .connecting
    private(set) var route: Route = .overview
    /// Ids of actions/alerts/sessions with a request in flight, for button spinners.
    private(set) var busy: Set<String> = []
    /// Last failed user action, shown briefly in the header.
    private(set) var flash: String?
    /// Why this connection hasn't succeeded yet (while still `.connecting`).
    private(set) var lastConnectError: String?

    /// Called with (previous, next) on every snapshot change. Used for notifications.
    @ObservationIgnored var onSnapshot: ((Snapshot?, Snapshot) -> Void)?

    @ObservationIgnored private var client: DaemonClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var flashTask: Task<Void, Never>?

    @ObservationIgnored private var settingsDebounce: Task<Void, Never>?
    @ObservationIgnored private var pendingSettings = PendingSettings()
    /// The settings as the daemon last sent them.
    @ObservationIgnored private var serverSettings: Settings?

    // MARK: Connection

    /// Starts over on `endpoint`: at launch, and each time the app launches its daemon again.
    func connect(to endpoint: DaemonEndpoint) {
        streamTask?.cancel()
        let client = DaemonClient(endpoint: endpoint)
        self.client = client
        connection = .connecting
        lastConnectError = nil
        streamTask = Task { [weak self] in
            var attempt = 0
            var reached = false
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await client.streamSnapshots { snap in
                        attempt = 0
                        reached = true
                        self.apply(snap)
                        if self.connection != .connected { self.connection = .connected }
                    }
                    // Clean close: the daemon went away or restarted.
                    self.markDisconnected("Daemon closed the connection", reached: reached)
                } catch is CancellationError {
                    return
                } catch {
                    if Task.isCancelled { return }
                    if case DaemonError.http(401, _) = error {
                        self.connection = .rejected
                    } else {
                        self.markDisconnected(error.userMessage, reached: reached)
                    }
                }
                attempt += 1
                // 0.5, 1, 2, 4, 8 … capped at 10s.
                let delay = min(10.0, 0.5 * pow(2, Double(min(attempt - 1, 5))))
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    /// Until this connection has worked once, a failed try is part of connecting, so a
    /// daemon that is still starting doesn't flash an error.
    private func markDisconnected(_ reason: String, reached: Bool) {
        if reached {
            connection = .disconnected(reason)
        } else {
            connection = .connecting
            lastConnectError = reason
        }
    }

    private func apply(_ next: Snapshot) {
        serverSettings = next.settings
        let shown = withLocalSettings(next)
        let previous = snapshot
        guard previous != shown else { return }
        snapshot = shown
        onSnapshot?(previous, shown)
        if case let .session(id) = route, shown.session(id: id) == nil { back() }
    }

    // MARK: Navigation

    /// Navigation you asked for (a row, a link). `back()` is also called when a session
    /// disappears from under you, so only this one taps the trackpad.
    func show(_ route: Route) {
        guard route != self.route else { return }
        Haptics.perform(.generic, "store.show")
        self.route = route
    }

    func back() {
        route = .overview
    }

    // MARK: Derived

    var activeSessions: [Session] { snapshot?.activeSessions ?? [] }
    var actions: [Action] { snapshot?.actions ?? [] }

    func isBusy(_ id: String) -> Bool { busy.contains(id) }

    // MARK: Actions

    /// Opens the action's `url` first when it has one (escalations, review links).
    /// A resolve can take minutes (merging, tagging); when our request gives up while the
    /// daemon still reports the action in flight, that isn't a failure, so say nothing.
    func resolve(_ action: Action, response: String? = nil, onSuccess: (() -> Void)? = nil) {
        if let url = action.url { SystemActions.open(url) }
        perform(
            action.id,
            stillWorking: { [weak self] error in
                (error.isTimeout || (error as? DaemonError)?.statusCode == 409)
                    && self?.snapshot?.action(id: action.id)?.inFlight == true
            },
            onSuccess: onSuccess
        ) { try await $0.resolve(actionId: action.id, response: response) }
    }

    func dismiss(_ action: Action) {
        perform(action.id) { try await $0.dismiss(actionId: action.id) }
    }

    func investigate(_ alert: AlertView) {
        perform(alert.id) { try await $0.investigate(alertId: alert.id) }
    }

    func feedback(_ alert: AlertView, _ label: AlertView.Feedback) {
        perform(alert.id) { try await $0.feedback(alertId: alert.id, label: label) }
    }

    func stop(_ session: Session) {
        perform(session.id) { try await $0.stop(sessionId: session.id) }
    }

    static func messageKey(_ session: Session) -> String { "\(session.id):message" }

    /// `onSuccess` runs once the daemon accepted the message (clear the field then, not before).
    func message(_ session: Session, text: String, onSuccess: (() -> Void)? = nil) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        perform(Self.messageKey(session), onSuccess: onSuccess) { try await $0.message(sessionId: session.id, text: text) }
    }

    func setPaused(_ paused: Bool) {
        if var snap = snapshot { snap.status.paused = paused; snapshot = snap }  // optimistic
        perform("pause") { try await $0.setPaused(paused) }
    }

    // MARK: Settings

    /// Applies `edit` locally at once, then POSTs the changed fields. With `debounce`,
    /// rapid edits (sliders, text fields) coalesce into one request.
    func editSettings(debounce: Bool = false, _ edit: (inout Settings) -> Void) {
        guard let snap = snapshot else { return }
        var next = snap.settings
        edit(&next)
        guard pendingSettings.record(from: snap.settings, to: next) else { return }
        snapshot = withLocalSettings(snap)

        // A later edit calls off the wait, never a request under way: that one would fail
        // as "cancelled" and take back the fields it carried.
        settingsDebounce?.cancel()
        guard debounce else { return sendSettings() }
        settingsDebounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.sendSettings()
        }
    }

    /// POSTs the unsent fields, unless a request is out: then they go once it is answered.
    private func sendSettings() {
        guard let client, let body = pendingSettings.beginSend() else { return }
        Task {
            let result: Result<Snapshot, Error>
            do {
                result = .success(try await client.updateSettings(body: body))
            } catch {
                result = .failure(error)
            }
            pendingSettings.endSend()
            switch result {
            case let .success(next):
                apply(next)
            case let .failure(error):
                show(error.userMessage)
                // Back to what the daemon last sent for these fields.
                if let snap = snapshot, let server = serverSettings {
                    snapshot = withLocalSettings(snap.with(settings: server))
                }
            }
            sendSettings()
        }
    }

    /// `snap` with every settings edit the daemon hasn't confirmed shown as edited.
    private func withLocalSettings(_ snap: Snapshot) -> Snapshot {
        guard pendingSettings.isPending else { return snap }
        return snap.with(settings: pendingSettings.shown(over: snap.settings))
    }

    // MARK: Fetches

    func alertDetail(id: String) async throws -> AlertDetail {
        guard let client else { throw DaemonError.notConnected }
        return try await client.alertDetail(id: id)
    }

    func board(view: String) async throws -> Board {
        guard let client else { throw DaemonError.notConnected }
        return try await client.board(view: view)
    }

    func alertBoard(alertId: String) async throws -> Board? {
        guard let client else { throw DaemonError.notConnected }
        return try await client.alertBoard(id: alertId)
    }

    func logSweep() async throws -> LogSweep {
        guard let client else { throw DaemonError.notConnected }
        return try await client.logs()
    }

    func transcript(for session: Session) async throws -> [TranscriptEntry] {
        guard let client else { throw DaemonError.notConnected }
        return try await client.transcript(sessionId: session.id)
    }

    // MARK: Plumbing

    /// Runs `call`, applies the Snapshot it returns, and flashes the error unless
    /// `stillWorking` says the daemon is still on it.
    private func perform(
        _ key: String,
        stillWorking: ((Error) -> Bool)? = nil,
        onSuccess: (() -> Void)? = nil,
        _ call: @escaping @Sendable (DaemonClient) async throws -> Snapshot
    ) {
        guard let client else {
            show(DaemonError.notConnected.userMessage)
            return
        }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                apply(try await call(client))
                onSuccess?()
            } catch {
                if stillWorking?(error) == true { return }
                show(error.userMessage)
            }
        }
    }

    func show(_ message: String) {
        flash = message
        flashTask?.cancel()
        flashTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            self?.flash = nil
        }
    }
}

private extension Snapshot {
    func with(settings: Settings) -> Snapshot {
        var s = self
        s.settings = settings
        s.status.dryRun = settings.dryRun
        return s
    }
}

/// Settings edits the daemon hasn't confirmed. An edited field keeps its local value over
/// any snapshot until the request carrying it has been answered, so an SSE echo of an
/// older state never undoes a keystroke or a half-typed path.
///
/// One request at a time: edits made while one is out wait for its answer, so answers
/// come back in the order they were sent and an older one never has the last word.
struct PendingSettings {
    /// The settings as the user last edited them.
    private(set) var local: Settings?
    /// Edited fields not POSTed yet.
    private(set) var unsent: Set<Settings.CodingKeys> = []
    /// The fields of the request that is out, not answered yet.
    private var sending: Set<Settings.CodingKeys> = []

    var isPending: Bool { !unsent.isEmpty || !sending.isEmpty }

    /// Records an edit from `current` to `next`. False when nothing changed.
    mutating func record(from current: Settings, to next: Settings) -> Bool {
        let changed = current.changedKeys(to: next)
        guard !changed.isEmpty else { return false }
        // Fields edited earlier keep their local value; `current` already shows them.
        local = next
        unsent.formUnion(changed)
        return true
    }

    /// Takes the unsent fields for the next request, as its `POST /settings` body. Nil
    /// while a request is out: `endSend` makes way for the next.
    mutating func beginSend() -> Data? {
        guard sending.isEmpty, let local, !unsent.isEmpty, let body = try? local.patchBody(unsent) else { return nil }
        sending = unsent
        unsent = []
        return body
    }

    /// The request that was out was answered (or failed).
    mutating func endSend() {
        sending = []
    }

    /// `server` with every unconfirmed field taken from the local edit.
    func shown(over server: Settings) -> Settings {
        guard let local else { return server }
        return server.overlaid(unsent.union(sending), from: local)
    }
}
