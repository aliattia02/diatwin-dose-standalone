/**
 * Navigation Type Definitions
 * Location: mobile/types/navigation.ts
 *
 * Description: Type-safe routing definitions for all navigation stacks and screens
 *
 * Features:
 * - Auth stack param types (login, register, forgot-password)
 * - Main tabs param types (dashboard, log, history, profile)
 * - Nested stack param types (log, meal, settings)
 * - Type-safe screen props helper
 */

// Types
import type { User, Patient, PatientConstants } from '@/types';

// Re-export for convenience
export type { User, Patient, PatientConstants };

/**
 * Auth stack param list
 */
export type AuthStackParamList = {
  login: undefined;
  register: undefined;
  'forgot-password': undefined;
};

/**
 * Main app tabs param list
 */
export type TabsParamList = {
  index: undefined;     // Dashboard/Home
  log: undefined;       // Quick log
  history: undefined;   // History
  profile: undefined;   // Profile/Settings
};

/**
 * Log stack param list
 */
export type LogStackParamList = {
  meal: undefined;
  glucose: undefined;
  insulin: undefined;
  activity: undefined;
};

/**
 * Meal stack param list
 */
export type MealStackParamList = {
  '[id]': { id: string };
};

/**
 * Settings stack param list
 */
export type SettingsStackParamList = {
  constants: undefined;
  medications: undefined;
  export: undefined;
};

/**
 * Root stack param list combining all navigators
 */
export type RootStackParamList = {
  '(auth)': AuthStackParamList;
  '(app)': {
    '(tabs)': TabsParamList;
    log: LogStackParamList;
    meal: MealStackParamList;
    settings: SettingsStackParamList;
  };
  '+not-found': undefined;
};

/**
 * Screen props helper type
 */
export interface ScreenProps<T extends keyof RootStackParamList> {
  route: {
    params: RootStackParamList[T];
  };
}