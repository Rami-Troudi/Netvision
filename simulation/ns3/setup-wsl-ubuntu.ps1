param(
  [string]$Distro = "Ubuntu"
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window: Start PowerShell as Administrator, then run this script again."
  }
}

Assert-Admin

Write-Host "Enabling WSL and Virtual Machine Platform..."
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

Write-Host "Setting WSL 2 as default..."
wsl.exe --set-default-version 2

Write-Host "Installing $Distro if missing..."
wsl.exe --install -d $Distro

Write-Host ""
Write-Host "If Windows asks for a reboot, reboot now. After reboot, open Ubuntu once to create the Linux user, then run:"
Write-Host "  wsl.exe -d $Distro -- bash -lc `"cd /mnt/c/Users/ramit/Documents/Codex/2026-05-23/yassinekolsi-odc-https-github-com-yassinekolsi && bash simulation/ns3/setup-ns3-ubuntu.sh`""
