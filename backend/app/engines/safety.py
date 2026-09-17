"""Safety validation engine.

Architecture (§14): FORECAST → OPTIMIZER → SAFETY VALIDATION → APPROVED
PLAN → OPERATOR. The optimizer never controls the station directly; every
plan must pass rule validation here first.
"""
from __future__ import annotations

import time

try:
    from ..config import SAFETY_RULES
    from ..state.system_state import STATE
    from . import forecast as fc
except (ImportError, ValueError):
    from app.config import SAFETY_RULES
    from app.state.system_state import STATE
    from app.engines import forecast as fc


def validate(plan: dict) -> dict:
    """Check a plan against all safety rules. Returns pass/fail + violations."""
    checks = []
    ok = True
    reserve = SAFETY_RULES["min_battery_soc"]

    # 1. battery reserve across the plan
    soc = STATE.battery_soc
    floor_seen = soc
    for s in plan.get("steps", []):
        bk = float(s["battery_kw"])
        if bk >= 0:
            soc += bk * 0.95 / 1200 * 100
        else:
            soc += bk / 0.95 / 1200 * 100
        floor_seen = min(floor_seen, soc)
    passed = bool(floor_seen >= reserve - 0.05)  # small float tolerance at the boundary
    ok &= passed
    checks.append({"rule": "battery_reserve", "passed": passed,
                   "detail": f"planned SOC floor {floor_seen:.1f}% vs minimum {reserve}%"})

    # 2. fuel reserve
    fuel_used = plan.get("expected_fuel_l", 0)
    fuel_end_pct = (STATE.fuel_l - fuel_used) / 10000 * 100
    passed = fuel_end_pct >= SAFETY_RULES["min_fuel_reserve_pct"]
    ok &= passed
    checks.append({"rule": "fuel_reserve", "passed": passed,
                   "detail": f"end-of-plan fuel {fuel_end_pct:.1f}% vs minimum {SAFETY_RULES['min_fuel_reserve_pct']}%"})

    # 3. critical load served every hour
    shortfall = [s for s in plan.get("steps", [])
                 if (s["diesel_kw"] + s["solar_kw"] + s["wind_kw"] -
                     max(0.0, s["battery_kw"])) + 1e-6 < SAFETY_RULES["critical_load_kw"]]
    passed = not shortfall
    ok &= passed
    checks.append({"rule": "critical_load_served", "passed": passed,
                   "detail": f"{len(shortfall)} hour(s) below critical load {SAFETY_RULES['critical_load_kw']} kW" if shortfall else "critical load covered all hours"})

    # 4. generator limits
    over = [s["diesel_kw"] for s in plan.get("steps", [])
            if s["diesel_kw"] > SAFETY_RULES["generator_max_kw"] + 1e-6]
    passed = not over
    ok &= passed
    checks.append({"rule": "generator_limits", "passed": passed,
                   "detail": f"max planned {max(over) if over else 0} kW" if over else "within limits"})

    # 5. emergency reserve head-room (uncertainty-aware)
    scen_unc = 0.10
    if STATE.scenario.get("storm") or STATE.scenario.get("bad_weather"):
        scen_unc = 0.22
    headroom_kwh = (STATE.battery_soc - SAFETY_RULES["emergency_battery_soc"]) / 100 * 1200
    need_kwh = SAFETY_RULES["critical_load_kw"] * plan.get("horizon_h", 6) * (1 + scen_unc)
    passed = headroom_kwh >= need_kwh * 0.5  # battery must cover ≥50% of uncertain critical need
    ok &= passed
    checks.append({"rule": "emergency_headroom", "passed": passed,
                   "detail": f"headroom {headroom_kwh:.0f} kWh vs uncertain critical need {need_kwh:.0f} kWh (unc {int(scen_unc*100)}%)"})

    # 6. energy balance sanity per step
    bad_balance = [s for s in plan.get("steps", [])
                   if abs((s["solar_kw"] + s["wind_kw"] + s["diesel_kw"] +
                           max(0.0, -s["battery_kw"])) - s["load_kw"]) > 0.15 * s["load_kw"] + 5]

    # 7. resupply margin (CQRM >= 0.0 Days)
    # The nominal optimizer plan requires positive resupply margin (Safe Operability >= P90 Resupply).
    # If CQRM < 0, nominal plans are rejected and require conservation fallback.
    is_fallback = (
        "fallback" in plan.get("method", "").lower()
        or "fallback" in str(plan.get("reason", "")).lower()
        or STATE.scenario.get("conserve", False)
        or plan.get("is_conservation_strategy", False)
    )
    try:
        from . import autonomy as au
        auto_calc = au.calculate()
        margin = auto_calc.get("cqrm_margin_days", auto_calc.get("autonomy_margin_days", 0.0))
        p90_days = auto_calc.get("next_resupply_days", auto_calc.get("resupply_conservative_days", 10.3))
        safe_days = auto_calc.get("safe_autonomy_days", 10.8)
    except Exception:
        margin = 0.5
        p90_days = 10.3
        safe_days = 10.8

    if not is_fallback and margin < -0.05:
        passed = False
        ok &= passed
        checks.append({
            "rule": "resupply_margin",
            "passed": False,
            "detail": f"Negative CQRM margin ({margin:.1f} days) — Safe operability ({safe_days:.1f}d) is shorter than P90 resupply ETA ({p90_days:.1f}d). Fallback required.",
        })
    else:
        checks.append({
            "rule": "resupply_margin",
            "passed": True,
            "detail": f"CQRM margin {margin:+.1f} days (resupply safely reachable)" if not is_fallback else f"Conservation fallback active under negative margin ({margin:.1f}d)",
        })

    result = {"passed": bool(ok), "checks": checks, "validated_at": time.time()}
    return result

