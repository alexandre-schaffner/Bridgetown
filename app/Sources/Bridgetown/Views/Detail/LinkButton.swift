import SwiftUI

/// A link-styled button that opens `url` (through `SystemActions.open`, so only https:,
/// slack: and revv: links ever open).
struct LinkButton: View {
    let title: String
    var systemImage: String?
    let url: String
    var help: String?

    var body: some View {
        Button {
            SystemActions.open(url)
        } label: {
            if let systemImage {
                Label(title, systemImage: systemImage)
            } else {
                Text(title)
            }
        }
        .buttonStyle(.link)
        .help(help ?? url)
    }
}
