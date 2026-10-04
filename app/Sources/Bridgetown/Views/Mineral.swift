import CoreGraphics
import SwiftUI

// The mineral layer: dark stone under the panels and the stage, felt more than seen.
// One texture, generated once in code: a pixel-fine grain, soft mottling and rare
// crystal flecks, all white at a few percent alpha, tileable so it repeats without a
// seam. It sits behind content only; text, data and status colours stay flat.

enum Stone {
    /// Texels per side. Drawn at the display scale, so on Retina one texel is one pixel.
    private static let side = 256

    /// White with alpha: lay it over a dark fill to turn the fill into stone.
    static let texture: CGImage? = make()

    private static func make() -> CGImage? {
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> Double {
            // xorshift64*: deterministic, so the stone is the same on every launch.
            state ^= state >> 12
            state ^= state << 25
            state ^= state >> 27
            return Double((state &* 0x2545_F491_4F6C_DD1D) >> 11) / Double(1 << 53)
        }

        // Low-frequency value noise on a wrapping grid: the mottling.
        let cells = 8
        var grid = [Double](repeating: 0, count: cells * cells)
        for i in grid.indices { grid[i] = next() }
        func lattice(_ x: Int, _ y: Int) -> Double { grid[((y % cells + cells) % cells) * cells + (x % cells + cells) % cells] }
        func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
        func mottle(_ u: Double, _ v: Double) -> Double {
            let x = u * Double(cells), y = v * Double(cells)
            let x0 = Int(x.rounded(.down)), y0 = Int(y.rounded(.down))
            let fx = smooth(x - Double(x0)), fy = smooth(y - Double(y0))
            let top = lattice(x0, y0) * (1 - fx) + lattice(x0 + 1, y0) * fx
            let bottom = lattice(x0, y0 + 1) * (1 - fx) + lattice(x0 + 1, y0 + 1) * fx
            return top * (1 - fy) + bottom * fy
        }

        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        for y in 0..<side {
            for x in 0..<side {
                let u = Double(x) / Double(side), v = Double(y) / Double(side)
                let cloud = mottle(u, v) * 0.65 + mottle(u * 2, v * 2) * 0.35
                let grain = next()
                let fleck = next() < 0.006 ? 0.5 + next() * 0.5 : 0
                let alpha = cloud * 0.03 + grain * 0.022 + fleck * 0.09
                let a = UInt8(min(255, alpha * 255))
                let i = (y * side + x) * 4
                // Premultiplied white.
                pixels[i] = a
                pixels[i + 1] = a
                pixels[i + 2] = a
                pixels[i + 3] = a
            }
        }
        let data = Data(pixels) as CFData
        guard let provider = CGDataProvider(data: data) else { return nil }
        return CGImage(
            width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )
    }
}

/// A dark fill turned to stone: the fill, then the stone texture tiled at pixel scale.
struct StoneFill: View {
    var base: Color = Ink.surface
    /// How much stone shows: 1 for panels, less for the stage.
    var strength: Double = 1
    @Environment(\.displayScale) private var scale

    var body: some View {
        ZStack {
            base
            if let texture = Stone.texture {
                Rectangle()
                    .fill(ImagePaint(image: Image(decorative: texture, scale: scale), scale: 1))
                    .opacity(strength)
            }
        }
        .allowsHitTesting(false)
    }
}
