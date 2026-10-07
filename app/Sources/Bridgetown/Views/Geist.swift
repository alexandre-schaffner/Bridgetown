import CoreText
import SwiftUI

/// Geist, bundled under `app/Fonts` and registered at launch. Until it is (or if it
/// can't be), `Font.custom` falls back to the system font at the same size.
enum Geist {
    /// Registers from the bytes, not the URLs: a URL-registered face is read lazily, so
    /// once the bundle is replaced or deleted under a running app (a rebuild, a removed
    /// worktree) any face not yet drawn renders as missing-glyph boxes.
    static func register() {
        for dir in fontDirectories {
            guard let urls = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { continue }
            let fonts = urls.filter { $0.pathExtension == "ttf" }.compactMap { try? Data(contentsOf: $0) }
            guard !fonts.isEmpty else { continue }
            for data in fonts {
                guard let provider = CGDataProvider(data: data as CFData), let font = CGFont(provider) else { continue }
                CTFontManagerRegisterGraphicsFont(font, nil)
            }
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
