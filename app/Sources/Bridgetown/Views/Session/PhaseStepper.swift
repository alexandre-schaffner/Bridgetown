import SwiftUI

/// The daemon's five evidence-backed steps. Each state has its own shape and label
/// treatment, so nothing relies on colour alone:
/// done = filled accent · current = accent, pulsing while live · pending = hollow outline ·
/// failed = filled red (failure) or gray (closed, stopped) with a glyph · skipped = dashed.
struct PhaseStepper: View {
    let session: Session
    var showsLabels = true

    private static let height: CGFloat = 4

    private var tone: Tone { session.tone }

    var body: some View {
        StepColumns(spacing: 3) {
            ForEach(Array(session.steps.enumerated()), id: \.offset) { _, step in
                VStack(alignment: .leading, spacing: 4) {
                    segment(step.state)
                        .frame(height: Self.height)
                    if showsLabels {
                        label(step)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .help("\(step.label): \(step.state.describe(tone: tone))")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private func segment(_ state: Step.State) -> some View {
        switch state {
        case .done:
            Capsule().fill(Color.accentColor)
        case .current:
            Capsule().fill(Color.accentColor)
                .modifier(Pulse(active: tone == .live))
        case .failed:
            Capsule().fill(tone.stopTint)
        case .skipped:
            DashedLine()
                .stroke(.tertiary, style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [2, 3]))
        case .pending, .unknown:
            Capsule().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
        }
    }

    private func label(_ step: Step) -> some View {
        HStack(spacing: 2) {
            if step.state == .failed {
                Image(systemName: tone.stopSymbol)
                    .font(.system(size: 9, weight: .medium))
            }
            Text(step.label)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .font(.system(size: 10, weight: step.state.isEmphasized ? .semibold : .regular))
        .foregroundStyle(step.state.labelStyle(stopTint: tone.stopTint))
    }

    private var accessibilityText: String {
        let steps = session.steps.map { "\($0.label) \($0.state.describe(tone: tone))" }.joined(separator: ", ")
        return "\(session.headline). \(steps)"
    }
}

/// Equal-width columns, except that a column whose content needs more room (a long
/// label such as "Root cause?") gets its ideal width and the others share the rest.
struct StepColumns: Layout {
    var spacing: CGFloat

    /// A little air after each label so a widened one doesn't run into the next.
    private static let labelAir: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let widths = Self.widths(ideals: ideals(subviews), total: proposal.width, spacing: spacing)
        let height = zip(subviews, widths)
            .map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            .max() ?? 0
        return CGSize(width: proposal.width ?? (widths.reduce(0, +) + Self.gaps(subviews.count, spacing)), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (sub, width) in zip(subviews, Self.widths(ideals: ideals(subviews), total: bounds.width, spacing: spacing)) {
            sub.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width + spacing
        }
    }

    private func ideals(_ subviews: Subviews) -> [CGFloat] {
        subviews.map { ceil($0.sizeThatFits(.unspecified).width) + Self.labelAir }
    }

    private static func gaps(_ count: Int, _ spacing: CGFloat) -> CGFloat { spacing * CGFloat(max(count - 1, 0)) }

    /// Column widths for `total` points. Water-fill: columns wider than an equal share
    /// keep their ideal width and the rest split what remains evenly. When even the ideals
    /// don't fit, every column scales down and labels truncate.
    static func widths(ideals: [CGFloat], total: CGFloat?, spacing: CGFloat) -> [CGFloat] {
        guard let total, !ideals.isEmpty else { return ideals }
        let available = max(0, total - gaps(ideals.count, spacing))
        let sum = ideals.reduce(0, +)
        guard sum <= available else {
            let scale = available / max(sum, 1)
            return ideals.map { $0 * scale }
        }
        var wide = Set<Int>()
        while wide.count < ideals.count {
            let share = (available - wide.reduce(0) { $0 + ideals[$1] }) / CGFloat(ideals.count - wide.count)
            let newlyWide = ideals.indices.filter { !wide.contains($0) && ideals[$0] > share }
            if newlyWide.isEmpty {
                return ideals.indices.map { wide.contains($0) ? ideals[$0] : share }
            }
            wide.formUnion(newlyWide)
        }
        return ideals
    }
}

private struct DashedLine: Shape {
    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: rect.minX + 0.5, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.maxX - 0.5, y: rect.midY))
        }
    }
}
