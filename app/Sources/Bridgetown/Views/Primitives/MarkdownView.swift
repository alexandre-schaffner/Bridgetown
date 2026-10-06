import SwiftUI

/// Markdown laid out as blocks: paragraphs, headings, lists with hanging indents, outlined
/// code blocks, quotes behind a rule, and tables separated by hairlines. Selectable.
struct MarkdownView: View {
    let blocks: [Markdown.Block]
    var size: CGFloat = 12
    /// Geist Mono for the words too (raw Slack messages); code is always mono.
    var mono = false
    var lineSpacing: CGFloat = 2

    var body: some View {
        VStack(alignment: .leading, spacing: size * 0.6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .font(font())
        .lineSpacing(lineSpacing)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(for block: Markdown.Block) -> some View {
        switch block {
        case .paragraph(let s):
            text(s)
        case .heading(let level, let s):
            text(s).font(font(level == 1 ? size + 1 : size, .semibold)).foregroundStyle(.primary)
        case .list(let items):
            VStack(alignment: .leading, spacing: size * 0.3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: size * 0.4) {
                        Text(item.marker)
                            .monospacedDigit()
                            .foregroundStyle(item.marker == "•" ? .tertiary : .secondary)
                            .frame(minWidth: size * 0.9, alignment: .trailing)
                        text(item.text)
                    }
                    .padding(.leading, CGFloat(item.depth) * size)
                }
            }
        case .code(let code):
            Text(code)
                .font(.geistMono(mono ? size : size - 0.5))
                .lineSpacing(1.5)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .outlined(radius: Ink.controlRadius)
        case .quote(let inner):
            HStack(alignment: .top, spacing: 8) {
                Ink.outline.frame(width: 2).clipShape(Capsule())
                // Recursive, so type-erased.
                AnyView(MarkdownView(blocks: inner, size: size, mono: mono, lineSpacing: lineSpacing))
            }
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        case .table(let header, let rows):
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        text(cell).font(font(size, .semibold))
                    }
                }
                Hairline().gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in text(cell) }
                    }
                }
            }
        case .rule:
            Hairline()
        }
    }

    private func text(_ s: String) -> some View {
        Text(Markdown.inline(s, size: size, mono: mono).underliningLinks())
            .fixedSize(horizontal: false, vertical: true)
    }

    private func font(_ size: CGFloat? = nil, _ weight: Font.Weight = .regular) -> Font {
        mono ? .geistMono(size ?? self.size, weight) : .geist(size ?? self.size, weight)
    }
}

extension AttributedString {
    /// Its links underlined. They take the text's colour (the stage's tint), as colour is
    /// for status, so the line is what marks them.
    func underliningLinks() -> AttributedString {
        var text = self
        for run in text.runs where run.link != nil {
            text[run.range].underlineStyle = .single
        }
        return text
    }
}
