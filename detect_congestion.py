"""
NetVision Digital Twin - Data Processing Engine
================================================
Processes radio network data to detect congestion and generate
visualization-ready JSON for the Digital Twin dashboard.

Author: Network Operations Team
Version: 2.0
"""

import pandas as pd
import numpy as np
import json
import os
from datetime import datetime
from typing import Tuple, Dict, List, Optional

# Configuration
CONFIG = {
    # Congestion thresholds
    'LOAD_CRITICAL': 85,      # PRB load % - Critical congestion
    'LOAD_HIGH': 70,          # PRB load % - High load warning
    'THROUGHPUT_MIN': 2000,   # Minimum throughput (kbps) for good service
    'CQI_MIN': 6,             # Minimum CQI for acceptable quality
    'TRAFFIC_HIGH': 5,        # High traffic threshold (active users)
    
    # Data quality
    'REQUIRED_COLUMNS': [
        'longitude_sector', 'latitude_sector', 'azimuth', 'cell_name',
        'ft_physical_resource_blocks_load_dl', 'l_traffic_activeuser_dl_avg'
    ]
}


def load_data(file_paths: List[str]) -> pd.DataFrame:
    """Load and combine multiple CSV files, with coordinate merging support."""
    dataframes = []
    base_df = None  # First file with coordinates becomes the base
    
    for i, path in enumerate(file_paths):
        if os.path.exists(path):
            try:
                df = pd.read_csv(path, delimiter=',')
                df.columns = df.columns.str.strip().str.lower()
                
                has_coords = 'longitude_sector' in df.columns and 'latitude_sector' in df.columns
                
                if has_coords:
                    base_df = df
                    dataframes.append(df)
                    print(f"  ✓ Loaded {len(df)} records from {os.path.basename(path)} (with coordinates)")
                else:
                    # This file lacks coordinates - we'll try to merge later
                    print(f"  ✓ Loaded {len(df)} records from {os.path.basename(path)} (no coordinates - metrics only)")
                    dataframes.append(df)
                    
            except Exception as e:
                print(f"  ✗ Error loading {path}: {e}")
        else:
            print(f"  ✗ File not found: {path}")
    
    if not dataframes:
        raise ValueError("No data files could be loaded")
    
    # If we have a base with coordinates, use only that
    # (The other file has different cells without location data)
    if base_df is not None:
        print(f"  → Using dataset with coordinates: {len(base_df)} records")
        return base_df
    
    combined = pd.concat(dataframes, ignore_index=True)
    print(f"  → Combined dataset: {len(combined)} total records")
    
    return combined


def clean_data(df: pd.DataFrame) -> pd.DataFrame:
    """Clean and normalize the dataset."""
    # Normalize column names
    df.columns = df.columns.str.strip().str.lower()
    
    # Define numeric columns
    numeric_cols = [
        'ft_physical_resource_blocks_load_dl',
        'l_traffic_activeuser_dl_avg',
        'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_',
        'ft_4g_lte_average_reported_cqi',
        'ot_average_ta',
        'referencesignalpwr',
        'longitude_sector',
        'latitude_sector',
        'azimuth',
        'frequency_band',
        'localcell_id'
    ]
    
    # Convert to numeric
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')
    
    # Remove rows without coordinates
    initial_count = len(df)
    df = df.dropna(subset=['longitude_sector', 'latitude_sector'])
    removed = initial_count - len(df)
    if removed > 0:
        print(f"  → Removed {removed} records without valid coordinates")
    
    return df


def analyze_congestion(row: pd.Series) -> Tuple[bool, str, int]:
    """
    Analyze a cell for congestion using multiple indicators.
    Returns: (is_congested, root_cause, severity_score)
    
    Severity scale: 0 (none) to 100 (critical)
    """
    load = row.get('ft_physical_resource_blocks_load_dl')
    throughput = row.get('ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_')
    traffic = row.get('l_traffic_activeuser_dl_avg', 0)
    cqi = row.get('ft_4g_lte_average_reported_cqi')
    
    severity = 0
    issues = []
    
    # Check PRB Load
    if pd.notna(load):
        if load >= CONFIG['LOAD_CRITICAL']:
            severity += 40
            issues.append("Critical PRB Load")
        elif load >= CONFIG['LOAD_HIGH']:
            severity += 25
            issues.append("High PRB Load")
    
    # Check Throughput (only if there's traffic)
    if pd.notna(throughput) and pd.notna(traffic) and traffic > 1:
        if throughput < CONFIG['THROUGHPUT_MIN']:
            severity += 30
            issues.append("Low Throughput")
    
    # Check CQI (signal quality)
    if pd.notna(cqi):
        if cqi < CONFIG['CQI_MIN']:
            severity += 20
            issues.append("Poor Signal Quality")
    
    # High traffic amplifies other issues
    if pd.notna(traffic) and traffic >= CONFIG['TRAFFIC_HIGH']:
        severity = min(100, int(severity * 1.2))
        if traffic >= 10:
            issues.append("Heavy Traffic")
    
    # Determine congestion status
    is_congested = severity >= 40
    root_cause = " + ".join(issues) if issues else "Normal"
    
    return is_congested, root_cause, min(100, severity)


def calculate_statistics(df: pd.DataFrame) -> Dict:
    """Calculate network-wide statistics."""
    stats = {
        'total_cells': len(df),
        'congested_cells': df['congested'].sum() if 'congested' in df.columns else 0,
        'avg_load': df['ft_physical_resource_blocks_load_dl'].mean(),
        'max_load': df['ft_physical_resource_blocks_load_dl'].max(),
        'avg_throughput': df['ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_'].mean(),
        'avg_cqi': df['ft_4g_lte_average_reported_cqi'].mean(),
        'data_completeness': (df['ft_physical_resource_blocks_load_dl'].notna().sum() / len(df)) * 100,
        'unique_sites': df['enodeb_name'].nunique() if 'enodeb_name' in df.columns else 0,
        'frequency_bands': df['frequency_band'].dropna().unique().tolist() if 'frequency_band' in df.columns else []
    }
    
    return stats


def process_network_data(input_files: List[str], output_path: str = 'data.json') -> Dict:
    """
    Main processing pipeline for network data.
    """
    print("\n" + "="*60)
    print("  NetVision Digital Twin - Data Processing Engine")
    print("="*60 + "\n")
    
    # Step 1: Load data
    print("📂 Loading data files...")
    df = load_data(input_files)
    
    # Step 2: Clean data
    print("\n🧹 Cleaning and normalizing data...")
    df = clean_data(df)
    
    # Step 3: Analyze congestion
    print("\n🔍 Analyzing network congestion...")
    congestion_results = df.apply(analyze_congestion, axis=1)
    df['congested'] = congestion_results.apply(lambda x: x[0])
    df['root_cause'] = congestion_results.apply(lambda x: x[1])
    df['severity'] = congestion_results.apply(lambda x: x[2])
    
    congested_count = df['congested'].sum()
    print(f"  → Found {congested_count} congested cells ({congested_count/len(df)*100:.1f}%)")
    
    # Step 4: Calculate statistics
    print("\n📊 Calculating network statistics...")
    stats = calculate_statistics(df)
    
    # Step 5: Prepare output
    print("\n💾 Preparing output data...")
    records = []
    for _, row in df.iterrows():
        record = row.to_dict()
        
        # Handle NaN values for JSON
        for key, value in record.items():
            if pd.isna(value):
                record[key] = None
        
        records.append(record)
    
    # Save to JSON
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, indent=2, ensure_ascii=False, default=str)
    
    print(f"  ✓ Saved {len(records)} records to {output_path}")
    
    # Print summary
    print("\n" + "-"*60)
    print("  PROCESSING SUMMARY")
    print("-"*60)
    print(f"  Total Cells:        {stats['total_cells']}")
    print(f"  Unique Sites:       {stats['unique_sites']}")
    print(f"  Congested Cells:    {stats['congested_cells']} ({stats['congested_cells']/stats['total_cells']*100:.1f}%)")
    print(f"  Avg PRB Load:       {stats['avg_load']:.1f}%")
    print(f"  Avg Throughput:     {stats['avg_throughput']/1000:.2f} Mbps")
    print(f"  Avg CQI:            {stats['avg_cqi']:.1f}")
    print(f"  Data Completeness:  {stats['data_completeness']:.1f}%")
    print(f"  Frequency Bands:    {sorted(stats['frequency_bands'])}")
    print("-"*60 + "\n")
    
    return stats


if __name__ == "__main__":
    # Input files
    input_files = [
        'public_data_set_radio_1_page1.csv',
        'public_data_set_radio_all_hour_page1.csv'
    ]
    
    # Run processing
    try:
        stats = process_network_data(input_files, 'data.json')
    except Exception as e:
        print(f"\n❌ Error during processing: {e}")
        raise
