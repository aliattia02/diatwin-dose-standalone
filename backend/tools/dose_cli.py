"""Dose suggestion as a command-line tool: JSON on stdin → JSON on stdout. No database, no Flask app, no network.

For callers outside the Flask app (the Local AI Hub's `calc` tool, scripts, a clinician's own checks). It runs the same
function the app runs (utils.dose_math.compute_suggested_insulin), so there is one dose formula.

  echo '{"constants": {"insulin_to_carb_ratio": 10, "correction_factor": 50, "target_glucose": 120,
         "insulin_delivery": "pump"}, "blood_glucose": 250, "active_insulin": 1.5}' | python tools/dose_cli.py

Input:  constants  (required: insulin_to_carb_ratio, correction_factor, target_glucose — no silent defaults for these;
                    optional: insulin_delivery, dose_step_units, min_dose_units, protein_factor, fat_factor, ...)
        nutrition  {carbs, protein, fat, fiber, absorption_type}   (missing numbers = 0)
        blood_glucose (mg/dL or null), active_insulin (U), active_meal_carbs (g), activity_impact, health_multiplier
Output: {"total", "breakdown", "provenance"} or {"error"} with exit code 2.
"""
from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
REQUIRED = ("insulin_to_carb_ratio", "correction_factor", "target_glucose")


def _version() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=BACKEND, capture_output=True, text=True,
                              timeout=5).stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def suggest(req: dict) -> dict:
    sys.path.insert(0, str(BACKEND))
    logging.disable(logging.CRITICAL)
    from constants import Constants
    from utils.dose_math import compute_suggested_insulin

    given = req.get("constants") or {}
    missing = [k for k in REQUIRED if not isinstance(given.get(k), (int, float)) or isinstance(given.get(k), bool) or given[k] <= 0]
    if missing:
        raise ValueError(f"missing or invalid patient constants: {', '.join(missing)} (no defaults are used for these)")
    if given.get("insulin_delivery", "pen") not in ("pen", "pump"):
        raise ValueError("insulin_delivery must be 'pen' or 'pump'")
    constants = Constants(None).get_patient_constants()  # defaults for everything the caller did not give
    constants.update(given)
    nutrition = {"carbs": 0, "protein": 0, "fat": 0, "fiber": 0, **(req.get("nutrition") or {})}
    factors = {"activeInsulin": req.get("active_insulin", 0.0), "activeMealCarbs": req.get("active_meal_carbs", 0.0),
               "activityImpact": req.get("activity_impact", 1.0), "healthMultiplier": req.get("health_multiplier", 1.0)}
    r = compute_suggested_insulin(constants, Constants.MEAL_ABSORPTION_PROFILES, nutrition, req.get("blood_glucose"),
                                  factors)
    r["provenance"] = {"producer": "rules:utils.dose_math.compute_suggested_insulin", "version": _version(),
                       "constants_source": "caller", "given_constants": sorted(given)}
    return r


def main() -> int:
    try:
        out = suggest(json.loads(sys.stdin.read() or "{}"))
    except (ValueError, TypeError, KeyError) as e:
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(out, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
