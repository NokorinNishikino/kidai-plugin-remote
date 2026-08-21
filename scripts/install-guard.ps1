# Kidai Plugin Remote 鈥?install-guard.ps1
#
# Installs the in-DSH half of the snapshot system (kidai-snapshot-guard) into
# a profile: copies the package into the profile's node_modules, declares the
# dependency and adds the bundle to dsh.profile.bundles. Takes effect on the
# next DSH restart.
param(
  [string]$ProfileName = "desktop",
  [string]$DshHome = ""
)
$ErrorActionPreference = "Stop"

if ($DshHome -eq "") { $DshHome = $env:DSH_HOME; if ($DshHome -eq "") { $DshHome = Join-Path $HOME ".dsh" } }
$profileDir = Join-Path $DshHome (Join-Path "profiles" $ProfileName)
$manifestPath = Join-Path $profileDir "package.json"
if (-not (Test-Path $manifestPath)) { Write-Error "profile manifest not found: $manifestPath"; exit 1 }

$guardSrc = Join-Path (Split-Path $PSScriptRoot -Parent) "..\kidai-snapshot-guard"
if (-not (Test-Path (Join-Path $guardSrc "package.json"))) { Write-Error "guard package not found at $guardSrc"; exit 1 }

$guardDest = Join-Path $profileDir (Join-Path "node_modules" "kidai-snapshot-guard")
Write-Host "copying kidai-snapshot-guard -> $guardDest"
Remove-Item $guardDest -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $guardDest | Out-Null
Get-ChildItem $guardSrc -Force | Where-Object { $_.Name -notin @(".git", "node_modules", ".gitignore") } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $guardDest $_.Name) -Recurse -Force
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue @{} -Force }
if (-not $manifest.dependencies.PSObject.Properties.Name -contains "kidai-snapshot-guard") {
  $manifest.dependencies | Add-Member -NotePropertyName "kidai-snapshot-guard" -NotePropertyValue "file:./node_modules/kidai-snapshot-guard" -Force
}
if (-not $manifest.dsh.profile.bundles) { $manifest.dsh.profile.bundles = @() }
if ($manifest.dsh.profile.bundles -notcontains "kidai-snapshot-guard") {
  $manifest.dsh.profile.bundles += "kidai-snapshot-guard"
}
$json = $manifest | ConvertTo-Json -Depth 20
# ConvertTo-Json escapes non-ASCII; acceptable for the manifest fields we touch.
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "OK: kidai-snapshot-guard installed into profile '$ProfileName'."
Write-Host "    - dependency + bundle declared in $manifestPath"
Write-Host "    - 鐢熸晥鏃堕棿锛氫笅娆￠噸鍚?DSH 鍚庯紙瀹堟姢鎻掍欢浼氬湪姣忔鎴愬姛鍚姩鏃剁‘璁ゅ緟瀹氬揩鐓э級銆?
Write-Host "    - 鍙敤 /kidai-snapshot 鍛戒护鍙鏌ョ湅蹇収锛涘洖婊氬湪 Kidai Plugin Remote 澶栭儴绠＄悊鍣ㄤ腑鎿嶄綔銆?
