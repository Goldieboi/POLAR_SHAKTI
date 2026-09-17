"""Autonomy & Safe-Operability Engine (CQRM Core).

Projects future energy conditions hour by hour (demand, renewables, battery
and fuel draw-down under reserves and uncertainty) and calculates safe station
operability over multiple uncertainty scenarios:
- expected_days
- conservative_days (safe operability planning metric: SOH_alpha(t))
- optimistic_days
- confidence (0.90)
- failure_probability_before_resupply

Confidence-Qualified Resupply Margin:
  CQRM_alpha(t) = SOH_alpha(t) - R_(1-alpha)(t)
Operator-facing label: Resupply Margin
"""
from __future__ import annotations

import math
import time
from typing import Any

try:
    from ..config import (
        BATTERY_CAPACITY_KWH, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
        RESUPPLY_RISK_MARGIN_DAYS, CRITICAL_MARGIN_DAYS, EMERGENCY_FUEL_PCT,
        SAFETY_RULES, USABLE_FUEL_L,
    )
    from ..state.system_state import STATE
    from . import forecast as fc
    from . import resupply_model as rm
except (ImportError, ValueError):
    from app.config import (
        BATTERY_CAPACITY_KWH, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
        RESUPPLY_RISK_MARGIN_DAYS, CRITICAL_MARGIN_DAYS, EMERGENCY_FUEL_PCT,
        SAFETY_RULES, USABLE_FUEL_L,
    )
    from app.state.system_state import STATE
    from app.engines import forecast as fc
    from app.engines import resupply_model as rm

METHODOLOGY = (
    "Confidence-Qualified Resupply Margin (CQRM): CQRM_α(t) = SOH_α(t) − R_(1−α)(t). "
    "Safe Operability Horizon (SOH) represents the conservative (P90) horizon under adverse weather "
    "and renewable intervals. Resupply Horizon R_(1-α)(t) represents the conservative arrival window."
)


def _hourly_profile(hours: int, renew_mult: float, load_mult: float) -> list[dict]:
    """Build an hourly projection of load and renewables."""
    f = STATE.latest_forecast or fc.forecast()
    scen = STATE.scenario
    unc = 0.10
    if scen.get("storm") or scen.get("bad_weather"):
        unc = 0.25
    elif scen.get("low_renewable"):
        unc = 0.18

    load24 = f["targets"]["load_kw"]["steps"].get("24", {"value": STATE.total_load_kw()})
    solar24 = f["targets"]["solar_kw"]["steps"].get("24", {"value": 0})
    wind24 = f["targets"]["wind_kw"]["steps"].get("24", {"value": 0})

    prof = []
    for h in range(hours):
        diurnal = math.sin(2 * math.pi * ((STATE.now_h() + h) % 24) / 24 - math.pi / 3)
        load = load24["value"] * (1 + 0.08 * diurnal) * load_mult
        solar = max(0.0, solar24["value"] * (1 + 0.3 * diurnal)) * renew_mult
        wind = max(0.0, wind24["value"] * (1 + 0.12 * diurnal)) * renew_mult
        prof.append({
            "hour": h,
            "load_kw": load,
            "renewable_kw": (solar + wind) * (1 - unc),
        })
    return prof


def _simulate_scenario(renew_mult: float, load_mult: float, reserve_soc_pct: float) -> tuple[float, float | None, float | None]:
    """Simulate energy depletion for a given uncertainty scenario."""
    hours_to_project = 720  # 30-day forward operational horizon
    prof = _hourly_profile(hours_to_project, renew_mult, load_mult)

    fuel_reserve_l = USABLE_FUEL_L * SAFETY_RULES["min_fuel_reserve_pct"] / 100.0
    fuel_l = max(0.0, STATE.fuel_l - fuel_reserve_l)
    batt_kwh = max(0.0, STATE.usable_battery_kwh(reserve_soc_pct))

    if STATE.generator_failed:
        # battery + renewables only
        first_step = prof[0] if prof else {"load_kw": 120.0, "renewable_kw": 0.0}
        net_drain = max(10.0, first_step["load_kw"] - first_step["renewable_kw"])
        return round(batt_kwh / net_drain / 24.0, 1), None, 0.0

    autonomy_h = 0.0
    fuel_exhausted_h = None
    battery_at_reserve_h = None

    for step in prof:
        load = step["load_kw"]
        renew = step["renewable_kw"]
        net = load - renew

        if net <= 0:
            # surplus charges battery
            batt_kwh = min(BATTERY_CAPACITY_KWH * (100.0 - reserve_soc_pct) / 100.0,
                           batt_kwh + (-net) * BATTERY_DISCHARGE_EFF)
            autonomy_h += 1.0
            continue

        # battery handles peak first
        from_batt = min(batt_kwh, net)
        batt_kwh -= from_batt
        net -= from_batt

        if batt_kwh <= 0.01 and battery_at_reserve_h is None:
            battery_at_reserve_h = step["hour"]

        if net > 0:
            fuel_needed = net * DIESEL_FUEL_L_PER_KWH
            if fuel_l >= fuel_needed:
                fuel_l -= fuel_needed
                autonomy_h += 1.0
            else:
                if fuel_l > 0:
                    autonomy_h += fuel_l / fuel_needed
                fuel_l = 0.0
                fuel_exhausted_h = step["hour"]
                break
        else:
            autonomy_h += 1.0

    return round(autonomy_h / 24.0, 1), fuel_exhausted_h, battery_at_reserve_h


def calculate() -> dict[str, Any]:
    """Compute multi-scenario safe operability, failure probability, and CQRM margin."""
    # Update resupply model
    resupply_info = rm.compute_resupply_distribution(
        delay_days=getattr(STATE, "resupply_delay_days", 0.0),
        weather=STATE.weather,
        scenario=STATE.scenario,
    )
    with STATE.lock:
        STATE.resupply_model = resupply_info
        STATE.resupply_date_days = resupply_info["expected_days"]

    base_soc_reserve = SAFETY_RULES["min_battery_soc"]

    # 1. Conservative Scenario (High demand, storm/low renewables, strict reserve)
    conservative_days, fuel_ex_h, batt_res_h = _simulate_scenario(
        renew_mult=0.72, load_mult=1.10, reserve_soc_pct=base_soc_reserve + 5.0
    )

    # 2. Expected Scenario (Nominal forecast, standard reserve)
    expected_days, _, _ = _simulate_scenario(
        renew_mult=1.00, load_mult=1.00, reserve_soc_pct=base_soc_reserve
    )

    # 3. Optimistic Scenario (Favorable renewables, lower demand)
    optimistic_days, _, _ = _simulate_scenario(
        renew_mult=1.25, load_mult=0.92, reserve_soc_pct=base_soc_reserve
    )

    # Enforce logical ordering: conservative <= expected <= optimistic
    conservative_days = min(conservative_days, expected_days)
    optimistic_days = max(optimistic_days, expected_days)

    resupply_target_days = resupply_info["conservative_days"]
    resupply_expected_days = resupply_info["expected_days"]

    # CQRM Margin: Safe operability vs conservative (P90) resupply arrival
    margin = round(conservative_days - resupply_target_days, 2)

    # Failure probability before resupply (logistic CDF of deficit margin)
    # margin = +2.0 d -> ~5% fail
    # margin = 0.0 d -> ~50% fail
    # margin = -1.5 d -> ~85% fail
    k = 1.35
    p_fail = 1.0 / (1.0 + math.exp(margin * k))
    p_fail = round(max(0.02, min(0.98, p_fail)), 2)

    # Status mapping per locked design:
    # SAFE (green) -> CAUTION (amber) -> CONSERVE (orange) -> CRITICAL (red)
    fuel_pct = STATE.fuel_pct()
    if STATE.generator_failed or fuel_pct < EMERGENCY_FUEL_PCT or margin < -1.0 or p_fail >= 0.55:
        status = "CRITICAL"
    elif margin < 0.5 or p_fail >= 0.35:
        status = "CONSERVE"
    elif margin < 2.0 or p_fail >= 0.15:
        status = "CAUTION"
    else:
        status = "SAFE"

    interpretation = _interpret(
        safe_d=conservative_days,
        resupply_d=resupply_expected_days,
        margin=margin,
        p_fail=p_fail,
        status=status,
    )

    fuel_reserve_l = USABLE_FUEL_L * SAFETY_RULES["min_fuel_reserve_pct"] / 100.0

    result = {
        # Core decision metrics
        "safe_autonomy_days": conservative_days,
        "conservative_days": conservative_days,
        "expected_days": expected_days,
        "optimistic_days": optimistic_days,
        "confidence": 0.90,
        "failure_probability_before_resupply": p_fail,

        # Logistics & CQRM
        "next_resupply_days": resupply_expected_days,
        "resupply_conservative_days": resupply_target_days,
        "autonomy_margin_days": margin,
        "cqrm_margin_days": margin,
        "status": status,
        "interpretation": interpretation,

        # Detailed breakdown
        "fuel_exhausted_at_h": fuel_ex_h,
        "battery_at_reserve_at_h": batt_res_h,
        "methodology": METHODOLOGY,
        "assumptions": {
            "min_battery_soc_reserve_pct": base_soc_reserve,
            "min_fuel_reserve_l": round(fuel_reserve_l, 1),
            "conservative_renewable_case": "Low forecast interval (P10) with weather penalty",
            "diesel_specific_consumption_l_per_kwh": DIESEL_FUEL_L_PER_KWH,
            "resupply_uncertainty_included": True,
        },
        "resupply_model": resupply_info,
        "calculated_at": time.time(),
    }

    with STATE.lock:
        STATE.autonomy = result
        _update_mode(result)
    return result


def _interpret(safe_d: float, resupply_d: float, margin: float, p_fail: float, status: str) -> str:
    """Generate plain language decision interpretation."""
    if status == "SAFE":
        return (f"Safe Operability ({safe_d}d) comfortably exceeds resupply ETA ({resupply_d}d) "
                f"with +{margin}d margin. Energy shortfall risk is negligible ({int(p_fail*100)}%).")
    elif status == "CAUTION":
        return (f"Safe Operability ({safe_d}d) allows a narrow +{margin}d buffer over resupply ETA ({resupply_d}d). "
                f"Shortfall risk is elevated ({int(p_fail*100)}%). Precautionary conservation advised.")
    elif status == "CONSERVE":
        return (f"Safe Operability ({safe_d}d) is constrained relative to resupply ETA ({resupply_d}d) "
                f"(margin: {margin:+.1f}d). Shortfall probability is {int(p_fail*100)}%. Flexible load reduction required.")
    else:  # CRITICAL
        deficit = abs(margin)
        return (f"DEFICIT DETECTED: Safe Operability ({safe_d}d) falls short of resupply ETA ({resupply_d}d) "
                f"by {deficit:.1f} days. Risk of energy failure before arrival is {int(p_fail*100)}%. Immediate conservation mode activated.")


def _update_mode(a: dict) -> None:
    """Synchronize station operating mode with CQRM risk assessment."""
    if not STATE.mode_auto:
        return
    st = a.get("status", "SAFE")
    if st == "CRITICAL":
        STATE.mode = "CRITICAL"
    elif st == "CONSERVE":
        STATE.mode = "ENERGY_CONSERVATION"
    elif st == "CAUTION":
        STATE.mode = "RESUPPLY_RISK"
    else:
        STATE.mode = "NORMAL"
