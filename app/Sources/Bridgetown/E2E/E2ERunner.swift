#if DEBUG
import AppKit

/// Runs steps against the live app, through the code paths a click takes: the Store's
/// navigation, the island controller, AX presses on real controls, and the mock daemon
/// (control lines on its stdin, restarts with another world). The suite and the control
/// endpoint both come through `perform`.
@MainActor
final class E2ERunner {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    struct Options {
        var out: URL
        var only: String?
        var baseline: URL?
    }

    /// What one `shot` step produced, per appearance.
    struct ShotResult: Encodable {
        var png: String
        var issues: [E2ELint.Issue]
    }

    let surfaces: E2ESurfaces
    private(set) var report: E2EReport
    private let store: Store
    private let daemon: DaemonProcess
    private let island: IslandController
    private let suite: E2ESuite
    private let options: Options
    private let startDaemon: () -> Void
    private let started = ContinuousClock.now
    private var appearances: [E2EAppearance]
    /// The step running, for side effects and failures: `steps[3]`, `before[0]`, `control`.
    private var step = "setup"

    init(app: AppDelegate, suite: E2ESuite, suiteName: String, options: Options, defaults: UserDefaults, commit: String) {
        store = app.store
        daemon = app.daemon
        island = app.island
        self.suite = suite
        self.options = options
        startDaemon = { [weak app] in app?.startDaemon() }
        appearances = suite.appearances
        surfaces = E2ESurfaces(store: app.store, daemon: app.daemon, island: app.island, defaults: defaults)
        report = E2EReport(
            run: options.out.lastPathComponent, commit: commit,
            os: ProcessInfo.processInfo.operatingSystemVersionString, now: suite.now, suite: suiteName
        )
    }

    /// 0 clean, 1 lint errors, 2 the harness failed.
    var status: Int32 {
        report.failure != nil ? 2 : report.summary.errors > 0 ? 1 : 0
    }

    /// The suite end to end; `status` says how it went.
    func run() async {
        do {
            for (index, json) in suite.beforeConnect.enumerated() {
                step = "before[\(index)]"
                _ = try await perform(json)
            }
            step = "connect"
            startDaemon()
            try await wait(.connected, timeoutMs: 20_000)
            for (index, json) in suite.steps.enumerated() {
                step = "steps[\(index)]"
                _ = try await perform(json)
            }
            step = "done"
        } catch {
            fail("\(step): \(error)")
            return
        }
        save()
    }

    func fail(_ message: String) {
        report.failure = message
        save()
    }

    /// A side effect a click would have had (`SystemActions.sink`).
    func record(_ kind: SystemActions.Effect, _ detail: String) {
        report.sideEffects.append(E2EReport.SideEffect(step: step, kind: kind, detail: detail))
    }

    func save() {
        report.durationMs = Self.milliseconds(since: started)
        try? report.write(to: options.out)
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Int {
        Int((ContinuousClock.now - start) / .milliseconds(1))
    }

    // MARK: Steps

    @discardableResult
    func perform(_ json: E2EJSON, as name: String? = nil) async throws -> [ShotResult] {
        if let name { step = name }
        switch try E2EStep(json) {
        case let .surface(spec):
            surfaces.show(spec)
        case let .show(target):
            store.show(try route(target))
            // Until the old route has slid away: a step after this one must not find its controls.
            try await wait(.settled, timeoutMs: 0)
        case .back:
            store.back()
            try await wait(.settled, timeoutMs: 0)
        case let .telemetry(mode):
            surfaces.defaults.set(mode.rawValue, forKey: "telemetryMode")
        case let .press(target):
            let (element, node) = try await find(target)
            guard E2EAccessibility.press(node) else {
                throw Failure(description: "\(target.target) (\(element.role), \(type(of: node))) doesn't take a press")
            }
        case let .action(target, name):
            let (element, node) = try await find(target)
            guard E2EAccessibility.perform(name, on: node) else {
                throw Failure(description: "\(target.target) has no action \"\(name)\" (it has \(element.actions))")
            }
        case let .type(target, text):
            try await retrying {
                let (element, _) = try self.lookUp(target)
                guard let host = self.surfaces.current?.host, E2EAccessibility.type(text, at: element.frame, in: host) else {
                    throw Failure(description: "\(target.target) (\(element.role)) is not a text field")
                }
            }
        case let .scroll(target, to):
            // "bottom" of what is there once it has finished growing (a press just before).
            try await wait(.settled, timeoutMs: 0)
            try await retrying { try self.scroll(target, to: to) }
        case let .island(move, action):
            try moveIsland(move, action: action)
            // Drawn afresh where the island lands: its content comes in with a transition that
            // carries its own spring, which no transaction takes away, and a shot taken on its
            // tail is off by a fraction of a pixel, differently each run.
            if let shown = surfaces.current, case .notch = shown.spec { surfaces.show(shown.spec) }
        case let .mock(line):
            daemon.sendControl(line.line)
        case let .crash(code):
            // On a quiet app: a request the steps before sent lands first rather than dying with it.
            try await wait(.settled, timeoutMs: 0)
            guard let crashing = daemonPid else { throw Failure(description: "no daemon running to crash") }
            daemon.sendControl(E2EJSON.object(["mock": .string("crash"), "code": .number(Double(code))]).line)
            // Done once the app has seen it go, so a `wait` after this one waits on what the
            // app does about it, not on the moment before it noticed.
            try await until("the crashed daemon to go", timeoutMs: 5_000) { daemonPid != crashing && !store.isConnected }
        case .stopDaemon:
            try await wait(.settled, timeoutMs: 0)
            await withCheckedContinuation { done in
                if !daemon.stop(completion: { done.resume() }) { done.resume() }
            }
        case let .restart(world, tokenMismatch):
            daemon.extraEnvironment["MOCK_WORLD"] = world ?? suite.world
            daemon.extraEnvironment["MOCK_API_TOKEN"] = tokenMismatch ? "not-this-app" : ""
            try await wait(.settled, timeoutMs: 0)
            let replaced = daemonPid
            daemon.restart()
            // The old one can answer for a moment as it goes: the stream starts on the new one,
            // at once rather than after the backoff a dead daemon built up.
            try await until("the new daemon to run") { daemonPid.map { $0 != replaced } ?? false }
            store.connect(to: daemon.endpoint)
            try await wait(tokenMismatch ? .rejected : .connected, timeoutMs: 20_000)
        case let .appearance(next):
            appearances = next
        case let .wait(condition, timeoutMs):
            try await wait(condition, timeoutMs: timeoutMs)
        case let .shot(name, lint, only):
            return try await shoot(name, lint: lint, appearances: only ?? appearances)
        case let .each(collection, steps):
            var results: [ShotResult] = []
            for id in ids(collection) {
                for json in steps { results += try await perform(json.filling(["id": id])) }
            }
            return results
        }
        return []
    }

    private func ids(_ collection: String) -> [String] {
        guard let snap = store.snapshot else { return [] }
        switch collection {
        case "sessions": return snap.sessions.map(\.id)
        case "actions": return snap.sortedActions.map(\.id)
        default: return snap.alerts.map(\.id)
        }
    }

    private func route(_ target: E2EStep.Target) throws -> Store.Route {
        switch target {
        case .overview:
            return .overview
        case let .session(id):
            guard store.snapshot?.session(id: id) != nil else { throw Failure(description: "no session \(id)") }
            return .session(id)
        case let .alert(id, title, sessionOf):
            // An alert past the snapshot's window still opens: the detail fetches it.
            if let id { return .alert(id) }
            if let sessionOf {
                guard let session = store.snapshot?.session(id: sessionOf) else { throw Failure(description: "no session \(sessionOf)") }
                return .alert(session.alertId)
            }
            guard let found = store.snapshot?.alerts.first(where: { $0.title == title }) else {
                throw Failure(description: "no alert titled \(title ?? "")")
            }
            return .alert(found.id)
        }
    }

    private func moveIsland(_ move: String, action id: String?) throws {
        switch move {
        case "open":
            island.open()
        case "hover":
            island.close()
            island.previewHover(true)
        case "banner":
            let actions = store.snapshot?.sortedActions ?? []
            guard let action = id.map({ id in actions.first { $0.id == id } }) ?? actions.first else {
                throw Failure(description: "no action \(id ?? "") for a banner")
            }
            island.showBanner(action)
        default:
            island.close()
            island.previewHover(false)
        }
    }

    /// An element of the current surface by identifier, else by its text: a control's
    /// first, then anything's. Waits up to 5s for it, as what it is on may still be loading.
    private func find(_ wanted: E2EStep.Element) async throws -> (E2EElement, AnyObject) {
        try await retrying { try self.lookUp(wanted) }
    }

    /// `body` until it stops failing, for up to 5s: the surface it acts on may still be
    /// loading or laying out.
    private func retrying<T>(_ body: () throws -> T) async throws -> T {
        let deadline = ContinuousClock.now + .seconds(5)
        while true {
            do {
                return try body()
            } catch {
                guard ContinuousClock.now < deadline else { throw error }
                try await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func lookUp(_ wanted: E2EStep.Element) throws -> (E2EElement, AnyObject) {
        guard let host = surfaces.current?.host else { throw Failure(description: "no surface yet") }
        let tree = E2EAccessibility.walk(host)
        var candidates = tree.elements
        if let within = wanted.within {
            guard let scope = tree.elements.first(where: { $0.identifier == within }) else {
                throw Failure(description: "no element \"\(within)\" to look in")
            }
            candidates = candidates.filter { isInside($0, scope.id, tree) }
        }
        let found = candidates.first { $0.identifier == wanted.target }
            ?? candidates.first { $0.interactive && $0.text == wanted.target }
            ?? candidates.first { $0.text == wanted.target }
        guard let found else { throw Failure(description: "no element \"\(wanted.target)\" on \(surfaces.current?.name ?? "?")") }
        return (found, tree.nodes[found.id])
    }

    private func scroll(_ target: String, to: String) throws {
        guard let host = surfaces.current?.host else { throw Failure(description: "no surface yet") }
        let tree = E2EAccessibility.walk(host)
        guard let start = tree.elements.firstIndex(where: { $0.identifier == target }) else {
            throw Failure(description: "no element \"\(target)\" to scroll")
        }
        // The identifier sits on the pane; its scroll area is it or the first one inside.
        let area = tree.elements[start...].first { $0.role == "AXScrollArea" && ($0.id == start || isInside($0, start, tree)) }
        guard let area, let scrollView = E2EAccessibility.scrollView(at: area.frame, in: host) else {
            throw Failure(description: "\(target) has no scroll area")
        }
        let clip = scrollView.contentView
        let content = scrollView.documentView?.frame.height ?? 0
        let room = max(0, content - clip.bounds.height)
        let offset = switch to {
        case "top": 0.0
        case "bottom": room
        default: min(room, max(0, Double(to) ?? 0))
        }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.isFlipped ? offset : room - offset))
        scrollView.reflectScrolledClipView(clip)
    }

    private func isInside(_ element: E2EElement, _ ancestor: Int, _ tree: E2EAccessibility.Tree) -> Bool {
        var next = element.parent
        while let id = next {
            if id == ancestor { return true }
            next = tree.elements[id].parent
        }
        return false
    }

    // MARK: Waiting

    private func wait(_ condition: E2EStep.Wait, timeoutMs: Int) async throws {
        if case let .milliseconds(ms) = condition {
            try await Task.sleep(for: .milliseconds(ms))
            return
        }
        if condition == .settled {
            guard let shown = surfaces.current else { return }
            _ = await settle(shown, appearance: appearances.first ?? .dark)
            return
        }
        // A dropped stream first says the daemon closed it, then, once a reconnect has failed,
        // that it is unreachable: wait for the reason to stand still a second.
        let hold: Duration = condition == .disconnected ? .seconds(1) : .zero
        var since: (connection: Store.Connection, at: ContinuousClock.Instant)?
        try await until("\(condition)", timeoutMs: timeoutMs) {
            guard holds(condition) else {
                since = nil
                return false
            }
            if since?.connection != store.connection { since = (store.connection, .now) }
            return since.map { ContinuousClock.now - $0.at >= hold } ?? false
        }
    }

    /// Polls `done` until it holds; past `timeoutMs` the step fails, saying what it waited for.
    private func until(_ what: String, timeoutMs: Int = 20_000, _ done: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .milliseconds(timeoutMs)
        while !done() {
            guard ContinuousClock.now < deadline else {
                throw Failure(description: "waited \(timeoutMs)ms for \(what) (connection \(store.connection), daemon \(daemon.state))")
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    /// The daemon's process, while one runs.
    private var daemonPid: Int32? {
        if case let .running(pid) = daemon.state { pid } else { nil }
    }

    private func holds(_ condition: E2EStep.Wait) -> Bool {
        switch condition {
        case .connected: store.isConnected && store.snapshot != nil
        case .rejected: store.connection == .rejected
        case .portInUse: daemon.state == .portInUse
        case .disconnected: if case .disconnected = store.connection { true } else { false }
        case .settled, .milliseconds: true
        }
    }

    // MARK: Shots

    private struct Frame {
        var tree: E2EAccessibility.Tree
        var image: NSBitmapImageRep?
        var masks: [CGRect]
        var settledMs: Int
        var settled: Bool
    }

    /// Settled: no request in flight for 200ms, then two frames 120ms apart the same,
    /// spinners masked. Past 4s the shot is taken anyway and says so.
    private func settle(_ shown: E2ESurfaces.Shown, appearance: E2EAppearance) async -> Frame {
        shown.window.appearance = NSAppearance(named: appearance == .dark ? .darkAqua : .aqua)
        let start = ContinuousClock.now
        var quietSince: ContinuousClock.Instant?
        var previous: Data?
        var frame = Frame(tree: .init(), image: nil, masks: [], settledMs: 0, settled: false)
        while ContinuousClock.now - start < .seconds(4) {
            surfaces.fit()
            if DaemonClient.requestsInFlight.withLock({ $0 }) > 0 {
                quietSince = nil
                previous = nil
            } else if let since = quietSince, ContinuousClock.now - since >= .milliseconds(200) {
                frame.tree = E2EAccessibility.walk(shown.host)
                frame.masks = frame.tree.elements.filter(\.spinner).map(\.frame)
                frame.image = render(shown, appearance: appearance)
                let pixels = frame.image.map { E2ECapture.masked($0, frame.masks) }
                // An empty tree may still be building; after 2s it is what there is (and blank).
                if let pixels, pixels == previous, !frame.tree.elements.isEmpty || ContinuousClock.now - start >= .seconds(2) {
                    frame.settled = true
                    break
                }
                previous = pixels
                try? await Task.sleep(for: .milliseconds(120))
                continue
            } else if quietSince == nil {
                quietSince = .now
            }
            try? await Task.sleep(for: .milliseconds(40))
        }
        if !frame.settled {
            frame.tree = E2EAccessibility.walk(shown.host)
            frame.masks = frame.tree.elements.filter(\.spinner).map(\.frame)
            frame.image = render(shown, appearance: appearance)
        }
        frame.settledMs = Self.milliseconds(since: start)
        return frame
    }

    private func render(_ shown: E2ESurfaces.Shown, appearance: E2EAppearance) -> NSBitmapImageRep? {
        E2ECapture.render(shown.host, appearance: shown.window.appearance) { [surfaces] in surfaces.paintBackdrop($0) }
    }

    private func shoot(_ name: String, lint: E2EStep.Lint, appearances: [E2EAppearance]) async throws -> [ShotResult] {
        guard options.only.map({ E2EGlob.matches($0, name) }) ?? true else { return [] }
        guard let shown = surfaces.current else { throw Failure(description: "shot \(name) before any surface") }
        let dirs = ["shots", "issues", "diff"].map { options.out.appending(path: $0) }
        for dir in dirs { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }

        var results: [ShotResult] = []
        var stagePixels: [E2EAppearance: (Data, NSBitmapImageRep)] = [:]
        for appearance in appearances {
            let frame = await settle(shown, appearance: appearance)
            let file = "\(name).\(appearance.rawValue)"
            let bounds = shown.host.bounds.size
            var issues: [E2ELint.Issue] = []
            if lint != .off {
                let lintOptions = E2ELint.Options(stage: shown.stage, shot: file, allow: suite.allow)
                issues = E2ELint.lint(bounds: bounds, elements: frame.tree.elements, options: lintOptions)
                if lint == .warnings {
                    for index in issues.indices where issues[index].severity == .error { issues[index].severity = .warning }
                }
            }
            // The shot's own findings, beside the tree's; the suite's allowlist covers them too.
            var whole: [E2ELint.Issue] = []
            if frame.tree.elements.isEmpty || (frame.image.map { E2ECapture.distinctColors($0) < 3 } ?? true) {
                whole.append(E2ELint.Issue(rule: "blank", severity: .error, message: "Nothing drawn, or no accessibility tree", elements: [], frames: []))
            }
            if !frame.settled {
                whole.append(E2ELint.Issue(rule: "unsettled", severity: .warning, message: "Still changing after 4s; shot anyway", elements: [], frames: []))
            }
            if let image = frame.image, shown.stage {
                stagePixels[appearance] = (E2ECapture.masked(image, frame.masks), image)
                if appearance == .light, let dark = stagePixels[.dark], dark.0 != stagePixels[.light]?.0,
                   let leak = E2ECapture.difference(image, from: dark.1) {
                    whole.append(E2ELint.Issue(
                        rule: "appearance-leak", severity: .warning,
                        message: "The light rendering differs from the dark one (\(leak.changedPixels) px): something reads the system appearance",
                        elements: [], frames: [leak.bbox]
                    ))
                }
            }
            let accepted = whole.filter { issue in !suite.allow.contains { $0.covers(rule: issue.rule, shot: file, identifier: nil, text: nil) } }
            issues = accepted.filter { $0.severity == .error } + issues + accepted.filter { $0.severity != .error }

            let png = "shots/\(file).png"
            if let image = frame.image {
                try E2ECapture.write(image, to: options.out.appending(path: png))
                for index in issues.indices where !issues[index].frames.isEmpty {
                    guard let crop = E2ECapture.crop(image, around: issues[index].frames) else { continue }
                    let path = "issues/\(file)-\(index + 1).png"
                    try E2ECapture.write(crop, to: options.out.appending(path: path))
                    issues[index].crop = path
                }
            }
            report.add(E2EReport.Shot(
                name: name, file: file, surface: shown.name, size: [bounds.width, bounds.height], appearance: appearance,
                route: describe(store.route), telemetry: surfaces.defaults.string(forKey: "telemetryMode") ?? TelemetryPanel.Mode.incidents.rawValue,
                png: png, settledMs: frame.settledMs, settled: frame.settled, masked: frame.masks.count,
                elements: frame.tree.elements.count, issues: issues, diff: frame.image.flatMap { diff($0, file: file) }
            ))
            results.append(ShotResult(png: options.out.appending(path: png).path, issues: issues))
            save()
        }
        return results
    }

    /// Against the same shot in the baseline run, when there is one.
    private func diff(_ image: NSBitmapImageRep, file: String) -> E2EReport.Diff? {
        guard let baseline = options.baseline else { return nil }
        let old = baseline.appending(path: "shots/\(file).png")
        // Said, rather than passed off as unchanged: a baseline from an ONLY run has few shots.
        guard let previous = E2ECapture.read(old) else {
            return E2EReport.Diff(baseline: old.path, changedPixels: 0, bbox: nil, png: nil, missing: true)
        }
        guard previous.pixelsWide == image.pixelsWide, previous.pixelsHigh == image.pixelsHigh else {
            return E2EReport.Diff(baseline: old.path, changedPixels: image.pixelsWide * image.pixelsHigh, bbox: nil, png: nil)
        }
        guard let change = E2ECapture.difference(image, from: previous) else { return nil }
        let png = "diff/\(file).png"
        try? E2ECapture.write(change.image, to: options.out.appending(path: png))
        let box = change.bbox
        return E2EReport.Diff(baseline: old.path, changedPixels: change.changedPixels, bbox: [box.minX, box.minY, box.width, box.height], png: png)
    }

    func describe(_ route: Store.Route) -> String {
        switch route {
        case .overview: "overview"
        case let .session(id): "session:\(id)"
        case let .alert(id): "alert:\(id)"
        }
    }

    // MARK: Inspection (control endpoint)

    /// The current surface's tree and its lint, without taking a shot.
    func tree() -> (surface: String, elements: [E2EElement], issues: [E2ELint.Issue])? {
        guard let shown = surfaces.current else { return nil }
        let tree = E2EAccessibility.walk(shown.host)
        let issues = E2ELint.lint(bounds: shown.host.bounds.size, elements: tree.elements, options: E2ELint.Options(stage: shown.stage, shot: "tree", allow: suite.allow))
        return (shown.name, tree.elements, issues)
    }

    var state: [String: E2EJSON] {
        [
            "route": .string(describe(store.route)),
            "connection": .string("\(store.connection)"),
            "daemon": .string("\(daemon.state)"),
            "surface": surfaces.current.map { .string($0.name) } ?? .null,
            "island": .string("\(island.model.presentation)"),
            "sessions": .number(Double(store.snapshot?.sessions.count ?? 0)),
            "actions": .number(Double(store.actions.count)),
            "alerts": .number(Double(store.snapshot?.alerts.count ?? 0)),
            "shots": .number(Double(report.shots.count)),
        ]
    }
}
#endif
