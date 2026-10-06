import SwiftUI

/// A detail pane, the same for a session and an alert: the back chevron and its title,
/// its sections scrolling under them, and a bar of actions along the bottom. The sections
/// run to the pane's edges, as the overview's lists do: tables between full-width
/// hairlines, text inset by `Metrics.inset`.
struct DetailScaffold<Content: View, Bar: View>: View {
    let title: String
    /// Session titles stay on one line; alert titles may take two.
    var titleLineLimit = 1
    @ViewBuilder var sections: Content
    @ViewBuilder var bar: Bar

    var body: some View {
        VStack(spacing: 0) {
            DetailTopBar(title: title, lineLimit: titleLineLimit)
            Hairline()
            PaneScrollView {
                VStack(alignment: .leading, spacing: 24) { sections }
                    .padding(.vertical, 18)
            }
            .accessibilityIdentifier("pane.detail")
            Hairline()
            HStack(spacing: 8) { bar }
                .padding(.horizontal, Metrics.inset)
                .padding(.vertical, 10)
        }
    }
}

/// Back chevron and title. Escape goes back too.
struct DetailTopBar: View {
    @Environment(Store.self) private var store
    let title: String
    var lineLimit = 1

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            IconButton(systemName: "chevron.left", help: "Back", size: 13, weight: .semibold) {
                Haptics.perform(.generic, "detail.back")
                store.back()
            }
            .keyboardShortcut(.cancelAction)
            Text(title)
                .font(Typo.paneTitle)
                .tracking(-0.4)
                .lineLimit(lineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 3.5)  // first line centred on the 24pt chevron
                .help(title)
            Spacer(minLength: 0)
        }
        .padding(.leading, 8)
        .padding(.trailing, Metrics.inset)
        .padding(.vertical, 12)
    }
}
