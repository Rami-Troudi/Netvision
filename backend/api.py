"""FastAPI layer for rule-based congestion recommendations."""
# ruff: noqa: E501

from __future__ import annotations

import csv
import importlib
import io
import logging
import os
import threading
from collections import Counter, OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
import pandas as pd
from pydantic import BaseModel

from backend.action_engine import evaluate_all_cells_for_export
from backend.common import normalize_band as _normalize_band
from backend.common import to_float as _to_float

try:
    import redis as _redis_mod
except ImportError:
    _redis_mod = None  # type: ignore[assignment]


BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

# ---------------------------------------------------------------------------
# Export CSV Cache — Redis-backed (multi-worker safe)
# Falls back to process-local OrderedDict when Redis is unavailable.
# ---------------------------------------------------------------------------
EXPORT_CACHE_MAX_ITEMS = 8
_REDIS_EXPORT_PREFIX = "odc:export_csv:"
_REDIS_EXPORT_TTL = 3600  # 1 hour

_redis_client: Any = None  # lazy-initialized on first access
_redis_init_lock = threading.Lock()

# Fallback in-memory cache (used only when Redis is unavailable)
_export_cache_fallback: OrderedDict[str, bytes] = OrderedDict()
_export_cache_fallback_lock = threading.Lock()


def _get_redis() -> Any:
    """Lazy-initialize a Redis connection, returning None if unavailable."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if _redis_mod is None:
        return None
    with _redis_init_lock:
        if _redis_client is not None:
            return _redis_client
        redis_url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6381").strip()
        try:
            client = _redis_mod.Redis.from_url(
                redis_url,
                decode_responses=False,
                socket_connect_timeout=2,
            )
            client.ping()
            _redis_client = client
            logger.info("Export cache: using Redis at %s", redis_url)
        except Exception as exc:
            logger.warning("Export cache: Redis unavailable (%s), falling back to in-memory", exc)
            _redis_client = None
    return _redis_client


logger = logging.getLogger(__name__)


class PredictRequest(BaseModel):
    cellname: str
    prb_load: float | None = None
    throughput: float | None = None
    active_users: float | None = None
    rrc_users: float | None = None
    cqi: float | None = None
    timestamp: str | None = None


class CellNotFoundError(Exception):
    def __init__(self, cellname: str) -> None:
        super().__init__(f"Cell not found: {cellname}")
        self.cellname = cellname


@asynccontextmanager
async def lifespan(app: FastAPI):
    action_engine_module = importlib.import_module("backend.action_engine")

    runtime_context = action_engine_module.build_context_from_runtime(PROJECT_ROOT)

    app.state.action_engine = action_engine_module
    app.state.runtime_context = runtime_context
    app.state.active_context = runtime_context
    app.state.context_source = str(runtime_context.get("source") or "runtime")

    yield


app = FastAPI(title="4G RAN Congestion API", lifespan=lifespan)


@app.exception_handler(CellNotFoundError)
async def cell_not_found_handler(_: Any, exc: CellNotFoundError) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"error": "Cell not found", "cellname": exc.cellname},
    )


def _normalize_cellname(cellname: str) -> str:
    key = str(cellname or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="cellname must be a non-empty string")
    return key


def _get_active_context(app: FastAPI) -> dict[str, Any]:
    context = getattr(app.state, "active_context", None)
    if not isinstance(context, dict):
        context = getattr(app.state, "runtime_context", None)
    if not isinstance(context, dict):
        context = app.state.action_engine._empty_context()  # type: ignore[attr-defined]
    return context


def _extract_request_kpis(body: PredictRequest) -> dict[str, Any]:
    return {
        key: float(val)
        for key, val in [
            ("prb_load", body.prb_load),
            ("throughput", body.throughput),
            ("active_users", body.active_users),
            ("rrc_users", body.rrc_users),
            ("cqi", body.cqi),
        ]
        if val is not None
    }


def _normalize_export_date(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = pd.to_datetime(text, errors="coerce")
    if pd.isna(parsed):
        return ""
    return parsed.strftime("%Y-%m-%d")


def _build_export_cache_key(context: dict[str, Any], timestamp: str) -> str:
    source = str(context.get("source") or "runtime")
    updated_at = str(context.get("updated_at") or "")
    return f"{source}|{updated_at}|{timestamp.strip()}"


def _get_cached_export_csv(cache_key: str) -> bytes | None:
    """Return cached CSV bytes or None — Redis-first, in-memory fallback."""
    r = _get_redis()
    if r is not None:
        try:
            return r.get(f"{_REDIS_EXPORT_PREFIX}{cache_key}")
        except Exception:
            pass  # Redis down mid-flight, fall through
    with _export_cache_fallback_lock:
        value = _export_cache_fallback.get(cache_key)
        if value is not None:
            _export_cache_fallback.move_to_end(cache_key)
        return value


def _set_cached_export_csv(cache_key: str, csv_bytes: bytes) -> None:
    """Store CSV bytes — Redis-first, in-memory fallback."""
    r = _get_redis()
    if r is not None:
        try:
            r.setex(f"{_REDIS_EXPORT_PREFIX}{cache_key}", _REDIS_EXPORT_TTL, csv_bytes)
            return
        except Exception:
            pass  # Redis down, fall through to in-memory
    with _export_cache_fallback_lock:
        _export_cache_fallback[cache_key] = csv_bytes
        _export_cache_fallback.move_to_end(cache_key)
        while len(_export_cache_fallback) > EXPORT_CACHE_MAX_ITEMS:
            _export_cache_fallback.popitem(last=False)


@app.get("/health")
def health() -> dict[str, Any]:
    context = _get_active_context(app)
    baseline_df = context.get("baseline_df")
    observations_df = context.get("observations_df")

    n_cells = 0
    if isinstance(baseline_df, pd.DataFrame):
        n_cells = max(n_cells, int(baseline_df["cell_name"].nunique()))
    if isinstance(observations_df, pd.DataFrame):
        n_cells = max(n_cells, int(observations_df["cell_name"].nunique()))

    return {
        "status": "ok",
        "n_cells_loaded": n_cells,
        "context_source": str(getattr(app.state, "context_source", "runtime")),
        "context_updated_at": str(context.get("updated_at") or ""),
    }


@app.get("/cells")
def cells() -> list[dict[str, Any]]:
    context = _get_active_context(app)
    baseline_df = context.get("baseline_df")
    observations_df = context.get("observations_df")

    rows: list[dict[str, Any]] = []

    if isinstance(baseline_df, pd.DataFrame) and not baseline_df.empty:
        for row in baseline_df.itertuples(index=False):
            rows.append(
                {
                    "cellname": str(row.cell_name),
                    "enodeb": str(getattr(row, "enodeb_name", "")),
                    "band": _normalize_band(getattr(row, "frequency_band", "")),
                }
            )
    elif isinstance(observations_df, pd.DataFrame) and not observations_df.empty:
        latest = observations_df.sort_values("timestamp").groupby("cell_name", as_index=False).tail(1)
        for row in latest.itertuples(index=False):
            rows.append(
                {
                    "cellname": str(row.cell_name),
                    "enodeb": str(getattr(row, "enodeb_name", "")),
                    "band": _normalize_band(getattr(row, "frequency_band", "")),
                }
            )

    rows.sort(key=lambda item: item["cellname"])
    return rows


@app.post("/context/upload")
def upload_context(payload: dict[str, Any], background_tasks: BackgroundTasks) -> dict[str, Any]:
    action_engine = app.state.action_engine

    try:
        context = action_engine.build_context_from_payload(payload)
    except Exception as exc:  # pragma: no cover - returned to API caller
        raise HTTPException(status_code=400, detail=f"Invalid context payload: {exc}") from exc

    app.state.active_context = context
    app.state.context_source = str(context.get("source") or "uploaded")

    baseline_df = context.get("baseline_df")
    observations_df = context.get("observations_df")
    busy_hour_profile = context.get("busy_hour_profile") or {}

    background_tasks.add_task(_precompute_export_csv, context)

    return {
        "success": True,
        "context_source": app.state.context_source,
        "cells": int(baseline_df["cell_name"].nunique()) if isinstance(baseline_df, pd.DataFrame) else 0,
        "observations": int(len(observations_df)) if isinstance(observations_df, pd.DataFrame) else 0,
        "busy_hour_profiles": int(len(busy_hour_profile)),
        "updated_at": str(context.get("updated_at") or ""),
    }


@app.delete("/context/reset")
def reset_context() -> dict[str, Any]:
    app.state.active_context = app.state.runtime_context
    runtime_source = app.state.runtime_context.get("source") if isinstance(app.state.runtime_context, dict) else "runtime"
    app.state.context_source = str(runtime_source or "runtime")
    return {
        "success": True,
        "context_source": app.state.context_source,
    }


@app.post("/predict")
def predict(body: PredictRequest) -> dict[str, Any]:
    cellname = _normalize_cellname(body.cellname)
    request_kpis = _extract_request_kpis(body)
    context = _get_active_context(app)

    try:
        payload = app.state.action_engine.evaluate_cell(
            cell_name=cellname,
            context=context,
            request_kpis=request_kpis,
            request_timestamp=body.timestamp,
        )
    except ValueError as exc:
        message = str(exc)
        if "no KPI data" in message:
            raise CellNotFoundError(cellname) from exc
        raise HTTPException(status_code=400, detail=message) from exc

    return payload


@app.get("/recommendations/summary")
def recommendations_summary() -> dict[str, Any]:
    context = _get_active_context(app)
    rows = app.state.action_engine.evaluate_all_cells_for_export(context=context)

    if not rows:
        return {
            "total_cells": 0,
            "congested_cells": 0,
            "action_frequency": [],
        }

    total_cells = len(rows)
    congested_cells = sum(1 for row in rows if bool(row.get("is_congested")))

    counter: Counter[str] = Counter()
    for row in rows:
        actions = row.get("recommended_actions")
        if not isinstance(actions, list):
            continue
        for action in actions:
            action_name = str(action.get("action_name") or action.get("action") or "").strip()
            if not action_name or action_name == "No Action Required":
                continue
            counter[action_name] += 1

    action_frequency = [
        {"action": name, "n_cells": count}
        for name, count in counter.most_common()
    ]

    return {
        "total_cells": total_cells,
        "congested_cells": congested_cells,
        "action_frequency": action_frequency,
        "context_source": str(getattr(app.state, "context_source", "runtime")),
    }


def _build_export_csv_bytes(context: dict[str, Any], request_timestamp: str | None) -> bytes:
    rows = evaluate_all_cells_for_export(
        context=context,
        request_timestamp=request_timestamp,
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "cell_name",
            "enodeb_name",
            "frequency_band",
            "date",
            "hour",
            "prb_load",
            "throughput_kbps",
            "active_users",
            "rrc_users",
            "cqi",
            "is_congested",
            "busy_hour_flag",
            "recommended_actions",
            "top_neighbor_for_rebalancing",
            "estimated_lost_ue",
            "estimated_lost_gb",
            "estimated_gain_ue",
            "estimated_gain_gb",
            "congestion_trigger",
            "secondary_action",
        ]
    )

    for row in rows:
        kpis = row.get("current_kpis") or {}
        actions = row.get("recommended_actions") or []
        is_congested = bool(row.get("is_congested", False))

        action_names = [
            str(action.get("action_name") or action.get("action") or "").strip()
            for action in actions
            if isinstance(action, dict)
            and str(action.get("action_name") or action.get("action") or "").strip()
            and str(action.get("action_name") or action.get("action") or "").strip() != "No Action Required"
        ]
        if is_congested and not action_names:
            logger.warning("Congested cell %s has no recommended actions, exporting with empty actions", row.get('cellname', ''))

        writer.writerow(
            [
                row.get("cellname", ""),
                row.get("enodeb_name", ""),
                row.get("frequency_band", ""),
                row.get("date", ""),
                row.get("hour", ""),
                kpis.get("prb_load", ""),
                kpis.get("throughput_kbps", ""),
                kpis.get("active_users", ""),
                kpis.get("rrc_users", ""),
                kpis.get("cqi", ""),
                str(is_congested).lower(),
                str(bool(row.get("busy_hour_flag", False))).lower(),
                action_names[0] if action_names else "No Action Required",
                row.get("top_neighbor_for_rebalancing") or "",
                row.get("estimated_lost_ue", 0),
                row.get("estimated_lost_gb", 0),
                row.get("estimated_gain_ue", 0),
                row.get("estimated_gain_gb", 0),
                row.get("congestion_trigger", ""),
                action_names[1] if len(action_names) > 1 else "",
            ]
        )

    return output.getvalue().encode("utf-8-sig")


def _precompute_export_csv(context: dict[str, Any]) -> None:
    cache_key = _build_export_cache_key(context, "")
    if _get_cached_export_csv(cache_key) is not None:
        return
    try:
        csv_bytes = _build_export_csv_bytes(context, None)
        _set_cached_export_csv(cache_key, csv_bytes)
    except Exception as exc:
        logger.error(f"Failed to precompute export CSV: {exc}")


@app.get("/recommendations/export")
def recommendations_export(timestamp: str = "") -> Response:
    context = _get_active_context(app)
    request_timestamp = timestamp.strip() if timestamp else None

    cache_key = _build_export_cache_key(context, request_timestamp or "")
    cached_csv = _get_cached_export_csv(cache_key)
    if cached_csv is not None:
        return Response(
            content=cached_csv,
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": "attachment; filename=recommendations_export.csv",
                "X-Export-Cache": "hit",
            },
        )

    csv_bytes = _build_export_csv_bytes(context, request_timestamp or None)
    _set_cached_export_csv(cache_key, csv_bytes)

    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=recommendations_export.csv",
            "X-Export-Cache": "miss",
        },
    )


@app.get("/cell/{cellname}/history")
def cell_history(cellname: str) -> list[dict[str, Any]]:
    key = _normalize_cellname(cellname)
    context = _get_active_context(app)
    observations_df = context.get("observations_df")

    if not isinstance(observations_df, pd.DataFrame) or observations_df.empty:
        raise CellNotFoundError(key)

    rows = observations_df[observations_df["cell_name"].astype(str).str.strip().eq(key)].copy()
    if rows.empty:
        raise CellNotFoundError(key)

    rows = rows.sort_values("timestamp")

    history: list[dict[str, Any]] = []
    for row in rows.itertuples(index=False):
        ts = pd.to_datetime(getattr(row, "timestamp"), errors="coerce")
        history.append(
            {
                "datetime": ts.isoformat() if pd.notna(ts) else "",
                "prb_load": _to_float(getattr(row, "prb_load", None), 0.0),
                "active_users": _to_float(getattr(row, "active_users", None), 0.0),
                "rrc_users": _to_float(getattr(row, "rrc_users", None), 0.0),
                "throughput_kbps": _to_float(getattr(row, "throughput_kbps", None), 0.0),
                "cqi": _to_float(getattr(row, "cqi", None), 0.0),
            }
        )

    return history


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.api:app", host="0.0.0.0", port=8000, reload=False)
