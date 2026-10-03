import SwiftUI

/// Long text capped at `lineLimit` lines, with a "Show more" toggle that only
/// appears when the text is actually cut off.
struct ClampedText: View {
    let text: AttributedString
    let lineLimit: Int
    var font: Font = .system(size: 12)
    var lineSpacing: CGFloat = 2
    var moreLabel = "Show more"
    var lessLabel = "Show less"
    /// Sets the text in a quiet rounded block (raw messages), with the toggle outside it.
    var boxed = false

    @ViewState private var expanded = false
    @ViewState private var fullHeight: CGFloat = 0
    @ViewState private var shownHeight: CGFloat = 0

    private var truncated: Bool { fullHeight > shownHeight + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: boxed ? 6 : 4) {
            styled(Text(text))
                .lineLimit(expanded ? nil : lineLimit)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { shownHeight = $0 }
                .background(alignment: .topLeading) {
                    // The same text unclamped, invisible, to learn whether the clamp cut anything.
                    styled(Text(text))
                        .fixedSize(horizontal: false, vertical: true)
                        .hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                }
                .padding(boxed ? 8 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    if boxed {
                        RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.quaternary.opacity(0.35))
                    }
                }
            if truncated || expanded {
                Button(expanded ? lessLabel : moreLabel) { expanded.toggle() }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.tint)
            }
        }
    }

    private func styled(_ t: Text) -> some View {
        t.font(font).lineSpacing(lineSpacing)
    }
}
