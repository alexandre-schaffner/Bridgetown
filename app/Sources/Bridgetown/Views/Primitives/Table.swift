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

// MARK: Table frame

extension View {
    /// A table's frame: a hairline above and one below, across the whole pane. Tables run
    /// to the pane's edges; the text around them (titles, footers, buttons) takes the
    /// pane's inset, `Metrics.inset`, itself.
    func tableFrame() -> some View {
        VStack(spacing: 0) {
            Hairline()
            self
            Hairline()
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

// MARK: Hover

extension View {
    /// A faint fill under the pointer: square for a row of a table, rounded for a small
    /// control. A row that is one button is a `TableRow`, which also answers the press.
    func hoverFill(radius: CGFloat = 0, enabled: Bool = true) -> some View {
        modifier(HoverFill(radius: radius, enabled: enabled))
    }
}

private struct HoverFill: ViewModifier {
    let radius: CGFloat
    let enabled: Bool
    @ViewState private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(hovering && enabled ? Ink.hover : .clear)
            )
            .onHover { hovering = $0 }
            .animation(Easing.quick, value: hovering)
    }
}

// MARK: Table row

/// A row of a table that is one button: it opens what it stands for, and with a `pick`
/// it can be picked for a bulk action too (a click picks instead of opening while the
/// list is picking, or with ⌘ or ⇧ held). Its fill says how it stands: picked, pressed,
/// under the pointer.
///
/// The row tracks the pointer once and hands it to its content (to show the selection
/// mark) and to its overlay (controls laid over the row's end, outside the button so they
/// take their own clicks). Its menu gets Select or Deselect after the row's own items.
struct TableRow<Content: View, Overlay: View, Menu: View>: View {
    var pick: RowPick?
    /// Nil when there is nothing to open: the row is not a button then.
    let open: (() -> Void)?
    @ViewBuilder let content: (_ hovering: Bool) -> Content
    @ViewBuilder let overlay: (_ hovering: Bool) -> Overlay
    @ViewBuilder let menu: () -> Menu
    @ViewState private var hovering = false

    var body: some View {
        Group {
            if let open {
                Button {
                    if pick?.click() != true { open() }
                } label: {
                    label
                }
                .buttonStyle(Fill(picked: pick?.selected == true, hovering: hovering))
            } else {
                label.background(pick?.selected == true ? Ink.picked : .clear)
            }
        }
        .overlay(alignment: .trailing) { overlay(hovering) }
        .onHover { hovering = $0 }
        .animation(Easing.quick, value: hovering)
        .accessibilityAddTraits(pick?.selected == true ? .isSelected : [])
        // The selection mark shows only under the pointer; this picks the row without it.
        .accessibilityActions {
            if let pick { Button(pick.selected ? "Deselect" : "Select", action: pick.toggle) }
        }
        .contextMenu {
            menu()
            if let pick {
                Divider()
                Button(pick.selected ? "Deselect" : "Select", action: pick.toggle)
            }
        }
    }

    private var label: some View {
        content(hovering)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }

    /// A faint fill on hover, a firmer one while the button is down, so a click is felt
    /// before it navigates, and the picked fill while the row is picked.
    private struct Fill: ButtonStyle {
        let picked: Bool
        let hovering: Bool

        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .background(picked ? Ink.picked : configuration.isPressed ? Ink.selected : hovering ? Ink.hover : .clear)
                .animation(Easing.quick, value: configuration.isPressed)
        }
    }
}

extension TableRow where Overlay == EmptyView {
    init(pick: RowPick? = nil, open: (() -> Void)?, @ViewBuilder content: @escaping (_ hovering: Bool) -> Content, @ViewBuilder menu: @escaping () -> Menu) {
        self.init(pick: pick, open: open, content: content, overlay: { _ in EmptyView() }, menu: menu)
    }
}

extension TableRow where Overlay == EmptyView, Menu == EmptyView {
    init(open: (() -> Void)?, @ViewBuilder content: @escaping (_ hovering: Bool) -> Content) {
        self.init(pick: nil, open: open, content: content, overlay: { _ in EmptyView() }, menu: { EmptyView() })
    }
}

// MARK: Fold row

/// A row that shows more of its table: what it holds, and a chevron that turns down as it
/// opens. Its words start at `leading`, where the rows' glyphs do.
struct FoldRow: View {
    let title: String
    let open: Bool
    let leading: CGFloat
    let toggle: () -> Void

    var body: some View {
        TableRow(open: toggle) { _ in
            HStack(spacing: 10) {
                Text(title)
                    .font(Typo.body)
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .padding(.leading, leading)
            .padding(.trailing, Metrics.inset)
            .frame(height: 42)
        }
    }
}
