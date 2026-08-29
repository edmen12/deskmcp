// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DeskMCPMac",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "DeskMCPCore", targets: ["DeskMCPCore"]),
        .executable(name: "DeskMCPMac", targets: ["DeskMCPMac"])
    ],
    targets: [
        .target(
            name: "DeskMCPCore",
            path: "Sources/DeskMCPCore"
        ),
        .executableTarget(
            name: "DeskMCPMac",
            dependencies: ["DeskMCPCore"],
            path: "Sources/DeskMCPMac"
        ),
        .testTarget(
            name: "DeskMCPCoreTests",
            dependencies: ["DeskMCPCore"],
            path: "Tests/DeskMCPCoreTests"
        )
    ]
)
