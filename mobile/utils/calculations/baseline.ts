/**
 * Stable Baseline Calculation
 * Derives the patient's metabolic baseline from a blood glucose reading
 * by "unwinding" all cumulative meal and insulin effects.
 *
 * Re-exports and wraps logic from blood-glucose-estimation.ts.
 *
 * Ports: backend/utils/pharmacodynamics.py::calculate_stable_baseline_from_reading()
 *
 * @module utils/calculations/baseline
 * @version 1.0
 */

import type { GlucoseReading } from '@/types/glucose.types';
import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { PatientConstants } from '@/types/constants.types';
import type { PharmacodynamicProfile } from '@/types/pharmacodynamics.types';
import type { BaselineResult } from '@/types/calculation.types';
import type { AbsorptionType } from '@/types/meal.types';

import {
  calculateStableBaselineFromReading as _calculateStableBaselineFromReading,
} from '@/utils/glucose/blood-glucose-estimation';

import { BASELINE_HARD_MIN, BASELINE_HARD_MAX } from '@/constants/shared-constants';

// ─── Re-export the result type ───────────────────────────────────────────────
export type { BaselineResult };

/**
 * Calculate the patient's stable metabolic baseline from a blood glucose reading.
 *
 * Formula:
 *   Baseline = Reading − (CumulativeMealEffect − CumulativeInsulinEffect)
 *
 * "Stable Baseline" represents what the patient's blood glucose would be
 * if all active meals and insulin had already fully resolved — essentially
 * their fasting / resting BG level for the current day.
 *
 * Key behaviours:
 * - Only meals/doses AFTER today's reset are considered
 * - Uses the reading timestamp (not current time) to calculate effects AT
 *   the moment of the reading, giving a true snapshot
 * - Fully absorbed events (past their duration) are treated as 100% absorbed
 * - Returns a warnings array if the baseline looks physiologically implausible
 *
 * Direct port of:
 *   backend/utils/pharmacodynamics.py::calculate_stable_baseline_from_reading()
 *
 * @param reading               - The most recent blood glucose reading
 * @param meals                 - All meals in the current daily window
 * @param insulinDoses          - All doses in the current daily window
 * @param currentTime           - Current timestamp (used only for reset calculation)
 * @param patientConstants      - Patient constants (carb_to_bg_factor, correction_factor …)
 * @param absorptionProfiles    - Absorption profile map keyed by AbsorptionType
 * @param resetHour             - Daily reset hour 0–23 (default 7)
 * @param timezoneOffsetMinutes - Patient UTC offset in minutes (default 0)
 * @returns Baseline result with breakdown and confidence score
 *
 * @example
 * const baseline = calculateStableBaselineFromReading(
 *   latestReading,   // { value: 140, timestamp: '...' }
 *   meals,
 *   doses,
 *   new Date(),
 *   constants,
 *   MEAL_ABSORPTION_PROFILES,
 *   7,    // reset at 7 AM
 *   -300  // EST
 * );
 * // baseline.stableBaseline ≈ 95 mg/dL
 * // baseline.cumulativeMealEffect ≈ 60 mg/dL (absorbed carbs so far)
 * // baseline.cumulativeInsulinEffect ≈ 15 mg/dL (absorbed insulin so far)
 */
export function calculateStableBaselineFromReading(
  reading: GlucoseReading,
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<AbsorptionType, PharmacodynamicProfile>,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): BaselineResult {
  return _calculateStableBaselineFromReading(
    reading,
    meals,
    insulinDoses,
    currentTime,
    patientConstants,
    absorptionProfiles,
    resetHour,
    timezoneOffsetMinutes
  );
}

// ─── Baseline Bounds & Clamping ──────────────────────────────────────────────

/** Physiological hard limits — outside these, the baseline is nonsensical. */
export const BASELINE_BOUNDS = {
  HARD_MIN: BASELINE_HARD_MIN,  // mg/dL — incompatible with consciousness below this
  HARD_MAX: BASELINE_HARD_MAX,  // mg/dL — no T1D has a true fasting baseline above this
} as const;

export type BaselineSanitizeStatus = 'ok' | 'hard_clamped';

export interface SanitizedBaseline {
  /** Final value to use for estimation */
  value: number;
  /** Raw value before clamping */
  rawValue: number;
  /** What was done to the raw value */
  status: BaselineSanitizeStatus;
  /** Warnings to surface to the user */
  warnings: string[];
}

/**
 * Apply hard physiological clamps to a raw dynamic baseline.
 *
 * Decision tree:
 *   raw < 55  → clamp to 55 + CRITICAL warning (likely unlogged insulin)
 *   raw > 220 → clamp to 220 + CRITICAL warning (likely unlogged meal)
 *   otherwise → use as-is, no warnings
 *
 * Intentionally does NOT do soft-blending toward the circadian model —
 * values inside the hard bounds are passed through unchanged regardless
 * of how unusual they look.
 *
 * @param rawBaseline - stableBaseline from calculateStableBaselineFromReading()
 */
export function sanitizeBaseline(rawBaseline: number): SanitizedBaseline {
  const { HARD_MIN, HARD_MAX } = BASELINE_BOUNDS;
  const warnings: string[] = [];

  if (rawBaseline < HARD_MIN) {
    warnings.push(
      `CRITICAL: Baseline ${rawBaseline.toFixed(0)} mg/dL is physiologically impossible. ` +
      `Likely cause: unlogged insulin dose. Clamped to ${HARD_MIN} mg/dL.`
    );
    return { value: HARD_MIN, rawValue: rawBaseline, status: 'hard_clamped', warnings };
  }

  if (rawBaseline > HARD_MAX) {
    warnings.push(
      `CRITICAL: Baseline ${rawBaseline.toFixed(0)} mg/dL is physiologically impossible. ` +
      `Likely cause: unlogged meal. Clamped to ${HARD_MAX} mg/dL.`
    );
    return { value: HARD_MAX, rawValue: rawBaseline, status: 'hard_clamped', warnings };
  }

  return { value: rawBaseline, rawValue: rawBaseline, status: 'ok', warnings };
}

/**
 * Determine whether a baseline result is reliable enough to use for BG estimation.
 *
 * Confidence degrades when:
 * - The reading is very old (stale)
 * - The baseline value is physiologically implausible (< 40 or > 300)
 * - There are many unmatched meal/insulin events (high stacking complexity)
 *
 * @param baseline      - The baseline result to assess
 * @param readingAgeMs  - Milliseconds since the reading was taken
 * @returns Confidence score 0.0 – 1.0
 */
export function assessBaselineConfidence(
  baseline: BaselineResult,
  readingAgeMs: number
): number {
  let confidence = 1.0;

  // Penalise stale readings (confidence halves every 2 hours)
  const ageHours = readingAgeMs / (1000 * 60 * 60);
  if (ageHours > 0.5) {
    confidence *= Math.exp(-0.35 * (ageHours - 0.5));
  }

  // Penalise implausible baselines
  if (baseline.stableBaseline < 40 || baseline.stableBaseline > 300) {
    confidence *= 0.5;
  }

  // Penalise heavy stacking (>4 simultaneous events)
  const totalEvents = baseline.mealsCount + baseline.insulinCount;
  if (totalEvents > 4) {
    confidence *= Math.max(0.6, 1 - (totalEvents - 4) * 0.05);
  }

  return Math.min(1.0, Math.max(0.0, confidence));
}