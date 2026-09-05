/**
 * Net Effect Integration
 * Combines baseline, cumulative effects, MOB, and IOB into a
 * single BG estimation with safety status and trend.
 *
 * Re-exports and wraps logic from blood-glucose-estimation.ts.
 *
 * Ports: backend/utils/pharmacodynamics.py (net effect calculation section)
 *
 * Changes (fix C-1):
 *   - calculateNetEffect() now accepts an optional activityPD parameter.
 *   - Extracts cumulative_activity_effect, sensitivity_multiplier, and
 *     activity_on_board from activityPD (snake_case — Option A confirmed).
 *   - Adds cumulativeActivityEffect to the net BG sum (NOT subtracted —
 *     the value is already signed negative for aerobic exercise).
 *   - Does NOT re-apply sensitivity_multiplier to correction_factor here;
 *     effective_correction_factor / effective_carb_to_bg_ratio in the PD
 *     response are pre-multiplied by the backend.
 *   - Exposes cumulativeActivityEffect, activitySensitivityMultiplier, and
 *     activityOnBoard on the returned NetEffectResult.
 *   - Null activityPD = zero effect; never breaks the BG pipeline.
 *
 * @module utils/calculations/net-effect
 * @version 2.0
 */

import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { PatientConstants } from '@/types/constants.types';
import type { PharmacodynamicProfile } from '@/types/pharmacodynamics.types';
import type { NetEffectResult, BaselineResult } from '@/types/calculation.types';
import type { AbsorptionType } from '@/types/meal.types';
import type { ActivityPDResult } from '@/services/api/activity-pharmacodynamics';

import {
  calculateNetEffect as _calculateNetEffect,
} from '@/utils/glucose/blood-glucose-estimation';

// ─── Extended result type ─────────────────────────────────────────────────────

/**
 * NetEffectResult extended with activity PD fields.
 * The three activity fields are always present (defaulting to 0 / 1.0 when
 * activityPD is null or absent).
 */
export interface NetEffectResultWithActivity extends NetEffectResult {
  /**
   * Signed BG contribution from exercise (mg/dL).
   * Negative = BG-lowering (aerobic default). Positive = BG-raising.
   * 0.0 when no activity data is available.
   */
  cumulativeActivityEffect: number;
  /**
   * Post-exercise ISF/CR sensitivity multiplier (≥ 1.0).
   * 1.0 = no boost.
   * ⚠️ effective_correction_factor in the PD response is pre-multiplied.
   *    Do NOT re-apply this multiplier to correction_factor here.
   */
  activitySensitivityMultiplier: number;
  /**
   * Unsigned total remaining acute BG drop (mg/dL). Analogous to IOB.
   * 0.0 when no activity data is available.
   */
  activityOnBoard: number;
}

// ─── Re-export result types ───────────────────────────────────────────────────
export type { NetEffectResult, BaselineResult };

/**
 * Calculate the complete net BG effect integrating all active interventions,
 * including exercise pharmacodynamics.
 *
 * This is the top-level calculation that produces all values shown in the
 * Active Effects Display:
 *
 *   estimatedBG      = baseline + cumulativeNetBaseline + cumulativeActivityEffect
 *   projectedFinalBG = estimatedBG + pendingMOBRise − pendingIOBReduction
 *   safetyStatus     = derived from estimatedBG + trend velocity
 *   trend            = derived from currentNetEffect (mg/dL change rate)
 *
 * Sign convention for activityPD (spec §6.3 / constraint list):
 *   cumulativeActivityEffect is ADDED (not subtracted) — it is already signed
 *   negative for BG-lowering aerobic exercise. No extra negation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  DOUBLE-COUNT WARNING — read before using the return value
 * ─────────────────────────────────────────────────────────────────────────────
 * `estimatedBG` in the returned object **already includes** `cumulativeActivityEffect`.
 * Downstream consumers MUST NOT add `cumulativeActivityEffect` (or any alias of
 * it such as `activityPD.cumulative_activity_effect`) to `estimatedBG` again.
 * Doing so double-counts exercise, making the estimated BG incorrectly low
 * during or after aerobic sessions.
 *
 * ⚠️  7TH-ARGUMENT PATH IS CURRENTLY DEAD CODE
 * ─────────────────────────────────────────────────────────────────────────────
 * Despite FIX D-2's original intent, NO production consumer passes `activityPD`
 * as the 7th argument. `useActiveEffects` was subsequently revised (Goal 3) to
 * use the delta approach instead — see below. If you are considering calling
 * this wrapper with a non-null `activityPD`, read this section first.
 *
 * DELTA PATTERN (both `useActiveEffects` dynamic mode AND AED):
 * `calculateStableBaselineFromReading` unwinds meal and insulin effects at the
 * reading timestamp but does NOT unwind the activity effect. The portion of
 * exercise that had already occurred when the reading was taken is therefore
 * baked into `stableBaseline`. Adding the full `cumulativeActivityEffect` would
 * double-count that portion.
 *
 * Both consumers apply only the NEW activity since the reading:
 *
 *   activityEffectAtReading   = calculateActivityEffectForCumulative(
 *                                 latestReading.timestamp,
 *                                 activityPD.activity_contributions,
 *                                 lastResetMs)
 *   activityDeltaSinceReading = cumulativeActivityEffect − activityEffectAtReading
 *   estimatedBG              += activityDeltaSinceReading   ← only new portion
 *
 * PRESET MODE EXCEPTION (`useActiveEffects`):
 * In preset mode the baseline is derived from the circadian profile, not a
 * reading, so no activity is pre-baked. The full `cumulativeActivityEffect` is
 * added directly (no delta subtraction). This is the one case where the
 * 7th-arg wrapper path would be safe to use, but for consistency the hook
 * applies it manually after the wrapper call.
 *
 * If you add a new consumer that calls this wrapper with `activityPD` non-null,
 * ensure its baseline is NOT reading-derived; otherwise you will double-count.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @param baseline           - Stable baseline (from calculateStableBaselineFromReading),
 *                             or null to fall back to patientConstants.target_glucose
 * @param meals              - Active meals
 * @param insulinDoses       - Active doses
 * @param currentTime        - Current timestamp
 * @param patientConstants   - Patient constants
 * @param absorptionProfiles - Absorption profile map keyed by AbsorptionType
 * @param activityPD         - Stacked activity PD response; null/undefined = zero effect.
 *                             ⚠️ See DEAD CODE warning above — no current consumer passes
 *                             a non-null value here. Both `useActiveEffects` and AED apply
 *                             the activity term manually after calling this wrapper with 6
 *                             arguments. When non-null, `estimatedBG` will include
 *                             `cumulative_activity_effect`, which is only safe when the
 *                             baseline is NOT reading-derived.
 * @returns Full net effect result with activity fields
 *
 * @example
 * // ✅ Correct — dynamic mode (useActiveEffects / AED delta pattern)
 * // activityPD is NOT passed; activity is applied manually as a delta after.
 * const netEffect = calculateNetEffect(
 *   baseline,
 *   meals,
 *   doses,
 *   new Date(),
 *   constants,
 *   MEAL_ABSORPTION_PROFILES,
 *   // ← activityPD intentionally omitted; wrapper called with 6 args only
 * );
 * const activityAtReading = calculateActivityEffectForCumulative(
 *   reading.timestamp, activityPD.activity_contributions, lastResetMs);
 * const estimatedBG = netEffect.estimatedBG
 *   + (activityPD.cumulative_activity_effect - activityAtReading);
 *
 * // ✅ Correct — preset mode (no reading-derived baseline; full amount safe)
 * // Still applied manually after the wrapper call for consistency.
 * const netEffect = calculateNetEffect(baseline, meals, doses, now, constants, profiles);
 * const estimatedBG = netEffect.estimatedBG + activityPD.cumulative_activity_effect;
 *
 * // ❌ WRONG — passing activityPD as 7th arg with a reading-derived baseline
 * // The reading already contains the pre-exercise BG drop → double-count.
 * const wrong = calculateNetEffect(
 *   readingDerivedBaseline, meals, doses, now, constants, profiles,
 *   activityPDResult,   // ← double-counts the portion baked into the baseline
 * );
 */
export function calculateNetEffect(
  baseline: BaselineResult | null,
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<AbsorptionType, PharmacodynamicProfile>,
  activityPD?: ActivityPDResult | null
): NetEffectResultWithActivity {

  // ── Extract activity fields (Option A — snake_case, no transform) ──────────
  // Default to zero effect when activityPD is null/undefined (network failure).
  const cumulativeActivityEffect     = activityPD?.cumulative_activity_effect ?? 0;
  const activitySensitivityMultiplier = activityPD?.sensitivity_multiplier     ?? 1.0;
  const activityOnBoard               = activityPD?.activity_on_board          ?? 0;

  // ── Run the core net-effect calculation (meals + insulin + baseline) ────────
  // blood-glucose-estimation.ts is NOT modified; activity adjustment is applied
  // as a post-processing step in this wrapper (per spec §STEP 3, point 6).
  const coreResult = _calculateNetEffect(
    baseline,
    meals,
    insulinDoses,
    currentTime,
    patientConstants,
    absorptionProfiles
  );

  // ── Add cumulativeActivityEffect to estimatedBG ────────────────────────────
  // ADD, never subtract — the value is already signed negative for aerobic.
  // (Spec §6.3 sign convention; constraint: "ADD it, never subtract — no extra negation")
  const adjustedEstimatedBG = (coreResult.estimatedBG ?? 0) + cumulativeActivityEffect;

  // Also adjust projectedFinalBG by the same delta if the field exists
  const adjustedProjectedBG = coreResult.projectedFinalBG != null
    ? coreResult.projectedFinalBG + cumulativeActivityEffect
    : coreResult.projectedFinalBG;

  return {
    ...coreResult,
    estimatedBG:    adjustedEstimatedBG,
    projectedFinalBG: adjustedProjectedBG,
    // ── Activity PD fields exposed for UI and downstream consumers ───────────
    cumulativeActivityEffect,
    activitySensitivityMultiplier,
    activityOnBoard,
  };
}

// ─── Utility helpers (unchanged) ─────────────────────────────────────────────

/**
 * Convenience: quickly check if a NetEffectResult needs urgent attention.
 *
 * Returns true for critical_low, critical_high, hypoglycemia_risk, or
 * hyperglycemia_risk statuses.
 */
export function requiresAttention(result: NetEffectResult): boolean {
  return (
    result.safetyStatus === 'critical_low' ||
    result.safetyStatus === 'critical_high' ||
    result.safetyStatus === 'hypoglycemia_risk' ||
    result.safetyStatus === 'hyperglycemia_risk'
  );
}

/**
 * Get a human-readable trend arrow string from a NetEffectResult.
 */
export function getTrendArrow(result: NetEffectResult): string {
  switch (result.trend) {
    case 'rising_rapidly':   return '⬆⬆';
    case 'rising':           return '⬆';
    case 'rising_slightly':  return '↗';
    case 'stable':           return '→';
    case 'falling_slightly': return '↘';
    case 'falling':          return '⬇';
    case 'falling_rapidly':  return '⬇⬇';
    default:                 return '—';
  }
}