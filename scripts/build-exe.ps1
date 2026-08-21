# Kidai Plugin Remote — build-exe.ps1
#
# Packages the manager into a SINGLE standalone .exe with zero downloads:
#  1. stage the app files (server.js, lib/, public/, vendor/, scripts/)
#  2. zip them into one embedded resource
#  3. compile a tiny C# launcher with the in-box .NET Framework csc.exe
#     (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe)
#  4. on first run the exe extracts the embedded app to
#     %LOCALAPPDATA%\KidaiPluginRemote\app and launches `node server.js`
#
# Output:  <project>\build\Kidai Plugin Remote.exe
param(
  [string]$OutDir = "build"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
  Write-Error "csc.exe not found at $csc (needs .NET Framework 4.x). Use the .cmd launcher instead."
  exit 1
}

$stage = Join-Path $env:TEMP ("kpr-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  Copy-Item (Join-Path $root "server.js") $stage
  Copy-Item (Join-Path $root "package.json") $stage
  Copy-Item (Join-Path $root "lib") (Join-Path $stage "lib") -Recurse
  Copy-Item (Join-Path $root "public") (Join-Path $stage "public") -Recurse
  Copy-Item (Join-Path $root "vendor") (Join-Path $stage "vendor") -Recurse
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "scripts") | Out-Null
  Copy-Item (Join-Path $root "scripts\minimize-console.ps1") (Join-Path $stage "scripts\minimize-console.ps1")

  $zip = Join-Path $stage "kidai-app.zip"
  $items = Get-ChildItem $stage -Force | Where-Object { $_.Name -ne "kidai-app.zip" }
  Compress-Archive -Path $items -DestinationPath $zip -CompressionLevel Optimal -Force
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash

  $program = @"
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;

[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyProduct("Kidai Plugin Remote")]
class Program {
  static int Main(string[] args) {
    var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    var appDir = Environment.GetEnvironmentVariable("KPR_APP_DIR");
    if (string.IsNullOrEmpty(appDir)) appDir = Path.Combine(appData, "KidaiPluginRemote", "app");
    var stamp = Path.Combine(appDir, ".stamp");
    var version = "$hash";
    try {
      if (!Directory.Exists(appDir) || !File.Exists(stamp) || File.ReadAllText(stamp) != version) {
        if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
        Directory.CreateDirectory(appDir);
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("kidai-app.zip")) {
          if (stream == null) throw new Exception("embedded resource kidai-app.zip missing");
          using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
            foreach (var entry in zip.Entries) {
              var target = Path.Combine(appDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
              if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
              var parent = Path.GetDirectoryName(target);
              if (parent != null) Directory.CreateDirectory(parent);
              entry.ExtractToFile(target, true);
            }
          }
        }
        File.WriteAllText(stamp, version);
      }
      var psi = new ProcessStartInfo();
      psi.FileName = Environment.GetEnvironmentVariable("KPR_NODE") ?? "node";
      psi.Arguments = "server.js";
      psi.WorkingDirectory = appDir;
      psi.UseShellExecute = false;
      var proc = Process.Start(psi);
      proc.WaitForExit();
      return proc.ExitCode;
    } catch (Exception ex) {
      try { Console.Error.WriteLine("Kidai Plugin Remote: " + ex.ToString()); } catch {}
      try { Console.ReadLine(); } catch {}
      return 1;
    }
  }
}
"@
  $cs = Join-Path $stage "Program.cs"
  Set-Content -Path $cs -Value $program -Encoding UTF8

  $outDir = Join-Path $root $OutDir
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $exe = Join-Path $outDir "Kidai Plugin Remote.exe"
  & $csc /nologo /target:exe "/out:$exe" "/resource:$zip" "/r:System.IO.Compression.dll" "/r:System.IO.Compression.FileSystem.dll" $cs
  if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
  Write-Host ""
  Write-Host "OK: $exe"
  Write-Host "    (single file; extracts app to %LOCALAPPDATA%\KidaiPluginRemote\app on first run)"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
