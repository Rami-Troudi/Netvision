"""Action recommendation engine for 4G RAN congestion management."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

from backend.common import normalize_band as _normalize_band
from backend.common import to_bool as _to_bool
from backend.common import to_float as _to_float


MODULE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = MODULE_DIR.parent
MODEL_ASSETS_DIR = PROJECT_ROOT / "runtime_data" / "model_assets"
THRESHOLDS_PATH = MODEL_ASSETS_DIR / "thresholds.json"
CELL_PROFILE_PATH = MODEL_ASSETS_DIR / "cell_congestion_profile.parquet"


def _load_thresholds(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _load_profile(path: Path) -> pd.DataFrame:
    con = duckdb.connect()
    try:
        return con.execute("SELECT * FROM read_parquet(?)", [str(path)]).df()
    finally:
        con.close()


THRESHOLDS = _load_thresholds(THRESHOLDS_PATH)
CELL_CONGESTION_PROFILE = _load_profile(CELL_PROFILE_PATH)


TIER_ORDER = {"court_terme": 0, "moyen_terme": 1, "long_terme": 2, "none": 3}

ORANGE_LOSS_CONFIG = {
    "PRB_SATURATED": 90.0,
    "PRB_HIGH": 80.0,
    "PRB_MEDIUM": 70.0,
    "THROUGHPUT_DEGRADED": 4000.0,
    "THROUGHPUT_TARGET": 10000.0,
    "USERS_CRITICAL": 4.0,
    "UE_LOSS_COEFF": 0.5,
    "GB_PER_UE": 2.4,
}


def _is_congested_for_loss(load: float, throughput: float, active_users: float) -> bool:
    if load >= ORANGE_LOSS_CONFIG["PRB_SATURATED"]:
        return True
    if load >= ORANGE_LOSS_CONFIG["PRB_HIGH"] and throughput < ORANGE_LOSS_CONFIG["THROUGHPUT_DEGRADED"]:
        return True
    if active_users > ORANGE_LOSS_CONFIG["USERS_CRITICAL"] and load >= ORANGE_LOSS_CONFIG["PRB_MEDIUM"]:
        return True
    if throughput < ORANGE_LOSS_CONFIG["THROUGHPUT_DEGRADED"] and load >= ORANGE_LOSS_CONFIG["PRB_MEDIUM"]:
        return True
    return False


def _estimate_traffic_loss(active_users: float, load: float, throughput: float) -> tuple[int, float]:
    safe_users = max(0.0, _to_float(active_users))
    safe_load = max(0.0, _to_float(load))
    safe_throughput = max(0.0, _to_float(throughput, ORANGE_LOSS_CONFIG["THROUGHPUT_TARGET"]))

    if not _is_congested_for_loss(safe_load, safe_throughput, safe_users):
        return 0, 0.0

    excess_load = max(0.0, safe_load - ORANGE_LOSS_CONFIG["PRB_MEDIUM"]) / 100.0
    throughput_gap = max(0.0, ORANGE_LOSS_CONFIG["THROUGHPUT_TARGET"] - safe_throughput) / ORANGE_LOSS_CONFIG[
        "THROUGHPUT_TARGET"
    ]
    loss_ue = int(max(0.0, safe_users * excess_load * throughput_gap * ORANGE_LOSS_CONFIG["UE_LOSS_COEFF"]))
    loss_gb = round(loss_ue * ORANGE_LOSS_CONFIG["GB_PER_UE"], 1)
    return loss_ue, loss_gb


def _enrich_action_with_gains(action: dict[str, Any], current_loss_ue: int, current_loss_gb: float) -> None:
    recovery_rate = max(0.0, min(100.0, _to_float(action.get("estimated_recovery_pct"), 0.0)))
    gain_ue = int(round(current_loss_ue * (recovery_rate / 100.0)))
    gain_ue = max(0, min(current_loss_ue, gain_ue))
    gain_gb = round(current_loss_gb * (recovery_rate / 100.0), 1)
    gain_gb = max(0.0, min(current_loss_gb, gain_gb))

    action["recovery_rate"] = recovery_rate
    action["gain_ue"] = gain_ue
    action["gain_gb"] = gain_gb


def _find_column(
    df: pd.DataFrame,
    candidates: list[str],
    *,
    required: bool,
    df_name: str,
) -> str | None:
    for col in candidates:
        if col in df.columns:
            return col
    if required:
        raise KeyError(f"{df_name} missing required column. Expected one of: {candidates}")
    return None


def _latest_row(df: pd.DataFrame, timestamp_col: str | None) -> pd.Series:
    if timestamp_col is None:
        return df.iloc[-1]

    out = df.copy()
    out["_timestamp_"] = pd.to_datetime(out[timestamp_col], errors="coerce")
    if out["_timestamp_"].notna().any():
        max_ts = out["_timestamp_"].max()
        return out.loc[out["_timestamp_"].eq(max_ts)].iloc[-1]
    return out.iloc[-1]


def _build_action(
    action: str,
    tier: str,
    confidence: str,
    reason: str,
    estimated_recovery_pct: int,
) -> dict[str, Any]:
    return {
        "action": action,
        "tier": tier,
        "confidence": confidence,
        "reason": reason,
        "estimated_recovery_pct": estimated_recovery_pct,
        "priority_rank": 0,
    }


def recommend_actions(cell_state: dict) -> list[dict]:
    actions: list[dict[str, Any]] = []
    added_action_names: set[str] = set()

    current_users = _to_float(cell_state.get("current_users"))
    current_prb = _to_float(cell_state.get("current_prb"))
    current_thrput = _to_float(cell_state.get("current_thrput"))
    predicted_prb_next_hour = _to_float(cell_state.get("predicted_prb_next_hour"))
    current_cqi = _to_float(cell_state.get("current_cqi"))
    avg_prb_busy_hour = _to_float(cell_state.get("avg_prb_busy_hour"))
    avg_users_busy_hour = _to_float(cell_state.get("avg_users_busy_hour"))
    pct_congested = _to_float(cell_state.get("pct_congested"))
    neighbor_mean_prb_bh = _to_float(cell_state.get("neighbor_mean_prb_bh"))
    is_structural_congestion = _to_bool(cell_state.get("is_structural_congestion"))
    rebalancing_opportunity = _to_bool(cell_state.get("rebalancing_opportunity"))
    frequency_band = _normalize_band(cell_state.get("frequency_band"))
    current_loss_ue = max(0, int(round(_to_float(cell_state.get("traffic_loss_ue"), 0.0))))
    current_loss_gb = max(0.0, _to_float(cell_state.get("traffic_loss_gb"), 0.0))

    if current_loss_ue == 0 and current_loss_gb == 0.0:
        current_loss_ue, current_loss_gb = _estimate_traffic_loss(
            active_users=current_users,
            load=current_prb,
            throughput=current_thrput,
        )

    def add_action(
        action: str,
        tier: str,
        confidence: str,
        reason: str,
        estimated_recovery_pct: int,
    ) -> None:
        actions.append(_build_action(action, tier, confidence, reason, estimated_recovery_pct))
        added_action_names.add(action)

    # Rule 1 — Immediate overload
    if (current_prb > 90 or predicted_prb_next_hour > 90) and rebalancing_opportunity:
        add_action(
            action="Équilibrage MLB",
            tier="court_terme",
            confidence="high",
            reason="PRB load critical and neighbor bands have available capacity",
            estimated_recovery_pct=40,
        )

    # Rule 2 — CQI-based coverage issue
    if current_prb > 75 and current_cqi < 7:
        add_action(
            action="Ajustement Tilt",
            tier="court_terme",
            confidence="high",
            reason="Low CQI suggests coverage overlap or interference — tilt adjustment expected to improve SINR and PRB efficiency",
            estimated_recovery_pct=15,
        )
    if current_prb > 75 and current_cqi < 9 and current_cqi >= 7:
        add_action(
            action="Ajustement Tilt",
            tier="court_terme",
            confidence="medium",
            reason="Moderate CQI degradation under load — tilt adjustment may recover capacity",
            estimated_recovery_pct=10,
        )

    # Rule 3 — Power adjustment
    if current_prb > 80 and current_cqi >= 9 and not rebalancing_opportunity:
        add_action(
            action="Ajustement Puissance",
            tier="court_terme",
            confidence="medium",
            reason="High PRB load with good CQI — power reduction may shrink footprint and offload users to neighbors",
            estimated_recovery_pct=10,
        )

    # Rule 4 — Carrier Aggregation
    if is_structural_congestion and frequency_band == "B1":
        add_action(
            action="Activation carrier (CA)",
            tier="moyen_terme",
            confidence="high",
            reason="Structural congestion on B1 — CA activation with B20 anchor can double effective capacity",
            estimated_recovery_pct=50,
        )
    if is_structural_congestion and frequency_band == "B3" and avg_prb_busy_hour > 85:
        add_action(
            action="Activation carrier (CA)",
            tier="moyen_terme",
            confidence="medium",
            reason="Structural congestion on B3 — CA candidate if B1 or B20 available on site",
            estimated_recovery_pct=40,
        )

    # Rule 5 — Radio parameter tuning
    if current_prb > 70 and current_prb <= 80 and "Équilibrage MLB" not in added_action_names:
        add_action(
            action="Tuning paramètres radio",
            tier="court_terme",
            confidence="low",
            reason="Moderate load — scheduler and admission control parameter review recommended",
            estimated_recovery_pct=10,
        )

    # Rule 6 — MIMO upgrade
    if is_structural_congestion and avg_prb_busy_hour > 85 and current_cqi >= 9:
        add_action(
            action="Upgrade MIMO",
            tier="moyen_terme",
            confidence="medium",
            reason="Structural congestion with high CQI — spatial multiplexing upgrade can increase spectral efficiency",
            estimated_recovery_pct=30,
        )

    # Rule 7 — Small Cell
    if is_structural_congestion and pct_congested > 0.40:
        add_action(
            action="Small Cell / Micro",
            tier="moyen_terme",
            confidence="medium",
            reason="Over 40% of busy hours congested — hotspot small cell deployment recommended to offload macro layer",
            estimated_recovery_pct=45,
        )

    # Rule 8 — 4th Sector
    if is_structural_congestion and pct_congested > 0.50 and avg_prb_busy_hour > 88:
        add_action(
            action="Ajout 4ème secteur",
            tier="long_terme",
            confidence="high",
            reason="Persistent heavy congestion — 4th sector addition will multiply sector capacity by ~1.8x",
            estimated_recovery_pct=85,
        )

    # Rule 9 — New Macro Site
    if is_structural_congestion and pct_congested > 0.60 and neighbor_mean_prb_bh > 75:
        add_action(
            action="Nouveau site macro",
            tier="long_terme",
            confidence="high",
            reason="Area-wide congestion across site — new capacitary macro site required",
            estimated_recovery_pct=90,
        )

    # Rule 10 — Cell Split
    if is_structural_congestion and pct_congested > 0.70 and avg_users_busy_hour > 60:
        add_action(
            action="Cell Split",
            tier="long_terme",
            confidence="medium",
            reason="Extreme persistent load with very high user count — geographic cell split recommended",
            estimated_recovery_pct=80,
        )

    deduplicated: list[dict[str, Any]] = []
    seen: set[str] = set()
    for action in actions:
        action_name = action["action"]
        if action_name in seen:
            continue
        seen.add(action_name)
        deduplicated.append(action)

    if not deduplicated:
        no_action = {
            "action": "Aucune action requise",
            "tier": "none",
            "confidence": "high",
            "reason": "Cell KPIs within normal range",
            "estimated_recovery_pct": 0,
            "priority_rank": 1,
        }
        _enrich_action_with_gains(no_action, current_loss_ue, current_loss_gb)
        return [no_action]

    sorted_actions = sorted(
        deduplicated,
        key=lambda item: (TIER_ORDER.get(item["tier"], 99), -int(item["estimated_recovery_pct"])),
    )
    for idx, action in enumerate(sorted_actions, start=1):
        action["priority_rank"] = idx
        _enrich_action_with_gains(action, current_loss_ue, current_loss_gb)
    return sorted_actions


def get_cell_state(
    cellname: str,
    features_df: pd.DataFrame,
    profile_df: pd.DataFrame,
    pred_prb: float,
    pred_users: float,
    pred_thrput: float,
) -> dict:
    if not str(cellname).strip():
        raise ValueError("cellname must be a non-empty string.")

    features_cell_col = _find_column(
        features_df,
        ["CELLNAME", "cellname", "CELL_NAME", "cell_name"],
        required=True,
        df_name="features_df",
    )
    timestamp_col = _find_column(
        features_df,
        ["DATE_ID", "date_id", "timestamp", "datetime", "ds"],
        required=False,
        df_name="features_df",
    )
    imputed_col = _find_column(
        features_df,
        ["IS_IMPUTED", "is_imputed"],
        required=True,
        df_name="features_df",
    )

    key = str(cellname).strip()
    feature_rows = features_df[features_df[features_cell_col].astype(str).str.strip().eq(key)]
    if feature_rows.empty:
        raise ValueError(f"Cell '{cellname}' not found in features_df.")

    non_imputed_rows = feature_rows[~feature_rows[imputed_col].map(_to_bool)]
    if non_imputed_rows.empty:
        raise ValueError(f"Cell '{cellname}' has no non-imputed row in features_df.")

    latest = _latest_row(non_imputed_rows, timestamp_col=timestamp_col)
    data_freshness_timestamp: str | None = None
    latest_observation_timestamp: str | None = None
    data_staleness_hours = 0.0
    if timestamp_col is not None and timestamp_col in feature_rows.columns:
        latest_ts_series = pd.to_datetime(feature_rows[timestamp_col], errors="coerce")
        selected_ts = pd.to_datetime(latest[timestamp_col], errors="coerce")
        if latest_ts_series.notna().any():
            latest_observation_ts = latest_ts_series.max()
            latest_observation_timestamp = latest_observation_ts.isoformat()
            if pd.notna(selected_ts):
                delta_hours = (latest_observation_ts - selected_ts).total_seconds() / 3600.0
                data_staleness_hours = max(0.0, float(delta_hours))
        if pd.notna(selected_ts):
            data_freshness_timestamp = selected_ts.isoformat()

    profile_cell_col = _find_column(
        profile_df,
        ["CELLNAME", "cellname", "CELL_NAME", "cell_name"],
        required=True,
        df_name="profile_df",
    )
    profile_rows = profile_df[profile_df[profile_cell_col].astype(str).str.strip().eq(key)]
    if profile_rows.empty:
        raise ValueError(f"Cell '{cellname}' not found in profile_df.")
    profile_latest = _latest_row(profile_rows, timestamp_col=None)

    enodeb_col = _find_column(
        features_df,
        ["ENODEB_NAME", "enodeb_name"],
        required=False,
        df_name="features_df",
    )
    if enodeb_col is None:
        enodeb_col = _find_column(
            profile_df,
            ["ENODEB_NAME", "enodeb_name"],
            required=True,
            df_name="profile_df",
        )
        enodeb_name = str(profile_latest[enodeb_col])
    else:
        enodeb_name = str(latest[enodeb_col])

    band_col_features = _find_column(
        features_df,
        ["FREQUENCY_BAND", "frequency_band"],
        required=False,
        df_name="features_df",
    )
    if band_col_features is not None:
        raw_band = latest[band_col_features]
    else:
        band_col_profile = _find_column(
            profile_df,
            ["FREQUENCY_BAND", "frequency_band"],
            required=True,
            df_name="profile_df",
        )
        raw_band = profile_latest[band_col_profile]

    prb_col = _find_column(
        features_df,
        ["prb_load", "current_prb"],
        required=True,
        df_name="features_df",
    )
    users_col = _find_column(
        features_df,
        ["active_users", "current_users"],
        required=True,
        df_name="features_df",
    )
    thrput_col = _find_column(
        features_df,
        ["throughput", "current_thrput"],
        required=True,
        df_name="features_df",
    )
    cqi_col = _find_column(
        features_df,
        ["cqi", "current_cqi"],
        required=True,
        df_name="features_df",
    )

    avg_prb_col = _find_column(
        profile_df,
        ["avg_prb_busy_hour"],
        required=True,
        df_name="profile_df",
    )
    pct_congested_col = _find_column(
        profile_df,
        ["pct_congested"],
        required=True,
        df_name="profile_df",
    )
    structural_col = _find_column(
        profile_df,
        ["is_structural_congestion"],
        required=True,
        df_name="profile_df",
    )
    rebalancing_col = _find_column(
        profile_df,
        ["rebalancing_opportunity"],
        required=True,
        df_name="profile_df",
    )
    neighbor_prb_col = _find_column(
        profile_df,
        ["neighbor_mean_prb_bh"],
        required=True,
        df_name="profile_df",
    )
    avg_users_bh_col = _find_column(
        profile_df,
        ["avg_users_busy_hour"],
        required=True,
        df_name="profile_df",
    )

    current_prb = _to_float(latest[prb_col])
    current_users = _to_float(latest[users_col])
    current_thrput = _to_float(latest[thrput_col])
    traffic_loss_ue, traffic_loss_gb = _estimate_traffic_loss(
        active_users=current_users,
        load=current_prb,
        throughput=current_thrput,
    )

    return {
        "cellname": key,
        "enodeb_name": enodeb_name,
        "frequency_band": _normalize_band(raw_band),
        "data_freshness_timestamp": data_freshness_timestamp,
        "latest_observation_timestamp": latest_observation_timestamp,
        "data_staleness_hours": data_staleness_hours,
        "predicted_prb_next_hour": _to_float(pred_prb),
        "predicted_users_next_hour": _to_float(pred_users),
        "predicted_thrput_next_hour": _to_float(pred_thrput),
        "current_prb": current_prb,
        "current_users": current_users,
        "current_thrput": current_thrput,
        "current_cqi": _to_float(latest[cqi_col]),
        "traffic_loss_ue": traffic_loss_ue,
        "traffic_loss_gb": traffic_loss_gb,
        "avg_prb_busy_hour": _to_float(profile_latest[avg_prb_col]),
        "avg_users_busy_hour": _to_float(profile_latest[avg_users_bh_col]),
        "pct_congested": _to_float(profile_latest[pct_congested_col]),
        "is_structural_congestion": _to_bool(profile_latest[structural_col]),
        "rebalancing_opportunity": _to_bool(profile_latest[rebalancing_col]),
        "neighbor_mean_prb_bh": _to_float(profile_latest[neighbor_prb_col]),
    }

