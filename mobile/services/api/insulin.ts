/**
 * Insulin API Service
 * Location: mobile/services/api/insulin.ts
 *
 * Main Functions: getDoses, logDose, getActiveDoses, getActiveInsulin,
 *                 getAnalytics, calculateIOB, getInsulinTypeDisplayName, getInsulinTypes
 * Description: Insulin logging and IOB (Insulin On Board) tracking via the backend API.
 *
 * Features:
 * - Fetch historical insulin dose logs with date/day filters
 * - Log a new insulin dose (POST /api/insulin/log)
 * - Fetch currently active insulin / IOB (GET /api/insulin/active-effect)
 * - Insulin analytics (GET /api/insulin-analytics)
 * - Client-side IOB helper (calculateIOB)
 * - Insulin type display name mapping and dropdown list
 *
 * Route mapping (backend: medication_routes.py):
 *   INSULIN.DATA     → GET  /api/insulin-data
 *   INSULIN.ACTIVE   → GET  /api/insulin/active-effect   ← FIX (was /api/active-insulin)
 *   INSULIN.LOG      → POST /api/insulin/log              ← FIX (was /api/insulin via MEDICATION.CREATE_LOG)
 *   INSULIN.ANALYTICS→ GET  /api/insulin-analytics
 */

import apiClient from './client';
import API from './endpoints';
import type { InsulinDataResponse, InsulinLogResponse, ActiveInsulinResponse } from '@/types/api';

export interface GetInsulinParams {
  days?: number;
  end_date?: string;
  patient_id?: string;
}

export interface LogInsulinData {
  medication: string;
  dose: number;
  taken_at?: string;
  scheduled_time?: string;
  notes?: string;
  meal_type?: string;
  blood_sugar?: number;
  is_insulin: boolean;
}

/**
 * Get insulin doses with optional filters.
 * FIXED: Properly passes days parameter to backend.
 */
export const getDoses = async (params: GetInsulinParams = {}): Promise<InsulinDataResponse> => {
  const queryParams: Record<string, string> = {};

  if (params.days !== undefined) {
    queryParams.days = params.days.toString();
    console.log(`[insulin.ts] Requesting insulin data for ${params.days} days`);
  }

  if (params.end_date) {
    queryParams.end_date = params.end_date;
  }

  if (params.patient_id) {
    queryParams.patient_id = params.patient_id;
  }

  console.log('[insulin.ts] Query parameters:', queryParams);

  const response = await apiClient.get<InsulinDataResponse>(API.INSULIN.DATA, {
    params: queryParams
  });

  console.log('[insulin.ts] Response:', {
    count: response.data.insulin_logs?.length || 0,
    meta: response.data.meta
  });

  return response.data;
};

/**
 * Log a new insulin dose.
 *
 * FIX: Previously used API.MEDICATION.CREATE_LOG → '/api/medication-log' which
 * requires a patient_id path param (/api/medication-log/<patient_id>).
 * The dedicated insulin log endpoint is /api/insulin/log (POST) — no path param needed.
 */
export const logDose = async (data: LogInsulinData): Promise<InsulinLogResponse> => {
  const response = await apiClient.post<InsulinLogResponse>(API.INSULIN.LOG, {
    ...data,
    is_insulin: true,
  });
  return response.data;
};

/**
 * Get currently active insulin doses (IOB) with optional target time.
 *
 * FIX: Was calling GET /api/active-insulin (404).
 * Backend route is GET /api/insulin/active-effect
 * (medication_routes.py line 934)
 */
export const getActiveDoses = async (targetTime?: string): Promise<ActiveInsulinResponse> => {
  const params: Record<string, string> = {};
  if (targetTime) {
    params.target_time = targetTime;
  }
  const response = await apiClient.get<ActiveInsulinResponse>(API.INSULIN.ACTIVE, { params });
  return response.data;
};

/**
 * Get active insulin — alias for getActiveDoses().
 * Used by the meal store and dashboard hooks.
 *
 * FIX: Inherits the corrected endpoint from getActiveDoses().
 */
export const getActiveInsulin = async (): Promise<ActiveInsulinResponse> => {
  return getActiveDoses();
};

/**
 * Get insulin analytics
 */
export const getAnalytics = async (params: { days?: number; patient_id?: string } = {}): Promise<Record<string, unknown>> => {
  const response = await apiClient.get(API.INSULIN.ANALYTICS, { params });
  return response.data;
};

/**
 * Calculate insulin on board (IOB) from active doses response
 */
export const calculateIOB = (activeInsulin: ActiveInsulinResponse): number => {
  return activeInsulin.total_active_insulin || 0;
};

/**
 * Get insulin type display name
 */
export const getInsulinTypeDisplayName = (medication: string): string => {
  const displayNames: Record<string, string> = {
    'insulin_lispro': 'Insulin Lispro (Humalog)',
    'insulin_aspart': 'Insulin Aspart (NovoLog)',
    'insulin_glulisine': 'Insulin Glulisine (Apidra)',
    'insulin_regular': 'Regular Insulin',
    'insulin_nph': 'NPH Insulin',
    'insulin_glargine': 'Insulin Glargine (Lantus)',
    'insulin_detemir': 'Insulin Detemir (Levemir)',
    'insulin_degludec': 'Insulin Degludec (Tresiba)',
    'rapid_acting': 'Rapid Acting',
    'short_acting': 'Short Acting',
    'intermediate_acting': 'Intermediate Acting',
    'long_acting': 'Long Acting',
  };
  return displayNames[medication] || medication;
};

/**
 * Get insulin types for dropdown selection
 */
export const getInsulinTypes = () => {
  return [
    { value: 'insulin_lispro', label: 'Insulin Lispro (Humalog)' },
    { value: 'insulin_aspart', label: 'Insulin Aspart (NovoLog)' },
    { value: 'insulin_glulisine', label: 'Insulin Glulisine (Apidra)' },
    { value: 'insulin_regular', label: 'Regular Insulin' },
    { value: 'insulin_nph', label: 'NPH Insulin' },
    { value: 'insulin_glargine', label: 'Insulin Glargine (Lantus)' },
    { value: 'insulin_detemir', label: 'Insulin Detemir (Levemir)' },
    { value: 'insulin_degludec', label: 'Insulin Degludec (Tresiba)' },
    { value: 'rapid_acting', label: 'Rapid Acting' },
    { value: 'short_acting', label: 'Short Acting' },
    { value: 'intermediate_acting', label: 'Intermediate Acting' },
    { value: 'long_acting', label: 'Long Acting' },
  ];
};

export default {
  getDoses,
  logDose,
  getActiveDoses,
  getActiveInsulin,
  getAnalytics,
  calculateIOB,
  getInsulinTypeDisplayName,
  getInsulinTypes,
};