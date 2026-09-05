/**
 * Blood glucose API service
 */

import apiClient from './client';
import API from './endpoints';
import type { BloodSugarResponse, BloodSugarCreateResponse } from '@/types/api';

export interface GetGlucoseParams {
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  filter_by?: 'timestamp' | 'reading_time';
  patient_id?: string;
}

export interface CreateGlucoseData {
  bloodSugar: number;
  bloodSugarTimestamp?: string;
  notes?: string;
  bloodSugarSource?: 'standalone' | 'meal' | 'cgm' | 'manual';
}

/**
 * Get list of blood sugar readings with optional filters
 */
export const getReadings = async (params: GetGlucoseParams = {}): Promise<BloodSugarResponse[]> => {
  const response = await apiClient.get<BloodSugarResponse[]>(API.BLOOD_SUGAR.LIST, { params });
  return response.data;
};

/**
 * Create a new blood sugar reading
 */
export const createReading = async (data: CreateGlucoseData): Promise<BloodSugarCreateResponse> => {
  const payload = {
    bloodSugar: data.bloodSugar,
    bloodSugarTimestamp: data.bloodSugarTimestamp,
    notes: data.notes || '',
    bloodSugarSource: data.bloodSugarSource || 'standalone'
  };

  const response = await apiClient.post<BloodSugarCreateResponse>(API.BLOOD_SUGAR.CREATE, payload);
  return response.data;
};

/**
 * Get the latest blood sugar reading
 */
export const getLatestReading = async (): Promise<BloodSugarResponse | null> => {
  const readings = await getReadings({ start_time: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
  if (readings.length > 0) {
    return readings.sort((a, b) =>
      new Date(b.bloodSugarTimestamp || b.timestamp).getTime() -
      new Date(a.bloodSugarTimestamp || a.timestamp).getTime()
    )[0];
  }
  return null;
};

/**
 * Get blood sugar status based on value and target
 */
export const getGlucoseStatus = (value: number, target: number = 100): 'low' | 'normal' | 'high' | 'veryLow' | 'veryHigh' => {
  if (value < 54) return 'veryLow';
  if (value < target * 0.7) return 'low';
  if (value > 250) return 'veryHigh';
  if (value > target * 1.3) return 'high';
  return 'normal';
};

/**
 * Get patient blood sugar readings
 */
export const getPatientReadings = async (patientId: string, params: { range?: string } = {}): Promise<BloodSugarResponse[]> => {
  const response = await apiClient.get<BloodSugarResponse[]>(API.BLOOD_SUGAR.BY_PATIENT(patientId), { params });
  return response.data;
};

export default {
  getReadings,
  createReading,
  getLatestReading,
  getGlucoseStatus,
  getPatientReadings,
};