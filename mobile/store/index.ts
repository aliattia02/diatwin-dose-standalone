/**
 * Store Barrel Export
 * Location: mobile/store/index.ts
 * 
 * Description: Central export point for all Zustand stores
 * 
 * Features:
 * - Re-exports all store hooks
 * - Re-exports default store instances
 * - Re-exports store-specific types
 */

export { useAuthStore, default as authStore } from './auth.store';
export { usePatientStore, default as patientStore } from './patient.store';
export { useOfflineStore, default as offlineStore } from './offline.store';
export { useMealStore } from './meal.store';

// Re-export store-specific types
export type { OfflineAction } from './offline.store';