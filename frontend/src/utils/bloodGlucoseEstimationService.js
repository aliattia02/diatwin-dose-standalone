/**
 * ============================================================================
 * BLOOD GLUCOSE ESTIMATION SERVICE
 * ============================================================================
 *
 * Unified service for glucose estimation across SMBG and CGM use cases.
 * Implements T1D stable baseline model with confidence-weighted estimates.
 *
 * Key Features:
 * - Stable baseline calculation (no decay for T1D)
 * - Confidence-weighted estimation with multi-point validation
 * - Rate-of-change (velocity) analysis
 * - Smart interpolation between readings
 * - Detection of baseline shifts and pattern changes
 * - SMBG-optimized gap filling
 * - CGM-enhanced continuous tracking
 * - 🆕 CUMULATIVE EFFECT CALCULATION for consistent baseline tracking
 * - 🆕 USER-CONFIGURABLE DAILY RESET HOUR (v4.0)
 *
 * REFACTORING v4.0 (Configurable Reset Hour):
 * ✅ NEW FEATURE: Support for user-configurable daily reset hour via patientConstants.daily_reset_hour
 * ✅ UPDATED: All TimeManager.getDailyResetTime() calls now pass resetHour parameter
 * ✅ UPDATED: All TimeManager.isWithinCurrentDay() calls now pass resetHour parameter
 * ✅ UPDATED: TimeManager.isAtResetTime() calls now pass resetHour parameter
 * ✅ BENEFIT: Supports patients with different schedules (early risers at 5 AM, night owls at 9 AM)
 * ✅ DEFAULT: Defaults to 7 AM if not specified in patientConstants
 *
 * REFACTORING v3.2 (estimateGlucoseAtTime Fix):
 * ✅ CRITICAL FIX: estimateGlucoseAtTime now uses absorbed fractions (cumulative model)
 * ✅ Previously used MOB/IOB which drop to zero after absorption completes
 * ✅ Now uses calculateAbsorbedFraction / calculateIOB to compute absorbed amounts
 * ✅ Effects persist after absorption (matching T1D physiology)
 * ✅ Integrated daily reset logic via TimeManager
 * ✅ generateSmartInterpolation, generateGlucoseEstimations automatically fixed
 *
 * REFACTORING v3.1 (TimeManager Integration):
 * ✅ Integrated cumulative utilities into TimeManager v3.1
 * ✅ Now uses TimeManager.getDailyResetTime() instead of local implementation
 * ✅ Now uses TimeManager.isWithinCurrentDay() instead of inline logic
 * ✅ Ensures consistency across all services using TimeManager
 * ✅ Reduced code duplication by ~15 lines
 * ✅ No circular dependencies (TimeManager is foundation layer)
 *
 * Author: DiaTwin Team
 * Version: 4.0 (User-Configurable Daily Reset Hour)
 * ============================================================================
 */

import {
  calculateIOB,
  calculateInsulinActivity,
  getInsulinProfile
} from './insulinPharmacodynamics.js';

import {
  calculateMealActivity,
  calculateAbsorbedFraction,
  calculateMOB,
  calculateMealBGImpact,
  getAbsorptionProfile,
  getMealDuration,
  isMealActive
} from './mealPharmacodynamics.js';

import TimeManager from './TimeManager.js';

// ============================================================================
// DEBUG CONTROL
// ============================================================================

const DEBUG_BASELINE = false; // Set to true to enable detailed logging
const DEBUG_ABSORBED_CARBS = false;
const DEBUG_CUMULATIVE = false; // 🆕 Debug cumulative calculations
const DEBUG_ESTIMATE = false; // 🆕 Debug estimateGlucoseAtTime

// ============================================================================
// CONSTANTS
// ============================================================================

const ESTIMATION_CONSTANTS = {
  // Time thresholds for confidence decay
  CONFIDENCE_THRESHOLDS: {
    VERY_HIGH: 15,    // minutes - CGM-level confidence
    HIGH: 30,         // minutes - very reliable
    GOOD: 60,         // minutes - reliable
    MODERATE: 120,    // minutes - acceptable
    LOW: 180,         // minutes - declining
    VERY_LOW: 240     // minutes - unreliable
  },

  // Baseline validation
  BASELINE_STABILITY_THRESHOLD: 15, // mg/dL std dev
  MIN_READINGS_FOR_VALIDATION: 3,
  MAX_BASELINE_AGE_HOURS: 4,

  // Rate of change thresholds (mg/dL per minute)
  VELOCITY_THRESHOLDS: {
    RAPID_RISE: 2,
    RISING: 1,
    STABLE_HIGH: 0.5,
    STABLE_LOW: -0.5,
    FALLING: -1,
    RAPID_FALL: -2
  },

  // Interpolation
  MAX_INTERPOLATION_GAP_MINUTES: 180,
  INTERPOLATION_INTERVAL_MINUTES: 5,

  // CGM-specific
  CGM_READING_INTERVAL_MINUTES: 5,
  CGM_DATA_QUALITY_THRESHOLD: 0.8 // 80% data availability
};

// ============================================================================
// CORE BASELINE CALCULATION - UPDATED WITH CUMULATIVE EFFECTS
// ============================================================================

/**
 * Calculate stable T1D baseline from actual reading
 *
 * 🆕 CUMULATIVE EFFECTS UPDATE:
 * Now calculates BOTH instantaneous AND cumulative effects for consistency
 * with the BG estimation pipeline that uses cumulative baseline shifts.
 *
 * The cumulative approach treats absorbed carbs/insulin as a "bank balance"
 * that persists after absorption completes, matching T1D physiology where
 * BG elevation remains after meal absorption finishes.
 */
export function calculateStableBaseline(
  actualReading,
  readingTimestamp,
  meals,
  insulinDoses,
  patientConstants
) {
  const carbToBGFactor = patientConstants?.carb_to_bg_factor || 4.0;
  const correctionFactor = patientConstants?.correction_factor || 50;

  // ✅ NORMALIZE: Lock reading time to MINUTE BOUNDARY
  let rawReadingTime = typeof readingTimestamp === 'number' ? readingTimestamp :
                       new Date(readingTimestamp).getTime();
  const readingTime = TimeManager.normalize(rawReadingTime, TimeManager.precision.MINUTE);

  if (DEBUG_BASELINE) {
    console.log('🔍 calculateStableBaseline CALLED:', {
      actualReading,
      readingTime: new Date(readingTime).toLocaleTimeString(),
      rawReadingTime: new Date(rawReadingTime).toLocaleTimeString(),
      mealsProvided: meals ? meals.length : 'NULL',
      insulinProvided: insulinDoses ? insulinDoses.length : 'NULL',
      patientConstants: {
        carbToBG: carbToBGFactor,
        correctionFactor: correctionFactor
      }
    });
  }

  // ============================================================================
  // STEP 1: Calculate CUMULATIVE MEAL EFFECTS (Bank Balance Approach)
  // ============================================================================

  // Instantaneous values (what's happening at reading time)
  let totalAbsorbedCarbsAtReading = 0;
  let totalActiveMOBAtReading = 0;
  const activeMealsAtReading = [];

  // 🆕 CUMULATIVE values (total accumulated effect from all meals)
  let cumulativeTotalCarbsEaten = 0;
  let cumulativeTotalAbsorbedCarbs = 0;
  let cumulativeTotalActiveMOB = 0;

  // ✅ REFACTOR v3.1: Use TimeManager.getDailyResetTime (consolidated in TimeManager v3.1)
  // ✅ v4.0: Support configurable reset hour from patientConstants
  // ✅ D24: the boundary must be anchored on the PATIENT's local date, not the
  //    browser's. Omitting this argument gave a clinician reviewing a patient
  //    in another timezone their own reset hour applied to the patient's day,
  //    and made this path disagree with the charts on the same screen.
  const resetHour = patientConstants?.daily_reset_hour || 7;
  const tzOffsetMinutes = patientConstants?.timezone_offset_minutes != null
    ? patientConstants.timezone_offset_minutes
    : -(new Date(readingTime).getTimezoneOffset());
  const dailyResetTime = TimeManager.getDailyResetTime(readingTime, resetHour, tzOffsetMinutes);

  if (meals && Array.isArray(meals)) {
    if (DEBUG_BASELINE || DEBUG_CUMULATIVE) {
      console.log('🍽️ Processing meals for baseline calculation:');
      console.log('  Daily reset time (7 AM):', new Date(dailyResetTime).toLocaleString());
    }

    meals.forEach((meal, idx) => {
      // ✅ Robust timestamp parsing
      let mealTimestamp;
      if (typeof meal.timestamp === 'number') {
        mealTimestamp = meal.timestamp;
      } else if (meal.timestamp) {
        mealTimestamp = new Date(meal.timestamp).getTime();
      } else {
        if (DEBUG_BASELINE) {
          console.warn(`❌ Meal ${idx} has no valid timestamp`);
        }
        return;
      }

      // Skip future meals
      if (mealTimestamp > readingTime) {
        if (DEBUG_BASELINE) {
          console.log(`  ⏭️ Meal ${idx}: SKIPPED (future meal)`);
        }
        return;
      }

      // ✅ REFACTOR v3.1: Use TimeManager.isWithinCurrentDay (consolidated in TimeManager v3.1)
      // ✅ v4.0: Pass resetHour from patientConstants
      if (!TimeManager.isWithinCurrentDay(mealTimestamp, readingTime, resetHour, tzOffsetMinutes)) {
        if (DEBUG_BASELINE) {
          console.log(`  ⏭️ Meal ${idx}: SKIPPED (before ${resetHour}:00 reset at ${new Date(dailyResetTime).toLocaleTimeString()})`);
        }
        return;
      }

      // ✅ SECOND PRECISION: Calculate hours since meal
      const hoursSinceMealAtReading = TimeManager.calculateHoursSince(
        readingTime,
        mealTimestamp,
        TimeManager.precision.SECOND
      );

      const absorptionType = meal.absorptionType || 'medium';
      const profile = getAbsorptionProfile(absorptionType);

      if (!profile) {
        if (DEBUG_BASELINE) {
          console.warn(`❌ No profile found for absorption type: ${absorptionType}`);
        }
        return;
      }

      // Skip if meal hasn't started yet
      if (hoursSinceMealAtReading < 0) {
        if (DEBUG_BASELINE) {
          console.log(`  ⏭️ Meal ${idx}: SKIPPED (not started yet)`);
        }
        return;
      }

      const totalCarbs = meal.carbEquiv || 0;

      // ✅ FIX: Silently skip meals with 0 carbs
      if (totalCarbs === 0) {
        if (DEBUG_BASELINE) {
          console.warn(`  ⚠️ Meal ${idx}: Has 0 carbs`);
        }
        return;
      }

      // ============================================================================
      // 🆕 CUMULATIVE CALCULATION: Two-phase approach
      // ============================================================================

      // PHASE 1: Meal is ACTIVE (within duration)
      if (hoursSinceMealAtReading <= profile.duration_hours) {
        const absorbedFraction = calculateAbsorbedFraction(hoursSinceMealAtReading, profile);
        const absorbedCarbsAtReading = totalCarbs * absorbedFraction;
        const mobAtReading = totalCarbs * (1 - absorbedFraction);

        // Add to instantaneous totals
        totalAbsorbedCarbsAtReading += absorbedCarbsAtReading;
        totalActiveMOBAtReading += mobAtReading;

        // Add to cumulative totals (these persist)
        cumulativeTotalCarbsEaten += totalCarbs;
        cumulativeTotalAbsorbedCarbs += absorbedCarbsAtReading;
        cumulativeTotalActiveMOB += mobAtReading;

        if (DEBUG_CUMULATIVE) {
          console.log(`  📊 Meal ${idx} (ACTIVE):`, {
            id: meal.id,
            hoursSinceMeal: hoursSinceMealAtReading.toFixed(2),
            totalCarbs: totalCarbs.toFixed(1),
            absorbedFraction: (absorbedFraction * 100).toFixed(1) + '%',
            instantaneous: {
              absorbed: absorbedCarbsAtReading.toFixed(1),
              mob: mobAtReading.toFixed(1)
            },
            cumulative: {
              totalEaten: cumulativeTotalCarbsEaten.toFixed(1),
              totalAbsorbed: cumulativeTotalAbsorbedCarbs.toFixed(1),
              totalMOB: cumulativeTotalActiveMOB.toFixed(1)
            }
          });
        }

        activeMealsAtReading.push({
          id: meal.id,
          hoursSinceMeal: hoursSinceMealAtReading,
          totalCarbs,
          absorbedCarbs: absorbedCarbsAtReading,
          mob: mobAtReading,
          absorptionType: absorptionType,
          phase: 'active'
        });
      }
      // PHASE 2: Meal is COMPLETE (beyond duration) - FULLY ABSORBED
      else {
        // T1D Model: BG elevation persists after meal absorption completes
        cumulativeTotalCarbsEaten += totalCarbs;
        cumulativeTotalAbsorbedCarbs += totalCarbs; // 100% absorbed

        if (DEBUG_CUMULATIVE) {
          console.log(`  💚 Meal ${idx} (FULLY ABSORBED):`, {
            id: meal.id,
            hoursSinceMeal: hoursSinceMealAtReading.toFixed(2),
            totalCarbs: totalCarbs.toFixed(1),
            note: '✅ Absorbed - persists until 7 AM reset',
            cumulative: {
              totalEaten: cumulativeTotalCarbsEaten.toFixed(1),
              totalAbsorbed: cumulativeTotalAbsorbedCarbs.toFixed(1)
            }
          });
        }

        activeMealsAtReading.push({
          id: meal.id,
          hoursSinceMeal: hoursSinceMealAtReading,
          totalCarbs,
          absorbedCarbs: totalCarbs,
          mob: 0,
          absorptionType: absorptionType,
          phase: 'fully_absorbed'
        });
      }
    });
  }

  const mealImpactAtReading = totalAbsorbedCarbsAtReading * carbToBGFactor;
  const cumulativeMealEffect = cumulativeTotalAbsorbedCarbs * carbToBGFactor;

  if (DEBUG_BASELINE || DEBUG_CUMULATIVE) {
    console.log('🍽️ Meals processing COMPLETE:', {
      instantaneous: {
        absorbedCarbs: totalAbsorbedCarbsAtReading.toFixed(1),
        activeMOB: totalActiveMOBAtReading.toFixed(1),
        mealImpact: mealImpactAtReading.toFixed(1)
      },
      cumulative: {
        totalEaten: cumulativeTotalCarbsEaten.toFixed(1),
        totalAbsorbed: cumulativeTotalAbsorbedCarbs.toFixed(1),
        cumulativeEffect: cumulativeMealEffect.toFixed(1)
      },
      activeMealsCount: activeMealsAtReading.length
    });
  }

  // ============================================================================
  // STEP 2: Calculate CUMULATIVE INSULIN EFFECTS (Bank Balance Approach)
  // ============================================================================

  // Instantaneous values
  let totalAbsorbedInsulinAtReading = 0;
  let totalActiveIOBAtReading = 0;
  const activeInsulinAtReading = [];

  // 🆕 CUMULATIVE values
  let cumulativeTotalInsulinDosed = 0;
  let cumulativeTotalAbsorbedInsulin = 0;
  let cumulativeTotalActiveIOB = 0;

  if (insulinDoses && Array.isArray(insulinDoses)) {
    if (DEBUG_BASELINE || DEBUG_CUMULATIVE) {
      console.log('💉 Processing insulin doses:');
    }

    insulinDoses.forEach((dose, idx) => {
      // ✅ Robust timestamp parsing
      let doseTimestamp;
      if (typeof dose.administrationTime === 'number') {
        doseTimestamp = dose.administrationTime;
      } else if (dose.administrationTime) {
        doseTimestamp = new Date(dose.administrationTime).getTime();
      } else if (dose.taken_at) {
        doseTimestamp = new Date(dose.taken_at).getTime();
      } else {
        if (DEBUG_BASELINE) {
          console.warn(`❌ Insulin dose ${idx} has no valid timestamp`);
        }
        return;
      }

      if (doseTimestamp > readingTime) {
        if (DEBUG_BASELINE) {
          console.log(`  ⏭️ Insulin ${idx}: SKIPPED (future dose)`);
        }
        return;
      }

      // ✅ REFACTOR v3.1: Use TimeManager.isWithinCurrentDay
      // ✅ v4.0: Pass resetHour from patientConstants
      if (!TimeManager.isWithinCurrentDay(doseTimestamp, readingTime, resetHour, tzOffsetMinutes)) {
        if (DEBUG_BASELINE) {
          console.log(`  ⏭️ Insulin ${idx}: SKIPPED (before ${resetHour}:00 reset at ${new Date(dailyResetTime).toLocaleTimeString()})`);
        }
        return;
      }

      const hoursSinceDoseAtReading = TimeManager.calculateHoursSince(
        readingTime,
        doseTimestamp,
        TimeManager.precision.SECOND
      );

      const insulinType = dose.insulinType || dose.medication || 'regular_insulin';
      const profile = getInsulinProfile(insulinType);

      if (!profile) {
        if (DEBUG_BASELINE) {
          console.warn(`❌ No profile found for insulin type: ${insulinType}`);
        }
        return;
      }

      if (hoursSinceDoseAtReading < 0) {
        if (DEBUG_BASELINE) {
          console.log(`  ⏭️ Insulin ${idx}: SKIPPED (not started)`);
        }
        return;
      }

      const initialDose = dose.dose || 0;

      // ============================================================================
      // 🆕 CUMULATIVE CALCULATION: Two-phase approach
      // ============================================================================

      // PHASE 1: Insulin is ACTIVE (within duration)
      if (hoursSinceDoseAtReading <= profile.duration_hours) {
        const iobAtReading = calculateIOB(hoursSinceDoseAtReading, initialDose, profile);
        const absorbedInsulinAtReading = Math.max(0, initialDose - iobAtReading);

        // Add to instantaneous totals
        totalAbsorbedInsulinAtReading += absorbedInsulinAtReading;
        totalActiveIOBAtReading += iobAtReading;

        // Add to cumulative totals
        cumulativeTotalInsulinDosed += initialDose;
        cumulativeTotalAbsorbedInsulin += absorbedInsulinAtReading;
        cumulativeTotalActiveIOB += iobAtReading;

        if (DEBUG_CUMULATIVE) {
          console.log(`  💉 Insulin ${idx} (ACTIVE):`, {
            hoursSinceDose: hoursSinceDoseAtReading.toFixed(2),
            initialDose: initialDose.toFixed(2),
            instantaneous: {
              absorbed: absorbedInsulinAtReading.toFixed(2),
              iob: iobAtReading.toFixed(2)
            },
            cumulative: {
              totalDosed: cumulativeTotalInsulinDosed.toFixed(2),
              totalAbsorbed: cumulativeTotalAbsorbedInsulin.toFixed(2),
              totalIOB: cumulativeTotalActiveIOB.toFixed(2)
            }
          });
        }

        activeInsulinAtReading.push({
          insulinType: insulinType,
          hoursSinceDose: hoursSinceDoseAtReading,
          initialDose,
          absorbedInsulin: absorbedInsulinAtReading,
          iob: iobAtReading,
          phase: 'active'
        });
      }
      // PHASE 2: Insulin is FULLY ABSORBED (beyond duration)
      else {
        cumulativeTotalInsulinDosed += initialDose;
        cumulativeTotalAbsorbedInsulin += initialDose; // 100% absorbed

        if (DEBUG_CUMULATIVE) {
          console.log(`  💉 Insulin ${idx} (FULLY ABSORBED):`, {
            hoursSinceDose: hoursSinceDoseAtReading.toFixed(2),
            initialDose: initialDose.toFixed(2),
            note: '✅ Absorbed - persists until 7 AM reset',
            cumulative: {
              totalDosed: cumulativeTotalInsulinDosed.toFixed(2),
              totalAbsorbed: cumulativeTotalAbsorbedInsulin.toFixed(2)
            }
          });
        }

        activeInsulinAtReading.push({
          insulinType: insulinType,
          hoursSinceDose: hoursSinceDoseAtReading,
          initialDose,
          absorbedInsulin: initialDose,
          iob: 0,
          phase: 'fully_absorbed'
        });
      }
    });
  }

  const insulinImpactAtReading = totalAbsorbedInsulinAtReading * correctionFactor;
  const cumulativeInsulinEffect = cumulativeTotalAbsorbedInsulin * correctionFactor;

  if (DEBUG_BASELINE || DEBUG_CUMULATIVE) {
    console.log('💉 Insulin processing COMPLETE:', {
      instantaneous: {
        absorbedInsulin: totalAbsorbedInsulinAtReading.toFixed(2),
        activeIOB: totalActiveIOBAtReading.toFixed(2),
        insulinImpact: insulinImpactAtReading.toFixed(1)
      },
      cumulative: {
        totalDosed: cumulativeTotalInsulinDosed.toFixed(2),
        totalAbsorbed: cumulativeTotalAbsorbedInsulin.toFixed(2),
        cumulativeEffect: cumulativeInsulinEffect.toFixed(1)
      },
      activeInsulinCount: activeInsulinAtReading.length
    });
  }

  // ============================================================================
  // STEP 3: Calculate T1D Baseline - BOTH APPROACHES
  // ============================================================================

  // Instantaneous net effect (what's actively happening at reading time)
  const netEffectAtReading = mealImpactAtReading - insulinImpactAtReading;
  const baseline = actualReading - netEffectAtReading;

  // 🆕 Cumulative net effect (the "bank balance" that persists)
  const cumulativeNetEffect = cumulativeMealEffect - cumulativeInsulinEffect;
  const cumulativeBaseline = actualReading - cumulativeNetEffect;

  const isPhysiologicallyValid = baseline >= 20 && baseline <= 400;
  const hasActiveEffects = mealImpactAtReading > 0.1 || insulinImpactAtReading > 0.1;

  if (DEBUG_BASELINE || DEBUG_CUMULATIVE) {
    console.log('🎯 BASELINE CALCULATION FINAL RESULT:');
    console.log('  INSTANTANEOUS APPROACH (traditional):');
    console.log('    Actual Reading:', actualReading);
    console.log('    Meal Impact:', mealImpactAtReading.toFixed(1));
    console.log('    Insulin Impact:', insulinImpactAtReading.toFixed(1));
    console.log('    Net Effect:', netEffectAtReading.toFixed(1));
    console.log('    Baseline:', baseline.toFixed(1));
    console.log('');
    console.log('  🆕 CUMULATIVE APPROACH (bank balance):');
    console.log('    Actual Reading:', actualReading);
    console.log('    Cumulative Meal Effect:', cumulativeMealEffect.toFixed(1));
    console.log('    Cumulative Insulin Effect:', cumulativeInsulinEffect.toFixed(1));
    console.log('    Cumulative Net Effect:', cumulativeNetEffect.toFixed(1));
    console.log('    Cumulative Baseline:', cumulativeBaseline.toFixed(1));
    console.log('');
    console.log('  VALIDATION:');
    console.log('    Is Physiologically Valid:', isPhysiologicallyValid);
    console.log('    Has Active Effects:', hasActiveEffects);
  }

  return {
    // Traditional instantaneous baseline (for backward compatibility)
    baseline: Math.round(baseline),
    actualReading: Math.round(actualReading),
    netEffectAtReading: Math.round(netEffectAtReading * 10) / 10,
    mealImpact: Math.round(mealImpactAtReading * 10) / 10,
    insulinImpact: Math.round(insulinImpactAtReading * 10) / 10,
    absorbedCarbsAtReading: Math.round(totalAbsorbedCarbsAtReading * 10) / 10,
    absorbedInsulinAtReading: Math.round(totalAbsorbedInsulinAtReading * 100) / 100,
    activeMOBAtReading: Math.round(totalActiveMOBAtReading * 10) / 10,
    activeIOBAtReading: Math.round(totalActiveIOBAtReading * 100) / 100,

    // 🆕 CUMULATIVE VALUES (bank balance approach)
    cumulativeBaseline: Math.round(cumulativeBaseline),
    cumulativeNetEffect: Math.round(cumulativeNetEffect * 10) / 10,
    cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeTotalCarbsEaten: Math.round(cumulativeTotalCarbsEaten * 10) / 10,
    cumulativeTotalAbsorbedCarbs: Math.round(cumulativeTotalAbsorbedCarbs * 10) / 10,
    cumulativeTotalInsulinDosed: Math.round(cumulativeTotalInsulinDosed * 100) / 100,
    cumulativeTotalAbsorbedInsulin: Math.round(cumulativeTotalAbsorbedInsulin * 100) / 100,

    // Metadata
    hasActiveEffects: hasActiveEffects,
    activeMealsCount: activeMealsAtReading.length,
    activeInsulinCount: activeInsulinAtReading.length,
    timestamp: readingTime,
    rawTimestamp: rawReadingTime,
    isValid: isPhysiologicallyValid,
    mealContributions: activeMealsAtReading,
    insulinContributions: activeInsulinAtReading,
    timePrecision: 'second',
    timestampNormalization: 'minute_boundary',
    calculationApproach: 'dual', // Both instantaneous and cumulative
    warnings: isPhysiologicallyValid ? [] : ['Calculated baseline outside physiological range']
  };
}

/**
 * Calculate robust baseline from multiple readings (CGM or recent SMBG)
 * 🆕 Now includes cumulative effects in all calculations
 */
export function calculateRobustBaseline(
  recentReadings,
  meals,
  insulinDoses,
  patientConstants
) {
  if (!recentReadings || recentReadings.length === 0) {
    return {
      baseline: null,
      confidence: 'none',
      error: 'No readings available'
    };
  }

  // Calculate baseline for each reading
  const baselines = recentReadings.map(reading => {
    const result = calculateStableBaseline(
      reading.value,
      reading.timestamp,
      meals,
      insulinDoses,
      patientConstants
    );
    return {
      baseline: result.baseline,
      cumulativeBaseline: result.cumulativeBaseline, // 🆕
      timestamp: reading.timestamp,
      isValid: result.isValid,
      hasActiveEffects: result.hasActiveEffects
    };
  });

  // Filter out invalid baselines
  const validBaselines = baselines.filter(b => b.isValid);

  if (validBaselines.length === 0) {
    return {
      baseline: null,
      confidence: 'none',
      error: 'No valid baselines calculated'
    };
  }

  // Calculate mean baseline (use cumulative for better accuracy)
  const mean = validBaselines.reduce((sum, b) => sum + b.cumulativeBaseline, 0) / validBaselines.length;

  // Calculate standard deviation
  const variance = validBaselines.reduce((sum, b) => {
    const diff = b.cumulativeBaseline - mean;
    return sum + (diff * diff);
  }, 0) / validBaselines.length;
  const stdDev = Math.sqrt(variance);

  // Determine confidence level based on consistency
  let confidence;
  if (stdDev < 10) confidence = 'very_high';
  else if (stdDev < 15) confidence = 'high';
  else if (stdDev < 20) confidence = 'medium';
  else if (stdDev < 30) confidence = 'low';
  else confidence = 'very_low';

  return {
    baseline: Math.round(mean),
    cumulativeBaseline: Math.round(mean), // 🆕
    confidence: confidence,
    stability: {
      mean: Math.round(mean * 10) / 10,
      stdDev: Math.round(stdDev * 10) / 10,
      min: Math.round(Math.min(...validBaselines.map(b => b.cumulativeBaseline))),
      max: Math.round(Math.max(...validBaselines.map(b => b.cumulativeBaseline))),
      range: Math.round(Math.max(...validBaselines.map(b => b.cumulativeBaseline)) -
                       Math.min(...validBaselines.map(b => b.cumulativeBaseline)))
    },
    validReadingsCount: validBaselines.length,
    totalReadingsCount: recentReadings.length,
    timestamp: Date.now()
  };
}

// ============================================================================
// CONFIDENCE SCORING
// ============================================================================

/**
 * Calculate confidence for glucose estimation
 */
export function calculateEstimationConfidence(
  minutesSinceReading,
  hasActiveEffects = false,
  baselineStability = 0,
  dataSource = 'smbg'
) {
  const thresholds = ESTIMATION_CONSTANTS.CONFIDENCE_THRESHOLDS;

  // Base confidence from time
  let timeConfidenceValue;
  let timeConfidenceLevel;

  if (minutesSinceReading <= thresholds.VERY_HIGH) {
    timeConfidenceValue = 95;
    timeConfidenceLevel = 'very_high';
  } else if (minutesSinceReading <= thresholds.HIGH) {
    timeConfidenceValue = 85;
    timeConfidenceLevel = 'high';
  } else if (minutesSinceReading <= thresholds.GOOD) {
    timeConfidenceValue = 75;
    timeConfidenceLevel = 'medium';
  } else if (minutesSinceReading <= thresholds.MODERATE) {
    timeConfidenceValue = 60;
    timeConfidenceLevel = 'medium';
  } else if (minutesSinceReading <= thresholds.LOW) {
    timeConfidenceValue = 40;
    timeConfidenceLevel = 'low';
  } else if (minutesSinceReading <= thresholds.VERY_LOW) {
    timeConfidenceValue = 25;
    timeConfidenceLevel = 'very_low';
  } else {
    timeConfidenceValue = 15;
    timeConfidenceLevel = 'very_low';
  }

  // Adjust for active effects (they reduce confidence)
  let effectsAdjustment = 0;
  if (hasActiveEffects) {
    if (minutesSinceReading > 60) effectsAdjustment = -10;
    else if (minutesSinceReading > 120) effectsAdjustment = -20;
  }

  // Adjust for baseline stability
  let stabilityAdjustment = 0;
  if (baselineStability > 0) {
    if (baselineStability < 10) stabilityAdjustment = 5;
    else if (baselineStability < 15) stabilityAdjustment = 0;
    else if (baselineStability < 25) stabilityAdjustment = -5;
    else stabilityAdjustment = -10;
  }

  // CGM bonus (more frequent readings)
  const dataSourceBonus = dataSource === 'cgm' ? 5 : 0;

  // Calculate final confidence
  const finalValue = Math.max(0, Math.min(100,
    timeConfidenceValue + effectsAdjustment + stabilityAdjustment + dataSourceBonus
  ));

  // Determine final level
  let finalLevel;
  if (finalValue >= 85) finalLevel = 'very_high';
  else if (finalValue >= 70) finalLevel = 'high';
  else if (finalValue >= 50) finalLevel = 'medium';
  else if (finalValue >= 30) finalLevel = 'low';
  else finalLevel = 'very_low';

  return {
    value: finalValue,
    level: finalLevel,
    message: getConfidenceMessage(finalLevel, minutesSinceReading),
    breakdown: {
      timeConfidence: timeConfidenceValue,
      effectsAdjustment: effectsAdjustment,
      stabilityAdjustment: stabilityAdjustment,
      dataSourceBonus: dataSourceBonus
    }
  };
}

/**
 * Get user-friendly confidence message
 * @private
 */
function getConfidenceMessage(level, minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  switch(level) {
    case 'very_high':
      return `Very reliable estimate (reading ${timeStr} ago)`;
    case 'high':
      return `Reliable estimate (reading ${timeStr} ago)`;
    case 'medium':
      return `Moderate confidence (reading ${timeStr} ago) - consider checking glucose`;
    case 'low':
      return `Low confidence (reading ${timeStr} ago) - recommend testing`;
    case 'very_low':
      return `Very low confidence (reading ${timeStr} ago) - testing strongly recommended`;
    default:
      return `Unknown confidence level`;
  }
}

// ============================================================================
// GLUCOSE ESTIMATION - FIXED WITH CUMULATIVE ABSORBED FRACTIONS
// ============================================================================

/**
 * Estimate glucose at any timestamp using stable baseline + cumulative net effect
 *
 * ✅ CRITICAL FIX v3.2: Now uses ABSORBED FRACTIONS instead of MOB/IOB
 *
 * PREVIOUS BUG:
 * Used MOB (remaining carbs) and IOB (remaining insulin) which drop to zero
 * after absorption completes. This caused BG estimates to collapse back toward
 * baseline after meals/insulin finished absorbing — completely wrong for T1D.
 *
 * FIX:
 * Now calculates ABSORBED amounts (carbs absorbed into bloodstream, insulin
 * that has acted) which PERSIST after absorption. This matches the T1D model
 * where BG elevation from carbs only goes away when insulin counteracts it,
 * not when the meal finishes absorbing.
 *
 * Also integrates the 7 AM daily reset logic to ensure consistency with
 * calculateStableBaseline and calculateNetEffectAtTime.
 *
 * T1D MODEL: Estimated BG = Stable Baseline + Cumulative Net Effect (at target time)
 *   where Cumulative Net Effect = Σ(absorbedCarbs × carbToBGFactor) - Σ(absorbedInsulin × correctionFactor)
 *
 * @param {number} baseline - Calculated stable baseline BG (from calculateStableBaseline)
 * @param {number} targetTimestamp - Time to estimate glucose for
 * @param {number} lastReadingTimestamp - Timestamp of the most recent actual reading
 * @param {Array} meals - Array of meal objects with {timestamp, carbEquiv, absorptionType}
 * @param {Array} insulinDoses - Array of dose objects with {administrationTime|taken_at, dose, insulinType|medication}
 * @param {object} patientConstants - Patient-specific factors
 * @param {object} options - Additional options
 * @returns {object} Glucose estimation with breakdown
 */
export function estimateGlucoseAtTime(
  baseline,
  targetTimestamp,
  lastReadingTimestamp,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const {
    baselineStability = 0,
    dataSource = 'smbg',
    includeConfidence = true
  } = options;

  const carbToBGFactor = patientConstants?.carb_to_bg_factor || 4.0;
  const correctionFactor = patientConstants?.correction_factor || 50;
  // ✅ v4.0: Extract reset hour from patientConstants
  const resetHour = patientConstants?.daily_reset_hour || 7;

  // ✅ NORMALIZE: Target time to SECOND boundary
  const normalizedTargetTime = TimeManager.normalize(targetTimestamp, TimeManager.precision.SECOND);

  // ✅ D24: anchor the day on the patient's offset, not the browser's.
  const tzOffsetMinutes = patientConstants?.timezone_offset_minutes != null
    ? patientConstants.timezone_offset_minutes
    : -(new Date(normalizedTargetTime).getTimezoneOffset());

  // ✅ v3.2: Check if we're at the reset point
  // ✅ v4.0: Use configurable resetHour
  const isAtReset = TimeManager.isAtResetTime(normalizedTargetTime, resetHour, tzOffsetMinutes);

  if (DEBUG_ESTIMATE) {
    console.log('🔬 estimateGlucoseAtTime (v3.2 cumulative):', {
      baseline,
      targetTime: new Date(normalizedTargetTime).toLocaleString(),
      lastReading: new Date(lastReadingTimestamp).toLocaleString(),
      isAtReset,
      mealsCount: meals?.length || 0,
      insulinCount: insulinDoses?.length || 0
    });
  }

  // At 7 AM reset, cumulative effects are zero — return baseline directly
  if (isAtReset) {
    const minutesSinceReading = (normalizedTargetTime - lastReadingTimestamp) / 60000;
    const confidence = includeConfidence
      ? calculateEstimationConfidence(minutesSinceReading, false, baselineStability, dataSource)
      : null;

    return {
      estimatedGlucose: Math.round(baseline),
      baseline: baseline,
      netEffect: 0,
      cumulativeNetEffect: 0,
      mealImpact: 0,
      insulinImpact: 0,
      cumulativeMealEffect: 0,
      cumulativeInsulinEffect: 0,
      totalAbsorbedCarbs: 0,
      totalAbsorbedInsulin: 0,
      totalActiveCarbs: 0,
      totalActiveInsulin: 0,
      activeMeals: 0,
      activeDoses: 0,
      hasActiveEffects: false,
      timestamp: normalizedTargetTime,
      minutesSinceReading: Math.round(minutesSinceReading),
      confidence: confidence,
      isFuture: normalizedTargetTime > Date.now(),
      isInterpolated: normalizedTargetTime < Date.now() && normalizedTargetTime > lastReadingTimestamp,
      timePrecision: 'second',
      calculationModel: 'cumulative_v3.2',
      isAtDailyReset: true
    };
  }

  // ============================================================================
  // STEP 1: Calculate CUMULATIVE meal effects at target time
  // ============================================================================

  let cumulativeMealEffect = 0;
  let totalAbsorbedCarbs = 0;
  let totalActiveCarbs = 0; // MOB — for informational display only
  let activeMeals = 0;
  const mealContributions = [];

  if (meals && Array.isArray(meals)) {
    meals.forEach(meal => {
      // Parse meal timestamp robustly
      let mealTimestamp;
      if (typeof meal.timestamp === 'number') {
        mealTimestamp = meal.timestamp;
      } else if (meal.timestamp) {
        mealTimestamp = new Date(meal.timestamp).getTime();
      } else {
        return; // Skip meals without valid timestamp
      }

      // ✅ v3.2: Apply daily reset filter — only include meals from current day
      // ✅ v4.0: Use configurable resetHour
      if (!TimeManager.isWithinCurrentDay(mealTimestamp, normalizedTargetTime, resetHour, tzOffsetMinutes)) {
        return;
      }

      // Skip future meals (relative to target time)
      if (mealTimestamp > normalizedTargetTime) {
        return;
      }

      const hoursSinceMeal = TimeManager.calculateHoursSince(
        normalizedTargetTime,
        mealTimestamp,
        TimeManager.precision.SECOND
      );

      if (hoursSinceMeal < 0) return;

      const absorptionType = meal.absorptionType || meal.nutrition?.absorptionType || 'medium';
      const profile = getAbsorptionProfile(absorptionType);
      if (!profile) return;

      const totalCarbs = meal.carbEquiv || meal.nutrition?.totalCarbEquiv || 0;
      if (totalCarbs <= 0) return;

      // ✅ CRITICAL FIX v3.2: Use ABSORBED FRACTION (cumulative, persists)
      // instead of MOB (which drops to zero)

      let absorbedFraction;
      let absorbedCarbs;
      let activeCarbs;
      let isComplete;

      if (hoursSinceMeal >= profile.duration_hours) {
        // PHASE 2: Meal fully absorbed — 100% persists
        absorbedFraction = 1.0;
        absorbedCarbs = totalCarbs;
        activeCarbs = 0;
        isComplete = true;
      } else {
        // PHASE 1: Meal still absorbing — partial absorption
        absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
        absorbedCarbs = totalCarbs * absorbedFraction;
        activeCarbs = totalCarbs * (1 - absorbedFraction);
        isComplete = false;
      }

      // T1D Model: BG elevation = absorbed carbs × carb-to-BG factor
      // This PERSISTS — it doesn't go away when MOB reaches zero
      const bgElevation = absorbedCarbs * carbToBGFactor;

      cumulativeMealEffect += bgElevation;
      totalAbsorbedCarbs += absorbedCarbs;
      totalActiveCarbs += activeCarbs;

      if (absorbedCarbs > 0.01 || activeCarbs > 0.01) {
        activeMeals++;
      }

      if (DEBUG_ESTIMATE) {
        console.log(`  🍽️ Meal: ${totalCarbs.toFixed(1)}g, ${hoursSinceMeal.toFixed(2)}h ago, ` +
          `absorbed: ${absorbedCarbs.toFixed(1)}g (${(absorbedFraction * 100).toFixed(0)}%), ` +
          `BG elevation: +${bgElevation.toFixed(1)} mg/dL, ` +
          `complete: ${isComplete}`);
      }

      mealContributions.push({
        mealId: meal.id || meal._id,
        totalCarbs,
        absorbedCarbs: Math.round(absorbedCarbs * 10) / 10,
        activeCarbs: Math.round(activeCarbs * 10) / 10,
        absorbedPercent: Math.round(absorbedFraction * 100),
        bgElevation: Math.round(bgElevation * 10) / 10,
        hoursSinceMeal: Math.round(hoursSinceMeal * 100) / 100,
        absorptionType,
        isComplete
      });
    });
  }

  // ============================================================================
  // STEP 2: Calculate CUMULATIVE insulin effects at target time
  // ============================================================================

  let cumulativeInsulinEffect = 0;
  let totalAbsorbedInsulin = 0;
  let totalActiveInsulin = 0; // IOB — for informational display only
  let activeDoses = 0;
  const insulinContributions = [];

  if (insulinDoses && Array.isArray(insulinDoses)) {
    insulinDoses.forEach(dose => {
      // Parse dose timestamp robustly
      let doseTimestamp;
      if (typeof dose.administrationTime === 'number') {
        doseTimestamp = dose.administrationTime;
      } else if (dose.administrationTime) {
        doseTimestamp = new Date(dose.administrationTime).getTime();
      } else if (dose.taken_at) {
        doseTimestamp = new Date(dose.taken_at).getTime();
      } else {
        return; // Skip doses without valid timestamp
      }

      // ✅ v3.2: Apply daily reset filter — only include doses from current day
      // ✅ v4.0: Use configurable resetHour
      if (!TimeManager.isWithinCurrentDay(doseTimestamp, normalizedTargetTime, resetHour, tzOffsetMinutes)) {
        return;
      }

      // Skip future doses (relative to target time)
      if (doseTimestamp > normalizedTargetTime) {
        return;
      }

      const hoursSinceDose = TimeManager.calculateHoursSince(
        normalizedTargetTime,
        doseTimestamp,
        TimeManager.precision.SECOND
      );

      if (hoursSinceDose < 0) return;

      const insulinType = dose.insulinType || dose.medication || 'regular_insulin';
      const profile = getInsulinProfile(insulinType);
      if (!profile) return;

      const initialDose = dose.dose || 0;
      if (initialDose <= 0) return;

      // ✅ CRITICAL FIX v3.2: Use ABSORBED INSULIN (cumulative, persists)
      // instead of IOB (which drops to zero)

      let absorbedInsulin;
      let iob;
      let isComplete;

      if (hoursSinceDose >= profile.duration_hours) {
        // PHASE 2: Insulin fully absorbed — 100% has acted
        absorbedInsulin = initialDose;
        iob = 0;
        isComplete = true;
      } else {
        // PHASE 1: Insulin still active — partial absorption
        iob = calculateIOB(hoursSinceDose, initialDose, profile);
        absorbedInsulin = Math.max(0, initialDose - iob);
        isComplete = false;
      }

      // T1D Model: BG reduction = absorbed insulin × correction factor
      // This PERSISTS — it doesn't go away when IOB reaches zero
      const bgReduction = absorbedInsulin * correctionFactor;

      cumulativeInsulinEffect += bgReduction;
      totalAbsorbedInsulin += absorbedInsulin;
      totalActiveInsulin += iob;

      if (absorbedInsulin > 0.001 || iob > 0.001) {
        activeDoses++;
      }

      if (DEBUG_ESTIMATE) {
        console.log(`  💉 Insulin: ${initialDose.toFixed(2)}u ${insulinType}, ${hoursSinceDose.toFixed(2)}h ago, ` +
          `absorbed: ${absorbedInsulin.toFixed(2)}u, IOB: ${iob.toFixed(2)}u, ` +
          `BG reduction: -${bgReduction.toFixed(1)} mg/dL, ` +
          `complete: ${isComplete}`);
      }

      insulinContributions.push({
        insulinType,
        initialDose,
        absorbedInsulin: Math.round(absorbedInsulin * 100) / 100,
        iob: Math.round(iob * 100) / 100,
        bgReduction: Math.round(bgReduction * 10) / 10,
        hoursSinceDose: Math.round(hoursSinceDose * 100) / 100,
        isComplete
      });
    });
  }

  // ============================================================================
  // STEP 3: Calculate Estimated BG using CUMULATIVE model
  // ============================================================================

  // T1D: Estimated BG = Stable Baseline + Cumulative Meal Effect - Cumulative Insulin Effect
  const cumulativeNetEffect = cumulativeMealEffect - cumulativeInsulinEffect;

  // ── Activity third term ─────────────────────────────────────────────────
  // cumulativeActivityEffect is passed via options.activityEffect (signed mg/dL).
  // When absent (options not provided or activity fetch failed) it defaults to 0,
  // preserving full backward compatibility.
  const activityEffect = options?.activityEffect ?? 0;

  const estimatedGlucose = baseline + cumulativeNetEffect + activityEffect;

  // Also compute the instantaneous "net effect" for legacy compatibility
  // This represents the rate-of-change contribution (from still-absorbing effects only)
  const instantaneousMealImpact = totalActiveCarbs * carbToBGFactor; // From MOB
  const instantaneousInsulinImpact = totalActiveInsulin * correctionFactor; // From IOB
  const instantaneousNetEffect = instantaneousMealImpact - instantaneousInsulinImpact;

  const hasActiveEffects = totalActiveCarbs > 0.1 || totalActiveInsulin > 0.01;

  // Calculate confidence
  const minutesSinceReading = (normalizedTargetTime - lastReadingTimestamp) / 60000;

  const confidence = includeConfidence
    ? calculateEstimationConfidence(minutesSinceReading, hasActiveEffects, baselineStability, dataSource)
    : null;

  if (DEBUG_ESTIMATE) {
    console.log('📊 estimateGlucoseAtTime RESULT:', {
      baseline,
      cumulativeMealEffect: cumulativeMealEffect.toFixed(1),
      cumulativeInsulinEffect: cumulativeInsulinEffect.toFixed(1),
      cumulativeNetEffect: cumulativeNetEffect.toFixed(1),
      estimatedGlucose: Math.round(estimatedGlucose),
      absorbedCarbs: totalAbsorbedCarbs.toFixed(1),
      absorbedInsulin: totalAbsorbedInsulin.toFixed(2),
      activeCarbs_MOB: totalActiveCarbs.toFixed(1),
      activeInsulin_IOB: totalActiveInsulin.toFixed(2),
      activeMeals,
      activeDoses
    });
  }

  return {
    estimatedGlucose: Math.round(estimatedGlucose),
    baseline: baseline,
    activityEffect: activityEffect,   // surfaced so callers can display the activity contribution

    // ✅ v3.2: Primary field is now cumulative net effect
    netEffect: Math.round(cumulativeNetEffect * 10) / 10,
    cumulativeNetEffect: Math.round(cumulativeNetEffect * 10) / 10,

    // Cumulative effects (persistent — the "bank balance")
    cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,

    // Legacy fields: mealImpact/insulinImpact now reflect cumulative too
    // This prevents consumers from getting the wrong (MOB-based) values
    mealImpact: Math.round(cumulativeMealEffect * 10) / 10,
    insulinImpact: Math.round(cumulativeInsulinEffect * 10) / 10,

    // Instantaneous effects (rate of change — for visualization curves)
    instantaneousMealImpact: Math.round(instantaneousMealImpact * 10) / 10,
    instantaneousInsulinImpact: Math.round(instantaneousInsulinImpact * 10) / 10,
    instantaneousNetEffect: Math.round(instantaneousNetEffect * 10) / 10,

    // Absorbed amounts (what's in bloodstream — cumulative)
    totalAbsorbedCarbs: Math.round(totalAbsorbedCarbs * 10) / 10,
    totalAbsorbedInsulin: Math.round(totalAbsorbedInsulin * 100) / 100,

    // Active amounts (what's still absorbing — instantaneous)
    totalActiveCarbs: Math.round(totalActiveCarbs * 10) / 10,
    totalActiveInsulin: Math.round(totalActiveInsulin * 100) / 100,

    // Pending effects (from still-absorbing amounts)
    pendingMealRise: Math.round((totalActiveCarbs * carbToBGFactor) * 10) / 10,
    pendingInsulinReduction: Math.round((totalActiveInsulin * correctionFactor) * 10) / 10,

    // ── Activity-adjusted projection ─────────────────────────────────────
    // When post-exercise sensitivity is active (W window), the effective ISF is
    // boosted. We scale the pending insulin reduction accordingly so the
    // projected BG accounts for the enhanced sensitivity.
    // If no activityPD is available, sensitivityMultiplier = 1.0 → no change.
    ...(() => {
      const sensitivityMultiplier = options?.activityPD?.sensitivity_multiplier ?? 1.0;
      const sensitivityScaledPendingReduction =
        (totalActiveInsulin * correctionFactor) * sensitivityMultiplier;
      const projectedFinalBG =
        baseline +
        cumulativeNetEffect +
        activityEffect +
        (totalActiveCarbs * carbToBGFactor) -
        sensitivityScaledPendingReduction;
      return {
        sensitivityMultiplier: Math.round(sensitivityMultiplier * 100) / 100,
        sensitivityScaledPendingReduction: Math.round(sensitivityScaledPendingReduction * 10) / 10,
        projectedFinalBG: Math.round(projectedFinalBG),
      };
    })(),

    // Detailed contributions for tooltips
    mealContributions: mealContributions,
    insulinContributions: insulinContributions,

    // Metadata
    activeMeals: activeMeals,
    activeDoses: activeDoses,
    hasActiveEffects: hasActiveEffects,
    timestamp: normalizedTargetTime,
    minutesSinceReading: Math.round(minutesSinceReading),
    confidence: confidence,
    isFuture: normalizedTargetTime > Date.now(),
    isInterpolated: normalizedTargetTime < Date.now() && normalizedTargetTime > lastReadingTimestamp,
    timePrecision: 'second',
    calculationModel: 'cumulative_v3.2',
    isAtDailyReset: false
  };
}

// ============================================================================
// RATE OF CHANGE (VELOCITY) ANALYSIS
// ============================================================================

/**
 * Calculate glucose velocity (rate of change)
 *
 * Essential for trend arrows and predicting hypoglycemia/hyperglycemia
 */
export function calculateGlucoseVelocity(currentReading, previousReading) {
  if (!currentReading || !previousReading) {
    return {
      velocity: 0,
      trend: 'unknown',
      arrow: '➡️',
      message: 'Insufficient data for trend'
    };
  }

  const deltaTime = (currentReading.timestamp - previousReading.timestamp) / 60000; // minutes
  const deltaGlucose = currentReading.value - previousReading.value;
  const velocity = deltaGlucose / deltaTime; // mg/dL per minute
  const velocityPerHour = velocity * 60;

  const thresholds = ESTIMATION_CONSTANTS.VELOCITY_THRESHOLDS;

  // Determine trend
  let trend, arrow, message, severity;

  if (velocity >= thresholds.RAPID_RISE) {
    trend = 'rapid_rise';
    arrow = '⬆️⬆️';
    message = `Rising rapidly (${Math.round(velocityPerHour)} mg/dL/hr)`;
    severity = 'high';
  } else if (velocity >= thresholds.RISING) {
    trend = 'rising';
    arrow = '⬆️';
    message = `Rising (${Math.round(velocityPerHour)} mg/dL/hr)`;
    severity = 'medium';
  } else if (velocity >= thresholds.STABLE_HIGH) {
    trend = 'stable_high';
    arrow = '↗️';
    message = `Slightly rising (${Math.round(velocityPerHour)} mg/dL/hr)`;
    severity = 'low';
  } else if (velocity >= thresholds.STABLE_LOW) {
    trend = 'stable';
    arrow = '➡️';
    message = 'Stable';
    severity = 'none';
  } else if (velocity >= thresholds.FALLING) {
    trend = 'stable_low';
    arrow = '↘️';
    message = `Slightly falling (${Math.round(Math.abs(velocityPerHour))} mg/dL/hr)`;
    severity = 'low';
  } else if (velocity >= thresholds.RAPID_FALL) {
    trend = 'falling';
    arrow = '⬇️';
    message = `Falling (${Math.round(Math.abs(velocityPerHour))} mg/dL/hr)`;
    severity = 'medium';
  } else {
    trend = 'rapid_fall';
    arrow = '⬇️⬇️';
    message = `Falling rapidly (${Math.round(Math.abs(velocityPerHour))} mg/dL/hr)`;
    severity = 'high';
  }

  return {
    velocity: Math.round(velocity * 100) / 100,
    velocityPerHour: Math.round(velocityPerHour),
    trend: trend,
    arrow: arrow,
    message: message,
    severity: severity,
    deltaTime: Math.round(deltaTime),
    deltaGlucose: Math.round(deltaGlucose),
    direction: velocity > 0 ? 'up' : velocity < 0 ? 'down' : 'stable'
  };
}

/**
 * Predict glucose value using velocity
 */
export function predictGlucoseFromVelocity(currentGlucose, velocity, minutesAhead) {
  const prediction = currentGlucose + (velocity * minutesAhead);

  return {
    predicted: Math.round(prediction),
    minutesAhead: minutesAhead,
    confidence: minutesAhead <= 30 ? 'high' : minutesAhead <= 60 ? 'medium' : 'low'
  };
}

// ============================================================================
// INTERPOLATION
// ============================================================================

/**
 * Smart interpolation between two readings accounting for active effects
 */
export function generateSmartInterpolation(
  reading1,
  reading2,
  meals,
  insulinDoses,
  patientConstants
) {
  const timeDiff = reading2.timestamp - reading1.timestamp;
  const timeDiffMinutes = timeDiff / 60000;

  // Don't interpolate if readings are too close or too far apart
  if (timeDiffMinutes < 5 || timeDiffMinutes > ESTIMATION_CONSTANTS.MAX_INTERPOLATION_GAP_MINUTES) {
    return [];
  }

  // Calculate baseline from first reading
  const baselineResult = calculateStableBaseline(
    reading1.value,
    reading1.timestamp,
    meals,
    insulinDoses,
    patientConstants
  );

  if (!baselineResult.baseline) {
    return [];
  }

  const baseline = baselineResult.baseline;
  const intervalMinutes = ESTIMATION_CONSTANTS.INTERPOLATION_INTERVAL_MINUTES;
  const numPoints = Math.floor(timeDiffMinutes / intervalMinutes) - 1;

  const interpolatedPoints = [];

  for (let i = 1; i <= numPoints; i++) {
    const timestamp = reading1.timestamp + (i * intervalMinutes * 60000);

    const estimate = estimateGlucoseAtTime(
      baseline,
      timestamp,
      reading1.timestamp,
      meals,
      insulinDoses,
      patientConstants,
      {
        includeConfidence: true,
        dataSource: 'smbg'
      }
    );

    interpolatedPoints.push({
      timestamp: timestamp,
      value: estimate.estimatedGlucose,
      confidence: estimate.confidence,
      source: 'interpolated',
      baseline: baseline
    });
  }

  return interpolatedPoints;
}

// ============================================================================
// SMBG-SPECIFIC FUNCTIONS
// ============================================================================

/**
 * Recommend next reading time based on current state
 */
export function recommendNextReading(
  currentEstimate,
  meals,
  insulinDoses,
  patientConstants
) {
  const glucose = currentEstimate.estimatedGlucose;
  const hasActiveEffects = currentEstimate.hasActiveEffects;
  const minutesSinceReading = currentEstimate.minutesSinceReading;

  let recommendedMinutes;
  let priority;
  let reason;

  // Critical levels - test immediately
  if (glucose < 70 || glucose > 250) {
    recommendedMinutes = 15;
    priority = 'urgent';
    reason = glucose < 70 ? 'Low glucose' : 'High glucose';
  }
  // Active effects - monitor closely
  else if (hasActiveEffects) {
    recommendedMinutes = 60;
    priority = 'high';
    reason = 'Active insulin or meal effects';
  }
  // Older reading - test sooner
  else if (minutesSinceReading > 180) {
    recommendedMinutes = 30;
    priority = 'high';
    reason = 'Reading is getting old';
  }
  // Stable state
  else {
    recommendedMinutes = 120;
    priority = 'routine';
    reason = 'Routine monitoring';
  }

  const nextReadingTime = Date.now() + (recommendedMinutes * 60000);

  return {
    recommendedMinutes: recommendedMinutes,
    nextReadingTime: nextReadingTime,
    priority: priority,
    reason: reason,
    message: `Recommend testing in ${recommendedMinutes} minutes (${reason})`
  };
}

// ============================================================================
// CGM-SPECIFIC FUNCTIONS
// ============================================================================

/**
 * Detect significant baseline shifts (for T1D therapy adjustments)
 */
export function detectBaselineShift(baselineHistory, thresholdMgDl = 20) {
  if (!baselineHistory || baselineHistory.length < 5) {
    return {
      hasShift: false,
      message: 'Insufficient data for baseline shift detection'
    };
  }

  // Compare recent baselines to older baselines
  const recent = baselineHistory.slice(-3);
  const older = baselineHistory.slice(0, Math.min(5, baselineHistory.length - 3));

  const recentMean = recent.reduce((sum, b) => sum + b.value, 0) / recent.length;
  const olderMean = older.reduce((sum, b) => sum + b.value, 0) / older.length;

  const shift = recentMean - olderMean;
  const isSignificant = Math.abs(shift) >= thresholdMgDl;

  return {
    hasShift: isSignificant,
    shift: Math.round(shift),
    direction: shift > 0 ? 'increase' : 'decrease',
    recentBaseline: Math.round(recentMean),
    previousBaseline: Math.round(olderMean),
    message: isSignificant
      ? `Baseline has ${shift > 0 ? 'increased' : 'decreased'} by ${Math.abs(Math.round(shift))} mg/dL`
      : 'No significant baseline shift detected',
    recommendation: isSignificant
      ? 'Consider consulting your healthcare provider to adjust therapy parameters'
      : null
  };
}

/**
 * Calculate data quality metrics for CGM
 */
export function assessCGMDataQuality(readings, expectedIntervalMinutes = 5) {
  if (!readings || readings.length === 0) {
    return {
      quality: 'none',
      message: 'No CGM data available'
    };
  }

  const timeSpan = readings[readings.length - 1].timestamp - readings[0].timestamp;
  const expectedReadings = timeSpan / (expectedIntervalMinutes * 60 * 1000);
  const actualReadings = readings.length;
  const dataAvailability = actualReadings / expectedReadings;

  // Check for gaps
  let maxGapMinutes = 0;
  let gapsCount = 0;

  for (let i = 1; i < readings.length; i++) {
    const gapMinutes = (readings[i].timestamp - readings[i - 1].timestamp) / 60000;
    if (gapMinutes > expectedIntervalMinutes * 1.5) {
      gapsCount++;
      maxGapMinutes = Math.max(maxGapMinutes, gapMinutes);
    }
  }

  // Determine quality level
  let quality;
  if (dataAvailability >= 0.95) quality = 'excellent';
  else if (dataAvailability >= 0.85) quality = 'good';
  else if (dataAvailability >= 0.70) quality = 'fair';
  else quality = 'poor';

  return {
    quality: quality,
    dataAvailability: Math.round(dataAvailability * 100),
    expectedReadings: Math.round(expectedReadings),
    actualReadings: actualReadings,
    missingReadings: Math.round(expectedReadings - actualReadings),
    gapsCount: gapsCount,
    maxGapMinutes: Math.round(maxGapMinutes),
    message: `CGM data quality: ${quality} (${Math.round(dataAvailability * 100)}% availability)`,
    warnings: []
  };
}

// ============================================================================
// UNIFIED ESTIMATION PIPELINE
// ============================================================================

/**
 * Complete glucose estimation pipeline - handles both SMBG and CGM
 *
 * This is the main entry point for glucose estimation
 */
export function generateGlucoseEstimations(
  actualReadings,
  meals,
  insulinDoses,
  patientConstants,
  options = {}
) {
  const {
    dataSource = 'smbg', // 'smbg' or 'cgm'
    includeInterpolation = true,
    includeFutureProjection = true,
    projectionHours = 4,
    targetTimestamp = Date.now()
  } = options;

  // Validate inputs
  if (!actualReadings || actualReadings.length === 0) {
    return {
      success: false,
      error: 'No actual readings provided',
      estimations: []
    };
  }

  // Sort readings by time
  const sortedReadings = [...actualReadings].sort((a, b) => a.timestamp - b.timestamp);
  const mostRecentReading = sortedReadings[sortedReadings.length - 1];

  // Calculate robust baseline (use multiple readings if available)
  const baselineResult = sortedReadings.length >= 3
    ? calculateRobustBaseline(sortedReadings.slice(-5), meals, insulinDoses, patientConstants)
    : calculateStableBaseline(
        mostRecentReading.value,
        mostRecentReading.timestamp,
        meals,
        insulinDoses,
        patientConstants
      );

  if (!baselineResult.baseline) {
    return {
      success: false,
      error: 'Unable to calculate valid baseline',
      estimations: []
    };
  }

  const baseline = baselineResult.baseline;
  const baselineStability = baselineResult.stability?.stdDev || 0;

  const estimations = [];

  // Generate current estimate
  const currentEstimate = estimateGlucoseAtTime(
    baseline,
    targetTimestamp,
    mostRecentReading.timestamp,
    meals,
    insulinDoses,
    patientConstants,
    {
      baselineStability: baselineStability,
      dataSource: dataSource,
      includeConfidence: true
    }
  );

  estimations.push({
    ...currentEstimate,
    type: 'current',
    source: 'estimation'
  });

  // Generate interpolations between readings (for SMBG)
  if (includeInterpolation && dataSource === 'smbg') {
    for (let i = 0; i < sortedReadings.length - 1; i++) {
      const interpolated = generateSmartInterpolation(
        sortedReadings[i],
        sortedReadings[i + 1],
        meals,
        insulinDoses,
        patientConstants
      );

      estimations.push(...interpolated.map(point => ({
        ...point,
        type: 'interpolated'
      })));
    }
  }

  // Generate future projections
  if (includeFutureProjection) {
    const projectionIntervalMinutes = 5;
    const projectionSteps = (projectionHours * 60) / projectionIntervalMinutes;

    for (let i = 1; i <= projectionSteps; i++) {
      const projectionTime = targetTimestamp + (i * projectionIntervalMinutes * 60 * 1000);

      const projection = estimateGlucoseAtTime(
        baseline,
        projectionTime,
        mostRecentReading.timestamp,
        meals,
        insulinDoses,
        patientConstants,
        {
          baselineStability: baselineStability,
          dataSource: dataSource,
          includeConfidence: true
        }
      );

      estimations.push({
        ...projection,
        type: 'projection',
        source: 'future_projection'
      });
    }
  }

  // Calculate velocity if we have multiple readings
  let velocity = null;
  if (sortedReadings.length >= 2) {
    velocity = calculateGlucoseVelocity(
      sortedReadings[sortedReadings.length - 1],
      sortedReadings[sortedReadings.length - 2]
    );
  }

  // Get reading recommendations (SMBG only)
  let nextReadingRecommendation = null;
  if (dataSource === 'smbg') {
    nextReadingRecommendation = recommendNextReading(
      currentEstimate,
      meals,
      insulinDoses,
      patientConstants
    );
  }

  // Sort all estimations by timestamp
  estimations.sort((a, b) => a.timestamp - b.timestamp);

  return {
    success: true,
    baseline: {
      value: baseline,
      confidence: baselineResult.confidence,
      stability: baselineResult.stability,
      timestamp: baselineResult.timestamp,
      // 🆕 Include cumulative baseline
      cumulativeBaseline: baselineResult.cumulativeBaseline
    },
    currentEstimate: currentEstimate,
    velocity: velocity,
    estimations: estimations,
    nextReadingRecommendation: nextReadingRecommendation,
    dataSource: dataSource,
    metadata: {
      actualReadingsCount: actualReadings.length,
      estimationsCount: estimations.length,
      projectionHours: includeFutureProjection ? projectionHours : 0,
      generatedAt: Date.now()
    }
  };
}

// ============================================================================
// EXPORT ALL FUNCTIONS
// ============================================================================

export default {
  // Core baseline functions
  calculateStableBaseline,
  calculateRobustBaseline,

  // Confidence scoring
  calculateEstimationConfidence,

  // Estimation
  estimateGlucoseAtTime,
  generateGlucoseEstimations,

  // Velocity analysis
  calculateGlucoseVelocity,
  predictGlucoseFromVelocity,
  ESTIMATION_CONSTANTS,

  // Interpolation
  generateSmartInterpolation,

  // SMBG-specific
  recommendNextReading,

  // CGM-specific
  detectBaselineShift,
  assessCGMDataQuality
};