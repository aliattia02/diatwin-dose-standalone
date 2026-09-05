/**
 * Insulin type definitions for NATIVE diabetes management platform
 * Based on German S3 Guidelines "Therapie des Typ-1-Diabetes" Version 5.0
 * AWMF-Registry: 057-013
 * 
 * Reference: Diabetol Stoffwechs 2024; 19: S155–S166
 * DOI: 10.1055/a-2312-0276
 * 
 * @module types/insulin
 */

/**
 * Insulin action type based on S3 Guidelines classification
 */
export type InsulinActionType = 
  | 'rapid_acting' 
  | 'short_acting' 
  | 'intermediate_acting' 
  | 'long_acting' 
  | 'mixed';

/**
 * Insulin curve type for visualization - determines the mathematical model used
 */
export type InsulinCurveType = 
  | 'gamma_steep'        // Rapid-acting insulins
  | 'gamma_very_steep'   // Ultra-rapid insulins (Fiasp, Lyumjev)
  | 'gamma_broad'        // Short-acting (Regular)
  | 'gamma_wide'         // Intermediate-acting (NPH)
  | 'gamma_extended'     // Long-acting (Detemir)
  | 'sigmoid_plateau'    // Long-acting (Glargine U100)
  | 'sigmoid_extended'   // Long-acting (Glargine U300)
  | 'sigmoid_ultra_long'; // Ultra-long-acting (Degludec)

/**
 * Insulin profile based on S3 Guidelines Table 9
 * Contains pharmacokinetic parameters for insulin types
 */
export interface InsulinProfile {
  /** Unique identifier for the insulin profile */
  id: string;
  /** Display name of the insulin */
  name: string;
  /** Action type classification */
  type: InsulinActionType;
  /** Description of the insulin */
  description: string;
  /** Time to onset in hours */
  onsetHours: number;
  /** Time to peak activity in hours (null for peakless insulins) */
  peakHours: number | null;
  /** Total duration of action in hours */
  durationHours: number;
  /** Whether the insulin is peakless (primarily long-acting analogs) */
  isPeakless: boolean;
  /** Curve type for visualization */
  curveType: InsulinCurveType;
  /** Commercial brand names */
  brandNames: string[];
  /** Effect factor (multiplier for calculations) */
  factor: number;
}

/**
 * Insulin dose record
 */
export interface InsulinDose {
  /** Unique identifier for this dose record */
  id: string;
  /** Type of insulin administered */
  insulinType: string;
  /** Dose amount in units */
  dose: number;
  /** Administration timestamp (ISO 8601 format) */
  administrationTime: string;
  /** Backend timestamp field (snake_case from MongoDB) */
  taken_at?: string;
  /** Backend medication field name (instead of insulinType) */
  medication?: string;
  /** Associated meal ID if taken with food */
  mealId?: string;
  /** Blood glucose reading at time of dose */
  bloodGlucose?: number;
  /** Additional notes */
  notes?: string;
}

/**
 * Point on an insulin activity curve for visualization
 */
export interface InsulinActivityPoint {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Hours since dose administration */
  hoursSinceDose: number;
  /** Activity percentage (0-100) */
  activityPercent: number;
  /** Active insulin units at this time */
  activeUnits: number;
  /** Type of insulin */
  insulinType: string;
  /** Curve type classification */
  curveType: InsulinCurveType;
  /** Kurtosis type (leptokurtic, mesokurtic, platykurtic) */
  kurtosisType: 'leptokurtic' | 'mesokurtic' | 'platykurtic';
}

/**
 * Input parameters for insulin dose calculation
 */
export interface InsulinCalculationInput {
  /** Current blood glucose in mg/dL */
  currentBloodGlucose: number;
  /** Target blood glucose in mg/dL */
  targetBloodGlucose: number;
  /** Total carbohydrates in grams */
  carbs: number;
  /** Total protein in grams */
  protein?: number;
  /** Total fat in grams */
  fat?: number;
  /** Meal type */
  mealType?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  /** Activity level (-2 to 2) */
  activityLevel?: number;
  /** Insulin to carb ratio */
  insulinToCarbRatio: number;
  /** Correction factor (ISF) */
  correctionFactor: number;
  /** Protein factor for carb equivalents */
  proteinFactor?: number;
  /** Fat factor for carb equivalents */
  fatFactor?: number;
}

/**
 * Result of insulin dose calculation
 */
export interface InsulinCalculationResult {
  /** Total recommended dose in units */
  totalDose: number;
  /** Breakdown of dose components */
  breakdown: {
    /** Dose for carbohydrates */
    carbDose: number;
    /** Dose for correction */
    correctionDose: number;
    /** Dose for protein (if applicable) */
    proteinDose?: number;
    /** Dose for fat (if applicable) */
    fatDose?: number;
  };
  /** Factors applied to calculation */
  factors: {
    /** Meal timing factor applied */
    mealTimingFactor: number;
    /** Activity factor applied */
    activityFactor: number;
    /** Time of day factor applied */
    timeOfDayFactor: number;
  };
  /** Warnings or notes about the calculation */
  warnings: string[];
}

/**
 * Parameters for insulin pharmacokinetics from S3 Guidelines
 */
export interface InsulinPharmacokinetics {
  /** Time to onset in hours */
  onset_hours: number;
  /** Time to peak in hours */
  peak_hours: number;
  /** Total duration in hours */
  duration_hours: number;
  /** Action type */
  type: InsulinActionType;
  /** Whether insulin is peakless */
  is_peakless: boolean;
  /** Curve type for calculations */
  curve_type?: InsulinCurveType;
  /** Description */
  description?: string;
  /** Brand names */
  brand_names?: string[];
  /** Factor multiplier */
  factor?: number;
}