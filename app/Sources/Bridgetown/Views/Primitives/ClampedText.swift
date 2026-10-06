import AppKit
import SwiftUI

/// Long Markdown capped at about `lineLimit` lines, with a "Show more" toggle that only
/// appears when the text is actually cut off. The cut falls after a whole line, the last
/// line above the limit (`TextRun.cut`), never through one, and that line trails off
/// toward its end.
struct ClampedText: View {
    let markdown: String
    let lineLimit: Int
    var size: CGFloat = 12
    var mono = false
    var lineSpacing: CGFloat = 2
    var moreLabel = "Show more"

    /// Accessibility keeps every line at its whole frame, cut off or not: while the text is
    /// clamped its container says so with this, for the e2e lint (`E2ELint`).
    nonisolated static let clipIdentifier = "clip"

    @ViewState private var expanded = false
    @ViewState private var fullHeight: CGFloat = 0
    @ViewState private var runs: [TextRun] = []

    /// A line's height and the spacing after it.
    private var pitch: CGFloat {
        let font = NSFont(name: Geist.postScriptName(.regular, mono: mono), size: size) ?? .systemFont(ofSize: size)
        return ceil(font.ascender - font.descender + font.leading) + lineSpacing
    }

    private var limit: CGFloat { CGFloat(lineLimit) * pitch }
    private var truncated: Bool { fullHeight > limit + 1 }
    private var clamped: Bool { truncated && !expanded }

    var body: some View {
        let cut = TextRun.cut(runs, limit: limit, pitch: pitch, spacing: lineSpacing)
        VStack(alignment: .leading, spacing: 4) {
            MarkdownView(blocks: Markdown.blocks(markdown), size: size, mono: mono, lineSpacing: lineSpacing)
                .coordinateSpace(.named(TextRun.space))
                .onPreferenceChange(TextRun.Key.self) { runs = $0 }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(maxHeight: clamped ? cut : nil, alignment: .top)
                .clipped()
                .mask {
                    VStack(spacing: 0) {
                        Color.black
                        if clamped {
                            HStack(spacing: 0) {
                                Color.black
                                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                                    .frame(width: 72)
                            }
                            .frame(height: pitch - lineSpacing)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(clamped ? Self.clipIdentifier : "")
                .frame(maxWidth: .infinity, alignment: .leading)
            if truncated {
                TextLink(expanded ? "Show less" : moreLabel) { expanded.toggle() }
                    .font(Typo.label)
            }
        }
    }
}

/// A block of a `MarkdownView` as laid out (a paragraph, a list item, a code block), so a
/// clamp can end between lines rather than through one.
struct TextRun: Equatable {
    var frame: CGRect
    /// A paragraph or a list item can end after any of its lines; a heading, a code block or
    /// a table only after the whole of it.
    var breaksLines: Bool

    static let space = "textRuns"

    struct Key: PreferenceKey {
        static let defaultValue: [TextRun] = []
        static func reduce(value: inout [TextRun], nextValue: () -> [TextRun]) { value += nextValue() }
    }

    /// Where a clamp `limit` points tall should end: after the last whole line above the
    /// limit. Blocks wholly above it are kept, the one it falls in is cut after its last
    /// line that fits, and nothing after that shows. `pitch` is a line with the `spacing`
    /// after it; a block's own pitch is measured from its height, so rounding in the font's
    /// metrics doesn't add up over its lines. With nothing measured yet, or a block that
    /// can't break first, it is the limit itself.
    static func cut(_ runs: [TextRun], limit: CGFloat, pitch: CGFloat, spacing: CGFloat) -> CGFloat {
        var cut: CGFloat?
        for run in runs.sorted(by: { $0.frame.minY < $1.frame.minY }) {
            if run.frame.maxY <= limit + 0.5 {
                cut = max(cut ?? 0, run.frame.maxY)
                continue
            }
            if run.breaksLines, run.frame.minY < limit {
                let lines = max(1, ((run.frame.height + spacing) / pitch).rounded())
                let own = (run.frame.height + spacing) / lines
                let fit = ((limit - run.frame.minY + spacing) / own).rounded(.down)
                if fit >= 1 { cut = run.frame.minY + fit * own - spacing }
            }
            break
        }
        return cut ?? limit
    }
}

extension View {
    /// Reports this block's frame to an enclosing `ClampedText` (`TextRun`).
    func textRun(breaksLines: Bool) -> some View {
        background {
            GeometryReader { geo in
                Color.clear.preference(
                    key: TextRun.Key.self,
                    value: [TextRun(frame: geo.frame(in: .named(TextRun.space)), breaksLines: breaksLines)]
                )
            }
        }
    }
}
