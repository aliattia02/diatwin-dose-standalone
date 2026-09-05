/**
 * API response type definitions
 * Location: mobile/types/api.ts
 *
 * This file defines mobile-specific API response wrappers and extends
 * shared types from the shared library with backend-specific fields.
 *
 * Import pattern:
 * - Use shared types for domain models (User, Meal, GlucoseReading, etc.)
 * - Define mobile-specific response wrappers here (pagination, API metadata)
 */

import type {
  User,
  Patient,
  PatientConstants,
  Meal,
  MealType,
  GlucoseReading,
  InsulinDose,
  Activity,
  FoodItem,
  AbsorptionType,
} from '../../shared/src/types';

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
  details?: string;
}

/**
 * Pagination info for list responses
 */
export interface PaginationInfo {
  total: number;
  limit: number;
  skip: number;
  page?: number;
  hasMore?: boolean;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  items: T[];
  pagination: PaginationInfo;
}

/**
 * Auth response types
 */
export interface LoginResponse {
  message: string;
  token: string;
  user_type: string;
  firstName: string;
  lastName: string;
}

export interface RegisterResponse {
  message: string;
  id: string;
}

/**
 * Patient constants response
 */
export interface PatientConstantsResponse {
  constants: PatientConstants & {
    patient_id: string;
    active_conditions: string[];
    active_medications: string[];
    medication_schedules: Record<string, {
      id: string;
      startDate: string;
      endDate: string;
      dailyTimes: string[];
    }>;
  };
}

/**
 * Meal response types
 */
export interface MealResponse {
  id: string;
  timestamp: string;
  mealTime?: string;
  mealType: string;
  foodItems: Array<{
    name: string;
    portion: number;
    measurement: string;
    nutrition?: {
      carbs: number;
      protein: number;
      fat: number;
      calories: number;
    };
  }>;
  nutrition: {
    calories: number;
    carbs: number;
    protein: number;
    fat: number;
    absorption_factor?: number;
  };
  notes?: string;
  bloodSugar?: number;
  bloodSugarTimestamp?: string;
  suggestedInsulin?: number;
  intendedInsulin?: number;
  insulinCalculation?: Record<string, unknown>;
  calculation_summary?: Record<string, unknown>;
}

export interface MealsListResponse {
  meals: MealResponse[];
  pagination: PaginationInfo;
}

/**
 * Blood sugar response types
 */
export interface BloodSugarResponse {
  _id: string;
  bloodSugar: number;
  timestamp: string;
  bloodSugarTimestamp?: string;
  status: 'low' | 'normal' | 'high';
  notes?: string;
  target: number;
}

export interface BloodSugarCreateResponse {
  message: string;
  id: string;
  meal_id?: string;
  status: string;
  bloodSugarTimestamp: string;
}

/**
 * Insulin response types
 */
export interface InsulinLogResponse {
  id: string;
  medication: string;
  dose: number;
  taken_at: string;
  scheduled_time: string;
  notes?: string;
  status: string;
  meal_type?: string;
  is_insulin: boolean;
  blood_sugar?: number;
  pharmacokinetics?: Record<string, unknown>;
}

export interface InsulinDataResponse {
  insulin_logs: InsulinLogResponse[];
  meta: {
    start_date: string;
    end_date: string;
    count: number;
  };
}

export interface ActiveInsulinResponse {
  total_active_insulin: number;
  calculation_time: string;
  calculation_timezone: string;
  active_doses: number;
  insulin_contributions: Array<{
    dose_id: string;
    medication: string;
    initial_dose: number;
    taken_at: string;
    hours_since_dose: number;
    activity_percent: number;
    active_units: number;
  }>;
}

/**
 * Activity response types
 */
export interface ActivityResponse {
  id: string;
  type: 'expected' | 'completed';
  level: number;
  levelLabel: string;
  impact: number;
  duration: string;
  timestamp: string;
  startTime?: string;
  endTime?: string;
  expectedTime?: string;
  completedTime?: string;
  notes?: string;
  meal_id?: string;
}

/**
 * Food search response types
 */
export interface FoodSearchResult {
  name: string;
  category: string;
  serving_size?: {
    amount: number;
    unit: string;
  };
  carbs?: number;
  protein?: number;
  fat?: number;
  absorption_type?: string;
}

export interface FoodCategoriesResponse {
  measurements: {
    volume: Record<string, { ml: number; display_name: string }>;
    weight: Record<string, { grams: number; display_name: string }>;
  };
  standard_portions: Record<string, unknown>;
  categories: {
    basic: string[];
    starch: string[];
    starchy_vegetables: string[];
    pulses: string[];
    fruits: string[];
    dairy: string[];
    sweets: string[];
    snacks: string[];
    common_snacks: string[];
    high_protein: string[];
    high_fat: string[];
    indian: string[];
    chinese: string[];
    italian: string[];
    custom: string[];
  };
}

/**
 * Error response type
 */
export interface ApiError {
  error: string;
  details?: string;
  status?: number;
}