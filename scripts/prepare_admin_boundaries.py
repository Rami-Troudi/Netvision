#!/usr/bin/env python3
"""Prepare Tunisia governorate/delegation GeoJSON and admin registry from COD-AB."""

from __future__ import annotations

import argparse
import csv
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TARGET_GOVERNORATES = 24
TARGET_DELEGATIONS_INS_RGPH_2024 = 279


def read_geojson_from_zip(zip_path: Path, member: str) -> dict[str, Any]:
    if not zip_path.exists():
        raise FileNotFoundError(
            f"Missing {zip_path}. Run scripts/fetch_admin_boundaries.py or place the COD-AB ZIP there."
        )
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open(member) as handle:
            return json.load(handle)


def compact_geometry(feature_collection: dict[str, Any], level: str) -> dict[str, Any]:
    features = []
    for feature in feature_collection.get("features", []):
        props = feature.get("properties") or {}
        if level == "governorate":
            out_props = {
                "gov_id": props.get("adm2_pcode"),
                "gov_name": props.get("adm2_name"),
                "gov_name_ar": props.get("adm2_name1"),
                "region_id": props.get("adm1_pcode"),
                "region_name": props.get("adm1_name"),
                "source_level": "COD-AB ADM2",
                "area_sqkm": props.get("area_sqkm"),
                "center_lon": props.get("center_lon"),
                "center_lat": props.get("center_lat"),
            }
        else:
            out_props = {
                "deleg_id": props.get("adm3_pcode"),
                "deleg_name": props.get("adm3_name"),
                "deleg_name_ar": props.get("adm3_name1"),
                "gov_id": props.get("adm2_pcode"),
                "gov_name": props.get("adm2_name"),
                "region_id": props.get("adm1_pcode"),
                "region_name": props.get("adm1_name"),
                "source_level": "COD-AB ADM3",
                "area_sqkm": props.get("area_sqkm"),
                "center_lon": props.get("center_lon"),
                "center_lat": props.get("center_lat"),
            }
        features.append(
            {
                "type": "Feature",
                "properties": out_props,
                "geometry": quantize_geometry(feature.get("geometry")),
            }
        )
    return {"type": "FeatureCollection", "features": features}


def quantize_geometry(geometry: dict[str, Any] | None, digits: int = 4, tolerance: float = 0.001) -> dict[str, Any] | None:
    if not geometry:
        return geometry

    def point_distance(point: list[float], start: list[float], end: list[float]) -> float:
        x, y = point[:2]
        x1, y1 = start[:2]
        x2, y2 = end[:2]
        dx = x2 - x1
        dy = y2 - y1
        if dx == 0 and dy == 0:
            return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        px = x1 + t * dx
        py = y1 + t * dy
        return ((x - px) ** 2 + (y - py) ** 2) ** 0.5

    def simplify_ring(ring: list[list[float]]) -> list[list[float]]:
        if len(ring) <= 12:
            return ring
        closed = ring[0][:2] == ring[-1][:2]
        work = ring[:-1] if closed else ring

        def dp(points: list[list[float]]) -> list[list[float]]:
            if len(points) <= 2:
                return points
            start, end = points[0], points[-1]
            max_dist = -1.0
            max_idx = 0
            for idx in range(1, len(points) - 1):
                dist = point_distance(points[idx], start, end)
                if dist > max_dist:
                    max_dist = dist
                    max_idx = idx
            if max_dist > tolerance:
                return dp(points[: max_idx + 1])[:-1] + dp(points[max_idx:])
            return [start, end]

        simplified = dp(work)
        if len(simplified) < 3:
            simplified = work[:3]
        if closed:
            simplified = simplified + [simplified[0]]
        return simplified

    def quantize_point(point: list[float]) -> list[float]:
        return [round(float(point[0]), digits), round(float(point[1]), digits), *point[2:]]

    def walk(value: Any, depth: int = 0) -> Any:
        if isinstance(value, list):
            if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
                return quantize_point(value)
            if value and isinstance(value[0], list) and value[0] and isinstance(value[0][0], (int, float)):
                return [quantize_point(point) for point in simplify_ring(value)]
            return [walk(item, depth + 1) for item in value]
        return value

    return {**geometry, "coordinates": walk(geometry.get("coordinates"))}


def read_name_table(path: Path) -> set[tuple[str, str]]:
    if not path.exists():
        return set()
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = set()
        for row in reader:
            gov = (row.get("gov_name") or row.get("governorate") or "").strip()
            deleg = (row.get("deleg_name") or row.get("delegation") or "").strip()
            if gov and deleg:
                rows.add((gov.casefold(), deleg.casefold()))
        return rows


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_registry(governorates: dict[str, Any], delegations: dict[str, Any]) -> dict[str, Any]:
    govs = []
    delegs = []
    for feature in governorates["features"]:
        props = feature["properties"]
        govs.append(
            {
                "gov_id": props["gov_id"],
                "gov_name": props["gov_name"],
                "gov_name_ar": props.get("gov_name_ar"),
                "region_id": props.get("region_id"),
                "region_name": props.get("region_name"),
                "area_sqkm": props.get("area_sqkm"),
                "center_lon": props.get("center_lon"),
                "center_lat": props.get("center_lat"),
            }
        )
    for feature in delegations["features"]:
        props = feature["properties"]
        delegs.append(
            {
                "deleg_id": props["deleg_id"],
                "deleg_name": props["deleg_name"],
                "deleg_name_ar": props.get("deleg_name_ar"),
                "gov_id": props["gov_id"],
                "gov_name": props["gov_name"],
                "region_id": props.get("region_id"),
                "region_name": props.get("region_name"),
                "area_sqkm": props.get("area_sqkm"),
                "center_lon": props.get("center_lon"),
                "center_lat": props.get("center_lat"),
            }
        )
    return {
        "source": "HDX / COD-AB Tunisia administrative boundaries",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target_counts": {
            "governorates": TARGET_GOVERNORATES,
            "delegations_ins_rgph_2024": TARGET_DELEGATIONS_INS_RGPH_2024,
        },
        "governorates": govs,
        "delegations": delegs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", default="data/admin_boundaries/raw/tun_admin_boundaries.geojson.zip")
    parser.add_argument("--public-dir", default="public/geo")
    parser.add_argument("--runtime-dir", default="runtime_data")
    parser.add_argument("--ins-csv", default="data/admin_boundaries/raw/ins_rgph_2024_delegations.csv")
    parser.add_argument("--ministry-csv", default="data/admin_boundaries/raw/ministry_interior_delegations.csv")
    args = parser.parse_args()

    zip_path = Path(args.zip)
    # Edge-matched COD-AB polygons are still official COD geometry and are much
    # smaller for browser delivery than the full-resolution operational files.
    governorates = compact_geometry(read_geojson_from_zip(zip_path, "tun_admin2_em.geojson"), "governorate")
    delegations = compact_geometry(read_geojson_from_zip(zip_path, "tun_admin3_em.geojson"), "delegation")
    registry = build_registry(governorates, delegations)

    public_dir = Path(args.public_dir)
    runtime_dir = Path(args.runtime_dir)
    write_json(public_dir / "tunisia_governorates.geojson", governorates)
    write_json(public_dir / "tunisia_delegations.geojson", delegations)
    write_json(public_dir / "admin_registry.json", registry)
    write_json(runtime_dir / "admin_registry.json", registry)

    cod_pairs = {
        (d["gov_name"].casefold(), d["deleg_name"].casefold())
        for d in registry["delegations"]
        if d.get("gov_name") and d.get("deleg_name")
    }
    ins_pairs = read_name_table(Path(args.ins_csv))
    ministry_pairs = read_name_table(Path(args.ministry_csv))

    report = {
        "generated_at": registry["generated_at"],
        "sources": {
            "geometry": "HDX / COD-AB cod-ab-tun",
            "ins_rgph_2024_csv_present": Path(args.ins_csv).exists(),
            "ministry_interior_csv_present": Path(args.ministry_csv).exists(),
        },
        "counts": {
            "cod_governorates": len(registry["governorates"]),
            "target_governorates": TARGET_GOVERNORATES,
            "cod_delegations": len(registry["delegations"]),
            "target_delegations_ins_rgph_2024": TARGET_DELEGATIONS_INS_RGPH_2024,
        },
        "warnings": [],
        "name_reconciliation": {
            "ins_missing_from_cod": sorted([f"{g}/{d}" for g, d in (ins_pairs - cod_pairs)]),
            "cod_missing_from_ins": sorted([f"{g}/{d}" for g, d in (cod_pairs - ins_pairs)]) if ins_pairs else [],
            "ministry_missing_from_cod": sorted([f"{g}/{d}" for g, d in (ministry_pairs - cod_pairs)]),
            "cod_missing_from_ministry": sorted([f"{g}/{d}" for g, d in (cod_pairs - ministry_pairs)]) if ministry_pairs else [],
        },
    }
    if len(registry["governorates"]) != TARGET_GOVERNORATES:
        report["warnings"].append("COD-AB governorate count differs from target 24.")
    if len(registry["delegations"]) != TARGET_DELEGATIONS_INS_RGPH_2024:
        report["warnings"].append(
            "COD-AB delegation polygon count differs from INS/RGPH 2024 target 279; no polygons were invented."
        )
    if not Path(args.ins_csv).exists():
        report["warnings"].append("INS/RGPH 2024 delegation registry CSV not provided; name reconciliation is incomplete.")
    if not Path(args.ministry_csv).exists():
        report["warnings"].append("Ministry of Interior validation CSV not provided; name reconciliation is incomplete.")
    write_json(runtime_dir / "admin_reconciliation_report.json", report)
    write_json(public_dir / "admin_reconciliation_report.json", report)

    print(
        "Prepared admin geography: "
        f"{len(registry['governorates'])} governorates, {len(registry['delegations'])} delegations"
    )
    if report["warnings"]:
        print("Warnings:")
        for warning in report["warnings"]:
            print(f"- {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
