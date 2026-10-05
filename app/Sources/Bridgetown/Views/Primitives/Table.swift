import SwiftUI

// Tables: rows separated by hairlines, not cards; the fills a row takes under the pointer.

// MARK: Hairline

/// The stage's divider: a 1pt line at hairline white, in place of the system separator.
struct Hairline: View {
    var vertical = false
    @Environment(\.displayScale) private var scale

    /// One device pixel.
    private var width: CGFloat { 1 / max(scale, 1) }

    var body: some View {
        if vertical {
            Ink.hairline.frame(width: width)
        } else {
            Ink.hairline.frame(height: width)
        }
    }
}

// MARK: Full bleed

private struct FullBleedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Tables run to the pane's edges between full-width hairlines, rather than sitting in
    /// an outlined block. The pane then pads only vertically, and the text around a table
    /// (titles, footers, buttons) takes the inset itself through `bleedInset()`.
    var fullBleed: Bool {
        get { self[FullBleedKey.self] }
        set { self[FullBleedKey.self] = newValue }
    }
}

extension View {
    /// Text beside a table: the pane's inset, when tables run to the edges.
    func bleedInset() -> some View { modifier(BleedInset()) }

    /// A table's frame: an outlined block, or hairlines above and below it at full width.
    func tableFrame() -> some View { modifier(TableFrame()) }
}

private struct BleedInset: ViewModifier {
    @Environment(\.fullBleed) private var fullBleed

    func body(content: Content) -> some View {
        content.padding(.horizontal, fullBleed ? Metrics.inset : 0)
    }
}

private struct TableFrame: ViewModifier {
    @Environment(\.fullBleed) private var fullBleed

    func body(content: Content) -> some View {
        if fullBleed {
            VStack(spacing: 0) {
                Hairline()
                content
                Hairline()
            }
        } else {
            content.outlined()
        }
    }
}

// MARK: Row list

/// Rows in one table (see `tableFrame`), a hairline between each, not a stack of cards.
/// A row that arrives fades in where it lands and one that leaves fades out as the rest
/// close up, so a card resolving or an alert coming in reads as one change, not a jump.
struct RowList<Data: RandomAccessCollection, Row: View>: View where Data.Element: Identifiable {
    let data: Data
    @ViewBuilder let row: (Data.Element) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(data.enumerated()), id: \.element.id) { index, element in
                VStack(spacing: 0) {
                    if index > 0 { Hairline() }
                    row(element)
                }
                .transition(.opacity)
            }
        }
        .tableFrame()
        .animation(Easing.state, value: data.map(\.id))
    }
}

// MARK: Cell grid

/// Two cells a row in one table (see `tableFrame`), hairlines between: how charts sit side by side.
/// An item marked `wide` takes a row to itself, and the rest pair up around it.
struct CellGrid<Item: Identifiable, Cell: View>: View {
    let items: [Item]
    var wide: Item.ID?
    @ViewBuilder let cell: (Item) -> Cell

    private struct Row: Identifiable {
        let items: [Item]
        var id: [Item.ID] { items.map(\.id) }
    }

    private var rows: [Row] {
        var rows: [Row] = []
        var pair: [Item] = []
        for item in items {
            if item.id == wide {
                if !pair.isEmpty { rows.append(Row(items: pair)) }
                pair = []
                rows.append(Row(items: [item]))
            } else {
                pair.append(item)
                if pair.count == 2 {
                    rows.append(Row(items: pair))
                    pair = []
                }
            }
        }
        if !pair.isEmpty { rows.append(Row(items: pair)) }
        return rows
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Hairline() }
                HStack(spacing: 0) {
                    cell(row.items[0]).frame(maxWidth: .infinity)
                    if row.items[0].id != wide {
                        Hairline(vertical: true)
                        if row.items.count > 1 {
                            cell(row.items[1]).frame(maxWidth: .infinity)
                        } else {
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tableFrame()
    }
}

// MARK: Card

extension View {
    /// A standalone outlined block; `highlighted` on hover.
    func card(highlighted: Bool = false) -> some View {
        outlined(fill: highlighted ? Color(white: 0.06) : Ink.surface)
    }
}

// MARK: Hover

struct HoverHighlight: ViewModifier {
    var radius: CGFloat = 6
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(hovering ? Ink.hover : .clear)
            )
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverHighlight(radius: CGFloat = 6) -> some View { modifier(HoverHighlight(radius: radius)) }

    /// A row in a `RowList` with controls of its own: a faint fill on hover. A row that is
    /// one button uses `RowButtonStyle`, which also answers the press.
    func rowHighlight(_ enabled: Bool = true) -> some View { modifier(RowHighlight(enabled: enabled)) }
}

struct RowHighlight: ViewModifier {
    var enabled = true
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(hovering && enabled ? Ink.hover : .clear)
            .onHover { hovering = $0 }
            .animation(Easing.quick, value: hovering)
    }
}

/// A whole row as a button: a faint fill on hover, a firmer one while the button is
/// down, so a click is felt before it navigates, and while the row is picked.
struct RowButtonStyle: ButtonStyle {
    /// Picked for a bulk action: the firm fill stays.
    var selected = false

    func makeBody(configuration: Configuration) -> some View {
        RowLabel(configuration: configuration, selected: selected)
    }

    private struct RowLabel: View {
        let configuration: Configuration
        let selected: Bool
        @ViewState private var hovering = false

        var body: some View {
            configuration.label
                .background(selected ? Ink.picked : configuration.isPressed ? Ink.selected : hovering ? Ink.hover : .clear)
                .onHover { hovering = $0 }
                .animation(Easing.quick, value: hovering)
                .animation(Easing.quick, value: configuration.isPressed)
        }
    }
}
