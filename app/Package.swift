// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Bridgetown",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Bridgetown",
            path: "Sources/Bridgetown"
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
