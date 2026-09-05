/**
 * Food-related type definitions for the mobile meal logging feature
 * Provides comprehensive types for food search, selection, and nutrient calculation
 * Location: mobile/types/food.ts
 */

import type { AbsorptionType, MeasurementType, ServingSize } from '../../shared/src/types';

/**
 * Measurement system type - 'volume' or 'weight'
 */
export type { MeasurementType };

/**
 * Re-export AbsorptionType from shared
 */
export type { AbsorptionType };

/**
 * Food item from the food database
 */
export interface Food {
  /** Unique identifier or name */
  id?: string;
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
  /** Full details object matching backend structure */
  details?: FoodDetails;
}

/**
 * Food category structure
 */
export interface FoodCategory {
  /** Category key */
  value: string;
  /** Display label */
  label: string;
}

/**
 * Food portion with dual measurement support (volume and weight)
 */
export interface FoodPortion {
  /** Volume amount */
  amount: number | null;
  /** Volume unit */
  unit: string | null;
  /** Weight amount */
  w_amount: number | null;
  /** Weight unit */
  w_unit: string | null;
  /** Currently active measurement type */
  activeMeasurement: MeasurementType;
  /** Base volume amount from serving size */
  baseAmount?: number;
  /** Base volume unit from serving size */
  baseUnit?: string;
  /** Base weight amount from serving size */
  baseWAmount?: number | null;
  /** Base weight unit from serving size */
  baseWUnit?: string | null;
}

/**
 * Food nutritional details matching backend structure
 */
export interface FoodDetails {
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
  /** Absorption type */
  absorption_type: AbsorptionType;
  /** Serving size information */
  serving_size: ServingSize;
  /** Glycemic index */
  glycemicIndex?: number;
}

/**
 * Selected food for meal - Food with portion information
 */
export interface SelectedFood {
  /** Unique ID for the selected food instance */
  id: number;
  /** Food name */
  name: string;
  /** Food category */
  category: string;
  /** Portion information */
  portion: FoodPortion;
  /** Full food details */
  details: FoodDetails;
}

/**
 * Custom food creation data
 */
export interface CustomFoodData {
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
  /** Absorption type */
  absorption_type?: AbsorptionType;
  /** Serving size */
  serving_size?: ServingSize;
}

/**
 * Calculated nutrients for a food item based on portion
 */
export interface CalculatedNutrients {
  /** Carbohydrates in grams */
  carbs: number;
  /** Protein in grams */
  protein: number;
  /** Fat in grams */
  fat: number;
  /** Absorption type */
  absorptionType: AbsorptionType;
}

/**
 * Measurement systems response from backend
 */
export interface MeasurementsResponse {
  /** Volume measurements */
  volume: Record<string, { ml: number; display_name: string }>;
  /** Weight measurements */
  weight: Record<string, { grams: number; display_name: string }>;
  /** Standard portions */
  standard_portions?: Record<string, unknown>;
}

/**
 * Categories response from backend
 */
export interface CategoriesResponse {
  /** Food categories */
  categories: Record<string, string[]>;
  /** Measurements included in response */
  measurements?: MeasurementsResponse;
  /** Standard portions */
  standard_portions?: Record<string, unknown>;
}

/**
 * Favorite food entry
 */
export interface FavoriteFood extends Food {
  /** Date added to favorites */
  addedAt?: string;
}

/**
 * Search foods response
 */
export interface FoodSearchResponse {
  /** List of matching foods */
  foods: Food[];
  /** Total count */
  total?: number;
}

/**
 * Transform a Food to SelectedFood when adding to meal
 */
export function createSelectedFood(food: Food): SelectedFood {
  // Get serving size from multiple possible locations
  const servingSize = food.serving_size || food.details?.serving_size || { amount: 1, unit: 'serving' };
  const hasWeightMeasurement = Boolean(servingSize?.w_amount);

  // Extract nutritional values - check both top-level and details
  const carbs = food.carbs ?? food.details?.carbs ?? 0;
  const protein = food.protein ?? food.details?.protein ?? 0;
  const fat = food.fat ?? food.details?.fat ?? 0;
  const fiber = food.fiber ?? food.details?.fiber;
  const calories = food.calories ?? food.details?.calories;
  const absorptionType = food.absorption_type ?? food.details?.absorption_type ?? 'medium';
  const glycemicIndex = food.glycemicIndex ?? food.details?.glycemicIndex;

  return {
    id: Date.now(),
    name: food.name,
    category: food.category,
    portion: {
      amount: servingSize?.amount || 1,
      unit: servingSize?.unit || 'serving',
      w_amount: servingSize?.w_amount || null,
      w_unit: servingSize?.w_unit || null,
      activeMeasurement: hasWeightMeasurement ? 'weight' : 'volume',
      baseAmount: servingSize?.amount || 1,
      baseUnit: servingSize?.unit || 'serving',
      baseWAmount: servingSize?.w_amount || null,
      baseWUnit: servingSize?.w_unit || null,
    },
    details: {
      carbs,
      protein,
      fat,
      fiber,
      calories,
      absorption_type: absorptionType,
      serving_size: servingSize,
      glycemicIndex,
    },
  };
}