/**
 * Meal impact calculation utilities
 * Ported from frontend/src/utils/BG_Effect.js to TypeScript
 * 
 * @module utils/glucose/meal-impact
 */

import { 
  AbsorptionType, 
  MealImpactCurvePoint,
  MealNutrition
} from '../../types/meal.types';
import { PatientConstants, DEFAULT_PATIENT_CONSTANTS } from '../../types/constants.types';
import { 
  ABSORPTION_PROFILES, 
  ABSORPTION_MODIFIERS,
  ABSORPTION_TYPE_VALUES,
  ABSORPTION_VALUE_TO_TYPE,
  getAbsorptionDescription
} from '../../constants/absorption.constants';
import { calculateCarbEquivalents } from './carb-equivalents';
// TS-C-2: import canonical generateMealImpactCurve from meal-impact-curves
// instead of re-implementing it here. The glucose/index.ts barrel re-exports
// from meal-impact-curves.ts; this file must not shadow that export.
import { generateMealImpactCurve } from './meal-impact-curves';

// Re-export the description function for convenience
export { getAbsorptionDescription };
// Re-export the canonical curve function so existing consumers of this module
// that call generateMealImpactCurve via meal-impact still get the single
// implementation — removing the duplicate without breaking any import path.
export { generateMealImpactCurve };


/**
 * Calculate weighted absorption type for meals with multiple food items
 *
 * @param foodItems - Array of food items with carbs and absorption type
 * @returns Weighted absorption type based on carb content
 */
export function calculateWeightedAbsorptionType(
  foodItems: Array<{
    carbs: number;
    absorptionType: AbsorptionType;
  }>
): AbsorptionType {
  if (!foodItems || foodItems.length === 0) {
    return 'medium';
  }

  let totalWeight = 0;
  let weightedSum = 0;

  for (const item of foodItems) {
    const carbs = item.carbs || 0;
    if (carbs > 0) {
      const absorptionValue = ABSORPTION_TYPE_VALUES[item.absorptionType] ?? 3;
      weightedSum += absorptionValue * carbs;
      totalWeight += carbs;
    }
  }

  if (totalWeight === 0) {
    return 'medium';
  }

  const averageValue = Math.round(weightedSum / totalWeight);
  return ABSORPTION_VALUE_TO_TYPE[averageValue] || 'medium';
}

/**
 * Full meal impact calculation result
 */
export interface MealImpactResult {
  carbEquivalents: {
    totalCarbEquiv: number;
    carbsActual: number;
    proteinCarbEquiv: number;
    fatCarbEquiv: number;
    fiberReduction: number;
  };
  baseInsulin: number;
  adjustedInsulin: number;
  peakBgImpact: number;
  absorptionProfile: {
    type: AbsorptionType;
    factor: number;
    description: string;
  };
  timeCurve?: MealImpactCurvePoint[];
}

/**
 * Calculate complete meal impact including carb equivalents and optional time curve
 *
 * @param nutrition - Meal nutrition data
 * @param absorptionType - Absorption type for the meal
 * @param patientConstants - Patient-specific constants
 * @param options - Additional calculation options
 * @returns Complete meal impact result
 */
export function calculateMealImpact(
  nutrition: Partial<MealNutrition>,
  absorptionType: AbsorptionType = 'medium',
  patientConstants?: Partial<PatientConstants>,
  options?: {
    includeTimeCurve?: boolean;
    mealTimestamp?: number;
    durationHours?: number;
    intervalMinutes?: number;
  }
): MealImpactResult {
  const constants = patientConstants || DEFAULT_PATIENT_CONSTANTS;
  const {
    includeTimeCurve = false,
    mealTimestamp = Date.now(),
    durationHours = 6,
    intervalMinutes = 5
  } = options || {};

  // Calculate carb equivalents
  const carbEquivalents = calculateCarbEquivalents(nutrition, constants);

  // Get absorption factor
  const absorptionFactor = ABSORPTION_MODIFIERS[absorptionType] ?? 1.0;

  // Calculate base insulin dose
  const baseInsulin = carbEquivalents.totalCarbEquiv / (constants.insulin_to_carb_ratio ?? 10);
  const adjustedInsulin = baseInsulin * absorptionFactor;

  // Calculate peak BG impact
  const carbToBgFactor = constants.carb_to_bg_factor ?? 4.0;
  const peakBgImpact = carbEquivalents.totalCarbEquiv * carbToBgFactor * absorptionFactor;

  // Build result
  const result: MealImpactResult = {
    carbEquivalents,
    baseInsulin,
    adjustedInsulin,
    peakBgImpact,
    absorptionProfile: {
      type: absorptionType,
      factor: absorptionFactor,
      description: getAbsorptionDescription(absorptionType)
    }
  };

  // Generate time curve if requested
  if (includeTimeCurve) {
    result.timeCurve = generateMealImpactCurve(
      carbEquivalents.totalCarbEquiv,
      absorptionType,
      mealTimestamp,
      durationHours,
      intervalMinutes,
      carbToBgFactor,
      absorptionFactor
    );
  }

  return result;
}

export default {
  generateMealImpactCurve,
  calculateWeightedAbsorptionType,
  getAbsorptionDescription,
  calculateMealImpact
};