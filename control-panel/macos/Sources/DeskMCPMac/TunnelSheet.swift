import SwiftUI

struct TunnelSheet: View {
    @EnvironmentObject private var model: DeskMCPModel
    @Environment(\.dismiss) private var dismiss
    @State private var tunnelID = ""
    @State private var runtimeKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connect Tunnel").font(.title2.bold())
            Text("Paste the Tunnel ID and Runtime API Key from OpenAI Platform. The key is stored in macOS Keychain and is not written to UserDefaults.")
                .font(.callout).foregroundStyle(.secondary)

            Text("Tunnel ID").font(.caption.weight(.semibold))
            TextField("tunnel_…", text: $tunnelID)
                .textFieldStyle(.roundedBorder)

            Text("Runtime API Key").font(.caption.weight(.semibold))
            SecureField("Leave blank to keep the existing key", text: $runtimeKey)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button("Cancel") { dismiss() }
                Spacer()
                Button("Save & Connect") {
                    model.saveTunnel(id: tunnelID, key: runtimeKey)
                    if model.message == nil { dismiss() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.blue)
            }
        }
        .padding(20)
        .frame(width: 380)
        .onAppear { tunnelID = model.tunnelID }
    }
}
