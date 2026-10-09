import AppKit
import SwiftUI

// MARK: Scroll area

/// The scrolling middle of a fixed-height pane: fills the space between header and
/// footer, content pinned to the top, so a column whose content shrinks never leaves blank
/// bands around it.
///
/// Scrolled, a soft shadow falls from the top edge, as if the content slid under what is
/// above it; with more below, the bottom edge fades out. Neither shows when everything fits.
///
/// The scroller is the stage's own (`ScrollThumb`), not the system's: with "Show scroll
/// bars: Always", AppKit draws a grey track down the black pane, over rows that run to
/// its edge.
///
/// With `followsEnd`, a pane scrolled to its end stays there as its content grows, as a
/// terminal follows its output: for a pane that grows where it ends, not where it is read.
///
/// The scroll area keeps to whole points, giving up a sliver of an edge when the pane
/// lands between two. AppKit puts the scroll view's clip on whole points anyway: offset
/// half a point to match a pane that isn't, it would snap back on the first scroll, and
/// every row would jump sideways under the fingers.
struct PaneScrollView<Content: View>: View {
    var followsEnd = false
    @ViewBuilder var content: Content

    @ViewState private var edges = ScrollEdges()
    /// Read only by the thumb, so scrolling redraws the thumb and not the content.
    @ViewState private var tracker = ScrollTracker()

    var body: some View {
        GeometryReader { pane in
            let snap = WholePoints(pane.frame(in: .global))
            let viewport = snap.height
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
                let follow = followsEnd && tracker.follows(growingTo: frame.height)
                tracker.update(offset: -frame.minY, content: frame.height, viewport: viewport)
                // Once AppKit has the scroll view's new height.
                if follow { DispatchQueue.main.async { tracker.scroll(to: .infinity) } }
                let next = ScrollEdges(
                    above: frame.minY < -1,
                    below: frame.maxY > viewport + 1
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
            .padding(snap.insets)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// The insets that bring a frame's edges in to the nearest whole points: none for a frame
/// already on them.
private struct WholePoints {
    let insets: EdgeInsets
    let height: CGFloat

    init(_ frame: CGRect) {
        // Within a hair of a whole point is on it: layout arithmetic leaves crumbs.
        func up(_ x: CGFloat) -> CGFloat { max(0, (x - 0.01).rounded(.up) - x) }
        func down(_ x: CGFloat) -> CGFloat { max(0, x - (x + 0.01).rounded(.down)) }
        let top = up(frame.minY)
        let bottom = down(frame.maxY)
        insets = EdgeInsets(top: top, leading: up(frame.minX), bottom: bottom, trailing: down(frame.maxX))
        height = max(0, frame.height - top - bottom)
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

    /// Scrolled to the end, so that content growing to `height` should be followed.
    func follows(growingTo height: CGFloat) -> Bool {
        scrollable && offset >= content - viewport - 1 && height > content + 0.5
    }

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

/// Hands over the AppKit scroll view a SwiftUI `ScrollView` is built on, once the probe
/// is in a window: before that it has no scroll view around it to find.
private struct EnclosingScrollView: NSViewRepresentable {
    let found: (NSScrollView) -> Void

    func makeNSView(context: Context) -> Probe { Probe(found: found) }

    func updateNSView(_ probe: Probe, context: Context) {}

    final class Probe: NSView {
        let found: (NSScrollView) -> Void

        init(found: @escaping (NSScrollView) -> Void) {
            self.found = found
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("not from a nib") }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let scrollView = enclosingScrollView { found(scrollView) }
        }
    }
}
