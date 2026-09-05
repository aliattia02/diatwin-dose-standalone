"""
Raw Mongo documents → canonical events.

This module is the quarantine boundary. Every historical quirk in the
collections is handled here, once, so that nothing downstream has to know
about them:

*   **Four timestamp encodings.** ``bloodSugarTimestamp`` has been written as
    a naive ``datetime``, an ISO string, an ISO string with a ``Z`` suffix,
    and not at all — the ``$or`` fan-out at ``backend/blood_sugar.py:341-363``
    exists to paper over exactly this. :func:`parse_time` collapses all four.

*   **Insulin is written twice.** A dose lands in ``medication_logs`` *and*
    as a ``meals`` document with ``mealType='insulin_only'``
    (``backend/routes/medication_routes.py:488``). Loading both without
    deduplication doubles every bolus, which would inflate IOB and quietly
    poison any model trained on it. :func:`dedupe_insulin` resolves it.

*   **Meals live in two collections.** ``meals`` carries the full record;
    ``meals_only`` carries a projection used by the newer routes. ``meals``
    is treated as authoritative here.

*   **Naive datetimes are UTC.** The backend stores naive UTC throughout
    (``datetime.utcnow()``). We attach the timezone rather than guessing.

Stdlib only.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .schema import (
    ActivityEvent,
    GlucoseReading,
    InsulinClass,
    InsulinDose,
    MealEvent,
    Source,
)

logger = logging.getLogger(__name__)

#: Two doses of the same insulin type within this window are the same dose
#: seen through two collections.
INSULIN_DEDUPE_WINDOW = timedelta(minutes=2)

#: Physiologically possible CGM range. Anything outside is a sensor artifact.
GLUCOSE_MIN_MG_DL = 20.0
GLUCOSE_MAX_MG_DL = 600.0

#: Insulin types that are basal regardless of how they were logged.
_BASAL_HINTS = ("glargine", "detemir", "degludec", "nph", "long_acting", "basal")


# ─── Timestamps ──────────────────────────────────────────────────────────────

def parse_time(value: Any) -> Optional[datetime]:
    """
    Parse any timestamp shape the database has ever held into aware UTC.

    Accepts ``datetime`` (naive treated as UTC), ISO-8601 strings with or
    without a ``Z`` suffix, and epoch seconds or milliseconds. Returns None
    for anything unparseable rather than raising — a single bad row should
    not abort a dataset build, but it must not silently become "now" either.
    """
    if value is None or value == "":
        return None

    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    if isinstance(value, (int, float)):
        # Heuristic: anything past ~2001 in seconds is milliseconds if it is
        # also past ~33658 in years, i.e. > 1e11.
        seconds = value / 1000.0 if value > 1e11 else float(value)
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
                try:
                    parsed = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
            else:
                logger.debug("unparseable timestamp: %r", value)
                return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)

    logger.debug("unsupported timestamp type %s: %r", type(value).__name__, value)
    return None


def _first_time(doc: Dict[str, Any], *keys: str) -> Optional[datetime]:
    """First key that parses to a real timestamp."""
    for key in keys:
        parsed = parse_time(doc.get(key))
        if parsed is not None:
            return parsed
    return None


def _float(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


# ─── Glucose ─────────────────────────────────────────────────────────────────

def normalize_glucose(doc: Dict[str, Any], *, tz_offset_min: int = 0) -> Optional[GlucoseReading]:
    """One ``blood_sugar`` document → :class:`GlucoseReading`."""
    mg_dl = _float(doc.get("bloodSugar"))
    if mg_dl is None:
        return None
    if not (GLUCOSE_MIN_MG_DL <= mg_dl <= GLUCOSE_MAX_MG_DL):
        logger.debug("dropping out-of-range glucose %.1f", mg_dl)
        return None

    # bloodSugarTimestamp is the reading time; timestamp is the write time.
    # Prefer the reading time, fall back to the write time.
    t = _first_time(doc, "bloodSugarTimestamp", "timestamp", "created_at")
    if t is None:
        return None
    observed = _first_time(doc, "created_at", "timestamp") or t

    raw_source = (doc.get("bloodSugarSource") or doc.get("source") or "").lower()
    if "libre" in raw_source or "cgm" in raw_source:
        source = Source.CGM_LIBRE
    elif "import" in raw_source:
        source = Source.IMPORT
    else:
        source = Source.FINGERSTICK

    return GlucoseReading(
        patient_id=str(doc.get("user_id") or doc.get("patient_id") or ""),
        t=t,
        observed_at=max(observed, t),
        source=source,
        source_id=str(doc.get("_id", "")),
        tz_offset_min=int(doc.get("timezone_offset_minutes") or tz_offset_min),
        mg_dl=mg_dl,
        trend=_float(doc.get("trend")),
    )


# ─── Insulin ─────────────────────────────────────────────────────────────────

def _classify_insulin(insulin_type: str, doc: Dict[str, Any]) -> InsulinClass:
    lowered = (insulin_type or "").lower()
    if any(hint in lowered for hint in _BASAL_HINTS):
        return InsulinClass.BASAL
    if doc.get("is_basal"):
        return InsulinClass.BASAL
    if lowered:
        return InsulinClass.BOLUS
    return InsulinClass.UNKNOWN


def normalize_insulin_from_medication_log(
    doc: Dict[str, Any], *, tz_offset_min: int = 0
) -> Optional[InsulinDose]:
    """One ``medication_logs`` document with ``is_insulin`` → :class:`InsulinDose`."""
    if not doc.get("is_insulin"):
        return None
    units = _float(doc.get("dose"))
    if units is None or units <= 0:
        return None

    t = _first_time(doc, "taken_at", "scheduled_time", "created_at")
    if t is None:
        return None
    observed = _first_time(doc, "created_at") or t
    insulin_type = str(doc.get("medication") or "regular_insulin")

    return InsulinDose(
        patient_id=str(doc.get("patient_id") or doc.get("user_id") or ""),
        t=t,
        observed_at=max(observed, t),
        source=Source.PATIENT_LOG,
        source_id=str(doc.get("_id", "")),
        tz_offset_min=int(doc.get("timezone_offset_minutes") or tz_offset_min),
        units=units,
        insulin_type=insulin_type,
        dose_class=_classify_insulin(insulin_type, doc),
    )


def normalize_insulin_from_meal(
    doc: Dict[str, Any], *, tz_offset_min: int = 0
) -> Optional[InsulinDose]:
    """
    The insulin half of a ``meals`` document.

    Carries ``suggestedInsulin`` alongside the delivered amount, which the
    ``medication_logs`` copy does not have — so when deduplication has to
    choose, this record is the richer one.
    """
    units = _float(doc.get("intendedInsulin"))
    if units is None or units <= 0:
        return None

    t = _first_time(doc, "insulinAdministrationTime", "timestamp", "created_at")
    if t is None:
        return None
    observed = _first_time(doc, "created_at", "timestamp") or t
    insulin_type = str(doc.get("intendedInsulinType") or "regular_insulin")

    return InsulinDose(
        patient_id=str(doc.get("user_id") or doc.get("patient_id") or ""),
        t=t,
        observed_at=max(observed, t),
        source=Source.PATIENT_LOG,
        source_id=str(doc.get("_id", "")),
        tz_offset_min=int(doc.get("timezone_offset_minutes") or tz_offset_min),
        units=units,
        insulin_type=insulin_type,
        dose_class=_classify_insulin(insulin_type, doc),
        suggested_units=_float(doc.get("suggestedInsulin")),
    )


def dedupe_insulin(doses: Iterable[InsulinDose]) -> List[InsulinDose]:
    """
    Collapse the ``medication_logs`` / ``meals`` dual write.

    Two doses match when they share a patient and insulin type and fall
    within :data:`INSULIN_DEDUPE_WINDOW`. The survivor is the record that
    carries ``suggested_units``, because that column is what the later RL
    step trains against; ties break toward the earlier ``observed_at``.
    """
    ordered = sorted(doses, key=lambda d: (d.patient_id, d.insulin_type, d.t))
    kept: List[InsulinDose] = []

    for dose in ordered:
        merged = False
        for i in range(len(kept) - 1, -1, -1):
            prev = kept[i]
            if prev.patient_id != dose.patient_id or prev.insulin_type != dose.insulin_type:
                continue
            if dose.t - prev.t > INSULIN_DEDUPE_WINDOW:
                break
            # Same dose seen twice — keep whichever carries more information.
            better = dose if (dose.suggested_units is not None and prev.suggested_units is None) else prev
            if better is not prev:
                kept[i] = better
            merged = True
            break
        if not merged:
            kept.append(dose)

    return sorted(kept, key=lambda d: d.t)


# ─── Meals ───────────────────────────────────────────────────────────────────

_NON_MEAL_TYPES = {"blood_sugar_only", "activity_only", "insulin_only"}


def normalize_meal(doc: Dict[str, Any], *, tz_offset_min: int = 0) -> Optional[MealEvent]:
    """One ``meals`` document → :class:`MealEvent`, or None if it carries no carbs."""
    if str(doc.get("mealType", "")) in _NON_MEAL_TYPES:
        return None

    nutrition = doc.get("nutrition") or {}
    carbs = _float(nutrition.get("carbs"), 0.0) or 0.0
    if carbs <= 0:
        return None

    t = _first_time(doc, "timestamp", "created_at")
    if t is None:
        return None
    observed = _first_time(doc, "created_at") or t

    return MealEvent(
        patient_id=str(doc.get("user_id") or doc.get("patient_id") or ""),
        t=t,
        observed_at=max(observed, t),
        source=Source.PATIENT_LOG,
        source_id=str(doc.get("_id", "")),
        tz_offset_min=int(doc.get("timezone_offset_minutes") or tz_offset_min),
        carbs_g=carbs,
        protein_g=_float(nutrition.get("protein"), 0.0) or 0.0,
        fat_g=_float(nutrition.get("fat"), 0.0) or 0.0,
        absorption_type=str(nutrition.get("absorption_type") or "medium"),
        meal_type=str(doc.get("mealType") or "normal"),
        announced=True,
    )


# ─── Activity ────────────────────────────────────────────────────────────────

_LEVEL_TO_INTENSITY = {-2: None, -1: None, 0: None, 1: "light", 2: "moderate", 3: "vigorous"}


def _parse_duration_minutes(value: Any) -> Optional[float]:
    """Accepts minutes as a number, or the legacy ``'HH:MM'`` string."""
    numeric = _float(value)
    if numeric is not None:
        return numeric
    if isinstance(value, str) and ":" in value:
        parts = value.split(":")
        try:
            if len(parts) == 2:
                return int(parts[0]) * 60.0 + int(parts[1])
            return float(parts[0]) * 60.0
        except ValueError:
            return None
    return None


def normalize_activity(doc: Dict[str, Any], *, tz_offset_min: int = 0) -> Optional[ActivityEvent]:
    """
    One ``activities`` document → :class:`ActivityEvent`.

    Sedentary levels (``level <= 0``) return None: they modulate insulin
    sensitivity coefficients elsewhere and do not produce a direct BG effect,
    so emitting them as bouts would double-count.
    """
    intensity = doc.get("intensity")
    if intensity not in ("light", "moderate", "vigorous"):
        level = doc.get("level")
        intensity = _LEVEL_TO_INTENSITY.get(int(level)) if level is not None else None
    if intensity is None:
        return None

    duration = _parse_duration_minutes(doc.get("duration_minutes") or doc.get("duration"))
    if duration is None or duration <= 0:
        return None

    t = _first_time(doc, "startTime", "start_time", "timestamp", "created_at")
    if t is None:
        return None
    observed = _first_time(doc, "created_at", "timestamp") or t

    return ActivityEvent(
        patient_id=str(doc.get("user_id") or doc.get("patient_id") or ""),
        t=t,
        observed_at=max(observed, t),
        source=Source.WATCH if doc.get("auto_segmented") else Source.PATIENT_LOG,
        source_id=str(doc.get("_id", "")),
        tz_offset_min=int(doc.get("timezone_offset_minutes") or tz_offset_min),
        duration_min=duration,
        intensity=str(intensity),
        mean_hr=_float(doc.get("mean_hr") or doc.get("meanHr")),
        bg_direction=int(doc.get("bg_direction", -1) or -1),
        auto_segmented=bool(doc.get("auto_segmented")),
    )


# ─── Batch helpers ───────────────────────────────────────────────────────────

def normalize_all(
    *,
    glucose_docs: Sequence[Dict[str, Any]] = (),
    meal_docs: Sequence[Dict[str, Any]] = (),
    medication_docs: Sequence[Dict[str, Any]] = (),
    activity_docs: Sequence[Dict[str, Any]] = (),
    tz_offset_min: int = 0,
) -> Dict[str, List[Any]]:
    """
    Normalize every stream at once, with insulin deduplication applied.

    Returns a dict with keys ``glucose``, ``insulin``, ``meals``, ``activity``
    plus ``dropped``, a per-stream count of records that failed normalization.
    A non-zero ``dropped`` is a data-quality signal worth logging, not an error.
    """
    def collect(docs, fn):
        out, dropped = [], 0
        for doc in docs:
            record = fn(doc, tz_offset_min=tz_offset_min)
            if record is None:
                dropped += 1
            else:
                out.append(record)
        return out, dropped

    glucose, g_drop = collect(glucose_docs, normalize_glucose)
    meals, m_drop = collect(meal_docs, normalize_meal)
    activity, a_drop = collect(activity_docs, normalize_activity)

    from_logs, _ = collect(medication_docs, normalize_insulin_from_medication_log)
    from_meals, _ = collect(meal_docs, normalize_insulin_from_meal)
    insulin = dedupe_insulin([*from_logs, *from_meals])

    return {
        "glucose": glucose,
        "insulin": insulin,
        "meals": meals,
        "activity": activity,
        "dropped": {
            "glucose": g_drop,
            "meals": m_drop,
            "activity": a_drop,
            "insulin_deduped": len(from_logs) + len(from_meals) - len(insulin),
        },
    }
