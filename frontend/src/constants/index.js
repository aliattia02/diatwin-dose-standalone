// frontend/src/constants/index.js
import {
  SHARED_CONSTANTS,
  convertToGrams,
  convertToMl,
  calculateHealthFactors,
  getInsulinInfo
} from './shared_constants';

// Export everything from SHARED_CONSTANTS
export const {
  MEASUREMENT_SYSTEMS,
  VOLUME_MEASUREMENTS,
  WEIGHT_MEASUREMENTS,
  DEFAULT_PATIENT_CONSTANTS,
  ACTIVITY_LEVELS,
  MEAL_TYPES,
  INSULIN_TYPES,
  FOOD_CATEGORIES,
  MEAL_TIMING_FACTORS,
  TIME_OF_DAY_FACTORS,
  DISEASE_FACTORS,
  MEDICATION_FACTORS
} = SHARED_CONSTANTS;

// Export utility functions
export { convertToGrams, convertToMl, calculateHealthFactors, getInsulinInfo };



