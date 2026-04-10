# Requirements: fastapi, uvicorn, pandas, numpy, duckdb, joblib, pyarrow

from __future__ import annotations

from contextlib import asynccontextmanager
import importlib
import inspect
import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
import numpy as np
import pandas as pd
from pydantic import BaseModel

from backend.common import normalize_band as _normalize_band
from backend.common import to_bool as _to_bool
from backend.common import to_float as _to_float


BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
MODEL_ASSETS_DIR = PROJECT_ROOT / "runtime_data" / "model_assets"
NO_ACTION_LABEL = "Aucune action requise"
STALE_ACTION_LABEL = "Data too stale for decision"
MODEL_VERSIONS = ["forecast_model"]

# Forecast request defaults can be tuned via environment for deterministic ops/tests.
FORECAST_CONFIDENCE_DECAY = float(os.getenv("FORECAST_CONFIDENCE_DECAY", "0.003"))
FORECAST_HOURS_AHEAD = int(os.getenv("FORECAST_HOURS_AHEAD", "1"))
FORECAST_STOCHASTIC = os.getenv("FORECAST_STOCHASTIC", "false").strip().lower() in {"1", "true", "yes", "y"}


class PredictRequest(BaseModel):
    cellname: str


class CellNotFoundError(Exception):
    def __init__(self, cellname: str) -> None:
        super().__init__(f"Cell not found: {cellname}")
        self.cellname = cellname


def _load_feature_columns(meta_path: Path) -> list[str]:
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    feature_cols = list(metadata.get("feature_cols", []))
    if not feature_cols:
        raise ValueError("features_meta.json has no feature_cols.")
    return feature_cols


def _predict_next_with_forecaster(
    forecaster: Any,
    cellname: str,
    target_dt: Any,
    baseline_info: dict[str, Any],
) -> dict[str, Any]:
    forecast_kwargs = {
        "cell_name": cellname,
        "target_dt": target_dt,
        "baseline_info": baseline_info,
        "confidence_decay": FORECAST_CONFIDENCE_DECAY,
        "hours_ahead": FORECAST_HOURS_AHEAD,
        "stochastic": FORECAST_STOCHASTIC,
    }

    # Pass only supported kwargs to avoid masking TypeErrors raised inside forecast_cell.
    supported_params = set(inspect.signature(forecaster.forecast_cell).parameters)
    call_kwargs = {k: v for k, v in forecast_kwargs.items() if k in supported_params}
    out = forecaster.forecast_cell(**call_kwargs)

    if not isinstance(out, dict):
        raise ValueError("Forecast model returned an invalid prediction payload.")
    return out


def _normalize_cellname(cellname: str) -> str:
    key = str(cellname).strip()
    if not key:
        raise HTTPException(status_code=400, detail="cellname must be a non-empty string.")
    return key


def _latest_non_imputed_frame(cell_hist: pd.DataFrame) -> pd.DataFrame:
    non_imputed = cell_hist[cell_hist["IS_IMPUTED"].map(_to_bool).eq(False)]
    if non_imputed.empty:
        raise ValueError("Cell has no non-imputed row in features_with_score.parquet.")

    ordered = non_imputed.sort_values("DATE_ID")
    return ordered.tail(1)


def _latest_non_imputed_row(cell_hist: pd.DataFrame) -> pd.Series:
    return _latest_non_imputed_frame(cell_hist).iloc[0]


def _get_cell_history_df(app: FastAPI, cellname: str) -> pd.DataFrame:
    key = _normalize_cellname(cellname)
    try:
        return app.state.features_by_cell.loc[[key]].copy().reset_index(drop=True)
    except KeyError as exc:
        raise CellNotFoundError(key) from exc


def _get_profile_row(app: FastAPI, cellname: str) -> pd.Series:
    key = _normalize_cellname(cellname)
    try:
        row = app.state.profile_by_cell.loc[key]
    except KeyError as exc:
        raise CellNotFoundError(key) from exc
    if isinstance(row, pd.DataFrame):
        return row.iloc[-1]
    return row


@asynccontextmanager
async def lifespan(app: FastAPI):
    paths = {
        "features": MODEL_ASSETS_DIR / "features_with_score.parquet",
        "meta": MODEL_ASSETS_DIR / "features_meta.json",
        "forecast_model": PROJECT_ROOT / "models" / "forecast_model.pkl",
        "profile": MODEL_ASSETS_DIR / "cell_congestion_profile.parquet",
        "thresholds": MODEL_ASSETS_DIR / "thresholds.json",
        "recommendations_parquet": MODEL_ASSETS_DIR / "all_cell_recommendations.parquet",
        "recommendations_csv": MODEL_ASSETS_DIR / "all_cell_recommendations.csv",
        "action_engine": BACKEND_DIR / "action_engine.py",
    }

    try:
        required_path_keys = [
            "features",
            "meta",
            "forecast_model",
            "profile",
            "thresholds",
            "recommendations_parquet",
            "recommendations_csv",
            "action_engine",
        ]
        missing = [f"{name}: {paths[name]}" for name in required_path_keys if not paths[name].exists()]
        if missing:
            raise FileNotFoundError("Missing startup files: " + "; ".join(missing))

        action_engine_module = importlib.import_module("backend.action_engine")
        thresholds = json.loads(paths["thresholds"].read_text(encoding="utf-8"))
        feature_cols = _load_feature_columns(paths["meta"])

        features_df = pd.read_parquet(paths["features"])
        profile_df = pd.read_parquet(paths["profile"])
        recommendations_df = pd.read_parquet(paths["recommendations_parquet"])

        for required_col in [
            "CELLNAME",
            "DATE_ID",
            "IS_IMPUTED",
            "prb_load",
            "active_users",
            "throughput",
            "cqi",
            "congestion_score",
        ]:
            if required_col not in features_df.columns:
                raise ValueError(f"features_with_score.parquet missing required column: {required_col}")

        for required_col in [
            "CELLNAME",
            "ENODEB_NAME",
            "FREQUENCY_BAND",
            "is_structural_congestion",
            "avg_prb_busy_hour",
        ]:
            if required_col not in profile_df.columns:
                raise ValueError(f"cell_congestion_profile.parquet missing required column: {required_col}")

        for required_col in [
            "CELLNAME",
            "action",
            "tier",
            "priority_rank",
            "avg_prb_busy_hour",
            "ENODEB_NAME",
            "FREQUENCY_BAND",
            "is_structural_congestion",
        ]:
            if required_col not in recommendations_df.columns:
                raise ValueError(f"all_cell_recommendations.parquet missing required column: {required_col}")

        features_df = features_df.copy()
        profile_df = profile_df.copy()
        recommendations_df = recommendations_df.copy()

        features_df["CELLNAME"] = features_df["CELLNAME"].astype(str).str.strip()
        profile_df["CELLNAME"] = profile_df["CELLNAME"].astype(str).str.strip()
        recommendations_df["CELLNAME"] = recommendations_df["CELLNAME"].astype(str).str.strip()
        features_df["DATE_ID"] = pd.to_datetime(features_df["DATE_ID"], errors="coerce")
        features_df = features_df.sort_values(["CELLNAME", "DATE_ID"]).reset_index(drop=True)

        profile_latest = (
            profile_df.reset_index(drop=True).groupby("CELLNAME", as_index=False, sort=False).tail(1).reset_index(drop=True)
        )

        prediction_backend = "trained_forecaster"
        forecast_model = None
        forecast_model_baseline: dict[str, Any] = {}

        from scripts.forecast_hf import load_trained_forecaster  # type: ignore

        forecast_model, forecast_model_baseline, _ = load_trained_forecaster(paths["forecast_model"])

        app.state.paths = paths
        app.state.thresholds = thresholds
        app.state.feature_cols = feature_cols
        app.state.action_engine = action_engine_module
        app.state.prediction_backend = prediction_backend
        app.state.forecast_model = forecast_model
        app.state.forecast_model_baseline = forecast_model_baseline
        app.state.features_df = features_df
        app.state.features_by_cell = features_df.set_index("CELLNAME", drop=False)
        app.state.profile_df = profile_latest
        app.state.profile_by_cell = profile_latest.set_index("CELLNAME", drop=False)
        app.state.recommendations_df = recommendations_df
        app.state.n_cells_loaded = int(profile_latest["CELLNAME"].nunique())
    except Exception as exc:
        raise RuntimeError(f"Startup loading failed: {exc}") from exc

    yield


app = FastAPI(title="4G RAN Congestion API", lifespan=lifespan)


@app.exception_handler(CellNotFoundError)
async def cell_not_found_handler(_: Any, exc: CellNotFoundError) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"error": "Cell not found", "cellname": exc.cellname},
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "n_cells_loaded": int(app.state.n_cells_loaded),
        "model_versions": MODEL_VERSIONS,
        "prediction_backend": str(getattr(app.state, "prediction_backend", "unknown")),
    }


@app.get("/cells")
def cells() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in app.state.profile_df.itertuples(index=False):
        rows.append(
            {
                "cellname": str(row.CELLNAME),
                "enodeb": str(row.ENODEB_NAME),
                "band": _normalize_band(getattr(row, "FREQUENCY_BAND", "")),
                "is_structural_congestion": bool(_to_bool(getattr(row, "is_structural_congestion", False))),
                "avg_prb_busy_hour": _to_float(getattr(row, "avg_prb_busy_hour", 0.0)),
            }
        )
    rows.sort(key=lambda item: item["cellname"])
    return rows


@app.post("/predict")
def predict(body: PredictRequest) -> dict[str, Any]:
    cellname = _normalize_cellname(body.cellname)
    cell_hist = _get_cell_history_df(app, cellname)
    _get_profile_row(app, cellname)

    latest_frame = _latest_non_imputed_frame(cell_hist)
    latest = latest_frame.iloc[0]
    prediction_backend = str(getattr(app.state, "prediction_backend", "trained_forecaster"))

    latest_ts = pd.to_datetime(latest.get("DATE_ID"), errors="coerce")
    if pd.isna(latest_ts):
        latest_ts = pd.Timestamp.utcnow().floor("h")
    target_dt = (latest_ts + pd.Timedelta(hours=1)).to_pydatetime()

    baseline_lookup = getattr(app.state, "forecast_model_baseline", {})
    baseline_info = baseline_lookup.get(cellname, {}) if isinstance(baseline_lookup, dict) else {}
    if not isinstance(baseline_info, dict):
        baseline_info = {}

    pred_obs = _predict_next_with_forecaster(
        forecaster=app.state.forecast_model,
        cellname=cellname,
        target_dt=target_dt,
        baseline_info=baseline_info,
    )

    pred_prb = float(np.clip(_to_float(pred_obs.get("load"), _to_float(latest.get("prb_load"))), 0.0, 100.0))
    pred_users_raw = pred_obs.get(
        "active_users",
        pred_obs.get("traffic", _to_float(latest.get("active_users"), 0.0)),
    )
    pred_users = float(np.clip(_to_float(pred_users_raw), 0.0, 500.0))
    pred_thrput = float(
        np.clip(_to_float(pred_obs.get("throughput"), _to_float(latest.get("throughput"))), 0.0, 500000.0)
    )

    cell_state = app.state.action_engine.get_cell_state(
        cellname=cellname,
        features_df=cell_hist,
        profile_df=app.state.profile_df,
        pred_prb=pred_prb,
        pred_users=pred_users,
        pred_thrput=pred_thrput,
    )
    actions = app.state.action_engine.recommend_actions(cell_state)

    return {
        "cellname": cellname,
        "enodeb_name": str(cell_state["enodeb_name"]),
        "frequency_band": str(cell_state["frequency_band"]),
        "current_kpis": {
            "prb_load": _to_float(cell_state["current_prb"]),
            "active_users": _to_float(cell_state["current_users"]),
            "throughput_kbps": _to_float(cell_state["current_thrput"]),
            "cqi": _to_float(cell_state["current_cqi"]),
        },
        "predicted_next_hour": {
            "prb_load": pred_prb,
            "active_users": pred_users,
            "throughput_kbps": pred_thrput,
        },
        "congestion_score": int(round(_to_float(latest.get("congestion_score"), 0.0))),
        "is_structural_congestion": bool(_to_bool(cell_state["is_structural_congestion"])),
        "recommended_actions": [
            {
                "action": str(action["action"]),
                "tier": str(action["tier"]),
                "confidence": str(action["confidence"]),
                "reason": str(action["reason"]),
                "estimated_recovery_pct": int(action["estimated_recovery_pct"]),
                "priority_rank": int(action["priority_rank"]),
            }
            for action in actions
        ],
    }


@app.get("/recommendations/summary")
def recommendations_summary() -> dict[str, Any]:
    rec_df = app.state.recommendations_df
    top_rec_per_cell = (
        rec_df.sort_values(["CELLNAME", "priority_rank"]).groupby("CELLNAME", as_index=False).first().reset_index(drop=True)
    )

    tier_sets = rec_df.groupby("CELLNAME")["tier"].agg(lambda series: set(str(t) for t in series.tolist()))
    by_tier = {
        "court_terme": int(sum("court_terme" in tiers for tiers in tier_sets)),
        "moyen_terme": int(sum("moyen_terme" in tiers for tiers in tier_sets)),
        "long_terme": int(sum("long_terme" in tiers for tiers in tier_sets)),
    }

    action_frequency_df = (
        rec_df[
            rec_df["action"].ne(NO_ACTION_LABEL)
            & rec_df["action"].ne(STALE_ACTION_LABEL)
        ]
        .groupby("action")["CELLNAME"]
        .nunique()
        .sort_values(ascending=False)
        .reset_index(name="n_cells")
    )

    top_congested = top_rec_per_cell.sort_values("avg_prb_busy_hour", ascending=False).head(20)
    top_congested_cells = [
        {
            "cellname": str(row.CELLNAME),
            "enodeb": str(row.ENODEB_NAME),
            "band": _normalize_band(getattr(row, "FREQUENCY_BAND", "")),
            "avg_prb_busy_hour": _to_float(getattr(row, "avg_prb_busy_hour", 0.0)),
            "is_structural_congestion": bool(_to_bool(getattr(row, "is_structural_congestion", False))),
        }
        for row in top_congested.itertuples(index=False)
    ]

    return {
        "total_cells": int(top_rec_per_cell["CELLNAME"].nunique()),
        "no_action_needed": int(top_rec_per_cell["action"].eq(NO_ACTION_LABEL).sum()),
        "by_tier": by_tier,
        "action_frequency": [
            {"action": str(row.action), "n_cells": int(row.n_cells)}
            for row in action_frequency_df.itertuples(index=False)
        ],
        "top_congested_cells": top_congested_cells,
    }


@app.get("/recommendations/export")
def recommendations_export() -> FileResponse:
    csv_path = app.state.paths["recommendations_csv"]
    return FileResponse(
        path=csv_path,
        media_type="text/csv",
        filename=csv_path.name,
    )


@app.get("/cell/{cellname}/history")
def cell_history(cellname: str) -> list[dict[str, Any]]:
    cell_hist = _get_cell_history_df(app, cellname).sort_values("DATE_ID")
    history: list[dict[str, Any]] = []
    for row in cell_hist.itertuples(index=False):
        ts = pd.to_datetime(getattr(row, "DATE_ID"), errors="coerce")
        if pd.isna(ts):
            datetime_str = str(getattr(row, "DATE_ID"))
        else:
            datetime_str = ts.isoformat()
        history.append(
            {
                "datetime": datetime_str,
                "prb_load": _to_float(getattr(row, "prb_load", 0.0)),
                "active_users": _to_float(getattr(row, "active_users", 0.0)),
                "throughput_kbps": _to_float(getattr(row, "throughput", 0.0)),
                "congestion_score": int(round(_to_float(getattr(row, "congestion_score", 0.0)))),
            }
        )
    return history


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.api:app", host="0.0.0.0", port=8000, reload=False)
