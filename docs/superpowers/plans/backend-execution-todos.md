# Backend Execution TODOs

Status legend: `TODO`, `IN_PROGRESS`, `DONE`, `BLOCKED`

## Module 1 - Congestion Rules and KPI Contract
- `DONE` Align `backend/action_engine.py` threshold checks to `PRB >= 90`.
- `DONE` Use shared `inferCongestedFromKpis` in `src/utils/v2Contracts.mjs`.
- `DONE` Align `pages/api/peak-hours.js` congestion decision with source rules.
- `DONE` Align `scripts/generate_labelled_comparison_data.mjs` classifier with source rules.
- `IN_PROGRESS` Remove remaining legacy `>=85` semantics from diagnosis text/classification paths where they still imply congestion.

## Module 2 - FastAPI Intelligence Engine
- `TODO` Add richer `/health` context metadata fields.
- `TODO` Add export cache invalidation on context upload/reset.
- `TODO` Harden context upload payload validation with explicit KPI/slice checks.

## Module 3 - Next.js API Gateway
- `DONE` Centralize simulation payload contract in `pages/api/_lib/simulationContract.js`.
- `DONE` Reuse simulation contract in `/api/simulate` and `/api/jobs`.
- `TODO` Standardize backend proxy error schema across recommend/export/context routes.

## Module 4 - Runtime Data Gateway
- `DONE` Keep mode-based root resolution in data APIs.
- `DONE` Use mode-aware root for simulation and worker paths.
- `TODO` Add compact `/api/timeline-summary` for smoother playback.

## Module 5 - Peak-Hours and Aggregation
- `DONE` Replace `prb >= 85` congestion shortcut in `/api/peak-hours`.
- `TODO` Add precomputed `peak_hours_index.json` and indexed read path.
- `TODO` Add deterministic contract tests for affected-vs-congested behavior.

## Module 6 - Queue and Worker Subsystem
- `DONE` Enforce shared action/mode/time-entry validation before queueing.
- `DONE` Make worker time-slice allowlist mode-aware (`real`/`mock`).
- `TODO` Persist richer runtime metadata in job artifact headers.

## Module 7 - Simulation Runtime Boundary
- `DONE` Keep supported action allowlist synchronized between direct and queued flows.
- `TODO` Add one explicit simulation contract test for unsupported action rejection in queued endpoint.

## Module 8 - Data Generation and Mock Reliability
- `DONE` Gate mock congestion labels through source-rule checker.
- `TODO` Regenerate labelled comparison artifacts with aligned classifier.
- `TODO` Validate 30-day hourly coverage and delegation cell minima in generated outputs.

## Module 9 - Admin Diagnostics and Health
- `TODO` Standardize health payload keys across backend/jobs/data endpoints.
- `TODO` Keep technical diagnostics scoped to admin mode.

## Module 10 - Validation and Release Gate
- `DONE` Stabilize contract tests after FR/localization and map-control contract drift.
- `IN_PROGRESS` Decompose monolithic smoke into deterministic subsets to avoid long hangs.
- `TODO` Add `npm run verify:backend` orchestrator command.
