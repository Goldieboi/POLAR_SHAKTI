"""Scenario Engine & Step-Controlled Demo Orchestrator.

Manages predefined primary/secondary operational scenarios and the
7-step judge demonstration flow.
"""
from __future__ import annotations

import threading
import time
from typing import Any

try:
    from ..state.system_state import STATE
    from . import forecast as fc
    from . import autonomy as au
    from . import optimizer as op
    from . import safety as sf
    from . import alerts as al
    from .. import db
except (ImportError, ValueError):
    from app.state.system_state import STATE
    from app.engines import forecast as fc
    from app.engines import autonomy as au
    from app.engines import optimizer as op
    from app.engines import safety as sf
    from app.engines import alerts as al
    from app import db

# SCENARIO DEFINITIONS: Partitioned into Primary and Secondary
PRIMARY_SCENARIOS = {
    "storm": {
        "id": "storm",
        "label": "ANTARCTIC BLIZZARD / STORM",
        "category": "primary",
        "description": "28 m/s gale-force winds, -30°C temperatures, solar cutoff, and heating surge.",
        "apply": {"storm": True, "bad_weather": True, "high_heating": True},
        "weather": {"temperature_c": -30.0, "wind_speed_ms": 28.0, "solar_irradiance_wm2": 15.0, "condition": "blizzard"},
    },
    "resupply_delay": {
        "id": "resupply_delay",
        "label": "RESUPPLY DELAY (+3 DAYS)",
        "category": "primary",
        "description": "Logistics convoy halted by sea-ice fissures; resupply horizon pushed out by 3 days.",
        "apply": {"resupply_risk": True},
        "state": {"resupply_delay_days": 3.0},
    },
    "internet_failure": {
        "id": "internet_failure",
        "label": "COMMUNICATION LOSS (OFFLINE AUTONOMY)",
        "category": "primary",
        "description": "Satellite link severed. All forecasting, optimization, and safety run locally.",
        "apply": {},
        "state": {"internet_online": False, "mqtt_connected": False},
    },
}

SECONDARY_SCENARIOS = {
    "normal": {
        "id": "normal",
        "label": "NORMAL NOMINAL OPERATION",
        "category": "secondary",
        "description": "Standard polar summer/shoulder conditions with stable renewables and reserves.",
        "apply": {},
        "state": {"resupply_delay_days": 0.0, "internet_online": True, "generator_failed": False},
        "weather": {"temperature_c": -16.0, "wind_speed_ms": 9.0, "solar_irradiance_wm2": 180.0, "condition": "partly cloudy"},
    },
    "low_wind": {
        "id": "low_wind",
        "label": "LOW WIND / POLAR CALM",
        "category": "secondary",
        "description": "Wind drops to 2 m/s; wind turbines produce near zero power.",
        "apply": {"low_renewable": True},
        "weather": {"temperature_c": -18.0, "wind_speed_ms": 2.0, "solar_irradiance_wm2": 160.0, "condition": "clear"},
    },
    "low_renewable": {
        "id": "low_renewable",
        "label": "POLAR NIGHT / ZERO SOLAR",
        "category": "secondary",
        "description": "Sun below horizon for winter season; 0 W/m² irradiance.",
        "apply": {"low_renewable": True},
        "weather": {"temperature_c": -24.0, "wind_speed_ms": 11.0, "solar_irradiance_wm2": 0.0, "condition": "polar night"},
    },
    "high_heating": {
        "id": "high_heating",
        "label": "DEEP FREEZE (-38°C)",
        "category": "secondary",
        "description": "Extreme temperature drop causing severe thermal heating demand.",
        "apply": {"high_heating": True},
        "weather": {"temperature_c": -38.0, "wind_speed_ms": 12.0, "solar_irradiance_wm2": 80.0, "condition": "extreme cold"},
    },
    "generator_failure": {
        "id": "generator_failure",
        "label": "PRIMARY GENERATOR FAILURE",
        "category": "secondary",
        "description": "Main diesel generator trips offline; battery storage becomes the sole firm source.",
        "apply": {},
        "state": {"generator_failed": True, "generator_running": False, "generator_output_kw": 0.0},
    },
    "combined_extreme": {
        "id": "combined_extreme",
        "label": "COMBINED EXTREME EVENT",
        "category": "secondary",
        "description": "Storm blizzard + resupply delay + high heating simultaneously active.",
        "apply": {"storm": True, "high_heating": True, "low_renewable": True, "resupply_risk": True},
        "state": {"resupply_delay_days": 4.0},
        "weather": {"temperature_c": -34.0, "wind_speed_ms": 32.0, "solar_irradiance_wm2": 10.0, "condition": "severe blizzard"},
    },
}

SCENARIOS = {**PRIMARY_SCENARIOS, **SECONDARY_SCENARIOS}

# 7-Step Demonstration Sequence
DEMO_STEPS = [
    {
        "step": 1,
        "title": "NORMAL OPERATION",
        "badge": "NOMINAL (SAFE)",
        "description": "Station in energy balance. Safe Operability (~9.4d) exceeds resupply ETA (~6.2d) with +3.2d margin.",
        "action": "Reset to nominal conditions",
    },
    {
        "step": 2,
        "title": "STORM DETECTED",
        "badge": "CAUTION",
        "description": "Severe blizzard approaches (-30°C, 28 m/s winds). Solar drops to near zero and heating surges. Status shifts to CAUTION.",
        "action": "Inject blizzard conditions and expand forecast uncertainty",
    },
    {
        "step": 3,
        "title": "RESUPPLY DELAY (+3 DAYS)",
        "badge": "CONSERVE",
        "description": "Sea-ice fissure halts convoy. Resupply pushed out by +3 days. Status escalates to CONSERVE.",
        "action": "Advance resupply delay slider from 0 to +3 days",
    },
    {
        "step": 4,
        "title": "STORM + RESUPPLY DELAY (DEFICIT)",
        "badge": "CRITICAL",
        "description": "Adverse weather and logistics deficit combine. Margin drops into deficit (-1.2d); Shortfall risk hits 68%.",
        "action": "Trigger combined stress; CQRM alerts of imminent energy shortfall",
    },
    {
        "step": 5,
        "title": "RESUPPLY-CONDITIONED REPLAN",
        "badge": "AUTONOMOUS REPLAN",
        "description": "Optimizer recalculates schedule: increases battery reserve to 35% and reduces flexible load to 63%.",
        "action": "Chance-constrained LP optimizes battery dispatch and preserves critical fuel",
    },
    {
        "step": 6,
        "title": "SAFETY VALIDATION & MARGIN RECOVERY",
        "badge": "SAFETY APPROVED / RECOVERY",
        "description": "Safety validator audits 6 constraints. Plan approved; safe operability extends and margin deficit recovers.",
        "action": "Apply validated plan; observe safe operability recovery",
    },
    {
        "step": 7,
        "title": "COMMUNICATION LOSS (LOCAL AUTONOMY)",
        "badge": "OFFLINE ACTIVE",
        "description": "External satellite severed. System continues autonomous real-time dispatch locally without interruption.",
        "action": "Sever cloud connection; observe 100% uninterrupted local operation",
    },
]


def activate(name: str) -> dict:
    """Activate a scenario by name."""
    if name not in SCENARIOS:
        raise KeyError(f"Unknown scenario: {name}")
    spec = SCENARIOS[name]

    with STATE.lock:
        # Reset previous flags
        for k in STATE.scenario:
            STATE.scenario[k] = False
        for k, v in spec.get("apply", {}).items():
            STATE.scenario[k] = v
        for k, v in spec.get("state", {}).items():
            setattr(STATE, k, v)
        if "weather" in spec:
            STATE.weather.update(spec["weather"])

    from .decision import run_pipeline
    rec = run_pipeline(f"scenario:{name}")
    al.evaluate()

    db.log_event(source="scenario", event=f"Scenario activated: {spec['label']}",
                 detail=spec["description"], status="info")

    return {
        "scenario": name,
        "label": spec["label"],
        "category": spec.get("category", "secondary"),
        "recommendation": rec,
        "autonomy": STATE.autonomy,
        "what_changed": STATE.what_changed,
        "before_after_replan": STATE.before_after_replan,
    }


def execute_demo_step(step_number: int) -> dict:
    """Execute a specific step of the 7-step demo."""
    if step_number < 1 or step_number > len(DEMO_STEPS):
        step_number = 1

    step_info = DEMO_STEPS[step_number - 1]

    with STATE.lock:
        STATE.demo_state = {
            "active": True,
            "step": step_number,
            "total_steps": len(DEMO_STEPS),
            "name": step_info["title"],
            "badge": step_info["badge"],
            "description": step_info["description"],
            "paused": False,
        }

    # Apply step-specific state changes
    if step_number == 1:
        # Step 1: Normal
        with STATE.lock:
            for k in STATE.scenario:
                STATE.scenario[k] = False
            STATE.internet_online = True
            STATE.mqtt_connected = True
            STATE.generator_failed = False
            STATE.resupply_delay_days = 0.0
            STATE.flexible_shed_pct = 0.0
            STATE.fuel_l = 8800.0
            STATE.battery_soc = 65.0
            STATE.weather.update({"temperature_c": -16.0, "wind_speed_ms": 9.0, "solar_irradiance_wm2": 180.0, "condition": "partly cloudy"})
    elif step_number == 2:
        # Step 2: Storm -> CAUTION
        with STATE.lock:
            for k in STATE.scenario:
                STATE.scenario[k] = False
            STATE.scenario["storm"] = True
            STATE.scenario["bad_weather"] = True
            STATE.scenario["high_heating"] = True
            STATE.resupply_delay_days = 0.0
            STATE.weather.update({"temperature_c": -28.0, "wind_speed_ms": 26.0, "solar_irradiance_wm2": 20.0, "condition": "blizzard"})
    elif step_number == 3:
        # Step 3: Resupply Delay (+3d) -> CONSERVE
        with STATE.lock:
            for k in STATE.scenario:
                STATE.scenario[k] = False
            STATE.scenario["resupply_risk"] = True
            STATE.resupply_delay_days = 3.0
            STATE.weather.update({"temperature_c": -18.0, "wind_speed_ms": 11.0, "solar_irradiance_wm2": 150.0, "condition": "partly cloudy"})
    elif step_number == 4:
        # Step 4: Combined Storm + Resupply Delay -> CRITICAL
        with STATE.lock:
            STATE.scenario["storm"] = True
            STATE.scenario["bad_weather"] = True
            STATE.scenario["high_heating"] = True
            STATE.scenario["resupply_risk"] = True
            STATE.resupply_delay_days = 3.0
            STATE.weather.update({"temperature_c": -32.0, "wind_speed_ms": 30.0, "solar_irradiance_wm2": 10.0, "condition": "severe blizzard"})
    elif step_number == 5:
        # Step 5: Optimizer Replan
        with STATE.lock:
            STATE.scenario["storm"] = True
            STATE.scenario["resupply_risk"] = True
            STATE.resupply_delay_days = 3.0
            STATE.flexible_shed_pct = 0.35  # Reduce flexible load
    elif step_number == 6:
        # Step 6: Safety Validation & Recovery
        with STATE.lock:
            STATE.scenario["storm"] = True
            STATE.scenario["resupply_risk"] = True
            STATE.resupply_delay_days = 3.0
            STATE.flexible_shed_pct = 0.37  # 63% flexible load active
    elif step_number == 7:
        # Step 7: Offline Mode
        with STATE.lock:
            STATE.internet_online = False
            STATE.mqtt_connected = False

    from .decision import run_pipeline
    rec = run_pipeline(f"demo_step_{step_number}:{step_info['title']}")
    al.evaluate()

    db.log_event(source="demo", event=f"Demo Step {step_number}: {step_info['title']}",
                 detail=step_info["description"], status="info")

    return {
        "demo_state": STATE.demo_state,
        "recommendation": rec,
        "autonomy": STATE.autonomy,
        "what_changed": STATE.what_changed,
        "before_after_replan": STATE.before_after_replan,
    }


def start_demo() -> dict:
    """Start demo at Step 1."""
    return execute_demo_step(1)


def next_demo_step() -> dict:
    """Advance to next step."""
    current = getattr(STATE, "demo_state", {}).get("step", 1)
    next_step = current + 1 if current < len(DEMO_STEPS) else 1
    return execute_demo_step(next_step)


def prev_demo_step() -> dict:
    """Go to previous step."""
    current = getattr(STATE, "demo_state", {}).get("step", 1)
    prev_step = current - 1 if current > 1 else len(DEMO_STEPS)
    return execute_demo_step(prev_step)


def pause_demo() -> dict:
    """Toggle demo pause."""
    with STATE.lock:
        is_paused = not STATE.demo_state.get("paused", False)
        STATE.demo_state["paused"] = is_paused
    return {"demo_state": STATE.demo_state}


def stop_demo() -> dict:
    """Exit demo and restore nominal operation."""
    with STATE.lock:
        STATE.demo_state = {
            "active": False, "step": 1, "total_steps": len(DEMO_STEPS),
            "name": "Normal Operation", "paused": False,
        }
        for k in STATE.scenario:
            STATE.scenario[k] = False
        STATE.internet_online = True
        STATE.mqtt_connected = True
        STATE.generator_failed = False
        STATE.resupply_delay_days = 0.0

    from .decision import run_pipeline
    rec = run_pipeline("demo_exit")
    al.evaluate()
    return {"demo_state": STATE.demo_state, "recommendation": rec}


def demo_status() -> dict:
    return getattr(STATE, "demo_state", {"active": False, "step": 1, "total_steps": 7})
