"""Phase 2 Backend Tests — Sandbox Reactive Engine.

Tests:
  1. Single-variable experiment
  2. Multi-variable experiment
  3. Apply (optimistic concurrency)
  4. Reset to demo baseline
  5. State version conflict (409)
  6. Simulation clock toggle
  7. CQRM mathematical relationship
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import requests
import time

BASE = "http://127.0.0.1:8000/api"

def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" -- {detail}" if detail else ""))
    return condition

passed = 0
failed = 0

def run_test(name, fn):
    global passed, failed
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"{'='*60}")
    try:
        if fn():
            passed += 1
            print(f"  >> TEST PASSED")
        else:
            failed += 1
            print(f"  >> TEST FAILED")
    except Exception as e:
        failed += 1
        print(f"  >> TEST ERROR: {e}")

# ---------------------------------------------------------------- Tests ----

def test_baseline_endpoint():
    r = requests.get(f"{BASE}/sandbox/baseline")
    data = r.json()
    ok = check("Baseline endpoint returns 200", r.status_code == 200)
    ok &= check("Baseline has battery_soc=62", data["baseline"]["battery_soc"] == 62.0)
    ok &= check("Baseline has fuel_l=8420", data["baseline"]["fuel_l"] == 8420.0)
    ok &= check("state_version present", "current_state_version" in data)
    return ok

def test_single_variable_experiment():
    r = requests.post(f"{BASE}/sandbox/experiment", json={"battery_soc": 35})
    data = r.json()
    ok = check("Experiment returns 200", r.status_code == 200)
    ok &= check("sandbox_session_id present", "sandbox_session_id" in data)
    ok &= check("baseline present", "baseline" in data)
    ok &= check("experiment present", "experiment" in data)
    ok &= check("Experiment battery_soc = 35", data["experiment"]["battery_soc"] == 35)
    ok &= check("recommendation present", "recommendation" in data)
    ok &= check("safety present", "safety" in data)
    ok &= check("execution_trace present", len(data.get("execution_trace", [])) > 0)
    ok &= check("input_provenance present", "input_provenance" in data)
    # Provenance should show manual_override for battery_soc
    prov = data.get("input_provenance", {})
    ok &= check("battery_soc provenance is manual_override",
                prov.get("battery_soc", {}).get("source") == "manual_override",
                f"got: {prov.get('battery_soc', {}).get('source')}")
    return ok

def test_multi_variable_experiment():
    r = requests.post(f"{BASE}/sandbox/experiment", json={
        "battery_soc": 35,
        "wind_kw": 20,
        "solar_kw": 40,
        "station_load_kw": 320,
        "resupply_delay_days": 4,
    })
    data = r.json()
    ok = check("Multi-variable returns 200", r.status_code == 200)
    ok &= check("CQRM computed", "cqrm_days" in data.get("experiment", {}))
    ok &= check("Safe operability computed", "safe_operability_days" in data.get("experiment", {}))
    # CQRM should be worse with these conditions
    cqrm = data["experiment"]["cqrm_days"]
    ok &= check(f"CQRM is negative or small under stress ({cqrm:.1f})", cqrm < 5.0, f"cqrm={cqrm}")
    return ok

def test_apply_and_global_propagation():
    # First run an experiment
    r1 = requests.post(f"{BASE}/sandbox/experiment", json={"battery_soc": 45})
    data1 = r1.json()
    session_id = data1["sandbox_session_id"]
    version = data1["state_version"]

    # Apply it
    r2 = requests.post(f"{BASE}/sandbox/apply", json={
        "sandbox_session_id": session_id,
        "state_version": version,
    })
    ok = check("Apply returns 200", r2.status_code == 200)
    data2 = r2.json()
    ok &= check("applied=True", data2["applied"] == True)
    ok &= check("state_version incremented", data2["state_version"] > version)

    # Verify global state reflects the change
    r3 = requests.get(f"{BASE}/station")
    station = r3.json()
    ok &= check("Station battery_soc is now 45", abs(station["battery_soc"] - 45) < 0.5,
                f"got: {station['battery_soc']}")
    ok &= check("Station state_version matches", station.get("state_version") == data2["state_version"])
    return ok

def test_reset_to_baseline():
    r = requests.post(f"{BASE}/sandbox/reset", json={})
    data = r.json()
    ok = check("Reset returns 200", r.status_code == 200)
    ok &= check("reset=True", data["reset"] == True)

    # Verify global state is back to baseline
    r2 = requests.get(f"{BASE}/station")
    station = r2.json()
    ok &= check("Battery SOC back to 62", abs(station["battery_soc"] - 62) < 0.5,
                f"got: {station['battery_soc']}")
    ok &= check("Fuel back to 8420", abs(station["fuel_l"] - 8420) < 10,
                f"got: {station['fuel_l']}")
    ok &= check("Mode back to NORMAL", station["mode"] == "NORMAL",
                f"got: {station['mode']}")
    return ok

def test_state_version_conflict():
    # Run experiment
    r1 = requests.post(f"{BASE}/sandbox/experiment", json={"fuel_l": 5000})
    data1 = r1.json()
    session_id = data1["sandbox_session_id"]
    version = data1["state_version"]

    # Mutate global state (simulate another actor)
    requests.post(f"{BASE}/sandbox/reset", json={})

    # Try to apply with stale version
    r2 = requests.post(f"{BASE}/sandbox/apply", json={
        "sandbox_session_id": session_id,
        "state_version": version,
    })
    ok = check("Stale apply returns 409", r2.status_code == 409)
    detail = r2.json().get("detail", "")
    ok &= check("Error mentions STATE_CHANGED", "STATE_CHANGED" in detail, detail)
    return ok

def test_simulation_clock():
    # Get initial state
    r1 = requests.get(f"{BASE}/sandbox/baseline")
    initial_paused = r1.json()["simulation_paused"]

    # Toggle
    r2 = requests.post(f"{BASE}/sandbox/clock")
    data2 = r2.json()
    ok = check("Clock toggle returns 200", r2.status_code == 200)
    ok &= check("Paused state toggled", data2["simulation_paused"] != initial_paused)

    # Toggle back
    r3 = requests.post(f"{BASE}/sandbox/clock")
    data3 = r3.json()
    ok &= check("Paused restored after double toggle", data3["simulation_paused"] == initial_paused)
    return ok

def test_cqrm_relationship():
    """Verify CQRM = Safe Operability - P90 Resupply ETA"""
    r = requests.post(f"{BASE}/sandbox/experiment", json={"battery_soc": 50, "resupply_delay_days": 3})
    data = r.json()
    auto = data.get("autonomy", {})
    safe_d = auto.get("safe_autonomy_days", 0)
    resupply_d = auto.get("resupply_conservative_days", auto.get("next_resupply_days", 0))
    cqrm = auto.get("cqrm_margin_days", 0)
    expected_cqrm = round(safe_d - resupply_d, 2)

    ok = check("CQRM matches formula", abs(cqrm - expected_cqrm) < 0.1,
               f"CQRM={cqrm}, safe={safe_d}, resupply={resupply_d}, expected={expected_cqrm}")
    return ok

# ---------------------------------------------------------------- Run ----

if __name__ == "__main__":
    print("\nPOLAR-EMS Phase 2 Backend Tests")
    print("=" * 60)

    # Reset first to ensure clean state
    requests.post(f"{BASE}/sandbox/reset", json={})
    time.sleep(0.5)

    run_test("Baseline endpoint", test_baseline_endpoint)
    run_test("Single-variable experiment", test_single_variable_experiment)
    run_test("Multi-variable experiment", test_multi_variable_experiment)
    run_test("Apply + global propagation", test_apply_and_global_propagation)
    run_test("Reset to demo baseline", test_reset_to_baseline)
    run_test("State version conflict (409)", test_state_version_conflict)
    run_test("Simulation clock toggle", test_simulation_clock)
    run_test("CQRM mathematical relationship", test_cqrm_relationship)

    print(f"\n{'='*60}")
    print(f"RESULTS: {passed} passed, {failed} failed, {passed + failed} total")
    print(f"{'='*60}")
    sys.exit(0 if failed == 0 else 1)
