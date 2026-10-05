import SwiftUI

// Marks for live work: drawn from the clock rather than animated, so nothing they do
// can drag a row's layout along, and still under Reduce Motion.

// MARK: Live

/// A status dot with a 1pt halo of its colour, like the step bars; live, it breathes
/// (static under Reduce Motion).
struct LiveDot: View {
    let color: Color
    var live = false
    var size: CGFloat = 6

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.5), radius: 1)
            .modifier(Pulse(active: live))
    }
}

// MARK: Pulse

/// Gentle opacity pulse for "in progress". Static under Reduce Motion.
///
/// Opacity is computed from the clock on every frame instead of animated. Any SwiftUI
/// animation here (`withAnimation(.repeatForever)`, `phaseAnimator`) opens a transaction
/// that also captures layout changes in the row, such as new activity text or the list
/// reflowing, and the bars then slide out of place. A pure function of time cannot move
/// anything.
struct Pulse: ViewModifier {
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: Double = 2.2

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                content.opacity(0.7 + 0.3 * cos(phase * 2 * .pi))
            }
        } else {
            content
        }
    }
}

// MARK: Stepper marks

/// A dot with a soft glow. When it breathes (waiting on you), a halo swells from it and
/// fades, every couple of seconds; it holds still under Reduce Motion.
struct Beacon: View {
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
