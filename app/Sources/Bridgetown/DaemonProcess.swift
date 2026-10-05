import Foundation
import Observation
import Security

/// Owns the daemon child process: resolves what to run, spawns it with the API token and
/// secrets on its stdin (docs/API.md "Launch"), pipes output to `logURL`, restarts it with
/// backoff when it dies, and terminates it on quit.
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

    enum State: Equatable {
        case idle
        case running(pid: Int32)
        case restarting(after: Duration)
        case attached
        case missing
        /// Exit 98: something else holds the port. Not restarted until asked to.
        case portInUse
        case failed(String)
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
    let logURL: URL
    private(set) var state: State = .idle

    #if DEBUG
    /// Added to the child's environment at its next launch: an e2e run picks the mock's
    /// world and clock with it, and restarts to change them.
    @ObservationIgnored var extraEnvironment: [String: String] = [:]
    #endif

    @ObservationIgnored private var process: Process?
    /// Our end of the child's stdin. Closing it tells the daemon to exit.
    @ObservationIgnored private var stdin: FileHandle?
    @ObservationIgnored private var restartTask: Task<Void, Never>?
    @ObservationIgnored private var consecutiveFailures = 0
    @ObservationIgnored private var launchedAt = Date.distantPast
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var restartRequested = false
    @ObservationIgnored private var onStopped: (() -> Void)?

    init(environment env: [String: String] = ProcessInfo.processInfo.environment) {
        let port = env["BRIDGETOWN_PORT"].flatMap(Int.init) ?? Self.defaultPort

        mode = Self.mode(environment: env, bundled: Bundle.main.url(forResource: "bridgetown-daemon", withExtension: nil))

        let logDir = env["BRIDGETOWN_LOG_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
        logURL = (logDir ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Bridgetown"))
            .appending(path: "daemon.log")

        let token = mode == .attach ? (env["BRIDGETOWN_API_TOKEN"] ?? "") : Self.randomToken()
        endpoint = DaemonEndpoint(port: port, token: token)

        // Writing secrets to a child that already died must fail the write, not kill the app.
        signal(SIGPIPE, SIG_IGN)
    }

    /// What to run: an explicit switch in the environment, then the bundle's daemon.
    nonisolated static func mode(environment env: [String: String], bundled: URL?) -> Mode {
        if let cmd = env["BRIDGETOWN_DAEMON_CMD"], !cmd.trimmingCharacters(in: .whitespaces).isEmpty { return .command(cmd) }
        if env["BRIDGETOWN_ATTACH"] == "1" { return .attach }
        if let bundled { return .bundled(bundled) }
        return .missing
    }

    // MARK: Lifecycle

    func start() {
        stopping = false
        switch mode {
        case .attach: state = .attached
        case .missing: state = .missing
        case .command, .bundled: launch()
        }
    }

    /// Restart after secrets changed, or retry after the port was taken. No-op when attached.
    func restart() {
        guard mode.canManage else { return }
        consecutiveFailures = 0
        restartTask?.cancel()
        if let process, process.isRunning {
            // The termination handler sees `restartRequested` and relaunches immediately.
            restartRequested = true
            signalStop(process)
        } else {
            launch()
        }
    }

    /// Ends the child without blocking: closes its stdin, sends SIGTERM, and SIGKILLs it
    /// after 2s. Calls `completion` once it's gone. Returns false when nothing was
    /// running, in which case `completion` is not called.
    @discardableResult
    func stop(completion: @escaping () -> Void) -> Bool {
        stopping = true
        restartTask?.cancel()
        guard let process, process.isRunning else { return false }
        onStopped = completion
        signalStop(process)
        let pid = process.processIdentifier
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, self.process?.processIdentifier == pid else { return }
            kill(pid, SIGKILL)
            // The termination handler normally finishes the stop; don't hang quit if it doesn't.
            try? await Task.sleep(for: .milliseconds(500))
            self.finishStop()
        }
        return true
    }

    private func signalStop(_ process: Process) {
        closeStdin()
        process.terminate()
    }

    private func finishStop() {
        let done = onStopped
        onStopped = nil
        done?()
    }

    // MARK: Spawning

    private func launch() {
        let p = Process()
        switch mode {
        case let .command(cmd):
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            // `exec` so SIGTERM and the stdin pipe reach the daemon, not an intermediate shell.
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

        let log = openLog()
        if let log {
            let header = "\n--- \(Date().formatted(.iso8601)) starting daemon (\(describe(mode))) on port \(endpoint.port) ---\n"
            log.write(Data(header.utf8))
            p.standardOutput = log
            p.standardError = log
        }
        let input = Pipe()
        p.standardInput = input

        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            let reason = proc.terminationReason
            let pid = proc.processIdentifier
            Task { @MainActor in self?.didTerminate(pid: pid, status: status, reason: reason) }
        }

        do {
            try p.run()
        } catch {
            try? log?.close()
            process = nil
            state = .failed(error.userMessage)
            scheduleRestart()
            return
        }
        // The child has its own copies of the log and of stdin's read end; ours would
        // leak an fd per restart. (Closing a handle Process already closed is a no-op.)
        try? log?.close()
        try? input.fileHandleForReading.close()
        process = p
        stdin = input.fileHandleForWriting
        launchedAt = Date()
        state = .running(pid: p.processIdentifier)

        let secrets = Secrets(
            apiToken: endpoint.token,
            slackUserToken: Keychain.read(.slackUserToken) ?? "",
            typesafeApiKey: Keychain.read(.typesafeAPIKey) ?? ""
        )
        do {
            try input.fileHandleForWriting.write(contentsOf: secrets.line())
        } catch {
            // It died before reading; the termination handler restarts it.
            appendLog("--- couldn't send secrets to the daemon: \(error.userMessage) ---\n")
        }
    }

    private func closeStdin() {
        try? stdin?.close()
        stdin = nil
    }

    private func didTerminate(pid: Int32, status: Int32, reason: Process.TerminationReason) {
        guard process?.processIdentifier == pid else { return }  // a stale child
        process = nil
        closeStdin()
        if stopping {
            state = .idle
            finishStop()
            return
        }
        if restartRequested {
            restartRequested = false
            launch()
            return
        }
        let how = reason == .uncaughtSignal ? "signal \(status)" : "exit \(status)"
        appendLog("--- daemon stopped (\(how)) ---\n")
        if reason == .exit, status == Self.portInUseStatus {
            // Restarting can't help while another process holds the port.
            state = .portInUse
            return
        }
        if Date().timeIntervalSince(launchedAt) > 30 { consecutiveFailures = 0 }
        scheduleRestart()
    }

    private func scheduleRestart() {
        consecutiveFailures += 1
        let seconds = min(30, 1 << min(consecutiveFailures - 1, 5))  // 1, 2, 4, 8, 16, 30
        let delay = Duration.seconds(seconds)
        state = .restarting(after: delay)
        restartTask?.cancel()
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, !self.stopping else { return }
            self.launch()
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

    // MARK: Log file

    private func openLog() -> FileHandle? {
        let fm = FileManager.default
        let dir = logURL.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        // Keep one previous log once the current one passes 10 MB.
        if let size = (try? fm.attributesOfItem(atPath: logURL.path))?[.size] as? Int, size > 10_000_000 {
            let old = logURL.appendingPathExtension("1")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: logURL, to: old)
        }
        if !fm.fileExists(atPath: logURL.path) {
            fm.createFile(atPath: logURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return nil }
        _ = try? handle.seekToEnd()
        return handle
    }

    private func appendLog(_ line: String) {
        guard let h = openLog() else { return }
        h.write(Data(line.utf8))
        try? h.close()
    }
}
