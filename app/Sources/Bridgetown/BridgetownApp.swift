import AppKit
import SwiftUI

@main
struct BridgetownApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var app

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environment(app.store)
                .environment(app.daemon)
                .environment(\.popoverHeight, app.popoverHeight)
        } label: {
            MenuBarLabel(store: app.store)
        }
        .menuBarExtraStyle(.window)

        SwiftUI.Settings {
            SettingsView()
                .environment(app.store)
                .environment(app.daemon)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    let daemon = DaemonProcess()
    let notifier = Notifier()

    #if DEBUG
    let preview = PreviewHarness(arguments: ProcessInfo.processInfo.arguments)
    #endif

    private var signalSources: [DispatchSourceSignal] = []

    var popoverHeight: CGFloat {
        #if DEBUG
        preview.popoverHeight ?? Metrics.height
        #else
        Metrics.height
        #endif
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Geist.register()
        NSApp.setActivationPolicy(.accessory)
        installSignalHandlers()

        notifier.start()
        store.onSnapshot = { [weak notifier] _, next in notifier?.snapshotChanged(next) }

        daemon.start()
        if daemon.mode != .missing {
            store.connect(to: daemon.endpoint)
        }

        #if DEBUG
        preview.start(store: store, daemon: daemon, popoverHeight: popoverHeight)
        #endif
    }

    /// Quit waits for the daemon to shut down (at most ~2.5s) without blocking the main
    /// thread, then lets the app go.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let waiting = daemon.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return waiting ? .terminateLater : .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Route SIGTERM/SIGINT through `terminate` so the daemon child is cleaned up.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated { NSApp.terminate(nil) }
            }
            source.resume()
            signalSources.append(source)
        }
    }
}
