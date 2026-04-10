from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from forecast_hf import (
    BASELINE_PATH,
    TRAINED_MODEL_PATH,
    TimeSeriesForecaster,
    load_historical_data,
    load_json,
    log,
    save_trained_forecaster,
)


def train_forecast_model(model_path: Path, history_limit: int | None = None) -> dict:
    if not BASELINE_PATH.exists():
        raise FileNotFoundError(f"Missing baseline file: {BASELINE_PATH}")

    baseline = load_json(BASELINE_PATH)
    effective_limit = None if history_limit is None or int(history_limit) <= 0 else int(history_limit)

    log("Loading full historical time slices for training...")
    historical = load_historical_data(limit=effective_limit)
    if not historical:
        raise RuntimeError("No historical data found in runtime_data/time_index.json and runtime_data/time_data.")

    log(f"Training forecaster on {len(historical)} time slices...")
    forecaster = TimeSeriesForecaster(historical)

    metadata = {
        "trained_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "history_slices": len(historical),
        "n_cells": len(baseline),
        "history_limit": effective_limit,
        "source": "runtime_data/time_index_and_time_data",
    }

    save_trained_forecaster(
        model_path=model_path,
        forecaster=forecaster,
        baseline=baseline,
        metadata=metadata,
    )

    summary = {
        "success": True,
        "model_path": str(model_path),
        "history_slices": len(historical),
        "n_cells": len(baseline),
        "history_limit": effective_limit,
    }
    print(json.dumps(summary))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Train and persist NetVision forecast model on full historical data.")
    parser.add_argument("--model-path", type=str, default=str(TRAINED_MODEL_PATH))
    parser.add_argument(
        "--history-limit",
        type=int,
        default=0,
        help="Optional number of latest slices to train on. Use 0 for full history.",
    )
    args = parser.parse_args()

    model_path = Path(args.model_path)
    history_limit = None if args.history_limit <= 0 else args.history_limit

    try:
        train_forecast_model(model_path=model_path, history_limit=history_limit)
    except Exception as exc:
        log(f"TRAINING FAILED: {type(exc).__name__}: {exc}", "ERROR")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
