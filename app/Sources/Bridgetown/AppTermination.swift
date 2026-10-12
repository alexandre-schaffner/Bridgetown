import AppKit

/// Finishes daemon shutdown before letting AppKit end the app.
@MainActor
final class AppTermination {
    private enum State { case running, stopping, ready }
    private var state = State.running

    func reply(
        to app: NSApplication,
        stop: (@escaping () -> Void) -> Bool
    ) -> NSApplication.TerminateReply {
        switch state {
        case .ready: return .terminateNow
        case .stopping: return .terminateCancel
        case .running: break
        }
        state = .stopping
        let waiting = stop {
            self.state = .ready
            app.terminate(nil)
        }
        if !waiting {
            state = .ready
            return .terminateNow
        }
        // From a Swift task, terminateLater blocks main-actor shutdown in AppKit's
        // quit loop. Keep the normal event loop running and retry once ready.
        return .terminateCancel
    }
}
