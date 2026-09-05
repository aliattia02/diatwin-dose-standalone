/**
 * Calculations — Public API
 * Single entry point for all Phase 2 calculation utilities.
 *
 * Import from here instead of reaching into sub-files:
 *
 * @example
 * import {
 *   calculateTotalCumulativeEffects,
 *   calculateStableBaselineFromReading,
 *   calculateNetEffect,
 * } from '@/utils/calculations';
 *
 * @module utils/calculations
 */

// ─── Cumulative Effects ───────────────────────────────────────────────────────
export {
  getDailyResetTime,
  calculateMealCumulativeEffect,
  calculateInsulinCumulativeEffect,
  calculateTotalCumulativeEffects,
  // P1 fix (§9): shared lock-in model — consumed by useActiveEffects, AED, EVC, BGV
  calculateActivityEffectForCumulative,
  type CumulativeEffectsResult,
  type ActivityEffectContribution,
} from './cumulative-effects';

// ─── Baseline ─────────────────────────────────────────────────────────────────
export {
  calculateStableBaselineFromReading,
  assessBaselineConfidence,
  type BaselineResult,
} from './baseline';

// ─── Net Effect ───────────────────────────────────────────────────────────────
export {
  calculateNetEffect,
  requiresAttention,
  getTrendArrow,
  type NetEffectResult,
} from './net-effect';