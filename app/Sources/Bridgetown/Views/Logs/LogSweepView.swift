import AppKit
import SwiftUI

/// Prod → Logs: the daemon's last sweep of prod's logs, its lines grouped into patterns
/// (one message, numbers collapsed). The suspicious ones first (new or surging errors,
/// warnings that name a risk) with Jev's verdict and the finding it raised; the day's
/// steady errors behind a button. Clicking a pattern opens its lines in Grafana Explore.
struct LogSweepView: View {
    @Environment(Store.self) private var store
    let now: Date

    var body: some View {
        PollingLoader(key: "logs", fetch: { try await store.logSweep() }) { loaded in
            if let sweep = loaded.value {
                SweepContent(sweep: sweep, now: now)
            } else if let error = loaded.error {
                BoardMessage(symbol: "exclamationmark.triangle", text: "Couldn't load the log sweep · \(error)")
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Reading the last sweep…")
                }
                .font(.geist(11))
                .foregroundStyle(.tertiary)
                .bleedInset()
            }
        }
    }
}

private struct SweepContent: View {
    let sweep: LogSweep
    let now: Date
    @ViewState private var showSteady = false

    var body: some View {
        let suspicious = sweep.patterns.filter(\.suspicious)
        let steady = sweep.patterns.filter { !$0.suspicious }
        VStack(alignment: .leading, spacing: 10) {
            if let error = sweep.error {
                BoardMessage(symbol: "exclamationmark.triangle", text: error)
            }
            if sweep.sweptAt == nil {
                if sweep.error == nil {
                    BoardMessage(
                        symbol: "text.magnifyingglass",
                        text: "Not swept yet. Every 10 minutes Bridgetown groups prod's error and warning lines into patterns; the first sweep runs a few minutes after it starts."
                    )
                }
            } else if suspicious.isEmpty {
                // A failed query says so above; "nothing suspicious" would claim more than was read.
                if sweep.error == nil {
                    BoardMessage(symbol: "checkmark", text: "Nothing suspicious in the last sweep: no new or surging error, no risky warning.")
                }
            } else {
                RowList(data: suspicious) { PatternRow(pattern: $0) }
            }
            if !steady.isEmpty {
                if showSteady {
                    RowList(data: steady) { PatternRow(pattern: $0) }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                Button(showSteady ? "Hide steady errors" : "Show \(steady.count) steady error\(steady.count == 1 ? "" : "s")") {
                    withAnimation(Easing.state) { showSteady.toggle() }
                }
                .buttonStyle(.stage(.secondary, compact: true))
                .frame(maxWidth: .infinity)
            }
            footer
                .bleedInset()
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text("Errors 24h · warnings 2h")
            if let sweptAt = sweep.sweptAt {
                Text("· swept \(Format.ago(sweptAt, now: now))")
            }
            Spacer(minLength: 0)
            Button {
                SystemActions.open(sweep.link)
            } label: {
                NudgeLabel(title: "Open in Grafana", symbol: "arrow.up.right", nudge: CGSize(width: 1.5, height: -1.5))
            }
            .buttonStyle(.plain)
            .help("Prod's error lines over the last 3 hours, in Grafana Explore")
        }
        .font(.geist(11.5).monospacedDigit())
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
}

// MARK: Row

private struct PatternRow: View {
    @Environment(Store.self) private var store
    let pattern: LogSweep.Pattern

    /// Jev called it a problem and the daemon raised a finding for it.
    private var problem: Bool { pattern.alertId != nil }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: pattern.level == .warning ? "exclamationmark.triangle" : "xmark.octagon")
                .font(.geist(12.5, .medium))
                .foregroundStyle(problem ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.tertiary))
                .frame(width: 16)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    // New, surging or risky: amber, the sweep's reason to look. Steady noise grey.
                    Text(pattern.headline)
                        .font(.geist(13, .medium))
                        .foregroundStyle(pattern.suspicious ? AnyShapeStyle(Ink.amber) : AnyShapeStyle(.secondary))
                        .fixedSize()
                    Text("· \(pattern.sourcesLabel)")
                        .font(Typo.rowDetail)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text("\(Format.count(pattern.recent)) in 15m")
                        .font(Typo.rowTime)
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
                            .font(.geist(11.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        if let alertId = pattern.alertId {
                            Button {
                                store.show(.alert(alertId))
                            } label: {
                                NudgeLabel(title: "Finding", symbol: "chevron.right", nudge: CGSize(width: 2, height: 0))
                            }
                            .buttonStyle(.plain)
                            .font(.geist(11.5, .medium))
                            .help("Show the finding Bridgetown raised for this pattern")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .rowHighlight()
        .onTapGesture { SystemActions.open(pattern.link) }
        .help(tooltip)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
        .accessibilityHint("Opens its lines in Grafana")
        .contextMenu { menu }
    }

    @ViewBuilder
    private var menu: some View {
        Button("Open lines in Grafana") { SystemActions.open(pattern.link) }
        if let alertId = pattern.alertId {
            Button("Show finding") { store.show(.alert(alertId)) }
        }
        Divider()
        Button("Copy example line") { copy(pattern.example) }
        Button("Copy pattern") { copy(pattern.message) }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private var tooltip: String {
        var lines = [pattern.message, "Logged by \(pattern.sources.joined(separator: ", "))"]
        if !pattern.versions.isEmpty { lines.append("Versions \(pattern.versions.joined(separator: ", "))") }
        lines.append("Click to open its lines in Grafana")
        return lines.joined(separator: "\n")
    }
}

/// A text link whose trailing glyph leans the way it goes on hover: right for into the
/// app, up and out for the browser. The text brightens with it.
struct NudgeLabel: View {
    let title: String
    let symbol: String
    let nudge: CGSize
    @ViewState private var hovering = false

    var body: some View {
        HStack(spacing: 3) {
            Text(title)
            Image(systemName: symbol)
                .font(.geist(8.5, .semibold))
                .offset(hovering ? nudge : .zero)
        }
        .foregroundStyle(hovering ? .primary : .secondary)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(Easing.quick, value: hovering)
    }
}
