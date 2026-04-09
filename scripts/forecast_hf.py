"""
NetVision Forecast Generator - HuggingFace Time Series Edition
--------------------------------------------------------------
Generates network traffic forecasts using pre-trained time series models.
Falls back to statistical methods if HuggingFace is unavailable.

Fixes Windows encoding issues by avoiding emoji characters.
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
import random
import math
import pandas as pd
import duckdb

# Force UTF-8 output on Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Configuration
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR
TIME_DATA_DIR = DATA_DIR / "time_data"
FORECAST_DATA_DIR = DATA_DIR / "forecast_data"
BASELINE_PATH = DATA_DIR / "baseline.json"
TIME_INDEX_PATH = DATA_DIR / "time_index.json"
FORECAST_INDEX_PATH = DATA_DIR / "forecast_index.json"

OBSERVATION_FIELDS = [
    "load",
    "throughput",
    "cqi",
    "traffic",
    "ta",
    "signal_power",
    "congested",
    "severity",
    "issue_type",
    "root_cause",
    "health_score",
    "confidence",
    "is_forecast",
]


def log(msg, level="INFO"):
    """Safe logging without emoji"""
    prefix = {"INFO": "[*]", "OK": "[+]", "ERROR": "[-]", "WARN": "[!]"}
    print(f"{prefix.get(level, '[*]')} {msg}")


def load_json(path):
    """Load JSON file"""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path, data):
    """Save JSON file"""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def normalize_observation_value(key, value):
    """Convert parquet scalar values to JSON-compatible observation values."""
    if pd.isna(value):
        return None
    if key in {"congested", "is_forecast"}:
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes"}
        return bool(value)
    return value


def dataframe_to_observations(df):
    """Convert a parquet dataframe back to the observation object map."""
    observations = {}
    if df.empty:
        return observations

    for row in df.to_dict(orient="records"):
        cell_name = str(row.get("cell_name", "")).strip()
        if not cell_name:
            continue
        observations[cell_name] = {
            field: normalize_observation_value(field, row.get(field))
            for field in OBSERVATION_FIELDS
            if field in row
        }
    return observations


def observations_to_dataframe(observations):
    """Convert observation object map to a parquet-ready dataframe."""
    rows = []
    for cell_name, values in (observations or {}).items():
        row = {"cell_name": cell_name}
        for field in OBSERVATION_FIELDS:
            row[field] = values.get(field)
        rows.append(row)
    return pd.DataFrame.from_records(rows, columns=["cell_name", *OBSERVATION_FIELDS])


def load_observations_file(path):
    """Load observations from parquet (preferred) or legacy JSON slices."""
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        df = read_parquet_dataframe(path)
        return dataframe_to_observations(df)
    if suffix == ".json":
        payload = load_json(path)
        return payload.get("observations", {})
    raise ValueError(f"Unsupported slice format: {path.name}")


def read_parquet_dataframe(path):
    """Read parquet file into dataframe via DuckDB."""
    con = duckdb.connect()
    try:
        escaped_path = str(path).replace("'", "''")
        return con.execute(f"SELECT * FROM read_parquet('{escaped_path}')").fetchdf()
    finally:
        con.close()


def write_parquet_dataframe(df, path):
    """Write dataframe to parquet via DuckDB."""
    con = duckdb.connect()
    try:
        con.register("slice_df", df)
        escaped_path = str(path).replace("'", "''")
        con.execute(f"COPY slice_df TO '{escaped_path}' (FORMAT PARQUET)")
    finally:
        con.close()


def parse_timestamp(ts_str):
    """Parse DD-MM-YYYY HH:MM format"""
    return datetime.strptime(ts_str, "%d-%m-%Y %H:%M")


def format_timestamp(dt):
    """Format to DD-MM-YYYY HH:MM"""
    return dt.strftime("%d-%m-%Y %H:%M")


def format_filename(dt):
    """Format to DD-MM-YYYY_HH-MM.parquet"""
    return dt.strftime("%d-%m-%Y_%H-%M.parquet")


def load_historical_data(limit=168):
    """Load recent historical time slices for training"""
    if not TIME_INDEX_PATH.exists():
        log("time_index.json not found", "ERROR")
        return []
    
    index = load_json(TIME_INDEX_PATH)
    timestamps = index.get("timestamps", [])
    # Ensure chronological order by actual datetime (index metadata can be unsorted)
    timestamps = sorted(
        timestamps,
        key=lambda e: parse_timestamp(e.get("timestamp", "01-01-1970 00:00"))
    )
    
    # Get last N hours of data
    recent = timestamps[-limit:] if len(timestamps) > limit else timestamps
    
    data = []
    for entry in recent:
        filename = entry.get("filename")
        if not filename:
            continue
        filepath = TIME_DATA_DIR / filename
        if filepath.exists():
            try:
                observations = load_observations_file(filepath)
                data.append({
                    "timestamp": entry.get("timestamp"),
                    "stats": entry.get("stats", {}),
                    "observations": observations
                })
            except Exception as e:
                log(f"Failed to load {filename}: {e}", "WARN")
    
    return data


def compute_cell_stats(observations):
    """Compute aggregate stats from observations"""
    loads = []
    throughputs = []
    cqis = []
    healths = []
    congested = 0
    
    for cell_name, obs in observations.items():
        if obs.get("load") is not None:
            loads.append(obs["load"])
        if obs.get("throughput") is not None:
            throughputs.append(obs["throughput"])
        if obs.get("cqi") is not None:
            cqis.append(obs["cqi"])
        if obs.get("health_score") is not None:
            healths.append(obs["health_score"])
        if obs.get("congested"):
            congested += 1
    
    n = len(loads) or 1
    return {
        "cells_observed": len(observations),
        "total_cells": len(observations),
        "congested": congested,
        "congestion_rate": round(congested / len(observations) * 100, 2) if observations else 0,
        "avg_load": round(sum(loads) / n, 2) if loads else 50,
        "max_load": round(max(loads), 2) if loads else 80,
        "avg_throughput": round(sum(throughputs) / len(throughputs), 2) if throughputs else 20000,
        "avg_cqi": round(sum(cqis) / len(cqis), 2) if cqis else 9.5,
        "avg_health": round(sum(healths) / len(healths), 2) if healths else 95
    }


def classify_cell(load, cqi):
    """Classify cell issue based on KPIs"""
    if load is None:
        return "Normal", "Normal", 0, 100
    
    load = float(load)
    cqi = float(cqi) if cqi else 10
    
    if load >= 90 and cqi < 7:
        return "Critical Congestion", "High Resource Utilization", 50, 50
    if load >= 85:
        return "Capacity Issue", "High Resource Utilization", 25, 75
    if load >= 70:
        return "Congestion", "Moderate Load", 10, 90
    if cqi < 5:
        return "Coverage Hole", "Poor Signal Quality", 20, 80
    if cqi < 7:
        return "Quality Degradation", "Low CQI", 10, 90
    return "Normal", "Normal", 0, 100


class TimeSeriesForecaster:
    """
    Simple but effective time series forecaster.
    Uses pattern-based prediction with hourly/daily seasonality.
    """
    
    def __init__(self, historical_data):
        self.historical = historical_data
        self.cell_history = self._build_cell_history()
        self.hourly_patterns = self._compute_hourly_patterns()
        
    def _build_cell_history(self):
        """Build per-cell history from time slices"""
        cell_history = {}
        for slice_data in self.historical:
            ts = slice_data.get("timestamp", "")
            obs = slice_data.get("observations", {})
            for cell_name, cell_obs in obs.items():
                if cell_name not in cell_history:
                    cell_history[cell_name] = []
                cell_history[cell_name].append({
                    "timestamp": ts,
                    **cell_obs
                })
        return cell_history
    
    def _compute_hourly_patterns(self):
        """Compute average metrics by hour of day"""
        hourly = {h: {"loads": [], "throughputs": [], "cqis": []} for h in range(24)}
        
        for slice_data in self.historical:
            ts_str = slice_data.get("timestamp", "")
            try:
                ts = parse_timestamp(ts_str)
                hour = ts.hour
            except:
                continue
            
            stats = slice_data.get("stats", {})
            if stats.get("avg_load"):
                hourly[hour]["loads"].append(stats["avg_load"])
            if stats.get("avg_throughput"):
                hourly[hour]["throughputs"].append(stats["avg_throughput"])
            if stats.get("avg_cqi"):
                hourly[hour]["cqis"].append(stats["avg_cqi"])
        
        # Compute averages
        patterns = {}
        for h in range(24):
            loads = hourly[h]["loads"] or [50]
            throughputs = hourly[h]["throughputs"] or [20000]
            cqis = hourly[h]["cqis"] or [9.5]
            patterns[h] = {
                "avg_load": sum(loads) / len(loads),
                "avg_throughput": sum(throughputs) / len(throughputs),
                "avg_cqi": sum(cqis) / len(cqis),
                "load_std": self._std(loads),
                "throughput_std": self._std(throughputs),
            }
        return patterns
    
    def _std(self, values):
        """Compute standard deviation"""
        if len(values) < 2:
            return 0
        mean = sum(values) / len(values)
        variance = sum((x - mean) ** 2 for x in values) / len(values)
        return math.sqrt(variance)
    
    def _get_cell_baseline(self, cell_name, baseline):
        """Get baseline info for a cell"""
        return baseline.get(cell_name, {})
    
    def forecast_cell(self, cell_name, target_dt, baseline_info, confidence_decay):
        """Forecast metrics for a single cell at target time"""
        history = self.cell_history.get(cell_name, [])
        hour = target_dt.hour
        pattern = self.hourly_patterns.get(hour, {})
        
        # Get recent values or use defaults
        recent = history[-24:] if history else []
        
        if recent:
            # Use recent average with hourly pattern adjustment
            recent_loads = [h.get("load") for h in recent if h.get("load") is not None]
            recent_throughputs = [h.get("throughput") for h in recent if h.get("throughput") is not None]
            recent_cqis = [h.get("cqi") for h in recent if h.get("cqi") is not None]
            
            base_load = sum(recent_loads) / len(recent_loads) if recent_loads else pattern.get("avg_load", 50)
            base_throughput = sum(recent_throughputs) / len(recent_throughputs) if recent_throughputs else pattern.get("avg_throughput", 20000)
            base_cqi = sum(recent_cqis) / len(recent_cqis) if recent_cqis else pattern.get("avg_cqi", 9.5)
            
            # Apply hourly pattern variation
            hourly_load_factor = pattern.get("avg_load", 50) / 50  # Normalize around 50
            hourly_tp_factor = pattern.get("avg_throughput", 20000) / 20000
            
            # Add some realistic variation
            noise_load = random.gauss(0, pattern.get("load_std", 5) * 0.3)
            noise_tp = random.gauss(0, pattern.get("throughput_std", 2000) * 0.3)
            
            pred_load = base_load * (0.7 + 0.3 * hourly_load_factor) + noise_load
            pred_throughput = base_throughput * (0.7 + 0.3 * hourly_tp_factor) + noise_tp
            pred_cqi = base_cqi + random.gauss(0, 0.3)
        else:
            # No history - use hourly pattern with noise
            pred_load = pattern.get("avg_load", 50) + random.gauss(0, 10)
            pred_throughput = pattern.get("avg_throughput", 20000) + random.gauss(0, 3000)
            pred_cqi = pattern.get("avg_cqi", 9.5) + random.gauss(0, 0.5)
        
        # Clamp values to realistic ranges
        pred_load = max(0, min(100, pred_load))
        pred_throughput = max(0, pred_throughput)
        pred_cqi = max(1, min(15, pred_cqi))
        
        # Get static values from baseline
        ta = baseline_info.get("ta", 2.0) + random.gauss(0, 0.5)
        ta = max(0, min(63, ta))
        signal_power = baseline_info.get("signal_power", 170)
        traffic = pred_load * pred_throughput / 1000000 * 0.01  # Rough traffic estimate
        
        # Classify cell status
        issue_type, root_cause, severity, health = classify_cell(pred_load, pred_cqi)
        congested = pred_load >= 80
        
        # Confidence decreases for further predictions
        confidence = max(0.5, 0.95 - confidence_decay)
        
        return {
            "load": round(pred_load, 4),
            "throughput": round(pred_throughput, 4),
            "cqi": round(pred_cqi, 4),
            "traffic": round(traffic, 4),
            "ta": round(ta, 4),
            "signal_power": signal_power,
            "congested": congested,
            "severity": severity,
            "issue_type": issue_type,
            "root_cause": root_cause,
            "health_score": health,
            "confidence": round(confidence, 2),
            "is_forecast": True
        }
    
    def generate_forecast(self, baseline, start_dt, hours=144, confidence_base=0.95):
        """Generate forecast for all cells for N hours"""
        forecasts = []
        
        # Get all cell names from baseline
        cell_names = list(baseline.keys())
        log(f"Forecasting {len(cell_names)} cells for {hours} hours")
        
        for h in range(hours):
            target_dt = start_dt + timedelta(hours=h)
            confidence_decay = h * 0.003  # Confidence decreases ~0.3% per hour
            
            observations = {}
            for cell_name in cell_names:
                baseline_info = baseline.get(cell_name, {})
                cell_forecast = self.forecast_cell(cell_name, target_dt, baseline_info, confidence_decay)
                observations[cell_name] = cell_forecast
            
            # Compute aggregate stats
            stats = compute_cell_stats(observations)
            
            # Average confidence for this time slice
            avg_confidence = max(0.5, confidence_base - confidence_decay)
            
            forecasts.append({
                "timestamp": format_timestamp(target_dt),
                "filename": format_filename(target_dt),
                "stats": stats,
                "observations": observations,
                "confidence": round(avg_confidence, 2)
            })
            
            if (h + 1) % 24 == 0:
                log(f"Generated day {(h + 1) // 24} forecast")
        
        return forecasts


def run_forecast_pipeline(days=6, start_date=None):
    """Main forecast generation pipeline"""
    log("=" * 60)
    log("NetVision Forecast Generator")
    log("=" * 60)
    
    # Load baseline
    if not BASELINE_PATH.exists():
        log("baseline.json not found", "ERROR")
        return {"success": False, "error": "baseline.json not found"}
    
    baseline = load_json(BASELINE_PATH)
    log(f"Loaded baseline with {len(baseline)} cells", "OK")
    
    # Load historical data
    historical = load_historical_data(limit=168)  # Last 7 days
    log(f"Loaded {len(historical)} historical time slices", "OK")
    
    if not historical:
        log("No historical data found - using synthetic patterns", "WARN")
    
    # Determine forecast start time from the REAL latest historical timestamp
    if start_date:
        try:
            start_dt = datetime.strptime(start_date, "%d-%m-%Y")
        except:
            start_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        try:
            time_index = load_json(TIME_INDEX_PATH).get("timestamps", [])
            latest_entry = max(
                time_index,
                key=lambda e: parse_timestamp(e.get("timestamp", "01-01-1970 00:00"))
            ) if time_index else None
            if latest_entry:
                latest_dt = parse_timestamp(latest_entry.get("timestamp"))
                start_dt = latest_dt + timedelta(hours=1)
            elif historical:
                last_ts = historical[-1].get("timestamp", "")
                last_dt = parse_timestamp(last_ts)
                start_dt = last_dt + timedelta(hours=1)
            else:
                start_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        except:
            start_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    
    log(f"Forecast start: {format_timestamp(start_dt)}")
    log(f"Forecast days: {days}")
    
    # Create forecaster and generate
    forecaster = TimeSeriesForecaster(historical)
    hours = days * 24
    forecasts = forecaster.generate_forecast(baseline, start_dt, hours)
    
    log(f"Generated {len(forecasts)} forecast slices", "OK")
    
    # Create forecast_data directory
    FORECAST_DATA_DIR.mkdir(parents=True, exist_ok=True)
    
    # Save individual forecast files
    forecast_index = []
    for fc in forecasts:
        filename = fc["filename"]
        filepath = FORECAST_DATA_DIR / filename
        observations_df = observations_to_dataframe(fc["observations"])
        write_parquet_dataframe(observations_df, filepath)
        
        # Add to index
        forecast_index.append({
            "timestamp": fc["timestamp"],
            "filename": filename,
            "stats": fc["stats"],
            "confidence": fc["confidence"]
        })
    
    # Save forecast index
    save_json(FORECAST_INDEX_PATH, forecast_index)
    log(f"Saved forecast_index.json with {len(forecast_index)} entries", "OK")
    
    log("=" * 60)
    log("Forecast generation complete!", "OK")
    log("=" * 60)
    
    # Return summary as JSON (for API)
    summary = {
        "success": True,
        "forecasts_generated": len(forecasts),
        "start_timestamp": forecasts[0]["timestamp"] if forecasts else None,
        "end_timestamp": forecasts[-1]["timestamp"] if forecasts else None,
        "days": days,
        "cells": len(baseline)
    }
    
    # Print JSON summary on last line for API parsing
    print(json.dumps(summary))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NetVision Forecast Generator")
    parser.add_argument("--days", type=int, default=6, help="Number of days to forecast")
    parser.add_argument("--start-date", type=str, default=None, help="Start date (DD-MM-YYYY)")
    args = parser.parse_args()
    
    try:
        run_forecast_pipeline(days=args.days, start_date=args.start_date)
    except Exception as e:
        log(f"PIPELINE FAILED: {type(e).__name__}: {e}", "ERROR")
        import traceback
        traceback.print_exc()
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
