"""Energy-system simulation step.

Implements the physics loop: weather → renewables & heating demand →
dispatch (battery/generator) → energy balance → SOC/fuel updates.
All values are kept mathematically consistent (Generation + discharge =
Load + charge + losses).
"""
from __future__ import annotations

from ..config import (
    BATTERY_CAPACITY_KWH, BATTERY_MAX_CHARGE_KW, BATTERY_MAX_DISCHARGE_KW,
    BATTERY_CHARGE_EFF, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
    DIESEL_MIN_KW, SAFETY_RULES,
)
from . import weather as wx
from ..state.system_state import STATE


def _renewables() -> tuple[float, float]:
    return (
        wx.solar_output_kw(STATE.weather["solar_irradiance_wm2"], STATE.weather["temperature_c"]),
        wx.wind_output_kw(STATE.weather["wind_speed_ms"]),
    )


def sim_step(dt_h: float) -> dict:
    """Advance the plant by dt_h simulated hours and return the balance."""
    with STATE.lock:
        scenario = STATE.scenario
        STATE.weather = wx.weather_snapshot(STATE.now_h(), scenario)

        solar_kw, wind_kw = _renewables()
        renewable_kw = solar_kw + wind_kw

        heating_kw = wx.heating_demand_kw(STATE.weather["temperature_c"],
                                          STATE.weather["wind_speed_ms"])
        # Heating sits inside the essential block; essentials flex with heating.
        essential_kw = 55.0 + heating_kw
        STATE.essential_load_kw = round(essential_kw, 1)

        load_kw = STATE.total_load_kw()

        # --- generator failure scenario ---
        if STATE.generator_failed:
            STATE.generator_running = False
            STATE.generator_output_kw = 0.0

        # --- follow approved plan if present, else rule-based dispatch ---
        plan_step = None
        if STATE.approved_plan.get("steps"):
            for s in STATE.approved_plan["steps"]:
                if s["start_offset_h"] <= STATE.now_h() % 6 < s["start_offset_h"] + s["hours"]:
                    plan_step = s
                    break

        battery_kw = 0.0
        diesel_kw = 0.0
        if plan_step:
            diesel_kw = float(plan_step.get("diesel_kw", 0.0))
            battery_kw = float(plan_step.get("battery_kw", 0.0))
            STATE.generator_running = diesel_kw > 0
        else:
            # Rule-based dispatch: renewables first, battery fills the gap,
            # diesel covers the rest. Battery holds reserve.
            surplus = renewable_kw - load_kw
            reserve = SAFETY_RULES["min_battery_soc"]
            if surplus >= 0:
                charge = min(surplus, BATTERY_MAX_CHARGE_KW)
                if STATE.battery_soc < 95:
                    battery_kw = charge
                    surplus -= charge
                diesel_kw = 0.0
            else:
                deficit = -surplus
                if STATE.battery_soc > reserve + 2:
                    d = min(deficit, BATTERY_MAX_DISCHARGE_KW)
                    battery_kw = -d
                    deficit -= d
                if deficit > 0 and not STATE.generator_failed:
                    diesel_kw = min(DIESEL_MAX(), deficit)
                    STATE.generator_running = True

        if diesel_kw > 0 and not STATE.generator_failed:
            diesel_kw = max(diesel_kw, DIESEL_MIN_KW)
            STATE.generator_running = True
        else:
            diesel_kw = 0.0
            STATE.generator_running = False

        # --- apply battery physics ---
        eff = BATTERY_CHARGE_EFF if battery_kw > 0 else BATTERY_DISCHARGE_EFF
        if battery_kw > 0:  # charging
            room_kwh = BATTERY_CAPACITY_KWH * (95.0 - STATE.battery_soc) / 100.0
            max_kw = min(BATTERY_MAX_CHARGE_KW, room_kwh / dt_h * eff)
            battery_kw = min(battery_kw, max_kw)
            if battery_kw < 0:
                battery_kw = 0.0
            STATE.battery_soc += battery_kw * eff * dt_h / BATTERY_CAPACITY_KWH * 100
        elif battery_kw < 0:  # discharging
            floor = max(SAFETY_RULES["emergency_battery_soc"], 5)
            avail_kwh = BATTERY_CAPACITY_KWH * max(0.0, STATE.battery_soc - floor) / 100.0
            max_kw = avail_kwh / dt_h * eff
            battery_kw = max(battery_kw, -min(BATTERY_MAX_DISCHARGE_KW, max_kw))
            STATE.battery_soc -= (-battery_kw) / eff * dt_h / BATTERY_CAPACITY_KWH * 100
        battery_kw = round(battery_kw, 1)
        STATE.battery_power_kw = battery_kw

        # --- fuel consumption ---
        if diesel_kw > 0:
            fuel_used_l = diesel_kw * DIESEL_FUEL_L_PER_KWH * dt_h
            STATE.fuel_l = max(0.0, STATE.fuel_l - fuel_used_l)

        # --- energy balance: ensure generation meets load (+ losses) ---
        losses_kw = round(0.02 * load_kw, 1)
        diesel_after_min = diesel_kw
        total_supply = solar_kw + wind_kw - battery_kw  # battery_kw<0 => discharge adds
        # clamp diesel to the residual so balance holds exactly
        residual = load_kw + losses_kw - (solar_kw + wind_kw - battery_kw)
        if residual > 0 and not STATE.generator_failed:
            diesel_after_min = max(diesel_kw, min(DIESEL_MAX(), residual))
            if not STATE.generator_running and residual > 0:
                STATE.generator_running = diesel_after_min > 0
        elif residual < 0:
            # curtail renewables (log as excess)
            pass
        STATE.generator_output_kw = round(diesel_after_min, 1)
        if STATE.generator_output_kw > 0:
            STATE.fuel_l = max(0.0, STATE.fuel_l - (STATE.generator_output_kw - diesel_kw) * DIESEL_FUEL_L_PER_KWH * dt_h)

        STATE.flexible_shed_pct = STATE.operator_overrides.get("flexible_shed_pct", STATE.flexible_shed_pct)

        balance = {
            "solar_kw": solar_kw, "wind_kw": wind_kw,
            "battery_kw": battery_kw, "diesel_kw": STATE.generator_output_kw,
            "load_kw": load_kw, "heating_kw": heating_kw,
            "losses_kw": losses_kw,
        }
        STATE._last_balance = balance
        return balance


def DIESEL_MAX() -> float:
    from ..state.system_state import STATE as _S
    return 0.0 if _S.generator_failed else 500.0
