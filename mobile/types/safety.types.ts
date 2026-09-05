/**
 * Safety and risk assessment type definitions for NATIVE diabetes management platform
 * Includes stacking analysis, hypoglycemia/hyperglycemia risk, and safety validation
 * @module types/safety
 */

// ✅ ADDED - Simple safety status type for BG calculations
export type SafetyStatusLevel =
  | 'critical_low'
  | 'hypoglycemia_risk'
  | 'acceptable'
  | 'optimal'
  | 'hyperglycemia_risk'
  | 'critical_high';

// ✅ ADDED - Extended glucose trend with all 7 values for pharmacodynamic calculations
export type GlucoseTrend =
  | 'rising_rapidly'
  | 'rising'
  | 'rising_slightly'
  | 'stable'
  | 'falling_slightly'
  | 'falling'
  | 'falling_rapidly';

/**
 * Safety level classification
 */
export type SafetyLevel = 'normal' | 'moderate' | 'high' | 'critical';

/**
 * Risk level classification
 */
export type RiskLevel = 'none' | 'low' | 'moderate' | 'high' | 'critical';

/**
 * Priority level for medical alerts
 */
export type PriorityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Safety status with warnings and recommendations
 */
export interface SafetyStatus {
  /** Overall safety level */
  level: SafetyLevel;
  /** Array of warning messages */
  warnings: string[];
  /** Array of recommended actions */
  recommendations: string[];
  /** Detailed risk assessments */
  risks?: {
    hypoglycemia?: RiskLevel;
    hyperglycemia?: RiskLevel;
    stacking?: RiskLevel;
  };
}

/**
 * Insulin stacking analysis result
 */
export interface InsulinStackingAnalysis {
  /** Whether stacking is detected */
  isStacking: boolean;
  /** Percentage of doses that overlap (0-100) */
  overlapPercentage: number;
  /** Risk level of stacking */
  riskLevel: RiskLevel;
  /** Number of active doses */
  activeDoses: number;
  /** Total insulin on board */
  totalIOB: number;
  /** Peak overlap time if stacking occurs */
  peakOverlapTime?: number;
  /** Peak combined activity */
  peakCombinedActivity?: number;
  /** Safety warnings */
  warnings: string[];
  /** Recommended actions */
  recommendations: string[];
}

/**
 * Meal stacking analysis result
 */
export interface MealStackingAnalysis {
  /** Whether meal stacking is detected */
  isStacking: boolean;
  /** Percentage of meals that overlap (0-100) */
  overlapPercentage: number;
  /** Risk level of stacking */
  riskLevel: RiskLevel;
  /** Number of active meals */
  activeMeals: number;
  /** Total meal on board */
  totalMOB: number;
  /** Peak overlap time if stacking occurs */
  peakOverlapTime?: number;
  /** Peak combined activity */
  peakCombinedActivity?: number;
  /** Safety warnings */
  warnings: string[];
  /** Recommended actions */
  recommendations: string[];
}

/**
 * Hypoglycemia risk assessment
 */
export interface HypoglycemiaRisk {
  /** Overall risk level */
  riskLevel: RiskLevel;
  /** Estimated time to hypoglycemia in hours (if at risk) */
  estimatedTimeToHypoglycemia?: number;
  /** Predicted nadir blood glucose */
  predictedNadir?: number;
  /** Contributing factors */
  factors: {
    /** High IOB contributing to risk */
    highIOB?: boolean;
    /** Rapid falling trend */
    rapidFallingTrend?: boolean;
    /** Recent exercise */
    recentExercise?: boolean;
    /** Time of day factor */
    timeOfDay?: string;
  };
  /** Risk score (0-100) */
  riskScore: number;
  /** Warnings */
  warnings: string[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * Hyperglycemia risk assessment
 */
export interface HyperglycemiaRisk {
  /** Overall risk level */
  riskLevel: RiskLevel;
  /** Estimated time to hyperglycemia in hours (if at risk) */
  estimatedTimeToHyperglycemia?: number;
  /** Predicted peak blood glucose */
  predictedPeak?: number;
  /** Contributing factors */
  factors: {
    /** High MOB contributing to risk */
    highMOB?: boolean;
    /** Rapid rising trend */
    rapidRisingTrend?: boolean;
    /** Insufficient insulin */
    insufficientInsulin?: boolean;
    /** Large meal */
    largeMeal?: boolean;
  };
  /** Risk score (0-100) */
  riskScore: number;
  /** Warnings */
  warnings: string[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * Safety check result for dosing decisions
 */
export interface DosingSafetyCheck {
  /** Whether the dose is safe */
  isSafe: boolean;
  /** Safety level */
  safetyLevel: SafetyLevel;
  /** Maximum safe dose in units */
  maxSafeDose?: number;
  /** Reasons for safety concern */
  concerns: string[];
  /** Warnings */
  warnings: string[];
  /** Recommendations */
  recommendations: string[];
  /** Detailed checks */
  checks: {
    /** IOB within safe limits */
    iobSafe: boolean;
    /** No dangerous stacking */
    stackingSafe: boolean;
    /** Recent BG readings available */
    recentReadingAvailable: boolean;
    /** Not in hypoglycemic range */
    notHypoglycemic: boolean;
  };
}

/**
 * Comprehensive safety assessment
 */
export interface ComprehensiveSafetyAssessment {
  /** Overall safety status */
  overallStatus: SafetyStatus;
  /** Insulin stacking analysis */
  insulinStacking?: InsulinStackingAnalysis;
  /** Meal stacking analysis */
  mealStacking?: MealStackingAnalysis;
  /** Hypoglycemia risk */
  hypoglycemiaRisk?: HypoglycemiaRisk;
  /** Hyperglycemia risk */
  hyperglycemiaRisk?: HyperglycemiaRisk;
  /** Dosing safety check */
  dosingSafety?: DosingSafetyCheck;
  /** Timestamp of assessment */
  assessmentTime: number;
  /** All warnings combined */
  allWarnings: string[];
  /** All recommendations combined */
  allRecommendations: string[];
}

/**
 * SMBG (Self-Monitoring Blood Glucose) reading priority
 */
export interface SMBGPriority {
  /** Priority level */
  priority: PriorityLevel;
  /** Priority score (0-100) */
  score: number;
  /** Reasons for priority level */
  reasons: string[];
}

/**
 * Counter-regulation response modeling
 */
export interface CounterRegulationResponse {
  /** Whether counter-regulation is active */
  isActive: boolean;
  /** Strength of counter-regulation (0-1) */
  strength: number;
  /** Blood glucose impact in mg/dL */
  bgImpact: number;
  /** Contributing hormones */
  hormones: {
    glucagon?: number;
    epinephrine?: number;
    cortisol?: number;
    growthHormone?: number;
  };
  /** Time to peak counter-regulation in hours */
  timeToPeak?: number;
}