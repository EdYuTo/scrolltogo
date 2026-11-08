# Gives Chrome the same GPU scheduling priority OBS gives itself
# (libobs-d3d11/d3d11-subsystem.cpp: D3DKMTSetProcessSchedulingPriorityClass),
# so an uncapped game can't starve screen capture and encoding.
# Must run as administrator. Re-run after restarting Chrome.

$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  # Relaunch elevated (shows the Windows admin prompt).
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
  exit
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Gpu {
  [DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priority);
  [DllImport("gdi32.dll")] public static extern int D3DKMTGetProcessSchedulingPriorityClass(IntPtr process, out int priority);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
"@

# Same rule as OBS: REALTIME normally, HIGH when hardware-accelerated GPU scheduling is on.
$hags = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode -eq 2
$priority = if ($hags) { 4 } else { 5 }
$names = @{ 2 = "normal"; 3 = "above normal"; 4 = "high"; 5 = "realtime" }

$procs = Get-Process chrome -ErrorAction SilentlyContinue
if (-not $procs) { Write-Host "Chrome isn't running. Open Chrome first, then run this again." -ForegroundColor Yellow; exit }

$ok = 0
foreach ($p in $procs) {
  $h = [Gpu]::OpenProcess(0x0200 -bor 0x0400, $false, $p.Id) # SET_INFORMATION | QUERY_INFORMATION
  if ($h -eq [IntPtr]::Zero) { continue }
  if ([Gpu]::D3DKMTSetProcessSchedulingPriorityClass($h, $priority) -eq 0) { $ok++ }
  [void][Gpu]::CloseHandle($h)
}

Write-Host "Set GPU priority to $($names[$priority]) on $ok of $($procs.Count) Chrome processes." -ForegroundColor Green
Write-Host "Keep Chrome open; if you restart it, run this again."
