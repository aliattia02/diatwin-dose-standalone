/**
 * Pharmacodynamics type definitions for NATIVE diabetes management platform
 * Covers insulin and meal absorption modeling using gamma distribution curves
 * @module types/pharmacodynamics
 *
 * TS-C-14: Removed pre-service-layer interfaces that are no longer referenced:
 *   GammaDistributionParams, IOBResult, MOBResult, InsulinActivityResult,
 *   MealActivityResult, PharmacodynamicTimelinePoint, StackedPharmacodynamicEffect.
 * These have been superseded by ActiveInsulinResult and MealOnBoardResult in
 * services/api/calculations.ts. Retained: PharmacodynamicProfile, ActivityCurvePoint,
 * ActivityCurveData (chart layer dependencies pending full scan).
 */

/**
 * Pharmacodynamic profile for insulin or meal absorption
 * Defines timing and curve characteristics
 */
export interface PharmacodynamicProfile {
  /** Time to onset in hours */
  onsetHours: number;
  /** Time to peak activity in hours */
  peakHours: number;
  /** Total duration of action in hours */
  durationHours: number;
  /** Type of curve used for modeling */
  curveType: string;
  /** Optional shape parameter for gamma distribution */
  shapeParam?: number;
  /** Optional scale parameter for gamma distribution */
  scaleParam?: number;
  /** Optional plateau duration for meal absorption */
  plateauHours?: number;
}

/**
 * Point on an activity curve (insulin or meal)
 * Represents activity at a specific time
 */
export interface ActivityCurvePoint {
  /** Time in hours since administration/consumption */
  time: number;
  /** Timestamp in milliseconds */
  timestamp?: number;
  /** Activity level (0-1) at this time */
  activity: number;
  /** Cumulative effect up to this time (0-1) */
  cumulativeEffect: number;
  /** Absorbed fraction up to this time (0-1) */
  absorbedFraction?: number;
}

/**
 * Activity curve data for visualization
 */
export interface ActivityCurveData {
  /** Array of curve points */
  points: ActivityCurvePoint[];
  /** Peak activity value */
  peakActivity: number;
  /** Time of peak activity in hours */
  peakTime: number;
  /** Total duration in hours */
  duration: number;
  /** Curve type identifier */
  curveType: string;
}