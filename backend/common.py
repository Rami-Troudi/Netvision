from __future__ import annotations

from numbers import Real
from typing import Any

import pandas as pd


ENCODED_BAND_MAP = {0: "B1", 1: "B3", 2: "B20"}


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if pd.isna(out):
        return default
    return out


def to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or pd.isna(value):
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "t", "yes", "y"}
    return bool(value)


def normalize_band(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""

    if isinstance(value, Real):
        int_value = int(value)
        if int_value in ENCODED_BAND_MAP:
            return ENCODED_BAND_MAP[int_value]

    text = str(value).strip().upper().replace(".0", "")
    if text in {"B1", "1"}:
        return "B1"
    if text in {"B3", "3"}:
        return "B3"
    if text in {"B20", "20"}:
        return "B20"
    if text in {"0", "1", "2"}:
        return ENCODED_BAND_MAP[int(text)]
    return text
