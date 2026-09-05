"""
Cross-language parity harness.

The insulin, meal and activity models are implemented three times — in Python
under ``backend/utils/``, in TypeScript under ``mobile/utils/``, and in
JavaScript under ``frontend/src/utils/`` — on purpose, as independent
implementations of the same mathematics. That is a recognised verification
technique, but it only *is* verification if something actually compares them.
Otherwise it is just three chances to be wrong.

This module is that comparison.

    python -m diatwin.verify.parity generate    # write the shared case file
    python -m diatwin.verify.parity python      # evaluate the Python side
    cd mobile && npx jest __tests__/parity      # evaluate the TypeScript side
    node diatwin/verify/frontend_eval.mjs       # evaluate the frontend side
    python -m diatwin.verify.parity compare     # assert agreement, exit 1 on drift
    python -m diatwin.verify.parity baseline    # re-record the known divergences

Every side reads the *same* ``cases.json`` and writes results keyed by case id,
so no implementation can influence another's inputs. ``compare`` returns a
non-zero exit status on divergence, which is what makes it usable as a CI gate.

All three pairs are compared rather than nominating one side as the reference.
With two implementations a disagreement says only that they differ; with three,
a case where two agree and one does not names the side that stands alone, and
that is evidence about where an edit belongs.

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
FE_RESULTS = FIXTURES / "results_frontend.json"
BASELINE = FIXTURES / "baseline_divergences.json"

#: The three independent implementations. Order matters only for display.
SIDE_NAMES = ("python", "typescript", "frontend")


def sides() -> Dict[str, Path]:
    """
    Where each side writes its results.

    Resolved on every call rather than frozen at import, so a test can point
    the harness at throwaway files by setting the module-level paths. A dict
    built once at import would capture the originals and quietly ignore that.
    """
    return {"python": PY_RESULTS, "typescript": TS_RESULTS, "frontend": FE_RESULTS}


HOW_TO_RUN: Dict[str, str] = {
    "python": "python -m diatwin.verify.parity python",
    "typescript": "cd mobile && npx jest __tests__/parity",
    "frontend": "node diatwin/verify/frontend_eval.mjs",
}

#: Every pair is compared. Comparing pairwise rather than against a nominated
#: reference is the point: when one side stands alone, the pair table says
#: which one, and that is evidence about where an edit belongs. A single
#: "correct" side chosen in advance would assume the answer.
PAIRS: List[tuple[str, str]] = [
    ("python", "typescript"),
    ("python", "frontend"),
    ("typescript", "frontend"),
]


def pair_key(a: str, b: str) -> str:
    """Stable name for a pair, used as the baseline file's key."""
    return "|".join(sorted((a, b)))


def _node() -> str:
    """
    The node executable, resolved through PATH.

    ``shutil.which`` rather than a bare ``"node"`` because on Windows the
    launcher is ``node.exe`` and ``subprocess.run`` without a shell will not
    find it by the bare name in every environment.
    """
    import shutil
    found = shutil.which("node")
    if found is None:
        raise SystemExit(
            "node is not on PATH — the frontend side of the harness needs it.\n"
            "  the other two sides still run:  python -m diatwin.verify.parity python")
    return found


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

def load_results() -> Dict[str, Dict[str, float]]:
    """Read every side's result file. Raises FileNotFoundError if one is absent."""
    return {
        side: json.loads(path.read_text(encoding="utf-8"))
        for side, path in sides().items()
    }


def _diverge_pair(
    left: Dict[str, float], right: Dict[str, float],
) -> tuple[Dict[str, float], List[str], List[str], List[str]]:
    """
    Compare two result maps without judging them.

    Returns (worst delta per family, diverging ids, left-only ids,
    right-only ids). Splitting this out is what lets ``compare`` and
    ``baseline`` share exactly one definition of "these differ".
    """
    only_left = sorted(set(left) - set(right))
    only_right = sorted(set(right) - set(left))
    shared = sorted(set(left) & set(right))

    worst: Dict[str, float] = {}
    diverging: List[str] = []

    for case_id in shared:
        kind = case_id.split("::", 1)[0]
        tol = TOLERANCE.get(kind, 1e-6)
        a, b = left[case_id], right[case_id]
        if math.isnan(a) or math.isnan(b):
            diverging.append(case_id)
            continue
        delta = abs(a - b)
        if delta > worst.get(kind, -1.0):
            worst[kind] = delta
        if delta > tol:
            diverging.append(case_id)

    return worst, diverging, only_left, only_right


def _divergences(
    results: Dict[str, Dict[str, float]] | None = None,
) -> Dict[str, tuple[Dict[str, float], List[str], List[str], List[str]]]:
    """Every pair's comparison, keyed by :func:`pair_key`."""
    if results is None:
        results = load_results()
    return {
        pair_key(a, b): _diverge_pair(results[a], results[b])
        for a, b in PAIRS
    }


def _odd_one_out(
    results: Dict[str, Dict[str, float]], diverging: Dict[str, List[str]],
) -> Dict[str, List[str]]:
    """
    For each case that diverges at all, name the side that stands alone.

    A case where two sides agree and the third does not is a much stronger
    signal than three-way disagreement: it says where the edit belongs. The
    return maps a side name — or ``"three-way"`` — to the case ids.
    """
    touched = sorted({cid for ids in diverging.values() for cid in ids})
    verdict: Dict[str, List[str]] = {}
    for case_id in touched:
        bad = [(a, b) for a, b in PAIRS if case_id in diverging[pair_key(a, b)]]
        if len(bad) == 3:
            label = "three-way"
        elif len(bad) == 2:
            # The side common to both failing pairs is the one standing alone.
            label = next(iter(set(bad[0]) & set(bad[1])))
        else:
            # Exactly one pair outside tolerance while each of those two sides
            # is within tolerance of the third. Not an outlier — a case sitting
            # on the tolerance boundary, and worth seeing as its own class
            # rather than being filed under a side.
            label = "straddle"
        verdict.setdefault(label, []).append(case_id)
    return verdict


def load_baseline() -> Dict[str, Any]:
    """
    The recorded divergences, or an empty baseline if none has been written.

    Normalises both the two-sided and the three-sided file shapes onto
    ``pairs``. Before the frontend became a side, the file held a flat
    ``cases`` list that meant python-versus-typescript and could not mean
    anything else; that list is still read as exactly that pair. The 205 it
    records are evidence of a decision taken in Arm 5 §5.1, and rewriting the
    file to a new shape would quietly restate that decision as something a
    tool did (rule 15).
    """
    if not BASELINE.exists():
        raw: Dict[str, Any] = {"note": "no baseline recorded", "cases": []}
    else:
        raw = json.loads(BASELINE.read_text(encoding="utf-8"))

    pairs: Dict[str, List[str]] = {pair_key(a, b): [] for a, b in PAIRS}
    if "pairs" in raw:
        for key, ids in raw["pairs"].items():
            pairs[key] = list(ids)
    else:
        pairs[pair_key("python", "typescript")] = list(raw.get("cases", []))

    raw["pairs"] = pairs
    return raw


def write_baseline() -> Dict[str, Any]:
    """
    Re-record the current divergences as the accepted baseline.

    Run this only after a deliberate decision about the divergence — either it
    has been accepted (Arm 5 §5.1) or it has been fixed and the file should
    shrink. Running it to silence a failing build defeats the harness
    (rule 15).
    """
    per_pair = _divergences()
    pairs = {key: sorted(entry[1]) for key, entry in per_pair.items()}
    payload = {
        "note": (
            "Case ids known to diverge, per pair of implementations. compare() "
            "fails only on divergence NOT listed here. See Arm 5 §5.1 for why "
            "the python|typescript entries are accepted. Regenerate with "
            "`python -m diatwin.verify.parity baseline` only after a deliberate "
            "decision, never to quiet a red build."
        ),
        "count": sum(len(v) for v in pairs.values()),
        # Kept so a reader who knows only the two-sided shape still finds the
        # python-versus-typescript list where it has always been.
        "cases": pairs[pair_key("python", "typescript")],
        "pairs": pairs,
    }
    BASELINE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def compare(*, verbose: bool = False) -> int:
    """
    Compare all three result files, pairwise. Returns a process exit status.

    Divergence already recorded in the baseline is reported but does not fail
    the build; anything else does. A baselined case that has started agreeing
    is reported as well, because it means the baseline can shrink.

    Reports the worst divergence per family *per pair*, so a failure names both
    the curve to look at and the side that carries it. Where two sides agree
    and one does not, the odd-one-out summary says which — that is the whole
    reason for having a third implementation rather than a second.
    """
    where = sides()
    missing = [side for side, path in where.items() if not path.exists()]
    if missing:
        for side in missing:
            print(f"missing {side} results: {where[side]}", file=sys.stderr)
            print(f"  run:  {HOW_TO_RUN[side]}", file=sys.stderr)
        return 2

    results = load_results()
    per_pair = _divergences(results)
    baseline_pairs = load_baseline()["pairs"]

    common = set.intersection(*(set(r) for r in results.values()))
    families = sorted({c.split("::", 1)[0] for c in common})
    print(f"parity: {len(common)} cases shared by all {len(SIDE_NAMES)} implementations "
          f"across {len(families)} families")

    # Worst delta per family per pair. One row per family keeps the three
    # columns side by side, which is what makes an outlier visible at a glance.
    header = f"  {'family':10}" + "".join(f"{pair_key(a, b):>26}" for a, b in PAIRS)
    print(f"\n{header}")
    for kind in families:
        tol = TOLERANCE.get(kind, 1e-6)
        row = f"  {kind:10}"
        for a, b in PAIRS:
            worst = per_pair[pair_key(a, b)][0].get(kind, 0.0)
            mark = " " if worst <= tol else "!"
            row += f"{worst:>25.3e}{mark}"
        print(f"{row}   (tol {tol:.0e})")
    print("  ! = outside tolerance for that pair")

    # A family or case dropping out of one side would make that pair pass by
    # comparing nothing, which is the one failure mode a pairwise comparison
    # cannot detect on its own.
    mismatched = False
    for a, b in PAIRS:
        _, _, only_a, only_b = per_pair[pair_key(a, b)]
        if only_a or only_b:
            mismatched = True
            print(f"\ncase-set mismatch {a} vs {b}: "
                  f"{len(only_a)} {a}-only, {len(only_b)} {b}-only")
            for case_id in (only_a + only_b)[:5]:
                print(f"  {case_id}")
    if mismatched:
        print("  every side must evaluate the same generated case file")
        return 1

    diverging = {key: entry[1] for key, entry in per_pair.items()}

    status = 0
    print()
    for a, b in PAIRS:
        key = pair_key(a, b)
        baselined = set(baseline_pairs.get(key, []))
        diverging_set = set(diverging[key])
        new = sorted(diverging_set - baselined)
        fixed = sorted(baselined - diverging_set)
        expected = sorted(diverging_set & baselined)
        print(f"{key:26} {len(diverging_set):5} diverging   "
              f"{len(baselined):5} baselined   {len(fixed):5} now agreeing   "
              f"{len(new):5} NEW")

        if fixed:
            print(f"  {len(fixed)} baselined case(s) now agree — the baseline can shrink:")
            for case_id in fixed[:10]:
                print(f"    {case_id}")
            if len(fixed) > 10:
                print(f"    ... and {len(fixed) - 10} more")
            print("    re-record with:  python -m diatwin.verify.parity baseline")

        if new:
            status = 1
            print(f"  {len(new)} NEW divergence(s), not in the baseline:")
            for case_id in new[:20]:
                x, y = results[a][case_id], results[b][case_id]
                tol = TOLERANCE.get(case_id.split("::", 1)[0], 1e-6)
                print(f"    {case_id}\n        {a}={x!r}  {b}={y!r}  "
                      f"delta={abs(x - y):.6g} > {tol:g}")
            if len(new) > 20:
                print(f"    ... and {len(new) - 20} more")

        if verbose and expected:
            print(f"  baselined (not failing the build): {len(expected)}")
            for case_id in expected[:20]:
                print(f"    {case_id}")

    verdict = _odd_one_out(results, diverging)
    if verdict:
        print("\nwhere the disagreement sits:")
        for label in sorted(verdict, key=lambda k: -len(verdict[k])):
            ids = verdict[label]
            fams = sorted({c.split("::", 1)[0] for c in ids})
            how = (f"{label} disagrees with the other two"
                   if label in SIDE_NAMES else
                   "all three disagree" if label == "three-way" else
                   "one pair outside tolerance, each within it of the third")
            print(f"  {len(ids):5}  {how:52} [{', '.join(fams)}]")

    if status:
        return 1

    total_baselined = sum(len(v) for v in baseline_pairs.values())
    if total_baselined:
        print(f"\nparity OK — no new divergence "
              f"({total_baselined} baselined, see Arm 5 §5.1)")
    else:
        print("\nparity OK — all three implementations agree within tolerance")
    return 0


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument(
        "command",
        choices=["generate", "python", "frontend", "compare", "baseline", "all"])
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.command in ("generate", "all"):
        payload = generate()
        print(f"generated {len(payload['cases'])} cases -> {CASES_FILE}")
    if args.command in ("python", "all"):
        results = evaluate_python()
        print(f"evaluated {len(results)} cases (python) -> {PY_RESULTS}")
    if args.command in ("frontend", "all"):
        # The frontend modules are ES modules with no React in them, so Node
        # runs them directly. Shelling out keeps that evaluator a peer of the
        # jest one rather than something Python re-implements.
        import subprocess
        script = HERE / "frontend_eval.mjs"
        proc = subprocess.run([_node(), str(script)], cwd=HERE.parents[1])
        if proc.returncode:
            return proc.returncode
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
