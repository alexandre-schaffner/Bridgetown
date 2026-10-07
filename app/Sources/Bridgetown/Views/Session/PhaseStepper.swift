import SwiftUI

/// The daemon's six evidence-backed steps as a row of named pills joined by hairlines,
/// with what there is to show for each (its evidence) under it.
struct PhaseStepper: View {
    let session: Session

    var body: some View {
        StepFits { style in
            StepFlow {
                ForEach(Array(session.steps.enumerated()), id: \.offset) { index, step in
                    VStack(alignment: .leading, spacing: 7) {
                        StepPill(session: session, index: index, style: style)
                        evidence(step, shown: style == .named || (style == .focused && session.pillKind(at: index).isMarked))
                    }
                }
            }
        }
        .animation(StepPill.morph, value: session.pillKinds)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(session.headline). \(session.stepsDescription)")
    }

    /// The step's evidence, a line under its pill: only under a named one, since a mark's
    /// column is too narrow to read. Laid over a fixed-height line so it truncates to its
    /// column instead of widening it.
    private func evidence(_ step: Step, shown: Bool) -> some View {
        Color.clear
            .frame(height: 14)
            .overlay(alignment: .leading) {
                if shown, let text = step.detail {
                    Text(text)
                        .font(Typo.caption.monospacedDigit())
                        .foregroundStyle(step.state == .failed ? AnyShapeStyle(session.tone.stopTint) : AnyShapeStyle(.tertiary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, StepPill.inset)
                        .help(text)
                }
            }
    }
}

/// The six steps as pills on a row of the Agents board.
struct StepTrack: View {
    let session: Session

    var body: some View {
        StepFits { style in
            StepFlow {
                ForEach(Array(session.steps.indices), id: \.self) { index in
                    StepPill(session: session, index: index, small: true, style: style)
                }
            }
        }
        .animation(StepPill.morph, value: session.pillKinds)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.stepsDescription)
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
/// - resolved: the last step it reached tinted green with a green dot
/// - skipped: its name struck through
/// The hairline is brighter behind the session than ahead, runs into the colour of the
/// step in progress, and carries a light into it while something moves.
///
/// Without its name (`Style`), a step is a small mark in the same ink: a ring ahead, a dot
/// done, a dash skipped, and the in-play mark itself where the session is.
struct StepPill: View {
    let session: Session
    let index: Int
    /// The Agents board's smaller size.
    var small = false
    var style = Style.named
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How every change between states eases: colour, glow, width and the mark at once.
    static var morph: Animation { Easing.reduceMotion ? Easing.state : .smooth(duration: 0.45) }

    /// Where a large pill's name starts, for lining up what goes under it.
    static let inset: CGFloat = 9

    private var kind: Kind { session.pillKind(at: index) }
    private var step: Step { session.steps[index] }

    private var named: Bool { style == .named || (style == .focused && kind.isMarked) }
    /// The board's pills sit a little tighter, so a row of six fits its column whole.
    private var inset: CGFloat { small ? 7 : Self.inset }
    private var height: CGFloat { small ? 20 : 22 }
    private var mark: CGFloat { small ? 7 : 8 }

    var body: some View {
        HStack(spacing: 0) {
            if named { pill } else { bare }
            if index < session.steps.count - 1 {
                Connector(kind: connector, tint: session.pillTint(at: index + 1))
                    .padding(.horizontal, 3)
                    .frame(minWidth: style == .named ? 10 : 6)
            }
        }
        .help("\(step.label): \(step.state.describe(tone: session.tone))")
    }

    /// The step without its name: its mark alone, as wide as the mark and a little air.
    @ViewBuilder
    private var bare: some View {
        Group {
            switch kind {
            case .ahead: Circle().strokeBorder(ink, lineWidth: 1)
            case .done: Circle().fill(ink)
            case .skipped: Capsule().fill(ink).frame(height: 1.5)
            default: head
            }
        }
        .frame(width: mark, height: mark)
        .padding(.horizontal, 2)
        .frame(height: height)
    }

    private var pill: some View {
        HStack(spacing: 6) {
            if kind.isMarked {
                head
                    .frame(width: mark, height: mark)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.2).combined(with: .opacity))
            }
            Text(step.label)
                .font(.geist(small ? 10.5 : 11.5, kind.isMarked ? .semibold : .medium))
                .strikethrough(kind == .skipped)
                .foregroundStyle(ink)
                .lineLimit(1)
                .modifier(Shimmer(active: kind == .moving))
        }
        .padding(.leading, kind.isMarked ? inset - 2 : inset)
        .padding(.trailing, inset)
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
}

/// The hairline between two pills, fading out at both ends so it never quite touches
/// them. Brighter behind the session than ahead; into the step in progress it runs from
/// grey into that step's colour, and while something moves a light travels along it.
private struct Connector: View {
    enum Kind { case behind, leading, feeding, ahead, unreached }

    let kind: Kind
    let tint: Color
    @Environment(\.marksHoldStill) private var still

    var body: some View {
        line
            .frame(height: 1)
            .overlay {
                if kind == .feeding && !still {
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
