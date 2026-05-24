$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$LogDir = Join-Path $RepoRoot ".runtime\ns3-setup"
$LogPath = Join-Path $LogDir "wsl-reset.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path $LogPath -Force

try {
  Write-Host "Stopping WSL client processes..."
  Get-Process wsl -ErrorAction SilentlyContinue | Stop-Process -Force

  Write-Host "Stopping WSLService..."
  Stop-Service WSLService -Force
  Start-Sleep -Seconds 5

  Write-Host "Starting WSLService..."
  Start-Service WSLService
  Start-Sleep -Seconds 5

  Write-Host "WSL service state:"
  Get-Service WSLService | Format-List Name,Status,StartType

  Write-Host "WSL list:"
  wsl.exe -l -v
  Write-Host "RESET_STATUS=SUCCESS"
} catch {
  Write-Host "RESET_STATUS=FAILED"
  Write-Host $_.Exception.Message
} finally {
  Stop-Transcript
}
