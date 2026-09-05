/**
 * Glucose type definitions for NATIVE diabetes management platform
 * @module types/glucose
 */

/**
 * Blood glucose status classification
 */
export type GlucoseStatus = 'low' | 'normal' | 'high';

/**
 * Source of glucose reading
 */
export type GlucoseSource = 'manual' | 'cgm' | 'meter' | 'lab';

/**
 * Blood glucose reading record
 */
export interface GlucoseReading {
  /** Unique identifier */
  id: string;
  /** User ID who recorded this reading */
  userId: string;
  /** Blood glucose value in mg/dL */
  value: number;
  /** Timestamp of the reading (ISO 8601 format) */
  timestamp: string;
  /** Status classification */
  status: GlucoseStatus;
  /** Source of the reading */
  source: GlucoseSource;
  /** Optional notes */
  notes?: string;
  /** Creation timestamp */
  createdAt?: string;
}

/**
 * Target glucose range for a patient
 */
export interface GlucoseRange {
  /** Minimum target value in mg/dL */
  min: number;
  /** Maximum target value in mg/dL */
  max: number;
  /** Target center value in mg/dL */
  target: number;
  /** Label for this range (e.g., "Pre-meal", "Post-meal") */
  label?: string;
}

/**
 * Time in range statistics
 */
export interface TimeInRange {
  /** Percentage of time below range */
  belowRange: number;
  /** Percentage of time in range */
  inRange: number;
  /** Percentage of time above range */
  aboveRange: number;
  /** Time period in hours */
  periodHours: number;
  /** Number of readings in this period */
  readingCount: number;
}

/**
 * Glucose statistics for a time period
 */
export interface GlucoseStatistics {
  /** Mean glucose value */
  mean: number;
  /** Median glucose value */
  median: number;
  /** Standard deviation */
  standardDeviation: number;
  /** Coefficient of variation (CV) */
  coefficientOfVariation: number;
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Time in range statistics */
  timeInRange: TimeInRange;
  /** Estimated A1C (if sufficient data) */
  estimatedA1C?: number;
  /** Number of readings */
  readingCount: number;
  /** Time period start */
  periodStart: string;
  /** Time period end */
  periodEnd: string;
}

/**
 * Glucose trend direction
 */
export type GlucoseTrend = 
  | 'rising_rapidly'    // > 3 mg/dL per minute
  | 'rising'            // 1-3 mg/dL per minute
  | 'stable'            // < 1 mg/dL per minute change
  | 'falling'           // 1-3 mg/dL per minute
  | 'falling_rapidly';  // > 3 mg/dL per minute

/**
 * Continuous glucose monitor (CGM) reading with trend
 */
export interface CGMReading extends GlucoseReading {
  source: 'cgm';
  /** Current trend direction */
  trend?: GlucoseTrend;
  /** Rate of change in mg/dL per minute */
  rateOfChange?: number;
  /** Sensor session ID */
  sensorSessionId?: string;
}
