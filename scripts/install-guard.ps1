# Kidai Plugin Remote - install-guard.ps1
# (ASCII-safe: PowerShell 5.1 reads this file as ANSI)
#
# Installs the in-DSH half of the snapshot system (kidai-snapshot-guard) into
# a profile: copies the package into the profile's node_modules, declares the
# dependency (absolute file: reference, NOT the self-referencing
# file:./node_modules form that pnpm rewrites away) and adds the bundle to
# dsh.profile.bundles. Takes effect on the next DSH restart.
param(
  [string]$ProfileName = "desktop",
  [string]$DshHome = ""
)
$ErrorActionPreference = "Stop"

if ($DshHome -eq "") { $DshHome = $env:DSH_HOME; if ($DshHome -eq "") { $DshHome = Join-Path $HOME ".dsh" } }
$profileDir = Join-Path $DshHome (Join-Path "profiles" $ProfileName)
$manifestPath = Join-Path $profileDir "package.json"
if (-not (Test-Path $manifestPath)) { Write-Error "profile manifest not found: $manifestPath"; exit 1 }

$guardSrcRaw = Join-Path (Split-Path $PSScriptRoot -Parent) "..\kidai-snapshot-guard"
if (-not (Test-Path (Join-Path $guardSrcRaw "package.json"))) { Write-Error "guard package not found at $guardSrcRaw"; exit 1 }
# Normalize so the declared file: dependency has no '..' segments.
$guardSrc = (Resolve-Path $guardSrcRaw).Path

$guardDest = Join-Path $profileDir (Join-Path "node_modules" "kidai-snapshot-guard")
Write-Host "copying kidai-snapshot-guard -> $guardDest"
Remove-Item $guardDest -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $guardDest | Out-Null
Get-ChildItem $guardSrc -Force | Where-Object { $_.Name -notin @(".git", "node_modules", ".gitignore") } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $guardDest $_.Name) -Recurse -Force
}

$guardRef = "file:" + ($guardSrc -replace "\\", "/")
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue @{} -Force }
if (-not $manifest.dependencies.PSObject.Properties.Name -contains "kidai-snapshot-guard") {
  $manifest.dependencies | Add-Member -NotePropertyName "kidai-snapshot-guard" -NotePropertyValue $guardRef -Force
}
if (-not $manifest.dsh.profile.bundles) { $manifest.dsh.profile.bundles = @() }
if ($manifest.dsh.profile.bundles -notcontains "kidai-snapshot-guard") {
  $manifest.dsh.profile.bundles += "kidai-snapshot-guard"
}
$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "OK: kidai-snapshot-guard installed into profile '$ProfileName'."
Write-Host "    - dependency ($guardRef) + bundle declared in $manifestPath"
Write-Host "    - takes effect on the next DSH restart; /kidai-snapshot command then works,"
Write-Host "      rollback is operated from the external Kidai Plugin Remote."
