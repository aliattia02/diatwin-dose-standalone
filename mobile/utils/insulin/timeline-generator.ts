/**
 * Insulin timeline generation for NATIVE diabetes management platform
 * Ported from frontend/src/utils/insulinUtils.js to TypeScript
 * 
 * @module utils/insulin/timeline-generator
 */

import {
  InsulinActionType,
  InsulinActivityPoint,
  InsulinPharmacokinetics,
} from '../../types/insulin.types';
import { PatientConstants } from '../../types/constants.types';
import { calculateInsulinActivity, calculateIOB } from './pharmacodynamics';
import { getDailyResetTime as getPatientDailyResetTime } from '../time/TimeManager';
import { DEFAULT_PATIENT_CONSTANTS } from '../../constants/shared-constants';

/**
 * Insulin dose data
 */
export interface InsulinDose {
  id?: string;
  dose: number;
  medication?: string;
  insulinType?: string;
  administrationTime?: number | string;
  taken_at?: number | string;
  timestamp?: number | string;
}

/**
 * Insulin timeline point
 */
export interface InsulinTimelinePoint {
  timestamp: number;
  formattedTime: string;
  insulinDoses: Record<string, number>;
  insulinBars: Record<string, number>;
  /** Total IOB across all active doses. Mirrors web totalActiveInsulin. */
  activeInsulin: number;
  /**
   * BG impact from absorbed insulin WITHIN the active window only.
   * Mirrors web insulinImpact = -(absorbedUnits x ISF).
   * S-curve that grows negative during absorption, SNAPS BACK TO 0
   * once duration_hours expires. NOT the bell-shaped activity curve.
   */
  bgImpact: number;
  /**
   * Cumulative BG reduction including completed doses.
   * Mirrors web cumulativeInsulinEffect.
   * Stays at -(dose x ISF) after absorption completes, resets at daily_reset_hour.
   */
  cumulativeInsulinEffect: number;
  insulinContributions: Array<{
    insulinType: string;
    doseAmount: number;
    /** Instantaneous active units (bell-curve, for IOB display only) */
    activeUnits: number;
    /** Absorbed units driving bgImpact (S-curve) */
    absorbedUnits: number;
    activityPercent: number;
    iob: number;
    hoursSinceDose: number;
    curveType: string;
    isComplete: boolean;
  }>;
  activeInsulinBidirectional: number;
  doseDetails?: Array<{
    insulinType: string;
    doseAmount: number;
    timestamp: number;
  }>;
}

/**
 * Options for insulin timeline generation
 */
export interface InsulinTimelineOptions {
  timeScale?: {
    start: number;
    end: number;
  };
  patientConstants?: Partial<PatientConstants>;
}

/**
 * Get insulin parameters for a specific insulin type.
 *
 * Resolution order (highest → lowest priority):
 *  1. Patient-specific overrides from patientConstants.medication_factors
 *  2. Shared app-wide defaults from DEFAULT_PATIENT_CONSTANTS.medication_factors
 *  3. Hard-coded fallback for well-known long-acting names
 *  4. Generic rapid-acting defaults
 *
 * IMPORTANT: curve_type must be propagated from the constants so that
 * calculateInsulinActivity() uses the correct kurtosis shape (e.g.
 * 'gamma_steep' for rapid-acting gives the leptokurtic profile with a sharp
 * rise and heavy tail that is clinically correct for T1D).  Without
 * curve_type the calculation falls back to a symmetric bell-curve (alpha=3.0),
 * which is wrong.
 */
function getInsulinParameters(
  insulinType: string | undefined,
  patientConstants: Partial<PatientConstants> | undefined
): InsulinPharmacokinetics {
  // Default parameters if not found
  const defaultParams: InsulinPharmacokinetics = {
    onset_hours: 0.5,
    peak_hours: 2.0,
    duration_hours: 4.0,
    type: 'rapid_acting' as InsulinActionType,
    is_peakless: false,
    // Default curve_type for rapid-acting gives a reasonable asymmetric shape
    // when no better match is found.
    curve_type: 'gamma_steep' as any,
  };

  if (!insulinType) return defaultParams;

  /**
   * Helper: map a raw medication_factors entry → InsulinPharmacokinetics,
   * explicitly including curve_type so the gamma-distribution shaping works.
   */
  function mapMedFactor(entry: any): InsulinPharmacokinetics {
    return {
      onset_hours:    entry.onset_hours    ?? defaultParams.onset_hours,
      peak_hours:     entry.peak_hours     ?? defaultParams.peak_hours,
      duration_hours: entry.duration_hours ?? defaultParams.duration_hours,
      type:           (entry.type          ?? defaultParams.type) as InsulinActionType,
      is_peakless:    entry.is_peakless    ?? false,
      // ↓ THIS IS THE CRITICAL FIELD — without it, calculatePeakedActivity()
      //   defaults to alpha=3.0 (symmetric bell curve) instead of the correct
      //   leptokurtic (gamma_steep/gamma_very_steep) profile for rapid-acting.
      curve_type:     entry.curve_type     as any,
    };
  }

  // 1. Patient-specific overrides take highest precedence
  const patientMedFactors = patientConstants?.medication_factors;
  if (patientMedFactors?.[insulinType]) {
    return mapMedFactor(patientMedFactors[insulinType]);
  }

  // 2. Shared app-wide constants (includes curve_type for all known insulins)
  const sharedMedFactors = DEFAULT_PATIENT_CONSTANTS.medication_factors;
  if (sharedMedFactors?.[insulinType]) {
    return mapMedFactor(sharedMedFactors[insulinType]);
  }

  // 3. Name-based fallback for common long-acting insulins
  if (
    insulinType.includes('glargine') ||
    insulinType.includes('detemir') ||
    insulinType.includes('degludec')
  ) {
    return {
      ...defaultParams,
      type: 'long_acting' as InsulinActionType,
      is_peakless: true,
      onset_hours: 1.0,
      peak_hours: 4.0,
      duration_hours: 24.0,
      curve_type: undefined, // peakless path doesn't use curve_type
    };
  }

  return defaultParams;
}

/**
 * Calculate insulin activity percentage — delegates to the shared
 * pharmacodynamics module which implements the full gamma-distribution
 * model with kurtosis (leptokurtic for rapid-acting, platykurtic for
 * basal insulins).  This is the same implementation used by the web
 * version (insulinPharmacodynamics.js → calculateInsulinActivity).
 */
function calculateInsulinActivityWrapper(
  hoursSinceDose: number,
  params: InsulinPharmacokinetics
): number {
  return calculateInsulinActivity(hoursSinceDose, params);
}

/**
 * Generate insulin timeline data.
 *
 * ── WEB VERSION PARITY ────────────────────────────────────────────────────────
 * The web version (netEffectCalculationService.js → calculateNetEffectAtTime)
 * computes TWO distinct quantities for insulin, and the mobile must do the same:
 *
 * 1. insulinImpact  (web field, plotted as purple area)
 *    = −(absorbedInsulin × correctionFactor)
 *    where absorbedInsulin = dose − IOB  (S-curve, 0 → max during window)
 *    IMPORTANT: doses whose duration has expired are EXCLUDED so this value
 *    snaps back to 0 once absorption is complete.  This is NOT the bell-curve
 *    activity; it is the monotonically-growing absorbed fraction.
 *
 * 2. cumulativeInsulinEffect  (web field, part of green "bank balance" line)
 *    = same absorbed-fraction S-curve DURING the window, but after the window
 *      ends it PERSISTS at −(dose × correctionFactor) until the daily reset.
 *    Mirrors calculateInsulinCumulativeEffect() in the web service.
 *    Resets to 0 at patientConstants.daily_reset_hour (default 7 AM).
 *
 * In the mobile timeline each InsulinTimelinePoint exposes:
 *   bgImpact               → mirrors web insulinImpact  (returns to 0 after window)
 *   cumulativeInsulinEffect → mirrors web cumulativeInsulinEffect (persists, resets daily)
 *   cumulativeNetBaseline   → cumulativeMealEffect + cumulativeInsulinEffect (for charts)
 *   activeInsulin           → total IOB across all active doses (for stacking display)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * @param insulinDoses - Array of insulin dose objects
 * @param options - Timeline generation options
 * @returns Array of timeline points with insulin effects
 */
export function generateInsulinTimelineData(
  insulinDoses: InsulinDose[],
  options: InsulinTimelineOptions = {}
): InsulinTimelinePoint[] {
  const { timeScale = { start: 0, end: 0 }, patientConstants = {} } = options;

  if (!insulinDoses || insulinDoses.length === 0) {
    return [];
  }

  // ── Constants ────────────────────────────────────────────────────────────
  const correctionFactor = (patientConstants as any).correction_factor || 50;
  const resetHour: number = (patientConstants as any).daily_reset_hour ?? 7;
  const tzOffsetMinutes: number = (patientConstants as any).timezone_offset_minutes ?? 0;
  const interval = 15 * 60 * 1000; // 15 minutes in ms

  /**
   * Returns the most recent reset-hour boundary before `currentTimestamp`.
   *
   * FIX (D13): this used `setHours` / `getHours`, so it resolved the reset hour
   * against the *device's* timezone and ignored `timezone_offset_minutes`
   * entirely — a patient's day rolled over at their phone's 07:00, not their
   * own. Arm 1 §2.2 states that all reset-time calculations use UTC Date
   * methods and are immune to the device timezone; that is now true here.
   *
   * Delegating to TimeManager rather than re-deriving it keeps one definition
   * of the boundary (Arm 5 rule 16).
   */
  function getDailyResetTime(currentTimestamp: number): number {
    return getPatientDailyResetTime(currentTimestamp, resetHour, tzOffsetMinutes);
  }

  /**
   * Mirror of web's isWithinCurrentDay():
   * True if doseTimestamp is AFTER the most recent reset boundary.
   */
  function isWithinCurrentDay(doseTimestamp: number, currentTimestamp: number): boolean {
    const resetTime = getDailyResetTime(currentTimestamp);
    return doseTimestamp > resetTime;
  }

  /**
   * Mirror of web's calculateInsulinAbsorptionFraction():
   * Uses IOB (remaining insulin fraction) to derive absorbed fraction.
   * Stays at 1.0 after absorption completes — unlike IOB which drops to 0.
   */
  function getAbsorptionFraction(hoursSinceDose: number, params: InsulinPharmacokinetics, doseAmount: number): number {
    if (hoursSinceDose <= 0) return 0;
    if (hoursSinceDose >= params.duration_hours) return 1.0;
    const iobFraction = calculateIOB(hoursSinceDose, 1.0, params); // IOB per 1 unit
    return Math.max(0, Math.min(1.0, 1.0 - iobFraction));
  }

  try {
    const timeline: InsulinTimelinePoint[] = [];

    // Normalise dose timestamps once, not inside the hot loop
    const normalisedDoses = insulinDoses.map((dose) => {
      const rawTime = dose.administrationTime || dose.taken_at || dose.timestamp;
      const doseTimestamp = rawTime
        ? typeof rawTime === 'number' ? rawTime : new Date(rawTime).getTime()
        : null;
      return { ...dose, _ts: doseTimestamp };
    }).filter((d) => d._ts !== null) as Array<InsulinDose & { _ts: number }>;

    for (let time = timeScale.start; time <= timeScale.end; time += interval) {
      const timePoint: InsulinTimelinePoint = {
        timestamp: time,
        formattedTime: new Date(time).toLocaleString(),
        insulinDoses: {},
        insulinBars: {},
        activeInsulin: 0,       // total IOB (stacking display)
        bgImpact: 0,            // mirrors web insulinImpact (S-curve, resets after window)
        cumulativeInsulinEffect: 0,  // mirrors web cumulativeInsulinEffect (persists)
        insulinContributions: [],
        activeInsulinBidirectional: 0,
      };

      // ── Mark dose-administration time points ────────────────────────────
      normalisedDoses.forEach((dose) => {
        if (Math.abs(dose._ts - time) <= interval / 2) {
          const insulinType = dose.medication || dose.insulinType || 'unknown';
          const doseAmount = dose.dose || 0;
          timePoint.insulinDoses[insulinType] = (timePoint.insulinDoses[insulinType] || 0) + doseAmount;
          timePoint.insulinBars[insulinType] = -doseAmount;
          if (!timePoint.doseDetails) timePoint.doseDetails = [];
          timePoint.doseDetails.push({ insulinType, doseAmount, timestamp: dose._ts });
        }
      });

      // ── STEP A: insulinImpact — absorbed fraction, WITHIN window only ───
      // Mirror of web's Step 2/3 in calculateNetEffectAtTime:
      //   dosesForCalculation = filter to hoursSinceDose <= duration
      //   insulinImpact       = −(sum of (dose − IOB) for each active dose) × ISF
      //
      // Doses past their duration are EXCLUDED here (they snap bgImpact to 0)
      // exactly as the web does before the daily-reset handles persistence.
      let totalIOB = 0;
      let totalAbsorbedInWindow = 0;

      const insulinContributions: InsulinTimelinePoint['insulinContributions'] = [];

      normalisedDoses.forEach((dose) => {
        const hoursSinceDose = (time - dose._ts) / 3_600_000;
        if (hoursSinceDose < 0) return;

        const insulinType = dose.medication || dose.insulinType || 'unknown';
        const params = getInsulinParameters(insulinType, patientConstants);

        // ← Completed doses excluded from insulinImpact (same as web filter)
        if (hoursSinceDose > params.duration_hours) return;

        const doseAmount = dose.dose || 0;
        const activityPercent = calculateInsulinActivityWrapper(hoursSinceDose, params);
        const activeUnits = (doseAmount * activityPercent) / 100;
        const iob = calculateIOB(hoursSinceDose, doseAmount, params);
        const absorbedUnits = Math.max(0, doseAmount - iob);

        totalIOB += iob;
        totalAbsorbedInWindow += absorbedUnits;

        insulinContributions.push({
          insulinType,
          doseAmount,
          activeUnits,
          absorbedUnits,
          activityPercent,
          iob,
          hoursSinceDose,
          curveType: params.type,
          isComplete: false,
        });
      });

      // bgImpact = absorbed S-curve during window, 0 outside window
      // Negative because insulin lowers BG.
      timePoint.bgImpact = -(totalAbsorbedInWindow * correctionFactor);
      timePoint.activeInsulin = totalIOB;
      timePoint.activeInsulinBidirectional = -totalIOB;
      timePoint.insulinContributions = insulinContributions;

      // ── STEP B: cumulativeInsulinEffect — persists after window ─────────
      // Mirror of web's calculateInsulinCumulativeEffect() per dose:
      //   - Only doses from current day (after daily reset) contribute
      //   - During window: absorbed-fraction S-curve (same as insulinImpact)
      //   - After window: STAYS at −(dose × ISF) until next reset
      // This is what gives the persistent "bank balance" the web's green line shows.
      // D13: compare in the patient's local time, not the device's. Shifting
      // by the offset and reading UTC fields is the same trick TimeManager
      // uses, and is immune to the device timezone.
      const isExactlyAtReset = (() => {
        const local = new Date(time + tzOffsetMinutes * 60 * 1000);
        return local.getUTCHours() === resetHour && local.getUTCMinutes() === 0;
      })();

      let cumulativeInsulinEffect = 0;
      if (!isExactlyAtReset) {
        normalisedDoses.forEach((dose) => {
          const doseTimestamp = dose._ts;
          // Only doses from current day (after last reset)
          if (!isWithinCurrentDay(doseTimestamp, time)) return;

          const hoursSinceDose = (time - doseTimestamp) / 3_600_000;
          if (hoursSinceDose < 0) return;

          const doseAmount = dose.dose || 0;
          const insulinType = dose.medication || dose.insulinType || 'unknown';
          const params = getInsulinParameters(insulinType, patientConstants);

          if (hoursSinceDose >= params.duration_hours) {
            // ← Dose COMPLETED: effect PERSISTS at full value (unlike insulinImpact)
            cumulativeInsulinEffect += -(doseAmount * correctionFactor);
          } else {
            // Dose still absorbing: same S-curve value as insulinImpact
            const absorptionFraction = getAbsorptionFraction(hoursSinceDose, params, doseAmount);
            cumulativeInsulinEffect += -(doseAmount * absorptionFraction * correctionFactor);
          }
        });
      }

      timePoint.cumulativeInsulinEffect = cumulativeInsulinEffect;

      timeline.push(timePoint);
    }

    return timeline;
  } catch (error) {
    // Error generating insulin timeline data
    return [];
  }
}

/**
 * Calculate combined insulin effect at a specific time.
 *
 * Mirrors the web's calculateNetEffectAtTime() insulin section exactly:
 * - bgImpact      = -(absorbed × ISF) for doses WITHIN their window only
 *                   (matches web insulinImpact — snaps to 0 after window)
 * - totalIOB      = sum of IOB across all active doses
 */
export function calculateCombinedInsulinEffect(
  insulinDoses: InsulinDose[],
  targetTime: number,
  patientConstants: Partial<PatientConstants> = {}
): {
  totalActiveInsulin: number;  // IOB remaining
  insulinContributions: Array<any>;
  bgImpact: number;            // matches web insulinImpact (resets after window)
} {
  if (!insulinDoses || insulinDoses.length === 0) {
    return { totalActiveInsulin: 0, insulinContributions: [], bgImpact: 0 };
  }

  const correctionFactor = (patientConstants as any).correction_factor || 50;
  const contributions: Array<any> = [];
  let totalIOB = 0;
  let totalAbsorbedInWindow = 0;

  insulinDoses.forEach((dose) => {
    const doseTime = dose.administrationTime || dose.taken_at || dose.timestamp;
    if (!doseTime) return;

    const doseTimestamp = typeof doseTime === 'number' ? doseTime : new Date(doseTime).getTime();
    const hoursSinceDose = (targetTime - doseTimestamp) / 3_600_000;

    if (hoursSinceDose < 0) return;

    const insulinType = dose.medication || dose.insulinType || 'unknown';
    const insulinParams = getInsulinParameters(insulinType, patientConstants);
    const doseAmount = dose.dose || 0;

    // Exclude completed doses from bgImpact (same as web dosesForCalculation filter)
    if (hoursSinceDose > insulinParams.duration_hours) return;

    const activityPercent = calculateInsulinActivityWrapper(hoursSinceDose, insulinParams);
    const iob = calculateIOB(hoursSinceDose, doseAmount, insulinParams);
    const absorbedUnits = Math.max(0, doseAmount - iob);

    totalIOB += iob;
    totalAbsorbedInWindow += absorbedUnits;

    contributions.push({
      dose: doseAmount,
      activeUnits: (doseAmount * activityPercent) / 100,
      absorbedUnits,
      iob,
      activityPercent,
      insulinType,
      hoursSinceDose,
    });
  });

  return {
    totalActiveInsulin: totalIOB,
    insulinContributions: contributions,
    bgImpact: -(totalAbsorbedInWindow * correctionFactor),
  };
}

export default {
  generateInsulinTimelineData,
  calculateCombinedInsulinEffect,
};