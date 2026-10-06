import SwiftUI

// What the overview shows in place of its sections: nothing yet, or no daemon yet.

/// Nothing to show yet: what Bridgetown is watching, or that it's paused.
struct EmptyState: View {
    let snapshot: Snapshot

    var body: some View {
        let channelCount = snapshot.watchedChannelCount
        VStack(spacing: 6) {
            ArchShape(joint: 1.5)
                .stroke(.tertiary, style: StrokeStyle(lineWidth: 1, lineJoin: .round))
                .frame(width: 26, height: 26 / ArchMark.aspect)
                .padding(.bottom, 4)
            Text("Nothing has fired yet")
                .font(.geist(14, .semibold))
            Text(snapshot.status.paused
                ? "Paused. Alerts are still triaged, but no agent starts on its own."
                : "Watching \(channelCount) channel\(channelCount == 1 ? "" : "s"). Alerts land here as they're triaged; anything that needs you shows up on top.")
                .font(Typo.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
    }
}

/// Before the first snapshot: progress while the daemon starts, or, when it can't start
/// or connect, that nothing will show until it does. Why, and the fix, are on the problem
/// line in the prod column, said once.
struct ConnectingState: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon

    /// The wait won't end on its own.
    private var blocked: Bool {
        switch DaemonHealth(daemon: daemon, store: store) {
        case .notBundled, .portInUse, .rejected, .keepsExiting: true
        case .starting, .restarting, .disconnected, .connected: false
        }
    }

    var body: some View {
        VStack(spacing: 8) {
            if blocked {
                Image(systemName: "exclamationmark.shield")
                    .font(.geist(24, .light))
                    .foregroundStyle(.secondary)
                Text("Nothing to show until the daemon is running.")
                    .font(Typo.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView().controlSize(.small)
                Text(daemon.mode == .attach ? "Attaching to daemon on port \(daemon.endpoint.port)…" : "Starting daemon…")
                    .font(Typo.body)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
    }
}
