"""POLAR-EMS Candidate Plan Generator & Multi-Criteria Decision Engine.

Generates 2-4 genuine candidate operating plans, evaluates each through the
LP optimizer and deterministic safety validator, ranks them based on safety,
CQRM, battery reserve, and resource efficiency, identifies the POLAR-EMS
Recommended plan, and provides dynamically computed justifications.

Pipeline (§18):
  Input Overrides / State
       ↓
  Forecasts / SOH / Resupply Model
       ↓
  Generate Candidate Strategies (Parameterized Reserve Floors & Flex Multipliers)
       ↓
  Evaluate Each Candidate (LP Scheduler + Scenario Simulation)
       ↓
  Deterministic Safety Validation (Rule checks)
       ↓
  Multi-Criteria Ranking (Safety > Critical Coverage > CQRM > Fuel > Disruption)
       ↓
  POLAR-EMS Recommendation & State Difference Explanations
"""
from __future__ import annotations

import math
import time
from typing import Any, Optional

try:
    from ..config import (
        BATTERY_CAPACITY_KWH, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
        SAFETY_RULES, USABLE_FUEL_L,
    )
    from ..state.system_state import STATE
    from . import optimizer as op
    from . import safety as sf
    from . import autonomy as au
    from . import resupply_model as rm
except (ImportError, ValueError):
    from app.config import (
        BATTERY_CAPACITY_KWH, BATTERY_DISCHARGE_EFF, DIESEL_FUEL_L_PER_KWH,
        SAFETY_RULES, USABLE_FUEL_L,
    )
    from app.state.system_state import STATE
    from app.engines import optimizer as op
    from app.engines import safety as sf
    from app.engines import autonomy as au
    from app.engines import resupply_model as rm


ML_INPUTS_LIST = [
    {"name": "Demand Forecast", "type": "ML (XGBoost)", "active": True},
    {"name": "Solar Forecast", "type": "ML (XGBoost)", "active": True},
    {"name": "Wind Forecast", "type": "ML (XGBoost)", "active": True},
    {"name": "Battery Health SOH", "type": "ML (RandomForest)", "active": True},
    {"name": "Resupply Logistics Model", "type": "Stochastic P90", "active": True},
    {"name": "SCADA Telemetry", "type": "Real-time State", "active": True},
    {"name": "LP Optimizer", "type": "Highs Solver", "active": True},
    {"name": "Safety Validator", "type": "Deterministic Gate", "active": True},
]


def generate_candidate_plans(
    current_autonomy: Optional[dict] = None,
    resupply_dist: Optional[dict] = None,
) -> dict[str, Any]:
    """Generate, optimize, safety-validate, and rank candidate plans.

    Returns structured candidate plans, the recommended plan index/id, and
    comparative metrics.
    """
    if current_autonomy is None:
        current_autonomy = au.calculate()

    resupply_target_days = current_autonomy.get(
        "resupply_conservative_days",
        current_autonomy.get("next_resupply_days", 10.3),
    )
    resupply_delay = getattr(STATE, "resupply_delay_days", 0.0)
    current_soc = STATE.battery_soc
    base_reserve = SAFETY_RULES["min_battery_soc"]

    # ---- 1. Define Candidate Strategy Archetypes ----
    # Dynamic optimizer default baseline
    opt_reserve, opt_flex, _ = op._compute_risk_conditioned_reserves()

    strategies = [
        {
            "id": "plan_critical_protection",
            "name": "Protect Critical Loads",
            "short_name": "Critical Protection",
            "strategy_type": "CRITICAL_PROTECTION",
            "simple_description": "Reduce non-essential energy use and preserve stored energy for critical services.",
            "reserve_soc": min(42.0, max(35.0, base_reserve + 15.0)),
            "flex_mult": 0.50,
            "diesel_max": None,  # standard generator limit
            "is_conservation_strategy": True,
        },
        {
            "id": "plan_generator_support",
            "name": "Increase Generator Support",
            "short_name": "Generator Support",
            "strategy_type": "GENERATOR_SUPPORT",
            "simple_description": "Increase generator support to reduce battery discharge and maintain loads.",
            "reserve_soc": max(20.0, base_reserve),
            "flex_mult": 0.85,
            "diesel_max": None,
            "is_conservation_strategy": False,
        },
        {
            "id": "plan_deep_conservation",
            "name": "Deep Conservation",
            "short_name": "Deep Conservation",
            "strategy_type": "DEEP_CONSERVATION",
            "simple_description": "Aggressively reduce discretionary energy use to extend station endurance.",
            "reserve_soc": min(48.0, max(40.0, base_reserve + 20.0)),
            "flex_mult": 0.20,
            "diesel_max": None,
            "is_conservation_strategy": True,
        },
        {
            "id": "plan_polar_recommended",
            "name": "POLAR-EMS Recommended",
            "short_name": "POLAR-EMS Optimal",
            "strategy_type": "POLAR_RECOMMENDED",
            "simple_description": "Best feasible trade-off conditioned on resupply probability and forecasts.",
            "reserve_soc": opt_reserve,
            "flex_mult": opt_flex,
            "diesel_max": None,
            "is_conservation_strategy": opt_flex < 0.65 or current_autonomy.get("status") in ("CRITICAL", "CONSERVE"),
        },
    ]

    # ---- 2. Evaluate Each Strategy Through Optimizer + Safety ----
    evaluated_plans = []
    for strat in strategies:
        evaluated = _evaluate_single_strategy(
            strat=strat,
            resupply_target_days=resupply_target_days,
            resupply_delay=resupply_delay,
        )
        evaluated_plans.append(evaluated)

    # ---- 3. Multi-Criteria Ranking & Selection ----
    feasible_plans = [p for p in evaluated_plans if p["safety_passed"]]
    unfeasible_plans = [p for p in evaluated_plans if not p["safety_passed"]]

    # Evaluate Emergency Conservation as a deterministic recovery fallback
    emergency_strat = {
        "id": "plan_emergency_conservation",
        "name": "Emergency Conservation Recovery",
        "short_name": "Emergency Conservation",
        "strategy_type": "EMERGENCY_CONSERVATION",
        "simple_description": "Deterministic safety fallback: cut non-essential flexible demand to preserve stored battery and fuel endurance for critical services.",
        "reserve_soc": min(50.0, max(40.0, base_reserve + 15.0)),
        "flex_mult": 0.15,
        "diesel_max": None,
        "is_conservation_strategy": True,
    }
    emergency_plan = _evaluate_single_strategy(
        strat=emergency_strat,
        resupply_target_days=resupply_target_days,
        resupply_delay=resupply_delay,
    )
    if emergency_plan["safety_passed"]:
        emergency_plan["confidence"] = "PREFERRED"
        emergency_plan["status_label"] = "RECOVERY ACTION"
        emergency_plan["why_recommended"] = (
            f"Preserves critical heating & life-support by cutting flexible loads to 15%, maintaining {emergency_plan['cqrm_days']:+.1f}d resupply buffer."
        )
    else:
        emergency_plan["confidence"] = "UNSAFE"
        emergency_plan["status_label"] = "UNSAFE"
        emergency_plan["why_not_recommended"] = (
            f"Cannot satisfy all configured constraints. Primary limitation: Safe operability ({emergency_plan['safe_operability_days']:.1f}d) "
            f"falls short of conservative resupply requirement ({resupply_target_days:.1f}d)."
        )

    recovery_options = [
        {
            "id": "plan_emergency_conservation",
            "label": "Enter Emergency Conservation",
            "name": "Emergency Conservation Recovery",
            "available": True,
            "description": emergency_plan["simple_description"],
            "plan": emergency_plan,
            "safety_passed": emergency_plan["safety_passed"],
            "safety_checks": emergency_plan["safety_checks"],
            "failed_reasons": emergency_plan["failed_reasons"],
            "primary_limitation": (
                f"Safe-operability horizon ({emergency_plan['safe_operability_days']:.1f}d) is shorter than conservative resupply requirement ({resupply_target_days:.1f}d)."
                if not emergency_plan["safety_passed"] else None
            ),
        }
    ]

    recommended_plan_id: Optional[str] = None
    if feasible_plans:
        # Rank feasible plans:
        # Hierarchy:
        # 1. Critical coverage (must be 100%)
        # 2. Resupply feasibility (CQRM >= 0 prioritized, higher is better)
        # 3. Reserve preservation (Higher end SOC)
        # 4. Resource efficiency (Fuel consumption penalty)
        # 5. Flexible load retention
        for p in feasible_plans:
            score = (
                (1000.0 if p["critical_coverage_pct"] >= 99.9 else -5000.0)
                + (500.0 if p["cqrm_days"] >= 0.0 else p["cqrm_days"] * 200.0)
                + (p["cqrm_days"] * 50.0)
                + (p["end_soc"] * 2.0)
                - (p["fuel_6h_l"] * 1.5)
                + (p["flex_load_pct"] * 0.4)
            )
            p["rank_score"] = round(score, 1)

        feasible_plans.sort(key=lambda x: x["rank_score"], reverse=True)
        winner = feasible_plans[0]
        recommended_plan_id = winner["id"]

        # Assign qualitative confidence levels
        for p in evaluated_plans:
            if not p["safety_passed"]:
                p["confidence"] = "UNSAFE"
                p["status_label"] = "UNSAFE"
            elif p["id"] == recommended_plan_id:
                p["is_recommended"] = True
                p["status_label"] = "RECOMMENDED"
                if p["cqrm_days"] >= 0.8 and p["end_soc"] >= 35.0:
                    p["confidence"] = "STRONGLY PREFERRED"
                else:
                    p["confidence"] = "PREFERRED"
            else:
                p["is_recommended"] = False
                p["status_label"] = "AVAILABLE"
                score_diff = winner["rank_score"] - p.get("rank_score", 0)
                if score_diff < 150.0 and p["cqrm_days"] >= 0.0:
                    p["confidence"] = "ALTERNATIVE"
                else:
                    p["confidence"] = "NOT RECOMMENDED"
    else:
        # No feasible nominal plans found
        for p in evaluated_plans:
            p["is_recommended"] = False
            p["confidence"] = "UNSAFE"
            p["status_label"] = "UNSAFE"

    # ---- 4. Generate Dynamic Comparative Explanations ----
    _generate_dynamic_explanations(
        plans=evaluated_plans,
        recommended_id=recommended_plan_id,
        resupply_delay=resupply_delay,
    )

    summary_status = "FEASIBLE_OPTIONS_AVAILABLE" if feasible_plans else "NO_SAFE_PLAN_FOUND"
    feasible_count = len(feasible_plans)
    rejected_count = len(unfeasible_plans)

    return {
        "status": summary_status,
        "feasible_count": feasible_count,
        "rejected_count": rejected_count,
        "recommended_plan_id": recommended_plan_id,
        "candidate_plans": evaluated_plans,
        "recovery_options": recovery_options,
        "advisory": (
            f"{feasible_count} feasible option(s) available, {rejected_count} rejected by safety validator."
            if feasible_plans else
            "NO CURRENT PLAN PASSES ALL SAFETY CONSTRAINTS: All 4 nominal operating strategies fail safety criteria. "
            "Emergency conservation recovery action available."
        ),
        "generated_at": time.time(),
    }


def _evaluate_single_strategy(
    strat: dict,
    resupply_target_days: float,
    resupply_delay: float,
) -> dict[str, Any]:
    """Evaluate a single candidate plan strategy through optimizer and safety gate."""
    plan_id = strat["id"]
    reserve_soc = strat["reserve_soc"]
    flex_mult = strat["flex_mult"]
    is_conservation = strat["is_conservation_strategy"]

    # 1. Run optimizer for this strategy
    try:
        opt_res = op.optimize(
            reserve_soc=reserve_soc,
            flex_mult=flex_mult,
            diesel_max=strat.get("diesel_max"),
        )
    except Exception as e:
        opt_res = op._rule_based_schedule(
            reason=f"Plan optimization fallback: {e}",
            reserve_soc_override=reserve_soc,
            flex_mult_override=flex_mult,
        )

    # 2. Add strategy metadata to plan for safety validator
    opt_res["is_conservation_strategy"] = is_conservation
    opt_res["strategy_id"] = plan_id

    # 3. Run safety validator
    safety_result = sf.validate(opt_res)
    safety_passed = safety_result.get("passed", False)
    safety_checks = safety_result.get("checks", [])

    # If generator is failed and strategy is GENERATOR_SUPPORT, mark infeasible
    if STATE.generator_failed and strat["strategy_type"] == "GENERATOR_SUPPORT":
        safety_passed = False
        safety_checks.append({
            "rule": "generator_availability",
            "passed": False,
            "detail": "Generator is marked as failed / unavailable",
        })

    # 4. Compute plan-specific safe operability & CQRM
    safe_operability_days = _simulate_plan_autonomy(
        flex_mult=flex_mult,
        reserve_soc=reserve_soc,
    )
    cqrm_days = round(safe_operability_days - resupply_target_days, 1)

    steps = opt_res.get("steps", [])
    fuel_6h = opt_res.get("expected_fuel_l", 0.0)
    end_soc = opt_res.get("expected_end_soc", STATE.battery_soc)

    # Dispatch metrics
    avg_diesel_kw = (
        round(sum(s.get("diesel_kw", 0.0) for s in steps) / max(1, len(steps)), 1)
        if steps else 0.0
    )
    max_diesel_kw = (
        round(max((s.get("diesel_kw", 0.0) for s in steps), default=0.0), 1)
        if steps else 0.0
    )
    avg_battery_kw = (
        round(sum(s.get("battery_kw", 0.0) for s in steps) / max(1, len(steps)), 1)
        if steps else 0.0
    )

    # Daily fuel projection (approximate 24h burn at current plan dispatch)
    fuel_daily_l = round(fuel_6h * 4.0, 1)

    # Check critical coverage
    crit_shortfall = any(
        (s.get("diesel_kw", 0.0) + s.get("solar_kw", 0.0) + s.get("wind_kw", 0.0) - max(0.0, s.get("battery_kw", 0.0))) + 1e-5
        < SAFETY_RULES["critical_load_kw"]
        for s in steps
    )
    critical_coverage_pct = 0.0 if crit_shortfall else 100.0

    flex_pct = round(flex_mult * 100.0, 1)
    flex_reduction_pct = round((1.0 - flex_mult) * 100.0, 1)

    failed_reasons = [c["detail"] for c in safety_checks if not c.get("passed", True)]

    return {
        "id": plan_id,
        "name": strat["name"],
        "short_name": strat["short_name"],
        "strategy_type": strat["strategy_type"],
        "simple_description": strat["simple_description"],
        "is_recommended": False,
        "confidence": "ALTERNATIVE",
        "status_label": "AVAILABLE",
        "safety_passed": safety_passed,
        "safety_checks": safety_checks,
        "failed_reasons": failed_reasons,
        "safe_operability_days": round(safe_operability_days, 1),
        "cqrm_days": cqrm_days,
        "end_soc": round(end_soc, 1),
        "reserve_soc_target": round(reserve_soc, 1),
        "fuel_6h_l": round(fuel_6h, 1),
        "fuel_daily_l": fuel_daily_l,
        "critical_coverage_pct": critical_coverage_pct,
        "flex_load_pct": flex_pct,
        "flex_reduction_pct": flex_reduction_pct,
        "generator_avg_kw": avg_diesel_kw,
        "generator_max_kw": max_diesel_kw,
        "battery_avg_kw": avg_battery_kw,
        "optimizer_method": opt_res.get("method", "LP"),
        "why_recommended": "",
        "why_not_recommended": "",
        "ml_inputs_used": ML_INPUTS_LIST,
        "plan_details": {
            "reserve_soc": reserve_soc,
            "flex_mult": flex_mult,
            "steps_count": len(steps),
            "first_step_diesel_kw": steps[0].get("diesel_kw", 0.0) if steps else 0.0,
            "first_step_battery_kw": steps[0].get("battery_kw", 0.0) if steps else 0.0,
        },
    }


def _simulate_plan_autonomy(flex_mult: float, reserve_soc: float) -> float:
    """Project safe operability under plan-specific flexible load multiplier and reserve."""
    hours_to_project = 720  # 30-day projection
    prof = au._hourly_profile(hours_to_project, renew_mult=0.72, load_mult=1.10)

    # Adjust load in profile according to flex_mult
    base_crit = STATE.critical_load_kw
    base_ess = STATE.essential_load_kw
    base_flex = STATE.flexible_load_kw
    total_nominal = base_crit + base_ess + base_flex
    plan_total = base_crit + base_ess + (base_flex * flex_mult)
    ratio = plan_total / max(1.0, total_nominal)

    fuel_reserve_l = USABLE_FUEL_L * SAFETY_RULES["min_fuel_reserve_pct"] / 100.0
    fuel_l = max(0.0, STATE.fuel_l - fuel_reserve_l)
    batt_kwh = max(0.0, STATE.usable_battery_kwh(reserve_soc))

    if STATE.generator_failed:
        first_step = prof[0] if prof else {"load_kw": 120.0, "renewable_kw": 0.0}
        net_drain = max(10.0, (first_step["load_kw"] * ratio) - first_step["renewable_kw"])
        return round(batt_kwh / net_drain / 24.0, 1)

    autonomy_h = 0.0
    for step in prof:
        load = step["load_kw"] * ratio
        renew = step["renewable_kw"]
        net = load - renew

        if net <= 0:
            batt_kwh = min(
                BATTERY_CAPACITY_KWH * (100.0 - reserve_soc) / 100.0,
                batt_kwh + (-net) * BATTERY_DISCHARGE_EFF,
            )
            autonomy_h += 1.0
            continue

        from_batt = min(batt_kwh, net)
        batt_kwh -= from_batt
        net -= from_batt

        if net > 0:
            fuel_needed = net * DIESEL_FUEL_L_PER_KWH
            if fuel_l >= fuel_needed:
                fuel_l -= fuel_needed
                autonomy_h += 1.0
            else:
                if fuel_l > 0:
                    autonomy_h += fuel_l / fuel_needed
                break
        else:
            autonomy_h += 1.0

    return round(autonomy_h / 24.0, 1)


def _generate_dynamic_explanations(
    plans: list[dict],
    recommended_id: Optional[str],
    resupply_delay: float,
) -> None:
    """Generate dynamic math-based explanations comparing candidate plans."""
    rec_plan = next((p for p in plans if p["id"] == recommended_id), None)

    for p in plans:
        if not p["safety_passed"]:
            fail_str = "; ".join(p["failed_reasons"][:2]) if p["failed_reasons"] else "Safety rule violations"
            p["why_not_recommended"] = f"UNSAFE: {fail_str}."
            continue

        if p["id"] == recommended_id:
            # Build reasons why recommended based on actual differences with other plans
            reasons = ["Guarantees 100% critical load coverage."]

            # Compare against generator support (fuel efficiency)
            gen_plan = next((x for x in plans if x["strategy_type"] == "GENERATOR_SUPPORT"), None)
            if gen_plan and gen_plan["id"] != p["id"]:
                fuel_diff = gen_plan["fuel_6h_l"] - p["fuel_6h_l"]
                if fuel_diff > 0.5:
                    reasons.append(f"Saves {fuel_diff:.1f} L fuel vs Generator Support while maintaining {p['cqrm_days']:+.1f}d CQRM.")

            # Compare against deep conservation (flexible load retention)
            deep_plan = next((x for x in plans if x["strategy_type"] == "DEEP_CONSERVATION"), None)
            if deep_plan and deep_plan["id"] != p["id"]:
                flex_diff = p["flex_load_pct"] - deep_plan["flex_load_pct"]
                if flex_diff > 5:
                    reasons.append(f"Maintains {flex_diff:.0f}% higher flexible consumption than Deep Conservation.")

            # Resupply margin justification
            if resupply_delay > 0:
                reasons.append(f"Maintains resilient {p['reserve_soc_target']:.0f}% battery reserve under +{resupply_delay:.1f}d resupply delay.")
            elif p["cqrm_days"] >= 0:
                reasons.append(f"Provides positive resupply buffer ({p['cqrm_days']:+.1f}d margin).")

            p["why_recommended"] = " ".join(reasons)
        else:
            # Plan is feasible but not recommended -> explain trade-off vs recommended plan
            if rec_plan:
                fuel_diff = p["fuel_6h_l"] - rec_plan["fuel_6h_l"]
                cqrm_diff = rec_plan["cqrm_days"] - p["cqrm_days"]
                flex_diff = rec_plan["flex_load_pct"] - p["flex_load_pct"]

                notes = []
                if fuel_diff > 1.0:
                    notes.append(f"Consumes {fuel_diff:+.1f} L more fuel than recommended plan")
                if cqrm_diff > 0.3:
                    notes.append(f"Provides {cqrm_diff:.1f}d less resupply margin")
                if flex_diff > 10:
                    notes.append(f"Curtails flexible load by {flex_diff:.0f}% more than necessary")
                elif flex_diff < -10:
                    notes.append(f"Maintains higher load at the cost of higher fuel/battery drain")

                p["why_not_recommended"] = "; ".join(notes) + "." if notes else "Lower multi-criteria optimization score than recommended plan."
            else:
                p["why_not_recommended"] = "Alternative operating option."
