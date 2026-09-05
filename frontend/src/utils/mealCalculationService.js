/**
 * ============================================================================
 * MEAL CALCULATION SERVICE
 * ============================================================================
 * 
 * High-level service for integrating meal calculations with insulin planning
 * and blood glucose management. This is the main interface used by the
 * frontend application.
 * 
 * Integrates:
 * - Meal pharmacodynamics (activity, MOB)
 * - Stacking analysis
 * - Meal-based insulin recommendations
 * - Real-time active carb tracking
 * 
 * Author: Enhanced MOB System
 * Version: 2.0
 * ============================================================================
 */

import {
  calculateMealActivity,
  calculateAbsorbedFraction,
  calculateMOB,
  calculateBGImpact,
  calculateStackedMealEffect,
  getAbsorptionProfile,
  calculateMealBGImpact,
  generateMealTimeSeries,
  getDuration,
  isMealActive
} from './mealPharmacodynamics.js';

import {
  analyzeMealStackingRisk,
  calculateBGResponseWithMeals,
  analyzeHyperglycemiaRisk,
  checkMealSafety
} from './mealStackingAnalyzer.js';

import { SHARED_CONSTANTS } from '../constants/shared_constants.js';

// ============================================================================
// DEBUG CONTROL - SET TO FALSE IN PRODUCTION
// ============================================================================
const DEBUG_MOB_VERIFICATION = false; // TEMPORARILY ENABLED for debugging

// ============================================================================
// MEAL DISPLAY CONFIGURATION
// ============================================================================
/**
 * MEAL_DISPLAY_RESET_HOUR: Reset meal display at this hour each day (24h format)
 *
 * Option 1: Simple 24h display (MEAL_DISPLAY_HOURS = 24)
 * Option 2: Daily reset at specific hour (MEAL_DISPLAY_RESET_HOUR = 7)
 *
 * With reset enabled, meals from before today's reset time are excluded
 * This creates a "clean slate" each day at the specified hour
 */
const USE_DAILY_RESET = true; // Set to false to use simple 24h window
const MEAL_DISPLAY_RESET_HOUR = 7; // Reset at 7 AM (24h format: 0-23)
const MEAL_DISPLAY_HOURS = 24; // Fallback for when reset is disabled

/**
 * Calculate active meal effects for a user at a specific time - T1D Model
 *
 *
 * This is the main function used by the frontend to get current MOB/stacking info.
 * Used in meal logging, insulin input, and dashboard displays.
 *
 * T1D MODEL KEY INSIGHT:
 * - MOB (total_active_carbs) = carbs still digesting = FUTURE BG rise
 * - Absorbed carbs = carbs in bloodstream = CURRENT BG elevation
 * - current_bg_elevation = BG elevation from ABSORBED carbs (not MOB!)
 * - pending_bg_rise = FUTURE additional rise from remaining MOB
 *
 * @param {Array} recentMeals - Array of recent meals from backend
 * @param {Date|string} targetTime - Time to calculate for (default: now)
 * @param {object} patientConstants - User's constants
 * @returns {object} Complete active meal analysis with T1D model
 */
/**
 * Calculate active meal effects for a user at a specific time - T1D Model (FIXED)
 *
 * CRITICAL FIX: Ensures absorbedCarbs is ALWAYS calculated and included
 *
 * @param {Array} recentMeals - Array of recent meals from backend
 * @param {Date|string} targetTime - Time to calculate for (default: now)
 * @param {object} patientConstants - User's constants
 * @returns {object} Complete active meal analysis with T1D model
 */
/**
 * Calculate active meal effects for a user at a specific time - T1D Model (FIXED)
 *
 * CRITICAL FIX: Ensures absorbedCarbs is ALWAYS calculated and included
 *
 * @param {Array} recentMeals - Array of recent meals from backend
 * @param {Date|string} targetTime - Time to calculate for (default: now)
 * @param {object} patientConstants - User's constants
 * @returns {object} Complete active meal analysis with T1D model
 */
export async function calculateActiveMealEffects(
  recentMeals,
  targetTime = new Date(),
  patientConstants = null
) {
  try {
    // 🔥 PERFORMANCE FIX (Bottleneck #3): Normalize time to minute precision
    // This prevents micro-second variations from causing continuous re-renders
    const rawTime = targetTime instanceof Date ? targetTime : new Date(targetTime);
    const calculationTime = new Date(Math.floor(rawTime.getTime() / 60000) * 60000);

    // Use patient-specific constants or defaults
    const constants = patientConstants || SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS;
    const carbToBGFactor = constants.carb_to_bg_factor || 4.0;

    // Transform recent meals to calculation format
    const activeMeals = recentMeals
      .map(meal => {
        const mealTime = new Date(meal.timestamp);
        const hoursSinceMeal = (calculationTime - mealTime) / (1000 * 60 * 60);

        // Get absorption type
        let absorptionType = 'medium';
        if (meal.nutrition?.absorption_type) {
          absorptionType = meal.nutrition.absorption_type;
        } else if (meal.nutrition?.absorptionType) {
          absorptionType = meal.nutrition.absorptionType;
        } else if (meal.calculation_summary?.absorption_type) {
          absorptionType = meal.calculation_summary.absorption_type;
        }

        const profile = getAbsorptionProfile(absorptionType);

        // ✅ FIX: Implement daily reset at 7 AM or use 24h window
        let maxAllowedAge;

        if (USE_DAILY_RESET) {
          // Calculate the most recent reset time (7 AM today or yesterday)
          const resetTime = new Date(calculationTime);
          resetTime.setHours(MEAL_DISPLAY_RESET_HOUR, 0, 0, 0);

          // If current time is before today's reset time, use yesterday's reset
          if (calculationTime < resetTime) {
            resetTime.setDate(resetTime.getDate() - 1);
          }

          // Calculate how many hours since the last reset
          const hoursSinceReset = (calculationTime - resetTime) / (1000 * 60 * 60);
          maxAllowedAge = hoursSinceReset + 1; // +1 hour buffer to include meals just before reset

          // Debug logging for reset feature (only when DEBUG enabled)
          if (DEBUG_MOB_VERIFICATION) {
            console.log('🕐 Daily Reset Feature:', {
              calculationTime: calculationTime.toLocaleString(),
              lastResetTime: resetTime.toLocaleString(),
              hoursSinceReset: hoursSinceReset.toFixed(2),
              maxAllowedAge: maxAllowedAge.toFixed(2)
            });
          }
        } else {
          // Simple 24-hour window
          maxAllowedAge = MEAL_DISPLAY_HOURS;
        }

        // Filter meals based on age
        if (!profile || hoursSinceMeal < 0 || hoursSinceMeal > maxAllowedAge) {
          return null;
        }

        // Get total carb equivalents - CALCULATE FIRST before using
        let carbEquiv = 0;
        if (meal.nutrition?.totalCarbEquiv) {
          carbEquiv = meal.nutrition.totalCarbEquiv;
        } else if (meal.nutrition?.total_carb_equiv) {
          carbEquiv = meal.nutrition.total_carb_equiv;
        } else if (meal.carbEquiv) {
          carbEquiv = meal.carbEquiv;
        } else {
          // Calculate from components
          const carbs = meal.nutrition?.carbs || 0;
          const protein = (meal.nutrition?.protein || 0) * (constants.protein_factor || 0.5);
          const fat = (meal.nutrition?.fat || 0) * (constants.fat_factor || 0.2);
          carbEquiv = carbs + protein + fat;
        }

        // 🔍 DEBUG: Log meal processing to compare with bloodGlucoseEstimationService
        console.log('🍽️ MOB Service - Meal Processing:', {
          mealId: meal.id || meal._id,
          mealTime: mealTime.toLocaleTimeString(),
          calculationTime: calculationTime.toLocaleTimeString(),
          hoursSinceMeal: hoursSinceMeal.toFixed(4),
          carbEquiv: carbEquiv,
          absorptionType: absorptionType,
          profileDuration: profile.duration_hours
        });

        return {
          id: meal.id || meal._id,
          mealType: meal.mealType || 'unknown',
          carbEquiv: carbEquiv,
          absorptionType: absorptionType,
          hoursSinceMeal: hoursSinceMeal,
          timestamp: mealTime.toISOString(),
          mealId: meal.id || meal._id
        };
      })
      .filter(meal => meal !== null);

    // ✅ CRITICAL FIX: Calculate stacked effects with EXPLICIT absorbed carbs tracking
    const stackedEffect = calculateStackedMealEffect(activeMeals, carbToBGFactor);

    // ✅ VERIFY: stackedEffect MUST have totalAbsorbed (only log if DEBUG enabled)
    if (!stackedEffect.totalAbsorbed && stackedEffect.totalAbsorbed !== 0) {
      if (DEBUG_MOB_VERIFICATION) {
        console.error('❌ CRITICAL: stackedEffect missing totalAbsorbed!', stackedEffect);
      }
      // Fallback calculation
      stackedEffect.totalAbsorbed = stackedEffect.contributions.reduce(
        (sum, c) => sum + (c.absorbedCarbs || 0),
        0
      );
      if (DEBUG_MOB_VERIFICATION) {
        console.log('✅ Fallback calculated totalAbsorbed:', stackedEffect.totalAbsorbed);
      }
    }

    // Analyze stacking risk
    const stackingAnalysis = analyzeMealStackingRisk(activeMeals, carbToBGFactor);

    // ✅ CRITICAL: Double-verify absorbed carbs in contributions (silent unless DEBUG)
    stackingAnalysis.contributions.forEach(contrib => {
      if (!contrib.absorbedCarbs && contrib.absorbedCarbs !== 0) {
        if (DEBUG_MOB_VERIFICATION) {
          console.error('❌ Contribution missing absorbedCarbs:', contrib);
        }
        // Calculate it now
        const profile = getAbsorptionProfile(contrib.absorptionType);
        const absorbedFraction = calculateAbsorbedFraction(contrib.hoursSinceMeal, profile);
        contrib.absorbedCarbs = contrib.carbEquiv * absorbedFraction;
        contrib.absorbedPercent = Math.round(absorbedFraction * 100);
        if (DEBUG_MOB_VERIFICATION) {
          console.log('✅ Fixed contribution absorbedCarbs:', contrib.absorbedCarbs);
        }
      }
    });

    // Calculate contribution by absorption type with T1D model
    const byAbsorptionType = {};
    stackingAnalysis.contributions.forEach(contrib => {
      if (!byAbsorptionType[contrib.absorptionType]) {
        byAbsorptionType[contrib.absorptionType] = {
          totalCarbs: 0,
          totalMOB: 0,
          totalAbsorbed: 0,
          totalActivity: 0,
          currentBGElevation: 0,
          pendingBGRise: 0,
          meals: []
        };
      }

      byAbsorptionType[contrib.absorptionType].totalCarbs += contrib.carbEquiv;
      byAbsorptionType[contrib.absorptionType].totalMOB += contrib.activeCarbs || contrib.mob;
      byAbsorptionType[contrib.absorptionType].totalAbsorbed += contrib.absorbedCarbs || 0;
      byAbsorptionType[contrib.absorptionType].totalActivity += contrib.activity;
      byAbsorptionType[contrib.absorptionType].currentBGElevation += contrib.bgElevation || contrib.bgImpact || 0;
      byAbsorptionType[contrib.absorptionType].pendingBGRise += contrib.pendingBGRise || 0;
      byAbsorptionType[contrib.absorptionType].meals.push(contrib);
    });

    // ✅ FINAL VERIFICATION: Calculate total absorbed from contributions
    const totalAbsorbedFromContributions = stackingAnalysis.contributions.reduce(
      (sum, c) => sum + (c.absorbedCarbs || 0),
      0
    );

    // Use the maximum of the two values to ensure we have the correct total
    const verifiedTotalAbsorbed = Math.max(
      stackedEffect.totalAbsorbed || 0,
      totalAbsorbedFromContributions
    );

    // ✅ FIX: Only log if DEBUG is enabled
    if (DEBUG_MOB_VERIFICATION) {
      console.log('✅ MOB Service - Absorbed Carbs FINAL VERIFICATION:', {
        stackedEffect_totalAbsorbed: stackedEffect.totalAbsorbed,
        calculated_from_contributions: totalAbsorbedFromContributions,
        verified_final_value: verifiedTotalAbsorbed,
        contributions_count: stackingAnalysis.contributions.length,
        individual_values: stackingAnalysis.contributions.map(c => ({
          mealType: c.mealType,
          absorbedCarbs: c.absorbedCarbs || 0,
          absorbedPercent: c.absorbedPercent || 0
        }))
      });
    }

    // 🔍 DEBUG: Log meal_contributions array size
    console.log('🔍 MEAL_CONTRIBUTIONS DEBUG:', {
      activeMealsCount: activeMeals.length,
      stackingContributionsCount: stackingAnalysis.contributions.length,
      willBeInMealContributions: stackingAnalysis.contributions.length,
      contributions: stackingAnalysis.contributions.map(c => ({
        mealId: c.mealId,
        mealType: c.mealType,
        hoursSinceMeal: c.hoursSinceMeal?.toFixed(2),
        carbEquiv: c.carbEquiv,
        mob: c.mob || c.activeCarbs,
        absorbedCarbs: c.absorbedCarbs
      }))
    });

    return {
      calculation_time: calculationTime.toISOString(),
      calculation_timezone: 'UTC',
      mob: {
        // MOB = carbs still absorbing (FUTURE BG rise)
        total_active_carbs: stackedEffect.totalMOB,

        // ✅ CRITICAL: Absorbed carbs (SINGLE SOURCE OF TRUTH)
        total_absorbed_carbs: verifiedTotalAbsorbed,

        // CURRENT BG elevation from absorbed carbs
        current_bg_elevation: stackedEffect.totalBGElevation || 0,
        expected_bg_impact: stackedEffect.totalBGElevation || 0,

        // FUTURE additional BG rise from remaining MOB
        pending_bg_rise: stackedEffect.pendingBGRise || 0,

        // Activity (absorption rate for visualization)
        total_activity_percent: stackedEffect.totalActivity,

active_meals_count: stackingAnalysis.contributions.length,  // ✅ Correct!

        // ✅ ENSURE: Each contribution has absorbedCarbs
        meal_contributions: stackingAnalysis.contributions.map(c => ({
          mealId: c.mealId,
          mealType: c.mealType,
          absorptionType: c.absorptionType,
          carbEquiv: c.carbEquiv,

          // T1D Model fields - ALL VERIFIED
          activeCarbs: c.activeCarbs || c.mob,
          absorbedCarbs: c.absorbedCarbs || 0,  // ✅ ALWAYS SET
          absorbedPercent: c.absorbedPercent || 0,  // ✅ ALWAYS SET

          // Legacy field
          mob: c.activeCarbs || c.mob,

          hoursSinceMeal: c.hoursSinceMeal,
          activityPercent: c.activity,

          // T1D: BG impacts
          bgElevation: c.bgElevation || c.bgImpact || 0,
          pendingBGRise: c.pendingBGRise || 0,
          bgImpact: c.bgElevation || c.bgImpact || 0,

          profile: c.profile
        })),
        by_absorption_type: byAbsorptionType
      },
      stacking: {
        is_stacking: stackedEffect.isStacking,
        risk_level: stackingAnalysis.severity.level,
        risk_score: stackingAnalysis.severity.score,
        risk_factors: stackingAnalysis.severity.factors,
        peak_overlap: stackingAnalysis.peakOverlap,
        fast_meal_mob: stackingAnalysis.fastMealMOB,
        slow_meal_mob: stackingAnalysis.slowMealMOB,
        recommendations: stackingAnalysis.recommendations,
        alerts: stackingAnalysis.alerts
      },
      carb_to_bg_factor: carbToBGFactor
    };
  } catch (error) {
    console.error('Error calculating active meal effects:', error);
    throw error;
  }
}


/**
 * Calculate meal impact for insulin dose calculation - T1D Model
 *
 * Integrates with insulin calculation logic to provide accurate
 * carb counting considering active meals.
 *
 * T1D MODEL:
 * - new_meal.expected_peak_bg_impact = MAX BG rise when fully absorbed
 * - active_meals.current_bg_elevation = CURRENT BG rise from already absorbed carbs
 * - active_meals.pending_bg_rise = FUTURE additional rise from MOB
 *
 * @param {object} mealData - New meal nutrition and context
 * @param {object} patientConstants - User's constants
 * @param {object} activeMealData - Current MOB from calculateActiveMealEffects
 * @returns {object} Meal impact breakdown with T1D model
 */
export function calculateMealImpact(
  mealData,
  patientConstants,
  activeMealData = null
) {
  const {
    carbs = 0,
    protein = 0,
    fat = 0,
    absorptionType = 'medium',
    mealType = 'normal'
  } = mealData;

  // Extract constants
  const proteinFactor = patientConstants.protein_factor || 0.5;
  const fatFactor = patientConstants.fat_factor || 0.2;
  const carbToBGFactor = patientConstants.carb_to_bg_factor || 4.0;

  // Calculate carb equivalents
  const proteinCarbEquiv = protein * proteinFactor;
  const fatCarbEquiv = fat * fatFactor;
  const totalCarbEquiv = carbs + proteinCarbEquiv + fatCarbEquiv;

  // Get absorption profile
  const profile = getAbsorptionProfile(absorptionType);
  if (!profile) {
    throw new Error(`Unknown absorption type: ${absorptionType}`);
  }

  // Calculate expected TOTAL BG impact when new meal is fully absorbed
  const expectedTotalBGImpact = totalCarbEquiv * carbToBGFactor;

  // MOB = carbs still absorbing (will cause future rise)
  const activeMealMOB = activeMealData?.mob?.total_active_carbs || 0;

  // Current BG elevation from already absorbed carbs
  const currentBGElevation = activeMealData?.mob?.current_bg_elevation ||
                             activeMealData?.mob?.expected_bg_impact || 0;

  // Pending additional rise from remaining MOB
  const pendingBGRise = activeMealData?.mob?.pending_bg_rise ||
                        (activeMealMOB * carbToBGFactor);

  // Total combined carbs (new meal + MOB from active meals)
  const totalCombinedCarbs = totalCarbEquiv + activeMealMOB;

  // Total FUTURE BG impact = new meal total + pending from active
  const totalFutureBGImpact = expectedTotalBGImpact + pendingBGRise;

  // Current + Future = Total expected BG rise
  const totalExpectedBGRise = currentBGElevation + totalFutureBGImpact;

  return {
    new_meal: {
      carbs: Math.round(carbs * 10) / 10,
      protein_carb_equiv: Math.round(proteinCarbEquiv * 10) / 10,
      fat_carb_equiv: Math.round(fatCarbEquiv * 10) / 10,
      total_carb_equiv: Math.round(totalCarbEquiv * 10) / 10,
      absorption_type: absorptionType,
      peak_hours: profile.peak_hours,
      duration_hours: profile.duration_hours,

      // T1D: This is the TOTAL rise when new meal is fully absorbed
      expected_peak_bg_impact: Math.round(expectedTotalBGImpact * 10) / 10
    },
    active_meals: {
      // MOB = carbs still digesting (future rise)
      total_active_carbs: Math.round(activeMealMOB * 10) / 10,

      // T1D Model: distinguish current vs pending
      current_bg_elevation: Math.round(currentBGElevation * 10) / 10,  // Already happened
      pending_bg_rise: Math.round(pendingBGRise * 10) / 10,            // Will happen

      // Legacy field (now shows current elevation, not MOB-based)
      expected_bg_impact: Math.round(currentBGElevation * 10) / 10,

      active_meal_count: activeMealData?.mob?.active_meals_count || 0
    },
    combined: {
      // Total carbs to consider for insulin dosing
      total_carb_equiv: Math.round(totalCombinedCarbs * 10) / 10,

      // T1D: Total FUTURE BG rise (new meal + pending from active)
      total_future_bg_impact: Math.round(totalFutureBGImpact * 10) / 10,

      // T1D: Total expected rise including current elevation
      total_expected_bg_rise: Math.round(totalExpectedBGRise * 10) / 10,

      // Legacy field
      total_bg_impact: Math.round(totalFutureBGImpact * 10) / 10
    },
    stacking_warning: activeMealData?.stacking?.is_stacking || false,
    stacking_risk: activeMealData?.stacking?.risk_level || 'low',
    recommendations: generateMealRecommendations(
      totalCarbEquiv,
      activeMealData,
      absorptionType
    )
  };
}


/**
 * Generate meal recommendations based on calculation
 *
 * @private
 */
function generateMealRecommendations(newCarbEquiv, activeMealData, absorptionType) {
  const recommendations = [];

  const activeMealCarbs = activeMealData?.mob?.total_active_carbs || 0;
  const totalCarbs = newCarbEquiv + activeMealCarbs;

  if (activeMealCarbs > 30) {
    recommendations.push({
      type: 'warning',
      message: 'High MOB detected - significant carbs still absorbing',
      priority: 'high',
      details: `${activeMealCarbs.toFixed(0)}g carbs still active from previous meals`
    });
  }

  if (totalCarbs > 100) {
    recommendations.push({
      type: 'caution',
      message: 'Very high total carb load',
      priority: 'high',
      details: `Total of ${totalCarbs.toFixed(0)}g carb equivalents. Consider splitting the meal or reducing portion.`
    });
  }

  if (activeMealData?.stacking?.risk_level === 'high' ||
      activeMealData?.stacking?.risk_level === 'severe') {
    recommendations.push({
      type: 'warning',
      message: 'High meal stacking risk detected',
      priority: 'high',
      details: 'Consider waiting 1-2 hours before eating, or choose a smaller portion'
    });
  }

  // Mixed absorption warnings
  const fastMOB = activeMealData?.stacking?.fast_meal_mob || 0;
  const slowMOB = activeMealData?.stacking?.slow_meal_mob || 0;

  if (fastMOB > 15 && (absorptionType === 'slow' || absorptionType === 'very_slow')) {
    recommendations.push({
      type: 'info',
      message: 'Mixed absorption timing',
      priority: 'medium',
      details: 'Fast-absorbing carbs still active, now adding slow-absorbing meal. This complicates insulin timing.'
    });
  }

  if (slowMOB > 15 && (absorptionType === 'fast' || absorptionType === 'very_fast')) {
    recommendations.push({
      type: 'info',
      message: 'Mixed absorption timing',
      priority: 'medium',
      details: 'Slow-absorbing carbs still active, now adding fast-absorbing meal. Consider dual-wave bolus.'
    });
  }

  return recommendations;
}

/**
 * Calculate predicted blood glucose trajectory with meals
 *
 * Projects future BG considering:
 * - Current meal absorption
 * - Planned/future meals
 * - Baseline glucose
 *
 * @param {number} baselineBG - Baseline blood glucose without meal effects
 * @param {Array} allMeals - All meals (past and planned)
 * @param {object} patientConstants - User constants
 * @param {number} hoursAhead - How far to project (default: 8)
 * @returns {Array} Time-series BG predictions
 */
export function predictBloodGlucoseWithMeals(
  baselineBG,
  allMeals,
  patientConstants,
  hoursAhead = 8
) {
  const carbToBGFactor = patientConstants.carb_to_bg_factor || 4.0;
  const timeWindowMinutes = hoursAhead * 60;

  // Transform meals to include time offset
  const mealsWithTime = allMeals.map(meal => {
    const mealTime = new Date(meal.timestamp);
    const now = new Date();
    const minutesSinceMeal = (now - mealTime) / (1000 * 60);

    // Get carb equiv
    let carbEquiv = 0;
    if (meal.nutrition?.totalCarbEquiv) {
      carbEquiv = meal.nutrition.totalCarbEquiv;
    } else if (meal.nutrition?.total_carb_equiv) {
      carbEquiv = meal.nutrition.total_carb_equiv;
    } else {
      const carbs = meal.nutrition?.carbs || 0;
      const protein = (meal.nutrition?.protein || 0) * (patientConstants.protein_factor || 0.5);
      const fat = (meal.nutrition?.fat || 0) * (patientConstants.fat_factor || 0.2);
      carbEquiv = carbs + protein + fat;
    }

    return {
      carbEquiv: carbEquiv,
      absorptionType: meal.nutrition?.absorption_type || meal.calculation_summary?.absorption_type || 'medium',
      timeMinutes: -minutesSinceMeal, // Negative for past, positive for future
      name: meal.foodItems?.map(f => f.name).join(', ') || meal.mealType
    };
  });

  // Calculate BG response
  const timeline = calculateBGResponseWithMeals(
    baselineBG,
    mealsWithTime,
    carbToBGFactor,
    timeWindowMinutes,
    5 // 5-minute intervals
  );

  // Identify critical points
  const highestBG = Math.max(...timeline.map(t => t.bg));
  const highestBGTime = timeline.find(t => t.bg === highestBG);
  const highEvents = timeline.filter(t => t.isHigh).length;

  return {
    timeline: timeline,
    summary: {
      baseline_bg: baselineBG,
      highest_bg: Math.round(highestBG * 10) / 10,
      highest_bg_time: highestBGTime?.timeLabel,
      highest_bg_hours_from_now: highestBGTime?.hours,
      high_event_count: highEvents,
      high_minutes: highEvents * 5,
      total_mob: Math.round(highestBGTime?.totalMOB || 0),
      carb_to_bg_factor: carbToBGFactor
    },
    risk_assessment: analyzeHyperglycemiaRisk(
      baselineBG,
      mealsWithTime.map(m => ({
        ...m,
        hoursSinceMeal: -m.timeMinutes / 60
      })),
      carbToBGFactor
    )
  };
}

/**
 * Get meal timing recommendation
 *
 * Determines optimal timing for next meal based on:
 * - Current MOB
 * - Absorption patterns
 * - Blood glucose level
 *
 * @param {object} activeMealData - Current MOB from calculateActiveMealEffects
 * @param {number} currentBG - Current blood glucose
 * @param {number} proposedCarbEquiv - Proposed meal size
 * @param {string} proposedAbsorptionType - Proposed meal type
 * @returns {object} Timing recommendation
 */
export function getMealTimingRecommendation(
  activeMealData,
  currentBG,
  proposedCarbEquiv = 60,
  proposedAbsorptionType = 'medium'
) {
  const activeMOB = activeMealData?.mob?.total_active_carbs || 0;
  const stackingRisk = activeMealData?.stacking?.risk_level || 'low';

  let waitMinutes = 0;
  let confidence = 'high';
  let reason = '';

  // Check stacking risk
  if (stackingRisk === 'critical' || stackingRisk === 'severe') {
    waitMinutes = 120; // 2 hours
    confidence = 'high';
    reason = 'Critical meal stacking detected. Multiple meals at peak.';
  } else if (stackingRisk === 'high') {
    waitMinutes = 60; // 1 hour
    confidence = 'high';
    reason = 'High meal stacking risk. Significant carbs still absorbing.';
  } else if (activeMOB > 40) {
    waitMinutes = 30;
    confidence = 'medium';
    reason = `${activeMOB.toFixed(0)}g carbs still absorbing.`;
  }

  // Adjust based on BG
  if (currentBG > 200) {
    waitMinutes = Math.max(waitMinutes, 30);
    reason += ' Current BG is high - allow time for correction.';
  } else if (currentBG < 80) {
    waitMinutes = Math.max(0, waitMinutes - 15);
    reason += ' Current BG is low - may eat sooner if needed.';
  }

  // Check absorption conflicts
  const fastMOB = activeMealData?.stacking?.fast_meal_mob || 0;
  const slowMOB = activeMealData?.stacking?.slow_meal_mob || 0;

  if (fastMOB > 15 && (proposedAbsorptionType === 'slow' || proposedAbsorptionType === 'very_slow')) {
    confidence = 'medium';
    reason += ' Note: Adding slow meal while fast carbs are active - complex insulin timing.';
  }

  const description = waitMinutes === 0
    ? 'Safe to eat now'
    : `Wait ${waitMinutes} minutes before eating`;

  return {
    wait_minutes: waitMinutes,
    description: description,
    confidence: confidence,
    reason: reason,
    factors: {
      active_mob: Math.round(activeMOB * 10) / 10,
      stacking_risk: stackingRisk,
      current_bg: currentBG,
      proposed_carbs: proposedCarbEquiv,
      proposed_absorption: proposedAbsorptionType
    }
  };
}

/**
 * Format meal contributions for display - T1D Model
 *
 * Utility function to format MOB data for UI components
 * Shows the inverse relationship:  MOB (future rise) vs absorbed (current elevation)
 *
 * @param {object} activeMealData - Data from calculateActiveMealEffects
 * @returns {Array} Formatted contributions with T1D model
 */
export function formatMealContributionsForDisplay(activeMealData) {
  if (!activeMealData?.mob?.meal_contributions) {
    return [];
  }

  return activeMealData.mob.meal_contributions.map(contrib => {
    const profile = getAbsorptionProfile(contrib.absorptionType);

    return {
      id: contrib.mealId,
      mealType: contrib.mealType.charAt(0).toUpperCase() + contrib.mealType.slice(1),
      absorptionType: contrib.absorptionType,

      // Total carbs in meal
      totalCarbs: contrib.carbEquiv,

      // T1D Model: distinguish MOB from absorbed
      activeCarbs:  contrib.activeCarbs || contrib.mob,        // MOB - still digesting
      absorbedCarbs:  contrib.absorbedCarbs || 0,              // In bloodstream
      absorbedPercent: contrib.absorbedPercent || 0,

      // Legacy field
      mob: contrib.activeCarbs || contrib.mob,

      activityPercent: contrib.activityPercent,
      hoursSinceMeal: contrib.hoursSinceMeal,
      minutesSinceMeal:  Math.round(contrib.hoursSinceMeal * 60),

      // T1D: BG impacts
      bgElevation: contrib.bgElevation || contrib.bgImpact || 0,  // Current rise from absorbed
      pendingBGRise: contrib.pendingBGRise || 0,                  // Future rise from MOB
      bgImpact: contrib.bgElevation || contrib.bgImpact || 0,     // Legacy field

      timeToEnd: Math.round((contrib.profile.duration - contrib.hoursSinceMeal) * 60),
      status: getMealStatus(contrib.hoursSinceMeal, contrib.profile)
    };
  });
}

/**
 * Get human-readable meal status
 *
 * @private
 */
function getMealStatus(hoursSinceMeal, profile) {
  if (hoursSinceMeal < profile.onset_hours) {
    return 'Starting';
  } else if (hoursSinceMeal < profile.peak_hours) {
    return 'Rising';
  } else if (hoursSinceMeal < profile.duration_hours) {
    return 'Peak';
  } else {
    return 'Declining';
  }
}

/**
 * Calculate net carb impact for insulin dosing - T1D Model
 *
 * Combines new meal carbs with active meal data to determine
 * total carb load and BG impact for insulin calculation.
 *
 * T1D MODEL:
 * - current_bg_elevation: BG rise already happened from absorbed carbs
 * - pending_bg_rise: BG rise coming from MOB (carbs still digesting)
 * - new_meal_bg_impact: BG rise from new meal when fully absorbed
 * - total_future_bg_rise: pending + new meal (what insulin needs to cover)
 *
 * @param {number} newMealCarbs - Carb equivalents in new meal
 * @param {object} activeMealData - Current MOB data
 * @param {object} patientConstants - User constants
 * @returns {object} Net carb impact breakdown with T1D model
 */
export function calculateNetCarbImpact(
  newMealCarbs,
  activeMealData,
  patientConstants
) {
  const carbToBGFactor = patientConstants.carb_to_bg_factor || 4.0;

  // MOB = carbs still absorbing (will cause future rise)
  const activeMOB = activeMealData?.mob?.total_active_carbs || 0;

  // Absorbed carbs = already in bloodstream (current elevation)
  const absorbedCarbs = activeMealData?.mob?.total_absorbed_carbs || 0;

  // Current BG elevation from absorbed carbs
  const currentBGElevation = activeMealData?.mob?.current_bg_elevation ||
                             activeMealData?.mob?.expected_bg_impact || 0;

  // Pending rise from MOB
  const pendingBGRise = activeMOB * carbToBGFactor;

  // New meal impact (when fully absorbed)
  const newMealBGImpact = newMealCarbs * carbToBGFactor;

  // Total carbs for insulin calculation = new meal + MOB
  // (absorbed carbs already caused BG rise, don't double count)
  const totalCarbsForInsulin = newMealCarbs + activeMOB;

  // Total FUTURE BG rise = pending from MOB + new meal
  const totalFutureBGRise = pendingBGRise + newMealBGImpact;

  // Total expected BG state = current elevation + future rise
  const totalExpectedBGRise = currentBGElevation + totalFutureBGRise;

  return {
    // New meal
    new_meal_carbs: Math.round(newMealCarbs * 10) / 10,
    new_meal_bg_impact: Math.round(newMealBGImpact * 10) / 10,

    // Active meals - T1D breakdown
    active_mob: Math.round(activeMOB * 10) / 10,              // Future rise
    absorbed_carbs: Math.round(absorbedCarbs * 10) / 10,      // Already absorbed
    current_bg_elevation: Math.round(currentBGElevation * 10) / 10,  // Current BG impact
    pending_bg_rise: Math.round(pendingBGRise * 10) / 10,     // Coming from MOB

    // Totals for insulin dosing
    total_carbs_for_insulin: Math.round(totalCarbsForInsulin * 10) / 10,
    total_future_bg_rise: Math.round(totalFutureBGRise * 10) / 10,
    total_expected_bg_rise: Math.round(totalExpectedBGRise * 10) / 10,

    // Legacy fields
    total_carbs: Math.round(totalCarbsForInsulin * 10) / 10,
    active_meal_bg_impact: Math.round(pendingBGRise * 10) / 10,
    total_bg_impact: Math.round(totalFutureBGRise * 10) / 10,

    // Percentages
    mob_percentage: totalCarbsForInsulin > 0
      ? Math.round((activeMOB / totalCarbsForInsulin) * 100)
      : 0,
    absorbed_percentage: (absorbedCarbs + activeMOB) > 0
      ? Math.round((absorbedCarbs / (absorbedCarbs + activeMOB)) * 100)
      : 0
  };
}

// Export all functions
export default {
  calculateActiveMealEffects,
  calculateMealImpact,
  predictBloodGlucoseWithMeals,
  getMealTimingRecommendation,
  formatMealContributionsForDisplay,
  calculateNetCarbImpact,

  // Re-export from sub-modules for convenience
  calculateMealActivity,
  calculateMOB,
  getAbsorptionProfile,
  analyzeMealStackingRisk,
  analyzeHyperglycemiaRisk,
  generateMealTimeSeries,
  checkMealSafety
};



