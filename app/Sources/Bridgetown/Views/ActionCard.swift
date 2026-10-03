import SwiftUI

struct ActionCard: View {
    @Environment(Store.self) private var store
    let action: Action
    /// Collapsed, the card is one row: title, one line of detail and the primary button
    /// when it needs no input. Expanding shows everything. Detail panes always expand.
    var expanded = true
    /// Tapping the row; nil where the card can't collapse.
    var onToggle: (() -> Void)?
    @ViewState private var reply = ""
    /// Editable copy of a `reply` action's draft.
    @ViewState private var draft: String
    @ViewState private var confirmingClose = false
    @FocusState private var replyFocused: Bool

    init(action: Action, expanded: Bool = true, onToggle: (() -> Void)? = nil) {
        self.action = action
        self.expanded = expanded
        self.onToggle = onToggle
        _draft = ViewState(initialValue: action.detail)
    }

    @ViewState private var hovering = false

    /// Kinds whose primary button needs nothing typed or chosen, so a collapsed row can offer it.
    private var oneClick: Bool {
        switch action.kind {
        case .reply, .answer: false
        default: action.options.isEmpty
        }
    }

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
        .animation(.snappy(duration: 0.18), value: confirmingClose)
        .onChange(of: action.detail) { old, new in
            if draft == old { draft = new }  // the agent revised its draft; keep user edits
        }
        .contextMenu {
            if let session = action.sessionId {
                Button("Show session") { store.show(.session(session)) }
            }
            if !action.inFlight {
                Button(action.dismissCloses ? "Close session…" : "Dismiss", action: requestDismiss)
            }
        }
    }

    private var icon: some View {
        Image(systemName: action.kind.symbol)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(.orange)
            .frame(width: 22, height: 22)
            .background(Color.orange.opacity(0.14), in: Circle())
    }

    /// One row: icon, title over a line of detail, then the primary button, progress, or a
    /// disclosure chevron for the kinds that need input.
    private var compact: some View {
        HStack(alignment: .center, spacing: 10) {
            icon
            VStack(alignment: .leading, spacing: 1) {
                Text(action.title)
                    .font(.system(size: 12.5, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                if !action.detail.isEmpty {
                    Text(action.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if action.inFlight {
                ProgressView().controlSize(.mini)
                    .help(action.kind.progressLabel)
            } else if oneClick {
                Button(action.primaryLabel) { store.resolve(action) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .lineLimit(1)
                    .fixedSize()
            } else {
                Text(action.kind == .reply ? "Review reply" : "Answer")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(.quaternary.opacity(hovering ? 0.7 : 0))
        )
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .onTapGesture { onToggle?() }
        .help(action.detail.isEmpty ? action.title : "\(action.title)\n\(action.detail)")
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Expand") { onToggle?() }
    }

    private var full: some View {
        HStack(alignment: .top, spacing: 10) {
            icon
                .padding(.top, -2)

            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if showsDetail {
                        Text(action.detail)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
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
        .padding(onToggle == nil ? Metrics.inset : 10)
        .background {
            // In the overview the card sits in a panel; elsewhere it carries its own fill.
            if onToggle == nil {
                RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).fill(.quaternary.opacity(0.5))
            } else {
                RoundedRectangle(cornerRadius: 7, style: .continuous).fill(.quaternary.opacity(0.55))
            }
        }
        .overlay(alignment: .topTrailing) {
            if !action.inFlight {
                IconButton(systemName: "xmark", help: dismissLabel, size: 9, weight: .semibold, action: requestDismiss)
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
                .font(.system(size: 11))
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
                .font(.system(size: 11))
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
                    .font(.system(size: 12))
                    .lineLimit(2...8)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(.quaternary, lineWidth: 0.5))
                HStack(spacing: 8) {
                    Button(action.primaryLabel) { store.resolve(action, response: draft) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if draft != action.detail {
                        Button("Revert") { draft = action.detail }
                            .buttonStyle(.plain)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    if store.isBusy(action.id) { ProgressView().controlSize(.mini) }
                }
            }
        } else if action.kind == .answer && action.options.isEmpty {
            HStack(spacing: 6) {
                TextField("Reply to the agent", text: $reply)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                    .focused($replyFocused)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 10, weight: .bold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(reply.trimmingCharacters(in: .whitespaces).isEmpty)
                .help(action.primaryLabel)
            }
        } else if action.kind == .answer {
            OptionChips(options: action.options) { store.resolve(action, response: $0) }
        } else {
            HStack(spacing: 10) {
                Button(action.primaryLabel) { store.resolve(action) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                // review: the agent ended without a fix. Talking to it is the alternative
                // to Retry / Close session, so it opens the session's message field,
                // offered only when the daemon will take a message.
                if action.kind == .review, let session = action.sessionId,
                   store.snapshot?.session(id: session)?.acceptsMessages == true {
                    Button("Reply to agent") { store.show(.session(session)) }
                        .buttonStyle(.plain)
                        .font(.system(size: 11))
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
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                } else {
                    Button(option) { choose(option) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }
}
