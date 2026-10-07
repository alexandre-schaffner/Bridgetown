import SwiftUI

/// A panel's series, one bucket per column, snapped to the pixel grid. Grey by default;
/// amber only where a bucket is well above usual, so the one thing worth a look is the one
/// thing in colour.
///
/// - Counts are thin bars on a baseline, one per bucket.
/// - Gauges (latency, memory, CPU) and several series are smooth lines over a fading fill;
///   for pods by version, the series still reporting bright, the others faint.
///
/// The newest bucket is white, spikes amber; a dashed rule, behind the marks, is the
/// signal's usual level, as the prod watcher reads it. While hovering, the hovered bucket is white and the rest dim. Deploys
/// are dashed rules (red when they failed), the alert that opened the board a solid
/// amber one.
struct BucketChart: View {
    enum Style { case bars, levels }

    struct Series {
        /// One value per column; nil where the bucket had no sample.
        var values: [Double?]
        /// Drawn bright: the series still reporting.
        var current: Bool
    }

    let series: [Series]
    let style: Style
    let yMax: Double
    /// The prod watcher's usual level, drawn as the rule; nil where no rule watches the signal.
    let usual: Double?
    /// A bucket above this is one the watcher's rule calls a spike.
    let spikeAbove: Double?
    /// The hovered column, if any.
    let hovered: Int?
    /// Rules across the grid, as fractions of its width.
    var deploys: [(x: Double, failed: Bool)] = []
    var marker: Double?

    @Environment(\.displayScale) private var scale

    var body: some View {
        Canvas { context, size in
            draw(in: &context, size: size)
        }
        .accessibilityHidden(true)
    }

    private var columns: Int { series.map(\.values.count).max() ?? 0 }

    private func snap(_ v: CGFloat) -> CGFloat { (v * scale).rounded() / scale }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let count = columns
        guard count > 0, size.width > 0, size.height > 0 else { return }
        switch style {
        case .bars: drawBars(in: &context, size: size, count: count)
        case .levels: drawLines(in: &context, size: size, count: count)
        }
        drawRules(in: &context, size: size)
    }

    private var newest: Int? { series.compactMap { s in s.values.lastIndex { $0 != nil } }.max() }

    private func y(_ value: Double, in size: CGSize) -> CGFloat {
        yMax > 0 ? size.height - CGFloat(value / yMax) * size.height : size.height
    }

    /// The usual level: a dashed hairline, drawn first so whatever is lit sits over it.
    private func drawUsual(in context: inout GraphicsContext, size: CGSize) {
        guard let usual, yMax > 0 else { return }
        let y = snap(y(usual, in: size)) + 0.5 / scale
        var rule = Path()
        rule.move(to: CGPoint(x: 0, y: y))
        rule.addLine(to: CGPoint(x: size.width, y: y))
        context.stroke(rule, with: .color(.white.opacity(0.3)), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
    }

    // MARK: Bars

    /// One thin column per bucket, rising from a baseline hairline; nothing behind them.
    private func drawBars(in context: inout GraphicsContext, size: CGSize, count: Int) {
        let pitch = size.width / CGFloat(count)
        let width = max(1 / scale, snap(pitch * 0.58))
        var base = Path()
        base.move(to: CGPoint(x: 0, y: size.height - 0.5 / scale))
        base.addLine(to: CGPoint(x: size.width, y: size.height - 0.5 / scale))
        context.stroke(base, with: .color(.white.opacity(0.14)), lineWidth: 1 / scale)
        drawUsual(in: &context, size: size)

        let newest = newest
        for s in series {
            for (c, value) in s.values.enumerated() {
                guard let value, value > 0 else { continue }
                let x = snap(CGFloat(c) * pitch + (pitch - width) / 2)
                // At least two pixels, so a small count still shows.
                let top = min(snap(y(value, in: size)), size.height - 2 / scale)
                let rect = CGRect(x: x, y: top, width: width, height: size.height - top)
                context.fill(Path(rect), with: .color(barColor(column: c, value: value, newest: newest, current: s.current)))
            }
        }
    }

    // MARK: Lines

    /// A smooth line through every sample, over a fill that fades to nothing; spikes as
    /// amber dots, the newest (or hovered) sample as a white one.
    private func drawLines(in context: inout GraphicsContext, size: CGSize, count: Int) {
        let pitch = size.width / CGFloat(count)
        func point(_ c: Int, _ value: Double) -> CGPoint {
            CGPoint(x: CGFloat(c) * pitch + pitch / 2, y: max(0.75, y(value, in: size)))
        }
        drawUsual(in: &context, size: size)
        if let hovered {
            let x = snap(CGFloat(hovered) * pitch + pitch / 2) + 0.5 / scale
            var rule = Path()
            rule.move(to: CGPoint(x: x, y: 0))
            rule.addLine(to: CGPoint(x: x, y: size.height))
            context.stroke(rule, with: .color(.white.opacity(0.35)), lineWidth: 1)
        }

        let newest = newest
        for s in series {
            // Runs of consecutive samples; a missing bucket breaks the line.
            var runs: [[(Int, Double)]] = [[]]
            for (c, value) in s.values.enumerated() {
                if let value { runs[runs.count - 1].append((c, value)) } else if !(runs.last?.isEmpty ?? true) { runs.append([]) }
            }
            for run in runs where !run.isEmpty {
                let points = run.map { point($0.0, $0.1) }
                let line = Self.smooth(points)
                if series.count == 1, let first = points.first, let last = points.last {
                    var area = line
                    area.addLine(to: CGPoint(x: last.x, y: size.height))
                    area.addLine(to: CGPoint(x: first.x, y: size.height))
                    area.closeSubpath()
                    context.fill(
                        area,
                        with: .linearGradient(
                            Gradient(colors: [.white.opacity(0.1), .white.opacity(0)]),
                            startPoint: CGPoint(x: 0, y: 0),
                            endPoint: CGPoint(x: 0, y: size.height)
                        )
                    )
                }
                context.stroke(
                    line,
                    with: .color(.white.opacity(s.current ? (hovered == nil ? 0.85 : 0.5) : 0.22)),
                    style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
                )
            }
            guard s.current else { continue }
            for (c, value) in s.values.enumerated() {
                guard let value else { continue }
                let spike = isSpike(value)
                let marked = c == hovered || (hovered == nil && c == newest)
                guard spike || marked else { continue }
                let p = point(c, value)
                let r: CGFloat = marked ? 2.5 : 2
                context.fill(
                    Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)),
                    with: .color(marked ? Ink.text : Ink.amber)
                )
            }
        }
    }

    /// A monotone cubic through `points` (Fritsch–Carlson): smooth, yet it passes through
    /// every sample and never swings past a neighbour, so a curve can't invent a peak or a
    /// dip below zero that the data doesn't have.
    static func smooth(_ points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        let n = points.count
        guard n > 2 else {
            points.dropFirst().forEach { path.addLine(to: $0) }
            return path
        }
        // Secant slopes, then tangents: zero at a turn, the mean elsewhere, then clamped.
        var secant = [CGFloat](repeating: 0, count: n - 1)
        for i in 0..<(n - 1) {
            let dx = points[i + 1].x - points[i].x
            secant[i] = dx == 0 ? 0 : (points[i + 1].y - points[i].y) / dx
        }
        var tangent = [CGFloat](repeating: 0, count: n)
        tangent[0] = secant[0]
        tangent[n - 1] = secant[n - 2]
        for i in 1..<(n - 1) {
            tangent[i] = secant[i - 1] * secant[i] <= 0 ? 0 : (secant[i - 1] + secant[i]) / 2
        }
        for i in 0..<(n - 1) where secant[i] == 0 {
            tangent[i] = 0
            tangent[i + 1] = 0
        }
        for i in 0..<(n - 1) where secant[i] != 0 {
            let a = tangent[i] / secant[i]
            let b = tangent[i + 1] / secant[i]
            let length = a * a + b * b
            if length > 9 {
                let t = 3 / length.squareRoot()
                tangent[i] = t * a * secant[i]
                tangent[i + 1] = t * b * secant[i]
            }
        }
        for i in 0..<(n - 1) {
            let p0 = points[i], p1 = points[i + 1]
            let third = (p1.x - p0.x) / 3
            path.addCurve(
                to: p1,
                control1: CGPoint(x: p0.x + third, y: p0.y + tangent[i] * third),
                control2: CGPoint(x: p1.x - third, y: p1.y - tangent[i + 1] * third)
            )
        }
        return path
    }

    // MARK: Rules

    private func drawRules(in context: inout GraphicsContext, size: CGSize) {
        for deploy in deploys {
            let x = snap(CGFloat(deploy.x) * size.width) + 0.5 / scale
            var rule = Path()
            rule.move(to: CGPoint(x: x, y: 0))
            rule.addLine(to: CGPoint(x: x, y: size.height))
            context.stroke(
                rule,
                with: .color(deploy.failed ? Ink.red.opacity(0.85) : .white.opacity(0.4)),
                style: StrokeStyle(lineWidth: 1, dash: [2, 2])
            )
        }
        if let marker {
            let x = snap(CGFloat(marker) * size.width) + 0.5 / scale
            var rule = Path()
            rule.move(to: CGPoint(x: x, y: 0))
            rule.addLine(to: CGPoint(x: x, y: size.height))
            context.stroke(rule, with: .color(Ink.amber), style: StrokeStyle(lineWidth: 1.25))
        }
    }

    private func isSpike(_ value: Double) -> Bool { spikeAbove.map { value > $0 } ?? false }

    /// A bar's colour: a spike amber (white while hovered); else the hovered bar white and
    /// the rest dim, or the newest white and the rest quiet grey. A series no longer
    /// reporting stays faint throughout.
    private func barColor(column: Int, value: Double, newest: Int?, current: Bool) -> Color {
        guard current else { return .white.opacity(0.2) }
        let spike = isSpike(value)
        if let hovered {
            if column == hovered { return .white.opacity(0.95) }
            return spike ? Ink.amber.opacity(0.4) : .white.opacity(0.28)
        }
        if spike { return Ink.amber.opacity(column == newest ? 1 : 0.85) }
        if column == newest { return .white.opacity(0.95) }
        return .white.opacity(0.42)
    }
}
