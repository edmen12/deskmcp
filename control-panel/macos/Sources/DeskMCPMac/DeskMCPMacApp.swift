import SwiftUI

@main
struct DeskMCPMacApp: App {
    @StateObject private var model = DeskMCPModel()

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environmentObject(model)
                .frame(width: 390)
        } label: {
            Image(systemName: model.gatewayReady ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark")
        }
        .menuBarExtraStyle(.window)
    }
}

enum DeskMCPProfile: String, CaseIterable, Identifiable {
    case readOnly = "read-only"
    case workspaceWrite = "workspace-write"
    case fullControl = "full-control"
    case fullyUnlocked = "fully-unlocked"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .readOnly: return "Read"
        case .workspaceWrite: return "Write"
        case .fullControl: return "Full"
        case .fullyUnlocked: return "Unlock"
        }
    }
}
