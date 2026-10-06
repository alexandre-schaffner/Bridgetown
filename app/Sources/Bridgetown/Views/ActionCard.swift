import SwiftUI

/// A card in Needs you, as a row of its table: the title and its age over the detail,
/// each up to two lines. The group's header names the verb, so the row's button waits for
/// the pointer, sliding in over the row's end rather than taking width from every title.
/// An agent's question with quick replies is answered from the row itself. Opened, the
/// row is the whole card (`ActionCard`).
struct ActionRow: View {
    @Environment(Store.self) private var store
    let action: Action
    let expanded: Bool
    let pick: RowPick
    let toggle: () -> Void
    @ViewState private var confirmingClose = false
    @Environment(\.now) private var now

    /// An agent's question with quick replies: answered from the row itself, one click,
    /// as nothing needs typing.
    private var answersInline: Bool { action.kind == .answer && !action.options.isEmpty && !action.inFlight }

    var body: some View {
        Group {
            if expanded || confirmingClose {
                ActionCard(action: action, pick: pick, confirmingClose: $confirmingClose, collapse: toggle)
            } else {
                row
            }
        }
        .busy(store.isBusy(action.id), dims: !action.inFlight)
    }

    private var row: some View {
        TableRow(pick: pick, open: toggle) { hovering in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                SelectMark(pick: pick, hovering: hovering) {
                    if action.failed(in: store.snapshot) {
                        Image(systemName: Tone.failure.stopSymbol)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Ink.red)
                            .accessibilityLabel("Failed")
                    }
                }
                .centeredOnRowTitle()

                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(action.title).rowTitle()
                        Spacer(minLength: 4)
                        if action.inFlight {
                            // Said by the row's value: as an element of its own, a spinner
                            // would make the whole row read as one.
                            ProgressView().controlSize(.mini)
                                .help(action.kind.progressLabel)
                                .accessibilityHidden(true)
                        } else {
                            Text(Format.relative(action.createdAt, now: now))
                                .font(Typo.time)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    if !action.detail.isEmpty {
                        Text(Markdown.line(action.detail, size: 12)).rowDetail()
                    }
                    if answersInline {
                        OptionChips(options: action.options) { store.resolve(action, response: $0) }
                            .padding(.top, 6)
                    }
                }
            }
            .padding(.horizontal, Metrics.inset)
            .padding(.vertical, 16)
        } overlay: { hovering in
            if hovering && !action.inFlight && !answersInline && !pick.picking {
                hoverButton
                    .transition(.opacity)
            }
        } menu: {
            ActionMenu(action: action, requestDismiss: requestDismiss)
        }
        .help(action.detail.isEmpty ? action.title : "\(action.title)\n\(Markdown.plain(action.detail))")
        .accessibilityIdentifier("needsYou.row.\(action.id)")
        .accessibilityValue(action.inFlight ? action.kind.progressLabel : "")
        .accessibilityAction(named: "Expand", toggle)
        .accessibilityAction(named: Text(action.primaryLabel)) {
            if action.isOneClick { store.resolve(action) } else { toggle() }
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
                } else {
                    // Needs input: the button opens the card where it's typed or chosen.
                    Button(action.kind == .reply ? "Review reply" : "Answer", action: toggle)
                }
            }
            .buttonStyle(.stage(.secondary))
            .fixedSize()
            .padding(.leading, 2)
            .padding(.trailing, Metrics.inset)
            .frame(maxHeight: .infinity)
            .background(Ink.hoverSolid)
        }
    }

    private func requestDismiss() {
        if action.dismissCloses { confirmingClose = true } else { store.dismiss(action) }
    }
}

/// A card opened in full: in Needs you, in place of its row, and in the session's detail
/// under the session it is about. Its title and detail sit where the row's did, so opening
/// a row doesn't move what you were reading; the title is whole, where the row cut it.
struct ActionCard: View {
    @Environment(Store.self) private var store
    let action: Action
    /// Its place in the list's selection, in Needs you.
    var pick: RowPick?
    @Binding var confirmingClose: Bool
    /// Folds the card back into its row; nil where it stands alone.
    var collapse: (() -> Void)?
    @ViewState private var reply = ""
    /// Editable copy of a `reply` action's draft.
    @ViewState private var draft: String

    init(action: Action, pick: RowPick? = nil, confirmingClose: Binding<Bool>, collapse: (() -> Void)? = nil) {
        self.action = action
        self.pick = pick
        _confirmingClose = confirmingClose
        self.collapse = collapse
        _draft = ViewState(initialValue: action.detail)
    }

    /// For `reply` the detail is the draft itself, edited below rather than shown as text.
    private var showsDetail: Bool { !action.detail.isEmpty && action.kind != .reply }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: action.failed(in: store.snapshot) ? Tone.failure.stopSymbol : action.kind.symbol)
                .font(.system(size: 12))
                .foregroundStyle(action.failed(in: store.snapshot) ? AnyShapeStyle(Ink.red) : AnyShapeStyle(.secondary))
                .frame(width: 16)
                .centeredOnRowTitle()

            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(action.title).rowTitle(lines: nil)
                    if showsDetail {
                        ClampedText(markdown: action.detail, lineLimit: 4, size: 12, lineSpacing: Typo.rowLineSpacing)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.trailing, 20)  // clear the dismiss button
                .contentShape(Rectangle())
                .onTapGesture { collapse?() }
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
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, 16)
        .background(pick?.selected == true ? Ink.picked : Ink.band)
        .overlay(alignment: .topTrailing) {
            if !action.inFlight {
                IconButton(
                    systemName: "xmark",
                    help: action.dismissCloses ? "Close session" : "Dismiss",
                    size: 9,
                    weight: .semibold,
                    action: requestDismiss
                )
                .accessibilityIdentifier("action.dismiss.\(action.id)")
                .padding(.top, 12)
                .padding(.trailing, 6)
            }
        }
        .animation(Easing.quick, value: confirmingClose)
        .onChange(of: action.detail) { old, new in
            if draft == old { draft = new }  // the agent revised its draft; keep user edits
        }
        .contextMenu {
            ActionMenu(action: action, requestDismiss: requestDismiss)
            if let pick {
                Divider()
                Button(pick.selected ? "Deselect" : "Select", action: pick.toggle)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func requestDismiss() {
        if action.dismissCloses { confirmingClose = true } else { store.dismiss(action) }
    }

    /// Closing is not fixing: say so before it's recorded.
    private var closeConfirmation: some View {
        ConfirmPrompt(question: "Close the session without a fix?", label: "Close session", isPresented: $confirmingClose) {
            store.dismiss(action)
        }
    }

    /// The daemon is resolving it (merging, tagging…). No button to press twice.
    private var progress: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(action.kind.progressLabel)
                .font(Typo.caption)
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
                    .font(Typo.body)
                    .lineLimit(2...8)
                    .inputField()
                HStack(spacing: 8) {
                    Button(action.primaryLabel) { store.resolve(action, response: draft) }
                        .buttonStyle(.stage(.primary))
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if draft != action.detail {
                        TextLink("Revert") { draft = action.detail }
                            .font(Typo.small)
                    }
                    if store.isBusy(action.id) { ProgressView().controlSize(.mini) }
                }
            }
        } else if action.kind == .answer && action.options.isEmpty {
            HStack(spacing: 6) {
                TextField("Reply to the agent", text: $reply)
                    .textFieldStyle(.plain)
                    .font(Typo.body)
                    .inputField()
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.geist(10, .bold))
                }
                .buttonStyle(.stage(.primary))
                .disabled(reply.trimmingCharacters(in: .whitespaces).isEmpty)
                .help(action.primaryLabel)
            }
        } else if action.kind == .answer {
            OptionChips(options: action.options) { store.resolve(action, response: $0) }
        } else {
            HStack(spacing: 10) {
                Button(action.primaryLabel) { store.resolve(action) }
                    .buttonStyle(.stage(.primary))
                // review: the agent ended without a fix. Talking to it is the alternative
                // to Retry / Close session, so it opens the session's message field,
                // offered only when the daemon will take a message.
                if action.kind == .review, let session = action.sessionId,
                   store.snapshot?.session(id: session)?.acceptsMessages == true {
                    TextLink("Reply to agent", direction: .inward) { store.show(.session(session)) }
                        .font(Typo.small)
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

/// A card's own menu items, for its row and for the opened card.
private struct ActionMenu: View {
    @Environment(Store.self) private var store
    let action: Action
    let requestDismiss: () -> Void

    var body: some View {
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
    }
}

/// Quick replies for `answer` actions. Wraps onto multiple lines.
private struct OptionChips: View {
    let options: [String]
    let choose: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button(option) { choose(option) }
                    .buttonStyle(.stage(index == 0 ? .primary : .secondary))
                    // Cut to the card's width when it is longer.
                    .help(option)
            }
        }
    }
}

extension Action {
    /// The agent behind it failed (a re-run, or a review of a failed session): marked red on
    /// its row, where every other meaning is left to the group's header.
    func failed(in snapshot: Snapshot?) -> Bool {
        kind == .rerun || (kind == .review && snapshot?.session(id: sessionId)?.tone == .failure)
    }
}

extension View {
    /// Dimmed while a request for it is in flight, and closed to a second click.
    func busy(_ busy: Bool, dims: Bool = true) -> some View {
        disabled(busy)
            .opacity(busy && dims ? 0.6 : 1)
            .animation(Easing.quick, value: busy)
    }
}
