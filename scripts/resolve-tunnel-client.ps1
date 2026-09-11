function Resolve-DeskMcpTunnelClient {
    param(
        [Parameter(Mandatory=$true)][string]$ProjectRoot,
        [ValidateSet('win-x64','win-arm64')][string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' })
    )

    . (Join-Path $PSScriptRoot 'release-targets.ps1')
    $targetConfig = Get-DeskMcpReleaseTarget $Target

    $override = [string]$env:DESKTOP_MCP_TUNNEL_CLIENT
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        $resolvedOverride = [IO.Path]::GetFullPath($override)
        if (-not (Test-Path -LiteralPath $resolvedOverride -PathType Leaf)) {
            throw ('DESKTOP_MCP_TUNNEL_CLIENT does not point to a file: ' + $resolvedOverride)
        }
        return $resolvedOverride
    }

    $stageRoot = Get-DeskMcpStageRoot $ProjectRoot $Target
    $stageCandidate = Join-Path $stageRoot ('tunnel-client\' + $targetConfig.TunnelVersion + '\bin\tunnel-client.exe')
    if (Test-Path -LiteralPath $stageCandidate -PathType Leaf) {
        return [IO.Path]::GetFullPath($stageCandidate)
    }

    $extractRoot = Join-Path $ProjectRoot ('runtime\downloads\tunnel-' + $Target)
    if (Test-Path -LiteralPath $extractRoot -PathType Container) {
        $matches = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'tunnel-client.exe' -ErrorAction Stop)
        if ($matches.Count -eq 1) { return $matches[0].FullName }
        if ($matches.Count -gt 1) { throw ('Multiple tunnel-client.exe files found under ' + $extractRoot + '; refusing ambiguous selection.') }
    }

    throw ('Verified tunnel-client.exe is unavailable for ' + $Target + '. Build the release stage first or set DESKTOP_MCP_TUNNEL_CLIENT to an explicit local executable path.')
}
