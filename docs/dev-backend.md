# Local Backend Services

This project uses non-Docker local services for development.

## Redis

Redis is optional for the current client-facing dashboard scope. Overview, Peak Hours, QoS Analysis, admin map, and Data Quality work without Redis. Redis is only required for queued jobs, simulation, and recommendation export flows.

Install and start Redis on Linux:

```bash
sudo apt update
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping
```

Expected output:

```text
PONG
```

Default configuration:

```bash
REDIS_URL=redis://127.0.0.1:6381
REDIS_CONNECTION_TIMEOUT_MS=1000
```

`REDIS_URL` is preferred. If it is not set, the app falls back to:

```bash
REDIS_HOST=127.0.0.1
REDIS_PORT=6381
```

## FastAPI Backend

FastAPI is optional for the current dashboard scope. It is used by recommendation-related backend routes and health checks, but it must not block the core dashboard.

Setup:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run_backend.py
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

Expected when running:

```json
{"status":"ok"}
```

## Next.js Checks

Start the dashboard:

```bash
npm run dev
```

Check API health routes:

```bash
curl http://127.0.0.1:3000/api/backend-health
curl http://127.0.0.1:3000/api/jobs-health
curl http://127.0.0.1:3000/api/data/stats.json
curl http://127.0.0.1:3000/api/peak-hours
```

Expected behavior:

- `/api/backend-health` returns `available:true` if FastAPI is running.
- `/api/backend-health` returns HTTP 200 with `available:false` if FastAPI is down.
- `/api/jobs-health` returns `ready:true` if Redis is running.
- `/api/jobs-health` returns HTTP 200 with `ready:false`, `optional:true`, and `scope:"out_of_current_phase"` if Redis is down.
- The frontend still loads without Redis or FastAPI.
