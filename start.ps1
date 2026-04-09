$ErrorActionPreference = "Stop"

Write-Host "Starting Redis via Docker Compose..." -ForegroundColor Cyan
docker-compose up -d

Write-Host "Starting Python Backend API..." -ForegroundColor Cyan
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "run_backend.py"

Write-Host "Starting Next.js Frontend and BullMQ Worker..." -ForegroundColor Cyan
# Run both Next dev and the worker using npm-run-all or natively
Start-Process -NoNewWindow -FilePath "npm" -ArgumentList "run worker"
npm run dev
