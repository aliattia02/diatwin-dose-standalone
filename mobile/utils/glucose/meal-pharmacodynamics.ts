/**
 * Meal Pharmacodynamics
 * Meal absorption modeling using gamma distribution curves
 * Ports logic from backend/utils/pharmacodynamics.py
 *
 * @module utils/glucose/meal-pharmacodynamics
 */

import type { Meal, MealFoodEntry } from '../../types/meal.types';
import type { PatientConstants } from '../../types/constants.types';
import type { PharmacodynamicProfile } from '../../types/pharmacodynamics.types';
import type { AbsorptionType } from '../../types/meal.types';
import type { MealAbsorptionProfile } from '../../constants/shared-constants';
import { MEAL_ABSORPTION_PROFILES, DEFAULT_PATIENT_CONSTANTS } from '../../constants/shared-constants';
import { getDailyResetTime as timeManagerDailyReset } from '@/utils/time/TimeManager';

/**
 * ============================================================================
 * PROFILE CONVERSION HELPERS
 * Convert between snake_case (MealAbsorptionProfile from constants) and
 * camelCase (PharmacodynamicProfile used by calculation functions)
 * ============================================================================
 */

/**
 * Convert a MealAbsorptionProfile (snake_case) to a PharmacodynamicProfile (camelCase)
 * Used when passing MEAL_ABSORPTION_PROFILES entries to calculation functions.
 * Accepts either format and returns the camelCase version.
 */
export function toPharmacodynamicProfile(
  profile: MealAbsorptionProfile | PharmacodynamicProfile | Record<string, any>
): PharmacodynamicProfile {
  // FIX (Bug 3 defence): guard against undefined/null being passed in.
  // This can happen when absorptionProfiles[absorptionType] returns undefined
  // because the key was invalid. Return a safe 'medium' default.
  if (!profile || typeof profile !== 'object') {
    return {
      onsetHours: 0.42,
      peakHours: 1.5,
      durationHours: 4.0,
      curveType: 'gamma_standard',
      shapeParam: 1.8,
      scaleParam: 0.8,
    };
  }
  // Already in camelCase format
  if ('onsetHours' in profile && typeof (profile as any).onsetHours === 'number') {
    return profile as PharmacodynamicProfile;
  }
  // Convert from snake_case (MealAbsorptionProfile)
  const p = profile as Record<string, any>;
  return {
    onsetHours: p.onset_hours ?? p.onsetHours ?? 0.25,
    peakHours: p.peak_hours ?? p.peakHours ?? 1.5,
    durationHours: p.duration_hours ?? p.durationHours ?? 4.0,
    curveType: p.curve_type ?? p.curveType ?? 'gamma_standard',
    shapeParam: p.shape_param ?? p.shapeParam ?? 2.0,
    scaleParam: p.scale_param ?? p.scaleParam ?? 1.0,
  };
}

/**
 * ============================================================================
 * TIMESTAMP PARSING
 * ============================================================================
 */

/**
 * Parse a meal timestamp to epoch milliseconds, UTC-safe.
 *
 * The backend stores timestamps in UTC but frequently omits the 'Z' suffix,
 * and `processContextMealsForChart` converts them to numbers before they get
 * here, so the same field arrives in several shapes:
 *
 *   number            already UTC ms
 *   "1772366400000"   numeric string — `new Date(s)` gives Invalid Date
 *   "...T12:00:00Z"   zone-qualified
 *   "...T12:00:00"    bare ISO — `new Date(s)` reads it as *device-local*
 *   "... 12:00:00"    space-separated, no zone
 *
 * Returns NaN for anything unparseable so callers can drop the record rather
 * than silently mis-timing it.
 *
 * FIX (D10): this logic previously existed only inside
 * calculateStackedMealEffect's reset guard, while calculateMealActivity and
 * isMealActive did a plain `new Date(meal.timestamp)` on the same field. A
 * numeric string therefore produced hoursSinceMeal = NaN, and because
 * `NaN < 0` is false the meal fell into the *expired* branch and was reported
 * fully absorbed; a bare ISO string shifted every absorption figure by the
 * device's UTC offset. One parser, used everywhere, is the fix.
 */
export function parseMealTimestamp(ts: unknown): number {
  if (typeof ts === 'number') return ts;                      // already UTC ms
  if (ts instanceof Date) return ts.getTime();
  if (ts === null || ts === undefined || ts === '') return NaN;

  const s = String(ts);
  if (/^\d+$/.test(s)) return parseInt(s, 10);                 // numeric string
  const hasZone = s.endsWith('Z') || s.includes('+') || /T.*-\d{2}:\d{2}$/.test(s);
  return hasZone ? new Date(s).getTime() : new Date(s.replace(' ', 'T') + 'Z').getTime();
}

/**
 * ============================================================================
 * CARB EXTRACTION FROM MEALS
 * Handles multiple data structures: calculation_summary, nutrition, foodItems
 * Matches backend logic in pharmacodynamics.py::calculate_meal_active_carbs()
 * ============================================================================
 */

/**
 * Extract total carb equivalents from a meal.
 * Handles the case where nutrition.totalCarbEquiv is not populated
 * and data is only in the foodItems array.
 *
 * Fallback chain (matches backend):
 * 1. calculation_summary.total_carb_equiv
 * 2. nutrition.totalCarbEquiv
 * 3. nutrition.totalCarbs / nutrition.carbs (+ protein/fat conversion)
 * 4. Computed from foodItems array
 *
 * @param meal - Meal document
 * @param proteinFactor - Protein to carb equiv factor (default 0.5)
 * @param fatFactor - Fat to carb equiv factor (default 0.2)
 * @returns Total carb equivalents
 */
export function getTotalCarbsFromMeal(
  meal: Meal,
  proteinFactor: number = 0.5,
  fatFactor: number = 0.2
): number {
  // 1. calculation_summary.total_carb_equiv (pre-computed by backend)
  if (meal.calculation_summary?.total_carb_equiv && meal.calculation_summary.total_carb_equiv > 0) {
    return meal.calculation_summary.total_carb_equiv;
  }

  // 2. nutrition.totalCarbEquiv (pre-computed)
  if (meal.nutrition?.totalCarbEquiv && meal.nutrition.totalCarbEquiv > 0) {
    return meal.nutrition.totalCarbEquiv;
  }

  // 3. Compute from nutrition raw values (matches backend fallback)
  const nutritionCarbs = meal.nutrition?.totalCarbs ?? meal.nutrition?.carbs ?? 0;
  const nutritionProtein = meal.nutrition?.totalProtein ?? meal.nutrition?.protein ?? 0;
  const nutritionFat = meal.nutrition?.totalFat ?? meal.nutrition?.fat ?? 0;
  const fromNutrition = nutritionCarbs + nutritionProtein * proteinFactor + nutritionFat * fatFactor;

  if (fromNutrition > 0) {
    return fromNutrition;
  }

  // 4. Compute from foodItems array (critical fallback when nutrition is not populated)
  if (meal.foodItems && Array.isArray(meal.foodItems) && meal.foodItems.length > 0) {
    return computeCarbEquivFromFoodItems(meal.foodItems, proteinFactor, fatFactor);
  }

  return 0;
}

/**
 * Compute total carb equivalents from foodItems array.
 * Each food item has details with carbs, protein, fat per serving,
 * and a portion with amount and unit.
 *
 * @param foodItems - Array of food entries in the meal
 * @param proteinFactor - Protein to carb equiv factor
 * @param fatFactor - Fat to carb equiv factor
 * @returns Total carb equivalents
 */
// FIBER_FACTOR = 1.0: dietary fiber does not raise BG and is fully subtracted
// from gross carbs when computing net carb equivalents for dosing. This matches
// standard T1D clinical practice (ADA / T1D Exchange: net carbs = carbs − fiber).
// Previously 0.1 (no physiological basis — understated net carbs by up to 54%
// for high-fiber foods such as legumes, whole grains, and vegetables).
const FIBER_FACTOR = 1.0;

function computeCarbEquivFromFoodItems(
  foodItems: MealFoodEntry[],
  proteinFactor: number,
  fatFactor: number
): number {
  let totalCarbEquiv = 0;

  for (const item of foodItems) {
    // ✅ FIX: Try both structures
    // First try details (preferred structure)
    const details = item.details;

    // Extract nutrients from either structure
    const carbs = details?.carbs ?? item.carbs ?? 0;           // ✅ ADDED fallback to item.carbs
    const protein = details?.protein ?? item.protein ?? 0;     // ✅ ADDED fallback to item.protein
    const fat = details?.fat ?? item.fat ?? 0;                 // ✅ ADDED fallback to item.fat
    const fiber = details?.fiber ?? item.fiber ?? 0;           // ✅ ADDED fallback to item.fiber

    // Carb equivalents: carbs + protein*factor + fat*factor - fiber*FIBER_FACTOR
    const itemCarbEquiv = carbs + protein * proteinFactor + fat * fatFactor - fiber * FIBER_FACTOR;
    totalCarbEquiv += Math.max(0, itemCarbEquiv);
  }

  return totalCarbEquiv;
}

/**
 * ============================================================================
 * GAMMA DISTRIBUTION CALCULATIONS
 * Core mathematical functions for meal absorption modeling
 * Ports: backend/utils/pharmacodynamics.py::calculate_gamma_absorption()
 * ============================================================================
 */

/**
 * Calculate gamma distribution probability density function value
 *
 * Formula: f(t; k, θ) = t^(k-1) * e^(-t/θ)
 *
 * @param t - Normalized time value (0-1)
 * @param k - Shape parameter (controls curve sharpness)
 * @param theta - Scale parameter (controls curve width)
 * @returns Raw gamma PDF value
 */
function calculateGammaValue(t: number, k: number, theta: number): number {
  if (t <= 0) return 0;

  try {
    const logValue = (k - 1) * Math.log(t) - (t / theta);
    return Math.exp(logValue);
  } catch (error) {
    return Math.pow(t, k - 1) * Math.exp(-t / theta);
  }
}

/**
 * Calculate meal absorption activity using gamma distribution
 * Direct port of: pharmacodynamics.py::calculate_gamma_absorption()
 *
 * Exported for the cross-language parity harness (case family `meal_activity`)
 * and for the property tests in `mobile/__tests__/meal-pharmacodynamics.test.ts`.
 * Behaviour is unchanged; only the visibility differs.
 *
 * @param hoursSinceMeal - Hours elapsed since meal consumption
 * @param profile - Pharmacodynamic profile with gamma parameters
 * @returns Activity percentage (0-100)
 */
export function calculateGammaAbsorption(
  hoursSinceMeal: number,
  profile: PharmacodynamicProfile
): number {
  const {
    onsetHours = 0.25,
    peakHours = 1.5,
    durationHours = 4.0,
    shapeParam = 2.0,
    scaleParam = 1.0,
  } = profile;

  // Outside active duration
  if (hoursSinceMeal < 0 || hoursSinceMeal > durationHours) {
    return 0.0;
  }

  // D21c: no absorption before gastric emptying completes.
  //
  // This used to ramp linearly to 5, and the gamma branch below starts at ~0
  // because t^(k-1) -> 0 for every k > 1. So absorption rate *fell* by a full
  // 5 percentage points at the instant onset completed — the opposite of the
  // physiology onsetHours describes. Returning 0 makes the curve continuous
  // at onset: before emptying is done, carbohydrate has not reached the
  // absorptive surface.
  if (hoursSinceMeal < onsetHours) {
    return 0.0;
  }

  // Main absorption phase
  const t = hoursSinceMeal - onsetHours;
  const tPeak = peakHours - onsetHours;
  const tDuration = durationHours - onsetHours;

  // Normalize time to [0, 1] range
  const normalizedT = t / tDuration;
  const normalizedPeak = tPeak / tDuration;

  if (normalizedT <= 0) return 0.0;

  // Calculate gamma parameters
  const k = shapeParam;
  const theta = scaleParam * normalizedPeak;

  // D21a: normalise by the curve's true maximum, not by its value at
  // peakHours.
  //
  // The density x^(k-1) * exp(-x/theta) peaks at x = (k-1)*theta. Dividing by
  // its value at normalizedPeak instead only coincides when
  // (k-1)*scaleParam === 1, which holds for none of the shipped profiles — so
  // the ratio exceeded 1 either side of the true mode and Math.min(100, ...)
  // clamped it. Between 18.6% and 38.5% of every absorption window sat at
  // exactly 100, carrying no information at all.
  //
  // NOTE (provisional, 2026-09-05): peakHours still names the normalisation
  // point rather than the mode. Reparameterising the profiles so peakHours IS
  // the mode is a separate decision — see the pre-ML audit §6.
  let mode = k > 1.0 ? (k - 1.0) * theta : 0.0;
  mode = Math.min(Math.max(mode, 1e-12), 1.0);

  // Calculate gamma values
  const activity = calculateGammaValue(normalizedT, k, theta);
  const peakActivity = calculateGammaValue(mode, k, theta);

  // Normalize to 100% at the true peak
  let normalizedActivity = 0;
  if (peakActivity > 0) {
    normalizedActivity = (activity / peakActivity) * 100;
  }

  return Math.min(100, Math.max(0, normalizedActivity));
}

/**
 * Calculate absorbed fraction using numerical integration
 * Direct port of: pharmacodynamics.py::calculate_absorbed_fraction()
 *
 * @param hoursSinceMeal - Time elapsed since meal
 * @param profile - Pharmacodynamic profile
 * @param steps - Integration steps (default: 100)
 * @returns Absorbed fraction (0.0 - 1.0)
 */
export function calculateAbsorbedFraction(
  hoursSinceMeal: number,
  profile: PharmacodynamicProfile,
  steps: number = 100
): number {
  if (hoursSinceMeal <= 0) return 0.0;
  if (hoursSinceMeal >= profile.durationHours) return 1.0;

  // Integrate from 0 to hoursSinceMeal
  const dt = hoursSinceMeal / steps;
  let integral = 0.0;

  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const activity = calculateGammaAbsorption(t, profile);
    integral += activity * dt;
  }

  // Total area for normalization (0 to duration)
  const totalDt = profile.durationHours / steps;
  let totalIntegral = 0.0;

  for (let i = 0; i < steps; i++) {
    const t = i * totalDt;
    const activity = calculateGammaAbsorption(t, profile);
    totalIntegral += activity * totalDt;
  }

  // Clamp to [0, 1]: this is a *fraction absorbed* and cannot exceed 1.
  //
  // Both integrals are 100-step left-Riemann sums, but over different step
  // sizes (hoursSinceMeal/100 and durationHours/100), so their discretisation
  // errors do not cancel and the ratio can drift a few parts in 10,000 either
  // side of 1 near the end of the window. Removing the pre-onset ramp (D21c)
  // steepened the curve's rise and made the overshoot newly visible — the
  // parity harness caught it as three `meal_abs::very_fast` divergences the
  // moment Python was clamped and these were not.
  //
  // Making the estimator itself exact would mean integrating both on a common
  // fixed grid, which shifts every absorbed-carbohydrate value slightly and is
  // a separate decision — see the pre-ML audit §6.
  if (totalIntegral <= 0) return 0.0;
  return Math.min(1, Math.max(0, integral / totalIntegral));
}

/**
 * ============================================================================
 * MEAL ABSORPTION PROFILE SELECTION
 * Determines which absorption profile to use for a meal
 * ============================================================================
 */

/**
 * Get meal absorption profile based on meal composition
 *
 * @param meal - Meal document
 * @param patientConstants - Patient-specific constants
 * @returns Pharmacodynamic profile with patient modifiers applied
 */
export function getMealAbsorptionProfile(
  meal: Meal,
  patientConstants: PatientConstants
): PharmacodynamicProfile & { patientModifier: number; absorptionType: AbsorptionType } {
  // Determine absorption type — always resolve to a non-empty string.
  let absorptionType: AbsorptionType = 'medium';

  if (meal.calculation_summary?.absorption_type) {
    absorptionType = meal.calculation_summary.absorption_type;
  } else if (meal.nutrition?.absorptionType || (meal.nutrition as any)?.absorption_type) {
    absorptionType = (meal.nutrition.absorptionType || (meal.nutrition as any).absorption_type) as AbsorptionType;
  } else if (meal.foodItems && Array.isArray(meal.foodItems) && meal.foodItems.length > 0) {
    // ✅ FIX: When nutrition object is empty (common after processContextMealsForChart),
    // fall back to the absorption_type stored in foodItems[0].details.
    // Without this the profile always defaulted to 'medium', giving the wrong
    // duration/peak shape for 'fast' or 'slow' meals.
    const firstItemAbsType = (meal.foodItems[0] as any)?.details?.absorption_type;
    if (firstItemAbsType && typeof firstItemAbsType === 'string') {
      absorptionType = firstItemAbsType as AbsorptionType;
    }
  }

  // FIX (Bug 3): validate absorptionType is a real key before lookup; fall back
  // to 'medium' so MEAL_ABSORPTION_PROFILES never receives undefined as a key.
  if (!absorptionType || typeof absorptionType !== 'string' || !MEAL_ABSORPTION_PROFILES[absorptionType]) {
    absorptionType = 'medium';
  }

  // Get standard profile — guaranteed to exist after validation above.
  const profile = MEAL_ABSORPTION_PROFILES[absorptionType] || MEAL_ABSORPTION_PROFILES['medium'];

  // TS-C-3: fall back to SHARED_CONSTANTS instead of a local inline object (RULE 1)
  const absorptionModifiers = patientConstants.absorption_modifiers
    || DEFAULT_PATIENT_CONSTANTS.absorption_modifiers;
  const patientModifier = absorptionModifiers[absorptionType] || 1.0;

  return {
    onsetHours: profile.onset_hours,
    peakHours: profile.peak_hours,
    durationHours: profile.duration_hours,
    curveType: profile.curve_type || 'gamma_standard',
    shapeParam: profile.shape_param || 2.0,
    scaleParam: profile.scale_param || 1.0,
    patientModifier,
    absorptionType,
  };
}

/**
 * ============================================================================
 * MEAL ACTIVITY CALCULATIONS
 * Calculate MOB (Meal on Board) and absorption effects
 * Direct port of: pharmacodynamics.py::calculate_meal_active_carbs()
 * ============================================================================
 */

/**
 * Result of meal activity calculation
 */
export interface MealActivityResult {
  /** Activity level (0-1) at specified time */
  activity: number;
  /** Cumulative effect (0-1) - absorbed fraction */
  cumulativeEffect: number;
  /** Meal on board in carb equivalents */
  mob: number;
  /** Blood glucose impact in mg/dL per hour */
  bgImpact: number;
  /** Hours since meal */
  hoursSinceMeal: number;
  /** Whether meal is still absorbing */
  isActive: boolean;
  /** Absorbed carbs so far */
  absorbedCarbs: number;
  /** Remaining carbs to be absorbed */
  remainingCarbs: number;
  /** Current BG elevation from absorbed carbs (PAST→PRESENT) */
  currentBgElevation: number;
  /** Pending BG rise from remaining carbs (PRESENT→FUTURE) */
  pendingBgRise: number;
}

/**
 * Calculate meal activity at specific time
 * Direct port of: pharmacodynamics.py::calculate_meal_active_carbs()
 *
 * @param meal - Meal document
 * @param currentTime - Current timestamp
 * @param patientConstants - Patient constants
 * @returns Complete meal activity result
 */
export function calculateMealActivity(
  meal: Meal,
  currentTime: Date,
  patientConstants: PatientConstants
): MealActivityResult {
  // 1. Calculate time since meal (D10: UTC-safe, handles every shape the
  //    backend and the chart pipeline send — see parseMealTimestamp)
  const mealMs = parseMealTimestamp(meal.timestamp);
  const hoursSinceMeal = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);

  // 2. Get absorption profile with patient modifiers
  const profile = getMealAbsorptionProfile(meal, patientConstants);

  // 3. Check if meal is still active
  const isActive = hoursSinceMeal >= 0 && hoursSinceMeal <= profile.durationHours;

  if (!isActive) {
    const totalCarbEquiv = getTotalCarbsFromMeal(meal, patientConstants.protein_factor, patientConstants.fat_factor);
    const carbToBgFactor = patientConstants.carb_to_bg_factor || 4.0;

    // Distinguish a future meal (not started yet) from an expired meal (fully absorbed).
    // A future meal's entire carb load is still pending — nothing has been absorbed yet.
    // An expired meal has been fully absorbed — nothing is pending.
    const isFutureMeal = hoursSinceMeal < 0;

    return {
      activity: 0,
      cumulativeEffect:   isFutureMeal ? 0 : 1,
      mob:                isFutureMeal ? totalCarbEquiv : 0,            // all carbs "on board" for future meal
      bgImpact: 0,
      hoursSinceMeal,
      isActive: false,
      absorbedCarbs:      isFutureMeal ? 0 : totalCarbEquiv,
      remainingCarbs:     isFutureMeal ? totalCarbEquiv : 0,            // full load still pending
      currentBgElevation: isFutureMeal ? 0 : totalCarbEquiv * carbToBgFactor,
      pendingBgRise:      isFutureMeal ? totalCarbEquiv * carbToBgFactor : 0, // full rise pending
    };
  }

  // 4. Get total carb equivalents (with foodItems fallback)
  const totalCarbEquiv = getTotalCarbsFromMeal(meal, patientConstants.protein_factor, patientConstants.fat_factor);

  if (totalCarbEquiv === 0) {
    return {
      activity: 0,
      cumulativeEffect: 0,
      mob: 0,
      bgImpact: 0,
      hoursSinceMeal,
      isActive: true,
      absorbedCarbs: 0,
      remainingCarbs: 0,
      currentBgElevation: 0,
      pendingBgRise: 0,
    };
  }

  // 5. Calculate activity percentage and absorbed fraction
  const activityPercent = calculateGammaAbsorption(hoursSinceMeal, profile);
  const activity = activityPercent / 100; // Convert to 0-1
  const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);

  // 6. Calculate absorbed and remaining carbs
  const absorbedCarbs = totalCarbEquiv * absorbedFraction;
  const remainingCarbs = totalCarbEquiv - absorbedCarbs;
  const activeCarbs = remainingCarbs; // MOB = carbs still being absorbed

  // 7. Calculate BG impacts
  const carbToBgFactor = patientConstants.carb_to_bg_factor || 4.0;

  // Current BG elevation from absorbed carbs (PAST→PRESENT)
  const currentBgElevation = absorbedCarbs * carbToBgFactor;

  // Pending BG rise from remaining carbs (PRESENT→FUTURE)
  const pendingBgRise = remainingCarbs * carbToBgFactor;

  // Active effect (instantaneous rate of BG change)
  const bgImpact = activity * totalCarbEquiv * carbToBgFactor;

  return {
    activity,
    cumulativeEffect: absorbedFraction,
    mob: activeCarbs,
    bgImpact,
    hoursSinceMeal,
    isActive: true,
    absorbedCarbs,
    remainingCarbs,
    currentBgElevation,
    pendingBgRise,
  };
}

/**
 * ============================================================================
 * STACKED MEAL EFFECTS
 * Calculate combined effects from multiple active meals
 * ============================================================================
 */

/**
 * Result of stacked meal calculations
 */
export interface StackedMealResult {
  /** Total MOB across all meals */
  totalMOB: number;
  /** Total active effect (rate of BG change) */
  totalActiveEffect: number;
  /** Total absorbed carbs */
  totalAbsorbedCarbs: number;
  /** Total pending BG rise */
  totalPendingRise: number;
  /** Total cumulative BG elevation */
  totalBGElevation: number;
  /** Individual meal contributions */
  contributions: Array<MealActivityResult & { mealId: string; mealType: string }>;
}
/**
 * Calculate total MOB from multiple meals
 * Aggregates effects from all active meals
 *
 * @param meals - Array of meal documents
 * @param currentTime - Current timestamp
 * @param patientConstants - Patient constants
 * @returns Aggregated MOB results
 */
export function calculateStackedMealEffect(
  meals: Meal[],
  currentTime: Date,
  patientConstants: PatientConstants
): StackedMealResult {
  let totalMOB = 0;
  let totalActiveEffect = 0;
  let totalAbsorbedCarbs = 0;
  let totalPendingRise = 0;
  let totalBGElevation = 0;
  const contributions: Array<MealActivityResult & { mealId: string; mealType: string }> = [];

  // Compute the daily reset boundary so pre-reset meals are excluded from
  // the "currently active" window.  This mirrors calculateTotalCumulativeEffects
  // and prevents meals from previous days accumulating in totalBGElevation.
  const resetHour = (patientConstants as any).daily_reset_hour ?? 7;
  const tzOffset  = (patientConstants as any).timezone_offset_minutes ?? 0;

  // D9, fixed: use TimeManager rather than an inline copy of the arithmetic.
  //
  // The helper that used to live here anchored the reset day on the *UTC*
  // calendar date (`utcMidnight`, then shifted by the offset), which is only
  // right while the patient's local date matches the UTC one. East of +07:00 it
  // does not — at 20:00 UTC a patient at UTC+13 is already on the next local
  // day — and because the rollback below it could only ever move the candidate
  // backwards, the boundary came out exactly 24 h early. Meals from the
  // previous window were then admitted and counted toward today's totals.
  //
  // It was inline "to avoid a circular import with blood-glucose-estimation.ts".
  // TimeManager has no such cycle: it imports neither of these modules, which is
  // what makes it usable as the single definition of the boundary.
  const lastResetMs = timeManagerDailyReset(currentTime.getTime(), resetHour, tzOffset);

  for (const meal of meals) {
    // FIX: Skip meals that pre-date today's daily reset.
    // These are already excluded by calculateTotalCumulativeEffects; including
    // them here inflated totalBGElevation by the full carb×factor of every
    // historical meal (observed as totalBGElevation: 3123.52 in logs).
    const mealTs = meal.timestamp;

    // ✅ FIX: Handle both numeric (ms) and string ISO timestamps.
    // processContextMealsForChart converts timestamps to numbers before passing
    // them here. String(number) produces e.g. "1742274240000", which has no
    // timezone indicator, so the old code appended 'Z' making "1742274240000Z"
    // → Invalid Date → NaN → every meal was silently skipped → totalBGElevation
    // was always 0 and the orange meal area never rendered.
    const mealMs = parseMealTimestamp(mealTs);
    if (isNaN(mealMs) || mealMs < lastResetMs) continue;

    const activity = calculateMealActivity(meal, currentTime, patientConstants);

    if (activity.isActive || activity.cumulativeEffect > 0 || activity.pendingBgRise > 0) {
      totalMOB += activity.mob;
      totalActiveEffect += activity.bgImpact;
      totalAbsorbedCarbs += activity.absorbedCarbs;
      totalPendingRise += activity.pendingBgRise;

      // FIX: Only add currentBgElevation for meals that are CURRENTLY ABSORBING.
      // Fully-absorbed meals return currentBgElevation = totalCarbs × carbToBgFactor
      // (their Phase-3 persist value), which belongs in the cumulative bank
      // balance — NOT in the live "active effect" metric used by the BG estimator.
      // Including expired meals here caused the BG estimator to show a wildly
      // inflated net effect even when no meals were actively absorbing.
      if (activity.isActive) {
        totalBGElevation += activity.currentBgElevation;
      }

      contributions.push({
        ...activity,
        mealId: meal.id || String((meal as any)._id),
        mealType: meal.mealType || 'unknown',
      });
    }
  }

  return {
    totalMOB,
    totalActiveEffect,
    totalAbsorbedCarbs,
    totalPendingRise,
    totalBGElevation,
    contributions,
  };
}

/**
 * ============================================================================
 * UTILITY FUNCTIONS
 * Helper functions for meal calculations
 * ============================================================================
 */

/**
 * Get total carb equivalents from a meal
 * Handles different possible field names and foodItems fallback
 *
 * @param meal - Meal document
 * @returns Total carb equivalents
 */
export function getTotalCarbEquiv(meal: Meal): number {
  return getTotalCarbsFromMeal(meal);
}

/**
 * Get absorption type from a meal
 * Handles different possible field names
 *
 * @param meal - Meal document
 * @returns Absorption type
 */
export function getAbsorptionType(meal: Meal): AbsorptionType {
  return meal.calculation_summary?.absorption_type ||
         meal.nutrition?.absorptionType ||
         (meal.nutrition as any)?.absorption_type ||
         'medium';
}

/**
 * Check if a meal is currently active (still absorbing)
 *
 * @param meal - Meal document
 * @param currentTime - Current timestamp
 * @param patientConstants - Patient constants
 * @returns True if meal is still absorbing
 */
export function isMealActive(
  meal: Meal,
  currentTime: Date,
  patientConstants: PatientConstants
): boolean {
  const profile = getMealAbsorptionProfile(meal, patientConstants);
  const mealMs = parseMealTimestamp(meal.timestamp);   // D10
  const hoursSinceMeal = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);

  return hoursSinceMeal >= 0 && hoursSinceMeal <= profile.durationHours;
}

/**
 * Generate absorption curve data points for visualization
 *
 * @param meal - Meal document
 * @param patientConstants - Patient constants
 * @param intervalMinutes - Time interval between points (default: 5)
 * @returns Array of time/activity data points
 */
export function generateMealAbsorptionCurve(
  meal: Meal,
  patientConstants: PatientConstants,
  intervalMinutes: number = 5
): Array<{ time: number; activity: number; absorbed: number }> {
  const profile = getMealAbsorptionProfile(meal, patientConstants);
  const points: Array<{ time: number; activity: number; absorbed: number }> = [];
  const steps = Math.ceil((profile.durationHours * 60) / intervalMinutes);

  for (let i = 0; i <= steps; i++) {
    const timeHours = (i * intervalMinutes) / 60;
    const activityPercent = calculateGammaAbsorption(timeHours, profile);
    const activity = activityPercent / 100;
    const absorbed = calculateAbsorbedFraction(timeHours, profile);

    points.push({
      time: timeHours,
      activity,
      absorbed,
    });
  }

  return points;
}

/**
 * ============================================================================
 * LEGACY COMPATIBILITY
 * Functions matching the old API for backward compatibility
 * ============================================================================
 */

/**
 * Calculate meal activity from profile (legacy name)
 * Alias for calculateMealActivity for backward compatibility
 */
export const calcMealActivityFromProfile = calculateMealActivity;

/**
 * Calculate meal absorbed fraction (legacy name)
 * Wrapper around calculateAbsorbedFraction for backward compatibility
 */
export function calcMealAbsorbedFraction(
  hoursSinceMeal: number,
  profile: PharmacodynamicProfile
): number {
  return calculateAbsorbedFraction(hoursSinceMeal, profile);
}

/**
 * ============================================================================
 * EXPORTS
 * All public functions
 * ============================================================================
 */

export default {
  // Core calculations
  calculateMealActivity,
  calculateStackedMealEffect,
  getMealAbsorptionProfile,
  calculateAbsorbedFraction,

  // Profile conversion
  toPharmacodynamicProfile,

  // Carb extraction
  getTotalCarbsFromMeal,

  // Utilities
  getTotalCarbEquiv,
  getAbsorptionType,
  isMealActive,
  generateMealAbsorptionCurve,

  // Legacy compatibility
  calcMealActivityFromProfile,
  calcMealAbsorbedFraction,
};