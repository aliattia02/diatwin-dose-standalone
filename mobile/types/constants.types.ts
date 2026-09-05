/**
 * Constants type definitions for NATIVE diabetes management platform
 * Matching backend ConstantConfig structure from backend/constants.py
 * @module types/constants
 */

import { AbsorptionType, MealType } from './meal.types';
import { InsulinPharmacokinetics } from './insulin.types';
import { SHARED_CONSTANTS } from '@/constants/shared-constants';

/**
 * Activity coefficients matching backend activity_coefficients structure
 * Keys are string numbers (-2 to 2), values are multipliers
 */
export interface ActivityCoefficients {
  '-2': number;
  '-1': number;
  '0': number;
  '1': number;
  '2': number;
  [key: string]: number;
}

/**
 * Absorption modifiers matching backend absorption_modifiers
 */
export interface AbsorptionModifiers {
  very_slow: number;
  slow: number;
  medium: number;
  fast: number;
  very_fast: number;
  [key: string]: number;
}

/**
 * Insulin timing guideline for a specific absorption type
 */
export interface InsulinTimingGuideline {
  timing_minutes: number;
  description: string;
}

/**
 * Insulin timing guidelines for all absorption types
 */
export interface InsulinTimingGuidelines {
  very_slow: InsulinTimingGuideline;
  slow: InsulinTimingGuideline;
  medium: InsulinTimingGuideline;
  fast: InsulinTimingGuideline;
  very_fast: InsulinTimingGuideline;
  [key: string]: InsulinTimingGuideline;
}

/**
 * Meal timing factors matching backend meal_timing_factors
 */
export interface MealTimingFactors {
  breakfast: number;
  lunch: number;
  dinner: number;
  snack: number;
  [key: string]: number;
}

/**
 * Time of day factor configuration
 */
export interface TimeOfDayFactor {
  hours: [number, number];
  factor: number;
  description: string;
}

/**
 * Time of day factors matching backend time_of_day_factors
 */
export interface TimeOfDayFactors {
  early_morning: TimeOfDayFactor;
  morning: TimeOfDayFactor;
  daytime: TimeOfDayFactor;
  late_night: TimeOfDayFactor;
  [key: string]: TimeOfDayFactor;
}

/**
 * Disease factor configuration
 */
export interface DiseaseFactor {
  factor: number;
  description: string;
}

/**
 * Disease factors matching backend disease_factors
 */
export interface DiseaseFactors {
  type_1_diabetes: DiseaseFactor;
  type_2_diabetes: DiseaseFactor;
  gestational_diabetes: DiseaseFactor;
  insulin_resistance: DiseaseFactor;
  thyroid_disorders: DiseaseFactor;
  celiac_disease: DiseaseFactor;
  [key: string]: DiseaseFactor;
}

/**
 * Medication factor configuration
 * Note: duration_based is optional to support both insulin and non-insulin medications
 */
export interface MedicationFactor extends InsulinPharmacokinetics {
  factor: number;
  description: string;
  duration_based?: boolean;
  brand_names?: string[];
}

/**
 * Medication factors including insulin types from S3 Guidelines
 */
export interface MedicationFactors {
  [key: string]: MedicationFactor;
}

/**
 * Meal absorption profile matching backend MEAL_ABSORPTION_PROFILES entries
 */
export interface MealAbsorptionProfile {
  description: string;
  peak_minutes: number;
  duration_minutes: number;
  curve_shape: string;
  gi_range?: [number, number];
}

/**
 * Complete patient constants interface matching backend ConstantConfig
 */
export interface PatientConstants {
  /** Insulin to carb ratio (e.g., 1 unit covers 10g carbs) */
  insulin_to_carb_ratio: number;
  /** Correction factor / ISF (e.g., 1 unit lowers BG by 40 mg/dL) */
  correction_factor: number;
  /** Target glucose in mg/dL */
  target_glucose: number;
  /** Protein factor for carb equivalents */
  protein_factor: number;
  /** Fat factor for carb equivalents */
  fat_factor: number;
  /** Carb to BG factor (e.g., 1g carb raises BG by 4 mg/dL) */
  carb_to_bg_factor: number;
  /** Alias used by the HR ODE activity model — kept in sync with carb_to_bg_factor */
  carb_to_bg_ratio?: number;
  /** Patient body weight in kg — used for allometric BG-drop scaling: drop × (70/kg)^0.25 */
  weight_kg?: number;
  /** Patient resting heart rate in bpm — used to normalise wearable HR traces */
  hr_base?: number;
  /** Patient maximum heart rate in bpm — used to normalise wearable HR traces */
  hr_max?: number;
  /** Hour of day (0-23) when daily cumulative effects reset (default: 7 for 7 AM) */
  daily_reset_hour: number;
  /** Patient timezone offset from UTC in minutes (e.g., -300 for EST) */
  timezone_offset_minutes: number;
  /**
   * Baseline derivation mode.
   * 'dynamic' — subtract today's cumulative effects from the latest BG reading.
   * 'preset'  — look up the 24-hour circadian profile at the current hour.
   */
  baseline_mode: 'dynamic' | 'preset';
  /** Circadian baseline profile used when baseline_mode === 'preset' */
  circadian_profile: {
    anchors: Array<{ hour: number; value: number }>;
    source?: 'preset' | 'custom';
  };
  /** Activity level coefficients */
  activity_coefficients: ActivityCoefficients;
  /** Absorption rate modifiers */
  absorption_modifiers: AbsorptionModifiers;
  /** Insulin timing guidelines by absorption type */
  insulin_timing_guidelines: InsulinTimingGuidelines;
  /** Meal timing factors */
  meal_timing_factors: MealTimingFactors;
  /** Time of day factors */
  time_of_day_factors: TimeOfDayFactors;
  /** Disease factors */
  disease_factors: DiseaseFactors;
  /** Meal absorption profiles by absorption type key */
  meal_absorption_profiles: { [key: string]: MealAbsorptionProfile };
  /** Medication factors including insulin types */
  medication_factors: MedicationFactors;
}

/**
 * Default patient constants — sourced from SHARED_CONSTANTS so there is a
 * single source of truth shared with constants.py (via shared-constants.ts).
 * Never hardcode values here; update shared-constants.ts instead.
 */
export const DEFAULT_PATIENT_CONSTANTS: PatientConstants =
  SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS as PatientConstants;

/**
 * Volume measurement definition
 */
export interface VolumeMeasurement {
  ml: number;
  display_name: string;
}

/**
 * Weight measurement definition
 */
export interface WeightMeasurement {
  grams: number;
  display_name: string;
}

/**
 * Measurement systems
 */
export interface MeasurementSystems {
  VOLUME: 'volume';
  WEIGHT: 'weight';
}

/**
 * Meal type option for UI
 */
export interface MealTypeOption {
  value: MealType;
  label: string;
}

/**
 * Food category option for UI
 */
export interface FoodCategoryOption {
  value: string;
  label: string;
}