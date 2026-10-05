import AppKit
import SwiftUI

/// Long Markdown capped at about `lineLimit` lines, with a "Show more" toggle that only
/// appears when the text is actually cut off. The cut fades out, since a block layout
/// can't stop on a line boundary the way a single `Text` does.
struct ClampedText: View {
    let markdown: String
    let lineLimit: Int
    var size: CGFloat = 12
    var mono = false
    var lineSpacing: CGFloat = 2
    var moreLabel = "Show more"
    /// Sets the text in a quiet rounded block (raw messages), with the toggle outside it.
    var boxed = false

    /// Accessibility keeps every line at its whole frame, cut off or not: while the text is
    /// clamped its container says so with this, for the e2e lint (`E2ELint`).
    nonisolated static let clipIdentifier = "clip"

    @ViewState private var expanded = false
    @ViewState private var fullHeight: CGFloat = 0

    private var lineHeight: CGFloat {
        let font = NSFont(name: Geist.postScriptName(.regular, mono: mono), size: size) ?? .systemFont(ofSize: size)
        return ceil(font.ascender - font.descender + font.leading) + lineSpacing
    }

    private var clampHeight: CGFloat { CGFloat(lineLimit) * lineHeight }
    private var truncated: Bool { fullHeight > clampHeight + 1 }
    private var clamped: Bool { truncated && !expanded }

    var body: some View {
        VStack(alignment: .leading, spacing: boxed ? 6 : 4) {
            MarkdownView(blocks: Markdown.blocks(markdown), size: size, mono: mono, lineSpacing: lineSpacing)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(maxHeight: expanded ? nil : clampHeight, alignment: .top)
                .clipped()
                .mask {
                    VStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .black.opacity(clamped ? 0 : 1)], startPoint: .top, endPoint: .bottom)
                            .frame(height: clamped ? lineHeight : 0)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(clamped ? Self.clipIdentifier : "")
                .padding(boxed ? 8 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    if boxed {
                        Color.clear.outlined()
                    }
                }
            if truncated {
                TextLink(expanded ? "Show less" : moreLabel) { expanded.toggle() }
                    .font(.geist(11.5, .medium))
            }
        }
    }
}
