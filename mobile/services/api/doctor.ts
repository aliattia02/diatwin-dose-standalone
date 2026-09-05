/**
 * Doctor API Service
 * Location: mobile/services/api/doctor.ts
 *
 * Main Functions: getPatients, getPatientConstants, updatePatientConstants,
 *                 resetPatientConstants, updatePatientConditions,
 *                 updatePatientMedications, getDoctorPatientMeals,
 *                 getPatientBloodSugar, getPatientActivities,
 *                 getPatientInsulinDoses  ← NEW
 */

import apiClient from './client';
import { API } from './endpoints';

import type { MealResponse, BloodSugarResponse, ActivityResponse } from '@/types/api';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DoctorPatient {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  activeConditions?: string[];
  activeMedications?: string[];
}

export interface PatientConstantsData {
  insulin_to_carb_ratio: number;
  correction_factor: number;
  target_glucose: number;
  protein_factor: number;
  fat_factor: number;
  carb_to_bg_factor: number;
  daily_reset_hour: number;           // user-configurable daily reset hour (0-23)
  timezone_offset_minutes?: number;   // patient UTC offset in minutes (e.g. 120 = UTC+2)
  activity_coefficients: Record<string, number>;
  absorption_modifiers: Record<string, number>;
  insulin_timing_guidelines: Record<string, unknown>;
  disease_factors: Record<string, unknown>;
  medication_factors: Record<string, unknown>;
  active_conditions: string[];
  active_medications: string[];
}

/**
 * A single insulin dose record as returned by the backend.
 * Field names mirror the mobile insulin dose type; adjust if your API differs.
 */
export interface InsulinDoseResponse {
  id?: string;
  _id?: string;
  insulinType: string;       // e.g. "rapid_acting", "long_acting"
  units: number;
  timestamp?: string;
  doseTime?: string;
  notes?: string;
  iobContribution?: number;  // mg/dL equivalent still active (optional)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient list
// ─────────────────────────────────────────────────────────────────────────────

export const getPatients = async (): Promise<DoctorPatient[]> => {
  const response = await apiClient.get<DoctorPatient[]>(API.DOCTOR.PATIENTS);
  return response.data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const getPatientConstants = async (patientId: string): Promise<PatientConstantsData> => {
  const response = await apiClient.get<{ constants: PatientConstantsData }>(
    API.DOCTOR.PATIENT_CONSTANTS(patientId)
  );
  return response.data.constants;
};

export const updatePatientConstants = async (
  patientId: string,
  constants: Partial<PatientConstantsData>
): Promise<PatientConstantsData> => {
  const response = await apiClient.put<{ constants: PatientConstantsData }>(
    API.DOCTOR.PATIENT_CONSTANTS(patientId),
    { constants }
  );
  return response.data.constants;
};

export const resetPatientConstants = async (patientId: string): Promise<PatientConstantsData> => {
  const response = await apiClient.post<{ constants: PatientConstantsData }>(
    API.DOCTOR.PATIENT_CONSTANTS_RESET(patientId)
  );
  return response.data.constants;
};

// ─────────────────────────────────────────────────────────────────────────────
// Conditions & Medications
// ─────────────────────────────────────────────────────────────────────────────

export const updatePatientConditions = async (
  patientId: string,
  conditions: string[]
): Promise<{ active_conditions: string[] }> => {
  const response = await apiClient.put<{ active_conditions: string[] }>(
    API.DOCTOR.PATIENT_CONDITIONS(patientId),
    { conditions }
  );
  return response.data;
};

export const updatePatientMedications = async (
  patientId: string,
  medications: string[]
): Promise<{ active_medications: string[] }> => {
  const response = await apiClient.put<{ active_medications: string[] }>(
    API.DOCTOR.PATIENT_MEDICATIONS(patientId),
    { medications }
  );
  return response.data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Patient data history
// ─────────────────────────────────────────────────────────────────────────────

export const getDoctorPatientMeals = async (
  patientId: string,
  params?: { limit?: number; skip?: number }
): Promise<{ meals: MealResponse[]; pagination: { total: number } }> => {
  const response = await apiClient.get<{ meals: MealResponse[]; pagination: { total: number } }>(
    API.MEALS.PATIENT_MEALS(patientId),
    { params }
  );
  return response.data;
};

export const getPatientBloodSugar = async (
  patientId: string,
  params?: { start_date?: string; end_date?: string; start_time?: string; end_time?: string; limit?: number }
): Promise<BloodSugarResponse[]> => {
  const response = await apiClient.get<BloodSugarResponse[]>(
    API.BLOOD_SUGAR.BY_PATIENT(patientId),
    { params }
  );
  return response.data;
};

export const getPatientActivities = async (
  patientId: string,
  params?: { limit?: number; skip?: number }
): Promise<ActivityResponse[]> => {
  const response = await apiClient.get<ActivityResponse[]>(
    API.ACTIVITIES.PATIENT_HISTORY(patientId),
    { params }
  );
  return response.data;
};

/**
 * Get insulin dose history for a patient (doctor view).
 *
 * Calls the dedicated doctor-proxied endpoint:
 *   GET /api/doctor/patient/<patient_id>/insulin
 *
 * This is NOT /api/patient/<id>/insulin (patient-only → 404 for doctor
 * tokens). The doctor endpoint enforces check_doctor_patient_access().
 */
export const getPatientInsulinDoses = async (
  patientId: string,
  params?: { limit?: number; start_date?: string; end_date?: string }
): Promise<InsulinDoseResponse[]> => {
  // Always use the doctor-namespaced route — never the patient-scoped one.
  const url = `/api/doctor/patient/${patientId}/insulin`;

  try {
    const response = await apiClient.get<{ doses: InsulinDoseResponse[] } | InsulinDoseResponse[]>(
      url,
      { params }
    );
    const raw = response.data;
    // Backend returns { doses: [] } — handle both shapes defensively
    if (Array.isArray(raw)) return raw;
    return (raw as { doses: InsulinDoseResponse[] }).doses ?? [];
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 403) {
      console.warn(`[Doctor] getPatientInsulinDoses: ${status} for patient ${patientId}`);
      return [];
    }
    throw err;
  }
};

export default {
  getPatients,
  getPatientConstants,
  updatePatientConstants,
  resetPatientConstants,
  updatePatientConditions,
  updatePatientMedications,
  getDoctorPatientMeals,
  getPatientBloodSugar,
  getPatientActivities,
  getPatientInsulinDoses,
};