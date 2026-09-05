/**
 * Insulin pharmacokinetics calculations for NATIVE diabetes management platform
 * Based on German S3 Guidelines "Therapie des Typ-1-Diabetes" Version 5.0
 * AWMF-Registry: 057-013
 * 
 * Reference: Diabetol Stoffwechs 2024; 19: S155–S166
 * DOI: 10.1055/a-2312-0276
 * 
 * Ported from frontend/src/utils/insulinUtils.js to TypeScript
 * 
 * @module utils/insulin/pharmacokinetics
 */

import { 
  InsulinActionType, 
  InsulinPharmacokinetics, 
  InsulinActivityPoint 
} from '../../types/insulin.types';
import { DEFAULT_PATIENT_CONSTANTS, type MedicationFactor } from '../../constants/shared-constants';

/**
 * Get insulin pharmacokinetics from shared constants
 * @param insulinType - Insulin type identifier
 * @returns Insulin pharmacokinetics parameters
 */
function getInsulinPharmacokinetics(insulinType: string): InsulinPharmacokinetics {
  const medicationFactors = DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const insulin = medicationFactors[insulinType];

  if (!insulin) {
    // Return default rapid-acting insulin parameters
    return {
      onset_hours: 0.5,
      peak_hours: 2.0,
      duration_hours: 4.0,
      type: 'rapid_acting' as InsulinActionType,
      is_peakless: false,
    };
  }

  return {
    onset_hours: insulin.onset_hours || 0.5,
    peak_hours: insulin.peak_hours || 2.0,
    duration_hours: insulin.duration_hours || 4.0,
    type: insulin.type as InsulinActionType,
    is_peakless: insulin.is_peakless || false,
    curve_type: insulin.curve_type,
  };
}

/**
 * Kurtosis type determines the shape of the insulin activity curve
 * - Leptokurtic: Sharp peak, heavy tails (rapid/short acting)
 * - Mesokurtic: Normal peak, moderate tails (intermediate acting)
 * - Platykurtic: Blunt peak, light tails (long acting)
 */
export type KurtosisType = 'leptokurtic' | 'mesokurtic' | 'platykurtic';

/**
 * Determine kurtosis type based on insulin action type
 * @param type - Insulin action type
 * @returns Kurtosis type for curve calculations
 */
export function getKurtosisType(type: InsulinActionType): KurtosisType {
  if (type.includes('rapid') || type.includes('short')) {
    return 'leptokurtic';
  } else if (type.includes('intermediate') || type.includes('mixed')) {
    return 'mesokurtic';
  } else if (type.includes('long')) {
    return 'platykurtic';
  }
  return 'mesokurtic';
}

/**
 * Calculate platykurtic curves for long-acting insulins (very obtuse angle)
 * Enhanced for S3 Guidelines long-acting insulins
 * @internal
 */
function calculatePlatykurticCurve(
  time: number,
  duration: number,
  peakTime: number,
  params: InsulinPharmacokinetics
): number {
  const maxActivity = 75; // Lower max for long-acting (S3 Guidelines show steady state)
  const type = params.type || 'long_acting';

  // Ultra-long insulins (Degludec) have even more obtuse angles
  const isUltraLong = type.includes('degludec') || params.duration_hours > 30;

  // S3 Guidelines-based phase timing
  let riseTime: number;
  let plateauStart: number;
  let plateauEnd: number;

  if (isUltraLong) {
    riseTime = duration * 0.35;
    plateauStart = duration * 0.45;
    plateauEnd = duration * 0.80;
  } else {
    riseTime = duration * 0.25;
    plateauStart = duration * 0.35;
    plateauEnd = duration * 0.75;
  }

  const tailCutoff = 0.02;

  if (time <= 0) return 0;

  if (time <= riseTime) {
    const t = time / riseTime;
    const obtuseCurve = Math.pow(t, isUltraLong ? 2.5 : 2.0);
    return maxActivity * 0.6 * obtuseCurve;
  } else if (time <= plateauStart) {
    const transitionProgress = (time - riseTime) / (plateauStart - riseTime);
    const smoothTransition = 0.5 * (1 - Math.cos(transitionProgress * Math.PI));
    return maxActivity * 0.6 + (maxActivity * 0.25 * smoothTransition);
  } else if (time <= plateauEnd) {
    const plateauProgress = (time - plateauStart) / (plateauEnd - plateauStart);
    const naturalVariation = 0.01 * Math.sin(plateauProgress * Math.PI);
    return maxActivity * 0.85 + (maxActivity * naturalVariation);
  } else {
    const declineTime = (time - plateauEnd) / (duration - plateauEnd);
    const lightDecline = Math.exp(-0.8 * declineTime);
    const activity = maxActivity * 0.85 * lightDecline;

    const cutoffValue = maxActivity * tailCutoff;
    return activity > cutoffValue ? activity : 0;
  }
}

/**
 * Calculate kurtotic curves for peaked insulins
 * Enhanced for S3 Guidelines rapid/short/intermediate acting insulins
 * @internal
 */
function calculateKurtoticCurve(
  time: number,
  duration: number,
  peak: number,
  kurtosisType: KurtosisType,
  params: InsulinPharmacokinetics
): number {
  const maxActivity = 100;
  const type = params.type || 'rapid_acting';

  let alpha: number;
  let beta: number;
  let tailCutoff: number;
  let peakIntensity: number;

  if (kurtosisType === 'leptokurtic') {
    if (type.includes('rapid')) {
      alpha = type.includes('faster') || type.includes('ultra_rapid') ? 8.0 : 6.5;
      beta = 0.5;
      tailCutoff = 0.01;
      peakIntensity = 1.2;
    } else {
      alpha = 4.5;
      beta = 0.6;
      tailCutoff = 0.015;
      peakIntensity = 1.1;
    }
  } else if (kurtosisType === 'mesokurtic') {
    alpha = 3.0;
    beta = 0.8;
    tailCutoff = 0.03;
    peakIntensity = 1.0;
  } else {
    alpha = 3.5;
    beta = 0.8;
    tailCutoff = 0.04;
    peakIntensity = 1.0;
  }

  if (time <= 0) return 0;

  const scale = peak / alpha;

  const gammaValue = Math.pow(time / scale, alpha - 1) * Math.exp(-time / scale);
  const peakValue = Math.pow(peak / scale, alpha - 1) * Math.exp(-peak / scale);

  if (peakValue <= 0) return 0;

  const normalizedValue = gammaValue / peakValue;
  let activity: number;

  if (time <= peak) {
    if (kurtosisType === 'leptokurtic') {
      activity = maxActivity * peakIntensity * Math.pow(normalizedValue, 0.8);
    } else {
      activity = maxActivity * peakIntensity * Math.pow(normalizedValue, 1.0);
    }
  } else {
    const timePastPeak = time - peak;
    const remainingDuration = duration - peak;

    if (remainingDuration <= 0) return 0;

    const tailProgress = timePastPeak / remainingDuration;
    let decayFactor: number;

    if (kurtosisType === 'leptokurtic') {
      decayFactor = Math.exp(-beta * 0.6 * Math.pow(tailProgress, 0.9));
    } else {
      decayFactor = Math.exp(-beta * 1.0 * Math.pow(tailProgress, 1.1));
    }

    activity = maxActivity * peakIntensity * normalizedValue * decayFactor;
  }

  const cutoffValue = maxActivity * tailCutoff;
  return activity > cutoffValue ? Math.max(0, Math.min(maxActivity, activity)) : 0;
}

/**
 * Calculates insulin activity percentage based on German S3 Guidelines
 * Enhanced with proper kurtosis application and S3 constants usage
 *
 * @param hoursSinceDose - Hours since insulin administration
 * @param params - Insulin pharmacokinetic parameters from S3 guidelines
 * @returns Activity percentage (0-100)
 */
export function calculateInsulinActivityPercentage(
  hoursSinceDose: number,
  params: InsulinPharmacokinetics
): number {
  const onset_hours = params.onset_hours ?? 0.5;
  const peak_hours = params.peak_hours ?? 2.0;
  const duration_hours = params.duration_hours ?? 4.0;
  const type = params.type ?? 'rapid_acting';
  const is_peakless = params.is_peakless ?? false;

  // No activity before onset or after duration
  if (hoursSinceDose < 0 || hoursSinceDose > duration_hours) {
    return 0;
  }

  // No activity before onset (S3 Guidelines specify clear onset times)
  if (hoursSinceDose < onset_hours) {
    return 0;
  }

  // Adjust time to start from onset
  const adjustedTime = hoursSinceDose - onset_hours;
  const adjustedDuration = duration_hours - onset_hours;

  // Determine kurtosis based on S3 Guidelines insulin classification
  const kurtosisType = getKurtosisType(type);

  // Apply kurtosis-specific calculation
  if (kurtosisType === 'platykurtic' || is_peakless) {
    return calculatePlatykurticCurve(adjustedTime, adjustedDuration, peak_hours - onset_hours, params);
  } else {
    const adjustedPeak = peak_hours - onset_hours;
    return calculateKurtoticCurve(adjustedTime, adjustedDuration, adjustedPeak, kurtosisType, params);
  }
}

/**
 * Generate complete insulin activity curve for visualization
 *
 * @param insulinType - Insulin type identifier
 * @param doseUnits - Dose amount in units
 * @param administrationTime - Administration timestamp in milliseconds
 * @param intervalMinutes - Time interval between data points (default 5)
 * @param params - Optional insulin pharmacokinetics (will be looked up if not provided)
 * @returns Array of activity points for the curve
 */
export function generateInsulinActivityCurve(
  insulinType: string,
  doseUnits: number,
  administrationTime: number,
  intervalMinutes: number = 5,
  params?: InsulinPharmacokinetics
): InsulinActivityPoint[] {
  const insulinParams = params || getInsulinPharmacokinetics(insulinType);
  const durationMinutes = insulinParams.duration_hours * 60;
  const results: InsulinActivityPoint[] = [];

  // Determine kurtosis type
  const kurtosisType = getKurtosisType(insulinParams.type);

  // Kurtosis-based activity thresholds
  let minActivityThreshold: number;
  if (kurtosisType === 'leptokurtic') {
    minActivityThreshold = 1.0;
  } else if (kurtosisType === 'mesokurtic') {
    minActivityThreshold = 2.0;
  } else {
    minActivityThreshold = 3.0;
  }

  // Generate points at specified intervals
  for (let minute = 0; minute <= durationMinutes; minute += intervalMinutes) {
    const hoursSinceDose = minute / 60;
    const activityPercent = calculateInsulinActivityPercentage(hoursSinceDose, insulinParams);

    if (activityPercent >= minActivityThreshold) {
      const activeUnits = (doseUnits * activityPercent) / 100;
      const timestamp = administrationTime + (minute * 60 * 1000);

      results.push({
        timestamp,
        hoursSinceDose,
        activityPercent,
        activeUnits,
        insulinType,
        curveType: insulinParams.curve_type || 'gamma_steep',
        kurtosisType
      });
    }
  }

  return results;
}

/**
 * Calculate active insulin (IOB - Insulin on Board) at a specific time
 *
 * @param doses - Array of insulin doses with timestamps
 * @param targetTime - Target timestamp in milliseconds to calculate IOB
 * @param patientMedicationFactors - Optional medication factors from patient constants
 * @returns Total active insulin units at the target time
 */
export function calculateActiveInsulin(
  doses: Array<{
    insulinType: string;
    dose: number;
    administrationTime: string | number;
  }>,
  targetTime: number,
  patientMedicationFactors?: Record<string, InsulinPharmacokinetics>
): number {
  let totalActiveInsulin = 0;

  for (const dose of doses) {
    const doseTimestamp = typeof dose.administrationTime === 'number'
      ? dose.administrationTime
      : new Date(dose.administrationTime).getTime();

    const hoursSinceDose = (targetTime - doseTimestamp) / (3600 * 1000);

    // Skip future doses or doses too old to be relevant
    if (hoursSinceDose < 0 || hoursSinceDose > 24) {
      continue;
    }

    // Get insulin parameters
    let insulinParams: InsulinPharmacokinetics;
    if (patientMedicationFactors && patientMedicationFactors[dose.insulinType]) {
      insulinParams = patientMedicationFactors[dose.insulinType];
    } else {
      insulinParams = getInsulinPharmacokinetics(dose.insulinType);
    }

    // Skip if outside duration
    if (hoursSinceDose > insulinParams.duration_hours) {
      continue;
    }

    const activityPercent = calculateInsulinActivityPercentage(hoursSinceDose, insulinParams);
    const activeUnits = (dose.dose * activityPercent) / 100;

    totalActiveInsulin += activeUnits;
  }

  return totalActiveInsulin;
}

/**
 * Calculate blood glucose impact from active insulin
 *
 * @param activeInsulin - Active insulin in units
 * @param correctionFactor - Insulin sensitivity factor (how much 1 unit lowers BG)
 * @returns Blood glucose impact in mg/dL (negative value)
 */
export function calculateBgImpactFromInsulin(
  activeInsulin: number,
  correctionFactor: number = 50
): number {
  if (activeInsulin <= 0) return 0;
  return -(activeInsulin * correctionFactor);
}

export default {
  getKurtosisType,
  calculateInsulinActivityPercentage,
  generateInsulinActivityCurve,
  calculateActiveInsulin,
  calculateBgImpactFromInsulin
};