# NetVision V2 Feature Matrix

| Old capability | Current V2 target | API/data dependency | Test coverage |
| --- | --- | --- | --- |
| Timeline previous/next/playback | Timeline bar plus map/panel refresh | `/api/data/time_data/*` | Browser QA plus `smoke:v2` data route |
| Smart recommendations | Operations tab recommendation cards | `POST /api/recommend`, FastAPI `/predict` | Contract mapping tests, browser QA |
| Recommendation-to-simulation | Recommendation card `Simulate` action | `POST /api/jobs`, `GET /api/jobs/:id`, worker | Contract payload tests, `smoke:v2`, browser QA |
| Manual simulator | Operations action selector | `POST /api/jobs`, `POST /api/simulate` diagnostic | Contract action tests, `smoke:v2` all supported actions |
| Site planning | Operations site planning card | `add_site` / `new_site` simulator actions | `smoke:v2`, browser QA |
| Analytics modal | Analytics tab | runtime cells, `/api/peak-hours`, FastAPI summary later | Browser QA |
| Explore modal | Analytics peak pressure section | `/api/peak-hours` | Browser QA |
| Import CSV mapping | Data tab ingestion workflow | data worker, `POST /api/recommend-context` | Browser/manual fixture QA |
| Export JSON/report | Data tab export actions | in-browser report builder | Browser QA |
| Recommendation CSV export | Data tab CSV actions | `GET /api/recommendations-export`, FastAPI `/recommendations/export` | `smoke:v2` |
| Map basemap/view/layers | Stable admin-first map controls | MapLibre sources/layers, normalized map state | Contract map tests, browser QA |
| Layer toggles | Map control strip | map source/layer guards | Browser QA |
| Search | Header global search opens Operations for cells | normalized search index | Browser QA |
| System readiness | System tab endpoint cards | health routes, Redis/worker state | `smoke:v2`, browser QA |

## V2 Acceptance Rule

A feature is considered migrated only when it is reachable in the unified cockpit, has a clear empty/error state, and has either contract, API smoke, or browser QA coverage.
