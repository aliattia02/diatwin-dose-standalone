/**
 * Calculation type definitions for NATIVE diabetes management platform
 * Includes net effect calculations, BG estimation, and timeline generation
 * @module types/calculation
 */

import type { SafetyStatusLevel, GlucoseTrend } from './safety.types';

/**
 * Net effect calculation result
 * Combines insulin and meal effects for blood glucose prediction
 */
export interface NetEffectResult {
  /** Current net effect in mg/dL per hour */
  currentNetEffect: number;
  /** Cumulative baseline effect (persists after absorption) */
  cumulativeBaseline: number;
  /** Estimated current blood glucose in mg/dL */
  estimatedBG: number;
  /** Projected final blood glucose in mg/dL */
  projectedFinalBG: number;
  /** Active insulin effect in mg/dL per hour */
  activeInsulinEffect: number;
  /** Active meal effect in mg/dL per hour */
  activeMealEffect: number;
  /** Total insulin on board in units */
  totalIOB: number;
  /** Total meal on board in carb equivalents */
  totalMOB: number;
  /** Safety status assessment */
  safetyStatus: SafetyStatusLevel;
  /** Timestamp of calculation */
  timestamp: number;
  /** Trend direction */
  trend?: GlucoseTrend;
  /** Baseline value used */
  baseline?: number;
  /** Cumulative meal effect */
  cumulativeMealEffect?: number;
  /** Cumulative insulin effect */
  cumulativeInsulinEffect?: number;
  /** Individual meal contributions */
  mealContributions?: Array<any>;
  /** Individual insulin contributions */
  insulinContributions?: Array<any>;
}

/**
 * Blood glucose estimation
 */
export interface BGEstimation {
  /** Estimated blood glucose in mg/dL */
  estimatedBG: number;
  /** Confidence level (0-1) */
  confidence: number;
  /** Whether based on a recent reading */
  basedOnReading: boolean;
  /** Age of most recent reading in minutes */
  readingAge: number;
  /** Blood glucose velocity in mg/dL per minute */
  velocity: number;
  /** Timestamp of estimation */
  timestamp: number;
  /** Method used for estimation */
  method: 'reading' | 'interpolation' | 'extrapolation' | 'baseline';
}

/**
 * Detailed effects breakdown for timeline
 */
export interface DetailedEffects {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Insulin effect in mg/dL per hour */
  insulinEffect: number;
  /** Meal effect in mg/dL per hour */
  mealEffect: number;
  /** Net effect (meal - insulin) in mg/dL per hour */
  netEffect: number;
  /** Cumulative baseline */
  cumulativeBaseline: number;
  /** Estimated BG in mg/dL */
  estimatedBG: number;
  /** Insulin on board in units */
  iob: number;
  /** Meal on board in carb equivalents */
  mob: number;
  /** Individual insulin contributions */
  insulinContributions: Array<{
    doseId: string;
    effect: number;
    iob: number;
  }>;
  /** Individual meal contributions */
  mealContributions: Array<{
    mealId: string;
    effect: number;
    mob: number;
  }>;
}

/**
 * Timeline point for visualization
 */
export interface TimelinePoint {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Hours from reference time */
  hoursFromReference: number;
  /** Estimated blood glucose */
  glucose: number;
  /** Insulin effect */
  insulinEffect: number;
  /** Meal effect */
  mealEffect: number;
  /** Net effect */
  netEffect: number;
  /** IOB */
  iob: number;
  /** MOB */
  mob: number;
  /** Cumulative baseline */
  cumulativeBaseline?: number;
}

/**
 * Blood glucose trajectory prediction
 */
export interface BGTrajectory {
  /** Starting blood glucose */
  startingBG: number;
  /** Array of predicted BG values over time */
  predictions: Array<{
    timestamp: number;
    glucose: number;
    confidence: number;
  }>;
  /** Expected final blood glucose */
  finalBG: number;
  /** Expected nadir (lowest point) */
  nadir: {
    value: number;
    timestamp: number;
  };
  /** Expected peak (highest point) */
  peak: {
    value: number;
    timestamp: number;
  };
  /** Time to stable state in hours */
  timeToStable: number;
}

/**
 * Calculation options/parameters
 */
export interface CalculationOptions {
  /** Current time in milliseconds */
  currentTime: number;
  /** Lookback period for insulin in hours */
  insulinLookbackHours?: number;
  /** Lookback period for meals in hours */
  mealLookbackHours?: number;
  /** Whether to include cumulative baseline */
  includeCumulativeBaseline?: boolean;
  /** Daily reset time (7 AM) in milliseconds */
  dailyResetTime?: number;
  /** Patient-specific correction factor */
  correctionFactor?: number;
  /** Patient-specific carb ratio */
  carbRatio?: number;
}

/**
 * Input for net effect calculation
 */
export interface NetEffectInput {
  /** Current time */
  currentTime: number;
  /** Most recent BG reading */
  recentBG?: {
    value: number;
    timestamp: number;
  };
  /** Array of insulin doses */
  insulinDoses: Array<{
    id: string;
    type: string;
    dose: number;
    timestamp: number;
  }>;
  /** Array of meals */
  meals: Array<{
    id: string;
    carbEquivalents: number;
    absorptionType: string;
    timestamp: number;
  }>;
  /** Calculation options */
  options?: CalculationOptions;
}

/**
 * Glucose velocity calculation
 */
export interface GlucoseVelocity {
  /** Velocity in mg/dL per minute */
  velocity: number;
  /** Velocity in mg/dL per hour */
  velocityPerHour: number;
  /** Acceleration in mg/dL per minute squared */
  acceleration?: number;
  /** Trend classification */
  trend: GlucoseTrend;
  /** Confidence in velocity estimate (0-1) */
  confidence: number;
  /** Time window used for calculation in minutes */
  timeWindow: number;
}

/**
 * Baseline calculation result
 * This matches the actual return type from calculateStableBaselineFromReading()
 */
export interface BaselineResult {
  /** Stable baseline blood glucose in mg/dL */
  stableBaseline: number;
  /** Original reading value in mg/dL */
  readingValue: number;
  /** Timestamp of the reading (ISO string) */
  readingTimestamp: string;
  /** Cumulative meal effect at reading time in mg/dL (always >= 0) */
  cumulativeMealEffect: number;
  /**
   * Cumulative insulin effect at reading time in mg/dL.
   *
   * ⚠ SIGN CONVENTION (unique to BaselineResult):
   * Stored as a POSITIVE number — the magnitude of BG reduction.
   * This is the opposite of `CumulativeEffectsResult.cumulativeInsulinEffect`,
   * which is stored as a NEGATIVE number (already signed for addition).
   *
   * Use:  stableBaseline = readingValue − cumulativeMealEffect + cumulativeInsulinEffect
   *   or: stableBaseline = readingValue − cumulativeNetEffect
   * Do NOT negate this field again before using it.
   */
  cumulativeInsulinEffect: number;
  /**
   * Net cumulative BG displacement at reading time: cumulativeMealEffect − cumulativeInsulinEffect.
   *
   * ⚠ SIGN CONVENTION (unique to BaselineResult):
   * Both operands are stored as positive magnitudes in this type, so the net
   * is computed as meal − insulin (subtraction), giving a signed result.
   * Contrast with `CumulativeEffectsResult.cumulativeNetBaseline`, which is
   * computed as meal + insulin where insulin is already negative (addition).
   *
   * Use:  stableBaseline = readingValue − cumulativeNetEffect
   */
  cumulativeNetEffect: number;
  /** Meals that were active at reading time */
  mealsAtReading: Array<{
    mealId: string;
    mealType?: string;
    totalCarbs: number;
    absorbedCarbs: number;
    bgEffect: number;
    absorbedFraction: number;
  }>;
  /** Insulin doses that were active at reading time */
  insulinAtReading: Array<{
    doseId: string;
    medication?: string;
    dose: number;
    absorbedInsulin: number;
    bgEffect: number;
    absorbedFraction: number;
  }>;
  /** Number of active meals */
  mealsCount: number;
  /** Number of active insulin doses */
  insulinCount: number;
  /** Optional confidence in baseline (0-1) */
  confidence?: number;
  /** Optional warnings about baseline calculation */
  warnings?: string[];
}

/**
 * Smart interpolation result
 */
export interface InterpolationResult {
  /** Interpolated value */
  value: number;
  /** Confidence in interpolation (0-1) */
  confidence: number;
  /** Method used */
  method: 'linear' | 'quadratic' | 'spline' | 'velocity-based';
  /** Gap size in minutes */
  gapSize: number;
}

/**
 * Validation metrics result
 */
export interface ValidationMetrics {
  /** Mean Absolute Error */
  mae: number;
  /** Mean Absolute Relative Difference (%) */
  mard: number;
  /** Root Mean Square Error */
  rmse: number;
  /** Clarke Error Grid zones */
  clarkeGrid?: {
    zoneA: number;
    zoneB: number;
    zoneC: number;
    zoneD: number;
    zoneE: number;
  };
  /** Number of pairs analyzed */
  pairCount: number;
}

/**
 * Time series data point
 */
export interface TimeSeriesPoint {
  /** Timestamp */
  timestamp: number;
  /** Value */
  value: number;
  /** Optional label */
  label?: string;
  /** Optional metadata */
  metadata?: Record<string, any>;
}

/**
 * Chart data preparation result
 */
export interface ChartData {
  /** X-axis data (timestamps or hours) */
  xData: number[];
  /** Y-axis data (glucose or effects) */
  yData: number[];
  /** Labels for data points */
  labels?: string[];
  /** Data series metadata */
  metadata?: {
    min: number;
    max: number;
    mean: number;
    unit: string;
  };
}