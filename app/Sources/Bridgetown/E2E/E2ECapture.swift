#if DEBUG
import AppKit

/// Pixels: a surface rendered at 2x without being on screen, the crops an issue points
/// at, and the difference from a baseline. Works without Screen Recording permission:
/// views draw themselves (`cacheDisplay`), nothing reads the screen.
@MainActor
enum E2ECapture {
    nonisolated static let scale: CGFloat = 2

    /// `view` at 2x, drawn over `backdrop`, which paints the bounds in the bitmap's own
    /// coordinates (origin at the bottom left) under the view's appearance.
    static func render(_ view: NSView, appearance: NSAppearance?, backdrop: (CGRect) -> Void) -> NSBitmapImageRep? {
        let bounds = view.bounds
        guard bounds.width >= 1, bounds.height >= 1, let content = bitmap(bounds.size), let output = bitmap(bounds.size) else { return nil }
        view.cacheDisplay(in: bounds, to: content)
        draw(into: output) {
            (appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
                backdrop(CGRect(origin: .zero, size: bounds.size))
            }
            content.draw(in: CGRect(origin: .zero, size: bounds.size), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        return output
    }

    /// Spinners never hold still: their frames are painted over before frames compare.
    static func masked(_ image: NSBitmapImageRep, _ masks: [CGRect]) -> Data {
        guard !masks.isEmpty, let copy = image.copy() as? NSBitmapImageRep else { return pixels(image) }
        draw(into: copy) {
            NSColor.magenta.setFill()
            for mask in masks { flipped(mask, in: copy.size).insetBy(dx: -1, dy: -1).fill() }
        }
        return pixels(copy)
    }

    static func pixels(_ image: NSBitmapImageRep) -> Data {
        guard let data = image.bitmapData else { return Data() }
        return Data(bytes: data, count: image.bytesPerRow * image.pixelsHigh)
    }

    /// Fewer than three colours is a blank shot: one fill, maybe a line.
    static func distinctColors(_ image: NSBitmapImageRep, atLeast wanted: Int = 3) -> Int {
        guard let data = image.bitmapData else { return 0 }
        var seen = Set<UInt32>()
        let step = max(1, image.pixelsWide * image.pixelsHigh / 40_000)
        var index = 0
        while index < image.pixelsWide * image.pixelsHigh, seen.count < wanted {
            let x = index % image.pixelsWide, y = index / image.pixelsWide
            let p = data + y * image.bytesPerRow + x * image.samplesPerPixel
            seen.insert(UInt32(p[0]) << 24 | UInt32(p[1]) << 16 | UInt32(p[2]) << 8 | UInt32(p[3]))
            index += step
        }
        return seen.count
    }

    /// The region around `frames` (24pt of padding), each outlined in red.
    static func crop(_ image: NSBitmapImageRep, around frames: [CGRect]) -> NSBitmapImageRep? {
        let size = image.size
        let union = frames.reduce(CGRect.null) { $0.union($1) }
        guard !union.isNull else { return nil }
        let region = union.insetBy(dx: -24, dy: -24).intersection(CGRect(origin: .zero, size: size)).integral
        guard region.width >= 1, region.height >= 1, let output = bitmap(region.size) else { return nil }
        draw(into: output) {
            image.draw(
                in: CGRect(origin: .zero, size: region.size),
                from: flipped(region, in: size), operation: .copy, fraction: 1, respectFlipped: true, hints: nil
            )
            NSColor.systemRed.setStroke()
            for frame in frames {
                let path = NSBezierPath(rect: flipped(frame.offsetBy(dx: -region.minX, dy: -region.minY), in: region.size).insetBy(dx: -1.5, dy: -1.5))
                path.lineWidth = 1.5
                path.stroke()
            }
        }
        return output
    }

    struct Difference {
        var changedPixels: Int
        /// In points, from the top-left.
        var bbox: CGRect
        var image: NSBitmapImageRep
    }

    /// Where `image` differs from `baseline`: changed pixels in red over a dimmed copy.
    /// Nil when they are the same, or not the same size (a size change is reported as such).
    static func difference(_ image: NSBitmapImageRep, from baseline: NSBitmapImageRep) -> Difference? {
        guard image.pixelsWide == baseline.pixelsWide, image.pixelsHigh == baseline.pixelsHigh,
              let a = image.bitmapData, let b = baseline.bitmapData
        else { return nil }
        let rowBytes = image.pixelsWide * image.samplesPerPixel
        // Most rows match; comparing them whole keeps a debug build quick.
        let rows = (0..<image.pixelsHigh).filter { memcmp(a + $0 * image.bytesPerRow, b + $0 * baseline.bytesPerRow, rowBytes) != 0 }
        guard !rows.isEmpty, let output = bitmap(image.size) else { return nil }
        draw(into: output) {
            NSColor.black.setFill()
            CGRect(origin: .zero, size: image.size).fill()
            image.draw(in: CGRect(origin: .zero, size: image.size), from: .zero, operation: .sourceOver, fraction: 0.33, respectFlipped: true, hints: nil)
        }
        guard let out = output.bitmapData else { return nil }
        var changed = 0
        var minX = Int.max, maxX = -1
        for y in rows {
            for x in 0..<image.pixelsWide {
                let pa = a + y * image.bytesPerRow + x * image.samplesPerPixel
                let pb = b + y * baseline.bytesPerRow + x * baseline.samplesPerPixel
                guard pa[0] != pb[0] || pa[1] != pb[1] || pa[2] != pb[2] || pa[3] != pb[3] else { continue }
                changed += 1
                minX = min(minX, x)
                maxX = max(maxX, x)
                let po = out + y * output.bytesPerRow + x * output.samplesPerPixel
                po[0] = 255; po[1] = 0; po[2] = 0; po[3] = 255
            }
        }
        let minY = rows.first ?? 0, maxY = rows.last ?? 0
        let bbox = CGRect(x: CGFloat(minX) / scale, y: CGFloat(minY) / scale, width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale)
        return Difference(changedPixels: changed, bbox: bbox, image: output)
    }

    static func write(_ image: NSBitmapImageRep, to url: URL) throws {
        guard let png = image.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        try png.write(to: url)
    }

    static func read(_ url: URL) -> NSBitmapImageRep? {
        guard let data = try? Data(contentsOf: url), let image = NSBitmapImageRep(data: data) else { return nil }
        // Same layout as ours, so pixels compare byte for byte.
        guard let normal = bitmap(image.size) else { return nil }
        draw(into: normal) { image.draw(in: CGRect(origin: .zero, size: image.size)) }
        return normal
    }

    // MARK: Plumbing

    private static func bitmap(_ size: CGSize) -> NSBitmapImageRep? {
        let image = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int((size.width * scale).rounded()), pixelsHigh: Int((size.height * scale).rounded()),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )
        image?.size = size
        return image
    }

    private static func draw(into image: NSBitmapImageRep, _ body: () -> Void) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
        body()
        NSGraphicsContext.restoreGraphicsState()
    }

    /// A top-left-origin rect in a bottom-left-origin bitmap of `size`.
    private static func flipped(_ rect: CGRect, in size: CGSize) -> CGRect {
        CGRect(x: rect.minX, y: size.height - rect.maxY, width: rect.width, height: rect.height)
    }
}
#endif
