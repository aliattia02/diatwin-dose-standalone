/**
 * Doctor Management API Service (Patient Authorization)
 * Location: mobile/services/api/doctor-management.ts
 *
 * NOTE: This is separate from doctor.ts which contains doctor-specific endpoints.
 *
 * FIX: getAllDoctors() now guards against 403 (doctors calling a patient-only
 * endpoint) by returning an empty array instead of throwing, and logs a clear
 * warning so developers know why the list is empty.
 */

import apiClient from './client';
import API from './endpoints';

export interface Doctor {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface AuthorizedDoctor extends Doctor {
  authorizedAt?: string;
}

/**
 * Get list of all available doctors (patient-facing: for a patient to select
 * which doctors they want to authorize).
 *
 * Returns an empty array when called with a doctor token (403) so that any
 * settings screen rendered during a doctor session degrades gracefully instead
 * of crashing.
 */
export async function getAllDoctors(): Promise<Doctor[]> {
  console.log('[Doctor Management] Fetching all doctors');
  try {
    const response = await apiClient.get<Doctor[]>(API.DOCTORS.LIST);
    console.log('[Doctor Management] Found doctors:', response.data.length);
    return response.data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 403) {
      // This endpoint is patient-only. If a doctor account hits it (e.g. the
      // settings/doctors screen pre-renders) we silently return [] rather than
      // surfacing a confusing error.
      console.warn(
        '[Doctor Management] getAllDoctors returned 403 — this is expected when ' +
        'a doctor account reaches the patient doctor-management screen. ' +
        'Ensure the settings/doctors screen is hidden for doctor users.'
      );
      return [];
    }
    throw err;
  }
}

/**
 * Get list of authorized doctors for current patient.
 */
export async function getAuthorizedDoctors(): Promise<AuthorizedDoctor[]> {
  console.log('[Doctor Management] Fetching authorized doctors');
  try {
    const response = await apiClient.get<AuthorizedDoctor[]>(API.PATIENT.AUTHORIZED_DOCTORS);
    console.log('[Doctor Management] Authorized doctors:', response.data.length);
    return response.data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 403) {
      console.warn('[Doctor Management] getAuthorizedDoctors returned 403 — patient-only endpoint called from doctor session');
      return [];
    }
    throw err;
  }
}

/**
 * Authorize a doctor to view patient data.
 */
export async function authorizeDoctor(doctorId: string): Promise<{ message: string; doctor?: Doctor }> {
  console.log('[Doctor Management] Authorizing doctor:', doctorId);
  const response = await apiClient.post<{ message: string; doctor?: Doctor }>(
    API.PATIENT.AUTHORIZE_DOCTOR,
    { doctor_id: doctorId }
  );
  console.log('[Doctor Management] Authorization result:', response.data.message);
  return response.data;
}

/**
 * Revoke doctor's access to patient data.
 */
export async function revokeDoctor(doctorId: string): Promise<{ message: string }> {
  console.log('[Doctor Management] Revoking doctor access:', doctorId);
  const response = await apiClient.post<{ message: string }>(
    API.PATIENT.REVOKE_DOCTOR,
    { doctor_id: doctorId }
  );
  console.log('[Doctor Management] Revoke result:', response.data.message);
  return response.data;
}

export default {
  getAllDoctors,
  getAuthorizedDoctors,
  authorizeDoctor,
  revokeDoctor,
};