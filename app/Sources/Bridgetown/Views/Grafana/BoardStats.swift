import Foundation

// A board's numbers as the charts read them: units, the window at a glance, and the
// buckets the window is cut into. What is usual and what is a spike is the daemon's call
// (`Panel.usual`, `spikeAbove`, `spike`).

extension Board.Panel.Unit {
    /// "1.2k", "423 ms", "0.9/s", "567 MB".
    func format(_ value: Double) -> String {
        switch self {
        case .ms:
            return value >= 1000 ? "\(Format.decimal(value / 1000, digits: 1)) s" : "\(Int(value.rounded())) ms"
        case .per_s:
            return "\(value.formatted(.number.precision(.significantDigits(1...2)).locale(Format.locale)))/s"
        case .bytes:
            return Format.bytes(value)
        case .count, .unknown:
            return Format.count(value)
        }
    }
}

extension Board.Panel {
    private static func median(_ values: [Double]) -> Double? {
        let values = values.sorted()
        guard !values.isEmpty else { return nil }
        let mid = values.count / 2
        return values.count.isMultiple(of: 2) ? (values[mid - 1] + values[mid]) / 2 : values[mid]
    }

    struct Sample: Equatable {
        var at: Date
        var value: Double
    }

    /// The window at a glance, over the series summed at each timestamp (as `latest` is).
    struct Summary: Equatable {
        /// The highest bucket, the first if several tie.
        var peak: Sample
        var low: Sample
        var median: Double
        /// Every bucket added up: for a count, how many in the window.
        var total: Double
    }

    /// Nil when the panel failed or has no samples.
    var summary: Summary? {
        var sums: [Double: Double] = [:]
        for s in series {
            for p in s.points { sums[p.t, default: 0] += p.v }
        }
        let totals = sums.sorted { $0.key < $1.key }.map { Sample(at: Date(timeIntervalSince1970: $0.key), value: $0.value) }
        guard error == nil,
              let peak = totals.max(by: { $0.value < $1.value }),
              let low = totals.min(by: { $0.value < $1.value }),
              let median = Self.median(totals.map(\.value))
        else { return nil }
        return Summary(peak: peak, low: low, median: median, total: totals.reduce(0) { $0 + $1.value })
    }

    /// A series' value nearest `date`, or its last when `date` is nil.
    static func value(of series: Series, at date: Date?) -> Double? {
        guard let date else { return series.points.last?.v }
        let t = date.timeIntervalSince1970
        return series.points.min { abs($0.t - t) < abs($1.t - t) }?.v
    }
}

extension Board.Panel {
    var hasSamples: Bool { series.contains { !$0.points.isEmpty } }

    /// The chart's top: a little above the highest sample, or the usual level's rule.
    var chartTop: Double {
        let top = max(series.flatMap { $0.points.map(\.v) }.max() ?? 0, usual ?? 0)
        return top > 0 ? top * 1.15 : 1
    }
}

// MARK: Buckets

extension Board {
    /// What one bucket covers: the board's step, a second at the least.
    var step: TimeInterval { Double(max(1, stepSeconds)) }

    /// One column per bucket across the window, the same for every panel, so the shared
    /// crosshair lands on the same bucket in each.
    var columns: Int { max(1, Int((to.timeIntervalSince(from) / step).rounded(.up))) }

    /// The column `date` falls in, outside `0..<columns` when it is outside the window.
    func column(of date: Date) -> Int { Int((date.timeIntervalSince(from) / step).rounded(.down)) }

    /// The middle of a column's bucket: where the crosshair stands over it.
    func time(ofColumn column: Int) -> Date { from.addingTimeInterval((Double(column) + 0.5) * step) }

    /// How far across the window `date` is: 0 at its start, 1 at its end.
    func fraction(of date: Date) -> Double { date.timeIntervalSince(from) / max(1, to.timeIntervalSince(from)) }

    /// A panel's series as its chart draws them: a value per column, the largest sample in
    /// the bucket, nil where there was none. The series still reporting is bright and the
    /// rest faint, so for pods by version the new tag reads as the live one.
    func buckets(of panel: Panel) -> [BucketChart.Series] {
        let count = columns
        return panel.series.map { s in
            var values = [Double?](repeating: nil, count: count)
            for p in s.points {
                let c = column(of: Date(timeIntervalSince1970: p.t))
                if values.indices.contains(c) { values[c] = max(values[c] ?? 0, p.v) }
            }
            let reporting = panel.series.count == 1 || (s.points.last?.v ?? 0) > 0
            return BucketChart.Series(values: values, current: reporting)
        }
    }
}

extension Board {
    /// The window runs up to about now (within ten minutes), rather than around an alert.
    func endsNow(at now: Date) -> Bool { abs(to.timeIntervalSince(now)) < 600 }

    /// The panel to lead with: the one the prod watcher finds the most unusual, or else the
    /// board's first.
    var lead: Board.Panel? {
        panels.filter { $0.spike != nil }.max { ($0.spike ?? 0) < ($1.spike ?? 0) } ?? panels.first
    }

    /// "per 30m": what one point of a count panel covers.
    var stepLabel: String {
        stepSeconds % 3600 == 0 ? "\(stepSeconds / 3600)h" : "\(max(1, stepSeconds / 60))m"
    }
}
