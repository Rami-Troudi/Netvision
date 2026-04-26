from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

try:
    import requests
except Exception:  # requests is optional for the API smoke check
    requests = None


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

RUNTIME_DIR = PROJECT_ROOT / "runtime_data"
TIME_DATA_DIR = RUNTIME_DIR / "time_data"
REPORT_PATH = RUNTIME_DIR / "validation_report.txt"
DRIFT_ASSET_PATH = RUNTIME_DIR / "model_assets" / "val_predictions.parquet"

PASS = "PASS"
WARN = "WARN"
FAIL = "FAIL"
SKIP = "SKIP"

REQUIRED_BASELINE_FIELDS = {
    "enodeb_name",
    "longitude",
    "latitude",
    "azimuth",
    "frequency_band",
    "localcell_id",
}
REQUIRED_OBSERVATION_COLUMNS = {
    "cell_name",
    "load",
    "throughput",
    "cqi",
    "traffic",
    "congested",
    "severity",
    "issue_type",
    "root_cause",
    "health_score",
}
VALID_ACTION_LABELS = {
    "Load Rebalancing",
    "Actions on Neighbors",
    "Tilt Adjustment",
    "Carrier Extension",
    "Add Band",
    "Add Sector",
    "Add Site",
    "Check Coverage/Interference",
    "No Action Required",
}


def _record_result(results: list[dict[str, str]], check_name: str, status: str, detail: str) -> None:
    results.append({"check": check_name, "status": status, "detail": detail})
    print(f"{status} - {check_name}: {detail}")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_parquet_schema(path: Path) -> tuple[int, set[str]]:
    con = duckdb.connect()
    try:
        row_count = int(con.execute("SELECT count(*) FROM read_parquet(?)", [str(path)]).fetchone()[0])
        schema_rows = con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()
        columns = {str(row[0]) for row in schema_rows}
        return row_count, columns
    finally:
        con.close()


def check_1_runtime_data_contract(results: list[dict[str, str]], state: dict[str, Any]) -> None:
    check_name = "CHECK 1 - Runtime data contract"
    missing = [
        path
        for path in [
            RUNTIME_DIR / "baseline.json",
            RUNTIME_DIR / "time_index.json",
            RUNTIME_DIR / "stats.json",
            TIME_DATA_DIR,
        ]
        if not path.exists()
    ]
    if missing:
        _record_result(results, check_name, FAIL, "Missing runtime paths: " + ", ".join(str(p.relative_to(PROJECT_ROOT)) for p in missing))
        return

    try:
        baseline = _load_json(RUNTIME_DIR / "baseline.json")
        time_index = _load_json(RUNTIME_DIR / "time_index.json")
        stats = _load_json(RUNTIME_DIR / "stats.json")
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Could not parse runtime JSON: {exc}")
        return

    if not isinstance(baseline, dict) or not baseline:
        _record_result(results, check_name, FAIL, "baseline.json must be a non-empty object keyed by cell name")
        return

    timestamps = time_index.get("timestamps") if isinstance(time_index, dict) else None
    if not isinstance(timestamps, list) or not timestamps:
        _record_result(results, check_name, FAIL, "time_index.json must include a non-empty timestamps array")
        return

    invalid_baseline = []
    for cell_name, meta in baseline.items():
        if not isinstance(meta, dict):
            invalid_baseline.append(str(cell_name))
            continue
        missing_fields = REQUIRED_BASELINE_FIELDS - set(meta)
        if missing_fields:
            invalid_baseline.append(f"{cell_name} missing {sorted(missing_fields)}")
    if invalid_baseline:
        _record_result(results, check_name, FAIL, "Invalid baseline rows: " + "; ".join(invalid_baseline[:5]))
        return

    missing_slices = []
    row_total = 0
    for entry in timestamps:
        filename = str(entry.get("filename") or "").strip() if isinstance(entry, dict) else ""
        if not filename:
            missing_slices.append("<empty filename>")
            continue
        slice_path = TIME_DATA_DIR / filename
        if not slice_path.exists():
            missing_slices.append(filename)
            continue
        rows, columns = _read_parquet_schema(slice_path)
        row_total += rows
        missing_columns = REQUIRED_OBSERVATION_COLUMNS - columns
        if missing_columns:
            _record_result(results, check_name, FAIL, f"{filename} missing observation columns: {sorted(missing_columns)}")
            return

    if missing_slices:
        _record_result(results, check_name, FAIL, "Missing time slices: " + ", ".join(missing_slices[:10]))
        return

    state["baseline"] = baseline
    state["time_index"] = time_index
    state["stats"] = stats if isinstance(stats, dict) else {}
    state["runtime_row_total"] = row_total
    _record_result(
        results,
        check_name,
        PASS,
        f"cells={len(baseline)}, timestamps={len(timestamps)}, observation_rows={row_total}",
    )


def check_2_action_engine_import_and_sample(results: list[dict[str, str]], state: dict[str, Any]) -> None:
    check_name = "CHECK 2 - Action engine import and sample evaluation"
    try:
        from backend import action_engine
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Could not import backend.action_engine: {exc}")
        return

    baseline = state.get("baseline") or {}
    if not baseline:
        _record_result(results, check_name, FAIL, "No baseline loaded from previous check")
        return

    try:
        context = action_engine.build_context_from_runtime(PROJECT_ROOT)
        observations_df = context.get("observations_df")
        if not isinstance(observations_df, pd.DataFrame) or observations_df.empty:
            _record_result(results, check_name, FAIL, "Action engine context has no observations")
            return

        sample_cell = str(observations_df.sort_values("timestamp").iloc[-1]["cell_name"])
        payload = action_engine.evaluate_cell(cell_name=sample_cell, context=context)
        actions = payload.get("recommended_actions")
        if not isinstance(actions, list) or not actions:
            _record_result(results, check_name, FAIL, f"No recommended_actions returned for sample cell {sample_cell}")
            return

        invalid_actions = sorted(
            {
                str(action.get("action_name") or action.get("action") or "").strip()
                for action in actions
                if isinstance(action, dict)
            }
            - VALID_ACTION_LABELS
        )
        if invalid_actions:
            _record_result(results, check_name, FAIL, f"Unexpected action labels: {invalid_actions}")
            return

        state["sample_cell"] = sample_cell
        state["sample_recommendation"] = payload
        _record_result(results, check_name, PASS, f"sample_cell={sample_cell}, actions={len(actions)}")
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Action engine sample failed: {exc}")


def check_3_simulator_smoke(results: list[dict[str, str]], state: dict[str, Any]) -> None:
    check_name = "CHECK 3 - Simulator smoke"
    sample_cell = str(state.get("sample_cell") or "")
    if not sample_cell:
        baseline = state.get("baseline") or {}
        sample_cell = next(iter(baseline), "")
    if not sample_cell:
        _record_result(results, check_name, FAIL, "No sample cell available")
        return

    try:
        from simulation.simulator import simulate_action

        result = simulate_action(
            PROJECT_ROOT,
            sample_cell,
            "tilt",
            {"degrees": 2},
        )
        required_keys = {"cell", "action", "before", "after", "impact", "confidence"}
        missing = required_keys - set(result)
        if missing:
            _record_result(results, check_name, FAIL, f"Simulator result missing keys: {sorted(missing)}")
            return
        _record_result(results, check_name, PASS, f"tilt simulation completed for {sample_cell}")
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Simulator smoke failed: {exc}")


def check_4_optional_drift_assets(results: list[dict[str, str]], state: dict[str, Any]) -> None:
    check_name = "CHECK 4 - Optional drift assets"
    if not DRIFT_ASSET_PATH.exists():
        _record_result(results, check_name, SKIP, "Drift validation asset is absent; /api/drift should return an available=false empty payload")
        return

    try:
        rows, columns = _read_parquet_schema(DRIFT_ASSET_PATH)
        required = {"CELLNAME", "DATE_ID", "y_true_prb", "y_pred_prb"}
        missing = required - columns
        if missing:
            _record_result(results, check_name, FAIL, f"Drift asset missing columns: {sorted(missing)}")
            return
        _record_result(results, check_name, PASS, f"drift rows={rows}")
    except Exception as exc:
        _record_result(results, check_name, FAIL, f"Could not inspect drift asset: {exc}")


def check_5_api_smoke_test(results: list[dict[str, str]], state: dict[str, Any]) -> None:
    check_name = "CHECK 5 - API smoke test"
    if requests is None:
        _record_result(results, check_name, SKIP, "requests is unavailable")
        return

    try:
        response = requests.get("http://localhost:8000/health", timeout=2)
        if response.status_code != 200:
            _record_result(results, check_name, WARN, f"API reachable but returned status_code={response.status_code}")
            return
        _record_result(results, check_name, PASS, "API reachable at /health")
    except Exception:
        _record_result(results, check_name, SKIP, "API not running; start with python run_backend.py")


def build_report(results: list[dict[str, str]], state: dict[str, Any]) -> str:
    timestamp = datetime.now().isoformat(timespec="seconds")
    blocking_statuses = [item["status"] for item in results if item["status"] != SKIP]
    if FAIL in blocking_statuses:
        overall_status = "FAILED"
    elif WARN in blocking_statuses:
        overall_status = "NEEDS REVIEW"
    else:
        overall_status = "READY FOR USE"

    lines = [
        "NetVision Runtime Validation Report",
        "=" * 48,
        f"Timestamp: {timestamp}",
        "",
        "Check Results",
        "-" * 48,
    ]
    for item in results:
        lines.append(f"{item['status']:<5} | {item['check']} | {item['detail']}")

    stats = state.get("stats") or {}
    lines.extend(
        [
            "",
            "Summary Statistics",
            "-" * 48,
            f"n_cells_runtime: {len(state.get('baseline') or {})}",
            f"n_timestamps_runtime: {len((state.get('time_index') or {}).get('timestamps') or [])}",
            f"n_observation_rows_runtime: {int(state.get('runtime_row_total') or 0)}",
            f"frequency_bands: {stats.get('frequency_bands', 'N/A')}",
            f"sample_cell: {state.get('sample_cell', 'N/A')}",
            "",
            f"Overall pipeline status: {overall_status}",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    results: list[dict[str, str]] = []
    state: dict[str, Any] = {}

    check_1_runtime_data_contract(results, state)
    check_2_action_engine_import_and_sample(results, state)
    check_3_simulator_smoke(results, state)
    check_4_optional_drift_assets(results, state)
    check_5_api_smoke_test(results, state)

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    report_text = build_report(results, state)
    REPORT_PATH.write_text(report_text, encoding="utf-8")

    print("\n" + "=" * 48)
    print(report_text, end="")


if __name__ == "__main__":
    main()
