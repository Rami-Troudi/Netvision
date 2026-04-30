# NetVision Digital Twin (Next.js)

Real-time radio network monitoring, KPI analytics, rule-based congestion recommendations, and action simulation for Orange NOC teams.

## Stack
- Next.js (pages router) frontend with MapLibre GL + Chart.js
- Python FastAPI backend for rule-based recommendations (`backend/api.py`)
- Python simulation engine (`simulation/simulator.py`)
- BullMQ + Redis queue for async simulation jobs only

## Current Architecture
- No forecasting pipeline: no model training scripts, no forecast endpoint, no forecast jobs, and no forecast timeline controls.
- Recommendations are deterministic and threshold-based, with busy-hour profiling and neighbor scoring.
- Import flow can push uploaded KPI context to the backend (`/api/recommend-context`) so recommendations run on imported data.
- CSV export is UTF-8, comma separated, and normalized for downstream tools.

## Quickstart (Windows)
1. Install dependencies:
   ```bash
   npm install
   python -m pip install -r requirements.txt
   ```
2. Build runtime data (recommended):
   ```bash
   python scripts/process_time_series.py --input data/data_set_radio_1.csv --output runtime_data
   ```
3. Start full local stack with one command:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\\start.ps1
   ```

## Manual Run
- Frontend: `npm run dev` (http://localhost:3000)
- Worker: `npm run worker` (optional Redis-backed queued jobs)
- Backend: `npm run backend` or `python run_backend.py` (optional FastAPI recommendation service)
- Redis check: `npm run redis:ping`
- Production build: `npm run build` then `npm start`

## Local Linux Services (No Docker)
Redis and FastAPI are optional for the current dashboard scope. Overview, Peak Hours, QoS Analysis, the admin map, and Data Quality must work when both are offline. Redis is needed only for queued jobs/simulation/recommendation export. FastAPI is needed only for recommendation-related backend routes.

Redis local service setup:

```bash
sudo apt update
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping
```

Expected Redis output: `PONG`.

FastAPI setup:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run_backend.py
```

Health checks:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:3000/api/backend-health
curl http://127.0.0.1:3000/api/jobs-health
```

See `docs/dev-backend.md` for full local service notes.

## API Surface
### Next.js API routes
- `POST /api/recommend`
- `POST /api/recommend-context`
- `POST /api/simulate`
- `POST /api/jobs` (simulation jobs only)
- `GET /api/jobs/:id`
- `GET /api/data/*` (path-restricted static runtime data)

### Python backend routes
- `GET /health`
- `GET /cells`
- `POST /predict`
- `POST /context/upload`
- `DELETE /context/reset`
- `GET /recommendations/summary`
- `GET /recommendations/export`
- `GET /cell/{cellname}/history`

## Project Structure (key paths)
```text
pages/           # Next.js pages (index, api/*)
public/          # static assets + browser worker
backend/         # rule engine API + helpers
scripts/         # time-series processing pipeline
runtime_data/    # baseline/index/slices + model_assets
simulation/      # simulator.py (fast estimator)
workers/         # BullMQ worker (simulation only)
src/             # frontend app logic + styles
```

## Notes
- Heavy routes require auth token unless `AUTH_BYPASS=true` is set for local use.
- Linux development uses local `redis-server`; Docker Redis is not required. `start.ps1` is Windows-specific legacy convenience tooling.
- Keep generated runtime artifacts out of git when working with large datasets.

## License
MIT License - See LICENSE file for details.