/**
 * API Connectivity Utilities
 * Location: mobile/utils/connectivity.ts
 *
 * Description: Check API server connectivity and provide user-friendly error messages
 *
 * Features:
 * - API server reachability testing
 * - Latency measurement
 * - User-friendly error messages
 * - Platform-specific connectivity tips
 * - URL formatting for display
 */

import { Platform } from 'react-native';

// Services
import { apiClient, getBaseUrl } from '@/services/api/client';

export interface ConnectivityStatus {
  isConnected: boolean;
  apiReachable: boolean;
  apiUrl: string;
  latency?: number;
  error?: string;
}

/**
 * Check if the API server is reachable
 * Returns status with latency and error details
 */
export const checkApiConnectivity = async (): Promise<ConnectivityStatus> => {
  const apiUrl = getBaseUrl();
  const startTime = Date.now();

  try {
    // FIX: /api/doctors is patient-only and returns 403 for doctor tokens,
    // which the apiClient interceptor rethrows even with validateStatus: () => true.
    // /api/doctor/patients returns 200 for doctors — safe for all authenticated users.
    const response = await apiClient.get('/api/doctor/patients', {
      timeout: 5000,
      validateStatus: () => true, // Accept any status code
    });

    const latency = Date.now() - startTime;

    return {
      isConnected: true,
      apiReachable: response.status < 500,
      apiUrl,
      latency,
    };
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    let errorMessage = 'Unknown error';

    if (error instanceof Error) {
      if (error.message.includes('Network Error')) {
        errorMessage = 'Network Error - Cannot reach server';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Request timeout - Server too slow or unreachable';
      } else {
        errorMessage = error.message;
      }
    }

    return {
      isConnected: false,
      apiReachable: false,
      apiUrl,
      latency,
      error: errorMessage,
    };
  }
};

/**
 * Get a user-friendly error message for connectivity issues
 */
export const getConnectivityErrorMessage = (status: ConnectivityStatus): string => {
  if (status.apiReachable) {
    return '';
  }

  if (status.error?.includes('Network Error')) {
    return `Cannot connect to server at ${status.apiUrl}. Please check:\n` +
      '• Your internet connection\n' +
      '• The server is running\n' +
      '• The API URL is correct in your .env file';
  }

  if (status.error?.includes('timeout')) {
    return `Server at ${status.apiUrl} is not responding. The server may be overloaded or unreachable.`;
  }

  return status.error || 'Unable to connect to the server';
};

/**
 * Format the API URL for display (hiding sensitive parts if any)
 */
export const formatApiUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
};

/**
 * Get platform-specific connectivity tips
 */
export const getConnectivityTips = (): string[] => {
  const tips = [
    'Make sure the backend server is running',
    'Check that EXPO_PUBLIC_API_URL is set correctly in mobile/.env',
  ];

  if (Platform.OS !== 'web') {
    tips.push('On physical devices, use your computer\'s network IP address (not localhost)');
    tips.push('Ensure your phone and computer are on the same network');
  }

  return tips;
};

export default {
  checkApiConnectivity,
  getConnectivityErrorMessage,
  formatApiUrl,
  getConnectivityTips,
};