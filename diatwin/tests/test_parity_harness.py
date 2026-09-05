"""
Tests for the parity harness itself.

The harness is the thing that decides whether the Python and TypeScript models
agree, so a bug in it is invisible in exactly the way that matters: it reports
success. These tests check the machinery, not the models — the models are what
the harness compares, and that comparison runs in CI.

Two properties carry the weight:

  - ``compare`` fails on divergence that is not baselined, and only on that. A
    gate that cannot fail is not a gate; a gate that always fails stops being
    read, which is what the 205 recorded insulin divergences would otherwise
    cause (Arm 5 §5.1).
  - The generated case set covers every family and embeds its inputs, so a
    family silently disappearing — the one failure mode ``compare`` cannot see
    on its own, because it would simply have nothing to disagree about — is
    caught here instead.

Nothing here imports the backend, so the suite stays stdlib-only and fast
(Arm 5 rule 1). Case generation is exercised through the fixtures already
committed under ``diatwin/verify/fixtures/``.
"""

from __future__ import annotations

import json

import pytest

from diatwin.verify import parity


EXPECTED_FAMILIES = {"activity", "iob", "meal_act", "meal_abs", "act_bg", "act_aob"}


@pytest.fixture
def cases():
    if not parity.CASES_FILE.exists():
        pytest.skip("case file not generated; run `python -m diatwin.verify.parity generate`")
    return json.loads(parity.CASES_FILE.read_text(encoding="utf-8"))


@pytest.fixture
def results():
    for path in (parity.PY_RESULTS, parity.TS_RESULTS):
        if not path.exists():
            pytest.skip(f"{path.name} not present; run both evaluation steps first")
    return (json.loads(parity.PY_RESULTS.read_text(encoding="utf-8")),
            json.loads(parity.TS_RESULTS.read_text(encoding="utf-8")))


class TestCaseFile:
    def test_every_family_is_present(self, cases):
        families = {c["id"].split("::", 1)[0] for c in cases["cases"]}
        assert families == EXPECTED_FAMILIES

    def test_every_family_has_a_declared_tolerance(self, cases):
        families = {c["id"].split("::", 1)[0] for c in cases["cases"]}
        missing = families - set(parity.TOLERANCE)
        assert not missing, f"families with no tolerance fall back to a default: {missing}"

    def test_case_ids_are_unique(self, cases):
        ids = [c["id"] for c in cases["cases"]]
        assert len(ids) == len(set(ids))

    def test_each_case_carries_its_own_inputs(self, cases):
        # Rule 12: a name-based lookup on each side would compare two different
        # curves if either export went stale, and report it as a model
        # difference. Every case must be self-contained.
        for case in cases["cases"]:
            fn = case["fn"]
            if fn in ("insulin_activity", "iob"):
                assert "duration_hours" in case["profile"], case["id"]
            elif fn in ("meal_activity", "meal_absorbed"):
                for key in ("onset_hours", "peak_hours", "duration_hours",
                            "shape_param", "scale_param"):
                    assert key in case["profile"], f"{case['id']} missing {key}"
            elif fn in ("activity_effect", "activity_aob"):
                assert "start_time" in case and "elapsed_minutes" in case, case["id"]
                assert "duration_minutes" in case["activity"], case["id"]
                assert "hr_base" in case["patient_constants"], case["id"]
            else:
                pytest.fail(f"unknown fn {fn!r} in {case['id']}")

    def test_hr_model_is_embedded_for_the_sync_check(self, cases):
        # The ODE parameters are not an input to either implementation, so they
        # cannot be embedded as case data. They are embedded as a checksum
        # instead, and both sides assert against it.
        assert "hr_model" in cases
        assert cases["hr_model"]["dt"] == 1.0
        assert cases["hr_model"]["acute_rate_per_min"] > 0

    def test_activity_cases_cover_both_hr_paths_and_the_cgm_override(self, cases):
        activity = [c for c in cases["cases"] if c["fn"].startswith("activity_")]
        assert any("hr_trace" in c["activity"] for c in activity), "no wearable-trace case"
        assert any("hr_trace" not in c["activity"] for c in activity), "no synthetic-trace case"
        assert any("bg_drop_override" in c["activity"] for c in activity), "no CGM-override case"
        assert {c["activity"]["bg_direction"] for c in activity} == {-1, 1}

    def test_meal_cases_reach_past_the_absorption_window(self, cases):
        # The truncation at duration_hours is where the two implementations are
        # most likely to disagree, so the grid has to cross it.
        meal = [c for c in cases["cases"] if c["fn"] == "meal_activity"]
        assert any(c["hours_since_meal"] > c["profile"]["duration_hours"] for c in meal)
        assert any(c["hours_since_meal"] == 0 for c in meal)


class TestDivergenceDetection:
    """`_divergences` is the single definition of 'these differ' (rule 11)."""

    def test_identical_results_diverge_nowhere(self, monkeypatch, results, tmp_path):
        py, _ = results
        _write(monkeypatch, tmp_path, py, dict(py))
        _, diverging, only_py, only_ts = parity._divergences()
        assert diverging == []
        assert only_py == [] and only_ts == []

    def test_a_difference_above_tolerance_is_caught_in_every_family(
            self, monkeypatch, results, tmp_path):
        py, _ = results
        ts = dict(py)
        probes = {}
        for family in EXPECTED_FAMILIES:
            case_id = next(k for k in py if k.startswith(f"{family}::"))
            ts[case_id] = py[case_id] + parity.TOLERANCE[family] * 10 + 1.0
            probes[family] = case_id
        _write(monkeypatch, tmp_path, py, ts)
        _, diverging, _, _ = parity._divergences()
        assert set(probes.values()) <= set(diverging)

    def test_a_difference_below_tolerance_is_not_caught(
            self, monkeypatch, results, tmp_path):
        py, _ = results
        ts = dict(py)
        for family in EXPECTED_FAMILIES:
            case_id = next(k for k in py if k.startswith(f"{family}::"))
            ts[case_id] = py[case_id] + parity.TOLERANCE[family] * 0.5
        _write(monkeypatch, tmp_path, py, ts)
        _, diverging, _, _ = parity._divergences()
        assert diverging == []

    def test_a_nan_on_either_side_diverges(self, monkeypatch, results, tmp_path):
        py, _ = results
        case_id = next(iter(py))
        ts = dict(py)
        ts[case_id] = float("nan")
        _write(monkeypatch, tmp_path, py, ts)
        _, diverging, _, _ = parity._divergences()
        assert case_id in diverging

    def test_a_missing_case_is_reported_as_a_set_mismatch_not_agreement(
            self, monkeypatch, results, tmp_path):
        # The failure mode that would otherwise pass silently: one side simply
        # not evaluating a family.
        py, _ = results
        ts = {k: v for k, v in py.items() if not k.startswith("meal_act::")}
        _write(monkeypatch, tmp_path, py, ts)
        _, diverging, only_py, only_ts = parity._divergences()
        assert diverging == []
        assert only_py and all(k.startswith("meal_act::") for k in only_py)


class TestBaselineGate:
    def test_clean_results_pass(self, monkeypatch, results, tmp_path, capsys):
        py, _ = results
        _write(monkeypatch, tmp_path, py, dict(py), baseline=[])
        assert parity.compare() == 0

    def test_new_divergence_fails(self, monkeypatch, results, tmp_path):
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        ts = dict(py)
        ts[case_id] = py[case_id] + 5.0
        _write(monkeypatch, tmp_path, py, ts, baseline=[])
        assert parity.compare() == 1

    def test_baselined_divergence_does_not_fail(self, monkeypatch, results, tmp_path):
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        ts = dict(py)
        ts[case_id] = py[case_id] + 5.0
        _write(monkeypatch, tmp_path, py, ts, baseline=[case_id])
        assert parity.compare() == 0

    def test_a_baseline_does_not_hide_a_different_case(self, monkeypatch, results, tmp_path):
        # The gate has to stay sensitive to everything it has not been told
        # about, or baselining one case quietly excuses the next one.
        py, _ = results
        baselined, other = (next(k for k in py if k.startswith(f"{f}::"))
                            for f in ("meal_act", "act_bg"))
        ts = dict(py)
        ts[baselined] = py[baselined] + 5.0
        ts[other] = py[other] + 5.0
        _write(monkeypatch, tmp_path, py, ts, baseline=[baselined])
        assert parity.compare() == 1

    def test_a_fixed_case_is_reported_but_still_passes(
            self, monkeypatch, results, tmp_path, capsys):
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        _write(monkeypatch, tmp_path, py, dict(py), baseline=[case_id])
        assert parity.compare() == 0
        assert "now agree" in capsys.readouterr().out

    def test_missing_results_exit_two_rather_than_passing(self, monkeypatch, tmp_path):
        # A run that never evaluated must not be mistaken for a run that agreed.
        monkeypatch.setattr(parity, "PY_RESULTS", tmp_path / "absent_py.json")
        monkeypatch.setattr(parity, "TS_RESULTS", tmp_path / "absent_ts.json")
        assert parity.compare() == 2

    def test_the_committed_baseline_only_lists_insulin_cases(self):
        # The recorded divergence is the insulin-curve split in Arm 5 §5.1. If a
        # meal or activity case ever appears in this file, it was baselined
        # rather than fixed, and that is a decision someone has to make on
        # purpose.
        if not parity.BASELINE.exists():
            pytest.skip("no baseline recorded")
        recorded = json.loads(parity.BASELINE.read_text(encoding="utf-8"))["cases"]
        families = {case_id.split("::", 1)[0] for case_id in recorded}
        assert families <= {"activity", "iob"}, (
            f"non-insulin families baselined: {families - {'activity', 'iob'}}")


def _write(monkeypatch, tmp_path, py, ts, baseline=None):
    """Point the harness at throwaway result files for one test."""
    py_path = tmp_path / "py.json"
    ts_path = tmp_path / "ts.json"
    py_path.write_text(json.dumps(py), encoding="utf-8")
    ts_path.write_text(json.dumps(ts), encoding="utf-8")
    monkeypatch.setattr(parity, "PY_RESULTS", py_path)
    monkeypatch.setattr(parity, "TS_RESULTS", ts_path)
    if baseline is not None:
        base_path = tmp_path / "baseline.json"
        base_path.write_text(json.dumps({"cases": baseline}), encoding="utf-8")
        monkeypatch.setattr(parity, "BASELINE", base_path)
