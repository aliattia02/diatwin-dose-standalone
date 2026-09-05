"""
Canonical event schema.

Everything downstream — feature building, the simulator, the RL environment,
the parity harness — consumes these types and nothing else. Raw Mongo
documents never travel past ``diatwin.data.normalize``.

Three rules hold for every record in this module:

1.  ``t`` is a timezone-aware UTC ``datetime``. There is exactly one time
    axis. Local wall-clock is derived from ``tz_offset_min``, never stored
    as a second source of truth.
2.  ``observed_at`` is when the system first learned the fact. It is never
    later than the moment a model is allowed to use the record. This is what
    makes leakage-free windowing possible: a meal logged at 14:00 but entered
    at 19:00 must not be visible to a 15:00 prediction.
3.  Records are immutable value objects. Corrections arrive as a new record
    with a later ``observed_at`` and the same ``source_id``.

Stdlib only, by design — this module is imported by the parity harness and by
CI before any ML dependency is installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional


# ─── Provenance ──────────────────────────────────────────────────────────────

class Source(str, Enum):
    """Where a record came from. Drives trust weighting during training."""

    CGM_LIBRE = "cgm_libre"        # LibreLinkUp sync — dense, machine-generated
    FINGERSTICK = "fingerstick"    # manual BG entry — sparse, higher trust per point
    PATIENT_LOG = "patient_log"    # patient-entered meal / dose / activity
    WATCH = "watch"                # Google Fit HR, auto-segmented
    IMPORT = "import"              # bulk research import (AZT1D, HUPA)
    DERIVED = "derived"            # produced by our own pipeline, not observed


class InsulinClass(str, Enum):
    BOLUS = "bolus"
    BASAL = "basal"
    UNKNOWN = "unknown"


# ─── Base ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Event:
    """Common fields. ``t`` is when it happened; ``observed_at`` when we knew."""

    patient_id: str
    t: datetime
    observed_at: datetime
    source: Source
    source_id: str = ""
    tz_offset_min: int = 0

    def __post_init__(self) -> None:
        for name in ("t", "observed_at"):
            value = getattr(self, name)
            if value.tzinfo is None:
                raise ValueError(
                    f"{type(self).__name__}.{name} must be timezone-aware UTC; "
                    f"got naive {value!r}. Normalize before constructing."
                )
            if value.utcoffset() != timezone.utc.utcoffset(None):
                object.__setattr__(self, name, value.astimezone(timezone.utc))

    @property
    def local_hour(self) -> float:
        """Local wall-clock hour as a float, for circadian features."""
        minutes = (self.t.hour * 60 + self.t.minute + self.tz_offset_min) % 1440
        return minutes / 60.0

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["kind"] = type(self).__name__
        for k, v in list(d.items()):
            if isinstance(v, datetime):
                d[k] = v.isoformat()
            elif isinstance(v, Enum):
                d[k] = v.value
        return d


# ─── Concrete events ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GlucoseReading(Event):
    """A blood glucose measurement, in mg/dL."""

    mg_dl: float = 0.0
    trend: Optional[float] = None          # mg/dL per minute, when the device reports it

    @property
    def is_cgm(self) -> bool:
        return self.source is Source.CGM_LIBRE


@dataclass(frozen=True)
class InsulinDose(Event):
    """A delivered insulin dose, in units."""

    units: float = 0.0
    insulin_type: str = "regular_insulin"  # key into Constants.medication_factors
    dose_class: InsulinClass = InsulinClass.UNKNOWN
    suggested_units: Optional[float] = None   # what the app proposed
    # suggested_units vs units is the behavioural-cloning target and the
    # single most valuable column for the later RL step: it is a logged
    # record of where the patient disagreed with the model.


@dataclass(frozen=True)
class MealEvent(Event):
    """Carbohydrate intake with an absorption class."""

    carbs_g: float = 0.0
    protein_g: float = 0.0
    fat_g: float = 0.0
    absorption_type: str = "medium"        # key into MEAL_ABSORPTION_PROFILES
    meal_type: str = "normal"
    announced: bool = True
    # announced=False marks a meal reconstructed after the fact (e.g. by a
    # detector). An unannounced-meal model must train on these separately.


@dataclass(frozen=True)
class ActivityEvent(Event):
    """An exercise bout."""

    duration_min: float = 0.0
    intensity: str = "moderate"            # light | moderate | vigorous
    mean_hr: Optional[float] = None
    bg_direction: int = -1                 # -1 lowering, +1 raising
    auto_segmented: bool = False


@dataclass
class PatientProfile:
    """
    Static and slow-moving patient parameters, as of ``valid_from``.

    Held separately from events because the PD kernel takes it as a single
    ``patient_constants`` dict. Changing a constant mid-record is a new
    profile version, not a mutation — otherwise a model trained across the
    change learns a discontinuity it cannot see.
    """

    patient_id: str
    valid_from: datetime
    constants: Dict[str, Any] = field(default_factory=dict)
    tz_offset_min: int = 0
    daily_reset_hour: int = 7

    def get(self, key: str, default: Any = None) -> Any:
        return self.constants.get(key, default)


# ─── The bundle every consumer receives ──────────────────────────────────────

@dataclass
class PatientTimeline:
    """
    One patient's complete, sorted, deduplicated history.

    This is the unit of work for dataset building, simulation and evaluation.
    Construction guarantees chronological order, so downstream code may assume
    it and use bisect rather than re-sorting.
    """

    patient_id: str
    profile: PatientProfile
    glucose: List[GlucoseReading] = field(default_factory=list)
    insulin: List[InsulinDose] = field(default_factory=list)
    meals: List[MealEvent] = field(default_factory=list)
    activity: List[ActivityEvent] = field(default_factory=list)

    def __post_init__(self) -> None:
        for name in ("glucose", "insulin", "meals", "activity"):
            setattr(self, name, sorted(getattr(self, name), key=lambda e: e.t))

    @property
    def span(self) -> Optional[tuple[datetime, datetime]]:
        """(first, last) across all streams, or None if the timeline is empty."""
        times = [e.t for s in (self.glucose, self.insulin, self.meals, self.activity) for e in s]
        return (min(times), max(times)) if times else None

    def as_of(self, cutoff: datetime) -> "PatientTimeline":
        """
        The timeline as it was *known* at ``cutoff``.

        Filters on ``observed_at``, not ``t`` — this is the leakage guard.
        A prediction made at time T may only ever see ``timeline.as_of(T)``.
        """
        keep = lambda seq: [e for e in seq if e.observed_at <= cutoff]
        return PatientTimeline(
            patient_id=self.patient_id,
            profile=self.profile,
            glucose=keep(self.glucose),
            insulin=keep(self.insulin),
            meals=keep(self.meals),
            activity=keep(self.activity),
        )

    def summary(self) -> Dict[str, Any]:
        span = self.span
        return {
            "patient_id": self.patient_id,
            "glucose": len(self.glucose),
            "insulin": len(self.insulin),
            "meals": len(self.meals),
            "activity": len(self.activity),
            "from": span[0].isoformat() if span else None,
            "to": span[1].isoformat() if span else None,
        }
