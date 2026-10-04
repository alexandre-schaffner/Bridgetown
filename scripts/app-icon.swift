// Draws Bridgetown's app icon: a stone arch of white marble standing on polished black
// stone, lit from behind. Paths and generated noise, no assets, so it renders the same
// every time.
//
//   swift scripts/app-icon.swift <out.icns> [preview.png]
//
// The tile follows the macOS icon grid (an 824pt continuous-corner square in a 1024pt
// canvas, with a drop shadow), so it sits with the system's own icons.

import AppKit
import CoreGraphics
import Foundation

let canvas: CGFloat = 1024
let tileRect = CGRect(x: 100, y: 100, width: 824, height: 824)
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func gray(_ w: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(srgbRed: w, green: w, blue: w, alpha: a) }
/// The light behind the arch: white, cooled a little toward Bridgetown's blue.
func glow(_ a: CGFloat) -> CGColor { CGColor(srgbRed: 0.62, green: 0.8, blue: 1, alpha: a) }

// MARK: Geometry

/// A rounded rect with continuous corners (curvature eases in, as on Apple's icons),
/// from the widely used reconstruction of UIKit's own path. Top-left origin.
func continuousRect(_ rect: CGRect, radius r: CGFloat) -> CGPath {
    let path = CGMutablePath()
    // One corner in local units of r, from the top edge to the right edge.
    let corner: [(CGPoint, CGPoint, CGPoint)] = [
        (CGPoint(x: 1.08849323, y: 0), CGPoint(x: 0.86840689, y: 0), CGPoint(x: 0.63149399, y: 0.07491100)),
        (CGPoint(x: 0.37282392, y: 0.16905899), CGPoint(x: 0.16905899, y: 0.37282392), CGPoint(x: 0.07491100, y: 0.63149399)),
        (CGPoint(x: 0, y: 0.86840689), CGPoint(x: 0, y: 1.08849323), CGPoint(x: 0, y: 1.52866471)),
    ]
    // Each corner maps (inset from its edge along, inset from the other edge) to canvas points.
    let corners: [(CGPoint) -> CGPoint] = [
        { CGPoint(x: rect.maxX - $0.x * r, y: rect.minY + $0.y * r) }, // top right
        { CGPoint(x: rect.maxX - $0.y * r, y: rect.maxY - $0.x * r) }, // bottom right
        { CGPoint(x: rect.minX + $0.x * r, y: rect.maxY - $0.y * r) }, // bottom left
        { CGPoint(x: rect.minX + $0.y * r, y: rect.minY + $0.x * r) }, // top left
    ]
    path.move(to: CGPoint(x: rect.minX + 1.52866483 * r, y: rect.minY))
    for map in corners {
        path.addLine(to: map(CGPoint(x: 1.52866471, y: 0)))
        for (c1, c2, end) in corner { path.addCurve(to: map(end), control1: map(c1), control2: map(c2)) }
    }
    path.closeSubpath()
    return path
}

/// A cubic from a to b that wanders: sampled, then nudged sideways by a fixed sum of
/// sines, so a vein is irregular but the same on every render (as in `BrandMark`).
func vein(_ a: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ b: CGPoint, wobble: CGFloat, seed: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let steps = 160
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps), u = 1 - t
        let x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x
        let y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
        let n = sin(t * 11 + seed) * 0.6 + sin(t * 27 + seed * 2.1) * 0.3 + sin(t * 61 + seed * 3.7) * 0.1
        let pt = CGPoint(x: x + n * wobble * 0.4, y: y + n * wobble)
        if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
    }
    return path
}

/// The arch, stone by stone: nine voussoirs over the opening (the middle one the
/// keystone, standing proud of the rest) on two piers of two blocks each. Joints are a
/// constant width, like mortar. Top-left origin.
struct Arch {
    let center = CGPoint(x: 512, y: 486)
    let inner: CGFloat = 138
    let outer: CGFloat = 258
    let pier: CGFloat = 214
    let joint: CGFloat = 8
    let voussoirs = 9

    var ground: CGFloat { center.y + pier }
    var crown: CGFloat { center.y - outer - 26 }

    var stones: [CGPath] {
        var paths: [CGPath] = []
        let span = CGFloat.pi / CGFloat(voussoirs)
        for i in 0..<voussoirs {
            // Angles run from the left springing (pi) over the crown (3pi/2) to the right (2pi).
            let a0 = .pi + CGFloat(i) * span, a1 = a0 + span
            let key = i == voussoirs / 2
            paths.append(wedge(from: a0, to: a1, inner: key ? inner - 12 : inner, outer: key ? outer + 26 : outer))
        }
        let blockHeight = (pier - joint / 2 - joint) / 2
        for x in [center.x - outer, center.x + inner] {
            for row in 0..<2 {
                let y = center.y + joint / 2 + CGFloat(row) * (blockHeight + joint)
                paths.append(CGPath(rect: CGRect(x: x, y: y, width: outer - inner, height: blockHeight), transform: nil))
            }
        }
        return paths
    }

    var silhouette: CGPath {
        let path = CGMutablePath()
        stones.forEach { path.addPath($0) }
        return path
    }

    /// The underside of the opening: where the light behind catches the stone.
    var intrados: CGPath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: center.x - inner, y: ground))
        path.addLine(to: CGPoint(x: center.x - inner, y: center.y))
        path.addArc(center: center, radius: inner, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
        path.addLine(to: CGPoint(x: center.x + inner, y: ground))
        return path
    }

    private func wedge(from a0: CGFloat, to a1: CGFloat, inner r: CGFloat, outer R: CGFloat) -> CGPath {
        // Points on a circle at a0 + asin(g / radius) lie g off the radial line at a0, so
        // each side of the wedge is that radial line pushed half a joint inward.
        let g = joint / 2
        let dR = asin(g / R), dr = asin(g / r)
        let path = CGMutablePath()
        path.addArc(center: center, radius: R, startAngle: a0 + dR, endAngle: a1 - dR, clockwise: false)
        path.addArc(center: center, radius: r, startAngle: a1 - dr, endAngle: a0 + dr, clockwise: true)
        path.closeSubpath()
        return path
    }
}

// MARK: Noise

/// Grain and soft mottling as white-with-alpha, deterministic (xorshift64*).
func stoneNoise(side: Int, grain: Double, cloud: Double, seed: UInt64) -> CGImage {
    var state = seed
    func next() -> Double {
        state ^= state >> 12
        state ^= state << 25
        state ^= state >> 27
        return Double((state &* 0x2545_F491_4F6C_DD1D) >> 11) / Double(1 << 53)
    }
    let cells = 6
    var grid = [Double](repeating: 0, count: cells * cells)
    for i in grid.indices { grid[i] = next() }
    func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
    func mottle(_ u: Double, _ v: Double, _ f: Double) -> Double {
        let x = u * Double(cells) * f, y = v * Double(cells) * f
        let x0 = Int(x), y0 = Int(y)
        let fx = smooth(x - floor(x)), fy = smooth(y - floor(y))
        func at(_ i: Int, _ j: Int) -> Double { grid[(j % cells) * cells + i % cells] }
        let top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
        let bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
        return top * (1 - fy) + bottom * fy
    }
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    for y in 0..<side {
        for x in 0..<side {
            let u = Double(x) / Double(side), v = Double(y) / Double(side)
            let c = mottle(u, v, 1) * 0.6 + mottle(u, v, 2) * 0.4
            let a = UInt8(min(1, c * cloud + next() * grain) * 255)
            let i = (y * side + x) * 4
            pixels[i] = a; pixels[i + 1] = a; pixels[i + 2] = a; pixels[i + 3] = a
        }
    }
    return CGImage(
        width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
        space: srgb, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: CGDataProvider(data: Data(pixels) as CFData)!, decode: nil, shouldInterpolate: true, intent: .defaultIntent
    )!
}

let blackGrain = stoneNoise(side: 1024, grain: 0.03, cloud: 0.045, seed: 0x9E37_79B9_7F4A_7C15)
let whiteGrain = stoneNoise(side: 1024, grain: 0.06, cloud: 0.05, seed: 0xD1B5_4A32_D192_ED03)

// MARK: Drawing

func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
    CGGradient(colorsSpace: srgb, colors: stops.map(\.1) as CFArray, locations: stops.map(\.0))!
}

func linear(_ ctx: CGContext, _ stops: [(CGFloat, CGColor)], from a: CGPoint, to b: CGPoint) {
    ctx.drawLinearGradient(gradient(stops), start: a, end: b, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

/// A radial gradient, optionally squashed vertically (an ellipse of light).
func radial(_ ctx: CGContext, _ stops: [(CGFloat, CGColor)], at c: CGPoint, radius: CGFloat, squash: CGFloat = 1) {
    ctx.saveGState()
    ctx.translateBy(x: c.x, y: c.y)
    ctx.scaleBy(x: 1, y: squash)
    ctx.drawRadialGradient(gradient(stops), startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: radius, options: [])
    ctx.restoreGState()
}

/// A soft stroke: the path is drawn far off-canvas and only its blurred shadow lands in place.
func softStroke(_ ctx: CGContext, _ path: CGPath, color: CGColor, width: CGFloat, blur: CGFloat, scale: CGFloat) {
    ctx.saveGState()
    let off: CGFloat = 4000
    ctx.setShadow(offset: CGSize(width: off * scale, height: 0), blur: blur * scale, color: color)
    ctx.translateBy(x: -off, y: 0)
    ctx.addPath(path)
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.setStrokeColor(gray(0, 1))
    ctx.strokePath()
    ctx.restoreGState()
}

func drawIcon(_ ctx: CGContext, scale: CGFloat) {
    // Top-left origin, in 1024 units.
    ctx.translateBy(x: 0, y: canvas * scale)
    ctx.scaleBy(x: scale, y: -scale)
    ctx.interpolationQuality = .high
    let tile = continuousRect(tileRect, radius: 185.4)
    let arch = Arch()
    let horizon = arch.ground
    let fine = scale >= 0.12 // below ~128px grain and veins are only noise

    // The tile's shadow, as on the system's own icons.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * scale), blur: 22 * scale, color: gray(0, 0.4))
    ctx.addPath(tile)
    ctx.setFillColor(gray(0.04))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(tile)
    ctx.clip()

    // Behind: black, with light rising from the horizon through the arch.
    linear(ctx, [(0, gray(0.075)), (1, gray(0.015))], from: CGPoint(x: 0, y: 100), to: CGPoint(x: 0, y: horizon))
    radial(ctx, [(0, glow(0.5)), (0.25, glow(0.16)), (0.6, glow(0.04)), (1, glow(0))], at: CGPoint(x: 512, y: horizon), radius: 560, squash: 0.8)
    radial(ctx, [(0, gray(1, 0.9)), (0.25, glow(0.45)), (1, glow(0))], at: CGPoint(x: 512, y: horizon), radius: 200, squash: 0.5)
    // A halo just behind the ring of stones: it shows through the joints and rims the crown.
    let ring = CGMutablePath()
    ring.addArc(center: arch.center, radius: (arch.inner + arch.outer) / 2, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
    softStroke(ctx, ring, color: glow(0.26), width: arch.outer - arch.inner, blur: 70, scale: scale)

    // The floor: polished black stone, reflecting the light and the arch.
    let floor = CGRect(x: 0, y: horizon, width: canvas, height: canvas - horizon)
    ctx.saveGState()
    ctx.clip(to: floor)
    ctx.setFillColor(gray(0.02))
    ctx.fill(floor)
    radial(ctx, [(0, glow(0.35)), (0.4, glow(0.08)), (1, glow(0))], at: CGPoint(x: 512, y: horizon), radius: 420, squash: 0.32)
    ctx.saveGState()
    ctx.translateBy(x: 0, y: 2 * horizon)
    ctx.scaleBy(x: 1, y: -1)
    ctx.setAlpha(0.16)
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    drawArch(ctx, arch, fine: false, scale: scale)
    ctx.endTransparencyLayer()
    ctx.restoreGState()
    // Fade the reflection into the floor.
    linear(ctx, [(0, gray(0.02, 0)), (0.45, gray(0.02, 0.9)), (1, gray(0.02, 1))], from: CGPoint(x: 0, y: horizon), to: CGPoint(x: 0, y: 924))
    ctx.restoreGState()

    // The floor's front edge catching the light, brightest under the arch.
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 100, y: horizon - 1, width: 824, height: 2.5))
    linear(ctx, [(0, gray(1, 0)), (0.5, gray(1, 0.75)), (1, gray(1, 0))], from: CGPoint(x: 140, y: 0), to: CGPoint(x: 884, y: 0))
    ctx.restoreGState()

    if fine {
        ctx.setBlendMode(.screen)
        ctx.draw(blackGrain, in: tileRect)
        ctx.setBlendMode(.normal)
    }

    // Contact shadows where the piers meet the floor.
    for x in [arch.center.x - (arch.outer + arch.inner) / 2, arch.center.x + (arch.outer + arch.inner) / 2] {
        radial(ctx, [(0, gray(0, 0.7)), (1, gray(0, 0))], at: CGPoint(x: x, y: horizon + 2), radius: 110, squash: 0.12)
    }

    drawArch(ctx, arch, fine: fine, scale: scale)

    // Polish over the whole tile: a soft sheen from the top left.
    ctx.setBlendMode(.screen)
    radial(ctx, [(0, gray(1, 0.07)), (1, gray(1, 0))], at: CGPoint(x: 280, y: 120), radius: 560)
    ctx.setBlendMode(.normal)
    ctx.restoreGState()

    // The tile's edge: lit along the top, faint elsewhere.
    ctx.saveGState()
    ctx.addPath(tile)
    ctx.clip()
    ctx.addPath(tile)
    ctx.setLineWidth(max(2.5, 1.6 / scale) * 2)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    linear(ctx, [(0, gray(1, 0.34)), (0.2, gray(1, 0.07)), (0.85, gray(1, 0.03)), (1, gray(1, 0.08))], from: CGPoint(x: 0, y: 100), to: CGPoint(x: 0, y: 924))
    ctx.restoreGState()
}

func drawArch(_ ctx: CGContext, _ arch: Arch, fine: Bool, scale: CGFloat) {
    let stones = arch.stones
    let top = arch.crown, bottom = arch.ground

    // Faces: one block of white marble, cut into stones, so the veins run on across joints.
    ctx.saveGState()
    ctx.addPath(arch.silhouette)
    ctx.clip()
    linear(ctx, [(0, gray(0.98)), (0.5, gray(0.86)), (1, gray(0.6))], from: CGPoint(x: 0, y: top), to: CGPoint(x: 0, y: bottom))
    if fine {
        ctx.saveGState()
        ctx.setBlendMode(.multiply)
        ctx.setAlpha(0.5)
        ctx.draw(whiteGrain, in: CGRect(x: 0, y: 0, width: canvas, height: canvas))
        ctx.restoreGState()
        // Soft grey clouds in the stone.
        ctx.setBlendMode(.multiply)
        radial(ctx, [(0, gray(0.86)), (1, gray(1))], at: CGPoint(x: 320, y: 560), radius: 170)
        radial(ctx, [(0, gray(0.9)), (1, gray(1))], at: CGPoint(x: 660, y: 300), radius: 190)
        ctx.setBlendMode(.normal)
        let main = vein(CGPoint(x: 200, y: 380), CGPoint(x: 380, y: 250), CGPoint(x: 560, y: 520), CGPoint(x: 830, y: 410), wobble: 9, seed: 0.7)
        let fork = vein(CGPoint(x: 470, y: 360), CGPoint(x: 560, y: 290), CGPoint(x: 640, y: 260), CGPoint(x: 780, y: 180), wobble: 6, seed: 3.1)
        let low = vein(CGPoint(x: 230, y: 700), CGPoint(x: 290, y: 620), CGPoint(x: 320, y: 560), CGPoint(x: 400, y: 500), wobble: 5, seed: 5.5)
        let right = vein(CGPoint(x: 640, y: 720), CGPoint(x: 690, y: 640), CGPoint(x: 720, y: 560), CGPoint(x: 800, y: 520), wobble: 4, seed: 1.9)
        softStroke(ctx, main, color: gray(0.45, 0.28), width: 34, blur: 14, scale: scale)
        softStroke(ctx, main, color: gray(0.36, 0.5), width: 3, blur: 1.4, scale: scale)
        for v in [fork, low, right] {
            softStroke(ctx, v, color: gray(0.45, 0.16), width: 16, blur: 10, scale: scale)
            softStroke(ctx, v, color: gray(0.38, 0.32), width: 1.6, blur: 1, scale: scale)
        }
    }
    // Polished: a sheen across the upper left.
    ctx.setBlendMode(.screen)
    linear(ctx, [(0, gray(1, 0.4)), (0.42, gray(1, 0)), (1, gray(1, 0))], from: CGPoint(x: 260, y: 230), to: CGPoint(x: 600, y: 680))
    ctx.setBlendMode(.normal)
    // Light from behind wraps the inner edges of the opening.
    softStroke(ctx, arch.intrados, color: glow(0.9), width: 10, blur: 16, scale: scale)
    ctx.restoreGState()

    // Each stone as a volume: a chamfer catching the light along its top, shade gathering
    // along its bottom, a little darker toward the lower right.
    for stone in stones {
        let box = stone.boundingBox
        ctx.saveGState()
        ctx.addPath(stone)
        ctx.clip()
        ctx.setBlendMode(.multiply)
        linear(ctx, [(0, gray(1)), (1, gray(0.9))], from: CGPoint(x: box.minX, y: box.minY), to: CGPoint(x: box.maxX, y: box.maxY))
        ctx.setBlendMode(.normal)
        ctx.restoreGState()
        innerShadow(ctx, stone, offset: CGSize(width: 0, height: -5), blur: 6, color: gray(0, 0.32), scale: scale)
        innerShadow(ctx, stone, offset: CGSize(width: 1, height: 3), blur: 3, color: gray(1, 1), scale: scale)
    }
}

/// A shadow cast inward from the shape's edges: the outside is filled, offset, and only
/// its shadow falls inside the clip. Offset in top-left units (positive y is down).
func innerShadow(_ ctx: CGContext, _ path: CGPath, offset: CGSize, blur: CGFloat, color: CGColor, scale: CGFloat) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.setShadow(offset: CGSize(width: offset.width * scale, height: -offset.height * scale), blur: blur * scale, color: color)
    ctx.addRect(path.boundingBox.insetBy(dx: -200, dy: -200))
    ctx.addPath(path)
    ctx.setFillColor(gray(0))
    ctx.fillPath(using: .evenOdd)
    ctx.restoreGState()
}

// MARK: Output

func render(_ px: Int) -> CGImage {
    let ctx = CGContext(
        data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    drawIcon(ctx, scale: CGFloat(px) / canvas)
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    try! NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: url)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: swift scripts/app-icon.swift <out.icns> [preview.png]\n".data(using: .utf8)!)
    exit(64)
}
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon-\(getpid()).iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

var rendered: [Int: CGImage] = [:]
for points in [16, 32, 128, 256, 512] {
    for factor in [1, 2] {
        let px = points * factor
        let image = rendered[px] ?? render(px)
        rendered[px] = image
        writePNG(image, to: iconset.appendingPathComponent("icon_\(points)x\(points)\(factor == 2 ? "@2x" : "").png"))
    }
}
if args.count >= 3 { writePNG(rendered[1024]!, to: URL(fileURLWithPath: args[2])) }

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", args[1]]
try! iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
exit(iconutil.terminationStatus)
