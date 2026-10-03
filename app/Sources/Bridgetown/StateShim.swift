import SwiftUI

/// SwiftUI's `@State` property wrapper under another name.
///
/// In the macOS 27 SDK `@State` resolves to a macro whose compiler plugin ships only with
/// Xcode, so on a Command Line Tools-only machine every `@State` fails to compile. The
/// underlying property-wrapper struct is unchanged; reaching it through a typealias skips
/// the macro and builds with any SDK.
typealias ViewState<Value> = SwiftUI.State<Value>
