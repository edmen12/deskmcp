import AppKit
import SwiftUI

struct PanelView: View {
    @EnvironmentObject private var model: DeskMCPModel
    @State private var showTunnel = false
    @State private var showFullWarning = false
    @State private var showUnlockWarning = false

    var body: some View {
        VStack(spacing: 16) {
            header
            statusGrid
            profileSection
            workspaceSection
            actions
            Divider()
            settingsSection
        }
        .padding(18)
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $showTunnel) { TunnelSheet().environmentObject(model) }
        .alert("Enable Full Control?", isPresented: $showFullWarning) {
            Button("Cancel", role: .cancel) { }
            Button("Enable", role: .destructive) { model.setProfile(.fullControl) }
        } message: {
            Text("Gateway-owned terminal sessions use your current macOS user permissions. Workspace file tools remain scoped, but terminal sessions are not filesystem-sandboxed by that workspace boundary. This mode is session-only.")
        }
        .alert("Fully unlock DeskMCP?", isPresented: $showUnlockWarning) {
            Button("Cancel", role: .cancel) { }
            Button("Unlock", role: .destructive) { model.setProfile(.fullyUnlocked) }
        } message: {
            Text("DeskMCP will stop enforcing Workspace, sensitive-path, and fresh-observation write guards for this session. File and terminal access is then limited only by your macOS account permissions and remote-client policy.")
        }

    }
    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.cyan)
            VStack(alignment: .leading, spacing: 2) {
                Text("DeskMCP").font(.title2.bold())
                Text("Your desktop. Connected to AI.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Label(model.gatewayReady && model.tunnelReady ? "Live" : "Local",
                  systemImage: "circle.fill")
                .font(.caption.bold())
                .foregroundStyle(model.gatewayReady && model.tunnelReady ? .green : .orange)
        }
    }

    private var statusGrid: some View {
        HStack(spacing: 10) {
            statusCard("Gateway", model.gatewayStatus, ready: model.gatewayReady)
            statusCard("Tunnel", model.tunnelStatus, ready: model.tunnelReady)
        }
    }

    private func statusCard(_ title: String, _ value: String, ready: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Circle().fill(ready ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(value).font(.callout.weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
    private var profileSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Permission profile").font(.headline)
                Spacer()
                Text(model.profile.title.uppercased())
                    .font(.caption.bold())
                    .foregroundStyle(model.profile == .fullyUnlocked ? .red : model.profile == .fullControl ? .orange : model.profile == .workspaceWrite ? .blue : .secondary)
            }
            HStack(spacing: 6) {
                profileButton(.readOnly)
                profileButton(.workspaceWrite)
                profileButton(.fullControl)
                profileButton(.fullyUnlocked)
            }
            .padding(4)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    private func profileButton(_ value: DeskMCPProfile) -> some View {
        Button(value.title) {
            if value == .fullControl { showFullWarning = true }
            else if value == .fullyUnlocked { showUnlockWarning = true }
            else { model.setProfile(value) }
        }
        .buttonStyle(.plain)
        .font(.callout.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(model.profile == value ? Color(nsColor: .selectedContentBackgroundColor).opacity(0.20) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: 9))
    }

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Workspace").font(.caption).foregroundStyle(.secondary)
            HStack {
                Text(model.workspace).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Change") { model.chooseWorkspace() }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
    private var actions: some View {
        HStack(spacing: 10) {
            Button("Restart Gateway") { model.restartGateway() }
                .buttonStyle(.borderedProminent)
                .tint(.blue)
                .frame(maxWidth: .infinity)
            Button("Tunnel") { showTunnel = true }
                .buttonStyle(.bordered)
        }
    }

    private var settingsSection: some View {
        VStack(spacing: 10) {
            Toggle("Start DeskMCP at login", isOn: Binding(
                get: { model.startAtLogin },
                set: { model.setStartAtLogin($0) }
            ))
            Toggle("Start Tunnel automatically", isOn: Binding(
                get: { model.autoStartTunnel },
                set: { model.setTunnelAutoStart($0) }
            ))
            HStack {
                if let message = model.message {
                    Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                Button("Quit") {
                    Task {
                        await model.shutdownOwnedServices()
                        NSApplication.shared.terminate(nil)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }
}
