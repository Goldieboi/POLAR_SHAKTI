"""Shared live SystemState.

Every module (forecasting, autonomy, optimization, safety, API, frontend)
reads and writes this single state object — this is what guarantees
system-wide state consistency (prompt §56).

Phase 2 additions:
  - state_version: monotonic integer incremented on every material change
  - simulation_paused: prevents background ticks while judge experiments
  - scenario_id: string label for the active scenario
  - calculated_at: factory-generated timestamp (never a class-level default)
  - DEMO_BASELINE: one canonical baseline used everywhere (reset, sandbox, tests)
  - apply_atomic_update(): safe state mutation under lock with version bump
  - reset_to_baseline(): restores DEMO_BASELINE and bumps version
"""
from __future__ import annotations

import threading
import time
from typing import Any, Optional

from ..config import (
    BATTERY_CAPACITY_KWH, BATTERY_MAX_CHARGE_KW, BATTERY_MAX_DISCHARGE_KW,
    DIESEL_RATED_KW, USABLE_FUEL_L,
)


# ---------------------------------------------------------------- canonical ---
# One authoritative demo baseline used by: Overview, Scenarios, Sandbox, Reset,
# automated tests, and demo mode.  Never duplicate these values elsewhere.
DEMO_BASELINE: dict[str, Any] = {
    "fuel_l": 8420.0,
    "battery_soc": 62.0,
    "battery_soh": 94.0,
    "battery_power_kw": 0.0,
    "generator_running": False,
    "generator_output_kw": 0.0,
    "generator_failed": False,
    "critical_load_kw": 72.0,
    "essential_load_kw": 60.0,
    "flexible_load_kw": 50.0,
    "flexible_shed_pct": 0.0,
    "weather": {
        "temperature_c": -18.0,
        "wind_speed_ms": 9.0,
        "solar_irradiance_wm2": 150.0,
        "condition": "partly cloudy",
    },
    "scenario": {
        "storm": False, "bad_weather": False, "high_heating": False,
        "low_renewable": False, "resupply_risk": False, "combined": False,
    },
    "internet_online": True,
    "mqtt_connected": True,
    "resupply_date_days": 6.0,
    "resupply_delay_days": 0.0,
    "resupply_fuel_l": 6000.0,
    "mode": "NORMAL",
    "mode_auto": True,
    "scenario_id": "NORMAL",
}


class SystemState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.t0 = time.time()

        # ---- Phase 2 versioning ----
        self.state_version: int = 1
        self.simulation_paused: bool = True
        self.scenario_id: str = "NORMAL"
        self.calculated_at: float = time.time()   # set fresh at init time

        # ------------------------------------------------------------ plant --
        self.fuel_l: float = DEMO_BASELINE["fuel_l"]
        self.battery_soc: float = DEMO_BASELINE["battery_soc"]
        self.battery_soh: float = DEMO_BASELINE["battery_soh"]
        self.battery_power_kw: float = DEMO_BASELINE["battery_power_kw"]
        self.generator_running: bool = DEMO_BASELINE["generator_running"]
        self.generator_output_kw: float = DEMO_BASELINE["generator_output_kw"]
        self.generator_failed: bool = DEMO_BASELINE["generator_failed"]
        # ----------------------------------------------------------- loads ---
        self.critical_load_kw: float = DEMO_BASELINE["critical_load_kw"]
        self.essential_load_kw: float = DEMO_BASELINE["essential_load_kw"]
        self.flexible_load_kw: float = DEMO_BASELINE["flexible_load_kw"]
        self.flexible_shed_pct: float = DEMO_BASELINE["flexible_shed_pct"]
        # --------------------------------------------------------- weather ---
        self.weather: dict = dict(DEMO_BASELINE["weather"])
        # ------------------------------------------------------- scenarios ---
        self.scenario: dict = dict(DEMO_BASELINE["scenario"])
        # ----------------------------------------------------- connectivity --
        self.internet_online: bool = DEMO_BASELINE["internet_online"]
        self.mqtt_connected: bool = DEMO_BASELINE["mqtt_connected"]
        self.cloud_sync_queue: int = 0
        self.last_sync_ts: Optional[float] = None
        # ------------------------------------------------------------ modes --
        self.mode: str = DEMO_BASELINE["mode"]
        self.mode_auto: bool = DEMO_BASELINE["mode_auto"]
        # ------------------------------------------------------------ resupply
        self.resupply_date_days: float = DEMO_BASELINE["resupply_date_days"]
        self.resupply_delay_days: float = DEMO_BASELINE["resupply_delay_days"]
        self.resupply_fuel_l: float = DEMO_BASELINE["resupply_fuel_l"]
        self.resupply_model: dict = {}
        # ----------------------------------------------------------- engines -
        self.engine_status: dict[str, str] = {
            "data": "OPERATIONAL", "ml": "OPERATIONAL",
            "optimizer": "OPERATIONAL", "safety": "OPERATIONAL",
            "database": "CONNECTED", "storage": "AVAILABLE",
        }
        self.ml_fallback: bool = False
        self.optimizer_fallback: bool = False
        # --------------------------------------------------------- forecast --
        self.latest_forecast: dict = {}
        # -------------------------------------------------------- autonomy ---
        self.autonomy: dict = {}
        # ------------------------------------------------------ optimization -
        self.approved_plan: dict = {}
        self.previous_plan: dict = {}
        self.active_plan_name: str = "POLAR-EMS Baseline Strategy"
        self.what_changed: list[dict] = []
        self.before_after_replan: dict = {}
        self.safety_result: dict = {}
        self.recommendation: dict = {}
        self.awaiting_approval: bool = False
        # ----------------------------------------------------------- demo ----
        self.demo_state: dict = {
            "active": False, "step": 1, "total_steps": 7,
            "name": "Normal Operation", "paused": False,
        }
        # -------------------------------------------------------- data quality
        self.data_quality: dict = {"score": 100.0, "issues": []}
        # --------------------------------------------------------- operator --
        self.operator_overrides: dict = {}

    # ---------------------------------------------------------- versioning --
    def apply_atomic_update(self, updates: dict[str, Any]) -> int:
        """Apply a dict of {attr: value} under the lock, bump version, refresh timestamp.

        Returns the new state_version.
        """
        with self.lock:
            for key, value in updates.items():
                if hasattr(self, key):
                    setattr(self, key, value)
            self.state_version += 1
            self.calculated_at = time.time()      # factory-fresh timestamp
            return self.state_version

    def reset_to_baseline(self) -> int:
        """Restore every physical/scenario field to DEMO_BASELINE.

        Does NOT erase historical audit records — only station state.
        Returns the new state_version.
        """
        with self.lock:
            for key, value in DEMO_BASELINE.items():
                if isinstance(value, dict):
                    setattr(self, key, dict(value))  # shallow copy dicts
                else:
                    setattr(self, key, value)
            # Reset derived engine state
            self.approved_plan = {}
            self.previous_plan = {}
            self.active_plan_name = "POLAR-EMS Baseline Strategy"
            self.what_changed = []
            self.before_after_replan = {}
            self.safety_result = {}
            self.recommendation = {}
            self.awaiting_approval = False
            self.resupply_model = {}
            self.autonomy = {}
            self.latest_forecast = {}
            self.ml_fallback = False
            self.optimizer_fallback = False
            self.data_quality = {"score": 100.0, "issues": []}
            self.operator_overrides = {}
            self.demo_state = {
                "active": False, "step": 1, "total_steps": 7,
                "name": "Normal Operation", "paused": False,
            }
            self.state_version += 1
            self.calculated_at = time.time()
            return self.state_version

    # ------------------------------------------------------------- helpers --
    def now_h(self) -> float:
        return (time.time() - self.t0) / 3600.0

    def total_load_kw(self) -> float:
        flex = self.flexible_load_kw * (1.0 - self.flexible_shed_pct)
        return round(self.critical_load_kw + self.essential_load_kw + flex, 1)

    def battery_energy_kwh(self) -> float:
        return BATTERY_CAPACITY_KWH * (self.battery_soc / 100.0) * (self.battery_soh / 100.0)

    def usable_battery_kwh(self, reserve_soc_pct: float) -> float:
        """Usable battery energy down to a specified reserve floor."""
        soc_above_reserve = max(0.0, self.battery_soc - reserve_soc_pct)
        return BATTERY_CAPACITY_KWH * (soc_above_reserve / 100.0) * (self.battery_soh / 100.0)

    def fuel_pct(self) -> float:
        return round(self.fuel_l / USABLE_FUEL_L * 100.0, 1)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "station": {"id": "maitri-sim", "name": "MAITRI SIMULATION",
                            "simulation": True},
                "sim_time_h": round(self.now_h(), 3),
                "fuel_l": round(self.fuel_l, 1),
                "fuel_pct": self.fuel_pct(),
                "battery_soc": round(self.battery_soc, 1),
                "battery_soh": round(self.battery_soh, 1),
                "battery_power_kw": round(self.battery_power_kw, 1),
                "generator_running": self.generator_running,
                "generator_output_kw": round(self.generator_output_kw, 1),
                "generator_failed": self.generator_failed,
                "loads": {
                    "critical_kw": self.critical_load_kw,
                    "essential_kw": self.essential_load_kw,
                    "flexible_kw": round(self.flexible_load_kw * (1 - self.flexible_shed_pct), 1),
                    "flexible_shed_pct": self.flexible_shed_pct,
                    "total_kw": self.total_load_kw(),
                },
                "weather": dict(self.weather),
                "scenario": dict(self.scenario),
                "connectivity": {
                    "internet": "ONLINE" if self.internet_online else "OFFLINE",
                    "mqtt": "CONNECTED" if self.mqtt_connected else "DISCONNECTED",
                    "cloud": "AVAILABLE" if self.internet_online else "UNAVAILABLE",
                    "sync_queue": self.cloud_sync_queue,
                },
                "mode": self.mode,
                "mode_auto": self.mode_auto,
                "active_plan_name": self.active_plan_name,
                "resupply": {
                    "in_days": round(self.resupply_date_days, 2),
                    "delay_days": round(self.resupply_delay_days, 1),
                    "expected_fuel_l": self.resupply_fuel_l,
                    "model": dict(self.resupply_model) if self.resupply_model else {},
                },
                "engines": dict(self.engine_status),
                "ml_fallback": self.ml_fallback,
                "optimizer_fallback": self.optimizer_fallback,
                "data_quality": self.data_quality,
                "what_changed": list(self.what_changed),
                "before_after_replan": dict(self.before_after_replan),
                "demo_state": dict(self.demo_state),
                # ---- Phase 2 versioning fields ----
                "state_version": self.state_version,
                "simulation_paused": self.simulation_paused,
                "scenario_id": self.scenario_id,
                "calculated_at": self.calculated_at,
            }


STATE = SystemState()
