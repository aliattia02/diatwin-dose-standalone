/**
 * Meal Store
 * Location: mobile/store/meal.store.ts
 *
 * Main Store: useMealStore
 * Description: Zustand store for meal logging state management
 *
 * Features:
 * - Active insulin tracking
 * - Recent meals caching
 * - Error handling
 * - Loading states
 */

import { create } from 'zustand';

// Services
import { getActiveInsulin } from '@/services/api/insulin';
import { getMeals } from '@/services/api/meals';

interface MealState {
  activeInsulin: number;
  patientConstants: any;
  recentMeals: any[];
  isLoading: boolean;
  error: string | null;

  // Actions
  updateActiveInsulin: (value: number) => void;
  fetchActiveInsulin: () => Promise<void>;
  fetchRecentMeals: () => Promise<void>;
  clearError: () => void;
}

export const useMealStore = create<MealState>((set) => ({
  activeInsulin: 0,
  patientConstants: null,
  recentMeals: [],
  isLoading: false,
  error: null,

  updateActiveInsulin: (value) => {
    set({ activeInsulin: value });
  },

  fetchActiveInsulin: async () => {
    try {
      const result = await getActiveInsulin();
      set({ activeInsulin: result.total_active_insulin || 0 });
    } catch (error) {
      console.error('Failed to fetch active insulin:', error);
      set({ error: 'Failed to load active insulin' });
    }
  },

  fetchRecentMeals: async () => {
    set({ isLoading: true, error: null });
    try {
      const result = await getMeals({ limit: 10 });
      set({
        recentMeals: result.meals || [],
        isLoading: false
      });
    } catch (error) {
      console.error('Failed to fetch recent meals:', error);
      set({
        error: 'Failed to load recent meals',
        isLoading: false
      });
    }
  },

  clearError: () => {
    set({ error: null });
  }
}));