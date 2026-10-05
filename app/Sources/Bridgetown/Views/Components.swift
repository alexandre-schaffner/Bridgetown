import AppKit
import SwiftUI

// Small shared building blocks for the island's panes. Spacing runs on a 4pt grid:
// 12 inside blocks, 24 between sections, 8 between related lines.

enum Metrics {
    static let inset: CGFloat = 12
    static let cardRadius: CGFloat = Ink.panelRadius
}

// MARK: Section header

/// A title and, past one, how many rows follow. The count stays grey: the rows carry
/// the colour where it means something.
struct SectionHeader: View {
    /// Tall enough for a compact button, so a selection header can stand in without a jump.
    static let height: CGFloat = 24

    let title: String
    var count: Int?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(Typo.title)
                .tracking(Typo.titleTracking)
                .foregroundStyle(.primary)
            if let count, count > 1 {
                Text("\(count)")
                    .font(.geist(12).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
        }
        .frame(height: Self.height)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: Detail section

/// A titled block in a detail pane: the title, content below. No outline of its own.
/// Under `fullBleed` the title takes the pane's inset; content that isn't a table should
/// take it too (`bleedInset()`).
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
                Text(title)
                    .font(Typo.title)
                    .tracking(Typo.titleTracking)
                    .foregroundStyle(.primary)
                if let detail {
                    Text(detail)
                        .font(.geist(12.5))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .bleedInset()
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

// MARK: Icon button

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
                .font(.geist(12))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 24, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .hoverHighlight(radius: 5)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Borderless SF Symbol button used in headers (pause, gear, dismiss).
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
                // Pause becomes play (and back) as one symbol morphing, not a swap.
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .hoverHighlight(radius: 6)
        .animation(Easing.state, value: systemName)
        .help(help)
        .accessibilityLabel(help)
    }
}

// MARK: Confirmation

/// An inline "are you sure" for destructive actions, in place of the button that asked.
/// A sheet or alert would take the island's focus away, so this stays in the view.
/// Cancels itself after 5 seconds.
struct ConfirmButtons: View {
    let confirmLabel: String
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button("Cancel", action: onCancel)
                .buttonStyle(.stage(.secondary))
            Button(confirmLabel, role: .destructive, action: onConfirm)
                .buttonStyle(.stage(.danger))
        }
        .task {
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { onCancel() }
        }
    }
}
