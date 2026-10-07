import Foundation
import Testing
@testable import Bridgetown

@Suite struct DaemonHealthTests {
    private let bundled = DaemonProcess.Mode.bundled(URL(fileURLWithPath: "/x"))

    @Test func aDaemonStillStartingIsNotTrouble() {
        let health = DaemonHealth(mode: bundled, state: .running(pid: 1), connection: .connecting, lastConnectError: "Daemon not reachable")
        #expect(health == .starting(lastError: "Daemon not reachable"))
        #expect(!health.isTrouble)
    }

    /// Saving tokens restarts the daemon: its stream closing on the way is not trouble.
    @Test func aRestartIsNotTrouble() {
        let health = DaemonHealth(mode: bundled, state: .restarting(after: .zero), connection: .disconnected("Daemon closed the connection"))
        #expect(health == .restarting)
        #expect(!health.isTrouble)
    }

    @Test func aDaemonThatWontStayUpIsTrouble() {
        for state in [DaemonProcess.State.restarting(after: .seconds(2)), .running(pid: 1)] {
            let health = DaemonHealth(mode: bundled, state: state, exiting: "exit 1", connection: .connecting)
            #expect(health == .keepsExiting("exit 1"))
            #expect(health.isTrouble)
        }
    }

    /// Once reached, a stream that drops while the daemon runs is a lost connection, however
    /// it started.
    @Test func aDroppedStreamToARunningDaemonIsDisconnected() {
        let health = DaemonHealth(mode: bundled, state: .running(pid: 1), exiting: "exit 1", connection: .disconnected("Daemon timed out"))
        #expect(health == .disconnected("Daemon timed out"))
        #expect(health.isTrouble)
    }

    @Test func blockersComeFirst() {
        #expect(DaemonHealth(mode: .missing, state: .idle, connection: .connecting) == .notBundled)
        #expect(DaemonHealth(mode: bundled, state: .portInUse, connection: .rejected) == .portInUse(byAnotherDaemon: true))
        #expect(DaemonHealth(mode: bundled, state: .portInUse, connection: .connecting) == .portInUse(byAnotherDaemon: false))
        #expect(DaemonHealth(mode: .attach, state: .idle, connection: .rejected) == .rejected)
        #expect(DaemonHealth(mode: .attach, state: .idle, connection: .connected) == .connected)
    }
}

@Suite struct DaemonLaunchTests {
    @Test func childEnvironmentCarriesNoSecrets() {
        let inherited = [
            "PATH": "/usr/bin",
            "HOME": "/Users/me",
            "BRIDGETOWN_API_TOKEN": "dev",
            "SLACK_USER_TOKEN": "xoxp-1",
            "TYPESAFE_API_KEY": "ts_1",
            "BRIDGETOWN_DAEMON_CMD": "bun src/main.ts",
            "BRIDGETOWN_ATTACH": "1",
            "BRIDGETOWN_LOG_DIR": "/tmp/run",
        ]
        let env = DaemonProcess.childEnvironment(inherited: inherited, port: 47622, home: "/Users/me")
        for key in ["BRIDGETOWN_API_TOKEN", "SLACK_USER_TOKEN", "TYPESAFE_API_KEY", "BRIDGETOWN_DAEMON_CMD", "BRIDGETOWN_ATTACH", "BRIDGETOWN_LOG_DIR"] {
            #expect(env[key] == nil, "\(key)")
        }
        #expect(env["BRIDGETOWN_SECRETS"] == "stdin")
        #expect(env["BRIDGETOWN_PORT"] == "47622")
        #expect(env["HOME"] == "/Users/me")
        #expect(env["PATH"]?.hasSuffix(":/usr/bin") == true)
        #expect(env["PATH"]?.contains("/Users/me/.bun/bin") == true)
    }

    @Test func anExplicitSwitchBeatsTheBundledDaemon() {
        let bundled = URL(fileURLWithPath: "/Applications/Bridgetown.app/Contents/Resources/bridgetown-daemon")
        #expect(DaemonProcess.mode(environment: ["BRIDGETOWN_ATTACH": "1"], bundled: bundled) == .attach)
        #expect(DaemonProcess.mode(environment: ["BRIDGETOWN_ATTACH": "1", "BRIDGETOWN_DAEMON_CMD": "bun main.ts"], bundled: bundled) == .command("bun main.ts"))
        #expect(DaemonProcess.mode(environment: [:], bundled: bundled) == .bundled(bundled))
        #expect(DaemonProcess.mode(environment: ["BRIDGETOWN_DAEMON_CMD": " "], bundled: nil) == .missing)
    }

    @MainActor @Test func theLogGoesToTheRunWhenItAsks() {
        #expect(DaemonProcess(environment: ["BRIDGETOWN_LOG_DIR": "/tmp/run"]).log.url.path == "/tmp/run/daemon.log")
        #expect(DaemonProcess(environment: [:]).log.url.path.hasSuffix("/Library/Logs/Bridgetown/daemon.log"))
    }

    /// A real child (`sleep`), its log in a temp dir, the Keychain kept out of it.
    @MainActor @Test func aDaemonRestartedAfterAStopIsRestartedWhenItDies() async throws {
        Keychain.inMemory = [:]
        let logs = FileManager.default.temporaryDirectory.appending(path: "bt-daemon-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: logs) }
        let daemon = DaemonProcess(environment: ["BRIDGETOWN_DAEMON_CMD": "sleep 30", "BRIDGETOWN_LOG_DIR": logs.path])
        daemon.start()
        await withCheckedContinuation { done in
            if !daemon.stop(completion: { done.resume() }) { done.resume() }
        }
        daemon.restart()
        guard case let .running(pid) = daemon.state else {
            Issue.record("not running after restart: \(daemon.state)")
            return
        }
        kill(pid, SIGKILL)
        for _ in 0..<150 where daemon.state == .running(pid: pid) {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(daemon.state == .restarting(after: .seconds(1)))
        daemon.stop {}
    }

    @MainActor @Test func stoppingWhileARestartWaitsCallsItOff() async throws {
        Keychain.inMemory = [:]
        let logs = FileManager.default.temporaryDirectory.appending(path: "bt-daemon-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: logs) }
        let daemon = DaemonProcess(environment: ["BRIDGETOWN_DAEMON_CMD": "false", "BRIDGETOWN_LOG_DIR": logs.path])
        daemon.start()
        for _ in 0..<150 where daemon.state != .restarting(after: .seconds(1)) {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(daemon.state == .restarting(after: .seconds(1)))
        #expect(daemon.stop {} == false)
        #expect(daemon.state == .idle)
    }

    /// A child that ignores SIGTERM and its stdin closing is killed 2s later, so a restart
    /// can't wedge with the old one still holding the port.
    @MainActor @Test func aRestartKillsAChildThatWontGo() async throws {
        Keychain.inMemory = [:]
        let logs = FileManager.default.temporaryDirectory.appending(path: "bt-daemon-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: logs) }
        let daemon = DaemonProcess(environment: [
            "BRIDGETOWN_DAEMON_CMD": "perl -e '$SIG{TERM} = \"IGNORE\"; sleep 30'", "BRIDGETOWN_LOG_DIR": logs.path,
        ])
        daemon.start()
        guard case let .running(stubborn) = daemon.state else {
            Issue.record("not running: \(daemon.state)")
            return
        }
        try await Task.sleep(for: .milliseconds(200))  // perl has set its handler
        daemon.restart()
        #expect(daemon.state == .restarting(after: .zero))
        for _ in 0..<200 where daemon.state == .restarting(after: .zero) {
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case let .running(next) = daemon.state else {
            Issue.record("not relaunched: \(daemon.state)")
            return
        }
        #expect(next != stubborn)
        #expect(kill(stubborn, 0) != 0)
        daemon.stop {}
        kill(next, SIGKILL)
    }

    /// Stopping on its own soon after each launch is how a daemon that can't start looks;
    /// the second time in a row it says so, with how the last run ended.
    @MainActor @Test func aDaemonThatKeepsExitingSaysHow() async throws {
        Keychain.inMemory = [:]
        let logs = FileManager.default.temporaryDirectory.appending(path: "bt-daemon-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: logs) }
        let daemon = DaemonProcess(environment: ["BRIDGETOWN_DAEMON_CMD": "sh -c 'exit 3'", "BRIDGETOWN_LOG_DIR": logs.path])
        daemon.start()
        for _ in 0..<150 where !daemon.keepsExiting {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(daemon.keepsExiting)
        #expect(daemon.lastExit == "exit 3")
        daemon.stop {}
    }

    @MainActor @Test func aDaemonThatCantLaunchIsLoggedAndRetried() throws {
        let logs = FileManager.default.temporaryDirectory.appending(path: "bt-daemon-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: logs) }
        let daemon = DaemonProcess(environment: ["BRIDGETOWN_LOG_DIR": logs.path], bundled: logs.appending(path: "bridgetown-daemon"))
        daemon.start()
        #expect(daemon.state == .restarting(after: .seconds(1)))
        #expect(daemon.lastExit?.hasPrefix("couldn't launch") == true)
        let log = try String(contentsOf: daemon.log.url, encoding: .utf8)
        #expect(log.contains("couldn't launch"))
        daemon.stop {}
    }

    /// Its output goes through the app to `daemon.log`, both streams.
    @MainActor @Test func theDaemonsOutputReachesTheLog() async throws {
        Keychain.inMemory = [:]
        let logs = FileManager.default.temporaryDirectory.appending(path: "bt-daemon-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: logs) }
        let daemon = DaemonProcess(environment: [
            "BRIDGETOWN_DAEMON_CMD": "sh -c 'echo on stdout; echo on stderr >&2; exec sleep 30'", "BRIDGETOWN_LOG_DIR": logs.path,
        ])
        daemon.start()
        var log = ""
        // The launch line quotes the command; the output is what ends in a newline.
        for _ in 0..<150 where !(log.contains("on stdout\n") && log.contains("on stderr\n")) {
            try await Task.sleep(for: .milliseconds(20))
            log = (try? String(contentsOf: daemon.log.url, encoding: .utf8)) ?? ""
        }
        #expect(log.contains("starting daemon"))
        #expect(log.contains("on stdout\n"))
        #expect(log.contains("on stderr\n"))
        await withCheckedContinuation { done in
            if !daemon.stop(completion: { done.resume() }) { done.resume() }
        }
    }

    @Test func secretsLineIsOneJSONObject() throws {
        let line = try DaemonProcess.Secrets(apiToken: "tok", slackUserToken: "xoxp-1", typesafeApiKey: "").line()
        #expect(line.last == UInt8(ascii: "\n"))
        #expect(line.dropLast().contains(UInt8(ascii: "\n")) == false)
        let json = try #require(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: String])
        #expect(json == ["apiToken": "tok", "slackUserToken": "xoxp-1", "typesafeApiKey": ""])
    }
}
