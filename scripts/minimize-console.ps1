# Kidai Plugin Remote — minimize the manager's own console window.
# The server spawns this helper with stdio:"inherit", so the helper attaches to
# the manager's console; GetConsoleWindow() then resolves to the console window
# itself, which ShowWindowAsync minimizes. No MainWindowHandle guessing needed.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KprWin32 {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
$hwnd = [KprWin32]::GetConsoleWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }
# SW_MINIMIZE = 6
[KprWin32]::ShowWindowAsync($hwnd, 6) | Out-Null
exit 0
