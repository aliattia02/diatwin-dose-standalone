/**
 * Activity API service for activity logging and tracking
 * Location: mobile/services/api/activities.ts
 */

import apiClient from './client';
import API from './endpoints';

export interface ActivityLevel {
  value: number;
  label: string;
  impact: number;
}

export interface ActivityRecord {
  level: number;
  startTime: string;
  endTime: string;
  duration?: string;
  type: 'expected' | 'completed';
  expectedTime?: string;
  completedTime?: string;
  impact?: number;
  notes?: string;
}

export interface RecordActivitiesData {
  expectedActivities: ActivityRecord[];
  completedActivities: ActivityRecord[];
  notes?: string;
}

export interface RecordActivitiesResponse {
  message: string;
  expected_activity_ids: string[];
  completed_activity_ids: string[];
  activity_ids: string[];
}

export interface ActivityHistoryParams {
  limit?: number;
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  filter_by?: 'timestamp' | 'startTime' | 'endTime';
  include_meal_details?: boolean;
}

export interface ActivityHistoryResponse {
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
  meal_details?: {
    mealType: string;
    timestamp: string;
    nutrition?: Record<string, number>;
    bloodSugar?: number;
    intendedInsulin?: number;
  };
}

/**
 * Record new activities (expected or completed)
 */
export const recordActivities = async (data: RecordActivitiesData): Promise<RecordActivitiesResponse> => {
  // B-7 fix: was '/api/record-activities' — hardcoded path bypasses the v()
  // versioning helper in endpoints.ts. When USE_VERSIONED_API is set to true
  // this call would 404 while every other endpoint transparently upgrades.
  const response = await apiClient.post<RecordActivitiesResponse>(
    API.ACTIVITIES.CREATE,
    data
  );
  return response.data;
};

/**
 * Get activity history with optional filters
 */
export const getActivityHistory = async (params: ActivityHistoryParams = {}): Promise<ActivityHistoryResponse[]> => {
  // B-7 fix: was '/api/activity-history' — hardcoded path bypasses versioning helper.
  const response = await apiClient.get<ActivityHistoryResponse[]>(
    API.ACTIVITIES.HISTORY,
    { params }
  );
  return response.data;
};

/**
 * Get recent activities (last 5 by default)
 */
export const getRecentActivities = async (limit: number = 5): Promise<ActivityHistoryResponse[]> => {
  return getActivityHistory({ limit });
};

/**
 * Get activity by ID
 */
export const getActivityById = async (id: string): Promise<ActivityHistoryResponse> => {
  // B-7 fix: was `/api/activity/${id}` — hardcoded path bypasses versioning helper.
  const response = await apiClient.get<ActivityHistoryResponse>(API.ACTIVITIES.BY_ID(id));
  return response.data;
};

/**
 * Calculate duration between two ISO timestamps
 */
export const calculateDuration = (startTime: string, endTime: string): { 
  hours: number;
  minutes: number;
  totalHours: number;
  formatted: string;
} => {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end.getTime() - start.getTime();
  
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const totalHours = diffMs / (1000 * 60 * 60);
  
  return {
    hours,
    minutes,
    totalHours,
    formatted: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  };
};

/**
 * Calculate total activity impact
 */
export const calculateActivityImpact = (
  activities: ActivityRecord[],
  activityCoefficients: Record<string, number>
): number => {
  return activities.reduce((total, activity) => {
    const coefficient = activityCoefficients[activity.level.toString()] || 1.0;
    
    const { totalHours } = calculateDuration(activity.startTime, activity.endTime);
    const durationWeight = Math.min(totalHours / 2, 1);
    const weightedImpact = 1.0 + ((coefficient - 1.0) * durationWeight);
    
    return total * weightedImpact;
  }, 1.0);
};

export default {
  recordActivities,
  getActivityHistory,
  getRecentActivities,
  getActivityById,
  calculateDuration,
  calculateActivityImpact,
};