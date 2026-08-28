param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BrandRoot = Join-Path $ProjectRoot 'assets\brand'
New-Item -ItemType Directory -Force -Path $BrandRoot | Out-Null

function New-DeskMcpBitmap([int]$Size, [string]$Path) {
    $bmp = New-Object Drawing.Bitmap $Size, $Size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([Drawing.Color]::Transparent)
    $s = $Size / 256.0
    $cyan = [Drawing.Color]::FromArgb(255, 45, 224, 216)
    $blue = [Drawing.Color]::FromArgb(255, 37, 99, 235)
    $navy = [Drawing.Color]::FromArgb(255, 5, 16, 31)
    $white = [Drawing.Color]::FromArgb(255, 236, 251, 255)

    $top = [Drawing.PointF[]]@(
        [Drawing.PointF]::new(44*$s,70*$s), [Drawing.PointF]::new(128*$s,22*$s),
        [Drawing.PointF]::new(212*$s,70*$s), [Drawing.PointF]::new(190*$s,84*$s),
        [Drawing.PointF]::new(128*$s,49*$s), [Drawing.PointF]::new(66*$s,84*$s)
    )
    $left = [Drawing.PointF[]]@(
        [Drawing.PointF]::new(42*$s,84*$s), [Drawing.PointF]::new(128*$s,133*$s),
        [Drawing.PointF]::new(128*$s,164*$s), [Drawing.PointF]::new(74*$s,133*$s),
        [Drawing.PointF]::new(74*$s,198*$s), [Drawing.PointF]::new(42*$s,180*$s)
    )
    $right = [Drawing.PointF[]]@(
        [Drawing.PointF]::new(214*$s,84*$s), [Drawing.PointF]::new(128*$s,133*$s),
        [Drawing.PointF]::new(128*$s,164*$s), [Drawing.PointF]::new(182*$s,133*$s),
        [Drawing.PointF]::new(182*$s,198*$s), [Drawing.PointF]::new(214*$s,180*$s)
    )
    $gradTop = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.RectangleF]::new(32*$s,20*$s,192*$s,180*$s)), $cyan, $blue, 55
    $gradSide = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.RectangleF]::new(30*$s,70*$s,200*$s,140*$s)), $cyan, $blue, 70
    $g.FillPolygon($gradTop,$top); $g.FillPolygon($gradSide,$left); $g.FillPolygon($gradSide,$right)

    $door = [Drawing.RectangleF]::new(109*$s,153*$s,38*$s,50*$s)
    $g.FillRectangle((New-Object Drawing.SolidBrush $navy),$door)
    $pen = New-Object Drawing.Pen $white,(3*$s)
    $g.DrawRectangle($pen,$door.X,$door.Y,$door.Width,$door.Height)
    $g.FillEllipse((New-Object Drawing.SolidBrush $cyan),136*$s,176*$s,5*$s,5*$s)
    $pathPoly = [Drawing.PointF[]]@(
        [Drawing.PointF]::new(109*$s,203*$s), [Drawing.PointF]::new(147*$s,203*$s),
        [Drawing.PointF]::new(198*$s,239*$s), [Drawing.PointF]::new(58*$s,239*$s)
    )
    $pathGrad = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.RectangleF]::new(58*$s,200*$s,140*$s,40*$s)), $cyan, $blue, 0
    $g.FillPolygon($pathGrad,$pathPoly)
    $bmp.Save($Path,[Drawing.Imaging.ImageFormat]::Png)
    $pen.Dispose(); $gradTop.Dispose(); $gradSide.Dispose(); $pathGrad.Dispose(); $g.Dispose(); $bmp.Dispose()
}

$sizes = @(16,32,48,64,128,256)
$pngs = @()
foreach ($size in $sizes) {
    $p = Join-Path $BrandRoot ("deskmcp-mark-$size.png")
    New-DeskMcpBitmap $size $p
    $pngs += $p
}

$icoPath = Join-Path $BrandRoot 'DeskMCP.ico'
$fs = [IO.File]::Open($icoPath,[IO.FileMode]::Create)
$bw = New-Object IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$pngs.Count)
$offset = 6 + (16 * $pngs.Count)
$entries = @()
foreach ($p in $pngs) {
    $bytes = [IO.File]::ReadAllBytes($p)
    $size = [int]([IO.Path]::GetFileNameWithoutExtension($p).Split('-')[-1])
    $dim = if ($size -ge 256) { 0 } else { $size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$bytes.Length); $bw.Write([UInt32]$offset)
    $entries += ,$bytes; $offset += $bytes.Length
}
foreach ($bytes in $entries) { $bw.Write($bytes) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()

Copy-Item -LiteralPath (Join-Path $BrandRoot 'deskmcp-mark-256.png') -Destination (Join-Path $ProjectRoot 'docs\images\deskmcp-mark.png') -Force
Write-Output 'BRAND_ASSETS_OK'
Write-Output ('ICON=' + $icoPath)
Write-Output ('PNG256=' + (Join-Path $BrandRoot 'deskmcp-mark-256.png'))