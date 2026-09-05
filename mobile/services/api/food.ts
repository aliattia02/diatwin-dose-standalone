/**
 * Food API service
 * Location: mobile/services/api/food.ts
 *
 * Provides food search, categories, favorites, and nutritional data
 */

import apiClient from './client';
import API from './endpoints';

// ============================================================================
// Type Definitions
// ============================================================================

export interface ServingSize {
  amount: number;
  unit: string;
  w_amount?: number;
  w_unit?: string;
}

export interface FoodDetails {
  carbs: number;
  protein: number;
  fat: number;
  absorption_type: 'fast' | 'medium' | 'slow';
  serving_size: ServingSize;
  fiber?: number;
  calories?: number;
  glycemicIndex?: number;
}

export interface FoodItem {
  id?: string;
  name: string;
  category?: string;
  details: FoodDetails;
  is_favorite?: boolean;
  is_custom?: boolean;
}

export interface SearchFoodsParams {
  query?: string;
  category?: string;
  limit?: number;
  skip?: number;
}

export interface CategoriesResponse {
  categories: Record<string, string[]>;
  measurements?: {
    volume: Record<string, { ml: number; display_name: string }>;
    weight: Record<string, { grams: number; display_name: string }>;
  };
}

export interface CustomFoodData {
  name: string;
  category?: string;
  carbs: number;
  protein: number;
  fat: number;
  serving_size: ServingSize;
  absorption_type?: 'fast' | 'medium' | 'slow';
  fiber?: number;
  calories?: number;
}

export interface MeasurementUnit {
  name: string;
  category: 'volume' | 'weight' | 'count';
  to_grams?: number;
}

export interface MeasurementsResponse {
  units: MeasurementUnit[];
}

export interface NutritionalSummaryParams {
  foods: Array<{
    name: string;
    amount: number;
    unit: string;
  }>;
}

export interface NutritionalSummary {
  total_carbs: number;
  total_protein: number;
  total_fat: number;
  total_calories: number;
  items: Array<{
    name: string;
    carbs: number;
    protein: number;
    fat: number;
    calories: number;
  }>;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Search for foods in the database
 */
export const searchFoods = async (params: SearchFoodsParams = {}): Promise<FoodItem[]> => {
  console.log('[Food Service] Searching foods with params:', params);

  try {
    const queryParams: Record<string, string> = {};

    if (params.query) {
      queryParams.query = params.query;
    }

    if (params.category) {
      queryParams.category = params.category;
    }

    if (params.limit !== undefined) {
      queryParams.limit = params.limit.toString();
    }

    if (params.skip !== undefined) {
      queryParams.skip = params.skip.toString();
    }

    const response = await apiClient.get<FoodItem[]>(API.FOOD.SEARCH, {
      params: queryParams,
    });

    console.log('[Food Service] Search results:', response.data.length, 'foods found');

    return response.data;
  } catch (error) {
    console.error('[Food Service] Search error:', error);
    throw error;
  }
};

/**
 * Get food categories
 */
export const getCategories = async (): Promise<CategoriesResponse> => {
  console.log('[Food Service] Fetching categories');

  try {
    const response = await apiClient.get<CategoriesResponse>(API.FOOD.CATEGORIES);

    console.log('[Food Service] Categories loaded:', Object.keys(response.data.categories || {}).length);

    return response.data;
  } catch (error) {
    console.error('[Food Service] Categories error:', error);
    throw error;
  }
};

/**
 * Get user's favorite foods
 */
export const getFavorites = async (): Promise<FoodItem[]> => {
  console.log('[Food Service] Fetching favorites');

  try {
    const response = await apiClient.get<FoodItem[]>(API.FOOD.FAVORITE);

    console.log('[Food Service] Favorites loaded:', response.data.length);

    return response.data;
  } catch (error) {
    console.error('[Food Service] Get favorites error:', error);
    // Return empty array on error instead of throwing
    // This prevents the component from breaking if favorites aren't set up yet
    return [];
  }
};

/**
 * Add a food to favorites
 * Backend expects { food_name: string } — matches the web (FoodSection.js) implementation
 */
export const addToFavorites = async (foodName: string): Promise<void> => {
  console.log('[Food Service] Adding to favorites:', foodName);

  try {
    await apiClient.post(API.FOOD.FAVORITE, { food_name: foodName });

    console.log('[Food Service] Food added to favorites');
  } catch (error) {
    console.error('[Food Service] Add to favorites error:', error);
    throw error;
  }
};

/**
 * Remove a food from favorites
 */
export const removeFromFavorites = async (foodName: string): Promise<void> => {
  console.log('[Food Service] Removing from favorites:', foodName);

  try {
    await apiClient.delete(API.FOOD.FAVORITE, { data: { food_name: foodName } });

    console.log('[Food Service] Food removed from favorites');
  } catch (error) {
    console.error('[Food Service] Remove from favorites error:', error);
    throw error;
  }
};

/**
 * Create a custom food item
 */
export const createCustomFood = async (data: CustomFoodData): Promise<FoodItem> => {
  console.log('[Food Service] Creating custom food:', data.name);

  try {
    const response = await apiClient.post<FoodItem>(API.FOOD.CUSTOM, data);

    console.log('[Food Service] Custom food created:', response.data);

    return response.data;
  } catch (error) {
    console.error('[Food Service] Create custom food error:', error);
    throw error;
  }
};

/**
 * Get measurement units
 */
export const getMeasurements = async (): Promise<MeasurementsResponse> => {
  console.log('[Food Service] Fetching measurements');

  try {
    const response = await apiClient.get<MeasurementsResponse>(API.FOOD.MEASUREMENTS);

    console.log('[Food Service] Measurements loaded');

    return response.data;
  } catch (error) {
    console.error('[Food Service] Measurements error:', error);
    throw error;
  }
};

/**
 * Get nutritional summary for a list of foods
 */
export const getNutritionalSummary = async (
  params: NutritionalSummaryParams
): Promise<NutritionalSummary> => {
  console.log('[Food Service] Getting nutritional summary for', params.foods.length, 'foods');

  try {
    const response = await apiClient.post<NutritionalSummary>(
      API.FOOD.NUTRITIONAL_SUMMARY,
      params
    );

    console.log('[Food Service] Nutritional summary:', response.data);

    return response.data;
  } catch (error) {
    console.error('[Food Service] Nutritional summary error:', error);
    throw error;
  }
};

// ============================================================================
// Default Export
// ============================================================================

export default {
  searchFoods,
  getCategories,
  getFavorites,
  addToFavorites,
  removeFromFavorites,
  createCustomFood,
  getMeasurements,
  getNutritionalSummary,
};