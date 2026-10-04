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
                .font(.geist(10))
                .foregroundStyle(.tertiary)
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
                }
                Button(showSteady ? "Hide steady errors" : "Show \(steady.count) steady error\(steady.count == 1 ? "" : "s")") {
                    withAnimation(.snappy(duration: 0.2)) { showSteady.toggle() }
                }
                .buttonStyle(.stage(.secondary, compact: true))
                .frame(maxWidth: .infinity)
            }
            footer
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
                HStack(spacing: 3) {
                    Text("Open in Grafana")
                    Image(systemName: "arrow.up.right")
                        .font(.geist(8.5, .semibold))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Prod's error lines over the last 3 hours, in Grafana Explore")
        }
        .font(.geist(10.5).monospacedDigit())
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
}

// MARK: Row

private struct PatternRow: View {
    @Environment(Store.self) private var store
    let pattern: LogSweep.Pattern
    @ViewState private var hovering = false

    /// Jev called it a problem and the daemon raised a finding for it.
    private var problem: Bool { pattern.alertId != nil }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: pattern.level == .warning ? "exclamationmark.triangle" : "xmark.octagon")
                .font(.geist(11, .medium))
                .foregroundStyle(problem ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.tertiary))
                .frame(width: 16)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(pattern.headline)
                        .font(.geist(11.5, .medium))
                        .foregroundStyle(pattern.suspicious ? .primary : .secondary)
                        .fixedSize()
                    Text("· \(pattern.sourcesLabel)")
                        .font(.geist(11))
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
                    .font(.geistMono(10.5))
                    .foregroundStyle(pattern.suspicious ? .secondary : .tertiary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                if let verdict = pattern.verdictLine {
                    HStack(spacing: 6) {
                        Text(verdict)
                            .font(.geist(10.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        if let alertId = pattern.alertId {
                            Button {
                                store.show(.alert(alertId))
                            } label: {
                                HStack(spacing: 2) {
                                    Text("Finding")
                                    Image(systemName: "chevron.right")
                                        .font(.geist(8, .semibold))
                                }
                            }
                            .buttonStyle(.plain)
                            .font(.geist(10.5, .medium))
                            .foregroundStyle(.secondary)
                            .help("Show the finding Bridgetown raised for this pattern")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .background(hovering ? Ink.hover : .clear)
        .onHover { hovering = $0 }
        .onTapGesture { SystemActions.open(pattern.link) }
        .help(tooltip)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
        .accessibilityHint("Opens its lines in Grafana")
        .contextMenu { menu }
        .animation(.easeOut(duration: 0.12), value: hovering)
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
