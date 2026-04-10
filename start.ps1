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
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "run_backend.py"

Write-Host "Starting Next.js Frontend and BullMQ Worker..." -ForegroundColor Cyan
# Run both Next dev and the worker using npm-run-all or natively
Start-Process -NoNewWindow -FilePath "npm.cmd" -ArgumentList "run worker"
npm run dev

