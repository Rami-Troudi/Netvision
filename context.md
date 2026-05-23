# ODC Migration Context

## Purpose

Living investigation notes for migrating the feature-rich old UI into the new `Rami-UI-refactor` interface.

## Current Working Assumptions

- The current branch `codex/Rami-UI-refactor` matches `origin/main` and `origin/Rami-UI-refactor` at `2669a5e`.
- The new UI was introduced after the old feature-rich interface. In the visible history, the likely refactor boundary is:
  - Old UI candidate: `c32c7fd` (`Finalize release readiness and UI simulator action gating`, 2026-04-26)
  - New UI start: `3a4a006` (`Rebuild NetVision cockpit UI with admin drilldown and ingestion`, 2026-04-27)
- There are no commits dated February or March 2026 in the fetched repository history. The relevant old UI is likely April pre-refactor or December prototype history.
- Real KPI CSV files are not present in this clone. Local testing currently uses bundled mock runtime data.

## Known Current Stack State

- New UI runs on `http://127.0.0.1:3000`.
- FastAPI backend runs on `http://127.0.0.1:8000`.
- Portable Redis `7.4.9` runs on `127.0.0.1:6381`.
- BullMQ worker runs against `REDIS_URL=redis://127.0.0.1:6381`.
- Current UI smoke passed: dashboard renders, backend health OK, worker ready, simulation queue ready, direct simulation and queued simulation both work.

## Investigation Method

- Keep current workspace on `codex/Rami-UI-refactor`.
- Use isolated worktrees for old commits/branches.
- Run old UI candidates on separate ports to avoid interfering with the current app.
- Test in browser with screenshots, DOM checks, console checks, and API/worker checks.
- Record feature inventory, behavior, regressions, and migration requirements here as findings accumulate.

## Branch and Commit Map

- `origin/main`, `origin/Rami-UI-refactor`, local `main`, and local `codex/Rami-UI-refactor` are at `2669a5e` (`Stabilize local Redis and FastAPI integration`, 2026-04-30).
- `3a4a006` (`Rebuild NetVision cockpit UI with admin drilldown and ingestion`, 2026-04-27) is the first visible new UI commit.
- `c32c7fd` (`Finalize release readiness and UI simulator action gating`, 2026-04-26) is the best old UI migration source so far.
- `origin/prototype-v1` ends at `dce04b1` (2026-04-20) and feeds the old feature lineage; `c32c7fd` contains that branch plus later readiness and simulator-gating fixes.
- The fetched history has no February or March 2026 commits. The user's "Feb/March old UI" memory likely maps to April pre-refactor history in this clone, unless there are missing/private refs.

## Old UI Runtime Under Test

- Old UI worktree: `.runtime/worktrees/old-ui-c32c7fd`.
- Commit under test: `c32c7fd`.
- Old UI URL: `http://127.0.0.1:3001`.
- FastAPI backend URL: `http://127.0.0.1:8000`.
- Redis: portable Redis `7.4.9` at `127.0.0.1:6381`.
- Old worker: running with `JOB_QUEUE_NAME=old-ui-jobs` and `REDIS_URL=redis://127.0.0.1:6381`.
- Old UI title: `NetVision Digital Twin | Orange Network Operations`.
- Screenshot evidence:
  - `.runtime/screenshots/old-ui-recommendation-simulation.png`
  - `.runtime/screenshots/new-ui-overview.png`
  - `.runtime/screenshots/new-ui-cell-qos-no-simulator.png`

## Old UI Feature Inventory

- Header toolbar:
  - Theme toggle (`#btn-theme`)
  - Analytics modal (`#btn-analytics`)
  - Data exploration modal (`#btn-explore`)
  - Import CSV modal (`#btn-import`)
  - Export modal (`#btn-export`)
  - Refresh data (`#btn-refresh`)
  - Fullscreen app (`#btn-fullscreen-app`)
- Timeline:
  - Previous, next, play/pause, slider, current/start/end labels.
  - Browser QA confirmed next and play/pause change timeline state.
- Map:
  - MapLibre map with satellite and streets basemaps.
  - 3D/2D mode toggle.
  - Sectors/Heatmap visualization toggle.
  - Legend collapse/expand.
  - Layer checkboxes for sectors, sites, labels, and clusters.
- Left panels:
  - Network Overview.
  - Performance Metrics.
  - Network Impact Summary.
  - Active Alerts.
- Right panels:
  - Smart Recommendations.
  - Action Simulator.
  - Site Planning.
  - Filters.
  - Search.
  - Layers.
  - Shortcuts.
- Modals/workflows:
  - Analytics: Issue Distribution, Severity Distribution, Band Performance, Load Distribution.
  - Explore: duration/metric selectors, update button, peak/off-peak/average insight cards.
  - Export: JSON, CSV, report, congested-cells-only export buttons.
  - Import: CSV upload, auto-detected type, reference/KPI type selector, session mode selector, strict congestion mode, mapping grid, preview, pre-import summary, save mapping profile, confirm import.

## Old UI Browser QA Findings

- Initial render:
  - Old UI renders the full operations console on `http://127.0.0.1:3001`.
  - Console repeatedly warns `stats.json unavailable (404); using fallback global stats`.
  - Console repeatedly reports `[DATA SCHEMA WARNING] Missing keys in historical slice 01-12-2025 00:00: load, traffic. Expected keys: load, throughput, traffic, ta, cqi`.
  - Impact: some old UI KPI cards show `0`, `N/A`, or misleading values even when backend simulator/recommendation logic works.
- Timeline:
  - `#time-next`, `#time-play`, and pause interaction worked in browser QA.
  - Current label id is `#time-current-label`.
- Theme:
  - `#btn-theme` toggles dark/light body class and can toggle back.
- Map controls:
  - Basemap select switched to `streets` and back to `satellite`.
  - 2D mode button clicked successfully.
  - Heatmap visualization button clicked successfully.
  - Legend collapse/expand worked.
  - Layer labels for `Cell Sectors` and `Site Markers` toggled the hidden checkbox state off and back on. Direct input targeting is fragile because the checkbox itself is visually hidden.
- Filters:
  - Filter controls and Apply/Reset buttons are present and clickable.
  - Automation filled `#load-min` with `70` and clicked Apply, but the displayed load range stayed `0% - 100%` while alert counts changed. This needs manual/code-level verification before migrating the filter state model.
- Sidebars:
  - Left and right sidebar collapse/expand controls worked and applied `collapsed` classes.
- Analytics:
  - Modal opens/closes.
  - Four chart canvases exist.
  - Summary text was empty in the mock-data run.
- Explore:
  - Modal opens/closes.
  - Metric selector changed to `avg_load`.
  - Refresh worked and insights rendered peak/off-peak/average content.
- Export:
  - Modal opens/closes.
  - Export options present: `export-json`, `export-csv`, `export-report`, `export-congested`.
  - Browser tool cannot fully validate client-side downloads reliably; backend recommendations CSV export was separately validated.
- Import:
  - Modal opens/closes.
  - Switching import type to KPI works.
  - Strict mode remains disabled until a Congestion Flag column is mapped.
  - Mapping grid correctly says `Upload a CSV to start column mapping` before a file is selected.
  - Browser automation surface does not expose a reliable file-upload method here, so full CSV file import remains pending/manual or code-level test.
- Search and selection:
  - Searching `TN1158_c01` returns a cell result.
  - Selecting it activates the action/site-planning context.
  - At the initial slice, recommendation panel shows `Add Sector` with long-term badge and `Simuler cette action`.

## Old UI Simulator and Recommendation Findings

- UI action simulator:
  - Selecting `tilt` builds the parameter UI.
  - `Run Simulation` completed with a `Fast (65% confidence)` before/after result and chart.
- Recommendation-to-simulation:
  - At `01-12-2025 00:00`, `TN1158_c01` gets an `Add Sector` recommendation.
  - Clicking `Simuler cette action` completed with a `Fast (75% confidence)` result and `planned_sector` impact text.
- Site planning:
  - With `TN1158_c01` selected, site planning enables.
  - `rooftop` site planning completed with a `Fast (82% confidence)` result and `planned_site` impact text.
- Direct simulator API on old UI (`POST /api/simulate`) was tested for all visible/backend actions:
  - Supported and passing: `tilt`, `redistribute`, `add_carrier`, `add_sector`, `add_site`, `new_site`.
  - Unsupported and correctly rejected with 400: `power`, `parameter_tuning`, `mimo_upgrade`, `small_cell`, `split_cell`.
  - Important code smell: old `src/main.js` still contains parameter UI cases for unsupported actions, but the visible select only exposes supported actions.
- Recommendations API spot check:
  - `TN1158_c01`: `Add Sector`.
  - `TN1158_c02`: `Tilt Adjustment`.
  - `TN1159_c02`: `Tilt Adjustment`.
  - `TN1164_c03`: `Tilt Adjustment`.
  - `TN1166_c01`: `Add Sector`.
  - `TN1559_c01`: `Add Sector`.
  - `TN5154_c02`: `Check Coverage/Interference` (not simulator-supported).

## Old API and Data Endpoint Findings

- `GET http://127.0.0.1:3001/api/recommendations-export?timestamp=01-12-2025%2000%3A00` works:
  - Status 200.
  - Content type `text/csv; charset=utf-8`.
  - Size about 136 KB.
  - First columns include `cell_name,enodeb_name,frequency_band,date,hour,prb_load,throughput_kbps,active_users,...`.
- Old Next app does not expose current-UI health endpoints:
  - `GET /health` on port 3001 returns 404.
  - `GET /api/backend-health` on port 3001 returns 404.
  - `GET /api/jobs-health` on port 3001 returns 404.
- Old data file route differences:
  - `GET /api/data/manifest.json` returns 400 `Invalid data path`.
  - `GET /api/data/stats.json` returns 404 `Data file not found on disk`.
  - The old UI falls back around missing `stats.json`, but the missing/changed data contract explains several UI metric inconsistencies in the mock-data run.

## New UI Comparison Findings

- Current new UI URL: `http://127.0.0.1:3000`.
- Title: `NetVision Digital Twin | Tunisia RAN Command Center`.
- New UI is an admin/regional cockpit:
  - National, governorate, delegation, and cell scopes.
  - Overview, Peak Hours, QoS Analysis, Data Quality, System Status.
  - Global search.
  - Administrative polygons and scope-driven site visibility.
  - Watchlist/saved views/guided demo/report export.
- Selecting `TN1158_c01` in the new UI:
  - Reaches cell scope: `Current scope cell, Tunis, El Menzah, TN1158_c01`.
  - Shows QoS analysis, RAN classification, KPI cards, and cell context.
  - Does not show old operational workflows.
- New UI simulator/recommendation absence confirmed in DOM:
  - No `.cell-panel`.
  - No `#sim-action`.
  - No `[data-testid="queue-simulation"]`.
  - No old `#action-run`.
  - No visible text matches for `Backend Recommendations`, `Action Simulator`, `Site Planning`, or `Smart Recommendations`.
- Source comparison:
  - New UI has `src/components/panels/CellOperationalPanel.jsx`, `RecommendationCard.jsx`, and `SimulationImpactCard.jsx`.
  - `src/components/panels/CockpitPanel.jsx` does not import or mount `CellOperationalPanel`.
  - Therefore the new UI has partial simulator/recommendation React code, but it is effectively orphaned from the visible cockpit.

## Migration Implications

- The old UI feature migration is not just "copy simulator code":
  - Need mount an operational cell panel or equivalent inside the new cell-level QoS flow.
  - Need reconcile old `load`/`traffic` schema expectations with new `prb_load`/`active_users` fields and mock/real data modes.
  - Need decide whether old map-level controls (3D/2D, heatmap/sectors, layer toggles) belong in the new admin map, and how they map to delegation/cell scope behavior.
  - Need preserve old recommendation-to-simulation flow, queued jobs, job polling, and before/after cards.
  - Need preserve site planning as a first-class flow, not just a backend action.
  - Need either migrate old import/export richness or intentionally supersede it with the new Data Quality panel's simpler import/export.
- High-value migration targets:
  - Cell operational drawer/panel in new cell scope.
  - Backend recommendation cards wired to `POST /api/recommend`.
  - Queued simulator action selector wired to `POST /api/jobs` and `GET /api/jobs/:id`.
  - Site planning subsection using `new_site`/`add_site`.
  - Recommendation CSV export pathway.
  - Import mapping workflow, if the product still needs non-admin users to map arbitrary CSVs.
- Risks:
  - Old UI data-contract warnings can hide real feature regressions by making the UI look "empty" while APIs work.
  - Current backend service on port 8000 may be serving the old worktree during this investigation. Before implementation, restore/confirm backend process origin for the current branch.
  - Browser console logs can include earlier same-tab history, so source/timestamps should be considered when interpreting repeated warnings.
