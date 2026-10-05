#if DEBUG
import AppKit

/// One node of a surface's accessibility tree, as the lint reads it.
struct E2EElement: Encodable, Equatable {
    /// A run of the element's text in one font.
    struct Run: Codable, Equatable {
        var location: Int
        var length: Int
        var font: String
        var size: Double
    }

    var id: Int
    var parent: Int?
    var role: String
    var identifier: String?
    /// The label, else the value: the whole text, however much of it shows.
    var text: String?
    var placeholder: String?
    /// In points, from the surface's top-left corner.
    var frame: CGRect
    /// The nearest enclosing `AXScrollArea`.
    var scrollArea: Int?
    var runs: [Run] = []
    /// Named actions (`accessibilityAction(named:)`).
    var actions: [String] = []

    static let interactiveRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXTextField", "AXTextArea", "AXPopUpButton",
        "AXMenuButton", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXComboBox",
    ]

    var interactive: Bool { Self.interactiveRoles.contains(role) }
    /// What fills the frame while its content loads; masked out of shots and settle checks.
    var spinner: Bool { role == "AXProgressIndicator" || role == "AXBusyIndicator" }

    enum CodingKeys: String, CodingKey { case id, parent, role, identifier, text, placeholder, frame, scrollArea, runs, actions }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(parent, forKey: .parent)
        try c.encode(role, forKey: .role)
        try c.encodeIfPresent(identifier, forKey: .identifier)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(placeholder, forKey: .placeholder)
        try c.encode(E2ELint.flat(frame), forKey: .frame)
        try c.encodeIfPresent(scrollArea, forKey: .scrollArea)
        if !runs.isEmpty { try c.encode(runs, forKey: .runs) }
        if !actions.isEmpty { try c.encode(actions, forKey: .actions) }
    }
}

/// Layout problems in one shot, read off its accessibility tree: a pure function of the
/// elements and the surface's size, so it is tested on made-up trees (E2ELintTests).
enum E2ELint {
    enum Severity: String, Codable, Comparable {
        case error, warning, info

        static func < (a: Severity, b: Severity) -> Bool { a.rank < b.rank }
        private var rank: Int { self == .error ? 0 : self == .warning ? 1 : 2 }
    }

    struct Issue: Encodable, Equatable {
        var rule: String
        var severity: Severity
        var message: String
        var elements: [Int]
        var frames: [CGRect]
        var text: String?
        var identifier: String?
        /// issues/<shot>-<n>.png, once cropped.
        var crop: String?

        enum CodingKeys: String, CodingKey { case rule, severity, message, elements, frames, text, identifier, crop }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(rule, forKey: .rule)
            try c.encode(severity, forKey: .severity)
            try c.encode(message, forKey: .message)
            try c.encode(elements, forKey: .elements)
            try c.encode(frames.map(E2ELint.flat), forKey: .frames)
            try c.encodeIfPresent(text, forKey: .text)
            try c.encodeIfPresent(identifier, forKey: .identifier)
            try c.encodeIfPresent(crop, forKey: .crop)
        }
    }

    /// A rect as the report writes it: `[x, y, width, height]` in points, from the top left.
    static func flat(_ rect: CGRect) -> [Double] {
        [rect.minX, rect.minY, rect.width, rect.height].map { (Double($0) * 10).rounded() / 10 }
    }

    struct Options {
        /// The island's own surfaces: every run of text must be Geist, and every control is
        /// the app's own, held to a 20pt target (Settings' are the system's, at its sizes).
        var stage = true
        var shot = ""
        var allow: [E2EAllow] = []
    }

    /// Controls whose parts are the system's own.
    static let systemControls: Set<String> = ["AXScrollBar", "AXIncrementor", "AXDateTimeArea"]

    /// Slack for edges: frames are fractional and AX rounds some of them.
    static let tolerance: CGFloat = 0.5

    static func lint(bounds: CGSize, elements: [E2EElement], options: Options = Options()) -> [Issue] {
        let surface = CGRect(origin: .zero, size: bounds)
        let byId = Dictionary(uniqueKeysWithValues: elements.map { ($0.id, $0) })
        var issues: [Issue] = []

        func issue(_ rule: String, _ severity: Severity, _ message: String, _ involved: [E2EElement]) {
            let allowed = options.allow.contains { allow in
                involved.contains { allow.covers(rule: rule, shot: options.shot, identifier: $0.identifier, text: $0.text) }
            }
            guard !allowed else { return }
            let first = involved.first
            issues.append(Issue(
                rule: rule, severity: severity, message: message, elements: involved.map(\.id), frames: involved.map(\.frame),
                text: first?.text, identifier: first?.identifier
            ))
        }

        func ancestors(_ element: E2EElement) -> [E2EElement] {
            var out: [E2EElement] = []
            var next = element.parent.flatMap { byId[$0] }
            while let current = next, out.count < 100 {
                out.append(current)
                next = current.parent.flatMap { byId[$0] }
            }
            return out
        }

        /// What of the element can be seen: inside each scroll area it is in, and the surface.
        func visible(_ element: E2EElement) -> CGRect {
            var rect = element.frame.intersection(surface)
            var area = element.scrollArea.flatMap { byId[$0] }
            while let scroll = area {
                rect = rect.intersection(scroll.frame)
                area = scroll.scrollArea.flatMap { byId[$0] }
            }
            return rect
        }

        let parents = Set(elements.compactMap(\.parent))
        /// Text no other element sits in: what is drawn, as opposed to a container's label.
        func isTextLeaf(_ element: E2EElement) -> Bool {
            element.text != nil && !element.interactive && !parents.contains(element.id)
        }
        /// Inside a view that clips it (`E2EAccessibility.clipIdentifier`): its lines keep
        /// their whole frames in the tree, so which of them show can't be told.
        func inClip(_ element: E2EElement) -> Bool {
            ancestors(element).contains { $0.identifier == E2EAccessibility.clipIdentifier }
        }
        let inside = surface.insetBy(dx: -tolerance, dy: -tolerance)
        var drawnText: [E2EElement] = []
        var scrolledOut = 0

        for element in elements {
            // A scroller's arrows, a stepper's, a date picker's fields: the system sizes and names them.
            if ancestors(element).contains(where: { Self.systemControls.contains($0.role) }) || element.role == "AXScrollBar" { continue }
            let shown = visible(element)
            let hidden = shown.isNull || shown.isEmpty
            if hidden, element.scrollArea != nil, element.frame.width > 0 { scrolledOut += 1 }
            if isTextLeaf(element), !hidden, !inClip(element) { drawnText.append(element) }

            // Outside a scroll area nothing may cross the surface's edge; text that does is cut.
            if element.scrollArea == nil, element.frame.width >= 1, element.frame.height >= 1, !inside.contains(element.frame) {
                if let text = element.text, isTextLeaf(element) {
                    issue("clipped-text", .error, "Partly outside the surface: \"\(text.prefix(60))\"", [element])
                } else {
                    issue("out-of-bounds", .error, "Reaches past the surface's edge", [element])
                }
            }
            // In one, rows cut at the top or bottom are scrolling; cut at the sides, they are clipped.
            if let text = element.text, isTextLeaf(element), !hidden, let area = element.scrollArea.flatMap({ byId[$0] }),
               element.frame.minX < area.frame.minX - tolerance || element.frame.maxX > area.frame.maxX + tolerance {
                issue("clipped-text", .error, "Cut by the side of its scroll area: \"\(text.prefix(60))\"", [element])
            }

            if element.interactive {
                if element.frame.width < 1 || element.frame.height < 1 {
                    // In a scroll area it may only be laid out lazily, out of sight.
                    if element.scrollArea == nil { issue("zero-size-control", .error, "A control with no size", [element]) }
                    continue
                }
                if hidden { continue }
                if options.stage, element.frame.width < 20 || element.frame.height < 20 {
                    issue("tiny-target", .warning, "Smaller than 20×20 to hit (\(Int(element.frame.width))×\(Int(element.frame.height)))", [element])
                }
                if (element.text ?? element.placeholder ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
                    issue("unlabeled-control", .warning, "A \(element.role) with no label", [element])
                }
                if let overflow = overflow(element) {
                    issue("truncated-control", .error, "Its label doesn't fit: \(overflow)", [element])
                }
            } else if !hidden, let overflow = overflow(element) {
                issue("truncated", .warning, "Clamped: \(overflow)", [element])
            }

            if options.stage, !hidden,
               let run = element.runs.first(where: { !$0.font.hasPrefix("Geist-") && !$0.font.hasPrefix("GeistMono-") }) {
                issue("font-fallback", .error, "Drawn in \(run.font) \(run.size)pt, not Geist", [element])
            }
        }

        for (index, a) in drawnText.enumerated() {
            for b in drawnText[(index + 1)...] {
                let va = visible(a), vb = visible(b)
                guard !va.contains(vb), !vb.contains(va) else { continue }
                let overlap = va.intersection(vb)
                guard !overlap.isNull, overlap.width > 2, overlap.height > 2 else { continue }
                let smaller = min(va.width * va.height, vb.width * vb.height)
                guard smaller > 0, overlap.width * overlap.height > 0.1 * smaller else { continue }
                issue("text-overlap", .error, "Overlaps \"\((b.text ?? "").prefix(40))\"", [a, b])
            }
        }

        if scrolledOut > 0 {
            issues.append(Issue(rule: "scrolled-out", severity: .info, message: "\(scrolledOut) elements are scrolled out of view", elements: [], frames: []))
        }
        // Most severe first, in tree order within each severity.
        return issues.enumerated().sorted { ($0.element.severity, $0.offset) < ($1.element.severity, $1.offset) }.map(\.element)
    }

    /// The run's font. The system font's private names (".SFNS-Semibold") only come back
    /// through `systemFont`, by weight.
    static func font(_ run: E2EElement.Run) -> NSFont {
        guard run.font.hasPrefix(".") else { return NSFont(name: run.font, size: run.size) ?? .systemFont(ofSize: run.size) }
        let weights: [(String, NSFont.Weight)] = [("Bold", .bold), ("Semibold", .semibold), ("Medium", .medium), ("Light", .light)]
        let weight = weights.first { run.font.hasSuffix($0.0) }?.1 ?? .regular
        return run.font.contains("Mono") ? .monospacedSystemFont(ofSize: run.size, weight: weight) : .systemFont(ofSize: run.size, weight: weight)
    }

    /// How the element's text overflows its frame, measured in its own fonts; nil when it
    /// fits or its fonts aren't known. Text that fits on one line is let off 2% and a point
    /// of width, as AX doesn't carry tracking; text that doesn't is wrapped at the frame's
    /// width and must fit its height.
    static func overflow(_ element: E2EElement) -> String? {
        guard let text = element.text, !element.runs.isEmpty, element.frame.width > 1 else { return nil }
        let measured = NSMutableAttributedString(string: text)
        for run in element.runs {
            let range = NSRange(location: run.location, length: run.length)
            guard NSMaxRange(range) <= measured.length else { continue }
            measured.addAttribute(.font, value: font(run), range: range)
        }
        let frame = element.frame
        let natural = measured.size()
        if natural.width <= frame.width * 1.02 + 1, natural.height <= frame.height + 1.5 { return nil }
        let wrapped = measured.boundingRect(
            with: CGSize(width: frame.width + 0.5, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        ).height
        guard wrapped > frame.height + 1.5 else { return nil }
        // A frame less than two lines tall holds one line: say how wide that line is.
        if !text.contains("\n"), frame.height < natural.height * 2 - 1.5 {
            return "needs \(Int(natural.width.rounded()))pt, has \(Int(frame.width))pt"
        }
        return "needs \(Int(wrapped.rounded()))pt of height, has \(Int(frame.height))pt"
    }
}
#endif
