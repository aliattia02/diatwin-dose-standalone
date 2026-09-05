/**
 * ============================================================================
 * INSULIN PHARMACODYNAMICS
 * ============================================================================
 *
 * Comprehensive insulin pharmacodynamics system implementing:
 *
 * 1. PHARMACOKINETICS - S3 Guidelines-based insulin modeling using
 *    gamma distribution curves with kurtosis modeling for physiologically-
 *    accurate insulin activity and IOB (Insulin On Board) calculations.
 *
 * 2. ACTIVITY CALCULATIONS - Precise insulin activity curves for all
 *    insulin types (rapid, short, intermediate, long-acting).
 *
 * 3. IOB CALCULATIONS - Insulin on board tracking for stacking prevention
 *    and correction dose safety.
 *
 * 4. BLOOD GLUCOSE IMPACT - T1D model for cumulative and pending BG effects.
 *
 * References:
 * - S3 Guidelines "Therapie des Typ-1-Diabetes" Version 5.0
 * - Gamma distribution for drug pharmacokinetics
 * - Clinical insulin pharmacokinetic profiles
 *
 * @module utils/insulin/pharmacodynamics
 * @version 4.0 - TypeScript migration
 */

import {
  InsulinPharmacokinetics,
  InsulinActionType,
  InsulinCurveType,
} from '../../types/insulin.types';
import {
  IOBResult,
  InsulinActivityResult,
  PharmacodynamicTimelinePoint,
  StackedPharmacodynamicEffect,
} from '../../types/pharmacodynamics.types';
import { DEFAULT_PATIENT_CONSTANTS, type MedicationFactor } from '../../constants/shared-constants';
import { isEffectActive } from '../time/TimeManager';

/**
 * Get insulin pharmacokinetics from shared constants
 * @param insulinType - Insulin type identifier
 * @returns Insulin pharmacokinetics parameters
 */
function getInsulinPharmacokinetics(insulinType: string): InsulinPharmacokinetics {
  const medicationFactors = DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const insulin = medicationFactors[insulinType];

  if (!insulin) {
    // Fall back to insulin_aspart profile — backend B-PD-3 fix (TS-C-1b).
    // The old fallback (onset 0.5h / peak 2.0h / dur 4.0h) predates the S3 Guidelines
    // calibration. insulin_aspart (onset 0.375h / peak 2.25h / dur 4.5h, gamma_steep)
    // is the canonical rapid-acting reference used by the Python backend.
    const aspart = medicationFactors['insulin_aspart'];
    if (aspart) {
      return {
        onset_hours:    aspart.onset_hours    || 0.375,
        peak_hours:     aspart.peak_hours     || 2.25,
        duration_hours: aspart.duration_hours || 4.5,
        type:           aspart.type           as InsulinActionType,
        is_peakless:    aspart.is_peakless    || false,
        curve_type:     aspart.curve_type     as InsulinCurveType | undefined,
      };
    }
    // Last-resort: inline aspart constants in case medication_factors is somehow absent
    return {
      onset_hours:    0.375,
      peak_hours:     2.25,
      duration_hours: 4.5,
      type:           'rapid_acting' as InsulinActionType,
      is_peakless:    false,
      curve_type:     'gamma_steep'  as InsulinCurveType,
    };
  }

  return {
    onset_hours: insulin.onset_hours || 0.5,
    peak_hours: insulin.peak_hours || 2.0,
    duration_hours: insulin.duration_hours || 4.0,
    type: insulin.type as InsulinActionType,
    is_peakless: insulin.is_peakless || false,
    curve_type: insulin.curve_type as InsulinCurveType | undefined,
  };
}

/**
 * Get all insulin profiles from shared constants
 */
const ALL_INSULIN_PROFILES = (() => {
  const medications = DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const profiles: Record<string, InsulinPharmacokinetics> = {};

  Object.entries(medications).forEach(([key, value]) => {
    profiles[key] = {
      onset_hours: value.onset_hours || 0.5,
      peak_hours: value.peak_hours || 2.0,
      duration_hours: value.duration_hours || 4.0,
      type: value.type as InsulinActionType,
      is_peakless: value.is_peakless || false,
      curve_type: value.curve_type as InsulinCurveType | undefined,
    };
  });

  return profiles;
})();

/**
 * Insulin dose for stacking calculations
 */
export interface InsulinDoseForStacking {
  /** Insulin dose in units */
  dose: number;
  /** Hours elapsed since dose administration */
  hoursSinceDose: number;
  /** Insulin type identifier */
  insulinType: string;
  /** Optional name for display */
  name?: string;
}

/**
 * Insulin dose with timing for time series generation
 */
export interface InsulinDoseWithTiming extends InsulinDoseForStacking {
  /** Time offset in minutes from series start */
  timeMinutes?: number;
}

/**
 * Dose contribution to stacked insulin effect
 */
export interface DoseContribution {
  /** Insulin type */
  insulinType: string;
  /** Dose in units */
  dose: number;
  /** Hours since dose */
  hoursSinceDose: number;
  /** Activity percentage (0-100) */
  activity: number;
  /** Active units at this time */
  activeUnits: number;
  /** Insulin on board in units */
  iob: number;
  /** Blood glucose impact in mg/dL */
  bgImpact: number;
  /** Insulin profile parameters */
  profile: {
    onset: number;
    peak: number | null;
    duration: number;
    type: InsulinActionType;
  };
}

/**
 * Stacked insulin effect result
 */
export interface StackedInsulinEffect {
  /** Total insulin on board across all doses */
  totalIOB: number;
  /** Total activity percentage */
  totalActivity: number;
  /** Total blood glucose impact in mg/dL */
  totalBGImpact: number;
  /** Number of active doses */
  activeDoses: number;
  /** Individual dose contributions */
  contributions: DoseContribution[];
  /** Whether multiple doses are overlapping */
  isStacking: boolean;
  /** Stacking risk level */
  stackingRisk: 'low' | 'moderate' | 'high' | 'severe';
}

/**
 * Insulin BG impact result
 */
export interface InsulinBGImpact {
  /** Current cumulative BG reduction in mg/dL */
  bgReduction: number;
  /** Pending BG reduction from IOB in mg/dL */
  pendingReduction: number;
  /** Total expected reduction (current + pending) */
  totalExpectedReduction: number;
  /** Insulin that has already acted (units) */
  absorbedInsulin: number;
  /** Currently active insulin (units) */
  activeInsulin: number;
  /** Insulin on board (units) */
  iob: number;
  /** Current activity percentage (0-100) */
  activity: number;
  /** Fraction of insulin absorbed (0-1) */
  absorbedFraction: number;
  /** Percentage of insulin absorbed (0-100) */
  absorbedPercent: number;
  /** Hours since dose */
  hoursSinceDose: number;
  /** Whether insulin is still active */
  isActive: boolean;
  /** Whether insulin has completed action */
  isComplete?: boolean;
  /** Insulin profile information */
  profile: {
    onset: number;
    peak: number | null;
    duration: number;
    type: InsulinActionType;
    is_peakless: boolean;
  };
}

/**
 * Time series data point for insulin visualization
 */
export interface InsulinTimeSeriesPoint {
  /** Time in minutes from start */
  time: number;
  /** Time label (HH:MM format) */
  timeLabel: string;
  /** Hours from start */
  hours: number;
  /** Total activity percentage */
  totalActivity: number;
  /** Total IOB in units */
  totalIOB: number;
  /** Total BG impact in mg/dL */
  totalBGImpact: number;
  /** Active dose details */
  activeDoses: Array<{
    name: string;
    insulinType: string;
    activity: number;
    iob: number;
    activeUnits: number;
    bgImpact: number;
  }>;
  /** Whether multiple doses are active */
  isStacking: boolean;
}

/**
 * BG-centric time series data point
 */
export interface InsulinBGTimeSeriesPoint {
  /** Time in minutes from start */
  time: number;
  /** Time label (HH:MM format) */
  timeLabel: string;
  /** Hours from start */
  hours: number;
  /** Baseline BG before insulin */
  baselineBG: number;
  /** Current BG with insulin effect */
  currentBG: number;
  /** Projected final BG */
  projectedFinalBG: number;
  /** Total BG reduction so far */
  totalBGReduction: number;
  /** Pending BG reduction from IOB */
  totalPendingReduction: number;
  /** Total active insulin (units) */
  totalActiveInsulin: number;
  /** Total IOB (units) */
  totalIOB: number;
  /** Total activity percentage */
  totalActivity: number;
  /** Active dose details */
  activeDoses: Array<{
    name: string;
    insulinType: string;
    activity: number;
    activeInsulin: number;
    iob: number;
    bgReduction: number;
    pendingReduction: number;
  }>;
  /** Whether multiple doses are active */
  isStacking: boolean;
}

/**
 * Food item for insulin recommendation
 */
export interface FoodItem {
  details: {
    absorption_type: 'very_fast' | 'fast' | 'medium' | 'slow' | 'very_slow';
  };
}

/**
 * Medication schedule for effect calculation
 */
export interface MedicationSchedule {
  /** Start date of medication */
  startDate: string | Date;
  /** End date of medication */
  endDate: string | Date;
  /** Daily dose times in HH:MM format */
  dailyTimes: string[];
}

/**
 * Medication data for effect calculation
 */
export interface MedicationData {
  /** Effect multiplier factor */
  factor: number;
  /** Whether effect is duration-based */
  duration_based: boolean;
  /** Time to onset in hours */
  onset_hours?: number;
  /** Time to peak effect in hours */
  peak_hours?: number;
  /** Total duration in hours */
  duration_hours?: number;
}

/**
 * Medication effect result
 */
export interface MedicationEffect {
  /** Current status */
  status: string;
  /** Effect factor multiplier */
  factor: number;
  /** Last dose time (formatted) */
  lastDose?: string;
  /** Hours since last dose */
  hoursSinceLastDose?: number;
  /** Start date (formatted) */
  startDate?: string;
  /** End date (formatted) */
  endDate?: string;
}

/**
 * Calculate insulin activity percentage at a given time using gamma distribution
 *
 * This is the CORE calculation that determines how active insulin is at any point.
 * Uses different curve shapes (kurtosis) based on insulin type:
 * - Leptokurtic: Sharp peak, heavy tails (rapid-acting)
 * - Mesokurtic: Normal bell curve (regular/intermediate)
 * - Platykurtic: Flat plateau (long-acting)
 *
 * @param hoursSinceDose - Hours elapsed since insulin administration
 * @param insulinProfile - Insulin pharmacokinetic parameters
 * @returns Activity percentage (0-100)
 */
export function calculateInsulinActivity(
  hoursSinceDose: number,
  insulinProfile: InsulinPharmacokinetics
): number {
  const {
    onset_hours,
    peak_hours,
    duration_hours,
    is_peakless,
    curve_type,
    type,
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
 * Long-acting insulins use multi-phase curves:
 * - Phase 1: Rising phase with obtuse curve
 * - Phase 2: Transition to plateau with smooth sigmoid
 * - Phase 3: Stable plateau with minimal variation
 * - Phase 4: Exponential decay
 *
 * @param hoursSinceDose - Hours since administration
 * @param onsetHours - Time to onset
 * @param durationHours - Total duration
 * @param type - Insulin action type
 * @returns Activity percentage (0-75)
 */
function calculatePeaklessActivity(
  hoursSinceDose: number,
  onsetHours: number,
  durationHours: number,
  type: InsulinActionType
): number {
  const isUltraLong = type === 'long_acting' && durationHours > 30; // Tresiba (42h)
  const maxActivity = 75; // Peakless insulins never reach 100%

  // Phase durations as percentages of total duration
  const riseTime = durationHours * (isUltraLong ? 0.35 : 0.25);
  const plateauStart = durationHours * (isUltraLong ? 0.45 : 0.35);
  const plateauEnd = durationHours * (isUltraLong ? 0.8 : 0.75);

  // Phase 1: Rising phase (onset → plateau) - obtuse curve
  if (hoursSinceDose <= riseTime) {
    const t = hoursSinceDose / riseTime;
    const obtuseCurve = Math.pow(t, isUltraLong ? 2.5 : 2.0);
    return maxActivity * 0.6 * obtuseCurve;
  }

  // Phase 2: Transition to plateau - smooth sigmoid
  if (hoursSinceDose <= plateauStart) {
    const transitionProgress =
      (hoursSinceDose - riseTime) / (plateauStart - riseTime);
    const smoothTransition = 0.5 * (1 - Math.cos(transitionProgress * Math.PI));
    return maxActivity * 0.6 + maxActivity * 0.25 * smoothTransition;
  }

  // Phase 3: Plateau phase - stable with minimal variation
  if (hoursSinceDose <= plateauEnd) {
    const plateauProgress =
      (hoursSinceDose - plateauStart) / (plateauEnd - plateauStart);
    const naturalVariation = 0.01 * Math.sin(plateauProgress * Math.PI);
    return maxActivity * 0.85 + maxActivity * naturalVariation;
  }

  // Phase 4: Decline phase - exponential decay
  const declineTime = (hoursSinceDose - plateauEnd) / (durationHours - plateauEnd);
  const lightDecline = Math.exp(-0.8 * declineTime);
  return maxActivity * 0.85 * lightDecline;
}

/**
 * Calculate activity for peaked insulin using gamma distribution
 *
 * Implements kurtosis-based curves for physiological accuracy:
 * - Leptokurtic (sharp peak, heavy tails): Rapid-acting insulins
 * - Mesokurtic (normal distribution): Regular insulin
 * - Platykurtic-like (broader, flatter): Intermediate-acting
 *
 * Uses gamma distribution: f(x) = (x^(α-1) * e^(-x/θ)) / (θ^α * Γ(α))
 * where α = shape parameter, θ = scale parameter
 *
 * @param hoursSinceDose - Hours since administration
 * @param onsetHours - Time to onset
 * @param peakHours - Time to peak activity
 * @param durationHours - Total duration
 * @param curveType - Type of curve (gamma_steep, gamma_broad, etc.)
 * @returns Activity percentage (0-100)
 */
function calculatePeakedActivity(
  hoursSinceDose: number,
  onsetHours: number,
  peakHours: number,
  durationHours: number,
  curveType: InsulinCurveType | undefined
): number {
  const maxActivity = 100;

  // Determine kurtosis parameters based on curve type
  let alpha: number;
  let beta: number;
  let peakIntensity: number;

  if (curveType === 'gamma_very_steep' || curveType === 'gamma_steep') {
    // LEPTOKURTIC: Sharp, intense peak (ultra-rapid and rapid-acting)
    alpha = curveType === 'gamma_very_steep' ? 8.0 : 6.5;
    beta = 0.5;
    peakIntensity = 1.0; // Activity cannot exceed 100%
  } else if (curveType === 'gamma_broad') {
    // MESOKURTIC: Normal distribution (short-acting/regular insulin)
    alpha = 4.5;
    beta = 0.8;
    peakIntensity = 1.0;
  } else {
    // PLATYKURTIC-LIKE: Broader, flatter peak (intermediate-acting and others)
    alpha = 3.0;
    beta = 1.0;
    peakIntensity = 1.0;
  }

  /**
   * Gamma distribution calculation
   *
   * The gamma distribution is used to model insulin activity curves:
   * - Scale parameter (θ) is derived from peak time and shape
   * - Shape parameter (α) controls curve sharpness
   * - Normalized to peak value for percentage calculation
   */
  const scale = peakHours / alpha;
  const gammaValue =
    Math.pow(hoursSinceDose / scale, alpha - 1) *
    Math.exp(-hoursSinceDose / scale);
  const peakValue =
    Math.pow(peakHours / scale, alpha - 1) * Math.exp(-peakHours / scale);

  if (peakValue <= 0) return 0;

  const normalizedValue = gammaValue / peakValue;

  // Rising phase (onset → peak)
  let activityValue: number;
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

    let decayFactor: number;
    if (curveType === 'gamma_very_steep' || curveType === 'gamma_steep') {
      // HEAVY TAILS: Leptokurtic distribution - slower decay
      decayFactor = Math.exp(-beta * 0.6 * Math.pow(tailProgress, 0.9));
    } else {
      // LIGHT TAILS: Faster decay for regular insulin
      decayFactor = Math.exp(-beta * 1.0 * Math.pow(tailProgress, 1.1));
    }

    activityValue = maxActivity * peakIntensity * normalizedValue * decayFactor;
  }

  // Cap activity at 100%
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
 * The trapezoidal rule provides accurate numerical integration:
 * ∫[t,T] activity(x)dx ≈ Δt * (f(t₀)/2 + f(t₁) + ... + f(tₙ₋₁) + f(tₙ)/2)
 *
 * @param hoursSinceDose - Hours elapsed since administration
 * @param initialDose - Original insulin dose in units
 * @param insulinProfile - Insulin pharmacokinetic parameters
 * @returns Remaining active insulin in units
 */
export function calculateIOB(
  hoursSinceDose: number,
  initialDose: number,
  insulinProfile: InsulinPharmacokinetics
): number {
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
    const time = hoursSinceDose + i * dt;
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
 * @param doses - Array of insulin doses with timing information
 * @param correctionFactor - mg/dL drop per unit (default: 50)
 * @returns Detailed stacking analysis
 */
export function calculateStackedInsulinEffect(
  doses: InsulinDoseForStacking[],
  correctionFactor: number = 40
): StackedInsulinEffect {
  let totalActivity = 0;
  let totalIOB = 0;
  let totalBGImpact = 0;
  const doseContributions: DoseContribution[] = [];

  doses.forEach((dose) => {
    const profile = getInsulinPharmacokinetics(dose.insulinType);

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
          type: profile.type,
        },
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
    stackingRisk: calculateStackingRisk(doseContributions),
  };
}

// ============================================================================
// S-CURVE CHART API
// ============================================================================
//
// WHY THIS EXISTS — the bell-curve vs. S-curve problem
// ─────────────────────────────────────────────────────
// calculateStackedInsulinEffect (above) computes:
//
//   bgImpact = (dose × activityPercent / 100) × ISF
//            = activeUnits × ISF
//
// `activityPercent` is the instantaneous gamma-PDF value — it rises to a peak
// at peak_hours then falls back to zero.  Multiplying a scalar by this produces
// a BELL CURVE that mirrors the shape of the activity curve itself.
//
// The web version's purple area is NOT a bell curve.  It plots the CUMULATIVE
// BG reduction already delivered by the absorbed fraction of the dose:
//
//   absorbedUnits = dose − IOB          (monotonically grows 0 → dose)
//   bgImpact      = absorbedUnits × ISF (monotonically grows 0 → dose×ISF)
//
// This gives an S-curve that starts at 0, grows as insulin absorbs, and snaps
// back to 0 the instant the dose duration expires — exactly mirroring the
// orange meal-effect area (which plots cumulative absorbed carbs).
//
// calculateStackedInsulinChartEffect implements this S-curve formula and is the
// ONLY function that should be used for chart area rendering.
// calculateStackedInsulinEffect remains correct for IOB widgets, stacking-risk
// alerts, and correction-dose displays — contexts where instantaneous activity
// rate is the right quantity.
// ============================================================================

/**
 * Single-dose contribution to the S-curve chart series.
 * Returned per dose in StackedInsulinChartEffect.contributions.
 */
export interface InsulinChartDoseContribution {
  /** Insulin type identifier */
  insulinType: string;
  /** Original dose in units */
  dose: number;
  /** Hours elapsed since administration */
  hoursSinceDose: number;
  /** Insulin still remaining to act (units) — decreasing over time */
  iob: number;
  /** Insulin that has already delivered its BG-lowering effect (units) */
  absorbedUnits: number;
  /** Cumulative BG reduction already delivered (mg/dL, always >= 0) */
  bgReduction: number;
  /** Fraction of dose absorbed so far (0 → 1) */
  absorbedFraction: number;
  /** Insulin profile parameters used */
  profile: {
    onset: number;
    peak: number | null;
    duration: number;
    type: InsulinActionType;
  };
}

/**
 * Result of calculateStackedInsulinChartEffect.
 * Use `totalBGImpact` (always <= 0) as the y-value for the purple area series.
 */
export interface StackedInsulinChartEffect {
  /**
   * Total cumulative BG reduction already delivered across all doses (mg/dL).
   * Always <= 0.  Use this as the y-value for the purple insulin area.
   */
  totalBGImpact: number;
  /** Total IOB across all active doses (units). */
  totalIOB: number;
  /** Number of doses that still have active absorption. */
  activeDoses: number;
  /** Per-dose breakdown. */
  contributions: InsulinChartDoseContribution[];
}

/**
 * Calculate the cumulative BG reduction already delivered by a single dose
 * at a given time — the S-curve formula used for chart rendering.
 *
 * Formula:
 *   absorbedUnits = max(0, dose − IOB)
 *   bgImpact      = -(absorbedUnits × correctionFactor)
 *
 * The result grows monotonically negative as the dose absorbs, then resets to
 * 0 the instant `hoursSinceDose` exceeds `duration_hours`.  This produces the
 * S-shaped curve visible in the web version's purple area series.
 *
 * Contrast with calculateStackedInsulinEffect which computes the instantaneous
 * activity RATE (a bell curve) — correct for IOB displays, wrong for chart areas.
 *
 * @param hoursSinceDose   - Hours elapsed since administration
 * @param initialDose      - Original dose in units
 * @param insulinType      - Insulin type identifier
 * @param correctionFactor - mg/dL drop per unit (default: 50)
 * @returns Cumulative BG reduction in mg/dL (<= 0), or 0 outside the active window
 */
export function calculateInsulinSCurveBGImpact(
  hoursSinceDose: number,
  initialDose: number,
  insulinType: string,
  correctionFactor: number = 40
): number {
  if (hoursSinceDose < 0 || initialDose <= 0) return 0;

  const profile = getInsulinPharmacokinetics(insulinType);
  if (!profile) return 0;

  // After the full duration has elapsed the dose is completely absorbed and its
  // cumulative effect has been fully captured in the daily baseline (via
  // calculateInsulinCumulativeEffect).  Reset to 0 so the area snaps closed.
  if (hoursSinceDose > profile.duration_hours) return 0;

  const iob = calculateIOB(hoursSinceDose, initialDose, profile);
  const absorbedUnits = Math.max(0, initialDose - iob);

  return -(absorbedUnits * correctionFactor); // negative = BG-lowering
}

/**
 * Calculate the stacked S-curve insulin BG impact for the chart area series.
 *
 * CHART USE ONLY — do not use for IOB widgets or correction-dose decisions.
 * For those, continue to use calculateStackedInsulinEffect which provides the
 * instantaneous activity rate (bell curve) needed for stacking-risk analysis.
 *
 * Each dose contributes:
 *   absorbedUnits = max(0, dose − IOB)
 *   bgImpact      = -(absorbedUnits × correctionFactor)
 *
 * The returned `totalBGImpact` (always <= 0) is the y-value to plot for the
 * purple insulin area.  It will produce an S-curve that rises from 0, grows
 * monotonically negative as insulin absorbs, then snaps back to 0 when the
 * dose duration expires — matching the web version exactly.
 *
 * @param doses            - Doses with hoursSinceDose pre-computed
 * @param correctionFactor - mg/dL drop per unit (default: 50)
 * @returns S-curve effect totals with per-dose breakdown
 *
 * @example
 * // In EffectsVisualizationChart buildChartPoint():
 * const chartInsulin = calculateStackedInsulinChartEffect(dosesForStackingAtTime, correctionFactor);
 * const insulinImpact = chartInsulin.totalBGImpact; // <= 0, S-curve
 */
export function calculateStackedInsulinChartEffect(
  doses: InsulinDoseForStacking[],
  correctionFactor: number = 40
): StackedInsulinChartEffect {
  let totalBGImpact = 0;
  let totalIOB = 0;
  const contributions: InsulinChartDoseContribution[] = [];

  for (const dose of doses) {
    const { hoursSinceDose, dose: units, insulinType } = dose;
    if (hoursSinceDose < 0 || units <= 0) continue;

    const profile = getInsulinPharmacokinetics(insulinType);
    if (!profile) {
      console.warn(`[calculateStackedInsulinChartEffect] Unknown insulin type: ${insulinType}`);
      continue;
    }

    // Skip doses that have fully expired — their effect is captured in the
    // cumulative baseline (calculateTotalCumulativeEffects) not here.
    if (hoursSinceDose > profile.duration_hours) continue;

    const iob = calculateIOB(hoursSinceDose, units, profile);
    const absorbedUnits = Math.max(0, units - iob);
    const bgReduction = absorbedUnits * correctionFactor; // always >= 0
    const absorbedFraction = units > 0 ? absorbedUnits / units : 0;

    totalIOB += iob;
    totalBGImpact -= bgReduction; // accumulate as negative (BG-lowering)

    contributions.push({
      insulinType,
      dose: units,
      hoursSinceDose: Math.round(hoursSinceDose * 100) / 100,
      iob: Math.round(iob * 100) / 100,
      absorbedUnits: Math.round(absorbedUnits * 100) / 100,
      bgReduction: Math.round(bgReduction * 10) / 10,
      absorbedFraction: Math.round(absorbedFraction * 1000) / 1000,
      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        type: profile.type,
      },
    });
  }

  return {
    totalBGImpact: Math.round(totalBGImpact * 10) / 10,   // <= 0
    totalIOB:      Math.round(totalIOB * 100) / 100,
    activeDoses:   contributions.length,
    contributions,
  };
}

/**
 * Calculate stacking risk level based on dose contributions
 *
 * Risk assessment based on:
 * - Total IOB amount
 * - Number of overlapping doses at peak times
 *
 * @param contributions - Dose contributions
 * @returns Risk level: 'low' | 'moderate' | 'high' | 'severe'
 */
function calculateStackingRisk(
  contributions: DoseContribution[]
): 'low' | 'moderate' | 'high' | 'severe' {
  if (contributions.length <= 1) return 'low';

  const totalIOB = contributions.reduce((sum, c) => sum + c.iob, 0);

  // Check for overlapping peaks
  const peakOverlap = contributions.filter(
    (c) =>
      c.profile.peak !== null &&
      c.hoursSinceDose >= c.profile.peak * 0.5 &&
      c.hoursSinceDose <= c.profile.peak * 1.5
  ).length;

  if (totalIOB > 15 || peakOverlap >= 3) return 'severe';
  if (totalIOB > 10 || peakOverlap >= 2) return 'high';
  if (totalIOB > 5) return 'moderate';
  return 'low';
}

/**
 * Get insulin profile pharmacokinetics by insulin type
 *
 * @param insulinType - Insulin type identifier
 * @returns Insulin pharmacokinetic profile or null if not found
 */
export function getInsulinProfile(
  insulinType: string
): InsulinPharmacokinetics | null {
  return getInsulinPharmacokinetics(insulinType);
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
 * @param hoursSinceDose - Hours since insulin administration
 * @param initialDose - Original insulin dose (units)
 * @param insulinType - Type of insulin
 * @param correctionFactor - BG drop per unit (default: 50)
 * @returns Comprehensive blood glucose impact breakdown
 */
export function calculateInsulinBGImpact(
  hoursSinceDose: number,
  initialDose: number,
  insulinType: string,
  correctionFactor: number = 40
): InsulinBGImpact {
  const profile = getInsulinProfile(insulinType);

  if (!profile) {
    console.warn(`No profile found for insulin type: ${insulinType}`);
    return {
      bgReduction: 0,
      pendingReduction: 0,
      totalExpectedReduction: 0,
      absorbedInsulin: 0,
      activeInsulin: 0,
      iob: 0,
      activity: 0,
      absorbedFraction: 0,
      absorbedPercent: 0,
      hoursSinceDose: 0,
      isActive: false,
      profile: {
        onset: 0,
        peak: 0,
        duration: 0,
        type: 'rapid_acting',
        is_peakless: false,
      },
    };
  }

  // Before onset - no effect yet
  if (hoursSinceDose < 0) {
    return {
      bgReduction: 0,
      pendingReduction: initialDose * correctionFactor, // All insulin is pending
      totalExpectedReduction: initialDose * correctionFactor,
      absorbedInsulin: 0,
      activeInsulin: 0,
      iob: initialDose,
      activity: 0,
      absorbedFraction: 0,
      absorbedPercent: 0,
      hoursSinceDose: 0,
      isActive: false,
      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        type: profile.type,
        is_peakless: profile.is_peakless,
      },
    };
  }

  // After duration - all insulin has acted
  if (hoursSinceDose > profile.duration_hours) {
    const totalReduction = initialDose * correctionFactor;
    return {
      bgReduction: totalReduction, // All insulin has acted = full reduction
      pendingReduction: 0, // No pending reduction
      totalExpectedReduction: totalReduction,
      absorbedInsulin: initialDose, // All insulin absorbed
      activeInsulin: 0, // No currently active insulin
      iob: 0, // No insulin on board
      activity: 0, // No activity
      absorbedFraction: 1.0, // 100% absorbed
      absorbedPercent: 100,
      hoursSinceDose: Math.round(hoursSinceDose * 100) / 100,
      isActive: false,
      isComplete: true,
      profile: {
        onset: profile.onset_hours,
        peak: profile.peak_hours,
        duration: profile.duration_hours,
        type: profile.type,
        is_peakless: profile.is_peakless,
      },
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
    bgReduction: Math.round(bgReduction * 10) / 10, // CUMULATIVE reduction so far
    pendingReduction: Math.round(pendingReduction * 10) / 10, // Future reduction from IOB
    totalExpectedReduction: Math.round((bgReduction + pendingReduction) * 10) / 10,

    // Insulin amounts
    absorbedInsulin: Math.round(absorbedInsulin * 100) / 100, // Insulin that has acted
    activeInsulin: Math.round(activeInsulin * 100) / 100, // Currently working (instantaneous)
    iob: Math.round(iob * 100) / 100, // Remaining to act

    // Percentages
    activity: Math.round(activity * 10) / 10, // Current activity %
    absorbedFraction: Math.round(absorbedFraction * 100) / 100, // Fraction absorbed (0-1)
    absorbedPercent: Math.round(absorbedFraction * 100), // Percent absorbed

    // Timing
    hoursSinceDose: Math.round(hoursSinceDose * 100) / 100,
    isActive: true,

    // Profile info
    profile: {
      onset: profile.onset_hours,
      peak: profile.peak_hours,
      duration: profile.duration_hours,
      type: profile.type,
      is_peakless: profile.is_peakless,
    },
  };
}

/**
 * Generate time-series data for visualization
 *
 * Creates data points at regular intervals showing insulin activity,
 * IOB, and BG impact over time for multiple doses.
 *
 * @param doses - Array of dose objects with timing
 * @param timeWindowMinutes - Total time to simulate (default: 720 = 12h)
 * @param intervalMinutes - Time step for data points (default: 5)
 * @param correctionFactor - BG impact per unit (default: 50)
 * @returns Time-series data points
 */
export function generateInsulinTimeSeries(
  doses: InsulinDoseWithTiming[],
  timeWindowMinutes: number = 720,
  intervalMinutes: number = 5,
  correctionFactor: number = 40
): InsulinTimeSeriesPoint[] {
  const timePoints: InsulinTimeSeriesPoint[] = [];

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hoursSinceStart = t / 60;

    let totalActivity = 0;
    let totalIOB = 0;
    let totalBGImpact = 0;
    const activeDoses: Array<{
      name: string;
      insulinType: string;
      activity: number;
      iob: number;
      activeUnits: number;
      bgImpact: number;
    }> = [];

    doses.forEach((dose) => {
      const profile = getInsulinPharmacokinetics(dose.insulinType);
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
            bgImpact: Math.round(bgImpact * 10) / 10,
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
      isStacking: activeDoses.length > 1,
    });
  }

  return timePoints;
}

/**
 * Generate BG-centric time series showing insulin's blood glucose impact
 *
 * This mirrors meal time series but shows BG reduction from insulin.
 * Shows baseline BG, current BG with insulin effect, and projected final BG.
 *
 * @param doses - Insulin doses with timeMinutes offset
 * @param baselineBG - Starting blood glucose (default: 250)
 * @param timeWindowMinutes - Simulation duration (default: 480 = 8h)
 * @param intervalMinutes - Time step (default: 5)
 * @param correctionFactor - BG impact per unit (default: 50)
 * @returns Time-series data points with BG values
 */
export function generateInsulinBGTimeSeries(
  doses: InsulinDoseWithTiming[],
  baselineBG: number = 250,
  timeWindowMinutes: number = 480,
  intervalMinutes: number = 5,
  correctionFactor: number = 40
): InsulinBGTimeSeriesPoint[] {
  const timePoints: InsulinBGTimeSeriesPoint[] = [];

  for (let t = 0; t <= timeWindowMinutes; t += intervalMinutes) {
    const hours = t / 60;

    let totalBGReduction = 0;
    let totalPendingReduction = 0;
    let totalActiveInsulin = 0;
    let totalIOB = 0;
    let totalActivity = 0;
    const activeDoses: Array<{
      name: string;
      insulinType: string;
      activity: number;
      activeInsulin: number;
      iob: number;
      bgReduction: number;
      pendingReduction: number;
    }> = [];

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
        pendingReduction: impact.pendingReduction,
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
      totalBGReduction: Math.round(totalBGReduction * 10) / 10, // Current drop
      totalPendingReduction: Math.round(totalPendingReduction * 10) / 10, // Future drop

      // Insulin amounts
      totalActiveInsulin: Math.round(totalActiveInsulin * 100) / 100,
      totalIOB: Math.round(totalIOB * 100) / 100,
      totalActivity: Math.round(totalActivity * 10) / 10,

      // Active doses details
      activeDoses: activeDoses,
      isStacking: activeDoses.length > 1,
    });
  }

  return timePoints;
}

/**
 * Calculate time to peak activity for insulin
 *
 * @param insulinType - Type of insulin
 * @returns Hours to peak activity (0 if not found)
 */
export function getInsulinTimeToPeak(insulinType: string): number {
  const profile = getInsulinProfile(insulinType);
  return profile ? profile.peak_hours : 0;
}

/**
 * Calculate duration of action for insulin
 *
 * @param insulinType - Type of insulin
 * @returns Total duration in hours (0 if not found)
 */
export function getInsulinDuration(insulinType: string): number {
  const profile = getInsulinProfile(insulinType);
  return profile ? profile.duration_hours : 0;
}

/**
 * Check if insulin is still active at a given time
 *
 * @param hoursSinceDose - Hours since administration
 * @param insulinType - Type of insulin
 * @returns True if still active
 */
export function isInsulinActive(hoursSinceDose: number, insulinType: string): boolean {
  const profile = getInsulinProfile(insulinType);
  return isEffectActive(hoursSinceDose, profile);
}

/**
 * ============================================================================
 * UI UTILITY FUNCTIONS
 * ============================================================================
 */

/**
 * Insulin type for UI display
 */
export interface InsulinTypeOption {
  /** Insulin type identifier */
  id: string;
  /** Formatted name */
  name: string;
  /** Display name with action type */
  displayName: string;
  /** Action type */
  type: InsulinActionType;
  /** Onset hours */
  onset_hours: number;
  /** Peak hours */
  peak_hours: number | null;
  /** Duration hours */
  duration_hours: number;
  /** Is peakless */
  is_peakless: boolean;
}

/**
 * Get all available insulin types for UI dropdowns
 * Filters and formats insulin types from constants
 *
 * @returns Sorted array of insulin type objects
 */
export function getAvailableInsulinTypes(): InsulinTypeOption[] {
  return Object.entries(ALL_INSULIN_PROFILES)
    .map(([key, value]) => ({
      id: key,
      name: key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
      displayName: `${key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())} (${
        value.type.split('_')[0]
      } acting)`,
      type: value.type,
      onset_hours: value.onset_hours,
      peak_hours: value.peak_hours,
      duration_hours: value.duration_hours,
      is_peakless: value.is_peakless,
    }))
    .sort((a, b) => {
      // Sort by action type: rapid, short, intermediate, long, mixed
      const typeOrder: Record<string, number> = {
        rapid: 1,
        short: 2,
        intermediate: 3,
        long: 4,
        mixed: 5,
      };

      const typeA = a.type.split('_')[0];
      const typeB = b.type.split('_')[0];

      return (typeOrder[typeA] || 99) - (typeOrder[typeB] || 99);
    });
}

/**
 * Format insulin name for display
 * Converts snake_case to Title Case and adds action type
 *
 * @param insulinType - Insulin type identifier (e.g., 'insulin_lispro')
 * @returns Formatted display name
 */
export function formatInsulinName(insulinType: string): string {
  if (!insulinType) return '';

  const insulin = ALL_INSULIN_PROFILES[insulinType];
  if (!insulin) {
    return insulinType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  }

  return `${insulinType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())} (${
    insulin.type.split('_')[0]
  } acting)`;
}

/**
 * Group insulin types by action profile (rapid/short/intermediate/long)
 * Useful for categorized UI displays
 *
 * @returns Insulin types grouped by category
 */
export function getInsulinTypesByCategory(): Record<string, InsulinTypeOption[]> {
  const insulinTypes = getAvailableInsulinTypes();

  return insulinTypes.reduce((acc, insulin) => {
    const category = insulin.type.split('_')[0];
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(insulin);
    return acc;
  }, {} as Record<string, InsulinTypeOption[]>);
}

/**
 * Recommend optimal insulin type based on meal context
 * Considers food absorption speed, meal timing, and time of day
 *
 * @param mealType - Type of meal ('breakfast', 'lunch', 'dinner', 'snack')
 * @param foods - Array of food items with absorption_type in details
 * @param currentTime - Current time (default: now)
 * @returns Recommended insulin type identifier
 */
export function recommendInsulinType(
  mealType: string,
  foods: FoodItem[],
  currentTime?: Date | number
): string {
  // Get hour of day (0-23)
  const hour = new Date(currentTime || Date.now()).getHours();

  // Default to regular insulin
  let recommended = 'regular_insulin';

  // Check if any food has very fast absorption
  const hasFastFood = foods.some(
    (food) =>
      food.details.absorption_type === 'very_fast' ||
      food.details.absorption_type === 'fast'
  );

  // Check if any food has very slow absorption
  const hasSlowFood = foods.some(
    (food) =>
      food.details.absorption_type === 'very_slow' ||
      food.details.absorption_type === 'slow'
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
  const mealTypeRecommendations: Record<string, string> = {
    breakfast: 'insulin_lispro',
    lunch: 'insulin_aspart',
    dinner: 'insulin_glulisine',
    snack: 'insulin_aspart',
  };

  return mealTypeRecommendations[mealType] || recommended;
}

/**
 * ============================================================================
 * NON-INSULIN MEDICATION EFFECTS
 * ============================================================================
 */

/**
 * Calculate non-insulin medication effect based on time since last dose
 * Handles medications like Metformin, GLP-1 agonists, SGLT2 inhibitors
 *
 * @param medication - Medication identifier
 * @param medData - Medication parameters
 * @param schedule - Schedule with startDate, endDate, dailyTimes
 * @param currentTime - Current time to calculate effect for
 * @returns Effect data
 */
export function calculateMedicationEffect(
  medication: string,
  medData: MedicationData | null | undefined,
  schedule: MedicationSchedule | null | undefined,
  currentTime: Date = new Date()
): MedicationEffect {
  if (!medData) return { status: 'Unknown', factor: 1.0 };

  if (medData.duration_based && schedule) {
    const startDate = new Date(schedule.startDate);
    const endDate = new Date(schedule.endDate);

    // Check schedule validity
    if (currentTime < startDate) {
      return {
        status: 'Scheduled to start',
        startDate: startDate.toLocaleDateString(),
        factor: 1.0,
      };
    }

    if (currentTime > endDate) {
      return {
        status: 'Schedule ended',
        endDate: endDate.toLocaleDateString(),
        factor: 1.0,
      };
    }

    // Find last dose time
    const lastDoseTime = findLastDoseTime(schedule.dailyTimes, currentTime);
    const hoursSinceLastDose = (currentTime.getTime() - lastDoseTime.getTime()) / (1000 * 60 * 60);

    // Calculate effect based on medication phase
    if (
      medData.onset_hours !== undefined &&
      hoursSinceLastDose < medData.onset_hours
    ) {
      return {
        status: 'Ramping up',
        factor:
          1.0 +
          (medData.factor - 1.0) * (hoursSinceLastDose / medData.onset_hours),
        lastDose: lastDoseTime.toLocaleString(),
        hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10,
      };
    } else if (
      medData.peak_hours !== undefined &&
      hoursSinceLastDose < medData.peak_hours
    ) {
      return {
        status: 'Peak effect',
        factor: medData.factor,
        lastDose: lastDoseTime.toLocaleString(),
        hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10,
      };
    } else if (
      medData.duration_hours !== undefined &&
      hoursSinceLastDose < medData.duration_hours
    ) {
      const remainingEffect =
        (medData.duration_hours - hoursSinceLastDose) /
        (medData.duration_hours - (medData.peak_hours || 0));
      return {
        status: 'Tapering',
        factor: 1.0 + (medData.factor - 1.0) * remainingEffect,
        lastDose: lastDoseTime.toLocaleString(),
        hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10,
      };
    }

    return {
      status: 'No current effect',
      factor: 1.0,
      lastDose: lastDoseTime.toLocaleString(),
      hoursSinceLastDose: Math.round(hoursSinceLastDose * 10) / 10,
    };
  }

  // Non-duration based medications (constant effect)
  return {
    status: 'Constant effect',
    factor: medData.factor || 1.0,
  };
}

/**
 * Find the last dose time based on daily schedule
 * Helper function for calculateMedicationEffect
 *
 * @param dailyTimes - List of daily time strings (HH:MM format)
 * @param currentTime - Current reference time
 * @returns Last dose time
 */
export function findLastDoseTime(
  dailyTimes: string[],
  currentTime: Date = new Date()
): Date {
  // Convert daily times to Date objects for the current or previous day
  const doseTimes = dailyTimes.map((time) => {
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

  return doseTimes.sort((a, b) => b.getTime() - a.getTime())[0];
}