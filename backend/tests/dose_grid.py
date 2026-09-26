"""Shared input grid for the dose characterisation tests (test_dose_math.py) and their golden-file generator.

Run `python tests/dose_grid.py` from backend/ (with MONGO_URI/SECRET_KEY set to dummies) to regenerate
tests/data/dose_golden_v0.json from the CURRENT code. Regenerating is a deliberate act: the golden file is the evidence
that a refactor did not change a dose (Arm 5 rule 13).
"""
from __future__ import annotations

import itertools
import json
import logging
import os
import sys
from pathlib import Path

KEYS = ("total", "base_insulin", "correction_insulin", "pre_active_total", "post_active_total", "overlap_adjustment",
        "projected_iob_at_peak", "projected_mob_at_peak", "mob_insulin_equivalent", "health_multiplier")
GOLDEN = Path(__file__).parent / "data" / "dose_golden_v0.json"
CONSTANT_SETS = [  # (insulin_to_carb_ratio, correction_factor, target_glucose)
    (10, 40, 100), (12, 50, 120), (8, 30, 110)]


def cases():
    for (icr, cf, tgt), bg, iob, carbs, (prot, fat), act, amc, hm in itertools.product(
            CONSTANT_SETS, (None, 60, 100, 115, 180, 250), (0.0, 1.5, 3.0), (0, 3, 45), ((0, 0), (20, 15)),
            (1.0, 0.8), (0.0, 40.0), (1.0, 1.2)):
        yield {"constants": {"insulin_to_carb_ratio": icr, "correction_factor": cf, "target_glucose": tgt},
               "nutrition": {"carbs": carbs, "protein": prot, "fat": fat, "fiber": 0},
               "blood_glucose": bg,
               "factors": {"activityImpact": act, "activeInsulin": iob, "activeMealCarbs": amc, "healthMultiplier": hm}}


def stub_constants_class():
    """A subclass of constants.Constants for Constants(user_id): the real defaults (class attributes included), with the
    case's ICR / CF / target on top. Built lazily because importing constants needs the backend on sys.path."""
    from constants import Constants

    class StubConstants(Constants):
        override: dict = {}

        def __init__(self, user_id=None):
            super().__init__(None)

        def get_patient_constants(self):
            pc = super().get_patient_constants()
            pc.update(StubConstants.override)
            return pc

    return StubConstants


def run_case(mi, case) -> dict:
    mi.Constants.override = case["constants"]
    r = mi.calculate_suggested_insulin(None, dict(case["nutrition"]), [], blood_glucose=case["blood_glucose"],
                                       calculation_factors=dict(case["factors"]))
    b = r["breakdown"]
    return {k: (r["total"] if k == "total" else b[k]) for k in KEYS}


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    os.environ.setdefault("MONGO_URI", "mongodb://127.0.0.1:1/none")
    os.environ.setdefault("SECRET_KEY", "golden-generator")
    logging.disable(logging.CRITICAL)
    import meal_insulin as mi
    mi.Constants = stub_constants_class()
    out = [{"case": c, "expected": run_case(mi, c)} for c in cases()]
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(out)} cases to {GOLDEN}")


if __name__ == "__main__":
    main()
