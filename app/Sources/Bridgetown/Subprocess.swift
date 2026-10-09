import Foundation

/// A tool run to the end without holding a thread: osascript for a takeover, hdiutil, ditto
/// and codesign for an update. The daemon, which outlives a call, is `DaemonProcess`'s.
enum Subprocess {
    struct Output: Sendable {
        let status: Int32
        /// What it said went wrong, trimmed.
        let errors: String

        var succeeded: Bool { status == 0 }
    }

    /// Runs `tool` with nothing on stdin and stdout dropped. Throws only if it couldn't start.
    static func run(_ tool: String, _ arguments: [String]) async throws -> Output {
        try await withCheckedThrowingContinuation { done in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = arguments
            let errors = Pipe()
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = errors
            p.terminationHandler = { p in
                let stderr = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                done.resume(returning: Output(status: p.terminationStatus, errors: stderr.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            do {
                try p.run()
            } catch {
                done.resume(throwing: error)
            }
        }
    }
}
