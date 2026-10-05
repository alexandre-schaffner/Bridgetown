import SwiftUI

struct ActionCard: View {
    @Environment(Store.self) private var store
    let action: Action
    /// Collapsed, the card is one row: title, one line of detail and the primary button
    /// when it needs no input. Expanding shows everything. Detail panes always expand.
    var expanded = true
    /// Tapping the row; nil where the card can't collapse.
    var onToggle: (() -> Void)?
    /// For the row's age.
    var now: Date = AppClock.now
    /// The row's place in the list's selection, in the overview.
    var pick: RowPick?
    @ViewState private var hovering = false
    @ViewState private var reply = ""
    /// Editable copy of a `reply` action's draft.
    @ViewState private var draft: String
    @ViewState private var confirmingClose = false
    @FocusState private var replyFocused: Bool

    init(action: Action, expanded: Bool = true, now: Date = AppClock.now, pick: RowPick? = nil, onToggle: (() -> Void)? = nil) {
        self.action = action
        self.expanded = expanded
        self.now = now
        self.pick = pick
        self.onToggle = onToggle
        _draft = ViewState(initialValue: action.detail)
    }

    /// An agent's question with quick replies: answered from the row itself, one click,
    /// as nothing needs typing.
    private var answersInline: Bool { action.kind == .answer && !action.options.isEmpty && !action.inFlight }

    /// For `reply` the detail is the draft itself, edited below rather than shown as text.
    private var showsDetail: Bool { !action.detail.isEmpty && action.kind != .reply }

    /// The ✕ says what it does: dismissing some cards records the session as closed.
    private var dismissLabel: String { action.dismissCloses ? "Close session" : "Dismiss" }

    var body: some View {
        Group {
            if expanded || confirmingClose { full } else { compact }
        }
        .disabled(store.isBusy(action.id))
        .opacity(store.isBusy(action.id) && !action.inFlight ? 0.6 : 1)
        .animation(Easing.quick, value: store.isBusy(action.id))
        .animation(.snappy(duration: 0.18), value: confirmingClose)
        .onChange(of: action.detail) { old, new in
            if draft == old { draft = new }  // the agent revised its draft; keep user edits
        }
        .contextMenu {
            if !action.inFlight, action.isOneClick {
                Button(action.primaryLabel) { store.resolve(action) }
                Divider()
            }
            if let session = action.sessionId {
                Button("Show session") { store.show(.session(session)) }
            }
            if !action.inFlight {
                Button(action.dismissCloses ? "Close session…" : "Dismiss", action: requestDismiss)
            }
            if let pick {
                Divider()
                Button(pick.selected ? "Deselect" : "Select", action: pick.toggle)
            }
        }
    }

    private var icon: some View {
        Image(systemName: action.kind.symbol)
            .font(.system(size: 12, weight: .regular))
            .foregroundStyle(iconTint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
            .frame(width: 16)
    }

    /// Green when a verified fix is ready to ship, amber for a new incident, red when an
    /// agent failed; questions and replies stay neutral.
    private var iconTint: Color? {
        switch action.kind {
        case .merge, .release: Ink.green
        case .investigate, .grafana: Ink.amber
        case .rerun: Ink.red
        case .review:
            action.sessionId.flatMap { store.snapshot?.session(id: $0)?.tone } == .failure ? Ink.red : nil
        default: nil
        }
    }

    /// A failed agent is marked on its row; the group's header carries every other meaning.
    private var failed: Bool { iconTint == Ink.red }

    /// One row: the title and its age over the detail, each up to two lines. The group's header names
    /// the verb, so the button waits for the pointer; it slides in over the row's end
    /// rather than taking width from every title.
    private var compact: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            SelectMark(pick: pick, hovering: hovering) {
                if failed {
                    Image(systemName: Tone.failure.stopSymbol)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Ink.red)
                        .accessibilityLabel("Failed")
                }
            }
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(action.title)
                        .font(Typo.rowTitle)
                        .tracking(Typo.rowTitleTracking)
                        .lineSpacing(Typo.rowLineSpacing)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if action.inFlight {
                        ProgressView().controlSize(.mini)
                            .help(action.kind.progressLabel)
                    } else {
                        Text(Format.relative(action.createdAt, now: now))
                            .font(Typo.rowTime)
                            .foregroundStyle(.tertiary)
                    }
                }
                if !action.detail.isEmpty {
                    Text(Markdown.line(action.detail, size: 12))
                        .font(Typo.rowDetail)
                        .lineSpacing(Typo.rowLineSpacing)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if answersInline {
                    OptionChips(options: action.options) { store.resolve(action, response: $0) }
                        .padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 16)
        .background(pick?.selected == true ? Ink.picked : hovering ? Ink.hover : .clear)
        .overlay(alignment: .trailing) {
            if hovering && !action.inFlight && !answersInline && pick?.picking != true {
                hoverButton
                    .transition(.opacity.combined(with: .offset(x: 6)))
            }
        }
        .animation(Easing.quick, value: hovering)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture {
            if pick?.click() == true { return }
            onToggle?()
        }
        .help(action.detail.isEmpty ? action.title : "\(action.title)\n\(Markdown.plain(action.detail))")
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("needsYou.row.\(action.id)")
        .accessibilityAddTraits(pick?.selected == true ? .isSelected : [])
        .accessibilityAction(named: "Expand") { onToggle?() }
        .accessibilityAction(named: Text(action.primaryLabel)) {
            if action.isOneClick { store.resolve(action) } else { onToggle?() }
        }
        // The selection mark shows only under the pointer; this picks the row without one,
        // in the lists that pick.
        .accessibilityActions {
            if let pick { Button(pick.selected ? "Deselect" : "Select", action: pick.toggle) }
        }
    }

    /// The row's button on hover, over an opaque end of the row that fades in from the
    /// left, so it reads as laid on top of the text rather than squeezing it.
    private var hoverButton: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [Ink.hoverSolid.opacity(0), Ink.hoverSolid], startPoint: .leading, endPoint: .trailing)
                .frame(width: 28)
            Group {
                if action.isOneClick {
                    Button(action.primaryLabel) { store.resolve(action) }
                        .buttonStyle(.stage(.secondary, compact: true))
                } else {
                    // Needs input: the button opens the card where it's typed or chosen.
                    Button(action.kind == .reply ? "Review reply" : "Answer") { onToggle?() }
                        .buttonStyle(.stage(.secondary, compact: true))
                }
            }
            .lineLimit(1)
            .fixedSize()
            .padding(.leading, 2)
            .padding(.trailing, Metrics.inset)
            .frame(maxHeight: .infinity)
            .background(Ink.hoverSolid)
        }
    }

    private var full: some View {
        HStack(alignment: .top, spacing: 10) {
            icon
                .padding(.top, -2)

            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title)
                        .font(.geist(13, .semibold))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if showsDetail {
                        ClampedText(markdown: action.detail, lineLimit: 3, size: 11, lineSpacing: 1)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.trailing, 16)  // clear the dismiss button
                .contentShape(Rectangle())
                .onTapGesture { onToggle?() }
                if confirmingClose {
                    closeConfirmation
                } else if action.inFlight {
                    progress
                } else {
                    controls
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background {
            // In the overview the open card is a row of the table; elsewhere it stands alone.
            if onToggle == nil {
                Color.clear.outlined()
            } else {
                Color.white.opacity(0.03)
            }
        }
        .overlay(alignment: .topTrailing) {
            if !action.inFlight {
                IconButton(systemName: "xmark", help: dismissLabel, size: 9, weight: .semibold, action: requestDismiss)
                    .accessibilityIdentifier("action.dismiss.\(action.id)")
                    .padding(6)
            }
        }
    }

    private func requestDismiss() {
        if action.dismissCloses {
            confirmingClose = true
        } else {
            store.dismiss(action)
        }
    }

    /// Closing is not fixing: say so before it's recorded.
    private var closeConfirmation: some View {
        HStack(spacing: 8) {
            Text("Close without a fix?")
                .font(.geist(11))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            ConfirmButtons(confirmLabel: "Close session") {
                confirmingClose = false
                store.dismiss(action)
            } onCancel: {
                confirmingClose = false
            }
        }
    }

    /// The daemon is resolving it (merging, tagging…). No button to press twice.
    private var progress: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(action.kind.progressLabel)
                .font(.geist(11))
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var controls: some View {
        if action.kind == .reply {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Reply", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.geist(12))
                    .lineLimit(2...8)
                    .inputField()
                HStack(spacing: 8) {
                    Button(action.primaryLabel) { store.resolve(action, response: draft) }
                        .buttonStyle(.stage(.primary, compact: true))
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if draft != action.detail {
                        Button("Revert") { draft = action.detail }
                            .buttonStyle(.plain)
                            .font(.geist(11))
                            .foregroundStyle(.secondary)
                    }
                    if store.isBusy(action.id) { ProgressView().controlSize(.mini) }
                }
            }
        } else if action.kind == .answer && action.options.isEmpty {
            HStack(spacing: 6) {
                TextField("Reply to the agent", text: $reply)
                    .textFieldStyle(.plain)
                    .font(.geist(12))
                    .inputField()
                    .focused($replyFocused)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.geist(10, .bold))
                }
                .buttonStyle(.stage(.primary, compact: true))
                .disabled(reply.trimmingCharacters(in: .whitespaces).isEmpty)
                .help(action.primaryLabel)
            }
        } else if action.kind == .answer {
            OptionChips(options: action.options) { store.resolve(action, response: $0) }
        } else {
            HStack(spacing: 10) {
                Button(action.primaryLabel) { store.resolve(action) }
                    .buttonStyle(.stage(.primary, compact: true))
                // review: the agent ended without a fix. Talking to it is the alternative
                // to Retry / Close session, so it opens the session's message field,
                // offered only when the daemon will take a message.
                if action.kind == .review, let session = action.sessionId,
                   store.snapshot?.session(id: session)?.acceptsMessages == true {
                    Button("Reply to agent") { store.show(.session(session)) }
                        .buttonStyle(.plain)
                        .font(.geist(11))
                        .foregroundStyle(.secondary)
                        .help("Open the session to message the agent")
                }
                if store.isBusy(action.id) {
                    ProgressView().controlSize(.mini)
                }
            }
        }
    }

    /// The answer stays in the field until the daemon has taken it.
    private func send() {
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let typed = reply
        store.resolve(action, response: text) {
            if reply == typed { reply = "" }
        }
    }
}

/// Quick replies for `answer` actions. Wraps onto multiple lines.
private struct OptionChips: View {
    let options: [String]
    let choose: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                if index == 0 {
                    Button(option) { choose(option) }
                        .buttonStyle(.stage(.primary, compact: true))
                } else {
                    Button(option) { choose(option) }
                        .buttonStyle(.stage(.secondary, compact: true))
                }
            }
        }
    }
}
