#if DEBUG
import Foundation

/// A JSON value as written. Steps stay JSON until they run, so `each` can fill in `$id`
/// first and the control endpoint can take the same steps over HTTP.
indirect enum E2EJSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([E2EJSON])
    case object([String: E2EJSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([E2EJSON].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: E2EJSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(value): try c.encode(value)
        case let .number(value): try c.encode(value)
        case let .string(value): try c.encode(value)
        case let .array(value): try c.encode(value)
        case let .object(value): try c.encode(value)
        }
    }

    subscript(key: String) -> E2EJSON? {
        if case let .object(fields) = self { fields[key] } else { nil }
    }

    var string: String? { if case let .string(value) = self { value } else { nil } }
    var number: Double? { if case let .number(value) = self { value } else { nil } }
    var bool: Bool? { if case let .bool(value) = self { value } else { nil } }
    var array: [E2EJSON]? { if case let .array(value) = self { value } else { nil } }

    /// `$id` (and any other `$token`) replaced in every string, keys left alone.
    func filling(_ values: [String: String]) -> E2EJSON {
        switch self {
        case let .string(text):
            return .string(values.reduce(text) { $0.replacingOccurrences(of: "$\($1.key)", with: $1.value) })
        case let .array(items):
            return .array(items.map { $0.filling(values) })
        case let .object(fields):
            return .object(fields.mapValues { $0.filling(values) })
        default:
            return self
        }
    }

    /// One line of JSON, for the mock's stdin and for error messages.
    var line: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "?"
    }
}

/// app/E2E/suite.json: the world, the clock, and the steps that drive and photograph the app.
struct E2ESuite: Decodable {
    /// Where both clocks stop: the mock's `MOCK_NOW` and the app's `AppClock`.
    var now: Date
    /// The mock's world at launch (`full` or `empty`).
    var world: String
    /// Every shot is taken in each, unless the shot or an `appearance` step says otherwise.
    var appearances: [E2EAppearance]
    /// Issues known and accepted, each with why.
    var allow: [E2EAllow]
    /// Run before the daemon starts: the app connecting.
    var beforeConnect: [E2EJSON]
    var steps: [E2EJSON]

    enum CodingKeys: String, CodingKey { case now, world, appearances, allow, beforeConnect, steps }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        now = try c.decode(Date.self, forKey: .now)
        world = try c.decodeIfPresent(String.self, forKey: .world) ?? "full"
        appearances = try c.decodeIfPresent([E2EAppearance].self, forKey: .appearances) ?? [.dark]
        allow = try c.decodeIfPresent([E2EAllow].self, forKey: .allow) ?? []
        beforeConnect = try c.decodeIfPresent([E2EJSON].self, forKey: .beforeConnect) ?? []
        steps = try c.decode([E2EJSON].self, forKey: .steps)
    }

    /// Where an `--e2e none` run stops the clocks: the instant suite.json uses too.
    static let defaultNow = Date(timeIntervalSince1970: 1_791_115_200)

    /// No suite (`--e2e none`): the app comes up and waits for the control endpoint.
    init(now: Date = defaultNow) {
        self.now = now
        world = "full"
        appearances = [.dark]
        allow = []
        beforeConnect = []
        steps = []
    }

    static func load(_ url: URL) throws -> E2ESuite {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(E2ESuite.self, from: Data(contentsOf: url))
    }
}

enum E2EAppearance: String, Codable, CaseIterable {
    case dark, light
}

/// An issue the suite accepts: `rule`, matched by element identifier or text (a regex),
/// on shots matching `shots` (a glob, default every shot).
struct E2EAllow: Codable {
    var rule: String
    var identifier: String?
    var text: String?
    var shots: String?
    var why: String

    func covers(rule: String, shot: String, identifier: String?, text: String?) -> Bool {
        guard rule == self.rule, E2EGlob.matches(shots ?? "*", shot) else { return false }
        if let wanted = self.identifier, wanted != identifier { return false }
        if let pattern = self.text {
            guard let text, text.range(of: pattern, options: .regularExpression) != nil else { return false }
        }
        return true
    }
}

/// `*` for any run of characters, `?` for one: shot names in `--e2e-only` and `allow`.
enum E2EGlob {
    static func matches(_ pattern: String, _ name: String) -> Bool {
        let regex = "^" + NSRegularExpression.escapedPattern(for: pattern)
            .replacingOccurrences(of: "\\*", with: ".*")
            .replacingOccurrences(of: "\\?", with: ".") + "$"
        return name.range(of: regex, options: .regularExpression) != nil
    }
}

/// One step, read from its JSON when it runs. Its op is its first key the runner knows.
enum E2EStep {
    enum Surface: Equatable {
        /// The open island at a preset size, or any size.
        case open(width: CGFloat, height: CGFloat, preset: String)
        /// The island at the notch, over a painted menu bar: `hardware` or `flat`.
        case notch(preset: String)
        case settings(tab: SettingsView.Tab)
    }

    enum Target {
        case overview
        case session(String)
        case alert(id: String?, title: String?, sessionOf: String?)
    }

    enum Wait: Equatable {
        case settled, connected, disconnected, rejected, portInUse
        case milliseconds(Int)
    }

    /// A shot's lint: off, on, or on with every error counted as a warning (stress sizes).
    enum Lint: Equatable {
        case off, on, warnings
    }

    /// An element on the current surface: by identifier or text, optionally only inside
    /// the element `within` names (when a title shows in two panes).
    struct Element {
        var target: String
        var within: String?
    }

    case surface(Surface)
    case show(Target)
    case back
    case telemetry(TelemetryPanel.Mode)
    case press(Element)
    /// A mouse click on the element: at its centre, or `at` points from its top-left corner
    /// (a control inside a row that is one button has no element of its own).
    case click(Element, at: CGPoint?)
    case action(on: Element, name: String)
    case type(into: Element, text: String)
    case scroll(in: String, to: String)
    case island(String, action: String?)
    /// A status patch, as a control line on the mock's stdin.
    case mock(E2EJSON)
    /// The mock exits with this code, as a crash would; the app does what it does about it.
    case crash(Int)
    /// The app stops its daemon and leaves it down, until a `restart`.
    case stopDaemon
    case restart(world: String?, tokenMismatch: Bool)
    case appearance([E2EAppearance])
    case wait(Wait, timeoutMs: Int)
    /// Fails the run unless the app's state (`GET /state`: route, actions, alerts…) comes
    /// to hold these values within 2s: what a step did, where a shot can't say it.
    case expect([String: E2EJSON])
    case shot(name: String, lint: Lint, appearances: [E2EAppearance]?)
    case each(String, [E2EJSON])

    struct Invalid: Error, CustomStringConvertible {
        let description: String
    }

    /// It changes what the app shows (or may): a frame settled before it no longer stands.
    var acts: Bool {
        switch self {
        case .appearance, .wait, .expect, .shot, .each: false
        default: true
        }
    }

    static let openPresets: [String: CGSize] = [
        "wide": CGSize(width: 1100, height: 480),
        // A 1024×640 screen, the smallest the island is laid out for.
        "narrow": CGSize(width: 864, height: 456),
        // Every pane's whole content, for what sits below the fold.
        "tall": CGSize(width: 1100, height: 1400),
        // Smaller than any screen gives it: a stress test, warnings only.
        "tiny": CGSize(width: 640, height: 360),
    ]

    init(_ json: E2EJSON) throws {
        func bad(_ message: String) -> Invalid { Invalid(description: "\(message): \(json.line)") }
        func text(_ key: String, in value: E2EJSON? = nil) throws -> String {
            guard let found = (value ?? json)[key]?.string, !found.isEmpty else { throw bad("expected a string \"\(key)\"") }
            return found
        }
        func appearances(_ value: E2EJSON?) throws -> [E2EAppearance]? {
            guard let value else { return nil }
            let names = value.array?.compactMap(\.string) ?? value.string.map { [$0] } ?? []
            let parsed = names.compactMap(E2EAppearance.init(rawValue:))
            guard !parsed.isEmpty, parsed.count == names.count else { throw bad("appearances are \"dark\" or \"light\"") }
            return parsed
        }

        if let surface = json["surface"]?.string {
            switch surface {
            case "open":
                if let size = json["size"]?.array?.compactMap(\.number), size.count == 2 {
                    self = .surface(.open(width: size[0], height: size[1], preset: "\(Int(size[0]))x\(Int(size[1]))"))
                } else {
                    let preset = json["preset"]?.string ?? "wide"
                    guard let size = Self.openPresets[preset] else { throw bad("unknown open preset \"\(preset)\"") }
                    self = .surface(.open(width: size.width, height: size.height, preset: preset))
                }
            case "notch":
                let preset = json["preset"]?.string ?? "hardware"
                guard preset == "hardware" || preset == "flat" else { throw bad("a notch is \"hardware\" or \"flat\"") }
                self = .surface(.notch(preset: preset))
            case "settings":
                let name = json["tab"]?.string ?? "accounts"
                guard let tab = SettingsView.Tab(rawValue: name) else { throw bad("unknown settings tab \"\(name)\"") }
                self = .surface(.settings(tab: tab))
            default:
                throw bad("unknown surface \"\(surface)\"")
            }
        } else if let show = json["show"] {
            if show.string == "overview" {
                self = .show(.overview)
            } else if let session = show["session"]?.string {
                self = .show(.session(session))
            } else if let alert = show["alert"] {
                if let id = alert.string {
                    self = .show(.alert(id: id, title: nil, sessionOf: nil))
                } else {
                    let target = Target.alert(id: alert["id"]?.string, title: alert["title"]?.string, sessionOf: alert["sessionOf"]?.string)
                    guard alert["id"] != nil || alert["title"] != nil || alert["sessionOf"] != nil else { throw bad("an alert by id, title or sessionOf") }
                    self = .show(target)
                }
            } else {
                throw bad("show \"overview\", a session or an alert")
            }
        } else if json["back"] != nil {
            self = .back
        } else if let mode = json["telemetry"]?.string {
            guard let parsed = TelemetryPanel.Mode.allCases.first(where: { $0.rawValue.lowercased() == mode.lowercased() }) else {
                throw bad("telemetry is one of \(TelemetryPanel.Mode.allCases.map(\.rawValue))")
            }
            self = .telemetry(parsed)
        } else if let island = json["island"]?.string {
            // Before `action`, which a banner step names its card with.
            guard ["rest", "hover", "banner", "open", "close"].contains(island) else { throw bad("island is rest, hover, banner, open or close") }
            self = .island(island, action: json["action"]?.string)
        } else if let target = json["press"]?.string {
            self = .press(Element(target: target, within: json["in"]?.string))
        } else if let target = json["click"]?.string {
            var at: CGPoint?
            if let offset = json["at"] {
                guard let xy = offset.array?.compactMap(\.number), xy.count == 2 else { throw bad("click \"at\" is [x, y]") }
                at = CGPoint(x: xy[0], y: xy[1])
            }
            self = .click(Element(target: target, within: json["in"]?.string), at: at)
        } else if let action = json["action"] {
            self = .action(on: Element(target: try text("on", in: action), within: json["in"]?.string), name: try text("name", in: action))
        } else if let type = json["type"] {
            guard let typed = type["text"]?.string else { throw bad("type needs \"text\"") }
            self = .type(into: Element(target: try text("into", in: type), within: json["in"]?.string), text: typed)
        } else if let scroll = json["scroll"] {
            let to = scroll["to"]?.string ?? scroll["to"]?.number.map { String(Int($0)) } ?? "bottom"
            self = .scroll(in: try text("in", in: scroll), to: to)
        } else if let mock = json["mock"] {
            if let status = mock["status"] {
                self = .mock(.object(["mock": .string("status"), "patch": status]))
            } else if let code = mock["crash"]?.number {
                self = .crash(Int(code))
            } else {
                throw bad("mock takes \"status\" or \"crash\"")
            }
        } else if let daemon = json["daemon"] {
            guard daemon.string == "stop" else { throw bad("daemon takes \"stop\"") }
            self = .stopDaemon
        } else if let restart = json["restart"] {
            self = .restart(world: restart["world"]?.string, tokenMismatch: restart["tokenMismatch"]?.bool ?? false)
        } else if let appearance = json["appearance"] {
            self = .appearance(try appearances(appearance) ?? [])
        } else if let wait = json["wait"] {
            let timeout = json["timeoutMs"]?.number.map(Int.init) ?? 20_000
            if let ms = wait["ms"]?.number {
                self = .wait(.milliseconds(Int(ms)), timeoutMs: timeout)
            } else {
                let waits: [String: Wait] = ["settled": .settled, "connected": .connected, "disconnected": .disconnected, "rejected": .rejected, "portInUse": .portInUse]
                guard let name = wait.string, let parsed = waits[name] else { throw bad("wait for \(waits.keys.sorted()) or {\"ms\": n}") }
                self = .wait(parsed, timeoutMs: timeout)
            }
        } else if let expect = json["expect"] {
            guard case let .object(fields) = expect, !fields.isEmpty else { throw bad("expect takes {\"route\": …, \"actions\": n, …}") }
            self = .expect(fields)
        } else if let shot = json["shot"]?.string {
            let lint: Lint = switch json["lint"] {
            case .bool(false)?: .off
            case .string("warnings")?: .warnings
            default: .on
            }
            self = .shot(name: shot, lint: lint, appearances: try appearances(json["appearances"]))
        } else if let each = json["each"]?.string {
            guard ["sessions", "actions", "alerts"].contains(each), let steps = json["do"]?.array else { throw bad("each sessions, actions or alerts, with \"do\"") }
            self = .each(each, steps)
        } else {
            throw bad("unknown step")
        }
    }
}
#endif
