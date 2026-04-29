# Demo and Real Data Modes

NetVision now supports two runtime data modes:

| Mode | Purpose | Runtime root |
| --- | --- | --- |
| `real` | Real imported/generated project data | `runtime_data/` |
| `mock` | Demo data covering every available Tunisia delegation in the current admin registry | `runtime_data_mock/` |

## API

Read the current mode:

```bash
curl http://127.0.0.1:3001/api/data-mode
```

Switch mode:

```bash
curl -X POST http://127.0.0.1:3001/api/data-mode \
  -H 'content-type: application/json' \
  --data '{"mode":"mock"}'
```

The mode is persisted in `.runtime/data_mode.json`. `DATA_MODE=real` or `DATA_MODE=mock` can be used as an environment override.

## Generate Mock Data

```bash
python3 scripts/generate_mock_runtime_data.py
```

The generator writes:

| File | Purpose |
| --- | --- |
| `runtime_data_mock/baseline.json` | 3 demo cells per available delegation |
| `runtime_data_mock/time_index.json` | 24 hourly demo slices |
| `runtime_data_mock/time_data/*.json` | KPI observations for each demo slice |
| `runtime_data_mock/stats.json` | Demo dataset summary |
| `runtime_data_mock/admin_cell_index.json` | Cell-to-delegation mapping |
| `runtime_data_mock/admin_registry.json` | Copy of the current admin registry |
| `runtime_data_mock/admin_reconciliation_report.json` | Demo reconciliation summary |

The current registry contains 264 COD delegation polygons, so the mock generator creates 792 cells. It does not invent the missing INS/RGPH target delegations.

## UI

Open the Data tab and use the `Mode` selector:

- `Real mode` shows the active production/runtime dataset.
- `Mock demo mode` switches the dashboard to the generated demo dataset immediately.

The map, scope footer, aggregation, search, peak-hours endpoint, admin cell index, and reconciliation status follow the active mode.
