#!/usr/bin/env python3
import json
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from backend.core_rules import is_congested as is_congested_rule

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'runtime_data_mock'
REAL = ROOT / 'runtime_data'
REG = ROOT / 'runtime_data' / 'admin_registry.json'
DELEGATIONS_GEOJSON = ROOT / 'public' / 'geo' / 'tunisia_delegations.geojson'

random.seed(42)


def load_json(p):
    return json.loads(p.read_text(encoding='utf-8'))


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _iter_coords(geom):
    gtype = (geom or {}).get('type')
    coords = (geom or {}).get('coordinates') or []
    if gtype == 'Polygon':
        for ring in coords:
            for lon, lat, *_ in ring:
                yield float(lon), float(lat)
    elif gtype == 'MultiPolygon':
        for poly in coords:
            for ring in poly:
                for lon, lat, *_ in ring:
                    yield float(lon), float(lat)


def build_delegation_centers_from_geojson():
    if not DELEGATIONS_GEOJSON.exists():
        return {}
    payload = load_json(DELEGATIONS_GEOJSON)
    centers = {}
    for feat in payload.get('features', []):
        props = feat.get('properties') or {}
        deleg_id = props.get('deleg_id')
        if not deleg_id:
            continue
        pts = list(_iter_coords(feat.get('geometry')))
        if not pts:
            continue
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        centers[deleg_id] = (lon, lat)
    return centers


def build_real_profiles():
    """Build calibration profiles from runtime_data (delegation + hour)."""
    time_index = load_json(REAL / 'time_index.json').get('timestamps', [])
    admin_idx = load_json(REAL / 'admin_cell_index.json')
    by_deleg = defaultdict(lambda: {'n': 0, 'prb': 0.0, 'thr': 0.0, 'cqi': 0.0, 'users': 0.0, 'cong': 0.0})
    by_hour = defaultdict(lambda: {'n': 0, 'prb': 0.0, 'thr': 0.0, 'cqi': 0.0, 'users': 0.0, 'cong': 0.0})
    global_acc = {'n': 0, 'prb': 0.0, 'thr': 0.0, 'cqi': 0.0, 'users': 0.0, 'cong': 0.0}

    for entry in time_index:
        filename = entry.get('filename')
        if not filename:
            continue
        payload = load_json(REAL / 'time_data' / filename)
        ts = str(payload.get('timestamp') or '')
        hour = int(ts[11:13]) if len(ts) >= 13 and ts[11:13].isdigit() else 0
        obs = payload.get('observations', {})
        for cell_name, o in obs.items():
            deleg_id = (admin_idx.get(cell_name) or {}).get('deleg_id') or 'unknown'
            prb = float(o.get('prb_load') or 0.0)
            thr = float(o.get('throughput') or 0.0)
            cqi = float(o.get('cqi') or 0.0)
            users = float(o.get('active_users') or 0.0)
            cong = 1.0 if o.get('congested') else 0.0

            for bucket in (by_deleg[deleg_id], by_hour[hour], global_acc):
                bucket['n'] += 1
                bucket['prb'] += prb
                bucket['thr'] += thr
                bucket['cqi'] += cqi
                bucket['users'] += users
                bucket['cong'] += cong

    def avg(d):
        n = max(1, d['n'])
        return {
            'prb': d['prb'] / n,
            'thr': d['thr'] / n,
            'cqi': d['cqi'] / n,
            'users': d['users'] / n,
            'cong': d['cong'] / n,
        }

    global_avg = avg(global_acc)
    deleg_profile = {k: avg(v) for k, v in by_deleg.items()}
    hour_profile = {int(k): avg(v) for k, v in by_hour.items()}
    return global_avg, deleg_profile, hour_profile


def main():
    total_days = 30
    total_hours = total_days * 24
    registry = load_json(REG)
    global_avg, deleg_profile, hour_profile = build_real_profiles()

    delegs = registry.get('delegations', [])
    govs = {g['gov_id']: g for g in registry.get('governorates', [])}
    baseline = {}
    admin_cell_index = {}

    deleg_geo_centers = build_delegation_centers_from_geojson()
    min_cells_per_delegation = 10
    sites_per_delegation = 5

    # Build baseline geometry/meta with at least ten cells per delegation.
    for d in delegs:
        gov = govs.get(d['gov_id'], {})
        center_lon, center_lat = deleg_geo_centers.get(
            d['deleg_id'],
            (float(d.get('center_lon') or 10.0), float(d.get('center_lat') or 34.0)),
        )
        for c in range(1, min_cells_per_delegation + 1):
            cell = f"{d['deleg_id'].replace('-', '_')}_c{c:02d}"
            site = f"{d['deleg_id'].replace('-', '_')}_s{((c - 1) % sites_per_delegation) + 1:02d}"
            lon = center_lon + random.uniform(-0.015, 0.015)
            lat = center_lat + random.uniform(-0.015, 0.015)
            baseline[cell] = {
                'cell_name': cell,
                'site_name': site,
                'frequency_band': random.choice(['L1800', 'L2100', 'L2600']),
                'azimuth': random.choice([0, 60, 120, 180, 240, 300]),
                'longitude': round(lon, 6),
                'latitude': round(lat, 6),
                'admin': {
                    'gov_id': d['gov_id'],
                    'gov_name': gov.get('gov_name', d.get('gov_name', '')),
                    'deleg_id': d['deleg_id'],
                    'deleg_name': d['deleg_name'],
                },
            }
            admin_cell_index[cell] = {
                'cell_name': cell,
                'site_name': site,
                'gov_id': d['gov_id'],
                'gov_name': gov.get('gov_name', d.get('gov_name', '')),
                'deleg_id': d['deleg_id'],
                'deleg_name': d['deleg_name'],
                'match_method': 'mock_calibrated_from_runtime',
                'match_confidence': 'high',
            }

    start = datetime(2025, 12, 1, 0, 0)
    timestamps = []
    time_data_dir = OUT / 'time_data'
    time_data_dir.mkdir(parents=True, exist_ok=True)

    # Cell-level static effect to maintain consistent quality differences.
    cell_effect = {cell: random.uniform(-1.0, 1.0) for cell in baseline.keys()}

    for h in range(total_hours):
        dt = start + timedelta(hours=h)
        hour = dt.hour
        weekday = dt.weekday()  # 0=Mon
        is_weekend = weekday >= 5
        fname = dt.strftime('%d-%m-%Y_%H-%M') + '.json'
        obs = {}
        congested = 0

        hp = hour_profile.get(hour, global_avg)
        # Realistic diurnal + weekday modulation.
        hour_user_factor = clamp(hp['users'] / max(1.0, global_avg['users']), 0.85, 1.18)
        hour_prb_factor = clamp(hp['prb'] / max(1.0, global_avg['prb']), 0.9, 1.12)
        weekend_user_factor = 0.93 if is_weekend else 1.0
        weekend_prb_factor = 0.96 if is_weekend else 1.0

        for cell, base in baseline.items():
            deleg_id = base['admin']['deleg_id']
            dp = deleg_profile.get(deleg_id, global_avg)
            cfx = cell_effect[cell]

            users_mean = dp['users'] * hour_user_factor * weekend_user_factor
            prb_mean = dp['prb'] * hour_prb_factor * weekend_prb_factor + cfx * 1.2
            cqi_mean = dp['cqi'] - max(0.0, (prb_mean - 72.0) * 0.03) - cfx * 0.2
            thr_mean = dp['thr'] - max(0.0, (prb_mean - 76.0) * 0.42) + max(0.0, (cqi_mean - 9.5) * 1.1)

            users = int(round(clamp(random.gauss(users_mean, max(6.0, users_mean * 0.16)), 8, 420)))
            prb = clamp(random.gauss(prb_mean, 6.8), 25.0, 98.0)
            cqi = clamp(random.gauss(cqi_mean, 1.05), 5.2, 14.2)
            throughput = clamp(random.gauss(thr_mean, 5.8), 2.0, 72.0)

            # Logical congestion rule with delegation/hour propensity aligned to real runtime.
            cong_target = float(dp.get('cong', global_avg['cong']))
            hour_cong_factor = clamp(hp.get('cong', global_avg['cong']) / max(0.01, global_avg['cong']), 0.8, 1.35)
            expected_cong = clamp(cong_target * hour_cong_factor * (0.95 if is_weekend else 1.0), 0.01, 0.25)
            stress = 0.0
            stress += max(0.0, (prb - 75.0) / 20.0) * 0.55
            stress += max(0.0, (18.0 - throughput) / 18.0) * 0.30
            stress += max(0.0, (8.2 - cqi) / 3.0) * 0.25
            stress += max(0.0, (users - 150.0) / 120.0) * 0.20
            base_hit = random.random() < clamp(expected_cong * 0.95, 0.0, 0.5)
            stress_hit = (prb >= 70.0) and (random.random() < clamp(stress * 0.55, 0.0, 0.6))
            throughput_kbps = round(throughput * 1000, 2)
            preflag = base_hit or stress_hit
            # Keep temporal/delegation pressure stochastic, but require
            # source-of-truth congestion thresholds before labeling a cell
            # as congested.
            is_cong = preflag and is_congested_rule(
                prb_load=prb,
                throughput=throughput_kbps,
                active_users=users,
            )
            severity = 'critical' if is_cong else ('watch' if prb >= 76 or throughput < 16 or cqi < 8.5 else 'healthy')
            issue_type = 'Congestion Confirmed' if is_cong else ('Capacity Pressure' if prb >= 76 else ('Radio Quality' if cqi < 8.5 else 'Normal'))
            health_score = int(round(clamp(100 - (prb - 45) * 0.95 - max(0.0, (8.8 - cqi) * 5.0), 20, 98)))

            congested += 1 if is_cong else 0
            traffic = round(max(0.2, throughput * users / 125.0), 3)
            rrc_users = int(round(clamp(users * random.uniform(0.42, 0.87), 2, users)))
            lost_traffic = round(max(0.0, (prb - 75.0) / 18.0) * random.uniform(0.1, 2.4), 3)
            recoverable_traffic = round(max(0.0, (prb - 80.0) / 15.0) * random.uniform(0.05, 1.9), 3)
            ta = round(clamp(random.gauss(3.8, 1.25), 0.6, 7.0), 2)

            obs[cell] = {
                'prb_load': round(prb, 2),
                'load': round(prb, 2),
                'throughput': round(throughput, 2),
                'throughput_kbps': throughput_kbps,
                'cqi': round(cqi, 2),
                'active_users': users,
                'rrc_users': rrc_users,
                'traffic': traffic,
                'congested': is_cong,
                'severity': severity,
                'issue_type': issue_type,
                'root_cause': issue_type,
                'health_score': health_score,
                'health': health_score,
                'lost_traffic': lost_traffic,
                'recoverable_traffic': recoverable_traffic,
                'ta': ta,
            }

        payload = {
            'timestamp': dt.strftime('%d-%m-%Y %H:%M'),
            'stats': {'observed_cells': len(baseline), 'congested_cells': congested},
            'observations': obs,
        }
        (time_data_dir / fname).write_text(json.dumps(payload), encoding='utf-8')
        timestamps.append({'timestamp': payload['timestamp'], 'filename': fname, 'stats': payload['stats']})

    stats = {
        'cell_count': len(baseline),
        'governorate_count': len(registry.get('governorates', [])),
        'delegation_count': len(delegs),
        'mode': 'mock',
        'calibration': 'runtime_data profiles (delegation/hour)',
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'baseline.json').write_text(json.dumps(baseline), encoding='utf-8')
    (OUT / 'time_index.json').write_text(json.dumps({
        'total_timestamps': len(timestamps),
        'start_time': timestamps[0]['timestamp'],
        'end_time': timestamps[-1]['timestamp'],
        'storage_format': 'json',
        'timestamps': timestamps,
    }, ensure_ascii=False), encoding='utf-8')
    (OUT / 'stats.json').write_text(json.dumps(stats), encoding='utf-8')
    (OUT / 'admin_cell_index.json').write_text(json.dumps(admin_cell_index, ensure_ascii=False), encoding='utf-8')
    src = ROOT / 'runtime_data' / 'admin_registry.json'
    if src.exists():
        (OUT / 'admin_registry.json').write_text(src.read_text(encoding='utf-8'), encoding='utf-8')
    reconciliation = {
        'mode': 'mock',
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'counts': {'cod_delegations': len(delegs), 'target_delegations_ins_rgph_2024': 279},
        'cell_spatial_join': {'total_cells': len(baseline), 'matched_cells': len(baseline), 'unmatched_cells': 0},
        'warnings': ['Mock data is calibrated on runtime_data KPI distributions and kept for development/testing only.'],
    }
    (OUT / 'admin_reconciliation_report.json').write_text(json.dumps(reconciliation, ensure_ascii=False), encoding='utf-8')
    print(f'Generated calibrated mock data: {OUT} with {len(delegs)} delegations, {len(baseline)} cells and {total_hours} hourly slices')


if __name__ == '__main__':
    main()
