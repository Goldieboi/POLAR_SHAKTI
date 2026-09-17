from __future__ import annotations

import time

from fastapi import APIRouter

from .. import db
from ..state.system_state import STATE
from ..engines.decision import run_pipeline
from ..engines.baseline import compare as baseline_compare

router = APIRouter(prefix="/optimization", tags=["optimization"])


@router.api_route("/latest", methods=["GET", "POST"])
def latest() -> dict:
    return STATE.recommendation or run_pipeline("api-request")


@router.api_route("/run", methods=["GET", "POST"])
def run() -> dict:
    return run_pipeline("operator-requested")


@router.api_route("/baseline-comparison", methods=["GET", "POST"])
def baseline_comparison() -> dict:
    """Compare Baseline (naive) vs POLAR-EMS (optimized) on the same state."""
    return baseline_compare()


@router.api_route("/approve", methods=["GET", "POST"])
def approve() -> dict:
    with STATE.lock:
        STATE.awaiting_approval = False
        if STATE.recommendation:
            STATE.approved_plan = STATE.recommendation.get("plan", {})
            STATE.recommendation["status"] = "approved"
            STATE.recommendation["awaiting_approval"] = False
    db.insert("operator_actions", ts=time.time(), actor="operator",
              action="approve_plan", params_json=db.j({"status": STATE.recommendation.get("status") if STATE.recommendation else "approved"}))
    db.log_event("operator", "Recommendation APPROVED", "Plan applied to simulation dispatch", "ok")
    return {"approved": True, "status": "approved", "timestamp": time.time()}


@router.api_route("/reject", methods=["GET", "POST"])
def reject() -> dict:
    with STATE.lock:
        STATE.awaiting_approval = False
        STATE.approved_plan = {}
        if STATE.recommendation:
            STATE.recommendation["status"] = "rejected"
            STATE.recommendation["awaiting_approval"] = False
    db.insert("operator_actions", ts=time.time(), actor="operator",
              action="reject_plan", params_json="{}")
    db.log_event("operator", "Recommendation REJECTED", "Reverting to automatic dispatch", "info")
    return {"approved": False, "status": "rejected", "timestamp": time.time()}


@router.api_route("/fallback", methods=["GET", "POST"])
def fallback() -> dict:
    """Generate and apply deterministic safe fallback conservation plan."""
    from ..engines.optimizer import _rule_based_schedule
    from ..engines.safety import validate as validate_safety
    
    with STATE.lock:
        prev_plan = dict(STATE.approved_plan) if STATE.approved_plan else (STATE.recommendation.get("plan", {}) if STATE.recommendation else {})
        fb_plan = _rule_based_schedule(reason="operator-triggered safe fallback")
        sv = validate_safety(fb_plan)
        
        STATE.scenario["conserve"] = True
        STATE.approved_plan = fb_plan
        
        # Calculate concrete deltas
        prev_steps = prev_plan.get("steps", [])
        fb_steps = fb_plan.get("steps", [])
        
        prev_gen = prev_steps[0]["diesel_kw"] if prev_steps else 0.0
        fb_gen = fb_steps[0]["diesel_kw"] if fb_steps else 0.0
        
        prev_batt = prev_steps[0]["battery_kw"] if prev_steps else 0.0
        fb_batt = fb_steps[0]["battery_kw"] if fb_steps else 0.0
        
        prev_fuel = prev_plan.get("expected_fuel_l", 0.0)
        fb_fuel = fb_plan.get("expected_fuel_l", 0.0)
        
        prev_reserve = prev_plan.get("required_reserve_soc_pct", 30.0)
        fb_reserve = fb_plan.get("required_reserve_soc_pct", 35.0)

        delta = {
            "generator_kw": {"from": round(prev_gen, 1), "to": round(fb_gen, 1)},
            "battery_kw": {"from": round(prev_batt, 1), "to": round(fb_batt, 1)},
            "fuel_projection_l": {"from": round(prev_fuel, 1), "to": round(fb_fuel, 1)},
            "reserve_soc_pct": {"from": round(prev_reserve, 1), "to": round(fb_reserve, 1)},
        }
        
        rec = {
            "plan": fb_plan,
            "safety": sv,
            "status": "conservation fallback active",
            "delta": delta,
            "awaiting_approval": False,
        }
        STATE.recommendation = rec

    db.insert("operator_actions", ts=time.time(), actor="operator",
              action="trigger_fallback", params_json=db.j(delta))
    db.log_event("operator", "Safe Fallback ACTIVATED", f"Conservation mode; Gen: {delta['generator_kw']['to']} kW", "warning")
    return rec


