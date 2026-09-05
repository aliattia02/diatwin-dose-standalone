/**
 * Form Validation Utilities
 * Location: mobile/utils/validation.ts
 *
 * Description: Form validation helpers for the mobile app with shared validators
 *
 * Features:
 * - Re-exports shared library validators
 * - Email and password validation
 * - Username validation
 * - Date of birth validation
 * - Portion and activity validation
 * - Combined form validation helper
 */

// Import from the validation subdirectory (not from self!)
import {
  validateGlucoseReading,
  validateInsulinDose,
  validateCarbs,
  GLUCOSE_LIMITS,
  INSULIN_LIMITS,
  type ValidationResult,
} from './validation/input-validators';

// Re-export shared validators
export {
  validateGlucoseReading,
  validateInsulinDose,
  validateCarbs,
  GLUCOSE_LIMITS,
  INSULIN_LIMITS,
};
export type { ValidationResult };

/**
 * Validate required field
 */
export const validateRequired = (value: unknown, fieldName: string): ValidationResult => {
  if (value === undefined || value === null || value === '') {
    return { isValid: false, errors: [`${fieldName} is required`], warnings: [] };
  }
  return { isValid: true, errors: [], warnings: [] };
};

/**
 * Validate email format
 */
export const validateEmail = (email: string): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!email) {
    errors.push('Email is required');
    return { isValid: false, errors, warnings };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    errors.push('Invalid email format');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Validate password strength
 */
export const validatePassword = (password: string): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!password) {
    errors.push('Password is required');
    return { isValid: false, errors, warnings };
  }

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  // Check for at least one letter and one number
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one letter and one number');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Validate username
 */
export const validateUsername = (username: string): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!username) {
    errors.push('Username is required');
    return { isValid: false, errors, warnings };
  }

  if (username.length < 3) {
    errors.push('Username must be at least 3 characters');
  }

  if (username.length > 30) {
    errors.push('Username must be at most 30 characters');
  }

  // Allow letters, numbers, underscores, and hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, underscores, and hyphens');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Validate date of birth
 */
export const validateDateOfBirth = (dateString: string): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!dateString) {
    errors.push('Date of birth is required');
    return { isValid: false, errors, warnings };
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    errors.push('Invalid date format');
    return { isValid: false, errors, warnings };
  }

  const now = new Date();
  const minAge = new Date(now.getFullYear() - 120, now.getMonth(), now.getDate());
  const maxAge = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  if (date < minAge || date > maxAge) {
    errors.push('Invalid date of birth');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Validate portion size
 */
export const validatePortion = (portion: number): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (portion === undefined || portion === null) {
    errors.push('Portion is required');
    return { isValid: false, errors, warnings };
  }

  if (isNaN(portion) || portion <= 0) {
    errors.push('Portion must be a positive number');
  }

  if (portion > 10000) {
    errors.push('Portion seems too large');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Validate activity duration
 */
export const validateActivityDuration = (duration: string): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!duration) {
    errors.push('Duration is required');
    return { isValid: false, errors, warnings };
  }

  // Expected format: HH:MM
  const durationRegex = /^(\d{1,2}):(\d{2})$/;
  const match = duration.match(durationRegex);

  if (!match) {
    errors.push('Duration must be in HH:MM format');
    return { isValid: false, errors, warnings };
  }

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours > 24 || minutes > 59) {
    errors.push('Invalid duration');
  }

  if (hours === 0 && minutes === 0) {
    errors.push('Duration must be greater than 0');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Validate activity level
 */
export const validateActivityLevel = (level: number): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (level === undefined || level === null) {
    errors.push('Activity level is required');
    return { isValid: false, errors, warnings };
  }

  if (![-2, -1, 0, 1, 2].includes(level)) {
    errors.push('Invalid activity level');
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Combined form validation helper
 */
export interface FormValidationRule {
  field: string;
  value: unknown;
  validate: (value: unknown) => ValidationResult;
}

export const validateForm = (rules: FormValidationRule[]): Record<string, string> => {
  const errors: Record<string, string> = {};

  for (const rule of rules) {
    const result = rule.validate(rule.value);
    if (!result.isValid && result.errors.length > 0) {
      errors[rule.field] = result.errors[0]; // Use first error
    }
  }

  return errors;
};