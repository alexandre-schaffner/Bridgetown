import SwiftUI

struct SessionDetailView: View {
    @Environment(Store.self) private var store
    let session: Session

    @ViewState private var transcript = Loadable<[TranscriptEntry]>()
    @ViewState private var message = ""
    @ViewState private var confirmingStop = false

    private var alert: AlertView? { store.snapshot?.alert(id: session.alertId) }

    /// "Codex", "CI": one column, so their values line up.
    private static let keyWidth: CGFloat = 40

    var body: some View {
        VStack(spacing: 0) {
            DetailTopBar(title: session.title)
            Hairline()
            PaneScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 10) {
                        origin
                        summary
                    }
                    GrafanaSection(alertId: session.alertId)
                    if let jev = alert?.triage.jev {
                        DetailSection(title: "Jev verdict") { JevScores(jev: jev) }
                    } else if let alert {
                        DetailSection(title: "Triage") {
                            Text(alert.triage.reason)
                                .font(.geist(12))
                                .foregroundStyle(.secondary)
                        }
                    }
                    let diagnosis = session.diagnosis.flatMap { $0.isEmpty ? nil : $0 }
                    if diagnosis != nil || session.rootCauseFound == false {
                        DetailSection(title: "Diagnosis") {
                            if session.rootCauseFound == false {
                                RootCauseNotice()
                            }
                            if let diagnosis {
                                ClampedText(markdown: diagnosis, lineLimit: 6)
                                    .id(session.id)
                            }
                        }
                    }
                    if session.prUrl != nil || session.ciRounds > 0 || session.slackThreadUrl != nil {
                        links
                    }
                    transcriptBlock
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            Hairline()
            bottomBar
        }
        .task(id: session.updatedAt) { await reloadTranscript() }
    }

    private func reloadTranscript() async {
        transcript = await transcript.reloaded { try await store.transcript(for: session) }
    }

    // MARK: Summary

    private var summary: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                StatusLine(session: session, lineLimit: session.isActive ? 1 : 3)
                // A finished session shows its outcome, not the last thing the agent was doing.
                if !session.isActive, let resolution = session.resolutionLine {
                    Text(resolution)
                        .font(.geist(11))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 12)  // align under the headline, past the dot
                }
            }
            PhaseStepper(session: session)
            VStack(alignment: .leading, spacing: 3) {
                if session.isActive && !session.activity.isEmpty {
                    Text(Markdown.line(session.activity, size: 11))
                        .font(.geist(11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(session.meta(now: .now))
                    .font(.geist(11))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    /// "From #alert-releases · View alert": the way back to what started it.
    private var origin: some View {
        HStack(spacing: 4) {
            Text("From \(Format.channel(session.channelName))")
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text("·").foregroundStyle(.tertiary)
            Button("View alert") { store.show(.alert(session.alertId)) }
                .buttonStyle(.link)
                .foregroundStyle(Ink.blue)
                .help("How Jev triaged it, the original message and its history")
            Spacer(minLength: 0)
        }
        .font(.geist(11))
    }

    // MARK: PR / CI / Slack

    private var links: some View {
        DetailSection(title: "Pull request") {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    if let pr = session.prUrl {
                        LinkButton(title: "PR \(Format.prLabel(pr))", systemImage: "arrow.triangle.pull", url: pr, help: "Open pull request \(pr)")
                    } else {
                        Text(session.isActive ? "Not opened yet" : "No PR opened").foregroundStyle(.secondary)
                    }
                    if let revv = session.revvUrl {
                        LinkButton(title: "Open in Revv", systemImage: "text.magnifyingglass", url: revv, help: "Open the PR walkthrough in Revv")
                    }
                    if let thread = session.slackThreadUrl {
                        LinkButton(title: "Slack thread", systemImage: "bubble.left", url: thread, help: "Open Slack thread")
                    }
                    Spacer(minLength: 0)
                }
                .font(.geist(12))
                .labelStyle(.titleAndIcon)
                .imageScale(.small)
                .lineLimit(1)
                .fixedSize(horizontal: false, vertical: true)

                if let channel = session.reviewChannel {
                    HStack(spacing: 4) {
                        Text("Review requested in #\(channel)")
                            .foregroundStyle(.secondary)
                        if let url = session.reviewUrl {
                            LinkButton(title: "View", url: url, help: "Open the review request in Slack")
                        }
                    }
                    .font(.geist(11))
                }

                if let reviewer = session.reviewerName, let line = session.critiqueLine {
                    HStack(spacing: 6) {
                        Text(reviewer)
                            .foregroundStyle(.tertiary)
                            .frame(width: Self.keyWidth, alignment: .leading)
                        Text(line)
                            .foregroundStyle(.secondary)
                    }
                    .font(.geist(11))
                    .monospacedDigit()
                    .help("Another vendor's model reviews each fix the agent pushes; Jev drops the nitpicks. The PR leaves draft once it passes.")
                }

                HStack(spacing: 6) {
                    Text("CI")
                        .foregroundStyle(.tertiary)
                        .frame(width: Self.keyWidth, alignment: .leading)
                    Text(session.ciText)
                        .foregroundStyle(.secondary)
                }
                .font(.geist(11))
                .monospacedDigit()
                if let branch = session.branch {
                    Text(branch)
                        .font(.geistMono(11))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
        }
    }

    // MARK: Transcript

    private var transcriptBlock: some View {
        DetailSection(title: "Transcript") {
            VStack(alignment: .leading, spacing: 8) {
                TranscriptView(entries: transcript.value ?? [], error: transcript.error)
                // The daemon decides: live, or finished and handed back with its worktree
                // intact ("Reply to agent" on a review card lands here).
                if session.acceptsMessages {
                    messageField
                }
            }
        }
    }

    private var messageField: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Message the agent", text: $message, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.geist(12))
                .lineLimit(1...4)
                .onSubmit(send)
                .inputField()
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.geist(20))
                    .symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? Ink.text : Color.secondary)
            .disabled(!canSend)
            .help("Send to the agent")
        }
    }

    private var canSend: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.isBusy(Store.messageKey(session))
    }

    /// The text stays in the field until the daemon has taken it, so a failed send
    /// loses nothing. Anything typed meanwhile is kept too. The transcript reloads at
    /// once so the message shows up even if the session itself didn't change.
    private func send() {
        guard canSend else { return }
        let sent = message
        store.message(session, text: sent) {
            if message == sent { message = "" }
            Task { await reloadTranscript() }
        }
    }

    // MARK: Bottom bar

    private var bottomBar: some View {
        HStack(spacing: 8) {
            Button {
                if let err = SystemActions.takeOver(session) { store.show(err) }
            } label: {
                Label("Take over in Terminal", systemImage: "terminal")
            }
            .buttonStyle(.stage(.secondary, compact: true))
            .disabled(session.claudeSessionId == nil)
            .help(session.claudeSessionId == nil ? "No Claude session yet" : "claude --resume in the worktree")

            Spacer(minLength: 0)

            if session.isActive {
                if confirmingStop {
                    ConfirmButtons(confirmLabel: "Stop session") {
                        confirmingStop = false
                        store.stop(session)
                    } onCancel: {
                        confirmingStop = false
                    }
                } else {
                    Button(role: .destructive) {
                        confirmingStop = true
                    } label: {
                        Text("Stop").foregroundStyle(Ink.red)
                    }
                    .buttonStyle(.stage(.secondary, compact: true))
                    .disabled(store.isBusy(session.id))
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .animation(.snappy(duration: 0.18), value: confirmingStop)
    }
}

/// Neutral, not alarming: the agent finished without a confirmed cause.
private struct RootCauseNotice: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "questionmark.circle")
                .font(.geist(11, .medium))
            VStack(alignment: .leading, spacing: 1) {
                Text("Root cause not found")
                    .font(.geist(11, .semibold))
                    .foregroundStyle(.primary)
                Text("What follows are the agent's leads, not a confirmed cause.")
                    .font(.geist(11))
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .outlined()
        .accessibilityElement(children: .combine)
    }
}

private struct TranscriptView: View {
    let entries: [TranscriptEntry]
    let error: String?

    var body: some View {
        Group {
            if entries.isEmpty {
                Text(error.map { "Couldn't load transcript · \($0)" } ?? "No transcript yet")
                    .font(.geist(11))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 60)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                                row(entry).id(index)
                            }
                        }
                        .padding(8)
                    }
                    .frame(height: 168)
                    .onAppear { proxy.scrollTo(entries.count - 1, anchor: .bottom) }
                    .onChange(of: entries.count) { _, n in proxy.scrollTo(n - 1, anchor: .bottom) }
                }
            }
        }
        .outlined()
    }

    private func row(_ e: TranscriptEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(e.at, format: Format.clock)
                .foregroundStyle(.tertiary)
                .help(e.at.formatted(date: .abbreviated, time: .standard))
            Text(e.kind == .text ? Markdown.lines(e.text, size: 10.5, mono: true) : AttributedString(e.kind.prefix + e.text))
                .foregroundStyle(e.kind.style)
                .lineLimit(e.kind.lineLimit)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.geistMono(10.5))
        .lineSpacing(2)
        .textSelection(.enabled)
    }
}
