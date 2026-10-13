import AppKit
import Termination

/// A bare app that quits the way Bridgetown does, for `AppTerminationTests`. Its quit
/// waits for a shutdown that reports back on the main actor, as `DaemonProcess` does.
///
///     TerminationHarness task|queue|modal [no-daemon]
///
/// `task` and `queue` quit from a main-actor task or a main-queue block (a SIGTERM's);
/// `modal` from under a modal window. It prints how many shutdowns it waited for.
@MainActor
final class Delegate: NSObject, NSApplicationDelegate {
    let from = CommandLine.arguments[1]
    let daemon = !CommandLine.arguments.contains("no-daemon")
    var stops = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.prohibited)
        switch from {
        case "task": Task { AppTermination.quit() }
        case "queue": DispatchQueue.main.async { AppTermination.quit() }
        case "modal":
            let window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: true)
            DispatchQueue.main.async { AppTermination.quit() }
            NSApp.runModal(for: window)
            fatalError("the modal window outlived quit")
        default: fatalError("quit from task, queue or modal")
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard daemon else { return .terminateNow }
        stops += 1
        Task {
            try? await Task.sleep(for: .milliseconds(100))
            // Asked again while it waits: AppKit doesn't stop twice.
            AppTermination.quit()
            try? await Task.sleep(for: .milliseconds(100))
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        print("shutdown finished; stops=\(stops)")
    }
}

@main
struct Harness {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = Delegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
