"""Unified congestion rules and thresholds for the NetVision pipeline.

This module is the **single source of truth** for:
- Network KPI thresholds (PRB, throughput, CQI, active users)
- Congestion detection logic
- Recovery rate constants

Both the data-processing pipeline (`scripts/process_time_series.py`) and the
runtime decision engine (`backend/action_engine.py`) MUST import from here
rather than defining their own copies.
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# KPI Thresholds — Orange DRS Standard
# ---------------------------------------------------------------------------

# PRB Load (Physical Resource Block) thresholds
PRB_SATURATED: float = 90.0       # Saturé — critical, always congested
PRB_HIGH: float = 80.0            # Target threshold
PRB_MEDIUM: float = 70.0          # Pre-warning / rebalancing headroom
PRB_LOW: float = 50.0             # Normal operation

# Throughput thresholds (kbps)
THROUGHPUT_DEGRADED: float = 4_000.0   # < 4 Mbps = degraded
THROUGHPUT_TARGET: float = 10_000.0    # >= 10 Mbps = target QoE
THROUGHPUT_CRITICAL: float = 2_000.0   # Very poor

# Active users (file d'attente)
ACTIVE_USERS_CRITICAL: float = 4.0     # > 4 = critical queue
RRC_USERS_CRITICAL: float = 4.0        # Same threshold for RRC users

# CQI (Channel Quality Indicator, 0-15)
CQI_POOR: float = 8.0                 # Poor quality
CQI_CRITICAL: float = 5.0             # Very poor signal
CQI_LOW: float = 7.0                  # Below acceptable

# Busy-hour detection
STRUCTURAL_BUSY_HOUR_PRB: float = 75.0

# Severity threshold for congestion fallback
SEVERITY_CONGESTED: int = 50

# Site-wide saturation guardrails for CAPEX recommendations.
# Add Site should only be considered when most cells on a site are saturated
# across multiple calendar days, not from a single hot snapshot.
SITE_SATURATION_CELL_RATIO: float = 0.60
SITE_SATURATION_MIN_DAYS: int = 3


# ---------------------------------------------------------------------------
# Recovery Rates (%) — per-action type
# ---------------------------------------------------------------------------

RECOVERY_RATES: dict[str, float] = {
    "tilt_adjustment": 15.0,
    "load_rebalancing": 40.0,
    "carrier_extension": 50.0,
    "actions_on_neighbors": 35.0,
    "add_band": 50.0,
    "new_sector": 85.0,
    "new_site": 90.0,
    "check_coverage": 10.0,
}

# Display-name → internal key mapping (used by action engine)
ACTION_NAME_TO_RATE_KEY: dict[str, str] = {
    "Load Rebalancing": "load_rebalancing",
    "Actions on Neighbors": "actions_on_neighbors",
    "Tilt Adjustment": "tilt_adjustment",
    "Carrier Extension": "carrier_extension",
    "Add Band": "add_band",
    "Add Sector": "new_sector",
    "Add Site": "new_site",
    "Check Coverage/Interference": "check_coverage",
}

# Estimated baseline loss for a congested cell
LOST_UE_BASELINE: int = 50
LOST_GB_BASELINE: float = 120.0


# ---------------------------------------------------------------------------
# Congestion Detection
# ---------------------------------------------------------------------------

def is_congested(
    *,
    prb_load: float,
    throughput: float,
    active_users: float = 0.0,
    severity: int = 0,
) -> bool:
    """Determine whether a cell is congested using the unified Orange rules.

    Rules (evaluated in priority order):
      1. PRB >= 90 %  →  always congested
      2. PRB >= 80 % AND throughput < 4 Mbps
      3. Active users > 4 AND PRB >= 70 %
      4. Throughput < 4 Mbps AND PRB >= 70 %
      5. Severity score >= 50

    Returns ``True`` if **any** rule fires.
    """
    if prb_load >= PRB_SATURATED:
        return True
    if prb_load >= PRB_HIGH and throughput < THROUGHPUT_DEGRADED:
        return True
    if active_users > ACTIVE_USERS_CRITICAL and prb_load >= PRB_MEDIUM:
        return True
    if throughput < THROUGHPUT_DEGRADED and prb_load >= PRB_MEDIUM:
        return True
    if severity >= SEVERITY_CONGESTED:
        return True
    return False
