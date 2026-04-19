"""
NetVision Digital Twin - Time-Series Data Processor
====================================================
Processes network data with time-based organization.
Separates observations by timestamp for time-slider functionality.

Author: Network Operations Team
Version: 4.0 - Time-Series Edition
"""

import pandas as pd
import numpy as np
import duckdb
import json
import os
import sys
import argparse
import re
from datetime import datetime
from typing import List, Dict, Any
import warnings
warnings.filterwarnings('ignore')

# Ensure backend package is importable from scripts/
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from backend.core_rules import (  # noqa: E402
    PRB_SATURATED, PRB_HIGH, PRB_MEDIUM, PRB_LOW,
    THROUGHPUT_DEGRADED, THROUGHPUT_TARGET, THROUGHPUT_CRITICAL,
    ACTIVE_USERS_CRITICAL, CQI_CRITICAL, CQI_LOW,
    SEVERITY_CONGESTED,
    is_congested as _is_congested,
)

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ============================================
# CONFIGURATION - Orange Network KPI Thresholds
# Based on Orange DRS standards
# ============================================
CONFIG = {
    # PRB Load Thresholds (Physical Resource Block) - Orange Standard
    'PRB_SATURATED': PRB_SATURATED,
    'PRB_HIGH': PRB_HIGH,
    'PRB_MEDIUM': PRB_MEDIUM,
    'PRB_LOW': PRB_LOW,
    
    # Throughput Thresholds (kbps) - Orange Standard
    'THROUGHPUT_DEGRADED': THROUGHPUT_DEGRADED,
    'THROUGHPUT_TARGET': THROUGHPUT_TARGET,
    'THROUGHPUT_CRITICAL': THROUGHPUT_CRITICAL,
    
    # Active Users (File d'attente) - Orange Standard
    'USERS_CRITICAL': ACTIVE_USERS_CRITICAL,
    'USERS_TARGET': 1,
    
    # CQI Thresholds (Channel Quality Indicator, 0-15)
    'CQI_CRITICAL': CQI_CRITICAL,
    'CQI_LOW': CQI_LOW,
    'CQI_MEDIUM': 9,
}


def write_parquet_slice(df: pd.DataFrame, output_path: str) -> None:
    """Write a dataframe to parquet using DuckDB (no pyarrow dependency)."""
    con = duckdb.connect()
    try:
        con.register("slice_df", df)
        escaped_path = output_path.replace("'", "''")
        con.execute(f"COPY slice_df TO '{escaped_path}' (FORMAT PARQUET)")
    finally:
        con.close()


def load_data(file_paths: List[str]) -> pd.DataFrame:
    """Load and combine CSV files."""
    dataframes = []
    
    for path in file_paths:
        if not os.path.exists(path):
            print(f"  ✗ File not found: {path}")
            continue
        
        df = pd.read_csv(path, low_memory=True, na_values=['', 'NA', 'N/A', 'null'])
        df.columns = df.columns.str.strip().str.lower()
        dataframes.append(df)
        print(f"  ✓ Loaded {len(df):,} records from {os.path.basename(path)}")
    
    if not dataframes:
        raise ValueError("No valid data files")
    
    combined = pd.concat(dataframes, ignore_index=True)
    return combined


def _float_from_text(text: str) -> float | None:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(value):
        return None
    return float(value)


def _in_range(value: float, min_value: float | None, max_value: float | None) -> bool:
    if min_value is not None and value < min_value:
        return False
    if max_value is not None and value > max_value:
        return False
    return True


def _numeric_candidates(raw: Any) -> List[float]:
    if raw is None:
        return []

    if isinstance(raw, (int, float, np.integer, np.floating)):
        value = float(raw)
        return [value] if np.isfinite(value) else []

    text = str(raw).strip()
    if not text:
        return []

    lowered = text.lower()
    if lowered in {'nan', 'none', 'null'}:
        return []

    text = text.replace('\u00a0', '').replace(' ', '').replace('\u2212', '-')
    text = re.sub(r'[^0-9,\.\-+eE]', '', text)
    if not text:
        return []

    variants: List[str] = []

    if ',' in text and '.' in text:
        # Handle locale combinations like 1.234,56 and 1,234.56
        if text.rfind(',') > text.rfind('.'):
            variants.append(text.replace('.', '').replace(',', '.'))
        else:
            variants.append(text.replace(',', ''))
    elif ',' in text:
        decimal_variant = text.replace(',', '.')
        thousands_variant = text.replace(',', '')

        comma_parts = text.split(',')
        is_grouped_thousands = (
            len(comma_parts) > 1
            and all(len(part) == 3 for part in comma_parts[1:])
            and re.fullmatch(r'[+-]?\d+', comma_parts[0] or '0') is not None
        )

        # Prefer grouped-thousands interpretation only when the pattern clearly matches.
        if is_grouped_thousands:
            variants.extend([thousands_variant, decimal_variant])
        else:
            variants.extend([decimal_variant, thousands_variant])
    else:
        variants.append(text)

    out: List[float] = []
    for variant in variants:
        value = _float_from_text(variant)
        if value is None:
            continue
        if not any(abs(existing - value) < 1e-12 for existing in out):
            out.append(value)
    return out


def parse_numeric(
    raw: Any,
    default: float | None = None,
    min_value: float | None = None,
    max_value: float | None = None,
) -> float | None:
    """Parse numeric values robustly, including decimal-comma formats."""
    candidates = _numeric_candidates(raw)
    if not candidates:
        return default

    for value in candidates:
        if _in_range(value, min_value, max_value):
            return value

    return default if default is not None else candidates[0]


def analyze_cell(row: pd.Series) -> Dict:
    """
    Analyze a single cell observation using Orange DRS standards.
    
    Congestion is detected if ANY of these conditions are met:
    1. PRB Load ≥ 90% (Saturé)
    2. PRB Load ≥ 80% AND Throughput < 4 Mbps (Capacity + Quality issue)
    3. Active Users > 4 AND PRB Load ≥ 70% (Queue building)
    4. Throughput < 4 Mbps AND PRB Load ≥ 70% (User experience degraded)
    """
    load = row.get('ft_physical_resource_blocks_load_dl')
    throughput = row.get('ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_')
    cqi = row.get('ft_4g_lte_average_reported_cqi')
    active_users = row.get('l_traffic_activeuser_dl_avg')
    
    # Normalize values
    load = parse_numeric(load, default=0, min_value=0, max_value=100) or 0
    throughput = parse_numeric(throughput, default=10000, min_value=0) or 10000
    cqi = parse_numeric(cqi, default=10, min_value=0, max_value=15) or 10
    active_users = parse_numeric(active_users, default=0, min_value=0) or 0
    
    # Calculate severity score (0-100) based on Orange criteria
    severity = 0
    issues = []
    
    # PRB Load scoring
    if load >= CONFIG['PRB_SATURATED']:
        severity += 50
        issues.append('Saturé (PRB ≥90%)')
    elif load >= CONFIG['PRB_HIGH']:
        severity += 30
        issues.append('Charge élevée (PRB ≥80%)')
    elif load >= CONFIG['PRB_MEDIUM']:
        severity += 15
        issues.append('Charge modérée')
    
    # Throughput scoring
    if throughput < CONFIG['THROUGHPUT_CRITICAL']:
        severity += 35
        issues.append('Débit critique (<2 Mbps)')
    elif throughput < CONFIG['THROUGHPUT_DEGRADED']:
        severity += 20
        issues.append('Débit dégradé (<4 Mbps)')
    
    # Active users (file d'attente) scoring
    if active_users > CONFIG['USERS_CRITICAL']:
        severity += 25
        issues.append(f'File d\'attente ({active_users:.0f} UE)')
    
    # CQI scoring
    if cqi < CONFIG['CQI_CRITICAL']:
        severity += 20
        issues.append('Qualité signal critique')
    elif cqi < CONFIG['CQI_LOW']:
        severity += 10
        issues.append('Qualité signal faible')
    
    # --- CONGESTION DETECTION (unified Orange criteria from core_rules) ---
    congested = _is_congested(
        prb_load=load,
        throughput=throughput,
        active_users=active_users,
        severity=severity,
    )
    
    # Determine issue type
    if not issues:
        issue_type = 'Normal'
        root_cause = 'Normal'
    elif load >= CONFIG['PRB_SATURATED']:
        issue_type = 'Saturation Capacité'
        root_cause = 'PRB saturés - renforcement capacitaire requis'
    elif load >= CONFIG['PRB_HIGH'] and throughput < CONFIG['THROUGHPUT_DEGRADED']:
        issue_type = 'Congestion + Dégradation'
        root_cause = 'Charge élevée avec débit dégradé'
    elif throughput < CONFIG['THROUGHPUT_DEGRADED']:
        issue_type = 'Dégradation QoE'
        root_cause = 'Débit utilisateur insuffisant'
    elif active_users > CONFIG['USERS_CRITICAL']:
        issue_type = 'File d\'attente'
        root_cause = 'Trop d\'utilisateurs actifs'
    elif cqi < CONFIG['CQI_LOW']:
        issue_type = 'Qualité Signal'
        root_cause = 'Interférence ou couverture faible'
    else:
        issue_type = 'Performance Warning'
        root_cause = ', '.join(issues)
    
    # Health score (inverse of severity)
    health_score = max(0, 100 - severity)
    
    # Calculate estimated traffic loss (Manque à gagner)
    # Based on Orange model: loss proportional to excess load and throughput gap
    traffic_loss_ue = 0
    traffic_loss_gb = 0
    if congested:
        # Estimate users affected by congestion
        excess_load = max(0, load - 70) / 100
        throughput_gap = max(0, CONFIG['THROUGHPUT_TARGET'] - throughput) / CONFIG['THROUGHPUT_TARGET']
        traffic_loss_ue = int(active_users * excess_load * 0.5)
        traffic_loss_gb = round(traffic_loss_ue * 2.4, 1)  # ~2.4 GB per affected UE/month estimate
    
    return {
        'congested': congested,
        'severity': min(100, severity),
        'issue_type': issue_type,
        'root_cause': root_cause,
        'health_score': health_score,
        'traffic_loss_ue': traffic_loss_ue,
        'traffic_loss_gb': traffic_loss_gb,
    }


def process_time_series_data(
    input_files: List[str],
    output_dir: str = '.',
) -> Dict:
    """
    Process network data and organize by timestamp.
    Outputs:
    - baseline.json: Unique cells with static info (coordinates, azimuth, band)
    - time_index.json: List of available timestamps
    - time_data/<timestamp>.parquet: Cell metrics for each timestamp
    """
    start_time = datetime.now()
    
    print("=" * 70)
    print("  NetVision Digital Twin - Time-Series Processor v4.0")
    print("=" * 70)
    
    # Load data
    print("\n📂 PHASE 1: Loading data...")
    print("-" * 50)
    df = load_data(input_files)
    print(f"  → Total records: {len(df):,}")
    
    # Clean data
    print("\n🧹 PHASE 2: Cleaning data...")
    print("-" * 50)

    # Some KPI files do not include geometry/static columns on every row.
    # Backfill missing static metadata by cell_name from rows that do have it.
    if 'cell_name' in df.columns:
        df['cell_name'] = df['cell_name'].astype(str).str.strip()
        geo_seed = df.dropna(subset=['longitude_sector', 'latitude_sector']).copy()
        if not geo_seed.empty:
            geo_seed = geo_seed.drop_duplicates(subset=['cell_name'], keep='first')
            seed_lookup = geo_seed.set_index('cell_name')
            for static_col in [
                'longitude_sector',
                'latitude_sector',
                'azimuth',
                'frequency_band',
                'localcell_id',
                'enodeb_name',
            ]:
                if static_col in df.columns and static_col in seed_lookup.columns:
                    df[static_col] = df[static_col].where(
                        df[static_col].notna(),
                        df['cell_name'].map(seed_lookup[static_col])
                    )

    # Normalize potentially locale-formatted numeric fields before filtering.
    numeric_specs = {
        'longitude_sector': (-180, 180),
        'latitude_sector': (-90, 90),
        'azimuth': (0, 360),
        'frequency_band': (None, None),
        'localcell_id': (None, None),
        'ft_physical_resource_blocks_load_dl': (0, 100),
        'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_': (0, None),
        'ft_4g_lte_average_reported_cqi': (0, 15),
        'l_traffic_activeuser_dl_avg': (0, None),
        'ft_average_nb_of_users__ues_rrc_connected': (0, None),
        'ot_average_ta': (0, None),
        'referencesignalpwr': (None, None),
    }
    for numeric_col, (min_value, max_value) in numeric_specs.items():
        if numeric_col in df.columns:
            df[numeric_col] = df[numeric_col].apply(
                lambda value: parse_numeric(
                    value,
                    default=np.nan,
                    min_value=min_value,
                    max_value=max_value,
                )
            )

    df = df.dropna(subset=['longitude_sector', 'latitude_sector'])
    df = df[(df['longitude_sector'].between(-180, 180)) & (df['latitude_sector'].between(-90, 90))]
    print(f"  → Valid records: {len(df):,}")
    
    # Parse timestamps
    print("\n⏰ PHASE 3: Analyzing time structure...")
    print("-" * 50)
    raw_date = df['date'].astype(str).str.strip()
    if 'time' in df.columns:
        raw_time = df['time'].astype(str).str.strip()
        date_has_time = raw_date.str.contains(r'\d{1,2}:\d{2}', regex=True, na=False)
        raw_date = raw_date.where(date_has_time, (raw_date + ' ' + raw_time).str.strip())

    raw_date = raw_date.str.replace(r'\s+', ' ', regex=True).str.strip()
    parsed_ts = pd.to_datetime(raw_date, format='%d-%m-%Y %H:%M', errors='coerce')
    missing_time_mask = parsed_ts.isna()
    if missing_time_mask.any():
        parsed_ts.loc[missing_time_mask] = pd.to_datetime(
            raw_date.loc[missing_time_mask],
            format='%d-%m-%Y',
            errors='coerce'
        )

    df = df.loc[parsed_ts.notna()].copy()
    parsed_ts = parsed_ts.loc[parsed_ts.notna()]
    df['date'] = parsed_ts.dt.strftime('%d-%m-%Y %H:%M')
    
    # Get unique timestamps
    timestamps = sorted(
        df['date'].unique(),
        key=lambda x: datetime.strptime(x, '%d-%m-%Y %H:%M')
    )
    print(f"  → Unique timestamps: {len(timestamps)}")
    print(f"  → Time range: {timestamps[0]} to {timestamps[-1]}")
    
    # Get unique cells
    unique_cells = df['cell_name'].nunique()
    unique_sites = df['enodeb_name'].nunique()
    print(f"  → Unique cells: {unique_cells}")
    print(f"  → Unique sites: {unique_sites}")
    print(f"  → Avg cells per site: {unique_cells / unique_sites:.1f}")
    
    # Create baseline (static cell info)
    print("\n📍 PHASE 4: Creating cell baseline...")
    print("-" * 50)
    
    # Get first occurrence of each cell for baseline
    baseline_df = df.drop_duplicates(subset=['cell_name'], keep='first')
    
    baseline = {}
    for _, row in baseline_df.iterrows():
        cell_name = str(row['cell_name'])
        baseline[cell_name] = {
            'enodeb_name': str(row['enodeb_name']),
            'longitude': float(row['longitude_sector']),
            'latitude': float(row['latitude_sector']),
            'azimuth': float(row['azimuth']) if pd.notna(row['azimuth']) else 0,
            'frequency_band': int(row['frequency_band']) if pd.notna(row['frequency_band']) else None,
            'localcell_id': int(row['localcell_id']) if pd.notna(row['localcell_id']) else None,
        }
    
    print(f"  ✓ Created baseline with {len(baseline)} cells")
    
    # Create data directory
    data_dir = os.path.join(output_dir, 'time_data')
    os.makedirs(data_dir, exist_ok=True)
    
    # Process each timestamp
    print("\n📊 PHASE 5: Processing time slices...")
    print("-" * 50)
    
    time_index = []
    global_stats = {
        'total_timestamps': len(timestamps),
        'total_cells': len(baseline),
        'total_sites': unique_sites,
        'frequency_bands': sorted(df['frequency_band'].dropna().unique().astype(int).tolist()),
    }
    
    for i, ts in enumerate(timestamps):
        ts_df = df[df['date'] == ts].copy()
        
        # Analyze each cell at this timestamp
        observations = {}
        observation_rows: List[Dict[str, Any]] = []
        congested_count = 0
        total_load = 0
        total_throughput = 0
        total_cqi = 0
        total_health = 0
        load_count = 0
        throughput_count = 0
        cqi_count = 0
        
        for _, row in ts_df.iterrows():
            cell_name = str(row['cell_name'])
            analysis = analyze_cell(row)
            
            load = row.get('ft_physical_resource_blocks_load_dl')
            throughput = row.get('ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_')
            cqi = row.get('ft_4g_lte_average_reported_cqi')
            active_users_raw = row.get('l_traffic_activeuser_dl_avg')
            rrc_users_raw = row.get('ft_average_nb_of_users__ues_rrc_connected')
            ta = row.get('ot_average_ta')
            signal = row.get('referencesignalpwr')

            load_value = parse_numeric(load, default=None, min_value=0, max_value=100)
            throughput_value = parse_numeric(throughput, default=None, min_value=0)
            cqi_value = parse_numeric(cqi, default=None, min_value=0, max_value=15)
            active_users_value = parse_numeric(active_users_raw, default=None, min_value=0)
            rrc_users_value = parse_numeric(rrc_users_raw, default=None, min_value=0)
            ta_value = parse_numeric(ta, default=None, min_value=0)
            signal_value = parse_numeric(signal, default=None)
            
            observation = {
                'load': load_value,
                'throughput': throughput_value,
                'cqi': cqi_value,
                'active_users': active_users_value,
                'rrc_users': rrc_users_value,
                'traffic': active_users_value,
                'ta': ta_value,
                'signal_power': signal_value,
                'congested': analysis['congested'],
                'severity': analysis['severity'],
                'issue_type': analysis['issue_type'],
                'root_cause': analysis['root_cause'],
                'health_score': analysis['health_score'],
            }
            observations[cell_name] = observation
            observation_rows.append({
                'cell_name': cell_name,
                **observation,
            })
            
            if analysis['congested']:
                congested_count += 1
            
            if load_value is not None:
                total_load += load_value
                load_count += 1
            if throughput_value is not None:
                total_throughput += throughput_value
                throughput_count += 1
            if cqi_value is not None:
                total_cqi += cqi_value
                cqi_count += 1
            total_health += analysis['health_score']
        
        # Calculate timestamp stats
        ts_stats = {
            'cells_observed': len(observations),
            'congested': congested_count,
            'congestion_rate': round(congested_count / len(observations) * 100, 2) if observations else 0,
            'avg_load': round(total_load / load_count, 2) if load_count else 0,
            'avg_throughput': round(total_throughput / throughput_count, 2) if throughput_count else 0,
            'avg_cqi': round(total_cqi / cqi_count, 2) if cqi_count else 0,
            'avg_health': round(total_health / len(observations), 2) if observations else 0,
        }
        
        # Save timestamp data
        ts_filename = ts.replace(' ', '_').replace(':', '-').replace('/', '-') + '.parquet'
        ts_path = os.path.join(data_dir, ts_filename)
        ts_slice_df = pd.DataFrame.from_records(observation_rows)
        write_parquet_slice(ts_slice_df, ts_path)
        
        time_index.append({
            'timestamp': ts,
            'filename': ts_filename,
            'stats': ts_stats
        })
        
        if (i + 1) % 50 == 0 or i == len(timestamps) - 1:
            print(f"  → Processed {i + 1}/{len(timestamps)} timestamps")
    
    # Save baseline
    print("\n💾 PHASE 6: Saving output files...")
    print("-" * 50)
    
    baseline_path = os.path.join(output_dir, 'baseline.json')
    with open(baseline_path, 'w', encoding='utf-8') as f:
        json.dump(baseline, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Saved baseline ({len(baseline)} cells) to baseline.json")
    
    # Save time index
    time_index_path = os.path.join(output_dir, 'time_index.json')
    with open(time_index_path, 'w', encoding='utf-8') as f:
        json.dump({
            'total_timestamps': len(time_index),
            'start_time': timestamps[0],
            'end_time': timestamps[-1],
            'storage_format': 'parquet',
            'timestamps': time_index
        }, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Saved time index ({len(time_index)} entries) to time_index.json")
    
    # Save global stats
    stats_path = os.path.join(output_dir, 'stats.json')
    with open(stats_path, 'w', encoding='utf-8') as f:
        json.dump(global_stats, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Saved global stats to stats.json")
    
    elapsed = (datetime.now() - start_time).total_seconds()
    
    print("\n" + "=" * 70)
    print("  PROCESSING COMPLETE")
    print("=" * 70)
    print(f"""
    📡 Network Baseline:
       • Unique Cells:      {len(baseline):,}
       • Unique Sites:      {unique_sites}
       • Frequency Bands:   {global_stats['frequency_bands']}
    
    ⏰ Time Series:
       • Time Slices:       {len(timestamps)}
       • Time Range:        {timestamps[0]} → {timestamps[-1]}
    
    ⏱️  Processing Time:    {elapsed:.2f} seconds
    """)
    print("=" * 70 + "\n")
    
    return global_stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process time-series network KPI files for NetVision")
    parser.add_argument(
        '--input',
        nargs='+',
        default=['data_set_radio_1.csv', 'data_set_radio_all_hour.csv'],
        help='Input CSV file(s)'
    )
    parser.add_argument(
        '--output',
        default='runtime_data',
        help='Output directory for baseline.json, time_index.json, stats.json, and time_data/'
    )
    args = parser.parse_args()
    
    try:
        stats = process_time_series_data(args.input, output_dir=args.output)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        raise
