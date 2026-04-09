"""
Train global LightGBM next-hour forecasting models for 4G RAN KPIs.

Artifacts:
- models/model_prb.pkl
- models/model_users.pkl
- models/model_thrput.pkl
- val_predictions.parquet
"""

import argparse
import json
from pathlib import Path
from typing import Dict, List, Tuple

import duckdb
import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score


REQUIRED_FEATURES = [
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
    "FREQUENCY_BAND",
    "CELL_ID",
    "ENODEB_ID",
    "LATITUDE",
    "LONGITUDE",
    "AZIMUTH",
]

MODEL_PARAMS = {
    "objective": "regression_l1",
    "n_estimators": 1000,
    "learning_rate": 0.05,
    "num_leaves": 63,
    "min_child_samples": 30,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 0.1,
    "n_jobs": -1,
    "verbose": -1,
}


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
        con.register("pred_df", df)
        escaped_path = str(path).replace("'", "''")
        con.execute(f"COPY pred_df TO '{escaped_path}' (FORMAT PARQUET)")
    finally:
        con.close()


def resolve_feature_columns(meta_path: Path) -> List[str]:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta_features = list(meta.get("feature_cols", []))
    missing = [col for col in REQUIRED_FEATURES if col not in meta_features]
    if missing:
        raise ValueError(f"Required feature(s) not found in features_meta.json: {missing}")
    return REQUIRED_FEATURES


def build_modeling_frame(df: pd.DataFrame) -> Tuple[pd.DataFrame, str]:
    data = df.sort_values(["CELLNAME", "DATE_ID"]).copy()
    data["DATE_ID"] = pd.to_datetime(data["DATE_ID"], errors="coerce")
    if data["DATE_ID"].isna().any():
        raise ValueError("DATE_ID contains unparsable timestamps.")

    throughput_col = "throughput_kbps" if "throughput_kbps" in data.columns else "throughput"
    if throughput_col not in data.columns:
        raise ValueError("Neither throughput_kbps nor throughput is present in features data.")

    grouped = data.groupby("CELLNAME", sort=False)
    data["target_prb"] = grouped["prb_load"].shift(-1)
    data["target_users"] = grouped["active_users"].shift(-1)
    data["target_thrput"] = grouped[throughput_col].shift(-1)
    data["target_is_imputed"] = grouped["IS_IMPUTED"].shift(-1)

    target_mask = (
        data["target_prb"].notna()
        & data["target_users"].notna()
        & data["target_thrput"].notna()
        & data["target_is_imputed"].eq(False)
    )
    data = data.loc[target_mask].copy()
    data.drop(columns=["target_is_imputed"], inplace=True)
    return data, throughput_col


def temporal_train_val_split(df: pd.DataFrame, val_days: int = 5) -> Tuple[pd.DataFrame, pd.DataFrame]:
    unique_ts = np.sort(df["DATE_ID"].unique())
    val_hours = val_days * 24
    if len(unique_ts) <= val_hours:
        raise ValueError("Not enough timestamps to create a 5-day validation split.")

    val_start_ts = pd.Timestamp(unique_ts[-val_hours])
    train_df = df[df["DATE_ID"] < val_start_ts].copy()
    val_df = df[df["DATE_ID"] >= val_start_ts].copy()

    if train_df.empty or val_df.empty:
        raise ValueError("Temporal split resulted in empty train or validation set.")

    return train_df, val_df


def evaluate(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    return {
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "r2": float(r2_score(y_true, y_pred)),
    }


def train_single_model(
    model_name: str,
    X_train: pd.DataFrame,
    y_train: pd.Series,
    X_val: pd.DataFrame,
    y_val: pd.Series,
    model_path: Path,
) -> Tuple[LGBMRegressor, np.ndarray]:
    model = LGBMRegressor(**MODEL_PARAMS)
    model.fit(
        X_train,
        y_train,
        eval_set=[(X_val, y_val)],
        eval_metric="l1",
        callbacks=[lgb.early_stopping(stopping_rounds=50, verbose=False)],
    )

    best_iteration = int(model.best_iteration_ or MODEL_PARAMS["n_estimators"])
    train_pred = model.predict(X_train, num_iteration=best_iteration)
    val_pred = model.predict(X_val, num_iteration=best_iteration)

    train_metrics = evaluate(y_train.values, train_pred)
    val_metrics = evaluate(y_val.values, val_pred)

    print(f"\n{model_name}")
    print(f"Best iteration: {best_iteration}")
    print(f"Train MAE: {train_metrics['mae']:.6f}")
    print(f"Validation MAE: {val_metrics['mae']:.6f}")
    print(f"Validation RMSE: {val_metrics['rmse']:.6f}")
    print(f"Validation R²: {val_metrics['r2']:.6f}")

    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, model_path)
    return model, val_pred


def run_training(features_path: Path, meta_path: Path, models_dir: Path, val_preds_path: Path) -> None:
    feature_cols = resolve_feature_columns(meta_path)
    df = read_parquet_df(features_path)
    df, throughput_col = build_modeling_frame(df)
    train_df, val_df = temporal_train_val_split(df, val_days=5)

    X_train = train_df[feature_cols]
    X_val = val_df[feature_cols]

    _, val_pred_prb = train_single_model(
        model_name="Model A (target_prb)",
        X_train=X_train,
        y_train=train_df["target_prb"],
        X_val=X_val,
        y_val=val_df["target_prb"],
        model_path=models_dir / "model_prb.pkl",
    )

    _, val_pred_users = train_single_model(
        model_name="Model B (target_users)",
        X_train=X_train,
        y_train=train_df["target_users"],
        X_val=X_val,
        y_val=val_df["target_users"],
        model_path=models_dir / "model_users.pkl",
    )

    _, val_pred_thrput = train_single_model(
        model_name="Model C (target_thrput)",
        X_train=X_train,
        y_train=train_df["target_thrput"],
        X_val=X_val,
        y_val=val_df["target_thrput"],
        model_path=models_dir / "model_thrput.pkl",
    )

    val_out = val_df[
        [
            "DATE_ID",
            "CELLNAME",
            "ENODEB_NAME",
            "FREQUENCY_BAND",
            "target_prb",
            "target_users",
            "target_thrput",
        ]
    ].copy()
    val_out.rename(
        columns={
            "target_prb": "y_true_prb",
            "target_users": "y_true_users",
            "target_thrput": "y_true_thrput",
        },
        inplace=True,
    )
    val_out["y_pred_prb"] = val_pred_prb
    val_out["y_pred_users"] = val_pred_users
    val_out["y_pred_thrput"] = val_pred_thrput
    val_out = val_out[
        [
            "DATE_ID",
            "CELLNAME",
            "ENODEB_NAME",
            "FREQUENCY_BAND",
            "y_true_prb",
            "y_pred_prb",
            "y_true_users",
            "y_pred_users",
            "y_true_thrput",
            "y_pred_thrput",
        ]
    ].sort_values(["DATE_ID", "CELLNAME"])

    val_preds_path.parent.mkdir(parents=True, exist_ok=True)
    write_parquet_df(val_out, val_preds_path)

    print("\nSaved artifacts:")
    print(f"- {models_dir / 'model_prb.pkl'}")
    print(f"- {models_dir / 'model_users.pkl'}")
    print(f"- {models_dir / 'model_thrput.pkl'}")
    print(f"- {val_preds_path}")
    print(f"Validation rows: {len(val_out):,}")
    print(f"Throughput source column: {throughput_col}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train global LightGBM next-hour KPI forecasting models.")
    parser.add_argument("--features", default="features_engineered.parquet", help="Input engineered features parquet.")
    parser.add_argument("--meta", default="features_meta.json", help="Input features metadata JSON.")
    parser.add_argument("--models-dir", default="models", help="Output directory for model pkl files.")
    parser.add_argument("--val-preds", default="val_predictions.parquet", help="Output validation predictions parquet.")
    args = parser.parse_args()

    run_training(
        features_path=Path(args.features),
        meta_path=Path(args.meta),
        models_dir=Path(args.models_dir),
        val_preds_path=Path(args.val_preds),
    )


if __name__ == "__main__":
    main()
