import SwiftUI

// The app's identity: black, structure drawn with 1pt borders instead of fills,
// Geist for words and Geist Mono only for machine text (branches, logs), white for
// the one primary action, and colour only on small status marks (PRODUCT.md): blue
// for live work, amber for "needs you", green for verified outcomes, red for failure.

enum Ink {
    /// The stage behind everything.
    static let stage = Color.black
    /// Panels and inputs: a hair above the stage, outlined.
    static let surface = Color(white: 0.039)
    /// Hover on a row, the selected tab.
    static let hover = Color.white.opacity(0.045)
    static let selected = Color.white.opacity(0.09)
    /// A row picked for a bulk action: firmer than hover, monochrome like every control.
    static let picked = Color.white.opacity(0.075)
    /// `hover` over the stage, opaque: for something laid over a hovered row's text.
    static let hoverSolid = Color(white: 0.045)
    /// A band set apart inside a table, fainter than hover: a group's header, an opened
    /// card, a notice, machine text (the transcript, a raw message).
    static let band = Color.white.opacity(0.025)
    /// Panel outlines and the dividers between rows.
    static let hairline = Color.white.opacity(0.17)
    /// Control outlines (secondary buttons, inputs, the tab switch): one step stronger.
    static let outline = Color.white.opacity(0.26)
    static let track = Color.white.opacity(0.08)
    /// Data marks: neutral, a step below the text.
    static let mark = Color.white.opacity(0.62)
    /// The same grey, opaque: a status mark with no colour of its own (a step stopped, or
    /// held in the queue), which fills and glows are tinted from.
    static let neutral = Color(white: 0.62)

    /// Text levels on black: 16:1, 7.6:1, 5.5:1 (all AA).
    static let text = Color(white: 0.93)
    static let dim = Color(white: 0.63)
    static let faint = Color(white: 0.53)

    /// Status marks only. Each clears 7:1 on black (AAA), so a status word reads as
    /// clearly as the text around it and a mark stands out from the greys: blue 7.7:1,
    /// amber 11.6:1, green 8.7:1, red 7.1:1.
    static let blue = Color(red: 0.24, green: 0.63, blue: 1)
    static let amber = Color(red: 1, green: 0.698, blue: 0.141)
    static let green = Color(red: 0.204, green: 0.741, blue: 0.482)
    static let red = Color(red: 1, green: 0.38, blue: 0.36)

    static let panelRadius: CGFloat = 8
    static let controlRadius: CGFloat = 6
    static let tagRadius: CGFloat = 4
}

// MARK: Motion

/// The app's timings: quick for feedback under the pointer (a press, a hover), state for
/// something that changed (a tab, a list, a card), pane for one pane taking another's
/// place, all easing out without a bounce. Under Reduce Motion each becomes a short
/// fade-length ease; the transitions that would slide or scale (a detail coming in, the
/// island's content unfolding) are plain fades there, chosen where each is declared from
/// the environment's `accessibilityReduceMotion`, the same setting this reads.
enum Easing {
    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    static var quick: Animation { reduceMotion ? .easeOut(duration: 0.08) : .easeOut(duration: 0.12) }
    static var state: Animation { reduceMotion ? .easeOut(duration: 0.12) : .smooth(duration: 0.24) }
    static var pane: Animation { reduceMotion ? .easeOut(duration: 0.12) : .smooth(duration: 0.32) }
}

// MARK: Type

/// The type scale: the sizes the stage is set in, named for what they set, so a screen
/// keeps to a few steps. A size not here is a glyph's (an icon, a mark) or a one-off
/// headline.
enum Typo {
    /// A detail pane's title.
    static let paneTitle = Font.geist(15, .semibold)
    /// Section titles.
    static let title = Font.geist(13, .semibold)
    static let titleTracking: CGFloat = -0.25
    /// A detail pane's prose: what the agent is doing, how it ended, the message field.
    static let lead = Font.geist(13)
    /// The default: prose, a row's line of detail.
    static let body = Font.geist(12)
    /// A body line that leads its block: Jev's decision, a chart's title.
    static let strong = Font.geist(12, .medium)
    /// Footers, links in text, secondary lines.
    static let small = Font.geist(11.5)
    /// Controls and field labels: buttons, tabs, text links.
    static let label = Font.geist(11.5, .medium)
    /// Notes and captions under something larger.
    static let caption = Font.geist(11)
    /// Times, durations and ages: tabular, so a column of them lines up.
    static let time = Font.geist(11.5).monospacedDigit()
    /// A number that is the point of its tile: tabular, so it doesn't jitter as it updates.
    static func figure(_ size: CGFloat) -> Font { .geist(size, .medium).monospacedDigit() }

    /// The overview's rows, sized to read at a glance: a title over a line of detail
    /// (`body`) and its time. Long titles wrap to a second line rather than cut off.
    static let rowTitle = Font.geist(13.5, .medium)
    /// A touch tight, so titles set firm rather than loose.
    static let rowTitleTracking: CGFloat = -0.15
    static let rowLineSpacing: CGFloat = 2.5
    /// How far above a row title's baseline the middle of its first line sits: where a
    /// row's leading mark is centred.
    static let rowTitleMidline: CGFloat = 5
}

extension Text {
    /// A section's title, the same wherever a section starts.
    func sectionTitle() -> some View {
        font(Typo.title)
            .tracking(Typo.titleTracking)
            .foregroundStyle(.primary)
    }

    /// A row's title: up to two lines, then cut at the end.
    func rowTitle() -> some View {
        font(Typo.rowTitle)
            .tracking(Typo.rowTitleTracking)
            .lineSpacing(Typo.rowLineSpacing)
            .lineLimit(2)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The line of detail under a row's title, a step quieter: up to two lines.
    func rowDetail() -> some View {
        font(Typo.body)
            .lineSpacing(Typo.rowLineSpacing)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
    }
}

extension View {
    /// A row's leading mark (its glyph, the selection mark) centred on the first line of
    /// the title beside it, in an `HStack` aligned on first baselines.
    func centeredOnRowTitle() -> some View {
        alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + Typo.rowTitleMidline }
    }
}

// MARK: Stage

extension View {
    /// The island's palette: always dark, Geist at body size, with the hierarchical text
    /// styles (`.secondary`, `.tertiary`) remapped to readable greys. The tint is the text's
    /// own: a link in prose is underlined, not blue, since blue means live work.
    func stagePalette() -> some View {
        font(Typo.body)
            .foregroundStyle(Ink.text, Ink.dim, Ink.faint)
            .tint(Ink.text)
            .environment(\.colorScheme, .dark)
    }

    /// The palette on the black stage.
    func stage() -> some View {
        stagePalette().background { Ink.stage.ignoresSafeArea() }
    }

    /// A text field's frame: outlined, on the surface.
    func inputField() -> some View {
        padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Ink.surface, in: RoundedRectangle(cornerRadius: Ink.controlRadius, style: .continuous))
            .overlay(PixelStroke(radius: Ink.controlRadius, style: Ink.outline))
    }

    /// An outlined block on the stage. Rows inside are separated by `Hairline`s, not gaps.
    func outlined(radius: CGFloat = Ink.panelRadius, fill: Color = Ink.surface) -> some View {
        background(fill)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(PixelStroke(radius: radius, style: Ink.edge))
    }
}

extension Ink {
    /// A panel's outline, lit from above: the top edge catches more light than the sides.
    static let edge = LinearGradient(
        colors: [Color.white.opacity(0.26), Color.white.opacity(0.17), Color.white.opacity(0.15)],
        startPoint: .top,
        endPoint: .bottom
    )
}

// MARK: Pixel stroke

/// A rounded outline exactly one device pixel wide: 0.5pt on Retina, 1pt elsewhere.
struct PixelStroke<S: ShapeStyle>: View {
    let radius: CGFloat
    let style: S
    @Environment(\.displayScale) private var scale

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .strokeBorder(style, lineWidth: 1 / max(scale, 1))
    }
}

// MARK: Brand mark

/// Bridgetown's mark: the app icon's arch, flat, in the text colour.
struct BrandMark: View {
    /// The height of the line it sits on; the arch takes 70% of it.
    var size: CGFloat = 20

    var body: some View {
        let height = size * 0.7
        ArchShape(joint: max(1, size * 0.06))
            .fill(.primary)
            .frame(width: height * ArchMark.aspect, height: height)
            .frame(height: size)
            .accessibilityHidden(true)
    }
}

// MARK: Buttons

/// Three buttons, as in Geist: white primary (the one next step), outlined secondary,
/// red for destructive confirmations. One size: the island's rows and bars are dense.
struct StageButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger }
    var kind: Kind = .secondary

    func makeBody(configuration: Configuration) -> some View {
        StageButtonLabel(configuration: configuration, kind: kind)
    }

    private struct StageButtonLabel: View {
        let configuration: Configuration
        let kind: Kind
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @ViewState private var hovering = false

        var body: some View {
            configuration.label
                .font(Typo.label)
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .foregroundStyle(foreground)
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(background, in: RoundedRectangle(cornerRadius: Ink.controlRadius, style: .continuous))
                .overlay {
                    if kind == .secondary {
                        PixelStroke(radius: Ink.controlRadius, style: Ink.outline)
                    }
                }
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(RoundedRectangle(cornerRadius: Ink.controlRadius))
                // Pressed in a touch, so the click lands before the request does.
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.965 : 1)
                .onHover { hovering = $0 }
                .animation(Easing.quick, value: hovering)
                .animation(Easing.quick, value: configuration.isPressed)
        }

        private var foreground: Color {
            switch kind {
            case .primary: .black
            case .secondary: Ink.text
            case .danger: .white
            }
        }

        private var background: Color {
            let lift = configuration.isPressed ? 2.0 : hovering && isEnabled ? 1.0 : 0
            switch kind {
            case .primary: return Color(white: 0.93 - lift * 0.06)
            case .secondary: return Color.white.opacity(lift * 0.05)
            case .danger: return Ink.red.opacity(1 - lift * 0.1)
            }
        }
    }
}

extension ButtonStyle where Self == StageButtonStyle {
    static func stage(_ kind: StageButtonStyle.Kind) -> StageButtonStyle { StageButtonStyle(kind: kind) }
}

// MARK: Tab switch

/// A small outlined segmented control: the selected option on a raised fill that slides
/// to the option you pick.
struct TabSwitch<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let title: (Option) -> String
    @Namespace private var fill

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option == selection
                Button {
                    guard option != selection else { return }
                    Haptics.perform(.alignment, "tabSwitch")
                    selection = option
                } label: {
                    Text(title(option))
                        .font(Typo.label)
                        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .padding(.horizontal, 9)
                        .frame(height: 20)
                        .background {
                            if selected {
                                RoundedRectangle(cornerRadius: Ink.tagRadius)
                                    .fill(Ink.selected)
                                    .matchedGeometryEffect(id: "selection", in: fill)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .overlay(PixelStroke(radius: Ink.controlRadius, style: Ink.outline))
        .animation(Easing.state, value: selection)
    }
}
