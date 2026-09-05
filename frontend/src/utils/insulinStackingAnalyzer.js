/**
 * ============================================================================
 * INSULIN STACKING ANALYZER WITH COUNTER-REGULATION
 * ============================================================================
 * 
 * Implements advanced stacking detection, counter-regulatory hormone modeling,
 * and hypoglycemia risk assessment for Type 1 Diabetes management.
 * 
 * Key Features:
 * - Multi-dose stacking analysis with peak overlap detection
 * - Counter-regulatory hormone responses (glucagon, epinephrine, cortisol/GH)
 * - T1D duration effects on counter-regulation effectiveness
 * - Hypoglycemia risk assessment with severity levels
 * - Safety recommendations and alerts
 * 
 * References:
 * - Cryer PE. Hypoglycemia-associated autonomic failure in diabetes. 2013
 * - S3 Guidelines for Insulin Therapy
 * - Enhanced IOB Model with Counter-Regulation
 * 
 * Author: Enhanced IOB System
 * Version: 3.0 (Refactored)
 * ============================================================================
 */

import {
  calculateInsulinActivity,
  calculateIOB,
  getInsulinProfile,
  calculateInsulinBGImpact
} from './insulinPharmacodynamics.js';

/**
 * ============================================================================
 * STACKING THRESHOLDS (Moved from netEffectCalculationService)
 * ============================================================================
 */

export const INSULIN_STACKING_THRESHOLDS = {
  CRITICAL_IOB: 20,
  HIGH_IOB: 15,
  MODERATE_IOB: 10,
  LOW_IOB: 5,
  CRITICAL_RAPID_IOB: 8,
  HIGH_RAPID_IOB: 5,
  MODERATE_RAPID_IOB: 3,
  PEAK_OVERLAP: {
    CRITICAL: 3,
    HIGH: 2,
    MODERATE: 1
  }
};

/**
 * ============================================================================
 * COUNTER-REGULATORY HORMONE SYSTEM
 * ============================================================================
 *
 * Models the body's natural defense against hypoglycemia through hormones:
 * 1. Glucagon (α-cells) - First line defense at ~70 mg/dL
 * 2. Epinephrine (adrenal) - Second line at ~60 mg/dL
 * 3. Cortisol/GH (adrenal/pituitary) - Sustained response at ~55 mg/dL
 *
 * CRITICAL: Counter-regulation becomes impaired with T1D duration due to
 * hypoglycemia unawareness and autonomic failure.
 */

export const COUNTER_REGULATION = {
  // Threshold BG levels where each hormone activates (mg/dL)
  glucagon_threshold: 70,
  epinephrine_threshold: 60,
  cortisol_threshold: 55,

  /**
   * Calculate counter-regulation effectiveness based on T1D duration
   *
   * Research shows progressive impairment with disease duration:
   * - <2 years: 100% effectiveness (new diagnosis)
   * - 2-5 years: 85% effectiveness (recent)
   * - 5-10 years: 65% effectiveness (moderate)
   * - 10-15 years: 45% effectiveness (long-standing)
   * - >15 years: 25% effectiveness (severe impairment)
   *
   * @param {number} years - Years with T1D
   * @returns {number} Effectiveness multiplier (0.25-1.0)
   */
  getEffectiveness: (years) => {
    if (years < 2) return 1.0;
    if (years < 5) return 0.85;
    if (years < 10) return 0.65;
    if (years < 15) return 0.45;
    return 0.25;
  },

  /**
   * Calculate glucagon response (first-line defense)
   *
   * Glucagon rapidly mobilizes hepatic glucose stores.
   * Response is proportional to BG deficit below 70 mg/dL.
   *
   * @param {number} bg - Current blood glucose
   * @param {number} effectiveness - T1D-adjusted effectiveness
   * @returns {number} BG increase (mg/dL)
   */
  glucagonResponse: (bg, effectiveness) => {
    if (bg >= 70) return 0;

    const deficit = 70 - bg;
    const baseResponse = Math.min(deficit * 0.8, 20); // Max 20 mg/dL

    return baseResponse * effectiveness;
  },

  /**
   * Calculate epinephrine response (second-line defense)
   *
   * Epinephrine provides stronger, sustained glucose mobilization
   * through hepatic glycogenolysis and gluconeogenesis.
   *
   * @param {number} bg - Current blood glucose
   * @param {number} effectiveness - T1D-adjusted effectiveness
   * @returns {number} BG increase (mg/dL)
   */
  epinephrineResponse: (bg, effectiveness) => {
    if (bg >= 60) return 0;

    const deficit = 60 - bg;
    const baseResponse = Math.min(deficit * 1.2, 30); // Max 30 mg/dL

    return baseResponse * effectiveness;
  },

  /**
   * Calculate cortisol/growth hormone response (sustained defense)
   *
   * Slower but sustained response, peaks 2-4 hours after hypoglycemia.
   * Provides prolonged glucose elevation through gluconeogenesis.
   *
   * @param {number} bg - Current blood glucose
   * @param {number} effectiveness - T1D-adjusted effectiveness
   * @returns {number} BG increase (mg/dL)
   */
  cortisolResponse: (bg, effectiveness) => {
    if (bg >= 55) return 0;

    const deficit = 55 - bg;
    const baseResponse = Math.min(deficit * 0.6, 15); // Max 15 mg/dL

    // Delayed and sustained effect (50% immediate, rest over time)
    return baseResponse * effectiveness * 0.5;
  },

  /**
   * Calculate total counter-regulatory response
   *
   * @param {number} bg - Current blood glucose without counter-reg
   * @param {number} t1dDuration - Years with T1D
   * @returns {object} Complete counter-reg analysis
   */
  calculateTotalResponse: (bg, t1dDuration) => {
    const effectiveness = COUNTER_REGULATION.getEffectiveness(t1dDuration);

    const glucagon = COUNTER_REGULATION.glucagonResponse(bg, effectiveness);
    const epinephrine = COUNTER_REGULATION.epinephrineResponse(bg, effectiveness);
    const cortisol = COUNTER_REGULATION.cortisolResponse(bg, effectiveness);

    const totalEffect = glucagon + epinephrine + cortisol;
    const finalBG = bg + totalEffect;

    const activeHormones = [];
    if (glucagon > 0) activeHormones.push({ type: 'Glucagon', effect: glucagon });
    if (epinephrine > 0) activeHormones.push({ type: 'Epinephrine', effect: epinephrine });
    if (cortisol > 0) activeHormones.push({ type: 'Cortisol/GH', effect: cortisol });

    return {
      bg_without_counter_reg: bg,
      bg_with_counter_reg: finalBG,
      total_counter_reg_effect: totalEffect,
      effectiveness_percent: Math.round(effectiveness * 100),
      active_hormones: activeHormones,
      is_hypoglycemic: bg < 70,
      is_severe_hypo: bg < 55,
      t1d_duration: t1dDuration
    };
  }
};

/**
 * ============================================================================
 * INSULIN STACKING ANALYSIS (Enhanced with thresholds)
 * ============================================================================
 */

/**
 * Analyze insulin stacking risk from multiple doses
 *
 * Stacking occurs when multiple insulin doses overlap, creating additive
 * effects that can cause severe, prolonged hypoglycemia. This is the #1
 * cause of dangerous lows in T1D.
 *
 * @param {Array} doses - Array of dose objects with {dose, hoursSinceDose, insulinType}
 * @param {number} correctionFactor - BG impact per unit (default: 50)
 * @returns {object} Complete stacking analysis
 */
export function analyzeStackingRisk(doses, correctionFactor = 50) {
  if (!doses || doses.length === 0) {
    return {
      isStacking: false,
      severity: { level: 'none', score: 0, factors: [] },
      peakOverlap: 0,
      rapidActingIOB: 0,
      contributions: [],
      recommendations: [],
      alerts: []
    };
  }

  const contributions = [];
  let totalIOB = 0;
  let totalActivity = 0;
  let rapidActingIOB = 0;
  let longActingIOB = 0;

  // Analyze each dose
  doses.forEach(dose => {
    const profile = getInsulinProfile(dose.insulinType);
    if (!profile) return;

    const activity = calculateInsulinActivity(dose.hoursSinceDose, profile);
    const iob = calculateIOB(dose.hoursSinceDose, dose.dose, profile);
    const activeUnits = (dose.dose * activity) / 100;
    const bgImpact = activeUnits * correctionFactor;

    totalIOB += iob;
    totalActivity += activity;

    if (profile.type === 'rapid_acting' || profile.type === 'ultra_rapid') {
      rapidActingIOB += iob;
    } else if (profile.type === 'long_acting' || profile.type === 'ultra_long') {
      longActingIOB += iob;
    }

    contributions.push({
      insulinType: dose.insulinType,
      dose: dose.dose,
      hoursSinceDose: Math.round(dose.hoursSinceDose * 100) / 100,
      activity: Math.round(activity * 10) / 10,
      activeUnits: Math.round(activeUnits * 100) / 100,
      iob: Math.round(iob * 100) / 100,
      bgImpact: Math.round(bgImpact * 10) / 10,
      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        type: profile.type,
        is_peakless: profile.is_peakless
      }
    });
  });

  // Detect peak overlap - multiple doses at or near peak simultaneously
  const peakOverlap = contributions.filter(c => {
    const profile = c.profile;
    if (profile.is_peakless) return false;

    const peakStart = profile.peak * 0.5;
    const peakEnd = profile.peak * 1.5;
    return c.hoursSinceDose >= peakStart && c.hoursSinceDose <= peakEnd;
  }).length;

  // Calculate stacking severity
  const severity = calculateStackingSeverity(
    contributions.length,
    totalIOB,
    rapidActingIOB,
    peakOverlap
  );

  // Generate recommendations
  const recommendations = generateStackingRecommendations(
    severity,
    totalIOB,
    rapidActingIOB,
    peakOverlap,
    contributions
  );

  // Generate alerts
  const alerts = generateStackingAlerts(severity, totalIOB, peakOverlap);

  return {
    isStacking: contributions.length > 1,
    severity: severity,
    peakOverlap: peakOverlap,
    rapidActingIOB: Math.round(rapidActingIOB * 100) / 100,
    longActingIOB: Math.round(longActingIOB * 100) / 100,
    totalIOB: Math.round(totalIOB * 100) / 100,
    totalActivity: Math.round(totalActivity * 10) / 10,
    contributions: contributions,
    recommendations: recommendations,
    alerts: alerts
  };
}

/**
 * Calculate stacking severity level and score
 * Uses thresholds from INSULIN_STACKING_THRESHOLDS
 *
 * @private
 */
function calculateStackingSeverity(doseCount, totalIOB, rapidActingIOB, peakOverlap) {
  let score = 0;
  const factors = [];
  const thresholds = INSULIN_STACKING_THRESHOLDS;

  // Factor 1: Number of active doses
  if (doseCount >= 4) {
    score += 30;
    factors.push(`${doseCount} simultaneous doses`);
  } else if (doseCount === 3) {
    score += 20;
    factors.push(`${doseCount} simultaneous doses`);
  } else if (doseCount === 2) {
    score += 10;
    factors.push(`${doseCount} simultaneous doses`);
  }

  // Factor 2: Total IOB
  if (totalIOB > thresholds.CRITICAL_IOB) {
    score += 40;
    factors.push(`Very high IOB (${totalIOB.toFixed(1)}u)`);
  } else if (totalIOB > thresholds.HIGH_IOB) {
    score += 30;
    factors.push(`High IOB (${totalIOB.toFixed(1)}u)`);
  } else if (totalIOB > thresholds.MODERATE_IOB) {
    score += 20;
    factors.push(`Elevated IOB (${totalIOB.toFixed(1)}u)`);
  } else if (totalIOB > thresholds.LOW_IOB) {
    score += 10;
    factors.push(`Moderate IOB (${totalIOB.toFixed(1)}u)`);
  }

  // Factor 3: Rapid-acting IOB (more dangerous for stacking)
  if (rapidActingIOB > thresholds.CRITICAL_RAPID_IOB) {
    score += 30;
    factors.push(`High rapid-acting IOB (${rapidActingIOB.toFixed(1)}u)`);
  } else if (rapidActingIOB > thresholds.HIGH_RAPID_IOB) {
    score += 20;
    factors.push(`Elevated rapid-acting IOB (${rapidActingIOB.toFixed(1)}u)`);
  } else if (rapidActingIOB > thresholds.MODERATE_RAPID_IOB) {
    score += 10;
    factors.push(`Active rapid-acting insulin (${rapidActingIOB.toFixed(1)}u)`);
  }

  // Factor 4: Peak overlap (most dangerous)
  if (peakOverlap >= thresholds.PEAK_OVERLAP.CRITICAL) {
    score += 40;
    factors.push(`${peakOverlap} doses at peak simultaneously`);
  } else if (peakOverlap >= thresholds.PEAK_OVERLAP.HIGH) {
    score += 30;
    factors.push(`${peakOverlap} doses at peak simultaneously`);
  } else if (peakOverlap === thresholds.PEAK_OVERLAP.MODERATE) {
    score += 10;
    factors.push(`1 dose at peak`);
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
function generateStackingRecommendations(severity, totalIOB, rapidActingIOB, peakOverlap, contributions) {
  const recommendations = [];

  if (severity.level === 'critical' || severity.level === 'severe') {
    recommendations.push({
      type: 'critical',
      priority: 'urgent',
      message: '⚠️ CRITICAL STACKING RISK',
      action: 'Do NOT dose additional insulin. Wait at least 2-3 hours.',
      details: 'Multiple overlapping peaks detected. Risk of severe, prolonged hypoglycemia.'
    });

    recommendations.push({
      type: 'safety',
      priority: 'urgent',
      message: 'Monitor blood glucose every 30-60 minutes',
      action: 'Have fast-acting carbs readily available',
      details: 'Be prepared to treat hypoglycemia. Consider setting CGM low alert to 80 mg/dL.'
    });
  } else if (severity.level === 'high') {
    recommendations.push({
      type: 'warning',
      priority: 'high',
      message: '⚠️ High stacking risk detected',
      action: 'Wait 1-2 hours before additional dosing, or reduce dose by 30-50%',
      details: `${totalIOB.toFixed(1)}u insulin still active. Consider current IOB in dose calculation.`
    });

    if (rapidActingIOB > 5) {
      recommendations.push({
        type: 'caution',
        priority: 'high',
        message: 'Significant rapid-acting insulin still working',
        action: 'Monitor BG closely for next 2-3 hours',
        details: `${rapidActingIOB.toFixed(1)}u rapid-acting insulin on board`
      });
    }
  } else if (severity.level === 'moderate') {
    recommendations.push({
      type: 'caution',
      priority: 'medium',
      message: 'Moderate insulin overlap',
      action: 'Account for active insulin before dosing',
      details: `${totalIOB.toFixed(1)}u IOB. Reduce correction doses by active insulin amount.`
    });
  } else if (severity.level === 'low') {
    recommendations.push({
      type: 'info',
      priority: 'low',
      message: 'Minimal overlap detected',
      action: 'Safe to dose, but consider active insulin',
      details: 'Small amount of insulin still active. Adjust if needed.'
    });
  }

  // Add specific warnings for peak overlaps
  if (peakOverlap >= 2) {
    recommendations.push({
      type: 'warning',
      priority: 'urgent',
      message: '⚠️ Multiple doses at peak activity',
      action: 'This is when stacking is most dangerous',
      details: `${peakOverlap} doses are currently at or near their peak effect. Combined impact is multiplicative, not additive.`
    });
  }

  // Add timing-specific recommendations
  const dosesNearingPeak = contributions.filter(c =>
    !c.profile.is_peakless &&
    c.hoursSinceDose < c.profile.peak &&
    c.hoursSinceDose > c.profile.onset
  );

  if (dosesNearingPeak.length > 0) {
    recommendations.push({
      type: 'info',
      priority: 'medium',
      message: `${dosesNearingPeak.length} dose(s) still rising toward peak`,
      action: 'BG will continue dropping for next 1-2 hours',
      details: 'Peak effects have not yet occurred. Do not over-correct current BG.'
    });
  }

  return recommendations;
}

/**
 * Generate stacking alerts
 *
 * @private
 */
function generateStackingAlerts(severity, totalIOB, peakOverlap) {
  const alerts = [];

  if (severity.level === 'critical') {
    alerts.push({
      level: 'critical',
      title: 'CRITICAL: Severe Insulin Stacking',
      message: 'Multiple overlapping insulin peaks. Do NOT dose more insulin.',
      icon: '🚨'
    });
  } else if (severity.level === 'severe') {
    alerts.push({
      level: 'error',
      title: 'WARNING: High Stacking Risk',
      message: 'Wait before dosing additional insulin. Monitor BG closely.',
      icon: '⚠️'
    });
  } else if (severity.level === 'high') {
    alerts.push({
      level: 'warning',
      title: 'Caution: Insulin Overlap',
      message: 'Consider active insulin before dosing.',
      icon: '⚡'
    });
  }

  if (totalIOB > 15) {
    alerts.push({
      level: 'warning',
      title: 'Very High IOB',
      message: `${totalIOB.toFixed(1)}u insulin still active`,
      icon: '💉'
    });
  }

  if (peakOverlap >= 3) {
    alerts.push({
      level: 'critical',
      title: 'Multiple Peaks Overlapping',
      message: 'Extreme hypoglycemia risk. Have glucose ready.',
      icon: '🔴'
    });
  }

  return alerts;
}
/**
 * ============================================================================
 * INSULIN STACKING ANALYZER - PART 2
 * ============================================================================
 * Continuation: Blood Glucose Response, Risk Assessment, Safety Checks
 */

/**
 * Calculate cumulative blood glucose reduction from multiple insulin doses
 *
 * T1D MODEL - Cumulative BG Reduction:
 * - Each dose contributes based on how much has been ABSORBED (not current activity)
 * - Total reduction = sum of all absorbed insulin × correction factor
 * - Pending reduction = sum of all IOB × correction factor
 *
 * This mirrors calculateStackedMealEffect but for insulin:
 * - Meal: absorbed carbs → cumulative BG elevation
 * - Insulin: absorbed insulin → cumulative BG reduction
 *
 * @param {Array} doses - Array of dose objects {dose, hoursSinceDose, insulinType}
 * @param {number} correctionFactor - BG impact per unit (default: 50)
 * @returns {object} Complete insulin stacking analysis with BG impact
 */
export function calculateStackedInsulinBGImpact(doses, correctionFactor = 50) {
  let totalBGReduction = 0;        // CUMULATIVE BG drop (from absorbed insulin)
  let totalPendingReduction = 0;   // FUTURE BG drop (from IOB)
  let totalAbsorbedInsulin = 0;    // Total insulin that has acted
  let totalActiveInsulin = 0;      // Currently working insulin (instantaneous)
  let totalIOB = 0;                // Total remaining insulin
  let totalActivity = 0;           // Sum of activity percentages
  let totalInitialDose = 0;        // Sum of all initial doses
  const insulinContributions = [];

  doses.forEach((dose) => {
    const impact = calculateInsulinBGImpact(
      dose.hoursSinceDose,
      dose.dose,
      dose.insulinType,
      correctionFactor
    );

    // Include even if not currently "active" - completed doses still contribute to cumulative reduction
    if (dose.hoursSinceDose < 0) return; // Skip future doses

    totalInitialDose += dose.dose;

    // Cumulative values (T1D model)
    totalBGReduction += impact.bgReduction;
    totalPendingReduction += impact.pendingReduction;
    totalAbsorbedInsulin += impact.absorbedInsulin || (dose.dose - impact.iob);

    // Instantaneous values
    totalActiveInsulin += impact.activeInsulin;
    totalIOB += impact.iob;
    totalActivity += impact.activity;

    insulinContributions.push({
      insulinType: dose.insulinType,
      dose: dose.dose,
      hoursSinceDose: impact.hoursSinceDose,

      // T1D Model values
      absorbedInsulin: impact.absorbedInsulin || (dose.dose - impact.iob),
      absorbedPercent: impact.absorbedPercent || Math.round(((dose.dose - impact.iob) / dose.dose) * 100),
      bgReduction: impact.bgReduction,           // Cumulative reduction from this dose
      pendingReduction: impact.pendingReduction, // Pending from this dose

      // Instantaneous values
      activity: impact.activity,
      activeInsulin: impact.activeInsulin,
      iob: impact.iob,

      // Profile info
      profile: impact.profile
    });
  });

  return {
    // T1D Model outputs
    totalBGReduction: Math.round(totalBGReduction * 10) / 10,           // Current cumulative drop
    totalPendingReduction: Math.round(totalPendingReduction * 10) / 10, // Future drop from IOB
    totalExpectedReduction: Math.round((totalBGReduction + totalPendingReduction) * 10) / 10,

    // Insulin amounts
    totalAbsorbedInsulin: Math.round(totalAbsorbedInsulin * 100) / 100,
    totalActiveInsulin: Math.round(totalActiveInsulin * 100) / 100,
    totalIOB: Math.round(totalIOB * 100) / 100,
    totalInitialDose: Math.round(totalInitialDose * 100) / 100,

    // Summary
    totalActivity: Math.round(totalActivity * 10) / 10,
    activeDoses: doses.filter(d => d.hoursSinceDose >= 0 && d.hoursSinceDose <= getInsulinProfile(d.insulinType)?.duration_hours).length,
    isStacking: insulinContributions.length > 1,

    // Detailed breakdown
    contributions: insulinContributions
  };
}

/**
 * ============================================================================
 * BLOOD GLUCOSE RESPONSE WITH COUNTER-REGULATION
 * ============================================================================
 */

/**
 * Calculate blood glucose response over time with counter-regulation
 *
 * Simulates BG trajectory considering:
 * - Insulin activity from all doses
 * - Counter-regulatory hormone responses
 * - T1D duration effects on counter-reg effectiveness
 *
 * @param {number} baselineBG - Starting blood glucose
 * @param {Array} doses - All insulin doses (past and future)
 * @param {number} correctionFactor - BG impact per unit
 * @param {number} t1dDuration - Years with T1D
 * @param {number} timeWindowMinutes - Simulation duration
 * @param {number} intervalMinutes - Time step
 * @returns {Array} Time-series BG predictions
 */
export function calculateBGResponseWithCounterReg(
  baselineBG,
  doses,
  correctionFactor = 50,
  t1dDuration = 5,
  timeWindowMinutes = 720,
  intervalMinutes = 5
) {
  const timeline = [];

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hours = t / 60;

    // Calculate insulin effect at this timepoint
    let totalBGReduction = 0;
    let totalIOB = 0;
    let totalActivity = 0;

    doses.forEach(dose => {
      const profile = getInsulinProfile(dose.insulinType);
      if (!profile) return;

      const doseTime = dose.timeMinutes || 0;
      const minutesSinceDose = t - doseTime;
      const hoursSinceDose = minutesSinceDose / 60;

      if (hoursSinceDose >= 0 && hoursSinceDose <= profile.duration_hours) {
        const activity = calculateInsulinActivity(hoursSinceDose, profile);
        const iob = calculateIOB(hoursSinceDose, dose.dose, profile);
        const activeUnits = (dose.dose * activity) / 100;
        const bgImpact = activeUnits * correctionFactor;

        totalActivity += activity;
        totalIOB += iob;
        totalBGReduction += bgImpact;
      }
    });

    // Calculate BG without counter-regulation
    const bgWithoutCounterReg = baselineBG - totalBGReduction;

    // Apply counter-regulation
    const counterReg = COUNTER_REGULATION.calculateTotalResponse(
      bgWithoutCounterReg,
      t1dDuration
    );

    const finalBG = counterReg.bg_with_counter_reg;

    timeline.push({
      time: t,
      timeLabel: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      hours: Math.round(hours * 100) / 100,
      baseline: baselineBG,
      bgReduction: Math.round(totalBGReduction * 10) / 10,
      bgWithoutCounterReg: Math.round(bgWithoutCounterReg * 10) / 10,
      bg: Math.round(finalBG * 10) / 10,
      counterRegEffect: Math.round(counterReg.total_counter_reg_effect * 10) / 10,
      activeCounterReg: counterReg.active_hormones,
      totalIOB: Math.round(totalIOB * 100) / 100,
      totalActivity: Math.round(totalActivity * 10) / 10,
      isHypo: bgWithoutCounterReg < 70,
      isSevereHypo: bgWithoutCounterReg < 55,
      counterRegEffectiveness: counterReg.effectiveness_percent
    });
  }

  return timeline;
}

/**
 * ============================================================================
 * HYPOGLYCEMIA RISK ASSESSMENT
 * ============================================================================
 */

/**
 * Analyze hypoglycemia risk from current insulin regimen
 *
 * @param {number} currentBG - Current blood glucose
 * @param {Array} doses - Active insulin doses
 * @param {number} correctionFactor - BG impact per unit
 * @param {number} t1dDuration - Years with T1D
 * @returns {object} Comprehensive risk assessment
 */
export function analyzeHypoglycemiaRisk(
  currentBG,
  doses,
  correctionFactor = 50,
  t1dDuration = 5
) {
  // Calculate BG trajectory for next 8 hours
  const dosesWithTime = doses.map(d => ({
    ...d,
    timeMinutes: -d.hoursSinceDose * 60
  }));

  const trajectory = calculateBGResponseWithCounterReg(
    currentBG,
    dosesWithTime,
    correctionFactor,
    t1dDuration,
    480, // 8 hours
    5
  );

  const lowestBG = Math.min(...trajectory.map(t => t.bg));
  const lowestBGWithoutCounterReg = Math.min(...trajectory.map(t => t.bgWithoutCounterReg));
  const lowestBGPoint = trajectory.find(t => t.bg === lowestBG);

  const hypoEvents = trajectory.filter(t => t.isHypo).length;
  const severeHypoEvents = trajectory.filter(t => t.isSevereHypo).length;

  // Calculate risk level
  let riskLevel;
  let riskScore = 0;

  if (lowestBG < 55) {
    riskLevel = 'critical';
    riskScore = 100;
  } else if (lowestBG < 70) {
    riskLevel = 'high';
    riskScore = 70 + ((70 - lowestBG) * 2);
  } else if (lowestBG < 80) {
    riskLevel = 'moderate';
    riskScore = 40 + ((80 - lowestBG) * 3);
  } else if (lowestBG < 100) {
    riskLevel = 'low';
    riskScore = 20 + ((100 - lowestBG) * 1);
  } else {
    riskLevel = 'minimal';
    riskScore = 0;
  }

  // Calculate counter-reg benefit
  const counterRegBenefit = lowestBGWithoutCounterReg - lowestBG;
  const counterRegEffectiveness = counterRegBenefit > 0
    ? Math.round((counterRegBenefit / lowestBGWithoutCounterReg) * 100)
    : 0;

  return {
    risk_level: riskLevel,
    risk_score: Math.round(riskScore),
    current_bg: currentBG,
    predicted_lowest_bg: Math.round(lowestBG * 10) / 10,
    predicted_lowest_bg_without_counter_reg: Math.round(lowestBGWithoutCounterReg * 10) / 10,
    time_to_lowest: lowestBGPoint?.timeLabel,
    hours_to_lowest: lowestBGPoint?.hours,
    counter_reg_benefit: Math.round(counterRegBenefit * 10) / 10,
    counter_reg_effectiveness_percent: counterRegEffectiveness,
    hypo_event_count: hypoEvents,
    hypo_minutes: hypoEvents * 5,
    severe_hypo_event_count: severeHypoEvents,
    severe_hypo_minutes: severeHypoEvents * 5,
    t1d_duration: t1dDuration,
    t1d_duration_label: getT1DDurationLabel(t1dDuration),
    recommendations: generateHypoRecommendations(
      riskLevel,
      lowestBG,
      hypoEvents,
      severeHypoEvents,
      counterRegEffectiveness,
      t1dDuration
    )
  };
}

/**
 * Get T1D duration label
 *
 * @param {number} years - Years with T1D
 * @returns {string} Duration category label
 */
export function getT1DDurationLabel(years) {
  if (years < 2) return 'New diagnosis (100% counter-reg)';
  if (years < 5) return 'Recent (85% counter-reg)';
  if (years < 10) return 'Moderate (65% counter-reg)';
  if (years < 15) return 'Long-standing (45% counter-reg)';
  return 'Very long (25% counter-reg) - Severe impairment';
}

/**
 * Generate hypoglycemia recommendations
 *
 * @private
 */
function generateHypoRecommendations(
  riskLevel,
  lowestBG,
  hypoEvents,
  severeHypoEvents,
  counterRegEffectiveness,
  t1dDuration
) {
  const recommendations = [];

  if (riskLevel === 'critical') {
    recommendations.push({
      type: 'critical',
      priority: 'urgent',
      message: '🚨 CRITICAL HYPOGLYCEMIA RISK',
      action: 'Treat immediately with 15-20g fast carbs. Do NOT dose more insulin.',
      details: `Predicted low of ${lowestBG.toFixed(0)} mg/dL. This is life-threatening.`
    });

    recommendations.push({
      type: 'safety',
      priority: 'urgent',
      message: 'Notify someone of your situation',
      action: 'Have glucagon kit ready. Consider calling for help.',
      details: 'Severe hypoglycemia can cause loss of consciousness.'
    });
  } else if (riskLevel === 'high') {
    recommendations.push({
      type: 'warning',
      priority: 'high',
      message: '⚠️ High hypoglycemia risk',
      action: 'Eat 10-15g carbs now. Monitor BG every 30-60 minutes.',
      details: `Predicted low of ${lowestBG.toFixed(0)} mg/dL in next few hours.`
    });

    if (hypoEvents > 12) { // >1 hour below 70
      recommendations.push({
        type: 'caution',
        priority: 'high',
        message: 'Prolonged hypoglycemia expected',
        action: 'May need multiple carb treatments',
        details: `Predicted ${Math.round(hypoEvents * 5 / 60)} hours below 70 mg/dL`
      });
    }
  } else if (riskLevel === 'moderate') {
    recommendations.push({
      type: 'caution',
      priority: 'medium',
      message: 'Moderate hypoglycemia risk',
      action: 'Have fast-acting carbs available. Check BG in 1-2 hours.',
      details: `May drop to ${lowestBG.toFixed(0)} mg/dL. Be prepared to treat.`
    });
  }

  // Counter-regulation warnings
  if (counterRegEffectiveness < 30 && lowestBG < 80) {
    recommendations.push({
      type: 'warning',
      priority: 'high',
      message: '⚠️ Impaired counter-regulation',
      action: 'Extra caution needed - your body cannot defend against lows effectively',
      details: `After ${t1dDuration} years with T1D, counter-regulation is only ${counterRegEffectiveness}% effective. You may not feel low blood sugar symptoms.`
    });

    recommendations.push({
      type: 'safety',
      priority: 'urgent',
      message: 'Hypoglycemia unawareness risk',
      action: 'Use CGM low alerts. Check BG frequently.',
      details: 'You may experience dangerous lows without warning symptoms.'
    });
  }

  if (severeHypoEvents > 0) {
    recommendations.push({
      type: 'critical',
      priority: 'urgent',
      message: '🚨 Severe hypoglycemia predicted',
      action: 'Immediate intervention required',
      details: `Predicted ${Math.round(severeHypoEvents * 5 / 60)} hours below 55 mg/dL. This can cause seizures or loss of consciousness.`
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
 * Check if current insulin regimen is safe for additional dosing
 *
 * @param {Array} activeDoses - Current active insulin doses
 * @param {number} proposedDose - New dose being considered
 * @param {string} proposedInsulinType - Type of new dose
 * @param {number} currentBG - Current blood glucose
 * @param {number} correctionFactor - BG impact per unit
 * @param {number} t1dDuration - Years with T1D (default: 5)
 * @returns {object} Safety check result
 */
export function checkDosingSafety(
  activeDoses,
  proposedDose,
  proposedInsulinType,
  currentBG,
  correctionFactor = 50,
  t1dDuration = 5
) {
  // Analyze current stacking
  const currentStacking = analyzeStackingRisk(activeDoses, correctionFactor);

  // Simulate adding proposed dose
  const profile = getInsulinProfile(proposedInsulinType);
  if (!profile) {
    return {
      is_safe: false,
      reason: 'Unknown insulin type',
      recommendations: []
    };
  }

  const newDoses = [
    ...activeDoses,
    {
      dose: proposedDose,
      hoursSinceDose: 0,
      insulinType: proposedInsulinType
    }
  ];

  const newStacking = analyzeStackingRisk(newDoses, correctionFactor);

  // Calculate predicted BG impact
  const totalNewIOB = newStacking.totalIOB;
  const predictedBGDrop = totalNewIOB * correctionFactor;
  const predictedBG = currentBG - predictedBGDrop;

  // Apply counter-regulation
  const counterReg = COUNTER_REGULATION.calculateTotalResponse(predictedBG, t1dDuration);
  const finalPredictedBG = counterReg.bg_with_counter_reg;

  // Safety checks
  const checks = {
    stacking_severity: newStacking.severity.level,
    current_bg_adequate: currentBG >= 100,
    predicted_bg_safe: finalPredictedBG >= 70,
    iob_not_excessive: totalNewIOB <= 20,
    no_severe_stacking: newStacking.severity.level !== 'critical' && newStacking.severity.level !== 'severe'
  };

  const is_safe = Object.values(checks).every(check => check === true);

  let reason = '';
  const recommendations = [];

  if (!checks.current_bg_adequate) {
    reason = `Current BG too low (${currentBG} mg/dL). Risk of hypoglycemia.`;
    recommendations.push({
      type: 'warning',
      message: 'Treat low blood sugar before dosing insulin',
      action: 'Consume 15g fast carbs, wait 15 minutes, recheck BG'
    });
  }

  if (!checks.predicted_bg_safe) {
    reason = `Predicted BG too low (${finalPredictedBG.toFixed(0)} mg/dL with ${totalNewIOB.toFixed(1)}u IOB)`;
    recommendations.push({
      type: 'warning',
      message: 'This dose will likely cause hypoglycemia',
      action: `Reduce dose to ${Math.max(0.5, proposedDose * 0.5).toFixed(1)}u or wait 1-2 hours`
    });
  }

  if (!checks.no_severe_stacking) {
    reason = `${newStacking.severity.level} insulin stacking risk`;
    recommendations.push({
      type: 'critical',
      message: 'Do not dose - dangerous stacking detected',
      action: 'Wait for active insulin to clear (2-4 hours)'
    });
  }

  return {
    is_safe: is_safe,
    reason: reason || 'Safe to dose',
    checks: checks,
    predicted_bg: Math.round(finalPredictedBG * 10) / 10,
    predicted_bg_without_counter_reg: Math.round(predictedBG * 10) / 10,
    total_iob_after_dose: Math.round(totalNewIOB * 100) / 100,
    stacking_level: newStacking.severity.level,
    counter_reg_effectiveness: counterReg.effectiveness_percent,
    recommendations: is_safe ? [
      {
        type: 'success',
        message: 'Dose appears safe',
        action: 'Monitor BG 2-3 hours after dosing'
      }
    ] : recommendations
  };
}

/**
 * Calculate safe correction dose considering active insulin
 *
 * @param {number} currentBG - Current blood glucose
 * @param {number} targetBG - Target blood glucose
 * @param {number} correctionFactor - BG drop per unit
 * @param {number} activeInsulin - Current IOB
 * @returns {object} Safe correction dose calculation
 */
export function calculateSafeCorrectionDose(
  currentBG,
  targetBG,
  correctionFactor,
  activeInsulin
) {
  // Calculate raw correction needed
  const bgExcess = currentBG - targetBG;
  const rawCorrection = bgExcess / correctionFactor;

  // Subtract active insulin
  const safeCorrectionDose = Math.max(0, rawCorrection - activeInsulin);

  // Apply minimum threshold
  let finalDose = safeCorrectionDose;
  if (rawCorrection > 0 && safeCorrectionDose < 0.5) {
    finalDose = 0;
  }

  // Round to 0.5u increments
  finalDose = Math.round(finalDose * 2) / 2;

  return {
    raw_correction: Math.round(rawCorrection * 100) / 100,
    active_insulin_offset: Math.round(activeInsulin * 100) / 100,
    safe_correction_dose: finalDose,
    bg_excess: Math.round(bgExcess),
    will_reach_target: safeCorrectionDose >= rawCorrection * 0.8,
    recommendation: finalDose === 0
      ? 'No correction needed - active insulin will cover excess'
      : `Dose ${finalDose}u to reach target BG`
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
  analyzeStackingRisk,
  calculateStackedInsulinBGImpact,

  // Counter-regulation
  COUNTER_REGULATION,

  // BG response
  calculateBGResponseWithCounterReg,

  // Risk assessment
  analyzeHypoglycemiaRisk,
  getT1DDurationLabel,

  // Safety checks
  checkDosingSafety,
  calculateSafeCorrectionDose,

  // Constants
  INSULIN_STACKING_THRESHOLDS
};



