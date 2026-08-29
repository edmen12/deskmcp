import Foundation

struct RuntimePaths {
    let appSupport: URL
    let logs: URL
    let workspace: URL
    let node: URL
    let gatewayRoot: URL
    let tunnelClient: URL

    static func resolve(bundle: Bundle = .main) throws -> RuntimePaths {
        let fm = FileManager.default
        let supportBase = try fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let support = supportBase.appendingPathComponent("DesktopMCP", isDirectory: true)
        let logs = support.appendingPathComponent("logs", isDirectory: true)
        let workspace = support.appendingPathComponent("workspace", isDirectory: true)
        try fm.createDirectory(at: logs, withIntermediateDirectories: true)
        try fm.createDirectory(at: workspace, withIntermediateDirectories: true)

        let resources = bundle.resourceURL ?? bundle.bundleURL
        return RuntimePaths(
            appSupport: support,
            logs: logs,
            workspace: workspace,
            node: resources.appendingPathComponent("node/bin/node"),
            gatewayRoot: resources.appendingPathComponent("gateway", isDirectory: true),
            tunnelClient: resources.appendingPathComponent("tunnel-client/bin/tunnel-client")
        )
    }
}
