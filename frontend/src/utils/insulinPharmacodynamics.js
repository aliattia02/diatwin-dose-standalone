/**
 * ============================================================================
 * INSULIN PHARMACODYNAMICS & UTILITIES
 * ============================================================================
 *
 * Comprehensive insulin management system combining:
 *
 * 1. PHARMACODYNAMICS - S3 Guidelines-based insulin pharmacokinetics using
 *    gamma distribution curves with kurtosis modeling for physiologically-
 *    accurate insulin activity and IOB (Insulin On Board) calculations.
 *
 * 2. UI UTILITIES - Insulin type management, formatting, and recommendations
 *    for user interfaces and meal planning.
 *
 * 3. MEDICATION EFFECTS - Non-insulin medication tracking (Metformin, GLP-1, etc.)
 *
 * References:
 * - S3 Guidelines for Insulin Therapy
 * - Gamma distribution for drug pharmacokinetics
 * - Clinical insulin pharmacokinetic profiles
 *
 * Author: Enhanced IOB System
 * Version: 3.0 (Merged with insulinUtils.js)
 * ============================================================================
 */

import { SHARED_CONSTANTS } from '../constants/shared_constants.js';
import TimeManager from './TimeManager.js';

/**
 * Calculate insulin activity percentage at a given time using gamma distribution
 *
 * This is the CORE calculation that determines how active insulin is at any point.
 * Uses different curve shapes (kurtosis) based on insulin type:
 * - Leptokurtic: Sharp peak, heavy tails (rapid-acting)
 * - Mesokurtic: Normal bell curve (regular/intermediate)
 * - Platykurtic: Flat plateau (long-acting)
 *
 * @param {number} hoursSinceDose - Hours elapsed since insulin administration
 * @param {object} insulinProfile - Insulin parameters from SHARED_CONSTANTS
 * @returns {number} Activity percentage (0-100)
 */
export function calculateInsulinActivity(hoursSinceDose, insulinProfile) {
  const {
    onset_hours,
    peak_hours,
    duration_hours,
    is_peakless,
    curve_type,
    type
  } = insulinProfile;

  // Outside duration window - no activity
  if (hoursSinceDose < 0 || hoursSinceDose > duration_hours) {
    return 0;
  }

  // Pre-onset phase - minimal activity
  if (hoursSinceDose < onset_hours) {
    return 0;
  }

  // ============================================================================
  // PEAKLESS INSULIN (Long-Acting: Lantus, Tresiba, Levemir)
  // ============================================================================
  if (is_peakless) {
    return calculatePeaklessActivity(
      hoursSinceDose,
      onset_hours,
      duration_hours,
      type
    );
  }

  // ============================================================================
  // PEAKED INSULIN (Rapid/Short/Intermediate: NovoRapid, Regular, NPH)
  // ============================================================================
  return calculatePeakedActivity(
    hoursSinceDose,
    onset_hours,
    peak_hours,
    duration_hours,
    curve_type
  );
}

/**
 * Calculate activity for peakless (long-acting) insulin
 * Uses sigmoid curves with extended plateau phases
 *
 * @private
 */
function calculatePeaklessActivity(hoursSinceDose, onsetHours, durationHours, type) {
  const isUltraLong = type === 'ultra_long'; // Tresiba (42h)
  const maxActivity = 75; // Peakless insulins never reach 100%

  // Phase durations as percentages of total duration
  const riseTime = durationHours * (isUltraLong ? 0.35 : 0.25);
  const plateauStart = durationHours * (isUltraLong ? 0.45 : 0.35);
  const plateauEnd = durationHours * (isUltraLong ? 0.80 : 0.75);

  // Phase 1: Rising phase (onset → plateau) - obtuse curve
  if (hoursSinceDose <= riseTime) {
    const t = hoursSinceDose / riseTime;
    const obtuseCurve = Math.pow(t, isUltraLong ? 2.5 : 2.0);
    return maxActivity * 0.6 * obtuseCurve;
  }

  // Phase 2: Transition to plateau - smooth sigmoid
  if (hoursSinceDose <= plateauStart) {
    const transitionProgress = (hoursSinceDose - riseTime) / (plateauStart - riseTime);
    const smoothTransition = 0.5 * (1 - Math.cos(transitionProgress * Math.PI));
    return maxActivity * 0.6 + (maxActivity * 0.25 * smoothTransition);
  }

  // Phase 3: Plateau phase - stable with minimal variation
  if (hoursSinceDose <= plateauEnd) {
    const plateauProgress = (hoursSinceDose - plateauStart) / (plateauEnd - plateauStart);
    const naturalVariation = 0.01 * Math.sin(plateauProgress * Math.PI);
    return maxActivity * 0.85 + (maxActivity * naturalVariation);
  }

  // Phase 4: Decline phase - exponential decay
  const declineTime = (hoursSinceDose - plateauEnd) / (durationHours - plateauEnd);
  const lightDecline = Math.exp(-0.8 * declineTime);
  return maxActivity * 0.85 * lightDecline;
}

/**
 * Calculate activity for peaked insulin using gamma distribution
 * Implements kurtosis-based curves for physiological accuracy
 *
 * @private
 */
function calculatePeakedActivity(hoursSinceDose, onsetHours, peakHours, durationHours, curveType) {
  const maxActivity = 100;

  // Determine kurtosis parameters based on curve type
  let alpha, beta, peakIntensity;

  if (curveType === 'gamma_very_steep' || curveType === 'gamma_steep') {
    // LEPTOKURTIC: Sharp, intense peak (ultra-rapid and rapid-acting)
    alpha = curveType === 'gamma_very_steep' ? 8.0 : 6.5;
    beta = 0.5;
    peakIntensity = 1.0; // ✅ FIXED: Changed from 1.2 to 1.0 - activity cannot exceed 100%
  } else if (curveType === 'gamma_moderate' || curveType === 'gamma_standard') {
    // MESOKURTIC: Normal distribution (regular insulin)
    alpha = 4.5;
    beta = 0.8;
    peakIntensity = 1.0;
  } else {
    // PLATYKURTIC-LIKE: Broader, flatter peak (intermediate-acting)
    alpha = 3.0;
    beta = 1.0;
    peakIntensity = 1.0;
  }

  // Calculate gamma distribution value
  const scale = peakHours / alpha;
  const gammaValue = Math.pow(hoursSinceDose / scale, alpha - 1) * Math.exp(-hoursSinceDose / scale);
  const peakValue = Math.pow(peakHours / scale, alpha - 1) * Math.exp(-peakHours / scale);

  if (peakValue <= 0) return 0;

  const normalizedValue = gammaValue / peakValue;

  // Rising phase (onset → peak)
  let activityValue;
  if (hoursSinceDose <= peakHours) {
    if (curveType === 'gamma_very_steep' || curveType === 'gamma_steep') {
      // Sharp rise for rapid-acting
      activityValue = maxActivity * peakIntensity * Math.pow(normalizedValue, 0.8);
    } else {
      // Standard rise
      activityValue = maxActivity * peakIntensity * normalizedValue;
    }
  } else {
    // Falling phase (peak → end) - exponential decay with tail modeling
    const timePastPeak = hoursSinceDose - peakHours;
    const remainingDuration = durationHours - peakHours;
    const tailProgress = timePastPeak / remainingDuration;

    let decayFactor;
    if (curveType === 'gamma_very_steep' || curveType === 'gamma_steep') {
      // HEAVY TAILS: Leptokurtic distribution - slower decay
      decayFactor = Math.exp(-beta * 0.6 * Math.pow(tailProgress, 0.9));
    } else {
      // LIGHT TAILS: Faster decay for regular insulin
      decayFactor = Math.exp(-beta * 1.0 * Math.pow(tailProgress, 1.1));
    }

    activityValue = maxActivity * peakIntensity * normalizedValue * decayFactor;
  }

  // ✅ CRITICAL FIX: Cap activity at 100%
  return Math.min(activityValue, maxActivity);
}
/**
 * Calculate IOB (Insulin On Board) - remaining active insulin
 *
 * Uses numerical integration (trapezoidal rule) to calculate the area under
 * the activity curve from current time to end of duration.
 *
 * IOB represents "insulin still in the system" and is CRITICAL for:
 * 1. Preventing insulin stacking
 * 2. Calculating correction doses
 * 3. Predicting future BG impact
 *
 * @param {number} hoursSinceDose - Hours elapsed since administration
 * @param {number} initialDose - Original insulin dose in units
 * @param {object} insulinProfile - Insulin parameters
 * @returns {number} Remaining active insulin in units
 */
export function calculateIOB(hoursSinceDose, initialDose, insulinProfile) {
  const { duration_hours } = insulinProfile;

  // Outside duration window - no IOB
  if (hoursSinceDose < 0 || hoursSinceDose > duration_hours) {
    return 0;
  }

  // Numerical integration using trapezoidal rule
  // We integrate from current time to end of duration
  const steps = 100; // Higher = more accurate, but slower
  const dt = (duration_hours - hoursSinceDose) / steps;

  let remainingActivity = 0;

  for (let i = 0; i <= steps; i++) {
    const time = hoursSinceDose + (i * dt);
    const activity = calculateInsulinActivity(time, insulinProfile);

    // Trapezoidal rule: weight endpoints by 0.5
    if (i === 0 || i === steps) {
      remainingActivity += activity * 0.5;
    } else {
      remainingActivity += activity;
    }
  }

  remainingActivity *= dt;

  // Calculate total area under curve (0 to duration)
  let totalActivity = 0;
  const totalDt = duration_hours / steps;

  for (let i = 0; i <= steps; i++) {
    const time = i * totalDt;
    const activity = calculateInsulinActivity(time, insulinProfile);

    if (i === 0 || i === steps) {
      totalActivity += activity * 0.5;
    } else {
      totalActivity += activity;
    }
  }

  totalActivity *= totalDt;

  // Calculate fraction remaining
  const fractionRemaining = totalActivity > 0 ? remainingActivity / totalActivity : 0;

  return initialDose * fractionRemaining;
}

/**
 * Calculate total active insulin effect for multiple doses (stacking)
 *
 * This is where insulin stacking happens - multiple overlapping doses
 * create additive effects that can lead to severe hypoglycemia.
 *
 * @param {Array} doses - Array of {dose, hoursSinceDose, insulinType}
 * @param {number} correctionFactor - mg/dL drop per unit (default: 50)
 * @returns {object} Detailed stacking analysis
 */
export function calculateStackedInsulinEffect(doses, correctionFactor = 50) {
  let totalActivity = 0;
  let totalIOB = 0;
  let totalBGImpact = 0;
  const doseContributions = [];

  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;

  doses.forEach((dose) => {
    const profile = medicationFactors[dose.insulinType];

    if (!profile) {
      console.warn(`Unknown insulin type: ${dose.insulinType}`);
      return;
    }

    const { hoursSinceDose, dose: units } = dose;

    // Check if dose is still active
    if (hoursSinceDose >= 0 && hoursSinceDose <= profile.duration_hours) {
      const activity = calculateInsulinActivity(hoursSinceDose, profile);
      const iob = calculateIOB(hoursSinceDose, units, profile);
      const activeUnits = (units * activity) / 100;
      const bgImpact = activeUnits * correctionFactor;

      totalActivity += activity;
      totalIOB += iob;
      totalBGImpact += bgImpact;

      doseContributions.push({
        insulinType: dose.insulinType,
        dose: units,
        hoursSinceDose: Math.round(hoursSinceDose * 100) / 100,
        activity: Math.round(activity * 10) / 10,
        activeUnits: Math.round(activeUnits * 100) / 100,
        iob: Math.round(iob * 100) / 100,
        bgImpact: Math.round(bgImpact * 10) / 10,
        profile: {
          onset: profile.onset_hours,
          peak: profile.peak_hours,
          duration: profile.duration_hours,
          type: profile.type
        }
      });
    }
  });

  return {
    totalIOB: Math.round(totalIOB * 100) / 100,
    totalActivity: Math.round(totalActivity * 10) / 10,
    totalBGImpact: Math.round(totalBGImpact * 10) / 10,
    activeDoses: doseContributions.length,
    contributions: doseContributions,
    isStacking: doseContributions.length > 1,
    stackingRisk: calculateStackingRisk(doseContributions)
  };
}

/**
 * Calculate stacking risk level
 *
 * @private
 * @param {Array} contributions - Dose contributions
 * @returns {string} 'low' | 'moderate' | 'high' | 'severe'
 */
function calculateStackingRisk(contributions) {
  if (contributions.length <= 1) return 'low';

  const totalIOB = contributions.reduce((sum, c) => sum + c.iob, 0);

  // Check for overlapping peaks
  const peakOverlap = contributions.filter(c =>
    c.hoursSinceDose >= (c.profile.peak * 0.5) &&
    c.hoursSinceDose <= (c.profile.peak * 1.5)
  ).length;

  if (totalIOB > 15 || peakOverlap >= 3) return 'severe';
  if (totalIOB > 10 || peakOverlap >= 2) return 'high';
  if (totalIOB > 5) return 'moderate';
  return 'low';
}

/**
 * Get insulin profile from SHARED_CONSTANTS by insulin type
 *
 * @param {string} insulinType - Insulin type identifier
 * @returns {object|null} Insulin profile or null if not found
 */
export function getInsulinProfile(insulinType) {
  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  return medicationFactors[insulinType] || null;
}

/**
 * Calculate blood glucose reduction from insulin at a specific time
 *
 * T1D MODEL (Comprehensive - mirrors meal absorption):
 * - Absorbed Insulin = insulin that has already acted = CURRENT BG reduction
 * - IOB = insulin still active = PENDING BG reduction
 * - BG reduction is CUMULATIVE (doesn't decay - only carbs raise BG back up)
 *
 * This mirrors the meal model:
 * - Absorbed carbs → current BG elevation
 * - MOB (carbs still absorbing) → pending BG elevation
 *
 * @param {number} hoursSinceDose - Hours since insulin administration
 * @param {number} initialDose - Original insulin dose (units)
 * @param {string} insulinType - Type of insulin
 * @param {number} correctionFactor - BG drop per unit (default: 50)
 * @returns {object} Comprehensive blood glucose impact breakdown
 */
export function calculateInsulinBGImpact(
  hoursSinceDose,
  initialDose,
  insulinType,
  correctionFactor = 50
) {
  const profile = getInsulinProfile(insulinType);

  if (!profile) {
    console.warn(`No profile found for insulin type: ${insulinType}`);
    return {
      bgReduction: 0,
      pendingReduction: 0,
      absorbedInsulin: 0,
      activeInsulin: 0,
      iob: 0,
      activity: 0,
      absorbedFraction: 0,
      isActive: false
    };
  }

  // Before onset - no effect yet
  if (hoursSinceDose < 0) {
    return {
      bgReduction: 0,
      pendingReduction: initialDose * correctionFactor, // All insulin is pending
      absorbedInsulin: 0,
      activeInsulin: 0,
      iob: initialDose,
      activity: 0,
      absorbedFraction: 0,
      isActive: false,
      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        type: profile.type,
        is_peakless: profile.is_peakless
      }
    };
  }

  // After duration - all insulin has acted
  if (hoursSinceDose > profile.duration_hours) {
    const totalReduction = initialDose * correctionFactor;
    return {
      bgReduction: totalReduction,        // All insulin has acted = full reduction
      pendingReduction: 0,                // No pending reduction
      absorbedInsulin: initialDose,       // All insulin absorbed
      activeInsulin: 0,                   // No currently active insulin
      iob: 0,                             // No insulin on board
      activity: 0,                        // No activity
      absorbedFraction: 1.0,              // 100% absorbed
      isActive: false,
      isComplete: true,
      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        type: profile.type,
        is_peakless: profile.is_peakless
      }
    };
  }

  // Calculate current activity percentage (0-100)
  const activity = calculateInsulinActivity(hoursSinceDose, profile);

  // Calculate IOB (remaining insulin that hasn't acted yet)
  const iob = calculateIOB(hoursSinceDose, initialDose, profile);

  // ============================================================================
  // T1D MODEL: Calculate ABSORBED insulin (what has already acted)
  // This is the KEY difference from the old model
  // Absorbed = Initial Dose - IOB (insulin that's been "used up")
  // ============================================================================
  const absorbedInsulin = initialDose - iob;
  const absorbedFraction = absorbedInsulin / initialDose;

  // Currently active insulin (what's working RIGHT NOW at this instant)
  const activeInsulin = (initialDose * activity) / 100;

  // ============================================================================
  // BG IMPACT CALCULATION (T1D Model - Cumulative)
  // ============================================================================
  // CURRENT BG Reduction = absorbed insulin × correction factor
  // This is CUMULATIVE - it doesn't decay, it stays reduced
  const bgReduction = absorbedInsulin * correctionFactor;

  // PENDING BG Reduction = IOB × correction factor
  // This is what will STILL happen as remaining insulin acts
  const pendingReduction = iob * correctionFactor;

  return {
    // T1D Model outputs
    bgReduction: Math.round(bgReduction * 10) / 10,           // CUMULATIVE reduction so far
    pendingReduction: Math.round(pendingReduction * 10) / 10, // Future reduction from IOB
    totalExpectedReduction: Math.round((bgReduction + pendingReduction) * 10) / 10,

    // Insulin amounts
    absorbedInsulin: Math.round(absorbedInsulin * 100) / 100, // Insulin that has acted
    activeInsulin: Math.round(activeInsulin * 100) / 100,     // Currently working (instantaneous)
    iob: Math.round(iob * 100) / 100,                         // Remaining to act

    // Percentages
    activity: Math.round(activity * 10) / 10,                 // Current activity %
    absorbedFraction: Math.round(absorbedFraction * 100) / 100, // Fraction absorbed (0-1)
    absorbedPercent: Math.round(absorbedFraction * 100),      // Percent absorbed

    // Timing
    hoursSinceDose: Math.round(hoursSinceDose * 100) / 100,
    isActive: true,

    // Profile info
    profile: {
      onset: profile.onset_hours,
      peak: profile.peak_hours,
      duration: profile.duration_hours,
      type: profile.type,
      is_peakless: profile.is_peakless
    }
  };
}

/**
 * Generate time-series data for visualization
 *
 * @param {Array} doses - Array of dose objects
 * @param {number} timeWindowMinutes - Total time to simulate
 * @param {number} intervalMinutes - Time step for data points
 * @param {number} correctionFactor - BG impact per unit
 * @returns {Array} Time-series data points
 */
export function generateInsulinTimeSeries(
  doses,
  timeWindowMinutes = 720,
  intervalMinutes = 5,
  correctionFactor = 50
) {
  const timePoints = [];
  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hoursSinceStart = t / 60;

    let totalActivity = 0;
    let totalIOB = 0;
    let totalBGImpact = 0;
    const activeDoses = [];

    doses.forEach((dose) => {
      const profile = medicationFactors[dose.insulinType];
      if (!profile) return;

      const doseTimeMinutes = dose.timeMinutes || 0;
      const minutesSinceDose = t - doseTimeMinutes;
      const hoursSinceDose = minutesSinceDose / 60;

      if (hoursSinceDose >= 0 && hoursSinceDose <= profile.duration_hours) {
        const activity = calculateInsulinActivity(hoursSinceDose, profile);
        const iob = calculateIOB(hoursSinceDose, dose.dose, profile);
        const activeUnits = (dose.dose * activity) / 100;
        const bgImpact = activeUnits * correctionFactor;

        totalActivity += activity;
        totalIOB += iob;
        totalBGImpact += bgImpact;

        if (iob > 0.01 || activity > 1) {
          activeDoses.push({
            name: dose.name || dose.insulinType,
            insulinType: dose.insulinType,
            activity: Math.round(activity * 10) / 10,
            iob: Math.round(iob * 100) / 100,
            activeUnits: Math.round(activeUnits * 100) / 100,
            bgImpact: Math.round(bgImpact * 10) / 10
          });
        }
      }
    });

    timePoints.push({
      time: t,
      timeLabel: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      hours: hoursSinceStart,
      totalActivity: Math.round(totalActivity * 10) / 10,
      totalIOB: Math.round(totalIOB * 100) / 100,
      totalBGImpact: Math.round(totalBGImpact * 10) / 10,
      activeDoses: activeDoses,
      isStacking: activeDoses.length > 1
    });
  }

  return timePoints;
}

/**
 * Generate BG-centric time series showing insulin's blood glucose impact
 *
 * This mirrors generateMealTimeSeries but shows BG reduction from insulin.
 * Shows baseline BG, current BG with insulin effect, and projected final BG.
 *
 * @param {Array} doses - Insulin doses with timeMinutes offset
 * @param {number} baselineBG - Starting blood glucose (default: 250)
 * @param {number} timeWindowMinutes - Simulation duration (default: 480 = 8h)
 * @param {number} intervalMinutes - Time step (default: 5)
 * @param {number} correctionFactor - BG impact per unit (default: 50)
 * @returns {Array} Time-series data points with BG values
 */
export function generateInsulinBGTimeSeries(
  doses,
  baselineBG = 250,
  timeWindowMinutes = 480,
  intervalMinutes = 5,
  correctionFactor = 50
) {
  const timePoints = [];

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hours = t / 60;

    let totalBGReduction = 0;
    let totalPendingReduction = 0;
    let totalActiveInsulin = 0;
    let totalIOB = 0;
    let totalActivity = 0;
    const activeDoses = [];

    doses.forEach((dose) => {
      const doseTime = dose.timeMinutes || 0;
      const minutesSinceDose = t - doseTime;
      const hoursSinceDose = minutesSinceDose / 60;

      const impact = calculateInsulinBGImpact(
        hoursSinceDose,
        dose.dose,
        dose.insulinType,
        correctionFactor
      );

      if (!impact.isActive) return;

      totalBGReduction += impact.bgReduction;
      totalPendingReduction += impact.pendingReduction;
      totalActiveInsulin += impact.activeInsulin;
      totalIOB += impact.iob;
      totalActivity += impact.activity;

      activeDoses.push({
        name: dose.name || dose.insulinType,
        insulinType: dose.insulinType,
        activity: impact.activity,
        activeInsulin: impact.activeInsulin,
        iob: impact.iob,
        bgReduction: impact.bgReduction,
        pendingReduction: impact.pendingReduction
      });
    });

    // Calculate blood glucose with insulin effect
    const currentBG = baselineBG - totalBGReduction;
    const projectedFinalBG = baselineBG - (totalBGReduction + totalPendingReduction);

    timePoints.push({
      time: t,
      timeLabel: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      hours: Math.round(hours * 100) / 100,

      // Baseline and current BG
      baselineBG: baselineBG,
      currentBG: Math.round(currentBG * 10) / 10,
      projectedFinalBG: Math.round(projectedFinalBG * 10) / 10,

      // BG reduction breakdown
      totalBGReduction: Math.round(totalBGReduction * 10) / 10,        // Current drop
      totalPendingReduction: Math.round(totalPendingReduction * 10) / 10, // Future drop

      // Insulin amounts
      totalActiveInsulin: Math.round(totalActiveInsulin * 100) / 100,
      totalIOB: Math.round(totalIOB * 100) / 100,
      totalActivity: Math.round(totalActivity * 10) / 10,

      // Active doses details
      activeDoses: activeDoses,
      isStacking: activeDoses.length > 1
    });
  }

  return timePoints;
}

/**
 * Calculate time to peak activity for insulin
 *
 * @param {string} insulinType - Type of insulin
 * @returns {number} Hours to peak activity
 */
export function getInsulinTimeToPeak(insulinType) {
  const profile = getInsulinProfile(insulinType);
  return profile ? profile.peak_hours : 0;
}







/**
 * Calculate duration of action for insulin
 *
 * @param {string} insulinType - Type of insulin
 * @returns {number} Total duration in hours
 */
export function getInsulinDuration(insulinType) {
  const profile = getInsulinProfile(insulinType);
  return profile ? profile.duration_hours : 0;
}

/**
 * Check if insulin is still active at a given time
 *
 * @param {number} hoursSinceDose - Hours since administration
 * @param {string} insulinType - Type of insulin
 * @returns {boolean} True if still active
 */
export function isInsulinActive(hoursSinceDose, insulinType) {
  const profile = getInsulinProfile(insulinType);
  return TimeManager.isEffectActive(hoursSinceDose, profile);
}

/**
 * ============================================================================
 * UI UTILITY FUNCTIONS (Merged from insulinUtils.js)
 * ============================================================================
 */

/**
 * Get all available insulin types for UI dropdowns
 * Filters and formats insulin types from SHARED_CONSTANTS
 *
 * @returns {Array} Sorted array of insulin type objects
 */
export function getAvailableInsulinTypes() {
  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;

  // Filter to include only insulin types (those with type containing "acting")
  return Object.entries(medicationFactors)
    .filter(([key, value]) => value.type && value.type.includes('acting'))
    .map(([key, value]) => ({
      id: key,
      name: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      ...value,
      displayName: `${key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} (${value.type.split('_')[0]} acting)`
    }))
    .sort((a, b) => {
      // Sort by action type: rapid, short, intermediate, long, mixed
      const typeOrder = {
        'rapid': 1,
        'short': 2,
        'intermediate': 3,
        'long': 4,
        'mixed': 5
      };

      const typeA = a.type.split('_')[0];
      const typeB = b.type.split('_')[0];

      return typeOrder[typeA] - typeOrder[typeB];
    });
}

/**
 * Format insulin name for display
 * Converts snake_case to Title Case and adds action type
 *
 * @param {string} insulinType - Insulin type identifier (e.g., 'insulin_lispro')
 * @returns {string} Formatted display name
 */
export function formatInsulinName(insulinType) {
  if (!insulinType) return '';

  const insulin = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors[insulinType];
  if (!insulin) return insulinType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  return `${insulinType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} (${insulin.type.split('_')[0]} acting)`;
}

/**
 * Group insulin types by action profile (rapid/short/intermediate/long)
 * Useful for categorized UI displays
 *
 * @returns {Object} Insulin types grouped by category
 */
export function getInsulinTypesByCategory() {
  const insulinTypes = getAvailableInsulinTypes();

  return insulinTypes.reduce((acc, insulin) => {
    const category = insulin.type.split('_')[0];
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(insulin);
    return acc;
  }, {});
}

/**
 * Recommend optimal insulin type based on meal context
 * Considers food absorption speed, meal timing, and time of day
 *
 * @param {string} mealType - Type of meal ('breakfast', 'lunch', 'dinner', 'snack')
 * @param {Array} foods - Array of food items with absorption_type in details
 * @param {Date|number} currentTime - Current time (default: now)
 * @returns {string} Recommended insulin type identifier
 */
export function recommendInsulinType(mealType, foods, currentTime) {
  // Get hour of day (0-23)
  const hour = new Date(currentTime || Date.now()).getHours();

  // Default to regular insulin
  let recommended = 'regular_insulin';

  // Check if any food has very fast absorption
  const hasFastFood = foods.some(food =>
    food.details.absorption_type === 'very_fast' || food.details.absorption_type === 'fast'
  );

  // Check if any food has very slow absorption
  const hasSlowFood = foods.some(food =>
    food.details.absorption_type === 'very_slow' || food.details.absorption_type === 'slow'
  );

  // Morning meals often need rapid insulin due to dawn phenomenon
  if (mealType === 'breakfast' || (hour >= 6 && hour <= 10)) {
    if (hasFastFood) {
      return 'insulin_aspart'; // Fast food in morning needs very rapid insulin
    } else {
      return 'insulin_lispro'; // Regular breakfast
    }
  }

  // For slower absorbing dinner meals, regular insulin may be better
  if (mealType === 'dinner' && hasSlowFood) {
    return 'regular_insulin';
  }

  // For most meals with fast carbs, rapid insulins are preferred
  if (hasFastFood) {
    return 'insulin_lispro';
  }

  // For slow absorbing foods at any time
  if (hasSlowFood) {
    return 'regular_insulin'; // Longer action profile matches slower absorption
  }

  // Default recommendation based on meal type
  const mealTypeRecommendations = {
    'breakfast': 'insulin_lispro',
    'lunch': 'insulin_aspart',
    'dinner': 'insulin_glulisine',
    'snack': 'insulin_aspart'
  };

  return mealTypeRecommendations[mealType] || recommended;
}

/**
 * Calculate non-insulin medication effect based on time since last dose
 * Handles medications like Metformin, GLP-1 agonists, SGLT2 inhibitors
 *
 * @param {string} medication - Medication identifier
 * @param {Object} medData - Medication parameters {onset_hours, peak_hours, duration_hours, factor, duration_based}
 * @param {Object} schedule - Schedule with {startDate, endDate, dailyTimes}
 * @param {Date} currentTime - Current time to calculate effect for
 * @returns {Object} Effect data {status, factor, lastDose?, hoursSinceLastDose?}
 */
export function calculateMedicationEffect(medication, medData, schedule, currentTime = new Date()) {
  if (!medData) return { status: 'Unknown', factor: 1.0 };

  if (medData.duration_based && schedule) {
    const startDate = new Date(schedule.startDate);
    const endDate = new Date(schedule.endDate);

    // Check schedule validity
    if (currentTime < startDate) {
      return {
        status: 'Scheduled to start',
        startDate: startDate.toLocaleDateString(),
        factor: 1.0
      };
    }

    if (currentTime > endDate) {
      return {
        status: 'Schedule ended',
        endDate: endDate.toLocaleDateString(),
        factor: 1.0
      };
    }

    // Find last dose time
    const lastDoseTime = findLastDoseTime(schedule.dailyTimes, currentTime);
    const hoursSinceLastDose = (currentTime - lastDoseTime) / (1000 * 60 * 60);

    // Calculate effect based on medication phase
    if (hoursSinceLastDose < medData.onset_hours) {
      return {
        status: 'Ramping up',
        factor: 1.0 + ((medData.factor - 1.0) * (hoursSinceLastDose / medData.onset_hours)),
        lastDose: lastDoseTime.toLocaleString(),
        hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10
      };
    } else if (hoursSinceLastDose < medData.peak_hours) {
      return {
        status: 'Peak effect',
        factor: medData.factor,
        lastDose: lastDoseTime.toLocaleString(),
        hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10
      };
    } else if (hoursSinceLastDose < medData.duration_hours) {
      const remainingEffect = (medData.duration_hours - hoursSinceLastDose) /
                           (medData.duration_hours - medData.peak_hours);
      return {
        status: 'Tapering',
        factor: 1.0 + ((medData.factor - 1.0) * remainingEffect),
        lastDose: lastDoseTime.toLocaleString(),
        hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10
      };
    }

    return {
      status: 'No current effect',
      factor: 1.0,
      lastDose: lastDoseTime.toLocaleString(),
      hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10
    };
  }

  // Non-duration based medications (constant effect)
  return {
    status: 'Constant effect',
    factor: medData.factor || 1.0
  };
}

/**
 * Find the last dose time based on daily schedule
 * Helper function for calculateMedicationEffect
 *
 * @param {Array} dailyTimes - List of daily time strings (HH:MM format)
 * @param {Date} currentTime - Current reference time
 * @returns {Date} Last dose time
 */
export function findLastDoseTime(dailyTimes, currentTime = new Date()) {
  // Convert daily times to Date objects for the current or previous day
  const doseTimes = dailyTimes.map(time => {
    const [hours, minutes] = time.split(':');
    const doseTime = new Date(currentTime);
    doseTime.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);

    // If this time is in the future today, use yesterday's time
    if (doseTime > currentTime) {
      doseTime.setDate(doseTime.getDate() - 1);
    }

    return doseTime;
  });

  // Find the most recent dose time
  if (doseTimes.length === 0) {
    return new Date(currentTime.getTime() - 24 * 60 * 60 * 1000); // Default to 24h ago if no times
  }

  return doseTimes.sort((a, b) => b - a)[0];
}

export default {
  // Core pharmacodynamics
  calculateInsulinActivity,
  calculateIOB,
  calculateStackedInsulinEffect,
  calculateInsulinBGImpact,
  getInsulinProfile,
  generateInsulinTimeSeries,
  generateInsulinBGTimeSeries,
  getInsulinTimeToPeak,
  getInsulinDuration,
  isInsulinActive,

  // UI utilities (merged from insulinUtils.js)
  getAvailableInsulinTypes,
  formatInsulinName,
  getInsulinTypesByCategory,
  recommendInsulinType,

  // Non-insulin medications
  calculateMedicationEffect,
  findLastDoseTime
};



