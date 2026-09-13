$ErrorActionPreference = 'Stop'

function Get-DeskMcpGitSourceCommit {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot)
    $root = [IO.Path]::GetFullPath($ProjectRoot)
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -eq $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if ($null -eq $git) { throw 'Git is required to resolve release source provenance.' }
    $lines = @(& $git.Source -C $root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { throw 'Could not resolve the current Git commit for release provenance.' }
    $commit = ([string]$lines[0]).Trim().ToLowerInvariant()
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw ('Resolved Git commit is invalid: ' + $commit) }
    return $commit
}

function Assert-DeskMcpReleaseSourceClean {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot)
    $root = [IO.Path]::GetFullPath($ProjectRoot)
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -eq $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if ($null -eq $git) { throw 'Git is required to verify release source cleanliness.' }
    $lines = @(& $git.Source -C $root status --porcelain --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect source state for release provenance.' }
    if ($lines.Count -gt 0) {
        $sample = (($lines | Select-Object -First 8) -join '; ')
        throw ('Release source tree is not clean; refusing to build an artifact whose commit would not fully identify its source. Changes: ' + $sample)
    }
}

function Get-DeskMcpSetupSourceCommit {
    param([Parameter(Mandatory=$true)][string]$SetupPath)
    $setup = [IO.Path]::GetFullPath($SetupPath)
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw ('Setup artifact is missing: ' + $setup) }

    $markerPrefix = 'DESKMCP_SOURCE_COMMIT_V1='
    $commitLength = 40
    $overlapLength = $markerPrefix.Length + $commitLength + 4
    $chunkLength = 65536
    $buffer = New-Object byte[] ($chunkLength + $overlapLength)
    $carry = 0
    [long]$absoluteRead = 0
    $offsets = New-Object 'Collections.Generic.HashSet[long]'
    $commits = New-Object 'Collections.Generic.List[string]'
    $invalidMarkers = 0
    $stream = [IO.File]::Open($setup, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        while ($true) {
            $read = $stream.Read($buffer, $carry, $chunkLength)
            if ($read -le 0) { break }
            $total = $carry + $read
            [long]$baseOffset = $absoluteRead - $carry
            $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $total)
            $searchAt = 0
            while ($searchAt -lt $text.Length) {
                $index = $text.IndexOf($markerPrefix, $searchAt, [StringComparison]::Ordinal)
                if ($index -lt 0) { break }
                $requiredEnd = $index + $markerPrefix.Length + $commitLength
                if ($requiredEnd -le $text.Length) {
                    [long]$absoluteOffset = $baseOffset + $index
                    if ($offsets.Add($absoluteOffset)) {
                        $candidate = $text.Substring($index + $markerPrefix.Length, $commitLength).ToLowerInvariant()
                        if ($candidate -match '^[0-9a-f]{40}$') { $commits.Add($candidate) }
                        else { $invalidMarkers++ }
                    }
                }
                $searchAt = $index + 1
            }
            $absoluteRead += $read
            $carry = [Math]::Min($overlapLength, $total)
            [Buffer]::BlockCopy($buffer, $total - $carry, $buffer, 0, $carry)
        }
    }
    finally { $stream.Dispose() }

    if ($invalidMarkers -gt 0) { throw 'Embedded Setup source provenance marker is invalid.' }
    if ($commits.Count -eq 0) { throw 'Embedded Setup source provenance marker is missing.' }
    if ($commits.Count -ne 1 -or $offsets.Count -ne 1) { throw 'Embedded Setup source provenance marker is ambiguous.' }
    return $commits[0]
}
