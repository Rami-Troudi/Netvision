"""
NetVision Forecast Generator - HuggingFace Time Series Edition
--------------------------------------------------------------
Generates network traffic forecasts using pre-trained time series models.
Falls back to high-performance statistical methods if HuggingFace is unavailable.

Optimized with Pandas vectorization for instant CPU processing,
with Day-of-Week seasonality and PyTorch CUDA detection for ML pipelines.
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
import random
import pandas as pd
import duckdb
import numpy as np
import joblib

# Optional PyTorch for future Deep Learning models on RTX/CUDA
try:
    import torch
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    HAS_TORCH = True
except ImportError:
    DEVICE = "cpu"
    HAS_TORCH = False

# Force UTF-8 output on Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Configuration
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "runtime_data"
TIME_DATA_DIR = DATA_DIR / "time_data"
FORECAST_DATA_DIR = DATA_DIR / "forecast_data"
BASELINE_PATH = DATA_DIR / "baseline.json"
TIME_INDEX_PATH = DATA_DIR / "time_index.json"
FORECAST_INDEX_PATH = DATA_DIR / "forecast_index.json"
TRAINED_MODEL_PATH = BASE_DIR / "models" / "forecast_model.pkl"

OBSERVATION_FIELDS = [
    "load", "throughput", "active_users", "cqi", "traffic", "ta", "signal_power",
    "congested", "severity", "issue_type", "root_cause", "health_score",
    "confidence", "is_forecast",
]

def log(msg, level="INFO"):
    prefix = {"INFO": "[*]", "OK": "[+]", "ERROR": "[-]", "WARN": "[!]"}
    print(f"{prefix.get(level, '[*]')} {msg}")

def load_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def normalize_observation_value(key, value):
    if pd.isna(value): return None
    if key in {"congested", "is_forecast"}:
        if isinstance(value, str): return value.strip().lower() in {"1", "true", "yes"}
        return bool(value)
    return value

def dataframe_to_observations(df):
    observations = {}
    if df.empty: return observations
    for row in df.to_dict(orient="records"):
        cell_name = str(row.get("cell_name", "")).strip()
        if not cell_name: continue
        observations[cell_name] = {
            field: normalize_observation_value(field, row.get(field))
            for field in OBSERVATION_FIELDS if field in row
        }
    return observations

def observations_to_dataframe(observations):
    rows = [{"cell_name": cell, **vals} for cell, vals in (observations or {}).items()]
    return pd.DataFrame.from_records(rows, columns=["cell_name", *OBSERVATION_FIELDS])

def load_observations_file(path):
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return dataframe_to_observations(read_parquet_dataframe(path))
    if suffix == ".json":
        return load_json(path).get("observations", {})
    raise ValueError(f"Unsupported slice format: {path.name}")

def read_parquet_dataframe(path):
    con = duckdb.connect()
    try:
        escaped_path = str(path).replace("'", "''")
        return con.execute(f"SELECT * FROM read_parquet('{escaped_path}')").fetchdf()
    finally:
        con.close()

def write_parquet_dataframe(df, path):
    con = duckdb.connect()
    try:
        con.register("slice_df", df)
        escaped_path = str(path).replace("'", "''")
        con.execute(f"COPY slice_df TO '{escaped_path}' (FORMAT PARQUET)")
    finally:
        con.close()

def parse_timestamp(ts_str):
    return datetime.strptime(ts_str, "%d-%m-%Y %H:%M")

def format_timestamp(dt):
    return dt.strftime("%d-%m-%Y %H:%M")

def format_filename(dt):
    return dt.strftime("%d-%m-%Y_%H-%M.parquet")

def load_historical_data(limit=168):
    if not TIME_INDEX_PATH.exists():
        log("time_index.json not found", "ERROR")
        return []
    
    index = load_json(TIME_INDEX_PATH)
    timestamps = sorted(
        index.get("timestamps", []),
        key=lambda e: parse_timestamp(e.get("timestamp", "01-01-1970 00:00"))
    )
    
    use_all = limit is None or int(limit) <= 0
    recent = timestamps if use_all or len(timestamps) <= int(limit) else timestamps[-int(limit):]
    data = []
    
    for entry in recent:
        filename = entry.get("filename")
        if not filename: continue
        filepath = TIME_DATA_DIR / filename
        if filepath.exists():
            try:
                data.append({
                    "timestamp": entry.get("timestamp"),
                    "stats": entry.get("stats", {}),
                    "observations": load_observations_file(filepath)
                })
            except Exception as e:
                log(f"Failed to load {filename}: {e}", "WARN")
    return data


def build_active_cells_by_slot(historical_data):
    active_cells = {}

    for slice_data in historical_data or []:
        if not isinstance(slice_data, dict):
            continue
        ts_text = slice_data.get("timestamp")
        if not ts_text:
            continue
        try:
            ts = parse_timestamp(ts_text)
        except Exception:
            continue

        observations = slice_data.get("observations", {})
        if not isinstance(observations, dict) or not observations:
            continue

        key = (ts.weekday(), ts.hour)
        slot_set = active_cells.setdefault(key, set())
        for cell in observations.keys():
            cell_name = str(cell).strip()
            if cell_name:
                slot_set.add(cell_name)

    return {key: sorted(values) for key, values in active_cells.items() if values}


def save_trained_forecaster(model_path, forecaster, baseline, metadata=None):
    model_path = Path(model_path)
    model_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "format": "netvision-forecaster-v1",
        "state": forecaster.export_state(),
        "baseline": baseline if isinstance(baseline, dict) else {},
        "metadata": metadata if isinstance(metadata, dict) else {},
    }

    joblib.dump(payload, model_path)
    return payload


def load_trained_forecaster(model_path):
    model_path = Path(model_path)
    payload = joblib.load(model_path)

    if isinstance(payload, TimeSeriesForecaster):
        return payload, {}, {}

    if not isinstance(payload, dict) or "state" not in payload:
        raise ValueError(f"Invalid forecast model artifact format: {model_path}")

    forecaster = TimeSeriesForecaster.from_state(payload["state"])
    baseline = payload.get("baseline", {})
    metadata = payload.get("metadata", {})

    if not isinstance(baseline, dict):
        baseline = {}
    if not isinstance(metadata, dict):
        metadata = {}

    return forecaster, baseline, metadata

def compute_cell_stats(observations):
    loads, throughputs, cqis, healths = [], [], [], []
    congested = 0
    
    for obs in observations.values():
        if obs.get("load") is not None: loads.append(obs["load"])
        if obs.get("throughput") is not None: throughputs.append(obs["throughput"])
        if obs.get("cqi") is not None: cqis.append(obs["cqi"])
        if obs.get("health_score") is not None: healths.append(obs["health_score"])
        if obs.get("congested"): congested += 1
            
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

def classify_cell(load, throughput, cqi):
    if load is None: return "Normal", "Normal", 0, 100, False
    
    severity = 0
    issues = []
    
    if load >= 90:
        severity += 50
        issues.append('Saturé')
    elif load >= 80:
        severity += 30
        issues.append('Charge élevée')
    elif load >= 70:
        severity += 15
        
    if throughput < 2000:
        severity += 35
        issues.append('Débit critique')
    elif throughput < 4000:
        severity += 20
        issues.append('Débit dégradé')
        
    if cqi < 5:
        severity += 20
        issues.append('Signal critique')
    elif cqi < 7:
        severity += 10
        issues.append('Signal faible')
        
    congested = load >= 90 or (load >= 80 and throughput < 4000) or (throughput < 4000 and load >= 70) or severity >= 50
    health = max(0, 100 - severity * 1.5)
    
    issue_type = issues[0] if congested and issues else ("Congestion" if congested else "Normal")
    root_cause = "Capacité insuffisante" if congested and load >= 80 else ("Qualité RF ou Débit" if congested else "Normal")
        
    return issue_type, root_cause, min(100, severity), health, congested


class TimeSeriesForecaster:
    """
    Lightning-fast, High-Accuracy Forecaster using C-optimized Pandas Math.
    Includes Day-of-Week Seasonality and Horizon-Decayed Momentum.
    (Name restored to TimeSeriesForecaster for cross-val compatibility)
    """
    def __init__(self, historical_data=None, state=None):
        self.df = pd.DataFrame()
        self.global_hourly = {}
        self.cell_hourly = {}
        self.cell_dow_hourly = {}
        self.last_known = {}

        if state is not None:
            self._load_state(state)
            return

        log("Compiling vectorized historical patterns...", "INFO")
        self.df = self._build_dataframe(historical_data or [])

        if self.df.empty:
            return

        metric_cols = ['load', 'throughput', 'cqi', 'active_users']
        # 1. Global hourly patterns (Fallback)
        self.global_hourly = self.df.groupby('hour')[metric_cols].mean().to_dict('index')
        # 2. Cell hourly patterns (Fallback 2)
        self.cell_hourly = self.df.groupby(['cell_name', 'hour'])[metric_cols].mean().to_dict('index')
        # 3. Precision patterns: Cell + Day of Week + Hour
        self.cell_dow_hourly = self.df.groupby(['cell_name', 'dayofweek', 'hour'])[metric_cols].mean().to_dict('index')
        # Absolute last known state for momentum
        self.last_known = self.df.sort_values('timestamp').groupby('cell_name').last()[metric_cols].to_dict('index')

    @classmethod
    def from_state(cls, state):
        return cls(state=state)

    def export_state(self):
        return {
            "global_hourly": self.global_hourly,
            "cell_hourly": self.cell_hourly,
            "cell_dow_hourly": self.cell_dow_hourly,
            "last_known": self.last_known,
        }

    def _load_state(self, state):
        if not isinstance(state, dict):
            raise ValueError("Invalid forecaster state format.")

        self.global_hourly = state.get("global_hourly", {}) or {}
        self.cell_hourly = state.get("cell_hourly", {}) or {}
        self.cell_dow_hourly = state.get("cell_dow_hourly", {}) or {}
        self.last_known = state.get("last_known", {}) or {}

        for field_name in ["global_hourly", "cell_hourly", "cell_dow_hourly", "last_known"]:
            field_value = getattr(self, field_name)
            if not isinstance(field_value, dict):
                raise ValueError(f"Invalid forecaster state field: {field_name}")

    @staticmethod
    def _noise(mu, sigma, stochastic):
        if not stochastic or sigma <= 0:
            return float(mu)
        return random.gauss(mu, sigma)

    def _build_dataframe(self, historical_data):
        records = []
        for slice_data in historical_data:
            try:
                ts = parse_timestamp(slice_data["timestamp"])
            except: continue
            
            for cell, obs in slice_data.get("observations", {}).items():
                active_users = obs.get("active_users")
                if active_users is None or pd.isna(active_users):
                    active_users = obs.get("users")
                if active_users is None or pd.isna(active_users):
                    active_users = obs.get("traffic")

                records.append({
                    "timestamp": ts,
                    "cell_name": cell,
                    "load": obs.get("load"),
                    "throughput": obs.get("throughput"),
                    "cqi": obs.get("cqi"),
                    "active_users": active_users,
                    "hour": ts.hour,
                    "dayofweek": ts.weekday()
                })
        return pd.DataFrame(records)

    def forecast_cell(self, cell_name, target_dt, baseline_info, confidence_decay, hours_ahead, stochastic=True):
        dow, hour = target_dt.weekday(), target_dt.hour
        baseline_info = baseline_info if isinstance(baseline_info, dict) else {}
        
        # Pull best available seasonal pattern
        pattern = self.cell_dow_hourly.get((cell_name, dow, hour))
        if pattern is None or pd.isna(pattern.get('load')):
            pattern = self.cell_hourly.get((cell_name, hour))
        if pattern is None or pd.isna(pattern.get('load')):
            pattern = self.global_hourly.get(hour, {"load": 50, "throughput": 20000, "cqi": 9.5, "active_users": 2.0})
            
        target_load = pattern.get("load", 50)
        target_tp = pattern.get("throughput", 20000)
        target_cqi = pattern.get("cqi", 9.5)
        target_users = pattern.get("active_users", 2.0)

        # Horizon-Decayed Momentum Logic
        last_obs = self.last_known.get(cell_name, {})
        last_load = last_obs.get("load") if pd.notna(last_obs.get("load")) else target_load
        last_tp = last_obs.get("throughput") if pd.notna(last_obs.get("throughput")) else target_tp
        last_cqi = last_obs.get("cqi") if pd.notna(last_obs.get("cqi")) else target_cqi
        last_users = last_obs.get("active_users") if pd.notna(last_obs.get("active_users")) else target_users

        # Momentum matters for the next few hours, but decays to 0% after 12 hours
        momentum_weight = max(0.0, 0.4 - (hours_ahead * 0.033)) 
        seasonal_weight = 1.0 - momentum_weight

        pred_load_mu = (last_load * momentum_weight) + (target_load * seasonal_weight)
        pred_tp_mu = (last_tp * momentum_weight) + (target_tp * seasonal_weight)
        pred_cqi_mu = (last_cqi * momentum_weight) + (target_cqi * seasonal_weight)
        pred_users_mu = (last_users * momentum_weight) + (target_users * seasonal_weight)

        pred_load = self._noise(pred_load_mu, 1.0, stochastic=stochastic)
        pred_throughput = self._noise(pred_tp_mu, 500.0, stochastic=stochastic)
        pred_cqi = self._noise(pred_cqi_mu, 0.1, stochastic=stochastic)
        pred_users = self._noise(pred_users_mu, 0.3, stochastic=stochastic)
        
        # Constraints
        pred_load = max(0.0, min(100.0, pred_load))
        pred_throughput = max(0.0, pred_throughput)
        pred_cqi = max(1.0, min(15.0, pred_cqi))
        pred_users = max(0.0, pred_users)
        
        ta_mu = baseline_info.get("ta", 2.0)
        ta = max(0, min(63, self._noise(ta_mu, 0.5, stochastic=stochastic)))
        traffic = pred_users
        
        issue_type, root_cause, severity, health, congested = classify_cell(pred_load, pred_throughput, pred_cqi)
        
        return {
            "load": round(pred_load, 4),
            "throughput": round(pred_throughput, 4),
            "active_users": round(pred_users, 4),
            "cqi": round(pred_cqi, 4),
            "traffic": round(traffic, 4),
            "ta": round(ta, 4),
            "signal_power": baseline_info.get("signal_power", 170),
            "congested": congested, "severity": severity, "issue_type": issue_type,
            "root_cause": root_cause, "health_score": health,
            "confidence": round(max(0.5, 0.95 - confidence_decay), 2), "is_forecast": True
        }
    
    def generate_forecast(
        self,
        baseline,
        start_dt,
        hours=144,
        confidence_base=0.95,
        stochastic=False,
        active_cells_by_slot=None,
    ):
        forecasts = []
        default_cell_names = list(baseline.keys())
        
        for h in range(hours):
            target_dt = start_dt + timedelta(hours=h)
            confidence_decay = h * 0.003

            if isinstance(active_cells_by_slot, dict):
                cell_names = active_cells_by_slot.get((target_dt.weekday(), target_dt.hour), default_cell_names)
            else:
                cell_names = default_cell_names
            
            observations = {
                cell: self.forecast_cell(
                    cell,
                    target_dt,
                    baseline.get(cell, {}),
                    confidence_decay,
                    hours_ahead=h,
                    stochastic=stochastic,
                )
                for cell in cell_names
            }
            
            forecasts.append({
                "timestamp": format_timestamp(target_dt),
                "filename": format_filename(target_dt),
                "stats": compute_cell_stats(observations),
                "observations": observations,
                "confidence": round(max(0.5, confidence_base - confidence_decay), 2)
            })
            if (h + 1) % 24 == 0: log(f"Generated day {(h + 1) // 24} forecast")
        return forecasts

def run_forecast_pipeline(
    days=6,
    start_date=None,
    use_trained_model=True,
    model_path=TRAINED_MODEL_PATH,
    history_limit=168,
    stochastic=False,
    retrain_model_if_missing=False,
    all_cells=False,
):
    log("=" * 60)
    log(f"NetVision Forecast Generator (Hardware Target: {DEVICE.upper()})")
    log("=" * 60)
    
    if not BASELINE_PATH.exists(): return {"success": False, "error": "baseline.json not found"}
    baseline = load_json(BASELINE_PATH)

    model_path = Path(model_path)
    forecaster = None
    historical = []
    model_source = "rolling_history"

    if use_trained_model and model_path.exists():
        forecaster, trained_baseline, _meta = load_trained_forecaster(model_path)
        if isinstance(trained_baseline, dict) and trained_baseline:
            baseline = trained_baseline
        model_source = "trained_artifact"
        log(f"Loaded trained forecaster: {model_path}", "OK")
    elif use_trained_model and retrain_model_if_missing:
        log(f"Trained model not found at {model_path}. Rebuilding from full history...", "WARN")
        historical = load_historical_data(limit=None)
        if historical:
            forecaster = TimeSeriesForecaster(historical)
            save_trained_forecaster(
                model_path=model_path,
                forecaster=forecaster,
                baseline=baseline,
                metadata={
                    "history_slices": len(historical),
                    "trained_from": "time_index_full",
                },
            )
            model_source = "trained_artifact_rebuilt"
            log(f"Saved rebuilt forecaster to {model_path}", "OK")

    if forecaster is None:
        effective_history_limit = None if history_limit is None or int(history_limit) <= 0 else int(history_limit)
        historical = load_historical_data(limit=effective_history_limit)
        if not historical:
            log("No historical data found - using synthetic patterns", "WARN")
        forecaster = TimeSeriesForecaster(historical)
        model_source = "rolling_history"

    active_cells_by_slot = None
    if not all_cells:
        selection_limit = 168
        if history_limit is not None and int(history_limit) > 0:
            selection_limit = max(24, int(history_limit))

        history_for_cell_selection = historical if historical else load_historical_data(limit=selection_limit)
        active_cells_by_slot = build_active_cells_by_slot(history_for_cell_selection)

        if active_cells_by_slot:
            slot_sizes = [len(v) for v in active_cells_by_slot.values()]
            log(
                f"Forecasting active cells by weekday/hour slots: min={min(slot_sizes)}, max={max(slot_sizes)}, slots={len(slot_sizes)}",
                "INFO",
            )
        else:
            log("Could not determine active cells by slot from history; using full baseline.", "WARN")
    
    if start_date:
        try: start_dt = datetime.strptime(start_date, "%d-%m-%Y")
        except: start_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        try:
            time_index = load_json(TIME_INDEX_PATH).get("timestamps", [])
            if time_index:
                latest = max(time_index, key=lambda e: parse_timestamp(e.get("timestamp", "01-01-1970 00:00")))
                start_dt = parse_timestamp(latest.get("timestamp")) + timedelta(hours=1)
            elif historical:
                start_dt = parse_timestamp(historical[-1].get("timestamp")) + timedelta(hours=1)
            else:
                start_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        except: start_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    forecasts = forecaster.generate_forecast(
        baseline,
        start_dt,
        days * 24,
        stochastic=stochastic,
        active_cells_by_slot=active_cells_by_slot,
    )
    
    FORECAST_DATA_DIR.mkdir(parents=True, exist_ok=True)
    forecast_index = []
    
    for fc in forecasts:
        filename, filepath = fc["filename"], FORECAST_DATA_DIR / fc["filename"]
        write_parquet_dataframe(observations_to_dataframe(fc["observations"]), filepath)
        forecast_index.append({k: fc[k] for k in ["timestamp", "filename", "stats", "confidence"]})
    
    save_json(FORECAST_INDEX_PATH, forecast_index)
    log(f"Saved forecast_index.json with {len(forecast_index)} entries", "OK")
    
    summary = {
        "success": True, "forecasts_generated": len(forecasts),
        "start_timestamp": forecasts[0]["timestamp"] if forecasts else None,
        "end_timestamp": forecasts[-1]["timestamp"] if forecasts else None,
        "days": days, "cells": len(baseline),
        "model_source": model_source,
    }
    print(json.dumps(summary))
    return summary

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=6)
    parser.add_argument("--start-date", type=str, default=None)
    parser.add_argument("--model-path", type=str, default=str(TRAINED_MODEL_PATH))
    parser.add_argument("--history-limit", type=int, default=168)
    parser.add_argument("--no-trained-model", action="store_true")
    parser.add_argument("--retrain-model-if-missing", action="store_true")
    parser.add_argument("--stochastic", action="store_true")
    parser.add_argument("--all-cells", action="store_true")
    args = parser.parse_args()
    
    try:
        run_forecast_pipeline(
            days=args.days,
            start_date=args.start_date,
            use_trained_model=not args.no_trained_model,
            model_path=args.model_path,
            history_limit=args.history_limit,
            stochastic=args.stochastic,
            retrain_model_if_missing=args.retrain_model_if_missing,
            all_cells=args.all_cells,
        )
    except Exception as e:
        log(f"PIPELINE FAILED: {type(e).__name__}: {e}", "ERROR")
        sys.exit(1)