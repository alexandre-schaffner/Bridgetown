import SwiftUI

/// What the route shows in the open island: a session or alert detail over the overview.
/// A detail slides in from the right over a fade; going back, it fades away. The overview stays put under it, out of sight, so coming back
/// finds it as it was: scrolled where it was, the same card open, the same rows picked.
/// A session gone from the snapshot shows the overview (the Store routes back right after).
struct RouteContent<Overview: View>: View {
    @Environment(Store.self) private var store
    @ViewBuilder let overview: () -> Overview

    var body: some View {
        let hidden = showsDetail
        ZStack {
            overview()
                .opacity(hidden ? 0 : 1)
                // Out of sight it takes no clicks, keys (its Escape) or VoiceOver, and its
                // live marks stop drawing frames. Hidden from VoiceOver as one container:
                // `accessibilityHidden(false)` straight on the content would unhide what
                // inside it hides itself (the panes' scroll thumbs).
                .disabled(hidden)
                .accessibilityElement(children: .contain)
                .accessibilityHidden(hidden)
                .environment(\.outOfSight, hidden)
            switch store.route {
            case let .session(id):
                if let session = store.snapshot?.session(id: id) {
                    presented(SessionDetailView(session: session).id(id))
                }
            case let .alert(id):
                presented(AlertDetailView(alertId: id).id(id))
            case .overview:
                EmptyView()
            }
        }
    }

    private var showsDetail: Bool {
        switch store.route {
        case let .session(id): store.snapshot?.session(id: id) != nil
        case .alert: true
        case .overview: false
        }
    }

    private func presented(_ detail: some View) -> some View {
        detail
            .onHorizontalSwipe(swipedBack)
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
    }

    /// Fingers moving right over a detail go back to the overview, like the chevron.
    private func swipedBack(_ direction: SwipeDirection) -> Bool {
        guard direction == .back else { return false }
        Haptics.perform(.generic, "detail.swipeBack")
        store.back()
        return true
    }
}
