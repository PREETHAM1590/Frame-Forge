$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$workspace = Split-Path -Parent $PSScriptRoot
$assetDirectory = Join-Path $workspace 'public'
$buildDirectory = Join-Path $workspace 'build'
New-Item -ItemType Directory -Force -Path $assetDirectory, $buildDirectory | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(23,25,27))
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(199,243,107))
$font = New-Object System.Drawing.Font 'Segoe UI', 150, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('F', $font, $accent, 66, 23)
$graphics.FillRectangle($accent, 56, 209, 144, 7)
$bitmap.Save((Join-Path $assetDirectory 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::Create((Join-Path $buildDirectory 'icon.ico'))
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $font.Dispose(); $accent.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
