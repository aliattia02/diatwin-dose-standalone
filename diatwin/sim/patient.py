"""
The pharmacodynamic kernel as a forward simulator.

``backend/utils/pharmacodynamics.py`` and ``activity_pharmacodynamics.py``
import no database code — they are pure functions over documents and a
constants dict. That makes them usable directly as system dynamics, which is
the precondition for both physics-informed features (the ML step) and an
environment to learn a policy in (the RL step).

This module supplies the two things the kernel does not:

*   **An adapter.** The kernel takes raw Mongo-shaped dicts with
    *timezone-naive* UTC datetimes. The canonical schema uses aware UTC.
    One place converts; nothing else needs to know.

*   **A state object.** :class:`PatientState` names what the kernel returns
    so callers stop indexing into nested dicts by string key.

Deliberately *not* here: a ``gymnasium.Env``. That belongs in
``diatwin/sim/env.py`` once a reward is agreed, and it should be a thin
wrapper over :class:`PatientSim` — keeping the dynamics importable without a
reinforcement-learning dependency is what lets the same code serve feature
generation and CI.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from ..data.schema import (
    ActivityEvent,
    GlucoseReading,
    InsulinDose,
    MealEvent,
    PatientProfile,
)

# ─── Kernel import ───────────────────────────────────────────────────────────
# The kernel still lives under backend/ and imports its siblings by bare name
# ("from constants import ...", "from time_manager import ..."), so backend/
# has to be on the path. Phase B of the migration moves these files into
# diatwin/core/ and this shim disappears.

_BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)
os.environ.setdefault("MONGO_URI", "mongodb://unused/simulation")

from constants import Constants                                  # noqa: E402
from utils import pharmacodynamics as pk                          # noqa: E402
from utils import activity_pharmacodynamics as apk                # noqa: E402

ABSORPTION_PROFILES = Constants.MEAL_ABSORPTION_PROFILES
DEFAULT_CONSTANTS = Constants.DEFAULT_PATIENT_CONSTANTS


# ─── Boundary conversion ─────────────────────────────────────────────────────

def _naive(t: datetime) -> datetime:
    """Aware UTC → naive UTC, the kernel's convention."""
    return t.astimezone(timezone.utc).replace(tzinfo=None)


def carb_equivalent(meal: MealEvent, constants: Dict[str, Any]) -> float:
    """
    Protein/fat-adjusted carbohydrate equivalent, in grams.

    Mirrors ``backend/meal_insulin.py:683`` exactly, including the ADA
    net-carb convention of subtracting fibre in full.

    This has to be supplied explicitly, because two kernel functions disagree
    about what to do when it is absent:
    ``calculate_meal_active_carbs`` falls back to ``carbs + protein + fat``
    (no factors, so an overestimate), while
    ``calculate_meal_cumulative_effect`` silently returns 0.0. A meal document
    written without it therefore contributes to MOB but nothing at all to the
    cumulative meal effect. Computing it here keeps the two consistent.
    """
    protein_factor = float(constants.get("protein_factor", 0.5) or 0.5)
    fat_factor = float(constants.get("fat_factor", 0.2) or 0.2)
    return round(max(0.0, meal.carbs_g
                     + meal.protein_g * protein_factor
                     + meal.fat_g * fat_factor
                     - getattr(meal, "fiber_g", 0.0)), 1)


def meal_to_doc(meal: MealEvent, constants: Dict[str, Any]) -> Dict[str, Any]:
    """:class:`MealEvent` → the dict shape the meal functions read."""
    return {
        "timestamp": _naive(meal.t),
        "mealType": meal.meal_type,
        "nutrition": {
            "carbs": meal.carbs_g,
            "protein": meal.protein_g,
            "fat": meal.fat_g,
            "fiber": getattr(meal, "fiber_g", 0.0),
            "absorption_type": meal.absorption_type,
            "total_carb_equiv": carb_equivalent(meal, constants),
        },
    }


def dose_to_doc(dose: InsulinDose) -> Dict[str, Any]:
    """:class:`InsulinDose` → the dict shape the insulin functions read."""
    return {
        "taken_at": _naive(dose.t),
        "administrationTime": _naive(dose.t),
        "dose": dose.units,
        "medication": dose.insulin_type,
        "is_insulin": True,
    }


def activity_to_doc(act: ActivityEvent) -> Dict[str, Any]:
    """:class:`ActivityEvent` → the dict ``normalize_activity_record`` reads."""
    return {
        "startTime": _naive(act.t),
        "timestamp": _naive(act.t),
        "intensity": act.intensity,
        "duration_minutes": act.duration_min,
        "mean_hr": act.mean_hr,
        "bg_direction": act.bg_direction,
    }


# ─── State ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PatientState:
    """
    Physiological state at one instant, as the kernel computes it.

    Field names mirror the domain vocabulary rather than the kernel's dict
    keys, so downstream feature code reads as physiology and not as JSON.
    """

    t: datetime
    iob: float = 0.0                  # units still active
    mob: float = 0.0                  # grams still absorbing
    insulin_effect: float = 0.0       # mg/dL, cumulative and negative
    meal_effect: float = 0.0          # mg/dL, cumulative and positive
    activity_effect: float = 0.0      # mg/dL, signed
    net_effect: float = 0.0           # mg/dL, sum of the three
    baseline_bg: float = 100.0        # mg/dL, circadian baseline
    predicted_bg: float = 100.0       # mg/dL, baseline + net effect
    sensitivity_multiplier: float = 1.0

    def as_features(self) -> Dict[str, float]:
        """Flat float dict, ready to become a feature row."""
        return {
            "iob": self.iob,
            "mob": self.mob,
            "insulin_effect": self.insulin_effect,
            "meal_effect": self.meal_effect,
            "activity_effect": self.activity_effect,
            "net_effect": self.net_effect,
            "baseline_bg": self.baseline_bg,
            "pd_predicted_bg": self.predicted_bg,
            "sensitivity_multiplier": self.sensitivity_multiplier,
        }


# ─── Simulator ───────────────────────────────────────────────────────────────

@dataclass
class PatientSim:
    """
    Forward evaluation of the PD kernel for one patient.

    Two uses, same object:

    *   **Feature generation.** Call :meth:`state_at` for every point on the
        grid to get physics-derived columns aligned with the CGM series.
    *   **Rollout.** Call :meth:`apply` then :meth:`state_at` to ask what
        would happen under a hypothetical dose — the transition function an
        RL environment steps.

    ``events`` is mutable so a rollout can branch. Copy the simulator before
    exploring an alternative action if the original must be preserved.
    """

    profile: PatientProfile
    meals: List[MealEvent] = field(default_factory=list)
    insulin: List[InsulinDose] = field(default_factory=list)
    activity: List[ActivityEvent] = field(default_factory=list)

    #: How far back the kernel looks for still-active events. Longer than the
    #: longest insulin duration so nothing active is ever truncated away.
    lookback: timedelta = timedelta(hours=36)

    @property
    def constants(self) -> Dict[str, Any]:
        merged = dict(DEFAULT_CONSTANTS)
        merged.update(self.profile.constants or {})
        return merged

    # ── mutation ────────────────────────────────────────────────────────────

    def apply(self, event: MealEvent | InsulinDose | ActivityEvent) -> "PatientSim":
        """Add one event. Returns self so calls chain."""
        if isinstance(event, MealEvent):
            self.meals.append(event)
        elif isinstance(event, InsulinDose):
            self.insulin.append(event)
        elif isinstance(event, ActivityEvent):
            self.activity.append(event)
        else:
            raise TypeError(f"cannot apply {type(event).__name__}")
        return self

    def copy(self) -> "PatientSim":
        """Independent branch, for exploring an alternative action."""
        return PatientSim(
            profile=self.profile,
            meals=list(self.meals),
            insulin=list(self.insulin),
            activity=list(self.activity),
            lookback=self.lookback,
        )

    # ── evaluation ──────────────────────────────────────────────────────────

    def _window(self, seq: Sequence[Any], t: datetime) -> List[Any]:
        """Events in ``(t - lookback, t]`` — the kernel ignores the rest anyway."""
        lo = t - self.lookback
        return [e for e in seq if lo < e.t <= t]

    def state_at(self, t: datetime, *, last_reading: Optional[GlucoseReading] = None) -> PatientState:
        """
        Evaluate the kernel at ``t``.

        Only events at or before ``t`` are visible, so this is safe to call
        across a whole grid without leaking the future into a feature.

        ``last_reading`` anchors the dynamic baseline when supplied; without
        it the circadian preset baseline is used. Which of the two a dataset
        uses is a modelling decision that must be recorded with the run —
        the two produce materially different targets.
        """
        naive_t = _naive(t)
        constants = self.constants
        reset_hour = int(self.profile.daily_reset_hour)
        tz_off = int(self.profile.tz_offset_min)

        active_meals = self._window(self.meals, t)
        active_doses = self._window(self.insulin, t)
        meal_docs = [meal_to_doc(m, constants) for m in active_meals]
        dose_docs = [dose_to_doc(d) for d in active_doses]
        act_docs = [activity_to_doc(a) for a in self._window(self.activity, t)]

        # Cumulative (daily-resetting) effects — flat snake_case return.
        totals = pk.calculate_total_cumulative_effects(
            meal_docs, dose_docs, naive_t, constants, ABSORPTION_PROFILES,
            reset_hour=reset_hour, timezone_offset_minutes=tz_off,
        ) or {}
        meal_effect = float(totals.get("cumulative_meal_effect", 0.0) or 0.0)
        insulin_effect = float(totals.get("cumulative_insulin_effect", 0.0) or 0.0)

        # On-board quantities come from separate functions — they are the
        # instantaneous state, not the daily-resetting accumulator.
        mob = sum(
            float((pk.calculate_meal_active_carbs(doc, naive_t, constants, ABSORPTION_PROFILES)
                   or {}).get("active_carbs", 0.0) or 0.0)
            for doc in meal_docs
        )
        iob = sum(_iob_for(dose, naive_t, constants) for dose in active_doses)

        activity_result: Dict[str, Any] = {}
        normalized = [r for r in (apk.normalize_activity_record(d) for d in act_docs) if r]
        if normalized:
            activity_result = apk.calculate_stacked_activity_effect(normalized, naive_t, constants) or {}

        activity_effect = float(activity_result.get("cumulative_activity_effect", 0.0) or 0.0)
        sensitivity = float(activity_result.get("sensitivity_multiplier", 1.0) or 1.0)

        baseline = _baseline_at(constants, t, last_reading)
        net = insulin_effect + meal_effect + activity_effect

        return PatientState(
            t=t,
            iob=float(iob),
            mob=float(mob),
            insulin_effect=float(insulin_effect),
            meal_effect=float(meal_effect),
            activity_effect=activity_effect,
            net_effect=float(net),
            baseline_bg=float(baseline),
            predicted_bg=float(baseline + net),
            sensitivity_multiplier=sensitivity,
        )

    def trajectory(
        self,
        grid: Sequence[datetime],
        *,
        last_reading: Optional[GlucoseReading] = None,
    ) -> List[PatientState]:
        """State at every grid point. This is the physics feature block."""
        return [self.state_at(t, last_reading=last_reading) for t in grid]


# ─── helpers ─────────────────────────────────────────────────────────────────

def insulin_profile(insulin_type: str, constants: Dict[str, Any]) -> Dict[str, Any]:
    """
    Pharmacokinetic profile for an insulin type.

    Falls back to ``insulin_aspart`` rather than ``regular_insulin``: the
    latter is an 8-hour short-acting curve, so defaulting to it would stretch
    a rapid-acting dose across twice its real duration. The kernel made the
    same correction at ``pharmacodynamics.py:759``.
    """
    factors = constants.get("medication_factors") or {}
    profile = factors.get(insulin_type) or factors.get("insulin_aspart") or {}
    return {
        "onset_hours": float(profile.get("onset_hours", 0.375)),
        "peak_hours": float(profile.get("peak_hours", 2.25)),
        "duration_hours": float(profile.get("duration_hours", 4.5)),
        "is_peakless": bool(profile.get("is_peakless", False)),
        "curve_type": profile.get("curve_type", "gamma_steep"),
    }


def _iob_for(dose: InsulinDose, naive_now: datetime, constants: Dict[str, Any]) -> float:
    """Units of ``dose`` still active at ``naive_now``."""
    hours = (naive_now - _naive(dose.t)).total_seconds() / 3600.0
    if hours < 0:
        return 0.0
    try:
        return float(pk.calculate_iob(hours, dose.units, insulin_profile(dose.insulin_type, constants)))
    except Exception:
        return 0.0


def _baseline_at(
    constants: Dict[str, Any],
    t: datetime,
    last_reading: Optional[GlucoseReading],
) -> float:
    """Circadian baseline at ``t``, anchored to ``last_reading`` when given."""
    target = float(constants.get("target_glucose", 100) or 100)
    try:
        from constants import get_circadian_baseline_at_hour
        local_hour = ((t.hour * 60 + t.minute + int(constants.get("timezone_offset_minutes", 0) or 0)) % 1440) / 60.0
        profile = constants.get("circadian_profile") or Constants.DEFAULT_CIRCADIAN_PROFILE
        baseline = float(get_circadian_baseline_at_hour(local_hour, profile))
    except Exception:
        baseline = target
    return baseline
