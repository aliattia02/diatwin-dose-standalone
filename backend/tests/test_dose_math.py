"""Dose suggestion: characterisation of calculate_suggested_insulin (meal_insulin.py).

CHARACTERISATION (Arm 5 rule 13): dose_golden_v0.json pins the outputs of the code as it was on 26 Sep 2026, including
the minimum-dose behaviour that raises any positive pre-IOB need below 0.5 U to 0.5 U even when active insulin already
exceeds the need (clinical finding F1, docs of the Local AI Hub 07 K45). A refactor must leave every value unchanged.
"""
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))  # tests/ is not a package here
import dose_grid  # noqa: E402

GOLDEN = json.loads(dose_grid.GOLDEN.read_text(encoding="utf-8"))


@pytest.fixture
def mi(monkeypatch):
    import meal_insulin
    monkeypatch.setattr(meal_insulin, "Constants", dose_grid.stub_constants_class())
    logging.disable(logging.CRITICAL)
    yield meal_insulin
    logging.disable(logging.NOTSET)


def test_golden_grid_is_large_and_covers_the_stacking_case():
    assert len(GOLDEN) >= 2000
    stacked = [g for g in GOLDEN if g["expected"]["post_active_total"] < 0 and g["expected"]["total"] == 0.5]
    assert stacked, "the grid must contain the F1 stacking behaviour it characterises"


def test_every_golden_case_is_reproduced(mi):
    bad = []
    for g in GOLDEN:
        got = dose_grid.run_case(mi, g["case"])
        if got != g["expected"]:
            bad.append((g["case"], g["expected"], got))
    assert not bad, f"{len(bad)} dose changes, first: {bad[0]}"
