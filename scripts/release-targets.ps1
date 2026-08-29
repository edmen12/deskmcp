function Get-DeskMcpReleaseTarget {
    param([Parameter(Mandatory=$true)][ValidateSet('win-x64','win-arm64')][string]$Target)

    $common = [ordered]@{
        Name = $Target
        NodeVersion = '24.19.0'
        TunnelVersion = 'v0.0.13'
        NpmOs = 'win32'
    }
    if ($Target -eq 'win-x64') {
        return [pscustomobject]($common + [ordered]@{
            Architecture = 'x64'
            DotnetRid = 'win-x64'
            CscPlatform = 'x64'
            NpmCpu = 'x64'
            NodeArchive = 'node-v24.19.0-win-x64.zip'
            NodeDirectory = 'node-v24.19.0-win-x64'
            NodeSha256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
            TunnelAsset = 'tunnel-client-v0.0.13-windows-amd64.zip'
            TunnelSha256 = '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb'
            TunnelTriple = 'windows-amd64'
            SharpPackage = 'sharp-win32-x64'
            RipgrepPackage = 'ripgrep-win32-x64'
            PeMachine = 0x8664
            SetupSuffix = ''
        })
    }
    return [pscustomobject]($common + [ordered]@{
        Architecture = 'arm64'
        DotnetRid = 'win-arm64'
        CscPlatform = 'anycpu'
        NpmCpu = 'arm64'
        NodeArchive = 'node-v24.19.0-win-arm64.zip'
        NodeDirectory = 'node-v24.19.0-win-arm64'
        NodeSha256 = '8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f'
        TunnelAsset = 'tunnel-client-v0.0.13-windows-arm64.zip'
        TunnelSha256 = 'ec7c33cb06fabbbc04aa4803304b647f8542922b8b1489c961b3ebfc283ddcb0'
        TunnelTriple = 'windows-arm64'
        SharpPackage = 'sharp-win32-arm64'
        RipgrepPackage = 'ripgrep-win32-arm64'
        PeMachine = 0xAA64
        SetupSuffix = '-win-arm64'
    })
}

function Get-DeskMcpStageRoot {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot,[Parameter(Mandatory=$true)][string]$Target)
    return Join-Path $ProjectRoot ('runtime\release-stage\' + $Target + '\DesktopMCP')
}

function Get-DeskMcpSetupName {
    param([Parameter(Mandatory=$true)][string]$Version,[Parameter(Mandatory=$true)]$TargetConfig)
    return 'DeskMCP-Setup-' + $Version + $TargetConfig.SetupSuffix + '.exe'
}
