import AppKit
import SwiftUI

// Small shared building blocks for the island's panes. Spacing runs on a 4pt grid:
// 12 inside blocks, 24 between sections, 8 between related lines.

enum Metrics {
    static let inset: CGFloat = 12
    /// A section's header: tall enough for a stage button, so a selection header or a
    /// prompt can stand in for it without a jump.
    static let headerHeight: CGFloat = 24
}

// MARK: Section header

/// A title and, past one, how many rows follow; anything that belongs beside the title
/// (the prod column's tabs) at its end. The count stays grey: the rows carry the colour
/// where it means something.
struct SectionHeader<Trailing: View>: View {
    let title: String
    var count: Int?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).sectionTitle()
            if let count, count > 1 {
                Text("\(count)")
                    .font(Typo.body.monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
            trailing
        }
        .frame(height: Metrics.headerHeight)
        .accessibilityAddTraits(.isHeader)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(title: String, count: Int? = nil) {
        self.init(title: title, count: count) { EmptyView() }
    }
}

// MARK: Detail section

/// A titled block in a detail pane: the title, content below. No outline of its own. The
/// title takes the pane's inset; content that isn't a table should take it too.
struct DetailSection<Content: View>: View {
    let title: String
    /// Shown after the title as written, never uppercased: a route or a board name.
    var detail: String?
    @ViewBuilder var content: Content

    init(title: String, detail: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.detail = detail
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).sectionTitle()
                if let detail {
                    Text(detail)
                        .font(Typo.fact)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .padding(.horizontal, Metrics.inset)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Channel chip

struct ChannelChip: View {
    let name: String

    var body: some View {
        Text(Format.channel(name))
            .font(.geist(11, .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: Ink.tagRadius))
    }
}

// MARK: Feedback

/// 👍 / 👎 on Jev's call for an alert: labels the verdict for calibration. The chosen one
/// is filled; choosing again changes the label.
struct FeedbackThumbs: View {
    @Environment(Store.self) private var store
    let alert: AlertView

    var body: some View {
        HStack(spacing: 4) {
            thumb(.good, symbol: "hand.thumbsup", help: "Good call")
            thumb(.bad, symbol: "hand.thumbsdown", help: "Bad call")
        }
        .disabled(store.isBusy(alert.id))
    }

    private func thumb(_ label: AlertView.Feedback, symbol: String, help: String) -> some View {
        let selected = alert.feedback == label
        return Button {
            store.feedback(alert, label)
        } label: {
            Image(systemName: selected ? symbol + ".fill" : symbol)
                .font(Typo.body)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 24, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .hoverFill(radius: 5)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: Icon button

/// A borderless SF Symbol button: a detail's back chevron, a card's dismiss cross.
struct IconButton: View {
    let systemName: String
    let help: String
    var size: CGFloat = 15
    var weight: Font.Weight = .regular
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: weight))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .hoverFill(radius: 6)
        .help(help)
        .accessibilityLabel(help)
    }
}

// MARK: Confirmation

/// An inline "are you sure" for a destructive action, in place of the control that asked:
/// what will happen, Cancel, and the action in red. A sheet or an alert would take the
/// island's focus away, so it stays in the view. It withdraws itself after 5 seconds.
///
/// On one line where it fits, the buttons at its end (`.fixedSize()` keeps it to its own
/// width); where it doesn't, the question takes a line of its own above them. The
/// buttons' labels are never cut: they say what a click does.
struct ConfirmPrompt: View {
    let question: String
    let label: String
    @Binding var isPresented: Bool
    let action: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                questionText.fixedSize()
                Spacer(minLength: 0)
                buttons
            }
            VStack(alignment: .leading, spacing: 8) {
                questionText.fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) { buttons }
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { isPresented = false }
        }
    }

    private var questionText: some View {
        Text(question)
            .font(Typo.small)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var buttons: some View {
        Button("Cancel") { isPresented = false }
            .buttonStyle(.stage(.secondary))
            .fixedSize()
        Button(label, role: .destructive) {
            isPresented = false
            action()
        }
        .buttonStyle(.stage(.danger))
        .fixedSize()
    }
}
