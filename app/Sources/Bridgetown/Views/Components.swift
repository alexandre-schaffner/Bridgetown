import AppKit
import SwiftUI

// Small shared building blocks for the popover. Spacing runs on a 4pt grid:
// 12 inside blocks, 24 between sections, 8 between related lines.

enum Metrics {
    static let width: CGFloat = 380
    /// The popover's fixed height (see `PaneScrollView`). Design review overrides it
    /// through the `popoverHeight` environment value.
    static let height: CGFloat = 620
    static let inset: CGFloat = 12
    static let cardRadius: CGFloat = Ink.panelRadius
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

// MARK: Hairline

/// The stage's divider: a 1pt line at hairline white, in place of the system separator.
struct Hairline: View {
    var vertical = false
    @Environment(\.displayScale) private var scale

    /// One device pixel.
    private var width: CGFloat { 1 / max(scale, 1) }

    var body: some View {
        if vertical {
            Ink.hairline.frame(width: width)
        } else {
            Ink.hairline.frame(height: width)
        }
    }
}

// MARK: Row list

/// Rows in one outlined block, a hairline between each: a table, not a stack of cards.
/// A row that arrives fades in where it lands and one that leaves fades out as the rest
/// close up, so a card resolving or an alert coming in reads as one change, not a jump.
struct RowList<Data: RandomAccessCollection, Row: View>: View where Data.Element: Identifiable {
    let data: Data
    @ViewBuilder let row: (Data.Element) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(data.enumerated()), id: \.element.id) { index, element in
                VStack(spacing: 0) {
                    if index > 0 { Hairline() }
                    row(element)
                }
                .transition(.opacity)
            }
        }
        .outlined()
        .animation(Easing.state, value: data.map(\.id))
    }
}

// MARK: Cell grid

/// Two cells a row in one outlined block, hairlines between: how charts sit side by side.
struct CellGrid<Item: Identifiable, Cell: View>: View {
    let items: [Item]
    @ViewBuilder let cell: (Item) -> Cell

    var body: some View {
        let rows = stride(from: 0, to: items.count, by: 2).map { Array(items[$0..<min($0 + 2, items.count)]) }
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Hairline() }
                HStack(spacing: 0) {
                    cell(row[0]).frame(maxWidth: .infinity)
                    Hairline(vertical: true)
                    if row.count > 1 {
                        cell(row[1]).frame(maxWidth: .infinity)
                    } else {
                        Color.clear.frame(maxWidth: .infinity)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .outlined()
    }
}

// MARK: Card

extension View {
    /// A standalone outlined block; `highlighted` on hover.
    func card(highlighted: Bool = false) -> some View {
        outlined(fill: highlighted ? Color(white: 0.06) : Ink.surface)
    }
}

// MARK: Section header

/// A title and, past one, how many rows follow. The count stays grey: the rows carry
/// the colour where it means something.
struct SectionHeader: View {
    let title: String
    var count: Int?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(Typo.title)
                .tracking(Typo.titleTracking)
                .foregroundStyle(.primary)
            if let count, count > 1 {
                Text("\(count)")
                    .font(.geist(12).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
        }
        .frame(height: 20)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: Detail section

/// A titled block in a detail pane: the title, content below. No outline of its own.
struct DetailSection<Content: View>: View {
    let title: String
    /// Shown after the title as written, never uppercased: a route or a board name.
    var detail: String?
    @ViewBuilder var content: Content

    init(title: String, detail: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.detail = detail
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title)
                    .font(Typo.title)
                    .tracking(Typo.titleTracking)
                    .foregroundStyle(.primary)
                if let detail {
                    Text(detail)
                        .font(.geist(12))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .accessibilityElement(children: .combine)
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
            .font(.geist(11, .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: Ink.tagRadius))
    }
}

// MARK: Scroll area

/// The scrolling middle of a fixed-height pane: fills the space between header and
/// footer, content pinned to the top. The popover has a constant height because a
/// MenuBarExtra window does not shrink when its content does, and a growing and
/// shrinking window leaves blank bands around centred content.
///
/// Scrolled, a soft shadow falls from the top edge, as if the content slid under what is
/// above it; with more below, the bottom edge fades out. Neither shows when everything fits.
struct PaneScrollView<Content: View>: View {
    @ViewBuilder var content: Content

    @ViewState private var edges = ScrollEdges()

    var body: some View {
        GeometryReader { viewport in
            ScrollView(.vertical) {
                content
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .background {
                        GeometryReader { geo in
                            Color.clear.preference(key: ContentFrameKey.self, value: geo.frame(in: .named(ScrollEdges.space)))
                        }
                    }
            }
            .coordinateSpace(name: ScrollEdges.space)
            .scrollBounceBehavior(.basedOnSize)
            .onPreferenceChange(ContentFrameKey.self) { frame in
                let next = ScrollEdges(
                    above: frame.minY < -1,
                    below: frame.maxY > viewport.size.height + 1
                )
                if next != edges { withAnimation(Easing.quick) { edges = next } }
            }
            .overlay(alignment: .top) {
                LinearGradient(colors: [.black.opacity(0.7), .black.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 14)
                    .opacity(edges.above ? 1 : 0)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                LinearGradient(colors: [.black.opacity(0), .black.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 24)
                    .opacity(edges.below ? 1 : 0)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

private struct ScrollEdges: Equatable {
    static let space = "paneScroll"

    /// Content scrolled up past the top edge.
    var above = false
    /// More content below the bottom edge.
    var below = false
}

private struct ContentFrameKey: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

// MARK: Hover

struct HoverHighlight: ViewModifier {
    var radius: CGFloat = 6
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(hovering ? Ink.hover : .clear)
            )
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverHighlight(radius: CGFloat = 6) -> some View { modifier(HoverHighlight(radius: radius)) }

    /// A row in a `RowList` with controls of its own: a faint fill on hover. A row that is
    /// one button uses `RowButtonStyle`, which also answers the press.
    func rowHighlight() -> some View { modifier(RowHighlight()) }
}

struct RowHighlight: ViewModifier {
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(hovering ? Ink.hover : .clear)
            .onHover { hovering = $0 }
            .animation(Easing.quick, value: hovering)
    }
}

/// A whole row as a button: a faint fill on hover, a firmer one while the button is
/// down, so a click is felt before it navigates.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RowLabel(configuration: configuration)
    }

    private struct RowLabel: View {
        let configuration: Configuration
        @ViewState private var hovering = false

        var body: some View {
            configuration.label
                .background(configuration.isPressed ? Ink.selected : hovering ? Ink.hover : .clear)
                .onHover { hovering = $0 }
                .animation(Easing.quick, value: hovering)
                .animation(Easing.quick, value: configuration.isPressed)
        }
    }
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

/// 👍 / 👎 on Jev's call for an alert: labels the verdict for calibration. The chosen one
/// is filled; choosing again changes the label.
struct FeedbackThumbs: View {
    @Environment(Store.self) private var store
    let alert: AlertView

    var body: some View {
        HStack(spacing: 4) {
            thumb(.good, symbol: "hand.thumbsup", help: "Good call")
            thumb(.bad, symbol: "hand.thumbsdown", help: "Bad call")
        }
        .disabled(store.isBusy(alert.id))
    }

    private func thumb(_ label: AlertView.Feedback, symbol: String, help: String) -> some View {
        let selected = alert.feedback == label
        return Button {
            store.feedback(alert, label)
        } label: {
            Image(systemName: selected ? symbol + ".fill" : symbol)
                .font(.geist(12))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 24, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .hoverHighlight(radius: 5)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

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
                // Pause becomes play (and back) as one symbol morphing, not a swap.
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .hoverHighlight(radius: 6)
        .animation(Easing.state, value: systemName)
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
                .buttonStyle(.stage(.secondary, compact: true))
            Button(confirmLabel, role: .destructive, action: onConfirm)
                .buttonStyle(.stage(.danger, compact: true))
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

/// Loads a value from the daemon and keeps it fresh: refetched every minute while on
/// screen. Reopening the popover keeps the value it had; only a different key starts
/// over. A failed refetch keeps the last value.
struct PollingLoader<Value, Content: View>: View {
    let key: String
    let fetch: () async throws -> Value
    @ViewBuilder let content: (Loadable<Value>) -> Content

    @ViewState private var loaded = Loadable<Value>()
    @ViewState private var loadedKey: String?

    var body: some View {
        content(loaded)
            .task(id: key) {
                if loadedKey != key {
                    loaded = Loadable()
                    loadedKey = key
                }
                while !Task.isCancelled {
                    let next = await loaded.reloaded(fetch)
                    // Switching tabs cancels this task after the next one has reset the value:
                    // writing now would put this key's value (or error) under the other tab.
                    guard !Task.isCancelled else { return }
                    loaded = next
                    try? await Task.sleep(for: .seconds(60))
                }
            }
    }
}
