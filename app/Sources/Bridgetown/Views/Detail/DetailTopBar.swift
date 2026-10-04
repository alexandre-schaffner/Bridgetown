import SwiftUI

/// Back chevron and title, shared by the pushed detail panes. Escape goes back too.
struct DetailTopBar: View {
    @Environment(Store.self) private var store
    let title: String
    /// Session titles stay on one line; alert titles may take two.
    var lineLimit = 1

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            IconButton(systemName: "chevron.left", help: "Back", size: 13, weight: .semibold) {
                store.back()
            }
            .keyboardShortcut(.cancelAction)
            Text(title)
                .font(.geist(15, .semibold))
                .tracking(-0.4)
                .lineLimit(lineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 3.5)  // first line centred on the 24pt chevron
                .help(title)
            Spacer(minLength: 0)
        }
        .padding(.leading, 8)
        .padding(.trailing, 16)
        .padding(.vertical, 12)
    }
}
