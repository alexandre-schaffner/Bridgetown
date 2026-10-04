#if DEBUG
import AppKit
import SwiftUI

/// Design-review tooling, debug builds only (`make dev-app ARGS=…`):
///
/// - `--preview-window`, `--preview-detail <session id>`, `--preview-alert <alert id>`,
///   `--preview-settings <tab>`: the UI in a normal window, for screenshots and design work.
/// - `--snapshot <png>` (+ `--snapshot-quit`): render that window to a PNG once data arrives.
/// - `--appearance dark|light`, `--preview-height <pt>`: for long content.
/// - `--island-demo`: the notch island cycles hover, banner, open and close, for
///   screen recordings of its motion.
@MainActor
final class PreviewHarness {
    struct Arguments {
        var previewWindow = false
        var previewDetail: String?
        var previewAlert: String?
        var previewSettings: SettingsView.Tab?
        var appearance: NSAppearance?
        var snapshotPath: String?
        var snapshotQuit = false
        var previewHeight: CGFloat?
        var islandDemo = false

        init(_ argv: [String]) {
            var it = argv.dropFirst().makeIterator()
            while let arg = it.next() {
                switch arg {
                case "--preview-window": previewWindow = true
                case "--preview-detail": previewDetail = it.next()
                case "--preview-alert": previewAlert = it.next()
                case "--preview-settings": previewSettings = it.next().flatMap(SettingsView.Tab.init(rawValue:)) ?? .accounts
                case "--snapshot": snapshotPath = it.next()
                case "--snapshot-quit": snapshotQuit = true
                case "--island-demo": islandDemo = true
                case "--preview-height": previewHeight = it.next().flatMap(Double.init).map { CGFloat($0) }
                case "--appearance":
                    switch it.next() {
                    case "dark": appearance = NSAppearance(named: .darkAqua)
                    case "light": appearance = NSAppearance(named: .aqua)
                    default: break
                    }
                default: break
                }
            }
        }
    }

    let args: Arguments
    private var window: NSWindow?

    init(arguments: [String]) {
        args = Arguments(arguments)
    }

    var popoverHeight: CGFloat? { args.previewHeight }

    func start(store: Store, daemon: DaemonProcess, island: IslandController, popoverHeight: CGFloat) {
        if let appearance = args.appearance { NSApp.appearance = appearance }
        if args.islandDemo { islandDemo(island, store: store) }

        if let tab = args.previewSettings {
            openWindow(title: "Settings", SettingsView(initialTab: tab).environment(store).environment(daemon))
        } else if args.previewWindow || args.previewDetail != nil || args.previewAlert != nil {
            if let id = args.previewDetail {
                store.show(.session(id))
            } else if let id = args.previewAlert {
                store.show(.alert(id))
            }
            let material = args.snapshotPath == nil
            let title = args.previewDetail != nil ? "Bridgetown · Session" : args.previewAlert != nil ? "Bridgetown · Alert" : "Bridgetown"
            openWindow(
                title: title,
                PopoverView()
                    .environment(store)
                    .environment(daemon)
                    .environment(\.popoverHeight, popoverHeight)
                    .background { if material { VisualEffectBackground(material: .popover) } }
            )
        }
        if let path = args.snapshotPath, window != nil {
            snapshot(to: path, store: store, quit: args.snapshotQuit)
        }
    }

    /// Rest, hover, rest, banner, open, close, on a loop.
    private func islandDemo(_ island: IslandController, store: Store) {
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

    private func openWindow(title: String, _ content: some View) {
        // Render controls as in a key window (the menu bar panel always is), even when
        // the preview window can't take focus.
        let root = content.environment(\.controlActiveState, .key)
        let host = NSHostingController(rootView: root)
        host.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: host)
        window.title = title
        window.styleMask = [.titled, .closable]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    /// Renders the preview window's own views to a PNG once data has arrived. Works
    /// without Screen Recording permission. Behind-window blur can't be captured this
    /// way, so the material is approximated with the window background.
    private func snapshot(to path: String, store: Store, quit: Bool) {
        Task { @MainActor in
            for _ in 0..<50 where store.snapshot == nil { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .seconds(1.2))  // let layout, transcript fetch and transitions settle
            guard let window, let view = window.contentView else { return }
            for _ in 0..<20 where !NSApp.isActive || !window.isKeyWindow {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
                try? await Task.sleep(for: .milliseconds(100))
            }
            let bounds = view.bounds
            func makeRep() -> NSBitmapImageRep? {
                let rep = NSBitmapImageRep(
                    bitmapDataPlanes: nil, pixelsWide: Int(bounds.width * 2), pixelsHigh: Int(bounds.height * 2),
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
                )
                rep?.size = bounds.size  // 2x
                return rep
            }
            guard let content = makeRep(), let output = makeRep() else { return }
            view.cacheDisplay(in: bounds, to: content)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: output)
            window.effectiveAppearance.performAsCurrentDrawingAppearance {
                NSColor.windowBackgroundColor.setFill()
                bounds.fill()
            }
            content.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            NSGraphicsContext.restoreGraphicsState()
            try? output.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            if quit { NSApp.terminate(nil) }
        }
    }
}
#endif
