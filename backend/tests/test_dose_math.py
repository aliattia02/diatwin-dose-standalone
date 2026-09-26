"""Dose suggestion: calculate_suggested_insulin (meal_insulin.py) → utils/dose_math.compute_suggested_insulin.

dose_golden_v0.json pins the outputs of the code as it was on 26 Sep 2026. Two clinician decisions of the same day
(the Local AI Hub's decision log, 07 K45/K46) then changed exactly one output, `total`:

  * a dose below min_dose_units (0.5 U) is not suggested at all (0 U). This replaces the old floor that raised any
    positive pre-IOB need below 0.5 U to 0.5 U even when active insulin already exceeded the need (282 grid cases);
  * a dose is rounded DOWN to the device step: 0.5 U for pens (the default), 0.1 U for pumps.

The tests therefore pin, per grid case: every other golden value unchanged; the new `total` equal to the rule applied
to the unrounded `raw_total`; and `raw_total` consistent with the old `total` wherever the old floor did not fire.
"""
import json
import logging
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))  # tests/ is imported by path here
import dose_grid  # noqa: E402

GOLDEN = json.loads(dose_grid.GOLDEN.read_text(encoding="utf-8"))


@pytest.fixture
def mi(monkeypatch):
    import meal_insulin
    monkeypatch.setattr(meal_insulin, "Constants", dose_grid.stub_constants_class())
    logging.disable(logging.CRITICAL)
    yield meal_insulin
    logging.disable(logging.NOTSET)


def rule(raw, step=0.5, minimum=0.5):
    return 0.0 if raw < minimum else round(math.floor(raw / step + 1e-9) * step, 2)


def full(mi, case, **extra):
    mi.Constants.override = {**case["constants"], **extra}
    return mi.calculate_suggested_insulin(None, dict(case["nutrition"]), [], blood_glucose=case["blood_glucose"],
                                          calculation_factors=dict(case["factors"]))


def test_golden_grid_is_large_and_covers_the_old_stacking_case():
    assert len(GOLDEN) >= 2000
    stacked = [g for g in GOLDEN if g["expected"]["post_active_total"] < 0 and g["expected"]["total"] == 0.5]
    assert len(stacked) == 282, "the grid must keep the F1 cases the decision changed"


def test_only_total_changed_and_it_follows_the_approved_rule(mi):
    bad = []
    for g in GOLDEN:
        r = full(mi, g["case"])
        b, old = r["breakdown"], g["expected"]
        now = {k: b[k] for k in dose_grid.KEYS if k != "total"}
        if now != {k: v for k, v in old.items() if k != "total"}:
            bad.append(("other value changed", g["case"]))
        if r["total"] != rule(b["raw_total"]):
            bad.append(("total not by rule", g["case"], b["raw_total"], r["total"]))
        old_floor_fired = old["pre_active_total"] > 0 and round(b["raw_total"], 1) < 0.5
        if not old_floor_fired and round(b["raw_total"], 1) != old["total"]:
            bad.append(("raw_total inconsistent with old total", g["case"], b["raw_total"], old["total"]))
    assert not bad, f"{len(bad)} problems, first: {bad[0]}"


def test_no_suggestion_ever_stacks_on_excess_active_insulin(mi):
    for g in GOLDEN:
        r = full(mi, g["case"])
        if r["breakdown"]["post_active_total"] < 0:
            assert r["total"] == 0.0, g["case"]


W23 = {"constants": {"insulin_to_carb_ratio": 10, "correction_factor": 50, "target_glucose": 120},
       "nutrition": {"carbs": 0, "protein": 0, "fat": 0, "fiber": 0}, "blood_glucose": 250,
       "factors": {"activityImpact": 1.0, "activeInsulin": 1.5, "activeMealCarbs": 0.0, "healthMultiplier": 1.0}}


@pytest.mark.parametrize("extra,expected", [
    ({}, 1.0),                                              # (250-120)/50 = 2.6 − 1.5 = 1.1 → pen, down to 0.5 U steps
    ({"insulin_delivery": "pump"}, 1.1),                    # pump: 0.1 U steps
    ({"insulin_delivery": "pump", "dose_step_units": 0.05}, 1.1),
    ({"min_dose_units": 1.5}, 0.0),                         # 1.1 U is below a 1.5 U minimum → no suggestion
])
def test_hand_checked_correction_bolus(mi, extra, expected):
    r = full(mi, W23, **extra)
    assert r["total"] == expected and abs(r["breakdown"]["raw_total"] - 1.1) < 1e-9


@pytest.mark.parametrize("bg,iob", [(115, 2.0), (120, 3.0)])
def test_the_two_stacking_cases_found_on_26_sep_now_give_zero(mi, bg, iob):
    case = {**W23, "constants": {"insulin_to_carb_ratio": 10, "correction_factor": 40, "target_glucose": 100},
            "blood_glucose": bg, "factors": {**W23["factors"], "activeInsulin": iob}}
    r = full(mi, case)
    assert r["breakdown"]["post_active_total"] < 0 and r["total"] == 0.0


def test_breakdown_names_the_rule_it_applied(mi):
    b = full(mi, W23, insulin_delivery="pump")["breakdown"]
    assert (b["insulin_delivery"], b["dose_step_units"], b["min_dose_units"], b["rounding"]) == ("pump", 0.1, 0.5, "down_to_step")


class TestDoctorCanSetDeliverySettings:
    ENDPOINT = "/api/doctor/patient/{}/constants"

    def put(self, client, doctor, patient, auth, constants):
        return client.put(self.ENDPOINT.format(str(patient["_id"])), json={"constants": constants}, headers=auth(doctor))

    def test_valid_settings_are_stored(self, client, authorized_doctor, patient, auth, db):
        r = self.put(client, authorized_doctor, patient, auth, {"insulin_delivery": "pump", "dose_step_units": 0.05, "min_dose_units": 0.3})
        assert r.status_code == 200, r.get_json()
        doc = db.users.find_one({"_id": patient["_id"]})
        assert (doc["insulin_delivery"], doc["dose_step_units"], doc["min_dose_units"]) == ("pump", 0.05, 0.3)

    @pytest.mark.parametrize("bad", [{"insulin_delivery": "syringe"}, {"dose_step_units": 0}, {"dose_step_units": 2},
                                     {"dose_step_units": True}, {"min_dose_units": -1}, {"min_dose_units": "0.5"}])
    def test_invalid_settings_are_rejected(self, client, authorized_doctor, patient, auth, bad):
        assert self.put(client, authorized_doctor, patient, auth, bad).status_code == 400
