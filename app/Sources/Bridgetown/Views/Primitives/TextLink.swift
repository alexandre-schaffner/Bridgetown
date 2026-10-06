import SwiftUI

/// A text button: monochrome like every control (colour is for status), brightening under
/// the pointer, with a glyph that leans the way it goes: right into the app, up and out
/// to the browser (it stays put under Reduce Motion). However small its type, it is 20pt
/// tall to hit; however narrow its line, its label is whole, since it says what a click
/// does: the words beside it give way first.
struct TextLink: View {
    enum Direction {
        /// Somewhere else in the island: a chevron that nudges right.
        case inward
        /// Out to the browser or Slack: an arrow that nudges up and out.
        case external
        /// Acts in place (Retry, Show more): no glyph.
        case none
    }

    let title: String
    var direction = Direction.none
    let action: () -> Void
    @ViewState private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ title: String, direction: Direction = .none, action: @escaping () -> Void) {
        self.title = title
        self.direction = direction
        self.action = action
    }

    /// Opens `url` (through `SystemActions.open`, so only https:, slack: and revv: links open).
    init(_ title: String, opening url: String) {
        self.init(title, direction: .external) { SystemActions.open(url) }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Text(title)
                if let glyph {
                    Image(systemName: glyph.symbol)
                        .font(.system(size: 8.5, weight: .semibold))
                        .offset(hovering && isEnabled && !reduceMotion ? glyph.nudge : .zero)
                }
            }
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(minHeight: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(hovering && isEnabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .opacity(isEnabled ? 1 : 0.5)
        .onHover { hovering = $0 }
        .animation(Easing.quick, value: hovering)
    }

    private var glyph: (symbol: String, nudge: CGSize)? {
        switch direction {
        case .inward: ("chevron.right", CGSize(width: 2, height: 0))
        case .external: ("arrow.up.right", CGSize(width: 1.5, height: -1.5))
        case .none: nil
        }
    }
}
