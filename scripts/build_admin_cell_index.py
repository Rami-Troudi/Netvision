#!/usr/bin/env python3
"""Spatially join runtime radio cells to Tunisia delegation polygons."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def iter_rings(geometry: dict[str, Any]):
    if not geometry:
        return
    if geometry.get("type") == "Polygon":
        for ring in geometry.get("coordinates", []):
            yield ring
    elif geometry.get("type") == "MultiPolygon":
        for polygon in geometry.get("coordinates", []):
            for ring in polygon:
                yield ring


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    if len(ring) < 3:
        return False
    j = len(ring) - 1
    for i, point in enumerate(ring):
        xi, yi = point[:2]
        xj, yj = ring[j][:2]
        intersects = (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        if intersects:
            inside = not inside
        j = i
    return inside


def point_in_polygon(lon: float, lat: float, geometry: dict[str, Any]) -> bool:
    if not geometry:
        return False
    if geometry.get("type") == "Polygon":
        polygons = [geometry.get("coordinates", [])]
    elif geometry.get("type") == "MultiPolygon":
        polygons = geometry.get("coordinates", [])
    else:
        return False
    for polygon in polygons:
        if not polygon:
            continue
        outer = point_in_ring(lon, lat, polygon[0])
        holes = any(point_in_ring(lon, lat, hole) for hole in polygon[1:])
        if outer and not holes:
            return True
    return False


def bounds_for_geometry(geometry: dict[str, Any]) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for ring in iter_rings(geometry) or []:
        for lon, lat, *_ in ring:
            xs.append(float(lon))
            ys.append(float(lat))
    return min(xs), min(ys), max(xs), max(ys)


def centroid(feature: dict[str, Any]) -> tuple[float, float]:
    props = feature.get("properties") or {}
    lon = props.get("center_lon")
    lat = props.get("center_lat")
    if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
        return float(lon), float(lat)
    minx, miny, maxx, maxy = bounds_for_geometry(feature.get("geometry") or {})
    return (minx + maxx) / 2, (miny + maxy) / 2


def distance_km(a_lon: float, a_lat: float, b_lon: float, b_lat: float) -> float:
    radius = 6371.0
    p1 = math.radians(a_lat)
    p2 = math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(h), math.sqrt(1 - h))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="runtime_data/baseline.json")
    parser.add_argument("--delegations", default="public/geo/tunisia_delegations.geojson")
    parser.add_argument("--runtime-dir", default="runtime_data")
    parser.add_argument("--public-dir", default="public/geo")
    args = parser.parse_args()

    baseline = read_json(Path(args.baseline))
    delegations = read_json(Path(args.delegations)).get("features", [])
    delegation_centroids = [(feature, centroid(feature)) for feature in delegations]
    index: dict[str, Any] = {}
    unmatched: list[dict[str, Any]] = []

    for cell_name, cell in baseline.items():
        lon = cell.get("longitude")
        lat = cell.get("latitude")
        site_name = cell.get("enodeb_name") or cell_name.rsplit("_", 1)[0]
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            unmatched.append({"cell_name": cell_name, "reason": "missing longitude/latitude"})
            continue

        match = None
        for feature in delegations:
            if point_in_polygon(float(lon), float(lat), feature.get("geometry") or {}):
                match = (feature, "point_in_polygon", "high", None)
                break

        if match is None and delegation_centroids:
            nearest_feature, nearest_centroid = min(
                delegation_centroids,
                key=lambda item: distance_km(float(lon), float(lat), item[1][0], item[1][1]),
            )
            dist = distance_km(float(lon), float(lat), nearest_centroid[0], nearest_centroid[1])
            match = (nearest_feature, "nearest_delegation_centroid", "medium" if dist <= 25 else "low", dist)

        if match is None:
            unmatched.append({"cell_name": cell_name, "reason": "no delegation match"})
            continue

        feature, method, confidence, dist = match
        props = feature.get("properties") or {}
        entry = {
            "cell_name": cell_name,
            "site_name": site_name,
            "gov_id": props.get("gov_id"),
            "gov_name": props.get("gov_name"),
            "deleg_id": props.get("deleg_id"),
            "deleg_name": props.get("deleg_name"),
            "match_method": method,
            "match_confidence": confidence,
        }
        if dist is not None:
            entry["nearest_distance_km"] = round(dist, 3)
        index[cell_name] = entry

    runtime_dir = Path(args.runtime_dir)
    write_json(runtime_dir / "admin_cell_index.json", index)
    write_json(Path(args.public_dir) / "admin_cell_index.json", index)

    report_path = runtime_dir / "admin_reconciliation_report.json"
    report = read_json(report_path) if report_path.exists() else {}
    report["cell_spatial_join"] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_cells": len(baseline),
        "matched_cells": len(index),
        "unmatched_cells": len(unmatched),
        "unmatched": unmatched,
        "match_methods": {
            "point_in_polygon": sum(1 for item in index.values() if item["match_method"] == "point_in_polygon"),
            "nearest_delegation_centroid": sum(
                1 for item in index.values() if item["match_method"] == "nearest_delegation_centroid"
            ),
        },
    }
    write_json(report_path, report)
    write_json(Path(args.public_dir) / "admin_reconciliation_report.json", report)
    print(f"Built admin cell index: {len(index)}/{len(baseline)} cells matched")
    if unmatched:
        print(f"Unmatched cells: {len(unmatched)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
