import AppKit
import Darwin
import DeskMCPCore
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
    private var intentionallyStoppingGatewayPID: Int32?
    private var intentionallyStoppingTunnelPID: Int32?
    private var supervisorTask: Task<Void, Never>?
    private var gatewaySupervisor = ServiceSupervisorState()
    private var tunnelSupervisor = ServiceSupervisorState()

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
        startSupervisor()
    }

    private func startSupervisor() {
        guard supervisorTask == nil else { return }
        supervisorTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.supervisorTick()
                do { try await Task.sleep(nanoseconds: 2_000_000_000) }
                catch { return }
            }
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
        let cleanKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validTunnelID(cleanID) else {
            message = "Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters."
            return
        }
        do {
            if !cleanKey.isEmpty { try KeychainStore.save(cleanKey) }
            guard try KeychainStore.read() != nil else {
                message = "A Runtime API Key is required before connecting."
                return
            }
            try configureTunnel(id: cleanID)
            tunnelID = cleanID
            autoStartTunnel = true
            defaults.set(tunnelID, forKey: "tunnelId")
            defaults.set(autoStartTunnel, forKey: "autoStartTunnel")
            restartTunnel()
        } catch let error as KeychainError {
            message = error.localizedDescription
        } catch {
            message = "Could not configure Tunnel: \(error.localizedDescription)"
        }
    }

    func setTunnelAutoStart(_ enabled: Bool) {
        autoStartTunnel = enabled
        defaults.set(enabled, forKey: "autoStartTunnel")
        tunnelSupervisor.reset()
        if enabled {
            Task { [weak self] in await self?.supervisorTick() }
        } else {
            Task { [weak self] in await self?.stopOwnedTunnel() }
        }
    }

    func restartGateway() {
        Task { [weak self] in
            guard let self else { return }
            self.gatewaySupervisor.reset()
            await self.stopGateway()
            self.startGateway()
        }
    }

    func restartTunnel() {
        Task { [weak self] in
            guard let self else { return }
            self.tunnelSupervisor.reset()
            await self.stopOwnedTunnel()
            self.startTunnelIfPossible()
        }
    }

    private static func validTunnelID(_ value: String) -> Bool {
        guard value.count == 39, value.hasPrefix("tunnel_") else { return false }
        return value.dropFirst(7).allSatisfy { $0.isNumber || ("a"..."f").contains(String($0)) }
    }

    private func startGateway() {
        guard gatewayProcess == nil else { return }
        guard let paths else {
            message = "DeskMCP runtime paths are unavailable."
            _ = gatewaySupervisor.recordFailure(now: Self.now)
            return
        }
        let entry = paths.gatewayRoot.appendingPathComponent("dist/src/index.js")
        guard FileManager.default.isExecutableFile(atPath: paths.node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            message = "The bundled Node/Gateway runtime is missing."
            _ = gatewaySupervisor.recordFailure(now: Self.now)
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
        gatewayProcess = process
        process.terminationHandler = { terminated in
            let pid = terminated.processIdentifier
            Task { @MainActor [weak self] in self?.gatewayDidExit(pid: pid) }
        }
        do {
            try process.run()
        } catch {
            if gatewayProcess === process { gatewayProcess = nil }
            _ = gatewaySupervisor.recordFailure(now: Self.now)
            message = "Could not start Gateway: \(error.localizedDescription)"
        }
    }

    private func gatewayDidExit(pid: Int32) {
        guard gatewayProcess?.processIdentifier == pid else { return }
        let intentional = intentionallyStoppingGatewayPID == pid
        gatewayProcess = nil
        gatewayReady = false
        gatewayStatus = "Offline"
        if intentional {
            intentionallyStoppingGatewayPID = nil
        } else {
            _ = gatewaySupervisor.recordFailure(now: Self.now)
        }
    }

    private func stopGateway() async {
        guard let owned = gatewayProcess else { return }
        let pid = owned.processIdentifier
        intentionallyStoppingGatewayPID = pid
        if owned.isRunning {
            await terminateOwnedProcess(owned, timeout: 3)
        }
        if gatewayProcess?.processIdentifier == pid { gatewayProcess = nil }
        if intentionallyStoppingGatewayPID == pid { intentionallyStoppingGatewayPID = nil }
        gatewayReady = false
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
            throw NSError(
                domain: "DeskMCP.Tunnel",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "Tunnel profile setup failed."]
            )
        }
    }

    private func startTunnelIfPossible() {
        guard tunnelProcess == nil,
              autoStartTunnel,
              gatewayReady,
              Self.validTunnelID(tunnelID),
              let paths,
              FileManager.default.isExecutableFile(atPath: paths.tunnelClient.path) else { return }

        let key: String
        do {
            guard let stored = try KeychainStore.read() else {
                tunnelStatus = "Add API key"
                return
            }
            key = stored
        } catch let error as KeychainError {
            tunnelStatus = Self.keychainStatus(error)
            return
        } catch {
            tunnelStatus = "Keychain error"
            return
        }

        let process = Process()
        process.executableURL = paths.tunnelClient
        process.arguments = ["run", "--profile", "desktop-mcp"]
        var environment = ProcessInfo.processInfo.environment
        environment["CONTROL_PLANE_API_KEY"] = key
        process.environment = environment
        tunnelProcess = process
        process.terminationHandler = { terminated in
            let pid = terminated.processIdentifier
            Task { @MainActor [weak self] in self?.tunnelDidExit(pid: pid) }
        }
        do {
            try process.run()
        } catch {
            if tunnelProcess === process { tunnelProcess = nil }
            _ = tunnelSupervisor.recordFailure(now: Self.now)
            message = "Could not start Tunnel: \(error.localizedDescription)"
        }
    }

    private func tunnelDidExit(pid: Int32) {
        guard tunnelProcess?.processIdentifier == pid else { return }
        let intentional = intentionallyStoppingTunnelPID == pid
        tunnelProcess = nil
        tunnelReady = false
        tunnelStatus = "Offline"
        if intentional {
            intentionallyStoppingTunnelPID = nil
        } else {
            _ = tunnelSupervisor.recordFailure(now: Self.now)
        }
    }

    private func stopOwnedTunnel() async {
        guard let process = tunnelProcess else { return }
        let pid = process.processIdentifier
        intentionallyStoppingTunnelPID = pid
        if process.isRunning {
            await terminateOwnedProcess(process, timeout: 3)
        }
        if tunnelProcess?.processIdentifier == pid { tunnelProcess = nil }
        if intentionallyStoppingTunnelPID == pid { intentionallyStoppingTunnelPID = nil }
        tunnelReady = false
    }

    func refreshStatus() async {
        gatewayReady = false
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/health")!)
            request.timeoutInterval = 1
            let (data, response) = try await URLSession.shared.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                let health = try JSONDecoder().decode(GatewayHealth.self, from: data)
                gatewayReady = true
                gatewayStatus = "Running"
                if let running = health.policy?.profile,
                   let parsed = DeskMCPProfile(rawValue: running),
                   parsed != profile {
                    profile = parsed
                }
            }
        } catch {
            gatewayStatus = gatewayProcess?.isRunning == true ? "Starting" : "Offline"
        }

        tunnelReady = false
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8080/readyz")!)
            request.timeoutInterval = 1
            let (data, response) = try await URLSession.shared.data(for: request)
            tunnelReady = (response as? HTTPURLResponse)?.statusCode == 200
                && String(decoding: data, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines) == "ready"
        } catch { }

        if tunnelReady {
            tunnelStatus = "Ready"
        } else if tunnelProcess?.isRunning == true {
            tunnelStatus = "Connecting"
        } else if !Self.validTunnelID(tunnelID) {
            tunnelStatus = "Set Tunnel ID"
        } else {
            do {
                tunnelStatus = try KeychainStore.read() == nil ? "Add API key" : "Offline"
            } catch let error as KeychainError {
                tunnelStatus = Self.keychainStatus(error)
            } catch {
                tunnelStatus = "Keychain error"
            }
        }
    }

    private func supervisorTick() async {
        await refreshStatus()
        let now = Self.now
        let gatewayDecision = gatewaySupervisor.evaluate(
            shouldRun: intentionallyStoppingGatewayPID == nil,
            isRunning: gatewayProcess?.isRunning == true,
            isReady: gatewayReady,
            now: now
        )
        switch gatewayDecision {
        case .none: break
        case .start: startGateway()
        case .stopAndBackoff:
            gatewayStatus = "Restarting"
            await stopGateway()
        }

        let tunnelShouldRun = intentionallyStoppingTunnelPID == nil
            && autoStartTunnel
            && gatewayReady
            && Self.validTunnelID(tunnelID)
            && Self.hasUsableTunnelKey
        let tunnelDecision = tunnelSupervisor.evaluate(
            shouldRun: tunnelShouldRun,
            isRunning: tunnelProcess?.isRunning == true,
            isReady: tunnelReady,
            now: now
        )
        switch tunnelDecision {
        case .none: break
        case .start: startTunnelIfPossible()
        case .stopAndBackoff:
            tunnelStatus = "Retrying"
            await stopOwnedTunnel()
        }
    }

    private static var hasUsableTunnelKey: Bool {
        do { return try KeychainStore.read() != nil }
        catch { return false }
    }

    private static var now: TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    private static func keychainStatus(_ error: KeychainError) -> String {
        switch error {
        case .interactionNotAllowed: return "Unlock Keychain"
        case .accessDenied: return "Keychain denied"
        case .unavailable: return "Keychain unavailable"
        case .invalidData: return "Re-enter API key"
        case .status: return "Keychain error"
        }
    }

    private func waitForExit(_ process: Process, timeout: TimeInterval) async -> Bool {
        let deadline = Self.now + timeout
        while process.isRunning && Self.now < deadline {
            do { try await Task.sleep(nanoseconds: 100_000_000) }
            catch { return !process.isRunning }
        }
        return !process.isRunning
    }

    private func terminateOwnedProcess(_ process: Process, timeout: TimeInterval) async {
        guard process.isRunning else { return }
        process.terminate()
        if await waitForExit(process, timeout: timeout) { return }
        guard process.isRunning else { return }
        _ = Darwin.kill(process.processIdentifier, SIGKILL)
        _ = await waitForExit(process, timeout: 1)
    }

    func shutdownOwnedServices() async {
        supervisorTask?.cancel()
        supervisorTask = nil
        await stopOwnedTunnel()
        await stopGateway()
    }
}
