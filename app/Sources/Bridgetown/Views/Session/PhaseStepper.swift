import SwiftUI

/// The daemon's six evidence-backed steps as a row of named pills joined by hairlines,
/// with what there is to show for each (its evidence) under it.
struct PhaseStepper: View {
    let session: Session

    var body: some View {
        StepFlow {
            ForEach(Array(session.steps.enumerated()), id: \.offset) { index, step in
                VStack(alignment: .leading, spacing: 7) {
                    StepPill(session: session, index: index)
                    evidence(step)
                }
            }
        }
        .animation(StepPill.morph, value: session.pillKinds)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    /// The step's evidence, a line under its pill. Laid over a fixed-height line so it
    /// truncates to its column instead of widening it.
    private func evidence(_ step: Step) -> some View {
        Color.clear
            .frame(height: 14)
            .overlay(alignment: .leading) {
                if let text = session.evidence(for: step) {
                    Text(text)
                        .font(.geist(11).monospacedDigit())
                        .foregroundStyle(step.state == .failed ? AnyShapeStyle(session.tone.stopTint) : AnyShapeStyle(.tertiary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, StepPill.inset)
                        .help(text)
                }
            }
    }

    private var accessibilityText: String {
        let steps = session.steps.map { "\($0.label) \($0.state.describe(tone: session.tone))" }.joined(separator: ", ")
        return "\(session.headline). \(steps)"
    }
}

/// The six steps as pills on a row of the Agents board.
struct StepTrack: View {
    let session: Session

    var body: some View {
        StepFlow {
            ForEach(Array(session.steps.indices), id: \.self) { index in
                StepPill(session: session, index: index, small: true)
            }
        }
        .animation(StepPill.morph, value: session.pillKinds)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.steps.map { "\($0.label) \($0.state.describe(tone: session.tone))" }.joined(separator: ", "))
    }
}

/// One step as a pill with its name in it, and the hairline on to the next. A step only
/// takes shape once the session reaches it, and the pill says how it stands, so nothing
/// relies on colour alone:
/// - ahead: just its name, faint (fainter once the session has ended and won't get there)
/// - done: a soft grey chip
/// - in progress: a chip tinted in the session's colour, glowing faintly, with what's
///   happening at its head: an arc spinning while something moves (the agent, CI, a
///   deploy), its name shimmering; a ring round a dot while it sits with reviewers or in
///   the queue; an amber dot, its halo breathing, when it waits on you
/// - failed: tinted red with a red dot; stopped or closed: grey with a bar
/// - resolved: the last chip tinted green with a green dot
/// - skipped: its name struck through
/// The hairline is brighter behind the session than ahead, runs into the colour of the
/// step in progress, and carries a light into it while something moves.
struct StepPill: View {
    let session: Session
    let index: Int
    /// The Agents board's smaller size.
    var small = false

    /// How every change between states eases: colour, glow, width and the mark at once.
    static var morph: Animation { Easing.reduceMotion ? Easing.state : .smooth(duration: 0.45) }

    /// Where a pill's name starts, for lining up what goes under it.
    static let inset: CGFloat = 9

    private var kind: Kind { session.pillKind(at: index) }
    private var step: Step { session.steps[index] }

    private var height: CGFloat { small ? 20 : 22 }
    private var mark: CGFloat { small ? 7 : 8 }

    var body: some View {
        HStack(spacing: 0) {
            pill
            if index < session.steps.count - 1 {
                Connector(kind: connector, tint: session.pillTint(at: index + 1))
                    .padding(.horizontal, 4)
                    .frame(minWidth: 14)
            }
        }
        .help("\(step.label): \(step.state.describe(tone: session.tone))")
    }

    private var pill: some View {
        HStack(spacing: 6) {
            if kind.isMarked {
                head
                    .frame(width: mark, height: mark)
                    .transition(.scale(scale: 0.2).combined(with: .opacity))
            }
            Text(step.label)
                .font(.geist(small ? 10.5 : 11.5, kind.isMarked ? .semibold : .medium))
                .strikethrough(kind == .skipped)
                .foregroundStyle(ink)
                .lineLimit(1)
                .modifier(Shimmer(active: kind == .moving))
        }
        .padding(.leading, kind.isMarked ? Self.inset - 2 : Self.inset)
        .padding(.trailing, Self.inset)
        .frame(height: height)
        .background {
            ZStack {
                Capsule(style: .circular).fill(fill)
                // True semicircle ends: the continuous curve reads squarish this small.
                // A lit top edge, fading by the middle, gives depth without a border.
                Capsule(style: .circular).strokeBorder(
                    LinearGradient(colors: [Color.white.opacity(lift), .clear], startPoint: .top, endPoint: .center),
                    lineWidth: 1
                )
                Capsule(style: .circular).strokeBorder(border, lineWidth: 1)
            }
            .shadow(color: tint.opacity(glows ? 0.3 : 0), radius: 8)
        }
        .fixedSize()
    }

    /// What's happening, at the head of a marked pill.
    @ViewBuilder
    private var head: some View {
        let line = max(1.25, mark / 6)
        switch kind {
        case .moving:
            Spinner(color: tint, lineWidth: line)
        case .held:
            ZStack {
                Circle().strokeBorder(tint, lineWidth: line)
                Circle().fill(tint).frame(width: mark * 0.36, height: mark * 0.36)
            }
        case .stopped:
            Capsule().fill(tint).frame(width: mark, height: line)
        default:
            Beacon(color: tint, breathes: kind == .you)
        }
    }

    private var connector: Connector.Kind {
        let next = session.pillKind(at: index + 1)
        if index + 1 == session.markerIndex, [.moving, .held, .you].contains(next) {
            return next == .moving ? .feeding : .leading
        }
        if index < session.markerIndex { return .behind }
        return session.isActive ? .ahead : .unreached
    }

    private var tint: Color { session.pillTint(at: index) }

    private var glows: Bool { kind.isMarked && kind != .stopped }

    private var ink: Color {
        switch kind {
        case .ahead, .skipped: session.isActive ? Ink.faint : Ink.faint.opacity(0.55)
        case .done: Ink.dim
        case .stopped: Ink.text.opacity(0.85)
        default: tint
        }
    }

    private var fill: Color {
        switch kind {
        case .ahead, .skipped: .clear
        case .done: Color.white.opacity(0.06)
        case .stopped: Color.white.opacity(0.08)
        default: tint.opacity(0.14)
        }
    }

    private var lift: Double {
        switch kind {
        case .ahead, .skipped: 0
        case .done, .stopped: 0.1
        default: 0.16
        }
    }

    private var border: Color {
        switch kind {
        case .ahead, .skipped, .done: .clear
        case .stopped: Color.white.opacity(0.18)
        default: tint.opacity(0.4)
        }
    }

    enum Kind: Hashable {
        case ahead, done, moving, held, you, failed, stopped, resolved, skipped

        /// Tinted, with a mark at its head: where the session is, or how it ended.
        var isMarked: Bool { ![.ahead, .done, .skipped].contains(self) }
    }
}

/// The hairline between two pills, fading out at both ends so it never quite touches
/// them. Brighter behind the session than ahead; into the step in progress it runs from
/// grey into that step's colour, and while something moves a light travels along it.
private struct Connector: View {
    enum Kind { case behind, leading, feeding, ahead, unreached }

    let kind: Kind
    let tint: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        line
            .frame(height: 1)
            .overlay {
                if kind == .feeding && !reduceMotion {
                    TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
                        GeometryReader { geo in
                            let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                            let eased = 1 - pow(1 - t, 3)
                            let band = max(10, geo.size.width * 0.45)
                            LinearGradient(colors: [tint.opacity(0), .white.opacity(0.9), tint.opacity(0)], startPoint: .leading, endPoint: .trailing)
                                .frame(width: band, height: 1.5)
                                .offset(x: -band + (geo.size.width + band) * eased, y: -0.25)
                                .opacity(1 - pow(t, 4))
                        }
                    }
                    .allowsHitTesting(false)
                }
            }
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.2),
                                         .init(color: .black, location: 0.8), .init(color: .clear, location: 1)],
                                 startPoint: .leading, endPoint: .trailing))
    }

    @ViewBuilder
    private var line: some View {
        switch kind {
        case .behind: Color.white.opacity(0.26)
        case .leading, .feeding: LinearGradient(colors: [Color.white.opacity(0.26), tint.opacity(0.8)], startPoint: .leading, endPoint: .trailing)
        case .ahead: Color.white.opacity(0.11)
        case .unreached: Color.white.opacity(0.06)
        }
    }
}

/// A dot with a soft glow. When it breathes (waiting on you), a halo swells from it and
/// fades, every couple of seconds; it holds still under Reduce Motion.
private struct Beacon: View {
    let color: Color
    var breathes = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !breathes || reduceMotion)) { context in
            let t = breathes && !reduceMotion ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4 : 1
            ZStack {
                Circle().fill(color.opacity(0.45 * (1 - t)))
                    .scaleEffect(1 + 1.1 * t)
                Circle().fill(color)
                    .scaleEffect(0.8)
                    .shadow(color: color.opacity(0.8), radius: 2)
            }
        }
    }
}

/// An arc chasing round a faint ring, as Vercel's builds show one, its length breathing as
/// it turns: work in motion. Drawn from the clock, like `Pulse`, so it can't drag the
/// row's layout along. Under Reduce Motion it holds still, still an arc on a ring.
struct Spinner: View {
    let color: Color
    var lineWidth: CGFloat = 1.5
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: reduceMotion)) { context in
            let time = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            let turn = time.truncatingRemainder(dividingBy: 0.95) / 0.95
            let length = 0.22 + 0.16 * (0.5 + 0.5 * sin(2 * .pi * time / 1.5))
            ZStack {
                Circle().stroke(color.opacity(0.22), lineWidth: lineWidth)
                Circle().trim(from: 0, to: length)
                    .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(turn * 360 - 90))
            }
            .padding(lineWidth / 2)
        }
    }
}

/// A light running through a label, left to right, as Vercel marks work in progress.
/// Nothing moves under Reduce Motion.
struct Shimmer: ViewModifier {
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: Double = 2

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    GeometryReader { geo in
                        let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                        let band = max(28, geo.size.width * 0.8)
                        LinearGradient(colors: [.white.opacity(0), .white.opacity(0.8), .white.opacity(0)], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band)
                            .offset(x: -band + (geo.size.width + band) * t)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        } else {
            content
        }
    }
}

extension Session {
    /// Where the session is: the step in progress or the one that failed; the next step
    /// when it waits between two (ready to merge, approval to release); past the end once
    /// resolved; where it stopped otherwise.
    var markerIndex: Int {
        let frontier = steps.firstIndex { $0.state == .pending || $0.state == .unknown } ?? steps.count
        if let i = steps.firstIndex(where: { $0.state == .failed }) { return i }
        if holder != nil { return steps.firstIndex { $0.state == .current } ?? frontier }
        if tone == .success { return steps.count }
        return frontier
    }

    /// How each step's pill stands, for animating a change across the row.
    var pillKinds: [StepPill.Kind] { steps.indices.map(pillKind(at:)) }

    func pillKind(at index: Int) -> StepPill.Kind {
        let step = steps[index]
        let at = markerIndex
        if step.state == .failed { return tone == .failure ? .failed : .stopped }
        if index == at, let holder {
            if holder == .you || tone == .waiting { return .you }
            return holder.isMoving ? .moving : .held
        }
        if index == at, !isActive { return .stopped }
        if step.state == .skipped { return .skipped }
        if index < at || step.state == .done {
            return tone == .success && index == steps.count - 1 ? .resolved : .done
        }
        return .ahead
    }

    /// A marked pill's colour: the session's while it's in play (amber on you), red where
    /// it failed, green once resolved, grey where it stopped.
    func pillTint(at index: Int) -> Color {
        switch pillKind(at: index) {
        case .moving, .held: tone.isQuiet ? Color(white: 0.62) : tone.color
        case .you: Ink.amber
        case .failed: Ink.red
        case .resolved: Ink.green
        default: Color(white: 0.62)
        }
    }
}

/// The pills at their own widths, left to right, with the room left over shared equally
/// by the hairlines between them, so the row spreads evenly across the width and every
/// pill keeps its whole name. Each subview is a column: a pill and its hairline on, with
/// anything under it.
struct StepFlow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let widths = Self.widths(minimums: minimums(subviews), total: proposal.width)
        let height = zip(subviews, widths)
            .map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            .max() ?? 0
        return CGSize(width: proposal.width ?? widths.reduce(0, +), height: height)
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
    /// what the minimums leave over, so the hairlines come out the same length. When even
    /// the minimums don't fit, every column scales down.
    static func widths(minimums: [CGFloat], total: CGFloat?) -> [CGFloat] {
        guard let total, !minimums.isEmpty else { return minimums }
        let sum = minimums.reduce(0, +)
        guard sum <= total else { return minimums.map { $0 * total / max(sum, 1) } }
        guard minimums.count > 1 else { return [total] }
        let share = (total - sum) / CGFloat(minimums.count - 1)
        return minimums.indices.map { minimums[$0] + ($0 < minimums.count - 1 ? share : 0) }
    }
}
