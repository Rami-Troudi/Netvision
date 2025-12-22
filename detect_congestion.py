"""
NetVision Digital Twin - Advanced Data Processing Engine
=========================================================
High-performance radio network data processor with advanced congestion
detection, coverage analysis, and interference identification.

Optimized for datasets with 700k+ records using vectorized operations.

Author: Network Operations Team
Version: 3.0 - Performance Edition
"""

import pandas as pd
import numpy as np
import json
import os
from datetime import datetime
from typing import Tuple, Dict, List, Optional
import warnings
warnings.filterwarnings('ignore')

# ============================================
# CONFIGURATION - Network KPI Thresholds
# ============================================
CONFIG = {
    # PRB Load Thresholds (Physical Resource Block)
    'PRB_CRITICAL': 90,          # Critical congestion
    'PRB_HIGH': 80,              # High load
    'PRB_MEDIUM': 70,            # Medium load
    'PRB_LOW': 50,               # Normal operation
    
    # Throughput Thresholds (kbps)
    'THROUGHPUT_CRITICAL': 1000,  # Very poor throughput
    'THROUGHPUT_LOW': 3000,       # Low throughput
    'THROUGHPUT_GOOD': 10000,     # Good throughput
    
    # CQI Thresholds (Channel Quality Indicator, 0-15)
    'CQI_CRITICAL': 4,           # Very poor signal quality
    'CQI_LOW': 6,                # Poor quality
    'CQI_MEDIUM': 8,             # Acceptable quality
    'CQI_GOOD': 10,              # Good quality
    
    # Traffic/Active Users Thresholds
    'TRAFFIC_VERY_HIGH': 10,     # Very high traffic
    'TRAFFIC_HIGH': 5,           # High traffic
    'TRAFFIC_MEDIUM': 2,         # Medium traffic
    
    # Timing Advance Thresholds (coverage radius indicator)
    'TA_EXTENDED': 10,           # Extended coverage (potential issues)
    'TA_NORMAL': 5,              # Normal coverage
    
    # Signal Power Thresholds (higher value = weaker signal in this dataset)
    'SIGNAL_WEAK': 180,          # Weak signal
    'SIGNAL_MEDIUM': 170,        # Medium signal
    
    # Band-specific multipliers (different bands have different characteristics)
    'BAND_MULTIPLIERS': {
        1: {'capacity': 1.0, 'coverage': 1.0},      # Band 1 (2100 MHz) - balanced
        3: {'capacity': 1.2, 'coverage': 0.8},      # Band 3 (1800 MHz) - more capacity
        20: {'capacity': 0.7, 'coverage': 1.3},     # Band 20 (800 MHz) - more coverage
    },
    
    # Processing configuration
    'CHUNK_SIZE': 50000,         # Process in chunks for memory efficiency
}


# ============================================
# ISSUE TYPES AND ROOT CAUSES
# ============================================
class IssueType:
    CONGESTION = "Congestion"
    CAPACITY = "Capacity Issue"
    COVERAGE = "Coverage Issue"
    QUALITY = "Quality Degradation"
    INTERFERENCE = "Potential Interference"
    OVERLOAD = "Network Overload"
    NORMAL = "Normal"


# ============================================
# DATA LOADING - Optimized for Large Files
# ============================================
def load_data_optimized(file_paths: List[str], chunk_size: int = None) -> pd.DataFrame:
    """
    Load and combine multiple CSV files with memory-efficient chunked reading.
    Optimized for 700k+ row datasets.
    """
    chunk_size = chunk_size or CONFIG['CHUNK_SIZE']
    dataframes = []
    
    # Define dtypes for memory optimization
    dtype_map = {
        'date': 'object',
        'enodeb_name': 'category',
        'cell_name': 'category',
        'frequency_band': 'float32',
        'localcell_id': 'float32',
        'cell_fdd_tdd_indication': 'category',
        'longitude_sector': 'float32',
        'latitude_sector': 'float32',
        'azimuth': 'float32',
        'l_traffic_activeuser_dl_avg': 'float32',
        'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_': 'float32',
        'ft_physical_resource_blocks_load_dl': 'float32',
        'ft_4g_lte_average_reported_cqi': 'float32',
        'ot_average_ta': 'float32',
        'referencesignalpwr': 'float32'
    }
    
    for path in file_paths:
        if not os.path.exists(path):
            print(f"  ✗ File not found: {path}")
            continue
            
        try:
            # Read in chunks for large files
            file_size = os.path.getsize(path) / (1024 * 1024)  # MB
            
            if file_size > 50:  # If file > 50MB, use chunked reading
                print(f"  → Large file detected ({file_size:.1f}MB), using chunked loading...")
                chunks = []
                for chunk in pd.read_csv(path, chunksize=chunk_size, 
                                        low_memory=True, na_values=['', 'NA', 'N/A', 'null']):
                    chunk.columns = chunk.columns.str.strip().str.lower()
                    if 'longitude_sector' in chunk.columns and 'latitude_sector' in chunk.columns:
                        chunks.append(chunk)
                if chunks:
                    df = pd.concat(chunks, ignore_index=True)
                    dataframes.append(df)
            else:
                df = pd.read_csv(path, low_memory=True,
                                na_values=['', 'NA', 'N/A', 'null'])
                df.columns = df.columns.str.strip().str.lower()
                if 'longitude_sector' in df.columns and 'latitude_sector' in df.columns:
                    dataframes.append(df)
                    
            print(f"  ✓ Loaded {len(df):,} records from {os.path.basename(path)}")
            
        except Exception as e:
            print(f"  ✗ Error loading {path}: {e}")
    
    if not dataframes:
        raise ValueError("No valid data files could be loaded")
    
    combined = pd.concat(dataframes, ignore_index=True)
    print(f"  → Combined dataset: {len(combined):,} total records")
    
    # Memory optimization
    combined = optimize_memory(combined)
    
    return combined


def optimize_memory(df: pd.DataFrame) -> pd.DataFrame:
    """Optimize DataFrame memory usage."""
    start_mem = df.memory_usage(deep=True).sum() / 1024**2
    
    # Convert object columns to category where appropriate
    for col in df.select_dtypes(include=['object']).columns:
        if df[col].nunique() / len(df) < 0.5:  # Less than 50% unique values
            df[col] = df[col].astype('category')
    
    # Downcast numeric types
    for col in df.select_dtypes(include=['float64']).columns:
        df[col] = pd.to_numeric(df[col], downcast='float')
    
    for col in df.select_dtypes(include=['int64']).columns:
        df[col] = pd.to_numeric(df[col], downcast='integer')
    
    end_mem = df.memory_usage(deep=True).sum() / 1024**2
    if start_mem > 0:
        print(f"  → Memory optimized: {start_mem:.1f}MB → {end_mem:.1f}MB ({(1-end_mem/start_mem)*100:.1f}% reduction)")
    
    return df


# Legacy function for backwards compatibility
def load_data(file_paths: List[str]) -> pd.DataFrame:
    """Load and combine multiple CSV files."""
    return load_data_optimized(file_paths)


def clean_data(df: pd.DataFrame) -> pd.DataFrame:
    """Clean and normalize the dataset using vectorized operations."""
    initial_count = len(df)
    
    # Remove rows without coordinates
    mask = df['longitude_sector'].notna() & df['latitude_sector'].notna()
    df = df[mask].copy()
    
    # Remove invalid coordinates
    mask = (df['longitude_sector'].between(-180, 180)) & (df['latitude_sector'].between(-90, 90))
    df = df[mask].copy()
    
    removed = initial_count - len(df)
    if removed > 0:
        print(f"  → Removed {removed:,} records without valid coordinates")
    
    # Fill missing values with appropriate defaults for analysis
    df['l_traffic_activeuser_dl_avg'] = df['l_traffic_activeuser_dl_avg'].fillna(0)
    
    return df


# ============================================
# ADVANCED CONGESTION ANALYSIS - Vectorized
# ============================================
def analyze_congestion_vectorized(df: pd.DataFrame) -> pd.DataFrame:
    """
    Vectorized congestion analysis for high performance.
    Analyzes multiple KPIs to detect various network issues.
    """
    n = len(df)
    
    # Initialize result arrays
    severity = np.zeros(n, dtype=np.float32)
    issues = [[] for _ in range(n)]
    issue_types = [''] * n
    
    # Extract columns as numpy arrays for speed
    prb_load = df['ft_physical_resource_blocks_load_dl'].values.astype(np.float32)
    throughput = df['ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_'].values.astype(np.float32)
    traffic = df['l_traffic_activeuser_dl_avg'].values.astype(np.float32)
    cqi = df['ft_4g_lte_average_reported_cqi'].values.astype(np.float32)
    ta = df['ot_average_ta'].values.astype(np.float32) if 'ot_average_ta' in df.columns else np.zeros(n, dtype=np.float32)
    signal_pwr = df['referencesignalpwr'].values.astype(np.float32) if 'referencesignalpwr' in df.columns else np.zeros(n, dtype=np.float32)
    band = df['frequency_band'].values if 'frequency_band' in df.columns else np.ones(n)
    
    # Convert NaN to sentinel values
    prb_load = np.nan_to_num(prb_load, nan=-1)
    throughput = np.nan_to_num(throughput, nan=-1)
    traffic = np.nan_to_num(traffic, nan=0)
    cqi = np.nan_to_num(cqi, nan=-1)
    ta = np.nan_to_num(ta, nan=0)
    signal_pwr = np.nan_to_num(signal_pwr, nan=0)
    
    # ==========================================
    # ANALYSIS 1: PRB Load Analysis
    # ==========================================
    prb_valid = prb_load >= 0
    prb_severity = np.zeros(n, dtype=np.float32)
    
    # Critical PRB load
    mask = prb_valid & (prb_load >= CONFIG['PRB_CRITICAL'])
    prb_severity[mask] = 40
    for i in np.where(mask)[0]:
        issues[i].append("Critical PRB Overload")
    
    # High PRB load
    mask = prb_valid & (prb_load >= CONFIG['PRB_HIGH']) & (prb_load < CONFIG['PRB_CRITICAL'])
    prb_severity[mask] = 30
    for i in np.where(mask)[0]:
        issues[i].append("High PRB Load")
    
    # Medium PRB load
    mask = prb_valid & (prb_load >= CONFIG['PRB_MEDIUM']) & (prb_load < CONFIG['PRB_HIGH'])
    prb_severity[mask] = 15
    for i in np.where(mask)[0]:
        issues[i].append("Elevated PRB Load")
    
    severity += prb_severity
    
    # ==========================================
    # ANALYSIS 2: Throughput Analysis
    # ==========================================
    tp_valid = (throughput >= 0) & (traffic > 0.5)
    tp_severity = np.zeros(n, dtype=np.float32)
    
    # Critical throughput
    mask = tp_valid & (throughput < CONFIG['THROUGHPUT_CRITICAL']) & (throughput >= 0)
    tp_severity[mask] = 30
    for i in np.where(mask)[0]:
        issues[i].append("Critical Low Throughput")
    
    # Low throughput
    mask = tp_valid & (throughput >= CONFIG['THROUGHPUT_CRITICAL']) & (throughput < CONFIG['THROUGHPUT_LOW'])
    tp_severity[mask] = 20
    for i in np.where(mask)[0]:
        issues[i].append("Low Throughput")
    
    severity += tp_severity
    
    # ==========================================
    # ANALYSIS 3: CQI (Signal Quality) Analysis
    # ==========================================
    cqi_valid = cqi >= 0
    cqi_severity = np.zeros(n, dtype=np.float32)
    
    # Critical CQI
    mask = cqi_valid & (cqi < CONFIG['CQI_CRITICAL'])
    cqi_severity[mask] = 25
    for i in np.where(mask)[0]:
        issues[i].append("Very Poor Signal Quality")
    
    # Low CQI
    mask = cqi_valid & (cqi >= CONFIG['CQI_CRITICAL']) & (cqi < CONFIG['CQI_LOW'])
    cqi_severity[mask] = 15
    for i in np.where(mask)[0]:
        issues[i].append("Poor Signal Quality")
    
    # Medium CQI
    mask = cqi_valid & (cqi >= CONFIG['CQI_LOW']) & (cqi < CONFIG['CQI_MEDIUM'])
    cqi_severity[mask] = 8
    for i in np.where(mask)[0]:
        issues[i].append("Suboptimal Signal Quality")
    
    severity += cqi_severity
    
    # ==========================================
    # ANALYSIS 4: Traffic Load Analysis
    # ==========================================
    traffic_severity = np.zeros(n, dtype=np.float32)
    
    # Very high traffic
    mask = traffic >= CONFIG['TRAFFIC_VERY_HIGH']
    traffic_severity[mask] = 15
    for i in np.where(mask)[0]:
        issues[i].append("Very High User Load")
    
    # High traffic
    mask = (traffic >= CONFIG['TRAFFIC_HIGH']) & (traffic < CONFIG['TRAFFIC_VERY_HIGH'])
    traffic_severity[mask] = 8
    for i in np.where(mask)[0]:
        issues[i].append("High User Load")
    
    severity += traffic_severity
    
    # ==========================================
    # ANALYSIS 5: Coverage Analysis (TA + Signal Power)
    # ==========================================
    coverage_severity = np.zeros(n, dtype=np.float32)
    
    # Extended coverage with weak signal
    mask = (ta > CONFIG['TA_EXTENDED']) & (signal_pwr > CONFIG['SIGNAL_WEAK'])
    coverage_severity[mask] = 15
    for i in np.where(mask)[0]:
        issues[i].append("Extended Range + Weak Signal")
    
    # Extended coverage only
    mask = (ta > CONFIG['TA_EXTENDED']) & (signal_pwr <= CONFIG['SIGNAL_WEAK']) & (signal_pwr > 0)
    coverage_severity[mask] = 8
    for i in np.where(mask)[0]:
        issues[i].append("Extended Coverage Area")
    
    severity += coverage_severity
    
    # ==========================================
    # ANALYSIS 6: Interference Detection
    # ==========================================
    mask = cqi_valid & (cqi < CONFIG['CQI_LOW']) & (signal_pwr < CONFIG['SIGNAL_MEDIUM']) & (signal_pwr > 0)
    for i in np.where(mask)[0]:
        issues[i].append("Potential Interference")
        severity[i] += 10
    
    # ==========================================
    # ANALYSIS 7: Capacity vs Quality Issue
    # ==========================================
    mask = prb_valid & tp_valid & (prb_load >= CONFIG['PRB_HIGH']) & (throughput < CONFIG['THROUGHPUT_LOW'])
    for i in np.where(mask)[0]:
        issues[i].append("Capacity Bottleneck")
        severity[i] += 5
    
    # ==========================================
    # TRAFFIC AMPLIFICATION
    # ==========================================
    high_traffic_mask = traffic >= CONFIG['TRAFFIC_HIGH']
    severity[high_traffic_mask] = np.minimum(100, severity[high_traffic_mask] * 1.15)
    
    # Cap severity at 100
    severity = np.minimum(100, severity)
    
    # ==========================================
    # DETERMINE ISSUE TYPE
    # ==========================================
    for i in range(n):
        issue_list = issues[i]
        if not issue_list:
            issue_types[i] = IssueType.NORMAL
        elif any('PRB' in x or 'Capacity' in x for x in issue_list):
            if any('Throughput' in x for x in issue_list):
                issue_types[i] = IssueType.OVERLOAD
            else:
                issue_types[i] = IssueType.CAPACITY
        elif any('Coverage' in x or 'Extended' in x for x in issue_list):
            issue_types[i] = IssueType.COVERAGE
        elif any('Interference' in x for x in issue_list):
            issue_types[i] = IssueType.INTERFERENCE
        elif any('Signal Quality' in x for x in issue_list):
            issue_types[i] = IssueType.QUALITY
        elif any('Throughput' in x for x in issue_list):
            issue_types[i] = IssueType.CONGESTION
        else:
            issue_types[i] = IssueType.CONGESTION
    
    # ==========================================
    # ADD RESULTS TO DATAFRAME
    # ==========================================
    df = df.copy()
    df['severity'] = severity.astype(np.int16)
    df['congested'] = severity >= 40
    df['root_cause'] = [' + '.join(iss) if iss else 'Normal' for iss in issues]
    df['issue_type'] = issue_types
    
    # Add severity level
    df['severity_level'] = pd.cut(
        df['severity'],
        bins=[-1, 0, 20, 40, 60, 80, 100],
        labels=['Normal', 'Low', 'Medium', 'High', 'Critical', 'Severe']
    )
    
    # Add health score (inverse of severity)
    df['health_score'] = (100 - df['severity']).clip(0, 100)
    
    return df


# Legacy function for backwards compatibility
def analyze_congestion(row: pd.Series) -> Tuple[bool, str, int]:
    """Legacy single-row analysis function."""
    load = row.get('ft_physical_resource_blocks_load_dl')
    throughput = row.get('ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_')
    traffic = row.get('l_traffic_activeuser_dl_avg', 0)
    cqi = row.get('ft_4g_lte_average_reported_cqi')
    
    severity = 0
    issues = []
    
    if pd.notna(load):
        if load >= CONFIG['PRB_CRITICAL']:
            severity += 40
            issues.append("Critical PRB Load")
        elif load >= CONFIG['PRB_HIGH']:
            severity += 25
            issues.append("High PRB Load")
    
    if pd.notna(throughput) and pd.notna(traffic) and traffic > 1:
        if throughput < CONFIG['THROUGHPUT_LOW']:
            severity += 30
            issues.append("Low Throughput")
    
    if pd.notna(cqi):
        if cqi < CONFIG['CQI_LOW']:
            severity += 20
            issues.append("Poor Signal Quality")
    
    if pd.notna(traffic) and traffic >= CONFIG['TRAFFIC_HIGH']:
        severity = min(100, int(severity * 1.2))
        if traffic >= 10:
            issues.append("Heavy Traffic")
    
    is_congested = severity >= 40
    root_cause = " + ".join(issues) if issues else "Normal"
    
    return is_congested, root_cause, min(100, severity)


def calculate_statistics(df: pd.DataFrame) -> Dict:
    """Calculate comprehensive network-wide statistics."""
    total_cells = len(df)
    congested_cells = int(df['congested'].sum()) if 'congested' in df.columns else 0
    
    # Severity distribution
    severity_dist = {}
    if 'severity_level' in df.columns:
        severity_dist = df['severity_level'].value_counts().to_dict()
    
    # Issue type distribution
    issue_dist = {}
    if 'issue_type' in df.columns:
        issue_dist = df['issue_type'].value_counts().to_dict()
    
    # Band statistics
    band_stats = {}
    if 'frequency_band' in df.columns:
        for band in df['frequency_band'].dropna().unique():
            band_df = df[df['frequency_band'] == band]
            band_stats[int(band)] = {
                'count': len(band_df),
                'congested': int(band_df['congested'].sum()) if 'congested' in band_df.columns else 0,
                'avg_load': float(band_df['ft_physical_resource_blocks_load_dl'].mean() or 0),
                'avg_cqi': float(band_df['ft_4g_lte_average_reported_cqi'].mean() or 0)
            }
    
    stats = {
        'total_cells': total_cells,
        'congested_cells': congested_cells,
        'congestion_rate': round((congested_cells / total_cells) * 100, 2) if total_cells > 0 else 0,
        'avg_load': round(float(df['ft_physical_resource_blocks_load_dl'].mean() or 0), 2),
        'max_load': round(float(df['ft_physical_resource_blocks_load_dl'].max() or 0), 2),
        'avg_throughput': round(float(df['ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_'].mean() or 0), 2),
        'avg_cqi': round(float(df['ft_4g_lte_average_reported_cqi'].mean() or 0), 2),
        'avg_health_score': round(float(df['health_score'].mean() or 0), 2) if 'health_score' in df.columns else 0,
        'data_completeness': round((df['ft_physical_resource_blocks_load_dl'].notna().sum() / total_cells) * 100, 2),
        'unique_sites': df['enodeb_name'].nunique() if 'enodeb_name' in df.columns else 0,
        'frequency_bands': sorted([int(x) for x in df['frequency_band'].dropna().unique()]) if 'frequency_band' in df.columns else [],
        'severity_distribution': {str(k): int(v) for k, v in severity_dist.items()},
        'issue_distribution': {str(k): int(v) for k, v in issue_dist.items()},
        'band_statistics': band_stats,
        'timestamp': datetime.now().isoformat()
    }
    
    return stats


def process_network_data(input_files: List[str], output_path: str = 'data.json',
                         stats_path: str = 'stats.json', max_output_records: int = None) -> Dict:
    """
    Main processing pipeline for network data.
    Optimized for 700k+ row datasets.
    """
    start_time = datetime.now()
    
    print("\n" + "="*70)
    print("  NetVision Digital Twin - Advanced Data Processing Engine v3.0")
    print("  Optimized for Large-Scale Network Analysis")
    print("="*70 + "\n")
    
    # Step 1: Load data
    print("📂 PHASE 1: Loading data files...")
    print("-" * 50)
    df = load_data_optimized(input_files)
    
    # Step 2: Clean data
    print("\n🧹 PHASE 2: Cleaning and validating data...")
    print("-" * 50)
    df = clean_data(df)
    print(f"  → Valid records after cleaning: {len(df):,}")
    
    # Step 3: Analyze congestion (using vectorized version)
    print("\n🔍 PHASE 3: Performing advanced network analysis...")
    print("-" * 50)
    print("  → Analyzing PRB Load patterns...")
    print("  → Evaluating throughput performance...")
    print("  → Assessing signal quality (CQI)...")
    print("  → Detecting coverage issues...")
    print("  → Identifying potential interference...")
    df = analyze_congestion_vectorized(df)
    
    congested_count = int(df['congested'].sum())
    print(f"\n  ✓ Analysis complete!")
    print(f"    • Congested cells: {congested_count:,} ({congested_count/len(df)*100:.1f}%)")
    if 'issue_type' in df.columns:
        print(f"    • Issue types detected: {df['issue_type'].nunique()}")
    
    # Step 4: Calculate statistics
    print("\n📊 PHASE 4: Calculating network statistics...")
    print("-" * 50)
    stats = calculate_statistics(df)
    
    # Step 5: Prepare output
    print("\n💾 PHASE 5: Preparing output files...")
    print("-" * 50)
    
    # Prepare records for JSON
    output_columns = [
        'date', 'enodeb_name', 'longitude_sector', 'latitude_sector', 'azimuth',
        'cell_name', 'frequency_band', 'localcell_id', 'cell_fdd_tdd_indication',
        'l_traffic_activeuser_dl_avg', 'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_',
        'ft_physical_resource_blocks_load_dl', 'ft_4g_lte_average_reported_cqi',
        'ot_average_ta', 'referencesignalpwr', 'congested', 'root_cause',
        'severity', 'issue_type', 'severity_level', 'health_score'
    ]
    
    available_columns = [c for c in output_columns if c in df.columns]
    output_df = df[available_columns].copy()
    
    # Limit records if specified
    if max_output_records and len(output_df) > max_output_records:
        print(f"  → Limiting output to {max_output_records:,} records (from {len(output_df):,})")
        congested = output_df[output_df['congested'] == True]
        normal = output_df[output_df['congested'] == False]
        remaining = max_output_records - len(congested)
        if remaining > 0:
            normal_sample = normal.sample(n=min(remaining, len(normal)), random_state=42)
            output_df = pd.concat([congested, normal_sample], ignore_index=True)
        else:
            output_df = congested.head(max_output_records)
    
    records = output_df.to_dict('records')
    
    # Clean up NaN values for JSON
    for record in records:
        for key, value in record.items():
            if pd.isna(value):
                record[key] = None
            elif isinstance(value, (np.integer, np.floating)):
                record[key] = float(value) if np.isfinite(value) else None
    
    # Save data JSON
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, indent=2, ensure_ascii=False, default=str)
    print(f"  ✓ Saved {len(records):,} records to {output_path}")
    
    # Save statistics JSON
    with open(stats_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2, ensure_ascii=False, default=str)
    print(f"  ✓ Saved statistics to {stats_path}")
    
    elapsed = (datetime.now() - start_time).total_seconds()
    
    # Print summary
    print("\n" + "="*70)
    print("  PROCESSING SUMMARY")
    print("="*70)
    print(f"""
    📡 Network Overview:
       • Total Cells Analyzed:    {stats['total_cells']:,}
       • Unique Sites:            {stats['unique_sites']:,}
       • Frequency Bands:         {stats['frequency_bands']}
    
    🚨 Congestion Analysis:
       • Congested Cells:         {stats['congested_cells']:,} ({stats['congestion_rate']}%)
       • Average Health Score:    {stats.get('avg_health_score', 0):.1f}/100
    
    📈 Performance Metrics:
       • Avg PRB Load:            {stats['avg_load']:.1f}%
       • Max PRB Load:            {stats['max_load']:.1f}%
       • Avg Throughput:          {stats['avg_throughput']/1000:.2f} Mbps
       • Avg CQI:                 {stats['avg_cqi']:.1f}
       • Data Completeness:       {stats['data_completeness']:.1f}%
    
    ⏱️  Processing Time:          {elapsed:.2f} seconds
       • Records/second:         {len(df)/elapsed:,.0f}
    """)
    print("="*70 + "\n")
    
    return stats


if __name__ == "__main__":
    # Input files
    input_files = [
        'public_data_set_radio_1_page1.csv',
        'public_data_set_radio_all_hour_page1.csv'
    ]
    
    # Run processing
    try:
        stats = process_network_data(
            input_files,
            output_path='data.json',
            stats_path='stats.json',
            max_output_records=None
        )
    except Exception as e:
        print(f"\n❌ Error during processing: {e}")
        import traceback
        traceback.print_exc()
        raise
