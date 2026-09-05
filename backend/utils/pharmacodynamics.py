"""
pharmacodynamics.py - Shared Pharmacokinetic/Pharmacodynamic Calculations
============================================================================
Centralized calculation engine for:
- Meal absorption (gamma distribution)
- Insulin activity (gamma distribution + peakless models)
- IOB (Insulin On Board) via trapezoidal integration
- MOB (Meal On Board) / absorbed carbs via a 100-step LEFT-RIEMANN sum

Note the two integrals do not use the same rule. `calculate_iob` weights its
endpoints by 0.5 (trapezoid); `calculate_absorbed_fraction` does not, and sums
i in range(steps) rather than range(steps + 1). This line claimed both were
trapezoidal until 2026-09-05, as did Arm 2 — and the web frontend had
implemented a trapezoid for the absorbed fraction to match the description,
which the three-way parity harness then found (D16). Whether either rule is
the right one is open; changing one moves every absorbed-carb figure in the
product and has to move on all three implementations at once.

Used by: meal_routes.py, medication_routes.py, meal_insulin.py

Author: DiaTwin Team
Version: 4.0 (Refactored - Single Source of Truth)
============================================================================
"""

import math
import logging
import calendar
from datetime import datetime, timedelta
from time_manager import TimeManager
from constants import get_circadian_baseline_at_hour, sanitize_baseline

logger = logging.getLogger(__name__)


# ============================================================================
# MEAL ABSORPTION - Gamma Distribution
# ============================================================================

def calculate_gamma_absorption(hours_since_meal, profile):
    """
    Calculate absorption activity using gamma distribution curve.

    The gamma distribution naturally models:
    - Delayed onset (gastric emptying)
    - Rise to peak (intestinal absorption)
    - Gradual tail (remaining absorption)

    Args:
        hours_since_meal (float): Hours elapsed since meal consumption
        profile (dict): Absorption profile with gamma parameters.
                        Expected keys: onset_hours, peak_hours, duration_hours,
                        shape_param, scale_param

    Returns:
        float: Activity percentage (0-100)
    """
    onset = profile.get('onset_hours', 0.25)
    peak = profile.get('peak_hours', 1.5)
    duration = profile.get('duration_hours', 4.0)
    shape = profile.get('shape_param', 2.0)
    scale = profile.get('scale_param', 1.0)

    if hours_since_meal < 0 or hours_since_meal > duration:
        return 0.0

    # D21c: no absorption before gastric emptying completes.
    #
    # This used to ramp linearly to 5, and the gamma branch below then starts
    # at ~0 because t**(k-1) -> 0 for every k > 1. So absorption rate *fell* by
    # a full 5 percentage points at the instant onset completed — the opposite
    # of the physiology `onset_hours` describes. Returning 0 makes the curve
    # continuous at onset and matches the model: before gastric emptying is
    # done, carbohydrate has not reached the absorptive surface.
    if hours_since_meal < onset:
        return 0.0

    t = hours_since_meal - onset
    t_peak = peak - onset
    t_duration = duration - onset

    normalized_t = t / t_duration
    normalized_peak = t_peak / t_duration

    if normalized_t <= 0:
        return 0.0

    k = shape
    theta = scale * normalized_peak

    # D21a: normalise by the curve's true maximum, not by its value at
    # `peak_hours`.
    #
    # The density x**(k-1) * exp(-x/theta) peaks at x = (k-1)*theta. Dividing
    # by its value at `normalized_peak` instead only coincides when
    # (k-1)*scale_param == 1, which holds for none of the shipped profiles — so
    # the ratio exceeded 1 either side of the true mode and `min(100, ...)`
    # clamped it. Between 18.6% and 38.5% of every absorption window sat at
    # exactly 100, carrying no information at all.
    #
    # Normalising by the true maximum removes the plateau without altering the
    # curve's shape, and `calculate_absorbed_fraction` divides by the total
    # area, so the fraction absorbed is unaffected by the rescaling itself.
    #
    # NOTE (provisional, 2026-09-05): `peak_hours` still names the
    # normalisation point rather than the mode — the curve now peaks at
    # onset + (k-1)*theta*(duration-onset), which is earlier. Reparameterising
    # the profiles so `peak_hours` *is* the mode is a separate decision; it
    # would change every profile's tail and needs clinical review.
    mode = (k - 1.0) * theta if k > 1.0 else 0.0
    mode = min(max(mode, 1e-12), 1.0)

    activity = (normalized_t ** (k - 1)) * math.exp(-normalized_t / theta)
    peak_activity = (mode ** (k - 1)) * math.exp(-mode / theta)

    if peak_activity > 0:
        activity = (activity / peak_activity) * 100

    return min(100, max(0, activity))


def calculate_meal_activity_percentage(hours_since_meal, meal_profile, absorption_profiles):
    """
    Calculate meal activity percentage based on absorption profile.

    Args:
        hours_since_meal (float): Hours elapsed since meal consumption
        meal_profile (dict): Meal absorption profile with onset, peak, duration
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        float: Activity percentage (0-100)
    """
    absorption_type = meal_profile.get('absorption_type', 'medium')

    if absorption_type in absorption_profiles:
        gamma_profile = {**absorption_profiles[absorption_type], **meal_profile}
        return calculate_gamma_absorption(hours_since_meal, gamma_profile)

    return calculate_gamma_absorption(hours_since_meal, meal_profile)


def get_meal_absorption_profile(meal, patient_constants, absorption_profiles):
    """
    Get absorption profile for a meal based on its composition.

    Args:
        meal (dict): Meal document from database
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        dict: Absorption profile with onset, peak, duration, gamma parameters
    """
    absorption_type = None

    if 'calculation_summary' in meal:
        absorption_type = meal['calculation_summary'].get('absorption_type')

    if not absorption_type and 'nutrition' in meal:
        absorption_type = meal['nutrition'].get('absorption_type')

    if not absorption_type:
        absorption_type = 'medium'

    profile = absorption_profiles.get(absorption_type, absorption_profiles['medium'])

    absorption_modifiers = patient_constants.get('absorption_modifiers', {})
    patient_modifier = absorption_modifiers.get(absorption_type, 1.0)

    return {
        'onset_hours': profile['onset_hours'],
        'peak_hours': profile['peak_hours'],
        'duration_hours': profile['duration_hours'],
        'curve_type': profile.get('curve_type', 'gamma_standard'),
        'shape_param': profile['shape_param'],
        'scale_param': profile['scale_param'],
        'absorption_type': absorption_type,
        'patient_modifier': patient_modifier
    }


def calculate_absorbed_fraction(hours_since_meal, profile, absorption_profiles):
    """
    Calculate fraction of carbs absorbed up to given time using numerical integration.

    Integrates the absorption activity curve from 0 to hours_since_meal,
    then divides by total area (0 to duration).

    Args:
        hours_since_meal (float): Time elapsed since meal
        profile (dict): Meal absorption profile
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        float: Fraction absorbed (0.0 - 1.0)
    """
    if hours_since_meal <= 0:
        return 0.0
    if hours_since_meal >= profile['duration_hours']:
        return 1.0

    steps = 100

    # Integrate from 0 to hours_since_meal
    dt = hours_since_meal / steps
    integral = 0.0
    for i in range(steps):
        t = i * dt
        activity = calculate_meal_activity_percentage(t, profile, absorption_profiles)
        integral += activity * dt

    # Total area for normalization (0 to duration)
    total_dt = profile['duration_hours'] / steps
    total_integral = 0.0
    for i in range(steps):
        t = i * total_dt
        activity = calculate_meal_activity_percentage(t, profile, absorption_profiles)
        total_integral += activity * total_dt

    if total_integral <= 0:
        return 0.0

    # Clamp to [0, 1]: this is a *fraction absorbed* and cannot exceed 1.
    #
    # Both integrals are 100-step left-Riemann sums, but over different step
    # sizes (`hours_since_meal/100` and `duration_hours/100`), so their
    # discretisation errors do not cancel and the ratio can drift a few parts
    # in 10,000 either side of 1 near the end of the window. Removing the
    # pre-onset ramp (D21c) steepened the curve's rise and made the overshoot
    # newly visible — measured at 1.000316 for `very_fast`.
    #
    # The clamp is definitional rather than cosmetic. Making the estimator
    # itself exact would mean integrating both on a common fixed grid, which
    # shifts every absorbed-carbohydrate value slightly and is a separate
    # decision — see the pre-ML audit §6.
    return min(1.0, max(0.0, integral / total_integral))


def calculate_meal_active_carbs(meal, current_time, patient_constants, absorption_profiles):
    """
    Calculate active carbs from a single meal — complete T1D model.

    Returns:
        - absorbed_carbs: Carbs that have entered bloodstream (PAST→PRESENT)
        - active_carbs (MOB): Carbs still being digested (PRESENT→FUTURE)
        - current_bg_elevation: BG impact from absorbed carbs
        - pending_bg_rise: Expected BG rise from MOB

    Args:
        meal (dict): Meal document
        current_time (datetime): Current timestamp (timezone-naive UTC)
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        dict: Complete meal absorption state
    """
    meal_time = meal.get('timestamp')
    if isinstance(meal_time, str):
        meal_time = datetime.fromisoformat(meal_time.replace('Z', '+00:00')).replace(tzinfo=None)

    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    hours_since_meal = TimeManager.calculate_hours_since(
        current_time, meal_time, TimeManager.PRECISION_SECOND
    )

    logger.debug(f"🍽️ MOB Calculation - Meal from {hours_since_meal:.2f}h ago")

    profile = get_meal_absorption_profile(meal, patient_constants, absorption_profiles)

    if hours_since_meal < 0 or hours_since_meal > profile['duration_hours']:
        return {
            'active_carbs': 0, 'absorbed_carbs': 0, 'total_carbs': 0,
            'activity_percent': 0, 'hours_elapsed': hours_since_meal,
            'absorption_type': profile['absorption_type'],
            'current_bg_elevation': 0, 'pending_bg_rise': 0
        }

    activity_percent = calculate_meal_activity_percentage(
        hours_since_meal, profile, absorption_profiles
    )

    # Get total carb equivalents
    total_carb_equiv = 0
    nutrition = meal.get('nutrition', {})

    if 'totalCarbEquiv' in nutrition:
        total_carb_equiv = nutrition['totalCarbEquiv']
    elif 'total_carb_equiv' in nutrition:
        total_carb_equiv = nutrition['total_carb_equiv']
    else:
        carbs = nutrition.get('carbs', 0)
        protein = nutrition.get('protein', 0) * patient_constants.get('protein_factor', 0.5)
        fat = nutrition.get('fat', 0) * patient_constants.get('fat_factor', 0.2)
        # Bug 6 fix (backend): subtract fiber fully (factor = 1.0).
        # ADA standard: net carbs = gross carbs − fiber.
        # Mirrors carb-equivalents.ts fiberFactor 0.1 → 1.0 fix.
        fiber = nutrition.get('fiber', 0)
        total_carb_equiv = max(0, carbs + protein + fat - fiber)

    absorbed_fraction = calculate_absorbed_fraction(
        hours_since_meal, profile, absorption_profiles
    )
    absorbed_carbs = total_carb_equiv * absorbed_fraction
    active_carbs = total_carb_equiv * (1 - absorbed_fraction)

    carb_to_bg_factor = patient_constants.get('carb_to_bg_factor', 4.0)
    current_bg_elevation = absorbed_carbs * carb_to_bg_factor
    pending_bg_rise = active_carbs * carb_to_bg_factor

    logger.debug(f"  Absorbed: {absorbed_carbs:.1f}g ({absorbed_fraction*100:.0f}%), Active: {active_carbs:.1f}g")
    logger.debug(f"  BG Elevation: +{current_bg_elevation:.0f}, Pending: +{pending_bg_rise:.0f}")

    return {
        'active_carbs': max(0, active_carbs),
        'absorbed_carbs': max(0, absorbed_carbs),
        'total_carbs': total_carb_equiv,
        'activity_percent': activity_percent,
        'hours_elapsed': hours_since_meal,
        'absorption_type': profile['absorption_type'],
        'peak_time': profile['peak_hours'],
        'duration_remaining': max(0, profile['duration_hours'] - hours_since_meal),
        'current_bg_elevation': round(current_bg_elevation, 1),
        'pending_bg_rise': round(pending_bg_rise, 1)
    }


def calculate_meal_total_carbs_for_window(meal, current_time, patient_constants, absorption_profiles):
    """
    Return total carb equivalents for a meal regardless of whether absorption
    has completed.  Used by the MOB comparison panel to count *all* carbs that
    entered the bloodstream within the query window — including meals that
    finished absorbing before the current moment.

    For active meals the returned dict is identical to calculate_meal_active_carbs.
    For fully-digested meals it still returns total_carbs / absorbed_carbs = total_carbs
    so callers can sum them correctly.

    Args:
        meal (dict): Meal document
        current_time (datetime): Current timestamp (timezone-naive UTC)
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        dict with keys: active_carbs, absorbed_carbs, total_carbs (never all-zero for real meals)
    """
    meal_time = meal.get('timestamp')
    if isinstance(meal_time, str):
        meal_time = datetime.fromisoformat(meal_time.replace('Z', '+00:00')).replace(tzinfo=None)

    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    hours_since_meal = TimeManager.calculate_hours_since(
        current_time, meal_time, TimeManager.PRECISION_SECOND
    )

    profile = get_meal_absorption_profile(meal, patient_constants, absorption_profiles)

    # Resolve total carb equivalents (same logic as calculate_meal_active_carbs)
    total_carb_equiv = 0
    nutrition = meal.get('nutrition', {})
    if 'totalCarbEquiv' in nutrition:
        total_carb_equiv = nutrition['totalCarbEquiv']
    elif 'total_carb_equiv' in nutrition:
        total_carb_equiv = nutrition['total_carb_equiv']
    else:
        carbs = nutrition.get('carbs', 0)
        protein = nutrition.get('protein', 0) * patient_constants.get('protein_factor', 0.5)
        fat = nutrition.get('fat', 0) * patient_constants.get('fat_factor', 0.2)
        # Bug 6 fix (backend): subtract fiber fully — ADA net-carb standard.
        fiber = nutrition.get('fiber', 0)
        total_carb_equiv = max(0, carbs + protein + fat - fiber)

    if total_carb_equiv <= 0 or hours_since_meal < 0:
        return {'active_carbs': 0, 'absorbed_carbs': 0, 'total_carbs': 0}

    # Meal fully digested — all carbs absorbed
    if hours_since_meal >= profile['duration_hours']:
        return {
            'active_carbs': 0,
            'absorbed_carbs': total_carb_equiv,
            'total_carbs': total_carb_equiv,
        }

    # Meal still absorbing — delegate to normal calculation
    result = calculate_meal_active_carbs(meal, current_time, patient_constants, absorption_profiles)
    return result


# ============================================================================
# INSULIN PHARMACODYNAMICS - Gamma Distribution + Peakless Models
# ============================================================================

def calculate_insulin_activity(hours_since_dose, params):
    """
    Calculate insulin activity using gamma distribution.
    Aligned with frontend insulinPharmacodynamics.js.

    Args:
        hours_since_dose (float): Hours elapsed since insulin administration
        params (dict): Insulin pharmacokinetic parameters

    Returns:
        float: Activity percentage (0-100)
    """
    onset_hours = params.get('onset_hours', 0.5)
    peak_hours = params.get('peak_hours', 2.0)
    duration_hours = params.get('duration_hours', 4.0)
    is_peakless = params.get('is_peakless', False)
    curve_type = params.get('curve_type', 'gamma_moderate')
    insulin_type = params.get('type', 'rapid_acting')

    if hours_since_dose < 0 or hours_since_dose > duration_hours:
        return 0

    if hours_since_dose < onset_hours:
        return 0

    # === PEAKLESS INSULIN (Long-Acting) ===
    if is_peakless:
        max_activity = 75
        is_ultra_long = insulin_type == 'ultra_long'

        rise_time = duration_hours * (0.35 if is_ultra_long else 0.25)
        plateau_start = duration_hours * (0.45 if is_ultra_long else 0.35)
        plateau_end = duration_hours * (0.80 if is_ultra_long else 0.75)

        if hours_since_dose <= rise_time:
            t = hours_since_dose / rise_time
            obtuse_curve = pow(t, 2.5 if is_ultra_long else 2.0)
            return max_activity * 0.6 * obtuse_curve

        if hours_since_dose <= plateau_start:
            transition_progress = (hours_since_dose - rise_time) / (plateau_start - rise_time)
            smooth_transition = 0.5 * (1 - math.cos(transition_progress * math.pi))
            return max_activity * 0.6 + (max_activity * 0.25 * smooth_transition)

        if hours_since_dose <= plateau_end:
            plateau_progress = (hours_since_dose - plateau_start) / (plateau_end - plateau_start)
            natural_variation = 0.01 * math.sin(plateau_progress * math.pi)
            return max_activity * 0.85 + (max_activity * natural_variation)

        decline_time = (hours_since_dose - plateau_end) / (duration_hours - plateau_end)
        light_decline = math.exp(-0.8 * decline_time)
        return max_activity * 0.85 * light_decline

    # === PEAKED INSULIN (Rapid/Short/Intermediate) ===
    max_activity = 100

    if curve_type in ['gamma_very_steep', 'gamma_steep']:
        alpha = 8.0 if curve_type == 'gamma_very_steep' else 6.5
        beta = 0.5
        peak_intensity = 1.0
    elif curve_type in ['gamma_moderate', 'gamma_standard']:
        alpha = 4.5
        beta = 0.8
        peak_intensity = 1.0
    else:
        alpha = 3.0
        beta = 1.0
        peak_intensity = 1.0

    scale = peak_hours / alpha
    gamma_value = pow(hours_since_dose / scale, alpha - 1) * math.exp(-hours_since_dose / scale)
    peak_value = pow(peak_hours / scale, alpha - 1) * math.exp(-peak_hours / scale)

    if peak_value <= 0:
        return 0

    normalized_value = gamma_value / peak_value

    if hours_since_dose <= peak_hours:
        if curve_type in ['gamma_very_steep', 'gamma_steep']:
            activity_value = max_activity * peak_intensity * pow(normalized_value, 0.8)
        else:
            activity_value = max_activity * peak_intensity * normalized_value
    else:
        time_past_peak = hours_since_dose - peak_hours
        remaining_duration = duration_hours - peak_hours
        tail_progress = time_past_peak / remaining_duration

        if curve_type in ['gamma_very_steep', 'gamma_steep']:
            decay_factor = math.exp(-beta * 0.6 * pow(tail_progress, 0.9))
        else:
            decay_factor = math.exp(-beta * 1.0 * pow(tail_progress, 1.1))

        activity_value = max_activity * peak_intensity * normalized_value * decay_factor

    return min(activity_value, max_activity)


def calculate_iob(hours_since_dose, initial_dose, profile):
    """
    Calculate IOB using trapezoidal integration.
    Aligned with frontend insulinPharmacodynamics.js.

    Args:
        hours_since_dose (float): Hours elapsed since administration
        initial_dose (float): Original insulin dose in units
        profile (dict): Insulin parameters

    Returns:
        float: Remaining active insulin in units
    """
    duration_hours = profile.get('duration_hours', 4.0)

    if hours_since_dose < 0 or hours_since_dose > duration_hours:
        return 0

    steps = 100
    dt = (duration_hours - hours_since_dose) / steps

    remaining_activity = 0
    for i in range(steps + 1):
        time = hours_since_dose + (i * dt)
        activity = calculate_insulin_activity(time, profile)
        if i == 0 or i == steps:
            remaining_activity += activity * 0.5
        else:
            remaining_activity += activity
    remaining_activity *= dt

    total_activity = 0
    total_dt = duration_hours / steps
    for i in range(steps + 1):
        time = i * total_dt
        activity = calculate_insulin_activity(time, profile)
        if i == 0 or i == steps:
            total_activity += activity * 0.5
        else:
            total_activity += activity
    total_activity *= total_dt

    fraction_remaining = remaining_activity / total_activity if total_activity > 0 else 0

    return initial_dose * fraction_remaining


def project_mob_at_time(active_meal_carbs, estimated_elapsed_hours, projection_hours,
                        absorption_type, absorption_profiles):
    """
    Project remaining MOB at a future time using the real absorption model
    instead of a simplified linear decay.

    Args:
        active_meal_carbs (float): Currently active (unabsorbed) carbs
        estimated_elapsed_hours (float): Estimated hours since existing meal
        projection_hours (float): Hours into the future to project
        absorption_type (str): Absorption type of the existing meal
        absorption_profiles (dict): MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        float: Projected remaining carbs at (now + projection_hours)
    """
    if active_meal_carbs <= 0:
        return 0.0

    profile = absorption_profiles.get(absorption_type, absorption_profiles.get('medium', {}))
    duration = profile.get('duration_hours', 4.0)

    # Current fraction absorbed at estimated_elapsed_hours
    current_fraction = calculate_absorbed_fraction(estimated_elapsed_hours, profile, absorption_profiles)

    # Future fraction absorbed at (estimated_elapsed + projection_hours)
    future_time = estimated_elapsed_hours + projection_hours
    future_fraction = calculate_absorbed_fraction(future_time, profile, absorption_profiles)

    # The active_meal_carbs represent total_carbs * (1 - current_fraction)
    # So total_carbs = active_meal_carbs / (1 - current_fraction)
    if current_fraction >= 1.0:
        return 0.0

    total_carbs = active_meal_carbs / (1 - current_fraction)
    projected_remaining = total_carbs * (1 - future_fraction)

    return max(0, projected_remaining)


def project_iob_at_time(active_insulin, estimated_elapsed_hours, projection_hours, profile):
    """
    Project remaining IOB at a future time using the real insulin model
    instead of a simplified exponential decay.

    Args:
        active_insulin (float): Currently active insulin (IOB)
        estimated_elapsed_hours (float): Estimated hours since dose
        projection_hours (float): Hours into the future to project
        profile (dict): Insulin pharmacokinetic parameters

    Returns:
        float: Projected remaining IOB at (now + projection_hours)
    """
    if active_insulin <= 0:
        return 0.0

    duration_hours = profile.get('duration_hours', 4.0)

    # Current IOB fraction
    current_iob = calculate_iob(estimated_elapsed_hours, 1.0, profile)

    if current_iob <= 0:
        return 0.0

    # Future IOB fraction
    future_time = estimated_elapsed_hours + projection_hours
    future_iob = calculate_iob(future_time, 1.0, profile)

    # Scale: active_insulin = initial_dose * current_iob_fraction
    # So initial_dose = active_insulin / current_iob_fraction
    # Projected IOB = initial_dose * future_iob_fraction
    initial_dose = active_insulin / current_iob
    projected_iob = initial_dose * future_iob

    return max(0, projected_iob)


# ============================================================================
# CUMULATIVE EFFECTS CALCULATION - FOR ACTIVEEFFECTSDISPLAY
# ============================================================================

def get_daily_reset_time(current_time, reset_hour=7, timezone_offset_minutes=0):
    """
    Get the most recent daily reset time before the current timestamp.
    Cumulative effects reset at this hour each day (default 7 AM).

    🆕 v4.3 - TIMEZONE FIX: Now uses patient's timezone_offset_minutes
    Delegates to TimeManager.get_daily_reset_time() for consistency with frontend.

    Args:
        current_time (datetime): Current timestamp (timezone-naive UTC)
        reset_hour (int): Hour of day for reset in LOCAL time (0-23), default 7
        timezone_offset_minutes (int): Patient's timezone offset from UTC in minutes
                                      Examples: UTC+2 = 120, UTC-5 = -300, UTC = 0

    Returns:
        datetime: Most recent reset time expressed as UTC-naive datetime
    """
    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    # Use TimeManager for timezone-aware reset calculation
    reset_ms = TimeManager.get_daily_reset_time(
        current_timestamp=current_time,
        reset_hour=reset_hour,
        timezone_offset_minutes=timezone_offset_minutes
    )

    return datetime.utcfromtimestamp(reset_ms / TimeManager.MILLISECONDS_PER_SECOND)


def is_within_current_day(dose_time, current_time, reset_hour=7, timezone_offset_minutes=0):
    """
    Check if a dose/meal should be included in cumulative calculation.
    Only include doses AFTER the most recent reset (not AT reset hour).

    🆕 v4.3 - TIMEZONE FIX: Now accepts timezone_offset_minutes parameter

    Args:
        dose_time (datetime): Time of dose/meal
        current_time (datetime): Current time
        reset_hour (int): Hour of day for reset (0-23), default 7
        timezone_offset_minutes (int): Patient's timezone offset from UTC in minutes

    Returns:
        bool: True if dose is within current day (after last reset)
    """
    if not isinstance(dose_time, datetime):
        dose_time = TimeManager.to_datetime(dose_time, TimeManager.PRECISION_SECOND)
    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    reset_time = get_daily_reset_time(current_time, reset_hour, timezone_offset_minutes)

    # Exclude doses exactly at reset hour for clean reset
    return dose_time > reset_time


def calculate_insulin_absorption_fraction(hours_since_dose, profile):
    """
    Calculate insulin absorption fraction at a given time.
    Returns 1.0 (100%) after completion and STAYS THERE.

    This is different from IOB which drops to 0 after completion.
    IOB tracks "on board" (remaining), this tracks "absorbed" (cumulative).

    Args:
        hours_since_dose (float): Hours elapsed since dose
        profile (dict): Insulin pharmacokinetic parameters

    Returns:
        float: Fraction absorbed (0.0-1.0)
    """
    if hours_since_dose <= 0:
        return 0.0

    duration_hours = profile.get('duration_hours', 4.0)

    # After duration, absorption is complete and PERSISTS at 100%
    if hours_since_dose >= duration_hours:
        return 1.0

    # During absorption: absorbed = 1.0 - IOB_fraction
    iob_fraction = calculate_iob(hours_since_dose, 1.0, profile)
    absorption_fraction = 1.0 - iob_fraction

    return max(0.0, min(1.0, absorption_fraction))


def calculate_meal_cumulative_effect(meal, current_time, patient_constants,
                                    absorption_profiles, reset_hour=7, timezone_offset_minutes=0):
    """
    Calculate cumulative effect of a single meal at a specific time.
    Effect PERSISTS even after absorption completes (until daily reset).

    This represents the permanent BG elevation from absorbed carbs.
    Unlike MOB (which drops to 0), this stays at totalEffect after completion.

    🆕 v4.3 - TIMEZONE FIX: Now accepts timezone_offset_minutes parameter

    Args:
        meal (dict): Meal document from database
        current_time (datetime): Current timestamp (timezone-naive UTC)
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants
        reset_hour (int): Hour of day for daily reset (default 7)
        timezone_offset_minutes (int): Patient's timezone offset from UTC in minutes

    Returns:
        float: Cumulative BG effect in mg/dL
    """
    meal_time = meal.get('timestamp')
    if isinstance(meal_time, str):
        meal_time = datetime.fromisoformat(meal_time.replace('Z', '+00:00')).replace(tzinfo=None)

    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    # Skip meals from before today's reset
    if not is_within_current_day(meal_time, current_time, reset_hour, timezone_offset_minutes):
        return 0.0

    carb_to_bg_factor = patient_constants.get('carb_to_bg_factor', 4.0)
    profile = get_meal_absorption_profile(meal, patient_constants, absorption_profiles)

    # Phase 1: Before meal starts
    if current_time < meal_time:
        return 0.0

    # Get total carbs
    total_carbs = 0
    if 'calculation_summary' in meal:
        total_carbs = meal['calculation_summary'].get('total_carb_equiv', 0)
    if not total_carbs and 'nutrition' in meal:
        total_carbs = meal['nutrition'].get('total_carb_equiv', 0)
        if not total_carbs:
            total_carbs = meal['nutrition'].get('totalCarbEquiv', 0)

    if total_carbs <= 0:
        return 0.0

    duration_hours = profile.get('duration_hours', 4.0)
    end_time = meal_time + timedelta(hours=duration_hours)

    # Phase 3: After absorption completes - PERSIST at 100%
    # THIS IS THE CRITICAL FIX - Effect stays at total even after completion
    if current_time >= end_time:
        return total_carbs * carb_to_bg_factor  # PERSISTS until next reset

    # Phase 2: During absorption
    hours_since_meal = TimeManager.calculate_hours_since(
        current_time, meal_time, TimeManager.PRECISION_SECOND
    )
    absorption_fraction = calculate_absorbed_fraction(hours_since_meal, profile, absorption_profiles)
    return total_carbs * min(absorption_fraction, 1.0) * carb_to_bg_factor


def calculate_insulin_cumulative_effect(dose, current_time, patient_constants, reset_hour=7, timezone_offset_minutes=0):
    """
    Calculate cumulative effect of a single insulin dose at a specific time.
    Effect PERSISTS even after absorption completes (until daily reset).

    This represents the permanent BG reduction from absorbed insulin.
    Unlike IOB (which drops to 0), this stays at totalEffect after completion.

    🆕 v4.3 - TIMEZONE FIX: Now accepts timezone_offset_minutes parameter

    Args:
        dose (dict): Insulin dose document from database
        current_time (datetime): Current timestamp (timezone-naive UTC)
        patient_constants (dict): Patient-specific constants
        reset_hour (int): Hour of day for daily reset (default 7)
        timezone_offset_minutes (int): Patient's timezone offset from UTC in minutes

    Returns:
        float: Cumulative BG effect in mg/dL (negative value)
    """
    dose_time = dose.get('taken_at') or dose.get('administrationTime')
    if isinstance(dose_time, str):
        dose_time = datetime.fromisoformat(dose_time.replace('Z', '+00:00')).replace(tzinfo=None)

    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    # Skip doses from before today's reset
    if not is_within_current_day(dose_time, current_time, reset_hour, timezone_offset_minutes):
        return 0.0

    correction_factor = patient_constants.get('correction_factor', 40)  # B-1 fix: was 50, must match calculate_stable_baseline_from_reading (L927) and all TS consumers
    # Bug 9 fix: default to 'insulin_aspart' (canonical rapid-acting) instead of
    # 'regular_insulin' (8-h short-acting) — mirrors the fix in cumulative-effects.ts.
    medication = dose.get('medication', 'insulin_aspart')

    # Get insulin profile
    profile = dose.get('effect_profile')
    if not profile:
        medication_factors = patient_constants.get('medication_factors', {})
        # Bug 9 fix: fall back to insulin_aspart profile so that unknown medication
        # types get a full profile with correct shape, not just a bare 4-h duration.
        profile = (
            medication_factors.get(medication)
            or medication_factors.get('insulin_aspart')
            or {
                'onset_hours': 0.375,
                'peak_hours': 2.25,
                'duration_hours': 4.5,
                'type': 'rapid_acting',
                'is_peakless': False,
                'curve_type': 'gamma_steep',
            }
        )

    # Phase 1: Before dose starts
    if current_time < dose_time:
        return 0.0

    dose_amount = dose.get('dose', 0)
    if dose_amount <= 0:
        return 0.0

    duration_hours = profile.get('duration_hours', 4.0)
    end_time = dose_time + timedelta(hours=duration_hours)

    # Phase 3: After absorption completes - PERSIST at 100%
    # THIS IS THE CRITICAL FIX - Effect stays at total even after completion
    if current_time >= end_time:
        return -(dose_amount * correction_factor)  # PERSISTS until next reset (negative for BG reduction)

    # Phase 2: During absorption
    hours_since_dose = TimeManager.calculate_hours_since(
        current_time, dose_time, TimeManager.PRECISION_SECOND
    )
    absorption_fraction = calculate_insulin_absorption_fraction(hours_since_dose, profile)
    return -(dose_amount * absorption_fraction * correction_factor)


def calculate_instantaneous_meal_effect(meals, current_time, patient_constants, absorption_profiles):
    """
    Calculate instantaneous meal effect - BG elevation from absorbed carbs RIGHT NOW.

    This is different from cumulative meal effect:
    - Instantaneous: Only counts active meals (within duration window)
    - Cumulative: Counts all absorbed carbs since reset (persists after completion)

    This matches the frontend's "Current Meal Impact" calculation.

    Args:
        meals (list): List of meal documents
        current_time (datetime): Current timestamp (timezone-naive UTC)
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants

    Returns:
        float: Instantaneous BG elevation from absorbed carbs (mg/dL)
    """
    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    instantaneous_meal_impact = 0.0

    for meal in meals:
        meal_data = calculate_meal_active_carbs(meal, current_time, patient_constants, absorption_profiles)

        # Only count meals that are still within their duration window
        # After completion, they contribute to cumulative but not instantaneous
        if meal_data['active_carbs'] > 0 or meal_data['absorbed_carbs'] > 0:
            instantaneous_meal_impact += meal_data['current_bg_elevation']

    return round(instantaneous_meal_impact, 1)



def calculate_stable_baseline_from_reading(
    reading_value,
    reading_timestamp,
    meals,
    insulin_doses,
    patient_constants,
    absorption_profiles,
    reset_hour=7,
    timezone_offset_minutes=0,
    activity_effect_at_reading=0.0,
):
    """
    Calculate stable metabolic baseline by removing cumulative effects from a BG reading.

    ✅ T1D CUMULATIVE MODEL (v1.3): FIXED - Only includes meals/insulin BEFORE reading time
    Formula: Stable Baseline = Reading - (Cumulative Meal Effect - Cumulative Insulin Effect - Activity Effect at Reading)

    🩺 EXERCISE FIX: If the patient exercised before the reading, the exercise-induced BG
    drop is already baked into the reading value. The old formula omitted this, causing the
    baseline to be underestimated by exactly activity_effect_at_reading.  Caller should pass
    calculate_stacked_activity_effect(activities, reading_timestamp, patient_constants)
    ['cumulative_activity_effect'] — a signed float (negative = BG-lowering).

    CRITICAL FIX (2026-02-13): Future event handling
    - Now SKIPS meals/insulin that occurred AFTER the reading
    - Previously treated future events as "just started" (hours_since = 0), causing negative baselines
    - Now only includes effects from meals/insulin that had actually occurred by reading time

    Example Timeline:
        7:00 AM  - Daily reset
        2:04 PM  - Meal consumed ← Include (happened before reading)
        4:04 PM  - Reading taken ← Calculate baseline at this point
        4:04 PM  - Insulin taken ← SKIP (same time or after reading)

    At reading time (4:04 PM), only the meal effect should be counted, not the insulin.

    🔧 PREVIOUS FIX (2026-02-13): Field lookup consistency
    - Uses get_meal_absorption_profile() for proper meal field lookup
    - Uses same carbs field hierarchy as calculate_total_cumulative_effects()
    - Fixes bug where meals showed 0 carbs due to wrong field names

    Args:
        reading_value (float): Blood glucose reading in mg/dL
        reading_timestamp (datetime): When the reading was taken
        meals (list): ALL meal documents from today (after daily reset)
                      NOTE: Will be filtered to only include meals BEFORE reading_timestamp
        insulin_doses (list): ALL insulin doses from today (after daily reset)
                              NOTE: Will be filtered to only include doses BEFORE reading_timestamp
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): MEAL_ABSORPTION_PROFILES from Constants
        reset_hour (int): Daily reset hour
        timezone_offset_minutes (int): Timezone offset

    Returns:
        dict: {
            'stable_baseline': float,              # Metabolic baseline (removing effects at reading time)
            'reading_value': float,                # Original reading
            'reading_timestamp': str,              # When reading was taken
            'cumulative_meal_effect': float,       # Meal BG elevation at reading time
            'cumulative_insulin_effect': float,    # Insulin BG reduction at reading time
            'cumulative_net_effect': float,        # Net cumulative effect at reading time
            'meals_count': int,                    # Number of meals included (before reading)
            'insulin_count': int                   # Number of insulin doses included (before reading)
        }
    """
    if not isinstance(reading_timestamp, datetime):
        reading_timestamp = TimeManager.to_datetime(reading_timestamp, TimeManager.PRECISION_SECOND)

    logger.info(f"🩸 Calculating stable baseline from reading at {reading_timestamp.isoformat()}")
    logger.info(f"✅ Filtering to meals/insulin that occurred BEFORE reading time")
    logger.info(f"  Total meals provided: {len(meals)}, Total insulin doses provided: {len(insulin_doses)}")

    # ============================================================================
    # ✅ CORRECT APPROACH: Calculate effects from meals/insulin BEFORE reading
    # ============================================================================
    # We calculate cumulative effects from meals/insulin that occurred BEFORE
    # the reading time. Future meals/insulin (that happened after) are skipped
    # because they couldn't have affected the reading value.

    # ✅ FIX 1: use the correct key name ('carb_to_bg_factor', not 'carb_to_bg_ratio').
    # Using the wrong key caused a silent fallback to 4.0 even when the patient's
    # actual factor differs, producing a systematic BG-estimate error.
    # Fallback to 'carb_to_bg_ratio' preserves backward compat with old documents.
    carb_to_bg_ratio = patient_constants.get('carb_to_bg_factor',
                        patient_constants.get('carb_to_bg_ratio', 4.0))
    correction_factor = patient_constants.get('correction_factor', 40)

    # Calculate cumulative meal effect from ALL today's meals
    cumulative_meal_effect = 0.0
    meals_at_reading = []

    for meal in meals:
        meal_time = meal.get('timestamp')
        if isinstance(meal_time, str):
            meal_time = datetime.fromisoformat(meal_time.replace('Z', '+00:00')).replace(tzinfo=None)

        # ✅ CORRECT BEHAVIOR: Only include meals that occurred BEFORE reading
        # (Future meals will be skipped in the check below)

        # Calculate hours since meal at reading time
        hours_since_meal_at_reading = TimeManager.calculate_hours_since(
            reading_timestamp, meal_time, TimeManager.PRECISION_SECOND
        )

        # ✅ CRITICAL FIX: Skip meals that occurred AFTER the reading
        # These meals are "in the future" relative to the reading time and should NOT
        # be counted in cumulative effects at reading time (they hadn't happened yet!)
        if hours_since_meal_at_reading < 0:
            logger.debug(f"  ⏩ Skipping meal at {meal_time.isoformat()} (occurred {abs(hours_since_meal_at_reading):.1f}h after reading)")
            continue

        # ✅ FIX: Use get_meal_absorption_profile for proper field lookup
        profile = get_meal_absorption_profile(meal, patient_constants, absorption_profiles)

        # ✅ FIX: Use same field lookup logic as calculate_total_cumulative_effects
        total_carbs = 0
        if 'calculation_summary' in meal:
            total_carbs = meal['calculation_summary'].get('total_carb_equiv', 0)
        if not total_carbs and 'nutrition' in meal:
            total_carbs = meal['nutrition'].get('total_carb_equiv', 0)
            if not total_carbs:
                total_carbs = meal['nutrition'].get('totalCarbEquiv', 0)
        if not total_carbs:
            total_carbs = meal.get('carbEquiv', 0)  # Fallback to old field name

        if total_carbs == 0:
            continue

        # Calculate absorbed carbs at reading time
        # ✅ FIX 2: delegate to calculate_absorbed_fraction instead of a local
        # fixed-step (dt=0.05) integration loop.  calculate_absorbed_fraction uses
        # 100 proportional steps — the same resolution as the frontend — eliminating
        # the ~1.5 mg/dL numerical integration divergence.
        duration = profile.get('duration_hours', 4.0)
        if hours_since_meal_at_reading <= duration:
            absorption_fraction = calculate_absorbed_fraction(
                hours_since_meal_at_reading, profile, absorption_profiles
            )
        else:
            absorption_fraction = 1.0  # Fully absorbed — cumulative effect persists

        absorbed_carbs = total_carbs * absorption_fraction
        bg_effect = absorbed_carbs * carb_to_bg_ratio
        cumulative_meal_effect += bg_effect

        meals_at_reading.append({
            'meal_id': str(meal.get('_id')),
            'hours_since': round(hours_since_meal_at_reading, 2),
            'total_carbs': total_carbs,
            'absorbed_carbs': round(absorbed_carbs, 1),
            'bg_effect': round(bg_effect, 1),
            'absorption_fraction': round(absorption_fraction, 3)
        })

    # Calculate cumulative insulin effect from ALL today's doses
    cumulative_insulin_effect = 0.0
    insulin_at_reading = []

    for dose in insulin_doses:
        dose_time = dose.get('taken_at') or dose.get('administrationTime')
        if isinstance(dose_time, str):
            dose_time = datetime.fromisoformat(dose_time.replace('Z', '+00:00')).replace(tzinfo=None)

        # ✅ CORRECT BEHAVIOR: Only include insulin doses that occurred BEFORE reading
        # (Future doses will be skipped in the check below)

        # Calculate hours since dose at reading time
        hours_since_dose_at_reading = TimeManager.calculate_hours_since(
            reading_timestamp, dose_time, TimeManager.PRECISION_SECOND
        )

        # ✅ CRITICAL FIX: Skip insulin doses that occurred AFTER the reading
        # These doses are "in the future" relative to the reading time and should NOT
        # be counted in cumulative effects at reading time (they hadn't happened yet!)
        if hours_since_dose_at_reading < 0:
            logger.debug(f"  ⏩ Skipping insulin dose at {dose_time.isoformat()} (occurred {abs(hours_since_dose_at_reading):.1f}h after reading)")
            continue

        # Bug 9 fix: default to 'insulin_aspart' and use its full profile as
        # fallback — matches the fix applied to calculate_insulin_cumulative_effect.
        medication = dose.get('medication', 'insulin_aspart')
        medication_factors = patient_constants.get('medication_factors', {})
        profile = (
            medication_factors.get(medication)
            or medication_factors.get('insulin_aspart')
            or {
                'onset_hours': 0.375,
                'peak_hours': 2.25,
                'duration_hours': 4.5,
                'type': 'rapid_acting',
            }
        )

        dose_amount = dose.get('dose', 0)
        if dose_amount == 0:
            continue

        # Calculate absorbed insulin at reading time
        # - Dose occurred before reading: use actual hours since dose at reading time
        # - If within duration: use absorption fraction
        # - If beyond duration: 100% absorbed
        duration = profile.get('duration_hours', 4.0)
        if hours_since_dose_at_reading <= duration:
            absorption_fraction = calculate_insulin_absorption_fraction(hours_since_dose_at_reading, profile)
        else:
            absorption_fraction = 1.0  # Fully absorbed

        absorbed_insulin = dose_amount * absorption_fraction
        bg_effect = absorbed_insulin * correction_factor
        cumulative_insulin_effect += bg_effect

        insulin_at_reading.append({
            'dose_id': str(dose.get('_id')),
            'medication': medication,
            'hours_since': round(hours_since_dose_at_reading, 2),
            'total_dose': dose_amount,
            'absorbed_insulin': round(absorbed_insulin, 2),
            'bg_effect': round(bg_effect, 1),
            'absorption_fraction': round(absorption_fraction, 3)
        })

    # ============================================================================
    # FORMULA: Stable Baseline using Cumulative Net Effect
    # ============================================================================
    # Reading = Baseline + Cumulative Meal Effect - Cumulative Insulin Effect
    # Therefore: Baseline = Reading - Cumulative Meal Effect + Cumulative Insulin Effect
    # Or equivalently: Baseline = Reading - (Cumulative Meal - Cumulative Insulin)
    #
    # ⚠️ SIGN CONVENTION — THIS FUNCTION uses CONVENTION B:
    #   cumulative_insulin_effect is accumulated as a POSITIVE magnitude, then SUBTRACTED.
    #   i.e.  net = meal_effect - insulin_effect   (both terms are positive numbers)
    #
    # calculate_total_cumulative_effects() uses CONVENTION A (the other convention):
    #   cumulative_insulin_effect is stored as a NEGATIVE value, then ADDED.
    #   i.e.  net = meal_effect + insulin_effect   (insulin_effect is already negative)
    #
    # Both are mathematically equivalent, but the intermediate values are NOT
    # interchangeable between the two functions. Never pass cumulative_insulin_effect
    # from one function as input to the other without negating it first.

    # ── Include exercise effect that was already baked into the reading ──────────
    # activity_effect_at_reading is signed (negative = BG-lowering).
    # Subtracting it here removes that exercise contribution from the net effect,
    # so the extracted baseline reflects true fasting BG without any intervention.
    # Error scenario without this fix: 45-min moderate session → ~6–7 mg/dL low baseline.
    cumulative_net_effect = cumulative_meal_effect - cumulative_insulin_effect + activity_effect_at_reading
    stable_baseline = reading_value - cumulative_net_effect

    # ── Hard-clamp baseline to physiological limits ───────────────────────────
    # Clamps values < 55 or > 220 mg/dL and attaches a CRITICAL warning.
    # Mirrors mobile/utils/calculations/baseline.ts::sanitizeBaseline().
    sanitized = sanitize_baseline(stable_baseline)
    if sanitized['warnings']:
        for w in sanitized['warnings']:
            logger.warning(f"⚠️ [sanitize_baseline] {w}")
    stable_baseline = sanitized['value']
    baseline_sanitize_status = sanitized['status']

    # Add validation warning for edge cases
    if stable_baseline < 40:
        logger.warning(f"⚠️ Calculated baseline is very low ({stable_baseline:.1f} mg/dL)")
        logger.warning(f"  This may indicate:")
        logger.warning(f"  - Reading was taken before today's daily period")
        logger.warning(f"  - Cumulative effects are very large relative to reading")
        logger.warning(f"  - Reading may be too old for accurate baseline estimation")

    logger.info(f"📊 Baseline Calculation (✅ T1D Cumulative Model):")
    logger.info(f"  Reading Value: {reading_value} mg/dL at {reading_timestamp.isoformat()}")
    logger.info(f"  Cumulative Meal Effect (ALL today): +{cumulative_meal_effect:.1f} mg/dL from {len(meals_at_reading)} meals")
    logger.info(f"  Cumulative Insulin Effect (ALL today): -{cumulative_insulin_effect:.1f} mg/dL from {len(insulin_at_reading)} doses")
    logger.info(f"  Activity Effect at Reading Time: {activity_effect_at_reading:+.1f} mg/dL (subtracted from net to recover true baseline)")
    logger.info(f"  Cumulative Net Effect (ALL today): {cumulative_net_effect:+.1f} mg/dL")
    logger.info(f"  ✅ Stable Baseline: {stable_baseline:.1f} mg/dL")
    logger.info(f"  Formula: {reading_value} - ({cumulative_meal_effect:.1f} - {cumulative_insulin_effect:.1f} - ({activity_effect_at_reading:.1f})) = {stable_baseline:.1f}")
    logger.info(f"  Note: This baseline represents BG with all of today's interventions removed")

    return {
        'stable_baseline': round(stable_baseline, 1),
        'reading_value': round(reading_value, 1),
        'reading_timestamp': reading_timestamp.isoformat(),
        'cumulative_meal_effect': round(cumulative_meal_effect, 1),
        'cumulative_insulin_effect': round(cumulative_insulin_effect, 1),
        'cumulative_net_effect': round(cumulative_net_effect, 1),
        'activity_effect_at_reading': round(activity_effect_at_reading, 1),
        'meals_at_reading': meals_at_reading,
        'insulin_at_reading': insulin_at_reading,
        'meals_count': len(meals_at_reading),
        'insulin_count': len(insulin_at_reading),
        'baseline_sanitize_status': baseline_sanitize_status,
        'baseline_warnings': sanitized['warnings'],
    }


def calculate_total_cumulative_effects(meals, insulin_doses, current_time,
                                       patient_constants, absorption_profiles, reset_hour=7, timezone_offset_minutes=0):
    """
    Calculate total cumulative effects from all meals and insulin doses.

    Returns both:
    1. Current activity (dE/dt) - rate of change happening NOW (for MOB/IOB)
    2. Cumulative baseline (E_cumulative) - accumulated shift from baseline

    The cumulative baseline represents the "bank balance" that resets daily.
    It persists even after absorption completes until the next daily reset.

    🆕 v4.3 - TIMEZONE FIX: Now accepts timezone_offset_minutes parameter

    Args:
        meals (list): List of meal documents
        insulin_doses (list): List of insulin dose documents
        current_time (datetime): Current timestamp (timezone-naive UTC)
        patient_constants (dict): Patient-specific constants
        absorption_profiles (dict): The MEAL_ABSORPTION_PROFILES from Constants
        reset_hour (int): Hour of day for daily reset (default 7)
        timezone_offset_minutes (int): Patient's timezone offset from UTC in minutes

    Returns:
        dict: Complete cumulative effects breakdown
    """
    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    # Initialize totals
    cumulative_meal_effect = 0.0
    cumulative_insulin_effect = 0.0
    meal_contributions = []
    insulin_contributions = []

    # Calculate cumulative meal effects (only from current day)
    for meal in meals:
        meal_effect = calculate_meal_cumulative_effect(
            meal, current_time, patient_constants, absorption_profiles, reset_hour, timezone_offset_minutes
        )

        if meal_effect > 0:
            cumulative_meal_effect += meal_effect

            meal_time = meal.get('timestamp')
            if isinstance(meal_time, str):
                meal_time = datetime.fromisoformat(meal_time.replace('Z', '+00:00')).replace(tzinfo=None)

            # Get meal details
            total_carbs = 0
            if 'calculation_summary' in meal:
                total_carbs = meal['calculation_summary'].get('total_carb_equiv', 0)
            if not total_carbs and 'nutrition' in meal:
                total_carbs = meal['nutrition'].get('total_carb_equiv', 0)
                if not total_carbs:
                    total_carbs = meal['nutrition'].get('totalCarbEquiv', 0)

            meal_contributions.append({
                'meal_id': str(meal.get('_id')),
                'meal_time': meal_time.isoformat() if isinstance(meal_time, datetime) else meal_time,
                'meal_type': meal.get('mealType', 'unknown'),
                'total_carbs': round(total_carbs, 1),
                'cumulative_bg_effect': round(meal_effect, 1)
            })

    # Calculate cumulative insulin effects (only from current day)
    for dose in insulin_doses:
        insulin_effect = calculate_insulin_cumulative_effect(
            dose, current_time, patient_constants, reset_hour, timezone_offset_minutes
        )

        if insulin_effect < 0:  # Negative = BG reduction
            cumulative_insulin_effect += insulin_effect

            dose_time = dose.get('taken_at') or dose.get('administrationTime')
            if isinstance(dose_time, str):
                dose_time = datetime.fromisoformat(dose_time.replace('Z', '+00:00')).replace(tzinfo=None)

            insulin_contributions.append({
                'dose_id': str(dose.get('_id')),
                'dose_time': dose_time.isoformat() if isinstance(dose_time, datetime) else dose_time,
                'medication': dose.get('medication', 'unknown'),
                'dose': round(dose.get('dose', 0), 2),
                'cumulative_bg_effect': round(insulin_effect, 1)
            })

    # ⚠️ SIGN CONVENTION — THIS FUNCTION uses CONVENTION A:
    #   calculate_insulin_cumulative_effect() returns a NEGATIVE value (BG reduction).
    #   cumulative_insulin_effect is therefore a negative number, and net is computed
    #   via ADDITION:  net = meal_effect + insulin_effect  (insulin already negative)
    #
    # calculate_stable_baseline_from_reading() uses CONVENTION B (the other convention):
    #   its cumulative_insulin_effect is a POSITIVE magnitude, combined via SUBTRACTION.
    #
    # Never mix values from these two functions without negating the insulin term first.
    cumulative_net_baseline = cumulative_meal_effect + cumulative_insulin_effect

    return {
        'cumulative_meal_effect': round(cumulative_meal_effect, 1),
        'cumulative_insulin_effect': round(cumulative_insulin_effect, 1),
        'cumulative_net_baseline': round(cumulative_net_baseline, 1),
        'meal_contributions': meal_contributions,
        'insulin_contributions': insulin_contributions,
        'reset_hour': reset_hour,
        'calculation_time': current_time.isoformat(),
        'next_reset': get_daily_reset_time(current_time + timedelta(days=1), reset_hour, timezone_offset_minutes).isoformat()
    }


def build_circadian_baseline_result(
    current_time,
    patient_constants,
    timezone_offset_minutes=0
):
    """
    Build a baseline result dict using the preset 24-hour circadian profile.

    This is the 'preset' mode counterpart of calculate_stable_baseline_from_reading().
    It returns an identical dict shape so all downstream callers
    (calculate_total_cumulative_effects, the /cumulative-effects route, the
    mobile hooks) can treat both modes identically without any branching below
    this point.

    Formula:
        stable_baseline = circadian_profile.interpolate(local_hour_of_day)

    No BG reading is required. The baseline is read directly from the
    patient's circadian_profile anchors (or the T1D default preset if none
    are stored) at the current local hour.

    Args:
        current_time (datetime):        Current UTC timestamp (timezone-naive)
        patient_constants (dict):       Patient constants dict from
                                        Constants.get_patient_constants()
        timezone_offset_minutes (int):  Patient UTC offset in minutes
                                        (e.g. UTC+2 = 120, UTC-5 = -300)

    Returns:
        dict matching the shape of calculate_stable_baseline_from_reading():
        {
            'stable_baseline':           float,  # mg/dL from circadian profile
            'baseline_mode':             'preset',
            'reading_value':             None,   # no reading used
            'reading_timestamp':         None,
            'cumulative_meal_effect':    0.0,    # effects added on top by caller
            'cumulative_insulin_effect': 0.0,
            'cumulative_net_effect':     0.0,
            'meals_count':               0,
            'insulin_count':             0,
            'circadian_hour':            float,  # local hour used for lookup
            'profile_source':            str,    # 'preset' or 'custom'
        }
    """
    if not isinstance(current_time, datetime):
        current_time = TimeManager.to_datetime(current_time, TimeManager.PRECISION_SECOND)

    # Convert UTC to patient local time for the hour lookup
    local_offset_hours = timezone_offset_minutes / 60.0
    local_hour = (
        current_time.hour
        + current_time.minute / 60.0
        + current_time.second / 3600.0
        + local_offset_hours
    ) % 24.0

    # Resolve profile — use patient's custom profile if stored, else default
    circadian_profile = patient_constants.get('circadian_profile', {})
    if not circadian_profile.get('anchors'):
        # Fallback: build default inline rather than importing get_default_circadian_profile
        # to avoid any risk of circular import at call time
        from constants import get_default_circadian_profile
        circadian_profile = get_default_circadian_profile(
            target_glucose=patient_constants.get('target_glucose', 100)
        )

    stable_baseline = get_circadian_baseline_at_hour(local_hour, circadian_profile)
    profile_source  = circadian_profile.get('source', 'preset')

    logger.info(
        f"Circadian baseline (preset mode): "
        f"local_hour={local_hour:.2f}h → {stable_baseline} mg/dL "
        f"(source={profile_source})"
    )

    return {
        'stable_baseline':           round(stable_baseline, 1),
        'baseline_mode':             'preset',
        'reading_value':             None,
        'reading_timestamp':         None,
        'cumulative_meal_effect':    0.0,
        'cumulative_insulin_effect': 0.0,
        'cumulative_net_effect':     0.0,
        'meals_count':               0,
        'insulin_count':             0,
        'circadian_hour':            round(local_hour, 3),
        'profile_source':            profile_source,
    }


def get_baseline_result(
    baseline_mode,
    current_time,
    patient_constants,
    meals=None,
    insulin_doses=None,
    latest_reading=None,
    absorption_profiles=None,
    reset_hour=7,
    timezone_offset_minutes=0
):
    """
    Unified baseline resolver — returns the correct baseline dict for either mode.

    This is the single call-site that cumulative_effects_routes.py and any
    other route should use.  It abstracts the mode switch so routes contain
    zero branching logic.

    Args:
        baseline_mode (str):            'dynamic' or 'preset'
        current_time (datetime):        Current UTC timestamp
        patient_constants (dict):       From Constants.get_patient_constants()
        meals (list):                   Required for 'dynamic' mode
        insulin_doses (list):           Required for 'dynamic' mode
        latest_reading (dict|None):     Required for 'dynamic' mode.
                                        Must have 'value' and 'timestamp' keys.
                                        If None in dynamic mode, falls back to preset.
        absorption_profiles (dict):     MEAL_ABSORPTION_PROFILES
        reset_hour (int):               Daily reset hour (default 7)
        timezone_offset_minutes (int):  Patient UTC offset in minutes

    Returns:
        dict from either build_circadian_baseline_result() or
        calculate_stable_baseline_from_reading(), always the same shape.
    """
    # ── Preset mode (circadian profile) ──────────────────────────────────────
    if baseline_mode == 'preset':
        return build_circadian_baseline_result(
            current_time=current_time,
            patient_constants=patient_constants,
            timezone_offset_minutes=timezone_offset_minutes,
        )

    # ── Dynamic mode (reading-based) ─────────────────────────────────────────
    # Requires a recent reading.  If none is available, degrade gracefully to
    # preset mode rather than crashing — the UI will show the mode label.
    if not latest_reading:
        logger.warning(
            "Dynamic baseline requested but no reading available — "
            "falling back to preset mode for this calculation."
        )
        result = build_circadian_baseline_result(
            current_time=current_time,
            patient_constants=patient_constants,
            timezone_offset_minutes=timezone_offset_minutes,
        )
        result['baseline_mode'] = 'dynamic_fallback'
        return result

    reading_value     = latest_reading.get('value') or latest_reading.get('blood_sugar')
    reading_timestamp = latest_reading.get('timestamp')

    if not isinstance(reading_timestamp, datetime):
        reading_timestamp = TimeManager.to_datetime(
            reading_timestamp, TimeManager.PRECISION_SECOND
        )

    return calculate_stable_baseline_from_reading(
        reading_value=reading_value,
        reading_timestamp=reading_timestamp,
        meals=meals or [],
        insulin_doses=insulin_doses or [],
        patient_constants=patient_constants,
        absorption_profiles=absorption_profiles or {},
        reset_hour=reset_hour,
        timezone_offset_minutes=timezone_offset_minutes,
    )