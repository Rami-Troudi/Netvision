# Tunisia Administrative Map Drilldown

NetVision now uses an offline-first MapLibre administrative map for the frontend command center. No satellite, street, OSM, or external basemap tiles are used.

## Sources

Geometry source: HDX / COD-AB Tunisia administrative boundaries (`cod-ab-tun`). The pipeline expects `tun_admin_boundaries.geojson.zip` and reads:

- `tun_admin2.geojson` for 24 governorates
- `tun_admin3.geojson` for delegation polygons

Registry target: INS / RGPH 2024 admin tables. If available, place a CSV at:

```bash
data/admin_boundaries/raw/ins_rgph_2024_delegations.csv
```

Validation source: Ministry of Interior open data. If available, place a CSV at:

```bash
data/admin_boundaries/raw/ministry_interior_delegations.csv
```

Both CSVs should include `gov_name` and `deleg_name` columns.

## Commands

Fetch geometry:

```bash
python scripts/fetch_admin_boundaries.py
```

Prepare public GeoJSON and runtime registry:

```bash
python scripts/prepare_admin_boundaries.py
```

Join runtime cells to delegation polygons:

```bash
python scripts/build_admin_cell_index.py
```

## Generated Files

Frontend static assets:

- `public/geo/tunisia_governorates.geojson`
- `public/geo/tunisia_delegations.geojson`
- `public/geo/admin_registry.json`
- `public/geo/admin_cell_index.json`
- `public/geo/admin_reconciliation_report.json`

Runtime support files:

- `runtime_data/admin_registry.json`
- `runtime_data/admin_cell_index.json`
- `runtime_data/admin_reconciliation_report.json`

## Reconciliation Meaning

The currently inspected COD-AB source contains 24 governorates and 264 delegation polygons. The requested INS/RGPH 2024 target is 279 delegations. The pipeline does not invent or silently drop polygons; it records the mismatch in `admin_reconciliation_report.json`.

## Drilldown Behavior

The frontend scope model is:

```js
national -> governorate -> delegation -> cell
```

- National scope shows governorates and national KPI aggregation.
- Governorate scope highlights the selected governorate and fades in delegations.
- Delegation scope reveals matched radio sites and sector wedges.
- Cell scope enables `/api/recommend` and `/api/simulate` workflows.

Sites and sectors are hidden before delegation scope by design.
