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
