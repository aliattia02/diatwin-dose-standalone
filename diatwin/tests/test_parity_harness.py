"""
Tests for the parity harness itself.

The harness is the thing that decides whether the Python, TypeScript and
frontend models agree, so a bug in it is invisible in exactly the way that
matters: it reports success. These tests check the machinery, not the models —
the models are what the harness compares, and that comparison runs in CI.

Three properties carry the weight:

  - ``compare`` fails on divergence that is not baselined, and only on that. A
    gate that cannot fail is not a gate; a gate that always fails stops being
    read, which is what the 205 recorded insulin divergences would otherwise
    cause (Arm 5 §5.1).
  - The generated case set covers every family and embeds its inputs, so a
    family silently disappearing — the one failure mode ``compare`` cannot see
    on its own, because it would simply have nothing to disagree about — is
    caught here instead.
  - Every pair is compared, and the odd-one-out summary names the side that
    stands alone. A three-way harness that quietly only checked two pairs would
    look identical from the outside, so the pairing itself is asserted.

Nothing here imports the backend, so the suite stays stdlib-only and fast
(Arm 5 rule 1). Case generation is exercised through the fixtures already
committed under ``diatwin/verify/fixtures/``.
"""

from __future__ import annotations

import json

import pytest

from diatwin.verify import parity


EXPECTED_FAMILIES = {"activity", "iob", "meal_act", "meal_abs", "act_bg", "act_aob", "dose_final"}


@pytest.fixture
def cases():
    if not parity.CASES_FILE.exists():
        pytest.skip("case file not generated; run `python -m diatwin.verify.parity generate`")
    return json.loads(parity.CASES_FILE.read_text(encoding="utf-8"))


@pytest.fixture
def results():
    for path in parity.sides().values():
        if not path.exists():
            pytest.skip(f"{path.name} not present; run every evaluation step first")
    return (json.loads(parity.PY_RESULTS.read_text(encoding="utf-8")),
            json.loads(parity.TS_RESULTS.read_text(encoding="utf-8")))


PY_TS = parity.pair_key("python", "typescript")
PY_FE = parity.pair_key("python", "frontend")
TS_FE = parity.pair_key("typescript", "frontend")


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
            elif fn == "dose_finalise":
                # the unrounded dose and the delivery settings travel with the case; {} means "the rule's defaults",
                # which are part of the rule under comparison (pen 0.5 U step, 0.5 U minimum)
                assert isinstance(case["raw"], (int, float)), case["id"]
                assert isinstance(case["patient_constants"], dict), case["id"]
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
    """`_diverge_pair` is the single definition of 'these differ' (rule 11)."""

    def test_identical_results_diverge_nowhere(self, monkeypatch, results, tmp_path):
        py, _ = results
        _write(monkeypatch, tmp_path, py, dict(py), dict(py))
        for key, (_, diverging, only_a, only_b) in parity._divergences().items():
            assert diverging == [], key
            assert only_a == [] and only_b == [], key

    def test_a_difference_above_tolerance_is_caught_in_every_family(
            self, monkeypatch, results, tmp_path):
        py, _ = results
        ts = dict(py)
        probes = {}
        for family in EXPECTED_FAMILIES:
            case_id = next(k for k in py if k.startswith(f"{family}::"))
            ts[case_id] = py[case_id] + parity.TOLERANCE[family] * 10 + 1.0
            probes[family] = case_id
        _write(monkeypatch, tmp_path, py, ts, dict(py))
        _, diverging, _, _ = parity._divergences()[PY_TS]
        assert set(probes.values()) <= set(diverging)

    def test_a_difference_below_tolerance_is_not_caught(
            self, monkeypatch, results, tmp_path):
        py, _ = results
        ts = dict(py)
        for family in EXPECTED_FAMILIES:
            case_id = next(k for k in py if k.startswith(f"{family}::"))
            ts[case_id] = py[case_id] + parity.TOLERANCE[family] * 0.5
        _write(monkeypatch, tmp_path, py, ts, dict(py))
        _, diverging, _, _ = parity._divergences()[PY_TS]
        assert diverging == []

    def test_a_nan_on_either_side_diverges(self, monkeypatch, results, tmp_path):
        py, _ = results
        case_id = next(iter(py))
        ts = dict(py)
        ts[case_id] = float("nan")
        _write(monkeypatch, tmp_path, py, ts, dict(py))
        _, diverging, _, _ = parity._divergences()[PY_TS]
        assert case_id in diverging

    def test_a_missing_case_is_reported_as_a_set_mismatch_not_agreement(
            self, monkeypatch, results, tmp_path):
        # The failure mode that would otherwise pass silently: one side simply
        # not evaluating a family.
        py, _ = results
        ts = {k: v for k, v in py.items() if not k.startswith("meal_act::")}
        _write(monkeypatch, tmp_path, py, ts, dict(py))
        _, diverging, only_py, only_ts = parity._divergences()[PY_TS]
        assert diverging == []
        assert only_py and all(k.startswith("meal_act::") for k in only_py)

    def test_every_pair_is_compared_not_just_two(self, monkeypatch, results, tmp_path):
        # A three-way harness that silently compared only python-vs-typescript
        # would look identical from the outside until the day the frontend
        # drifted. Each pair is perturbed on its own and has to be the one that
        # reports it.
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        bump = py[case_id] + 5.0

        for changed, expect_bad in (("ts", {PY_TS, TS_FE}),
                                    ("fe", {PY_FE, TS_FE})):
            ts = dict(py)
            fe = dict(py)
            if changed == "ts":
                ts[case_id] = bump
            else:
                fe[case_id] = bump
            _write(monkeypatch, tmp_path, py, ts, fe)
            bad = {k for k, (_, div, _, _) in parity._divergences().items() if case_id in div}
            assert bad == expect_bad, changed

    def test_the_odd_one_out_names_the_side_that_stands_alone(
            self, monkeypatch, results, tmp_path):
        # This is what the third implementation buys: not "they differ" but
        # "this one differs from the other two".
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        fe = dict(py)
        fe[case_id] = py[case_id] + 5.0
        _write(monkeypatch, tmp_path, py, dict(py), fe)
        diverging = {k: entry[1] for k, entry in parity._divergences().items()}
        verdict = parity._odd_one_out(parity.load_results(), diverging)
        assert verdict == {"frontend": [case_id]}

    def test_three_mutually_different_values_are_not_blamed_on_one_side(
            self, monkeypatch, results, tmp_path):
        # Naming a culprit when there is none would be worse than saying
        # nothing: it would send someone to edit an arbitrary file.
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        ts = dict(py)
        fe = dict(py)
        ts[case_id] = py[case_id] + 5.0
        fe[case_id] = py[case_id] + 10.0
        _write(monkeypatch, tmp_path, py, ts, fe)
        diverging = {k: entry[1] for k, entry in parity._divergences().items()}
        verdict = parity._odd_one_out(parity.load_results(), diverging)
        assert verdict == {"three-way": [case_id]}


class TestBaselineGate:
    def test_clean_results_pass(self, monkeypatch, results, tmp_path, capsys):
        py, _ = results
        _write(monkeypatch, tmp_path, py, dict(py), dict(py), baseline={})
        assert parity.compare() == 0

    def test_new_divergence_fails(self, monkeypatch, results, tmp_path):
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        ts = dict(py)
        ts[case_id] = py[case_id] + 5.0
        _write(monkeypatch, tmp_path, py, ts, dict(py), baseline={})
        assert parity.compare() == 1

    def test_baselined_divergence_does_not_fail(self, monkeypatch, results, tmp_path):
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        ts = dict(py)
        ts[case_id] = py[case_id] + 5.0
        _write(monkeypatch, tmp_path, py, ts, dict(py),
               baseline={PY_TS: [case_id], TS_FE: [case_id]})
        assert parity.compare() == 0

    def test_baselining_a_case_for_one_pair_does_not_excuse_another_pair(
            self, monkeypatch, results, tmp_path):
        # Divergence is a property of a pair, not of a case. A case accepted
        # between python and typescript says nothing about the frontend, and
        # keying the baseline on case id alone would silently grant that.
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        ts = dict(py)
        ts[case_id] = py[case_id] + 5.0
        _write(monkeypatch, tmp_path, py, ts, dict(py), baseline={PY_TS: [case_id]})
        assert parity.compare() == 1

    def test_a_baseline_does_not_hide_a_different_case(self, monkeypatch, results, tmp_path):
        # The gate has to stay sensitive to everything it has not been told
        # about, or baselining one case quietly excuses the next one.
        py, _ = results
        baselined, other = (next(k for k in py if k.startswith(f"{f}::"))
                            for f in ("meal_act", "act_bg"))
        ts = dict(py)
        ts[baselined] = py[baselined] + 5.0
        ts[other] = py[other] + 5.0
        _write(monkeypatch, tmp_path, py, ts, dict(py),
               baseline={PY_TS: [baselined], TS_FE: [baselined]})
        assert parity.compare() == 1

    def test_a_fixed_case_is_reported_but_still_passes(
            self, monkeypatch, results, tmp_path, capsys):
        py, _ = results
        case_id = next(k for k in py if k.startswith("meal_act::"))
        _write(monkeypatch, tmp_path, py, dict(py), dict(py),
               baseline={PY_TS: [case_id]})
        assert parity.compare() == 0
        assert "now agree" in capsys.readouterr().out

    def test_missing_results_exit_two_rather_than_passing(self, monkeypatch, tmp_path):
        # A run that never evaluated must not be mistaken for a run that agreed.
        monkeypatch.setattr(parity, "PY_RESULTS", tmp_path / "absent_py.json")
        monkeypatch.setattr(parity, "TS_RESULTS", tmp_path / "absent_ts.json")
        monkeypatch.setattr(parity, "FE_RESULTS", tmp_path / "absent_fe.json")
        assert parity.compare() == 2

    def test_a_missing_frontend_alone_exits_two(self, monkeypatch, results, tmp_path):
        # The third side going quiet is the failure this whole change could
        # introduce: two sides would still agree and the run would look green.
        py, _ = results
        _write(monkeypatch, tmp_path, py, dict(py), dict(py), baseline={})
        monkeypatch.setattr(parity, "FE_RESULTS", tmp_path / "absent_fe.json")
        assert parity.compare() == 2

    def test_a_two_sided_baseline_file_still_reads_as_python_versus_typescript(
            self, monkeypatch, tmp_path):
        # The committed baseline predates the frontend side and records a
        # decision (Arm 5 §5.1). Reading it must not silently reassign those
        # 205 cases to a different pair, or grant them to every pair at once.
        path = tmp_path / "legacy.json"
        path.write_text(json.dumps({"cases": ["iob::x::1.0"]}), encoding="utf-8")
        monkeypatch.setattr(parity, "BASELINE", path)
        pairs = parity.load_baseline()["pairs"]
        assert pairs[PY_TS] == ["iob::x::1.0"]
        assert pairs[PY_FE] == [] and pairs[TS_FE] == []

    def test_the_committed_baseline_only_lists_insulin_cases(self):
        # The recorded divergence is the insulin-curve split in Arm 5 §5.1. If a
        # meal or activity case ever appears in this file, it was baselined
        # rather than fixed, and that is a decision someone has to make on
        # purpose.
        if not parity.BASELINE.exists():
            pytest.skip("no baseline recorded")
        recorded = json.loads(parity.BASELINE.read_text(encoding="utf-8"))
        every = {cid for ids in parity.load_baseline()["pairs"].values() for cid in ids}
        families = {case_id.split("::", 1)[0] for case_id in every}
        assert families <= {"activity", "iob"}, (
            f"non-insulin families baselined: {families - {'activity', 'iob'}}")
        assert recorded  # the file exists and is not an empty shell


def _write(monkeypatch, tmp_path, py, ts, fe, baseline=None):
    """Point the harness at throwaway result files for one test."""
    for name, data, attr in (("py", py, "PY_RESULTS"),
                             ("ts", ts, "TS_RESULTS"),
                             ("fe", fe, "FE_RESULTS")):
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        monkeypatch.setattr(parity, attr, path)
    if baseline is not None:
        base_path = tmp_path / "baseline.json"
        base_path.write_text(json.dumps({"pairs": baseline}), encoding="utf-8")
        monkeypatch.setattr(parity, "BASELINE", base_path)
