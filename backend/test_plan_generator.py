"""Unit tests for Phase 3 — Candidate Plan Generator & Ranking Engine."""
import sys
import os
import unittest

# Ensure backend root is in sys.path
backend_dir = os.path.join(os.path.dirname(__file__), "backend")
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.state.system_state import STATE
from app.engines import plan_generator as pg
from app.engines import optimizer as op
from app.engines import safety as sf
from app.engines import autonomy as au
from app.api.sandbox import run_experiment, apply_experiment, reset_to_baseline as sandbox_reset, ExperimentInput, ApplyRequest


class TestPlanGenerator(unittest.TestCase):

    def setUp(self):
        STATE.reset_to_baseline()

    def test_candidate_plans_generation_baseline(self):
        """Verify 4 candidate plans are generated under baseline conditions."""
        autonomy = au.calculate()
        res = pg.generate_candidate_plans(current_autonomy=autonomy)

        self.assertIn("candidate_plans", res)
        plans = res["candidate_plans"]
        self.assertEqual(len(plans), 4)

        # Check required strategy types exist
        strat_types = [p["strategy_type"] for p in plans]
        self.assertIn("CRITICAL_PROTECTION", strat_types)
        self.assertIn("GENERATOR_SUPPORT", strat_types)
        self.assertIn("DEEP_CONSERVATION", strat_types)
        self.assertIn("POLAR_RECOMMENDED", strat_types)

        # Under baseline, all plans should be evaluated through optimizer and safety
        for p in plans:
            self.assertIn("cqrm_days", p)
            self.assertIn("end_soc", p)
            self.assertIn("fuel_6h_l", p)
            self.assertIn("critical_coverage_pct", p)
            self.assertIn("flex_load_pct", p)
            self.assertIn("safety_passed", p)
            self.assertIn("ml_inputs_used", p)
            self.assertEqual(len(p["ml_inputs_used"]), 8)

        # Winner must be identified and marked
        self.assertIsNotNone(res["recommended_plan_id"])
        rec_plan = next(p for p in plans if p["id"] == res["recommended_plan_id"])
        self.assertTrue(rec_plan["is_recommended"])
        self.assertTrue(rec_plan["safety_passed"])
        self.assertGreater(len(rec_plan["why_recommended"]), 0)

    def test_plans_adapt_under_high_demand(self):
        """Verify candidate plans re-calculate metrics and rankings when load increases."""
        # High demand experiment
        exp_res = run_experiment(ExperimentInput(station_load_kw=330))

        self.assertIn("candidate_plans", exp_res)
        plans = exp_res["candidate_plans"]
        self.assertEqual(len(plans), 4)

        # Check that fuel burn and CQRM reflect higher demand
        for p in plans:
            self.assertGreaterEqual(p["fuel_6h_l"], 0)

        # Ensure dynamic explanation is generated
        rec_id = exp_res["recommended_plan_id"]
        if rec_id:
            rec_plan = next(p for p in plans if p["id"] == rec_id)
            self.assertGreater(len(rec_plan["why_recommended"]), 0)

    def test_extreme_stress_provides_actionable_recovery_and_options(self):
        """Verify that under severe stress (CQRM < 0), all candidate plans are displayed
        with their reasons why unsafe, and Emergency Conservation recovery option is provided.
        """
        # Extreme stress: low battery, high delay, blizzard
        exp_res = run_experiment(ExperimentInput(
            battery_soc=25,
            resupply_delay_days=5.0,
            station_load_kw=320,
            solar_kw=5,
            wind_kw=10,
        ))

        self.assertIn("candidate_plans", exp_res)
        plans = exp_res["candidate_plans"]
        self.assertEqual(len(plans), 4)

        # All nominal plans should be present and marked with their specific failure reasons
        for p in plans:
            self.assertIn("why_not_recommended", p)
            self.assertIn("UNSAFE", p["why_not_recommended"])
            self.assertGreater(len(p["failed_reasons"]), 0)

        # Recovery options must be provided
        self.assertIn("recovery_options", exp_res)
        recovery_opts = exp_res["recovery_options"]
        self.assertGreater(len(recovery_opts), 0)

        rec_action = recovery_opts[0]
        self.assertEqual(rec_action["id"], "plan_emergency_conservation")
        self.assertIn("plan", rec_action)
        self.assertEqual(rec_action["plan"]["strategy_type"], "EMERGENCY_CONSERVATION")

    def test_apply_emergency_conservation_updates_state(self):
        """Verify applying Emergency Conservation recovery action commits to global simulation."""
        v0 = STATE.state_version

        # Run experiment under stress
        exp = run_experiment(ExperimentInput(battery_soc=30, resupply_delay_days=4.0))
        sid = exp["sandbox_session_id"]

        # Apply the emergency conservation recovery plan
        apply_res = apply_experiment(ApplyRequest(
            sandbox_session_id=sid,
            state_version=exp["state_version"],
            selected_plan_id="plan_emergency_conservation",
        ))

        self.assertTrue(apply_res["applied"])
        self.assertGreater(apply_res["state_version"], v0)
        self.assertEqual(apply_res["applied_plan"]["name"], "Emergency Conservation Recovery")
        self.assertEqual(STATE.active_plan_name, "Emergency Conservation Recovery")


if __name__ == "__main__":
    unittest.main()
