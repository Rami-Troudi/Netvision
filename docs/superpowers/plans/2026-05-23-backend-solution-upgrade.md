# Backend Solution Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade NetVision backend logic into a coherent, fast, source-of-truth aligned operational platform for congestion detection, peak-hour analysis, data serving, recommendation context, and job execution.

**Architecture:** Keep the current split: FastAPI remains the intelligence engine, Next.js API remains the UI gateway, Redis/BullMQ remains the async job layer, and runtime data remains file-backed for now. The upgrade removes duplicated KPI logic, adds precomputed indexes where the UI currently performs expensive repeated work, and tightens validation around data mode, time slices, and operational contracts.

**Tech Stack:** FastAPI, Python/Pandas/DuckDB, Next.js API routes, Node.js, BullMQ, Redis, SQLite, Parquet/JSON runtime files, contract tests in `tests/contracts`, smoke tests in `scripts/v2-api-smoke.mjs`.

---

## Current Components

1. FastAPI intelligence engine
- Files: `backend/api.py`, `backend/core_rules.py`, `backend/action_engine.py`
- Responsibility: health, cells, prediction/recommendation, recommendation context upload/reset, export CSV, runtime context loading.

2. Next.js API gateway
- Files: `pages/api/recommend.js`, `pages/api/simulate.js`, `pages/api/recommendations-export.js`, `pages/api/recommend-context.js`, `pages/api/backend-health.js`
- Responsibility: authenticated frontend-facing bridge to FastAPI and Python simulator.

3. Runtime data gateway
- Files: `pages/api/data/[...slug].js`, `pages/api/_lib/dataMode.js`, `src/admin/adminData.js`
- Responsibility: serve `runtime_data` or `runtime_data_mock`, stream JSON/Parquet slices, expose baseline/time/admin files.

4. Peak-hours and aggregation API
- Files: `pages/api/peak-hours.js`, `src/admin/adminAggregation.js`, `src/admin/adminOps.js`
- Responsibility: derive busy-hour profiles, congestion rates, affected cells, scope summaries.

5. Queue and worker subsystem
- Files: `pages/api/_lib/jobs.js`, `pages/api/jobs/index.js`, `pages/api/jobs/[id].js`, `pages/api/jobs-health.js`, `job-workers/jobWorker.js`
- Responsibility: create simulation jobs, persist lifecycle in SQLite, execute through BullMQ/Redis, write artifacts.

6. Simulation runtime
- Files: `simulation/simulator.py`, `pages/api/simulate.js`, `job-workers/jobWorker.js`
- Responsibility: execute supported action what-if models.

7. Data generation and validation
- Files: `scripts/process_time_series.py`, `scripts/generate_mock_runtime_data.py`, `scripts/generate_labelled_comparison_data.mjs`, `backend/validate_pipeline.py`, `scripts/v2-api-smoke.mjs`
- Responsibility: build runtime data, mock calibrated data, labelled comparison exports, and validation reports.

## Findings

1. Rule duplication remains after the first congestion alignment pass.
- `backend/core_rules.py` is the intended source of truth.
- `pages/api/peak-hours.js` still uses `prb >= 85`, `throughput < 15 Mbps`, and local QoS scoring.
- `src/admin/adminAggregation.js` still has diagnostic labels and confidence-like issue logic using older `85%` thresholds.
- `scripts/generate_labelled_comparison_data.mjs` still classifies congestion with `prb >= 85`.

2. Unit handling is too fragile.
- Some paths treat throughput as kbps, some as Mbps, and some normalize heuristically with `>1000`.
- `pages/api/recommend.js` forwards `throughput` directly to FastAPI, so a UI caller can accidentally send Mbps where FastAPI expects kbps.
- `src/utils/v2Contracts.mjs` currently normalizes `obs.throughput` as kbps, then converts to Mbps only if `>1000`; this is workable for old slices but risky for mixed imports.

3. Peak-hours API is a performance bottleneck.
- `pages/api/peak-hours.js` loads every time slice and every observation into memory on first request.
- It caches only raw observations by data mode, not by file mtime or query fingerprint.
- For 720 hourly slices and at least 10 cells per delegation, this becomes one of the main responsiveness risks.

4. Data serving is file-safe but not operationally indexed.
- `pages/api/data/[...slug].js` validates allowed paths and streams JSON, which is good.
- Parquet reading converts an entire slice to a JS object per request.
- `src/admin/adminData.js` loads only the first slice initially, but timeline playback can still generate many slice fetches without a compact per-slice summary API.

5. Queue and direct simulation validation are split.
- `pages/api/simulate.js` validates action allowlist and time file allowlist.
- `pages/api/jobs/index.js` accepts any action string as long as `cell_name` and `action` exist; invalid actions fail later in the worker/simulator.
- `job-workers/jobWorker.js` and `pages/api/simulate.js` duplicate time-file allowlist logic.

6. Runtime mode mismatch risk.
- Data API supports `runtime_data_mock` through `getRuntimeDataRoot()`.
- Simulation direct and worker paths hardcode `runtime_data/time_index.json` and `runtime_data/time_data`, so UI can view mock data while simulating against real data.

7. Health semantics are confusing.
- `pages/api/backend-health.js` returns HTTP 200 even when FastAPI is unavailable, with `available: false`.
- This is acceptable for UI resilience, but smoke tests and admin diagnostics need a stricter machine-readable health endpoint or clear schema.

8. Export path can be expensive.
- FastAPI export has Redis/in-memory cache, which is good.
- Next export timeout is very long (`420000ms`) and retries full export calls, so a slow export can occupy API capacity and hide the real bottleneck.

9. Validation exists but is not yet a hard gate.
- `backend/validate_pipeline.py`, `tests/contracts/*.mjs`, and `scripts/v2-api-smoke.mjs` are valuable.
- They do not yet assert consistent congestion logic across Python, JS normalization, peak-hours, labelled comparison, and mock generation.

## Upgrade Plan

### Task 1: Create One Shared JS Congestion Contract

**Files:**
- Modify: `src/utils/v2Contracts.mjs`
- Modify: `pages/api/peak-hours.js`
- Modify: `scripts/generate_labelled_comparison_data.mjs`
- Test: `tests/contracts/v2-contracts.mjs`

- [ ] Add exported constants matching `backend/core_rules.py`: `PRB_SATURATED=90`, `PRB_HIGH=80`, `PRB_MEDIUM=70`, `THROUGHPUT_DEGRADED_KBPS=4000`, `ACTIVE_USERS_CRITICAL=4`.
- [ ] Add `normalizeThroughputPair(value, unitHint)` returning `{ throughput_kbps, throughput_mbps }`.
- [ ] Update `inferCongestedFromKpis` to accept explicit `throughputKbps`.
- [ ] Replace remaining `prb >= 85` congestion classifications in JS.
- [ ] Add contract cases for PRB 90, PRB 80 + THP 3999, PRB 70 + users 5, and PRB 70 + THP 3999.
- [ ] Run `node tests/contracts/v2-contracts.mjs`.

### Task 2: Align Peak-Hours API With Source Rules

**Files:**
- Modify: `pages/api/peak-hours.js`
- Test: `tests/contracts/peak-hours-contracts.mjs`

- [ ] Import the shared congestion helper from `src/utils/v2Contracts.mjs`.
- [ ] Change `normalizeObs()` to return both `throughput_kbps` and `throughput`.
- [ ] Replace `Boolean(record.congested) || prb >= 85` with the source helper.
- [ ] Replace affected-cell logic with `row.congested || row.qos_degraded`, where `qos_degraded` is explicitly computed from low throughput, poor CQI, or congestion.
- [ ] Add a small fixture test proving peak-hours affected cells do not trigger on PRB 85 alone when throughput/users are healthy.
- [ ] Run `node tests/contracts/peak-hours-contracts.mjs`.

### Task 3: Fix Runtime Mode Consistency For Simulation

**Files:**
- Modify: `pages/api/simulate.js`
- Modify: `job-workers/jobWorker.js`
- Create: `job-workers/runtimeDataRoot.cjs`
- Test: `tests/contracts/operational-api-contracts.mjs`

- [ ] Extract a CommonJS `getRuntimeDataRoot()` helper mirroring `pages/api/_lib/dataMode.js`.
- [ ] Use that helper in direct simulation to resolve `time_index.json` and `time_data`.
- [ ] Use that helper in the worker to resolve allowed time files.
- [ ] Include `data_mode` in job request and response payloads so diagnostics can explain what data was used.
- [ ] Add a contract test that switches mock mode and verifies the job/simulate payload points at the mock time file allowlist.
- [ ] Run `node tests/contracts/operational-api-contracts.mjs`.

### Task 4: Centralize Job Payload Validation

**Files:**
- Create: `pages/api/_lib/simulationContract.js`
- Modify: `pages/api/simulate.js`
- Modify: `pages/api/jobs/index.js`
- Modify: `job-workers/jobWorker.js`
- Test: `tests/contracts/operational-api-contracts.mjs`

- [ ] Move supported actions, mode validation, params object validation, and time-entry validation into one module.
- [ ] Make `/api/jobs` reject unsupported actions immediately with HTTP 400.
- [ ] Make direct simulation and queued simulation return the same validation error shape.
- [ ] Keep supported actions limited to `tilt`, `redistribute`, `neighbor_optimization`, `add_carrier`, `add_sector`.
- [ ] Run direct and queued smoke checks for all five source-truth actions.

### Task 5: Build A Precomputed Peak-Hours Index

**Files:**
- Create: `scripts/build_peak_hours_index.mjs`
- Modify: `pages/api/peak-hours.js`
- Modify: `scripts/generate_mock_runtime_data.py`
- Test: `tests/contracts/peak-hours-contracts.mjs`

- [ ] Generate `runtime_data/peak_hours_index.json` and `runtime_data_mock/peak_hours_index.json` during data generation.
- [ ] Store profiles by `group_by`, `scope_id`, `metric`, and hour.
- [ ] Make `/api/peak-hours` read the index when present, and fall back to raw scan only when absent.
- [ ] Add mtime-based invalidation so admin imports or regenerated data refresh the index.
- [ ] Verify cold request time and warm request time on 720 slices.

### Task 6: Add Slice Summary API For Smooth Playback

**Files:**
- Create: `pages/api/timeline-summary.js`
- Modify: `src/admin/adminData.js`
- Modify: `src/main.js`
- Test: `tests/contracts/runtime-config-contracts.mjs`

- [ ] Create an endpoint returning per-slice national and delegation summaries without full observations.
- [ ] Include `timestamp`, `filename`, `congestion_rate`, `avg_prb`, `avg_throughput`, `avg_cqi`, `active_users`, and top changed delegations.
- [ ] Use it for timeline play state and national-scale delegation variation.
- [ ] Fetch full cell observations only for selected slice/scope.
- [ ] Verify playback avoids full dashboard refresh behavior.

### Task 7: Tighten Recommendation Context Lifecycle

**Files:**
- Modify: `backend/api.py`
- Modify: `pages/api/recommend-context.js`
- Test: `scripts/v2-api-smoke.mjs`

- [ ] Add context metadata to upload/reset responses: source, slice count, cell count, updated timestamp.
- [ ] Clear FastAPI export cache when context changes.
- [ ] Make `/health` report active context source and whether uploaded context is active.
- [ ] Add smoke checks for upload, predict with uploaded context, reset, and predict with runtime context.

### Task 8: Make Export Async-Capable

**Files:**
- Modify: `backend/api.py`
- Modify: `pages/api/recommendations-export.js`
- Modify: `pages/api/jobs/index.js`
- Modify: `job-workers/jobWorker.js`

- [ ] Keep current synchronous export for small/current cached CSVs.
- [ ] Add an export job type for full recommendation CSV if the backend computation exceeds a short threshold.
- [ ] Save CSV artifacts under `.runtime/job-results`.
- [ ] Return a job id when export must run async.
- [ ] Keep the UI download path admin-only.

### Task 9: Upgrade Validation Into A Release Gate

**Files:**
- Modify: `backend/validate_pipeline.py`
- Modify: `scripts/v2-api-smoke.mjs`
- Modify: `package.json`

- [ ] Add a single command `npm run verify:backend`.
- [ ] Include Python rule tests, JS contract tests, FastAPI health/predict/export, Next API smoke, queue health, direct simulation, queued simulation, peak-hours, data-mode, and runtime validation.
- [ ] Fail if any source-rule mismatch appears in generated data or labels.
- [ ] Emit a compact PASS/FAIL report for the user and CI.

### Task 10: Observability And Operator Diagnostics

**Files:**
- Modify: `pages/api/backend-health.js`
- Modify: `pages/api/jobs-health.js`
- Modify: `backend/api.py`
- Modify: `src/components/panels/CockpitPanel.jsx`

- [ ] Standardize health payloads with `available`, `status`, `mode`, `data_root`, `context_source`, `latency_ms`, and `last_error`.
- [ ] Keep UI wording French/operator-facing in normal mode.
- [ ] Keep raw service names and API details admin-only.
- [ ] Add latency headers to backend proxy calls.

## Priority Order

1. Correctness: Tasks 1, 2, 3, 4.
2. Performance: Tasks 5, 6.
3. Operational robustness: Tasks 7, 8, 9.
4. Diagnostics polish: Task 10.

## Acceptance Criteria

- Congestion logic matches `backend/core_rules.py` across backend, frontend normalization, peak-hours, aggregation, mock generation, and labelled comparison.
- Throughput units are explicit at every API boundary.
- Mock mode and real mode use the same time slice root for data, recommendation context, direct simulation, and queued simulation.
- Peak-hours remains responsive on 30 days hourly data.
- Timeline playback can use summary data without refetching full observations on every tick.
- Unsupported simulator actions fail before queueing.
- Health diagnostics are machine-readable and operator-readable.
- `npm run build`, contract tests, `scripts/v2-api-smoke.mjs`, and backend validation pass.
