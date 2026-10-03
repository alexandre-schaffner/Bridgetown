import AppKit
import SwiftUI

/// The status item: `bolt.shield` idle, `bolt.shield.fill` + count while sessions run,
/// an orange dot when something needs you, dimmed when the daemon is unreachable.
struct MenuBarLabel: View {
    let store: Store

    var body: some View {
        let state = MenuBarIcon.State(
            connected: store.isConnected,
            running: store.activeSessions.count,
            needsYou: !store.actions.isEmpty
        )
        Image(nsImage: MenuBarIcon.image(for: state))
            .accessibilityLabel(state.accessibilityLabel)
    }
}

enum MenuBarIcon {
    struct State: Hashable {
        var connected: Bool
        var running: Int
        var needsYou: Bool

        var accessibilityLabel: String {
            guard connected else { return "Bridgetown, disconnected" }
            var parts = ["Bridgetown"]
            if running > 0 { parts.append("\(running) running") }
            if needsYou { parts.append("needs you") }
            return parts.joined(separator: ", ")
        }
    }

    @MainActor private static var cache: [State: NSImage] = [:]

    /// Drawn by hand so the count and dot sit in one image. Template (auto-tinted by the
    /// menu bar) unless the orange dot is showing; then the glyph colour is resolved from
    /// the drawing appearance so it still follows the menu bar.
    @MainActor
    static func image(for state: State) -> NSImage {
        if let cached = cache[state] { return cached }

        let symbolName = state.connected && state.running > 0 ? "bolt.shield.fill" : "bolt.shield"
        let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
            .withSymbolConfiguration(config) ?? NSImage()

        let count = state.connected && state.running > 0 ? "\(state.running)" : nil
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        let countSize = count.map { ($0 as NSString).size(withAttributes: [.font: font]) } ?? .zero

        let height: CGFloat = 18
        let symbolSize = symbol.size
        let gap: CGFloat = count == nil ? 0 : (state.needsYou ? 3.5 : 2)
        let dotOverhang: CGFloat = state.needsYou && count == nil ? 2 : 0
        let width = ceil(symbolSize.width + gap + countSize.width + dotOverhang)
        let template = !state.needsYou
        let alpha: CGFloat = state.connected ? 1 : 0.4

        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { _ in
            // Match what the menu bar does with template images: solid black or white.
            let dark = NSAppearance.currentDrawing().bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let ink: NSColor = template || !dark ? .black : .white
            let symbolRect = NSRect(
                x: 0, y: (height - symbolSize.height) / 2,
                width: symbolSize.width, height: symbolSize.height
            )
            drawTinted(symbol, in: symbolRect, color: ink, alpha: alpha)

            if let count {
                let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink.withAlphaComponent(alpha)]
                let origin = NSPoint(x: symbolRect.maxX + gap, y: (height - countSize.height) / 2)
                (count as NSString).draw(at: origin, withAttributes: attrs)
            }

            if state.needsYou {
                // Knock out a ring so the dot reads cleanly against the glyph.
                let d: CGFloat = 6.5
                let dot = NSRect(x: symbolRect.maxX - d + 2, y: symbolRect.maxY - d + 0.5, width: d, height: d)
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(ovalIn: dot.insetBy(dx: -1.5, dy: -1.5)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                NSColor.systemOrange.setFill()
                NSBezierPath(ovalIn: dot).fill()
            }
            return true
        }
        image.isTemplate = template
        image.accessibilityDescription = state.accessibilityLabel
        cache[state] = image
        return image
    }

    /// Vector draw, then recolour what was just drawn. Only the symbol is in `rect` at this
    /// point, so `sourceAtop` tints exactly the glyph.
    private static func drawTinted(_ symbol: NSImage, in rect: NSRect, color: NSColor, alpha: CGFloat) {
        symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: alpha)
        color.setFill()
        rect.fill(using: .sourceAtop)
    }
}
