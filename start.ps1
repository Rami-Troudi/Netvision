$ErrorActionPreference = "Stop"

Write-Host "Starting Redis via Docker Compose..." -ForegroundColor Cyan
docker-compose up -d

Write-Host "Stopping any existing processes on port 8000 and 3000..." -ForegroundColor Yellow
$occupyingProcess = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
if ($occupyingProcess) {
    Stop-Process -Id $occupyingProcess.OwningProcess -Force -ErrorAction SilentlyContinue
}
$occupyingNode = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($occupyingNode) {
    Stop-Process -Id $occupyingNode.OwningProcess -Force -ErrorAction SilentlyContinue
}

Write-Host "Setting AUTH_BYPASS to bypass strict token checks for local deployment..." -ForegroundColor Yellow
$env:AUTH_BYPASS = "true"

Write-Host "Starting Python Backend API..." -ForegroundColor Cyan
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "run_backend.py"

Write-Host "Cleaning up previous Next.js cache to ensure fresh dev build..." -ForegroundColor Yellow
if (Test-Path ".next") { Remove-Item ".next" -Recurse -Force }

Write-Host "Starting Next.js Frontend (development server) and BullMQ Worker..." -ForegroundColor Cyan
Start-Process -NoNewWindow -FilePath "npm.cmd" -ArgumentList "run worker"

# Use the dev server for fast local testing (no build required)
npm run dev

