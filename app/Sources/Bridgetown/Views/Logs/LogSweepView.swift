import SwiftUI

/// Prod → Logs: the daemon's last sweep of prod's logs, its lines grouped into patterns
/// (one message, numbers collapsed). The suspicious ones first (new or surging errors,
/// warnings that name a risk) with Jev's verdict and the finding it raised; the day's
/// steady errors behind a button. Clicking a pattern opens its lines in Grafana Explore.
struct LogSweepView: View {
    @Environment(Store.self) private var store

    var body: some View {
        PollingLoader(key: "logs", fetch: { try await store.fetch { try await $0.logs() } }) { loaded in
            if let sweep = loaded.value {
                SweepContent(sweep: sweep)
            } else if let error = loaded.error {
                BoardMessage(symbol: "exclamationmark.triangle", text: "Couldn't load the log sweep · \(error)")
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Reading the last sweep…")
                }
                .font(Typo.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, Metrics.inset)
            }
        }
    }
}

private struct SweepContent: View {
    let sweep: LogSweep
    @Environment(\.now) private var now
    @ViewState private var showSteady = false

    /// A line of the table: a pattern, or the fold the steady ones sit behind.
    private enum Row: Identifiable {
        case pattern(LogSweep.Pattern)
        case steady(count: Int)

        var id: String {
            switch self {
            case let .pattern(pattern): pattern.key
            case .steady: "fold.steady"
            }
        }
    }

    var body: some View {
        let suspicious = sweep.patterns.filter(\.suspicious)
        let steady = sweep.patterns.filter { !$0.suspicious }
        let rows = suspicious.map(Row.pattern)
            + (steady.isEmpty ? [] : [Row.steady(count: steady.count)])
            + (showSteady ? steady.map(Row.pattern) : [])
        VStack(alignment: .leading, spacing: 10) {
            if let error = sweep.error {
                BoardMessage(symbol: "exclamationmark.triangle", text: error)
            }
            // A failed query says so above: "not swept" or "nothing suspicious" would then
            // claim more than was read.
            if sweep.error == nil {
                if sweep.sweptAt == nil {
                    BoardMessage(
                        symbol: "text.magnifyingglass",
                        text: "Not swept yet. Every 10 minutes Bridgetown groups prod's error and warning lines into patterns; the first sweep runs a few minutes after it starts."
                    )
                } else if suspicious.isEmpty {
                    BoardMessage(symbol: "checkmark", text: "Nothing suspicious in the last sweep: no new or surging error, no risky warning.")
                }
            }
            if !rows.isEmpty {
                RowList(data: rows) { row in
                    switch row {
                    case let .pattern(pattern):
                        PatternRow(pattern: pattern)
                    case let .steady(count):
                        FoldRow(title: count == 1 ? "1 steady error" : "\(count) steady errors", open: showSteady, leading: PatternRow.textColumn) {
                            withAnimation(Easing.state) { showSteady.toggle() }
                        }
                        .accessibilityLabel(showSteady ? "Hide \(count) steady errors" : "Show \(count) steady errors")
                        .accessibilityIdentifier("logs.showSteady")
                    }
                }
            }
            footer
                .padding(.horizontal, Metrics.inset)
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text("Errors 24h · warnings 2h")
            if let sweptAt = sweep.sweptAt {
                Text("· swept \(Format.ago(sweptAt, now: now))")
            }
            Spacer(minLength: 0)
            TextLink("Open in Grafana", opening: sweep.link)
                .help("Prod's error lines over the last 3 hours, in Grafana Explore")
        }
        .font(Typo.time)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
}

// MARK: Row

private struct PatternRow: View {
    @Environment(Store.self) private var store
    let pattern: LogSweep.Pattern

    /// Where the words start, past the level's glyph: a fold row's line up with them.
    static let textColumn = Metrics.inset + 16 + 10

    /// Jev called it a problem and the daemon raised a finding for it.
    private var problem: Bool { pattern.alertId != nil }

    var body: some View {
        TableRow(open: { SystemActions.open(pattern.link) }) { _ in
            content
        } menu: {
            menu
        }
        .help(tooltip)
        .accessibilityIdentifier("logs.pattern.\(pattern.key)")
        .accessibilityAddTraits(.isLink)
        .accessibilityHint("Opens its lines in Grafana")
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: pattern.level == .warning ? "exclamationmark.triangle" : "xmark.octagon")
                .font(.geist(12.5, .medium))
                .foregroundStyle(problem ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.tertiary))
                .frame(width: 16)
                .centeredOnRowTitle()

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    // New, surging or risky: amber, the sweep's reason to look. Steady noise grey.
                    Text(pattern.headline)
                        .font(.geist(13, .medium))
                        .foregroundStyle(pattern.suspicious ? AnyShapeStyle(Ink.amber) : AnyShapeStyle(.secondary))
                        .fixedSize()
                    Text("· \(pattern.sourcesLabel)")
                        .font(Typo.body)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text("\(Format.count(pattern.recent)) in 15m")
                        .font(Typo.time)
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                }
                Text(pattern.example)
                    .font(.geistMono(11.5))
                    .lineSpacing(Typo.rowLineSpacing)
                    .foregroundStyle(pattern.suspicious ? .secondary : .tertiary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                if let verdict = pattern.verdictLine {
                    HStack(spacing: 6) {
                        Text(verdict)
                            .font(Typo.time)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        if let alertId = pattern.alertId {
                            TextLink("Finding", direction: .inward) { store.show(.alert(alertId)) }
                                .font(Typo.label)
                                .help("Show the finding Bridgetown raised for this pattern")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 14)
    }

    @ViewBuilder
    private var menu: some View {
        Button("Open lines in Grafana") { SystemActions.open(pattern.link) }
        if let alertId = pattern.alertId {
            Button("Show finding") { store.show(.alert(alertId)) }
        }
        Divider()
        Button("Copy example line") { SystemActions.copy(pattern.example) }
        Button("Copy pattern") { SystemActions.copy(pattern.message) }
    }

    private var tooltip: String {
        var lines = [pattern.message, "Logged by \(pattern.sources.joined(separator: ", "))"]
        if !pattern.versions.isEmpty { lines.append("Versions \(pattern.versions.joined(separator: ", "))") }
        lines.append("Click to open its lines in Grafana")
        return lines.joined(separator: "\n")
    }
}
