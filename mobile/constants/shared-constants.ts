// Auto-generated from backend constants - DO NOT EDIT DIRECTLY

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
  /** D22: HR-reserve fraction at which the acute signal Z reaches 1.0. */
  z_reference_hr_reserve: number;
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


// ============================================================================
// CONSTANTS
// ============================================================================

export const SHARED_CONSTANTS: SharedConstants = {
  "MEASUREMENT_SYSTEMS": {
    "VOLUME": "volume",
    "WEIGHT": "weight"
  },
  "VOLUME_MEASUREMENTS": {
    "cup": {
      "ml": 240,
      "display_name": "Cup"
    },
    "half_cup": {
      "ml": 120,
      "display_name": "\u00bd Cup"
    },
    "quarter_cup": {
      "ml": 60,
      "display_name": "\u00bc Cup"
    },
    "tablespoon": {
      "ml": 15,
      "display_name": "Tablespoon"
    },
    "teaspoon": {
      "ml": 5,
      "display_name": "Teaspoon"
    },
    "bowl": {
      "ml": 400,
      "display_name": "Medium Bowl"
    },
    "v_plate": {
      "ml": 350,
      "display_name": "Full Plate (Volume)"
    },
    "v_small_plate": {
      "ml": 175,
      "display_name": "Small Plate (Volume)"
    },
    "ml": {
      "ml": 1,
      "display_name": "Milliliter"
    }
  },
  "WEIGHT_MEASUREMENTS": {
    "palm": {
      "grams": 85,
      "display_name": "Palm-sized"
    },
    "handful": {
      "grams": 30,
      "display_name": "Handful"
    },
    "fist": {
      "grams": 150,
      "display_name": "Fist-sized"
    },
    "w_plate": {
      "grams": 300,
      "display_name": "Full Plate (Weight)"
    },
    "w_small_plate": {
      "grams": 150,
      "display_name": "Small Plate (Weight)"
    },
    "g": {
      "grams": 1,
      "display_name": "Grams"
    },
    "kg": {
      "grams": 1000,
      "display_name": "Kilograms"
    }
  },
  "ACTIVITY_LEVELS": [
    {
      "value": -2,
      "label": "mode 1",
      "impact": 1.2
    },
    {
      "value": -1,
      "label": "mode 2",
      "impact": 1.1
    },
    {
      "value": 0,
      "label": "Normal Activity",
      "impact": 1.0
    },
    {
      "value": 1,
      "label": "High Activity",
      "impact": 0.9
    },
    {
      "value": 2,
      "label": "Vigorous Activity",
      "impact": 0.8
    }
  ],
  "MEAL_TYPES": [
    {
      "value": "breakfast",
      "label": "Breakfast"
    },
    {
      "value": "lunch",
      "label": "Lunch"
    },
    {
      "value": "dinner",
      "label": "Dinner"
    },
    {
      "value": "snack",
      "label": "Snack"
    }
  ],
  "FOOD_CATEGORIES": [
    {
      "value": "basic",
      "label": "Basic Foods"
    },
    {
      "value": "starch",
      "label": "Starches"
    },
    {
      "value": "starchy_vegetables",
      "label": "Starchy Vegetables"
    },
    {
      "value": "pulses",
      "label": "Pulses"
    },
    {
      "value": "fruits",
      "label": "Fruits"
    },
    {
      "value": "dairy",
      "label": "Dairy"
    },
    {
      "value": "sweets",
      "label": "Sweets & Desserts"
    },
    {
      "value": "snacks",
      "label": "Snacks"
    },
    {
      "value": "common_snacks",
      "label": "Common Snacks"
    },
    {
      "value": "high_protein",
      "label": "High Protein Foods"
    },
    {
      "value": "high_fat",
      "label": "High Fat Foods"
    },
    {
      "value": "egyptian",
      "label": "Egyptian Dishes"
    },
    {
      "value": "international",
      "label": "International Dishes"
    },
    {
      "value": "german",
      "label": "German Dishes"
    },
    {
      "value": "salads_condiments",
      "label": "Salads & Condiments"
    },
    {
      "value": "beverages",
      "label": "Beverages"
    },
    {
      "value": "custom",
      "label": "Custom Foods"
    }
  ],
  "DEFAULT_PATIENT_CONSTANTS": {
    "insulin_to_carb_ratio": 10,
    "correction_factor": 40,
    "target_glucose": 100,
    "protein_factor": 0.5,
    "fat_factor": 0.2,
    "carb_to_bg_factor": 4.0,
    "carb_to_bg_ratio": 4.0,
    "weight_kg": 70.0,
    "hr_base": 70.0,
    "hr_max": 190.0,
    "daily_reset_hour": 7,
    "timezone_offset_minutes": 0,
    "baseline_mode": "dynamic",
    "circadian_profile": {
      "anchors": [
        {
          "hour": 0,
          "value": 90.0
        },
        {
          "hour": 1,
          "value": 88.0
        },
        {
          "hour": 2,
          "value": 87.0
        },
        {
          "hour": 3,
          "value": 85.0
        },
        {
          "hour": 4,
          "value": 87.0
        },
        {
          "hour": 5,
          "value": 93.0
        },
        {
          "hour": 6,
          "value": 108.0
        },
        {
          "hour": 7,
          "value": 118.0
        },
        {
          "hour": 8,
          "value": 120.0
        },
        {
          "hour": 9,
          "value": 115.0
        },
        {
          "hour": 10,
          "value": 108.0
        },
        {
          "hour": 11,
          "value": 103.0
        },
        {
          "hour": 12,
          "value": 100.0
        },
        {
          "hour": 13,
          "value": 98.0
        },
        {
          "hour": 14,
          "value": 97.0
        },
        {
          "hour": 15,
          "value": 97.0
        },
        {
          "hour": 16,
          "value": 100.0
        },
        {
          "hour": 17,
          "value": 102.0
        },
        {
          "hour": 18,
          "value": 100.0
        },
        {
          "hour": 19,
          "value": 99.0
        },
        {
          "hour": 20,
          "value": 97.0
        },
        {
          "hour": 21,
          "value": 95.0
        },
        {
          "hour": 22,
          "value": 93.0
        },
        {
          "hour": 23,
          "value": 91.0
        }
      ],
      "source": "preset"
    },
    "activity_coefficients": {
      "-2": 1.2,
      "-1": 1.1,
      "0": 1.0,
      "1": 0.9,
      "2": 0.8
    },
    "absorption_modifiers": {
      "very_slow": 0.6,
      "slow": 0.8,
      "medium": 1.0,
      "mixed": 0.9,
      "fast": 1.2,
      "very_fast": 1.4
    },
    "insulin_timing_guidelines": {
      "very_fast": {
        "timing_minutes": 0,
        "description": "Inject your bolus insulin and eat immediately \u2014 no pre-bolus wait needed.",
        "split_bolus_advisory": false
      },
      "fast": {
        "timing_minutes": 5,
        "description": "Inject your bolus insulin 5 min before eating.",
        "split_bolus_advisory": false
      },
      "medium": {
        "timing_minutes": 10,
        "description": "Inject your bolus insulin 10 min before eating.",
        "split_bolus_advisory": false
      },
      "slow": {
        "timing_minutes": 20,
        "description": "Slow meal \u2014 choose one option:\nA (NovoLog split): inject 20 min before eating, second dose at +90 min.\nB (Regular insulin): inject full dose at meal start \u2014 no wait needed.\nC (NovoLog single): inject 10 min after first bite \u2014 best single-dose peak alignment.",
        "split_bolus_advisory": false
      },
      "very_slow": {
        "timing_minutes": 30,
        "description": "Very slow meal \u2014 choose one option:\nA (NovoLog split): inject 30 min before eating, second dose at +90 min.\nB (Regular insulin): inject full dose at meal start \u2014 best single-injection match.\nC (NovoLog single): inject 30 min after first bite \u2014 best single-dose option for this meal.",
        "split_bolus_advisory": true
      },
      "mixed": {
        "timing_minutes": 5,
        "description": "Mixed meal (biphasic response) \u2014 choose one option:\nA (NovoLog dual split): 60% dose 5 min before eating, 40% dose at +2.5 h.\nB (Regular insulin): full dose at meal start \u2014 covers both peaks in one injection.\nCheck BG at +2 h and +5\u20136 h; late hyperglycaemia (3\u20136 h) is the primary risk.",
        "split_bolus_advisory": true
      }
    },
    "meal_timing_factors": {
      "breakfast": 1.2,
      "lunch": 1.0,
      "dinner": 0.9,
      "snack": 1.0
    },
    "time_of_day_factors": {
      "early_morning": {
        "hours": [
          0,
          6
        ],
        "factor": 1.1,
        "description": "Very early morning adjustment"
      },
      "morning": {
        "hours": [
          6,
          10
        ],
        "factor": 1.2,
        "description": "Morning insulin resistance period"
      },
      "daytime": {
        "hours": [
          10,
          22
        ],
        "factor": 1.0,
        "description": "Standard daytime period"
      },
      "late_night": {
        "hours": [
          22,
          24
        ],
        "factor": 0.9,
        "description": "Late night adjustment"
      }
    },
    "disease_factors": {
      "type_1_diabetes": {
        "factor": 1.0,
        "description": "Standard insulin sensitivity for Type 1 Diabetes"
      },
      "type_2_diabetes": {
        "factor": 0.8,
        "description": "Reduced insulin sensitivity for Type 2 Diabetes"
      },
      "gestational_diabetes": {
        "factor": 1.2,
        "description": "Increased insulin sensitivity during pregnancy"
      },
      "insulin_resistance": {
        "factor": 0.7,
        "description": "Significant reduction in insulin sensitivity"
      },
      "thyroid_disorders": {
        "factor": 1.1,
        "description": "Slight increase in insulin requirements"
      },
      "celiac_disease": {
        "factor": 1.1,
        "description": "May require insulin adjustment due to absorption issues"
      }
    },
    "medication_factors": {
      "nph_insulin": {
        "factor": 1.0,
        "description": "Intermediate-acting human insulin (NPH)",
        "duration_based": true,
        "onset_hours": 1.5,
        "peak_hours": 6.5,
        "duration_hours": 14,
        "type": "intermediate_acting",
        "is_peakless": false,
        "brand_names": [
          "Humulin N",
          "Novolin N"
        ],
        "curve_type": "gamma_wide"
      },
      "regular_insulin": {
        "factor": 1.0,
        "description": "Short-acting human insulin",
        "duration_based": true,
        "onset_hours": 0.75,
        "peak_hours": 3,
        "duration_hours": 8,
        "type": "short_acting",
        "is_peakless": false,
        "brand_names": [
          "Humulin R",
          "Novolin R"
        ],
        "curve_type": "gamma_broad"
      },
      "mixed_insulin_70_30": {
        "factor": 1.0,
        "description": "70% NPH, 30% Regular insulin mixture",
        "duration_based": true,
        "onset_hours": 0.5,
        "peak_hours": 3.25,
        "duration_hours": 14,
        "type": "mixed",
        "is_peakless": false,
        "brand_names": [
          "Humulin 70/30",
          "Novolin 70/30"
        ],
        "curve_type": "gamma_broad"
      },
      "insulin_degludec": {
        "factor": 1.0,
        "description": "Ultra-long-acting insulin analogue - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 1.5,
        "peak_hours": 11,
        "duration_hours": 42,
        "type": "long_acting",
        "is_peakless": true,
        "brand_names": [
          "Tresiba"
        ],
        "curve_type": "sigmoid_ultra_long"
      },
      "insulin_detemir": {
        "factor": 1.0,
        "description": "Long-acting insulin analogue - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 1,
        "peak_hours": 8,
        "duration_hours": 22.5,
        "type": "long_acting",
        "is_peakless": true,
        "brand_names": [
          "Levemir"
        ],
        "curve_type": "gamma_extended"
      },
      "insulin_glargine": {
        "factor": 1.0,
        "description": "Long-acting insulin analogue U100 - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 1,
        "peak_hours": 10,
        "duration_hours": 23.5,
        "type": "long_acting",
        "is_peakless": true,
        "brand_names": [
          "Lantus",
          "Basaglar"
        ],
        "curve_type": "sigmoid_plateau"
      },
      "insulin_glargine_u300": {
        "factor": 1.0,
        "description": "Long-acting insulin analogue U300 - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 3.5,
        "peak_hours": 14,
        "duration_hours": 31,
        "type": "long_acting",
        "is_peakless": true,
        "brand_names": [
          "Toujeo"
        ],
        "curve_type": "sigmoid_extended"
      },
      "insulin_aspart": {
        "factor": 1.0,
        "description": "Rapid-acting insulin analogue - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.375,
        "peak_hours": 2.25,
        "duration_hours": 4.5,
        "type": "rapid_acting",
        "is_peakless": false,
        "brand_names": [
          "NovoLog",
          "NovoRapid"
        ],
        "curve_type": "gamma_steep"
      },
      "insulin_aspart_faster": {
        "factor": 1.0,
        "description": "Faster-acting insulin aspart - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.29,
        "peak_hours": 2.25,
        "duration_hours": 3.5,
        "type": "rapid_acting",
        "is_peakless": false,
        "brand_names": [
          "Fiasp"
        ],
        "curve_type": "gamma_very_steep"
      },
      "insulin_glulisine": {
        "factor": 1.0,
        "description": "Rapid-acting insulin analogue - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.375,
        "peak_hours": 2.25,
        "duration_hours": 4.5,
        "type": "rapid_acting",
        "is_peakless": false,
        "brand_names": [
          "Apidra"
        ],
        "curve_type": "gamma_steep"
      },
      "insulin_lispro": {
        "factor": 1.0,
        "description": "Rapid-acting insulin analogue - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.375,
        "peak_hours": 2.25,
        "duration_hours": 4.5,
        "type": "rapid_acting",
        "is_peakless": false,
        "brand_names": [
          "Humalog",
          "Admelog"
        ],
        "curve_type": "gamma_steep"
      },
      "insulin_lispro_ultra_rapid": {
        "factor": 1.0,
        "description": "Ultra rapid-acting insulin lispro - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.29,
        "peak_hours": 2,
        "duration_hours": 4,
        "type": "rapid_acting",
        "is_peakless": false,
        "brand_names": [
          "Lyumjev"
        ],
        "curve_type": "gamma_very_steep"
      },
      "mixed_aspart_70_30": {
        "factor": 1.0,
        "description": "70% protaminated aspart, 30% aspart - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.375,
        "peak_hours": 2.5,
        "duration_hours": 12,
        "type": "mixed",
        "is_peakless": false,
        "brand_names": [
          "NovoMix 70/30"
        ],
        "curve_type": "gamma_broad"
      },
      "mixed_lispro_75_25": {
        "factor": 1.0,
        "description": "75% protaminated lispro, 25% lispro - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.375,
        "peak_hours": 2.5,
        "duration_hours": 12,
        "type": "mixed",
        "is_peakless": false,
        "brand_names": [
          "Humalog Mix 75/25"
        ],
        "curve_type": "gamma_broad"
      },
      "combination_degludec_aspart": {
        "factor": 1.0,
        "description": "70% degludec, 30% aspart combination - S3 Guidelines",
        "duration_based": true,
        "onset_hours": 0.375,
        "peak_hours": 2.5,
        "duration_hours": 30,
        "type": "mixed",
        "is_peakless": false,
        "brand_names": [
          "Ryzodeg"
        ],
        "curve_type": "gamma_broad"
      },
      "injectable_contraceptives": {
        "factor": 1.3,
        "description": "Injectable contraceptives can significantly increase insulin resistance",
        "duration_based": true,
        "onset_hours": 48,
        "peak_hours": 168,
        "duration_hours": 2160,
        "type": "hormone"
      },
      "corticosteroids": {
        "factor": 1.4,
        "description": "Significant increase in insulin resistance",
        "duration_based": true,
        "onset_hours": 4,
        "peak_hours": 8,
        "duration_hours": 24,
        "type": "steroid"
      },
      "oral_contraceptives": {
        "factor": 1.2,
        "description": "Oral contraceptives may increase insulin resistance",
        "duration_based": true,
        "onset_hours": 24,
        "peak_hours": 72,
        "duration_hours": 720,
        "type": "hormone"
      },
      "beta_blockers": {
        "factor": 1.2,
        "description": "Moderate increase in insulin resistance",
        "duration_based": false,
        "type": "cardiovascular"
      },
      "thiazide_diuretics": {
        "factor": 1.1,
        "description": "Slight increase in insulin resistance",
        "duration_based": false,
        "type": "cardiovascular"
      },
      "metformin": {
        "factor": 0.9,
        "description": "Improved insulin sensitivity",
        "duration_based": false,
        "type": "antidiabetic"
      },
      "thiazolidinediones": {
        "factor": 0.8,
        "description": "Significant improvement in insulin sensitivity",
        "duration_based": true,
        "onset_hours": 24,
        "peak_hours": 48,
        "duration_hours": 168,
        "type": "antidiabetic"
      }
    },
    "meal_absorption_profiles": {
      "very_fast": {
        "onset_hours": 0.08,
        "peak_hours": 0.5,
        "duration_hours": 2.0,
        "curve_type": "gamma_steep",
        "shape_param": 2.5,
        "scale_param": 0.3,
        "description": "Simple sugars, glucose tablets - very rapid absorption"
      },
      "fast": {
        "onset_hours": 0.25,
        "peak_hours": 1.0,
        "duration_hours": 3.0,
        "curve_type": "gamma_moderate",
        "shape_param": 2.0,
        "scale_param": 0.5,
        "description": "Refined carbohydrates, white bread, juice - fast absorption"
      },
      "medium": {
        "onset_hours": 0.42,
        "peak_hours": 1.5,
        "duration_hours": 4.0,
        "curve_type": "gamma_standard",
        "shape_param": 1.8,
        "scale_param": 0.8,
        "description": "Mixed meals, whole grains - moderate absorption"
      },
      "slow": {
        "onset_hours": 0.75,
        "peak_hours": 2.5,
        "duration_hours": 5.5,
        "curve_type": "gamma_extended",
        "shape_param": 1.5,
        "scale_param": 1.2,
        "description": "High protein/fat meals, complex carbs - slow absorption"
      },
      "very_slow": {
        "onset_hours": 1.0,
        "peak_hours": 3.5,
        "duration_hours": 7.0,
        "curve_type": "gamma_plateau",
        "shape_param": 1.2,
        "scale_param": 1.8,
        "description": "Very high fat/fiber meals - very slow absorption"
      },
      "mixed": {
        "onset_hours": 0.25,
        "peak_hours": 2.0,
        "duration_hours": 6.0,
        "curve_type": "gamma_broad",
        "shape_param": 1.4,
        "scale_param": 1.4,
        "description": "Mixed fast + slow meal (pizza-effect) - biphasic absorption"
      }
    }
  },
  "VIEW_MODE_CONFIGS": {
    "3h": {
      "label": "3H",
      "pastHours": 2.5,
      "futureHours": 0.5,
      "tickInterval": 0.5,
      "tickFormat": "HH:mm",
      "interpolationInterval": 1,
      "mealLookback": 3,
      "insulinLookback": 4,
      "cumulativeLookbackHours": 32
    },
    "6h": {
      "label": "6H",
      "pastHours": 4,
      "futureHours": 2,
      "tickInterval": 1,
      "tickFormat": "HH:mm",
      "interpolationInterval": 5,
      "mealLookback": 6,
      "insulinLookback": 6,
      "cumulativeLookbackHours": 32
    },
    "12h": {
      "label": "12H",
      "pastHours": 10,
      "futureHours": 2,
      "tickInterval": 2,
      "tickFormat": "HH:mm",
      "interpolationInterval": 10,
      "mealLookback": 12,
      "insulinLookback": 12,
      "cumulativeLookbackHours": 32
    },
    "24h": {
      "label": "24H",
      "pastHours": 20,
      "futureHours": 4,
      "tickInterval": 3,
      "tickFormat": "HH:mm",
      "interpolationInterval": 15,
      "mealLookback": 24,
      "insulinLookback": 24,
      "cumulativeLookbackHours": 32
    },
    "3d": {
      "label": "3D",
      "pastHours": 68,
      "futureHours": 4,
      "tickInterval": 6,
      "tickFormat": "MM/DD",
      "interpolationInterval": 30,
      "mealLookback": 72,
      "insulinLookback": 72,
      "cumulativeLookbackHours": 68
    },
    "week": {
      "label": "Week",
      "pastHours": 168,
      "futureHours": 0,
      "tickInterval": 24,
      "tickFormat": "DD/MM",
      "interpolationInterval": 15,
      "mealLookback": 168,
      "insulinLookback": 168,
      "cumulativeLookbackHours": 168
    },
    "month": {
      "label": "Month",
      "pastHours": 720,
      "futureHours": 0,
      "tickInterval": 72,
      "tickFormat": "DD/MM",
      "interpolationInterval": 30,
      "mealLookback": 720,
      "insulinLookback": 720,
      "cumulativeLookbackHours": 720
    }
  },
  "T1D_BG_CONSTANTS": {
    "recent_reading_threshold_min": 15,
    "max_reading_age_hours": 4,
    "max_reading_age_minutes": 240,
    "target_glucose_default": 100,
    "default_chart_interval_min": 1,
    "iob_lookback_hours": 48,
    "mob_lookback_hours": 12
  },
  "NET_EFFECT_THRESHOLDS": {
    "high_rising": 50,
    "rising": 20,
    "slightly_rising": 5,
    "stable_high": 5,
    "stable_low": -5,
    "slightly_falling": -5,
    "falling": -20,
    "rapidly_falling": -50
  },
  "TIMING_THRESHOLDS": {
    "min_active_carbs": 5,
    "max_active_carbs": 30,
    "high_iob_threshold": 2,
    "slow_meal_activity_threshold": 20
  },
  "CURVE_DESCRIPTIONS": {
    "gamma_very_steep": "Ultra-rapid (Sharp peak, heavy tails)",
    "gamma_steep": "Rapid-acting (Leptokurtic)",
    "gamma_moderate": "Regular insulin (Mesokurtic)",
    "gamma_standard": "Standard action",
    "gamma_broad": "Intermediate (Platykurtic)",
    "gamma_wide": "Wide distribution",
    "gamma_extended": "Extended action",
    "gamma_plateau": "Plateau effect",
    "sigmoid_plateau": "Steady plateau",
    "sigmoid_extended": "Extended plateau",
    "sigmoid_ultra_long": "Ultra-long plateau"
  },
  "MEAL_ABSORPTION_PROFILES": {
    "very_fast": {
      "onset_hours": 0.08,
      "peak_hours": 0.5,
      "duration_hours": 2.0,
      "curve_type": "gamma_steep",
      "shape_param": 2.5,
      "scale_param": 0.3,
      "description": "Simple sugars, glucose tablets - very rapid absorption"
    },
    "fast": {
      "onset_hours": 0.25,
      "peak_hours": 1.0,
      "duration_hours": 3.0,
      "curve_type": "gamma_moderate",
      "shape_param": 2.0,
      "scale_param": 0.5,
      "description": "Refined carbohydrates, white bread, juice - fast absorption"
    },
    "medium": {
      "onset_hours": 0.42,
      "peak_hours": 1.5,
      "duration_hours": 4.0,
      "curve_type": "gamma_standard",
      "shape_param": 1.8,
      "scale_param": 0.8,
      "description": "Mixed meals, whole grains - moderate absorption"
    },
    "slow": {
      "onset_hours": 0.75,
      "peak_hours": 2.5,
      "duration_hours": 5.5,
      "curve_type": "gamma_extended",
      "shape_param": 1.5,
      "scale_param": 1.2,
      "description": "High protein/fat meals, complex carbs - slow absorption"
    },
    "very_slow": {
      "onset_hours": 1.0,
      "peak_hours": 3.5,
      "duration_hours": 7.0,
      "curve_type": "gamma_plateau",
      "shape_param": 1.2,
      "scale_param": 1.8,
      "description": "Very high fat/fiber meals - very slow absorption"
    },
    "mixed": {
      "onset_hours": 0.25,
      "peak_hours": 2.0,
      "duration_hours": 6.0,
      "curve_type": "gamma_broad",
      "shape_param": 1.4,
      "scale_param": 1.4,
      "description": "Mixed fast + slow meal (pizza-effect) - biphasic absorption"
    }
  },
  "BASELINE_MODES": {
    "dynamic": {
      "label": "Dynamic (reading-based)",
      "description": "Derives the baseline from your latest BG reading by removing all cumulative meal and insulin effects since the daily reset. Most accurate when you have a recent reading."
    },
    "preset": {
      "label": "Preset 24-hour profile",
      "description": "Uses a clinically-modelled 24-hour circadian profile that captures the dawn phenomenon, overnight dip, and daytime plateau. Works without a recent reading and is stable across testing sessions."
    }
  },
  "DEFAULT_CIRCADIAN_PROFILE": {
    "anchors": [
      {
        "hour": 0,
        "value": 90.0
      },
      {
        "hour": 1,
        "value": 88.0
      },
      {
        "hour": 2,
        "value": 87.0
      },
      {
        "hour": 3,
        "value": 85.0
      },
      {
        "hour": 4,
        "value": 87.0
      },
      {
        "hour": 5,
        "value": 93.0
      },
      {
        "hour": 6,
        "value": 108.0
      },
      {
        "hour": 7,
        "value": 118.0
      },
      {
        "hour": 8,
        "value": 120.0
      },
      {
        "hour": 9,
        "value": 115.0
      },
      {
        "hour": 10,
        "value": 108.0
      },
      {
        "hour": 11,
        "value": 103.0
      },
      {
        "hour": 12,
        "value": 100.0
      },
      {
        "hour": 13,
        "value": 98.0
      },
      {
        "hour": 14,
        "value": 97.0
      },
      {
        "hour": 15,
        "value": 97.0
      },
      {
        "hour": 16,
        "value": 100.0
      },
      {
        "hour": 17,
        "value": 102.0
      },
      {
        "hour": 18,
        "value": 100.0
      },
      {
        "hour": 19,
        "value": 99.0
      },
      {
        "hour": 20,
        "value": 97.0
      },
      {
        "hour": 21,
        "value": 95.0
      },
      {
        "hour": 22,
        "value": 93.0
      },
      {
        "hour": 23,
        "value": 91.0
      }
    ],
    "source": "preset"
  },
  "BASELINE_HARD_MIN": 55.0,
  "BASELINE_HARD_MAX": 220.0,
  "ACTIVITY_INTENSITY_LEVELS": {
    "light": {
      "hr_fraction": 0.5,
      "label": "Light",
      "level": 0
    },
    "moderate": {
      "hr_fraction": 0.65,
      "label": "Moderate",
      "level": 1
    },
    "vigorous": {
      "hr_fraction": 0.8,
      "label": "Vigorous",
      "level": 2
    }
  },
  "HR_MODEL": {
    "tau_HR": 5.0,
    "tau_Z": 10.0,
    "tau_W": 90.0,
    "a": 0.05,
    "alpha": 0.0008,
    "max_sensitivity_boost": 0.6,
    "dt": 1.0,
    "acute_rate_per_min": 0.15,
    "hr_max_pop": 190.0,
    "hr_base_pop": 70.0,
    "z_reference_hr_reserve": 0.8
  },
  "INTENSITY_HR_FRACTION": {
    "light": 0.5,
    "moderate": 0.65,
    "vigorous": 0.8
  },
  "INTENSITY_PEAK_BOOST": {
    "light": 0.1,
    "moderate": 0.25,
    "vigorous": 0.4
  },
  "LEVEL_TO_INTENSITY": {
    "-2": null,
    "-1": null,
    "0": "light",
    "1": "moderate",
    "2": "vigorous"
  }
} as const;

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
(function validateAbsorptionConfig() {
  const knownMedTypes = new Set(
    Object.values(SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors ?? {})
      .map((m: any) => m?.type)
      .filter(Boolean)
  );
  if (knownMedTypes.size === 0) return; // constants not loaded yet — skip

  for (const [absorptionKey, config] of Object.entries(ABSORPTION_TO_INSULIN_CONFIG)) {
    for (const typeFilter of config.typeFilter ?? []) {
      if (!knownMedTypes.has(typeFilter)) {
        const msg =
          `[shared-constants] §M-5: ABSORPTION_TO_INSULIN_CONFIG["${absorptionKey}"]` +
          `.typeFilter contains unknown medication category "${typeFilter}".` +
          ` Known types: ${[...knownMedTypes].join(', ')}`;
        if (process.env.NODE_ENV === 'production') {
          console.warn(msg);
        } else {
          throw new Error(msg);
        }
      }
    }
  }
})();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export const convertToGrams = (amount: number, unit: string): number => {
  const volumeMeasurements = SHARED_CONSTANTS.VOLUME_MEASUREMENTS;
  const weightMeasurements = SHARED_CONSTANTS.WEIGHT_MEASUREMENTS;

  if (weightMeasurements[unit]) {
    return amount * weightMeasurements[unit].grams!;
  }

  if (volumeMeasurements[unit]) {
    return amount * volumeMeasurements[unit].ml!;
  }

  return amount;
};

export const convertToMl = (amount: number, unit: string): number => {
  const volumeMeasurements = SHARED_CONSTANTS.VOLUME_MEASUREMENTS;
  const weightMeasurements = SHARED_CONSTANTS.WEIGHT_MEASUREMENTS;

  if (volumeMeasurements[unit]) {
    return amount * volumeMeasurements[unit].ml!;
  }

  if (weightMeasurements[unit]) {
    return amount * weightMeasurements[unit].grams!;
  }

  return amount;
};

export const calculateHealthFactors = (
  diseases?: string[],
  medications?: string[]
): number => {
  let totalFactor = 1.0;

  if (diseases && diseases.length > 0) {
    diseases.forEach((disease) => {
      const diseaseFactor =
        SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.disease_factors[disease]?.factor || 1.0;
      totalFactor *= diseaseFactor;
    });
  }

  if (medications && medications.length > 0) {
    medications.forEach((med) => {
      const medFactor =
        SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors[med]?.factor || 1.0;
      totalFactor *= medFactor;
    });
  }

  return totalFactor;
};

export const getInsulinInfo = (
  insulinName: string
): (MedicationFactor & { name: string }) | null => {
  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  if (medicationFactors && medicationFactors[insulinName]) {
    return {
      ...medicationFactors[insulinName],
      name: insulinName,
    };
  }
  return null;
};

export const getMealAbsorptionProfile = (
  absorptionType: string
): (MealAbsorptionProfile & { type: string }) | null => {
  const profiles = SHARED_CONSTANTS.MEAL_ABSORPTION_PROFILES;
  if (profiles && profiles[absorptionType]) {
    return {
      ...profiles[absorptionType],
      type: absorptionType,
    };
  }
  return profiles ? { ...profiles['medium'], type: 'medium' } : null;
};

/**
 * Interpolate the circadian baseline at a fractional hour of day.
 */
export const getCircadianBaseline = (
  hourFloat: number,
  profile?: CircadianProfile
): number => {
  const anchors = profile?.anchors ?? SHARED_CONSTANTS.DEFAULT_CIRCADIAN_PROFILE.anchors;
  if (!anchors || anchors.length === 0) return 100;

  const h = ((hourFloat % 24) + 24) % 24;
  let lower: CircadianAnchor | null = null;
  let upper: CircadianAnchor | null = null;

  for (const anchor of anchors) {
    if (anchor.hour <= h) lower = anchor;
    if (upper === null && anchor.hour > h) upper = anchor;
  }

  if (lower === null) lower = anchors[anchors.length - 1];
  if (upper === null) upper = anchors[0];

  let loH = lower.hour;
  let hiH = upper.hour;
  if (hiH < loH) hiH += 24;
  if (loH === hiH) return lower.value;

  const t = (h - loH) / (hiH - loH);
  return Math.round((lower.value + t * (upper.value - lower.value)) * 10) / 10;
};

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
export const getCumulativeLookbackHours = (dailyResetHour: number = 7): number => {
  return Math.floor(dailyResetHour) + 24 + 1;
};

export const getActivityLevel = (value: number): ActivityLevel | null => {
  return SHARED_CONSTANTS.ACTIVITY_LEVELS.find((level) => level.value === value) || null;
};

export const getMealType = (value: string): MealType | null => {
  return SHARED_CONSTANTS.MEAL_TYPES.find((type) => type.value === value) || null;
};

export const getFoodCategory = (value: string): FoodCategory | null => {
  return SHARED_CONSTANTS.FOOD_CATEGORIES.find((cat) => cat.value === value) || null;
};

export const getTimeOfDayFactor = (hour: number): (TimeOfDayFactor & { key: string }) | null => {
  const factors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.time_of_day_factors;

  for (const [key, value] of Object.entries(factors)) {
    const [start, end] = value.hours;
    if (hour >= start && hour < end) {
      return { ...value, key };
    }
  }

  return null;
};

export const getInsulinTimingGuideline = (
  absorptionSpeed: string
): InsulinTimingGuideline | null => {
  const guidelines = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines;
  return guidelines[absorptionSpeed] || null;
};

export const getInsulinsByType = (): { [type: string]: { key: string; info: MedicationFactor }[] } => {
  const medications = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const grouped: { [type: string]: { key: string; info: MedicationFactor }[] } = {};

  Object.entries(medications).forEach(([key, value]) => {
    if (!grouped[value.type]) {
      grouped[value.type] = [];
    }
    grouped[value.type].push({ key, info: value });
  });

  return grouped;
};

// Export individual constants for convenience
export const {
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
} = SHARED_CONSTANTS;
