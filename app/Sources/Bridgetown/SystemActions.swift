import AppKit

/// Side effects outside the app: URLs, the log file, Terminal takeover.
@MainActor
enum SystemActions {
    /// URLs from the daemon originate partly with agents, so only web, Slack and Revv
    /// links open; anything else (`file:`, `x-apple…`, custom app schemes) is ignored.
    nonisolated static let openableSchemes: Set<String> = ["https", "slack", "revv"]

    nonisolated static func openableURL(_ urlString: String?) -> URL? {
        guard let urlString, let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(), openableSchemes.contains(scheme)
        else { return nil }
        return url
    }

    static func open(_ urlString: String?) {
        guard let url = openableURL(urlString) else { return }
        NSWorkspace.shared.open(url)
    }

    static func openLogs() {
        let url = DaemonProcess.logURL
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: url.path, contents: nil)
        }
        NSWorkspace.shared.open(url)
    }

    /// `cd '<worktree>' && claude --resume <id>` in a new Terminal window.
    /// Returns an error message on failure.
    static func takeOver(_ session: Session) -> String? {
        guard let id = session.claudeSessionId else { return "No Claude session to resume yet" }
        let dir = session.worktree ?? FileManager.default.homeDirectoryForCurrentUser.path
        let shell = "cd \(shellQuote(dir)) && claude --resume \(shellQuote(id))"
        let script = """
        tell application "Terminal"
            do script "\(appleScriptEscape(shell))"
            activate
        end tell
        """
        var error: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&error)
        if let error {
            return (error[NSAppleScript.errorMessage] as? String) ?? "Couldn't open Terminal"
        }
        return nil
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func appleScriptEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }
}
