"""tools/dose_cli.py: the dose formula as a subprocess tool (JSON in/out), run with NO database environment at all."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

CLI = Path(__file__).resolve().parents[1] / "tools" / "dose_cli.py"
W23 = {"constants": {"insulin_to_carb_ratio": 10, "correction_factor": 50, "target_glucose": 120},
       "blood_glucose": 250, "active_insulin": 1.5}


def run(req):
    env = {k: v for k, v in os.environ.items() if k not in ("MONGO_URI", "SECRET_KEY")}
    p = subprocess.run([sys.executable, str(CLI)], input=json.dumps(req), capture_output=True, text=True, env=env, timeout=120)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("delivery,expected", [("pen", 1.0), ("pump", 1.1)])
def test_correction_bolus_uses_the_callers_constants(delivery, expected):
    rc, out = run({**W23, "constants": {**W23["constants"], "insulin_delivery": delivery}})
    assert rc == 0 and out["total"] == expected
    assert out["breakdown"]["correction_insulin"] == 2.6 and out["breakdown"]["post_active_total"] == 1.1
    assert out["provenance"]["producer"] == "rules:utils.dose_math.compute_suggested_insulin"
    assert out["provenance"]["constants_source"] == "caller"


def test_missing_patient_constants_are_refused_not_defaulted():
    rc, out = run({"blood_glucose": 250, "active_insulin": 1.5, "constants": {"insulin_to_carb_ratio": 10}})
    assert rc == 2 and "correction_factor" in out["error"] and "target_glucose" in out["error"]


def test_excess_active_insulin_gives_zero():
    rc, out = run({"constants": {"insulin_to_carb_ratio": 10, "correction_factor": 40, "target_glucose": 100},
                   "blood_glucose": 115, "active_insulin": 2.0})
    assert rc == 0 and out["total"] == 0.0 and out["breakdown"]["post_active_total"] < 0


def test_bad_delivery_is_refused():
    rc, out = run({**W23, "constants": {**W23["constants"], "insulin_delivery": "syringe"}})
    assert rc == 2 and "insulin_delivery" in out["error"]


# ── Input validation (defects D1-D4 of docs/engineering/2026-10-10-safety-gate-and-crosscheck-spec.md) ──────────
# Each rejected request must come back as {"error": ...} with exit code 2, never a traceback.
BASE = {"constants": {"insulin_to_carb_ratio": 10, "correction_factor": 40, "target_glucose": 100}}


@pytest.mark.parametrize("body", [[1, 2], "text", 5, None, True])
def test_a_body_that_is_not_an_object_is_refused(body):
    rc, out = run(body)
    assert rc == 2 and "JSON object" in out["error"]


@pytest.mark.parametrize("step", [0, 0.0, -0.5, True, "0.5"])
def test_dose_step_of_zero_or_below_or_not_a_number_is_refused(step):
    rc, out = run({"constants": {**BASE["constants"], "dose_step_units": step}, "blood_glucose": 250})
    assert rc == 2 and "dose_step_units" in out["error"]


@pytest.mark.parametrize("step,expected", [(None, 3.5), (0.25, 3.75), (1, 3.0)])
def test_valid_dose_steps_are_unchanged(step, expected):
    rc, out = run({"constants": {**BASE["constants"], "dose_step_units": step}, "blood_glucose": 250})
    assert rc == 0 and out["total"] == expected


@pytest.mark.parametrize("bg", [0, 0.0, -1, -50, True, "250", float("nan")])
def test_glucose_of_zero_or_below_or_not_a_number_is_refused(bg):
    rc, out = run({**BASE, "blood_glucose": bg})
    assert rc == 2 and "blood_glucose" in out["error"]


def test_no_reading_is_still_accepted_as_null_or_absent():
    for req in ({**BASE, "blood_glucose": None, "nutrition": {"carbs": 60}}, {**BASE, "nutrition": {"carbs": 60}}):
        rc, out = run(req)
        assert rc == 0 and out["total"] == 6.0 and out["breakdown"]["correction_insulin"] == 0


@pytest.mark.parametrize("iob", [-0.1, -3, True, "1.5", float("nan")])
def test_negative_or_non_numeric_active_insulin_is_refused(iob):
    rc, out = run({**BASE, "blood_glucose": 100, "active_insulin": iob})
    assert rc == 2 and "active_insulin" in out["error"]


def test_zero_active_insulin_is_accepted():
    rc, out = run({**BASE, "blood_glucose": 250, "active_insulin": 0})
    assert rc == 0 and out["total"] == 3.5


@pytest.mark.parametrize("carbs", [-1, -50, True, "60", float("nan")])
def test_negative_or_non_numeric_carbs_are_refused(carbs):
    rc, out = run({**BASE, "blood_glucose": 100, "nutrition": {"carbs": carbs}})
    assert rc == 2 and "carbs" in out["error"]


def test_zero_carbs_and_missing_carbs_are_accepted():
    for nutrition in ({"carbs": 0}, {"protein": 10}, {}):
        rc, out = run({**BASE, "blood_glucose": 250, "nutrition": nutrition})
        assert rc == 0 and out["total"] >= 3.5


def test_valid_requests_give_the_same_numbers_as_before_the_validation():
    # the probe set of the specification (section 2.4): rows A, C, E, F, P, Q, R
    cases = [
        ({"constants": {"insulin_to_carb_ratio": 10, "correction_factor": 50, "target_glucose": 120},
          "blood_glucose": 250, "active_insulin": 1.5}, 1.0),
        ({**BASE, "blood_glucose": 40, "nutrition": {"carbs": 60}}, 4.5),
        ({**BASE, "nutrition": {"carbs": 60}}, 6.0),
        ({**BASE, "blood_glucose": 250, "nutrition": {"carbs": 500}}, 53.5),
        ({"constants": {**BASE["constants"], "insulin_delivery": "pump"}, "blood_glucose": 250}, 3.7),
        ({**BASE, "blood_glucose": 250}, 3.5),
        ({**BASE, "nutrition": {"carbs": 4.9}}, 0.0),
    ]
    for req, expected in cases:
        rc, out = run(req)
        assert rc == 0 and out["total"] == expected, req
