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
