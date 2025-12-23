#!/usr/bin/env python3
"""
Network Traffic Forecasting Pipeline
Predicts network congestion and traffic for the next 6 days using XGBoost.
Outputs JSON files compatible with the NetVision dashboard time_data format.

REQUIREMENT: XGBoost is MANDATORY for this pipeline.
"""

import os
import sys
import json
import argparse
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

# XGBoost is MANDATORY - fail if not available
try:
    import xgboost as xgb
    from sklearn.model_selection import train_test_split, TimeSeriesSplit
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
    from sklearn.preprocessing import PowerTransformer
    HAS_XGBOOST = True
except ImportError:
    print("ERROR: XGBoost is REQUIRED for this forecasting pipeline.")
    print("Please install it with: pip install xgboost scikit-learn")
    sys.exit(1)

# Configuration
FORECAST_DAYS = 6
HOURS_PER_DAY = 24
TARGET_METRICS = ['load', 'throughput', 'cqi', 'traffic', 'active_users']

# Orange DRS congestion thresholds
CONGESTION_THRESHOLDS = {
    'prb_saturated': 80,       # PRB >= 80% = Saturé (adjusted to match historical pattern)
    'prb_high': 70,            # PRB >= 70% + low throughput
    'throughput_low': 8000,    # < 8 Mbps = dégradé
    'users_high': 4            # > 4 active users
}

# Ensure float conversion is safe
def safe_float(val, default=0.0):
    """Safely convert value to float, handling None and NaN."""
    if val is None:
        return default
    try:
        result = float(val)
        if np.isnan(result) or np.isinf(result):
            return default
        return result
    except (ValueError, TypeError):
        return default


def load_historical_data(base_dir: Path):
    """Load historical data from time_data JSON files."""
    
    # Load from time_data JSON files (primary source)
    time_data_dir = base_dir / 'public' / 'time_data'
    if not time_data_dir.exists():
        time_data_dir = base_dir / 'time_data'
    
    if time_data_dir.exists():
        print(f"Loading historical data from {time_data_dir}")
        all_data = []
        
        json_files = sorted(time_data_dir.glob('*.json'))
        print(f"  Found {len(json_files)} time data files")
        
        for json_file in json_files:
            try:
                with open(json_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    
                # Parse timestamp from filename (DD-MM-YYYY_HH-MM.json)
                fname = json_file.stem
                try:
                    dt = datetime.strptime(fname, '%d-%m-%Y_%H-%M')
                except:
                    continue
                
                # Extract cell observations
                observations = data.get('observations', data)
                for cell_name, obs in observations.items():
                    if not isinstance(obs, dict):
                        continue
                    row = {
                        'datetime': dt,
                        'cell_name': cell_name,
                        'load': safe_float(obs.get('load'), None),
                        'cqi': safe_float(obs.get('cqi'), None),
                        'throughput': safe_float(obs.get('throughput'), None),
                        'traffic': safe_float(obs.get('traffic'), 0),
                        'ta': safe_float(obs.get('ta'), None),
                        'signal_power': safe_float(obs.get('signal_power'), 170),
                        'active_users': safe_float(obs.get('active_users'), 0),
                        'congested': bool(obs.get('congested', False)),
                        'severity': safe_float(obs.get('severity'), 0),
                        'issue_type': obs.get('issue_type', 'Normal'),
                        'health_score': safe_float(obs.get('health_score'), 100)
                    }
                    all_data.append(row)
            except Exception as e:
                print(f"  Warning: Could not load {json_file.name}: {e}")
        
        if all_data:
            df = pd.DataFrame(all_data)
            print(f"  Loaded {len(df):,} historical records from {len(json_files)} files")
            return df
    
    print("No historical data found")
    return None


def create_time_features(df: pd.DataFrame) -> pd.DataFrame:
    """Create time-based features for forecasting - BASIC features only."""
    df = df.copy()
    
    if 'datetime' not in df.columns:
        return df
    
    df['hour'] = df['datetime'].dt.hour
    df['dayofweek'] = df['datetime'].dt.dayofweek
    df['month'] = df['datetime'].dt.month
    df['is_weekend'] = (df['dayofweek'] >= 5).astype(int)
    df['is_peak_hour'] = df['hour'].isin([8, 9, 10, 11, 12, 18, 19, 20, 21]).astype(int)
    df['is_night'] = df['hour'].isin([0, 1, 2, 3, 4, 5]).astype(int)
    
    # Cyclical encoding
    df['hour_sin'] = np.sin(2 * np.pi * df['hour'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour'] / 24)
    df['dow_sin'] = np.sin(2 * np.pi * df['dayofweek'] / 7)
    df['dow_cos'] = np.cos(2 * np.pi * df['dayofweek'] / 7)
    
    return df


def create_advanced_features(df: pd.DataFrame, target_col: str = 'load') -> pd.DataFrame:
    """
    Create advanced features including lags and rolling statistics.
    Matches the reference XGBoost implementation.
    """
    df = df.copy()
    
    # Basic time features
    df = create_time_features(df)
    
    # Ensure sorted by datetime
    df = df.sort_values('datetime').reset_index(drop=True)
    
    # ============================================
    # LAG FEATURES (Historical values)
    # ============================================
    df['lag_1'] = df[target_col].shift(1)         # 1 hour ago
    df['lag_2'] = df[target_col].shift(2)         # 2 hours ago
    df['lag_3'] = df[target_col].shift(3)         # 3 hours ago
    df['lag_24'] = df[target_col].shift(24)       # Same time yesterday
    df['lag_48'] = df[target_col].shift(48)       # Same time 2 days ago
    df['lag_168'] = df[target_col].shift(168)     # Same time last week
    
    # ============================================
    # ROLLING STATISTICS (Trends)
    # ============================================
    # 24-hour rolling stats (shifted by 1 to avoid data leakage)
    df['rolling_mean_24'] = df[target_col].shift(1).rolling(window=24, min_periods=1).mean()
    df['rolling_std_24'] = df[target_col].shift(1).rolling(window=24, min_periods=1).std()
    df['rolling_max_24'] = df[target_col].shift(1).rolling(window=24, min_periods=1).max()
    df['rolling_min_24'] = df[target_col].shift(1).rolling(window=24, min_periods=1).min()
    df['rolling_median_24'] = df[target_col].shift(1).rolling(window=24, min_periods=1).median()
    
    # 168-hour (1 week) rolling stats
    df['rolling_mean_168'] = df[target_col].shift(1).rolling(window=168, min_periods=24).mean()
    df['rolling_std_168'] = df[target_col].shift(1).rolling(window=168, min_periods=24).std()
    
    # ============================================
    # DERIVED FEATURES (Interactions)
    # ============================================
    # Change from previous hour
    df['change_1h'] = df[target_col] - df[target_col].shift(1)
    df['change_24h'] = df[target_col] - df[target_col].shift(24)
    
    # Percentage change
    df['pct_change_1h'] = df[target_col].pct_change(1)
    df['pct_change_24h'] = df[target_col].pct_change(24)
    
    # Replace inf/-inf with NaN, then fill
    df = df.replace([np.inf, -np.inf], np.nan)
    
    return df


def compute_hourly_patterns(df: pd.DataFrame) -> dict:
    """Compute average patterns by hour and day of week."""
    patterns = {}
    
    if df is None or len(df) == 0:
        return patterns
    
    # Filter to only rows with valid load values
    df_valid = df[df['load'].notna() & (df['load'] > 0)]
    
    if len(df_valid) == 0:
        return patterns
    
    if 'load' in df_valid.columns:
        # Average load by hour
        hourly_load = df_valid.groupby('hour')['load'].agg(['mean', 'std']).fillna(0).to_dict('index')
        patterns['hourly_load'] = hourly_load
        
        # Average load by day of week
        dow_load = df_valid.groupby('dayofweek')['load'].agg(['mean', 'std']).fillna(0).to_dict('index')
        patterns['dow_load'] = dow_load
    
    if 'cqi' in df_valid.columns:
        df_cqi = df_valid[df_valid['cqi'].notna()]
        if len(df_cqi) > 0:
            hourly_cqi = df_cqi.groupby('hour')['cqi'].agg(['mean', 'std']).fillna(0).to_dict('index')
            patterns['hourly_cqi'] = hourly_cqi
    
    if 'throughput' in df_valid.columns:
        df_thp = df_valid[df_valid['throughput'].notna()]
        if len(df_thp) > 0:
            hourly_thp = df_thp.groupby('hour')['throughput'].agg(['mean', 'std']).fillna(0).to_dict('index')
            patterns['hourly_throughput'] = hourly_thp
    
    if 'traffic' in df_valid.columns:
        df_trf = df_valid[df_valid['traffic'].notna()]
        if len(df_trf) > 0:
            hourly_traffic = df_trf.groupby('hour')['traffic'].agg(['mean', 'std']).fillna(0).to_dict('index')
            patterns['hourly_traffic'] = hourly_traffic
    
    return patterns


def compute_cell_baselines(df: pd.DataFrame) -> dict:
    """Compute baseline statistics per cell from historical data."""
    baselines = {}
    
    if df is None or 'cell_name' not in df.columns:
        return baselines
    
    for cell_name, group in df.groupby('cell_name'):
        # Filter to valid observations only
        valid_obs = group[group['load'].notna()]
        
        if len(valid_obs) == 0:
            # Cell has no valid observations - use defaults
            baselines[cell_name] = {
                'load_mean': 50,
                'load_std': 15,
                'cqi_mean': 10,
                'cqi_std': 2,
                'throughput_mean': 15000,
                'throughput_std': 8000,
                'traffic_mean': 1.0,
                'ta_mean': 2.0,
                'signal_power': 170,
                'congestion_rate': 0.1,
                'has_data': False
            }
            continue
            
        baselines[cell_name] = {
            'load_mean': safe_float(valid_obs['load'].mean(), 50),
            'load_std': safe_float(valid_obs['load'].std(), 15),
            'cqi_mean': safe_float(valid_obs['cqi'].mean(), 10) if 'cqi' in valid_obs else 10,
            'cqi_std': safe_float(valid_obs['cqi'].std(), 2) if 'cqi' in valid_obs else 2,
            'throughput_mean': safe_float(valid_obs['throughput'].mean(), 15000) if 'throughput' in valid_obs else 15000,
            'throughput_std': safe_float(valid_obs['throughput'].std(), 8000) if 'throughput' in valid_obs else 8000,
            'traffic_mean': safe_float(valid_obs['traffic'].mean(), 1.0) if 'traffic' in valid_obs else 1.0,
            'ta_mean': safe_float(valid_obs['ta'].mean(), 2.0) if 'ta' in valid_obs else 2.0,
            'signal_power': safe_float(valid_obs['signal_power'].iloc[0], 170) if 'signal_power' in valid_obs else 170,
            'congestion_rate': safe_float(valid_obs['congested'].mean(), 0.1) if 'congested' in valid_obs else 0.1,
            'has_data': True
        }
    
    return baselines


def predict_cell_metrics(cell_baseline: dict, hour: int, dow: int, patterns: dict, 
                         trend_factor: float = 1.0, day_offset: int = 0) -> dict:
    """Predict metrics for a single cell at a specific time using patterns from historical data."""
    
    # Get hourly pattern multipliers
    hour_load_mult = 1.0
    if 'hourly_load' in patterns and hour in patterns['hourly_load']:
        global_mean = np.mean([p['mean'] for p in patterns['hourly_load'].values() if p['mean'] > 0])
        if global_mean > 0:
            hour_load_mult = patterns['hourly_load'][hour]['mean'] / global_mean
    
    # Day of week adjustment
    dow_mult = 1.0
    if 'dow_load' in patterns and dow in patterns['dow_load']:
        global_mean = np.mean([p['mean'] for p in patterns['dow_load'].values() if p['mean'] > 0])
        if global_mean > 0:
            dow_mult = patterns['dow_load'][dow]['mean'] / global_mean
    
    # Peak hour boost (morning 8-12, evening 18-21)
    is_peak = hour in [8, 9, 10, 11, 12, 18, 19, 20, 21]
    peak_boost = 1.15 if is_peak else 1.0
    
    # Night reduction (00:00 - 06:00)
    is_night = hour in [0, 1, 2, 3, 4, 5, 6]
    night_factor = 0.6 if is_night else 1.0
    
    # Weekend reduction
    is_weekend = dow >= 5
    weekend_factor = 0.85 if is_weekend else 1.0
    
    # Combined multiplier with some bounded randomness
    multiplier = hour_load_mult * dow_mult * peak_boost * night_factor * weekend_factor * trend_factor
    multiplier = max(0.3, min(2.0, multiplier))  # Bound the multiplier
    
    # Predict load with controlled randomness
    base_load = cell_baseline.get('load_mean', 50)
    load_std = cell_baseline.get('load_std', 15)
    noise = np.random.normal(0, min(load_std * 0.2, 5))  # Limited noise
    predicted_load = base_load * multiplier + noise
    predicted_load = np.clip(predicted_load, 0, 100)
    
    # Predict CQI (inverse relationship with load - higher load = lower CQI)
    base_cqi = cell_baseline.get('cqi_mean', 10)
    cqi_std = cell_baseline.get('cqi_std', 2)
    load_impact = (predicted_load - 50) / 100  # -0.5 to 0.5 range
    cqi_noise = np.random.normal(0, min(cqi_std * 0.15, 0.5))
    predicted_cqi = base_cqi - load_impact * 2.5 + cqi_noise
    predicted_cqi = np.clip(predicted_cqi, 1, 15)
    
    # Predict throughput (inverse relationship with load)
    base_thp = cell_baseline.get('throughput_mean', 15000)
    thp_std = cell_baseline.get('throughput_std', 8000)
    thp_factor = 1.0 - (predicted_load / 100) * 0.6  # Higher load = lower throughput
    thp_noise = np.random.normal(0, min(thp_std * 0.1, 2000))
    predicted_thp = base_thp * thp_factor + thp_noise
    predicted_thp = max(1000, min(150000, predicted_thp))
    
    # Predict traffic (correlated with load)
    base_traffic = cell_baseline.get('traffic_mean', 1.0)
    predicted_traffic = base_traffic * multiplier * (0.9 + np.random.random() * 0.2)
    predicted_traffic = max(0, predicted_traffic)
    
    # Timing Advance (relatively stable with small variation)
    base_ta = cell_baseline.get('ta_mean', 2.0)
    predicted_ta = base_ta * (0.95 + np.random.random() * 0.1)
    predicted_ta = max(0.5, min(10, predicted_ta))
    
    # Signal power (stable per cell)
    signal_power = cell_baseline.get('signal_power', 170)
    
    # Determine congestion status using Orange DRS thresholds
    congested = False
    severity = 0
    issue_type = 'Normal'
    root_cause = 'Normal'
    health_score = 100
    
    if predicted_load >= CONGESTION_THRESHOLDS['prb_saturated']:
        congested = True
        severity = 40
        issue_type = 'Capacity Issue'
        root_cause = 'High Resource Utilization'
        health_score = 60
    elif predicted_load >= CONGESTION_THRESHOLDS['prb_high']:
        if predicted_thp < CONGESTION_THRESHOLDS['throughput_low']:
            congested = True
            severity = 30
            issue_type = 'Throughput Degradation'
            root_cause = 'High Load + Low Throughput'
            health_score = 70
        else:
            severity = 10
            health_score = 90
    elif predicted_cqi < 7:
        severity = 15
        issue_type = 'Quality Issue'
        root_cause = 'Poor Signal Quality'
        health_score = 85
    
    # Confidence decreases with forecast horizon
    base_confidence = 0.90 - (day_offset * 0.03)
    base_confidence = max(0.60, base_confidence)
    
    return {
        'load': round(predicted_load, 4),
        'throughput': round(predicted_thp, 4),
        'cqi': round(predicted_cqi, 4),
        'traffic': round(predicted_traffic, 4),
        'ta': round(predicted_ta, 4),
        'signal_power': signal_power,
        'congested': congested,
        'severity': severity,
        'issue_type': issue_type,
        'root_cause': root_cause,
        'health_score': health_score,
        'confidence': round(base_confidence, 2),
        'is_forecast': True
    }


def generate_forecast(base_dir: Path, start_date: datetime = None, days: int = FORECAST_DAYS) -> list:
    """Generate forecast for the next N days using XGBoost or statistical patterns."""
    
    print(f"\n{'='*60}")
    print(f"  NETWORK FORECAST GENERATOR")
    print(f"  Forecast Period: {days} days ({days * 24} hours)")
    print(f"  XGBoost Available: {HAS_XGBOOST}")
    print(f"{'='*60}\n")
    
    # Load historical data
    df = load_historical_data(base_dir)
    
    if df is None or len(df) == 0:
        print("No historical data available, using default patterns")
        df = pd.DataFrame()
    else:
        print(f"Loaded {len(df):,} historical records")
        df = create_time_features(df)
    
    # Load baseline.json for cell list and positions
    baseline_path = base_dir / 'public' / 'baseline.json'
    if not baseline_path.exists():
        baseline_path = base_dir / 'baseline.json'
        
    baseline_data = {}
    if baseline_path.exists():
        with open(baseline_path, 'r', encoding='utf-8') as f:
            baseline_data = json.load(f)
        cell_names = list(baseline_data.keys())
        print(f"Found {len(cell_names)} cells in baseline")
    else:
        cell_names = df['cell_name'].unique().tolist() if len(df) > 0 and 'cell_name' in df.columns else []
        print(f"Found {len(cell_names)} cells in historical data")
    
    if not cell_names:
        print("ERROR: No cells found")
        return []
    
    # Compute patterns from historical data
    patterns = compute_hourly_patterns(df) if len(df) > 0 else {}
    cell_baselines = compute_cell_baselines(df) if len(df) > 0 else {}
    
    print(f"Computed patterns for {len(patterns)} metrics")
    print(f"Computed baselines for {len(cell_baselines)} cells")
    
    # Default baseline for cells without history
    default_baseline = {
        'load_mean': 50,
        'load_std': 15,
        'cqi_mean': 10,
        'cqi_std': 2,
        'throughput_mean': 15000,
        'throughput_std': 8000,
        'traffic_mean': 1.0,
        'ta_mean': 2.0,
        'signal_power': 170,
        'congestion_rate': 0.1,
        'has_data': False
    }
    
    # XGBoost is MANDATORY - train models
    print("\n--- Training XGBoost Models (MANDATORY) ---")
    if len(df) < 100:
        print("ERROR: Not enough historical data to train XGBoost models")
        print(f"  Required: at least 100 records, Found: {len(df)}")
        sys.exit(1)
    
    xgb_model = train_xgboost_model(df)
    
    if xgb_model is None:
        print("ERROR: XGBoost model training failed - this is mandatory")
        sys.exit(1)
    
    print("--- XGBoost Models Ready ---\n")
    
    # Determine start date
    if start_date is None:
        if len(df) > 0 and 'datetime' in df.columns:
            last_date = df['datetime'].max()
            start_date = last_date + timedelta(hours=1)
        else:
            start_date = datetime.now().replace(minute=0, second=0, microsecond=0)
    
    print(f"Forecast start: {start_date.strftime('%d-%m-%Y %H:%M')}")
    print(f"Forecast end: {(start_date + timedelta(days=days) - timedelta(hours=1)).strftime('%d-%m-%Y %H:%M')}")
    
    # Initialize forecast state for recursive predictions
    # Use the recent history from training as initial state
    recent_history = xgb_model.get('recent_history', None)
    if recent_history is not None:
        initial_loads = recent_history['load'].tolist()
    else:
        initial_loads = []
    
    # Forecast state maintains running history for lag features
    forecast_state = {
        'recent_loads': initial_loads.copy()
    }
    
    # Generate forecasts using XGBoost
    forecasts = []
    total_hours = days * HOURS_PER_DAY
    
    for hour_offset in range(total_hours):
        forecast_time = start_date + timedelta(hours=hour_offset)
        hour = forecast_time.hour
        dow = forecast_time.weekday()
        day_offset = hour_offset // 24
        
        # Trend factor: slight increase over time (network growth)
        trend_factor = 1.0 + (day_offset * 0.01)  # 1% increase per day
        
        observations = {}
        congested_count = 0
        total_load = 0
        total_cqi = 0
        total_throughput = 0
        total_health = 0
        valid_count = 0
        
        # Collect predictions for this hour to update state
        hour_predictions = []
        
        for cell_name in cell_names:
            cell_baseline = cell_baselines.get(cell_name, default_baseline)
            
            # Always use XGBoost prediction when model is available
            if xgb_model is not None:
                metrics = predict_with_xgboost(xgb_model, cell_baseline, hour, dow, day_offset, forecast_state)
                hour_predictions.append(metrics.get('predicted_load_for_state', metrics['load']))
            else:
                # Fallback: Add some cell-specific variation for statistical prediction
                cell_hash = hash(cell_name) % 1000 / 1000
                cell_variation = 0.9 + cell_hash * 0.2
                
                metrics = predict_cell_metrics(
                    cell_baseline, 
                    hour, 
                    dow, 
                    patterns,
                    trend_factor * cell_variation,
                    day_offset
                )
            
            observations[cell_name] = metrics
            
            if metrics['congested']:
                congested_count += 1
            
            # Accumulate for stats
            if metrics['load'] is not None:
                total_load += metrics['load']
                total_cqi += metrics['cqi']
                total_throughput += metrics['throughput']
                total_health += metrics['health_score']
                valid_count += 1
        
        # Calculate summary stats with safe division
        avg_load = round(total_load / valid_count, 2) if valid_count > 0 else 0
        avg_cqi = round(total_cqi / valid_count, 2) if valid_count > 0 else 0
        avg_throughput = round(total_throughput / valid_count, 2) if valid_count > 0 else 0
        avg_health = round(total_health / valid_count, 2) if valid_count > 0 else 100
        
        # Update forecast state with this hour's average load for recursive prediction
        if hour_predictions:
            hour_avg_load = np.mean(hour_predictions)
            forecast_state['recent_loads'].append(hour_avg_load)
            # Keep only last 200 values to prevent memory growth
            if len(forecast_state['recent_loads']) > 200:
                forecast_state['recent_loads'] = forecast_state['recent_loads'][-200:]
        
        # Find max load
        loads = [obs['load'] for obs in observations.values() if obs['load'] is not None]
        max_load = round(max(loads), 2) if loads else 0
        
        # Confidence based on day offset
        confidence = round(0.90 - (day_offset * 0.03), 2)
        confidence = max(0.60, confidence)
        
        forecast_entry = {
            'filename': forecast_time.strftime('%d-%m-%Y_%H-%M.json'),
            'timestamp': forecast_time.strftime('%d-%m-%Y %H:%M'),
            'datetime_iso': forecast_time.isoformat(),
            'is_forecast': True,
            'confidence': confidence,
            'observations': observations,
            'stats': {
                'cells_observed': len(observations),
                'total_cells': len(observations),
                'congested': congested_count,
                'congestion_rate': round(congested_count / len(observations) * 100, 2) if observations else 0,
                'avg_load': avg_load,
                'max_load': max_load,
                'avg_throughput': avg_throughput,
                'avg_cqi': avg_cqi,
                'avg_health': avg_health
            }
        }
        
        forecasts.append(forecast_entry)
        
        if hour_offset % 24 == 0:
            print(f"  Day {day_offset + 1}: {congested_count} congested cells ({forecast_entry['stats']['congestion_rate']:.1f}%), avg load: {avg_load:.1f}%")
    
    print(f"\nGenerated {len(forecasts)} hourly forecasts")
    
    return forecasts


def train_xgboost_model(df: pd.DataFrame):
    """
    Train XGBoost models for load, CQI, and throughput prediction.
    Uses lag features, rolling statistics, and PowerTransformer as per reference implementation.
    """
    
    try:
        print("  Preparing data with advanced features...")
        
        # Aggregate data by datetime (average across all cells per hour)
        # This gives us a clean time series for training
        df_agg = df.groupby('datetime').agg({
            'load': 'mean',
            'cqi': 'mean',
            'throughput': 'mean',
            'traffic': 'mean'
        }).reset_index()
        
        df_agg = df_agg.sort_values('datetime').reset_index(drop=True)
        
        # Create advanced features including lags and rolling stats
        df_agg = create_advanced_features(df_agg, target_col='load')
        
        # Drop rows with NaN from lag features (first ~168 hours)
        df_agg = df_agg.dropna(subset=['lag_1', 'lag_24', 'rolling_mean_24'])
        
        if len(df_agg) < 100:
            print(f"  ERROR: Not enough data after feature engineering (need 100, got {len(df_agg)})")
            sys.exit(1)
        
        print(f"  Training data: {len(df_agg)} hourly observations")
        
        # Feature columns - INCLUDING lags and rolling stats
        feature_cols = [
            'hour', 'dayofweek', 'is_weekend', 'is_peak_hour', 'is_night',
            'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos',
            'lag_1', 'lag_2', 'lag_3', 'lag_24', 'lag_48', 'lag_168',
            'rolling_mean_24', 'rolling_std_24', 'rolling_max_24', 'rolling_min_24',
            'rolling_mean_168', 'rolling_std_168',
            'change_1h', 'change_24h'
        ]
        
        # Filter to available columns and fill NaN
        feature_cols = [c for c in feature_cols if c in df_agg.columns]
        df_agg[feature_cols] = df_agg[feature_cols].fillna(0)
        
        print(f"  Using {len(feature_cols)} features including lags and rolling stats")
        
        X = df_agg[feature_cols].values
        models = {}
        transformers = {}
        
        # ============================================
        # Train Load Model with PowerTransformer
        # ============================================
        y_load = df_agg['load'].values
        
        # Apply PowerTransformer (Yeo-Johnson) as per reference
        pt_load = PowerTransformer(method='yeo-johnson')
        y_load_transformed = pt_load.fit_transform(y_load.reshape(-1, 1)).ravel()
        transformers['load'] = pt_load
        
        # Use Time Series Split (5 folds) as per reference
        print("  Performing Time Series Cross-Validation...")
        tscv = TimeSeriesSplit(n_splits=5)
        cv_scores = []
        
        for fold, (train_idx, val_idx) in enumerate(tscv.split(X), 1):
            X_cv_train, X_cv_val = X[train_idx], X[val_idx]
            y_cv_train, y_cv_val = y_load_transformed[train_idx], y_load_transformed[val_idx]
            
            model_cv = xgb.XGBRegressor(
                n_estimators=300,
                max_depth=7,
                learning_rate=0.05,
                min_child_weight=3,
                subsample=0.8,
                colsample_bytree=0.8,
                gamma=0.1,
                reg_alpha=0.01,
                reg_lambda=1.0,
                objective='reg:squarederror',
                random_state=42,
                verbosity=0,
                n_jobs=-1
            )
            model_cv.fit(X_cv_train, y_cv_train)
            y_cv_pred = model_cv.predict(X_cv_val)
            
            # Inverse transform for MAE calculation
            y_val_orig = pt_load.inverse_transform(y_cv_val.reshape(-1, 1)).ravel()
            y_pred_orig = pt_load.inverse_transform(y_cv_pred.reshape(-1, 1)).ravel()
            
            mae = mean_absolute_error(y_val_orig, y_pred_orig)
            r2 = r2_score(y_val_orig, y_pred_orig)
            cv_scores.append({'mae': mae, 'r2': r2})
        
        avg_mae = np.mean([s['mae'] for s in cv_scores])
        avg_r2 = np.mean([s['r2'] for s in cv_scores])
        print(f"  CV Results - MAE: {avg_mae:.2f}, R²: {avg_r2:.4f}")
        
        # Train final model on all data
        split_idx = int(len(X) * 0.85)
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y_load_transformed[:split_idx], y_load_transformed[split_idx:]
        
        load_model = xgb.XGBRegressor(
            n_estimators=500,
            max_depth=7,
            learning_rate=0.03,
            min_child_weight=3,
            subsample=0.8,
            colsample_bytree=0.8,
            gamma=0.1,
            reg_alpha=0.01,
            reg_lambda=1.0,
            early_stopping_rounds=50,
            objective='reg:squarederror',
            random_state=42,
            verbosity=0,
            n_jobs=-1
        )
        load_model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)
        
        y_pred = load_model.predict(X_test)
        y_test_orig = pt_load.inverse_transform(y_test.reshape(-1, 1)).ravel()
        y_pred_orig = pt_load.inverse_transform(y_pred.reshape(-1, 1)).ravel()
        
        load_mae = mean_absolute_error(y_test_orig, y_pred_orig)
        load_rmse = np.sqrt(mean_squared_error(y_test_orig, y_pred_orig))
        load_r2 = r2_score(y_test_orig, y_pred_orig)
        models['load'] = load_model
        
        print(f"  XGBoost Load Model: MAE={load_mae:.2f}, RMSE={load_rmse:.2f}, R²={load_r2:.4f}")
        
        # ============================================
        # Train CQI Model
        # ============================================
        if 'cqi' in df_agg.columns and df_agg['cqi'].notna().sum() >= 100:
            y_cqi = df_agg['cqi'].fillna(10).values
            pt_cqi = PowerTransformer(method='yeo-johnson')
            y_cqi_transformed = pt_cqi.fit_transform(y_cqi.reshape(-1, 1)).ravel()
            transformers['cqi'] = pt_cqi
            
            y_train_cqi, y_test_cqi = y_cqi_transformed[:split_idx], y_cqi_transformed[split_idx:]
            
            cqi_model = xgb.XGBRegressor(
                n_estimators=300,
                max_depth=6,
                learning_rate=0.05,
                objective='reg:squarederror',
                random_state=42,
                verbosity=0,
                n_jobs=-1
            )
            cqi_model.fit(X_train, y_train_cqi)
            
            y_pred_cqi = cqi_model.predict(X_test)
            y_pred_cqi_orig = pt_cqi.inverse_transform(y_pred_cqi.reshape(-1, 1)).ravel()
            y_test_cqi_orig = pt_cqi.inverse_transform(y_test_cqi.reshape(-1, 1)).ravel()
            
            cqi_mae = mean_absolute_error(y_test_cqi_orig, y_pred_cqi_orig)
            models['cqi'] = cqi_model
            print(f"  XGBoost CQI Model: MAE={cqi_mae:.2f}")
        
        # ============================================
        # Train Throughput Model
        # ============================================
        if 'throughput' in df_agg.columns and df_agg['throughput'].notna().sum() >= 100:
            y_thp = df_agg['throughput'].fillna(15000).values
            pt_thp = PowerTransformer(method='yeo-johnson')
            y_thp_transformed = pt_thp.fit_transform(y_thp.reshape(-1, 1)).ravel()
            transformers['throughput'] = pt_thp
            
            y_train_thp, y_test_thp = y_thp_transformed[:split_idx], y_thp_transformed[split_idx:]
            
            thp_model = xgb.XGBRegressor(
                n_estimators=300,
                max_depth=6,
                learning_rate=0.05,
                objective='reg:squarederror',
                random_state=42,
                verbosity=0,
                n_jobs=-1
            )
            thp_model.fit(X_train, y_train_thp)
            
            y_pred_thp = thp_model.predict(X_test)
            y_pred_thp_orig = pt_thp.inverse_transform(y_pred_thp.reshape(-1, 1)).ravel()
            y_test_thp_orig = pt_thp.inverse_transform(y_test_thp.reshape(-1, 1)).ravel()
            
            thp_mae = mean_absolute_error(y_test_thp_orig, y_pred_thp_orig)
            models['throughput'] = thp_model
            print(f"  XGBoost Throughput Model: MAE={thp_mae:.2f}")
        
        # Store global stats and recent history for prediction
        recent_history = df_agg.tail(168).copy()  # Last week of hourly data
        
        global_stats = {
            'load_mean': df_agg['load'].mean(),
            'load_std': df_agg['load'].std(),
            'cqi_mean': df_agg['cqi'].mean() if 'cqi' in df_agg else 10,
            'throughput_mean': df_agg['throughput'].mean() if 'throughput' in df_agg else 15000
        }
        
        return {
            'models': models,
            'transformers': transformers,
            'feature_cols': feature_cols,
            'global_stats': global_stats,
            'recent_history': recent_history
        }
        
    except Exception as e:
        print(f"  ERROR: XGBoost training failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


def predict_with_xgboost(xgb_data: dict, cell_baseline: dict, hour: int, dow: int, day_offset: int,
                         forecast_state: dict = None) -> dict:
    """
    Use XGBoost models for prediction using lag features and rolling statistics.
    forecast_state: Contains recent predictions for recursive forecasting.
    """
    
    is_weekend = 1 if dow >= 5 else 0
    is_peak = 1 if hour in [8, 9, 10, 11, 12, 18, 19, 20, 21] else 0
    is_night = 1 if hour in [0, 1, 2, 3, 4, 5, 6] else 0
    hour_sin = np.sin(2 * np.pi * hour / 24)
    hour_cos = np.cos(2 * np.pi * hour / 24)
    dow_sin = np.sin(2 * np.pi * dow / 7)
    dow_cos = np.cos(2 * np.pi * dow / 7)
    
    models = xgb_data['models']
    transformers = xgb_data.get('transformers', {})
    global_stats = xgb_data['global_stats']
    recent_history = xgb_data.get('recent_history', None)
    feature_cols = xgb_data['feature_cols']
    
    # Get lag values from forecast_state (recursive forecasting) or recent history
    recent_loads = forecast_state.get('recent_loads', []) if forecast_state else []
    
    # If we have recent history from training, use it for initial lags
    if recent_history is not None and len(recent_loads) == 0:
        recent_loads = recent_history['load'].tolist()
    
    # Calculate lag features
    lag_1 = recent_loads[-1] if len(recent_loads) >= 1 else global_stats['load_mean']
    lag_2 = recent_loads[-2] if len(recent_loads) >= 2 else global_stats['load_mean']
    lag_3 = recent_loads[-3] if len(recent_loads) >= 3 else global_stats['load_mean']
    lag_24 = recent_loads[-24] if len(recent_loads) >= 24 else global_stats['load_mean']
    lag_48 = recent_loads[-48] if len(recent_loads) >= 48 else global_stats['load_mean']
    lag_168 = recent_loads[-168] if len(recent_loads) >= 168 else global_stats['load_mean']
    
    # Calculate rolling stats from recent loads
    if len(recent_loads) >= 24:
        last_24 = recent_loads[-24:]
        rolling_mean_24 = np.mean(last_24)
        rolling_std_24 = np.std(last_24) if len(last_24) > 1 else 0
        rolling_max_24 = np.max(last_24)
        rolling_min_24 = np.min(last_24)
    else:
        rolling_mean_24 = global_stats['load_mean']
        rolling_std_24 = global_stats['load_std']
        rolling_max_24 = global_stats['load_mean'] + global_stats['load_std']
        rolling_min_24 = global_stats['load_mean'] - global_stats['load_std']
    
    if len(recent_loads) >= 168:
        last_168 = recent_loads[-168:]
        rolling_mean_168 = np.mean(last_168)
        rolling_std_168 = np.std(last_168) if len(last_168) > 1 else 0
    else:
        rolling_mean_168 = global_stats['load_mean']
        rolling_std_168 = global_stats['load_std']
    
    # Change features
    change_1h = lag_1 - lag_2 if len(recent_loads) >= 2 else 0
    change_24h = lag_1 - lag_24 if len(recent_loads) >= 24 else 0
    
    # Build feature vector
    features = {
        'hour': hour,
        'dayofweek': dow,
        'is_weekend': is_weekend,
        'is_peak_hour': is_peak,
        'is_night': is_night,
        'hour_sin': hour_sin,
        'hour_cos': hour_cos,
        'dow_sin': dow_sin,
        'dow_cos': dow_cos,
        'lag_1': lag_1,
        'lag_2': lag_2,
        'lag_3': lag_3,
        'lag_24': lag_24,
        'lag_48': lag_48,
        'lag_168': lag_168,
        'rolling_mean_24': rolling_mean_24,
        'rolling_std_24': rolling_std_24,
        'rolling_max_24': rolling_max_24,
        'rolling_min_24': rolling_min_24,
        'rolling_mean_168': rolling_mean_168,
        'rolling_std_168': rolling_std_168,
        'change_1h': change_1h,
        'change_24h': change_24h
    }
    
    X = np.array([[features.get(c, 0) for c in feature_cols]])
    
    # Predict Load using XGBoost with PowerTransformer inverse
    y_pred_transformed = models['load'].predict(X)[0]
    
    if 'load' in transformers:
        predicted_load = transformers['load'].inverse_transform([[y_pred_transformed]])[0, 0]
    else:
        predicted_load = y_pred_transformed
    
    # Apply cell-specific adjustment based on historical baseline
    cell_load_mean = cell_baseline.get('load_mean', 50)
    global_load_mean = global_stats.get('load_mean', 50)
    
    # Cell adjustment factor
    if cell_baseline.get('has_data', False) and global_load_mean > 0:
        cell_adjustment = cell_load_mean / global_load_mean
        cell_adjustment = np.clip(cell_adjustment, 0.5, 2.0)
        predicted_load = predicted_load * cell_adjustment
    
    # Small controlled noise for realism
    noise = np.random.normal(0, 1.0)
    predicted_load = np.clip(predicted_load + noise, 0, 100)
    
    # Predict CQI using XGBoost
    if 'cqi' in models:
        y_pred_cqi = models['cqi'].predict(X)[0]
        if 'cqi' in transformers:
            predicted_cqi = transformers['cqi'].inverse_transform([[y_pred_cqi]])[0, 0]
        else:
            predicted_cqi = y_pred_cqi
        
        # Cell-specific adjustment
        cell_cqi_mean = cell_baseline.get('cqi_mean', 10)
        global_cqi_mean = global_stats.get('cqi_mean', 10)
        if cell_baseline.get('has_data', False) and global_cqi_mean > 0:
            cqi_adjustment = cell_cqi_mean / global_cqi_mean
            cqi_adjustment = np.clip(cqi_adjustment, 0.7, 1.3)
            predicted_cqi = predicted_cqi * cqi_adjustment
        predicted_cqi += np.random.normal(0, 0.15)
    else:
        base_cqi = cell_baseline.get('cqi_mean', 10)
        load_impact = (predicted_load - 50) / 100
        predicted_cqi = base_cqi - load_impact * 2.5 + np.random.normal(0, 0.2)
    
    predicted_cqi = np.clip(predicted_cqi, 1, 15)
    
    # Predict Throughput using XGBoost
    if 'throughput' in models:
        y_pred_thp = models['throughput'].predict(X)[0]
        if 'throughput' in transformers:
            predicted_thp = transformers['throughput'].inverse_transform([[y_pred_thp]])[0, 0]
        else:
            predicted_thp = y_pred_thp
        
        # Cell-specific adjustment
        cell_thp_mean = cell_baseline.get('throughput_mean', 15000)
        global_thp_mean = global_stats.get('throughput_mean', 15000)
        if cell_baseline.get('has_data', False) and global_thp_mean > 0:
            thp_adjustment = cell_thp_mean / global_thp_mean
            thp_adjustment = np.clip(thp_adjustment, 0.3, 3.0)
            predicted_thp = predicted_thp * thp_adjustment
        predicted_thp += np.random.normal(0, 300)
    else:
        base_thp = cell_baseline.get('throughput_mean', 15000)
        thp_factor = 1.0 - (predicted_load / 100) * 0.6
        predicted_thp = base_thp * thp_factor + np.random.normal(0, 500)
    
    predicted_thp = max(1000, min(150000, predicted_thp))
    
    # Traffic correlates with load
    base_traffic = cell_baseline.get('traffic_mean', 1.0)
    load_factor = predicted_load / 50 if predicted_load > 0 else 0.5
    predicted_traffic = base_traffic * load_factor * (0.9 + np.random.random() * 0.2)
    predicted_traffic = max(0, predicted_traffic)
    
    # TA is relatively stable
    base_ta = cell_baseline.get('ta_mean', 2.0)
    predicted_ta = base_ta * (0.95 + np.random.random() * 0.1)
    predicted_ta = max(0.5, min(10, predicted_ta))
    
    signal_power = cell_baseline.get('signal_power', 170)
    
    # Determine congestion status
    congested = False
    severity = 0
    issue_type = 'Normal'
    root_cause = 'Normal'
    health_score = 100
    
    if predicted_load >= CONGESTION_THRESHOLDS['prb_saturated']:
        congested = True
        severity = 40
        issue_type = 'Capacity Issue'
        root_cause = 'High Resource Utilization'
        health_score = 60
    elif predicted_load >= CONGESTION_THRESHOLDS['prb_high']:
        if predicted_thp < CONGESTION_THRESHOLDS['throughput_low']:
            congested = True
            severity = 30
            issue_type = 'Throughput Degradation'
            root_cause = 'High Load + Low Throughput'
            health_score = 70
        else:
            severity = 10
            health_score = 90
    elif predicted_cqi < 7:
        severity = 15
        issue_type = 'Quality Issue'
        root_cause = 'Poor Signal Quality'
        health_score = 85
    
    # Confidence decreases with forecast horizon
    confidence = round(0.90 - (day_offset * 0.03), 2)
    confidence = max(0.60, confidence)
    
    return {
        'load': round(predicted_load, 4),
        'throughput': round(predicted_thp, 4),
        'cqi': round(predicted_cqi, 4),
        'traffic': round(predicted_traffic, 4),
        'ta': round(predicted_ta, 4),
        'signal_power': signal_power,
        'congested': congested,
        'severity': severity,
        'issue_type': issue_type,
        'root_cause': root_cause,
        'health_score': health_score,
        'confidence': confidence,
        'is_forecast': True,
        'predicted_load_for_state': predicted_load  # For recursive forecasting
    }


def save_forecasts(forecasts: list, output_dir: Path):
    """Save forecasts to JSON files matching the historical time_data format."""
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Save individual time files
    forecast_data_dir = output_dir / 'forecast_data'
    forecast_data_dir.mkdir(exist_ok=True)
    
    for forecast in forecasts:
        filename = forecast['filename']
        filepath = forecast_data_dir / filename
        
        # Save in the same format as historical time_data files
        output_data = {
            'timestamp': forecast['timestamp'],
            'stats': forecast['stats'],
            'observations': forecast['observations'],
            'is_forecast': True,
            'confidence': forecast['confidence']
        }
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2)
    
    # Save forecast index with all relevant stats
    forecast_index = [{
        'filename': f['filename'],
        'timestamp': f['timestamp'],
        'is_forecast': True,
        'confidence': f['confidence'],
        'stats': f['stats']
    } for f in forecasts]
    
    index_path = output_dir / 'forecast_index.json'
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(forecast_index, f, indent=2)
    
    print(f"\nSaved forecasts to {output_dir}")
    print(f"  - {len(forecasts)} hourly forecast files in forecast_data/")
    print(f"  - forecast_index.json")
    
    # Print sample stats
    if forecasts:
        sample = forecasts[0]
        print(f"\nSample forecast stats (first hour):")
        print(f"  - Cells: {sample['stats']['cells_observed']}")
        print(f"  - Congested: {sample['stats']['congested']}")
        print(f"  - Avg Load: {sample['stats']['avg_load']:.1f}%")
        print(f"  - Avg CQI: {sample['stats']['avg_cqi']:.1f}")
        print(f"  - Confidence: {sample['confidence']}")
    
    return index_path


def main():
    parser = argparse.ArgumentParser(description='Generate network traffic forecasts')
    parser.add_argument('--days', type=int, default=FORECAST_DAYS, help='Number of days to forecast')
    parser.add_argument('--output', type=str, default=None, help='Output directory')
    parser.add_argument('--start-date', type=str, default=None, help='Start date (DD-MM-YYYY)')
    
    args = parser.parse_args()
    
    # Determine base directory
    script_dir = Path(__file__).parent
    base_dir = script_dir.parent
    
    # Parse start date
    start_date = None
    if args.start_date:
        try:
            start_date = datetime.strptime(args.start_date, '%d-%m-%Y')
        except:
            print(f"Warning: Could not parse start date '{args.start_date}', using auto-detect")
    
    # Generate forecasts
    forecasts = generate_forecast(base_dir, start_date, args.days)
    
    if not forecasts:
        print("No forecasts generated")
        sys.exit(1)
    
    # Save forecasts
    output_dir = Path(args.output) if args.output else base_dir / 'public'
    save_forecasts(forecasts, output_dir)
    
    # Output summary for API consumption
    summary = {
        'success': True,
        'forecast_count': len(forecasts),
        'start_date': forecasts[0]['timestamp'] if forecasts else None,
        'end_date': forecasts[-1]['timestamp'] if forecasts else None,
        'days': args.days,
        'total_congestion_events': sum(f['stats']['congested'] for f in forecasts)
    }
    
    print(f"\n{json.dumps(summary)}")


if __name__ == '__main__':
    main()
