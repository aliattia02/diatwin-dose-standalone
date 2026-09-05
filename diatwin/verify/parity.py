"""
Cross-language parity harness.

The insulin, meal and activity models are implemented twice — once in Python
under ``backend/utils/`` and once in TypeScript under ``mobile/utils/`` — on
purpose, as independent implementations of the same mathematics. That is a
recognised verification technique, but it only *is* verification if something
actually compares the two. Otherwise it is just two chances to be wrong.

This module is that comparison.

    python -m diatwin.verify.parity generate    # write the shared case file
    python -m diatwin.verify.parity python      # evaluate the Python side
    cd mobile && npx jest __tests__/parity      # evaluate the TypeScript side
    python -m diatwin.verify.parity compare     # assert agreement, exit 1 on drift
    python -m diatwin.verify.parity baseline    # re-record the known divergences

Both sides read the *same* ``cases.json`` and write results keyed by case id,
so neither implementation can influence the other's inputs. ``compare``
returns a non-zero exit status on divergence, which is what makes it usable
as a CI gate.

Case families
-------------

============== ====================================================
``activity``   insulin activity curve, ``calculate_insulin_activity``
``iob``        insulin on board, ``calculate_iob``
``meal_act``   meal absorption curve, ``calculate_gamma_absorption``
``meal_abs``   absorbed fraction, ``calculate_absorbed_fraction``
``act_bg``     exercise acute BG effect, Y/Z/W ODE
``act_aob``    activity on board, Y/Z/W ODE
============== ====================================================

Baselined divergence
--------------------

205 of the insulin cases diverge for reasons recorded in Arm 5 §5.1 — two
branch conditions that key on disjoint name sets. Correcting them changes
clinical behaviour and is a deliberate decision, not a cleanup. Until that
decision is taken the harness has to distinguish *that* divergence from a new
one, or it degrades into a job that is always red and therefore never read.

``fixtures/baseline_divergences.json`` records the case ids that are known to
diverge. ``compare`` exits non-zero only for a case that diverges and is *not*
in that file. A baselined case that starts agreeing is reported too — that is
the signal to re-run ``baseline`` and shrink the file.

Tolerances are absolute and per-quantity, chosen so that a difference large
enough to change a displayed number fails, while pure floating-point noise
and the two sides' different integration step counts do not.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
CASES_FILE = FIXTURES / "cases.json"
PY_RESULTS = FIXTURES / "results_python.json"
TS_RESULTS = FIXTURES / "results_typescript.json"
BASELINE = FIXTURES / "baseline_divergences.json"

#: Absolute tolerance per quantity, in that quantity's own units.
TOLERANCE: Dict[str, float] = {
    "activity": 1e-6,   # dimensionless fraction — should agree to machine noise
    "iob": 5e-3,        # units of insulin; 0.005 U is far below display precision
    # Meal absorption. Python evaluates t**(k-1) directly, TypeScript evaluates
    # exp((k-1)·ln t); algebraically identical, so only float noise separates
    # them. The absorbed fraction is a 100-step Riemann sum of the same curve
    # on both sides, so the noise accumulates but stays far below 1e-9.
    "meal_act": 1e-9,   # activity percentage, 0-100
    "meal_abs": 1e-9,   # absorbed fraction, 0-1
    # Activity ODE. Both sides round before returning — Python with round(),
    # which is round-half-to-even, TypeScript with Math.round(x*100)/100, which
    # is half-up. A value landing exactly on a rounding tie would differ by one
    # unit in the last place kept, so the tolerance admits that and nothing
    # larger: anything above it means the ODEs themselves disagree.
    "act_bg": 1.01e-2,  # mg/dL, both sides rounded to 2 dp
    "act_aob": 1.01e-1, # mg/dL, both sides rounded to 1 dp
}

#: Insulin types spanning every curve shape the constants define, so a change
#: to any one curve family is caught.
INSULIN_TYPES = [
    "insulin_lispro",            # gamma_steep, rapid
    "insulin_aspart_faster",     # gamma_very_steep, rapid
    "regular_insulin",           # gamma_broad, short
    "nph_insulin",               # gamma_wide, intermediate
    "insulin_glargine",          # sigmoid_plateau, peakless long
    "insulin_degludec",          # sigmoid_ultra_long, peakless ultra-long
    "mixed_insulin_70_30",       # gamma_broad, mixed
]

#: Hours since dose. Deliberately includes 0, sub-onset, peak, and points
#: past the duration of the shorter insulins so the boundary conditions —
#: where the two implementations are most likely to disagree — are covered.
HOURS = [0.0, 0.1, 0.25, 0.375, 0.5, 1.0, 1.5, 2.0, 2.25, 3.0, 4.0, 4.5,
         5.0, 6.0, 8.0, 10.0, 12.0, 14.0, 18.0, 22.5, 24.0, 30.0, 42.0]

DOSES = [0.5, 1.0, 4.0, 6.5, 12.0]

#: Every meal absorption profile the constants define. Unlike the insulin
#: profiles these are only six, so all of them are covered rather than a
#: representative subset.
MEAL_TYPES = ["very_fast", "fast", "medium", "slow", "very_slow", "mixed"]

#: Hours since the meal, as a fraction of that profile's own duration, so the
#: same grid lands on the same features of every curve: before onset, at onset,
#: on the 100 % plateau, at peak, deep in the tail, and past the window.
MEAL_FRACTIONS = [0.0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5,
                  0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0, 1.05, 1.5]

#: Exercise sessions. Intensity tiers, durations spanning a short interval to a
#: long endurance session, and the two paths through the model — the synthetic
#: HR trace and a wearable one.
ACTIVITY_INTENSITIES = ["light", "moderate", "vigorous"]
ACTIVITY_DURATIONS = [10.0, 30.0, 45.0, 90.0]

#: Minutes elapsed since the session start. Covers the start, mid-session, the
#: moment it ends, the 4·tau_Z recovery tail, and well past it.
ACTIVITY_ELAPSED = [0.0, 5.0, 15.0, 30.0, 45.0, 60.0, 90.0, 120.0, 240.0]

#: Patient weights, exercising the allometric (70/w)^0.25 scaling, plus the
#: no-weight case where the scaling must not be applied at all.
ACTIVITY_WEIGHTS = [50.0, 70.0, 100.0, None]

#: Fixed clock for the activity cases. Naive UTC on both sides — the kernel's
#: convention (Arm 5 rule 4); no timezone arithmetic is under test here.
ACTIVITY_START = "2026-03-01T12:00:00"

#: A wearable trace: two-minute ramp, plateau at 150 bpm, cool-down.
WEARABLE_TRACE = [
    {"t_min": 0.0, "hr_bpm": 68.0},
    {"t_min": 2.0, "hr_bpm": 132.0},
    {"t_min": 20.0, "hr_bpm": 150.0},
    {"t_min": 35.0, "hr_bpm": 143.0},
    {"t_min": 45.0, "hr_bpm": 96.0},
]


# ─── Case generation ─────────────────────────────────────────────────────────

def _load_meal_profiles() -> Dict[str, Dict[str, Any]]:
    """Meal absorption profiles from the single source of truth."""
    backend = HERE.parent.parent / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    os.environ.setdefault("MONGO_URI", "mongodb://unused/parity")
    from constants import Constants

    source = Constants.MEAL_ABSORPTION_PROFILES
    out = {}
    for name in MEAL_TYPES:
        p = source[name]
        out[name] = {
            "onset_hours": p["onset_hours"],
            "peak_hours": p["peak_hours"],
            "duration_hours": p["duration_hours"],
            "curve_type": p.get("curve_type", "gamma_standard"),
            "shape_param": p["shape_param"],
            "scale_param": p["scale_param"],
        }
    return out


def _load_hr_model() -> Dict[str, float]:
    """
    The Y/Z/W ODE parameters.

    Unlike the pharmacokinetic profiles these cannot be embedded as *inputs* —
    neither implementation takes them as arguments; both read their own copy of
    the constants. Embedding them anyway lets each side check its copy against
    the case file and fail with "constants out of sync" rather than reporting a
    stale export as a model difference. That is what rule 12 is protecting
    against; this is the closest the activity model allows.
    """
    backend = HERE.parent.parent / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    os.environ.setdefault("MONGO_URI", "mongodb://unused/parity")
    from constants import Constants
    return {k: float(v) for k, v in Constants.HR_MODEL.items()}


def _activity_cases() -> List[Dict[str, Any]]:
    """
    Exercise-model cases.

    Each carries its whole input: session start, clock, duration, intensity,
    direction, and the patient constants the model reads. Nothing is looked up
    by name at evaluation time except HR_MODEL, which is checked separately.
    """
    cases: List[Dict[str, Any]] = []

    def add(tag: str, activity: Dict[str, Any], constants: Dict[str, Any],
            elapsed: float) -> None:
        # The clock is carried as an offset in minutes from start_time, and
        # each side does the addition in its own date type. Pre-formatting a
        # second timestamp string would make ISO parsing part of what is under
        # test, and that is TimeManager's job, not this harness's.
        for fn, family in (("activity_effect", "act_bg"), ("activity_aob", "act_aob")):
            cases.append({
                "id": f"{family}::{tag}::{elapsed}",
                "fn": fn,
                "start_time": ACTIVITY_START,
                "elapsed_minutes": elapsed,
                "activity": activity,
                "patient_constants": constants,
            })

    base_constants = {"hr_base": 70.0, "hr_max": 190.0, "weight_kg": 70.0}

    # The synthetic-trace grid: intensity x duration x elapsed.
    for intensity in ACTIVITY_INTENSITIES:
        for duration in ACTIVITY_DURATIONS:
            activity = {
                "intensity": intensity,
                "duration_minutes": duration,
                "bg_direction": -1,
            }
            for elapsed in ACTIVITY_ELAPSED:
                add(f"{intensity}-{duration:g}m", activity, base_constants, elapsed)

    # Allometric weight scaling, including the no-weight case.
    for weight in ACTIVITY_WEIGHTS:
        constants = {"hr_base": 70.0, "hr_max": 190.0}
        if weight is not None:
            constants["weight_kg"] = weight
        activity = {"intensity": "moderate", "duration_minutes": 45.0, "bg_direction": -1}
        for elapsed in ACTIVITY_ELAPSED:
            add(f"weight-{weight if weight is not None else 'none'}", activity, constants, elapsed)

    # Non-default resting/maximum heart rates, which move the onset gate.
    for hr_base, hr_max in ((55.0, 200.0), (85.0, 165.0)):
        constants = {"hr_base": hr_base, "hr_max": hr_max, "weight_kg": 70.0}
        activity = {"intensity": "moderate", "duration_minutes": 45.0, "bg_direction": -1}
        for elapsed in ACTIVITY_ELAPSED:
            add(f"hr-{hr_base:g}-{hr_max:g}", activity, constants, elapsed)

    # BG-raising sessions — the sign has to travel identically through both.
    activity = {"intensity": "vigorous", "duration_minutes": 30.0, "bg_direction": 1}
    for elapsed in ACTIVITY_ELAPSED:
        add("bg-direction-up", activity, base_constants, elapsed)

    # The wearable-trace path, which bypasses the synthetic trace builder.
    activity = {
        "intensity": "moderate",
        "duration_minutes": 45.0,
        "bg_direction": -1,
        "hr_trace": WEARABLE_TRACE,
    }
    for elapsed in ACTIVITY_ELAPSED:
        add("wearable-trace", activity, base_constants, elapsed)

    # The CGM-override path, which bypasses the ODE entirely.
    for override in (25.0, 60.0):
        activity = {
            "intensity": "moderate",
            "duration_minutes": 60.0,
            "bg_direction": -1,
            "bg_drop_override": override,
        }
        for elapsed in ACTIVITY_ELAPSED:
            add(f"cgm-override-{override:g}", activity, base_constants, elapsed)

    return cases

def _load_profiles() -> Dict[str, Dict[str, Any]]:
    """Pharmacokinetic profiles from the single source of truth."""
    backend = HERE.parent.parent / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    os.environ.setdefault("MONGO_URI", "mongodb://unused/parity")
    from constants import Constants

    factors = Constants.DEFAULT_PATIENT_CONSTANTS["medication_factors"]
    profiles = {}
    for name in INSULIN_TYPES:
        p = factors[name]
        profiles[name] = {
            "onset_hours": p["onset_hours"],
            "peak_hours": p["peak_hours"],
            "duration_hours": p["duration_hours"],
            "is_peakless": p.get("is_peakless", False),
            "curve_type": p.get("curve_type", "gamma_steep"),
            "type": p.get("type", "rapid_acting"),
        }
    return profiles


def generate() -> Dict[str, Any]:
    """
    Build the shared case file.

    Profiles are embedded rather than looked up by name on each side. If the
    TypeScript build carried a stale copy of the constants, a name-based
    lookup would compare two different curves and the harness would report a
    model difference that is really a sync problem. Embedding isolates the
    question to the mathematics.
    """
    profiles = _load_profiles()
    meal_profiles = _load_meal_profiles()
    cases: List[Dict[str, Any]] = []

    for insulin_type, profile in profiles.items():
        for hours in HOURS:
            cases.append({
                "id": f"activity::{insulin_type}::{hours}",
                "fn": "insulin_activity",
                "hours_since_dose": hours,
                "profile": profile,
            })
            for dose in DOSES:
                cases.append({
                    "id": f"iob::{insulin_type}::{hours}::{dose}",
                    "fn": "iob",
                    "hours_since_dose": hours,
                    "dose": dose,
                    "profile": profile,
                })

    # Meal absorption. The grid is expressed as a fraction of each profile's
    # own duration so the same case index lands on the same feature of every
    # curve, and includes points past the window where both sides must return
    # the truncated value rather than extrapolating.
    for meal_type, profile in meal_profiles.items():
        for fraction in MEAL_FRACTIONS:
            hours = round(fraction * profile["duration_hours"], 6)
            cases.append({
                "id": f"meal_act::{meal_type}::{fraction}",
                "fn": "meal_activity",
                "hours_since_meal": hours,
                "profile": profile,
            })
            cases.append({
                "id": f"meal_abs::{meal_type}::{fraction}",
                "fn": "meal_absorbed",
                "hours_since_meal": hours,
                "profile": profile,
            })

    cases.extend(_activity_cases())

    payload = {
        "version": 2,
        "note": "Generated by diatwin.verify.parity. Do not hand-edit.",
        "tolerance": TOLERANCE,
        # Not an input to any case — a checksum. Both sides assert their own
        # HR_MODEL matches this, so a stale constants export fails as a sync
        # problem rather than surfacing as a model difference.
        "hr_model": _load_hr_model(),
        "cases": cases,
    }
    FIXTURES.mkdir(parents=True, exist_ok=True)
    CASES_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


# ─── Python side ─────────────────────────────────────────────────────────────

def evaluate_python() -> Dict[str, float]:
    """Run every case through the Python kernel."""
    backend = HERE.parent.parent / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    os.environ.setdefault("MONGO_URI", "mongodb://unused/parity")
    from datetime import datetime, timedelta

    from utils import pharmacodynamics as pk
    from utils import activity_pharmacodynamics as apk

    payload = json.loads(CASES_FILE.read_text(encoding="utf-8"))

    # Constants sync check — see _load_hr_model().
    embedded = payload.get("hr_model")
    if embedded is not None:
        mine = {k: float(v) for k, v in apk.HR_MODEL.items()}
        if mine != {k: float(v) for k, v in embedded.items()}:
            raise SystemExit(
                "HR_MODEL in backend/constants.py does not match the case file.\n"
                "  Regenerate the cases before comparing — otherwise a constants\n"
                "  desync is reported as a model difference.\n"
                f"  case file: {embedded}\n  backend:   {mine}"
            )

    results: Dict[str, float] = {}

    for case in payload["cases"]:
        fn = case["fn"]
        if fn == "insulin_activity":
            value = pk.calculate_insulin_activity(case["hours_since_dose"], case["profile"])
        elif fn == "iob":
            value = pk.calculate_iob(case["hours_since_dose"], case["dose"], case["profile"])
        elif fn == "meal_activity":
            value = pk.calculate_gamma_absorption(case["hours_since_meal"], case["profile"])
        elif fn == "meal_absorbed":
            # An empty profile map forces calculate_meal_activity_percentage down
            # its direct branch, so the embedded profile is the only input and
            # nothing is looked up by name (rule 12).
            value = pk.calculate_absorbed_fraction(
                case["hours_since_meal"], case["profile"], {})
        elif fn in ("activity_effect", "activity_aob"):
            start = datetime.fromisoformat(case["start_time"])
            current = start + timedelta(minutes=case["elapsed_minutes"])
            activity = dict(case["activity"])
            activity["timestamp"] = start
            if fn == "activity_effect":
                value = apk.calculate_activity_cumulative_effect(
                    activity, current, case["patient_constants"])
            else:
                value = apk.get_activity_on_board(
                    activity, current, case["patient_constants"])["remaining_bg_drop"]
        else:
            raise ValueError(f"unknown fn {fn!r}")
        results[case["id"]] = float(value)

    PY_RESULTS.write_text(json.dumps(results, indent=2, sort_keys=True), encoding="utf-8")
    return results


# ─── Comparison ──────────────────────────────────────────────────────────────

def _divergences() -> tuple[Dict[str, float], List[str], List[str], List[str]]:
    """
    Compare the two result files without judging them.

    Returns (worst delta per family, diverging ids, python-only ids,
    typescript-only ids). Splitting this out is what lets ``compare`` and
    ``baseline`` share exactly one definition of "these differ".
    """
    py = json.loads(PY_RESULTS.read_text(encoding="utf-8"))
    ts = json.loads(TS_RESULTS.read_text(encoding="utf-8"))

    only_py = sorted(set(py) - set(ts))
    only_ts = sorted(set(ts) - set(py))
    shared = sorted(set(py) & set(ts))

    worst: Dict[str, float] = {}
    diverging: List[str] = []

    for case_id in shared:
        kind = case_id.split("::", 1)[0]
        tol = TOLERANCE.get(kind, 1e-6)
        a, b = py[case_id], ts[case_id]
        if math.isnan(a) or math.isnan(b):
            diverging.append(case_id)
            continue
        delta = abs(a - b)
        if delta > worst.get(kind, -1.0):
            worst[kind] = delta
        if delta > tol:
            diverging.append(case_id)

    return worst, diverging, only_py, only_ts


def load_baseline() -> Dict[str, Any]:
    """The recorded divergences, or an empty baseline if none has been written."""
    if not BASELINE.exists():
        return {"note": "no baseline recorded", "cases": []}
    return json.loads(BASELINE.read_text(encoding="utf-8"))


def write_baseline() -> Dict[str, Any]:
    """
    Re-record the current divergences as the accepted baseline.

    Run this only after a deliberate decision about the divergence — either it
    has been accepted (Arm 5 §5.1) or it has been fixed and the file should
    shrink. Running it to silence a failing build defeats the harness.
    """
    _, diverging, _, _ = _divergences()
    payload = {
        "note": (
            "Case ids known to diverge between the Python and TypeScript "
            "implementations. compare() fails only on divergence NOT listed "
            "here. See Arm 5 §5.1 for why these are accepted. Regenerate with "
            "`python -m diatwin.verify.parity baseline` only after a deliberate "
            "decision, never to quiet a red build."
        ),
        "count": len(diverging),
        "cases": sorted(diverging),
    }
    BASELINE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def compare(*, verbose: bool = False) -> int:
    """
    Compare the two result files. Returns a process exit status.

    Divergence already recorded in the baseline is reported but does not fail
    the build; anything else does. A baselined case that has started agreeing
    is reported as well, because it means the baseline can shrink.

    Reports the worst divergence per family so a failure names the curve to
    look at, rather than only the first case that happened to trip.
    """
    for path, side in ((PY_RESULTS, "python"), (TS_RESULTS, "typescript")):
        if not path.exists():
            print(f"missing {side} results: {path}", file=sys.stderr)
            print(f"  run:  python -m diatwin.verify.parity {side}"
                  if side == "python" else
                  "  run:  cd mobile && npx jest __tests__/parity", file=sys.stderr)
            return 2

    py = json.loads(PY_RESULTS.read_text(encoding="utf-8"))
    ts = json.loads(TS_RESULTS.read_text(encoding="utf-8"))
    worst, diverging, only_py, only_ts = _divergences()

    baselined = set(load_baseline()["cases"])
    diverging_set = set(diverging)
    new = sorted(diverging_set - baselined)
    fixed = sorted(baselined - diverging_set)
    expected = sorted(diverging_set & baselined)

    shared = len(set(py) & set(ts))
    families = sorted({c.split("::", 1)[0] for c in set(py) & set(ts)})
    print(f"parity: {shared} shared cases across {len(families)} families")
    for kind in families:
        delta = worst.get(kind, 0.0)
        tol = TOLERANCE.get(kind, 1e-6)
        flag = "" if delta <= tol else "   <-- outside tolerance"
        print(f"  {kind:10} worst delta = {delta:.3e}  (tol {tol:.0e}){flag}")

    print(f"\nbaseline: {len(baselined)} recorded, {len(expected)} still diverging, "
          f"{len(fixed)} now agreeing, {len(new)} new")

    if only_py or only_ts:
        print(f"\ncase-set mismatch: {len(only_py)} python-only, {len(only_ts)} typescript-only")
        for case_id in (only_py + only_ts)[:5]:
            print(f"  {case_id}")
        print("  both sides must evaluate the same generated case file")
        return 1

    if fixed:
        print(f"\n{len(fixed)} baselined case(s) now agree — the baseline can shrink:")
        for case_id in fixed[:10]:
            print(f"  {case_id}")
        if len(fixed) > 10:
            print(f"  ... and {len(fixed) - 10} more")
        print("  re-record with:  python -m diatwin.verify.parity baseline")

    if new:
        print(f"\n{len(new)} NEW divergence(s), not in the baseline:")
        for case_id in new[:20]:
            a, b = py[case_id], ts[case_id]
            print(f"  {case_id}\n      python={a!r}  typescript={b!r}  "
                  f"delta={abs(a - b):.6g} > {TOLERANCE.get(case_id.split('::', 1)[0], 1e-6):g}")
        if len(new) > 20:
            print(f"  ... and {len(new) - 20} more")
        return 1

    if verbose and expected:
        print(f"\nbaselined divergences (not failing the build):")
        for case_id in expected[:20]:
            print(f"  {case_id}")

    if expected:
        print(f"\nparity OK — no new divergence "
              f"({len(expected)} baselined, see Arm 5 §5.1)")
    else:
        print("\nparity OK — both implementations agree within tolerance")
    return 0


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("command",
                        choices=["generate", "python", "compare", "baseline", "all"])
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.command in ("generate", "all"):
        payload = generate()
        print(f"generated {len(payload['cases'])} cases -> {CASES_FILE}")
    if args.command in ("python", "all"):
        results = evaluate_python()
        print(f"evaluated {len(results)} cases (python) -> {PY_RESULTS}")
    if args.command == "compare":
        return compare(verbose=args.verbose)
    if args.command == "baseline":
        payload = write_baseline()
        print(f"recorded {payload['count']} divergence(s) -> {BASELINE}")
        return 0
    if args.command == "all":
        print("\nnow run:  cd mobile && npx jest __tests__/parity")
        print("then:     python -m diatwin.verify.parity compare")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
