$ErrorActionPreference = "Stop"

$modelPath = Join-Path $PSScriptRoot "models\forecast_model.pkl"

if (-not (Test-Path $modelPath)) {
	Write-Host "Training forecast model on full history..." -ForegroundColor Cyan
	python scripts/train_forecast_model.py --history-limit 0
} else {
	Write-Host "Forecast model already exists, skipping training." -ForegroundColor DarkGray
}

Write-Host "Starting Redis via Docker Compose..." -ForegroundColor Cyan
docker-compose up -d

Write-Host "Starting Python Backend API..." -ForegroundColor Cyan
# For real deployments, run the backend under a process manager like pm2 or gunicorn.
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "run_backend.py"

Write-Host "Starting Next.js Frontend (production server) and BullMQ Worker..." -ForegroundColor Cyan
# Use the production Next.js server command for deployment-like startup behavior.
Start-Process -NoNewWindow -FilePath "npm.cmd" -ArgumentList "run worker"
npm run start

