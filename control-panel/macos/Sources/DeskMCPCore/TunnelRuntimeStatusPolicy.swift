import Foundation

public struct TunnelRuntimeEvaluation: Equatable {
    public let ready: Bool
    public let localReady: Bool
    public let endpointMatchesExpected: Bool
    public let controlPlaneReady: Bool
    public let credentialRejected: Bool
    public let tunnelIDMismatch: Bool
    public let detail: String

    public init(
        ready: Bool,
        localReady: Bool,
        endpointMatchesExpected: Bool,
        controlPlaneReady: Bool,
        credentialRejected: Bool,
        tunnelIDMismatch: Bool,
        detail: String
    ) {
        self.ready = ready
        self.localReady = localReady
        self.endpointMatchesExpected = endpointMatchesExpected
        self.controlPlaneReady = controlPlaneReady
        self.credentialRejected = credentialRejected
        self.tunnelIDMismatch = tunnelIDMismatch
        self.detail = detail
    }
}

public enum TunnelRuntimeStatusPolicy {
    private static let expectedMCPURL = "http://127.0.0.1:8765/mcp"
    private static let pollFreshness: TimeInterval = 90

    public static func evaluate(
        expectedTunnelID: String,
        readyRequestOK: Bool,
        readyBody: String,
        statusBody: String,
        metricsBody: String,
        now: Date
    ) -> TunnelRuntimeEvaluation {
        let localReady = readyRequestOK && readyBody.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "ready"
        var endpointMatches = false
        var controlPlaneReady = false
        var credentialRejected = false
        var tunnelIDMismatch = false
        var detail = "Local tunnel is not ready."

        if statusBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "Tunnel status is unavailable.")
        }
        if isCredentialError(statusBody) {
            credentialRejected = true
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "OpenAI rejected the Runtime API key.")
        }
        guard let data = statusBody.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "Tunnel status JSON is invalid.")
        }

        endpointMatches = (root["mcp_server_url"] as? String)?.caseInsensitiveCompare(expectedMCPURL) == .orderedSame
        guard endpointMatches else {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "The running tunnel belongs to a different MCP endpoint.")
        }

        let runtimeTunnelID = root["control_plane_tunnel_id"] as? String
        guard runtimeTunnelID == expectedTunnelID else {
            tunnelIDMismatch = true
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "Tunnel ID does not match the DeskMCP configuration.")
        }

        if let metadataError = root["tunnel_metadata_error"] as? String, !metadataError.isEmpty {
            credentialRejected = isCredentialError(metadataError)
            detail = credentialRejected ? "OpenAI rejected the Runtime API key." : "OpenAI tunnel metadata is unavailable."
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, detail)
        }

        let metadata = root["tunnel_metadata"] as? [String: Any]
        let metadataID = (metadata?["ID"] as? String) ?? (metadata?["Id"] as? String) ?? (metadata?["id"] as? String)
        guard metadataID == expectedTunnelID else {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "OpenAI tunnel metadata has not been confirmed yet.")
        }
        guard localReady else {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "Local tunnel is not ready.")
        }

        guard let lastPoll = metric(metricsBody, name: "commands_poll_last_successful_timestamp_seconds"), lastPoll > 0 else {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "Waiting for the first successful OpenAI control-plane poll.")
        }
        let age = now.timeIntervalSince1970 - lastPoll
        guard age >= 0, age <= pollFreshness else {
            return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "OpenAI control-plane polling is stale.")
        }

        controlPlaneReady = true
        return result(localReady, endpointMatches, controlPlaneReady, credentialRejected, tunnelIDMismatch, "Ready")
    }

    private static func result(
        _ localReady: Bool,
        _ endpointMatchesExpected: Bool,
        _ controlPlaneReady: Bool,
        _ credentialRejected: Bool,
        _ tunnelIDMismatch: Bool,
        _ detail: String
    ) -> TunnelRuntimeEvaluation {
        TunnelRuntimeEvaluation(
            ready: localReady && endpointMatchesExpected && controlPlaneReady && !credentialRejected && !tunnelIDMismatch,
            localReady: localReady,
            endpointMatchesExpected: endpointMatchesExpected,
            controlPlaneReady: controlPlaneReady,
            credentialRejected: credentialRejected,
            tunnelIDMismatch: tunnelIDMismatch,
            detail: detail
        )
    }

    private static func isCredentialError(_ value: String) -> Bool {
        let lower = value.lowercased()
        return lower.contains("invalid_api_key")
            || lower.contains("incorrect api key")
            || lower.contains("status 401")
            || lower.contains("unauthorized")
    }

    private static func metric(_ text: String, name: String) -> Double? {
        for rawLine in text.split(whereSeparator: { $0.isNewline }) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#") || !line.hasPrefix(name) { continue }
            if line.count > name.count {
                let index = line.index(line.startIndex, offsetBy: name.count)
                let separator = line[index]
                if separator != "{" && !separator.isWhitespace { continue }
            }
            guard let rawValue = line.split(whereSeparator: { $0.isWhitespace }).last,
                  let value = Double(rawValue) else { continue }
            return value
        }
        return nil
    }
}
