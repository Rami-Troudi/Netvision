"""
NetVision Digital Twin - Action Simulation Engine
-------------------------------------------------
Physics-based simulation for what-if remediation actions using LTE
propagation models and realistic constraints. Digital Twin accuracy
is paramount - all values are bounded by physical limits.
"""

import argparse
import json
import math
import os
from pathlib import Path
from typing import Dict, Any, Tuple, List, Optional, Union

# ============================================================================
# PHYSICAL CONSTANTS & LTE CONSTRAINTS
# ============================================================================

# LTE Physical Limits (3GPP specifications)
PHYSICAL_LIMITS = {
    "CQI_MIN": 1,           # Minimum CQI (QPSK, very low rate)
    "CQI_MAX": 15,          # Maximum CQI (64QAM, highest rate)
    "PRB_LOAD_MIN": 0.0,    # Minimum PRB utilization %
    "PRB_LOAD_MAX": 100.0,  # Maximum PRB utilization %
    "TILT_MIN": 0,          # Minimum electrical downtilt (degrees)
    "TILT_MAX": 15,         # Maximum electrical downtilt (degrees)
    "POWER_MIN_DBM": 20,    # Minimum eNodeB TX power
    "POWER_MAX_DBM": 60,    # Maximum eNodeB TX power (macro)
    "SINR_MIN_DB": -10,     # Minimum practical SINR
    "SINR_MAX_DB": 30,      # Maximum practical SINR
    "TA_MIN": 0,            # Minimum Timing Advance
    "TA_MAX": 63,           # Maximum Timing Advance (LTE limit)
    "AZIMUTH_MIN": 0,       # Degrees
    "AZIMUTH_MAX": 360,     # Degrees
    "THROUGHPUT_MIN_KBPS": 0,
    "HEALTH_MIN": 0,
    "HEALTH_MAX": 100,
}

# CQI to Spectral Efficiency mapping (3GPP TS 36.213)
# More accurate than linear interpolation
CQI_SPECTRAL_EFFICIENCY = {
    1: 0.1523, 2: 0.2344, 3: 0.3770, 4: 0.6016, 5: 0.8770,
    6: 1.1758, 7: 1.4766, 8: 1.9141, 9: 2.4063, 10: 2.7305,
    11: 3.3223, 12: 3.9023, 13: 4.5234, 14: 5.1152, 15: 5.5547
}

# Band-specific parameters (realistic LTE deployments)
BAND_PARAMETERS = {
    1:  {"name": "L2100", "bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.5, "capacity_mbps": 150},
    3:  {"name": "L1800", "bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.4, "capacity_mbps": 150},
    7:  {"name": "L2600", "bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.8, "capacity_mbps": 200},
    20: {"name": "L800",  "bw_mhz": 10, "max_prb": 50,  "path_loss_exp": 3.0, "capacity_mbps": 75},
    38: {"name": "TDD2600", "bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.7, "capacity_mbps": 150},
    40: {"name": "TDD2300", "bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.6, "capacity_mbps": 140},
    41: {"name": "TDD2500", "bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.7, "capacity_mbps": 150},
}

DEFAULT_BAND_PARAMS = {"name": "Unknown", "bw_mhz": 10, "max_prb": 50, "path_loss_exp": 3.5, "capacity_mbps": 100}

# ============================================================================
# UTILITY FUNCTIONS WITH PHYSICAL BOUNDS
# ============================================================================

def clamp(val: float, lo: float, hi: float) -> float:
    """Clamp value to physical bounds"""
    if val is None:
        return lo
    return max(lo, min(hi, float(val)))


def clamp_cqi(cqi: float) -> float:
    return clamp(cqi, PHYSICAL_LIMITS["CQI_MIN"], PHYSICAL_LIMITS["CQI_MAX"])


def clamp_load(load: float) -> float:
    return clamp(load, PHYSICAL_LIMITS["PRB_LOAD_MIN"], PHYSICAL_LIMITS["PRB_LOAD_MAX"])


def clamp_throughput(tp: float) -> float:
    return max(PHYSICAL_LIMITS["THROUGHPUT_MIN_KBPS"], tp) if tp else 0


def clamp_sinr(sinr: float) -> float:
    return clamp(sinr, PHYSICAL_LIMITS["SINR_MIN_DB"], PHYSICAL_LIMITS["SINR_MAX_DB"])


def clamp_tilt(tilt: float) -> float:
    return clamp(tilt, PHYSICAL_LIMITS["TILT_MIN"], PHYSICAL_LIMITS["TILT_MAX"])


def get_band_params(band_raw: Any) -> Dict[str, Any]:
    """Get physical parameters for a frequency band"""
    try:
        b = int(band_raw)
    except Exception:
        return DEFAULT_BAND_PARAMS
    return BAND_PARAMETERS.get(b, DEFAULT_BAND_PARAMS)


def map_band_name(band_raw: Any) -> str:
    return get_band_params(band_raw)["name"]


def cqi_to_spectral_efficiency(cqi: float) -> float:
    """Convert CQI to spectral efficiency (bits/s/Hz) using 3GPP mapping"""
    cqi_int = int(clamp_cqi(round(cqi)))
    return CQI_SPECTRAL_EFFICIENCY.get(cqi_int, 1.0)


def spectral_efficiency_to_cqi(se: float) -> float:
    """Inverse: spectral efficiency to approximate CQI"""
    for cqi, eff in sorted(CQI_SPECTRAL_EFFICIENCY.items(), reverse=True):
        if se >= eff:
            return float(cqi)
    return 1.0


def estimate_throughput_from_cqi(cqi: float, band: int, load_pct: float) -> float:
    """
    Estimate throughput using Shannon-like formula with LTE constraints
    
    Throughput = BW * SE * (1 - load_overhead) * PRB_utilization
    """
    params = get_band_params(band)
    bw_hz = params["bw_mhz"] * 1e6
    se = cqi_to_spectral_efficiency(cqi)
    
    # Account for LTE overhead (~25% for control channels, CP, etc.)
    overhead_factor = 0.75
    
    # PRB efficiency based on load (high load = more contention)
    load_efficiency = 1.0 - (load_pct / 100) * 0.15 if load_pct > 50 else 1.0
    
    throughput_bps = bw_hz * se * overhead_factor * load_efficiency
    throughput_kbps = throughput_bps / 1000
    
    # Cap at band capacity
    max_kbps = params["capacity_mbps"] * 1000
    return clamp_throughput(min(throughput_kbps, max_kbps))


def compute_health(load: float, cqi: float) -> float:
    """
    Compute cell health score based on KPIs
    Health degrades with high load and poor CQI
    """
    load = clamp_load(load if load is not None else 0)
    cqi = clamp_cqi(cqi if cqi is not None else 10)
    
    # Load penalty (exponential for high load)
    if load >= 90:
        load_penalty = 50 + (load - 90) * 2
    elif load >= 70:
        load_penalty = 20 + (load - 70) * 1.5
    else:
        load_penalty = load * 0.2
    
    # CQI penalty (threshold-based)
    if cqi < 5:
        cqi_penalty = 40
    elif cqi < 7:
        cqi_penalty = 25
    elif cqi < 9:
        cqi_penalty = 10
    else:
        cqi_penalty = 0
    
    health = 100 - load_penalty - cqi_penalty
    return clamp(health, PHYSICAL_LIMITS["HEALTH_MIN"], PHYSICAL_LIMITS["HEALTH_MAX"])


def classify_issue(load: float, cqi: float) -> str:
    """Classify cell issue based on KPIs with proper thresholds"""
    load = clamp_load(load if load is not None else 0)
    cqi = clamp_cqi(cqi if cqi is not None else 10)
    
    # Combined issue detection
    if load >= 90 and cqi < 7:
        return "Critical Congestion"
    if load >= 85:
        return "Capacity Issue"
    if load >= 70:
        return "Congestion"
    if cqi < 5:
        return "Coverage Hole"
    if cqi < 7:
        return "Quality Degradation"
    return "Normal"


def load_file(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ============================================================================
# PHYSICS-BASED ACTION MODELS
# ============================================================================

def apply_tilt_scenario(state: Dict[str, float], params: Dict[str, Any], baseline_info: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, float], List[Dict[str, Any]], float]:
    """
    Apply antenna tilt change using RF propagation principles
    
    Physics model:
    - Downtilt reduces cell radius (focuses energy closer to site)
    - This can reduce interference to neighbors and improve local CQI
    - But may push edge users to neighboring cells (load redistribution)
    - Typical tilt range: 0-15 degrees (electrical)
    
    Returns: (new_state, affected_neighbors, confidence)
    """
    current_tilt = baseline_info.get("tilt", 4) if baseline_info else 4
    delta_degrees = float(params.get("degrees", 2))
    new_tilt = clamp_tilt(current_tilt + delta_degrees)
    actual_delta = new_tilt - current_tilt
    
    # Validate physical bounds
    if abs(actual_delta) < 0.5:
        # No meaningful change
        return state.copy(), [], 0.3
    
    load = state["load"]
    cqi = state["cqi"]
    throughput = state["throughput"]
    band = baseline_info.get("frequency_band", 3) if baseline_info else 3
    
    # RF model: downtilt effect on coverage and capacity
    # Downtilt reduces cell edge coverage, concentrating users closer
    # This improves SINR for remaining users but may push some to neighbors
    
    if actual_delta > 0:  # Downtilt
        # Load reduction: edge users handed off (approx 3-5% per degree)
        load_reduction_factor = 0.04 * actual_delta
        edge_users_pushed = load * load_reduction_factor
        new_load = clamp_load(load - edge_users_pushed)
        
        # CQI improvement: remaining users have better SINR
        # Approx 0.2-0.4 CQI improvement per degree of downtilt
        cqi_improvement = 0.3 * actual_delta * (1 - load / 200)  # Less improvement at high load
        new_cqi = clamp_cqi(cqi + cqi_improvement)
        
        # Affected neighbors receive the pushed users
        affected = [{"name": "neighbors", "load_change": round(edge_users_pushed * 0.7, 2)}]
        confidence = 0.65
        
    else:  # Uptilt
        # Uptilt increases coverage but dilutes capacity
        load_increase = abs(actual_delta) * 3
        new_load = clamp_load(load + load_increase)
        
        # CQI degradation due to increased interference
        cqi_degradation = abs(actual_delta) * 0.25
        new_cqi = clamp_cqi(cqi - cqi_degradation)
        
        affected = []
        confidence = 0.55
    
    # Recalculate throughput based on new CQI and load
    new_throughput = estimate_throughput_from_cqi(new_cqi, band, new_load)
    
    return {
        "load": new_load,
        "cqi": new_cqi,
        "throughput": new_throughput,
    }, affected, confidence


def apply_add_carrier(state: Dict[str, float], params: Dict[str, Any], baseline_info: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, float], float]:
    """
    Add carrier aggregation - physically realistic model
    
    Physics constraints:
    - Cannot add carrier if site already uses that band
    - Load split depends on CA capability (Category)
    - Inter-band CA has additional signaling overhead
    - Throughput gain is not linear (diminishing returns)
    
    Returns: (new_state, confidence)
    """
    load = state["load"]
    throughput = state["throughput"]
    cqi = state["cqi"]
    current_band = baseline_info.get("frequency_band", 3) if baseline_info else 3
    new_band = params.get("band")
    
    if not new_band:
        # No band specified - use default
        new_band = 7 if current_band != 7 else 3
    
    try:
        new_band = int(new_band)
    except:
        new_band = 7
    
    # Physical model for carrier aggregation
    current_params = get_band_params(current_band)
    new_params = get_band_params(new_band)
    
    # Combined capacity (not simply additive due to overhead)
    total_capacity = current_params["capacity_mbps"] + new_params["capacity_mbps"] * 0.85
    capacity_ratio = current_params["capacity_mbps"] / total_capacity
    
    # Load is distributed across carriers
    # Higher frequency carriers typically get more data traffic
    new_load = clamp_load(load * capacity_ratio * 1.1)  # Some scheduling overhead
    
    # CQI can improve slightly due to better scheduling flexibility
    cqi_improvement = 0.3 + (0.2 if new_params["bw_mhz"] >= 15 else 0)
    new_cqi = clamp_cqi(cqi + cqi_improvement)
    
    # Throughput gain (realistic: 40-80% gain, not 2x)
    throughput_multiplier = 1.4 + (new_params["capacity_mbps"] / current_params["capacity_mbps"]) * 0.3
    throughput_multiplier = min(throughput_multiplier, 1.8)  # Cap at 80% gain
    new_throughput = clamp_throughput(throughput * throughput_multiplier)
    
    confidence = 0.70  # CA is well-understood
    
    return {
        "load": new_load,
        "cqi": new_cqi,
        "throughput": new_throughput,
    }, confidence


def apply_redistribute(state: Dict[str, float], params: Dict[str, Any], baseline: Optional[Dict[str, Any]] = None, observations: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, float], List[Dict[str, Any]], float]:
    """
    Redistribute traffic using MLB (Mobility Load Balancing)
    
    Physics constraints:
    - Can only push to neighbors with spare capacity
    - Ratio limited by handover success rate (~60% max practical)
    - Target cell must have coverage overlap
    - CQI impact on redistributed users
    
    Returns: (new_state, affected_cells, confidence)
    """
    ratio = float(params.get("ratio", 0.2))
    ratio = clamp(ratio, 0.05, 0.5)  # Physical limit: 5-50% redistribution
    
    load = state["load"]
    throughput = state["throughput"]
    cqi = state["cqi"]
    
    target_cell = params.get("target")
    
    affected = []
    
    if target_cell and observations:
        target_obs = observations.get(target_cell, {})
        target_load = target_obs.get("load", 50)
        
        # Check if target has capacity
        if target_load >= 80:
            # Target is also congested - limited redistribution
            effective_ratio = ratio * 0.3
            confidence = 0.35
        elif target_load >= 60:
            effective_ratio = ratio * 0.7
            confidence = 0.50
        else:
            effective_ratio = ratio
            confidence = 0.60
        
        # Calculate actual load transfer
        load_to_move = load * effective_ratio
        
        # Handover success rate (typically 85-95%)
        ho_success = 0.90
        actual_moved = load_to_move * ho_success
        
        new_load = clamp_load(load - actual_moved)
        
        # Target receives the load
        affected.append({
            "name": target_cell,
            "load_change": round(actual_moved * 0.95, 2),  # Some loss in handover
            "cqi_change": round(-0.2, 2)  # Slight CQI impact on target
        })
    else:
        # Generic redistribution (less accurate)
        effective_ratio = ratio * 0.5
        new_load = clamp_load(load * (1 - effective_ratio))
        confidence = 0.45
    
    # Throughput adjusts with load
    load_reduction = (state["load"] - new_load) / state["load"] if state["load"] > 0 else 0
    new_throughput = clamp_throughput(throughput * (1 + load_reduction * 0.15))
    
    return {
        "load": new_load,
        "cqi": cqi,  # CQI unchanged for remaining users
        "throughput": new_throughput,
    }, affected, confidence


def apply_new_site(state: Dict[str, float]) -> Dict[str, float]:
    """DEPRECATED: Handled by separate site planning tool"""
    raise ValueError("Deploy new site is handled in the site planning tool, not inline actions")


# ============================================================================
# DATA LOADING WITH VALIDATION
# ============================================================================

def load_time_entry(base_dir: Path, time_file: Optional[str] = None) -> Tuple[str, Dict[str, Any]]:
    time_data_dir = base_dir / "public" / "time_data"
    if time_file:
        candidate = time_data_dir / time_file
        if candidate.exists():
            data = load_file(candidate)
            return data.get("timestamp", time_file), data.get("observations", {})
    index_path = base_dir / "public" / "time_index.json"
    if index_path.exists():
        idx = load_file(index_path)
        timestamps = idx.get("timestamps") or []
        if timestamps:
            first = timestamps[0]
            fname = first.get("filename")
            if fname:
                candidate = time_data_dir / fname
                if candidate.exists():
                    data = load_file(candidate)
                    return data.get("timestamp", fname), data.get("observations", {})
    raise FileNotFoundError("No valid time slice found")


def build_state(baseline: Dict[str, Any], observations: Dict[str, Any], cell_name: str) -> Dict[str, float]:
    """Build cell state with physical validation"""
    obs = observations.get(cell_name, {})
    
    # Extract and validate each metric against physical limits
    load = obs.get("load")
    throughput = obs.get("throughput")
    cqi = obs.get("cqi")
    traffic = obs.get("traffic")
    ta = obs.get("ta")
    signal_power = obs.get("signal_power")

    return {
        "load": clamp_load(float(load)) if load is not None else 0.0,
        "throughput": clamp_throughput(float(throughput)) if throughput is not None else 0.0,
        "cqi": clamp_cqi(float(cqi)) if cqi is not None else 10.0,
        "traffic": max(0, float(traffic)) if traffic is not None else 0.0,
        "ta": clamp(float(ta), PHYSICAL_LIMITS["TA_MIN"], PHYSICAL_LIMITS["TA_MAX"]) if ta is not None else 0.0,
        "signal_power": clamp(float(signal_power), 100, 200) if signal_power is not None else 170.0,
    }


def format_state(raw: Dict[str, float], band: int = 3) -> Dict[str, Union[float, str]]:
    """Format state with physical bounds enforced"""
    load = clamp_load(raw.get("load", 0.0))
    cqi = clamp_cqi(raw.get("cqi", 10.0))
    throughput = clamp_throughput(raw.get("throughput", 0.0))
    
    # Validate throughput against theoretical maximum for CQI
    max_theoretical = estimate_throughput_from_cqi(cqi, band, load)
    throughput = min(throughput, max_theoretical * 1.1)  # Allow 10% margin
    
    health = compute_health(load, cqi)
    
    return {
        "load": round(load, 2),
        "cqi": round(cqi, 2),
        "throughput": round(throughput, 2),
        "health_score": round(health, 2),
        "issue_type": classify_issue(load, cqi),
    }


# ============================================================================
# MAIN SIMULATION FLOW
# ============================================================================

def simulate_action(base_dir: Path, cell_name: str, action: str, params: Dict[str, Any], time_file: Optional[str] = None) -> Dict[str, Any]:
    """
    Run physics-based simulation for a remediation action
    
    Returns calibrated predictions with appropriate confidence levels
    """
    baseline_path = base_dir / "public" / "baseline.json"
    if not baseline_path.exists():
        raise FileNotFoundError("baseline.json not found")
    baseline = load_file(baseline_path)

    if cell_name not in baseline:
        raise ValueError(f"Cell {cell_name} not found in baseline")

    cell_info = baseline[cell_name]
    band = cell_info.get("frequency_band", 3)
    
    timestamp, observations = load_time_entry(base_dir, time_file)
    before_state = build_state(baseline, observations, cell_name)

    action = (action or "").lower()
    affected: List[Dict[str, Any]] = []
    confidence = 0.5

    # Validate action preconditions
    obs = observations.get(cell_name, {})
    is_congested = obs.get("congested", False)
    load = before_state["load"]
    cqi = before_state["cqi"]
    
    # Log warning for healthy cells but still run the simulation
    healthy_cell_warning = None
    if load < 50 and cqi > 10 and action in ["tilt", "add_carrier", "redistribute"]:
        healthy_cell_warning = "Cell is healthy - simulation still applied for testing purposes"

    if action == "tilt":
        after_raw, affected, confidence = apply_tilt_scenario(before_state, params, cell_info)
        
        delta = params.get("degrees", 0)
        if delta > 0:
            recommendation = f"Downtilt by {delta}° reduces cell footprint, improving edge interference"
        else:
            recommendation = f"Uptilt by {abs(delta)}° extends coverage but may increase interference"
            
    elif action == "add_carrier":
        after_raw, confidence = apply_add_carrier(before_state, params, cell_info)
        affected = []
        new_band = params.get("band", 7)
        recommendation = f"Add Band {new_band} carrier for capacity offload (CA enabled)"
        
    elif action == "redistribute":
        after_raw, affected, confidence = apply_redistribute(
            before_state, params, baseline, observations
        )
        target = params.get("target", "neighbors")
        recommendation = f"MLB handover bias to {target} to balance load"
        
    elif action == "new_site":
        raise ValueError("Deploy new site is handled in the site planning tool")
        
    else:
        after_raw = before_state.copy()
        recommendation = "No action applied"
        confidence = 0.3

    before_fmt = format_state(before_state, band)
    after_fmt = format_state(after_raw, band)

    impact = {
        "load_change": round(after_fmt["load"] - before_fmt["load"], 2),
        "throughput_change": round(after_fmt["throughput"] - before_fmt["throughput"], 2),
        "cqi_change": round(after_fmt["cqi"] - before_fmt["cqi"], 2),
        "affected_cells": affected,
    }

    result = {
        "cell": cell_name,
        "action": action,
        "timestamp": timestamp,
        "before": before_fmt,
        "after": after_fmt,
        "impact": impact,
        "recommendation": recommendation,
        "confidence": round(confidence, 2),
    }
    
    if healthy_cell_warning:
        result["warning"] = healthy_cell_warning
    
    # Debug payload to trace simulation inputs/outputs in UI if needed
    result["debug"] = {
        "params": params,
        "mode": "fast",
        "before_raw": before_state,
        "after_raw": after_raw,
        "baseline_band": band,
    }
    
    return result


# --- CLI Entry ---

def main() -> None:
    parser = argparse.ArgumentParser(description="NetVision Action Simulator")
    parser.add_argument("--cell", required=True, help="Cell name")
    parser.add_argument("--action", required=True, help="Action type: tilt|add_carrier|redistribute|new_site")
    parser.add_argument("--params", default="{}", help="JSON string of parameters")
    parser.add_argument("--time-file", default=None, help="Time-slice filename (from time_data)")
    parser.add_argument("--mode", default="fast", choices=["fast"], help="Simulation mode (fast only; ns-3 removed)")
    args = parser.parse_args()

    try:
        params = json.loads(args.params) if args.params else {}
    except Exception:
        params = {}

    base_dir = Path(__file__).resolve().parent.parent

    try:
        result = simulate_action(base_dir, args.cell, args.action, params, args.time_file)
        print(json.dumps(result))
    except Exception as exc:
        error_resp = {"error": str(exc)}
        print(json.dumps(error_resp))
        raise


if __name__ == "__main__":
    main()
