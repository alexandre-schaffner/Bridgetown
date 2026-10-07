import SwiftUI

// The app's clock and how times, numbers and names are written.

// MARK: - Clock

/// The time every view reads: ages, "polled 2m ago", whether a chart's window ends now.
/// The wall clock, unless an e2e run has stopped it at its suite's instant, the one the
/// mock daemon's clock stopped at too.
enum AppClock {
    static var now: Date {
        #if DEBUG
        if let override { return override }
        #endif
        return Date()
    }

    #if DEBUG
    /// Set once at launch (`E2EHarness.configure`), before any view reads the time.
    nonisolated(unsafe) static var override: Date?
    #endif
}

private struct NowKey: EnvironmentKey {
    static var defaultValue: Date { AppClock.now }
}

extension EnvironmentValues {
    /// The time ages and durations are measured to: the open island's 30-second tick
    /// (`IslandOpenView`). A view that reads it redraws on the tick even when nothing it
    /// was given has changed, so no age freezes while its row stands still.
    var now: Date {
        get { self[NowKey.self] }
        set { self[NowKey.self] = newValue }
    }
}

// MARK: - Formatting

enum Format {
    /// Numbers follow the copy, which is English: "1.2k" and "$0.97", never "1,2k" or "0,97 $".
    static let locale = Locale(identifier: "en_US")

    /// "0.9", "2.3": at most `digits` decimals, no trailing zeros.
    static func decimal(_ value: Double, digits: Int) -> String {
        value.formatted(.number.precision(.fractionLength(0...digits)).rounded(rule: .toNearestOrAwayFromZero).locale(locale))
    }

    /// Memory in binary units, one decimal below 100: "567 MB", "35.3 GB".
    static func bytes(_ value: Double) -> String {
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var v = max(0, value)
        var i = 0
        while v >= 1024, i < units.count - 1 {
            v /= 1024
            i += 1
        }
        return "\(decimal(v, digits: i == 0 || v >= 100 ? 0 : 1)) \(units[i])"
    }

    /// A count as a person reads it: "4.5" and "21" below a thousand (a decimal only
    /// while it changes the reading), then "1.2k", "34k", "1.2M".
    static func count(_ value: Double) -> String {
        let v = abs(value)
        switch v {
        case 1_000_000...: return "\(decimal(value / 1_000_000, digits: v < 10_000_000 ? 1 : 0))M"
        case 1000...: return "\(decimal(value / 1000, digits: v < 10_000 ? 1 : 0))k"
        case 10...: return decimal(value.rounded(), digits: 0)
        default: return decimal(value, digits: 1)
        }
    }

    /// "now", "4m", "2h", "3d", then a short date. Each unit counts whole ones, as a clock
    /// does: 59m59s is "59m", not "60m".
    static func relative(_ date: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(date))
        switch s {
        case ..<45: return "now"
        case ..<3600: return "\(max(1, Int(s / 60)))m"
        case ..<86_400: return "\(Int(s / 3600))h"
        case ..<(7 * 86_400): return "\(Int(s / 86_400))d"
        default: return date.formatted(.dateTime.month(.abbreviated).day())
        }
    }

    /// "just now", "4m ago", then a short date after a week.
    static func ago(_ date: Date, now: Date) -> String {
        let r = relative(date, now: now)
        if r == "now" { return "just now" }
        return now.timeIntervalSince(date) < 7 * 86_400 ? "\(r) ago" : r
    }

    /// "14:05" for history and transcript lines, and chart times: 24-hour whatever the
    /// locale, since without its AM/PM a 12-hour "02:05" reads as the small hours.
    static let clock = Date.VerbatimFormatStyle(
        format: "\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits)",
        timeZone: .current,
        calendar: .current
    )

    static func percent(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

    static func duration(from start: Date, to end: Date) -> String {
        let s = Int(max(0, end.timeIntervalSince(start)))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \(s % 3600 / 60)m"
    }

    static func cost(_ usd: Double) -> String {
        usd.formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(locale))
    }

    /// "#4123" from a GitHub PR URL, else "".
    static func prLabel(_ url: String) -> String {
        if let n = url.split(separator: "/").last, Int(n) != nil { return "#\(n)" }
        return ""
    }
}
