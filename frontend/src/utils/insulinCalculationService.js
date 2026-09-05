/**
 * ============================================================================
 * INSULIN CALCULATION SERVICE
 * ============================================================================
 * 
 * High-level service for integrating insulin calculations with meal planning
 * and blood glucose management. This is the main interface used by the
 * frontend application.
 * 
 * Integrates:
 * - Insulin pharmacodynamics (activity, IOB)
 * - Stacking analysis and counter-regulation
 * - Meal-based insulin dosing
 * - Real-time active insulin tracking
 * 
 * Author: Enhanced IOB System
 * Version: 2.1 - TIME NORMALIZATION FIX
 *
 * CHANGELOG v2.1:
 * - ✅ FIXED: Added TimeManager import for time normalization
 * - ✅ FIXED: Normalized calculationTime to minute precision (matches meal service)
 * - ✅ FIXED: Prevents re-render loops caused by microsecond time variations
 * ============================================================================
 */

import {
  calculateIOB,
  calculateInsulinActivity,
  calculateStackedInsulinEffect,
  calculateBGImpact,
  getInsulinProfile,
  generateInsulinTimeSeries,
  isInsulinActive
} from './insulinPharmacodynamics';

import {
  analyzeStackingRisk,
  calculateBGResponseWithCounterReg,
  analyzeHypoglycemiaRisk,
  getT1DDurationLabel
} from './insulinStackingAnalyzer';

import { SHARED_CONSTANTS } from '../constants/shared_constants.js';

// ✅ CRITICAL FIX: Import TimeManager for time normalization
import TimeManager from '../utils/TimeManager';

/**
 * Calculate active insulin effects for a user at a specific time
 *
 * This is the main function used by the frontend to get current IOB/stacking info.
 * Used in meal logging, insulin input, and dashboard displays.
 *
 * ✅ FIXED v2.1: Now normalizes time to minute precision to match meal service
 * and prevent re-render loops from microsecond time variations.
 *
 * @param {Array} recentDoses - Array of recent insulin doses from backend
 * @param {Date|string} targetTime - Time to calculate for (default: now)
 * @param {object} patientConstants - User's insulin sensitivity constants
 * @returns {object} Complete active insulin analysis
 */
export async function calculateActiveInsulinEffects(
  recentDoses,
  targetTime = new Date(),
  patientConstants = null
) {
  try {
    // ✅ CRITICAL FIX: Normalize time to minute precision (matches meal service)
    // This prevents micro-second variations from causing continuous re-renders
    const rawTime = targetTime instanceof Date ? targetTime : new Date(targetTime);
    const calculationTime = new Date(Math.floor(rawTime.getTime() / 60000) * 60000);

    // 🔍 DEBUG: Log time normalization (can be removed in production)
    if (rawTime.getTime() !== calculationTime.getTime()) {
      console.log('⏱️ Insulin Service - Time Normalized:', {
        rawTime: rawTime.toISOString(),
        normalizedTime: calculationTime.toISOString(),
        differenceMs: rawTime.getTime() - calculationTime.getTime(),
        note: 'Normalized to minute boundary to prevent re-render loops'
      });
    }

    // Use patient-specific constants or defaults
    const constants = patientConstants || SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS;
    const correctionFactor = constants.correction_factor || 50;

    // Transform recent doses to calculation format
    const activeDoses = recentDoses
      .map(dose => {
        const takenAt = new Date(dose.taken_at || dose.scheduled_time);
        const hoursSinceDose = (calculationTime - takenAt) / (1000 * 60 * 60);

        const profile = getInsulinProfile(dose.medication);

        // Only include if still within duration window
        if (!profile || hoursSinceDose < 0 || hoursSinceDose > profile.duration_hours) {
          return null;
        }

        return {
          dose: dose.dose,
          insulinType: dose.medication,
          hoursSinceDose: hoursSinceDose,
          takenAt: takenAt.toISOString(),
          doseId: dose.id || dose._id
        };
      })
      .filter(dose => dose !== null);

    // Calculate stacked effects
    const stackedEffect = calculateStackedInsulinEffect(activeDoses, correctionFactor);

    // Analyze stacking risk
    const stackingAnalysis = analyzeStackingRisk(activeDoses, correctionFactor);

    // Calculate contribution by insulin type
    const byInsulinType = {};
    stackingAnalysis.contributions.forEach(contrib => {
      if (!byInsulinType[contrib.insulinType]) {
        byInsulinType[contrib.insulinType] = {
          totalDose: 0,
          totalIOB: 0,
          totalActivity: 0,
          doses: []
        };
      }

      byInsulinType[contrib.insulinType].totalDose += contrib.dose;
      byInsulinType[contrib.insulinType].totalIOB += contrib.iob;
      byInsulinType[contrib.insulinType].totalActivity += contrib.activity;
      byInsulinType[contrib.insulinType].doses.push(contrib);
    });

    return {
      calculation_time: calculationTime.toISOString(),
      calculation_timezone: 'UTC',
      iob: {
        total_active_insulin: stackedEffect.totalIOB,
        total_activity_percent: stackedEffect.totalActivity,
        total_bg_impact: stackedEffect.totalBGImpact,
        active_doses_count: stackedEffect.activeDoses,
        insulin_contributions: stackingAnalysis.contributions.map(c => ({
          insulinType: c.insulinType,
          dose: c.dose,
          activeUnits: c.activeUnits,
          iob: c.iob,
          hoursSinceDose: c.hoursSinceDose,
          activityPercent: c.activity,
          bgImpact: c.bgImpact,
          profile: c.profile
        })),
        by_insulin_type: byInsulinType
      },
      stacking: {
        is_stacking: stackedEffect.isStacking,
        risk_level: stackingAnalysis.severity.level,
        risk_score: stackingAnalysis.severity.score,
        risk_factors: stackingAnalysis.severity.factors,
        peak_overlap: stackingAnalysis.peakOverlap,
        rapid_acting_iob: stackingAnalysis.rapidActingIOB,
        recommendations: stackingAnalysis.recommendations,
        alerts: stackingAnalysis.alerts
      },
      correction_factor: correctionFactor
    };
  } catch (error) {
    console.error('Error calculating active insulin effects:', error);
    throw error;
  }
}

/**
 * Calculate suggested insulin dose for a meal
 *
 * Integrates with meal calculation logic to provide insulin recommendations
 * considering active insulin (IOB) and stacking risk.
 *
 * @param {object} mealData - Meal nutrition and context
 * @param {object} patientConstants - User's insulin parameters
 * @param {object} activeInsulinData - Current IOB from calculateActiveInsulinEffects
 * @returns {object} Insulin dose recommendation with breakdown
 */
export function calculateMealInsulinDose(
  mealData,
  patientConstants,
  activeInsulinData = null
) {
  const {
    carbs = 0,
    protein = 0,
    fat = 0,
    bloodSugar = null,
    mealType = 'normal',
    activityLevel = 0,
    absorptionFactor = 1.0
  } = mealData;

  // Extract constants
  const insulinToCarb = patientConstants.insulin_to_carb_ratio || 10;
  const correctionFactor = patientConstants.correction_factor || 50;
  const targetGlucose = patientConstants.target_glucose || 100;
  const proteinFactor = patientConstants.protein_factor || 0.5;
  const fatFactor = patientConstants.fat_factor || 0.2;

  // Calculate carb equivalents
  const proteinCarbEquiv = protein * proteinFactor;
  const fatCarbEquiv = fat * fatFactor;
  const totalCarbEquiv = carbs + proteinCarbEquiv + fatCarbEquiv;

  // Base insulin from carbs
  const baseInsulin = totalCarbEquiv / insulinToCarb;

  // Apply meal timing factor
  const mealTimingFactors = patientConstants.meal_timing_factors ||
    SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.meal_timing_factors;
  const mealTimingFactor = mealTimingFactors[mealType] || 1.0;

  // Apply activity coefficient
  const activityCoefficients = patientConstants.activity_coefficients ||
    SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.activity_coefficients;
  const activityCoefficient = activityCoefficients[activityLevel.toString()] || 1.0;

  // Calculate adjusted insulin
  const adjustedInsulin = baseInsulin * absorptionFactor * mealTimingFactor * activityCoefficient;

  // Calculate correction insulin if blood sugar provided
  let correctionInsulin = 0;
  if (bloodSugar !== null && bloodSugar > targetGlucose) {
    correctionInsulin = (bloodSugar - targetGlucose) / correctionFactor;
  }

  // Total before considering active insulin
  const totalBeforeIOB = adjustedInsulin + correctionInsulin;

  // Consider active insulin (IOB)
  const activeInsulin = activeInsulinData?.iob?.total_active_insulin || 0;

  // Calculate MOB (Meal On Board) - simplified for now
  // In future, this should track carbs still being absorbed
  const activeMealCarbs = 0; // TODO: Implement MOB tracking
  const mobInsulinEquiv = activeMealCarbs / insulinToCarb;

  // Subtract active insulin and MOB
  const totalAfterIOB = Math.max(0, totalBeforeIOB - activeInsulin - mobInsulinEquiv);

  // Apply minimum threshold
  let finalInsulin = totalAfterIOB;
  if (totalBeforeIOB > 0 && finalInsulin < 0.5) {
    finalInsulin = 0.5; // Minimum 0.5 units if any insulin needed
  }

  // Round to nearest 0.5 units (typical insulin pen increment)
  finalInsulin = Math.round(finalInsulin * 2) / 2;

  return {
    suggested_dose: finalInsulin,
    breakdown: {
      // Nutrition
      carbs: Math.round(carbs * 10) / 10,
      protein_carb_equiv: Math.round(proteinCarbEquiv * 10) / 10,
      fat_carb_equiv: Math.round(fatCarbEquiv * 10) / 10,
      total_carb_equiv: Math.round(totalCarbEquiv * 10) / 10,

      // Insulin calculation
      base_insulin: Math.round(baseInsulin * 100) / 100,
      adjusted_insulin: Math.round(adjustedInsulin * 100) / 100,
      correction_insulin: Math.round(correctionInsulin * 100) / 100,
      total_before_iob: Math.round(totalBeforeIOB * 100) / 100,

      // Active insulin adjustment
      active_insulin: Math.round(activeInsulin * 100) / 100,
      active_meal_carbs: Math.round(activeMealCarbs * 100) / 100,
      mob_insulin_equiv: Math.round(mobInsulinEquiv * 100) / 100,
      total_after_iob: Math.round(totalAfterIOB * 100) / 100,

      // Adjustment factors
      absorption_factor: absorptionFactor,
      meal_timing_factor: mealTimingFactor,
      activity_coefficient: activityCoefficient
    },
    stacking_warning: activeInsulinData?.stacking?.is_stacking || false,
    stacking_risk: activeInsulinData?.stacking?.risk_level || 'low',
    recommendations: generateDoseRecommendations(
      finalInsulin,
      activeInsulinData,
      totalBeforeIOB
    )
  };
}

/**
 * Generate dose recommendations based on calculation
 *
 * @private
 */
function generateDoseRecommendations(suggestedDose, activeInsulinData, totalBeforeIOB) {
  const recommendations = [];

  if (suggestedDose === 0 && totalBeforeIOB > 0) {
    recommendations.push({
      type: 'info',
      message: 'No additional insulin needed - active insulin covers this meal',
      priority: 'high'
    });
  }

  if (activeInsulinData?.stacking?.risk_level === 'high' ||
      activeInsulinData?.stacking?.risk_level === 'severe') {
    recommendations.push({
      type: 'warning',
      message: 'High insulin stacking risk detected',
      priority: 'high',
      details: 'Consider waiting 1-2 hours before dosing, or reduce dose by 20-30%'
    });
  }

  if (activeInsulinData?.iob?.total_active_insulin > 5) {
    recommendations.push({
      type: 'caution',
      message: `${activeInsulinData.iob.total_active_insulin.toFixed(1)}u insulin still active`,
      priority: 'medium',
      details: 'Monitor blood glucose closely after this dose'
    });
  }

  if (suggestedDose > 0 && suggestedDose < 1) {
    recommendations.push({
      type: 'info',
      message: 'Small dose recommended',
      priority: 'low',
      details: 'Consider if this meal warrants insulin or if you can wait'
    });
  }

  return recommendations;
}

/**
 * Calculate predicted blood glucose trajectory
 *
 * Projects future BG considering:
 * - Current insulin activity
 * - Planned/future doses
 * - Counter-regulatory responses
 *
 * ✅ FIXED v2.1: Now normalizes time to minute precision
 *
 * @param {number} currentBG - Current blood glucose (mg/dL)
 * @param {Array} allDoses - All insulin doses (past and planned)
 * @param {object} patientConstants - User constants
 * @param {number} t1dDuration - Years with T1D
 * @param {number} hoursAhead - How far to project (default: 8)
 * @returns {Array} Time-series BG predictions
 */
export function predictBloodGlucoseTrajectory(
  currentBG,
  allDoses,
  patientConstants,
  t1dDuration = 5,
  hoursAhead = 8
) {
  const correctionFactor = patientConstants.correction_factor || 50;
  const timeWindowMinutes = hoursAhead * 60;

  // ✅ CRITICAL FIX: Normalize current time to minute precision
  const now = new Date(Math.floor(Date.now() / 60000) * 60000);

  // Transform doses to include time offset
  const dosesWithTime = allDoses.map(dose => {
    const takenAt = new Date(dose.taken_at || dose.scheduled_time);
    const minutesSinceDose = (now - takenAt) / (1000 * 60);

    return {
      dose: dose.dose,
      insulinType: dose.medication,
      timeMinutes: -minutesSinceDose, // Negative for past, positive for future
      name: dose.name || dose.medication
    };
  });

  // Calculate BG response with counter-regulation
  const timeline = calculateBGResponseWithCounterReg(
    currentBG,
    dosesWithTime,
    correctionFactor,
    t1dDuration,
    timeWindowMinutes,
    5 // 5-minute intervals
  );

  // Identify critical points
  const lowestBG = Math.min(...timeline.map(t => t.bg));
  const lowestBGTime = timeline.find(t => t.bg === lowestBG);
  const hypoEvents = timeline.filter(t => t.isHypo).length;

  return {
    timeline: timeline,
    summary: {
      current_bg: currentBG,
      lowest_bg: Math.round(lowestBG * 10) / 10,
      lowest_bg_time: lowestBGTime?.timeLabel,
      lowest_bg_hours_from_now: lowestBGTime?.hours,
      hypo_event_count: hypoEvents,
      hypo_minutes: hypoEvents * 5,
      counter_reg_effectiveness: Math.round(
        (1 - (lowestBGTime?.bgWithoutCounterReg - lowestBG) / lowestBGTime?.bgWithoutCounterReg) * 100
      ) || 0,
      t1d_duration: t1dDuration,
      t1d_duration_label: getT1DDurationLabel(t1dDuration)
    },
    risk_assessment: analyzeHypoglycemiaRisk(
      currentBG,
      dosesWithTime.map(d => ({
        ...d,
        hoursSinceDose: -d.timeMinutes / 60
      })),
      correctionFactor,
      t1dDuration
    )
  };
}

/**
 * Get insulin timing recommendation for a meal
 * 
 * Determines optimal timing for insulin administration based on:
 * - Meal absorption speed
 * - Insulin type
 * - Current blood glucose
 * 
 * @param {string} insulinType - Type of insulin to be used
 * @param {number} mealAbsorptionSpeed - How fast meal will absorb
 * @param {number} currentBG - Current blood glucose
 * @param {object} patientConstants - User constants
 * @returns {object} Timing recommendation
 */
export function getInsulinTimingRecommendation(
  insulinType,
  mealAbsorptionSpeed = 'medium',
  currentBG = 100,
  patientConstants = null
) {
  const constants = patientConstants || SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS;
  const profile = getInsulinProfile(insulinType);

  if (!profile) {
    return {
      timing_minutes: 0,
      description: 'Take insulin at start of meal',
      confidence: 'low'
    };
  }

  // Get timing guidelines from constants
  const timingGuidelines = constants.insulin_timing_guidelines || 
    SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines;

  const baseGuideline = timingGuidelines[mealAbsorptionSpeed] || timingGuidelines['medium'];

  // Adjust based on current BG
  let timingAdjustment = 0;
  if (currentBG > 180) {
    timingAdjustment = 5; // Dose earlier if high
  } else if (currentBG < 80) {
    timingAdjustment = -5; // Dose later if low
  }

  // Adjust based on insulin onset
  let onsetAdjustment = 0;
  if (profile.type === 'ultra_rapid') {
    onsetAdjustment = -5; // Ultra-rapid can be taken closer to meal
  } else if (profile.type === 'short_acting' || profile.type === 'intermediate_acting') {
    onsetAdjustment = 10; // Regular insulin needs more lead time
  }

  const finalTiming = Math.max(0, baseGuideline.timing_minutes + timingAdjustment + onsetAdjustment);

  return {
    timing_minutes: finalTiming,
    description: finalTiming === 0 
      ? 'Take insulin at the start of meal'
      : `Take insulin ${finalTiming} minutes before eating`,
    confidence: currentBG >= 70 && currentBG <= 180 ? 'high' : 'medium',
    factors: {
      base_timing: baseGuideline.timing_minutes,
      bg_adjustment: timingAdjustment,
      insulin_onset_adjustment: onsetAdjustment,
      current_bg: currentBG,
      meal_absorption: mealAbsorptionSpeed,
      insulin_type: insulinType
    }
  };
}

/**
 * Format insulin contributions for display
 * 
 * Utility function to format IOB data for UI components
 * 
 * @param {object} activeInsulinData - Data from calculateActiveInsulinEffects
 * @returns {Array} Formatted contributions
 */
export function formatInsulinContributionsForDisplay(activeInsulinData) {
  if (!activeInsulinData?.iob?.insulin_contributions) {
    return [];
  }

  return activeInsulinData.iob.insulin_contributions.map(contrib => {
    const profile = getInsulinProfile(contrib.insulinType);
    const brandName = profile?.brand_names?.[0] || contrib.insulinType;

    return {
      id: `${contrib.insulinType}-${contrib.hoursSinceDose}`,
      insulinName: brandName,
      insulinType: contrib.insulinType,
      originalDose: contrib.dose,
      activeUnits: contrib.activeUnits,
      iob: contrib.iob,
      activityPercent: contrib.activityPercent,
      hoursSinceDose: contrib.hoursSinceDose,
      minutesSinceDose: Math.round(contrib.hoursSinceDose * 60),
      bgImpact: contrib.bgImpact,
      timeToEnd: Math.round((contrib.profile.duration - contrib.hoursSinceDose) * 60),
      status: getInsulinStatus(contrib.hoursSinceDose, contrib.profile)
    };
  });
}

/**
 * Get human-readable insulin status
 * 
 * @private
 */
function getInsulinStatus(hoursSinceDose, profile) {
  if (hoursSinceDose < profile.onset_hours) {
    return 'Starting';
  } else if (hoursSinceDose < profile.peak_hours) {
    return 'Rising';
  } else if (hoursSinceDose < profile.peak_hours * 1.5) {
    return 'Peak';
  } else {
    return 'Declining';
  }
}

// Export all functions
export default {
  calculateActiveInsulinEffects,
  calculateMealInsulinDose,
  predictBloodGlucoseTrajectory,
  getInsulinTimingRecommendation,
  formatInsulinContributionsForDisplay,
  
  // Re-export from sub-modules for convenience
  calculateIOB,
  calculateInsulinActivity,
  getInsulinProfile,
  analyzeStackingRisk,
  analyzeHypoglycemiaRisk,
  generateInsulinTimeSeries
};



