"""
Evaluate PRB forecasting errors and calibrate congestion thresholds.

Outputs:
- features_with_score.parquet
- cell_congestion_profile.parquet
- thresholds.json
"""

import argparse
import json
from pathlib import Path
from typing import Dict, List

import duckdb
import numpy as np
import pandas as pd


BUSY_HOURS = [17, 18, 19, 20, 21, 22]


def read_parquet_df(path: Path) -> pd.DataFrame:
    con = duckdb.connect()
    try:
        escaped_path = str(path).replace("'", "''")
        return con.execute(f"SELECT * FROM read_parquet('{escaped_path}')").fetchdf()
    finally:
        con.close()


def write_parquet_df(df: pd.DataFrame, path: Path) -> None:
    con = duckdb.connect()
    try:
        con.register("out_df", df)
        escaped_path = str(path).replace("'", "''")
        con.execute(f"COPY out_df TO '{escaped_path}' (FORMAT PARQUET)")
    finally:
        con.close()


def require_columns(df: pd.DataFrame, required: List[str], name: str) -> None:
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f"{name} is missing required columns: {missing}")


def summarize_errors_by_group(df: pd.DataFrame, group_col: str) -> pd.DataFrame:
    grouped = (
        df.groupby(group_col, dropna=False, as_index=False)
        .agg(
            n_rows=("y_true_prb", "size"),
            mae=("abs_error_prb", "mean"),
            mse=("sq_error_prb", "mean"),
        )
        .sort_values(group_col)
        .reset_index(drop=True)
    )
    grouped["rmse"] = np.sqrt(grouped.pop("mse"))
    return grouped


def run_error_analysis(val_df: pd.DataFrame) -> None:
    require_columns(
        val_df,
        ["DATE_ID", "FREQUENCY_BAND", "y_true_prb", "y_pred_prb"],
        "val_predictions.parquet",
    )

    out = val_df.copy()
    out["DATE_ID"] = pd.to_datetime(out["DATE_ID"], errors="coerce")
    if out["DATE_ID"].isna().any():
        raise ValueError("val_predictions.parquet contains unparsable DATE_ID values.")

    out["is_busy_hour"] = out["DATE_ID"].dt.hour.isin(BUSY_HOURS)
    out["load_regime"] = np.where(out["y_true_prb"] > 80, "high_load", "normal_load")
    out["abs_error_prb"] = (out["y_pred_prb"] - out["y_true_prb"]).abs()
    out["sq_error_prb"] = (out["y_pred_prb"] - out["y_true_prb"]) ** 2

    by_band = summarize_errors_by_group(out, "FREQUENCY_BAND")
    by_load = summarize_errors_by_group(out, "load_regime")
    by_busy = summarize_errors_by_group(out, "is_busy_hour")

    float_fmt = lambda x: f"{x:.4f}"

    print("\nTASK 1 - Error summary by FREQUENCY_BAND")
    print(by_band.to_string(index=False, float_format=float_fmt))

    print("\nTASK 1 - Error summary by load regime (y_true_prb > 80)")
    print(by_load.to_string(index=False, float_format=float_fmt))

    print("\nTASK 1 - Error summary by is_busy_hour")
    print(by_busy.to_string(index=False, float_format=float_fmt))


def resolve_throughput_column(df: pd.DataFrame) -> str:
    if "throughput_kbps" in df.columns:
        return "throughput_kbps"
    if "throughput" in df.columns:
        return "throughput"
    raise ValueError("features_engineered.parquet must contain either throughput_kbps or throughput.")


def add_congestion_score(df: pd.DataFrame, throughput_col: str) -> pd.DataFrame:
    out = df.copy()
    require_columns(
        out,
        ["prb_load", "active_users", throughput_col, "is_busy_hour"],
        "features_engineered.parquet",
    )

    prb = out["prb_load"].to_numpy()
    users = out["active_users"].to_numpy()
    thrput = out[throughput_col].to_numpy()
    is_busy = out["is_busy_hour"].eq(True).to_numpy()

    prb_score = np.select([prb > 90, prb > 80, prb > 70], [3, 2, 1], default=0)
    user_score = np.select([users > 40, users > 20], [2, 1], default=0)
    thrput_score = np.select(
        [(thrput < 2000) & (prb > 70), (thrput < 5000) & (prb > 70)],
        [2, 1],
        default=0,
    )
    busy_bonus = is_busy.astype(np.int8)

    out["congestion_score"] = (prb_score + user_score + thrput_score + busy_bonus).astype(np.int8)
    return out


def build_cell_congestion_profile(df: pd.DataFrame, throughput_col: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    require_columns(
        df,
        [
            "CELLNAME",
            "ENODEB_NAME",
            "ENODEB_ID",
            "FREQUENCY_BAND",
            "DATE_ID",
            "prb_load",
            "active_users",
            throughput_col,
            "IS_IDLE",
            "is_busy_hour",
            "congestion_score",
        ],
        "features_with_score",
    )

    out = df.copy()
    cell_keys = ["CELLNAME", "ENODEB_NAME", "ENODEB_ID", "FREQUENCY_BAND"]

    busy_non_idle = out["is_busy_hour"].eq(True) & out["IS_IDLE"].eq(False)
    out["busy_non_idle"] = busy_non_idle
    out["is_congested_busy"] = out["is_busy_hour"].eq(True) & out["congestion_score"].ge(4)
    out["prb_busy_non_idle"] = out["prb_load"].where(busy_non_idle)
    out["users_busy_non_idle"] = out["active_users"].where(busy_non_idle)
    out["thrput_busy_non_idle"] = out[throughput_col].where(busy_non_idle)

    profile = (
        out.groupby(cell_keys, as_index=False)
        .agg(
            n_busy_hours=("busy_non_idle", "sum"),
            n_congested_busy_hours=("is_congested_busy", "sum"),
            avg_prb_busy_hour=("prb_busy_non_idle", "mean"),
            max_prb=("prb_load", "max"),
            avg_users_busy_hour=("users_busy_non_idle", "mean"),
            avg_thrput_busy_hour=("thrput_busy_non_idle", "mean"),
        )
        .sort_values(cell_keys)
        .reset_index(drop=True)
    )

    profile["n_busy_hours"] = profile["n_busy_hours"].astype(np.int32)
    profile["n_congested_busy_hours"] = profile["n_congested_busy_hours"].astype(np.int32)
    profile["pct_congested"] = np.divide(
        profile["n_congested_busy_hours"],
        profile["n_busy_hours"],
        out=np.zeros(len(profile), dtype=float),
        where=profile["n_busy_hours"].to_numpy() > 0,
    )
    profile["is_structural_congestion"] = profile["pct_congested"] > 0.20

    for col in ["avg_prb_busy_hour", "avg_users_busy_hour", "avg_thrput_busy_hour"]:
        profile[col] = profile[col].fillna(0.0)

    busy_hours_only = out[out["is_busy_hour"].eq(True)].copy()
    if busy_hours_only.empty:
        enodeb_busy_mean_prb = pd.DataFrame(columns=["ENODEB_NAME", "enodeb_mean_prb_bh"])
        profile["neighbor_mean_prb_bh"] = np.nan
    else:
        enodeb_busy_mean_prb = (
            busy_hours_only.groupby("ENODEB_NAME", as_index=False)["prb_load"]
            .mean()
            .rename(columns={"prb_load": "enodeb_mean_prb_bh"})
        )

        enodeb_time_keys = ["ENODEB_NAME", "DATE_ID"]
        prb_sum = busy_hours_only.groupby(enodeb_time_keys, sort=False)["prb_load"].transform("sum")
        prb_count = busy_hours_only.groupby(enodeb_time_keys, sort=False)["prb_load"].transform("size")
        busy_hours_only["neighbor_prb_same_hour"] = np.where(
            prb_count.gt(1),
            (prb_sum - busy_hours_only["prb_load"]) / (prb_count - 1),
            np.nan,
        )

        neighbor_means = (
            busy_hours_only.groupby(cell_keys, as_index=False)["neighbor_prb_same_hour"]
            .mean()
            .rename(columns={"neighbor_prb_same_hour": "neighbor_mean_prb_bh"})
        )
        profile = profile.merge(neighbor_means, on=cell_keys, how="left")

    # A cell has different-band neighbors only when its eNodeB hosts >1 unique frequency band.
    enodeb_band_count = profile.groupby("ENODEB_NAME", sort=False)["FREQUENCY_BAND"].transform("nunique")
    enodeb_cell_count = profile.groupby("ENODEB_NAME", sort=False)["CELLNAME"].transform("size")
    has_different_band_neighbor = enodeb_band_count.gt(1) & enodeb_cell_count.gt(1)

    profile["rebalancing_opportunity"] = (
        profile["avg_prb_busy_hour"].gt(80)
        & profile["neighbor_mean_prb_bh"].lt(65)
        & has_different_band_neighbor
    )

    return profile, enodeb_busy_mean_prb


def compute_thresholds(df: pd.DataFrame) -> Dict[str, object]:
    require_columns(df, ["prb_load", "is_busy_hour", "IS_IDLE"], "features_with_score")
    mask = df["is_busy_hour"].eq(True) & df["IS_IDLE"].eq(False)
    prb_busy_non_idle = df.loc[mask, "prb_load"]
    if prb_busy_non_idle.empty:
        raise ValueError("Cannot compute thresholds: no non-idle busy-hour rows found.")

    prb_critical = float(np.quantile(prb_busy_non_idle.to_numpy(), 0.90))
    prb_warning = float(np.quantile(prb_busy_non_idle.to_numpy(), 0.75))

    return {
        "prb_critical": prb_critical,
        "prb_warning": prb_warning,
        "prb_structural_threshold": 80,
        "prb_rebalancing_neighbor_max": 65,
        "min_pct_congested_for_structural": 0.20,
        "congestion_score_threshold": 4,
        "busy_hours": BUSY_HOURS,
    }


def print_structural_breakdown(profile: pd.DataFrame) -> None:
    structural = profile[profile["is_structural_congestion"]]
    print(f"\nTASK 3 - Structurally congested cells: {len(structural):,} / {len(profile):,}")

    if structural.empty:
        print("Breakdown by FREQUENCY_BAND: none")
        return

    breakdown = (
        structural.groupby("FREQUENCY_BAND", as_index=False)
        .agg(n_structural_cells=("CELLNAME", "size"))
        .sort_values("FREQUENCY_BAND")
    )
    print("Breakdown by FREQUENCY_BAND:")
    print(breakdown.to_string(index=False))


def run(
    val_predictions_path: Path,
    features_path: Path,
    features_with_score_path: Path,
    cell_profile_path: Path,
    thresholds_path: Path,
) -> None:
    val_df = read_parquet_df(val_predictions_path)
    features_df = read_parquet_df(features_path)

    run_error_analysis(val_df)

    throughput_col = resolve_throughput_column(features_df)
    features_scored = add_congestion_score(features_df, throughput_col=throughput_col)
    write_parquet_df(features_scored, features_with_score_path)

    cell_profile, enodeb_busy_means = build_cell_congestion_profile(features_scored, throughput_col=throughput_col)
    write_parquet_df(cell_profile, cell_profile_path)
    print_structural_breakdown(cell_profile)
    print(f"\nTASK 4 - eNodeB busy-hour mean PRB computed for {len(enodeb_busy_means):,} eNodeBs")

    thresholds = compute_thresholds(features_scored)
    thresholds_path.write_text(json.dumps(thresholds, indent=2), encoding="utf-8")

    print("\nTASK 5 - thresholds.json")
    print(json.dumps(thresholds, indent=2))

    print("\nSaved artifacts:")
    print(f"- {features_with_score_path}")
    print(f"- {cell_profile_path}")
    print(f"- {thresholds_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate model errors and calibrate congestion thresholds.")
    parser.add_argument("--val-preds", default="val_predictions.parquet", help="Validation predictions parquet.")
    parser.add_argument("--features", default="features_engineered.parquet", help="Engineered features parquet.")
    parser.add_argument(
        "--features-with-score",
        default="features_with_score.parquet",
        help="Output parquet path with congestion_score.",
    )
    parser.add_argument(
        "--cell-profile",
        default="cell_congestion_profile.parquet",
        help="Output parquet path with per-cell congestion profile.",
    )
    parser.add_argument("--thresholds", default="thresholds.json", help="Output thresholds JSON file.")
    args = parser.parse_args()

    run(
        val_predictions_path=Path(args.val_preds),
        features_path=Path(args.features),
        features_with_score_path=Path(args.features_with_score),
        cell_profile_path=Path(args.cell_profile),
        thresholds_path=Path(args.thresholds),
    )


if __name__ == "__main__":
    main()
