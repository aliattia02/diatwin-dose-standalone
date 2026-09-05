/**
 * Forms Barrel Export
 * Location: mobile/components/forms/index.ts
 *
 * Main Exports: All form components and types
 * Description: Central export point for all form-related components,
 *              including unified components and backward-compatible wrappers
 *
 * Features:
 * - Unified components (recommended for new code)
 * - Backward compatibility wrappers (for existing code)
 * - Centralized type exports
 * - Clear documentation of export purposes
 */

// ==========================================
// UNIFIED COMPONENTS (Recommended for new code)
// ==========================================

// Time Picker
export { default as UnifiedTimePicker } from './UnifiedTimePicker';
export type { TimeMode, UnifiedTimePickerProps } from './UnifiedTimePicker';

// Activity Components
export { default as UnifiedActivityInput } from './UnifiedActivityInput';
export type { UnifiedActivity } from './UnifiedActivityInput';

// Blood Sugar Components
export { default as UnifiedBloodSugarInput } from './UnifiedBloodSugarInput';
export type {
  BloodSugarData,
  GlucoseUnit,
} from './UnifiedBloodSugarInput';

// Insulin Components
export { default as UnifiedInsulinInput } from './UnifiedInsulinInput';
export type {
  InsulinData,
} from './UnifiedInsulinInput';

// Meal Components
export { default as MealForm } from './MealForm';
export type {
  MealFormData,
  MealCalculationResult,
} from './MealForm';

// ==========================================
// BACKWARD COMPATIBILITY (For existing screens)
// ==========================================




// BloodSugarInput - Direct export of UnifiedBloodSugarInput (no wrapper needed)
export { default as BloodSugarInput } from './UnifiedBloodSugarInput';

// Activity Recording - Alias for UnifiedActivityInput
export { default as ActivityRecording } from './UnifiedActivityInput';