import SwiftUI

/// What the route shows in the open island: a session or alert detail, else the overview.
/// A detail slides in from the right over a fade; the overview fades back. A session gone
/// from the snapshot shows the overview (the Store routes back to it right after).
struct RouteContent<Overview: View>: View {
    @Environment(Store.self) private var store
    @ViewBuilder let overview: () -> Overview

    var body: some View {
        switch store.route {
        case let .session(id):
            if let session = store.snapshot?.session(id: id) {
                SessionDetailView(session: session)
                    .onHorizontalSwipe(swipedBack)
                    .transition(detail)
            } else {
                overview()
                    .transition(back)
            }
        case let .alert(id):
            AlertDetailView(alertId: id)
                .id(id)
                .onHorizontalSwipe(swipedBack)
                .transition(detail)
        case .overview:
            overview()
                .transition(back)
        }
    }

    /// Fingers moving right over a detail go back to the overview, like the chevron.
    private func swipedBack(_ direction: SwipeDirection) -> Bool {
        guard direction == .back else { return false }
        Haptics.perform(.generic, "detail.swipeBack")
        store.back()
        return true
    }

    private var detail: AnyTransition {
        .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity)
    }

    private var back: AnyTransition { .opacity }
}
