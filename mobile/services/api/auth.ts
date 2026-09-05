/**
 * mobile/services/api/auth.ts - Authentication service for the mobile app
 */

import apiClient from './client';
import API from './endpoints'; // Use default import
import { secureStorage, STORAGE_KEYS } from '../../utils/storage';

// Type definitions
export interface LoginCredentials {
  username: string;
  password: string;
  user_type: 'patient' | 'doctor' | 'admin';
}

export interface RegisterData {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  user_type: 'patient' | 'doctor' | 'admin';
}

export interface UserData {
  token: string;
  userType: 'patient' | 'doctor' | 'admin';
  firstName: string;
  lastName: string;
}

interface LoginResponse {
  message: string;
  token: string;
  user_type: string;
  firstName: string;
  lastName: string;
  shared_constants?: Record<string, any>;
}

interface RegisterResponse {
  message: string;
  id: string;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verifying the signature.
 * We only use this to read the `exp` claim on the client side;
 * the server always re-validates the signature on every request.
 */
const decodeTokenPayload = (token: string): Record<string, any> | null => {
  try {
    const base64 = token.split('.')[1];
    if (!base64) return null;
    // atob works in React Native's Hermes / JSC runtime
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/**
 * Returns true if the token exists AND its `exp` claim is still in the future.
 * A missing `exp` is treated as non-expiring (valid).
 */
const isTokenValid = (token: string): boolean => {
  const payload = decodeTokenPayload(token);
  if (!payload) return false;
  if (!payload.exp) return true;                        // no expiry set
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp > nowSec;
};

/**
 * Login user and store token
 */
export const login = async (credentials: LoginCredentials): Promise<UserData> => {
  console.log('[Auth Service] Login request:', JSON.stringify({
    username: credentials.username,
    user_type: credentials.user_type
  }));

  const response = await apiClient.post<LoginResponse>(API.AUTH.LOGIN, credentials);

  console.log('[Auth Service] Login successful:', {
    user_type: response.data.user_type,
    firstName: response.data.firstName,
  });

  const userData: UserData = {
    token: response.data.token,
    userType: response.data.user_type as 'patient' | 'doctor' | 'admin',
    firstName: response.data.firstName,
    lastName: response.data.lastName,
  };

  // Store token and user data securely
  await secureStorage.set(STORAGE_KEYS.AUTH_TOKEN, userData.token);
  await secureStorage.set(STORAGE_KEYS.USER_DATA, JSON.stringify(userData));

  // Store shared constants if provided by the server
  if (response.data.shared_constants) {
    await secureStorage.set(
      STORAGE_KEYS.SHARED_CONSTANTS,
      JSON.stringify(response.data.shared_constants)
    );
    console.log('[Auth Service] Shared constants stored from login response');
  }

  console.log('[Auth Service] User data stored successfully');

  return userData;
};

/**
 * Register a new user
 */
export const register = async (data: RegisterData): Promise<RegisterResponse> => {
  console.log('[Auth Service] Register request:', JSON.stringify({
    username: data.username,
    email: data.email,
    user_type: data.user_type,
  }));

  const response = await apiClient.post<RegisterResponse>(API.AUTH.REGISTER, data);

  console.log('[Auth Service] Registration successful:', response.data);

  return response.data;
};

/**
 * Logout user and clear stored data
 */
export const logout = async (): Promise<void> => {
  try {
    // Optionally call logout endpoint if backend has one
    // await apiClient.post(API.AUTH.LOGOUT);
    console.log('[Auth Service] Logging out user');
  } catch (error) {
    console.warn('[Auth Service] Logout API call failed:', error);
  }

  // Clear stored auth data
  await secureStorage.remove(STORAGE_KEYS.AUTH_TOKEN);
  await secureStorage.remove(STORAGE_KEYS.USER_DATA);

  console.log('[Auth Service] User data cleared');
};

/**
 * Check if user is authenticated.
 * Validates that a token exists AND hasn't expired (client-side check).
 * If the token is expired, it is cleared from storage automatically so the
 * user is sent back to the login screen rather than getting stuck with 401s.
 */
export const isAuthenticated = async (): Promise<boolean> => {
  try {
    const token = await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) return false;

    if (!isTokenValid(token)) {
      console.log('[Auth Service] Stored token has expired — clearing credentials');
      await secureStorage.remove(STORAGE_KEYS.AUTH_TOKEN);
      await secureStorage.remove(STORAGE_KEYS.USER_DATA);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Auth Service] Error checking authentication:', error);
    return false;
  }
};

/**
 * Get stored auth token
 */
export const getStoredToken = async (): Promise<string | null> => {
  try {
    return await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);
  } catch (error) {
    console.error('[Auth Service] Error getting stored token:', error);
    return null;
  }
};

/**
 * Get stored user data
 */
export const getStoredUserData = async (): Promise<UserData | null> => {
  try {
    const data = await secureStorage.get(STORAGE_KEYS.USER_DATA);
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  } catch (error) {
    console.error('[Auth Service] Error getting stored user data:', error);
    return null;
  }
};

/**
 * Refresh token (placeholder for future implementation)
 */
export const refreshToken = async (): Promise<string | null> => {
  // TODO: Implement token refresh when backend supports it
  return null;
};

/**
 * Get stored shared constants (written on login from the server response)
 */
export const getSharedConstants = async (): Promise<Record<string, any> | null> => {
  try {
    const data = await secureStorage.get(STORAGE_KEYS.SHARED_CONSTANTS);
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  } catch (error) {
    console.error('[Auth Service] Error getting shared constants:', error);
    return null;
  }
};

// Default export for convenience
const authService = {
  login,
  register,
  logout,
  isAuthenticated,
  getStoredToken,
  getStoredUserData,
  getSharedConstants,
  refreshToken,
};

export default authService;