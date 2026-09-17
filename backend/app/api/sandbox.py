"""Sandbox API — Isolated Judge Experiment Room.

Phase 2: Provides endpoints for running isolated experiments, applying results
to the global station state, resetting to the canonical demo baseline, and
controlling the simulation clock.

Key design decisions (from user feedback):
  - sandbox_session_id isolates each judge/tab
  - experiment state NEVER mutates global state until APPLY
  - input provenance: every value carries 'source' (manual_override / model_prediction / etc.)
  - optimistic concurrency: apply checks state_version to prevent stale overwrites
  - DEMO_BASELINE is the single canonical reset target
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..state.system_state import STATE, DEMO_BASELINE
from .. import db
from ..engines.decision import run_pipeline
from ..engines import forecast as fc
from ..engines import autonomy as au
from ..engines import safety as sf

router = APIRouter(prefix="/sandbox", tags=["sandbox"])

# ---- In-memory experiment sessions (isolated per tab / judge) ----
_sessions: dict[str, dict[str, Any]] = {}


# ---------------------------------------------------------------- models ----

class ExperimentInput(BaseModel):
    """Inputs the judge can modify in the sandbox.

    Every field is optional — only supplied fields are treated as overrides.
    """
    sandbox_session_id: Optional[str] = None

    # Battery
    battery_soc: Optional[float] = Field(None, ge=0, le=100)
    battery_soh: Optional[float] = Field(None, ge=0, le=100)

    # Renewables
    solar_kw: Optional[float] = Field(None, ge=0, le=200)
    wind_kw: Optional[float] = Field(None, ge=0, le=200)

    # Demand
    station_load_kw: Optional[float] = Field(None, ge=30, le=500)
    critical_load_kw: Optional[float] = Field(None, ge=10, le=200)
    flexible_load_kw: Optional[float] = Field(None, ge=0, le=200)

    # Generator / Fuel
    fuel_l: Optional[float] = Field(None, ge=0, le=15000)
    generator_available: Optional[bool] = None

    # Logistics
    resupply_delay_days: Optional[float] = Field(None, ge=0, le=14)

    # Connectivity
    communication_loss: Optional[bool] = None

    # Temperature
    temperature_c: Optional[float] = Field(None, ge=-60, le=30)


class ApplyRequest(BaseModel):
    sandbox_session_id: str
    state_version: int  # optimistic concurrency check
    selected_plan_id: Optional[str] = None


class ResetRequest(BaseModel):
    sandbox_session_id: Optional[str] = None


# ---------------------------------------------------------------- helpers ---

def _get_or_create_session(session_id: Optional[str]) -> tuple[str, dict]:
    """Get an existing session or create a new one from current global state."""
    if session_id and session_id in _sessions:
        return session_id, _sessions[session_id]

    sid = session_id or str(uuid.uuid4())
    _sessions[sid] = {
        "session_id": sid,
        "created_at": time.time(),
        "baseline_state_version": STATE.state_version,
        "overrides": {},         # {field: {value, source}}
        "last_result": None,
        "selected_plan_id": None,
    }
    return sid, _sessions[sid]


def _build_experiment_state(overrides: dict[str, dict]) -> dict[str, Any]:
    """Build a snapshot of what the station would look like with overrides applied."""
    # Start from current global state
    state = {
        "battery_soc": STATE.battery_soc,
        "battery_soh": STATE.battery_soh,
        "fuel_l": STATE.fuel_l,
        "critical_load_kw": STATE.critical_load_kw,
        "essential_load_kw": STATE.essential_load_kw,
        "flexible_load_kw": STATE.flexible_load_kw,
        "generator_failed": STATE.generator_failed,
        "resupply_delay_days": STATE.resupply_delay_days,
        "internet_online": STATE.internet_online,
        "temperature_c": STATE.weather.get("temperature_c", -18.0),
        "wind_speed_ms": STATE.weather.get("wind_speed_ms", 9.0),
        "solar_irradiance_wm2": STATE.weather.get("solar_irradiance_wm2", 150.0),
    }

    # Apply overrides
    for field, info in overrides.items():
        if field in state:
            state[field] = info["value"]

    return state


def _run_experiment_pipeline(exp_state: dict, overrides: dict) -> dict[str, Any]:
    """Run the full decision pipeline with experiment state (without mutating global STATE).

    Temporarily applies overrides to STATE, runs pipeline, then restores.
    This is safe because we hold STATE.lock for the entire operation.
    """
    with STATE.lock:
        # Save original values
        originals = {}
        field_to_state_attr = {
            "battery_soc": "battery_soc",
            "battery_soh": "battery_soh",
            "fuel_l": "fuel_l",
            "critical_load_kw": "critical_load_kw",
            "essential_load_kw": "essential_load_kw",
            "flexible_load_kw": "flexible_load_kw",
            "generator_failed": "generator_failed",
            "resupply_delay_days": "resupply_delay_days",
            "internet_online": "internet_online",
        }
        weather_fields = {"temperature_c", "wind_speed_ms", "solar_irradiance_wm2"}

        # Snapshot originals
        for field, attr in field_to_state_attr.items():
            originals[attr] = getattr(STATE, attr)
        originals["weather"] = dict(STATE.weather)

        try:
            # Apply experiment state to STATE temporarily
            for field, attr in field_to_state_attr.items():
                if field in exp_state:
                    setattr(STATE, attr, exp_state[field])

            # Weather fields
            for wf in weather_fields:
                if wf in exp_state:
                    STATE.weather[wf] = exp_state[wf]

            # Run the pipeline engines (forecast -> autonomy -> optimizer -> safety -> plan_generator)
            forecast_result = fc.forecast()
            autonomy_result = au.calculate()

            from ..engines import optimizer as op
            from ..engines import plan_generator as pg

            plan = op.optimize()
            safety_result = sf.validate(plan)

            # Generate and rank genuine candidate operating plans
            plan_gen_result = pg.generate_candidate_plans(
                current_autonomy=autonomy_result,
            )

            # Build execution trace
            execution_trace = _build_execution_trace(overrides, plan_gen_result)

            result = {
                "experiment_state": exp_state,
                "autonomy": autonomy_result,
                "plan": plan,
                "safety": safety_result,
                "candidate_plans": plan_gen_result["candidate_plans"],
                "recovery_options": plan_gen_result.get("recovery_options", []),
                "recommended_plan_id": plan_gen_result["recommended_plan_id"],
                "plan_generation_status": plan_gen_result["status"],
                "feasible_count": plan_gen_result["feasible_count"],
                "rejected_count": plan_gen_result["rejected_count"],
                "plans_advisory": plan_gen_result["advisory"],
                "forecast_summary": {
                    "load_24h": forecast_result["targets"]["load_kw"]["steps"].get("24", {}),
                    "solar_24h": forecast_result["targets"]["solar_kw"]["steps"].get("24", {}),
                    "wind_24h": forecast_result["targets"]["wind_kw"]["steps"].get("24", {}),
                },
                "execution_trace": execution_trace,
                "calculated_at": time.time(),
                "state_version": STATE.state_version,
            }

            return result

        finally:
            # ALWAYS restore original state (critical for isolation)
            for attr, value in originals.items():
                if attr == "weather":
                    STATE.weather = value
                else:
                    setattr(STATE, attr, value)


def _build_execution_trace(overrides: dict, plan_gen_result: dict) -> list[dict]:
    """Build the decision trace showing the causal chain."""
    trace = []

    # Which inputs changed
    changed_inputs = [f for f in overrides.keys()]
    trace.append({
        "step": "INPUT_CHANGED",
        "status": "complete",
        "detail": f"{len(changed_inputs)} input(s) modified: {', '.join(changed_inputs)}" if changed_inputs else "Baseline inputs evaluated",
    })

    trace.append({"step": "FORECAST_UPDATED", "status": "complete", "detail": "Demand, solar, wind forecasts recalculated"})
    trace.append({"step": "RISK_UPDATED", "status": "complete", "detail": "Failure probability recalculated"})
    trace.append({"step": "RESUPPLY_UPDATED", "status": "complete", "detail": "Resupply distribution updated"})
    trace.append({"step": "SAFE_OPERABILITY_UPDATED", "status": "complete", "detail": "Conservative/expected/optimistic horizons recalculated"})
    trace.append({"step": "CQRM_UPDATED", "status": "complete", "detail": "CQRM margin recomputed"})

    cand_count = len(plan_gen_result.get("candidate_plans", []))
    feas_count = plan_gen_result.get("feasible_count", 0)
    rej_count = plan_gen_result.get("rejected_count", 0)
    trace.append({
        "step": "PLANS_GENERATED",
        "status": "complete",
        "detail": f"{cand_count} candidates evaluated — {feas_count} feasible, {rej_count} unsafe",
    })
    trace.append({
        "step": "SAFETY_VALIDATED",
        "status": "complete" if feas_count > 0 else "failed",
        "detail": f"Deterministic safety checks: {feas_count} passed, {rej_count} rejected",
    })

    rec_id = plan_gen_result.get("recommended_plan_id")
    if rec_id:
        rec_plan = next((p for p in plan_gen_result.get("candidate_plans", []) if p["id"] == rec_id), None)
        plan_title = rec_plan["name"] if rec_plan else "POLAR-EMS Candidate"
        trace.append({
            "step": "RECOMMENDATION_RANKED",
            "status": "complete",
            "detail": f"Multi-criteria ranking selected '{plan_title}' as POLAR-EMS Recommendation",
        })
    else:
        trace.append({
            "step": "RECOMMENDATION_RANKED",
            "status": "failed",
            "detail": f"0 safe nominal plans found; Emergency Conservation recovery path activated",
        })

    return trace


def _build_input_provenance(overrides: dict, exp_state: dict) -> dict[str, dict]:
    """Build provenance map showing where each input value came from."""
    provenance = {}
    all_fields = [
        "battery_soc", "battery_soh", "fuel_l", "critical_load_kw",
        "essential_load_kw", "flexible_load_kw", "generator_failed",
        "resupply_delay_days", "internet_online", "temperature_c",
        "wind_speed_ms", "solar_irradiance_wm2",
    ]

    for field in all_fields:
        if field in overrides:
            provenance[field] = {
                "value": overrides[field]["value"],
                "source": "manual_override",
                "label": "Judge Experiment",
            }
        elif field in exp_state:
            provenance[field] = {
                "value": exp_state[field],
                "source": "simulation_state",
                "label": "Current Simulation",
            }

    return provenance


# ---------------------------------------------------------------- endpoints ---

@router.post("/experiment")
def run_experiment(req: ExperimentInput) -> dict:
    """Run an isolated experiment with the given overrides.

    Does NOT mutate global state. Returns the full decision chain and candidate plans.
    """
    session_id, session = _get_or_create_session(req.sandbox_session_id)

    # Build overrides from request
    override_fields = {
        "battery_soc": req.battery_soc,
        "battery_soh": req.battery_soh,
        "fuel_l": req.fuel_l,
        "critical_load_kw": req.critical_load_kw,
        "flexible_load_kw": req.flexible_load_kw,
        "generator_failed": not req.generator_available if req.generator_available is not None else None,
        "resupply_delay_days": req.resupply_delay_days,
        "internet_online": not req.communication_loss if req.communication_loss is not None else None,
        "temperature_c": req.temperature_c,
    }

    # Handle solar/wind as weather overrides
    if req.solar_kw is not None:
        override_fields["solar_irradiance_wm2"] = req.solar_kw * 8.33  # approx W/m2 per kW
    if req.wind_kw is not None:
        override_fields["wind_speed_ms"] = req.wind_kw / 16.67  # approx m/s per kW

    # Handle station_load_kw -> splits across load types
    if req.station_load_kw is not None:
        ratio = req.station_load_kw / max(1, STATE.total_load_kw())
        override_fields["essential_load_kw"] = STATE.essential_load_kw * ratio
        override_fields["flexible_load_kw"] = STATE.flexible_load_kw * ratio

    # Store only non-None overrides with provenance
    new_overrides = {}
    for field, value in override_fields.items():
        if value is not None:
            new_overrides[field] = {"value": value, "source": "manual_override"}

    # Merge with existing session overrides (new values win)
    session["overrides"].update(new_overrides)

    # Build experiment state and run pipeline
    exp_state = _build_experiment_state(session["overrides"])
    result = _run_experiment_pipeline(exp_state, session["overrides"])

    # Build baseline comparison
    baseline_state = {
        "battery_soc": STATE.battery_soc,
        "battery_soh": STATE.battery_soh,
        "fuel_l": STATE.fuel_l,
        "safe_operability_days": STATE.autonomy.get("safe_autonomy_days", 0),
        "cqrm_days": STATE.autonomy.get("cqrm_margin_days", 0),
        "risk_level": STATE.autonomy.get("status", "SAFE"),
        "reserve_target": STATE.autonomy.get("assumptions", {}).get("min_battery_soc_reserve_pct", 30),
        "resupply_delay_days": STATE.resupply_delay_days,
    }

    experiment_summary = {
        "battery_soc": exp_state.get("battery_soc"),
        "battery_soh": exp_state.get("battery_soh"),
        "fuel_l": exp_state.get("fuel_l"),
        "safe_operability_days": result["autonomy"].get("safe_autonomy_days", 0),
        "cqrm_days": result["autonomy"].get("cqrm_margin_days", 0),
        "risk_level": result["autonomy"].get("status", "SAFE"),
        "reserve_target": result["plan"].get("reserve_soc_target", 30),
        "resupply_delay_days": exp_state.get("resupply_delay_days", 0),
    }

    # Input provenance
    provenance = _build_input_provenance(session["overrides"], exp_state)

    # Recommendation
    autonomy_status = result["autonomy"].get("status", "SAFE")
    cqrm = result["autonomy"].get("cqrm_margin_days", 0)

    if autonomy_status == "CRITICAL":
        recommendation = "EMERGENCY CONSERVATION"
        reason = f"CQRM margin is {cqrm:+.1f} days. Station cannot sustain until resupply without immediate conservation."
    elif autonomy_status == "CONSERVE":
        recommendation = "CONSERVE"
        reason = f"CQRM margin constrained ({cqrm:+.1f} days). Flexible load reduction required."
    elif autonomy_status == "CAUTION":
        recommendation = "CAUTION"
        reason = f"Narrow resupply margin ({cqrm:+.1f} days). Precautionary conservation advised."
    else:
        recommendation = "NORMAL OPERATIONS"
        reason = f"Safe operability comfortably exceeds resupply ETA with +{cqrm:.1f}d margin."

    session["last_result"] = result
    session["selected_plan_id"] = result.get("recommended_plan_id")

    # Log the experiment
    db.log_event(
        source="sandbox",
        event="Experiment executed",
        detail=f"Session {session_id[:8]}; overrides: {list(session['overrides'].keys())}; result: {autonomy_status}; recommended_plan: {result.get('recommended_plan_id')}",
        status="ok",
    )

    return {
        "sandbox_session_id": session_id,
        "baseline": baseline_state,
        "experiment": experiment_summary,
        "recommendation": recommendation,
        "reason": reason,
        "safety": result["safety"],
        "autonomy": result["autonomy"],
        "candidate_plans": result["candidate_plans"],
        "recovery_options": result.get("recovery_options", []),
        "recommended_plan_id": result["recommended_plan_id"],
        "selected_plan_id": session["selected_plan_id"],
        "feasible_count": result["feasible_count"],
        "rejected_count": result["rejected_count"],
        "plans_advisory": result["plans_advisory"],
        "plan_summary": {
            "method": result["plan"].get("method", "unknown"),
            "expected_fuel_l": result["plan"].get("expected_fuel_l", 0),
            "reserve_soc_target": result["plan"].get("reserve_soc_target", 30),
            "flexible_load_pct": result["plan"].get("flexible_load_pct", 100),
        },
        "input_provenance": provenance,
        "execution_trace": result["execution_trace"],
        "state_version": result["state_version"],
        "calculated_at": result["calculated_at"],
    }


class SelectPlanRequest(BaseModel):
    sandbox_session_id: str
    plan_id: str


@router.post("/select-plan")
def select_plan(req: SelectPlanRequest) -> dict:
    """Select a candidate plan or recovery option in the active sandbox session."""
    if req.sandbox_session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Sandbox session not found")
    session = _sessions[req.sandbox_session_id]
    session["selected_plan_id"] = req.plan_id
    return {"selected_plan_id": req.plan_id}


@router.post("/apply")
def apply_experiment(req: ApplyRequest) -> dict:
    """Apply an experiment result as the new global station state.

    Implements optimistic concurrency: rejects if state_version has changed
    since the experiment was run.
    """
    if req.sandbox_session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Sandbox session not found")

    session = _sessions[req.sandbox_session_id]
    if not session.get("last_result"):
        raise HTTPException(status_code=400, detail="No experiment result to apply. Run an experiment first.")

    # Optimistic concurrency check
    current_version = STATE.state_version
    if req.state_version != current_version:
        raise HTTPException(
            status_code=409,
            detail=f"STATE_CHANGED: Expected version {req.state_version}, current is {current_version}. "
                   f"Re-run the experiment with current state before applying."
        )

    # Check selected plan if provided (look in candidate_plans or recovery_options)
    selected_plan_id = req.selected_plan_id or session.get("selected_plan_id")
    candidate_plans = session["last_result"].get("candidate_plans", [])
    recovery_options = session["last_result"].get("recovery_options", [])

    selected_plan = next((p for p in candidate_plans if p["id"] == selected_plan_id), None)
    if not selected_plan:
        rec_opt = next((r for r in recovery_options if r["id"] == selected_plan_id or r.get("plan", {}).get("id") == selected_plan_id), None)
        if rec_opt:
            selected_plan = rec_opt.get("plan")

    if selected_plan and not selected_plan.get("safety_passed", True):
        # If it's an emergency conservation recovery action that cannot satisfy all constraints,
        # we still allow applying emergency conservation to enter conservation mode, but log it explicitly.
        if selected_plan.get("strategy_type") != "EMERGENCY_CONSERVATION":
            raise HTTPException(
                status_code=400,
                detail="UNSAFE_PLAN: The selected nominal plan was rejected by the safety validator and cannot be applied. Please select Emergency Conservation recovery action.",
            )

    # Build updates dict from overrides
    updates: dict[str, Any] = {}
    weather_updates: dict[str, Any] = {}
    weather_fields = {"temperature_c", "wind_speed_ms", "solar_irradiance_wm2"}

    for field, info in session["overrides"].items():
        if field in weather_fields:
            weather_updates[field] = info["value"]
        else:
            updates[field] = info["value"]

    # Apply weather as merged dict
    if weather_updates:
        new_weather = dict(STATE.weather)
        new_weather.update(weather_updates)
        updates["weather"] = new_weather

    # If a conservation plan is applied, set operating mode accordingly
    plan_name = selected_plan.get("name", "Default Recommendation") if selected_plan else "Default Recommendation"
    if selected_plan:
        strat_type = selected_plan.get("strategy_type", "")
        if strat_type in ("DEEP_CONSERVATION", "CRITICAL_PROTECTION"):
            updates["mode"] = "ENERGY_CONSERVATION"
        elif strat_type == "GENERATOR_SUPPORT":
            updates["mode"] = "NORMAL"
        updates["active_plan_name"] = plan_name

    # Atomic update
    new_version = STATE.apply_atomic_update(updates)

    # Re-run the full pipeline with the new global state
    pipeline_result = run_pipeline("sandbox_apply")
    if selected_plan:
        with STATE.lock:
            STATE.active_plan_name = plan_name

    # Log the apply action
    db.log_event(
        source="sandbox",
        event="Experiment and Plan applied to global state",
        detail=f"Session {req.sandbox_session_id[:8]}; Plan: {plan_name}; new version {new_version}; overrides: {list(session['overrides'].keys())}",
        status="ok",
    )

    # Clear session overrides after apply
    session["overrides"] = {}
    session["last_result"] = None
    session["selected_plan_id"] = None

    return {
        "applied": True,
        "applied_plan": {
            "id": selected_plan.get("id") if selected_plan else None,
            "name": plan_name,
            "simple_description": selected_plan.get("simple_description") if selected_plan else "Plan applied",
        },
        "state_version": new_version,
        "scenario_id": STATE.scenario_id,
        "calculated_at": STATE.calculated_at,
        "pipeline_result": {
            "status": pipeline_result.get("status", "unknown"),
            "autonomy_status": pipeline_result.get("autonomy", {}).get("status", "SAFE"),
            "cqrm_days": pipeline_result.get("autonomy", {}).get("cqrm_margin_days", 0),
            "safety_passed": pipeline_result.get("safety", {}).get("passed", True),
        },
    }


@router.post("/reset")
def reset_to_baseline(req: ResetRequest) -> dict:
    """Reset the entire station to the canonical DEMO_BASELINE.

    Does NOT erase audit history. Logs the reset event.
    """
    # Reset global state
    new_version = STATE.reset_to_baseline()

    # Re-run the full pipeline with baseline state
    pipeline_result = run_pipeline("demo_baseline_reset")

    # Force mode to NORMAL after pipeline (baseline is definitionally nominal)
    with STATE.lock:
        STATE.mode = "NORMAL"
        STATE.mode_auto = True

    # Clear the session if one was provided
    if req.sandbox_session_id and req.sandbox_session_id in _sessions:
        del _sessions[req.sandbox_session_id]

    # Log the reset
    db.log_event(
        source="sandbox",
        event="DEMO BASELINE RESET",
        detail=f"Station restored to canonical baseline. New version {new_version}.",
        status="ok",
    )

    return {
        "reset": True,
        "state_version": new_version,
        "scenario_id": STATE.scenario_id,
        "calculated_at": STATE.calculated_at,
        "baseline": DEMO_BASELINE,
    }


@router.post("/clock")
def toggle_simulation_clock() -> dict:
    """Toggle simulation_paused (RUNNING vs PAUSED)."""
    with STATE.lock:
        STATE.simulation_paused = not STATE.simulation_paused
        paused = STATE.simulation_paused

    status = "PAUSED" if paused else "RUNNING"
    db.log_event(
        source="sandbox",
        event=f"Simulation clock {status}",
        detail=f"Simulation {'paused' if paused else 'resumed'} by operator.",
        status="ok",
    )

    return {
        "simulation_paused": paused,
        "status": status,
        "state_version": STATE.state_version,
    }


@router.get("/session/{session_id}")
def get_session(session_id: str) -> dict:
    """Get the current state of a sandbox session."""
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Sandbox session not found")

    session = _sessions[session_id]
    return {
        "sandbox_session_id": session["session_id"],
        "created_at": session["created_at"],
        "baseline_state_version": session["baseline_state_version"],
        "overrides": session["overrides"],
        "has_result": session["last_result"] is not None,
    }


@router.get("/baseline")
def get_baseline() -> dict:
    """Return the canonical DEMO_BASELINE for reference."""
    return {
        "baseline": DEMO_BASELINE,
        "current_state_version": STATE.state_version,
        "simulation_paused": STATE.simulation_paused,
    }
