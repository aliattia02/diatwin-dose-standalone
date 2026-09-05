/**
 * ============================================================================
 * MEAL PHARMACODYNAMICS CALCULATOR
 * ============================================================================
 * 
 * Implements S3 Guidelines-based meal absorption using gamma distribution
 * curves for physiologically-accurate carbohydrate absorption and MOB
 * (Meal On Board) calculations.
 * 
 * CRITICAL: This mirrors the backend Python implementation in
 * meal_on_board_routes.py to ensure consistency.
 * 
 * Author: Enhanced MOB System
 * Version: 2.1
 * Changes in 2.1:
 *   - D16 fix: calculateAbsorbedFraction() integrates with a left-Riemann sum,
 *     matching Python calculate_absorbed_fraction() and the mobile client. It
 *     used the trapezoidal rule under a comment claiming it matched Python.
 *     Found by the three-way parity harness. See the note on that function for
 *     why the trapezoid was not kept despite being more accurate on four of
 *     the six profiles.
 * ============================================================================
 */

import { SHARED_CONSTANTS } from '../constants/shared_constants.js';

// ============================================================================
// ABSORPTION PROFILES (from shared_constants)
// ============================================================================

const ABSORPTION_PROFILES = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.meal_absorption_profiles;

/**
 * Calculate meal absorption activity using gamma distribution
 * 
 * CRITICAL: This MUST match Python's calculate_gamma_absorption() exactly
 * 
 * @param {number} hoursSinceMeal - Hours elapsed since meal consumption
 * @param {object} profile - Meal absorption profile
 * @returns {number} Activity percentage (0-100)
 */
export function calculateMealActivity(hoursSinceMeal, profile) {
  const {
    onset_hours,
    peak_hours,
    duration_hours,
    shape_param,
    scale_param
  } = profile;

  // Outside duration window
  if (hoursSinceMeal < 0 || hoursSinceMeal > duration_hours) {
    return 0.0;
  }

  // D21c: no absorption before gastric emptying completes.
  //
  // This used to ramp linearly to 5, and the gamma branch below starts at ~0
  // because t^(k-1) -> 0 for every k > 1. So absorption rate *fell* by a full
  // 5 percentage points at the instant onset completed — the opposite of the
  // physiology onset_hours describes. Returning 0 makes the curve continuous
  // at onset: before emptying is done, carbohydrate has not reached the
  // absorptive surface.
  if (hoursSinceMeal < onset_hours) {
    return 0.0;
  }

  // Adjust time relative to onset
  const t = hoursSinceMeal - onset_hours;
  const t_peak = peak_hours - onset_hours;
  const t_duration = duration_hours - onset_hours;

  // Normalize time to [0, 1]
  const normalized_t = t / t_duration;
  const normalized_peak = t_peak / t_duration;

  if (normalized_t <= 0) return 0.0;

  // Gamma function calculation
  const k = shape_param;
  const theta = scale_param * normalized_peak;

  // D21a: normalise by the curve's true maximum, not by its value at
  // peak_hours.
  //
  // The density x^(k-1) * exp(-x/theta) peaks at x = (k-1)*theta. Dividing by
  // its value at normalized_peak instead only coincides when
  // (k-1)*scale_param === 1, which holds for none of the shipped profiles — so
  // the ratio exceeded 1 either side of the true mode and Math.min(100, ...)
  // clamped it. Between 18.6% and 38.5% of every absorption window sat at
  // exactly 100, carrying no information at all.
  //
  // NOTE (provisional, 2026-09-05): peak_hours still names the normalisation
  // point rather than the mode. Reparameterising the profiles so peak_hours IS
  // the mode is a separate decision — see the pre-ML audit §6.
  let mode = k > 1.0 ? (k - 1.0) * theta : 0.0;
  mode = Math.min(Math.max(mode, 1e-12), 1.0);

  // Gamma PDF: t^(k-1) * e^(-t/θ)
  const activity = Math.pow(normalized_t, k - 1) * Math.exp(-normalized_t / theta);
  const peak_activity = Math.pow(mode, k - 1) * Math.exp(-mode / theta);

  if (peak_activity > 0) {
    const normalized_activity = (activity / peak_activity) * 100;
    return Math.min(100, Math.max(0, normalized_activity));
  }

  return 0;
}

/**
 * Calculate absorbed fraction using numerical integration
 *
 * Left-Riemann sum over 100 steps, matching Python
 * `calculate_absorbed_fraction` and `mobile/utils/glucose/
 * meal-pharmacodynamics.ts`.
 *
 * This used the trapezoidal rule until the parity harness gained a third side
 * and found it (D16). The comment here claimed it matched Python; it did not,
 * and the difference reached 3.9e-03 in absorbed fraction — 0.93 mg/dL on a
 * 60 g meal, below display precision, which is why nobody saw it.
 *
 * The trapezoid is not simply better and was not kept for that reason.
 * Measured against composite Simpson at 200,000 intervals it wins on four
 * profiles (up to 13.9x on `medium`) and loses on `very_slow` and `mixed`.
 * The reason is that the activity curve is not smooth: it has a jump of about
 * 5 percentage points exactly at `onset_hours`, where the pre-onset ramp ends
 * at 5 and the gamma density starts at 0 because t^(k-1) -> 0 for k > 1. A
 * trapezoid assumes smoothness, so which rule wins depends on where that jump
 * falls relative to the grid.
 *
 * Whether 100 left-Riemann steps is the right rule at all is a live question
 * for all three implementations, not this one. Changing it moves every
 * absorbed-carb number in the product and has to move on every side at once,
 * or the harness reports the improvement as a regression.
 *
 * @param {number} hoursSinceMeal - Hours since meal
 * @param {object} profile - Absorption profile
 * @returns {number} Fraction absorbed (0-1)
 */
export function calculateAbsorbedFraction(hoursSinceMeal, profile) {
  // ✅ CRITICAL DEBUG: Show what profile we're ACTUALLY using
  if (window.DEBUG_ABSORPTION_PROFILE) {
    console.log('🔬 calculateAbsorbedFraction() called:', {
      hoursSinceMeal: hoursSinceMeal.toFixed(4),
      profile_received: {
        onset_hours: profile.onset_hours,
        peak_hours: profile.peak_hours,
        duration_hours: profile.duration_hours,
        shape_param: profile.shape_param,
        scale_param: profile.scale_param,
        curve_type: profile.curve_type,
        absorption_type: profile.absorption_type
      },
      callStack: new Error().stack.split('\n').slice(1, 4).join('\n')
    });
  }

  if (hoursSinceMeal <= 0) return 0.0;
  if (hoursSinceMeal >= profile.duration_hours) return 1.0;
  // Numerical integration parameters
  const steps = 100;
  const dt = hoursSinceMeal / steps;
  let integral = 0.0;

  // Integrate from 0 to hoursSinceMeal. Left-Riemann: i runs to steps - 1 and
  // every sample carries the same weight.
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    integral += calculateMealActivity(t, profile) * dt;
  }

  // Total area (0 to duration), on its own grid, for normalization.
  const total_steps = 100;
  const total_dt = profile.duration_hours / total_steps;
  let total_integral = 0.0;

  for (let i = 0; i < total_steps; i++) {
    const t = i * total_dt;
    total_integral += calculateMealActivity(t, profile) * total_dt;
  }

  // Clamp to [0, 1]: this is a *fraction absorbed* and cannot exceed 1.
  //
  // Both integrals are 100-step left-Riemann sums, but over different step
  // sizes (hoursSinceMeal/100 and duration_hours/100), so their discretisation
  // errors do not cancel and the ratio can drift a few parts in 10,000 either
  // side of 1 near the end of the window. Removing the pre-onset ramp (D21c)
  // steepened the curve's rise and made the overshoot newly visible — the
  // parity harness caught it as three `meal_abs::very_fast` divergences the
  // moment Python was clamped and these were not.
  //
  // Making the estimator itself exact would mean integrating both on a common
  // fixed grid, which shifts every absorbed-carbohydrate value slightly and is
  // a separate decision — see the pre-ML audit §6.
  if (total_integral <= 0) return 0.0;
  return Math.min(1, Math.max(0, integral / total_integral));
}

/**
 * Calculate MOB (Meal On Board) - remaining active carbs
 * 
 * Parallel to IOB calculation in insulinPharmacodynamics.js
 * 
 * @param {number} hoursSinceMeal - Hours elapsed
 * @param {number} totalCarbEquiv - Total carb equivalents consumed
 * @param {object} profile - Absorption profile
 * @returns {number} Remaining active carbs in grams
 */
export function calculateMOB(hoursSinceMeal, totalCarbEquiv, profile) {
  const { duration_hours } = profile;

  // Outside duration window
  if (hoursSinceMeal < 0 || hoursSinceMeal > duration_hours) {
    return 0;
  }

  // Calculate absorbed fraction
  const absorbed_fraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
  
  // MOB = remaining unabsorbed carbs
  const active_carbs = totalCarbEquiv * (1 - absorbed_fraction);

  return Math.max(0, active_carbs);
}
// ===== START INSERT (replace the deleted section above) =====
/**
 * Calculate BG impact from ABSORBED carbs (T1D Model)
 *
 * CRITICAL T1D INSIGHT:
 * - BG elevation comes from ABSORBED carbs (in bloodstream), NOT from MOB
 * - MOB (Meal On Board) = carbs still in gut = FUTURE BG rise
 * - Absorbed carbs = carbs in bloodstream = CURRENT BG elevation
 * - For T1D: BG elevation is CUMULATIVE and does NOT decay without insulin
 *
 * @param {number} absorbedCarbs - Carbs that have been absorbed into bloodstream
 * @param {number} carbToBGFactor - Patient-specific BG impact per gram (default: 4.0)
 * @returns {number} BG elevation in mg/dL
 */
export function calculateBGImpact(absorbedCarbs, carbToBGFactor = 4.0) {
  return absorbedCarbs * carbToBGFactor;
}

/**
 * Calculate complete meal absorption state for T1D
 *
 * This function provides the full picture of meal absorption:
 * - absorbedCarbs:  carbs in bloodstream (causing current BG elevation)
 * - activeCarbs (MOB): carbs still digesting (will cause future BG rise)
 * - bgElevation: current BG impact from absorbed carbs
 * - pendingBGRise: expected additional BG rise from remaining MOB
 *
 * @param {number} hoursSinceMeal - Hours elapsed since meal consumption
 * @param {number} totalCarbEquiv - Total carb equivalents consumed
 * @param {object} profile - Meal absorption profile
 * @param {number} carbToBGFactor - BG impact per gram (default: 4.0)
 * @returns {object} Complete absorption state
 */
export function calculateMealAbsorptionState(hoursSinceMeal, totalCarbEquiv, profile, carbToBGFactor = 4.0) {
  const { duration_hours } = profile;

  // Before meal started
  if (hoursSinceMeal < 0) {
    return {
      absorbedCarbs: 0,
      activeCarbs: 0,
      absorbedFraction: 0,
      bgElevation: 0,
      pendingBGRise: 0,
      activity: 0,
      isComplete: false,
      isActive: false
    };
  }

  // Calculate absorbed fraction (0 to 1)
  const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);

  // ABSORBED carbs = carbs that have moved to bloodstream = cause CURRENT BG elevation
  const absorbedCarbs = totalCarbEquiv * absorbedFraction;

  // MOB (active carbs) = carbs still in gut = will cause FUTURE BG rise
  const activeCarbs = totalCarbEquiv * (1 - absorbedFraction);

  // BG elevation from ABSORBED carbs (T1D:  cumulative, doesn't decay without insulin)
  const bgElevation = absorbedCarbs * carbToBGFactor;

  // Pending BG rise from remaining MOB
  const pendingBGRise = activeCarbs * carbToBGFactor;

  // Activity = current absorption RATE (for visualization of absorption curve)
  const activity = calculateMealActivity(hoursSinceMeal, profile);

  return {
    absorbedCarbs:  Math.round(absorbedCarbs * 100) / 100,
    activeCarbs: Math.round(activeCarbs * 100) / 100,
    absorbedFraction: Math.round(absorbedFraction * 1000) / 1000,
    bgElevation: Math.round(bgElevation * 10) / 10,
    pendingBGRise: Math.round(pendingBGRise * 10) / 10,
    activity: Math.round(activity * 10) / 10,
    isComplete: hoursSinceMeal >= duration_hours,
    isActive: hoursSinceMeal >= 0 && hoursSinceMeal <= duration_hours
  };
}

/**
 * Calculate BG elevation from absorbed carbs at a specific time
 *
 * Convenience function that combines absorption calculation with BG impact
 *
 * @param {number} hoursSinceMeal - Hours since meal
 * @param {number} totalCarbEquiv - Total carb equivalents
 * @param {object} profile - Absorption profile
 * @param {number} carbToBGFactor - BG impact per gram
 * @returns {number} Current BG elevation in mg/dL
 */
export function calculateBGElevationAtTime(hoursSinceMeal, totalCarbEquiv, profile, carbToBGFactor = 4.0) {
  if (hoursSinceMeal < 0) return 0;

  const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
  const absorbedCarbs = totalCarbEquiv * absorbedFraction;

  return absorbedCarbs * carbToBGFactor;
}


// ===== START INSERT (replace the deleted section above) =====
/**
 * Calculate total active meal effects for multiple meals (stacking) - T1D Model
 *
 * CRITICAL T1D DISTINCTION:
 * - totalMOB:  Carbs still in gut (FUTURE BG rise)
 * - totalAbsorbed: Carbs already in bloodstream (CURRENT BG elevation)
 * - totalBGElevation: Current BG impact from absorbed carbs
 * - pendingBGRise: Expected additional rise from remaining MOB
 *
 * The relationship is INVERSE:  As MOB decreases, BG elevation increases
 *
 * @param {Array} meals - Array of meal objects with {carbEquiv, hoursSinceMeal, absorptionType}
 * @param {number} carbToBGFactor - BG impact per gram
 * @returns {object} Complete stacking analysis with T1D model
 */
export function calculateStackedMealEffect(meals, carbToBGFactor = 4.0) {
  let totalMOB = 0;           // Carbs still absorbing (future BG rise)
  let totalAbsorbed = 0;      // Carbs already absorbed (current BG elevation)
  let totalBGElevation = 0;   // Actual current BG impact from absorbed carbs
  let totalActivity = 0;      // Sum of absorption rates
  const mealContributions = [];

  meals.forEach((meal) => {
    const profile = getAbsorptionProfile(meal.absorptionType);

    if (!profile) {
      console.warn(`Unknown absorption type: ${meal.absorptionType}`);
      return;
    }

    const { hoursSinceMeal, carbEquiv } = meal;

    // Track meals up to the defined duration
    if (hoursSinceMeal >= 0 && hoursSinceMeal <= profile.duration_hours) {
      // Get complete absorption state
      const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
      const absorbedCarbs = carbEquiv * absorbedFraction;
      const activeCarbs = carbEquiv * (1 - absorbedFraction);
      const activity = calculateMealActivity(hoursSinceMeal, profile);

      // T1D: BG elevation from ABSORBED carbs (not MOB!)
      const bgElevation = absorbedCarbs * carbToBGFactor;
      const pendingBGRise = activeCarbs * carbToBGFactor;

      totalActivity += activity;
      totalMOB += activeCarbs;
      totalAbsorbed += absorbedCarbs;
      totalBGElevation += bgElevation;

      mealContributions.push({
        mealId:  meal.id || meal.mealId,
        mealType: meal.mealType || 'unknown',
        absorptionType: meal.absorptionType,
        carbEquiv: carbEquiv,
        hoursSinceMeal: Math.round(hoursSinceMeal * 100) / 100,

        // Absorption rate (for curve visualization)
        activity: Math.round(activity * 10) / 10,

        // T1D Model: distinguish MOB from absorbed
        activeCarbs: Math.round(activeCarbs * 10) / 10,      // MOB - future rise
        absorbedCarbs:  Math.round(absorbedCarbs * 10) / 10,  // In bloodstream - current elevation
        absorbedPercent: Math.round(absorbedFraction * 100),

        // Legacy field for backward compatibility (now refers to MOB)
        mob: Math.round(activeCarbs * 10) / 10,

        // BG impacts - T1D model
        bgElevation: Math.round(bgElevation * 10) / 10,      // Current BG rise from absorbed
        pendingBGRise:  Math.round(pendingBGRise * 10) / 10,  // Future rise from MOB

        // Legacy field for backward compatibility
        bgImpact: Math.round(bgElevation * 10) / 10,

        profile: {
          onset: profile.onset_hours,
          peak: profile.peak_hours,
          duration: profile.duration_hours,
          absorptionType: meal.absorptionType
        }
      });
    }
  });

  // Pending additional rise from all remaining MOB
  const pendingBGRise = totalMOB * carbToBGFactor;

  return {
    // T1D-specific fields (primary)
    totalMOB: Math.round(totalMOB * 100) / 100,                    // Future BG rise potential
    totalAbsorbed: Math.round(totalAbsorbed * 100) / 100,          // Already causing BG elevation
    totalBGElevation:  Math.round(totalBGElevation * 10) / 10,      // Current BG impact
    pendingBGRise: Math.round(pendingBGRise * 10) / 10,            // Expected additional rise

    // Activity for visualization
    totalActivity: Math.round(totalActivity * 10) / 10,

    // Legacy field for backward compatibility
    totalBGImpact:  Math.round(totalBGElevation * 10) / 10,

    activeMeals: mealContributions.length,
    contributions: mealContributions,
    isStacking: mealContributions.length > 1,
    stackingRisk: calculateMealStackingRisk(mealContributions)
  };
}
// ===== END INSERT =====

/**
 * Calculate meal stacking risk level
 *
 * @private
 * @param {Array} contributions - Meal contributions
 * @returns {string} 'low' | 'moderate' | 'high' | 'severe'
 */
function calculateMealStackingRisk(contributions) {
  if (contributions.length <= 1) return 'low';

  const totalMOB = contributions.reduce((sum, c) => sum + c.mob, 0);

  // Check for overlapping peaks
  const peakOverlap = contributions.filter(c =>
    c.hoursSinceMeal >= (c.profile.peak * 0.5) &&
    c.hoursSinceMeal <= c.profile.peak
  ).length;

  // Check for fast-absorbing meals
  const fastMeals = contributions.filter(c =>
    c.absorptionType === 'very_fast' || c.absorptionType === 'fast'
  ).length;

  // Risk assessment
  if (totalMOB > 100 || peakOverlap >= 3) return 'severe';
  if (totalMOB > 70 || (peakOverlap >= 2 && fastMeals >= 1)) return 'high';
  if (totalMOB > 40 || peakOverlap >= 2) return 'moderate';
  return 'low';
}

/**
 * Get absorption profile from SHARED_CONSTANTS by absorption type
 *
 * @param {string} absorptionType - Absorption type identifier
 * @returns {object|null} Absorption profile or null if not found
 */
export function getAbsorptionProfile(absorptionType) {
  return ABSORPTION_PROFILES[absorptionType] || null;
}

// ===== START INSERT (replace the deleted section above) =====
/**
 * Calculate BG impact from a meal at a specific time - T1D Model
 *
 * Returns complete breakdown of current and pending BG effects
 *
 * @param {number} carbEquiv - Carb equivalents in grams
 * @param {string} absorptionType - Type of absorption
 * @param {number} carbToBGFactor - BG impact per gram
 * @param {number} hoursSinceMeal - Time elapsed since meal
 * @returns {object} Complete BG impact breakdown
 */
export function calculateMealBGImpact(carbEquiv, absorptionType, carbToBGFactor, hoursSinceMeal) {
  const profile = getAbsorptionProfile(absorptionType);
  if (!profile) {
    return {
      bgElevation: 0,
      pendingBGRise:  0,
      totalExpectedRise: 0,
      absorbedCarbs:  0,
      activeCarbs: 0,
      absorbedPercent:  0,
      activity: 0
    };
  }

  const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
  const absorbedCarbs = carbEquiv * absorbedFraction;
  const activeCarbs = carbEquiv * (1 - absorbedFraction);
  const activity = calculateMealActivity(hoursSinceMeal, profile);

  // T1D:  BG elevation from ABSORBED carbs
  const bgElevation = absorbedCarbs * carbToBGFactor;

  // Pending rise from remaining MOB
  const pendingBGRise = activeCarbs * carbToBGFactor;

  // Total expected rise when fully absorbed
  const totalExpectedRise = carbEquiv * carbToBGFactor;

  return {
    bgElevation:  Math.round(bgElevation * 10) / 10,           // Current BG impact
    pendingBGRise: Math.round(pendingBGRise * 10) / 10,       // Future additional rise
    totalExpectedRise: Math.round(totalExpectedRise * 10) / 10, // Max rise when complete
    absorbedCarbs: Math.round(absorbedCarbs * 10) / 10,
    activeCarbs:  Math.round(activeCarbs * 10) / 10,
    absorbedPercent: Math.round(absorbedFraction * 100),
    activity: Math.round(activity * 10) / 10
  };
}

/**
 * Simple BG elevation calculation for backward compatibility
 * Returns just the number (current BG elevation from absorbed carbs)
 *
 * @param {number} carbEquiv - Carb equivalents in grams
 * @param {string} absorptionType - Type of absorption
 * @param {number} carbToBGFactor - BG impact per gram
 * @param {number} hoursSinceMeal - Time elapsed since meal
 * @returns {number} Current BG elevation in mg/dL
 */
export function calculateMealBGImpactSimple(carbEquiv, absorptionType, carbToBGFactor, hoursSinceMeal) {
  const result = calculateMealBGImpact(carbEquiv, absorptionType, carbToBGFactor, hoursSinceMeal);
  return result.bgElevation;
}
// ===== END INSERT =====
// ===== START INSERT (replace the deleted section above) =====
/**
 * Generate time-series data for meal visualization - T1D Model
 *
 * Shows the inverse relationship between MOB and BG elevation:
 * - As MOB decreases (carbs absorbed), BG elevation increases
 * - BG elevation is cumulative and doesn't decay without insulin
 *
 * @param {Array} meals - Array of meal objects
 * @param {number} timeWindowMinutes - Total time to simulate (default:  720 = 12 hours)
 * @param {number} intervalMinutes - Time step for data points (default: 5)
 * @param {number} carbToBGFactor - BG impact per gram (default:  4.0)
 * @returns {Array} Time-series data points with T1D model
 */
export function generateMealTimeSeries(
  meals,
  timeWindowMinutes = 720,
  intervalMinutes = 5,
  carbToBGFactor = 4.0
) {
  const timePoints = [];

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hoursSinceStart = t / 60;

    let totalActivity = 0;
    let totalMOB = 0;           // Carbs still absorbing
    let totalAbsorbed = 0;      // Carbs already absorbed
    let totalBGElevation = 0;   // Current BG impact from absorbed
    const activeMeals = [];

    meals.forEach((meal) => {
      const profile = getAbsorptionProfile(meal.absorptionType);
      if (!profile) return;

      const mealTimeMinutes = meal.timeMinutes || 0;
      const minutesSinceMeal = t - mealTimeMinutes;
      const hoursSinceMeal = minutesSinceMeal / 60;

      // Track effects up to the defined duration
      if (hoursSinceMeal >= 0 && hoursSinceMeal <= profile.duration_hours) {
        const activity = calculateMealActivity(hoursSinceMeal, profile);
        const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
        const absorbedCarbs = meal.carbEquiv * absorbedFraction;
        const activeCarbs = meal.carbEquiv * (1 - absorbedFraction);

        // T1D: BG elevation from ABSORBED carbs
        const bgElevation = absorbedCarbs * carbToBGFactor;
        const pendingRise = activeCarbs * carbToBGFactor;

        totalActivity += activity;
        totalMOB += activeCarbs;
        totalAbsorbed += absorbedCarbs;
        totalBGElevation += bgElevation;

        if (activeCarbs > 0.01 || absorbedCarbs > 0.01 || activity > 1) {
          activeMeals.push({
            name: meal.name || meal.mealType,
            absorptionType:  meal.absorptionType,
            activity: Math.round(activity * 10) / 10,

            // T1D Model fields
            mob: Math.round(activeCarbs * 100) / 100,           // Future rise
            absorbedCarbs:  Math.round(absorbedCarbs * 100) / 100, // Current elevation
            absorbedPercent: Math.round(absorbedFraction * 100),

            bgElevation: Math.round(bgElevation * 10) / 10,     // Current BG impact
            pendingRise: Math.round(pendingRise * 10) / 10,     // Future BG impact

            // Legacy field
            activeCarbs:  Math.round(activeCarbs * 100) / 100,
            bgImpact: Math.round(bgElevation * 10) / 10
          });
        }
      }
    });

    // Pending additional rise from all remaining MOB
    const pendingBGRise = totalMOB * carbToBGFactor;

    timePoints.push({
      time: t,
      timeLabel: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      hours: hoursSinceStart,

      // Absorption rate (for curve visualization)
      totalActivity: Math.round(totalActivity * 10) / 10,

      // T1D Model: distinguish MOB from absorbed
      totalMOB: Math.round(totalMOB * 100) / 100,                 // Future rise potential
      totalAbsorbed: Math.round(totalAbsorbed * 100) / 100,       // In bloodstream
      totalBGElevation: Math.round(totalBGElevation * 10) / 10,   // Current BG impact
      pendingBGRise: Math.round(pendingBGRise * 10) / 10,         // Future additional rise

      // Legacy field for backward compatibility
      totalBGImpact: Math.round(totalBGElevation * 10) / 10,

      activeMeals: activeMeals,
      isStacking: activeMeals.length > 1
    });
  }

  return timePoints;
}
// ===== END INSERT =====
/**
 * Calculate time to peak absorption for a meal
 * 
 * @param {string} absorptionType - Type of absorption
 * @returns {number} Hours to peak activity
 */
export function getTimeToPeak(absorptionType) {
  const profile = getAbsorptionProfile(absorptionType);
  return profile ? profile.peak_hours : 0;
}

/**
 * Calculate duration of absorption for a meal
 * 
 * @param {string} absorptionType - Type of absorption
 * @returns {number} Total duration in hours
 */
export function getDuration(absorptionType) {
  const profile = getAbsorptionProfile(absorptionType);
  return profile ? profile.duration_hours : 0;
}

/**
 * Check if meal is still actively absorbing at a given time
 * 
 * @param {number} hoursSinceMeal - Hours since meal consumption
 * @param {string} absorptionType - Type of absorption
 * @returns {boolean} True if still active
 */
export function isMealActive(hoursSinceMeal, absorptionType) {
  const profile = getAbsorptionProfile(absorptionType);
  if (!profile) return false;

  return hoursSinceMeal >= 0 && hoursSinceMeal <= profile.duration_hours;
}

/**
 * Calculate mixed meal absorption (e.g., fast + slow components)
 * 
 * Example: Meal with fruit (fast) + pasta (slow)
 * 
 * @param {number} hoursSinceMeal - Hours since meal
 * @param {number} fastFraction - Fraction of fast-absorbing carbs (0-1)
 * @param {number} slowFraction - Fraction of slow-absorbing carbs (0-1)
 * @param {string} fastType - Fast absorption type (default: 'fast')
 * @param {string} slowType - Slow absorption type (default: 'slow')
 * @returns {number} Combined activity percentage (0-100)
 */
export function calculateMixedMealActivity(
  hoursSinceMeal,
  fastFraction,
  slowFraction,
  fastType = 'fast',
  slowType = 'slow'
) {
  const fastProfile = getAbsorptionProfile(fastType);
  const slowProfile = getAbsorptionProfile(slowType);

  if (!fastProfile || !slowProfile) return 0;

  const fastActivity = calculateMealActivity(hoursSinceMeal, fastProfile) * fastFraction;
  const slowActivity = calculateMealActivity(hoursSinceMeal, slowProfile) * slowFraction;

  return fastActivity + slowActivity;
}

// Export all functions
export default {
  calculateMealActivity,
  calculateAbsorbedFraction,
  calculateMOB,
  calculateBGImpact,
  calculateMealAbsorptionState,
  calculateBGElevationAtTime,
  calculateStackedMealEffect,
  getAbsorptionProfile,
  calculateMealBGImpact,
  calculateMealBGImpactSimple,
  generateMealTimeSeries,
  getTimeToPeak,
  getDuration,
  isMealActive,
  calculateMixedMealActivity
};



