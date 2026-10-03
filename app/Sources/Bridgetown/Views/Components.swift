import AppKit
import SwiftUI

// Small shared building blocks for the popover. Spacing runs on a 4pt grid:
// 12 inside cards, 16 between sections, 8 between related lines.

enum Metrics {
    static let width: CGFloat = 380
    /// The popover's fixed height (see `PaneScrollView`). Design review overrides it
    /// through the `popoverHeight` environment value.
    static let height: CGFloat = 620
    static let inset: CGFloat = 12
    static let cardRadius: CGFloat = 10
}

private struct PopoverHeightKey: EnvironmentKey {
    static let defaultValue = Metrics.height
}

extension EnvironmentValues {
    /// The popover's fixed height; `--preview-height` sets it for long content.
    var popoverHeight: CGFloat {
        get { self[PopoverHeightKey.self] }
        set { self[PopoverHeightKey.self] = newValue }
    }
}

// MARK: Card

struct CardBackground: ViewModifier {
    var highlighted = false

    func body(content: Content) -> some View {
        content
            .background(
                .quaternary.opacity(highlighted ? 0.85 : 0.5),
                in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous)
            )
    }
}

extension View {
    func card(highlighted: Bool = false) -> some View { modifier(CardBackground(highlighted: highlighted)) }

    /// A grouped surface holding several rows or a chart: the card fill plus a hairline,
    /// so the rows inside can use their own hover fill.
    func panel() -> some View {
        background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous)
                    .strokeBorder(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 0.5)
            )
    }
}

// MARK: Section header

struct SectionHeader: View {
    let title: String
    var count: Int?
    /// Colours the count when the section is worth attention (orange for Needs you).
    var tint: Color?
    var trailing: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            if let count, count > 1 {
                Text(count, format: .number)
                    .font(.system(size: 10, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background((tint ?? .secondary).opacity(0.14), in: Capsule())
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing)
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: Detail section

/// A titled block in a detail pane: small semibold label, content below. No card.
struct DetailSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Channel chip

struct ChannelChip: View {
    let name: String

    var body: some View {
        Text(Format.channel(name))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(.quaternary.opacity(0.7), in: Capsule())
    }
}

// MARK: Scroll area

/// The scrolling middle of a fixed-height pane: fills the space between header and
/// footer, content pinned to the top. The popover has a constant height because a
/// MenuBarExtra window does not shrink when its content does, and a growing and
/// shrinking window leaves blank bands around centred content.
struct PaneScrollView<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView(.vertical) {
            content.frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: Hover

struct HoverHighlight: ViewModifier {
    var radius: CGFloat = 6
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(.quaternary.opacity(hovering ? 0.6 : 0))
            )
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverHighlight(radius: CGFloat = 6) -> some View { modifier(HoverHighlight(radius: radius)) }
}

// MARK: Pulse

/// Gentle opacity pulse for "in progress". Static under Reduce Motion.
///
/// Opacity is computed from the clock on every frame instead of animated. Any SwiftUI
/// animation here (`withAnimation(.repeatForever)`, `phaseAnimator`) opens a transaction
/// that also captures layout changes in the row, such as new activity text or the list
/// reflowing, and the bars then slide out of place. A pure function of time cannot move
/// anything.
struct Pulse: ViewModifier {
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: Double = 2.2

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                content.opacity(0.7 + 0.3 * cos(phase * 2 * .pi))
            }
        } else {
            content
        }
    }
}

// MARK: Icon button

/// Borderless SF Symbol button used in headers (pause, gear, dismiss).
struct IconButton: View {
    let systemName: String
    let help: String
    var size: CGFloat = 15
    var weight: Font.Weight = .regular
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: weight))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .hoverHighlight(radius: 6)
        .help(help)
        .accessibilityLabel(help)
    }
}

// MARK: Material background (preview window only)

struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) { v.material = material }
}

// MARK: Confirmation

/// An inline "are you sure" for destructive actions, in place of the button that asked.
/// Menu bar windows handle sheets and alerts badly, so this stays in the view. Cancels
/// itself after 5 seconds.
struct ConfirmButtons: View {
    let confirmLabel: String
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button("Cancel", action: onCancel)
                .controlSize(.small)
            Button(confirmLabel, role: .destructive, action: onConfirm)
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(.red)
        }
        .task {
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { onCancel() }
        }
    }
}

// MARK: Loading

/// A value fetched from the daemon: the last good value, or why the first fetch failed.
/// A failed refetch keeps the old value on screen rather than replacing it with an error.
struct Loadable<Value> {
    var value: Value?
    var error: String?

    @MainActor
    func reloaded(_ fetch: () async throws -> Value) async -> Loadable {
        do {
            return Loadable(value: try await fetch(), error: nil)
        } catch is CancellationError {
            return self
        } catch let error as URLError where error.code == .cancelled {
            // The view went away mid-request (the popover closed): not a failure.
            return self
        } catch {
            return Loadable(value: value, error: value == nil ? error.userMessage : self.error)
        }
    }
}
