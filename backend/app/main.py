"""FastAPI application entry point.

Wires: startup (seed history, train models, start sim loop), API routers,
and the frontend static mount for single-process deployment (Electron-ready).
"""
from __future__ import annotations

import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from . import db
from .sim import seed, loop
from .engines import forecast as fc
from .engines import autonomy as au
from .engines import alerts as al
from .state.system_state import STATE
from .services.model_loader import get_model_loader
from .api import (
    station_router, sensors_router, weather_router, forecast_router,
    autonomy_router, optimization_router, safety_router, resupply_router,
    scenarios_router, alerts_router, events_router, system_router,
    connectivity_router, data_router, actions_router, models_router,
)
from .api.scenario_v1 import router as scenario_v1_router
from .api.sandbox import router as sandbox_router

app = FastAPI(title="POLAR-EMS", version="1.0.0",
              description="Autonomy-Aware Polar Energy Management System — SIMULATION / DEMONSTRATION DATA")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])

@app.get("/health")
@app.get("/api/health")
def health_check() -> dict:
    loader = get_model_loader()
    return {
        "status": "healthy",
        "timestamp": time.time(),
        "models_loaded": list(loader.models.keys()),
        "models_count": len(loader.models),
        "app": "POLAR-EMS",
        "version": "1.0.0"
    }

app.include_router(scenario_v1_router, prefix="/api")
app.include_router(sandbox_router, prefix="/api")

for r in (station_router, sensors_router, weather_router, forecast_router,
          autonomy_router, optimization_router, safety_router, resupply_router,
          scenarios_router, alerts_router, events_router, system_router,
          connectivity_router, data_router, actions_router, models_router):
    app.include_router(r, prefix="/api")


@app.on_event("startup")
def startup() -> None:
    db.get_conn()
    
    # Load ML models into singleton memory cache
    try:
        loader = get_model_loader()
        loader.load_all()
    except Exception as e:
        print(f"Warning loading ML models at startup: {e}")

    # seed demo history once
    cnt = db.query_one("SELECT COUNT(*) c FROM sensor_readings")["c"]
    if not cnt:
        n = seed.generate_history()
        db.log_event("system", "Seeded simulation history",
                     f"{n} readings generated (labelled SIMULATION DATA)", "info")
    # train fallback ML models locally
    try:
        res = fc.train_models()
        db.log_event("ml", "Model training", str(res.get("status")), "info")
    except Exception as e:
        print(f"Fallback training note: {e}")

    # initial pipeline so UI has data immediately
    from .engines.decision import run_pipeline
    run_pipeline("startup")
    al.evaluate()
    loop.start()

# serve frontend build if present (single-origin deployment / future Electron)
_dist = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
if os.path.isdir(_dist):
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")

