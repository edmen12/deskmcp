$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'release-provenance.ps1')

function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Throws([scriptblock]$Action, [string]$MessagePattern) {
    try { & $Action; throw 'Expected failure did not occur.' }
    catch {
        if ($_.Exception.Message -eq 'Expected failure did not occur.') { throw }
        if ($_.Exception.Message -notmatch $MessagePattern) { throw ('Unexpected failure: ' + $_.Exception.Message) }
    }
}

$tempRoot = Join-Path $env:TEMP ('deskmcp-release-provenance-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
    $cscCandidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    $csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    Require ([bool]$csc) 'Windows .NET Framework C# compiler was not found.'

    $source = Join-Path $tempRoot 'Fixture.cs'
    [IO.File]::WriteAllText($source, 'internal static class Fixture { public static void Main() {} }', [Text.Encoding]::ASCII)
    $commit = '0123456789abcdef0123456789abcdef01234567'
    $markerPrefix = 'DESKMCP_SOURCE_COMMIT_V1='
    $commitPath = Join-Path $tempRoot 'commit.txt'
    [IO.File]::WriteAllText($commitPath, ($markerPrefix + $commit + [Environment]::NewLine), [Text.Encoding]::ASCII)
    $fixture = Join-Path $tempRoot 'Fixture.exe'
    & $csc /nologo /target:exe ('/out:' + $fixture) ('/resource:' + $commitPath + ',DesktopMCP.SourceCommit.txt') $source
    if ($LASTEXITCODE -ne 0) { throw ('Fixture compile failed: ' + $LASTEXITCODE) }
    Require ((Get-DeskMcpSetupSourceCommit $fixture) -eq $commit) 'Embedded source commit fixture did not round-trip.'

    $missing = Join-Path $tempRoot 'Missing.exe'
    & $csc /nologo /target:exe ('/out:' + $missing) $source
    if ($LASTEXITCODE -ne 0) { throw ('Missing-resource fixture compile failed: ' + $LASTEXITCODE) }
    Expect-Throws { Get-DeskMcpSetupSourceCommit $missing | Out-Null } 'provenance marker is missing'

    [IO.File]::WriteAllText($commitPath, ($markerPrefix + ('z' * 40) + [Environment]::NewLine), [Text.Encoding]::ASCII)
    $invalid = Join-Path $tempRoot 'Invalid.exe'
    & $csc /nologo /target:exe ('/out:' + $invalid) ('/resource:' + $commitPath + ',DesktopMCP.SourceCommit.txt') $source
    if ($LASTEXITCODE -ne 0) { throw ('Invalid-resource fixture compile failed: ' + $LASTEXITCODE) }
    Expect-Throws { Get-DeskMcpSetupSourceCommit $invalid | Out-Null } 'provenance marker is invalid'

    [IO.File]::WriteAllText($commitPath, ($markerPrefix + $commit + [Environment]::NewLine + $markerPrefix + $commit + [Environment]::NewLine), [Text.Encoding]::ASCII)
    $ambiguous = Join-Path $tempRoot 'Ambiguous.exe'
    & $csc /nologo /target:exe ('/out:' + $ambiguous) ('/resource:' + $commitPath + ',DesktopMCP.SourceCommit.txt') $source
    if ($LASTEXITCODE -ne 0) { throw ('Ambiguous-resource fixture compile failed: ' + $LASTEXITCODE) }
    Expect-Throws { Get-DeskMcpSetupSourceCommit $ambiguous | Out-Null } 'provenance marker is ambiguous'

    $repo = Join-Path $tempRoot 'repo'
    New-Item -ItemType Directory -Force -Path $repo | Out-Null
    & git -C $repo init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Git fixture init failed.' }
    & git -C $repo config user.email 'provenance-test@localhost'
    & git -C $repo config user.name 'DeskMCP Provenance Test'
    & git -C $repo config commit.gpgsign false
    [IO.File]::WriteAllText((Join-Path $repo 'tracked.txt'), 'one', [Text.Encoding]::ASCII)
    & git -C $repo add tracked.txt
    & git -C $repo commit --quiet -m init
    if ($LASTEXITCODE -ne 0) { throw 'Git fixture commit failed.' }
    $gitCommit = Get-DeskMcpGitSourceCommit $repo
    Require ($gitCommit -match '^[0-9a-f]{40}$') 'Git fixture source commit was invalid.'
    Assert-DeskMcpReleaseSourceClean $repo
    [IO.File]::WriteAllText((Join-Path $repo 'tracked.txt'), 'two', [Text.Encoding]::ASCII)
    Expect-Throws { Assert-DeskMcpReleaseSourceClean $repo } 'Release source tree is not clean'
    & git -C $repo checkout --quiet -- tracked.txt
    [IO.File]::WriteAllText((Join-Path $repo 'untracked.ts'), 'export const injected = true;', [Text.Encoding]::ASCII)
    Expect-Throws { Assert-DeskMcpReleaseSourceClean $repo } 'Release source tree is not clean'

    Write-Output 'RELEASE_PROVENANCE_SELF_TEST=PASS'
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
