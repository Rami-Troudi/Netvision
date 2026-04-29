# NetVision UI Feature Audit

Generated after browser inspection with Playwright against `http://127.0.0.1:3001`.

## Summary

| Result | Count |
| --- | ---: |
| PASS | 42 |
| FAIL | 0 |

## Coverage

| Feature / Endpoint | Status | Detail |
| --- | --- | --- |
| Real data mode API | PASS | `POST /api/data-mode` returned `200` |
| Page shell | PASS | title, `#main-content`, skip link, timeline, search, metric selector |
| Map rendering | PASS | MapLibre canvas rendered |
| Cockpit tabs | PASS | triage, operations, actions, data, system mounted and rendered |
| Runtime data endpoint | PASS | `GET /api/data/stats.json` returned `200` |
| Data mode endpoint | PASS | `GET /api/data-mode` returned `200` |
| Peak hours endpoint | PASS | `GET /api/peak-hours` returned `200` |
| Backend health endpoint | PASS | `GET /api/backend-health` returned `200` |
| Jobs health endpoint | PASS | `GET /api/jobs-health` returned `200` |
| Drift endpoint | PASS | `GET /api/drift` returned `200` with graceful degraded support |
| Data ingestion controls | PASS | mode selector, CSV import, restore runtime |
| Export controls | PASS | scoped JSON, report, recommendations CSV |
| Mock mode API | PASS | `POST /api/data-mode` returned `200` |
| Mock runtime data | PASS | 792 generated cells loaded |
| Mock delegation coverage | PASS | 264 available COD delegations covered |
| Search | PASS | delegation/site/cell search returns results and changes scope |
| Operations panel | PASS | filters and scoped site table/empty state render |
| Cell action workflow | PASS | site row selection reaches cell/action workflow |
| Dark mode | PASS | toggle changes app shell from light to dark |
| Focus mode | PASS | toggle applies focus layout |

## Notes

- Forecast was intentionally excluded from the audit per the current product direction.
- `jobs-health` may report degraded when Redis is absent, but the UI endpoint and graceful degraded state are wired.
- `drift` may report unavailable when model artifacts are absent, but the UI endpoint and graceful degraded state are wired.
- Mock data is demo-only. It is generated from the current admin registry and delegation centers, not official radio measurements.
