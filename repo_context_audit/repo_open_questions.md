# Repo Open Questions

## Product

- Is current `main` the intended demo/production branch, or should the `target/main` forecast snapshot be considered the future target?
- Should NetVision remain a NOC operations console only, or also include planning pages such as the `pages/site-planning.js` present on `target/main`?
- Which user role is primary for action ranking: NOC triage, RF optimization, CAPEX planning, or executive demo?
- Are action labels expected to be English (`Load Rebalancing`, `Add Site`) or French legacy labels (`Équilibrage MLB`, `Nouveau site macro`)?

## Data

- Where should raw CSV files live: `data/` as README says, or repo root as `process_time_series.py` defaults?
- What is the canonical production dataset size: local 50-cell sample, validation script 1554 cells, or another number?
- Is `runtime_data/model_assets` still part of the product, or should drift/validation be removed with the forecast/model pipeline?
- Which KPI column names are contractually required for imported and generated datasets?
- Should generated `peak_hours.json` and `peak_hours.csv` be written by an API route at runtime, or generated only by an offline pipeline?

## Frontend

- Should site-planning use the async queue like the main action panel, or keep direct `/api/simulate` calls?
- Are legacy action UI branches (`power`, `parameter_tuning`, `mimo_upgrade`, `small_cell`, `split_cell`) intentionally preserved for future work?
- Should the dashboard continue using an imperative `src/main.js` architecture, or is a React component refactor planned?
- What is the expected behavior when FastAPI is unavailable: hard error, local fallback, or disabled recommendation panels?
- Should imported datasets persist beyond page reload, or is an in-memory session sufficient?

## Backend

- What values should `SITE_SATURATION_CELL_RATIO` and `SITE_SATURATION_MIN_DAYS` have in `backend/core_rules.py`?
- Should `RECOVERY_RATES` include `actions_on_neighbors`, `add_band`, and `check_coverage`, or should `action_engine.py` stop using those keys?
- Is FastAPI intended to be externally reachable, or only private behind Next.js API proxies?
- Should `/cells`, `/recommendations/summary`, and `/cell/{cellname}/history` be wired into UI flows?
- Should backend context upload be global process state, per session/user, or demo-only?

## Simulation

- Are simulator recovery envelopes meant to override the more detailed physics formulas, or should they only constrain outliers?
- Should `add_carrier` validate same-site existing bands server-side, not just in the UI?
- What is the desired distinction between `new_site` and `add_site` in API/action naming?
- Should unsupported frontend legacy actions be removed or implemented in `simulation/simulator.py`?
- Should simulator use `python`, `python3`, or configurable `PYTHON_BIN` for cross-platform startup?

## Forecast

- Is forecast intentionally removed from current `main`, or accidentally dropped during branch updates?
- If forecast returns, should it use the `target/main` scripts/model, or a new design?
- Where should forecast output live and how should it integrate with `time_index.json`?
- Should drift depend on forecast validation artifacts, or become a separate backend health check?

## Deployment

- What is the target deployment environment: Windows local demo, Linux server, Docker Compose, Vercel + separate FastAPI, or something else?
- Should `start.ps1` remain the primary one-command startup path?
- Is there a Linux/macOS equivalent startup script planned?
- Should Redis be mandatory in all environments, or should direct simulation be the default when Redis is absent?
- Should `.runtime/jobs.sqlite` be ephemeral per deployment or persisted?

## Security

- Is development auth bypass acceptable for shared demos, or should all environments require tokens?
- Which token env name should be canonical among `API_AUTH_TOKEN`, `API_TOKEN`, `AUTH_TOKEN`, and `SESSION_TOKEN`?
- Should rate limiting be moved from process-local memory to Redis for multi-instance deployments?
- Should FastAPI endpoints have their own auth if exposed outside localhost?
- Are uploaded CSV contents considered sensitive operational network data that need retention and audit policies?

## Demo workflow

- Which exact commands should a fresh evaluator run, and on which OS?
- Which sample dataset should be included or provided out of band for demos?
- Should the demo show drift and forecast, or hide those controls until artifacts exist?
- Should backend validation be part of demo startup, given current missing model artifacts?
- What is the expected "known good" cell/action example for verifying recommendation and simulation behavior?
