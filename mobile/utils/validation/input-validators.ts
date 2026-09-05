/**
 * Input Validation Utilities
 * Location: mobile/utils/validation/input-validators.ts
 *
 * Description: Core input validation utilities for diabetes data (glucose, insulin, meals)
 *
 * Features:
 * - Blood glucose reading validation with limits
 * - Insulin dose validation with safety checks
 * - Meal entry and food item validation
 * - Carbohydrate value validation
 * - Comprehensive error and warning messages
 */

// Types
import type { GlucoseReading } from '@/types/glucose.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { MealFoodEntry } from '@/types/meal.types';

/**
 * Validation result with error and warning details
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Glucose reading validation limits (mg/dL)
 */
export const GLUCOSE_LIMITS = {
  MIN: 20,    // Minimum physiologically possible
  MAX: 600,   // Maximum physiologically possible
  LOW_WARNING: 70,   // Warning threshold for low
  HIGH_WARNING: 250  // Warning threshold for high
} as const;

/**
 * Insulin dose validation limits (units)
 */
export const INSULIN_LIMITS = {
  MIN: 0,
  MAX: 100,  // Maximum reasonable single dose
  HIGH_WARNING: 30 // Warning threshold for high dose
} as const;

/**
 * Validate a blood glucose reading
 *
 * @param value - Blood glucose value in mg/dL
 * @returns Validation result with any errors or warnings
 */
export function validateGlucoseReading(value: number | null | undefined): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (value === null || value === undefined) {
    errors.push('Blood glucose value is required');
    return { isValid: false, errors, warnings };
  }

  if (typeof value !== 'number' || isNaN(value)) {
    errors.push('Blood glucose value must be a number');
    return { isValid: false, errors, warnings };
  }

  if (value < GLUCOSE_LIMITS.MIN) {
    errors.push(`Blood glucose value ${value} mg/dL is below minimum (${GLUCOSE_LIMITS.MIN} mg/dL)`);
  }

  if (value > GLUCOSE_LIMITS.MAX) {
    errors.push(`Blood glucose value ${value} mg/dL exceeds maximum (${GLUCOSE_LIMITS.MAX} mg/dL)`);
  }

  if (errors.length === 0) {
    if (value < GLUCOSE_LIMITS.LOW_WARNING) {
      warnings.push(`Blood glucose ${value} mg/dL is low. Consider treating hypoglycemia.`);
    } else if (value > GLUCOSE_LIMITS.HIGH_WARNING) {
      warnings.push(`Blood glucose ${value} mg/dL is high. Consider correction dose.`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate an insulin dose
 *
 * @param dose - Insulin dose in units
 * @returns Validation result with any errors or warnings
 */
export function validateInsulinDose(dose: number | null | undefined): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (dose === null || dose === undefined) {
    errors.push('Insulin dose is required');
    return { isValid: false, errors, warnings };
  }

  if (typeof dose !== 'number' || isNaN(dose)) {
    errors.push('Insulin dose must be a number');
    return { isValid: false, errors, warnings };
  }

  if (dose < INSULIN_LIMITS.MIN) {
    errors.push('Insulin dose cannot be negative');
  }

  if (dose > INSULIN_LIMITS.MAX) {
    errors.push(`Insulin dose ${dose} units exceeds maximum (${INSULIN_LIMITS.MAX} units)`);
  }

  if (errors.length === 0 && dose > INSULIN_LIMITS.HIGH_WARNING) {
    warnings.push(`Insulin dose ${dose} units is unusually high. Please verify.`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate a complete insulin dose record
 *
 * @param doseRecord - Complete insulin dose record
 * @returns Validation result with any errors or warnings
 */
export function validateInsulinDoseRecord(
  doseRecord: Partial<InsulinDose> | null | undefined
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!doseRecord) {
    errors.push('Insulin dose record is required');
    return { isValid: false, errors, warnings };
  }

  // Validate dose amount
  const doseValidation = validateInsulinDose(doseRecord.dose);
  errors.push(...doseValidation.errors);
  warnings.push(...doseValidation.warnings);

  // Validate insulin type
  if (!doseRecord.insulinType || doseRecord.insulinType.trim() === '') {
    errors.push('Insulin type is required');
  }

  // Validate administration time
  if (!doseRecord.administrationTime) {
    errors.push('Administration time is required');
  } else {
    const adminTime = new Date(doseRecord.administrationTime);
    if (isNaN(adminTime.getTime())) {
      errors.push('Administration time is not a valid date');
    } else {
      // Check if time is in the future (more than 5 minutes)
      const now = new Date();
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
      if (adminTime > fiveMinutesFromNow) {
        warnings.push('Administration time is in the future');
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate a meal food entry
 *
 * @param entry - Meal food entry
 * @returns Validation result with any errors or warnings
 */
export function validateMealEntry(
  entry: Partial<MealFoodEntry> | null | undefined
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!entry) {
    errors.push('Meal entry is required');
    return { isValid: false, errors, warnings };
  }

  // Validate food name
  if (!entry.name || entry.name.trim() === '') {
    errors.push('Food name is required');
  }

  // Validate portion
  if (!entry.portion) {
    errors.push('Portion information is required');
  } else {
    if (typeof entry.portion.amount !== 'number' || entry.portion.amount <= 0) {
      errors.push('Portion amount must be a positive number');
    }
    if (!entry.portion.unit || entry.portion.unit.trim() === '') {
      errors.push('Portion unit is required');
    }
  }

  // Validate nutrition details exist
  if (!entry.details) {
    warnings.push('Nutrition details are missing');
  } else {
    // Check for reasonable carb values
    if (typeof entry.details.carbs === 'number') {
      if (entry.details.carbs < 0) {
        errors.push('Carbohydrate value cannot be negative');
      } else if (entry.details.carbs > 500) {
        warnings.push('Carbohydrate value seems unusually high');
      }
    }

    // Check for reasonable protein values
    if (typeof entry.details.protein === 'number' && entry.details.protein < 0) {
      errors.push('Protein value cannot be negative');
    }

    // Check for reasonable fat values
    if (typeof entry.details.fat === 'number' && entry.details.fat < 0) {
      errors.push('Fat value cannot be negative');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate a complete meal
 *
 * @param meal - Meal data
 * @returns Validation result with any errors or warnings
 */
export function validateMeal(meal: {
  mealType?: string;
  timestamp?: number | string;
  foodItems?: Partial<MealFoodEntry>[];
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!meal) {
    errors.push('Meal data is required');
    return { isValid: false, errors, warnings };
  }

  // Validate meal type
  const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
  if (!meal.mealType || !validMealTypes.includes(meal.mealType)) {
    errors.push('Valid meal type is required (breakfast, lunch, dinner, or snack)');
  }

  // Validate timestamp
  if (!meal.timestamp) {
    errors.push('Meal timestamp is required');
  } else {
    const mealTime = new Date(meal.timestamp);
    if (isNaN(mealTime.getTime())) {
      errors.push('Meal timestamp is not a valid date');
    }
  }

  // Validate food items
  if (!meal.foodItems || !Array.isArray(meal.foodItems) || meal.foodItems.length === 0) {
    errors.push('At least one food item is required');
  } else {
    meal.foodItems.forEach((item, index) => {
      const itemValidation = validateMealEntry(item);
      itemValidation.errors.forEach(err => {
        errors.push(`Food item ${index + 1}: ${err}`);
      });
      itemValidation.warnings.forEach(warn => {
        warnings.push(`Food item ${index + 1}: ${warn}`);
      });
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate carbohydrate value
 *
 * @param carbs - Carbohydrate value in grams
 * @returns Validation result
 */
export function validateCarbs(carbs: number | null | undefined): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (carbs === null || carbs === undefined) {
    errors.push('Carbohydrate value is required');
    return { isValid: false, errors, warnings };
  }

  if (typeof carbs !== 'number' || isNaN(carbs)) {
    errors.push('Carbohydrate value must be a number');
    return { isValid: false, errors, warnings };
  }

  if (carbs < 0) {
    errors.push('Carbohydrate value cannot be negative');
  }

  if (carbs > 500) {
    warnings.push('Carbohydrate value seems unusually high');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

export default {
  validateGlucoseReading,
  validateInsulinDose,
  validateInsulinDoseRecord,
  validateMealEntry,
  validateMeal,
  validateCarbs,
  GLUCOSE_LIMITS,
  INSULIN_LIMITS
};