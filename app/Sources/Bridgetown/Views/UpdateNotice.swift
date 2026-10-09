import SwiftUI

/// A newer Bridgetown, at the top of the prod column: which one, its notes, and the button
/// that installs it and relaunches. Then how the install is going, or why it failed. Nothing
/// while this one is the newest, except right after you asked.
struct UpdateNotice: View {
    @Environment(Updater.self) private var updater

    var body: some View {
        let state = updater.state
        if let title = title(state) {
            HStack(alignment: .center, spacing: 10) {
                mark(state)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
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
        case .upToDate, .installed:
            symbol("checkmark.circle.fill", Ink.green)
        case .available:
            symbol("arrow.down.circle.fill", Ink.blue)
        case .checkFailed, .installFailed:
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

    /// Nil while there is nothing to say.
    private func title(_ state: Updater.State) -> String? {
        switch state {
        case .idle: nil
        case .checking: "Checking for updates…"
        case .upToDate: "Bridgetown \(updater.current.map { "\($0) " } ?? "")is up to date"
        case let .available(r): "Bridgetown \(r.version) is available"
        case let .downloading(r, percent): "Downloading \(r.version) · \(percent)%"
        case let .installing(r): "Installing \(r.version)…"
        case let .installed(r): "Bridgetown \(r.version) is installed"
        case .installFailed: "Couldn't update Bridgetown"
        case .checkFailed: "Couldn't check for updates"
        }
    }

    private func detail(_ state: Updater.State) -> String? {
        switch state {
        case .available:
            if case let .failure(obstacle) = updater.installer { obstacle.message }
            else { updater.current.map { "You have \($0). Installing relaunches the app." } }
        case .installing:
            "Bridgetown opens again in a moment."
        case .installed:
            "Quit Bridgetown and open it again to finish."
        case let .checkFailed(message), let .installFailed(_, message):
            message
        case .idle, .checking, .upToDate, .downloading:
            nil
        }
    }

    @ViewBuilder
    private func controls(_ state: Updater.State) -> some View {
        // Up to date, checking again is the menu's.
        if let action = updater.action, state != .upToDate {
            HStack(spacing: 10) {
                if case let .available(r) = state {
                    TextLink("What's new", opening: r.page.absoluteString)
                }
                Button(label(action, state)) { updater.perform(action) }
                    .buttonStyle(.stage(.secondary))
                    .help(action.title)
                    .accessibilityIdentifier("update.action")
            }
            .fixedSize()
        }
    }

    private func label(_ action: Updater.Action, _ state: Updater.State) -> String {
        switch (action, state) {
        case (_, .checkFailed), (_, .installFailed): "Retry"
        case (.check, _): "Check"
        case (.install, _): "Install"
        case (.download, _): "Download"
        case (.quit, _): "Quit"
        }
    }
}
