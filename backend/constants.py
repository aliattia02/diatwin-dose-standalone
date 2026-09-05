"""
constants.py - Centralized Constants Management
============================================================================
Insulin pharmacokinetic parameters based on:
German S3 Guideline "Therapie des Typ-1-Diabetes" Version 5.0
AWMF-Registry: 057-013
Table 9: Charakteristika der Insulinarten

Reference: Diabetol Stoffwechs 2024; 19: S155–S166
DOI: 10.1055/a-2312-0276

Meal absorption profiles use gamma distribution parameters for
physiologically-accurate modeling of carbohydrate absorption.

VERSION HISTORY:
v4.4 - Added HR ODE exercise model constants (weight_kg, hr_base, hr_max,
       carb_to_bg_ratio, ACTIVITY_INTENSITY_LEVELS)
v4.3 - Added circadian baseline profile and baseline_mode switching
v4.2 - Added TypeScript export for React Native mobile app
v4.1 - Added user-configurable daily_reset_hour to ConstantConfig
v4.0 - Refactored - Single Source of Truth for all profiles
v3.0 - Added auto-export to frontend

Author: DiaTwin Team
Version: 4.4 (HR ODE Activity Model)
============================================================================
"""

from typing import Dict, Any, Optional, List
from pathlib import Path
import json
import logging
import time
from bson import ObjectId
import dataclasses
from dataclasses import dataclass, asdict, field

# Module-level logger — replaces all print() calls in this file so output
# goes through Flask's logging pipeline instead of stdout (which was inflating
# cron-job.org response sizes and flooding Render logs).
_logger = logging.getLogger(__name__)

# ─── Process-level patient constants cache ────────────────────────────────────
# Keyed by patient_id (str). Each entry: (patient_config: ConstantConfig, ts: float)
# TTL of 60 s means a burst of parallel requests for the same patient (e.g. the
# 6+ simultaneous API calls on mobile app startup) only hits MongoDB once, then
# serves the rest from memory — eliminating the "Loading constants for patient"
# spam seen 10+ times per second in the Render logs.
_PATIENT_CONSTANTS_CACHE: Dict[str, tuple] = {}
_CACHE_TTL_SECONDS = 60


# ============================================================================
# CIRCADIAN BASELINE — module-level helper (no external import needed)
# ============================================================================

def get_default_circadian_profile(target_glucose: float = 100) -> Dict[str, Any]:
    """
    Return the default T1D circadian baseline profile scaled around target_glucose.

    The raw anchor values are defined for a 100 mg/dL target.  When a patient
    has a different target the whole curve shifts by the same delta so the shape
    (dawn rise, Somogyi nadir, overnight descent) is preserved.

    Physiological features encoded:
      • Somogyi nadir   ~3 AM  (–15 mg/dL below target)
      • Dawn phenomenon  5–8 AM (+20 mg/dL above target)
      • Mid-day plateau  10 AM–3 PM (near target)
      • Gentle overnight descent 10 PM → 3 AM

    Args:
        target_glucose: Patient's target BG in mg/dL (default 100)

    Returns:
        dict with keys:
            anchors  – list of {hour: int, value: float} dicts (24 entries)
            source   – 'preset' (distinguishes from future learned profiles)
    """
    offset = target_glucose - 100.0

    raw_anchors = [
        {"hour": 0,  "value": 90},
        {"hour": 1,  "value": 88},
        {"hour": 2,  "value": 87},
        {"hour": 3,  "value": 85},   # Somogyi nadir
        {"hour": 4,  "value": 87},
        {"hour": 5,  "value": 93},   # dawn rise begins
        {"hour": 6,  "value": 108},
        {"hour": 7,  "value": 118},  # dawn peak
        {"hour": 8,  "value": 120},
        {"hour": 9,  "value": 115},
        {"hour": 10, "value": 108},
        {"hour": 11, "value": 103},
        {"hour": 12, "value": 100},
        {"hour": 13, "value": 98},
        {"hour": 14, "value": 97},
        {"hour": 15, "value": 97},
        {"hour": 16, "value": 100},
        {"hour": 17, "value": 102},
        {"hour": 18, "value": 100},
        {"hour": 19, "value": 99},
        {"hour": 20, "value": 97},
        {"hour": 21, "value": 95},
        {"hour": 22, "value": 93},
        {"hour": 23, "value": 91},
    ]

    return {
        "anchors": [
            {"hour": a["hour"], "value": round(a["value"] + offset, 1)}
            for a in raw_anchors
        ],
        "source": "preset",
    }


def get_circadian_baseline_at_hour(
    hour_float: float,
    profile: Dict[str, Any],
) -> float:
    """
    Linear interpolation of the circadian profile at a fractional hour.

    Args:
        hour_float: Time of day as a float, e.g. 7.5 = 7:30 AM (0–23.999)
        profile:    Circadian profile dict from get_default_circadian_profile()
                    or patient_constants['circadian_profile']

    Returns:
        Interpolated baseline in mg/dL
    """
    anchors = profile.get("anchors", [])
    if not anchors:
        return 100.0

    # Wrap into [0, 24)
    h = hour_float % 24.0

    # Find surrounding anchor indices (circular: hour 23→0 wraps)
    lower = None
    upper = None
    for i, anchor in enumerate(anchors):
        if anchor["hour"] <= h:
            lower = anchor
        if upper is None and anchor["hour"] > h:
            upper = anchor

    if lower is None:
        lower = anchors[-1]   # wrap: before first anchor → use last
    if upper is None:
        upper = anchors[0]    # wrap: after last anchor → use first

    lo_h = lower["hour"]
    hi_h = upper["hour"]
    lo_v = lower["value"]
    hi_v = upper["value"]

    if lo_h == hi_h:
        return lo_v

    # Handle midnight wrap (e.g. lower=23, upper=0)
    if hi_h < lo_h:
        hi_h += 24

    t = (h - lo_h) / (hi_h - lo_h)
    return round(lo_v + t * (hi_v - lo_v), 1)


# ── Baseline hard bounds ──────────────────────────────────────────────────────
# Mirrors mobile/utils/calculations/baseline.ts::BASELINE_BOUNDS
BASELINE_HARD_MIN: float = 55.0   # mg/dL — incompatible with consciousness below this
BASELINE_HARD_MAX: float = 220.0  # mg/dL — no T1D has a true fasting baseline above this


def sanitize_baseline(raw_baseline: float) -> dict:
    """
    Apply hard physiological clamps to a raw dynamic baseline.

    Clamps values outside [55, 220] mg/dL and attaches a CRITICAL warning.
    Does NOT perform soft blending — values inside the hard bounds are returned
    unchanged regardless of how unusual they look.

    Mirrors mobile/utils/calculations/baseline.ts::sanitizeBaseline().

    Args:
        raw_baseline: stableBaseline from calculate_stable_baseline_from_reading()

    Returns:
        dict with keys:
            value   – final clamped value to use
            raw     – original value before clamping
            status  – 'ok' | 'hard_clamped'
            warnings – list of warning strings (empty when status='ok')
    """
    warnings: List[str] = []

    if raw_baseline < BASELINE_HARD_MIN:
        warnings.append(
            f"CRITICAL: Baseline {raw_baseline:.0f} mg/dL is physiologically impossible. "
            f"Likely cause: unlogged insulin dose. Clamped to {BASELINE_HARD_MIN:.0f} mg/dL."
        )
        return {
            "value": BASELINE_HARD_MIN,
            "raw": raw_baseline,
            "status": "hard_clamped",
            "warnings": warnings,
        }

    if raw_baseline > BASELINE_HARD_MAX:
        warnings.append(
            f"CRITICAL: Baseline {raw_baseline:.0f} mg/dL is physiologically impossible. "
            f"Likely cause: unlogged meal. Clamped to {BASELINE_HARD_MAX:.0f} mg/dL."
        )
        return {
            "value": BASELINE_HARD_MAX,
            "raw": raw_baseline,
            "status": "hard_clamped",
            "warnings": warnings,
        }

    return {
        "value": raw_baseline,
        "raw": raw_baseline,
        "status": "ok",
        "warnings": warnings,
    }


@dataclass
class ConstantConfig:
    """Base configuration for patient-modifiable constants"""
    insulin_to_carb_ratio: float = 10
    correction_factor: float = 40
    target_glucose: float = 100
    protein_factor: float = 0.5
    fat_factor: float = 0.2
    carb_to_bg_factor: float = 4.0  # Default: 1g carbs = 4 mg/dL increase

    # ── Activity / exercise model constants ──────────────────────────────────
    # carb_to_bg_ratio is an alias for carb_to_bg_factor used by the HR ODE
    # activity model. Keep both in sync via update_patient_constants().
    carb_to_bg_ratio: float = 4.0

    # weight_kg: used for allometric scaling of BG-drop magnitude.
    # Formula: drop *= (70 / weight_kg) ** 0.25  (Dalla Man 2009 convention).
    weight_kg: float = 70.0

    # Patient resting and maximum heart rate (bpm).
    # Used to normalise wearable HR traces and build synthetic traces for the
    # intensity-only fallback path (no wearable connected).
    hr_base: float = 70.0
    hr_max: float = 190.0

    # User-configurable daily reset hour for cumulative effects
    # Range: 0-23 (represents hour of day in local time)
    # Default: 7 (7:00 AM) - typical wake-up time for most patients
    daily_reset_hour: int = 7

    # ── Timezone offset (SIGN CONVENTION) ────────────────────────────────────
    # timezone_offset_minutes = local_minutes_ahead_of_UTC
    #
    #   Egypt   (UTC+2) → +120   ← data source / logging timezone
    #   Germany (UTC+1) →  +60   ← viewer timezone
    #   UTC             →    0
    #
    # Conversion: utc = local - offset_hours
    # Code:       dt  = dt - timedelta(hours=timezone_offset_minutes / 60)
    #
    # NOTE: This value MUST reflect the LOGGING device's timezone (e.g.
    # Egypt = +120). The viewer's offset is handled automatically by the
    # browser's Date parsing — do NOT double-apply it.
    #
    # MIGRATION: Existing users with timezone_offset_minutes=0 who are NOT in
    # UTC must update this value or all LibreLinkUp CGM timestamps will be
    # stored without conversion, causing display offsets equal to their full
    # UTC offset (e.g. a 2-hour shift for UTC+2 patients).
    #
    # VALIDATION: values must be within -840 to +840 (-14h to +14h).
    # Enforced on UPDATE in the patient constants route; ensure CREATE also
    # validates the same range.
    #
    # Range: -840 to +840 minutes (-14h to +14h UTC offsets)
    # Default: 0 (UTC) — WARNING: 0 means NO UTC conversion; configure for
    # any non-UTC patient (see libre_service.py warning log for details).
    timezone_offset_minutes: int = 0

    # ── Baseline mode ────────────────────────────────────────────────────────
    # Controls how the stable baseline is derived before applying
    # cumulative meal/insulin effects.
    #
    #   'dynamic' → subtract today's cumulative effects from the latest reading
    #               (original behaviour — requires a recent BG reading)
    #
    #   'preset'  → look up the 24-hour circadian profile at the current hour
    #               (works even without a recent reading; uses the T1D default
    #               profile or a patient-customised one stored in circadian_profile)
    #
    # Default is 'dynamic' so existing patients are unaffected until they
    # explicitly choose to switch.
    baseline_mode: str = 'dynamic'

    # Circadian profile used when baseline_mode == 'preset'.
    # Stored as a dict with key 'anchors' (list of {hour, value} dicts).
    # Left empty here; get_patient_constants() injects the T1D preset when
    # this field is empty so the mode works for every patient from day one.
    circadian_profile: Dict[str, Any] = field(default_factory=dict)

    activity_coefficients: Dict[str, float] = field(default_factory=lambda: {
        "-2": 1.2,  # mode 1 (20% increase in insulin needs)
        "-1": 1.1,  # mode 2 (10% increase)
        "0": 1.0,   # Normal Activity (no change)
        "1": 0.9,   # High Activity (10% decrease)
        "2": 0.8    # Vigorous Activity (20% decrease)
    })
    absorption_modifiers: Dict[str, float] = field(default_factory=lambda: {
        'very_slow': 0.6,
        'slow': 0.8,
        'medium': 1.0,
        'mixed': 0.9,   # Weighted midpoint: fast leg dominates early, slow leg extends tail
        'fast': 1.2,
        'very_fast': 1.4
    })
    insulin_timing_guidelines: Dict[str, Dict[str, Any]] = field(default_factory=lambda: {
        'very_fast': {
            'timing_minutes': 0,
            'description': 'Inject your bolus insulin and eat immediately — no pre-bolus wait needed.',
            'split_bolus_advisory': False,
        },
        'fast': {
            'timing_minutes': 5,
            'description': 'Inject your bolus insulin 5 min before eating.',
            'split_bolus_advisory': False,
        },
        'medium': {
            'timing_minutes': 10,
            'description': 'Inject your bolus insulin 10 min before eating.',
            'split_bolus_advisory': False,
        },
        'slow': {
            'timing_minutes': 20,
            'description': (
                'Slow meal — choose one option:\n'
                'A (NovoLog split): inject 20 min before eating, second dose at +90 min.\n'
                'B (Regular insulin): inject full dose at meal start — no wait needed.\n'
                'C (NovoLog single): inject 10 min after first bite — best single-dose peak alignment.'
            ),
            'split_bolus_advisory': False,
        },
        'very_slow': {
            'timing_minutes': 30,
            'description': (
                'Very slow meal — choose one option:\n'
                'A (NovoLog split): inject 30 min before eating, second dose at +90 min.\n'
                'B (Regular insulin): inject full dose at meal start — best single-injection match.\n'
                'C (NovoLog single): inject 30 min after first bite — best single-dose option for this meal.'
            ),
            'split_bolus_advisory': True,
        },
        'mixed': {
            'timing_minutes': 5,
            'description': (
                'Mixed meal (biphasic response) — choose one option:\n'
                'A (NovoLog dual split): 60% dose 5 min before eating, 40% dose at +2.5 h.\n'
                'B (Regular insulin): full dose at meal start — covers both peaks in one injection.\n'
                'Check BG at +2 h and +5–6 h; late hyperglycaemia (3–6 h) is the primary risk.'
            ),
            'split_bolus_advisory': True,
        },
    })
    meal_timing_factors: Dict[str, float] = field(default_factory=lambda: {
        'breakfast': 1.2,  # Higher insulin resistance in morning
        'lunch': 1.0,
        'dinner': 0.9,    # Better insulin sensitivity in evening
        'snack': 1.0      # Default factor for snacks
    })
    time_of_day_factors: Dict[str, Dict[str, Any]] = field(default_factory=lambda: {
        'early_morning': {
            'hours': (0, 6),
            'factor': 1.1,
            'description': 'Very early morning adjustment'
        },
        'morning': {
            'hours': (6, 10),
            'factor': 1.2,
            'description': 'Morning insulin resistance period'
        },
        'daytime': {
            'hours': (10, 22),
            'factor': 1.0,
            'description': 'Standard daytime period'
        },
        'late_night': {
            'hours': (22, 24),
            'factor': 0.9,
            'description': 'Late night adjustment'
        }
    })
    disease_factors: Dict[str, Dict[str, Any]] = field(default_factory=lambda: {
        'type_1_diabetes': {
            'factor': 1.0,
            'description': 'Standard insulin sensitivity for Type 1 Diabetes'
        },
        'type_2_diabetes': {
            'factor': 0.8,
            'description': 'Reduced insulin sensitivity for Type 2 Diabetes'
        },
        'gestational_diabetes': {
            'factor': 1.2,
            'description': 'Increased insulin sensitivity during pregnancy'
        },
        'insulin_resistance': {
            'factor': 0.7,
            'description': 'Significant reduction in insulin sensitivity'
        },
        'thyroid_disorders': {
            'factor': 1.1,
            'description': 'Slight increase in insulin requirements'
        },
        'celiac_disease': {
            'factor': 1.1,
            'description': 'May require insulin adjustment due to absorption issues'
        }
    })

    # Medication factors - S3 Guidelines Table 9
    medication_factors: Dict[str, Dict[str, Any]] = field(default_factory=lambda: {
        # ====================================================================
        # Human Insulins - Based on German S3 Guidelines Table 9
        # ====================================================================
        'nph_insulin': {
            'factor': 1.0,
            'description': 'Intermediate-acting human insulin (NPH)',
            'duration_based': True,
            'onset_hours': 1.5,
            'peak_hours': 6.5,
            'duration_hours': 14,
            'type': 'intermediate_acting',
            'is_peakless': False,
            'brand_names': ['Humulin N', 'Novolin N'],
            'curve_type': 'gamma_wide'
        },
        'regular_insulin': {
            'factor': 1.0,
            'description': 'Short-acting human insulin',
            'duration_based': True,
            'onset_hours': 0.75,
            'peak_hours': 3,
            'duration_hours': 8,
            'type': 'short_acting',
            'is_peakless': False,
            'brand_names': ['Humulin R', 'Novolin R'],
            'curve_type': 'gamma_broad'
        },
        'mixed_insulin_70_30': {
            'factor': 1.0,
            'description': '70% NPH, 30% Regular insulin mixture',
            'duration_based': True,
            'onset_hours': 0.5,
            'peak_hours': 3.25,
            'duration_hours': 14,
            'type': 'mixed',
            'is_peakless': False,
            'brand_names': ['Humulin 70/30', 'Novolin 70/30'],
            'curve_type': 'gamma_broad'
        },

        # ====================================================================
        # Long-Acting Insulin Analogs - S3 Guidelines Table 9
        # ====================================================================
        'insulin_degludec': {
            'factor': 1.0,
            'description': 'Ultra-long-acting insulin analogue - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 1.5,
            'peak_hours': 11,
            'duration_hours': 42,
            'type': 'long_acting',
            'is_peakless': True,
            'brand_names': ['Tresiba'],
            'curve_type': 'sigmoid_ultra_long'
        },
        'insulin_detemir': {
            'factor': 1.0,
            'description': 'Long-acting insulin analogue - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 1,
            'peak_hours': 8,
            'duration_hours': 22.5,
            'type': 'long_acting',
            'is_peakless': True,
            'brand_names': ['Levemir'],
            'curve_type': 'gamma_extended'
        },
        'insulin_glargine': {
            'factor': 1.0,
            'description': 'Long-acting insulin analogue U100 - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 1,
            'peak_hours': 10,
            'duration_hours': 23.5,
            'type': 'long_acting',
            'is_peakless': True,
            'brand_names': ['Lantus', 'Basaglar'],
            'curve_type': 'sigmoid_plateau'
        },
        'insulin_glargine_u300': {
            'factor': 1.0,
            'description': 'Long-acting insulin analogue U300 - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 3.5,
            'peak_hours': 14,
            'duration_hours': 31,
            'type': 'long_acting',
            'is_peakless': True,
            'brand_names': ['Toujeo'],
            'curve_type': 'sigmoid_extended'
        },

        # ====================================================================
        # Rapid-Acting Insulin Analogs - S3 Guidelines Table 9
        # ====================================================================
        'insulin_aspart': {
            'factor': 1.0,
            'description': 'Rapid-acting insulin analogue - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.375,
            'peak_hours': 2.25,
            'duration_hours': 4.5,
            'type': 'rapid_acting',
            'is_peakless': False,
            'brand_names': ['NovoLog', 'NovoRapid'],
            'curve_type': 'gamma_steep'
        },
        'insulin_aspart_faster': {
            'factor': 1.0,
            'description': 'Faster-acting insulin aspart - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.29,
            'peak_hours': 2.25,
            'duration_hours': 3.5,
            'type': 'rapid_acting',
            'is_peakless': False,
            'brand_names': ['Fiasp'],
            'curve_type': 'gamma_very_steep'
        },
        'insulin_glulisine': {
            'factor': 1.0,
            'description': 'Rapid-acting insulin analogue - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.375,
            'peak_hours': 2.25,
            'duration_hours': 4.5,
            'type': 'rapid_acting',
            'is_peakless': False,
            'brand_names': ['Apidra'],
            'curve_type': 'gamma_steep'
        },
        'insulin_lispro': {
            'factor': 1.0,
            'description': 'Rapid-acting insulin analogue - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.375,
            'peak_hours': 2.25,
            'duration_hours': 4.5,
            'type': 'rapid_acting',
            'is_peakless': False,
            'brand_names': ['Humalog', 'Admelog'],
            'curve_type': 'gamma_steep'
        },
        'insulin_lispro_ultra_rapid': {
            'factor': 1.0,
            'description': 'Ultra rapid-acting insulin lispro - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.29,
            'peak_hours': 2,
            'duration_hours': 4,
            'type': 'rapid_acting',
            'is_peakless': False,
            'brand_names': ['Lyumjev'],
            'curve_type': 'gamma_very_steep'
        },

        # ====================================================================
        # Mixed Analog Insulins - S3 Guidelines Table 9
        # ====================================================================
        'mixed_aspart_70_30': {
            'factor': 1.0,
            'description': '70% protaminated aspart, 30% aspart - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.375,
            'peak_hours': 2.5,
            'duration_hours': 12,
            'type': 'mixed',
            'is_peakless': False,
            'brand_names': ['NovoMix 70/30'],
            'curve_type': 'gamma_broad'
        },
        'mixed_lispro_75_25': {
            'factor': 1.0,
            'description': '75% protaminated lispro, 25% lispro - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.375,
            'peak_hours': 2.5,
            'duration_hours': 12,
            'type': 'mixed',
            'is_peakless': False,
            'brand_names': ['Humalog Mix 75/25'],
            'curve_type': 'gamma_broad'
        },
        'combination_degludec_aspart': {
            'factor': 1.0,
            'description': '70% degludec, 30% aspart combination - S3 Guidelines',
            'duration_based': True,
            'onset_hours': 0.375,
            'peak_hours': 2.5,
            'duration_hours': 30,
            'type': 'mixed',
            'is_peakless': False,
            'brand_names': ['Ryzodeg'],
            'curve_type': 'gamma_broad'
        },

        # ====================================================================
        # Other Medications
        # ====================================================================
        'injectable_contraceptives': {
            'factor': 1.3,
            'description': 'Injectable contraceptives can significantly increase insulin resistance',
            'duration_based': True,
            'onset_hours': 48,
            'peak_hours': 168,
            'duration_hours': 2160,
            'type': 'hormone'
        },
        'corticosteroids': {
            'factor': 1.4,
            'description': 'Significant increase in insulin resistance',
            'duration_based': True,
            'onset_hours': 4,
            'peak_hours': 8,
            'duration_hours': 24,
            'type': 'steroid'
        },
        'oral_contraceptives': {
            'factor': 1.2,
            'description': 'Oral contraceptives may increase insulin resistance',
            'duration_based': True,
            'onset_hours': 24,
            'peak_hours': 72,
            'duration_hours': 720,
            'type': 'hormone'
        },
        'beta_blockers': {
            'factor': 1.2,
            'description': 'Moderate increase in insulin resistance',
            'duration_based': False,
            'type': 'cardiovascular'
        },
        'thiazide_diuretics': {
            'factor': 1.1,
            'description': 'Slight increase in insulin resistance',
            'duration_based': False,
            'type': 'cardiovascular'
        },
        'metformin': {
            'factor': 0.9,
            'description': 'Improved insulin sensitivity',
            'duration_based': False,
            'type': 'antidiabetic'
        },
        'thiazolidinediones': {
            'factor': 0.8,
            'description': 'Significant improvement in insulin sensitivity',
            'duration_based': True,
            'onset_hours': 24,
            'peak_hours': 48,
            'duration_hours': 168,
            'type': 'antidiabetic'
        }
    })


class Constants:
    """Enhanced constants management with dataclass support"""

    # Class-level constants
    MEASUREMENT_SYSTEMS = {
        'VOLUME': 'volume',
        'WEIGHT': 'weight'
    }

    VOLUME_MEASUREMENTS = {
        'cup': {'ml': 240, 'display_name': 'Cup'},
        'half_cup': {'ml': 120, 'display_name': '½ Cup'},
        'quarter_cup': {'ml': 60, 'display_name': '¼ Cup'},
        'tablespoon': {'ml': 15, 'display_name': 'Tablespoon'},
        'teaspoon': {'ml': 5, 'display_name': 'Teaspoon'},
        'bowl': {'ml': 400, 'display_name': 'Medium Bowl'},
        'v_plate': {'ml': 350, 'display_name': 'Full Plate (Volume)'},
        'v_small_plate': {'ml': 175, 'display_name': 'Small Plate (Volume)'},
        'ml': {'ml': 1, 'display_name': 'Milliliter'}
    }

    WEIGHT_MEASUREMENTS = {
        'palm': {'grams': 85, 'display_name': 'Palm-sized'},
        'handful': {'grams': 30, 'display_name': 'Handful'},
        'fist': {'grams': 150, 'display_name': 'Fist-sized'},
        'w_plate': {'grams': 300, 'display_name': 'Full Plate (Weight)'},
        'w_small_plate': {'grams': 150, 'display_name': 'Small Plate (Weight)'},
        'g': {'grams': 1, 'display_name': 'Grams'},
        'kg': {'grams': 1000, 'display_name': 'Kilograms'}
    }

    ACTIVITY_LEVELS = [
        {'value': -2, 'label': 'mode 1', 'impact': 1.2},
        {'value': -1, 'label': 'mode 2', 'impact': 1.1},
        {'value': 0, 'label': 'Normal Activity', 'impact': 1.0},
        {'value': 1, 'label': 'High Activity', 'impact': 0.9},
        {'value': 2, 'label': 'Vigorous Activity', 'impact': 0.8}
    ]

    # ── HR ODE exercise model — intensity label map ───────────────────────────
    # Maps the string intensity labels used by activity_pharmacodynamics to
    # their HR fraction above resting and to the legacy integer level.
    # Exported to the frontend via get_all_constants() so the activity-entry
    # form can display human-readable labels without hard-coding them in JS/TS.
    ACTIVITY_INTENSITY_LEVELS = {
        'light':    {'hr_fraction': 0.50, 'label': 'Light',    'level': 0},
        'moderate': {'hr_fraction': 0.65, 'label': 'Moderate', 'level': 1},
        'vigorous': {'hr_fraction': 0.80, 'label': 'Vigorous', 'level': 2},
    }

    # ── HR ODE model parameters (population values — not patient-modifiable) ──
    # Fixed ODE shape constants from the Dalla Man / Breton literature.
    # Patient physiology is captured via hr_base / hr_max / weight_kg in
    # ConstantConfig above.  Exported to the frontend so the TypeScript port
    # in mobile/utils/activity/activity-pharmacodynamics.ts can share the same
    # numerical values without hard-coding them.
    HR_MODEL = {
        'tau_HR':                5.0,    # Low-pass filter time-constant HR→Y (min)
        'tau_Z':                10.0,    # Z decay after exercise ends (min)
        'tau_W':                90.0,    # W recovery decay (min) — late hypo risk
        'a':                    0.05,    # Exercise-onset threshold (fraction of HRb)
        'alpha':                0.0008,  # W·Z → sensitivity-multiplier scaling
        'max_sensitivity_boost': 0.60,   # Hard cap: 60 % boost maximum
        'dt':                   1.0,     # Euler integration step (min)
        'acute_rate_per_min':   0.15,    # mg/dL per minute at Z = 1 (calibrated)
        'hr_max_pop':          190.0,    # Population reference HRmax (bpm)
        'hr_base_pop':          70.0,    # Population resting HR (bpm)
    }

    # HR as fraction of (HRmax − HRbase) above HRbase for each intensity tier.
    INTENSITY_HR_FRACTION = {
        'light':    0.50,
        'moderate': 0.65,
        'vigorous': 0.80,
    }

    # Population-calibrated peak BG-sensitivity boost per exercise intensity tier.
    # Approximates HR_MODEL alpha × W_peak × (1 + Z_peak) for hr_base=70, weight=70 kg.
    # Used by EVC and BGV as a chart fallback when the live API sensitivity_multiplier
    # has decayed to baseline (≤ 1.005). Single source of truth — never duplicate.
    INTENSITY_PEAK_BOOST = {
        'light':    0.10,   # ×1.10 ISF/CR boost after light exercise
        'moderate': 0.25,   # ×1.25 after moderate exercise
        'vigorous': 0.40,   # ×1.40 after vigorous exercise
    }

    # Legacy integer level → pharmacodynamic intensity string.
    # Levels ≤ −1 represent sedentary / sick days (no BG-lowering exercise effect).
    LEVEL_TO_INTENSITY = {
        -2: None,
        -1: None,
         0: 'light',
         1: 'moderate',
         2: 'vigorous',
    }

    MEAL_TYPES = [
        {'value': 'breakfast', 'label': 'Breakfast'},
        {'value': 'lunch', 'label': 'Lunch'},
        {'value': 'dinner', 'label': 'Dinner'},
        {'value': 'snack', 'label': 'Snack'}
    ]

    FOOD_CATEGORIES = [
        {'value': 'basic', 'label': 'Basic Foods'},
        {'value': 'starch', 'label': 'Starches'},
        {'value': 'starchy_vegetables', 'label': 'Starchy Vegetables'},
        {'value': 'pulses', 'label': 'Pulses'},
        {'value': 'fruits', 'label': 'Fruits'},
        {'value': 'dairy', 'label': 'Dairy'},
        {'value': 'sweets', 'label': 'Sweets & Desserts'},
        {'value': 'snacks', 'label': 'Snacks'},
        {'value': 'common_snacks', 'label': 'Common Snacks'},
        {'value': 'high_protein', 'label': 'High Protein Foods'},
        {'value': 'high_fat', 'label': 'High Fat Foods'},
        {'value': 'egyptian', 'label': 'Egyptian Dishes'},
        {'value': 'international', 'label': 'International Dishes'},
        {'value': 'german', 'label': 'German Dishes'},
        {'value': 'salads_condiments', 'label': 'Salads & Condiments'},
        {'value': 'beverages', 'label': 'Beverages'},
        {'value': 'custom', 'label': 'Custom Foods'}
    ]

    config = ConstantConfig()

    # ── Baseline hard bounds (mirrors module-level constants) ─────────────────
    BASELINE_HARD_MIN: float = BASELINE_HARD_MIN   # 55.0  mg/dL
    BASELINE_HARD_MAX: float = BASELINE_HARD_MAX   # 220.0 mg/dL

    # ── Baseline mode definitions ─────────────────────────────────────────────
    BASELINE_MODES = {
        'dynamic': {
            'label': 'Dynamic (reading-based)',
            'description': (
                'Derives the baseline from your latest BG reading by removing '
                'all cumulative meal and insulin effects since the daily reset. '
                'Most accurate when you have a recent reading.'
            ),
        },
        'preset': {
            'label': 'Preset 24-hour profile',
            'description': (
                'Uses a clinically-modelled 24-hour circadian profile that '
                'captures the dawn phenomenon, overnight dip, and daytime plateau. '
                'Works without a recent reading and is stable across testing sessions.'
            ),
        },
    }

    DEFAULT_CIRCADIAN_PROFILE = get_default_circadian_profile(target_glucose=100)

    # View mode configurations for time-based visualizations
    #
    # cumulativeLookbackHours — minimum API fetch depth needed for a correct
    # cumulative line.  Always >= pastHours AND >= (DEFAULT_RESET_HOUR + 24 + 1)
    # so the previous daily window is fully covered regardless of the visible range.
    #
    # Formula: max(pastHours, DEFAULT_RESET_HOUR + 24 + 1)
    #   DEFAULT_RESET_HOUR = 7  →  7 + 24 + 1 = 32 h minimum.
    # For multi-day views pastHours already exceeds 32 h, so it is used as-is.
    # At runtime, getCumulativeLookbackHours(dailyResetHour) returns
    # max(pastHours, dailyResetHour + 24 + 1) using the patient's actual reset hour.
    _DEFAULT_CUMULATIVE_LOOKBACK = ConstantConfig.daily_reset_hour + 24 + 1  # 7+24+1 = 32

    VIEW_MODE_CONFIGS = {
        '3h': {
            'label': '3H',
            'pastHours': 2.5,
            'futureHours': 0.5,
            'tickInterval': 0.5,
            'tickFormat': 'HH:mm',
            'interpolationInterval': 1,
            'mealLookback': 3,
            'insulinLookback': 4,
            'cumulativeLookbackHours': _DEFAULT_CUMULATIVE_LOOKBACK,  # 32
        },
        '6h': {
            'label': '6H',
            'pastHours': 4,
            'futureHours': 2,
            'tickInterval': 1,
            'tickFormat': 'HH:mm',
            'interpolationInterval': 5,
            'mealLookback': 6,
            'insulinLookback': 6,
            'cumulativeLookbackHours': _DEFAULT_CUMULATIVE_LOOKBACK,  # 32
        },
        '12h': {
            'label': '12H',
            'pastHours': 10,
            'futureHours': 2,
            'tickInterval': 2,
            'tickFormat': 'HH:mm',
            'interpolationInterval': 10,
            'mealLookback': 12,
            'insulinLookback': 12,
            'cumulativeLookbackHours': _DEFAULT_CUMULATIVE_LOOKBACK,  # 32
        },
        '24h': {
            'label': '24H',
            'pastHours': 20,
            'futureHours': 4,
            'tickInterval': 3,
            'tickFormat': 'HH:mm',
            'interpolationInterval': 15,
            'mealLookback': 24,
            'insulinLookback': 24,
            'cumulativeLookbackHours': _DEFAULT_CUMULATIVE_LOOKBACK,  # 32
        },
        '3d': {
            'label': '3D',
            'pastHours': 68,
            'futureHours': 4,
            'tickInterval': 6,
            'tickFormat': 'MM/DD',
            'interpolationInterval': 30,
            'mealLookback': 72,
            'insulinLookback': 72,
            'cumulativeLookbackHours': 68,   # pastHours already > 32
        },
        'week': {
            'label': 'Week',
            'pastHours': 168,
            'futureHours': 0,
            'tickInterval': 24,
            'tickFormat': 'DD/MM',
            'interpolationInterval': 15,
            'mealLookback': 168,
            'insulinLookback': 168,
            'cumulativeLookbackHours': 168,  # pastHours already > 32
        },
        'month': {
            'label': 'Month',
            'pastHours': 720,
            'futureHours': 0,
            'tickInterval': 72,
            'tickFormat': 'DD/MM',
            'interpolationInterval': 30,
            'mealLookback': 720,
            'insulinLookback': 720,
            'cumulativeLookbackHours': 720,  # pastHours already > 32
        },
    }

    # Type 1 Diabetes blood glucose constants
    T1D_BG_CONSTANTS = {
        'recent_reading_threshold_min': 15,
        'max_reading_age_hours': 4,
        'max_reading_age_minutes': 240,
        'target_glucose_default': 100,
        'default_chart_interval_min': 1,
        'iob_lookback_hours': 48,
        'mob_lookback_hours': 12
    }

    # Net effect thresholds for blood glucose predictions
    NET_EFFECT_THRESHOLDS = {
        'high_rising': 50,
        'rising': 20,
        'slightly_rising': 5,
        'stable_high': 5,
        'stable_low': -5,
        'slightly_falling': -5,
        'falling': -20,
        'rapidly_falling': -50
    }

    # Timing thresholds for meal and insulin safety assessment
    TIMING_THRESHOLDS = {
        'min_active_carbs': 5,
        'max_active_carbs': 30,
        'high_iob_threshold': 2,
        'slow_meal_activity_threshold': 20
    }

    # Pharmacokinetic curve descriptions
    CURVE_DESCRIPTIONS = {
        'gamma_very_steep': 'Ultra-rapid (Sharp peak, heavy tails)',
        'gamma_steep': 'Rapid-acting (Leptokurtic)',
        'gamma_moderate': 'Regular insulin (Mesokurtic)',
        'gamma_standard': 'Standard action',
        'gamma_broad': 'Intermediate (Platykurtic)',
        'gamma_wide': 'Wide distribution',
        'gamma_extended': 'Extended action',
        'gamma_plateau': 'Plateau effect',
        'sigmoid_plateau': 'Steady plateau',
        'sigmoid_extended': 'Extended plateau',
        'sigmoid_ultra_long': 'Ultra-long plateau'
    }

    # ========================================================================
    # MEAL ABSORPTION PROFILES - Single Source of Truth
    # ========================================================================
    MEAL_ABSORPTION_PROFILES = {
        'very_fast': {
            'onset_hours': 0.08,
            'peak_hours': 0.5,
            'duration_hours': 2.0,
            'curve_type': 'gamma_steep',
            'shape_param': 2.5,
            'scale_param': 0.3,
            'description': 'Simple sugars, glucose tablets - very rapid absorption'
        },
        'fast': {
            'onset_hours': 0.25,
            'peak_hours': 1.0,
            'duration_hours': 3.0,
            'curve_type': 'gamma_moderate',
            'shape_param': 2.0,
            'scale_param': 0.5,
            'description': 'Refined carbohydrates, white bread, juice - fast absorption'
        },
        'medium': {
            'onset_hours': 0.42,
            'peak_hours': 1.5,
            'duration_hours': 4.0,
            'curve_type': 'gamma_standard',
            'shape_param': 1.8,
            'scale_param': 0.8,
            'description': 'Mixed meals, whole grains - moderate absorption'
        },
        'slow': {
            'onset_hours': 0.75,
            'peak_hours': 2.5,
            'duration_hours': 5.5,
            'curve_type': 'gamma_extended',
            'shape_param': 1.5,
            'scale_param': 1.2,
            'description': 'High protein/fat meals, complex carbs - slow absorption'
        },
        'very_slow': {
            'onset_hours': 1.0,
            'peak_hours': 3.5,
            'duration_hours': 7.0,
            'curve_type': 'gamma_plateau',
            'shape_param': 1.2,
            'scale_param': 1.8,
            'description': 'Very high fat/fiber meals - very slow absorption'
        },
        'mixed': {
            'onset_hours': 0.25,
            'peak_hours': 2.0,
            'duration_hours': 6.0,
            'curve_type': 'gamma_broad',
            'shape_param': 1.4,
            'scale_param': 1.4,
            'description': 'Mixed fast + slow meal (pizza-effect) - biphasic absorption'
        },
    }

    # ========================================================================
    # DEFAULT PATIENT CONSTANTS - Assembled from all sources above
    # ========================================================================
    DEFAULT_PATIENT_CONSTANTS = {
        'insulin_to_carb_ratio': config.insulin_to_carb_ratio,
        'correction_factor': config.correction_factor,
        'target_glucose': config.target_glucose,
        'protein_factor': config.protein_factor,
        'fat_factor': config.fat_factor,
        'carb_to_bg_factor': config.carb_to_bg_factor,
        # ── Activity model fields ─────────────────────────────────────────
        'carb_to_bg_ratio':  config.carb_to_bg_ratio,   # alias — keep in sync
        'weight_kg':         config.weight_kg,
        'hr_base':           config.hr_base,
        'hr_max':            config.hr_max,
        # ──────────────────────────────────────────────────────────────────
        'daily_reset_hour': config.daily_reset_hour,
        'timezone_offset_minutes': config.timezone_offset_minutes,
        # ── Baseline mode ─────────────────────────────────────────────────
        'baseline_mode': config.baseline_mode,          # 'dynamic' | 'preset'
        'circadian_profile': config.circadian_profile,  # populated at runtime
        # ──────────────────────────────────────────────────────────────────
        'activity_coefficients': config.activity_coefficients,
        'absorption_modifiers': config.absorption_modifiers,
        'insulin_timing_guidelines': config.insulin_timing_guidelines,
        'meal_timing_factors': config.meal_timing_factors,
        'time_of_day_factors': config.time_of_day_factors,
        'disease_factors': config.disease_factors,
        'medication_factors': config.medication_factors,
        'meal_absorption_profiles': MEAL_ABSORPTION_PROFILES,
    }

    def __init__(self, patient_id: Optional[str] = None):
        """Initialize constants with optional patient-specific overrides."""
        self.patient_id = patient_id
        self.default_config = ConstantConfig()
        self.patient_config = self.default_config
        self._constants_cache = {}

        if patient_id:
            cached = _PATIENT_CONSTANTS_CACHE.get(patient_id)
            if cached and (time.monotonic() - cached[1]) < _CACHE_TTL_SECONDS:
                self.patient_config = cached[0]
                _logger.debug(f"Constants cache hit for patient: {patient_id}")
            else:
                self._load_patient_constants()

    @property
    def volume_base(self) -> Dict[str, float]:
        if 'volume_base' not in self._constants_cache:
            self._constants_cache['volume_base'] = {
                unit: data['ml'] for unit, data in self.VOLUME_MEASUREMENTS.items()
            }
        return self._constants_cache['volume_base']

    @property
    def weight_base(self) -> Dict[str, float]:
        if 'weight_base' not in self._constants_cache:
            self._constants_cache['weight_base'] = {
                unit: data['grams'] for unit, data in self.WEIGHT_MEASUREMENTS.items()
            }
        return self._constants_cache['weight_base']

    def get_constant(self, key: str, default: Any = None) -> Any:
        cache_key = f'constant_{key}'
        if cache_key in self._constants_cache:
            return self._constants_cache[cache_key]

        value = None

        if hasattr(self.patient_config, key):
            value = getattr(self.patient_config, key)
        elif hasattr(self, key.upper()):
            value = getattr(self, key.upper())
        elif '.' in key:
            try:
                parts = key.split('.')
                current = self.patient_config
                for part in parts:
                    if hasattr(current, part):
                        current = getattr(current, part)
                    else:
                        current = None
                        break
                value = current
            except Exception:
                value = None

        if value is not None:
            self._constants_cache[cache_key] = value
            return value

        return default

    def convert_to_standard(self, amount: float, from_unit: str) -> Optional[float]:
        try:
            if from_unit in self.volume_base:
                return float(amount) * self.volume_base[from_unit]
            elif from_unit in self.weight_base:
                return float(amount) * self.weight_base[from_unit]
            return None
        except (TypeError, ValueError):
            return None

    def _load_patient_constants(self) -> None:
        try:
            from config import mongo
            _logger.debug(f"Loading constants for patient: {self.patient_id}")
            patient = mongo.db.users.find_one({'_id': ObjectId(self.patient_id)})

            if patient:
                # ── Step 1: Read from patient_constants subdoc (if present) ──────
                constants_data = dict(patient.get('patient_constants') or {})

                # ── Step 2: Top-level fallback for ALL known ConstantConfig fields ─
                # This handles both legacy patients (no subdoc) and patients whose
                # subdoc is missing newer fields like timezone_offset_minutes that
                # were added after the subdoc was first written.
                top_level_fields = {
                    'insulin_to_carb_ratio': patient.get('insulin_to_carb_ratio'),
                    'correction_factor': patient.get('correction_factor'),
                    'target_glucose': patient.get('target_glucose'),
                    'protein_factor': patient.get('protein_factor'),
                    'fat_factor': patient.get('fat_factor'),
                    'activity_coefficients': patient.get('activity_coefficients'),
                    'absorption_modifiers': patient.get('absorption_modifiers'),
                    'insulin_timing_guidelines': patient.get('insulin_timing_guidelines'),
                    'weight_kg': patient.get('weight_kg'),
                    'hr_base': patient.get('hr_base'),
                    'hr_max': patient.get('hr_max'),
                    'carb_to_bg_ratio': patient.get('carb_to_bg_ratio'),
                    # ── Newer fields that may only exist at top level ──────────
                    'timezone_offset_minutes': patient.get('timezone_offset_minutes'),
                    'daily_reset_hour': patient.get('daily_reset_hour'),
                    'baseline_mode': patient.get('baseline_mode'),
                }

                # Merge: top-level provides a baseline, patient_constants overrides.
                # patient_constants wins on conflict so explicit updates are respected.
                merged = {k: v for k, v in top_level_fields.items() if v is not None}
                merged.update({k: v for k, v in constants_data.items() if v is not None})

                # Filter to only keys ConstantConfig actually has
                valid = {
                    k: v for k, v in merged.items()
                    if hasattr(self.default_config, k)
                }

                if valid:
                    _logger.debug(f"Found patient constants for {self.patient_id}: {list(valid.keys())}")
                    self.patient_config = dataclasses.replace(self.default_config, **valid)
                else:
                    _logger.debug(f"No patient constants found for {self.patient_id}, using defaults")

                _PATIENT_CONSTANTS_CACHE[self.patient_id] = (self.patient_config, time.monotonic())

        except Exception as e:
            _logger.error(f"Error loading patient constants for {self.patient_id}: {e}")

    def get_patient_constants(self) -> Dict[str, Any]:
        """
        Get current patient or default constants as a dictionary.

        Key behaviours:
        - Always includes meal_absorption_profiles (class-level, not patient-modifiable)
        - When baseline_mode == 'preset' and no custom circadian_profile is stored,
          injects the T1D default profile scaled to the patient's target_glucose.
        """
        result = asdict(self.patient_config)
        result['meal_absorption_profiles'] = self.MEAL_ABSORPTION_PROFILES

        # Inject preset profile when needed so callers never see an empty dict
        if not result.get('circadian_profile', {}).get('anchors'):
            result['circadian_profile'] = get_default_circadian_profile(
                target_glucose=result.get('target_glucose', 100)
            )

        return result

    def update_patient_constants(self, new_constants: Dict[str, Any]) -> bool:
        if not self.patient_id:
            return False

        try:
            from config import mongo

            valid_constants = {
                k: v for k, v in new_constants.items()
                if hasattr(self.default_config, k)
            }

            # Keep carb_to_bg_factor and carb_to_bg_ratio in sync
            if 'carb_to_bg_factor' in valid_constants and 'carb_to_bg_ratio' not in valid_constants:
                valid_constants['carb_to_bg_ratio'] = valid_constants['carb_to_bg_factor']
            elif 'carb_to_bg_ratio' in valid_constants and 'carb_to_bg_factor' not in valid_constants:
                valid_constants['carb_to_bg_factor'] = valid_constants['carb_to_bg_ratio']

            # ── FIX: dot-notation so only the specific keys are updated ──────────
            # The old '$set': {'patient_constants': valid_constants} was destructive —
            # it replaced the entire subdoc, wiping any keys not in this call.
            set_payload = {f'patient_constants.{k}': v for k, v in valid_constants.items()}

            result = mongo.db.users.update_one(
                {'_id': ObjectId(self.patient_id)},
                {'$set': set_payload}
            )

            if result.modified_count > 0:
                self.patient_config = dataclasses.replace(
                    self.patient_config,
                    **valid_constants
                )
                _PATIENT_CONSTANTS_CACHE.pop(self.patient_id, None)
                self._constants_cache = {}
                return True

            return False
        except Exception as e:
            _logger.error(f"Error updating patient constants for {self.patient_id}: {e}")
            return False

    def convert_between_units(self, amount: float, from_unit: str, to_unit: str) -> Optional[float]:
        base_amount = self.convert_to_standard(amount, from_unit)
        if base_amount is None:
            return None

        if to_unit in self.volume_base:
            return base_amount / self.volume_base[to_unit]
        elif to_unit in self.weight_base:
            return base_amount / self.weight_base[to_unit]
        return None

    @classmethod
    def get_supported_measurements(cls) -> Dict[str, Any]:
        return {
            "volume": list(cls.VOLUME_MEASUREMENTS.keys()),
            "weight": list(cls.WEIGHT_MEASUREMENTS.keys()),
            "standard_portions": {
                k: {
                    "display_name": v["display_name"],
                    **({f"ml": v["ml"]} if "ml" in v else {}),
                    **({f"grams": v["grams"]} if "grams" in v else {})
                }
                for k, v in {**cls.VOLUME_MEASUREMENTS, **cls.WEIGHT_MEASUREMENTS}.items()
            }
        }

    @classmethod
    def get_all_constants(cls) -> Dict[str, Any]:
        """Get all base constants in a format suitable for frontend export."""
        default_patient_constants = dict(cls.DEFAULT_PATIENT_CONSTANTS)
        if not default_patient_constants.get('circadian_profile', {}).get('anchors'):
            default_patient_constants['circadian_profile'] = cls.DEFAULT_CIRCADIAN_PROFILE

        return {
            'MEASUREMENT_SYSTEMS': cls.MEASUREMENT_SYSTEMS,
            'VOLUME_MEASUREMENTS': cls.VOLUME_MEASUREMENTS,
            'WEIGHT_MEASUREMENTS': cls.WEIGHT_MEASUREMENTS,
            'ACTIVITY_LEVELS': cls.ACTIVITY_LEVELS,
            'MEAL_TYPES': cls.MEAL_TYPES,
            'FOOD_CATEGORIES': cls.FOOD_CATEGORIES,
            'DEFAULT_PATIENT_CONSTANTS': default_patient_constants,
            'VIEW_MODE_CONFIGS': cls.VIEW_MODE_CONFIGS,
            'T1D_BG_CONSTANTS': cls.T1D_BG_CONSTANTS,
            'NET_EFFECT_THRESHOLDS': cls.NET_EFFECT_THRESHOLDS,
            'TIMING_THRESHOLDS': cls.TIMING_THRESHOLDS,
            'CURVE_DESCRIPTIONS': cls.CURVE_DESCRIPTIONS,
            'MEAL_ABSORPTION_PROFILES': cls.MEAL_ABSORPTION_PROFILES,
            # ── Circadian baseline additions ──────────────────────────────
            'BASELINE_MODES': cls.BASELINE_MODES,
            'DEFAULT_CIRCADIAN_PROFILE': cls.DEFAULT_CIRCADIAN_PROFILE,
            # ── Baseline hard bounds ──────────────────────────────────────
            'BASELINE_HARD_MIN': cls.BASELINE_HARD_MIN,
            'BASELINE_HARD_MAX': cls.BASELINE_HARD_MAX,
            # ── Activity intensity label map ──────────────────────────────
            'ACTIVITY_INTENSITY_LEVELS': cls.ACTIVITY_INTENSITY_LEVELS,
            # ── HR ODE model parameters (population, not patient-modifiable) ─
            'HR_MODEL':              cls.HR_MODEL,
            'INTENSITY_HR_FRACTION': cls.INTENSITY_HR_FRACTION,
            'INTENSITY_PEAK_BOOST':  cls.INTENSITY_PEAK_BOOST,
            # LEVEL_TO_INTENSITY: integer keys must be strings for JSON
            'LEVEL_TO_INTENSITY':    {str(k): v for k, v in cls.LEVEL_TO_INTENSITY.items()},
        }

    @classmethod
    def get_cumulative_lookback_hours(cls, daily_reset_hour: int = 7) -> int:
        """
        Return the minimum API fetch depth (in hours) required to guarantee a
        correct cumulative baseline line for the given patient reset hour.

        Formula: daily_reset_hour + 24 + 1

        The +24 ensures the *previous* daily window is always fully covered
        (a meal eaten just after yesterday's reset must still be included).
        The +1 absorbs DST transitions and off-by-one rounding at midnight.

        Examples:
            reset_hour = 7   →  32 h  (default)
            reset_hour = 0   →  25 h
            reset_hour = 10  →  35 h
            reset_hour = 22  →  47 h

        This is also the runtime companion to the static VIEW_MODE_CONFIGS
        cumulativeLookbackHours field, which is pre-computed with the default
        reset hour (7).  Use this method at request time when the patient's
        actual reset hour is known.
        """
        return int(daily_reset_hour) + 24 + 1

    @classmethod
    def export_constants_to_frontend(cls, output_path: str = '../frontend/src/constants/shared_constants.js'):
        """Enhanced export of constants to JavaScript."""
        constants = cls.get_all_constants()

        js_content = f"""// Auto-generated from backend constants - DO NOT EDIT DIRECTLY
export const SHARED_CONSTANTS = {json.dumps(constants, indent=2)};

// Utility Functions
export const convertToGrams = (amount, unit) => {{
    const volumeMeasurements = SHARED_CONSTANTS.VOLUME_MEASUREMENTS;
    const weightMeasurements = SHARED_CONSTANTS.WEIGHT_MEASUREMENTS;

    if (weightMeasurements[unit]) {{
        return amount * weightMeasurements[unit].grams;
    }}

    if (volumeMeasurements[unit]) {{
        return amount * volumeMeasurements[unit].ml;
    }}

    return amount;
}};

export const convertToMl = (amount, unit) => {{
    const volumeMeasurements = SHARED_CONSTANTS.VOLUME_MEASUREMENTS;
    const weightMeasurements = SHARED_CONSTANTS.WEIGHT_MEASUREMENTS;

    if (volumeMeasurements[unit]) {{
        return amount * volumeMeasurements[unit].ml;
    }}

    if (weightMeasurements[unit]) {{
        return amount * weightMeasurements[unit].grams;
    }}

    return amount;
}};

export const calculateHealthFactors = (diseases, medications) => {{
    let totalFactor = 1.0;

    if (diseases && diseases.length > 0) {{
        diseases.forEach(disease => {{
            const diseaseFactor = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.disease_factors[disease]?.factor || 1.0;
            totalFactor *= diseaseFactor;
        }});
    }}

    if (medications && medications.length > 0) {{
        medications.forEach(med => {{
            const medFactor = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors[med]?.factor || 1.0;
            totalFactor *= medFactor;
        }});
    }}

    return totalFactor;
}};

export const getInsulinInfo = (insulinName) => {{
    const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
    if (medicationFactors && medicationFactors[insulinName]) {{
        return {{
            ...medicationFactors[insulinName],
            name: insulinName
        }};
    }}
    return null;
}};

export const getMealAbsorptionProfile = (absorptionType) => {{
    const profiles = SHARED_CONSTANTS.MEAL_ABSORPTION_PROFILES;
    if (profiles && profiles[absorptionType]) {{
        return {{
            ...profiles[absorptionType],
            type: absorptionType
        }};
    }}
    return profiles ? profiles['medium'] : null;
}};

export const getCircadianBaseline = (hourFloat, profile) => {{
    const anchors = (profile && profile.anchors) || SHARED_CONSTANTS.DEFAULT_CIRCADIAN_PROFILE.anchors;
    if (!anchors || anchors.length === 0) return 100;

    const h = ((hourFloat % 24) + 24) % 24;
    let lower = null;
    let upper = null;

    for (const anchor of anchors) {{
        if (anchor.hour <= h) lower = anchor;
        if (upper === null && anchor.hour > h) upper = anchor;
    }}

    if (lower === null) lower = anchors[anchors.length - 1];
    if (upper === null) upper = anchors[0];

    let loH = lower.hour;
    let hiH = upper.hour;
    if (hiH < loH) hiH += 24;
    if (loH === hiH) return lower.value;

    const t = (h - loH) / (hiH - loH);
    return Math.round((lower.value + t * (upper.value - lower.value)) * 10) / 10;
}};
"""

        frontend_path = Path(output_path)
        frontend_path.parent.mkdir(parents=True, exist_ok=True)

        with open(frontend_path, 'w', encoding='utf-8') as f:
            f.write(js_content)

    @classmethod
    def export_constants_to_mobile(cls, output_path: str = '../mobile/constants/shared-constants.ts'):
        """Export constants to TypeScript for React Native mobile app."""
        constants = cls.get_all_constants()

        ts_types = """// Auto-generated from backend constants - DO NOT EDIT DIRECTLY

// ============================================================================
// MANUAL ADDITIONS — Insulin type suggestion config (not auto-generated)
// ============================================================================

/** Valid baseline calculation modes */
export type BaselineMode = 'dynamic' | 'preset';

export interface InsulinTypeSuggestionConfig {
  label: string;
  rationale: string;
  color: string;
  icon: string;
  typeFilter: string[];
  preferredKeys?: string[];
}

export const ABSORPTION_TO_INSULIN_CONFIG: Record<AbsorptionType, InsulinTypeSuggestionConfig> = {
  very_fast: {
    label: 'Ultra-Rapid Analog',
    rationale:
      'Very fast-absorbing foods (glucose tabs, simple sugars) spike BG rapidly. ' +
      'Ultra-rapid analogs match this peak best and reduce post-meal hypoglycemia risk.',
    color: '#d32f2f',
    icon: '⚡',
    typeFilter: ['rapid_acting'],
    preferredKeys: ['insulin_aspart_faster', 'insulin_lispro_ultra_rapid'],
  },
  fast: {
    label: 'Rapid-Acting Analog',
    rationale:
      'Fast-absorbing foods (white bread, juice, refined carbs) are well-covered by ' +
      'standard rapid-acting analogs taken 5–10 min before eating.',
    color: '#e64a19',
    icon: '🔺',
    typeFilter: ['rapid_acting'],
    preferredKeys: ['insulin_aspart', 'insulin_lispro', 'insulin_glulisine'],
  },
  medium: {
    label: 'Rapid-Acting Analog',
    rationale:
      'Mixed meals and whole grains absorb at a moderate pace. ' +
      'Rapid-acting analogs taken 10–15 min before align well with the absorption curve.',
    color: '#388e3c',
    icon: '✅',
    typeFilter: ['rapid_acting'],
    preferredKeys: ['insulin_aspart', 'insulin_lispro', 'insulin_glulisine'],
  },
  mixed: {
    label: 'NovoLog Dual Split or Regular Insulin',
    rationale:
      'This meal combines fast-absorbing and slow/fat-heavy items, creating a biphasic ' +
      'glucose response (pizza effect). A single rapid-acting bolus covers only one peak. ' +
      'Use a dual split (60% before eating, 40% at +2.5 h) or switch to regular insulin ' +
      'whose longer action profile spans both rises in a single injection.',
    color: '#f57c00',
    icon: '🍕',
    typeFilter: ['rapid_acting', 'short_acting'],
    coverageGapNote:
      'A single rapid-acting dose will miss either the early carb spike or the ' +
      'fat-delayed rise (3–5 h). Check BG at +2 h and +5–6 h after eating.',
    splitDoseNote:
      'Dual-split strategy: 60% of total dose 5 min before eating to cover the ' +
      'fast-carb peak, then 40% at +2.5 h to cover the fat-delayed second rise.',
  },
  slow: {
    label: 'Rapid-Acting Analog or Regular Insulin',
    rationale:
      'High-protein/fat and complex-carb meals absorb slowly. Take a rapid-acting analog ' +
      '20–30 min early, or switch to regular insulin to better match the delayed glucose rise.',
    color: '#1565c0',
    icon: '🕐',
    typeFilter: ['rapid_acting', 'short_acting'],
  },
  very_slow: {
    label: 'Regular Insulin or Split Dose',
    rationale:
      'Very high-fat/fiber meals have a prolonged flat absorption curve. A split bolus ' +
      '(50% now, 50% in 1–2 h) or regular insulin reduces early hypoglycemia risk.',
    color: '#6a1b9a',
    icon: '⏳',
    typeFilter: ['short_acting'],
  },
};

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface MeasurementSystems {
  VOLUME: string;
  WEIGHT: string;
}

export interface Measurement {
  ml?: number;
  grams?: number;
  display_name: string;
}

export interface ActivityLevel {
  value: number;
  label: string;
  impact: number;
}

/** HR ODE exercise model — intensity tier descriptor */
export interface ActivityIntensityLevel {
  /** Fraction of (HRmax − HRbase) above HRbase for this tier */
  hr_fraction: number;
  /** Human-readable label: 'Light' | 'Moderate' | 'Vigorous' */
  label: string;
  /** Maps to legacy ACTIVITY_LEVELS integer value */
  level: number;
}

/** Categorical exercise intensity — used throughout activity-pharmacodynamics */
export type ActivityIntensity = 'light' | 'moderate' | 'vigorous';

/**
 * Population-level ODE shape constants for the Dalla Man / Breton HR exercise model.
 * Patient physiology (hr_base, hr_max, weight_kg) lives in PatientConstants.
 */
export interface HrModel {
  tau_HR: number;
  tau_Z: number;
  tau_W: number;
  a: number;
  alpha: number;
  max_sensitivity_boost: number;
  dt: number;
  acute_rate_per_min: number;
  hr_max_pop: number;
  hr_base_pop: number;
}

export interface MealType {
  value: string;
  label: string;
}

export interface FoodCategory {
  value: string;
  label: string;
}

export interface InsulinTimingGuideline {
  timing_minutes: number;
  description: string;
}

export interface TimeOfDayFactor {
  hours: [number, number];
  factor: number;
  description: string;
}

export interface DiseaseFactor {
  factor: number;
  description: string;
}

export interface MedicationFactor {
  factor: number;
  description: string;
  duration_based: boolean;
  onset_hours?: number;
  peak_hours?: number;
  duration_hours?: number;
  type: string;
  is_peakless?: boolean;
  brand_names?: string[];
  curve_type?: string;
}

export interface MealAbsorptionProfile {
  onset_hours: number;
  peak_hours: number;
  duration_hours: number;
  curve_type: string;
  shape_param: number;
  scale_param: number;
  description: string;
}

/** Single anchor point in the circadian baseline profile */
export interface CircadianAnchor {
  hour: number;   // 0–23 (integer)
  value: number;  // mg/dL
}

/** Circadian baseline profile stored on the patient */
export interface CircadianProfile {
  anchors: CircadianAnchor[];
  source: 'preset' | 'custom';
}

/** Human-readable description of a baseline mode */
export interface BaselineModeInfo {
  label: string;
  description: string;
}

export interface PatientConstants {
  insulin_to_carb_ratio: number;
  correction_factor: number;
  target_glucose: number;
  protein_factor: number;
  fat_factor: number;
  carb_to_bg_factor: number;
  daily_reset_hour: number;
  timezone_offset_minutes: number;
  /** Controls how the stable baseline is derived — see BASELINE_MODES */
  baseline_mode: BaselineMode;
  /** 24-hour circadian profile used when baseline_mode === 'preset' */
  circadian_profile: CircadianProfile;
  activity_coefficients: { [key: string]: number };
  absorption_modifiers: { [key: string]: number };
  insulin_timing_guidelines: { [key: string]: InsulinTimingGuideline };
  meal_timing_factors: { [key: string]: number };
  time_of_day_factors: { [key: string]: TimeOfDayFactor };
  disease_factors: { [key: string]: DiseaseFactor };
  medication_factors: { [key: string]: MedicationFactor };
  meal_absorption_profiles: { [key: string]: MealAbsorptionProfile };
  // ── Activity / HR ODE model fields ────────────────────────────────────────
  /** Alias for carb_to_bg_factor used by the activity model (default 4.0) */
  carb_to_bg_ratio?: number;
  /** Body weight in kg — used for allometric BG-drop scaling (default 70.0) */
  weight_kg?: number;
  /** Patient resting HR in bpm (default 70.0) */
  hr_base?: number;
  /** Patient maximum HR in bpm (default 190.0) */
  hr_max?: number;
}

export interface ViewModeConfig {
  label: string;
  pastHours: number;
  futureHours: number;
  tickInterval: number;
  tickFormat: string;
  interpolationInterval: number;
  mealLookback: number;
  insulinLookback: number;
  /**
   * Minimum API fetch depth (hours) needed for a correct cumulative baseline line.
   *
   * Always >= pastHours AND >= (dailyResetHour + 24 + 1) so the *previous* daily
   * window is fully covered regardless of how short the visible chart range is.
   *
   * Static value is pre-computed with DEFAULT_RESET_HOUR = 7 (→ 32 h).
   * For the patient's actual reset hour at runtime, call:
   *   getCumulativeLookbackHours(patientConstants.daily_reset_hour)
   *
   * Usage in activeEffectsOptions:
   *   const fetchHours = Math.max(
   *     displayPastHours,
   *     getCumulativeLookbackHours(patientConstants.daily_reset_hour)
   *   );
   *
   * Usage in allMealsInWindow (anchor to reset at rangeStart):
   *   const earliestResetMs = getLastResetTimeMs(
   *     new Date(Math.min(rangeStart, now)), resetHour, tzOffset
   *   );
   *   const cumulativeWindowStart = Math.min(rangeStart, earliestResetMs);
   */
  cumulativeLookbackHours: number;
}

export interface T1DBGConstants {
  recent_reading_threshold_min: number;
  max_reading_age_hours: number;
  max_reading_age_minutes: number;
  target_glucose_default: number;
  default_chart_interval_min: number;
  iob_lookback_hours: number;
  mob_lookback_hours: number;
}

export interface NetEffectThresholds {
  high_rising: number;
  rising: number;
  slightly_rising: number;
  stable_high: number;
  stable_low: number;
  slightly_falling: number;
  falling: number;
  rapidly_falling: number;
}

export interface TimingThresholds {
  min_active_carbs: number;
  max_active_carbs: number;
  high_iob_threshold: number;
  slow_meal_activity_threshold: number;
}

export interface SharedConstants {
  MEASUREMENT_SYSTEMS: MeasurementSystems;
  VOLUME_MEASUREMENTS: { [key: string]: Measurement };
  WEIGHT_MEASUREMENTS: { [key: string]: Measurement };
  ACTIVITY_LEVELS: ActivityLevel[];
  MEAL_TYPES: MealType[];
  FOOD_CATEGORIES: FoodCategory[];
  DEFAULT_PATIENT_CONSTANTS: PatientConstants;
  VIEW_MODE_CONFIGS: { [key: string]: ViewModeConfig };
  T1D_BG_CONSTANTS: T1DBGConstants;
  NET_EFFECT_THRESHOLDS: NetEffectThresholds;
  TIMING_THRESHOLDS: TimingThresholds;
  CURVE_DESCRIPTIONS: { [key: string]: string };
  MEAL_ABSORPTION_PROFILES: { [key: string]: MealAbsorptionProfile };
  BASELINE_MODES: { [key in BaselineMode]: BaselineModeInfo };
  DEFAULT_CIRCADIAN_PROFILE: CircadianProfile;
  /** HR ODE exercise model — intensity tier map */
  ACTIVITY_INTENSITY_LEVELS: { [key: string]: ActivityIntensityLevel };
  /** Population-level ODE shape constants (Dalla Man / Breton) — not patient-modifiable */
  HR_MODEL: HrModel;
  /** HR as fraction of (HRmax − HRbase) above HRbase per intensity tier */
  INTENSITY_HR_FRACTION: { light: number; moderate: number; vigorous: number };
  /**
   * Population-calibrated peak BG-sensitivity boost per exercise intensity tier.
   * Approximates HR_MODEL alpha × W_peak × (1 + Z_peak) for hr_base=70, weight=70 kg.
   * Used by EVC and BGV as chart fallback when live API scalar has decayed to baseline.
   * Single source of truth — never duplicate as local constants in chart components.
   */
  INTENSITY_PEAK_BOOST: { [key in ActivityIntensity]: number };
  /**
   * Maps legacy integer activity level → pharmacodynamic intensity string.
   * Levels ≤ −1 represent sedentary / sick days → null (no BG-lowering effect).
   */
  LEVEL_TO_INTENSITY: { [level: string]: ActivityIntensity | null };
}

"""

        ts_content = ts_types + f"""
// ============================================================================
// CONSTANTS
// ============================================================================

export const SHARED_CONSTANTS: SharedConstants = {json.dumps(constants, indent=2)} as const;

// Derive from the generated constant — never hand-maintain this union
const _mealProfiles = SHARED_CONSTANTS.MEAL_ABSORPTION_PROFILES;
/** Derived from MEAL_ABSORPTION_PROFILES keys — do not hand-edit this union */
export type AbsorptionType = keyof typeof _mealProfiles;

// §M-5 — Validate ABSORPTION_TO_INSULIN_CONFIG.typeFilter values at module load.
// Every typeFilter string must match a medication type category present in
// medication_factors (i.e. the "type" field on each entry, e.g. "rapid_acting",
// "short_acting") — NOT the medication key names (e.g. "insulin_aspart").
// This throws in development and logs a warning in production so stale filter
// strings are caught as soon as the module is imported, not at runtime during
// a user interaction.
(function validateAbsorptionConfig() {{
  const knownMedTypes = new Set(
    Object.values(SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors ?? {{}})
      .map((m: any) => m?.type)
      .filter(Boolean)
  );
  if (knownMedTypes.size === 0) return; // constants not loaded yet — skip

  for (const [absorptionKey, config] of Object.entries(ABSORPTION_TO_INSULIN_CONFIG)) {{
    for (const typeFilter of config.typeFilter ?? []) {{
      if (!knownMedTypes.has(typeFilter)) {{
        const msg =
          `[shared-constants] §M-5: ABSORPTION_TO_INSULIN_CONFIG["${{absorptionKey}}"]` +
          `.typeFilter contains unknown medication category "${{typeFilter}}".` +
          ` Known types: ${{[...knownMedTypes].join(', ')}}`;
        if (process.env.NODE_ENV === 'production') {{
          console.warn(msg);
        }} else {{
          throw new Error(msg);
        }}
      }}
    }}
  }}
}})();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export const convertToGrams = (amount: number, unit: string): number => {{
  const volumeMeasurements = SHARED_CONSTANTS.VOLUME_MEASUREMENTS;
  const weightMeasurements = SHARED_CONSTANTS.WEIGHT_MEASUREMENTS;

  if (weightMeasurements[unit]) {{
    return amount * weightMeasurements[unit].grams!;
  }}

  if (volumeMeasurements[unit]) {{
    return amount * volumeMeasurements[unit].ml!;
  }}

  return amount;
}};

export const convertToMl = (amount: number, unit: string): number => {{
  const volumeMeasurements = SHARED_CONSTANTS.VOLUME_MEASUREMENTS;
  const weightMeasurements = SHARED_CONSTANTS.WEIGHT_MEASUREMENTS;

  if (volumeMeasurements[unit]) {{
    return amount * volumeMeasurements[unit].ml!;
  }}

  if (weightMeasurements[unit]) {{
    return amount * weightMeasurements[unit].grams!;
  }}

  return amount;
}};

export const calculateHealthFactors = (
  diseases?: string[],
  medications?: string[]
): number => {{
  let totalFactor = 1.0;

  if (diseases && diseases.length > 0) {{
    diseases.forEach((disease) => {{
      const diseaseFactor =
        SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.disease_factors[disease]?.factor || 1.0;
      totalFactor *= diseaseFactor;
    }});
  }}

  if (medications && medications.length > 0) {{
    medications.forEach((med) => {{
      const medFactor =
        SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors[med]?.factor || 1.0;
      totalFactor *= medFactor;
    }});
  }}

  return totalFactor;
}};

export const getInsulinInfo = (
  insulinName: string
): (MedicationFactor & {{ name: string }}) | null => {{
  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  if (medicationFactors && medicationFactors[insulinName]) {{
    return {{
      ...medicationFactors[insulinName],
      name: insulinName,
    }};
  }}
  return null;
}};

export const getMealAbsorptionProfile = (
  absorptionType: string
): (MealAbsorptionProfile & {{ type: string }}) | null => {{
  const profiles = SHARED_CONSTANTS.MEAL_ABSORPTION_PROFILES;
  if (profiles && profiles[absorptionType]) {{
    return {{
      ...profiles[absorptionType],
      type: absorptionType,
    }};
  }}
  return profiles ? {{ ...profiles['medium'], type: 'medium' }} : null;
}};

/**
 * Interpolate the circadian baseline at a fractional hour of day.
 */
export const getCircadianBaseline = (
  hourFloat: number,
  profile?: CircadianProfile
): number => {{
  const anchors = profile?.anchors ?? SHARED_CONSTANTS.DEFAULT_CIRCADIAN_PROFILE.anchors;
  if (!anchors || anchors.length === 0) return 100;

  const h = ((hourFloat % 24) + 24) % 24;
  let lower: CircadianAnchor | null = null;
  let upper: CircadianAnchor | null = null;

  for (const anchor of anchors) {{
    if (anchor.hour <= h) lower = anchor;
    if (upper === null && anchor.hour > h) upper = anchor;
  }}

  if (lower === null) lower = anchors[anchors.length - 1];
  if (upper === null) upper = anchors[0];

  let loH = lower.hour;
  let hiH = upper.hour;
  if (hiH < loH) hiH += 24;
  if (loH === hiH) return lower.value;

  const t = (h - loH) / (hiH - loH);
  return Math.round((lower.value + t * (upper.value - lower.value)) * 10) / 10;
}};

/**
 * Return the minimum API fetch depth (hours) needed for a correct cumulative
 * baseline line, given the patient's daily reset hour.
 *
 * Formula: dailyResetHour + 24 + 1
 *
 * The +24 ensures the *previous* daily window is always fully covered
 * (a dose taken just after yesterday's reset must still be included).
 * The +1 absorbs DST transitions and off-by-one rounding at midnight.
 *
 * Examples:
 *   dailyResetHour = 7  (default) →  32 h
 *   dailyResetHour = 0            →  25 h
 *   dailyResetHour = 10           →  35 h
 *   dailyResetHour = 22           →  47 h
 *
 * Usage in activeEffectsOptions:
 * ```ts
 * const resetHour = patientConstants?.daily_reset_hour
 *   ?? DEFAULT_PATIENT_CONSTANTS.daily_reset_hour;
 * const fetchHours = Math.max(displayPastHours, getCumulativeLookbackHours(resetHour));
 * ```
 *
 * Usage in allMealsInWindow (anchor window start to the reset at rangeStart):
 * ```ts
 * const earliestResetMs = getLastResetTimeMs(
 *   new Date(Math.min(rangeStart, now)), resetHour, tzOffset
 * );
 * const cumulativeWindowStart = Math.min(rangeStart, earliestResetMs);
 * ```
 */
export const getCumulativeLookbackHours = (dailyResetHour: number = 7): number => {{
  return Math.floor(dailyResetHour) + 24 + 1;
}};

export const getActivityLevel = (value: number): ActivityLevel | null => {{
  return SHARED_CONSTANTS.ACTIVITY_LEVELS.find((level) => level.value === value) || null;
}};

export const getMealType = (value: string): MealType | null => {{
  return SHARED_CONSTANTS.MEAL_TYPES.find((type) => type.value === value) || null;
}};

export const getFoodCategory = (value: string): FoodCategory | null => {{
  return SHARED_CONSTANTS.FOOD_CATEGORIES.find((cat) => cat.value === value) || null;
}};

export const getTimeOfDayFactor = (hour: number): (TimeOfDayFactor & {{ key: string }}) | null => {{
  const factors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.time_of_day_factors;

  for (const [key, value] of Object.entries(factors)) {{
    const [start, end] = value.hours;
    if (hour >= start && hour < end) {{
      return {{ ...value, key }};
    }}
  }}

  return null;
}};

export const getInsulinTimingGuideline = (
  absorptionSpeed: string
): InsulinTimingGuideline | null => {{
  const guidelines = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines;
  return guidelines[absorptionSpeed] || null;
}};

export const getInsulinsByType = (): {{ [type: string]: {{ key: string; info: MedicationFactor }}[] }} => {{
  const medications = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const grouped: {{ [type: string]: {{ key: string; info: MedicationFactor }}[] }} = {{}};

  Object.entries(medications).forEach(([key, value]) => {{
    if (!grouped[value.type]) {{
      grouped[value.type] = [];
    }}
    grouped[value.type].push({{ key, info: value }});
  }});

  return grouped;
}};

// Export individual constants for convenience
export const {{
  MEASUREMENT_SYSTEMS,
  VOLUME_MEASUREMENTS,
  WEIGHT_MEASUREMENTS,
  ACTIVITY_LEVELS,
  MEAL_TYPES,
  FOOD_CATEGORIES,
  DEFAULT_PATIENT_CONSTANTS,
  VIEW_MODE_CONFIGS,
  T1D_BG_CONSTANTS,
  NET_EFFECT_THRESHOLDS,
  TIMING_THRESHOLDS,
  CURVE_DESCRIPTIONS,
  MEAL_ABSORPTION_PROFILES,
  BASELINE_MODES,
  DEFAULT_CIRCADIAN_PROFILE,
  BASELINE_HARD_MIN,
  BASELINE_HARD_MAX,
  ACTIVITY_INTENSITY_LEVELS,
  HR_MODEL,
  INTENSITY_HR_FRACTION,
  INTENSITY_PEAK_BOOST,
  LEVEL_TO_INTENSITY,
}} = SHARED_CONSTANTS;
"""

        mobile_path = Path(output_path)
        mobile_path.parent.mkdir(parents=True, exist_ok=True)

        with open(mobile_path, 'w', encoding='utf-8') as f:
            f.write(ts_content)

        _logger.info(f"TypeScript constants exported to: {mobile_path}")

    @classmethod
    def get_shared_constants_json(cls) -> dict:
        """
        Return the full SHARED_CONSTANTS payload as a plain Python dict
        ready for jsonify().  This is the authoritative source in production.
        """
        return cls.get_all_constants()

    @classmethod
    def invalidate_patient_cache(cls, patient_id: str) -> None:
        """Invalidate the process-level constants cache for a specific patient."""
        _PATIENT_CONSTANTS_CACHE.pop(patient_id, None)

    @classmethod
    def export_all_constants_safe(cls) -> bool:
        """
        Attempt to write shared_constants.js and shared-constants.ts to disk.

        Local dev  — writes both files.
        Render/prod — exits immediately without touching the filesystem.
        """
        import os
        if os.environ.get('RENDER'):
            _logger.info('Render environment detected — skipping file export (constants served via GET /api/patient/constants)')
            return True

        from pathlib import Path
        backend_dir = Path(__file__).resolve().parent
        root_dir    = backend_dir.parent

        web_path    = root_dir / 'frontend' / 'src' / 'constants' / 'shared_constants.js'
        mobile_path = root_dir / 'mobile'   / 'constants' / 'shared-constants.ts'

        web_ok = mobile_ok = True

        if web_path.parent.exists():
            try:
                cls.export_constants_to_frontend(str(web_path))
                _logger.info(f'Web constants written → {web_path}')
            except Exception as e:
                _logger.warning(f'Web constants write failed (non-fatal): {e}')
                web_ok = False
        else:
            _logger.info('Web constants dir absent — skipping file write')

        if mobile_path.parent.exists():
            try:
                cls.export_constants_to_mobile(str(mobile_path))
                _logger.info(f'Mobile constants written → {mobile_path}')
            except Exception as e:
                _logger.warning(f'Mobile constants write failed (non-fatal): {e}')
                mobile_ok = False
        else:
            _logger.info('Mobile constants dir absent — skipping file write')

        return web_ok and mobile_ok

    @classmethod
    def export_all_constants(cls,
                           web_output_path: str = '../frontend/src/constants/shared_constants.js',
                           mobile_output_path: str = '../mobile/constants/shared-constants.ts'):
        """Export constants to both web (JavaScript) and mobile (TypeScript) formats."""
        _logger.info('Exporting constants to frontend and mobile...')
        cls.export_constants_to_frontend(web_output_path)
        cls.export_constants_to_mobile(mobile_output_path)
        _logger.info('All constants exported successfully!')