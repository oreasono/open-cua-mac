// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AXHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AXHelper", path: "Sources/AXHelper"),
    ]
)
