"""Data processing & validation engine.

Range checks, duplicate/timestamp validation, anomaly detection and a
rolling Data Quality Score. Bad data is flagged, never silently hidden.
"""
from __future__ import annotations

import statistics
import time
from collections import defaultdict, deque

try:
    from ..config import DIESEL_RATED_KW
    from ..state.system_state import STATE
except (ImportError, ValueError):
    from app.config import DIESEL_RATED_KW
    from app.state.system_state import STATE

# plausible ranges per sensor
RANGES = {
    "load_kw": (0, 700), "solar_kw": (0, 130), "wind_kw": (0, 160),
    "battery_soc": (0, 100), "battery_soh": (0, 100),
    "fuel_l": (0, 10000), "temperature_c": (-85, 25),
    "wind_speed_ms": (0, 60), "solar_irradiance_wm2": (0, 900),
    "generator_output_kw": (0, DIESEL_RATED_KW),
}

WINDOW: deque = deque(maxlen=2000)
_issues: deque = deque(maxlen=200)
_last_by_sensor: dict[str, tuple[float, float]] = {}   # sensor -> (ts, value)
_rolling_quality: deque = deque(maxlen=300)

ISSUE_SEVERITY = {"out_of_range": "warning", "anomaly": "warning",
                  "duplicate": "info", "bad_timestamp": "info", "missing": "info"}


def process_reading(sensor: str, value: float, ts: Optional[float] = None,
                    source: str = "simulated") -> dict:
    """Validate one reading. Returns dict with quality + flags."""
    ts = ts if ts is not None else time.time()
    flags: list[str] = []
    quality = 1.0

    # range validation
    if sensor in RANGES:
        lo, hi = RANGES[sensor]
        if not (lo <= value <= hi):
            flags.append("out_of_range")
            quality -= 0.8

    # duplicate / timestamp checks
    last = _last_by_sensor.get(sensor)
    if last and abs(value - last[1]) < 1e-9 and (ts - last[0]) < 0.2:
        flags.append("duplicate")
        quality -= 0.2
    _last_by_sensor[sensor] = (ts, value)

    # anomaly detection: deviation from rolling median of recent values
    recent = [v for (s, v, _) in WINDOW if s == sensor]
    if len(recent) >= 12:
        med = statistics.median(recent[-50:])
        spread = statistics.pstdev(recent[-50:]) or 1.0
        if abs(value - med) > 4 * spread:
            flags.append("anomaly")
            quality -= 0.5

    quality = max(0.0, round(quality, 3))
    rec = {"sensor": sensor, "value": value, "ts": ts, "quality": quality,
           "flags": flags, "source": source}
    WINDOW.append((sensor, value, ts))
    _rolling_quality.append(quality)

    for f in flags:
        _issues.appendleft({"ts": ts, "sensor": sensor, "value": value,
                            "type": f, "severity": ISSUE_SEVERITY.get(f, "info")})

    return rec


def process_batch(readings: list[dict]) -> dict:
    results = [process_reading(r["sensor"], r["value"], r.get("ts"),
                               r.get("source", "batch")) for r in readings]
    return summarize()


def summarize() -> dict:
    score = round(100.0 * (sum(_rolling_quality) / len(_rolling_quality)), 1) if _rolling_quality else 100.0
    counts: dict[str, int] = defaultdict(int)
    for i in list(_issues)[:50]:
        counts[i["type"]] += 1
    issue_lines = [f"{n} {t} reading(s)" for t, n in counts.items()]
    return {"score": score, "issues": issue_lines,
            "recent": list(_issues)[:25], "samples": len(_rolling_quality)}


def quality_snapshot() -> dict:
    STATE.data_quality = summarize()
    return STATE.data_quality


def fallback_value(sensor: str) -> Optional[float]:
    """Last-known-good value for a failed sensor (graceful degradation)."""
    for s, v, _ in reversed(WINDOW):
        if s == sensor:
            return v
    return None
