import AppKit
import SwiftUI

@main
struct BridgetownApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var app

    // No menu bar item: the island in the notch is the app.
    var body: some Scene {
        SwiftUI.Settings {
            SettingsView()
                .environment(app.store)
                .environment(app.daemon)
                .environment(\.openURL, SystemActions.openLink)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    let daemon = DaemonProcess()
    let notifier = Notifier()
    private(set) lazy var island = IslandController(store: store, daemon: daemon)

    #if DEBUG
    /// `--e2e …` or `--island-demo` (E2E/E2EHarness.swift); nil on a normal launch.
    let harness = E2EHarness(arguments: ProcessInfo.processInfo.arguments)
    #endif

    private var signalSources: [DispatchSourceSignal] = []
    private var newActions = NewActions()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Geist.register()
        NSApp.setActivationPolicy(.accessory)
        installSignalHandlers()

        #if DEBUG
        // Before anything starts: a run swaps out the clock, the Keychain, side effects,
        // the daemon's environment and the island's panel, and posts no notifications.
        harness?.configure(self)
        if harness == nil { notifier.start() }
        #else
        notifier.start()
        #endif
        notifier.onOpen = { [weak self] in self?.island.open() }
        // Each new "Needs you" is both a notification and a banner under the notch.
        store.onSnapshot = { [weak self] _, next in
            guard let self else { return }
            let fresh = newActions.update(next)
            guard let first = fresh.first else { return }
            notifier.post(fresh)
            island.announce(first)
        }
        island.start()

        #if DEBUG
        // It starts the daemon itself, once it has shown the app connecting.
        if let harness { return harness.start(self) }
        #endif
        startDaemon()
    }

    func startDaemon() {
        daemon.start()
        if daemon.mode != .missing {
            store.connect(to: daemon.endpoint)
        }
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
