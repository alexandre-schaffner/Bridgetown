// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Bridgetown",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Bridgetown",
            dependencies: ["Termination", "ThinkingOrbs"],
            path: "Sources/Bridgetown"
        ),
        .target(name: "Termination", path: "Sources/Termination"),
        // Libraries.dev's ThinkingOrbsKit (MIT, LICENSE included), as of bfcb863,
        // less its snapshot helper, plus a tint.
        .target(
            name: "ThinkingOrbs",
            path: "Sources/ThinkingOrbs",
            exclude: ["LICENSE"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // A bare app that quits as Bridgetown does, which AppTerminationTests runs.
        .executableTarget(
            name: "TerminationHarness",
            dependencies: ["Termination"],
            path: "Sources/TerminationHarness"
        ),
        // swift-testing (`import Testing`), which ships with the Command Line Tools;
        // XCTest needs a full Xcode. Run with `make test-app` or `swift test`.
        .testTarget(
            name: "BridgetownTests",
            dependencies: ["Bridgetown"],
            path: "Tests/BridgetownTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
