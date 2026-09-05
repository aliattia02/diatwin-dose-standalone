/**
 * Auth Store
 * Location: mobile/store/auth.store.ts
 *
 * Main Store: useAuthStore
 * Description: Zustand store for authentication state management
 *
 * Features:
 * - User login and logout
 * - Token persistence
 * - Authentication state checking
 * - Error handling and clearing
 * - Platform-agnostic storage (web/native)
 */

import { create } from 'zustand';

// Services
import authService from '@/services/api/auth';
import type { LoginCredentials } from '@/services/api/auth';

// ─── JWT helper ───────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verifying the signature (client-side only).
 * Used exclusively to read the `exp` claim so we can detect expiry before
 * making a network request and avoid a silent 401 loop.
 */
const decodeTokenPayload = (token: string): Record<string, any> | null => {
  try {
    const base64 = token.split('.')[1];
    if (!base64) return null;
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/**
 * Returns true if the token exists AND its `exp` claim is still in the future.
 * A token without an `exp` claim is treated as non-expiring (valid).
 */
const isTokenValid = (token: string): boolean => {
  const payload = decodeTokenPayload(token);
  if (!payload) return false;
  if (!payload.exp) return true;
  return payload.exp > Math.floor(Date.now() / 1000);
};

// ─────────────────────────────────────────────────────────────────────────────

interface User {
  _id?: string;
  username?: string;
  email?: string;
  user_type?: 'patient' | 'doctor' | 'admin';
  firstName?: string;
  lastName?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  sharedConstants: Record<string, any> | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  sharedConstants: null,

  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });
    try {
      const userData = await authService.login(credentials);

      set({
        user: {
          firstName: userData.firstName,
          lastName: userData.lastName,
          user_type: userData.userType as 'patient' | 'doctor' | 'admin',
        },
        token: userData.token,
        isAuthenticated: true,
        isLoading: false,
        sharedConstants: await authService.getSharedConstants(),
      });
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Login failed';
      set({
        error: errorMessage,
        isLoading: false
      });
      throw error;
    }
  },

  logout: async () => {
    // DON'T set isLoading: true here - it unmounts the navigator!
    try {
      await authService.logout();
    } catch (error) {
      console.error('Logout error:', error);
    }
    // Set all state at once, keeping isLoading: false
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const token = await authService.getStoredToken();

      // Validate token exists and hasn't expired client-side.
      // This prevents a silent 401 loop when an old 24h token is stored.
      if (token && isTokenValid(token)) {
        const userData = await authService.getStoredUserData();

        set({
          user: userData ? {
            firstName: userData.firstName,
            lastName: userData.lastName,
            user_type: userData.userType as 'patient' | 'doctor' | 'admin',
          } : null,
          token,
          isAuthenticated: true,
          isLoading: false,
          sharedConstants: await authService.getSharedConstants(),
        });
      } else {
        // Token missing or expired — clear storage and send to login
        if (token) {
          console.log('[AuthStore] Stored token expired — clearing credentials');
          await authService.logout();
        }
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('Error checking auth:', error);
      set({
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));

export default useAuthStore;