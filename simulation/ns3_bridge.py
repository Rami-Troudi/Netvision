"""
NS-3 Bridge for Orange Digital Twin
Converts baseline data to ns-3 config, runs simulation, parses results
"""

import subprocess
import json
import tempfile
import os
import sys
from pathlib import Path
from typing import Dict, Any, Optional, List
import argparse

# ============================================================================
# Configuration
# ============================================================================

# Default ns-3 installation path (WSL2 or Linux)
DEFAULT_NS3_PATH = "/usr/local/ns-allinone-3.40/ns-3.40"
WSL_NS3_PATH = "/home/user/ns-allinone-3.40/ns-3.40"

# Fallback: use WSL from Windows
USE_WSL = sys.platform == "win32"


class NS3Bridge:
    """Bridge between Python API and ns-3 C++ simulator"""

    def __init__(self, ns3_path: str = None, use_wsl: bool = None):
        self.ns3_path = ns3_path or (WSL_NS3_PATH if USE_WSL else DEFAULT_NS3_PATH)
        self.use_wsl = use_wsl if use_wsl is not None else USE_WSL
        self.scenario_name = "orange-lte-sim"
        
    def _run_command(self, cmd: List[str], cwd: str = None, timeout: int = 120) -> subprocess.CompletedProcess:
        """Run a command, optionally through WSL"""
        if self.use_wsl:
            # Convert Windows paths to WSL paths
            wsl_cmd = ["wsl", "-e"] + cmd
            return subprocess.run(wsl_cmd, capture_output=True, text=True, timeout=timeout)
        else:
            return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)

    def build_config(self, baseline: Dict, observations: Dict, 
                      target_cell: str, action: str, params: Dict) -> Dict:
        """
        Build ns-3 config JSON from baseline data and observations
        
        Args:
            baseline: Cell baseline info {cell_name: {lon, lat, azimuth, band, ...}}
            observations: Current KPIs {cell_name: {load, cqi, throughput, users, ...}}
            target_cell: The cell to apply action on
            action: Action type (tilt, power, add_carrier, redistribute, new_site)
            params: Action parameters
            
        Returns:
            ns-3 compatible config dict
        """
        # Group cells by site
        sites = {}
        for cell_name, info in baseline.items():
            # Parse site name from cell name (e.g., site_0002_f2 -> site_0002)
            parts = cell_name.rsplit('_', 1)
            site_name = parts[0] if len(parts) > 1 else cell_name
            
            if site_name not in sites:
                sites[site_name] = {
                    "enodeb_name": info.get("enodeb_name", site_name),
                    "lon": info.get("longitude", 0),
                    "lat": info.get("latitude", 0),
                    "cells": []
                }
            
            # Get observation data for this cell
            obs = observations.get(cell_name, {})
            
            cell_config = {
                "cell_name": cell_name,
                "band": info.get("frequency_band", 1800),
                "pci": info.get("localcell_id", len(sites[site_name]["cells"]) + 1),
                "tilt": info.get("tilt", 4),  # Default 4 degrees if not in data
                "azimuth": info.get("azimuth", 0),
                "initial_users": int(obs.get("users", obs.get("active_users", 50)))
            }
            
            sites[site_name]["cells"].append(cell_config)
        
        config = {
            "sites": list(sites.values()),
            "simulation_time_s": 10.0,
            "action": None
        }
        
        # Add action if specified
        if action and target_cell:
            action_config = {
                "type": action,
                "cell_name": target_cell,
                "time_s": 5.0,  # Apply action at midpoint
                "params": {}
            }
            
            if action == "tilt":
                current_tilt = baseline.get(target_cell, {}).get("tilt", 4)
                delta = params.get("degrees", 2)
                action_config["params"]["new_tilt"] = current_tilt + delta
                
            elif action == "power":
                current_power = baseline.get(target_cell, {}).get("referencesignalpwr", 46)
                delta = params.get("dbm", 3)
                action_config["params"]["new_power_dbm"] = current_power + delta
                
            elif action == "add_carrier":
                action_config["params"]["new_band"] = params.get("band", 2600)
                
            elif action == "redistribute":
                action_config["params"]["target_cell"] = params.get("target", "")
                action_config["params"]["ratio"] = params.get("ratio", 0.2)
                
            config["action"] = action_config
        
        return config

    def run_simulation(self, config: Dict, timeout: int = 120) -> Dict:
        """
        Run ns-3 simulation with given config
        
        Returns:
            Simulation results dict
        """
        # Create temp files for config and results
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config, f, indent=2)
            config_file = f.name
        
        results_file = config_file.replace('.json', '_results.json')
        
        try:
            # Build ns-3 command
            if self.use_wsl:
                # Convert Windows path to WSL path
                wsl_config = config_file.replace('\\', '/').replace('C:', '/mnt/c')
                wsl_results = results_file.replace('\\', '/').replace('C:', '/mnt/c')
                
                cmd = [
                    "bash", "-c",
                    f"cd {self.ns3_path} && ./ns3 run '{self.scenario_name} --config={wsl_config} --output={wsl_results}'"
                ]
            else:
                cmd = [
                    f"{self.ns3_path}/ns3",
                    "run",
                    f"{self.scenario_name} --config={config_file} --output={results_file}"
                ]
            
            # Run simulation
            result = self._run_command(cmd, timeout=timeout)
            
            if result.returncode != 0:
                raise RuntimeError(f"ns-3 simulation failed: {result.stderr}")
            
            # Read results
            if os.path.exists(results_file):
                with open(results_file) as f:
                    return json.load(f)
            else:
                raise FileNotFoundError(f"Results file not found: {results_file}")
                
        finally:
            # Cleanup temp files
            try:
                os.unlink(config_file)
                if os.path.exists(results_file):
                    os.unlink(results_file)
            except:
                pass

    def simulate_action(self, baseline: Dict, observations: Dict,
                        target_cell: str, action: str, params: Dict) -> Dict:
        """
        Full simulation pipeline: build config, run ns-3, format results
        
        Returns:
            API-compatible result dict with before/after comparison
        """
        # Run baseline (no action)
        baseline_config = self.build_config(baseline, observations, target_cell, None, {})
        baseline_results = self.run_simulation(baseline_config)
        
        # Run with action
        action_config = self.build_config(baseline, observations, target_cell, action, params)
        action_results = self.run_simulation(action_config)
        
        # Find target cell in results
        before_kpis = None
        after_kpis = None
        
        for cell in baseline_results.get("cells", []):
            if cell["cell_name"] == target_cell:
                before_kpis = cell
                break
        
        for cell in action_results.get("cells", []):
            if cell["cell_name"] == target_cell:
                after_kpis = cell
                break
        
        if not before_kpis or not after_kpis:
            return {"error": f"Cell {target_cell} not found in results"}
        
        # Format response
        return {
            "cell": target_cell,
            "action": action,
            "simulation_mode": "ns-3_precise",
            "simulation_time_s": baseline_config.get("simulation_time_s", 10),
            "before": {
                "load": before_kpis.get("prb_utilization_pct", 0),
                "cqi": before_kpis.get("avg_cqi", 0),
                "throughput": before_kpis.get("throughput_kbps", 0),
                "health_score": before_kpis.get("health_score", 0),
                "issue_type": before_kpis.get("issue_type", "Normal"),
                "sinr_db": before_kpis.get("avg_sinr_db", 0)
            },
            "after": {
                "load": after_kpis.get("prb_utilization_pct", 0),
                "cqi": after_kpis.get("avg_cqi", 0),
                "throughput": after_kpis.get("throughput_kbps", 0),
                "health_score": after_kpis.get("health_score", 0),
                "issue_type": after_kpis.get("issue_type", "Normal"),
                "sinr_db": after_kpis.get("avg_sinr_db", 0)
            },
            "impact": {
                "load_change": round(after_kpis.get("prb_utilization_pct", 0) - before_kpis.get("prb_utilization_pct", 0), 2),
                "throughput_change": round(after_kpis.get("throughput_kbps", 0) - before_kpis.get("throughput_kbps", 0), 2),
                "cqi_change": round(after_kpis.get("avg_cqi", 0) - before_kpis.get("avg_cqi", 0), 2),
                "health_change": round(after_kpis.get("health_score", 0) - before_kpis.get("health_score", 0), 2),
                "affected_cells": self._find_affected_cells(baseline_results, action_results, target_cell)
            },
            "recommendation": self._generate_recommendation(before_kpis, after_kpis, action),
            "confidence": 0.90  # ns-3 has higher confidence than fast estimator
        }

    def _find_affected_cells(self, before: Dict, after: Dict, target: str) -> List[Dict]:
        """Find cells whose KPIs changed due to the action (neighbors)"""
        affected = []
        
        before_cells = {c["cell_name"]: c for c in before.get("cells", [])}
        after_cells = {c["cell_name"]: c for c in after.get("cells", [])}
        
        for name, before_kpi in before_cells.items():
            if name == target:
                continue
            after_kpi = after_cells.get(name)
            if not after_kpi:
                continue
            
            load_change = after_kpi.get("prb_utilization_pct", 0) - before_kpi.get("prb_utilization_pct", 0)
            if abs(load_change) > 2:  # Significant change threshold
                affected.append({
                    "name": name,
                    "load_change": round(load_change, 2),
                    "cqi_change": round(after_kpi.get("avg_cqi", 0) - before_kpi.get("avg_cqi", 0), 2)
                })
        
        return affected

    def _generate_recommendation(self, before: Dict, after: Dict, action: str) -> str:
        """Generate human-readable recommendation based on results"""
        load_improved = after.get("prb_utilization_pct", 0) < before.get("prb_utilization_pct", 0)
        cqi_improved = after.get("avg_cqi", 0) > before.get("avg_cqi", 0)
        throughput_improved = after.get("throughput_kbps", 0) > before.get("throughput_kbps", 0)
        
        improvements = sum([load_improved, cqi_improved, throughput_improved])
        
        if improvements >= 2:
            return f"Recommended: {action} action shows positive impact on network performance"
        elif improvements == 1:
            return f"Marginal benefit: {action} action shows mixed results, review trade-offs"
        else:
            return f"Not recommended: {action} action may degrade performance"


# ============================================================================
# Fallback: Mock NS-3 for development/testing without ns-3 installed
# Uses same physics models as simulator.py for consistency
# ============================================================================

# Import physical constants from simulator for consistency
try:
    from simulator import (
        PHYSICAL_LIMITS, CQI_SPECTRAL_EFFICIENCY, BAND_PARAMETERS,
        clamp_cqi, clamp_load, clamp_throughput, cqi_to_spectral_efficiency,
        compute_health, classify_issue, get_band_params
    )
except ImportError:
    # Fallback definitions if import fails
    PHYSICAL_LIMITS = {"CQI_MIN": 1, "CQI_MAX": 15, "PRB_LOAD_MIN": 0, "PRB_LOAD_MAX": 100}
    
    def clamp_cqi(v): return max(1, min(15, v))
    def clamp_load(v): return max(0, min(100, v))
    def clamp_throughput(v): return max(0, v)
    def cqi_to_spectral_efficiency(cqi): return 0.1523 + (cqi - 1) * 0.38
    def compute_health(load, cqi):
        h = 100
        if load > 80: h -= 30
        if cqi < 7: h -= 25
        return max(0, h)
    def classify_issue(load, cqi):
        if load > 85 and cqi < 7: return "Critical Congestion"
        if load > 85: return "Capacity Issue"
        if cqi < 7: return "Coverage Issue"
        return "Normal"
    def get_band_params(b):
        return {"bw_mhz": 20, "max_prb": 100, "path_loss_exp": 3.5, "capacity_mbps": 150}


class MockNS3Bridge(NS3Bridge):
    """
    Mock bridge using physics models aligned with simulator.py
    
    Provides realistic results without requiring ns-3 installation.
    Uses 3GPP-based models for CQI, throughput, and action effects.
    """
    
    def run_simulation(self, config: Dict, timeout: int = 120) -> Dict:
        """Generate physics-based mock results"""
        import random
        
        random.seed(42)  # Reproducible results for testing
        
        results = {
            "simulation_time_s": config.get("simulation_time_s", 10),
            "cells": [],
            "aggregate": {
                "total_throughput_mbps": 0,
                "avg_delay_ms": 0,
                "total_flows": 0
            }
        }
        
        action = config.get("action")
        total_delay = 0
        cell_count = 0
        
        for site in config.get("sites", []):
            for cell in site.get("cells", []):
                users = cell.get("initial_users", 50)
                band = cell.get("band", 1800)
                tilt = cell.get("tilt", 4)
                
                # Map band number to internal format
                if band >= 1000:
                    # Convert frequency to band number
                    band_map = {800: 20, 1800: 3, 2100: 1, 2600: 7, 2300: 40, 2500: 41}
                    band = band_map.get(band, 3)
                
                band_params = get_band_params(band)
                
                # Physics-based base KPIs
                # PRB load depends on users and band capacity
                max_users_per_prb = band_params["max_prb"] * 0.8
                base_load = clamp_load((users / max_users_per_prb) * 100)
                
                # CQI based on load (interference model)
                # Higher load = more interference = lower CQI
                interference_factor = 1 + (base_load / 100) * 0.3
                base_cqi = clamp_cqi(14 / interference_factor + random.uniform(-0.5, 0.5))
                
                # Apply action effects using physics models
                load_delta = 0
                cqi_delta = 0
                
                if action and action.get("cell_name") == cell["cell_name"]:
                    action_type = action.get("type", "")
                    params = action.get("params", {})
                    
                    if action_type == "tilt":
                        # RF model: downtilt reduces coverage, improving local SINR
                        new_tilt = params.get("new_tilt", tilt)
                        tilt_change = new_tilt - tilt
                        
                        # 3-5% load reduction per degree downtilt (edge users handed off)
                        load_delta = -tilt_change * 4 * (base_load / 100)
                        # 0.2-0.4 CQI improvement per degree (less interference)
                        cqi_delta = tilt_change * 0.3
                        
                    elif action_type == "power":
                        # Power model: affects both coverage and interference
                        new_power = params.get("new_power_dbm", 46)
                        power_delta = new_power - 46
                        
                        # Power up improves coverage but increases interference
                        cqi_delta = power_delta * 0.15  # Diminishing returns
                        load_delta = -power_delta * 0.5  # Slight capacity improvement
                        
                    elif action_type == "add_carrier":
                        # Carrier aggregation model
                        new_band = params.get("new_band", 2600)
                        new_band_int = {800: 20, 1800: 3, 2100: 1, 2600: 7}.get(new_band, 7)
                        new_params = get_band_params(new_band_int)
                        
                        # Load reduction proportional to added capacity
                        capacity_ratio = band_params["capacity_mbps"] / (band_params["capacity_mbps"] + new_params["capacity_mbps"] * 0.85)
                        load_delta = -(base_load * (1 - capacity_ratio))
                        
                        # CQI improvement from better scheduling
                        cqi_delta = 0.4
                        
                    elif action_type == "redistribute":
                        # MLB model
                        ratio = params.get("ratio", 0.2)
                        ratio = max(0.05, min(0.5, ratio))
                        
                        # Handover success rate
                        ho_success = 0.90
                        load_delta = -base_load * ratio * ho_success
                
                # Apply deltas with physical bounds
                final_load = clamp_load(base_load + load_delta + random.uniform(-2, 2))
                final_cqi = clamp_cqi(base_cqi + cqi_delta + random.uniform(-0.3, 0.3))
                
                # Throughput from Shannon-like formula
                se = cqi_to_spectral_efficiency(final_cqi)
                bw_hz = band_params["bw_mhz"] * 1e6
                overhead = 0.75  # LTE control overhead
                load_eff = 1.0 - (final_load / 100) * 0.15 if final_load > 50 else 1.0
                throughput_bps = bw_hz * se * overhead * load_eff
                throughput_kbps = clamp_throughput(throughput_bps / 1000)
                
                # Cap at band capacity
                max_kbps = band_params["capacity_mbps"] * 1000
                throughput_kbps = min(throughput_kbps, max_kbps)
                
                # SINR estimate from CQI (reverse mapping)
                sinr_db = (final_cqi - 1) * 2 + random.uniform(-1, 1)
                sinr_db = max(-10, min(30, sinr_db))  # Physical limits
                
                # Delay model: higher load = more queueing delay
                base_delay_ms = 20  # Minimum RTT
                load_delay = (final_load / 100) ** 2 * 60  # Exponential queueing
                cell_delay = base_delay_ms + load_delay + random.uniform(-5, 5)
                
                health = compute_health(final_load, final_cqi)
                issue = classify_issue(final_load, final_cqi)
                
                results["cells"].append({
                    "cell_id": len(results["cells"]) + 1,
                    "cell_name": cell["cell_name"],
                    "user_count": users,
                    "avg_cqi": round(final_cqi, 2),
                    "avg_sinr_db": round(sinr_db, 2),
                    "throughput_kbps": round(throughput_kbps, 2),
                    "prb_utilization_pct": round(final_load, 2),
                    "handover_in": random.randint(0, 5),
                    "handover_out": random.randint(0, 5),
                    "health_score": round(health, 2),
                    "issue_type": issue,
                    "delay_ms": round(cell_delay, 2)
                })
                
                results["aggregate"]["total_throughput_mbps"] += throughput_kbps / 1000
                results["aggregate"]["total_flows"] += users
                total_delay += cell_delay
                cell_count += 1
        
        results["aggregate"]["total_throughput_mbps"] = round(results["aggregate"]["total_throughput_mbps"], 2)
        results["aggregate"]["avg_delay_ms"] = round(total_delay / max(1, cell_count), 2)
        
        return results


# ============================================================================
# CLI Interface
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="NS-3 Bridge for LTE Simulation")
    parser.add_argument("--baseline", required=True, help="Path to baseline.json")
    parser.add_argument("--observations", required=True, help="Path to observations JSON (time slice)")
    parser.add_argument("--cell", required=True, help="Target cell name")
    parser.add_argument("--action", required=True, choices=["tilt", "power", "add_carrier", "redistribute", "new_site"])
    parser.add_argument("--params", default="{}", help="Action parameters as JSON")
    parser.add_argument("--ns3-path", default=None, help="Path to ns-3 installation")
    parser.add_argument("--mock", action="store_true", help="Use mock simulator (no ns-3 required)")
    
    args = parser.parse_args()
    
    # Load data
    with open(args.baseline) as f:
        baseline = json.load(f)
    
    with open(args.observations) as f:
        observations = json.load(f)
    
    params = json.loads(args.params)
    
    # Create bridge
    if args.mock:
        bridge = MockNS3Bridge()
    else:
        bridge = NS3Bridge(ns3_path=args.ns3_path)
    
    # Run simulation
    try:
        result = bridge.simulate_action(baseline, observations, args.cell, args.action, params)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
