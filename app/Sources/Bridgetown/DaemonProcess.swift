import Foundation
import Observation
import Security

/// Owns the daemon child process: resolves what to run, spawns it with the API token and
/// secrets on its stdin (docs/API.md "Launch"), relays its output to `log`, restarts it
/// with backoff when it dies, and terminates it on quit.
///
/// The stdin pipe stays open for the daemon's lifetime. The daemon exits when it closes,
/// so it never outlives the app, even after a crash.
@MainActor
@Observable
final class DaemonProcess {
    /// Chosen in this order (`mode(environment:bundled:)`): an explicit switch in the
    /// environment beats the bundle.
    enum Mode: Equatable {
        /// `BRIDGETOWN_DAEMON_CMD`, run through `/bin/sh -c` (dev).
        case command(String)
        /// `BRIDGETOWN_ATTACH=1`: an already-running daemon, not ours to manage.
        case attach
        /// `bridgetown-daemon` inside the app bundle's Resources.
        case bundled(URL)
        /// Nothing to run and not attaching.
        case missing

        var canManage: Bool {
            switch self {
            case .command, .bundled: true
            case .attach, .missing: false
            }
        }
    }

    /// The child we manage; attached or missing, it stays `idle`.
    enum State: Equatable {
        case idle
        case running(pid: Int32)
        /// Launched again after `after`: it stopped on its own, or `restart` asked (`.zero`).
        case restarting(after: Duration)
        /// Exit 98: something else holds the port. Not restarted until asked to.
        case portInUse
    }

    static let defaultPort = 47621
    /// The daemon's exit status when its port is taken.
    static let portInUseStatus: Int32 = 98
    /// Never handed to the child: secrets travel over stdin, and dev-only switches stay here.
    nonisolated static let strippedEnvironment: Set<String> = [
        "BRIDGETOWN_API_TOKEN", "SLACK_USER_TOKEN", "TYPESAFE_API_KEY",
        "BRIDGETOWN_DAEMON_CMD", "BRIDGETOWN_ATTACH", "BRIDGETOWN_LOG_DIR",
    ]

    let mode: Mode
    let endpoint: DaemonEndpoint
    /// The child's stdout and stderr: `daemon.log` in ~/Library/Logs/Bridgetown, or in
    /// `BRIDGETOWN_LOG_DIR` (an e2e run keeps it with its shots).
    let log: LogFile
    private(set) var state: State = .idle
    /// How the last run ended on its own ("exit 1", "signal 9"), or why it couldn't launch.
    private(set) var lastExit: String?
    /// Runs in a row that ended on their own within 30s of launching (or didn't launch).
    private var consecutiveFailures = 0

    /// Called each time a child is launched: a new daemon to connect to.
    @ObservationIgnored var onLaunch: (() -> Void)?

    #if DEBUG
    /// Added to the child's environment at its next launch: an e2e run picks the mock's
    /// world and clock with it, and restarts to change them.
    @ObservationIgnored var extraEnvironment: [String: String] = [:]
    #endif

    @ObservationIgnored private var process: Process?
    /// Our end of the child's stdin. Closing it tells the daemon to exit.
    @ObservationIgnored private var stdin: FileHandle?
    @ObservationIgnored private var restartTask: Task<Void, Never>?
    @ObservationIgnored private var killTask: Task<Void, Never>?
    @ObservationIgnored private var launchedAt = Date.distantPast
    /// Set while we end the child on purpose: what to do once it has gone.
    @ObservationIgnored private var then: Then?

    private enum Then {
        case relaunch
        case finish(() -> Void)
    }

    init(
        environment env: [String: String] = ProcessInfo.processInfo.environment,
        bundled: URL? = Bundle.main.url(forResource: "bridgetown-daemon", withExtension: nil)
    ) {
        let port = env["BRIDGETOWN_PORT"].flatMap(Int.init) ?? Self.defaultPort

        mode = Self.mode(environment: env, bundled: bundled)

        let logDir = env["BRIDGETOWN_LOG_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
        log = LogFile(url: (logDir ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Bridgetown"))
            .appending(path: "daemon.log"))

        let token = mode == .attach ? (env["BRIDGETOWN_API_TOKEN"] ?? "") : Self.randomToken()
        endpoint = DaemonEndpoint(port: port, token: token)
    }

    /// What to run: an explicit switch in the environment, then the bundle's daemon.
    nonisolated static func mode(environment env: [String: String], bundled: URL?) -> Mode {
        if let cmd = env["BRIDGETOWN_DAEMON_CMD"], !cmd.trimmingCharacters(in: .whitespaces).isEmpty { return .command(cmd) }
        if env["BRIDGETOWN_ATTACH"] == "1" { return .attach }
        if let bundled { return .bundled(bundled) }
        return .missing
    }

    // MARK: Lifecycle

    /// Whether it has stopped on its own again and again, soon after each launch.
    var keepsExiting: Bool { consecutiveFailures >= 2 }

    func start() {
        guard mode.canManage else { return }
        launch()
    }

    /// Restart after secrets changed, or retry after the port was taken or a `stop`. No-op
    /// when attached, and while a stop or restart is under way.
    func restart() {
        guard mode.canManage, then == nil else { return }
        consecutiveFailures = 0
        restartTask?.cancel()
        guard let process else { return launch() }
        state = .restarting(after: .zero)
        terminate(process, then: .relaunch)
    }

    /// Ends the child without blocking (`terminate`) and calls `completion` once it's gone.
    /// Returns false when nothing was running, in which case `completion` is not called.
    @discardableResult
    func stop(completion: @escaping () -> Void) -> Bool {
        restartTask?.cancel()
        guard let process else {
            // A restart it was waiting for is called off.
            if case .restarting = state { state = .idle }
            return false
        }
        var done = completion
        if case let .finish(earlier)? = then { done = { earlier(); completion() } }
        terminate(process, then: .finish(done))
        return true
    }

    /// Closes the child's stdin and sends SIGTERM, then SIGKILL if it is still there 2s
    /// later; `then` runs once it has gone.
    private func terminate(_ process: Process, then: Then) {
        self.then = then
        closeStdin()
        process.terminate()
        let pid = process.processIdentifier
        killTask?.cancel()
        killTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            kill(pid, SIGKILL)
            // The termination handler normally takes it from here; don't hang if it doesn't.
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.didTerminate(pid: pid, status: SIGKILL, reason: .uncaughtSignal)
        }
    }

    // MARK: Spawning

    private func launch() {
        let p = Process()
        switch mode {
        case let .command(cmd):
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            // `exec` so SIGTERM and the stdin pipe reach the daemon, not an intermediate
            // shell; so it is one command (`bun ~/bridgetown/daemon/src/main.ts`), not a list.
            p.arguments = ["-c", "exec \(cmd)"]
        case let .bundled(url):
            p.executableURL = url
        case .attach, .missing:
            return
        }
        p.environment = Self.childEnvironment(
            inherited: ProcessInfo.processInfo.environment,
            port: endpoint.port,
            home: FileManager.default.homeDirectoryForCurrentUser.path
        )
        #if DEBUG
        p.environment?.merge(extraEnvironment) { $1 }
        #endif
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        log.append("\n--- \(Date().formatted(.iso8601)) starting daemon (\(describe(mode))) on port \(endpoint.port) ---\n")
        // Through us rather than straight to the file, so the log can be rotated under a
        // daemon that runs for weeks.
        let output = Pipe()
        p.standardOutput = output
        p.standardError = output
        output.fileHandleForReading.readabilityHandler = { [log] handle in
            let data = handle.availableData
            guard data.isEmpty else { return log.append(data) }
            // End of file: the daemon, and anything it started that kept its output, is gone.
            handle.readabilityHandler = nil
            try? handle.close()
        }
        let input = Pipe()
        p.standardInput = input
        // Writing to a child that already died must fail the write, not kill the app.
        _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)

        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            let reason = proc.terminationReason
            let pid = proc.processIdentifier
            Task { @MainActor in self?.didTerminate(pid: pid, status: status, reason: reason) }
        }

        do {
            try p.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            let why = "couldn't launch: \(error.userMessage)"
            log.append("--- \(why) ---\n")
            lastExit = why
            scheduleRestart()
            return
        }
        // The child has its own copies of the output's write end and of stdin's read end:
        // ours would leak an fd per restart, and the output would never reach its end.
        // (Closing a handle Process already closed is a no-op.)
        try? output.fileHandleForWriting.close()
        try? input.fileHandleForReading.close()
        process = p
        stdin = input.fileHandleForWriting
        launchedAt = Date()
        state = .running(pid: p.processIdentifier)
        onLaunch?()

        let saved = Keychain.secrets() ?? [:]
        let secrets = Secrets(
            apiToken: endpoint.token,
            slackUserToken: saved[.slackUserToken] ?? "",
            typesafeApiKey: saved[.typesafeAPIKey] ?? ""
        )
        do {
            try input.fileHandleForWriting.write(contentsOf: secrets.line())
        } catch {
            // It died before reading; the termination handler restarts it.
            log.append("--- couldn't send secrets to the daemon: \(error.userMessage) ---\n")
        }
    }

    private func closeStdin() {
        try? stdin?.close()
        stdin = nil
    }

    private func didTerminate(pid: Int32, status: Int32, reason: Process.TerminationReason) {
        guard process?.processIdentifier == pid else { return }  // a stale child
        process = nil
        killTask?.cancel()
        closeStdin()
        let how = reason == .uncaughtSignal ? "signal \(status)" : "exit \(status)"
        log.append("--- daemon stopped (\(how)) ---\n")
        let then = self.then
        self.then = nil
        switch then {
        case let .finish(done)?:
            state = .idle
            done()
        case .relaunch?:
            launch()
        case nil:
            lastExit = how
            if reason == .exit, status == Self.portInUseStatus {
                // Restarting can't help while another process holds the port.
                state = .portInUse
                return
            }
            if Date().timeIntervalSince(launchedAt) > 30 { consecutiveFailures = 0 }
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        consecutiveFailures += 1
        let seconds = min(30, 1 << min(consecutiveFailures - 1, 5))  // 1, 2, 4, 8, 16, 30
        let delay = Duration.seconds(seconds)
        state = .restarting(after: delay)
        restartTask?.cancel()
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.launch()
        }
    }

    // MARK: Environment

    /// The launch line on the daemon's stdin.
    struct Secrets: Encodable {
        var apiToken: String
        /// Empty when not set in the Keychain.
        var slackUserToken: String
        var typesafeApiKey: String

        func line() throws -> Data {
            try JSONEncoder().encode(self) + Data("\n".utf8)
        }
    }

    /// The inherited environment with a usable PATH, `BRIDGETOWN_SECRETS=stdin`, and no
    /// secrets: sessions and their subprocesses inherit whatever the daemon gets here.
    nonisolated static func childEnvironment(inherited: [String: String], port: Int, home: String) -> [String: String] {
        var env = inherited.filter { !strippedEnvironment.contains($0.key) }
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.bun/bin", "\(home)/.local/bin"]
        let path = inherited["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = (extra + [path]).joined(separator: ":")
        env["BRIDGETOWN_PORT"] = String(port)
        env["BRIDGETOWN_SECRETS"] = "stdin"
        return env
    }

    private func describe(_ mode: Mode) -> String {
        switch mode {
        case let .command(cmd): "command: \(cmd)"
        case let .bundled(url): url.path
        case .attach: "attach"
        case .missing: "missing"
        }
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    #if DEBUG
    /// One line on the child's stdin after the secrets: the mock daemon reads these as
    /// commands (patch its status, crash with a code). The real daemon ignores them.
    func sendControl(_ line: String) {
        try? stdin?.write(contentsOf: Data((line + "\n").utf8))
    }
    #endif
}
