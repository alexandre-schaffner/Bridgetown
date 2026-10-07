#if DEBUG
import AppKit

/// The app driven without a person, debug builds only. `make e2e` (scripts/e2e.sh) runs:
///
/// - `--e2e <suite.json|none> --e2e-out <dir>`: the suite against the static mock daemon,
///   which the app launches itself (`BRIDGETOWN_DAEMON_CMD`); a PNG and a layout lint per
///   shot, report.json and index.md in `dir`. Exits 0 clean, 1 with lint errors, 2 when
///   the harness itself failed (an unknown step, a missing target, no connection in 20s,
///   the 600s watchdog).
/// - `--e2e-only <glob>`: only the shots whose names match; every step still runs.
/// - `--e2e-baseline <run dir>`: each shot diffed against that run's.
/// - `--e2e-serve`: afterwards, steered over loopback HTTP (`E2EControl`).
/// - `--island-demo`: the real island at the notch cycles hover, banner, open and close,
///   for screen recordings of its motion.
///
/// A run never touches the user's world: the clock stops at the suite's instant, the
/// Keychain is a dictionary, defaults go to a domain of the checkout's own, clicks that would open
/// something are recorded instead, no notification is posted, and the island is drawn
/// off screen rather than at the notch.
@MainActor
final class E2EHarness {
    struct Options {
        /// Nil for `--e2e none`: no suite, straight to serving.
        var suite: URL?
        var out: URL
        var only: String?
        var baseline: URL?
        var serve = false
    }

    enum Mode {
        case run(Options)
        case islandDemo
    }

    /// The suite must be done within this, and a served run that hears nothing for this long ends.
    static let watchdogSeconds = 600

    let mode: Mode
    private var suite = E2ESuite()
    private var runner: E2ERunner?
    private var control: E2EControl?
    private let watchdog = E2EWatchdog()
    /// @AppStorage reads and writes here during a run, never in the app's own defaults.
    private var defaultsDomain = ""

    /// Nil on a normal launch. A malformed command line exits 2 here, before anything starts.
    init?(arguments: [String]) {
        var options = Options(out: URL(fileURLWithPath: "."))
        var suite: String?
        var out: String?
        var demo = false
        var args = arguments.dropFirst().makeIterator()
        func value(_ flag: String) -> String {
            guard let next = args.next(), !next.hasPrefix("--") else { Self.exit(2, "\(flag) needs a value", out: out) }
            return next
        }
        while let arg = args.next() {
            switch arg {
            case "--e2e": suite = value(arg)
            case "--e2e-out": out = value(arg)
            case "--e2e-only": options.only = value(arg)
            case "--e2e-baseline":
                let path = value(arg)
                options.baseline = URL(fileURLWithPath: path, isDirectory: true)
            case "--e2e-serve": options.serve = true
            case "--island-demo": demo = true
            default:
                if arg.hasPrefix("--e2e") || arg.hasPrefix("--preview") { Self.exit(2, "unknown flag \(arg)", out: out) }
            }
        }
        if let suite {
            guard let out else { Self.exit(2, "--e2e needs --e2e-out <dir>", out: nil) }
            options.out = URL(fileURLWithPath: out, isDirectory: true)
            options.suite = suite == "none" ? nil : URL(fileURLWithPath: suite)
            mode = .run(options)
            // Now, with the app delegate: SwiftUI can draw a Settings window it restores
            // before `configure`, and its Accounts tab reads the Keychain as it appears. A
            // rebuilt binary then puts up a Keychain prompt that blocks the run.
            Keychain.inMemory = [:]
        } else if demo {
            mode = .islandDemo
        } else {
            return nil
        }
    }

    // MARK: Lifecycle

    /// Before the daemon, the notifier and the island start: everything a run swaps out.
    func configure(_ app: AppDelegate) {
        guard case let .run(options) = mode else { return }
        // Never the user's daemon: one this run launches, on a port of its own.
        guard case .command = app.daemon.mode else {
            Self.exit(2, "e2e runs launch their own mock daemon: set BRIDGETOWN_DAEMON_CMD (scripts/e2e.sh does)", out: options.out.path)
        }
        guard app.daemon.endpoint.port != DaemonProcess.defaultPort else {
            Self.exit(2, "e2e runs never use port \(DaemonProcess.defaultPort), the real daemon's: set BRIDGETOWN_PORT", out: options.out.path)
        }
        do {
            try FileManager.default.createDirectory(at: options.out, withIntermediateDirectories: true)
            if let url = options.suite { suite = try E2ESuite.load(url) }
        } catch {
            Self.exit(2, "can't read the suite: \(error)", out: options.out.path)
        }

        // Lines reach whoever drives the run as they are printed (the control endpoint's URL), not at exit.
        setvbuf(stdout, nil, _IOLBF, 0)
        AppClock.override = suite.now
        Haptics.muted = true
        Easing.reduceMotionOverride = true
        app.island.offscreen = true
        // Unbundled, the debug binary launches as a regular app and SwiftUI opens its one
        // scene, Settings, on the user's screen. A run draws Settings off screen itself.
        for window in NSApp.windows where window.identifier?.rawValue == "com_apple_SwiftUI_Settings_window" {
            window.close()
        }
        E2EAccessibility.enable()
        let checkout = Self.checkout(of: options.out)
        let root = "/tmp/bt-e2e-\(checkout)"
        defaultsDomain = "xyz.merkl.bridgetown.e2e.\(checkout)"
        app.daemon.extraEnvironment = [
            "MOCK_STATIC": "1",
            "MOCK_NOW": suite.now.formatted(.iso8601),
            "MOCK_WORLD": suite.world,
            "MOCK_ROOT": root,
            // Whatever the shell exported: the store stays in the root, nothing reaches out,
            // and the mock answers this app, in its world as seeded (no forced dry run).
            "BRIDGETOWN_HOME": "\(root)/home",
            "MOCK_GRAFANA": "",
            "MOCK_GITHUB": "",
            "MOCK_API_TOKEN": "",
            "MOCK_EXIT_AT_START": "",
            "BRIDGETOWN_DRY_RUN": "",
        ]
        UserDefaults.standard.removePersistentDomain(forName: defaultsDomain)
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [defaultsDomain] _ in
            UserDefaults.standard.removePersistentDomain(forName: defaultsDomain)
        }
        guard let defaults = UserDefaults(suiteName: defaultsDomain) else {
            Self.exit(2, "no defaults domain \(defaultsDomain) of its own", out: options.out.path)
        }
        let runner = E2ERunner(
            app: app, suite: suite, suiteName: options.suite?.path ?? "none",
            options: E2ERunner.Options(out: options.out, only: options.only, baseline: options.baseline),
            defaults: defaults, commit: ProcessInfo.processInfo.environment["E2E_COMMIT"] ?? "unknown"
        )
        self.runner = runner
        SystemActions.sink = { [weak runner] kind, detail in runner?.record(kind, detail) }
        watchdog.start(seconds: Self.watchdogSeconds) { [weak runner] in
            runner?.fail("watchdog: nothing finished within \(Self.watchdogSeconds)s")
        }
    }

    /// After the island starts. The harness starts the daemon itself, once the steps that
    /// show the app connecting have run.
    func start(_ app: AppDelegate) {
        switch mode {
        case .islandDemo:
            app.startDaemon()
            islandDemo(app)
        case let .run(options):
            guard let runner else { return }
            Task { @MainActor in
                await runner.run()
                print(runner.report.summaryLine)
                guard options.serve, runner.status != 2 else { return finish(app) }
                serve(runner, app, out: options.out)
            }
        }
    }

    private func serve(_ runner: E2ERunner, _ app: AppDelegate, out: URL) {
        Task { @MainActor in
            do {
                let control = try E2EControl(
                    runner: runner,
                    activity: { [watchdog] in watchdog.kick(seconds: Self.watchdogSeconds) },
                    quit: { self.finish(app) }
                )
                self.control = control
                let url = try await control.start(writingTo: out)
                print("e2e control on \(url) (token in \(out.appending(path: "control.json").path))")
                watchdog.kick(seconds: Self.watchdogSeconds)
            } catch {
                runner.fail("control endpoint: \(error)")
                finish(app)
            }
        }
    }

    /// The report written, the defaults domain gone, the mock stopped (it removes its own
    /// root), then out with the run's status, shots taken while serving included.
    private func finish(_ app: AppDelegate) {
        control?.stop()
        runner?.save()
        let status = runner?.status ?? 2
        UserDefaults.standard.removePersistentDomain(forName: defaultsDomain)
        if !app.daemon.stop(completion: { Darwin.exit(status) }) { Darwin.exit(status) }
    }

    /// One id per checkout, for the mock's root (`MOCK_ROOT`) and the run's defaults domain:
    /// paths in shots stay put from run to run, and two worktrees' runs at the same time
    /// share neither (one's telemetry tab once showed up in the other's shots).
    static func checkout(of out: URL) -> String {
        let checkout = out.deletingLastPathComponent().path
        let hash = checkout.utf8.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
        return String(hash, radix: 16)
    }

    /// Before any run state exists: say why, leave a report saying so, and stop.
    private static func exit(_ status: Int32, _ message: String, out: String?) -> Never {
        FileHandle.standardError.write(Data("e2e: \(message)\n".utf8))
        if let out {
            let report = E2EJSON.object(["failure": .string(message), "summary": .object(["shots": .number(0), "errors": .number(0)])])
            try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
            try? Data(report.line.utf8).write(to: URL(fileURLWithPath: out).appending(path: "report.json"))
            try? Data("# Bridgetown e2e\n\nFAILED: \(message)\n".utf8).write(to: URL(fileURLWithPath: out).appending(path: "index.md"))
        }
        Darwin.exit(status)
    }

    // MARK: Island demo

    /// Rest, hover, rest, banner, open, close, on a loop.
    private func islandDemo(_ app: AppDelegate) {
        let island = app.island, store = app.store
        Task { @MainActor in
            for _ in 0..<100 where store.snapshot == nil { try? await Task.sleep(for: .milliseconds(100)) }
            while true {
                try? await Task.sleep(for: .seconds(2))
                island.previewHover(true)
                try? await Task.sleep(for: .seconds(1.5))
                island.previewHover(false)
                try? await Task.sleep(for: .seconds(1.5))
                if let action = store.snapshot?.sortedActions.first { island.showBanner(action) }
                try? await Task.sleep(for: .seconds(3))
                island.open()
                try? await Task.sleep(for: .seconds(3.5))
                island.close()
            }
        }
    }
}

/// Ends a run that hangs. Fires on its own queue, so a stuck main thread can't hold it:
/// the main actor gets a moment to write the report, then the process exits 2 regardless,
/// and the mock daemon, its stdin closed, follows.
final class E2EWatchdog: @unchecked Sendable {
    private let timer = DispatchSource.makeTimerSource(queue: .global())

    func start(seconds: Int, onFire: @escaping @MainActor @Sendable () -> Void) {
        timer.setEventHandler {
            FileHandle.standardError.write(Data("e2e: watchdog fired\n".utf8))
            DispatchQueue.main.async { MainActor.assumeIsolated { onFire() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { Darwin.exit(2) }
        }
        timer.schedule(deadline: .now() + .seconds(seconds))
        timer.resume()
    }

    /// Pushes the deadline back: the control endpoint heard from its agent.
    func kick(seconds: Int) {
        timer.schedule(deadline: .now() + .seconds(seconds))
    }
}
#endif
