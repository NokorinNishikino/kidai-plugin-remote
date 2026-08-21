# Kidai Plugin Remote - install-shortcut.ps1
# (ASCII-safe; resolves the launcher .cmd by scanning, so the Chinese filename
# never has to pass through a non-Unicode command line)
#
# Creates a desktop shortcut that opens the classic launcher console.
param(
  [string]$Root = ""
)
$ErrorActionPreference = "Stop"
if ($Root -eq "") { $Root = Split-Path $PSScriptRoot -Parent }

$launcher = Get-ChildItem -Path $Root -Filter "*.cmd" -File | Where-Object { $_.Name -ne "install.cmd" } | Select-Object -First 1
if ($null -eq $launcher) { Write-Error "launcher .cmd not found under $Root"; exit 1 }

$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "Kidai Plugin Remote.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:WINDIR "System32\cmd.exe"
$sc.Arguments = "/c `"`"$($launcher.FullName)`"`""
$sc.WorkingDirectory = $Root
$sc.Description = "Kidai Plugin Remote (classic launcher)"
$sc.IconLocation = "$env:WINDIR\System32\cmd.exe,0"
$sc.Save()
Write-Host "OK: desktop shortcut created -> $lnk"
