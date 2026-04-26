# Repo Execution Map

## A. Startup flow: `npm run dev`

`npm run dev` runs `next dev`. It starts the Next.js development server, serves `pages/index.js`, and exposes API routes under `pages/api`.

```mermaid
sequenceDiagram
  participant User
  participant Next as Next.js dev server
  participant Page as pages/index.js
  participant App as src/main.js
  participant API as /api/data/*
  participant Worker as public/workers/dataWorker.js
  participant Map as MapLibre

  User->>Next: Open http://localhost:3000
  Next->>Page: Render dashboard shell
  Page->>App: Load imperative frontend bundle
  App->>API: GET baseline.json, time_index.json, stats.json
  API-->>App: JSON runtime data
  App->>API: GET /api/peak-hours
  API-->>App: peak-hour rows or error fallback
  App->>Worker: buildSiteHierarchy
  Worker-->>App: site hierarchy
  App->>App: build point + sector GeoJSON
  App->>API: GET first time_data parquet slice
  API-->>App: observations JSON
  App->>Worker: buildFeatureUpdates
  Worker-->>App: per-cell visual state
  App->>Map: create map, add sources/layers, fit bounds
```

Important prerequisites:

- `node_modules/` must exist from `npm install`.
- `runtime_data/baseline.json`, `runtime_data/time_index.json`, and at least one `runtime_data/time_data/*.parquet` should exist.
- API auth is bypassed by default in non-production if no token is configured.

Current risk:

- Frontend can load local runtime data without FastAPI, but recommendations/export fail if FastAPI is down or broken.

## B. Worker flow: `npm run worker`

`npm run worker` runs `node job-workers/jobWorker.js`.

```mermaid
sequenceDiagram
  participant Worker as jobWorker.js
  participant Redis
  participant DB as .runtime/jobs.sqlite
  participant Py as simulation/simulator.py
  participant Files as runtime_data + .runtime/job-results

  Worker->>Redis: Connect to netvision-jobs
  Worker->>DB: Ensure jobs table exists
  Redis-->>Worker: execute-job {jobId}
  Worker->>DB: Load job row
  Worker->>DB: Mark running
  Worker->>Files: Validate time_entry filename against time_index.json
  Worker->>Py: Spawn python simulation/simulator.py
  Py->>Files: Read baseline.json and selected time slice
  Py-->>Worker: JSON result on stdout
  Worker->>Files: Write .runtime/job-results/<jobId>.json
  Worker->>DB: Store result_json/result_path, mark done
```

Failure path:

- Missing Redis prevents job consumption.
- Missing `simulation/simulator.py`, bad time filename, invalid payload, Python failure, or invalid JSON marks job `failed` with `error_text`.

## C. Data processing flow

Command shape:

```bash
python scripts/process_time_series.py --input data/data_set_radio_1.csv --output runtime_data
```

Script defaults differ:

```bash
python scripts/process_time_series.py --input data_set_radio_1.csv data_set_radio_all_hour.csv --output runtime_data
```

```mermaid
flowchart TD
  A[Raw CSV files] --> B[load_data]
  B --> C[lowercase and trim columns]
  C --> D[backfill static metadata by cell_name]
  D --> E[parse numeric KPI and geometry fields]
  E --> F[filter invalid coordinates and timestamps]
  F --> G[baseline per unique cell]
  F --> H[per-timestamp observations]
  H --> I[analyze_cell congestion/severity/health]
  I --> J[write time_data/<timestamp>.parquet]
  G --> K[write baseline.json]
  H --> L[write time_index.json]
  F --> M[write stats.json]
```

Output contracts:

- `baseline.json`: object keyed by cell name, with site, longitude, latitude, azimuth, band, local cell id.
- `time_index.json`: `{total_timestamps,start_time,end_time,storage_format,timestamps:[{timestamp,filename,stats}]}`.
- `time_data/*.parquet`: rows keyed by `cell_name` with KPI fields.
- `stats.json`: global counts and bands.

## D. Forecast flow

Current `main` has no forecast generation flow.

- No `pages/api/forecast.js` on current `main`.
- No `scripts/train_forecast_model.py` or `scripts/forecast_hf.py` on current `main`.
- README explicitly says no forecasting pipeline.
- `target/main` contains forecast files and a model artifact, but that branch is a divergent snapshot and should not be treated as current runtime behavior.

Current related flow is drift:

```mermaid
sequenceDiagram
  participant UI as src/main.js
  participant API as /api/drift
  participant Asset as runtime_data/model_assets/val_predictions.parquet

  UI->>API: GET /api/drift?abs_threshold=15&pct_threshold=30&limit=150
  API->>Asset: Read validation predictions parquet
  Asset-->>API: CELLNAME, DATE_ID, y_true_prb, y_pred_prb
  API-->>UI: Drift alerts by cell
  UI->>UI: Attach drift metadata to point features and alert panel
```

Current blocker:

- `runtime_data/model_assets/val_predictions.parquet` is missing locally, so `/api/drift` returns 500 and frontend falls back to no drift alerts.

## E. Simulation flow

Standard action-panel simulation uses async jobs:

```mermaid
sequenceDiagram
  participant UI as src/main.js
  participant Jobs as POST /api/jobs
  participant DB as .runtime/jobs.sqlite
  participant Redis as BullMQ Redis
  participant Worker as jobWorker.js
  participant Sim as simulation/simulator.py
  participant Poll as GET /api/jobs/:id

  UI->>Jobs: POST {cell_name, action, params, time_entry, mode:"fast"}
  Jobs->>DB: create pending job
  Jobs->>Redis: queue execute-job {jobId}
  Jobs-->>UI: 202 {jobId,status:"pending"}
  UI->>Poll: Poll job status
  Redis-->>Worker: deliver job
  Worker->>DB: mark running
  Worker->>Sim: spawn python simulator
  Sim-->>Worker: before/after/impact JSON
  Worker->>DB: mark done, save result
  Poll-->>UI: {status:"done", result}
  UI->>UI: render before/after cards and Chart.js chart
```

Site planning flow is direct:

```mermaid
sequenceDiagram
  participant UI as site planning panel
  participant API as /api/simulate
  participant Sim as simulation/simulator.py

  UI->>API: POST {cell_name, action:"new_site", params:{siteType}, time_entry}
  API->>Sim: spawn python simulator.py
  Sim-->>API: JSON result
  API-->>UI: JSON result
```

Supported simulator actions:

- `tilt`
- `add_carrier`
- `redistribute`
- `add_sector`
- `new_site`
- `add_site`

## F. Recommendation flow

```mermaid
sequenceDiagram
  participant UI as src/main.js
  participant Next as /api/recommend
  participant FastAPI as backend/api.py
  participant Engine as backend/action_engine.py
  participant RD as runtime_data or uploaded context

  UI->>Next: POST {cell_name,timestamp,KPI overrides}
  Next->>Next: Auth + rate limit
  Next->>FastAPI: POST /predict {cellname,KPIs}
  FastAPI->>Engine: evaluate_cell(context, request_kpis, timestamp)
  Engine->>RD: Uses active in-memory context
  Engine-->>FastAPI: recommendation payload
  FastAPI-->>Next: JSON
  Next-->>UI: JSON
  UI->>UI: map backend actions to simulator actions and render cards
```

Current blocker:

- FastAPI cannot import `backend.action_engine` in the local `.venv` because `backend/core_rules.py` lacks constants imported by `action_engine.py`.

Import-session recommendation context:

```mermaid
sequenceDiagram
  participant UI as imported session
  participant Next as /api/recommend-context
  participant FastAPI as /context/upload
  participant Engine as build_context_from_payload

  UI->>Next: POST compact {baseline,slices,source}
  Next->>FastAPI: POST /context/upload
  FastAPI->>Engine: normalize uploaded context
  Engine-->>FastAPI: DataFrames + busy-hour profile
  FastAPI-->>Next: context stats
  Next-->>UI: success
```

## G. Data loading flow

Baseline and index:

```mermaid
sequenceDiagram
  participant UI as init()
  participant API as /api/data/[...slug]
  participant Files as runtime_data

  UI->>API: GET /api/data/baseline.json
  API->>Files: stream runtime_data/baseline.json
  API-->>UI: baseline object
  UI->>API: GET /api/data/time_index.json
  API->>Files: stream runtime_data/time_index.json
  API-->>UI: time index
  UI->>API: GET /api/data/stats.json
  API-->>UI: stats or fallback generated in frontend
```

Time slices:

```mermaid
sequenceDiagram
  participant UI as loadHistoricalSliceInternal
  participant API as /api/data/time_data/<file>
  participant Parquet as parquetjs-lite
  participant Worker as dataWorker
  participant Map as MapLibre

  UI->>API: GET time_data slice
  API->>Parquet: Read Parquet rows
  API->>API: Convert rows to observations keyed by cell_name
  API-->>UI: {timestamp,stats,observations}
  UI->>Worker: buildFeatureUpdates
  Worker-->>UI: per-cell feature update array
  UI->>Map: setData / setFeatureState / filters
```

Forecast slices:

- No forecast slices are loaded on current `main`.
- Any future forecast implementation must define whether forecast slices live under `runtime_data/time_data`, `runtime_data/forecast_data`, or another allow-listed data directory; `/api/data` currently only allow-lists `time_data`.
