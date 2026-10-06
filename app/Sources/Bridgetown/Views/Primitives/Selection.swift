import AppKit
import SwiftUI

// Picking several rows of a list to act on them at once, as in Finder: ⌘-click toggles a
// row, ⇧-click picks the run from the last row picked. A row's mark (in its leading
// column, on hover) toggles it too, so a selection can be made with the mouse alone; and
// while anything is picked, a plain click toggles instead of opening, until it's cleared.

/// The rows picked in one list, by id.
struct RowSelection: Equatable {
    private(set) var ids: Set<String> = []
    /// Where a ⇧-click range starts: the last row toggled.
    private var anchor: String?

    var isEmpty: Bool { ids.isEmpty }
    var count: Int { ids.count }
    func contains(_ id: String) -> Bool { ids.contains(id) }

    mutating func toggle(_ id: String) {
        if ids.remove(id) == nil { ids.insert(id) }
        anchor = id
    }

    /// Picks every row from the anchor to `id`, keeping what was already picked.
    mutating func extend(to id: String, in order: [String]) {
        guard let anchor, let from = order.firstIndex(of: anchor), let to = order.firstIndex(of: id) else {
            toggle(id)
            return
        }
        ids.formUnion(order[min(from, to)...max(from, to)])
    }

    /// Picks all of `group`, or none of it when all of it is already picked.
    mutating func toggle(all group: [String]) {
        if group.allSatisfy(ids.contains) { ids.subtract(group) } else { ids.formUnion(group) }
        anchor = nil
    }

    mutating func set(_ ids: some Sequence<String>) {
        self.ids = Set(ids)
        anchor = nil
    }

    mutating func clear() { set([]) }

    /// Forgets rows that have left the list (resolved, aged out).
    mutating func keep(only present: some Sequence<String>) {
        let present = Set(present)
        ids.formIntersection(present)
        if let a = anchor, !present.contains(a) { anchor = nil }
    }

    /// A click on row `id`. Returns whether it picked: with ⌘ or ⇧ held, or while
    /// something is already picked. Otherwise the row does what a click does.
    mutating func click(_ id: String, in order: [String], modifiers: NSEvent.ModifierFlags) -> Bool {
        if modifiers.contains(.shift) {
            extend(to: id, in: order)
        } else if modifiers.contains(.command) || !isEmpty {
            toggle(id)
        } else {
            return false
        }
        return true
    }
}

/// What a row needs to know about the list's selection.
struct RowPick {
    var selected: Bool
    /// Something in the list is picked: every row shows its mark.
    var picking: Bool
    /// Handles a click with the current modifier keys; true when it picked.
    var click: @MainActor () -> Bool
    var toggle: @MainActor () -> Void
}

extension Binding where Value == RowSelection {
    /// The pick for row `id` of a list in `order`.
    @MainActor
    func pick(_ id: String, in order: [String]) -> RowPick {
        RowPick(
            selected: wrappedValue.contains(id),
            picking: !wrappedValue.isEmpty,
            click: {
                let picked = wrappedValue.click(id, in: order, modifiers: NSEvent.modifierFlags)
                if picked { Haptics.perform(.alignment, "select") }
                return picked
            },
            toggle: {
                wrappedValue.toggle(id)
                Haptics.perform(.alignment, "select")
            }
        )
    }
}

// MARK: Mark

/// A row's leading column: its own glyph at rest; a hollow circle to pick it on hover or
/// while the list is picking; filled white with a dark check once picked.
struct SelectMark<Glyph: View>: View {
    let pick: RowPick?
    var hovering: Bool
    @ViewBuilder var glyph: Glyph

    private var showsMark: Bool {
        guard let pick else { return false }
        return pick.selected || pick.picking || hovering
    }

    var body: some View {
        ZStack {
            if showsMark, let pick {
                Button(action: pick.toggle) {
                    ZStack {
                        if pick.selected {
                            Circle().fill(Ink.text)
                            Image(systemName: "checkmark")
                                .font(.system(size: 7.5, weight: .bold))
                                .foregroundStyle(Ink.stage)
                        } else {
                            Circle().strokeBorder(Ink.outline, lineWidth: 1)
                        }
                    }
                    .frame(width: 13, height: 13)
                    .frame(width: Self.size, height: Self.size)
                    // A little larger to hit than to see, without taking more room.
                    .contentShape(Rectangle().inset(by: -3))
                }
                .buttonStyle(.plain)
                .help(pick.selected ? "Deselect" : "Select (⌘-click a row; ⇧-click for a range)")
                .accessibilityLabel(pick.selected ? "Deselect" : "Select")
                .transition(.opacity)
            } else {
                glyph.transition(.opacity)
            }
        }
        // One size whatever it shows (an empty slot, a dot, a glyph, the circle), so a
        // row never changes height or shifts when the mark appears under the pointer.
        .frame(width: Self.size, height: Self.size)
        .animation(Easing.quick, value: showsMark)
    }

    private static var size: CGFloat { 16 }
}

// MARK: Selection header

/// Stands in for a section's header while rows are picked: how many, the bulk actions,
/// and Clear. The same height as the header it replaces, so nothing jumps.
///
/// It keeps to its column: short of room it drops "Select all", then says only the count,
/// with the actions' labels whole until nothing else is left to give. Wider than its
/// column, it would widen every list under it past the island's edge.
struct SelectionHeader<Actions: View>: View {
    let count: Int
    /// All of the list's rows, to offer "Select all" until they are.
    let total: Int
    let selectAll: () -> Void
    let clear: () -> Void
    @ViewBuilder var actions: Actions

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(counted: "\(count) selected", offersSelectAll: count < total)
            row(counted: "\(count) selected", offersSelectAll: false)
            row(counted: "\(count)", offersSelectAll: false)
            row(counted: "\(count)", offersSelectAll: false, squeezed: true)
        }
        .frame(height: Metrics.headerHeight)
        .animation(Easing.quick, value: count)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(counted: String, offersSelectAll: Bool, squeezed: Bool = false) -> some View {
        HStack(spacing: 8) {
            Text(counted)
                .sectionTitle()
                .monospacedDigit()
                .contentTransition(.numericText())
                .lineLimit(1)
                .fixedSize()
                .accessibilityLabel("\(count) selected")
            if offersSelectAll {
                TextLink("Select all", action: selectAll)
                    .font(Typo.label)
                    .fixedSize()
            }
            Spacer(minLength: 0)
            actions
                .fixedSize(horizontal: !squeezed, vertical: false)
            Button(action: clear) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .hoverFill(radius: Ink.tagRadius)
            // Escape is the overview's: it clears every list at once (`OverviewPicks`).
            .help("Clear selection (Esc)")
            .accessibilityLabel("Clear selection")
        }
    }
}

/// A section's header, or its selection header while rows are picked. A bulk action that
/// asks first (`confirming`) puts its prompt in place of the whole selection header, so the
/// question has the width to say what will happen, and a second line in a narrow column;
/// clearing the selection withdraws it.
struct PickingHeader<Header: View, Actions: View, Prompt: View>: View {
    @Binding var selection: RowSelection
    let order: [String]
    @Binding var confirming: Bool
    let header: Header
    let actions: Actions
    let prompt: Prompt

    init(
        selection: Binding<RowSelection>,
        order: [String],
        confirming: Binding<Bool>,
        @ViewBuilder header: () -> Header,
        @ViewBuilder actions: () -> Actions,
        @ViewBuilder prompt: () -> Prompt
    ) {
        _selection = selection
        self.order = order
        _confirming = confirming
        self.header = header()
        self.actions = actions()
        self.prompt = prompt()
    }

    var body: some View {
        ZStack(alignment: .leading) {
            if selection.isEmpty {
                header.transition(.opacity)
            } else if confirming {
                prompt.transition(.opacity)
            } else {
                SelectionHeader(
                    count: selection.count,
                    total: order.count,
                    selectAll: { selection.set(order) },
                    clear: { selection.clear() }
                ) { actions }
                .transition(.opacity)
            }
        }
        .frame(minHeight: Metrics.headerHeight)
        .animation(Easing.quick, value: selection.isEmpty)
        .animation(Easing.quick, value: confirming)
        .onChange(of: order) { _, ids in selection.keep(only: ids) }
        .onChange(of: selection.isEmpty) { _, empty in if empty { confirming = false } }
    }
}

extension PickingHeader where Prompt == EmptyView {
    /// For a list whose bulk actions never ask first.
    init(selection: Binding<RowSelection>, order: [String], @ViewBuilder header: () -> Header, @ViewBuilder actions: () -> Actions) {
        self.init(selection: selection, order: order, confirming: .constant(false), header: header, actions: actions) { EmptyView() }
    }
}
