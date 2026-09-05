/**
 * Carbohydrate Equivalents Calculation
 * Location: mobile/utils/glucose/carb-equivalents.ts
 *
 * Description: Calculate total carbohydrate equivalents from nutrition data
 *
 * Features:
 * - Protein and fat conversion to carb equivalents
 * - Fiber reduction calculation
 * - Blood glucose impact calculation
 * - Insulin dose calculation for carbs
 * - Correction dose calculation
 * - Total insulin dose with adjustment factors
 */

// Types
import type { MealNutrition, CarbEquivalentsResult } from '@/types/meal.types';
import type { PatientConstants } from '@/types/constants.types';

// Constants
import { DEFAULT_PATIENT_CONSTANTS } from '@/constants';

/**
 * Calculate total carbohydrate equivalents from nutrition data
 * This is the core calculation shared between web and mobile
 *
 * @param nutrition - Nutrition data containing carbs, protein, fat, fiber
 * @param patientConstants - Patient-specific constants (or defaults)
 * @returns Carbohydrate equivalents breakdown
 */
export function calculateCarbEquivalents(
  nutrition: Partial<MealNutrition> | null | undefined,
  patientConstants?: Partial<PatientConstants>
): CarbEquivalentsResult {
  if (!nutrition) {
    return {
      totalCarbEquiv: 0,
      carbsActual: 0,
      proteinCarbEquiv: 0,
      fatCarbEquiv: 0,
      fiberReduction: 0
    };
  }

  // Extract nutritional values (handle both naming conventions)
  const carbs = nutrition.totalCarbs ?? nutrition.carbs ?? 0;
  const protein = nutrition.totalProtein ?? nutrition.protein ?? 0;
  const fat = nutrition.totalFat ?? nutrition.fat ?? 0;
  const fiber = nutrition.fiber ?? 0;

  // Get conversion factors from patient constants or use defaults
  const constants = patientConstants || DEFAULT_PATIENT_CONSTANTS;
  const proteinFactor = constants.protein_factor ?? 0.5;
  const fatFactor = constants.fat_factor ?? 0.2;
  // FIBER_FACTOR = 1.0: dietary fiber does not raise BG and is fully
  // subtracted from gross carbs (ADA standard: net carbs = carbs − fiber).
  // Previously 0.1 — same bug fixed in meal-pharmacodynamics.ts (Bug 6).
  // This path is used by calculateUnifiedMealImpact() and
  // calculateTotalInsulinDose(); both were still computing wrong net carbs
  // for high-fiber foods (beans, whole grains, vegetables).
  const fiberFactor = 1.0;

  // Calculate protein and fat carb equivalents
  const proteinCarbEquiv = protein * proteinFactor;
  const fatCarbEquiv = fat * fatFactor;
  const fiberReduction = fiber * fiberFactor;

  // Calculate total carb equivalents
  const totalCarbEquiv = Math.max(0, carbs + proteinCarbEquiv + fatCarbEquiv - fiberReduction);

  return {
    totalCarbEquiv,
    carbsActual: carbs,
    proteinCarbEquiv,
    fatCarbEquiv,
    fiberReduction
  };
}

/**
 * Calculate blood glucose impact from carbohydrate equivalents
 *
 * @param carbEquivalents - Total carbohydrate equivalents
 * @param carbToBgFactor - Factor to convert carbs to BG impact (default 4.0 mg/dL per gram)
 * @returns Blood glucose impact in mg/dL
 */
export function calculateBgImpact(
  carbEquivalents: number,
  carbToBgFactor: number = 4.0
): number {
  if (carbEquivalents <= 0) return 0;
  return carbEquivalents * carbToBgFactor;
}

/**
 * Calculate insulin dose needed for carbohydrate equivalents
 *
 * @param carbEquivalents - Total carbohydrate equivalents
 * @param insulinToCarbRatio - Insulin to carb ratio (e.g., 10 means 1 unit per 10g carbs)
 * @returns Recommended insulin dose in units
 */
export function calculateInsulinForCarbs(
  carbEquivalents: number,
  insulinToCarbRatio: number = 10
): number {
  if (carbEquivalents <= 0 || insulinToCarbRatio <= 0) return 0;
  return carbEquivalents / insulinToCarbRatio;
}

/**
 * Calculate correction dose for blood glucose above target
 *
 * @param currentBg - Current blood glucose in mg/dL
 * @param targetBg - Target blood glucose in mg/dL
 * @param correctionFactor - Insulin sensitivity factor (how much 1 unit lowers BG)
 * @returns Correction dose in units (0 if BG is at or below target)
 */
export function calculateCorrectionDose(
  currentBg: number,
  targetBg: number,
  correctionFactor: number = 40
): number {
  if (currentBg <= targetBg || correctionFactor <= 0) return 0;
  return (currentBg - targetBg) / correctionFactor;
}

/**
 * Calculate total insulin dose combining carb coverage and correction
 *
 * @param options - Calculation options
 * @returns Total recommended insulin dose
 */
export function calculateTotalInsulinDose(options: {
  carbEquivalents: number;
  currentBg?: number;
  targetBg?: number;
  insulinToCarbRatio?: number;
  correctionFactor?: number;
  activityFactor?: number;
  mealTimingFactor?: number;
}): {
  totalDose: number;
  carbDose: number;
  correctionDose: number;
  adjustedDose: number;
  factors: {
    activity: number;
    mealTiming: number;
  };
} {
  const {
    carbEquivalents,
    currentBg,
    targetBg = 100,
    insulinToCarbRatio = 10,
    correctionFactor = 40,
    activityFactor = 1.0,
    mealTimingFactor = 1.0
  } = options;

  // Calculate component doses
  const carbDose = calculateInsulinForCarbs(carbEquivalents, insulinToCarbRatio);
  const correctionDose = currentBg !== undefined
    ? calculateCorrectionDose(currentBg, targetBg, correctionFactor)
    : 0;

  // Calculate base total
  const baseDose = carbDose + correctionDose;

  // Apply adjustment factors
  const adjustedDose = baseDose * activityFactor * mealTimingFactor;
  const totalDose = Math.max(0, Math.round(adjustedDose * 10) / 10); // Round to 0.1 units

  return {
    totalDose,
    carbDose,
    correctionDose,
    adjustedDose,
    factors: {
      activity: activityFactor,
      mealTiming: mealTimingFactor
    }
  };
}

export default {
  calculateCarbEquivalents,
  calculateBgImpact,
  calculateInsulinForCarbs,
  calculateCorrectionDose,
  calculateTotalInsulinDose
};