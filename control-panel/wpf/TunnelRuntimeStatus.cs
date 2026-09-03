using System;
using System.Globalization;
using System.Text.Json;

internal sealed class TunnelRuntimeStatus
{
    public bool LocalReady { get; set; }
    public bool EndpointMatchesExpected { get; set; }
    public bool ControlPlaneReady { get; set; }
    public bool CredentialRejected { get; set; }
    public bool TunnelIdMismatch { get; set; }
    public string Detail { get; set; }
    public bool Ready { get { return LocalReady && EndpointMatchesExpected && ControlPlaneReady && !CredentialRejected && !TunnelIdMismatch; } }
}

internal static class TunnelRuntimeStatusEvaluator
{
    private static readonly TimeSpan PollFreshness = TimeSpan.FromSeconds(90);

    public static TunnelRuntimeStatus Evaluate(string expectedTunnelId, bool readyRequestOk, string readyBody, string statusJson, string metricsText, DateTimeOffset now)
    {
        TunnelRuntimeStatus result = new TunnelRuntimeStatus { Detail = "Local tunnel is not ready." };
        result.LocalReady = readyRequestOk && String.Equals((readyBody ?? "").Trim(), "ready", StringComparison.OrdinalIgnoreCase);

        if (String.IsNullOrWhiteSpace(statusJson))
        {
            result.Detail = "Tunnel status is unavailable.";
            return result;
        }
        if (IsCredentialError(statusJson))
        {
            result.CredentialRejected = true;
            result.Detail = "OpenAI rejected the Runtime API key.";
            return result;
        }
        try
        {
            using (JsonDocument document = JsonDocument.Parse(statusJson))
            {
                JsonElement root = document.RootElement;
                string mcpServerUrl = ReadString(root, "mcp_server_url");
                result.EndpointMatchesExpected = String.Equals(mcpServerUrl, "http://127.0.0.1:8765/mcp", StringComparison.OrdinalIgnoreCase);
                if (!result.EndpointMatchesExpected)
                {
                    result.Detail = "The running tunnel belongs to a different MCP endpoint.";
                    return result;
                }

                string runtimeTunnelId = ReadString(root, "control_plane_tunnel_id");
                if (!String.Equals(runtimeTunnelId, expectedTunnelId, StringComparison.Ordinal))
                {
                    result.TunnelIdMismatch = true;
                    result.Detail = "Tunnel ID does not match the DeskMCP configuration.";
                    return result;
                }

                string metadataError = ReadString(root, "tunnel_metadata_error");
                if (!String.IsNullOrWhiteSpace(metadataError))
                {
                    result.CredentialRejected = IsCredentialError(metadataError);
                    result.Detail = result.CredentialRejected ? "OpenAI rejected the Runtime API key." : "OpenAI tunnel metadata is unavailable.";
                    return result;
                }

                string metadataId = ReadTunnelMetadataId(root);
                if (!String.Equals(metadataId, expectedTunnelId, StringComparison.Ordinal))
                {
                    result.Detail = "OpenAI tunnel metadata has not been confirmed yet.";
                    return result;
                }
                if (!result.LocalReady)
                {
                    result.Detail = "Local tunnel is not ready.";
                    return result;
                }
            }
        }
        catch (JsonException)
        {
            result.Detail = "Tunnel status JSON is invalid.";
            return result;
        }

        double lastPoll;
        if (!TryReadMetric(metricsText, "commands_poll_last_successful_timestamp_seconds", out lastPoll) || lastPoll <= 0)
        {
            result.Detail = "Waiting for the first successful OpenAI control-plane poll.";
            return result;
        }

        DateTimeOffset lastPollAt;
        try { lastPollAt = DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Round(lastPoll * 1000.0)); }
        catch
        {
            result.Detail = "The OpenAI control-plane poll timestamp is invalid.";
            return result;
        }
        TimeSpan age = now - lastPollAt;
        if (age < TimeSpan.Zero || age > PollFreshness)
        {
            result.Detail = "OpenAI control-plane polling is stale.";
            return result;
        }

        result.ControlPlaneReady = true;
        result.Detail = "Ready";
        return result;
    }
    private static string ReadString(JsonElement root, string name)
    {
        JsonElement value;
        if (!root.TryGetProperty(name, out value) || value.ValueKind != JsonValueKind.String) return null;
        return value.GetString();
    }

    private static string ReadTunnelMetadataId(JsonElement root)
    {
        JsonElement metadata;
        if (!root.TryGetProperty("tunnel_metadata", out metadata) || metadata.ValueKind != JsonValueKind.Object) return null;
        foreach (string name in new[] { "ID", "Id", "id" })
        {
            JsonElement value;
            if (metadata.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.String) return value.GetString();
        }
        return null;
    }

    private static bool IsCredentialError(string error)
    {
        string value = (error ?? "").ToLowerInvariant();
        return value.Contains("invalid_api_key") || value.Contains("incorrect api key") || value.Contains("status 401") || value.Contains("unauthorized");
    }

    private static bool TryReadMetric(string metrics, string metricName, out double value)
    {
        value = 0;
        if (String.IsNullOrWhiteSpace(metrics)) return false;
        string[] lines = metrics.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string raw in lines)
        {
            string line = raw.Trim();
            if (line.StartsWith("#", StringComparison.Ordinal) || !line.StartsWith(metricName, StringComparison.Ordinal)) continue;
            if (line.Length > metricName.Length && line[metricName.Length] != '{' && !Char.IsWhiteSpace(line[metricName.Length])) continue;
            int separator = line.LastIndexOf(' ');
            if (separator <= 0 || separator >= line.Length - 1) continue;
            string rawValue = line.Substring(separator + 1).Trim();
            if (Double.TryParse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return true;
        }
        return false;
    }

    public static int RunSelfTest()
    {
        const string id = "tunnel_0123456789abcdef0123456789abcdef";
        DateTimeOffset now = DateTimeOffset.FromUnixTimeSeconds(2000);
        string goodStatus = "{\"control_plane_tunnel_id\":\"" + id + "\",\"mcp_server_url\":\"http://127.0.0.1:8765/mcp\",\"tunnel_metadata\":{\"ID\":\"" + id + "\"}}";
        string goodMetrics = "commands_poll_last_successful_timestamp_seconds 1995";
        TunnelRuntimeStatus good = Evaluate(id, true, "ready", goodStatus, goodMetrics, now);
        if (!good.Ready) return 11;

        string rejectedStatus = "{\"control_plane_tunnel_id\":\"" + id + "\",\"mcp_server_url\":\"http://127.0.0.1:8765/mcp\",\"tunnel_metadata_error\":\"status 401: invalid_api_key\"}";
        TunnelRuntimeStatus rejected = Evaluate(id, true, "ready", rejectedStatus, goodMetrics, now);
        if (rejected.Ready || !rejected.CredentialRejected) return 12;

        TunnelRuntimeStatus rejectedHttp = Evaluate(id, true, "ready", "status 401 unauthorized {\"error\":{\"code\":\"invalid_api_key\"}}", goodMetrics, now);
        if (rejectedHttp.Ready || !rejectedHttp.CredentialRejected) return 16;

        TunnelRuntimeStatus stale = Evaluate(id, true, "ready", goodStatus, "commands_poll_last_successful_timestamp_seconds 1800", now);
        if (stale.Ready) return 13;

        TunnelRuntimeStatus localOnly = Evaluate(id, true, "ready", goodStatus, "", now);
        if (localOnly.Ready) return 14;

        TunnelRuntimeStatus localDown = Evaluate(id, false, "", goodStatus, goodMetrics, now);
        if (localDown.Ready) return 15;
        return 0;
    }
}
