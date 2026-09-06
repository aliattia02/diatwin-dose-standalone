/**
 * ============================================================================
 * NET EFFECT CALCULATION SERVICE - WITH CUMULATIVE BASELINE TRACKING
 * ============================================================================
 *
 * VERSION: 4.9 - USER-CONFIGURABLE DAILY RESET HOUR
 *
 * NEW IN v4.9:
 * ✅ FEATURE: Configurable daily reset hour via patientConstants.daily_reset_hour
 * ✅ UPDATED: All TimeManager calls now pass resetHour parameter (default: 7)
 * ✅ UPDATED: getDailyResetTime wrapper accepts resetHour parameter
 * ✅ UPDATED: isWithinCurrentDay wrapper accepts resetHour parameter
 * ✅ UPDATED: calculateMealCumulativeEffect accepts resetHour parameter
 * ✅ UPDATED: calculateInsulinCumulativeEffect accepts resetHour parameter
 * ✅ BENEFIT: Supports patients with different schedules (early risers, night owls)
 *
 * VERSION: 4.8 - CONSOLIDATED INSULIN BG IMPACT FUNCTIONS
 *
 * NEW IN v4.8:
 * ✅ CONSOLIDATION: Moved calculateInsulinTargetRange from insulin_bg_impact.js
 * ✅ CONSOLIDATION: Moved formatInsulinBGImpactForDisplay from insulin_bg_impact.js
 * ✅ BENEFIT: Single source of truth for all BG effect calculations and formatting
 * ✅ BENEFIT: Reduces code duplication and import complexity
 *
 * NEW IN v4.7:
 * ✅ ARCHITECTURAL PATTERN: Service Layer Routing
 * ✅ This service now acts as a routing layer for lower-tier functions
 * ✅ Re-exports: calculateSafeCorrectionDose, checkMealSafety,
 *               getAbsorptionProfile, getInsulinProfile
 * ✅ Benefit: BloodSugarDataContext imports everything through one service
 * ✅ This creates a clear dependency hierarchy and prevents import sprawl
 *
 * ROUTING PATTERN:
 * BloodSugarDataContext → netEffectCalculationService → Lower-tier services
 *   - Insulin stacking functions
 *   - Meal stacking functions
 *   - Meal pharmacodynamics
 *   - Insulin pharmacodynamics
 *
 * VERSION: 4.6 - TIMEMANAGER INTEGRATION
 *
 * REFACTORING IN v4.6:
 * ✅ REFACTORED: Cumulative utilities now integrated into TimeManager v3.1
 * ✅ getDailyResetTime, isWithinCurrentDay, isAtResetTime now use TimeManager methods
 * ✅ Eliminates need for separate cumulativeUtils.js file
 * ✅ Maintains backward compatibility - all exports remain the same
 * ✅ Prevents circular dependencies by using TimeManager as foundation layer
 * ✅ Wrapper functions maintained for existing consumers
 *
 * VERSION: 4.5 - FIXED INSULIN CUMULATIVE EFFECT BUG
 *
 * CRITICAL FIX IN v4.5:
 * ✅ FIXED: calculateInsulinAbsorptionFraction now correctly uses calculateIOB
 * ✅ Bug was: calculateInsulinActivity returns a number, not an object with .iob
 * ✅ Solution: Use calculateIOB(hoursSinceDose, 1.0, profile) to get IOB fraction
 * ✅ This fixes NaN/0.0 values during active insulin absorption
 *
 * VERSION: 4.4 - FIXED CUMULATIVE MEAL TRACKING BEYOND 8 HOURS
 *
 * CRITICAL FIX IN v4.4:
 * ✅ FIXED: Meal cumulative effects now persist correctly until 7 AM reset
 * ✅ Separated mealsForMOB (8-hour window) from mealsForCumulative (day-based)
 * ✅ Cumulative tracking no longer filtered by MOB_LOOKBACK_HOURS
 * ✅ Meals consumed >8 hours ago now correctly show in cumulative baseline
 *
 * ROOT CAUSE: Previous versions used the same mealsForMOB array (filtered to
 * 8-hour window) for both MOB calculation AND cumulative tracking. This caused
 * meal cumulative effects to disappear after 8 hours instead of persisting
 * until the 7 AM reset. Now uses separate arrays for each purpose.
 *
 * CRITICAL FIX IN v4.3:
 * ✅ FIXED: Cumulative baseline now resets to EXACTLY 0 at 7 AM (was -200)
 * ✅ Changed isWithinCurrentDay to use > instead of >= (excludes 7 AM doses)
 * ✅ Added explicit isExactly7AM check to force cumulative = 0
 * ✅ Contributions arrays are empty at 7 AM reset point
 *
 * NEW IN v4.2:
 * ✅ Added daily reset functionality - cumulative baseline resets at 7 AM each day
 * ✅ Only meals/insulin from current day (after 7 AM) contribute to cumulative
 * ✅ This matches typical daily diabetes management patterns
 *
 * CRITICAL FIX IN v4.1:
 * Fixed cumulative baseline to PERSIST after absorption completes.
 * Previous version used MOB/IOB values which drop to zero - now uses
 * individual dose tracking with absorption fractions that stay at 1.0.
 *
 * CRITICAL NEW FEATURE: Dual-Line Visualization System
 *
 * Line 1 (Existing): Current Net Effect - Rate of change happening NOW
 * Line 2 (NEW): Cumulative Baseline - Accumulated shift from baseline (resets daily at 7 AM)
 *
 * KEY INSIGHT:
 * In Type 1 Diabetes, absorbed glucose does NOT leave the bloodstream without
 * insulin. Therefore:
 * - Current activity (dE/dt) goes to ZERO after absorption completes
 * - Cumulative effect (E_cumulative) PERSISTS until next 7 AM reset
 *
 * This is like a bank account that resets daily:
 * - Transaction rate (activity) is temporary
 * - Running balance (cumulative) persists within the day
 * - Balance resets to 0 at 7 AM each morning
 *
 * Changes in v4.2:
 * 1. ✅ NEW: getDailyResetTime() - finds most recent 7 AM reset
 * 2. ✅ NEW: isWithinCurrentDay() - filters doses to current day only
 * 3. ✅ UPDATED: calculateMealCumulativeEffect() - respects daily reset
 * 4. ✅ UPDATED: calculateInsulinCumulativeEffect() - respects daily reset
 *
 * Changes in v4.1:
 * 1. ✅ FIXED: Added helper functions for persistent cumulative calculation
 * 2. ✅ FIXED: Meal cumulative now calculated from individual meals with persistent fractions
 * 3. ✅ FIXED: Insulin cumulative now calculated from individual doses with persistent fractions
 * 4. ✅ Cumulative effects now properly persist at 100% after absorption completes
 *
 * Changes from v3.0:
 * 1. ✅ Added cumulativeMealEffect - persistent BG elevation from absorbed carbs
 * 2. ✅ Added cumulativeInsulinEffect - persistent BG reduction from absorbed insulin
 * 3. ✅ Added cumulativeNetBaseline - net shift from baseline (the "bank balance")
 * 4. ✅ Added detailed contribution tracking for tooltips
 * 5. ✅ Maintains ALL existing functionality (backward compatible)
 */

// =====================================
// IMPORTS - Tier 2 Services
// =====================================
import {
  calculateStackedInsulinEffect,
  getInsulinProfile,
  calculateInsulinActivity,
  calculateIOB
} from './insulinPharmacodynamics.js';

import {
  analyzeStackingRisk as analyzeInsulinStackingRisk,
  analyzeHypoglycemiaRisk,
  checkDosingSafety as checkInsulinDosingSafetyImported,
  calculateSafeCorrectionDose,
  getT1DDurationLabel,
  COUNTER_REGULATION,
  INSULIN_STACKING_THRESHOLDS
} from './insulinStackingAnalyzer.js';

import {
  formatInsulinContributionsForDisplay
} from './insulinCalculationService.js';

import {
  calculateActiveMealEffects,
  formatMealContributionsForDisplay
} from './mealCalculationService.js';

import {
  calculateMealActivity,
  calculateMOB,
  getAbsorptionProfile,
  calculateAbsorbedFraction
} from './mealPharmacodynamics.js';

import {
  analyzeMealStackingRisk,
  analyzeHyperglycemiaRisk,
  checkMealSafety,
  MEAL_STACKING_THRESHOLDS
} from './mealStackingAnalyzer.js';

import {
  calculateStableBaseline,
  calculateRobustBaseline,
  calculateEstimationConfidence,
  estimateGlucoseAtTime,
  calculateGlucoseVelocity,
  predictGlucoseFromVelocity,
  generateSmartInterpolation,
  recommendNextReading,
  detectBaselineShift,
  assessCGMDataQuality
} from './bloodGlucoseEstimationService.js';

import TimeManager from './TimeManager.js';
import { SHARED_CONSTANTS } from '../constants/shared_constants';

// =====================================
// DEBUG MODE - DISABLED FOR PERFORMANCE
// =====================================
const DEBUG_MODE = false; // ✅ Keep disabled to prevent log spam

// =====================================
// CONSTANTS
// =====================================
export const NET_EFFECT_CONSTANTS = {
  TIME_PRECISION: 'second',
  TIMESTAMP_NORMALIZATION: 'minute_boundary',
  MAX_READING_AGE_HOURS: SHARED_CONSTANTS.T1D_BG_CONSTANTS.max_reading_age_hours,
  MAX_READING_AGE_MINUTES: SHARED_CONSTANTS.T1D_BG_CONSTANTS.max_reading_age_minutes,
  IOB_LOOKBACK_HOURS: SHARED_CONSTANTS.T1D_BG_CONSTANTS.iob_lookback_hours,
  MOB_LOOKBACK_HOURS: SHARED_CONSTANTS.T1D_BG_CONSTANTS.mob_lookback_hours,

  NET_EFFECT_THRESHOLDS: {
    HIGH_RISING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.high_rising,
    RISING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.rising,
    SLIGHTLY_RISING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.slightly_rising,
    STABLE_HIGH: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.stable_high,
    STABLE_LOW: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.stable_low,
    SLIGHTLY_FALLING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.slightly_falling,
    FALLING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.falling,
    RAPIDLY_FALLING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.rapidly_falling
  },

  VISUALIZATION: {
    DEFAULT_INTERVAL_MINUTES: 5,
    DEFAULT_PAST_HOURS: 8,
    DEFAULT_FUTURE_HOURS: 4,
    AREA_OPACITY: 0.6,
    LINE_WIDTH: 2,
    DOT_RADIUS: 4
  },

  EFFECT_LEVELS: {
    CRITICAL_HIGH: 100,
    HIGH: 50,
    MODERATE: 20,
    LOW: 5,
    NEGLIGIBLE: 2
  },

  STACKING: {
    INSULIN: INSULIN_STACKING_THRESHOLDS,
    MEAL: MEAL_STACKING_THRESHOLDS
  },

  RISK: {
    HYPOGLYCEMIA: {
      CRITICAL: 55,
      HIGH: 70,
      MODERATE: 80,
      LOW: 100
    },
    HYPERGLYCEMIA: {
      CRITICAL: 300,
      HIGH: 250,
      MODERATE: 180,
      LOW: 140
    }
  },

  COUNTER_REGULATION: {
    GLUCAGON_THRESHOLD: 70,
    EPINEPHRINE_THRESHOLD: 60,
    CORTISOL_THRESHOLD: 55
  }
};

// =====================================
// COUNTER-REGULATION
// =====================================
export function calculateCounterRegulation(bg, t1dDuration = 5) {
  return COUNTER_REGULATION.calculateTotalResponse(bg, t1dDuration);
}

// =====================================
// CUMULATIVE EFFECT HELPER FUNCTIONS (v4.2 FIX)
// =====================================

/**
 * Get the most recent baseline reset time before the current timestamp
 * Cumulative effects reset daily at configured reset hour
 *
 * ✅ REFACTOR v3.1: This now uses TimeManager.getDailyResetTime() (consolidated in TimeManager v3.1)
 * ✅ v4.0: Support configurable reset hour
 * Kept as wrapper function to maintain backward compatibility with existing exports
 *
 * @param {number} currentTimestamp - Current time in milliseconds
 * @param {number} [resetHour=7] - Hour of day for reset (0-23)
 * @returns {number} Reset time in milliseconds
 */
function getDailyResetTime(currentTimestamp, resetHour = 7, tzOffsetMinutes = null) {
  return TimeManager.getDailyResetTime(currentTimestamp, resetHour, tzOffsetMinutes);
}

/**
 * Check if a dose/meal should be included in cumulative calculation
 * Only include doses AFTER the most recent reset (not AT reset hour)
 *
 * CRITICAL: Doses exactly at reset hour are EXCLUDED to ensure clean reset
 *
 * ✅ REFACTOR v3.1: This now uses TimeManager.isWithinCurrentDay() (consolidated in TimeManager v3.1)
 * ✅ v4.0: Support configurable reset hour
 * Kept as wrapper function to maintain backward compatibility with existing exports
 *
 * @param {number} doseTimestamp - Timestamp of dose/meal in milliseconds
 * @param {number} currentTimestamp - Current time in milliseconds
 * @param {number} [resetHour=7] - Hour of day for reset (0-23)
 * @returns {boolean} True if dose is within current day
 */
function isWithinCurrentDay(doseTimestamp, currentTimestamp, resetHour = 7, tzOffsetMinutes = null) {
  return TimeManager.isWithinCurrentDay(doseTimestamp, currentTimestamp, resetHour, tzOffsetMinutes);
}

/**
 * Check if current time is exactly at or very close to 7 AM reset point
 * Returns true if within 1 minute of 7 AM
 *
 * ✅ REFACTOR v3.1: This now uses TimeManager.isAtResetTime() (consolidated in TimeManager v3.1)
 * Kept as wrapper function to maintain backward compatibility with existing exports
 */
function isAtResetTime(currentTimestamp, resetHour = 7, tzOffsetMinutes = null) {
  // ✅ D24b: this wrapper used to swallow both resetHour and the patient's
  // offset, so every caller silently got the 7 AM default on the browser's
  // clock. It forwards them now, like the two wrappers above it.
  return TimeManager.isAtResetTime(currentTimestamp, resetHour, tzOffsetMinutes);
}

/**
 * Calculate insulin absorption fraction at a given time
 * CRITICAL FIX v4.1: Returns 1.0 (100%) after completion and STAYS THERE
 * CRITICAL FIX v4.5: Now correctly uses calculateIOB instead of calculateInsulinActivity
 *
 * This is different from IOB which drops to 0 after completion.
 * IOB tracks "on board" (remaining), this tracks "absorbed" (cumulative).
 *
 * ROOT CAUSE OF BUG:
 * - calculateInsulinActivity returns a NUMBER (activity percentage)
 * - Previous code was trying to access .iob property which doesn't exist → NaN
 * - Solution: Use calculateIOB which correctly calculates remaining insulin
 */
function calculateInsulinAbsorptionFraction(hoursSinceDose, profile) {
  if (hoursSinceDose <= 0) return 0;
  if (hoursSinceDose >= profile.duration_hours) return 1.0; // ✅ PERSISTS at 100%

  // ✅ FIXED v4.5: Use calculateIOB to get remaining insulin fraction
  // calculateIOB returns remaining units for a 1.0 unit dose
  // So absorbed = 1.0 - IOB
  const iobFraction = calculateIOB(hoursSinceDose, 1.0, profile);
  const absorptionFraction = 1.0 - iobFraction;

  // Ensure we stay within bounds [0, 1]
  return Math.max(0, Math.min(1.0, absorptionFraction));
}

/**
 * Calculate cumulative effect of a single meal at a specific time
 * CRITICAL FIX v4.1: Effect PERSISTS even after absorption completes
 * NEW v4.2: Only counts meals from current day (after reset)
 * ✅ v4.0: Support configurable reset hour
 *
 * This represents the permanent BG elevation from absorbed carbs.
 * Unlike MOB (which drops to 0), this stays at totalEffect after completion.
 *
 * @param {Object} meal - Meal data
 * @param {number} currentTime - Current timestamp
 * @param {number} carbToBGFactor - Carb to BG conversion factor
 * @param {number} [resetHour=7] - Hour of day for daily reset
 * @returns {number} Cumulative BG effect in mg/dL
 */
function calculateMealCumulativeEffect(meal, currentTime, carbToBGFactor, resetHour = 7, tzOffsetMinutes = null) {
  const mealTime = meal.timestamp;

  // NEW v4.2: Skip meals from before today's reset
  // ✅ v4.0: Use configurable resetHour
  if (!isWithinCurrentDay(mealTime, currentTime, resetHour, tzOffsetMinutes)) {
    return 0;
  }

  const absorptionType = meal.nutrition?.absorptionType || meal.absorptionType || 'medium';
  const profile = getAbsorptionProfile(absorptionType);
  const duration = profile.duration_hours * 3600 * 1000; // Convert to ms
  const endTime = mealTime + duration;

  // Phase 1: Before absorption starts
  if (currentTime < mealTime) {
    return 0;
  }

  // Phase 3: After absorption completes - PERSIST at 100%
  // ✅ THIS IS THE CRITICAL FIX - Effect stays at total even after completion
  if (currentTime >= endTime) {
    const totalCarbs = meal.nutrition?.totalCarbEquiv || meal.carbEquiv || 0;
    return totalCarbs * carbToBGFactor; // ✅ PERSISTS until next 7 AM
  }

  // Phase 2: During absorption
  const elapsed = (currentTime - mealTime) / (3600 * 1000); // hours
  const absorptionFraction = calculateAbsorbedFraction(elapsed, profile);
  const totalCarbs = meal.nutrition?.totalCarbEquiv || meal.carbEquiv || 0;
  return totalCarbs * Math.min(absorptionFraction, 1.0) * carbToBGFactor;
}

/**
 * Calculate cumulative effect of a single insulin dose at a specific time
 * CRITICAL FIX v4.1: Effect PERSISTS even after absorption completes
 * NEW v4.2: Only counts doses from current day (after reset)
 * ✅ v4.0: Support configurable reset hour
 *
 * This represents the permanent BG reduction from absorbed insulin.
 * Unlike IOB (which drops to 0), this stays at totalEffect after completion.
 *
 * @param {Object} dose - Insulin dose data
 * @param {number} currentTime - Current timestamp
 * @param {number} correctionFactor - Insulin sensitivity factor
 * @param {number} [resetHour=7] - Hour of day for daily reset
 * @returns {number} Cumulative BG effect in mg/dL (negative value)
 */
function calculateInsulinCumulativeEffect(dose, currentTime, correctionFactor, resetHour = 7, tzOffsetMinutes = null) {
  const doseTime = dose.administrationTime;

  // NEW v4.2: Skip doses from before today's reset
  // ✅ v4.0: Use configurable resetHour
  if (!isWithinCurrentDay(doseTime, currentTime, resetHour, tzOffsetMinutes)) {
    return 0;
  }

  const insulinType = dose.medication || dose.insulinType || 'regular_insulin';
  const profile = getInsulinProfile(insulinType);

  if (!profile) return 0;

  const duration = profile.duration_hours * 3600 * 1000; // Convert to ms
  const endTime = doseTime + duration;

  // Phase 1: Before absorption starts
  if (currentTime < doseTime) {
    return 0;
  }

  // Phase 3: After absorption completes - PERSIST at 100%
  // ✅ THIS IS THE CRITICAL FIX - Effect stays at total even after completion
  if (currentTime >= endTime) {
    return -(dose.dose * correctionFactor); // ✅ PERSISTS until next 7 AM (negative for BG reduction)
  }

  // Phase 2: During absorption
  const elapsed = (currentTime - doseTime) / (3600 * 1000); // hours
  const absorptionFraction = calculateInsulinAbsorptionFraction(elapsed, profile);
  return -(dose.dose * absorptionFraction * correctionFactor);
}


// =====================================
// CORE NET EFFECT CALCULATION - WITH CUMULATIVE TRACKING
// =====================================
/**
 * Calculate net effect at a specific time with cumulative baseline tracking
 *
 * NEW IN v4.0: Returns both current activity AND cumulative effects
 *
 * @param {Array} meals - Meal data with timestamps and carb equivalents
 * @param {Array} insulinDoses - Insulin doses with administration times
 * @param {number} targetTimestamp - Time to calculate effects for
 * @param {object} patientConstants - Patient-specific factors
 * @param {object} options - Additional options (t1dDuration, currentBG, etc.)
 * @returns {object} Complete effect data including cumulative baseline
 */
export async function calculateNetEffectAtTime(
  meals,
  insulinDoses,
  targetTimestamp,
  patientConstants,
  options = {}
) {
  const normalizedTimestamp = TimeManager.normalize(targetTimestamp, TimeManager.precision.SECOND);

  if (!patientConstants) {
    return {
      netEffect: 0,
      mealImpact: 0,
      insulinImpact: 0,
      totalActiveInsulin: 0,
      totalActiveCarbs: 0,
      totalAbsorbedCarbs: 0,
      totalAbsorbedInsulin: 0,
      // NEW: Cumulative tracking
      cumulativeMealEffect: 0,
      cumulativeInsulinEffect: 0,
      cumulativeNetBaseline: 0,
      mealCumulativeContributions: [],
      insulinCumulativeContributions: [],
      timestamp: normalizedTimestamp,
      hasActiveEffects: false,
      error: 'No patient constants available'
    };
  }

  const correctionFactor = patientConstants.correction_factor || 50;
  const carbToBGFactor = patientConstants.carb_to_bg_factor || 4.0;
  const t1dDuration = options.t1dDuration || patientConstants.t1d_duration_years || 5;
  // ✅ v4.0: Extract reset hour from patientConstants
  const resetHour = patientConstants.daily_reset_hour || 7;
  // ✅ v4.9: Extract timezone offset — falls back to browser offset if not stored
  const tzOffsetMinutes = patientConstants.timezone_offset_minutes != null
    ? patientConstants.timezone_offset_minutes
    : -(new Date(normalizedTimestamp).getTimezoneOffset());

  // ── Activity third term (optional, passed via options.activityPD) ─────────
  // The caller (BloodSugarDataContext or ActiveEffectsDisplay) may inject the
  // result of fetchStackedActivityEffect() here.  If absent, the term is 0 and
  // existing behaviour is completely unchanged.
  const cumulativeActivityEffect = options.activityPD?.cumulative_activity_effect ?? 0;
  const activitySensitivityMultiplier = options.activityPD?.sensitivity_multiplier ?? 1.0;
  const activityOnBoard          = options.activityPD?.activity_on_board ?? 0;
  const activityContributions    = options.activityPD?.activity_contributions ?? [];

  // ============================================================================
  // STEP 1: Calculate MOB at target time
  // ============================================================================
  // Format all meals first
  const allMealsFormatted = (meals || []).map(meal => {
    let mealTime;
    if (typeof meal.timestamp === 'number') {
      mealTime = meal.timestamp;
    } else if (meal.timestamp instanceof Date) {
      mealTime = meal.timestamp.getTime();
    } else {
      mealTime = new Date(meal.timestamp).getTime();
    }

    return {
      id: meal.id || meal._id,
      timestamp: mealTime,
      mealType: meal.mealType || 'normal',
      nutrition: {
        totalCarbEquiv: meal.nutrition?.totalCarbEquiv ||
                        meal.nutrition?.total_carb_equiv ||
                        meal.carbEquiv || 0,
        absorptionType: meal.nutrition?.absorptionType ||
                        meal.nutrition?.absorption_type ||
                        meal.absorptionType || 'medium',
        carbs: meal.nutrition?.carbs || 0,
        protein: meal.nutrition?.protein || 0,
        fat: meal.nutrition?.fat || 0
      },
      calculation_summary: meal.calculation_summary,
      foodItems: meal.foodItems || []
    };
  });

  // ✅ CRITICAL FIX: Separate arrays for MOB vs Cumulative calculation
  // MOB array: Only meals within 8-hour lookback (for active absorption)
  const mealsForMOB = allMealsFormatted.filter(meal => {
    const hoursSinceMeal = (normalizedTimestamp - meal.timestamp) / (3600 * 1000);
    return hoursSinceMeal >= -0.001 && hoursSinceMeal <= NET_EFFECT_CONSTANTS.MOB_LOOKBACK_HOURS;
  });

  // Cumulative array: All meals from current day (after last reset)
  // This ensures cumulative effects persist until reset, even if absorption completed
  // ✅ v4.0: Use configurable resetHour
  const mealsForCumulative = allMealsFormatted.filter(meal => {
    return isWithinCurrentDay(meal.timestamp, normalizedTimestamp, resetHour, tzOffsetMinutes);
  });

  const mobResult = await calculateActiveMealEffects(
    mealsForMOB,
    new Date(normalizedTimestamp),
    patientConstants
  );

  const totalActiveCarbs = mobResult.mob?.total_active_carbs || 0;
  const totalAbsorbedCarbs = mobResult.mob?.total_absorbed_carbs || 0;
  const mealImpact = mobResult.mob?.current_bg_elevation ||
                     mobResult.mob?.expected_bg_impact || 0;
  const pendingMealRise = mobResult.mob?.pending_bg_rise ||
                          (totalActiveCarbs * carbToBGFactor);

  // ============================================================================
  // ✅ FIXED v4.2: Calculate CUMULATIVE MEAL EFFECT WITH DAILY RESET
  // ✅ FIXED v4.3: Use mealsForCumulative instead of mealsForMOB
  // ✅ v4.0: Use configurable resetHour
  // ============================================================================
  // CRITICAL: At exactly reset hour, force cumulative to be 0 (clean reset)
  // ✅ v4.9: Use patient's local hour (via tzOffsetMinutes) not JS engine local hour
  const localMs = normalizedTimestamp + tzOffsetMinutes * 60 * 1000;
  const localDate = new Date(localMs);
  const isExactlyAtReset = localDate.getUTCHours() === resetHour && localDate.getUTCMinutes() === 0;

  // Calculate cumulative effect from EACH meal individually using persistent fractions
  // ✅ FIX: Use mealsForCumulative (day-based) instead of mealsForMOB (8-hour window)
  // ✅ v4.0: Pass resetHour to calculateMealCumulativeEffect
  let cumulativeMealEffect = 0;
  if (!isExactlyAtReset) {
    cumulativeMealEffect = mealsForCumulative.reduce((sum, meal) => {
      return sum + calculateMealCumulativeEffect(meal, normalizedTimestamp, carbToBGFactor, resetHour, tzOffsetMinutes);
    }, 0);
  }

  // Track individual meal contributions with proper cumulative tracking
  // At reset hour, contributions should be empty
  // ✅ FIX: Use mealsForCumulative to ensure completed meals still show in contributions
  const mealCumulativeContributions = isExactlyAtReset ? [] : mealsForCumulative.map(meal => {
    const mealTime = meal.timestamp;
    const absorptionType = meal.nutrition?.absorptionType || meal.absorptionType || 'medium';
    const profile = getAbsorptionProfile(absorptionType);
    const hoursSinceMeal = (normalizedTimestamp - mealTime) / (3600 * 1000);
    const isComplete = hoursSinceMeal >= profile.duration_hours;

    const absorbedFraction = isComplete ? 1.0 : calculateAbsorbedFraction(hoursSinceMeal, profile);
    const totalCarbs = meal.nutrition?.totalCarbEquiv || meal.carbEquiv || 0;
    const absorbedCarbs = totalCarbs * absorbedFraction;
    const cumulativeEffect = absorbedCarbs * carbToBGFactor;

    // Find the current activity from MOB results
    const mobContrib = mobResult.mob?.meal_contributions?.find(c =>
      c.mealId === (meal.id || meal._id)
    );

    return {
      mealId: meal.id || meal._id,
      mealType: meal.mealType || 'meal',
      totalCarbs: totalCarbs,
      absorbedCarbs: absorbedCarbs,
      cumulativeEffect: cumulativeEffect,  // ✅ This persists at 100% after completion
      currentActivity: mobContrib?.currentActivity || 0,  // This goes to zero
      hoursSinceMeal: hoursSinceMeal,
      isComplete: isComplete,
      absorptionType: absorptionType
    };
  });

  // ============================================================================
  // STEP 2: Calculate IOB at target time
  // ============================================================================
  const dosesForCalculation = (insulinDoses || []).map(dose => {
    const doseTime = typeof dose.administrationTime === 'number'
      ? dose.administrationTime
      : new Date(dose.administrationTime || dose.taken_at).getTime();

    const hoursSinceDose = TimeManager.calculateHoursSince(
      normalizedTimestamp,
      doseTime,
      TimeManager.precision.SECOND
    );

    return {
      dose: dose.dose,
      insulinType: dose.medication || dose.insulinType || 'regular_insulin',
      hoursSinceDose: hoursSinceDose
    };
  }).filter(dose => {
    const profile = getInsulinProfile(dose.insulinType);
    return profile && dose.hoursSinceDose >= 0 && dose.hoursSinceDose <= profile.duration_hours;
  });

  const iobResult = calculateStackedInsulinEffect(dosesForCalculation, correctionFactor);

  const transformedIOBResult = {
    totalActiveInsulin: iobResult.totalIOB || 0,
    bgImpact: -(iobResult.totalBGImpact || 0),
    insulinContributions: (iobResult.contributions || []).map(contrib => ({
      insulinType: contrib.insulinType,
      dose: contrib.dose,
      initial_dose: contrib.dose,
      iob: contrib.iob,
      activity: contrib.activity,
      activeUnits: contrib.activeUnits,
      hoursSinceDose: contrib.hoursSinceDose,
      bgImpact: contrib.bgImpact
    }))
  };

  const totalActiveInsulin = transformedIOBResult.totalActiveInsulin || 0;

  // Calculate absorbed insulin
  let totalAbsorbedInsulin = 0;
  if (transformedIOBResult.insulinContributions) {
    transformedIOBResult.insulinContributions.forEach(contrib => {
      const initialDose = contrib.initial_dose || contrib.dose;
      const iob = contrib.iob || 0;
      const absorbed = Math.max(0, initialDose - iob);
      totalAbsorbedInsulin += absorbed;
    });
  }

  // Current insulin impact (from absorbed insulin)
  const currentInsulinImpact = totalAbsorbedInsulin * correctionFactor;
  const insulinImpact = -currentInsulinImpact; // Negative because it REDUCES BG
  const pendingInsulinReduction = totalActiveInsulin * correctionFactor;

  // ============================================================================
  // ✅ FIXED v4.1: Calculate CUMULATIVE INSULIN EFFECT
  // ✅ v4.0: Use configurable resetHour
  // ============================================================================
  // Calculate cumulative effect from EACH insulin dose individually using persistent fractions
  const insulinDosesWithTime = (insulinDoses || []).map(dose => ({
    ...dose,
    administrationTime: typeof dose.administrationTime === 'number'
      ? dose.administrationTime
      : new Date(dose.administrationTime || dose.taken_at).getTime()
  }));

  // CRITICAL: At exactly reset hour, force cumulative to be 0 (clean reset)
  let cumulativeInsulinEffect = 0;
  if (!isExactlyAtReset) {
    // 🔍 DEBUG: Log all insulin doses being considered
    if (DEBUG_MODE && insulinDosesWithTime.length > 0) {
      console.log('🔬 CUMULATIVE INSULIN CALCULATION:', {
        currentTime: new Date(normalizedTimestamp).toLocaleTimeString(),
        totalDoses: insulinDosesWithTime.length,
        doses: insulinDosesWithTime.map(d => ({
          time: new Date(d.administrationTime).toLocaleTimeString(),
          dose: d.dose,
          medication: d.medication
        }))
      });
    }

    cumulativeInsulinEffect = insulinDosesWithTime.reduce((sum, dose) => {
      const contribution = calculateInsulinCumulativeEffect(dose, normalizedTimestamp, correctionFactor, resetHour, tzOffsetMinutes);

      // 🔍 DEBUG: Log each contribution
      if (DEBUG_MODE) {
        const hoursSince = (normalizedTimestamp - dose.administrationTime) / (3600 * 1000);
        const withinDay = isWithinCurrentDay(dose.administrationTime, normalizedTimestamp, resetHour, tzOffsetMinutes);
        console.log('  📍 Dose contribution:', {
          doseTime: new Date(dose.administrationTime).toLocaleTimeString(),
          hoursSince: hoursSince.toFixed(2),
          withinCurrentDay: withinDay,
          dose: dose.dose,
          contribution: contribution.toFixed(1),
          reason: contribution === 0 ? (
            !withinDay ? 'NOT_WITHIN_DAY' :
            hoursSince < 0 ? 'FUTURE_DOSE' :
            'UNKNOWN'
          ) : 'OK'
        });
      }

      return sum + contribution;
    }, 0);

    // 🔍 DEBUG: Log final result
    if (DEBUG_MODE) {
      console.log('💉 FINAL Cumulative Insulin Effect:', cumulativeInsulinEffect.toFixed(1), 'mg/dL');
    }
  }

  // Track individual insulin contributions with proper cumulative tracking
  // At 7 AM reset, contributions should be empty
  const insulinCumulativeContributions = isExactlyAtReset ? [] : insulinDosesWithTime
    .filter(dose => {
      // Only include doses that have started absorbing
      const hoursSince = (normalizedTimestamp - dose.administrationTime) / (3600 * 1000);
      return hoursSince >= 0;
    })
    .map(dose => {
      const doseTime = dose.administrationTime;
      const insulinType = dose.medication || dose.insulinType || 'regular_insulin';
      const profile = getInsulinProfile(insulinType);

      if (!profile) return null;

      const hoursSinceDose = (normalizedTimestamp - doseTime) / (3600 * 1000);
      const isComplete = hoursSinceDose >= profile.duration_hours;

      const absorptionFraction = isComplete ? 1.0 : calculateInsulinAbsorptionFraction(hoursSinceDose, profile);
      const absorbedInsulin = dose.dose * absorptionFraction;
      const cumulativeEffect = -(absorbedInsulin * correctionFactor);

      // Find the current activity from IOB results
      const iobContrib = transformedIOBResult.insulinContributions?.find(c =>
        Math.abs(c.hoursSinceDose - hoursSinceDose) < 0.01
      );

      return {
        doseId: dose.id || dose._id,
        insulinType: insulinType,
        totalDose: dose.dose,
        absorbedInsulin: absorbedInsulin,
        cumulativeEffect: cumulativeEffect,  // ✅ This persists at 100% after completion (negative)
        currentActivity: iobContrib?.activity || 0,  // This goes to zero
        hoursSinceDose: hoursSinceDose,
        isComplete: isComplete
      };
    })
    .filter(c => c !== null);

  // ============================================================================
  // STEP 3: Calculate Net Effects (Current AND Cumulative)
  // ============================================================================
  const netEffect = mealImpact + insulinImpact;

  // 🆕 NEW: Cumulative net baseline - the "bank balance"
  // ✅ Third term: activity (signed, lowers BG for aerobic sessions)
  const cumulativeNetBaseline = cumulativeMealEffect + cumulativeInsulinEffect + cumulativeActivityEffect;

  const hasActiveEffects = totalActiveInsulin > 0.01 || totalActiveCarbs > 0.1;

  // ============================================================================
  // STEP 4: Stacking Analysis
  // ============================================================================
  const insulinStacking = analyzeInsulinStackingRisk(
    transformedIOBResult.insulinContributions,
    correctionFactor
  );

  const mealStacking = analyzeMealStackingRisk(
    mobResult.mob?.meal_contributions || [],
    carbToBGFactor
  );

  // ============================================================================
  // STEP 5: Risk Assessment
  // ============================================================================
  const currentBG = options.currentBG || null;
  let hypoRisk = null;
  let hyperRisk = null;

  if (currentBG !== null) {
    const predictedBG = currentBG + netEffect + pendingMealRise - pendingInsulinReduction;

    hypoRisk = analyzeHypoglycemiaRisk(
      currentBG,
      dosesForCalculation,
      correctionFactor,
      t1dDuration
    );

    hyperRisk = analyzeHyperglycemiaRisk(
      currentBG,
      mobResult.mob?.meal_contributions?.map(c => ({
        carbEquiv: c.carbEquiv,
        absorptionType: c.absorptionType,
        hoursSinceMeal: c.hoursSinceMeal
      })) || [],
      carbToBGFactor
    );
  }

  // ============================================================================
  // RETURN: Complete effect data with cumulative tracking
  // ============================================================================
  return {
    // Current effects (rate of change NOW)
    netEffect: Math.round(netEffect * 10) / 10,
    mealImpact: Math.round(mealImpact * 10) / 10,
    insulinImpact: Math.round(insulinImpact * 10) / 10,
    currentInsulinImpact: Math.round(currentInsulinImpact * 10) / 10,
    pendingMealRise: Math.round(pendingMealRise * 10) / 10,
    pendingInsulinReduction: Math.round(pendingInsulinReduction * 10) / 10,

    // Absorbed amounts (what's in bloodstream)
    totalAbsorbedCarbs: Math.round(totalAbsorbedCarbs * 10) / 10,
    totalAbsorbedInsulin: Math.round(totalAbsorbedInsulin * 100) / 100,

    // Active amounts (what's still absorbing)
    totalActiveCarbs: Math.round(totalActiveCarbs * 10) / 10,
    totalActiveInsulin: Math.round(totalActiveInsulin * 100) / 100,

    // 🆕 NEW: Cumulative effects (the "bank balance") — now includes activity
    cumulativeMealEffect:      Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect:   Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeActivityEffect:  Math.round(cumulativeActivityEffect * 10) / 10,  // ← activity term
    cumulativeNetBaseline:     Math.round(cumulativeNetBaseline * 10) / 10,

    // ── Activity metadata ────────────────────────────────────────────────────
    activitySensitivityMultiplier: Math.round(activitySensitivityMultiplier * 10000) / 10000,
    activityOnBoard:               Math.round(activityOnBoard * 10) / 10,
    activityContributions,

    // 🆕 NEW: Detailed contributions for tooltips
    mealCumulativeContributions,
    insulinCumulativeContributions,

    // Metadata
    timestamp: normalizedTimestamp,
    hasActiveEffects,

    // Details for backward compatibility
    mobDetails: mobResult,
    iobDetails: transformedIOBResult,
    insulinStacking,
    mealStacking,
    hypoRisk,
    hyperRisk,
    status: getNetEffectStatus(netEffect)
  };
}

// =====================================
// SAFETY CHECKS
// =====================================
export function checkInsulinDosingSafety(
  activeDoses,
  proposedDose,
  proposedInsulinType,
  currentBG,
  correctionFactor = 50,
  t1dDuration = 5
) {
  return checkInsulinDosingSafetyImported(
    activeDoses,
    proposedDose,
    proposedInsulinType,
    currentBG,
    correctionFactor,
    t1dDuration
  );
}

export { checkMealSafety, calculateSafeCorrectionDose };

// =====================================
// BASELINE CALCULATION
// =====================================
export function calculateBaselineFromReading(
  actualReading,
  readingTimestamp,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const netEffect = calculateNetEffectAtTime(
    meals,
    insulinDoses,
    readingTimestamp,
    patientConstants,
    options
  );

  // 🆕 NEW: Use cumulative baseline for more accurate baseline calculation
  const baseline = actualReading - netEffect.cumulativeNetBaseline;


  return {
    baselineValue: baseline,
    confidence: calculateEstimationConfidence(
      actualReading,
      netEffect,
      options.cgmQuality || 0.8
    ),
    netEffect: netEffect,
    readingTime: readingTimestamp,
    actualReading
  };
}

export function calculateCurrentEstimatedBG(
  baseline,
  currentTimestamp,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const netEffect = calculateNetEffectAtTime(
    meals,
    insulinDoses,
    currentTimestamp,
    patientConstants,
    options
  );

  // 🆕 NEW: Use cumulative baseline for current BG estimation
  const estimatedBG = baseline + netEffect.cumulativeNetBaseline;

  return {
    estimatedBG,
    baseline,
    netEffect: netEffect,
    timestamp: currentTimestamp,
    confidence: calculateEstimationConfidence(
      estimatedBG,
      netEffect,
      options.cgmQuality || 0.8
    )
  };
}

export function calculateProjectedFinalBG(
  baseline,
  currentTimestamp,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const netEffect = calculateNetEffectAtTime(
    meals,
    insulinDoses,
    currentTimestamp,
    patientConstants,
    options
  );

  // 🆕 NEW: Project final BG using cumulative baseline + pending effects
  const projectedBG = baseline +
                      netEffect.cumulativeNetBaseline +
                      netEffect.pendingMealRise -
                      netEffect.pendingInsulinReduction;

  return {
    projectedBG,
    baseline,
    currentNetEffect: netEffect.cumulativeNetBaseline,
    pendingMealRise: netEffect.pendingMealRise,
    pendingInsulinReduction: netEffect.pendingInsulinReduction,
    timestamp: currentTimestamp,
    confidence: calculateEstimationConfidence(
      projectedBG,
      netEffect,
      options.cgmQuality || 0.8
    )
  };
}

// =====================================
// TIMELINE GENERATION WITH CUMULATIVE TRACKING
// =====================================
export async function generateDetailedEffectsTimeline(
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const {
    startTime = Date.now() - (NET_EFFECT_CONSTANTS.VISUALIZATION.DEFAULT_PAST_HOURS * 60 * 60 * 1000),
    endTime = Date.now() + (NET_EFFECT_CONSTANTS.VISUALIZATION.DEFAULT_FUTURE_HOURS * 60 * 60 * 1000),
    intervalMinutes = NET_EFFECT_CONSTANTS.VISUALIZATION.DEFAULT_INTERVAL_MINUTES,
    includeBreakdown = true,
    includeIndividualContributions = true,
    currentBG = null,
    t1dDuration = 5
  } = options;

  const timeline = [];
  const intervalMs = intervalMinutes * 60 * 1000;
  const now = Date.now();

  for (let time = startTime; time <= endTime; time += intervalMs) {
    const normalizedTime = TimeManager.normalize(time, TimeManager.precision.SECOND);
    const isHistorical = normalizedTime <= now;
    const isFuture = normalizedTime > now;

    const netEffect = await calculateNetEffectAtTime(
      meals,
      insulinDoses,
      normalizedTime,
      patientConstants,
      { currentBG: currentBG, t1dDuration: t1dDuration }
    );

    const timePoint = {
      timestamp: normalizedTime,
      readingTime: normalizedTime,
      formattedTime: new Date(normalizedTime).toLocaleTimeString(),
      isHistorical,
      isFuture,
      isNow: Math.abs(normalizedTime - now) < intervalMs / 2,

      // Current effects (rate of change)
      netEffect: netEffect.netEffect,
      mealImpact: netEffect.mealImpact,
      insulinImpact: Math.abs(netEffect.insulinImpact),
      insulinImpactSigned: netEffect.insulinImpact,
      pendingMealRise: netEffect.pendingMealRise,
      pendingInsulinReduction: netEffect.pendingInsulinReduction,

      // 🆕 NEW: Cumulative effects (bank balance)
      cumulativeMealEffect: netEffect.cumulativeMealEffect,
      cumulativeInsulinEffect: netEffect.cumulativeInsulinEffect,
      cumulativeNetBaseline: netEffect.cumulativeNetBaseline,

      // Absorbed and active amounts
      totalActiveCarbs: netEffect.totalActiveCarbs,
      totalActiveInsulin: netEffect.totalActiveInsulin,
      totalAbsorbedCarbs: netEffect.totalAbsorbedCarbs,
      totalAbsorbedInsulin: netEffect.totalAbsorbedInsulin,

      // Status and risk
      hasActiveEffects: netEffect.hasActiveEffects,
      status: netEffect.status,
      effectLevel: getEffectLevel(netEffect.netEffect),
      insulinStacking: netEffect.insulinStacking,
      mealStacking: netEffect.mealStacking,
      hypoRisk: netEffect.hypoRisk,
      hyperRisk: netEffect.hyperRisk
    };

    if (includeBreakdown) {
      timePoint.breakdown = calculateEffectBreakdown(netEffect);
    }

    if (includeIndividualContributions) {
      timePoint.mealContributions = netEffect.mobDetails?.mob?.meal_contributions || [];
      timePoint.insulinContributions = netEffect.iobDetails?.insulinContributions || [];
      // 🆕 NEW: Add cumulative contributions
      timePoint.mealCumulativeContributions = netEffect.mealCumulativeContributions || [];
      timePoint.insulinCumulativeContributions = netEffect.insulinCumulativeContributions || [];
    }

    timeline.push(timePoint);
  }

  return timeline;
}

export function calculateEffectBreakdown(netEffectData) {
  return {
    // Current impacts
    absorbedCarbsImpact: netEffectData.mealImpact || 0,
    pendingCarbsImpact: netEffectData.pendingMealRise || 0,
    totalMealImpact: (netEffectData.mealImpact || 0) + (netEffectData.pendingMealRise || 0),
    absorbedInsulinImpact: Math.abs(netEffectData.currentInsulinImpact || netEffectData.insulinImpact || 0),
    pendingInsulinImpact: netEffectData.pendingInsulinReduction || 0,
    totalInsulinImpact: Math.abs(netEffectData.insulinImpact || 0) + (netEffectData.pendingInsulinReduction || 0),
    netCurrent: netEffectData.netEffect || 0,
    netProjected: (netEffectData.netEffect || 0) +
                   (netEffectData.pendingMealRise || 0) -
                   (netEffectData.pendingInsulinReduction || 0),

    // 🆕 NEW: Cumulative impacts (three-term model)
    cumulativeMeal:     netEffectData.cumulativeMealEffect || 0,
    cumulativeInsulin:  netEffectData.cumulativeInsulinEffect || 0,
    cumulativeActivity: netEffectData.cumulativeActivityEffect || 0,    // ← new
    cumulativeNet:      netEffectData.cumulativeNetBaseline || 0
  };
}

export async function generateTimelineWithEffects(
  baseline,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const {
    startTime = Date.now() - (12 * 60 * 60 * 1000),
    endTime = Date.now() + (4 * 60 * 60 * 1000),
    intervalMinutes = 5,
    includeProjection = true,
    t1dDuration = 5
  } = options;

  const timeline = [];
  const intervalMs = intervalMinutes * 60 * 1000;
  const now = Date.now();

  for (let time = startTime; time <= endTime; time += intervalMs) {
    const isHistorical = time < now;
    const isFuture = time >= now;

    const netEffect = await calculateNetEffectAtTime(
      meals,
      insulinDoses,
      time,
      patientConstants,
      { t1dDuration }
    );

    // 🆕 NEW: Use cumulative baseline for BG estimation
    const estimatedBG = baseline + netEffect.cumulativeNetBaseline;
    const projectedFinalBG = isFuture
      ? baseline + netEffect.cumulativeNetBaseline + netEffect.pendingMealRise - netEffect.pendingInsulinReduction
      : null;

    const timePoint = {
      timestamp: time,
      formattedTime: new Date(time).toLocaleTimeString(),
      baseline: baseline,

      // Current effects
      netEffect: netEffect.netEffect,
      mealImpact: netEffect.mealImpact,
      insulinImpact: netEffect.insulinImpact,

      // 🆕 NEW: Cumulative effects
      cumulativeMealEffect: netEffect.cumulativeMealEffect,
      cumulativeInsulinEffect: netEffect.cumulativeInsulinEffect,
      cumulativeNetBaseline: netEffect.cumulativeNetBaseline,

      // BG estimates
      estimatedBG: Math.round(estimatedBG),
      projectedFinalBG: projectedFinalBG ? Math.round(projectedFinalBG) : null,

      // Amounts
      totalActiveCarbs: netEffect.totalActiveCarbs,
      totalActiveInsulin: netEffect.totalActiveInsulin,
      totalAbsorbedCarbs: netEffect.totalAbsorbedCarbs,
      totalAbsorbedInsulin: netEffect.totalAbsorbedInsulin,
      pendingMealRise: netEffect.pendingMealRise,
      pendingInsulinReduction: netEffect.pendingInsulinReduction,

      // Metadata
      isHistorical,
      isFuture,
      hasActiveEffects: netEffect.hasActiveEffects,
      status: netEffect.status,
      insulinStacking: netEffect.insulinStacking,
      mealStacking: netEffect.mealStacking,
      hypoRisk: netEffect.hypoRisk,
      hyperRisk: netEffect.hyperRisk
    };

    timeline.push(timePoint);
  }

  return timeline;
}

export async function generateChartTimeline(
  baseline,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const {
    startTime = Date.now() - (8 * 60 * 60 * 1000),
    endTime = Date.now() + (4 * 60 * 60 * 1000),
    intervalMinutes = 5
  } = options;

  const timeline = await generateTimelineWithEffects(
    baseline,
    meals,
    insulinDoses,
    patientConstants,
    {
      startTime,
      endTime,
      intervalMinutes,
      includeProjection: true,
      ...options
    }
  );

  return timeline.map(point => ({
    timestamp: point.timestamp,
    readingTime: point.timestamp,
    formattedTime: point.formattedTime,

    // Y-axis values for chart
    mealImpact: point.mealImpact,
    insulinImpact: point.insulinImpact,
    netEffect: point.netEffect,
    estimatedBG: point.estimatedBG,

    // 🆕 NEW: Cumulative line values
    cumulativeMealEffect: point.cumulativeMealEffect,
    cumulativeInsulinEffect: point.cumulativeInsulinEffect,
    cumulativeNetBaseline: point.cumulativeNetBaseline,

    // Tooltip data
    totalActiveCarbs: point.totalActiveCarbs,
    totalActiveInsulin: point.totalActiveInsulin,
    totalAbsorbedCarbs: point.totalAbsorbedCarbs,
    totalAbsorbedInsulin: point.totalAbsorbedInsulin,
    pendingMealRise: point.pendingMealRise,
    pendingInsulinReduction: point.pendingInsulinReduction,

    // Metadata
    isHistorical: point.isHistorical,
    isFuture: point.isFuture,
    hasActiveEffects: point.hasActiveEffects
  }));
}

// =====================================
// EFFECT LEVEL & COLOR HELPERS
// =====================================
export function getEffectLevel(netEffect) {
  const absEffect = Math.abs(netEffect);

  if (absEffect >= NET_EFFECT_CONSTANTS.EFFECT_LEVELS.CRITICAL_HIGH) {
    return 'critical';
  } else if (absEffect >= NET_EFFECT_CONSTANTS.EFFECT_LEVELS.HIGH) {
    return 'high';
  } else if (absEffect >= NET_EFFECT_CONSTANTS.EFFECT_LEVELS.MODERATE) {
    return 'moderate';
  } else if (absEffect >= NET_EFFECT_CONSTANTS.EFFECT_LEVELS.LOW) {
    return 'low';
  } else {
    return 'negligible';
  }
}

export function getEffectColor(netEffect) {
  if (netEffect > NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.HIGH_RISING) {
    return '#d32f2f'; // Critical red
  } else if (netEffect > NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.RISING) {
    return '#f44336'; // High red
  } else if (netEffect > NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.SLIGHTLY_RISING) {
    return '#ff9800'; // Orange
  } else if (netEffect > NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.STABLE_LOW &&
             netEffect <= NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.STABLE_HIGH) {
    return '#4caf50'; // Green (stable)
  } else if (netEffect > NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.SLIGHTLY_FALLING) {
    return '#2196f3'; // Light blue
  } else if (netEffect > NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS.FALLING) {
    return '#1976d2'; // Blue
  } else {
    return '#0d47a1'; // Dark blue
  }
}

export function getNetEffectStatus(netEffect) {
  const thresholds = NET_EFFECT_CONSTANTS.NET_EFFECT_THRESHOLDS;

  let level, description, color;

  if (netEffect > thresholds.HIGH_RISING) {
    level = 'high_rising';
    description = 'Rapidly Rising';
    color = '#d32f2f';
  } else if (netEffect > thresholds.RISING) {
    level = 'rising';
    description = 'Rising';
    color = '#ff8800';
  } else if (netEffect > thresholds.SLIGHTLY_RISING) {
    level = 'slightly_rising';
    description = 'Slightly Rising';
    color = '#ffa726';
  } else if (netEffect > thresholds.STABLE_LOW && netEffect <= thresholds.STABLE_HIGH) {
    level = 'stable';
    description = 'Stable';
    color = '#666666';
  } else if (netEffect > thresholds.SLIGHTLY_FALLING) {
    level = 'slightly_falling';
    description = 'Slightly Falling';
    color = '#82ca9d';
  } else if (netEffect > thresholds.FALLING) {
    level = 'falling';
    description = 'Falling';
    color = '#4CAF50';
  } else {
    level = 'rapidly_falling';
    description = 'Rapidly Falling';
    color = '#2e7d32';
  }

  return {
    level,
    description,
    color,
    arrow: getStatusArrow(level)
  };
}

function getStatusArrow(level) {
  const arrows = {
    'high_rising': '⬆️⬆️',
    'rising': '⬆️',
    'slightly_rising': '↗️',
    'stable': '➡️',
    'slightly_falling': '↘️',
    'falling': '⬇️',
    'rapidly_falling': '⬇️⬇️'
  };
  return arrows[level] || '➡️';
}

// =====================================
// DISPLAY FORMATTING WITH CUMULATIVE
// =====================================
export function formatNetEffectForDisplay(netEffectData, options = {}) {
  const {
    includeDetails = true,
    includeContributions = false,
    includeCumulative = true  // 🆕 NEW option
  } = options;

  const formatted = {
    // Current effects (rate of change)
    netEffect: {
      value: netEffectData.netEffect,
      formatted: `${netEffectData.netEffect > 0 ? '+' : ''}${netEffectData.netEffect.toFixed(1)} mg/dL`,
      status: netEffectData.status
    },
    currentImpacts: {
      meal: {
        value: netEffectData.mealImpact,
        formatted: `+${netEffectData.mealImpact.toFixed(1)} mg/dL`,
        label: 'Current BG Elevation (from absorbed carbs)'
      },
      insulin: {
        value: Math.abs(netEffectData.insulinImpact),
        formatted: `-${Math.abs(netEffectData.insulinImpact).toFixed(1)} mg/dL`,
        label: 'Current BG Reduction (from absorbed insulin)'
      }
    },
    pendingImpacts: {
      meal: {
        value: netEffectData.pendingMealRise,
        formatted: `+${netEffectData.pendingMealRise.toFixed(1)} mg/dL`,
        label: 'Pending BG Rise (from MOB)'
      },
      insulin: {
        value: netEffectData.pendingInsulinReduction,
        formatted: `-${netEffectData.pendingInsulinReduction.toFixed(1)} mg/dL`,
        label: 'Pending BG Reduction (from IOB)'
      }
    }
  };

  // 🆕 NEW: Cumulative effects section
  if (includeCumulative) {
    formatted.cumulativeEffects = {
      meal: {
        value: netEffectData.cumulativeMealEffect || 0,
        formatted: `+${(netEffectData.cumulativeMealEffect || 0).toFixed(1)} mg/dL`,
        label: 'Total Accumulated BG Rise (from all absorbed carbs)'
      },
      insulin: {
        value: netEffectData.cumulativeInsulinEffect || 0,
        formatted: `${(netEffectData.cumulativeInsulinEffect || 0).toFixed(1)} mg/dL`,
        label: 'Total Accumulated BG Reduction (from all absorbed insulin)'
      },
      net: {
        value: netEffectData.cumulativeNetBaseline || 0,
        formatted: `${netEffectData.cumulativeNetBaseline > 0 ? '+' : ''}${(netEffectData.cumulativeNetBaseline || 0).toFixed(1)} mg/dL`,
        label: 'Net Baseline Shift (your current position relative to baseline)'
      },
      activity: {
        value:     netEffectData.cumulativeActivityEffect || 0,
        formatted: `${(netEffectData.cumulativeActivityEffect || 0) > 0 ? '+' : ''}${(netEffectData.cumulativeActivityEffect || 0).toFixed(1)} mg/dL`,
        label:     'Activity BG Effect (acute IIRd + W-window)',
        sensitivityMultiplier: netEffectData.activitySensitivityMultiplier || 1.0,
        activityOnBoard:       netEffectData.activityOnBoard || 0,
      },
    };
  }

  if (includeDetails) {
    formatted.details = {
      absorbed: {
        carbs: `${netEffectData.totalAbsorbedCarbs.toFixed(1)}g`,
        insulin: `${netEffectData.totalAbsorbedInsulin.toFixed(2)}u`
      },
      active: {
        carbs: `${netEffectData.totalActiveCarbs.toFixed(1)}g`,
        insulin: `${netEffectData.totalActiveInsulin.toFixed(2)}u`
      }
    };
  }

  if (includeContributions && netEffectData.mobDetails && netEffectData.iobDetails) {
    formatted.contributions = {
      meals: formatMealContributionsForDisplay(netEffectData.mobDetails),
      insulin: formatInsulinContributionsForDisplay(netEffectData.iobDetails)
    };

    // 🆕 NEW: Cumulative contributions
    if (netEffectData.mealCumulativeContributions) {
      formatted.mealCumulativeContributions = netEffectData.mealCumulativeContributions;
    }
    if (netEffectData.insulinCumulativeContributions) {
      formatted.insulinCumulativeContributions = netEffectData.insulinCumulativeContributions;
    }
  }

  return formatted;
}

// =====================================
// TARGET RANGE CALCULATION
// =====================================
/**
 * Calculate blood glucose target range with insulin effect
 *
 * This shows where BG SHOULD BE after insulin acts, similar to
 * "Target + Meal Effect" but in reverse: "Baseline - Insulin Effect"
 *
 * @param {number} baselineBG - Starting BG without insulin effect
 * @param {number} targetBG - Target blood glucose
 * @param {number} insulinBGReduction - Current BG reduction from insulin
 * @returns {object} Target range with insulin effect
 */
export function calculateInsulinTargetRange(
  baselineBG,
  targetBG,
  insulinBGReduction
) {
  // Expected BG after insulin acts
  const expectedBG = baselineBG - insulinBGReduction;

  // Target range (±20% of target)
  const targetLow = targetBG * 0.8;
  const targetHigh = targetBG * 1.2;

  // Check if expected BG is in range
  const isInRange = expectedBG >= targetLow && expectedBG <= targetHigh;

  return {
    baselineBG: Math.round(baselineBG),
    expectedBG: Math.round(expectedBG),
    targetBG: targetBG,
    targetLow: Math.round(targetLow),
    targetHigh: Math.round(targetHigh),
    insulinBGReduction: Math.round(insulinBGReduction * 10) / 10,
    isInRange: isInRange,
    deviation: Math.round((expectedBG - targetBG) * 10) / 10
  };
}

/**
 * Format insulin BG impact for display
 *
 * Utility function to format data for UI components
 *
 * @param {object} insulinImpact - Impact data from calculateStackedInsulinBGImpact
 * @returns {object} Formatted display data
 */
export function formatInsulinBGImpactForDisplay(insulinImpact) {
  return {
    summary: {
      totalBGReduction: `${insulinImpact.totalBGReduction.toFixed(1)} mg/dL`,
      totalPendingReduction: `${insulinImpact.totalPendingReduction.toFixed(1)} mg/dL`,
      totalExpectedReduction: `${insulinImpact.totalExpectedReduction.toFixed(1)} mg/dL`,
      totalIOB: `${insulinImpact.totalIOB.toFixed(2)} units`,
      activeDoses: insulinImpact.activeDoses
    },
    contributions: insulinImpact.contributions.map(contrib => ({
      insulinType: contrib.insulinType,
      dose: `${contrib.dose.toFixed(1)}u`,
      hoursSinceDose: `${contrib.hoursSinceDose.toFixed(1)}h`,
      activity: `${contrib.activity.toFixed(1)}%`,
      activeInsulin: `${contrib.activeInsulin.toFixed(2)}u`,
      iob: `${contrib.iob.toFixed(2)}u`,
      currentDrop: `-${contrib.bgReduction.toFixed(1)} mg/dL`,
      pendingDrop: `-${contrib.pendingReduction.toFixed(1)} mg/dL`,
      status: getInsulinStatusLabel(contrib.hoursSinceDose, contrib.profile)
    })),
    warnings: generateInsulinBGWarnings(insulinImpact)
  };
}

/**
 * Get insulin status label based on time since dose
 *
 * @private
 */
function getInsulinStatusLabel(hoursSinceDose, profile) {
  if (hoursSinceDose < profile.onset) {
    return 'Starting';
  } else if (hoursSinceDose < profile.peak) {
    return 'Rising to Peak';
  } else if (hoursSinceDose < profile.peak * 1.5) {
    return 'At Peak';
  } else if (hoursSinceDose < profile.duration * 0.8) {
    return 'Active';
  } else {
    return 'Declining';
  }
}

/**
 * Generate warnings for insulin BG impact
 *
 * @private
 */
function generateInsulinBGWarnings(insulinImpact) {
  const warnings = [];

  if (insulinImpact.totalBGReduction > 150) {
    warnings.push({
      level: 'critical',
      message: 'Very high insulin effect - severe hypoglycemia risk',
      icon: '🚨'
    });
  } else if (insulinImpact.totalBGReduction > 100) {
    warnings.push({
      level: 'warning',
      message: 'High insulin effect - monitor for hypoglycemia',
      icon: '⚠️'
    });
  }

  if (insulinImpact.isStacking && insulinImpact.activeDoses >= 3) {
    warnings.push({
      level: 'warning',
      message: `${insulinImpact.activeDoses} doses overlapping - increased stacking risk`,
      icon: '💉'
    });
  }

  if (insulinImpact.totalPendingReduction > 80) {
    warnings.push({
      level: 'info',
      message: `${insulinImpact.totalPendingReduction.toFixed(0)} mg/dL additional drop expected from IOB`,
      icon: '⏳'
    });
  }

  return warnings;
}

// =====================================
// VALIDATION
// =====================================
export function validateNetEffectInputs(meals, insulinDoses, patientConstants) {
  const errors = [];
  const warnings = [];

  if (!patientConstants) {
    errors.push('Patient constants are required');
  } else {
    if (!patientConstants.carb_to_bg_factor) {
      warnings.push('Missing carb_to_bg_factor, using default');
    }
    if (!patientConstants.correction_factor) {
      warnings.push('Missing correction_factor, using default');
    }
  }

  if (meals && !Array.isArray(meals)) {
    errors.push('Meals must be an array');
  }

  if (insulinDoses && !Array.isArray(insulinDoses)) {
    errors.push('Insulin doses must be an array');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

// =====================================
// MARKER GENERATION
// =====================================
export function generateMealMarkers(meals, startTime, endTime) {
  return meals
    .filter(meal => {
      const mealTime = typeof meal.timestamp === 'number'
        ? meal.timestamp
        : new Date(meal.timestamp).getTime();
      return mealTime >= startTime && mealTime <= endTime;
    })
    .map(meal => {
      const mealTime = typeof meal.timestamp === 'number'
        ? meal.timestamp
        : new Date(meal.timestamp).getTime();

      const carbEquiv = meal.nutrition?.totalCarbEquiv ||
                       meal.nutrition?.total_carb_equiv ||
                       meal.carbEquiv || 0;

      return {
        timestamp: mealTime,
        readingTime: mealTime,
        type: 'meal',
        mealType: meal.mealType || 'meal',
        carbs: carbEquiv,
        absorptionType: meal.nutrition?.absorptionType ||
                       meal.nutrition?.absorption_type ||
                       'medium',
        label: `${meal.mealType || 'Meal'}: ${carbEquiv.toFixed(0)}g`,
        icon: '🍽️',
        color: '#ff9800'
      };
    });
}

export function generateInsulinMarkers(insulinDoses, startTime, endTime) {
  return insulinDoses
    .filter(dose => {
      const doseTime = typeof dose.administrationTime === 'number'
        ? dose.administrationTime
        : new Date(dose.administrationTime || dose.taken_at).getTime();
      return doseTime >= startTime && doseTime <= endTime;
    })
    .map(dose => {
      const doseTime = typeof dose.administrationTime === 'number'
        ? dose.administrationTime
        : new Date(dose.administrationTime || dose.taken_at).getTime();

      const insulinType = dose.medication || dose.insulinType || 'insulin';
      const profile = getInsulinProfile(insulinType);

      return {
        timestamp: doseTime,
        readingTime: doseTime,
        type: 'insulin',
        insulinType: insulinType,
        dose: dose.dose,
        profile: profile,
        label: `${dose.dose.toFixed(1)}u ${insulinType.replace('insulin_', '')}`,
        icon: '💉',
        color: '#2196f3'
      };
    });
}

// =====================================
// AXIS DOMAIN CALCULATION
// =====================================
export function calculateEffectsYAxisDomain(timeline, options = {}) {
  const {
    padding = 20,
    minRange = 100,
    includeCumulative = true  // 🆕 NEW option
  } = options;

  if (!timeline || timeline.length === 0) {
    return { min: -100, max: 100 };
  }

  const maxMealImpact = Math.max(...timeline.map(t => t.mealImpact || 0), 0);
  const maxInsulinImpact = Math.max(...timeline.map(t => Math.abs(t.insulinImpact || 0)), 0);
  const maxNetEffect = Math.max(...timeline.map(t => Math.abs(t.netEffect || 0)), 0);

  // 🆕 NEW: Include cumulative baseline in domain calculation
  let maxCumulative = 0;
  if (includeCumulative) {
    maxCumulative = Math.max(...timeline.map(t => Math.abs(t.cumulativeNetBaseline || 0)), 0);
  }

  const maxAbsoluteValue = Math.max(maxMealImpact, maxInsulinImpact, maxNetEffect, maxCumulative);
  const range = Math.max(maxAbsoluteValue + padding, minRange / 2);

  return {
    min: -range,
    max: range,
    maxMealImpact,
    maxInsulinImpact,
    maxNetEffect,
    maxCumulative  // 🆕 NEW
  };
}

// =====================================
// EXPORTS
// =====================================
export {
  getDailyResetTime,
  isWithinCurrentDay,
  calculateMealCumulativeEffect,
  calculateInsulinCumulativeEffect,
  // ✅ RE-EXPORT: Routing through service layer
  getAbsorptionProfile,
  getInsulinProfile,
};

export default {
  calculateNetEffectAtTime,
  calculateBaselineFromReading,
  calculateCurrentEstimatedBG,
  calculateProjectedFinalBG,
  generateTimelineWithEffects,
  generateChartTimeline,
  generateDetailedEffectsTimeline,
  calculateEffectBreakdown,
  getEffectLevel,
  getEffectColor,
  generateMealMarkers,
  generateInsulinMarkers,
  calculateEffectsYAxisDomain,
  analyzeInsulinStackingRisk,
  analyzeMealStackingRisk,
  analyzeHypoglycemiaRisk,
  analyzeHyperglycemiaRisk,
  calculateCounterRegulation,
  getT1DDurationLabel,
  checkInsulinDosingSafety,
  checkMealSafety,
  calculateSafeCorrectionDose,
  formatNetEffectForDisplay,
  validateNetEffectInputs,
  NET_EFFECT_CONSTANTS,
  getNetEffectStatus,
  // ✅ ADD: Include in default export too
  getDailyResetTime,
  isWithinCurrentDay,
  calculateMealCumulativeEffect,
  calculateInsulinCumulativeEffect,
  getAbsorptionProfile,
  getInsulinProfile,

  calculateInsulinTargetRange,
  formatInsulinBGImpactForDisplay
};