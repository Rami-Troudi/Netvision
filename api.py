# Requirements: fastapi, uvicorn, pandas, lightgbm, joblib, pyarrow

from __future__ import annotations

from contextlib import asynccontextmanager
import importlib
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
import joblib
import numpy as np
import pandas as pd
from pydantic import BaseModel


ROOT_DIR = Path(__file__).resolve().parent
NO_ACTION_LABEL = "Aucune action requise"
STALE_ACTION_LABEL = "Data too stale for decision"
MODEL_VERSIONS = ["prb", "users", "thrput"]
ENCODED_BAND_MAP = {0: "B1", 1: "B3", 2: "B20"}


class PredictRequest(BaseModel):
    cellname: str


class CellNotFoundError(Exception):
    def __init__(self, cellname: str) -> None:
        super().__init__(f"Cell not found: {cellname}")
        self.cellname = cellname


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if pd.isna(out):
        return default
    return out


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or pd.isna(value):
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "t", "yes", "y"}
    return bool(value)


def _normalize_band(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""

    if isinstance(value, (int, np.integer, float, np.floating)):
        int_value = int(value)
        if int_value in ENCODED_BAND_MAP:
            return ENCODED_BAND_MAP[int_value]

    text = str(value).strip().upper().replace(".0", "")
    if text in {"B1", "1"}:
        return "B1"
    if text in {"B3", "3"}:
        return "B3"
    if text in {"B20", "20"}:
        return "B20"
    if text in {"0", "2"}:
        return ENCODED_BAND_MAP[int(text)]
    return text


def _load_feature_columns(meta_path: Path) -> list[str]:
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    feature_cols = list(metadata.get("feature_cols", []))
    if not feature_cols:
        raise ValueError("features_meta.json has no feature_cols.")
    return feature_cols


def _predict_with_model(model: Any, feature_frame: pd.DataFrame) -> np.ndarray:
    best_iteration = getattr(model, "best_iteration_", None)
    if isinstance(best_iteration, (int, np.integer)) and int(best_iteration) > 0:
        try:
            return model.predict(feature_frame, num_iteration=int(best_iteration))
        except TypeError:
            pass
    return model.predict(feature_frame)


def _align_model_features(
    model: Any,
    base_feature_frame: pd.DataFrame,
    meta_feature_cols: list[str],
    model_label: str,
) -> pd.DataFrame:
    model_feature_names = getattr(model, "feature_name_", None)
    if isinstance(model_feature_names, (list, tuple)) and model_feature_names:
        missing = [col for col in model_feature_names if col not in base_feature_frame.columns]
        if missing:
            raise ValueError(f"{model_label} expects missing feature columns: {missing}")
        not_in_meta = [col for col in model_feature_names if col not in meta_feature_cols]
        if not_in_meta:
            raise ValueError(f"{model_label} has features not present in features_meta.json: {not_in_meta}")
        return base_feature_frame[list(model_feature_names)]

    expected_n = getattr(model, "n_features_in_", None)
    if isinstance(expected_n, (int, np.integer)) and int(expected_n) != base_feature_frame.shape[1]:
        raise ValueError(
            f"{model_label} expects {int(expected_n)} features but features_meta.json provides {base_feature_frame.shape[1]}."
        )
    return base_feature_frame


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
        "features": ROOT_DIR / "features_with_score.parquet",
        "meta": ROOT_DIR / "features_meta.json",
        "model_prb": ROOT_DIR / "models" / "model_prb.pkl",
        "model_users": ROOT_DIR / "models" / "model_users.pkl",
        "model_thrput": ROOT_DIR / "models" / "model_thrput.pkl",
        "profile": ROOT_DIR / "cell_congestion_profile.parquet",
        "thresholds": ROOT_DIR / "thresholds.json",
        "recommendations_parquet": ROOT_DIR / "all_cell_recommendations.parquet",
        "recommendations_csv": ROOT_DIR / "all_cell_recommendations.csv",
        "action_engine": ROOT_DIR / "action_engine.py",
    }

    try:
        missing = [f"{name}: {path}" for name, path in paths.items() if not path.exists()]
        if missing:
            raise FileNotFoundError("Missing startup files: " + "; ".join(missing))

        action_engine_module = importlib.import_module("action_engine")
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

        missing_model_features = [col for col in feature_cols if col not in features_df.columns]
        if missing_model_features:
            raise ValueError(f"Missing feature columns in features_with_score.parquet: {missing_model_features}")

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

        model_prb = joblib.load(paths["model_prb"])
        model_users = joblib.load(paths["model_users"])
        model_thrput = joblib.load(paths["model_thrput"])

        app.state.paths = paths
        app.state.thresholds = thresholds
        app.state.feature_cols = feature_cols
        app.state.action_engine = action_engine_module
        app.state.model_prb = model_prb
        app.state.model_users = model_users
        app.state.model_thrput = model_thrput
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
    base_features = latest_frame[app.state.feature_cols].apply(pd.to_numeric, errors="coerce").fillna(0.0)

    x_prb = _align_model_features(app.state.model_prb, base_features, app.state.feature_cols, "model_prb")
    x_users = _align_model_features(app.state.model_users, base_features, app.state.feature_cols, "model_users")
    x_thrput = _align_model_features(app.state.model_thrput, base_features, app.state.feature_cols, "model_thrput")

    pred_prb = float(np.clip(_predict_with_model(app.state.model_prb, x_prb)[0], 0.0, 100.0))
    pred_users = float(np.clip(_predict_with_model(app.state.model_users, x_users)[0], 0.0, 500.0))
    pred_thrput = float(np.clip(_predict_with_model(app.state.model_thrput, x_thrput)[0], 0.0, 500000.0))

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

    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)
