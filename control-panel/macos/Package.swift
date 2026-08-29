// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DeskMCPMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "DeskMCPMac", targets: ["DeskMCPMac"])
    ],
    targets: [
        .executableTarget(
            name: "DeskMCPMac",
            path: "Sources/DeskMCPMac"
        )
    ]
)
