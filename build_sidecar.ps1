# build_sidecar.ps1
# photo_blur.py を PyInstaller で exe 化し、Tauri サイドカー用の場所に配置するスクリプト
#
# 使い方:
#   .\build_sidecar.ps1
#
# 前提:
#   pip install pyinstaller opencv-python numpy

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot  = $PSScriptRoot
$DistDir   = "$RepoRoot\dist"
$BinDir    = "$RepoRoot\src-tauri\binaries"

# ターゲットトリプルを自動取得
$triple = (rustc -vV | Select-String "host:").ToString().Trim() -replace "host:\s*", ""
Write-Host "Target triple: $triple"

# PyInstaller でビルド
Write-Host "Building photo_blur.exe with PyInstaller..."
Set-Location $RepoRoot
pyinstaller `
    --onefile `
    --name photo_blur `
    --distpath "$DistDir" `
    --workpath "$RepoRoot\build_pyinstaller" `
    --specpath "$RepoRoot\build_pyinstaller" `
    --noconfirm `
    photo_blur.py

if (-not (Test-Path "$DistDir\photo_blur.exe")) {
    Write-Error "PyInstaller build failed: $DistDir\photo_blur.exe not found"
    exit 1
}

# Tauri サイドカー用にコピー（ファイル名にトリプルを付ける）
$dest = "$BinDir\photo_blur-$triple.exe"
Copy-Item "$DistDir\photo_blur.exe" $dest -Force
Write-Host "Copied to: $dest"
Write-Host ""
Write-Host "Done. Now run: npm run tauri build"
