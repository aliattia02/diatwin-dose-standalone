/**
 * ============================================================================
 * MEAL STACKING ANALYZER (Refactored)
 * ============================================================================
 *
 * Implements advanced meal stacking detection, timing conflict assessment,
 * and glycemic management for Type 1 Diabetes.
 *
 * Key Features:
 * - Multi-meal overlap detection with peak timing analysis
 * - Absorption conflict detection (fast + slow meal combinations)
 * - BG trajectory prediction considering meal stacking
 * - Safety recommendations and timing alerts
 *
 * Parallel to insulinStackingAnalyzer.js but for meal effects
 *
 * Author: Enhanced MOB System
 * Version: 3.0 (Refactored)
 * ============================================================================
 */

import {
  calculateMealActivity,
  calculateMOB,
  getAbsorptionProfile,
  calculateAbsorbedFraction
} from './mealPharmacodynamics.js';

/**
 * ============================================================================
 * STACKING THRESHOLDS (Moved from netEffectCalculationService)
 * ============================================================================
 */

export const MEAL_STACKING_THRESHOLDS = {
  CRITICAL_MOB: 100,
  HIGH_MOB: 70,
  MODERATE_MOB: 50,
  LOW_MOB: 30,
  CRITICAL_FAST_MOB: 40,
  HIGH_FAST_MOB: 25,
  MODERATE_FAST_MOB: 15,
  PEAK_OVERLAP: {
    CRITICAL: 3,
    HIGH: 2,
    MODERATE: 1
  }
};

/**
 * ============================================================================
 * MEAL STACKING ANALYSIS
 * ============================================================================
 */

/**
 * Analyze meal stacking risk from multiple meals
 *
 * Stacking occurs when multiple meals overlap, creating additive BG effects
 * that can cause hyperglycemia or complicate insulin dosing.
 *
 * @param {Array} meals - Array of meal objects with {carbEquiv, hoursSinceMeal, absorptionType, mealType}
 * @param {number} carbToBGFactor - BG impact per gram (default: 4.0)
 * @returns {object} Complete stacking analysis
 */
export function analyzeMealStackingRisk(meals, carbToBGFactor = 4.0) {
  if (!meals || meals.length === 0) {
    return {
      isStacking: false,
      severity: { level: 'none', score: 0, factors: [] },
      peakOverlap: 0,
      fastMealMOB: 0,
      slowMealMOB: 0,
      contributions: [],
      recommendations: [],
      alerts: []
    };
  }

  const contributions = [];
  let totalMOB = 0;
  let totalActivity = 0;
  let fastMealMOB = 0;
  let slowMealMOB = 0;

  // Analyze each meal
  meals.forEach(meal => {
    const profile = getAbsorptionProfile(meal.absorptionType);
    if (!profile) return;

    const activity = calculateMealActivity(meal.hoursSinceMeal, profile);
    const mob = calculateMOB(meal.hoursSinceMeal, meal.carbEquiv, profile);
    const absorbedFraction = calculateAbsorbedFraction(meal.hoursSinceMeal, profile);

    // Calculate both absorbed and active carbs
    const absorbedCarbs = meal.carbEquiv * absorbedFraction;
    const activeCarbs = meal.carbEquiv * (1 - absorbedFraction);

    // T1D Model: BG elevation from ABSORBED carbs (not MOB!)
    const bgElevation = absorbedCarbs * carbToBGFactor;
    const pendingBGRise = activeCarbs * carbToBGFactor;

    totalMOB += mob;
    totalActivity += activity;

    if (meal.absorptionType === 'very_fast' || meal.absorptionType === 'fast') {
      fastMealMOB += mob;
    } else if (meal.absorptionType === 'slow' || meal.absorptionType === 'very_slow') {
      slowMealMOB += mob;
    }

    contributions.push({
      mealId: meal.id || meal.mealId,
      mealType: meal.mealType || 'unknown',
      absorptionType: meal.absorptionType,
      carbEquiv: meal.carbEquiv,
      hoursSinceMeal: Math.round(meal.hoursSinceMeal * 100) / 100,
      activity: Math.round(activity * 10) / 10,

      // T1D Model: Include both absorbed and active carbs
      absorbedCarbs: Math.round(absorbedCarbs * 10) / 10,
      activeCarbs: Math.round(activeCarbs * 10) / 10,
      absorbedPercent: Math.round(absorbedFraction * 100),

      // Legacy fields
      mob: Math.round(mob * 100) / 100,

      // T1D Model: BG impacts
      bgElevation: Math.round(bgElevation * 10) / 10,  // Current elevation
      pendingBGRise: Math.round(pendingBGRise * 10) / 10,  // Future rise
      bgImpact: Math.round(bgElevation * 10) / 10,  // Legacy field

      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        absorptionType: meal.absorptionType
      }
    });
  });

  // Detect peak overlap - multiple meals at or near peak simultaneously
  const peakOverlap = contributions.filter(c => {
    const profile = c.profile;
    const peakStart = profile.peak * 0.5;
    const peakEnd = profile.peak * 1.5;
    return c.hoursSinceMeal >= peakStart && c.hoursSinceMeal <= peakEnd;
  }).length;

  // Calculate stacking severity
  const severity = calculateStackingSeverity(
    contributions.length,
    totalMOB,
    fastMealMOB,
    slowMealMOB,
    peakOverlap
  );

  // Generate recommendations
  const recommendations = generateStackingRecommendations(
    severity,
    totalMOB,
    fastMealMOB,
    slowMealMOB,
    peakOverlap,
    contributions
  );

  // Generate alerts
  const alerts = generateStackingAlerts(severity, totalMOB, peakOverlap);

  return {
    isStacking: contributions.length > 1,
    severity: severity,
    peakOverlap: peakOverlap,
    fastMealMOB: Math.round(fastMealMOB * 100) / 100,
    slowMealMOB: Math.round(slowMealMOB * 100) / 100,
    totalMOB: Math.round(totalMOB * 100) / 100,
    totalActivity: Math.round(totalActivity * 10) / 10,
    contributions: contributions,
    recommendations: recommendations,
    alerts: alerts
  };
}

/**
 * Calculate stacking severity level and score
 * Uses thresholds from MEAL_STACKING_THRESHOLDS
 *
 * @private
 */
function calculateStackingSeverity(mealCount, totalMOB, fastMealMOB, slowMealMOB, peakOverlap) {
  let score = 0;
  const factors = [];
  const thresholds = MEAL_STACKING_THRESHOLDS;

  // Factor 1: Number of active meals
  if (mealCount >= 4) {
    score += 30;
    factors.push(`${mealCount} simultaneous meals absorbing`);
  } else if (mealCount === 3) {
    score += 20;
    factors.push(`${mealCount} simultaneous meals absorbing`);
  } else if (mealCount === 2) {
    score += 10;
    factors.push(`${mealCount} simultaneous meals absorbing`);
  }

  // Factor 2: Total MOB
  if (totalMOB > thresholds.CRITICAL_MOB) {
    score += 40;
    factors.push(`Very high MOB (${totalMOB.toFixed(0)}g active carbs)`);
  } else if (totalMOB > thresholds.HIGH_MOB) {
    score += 30;
    factors.push(`High MOB (${totalMOB.toFixed(0)}g active carbs)`);
  } else if (totalMOB > thresholds.MODERATE_MOB) {
    score += 20;
    factors.push(`Elevated MOB (${totalMOB.toFixed(0)}g active carbs)`);
  } else if (totalMOB > thresholds.LOW_MOB) {
    score += 10;
    factors.push(`Moderate MOB (${totalMOB.toFixed(0)}g active carbs)`);
  }

  // Factor 3: Fast-absorbing MOB (more dangerous for rapid BG spikes)
  if (fastMealMOB > thresholds.CRITICAL_FAST_MOB) {
    score += 30;
    factors.push(`High fast-absorbing carbs (${fastMealMOB.toFixed(0)}g)`);
  } else if (fastMealMOB > thresholds.HIGH_FAST_MOB) {
    score += 20;
    factors.push(`Elevated fast-absorbing carbs (${fastMealMOB.toFixed(0)}g)`);
  } else if (fastMealMOB > thresholds.MODERATE_FAST_MOB) {
    score += 10;
    factors.push(`Active fast-absorbing carbs (${fastMealMOB.toFixed(0)}g)`);
  }

  // Factor 4: Peak overlap (most dangerous - additive BG spikes)
  if (peakOverlap >= thresholds.PEAK_OVERLAP.CRITICAL) {
    score += 40;
    factors.push(`${peakOverlap} meals at peak simultaneously`);
  } else if (peakOverlap >= thresholds.PEAK_OVERLAP.HIGH) {
    score += 30;
    factors.push(`${peakOverlap} meals at peak simultaneously`);
  } else if (peakOverlap === thresholds.PEAK_OVERLAP.MODERATE) {
    score += 10;
    factors.push(`1 meal at peak absorption`);
  }

  // Factor 5: Mixed fast + slow (complicates insulin timing)
  if (fastMealMOB > 15 && slowMealMOB > 15) {
    score += 15;
    factors.push(`Mixed fast + slow absorption (complex insulin timing)`);
  }

  // Determine severity level
  let level;
  if (score >= 80) {
    level = 'critical';
  } else if (score >= 60) {
    level = 'severe';
  } else if (score >= 40) {
    level = 'high';
  } else if (score >= 20) {
    level = 'moderate';
  } else if (score > 0) {
    level = 'low';
  } else {
    level = 'none';
  }

  return {
    level: level,
    score: score,
    factors: factors
  };
}

/**
 * Generate stacking recommendations
 *
 * @private
 */
function generateStackingRecommendations(
  severity,
  totalMOB,
  fastMealMOB,
  slowMealMOB,
  peakOverlap,
  contributions
) {
  const recommendations = [];

  if (severity.level === 'critical' || severity.level === 'severe') {
    recommendations.push({
      type: 'critical',
      priority: 'urgent',
      message: '⚠️ CRITICAL MEAL STACKING DETECTED',
      action: 'Wait 2-3 hours before eating again. Risk of severe hyperglycemia.',
      details: 'Multiple overlapping meal peaks detected. BG will continue rising for next 1-2 hours.'
    });

    recommendations.push({
      type: 'safety',
      priority: 'urgent',
      message: 'Monitor blood glucose every 30-60 minutes',
      action: 'Be prepared to give correction insulin if BG exceeds target range',
      details: 'Consider setting CGM high alert to 200 mg/dL or your target + 50.'
    });
  } else if (severity.level === 'high') {
    recommendations.push({
      type: 'warning',
      priority: 'high',
      message: '⚠️ High meal stacking risk detected',
      action: 'Wait 1-2 hours before next meal, or choose low-carb option',
      details: `${totalMOB.toFixed(0)}g carbs still absorbing. Consider insulin needs carefully.`
    });

    if (fastMealMOB > 25) {
      recommendations.push({
        type: 'caution',
        priority: 'high',
        message: 'Significant fast-absorbing carbs still active',
        action: 'Monitor BG closely for next 1-2 hours - rapid spike expected',
        details: `${fastMealMOB.toFixed(0)}g fast-absorbing carbs on board`
      });
    }
  } else if (severity.level === 'moderate') {
    recommendations.push({
      type: 'caution',
      priority: 'medium',
      message: 'Moderate meal overlap detected',
      action: 'Account for active carbs before next meal or insulin dose',
      details: `${totalMOB.toFixed(0)}g MOB. Adjust insulin calculations accordingly.`
    });
  } else if (severity.level === 'low') {
    recommendations.push({
      type: 'info',
      priority: 'low',
      message: 'Minimal meal overlap detected',
      action: 'Safe to eat, but consider active carbs in insulin calculation',
      details: 'Small amount of carbs still absorbing. Adjust if needed.'
    });
  }

  // Add specific warnings for peak overlaps
  if (peakOverlap >= 2) {
    recommendations.push({
      type: 'warning',
      priority: 'urgent',
      message: '⚠️ Multiple meals at peak absorption',
      action: 'This is when stacking is most dangerous',
      details: `${peakOverlap} meals are currently at or near their peak effect. Combined BG impact is additive.`
    });
  }

  // Add timing-specific recommendations
  const mealsNearingPeak = contributions.filter(c =>
    c.hoursSinceMeal < c.profile.peak &&
    c.hoursSinceMeal > c.profile.onset
  );

  if (mealsNearingPeak.length > 0) {
    recommendations.push({
      type: 'info',
      priority: 'medium',
      message: `${mealsNearingPeak.length} meal(s) still rising toward peak`,
      action: 'BG will continue rising for next 30-90 minutes',
      details: 'Peak absorption has not yet occurred. Wait before correcting BG.'
    });
  }

  // Mixed meal warnings
  if (fastMealMOB > 15 && slowMealMOB > 15) {
    recommendations.push({
      type: 'caution',
      priority: 'medium',
      message: 'Mixed fast + slow meal absorption',
      action: 'Complex insulin timing - consider dual-wave or extended bolus',
      details: `Fast carbs (${fastMealMOB.toFixed(0)}g) will spike BG first, then slow carbs (${slowMealMOB.toFixed(0)}g) will sustain it.`
    });
  }

  return recommendations;
}

/**
 * Generate stacking alerts
 *
 * @private
 */
function generateStackingAlerts(severity, totalMOB, peakOverlap) {
  const alerts = [];

  if (severity.level === 'critical') {
    alerts.push({
      level: 'critical',
      title: 'CRITICAL: Severe Meal Stacking',
      message: 'Multiple overlapping meal peaks. Wait before eating.',
      icon: '🚨'
    });
  } else if (severity.level === 'severe') {
    alerts.push({
      level: 'error',
      title: 'WARNING: High Stacking Risk',
      message: 'Wait 1-2 hours before next meal. Monitor BG closely.',
      icon: '⚠️'
    });
  } else if (severity.level === 'high') {
    alerts.push({
      level: 'warning',
      title: 'Caution: Meal Overlap',
      message: 'Consider active carbs before next meal.',
      icon: '⚡'
    });
  }

  if (totalMOB > 80) {
    alerts.push({
      level: 'warning',
      title: 'Very High MOB',
      message: `${totalMOB.toFixed(0)}g carbs still absorbing`,
      icon: '🍽️'
    });
  }

  if (peakOverlap >= 3) {
    alerts.push({
      level: 'critical',
      title: 'Multiple Peaks Overlapping',
      message: 'Extreme hyperglycemia risk. Monitor closely.',
      icon: '🔴'
    });
  }

  return alerts;
}

/**
 * ============================================================================
 * BLOOD GLUCOSE RESPONSE WITH MEAL EFFECTS
 * ============================================================================
 */

/**
 * Calculate blood glucose response over time with meal absorption
 *
 * Simulates BG trajectory considering:
 * - Meal absorption from all active meals
 * - Carb-to-BG conversion factors
 * - Peak timing and overlap
 *
 * @param {number} baselineBG - Starting blood glucose without meal effects
 * @param {Array} meals - All meals (past and future)
 * @param {number} carbToBGFactor - BG impact per gram (default: 4.0)
 * @param {number} timeWindowMinutes - Simulation duration (default: 720 = 12 hours)
 * @param {number} intervalMinutes - Time step (default: 5)
 * @returns {Array} Time-series BG predictions
 */
export function calculateBGResponseWithMeals(
  baselineBG,
  meals,
  carbToBGFactor = 4.0,
  timeWindowMinutes = 720,
  intervalMinutes = 5
) {
  const timeline = [];

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hours = t / 60;

    // Calculate meal effect at this timepoint
    let totalBGElevation = 0;
    let totalMOB = 0;
    let totalActivity = 0;

    meals.forEach(meal => {
      const profile = getAbsorptionProfile(meal.absorptionType);
      if (!profile) return;

      const mealTime = meal.timeMinutes || 0;
      const minutesSinceMeal = t - mealTime;
      const hoursSinceMeal = minutesSinceMeal / 60;

      if (hoursSinceMeal >= 0 && hoursSinceMeal <= profile.duration_hours) {
        const activity = calculateMealActivity(hoursSinceMeal, profile);
        const mob = calculateMOB(hoursSinceMeal, meal.carbEquiv, profile);
        const absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
        const absorbedCarbs = meal.carbEquiv * absorbedFraction;
        const bgImpact = absorbedCarbs * carbToBGFactor;

        totalActivity += activity;
        totalMOB += mob;
        totalBGElevation += bgImpact;
      }
    });

    const currentBG = baselineBG + totalBGElevation;

    timeline.push({
      time: t,
      timeLabel: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      hours: Math.round(hours * 100) / 100,
      baseline: baselineBG,
      bgElevation: Math.round(totalBGElevation * 10) / 10,
      bg: Math.round(currentBG * 10) / 10,
      totalMOB: Math.round(totalMOB * 100) / 100,
      totalActivity: Math.round(totalActivity * 10) / 10,
      isHigh: currentBG > 180,
      isVeryHigh: currentBG > 250
    });
  }

  return timeline;
}

/**
 * ============================================================================
 * HYPERGLYCEMIA RISK ASSESSMENT
 * ============================================================================
 */

/**
 * Analyze hyperglycemia risk from current meal regimen
 *
 * @param {number} currentBG - Current blood glucose
 * @param {Array} meals - Active meals
 * @param {number} carbToBGFactor - BG impact per gram (default: 4.0)
 * @returns {object} Comprehensive risk assessment
 */
export function analyzeHyperglycemiaRisk(
  currentBG,
  meals,
  carbToBGFactor = 4.0
) {
  // Calculate BG trajectory for next 8 hours
  const mealsWithTime = meals.map(m => ({
    ...m,
    timeMinutes: -m.hoursSinceMeal * 60
  }));

  const trajectory = calculateBGResponseWithMeals(
    currentBG,
    mealsWithTime,
    carbToBGFactor,
    480, // 8 hours
    5
  );

  const highestBG = Math.max(...trajectory.map(t => t.bg));
  const highestBGPoint = trajectory.find(t => t.bg === highestBG);

  const highEvents = trajectory.filter(t => t.isHigh).length;
  const veryHighEvents = trajectory.filter(t => t.isVeryHigh).length;

  // Calculate risk level
  let riskLevel;
  let riskScore = 0;

  if (highestBG > 300) {
    riskLevel = 'critical';
    riskScore = 100;
  } else if (highestBG > 250) {
    riskLevel = 'high';
    riskScore = 70 + ((highestBG - 250) / 2);
  } else if (highestBG > 180) {
    riskLevel = 'moderate';
    riskScore = 40 + ((highestBG - 180) * 0.5);
  } else if (highestBG > 140) {
    riskLevel = 'low';
    riskScore = 20 + ((highestBG - 140) * 0.5);
  } else {
    riskLevel = 'minimal';
    riskScore = 0;
  }

  return {
    risk_level: riskLevel,
    risk_score: Math.round(riskScore),
    current_bg: currentBG,
    predicted_highest_bg: Math.round(highestBG * 10) / 10,
    time_to_highest: highestBGPoint?.timeLabel,
    hours_to_highest: highestBGPoint?.hours,
    high_event_count: highEvents,
    high_minutes: highEvents * 5,
    very_high_event_count: veryHighEvents,
    very_high_minutes: veryHighEvents * 5,
    recommendations: generateHyperglycemiaRecommendations(
      riskLevel,
      highestBG,
      highEvents,
      veryHighEvents
    )
  };
}

/**
 * Generate hyperglycemia recommendations
 *
 * @private
 */
function generateHyperglycemiaRecommendations(
  riskLevel,
  highestBG,
  highEvents,
  veryHighEvents
) {
  const recommendations = [];

  if (riskLevel === 'critical') {
    recommendations.push({
      type: 'critical',
      priority: 'urgent',
      message: '🚨 CRITICAL HYPERGLYCEMIA RISK',
      action: 'Give correction insulin immediately. Do NOT eat more.',
      details: `Predicted peak of ${highestBG.toFixed(0)} mg/dL. This is dangerous.`
    });
  } else if (riskLevel === 'high') {
    recommendations.push({
      type: 'warning',
      priority: 'high',
      message: '⚠️ High hyperglycemia risk',
      action: 'Consider correction insulin now. Monitor BG every 30-60 minutes.',
      details: `Predicted peak of ${highestBG.toFixed(0)} mg/dL in next few hours.`
    });

    if (highEvents > 12) { // >1 hour above 180
      recommendations.push({
        type: 'caution',
        priority: 'high',
        message: 'Prolonged hyperglycemia expected',
        action: 'May need multiple correction doses',
        details: `Predicted ${Math.round(highEvents * 5 / 60)} hours above 180 mg/dL`
      });
    }
  } else if (riskLevel === 'moderate') {
    recommendations.push({
      type: 'caution',
      priority: 'medium',
      message: 'Moderate hyperglycemia risk',
      action: 'Monitor BG in 1-2 hours. Be ready to correct.',
      details: `May rise to ${highestBG.toFixed(0)} mg/dL. Prepare correction insulin.`
    });
  }

  if (veryHighEvents > 0) {
    recommendations.push({
      type: 'critical',
      priority: 'urgent',
      message: '🚨 Severe hyperglycemia predicted',
      action: 'Immediate intervention required',
      details: `Predicted ${Math.round(veryHighEvents * 5 / 60)} hours above 250 mg/dL. Risk of DKA if prolonged.`
    });
  }

  return recommendations;
}

/**
 * ============================================================================
 * SAFETY CHECKS
 * ============================================================================
 */

/**
 * Check if it's safe to eat another meal
 *
 * @param {Array} activeMeals - Current active meals
 * @param {number} proposedCarbEquiv - New meal carb equivalents
 * @param {string} proposedAbsorptionType - Type of new meal
 * @param {number} currentBG - Current blood glucose
 * @param {number} carbToBGFactor - BG impact per gram (default: 4.0)
 * @returns {object} Safety check result
 */
export function checkMealSafety(
  activeMeals,
  proposedCarbEquiv,
  proposedAbsorptionType,
  currentBG,
  carbToBGFactor = 4.0
) {
  // Analyze current stacking
  const currentStacking = analyzeMealStackingRisk(activeMeals, carbToBGFactor);

  // Simulate adding proposed meal
  const profile = getAbsorptionProfile(proposedAbsorptionType);
  if (!profile) {
    return {
      is_safe: false,
      reason: 'Unknown absorption type',
      recommendations: []
    };
  }

  const newMeals = [
    ...activeMeals,
    {
      carbEquiv: proposedCarbEquiv,
      hoursSinceMeal: 0,
      absorptionType: proposedAbsorptionType
    }
  ];

  const newStacking = analyzeMealStackingRisk(newMeals, carbToBGFactor);

  // Calculate predicted BG impact
  const totalNewMOB = newStacking.totalMOB;
  const predictedBGRise = totalNewMOB * carbToBGFactor;
  const predictedBG = currentBG + predictedBGRise;

  // Safety checks
  const checks = {
    stacking_severity: newStacking.severity.level,
    current_bg_safe: currentBG <= 200,
    predicted_bg_safe: predictedBG <= 250,
    mob_not_excessive: totalNewMOB <= 100,
    no_severe_stacking: newStacking.severity.level !== 'critical' && newStacking.severity.level !== 'severe'
  };

  const is_safe = Object.values(checks).every(check => check === true);

  let reason = '';
  const recommendations = [];

  if (!checks.current_bg_safe) {
    reason = `Current BG too high (${currentBG} mg/dL). Risk of severe hyperglycemia.`;
    recommendations.push({
      type: 'warning',
      message: 'Correct high blood sugar before eating',
      action: 'Give correction insulin, wait 1-2 hours, recheck BG'
    });
  }

  if (!checks.predicted_bg_safe) {
    reason = `Predicted BG too high (${predictedBG.toFixed(0)} mg/dL with ${totalNewMOB.toFixed(0)}g MOB)`;
    recommendations.push({
      type: 'warning',
      message: 'This meal will likely cause severe hyperglycemia',
      action: `Reduce portion by 50% or wait 2-3 hours`
    });
  }

  if (!checks.no_severe_stacking) {
    reason = `${newStacking.severity.level} meal stacking risk`;
    recommendations.push({
      type: 'critical',
      message: 'Do not eat - dangerous stacking detected',
      action: 'Wait for active carbs to clear (2-4 hours)'
    });
  }

  return {
    is_safe: is_safe,
    reason: reason || 'Safe to eat',
    checks: checks,
    predicted_bg: Math.round(predictedBG * 10) / 10,
    total_mob_after_meal: Math.round(totalNewMOB * 100) / 100,
    stacking_level: newStacking.severity.level,
    recommendations: is_safe ? [
      {
        type: 'success',
        message: 'Meal appears safe',
        action: 'Monitor BG 1-2 hours after eating'
      }
    ] : recommendations
  };
}

/**
 * ============================================================================
 * EXPORTS
 * ============================================================================
 */

// Export all functions
export default {
  // Core stacking analysis
  analyzeMealStackingRisk,

  // BG response
  calculateBGResponseWithMeals,

  // Risk assessment
  analyzeHyperglycemiaRisk,

  // Safety checks
  checkMealSafety,

  // Constants
  MEAL_STACKING_THRESHOLDS
};



