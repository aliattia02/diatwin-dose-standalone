/**
 * Utils Barrel Export
 * Location: mobile/utils/index.ts
 *
 * Description: Central export point for all utility functions
 *
 * Features:
 * - Re-exports time utilities
 * - Re-exports insulin utilities
 * - Re-exports glucose utilities
 * - Re-exports validation utilities
 * - Re-exports storage utilities (AsyncStorage, SecureStore)
 * - Re-exports network utilities
 * - Re-exports connectivity utilities
 */

// ============================================================================
// TIME UTILITIES
// ============================================================================
export * from './time';

// ============================================================================
// INSULIN UTILITIES
// ============================================================================
export * from './insulin';

// ============================================================================
// GLUCOSE UTILITIES
// ============================================================================
export * from './glucose';

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================
export * from './validation';

// ============================================================================
// MOBILE-SPECIFIC UTILITIES
// ============================================================================

// Storage utilities (AsyncStorage, SecureStore)
export * from './storage';

// Network utilities (platform-specific)
export * from './network';

// Connectivity utilities (API connectivity checking)
export * from './connectivity';