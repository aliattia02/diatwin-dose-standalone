/**
 * Patient API Service
 * Location: mobile/services/api/patient.ts
 *
 * Main Functions: getConstants, updateConstants, getProfile, updateProfile
 * Description: Patient constants and profile CRUD operations via the backend API.
 *
 * Features:
 * - Fetch and update patient-specific glucose/insulin constants
 * - Fetch and update patient profile (demographics, preferences)
 * - Typed responses for all endpoints
 * - Supports active conditions and medication schedules in response shape
 */

import apiClient from './client';
import API from './endpoints';

// Migrated from broken '../../../shared/src/types' path → local constants barrel
import type { PatientConstants } from '@/constants/shared-constants';

/**
 * Extended patient constants response from backend.
 * Includes server-side fields (patient_id, conditions, medications)
 * on top of the base PatientConstants shape.
 */
export interface PatientConstantsResponse extends PatientConstants {
  patient_id: string;
  active_conditions?: string[];
  active_medications?: string[];
  medication_schedules?: Record<string, {
    id: string;
    startDate: string;
    endDate: string;
    dailyTimes: string[];
  }>;
}

/**
 * Get patient constants
 *
 * @returns {Promise<PatientConstantsResponse>} Patient constants
 */
export const getConstants = async (): Promise<PatientConstantsResponse> => {
  const response = await apiClient.get<PatientConstantsResponse>(API.PATIENT.CONSTANTS);
  return response.data;
};

/**
 * Update patient constants
 *
 * @param {Partial<PatientConstants>} constants - Constants to update (partial)
 * @returns {Promise<PatientConstantsResponse>} Updated patient constants
 */
export const updateConstants = async (
  constants: Partial<PatientConstants>
): Promise<PatientConstantsResponse> => {
  const response = await apiClient.put<PatientConstantsResponse>(
    API.PATIENT.CONSTANTS,
    constants
  );
  return response.data;
};

/**
 * Patient profile data structure
 */
export interface PatientProfile {
  firstName?: string;
  lastName?: string;
  email?: string;
  dateOfBirth?: string;
  weight?: number;
  height?: number;
  diabetesType?: string;
  diagnosisDate?: string;
  preferredUnits?: 'metric' | 'imperial';
  timezone?: string;
}

/**
 * Get patient profile
 *
 * @returns {Promise<PatientProfile>} Patient profile data
 */
export const getProfile = async (): Promise<PatientProfile> => {
  const response = await apiClient.get<PatientProfile>(API.PATIENT.PROFILE);
  return response.data;
};

/**
 * Update patient profile
 *
 * @param {Partial<PatientProfile>} profileData - Profile data to update (partial)
 * @returns {Promise<PatientProfile>} Updated profile data
 */
export const updateProfile = async (profileData: Partial<PatientProfile>): Promise<PatientProfile> => {
  const response = await apiClient.put<PatientProfile>(API.PATIENT.PROFILE, profileData);
  return response.data;
};

export default {
  getConstants,
  updateConstants,
  getProfile,
  updateProfile,
};