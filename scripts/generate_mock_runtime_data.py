#!/usr/bin/env python3
import json, random
from pathlib import Path
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'runtime_data_mock'
REG = ROOT / 'runtime_data' / 'admin_registry.json'

random.seed(42)

def load_json(p):
    return json.loads(p.read_text(encoding='utf-8'))

def main():
    registry = load_json(REG)
    delegs = registry.get('delegations', [])
    govs = {g['gov_id']: g for g in registry.get('governorates', [])}
    baseline = {}
    admin_cell_index = {}
    for i, d in enumerate(delegs, start=1):
      gov = govs.get(d['gov_id'], {})
      for c in range(1,4):
        cell = f"{d['deleg_id'].replace('-','_')}_c{c:02d}"
        site = f"{d['deleg_id'].replace('-','_')}_s{(c+1)//2:02d}"
        lon = float(d.get('center_lon') or d.get('centroid_lon') or 10.0) + random.uniform(-0.03, 0.03)
        lat = float(d.get('center_lat') or d.get('centroid_lat') or 34.0) + random.uniform(-0.03, 0.03)
        baseline[cell] = {
          'cell_name': cell, 'site_name': site, 'frequency_band': random.choice(['L1800','L2100','L2600']),
          'azimuth': random.choice([0,60,120,180,240,300]), 'longitude': round(lon, 6), 'latitude': round(lat,6),
          'admin': {'gov_id': d['gov_id'], 'gov_name': gov.get('gov_name', d.get('gov_name','')), 'deleg_id': d['deleg_id'], 'deleg_name': d['deleg_name']}
        }
        admin_cell_index[cell] = {
          'cell_name': cell,
          'site_name': site,
          'gov_id': d['gov_id'],
          'gov_name': gov.get('gov_name', d.get('gov_name','')),
          'deleg_id': d['deleg_id'],
          'deleg_name': d['deleg_name'],
          'match_method': 'mock_registry_centroid',
          'match_confidence': 'demo'
        }

    start = datetime(2025,12,1,0,0)
    timestamps = []
    time_data_dir = OUT / 'time_data'
    time_data_dir.mkdir(parents=True, exist_ok=True)
    for h in range(24):
      dt = start + timedelta(hours=h)
      fname = dt.strftime('%d-%m-%Y_%H-%M') + '.json'
      obs = {}
      congested = 0
      for cell in baseline:
        prb = random.uniform(35, 96)
        cqi = random.uniform(6.5, 13.5)
        users = random.randint(20, 220)
        thr = max(2.0, random.uniform(6, 60) - max(0, prb-75)*0.35)
        is_cong = prb > 83 and thr < 20
        congested += 1 if is_cong else 0
        obs[cell] = {'prb_load': round(prb,2), 'throughput': round(thr,2), 'cqi': round(cqi,2), 'active_users': users, 'congested': is_cong, 'lost_traffic': round(max(0, (prb-70)/20)*random.uniform(0.1,2.5),3), 'recoverable_traffic': round(max(0, (prb-75)/20)*random.uniform(0.1,1.8),3), 'ta': round(random.uniform(0.8, 6.5),2)}
      payload = {'timestamp': dt.strftime('%d-%m-%Y %H:%M'), 'stats': {'observed_cells': len(baseline), 'congested_cells': congested}, 'observations': obs}
      (time_data_dir / fname).write_text(json.dumps(payload), encoding='utf-8')
      timestamps.append({'timestamp': payload['timestamp'], 'filename': fname, 'stats': payload['stats']})

    stats = {'cell_count': len(baseline), 'governorate_count': len(registry.get('governorates',[])), 'delegation_count': len(delegs), 'mode': 'mock'}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'baseline.json').write_text(json.dumps(baseline), encoding='utf-8')
    (OUT / 'time_index.json').write_text(json.dumps({'total_timestamps': len(timestamps), 'start_time': timestamps[0]['timestamp'], 'end_time': timestamps[-1]['timestamp'], 'storage_format': 'json', 'timestamps': timestamps}, ensure_ascii=False), encoding='utf-8')
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
      'warnings': ['Mock demo mode uses delegation registry centroids and does not represent official radio measurements.']
    }
    (OUT / 'admin_reconciliation_report.json').write_text(json.dumps(reconciliation, ensure_ascii=False), encoding='utf-8')
    print(f'Generated mock runtime data: {OUT} with {len(delegs)} delegations and {len(baseline)} cells')

if __name__ == '__main__':
    main()
