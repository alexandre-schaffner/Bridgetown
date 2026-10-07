import SwiftUI

struct SessionDetailView: View {
    @Environment(Store.self) private var store
    let session: Session

    @ViewState private var transcript = Loadable<[TranscriptEntry]>()
    @ViewState private var message = ""
    @ViewState private var confirmingStop = false
    @ViewState private var closingCard = false
    @Environment(\.now) private var now

    /// The card this session has in "Needs you": its next step, offered here too.
    private var action: Action? { store.snapshot?.actions.first { $0.sessionId == session.id } }

    /// "Codex", "CI", "Branch": one column, so their values line up.
    private static let keyWidth: CGFloat = 64

    var body: some View {
        // The transcript and the message field end the pane: scrolled down to them, a new
        // entry or a longer message keeps the field in view.
        DetailScaffold(title: session.title, followsEnd: true) {
            VStack(alignment: .leading, spacing: 14) {
                origin
                summary
            }
            .padding(.horizontal, Metrics.inset)
            if let action {
                ActionCard(action: action, confirmingClose: $closingCard)
                    .tableFrame()
            }
            GrafanaSection(alertId: session.alertId)
            let diagnosis = session.diagnosis.flatMap { $0.isEmpty ? nil : $0 }
            if diagnosis != nil || session.rootCauseFound == false {
                DetailSection(title: "Diagnosis") {
                    if session.rootCauseFound == false {
                        RootCauseNotice()
                    }
                    if let diagnosis {
                        ClampedText(markdown: diagnosis, lineLimit: 6, size: 13.5, lineSpacing: 4)
                            .id(session.id)
                            .padding(.horizontal, Metrics.inset)
                    }
                }
            }
            if session.prUrl != nil || session.ciRounds > 0 {
                links
            }
            transcriptBlock
        } bar: {
            bottomBar
        }
        .task(id: session.updatedAt) { await reloadTranscript() }
    }

    private func reloadTranscript() async {
        transcript = await transcript.reloaded { try await store.fetch { [id = session.id] in try await $0.transcript(sessionId: id) } }
    }

    // MARK: Summary

    private var summary: some View {
        VStack(alignment: .leading, spacing: 14) {
            StatusLine(session: session, size: 15, lineLimit: session.isActive ? 2 : 3)
            PhaseStepper(session: session)
                .padding(.vertical, 4)
            VStack(alignment: .leading, spacing: 5) {
                if let activity = session.activityLine(besideCard: action != nil) {
                    Text(Markdown.line(activity, size: 13))
                        .font(Typo.lead)
                        .lineSpacing(Typo.rowLineSpacing)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(session.meta(now: now))
                    .font(Typo.body)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    /// "From #alert-releases · View alert · Slack thread": the way back to what started it.
    private var origin: some View {
        HStack(spacing: 4) {
            // Short of room, the channel's name gives way, in its middle: never "From" or a link.
            Text("From").foregroundStyle(.tertiary)
            Text(session.channelLabel)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text("·").foregroundStyle(.tertiary)
            TextLink("View alert", direction: .inward) { store.show(.alert(session.alertId)) }
                .help("How Jev triaged it, the original message and its history")
            if let thread = session.slackThreadUrl {
                Text("·").foregroundStyle(.tertiary)
                TextLink("Slack thread", opening: thread)
                    .help("Open the session's Slack thread")
            }
            Spacer(minLength: 0)
        }
        .font(Typo.body)
    }

    // MARK: PR / CI / Slack

    private var links: some View {
        DetailSection(title: "Pull request") {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 14) {
                    if let pr = session.prUrl {
                        TextLink("PR \(Format.prLabel(pr))", opening: pr)
                            .help("Open pull request \(pr)")
                    } else {
                        Text(session.isActive ? "Not opened yet" : "No PR opened").foregroundStyle(.secondary)
                    }
                    if let revv = session.revvUrl {
                        TextLink("Open in Revv", opening: revv)
                            .help("Open the PR walkthrough in Revv")
                    }
                    Spacer(minLength: 0)
                }
                .font(.geist(13, .medium))

                if let channel = session.reviewChannel {
                    keyValue("Review") {
                        HStack(spacing: 6) {
                            Text("Requested in #\(channel)")
                                .foregroundStyle(.secondary)
                            if let url = session.reviewUrl {
                                TextLink("View", opening: url)
                                    .help("Open the review request in Slack")
                            }
                        }
                    }
                }

                keyValue(session.reviewerName) {
                    Text(session.critiqueLine)
                        .foregroundStyle(.secondary)
                }
                .help("Another vendor's model reviews each fix the agent pushes; Jev drops the nitpicks. The PR leaves draft once it passes.")

                keyValue("CI") {
                    Text(session.ciLine)
                        .foregroundStyle(session.step(.ci)?.lineColor.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                }
                if let branch = session.branch {
                    keyValue("Branch") {
                        Text(branch)
                            .font(.geistMono(12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(.horizontal, Metrics.inset)
        }
    }

    /// A key in the first column, its value beside it: the PR section's facts line up, each
    /// as tall as a link, so a row with one is spaced like the rest.
    private func keyValue<Value: View>(_ key: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .frame(width: Self.keyWidth, alignment: .leading)
            value()
            Spacer(minLength: 0)
        }
        .frame(minHeight: 20)
        .font(Typo.fact)
        .monospacedDigit()
        .accessibilityElement(children: .combine)
    }

    // MARK: Transcript

    private var transcriptBlock: some View {
        DetailSection(title: "Transcript") {
            VStack(alignment: .leading, spacing: 10) {
                TranscriptView(entries: transcript.value ?? [], error: transcript.error)
                // The daemon decides: live, or finished and handed back with its worktree
                // intact ("Reply to agent" on a review card lands here).
                if session.acceptsMessages {
                    messageField
                        .padding(.horizontal, Metrics.inset)
                }
            }
        }
    }

    private var messageField: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Message the agent", text: $message, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Typo.lead)
                .lineLimit(1...4)
                .onSubmit(send)
                .inputField()
                .accessibilityIdentifier("session.message")
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.geist(20))
                    .symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? Ink.text : Color.secondary)
            .disabled(!canSend)
            .help("Send to the agent")
            .accessibilityIdentifier("session.send")
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

    @ViewBuilder
    private var bottomBar: some View {
        Button {
            Task { if let err = await SystemActions.takeOver(session) { store.report(err) } }
        } label: {
            Label("Take over in Terminal", systemImage: "terminal")
        }
        .buttonStyle(.stage(.secondary))
        .disabled(session.claudeSessionId == nil)
        .help(session.claudeSessionId == nil ? "No Claude session yet" : "claude --resume in the worktree")

        Spacer(minLength: 0)

        if session.isActive {
            Group {
                if confirmingStop {
                    ConfirmPrompt(question: "Stop this session?", label: "Stop session", isPresented: $confirmingStop) {
                        store.stop(session)
                    }
                    .fixedSize()
                } else {
                    Button("Stop…") { confirmingStop = true }
                        .buttonStyle(.stage(.secondary))
                        .disabled(store.isBusy(session.id))
                        .accessibilityIdentifier("session.stop")
                }
            }
            .animation(Easing.quick, value: confirmingStop)
        }
    }
}

/// Neutral, not alarming: the agent finished without a confirmed cause.
private struct RootCauseNotice: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "questionmark.circle")
                .font(.geist(13, .medium))
            VStack(alignment: .leading, spacing: 3) {
                Text("Root cause not found")
                    .font(Typo.title)
                    .foregroundStyle(.primary)
                Text("What follows are the agent's leads, not a confirmed cause.")
                    .font(Typo.fact)
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Ink.band)
        .tableFrame()
        .accessibilityElement(children: .combine)
    }
}

/// What the agent did, oldest first, in the pane itself rather than a scroller of its
/// own: the latest entries, with the earlier ones a click away. A new entry lands at the
/// end without moving what you are reading.
private struct TranscriptView: View {
    let entries: [TranscriptEntry]
    let error: String?
    @ViewState private var showAll = false

    /// Entries shown before "Show earlier".
    static let recent = 12

    /// How many entries fold away: those before the latest `recent`, unless they are so few
    /// the link would take as much room as they do.
    private var hidden: Int {
        let earlier = entries.count - Self.recent
        return showAll || earlier < 3 ? 0 : earlier
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if entries.isEmpty {
                Text(error.map { "Couldn't load transcript · \($0)" } ?? "No transcript yet")
                    .font(Typo.body)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 48)
            } else {
                let hidden = hidden
                if hidden > 0 {
                    TextLink("Show \(hidden) earlier entries") { showAll = true }
                        .font(Typo.label)
                }
                // Not lazy: a lazy stack guesses the height of rows it hasn't drawn, so the
                // pane's end (the message field) moves once they are, after it was scrolled to.
                ForEach(entries.indices.dropFirst(hidden), id: \.self) { index in
                    row(entries[index])
                }
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Ink.band)
        .tableFrame()
    }

    private func row(_ e: TranscriptEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(e.at, format: Format.clock)
                .foregroundStyle(.tertiary)
                .help(e.at.formatted(date: .abbreviated, time: .standard))
            Text(e.kind == .text ? Markdown.lines(e.text, size: 12, mono: true).underliningLinks() : AttributedString(e.kind.prefix + e.text))
                .foregroundStyle(e.kind.style)
                .lineLimit(e.kind.lineLimit)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(e.kind.lineLimit == 1 ? e.text : "")
        }
        .font(.geistMono(12))
        .lineSpacing(3)
        .textSelection(.enabled)
    }
}
