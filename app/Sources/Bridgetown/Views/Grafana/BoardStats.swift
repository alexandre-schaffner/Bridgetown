import Foundation

// A board's numbers as the charts read them: units, the window's usual level, spikes.

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
    /// The window's usual level, the median of its one series; nil for several series,
    /// an empty window or a median of zero.
    var typical: Double? {
        guard series.count == 1, let median = Self.median(series[0].points.compactMap { $0.count == 2 ? $0[1] : nil })
        else { return nil }
        return median > 0 ? median : nil
    }

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
            for p in s.points where p.count == 2 { sums[p[0], default: 0] += p[1] }
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
        guard let date else { return series.points.last?.last }
        let t = date.timeIntervalSince1970
        return series.points.min { abs($0[0] - t) < abs($1[0] - t) }?.last
    }

    /// Well above usual: at least 1.8× the median, and more than one over it.
    static func isSpike(_ value: Double, typical: Double?) -> Bool {
        guard let typical else { return false }
        return value >= max(typical * 1.8, typical + 1)
    }

    /// How unusual the latest value is, as a multiple of the median, when it spikes.
    var spikeRatio: Double? {
        guard error == nil, let latest, let typical, Self.isSpike(latest, typical: typical) else { return nil }
        return latest / typical
    }
}

extension Board {
    /// The window runs up to about now (within ten minutes), rather than around an alert.
    func endsNow(at now: Date) -> Bool { abs(to.timeIntervalSince(now)) < 600 }

    /// The panel to lead with: the one spiking hardest, or else the board's first.
    var lead: Board.Panel? {
        panels.filter { $0.spikeRatio != nil }.max { ($0.spikeRatio ?? 0) < ($1.spikeRatio ?? 0) } ?? panels.first
    }

    /// "per 30m": what one point of a count panel covers.
    var stepLabel: String {
        stepSeconds % 3600 == 0 ? "\(stepSeconds / 3600)h" : "\(max(1, stepSeconds / 60))m"
    }
}
