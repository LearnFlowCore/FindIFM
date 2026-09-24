# Создаёт ICO с PNG-изображением 256x256 без сторонних графических утилит.
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot 'build\icon.ico'
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(20, 36, 59))

$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(97, 213, 192))
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16, 41, 64))
$graphics.FillEllipse($accent, 36, 36, 184, 184)
$font = New-Object System.Drawing.Font 'Segoe UI', 104, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString('M', $font, $ink, (New-Object System.Drawing.RectangleF 36, 28, 184, 184), $format)

$pngStream = New-Object System.IO.MemoryStream
$bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $pngStream.ToArray()
$file = [System.IO.File]::Create($output)
$writer = New-Object System.IO.BinaryWriter $file
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$png.Length)
$writer.Write([UInt32]22)
$writer.Write($png)
$writer.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$font.Dispose()
$accent.Dispose()
$ink.Dispose()
$format.Dispose()
$pngStream.Dispose()
