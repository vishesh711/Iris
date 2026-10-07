// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "IrisClient",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "IrisClient",
            path: "Sources/IrisClient"
        )
    ]
)
