"""Alert engine.

Alerts are generated from actual system conditions — never arbitrary.
"""
from __future__ import annotations

import time

try:
    from .. import db
    from ..config import SAFETY_RULES, EMERGENCY_FUEL_PCT, USABLE_FUEL_L
    from ..state.system_state import STATE
except (ImportError, ValueError):
    from app import db
    from app.config import SAFETY_RULES, EMERGENCY_FUEL_PCT, USABLE_FUEL_L
    from app.state.system_state import STATE

_active: dict[str, dict] = {}


def _raise(code: str, severity: str, title: str, message: str) -> None:
    if code in _active:
        return
    alert_id = db.insert("alerts", ts=time.time(), severity=severity, code=code,
                         title=title, message=message, acknowledged=0, active=1)
    _active[code] = {"id": alert_id, "ts": time.time()}
    db.log_event(source="alerts", event=title, detail=message, status=severity.lower())


def clear(code: str) -> None:
    if code in _active:
        db.execute("UPDATE alerts SET active=0 WHERE code=? AND active=1", (code,))
        del _active[code]


def evaluate() -> None:
    """Run all condition checks against the live state."""
    a = STATE.autonomy or {}
    margin = a.get("autonomy_margin_days")
    fuel_pct = STATE.fuel_pct()

    if margin is not None and margin < 0:
        _raise("AUTONOMY_BELOW_RESUPPLY", "CRITICAL",
               "SAFE AUTONOMY BELOW RESUPPLY HORIZON",
               f"Autonomy {a['safe_autonomy_days']} d vs resupply in {a['next_resupply_days']} d (margin {margin:+.1f} d).")
    else:
        clear("AUTONOMY_BELOW_RESUPPLY")

    if margin is not None and 0 <= margin < 2.0:
        _raise("RESUPPLY_RISK", "WARNING", "RESUPPLY RISK — LOW AUTONOMY MARGIN",
               f"Autonomy margin {margin:+.1f} d below 2 d comfort threshold.")
    else:
        clear("RESUPPLY_RISK")

    if fuel_pct < SAFETY_RULES["min_fuel_reserve_pct"]:
        sev = "EMERGENCY" if fuel_pct < EMERGENCY_FUEL_PCT else "CRITICAL"
        _raise("LOW_FUEL", sev, "LOW FUEL RESERVE",
               f"Fuel at {fuel_pct:.1f}% of usable capacity.")
    else:
        clear("LOW_FUEL")

    if STATE.battery_soc < SAFETY_RULES["min_battery_soc"] + 3:
        _raise("BATTERY_RESERVE", "WARNING", "BATTERY RESERVE APPROACHING",
               f"SOC {STATE.battery_soc:.1f}% approaching {SAFETY_RULES['min_battery_soc']}% reserve floor.")
    else:
        clear("BATTERY_RESERVE")

    if STATE.generator_failed:
        _raise("GEN_FAILURE", "EMERGENCY", "GENERATOR FAILURE",
               "Diesel generator unavailable — recalculating autonomy without diesel backup.")
    else:
        clear("GEN_FAILURE")

    if not STATE.internet_online:
        _raise("INTERNET_LOST", "INFO", "INTERNET CONNECTION LOST",
               "Cloud services unavailable. Local operation continuing — all core engines active.")
    else:
        clear("INTERNET_LOST")

    if STATE.weather["wind_speed_ms"] > 15 or STATE.weather["condition"] in ("storm", "blizzard"):
        _raise("RENEWABLE_UNCERTAINTY", "WARNING", "RENEWABLE FORECAST UNCERTAINTY HIGH",
               f"Wind {STATE.weather['wind_speed_ms']} m/s, condition {STATE.weather['condition']}. "
               "Reserves widened, battery discharge limited.")
    else:
        clear("RENEWABLE_UNCERTAINTY")

    if STATE.weather["temperature_c"] < -25:
        _raise("HIGH_HEATING", "WARNING", "HIGH HEATING DEMAND EXPECTED",
               f"Temperature {STATE.weather['temperature_c']}°C — heating demand rising, load forecast updated.")
    else:
        clear("HIGH_HEATING")

    if not STATE.safety_result.get("passed", True):
        _raise("SAFETY_REJECTED", "CRITICAL", "SAFETY PLAN REJECTED",
               "Latest optimization plan failed safety validation; safe fallback active.")
    else:
        clear("SAFETY_REJECTED")


def list_alerts(active_only: bool = True) -> list[dict]:
    if active_only:
        rows = db.query("SELECT * FROM alerts WHERE active=1 ORDER BY ts DESC")
    else:
        rows = db.query("SELECT * FROM alerts ORDER BY ts DESC LIMIT 200")
    # Deduplicate by code: group with occurrence count
    seen: dict[str, dict] = {}
    for r in rows:
        code = r.get("code", "")
        if code in seen:
            seen[code]["occurrences"] = seen[code].get("occurrences", 1) + 1
        else:
            r["occurrences"] = 1
            seen[code] = r
    return list(seen.values())


def acknowledge(alert_id: int) -> None:
    db.execute("UPDATE alerts SET acknowledged=1 WHERE id=?", (alert_id,))
