param(
    [int[]]$ClientCounts = @(8,16,32),
    [int]$ReadRounds = 10,
    [int]$WriteRounds = 3,
    [switch]$Quick
)
$ErrorActionPreference = 'Stop'
if ($Quick) { $ClientCounts = @(4,8); $ReadRounds = 2; $WriteRounds = 1 }
if ($ClientCounts.Count -eq 0 -or $ClientCounts.Count -gt 8) { throw 'ClientCounts must contain 1 to 8 entries.' }
foreach ($count in $ClientCounts) { if ($count -lt 1 -or $count -gt 64) { throw 'Each client count must be between 1 and 64.' } }
if ($ReadRounds -lt 1 -or $ReadRounds -gt 100) { throw 'ReadRounds must be between 1 and 100.' }
if ($WriteRounds -lt 1 -or $WriteRounds -gt 20) { throw 'WriteRounds must be between 1 and 20.' }

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RunRoot = Join-Path $ProjectRoot ('runtime\agent-safe-multi-client\' + [guid]::NewGuid().ToString('N'))
$GatewayRoot = Join-Path $RunRoot 'gateway'
$GatewayDist = Join-Path $GatewayRoot 'dist'
$Workspace = Join-Path $RunRoot 'workspace'
$AuditLog = Join-Path $RunRoot 'audit.jsonl'
$StressScript = Join-Path $RunRoot 'multi-client-stress.mjs'
$NodeExe = Join-Path $ProjectRoot 'runtime\downloads\node-v24.19.0\node-v24.19.0-win-x64\node.exe'
$TscCmd = Join-Path $ProjectRoot 'node_modules\.bin\tsc.cmd'
$DcEntry = Join-Path $ProjectRoot 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
$ClientEntry = Join-Path $ProjectRoot 'node_modules\@modelcontextprotocol\client\dist\index.mjs'
$SourceNodeModules = Join-Path $ProjectRoot 'node_modules'
$gateway = $null

function Require([bool]$Condition,[string]$Message){ if(-not $Condition){ throw $Message } }
function FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}
function Get-OptionalFileState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Exists=$false; Hash=$null } }
    return [pscustomobject]@{ Exists=$true; Hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }
}
function Require-UnchangedFileState([string]$Label,[string]$Path,[object]$Before) {
    $after = Get-OptionalFileState $Path
    Require ($after.Exists -eq $Before.Exists -and $after.Hash -eq $Before.Hash) ($Label + ' changed during multi-client stability test.')
}

foreach ($required in @($NodeExe,$TscCmd,$DcEntry,$ClientEntry)) { Require (Test-Path -LiteralPath $required) ('Required dependency is missing: ' + $required) }
$RealStartupLink = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DeskMCP Control Panel.lnk'
$RealSettingsPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'DesktopMCP\settings.json'
$RealTunnelProfile = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'tunnel-client\desktop-mcp.yaml'
$RealStartupBefore = Get-OptionalFileState $RealStartupLink
$RealSettingsBefore = Get-OptionalFileState $RealSettingsPath
$RealTunnelBefore = Get-OptionalFileState $RealTunnelProfile
$LivePanelPidsBefore = @(Get-Process -Name DeskMCP -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$old = @{
    Profile=$env:DESKTOP_MCP_PROFILE; Roots=$env:DESKTOP_MCP_ALLOWED_ROOTS; Port=$env:DESKTOP_MCP_PORT;
    Audit=$env:DESKTOP_MCP_AUDIT_LOG; Dc=$env:DESKTOP_COMMANDER_ENTRY
}

try {
    New-Item -ItemType Directory -Force -Path $GatewayRoot,$GatewayDist,$Workspace | Out-Null
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'package.json') -Destination (Join-Path $GatewayRoot 'package.json') -Force
    & $TscCmd -p (Join-Path $ProjectRoot 'tsconfig.json') --outDir $GatewayDist
    if ($LASTEXITCODE -ne 0) { throw 'Private Gateway TypeScript build failed.' }
    New-Item -ItemType Junction -Path (Join-Path $GatewayRoot 'node_modules') -Target $SourceNodeModules | Out-Null

    $maxClients = ($ClientCounts | Measure-Object -Maximum).Maximum
    for ($i=0; $i -lt $maxClients; $i++) {
        [IO.File]::WriteAllText((Join-Path $Workspace ('client-' + $i + '.txt')), 'BASE-' + $i, [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $Workspace 'shared.txt'), 'SHARED-BASE', [Text.UTF8Encoding]::new($false))

    $clientEntryUrl = $ClientEntry.Replace('\','/')
    $stressSource = @'
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [rawPort, workspace, rawCounts, rawReadRounds, rawWriteRounds] = process.argv.slice(2);
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL('__CLIENT_ENTRY__').href);
const baseUrl = `http://127.0.0.1:${rawPort}/mcp`;
const counts = rawCounts.split(',').map(Number);
const readRounds = Number(rawReadRounds);
const writeRounds = Number(rawWriteRounds);
const obs = result => {
  const m = JSON.stringify(result.content).match(/DeskMCP observation_id: ([0-9a-f-]{36})/i);
  if (!m) throw new Error('missing observation_id');
  return m[1];
};
const tool = (client, name, args) => client.callTool({ name, arguments: args });
for (const count of counts) {
  const clients = Array.from({ length: count }, (_, i) => new Client(
    { name: `deskmcp-pressure-${count}-${i}`, version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } }
  ));
  try {
    await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)))));
    const readStarted = performance.now();
    for (let round=0; round<readRounds; round++) {
      const results = await Promise.all(clients.map((client, i) => tool(client, 'desktop_get_file_info', { path: path.join(workspace, `client-${i}.txt`) })));
      if (results.some(r => r.isError === true)) throw new Error(`read pressure failed at ${count} clients round ${round}`);
    }
    const readMs = performance.now() - readStarted;

    const writeStarted = performance.now();
    for (let round=0; round<writeRounds; round++) {
      await Promise.all(clients.map(async (client, i) => {
        const file = path.join(workspace, `client-${i}.txt`);
        const read = await tool(client, 'desktop_read_file', { path: file });
        if (read.isError === true) throw new Error(`read-before-write failed for client ${i}`);
        const write = await tool(client, 'desktop_write_file', {
          path: file,
          content: `CLIENT-${i}-ROUND-${round}`,
          mode: 'rewrite',
          observation_id: obs(read)
        });
        if (write.isError === true) throw new Error(`private write failed for client ${i}: ${JSON.stringify(write.content)}`);
      }));
    }
    const writeMs = performance.now() - writeStarted;

    const shared = path.join(workspace, 'shared.txt');
    await writeFile(shared, `SHARED-BASE-${count}`, 'utf8');
    const sharedReads = await Promise.all(clients.map(client => tool(client, 'desktop_read_file', { path: shared })));
    const tokens = sharedReads.map(read => {
      if (read.isError === true) throw new Error('shared read failed');
      return obs(read);
    });
    const race = await Promise.all(clients.map((client, i) => tool(client, 'desktop_write_file', {
      path: shared,
      content: `WINNER-${count}-${i}`,
      mode: 'rewrite',
      observation_id: tokens[i]
    })));
    const wins = race.filter(r => r.isError !== true).length;
    const stale = race.filter(r => r.isError === true && /STALE observation/.test(JSON.stringify(r.content))).length;
    if (wins !== 1 || stale !== count - 1) throw new Error(`shared race invariant failed: wins=${wins} stale=${stale} count=${count}`);
    const finalShared = await readFile(shared, 'utf8');
    if (!new RegExp(`^WINNER-${count}-\\d+$`).test(finalShared)) throw new Error(`unexpected shared winner payload: ${finalShared}`);

    console.log(`CLIENT_PRESSURE_${count}=PASS readMs=${Math.round(readMs)} writeMs=${Math.round(writeMs)} raceWins=${wins} stale=${stale}`);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
}
console.log('MULTI_CLIENT_STABILITY=PASS');
'@
    [IO.File]::WriteAllText($StressScript,$stressSource.Replace('__CLIENT_ENTRY__',$clientEntryUrl),[Text.UTF8Encoding]::new($false))

    $port = FreePort
    $env:DESKTOP_MCP_PROFILE = 'workspace-write'
    $env:DESKTOP_MCP_ALLOWED_ROOTS = $Workspace
    $env:DESKTOP_MCP_PORT = [string]$port
    $env:DESKTOP_MCP_AUDIT_LOG = $AuditLog
    $env:DESKTOP_COMMANDER_ENTRY = $DcEntry
    $gateway = Start-Process -FilePath $NodeExe -ArgumentList 'dist\src\index.js' -WorkingDirectory $GatewayRoot -PassThru

    $base = 'http://127.0.0.1:' + $port
    $health = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        if ($gateway.HasExited) { throw ('Private Gateway exited early: ' + $gateway.ExitCode) }
        try { $health = Invoke-RestMethod ($base + '/health') -TimeoutSec 1 } catch { Start-Sleep -Milliseconds 250 }
    } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
    Require ([bool]$health) 'Private multi-client Gateway did not become healthy.'
    Require ($health.policy.profile -eq 'workspace-write') 'Private multi-client Gateway has the wrong profile.'
    Require ($health.desktopCommander.ready -eq $true) 'Private Desktop Commander is not ready.'

    & $NodeExe $StressScript ([string]$port) $Workspace (($ClientCounts -join ',')) ([string]$ReadRounds) ([string]$WriteRounds)
    if ($LASTEXITCODE -ne 0) { throw ('Multi-client stress exited ' + $LASTEXITCODE) }

    $auditLines = @(Get-Content -LiteralPath $AuditLog -ErrorAction Stop).Count
    Require ($auditLines -gt 0 -and ($auditLines % 2) -eq 0) 'Audit log does not contain paired records after concurrent pressure.'
    Write-Output ('MULTI_CLIENT_AUDIT_LINES=' + $auditLines)
} finally {
    try {
        if ($gateway -and -not $gateway.HasExited) {
            try { & $NodeExe (Join-Path $GatewayRoot 'dist\src\stop.js') ([string]$port) *> $null } catch { }
            try { if (-not $gateway.WaitForExit(5000)) { Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue } } catch { }
        }
    } finally {
        $env:DESKTOP_MCP_PROFILE=$old.Profile; $env:DESKTOP_MCP_ALLOWED_ROOTS=$old.Roots; $env:DESKTOP_MCP_PORT=$old.Port
        $env:DESKTOP_MCP_AUDIT_LOG=$old.Audit; $env:DESKTOP_COMMANDER_ENTRY=$old.Dc
        try { if (Test-Path -LiteralPath $RunRoot) { Remove-Item -LiteralPath $RunRoot -Recurse -Force } } catch { }
    }
}

Require-UnchangedFileState 'Real Startup shortcut' $RealStartupLink $RealStartupBefore
Require-UnchangedFileState 'Real DeskMCP settings' $RealSettingsPath $RealSettingsBefore
Require-UnchangedFileState 'Real Tunnel profile' $RealTunnelProfile $RealTunnelBefore
foreach ($livePid in $LivePanelPidsBefore) { Require ([bool](Get-Process -Id $livePid -ErrorAction SilentlyContinue)) "Multi-client stability test terminated pre-existing DeskMCP PID $livePid." }
Write-Output 'REAL_USER_STATE_UNCHANGED=OK'
Write-Output 'PREEXISTING_DESKMCP_PROCESSES_PRESERVED=OK'
