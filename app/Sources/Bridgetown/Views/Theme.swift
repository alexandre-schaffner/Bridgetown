import CoreText
import SwiftUI

// The popover's identity: black, structure drawn with 1pt borders instead of fills,
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
    /// Panel outlines and the dividers between rows.
    static let hairline = Color.white.opacity(0.17)
    /// Control outlines (secondary buttons, inputs, the tab switch): one step stronger.
    static let outline = Color.white.opacity(0.26)
    static let track = Color.white.opacity(0.08)
    /// Data marks and finished steps: neutral, a step below the text.
    static let mark = Color.white.opacity(0.62)

    /// Text levels on black: 16:1, 7.6:1, 5.5:1 (all AA).
    static let text = Color(white: 0.93)
    static let dim = Color(white: 0.63)
    static let faint = Color(white: 0.53)

    /// Status marks only.
    static let blue = Color(red: 0, green: 0.565, blue: 1)
    static let amber = Color(red: 1, green: 0.698, blue: 0.141)
    static let green = Color(red: 0.188, green: 0.643, blue: 0.424)
    static let red = Color(red: 0.898, green: 0.282, blue: 0.302)

    static let panelRadius: CGFloat = 8
    static let controlRadius: CGFloat = 6
    static let tagRadius: CGFloat = 4
}

// MARK: Type

/// Geist, bundled under `app/Fonts` and registered at launch. Until it is (or if it
/// can't be), `Font.custom` falls back to the system font at the same size.
enum Geist {
    static func register() {
        for dir in fontDirectories {
            guard let urls = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { continue }
            let fonts = urls.filter { $0.pathExtension == "ttf" }
            guard !fonts.isEmpty else { continue }
            CTFontManagerRegisterFontURLs(fonts as CFArray, .process, true, nil)
            return
        }
    }

    /// `Contents/Resources/Fonts` in the app bundle (see the Makefile); in a debug build
    /// run from the package, the source tree's `app/Fonts`.
    private static var fontDirectories: [URL] {
        var dirs: [URL] = []
        if let resources = Bundle.main.resourceURL { dirs.append(resources.appendingPathComponent("Fonts")) }
        #if DEBUG
        dirs.append(URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../Fonts").standardizedFileURL)
        #endif
        return dirs
    }

    static func postScriptName(_ weight: Font.Weight, mono: Bool) -> String {
        let suffix: String
        switch weight {
        case .bold, .heavy, .black: suffix = mono ? "SemiBold" : "Bold"
        case .semibold: suffix = "SemiBold"
        case .medium: suffix = "Medium"
        default: suffix = "Regular"
        }
        return (mono ? "GeistMono-" : "Geist-") + suffix
    }
}

extension Font {
    static func geist(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(Geist.postScriptName(weight, mono: false), fixedSize: size)
    }

    static func geistMono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(Geist.postScriptName(weight, mono: true), fixedSize: size)
    }
}

enum Typo {
    /// Section titles.
    static let title = Font.geist(13, .semibold)
    static let titleTracking: CGFloat = -0.25
    /// Field labels inside a section.
    static let label = Font.geist(11.5, .medium)
    /// A number that is the point of its tile: tabular, so it doesn't jitter as it updates.
    static func figure(_ size: CGFloat) -> Font { .geist(size, .medium).monospacedDigit() }
    /// Times, durations and ages in rows.
    static let time = Font.geist(11).monospacedDigit()
}

// MARK: Stage

/// Paints the stage and pins the popover to its palette: always dark, with the
/// hierarchical text styles (`.secondary`, `.tertiary`) remapped to readable greys.
struct StageBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.geist(12))
            .foregroundStyle(Ink.text, Ink.dim, Ink.faint)
            .tint(Ink.blue)
            .background { StoneFill(base: Ink.stage, strength: 0.5).ignoresSafeArea() }
            .environment(\.colorScheme, .dark)
    }
}

extension View {
    func stage() -> some View { modifier(StageBackground()) }

    /// A text field's frame: outlined, on the surface.
    func inputField() -> some View {
        padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Ink.surface, in: RoundedRectangle(cornerRadius: Ink.controlRadius, style: .continuous))
            .overlay(PixelStroke(radius: Ink.controlRadius, style: Ink.outline))
    }

    /// An outlined block on the stage. Rows inside are separated by `Hairline`s, not gaps.
    func outlined(radius: CGFloat = Ink.panelRadius, fill: Color = Ink.surface) -> some View {
        background { StoneFill(base: fill) }
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

// MARK: Live

/// A status dot; live, it breathes (static under Reduce Motion).
struct LiveDot: View {
    let color: Color
    var live = false
    var size: CGFloat = 6

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .modifier(Pulse(active: live))
    }
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

/// Bridgetown's mark: a black bolt shield on a chip of polished marble. The one
/// mineral thing in the interface; everything else stays flat.
struct BrandMark: View {
    var size: CGFloat = 20

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
        Image(systemName: "bolt.shield.fill")
            .font(.system(size: size * 0.6, weight: .bold))
            .foregroundStyle(Color(white: 0.06))
            .frame(width: size, height: size)
            .background(Marble().clipShape(shape))
            .overlay(PolishedEdge(shape: shape))
            .accessibilityHidden(true)
    }
}

/// Pale stone with grey veins: soft mottling, one main vein that wanders and feathers,
/// a fork and a faint lower seam. Paths, not an image, so it stays sharp at any scale.
private struct Marble: View {
    var body: some View {
        Canvas { context, size in
            let w = size.width, h = size.height
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * w, y: y * h) }

            /// A cubic from a to b that wanders: sampled, then nudged sideways by a fixed
            /// sum of sines, so the vein is irregular but identical on every draw.
            func vein(_ a: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ b: CGPoint, wobble: CGFloat, seed: CGFloat) -> Path {
                Path { path in
                    let steps = 48
                    for i in 0...steps {
                        let t = CGFloat(i) / CGFloat(steps), u = 1 - t
                        let x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x
                        let y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
                        let n = sin(t * 11 + seed) * 0.6 + sin(t * 27 + seed * 2.1) * 0.3 + sin(t * 61 + seed * 3.7) * 0.1
                        let pt = CGPoint(x: x, y: y + n * wobble * h)
                        if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                    }
                }
            }

            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .linearGradient(
                    Gradient(colors: [Color(white: 0.97), Color(white: 0.92), Color(white: 0.87)]),
                    startPoint: .zero, endPoint: CGPoint(x: w, y: h)
                )
            )

            // Mottling: a few soft clouds of grey in the stone.
            var mottle = context
            mottle.addFilter(.blur(radius: w * 0.12))
            for (x, y, r, o) in [(0.2, 0.75, 0.35, 0.16), (0.8, 0.2, 0.3, 0.1), (0.65, 0.7, 0.25, 0.12)] as [(CGFloat, CGFloat, CGFloat, Double)] {
                mottle.fill(Path(ellipseIn: CGRect(x: (x - r) * w, y: (y - r * 0.6) * h, width: 2 * r * w, height: 1.2 * r * h)), with: .color(Color(white: 0.55).opacity(o)))
            }

            let main = vein(p(-0.05, 0.32), p(0.3, 0.14), p(0.52, 0.7), p(1.05, 0.56), wobble: 0.022, seed: 1.3)
            let fork = vein(p(0.46, 0.48), p(0.58, 0.36), p(0.76, 0.26), p(1.02, 0.04), wobble: 0.014, seed: 4.2)
            let seam = vein(p(0.08, 1.04), p(0.36, 0.78), p(0.7, 0.92), p(1.05, 0.8), wobble: 0.012, seed: 2.6)
            let ink = Color(white: 0.4)

            // Each vein: a wide feathered halo, then a fine core.
            var halo = context
            halo.addFilter(.blur(radius: w * 0.035))
            halo.stroke(main, with: .color(ink.opacity(0.35)), lineWidth: w * 0.09)
            halo.stroke(fork, with: .color(ink.opacity(0.22)), lineWidth: w * 0.05)
            halo.stroke(seam, with: .color(ink.opacity(0.16)), lineWidth: w * 0.05)

            var core = context
            core.addFilter(.blur(radius: w * 0.006))
            core.stroke(main, with: .color(ink.opacity(0.55)), style: StrokeStyle(lineWidth: w * 0.018, lineCap: .round, lineJoin: .round))
            core.stroke(fork, with: .color(ink.opacity(0.4)), style: StrokeStyle(lineWidth: w * 0.009, lineCap: .round, lineJoin: .round))
            core.stroke(seam, with: .color(ink.opacity(0.3)), style: StrokeStyle(lineWidth: w * 0.008, lineCap: .round, lineJoin: .round))

            // Polish: a soft band of light across the top-left.
            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: .white.opacity(0.5), location: 0),
                        .init(color: .white.opacity(0), location: 0.5),
                    ]),
                    startPoint: .zero, endPoint: CGPoint(x: w * 0.7, y: h * 0.9)
                )
            )
        }
    }
}

/// A one-pixel light on the top edge and a shade on the bottom, as on a polished stone.
private struct PolishedEdge<S: InsettableShape>: View {
    let shape: S
    @Environment(\.displayScale) private var scale

    var body: some View {
        shape.strokeBorder(
            LinearGradient(colors: [.white.opacity(0.9), .white.opacity(0.1), .black.opacity(0.25)], startPoint: .top, endPoint: .bottom),
            lineWidth: 1 / max(scale, 1)
        )
    }
}

// MARK: Section label

/// The title of a field inside a section.
struct SectionLabel: View {
    let text: String
    var color: Color?

    init(_ text: String, color: Color? = nil) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(Typo.label)
            .foregroundStyle(color.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
            .lineLimit(1)
    }
}

// MARK: Badge

/// A count or short tag: outlined grey, or tinted when it carries a state.
struct Badge: View {
    let text: String
    var tint: Color?

    var body: some View {
        Text(text)
            .font(.geist(10.5, .medium).monospacedDigit())
            .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background((tint ?? .white).opacity(tint == nil ? 0.06 : 0.14), in: RoundedRectangle(cornerRadius: Ink.tagRadius))
            .contentTransition(.numericText())
    }
}

// MARK: Buttons

/// Three buttons, as in Geist: white primary (the one next step), outlined secondary,
/// red for destructive confirmations.
struct StageButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger }
    var kind: Kind = .secondary
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        StageButtonLabel(configuration: configuration, kind: kind, compact: compact)
    }

    private struct StageButtonLabel: View {
        let configuration: Configuration
        let kind: Kind
        let compact: Bool
        @Environment(\.isEnabled) private var isEnabled
        @ViewState private var hovering = false

        var body: some View {
            configuration.label
                .font(.geist(compact ? 11.5 : 12, .medium))
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .foregroundStyle(foreground)
                .padding(.horizontal, compact ? 8 : 10)
                .frame(height: compact ? 24 : 28)
                .background(background, in: RoundedRectangle(cornerRadius: Ink.controlRadius, style: .continuous))
                .overlay {
                    if kind == .primary {
                        // Polished stone: light from above, a lit top edge.
                        RoundedRectangle(cornerRadius: Ink.controlRadius, style: .continuous)
                            .fill(LinearGradient(colors: [.white.opacity(0.5), .clear, .black.opacity(0.08)], startPoint: .top, endPoint: .bottom))
                            .allowsHitTesting(false)
                        PixelStroke(radius: Ink.controlRadius, style: LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .top, endPoint: .center))
                    }
                    if kind == .secondary {
                        PixelStroke(radius: Ink.controlRadius, style: Ink.outline)
                    }
                }
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(RoundedRectangle(cornerRadius: Ink.controlRadius))
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
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
            case .primary: return Color(white: 0.88 - lift * 0.05)
            case .secondary: return Color.white.opacity(lift * 0.05)
            case .danger: return Ink.red.opacity(1 - lift * 0.1)
            }
        }
    }
}

extension ButtonStyle where Self == StageButtonStyle {
    static var primary: StageButtonStyle { StageButtonStyle(kind: .primary) }
    static var secondary: StageButtonStyle { StageButtonStyle(kind: .secondary) }
    static var danger: StageButtonStyle { StageButtonStyle(kind: .danger) }
    static func stage(_ kind: StageButtonStyle.Kind, compact: Bool = false) -> StageButtonStyle {
        StageButtonStyle(kind: kind, compact: compact)
    }
}

// MARK: Tab switch

/// A small outlined segmented control: the selected option on a raised fill.
struct TabSwitch<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let title: (Option) -> String

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option == selection
                Button { selection = option } label: {
                    Text(title(option))
                        .font(.geist(11.5, .medium))
                        .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .padding(.horizontal, 9)
                        .frame(height: 20)
                        .background(selected ? Ink.selected : .clear, in: RoundedRectangle(cornerRadius: Ink.tagRadius))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .overlay(PixelStroke(radius: Ink.controlRadius, style: Ink.outline))
        .animation(.easeOut(duration: 0.15), value: selection)
    }
}
