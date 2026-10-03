import Foundation

enum Mrkdwn {
    /// Slack mrkdwn as plain text: `<url|label>` → label, `<#C…|name>` → #name,
    /// `<!here>` → @here, `<url>` → url, and HTML entities decoded. A `<` with no
    /// closing `>` is kept as written.
    static func plain(_ s: String) -> String {
        var out = ""
        var rest = Substring(s)
        while let open = rest.firstIndex(of: "<"), let close = rest[open...].firstIndex(of: ">") {
            out += rest[..<open]
            out += token(rest[rest.index(after: open)..<close])
            rest = rest[rest.index(after: close)...]
        }
        out += rest
        return out
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func token(_ t: Substring) -> String {
        let parts = t.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        let target = parts.first.map(String.init) ?? ""
        let label = parts.count > 1 ? String(parts[1]) : nil
        if target.hasPrefix("#") { return prefixed("#", label ?? String(target.dropFirst())) }
        if target.hasPrefix("@") { return prefixed("@", label ?? String(target.dropFirst())) }
        if target.hasPrefix("!") {
            let name = target.dropFirst().split(separator: "^").first.map(String.init) ?? ""
            return prefixed("@", label ?? name)
        }
        return label ?? target
    }

    /// Slack labels often carry their sigil already (`<!subteam^S0|@dev-product>`); never print it twice.
    private static func prefixed(_ sigil: String, _ name: String) -> String {
        name.hasPrefix(sigil) ? name : sigil + name
    }

    /// Inline markdown only (`code`, **bold**), so agent prose reads naturally.
    static func inlineMarkdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
