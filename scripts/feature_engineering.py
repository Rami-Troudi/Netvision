"""
4G RAN congestion feature engineering pipeline.

Outputs:
- features_engineered.parquet
- features_meta.json
"""

import argparse
import json
from pathlib import Path
from typing import Dict, Iterable, List

import duckdb
import numpy as np
import pandas as pd


COLUMN_ALIASES: Dict[str, List[str]] = {
    "DATE_ID": ["DATE_ID", "date"],
    "ENODEB_NAME": ["ENODEB_NAME", "enodeb_name"],
    "CELLNAME": ["CELLNAME", "cell_name"],
    "LOCALCELL_ID": ["LOCALCELL_ID", "localcell_id"],
    "CELL_TYPE": ["CELL_TYPE", "cell_fdd_tdd_indication"],
    "FREQUENCY_BAND": ["FREQUENCY_BAND", "frequency_band"],
    "LATITUDE": ["LATITUDE", "latitude", "latitude_sector"],
    "LONGITUDE": ["LONGITUDE", "longitude", "longitude_sector"],
    "AZIMUTH": ["AZIMUTH", "azimuth"],
    "active_users": ["L.Traffic.ActiveUser.DL.Avg", "l_traffic_activeuser_dl_avg"],
    "throughput": [
        "FT_AVE 4G/LTE DL USER THRPUT without Last TTI",
        "ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_",
    ],
    "prb_load": ["FT_PHYSICAL RESOURCE BLOCKS LOAD DL", "ft_physical_resource_blocks_load_dl"],
    "cqi": ["FT_4G/LTE AVERAGE REPORTED CQI", "ft_4g_lte_average_reported_cqi"],
}

KPI_COLS = ["prb_load", "active_users", "throughput", "cqi"]
STATIC_COLS = ["ENODEB_NAME", "LOCALCELL_ID", "CELL_TYPE", "FREQUENCY_BAND", "LATITUDE", "LONGITUDE", "AZIMUTH"]
TARGET_COLS = ["prb_load", "active_users", "throughput"]


def resolve_columns(columns: Iterable[str]) -> Dict[str, str]:
    normalized_to_original = {str(col).strip().lower(): str(col) for col in columns}
    rename_map: Dict[str, str] = {}
    missing: List[str] = []

    for canonical, aliases in COLUMN_ALIASES.items():
        matched = None
        for alias in aliases:
            key = alias.strip().lower()
            if key in normalized_to_original:
                matched = normalized_to_original[key]
                break
        if matched is None:
            missing.append(canonical)
        else:
            rename_map[matched] = canonical

    if missing:
        raise KeyError(f"Missing required columns: {missing}")

    return rename_map


def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path, low_memory=False)
    rename_map = resolve_columns(df.columns)
    df = df.rename(columns=rename_map)
    df = df[list(COLUMN_ALIASES.keys())].copy()

    df["DATE_ID"] = pd.to_datetime(df["DATE_ID"], dayfirst=True, errors="coerce")
    if df["DATE_ID"].isna().any():
        raise ValueError("DATE_ID contains unparsable timestamps.")

    for col in ["ENODEB_NAME", "CELLNAME", "CELL_TYPE"]:
        df[col] = df[col].astype(str).str.strip()

    for col in ["LOCALCELL_ID", "LATITUDE", "LONGITUDE", "AZIMUTH", *KPI_COLS]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df.sort_values(["CELLNAME", "DATE_ID"]).reset_index(drop=True)


def apply_missing_value_logic(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()

    out["prb_load"] = out["prb_load"].fillna(0.0)
    out["active_users"] = out["active_users"].fillna(0.0)

    idle_mask = out["active_users"].eq(0)
    out.loc[idle_mask, ["throughput", "cqi"]] = 0.0
    out["throughput"] = out["throughput"].fillna(0.0)
    out["cqi"] = out["cqi"].fillna(0.0)

    out["IS_IDLE"] = out["prb_load"].eq(0)
    return out


def collapse_duplicate_cell_hours(df: pd.DataFrame) -> pd.DataFrame:
    agg_spec = {col: "first" for col in STATIC_COLS}
    agg_spec.update({col: "mean" for col in KPI_COLS})

    out = (
        df.groupby(["CELLNAME", "DATE_ID"], as_index=False, sort=True)
        .agg(agg_spec)
        .sort_values(["CELLNAME", "DATE_ID"])
        .reset_index(drop=True)
    )
    out["IS_IDLE"] = out["prb_load"].eq(0)
    return out


def expand_to_complete_hourly_grid(df: pd.DataFrame) -> pd.DataFrame:
    all_hours = pd.date_range(df["DATE_ID"].min(), df["DATE_ID"].max(), freq="h")
    all_cells = np.sort(df["CELLNAME"].unique())
    full_index = pd.MultiIndex.from_product([all_cells, all_hours], names=["CELLNAME", "DATE_ID"])

    cell_static = df.groupby("CELLNAME", as_index=True)[STATIC_COLS].first()
    out = df.set_index(["CELLNAME", "DATE_ID"]).reindex(full_index).reset_index()
    out["IS_IMPUTED"] = out["prb_load"].isna()

    for col in STATIC_COLS:
        out[col] = out[col].fillna(out["CELLNAME"].map(cell_static[col]))

    out.loc[out["IS_IMPUTED"], KPI_COLS] = 0.0
    out[KPI_COLS] = out[KPI_COLS].fillna(0.0)
    out["IS_IDLE"] = out["prb_load"].eq(0)
    out.loc[out["IS_IMPUTED"], "IS_IDLE"] = True

    out["LOCALCELL_ID"] = pd.to_numeric(out["LOCALCELL_ID"], errors="coerce").fillna(0).astype(np.int32)
    out["LATITUDE"] = pd.to_numeric(out["LATITUDE"], errors="coerce").fillna(0.0)
    out["LONGITUDE"] = pd.to_numeric(out["LONGITUDE"], errors="coerce").fillna(0.0)
    out["AZIMUTH"] = pd.to_numeric(out["AZIMUTH"], errors="coerce").fillna(0.0)

    return out.sort_values(["CELLNAME", "DATE_ID"]).reset_index(drop=True)


def add_time_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["hour_of_day"] = out["DATE_ID"].dt.hour.astype(np.int8)
    out["day_of_week"] = out["DATE_ID"].dt.dayofweek.astype(np.int8)
    out["is_weekend"] = out["day_of_week"].ge(5)
    out["is_busy_hour"] = out["hour_of_day"].between(17, 22)
    return out


def add_lag_and_rolling_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    grouped = out.groupby("CELLNAME", sort=False)

    for lag in [1, 2, 3, 6, 12, 24]:
        out[f"prb_lag{lag}"] = grouped["prb_load"].shift(lag)

    out["users_lag1"] = grouped["active_users"].shift(1)
    out["users_lag24"] = grouped["active_users"].shift(24)
    out["thrput_lag1"] = grouped["throughput"].shift(1)
    out["thrput_lag24"] = grouped["throughput"].shift(24)

    out["prb_roll3_mean"] = grouped["prb_load"].rolling(window=3, min_periods=1).mean().reset_index(level=0, drop=True)
    out["prb_roll6_mean"] = grouped["prb_load"].rolling(window=6, min_periods=1).mean().reset_index(level=0, drop=True)
    out["prb_roll24_mean"] = grouped["prb_load"].rolling(window=24, min_periods=1).mean().reset_index(level=0, drop=True)
    out["prb_roll24_max"] = grouped["prb_load"].rolling(window=24, min_periods=1).max().reset_index(level=0, drop=True)
    out["users_roll3_mean"] = grouped["active_users"].rolling(window=3, min_periods=1).mean().reset_index(
        level=0, drop=True
    )

    lag_cols = [
        "prb_lag1",
        "prb_lag2",
        "prb_lag3",
        "prb_lag6",
        "prb_lag12",
        "prb_lag24",
        "users_lag1",
        "users_lag24",
        "thrput_lag1",
        "thrput_lag24",
    ]
    out[lag_cols] = out[lag_cols].fillna(0.0)
    return out


def add_neighbor_band_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    keys = [out["ENODEB_NAME"], out["DATE_ID"]]
    group = out.groupby(["ENODEB_NAME", "DATE_ID"], sort=False)["prb_load"]

    group_sum = group.transform("sum")
    group_size = group.transform("size")
    group_max = group.transform("max")

    out["neighbor_band_prb_mean"] = np.where(
        group_size.gt(1),
        (group_sum - out["prb_load"]) / (group_size - 1),
        0.0,
    )

    is_group_max = out["prb_load"].eq(group_max)
    max_count = is_group_max.groupby(keys, sort=False).transform("sum")
    second_max = out["prb_load"].where(~is_group_max).groupby(keys, sort=False).transform("max").fillna(group_max)

    out["neighbor_band_prb_max"] = np.where(
        group_size.le(1),
        0.0,
        np.where(is_group_max & max_count.eq(1), second_max, group_max),
    )
    return out


def encode_frequency_band(series: pd.Series) -> pd.Series:
    cleaned = series.astype(str).str.strip().str.upper().str.replace(".0", "", regex=False)
    band_map = {"B1": 0, "1": 0, "B3": 1, "3": 1, "B20": 2, "20": 2}
    encoded = cleaned.map(band_map)

    if encoded.isna().any():
        unknown = sorted(series[encoded.isna()].astype(str).unique().tolist())
        raise ValueError(f"Unexpected FREQUENCY_BAND values: {unknown}")

    return encoded.astype(np.int8)


def add_categorical_encodings(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["FREQUENCY_BAND"] = encode_frequency_band(out["FREQUENCY_BAND"])
    out["CELL_ID"] = pd.factorize(out["CELLNAME"], sort=True)[0].astype(np.int32)
    out["ENODEB_ID"] = pd.factorize(out["ENODEB_NAME"], sort=True)[0].astype(np.int16)
    return out


def write_parquet_with_duckdb(df: pd.DataFrame, output_path: Path) -> None:
    con = duckdb.connect()
    try:
        con.register("features_df", df)
        escaped = str(output_path).replace("'", "''")
        con.execute(f"COPY features_df TO '{escaped}' (FORMAT PARQUET)")
    finally:
        con.close()


def build_metadata(df: pd.DataFrame, feature_cols: List[str]) -> Dict[str, object]:
    return {
        "total_rows": int(len(df)),
        "n_cells": int(df["CELLNAME"].nunique()),
        "n_enodebs": int(df["ENODEB_NAME"].nunique()),
        "date_min": df["DATE_ID"].min().isoformat(),
        "date_max": df["DATE_ID"].max().isoformat(),
        "feature_cols": feature_cols,
        "target_cols": TARGET_COLS,
        "imputed_rows_count": int(df["IS_IMPUTED"].sum()),
        "idle_rows_count": int(df["IS_IDLE"].sum()),
    }


def print_summary(df: pd.DataFrame) -> None:
    print(f"shape: {df.shape}")
    print("missing_values_per_column:")
    print(df.isna().sum().to_string())
    print("is_idle_value_counts:")
    print(df["IS_IDLE"].value_counts(dropna=False).to_string())
    print("is_imputed_value_counts:")
    print(df["IS_IMPUTED"].value_counts(dropna=False).to_string())


def run_pipeline(input_csv: Path, output_parquet: Path, output_meta: Path) -> None:
    df = load_data(input_csv)
    df = apply_missing_value_logic(df)
    df = collapse_duplicate_cell_hours(df)
    df = expand_to_complete_hourly_grid(df)
    df = add_time_features(df)
    df = add_lag_and_rolling_features(df)
    df = add_neighbor_band_features(df)
    df = add_categorical_encodings(df)

    feature_cols = [
        "CELL_ID",
        "ENODEB_ID",
        "FREQUENCY_BAND",
        "LOCALCELL_ID",
        "LATITUDE",
        "LONGITUDE",
        "AZIMUTH",
        "cqi",
        "hour_of_day",
        "day_of_week",
        "is_weekend",
        "is_busy_hour",
        "IS_IDLE",
        "IS_IMPUTED",
        "prb_lag1",
        "prb_lag2",
        "prb_lag3",
        "prb_lag6",
        "prb_lag12",
        "prb_lag24",
        "users_lag1",
        "users_lag24",
        "thrput_lag1",
        "thrput_lag24",
        "prb_roll3_mean",
        "prb_roll6_mean",
        "prb_roll24_mean",
        "prb_roll24_max",
        "users_roll3_mean",
        "neighbor_band_prb_mean",
        "neighbor_band_prb_max",
    ]

    ordered_cols = [
        "DATE_ID",
        "ENODEB_NAME",
        "ENODEB_ID",
        "CELLNAME",
        "CELL_ID",
        "LOCALCELL_ID",
        "CELL_TYPE",
        "FREQUENCY_BAND",
        "LATITUDE",
        "LONGITUDE",
        "AZIMUTH",
        "prb_load",
        "active_users",
        "throughput",
        "cqi",
        "IS_IDLE",
        "IS_IMPUTED",
        "hour_of_day",
        "day_of_week",
        "is_weekend",
        "is_busy_hour",
        "prb_lag1",
        "prb_lag2",
        "prb_lag3",
        "prb_lag6",
        "prb_lag12",
        "prb_lag24",
        "users_lag1",
        "users_lag24",
        "thrput_lag1",
        "thrput_lag24",
        "prb_roll3_mean",
        "prb_roll6_mean",
        "prb_roll24_mean",
        "prb_roll24_max",
        "users_roll3_mean",
        "neighbor_band_prb_mean",
        "neighbor_band_prb_max",
    ]
    df = df[ordered_cols]

    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    output_meta.parent.mkdir(parents=True, exist_ok=True)

    write_parquet_with_duckdb(df, output_parquet)
    meta = build_metadata(df, feature_cols)
    output_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print_summary(df)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build engineered 4G RAN features from radio CSV data.")
    parser.add_argument("--input", default="data_set_radio_1.csv", help="Input CSV file path.")
    parser.add_argument("--output-parquet", default="features_engineered.parquet", help="Output parquet path.")
    parser.add_argument("--output-meta", default="features_meta.json", help="Output metadata JSON path.")
    args = parser.parse_args()

    run_pipeline(
        input_csv=Path(args.input),
        output_parquet=Path(args.output_parquet),
        output_meta=Path(args.output_meta),
    )


if __name__ == "__main__":
    main()
