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
from datetime import datetime
from typing import List, Dict, Any
import warnings
warnings.filterwarnings('ignore')

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ============================================
# CONFIGURATION - Orange Network KPI Thresholds
# Based on Orange DRS standards
# ============================================
CONFIG = {
    # PRB Load Thresholds (Physical Resource Block) - Orange Standard
    'PRB_SATURATED': 90,         # Saturé (Critical)
    'PRB_HIGH': 80,              # Seuil cible (Target threshold)
    'PRB_MEDIUM': 70,            # Pre-warning
    'PRB_LOW': 50,               # Normal operation
    
    # Throughput Thresholds (kbps) - Orange Standard
    'THROUGHPUT_DEGRADED': 4000,  # < 4 Mbps = Dégradé
    'THROUGHPUT_TARGET': 10000,   # ≥ 10 Mbps = Target
    'THROUGHPUT_CRITICAL': 2000,  # Very poor
    
    # Active Users (File d'attente) - Orange Standard
    'USERS_CRITICAL': 4,          # > 4 = Critique
    'USERS_TARGET': 1,            # ≤ 1 = Target
    
    # CQI Thresholds (Channel Quality Indicator, 0-15)
    'CQI_CRITICAL': 5,           # Very poor signal quality
    'CQI_LOW': 7,                # Poor quality
    'CQI_MEDIUM': 9,             # Acceptable quality
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
    load = float(load) if pd.notna(load) else 0
    throughput = float(throughput) if pd.notna(throughput) else 10000
    cqi = float(cqi) if pd.notna(cqi) else 10
    active_users = float(active_users) if pd.notna(active_users) else 0
    
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
    
    # --- CONGESTION DETECTION (Orange criteria) ---
    congested = False
    
    # Rule 1: PRB ≥ 90% = Always congested (Saturé)
    if load >= CONFIG['PRB_SATURATED']:
        congested = True
    
    # Rule 2: PRB ≥ 80% AND Throughput < 4 Mbps
    elif load >= CONFIG['PRB_HIGH'] and throughput < CONFIG['THROUGHPUT_DEGRADED']:
        congested = True
    
    # Rule 3: Active users > 4 AND PRB ≥ 70%
    elif active_users > CONFIG['USERS_CRITICAL'] and load >= CONFIG['PRB_MEDIUM']:
        congested = True
    
    # Rule 4: Throughput < 4 Mbps AND PRB ≥ 70% (degraded experience)
    elif throughput < CONFIG['THROUGHPUT_DEGRADED'] and load >= CONFIG['PRB_MEDIUM']:
        congested = True
    
    # Rule 5: Severity score high enough
    elif severity >= 50:
        congested = True
    
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
    df = df.dropna(subset=['longitude_sector', 'latitude_sector'])
    df = df[(df['longitude_sector'].between(-180, 180)) & (df['latitude_sector'].between(-90, 90))]
    print(f"  → Valid records: {len(df):,}")
    
    # Parse timestamps
    print("\n⏰ PHASE 3: Analyzing time structure...")
    print("-" * 50)
    df['date'] = df['date'].astype(str).str.strip()
    
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
            traffic = row.get('l_traffic_activeuser_dl_avg')
            ta = row.get('ot_average_ta')
            signal = row.get('referencesignalpwr')
            
            observation = {
                'load': float(load) if pd.notna(load) else None,
                'throughput': float(throughput) if pd.notna(throughput) else None,
                'cqi': float(cqi) if pd.notna(cqi) else None,
                'traffic': float(traffic) if pd.notna(traffic) else None,
                'ta': float(ta) if pd.notna(ta) else None,
                'signal_power': float(signal) if pd.notna(signal) else None,
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
            
            if pd.notna(load):
                total_load += load
                load_count += 1
            if pd.notna(throughput):
                total_throughput += throughput
                throughput_count += 1
            if pd.notna(cqi):
                total_cqi += cqi
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
        default='.',
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
