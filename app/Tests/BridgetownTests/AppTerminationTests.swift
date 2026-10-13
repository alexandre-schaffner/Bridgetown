import Darwin
import Foundation
import Testing

/// The real AppKit quit loop, which only a process of its own can run: `TerminationHarness`,
/// a bare app that quits as Bridgetown does, and then Bridgetown itself.
@Suite struct AppTerminationTests {
    /// The package's executables, which `swift test` builds beside this test bundle.
    private static let products = Bundle(for: Token.self).bundleURL.deletingLastPathComponent()
    private final class Token {}

    @Test(arguments: ["task", "queue", "modal"])
    func quitWaitsForTheShutdownOnce(from: String) async throws {
        #expect(try await harness(from).contains("shutdown finished; stops=1"))
    }

    @Test func quitWithoutADaemonEndsAtOnce() async throws {
        #expect(try await harness("task", "no-daemon").contains("shutdown finished; stops=0"))
    }

    /// A SIGTERM, as logout or `kill` sends: the app quits, and its daemon goes with it.
    @Test func bridgetownQuitsOnSIGTERMAndStopsItsDaemon() async throws {
        let folder = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let app = Process()
        app.executableURL = try executable("Bridgetown")
        app.arguments = ["--e2e", "none", "--e2e-out", folder.appending(path: "run").path]
        app.environment = ProcessInfo.processInfo.environment.merging([
            "BRIDGETOWN_DAEMON_CMD": "/bin/sleep 60",
            "BRIDGETOWN_PORT": String(try freePort()),
            "BRIDGETOWN_LOG_DIR": folder.path,
        ]) { $1 }
        app.standardOutput = FileHandle.nullDevice
        app.standardError = FileHandle.nullDevice
        try app.run()
        var children: [pid_t] = []
        defer {
            if app.isRunning { kill(app.processIdentifier, SIGKILL) }
            for child in children { kill(child, SIGKILL) }
        }
        for _ in 0..<100 where children.isEmpty {
            children = try await childProcesses(of: app.processIdentifier)
            if children.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        }
        try #require(!children.isEmpty, "Bridgetown didn't launch its daemon")
        kill(app.processIdentifier, SIGTERM)
        try await waitForExit(app)
        #expect(app.terminationReason == .exit)
        #expect(app.terminationStatus == 0)
        for child in children {
            #expect(kill(child, 0) == -1 && errno == ESRCH, "daemon \(child) outlived the app")
        }
    }

    // MARK: - Helpers

    private func executable(_ name: String) throws -> URL {
        let url = Self.products.appending(path: name)
        try #require(FileManager.default.isExecutableFile(atPath: url.path), "\(name) isn't built at \(url.path)")
        return url
    }

    /// What `TerminationHarness` printed, once it exited cleanly.
    private func harness(_ arguments: String...) async throws -> String {
        let folder = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let output = folder.appending(path: "out")
        FileManager.default.createFile(atPath: output.path, contents: nil)
        let process = Process()
        process.executableURL = try executable("TerminationHarness")
        process.arguments = arguments
        process.standardOutput = try FileHandle(forWritingTo: output)
        process.standardError = FileHandle.nullDevice
        try process.run()
        try await waitForExit(process)
        #expect(process.terminationReason == .exit)
        #expect(process.terminationStatus == 0)
        return try String(contentsOf: output, encoding: .utf8)
    }

    /// Five seconds, then it is killed: a quit that hangs fails here rather than hanging the run.
    private func waitForExit(_ process: Process) async throws {
        for _ in 0..<500 where process.isRunning {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
        Issue.record("\(process.executableURL?.lastPathComponent ?? "process") didn't quit within five seconds")
    }

    private func childProcesses(of pid: pid_t) async throws -> [pid_t] {
        let pgrep = Process()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-P", String(pid)]
        let pipe = Pipe()
        pgrep.standardOutput = pipe
        try pgrep.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        pgrep.waitUntilExit()
        return String(decoding: output, as: UTF8.self).split(whereSeparator: \.isNewline).compactMap { pid_t($0) }
    }

    private func temporaryFolder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "bt-termination-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A port nothing listens on: the one the system picks for a socket bound to port 0.
    private func freePort() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0
            }
        }
        try #require(bound)
        return UInt16(bigEndian: address.sin_port)
    }
}
