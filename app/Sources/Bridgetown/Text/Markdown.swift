import SwiftUI

/// The Markdown agents write (diagnoses, recommendations, transcripts), and Slack messages,
/// which the daemon translates from mrkdwn (`AlertDetail.raw`). Blocks are parsed here, line
/// by line; inline syntax (`code`, **bold**, *italic*, ~~strike~~, links) is Foundation's.
enum Markdown {
    struct ListItem: Equatable {
        /// "•" or the number as written ("1.").
        var marker: String
        var text: String
        var depth: Int
    }

    indirect enum Block: Equatable {
        case paragraph(String)
        case heading(level: Int, String)
        case list([ListItem])
        case code(String)
        case quote([Block])
        case table(header: [String], rows: [[String]])
        case rule
    }

    // MARK: Blocks

    static func blocks(_ s: String) -> [Block] {
        var lines = s.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")[...]
        var out: [Block] = []
        var paragraph: [String] = []

        func flush() {
            guard !paragraph.isEmpty else { return }
            out.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph = []
        }

        while let line = lines.popFirst() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                flush()
            } else if let fence = fence(trimmed) {
                flush()
                var body: [String] = []
                while let next = lines.popFirst(), !next.trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(next)
                }
                out.append(.code(body.joined(separator: "\n")))
            } else if let heading = heading(trimmed) {
                flush()
                out.append(heading)
            } else if isRule(trimmed) {
                flush()
                out.append(.rule)
            } else if trimmed.hasPrefix(">") {
                flush()
                var quoted = [unquoted(trimmed)]
                while let next = lines.first?.trimmingCharacters(in: .whitespaces), next.hasPrefix(">") {
                    quoted.append(unquoted(next))
                    lines.removeFirst()
                }
                out.append(.quote(blocks(quoted.joined(separator: "\n"))))
            } else if let item = listItem(line) {
                flush()
                out.append(.list(list(from: item, rest: &lines)))
            } else if let table = table(first: trimmed, rest: &lines) {
                flush()
                out.append(table)
            } else {
                paragraph.append(line)
            }
        }
        flush()
        return out
    }

    /// The list `first` opens: items until a blank line that isn't followed by another item,
    /// another kind of block, or numbers where it had bullets (or the reverse) at its level.
    /// Lines in between continue the item above them.
    private static func list(from first: ListItem, rest lines: inout ArraySlice<String>) -> [ListItem] {
        func belongs(_ item: ListItem) -> Bool {
            item.depth > first.depth || (item.marker == "•") == (first.marker == "•")
        }
        var items = [first]
        while let next = lines.first {
            let trimmed = next.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                let following = lines.dropFirst().first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                guard let item = following.flatMap(listItem), belongs(item) else { break }
                lines.removeFirst()
            } else if let item = listItem(next) {
                guard belongs(item) else { break }
                items.append(item)
                lines.removeFirst()
            } else if startsBlock(trimmed) {
                break
            } else {
                items[items.count - 1].text += "\n" + trimmed
                lines.removeFirst()
            }
        }
        return items
    }

    private static func startsBlock(_ trimmed: String) -> Bool {
        fence(trimmed) != nil || heading(trimmed) != nil || isRule(trimmed) || trimmed.hasPrefix(">")
    }

    private static func fence(_ trimmed: String) -> String? {
        ["```", "~~~"].first { trimmed.hasPrefix($0) }
    }

    private static func heading(_ trimmed: String) -> Block? {
        let hashes = trimmed.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : .heading(level: hashes, text)
    }

    private static func isRule(_ trimmed: String) -> Bool {
        let marks = trimmed.filter { $0 != " " }
        guard marks.count >= 3, let first = marks.first, "-*_".contains(first) else { return false }
        return marks.allSatisfy { $0 == first }
    }

    private static func unquoted(_ trimmed: String) -> String {
        let rest = trimmed.dropFirst()
        return String(rest.first == " " ? rest.dropFirst() : rest)
    }

    private static let bullets: Set<Character> = ["-", "*", "+", "•", "◦", "▪"]

    /// `- item`, `• item`, `1. item`, `2) item`; two spaces of indent per level. At most
    /// three digits, so a line that starts with a year stays a paragraph.
    static func listItem(_ line: String) -> ListItem? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }
        let depth = min(indent.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) } / 2, 4)
        let body = line.dropFirst(indent.count)
        guard let first = body.first else { return nil }
        let marker: String
        if bullets.contains(first) {
            marker = "•"
        } else {
            let digits = body.prefix { $0.isASCII && $0.isNumber }
            guard (1...3).contains(digits.count), let close = body.dropFirst(digits.count).first, close == "." || close == ")" else { return nil }
            marker = digits + "."
        }
        let afterMarker = body.dropFirst(marker == "•" ? 1 : marker.count)
        guard afterMarker.first == " " else { return nil }
        let text = afterMarker.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return ListItem(marker: marker, text: text, depth: depth)
    }

    /// A pipe table needs its `|---|` separator under the header; otherwise the lines stay prose.
    private static func table(first: String, rest lines: inout ArraySlice<String>) -> Block? {
        guard first.contains("|"),
              let separator = lines.first?.trimmingCharacters(in: .whitespaces),
              separator.contains("-"), separator.contains("|"),
              separator.allSatisfy({ "|-: ".contains($0) })
        else { return nil }
        let header = cells(first)
        lines.removeFirst()
        var rows: [[String]] = []
        while let next = lines.first?.trimmingCharacters(in: .whitespaces), next.contains("|") {
            let row = cells(next)
            rows.append(Array((row + Array(repeating: "", count: header.count)).prefix(header.count)))
            lines.removeFirst()
        }
        return .table(header: header, rows: rows)
    }

    private static func cells(_ row: String) -> [String] {
        var parts = row.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if row.hasPrefix("|") { parts.removeFirst() }
        if row.hasSuffix("|"), !parts.isEmpty { parts.removeLast() }
        return parts
    }

    // MARK: Inline

    /// One block's inline Markdown, styled for Geist at `size`: bold and code get explicit
    /// faces (SwiftUI can't derive them from a custom font) and bare URLs become links.
    static func inline(_ s: String, size: CGFloat, mono: Bool = false) -> AttributedString {
        var text = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        let runs = text.runs.map { ($0.range, $0.inlinePresentationIntent ?? []) }
        for (range, intent) in runs {
            let weight: Font.Weight = intent.contains(.stronglyEmphasized) ? .semibold : .regular
            if intent.contains(.code) {
                text[range].font = .geistMono(mono ? size : size - 0.5, weight)
                text[range].backgroundColor = Ink.track
            } else if weight != .regular {
                text[range].font = mono ? .geistMono(size, weight) : .geist(size, weight)
            }
        }
        linkBareURLs(&text)
        return text
    }

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    private static func linkBareURLs(_ text: inout AttributedString) {
        guard let linkDetector else { return }
        let plain = String(text.characters)
        for match in linkDetector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            guard let url = match.url, ["http", "https"].contains(url.scheme?.lowercased()),
                  let range = Range(match.range, in: plain)
            else { continue }
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let upper = text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            let found = text[lower..<upper]
            let taken = found.runs.contains { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }
            if !taken { text[lower..<upper].link = url }
        }
    }

    // MARK: Flattened

    /// Everything on one line, for rows and status lines: block syntax dropped, inline kept.
    /// No links: a row is one tap target, and blue is for live work there.
    static func line(_ s: String, size: CGFloat, mono: Bool = false) -> AttributedString {
        var text = flattened(s, size: size, mono: mono, separator: " ")
        text.link = nil
        return text
    }

    /// Blocks on their own lines in a single `Text`, for places that clamp by line count.
    static func lines(_ s: String, size: CGFloat, mono: Bool = false) -> AttributedString {
        flattened(s, size: size, mono: mono, separator: "\n")
    }

    /// The words alone, for tooltips and strings built around other text.
    static func plain(_ s: String) -> String {
        String(line(s, size: 12).characters)
    }

    private static func flattened(_ s: String, size: CGFloat, mono: Bool, separator: String) -> AttributedString {
        let oneLine = separator == " "
        func inlineText(_ t: String) -> AttributedString {
            inline(oneLine ? t.replacingOccurrences(of: "\n", with: " ") : t, size: size, mono: mono)
        }
        func render(_ block: Block) -> [AttributedString] {
            switch block {
            case .paragraph(let t): return [inlineText(t)]
            case .heading(_, let t):
                var heading = inlineText(t)
                heading.font = mono ? .geistMono(size, .semibold) : .geist(size, .semibold)
                return [heading]
            case .list(let items):
                return items.map { AttributedString(String(repeating: "  ", count: oneLine ? 0 : $0.depth) + $0.marker + " ") + inlineText($0.text) }
            case .code(let code):
                var text = AttributedString(oneLine ? code.split(separator: "\n").joined(separator: " ") : code)
                text.font = .geistMono(mono ? size : size - 0.5)
                return [text]
            case .quote(let inner): return inner.flatMap(render)
            case .table(let header, let rows):
                return ([header] + rows).map { inlineText($0.joined(separator: " · ")) }
            case .rule: return []
            }
        }
        var out = AttributedString()
        for (index, part) in blocks(s).flatMap(render).enumerated() {
            if index > 0 { out += AttributedString(separator) }
            out += part
        }
        return out
    }
}
