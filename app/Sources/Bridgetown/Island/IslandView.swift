import SwiftUI

/// The island: one black shape that hangs from the notch and morphs between resting,
/// banner and open. Content is laid out at its final size and revealed by the shape as it
/// grows (the shape clips it), with a blur-fade on top, so opening reads as the notch
/// unfolding rather than a window appearing.
struct IslandView: View {
    let model: IslandModel
    let open: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let layout = model.layout
        let shape = NotchShape(shoulder: layout.shoulder, corner: layout.corner)
        ZStack(alignment: .top) {
            content
        }
        .frame(width: layout.frameWidth, height: layout.height, alignment: .top)
        .clipShape(shape)
        .background {
            shape
                .fill(.black)
                .shadow(color: .black.opacity(layout.lifted ? 0.55 : 0), radius: 26, y: 14)
                .shadow(color: .black.opacity(layout.lifted ? 0.3 : 0), radius: 4, y: 2)
        }
        .overlay {
            // A lit edge down the sides and along the bottom, fading out toward the screen's
            // top edge so the shape still seems to come out of the notch.
            shape
                .stroke(
                    LinearGradient(colors: [.white.opacity(0), .white.opacity(0.07), .white.opacity(0.16)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 1
                )
                .opacity(layout.lifted ? 1 : 0)
                .allowsHitTesting(false)
        }
        .overlay {
            if model.presentation != .open {
                shape
                    .fill(.clear)
                    .contentShape(shape)
                    .onTapGesture(perform: open)
                    .accessibilityElement()
                    .accessibilityLabel(accessibilityLabel)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction(named: "Open Bridgetown", open)
            }
        }
        .opacity(layout.visible ? 1 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .font(.geist(12))
        .foregroundStyle(Ink.text, Ink.dim, Ink.faint)
        .environment(\.colorScheme, .dark)
    }

    @ViewBuilder
    private var content: some View {
        let notch = model.geometry.notch
        switch model.presentation {
        case .resting:
            GlanceWings(glance: model.glance, notch: notch, hovering: model.hovering)
                .transition(.reveal(reduceMotion: reduceMotion))
        case .banner:
            if let action = model.banner {
                BannerContent(action: action, notch: notch)
                    .transition(.reveal(reduceMotion: reduceMotion))
            }
        case .open:
            IslandOpenView(model: model)
                .transition(.reveal(reduceMotion: reduceMotion))
        }
    }

    private var accessibilityLabel: String {
        let glance = model.glance
        if model.presentation == .banner, let action = model.banner { return "Needs you: \(action.title)" }
        var parts = ["Bridgetown"]
        if glance.trouble { parts.append("not connected") }
        if glance.working > 0 { parts.append("\(glance.working) running") }
        if glance.waiting > 0 { parts.append("\(glance.waiting) \(glance.waiting == 1 ? "needs" : "need") you") }
        return parts.joined(separator: ", ")
    }
}

// MARK: Transitions

private struct Reveal: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content
            .opacity(active ? 0 : 1)
            .blur(radius: active ? 10 : 0)
            .scaleEffect(active ? 0.96 : 1, anchor: .top)
    }
}

private extension AnyTransition {
    /// In: a blur-fade that trails the shape a beat, so the outline leads and the content
    /// settles into it. Out: quick, before the shape closes over it. Under Reduce Motion,
    /// a short fade each way: nothing blurs or scales.
    static func reveal(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion {
            return .opacity.animation(Easing.quick)
        }
        return .asymmetric(
            insertion: .modifier(active: Reveal(active: true), identity: Reveal(active: false))
                .animation(.smooth(duration: 0.36).delay(0.07)),
            removal: .modifier(active: Reveal(active: true), identity: Reveal(active: false))
                .animation(.easeIn(duration: 0.12))
        )
    }
}

// MARK: Wings

/// Either side of the notch: the arch for the agents on the left, a count on the right.
struct GlanceWings: View {
    let glance: Glance
    let notch: CGSize
    let hovering: Bool

    var body: some View {
        let wing = IslandModel.wing
        HStack(spacing: 0) {
            ArchGlyph(working: glance.working > 0, dim: glance.trouble || glance.isEmpty)
                .frame(width: wing)
            Color.clear.frame(width: notch.width)
            trailing
                .frame(width: wing)
        }
        .frame(height: notch.height)
        .offset(y: hovering ? 1.5 : 0)
    }

    @ViewBuilder
    private var trailing: some View {
        if glance.waiting > 0 {
            Count(value: glance.waiting, color: Ink.amber, dot: Ink.amber, live: false)
        } else if glance.working > 0 {
            Count(value: glance.working, color: Ink.text, dot: Ink.blue, live: true)
        } else if glance.trouble {
            Circle().fill(Ink.red).frame(width: 6, height: 6)
        }
    }

    private struct Count: View {
        let value: Int
        let color: Color
        let dot: Color
        let live: Bool

        var body: some View {
            HStack(spacing: 4) {
                LiveDot(color: dot, live: live, size: 5)
                Text("\(value)")
                    .font(.geist(12.5, .semibold).monospacedDigit())
                    .foregroundStyle(color)
                    .contentTransition(.numericText(value: Double(value)))
            }
        }
    }
}

/// The arch mark. While agents run, light breathes behind it in Bridgetown's blue, as on
/// the app icon. Static under Reduce Motion.
private struct ArchGlyph: View {
    let working: Bool
    let dim: Bool
    @Environment(\.marksHoldStill) private var still

    var body: some View {
        let mark = ArchShape(joint: 1.1)
            .fill(dim ? Ink.faint : Ink.text)
            .frame(width: 14 * ArchMark.aspect, height: 14)
        if working && !still {
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                let swell = 0.5 - 0.5 * cos(phase * 2 * .pi)
                mark
                    .shadow(color: Ink.blue.opacity(0.35 + 0.55 * swell), radius: 3 + 4 * swell)
                    .shadow(color: Ink.blue.opacity(0.25 * swell), radius: 10)
            }
        } else {
            mark.shadow(color: Ink.blue.opacity(working ? 0.6 : 0), radius: 5)
        }
    }
}

// MARK: Banner

/// A new "Needs you", shown under the notch for a few seconds: what it is, and that it
/// is yours. Clicking opens the island.
private struct BannerContent: View {
    let action: Action
    let notch: CGSize

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: notch.height)
            HStack(spacing: 11) {
                Image(systemName: action.kind.symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Ink.amber)
                    .frame(width: 30, height: 30)
                    .background(Ink.amber.opacity(0.14), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("Needs you")
                        .font(.geist(10.5, .medium))
                        .foregroundStyle(Ink.amber)
                    Text(action.title)
                        .font(.geist(13, .semibold))
                        .tracking(-0.2)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .frame(height: IslandModel.bannerHeight)
        }
        .frame(width: IslandModel.bannerWidth)
    }
}
