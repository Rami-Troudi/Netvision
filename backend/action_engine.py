"""Rule-based congestion decision engine for 4G/5G operations."""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

from backend.common import normalize_band as _normalize_band
from backend.common import to_float as _to_float
from backend.core_rules import (
    ACTION_NAME_TO_RATE_KEY as _ACTION_NAME_TO_RATE_KEY,
    ACTIVE_USERS_CRITICAL,
    CQI_POOR,
    LOST_GB_BASELINE,
    LOST_UE_BASELINE,
    PRB_MEDIUM,
    PRB_SATURATED,
    RECOVERY_RATES,
    STRUCTURAL_BUSY_HOUR_PRB,
    THROUGHPUT_DEGRADED,
    is_congested as _is_congested,
)


ORANGE_THRESHOLDS = {
    "PRB_SATURATED": PRB_SATURATED,
    "PRB_REBALANCE_HEADROOM": PRB_MEDIUM,
    "THROUGHPUT_DEGRADED": THROUGHPUT_DEGRADED,
    "ACTIVE_USERS_CRITICAL": ACTIVE_USERS_CRITICAL,
    "RRC_USERS_CRITICAL": ACTIVE_USERS_CRITICAL,
    "CQI_POOR": CQI_POOR,
    "STRUCTURAL_BUSY_HOUR_PRB": STRUCTURAL_BUSY_HOUR_PRB,
}

logger = logging.getLogger(__name__)

NEIGHBOR_RADIUS_KM = 3.0

ACTION_ORDER = {
    "Load Rebalancing": 1,
    "Carrier Extension": 2,
    "Tilt Adjustment": 3,
    "Add Sector": 4,
    "Add Site": 5,
    "No Action Required": 99,
}




def _empty_context() -> dict[str, Any]:
    return {
        "baseline_df": pd.DataFrame(
            columns=[
                "cell_name",
                "enodeb_name",
                "longitude",
                "latitude",
                "azimuth",
                "frequency_band",
                "localcell_id",
                "cell_fdd_tdd_indication",
            ]
        ),
        "observations_df": pd.DataFrame(
            columns=[
                "cell_name",
                "timestamp",
                "date_iso",
                "hour",
                "prb_load",
                "throughput_kbps",
                "active_users",
                "rrc_users",
                "cqi",
                "enodeb_name",
                "longitude",
                "latitude",
                "azimuth",
                "frequency_band",
                "localcell_id",
            ]
        ),
        "busy_hour_profile": {},
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source": "empty",
    }


def _parse_timestamp(value: Any) -> pd.Timestamp:
    if isinstance(value, pd.Timestamp):
        return value
    if isinstance(value, datetime):
        return pd.Timestamp(value)

    text = str(value or "").strip()
    if not text:
        return pd.NaT

    for fmt in (
        "%d-%m-%Y %H:%M",
        "%d-%m-%Y %H:%M:%S",
        "%d-%m-%Y",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
    ):
        try:
            return pd.Timestamp(datetime.strptime(text, fmt))
        except ValueError:
            continue

    parsed = pd.to_datetime(text, errors="coerce")
    if pd.isna(parsed):
        return pd.NaT
    return parsed


def _format_date_iso(ts: pd.Timestamp) -> str:
    if pd.isna(ts):
        return ""
    return ts.strftime("%Y-%m-%d")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        out = int(float(value))
    except (TypeError, ValueError):
        return default
    return out


def _safe_float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    out = _to_float(value, default=float("nan"))
    if pd.isna(out):
        return None
    return float(out)


def _to_str(value: Any) -> str:
    return str(value or "").strip()


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))
    return r * c


def _angular_diff_deg(az1: float | None, az2: float | None) -> float | None:
    if az1 is None or az2 is None:
        return None
    diff = abs(az1 - az2) % 360.0
    return min(diff, 360.0 - diff)


def _is_zero_traffic_row(
    prb_load: float | None,
    throughput_kbps: float | None,
    active_users: float | None,
    rrc_users: float | None,
    cqi: float | None,
) -> bool:
    values = [prb_load, throughput_kbps, active_users, rrc_users, cqi]
    has_signal = False
    for value in values:
        if value is None:
            continue
        if float(value) > 0.0:
            has_signal = True
            break
    return not has_signal


def _normalize_baseline_df(baseline: dict[str, Any]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for cell_name, info in (baseline or {}).items():
        if not isinstance(info, dict):
            continue
        rows.append(
            {
                "cell_name": _to_str(cell_name),
                "enodeb_name": _to_str(info.get("enodeb_name")),
                "longitude": _safe_float_or_none(info.get("longitude")),
                "latitude": _safe_float_or_none(info.get("latitude")),
                "azimuth": _safe_float_or_none(info.get("azimuth")),
                "frequency_band": _to_str(info.get("frequency_band")),
                "localcell_id": _to_str(info.get("localcell_id")),
                "cell_fdd_tdd_indication": _to_str(info.get("cell_fdd_tdd_indication")),
            }
        )

    if not rows:
        return _empty_context()["baseline_df"]

    out = pd.DataFrame(rows)
    out = out[out["cell_name"].astype(str).str.len() > 0].copy()
    out = out.drop_duplicates(subset=["cell_name"], keep="last")
    out = out.reset_index(drop=True)
    return out


def _read_slice_observations(file_path: Path) -> dict[str, dict[str, Any]]:
    suffix = file_path.suffix.lower()

    if suffix == ".json":
        payload = json.loads(file_path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            observations = payload.get("observations")
            if isinstance(observations, dict):
                return observations
        return {}

    if suffix == ".parquet":
        con = duckdb.connect()
        try:
            df = con.execute("SELECT * FROM read_parquet(?)", [str(file_path)]).fetchdf()
        finally:
            con.close()

        observations: dict[str, dict[str, Any]] = {}
        if df.empty:
            return observations

        for row in df.to_dict(orient="records"):
            cell_name = _to_str(row.get("cell_name"))
            if not cell_name:
                continue
            observations[cell_name] = dict(row)
        return observations

    return {}


def _observation_to_row(
    *,
    cell_name: str,
    timestamp: pd.Timestamp,
    observation: dict[str, Any],
    baseline_meta: dict[str, Any] | None,
) -> dict[str, Any] | None:
    prb_load = _safe_float_or_none(
        observation.get("prb_load", observation.get("load", observation.get("ft_physical_resource_blocks_load_dl")))
    )
    throughput_kbps = _safe_float_or_none(
        observation.get(
            "throughput_kbps",
            observation.get(
                "throughput",
                observation.get("ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_"),
            ),
        )
    )
    active_users = _safe_float_or_none(
        observation.get("active_users", observation.get("l_traffic_activeuser_dl_avg", observation.get("traffic")))
    )
    rrc_users = _safe_float_or_none(
        observation.get("rrc_users", observation.get("ft_average_nb_of_users__ues_rrc_connected"))
    )
    cqi = _safe_float_or_none(
        observation.get("cqi", observation.get("ft_4g_lte_average_reported_cqi"))
    )
    traffic_volume_gb = _safe_float_or_none(
        observation.get("traffic_volume_gb", observation.get("ft_4g_lte_dl_traffic_volume__gbytes"))
    )
    ta = _safe_float_or_none(observation.get("ta", observation.get("ot_average_ta")))
    signal_power = _safe_float_or_none(observation.get("signal_power", observation.get("referencesignalpwr")))

    if _is_zero_traffic_row(prb_load, throughput_kbps, active_users, rrc_users, cqi):
        return None

    baseline_meta = baseline_meta or {}
    return {
        "cell_name": cell_name,
        "timestamp": timestamp,
        "date_iso": _format_date_iso(timestamp),
        "hour": int(timestamp.hour) if not pd.isna(timestamp) else None,
        "prb_load": prb_load,
        "throughput_kbps": throughput_kbps,
        "active_users": active_users,
        "rrc_users": rrc_users,
        "cqi": cqi,
        "traffic_volume_gb": traffic_volume_gb,
        "ta": ta,
        "signal_power": signal_power,
        "enodeb_name": _to_str(observation.get("enodeb_name") or baseline_meta.get("enodeb_name")),
        "longitude": _safe_float_or_none(observation.get("longitude") or baseline_meta.get("longitude")),
        "latitude": _safe_float_or_none(observation.get("latitude") or baseline_meta.get("latitude")),
        "azimuth": _safe_float_or_none(observation.get("azimuth") or baseline_meta.get("azimuth")),
        "frequency_band": _to_str(observation.get("frequency_band") or baseline_meta.get("frequency_band")),
        "localcell_id": _to_str(observation.get("localcell_id") or baseline_meta.get("localcell_id")),
    }


def _normalize_observations_df(
    *,
    baseline_df: pd.DataFrame,
    slices: list[dict[str, Any]],
) -> pd.DataFrame:
    if not slices:
        return _empty_context()["observations_df"]

    baseline_lookup = {
        _to_str(row.cell_name): {
            "enodeb_name": _to_str(row.enodeb_name),
            "longitude": _safe_float_or_none(row.longitude),
            "latitude": _safe_float_or_none(row.latitude),
            "azimuth": _safe_float_or_none(row.azimuth),
            "frequency_band": _to_str(row.frequency_band),
            "localcell_id": _to_str(row.localcell_id),
        }
        for row in baseline_df.itertuples(index=False)
    }

    rows: list[dict[str, Any]] = []

    for slice_entry in slices:
        if not isinstance(slice_entry, dict):
            continue
        raw_ts = slice_entry.get("timestamp")
        ts = _parse_timestamp(raw_ts)
        if pd.isna(ts):
            continue

        observations = slice_entry.get("observations")
        if not isinstance(observations, dict):
            continue

        for cell_name_raw, observation in observations.items():
            if not isinstance(observation, dict):
                continue
            cell_name = _to_str(cell_name_raw)
            if not cell_name:
                continue

            row = _observation_to_row(
                cell_name=cell_name,
                timestamp=ts,
                observation=observation,
                baseline_meta=baseline_lookup.get(cell_name),
            )
            if row is not None:
                rows.append(row)

    if not rows:
        return _empty_context()["observations_df"]

    out = pd.DataFrame(rows)
    out["timestamp"] = pd.to_datetime(out["timestamp"], errors="coerce")
    out = out[out["timestamp"].notna()].copy()
    out = out.sort_values(["cell_name", "timestamp"]).reset_index(drop=True)
    return out


def detect_busy_hours(cell_df: pd.DataFrame) -> set[int]:
    """Detect structural busy hours with groupby + percentile thresholds."""
    if not isinstance(cell_df, pd.DataFrame) or cell_df.empty:
        return set()

    if "ft_physical_resource_blocks_load_dl" in cell_df.columns:
        prb_col = "ft_physical_resource_blocks_load_dl"
    elif "prb_load" in cell_df.columns:
        prb_col = "prb_load"
    elif "load" in cell_df.columns:
        prb_col = "load"
    else:
        return set()

    if "hour" not in cell_df.columns:
        return set()

    tmp = cell_df[["hour", prb_col]].copy()
    tmp["hour"] = pd.to_numeric(tmp["hour"], errors="coerce")
    tmp[prb_col] = pd.to_numeric(tmp[prb_col], errors="coerce")
    tmp = tmp.dropna(subset=["hour", prb_col])
    if tmp.empty:
        return set()

    hourly_mean = tmp.groupby("hour", as_index=True)[prb_col].mean()
    if hourly_mean.empty:
        return set()

    percentile80 = float(np.percentile(hourly_mean.values, 80))
    busy_hours = {
        int(hour)
        for hour, mean_prb in hourly_mean.items()
        if float(mean_prb) > 75.0 or float(mean_prb) > percentile80
    }

    # Fallback for single-day uploads: treat any observed hour with PRB > 75 as potential busy hour.
    n_days = 0
    if "timestamp" in cell_df.columns:
        ts = pd.to_datetime(cell_df["timestamp"], errors="coerce")
        if ts.notna().any():
            n_days = int(ts.dt.date.nunique())
    elif "date_iso" in cell_df.columns:
        ds = pd.to_datetime(cell_df["date_iso"], errors="coerce")
        if ds.notna().any():
            n_days = int(ds.dt.date.nunique())

    if n_days <= 1:
        direct_busy_hours = tmp.loc[tmp[prb_col] > 75.0, "hour"].tolist()
        busy_hours.update(int(hour) for hour in direct_busy_hours)

    return busy_hours


def _build_busy_hour_profile(observations_df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    profiles: dict[str, dict[str, Any]] = {}
    if observations_df.empty:
        return profiles

    valid = observations_df[observations_df["prb_load"].notna()].copy()
    if valid.empty:
        return profiles

    for cell_name, group in valid.groupby("cell_name"):
        if group.empty:
            continue

        detect_df = group[["hour", "prb_load", "timestamp"]].rename(
            columns={"prb_load": "ft_physical_resource_blocks_load_dl"}
        )
        busy_hour_set = detect_busy_hours(detect_df)

        hourly = (
            group.groupby("hour", as_index=False)["prb_load"]
            .agg(mean_prb="mean", std_prb="std", samples="count")
            .sort_values("hour")
            .reset_index(drop=True)
        )

        mean_values = hourly["mean_prb"].dropna().tolist()
        q80 = float(np.percentile(mean_values, 80)) if mean_values else 0.0

        busy_hours = sorted(int(hour) for hour in busy_hour_set)

        hour_stats: dict[int, dict[str, Any]] = {}
        for row in hourly.itertuples(index=False):
            hour_int = int(row.hour)
            mean_prb = _to_float(row.mean_prb)
            std_prb = 0.0 if pd.isna(row.std_prb) else _to_float(row.std_prb)
            hour_stats[hour_int] = {
                "mean_prb": round(mean_prb, 4),
                "std_prb": round(std_prb, 4),
                "samples": int(row.samples),
                "is_busy_hour": bool(hour_int in busy_hours),
            }

        profiles[str(cell_name)] = {
            "busy_hours": busy_hours,
            "hour_stats": hour_stats,
            "q80_prb": round(q80, 4),
        }

    return profiles


def _build_context(
    *,
    baseline_df: pd.DataFrame,
    observations_df: pd.DataFrame,
    source: str,
) -> dict[str, Any]:
    out = {
        "baseline_df": baseline_df.reset_index(drop=True),
        "observations_df": observations_df.reset_index(drop=True),
        "busy_hour_profile": _build_busy_hour_profile(observations_df),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
    }

    return out


def build_context_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    baseline = payload.get("baseline")
    slices = payload.get("slices")

    if not isinstance(baseline, dict):
        raise ValueError("Payload baseline must be an object")
    if not isinstance(slices, list):
        raise ValueError("Payload slices must be an array")

    baseline_df = _normalize_baseline_df(baseline)
    observations_df = _normalize_observations_df(baseline_df=baseline_df, slices=slices)
    source = _to_str(payload.get("source") or "uploaded")

    return _build_context(baseline_df=baseline_df, observations_df=observations_df, source=source)


def build_context_from_runtime(project_root: Path) -> dict[str, Any]:
    runtime_dir = project_root / "runtime_data"
    baseline_path = runtime_dir / "baseline.json"
    time_index_path = runtime_dir / "time_index.json"
    time_data_dir = runtime_dir / "time_data"

    if not baseline_path.exists() or not time_index_path.exists() or not time_data_dir.exists():
        return _empty_context()

    baseline_payload = json.loads(baseline_path.read_text(encoding="utf-8"))
    if not isinstance(baseline_payload, dict):
        return _empty_context()

    baseline_df = _normalize_baseline_df(baseline_payload)

    index_payload = json.loads(time_index_path.read_text(encoding="utf-8"))
    timestamps = index_payload.get("timestamps") if isinstance(index_payload, dict) else None
    if not isinstance(timestamps, list):
        return _build_context(
            baseline_df=baseline_df,
            observations_df=_empty_context()["observations_df"],
            source="runtime",
        )

    slices: list[dict[str, Any]] = []
    for entry in timestamps:
        if not isinstance(entry, dict):
            continue
        filename = _to_str(entry.get("filename"))
        raw_timestamp = entry.get("timestamp")
        if not filename:
            continue

        file_path = (time_data_dir / filename).resolve()
        if not file_path.exists() or not file_path.is_file():
            continue

        observations = _read_slice_observations(file_path)
        slices.append(
            {
                "timestamp": raw_timestamp,
                "observations": observations,
            }
        )

    observations_df = _normalize_observations_df(baseline_df=baseline_df, slices=slices)
    return _build_context(baseline_df=baseline_df, observations_df=observations_df, source="runtime")


def _threshold_flags(kpis: dict[str, Any]) -> dict[str, bool]:
    prb = _to_float(kpis.get("prb_load"), 0.0)
    throughput = _to_float(kpis.get("throughput_kbps"), 0.0)
    active_users = _to_float(kpis.get("active_users"), 0.0)
    rrc_users = _to_float(kpis.get("rrc_users"), 0.0)
    cqi = _to_float(kpis.get("cqi"), 0.0)

    prb_saturated = prb > ORANGE_THRESHOLDS["PRB_SATURATED"]
    throughput_degraded = throughput < ORANGE_THRESHOLDS["THROUGHPUT_DEGRADED"]
    active_queue_critical = active_users > ORANGE_THRESHOLDS["ACTIVE_USERS_CRITICAL"]
    rrc_queue_signal = rrc_users > ORANGE_THRESHOLDS["RRC_USERS_CRITICAL"]
    cqi_poor = cqi < ORANGE_THRESHOLDS["CQI_POOR"]

    congestion_confirmed = prb_saturated and (throughput_degraded or active_queue_critical or cqi_poor)

    return {
        "prb_saturated": prb_saturated,
        "throughput_degraded": throughput_degraded,
        "active_queue_critical": active_queue_critical,
        "rrc_queue_signal": rrc_queue_signal,
        "cqi_poor": cqi_poor,
        "congestion_confirmed": congestion_confirmed,
    }


def _format_threshold_reason(flags: dict[str, bool]) -> str:
    reasons: list[str] = []
    if flags.get("prb_saturated"):
        reasons.append("PRB load above 90%")
    if flags.get("throughput_degraded"):
        reasons.append("throughput below 4000 kbps")
    if flags.get("active_queue_critical"):
        reasons.append("active users above 4")
    if flags.get("rrc_queue_signal"):
        reasons.append("RRC users above 4")
    if flags.get("cqi_poor"):
        reasons.append("CQI below 8")
    return "; ".join(reasons)


def _loss_gain_for_recovery(
    recovery_rate: float,
    lost_ue: int = LOST_UE_BASELINE,
    lost_gb: float = LOST_GB_BASELINE,
) -> tuple[int, float]:
    ratio = max(0.0, min(1.0, recovery_rate / 100.0))
    gain_ue = int(round(lost_ue * ratio))
    gain_gb = round(lost_gb * ratio, 2)
    return gain_ue, gain_gb


def _build_action(
    action_name: str,
    reason: str,
    recovery_rate: float,
    tier: str,
    *,
    lost_ue: int = LOST_UE_BASELINE,
    lost_gb: float = LOST_GB_BASELINE,
) -> dict[str, Any]:
    gain_ue, gain_gb = _loss_gain_for_recovery(recovery_rate, lost_ue=lost_ue, lost_gb=lost_gb)
    return {
        "action_name": action_name,
        "action": action_name,
        "reason": reason,
        "tier": tier,
        "confidence": "high",
        "recovery_rate": recovery_rate,
        "estimated_recovery_pct": int(round(recovery_rate)),
        "gain_ue": gain_ue,
        "gain_gb": gain_gb,
    }


def _recovery_ratio_from_action(action: dict[str, Any] | None) -> float:
    if not isinstance(action, dict):
        return 0.0

    raw_recovery = _safe_float_or_none(action.get("recovery_rate"))
    ratio = 0.0
    if raw_recovery is not None:
        ratio = raw_recovery / 100.0 if raw_recovery > 1.0 else raw_recovery

    if ratio <= 0.0:
        action_name = _to_str(action.get("action_name") or action.get("action"))
        rate_key = _ACTION_NAME_TO_RATE_KEY.get(action_name)
        if rate_key:
            ratio = RECOVERY_RATES.get(rate_key, 0.0) / 100.0

    return max(0.0, min(1.0, float(ratio)))


def _pick_current_row(
    *,
    cell_name: str,
    observations_df: pd.DataFrame,
    request_timestamp: pd.Timestamp,
) -> pd.Series | None:
    cell_rows = observations_df[observations_df["cell_name"].astype(str).str.strip().eq(cell_name)]
    if cell_rows.empty:
        return None

    if not pd.isna(request_timestamp):
        exact_rows = cell_rows[cell_rows["timestamp"].eq(request_timestamp)]
        if not exact_rows.empty:
            return exact_rows.sort_values("timestamp").iloc[-1]

    if "prb_load" in cell_rows.columns:
        return cell_rows.sort_values(["prb_load", "timestamp"]).iloc[-1]

    return cell_rows.sort_values("timestamp").iloc[-1]




def _site_prefix_from_cell_name(cell_name: str) -> str:
    parts = [part for part in _to_str(cell_name).split("_") if part]
    if len(parts) >= 2:
        return "_".join(parts[:2]).lower()
    if len(parts) == 1:
        return parts[0].lower()
    return ""


def _band_suffix_from_cell_name(cell_name: str) -> str | None:
    tail = _to_str(cell_name).split("_")[-1].lower()
    if tail.startswith("h"):
        return "h"
    if tail.startswith("l"):
        return "l"
    if tail.startswith("f"):
        return "f"
    return None


def _build_cells_snapshot_df(
    *,
    baseline_df: pd.DataFrame,
    observations_df: pd.DataFrame,
    request_timestamp: pd.Timestamp,
) -> pd.DataFrame:
    columns = [
        "cell_name",
        "enodeb_name",
        "azimuth",
        "prb_load",
        "cqi",
        "site_prefix",
        "ft_physical_resource_blocks_load_dl",
        "ft_4g_lte_average_reported_cqi",
    ]
    if observations_df.empty:
        return pd.DataFrame(columns=columns)

    if not pd.isna(request_timestamp):
        scoped = observations_df[observations_df["timestamp"].eq(request_timestamp)].copy()
    else:
        scoped = pd.DataFrame()

    if scoped.empty:
        scoped = observations_df.copy()

    snapshot = (
        scoped.sort_values("timestamp")
        .groupby("cell_name", as_index=False)
        .tail(1)
        .reset_index(drop=True)
    )
    if snapshot.empty:
        return pd.DataFrame(columns=columns)

    out = pd.DataFrame()
    out["cell_name"] = snapshot["cell_name"].astype(str).str.strip()
    out["enodeb_name"] = snapshot["enodeb_name"] if "enodeb_name" in snapshot.columns else ""
    out["azimuth"] = snapshot["azimuth"] if "azimuth" in snapshot.columns else None
    out["prb_load"] = snapshot["prb_load"] if "prb_load" in snapshot.columns else None
    out["cqi"] = snapshot["cqi"] if "cqi" in snapshot.columns else None

    if not baseline_df.empty:
        base_meta = baseline_df[["cell_name", "enodeb_name", "azimuth"]].copy()
        base_meta["cell_name"] = base_meta["cell_name"].astype(str).str.strip()
        base_meta = base_meta.drop_duplicates(subset=["cell_name"], keep="last")
        out = out.merge(base_meta, on="cell_name", how="left", suffixes=("", "_base"))
        out["enodeb_name"] = out["enodeb_name"].where(
            out["enodeb_name"].astype(str).str.strip().ne(""),
            out["enodeb_name_base"],
        )
        out["azimuth"] = out["azimuth"].where(out["azimuth"].notna(), out["azimuth_base"])
        out = out.drop(columns=["enodeb_name_base", "azimuth_base"], errors="ignore")

    out["site_prefix"] = out["cell_name"].map(_site_prefix_from_cell_name)
    out["ft_physical_resource_blocks_load_dl"] = out["prb_load"]
    out["ft_4g_lte_average_reported_cqi"] = out["cqi"]
    return out[columns]


def score_neighbors(congested_cell: dict[str, Any], all_cells_df: pd.DataFrame) -> list[dict[str, Any]]:
    """Score neighbor eligibility using weighted PRB headroom, CQI quality, and azimuth alignment."""
    if not isinstance(congested_cell, dict):
        return []
    if not isinstance(all_cells_df, pd.DataFrame) or all_cells_df.empty:
        return []

    key = _to_str(congested_cell.get("cell_name"))
    if not key:
        return []

    target_enodeb = _to_str(congested_cell.get("enodeb_name"))
    target_prefix = _site_prefix_from_cell_name(key)
    target_azimuth = _safe_float_or_none(congested_cell.get("azimuth"))

    ranked: list[dict[str, Any]] = []
    for row in all_cells_df.itertuples(index=False):
        neighbor_name = _to_str(getattr(row, "cell_name", ""))
        if not neighbor_name or neighbor_name == key:
            continue

        neighbor_enodeb = _to_str(getattr(row, "enodeb_name", ""))
        neighbor_prefix = _to_str(getattr(row, "site_prefix", "")) or _site_prefix_from_cell_name(neighbor_name)
        if not (
            (target_enodeb and neighbor_enodeb == target_enodeb)
            or (target_prefix and neighbor_prefix == target_prefix)
        ):
            continue

        neighbor_prb = _safe_float_or_none(getattr(row, "ft_physical_resource_blocks_load_dl", None))
        if neighbor_prb is None:
            neighbor_prb = _safe_float_or_none(getattr(row, "prb_load", None))
        if neighbor_prb is None or neighbor_prb >= ORANGE_THRESHOLDS["PRB_REBALANCE_HEADROOM"]:
            continue

        neighbor_cqi = _safe_float_or_none(getattr(row, "ft_4g_lte_average_reported_cqi", None))
        if neighbor_cqi is None:
            neighbor_cqi = _safe_float_or_none(getattr(row, "cqi", None))
        neighbor_azimuth = _safe_float_or_none(getattr(row, "azimuth", None))

        prb_headroom = max(0.0, min(1.0, (100.0 - neighbor_prb) / 100.0))
        cqi_quality = max(0.0, min(1.0, _to_float(neighbor_cqi, 0.0) / 15.0))

        if target_azimuth is None or neighbor_azimuth is None:
            azimuth_alignment = 0.5
        else:
            abs_diff = abs(target_azimuth - neighbor_azimuth)
            angular_distance = min(abs_diff, 360.0 - abs_diff)
            azimuth_alignment = max(0.0, min(1.0, 1.0 - (angular_distance / 180.0)))

        score = round((prb_headroom + cqi_quality + azimuth_alignment) / 3.0, 6)
        if score <= 0.5:
            continue

        ranked.append(
            {
                "cell_name": neighbor_name,
                "score": score,
                "prb_load": round(neighbor_prb, 2),
            }
        )

    ranked.sort(key=lambda item: (-_to_float(item.get("score"), 0.0), _to_float(item.get("prb_load"), 100.0)))
    return ranked[:3]


def _site_wide_saturation_status(
    *,
    enodeb_name: str,
    observations_df: pd.DataFrame,
    request_timestamp: pd.Timestamp,
) -> tuple[bool, int, int]:
    target_enodeb = _to_str(enodeb_name)
    if not target_enodeb:
        return False, 0, 0
    if not isinstance(observations_df, pd.DataFrame) or observations_df.empty:
        return False, 0, 0

    site_rows = observations_df[
        observations_df["enodeb_name"].astype(str).str.strip().eq(target_enodeb)
    ].copy()
    if site_rows.empty:
        return False, 0, 0

    if not pd.isna(request_timestamp):
        scoped = site_rows[site_rows["timestamp"].eq(request_timestamp)].copy()
    else:
        scoped = pd.DataFrame()

    if scoped.empty:
        scoped = (
            site_rows.sort_values("timestamp")
            .groupby("cell_name", as_index=False)
            .tail(1)
            .reset_index(drop=True)
        )
    else:
        scoped = (
            scoped.sort_values("timestamp")
            .groupby("cell_name", as_index=False)
            .tail(1)
            .reset_index(drop=True)
        )

    total_site_cells = int(len(scoped))
    if total_site_cells <= 0:
        return False, 0, 0

    congested_site_cells = 0
    for row in scoped.itertuples(index=False):
        row_flags = _threshold_flags(
            {
                "prb_load": getattr(row, "prb_load", None),
                "throughput_kbps": getattr(row, "throughput_kbps", None),
                "active_users": getattr(row, "active_users", None),
                "rrc_users": getattr(row, "rrc_users", None),
                "cqi": getattr(row, "cqi", None),
            }
        )
        if row_flags.get("congestion_confirmed"):
            congested_site_cells += 1

    site_wide_saturation = (congested_site_cells / total_site_cells) > 0.5

    # New logic: Time-aware check. Only return True if site is saturated on at least 3 separate days.
    if site_wide_saturation and "timestamp" in site_rows.columns:
        congested_days = set()
        for ts, group in site_rows.groupby("timestamp"):
            if len(congested_days) >= 3:
                break

            ts_cells = len(group["cell_name"].unique())
            if ts_cells <= 0:
                continue

            ts_congested = 0
            for r in group.itertuples(index=False):
                r_flags = _threshold_flags({
                    "prb_load": getattr(r, "prb_load", None),
                    "throughput_kbps": getattr(r, "throughput_kbps", None),
                    "active_users": getattr(r, "active_users", None),
                    "rrc_users": getattr(r, "rrc_users", None),
                    "cqi": getattr(r, "cqi", None),
                })
                if r_flags.get("congestion_confirmed"):
                    ts_congested += 1
            
            if (ts_congested / ts_cells) > 0.5:
                ts_date = pd.to_datetime(ts).date()
                if pd.notna(ts_date):
                    congested_days.add(ts_date)
        
        if len(congested_days) < 3:
            site_wide_saturation = False

    return site_wide_saturation, congested_site_cells, total_site_cells


def _find_underloaded_capacity_peers(
    *,
    cell_name: str,
    all_cells_df: pd.DataFrame,
) -> list[str]:
    key = _to_str(cell_name)
    if not isinstance(all_cells_df, pd.DataFrame) or all_cells_df.empty:
        return []

    target_rows = all_cells_df[all_cells_df["cell_name"].astype(str).str.strip().eq(key)]
    if target_rows.empty:
        return []

    target_band = _to_str(target_rows.iloc[0].get("frequency_band", "")).lower()
    look_for = []
    
    # Restrict extensions to B3 (1800) <-> B1 (2100) only. B20 (800) is excluded entirely.
    if "1800" in target_band or "b3" in target_band or key.endswith("h"):
        look_for = ["2100", "b1", "m"]  # B3 -> B1
    elif "2100" in target_band or "b1" in target_band or key.endswith("m"):
        look_for = ["1800", "b3", "h"]  # B1 -> B3
    else:
        return []

    prefix = _site_prefix_from_cell_name(key)
    peers: list[str] = []
    for row in all_cells_df.itertuples(index=False):
        peer_name = _to_str(getattr(row, "cell_name", ""))
        if not peer_name or peer_name == key:
            continue
        if _site_prefix_from_cell_name(peer_name) != prefix:
            continue

        peer_band = _to_str(getattr(row, "frequency_band", "")).lower()
        peer_suffix = _band_suffix_from_cell_name(peer_name)

        # Explicitly skip coverage bands (B20 / 800MHz)
        if "800" in peer_band or "b20" in peer_band or peer_suffix in {"l", "f"}:
            continue

        is_match = False
        for term in look_for:
            if term in peer_band or term == peer_suffix:
                is_match = True
                break

        if not is_match:
            continue

        peer_prb = _safe_float_or_none(getattr(row, "ft_physical_resource_blocks_load_dl", None))
        if peer_prb is None:
            peer_prb = _safe_float_or_none(getattr(row, "prb_load", None))
        if peer_prb is not None and peer_prb < 60.0:
            peers.append(peer_name)

    return sorted(set(peers))


def _busy_hour_congestion_summary(
    *,
    cell_name: str,
    observations_df: pd.DataFrame,
    busy_profile: dict[str, Any],
) -> tuple[list[int], list[int], bool]:
    busy_hours = list(busy_profile.get("busy_hours", []))
    if not busy_hours:
        return [], [], False

    cell_rows = observations_df[observations_df["cell_name"].astype(str).str.strip().eq(cell_name)]
    if cell_rows.empty:
        return busy_hours, [], False

    congested_hours: set[int] = set()
    for row in cell_rows.itertuples(index=False):
        hour = _safe_int(getattr(row, "hour", -1), -1)
        if hour not in busy_hours:
            continue

        flags = _threshold_flags(
            {
                "prb_load": getattr(row, "prb_load", None),
                "throughput_kbps": getattr(row, "throughput_kbps", None),
                "active_users": getattr(row, "active_users", None),
                "rrc_users": getattr(row, "rrc_users", None),
                "cqi": getattr(row, "cqi", None),
            }
        )
        if flags["congestion_confirmed"]:
            congested_hours.add(hour)

    sorted_congested = sorted(congested_hours)
    all_busy_hours_congested = bool(busy_hours) and all(hour in congested_hours for hour in busy_hours)
    return busy_hours, sorted_congested, all_busy_hours_congested


def evaluate_cell(
    *,
    cell_name: str,
    context: dict[str, Any],
    request_kpis: dict[str, Any] | None = None,
    request_timestamp: Any = None,
) -> dict[str, Any]:
    key = _to_str(cell_name)
    if not key:
        raise ValueError("cell_name must be a non-empty string")

    baseline_df = context.get("baseline_df")
    observations_df = context.get("observations_df")
    busy_hour_profile = context.get("busy_hour_profile") or {}

    if not isinstance(baseline_df, pd.DataFrame):
        baseline_df = _empty_context()["baseline_df"]
    if not isinstance(observations_df, pd.DataFrame):
        observations_df = _empty_context()["observations_df"]

    ts = _parse_timestamp(request_timestamp)
    current_row = _pick_current_row(cell_name=key, observations_df=observations_df, request_timestamp=ts)

    baseline_rows = baseline_df[baseline_df["cell_name"].astype(str).str.strip().eq(key)]
    baseline_meta = baseline_rows.iloc[-1] if not baseline_rows.empty else pd.Series(dtype=object)

    if current_row is None and not request_kpis:
        raise ValueError(f"Cell '{key}' has no KPI data available")

    req = request_kpis or {}

    prb_load = _to_float(req.get("prb_load"), _to_float(current_row.get("prb_load") if current_row is not None else None, 0.0))
    throughput_kbps = _to_float(
        req.get("throughput"),
        _to_float(current_row.get("throughput_kbps") if current_row is not None else None, 0.0),
    )
    active_users = _to_float(
        req.get("active_users"),
        _to_float(current_row.get("active_users") if current_row is not None else None, 0.0),
    )
    rrc_users = _to_float(
        req.get("rrc_users"),
        _to_float(current_row.get("rrc_users") if current_row is not None else None, 0.0),
    )
    cqi = _to_float(req.get("cqi"), _to_float(current_row.get("cqi") if current_row is not None else None, 0.0))
    traffic_volume_gb = _to_float(
        req.get("traffic_volume_gb"),
        _to_float(current_row.get("traffic_volume_gb") if current_row is not None else None, 0.0),
    )
    ta = _to_float(req.get("ta"), _to_float(current_row.get("ta") if current_row is not None else None, 0.0))
    signal_power = _to_float(req.get("signal_power"), _to_float(current_row.get("signal_power") if current_row is not None else None, 0.0))

    if pd.isna(ts):
        ts = _parse_timestamp(current_row.get("timestamp") if current_row is not None else None)

    flags = _threshold_flags(
        {
            "prb_load": prb_load,
            "throughput_kbps": throughput_kbps,
            "active_users": active_users,
            "rrc_users": rrc_users,
            "cqi": cqi,
        }
    )

    profile = busy_hour_profile.get(key, {"busy_hours": [], "hour_stats": {}})
    busy_hours, congested_busy_hours, _ = _busy_hour_congestion_summary(
        cell_name=key,
        observations_df=observations_df,
        busy_profile=profile,
    )

    current_hour = _safe_int(ts.hour if not pd.isna(ts) else -1, -1)
    busy_hour_flag = current_hour in set(int(hour) for hour in busy_hours)
    if not busy_hours and prb_load > ORANGE_THRESHOLDS["STRUCTURAL_BUSY_HOUR_PRB"] and current_hour >= 0:
        busy_hour_flag = True
        busy_hours = sorted(set(busy_hours + [current_hour]))

    all_cells_df = _build_cells_snapshot_df(
        baseline_df=baseline_df,
        observations_df=observations_df,
        request_timestamp=ts,
    )

    target_azimuth = _safe_float_or_none(
        (baseline_meta.get("azimuth") if not baseline_meta.empty else None)
        or (current_row.get("azimuth") if current_row is not None else None)
    )
    target_enodeb = _to_str(
        (baseline_meta.get("enodeb_name") if not baseline_meta.empty else "")
        or (current_row.get("enodeb_name") if current_row is not None else "")
    )

    neighbors = score_neighbors(
        {
            "cell_name": key,
            "azimuth": target_azimuth,
            "enodeb_name": target_enodeb,
            "ft_physical_resource_blocks_load_dl": prb_load,
            "ft_4g_lte_average_reported_cqi": cqi,
        },
        all_cells_df,
    )
    top_neighbor = neighbors[0]["cell_name"] if neighbors else None

    capacity_peers = _find_underloaded_capacity_peers(
        cell_name=key,
        all_cells_df=all_cells_df,
    )

    threshold_reason = _format_threshold_reason(flags)
    is_congested = bool(flags["congestion_confirmed"])
    site_wide_saturation = False
    congested_site_cells = 0
    total_site_cells = 0
    if is_congested:
        site_wide_saturation, congested_site_cells, total_site_cells = _site_wide_saturation_status(
            enodeb_name=target_enodeb,
            observations_df=observations_df,
            request_timestamp=ts,
        )

    recommended_actions: list[dict[str, Any]] = []
    structural_ratio = (len(congested_busy_hours) / len(busy_hours)) if busy_hours else 0.0

    # --- Bug 1 fix: dynamic estimated_lost_ue/gb based on cell severity ---
    if is_congested:
        user_scale = max(1.0, active_users / ORANGE_THRESHOLDS["ACTIVE_USERS_CRITICAL"])
        prb_scale = max(1.0, prb_load / ORANGE_THRESHOLDS["PRB_SATURATED"])
        severity_multiplier = min(3.0, (user_scale + prb_scale) / 2.0)
        estimated_lost_ue = max(
            LOST_UE_BASELINE // 4,
            int(round(LOST_UE_BASELINE * severity_multiplier / 2.0)),
        )
        if traffic_volume_gb > 0:
            loss_ratio = max(0.1, min(0.6, (severity_multiplier / 3.0) * 0.40))
            estimated_lost_gb = round(traffic_volume_gb * loss_ratio, 2)
        else:
            estimated_lost_gb = round(LOST_GB_BASELINE * severity_multiplier / 2.0, 2)
    else:
        estimated_lost_ue = 0
        estimated_lost_gb = 0.0

    if is_congested:
        rebalancing_candidate = bool(neighbors) and not site_wide_saturation
        carrier_candidate = bool(capacity_peers)

        # Tilt candidate based on high TA or excessive power or plain poor coverage
        high_ta = bool(ta is not None and ta > 2.0)
        high_power = bool(signal_power is not None and signal_power > 12.0)
        poor_coverage = bool(cqi < ORANGE_THRESHOLDS["CQI_POOR"] or throughput_kbps < ORANGE_THRESHOLDS["THROUGHPUT_DEGRADED"])
        tilt_candidate = high_ta or high_power or poor_coverage

        if site_wide_saturation:
            saturation_reason = (
                f"{threshold_reason}; site-wide saturation detected on {target_enodeb} "
                f"({congested_site_cells}/{total_site_cells} cells congested)"
            )
            if structural_ratio > 0.80:
                recommended_actions = [
                    _build_action(
                        action_name="Add Site",
                        reason=saturation_reason,
                        recovery_rate=RECOVERY_RATES["new_site"],
                        tier="long_terme",
                        lost_ue=estimated_lost_ue,
                        lost_gb=estimated_lost_gb,
                    )
                ]
            else:
                recommended_actions = [
                    _build_action(
                        action_name="Add Sector",
                        reason=saturation_reason,
                        recovery_rate=RECOVERY_RATES["new_sector"],
                        tier="long_terme",
                        lost_ue=estimated_lost_ue,
                        lost_gb=estimated_lost_gb,
                    )
                ]
        elif rebalancing_candidate:
            neighbor_label = ", ".join(item["cell_name"] for item in neighbors)
            recommended_actions = [
                _build_action(
                    action_name="Load Rebalancing",
                    reason=f"{threshold_reason}; eligible neighbors with headroom ({neighbor_label})",
                    recovery_rate=RECOVERY_RATES["load_rebalancing"],
                    tier="court_terme",
                    lost_ue=estimated_lost_ue,
                    lost_gb=estimated_lost_gb,
                )
            ]
        elif carrier_candidate:
            peer_label = ", ".join(capacity_peers)
            recommended_actions = [
                _build_action(
                    action_name="Carrier Extension",
                    reason=(
                        f"{threshold_reason}; target capacity peers available on same site below 60% PRB "
                        f"({peer_label})"
                    ),
                    recovery_rate=RECOVERY_RATES["carrier_extension"],
                    tier="moyen_terme",
                    lost_ue=estimated_lost_ue,
                    lost_gb=estimated_lost_gb,
                )
            ]
        elif (
            busy_hour_flag
            and prb_load > ORANGE_THRESHOLDS["PRB_SATURATED"]
            and not rebalancing_candidate
            and not carrier_candidate
            and tilt_candidate
        ):
            tilt_reason = "high Timing Advance (TA) or excessive power" if (high_ta or high_power) else "busy-hour overload with poor coverage"
            recommended_actions = [
                _build_action(
                    action_name="Tilt Adjustment",
                    reason=f"{threshold_reason}; {tilt_reason}",
                    recovery_rate=RECOVERY_RATES["tilt_adjustment"],
                    tier="court_terme",
                    lost_ue=estimated_lost_ue,
                    lost_gb=estimated_lost_gb,
                )
            ]
        elif structural_ratio > 0.60 and not rebalancing_candidate and not carrier_candidate:
            structural_reason = (
                f"{threshold_reason}; structural congestion ratio {round(structural_ratio * 100, 1)}% "
                f"with no rebalancing/carrier candidate"
            )
            recommended_actions = [
                _build_action(
                    action_name="Add Sector",
                    reason=structural_reason,
                    recovery_rate=RECOVERY_RATES["new_sector"],
                    tier="long_terme",
                    lost_ue=estimated_lost_ue,
                    lost_gb=estimated_lost_gb,
                )
            ]
        elif tilt_candidate:
            tilt_reason = "high Timing Advance (TA) or excessive power" if (high_ta or high_power) else "poor CQI or degraded throughput"
            recommended_actions = [
                _build_action(
                    action_name="Tilt Adjustment",
                    reason=f"{threshold_reason}; {tilt_reason} with no higher-priority candidate",
                    recovery_rate=RECOVERY_RATES["tilt_adjustment"],
                    tier="court_terme",
                    lost_ue=estimated_lost_ue,
                    lost_gb=estimated_lost_gb,
                )
            ]
        else:
            # Cell is congested by PRB but signal quality is acceptable — capacity-driven
            recommended_actions = [
                _build_action(
                    action_name="Add Sector",
                    reason=f"{threshold_reason}; PRB-saturated but CQI/throughput acceptable — capacity-driven, manual review recommended",
                    recovery_rate=RECOVERY_RATES["new_sector"],
                    tier="long_terme",
                    lost_ue=estimated_lost_ue,
                    lost_gb=estimated_lost_gb,
                )
            ]

    if not is_congested:
        recommended_actions.append(
            {
                "action_name": "No Action Required",
                "action": "No Action Required",
                "reason": "Congestion thresholds are not jointly met",
                "tier": "none",
                "confidence": "high",
                "recovery_rate": 0.0,
                "estimated_recovery_pct": 0,
                "gain_ue": 0,
                "gain_gb": 0.0,
            }
        )

    recommended_actions.sort(key=lambda item: ACTION_ORDER.get(str(item.get("action_name")), 999))
    for index, action in enumerate(recommended_actions, start=1):
        action["priority_rank"] = index

    top_action = recommended_actions[0] if recommended_actions else None
    top_action_recovery_ratio = _recovery_ratio_from_action(top_action) if is_congested else 0.0
    if is_congested and isinstance(top_action, dict):
        normalized_recovery_pct = round(top_action_recovery_ratio * 100.0, 2)
        if _safe_float_or_none(top_action.get("recovery_rate")) is None:
            top_action["recovery_rate"] = normalized_recovery_pct
            top_action["estimated_recovery_pct"] = int(round(normalized_recovery_pct))
            top_action["gain_ue"] = round(estimated_lost_ue * top_action_recovery_ratio, 2)
            top_action["gain_gb"] = round(estimated_lost_gb * top_action_recovery_ratio, 2)

    estimated_gain_ue = round(estimated_lost_ue * top_action_recovery_ratio, 2) if is_congested else 0
    estimated_gain_gb = round(estimated_lost_gb * top_action_recovery_ratio, 2) if is_congested else 0.0

    # --- Bug 4 fix: null out top_neighbor when action is not Load Rebalancing ---
    top_action_name = str(
        (recommended_actions[0].get("action_name") or "") if recommended_actions else ""
    )
    if top_action_name != "Load Rebalancing":
        top_neighbor = None

    enodeb_name = _to_str(
        (baseline_meta.get("enodeb_name") if not baseline_meta.empty else "")
        or (current_row.get("enodeb_name") if current_row is not None else "")
    )
    frequency_band = _to_str(
        (baseline_meta.get("frequency_band") if not baseline_meta.empty else "")
        or (current_row.get("frequency_band") if current_row is not None else "")
    )

    date_iso = _format_date_iso(ts)
    hour_label = f"{current_hour:02d}" if current_hour >= 0 else ""

    return {
        "cellname": key,
        "enodeb_name": enodeb_name,
        "frequency_band": _normalize_band(frequency_band),
        "date": date_iso,
        "hour": hour_label,
        "current_kpis": {
            "prb_load": round(prb_load, 4),
            "throughput_kbps": round(throughput_kbps, 4),
            "active_users": round(active_users, 4),
            "rrc_users": round(rrc_users, 4),
            "cqi": round(cqi, 4),
            "traffic_loss_ue": estimated_lost_ue,
            "traffic_loss_gb": estimated_lost_gb,
        },
        "current_loss": {
            "ue": estimated_lost_ue,
            "gb": estimated_lost_gb,
        },
        "predicted_next_hour": {
            "prb_load": round(prb_load, 4),
            "active_users": round(active_users, 4),
            "throughput_kbps": round(throughput_kbps, 4),
        },
        "is_congested": is_congested,
        "busy_hour_flag": bool(busy_hour_flag),
        "busy_hours": busy_hours,
        "congested_busy_hours": congested_busy_hours,
        "structural_congestion": bool(structural_ratio > 0.60),
        "top_neighbors": neighbors,
        "top_neighbor_for_rebalancing": top_neighbor,
        "estimated_lost_ue": estimated_lost_ue,
        "estimated_lost_gb": estimated_lost_gb,
        "estimated_gain_ue": estimated_gain_ue,
        "estimated_gain_gb": round(estimated_gain_gb, 2),
        "recommended_actions": recommended_actions,
    }


def evaluate_all_cells_for_export(
    *,
    context: dict[str, Any],
    request_timestamp: Any = None,
) -> list[dict[str, Any]]:
    baseline_df = context.get("baseline_df")
    observations_df = context.get("observations_df")

    if not isinstance(baseline_df, pd.DataFrame):
        baseline_df = _empty_context()["baseline_df"]
    if not isinstance(observations_df, pd.DataFrame):
        observations_df = _empty_context()["observations_df"]

    cell_names = sorted(set(baseline_df["cell_name"].astype(str).tolist()) | set(observations_df["cell_name"].astype(str).tolist()))

    busy_hour_profile = context.get("busy_hour_profile") or {}

    rows: list[dict[str, Any]] = []
    for cell_name in cell_names:
        if not _to_str(cell_name):
            continue

        cell_timestamp = request_timestamp
        if not cell_timestamp:
            profile = busy_hour_profile.get(cell_name, {})
            hour_stats = profile.get("hour_stats", {})
            busy_hours = set(profile.get("busy_hours", []))

            peak_hour = None
            max_prb = -1.0

            for hour_str, stats in hour_stats.items():
                hour_int = int(hour_str)
                if hour_int in busy_hours:
                    mean_prb = stats.get("mean_prb", 0.0)
                    if mean_prb > max_prb:
                        max_prb = mean_prb
                        peak_hour = hour_int

            if peak_hour is not None:
                cell_rows = observations_df[observations_df["cell_name"].astype(str).str.strip().eq(cell_name)]
                if "hour" in cell_rows.columns:
                    hour_rows = cell_rows[pd.to_numeric(cell_rows["hour"], errors="coerce").fillna(-1).astype(int) == peak_hour]
                    if not hour_rows.empty:
                        best_row = hour_rows.sort_values(["prb_load", "timestamp"]).iloc[-1]
                        cell_timestamp = best_row.get("timestamp")

        try:
            evaluated = evaluate_cell(
                cell_name=cell_name,
                context=context,
                request_kpis=None,
                request_timestamp=cell_timestamp,
            )

            current_kpis = evaluated.get("current_kpis") or {}
            prb = _to_float(current_kpis.get("prb_load"), 0.0)
            throughput = _to_float(current_kpis.get("throughput_kbps"), 0.0)
            active_users = _to_float(current_kpis.get("active_users"), 0.0)
            if prb <= 0.0 and throughput <= 0.0 and active_users <= 0.0:
                continue

            rows.append(evaluated)
        except Exception as exc:
            logger.warning("evaluate_all_cells_for_export: skipping cell %s: %s", cell_name, exc)
            continue
    return rows
