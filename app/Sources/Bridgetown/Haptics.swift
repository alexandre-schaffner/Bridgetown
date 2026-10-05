import AppKit
import OSLog

/// Force Touch trackpad feedback, felt only while a finger is on the trackpad (and not at
/// all on a mouse). Play it only in the handler of the input that caused it (a click, a
/// pointer move), never when state changes: state also changes on its own (snapshots,
/// requests finishing, another view sharing the value), and a tap you didn't cause feels
/// like a glitch. Three feelings, each kept to one meaning:
///
/// - `.alignment`: something snapped into place, like a tab or a card opening.
/// - `.generic`: you moved somewhere, into a session or back out.
/// - `.levelChange`: the island opening under your click.
///
/// One gesture, one tap: a second one within `minimumGap` (hovering the island and
/// pressing it at once, a click that both selects and navigates) is dropped, since two
/// taps that close together feel like a stutter, not two events.
@MainActor
enum Haptics {
    private static let log = Logger(subsystem: "xyz.merkl.bridgetown", category: "haptics")
    private static let minimumGap: TimeInterval = 0.2
    private static var last: Date?

    #if DEBUG
    /// An e2e run plays nothing: its clicks are not yours.
    static var muted = false
    #endif

    /// `source` names the call site in the log (`log stream --predicate 'category == "haptics"'`).
    static func perform(_ pattern: NSHapticFeedbackManager.FeedbackPattern, _ source: StaticString) {
        #if DEBUG
        if muted { return }
        #endif
        let now = Date()
        if let last, now.timeIntervalSince(last) < minimumGap {
            log.debug("\(source, privacy: .public) pattern=\(pattern.rawValue) dropped: too close to the last")
            return
        }
        last = now
        log.debug("\(source, privacy: .public) pattern=\(pattern.rawValue)")
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .drawCompleted)
    }
}
