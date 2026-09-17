"""Data ingestion layer.

Simulates an MQTT bus with the standard topic set; the same interface
accepts REST pushes, local feeds and CSV so real sensors can replace the
simulator later without touching downstream engines.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Any, Callable, Optional

try:
    from ..state.system_state import STATE
except (ImportError, ValueError):
    from app.state.system_state import STATE

TOPICS = [
    "station/power/load",
    "station/weather/temperature",
    "station/weather/wind",
    "station/weather/solar",
    "station/battery/soc",
    "station/battery/soh",
    "station/fuel/level",
    "station/generator/status",
    "station/generator/output",
]

_subscribers: dict[str, list[Callable[[str, Any], None]]] = {t: [] for t in TOPICS}
_recent: deque = deque(maxlen=500)
_health: dict[str, dict] = {t: {"last_ts": None, "msgs": 0, "status": "waiting"} for t in TOPICS}


def publish(topic: str, payload: Any) -> None:
    """Publish a message on the simulated bus and update topic health."""
    msg = {"topic": topic, "payload": payload, "ts": time.time()}
    _recent.append(msg)
    if topic in _health:
        h = _health[topic]
        h["last_ts"] = msg["ts"]
        h["msgs"] += 1
        h["status"] = "connected"
    for cb in _subscribers.get(topic, []):
        try:
            cb(topic, payload)
        except Exception:
            pass


def subscribe(topic: str, callback: Callable[[str, Any], None]) -> None:
    if topic in _subscribers:
        _subscribers[topic].append(callback)


def health() -> dict:
    now = time.time()
    out = []
    for t, h in _health.items():
        stale = h["last_ts"] is not None and (now - h["last_ts"]) > 30
        status = "stale" if stale else h["status"]
        out.append({
            "topic": t,
            "status": status,
            "messages": h["msgs"],
            "last_message_age_s": round(now - h["last_ts"], 1) if h["last_ts"] else None,
        })
    return {"mqtt_connected": STATE.mqtt_connected, "topics": out,
            "total_messages": sum(h["msgs"] for h in _health.values())}


def recent_messages(limit: int = 50) -> list:
    return list(_recent)[-limit:]


def ingest_csv(rows: list[dict]) -> int:
    """Accept CSV rows of historical readings: ts,sensor,value."""
    from .. import db
    clean = []
    for r in rows:
        try:
            clean.append({"ts": float(r["ts"]), "sensor": str(r["sensor"]),
                          "value": float(r["value"]), "unit": r.get("unit", ""),
                          "quality": 0.8, "source": "csv"})
        except (KeyError, ValueError, TypeError):
            continue
    if clean:
        db.insert_many("sensor_readings", clean)
    return len(clean)


def ingest_rest(sensor: str, value: float, unit: str = "", ts: Optional[float] = None) -> dict:
    from .. import db
    ts = ts or time.time()
    db.insert("sensor_readings", ts=ts, sensor=sensor, value=value,
              unit=unit, quality=0.8, source="rest")
    publish(f"station/external/{sensor}", value)
    return {"accepted": True, "sensor": sensor, "value": value}
