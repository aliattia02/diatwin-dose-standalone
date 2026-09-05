/**
 * Meals API service - FIXED VERSION
 * Ensures insulin data AND activities are properly sent to backend
 * Location: mobile/services/api/meals.ts
 */

import apiClient from './client';
import API from './endpoints';
import type { MealResponse, MealsListResponse } from '@/types/api';

export interface CreateMealData {
  mealType: string;
  mealTime: string;
  selectedFoods: any[];
  bloodSugar?: number;
  bloodSugarTimestamp?: string;
  bloodSugarUnit?: string;
  activities?: any[];
  intendedInsulin?: number;
  intendedInsulinType?: string;
  insulinTimestamp?: string;
  notes?: string;
  activityIds?: string[];
  calculationFactors?: any;
}

export interface CalculateMealData {
  mealType: string;
  selectedFoods: any[];
  bloodSugar?: number;
  activities?: any[];
}

/**
 * Format activities for backend consumption
 * Backend expects: { level: number, duration: string }
 */
function formatActivitiesForBackend(activities: any[] | undefined): any[] {
  if (!activities || !Array.isArray(activities)) {
    return []; // Return empty array if no activities
  }

  return activities.map(activity => ({
    level: activity.level,
    duration: activity.duration,
    // Include other fields the backend might need
    // B-5 fix: was `activity.type || activity.isExpected ? 'expected' : 'completed'`
    // JS precedence evaluated that as `(activity.type || activity.isExpected) ? 'expected' : 'completed'`
    // so any truthy activity.type (including the string 'completed') always resolved to 'expected'.
    type: activity.type ? activity.type : (activity.isExpected ? 'expected' : 'completed'),
    impact: activity.impact,
    startTime: activity.startTime,
    endTime: activity.endTime,
    notes: activity.notes || ''
  }));
}

/**
 * Calculate meal insulin requirements
 */
export const calculateMeal = async (data: CalculateMealData): Promise<any> => {
  console.log('[meals.ts] Calculating meal with data:', JSON.stringify(data, null, 2));

  try {
    // **CRITICAL FIX**: Format activities properly for backend
    const formattedActivities = formatActivitiesForBackend(data.activities);

    console.log('[meals.ts] Formatted activities:', JSON.stringify(formattedActivities, null, 2));

    const response = await apiClient.post(API.MEALS.CALCULATE, {
      mealType: data.mealType,
      foodItems: data.selectedFoods,
      bloodSugar: data.bloodSugar,
      activities: formattedActivities, // Send formatted activities
    });

    console.log('[meals.ts] Calculation response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('[meals.ts] Calculation error:', error);
    throw error;
  }
};

/**
 * Create a new meal entry
 * **CRITICAL FIX**: Properly formats insulin data AND activities for backend
 */
export const createMeal = async (data: CreateMealData): Promise<MealResponse> => {
  console.log('[meals.ts] Creating meal with data:', JSON.stringify(data, null, 2));

  // **CRITICAL**: Verify insulin data is present
  console.log('[meals.ts] Insulin data being sent:', {
    intendedInsulin: data.intendedInsulin,
    intendedInsulinType: data.intendedInsulinType,
    insulinTimestamp: data.insulinTimestamp,
  });

  try {
    // **CRITICAL FIX**: Format activities properly for backend
    const formattedActivities = formatActivitiesForBackend(data.activities);

    console.log('[meals.ts] Formatted activities for meal creation:', JSON.stringify(formattedActivities, null, 2));

    const payload = {
      mealType: data.mealType,
      mealTime: data.mealTime,
      foodItems: data.selectedFoods,
      // Only include blood sugar fields when an actual reading was provided
      ...(data.bloodSugar != null && {
        bloodSugar: data.bloodSugar,
        bloodSugarTimestamp: data.bloodSugarTimestamp || data.mealTime,
        bloodSugarUnit: data.bloodSugarUnit,
      }),
      activities: formattedActivities,
      // Only include insulin fields when an actual dose was provided
      ...(data.intendedInsulin != null && {
        intendedInsulin: data.intendedInsulin,
        intendedInsulinType: data.intendedInsulinType,
        insulinTimestamp: data.insulinTimestamp || data.mealTime,
      }),
      notes: data.notes || '',
      activityIds: data.activityIds,
      // Forward on-device calculation breakdown for backend audit/logging
      ...(data.calculationFactors != null && {
        calculationFactors: data.calculationFactors,
      }),
    };

    // ── Diagnostic: compact per-food summary to spot bad units quickly ──────────
    console.log('[meals.ts] 📦 Payload summary:');
    console.log('  mealType          :', payload.mealType);
    console.log('  mealTime          :', payload.mealTime);
    console.log('  bloodSugar        :', (payload as any).bloodSugar ?? '(not sent)');
    console.log('  intendedInsulin   :', (payload as any).intendedInsulin ?? '(not sent)');
    console.log('  calculationFactors:', (payload as any).calculationFactors != null ? '✅ present' : '(not sent)');
    console.log('  foodItems:');
    ((payload as any).foodItems || []).forEach((f: any, i: number) => {
      console.log(
        `    [${i}] ${f.name}` +
        ` | amount=${f.portion?.amount} unit=${f.portion?.unit}` +
        ` measurement_type=${f.portion?.measurement_type}` +
        ` absorption=${f.details?.absorption_type}`
      );
    });
    console.log('[meals.ts] Full payload JSON:', JSON.stringify(payload, null, 2));

    const response = await apiClient.post<MealResponse>(API.MEALS.CREATE, payload);

    console.log('[meals.ts] ✅ Meal created successfully:', response.data);

    if (response.data.intendedInsulin) {
      console.log('[meals.ts] ✅ Insulin saved:', {
        intendedInsulin: response.data.intendedInsulin,
        intendedInsulinType: response.data.intendedInsulinType,
      });
    } else {
      console.warn('[meals.ts] ⚠️ Insulin NOT in response (expected if none was entered)');
    }

    return response.data;
  } catch (error: any) {
    // ── Extract the actual backend error message from the response body ──────
    const status  = error?.response?.status;
    const body    = error?.response?.data;
    const message = body?.error ?? body?.message ?? error?.message ?? 'unknown';

    console.error('[meals.ts] ❌ Create meal FAILED');
    console.error('  HTTP status :', status);
    console.error('  Backend says:', message);
    if (body) {
      console.error('  Full body   :', JSON.stringify(body, null, 2));
    }
    // Propagate the human-readable backend message so MealForm alert shows it
    if (body?.error && error.message !== body.error) {
      error.message = body.error;
    }
    throw error;
  }
};

/**
 * Get list of meals
 */
export const getMeals = async (params?: {
  limit?: number;
  skip?: number;
  start_date?: string;
  end_date?: string;
}): Promise<MealsListResponse> => {
  const response = await apiClient.get<MealsListResponse>(API.MEALS.LIST, { params });
  return response.data;
};

/**
 * Get a specific meal by ID.
 *
 * NOTE: GET /api/meal/<id> returns 405 — the backend only supports DELETE on
 * that path. We fetch the paginated list and find the matching entry instead.
 */
export const getMealById = async (id: string): Promise<MealResponse> => {
  const response = await apiClient.get<MealsListResponse>(API.MEALS.LIST, {
    params: { limit: 200, skip: 0 },
  });
  const meal = response.data.meals?.find((m: MealResponse) => m.id === id);
  if (!meal) {
    throw new Error(`Meal ${id} not found`);
  }
  return meal;
};

/**
 * Get patient meals (for doctor view)
 */
export const getPatientMeals = async (patientId: string, params?: {
  limit?: number;
  skip?: number;
  start_date?: string;
  end_date?: string;
}): Promise<MealsListResponse> => {
  const response = await apiClient.get<MealsListResponse>(
    API.MEALS.PATIENT_MEALS(patientId),
    { params }
  );
  return response.data;
};

export default {
  calculateMeal,
  createMeal,
  getMeals,
  getMealById,
  getPatientMeals,
};