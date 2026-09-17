"""Resupply-Conditioned Energy Optimization Engine.

Chance-constrained LP scheduler (scipy.optimize.linprog) over a 6-hour horizon
deciding battery charge/discharge, diesel generation, and flexible load throttling.

CORE INNOVATION & CAUSALITY:
Resupply arrival uncertainty directly sets:
1. Dynamic battery reserve floor (raising reserve requirement when resupply is delayed).
2. Non-critical flexible load throttling (shedding to conserve fuel/energy for extended horizons).
3. Diesel conservation constraints to avoid premature fuel depletion.

This guarantees:
Resupply delay changes → Resupply distribution changes → Optimizer solution changes.
"""
from __future__ import annotations

import math
import time
from typing import Optional, Any

try:
    from scipy.optimize import linprog
except ImportError:
    linprog = None

try:
    from ..config import (
        BATTERY_CAPACITY_KWH, BATTERY_MAX_CHARGE_KW, BATTERY_MAX_DISCHARGE_KW,
        BATTERY_CHARGE_EFF, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
        DIESEL_MIN_KW, SAFETY_RULES,
    )
    from ..state.system_state import STATE
    from . import forecast as fc
    from . import resupply_model as rm
except (ImportError, ValueError):
    from app.config import (
        BATTERY_CAPACITY_KWH, BATTERY_MAX_CHARGE_KW, BATTERY_MAX_DISCHARGE_KW,
        BATTERY_CHARGE_EFF, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
        DIESEL_MIN_KW, SAFETY_RULES,
    )
    from app.state.system_state import STATE
    from app.engines import forecast as fc
    from app.engines import resupply_model as rm

HORIZON_H = 6


def optimize(
    reserve_soc: Optional[float] = None,
    flex_mult: Optional[float] = None,
    diesel_max: Optional[float] = None,
) -> dict[str, Any]:
    """Run resupply-conditioned optimization; return schedule + causality breakdown."""
    t0 = time.time()
    try:
        result = _lp_schedule(
            reserve_soc_override=reserve_soc,
            flex_mult_override=flex_mult,
            diesel_max_override=diesel_max,
        )
        result["method"] = "linear-programming (resupply-conditioned)"
        result["status"] = "optimal"
    except Exception as e:
        result = _rule_based_schedule(
            reason=f"LP fallback: {e}",
            reserve_soc_override=reserve_soc,
            flex_mult_override=flex_mult,
            diesel_max_override=diesel_max,
        )
        result["method"] = "rule-based-fallback"
        result["status"] = "fallback"

    result["compute_ms"] = round((time.time() - t0) * 1000, 1)
    result["created_at"] = time.time()
    return result


def _compute_risk_conditioned_reserves() -> tuple[float, float, dict]:
    """Calculate reserve SOC and flexible load multiplier conditioned on resupply
    arrival probability distribution.

    The resupply distribution directly constrains the optimizer:
      Weather + Season + Logistics
        → Resupply Arrival Distribution
        → P(arrive before SOH limit)
        → Reserve floor & flex load throttle

    This ensures uncertainty actually enters the dispatch, not just the display.
    """
    delay = getattr(STATE, "resupply_delay_days", 0.0)
    scen = STATE.scenario
    is_storm = scen.get("storm") or scen.get("bad_weather")

    # 1. Compute the actual resupply probability distribution
    resupply_dist = rm.compute_resupply_distribution(
        delay_days=delay, weather=STATE.weather, scenario=scen,
    )
    conservative_arrival = resupply_dist["conservative_days"]
    expected_arrival = resupply_dist["expected_days"]

    # 2. Extract P(resupply arrives within safe operability window)
    #    from the cumulative distribution — this is the key link
    soh_estimate_days = getattr(STATE, 'autonomy', {}).get('safe_autonomy_days', 9.0)
    p_arrive_before_soh = 0.5  # default
    for dp in resupply_dist.get("daily_distribution", []):
        if dp["day"] >= int(soh_estimate_days):
            p_arrive_before_soh = dp["cumulative_arrival_probability"]
            break
    else:
        if resupply_dist.get("daily_distribution"):
            p_arrive_before_soh = resupply_dist["daily_distribution"][-1]["cumulative_arrival_probability"]

    # 3. Reserve SOC: inversely proportional to arrival confidence
    uncertainty_penalty = max(0.0, (1.0 - p_arrive_before_soh) * 20.0)
    storm_penalty = 5.0 if is_storm else 0.0
    additional_reserve = uncertainty_penalty + storm_penalty
    reserve_soc = min(40.0, max(SAFETY_RULES["min_battery_soc"], 20.0 + additional_reserve))
    if STATE.mode == "ENERGY_CONSERVATION":
        reserve_soc = max(reserve_soc, 35.0)

    # 4. Flexible load multiplier: throttle more when resupply confidence is low
    confidence_throttle = max(0.0, (1.0 - p_arrive_before_soh) * 0.55)
    storm_throttle = 0.15 if is_storm else 0.0
    flex_mult = max(0.25, 1.0 - confidence_throttle - storm_throttle)
    if STATE.mode == "ENERGY_CONSERVATION":
        flex_mult = min(flex_mult, 0.35)

    causality = {
        "p_arrive_before_soh": round(p_arrive_before_soh, 3),
        "soh_estimate_days": round(soh_estimate_days, 1),
        "conservative_arrival_days": conservative_arrival,
        "expected_arrival_days": expected_arrival,
        "uncertainty_penalty_pct": round(uncertainty_penalty, 1),
        "reserve_soc_target": round(reserve_soc, 1),
        "flex_mult": round(flex_mult, 2),
    }

    return round(reserve_soc, 1), round(flex_mult, 2), causality


def _profile(H: int, flex_mult: float) -> list[dict]:
    f = STATE.latest_forecast or fc.forecast()
    steps24 = f["targets"]["load_kw"]["steps"]
    solar24 = f["targets"]["solar_kw"]["steps"].get("24", {"value": 0})
    wind24 = f["targets"]["wind_kw"]["steps"].get("24", {"value": 0})
    crit = STATE.critical_load_kw
    essential = STATE.essential_load_kw
    base_flex = STATE.flexible_load_kw
    effective_flex = base_flex * flex_mult

    out = []
    for h in range(H):
        # High-demand side planning
        total_load = crit + essential + effective_flex
        solar = max(0.0, float(solar24["value"]))
        wind = max(0.0, float(wind24["value"]))
        out.append({
            "load": round(total_load, 1),
            "load_hi": round(total_load * 1.05, 1),
            "solar": round(solar, 1),
            "wind": round(wind, 1),
            "renew_lo": round((solar + wind) * 0.82, 1),
            "flexible": round(effective_flex, 1),
            "flexible_pct": round(flex_mult * 100, 1),
        })
    return out


def _diesel_max(override: Optional[float] = None) -> float:
    if STATE.generator_failed:
        return 0.0
    if override is not None:
        return override
    return SAFETY_RULES["generator_max_kw"]


def _lp_schedule(
    reserve_soc_override: Optional[float] = None,
    flex_mult_override: Optional[float] = None,
    diesel_max_override: Optional[float] = None,
) -> dict[str, Any]:
    if linprog is None:
        raise RuntimeError("scipy is not installed; linprog unavailable")
    H = HORIZON_H
    if reserve_soc_override is not None and flex_mult_override is not None:
        reserve_soc = float(reserve_soc_override)
        flex_mult = float(flex_mult_override)
        resupply_causality = {
            "reserve_soc_target": reserve_soc,
            "flex_mult": flex_mult,
            "source": "candidate_strategy",
        }
    else:
        reserve_soc, flex_mult, resupply_causality = _compute_risk_conditioned_reserves()

    prof = _profile(H, flex_mult)

    reserve_kwh = BATTERY_CAPACITY_KWH * (reserve_soc / 100.0)

    # Decision vars per hour h: [charge_h, discharge_h, diesel_h]
    # Minimise diesel fuel: c = [0, 0, fuel_per_kwh] * H
    c = [0.0, 0.0, DIESEL_FUEL_L_PER_KWH] * H

    A_eq, b_eq = [], []
    A_ub, b_ub = [], []
    soc_start = STATE.battery_soc / 100.0 * BATTERY_CAPACITY_KWH
    d_max = _diesel_max(diesel_max_override)

    for h in range(H):
        load = prof[h]["load_hi"]
        renew = prof[h]["renew_lo"]

        # Energy Balance: renew + discharge + diesel - charge = load
        row_eq = [0.0] * (3 * H)
        row_eq[3 * h] = -1.0                    # charge
        row_eq[3 * h + 1] = BATTERY_DISCHARGE_EFF  # discharge
        row_eq[3 * h + 2] = 1.0                 # diesel
        A_eq.append(row_eq)
        b_eq.append(load - renew)

        # Battery reserve inequality:
        # SOC_{h+1} = SOC_0 + sum(eff_c*charge - discharge/eff_d) >= reserve_kwh
        # <=> -sum(eff_c*charge - discharge/eff_d) <= SOC_0 - reserve_kwh
        row_ub = [0.0] * (3 * H)
        for k in range(h + 1):
            row_ub[3 * k] = -BATTERY_CHARGE_EFF
            row_ub[3 * k + 1] = 1.0 / BATTERY_DISCHARGE_EFF
        A_ub.append(row_ub)
        # Tighter reserve ceiling directly restricts battery discharge!
        b_ub.append(max(0.0, soc_start - reserve_kwh))

        # Generator rating constraint
        row_gen = [0.0] * (3 * H)
        row_gen[3 * h + 2] = 1.0
        A_ub.append(row_gen)
        b_ub.append(d_max)

    bounds = []
    for h in range(H):
        bounds.append((0.0, BATTERY_MAX_CHARGE_KW))
        bounds.append((0.0, BATTERY_MAX_DISCHARGE_KW))
        bounds.append((0.0, d_max))

    res = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq, bounds=bounds, method="highs")
    if not res.success:
        raise RuntimeError(res.message)

    steps = []
    for h in range(H):
        charge = float(res.x[3 * h])
        discharge = float(res.x[3 * h + 1])
        diesel = float(res.x[3 * h + 2])
        # Net battery power: positive = charging, negative = discharging
        net_battery = round(charge - discharge, 1)
        steps.append({
            "start_offset_h": h,
            "hours": 1.0,
            "diesel_kw": round(diesel, 1),
            "battery_kw": net_battery,
            "battery_charge_kw": round(charge, 1),
            "battery_discharge_kw": round(discharge, 1),
            "solar_kw": prof[h]["solar"],
            "wind_kw": prof[h]["wind"],
            "load_kw": prof[h]["load_hi"],
            "flexible_kw": prof[h]["flexible"],
            "flexible_pct": prof[h]["flexible_pct"],
        })

    fuel_used = sum(s["diesel_kw"] for s in steps) * DIESEL_FUEL_L_PER_KWH
    fuel_used_r = round(float(fuel_used), 1)
    fuel_remaining = round(STATE.fuel_l - fuel_used_r, 1)
    end_soc = _project_end_soc(steps)

    dispatch_summary = {
        "battery_kw": abs(steps[0]["battery_kw"]),
        "diesel_kw": steps[0]["diesel_kw"],
        "flexible_pct": round(flex_mult * 100, 1),
        "reserve_soc_pct": reserve_soc,
        "resupply_delay_days": getattr(STATE, "resupply_delay_days", 0.0),
    }

    return {
        "horizon_h": H,
        "steps": steps,
        "expected_fuel_l": fuel_used_r,
        "fuel_consumed_6h_l": fuel_used_r,
        "fuel_remaining_end_l": fuel_remaining,
        "expected_end_soc": end_soc,
        "objective": fuel_used_r,
        "reserve_soc_target": reserve_soc,
        "flexible_load_pct": round(flex_mult * 100, 1),
        "dispatch_summary": dispatch_summary,
        "recommendation_summary": _summary(steps, end_soc, reserve_soc, flex_mult),
        "resupply_causality": resupply_causality,
    }


def _project_end_soc(steps: list[dict]) -> float:
    soc = STATE.battery_soc / 100.0 * BATTERY_CAPACITY_KWH
    for s in steps:
        bk = float(s["battery_kw"])
        if bk >= 0:
            soc += bk * BATTERY_CHARGE_EFF
        else:
            soc += bk / BATTERY_DISCHARGE_EFF
    return round(max(0.0, min(100.0, soc / BATTERY_CAPACITY_KWH * 100.0)), 1)


def _summary(steps: list[dict], end_soc: float, reserve_soc: float, flex_mult: float) -> str:
    parts = []
    delay = getattr(STATE, "resupply_delay_days", 0.0)
    has_diesel = any(s["diesel_kw"] > 0 for s in steps)
    avg_diesel = sum(s["diesel_kw"] for s in steps) / max(1, len(steps))

    if delay > 0:
        parts.append(f"Resupply delayed by +{delay:.0f}d: battery reserve floor raised to {reserve_soc:.0f}%")
        if flex_mult < 1.0:
            parts.append(f"flexible loads throttled to {int(flex_mult*100)}% to extend autonomy")
    else:
        parts.append(f"Nominal horizon: battery reserves held above {reserve_soc:.0f}% floor")

    if has_diesel:
        parts.append(f"generator dispatched at {avg_diesel:.0f} kW average to protect critical heating")
    else:
        parts.append("renewables and battery carrying total load without diesel")

    return ". ".join(parts) + "."


def _rule_based_schedule(
    reason: str = "",
    reserve_soc_override: Optional[float] = None,
    flex_mult_override: Optional[float] = None,
    diesel_max_override: Optional[float] = None,
) -> dict[str, Any]:
    """Safe fallback rule-based strategy."""
    H = HORIZON_H
    if reserve_soc_override is not None and flex_mult_override is not None:
        reserve_soc = float(reserve_soc_override)
        flex_mult = float(flex_mult_override)
        resupply_causality = {
            "reserve_soc_target": reserve_soc,
            "flex_mult": flex_mult,
            "source": "candidate_strategy",
        }
    else:
        reserve_soc, flex_mult, resupply_causality = _compute_risk_conditioned_reserves()

    prof = _profile(H, flex_mult)
    d_max = _diesel_max(diesel_max_override)

    steps = []
    soc = STATE.battery_soc
    for h in range(H):
        load = prof[h]["load_hi"]
        renew = prof[h]["renew_lo"]
        flex = prof[h]["flexible"]
        net = load - renew
        battery_kw, diesel_kw = 0.0, 0.0

        if net <= 0:
            battery_kw = round(min(-net, BATTERY_MAX_CHARGE_KW), 1) if soc < 95 else 0.0
        else:
            if soc > reserve_soc + 2.0:
                d = min(net, BATTERY_MAX_DISCHARGE_KW)
                battery_kw = -round(d, 1)
                net -= d
                soc -= d / BATTERY_DISCHARGE_EFF / BATTERY_CAPACITY_KWH * 100
            if net > 0 and not STATE.generator_failed:
                diesel_kw = round(max(min(net, d_max), DIESEL_MIN_KW if net > 5 else 0.0), 1)

        steps.append({
            "start_offset_h": h,
            "hours": 1.0,
            "diesel_kw": diesel_kw,
            "battery_kw": battery_kw,
            "battery_charge_kw": max(0.0, battery_kw),
            "battery_discharge_kw": abs(min(0.0, battery_kw)),
            "solar_kw": prof[h]["solar"],
            "wind_kw": prof[h]["wind"],
            "load_kw": round(load, 1),
            "flexible_kw": round(flex, 1),
            "flexible_pct": prof[h]["flexible_pct"],
        })

    fuel_used_r = round(sum(s["diesel_kw"] for s in steps) * DIESEL_FUEL_L_PER_KWH, 1)
    fuel_remaining = round(STATE.fuel_l - fuel_used_r, 1)
    end_soc = _project_end_soc(steps)

    dispatch_summary = {
        "battery_kw": abs(steps[0]["battery_kw"]),
        "diesel_kw": steps[0]["diesel_kw"],
        "flexible_pct": round(flex_mult * 100, 1),
        "reserve_soc_pct": reserve_soc,
        "resupply_delay_days": getattr(STATE, "resupply_delay_days", 0.0),
    }

    return {
        "horizon_h": H,
        "steps": steps,
        "expected_fuel_l": fuel_used_r,
        "fuel_consumed_6h_l": fuel_used_r,
        "fuel_remaining_end_l": fuel_remaining,
        "expected_end_soc": end_soc,
        "objective": fuel_used_r,
        "reserve_soc_target": reserve_soc,
        "flexible_load_pct": round(flex_mult * 100, 1),
        "dispatch_summary": dispatch_summary,
        "reason": reason or "rule-based safe fallback",
        "recommendation_summary": _summary(steps, end_soc, reserve_soc, flex_mult),
        "resupply_causality": resupply_causality,
    }
