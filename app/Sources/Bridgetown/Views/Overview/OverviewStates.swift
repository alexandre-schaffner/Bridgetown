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
                .font(.geist(11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
    }
}

/// Before the first snapshot: progress while the daemon starts, or why it can't.
struct ConnectingState: View {
    @Environment(Store.self) private var store
    @Environment(DaemonProcess.self) private var daemon

    /// A reason the wait won't end on its own. The header carries the details and the fix.
    private var blocker: String? {
        if daemon.state == .missing { return "The daemon isn't bundled with this build." }
        if daemon.state == .portInUse { return "The daemon couldn't start: port \(daemon.endpoint.port) is in use." }
        if store.connection == .rejected { return "The daemon on port \(daemon.endpoint.port) won't accept this app." }
        return nil
    }

    var body: some View {
        VStack(spacing: 8) {
            if let blocker {
                Image(systemName: "exclamationmark.shield")
                    .font(.geist(24, .light))
                    .foregroundStyle(.secondary)
                Text(blocker)
                    .font(.geist(12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView().controlSize(.small)
                Text(daemon.mode == .attach ? "Attaching to daemon on port \(daemon.endpoint.port)…" : "Starting daemon…")
                    .font(.geist(12))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
    }
}
