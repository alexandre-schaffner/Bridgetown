import SwiftUI

/// A newer Bridgetown, at the top of the prod column: which one, its notes, and the button
/// that installs it and relaunches. Then how the install is going, or why it failed. Nothing
/// while this one is the newest, except right after you asked.
struct UpdateNotice: View {
    @Environment(Updater.self) private var updater

    var body: some View {
        let state = updater.state
        if state != .idle {
            HStack(alignment: .center, spacing: 10) {
                mark(state)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(state))
                        .font(Typo.strong)
                        .foregroundStyle(.primary)
                    if let detail = detail(state) {
                        Text(detail)
                            .font(Typo.small)
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(2)
                .monospacedDigit()
                Spacer(minLength: 0)
                controls(state)
            }
            .padding(.horizontal, Metrics.inset)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("update.notice")
        }
    }

    @ViewBuilder
    private func mark(_ state: Updater.State) -> some View {
        switch state {
        case .checking, .downloading, .installing:
            ProgressView().controlSize(.mini).frame(width: 14)
        case .upToDate:
            symbol("checkmark.circle.fill", Ink.green)
        case .available:
            symbol("arrow.down.circle.fill", Ink.blue)
        case .failed:
            symbol("exclamationmark.triangle.fill", Ink.amber)
        case .idle:
            EmptyView()
        }
    }

    private func symbol(_ name: String, _ color: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: 13))
            .foregroundStyle(color)
            .frame(width: 14)
    }

    private func title(_ state: Updater.State) -> String {
        switch state {
        case .idle, .checking: "Checking for updates…"
        case .upToDate: "Bridgetown \(updater.current.map { "\($0) " } ?? "")is up to date"
        case let .available(r): "Bridgetown \(r.version) is available"
        case let .downloading(r, progress): "Downloading \(r.version) · \(Int(progress * 100))%"
        case let .installing(r): "Installing \(r.version)…"
        case .failed(_, .some): "Couldn't update Bridgetown"
        case .failed(_, nil): "Couldn't check for updates"
        }
    }

    private func detail(_ state: Updater.State) -> String? {
        switch state {
        case .available where !updater.canInstall:
            "Move Bridgetown to Applications to update it from here."
        case .available:
            updater.current.map { "You have \($0). Bridgetown quits, and opens again on the new version." }
        case .installing:
            "Bridgetown opens again in a moment."
        case let .failed(message, _):
            message
        case .idle, .checking, .upToDate, .downloading:
            nil
        }
    }

    @ViewBuilder
    private func controls(_ state: Updater.State) -> some View {
        switch state {
        case let .available(r):
            HStack(spacing: 10) {
                TextLink("What's new", opening: r.page.absoluteString)
                if updater.canInstall {
                    Button("Install") { updater.install() }
                        .buttonStyle(.stage(.secondary))
                        .help("Download Bridgetown \(r.version.description), replace this app with it, and open it again")
                        .accessibilityIdentifier("update.install")
                } else {
                    Button("Download") { SystemActions.open(r.dmg.absoluteString) }
                        .buttonStyle(.stage(.secondary))
                }
            }
            .fixedSize()
        case let .failed(_, r):
            Button("Retry") {
                if r != nil { updater.install() } else { Task { await updater.check(manual: true) } }
            }
            .buttonStyle(.stage(.secondary))
            .fixedSize()
        case .idle, .checking, .upToDate, .downloading, .installing:
            EmptyView()
        }
    }
}
