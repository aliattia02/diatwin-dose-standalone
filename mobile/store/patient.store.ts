/**
 * Patient Store
 * Location: mobile/store/patient.store.ts
 *
 * Main Store: usePatientStore
 * Description: Zustand store for managing patient constants and settings with caching
 *
 * Features:
 * - Load and cache patient constants from API
 * - Update patient constants locally and remotely
 * - Active conditions and medications tracking
 * - 5-minute cache for constants
 * - Automatic fallback to defaults on error
 * - Medication schedules management
 */

import { create } from 'zustand';

// Types
import type { PatientConstants } from '@/types/constants.types';
import type { PatientConstantsResponse } from '@/types/api';

// Constants
import { DEFAULT_PATIENT_CONSTANTS } from '@/constants';

// Services
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

// Utils
import { storage, STORAGE_KEYS } from '@/utils/storage';

interface PatientState {
  constants: PatientConstants | null;
  activeConditions: string[];
  activeMedications: string[];
  medicationSchedules: Record<string, {
    id: string;
    startDate: string;
    endDate: string;
    dailyTimes: string[];
  }>;
  isLoading: boolean;
  error: string | null;
  lastFetched: number | null;

  // Actions
  loadConstants: () => Promise<void>;
  updateConstants: (constants: Partial<PatientConstants>) => Promise<void>;
  getConstant: <K extends keyof PatientConstants>(key: K) => PatientConstants[K];
  clearConstants: () => void;
}

export const usePatientStore = create<PatientState>((set, get) => ({
  constants: null,
  activeConditions: [],
  activeMedications: [],
  medicationSchedules: {},
  isLoading: false,
  error: null,
  lastFetched: null,

  loadConstants: async () => {
    set({ isLoading: true, error: null });

    // ── PHASE 1: Immediately populate from cache ──────────────────────────────
    // Read whatever is in storage right now — even stale — and put it in state
    // before making any network call.  This eliminates the flash where
    // `constants` is null for the duration of the API round-trip, which caused:
    //   render 1 → constants=null  → effectiveConstants = DEFAULT (CF=40, carb=4)
    //   render 2 → constants=real  → effectiveConstants = server  (CF=70, carb=10)
    // producing the "normal then extreme" two-pass calculation flicker.
    //
    // After Phase 1, `constants` is either:
    //   a) the last-known server values  (cache hit)
    //   b) still null                    (first-ever install, no cache yet)
    //
    // `isLoading` stays TRUE in both cases — the guards in usePatientConstants
    // and useActiveEffects hold all calculations until Phase 2 completes, so no
    // calc ever fires against stale/default constants.
    let hasCachedConstants = false;
    try {
      const cached = await storage.getJSON<{
        constants: PatientConstants;
        activeConditions: string[];
        activeMedications: string[];
        lastFetched: number;
      }>(STORAGE_KEYS.PATIENT_CONSTANTS);

      if (cached?.constants) {
        hasCachedConstants = true;
        const isFresh =
          cached.lastFetched != null &&
          Date.now() - cached.lastFetched < 5 * 60 * 1000;

        // Populate state immediately with cached values.
        // isLoading stays true — Phase 2 (API fetch) still needs to run unless fresh.
        set({
          constants: cached.constants,
          activeConditions: cached.activeConditions || [],
          activeMedications: cached.activeMedications || [],
          lastFetched: cached.lastFetched ?? null,
          // Only mark done if cache is genuinely fresh — callers will skip Phase 2.
          ...(isFresh ? { isLoading: false } : {}),
        });

        if (isFresh) {
          // Cache is fresh — no need to hit the network this cycle.
          return;
        }
        // Cache is stale: fall through to Phase 2 with isLoading still true.
      }
    } catch {
      // Storage read failed — proceed to Phase 2 with isLoading still true.
    }

    // ── PHASE 2: Fetch fresh constants from API ───────────────────────────────
    // isLoading is still true here, so the constantsLoading guard in
    // usePatientConstants / useActiveEffects / ActiveEffectsDisplay will block
    // all calculations until this resolves — even if Phase 1 already populated
    // state with stale cached values.
    try {
      const response = await apiClient.get<PatientConstantsResponse>(API.PATIENT.CONSTANTS);
      const data = response.data.constants;

      const now = Date.now();

      // Persist to cache so Phase 1 on the next mount is instant.
      await storage.set(STORAGE_KEYS.PATIENT_CONSTANTS, {
        constants: data,
        activeConditions: data.active_conditions || [],
        activeMedications: data.active_medications || [],
        lastFetched: now,
      });

      set({
        constants: data,
        activeConditions: data.active_conditions || [],
        activeMedications: data.active_medications || [],
        medicationSchedules: data.medication_schedules || {},
        isLoading: false,
        error: null,
        lastFetched: now,
      });
    } catch (error) {
      console.error('Error loading patient constants:', error);

      if (hasCachedConstants) {
        // Phase 1 already populated the store with cached values — just release
        // the loading flag so the UI can proceed with what we have.
        set({
          isLoading: false,
          error: 'Using cached data — failed to reach server',
        });
      } else {
        // No cache at all — last resort: fall back to defaults so the app
        // doesn't stay in an infinite loading state on first install with no network.
        set({
          constants: DEFAULT_PATIENT_CONSTANTS,
          activeConditions: [],
          activeMedications: [],
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load constants',
        });
      }
    }
  },

  updateConstants: async (newConstants: Partial<PatientConstants>) => {
    set({ isLoading: true, error: null });
    try {
      // TODO: Implement API endpoint for updating constants
      // For now, just update locally
      const currentConstants = get().constants || DEFAULT_PATIENT_CONSTANTS;
      const updatedConstants = { ...currentConstants, ...newConstants };

      // Update cache
      await storage.set(STORAGE_KEYS.PATIENT_CONSTANTS, {
        constants: updatedConstants,
        activeConditions: get().activeConditions,
        activeMedications: get().activeMedications,
        lastFetched: Date.now(),
      });

      set({
        constants: updatedConstants,
        isLoading: false,
        lastFetched: Date.now(),
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to update constants',
      });
      throw error;
    }
  },

  getConstant: <K extends keyof PatientConstants>(key: K): PatientConstants[K] => {
    const { constants } = get();
    if (constants && key in constants) {
      return constants[key];
    }
    return DEFAULT_PATIENT_CONSTANTS[key];
  },

  clearConstants: () => {
    storage.remove(STORAGE_KEYS.PATIENT_CONSTANTS);
    set({
      constants: null,
      activeConditions: [],
      activeMedications: [],
      medicationSchedules: {},
      lastFetched: null,
      error: null,
    });
  },
}));

export default usePatientStore;