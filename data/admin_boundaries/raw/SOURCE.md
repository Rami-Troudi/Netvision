# Tunisia Administrative Boundary Sources

This folder is the local staging area for official administrative boundary and registry source files.

## Geometry Source

Primary geometry source: HDX / COD-AB Tunisia administrative boundaries.

- Dataset: `cod-ab-tun`
- Public mirror inspected: `https://www.data4tunisia.org/en/datasets/cod-ab-tun/`
- Required download: `tun_admin_boundaries.geojson.zip`
- Expected files inside the ZIP:
  - `tun_admin2.geojson`: 24 governorate polygons
  - `tun_admin3.geojson`: delegation polygons

Place the ZIP here if automatic download is unavailable:

```text
data/admin_boundaries/raw/tun_admin_boundaries.geojson.zip
```

## Registry / Name Validation Sources

Target registry source: INS / RGPH 2024 census/admin tables.

Optional local CSV path:

```text
data/admin_boundaries/raw/ins_rgph_2024_delegations.csv
```

Recommended columns:

```text
gov_name,deleg_name
```

Validation source: Ministry of Interior open data for territorial sectors by governorate and delegation.

Optional local CSV path:

```text
data/admin_boundaries/raw/ministry_interior_delegations.csv
```

Recommended columns:

```text
gov_name,deleg_name
```

## Important Current Constraint

The COD-AB dataset inspected by this repository contains 264 delegation polygons, while the requested INS/RGPH target is 279 delegations. The pipeline must not invent or silently drop delegation polygons. It records this mismatch in `runtime_data/admin_reconciliation_report.json`.
