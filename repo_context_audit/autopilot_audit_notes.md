# Autopilot Audit Notes (2026-05-26)

## Purpose

This note captures the audit context for the current NetVision repository state so the investigation can resume without losing context. It focuses on the codex-related documents, an inventory snapshot, and the most important file-level findings that affect product behavior.

## Codex context sources

- `handover.md` references the original Codex workspace path and provides a full technical handover, current product direction, and a summary of the old/new UI split.
- `context.md` records the ODC migration investigation, commit boundaries, and old UI feature inventory.
- No files containing `codex` in their filename exist in the repo; the codex context is embedded in `handover.md` and `context.md`.

## Repository inventory snapshot

Inventory was collected from `git ls-files` to scope the audit:

- Total tracked files: **901**
- Root files (14): `.env.example`, `.eslintrc.json`, `.gitignore`, `README.md`, `context.md`, `docker-compose.yml`, `handover.md`, `next.config.js`, `package-lock.json`, `package.json`, `parsec-linux.deb`, `requirements.txt`, `run_backend.py`, `start.ps1`
- Top-level directory counts:
  - `.playwright-mcp`: 7
  - `artifacts`: 3
  - `assets`: 2
  - `backend`: 6
  - `data`: 1
  - `docs`: 11
  - `job-workers`: 4
  - `pages`: 27
  - `public`: 6
  - `repo_context_audit`: 4
  - `runtime_data_mock`: 728
  - `scripts`: 20
  - `simulation`: 13
  - `src`: 48
  - `tests`: 7

## Key file observations by area

### Root and docs

- `README.md` documents stack, quickstart, and the current architecture boundaries (no forecast pipeline in mainline).
- `handover.md` is the primary codex-era handover with product direction, UI priorities, and ns-3 work.
- `context.md` is the living migration log for the old UI vs new UI transition.

### Frontend

- `pages/index.js` renders the static dashboard shell; the interactive console is imperative JS in `src/main.js`.
- `src/components/**` contains the V2 cockpit React panels and the admin map.
- `src/utils/**` includes normalization and timestamp helpers used by UI and tests.

### API routes and server helpers

- `pages/api/**` exposes data access, drift, recommendations, simulation, import, export, and health routes.
- `pages/api/_lib/**` centralizes auth, jobs, audit logging, simulation contracts, and shared API helpers.

### Backend and simulation

- `backend/api.py` and `backend/action_engine.py` provide FastAPI recommendations and rule evaluation.
- `simulation/simulator.py` powers direct and queued simulations.

### Data + worker

- `public/workers/dataWorker.js` performs heavy CSV and feature updates.
- `job-workers/jobWorker.js` runs BullMQ jobs and calls the simulator.
- `runtime_data_mock/**` contains the majority of tracked files (mock runtime data slices).

### Tests

- `tests/contracts/*.mjs` validates API contracts, simulation contracts, and forecast scaffolding.

## Verification status (2026-05-26)

- `npm run lint`: passed (Next.js lint deprecation notice only).
- `npm run build`: succeeded (Next 15.5.15).
- `npm run test:contracts`: 2 failures due to missing `runtime_data/time_index.json` in the repo clone; other suites passed.

## Follow-ups for deeper per-file review

- Full per-file annotations are pending; use the inventory snapshot above to resume file-by-file notes.
- Ensure `runtime_data/time_index.json` exists before re-running ns-3 contract tests.
