$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exclude = @('\runtime\','\node_modules\','\dist\','\tools\tunnel-client\')
$extensions = @('.md','.ts','.ps1','.cmd','.bat','.cs','.xaml','.json','.mjs','.yml','.yaml','.txt','.gitignore','.gitattributes')
$patterns = [ordered]@{
    'OpenAI-style secret key' = 'sk-[A-Za-z0-9_-]{20,}'
    'GitHub token' = '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'
    'AWS access key' = 'AKIA[0-9A-Z]{16}'
    'Google API key' = 'AIza[0-9A-Za-z_-]{30,}'
    'Private key block' = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
    'Concrete OpenAI Tunnel ID' = 'tunnel_[0-9a-f]{32}'
}
$findings = [Collections.Generic.List[object]]::new()
$files = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object {
        $full = $_.FullName
        -not ($exclude | Where-Object { $full.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0 }) -and
        ($extensions -contains $_.Extension -or $_.Name -in @('.gitignore','.gitattributes','.npmrc'))
    }
foreach ($file in $files) {
    $lineNo = 0
    foreach ($line in [IO.File]::ReadLines($file.FullName)) {
        $lineNo++
        foreach ($entry in $patterns.GetEnumerator()) {
            if ([regex]::IsMatch($line, $entry.Value)) {
                $findings.Add([pscustomobject]@{
                    Type = $entry.Key
                    File = $file.FullName.Substring($ProjectRoot.Length).TrimStart('\\')
                    Line = $lineNo
                })
            }
        }
    }
}
Write-Output ('FILES_SCANNED=' + @($files).Count)
Write-Output ('FINDINGS=' + $findings.Count)
foreach ($item in $findings) {
    Write-Output ('FINDING|' + $item.Type + '|' + $item.File + '|line=' + $item.Line)
}
if ($findings.Count -gt 0) { exit 3 }
Write-Output 'SECRET_SCAN=PASS'
exit 0