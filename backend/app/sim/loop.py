"""Background loop: publishes simulated sensor data on the MQTT bus,
runs validation, and periodically refreshes forecasts / autonomy / alerts.
"""
from __future__ import annotations

import threading
import time
import traceback

from ..config import SIM_TICK_SECONDS, SIM_HOURS_PER_TICK
from ..state.system_state import STATE
from .. import db
from . import weather as wx
from . import plant
from ..engines import ingestion, validation, alerts
from ..engines import forecast as fc
from ..engines import autonomy as au

_running = False
_tick = 0


def _publish(topic: str, value, unit: str) -> None:
    ingestion.publish(topic, {"value": value, "unit": unit, "ts": time.time()})


def tick() -> None:
    global _tick
    # Phase 2: respect simulation_paused — do not advance physics while judge experiments
    if STATE.simulation_paused:
        return
    _tick += 1
    try:
        balance = plant.sim_step(SIM_HOURS_PER_TICK)

        # --- publish on simulated MQTT bus ---
        _publish("station/power/load", balance["load_kw"], "kW")
        _publish("station/weather/temperature", STATE.weather["temperature_c"], "°C")
        _publish("station/weather/wind", STATE.weather["wind_speed_ms"], "m/s")
        _publish("station/weather/solar", STATE.weather["solar_irradiance_wm2"], "W/m²")
        _publish("station/battery/soc", STATE.battery_soc, "%")
        _publish("station/battery/soh", STATE.battery_soh, "%")
        _publish("station/fuel/level", STATE.fuel_l, "L")
        _publish("station/generator/status", 1 if STATE.generator_running else 0, "bool")
        _publish("station/generator/output", STATE.generator_output_kw, "kW")

        # --- validate the stream (data quality engine) ---
        validation.process_reading("load_kw", balance["load_kw"])
        validation.process_reading("solar_kw", balance["solar_kw"])
        validation.process_reading("wind_kw", balance["wind_kw"])
        validation.process_reading("battery_soc", STATE.battery_soc)
        validation.process_reading("temperature_c", STATE.weather["temperature_c"])
        validation.quality_snapshot()

        # --- persist live samples every 5 ticks ---
        if _tick % 5 == 0:
            now = time.time()
            t_h = now % (24 * 3600)
            db.insert("weather_data", ts=now, temperature_c=STATE.weather["temperature_c"],
                      wind_speed_ms=STATE.weather["wind_speed_ms"],
                      solar_irradiance=STATE.weather["solar_irradiance_wm2"],
                      condition=STATE.weather["condition"])
            db.insert("battery_state", ts=now, soc_pct=STATE.battery_soc,
                      soh_pct=STATE.battery_soh, power_kw=STATE.battery_power_kw)
            db.insert("generator_state", ts=now, running=int(STATE.generator_running),
                      output_kw=STATE.generator_output_kw,
                      fuel_rate_lph=STATE.generator_output_kw * 0.28)
            db.insert("fuel_state", ts=now, level_l=STATE.fuel_l)
            db.insert("sensor_readings", ts=now, sensor="load_kw",
                      value=balance["load_kw"], unit="kW",
                      quality=STATE.data_quality.get("score", 100) / 100, source="simulated")
            db.insert("sensor_readings", ts=now, sensor="solar_kw", value=balance["solar_kw"],
                      unit="kW", quality=1.0, source="simulated")
            db.insert("sensor_readings", ts=now, sensor="wind_kw", value=balance["wind_kw"],
                      unit="kW", quality=1.0, source="simulated")
            db.insert("sensor_readings", ts=now, sensor="battery_soc",
                      value=round(STATE.battery_soc, 1), unit="%",
                      quality=1.0, source="simulated")

        # --- resupply clock ---
        STATE.resupply_date_days = max(0.0, STATE.resupply_date_days - SIM_HOURS_PER_TICK / 24)

        # --- every 15 ticks: refresh forecast + autonomy + alerts ---
        if _tick % 15 == 0:
            fc.forecast()
            au.calculate()
            alerts.evaluate()

    except Exception:
        traceback.print_exc()


def _loop() -> None:
    global _running
    while _running:
        tick()
        time.sleep(SIM_TICK_SECONDS)


def start() -> None:
    global _running
    if _running:
        return
    _running = True
    th = threading.Thread(target=_loop, daemon=True)
    th.start()


def stop() -> None:
    global _running
    _running = False
