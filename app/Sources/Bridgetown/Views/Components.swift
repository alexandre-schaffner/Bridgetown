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

// MARK: Full bleed

private struct FullBleedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Tables run to the pane's edges between full-width hairlines, rather than sitting in
    /// an outlined block. The pane then pads only vertically, and the text around a table
    /// (titles, footers, buttons) takes the inset itself through `bleedInset()`.
    var fullBleed: Bool {
        get { self[FullBleedKey.self] }
        set { self[FullBleedKey.self] = newValue }
    }
}

extension View {
    /// Text beside a table: the pane's inset, when tables run to the edges.
    func bleedInset() -> some View { modifier(BleedInset()) }

    /// A table's frame: an outlined block, or hairlines above and below it at full width.
    func tableFrame() -> some View { modifier(TableFrame()) }
}

private struct BleedInset: ViewModifier {
    @Environment(\.fullBleed) private var fullBleed

    func body(content: Content) -> some View {
        content.padding(.horizontal, fullBleed ? Metrics.inset : 0)
    }
}

private struct TableFrame: ViewModifier {
    @Environment(\.fullBleed) private var fullBleed

    func body(content: Content) -> some View {
        if fullBleed {
            VStack(spacing: 0) {
                Hairline()
                content
                Hairline()
            }
        } else {
            content.outlined()
        }
    }
}

// MARK: Row list

/// Rows in one table (see `tableFrame`), a hairline between each, not a stack of cards.
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
        .tableFrame()
        .animation(Easing.state, value: data.map(\.id))
    }
}

// MARK: Cell grid

/// Two cells a row in one table (see `tableFrame`), hairlines between: how charts sit side by side.
/// An item marked `wide` takes a row to itself, and the rest pair up around it.
struct CellGrid<Item: Identifiable, Cell: View>: View {
    let items: [Item]
    var wide: Item.ID?
    @ViewBuilder let cell: (Item) -> Cell

    private struct Row: Identifiable {
        let items: [Item]
        var id: [Item.ID] { items.map(\.id) }
    }

    private var rows: [Row] {
        var rows: [Row] = []
        var pair: [Item] = []
        for item in items {
            if item.id == wide {
                if !pair.isEmpty { rows.append(Row(items: pair)) }
                pair = []
                rows.append(Row(items: [item]))
            } else {
                pair.append(item)
                if pair.count == 2 {
                    rows.append(Row(items: pair))
                    pair = []
                }
            }
        }
        if !pair.isEmpty { rows.append(Row(items: pair)) }
        return rows
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Hairline() }
                HStack(spacing: 0) {
                    cell(row.items[0]).frame(maxWidth: .infinity)
                    if row.items[0].id != wide {
                        Hairline(vertical: true)
                        if row.items.count > 1 {
                            cell(row.items[1]).frame(maxWidth: .infinity)
                        } else {
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tableFrame()
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

struct SectionHeader: View {
    /// Tall enough for a compact button, so a selection header can stand in without a jump.
    static let height: CGFloat = 24

    let title: String
    var count: Int?
    /// Colours the count when the section is worth attention (orange for Needs you).
    var tint: Color?
    var trailing: String?

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(Typo.title)
                .tracking(Typo.titleTracking)
                .foregroundStyle(.primary)
            if let count, count > 1 {
                Badge(text: "\(count)", tint: tint)
            }
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing)
                    .font(.geist(11))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .frame(height: Self.height)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: Detail section

/// A titled block in a detail pane: the title, content below. No outline of its own.
/// Under `fullBleed` the title takes the pane's inset; content that isn't a table should
/// take it too (`bleedInset()`).
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title)
                    .font(Typo.title)
                    .tracking(Typo.titleTracking)
                    .foregroundStyle(.primary)
                if let detail {
                    Text(detail)
                        .font(.geist(12.5))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .bleedInset()
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
///
/// The scroller is the stage's own (`ScrollThumb`), not the system's: with "Show scroll
/// bars: Always", AppKit draws a grey track down the black pane, over rows that run to
/// its edge.
struct PaneScrollView<Content: View>: View {
    @ViewBuilder var content: Content

    @ViewState private var edges = ScrollEdges()
    /// Read only by the thumb, so scrolling redraws the thumb and not the content.
    @ViewState private var tracker = ScrollTracker()

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
                    .background { EnclosingScrollView { tracker.scrollView = $0 } }
            }
            .scrollIndicators(.never)
            .coordinateSpace(name: ScrollEdges.space)
            .scrollBounceBehavior(.basedOnSize)
            .onPreferenceChange(ContentFrameKey.self) { frame in
                tracker.update(offset: -frame.minY, content: frame.height, viewport: viewport.size.height)
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
            .overlay(alignment: .topTrailing) { ScrollThumb(tracker: tracker) }
            .onHover { tracker.hovering = $0 }
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
    /// Siblings that don't measure (the scroll view finder) report `.zero`; keep the real frame.
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

// MARK: Scroll thumb

/// Where a pane is scrolled to, and the AppKit scroll view under it, for dragging.
@MainActor
@Observable
final class ScrollTracker {
    private(set) var offset: CGFloat = 0
    private(set) var content: CGFloat = 0
    private(set) var viewport: CGFloat = 0
    /// Bumped on every scroll, so the thumb shows while the pane moves.
    private(set) var moves = 0
    var hovering = false
    @ObservationIgnored weak var scrollView: NSScrollView?

    var scrollable: Bool { content > viewport + 1 && viewport > 0 }

    func update(offset: CGFloat, content: CGFloat, viewport: CGFloat) {
        let moved = abs(offset - self.offset) > 0.5
        self.offset = offset
        self.content = content
        self.viewport = viewport
        if moved { moves &+= 1 }
    }

    /// Scrolls the pane so its top is `offset` points into the content.
    func scroll(to offset: CGFloat) {
        guard let scrollView else { return }
        let clip = scrollView.contentView
        let y = min(max(0, offset), max(0, content - viewport))
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.isFlipped ? y : content - viewport - y))
        scrollView.reflectScrolledClipView(clip)
    }
}

/// A thin capsule at the pane's trailing edge: shown while the pane scrolls or the pointer
/// is over it, then faded out; wider under the pointer, and draggable like any scroller.
/// Nothing when everything fits.
private struct ScrollThumb: View {
    let tracker: ScrollTracker
    @ViewState private var recentlyMoved = false
    @ViewState private var hovering = false
    @ViewState private var dragStart: CGFloat?
    @ViewState private var hideTask: Task<Void, Never>?

    private static let inset: CGFloat = 3
    private static let minLength: CGFloat = 28

    var body: some View {
        let track = max(0, tracker.viewport - 2 * Self.inset)
        let length = tracker.scrollable ? max(Self.minLength, track * tracker.viewport / tracker.content) : 0
        let travel = max(0, track - length)
        let range = max(1, tracker.content - tracker.viewport)
        let y = Self.inset + travel * min(1, max(0, tracker.offset / range))
        let active = hovering || dragStart != nil
        let visible = tracker.scrollable && (recentlyMoved || tracker.hovering || active)

        Capsule()
            .fill(Color.white.opacity(active ? 0.42 : 0.24))
            .frame(width: active ? 7 : 5, height: length)
            .frame(width: 14, height: length, alignment: .trailing)
            .padding(.trailing, Self.inset)
            .contentShape(Rectangle())
            .offset(y: y)
            .opacity(visible ? 1 : 0)
            .allowsHitTesting(visible)
            .onHover { hovering = $0 }
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .onChanged { drag in
                        let start = dragStart ?? tracker.offset
                        if dragStart == nil { dragStart = start }
                        tracker.scroll(to: start + drag.translation.height * range / max(1, travel))
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .animation(Easing.quick, value: visible)
            .animation(Easing.quick, value: active)
            .onChange(of: tracker.moves) {
                recentlyMoved = true
                hideTask?.cancel()
                hideTask = Task {
                    try? await Task.sleep(for: .seconds(1.1))
                    if !Task.isCancelled { recentlyMoved = false }
                }
            }
            .accessibilityHidden(true)  // VoiceOver scrolls the scroll view itself
    }
}

/// Hands over the AppKit scroll view a SwiftUI `ScrollView` is built on.
private struct EnclosingScrollView: NSViewRepresentable {
    let found: (NSScrollView) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            if let scrollView = view?.enclosingScrollView { found(scrollView) }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
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
    func rowHighlight(_ enabled: Bool = true) -> some View { modifier(RowHighlight(enabled: enabled)) }
}

struct RowHighlight: ViewModifier {
    var enabled = true
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(hovering && enabled ? Ink.hover : .clear)
            .onHover { hovering = $0 }
            .animation(Easing.quick, value: hovering)
    }
}

/// A whole row as a button: a faint fill on hover, a firmer one while the button is
/// down, so a click is felt before it navigates, and while the row is picked.
struct RowButtonStyle: ButtonStyle {
    /// Picked for a bulk action: the firm fill stays.
    var selected = false

    func makeBody(configuration: Configuration) -> some View {
        RowLabel(configuration: configuration, selected: selected)
    }

    private struct RowLabel: View {
        let configuration: Configuration
        let selected: Bool
        @ViewState private var hovering = false

        var body: some View {
            configuration.label
                .background(selected ? Ink.picked : configuration.isPressed ? Ink.selected : hovering ? Ink.hover : .clear)
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
