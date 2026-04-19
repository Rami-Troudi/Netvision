from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score

try:
    import requests
except Exception:  # requests is optional for the API smoke check
    requests = None


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ROOT_DIR = PROJECT_ROOT / "runtime_data" / "model_assets"
REPORT_PATH = PROJECT_ROOT / "runtime_data" / "validation_report.txt"

PASS = "PASS"
WARN = "WARN"
FAIL = "FAIL"
SKIP = "SKIP"

ALLOWED_ACTIONS = {
    "Équilibrage MLB",
    "Ajustement Tilt",
    "Ajustement Puissance",
    "Activation carrier (CA)",
    "Tuning paramètres radio",
    "Upgrade MIMO",
    "Small Cell / Micro",
    "Ajout 4ème secteur",
    "Nouveau site macro",
    "Cell Split",
    "Aucune action requise",
}
CAPEX_ACTIONS = {"Nouveau site macro", "Cell Split"}


def _record_result(results: list[dict], check_name: str, status: str, detail: str) -> None:
    results.append({"check": check_name, "status": status, "detail": detail})
    print(f"{status} — {check_name}: {detail}")


def check_1_data_integrity(results: list[dict], state: dict) -> None:
    check_name = "CHECK 1 — Data integrity"
    try:
        features_path = ROOT_DIR / "features_engineered.parquet"
        features_df = pd.read_parquet(features_path)
        state["features_df"] = features_df

        required_cols = {"CELLNAME", "DATE_ID", "prb_load"}
        missing_required = sorted(required_cols - set(features_df.columns))
        if missing_required:
            _record_result(results, check_name, FAIL, f"Missing required columns: {missing_required}")
            return

        n_cells = int(features_df["CELLNAME"].nunique())
        if "ENODEB_NAME" in features_df.columns:
            n_enodebs = int(features_df["ENODEB_NAME"].nunique())
        elif "ENODEB_ID" in features_df.columns:
            n_enodebs = int(features_df["ENODEB_ID"].nunique())
        else:
            _record_result(results, check_name, FAIL, "Missing ENODEB_NAME/ENODEB_ID columns.")
            return

        negative_prb_count = int((features_df["prb_load"] < 0).sum())
        max_prb = float(features_df["prb_load"].max())
        duplicate_count = int(features_df.duplicated(subset=["CELLNAME", "DATE_ID"]).sum())

        failures: list[str] = []
        if n_cells != 1554:
            failures.append(f"n_cells expected 1554, got {n_cells}")
        if n_enodebs != 153:
            failures.append(f"n_enodebs expected 153, got {n_enodebs}")
        if negative_prb_count > 0:
            failures.append(f"{negative_prb_count} rows have negative prb_load")
        if max_prb > 100:
            failures.append(f"prb_load max is {max_prb:.4f} (>100)")
        if duplicate_count > 0:
            failures.append(f"{duplicate_count} duplicate (CELLNAME, DATE_ID) rows found")

        if failures:
            _record_result(results, check_name, FAIL, " | ".join(failures))
            return

        _record_result(
            results,
            check_name,
            PASS,
            f"n_cells={n_cells}, n_enodebs={n_enodebs}, min_prb={features_df['prb_load'].min():.4f}, max_prb={max_prb:.4f}, duplicates=0",
        )
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Exception: {exc}")


def check_2_feature_completeness(results: list[dict], state: dict) -> None:
    check_name = "CHECK 2 — Feature completeness"
    try:
        if "features_df" not in state:
            state["features_df"] = pd.read_parquet(ROOT_DIR / "features_engineered.parquet")
        features_df = state["features_df"]

        meta = json.loads((ROOT_DIR / "features_meta.json").read_text(encoding="utf-8"))
        feature_cols = list(meta.get("feature_cols", []))
        if not feature_cols:
            _record_result(results, check_name, FAIL, "features_meta.json has no feature_cols.")
            return

        missing_cols = [col for col in feature_cols if col not in features_df.columns]
        if missing_cols:
            _record_result(results, check_name, FAIL, f"Missing feature columns in parquet: {missing_cols}")
            return

        nan_ratio = features_df[feature_cols].isna().mean()
        fail_cols = nan_ratio[nan_ratio > 0.05].sort_values(ascending=False)
        warn_cols = nan_ratio[(nan_ratio >= 0.01) & (nan_ratio <= 0.05)].sort_values(ascending=False)

        if not fail_cols.empty:
            detail = ", ".join(f"{col}={ratio * 100:.2f}%" for col, ratio in fail_cols.items())
            _record_result(results, check_name, FAIL, f"NaN > 5% in feature columns: {detail}")
            return

        if not warn_cols.empty:
            detail = ", ".join(f"{col}={ratio * 100:.2f}%" for col, ratio in warn_cols.items())
            _record_result(results, check_name, WARN, f"NaN between 1% and 5% in: {detail}")
            return

        _record_result(
            results,
            check_name,
            PASS,
            f"All {len(feature_cols)} feature columns present; max NaN ratio={nan_ratio.max() * 100:.2f}%",
        )
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Exception: {exc}")


def check_3_model_prediction_sanity(results: list[dict], state: dict) -> None:
    check_name = "CHECK 3 — Model prediction sanity"
    try:
        val_df = pd.read_parquet(ROOT_DIR / "val_predictions.parquet")
        
        # Convert to datetime to match features_df regardless of string type
        try:
            val_df["DATE_ID"] = pd.to_datetime(val_df["DATE_ID"]).dt.tz_localize(None)
        except Exception:
            pass
            
        state["val_df"] = val_df

        required_val_cols = {"CELLNAME", "DATE_ID", "y_true_prb", "y_pred_prb"}
        missing_val_cols = sorted(required_val_cols - set(val_df.columns))
        if missing_val_cols:
            _record_result(results, check_name, FAIL, f"val_predictions.parquet missing columns: {missing_val_cols}")
            return

        if "features_df" not in state:
            state["features_df"] = pd.read_parquet(ROOT_DIR / "features_engineered.parquet")
        features_df = state["features_df"]
        required_feature_cols = {"CELLNAME", "DATE_ID", "is_busy_hour"}
        missing_feature_cols = sorted(required_feature_cols - set(features_df.columns))
        if missing_feature_cols:
            _record_result(results, check_name, FAIL, f"features_engineered.parquet missing columns: {missing_feature_cols}")
            return

        merged = val_df.merge(
            features_df[["CELLNAME", "DATE_ID", "is_busy_hour"]],
            on=["CELLNAME", "DATE_ID"],
            how="left",
        )

        missing_busy_mask = int(merged["is_busy_hour"].isna().sum())
        merged["is_busy_hour"] = merged["is_busy_hour"].fillna(False).astype(bool)

        mae_prb = float(mean_absolute_error(merged["y_true_prb"], merged["y_pred_prb"]))
        busy_df = merged[merged["is_busy_hour"]]
        if busy_df.empty:
            _record_result(results, check_name, FAIL, "No busy-hour rows found for R² computation.")
            return

        r2_busy = float(r2_score(busy_df["y_true_prb"], busy_df["y_pred_prb"]))
        state["prb_mae"] = mae_prb
        state["prb_r2_busy"] = r2_busy

        fail_reasons: list[str] = []
        warn_reasons: list[str] = []
        if mae_prb > 20:
            fail_reasons.append(f"MAE={mae_prb:.4f} (>20)")
        elif mae_prb >= 15:
            warn_reasons.append(f"MAE={mae_prb:.4f} (15-20)")

        if r2_busy < 0.3:
            fail_reasons.append(f"R²_busy={r2_busy:.4f} (<0.3)")
        elif r2_busy < 0.5:
            warn_reasons.append(f"R²_busy={r2_busy:.4f} (0.3-0.5)")

        if missing_busy_mask > 0:
            warn_reasons.append(f"{missing_busy_mask} validation rows missing busy-hour flag after join")

        if fail_reasons:
            _record_result(
                results,
                check_name,
                FAIL,
                "; ".join(fail_reasons + warn_reasons) if warn_reasons else "; ".join(fail_reasons),
            )
            return

        if warn_reasons:
            _record_result(results, check_name, WARN, "; ".join(warn_reasons))
            return

        _record_result(
            results,
            check_name,
            PASS,
            f"MAE={mae_prb:.4f} (<15) and R²_busy={r2_busy:.4f} (>0.5) on {len(busy_df)} busy-hour rows",
        )
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Exception: {exc}")


def check_4_action_engine_coverage(results: list[dict], state: dict) -> None:
    check_name = "CHECK 4 — Action engine coverage"
    try:
        rec_df = pd.read_parquet(ROOT_DIR / "all_cell_recommendations.parquet")
        state["rec_df"] = rec_df

        required_cols = {"CELLNAME", "action", "priority_rank"}
        missing_cols = sorted(required_cols - set(rec_df.columns))
        if missing_cols:
            _record_result(results, check_name, FAIL, f"Missing columns in recommendations parquet: {missing_cols}")
            return

        cells_with_reco = int(rec_df["CELLNAME"].nunique())
        invalid_actions = sorted(set(rec_df["action"].dropna().astype(str)) - ALLOWED_ACTIONS)
        duplicate_priorities = int(rec_df.duplicated(subset=["CELLNAME", "priority_rank"]).sum())

        failures: list[str] = []
        if cells_with_reco != 1554:
            failures.append(f"Cells with recommendations expected 1554, got {cells_with_reco}")
        if invalid_actions:
            failures.append(f"Invalid action values: {invalid_actions}")
        if duplicate_priorities > 0:
            failures.append(f"{duplicate_priorities} duplicated priority_rank values within same CELLNAME")

        if failures:
            _record_result(results, check_name, FAIL, " | ".join(failures))
            return

        _record_result(
            results,
            check_name,
            PASS,
            f"coverage={cells_with_reco}/1554 cells, invalid_actions=0, duplicated_priority_rank=0",
        )
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Exception: {exc}")


def check_5_structural_congestion_plausibility(results: list[dict], state: dict) -> None:
    check_name = "CHECK 5 — Structural congestion plausibility"
    try:
        profile_df = pd.read_parquet(ROOT_DIR / "cell_congestion_profile.parquet")
        state["profile_df"] = profile_df

        required_cols = {"CELLNAME", "is_structural_congestion"}
        missing_cols = sorted(required_cols - set(profile_df.columns))
        if missing_cols:
            _record_result(results, check_name, FAIL, f"Missing columns in profile parquet: {missing_cols}")
            return

        total_cells = int(profile_df["CELLNAME"].nunique())
        structural_cells = int(profile_df["is_structural_congestion"].fillna(False).astype(bool).sum())
        state["n_structural"] = structural_cells
        ratio = (structural_cells / total_cells) if total_cells else 0.0

        if structural_cells == 0 or ratio > 0.80:
            _record_result(
                results,
                check_name,
                FAIL,
                f"Structural congestion ratio={ratio * 100:.2f}% ({structural_cells}/{total_cells})",
            )
            return

        if 0.05 <= ratio <= 0.60:
            _record_result(
                results,
                check_name,
                PASS,
                f"Structural congestion ratio={ratio * 100:.2f}% ({structural_cells}/{total_cells})",
            )
            return

        _record_result(
            results,
            check_name,
            WARN,
            f"Structural congestion ratio out of target range (5%-60%): {ratio * 100:.2f}% ({structural_cells}/{total_cells})",
        )
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Exception: {exc}")


def check_6_capex_action_sanity(results: list[dict], state: dict) -> None:
    check_name = "CHECK 6 — CAPEX action sanity"
    try:
        if "rec_df" not in state:
            state["rec_df"] = pd.read_parquet(ROOT_DIR / "all_cell_recommendations.parquet")
        rec_df = state["rec_df"]

        required_cols = {"CELLNAME", "action", "priority_rank"}
        missing_cols = sorted(required_cols - set(rec_df.columns))
        if missing_cols:
            _record_result(results, check_name, FAIL, f"Missing columns in recommendations parquet: {missing_cols}")
            return

        top_capex_cells = int(
            rec_df[
                rec_df["priority_rank"].eq(1) & rec_df["action"].isin(CAPEX_ACTIONS)
            ]["CELLNAME"].nunique()
        )
        total_cells = int(rec_df["CELLNAME"].nunique())
        ratio = (top_capex_cells / total_cells) if total_cells else 0.0
        state["n_capex"] = top_capex_cells

        if ratio > 0.10:
            _record_result(
                results,
                check_name,
                WARN,
                f"Top-priority CAPEX actions for {top_capex_cells}/{total_cells} cells ({ratio * 100:.2f}%)",
            )
            return

        _record_result(
            results,
            check_name,
            PASS,
            f"Top-priority CAPEX actions for {top_capex_cells}/{total_cells} cells ({ratio * 100:.2f}%)",
        )
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Exception: {exc}")


def check_7_api_smoke_test(results: list[dict], state: dict) -> None:
    check_name = "CHECK 7 — API smoke test"
    if requests is None:
        _record_result(results, check_name, SKIP, "SKIP — API not running, start with: python run_backend.py")
        return

    try:
        response = requests.get("http://localhost:8000/health", timeout=2)
        state["api_status_code"] = response.status_code
        _record_result(results, check_name, PASS, f"API reachable at /health (status_code={response.status_code})")
    except Exception:
        _record_result(results, check_name, SKIP, "SKIP — API not running, start with: python run_backend.py")


def build_report(results: list[dict], state: dict) -> str:
    timestamp = datetime.now().isoformat(timespec="seconds")

    rec_df = state.get("rec_df")
    profile_df = state.get("profile_df")
    n_cells_scored = int(rec_df["CELLNAME"].nunique()) if isinstance(rec_df, pd.DataFrame) else 0
    n_structural = int(state.get("n_structural", 0))
    n_capex = int(state.get("n_capex", 0))
    prb_mae = state.get("prb_mae")
    prb_r2_busy = state.get("prb_r2_busy")

    most_common_action = "N/A"
    top5_text = "N/A"
    if isinstance(rec_df, pd.DataFrame) and not rec_df.empty:
        top_per_cell = (
            rec_df.sort_values(["CELLNAME", "priority_rank"])
            .groupby("CELLNAME", as_index=False)
            .first()
            .reset_index(drop=True)
        )
        if not top_per_cell.empty:
            most_common_action = str(top_per_cell["action"].value_counts().idxmax())
            top5 = top_per_cell.sort_values("predicted_prb", ascending=False).head(5).copy()
            top5 = top5[["CELLNAME", "ENODEB_NAME", "predicted_prb", "action"]]
            top5_text = top5.to_string(
                index=False,
                formatters={"predicted_prb": lambda x: f"{float(x):.2f}"},
            )

    statuses = [item["status"] for item in results if item["check"] != "CHECK 7 — API smoke test"]
    if FAIL in statuses:
        overall_status = "FAILED"
    elif WARN in statuses:
        overall_status = "NEEDS REVIEW"
    else:
        overall_status = "READY FOR USE"

    lines: list[str] = []
    lines.append("4G RAN Congestion Pipeline Validation Report")
    lines.append("=" * 48)
    lines.append(f"Timestamp: {timestamp}")
    lines.append("")
    lines.append("Check Results")
    lines.append("-" * 48)
    for item in results:
        lines.append(f"{item['status']:<5} | {item['check']} | {item['detail']}")
    lines.append("")
    lines.append("Summary Statistics")
    lines.append("-" * 48)
    lines.append(f"n_cells_scored: {n_cells_scored}")
    lines.append(f"n_structurally_congested: {n_structural}")
    lines.append(f"n_needing_capex: {n_capex}")
    lines.append(
        "PRB model MAE: "
        + (f"{float(prb_mae):.4f}" if prb_mae is not None else "N/A")
    )
    lines.append(
        "PRB model R² on busy hours: "
        + (f"{float(prb_r2_busy):.4f}" if prb_r2_busy is not None else "N/A")
    )
    lines.append(f"Most common recommended action: {most_common_action}")
    lines.append("")
    lines.append("Top 5 cells by predicted PRB next hour")
    lines.append("-" * 48)
    lines.append(top5_text)
    lines.append("")
    lines.append(f"Overall pipeline status: {overall_status}")
    return "\n".join(lines) + "\n"


def main() -> None:
    results: list[dict] = []
    state: dict = {}

    check_1_data_integrity(results, state)
    check_2_feature_completeness(results, state)
    check_3_model_prediction_sanity(results, state)
    check_4_action_engine_coverage(results, state)
    check_5_structural_congestion_plausibility(results, state)
    check_6_capex_action_sanity(results, state)
    check_7_api_smoke_test(results, state)

    report_text = build_report(results, state)
    REPORT_PATH.write_text(report_text, encoding="utf-8")

    print("\n" + "=" * 48)
    print(report_text, end="")


if __name__ == "__main__":
    main()
