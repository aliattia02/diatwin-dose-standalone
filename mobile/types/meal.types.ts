/**
 * Meal and food type definitions for NATIVE diabetes management platform
 * @module types/meal
 */

/**
 * Meal type classification
 */
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/**
 * Absorption type classification based on food composition
 * Affects the rate at which nutrients impact blood glucose
 */
export type AbsorptionType = 'very_fast' | 'fast' | 'medium' | 'slow' | 'very_slow';

/**
 * Measurement type for food portions
 */
export type MeasurementType = 'volume' | 'weight';

/**
 * Serving size definition matching backend structure
 */
export interface ServingSize {
  /** Volume amount */
  amount?: number;
  /** Volume unit */
  unit?: string;
  /** Weight amount */
  w_amount?: number;
  /** Weight unit */
  w_unit?: string;
  /** Display name */
  display_name?: string;
}

/**
 * Food item from the food database
 */
export interface FoodItem {
  /** Unique identifier */
  id: string;
  /** Food name */
  name: string;
  /** Food category */
  category: string;
  /** Carbohydrates per serving in grams */
  carbs: number;
  /** Protein per serving in grams */
  protein: number;
  /** Fat per serving in grams */
  fat: number;
  /** Fiber per serving in grams */
  fiber?: number;
  /** Calories per serving */
  calories?: number;
  /** Glycemic index (0-100) */
  glycemicIndex?: number;
  /** Absorption type */
  absorption_type: AbsorptionType;
  /** Serving size information */
  serving_size: ServingSize;
  /** Whether this is a custom food item */
  isCustom?: boolean;
}

/**
 * Food entry within a meal
 */
export interface MealFoodEntry {
  /** Reference to food item */
  foodId: string;
  /** Food item name */
  name: string;
  /** Portion information */
  portion: {
    /** Amount */
    amount: number;
    /** Unit */
    unit: string;
    /** Active measurement type */
    activeMeasurement: MeasurementType;
    /** Weight amount (if weight-based) */
    w_amount?: number;
    /** Weight unit (if weight-based) */
    w_unit?: string;
  };
  /** Full food item details */
  details: FoodItem;
}

/**
 * Calculated nutrition totals for a meal
 */
export interface MealNutrition {
  /** Total carbohydrates in grams */
  totalCarbs: number;
  /** Alternative accessor for carbs */
  carbs?: number;
  /** Total protein in grams */
  totalProtein: number;
  /** Alternative accessor for protein */
  protein?: number;
  /** Total fat in grams */
  totalFat: number;
  /** Alternative accessor for fat */
  fat?: number;
  /** Total fiber in grams */
  fiber?: number;
  /** Total calories */
  calories?: number;
  /** Total carbohydrate equivalents (including protein/fat conversion) */
  totalCarbEquiv?: number;
  /** Weighted absorption type for the meal */
  absorptionType?: AbsorptionType;
  /** Alternative accessor for absorption type */
  absorption_type?: AbsorptionType;
}

/**
 * Complete meal record
 */
export interface Meal {
  /** Unique identifier */
  id: string;
  /** User ID who created this meal */
  userId: string;
  /** Type of meal */
  mealType: MealType;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Food items in the meal */
  foodItems: MealFoodEntry[];
  /** Calculated nutrition totals */
  nutrition: MealNutrition;
  /** Associated insulin dose ID */
  insulinDoseId?: string;
  /** Notes about the meal */
  notes?: string;
  /** Calculation summary from backend */
  calculation_summary?: {
    base_insulin: number;
    adjustment_factors: {
      absorption_rate: number;
      meal_timing: number;
    };
    meal_only_suggested_insulin: number;
    absorption_type: AbsorptionType;
    /** Total carbohydrate equivalents (carbs + protein*factor + fat*factor) */
    total_carb_equiv?: number;
    absorption_metadata?: {
      weighted_type: AbsorptionType;
      patient_modifier: number;
      original_factor: number;
    };
  };
  /** Creation timestamp */
  createdAt?: string;
  /** Last update timestamp */
  updatedAt?: string;
}

/**
 * Point on a meal impact curve for visualization
 */
export interface MealImpactCurvePoint {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Minutes since meal consumption */
  minutesSinceMeal: number;
  /** Hours since meal consumption */
  hoursSinceMeal: number;
  /** Impact value (carb equivalents active at this time) */
  impactValue: number;
  /** Blood glucose impact in mg/dL */
  bgImpact: number;
  /** Absorption type */
  absorptionType: AbsorptionType;
  /** Absorption profile information */
  profile: {
    onset: number;
    peak: number;
    plateauEnd: number;
    duration: number;
    description: string;
  };
}

/**
 * Result of carbohydrate equivalents calculation
 */
export interface CarbEquivalentsResult {
  /** Total carbohydrate equivalents */
  totalCarbEquiv: number;
  /** Actual carbohydrates in grams */
  carbsActual: number;
  /** Protein converted to carb equivalents */
  proteinCarbEquiv: number;
  /** Fat converted to carb equivalents */
  fatCarbEquiv: number;
  /** Fiber reduction from carb equivalents */
  fiberReduction: number;
}

/**
 * Absorption profile for meal impact calculations
 */
export interface AbsorptionProfile {
  /** Minutes until absorption begins */
  onsetMinutes: number;
  /** Minutes until peak absorption */
  peakMinutes: number;
  /** Minutes of plateau at peak */
  plateauMinutes: number;
  /** Total duration in hours */
  durationHours: number;
  /** Shape parameter for rise phase */
  riseShape: number;
  /** Shape parameter for fall phase */
  fallShape: number;
  /** Width of peak as fraction of duration */
  peakWidth: number;
  /** Human-readable description */
  description: string;
}
