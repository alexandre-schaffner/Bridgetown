import SwiftUI

/// The pills at their own widths, left to right, with the room left over shared equally
/// by the hairlines between them, so the row spreads evenly across the width and every
/// pill keeps its whole name. Each subview is a column: a pill and its hairline on, with
/// anything under it.
///
/// It never squeezes a column below its minimum: short of room it reports its true width,
/// so `StepFits` can tell and fall back to a narrower style instead of pills overlapping.
struct StepFlow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let minimums = minimums(subviews)
        let widths = Self.widths(minimums: minimums, total: proposal.width)
        let height = zip(subviews, widths)
            .map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            .max() ?? 0
        return CGSize(width: max(proposal.width ?? 0, widths.reduce(0, +)), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (sub, width) in zip(subviews, Self.widths(minimums: minimums(subviews), total: bounds.width)) {
            sub.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width
        }
    }

    /// Each column at its narrowest: the pill whole, the shortest hairline after it.
    private func minimums(_ subviews: Subviews) -> [CGFloat] {
        subviews.map { ceil($0.sizeThatFits(ProposedViewSize(width: 0, height: nil)).width) }
    }

    /// Column widths for `total` points: every column but the last gets an equal share of
    /// what the minimums leave over, so the hairlines come out the same length. When the
    /// minimums don't fit, they are what it gets.
    static func widths(minimums: [CGFloat], total: CGFloat?) -> [CGFloat] {
        let sum = minimums.reduce(0, +)
        guard let total, sum < total, !minimums.isEmpty else { return minimums }
        guard minimums.count > 1 else { return [total] }
        let share = (total - sum) / CGFloat(minimums.count - 1)
        return minimums.indices.map { minimums[$0] + ($0 < minimums.count - 1 ? share : 0) }
    }
}

/// A row of steps in the widest style that fits its column: every name, then only the
/// name of the step in play, then marks alone (`StepPill.Style`).
struct StepFits<Row: View>: View {
    @ViewBuilder let row: (StepPill.Style) -> Row

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(.named)
            row(.focused)
            row(.marks)
        }
    }
}
