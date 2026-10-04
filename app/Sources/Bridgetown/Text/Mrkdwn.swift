import Foundation

enum Mrkdwn {
    /// Slack mrkdwn as Markdown, for `Markdown.blocks`: `*bold*` → `**bold**`, `_italic_` →
    /// `*italic*`, `~strike~` → `~~strike~~`, ```` ``` ```` fences on their own lines,
    /// `<url|label>` → `[label](url)`, `<#C…|name>` → #name, `<!here>` → @here, and a
    /// leading `&gt;` → a quote. Entities are left for the Markdown parser to decode, except
    /// inside code, which it reads verbatim. A `<` with no closing `>` is kept as written.
    static func markdown(_ s: String) -> String {
        let parts = s.components(separatedBy: "```")
        var out = ""
        for (index, part) in parts.enumerated() {
            let isCode = index % 2 == 1
            if isCode && index < parts.count - 1 {
                out += "\n```\n" + decoded(trimmingOneNewline(part)) + "\n```\n"
            } else {
                // An unclosed fence is text, with its backticks escaped so they stay literal.
                out += (isCode ? "\\`\\`\\`" : "") + text(part)
            }
        }
        return out
    }

    /// Text between fences: inline code kept (decoded), everything else translated.
    private static func text(_ s: String) -> String {
        let parts = s.components(separatedBy: "`")
        var out = ""
        for (index, part) in parts.enumerated() {
            if index % 2 == 1 && index < parts.count - 1 {
                out += "`" + decoded(part) + "`"
            } else {
                out += (index % 2 == 1 ? "\\`" : "") + prose(part)
            }
        }
        return out
    }

    /// Tokens are swapped for private-use placeholders while emphasis is rewritten, so a URL's
    /// underscores are never read as italics but `*see <url|docs>*` still bolds the link.
    private static func prose(_ s: String) -> String {
        var tokens: [String] = []
        var masked = ""
        var rest = Substring(s)
        while let open = rest.firstIndex(of: "<"), let close = rest[open...].firstIndex(of: ">") {
            masked += escaped(rest[..<open])
            masked.unicodeScalars.append(placeholder(tokens.count))
            tokens.append(token(rest[rest.index(after: open)..<close]))
            rest = rest[rest.index(after: close)...]
        }
        masked += escaped(rest)

        for (pattern, template) in emphasis {
            masked = pattern.stringByReplacingMatches(in: masked, range: NSRange(masked.startIndex..., in: masked), withTemplate: template)
        }
        masked = quoteMark.stringByReplacingMatches(in: masked, range: NSRange(masked.startIndex..., in: masked), withTemplate: ">")

        var out = ""
        for scalar in masked.unicodeScalars {
            let index = Int(scalar.value) - Int(placeholderBase)
            if (0..<tokens.count).contains(index) { out += tokens[index] } else { out.unicodeScalars.append(scalar) }
        }
        return out
    }

    private static let placeholderBase: UInt32 = 0xF0000  // Supplementary Private Use Area-A

    private static func placeholder(_ index: Int) -> Unicode.Scalar {
        Unicode.Scalar(placeholderBase + UInt32(index))!
    }

    /// Slack has no escapes, so a backslash is always literal; a bare `<` too.
    private static func escaped(_ s: Substring) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "<", with: "\\<")
    }

    /// Bold first, so the `*italic*` it produces isn't bolded again. A marker counts only
    /// at a word edge, as in Slack: `snake_case` and `2*3*4` stay as written.
    private static let emphasis: [(NSRegularExpression, String)] = [
        (#"(?<![\p{L}\p{N}_*\\])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}_*])"#, "**$1**"),
        (#"(?<![\p{L}\p{N}_\\])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])"#, "*$1*"),
        (#"(?<![\p{L}\p{N}~\\])~(?=\S)([^~\n]+?)(?<=\S)~(?![\p{L}\p{N}~])"#, "~~$1~~"),
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    private static let quoteMark = try! NSRegularExpression(pattern: "^&gt; ?", options: .anchorsMatchLines)

    /// `<https://x|label>` → a Markdown link; channels, users and groups → their name.
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
        guard target.contains(":") else { return label ?? target }
        guard let label, label != target else { return "<\(target)>" }
        let escapedLabel = label.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        return "[\(escapedLabel)](<\(target)>)"
    }

    /// Slack labels often carry their sigil already (`<!subteam^S0|@dev-product>`); never print it twice.
    private static func prefixed(_ sigil: String, _ name: String) -> String {
        name.hasPrefix(sigil) ? name : sigil + name
    }

    private static func decoded(_ s: String) -> String {
        s.replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func trimmingOneNewline(_ s: String) -> String {
        var s = Substring(s)
        if s.first == "\n" { s = s.dropFirst() }
        if s.last == "\n" { s = s.dropLast() }
        return String(s)
    }
}
