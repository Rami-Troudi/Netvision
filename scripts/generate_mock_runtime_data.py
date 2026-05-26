#!/usr/bin/env python3
import json
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.core_rules import is_congested as is_congested_rule
OUT = ROOT / "runtime_data_mock"
REAL = ROOT / "runtime_data"
CALIBRATION_DIR = ROOT / ".runtime" / "mock-calibration"
CALIBRATION_FILE = CALIBRATION_DIR / "real_profiles.json"
DELEGATIONS_GEOJSON = ROOT / "public" / "geo" / "tunisia_delegations.geojson"

SEED = 42
random.seed(SEED)

ZONE_TYPES = ("urban", "suburban", "rural")


def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def load_git_json(ref_path: str):
    try:
        raw = subprocess.check_output(["git", "show", f"HEAD:{ref_path}"], cwd=str(ROOT), text=True)
        return json.loads(raw)
    except Exception:
        return None


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    idx = int(round((len(ordered) - 1) * pct))
    idx = max(0, min(len(ordered) - 1, idx))
    return ordered[idx]


def parse_hour(ts: str):
    ts = str(ts or "")
    if len(ts) >= 13 and ts[11:13].isdigit():
        return int(ts[11:13])
    if len(ts) >= 2 and ts[0:2].isdigit():
        return int(ts[0:2]) % 24
    return 0


def _iter_coords(geom):
    gtype = (geom or {}).get("type")
    coords = (geom or {}).get("coordinates") or []
    if gtype == "Polygon":
        for ring in coords:
            for lon, lat, *_ in ring:
                yield float(lon), float(lat)
    elif gtype == "MultiPolygon":
        for poly in coords:
            for ring in poly:
                for lon, lat, *_ in ring:
                    yield float(lon), float(lat)


def build_delegation_centers_from_geojson():
    if not DELEGATIONS_GEOJSON.exists():
        return {}
    payload = load_json(DELEGATIONS_GEOJSON)
    centers = {}
    for feat in payload.get("features", []):
        props = feat.get("properties") or {}
        deleg_id = props.get("deleg_id")
        if not deleg_id:
            continue
        pts = list(_iter_coords(feat.get("geometry")))
        if not pts:
            continue
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        centers[deleg_id] = (lon, lat)
    return centers


def assign_zone_types(deleg_ids, delegation_load):
    values = [float(delegation_load.get(k, 0.0)) for k in deleg_ids]
    p33 = percentile(values, 0.33)
    p66 = percentile(values, 0.66)
    mapping = {}
    for deleg_id in deleg_ids:
        load = float(delegation_load.get(deleg_id, 0.0))
        if load >= p66:
            mapping[deleg_id] = "urban"
        elif load >= p33:
            mapping[deleg_id] = "suburban"
        else:
            mapping[deleg_id] = "rural"
    return mapping


def extract_real_profiles():
    index = load_json(REAL / "time_index.json").get("timestamps", [])
    admin_idx = load_json(REAL / "admin_cell_index.json")

    by_hour = defaultdict(lambda: defaultdict(list))
    by_zone_hour = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    by_deleg_load = defaultdict(list)
    by_day_peak = defaultdict(list)

    # first pass for delegation load
    for entry in index:
        filename = entry.get("filename")
        if not filename:
            continue
        payload = load_json(REAL / "time_data" / filename)
        hour = parse_hour(payload.get("timestamp"))
        obs = payload.get("observations", {})
        for cell, row in obs.items():
            deleg = (admin_idx.get(cell) or {}).get("deleg_id") or "unknown"
            prb = float(row.get("prb_load") or row.get("load") or 0.0)
            by_deleg_load[deleg].append(prb)
            by_hour[hour]["prb_load"].append(prb)
            by_hour[hour]["throughput"].append(float(row.get("throughput") or 0.0))
            by_hour[hour]["cqi"].append(float(row.get("cqi") or 0.0))
            by_hour[hour]["active_users"].append(float(row.get("active_users") or row.get("rrc_users") or 0.0))
            by_hour[hour]["congested_rate"].append(1.0 if row.get("congested") else 0.0)

    deleg_mean_load = {k: (sum(v) / max(1, len(v))) for k, v in by_deleg_load.items()}
    zone_by_deleg = assign_zone_types(list(deleg_mean_load.keys()), deleg_mean_load)

    for entry in index:
        filename = entry.get("filename")
        ts = entry.get("timestamp") or ""
        if not filename:
            continue
        payload = load_json(REAL / "time_data" / filename)
        hour = parse_hour(payload.get("timestamp") or ts)
        date_key = str(ts).split(" ")[0]
        obs = payload.get("observations", {})
        per_zone_prb = defaultdict(list)
        for cell, row in obs.items():
            deleg = (admin_idx.get(cell) or {}).get("deleg_id") or "unknown"
            zone = zone_by_deleg.get(deleg, "suburban")
            prb = float(row.get("prb_load") or row.get("load") or 0.0)
            thr = float(row.get("throughput") or 0.0)
            cqi = float(row.get("cqi") or 0.0)
            users = float(row.get("active_users") or row.get("rrc_users") or 0.0)
            cong = 1.0 if row.get("congested") else 0.0
            per_zone_prb[zone].append(prb)
            for k, v in (
                ("prb_load", prb),
                ("throughput", thr),
                ("cqi", cqi),
                ("active_users", users),
                ("congested_rate", cong),
            ):
                by_zone_hour[zone][hour][k].append(v)
        for zone in ZONE_TYPES:
            if per_zone_prb[zone]:
                by_day_peak[(zone, date_key)].append((hour, sum(per_zone_prb[zone]) / len(per_zone_prb[zone])))

    def avg(series):
        return sum(series) / max(1, len(series))

    hourly = {}
    for hour in range(24):
        bucket = by_hour.get(hour, {})
        hourly[hour] = {k: avg(v) for k, v in bucket.items()}

    zone_hourly = {}
    for zone in ZONE_TYPES:
        zone_hourly[zone] = {}
        for hour in range(24):
            bucket = by_zone_hour.get(zone, {}).get(hour, {})
            zone_hourly[zone][hour] = {k: avg(v) for k, v in bucket.items()}

    dominant_busy_hours = {}
    for zone in ZONE_TYPES:
        peaks = []
        for (z, _day), vals in by_day_peak.items():
            if z != zone or not vals:
                continue
            peaks.append(max(vals, key=lambda x: x[1])[0])
        hist = defaultdict(int)
        for h in peaks:
            hist[h] += 1
        dominant_busy_hours[zone] = sorted(hist.keys(), key=lambda h: hist[h], reverse=True)[:4]

    profile = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_runtime": "runtime_data",
        "seed": SEED,
        "zone_by_delegation": zone_by_deleg,
        "hourly_global": hourly,
        "hourly_by_zone": zone_hourly,
        "dominant_busy_hours_by_zone": dominant_busy_hours,
        "delegation_mean_prb": deleg_mean_load,
    }
    CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)
    CALIBRATION_FILE.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    return profile


def generate_mock_data(profile):
    registry = load_json(REAL / "admin_registry.json")
    delegs = registry.get("delegations", [])
    govs = {g["gov_id"]: g for g in registry.get("governorates", [])}
    zone_by_deleg = profile.get("zone_by_delegation", {})
    global_hour = profile.get("hourly_global", {})
    zone_hour = profile.get("hourly_by_zone", {})

    baseline = load_git_json("runtime_data_mock/baseline.json") or {}
    admin_cell_index = load_git_json("runtime_data_mock/admin_cell_index.json") or {}
    if not baseline:
        centers = build_delegation_centers_from_geojson()
        min_cells_per_delegation = 10
        sites_per_delegation = 5
        for d in delegs:
            gov = govs.get(d["gov_id"], {})
            center_lon, center_lat = centers.get(
                d["deleg_id"], (float(d.get("center_lon") or 10.0), float(d.get("center_lat") or 34.0))
            )
            zone = zone_by_deleg.get(d["deleg_id"], "suburban")
            for c in range(1, min_cells_per_delegation + 1):
                cell = f"{d['deleg_id'].replace('-', '_')}_c{c:02d}"
                site = f"{d['deleg_id'].replace('-', '_')}_s{((c - 1) % sites_per_delegation) + 1:02d}"
                lon = center_lon + random.uniform(-0.015, 0.015)
                lat = center_lat + random.uniform(-0.015, 0.015)
                baseline[cell] = {
                    "cell_name": cell,
                    "site_name": site,
                    "frequency_band": random.choice(["L1800", "L2100", "L2600"]),
                    "azimuth": random.choice([0, 60, 120, 180, 240, 300]),
                    "longitude": round(lon, 6),
                    "latitude": round(lat, 6),
                    "zone_type": zone,
                    "admin": {
                        "gov_id": d["gov_id"],
                        "gov_name": gov.get("gov_name", d.get("gov_name", "")),
                        "deleg_id": d["deleg_id"],
                        "deleg_name": d["deleg_name"],
                    },
                }
                admin_cell_index[cell] = {
                    "cell_name": cell,
                    "site_name": site,
                    "gov_id": d["gov_id"],
                    "gov_name": gov.get("gov_name", d.get("gov_name", "")),
                    "deleg_id": d["deleg_id"],
                    "deleg_name": d["deleg_name"],
                    "match_method": "mock_calibrated_from_runtime_data",
                    "match_confidence": "high",
                }
    for cell, meta in baseline.items():
        deleg_id = ((admin_cell_index.get(cell) or {}).get("deleg_id") or (meta.get("admin") or {}).get("deleg_id") or "unknown")
        zone = zone_by_deleg.get(deleg_id, "suburban")
        meta["zone_type"] = zone

    start = datetime(2025, 12, 1, 0, 0)
    total_hours = 30 * 24
    time_data_dir = OUT / "time_data"
    time_data_dir.mkdir(parents=True, exist_ok=True)

    cell_effect = {cell: random.uniform(-1.0, 1.0) for cell in baseline.keys()}
    timestamps = []
    for h in range(total_hours):
        dt = start + timedelta(hours=h)
        hour = dt.hour
        weekday = dt.weekday()
        is_weekend = weekday >= 5
        fname = dt.strftime("%d-%m-%Y_%H-%M") + ".json"
        obs = {}
        congested = 0
        for cell, base in baseline.items():
            zone = base.get("zone_type", "suburban")
            zhour = zone_hour.get(zone, {}).get(hour, {})
            ghour = global_hour.get(hour, {})
            prb_base = float(zhour.get("prb_load", ghour.get("prb_load", 60.0)))
            thr_base_raw = float(zhour.get("throughput", ghour.get("throughput", 22000.0)))
            thr_base = thr_base_raw / 1000.0 if thr_base_raw > 500 else thr_base_raw
            cqi_base = float(zhour.get("cqi", ghour.get("cqi", 10.0)))
            usr_base = float(zhour.get("active_users", ghour.get("active_users", 120.0)))
            cong_rate = float(zhour.get("congested_rate", ghour.get("congested_rate", 0.08)))

            weekend_factor = 0.95 if is_weekend else 1.0
            cfx = cell_effect[cell]
            users = int(round(clamp(random.gauss(usr_base * weekend_factor + cfx * 2.0, max(8.0, usr_base * 0.18)), 6, 600)))
            prb = clamp(random.gauss(prb_base + cfx * 1.4, 7.5), 15.0, 99.0)
            cqi = clamp(random.gauss(cqi_base - max(0.0, (prb - 75.0) * 0.03), 1.2), 4.0, 15.0)
            thr_sigma = max(2.0, abs(thr_base) * 0.18)
            throughput = clamp(
                random.gauss(thr_base - max(0.0, (prb - 78.0) * 0.12) + max(0.0, (cqi - 9.0) * 0.22), thr_sigma),
                0.2,
                120.0,
            )

            stress = 0.0
            stress += max(0.0, (prb - 75.0) / 20.0) * 0.5
            stress += max(0.0, (18.0 - throughput) / 18.0) * 0.35
            stress += max(0.0, (8.0 - cqi) / 4.0) * 0.2
            stress += max(0.0, (users - 160.0) / 140.0) * 0.15
            expected_cong = clamp(cong_rate * (1.0 + stress * 0.6), 0.005, 0.7)
            preflag = random.random() < expected_cong
            throughput_kbps = round(throughput * 1000.0, 2)
            is_cong = preflag and is_congested_rule(prb_load=prb, throughput=throughput_kbps, active_users=users)
            severity = "critical" if is_cong else ("watch" if prb >= 76 or throughput < 16 or cqi < 8.5 else "healthy")
            issue_type = "Congestion Confirmed" if is_cong else ("Capacity Pressure" if prb >= 76 else ("Radio Quality" if cqi < 8.5 else "Normal"))
            health_score = int(round(clamp(100 - (prb - 45) * 0.9 - max(0.0, (8.8 - cqi) * 4.8), 20, 98)))
            congested += 1 if is_cong else 0
            traffic = round(max(0.2, throughput * users / 125.0), 3)
            rrc_users = int(round(clamp(users * random.uniform(0.42, 0.87), 2, users)))
            lost_traffic = round(max(0.0, (prb - 75.0) / 18.0) * random.uniform(0.1, 2.4), 3)
            recoverable_traffic = round(max(0.0, (prb - 80.0) / 15.0) * random.uniform(0.05, 1.9), 3)
            ta = round(clamp(random.gauss(3.8, 1.25), 0.6, 7.0), 2)
            obs[cell] = {
                "prb_load": round(prb, 2),
                "load": round(prb, 2),
                "throughput": round(throughput, 2),
                "throughput_kbps": throughput_kbps,
                "cqi": round(cqi, 2),
                "active_users": users,
                "rrc_users": rrc_users,
                "traffic": traffic,
                "congested": is_cong,
                "severity": severity,
                "issue_type": issue_type,
                "root_cause": issue_type,
                "health_score": health_score,
                "health": health_score,
                "lost_traffic": lost_traffic,
                "recoverable_traffic": recoverable_traffic,
                "ta": ta,
            }

        payload = {"timestamp": dt.strftime("%d-%m-%Y %H:%M"), "stats": {"observed_cells": len(baseline), "congested_cells": congested}, "observations": obs}
        (time_data_dir / fname).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        timestamps.append({"timestamp": payload["timestamp"], "filename": fname, "stats": payload["stats"]})

    OUT.mkdir(parents=True, exist_ok=True)
    stats = {
        "cell_count": len(baseline),
        "governorate_count": len(registry.get("governorates", [])),
        "delegation_count": len(delegs),
        "mode": "mock",
        "calibration": "mock calibré réel (multi-profils régionaux)",
        "source_profile": str(CALIBRATION_FILE.relative_to(ROOT)),
    }
    (OUT / "baseline.json").write_text(json.dumps(baseline, ensure_ascii=False), encoding="utf-8")
    (OUT / "time_index.json").write_text(
        json.dumps(
            {
                "total_timestamps": len(timestamps),
                "start_time": timestamps[0]["timestamp"],
                "end_time": timestamps[-1]["timestamp"],
                "storage_format": "json",
                "timestamps": timestamps,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (OUT / "stats.json").write_text(json.dumps(stats, ensure_ascii=False), encoding="utf-8")
    (OUT / "admin_cell_index.json").write_text(json.dumps(admin_cell_index, ensure_ascii=False), encoding="utf-8")

    reg = ROOT / "runtime_data" / "admin_registry.json"
    if reg.exists():
        (OUT / "admin_registry.json").write_text(reg.read_text(encoding="utf-8"), encoding="utf-8")

    reconciliation = {
        "mode": "mock",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": {"cod_delegations": len(delegs), "target_delegations_ins_rgph_2024": 279},
        "cell_spatial_join": {"total_cells": len(baseline), "matched_cells": len(baseline), "unmatched_cells": 0},
        "warnings": ["Mock data is calibrated from runtime_data observed temporal and KPI distributions."],
    }
    (OUT / "admin_reconciliation_report.json").write_text(json.dumps(reconciliation, ensure_ascii=False), encoding="utf-8")
    print(f"Generated calibrated mock data: {OUT} with {len(baseline)} cells and {total_hours} hourly slices")


def main():
    profile = extract_real_profiles()
    generate_mock_data(profile)
    print(f"Wrote calibration profiles: {CALIBRATION_FILE}")


if __name__ == "__main__":
    main()
