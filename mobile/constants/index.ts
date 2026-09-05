/**
 * Constants exports for mobile diabetes management platform
 * @module constants
 */

// Theme constants
export * from './theme';
export { default as theme } from './theme';

// Shared constants from backend (replaces imports from shared folder)
export * from './shared-constants';

// Re-export commonly used constants for convenience
export {
  SHARED_CONSTANTS,
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
} from './shared-constants';

// Re-export helper functions
export {
  convertToGrams,
  convertToMl,
  calculateHealthFactors,
  getInsulinInfo,
  getMealAbsorptionProfile,
  getActivityLevel,
  getMealType,
  getFoodCategory,
  getTimeOfDayFactor,
  getInsulinTimingGuideline,
  getInsulinsByType,
} from './shared-constants';

// Re-export types from shared-constants for convenience
export type {
  MeasurementSystems,
  Measurement,
  ActivityLevel,
  MealType,
  FoodCategory,
  InsulinTimingGuideline,
  TimeOfDayFactor,
  DiseaseFactor,
  MedicationFactor,
  MealAbsorptionProfile,
  PatientConstants,
  ViewModeConfig,
  T1DBGConstants,
  NetEffectThresholds,
  TimingThresholds,
  CurveDescription,
  CurveDescriptions,
} from './shared-constants';