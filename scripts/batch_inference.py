"""
Run batch next-hour inference for all cells and generate action recommendations.

Outputs:
- all_cell_recommendations.parquet
- all_cell_recommendations.csv
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import duckdb
import joblib
import numpy as np
import pandas as pd


ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import action_engine  # noqa: E402


OUTPUT_COLUMNS = [
    "CELLNAME",
    "ENODEB_NAME",
    "FREQUENCY_BAND",
    "LATITUDE",
    "LONGITUDE",
    "AZIMUTH",
    "current_prb",
    "current_users",
    "current_thrput",
    "current_cqi",
    "predicted_prb",
    "predicted_users",
    "predicted_thrput",
    "data_freshness_timestamp",
    "latest_observation_timestamp",
    "data_staleness_hours",
    "avg_prb_busy_hour",
    "pct_congested",
    "is_structural_congestion",
    "rebalancing_opportunity",
    "congestion_score",
    "action",
    "tier",
    "confidence",
    "reason",
    "estimated_recovery_pct",
    "priority_rank",
]

STALE_ACTION = "Data too stale for decision"
STALE_REASON_TEMPLATE = (
    "Latest non-imputed KPI is {staleness_hours:.1f}h old (> {max_staleness_hours:.1f}h); "
    "refresh telemetry before optimization decisions."
)


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if pd.isna(out):
        return default
    return out


def resolve_path(path_like: str, base_dir: Path) -> Path:
    path = Path(path_like)
    if path.is_absolute():
        return path
    return (base_dir / path).resolve()


def read_parquet_df(path: Path) -> pd.DataFrame:
    con = duckdb.connect()
    try:
        return con.execute("SELECT * FROM read_parquet(?)", [str(path)]).df()
    finally:
        con.close()


def write_parquet_df(df: pd.DataFrame, path: Path) -> None:
    con = duckdb.connect()
    try:
        con.register("out_df", df)
        escaped = str(path).replace("'", "''")
        con.execute(f"COPY out_df TO '{escaped}' (FORMAT PARQUET)")
    finally:
        con.close()


def load_feature_columns(meta_path: Path) -> list[str]:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    feature_cols = list(meta.get("feature_cols", []))
    if not feature_cols:
        raise ValueError("features_meta.json has no feature_cols.")
    return feature_cols


def build_current_snapshot(features_df: pd.DataFrame) -> pd.DataFrame:
    required = ["CELLNAME", "DATE_ID", "IS_IMPUTED", "congestion_score"]
    missing = [col for col in required if col not in features_df.columns]
    if missing:
        raise ValueError(f"features_with_score.parquet missing required columns: {missing}")

    out = features_df.copy()
    out["DATE_ID"] = pd.to_datetime(out["DATE_ID"], errors="coerce")
    if out["DATE_ID"].isna().any():
        raise ValueError("DATE_ID contains unparsable timestamps in features_with_score.parquet.")

    out = out.sort_values(["CELLNAME", "DATE_ID"]).reset_index(drop=True)
    non_imputed = out[out["IS_IMPUTED"].eq(False)].copy()
    if non_imputed.empty:
        raise ValueError("No non-imputed rows found in features data.")

    all_cells = set(out["CELLNAME"].astype(str).tolist())
    cells_with_non_imputed = set(non_imputed["CELLNAME"].astype(str).tolist())
    missing_cells = sorted(all_cells - cells_with_non_imputed)
    if missing_cells:
        raise ValueError(
            "Some cells have no non-imputed rows and cannot be scored: "
            + ", ".join(missing_cells[:10])
            + ("..." if len(missing_cells) > 10 else "")
        )

    return non_imputed.groupby("CELLNAME", as_index=False, sort=False).tail(1).reset_index(drop=True)


def predict_with_model(model: Any, feature_frame: pd.DataFrame) -> np.ndarray:
    best_iteration = getattr(model, "best_iteration_", None)
    if isinstance(best_iteration, (int, np.integer)) and int(best_iteration) > 0:
        try:
            return model.predict(feature_frame, num_iteration=int(best_iteration))
        except TypeError:
            pass
    return model.predict(feature_frame)


def align_model_features(
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


def build_recommendations_dataframe(
    features_df: pd.DataFrame,
    current_df: pd.DataFrame,
    profile_df: pd.DataFrame,
    max_staleness_hours: float,
) -> pd.DataFrame:
    current_lookup = current_df.set_index("CELLNAME", drop=False)
    rows: list[dict[str, Any]] = []

    for cellname, cell_hist in features_df.groupby("CELLNAME", sort=False):
        if cellname not in current_lookup.index:
            continue

        snap = current_lookup.loc[cellname]
        if isinstance(snap, pd.DataFrame):
            snap = snap.iloc[-1]

        cell_state = action_engine.get_cell_state(
            cellname=str(cellname),
            features_df=cell_hist,
            profile_df=profile_df,
            pred_prb=_to_float(snap["predicted_prb"]),
            pred_users=_to_float(snap["predicted_users"]),
            pred_thrput=_to_float(snap["predicted_thrput"]),
        )
        staleness_hours = _to_float(cell_state.get("data_staleness_hours"))
        if staleness_hours > max_staleness_hours:
            actions = [
                {
                    "action": STALE_ACTION,
                    "tier": "none",
                    "confidence": "high",
                    "reason": STALE_REASON_TEMPLATE.format(
                        staleness_hours=staleness_hours,
                        max_staleness_hours=max_staleness_hours,
                    ),
                    "estimated_recovery_pct": 0,
                    "priority_rank": 1,
                }
            ]
        else:
            actions = action_engine.recommend_actions(cell_state)

        for rec in actions:
            rows.append(
                {
                    "CELLNAME": str(cellname),
                    "ENODEB_NAME": str(cell_state["enodeb_name"]),
                    "FREQUENCY_BAND": str(cell_state["frequency_band"]),
                    "LATITUDE": _to_float(snap.get("LATITUDE")),
                    "LONGITUDE": _to_float(snap.get("LONGITUDE")),
                    "AZIMUTH": _to_float(snap.get("AZIMUTH")),
                    "current_prb": _to_float(cell_state["current_prb"]),
                    "current_users": _to_float(cell_state["current_users"]),
                    "current_thrput": _to_float(cell_state["current_thrput"]),
                    "current_cqi": _to_float(cell_state["current_cqi"]),
                    "predicted_prb": _to_float(cell_state["predicted_prb_next_hour"]),
                    "predicted_users": _to_float(cell_state["predicted_users_next_hour"]),
                    "predicted_thrput": _to_float(cell_state["predicted_thrput_next_hour"]),
                    "data_freshness_timestamp": cell_state.get("data_freshness_timestamp"),
                    "latest_observation_timestamp": cell_state.get("latest_observation_timestamp"),
                    "data_staleness_hours": staleness_hours,
                    "avg_prb_busy_hour": _to_float(cell_state["avg_prb_busy_hour"]),
                    "pct_congested": _to_float(cell_state["pct_congested"]),
                    "is_structural_congestion": bool(cell_state["is_structural_congestion"]),
                    "rebalancing_opportunity": bool(cell_state["rebalancing_opportunity"]),
                    "congestion_score": _to_float(snap.get("congestion_score")),
                    "action": rec["action"],
                    "tier": rec["tier"],
                    "confidence": rec["confidence"],
                    "reason": rec["reason"],
                    "estimated_recovery_pct": int(rec["estimated_recovery_pct"]),
                    "priority_rank": int(rec["priority_rank"]),
                }
            )

    rec_df = pd.DataFrame(rows, columns=OUTPUT_COLUMNS)
    return rec_df.sort_values(["CELLNAME", "priority_rank"]).reset_index(drop=True)


def print_console_summary(rec_df: pd.DataFrame) -> None:
    top_reco_per_cell = (
        rec_df.sort_values(["CELLNAME", "priority_rank"])
        .groupby("CELLNAME", as_index=False)
        .first()
        .reset_index(drop=True)
    )
    tier_sets = rec_df.groupby("CELLNAME")["tier"].agg(lambda s: set(s.tolist()))

    total_cells = int(top_reco_per_cell["CELLNAME"].nunique())
    no_action_cells = int(top_reco_per_cell["action"].eq("Aucune action requise").sum())
    stale_data_cells = int(top_reco_per_cell["action"].eq(STALE_ACTION).sum())
    no_action_pct = (100.0 * no_action_cells / total_cells) if total_cells else 0.0
    court_terme_only_cells = int(sum(tiers == {"court_terme"} for tiers in tier_sets))
    moyen_terme_cells = int(sum("moyen_terme" in tiers for tiers in tier_sets))
    long_terme_cells = int(sum("long_terme" in tiers for tiers in tier_sets))

    print(f"Total cells scored: {total_cells:,}")
    print(f"Cells with no action needed: {no_action_cells:,} ({no_action_pct:.2f}%)")
    print(f"Cells blocked due to stale data: {stale_data_cells:,}")
    print(f"Cells with court_terme actions only: {court_terme_only_cells:,}")
    print(f"Cells with moyen_terme actions: {moyen_terme_cells:,}")
    print(f"Cells with long_terme CAPEX actions: {long_terme_cells:,}")

    print("\nTop 10 most congested cells (by avg_prb_busy_hour, descending):")
    top10 = (
        top_reco_per_cell.sort_values("avg_prb_busy_hour", ascending=False)
        .head(10)
        .rename(columns={"action": "top_recommended_action"})
    )
    top10 = top10[
        ["CELLNAME", "FREQUENCY_BAND", "avg_prb_busy_hour", "pct_congested", "top_recommended_action"]
    ].copy()
    if top10.empty:
        print("No cells available.")
    else:
        print(
            top10.to_string(
                index=False,
                formatters={
                    "avg_prb_busy_hour": lambda x: f"{float(x):.2f}",
                    "pct_congested": lambda x: f"{float(x):.3f}",
                },
            )
        )

    print("\nAction frequency (how many cells got each action recommended):")
    action_freq = (
        rec_df[
            rec_df["action"].ne("Aucune action requise")
            & rec_df["action"].ne(STALE_ACTION)
        ]
        .groupby("action")["CELLNAME"]
        .nunique()
        .sort_values(ascending=False)
    )
    if action_freq.empty:
        print("No remediation actions recommended.")
    else:
        freq_table = action_freq.rename("cells").reset_index()
        print(freq_table.to_string(index=False))


def run(
    features_path: Path,
    meta_path: Path,
    model_prb_path: Path,
    model_users_path: Path,
    model_thrput_path: Path,
    profile_path: Path,
    thresholds_path: Path,
    output_parquet_path: Path,
    output_csv_path: Path,
    max_staleness_hours: float,
) -> None:
    if not thresholds_path.exists():
        raise FileNotFoundError(f"Missing thresholds.json: {thresholds_path}")

    features_df = read_parquet_df(features_path)
    profile_df = read_parquet_df(profile_path)
    feature_cols = load_feature_columns(meta_path)

    missing_feature_cols = [col for col in feature_cols if col not in features_df.columns]
    if missing_feature_cols:
        raise ValueError(f"Missing feature columns in features_with_score.parquet: {missing_feature_cols}")

    current_df = build_current_snapshot(features_df)
    X_current_base = current_df[feature_cols].fillna(0.0)

    model_prb = joblib.load(model_prb_path)
    model_users = joblib.load(model_users_path)
    model_thrput = joblib.load(model_thrput_path)

    X_prb = align_model_features(model_prb, X_current_base, feature_cols, "model_prb")
    X_users = align_model_features(model_users, X_current_base, feature_cols, "model_users")
    X_thrput = align_model_features(model_thrput, X_current_base, feature_cols, "model_thrput")

    current_df["predicted_prb"] = np.clip(predict_with_model(model_prb, X_prb), 0.0, 100.0)
    current_df["predicted_users"] = np.clip(predict_with_model(model_users, X_users), 0.0, 500.0)
    current_df["predicted_thrput"] = np.clip(predict_with_model(model_thrput, X_thrput), 0.0, 500000.0)

    recommendations_df = build_recommendations_dataframe(
        features_df=features_df,
        current_df=current_df,
        profile_df=profile_df,
        max_staleness_hours=max_staleness_hours,
    )

    output_parquet_path.parent.mkdir(parents=True, exist_ok=True)
    output_csv_path.parent.mkdir(parents=True, exist_ok=True)
    write_parquet_df(recommendations_df, output_parquet_path)
    recommendations_df.to_csv(output_csv_path, index=False, encoding="utf-8")

    print_console_summary(recommendations_df)
    print("\nSaved artifacts:")
    print(f"- {output_parquet_path}")
    print(f"- {output_csv_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Batch-score all 4G cells and generate action recommendations.")
    parser.add_argument("--features", default="features_with_score.parquet", help="Input scored features parquet.")
    parser.add_argument("--meta", default="features_meta.json", help="Input features metadata JSON.")
    parser.add_argument("--model-prb", default="models/model_prb.pkl", help="PRB forecasting model path.")
    parser.add_argument("--model-users", default="models/model_users.pkl", help="Users forecasting model path.")
    parser.add_argument("--model-thrput", default="models/model_thrput.pkl", help="Throughput forecasting model path.")
    parser.add_argument("--profile", default="cell_congestion_profile.parquet", help="Cell profile parquet path.")
    parser.add_argument("--thresholds", default="thresholds.json", help="Thresholds JSON path.")
    parser.add_argument(
        "--output-parquet",
        default="all_cell_recommendations.parquet",
        help="Output parquet path with one row per recommendation.",
    )
    parser.add_argument(
        "--output-csv",
        default="all_cell_recommendations.csv",
        help="Output CSV path with one row per recommendation.",
    )
    parser.add_argument(
        "--max-staleness-hours",
        type=float,
        default=24.0,
        help="Maximum allowed KPI staleness in hours before gating recommendations.",
    )
    args = parser.parse_args()

    run(
        features_path=resolve_path(args.features, ROOT_DIR),
        meta_path=resolve_path(args.meta, ROOT_DIR),
        model_prb_path=resolve_path(args.model_prb, ROOT_DIR),
        model_users_path=resolve_path(args.model_users, ROOT_DIR),
        model_thrput_path=resolve_path(args.model_thrput, ROOT_DIR),
        profile_path=resolve_path(args.profile, ROOT_DIR),
        thresholds_path=resolve_path(args.thresholds, ROOT_DIR),
        output_parquet_path=resolve_path(args.output_parquet, ROOT_DIR),
        output_csv_path=resolve_path(args.output_csv, ROOT_DIR),
        max_staleness_hours=float(args.max_staleness_hours),
    )


if __name__ == "__main__":
    main()

