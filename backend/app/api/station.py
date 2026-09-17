from __future__ import annotations

import time
from fastapi import APIRouter

from ..state.system_state import STATE
from ..services.model_loader import get_model_loader

router = APIRouter(prefix="/station", tags=["station"])


@router.get("")
def station_overview() -> dict:
    snap = STATE.snapshot()
    bal = getattr(STATE, "_last_balance", {})
    if "heating_kw" not in bal:
        from ..sim.weather import heating_demand_kw
        bal["heating_kw"] = heating_demand_kw(
            STATE.weather.get("temperature_c", -18),
            STATE.weather.get("wind_speed_ms", 9))
    snap["balance"] = bal
    snap["autonomy"] = STATE.autonomy
    snap["latest_forecast"] = STATE.latest_forecast
    snap["safety"] = STATE.safety_result
    snap["awaiting_approval"] = STATE.awaiting_approval
    rec = STATE.recommendation or {}
    snap["recommendation"] = rec
    snap["recommendation_summary"] = rec.get("plan", {}).get("recommendation_summary", "")
    snap["what_changed"] = STATE.what_changed
    snap["before_after_replan"] = STATE.before_after_replan
    snap["demo_state"] = getattr(STATE, "demo_state", {})
    try:
        snap["intelligence"] = get_model_loader().get_intelligence_status()
    except Exception:
        snap["intelligence"] = {}
    return snap
