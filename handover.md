# NetVision Handover

Workspace: `C:\Users\ramit\Documents\Codex\2026-05-23\yassinekolsi-odc-https-github-com-yassinekolsi`

This document is a full technical and product handover for another AI or engineer taking over the NetVision work. Assume no prior conversation context. Read this before changing code.

## 1. Project Purpose

NetVision is a radio network operations cockpit for Tunisian 4G/5G-style RAN analysis. The target user is a radio/network engineer, not a demo reviewer and not a developer. The product should help an operator follow one practical workflow:

1. Search or select a cell.
2. Inspect QoS evidence.
3. Understand why the cell is congested or degraded.
4. Choose a realistic operational action.
5. Run an asynchronous simulation.
6. Compare before/after impact with clear confidence, assumptions, and guardrails.

The current strategic direction is to make the new V2 UI a focused French operator tool. Debug/admin/data controls must be hidden behind admin mode. The normal UI should avoid AI-demo language, raw infra jargon, and features that do not support diagnosis, navigation, or action.

## 2. Current Workspace State

The repo is dirty and contains many important uncommitted changes. Do not reset or revert anything unless the user explicitly asks.

Important current untracked/modified areas include:

- `simulation/ns3/`: new ns-3 simulator integration scaffold.
- `pages/api/_lib/apiErrors.js`: structured API error helper.
- `pages/api/_lib/audit.js`: audit JSONL helper.
- `pages/api/_lib/simGuardrails.js`: simulation feasibility and plausibility guardrails.
- `runtime_data_mock/neighbor_graph.json`: generated mock neighbor graph.
- `scripts/build_neighbor_graph.mjs`: neighbor graph generator.
- `scripts/ns3-prereq-check.mjs`: WSL/ns-3 readiness check.
- `scripts/ns3-rationality-batch.mjs`: batch simulation rationality QA.
- `tests/contracts/ns3-contracts.mjs`: ns-3 contract tests.

Many existing files are also modified, especially `src/main.js`, `src/components/panels/*`, `pages/api/jobs/*`, `pages/api/jobs-health.js`, `simulation/simulator.py`, and backend rule files.

## 3. Runtime Stack

The app is a hybrid Next.js/React + FastAPI + BullMQ/Redis + simulator stack.

Main services:

- Next.js UI/API: `http://127.0.0.1:3000`
- FastAPI backend: `http://127.0.0.1:8000`
- Redis for BullMQ: expected `redis://127.0.0.1:6381`
- BullMQ worker: `node job-workers/jobWorker.js`
- ns-3 execution target: WSL Ubuntu

Useful commands:

```powershell
npm run dev
npm run worker
npm run backend
npm run redis:ping
npm run ns3:check
npm run test:contracts
npm run smoke:v2
npm run smoke:v2:core
npm run smoke:v2:sim
npm run qa:ns3:rationality
```

`package.json` requires Node `>=22.5.0`. The app depends on Next 15, React 19, BullMQ, ioredis, MapLibre, Turf, Chart.js, parquetjs-lite, and Playwright.

## 4. Branch and Historical Context

The user originally wanted the feature-rich old UI functionality migrated into the new UI.

Known history from `context.md`:

- Current new UI lineage is around `Rami-UI-refactor`.
- Old feature-rich UI reference commit is likely `c32c7fd` from 2026-04-26.
- New UI starts around `3a4a006` from 2026-04-27.
- No February/March commits were found in fetched history, despite user memory of an older UI from that period.

Old UI features included:

- Timeline controls.
- Rich map controls.
- Smart recommendations.
- Action simulator.
- Site planning.
- Analytics modal.
- Explore modal.
- Import mapping workflow.
- Export JSON/CSV/TXT/recommendations.

Current V2 direction intentionally does not restore the old UI shell. It should preserve only useful operator workflows in the new cockpit.

## 5. Source of Truth: DATASET Radio 2.pptx

Source file path:

`C:\Users\ramit\Downloads\DATASET Radio 2.pptx`

Extracted text currently exists at:

`docs/source-truth/DATASET-Radio-2-extracted.txt`

Alignment notes exist at:

`docs/source-truth/ns3-source-truth-alignment.md`

Key source-truth thresholds:

- Cell load / PRB saturation: observed `> 90%`, target `< 80%`.
- Waiting/queued users: observed `> 4`, target `<= 1`.
- Average user throughput: observed `< 4 Mbps`, target `>= 10 Mbps`.

The congestion logic should treat serious congestion as combined busy-hour evidence: high PRB, low throughput, and active-user/queue pressure. Avoid using a simplistic `PRB >= 85` shortcut as the authoritative rule.

Supported simulation actions from the PPTX/product contract:

- `tilt`: tilt / power adjustment, recovery prior 15%.
- `redistribute`: load rebalancing, recovery prior 40%.
- `neighbor_optimization`: neighboring sector/cell optimization, recovery prior 35%.
- `add_carrier`: add band/carrier, recovery prior 50%.
- `add_sector`: add sector/fourth sector, recovery prior 85%.

Planning-only for now:

- `add_site` / `new_site` should not be executable simulator actions. Site placement needs geospatial planning assumptions not yet validated. Recommendations can mention site planning only as advisory.

## 6. Current UI Model

Main entrypoint:

- `src/main.js`

Core components:

- `src/components/dashboard/TopHeader.jsx`
- `src/components/dashboard/CockpitRail.jsx`
- `src/components/dashboard/TimelineBar.jsx`
- `src/components/admin-map/TunisiaMap.jsx`
- `src/components/panels/CockpitPanel.jsx`
- `src/components/panels/CellOperationalPanel.jsx`
- `src/components/panels/RecommendationCard.jsx`
- `src/components/panels/SimulationImpactCard.jsx`

Normal operator tabs should be:

- `Vue reseau`
- `Heures critiques`
- `Qualite radio`
- `Action cellule`

Admin-only tabs/tools should include:

- Data import/reset.
- Data mode switching.
- Raw system/API/worker/backend health.
- Import/export/debug diagnostics.

Admin mode is controlled through `src/utils/uiPolicy.mjs` using env/URL logic such as `NEXT_PUBLIC_NETVISION_ADMIN_TOOLS=true` or `?admin=1`.

Important recent UI changes already started:

- `CockpitPanel.jsx` now mounts `CellOperationalPanel` for operations.
- Selected-cell QoS panel has a CTA to open `Action cellule`.
- KPI microcopy was added to some QoS cards.
- `TunisiaMap.jsx` hover handling was patched to reduce stale hover text when crossing adjacent delegations.

Remaining UI work:

- Search selection should deterministically set scope to `cell`, open `Qualite radio`, and preserve selected timestamp. Current `selectCell` in `src/main.js` defaults to `operations`, so this needs aligning with the newest plan.
- Add KPI microcopy also inside `CellOperationalPanel`.
- Remove any remaining normal-mode clutter and English/admin text.
- Add clear blocked-simulation messaging from feasibility errors.
- Surface simulation `fidelity_level`, `feasibility`, `credibility`, and `calibration` in result cards.

## 7. Map Architecture and Issues

Map component:

- `src/components/admin-map/TunisiaMap.jsx`

Current map implementation:

- Initializes MapLibre once.
- Adds governorate, delegation, site, heatmap, label, and selected-cell layers.
- Uses safe helpers for `setData`, `setFilter`, paint/layout updates.
- Scope rendering is still mostly interpreted inside the component.

Recent fix:

- Hover now also uses `queryRenderedFeatures` on global `mousemove` to replace stale hover state faster.

Remaining map work from the plan:

- Add a dedicated map state helper that derives all map state from app state only.
- Inputs should include `scope`, `selectedCellName`, `metricMode`, `timelineIndex`, and `mapControls`.
- Outputs should include layer visibility, filters, selected feature id, camera target, and hover policy.
- Refactor `TunisiaMap` to consume this derived state instead of interpreting scope transitions directly.
- Clear hover on source refresh, scope change, map degraded state, and mouseleave.
- Keep selected cell highlight stable across timeline changes.
- Add degraded-mode table workflow in the map column: “Voir cellules prioritaires”.
- Throttle `setData`, filters, paint updates, and timeline refreshes with `requestAnimationFrame`.

## 8. Data Model and Runtime Data

Runtime roots:

- Real mode: `runtime_data`
- Mock mode: `runtime_data_mock`

Selected by:

- `pages/api/_lib/dataMode.js`
- `pages/api/data-mode.js`

Key runtime files:

- `baseline.json`
- `time_index.json`
- `time_data/*.json` or `*.parquet`
- `admin_registry.json`
- `admin_cell_index.json`
- `admin_reconciliation_report.json`
- `neighbor_graph.json`

Data API:

- `pages/api/data/[...slug].js`

Allowed root files are explicitly allowlisted. `time_data` accepts only JSON or Parquet and checks path traversal.

Frontend data building:

- `src/admin/adminData.js`
- `src/admin/adminAggregation.js`
- `src/admin/adminOps.js`
- `src/admin/adminSearch.js`
- `src/admin/importWorker.js`

Important warning:

The old UI used schema keys such as `load` and `traffic`; the new V2 uses normalized fields such as `prb_load`, `throughput`, `throughput_kbps`, `active_users`, `cqi`, `ta`, `health`, and `admin`.

## 9. Backend/FastAPI Components

Python backend:

- `run_backend.py`
- `backend/core_rules.py`
- `backend/action_engine.py`
- `backend/validate_pipeline.py`

Source-truth congestion fixes were partially applied:

- `backend/action_engine.py` uses source-aligned PRB threshold checks.
- `src/utils/v2Contracts.mjs` contains `inferCongestedFromKpis`.
- `src/admin/adminAggregation.js` and some UI panels were updated to use source-rule inference.
- `scripts/generate_mock_runtime_data.py` labels mock congestion using backend core rules.

FastAPI endpoints referenced by plans/context:

- `/health`
- `/predict`
- `/recommendations/export`
- `/recommendations/summary`
- `/cell/{cellname}/history`

Next API endpoints used by the UI:

- `POST /api/recommend`
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs-health`
- `POST /api/simulate` (diagnostic only, should not be normal UI path)
- `GET /api/recommendations-export`
- `GET/POST /api/data-mode`
- `GET /api/data/*`
- `GET /api/peak-hours`

## 10. Jobs, Queue, and Simulation Flow

Main job files:

- `pages/api/jobs/index.js`
- `pages/api/jobs/[id].js`
- `pages/api/_lib/jobs.js`
- `pages/api/jobs-health.js`
- `job-workers/jobWorker.js`

Target simulation flow:

```text
UI -> /api/jobs -> BullMQ/Redis -> job-workers/jobWorker.js
   -> simulation/ns3/adapter/ns3JobAdapter.js
   -> simulation/ns3/scenario-builder/build_scenario.mjs
   -> WSL Ubuntu ns-3 runner
   -> metrics/result artifacts
   -> SQLite job result
   -> UI polling
```

SQLite job DB:

- `.runtime/jobs.sqlite`

Job result artifacts:

- `.runtime/job-results`
- `.runtime/ns3-jobs/<jobId>/`

Recent job reliability changes already started:

- `pages/api/_lib/jobs.js` now has `idempotency_key` in schema and lookup by key.
- `pages/api/jobs/index.js` accepts `Idempotency-Key` header and body `idempotency_key`.
- Duplicate idempotency key with different payload returns a structured validation error.
- `pages/api/_lib/apiErrors.js` was added for structured error envelopes.
- `pages/api/_lib/audit.js` was added for audit JSONL writes.
- `pages/api/_lib/simGuardrails.js` was added for `canSimulate` and plausibility validation.
- `pages/api/jobs-health.js` was extended with basic rolling SLO fields.

Important caveat:

The latest changes were made quickly and must be reviewed. In particular, `pages/api/jobs/index.js` uses `getRuntimeDataRoot().root` as an absolute path and then wraps it with `path.resolve(process.cwd(), ...)`. That is usually harmless with absolute paths, but verify this logic. Also verify that audit writes happen before returns on every path where intended.

## 11. ns-3 Simulator State

ns-3 folder:

- `simulation/ns3/README.md`
- `simulation/ns3/adapter/ns3JobAdapter.js`
- `simulation/ns3/adapter/ns3ResultAdapter.js`
- `simulation/ns3/scenario-builder/build_scenario.mjs`
- `simulation/ns3/runner/netvision-ran-sim.cc`
- `simulation/ns3/schemas/ns3_request.schema.json`
- `simulation/ns3/schemas/ns3_result.schema.json`

Current ns-3 status from README:

- Scenario builder and result adapter are wired.
- C++ runner is a V1 skeleton contract.
- It still needs completion against the local ns-3 LTE build before `/api/jobs-health` reliably reports `ready=true` in a production-like sense.

Environment expected:

```powershell
$env:NETVISION_NS3_WSL_DISTRO = "Ubuntu"
$env:NETVISION_NS3_BINARY = "/home/netvision/ns-3-dev/build/scratch/netvision-ran-sim"
$env:NETVISION_NS3_TIMEOUT_MS = "180000"
```

Verification:

```powershell
npm run ns3:check
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/jobs-health
```

Important product decision:

There should be no silent fast fallback. If ns-3, WSL, Redis, worker, or data are broken, operator UI should block simulation with a clear French message. The old Python simulator in `simulation/simulator.py` is backup/diagnostic only and should not silently run.

## 12. Simulation Contracts

Contract file:

- `pages/api/_lib/simulationContract.js`

Allowed actions currently:

```js
tilt
redistribute
neighbor_optimization
add_carrier
add_sector
```

Current allowed engine:

```js
ns3
```

Current fidelity level:

```js
operations_v1
```

Plan asks for future:

```js
operations_v2_calibrated
```

This has not been fully implemented yet. `simulationContract.js` currently only allows `operations_v1`, so any code claiming v2 support will fail request validation until this is extended.

Expected future simulation result shape:

```json
{
  "fidelity_level": "operations_v1|operations_v2_calibrated",
  "feasibility": {
    "ok": true,
    "warnings": [],
    "blocked_reasons": []
  },
  "credibility": {
    "valid": true,
    "score": 83,
    "reasons": [],
    "validator_version": "netvision-sim-credibility-v1"
  },
  "calibration": {
    "profile": "delegation-band-action",
    "quality": "low|medium|high",
    "baseline_error": {
      "throughput_mape": 0.08,
      "cqi_error": 0.35,
      "load_error": 0.02
    }
  }
}
```

Recent adapter work:

- `simulation/ns3/adapter/ns3ResultAdapter.js` now attempts to add `feasibility`, `credibility`, and richer `calibration`.
- Review this file carefully: it currently imports `pages/api/_lib/simGuardrails.js` from a CommonJS module using `require`. Since `simGuardrails.js` is ESM syntax, this may break under Node depending on module loading. Fix by moving shared guardrails into a CommonJS-compatible module or converting adapter/module boundaries consistently.

## 13. Import/Export State

Current import UI:

- Admin-only `DataPanel` in `src/components/panels/CockpitPanel.jsx`.
- Frontend worker wrapper in `src/admin/importWorker.js`.
- Browser worker likely at `public/workers/dataWorker.js` or similar; locate before editing.

Current export:

- `src/services/operationalApi.mjs` has `downloadRecommendationsCsv(timestamp)`.
- `pages/api/recommendations-export.js` handles CSV export.

Required but not fully implemented:

- Import dry-run mode.
- Schema diff with accepted/unknown/missing fields.
- KPI coverage and sample warnings.
- Reusable import profiles.
- CSV field allowlists.
- Scoped exports by scope and time window.
- Audit entries for import dry-run/apply, restore runtime, data mode switch, context upload/reset, export generation.

Audit helper exists but is only partially wired.

## 14. Security and Rate Limiting

Security helper:

- `pages/api/_lib/security.js`

Current behavior:

- Token auth uses env keys such as `API_AUTH_TOKEN`, `API_TOKEN`, `AUTH_TOKEN`, `SESSION_TOKEN`.
- In non-production or `AUTH_BYPASS=true`, auth can be bypassed if no token is configured.
- Rate limiting uses an in-memory map keyed by client IP and endpoint prefix.

Required hardening still needed:

- Lower rate limit for simulation/job creation/import.
- Moderate rate limit for health/status.
- Higher but explicit limit for local data reads.
- Structured error envelope for auth/rate-limit failures.
- Audit actor source should include token hash or dev-bypass marker.

`auditActor(req)` currently hashes token-ish headers or returns `dev-bypass`.

## 15. Performance Work

Current useful memoization:

- `src/main.js` already uses `useMemo` for many heavy derived values: `cells`, `filteredCells`, `scopedCells`, `siteRows`, `alerts`, rankings, search index, selected entities, summaries, data quality, slice deltas.

Remaining performance plan:

- Add stronger memoized selectors for cells by governorate/delegation/site.
- Virtualize long tables in governorate/delegation/site/cell rankings.
- Throttle MapLibre `setData`, filter, paint, and layout updates with `requestAnimationFrame`.
- Ensure camera changes only on scope identity changes, not timeline changes.
- Add a performance budget script that opens the dashboard, searches `TN1158_c01`, switches timeline 10 times, checks console errors, and writes a report.

Playwright is already in `devDependencies`, but there is no completed top-10 workflow suite yet.

## 16. Testing and QA State

Existing tests/scripts:

- `npm run test:contracts`
- `npm run smoke:v2`
- `npm run smoke:v2:core`
- `npm run smoke:v2:sim`
- `npm run verify:backend`
- `npm run ns3:check`
- `npm run qa:ns3:rationality`

Contract tests currently include:

- `tests/contracts/v2-contracts.mjs`
- `tests/contracts/operational-api-contracts.mjs`
- `tests/contracts/ns3-contracts.mjs`

Last reported contract run passed:

- `node --test tests/contracts/ns3-contracts.mjs`: passed.
- `node --test tests/contracts/v2-contracts.mjs`: passed.
- `npm run test:contracts`: passed 20/20.

Do not assume the app is fully correct because contract tests pass. Browser QA and API smoke are still needed after any substantial change.

Required tests still to add:

- Job idempotency same key/same payload returns same job.
- Job idempotency same key/different payload rejects.
- Structured error shapes across validation/data/engine/infra.
- `canSimulate` blocking cases.
- `operations_v2_calibrated` result contract once supported.
- Plausibility validator impossible deltas.
- Import dry-run no-mutation behavior.
- Scoped export metadata.
- French visible-string snapshots.
- Playwright top-10 operator workflows.
- Performance budget script.
- Full dataset sweep under `.runtime/qa`.

## 17. Known High-Risk Bugs / Review Points

Review these first before extending:

1. `simulation/ns3/adapter/ns3ResultAdapter.js` may have an ESM/CommonJS interop issue due to requiring `pages/api/_lib/simGuardrails.js`.
2. `pages/api/jobs/index.js` structured error shape changed, but frontend `readJsonResponse` in `src/services/operationalApi.mjs` still expects `payload.detail || payload.error`. If `payload.error` is now an object, user-facing error can become `[object Object]`. Fix frontend error parsing.
3. `pages/api/jobs/index.js` computes `runtimeRoot` from `getRuntimeDataRoot`; verify path handling.
4. `simulationContract.js` allows only `operations_v1`; do not advertise `operations_v2_calibrated` until validation and implementation are complete.
5. `canSimulate` currently checks `baseline[cell].prb_load`, but runtime KPI values may live in current time observations rather than baseline. It must validate against the selected time slice, not only baseline.
6. `canSimulate` should verify `time_entry.filename` exists in `time_index.json`; current worker has its own time-file validation, but pre-queue feasibility should catch it too.
7. Idempotency compares raw `JSON.stringify(jobDefinition.payload)`. This can be order-sensitive if payload object key order differs. Prefer canonical JSON stable stringify.
8. Audit logging is incomplete and should be wired to all admin actions.
9. Jobs DB schema was changed in both API helper and worker should stay aligned. Check `job-workers/jobWorker.js` table schema: it may not include `idempotency_key` yet.
10. `/api/jobs-health` SLO query selected `error_text` after a patch, but verify SQL and result parsing in a live run.

## 18. Immediate Next Work

Recommended next sequence:

1. Stabilize current partial backend changes:
   - Fix module interop in ns-3 result adapter.
   - Fix frontend structured error parsing.
   - Align worker SQLite schema with API schema.
   - Replace idempotency raw stringify with stable canonical payload hash.
   - Extend `canSimulate` to read selected time slice and time index.

2. Finish simulation maturity:
   - Add `operations_v2_calibrated` to `simulationContract.js`.
   - Implement calibration profiles keyed by governorate/delegation/band/action.
   - Add action-specific realism checks for tilt, redistribute, neighbor optimization, carrier, sector.
   - Reject implausible ns-3 outputs before storing `done` results.
   - Surface feasibility/credibility/calibration in `SimulationImpactCard.jsx`.

3. Finish import/export/audit:
   - Locate browser data worker.
   - Add dry-run command.
   - Add allowlist sanitization.
   - Store profiles.
   - Add scoped export API and UI.
   - Audit import/export/data-mode/restore actions.

4. Finish map/perf:
   - Create map state helper module.
   - Refactor `TunisiaMap`.
   - Add degraded table workflow.
   - Add table virtualization.
   - Add performance budget script.

5. Finish QA:
   - Add Playwright workflow tests.
   - Add full dataset sweep.
   - Run contract, smoke, browser, and ns-3 rationality tests.

## 19. Product Tone and UX Rules

The normal operator UI must be French-first. Avoid English body text in normal mode.

Do not show these in normal mode:

- `FastAPI`
- `Redis`
- `worker`
- `backend`
- `queue`
- `mock`
- `drift`
- `artifact`
- raw endpoint names
- raw AI/classifier confidence
- "AI" phrasing

Operator wording should be concrete:

- `Simulation indisponible: verifier le service dans Admin.`
- `Simulation bloquee: voisins insuffisants pour cette action.`
- `Charge PRB: Mesure la pression capacitaire radio.`
- `Debit: Mesure l experience utilisateur.`
- `CQI: Indique la qualite radio percue.`
- `Utilisateurs actifs: Montre la demande instantanee.`
- `TA: Aide a detecter bord de cellule/couverture.`

Admin mode can expose technical service names, but explanatory text should still be French.

## 20. Do Not Do

- Do not silently fall back to the old Python simulator.
- Do not reintroduce `add_site` or `new_site` as executable simulation actions.
- Do not claim ns-3 is physically accurate until calibration and validation prove it.
- Do not make national/governorate-scale ns-3 simulations from the UI.
- Do not restore old UI clutter wholesale.
- Do not hide broken infra behind optimistic UI states.
- Do not reset the dirty worktree.

## 21. Completion Definition

This phase is complete only when:

- Normal mode supports the full operator path: search/select cell -> QoS evidence -> Action cellule -> queued ns-3 simulation -> before/after result.
- Infeasible simulations are blocked before queueing with a French reason.
- `/api/jobs` returns structured errors and correct idempotency behavior.
- `/api/jobs-health` reports readiness and SLOs.
- Import dry-run and scoped exports exist and audit entries are written.
- Map hover/selection/timeline behavior is stable under fast interactions.
- Performance budget script and Playwright top-10 workflows run.
- `npm run test:contracts`, smoke scripts, and relevant browser QA pass.

