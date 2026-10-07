import SwiftUI

/// Left-aligned wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = Self.rows(sizes: sizes(subviews, within: width), width: width, spacing: spacing)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = sizes(subviews, within: bounds.width)
        var y = bounds.minY
        for row in Self.rows(sizes: sizes, width: bounds.width, spacing: spacing) {
            var x = bounds.minX
            for index in row.indices {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sizes[index]))
                x += sizes[index].width + spacing
            }
            y += row.height + spacing
        }
    }

    /// Each chip at its own size, except one wider than the row: that one is measured again
    /// at the row's width, so it is cut (or wraps) inside the row instead of running past
    /// its edge.
    private func sizes(_ subviews: Subviews, within width: CGFloat) -> [CGSize] {
        subviews.map { chip in
            let ideal = chip.sizeThatFits(.unspecified)
            return ideal.width <= width ? ideal : chip.sizeThatFits(ProposedViewSize(width: width, height: nil))
        }
    }

    struct Row: Equatable { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    /// Greedy line breaking: each item goes on the current row unless it would overflow
    /// `width`; an item as wide as `width` gets a row of its own.
    static func rows(sizes: [CGSize], width: CGFloat, spacing: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (i, size) in sizes.enumerated() {
            if !row.indices.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(i)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}
