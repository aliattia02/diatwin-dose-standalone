/**
 * Auth hook wrapping auth store with navigation integration.
 *
 * Changes in this version:
 *  - Added `wakeUpServer` from client.ts so login automatically warms the
 *    Render free-tier dyno before sending credentials.
 *  - Exposes `isWakingUp` + `wakeProgress` so the login screen can show
 *    a friendly "Server starting…" progress bar instead of a frozen spinner.
 *  - `login()` now runs the wakeup poll first (skipped for localhost).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { useAuthStore } from '@/store/auth.store';
import type { LoginCredentials, RegisterData } from '@/services/api/auth';
import { register as apiRegister } from '@/services/api/auth';
import { wakeUpServer, type WakeProgress } from '@/services/api/client';

// ─── Public API ───────────────────────────────────────────────────────────────

export const useAuth = () => {
  const router     = useRouter();
  const segments   = useSegments();
  const navState   = useRootNavigationState();

  const {
    user,
    token,
    isAuthenticated,
    isLoading,
    error,
    login: storeLogin,
    logout: storeLogout,
    checkAuth,
    clearError,
  } = useAuthStore();

  // Wake-up state (shown in login UI before the actual login request fires)
  const [isWakingUp,   setIsWakingUp]   = useState(false);
  const [wakeProgress, setWakeProgress] = useState<WakeProgress>({
    percent: 0,
    message: '',
    ready:   false,
  });

  // Prevent duplicate wakeup calls if the user taps Sign In twice quickly
  const wakeInProgress = useRef(false);

  // ── Navigation guard ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navState?.key) return;
    if (isLoading)      return;

    const inAuthGroup = segments[0] === '(auth)';

    if (isAuthenticated && inAuthGroup) {
      router.replace('/(app)/(tabs)');
    } else if (!isAuthenticated && !inAuthGroup && segments[0] !== undefined) {
      router.replace('/(auth)/login');
    }
  }, [isAuthenticated, isLoading, segments, navState?.key]);

  // ── login — wakes server first, then authenticates ─────────────────────────
  const login = useCallback(async (credentials: LoginCredentials) => {
    // Guard: don't start two wakeup polls simultaneously
    if (wakeInProgress.current) return;
    wakeInProgress.current = true;

    try {
      setIsWakingUp(true);
      setWakeProgress({ percent: 0, message: 'Connecting to server…', ready: false });

      const serverReady = await wakeUpServer((progress) => {
        setWakeProgress(progress);
      });

      setIsWakingUp(false);

      if (!serverReady) {
        // wakeUpServer already logged the error; surface it to the user
        throw new Error(
          'The server did not respond in time.\n' +
          'Please check your connection and try again.'
        );
      }

      // Server is awake — proceed with login
      await storeLogin(credentials);
    } finally {
      wakeInProgress.current = false;
      setIsWakingUp(false);
    }
  }, [storeLogin]);

  // ── logout ──────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    await storeLogout();
    // Navigation handled by the useEffect guard above
  }, [storeLogout]);

  // ── register ────────────────────────────────────────────────────────────────
  const register = useCallback(async (data: RegisterData) => {
    return apiRegister(data);
  }, []);

  return {
    user,
    token,
    isAuthenticated,
    isLoading,
    isWakingUp,
    wakeProgress,
    error,
    login,
    logout,
    register,
    checkAuth,
    clearError,
  };
};

export default useAuth;