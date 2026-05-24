param(
  [string]$Distro = "Ubuntu"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$LogDir = Join-Path $RepoRoot ".runtime\ns3-setup"
$LogPath = Join-Path $LogDir "wsl-setup.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path $LogPath -Force

try {
  & "$PSScriptRoot\setup-wsl-ubuntu.ps1" -Distro $Distro
  Write-Host "SETUP_STATUS=SUCCESS"
} catch {
  Write-Host "SETUP_STATUS=FAILED"
  Write-Host $_.Exception.Message
  throw
} finally {
  Stop-Transcript
  Write-Host "Log written to $LogPath"
  Read-Host "Press Enter to close"
}
