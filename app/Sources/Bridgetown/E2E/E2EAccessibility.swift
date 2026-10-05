#if DEBUG
import AppKit

/// The accessibility tree of a surface, read in-process: no permission is needed to read
/// our own views, once AppKit is told an assistive client is there.
///
/// SwiftUI's nodes (`AccessibilityNode`) answer the NSAccessibility selectors but don't
/// bridge to `NSAccessibilityProtocol` in Swift, and KVC on them hangs, so every read goes
/// through the selector: `perform` for objects, the method's implementation cast to a C
/// function for structs and BOOLs.
@MainActor
enum E2EAccessibility {
    /// A surface's elements, and the node behind each, for pressing and typing.
    struct Tree {
        var elements: [E2EElement] = []
        var nodes: [AnyObject] = []
    }

    /// Without these SwiftUI builds no tree below the hosting view's first level.
    static func enable() {
        for attribute in ["AXEnhancedUserInterface", "AXManualAccessibility"] {
            _ = NSApp.perform(NSSelectorFromString("accessibilitySetValue:forAttribute:"), with: true, with: attribute)
        }
    }

    /// Every element under `host`, in tree order, with frames in the window's points from
    /// its top-left corner.
    static func walk(_ host: NSView) -> Tree {
        guard let window = host.window else { return Tree() }
        var tree = Tree()
        func visit(_ node: AnyObject, parent: Int?, scrollArea: Int?, depth: Int) {
            guard depth < 80, tree.nodes.count < 6_000 else { return }
            let id = tree.elements.count
            let role = string(node, "accessibilityRole") ?? ""
            let interactive = E2EElement.interactiveRoles.contains(role)
            var label = string(node, "accessibilityLabel") ?? string(node, "accessibilityTitle") ?? ""
            // A Form's switch has no label of its own: the text beside it is its title element.
            if label.isEmpty, interactive, let title = object(node, "accessibilityTitleUIElement") {
                label = string(title, "accessibilityValue") ?? string(title, "accessibilityLabel") ?? ""
            }
            let value = string(node, "accessibilityValue") ?? ""
            // Static text draws its value (its font runs index into it); a Form labels a row's
            // value with the row's title, which is not what is drawn there.
            let text = role == "AXStaticText" ? (value.isEmpty ? label : value) : (label.isEmpty ? value : label)
            let identifier = string(node, "accessibilityIdentifier").flatMap { $0.isEmpty ? nil : $0 }
            let screen = frame(node)
            let local = CGRect(x: screen.minX - window.frame.minX, y: window.frame.maxY - screen.maxY, width: screen.width, height: screen.height)
            let actions = customActions(node).compactMap(\.name)
            tree.elements.append(E2EElement(
                id: id,
                parent: parent,
                role: role,
                identifier: identifier,
                text: text.isEmpty ? nil : text,
                placeholder: string(node, "accessibilityPlaceholderValue").flatMap { $0.isEmpty ? nil : $0 },
                frame: local,
                scrollArea: scrollArea,
                runs: role == "AXStaticText" ? runs(node) : [],
                actions: actions
            ))
            tree.nodes.append(node)
            let inner = role == "AXScrollArea" ? id : scrollArea
            for child in children(node) { visit(child, parent: id, scrollArea: inner, depth: depth + 1) }
        }
        for child in (host.accessibilityChildren() ?? []).map({ $0 as AnyObject }) {
            visit(child, parent: nil, scrollArea: nil, depth: 0)
        }
        return tree
    }

    // MARK: Acting

    /// AXPress: a Button, a Toggle, or a view's default `accessibilityAction`. An AppKit
    /// control SwiftUI puts in a Form (Settings' switches) that refuses it is clicked.
    static func press(_ node: AnyObject) -> Bool {
        let selector = NSSelectorFromString("accessibilityPerformPress")
        if let object = node as? NSObject, object.responds(to: selector) {
            typealias Press = @convention(c) (AnyObject, Selector) -> Bool
            if unsafeBitCast(object.method(for: selector), to: Press.self)(object, selector) { return true }
        }
        guard let control = node as? NSControl, control.isEnabled else { return false }
        control.performClick(nil)
        return true
    }

    /// A named action (`accessibilityAction(named:)`).
    static func perform(_ name: String, on node: AnyObject) -> Bool {
        guard let action = customActions(node).first(where: { $0.name == name }) else { return false }
        if let handler = action.handler { return handler() }
        if let target = action.target as? NSObject, let selector = action.selector {
            _ = target.perform(selector, with: action)
            return true
        }
        return false
    }

    /// Types into the text field at `frame` (window points, top-left origin) as a keyboard
    /// would: the field's text, then its delegate told, which is how SwiftUI's binding hears it.
    static func type(_ text: String, at frame: CGRect, in host: NSView) -> Bool {
        if let field = view(NSTextField.self, at: frame, in: host) {
            field.stringValue = text
            field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
            return true
        }
        if let textView = view(NSTextView.self, at: frame, in: host) {
            textView.string = text
            textView.didChangeText()
            return true
        }
        return false
    }

    /// The AppKit scroll view a SwiftUI `ScrollView` at `frame` is built on.
    static func scrollView(at frame: CGRect, in host: NSView) -> NSScrollView? {
        view(NSScrollView.self, at: frame, in: host)
    }

    /// The AppKit view of `kind` under the host that covers most of `frame`. Hit-testing
    /// can't find it: the hosting view draws SwiftUI's content itself and answers for it.
    private static func view<Kind: NSView>(_ kind: Kind.Type, at frame: CGRect, in host: NSView) -> Kind? {
        guard let window = host.window else { return nil }
        func all(_ view: NSView) -> [Kind] {
            view.subviews.flatMap { [$0 as? Kind].compactMap { $0 } + all($0) }
        }
        let covering = all(host).map { candidate -> (Kind, CGFloat) in
            let rect = candidate.convert(candidate.bounds, to: nil)
            let local = CGRect(x: rect.minX, y: window.frame.height - rect.maxY, width: rect.width, height: rect.height)
            let shared = local.intersection(frame)
            return (candidate, shared.isNull ? 0 : shared.width * shared.height)
        }
        return covering.filter { $0.1 > 0 }.max { $0.1 < $1.1 }?.0
    }

    // MARK: Reading

    private static func object(_ node: AnyObject, _ name: String) -> AnyObject? {
        let selector = NSSelectorFromString(name)
        guard let object = node as? NSObject, object.responds(to: selector) else { return nil }
        return object.perform(selector)?.takeUnretainedValue()
    }

    private static func string(_ node: AnyObject, _ name: String) -> String? {
        switch object(node, name) {
        case let text as String: text
        case let text as NSAttributedString: text.string
        default: nil
        }
    }

    private static func children(_ node: AnyObject) -> [AnyObject] {
        (object(node, "accessibilityChildren") as? [AnyObject]) ?? []
    }

    private static func customActions(_ node: AnyObject) -> [NSAccessibilityCustomAction] {
        (object(node, "accessibilityCustomActions") as? [NSAccessibilityCustomAction]) ?? []
    }

    private static func frame(_ node: AnyObject) -> CGRect {
        let selector = NSSelectorFromString("accessibilityFrame")
        guard let object = node as? NSObject, object.responds(to: selector) else { return .zero }
        typealias Frame = @convention(c) (AnyObject, Selector) -> NSRect
        return unsafeBitCast(object.method(for: selector), to: Frame.self)(object, selector)
    }

    /// The font of each run of the element's text, from its AXFont attribute. The range
    /// comes from the element itself: one past its end raises, and an Objective-C exception
    /// unwinding through Swift leaves the concurrency runtime corrupt.
    private static func runs(_ node: AnyObject) -> [E2EElement.Run] {
        let selector = NSSelectorFromString("accessibilityAttributedStringForRange:")
        let count = NSSelectorFromString("accessibilityNumberOfCharacters")
        guard let object = node as? NSObject, object.responds(to: selector), object.responds(to: count) else { return [] }
        typealias Length = @convention(c) (AnyObject, Selector) -> Int
        let length = unsafeBitCast(object.method(for: count), to: Length.self)(object, count)
        guard length > 0 else { return [] }
        typealias Attributed = @convention(c) (AnyObject, Selector, NSRange) -> Unmanaged<NSAttributedString>?
        guard let text = unsafeBitCast(object.method(for: selector), to: Attributed.self)(object, selector, NSRange(location: 0, length: length))?
            .takeUnretainedValue()
        else { return [] }
        var runs: [E2EElement.Run] = []
        text.enumerateAttribute(NSAttributedString.Key("AXFont"), in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let font = value as? [String: Any], let name = font["AXFontName"] as? String else { return }
            let size = (font["AXFontSize"] as? NSNumber)?.doubleValue ?? 0
            runs.append(E2EElement.Run(location: range.location, length: range.length, font: name, size: size))
        }
        return runs
    }
}
#endif
