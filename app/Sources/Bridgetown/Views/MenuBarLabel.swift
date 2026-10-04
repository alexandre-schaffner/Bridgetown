import AppKit
import SwiftUI

/// The status item: the arch in outline when idle, solid + count while sessions run,
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

        let solid = state.connected && state.running > 0

        let count = state.connected && state.running > 0 ? "\(state.running)" : nil
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        let countSize = count.map { ($0 as NSString).size(withAttributes: [.font: font]) } ?? .zero

        let height: CGFloat = 18
        let archSize = NSSize(width: (15 * ArchMark.aspect).rounded(), height: 15)
        let gap: CGFloat = count == nil ? 0 : (state.needsYou ? 3.5 : 2)
        let dotOverhang: CGFloat = state.needsYou && count == nil ? 2 : 0
        let width = ceil(archSize.width + gap + countSize.width + dotOverhang)
        let template = !state.needsYou
        let alpha: CGFloat = state.connected ? 1 : 0.4

        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { _ in
            // Match what the menu bar does with template images: solid black or white.
            let dark = NSAppearance.currentDrawing().bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let ink: NSColor = template || !dark ? .black : .white
            let archRect = NSRect(
                x: 0, y: (height - archSize.height) / 2,
                width: archSize.width, height: archSize.height
            )
            drawArch(in: archRect, solid: solid, color: ink.withAlphaComponent(alpha))

            if let count {
                let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink.withAlphaComponent(alpha)]
                let origin = NSPoint(x: archRect.maxX + gap, y: (height - countSize.height) / 2)
                (count as NSString).draw(at: origin, withAttributes: attrs)
            }

            if state.needsYou {
                // Knock out a ring so the dot reads cleanly against the glyph.
                let d: CGFloat = 6.5
                let dot = NSRect(x: archRect.maxX - d + 2, y: archRect.maxY - d + 0.5, width: d, height: d)
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

    /// The arch, solid or as a 1pt outline of its stones. `ArchMark` is top-left origin;
    /// the image draws bottom-left, so the path is flipped into `rect`.
    private static func drawArch(in rect: NSRect, solid: Bool, color: NSColor) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        var flip = CGAffineTransform(translationX: 0, y: rect.minY + rect.maxY).scaledBy(x: 1, y: -1)
        let local = ArchMark.path(in: rect.insetBy(dx: solid ? 0 : 0.5, dy: solid ? 0 : 0.5), joint: solid ? 1.25 : 1.5)
        guard let path = local.copy(using: &flip) else { return }
        ctx.saveGState()
        ctx.addPath(path)
        if solid {
            ctx.setFillColor(color.cgColor)
            ctx.fillPath()
        } else {
            ctx.setStrokeColor(color.cgColor)
            ctx.setLineWidth(1)
            ctx.setLineJoin(.round)
            ctx.strokePath()
        }
        ctx.restoreGState()
    }
}
