import Foundation
import Testing
@testable import DeskMCPCore

struct TunnelRuntimeStatusPolicyTests {
    private let tunnelID = "tunnel_00000000000000000000000000000000"
    private let now = Date(timeIntervalSince1970: 2_000)

    private var goodStatus: String {
        "{\"control_plane_tunnel_id\":\"\(tunnelID)\",\"mcp_server_url\":\"http://127.0.0.1:8765/mcp\",\"tunnel_metadata\":{\"ID\":\"\(tunnelID)\"}}"
    }

    @Test func exactTunnelAndFreshControlPlanePollAreRequired() {
        let good = TunnelRuntimeStatusPolicy.evaluate(
            expectedTunnelID: tunnelID,
            readyRequestOK: true,
            readyBody: "ready\n",
            statusBody: goodStatus,
            metricsBody: "commands_poll_last_successful_timestamp_seconds 1995\n",
            now: now
        )
        #expect(good.ready)
        #expect(good.detail == "Ready")

        let localOnly = TunnelRuntimeStatusPolicy.evaluate(
            expectedTunnelID: tunnelID,
            readyRequestOK: true,
            readyBody: "ready",
            statusBody: goodStatus,
            metricsBody: "",
            now: now
        )
        #expect(!localOnly.ready)
        #expect(localOnly.detail.contains("first successful"))

        let stale = TunnelRuntimeStatusPolicy.evaluate(
            expectedTunnelID: tunnelID,
            readyRequestOK: true,
            readyBody: "ready",
            statusBody: goodStatus,
            metricsBody: "commands_poll_last_successful_timestamp_seconds 1800\n",
            now: now
        )
        #expect(!stale.ready)
        #expect(stale.detail.contains("stale"))
    }

    @Test func wrongEndpointTunnelOrCredentialCannotReportReady() {
        let wrongEndpoint = TunnelRuntimeStatusPolicy.evaluate(
            expectedTunnelID: tunnelID,
            readyRequestOK: true,
            readyBody: "ready",
            statusBody: "{\"control_plane_tunnel_id\":\"\(tunnelID)\",\"mcp_server_url\":\"http://127.0.0.1:9999/mcp\",\"tunnel_metadata\":{\"ID\":\"\(tunnelID)\"}}",
            metricsBody: "commands_poll_last_successful_timestamp_seconds 1995\n",
            now: now
        )
        #expect(!wrongEndpoint.ready)
        #expect(!wrongEndpoint.endpointMatchesExpected)

        let otherID = "tunnel_11111111111111111111111111111111"
        let wrongTunnel = TunnelRuntimeStatusPolicy.evaluate(
            expectedTunnelID: tunnelID,
            readyRequestOK: true,
            readyBody: "ready",
            statusBody: "{\"control_plane_tunnel_id\":\"\(otherID)\",\"mcp_server_url\":\"http://127.0.0.1:8765/mcp\",\"tunnel_metadata\":{\"ID\":\"\(otherID)\"}}",
            metricsBody: "commands_poll_last_successful_timestamp_seconds 1995\n",
            now: now
        )
        #expect(!wrongTunnel.ready)
        #expect(wrongTunnel.tunnelIDMismatch)

        let rejected = TunnelRuntimeStatusPolicy.evaluate(
            expectedTunnelID: tunnelID,
            readyRequestOK: true,
            readyBody: "ready",
            statusBody: "status 401 unauthorized {\"error\":{\"code\":\"invalid_api_key\"}}",
            metricsBody: "commands_poll_last_successful_timestamp_seconds 1995\n",
            now: now
        )
        #expect(!rejected.ready)
        #expect(rejected.credentialRejected)
    }
}
