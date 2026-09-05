/**
 * Environment configuration for the mobile app
 * Reads from Expo constants or falls back to defaults
 *
 * For local development: set EXPO_PUBLIC_API_URL=http://localhost:5000 in .env
 * For Render deployment: set EXPO_PUBLIC_API_URL=https://native-3y3j.onrender.com in .env
 */

import Constants from 'expo-constants';

interface AppConfig {
  apiUrl: string;
  apiVersion: string;
  useVersionedEndpoints: boolean;
}

// Get configuration from expo constants or use defaults
const getConfig = (): AppConfig => {
  const extra = Constants.expoConfig?.extra || {};

  return {
    apiUrl: extra.apiUrl || process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000',
    apiVersion: extra.apiVersion || process.env.EXPO_PUBLIC_API_VERSION || 'v1',
    // Set to false to use non-versioned endpoints (for compatibility with current backend)
    useVersionedEndpoints: extra.useVersionedEndpoints ?? false,
  };
};

export const config = getConfig();

/**
 * Build the full API endpoint URL
 * @param endpoint - The endpoint path (e.g., '/login')
 * @returns Full URL with optional version prefix
 */
export const buildApiUrl = (endpoint: string): string => {
  const { apiUrl, apiVersion, useVersionedEndpoints } = config;

  // If endpoint already has /api prefix, use as-is
  if (endpoint.startsWith('/api')) {
    if (useVersionedEndpoints && !endpoint.includes(`/api/${apiVersion}`)) {
      // Insert version after /api
      return `${apiUrl}${endpoint.replace('/api', `/api/${apiVersion}`)}`;
    }
    return `${apiUrl}${endpoint}`;
  }

  // Build URL with or without version
  if (useVersionedEndpoints) {
    return `${apiUrl}/api/${apiVersion}${endpoint}`;
  }
  return `${apiUrl}${endpoint}`;
};

export default config;