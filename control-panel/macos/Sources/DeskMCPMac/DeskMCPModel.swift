import AppKit
import Foundation
import ServiceManagement
import SwiftUI

private struct GatewayHealth: Decodable {
    struct Policy: Decodable { let profile: String? }
    let version: String?
    let policy: Policy?
}

@MainActor
final class DeskMCPModel: ObservableObject {
    @Published var gatewayReady = false
    @Published var tunnelReady = false
    @Published var gatewayStatus = "Checking"
    @Published var tunnelStatus = "Checking"
    @Published var profile: DeskMCPProfile = .readOnly
    @Published var workspace = ""
    @Published var tunnelID = ""
    @Published var autoStartTunnel = false
    @Published var startAtLogin = false
    @Published var message: String?

    private let defaults = UserDefaults.standard
    private let paths: RuntimePaths?
    private var gatewayProcess: Process?
    private var tunnelProcess: Process?

    init() {
        paths = try? RuntimePaths.resolve()
        let defaultWorkspace = paths?.workspace.path ?? FileManager.default.homeDirectoryForCurrentUser.path
        workspace = defaults.string(forKey: "workspace") ?? defaultWorkspace
        tunnelID = defaults.string(forKey: "tunnelId") ?? ""
        autoStartTunnel = defaults.bool(forKey: "autoStartTunnel")
        let storedProfile = defaults.string(forKey: "profile")
        profile = storedProfile == DeskMCPProfile.workspaceWrite.rawValue ? .workspaceWrite : .readOnly
        if #available(macOS 13.0, *) {
            startAtLogin = SMAppService.mainApp.status == .enabled
        }
    }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.title = "Choose DeskMCP Workspace"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: workspace, isDirectory: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        workspace = url.path
        defaults.set(workspace, forKey: "workspace")
        restartGateway()
    }

    func setProfile(_ value: DeskMCPProfile) {
        profile = value
        if value != .fullControl {
            defaults.set(value.rawValue, forKey: "profile")
        }
        restartGateway()
    }

    func setStartAtLogin(_ enabled: Bool) {
        guard #available(macOS 13.0, *) else { return }
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            startAtLogin = SMAppService.mainApp.status == .enabled
        } catch {
            message = "Could not update Login Item: \(error.localizedDescription)"
            startAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
    func saveTunnel(id: String, key: String) {
        message = nil
        let cleanID = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validTunnelID(cleanID) else {
            message = "Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters."
            return
        }
        do {
            if !key.isEmpty { try KeychainStore.save(key.trimmingCharacters(in: .whitespacesAndNewlines)) }
            guard KeychainStore.read() != nil else {
                message = "A Runtime API Key is required before connecting."
                return
            }
            try configureTunnel(id: cleanID)
            tunnelID = cleanID
            autoStartTunnel = true
            defaults.set(tunnelID, forKey: "tunnelId")
            defaults.set(autoStartTunnel, forKey: "autoStartTunnel")
            restartTunnel()
        } catch {
            message = "Could not configure Tunnel: \(error.localizedDescription)"
        }
    }

    func setTunnelAutoStart(_ enabled: Bool) {
        autoStartTunnel = enabled
        defaults.set(enabled, forKey: "autoStartTunnel")
        if enabled { startTunnelIfPossible() }
        else { stopOwnedTunnel() }
    }

    func restartGateway() {
        stopGateway()
        startGateway()
    }

    func restartTunnel() {
        stopOwnedTunnel()
        startTunnelIfPossible()
    }

    private static func validTunnelID(_ value: String) -> Bool {
        guard value.count == 39, value.hasPrefix("tunnel_") else { return false }
        return value.dropFirst(7).allSatisfy { $0.isNumber || ("a"..."f").contains(String($0)) }
    }
    private func startGateway() {
        guard let paths else { message = "DeskMCP runtime paths are unavailable."; return }
        let entry = paths.gatewayRoot.appendingPathComponent("dist/src/index.js")
        guard FileManager.default.isExecutableFile(atPath: paths.node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            message = "The bundled Node/Gateway runtime is missing."
            return
        }
        let process = Process()
        process.executableURL = paths.node
        process.arguments = ["dist/src/index.js"]
        process.currentDirectoryURL = paths.gatewayRoot
        var environment = ProcessInfo.processInfo.environment
        environment["DESKTOP_MCP_PROFILE"] = profile.rawValue
        environment["DESKTOP_MCP_ALLOWED_ROOTS"] = workspace
        environment["DESKTOP_MCP_AUDIT_LOG"] = paths.logs.appendingPathComponent("audit.jsonl").path
        process.environment = environment
        do {
            try process.run()
            gatewayProcess = process
            process.terminationHandler = { _ in Task { @MainActor in self.gatewayProcess = nil } }
        } catch {
            message = "Could not start Gateway: \(error.localizedDescription)"
        }
    }

    private func stopGateway() {
        guard let paths else { return }
        let stopScript = paths.gatewayRoot.appendingPathComponent("dist/src/stop.js")
        guard FileManager.default.isExecutableFile(atPath: paths.node.path),
              FileManager.default.fileExists(atPath: stopScript.path) else {
            gatewayProcess?.terminate(); gatewayProcess = nil; return
        }
        let process = Process()
        process.executableURL = paths.node
        process.arguments = ["dist/src/stop.js"]
        process.currentDirectoryURL = paths.gatewayRoot
        try? process.run()
        process.waitUntilExit()
        gatewayProcess = nil
    }
    private func configureTunnel(id: String) throws {
        guard let paths, FileManager.default.isExecutableFile(atPath: paths.tunnelClient.path) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let process = Process()
        process.executableURL = paths.tunnelClient
        process.arguments = [
            "init", "--sample", "sample_mcp_remote_no_auth",
            "--profile", "desktop-mcp",
            "--tunnel-id", id,
            "--mcp-server-url", "http://127.0.0.1:8765/mcp",
            "--force"
        ]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "DeskMCP.Tunnel", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "Tunnel profile setup failed."])
        }
    }

    private func startTunnelIfPossible() {
        guard autoStartTunnel, Self.validTunnelID(tunnelID), tunnelProcess == nil,
              let key = KeychainStore.read(), !key.isEmpty,
              let paths, FileManager.default.isExecutableFile(atPath: paths.tunnelClient.path) else { return }
        let process = Process()
        process.executableURL = paths.tunnelClient
        process.arguments = ["run", "--profile", "desktop-mcp"]
        var environment = ProcessInfo.processInfo.environment
        environment["CONTROL_PLANE_API_KEY"] = key
        process.environment = environment
        do {
            try process.run()
            tunnelProcess = process
            process.terminationHandler = { _ in Task { @MainActor in self.tunnelProcess = nil } }
        } catch {
            message = "Could not start Tunnel: \(error.localizedDescription)"
        }
    }

    private func stopOwnedTunnel() {
        guard let process = tunnelProcess else { return }
        if process.isRunning { process.terminate() }
        tunnelProcess = nil
    }
    func refreshStatus() async {
        gatewayReady = false
        tunnelReady = false
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/health")!)
            request.timeoutInterval = 1
            let (data, response) = try await URLSession.shared.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                let health = try JSONDecoder().decode(GatewayHealth.self, from: data)
                gatewayReady = true
                gatewayStatus = "Running"
                if let running = health.policy?.profile,
                   let parsed = DeskMCPProfile(rawValue: running), parsed != profile {
                    profile = parsed
                }
            }
        } catch {
            gatewayStatus = gatewayProcess?.isRunning == true ? "Starting" : "Offline"
        }

        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8080/readyz")!)
            request.timeoutInterval = 1
            let (data, response) = try await URLSession.shared.data(for: request)
            tunnelReady = (response as? HTTPURLResponse)?.statusCode == 200 && String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "ready"
            tunnelStatus = tunnelReady ? "Ready" : (tunnelProcess?.isRunning == true ? "Connecting" : "Offline")
        } catch {
            if !Self.validTunnelID(tunnelID) { tunnelStatus = "Set Tunnel ID" }
            else if KeychainStore.read() == nil { tunnelStatus = "Add API key" }
            else { tunnelStatus = tunnelProcess?.isRunning == true ? "Connecting" : "Offline" }
        }

        if !gatewayReady && gatewayProcess == nil { startGateway() }
        if gatewayReady && !tunnelReady { startTunnelIfPossible() }
    }

    func shutdownOwnedServices() {
        stopOwnedTunnel()
        stopGateway()
    }
}
