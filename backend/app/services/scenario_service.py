"""Scenario Service — run_polar_ems_scenario_v2 end-to-end integration.

Orchestrates station state generation, scenario injection, safe operability simulation,
CQRM margin calculation, dynamic reserve policy, LP optimization, deterministic safety validation,
and final operational decision.
"""
from __future__ import annotations

from dataclasses import dataclass
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
import numpy as np
import pandas as pd

from .operability_service import OperabilityService
from .cqrm_service import CQRMService
from .optimizer_service import OptimizerService
from .safety_service import SafetyService
from .decision_service import DecisionService

logger = logging.getLogger("polar_ems.scenario")

def _find_data_dir() -> Path:
    env_dir = os.environ.get("POLAR_EMS_DATA_DIR")
    if env_dir and Path(env_dir).exists():
        return Path(env_dir)
    curr = Path(__file__).resolve()
    for p in curr.parents:
        cand = p / "data"
        if cand.exists() and (cand / "Plant_1_Generation_Data.csv").exists():
            return cand
    for p in curr.parents:
        cand = p / "data"
        if cand.exists():
            return cand
    return curr.parent.parent.parent / "data"

DATA_DIR = _find_data_dir()
BASE_DIR = DATA_DIR.parent


@dataclass
class StationState:
    timestamp: str
    load_kw: float
    critical_load_kw: float
    flexible_load_kw: float
    solar_kw: float
    wind_kw: float
    renewable_kw: float
    net_load_kw: float
    battery_soc_pct: float
    battery_soh_pct: float
    battery_usable_capacity_kwh: float
    battery_energy_kwh: float
    generator_available_kw: float
    generator_min_kw: float
    fuel_remaining_l: float
    temperature_c: float
    wind_speed_ms: float
    storm_flag: bool
    low_renewable_flag: bool
    communication_status: str
    scada_anomaly_score: Optional[float]
    scada_anomaly_flag: bool
    resupply_p10_days: float
    resupply_p50_days: float
    resupply_p90_days: float
    safe_operability_days: Optional[float] = None
    resupply_margin_days: Optional[float] = None
    cqrm: Optional[float] = None
    risk_level: Optional[str] = None


class ScenarioService:
    _optimizer_data_cache: Optional[pd.DataFrame] = None
    _resupply_data_cache: Optional[pd.DataFrame] = None

    @classmethod
    def get_optimizer_dataset(cls) -> pd.DataFrame:
        if cls._optimizer_data_cache is not None:
            return cls._optimizer_data_cache

        possible_paths = [
            DATA_DIR / "polar_ems_optimizer_synthetic_data (1).csv",
            DATA_DIR / "polar_ems_optimizer_synthetic_data.csv",
            DATA_DIR / "Plant_1_Generation_Data.csv",
            BASE_DIR / "data" / "polar_ems_optimizer_synthetic_data (1).csv",
            BASE_DIR / "data" / "polar_ems_optimizer_synthetic_data.csv",
        ]

        data_path = None
        for p in possible_paths:
            if p.exists():
                data_path = p
                break

        if data_path is None:
            # Fallback to finding any optimizer data in data directory
            matches = list(DATA_DIR.glob("*optimizer*.csv"))
            if matches:
                data_path = matches[0]
            else:
                raise FileNotFoundError(f"Optimizer synthetic dataset not found in {DATA_DIR}")

        logger.info(f"Loading optimizer dataset from {data_path}")
        df = pd.read_csv(data_path)
        cls._optimizer_data_cache = df
        return df

    @classmethod
    def build_scenario_profile(
        cls,
        base_df: pd.DataFrame,
        scenario: str,
        delay_days: float = 0.0
    ) -> pd.DataFrame:
        df = base_df.copy()
        scenario = scenario.upper().strip()

        if scenario == "STORM":
            wind_factor = 0.45
            solar_factor = 0.65
            df["wind_forecast_kw"] *= wind_factor
            df["solar_forecast_kw"] *= solar_factor
            df["renewable_forecast_kw"] = df["solar_forecast_kw"] + df["wind_forecast_kw"]
            df["net_load_kw"] = np.maximum(0.0, df["load_forecast_kw"] - df["renewable_forecast_kw"])
            df["storm_flag"] = 1
            df["low_renewable_flag"] = 1

        elif scenario == "LOW_RENEWABLE":
            wind_factor = 0.60
            solar_factor = 0.50
            df["wind_forecast_kw"] *= wind_factor
            df["solar_forecast_kw"] *= solar_factor
            df["renewable_forecast_kw"] = df["solar_forecast_kw"] + df["wind_forecast_kw"]
            df["net_load_kw"] = np.maximum(0.0, df["load_forecast_kw"] - df["renewable_forecast_kw"])
            df["low_renewable_flag"] = 1

        elif scenario == "BATTERY_DEGRADATION":
            pass

        elif scenario == "SCADA_ANOMALY":
            if "generator_available_kw" in df.columns:
                df["generator_available_kw"] *= 0.75

        elif scenario == "COMMUNICATION_LOSS":
            pass

        elif scenario == "RESUPPLY_DELAY_4D":
            pass

        elif scenario == "NORMAL":
            pass

        else:
            raise ValueError(f"Unknown scenario: {scenario}")

        return df

    @classmethod
    def run_scenario(
        cls,
        scenario: str = "NORMAL",
        delay_days: float = 0.0,
        battery_soh_override: Optional[float] = None,
        anomaly_override: Optional[float] = None,
        communication_override: Optional[str] = None
    ) -> Dict[str, Any]:
        scenario = scenario.upper().strip()
        optimizer_data = cls.get_optimizer_dataset()
        row = optimizer_data.iloc[0]

        # 1. Base station state
        load_kw = float(row["load_forecast_kw"])
        solar_kw = float(row["solar_forecast_kw"])
        wind_kw = float(row["wind_forecast_kw"])
        critical_load_kw = float(row["critical_load_kw"])
        flexible_load_kw = float(row["flexible_load_kw"])
        renewable_kw = max(0.0, solar_kw + wind_kw)
        net_load_kw = max(0.0, load_kw - renewable_kw)

        state = StationState(
            timestamp=str(row["timestamp"]),
            load_kw=load_kw,
            critical_load_kw=critical_load_kw,
            flexible_load_kw=flexible_load_kw,
            solar_kw=solar_kw,
            wind_kw=wind_kw,
            renewable_kw=renewable_kw,
            net_load_kw=net_load_kw,
            battery_soc_pct=float(row["battery_soc_pct"]),
            battery_soh_pct=float(row["battery_soh_pct"]),
            battery_usable_capacity_kwh=float(row["battery_usable_capacity_kwh"]),
            battery_energy_kwh=float(row["battery_energy_kwh"]),
            generator_available_kw=float(row["generator_available_kw"]),
            generator_min_kw=float(row["generator_min_kw"]),
            fuel_remaining_l=float(row["diesel_fuel_l"]),
            temperature_c=float(row["temperature_c"]),
            wind_speed_ms=float(row["wind_speed_ms"]),
            storm_flag=bool(row["storm_flag"]),
            low_renewable_flag=bool(row["low_renewable_flag"]),
            communication_status=str(row["communication_status"]),
            scada_anomaly_score=None,
            scada_anomaly_flag=False,
            resupply_p10_days=float(row["resupply_eta_p10_days"]),
            resupply_p50_days=float(row["resupply_eta_p50_days"]),
            resupply_p90_days=float(row["resupply_eta_p90_days"]),
        )

        # 2. Scenario-specific station overrides
        if scenario == "STORM":
            state.storm_flag = True
            state.low_renewable_flag = True

        elif scenario == "LOW_RENEWABLE":
            state.low_renewable_flag = True

        elif scenario == "RESUPPLY_DELAY_4D":
            delay_days = 4.0

        elif scenario == "BATTERY_DEGRADATION":
            if battery_soh_override is None:
                battery_soh_override = 75.0
            state.battery_soh_pct = float(battery_soh_override)
            state.battery_usable_capacity_kwh *= (state.battery_soh_pct / 100.0)
            state.battery_energy_kwh = min(state.battery_energy_kwh, state.battery_usable_capacity_kwh)

        elif scenario == "SCADA_ANOMALY":
            if anomaly_override is None:
                anomaly_override = 0.90
            state.scada_anomaly_score = float(anomaly_override)
            state.scada_anomaly_flag = True

        elif scenario == "COMMUNICATION_LOSS":
            state.communication_status = "LOCAL"

        if communication_override is not None:
            state.communication_status = str(communication_override)
        if anomaly_override is not None:
            state.scada_anomaly_score = float(anomaly_override)
            state.scada_anomaly_flag = True

        # 3. Build scenario profile
        scenario_profile = cls.build_scenario_profile(optimizer_data, scenario=scenario, delay_days=delay_days)

        # 4. Resupply quantiles
        p10 = state.resupply_p10_days + delay_days
        p50 = state.resupply_p50_days + delay_days
        p90 = state.resupply_p90_days + delay_days

        # 5. Safe Operability forward simulation
        safe_result = OperabilityService.calculate_safe_operability(
            state=state,
            optimizer_df=scenario_profile,
            start_timestamp=state.timestamp,
            horizon_hours=30 * 24
        )

        # 6. CQRM metrics
        cqrm_result = CQRMService.calculate_cqrm(
            safe_operability_days=safe_result["safe_operability_days"],
            resupply_p10_days=p10,
            resupply_p50_days=p50,
            resupply_p90_days=p90
        )

        # 7. CQRM Reserve Policy
        reserve_policy = CQRMService.calculate_reserve_policy(
            cqrm_result=cqrm_result,
            battery_capacity_kwh=state.battery_usable_capacity_kwh
        )

        # 8. LP Optimizer (optimize_station_v3)
        optimizer_result = OptimizerService.optimize_station_v3(
            optimizer_df=scenario_profile,
            state=state,
            min_reserve_soc_pct=reserve_policy["required_reserve_soc_pct"],
            horizon_hours=168
        )

        # 9. Deterministic Safety Validation
        if optimizer_result["status"] == "OPTIMAL":
            safety_result = SafetyService.validate_plan(
                state=state,
                optimizer_result=optimizer_result,
                cqrm_result=cqrm_result,
                plan=optimizer_result["plan"]
            )
        else:
            safety_result = {
                "status": "UNSAFE",
                "violations": [{
                    "code": "OPTIMIZER_INFEASIBLE",
                    "value": optimizer_result.get("message", "infeasible"),
                    "limit": "feasible operating plan"
                }],
                "violation_count": 1,
                "minimum_soc_pct": np.nan,
                "battery_soh_pct": state.battery_soh_pct,
                "battery_temperature_c": state.temperature_c,
                "critical_load_coverage_pct": 0.0,
                "max_power_balance_error_kw": np.nan,
                "generator_available_kw": state.generator_available_kw,
                "final_fuel_l": state.fuel_remaining_l,
                "max_battery_discharge_kw": np.nan,
                "resupply_margin_days": cqrm_result["cqrm"]
            }

        # 10. Operational Decision Engine
        if optimizer_result["status"] == "OPTIMAL":
            decision = DecisionService.run_final_decision(
                state=state,
                cqrm_result=cqrm_result,
                optimizer_result=optimizer_result,
                safety_result=safety_result
            )
        else:
            decision = {
                "final_decision": "REJECT_PLAN",
                "operating_mode": "CONSERVATION",
                "risk_level": cqrm_result["risk_level"],
                "cqrm_days": cqrm_result["cqrm"],
                "resupply_margin_days": cqrm_result["cqrm"],
                "recommended_action": "Optimizer found no feasible plan under severe conditions. Reject plan and request operator intervention.",
                "reason": "The proposed operating conditions yield an infeasible optimization plan.",
                "requires_operator_intervention": True,
                "violations": ["OPTIMIZER_INFEASIBLE"]
            }

        # Format hourly plan if available
        hourly_records = []
        if optimizer_result.get("status") == "OPTIMAL" and "plan" in optimizer_result:
            hourly_records = optimizer_result["plan"].to_dict(orient="records")

        return {
            "scenario": scenario,
            "safe_operability_days": round(float(safe_result["safe_operability_days"]), 2),
            "cqrm_days": round(float(cqrm_result["cqrm"]), 2),
            "risk_level": cqrm_result["risk_level"],
            "required_reserve_soc_pct": round(float(reserve_policy["required_reserve_soc_pct"]), 2),
            "optimizer_status": optimizer_result["status"],
            "safety_status": safety_result["status"],
            "final_decision": decision["final_decision"],
            "operating_mode": decision["operating_mode"],
            "operator_intervention_required": bool(decision["requires_operator_intervention"]),
            "resupply_p10_days": round(float(p10), 2),
            "resupply_p50_days": round(float(p50), 2),
            "resupply_p90_days": round(float(p90), 2),
            "resupply_margin_days": round(float(cqrm_result["cqrm"]), 2),
            "recommended_action": decision["recommended_action"],
            "reason": decision["reason"],
            "violations": decision["violations"],
            "initial_battery_soc_pct": round(float(state.battery_soc_pct), 2),
            "final_battery_soc_pct": round(float(optimizer_result.get("final_battery_soc_pct", safe_result.get("final_battery_soc_pct", 0.0))), 2) if np.isfinite(optimizer_result.get("final_battery_soc_pct", np.nan)) else None,
            "initial_fuel_l": round(float(state.fuel_remaining_l), 2),
            "final_fuel_l": round(float(safety_result.get("final_fuel_l", state.fuel_remaining_l)), 2) if np.isfinite(safety_result.get("final_fuel_l", np.nan)) else None,
            "fuel_used_l": round(float(optimizer_result.get("fuel_used_l", 0.0)), 2) if optimizer_result.get("status") == "OPTIMAL" else 0.0,
            "generator_energy_kwh": round(float(optimizer_result.get("generator_energy_kwh", 0.0)), 2) if optimizer_result.get("status") == "OPTIMAL" else 0.0,
            "renewable_used_kwh": round(float(optimizer_result.get("renewable_used_kwh", 0.0)), 2) if optimizer_result.get("status") == "OPTIMAL" else 0.0,
            "renewable_curtailed_kwh": round(float(optimizer_result.get("renewable_curtailed_kwh", 0.0)), 2) if optimizer_result.get("status") == "OPTIMAL" else 0.0,
            "battery_discharge_kwh": round(float(optimizer_result.get("battery_discharge_kwh", 0.0)), 2) if optimizer_result.get("status") == "OPTIMAL" else 0.0,
            "battery_charge_kwh": round(float(optimizer_result.get("battery_charge_kwh", 0.0)), 2) if optimizer_result.get("status") == "OPTIMAL" else 0.0,
            "first_violation": safe_result.get("first_violation"),
            "hourly_plan": hourly_records
        }
