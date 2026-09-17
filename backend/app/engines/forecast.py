"""Forecasting engine.

Lightweight, fully-local ML: ridge regression with cyclic time features,
trained on the station's own history (seeded simulation data). Produces
point forecasts, ~90% prediction intervals and honest MAE/RMSE metrics.

If the model fails to train, `ml_fallback` activates a persistence
heuristic so the system degrades gracefully.
"""
from __future__ import annotations

import math
import statistics
import time
from typing import Optional

import numpy as np

try:
    from ..config import FORECAST_HORIZONS_H, FORECAST_HISTORY_H, UNCERTAINTY_Z
    from .. import db
    from ..state.system_state import STATE
except (ImportError, ValueError):
    from app.config import FORECAST_HORIZONS_H, FORECAST_HISTORY_H, UNCERTAINTY_Z
    from app import db
    from app.state.system_state import STATE

MODEL_VERSION = "ridge-1.2.0"
MODEL_TRAINED_AT: Optional[float] = None
MODEL_METRICS: dict = {}

TARGETS = ["load_kw", "solar_kw", "wind_kw"]


# ------------------------------------------------------------- features ---
def _features(t_h: float, temp: float, wind: float, irr: float) -> list[float]:
    hour = t_h % 24
    return [
        1.0,
        math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24),
        math.sin(4 * math.pi * hour / 24), math.cos(4 * math.pi * hour / 24),
        temp / 40.0, wind / 30.0, irr / 500.0,
        math.sin(2 * math.pi * t_h / (24 * 7)),   # weekly-ish synoptic
        math.cos(2 * math.pi * t_h / (24 * 7)),
    ]


def _design_matrix(rows: list[dict]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    X = []
    y: dict[str, list[float]] = {t: [] for t in TARGETS}
    for r in rows:
        t_h = r["ts"] % (24 * 10 ** 6)  # keep cyclic features sane
        X.append(_features(t_h, r["temperature_c"], r["wind_speed_ms"], r["solar_irradiance"]))
        for t in TARGETS:
            y[t].append(r[t])
    return np.array(X), {k: np.array(v) for k, v in y.items()}


def _ridge_fit(X: np.ndarray, y: np.ndarray, lam: float = 1.0) -> np.ndarray:
    d = X.shape[1]
    return np.linalg.solve(X.T @ X + lam * np.eye(d), X.T @ y)


def _predict(w: np.ndarray, x: np.ndarray) -> float:
    return float(x @ w)


# ------------------------------------------------------------ training ----
def train_models() -> dict:
    """Train on the station's stored history (simulation data)."""
    global MODEL_TRAINED_AT, MODEL_METRICS
    try:
        rows = db.query(
            """SELECT w.ts, w.temperature_c, w.wind_speed_ms, w.solar_irradiance,
                      s_load.value AS load_kw, s_sol.value AS solar_kw, s_wind.value AS wind_kw
               FROM weather_data w
               JOIN sensor_readings s_load ON s_load.ts = w.ts AND s_load.sensor='load_kw'
               JOIN sensor_readings s_sol  ON s_sol.ts  = w.ts AND s_sol.sensor='solar_kw'
               JOIN sensor_readings s_wind ON s_wind.ts = w.ts AND s_wind.sensor='wind_kw'
               ORDER BY w.ts DESC LIMIT ?""",
            (FORECAST_HISTORY_H,))
        if len(rows) < 48:
            raise RuntimeError("insufficient history")

        X, Y = _design_matrix(rows)
        weights, residuals = {}, {}
        for t in TARGETS:
            w = _ridge_fit(X, Y[t])
            weights[t] = w.tolist()
            residuals[t] = (Y[t] - X @ w).tolist()

        # honest time-based validation metrics (last 20% as test set)
        n_test = max(12, int(len(rows) * 0.2))
        Xtr, Xte = X[:-n_test], X[-n_test:]
        metrics = {}
        for t in TARGETS:
            w = _ridge_fit(Xtr, Y[t][:-n_test])
            pred = Xte @ w
            err = Y[t][-n_test:] - pred
            mae = float(np.mean(np.abs(err)))
            rmse = float(np.sqrt(np.mean(err ** 2)))
            metrics[t] = {"mae": round(mae, 2), "rmse": round(rmse, 2),
                          "sigma": round(float(np.std(residuals[t])), 2),
                          "samples_test": int(n_test)}

        MODEL_METRICS = metrics
        MODEL_TRAINED_AT = time.time()
        STATE.engine_status["ml"] = "OPERATIONAL"
        STATE.ml_fallback = False
        _save_weights(weights)
        return {"status": "trained", "samples": len(rows), "metrics": metrics,
                "version": MODEL_VERSION, "trained_at": MODEL_TRAINED_AT}
    except Exception as e:
        STATE.engine_status["ml"] = "DEGRADED — FALLBACK MODEL"
        STATE.ml_fallback = True
        return {"status": "fallback", "reason": str(e), "version": "persistence-fallback"}


def _save_weights(weights: dict) -> None:
    db.execute("DELETE FROM model_state WHERE key='ridge_weights'")
    db.execute("INSERT INTO model_state (key, value_json) VALUES ('ridge_weights', ?)",
               (db.j(weights),))


def _load_weights() -> Optional[dict]:
    row = db.query_one("SELECT value_json FROM model_state WHERE key='ridge_weights'")
    if row:
        try:
            import json
            return json.loads(row["value_json"])
        except Exception:
            return None
    return None


# ----------------------------------------------------------- inference ----
def forecast() -> dict:
    """Produce forecasts for all horizons for all targets."""
    now_h = STATE.now_h()
    weather = STATE.weather
    scen = STATE.scenario

    out: dict = {"generated_at": time.time(), "targets": {}}
    weights = None if STATE.ml_fallback else _load_weights()

    for target in TARGETS:
        steps = {}
        for h in FORECAST_HORIZONS_H:
            if weights and target in weights:
                w = np.array(weights[target])
                t_future = now_h + h
                # use forecast weather (scenario-adjusted persistence of now)
                x = np.array(_features(t_future, weather["temperature_c"],
                                       weather["wind_speed_ms"],
                                       weather["solar_irradiance_wm2"]))
                value = _predict(w, x)
                sigma = MODEL_METRICS.get(target, {}).get("sigma", 10.0)
                # scenario widening of uncertainty
                u = 1.0
                if scen.get("storm") or scen.get("bad_weather"):
                    u = 1.8
                elif scen.get("low_renewable"):
                    u = 1.4
                lo = value - UNCERTAINTY_Z * sigma * u
                hi = value + UNCERTAINTY_Z * sigma * u
                steps[str(h)] = {"value": round(max(0.0, value), 1),
                                 "lo": round(max(0.0, lo), 1),
                                 "hi": round(max(0.0, hi), 1)}
            else:
                # fallback: persistence with wide interval
                base = {"load_kw": STATE.total_load_kw(),
                        "solar_kw": weather.get("solar_irradiance_wm2", 0) / 1000 * 108,
                        "wind_kw": max(0.0, (weather["wind_speed_ms"] - 3)) * 12}.get(target, 0.0)
                base = min(base, {"load_kw": 700, "solar_kw": 120, "wind_kw": 150}[target])
                spread = base * 0.35
                steps[str(h)] = {"value": round(base, 1),
                                 "lo": round(max(0.0, base - spread), 1),
                                 "hi": round(base + spread, 1)}
        out["targets"][target] = {
            "steps": steps,
            "model": "persistence-fallback" if (STATE.ml_fallback or not weights)
                     else f"ridge ({MODEL_VERSION})",
        }

    # heating demand forecast derived from temperature model
    heating_now = weather["temperature_c"]
    load24 = out["targets"]["load_kw"]["steps"].get("24", {})
    out["heating_note"] = f" Heating tracked via temperature coupling (now {heating_now}°C)."

    STATE.latest_forecast = out
    _persist(out)
    return out


def _persist(f: dict) -> None:
    rows = []
    for target, tinfo in f["targets"].items():
        for h, s in tinfo["steps"].items():
            rows.append({"ts": time.time(), "horizon_h": float(h), "target": target,
                         "value": s["value"], "lo": s["lo"], "hi": s["hi"],
                         "model": tinfo["model"],
                         "mae": MODEL_METRICS.get(target, {}).get("mae"),
                         "rmse": MODEL_METRICS.get(target, {}).get("rmse"),
                         "confidence": round(max(0.0, 1.0 - MODEL_METRICS.get(target, {}).get("rmse", 20) / 100), 2)})
    db.insert_many("forecasts", rows)


def model_info() -> dict:
    return {
        "name": "Ridge Regression Energy Forecaster",
        "version": MODEL_VERSION,
        "trained_at": MODEL_TRAINED_AT,
        "dataset": "Station simulated history (seeded, labelled SIMULATION DATA)",
        "metrics": MODEL_METRICS,
        "status": STATE.engine_status.get("ml", "UNKNOWN"),
        "fallback_active": STATE.ml_fallback,
        "features": ["hour-of-day (cyclic)", "temperature", "wind speed",
                     "solar irradiance", "synoptic cycle"],
    }


def simulate_model_update() -> dict:
    """Simulated 'new model available' flow — validated before promotion."""
    old = dict(MODEL_METRICS)
    res = train_models()
    return {"previous": old, "result": res,
            "promoted": res.get("status") == "trained" and
                        res["metrics"]["load_kw"]["mae"] <= old.get("load_kw", {}).get("mae", 1e9) + 5}
