import CoreGraphics
import SwiftUI

/// Bridgetown's arch, as on the app icon (scripts/app-icon.swift): a ring of stones whose
/// keystone stands proud, on two piers. Small marks cut only the joints that still read
/// at their size: either side of the keystone and at the springing.
enum ArchMark {
    /// Width over height of the arch's bounds.
    static let aspect: CGFloat = width / height

    // The icon's measures, in its 1024-unit canvas, around the centre of the ring.
    private static let outer: CGFloat = 258
    private static let inner: CGFloat = 138
    private static let pier: CGFloat = 214
    private static let keyRise: CGFloat = 26
    private static let keyDrop: CGFloat = 12
    /// The keystone's share of the half ring: a little wider than on the icon (one of
    /// nine there), so it still reads as a wedge at menu bar size.
    private static let keySpan: CGFloat = .pi / 7
    private static let width = 2 * outer
    private static let height = outer + keyRise + pier

    /// The arch fitted and centred in `rect`, top-left origin, `joint` points wide.
    /// Stones are separate subpaths with the same winding, so fill or stroke them as one.
    static func path(in rect: CGRect, joint: CGFloat) -> CGPath {
        let unit = min(rect.width / width, rect.height / height)
        let center = CGPoint(x: rect.midX, y: rect.midY - (height / 2 - outer - keyRise) * unit)
        let R = outer * unit, r = inner * unit
        let g = joint / 2

        let path = CGMutablePath()
        /// A sector of the ring between two angles, each side pulled half a joint inward.
        func ring(_ a0: CGFloat, _ a1: CGFloat, inner r: CGFloat, outer R: CGFloat, cut0: Bool = true, cut1: Bool = true) {
            let s0 = cut0 ? g : 0, s1 = cut1 ? g : 0
            /// The arc's ends at `radius`; where the joints would overlap (a small mark's
            /// keystone, near the opening) the sides meet in a point instead.
            func ends(_ radius: CGFloat) -> (CGFloat, CGFloat) {
                let from = a0 + asin(min(1, s0 / radius)), to = a1 - asin(min(1, s1 / radius))
                return from < to ? (from, to) : ((a0 + a1) / 2, (a0 + a1) / 2)
            }
            let (o0, o1) = ends(R), (i0, i1) = ends(r)
            path.move(to: CGPoint(x: center.x + R * cos(o0), y: center.y + R * sin(o0)))
            path.addArc(center: center, radius: R, startAngle: o0, endAngle: o1, clockwise: false)
            path.addArc(center: center, radius: r, startAngle: i1, endAngle: i0, clockwise: true)
            path.closeSubpath()
        }
        let crown = 1.5 * CGFloat.pi
        ring(.pi, crown - keySpan / 2, inner: r, outer: R, cut0: false)
        ring(crown - keySpan / 2, crown + keySpan / 2, inner: r - keyDrop * unit, outer: R + keyRise * unit)
        ring(crown + keySpan / 2, 2 * .pi, inner: r, outer: R, cut1: false)
        // Piers, below a joint at the springing. Drawn clockwise, like the ring.
        for x in [center.x - R, center.x + r] {
            let block = CGRect(x: x, y: center.y + g, width: R - r, height: pier * unit - g)
            path.move(to: CGPoint(x: block.minX, y: block.minY))
            path.addLine(to: CGPoint(x: block.maxX, y: block.minY))
            path.addLine(to: CGPoint(x: block.maxX, y: block.maxY))
            path.addLine(to: CGPoint(x: block.minX, y: block.maxY))
            path.closeSubpath()
        }
        return path
    }
}

struct ArchShape: Shape {
    /// The joints between stones, in points.
    var joint: CGFloat = 1

    func path(in rect: CGRect) -> Path { Path(ArchMark.path(in: rect, joint: joint)) }
}
