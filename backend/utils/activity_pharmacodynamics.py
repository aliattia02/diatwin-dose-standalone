"""
activity_pharmacodynamics.py — Dalla Man / Breton HR-Informed Exercise Model
=============================================================================
Replaces the previous categorical Gaussian model with the physiologically
grounded Y/Z/W ODE system (Dalla Man, Breton, Cobelli 2009; Romeres et al. 2021).

BIMODAL MECHANISM
─────────────────
  ① ACUTE DIRECT EFFECT (IIRd — insulin-independent glucose uptake)
     Driven by state variable Z. Contracting muscles consume glucose via
     GLUT4 transport regardless of insulin. Fast onset, decays with τ_Z ≈ 10 min
     after exercise ends. Maps to: cumulative_activity_effect (signed mg/dL).

  ② PROLONGED SENSITIVITY EFFECT (IDRd — insulin-dependent)
     Driven by W (integral of Y over time). GLUT4 upregulation persists for
     hours post-exercise. Slow decay τ_W ≈ 90 min. Maps to: sensitivity_multiplier
     on correction_factor / carb_to_bg_ratio.

STATE VARIABLES (Euler integration, dt = 1 min)
───────────────────────────────────────────────
  Y  = filtered HR above baseline (energy expenditure proxy)
       dY/dt = (HRabove / τ_HR) − (Y / τ_HR)
  Z  = acute IIRd signal (fast-on during exercise, slow-off after)
       dZ/dt = (1 − Z)  when Y > a·HRb and in-exercise window
             = −Z / τ_Z after exercise
  W  = cumulative load integral of Y (intensity × duration jointly)
       dW/dt = Y         during exercise
             = −W / τ_W  in recovery

INPUT PRIORITY — NO HR TRACE NEEDED
──────────────────────────────────────
  1. hr_trace — array of (t_min, hr_bpm) from wearable (Garmin, Fitbit, etc.)
  2. intensity + duration_minutes — user-entered categorical fallback.
     When hr_trace is absent the model automatically builds a synthetic HR
     trace from the patient's hr_base / hr_max constants and the chosen
     intensity tier. This path is fully supported and gives a physiologically
     plausible result — no wearable required.

INTENSITY TIERS (categorical fallback)
────────────────────────────────────────
  'light'    → HR ≈ 50 % HRmax  (brisk walk, gentle yoga)
  'moderate' → HR ≈ 65 % HRmax  (jogging, cycling)
  'vigorous' → HR ≈ 80 % HRmax  (HIIT, fast running, competitive sport)

BG DIRECTION
────────────
  bg_direction field on each activity record controls the sign of the effect:
    -1  (default) → BG-lowering (aerobic / normal exercise)
    +1            → BG-raising  (managed internally; not surfaced in UI yet)

CONSTANTS INTEGRATION
──────────────────────
  The model reads the following fields from patient_constants dict.
  All are added to ConstantConfig / DEFAULT_PATIENT_CONSTANTS by the
  companion constants_activity_patch.py:
    weight_kg        → allometric BG-drop scaling   (default 70.0 kg)
    hr_base          → patient resting HR            (default 70.0 bpm)
    hr_max           → patient max HR                (default 190.0 bpm)
    correction_factor→ ISF scaled by sensitivity multiplier
    carb_to_bg_ratio → CR scaled by sensitivity multiplier
                       (fallback: carb_to_bg_factor for legacy constants)

DURATION SOURCE (in order of preference)
─────────────────────────────────────────
  duration_minutes field  →  endTime − startTime  →  duration "HH:MM"  →  30 min

References:
  Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
  Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
  Breton MD                       — J Diabetes Sci Technol 2008;2(1):169-174

Author:  DiaTwin Team
Version: 2.2 (H-3: daily reset-boundary guard in sensitivity multiplier; M-3: warning logs in normalize_activity_record)
=============================================================================
"""

import math
import logging
from datetime import datetime, timedelta
from typing import List, Optional, Tuple, Dict, Any

# B-PD-1: Import ODE constants from the single source of truth in constants.py.
# Eliminates the local copies that could drift if parameters are tuned.
from constants import Constants
# B-PD-2: Delegate reset-time arithmetic to the shared implementation in
# pharmacodynamics.py, completing the B-8 fix that was previously applied
# only to activity_pharmacodynamics_routes.py.
from utils.pharmacodynamics import get_daily_reset_time

logger = logging.getLogger(__name__)


# ─── HR ODE Model Parameters ─────────────────────────────────────────────────
# B-PD-1: These are now sourced from constants.py (Constants class attributes)
# so there is a single source of truth. Do NOT redefine these values here.
# All internal references to HR_MODEL, INTENSITY_HR_FRACTION, and
# LEVEL_TO_INTENSITY continue to work unchanged.

HR_MODEL: Dict[str, float]          = Constants.HR_MODEL
INTENSITY_HR_FRACTION: Dict[str, float]    = Constants.INTENSITY_HR_FRACTION
LEVEL_TO_INTENSITY: Dict[int, Optional[str]] = Constants.LEVEL_TO_INTENSITY


# ─── Helpers: timestamp + duration parsing ───────────────────────────────────

def _parse_dt(value) -> Optional[datetime]:
    """Parse datetime from datetime object or ISO string. Returns naive UTC."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return dt.replace(tzinfo=None)
        except ValueError:
            return None
    return None


def _parse_duration_field(duration_str: str) -> float:
    """Parse 'HH:MM' or numeric string to total minutes."""
    if not duration_str:
        return 30.0
    try:
        parts = str(duration_str).split(":")
        if len(parts) == 2:
            return int(parts[0]) * 60.0 + int(parts[1])
        return float(parts[0]) * 60.0
    except (ValueError, AttributeError):
        return 30.0


# ─── Normalization: legacy activity record → standard ActivityLog ─────────────

def normalize_activity_record(raw: dict) -> Optional[dict]:
    """
    Convert a document from mongo.db.activities to the standard ActivityLog
    format expected by the HR pharmacodynamic functions.

    Supports both new-style records (intensity string + duration_minutes)
    and legacy records (integer level + 'HH:MM' duration string).

    Returns None for sedentary levels (≤ −1) — those affect insulin coefficients
    separately and do not produce a direct BG-exercise effect.

    Fields read from raw record:
        intensity        (str, optional) — 'light' | 'moderate' | 'vigorous'
        level            (int, optional) — legacy −2..2 → intensity via LEVEL_TO_INTENSITY
        startTime        (datetime|str)  — preferred exercise start timestamp
        completedTime    (datetime|str)  — fallback start
        timestamp        (datetime|str)  — last-resort start (record creation time)
        endTime          (datetime|str)  — used to compute duration when present
        duration_minutes (float)         — direct duration override
        duration         (str "HH:MM")  — legacy duration string
        hr_trace         (list, optional)— [{t_min, hr_bpm}] from wearable
        hr_base          (float, optional)
        hr_max           (float, optional)
        bg_drop_override (float, optional) — CGM-measured BG drop bypasses model
        bg_direction     (int, optional) — −1 = lowers BG (default), +1 = raises BG
    """
    # ── Resolve intensity ─────────────────────────────────────────────────
    doc_id = str(raw.get("_id", "<no _id>"))

    if "intensity" in raw and raw["intensity"] in INTENSITY_HR_FRACTION:
        intensity = raw["intensity"]
    else:
        level = raw.get("level")
        if level is None:
            logger.warning(
                "[normalize_activity_record] doc=%s: no intensity or level field — skipping",
                doc_id,
            )
            return None
        intensity = LEVEL_TO_INTENSITY.get(int(level))
        if intensity is None:
            # Sedentary / sick level — expected path, not a data error
            logger.debug(
                "[normalize_activity_record] doc=%s: level=%s maps to sedentary/sick — skipping",
                doc_id, level,
            )
            return None

    # ── Resolve start time ────────────────────────────────────────────────
    start_raw = (
        raw.get("startTime")
        or raw.get("completedTime")
        or raw.get("timestamp")
    )
    if not start_raw:
        logger.warning(
            "[normalize_activity_record] doc=%s: no timestamp field — skipping",
            doc_id,
        )
        return None
    start_time = _parse_dt(start_raw)
    if start_time is None:
        logger.warning(
            "[normalize_activity_record] doc=%s: unparseable timestamp %r — skipping",
            doc_id, start_raw,
        )
        return None

    # ── Resolve duration ──────────────────────────────────────────────────
    # Use `is not None` rather than a truthiness check so that an explicit
    # duration_minutes=0 takes the direct branch instead of silently falling
    # through to the endTime / "00:30" fallback and gaining a phantom duration.
    if raw.get("duration_minutes") is not None:
        duration_minutes = float(raw["duration_minutes"])
        if duration_minutes == 0:
            logger.warning(
                "[normalize_activity_record] doc=%s: duration_minutes=0 — "
                "clamped to 1.0 min by max() below; check source data.",
                doc_id,
            )
    elif raw.get("endTime"):
        end_time = _parse_dt(raw["endTime"])
        if end_time and end_time > start_time:
            duration_minutes = (end_time - start_time).total_seconds() / 60.0
        else:
            duration_minutes = _parse_duration_field(raw.get("duration", "00:30"))
    else:
        duration_minutes = _parse_duration_field(raw.get("duration", "00:30"))

    duration_minutes = max(1.0, duration_minutes)

    normalized: dict = {
        "_id":              str(raw.get("_id", "")),
        "timestamp":        start_time,
        "duration_minutes": duration_minutes,
        "intensity":        intensity,
        # bg_direction: -1 = lowers BG (default aerobic), +1 = raises BG
        "bg_direction":     int(raw.get("bg_direction", -1)),
    }

    # Pass through optional wearable / override fields
    for key in ("hr_trace", "hr_base", "hr_max", "bg_drop_override"):
        if key in raw:
            normalized[key] = raw[key]

    return normalized


# ─── Synthetic HR trace builder ───────────────────────────────────────────────

def _synthetic_hr_trace(
    intensity: str,
    duration_minutes: float,
    hr_max: float,
    hr_base: float,
) -> List[Tuple[float, float]]:
    """
    Build a synthetic (t_min, hr_bpm) trace for the given intensity tier.

    Used as the fallback when no wearable HR trace is present.
    Shape: 2-min ramp-up → flat plateau → last sample at duration end.

    This is the path taken when a user enters intensity + duration manually
    without a connected wearable.  It is fully supported and gives a
    physiologically plausible result for all downstream calculations.
    """
    fraction = INTENSITY_HR_FRACTION.get(intensity, INTENSITY_HR_FRACTION["moderate"])
    peak_hr  = hr_base + fraction * (hr_max - hr_base)

    ramp_end = min(2.0, duration_minutes * 0.1)
    trace = [
        (0.0,           hr_base),
        (ramp_end,      peak_hr),
        (duration_minutes, peak_hr),
    ]
    return trace


def _get_patient_hr_defaults(patient_constants: dict) -> Tuple[float, float]:
    """Return (hr_base, hr_max) from patient constants with population fallbacks."""
    hr_base = float(patient_constants.get("hr_base") or HR_MODEL["hr_base_pop"])
    hr_max  = float(patient_constants.get("hr_max")  or HR_MODEL["hr_max_pop"])
    return hr_base, hr_max


def _get_trace_from_activity(
    activity: dict,
    patient_constants: dict,
) -> List[Tuple[float, float]]:
    """
    Return the HR trace for an activity, preferring wearable data.

    Priority:
      1. activity['hr_trace']  — real wearable samples
      2. Synthetic trace built from intensity + duration + patient constants

    The activity-level hr_base / hr_max override the patient-level defaults so
    individual sessions recorded with a specific wearable profile are honoured.
    """
    if activity.get("hr_trace"):
        return [(s["t_min"], s["hr_bpm"]) for s in activity["hr_trace"]]

    intensity        = activity.get("intensity", "moderate")
    duration_minutes = float(activity.get("duration_minutes", 30))
    p_hr_base, p_hr_max = _get_patient_hr_defaults(patient_constants)
    hr_base = float(activity.get("hr_base") or p_hr_base)
    hr_max  = float(activity.get("hr_max")  or p_hr_max)
    return _synthetic_hr_trace(intensity, duration_minutes, hr_max, hr_base)


# ─── Core ODE simulation ──────────────────────────────────────────────────────

def _interpolate_hr(
    trace: List[Tuple[float, float]],
    t: float,
    hr_base: float,
) -> float:
    """Linear interpolation of HR at time t from the trace. Clamps to hr_base outside."""
    if not trace:
        return hr_base
    if t <= trace[0][0]:
        return trace[0][1]
    if t >= trace[-1][0]:
        return hr_base  # back to resting after last sample
    for i in range(len(trace) - 1):
        t0, h0 = trace[i]
        t1, h1 = trace[i + 1]
        if t0 <= t <= t1:
            frac = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            return h0 + frac * (h1 - h0)
    return hr_base


def _simulate_hr_ode(
    trace: List[Tuple[float, float]],
    elapsed: float,
    hr_base: float,
) -> Tuple[float, float, float]:
    """
    Euler-integrate the Y/Z/W ODE up to `elapsed` minutes.
    Returns (Y, Z, W) at elapsed time.
    """
    Y, Z, W = 0.0, 0.0, 0.0
    dt        = HR_MODEL["dt"]
    tau_HR    = HR_MODEL["tau_HR"]
    tau_Z     = HR_MODEL["tau_Z"]
    tau_W     = HR_MODEL["tau_W"]
    a         = HR_MODEL["a"]
    threshold = hr_base * (1.0 + a)
    last_t    = trace[-1][0] if trace else 0.0
    steps     = int(math.ceil(elapsed / dt))

    for i in range(steps):
        t  = i * dt
        hr = _interpolate_hr(trace, min(t, last_t), hr_base)
        hr_above    = max(0.0, hr - hr_base)
        in_exercise = (t <= last_t) and (hr > threshold)
        onset_active = Y > a * hr_base

        dY = (hr_above / tau_HR) - (Y / tau_HR)
        Y  = max(0.0, Y + dY * dt)

        dZ = (1.0 - Z) if (in_exercise and onset_active) else (-Z / tau_Z)
        Z  = min(1.0, max(0.0, Z + dZ * dt))

        dW = Y if in_exercise else (-W / tau_W)
        W  = max(0.0, W + dW * dt)

    return Y, Z, W


def _integrate_z_drop(
    trace: List[Tuple[float, float]],
    from_minute: float,
    to_minute: float,
    hr_base: float,
    weight_kg: Optional[float],
) -> float:
    """
    Integrate Z * acute_rate_per_min from from_minute to to_minute.
    Returns UNSIGNED magnitude (sign applied by the caller via bg_direction).
    Applies allometric weight scaling when weight_kg is provided.
    """
    if to_minute <= from_minute:
        return 0.0

    Y, Z, W = 0.0, 0.0, 0.0
    dt               = HR_MODEL["dt"]
    tau_HR           = HR_MODEL["tau_HR"]
    tau_Z            = HR_MODEL["tau_Z"]
    tau_W            = HR_MODEL["tau_W"]
    a                = HR_MODEL["a"]
    acute_rate       = HR_MODEL["acute_rate_per_min"]
    threshold        = hr_base * (1.0 + a)
    last_t           = trace[-1][0] if trace else 0.0
    steps            = int(math.ceil(to_minute / dt))
    total_drop       = 0.0

    for i in range(steps):
        t  = i * dt
        hr = _interpolate_hr(trace, min(t, last_t), hr_base)
        hr_above    = max(0.0, hr - hr_base)
        in_exercise = (t <= last_t) and (hr > threshold)
        onset_active = Y > a * hr_base

        dY = (hr_above / tau_HR) - (Y / tau_HR)
        Y  = max(0.0, Y + dY * dt)

        dZ = (1.0 - Z) if (in_exercise and onset_active) else (-Z / tau_Z)
        Z  = min(1.0, max(0.0, Z + dZ * dt))

        dW = Y if in_exercise else (-W / tau_W)
        W  = max(0.0, W + dW * dt)

        if t >= from_minute:
            total_drop += Z * acute_rate * dt

    # Allometric scaling: heavier patients have smaller per-kg BG drop
    if weight_kg and weight_kg > 0:
        total_drop *= (70.0 / weight_kg) ** 0.25

    return total_drop   # always ≥ 0; sign applied by caller


# ─── Public API ───────────────────────────────────────────────────────────────

def calculate_activity_cumulative_effect(
    activity: dict,
    current_time: datetime,
    patient_constants: dict,
) -> float:
    """
    Signed BG effect of a single activity session up to current_time (mg/dL).

    Sign is controlled by activity['bg_direction']:
        -1  → negative (lowers BG, default aerobic effect)
        +1  → positive (raises BG, stored internally for specific session types)

    Returns 0.0 when the session is in the future or has no effect.
    """
    start_time = _parse_dt(activity.get("timestamp") or activity.get("start_time"))
    if not start_time or current_time < start_time:
        return 0.0

    bg_direction = int(activity.get("bg_direction", -1))  # −1 or +1

    # CGM-measured override bypasses the ODE — absorbed linearly over duration + tail
    if activity.get("bg_drop_override") is not None:
        drop_mag     = float(activity["bg_drop_override"])
        dur          = float(activity.get("duration_minutes", 30))
        tail         = dur * 0.4
        elapsed      = (current_time - start_time).total_seconds() / 60.0
        frac         = min(1.0, max(0.0, elapsed / (dur + tail)))
        return round(bg_direction * drop_mag * frac, 2)

    p_hr_base, _p_hr_max = _get_patient_hr_defaults(patient_constants)
    hr_base   = float(activity.get("hr_base") or p_hr_base)
    weight_kg = patient_constants.get("weight_kg")
    trace     = _get_trace_from_activity(activity, patient_constants)
    elapsed   = (current_time - start_time).total_seconds() / 60.0
    post_tail = 4.0 * HR_MODEL["tau_Z"]
    scan_to   = min(elapsed, float(activity.get("duration_minutes", 30)) + post_tail)

    magnitude = _integrate_z_drop(trace, 0.0, scan_to, hr_base, weight_kg)
    return round(bg_direction * magnitude, 2)


def get_activity_on_board(
    activity: dict,
    current_time: datetime,
    patient_constants: dict,
) -> dict:
    """
    Activity On Board (AOB) — remaining acute BG effect still to be delivered.

    Returns:
        remaining_bg_drop  (float) — unsigned magnitude remaining
        absorbed_fraction  (float) — 0.0–1.0
        minutes_elapsed    (float)
        is_active          (bool)  — True if still within duration_minutes
        intensity          (str)
        bg_direction       (int)   — −1 or +1
    """
    start_time       = _parse_dt(activity.get("timestamp") or activity.get("start_time"))
    intensity        = activity.get("intensity", "moderate")
    duration_minutes = float(activity.get("duration_minutes", 30))
    bg_direction     = int(activity.get("bg_direction", -1))

    if not start_time:
        return {
            "remaining_bg_drop": 0.0, "absorbed_fraction": 0.0,
            "minutes_elapsed": 0.0, "is_active": False,
            "intensity": intensity, "bg_direction": bg_direction,
        }

    elapsed = max(0.0, (current_time - start_time).total_seconds() / 60.0)

    # ── CGM-measured override: mirror the linear model in
    #    calculate_activity_cumulative_effect so AOB is consistent ────────────
    if activity.get("bg_drop_override") is not None:
        drop_mag = abs(float(activity["bg_drop_override"]))
        tail     = duration_minutes * 0.4
        full     = duration_minutes + tail
        absorbed = min(1.0, max(0.0, elapsed / full)) if full > 0 else 1.0
        remaining = max(0.0, drop_mag * (1.0 - absorbed))
        return {
            "remaining_bg_drop": round(remaining, 1),
            "absorbed_fraction": round(absorbed, 3),
            "minutes_elapsed":   round(elapsed, 1),
            "is_active":         elapsed < duration_minutes,
            "intensity":         intensity,
            "bg_direction":      bg_direction,
        }
    # ─────────────────────────────────────────────────────────────────────────

    # ── ODE path (no CGM override) ───────────────────────────────────────────
    p_hr_base, _p_hr_max = _get_patient_hr_defaults(patient_constants)
    hr_base   = float(activity.get("hr_base") or p_hr_base)
    weight_kg = patient_constants.get("weight_kg")
    trace     = _get_trace_from_activity(activity, patient_constants)

    last_trace_t = trace[-1][0] if trace else duration_minutes
    full_window  = last_trace_t + 4.0 * HR_MODEL["tau_Z"]

    total_drop   = _integrate_z_drop(trace, 0.0, full_window, hr_base, weight_kg)
    elapsed_drop = _integrate_z_drop(trace, 0.0, min(elapsed, full_window), hr_base, weight_kg)

    absorbed  = (elapsed_drop / total_drop) if total_drop > 0 else 1.0
    absorbed  = min(1.0, max(0.0, absorbed))
    remaining = max(0.0, total_drop * (1.0 - absorbed))

    return {
        "remaining_bg_drop": round(remaining, 1),
        "absorbed_fraction": round(absorbed, 3),
        "minutes_elapsed":   round(elapsed, 1),
        "is_active":         elapsed < duration_minutes,
        "intensity":         intensity,
        "bg_direction":      bg_direction,
    }


def _get_reset_time(patient_constants: dict, current_time: datetime) -> datetime:
    """
    Calculate the start of today's activity window (the daily reset boundary).

    B-PD-2: Delegates to get_daily_reset_time() from pharmacodynamics.py so
    that all reset-time arithmetic shares a single implementation. The previous
    local arithmetic was a near-duplicate of that function but diverged in edge
    cases (e.g. TimeManager precision handling), completing the B-8 fix that
    was previously applied only to activity_pharmacodynamics_routes.py.

    Uses:
        daily_reset_hour          — local clock hour at which the day resets (default 7)
        timezone_offset_minutes   — user's UTC offset in minutes (default 0)

    The returned datetime is in naive UTC, matching the timestamps stored in mongo.
    """
    reset_hour    = patient_constants.get("daily_reset_hour", 7)
    tz_offset_min = patient_constants.get("timezone_offset_minutes", 0)
    return get_daily_reset_time(current_time, reset_hour, tz_offset_min)


def calculate_activity_sensitivity_multiplier(
    activities: List[dict],
    current_time: datetime,
    patient_constants: Optional[dict] = None,
) -> float:
    """
    Post-exercise ISF/CR sensitivity multiplier from the W state variable.

    Sensitivity = 1.0 + α · W · (1 + Z), capped at max_sensitivity_boost.
    Takes the maximum across all sessions (GLUT4 receptors are already
    upregulated — they don't simply stack additively).

    Returns float ≥ 1.0  (e.g. 1.30 = 30 % more sensitive than baseline).
    Only considers sessions within the last 8 hours (W decays to < 1 % beyond 5·τ_W)
    AND within today's reset window — sessions before the daily reset boundary are
    excluded so yesterday's exercise does not carry into a new day's calculations.
    """
    alpha     = HR_MODEL["alpha"]
    max_boost = HR_MODEL["max_sensitivity_boost"]
    pc        = patient_constants or {}
    best      = 1.0

    # Compute today's reset boundary — sessions before this are excluded (H-3)
    reset_time = _get_reset_time(pc, current_time)

    for activity in activities:
        start_time = _parse_dt(activity.get("timestamp") or activity.get("start_time"))
        if not start_time or current_time < start_time:
            continue

        # H-3: skip sessions that started before today's reset boundary
        if start_time < reset_time:
            continue

        elapsed = (current_time - start_time).total_seconds() / 60.0
        if elapsed > 8.0 * 60.0:
            continue   # W has fully decayed — no sensitivity contribution

        p_hr_base, _p_hr_max = _get_patient_hr_defaults(pc)
        hr_base = float(activity.get("hr_base") or p_hr_base)
        trace   = _get_trace_from_activity(activity, pc)

        _Y, Z, W = _simulate_hr_ode(trace, elapsed, hr_base)
        raw_boost  = alpha * W * (1.0 + Z)
        boost      = min(raw_boost, max_boost)
        multiplier = round(1.0 + boost, 4)
        best       = max(best, multiplier)

    return best


def apply_activity_sensitivity(
    patient_constants: dict,
    activities: List[dict],
    current_time: datetime,
) -> dict:
    """
    Return a modified copy of patient_constants with ISF and carb ratio
    scaled by the current activity sensitivity multiplier.

    Reads from patient_constants:
        correction_factor   — multiplied   (same insulin → bigger drop → higher ISF)
        carb_to_bg_ratio    — divided      (same carbs → smaller rise)
        carb_to_bg_factor   — also divided (legacy alias — whichever is present)

    The original dict is NOT mutated.
    """
    multiplier = calculate_activity_sensitivity_multiplier(
        activities, current_time, patient_constants
    )
    if multiplier == 1.0:
        return patient_constants

    modified = dict(patient_constants)

    if "correction_factor" in modified:
        modified["correction_factor"] = round(modified["correction_factor"] * multiplier, 2)

    # Support both field names — keep whichever the caller stored
    for cr_key in ("carb_to_bg_ratio", "carb_to_bg_factor"):
        if cr_key in modified:
            modified[cr_key] = round(modified[cr_key] / multiplier, 2)

    logger.info(
        f"Activity sensitivity ×{multiplier:.3f}: "
        f"correction_factor → {modified.get('correction_factor')}, "
        f"carb_to_bg_ratio → {modified.get('carb_to_bg_ratio') or modified.get('carb_to_bg_factor')}"
    )
    return modified


def calculate_stacked_activity_effect(
    activities: List[dict],
    current_time: datetime,
    patient_constants: dict,
) -> dict:
    """
    Combine all normalised activity sessions into a single result.

    Use normalise_activity_record() on raw mongo.db.activities documents
    before passing here.

    The cumulative_activity_effect is SIGNED:
        negative → net BG-lowering   (typical aerobic session)
        positive → net BG-raising    (recorded with bg_direction = +1)
        near 0   → sessions cancel out or none are active

    Usage in cumulative_effects_routes.py:
        activity_data = calculate_stacked_activity_effect(
            activities, target_time, patient_constants
        )
        cumulative_net_baseline = (
            cumulative_data['cumulative_meal_effect']
            + cumulative_data['cumulative_insulin_effect']
            + activity_data['cumulative_activity_effect']   # signed ← new
        )

    Returns:
        cumulative_activity_effect  (float, signed mg/dL)
        sensitivity_multiplier      (float ≥ 1.0)
        activity_on_board           (float, unsigned remaining drop magnitude)
        activity_contributions      (list, per-session breakdown)
        active_sessions             (int)
    """
    cumulative_effect = 0.0
    total_aob         = 0.0
    contributions     = []
    active_count      = 0

    for activity in activities:
        effect = calculate_activity_cumulative_effect(activity, current_time, patient_constants)
        aob    = get_activity_on_board(activity, current_time, patient_constants)

        cumulative_effect += effect
        total_aob         += aob["remaining_bg_drop"]

        if aob["is_active"]:
            active_count += 1

        start_time = activity.get("timestamp") or activity.get("start_time")
        contributions.append({
            "activity_id":          str(activity.get("_id", "")),
            "start_time":           start_time.isoformat() if isinstance(start_time, datetime) else start_time,
            "intensity":            activity.get("intensity", "moderate"),
            "duration_minutes":     activity.get("duration_minutes", 30),
            "bg_direction":         activity.get("bg_direction", -1),
            "cumulative_bg_effect": round(effect, 1),
            "remaining_bg_drop":    aob["remaining_bg_drop"],
            "absorbed_fraction":    aob["absorbed_fraction"],
            "is_active":            aob["is_active"],
            "model":                "hr_ode" if activity.get("hr_trace") else "synthetic_hr",
        })

    sensitivity = calculate_activity_sensitivity_multiplier(
        activities, current_time, patient_constants
    )

    return {
        "cumulative_activity_effect": round(cumulative_effect, 1),
        "sensitivity_multiplier":     round(sensitivity, 4),
        "activity_on_board":          round(total_aob, 1),
        "activity_contributions":     contributions,
        "active_sessions":            active_count,
    }