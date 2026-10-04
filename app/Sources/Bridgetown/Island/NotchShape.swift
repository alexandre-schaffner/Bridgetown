import SwiftUI

/// The notch, grown: a black shape hanging from the top edge of the screen. Its top corners
/// flare outward into the edge, as the hardware notch's do, and its bottom corners are
/// continuous curves rather than circular arcs. Both radii animate, so the shape morphs
/// as it opens instead of just scaling.
///
/// `rect` includes the shoulders: the body is `rect.width - 2 * shoulder` wide.
struct NotchShape: Shape {
    /// The outward flare where the shape meets the top edge.
    var shoulder: CGFloat
    /// The bottom corners.
    var corner: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(shoulder, corner) }
        set { (shoulder, corner) = (newValue.first, newValue.second) }
    }

    /// Handle length as a share of the radius: 0.55 draws a circle; longer handles ease the
    /// curvature in, like Apple's continuous corners.
    private static let ease: CGFloat = 0.64

    func path(in rect: CGRect) -> Path {
        let s = max(0, min(shoulder, rect.width / 4, rect.height / 2))
        let c = max(0, min(corner, (rect.width - 2 * s) / 2, rect.height - s))
        let k = Self.ease
        let left = rect.minX + s, right = rect.maxX - s
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addCurve(
            to: CGPoint(x: left, y: rect.minY + s),
            control1: CGPoint(x: rect.minX + s * k, y: rect.minY),
            control2: CGPoint(x: left, y: rect.minY + s * (1 - k))
        )
        p.addLine(to: CGPoint(x: left, y: rect.maxY - c))
        p.addCurve(
            to: CGPoint(x: left + c, y: rect.maxY),
            control1: CGPoint(x: left, y: rect.maxY - c * (1 - k)),
            control2: CGPoint(x: left + c * (1 - k), y: rect.maxY)
        )
        p.addLine(to: CGPoint(x: right - c, y: rect.maxY))
        p.addCurve(
            to: CGPoint(x: right, y: rect.maxY - c),
            control1: CGPoint(x: right - c * (1 - k), y: rect.maxY),
            control2: CGPoint(x: right, y: rect.maxY - c * (1 - k))
        )
        p.addLine(to: CGPoint(x: right, y: rect.minY + s))
        p.addCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY),
            control1: CGPoint(x: right, y: rect.minY + s * (1 - k)),
            control2: CGPoint(x: rect.maxX - s * k, y: rect.minY)
        )
        p.closeSubpath()
        return p
    }
}
