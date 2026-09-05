/**
 * Cumulative Effects Calculation
 * Daily accumulated meal and insulin effects with timezone-aware reset
 *
 * ─── v4.4 FIX: PERSIST-AT-100% (matches backend Phase 3 behaviour) ────────────
 *
 * ROOT CAUSE of frontend/backend mismatch in estimatedBG / cumulativeNetBaseline:
 *
 *   Backend `calculate_meal_cumulative_effect` (pharmacodynamics.py line 709):
 *     if current_time >= end_time:
 *       return total_carbs * carb_to_bg_factor   # ← PERSISTS at full value
 *
 *   Backend `calculate_insulin_cumulative_effect` (pharmacodynamics.py line 780):
 *     if current_time >= end_time:
 *       return -(dose_amount * correction_factor) # ← PERSISTS at full value
 *
 *   The previous frontend implementation delegated to blood-glucose-estimation.ts
 *   which did NOT implement this Phase 3 persist behaviour, returning 0 (or the
 *   last partial value) once absorption duration elapsed.
 *
 * FIX SUMMARY:
 *   - `calculateMealCumulativeEffect` now detects Phase 3 (hours-since >= duration)
 *     and returns the FULL carb×factor effect, delegating only Phase 1/2 to the
 *     underlying blood-glucose-estimation implementation.
 *   - `calculateInsulinCumulativeEffect` similarly returns -(dose×CF) for Phase 3.
 *   - `calculateTotalCumulativeEffects` is rewritten to call the FIXED sub-functions
 *     directly so that every meal/dose benefits from persist-at-100%.
 *
 * ─── v4.5 FIX: PHASE 3 INSULIN CRASH + SENSITIVITY MULTIPLIER BUG ────────────
 *
 * BUG 1 (crash): `calculateInsulinCumulativeEffect` Phase 3 branch referenced
 *   `tzOffsetMinutes` which is not defined in scope — the parameter is named
 *   `timezoneOffsetMinutes`. This caused a ReferenceError on every chart render,
 *   silently swallowed by generateChartData's try-catch, leaving the chart empty.
 *
 * BUG 2 (visual — green line drops without new insulin):
 *   Phase 3 used `overrideCorrectionFactor` (= CF × sensitivityMultiplier(t)) as
 *   the correction factor for fully-absorbed doses. Because sensitivityMultiplier(t)
 *   is time-varying (it ramps up during exercise), the Phase 3 contribution became
 *   more negative as the exercise sensitivity window grew — causing the green
 *   cumulative "bank balance" line to drop even with no new insulin.
 *
 *   Fix: Phase 3 always uses the BASE correction_factor. The dose is fully
 *   absorbed — its BG-lowering action already happened at the base rate and cannot
 *   be retroactively enlarged by a later exercise session. The override is only
 *   valid for Phases 1 & 2 (active partial absorption inside the exercise window).
 *
 * ─── v4.6 FIX: PHASE 3 MEAL SENSITIVITY MULTIPLIER BUG ──────────────────────
 *
 * BUG (visual — green line drops without new meals):
 *   `buildChartPoint` in EffectsVisualizationChart patches
 *   `effectiveC2BForCumulative = carb_to_bg_factor / sensitivityMultiplier(t)` into
 *   `patientConstantsForCumulative.carb_to_bg_factor` and passes it to
 *   `calculateTotalCumulativeEffects → calculateMealCumulativeEffect`.
 *   Phase 3 meals read `patientConstants.carb_to_bg_factor` directly — now the
 *   OVERRIDDEN value — so their locked-in contribution shrinks as
 *   sensitivityMultiplier(t) grows.  A day with 60 g of fully-absorbed carbs
 *   (C2B = 4 → +240 banked) loses ~55 mg/dL from the bank balance when
 *   sensitivityMultiplier reaches 1.3, making the green line plunge even though
 *   the exercise direct effect is only −7 mg/dL.
 *
 *   Fix: `calculateMealCumulativeEffect` now accepts an optional
 *   `overrideCarbToBGFactor` parameter.  Phase 3 always uses the BASE
 *   `carb_to_bg_factor` from patientConstants (ignoring any override), identical
 *   to the v4.5 pattern for Phase 3 insulin.  Phase 1 & 2 inject the override
 *   into a patched constants copy (same pattern as `_calculateInsulinCumulativeEffect`).
 *   `calculateTotalCumulativeEffects` accepts and forwards the parameter.
 *   `buildChartPoint` no longer puts effectiveC2B inside patientConstantsForCumulative;
 *   it passes it as the dedicated `overrideCarbToBGFactor` argument instead.
 *
 * IMPORTANT — caller responsibility:
 *   Pass ALL meals/doses from the current daily window (not just still-absorbing
 *   ones). Fully-absorbed meals must be included so their persisted effect is
 *   counted. See ActiveEffectsDisplay.tsx `allMealsInWindow` for the pattern.
 *
 * ─── v4.8 FIX: ACTIVITY RAMP OVERCOUNT + PHASE 2→3 C2B TRANSITION LEAK ──────
 *
 * BUG A (green line plateau at wrong height — visible during/after active session):
 *   `calculateActivityEffectForCumulative` computed:
 *     fullEffect = cumulative_bg_effect + bgDir * remaining_bg_drop
 *   where both fields are frozen snapshots from the API response (evaluated at "now").
 *   For historical chart points (left of the "now" line), the during-session ramp used
 *     frac × fullEffect
 *   where `frac` is the fraction of the session elapsed at T_target, but `fullEffect`
 *   is the TOTAL eventual drop as computed at T_now.  For T_target < T_now and the
 *   session still in progress at T_now, `fullEffect` is larger than the actual drop
 *   delivered by T_target — the ramp overshoots, and the post-session plateau locks in
 *   at a higher level than physiologically occurred at T_target.
 *
 *   Fix: add a `nowMs` parameter (default Date.now()).  For T_target ≤ T_now the ramp
 *   back-scales from `cumulative_bg_effect` (the authoritative delivered amount at T_now):
 *     effectAtTarget = cumulative_bg_effect × (fracAtTarget / fracAtNow)
 *   For T_target > T_now (future points), the full `fullEffect` is used as before.
 *   For post-session points (T_target > endMs) the lock-in is unchanged.
 *
 *   All four consumers (EVC, BGV, AED, useActiveEffects) are updated to pass
 *   their reference "now" timestamp as the fourth argument.  Callers that don't pass
 *   it fall back to Date.now() — safe for AED / useActiveEffects which always evaluate
 *   at "now" anyway.
 *
 * BUG B (step-change up on green line at Phase 2→3 meal transition):
 *   `calculateMealCumulativeEffect` delegates Phase 1/2 to `_calculateMealCumulativeEffect`
 *   with `overrideCarbToBGFactor` patched into the constants object.  However
 *   `_calculateMealCumulativeEffect` has its OWN internal Phase 3 check — so if this
 *   wrapper's `hoursSince` and the inner function's `hoursSinceMeal` diverge at all
 *   (floating-point, different Date instances, profile resolution differences), a meal
 *   right at the boundary can hit the inner Phase 3 branch with the patched (lower)
 *   C2B and return `totalCarbs × (C2B / sensitivityMultiplier)`.  On the next chart tick
 *   the wrapper catches Phase 3 first and returns the correct base-C2B value — producing
 *   a one-tick step up visible as the green line jump after meal absorption ends.
 *
 *   Fix: suppress the override for the final 0.1 h (6 min) before the Phase 2→3
 *   boundary — a `safeOverrideC2B` guard that zeroes the override when
 *   `hoursSince >= durationHours − 0.1`.  This tiny blind spot at the transition is
 *   visually imperceptible but eliminates the step artifact completely.
 *
 * ─── v4.11 FIX: DOUBLE-PHASE-3-CHECK ROOT CAUSE (green line step w/o exercise) ─
 *
 * ROOT CAUSE of the persistent green-line step-down-then-snap-up (visible even
 * with zero exercise, proving sensitivity/override code was not the cause):
 *
 *   The outer `calculateMealCumulativeEffect` wrapper delegated Phase 1/2 to
 *   `_calculateMealCumulativeEffect` (blood-glucose-estimation.ts).  These two
 *   functions resolved the meal timestamp through DIFFERENT code paths:
 *
 *     Outer:  parseUTCMs((meal as any).timestamp)  — reads only .timestamp
 *     Inner:  getMealTimestamp(meal)               — tries .timestamp ?? .meal_time
 *                                                    ?? .logged_at ?? .created_at
 *
 *   If they landed on different fields, or if sub-millisecond floating-point
 *   differences crept in, the inner function's own
 *   `if (hoursSinceMeal >= profile.durationHours)` Phase 3 check fired at a
 *   different chart tick than the outer's check — producing a one-tick value
 *   inconsistency that rendered as the step artifact.
 *
 *   The same race existed for insulin: the outer wrapper used
 *   `medicationFactors[insulinType].duration_hours` for the Phase 3 check while
 *   the inner `_calculateInsulinCumulativeEffect` used `getInsulinProfile()` for
 *   IOB calculation.  Mismatched `duration_hours` values caused Phase 3 to fire
 *   at different ticks in the two functions.
 *
 * FIX SUMMARY:
 *   Eliminate the inner-function delegates entirely.  Both
 *   `calculateMealCumulativeEffect` and `calculateInsulinCumulativeEffect` now
 *   resolve their profile ONCE (before the Phase 3 check) and compute the
 *   absorbed / IOB fraction INLINE using the same `hoursSince` and the same
 *   profile.  There is now exactly ONE Phase 3 check per item — the double-
 *   Phase-3-check race is structurally impossible.
 *
 *   • Meal Phase 1/2: `calculateAbsorbedFraction(hoursSince, pdProfile)` from
 *     meal-pharmacodynamics.ts — same function the inner was using.
 *   • Insulin Phase 1/2: `calculateIOB(hoursSince, 1.0, pkProfile)` from
 *     insulin/pharmacodynamics.ts — same function the inner was using.
 *   • The `safeOverrideC2B` (0.1 h guard) is retained as belt-and-suspenders.
 *
 * ─── v4.12 FIX: INSULINTYPE REFERENCEERROR + PHASE 2→3 REVERT STEP ────────────
 *
 * BUG 1 (crash — blank chart): `calculateInsulinCumulativeEffect` called
 *   `getInsulinPKProfile(insulinType)` but `insulinType` was never declared in
 *   the function scope.  The variable was mentioned in the surrounding comment
 *   (carried over from the old outer-wrapper architecture) but the actual
 *   extraction from `dose` was omitted during the v4.11 inline refactor.
 *   Every call threw `ReferenceError: insulinType is not defined`, silently
 *   caught by `generateChartData`'s try-catch — chart rendered blank.
 *
 *   Fix: extract `insulinType` from the dose object before use:
 *     `(dose as any).insulinType ?? (dose as any).medication ?? 'rapid'`
 *   Mirrors the extraction pattern used in EffectsVisualizationChart.tsx line 244.
 *
 * BUG 2 (visual — green line reverts upward at absorption end during exercise):
 *   When a dose finishes absorbing while the exercise sensitivity window is active
 *   (`sensitivityMultiplierAtTime > 1.005`), the Phase 2→3 boundary produces a
 *   discontinuity:
 *
 *     Phase 2 final tick: `-(doseAmount × absorptionFraction × effectiveCF)`
 *       where effectiveCF = baseCF × sensitivityMultiplier  (e.g. 40 × 1.3 = 52)
 *       and absorptionFraction ≈ 1.0  →  returns ≈ −520 (for 10u dose)
 *
 *     Phase 3 first tick: `-(doseAmount × baseCF)`  (v4.5 fix)
 *       →  returns −400
 *
 *   The insulin contribution jumps from −520 to −400 (120 mg/dL less negative).
 *   cumulativeNetBaseline = meals + insulin → increases by 120 → green line step up.
 *   Step magnitude = doseAmount × baseCF × (sensitivityMultiplier − 1).
 *
 *   Fix: clamp the Phase 3 entry so it is never less negative than the Phase 2
 *   exit value.  `Math.min` picks the more-negative of the two:
 *     phase3    = -(doseAmount × baseCF)
 *     phase2Exit = -(doseAmount × (overrideCorrectionFactor ?? baseCF))
 *     return Math.min(phase3, phase2Exit)
 *
 *   Once the exercise window closes (sensitivityMultiplierAtTime ≤ 1.005), the
 *   v4.7 guard in buildChartPoint sets overrideCorrectionFactor = undefined, so
 *   phase2Exit collapses to -(doseAmount × baseCF) = phase3 — the clamp becomes
 *   a no-op and Phase 3 correctly returns baseCF with no phantom growth.
 *
 * BUG 3 (visual — same revert step for meals, opposite sign):
 *   During exercise, `overrideCarbToBGFactor = baseCarbToBGFactor / sensitivityMultiplier`
 *   which is LESS than baseCarbToBGFactor (carbs raise BG less when insulin is more
 *   effective).  At the Phase 2→3 boundary:
 *
 *     Phase 2 final tick: `totalCarbs × absorbedFraction × (baseCarbToBGFactor / multiplier)`
 *       ≈ totalCarbs × (baseCarbToBGFactor / 1.3)  →  smaller positive value
 *
 *     Phase 3 first tick: `totalCarbs × baseCarbToBGFactor`  (v4.6 fix)
 *       →  larger positive value
 *
 *   cumulativeMealEffect jumps up → green line step up, identical symptom.
 *
 *   Additionally the previous `safeOverrideC2B` guard (zero out override within
 *   0.1 h of Phase 2→3) was the old partial mitigation for the double-Phase-3-check
 *   bug fixed in v4.11.  Its original purpose is gone, but it remained in the code
 *   and introduced its OWN step: at `hoursSince = durationHours − 0.1` the C2B
 *   silently snapped from overrideC2B to baseCarbToBGFactor — a 6-minute-early
 *   upward step that replaced the Phase-3-boundary step.
 *
 *   Fix:
 *     1. Remove `safeOverrideC2B` — its double-Phase-3 purpose is gone and it
 *        causes the 0.1 h step.  Use `overrideCarbToBGFactor` directly for Phase 1/2.
 *     2. Clamp Phase 3 entry: `Math.min(phase3, phase2Exit)` where both values are
 *        positive.  Math.min returns the smaller (less positive) value, preventing
 *        the jump from the reduced Phase 2 exit up to the base Phase 3 value.
 *        Same mechanics as the insulin clamp — just applied to positive values.
 *
 * ─── v4.13 FIX: POST-SESSION LOCK-IN RECOVERY (green line rebounds upward) ────
 *
 * ROOT CAUSE: v4.9 split the post-session branch of `calculateActivityEffectForCumulative`
 *   by `targetMs <= nowMs` (historical) vs `targetMs > nowMs` (future):
 *     Historical: lock at `cumulative_bg_effect`  (live API snapshot at T_now)
 *     Future:     lock at `fullEffect`             (total eventual drop)
 *
 *   `cumulative_bg_effect` is a live API snapshot, not a fixed historical record.
 *   When T_now advances past endMs (session is fully over), a completed session's
 *   `cumulative_bg_effect` equals `fullEffect` (all drop delivered). BUT the v4.9
 *   split made the historical post-session branch lock at `cumulative_bg_effect`
 *   rather than `fullEffect`, so when `remaining_bg_drop > 0` (stale API snapshot)
 *   the lock-in level was lower than `fullEffect`. On the NEXT chart refresh when
 *   T_now had advanced further, those same historical points re-evaluated — and
 *   if they had crossed the nowMs boundary, they'd switch to the future branch and
 *   jump up to `fullEffect`.  Visually: the green cumulative line appeared to
 *   gradually recover (move less negative) after the session ended.
 *
 *   Additionally, the snap-up that v4.9 was trying to prevent (a step at endMs for
 *   ACTIVE sessions where T_now < endMs) is already eliminated by the v4.10
 *   during-session future ramp: the ramp reaches `fullEffect` at exactly endMs,
 *   so the post-session lock-in at `fullEffect` is C⁰-continuous with the ramp —
 *   no special-casing needed.
 *
 * FIX: Remove the `targetMs <= nowMs` split from the post-session branch.
 *   Lock in unconditionally at `fullEffect` for ALL post-session points.
 *   The `nowMs` parameter is still used by the during-session branches (v4.8/v4.10).
 *
 * ─── v4.14 FIX: UNIVERSAL CUMULATIVE FLOOR (sensitivity-boost mountain shape) ─
 *
 * ROOT CAUSE (same as insulinBoostData blue-band fix in EffectsVisualizationChart):
 *   `calculateInsulinCumulativeEffect` Phase 1/2 returns
 *     -(doseAmount × absorptionFraction × effectiveCF)
 *   where effectiveCF = correctionFactor × sensitivityMultiplierAtTime.
 *   As sensitivityMultiplierAtTime decays post-exercise (e.g. 1.3 → 1.005),
 *   effectiveCF shrinks at every subsequent chart tick → the per-point
 *   contribution becomes LESS negative → a time-series sweep over these values
 *   exhibits a downward mountain: it deepens, peaks, then rises back toward 0.
 *   The green cumulative line (and any downstream time-series consumer) rises
 *   even while doses are still absorbing.
 *
 * FIX: New exported utility `applyInsulinCumulativeFloor`.
 *   Call this on any time-ordered array of cumulative-effects results after all
 *   points are built.  It applies a running-min ratchet to
 *   `cumulativeInsulinEffect`: the value may only go deeper (more negative),
 *   never shallower.  The same delta propagates to `cumulativeNetBaseline` so
 *   the net line stays correct.  The floor resets when
 *   |cumulativeInsulinEffect| < 0.1 (no doses on board / daily reset boundary).
 *
 * CONSUMERS that must call this utility:
 *   • EffectsVisualizationChart  — replaces the inline post-pass added previously.
 *   • BloodGlucoseVisualization  — any chart that sweeps calculateTotalCumulativeEffects
 *                                   across a time axis.
 *   • Any future time-series builder that iterates over chart points.
 *
 * NOT applicable to point-in-time hooks (useActiveEffects, useBloodGlucoseEstimation):
 *   those evaluate at a single "now" timestamp — the floor concept requires
 *   a time-ordered series of values to compare against.
 *
 * @module utils/calculations/cumulative-effects
 * @version 4.14
 */

import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { PatientConstants } from '@/types/constants.types';
import type { PharmacodynamicProfile } from '@/types/pharmacodynamics.types';
import type { AbsorptionType } from '@/types/meal.types';
import type { MealAbsorptionProfile } from '@/constants/shared-constants';

import {
  getDailyResetTime as _getDailyResetTime,
  getLastResetTime as _getLastResetTime,
  type CumulativeEffectsResult,
} from '@/utils/glucose/blood-glucose-estimation';

// Used for inline Phase 1/2 meal absorption computation (fix: eliminates
// double-Phase-3-check by removing the delegate to _calculateMealCumulativeEffect).
import {
  calculateAbsorbedFraction,
  toPharmacodynamicProfile,
} from '@/utils/glucose/meal-pharmacodynamics';

// Used for inline Phase 1/2 insulin absorption computation (fix: eliminates
// double-Phase-3-check by removing the delegate to _calculateInsulinCumulativeEffect).
import {
  calculateIOB,
  getInsulinProfile as getInsulinPKProfile,
} from '@/utils/insulin/pharmacodynamics';

import {
  calculateStackedActivityEffect,
  type NormalizedActivity,
  type ActivityContribution,
} from '@/utils/activity/activity-pharmacodynamics';

// ─── Re-export types so callers don't need to reach into the sub-modules ─────
export type { CumulativeEffectsResult, ActivityContribution };

/**
 * Extends the base CumulativeEffectsResult with the activity (exercise)
 * pharmacodynamic term — the third signed term in the daily bank-balance model.
 *
 * cumulativeNetBaseline = cumulativeMealEffect
 *                       + cumulativeInsulinEffect   (negative)
 *                       + cumulativeActivityEffect   (negative for aerobic, positive for anaerobic)
 */
export interface ExtendedCumulativeEffectsResult extends CumulativeEffectsResult {
  /** Signed mg/dL contribution from all exercise sessions (negative = BG-lowering) */
  cumulativeActivityEffect: number;
  /** Per-session breakdown — mirrors activity_contributions from the backend */
  activityContributions: ActivityContribution[];
}

// ─── Internal UTC timestamp parser ───────────────────────────────────────────
// Handles three input types:
//   1. number  — already UTC milliseconds (from processContextMealsForChart)
//   2. numeric string — e.g. "1742274240000" (number coerced to string)
//   3. ISO string — bare (no Z) or with timezone indicator
//
// ✅ FIX: processContextMealsForChart converts meal.timestamp to a number before
// passing meals to buildChartData, which then calls calculateTotalCumulativeEffects.
// The previous implementation only accepted strings, so calling .endsWith() on a
// number crashed with "ts.endsWith is not a function".
function parseUTCMs(ts: string | number | null | undefined): number {
  if (ts === null || ts === undefined || ts === '') return NaN;
  // Fast-path: already a number (UTC ms)
  if (typeof ts === 'number') return ts;
  // Numeric string fast-path: all digits → treat as ms timestamp
  if (/^\d+$/.test(ts)) return parseInt(ts, 10);
  // ISO string: append 'Z' for bare strings that have no timezone indicator
  const hasZone =
    ts.endsWith('Z') ||
    ts.includes('+') ||
    /T.*-\d{2}:\d{2}$/.test(ts);
  return hasZone
    ? new Date(ts).getTime()
    : new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Get the daily reset timestamp for a patient in their local timezone.
 */
export function getDailyResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  return _getDailyResetTime(date, resetHour, timezoneOffsetMinutes);
}

/**
 * Get the most recent past reset time (yesterday's reset if before today's reset hour).
 * Re-exported so callers can compute the same daily boundary used here.
 */
export function getLastResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  return _getLastResetTime(date, resetHour, timezoneOffsetMinutes);
}

/**
 * Get the NEXT upcoming reset time — used to cap Phase 3 persist-at-100%
 * so that events from the current window don't bleed into the next day.
 */
function getNextResetTimeMs(currentTime: Date, resetHour: number, tzOffsetMinutes: number): number {
  const lastResetMs = _getLastResetTime(currentTime, resetHour, tzOffsetMinutes).getTime();
  return lastResetMs + 24 * 60 * 60 * 1000;
}

/**
 * Calculate the cumulative BG elevation from a single meal since today's reset.
 *
 * ─── Phase 3 (persist-at-100%) FIX ───────────────────────────────────────────
 * When a meal has fully absorbed (hours-since >= duration) its effect is held at
 * `totalCarbs × carb_to_bg_factor` until the daily reset — matching backend
 * pharmacodynamics.py lines 707-710 ("THIS IS THE CRITICAL FIX").
 *
 * Returns 0 if the meal was eaten before today's reset.
 *
 * @returns Cumulative BG elevation in mg/dL — POSITIVE value (>= 0).
 */
export function calculateMealCumulativeEffect(
  meal: Meal,
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<string, PharmacodynamicProfile | MealAbsorptionProfile>,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0,
  overrideCarbToBGFactor?: number,  // ← Phase 1 & 2 only — Phase 3 ignores this (v4.6 fix)
  absorptionReferenceTime?: Date,   // ← v4.10: when set, hoursSince uses this instead of
                                    //   currentTime.  Freezes the absorption ramp at "now"
                                    //   for future chart points while currentTime continues
                                    //   to own the daily-reset boundary check.
  resolvePhase3OverrideC2B?: (absorptionEndMs: number) => number | undefined
                                    // ← v4.13 FIX: when provided, called with the meal's
                                    //   absorption-end timestamp to produce a FROZEN C2B
                                    //   for the Phase 3 clamp (phase2Exit).  Prevents the
                                    //   clamp value from drifting as sensitivityMultiplier
                                    //   decays after the sensitivity window closes.
): number {
  // Parse meal timestamp as UTC
  const mealMs = parseUTCMs((meal as any).timestamp);
  if (isNaN(mealMs)) return 0;

  // Skip future meals — guard uses currentTime (targetTime) so future meals
  // added to allMealsUpToNow before their own timestamp are excluded correctly.
  if (mealMs > currentTime.getTime()) return 0;

  // ── CRITICAL: Check daily reset BEFORE Phase 3 ────────────────────────────
  // Phase 3 (persist-at-100%) must NOT apply to meals from before today's reset.
  // The base _calculateMealCumulativeEffect performs this check in Phases 1 & 2,
  // but we short-circuit to Phase 3 before calling it. Without this guard, a meal
  // eaten before the daily reset hour that has fully absorbed would be included
  // in the current day's cumulative effect — the bank balance would never reset.
  //
  // NOTE (v4.10): always uses currentTime (= targetTime) for the reset check so
  // the 07:00 future-zone reset drop is enforced even when absorptionReferenceTime
  // is capped at "now".
  const lastResetMs = _getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes).getTime();
  if (mealMs < lastResetMs) return 0;

  // ── Resolve absorption profile — shared by Phase 3 and Phase 1/2 ─────────
  // Done ONCE here so BOTH the Phase 3 duration check AND the Phase 1/2
  // absorbed-fraction computation use the EXACT same profile object and the
  // exact same `hoursSince`.  Previously the outer wrapper resolved the profile
  // independently from `_calculateMealCumulativeEffect` (which used its own
  // `getMealTimestamp` fallback chain), creating a race at the Phase 2→3
  // boundary: if the two functions computed `hoursSinceMeal` from different
  // fields, the inner function's Phase 3 could fire a tick earlier or later than
  // the outer's, producing the visible step artifact in the green line.
  const absType: string =
    (meal as any).calculation_summary?.absorption_type ??
    (meal as any).nutrition?.absorption_type ??
    (meal as any).nutrition?.absorptionType ??
    'medium';
  const rawProfile: any =
    (absorptionProfiles as any)[absType] ??
    (absorptionProfiles as any)['medium'];
  const pdProfile = toPharmacodynamicProfile(rawProfile);
  const durationHours: number = pdProfile.durationHours;

  // ── Extract carbs once — shared by Phase 3 and Phase 1/2 ─────────────────
  // Extended fallback chain covers all meal shapes:
  //   • meal.carbEquiv         — set by processContextMealsForChart (doctor chart path)
  //   • calculation_summary    — set by backend for patient chart path
  //   • nutrition.*            — various field-name variants
  const rawNutrition: any = (meal as any).nutrition ?? {};
  const totalCarbs: number =
    (meal as any).carbEquiv                              ??  // processContextMealsForChart
    (meal as any).calculation_summary?.total_carb_equiv  ??
    rawNutrition.total_carb_equiv                        ??
    rawNutrition.totalCarbEquiv                          ??
    rawNutrition.totalCarbs                              ??
    rawNutrition.carbs                                   ??
    0;
  if (totalCarbs <= 0) return 0;

  // Base C2B — Phase 3 always uses this; Phase 1/2 may apply an exercise override.
  // v4.6 FIX: Phase 3 must never use overrideCarbToBGFactor — the meal is fully
  // absorbed; its BG-raising action already happened at the base rate and cannot
  // be retroactively reduced by a later exercise session.
  const baseCarbToBGFactor: number =
    (patientConstants as any).carb_to_bg_factor ??
    (patientConstants as any).carb_to_bg_ratio ??
    4.0;

  // ── v4.10: Use absorptionReferenceTime for hoursSince when provided ────────
  // For future chart points buildChartPoint passes absorptionReferenceTime = now,
  // freezing the absorbed-fraction at its "now" value — the green line is flat in
  // the future zone for still-absorbing meals instead of continuing the gamma ramp.
  // currentTime is kept for all boundary checks (reset window, Phase 3 cap).
  const absorptionMs = (absorptionReferenceTime ?? currentTime).getTime();
  const hoursSince = (absorptionMs - mealMs) / (1000 * 60 * 60);

  // ── Phase 3: After absorption completes — PERSIST at full effect ─────────
  // Matches backend pharmacodynamics.py:
  //   if current_time >= end_time:
  //     return total_carbs * carb_to_bg_factor  # PERSISTS until next reset
  // CRITICAL: also cap at the next reset so meals from the current window
  // don't persist into the following day.
  if (hoursSince >= durationHours) {
    const nextResetMs = getNextResetTimeMs(currentTime, resetHour, timezoneOffsetMinutes);
    if (mealMs >= lastResetMs && mealMs < nextResetMs) {
      // v4.6: Phase 3 always uses base C2B — absorption complete, no retroactive scaling.
      const phase3 = totalCarbs * baseCarbToBGFactor;
      // v4.12 FIX: clamp so Phase 3 entry is never more positive than Phase 2 exit.
      // During exercise overrideCarbToBGFactor = baseCarbToBGFactor / sensitivityMultiplier
      // which is LESS than baseCarbToBGFactor, so Phase 2 exit < Phase 3 — the green
      // line would jump up at the boundary.  Math.min returns the smaller (less positive)
      // value, keeping the line continuous.  Once the exercise window closes,
      // overrideCarbToBGFactor becomes undefined → phase2Exit === phase3 → no-op.
      //
      // v4.13 FIX: freeze the C2B used for phase2Exit at the moment absorption completed.
      // The resolver evaluates sensitivityMultiplierAtTime(mealMs + durationHours × 3600s),
      // which is constant per meal regardless of the current chart-point time.  Without
      // this, using the chart-point's decaying multiplier caused phase2Exit to become
      // more positive at every subsequent chart tick → Phase 3 drifted upward ~120 mg/dL.
      const absorptionEndMsMeal = mealMs + durationHours * 3_600_000;
      const frozenOverrideC2B = resolvePhase3OverrideC2B
        ? resolvePhase3OverrideC2B(absorptionEndMsMeal)
        : overrideCarbToBGFactor;
      const phase2Exit = totalCarbs * (frozenOverrideC2B ?? baseCarbToBGFactor);
      return Math.min(phase3, phase2Exit);
    }
    return 0;
  }

  // ── Phase 1 & 2: inline absorbed-fraction computation ────────────────────
  //
  // ─── ROOT-CAUSE FIX (eliminates double-Phase-3-check architecture) ────────
  //
  // Previous architecture delegated Phase 1/2 to _calculateMealCumulativeEffect
  // (blood-glucose-estimation.ts), which resolved the meal timestamp through its
  // own getMealTimestamp() helper (trying .timestamp ?? .meal_time ?? .logged_at
  // ?? .created_at) and computed a SECOND `hoursSinceMeal`.  If even a sub-
  // millisecond floating-point difference or a different field landed between the
  // outer's `hoursSince` and the inner's `hoursSinceMeal`, both functions had their
  // own `if (hoursSinceMeal >= profile.durationHours)` check — and the inner could
  // fire Phase 3 one chart-tick earlier than the outer.
  //
  // In the no-exercise case: inner early-Phase-3 fired, returning totalCarbs × C2B
  // (same value as Phase 3), but the inner function's profile resolution could
  // also differ slightly (e.g., different durationHours from a differently keyed
  // profile), producing a value inconsistent with the ramp — visible as the step.
  //
  // In the exercise case (overrideCarbToBGFactor patched into the inner's constants
  // copy): inner early-Phase-3 returned totalCarbs × (C2B/sensitivityMultiplier),
  // which is lower than the correct Phase 3 value — a larger visible step-down.
  //
  // Fix: compute absorbedFraction directly here using the SAME `hoursSince` and
  // the SAME `pdProfile` already resolved above.  There is now exactly ONE Phase 3
  // check (the outer's `hoursSince >= durationHours`), ONE hoursSince, ONE profile.
  // The double-Phase-3-check race cannot occur.
  //
  // v4.12 NOTE: `safeOverrideC2B` (the 0.1 h boundary guard that zeroed out
  // overrideCarbToBGFactor in the last 6 minutes before Phase 3) has been removed.
  // Its original purpose was to prevent the inner function's early-Phase-3 from
  // using the lower exercise C2B — that race is now structurally impossible.
  // Keeping it introduced its own step: at hoursSince = durationHours − 0.1 the
  // effective C2B silently snapped from overrideC2B to baseCarbToBGFactor, producing
  // the same visual step artifact 6 minutes earlier.  The Phase 3 Math.min clamp
  // above now handles boundary continuity cleanly without a time-offset guard.
  const absorbedFraction = calculateAbsorbedFraction(hoursSince, pdProfile);
  const effectiveC2B = overrideCarbToBGFactor ?? baseCarbToBGFactor;
  return totalCarbs * Math.min(absorbedFraction, 1.0) * effectiveC2B;
}

/**
 * Calculate the cumulative BG reduction from a single insulin dose since today's reset.
 *
 * ─── Phase 3 (persist-at-100%) FIX ───────────────────────────────────────────
 * When a dose has fully absorbed (hours-since >= duration) its effect is held at
 * `-(dose × correction_factor)` until the daily reset — matching backend
 * pharmacodynamics.py lines 778-781.
 *
 * Returns 0 if the dose was administered before today's reset.
 * The returned value is <= 0 (negative = glucose-lowering).
 *
 * ─── v4.5 FIX: TWO BUGS IN PHASE 3 ──────────────────────────────────────────
 *
 * BUG 1 (crash): Phase 3 called `getNextResetTimeMs(..., tzOffsetMinutes)` but
 *   `tzOffsetMinutes` is not defined in this function's scope — the parameter is
 *   named `timezoneOffsetMinutes`. This caused a ReferenceError on every call,
 *   crashing the entire chart data generation silently.
 *   Fix: use `timezoneOffsetMinutes` consistently throughout.
 *
 * BUG 2 (green line drops during exercise without new insulin):
 *   Phase 3 returned `-(doseAmount × overrideCorrectionFactor)` where
 *   `overrideCorrectionFactor = CF × sensitivityMultiplier(t)`. Because
 *   sensitivityMultiplier(t) ramps up during exercise, the Phase 3 contribution
 *   grew more negative at every chart point — the bank balance dropped even
 *   though the dose was fully absorbed before exercise began.
 *
 *   Fix: Phase 3 always uses the BASE `correction_factor` from patientConstants.
 *   The absorption is complete — the BG-lowering action already happened at the
 *   base rate and cannot be retroactively scaled by a later exercise session.
 *   `overrideCorrectionFactor` remains valid ONLY for Phases 1 & 2 (the dose is
 *   still being absorbed during the active exercise sensitivity window).
 *
 * @returns Cumulative BG reduction in mg/dL — NEGATIVE value (<= 0).
 *          Callers must ADD (not subtract) this to the meal effect to get net.
 *          Contrast: blood-glucose-estimation.ts stores insulin effect as
 *          a POSITIVE magnitude and subtracts it. Never mix the two.
 */
export function calculateInsulinCumulativeEffect(
  dose: InsulinDose,
  currentTime: Date,
  patientConstants: PatientConstants,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0,
  overrideCorrectionFactor?: number,  // ← valid for Phases 1 & 2 only (see v4.5 fix above)
  absorptionReferenceTime?: Date,     // ← v4.10: when set, hoursSince uses this instead of
                                      //   currentTime — freezes absorption ramp at "now"
                                      //   for future chart points while currentTime continues
                                      //   to own the daily-reset boundary check.
  resolvePhase3OverrideCF?: (absorptionEndMs: number) => number | undefined
                                      // ← v4.13 FIX: when provided, called with the dose's
                                      //   absorption-end timestamp to produce a FROZEN CF
                                      //   for the Phase 3 clamp (phase2Exit).  Prevents the
                                      //   clamp value from drifting as sensitivityMultiplier
                                      //   decays after the sensitivity window closes.
): number {
  // Parse dose timestamp as UTC
  const rawTs: string | undefined =
    (dose as any).administrationTime ??
    (dose as any).taken_at ??
    (dose as any).takenAt;
  const doseMs = parseUTCMs(rawTs);
  if (isNaN(doseMs)) return 0;

  // Skip future doses — guard uses currentTime (targetTime).
  if (doseMs > currentTime.getTime()) return 0;

  // ── CRITICAL: Check daily reset BEFORE Phase 3 ────────────────────────────
  // Phase 3 (persist-at-100%) must NOT apply to doses from before today's reset.
  // The base _calculateInsulinCumulativeEffect performs this check in Phases 1 & 2,
  // but we short-circuit to Phase 3 before calling it. Without this guard, a dose
  // given before the daily reset hour that has fully absorbed would be included
  // in the current day's cumulative insulin effect — the bank balance would
  // never reset and yesterday's insulin would keep suppressing today's BG estimate.
  //
  // NOTE (v4.10): always uses currentTime (= targetTime) for the reset check —
  // mirrors the same guarantee in calculateMealCumulativeEffect.
  const lastResetMs = _getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes).getTime();
  if (doseMs < lastResetMs) return 0;

  // ── Resolve PK profile — single source for BOTH duration check and IOB ──────
  // Previously the outer used `medicationFactors[insulinType]` for the duration
  // check while the inner `_calculateInsulinCumulativeEffect` used
  // `getInsulinPharmacokinetics(medication)` (the shared PK constants).  If the
  // patient's medication_factors entry had a slightly different `duration_hours`
  // than the shared PK profile, Phase 3 fired at different ticks in the outer vs
  // inner function — producing the same step artifact as the meal race.
  //
  // Fix: use `getInsulinPKProfile(insulinType)` for everything.  The shared PK
  // constants are the authoritative source; patient medication_factors may
  // override other fields but the PK shape used for IOB integration should match
  // the duration used for the Phase 3 check.
  //
  // v4.12 FIX: `insulinType` was referenced but never declared — ReferenceError
  // on every call, silently swallowed by generateChartData's try-catch, leaving
  // the chart blank.  Extract it from the dose object using the same dual-field
  // pattern used throughout the codebase (insulinType ?? medication).
  const insulinType: string =
    (dose as any).insulinType ?? (dose as any).medication ?? 'rapid';
  const pkProfile = getInsulinPKProfile(insulinType);
  const durationHours: number = pkProfile.duration_hours;

  // ── Shared values for Phase 3 and Phase 1/2 ──────────────────────────────
  const doseAmount: number = (dose as any).units ?? (dose as any).dose ?? 0;
  if (doseAmount <= 0) return 0;

  // v4.5 FIX 2: Phase 3 always uses BASE correction_factor — never override.
  const baseCF: number =
    (patientConstants as any).correction_factor ?? 40; // match universal TS default

  // ── v4.10: Use absorptionReferenceTime for hoursSince when provided ────────
  // Mirrors the same pattern in calculateMealCumulativeEffect above.
  const absorptionMs = (absorptionReferenceTime ?? currentTime).getTime();
  const hoursSince = (absorptionMs - doseMs) / (1000 * 60 * 60);

  // ── Phase 3: After absorption completes — PERSIST at full BG reduction ───
  // Matches backend pharmacodynamics.py:
  //   if current_time >= end_time:
  //     return -(dose_amount * correction_factor)  # PERSISTS until next reset
  // CRITICAL: also cap at the next reset so doses from the current window
  // don't persist into the following day.
  //
  // v4.5 FIX 1: was `getNextResetTimeMs(..., tzOffsetMinutes)` — variable not
  //   defined. Corrected to `timezoneOffsetMinutes`.
  // v4.5 FIX 2: was `overrideCorrectionFactor ?? baseCF` — always use baseCF.
  //   The override (CF × sensitivityMultiplier(t)) is time-varying and must NOT
  //   be applied to a completed historical absorption event. See JSDoc above.
  if (hoursSince >= durationHours) {
    const nextResetMs = getNextResetTimeMs(currentTime, resetHour, timezoneOffsetMinutes); // FIX 1
    if (doseMs >= lastResetMs && doseMs < nextResetMs) {
      // v4.5 FIX 2: base CF only — absorption complete, no retroactive exercise scaling.
      const phase3 = -(doseAmount * baseCF);
      // v4.12 FIX: clamp so Phase 3 entry is never less negative than Phase 2 exit.
      // Without this, when effectiveCF > baseCF (exercise window active at absorption
      // end), Phase 2's final value ≈ -(doseAmount × effectiveCF) is more negative than
      // phase3, producing a visible upward step in the green cumulative line.
      // Math.min picks the more-negative value, eliminating the discontinuity.
      // Once the exercise window closes (overrideCorrectionFactor becomes undefined via
      // the v4.7 > 1.005 guard), phase2Exit === phase3 and the clamp is a no-op.
      //
      // v4.13 FIX: freeze the CF used for phase2Exit at the moment absorption completed.
      // The resolver evaluates sensitivityMultiplierAtTime(doseMs + durationHours × 3600s),
      // which is constant per dose regardless of the current chart-point time.  Without
      // this, using the chart-point's decaying multiplier caused phase2Exit to become
      // less negative at every subsequent chart tick → Phase 3 drifted upward ~120 mg/dL.
      const absorptionEndMsDose = doseMs + durationHours * 3_600_000;
      const frozenOverrideCF = resolvePhase3OverrideCF
        ? resolvePhase3OverrideCF(absorptionEndMsDose)
        : overrideCorrectionFactor;
      const phase2Exit = -(doseAmount * (frozenOverrideCF ?? baseCF));
      return Math.min(phase3, phase2Exit);
    }
    return 0;
  }

  // ── Phase 1 & 2: inline IOB computation ──────────────────────────────────
  //
  // ─── ROOT-CAUSE FIX (eliminates double-Phase-3-check architecture) ────────
  //
  // The previous delegate to _calculateInsulinCumulativeEffect used
  // `getInsulinPharmacokinetics(medication)` internally for IOB, while the outer
  // wrapper used `medicationFactors[insulinType]` for the duration check.
  // If these two profiles had different `duration_hours` values (e.g., a patient-
  // customised medication_factors entry), Phase 3 fired at different chart ticks
  // in the outer vs inner function — same double-Phase-3-check race as meals.
  //
  // Fix: `pkProfile` (resolved above via `getInsulinPKProfile`) is now the single
  // source for BOTH `durationHours` (Phase 3 check) and `calculateIOB` (Phase 1/2
  // absorption fraction).  There is exactly one Phase 3 check and one profile.
  //
  // overrideCorrectionFactor IS valid for Phase 1/2 — during active absorption
  // inside the exercise sensitivity window, insulin genuinely lowers BG more
  // aggressively.  Phase 3 always uses baseCF (absorption already completed).
  const iobFraction = calculateIOB(hoursSince, 1.0, pkProfile);
  const absorptionFraction = 1.0 - iobFraction;
  const effectiveCF = overrideCorrectionFactor ?? baseCF;
  return -(doseAmount * absorptionFraction * effectiveCF); // negative = BG reduction
}

/**
 * Calculate total cumulative effects from all meals and insulin doses.
 *
 * ─── v4.4 FIX ────────────────────────────────────────────────────────────────
 * Rewrites the previous delegate-to-`_calculateTotalCumulativeEffects` pattern
 * to call the FIXED `calculateMealCumulativeEffect` and
 * `calculateInsulinCumulativeEffect` above, so all Phase 3 (persist-at-100%)
 * behaviour is applied correctly.
 *
 * This is the "bank balance" model:
 *   cumulativeNetBaseline = cumulativeMealEffect + cumulativeInsulinEffect
 *   (insulin effect is negative, so this is meals − |insulin|)
 *
 * Only events AFTER today's reset are counted (enforced inside the per-item functions).
 *
 * Direct port of:
 *   backend/utils/pharmacodynamics.py::calculate_total_cumulative_effects()
 *
 * @param meals                 - ALL meals in current daily window (including fully absorbed)
 * @param insulinDoses          - ALL doses in current daily window (including fully absorbed)
 * @param currentTime           - Current timestamp
 * @param patientConstants      - Patient constants (carb_to_bg_factor, correction_factor …)
 * @param absorptionProfiles    - Absorption profile map keyed by AbsorptionType
 * @param resetHour             - Daily reset hour 0–23 (default 7)
 * @param timezoneOffsetMinutes - Patient UTC offset in minutes (default 0)
 * @param activities            - Normalised activity records for HR ODE model (optional)
 * @param effectiveCorrectionFactor - Optional CF override for post-exercise sensitivity.
 *                                    Passed to calculateInsulinCumulativeEffect for
 *                                    Phases 1 & 2 only — Phase 3 always uses base CF.
 * @param overrideCarbToBGFactor    - Optional C2B override for post-exercise sensitivity.
 *                                    Passed to calculateMealCumulativeEffect for
 *                                    Phases 1 & 2 only — Phase 3 always uses base C2B.
 *                                    (v4.6 fix — mirrors effectiveCorrectionFactor pattern)
 * @returns Full cumulative effects breakdown including the activity term
 *
 * @example
 * const cumulative = calculateTotalCumulativeEffects(
 *   allMealsInWindow,  // ALL meals after reset — not just activeMeals!
 *   allDosesInWindow,
 *   new Date(), constants, MEAL_ABSORPTION_PROFILES, 7, -300,
 *   normalizedActivities   // optional — pass [] when no exercise today
 * );
 * console.log(cumulative.cumulativeNetBaseline); // e.g. +150.0 mg/dL (including activity)
 * console.log(cumulative.cumulativeActivityEffect); // e.g. -30.0 mg/dL
 */
export function calculateTotalCumulativeEffects(
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<string, PharmacodynamicProfile | MealAbsorptionProfile>,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0,
  activities?: NormalizedActivity[],
  effectiveCorrectionFactor?: number,  // ← Phase 1 & 2 only — Phase 3 ignores this (v4.5 fix)
  overrideCarbToBGFactor?: number,     // ← Phase 1 & 2 only — Phase 3 ignores this (v4.6 fix)
  absorptionReferenceTime?: Date,      // ← v4.10: when set, forwarded to per-item functions to
                                       //   freeze the absorption ramp at "now" for future points.
                                       //   currentTime continues to own the reset boundary check.
  resolvePhase3OverrideCF?:  (absorptionEndMs: number) => number | undefined,
                                       // ← v4.13 FIX: forwarded to calculateInsulinCumulativeEffect.
                                       //   Frozen per-dose CF for Phase 3 clamp (no drift).
  resolvePhase3OverrideC2B?: (absorptionEndMs: number) => number | undefined
                                       // ← v4.13 FIX: forwarded to calculateMealCumulativeEffect.
                                       //   Frozen per-meal C2B for Phase 3 clamp (no drift).
): ExtendedCumulativeEffectsResult {
  let cumulativeMealEffect = 0;
  let cumulativeInsulinEffect = 0;
  const mealContributions: any[] = [];
  const insulinContributions: any[] = [];

  for (const meal of meals) {
    const effect = calculateMealCumulativeEffect(
      meal, currentTime, patientConstants, absorptionProfiles, resetHour, timezoneOffsetMinutes,
      overrideCarbToBGFactor,    // ← Phase 1/2 only; Phase 3 uses base C2B regardless
      absorptionReferenceTime,   // ← v4.10: freeze absorption at "now" for future chart points
      resolvePhase3OverrideC2B,  // ← v4.13: frozen C2B resolver for Phase 3 clamp
    );
    if (effect > 0) {
      cumulativeMealEffect += effect;
      mealContributions.push({
        mealId: String((meal as any)._id ?? (meal as any).id ?? ''),
        mealTime: (meal as any).timestamp ?? '',
        carbs: (() => {
          const rn: any = (meal as any).nutrition ?? {};
          return (meal as any).carbEquiv ??
            (meal as any).calculation_summary?.total_carb_equiv ??
            rn.total_carb_equiv ?? rn.totalCarbEquiv ?? rn.totalCarbs ?? rn.carbs ?? 0;
        })(),
        bgElevation: Math.round(effect * 10) / 10,
      });
    }
  }

  for (const dose of insulinDoses) {
    const effect = calculateInsulinCumulativeEffect(
      dose, currentTime, patientConstants, resetHour, timezoneOffsetMinutes,
      effectiveCorrectionFactor,  // ← Phase 1/2 CF override
      absorptionReferenceTime,    // ← v4.10: freeze absorption at "now" for future chart points
      resolvePhase3OverrideCF,    // ← v4.13: frozen CF resolver for Phase 3 clamp
    );
    if (effect < 0) {
      cumulativeInsulinEffect += effect;
      insulinContributions.push({
        doseId: String((dose as any)._id ?? (dose as any).id ?? ''),
        takenAt: (dose as any).administrationTime ?? (dose as any).taken_at ?? '',
        dose: (dose as any).units ?? (dose as any).dose ?? 0,
        bgReduction: Math.round(effect * 10) / 10,
      });
    }
  }

  // insulin effect is already negative → addition gives: meals − |insulin|
  const mealPlusInsulin = cumulativeMealEffect + cumulativeInsulinEffect;

  // ── Activity (HR ODE) term — third signed term in the bank-balance model ──
  // Negative for aerobic exercise (GLUT4 glucose uptake), positive for sessions
  // recorded with bg_direction = +1 (anaerobic / stress response).
  // Takes MAX sensitivity multiplier across sessions (GLUT4 doesn't stack).
  let cumulativeActivityEffect = 0;
  let activityContributions: ActivityContribution[] = [];

  if (activities && activities.length > 0) {
    const activityResult = calculateStackedActivityEffect(
      activities,
      patientConstants as any,
      currentTime,
    );
    cumulativeActivityEffect   = activityResult.cumulative_activity_effect;
    activityContributions      = activityResult.activity_contributions;
  }

  const cumulativeNetBaseline = mealPlusInsulin + cumulativeActivityEffect;

  const nextReset = getDailyResetTime(
    new Date(currentTime.getTime() + 24 * 60 * 60 * 1000),
    resetHour,
    timezoneOffsetMinutes
  );

  return {
    cumulativeMealEffect:    Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeNetBaseline:   Math.round(cumulativeNetBaseline * 10) / 10,
    cumulativeActivityEffect: Math.round(cumulativeActivityEffect * 10) / 10,
    activityContributions,
    mealContributions,
    insulinContributions,
    resetHour,
    calculationTime: currentTime.toISOString(),
    nextReset: nextReset.toISOString(),
  } as ExtendedCumulativeEffectsResult;
}

// ─── Activity effect for the cumulative bank-balance series (P1 fix — §9) ────

/**
 * Minimal shape required by calculateActivityEffectForCumulative.
 *
 * Structurally satisfied by ActivityContribution from both:
 *   @/services/api/activity-pharmacodynamics  (API response type)
 *   @/utils/activity/activity-pharmacodynamics (local ODE type)
 *
 * Using a structural interface here avoids a cross-layer import between the
 * utils/ calculation layer and the services/api layer.
 */
export interface ActivityEffectContribution {
  /** ISO-8601 start timestamp of the session */
  start_time: string;
  /** Session length in minutes */
  duration_minutes: number;
  /**
   * Signed mg/dL contributed by this session to the cumulative effect SO FAR.
   * Negative = BG-lowering (aerobic). Positive = BG-raising (anaerobic / stress).
   * This is only the ABSORBED portion at the time the API response was computed.
   * For the full eventual lock-in amount use cumulative_bg_effect + full remaining.
   */
  cumulative_bg_effect: number;
  /**
   * v4.7: Unsigned remaining acute BG drop still to be delivered (mg/dL).
   * Together with cumulative_bg_effect this gives the total session effect:
   *   fullEffect = cumulative_bg_effect + bg_direction * (−remaining_bg_drop)
   *              = cumulative_bg_effect − remaining_bg_drop   [aerobic, bg_direction=−1]
   * Optional so callers that only have cumulative_bg_effect still work.
   */
  remaining_bg_drop?: number;
  /**
   * v4.7: Sign of BG direction. -1 = lowers BG (aerobic default), +1 = raises BG.
   * Required to correctly sign the remaining_bg_drop when computing fullEffect.
   * Optional (defaults to -1 when absent for backward compat).
   */
  bg_direction?: -1 | 1;
}

/**
 * Activity BG effect for the cumulative "bank balance" series — **lock-in model**.
 *
 * ⚠️  This is NOT the same as `calculateActivityEffectAtTime` used by EVC/BGV
 * for the teal instantaneous-rate line (which applies exponential decay after the
 * session ends). This function locks in the effect permanently post-session because
 * a BG drop from exercise does not reverse on its own.
 *
 * Lock-in model:
 * ```
 *   During session  (startMs → endMs):  linear ramp  0 → fullEffect
 *   Post-session    (targetMs > endMs): locked at fullEffect permanently (no decay)
 * ```
 *
 * Two key properties:
 *
 *  1. **LOCK-IN**: after training ends the effect is flat at `fullEffect`
 *     (= cumulative_bg_effect + bg_direction × remaining_bg_drop, the total
 *     eventual drop the session will deliver).
 *
 *  2. **DAILY RESET GUARD**: sessions whose `start_time` falls before `resetTimeMs`
 *     are excluded, matching `calculateTotalCumulativeEffects()` for meals/insulin.
 *
 * **Primary use — activityDeltaSinceReading:**
 * ```ts
 *   const effectAtReading = calculateActivityEffectForCumulative(
 *     latestReading.timestamp, activityPD.activity_contributions, lastResetMs
 *   );
 *   const delta = activityPD.cumulative_activity_effect - effectAtReading;
 *   estimatedBG += delta; // add only the post-reading portion — no double-count
 * ```
 *
 * Previously duplicated as a private function in:
 *   - `useActiveEffects._activityEffectAtTime`
 *   - `ActiveEffectsDisplay.calculateActivityEffectForCumulative`
 *   - `EffectsVisualizationChart.calculateActivityEffectForCumulative`
 *   - `BloodGlucoseVisualization.calculateActivityEffectForCumulative`
 *
 * Extracted here (P1 fix — §9) so all four consumers import from one place.
 * Uses the module-local `parseUTCMs` for timezone-safe timestamp parsing.
 *
 * ─── v4.8 FIX: HISTORICAL RAMP OVERCOUNT ─────────────────────────────────────
 *
 * BUG: `fullEffect = cumulative_bg_effect + bgDir * remaining_bg_drop` is a
 *   T_now snapshot.  For historical points (T_target < T_now) the ramp was
 *   `frac × fullEffect` — but `fullEffect` already includes the drop that will be
 *   delivered BETWEEN T_target and T_now, overcounting the historical effect and
 *   setting the post-session lock-in plateau too high.
 *
 * FIX: add a `nowMs` parameter (default Date.now()).  For T_target ≤ T_now the ramp
 *   back-scales from `cumulative_bg_effect` (the delivered amount at T_now):
 *
 *     fracAtTarget = (T_target − startMs) / durationMs
 *     fracAtNow    = min(1, (T_now − startMs) / durationMs)
 *     effectAtTarget = cumulative_bg_effect × (fracAtTarget / fracAtNow)
 *
 *   When fracAtNow ≈ 0 (session just started at T_now) the ratio is clamped to 0.
 *   For T_target > T_now (future points during the session), the ramp uses
 *   `fracAtTarget × fullEffect` as before — correct because fullEffect is the total
 *   drop the session will eventually deliver.
 *   Post-session lock-in is unchanged regardless of T_target.
 *
 *   Consumers (EVC, BGV) pass their chart-generation "now" timestamp as `nowMs`
 *   so historical and future points are both handled correctly in a single pass.
 *   AED / useActiveEffects always evaluate at T_now so the default is safe for them.
 *
 * ─── v4.9 FIX: LOCK-IN SNAP AT SESSION END ────────────────────────────────────
 *
 * BUG: For an active session (T_now < endMs), the post-session branch
 *   (`targetMs > endMs`) locked in at `fullEffect` for ALL future post-session
 *   points. But `fullEffect = cumulative_bg_effect + bgDir * remaining_bg_drop`
 *   includes `remaining_bg_drop` — the acute drop still outstanding at T_now.
 *   Meanwhile the during-session branch correctly returned only `cumulative_bg_effect`
 *   (the actually-delivered amount) at T_now. The moment T_target crossed endMs,
 *   the value jumped by `remaining_bg_drop`, producing a sharp step up in the green
 *   bank-balance line at the session end time even though no new food was eaten.
 *
 * FIX: Split the post-session lock-in by T_target vs T_now:
 *   T_target ≤ T_now  →  lock in at `cumulative_bg_effect` (delivered amount at T_now).
 *   T_target >  T_now  →  lock in at `fullEffect` (full drop will be delivered by then).
 *
 * This makes the historical lock-in plateau exactly continuous with the ramp that
 * ends at T_now, eliminating the step artifact.
 *
 * ─── v4.10 FIX: NOW-BOUNDARY KINK IN DURING-SESSION FUTURE RAMP ──────────────
 *
 * BUG: For an active session (T_now < endMs), future chart points (T_now < T_target ≤ endMs)
 *   used the formula `fracAtTarget × fullEffect`.  At T_target = T_now this evaluates
 *   to `fracAtNow × fullEffect`, while the historical branch at the same point returns
 *   `cumulative_bg_effect`.  These are equal only when `remaining_bg_drop = 0`.
 *   When remaining drop is non-zero (session still in progress) the two branches
 *   disagree at the boundary — visible as a sharp kink / step in the green line
 *   exactly at the red "now" dashed marker.
 *
 * FIX: Replace `fracAtTarget × fullEffect` with a two-segment ramp that is
 *   C⁰-continuous at T_now:
 *
 *     fracIntoFuture = (T_target − T_now) / (endMs − T_now)   (0 → 1)
 *     effectAtTarget = cumulative_bg_effect
 *                    + fracIntoFuture × (fullEffect − cumulative_bg_effect)
 *
 *   At T_target = T_now  → cumulative_bg_effect  (matches historical branch exactly) ✓
 *   At T_target = endMs  → fullEffect                                                ✓
 *
 * @param targetMs        UTC ms of the evaluation point (e.g. reading timestamp or chart point)
 * @param contributions   `activity_contributions` from the stacked ActivityPDResult
 * @param resetTimeMs     Daily reset boundary in UTC ms — sessions before this are excluded
 * @param nowMs           UTC ms of "now" (the API response timestamp). Default: Date.now().
 *                        Chart consumers MUST pass their reference "now" so that historical
 *                        chart points use the correct back-scaled ramp (v4.8) and the future
 *                        ramp starts continuously from the delivered amount (v4.10).
 *                        NOTE (v4.13): `nowMs` is still used by the during-session branches
 *                        (v4.8 back-scale and v4.10 future ramp). It is no longer used by the
 *                        post-session branch, which unconditionally locks at `fullEffect`.
 * @returns Signed mg/dL of activity effect locked-in at `targetMs`. Post-session points always
 *          return `fullEffect` (the total delivered drop) — the line is permanently flat after
 *          session end, never recovering upward unless a new meal or session is logged (v4.13).
 */
export function calculateActivityEffectForCumulative(
  targetMs: number,
  contributions: ActivityEffectContribution[],
  resetTimeMs: number,
  nowMs: number = Date.now(),   // v4.8/v4.10: chart consumers must pass their reference "now"
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;
    if (startMs < resetTimeMs) continue;                  // daily reset guard

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;

    // fullEffect = total eventual drop the session will deliver (signed).
    //
    // Sign accounting:
    //   cumulative_bg_effect  — already signed  (−5 for aerobic, +3 for anaerobic)
    //   remaining_bg_drop     — unsigned magnitude (always ≥ 0)
    //   bg_direction          — sign of effect (−1 aerobic, +1 anaerobic)
    //
    //   fullEffect = cumulative_bg_effect + bg_direction * remaining_bg_drop
    //     aerobic  (bgDir=−1): −5 + (−1)(2) = −7  ✓
    //     anaerobic(bgDir=+1): +3 + (+1)(2) = +5  ✓
    //
    // When remaining_bg_drop is absent (synthetic/historical contributions with
    // absorbed_fraction=1.0), falls back to cumulative_bg_effect alone — correct
    // because the full drop has already been delivered.
    const bgDir         = c.bg_direction ?? -1;
    const remainingDrop = c.remaining_bg_drop ?? 0;
    const fullEffect    = (c.cumulative_bg_effect ?? 0) + bgDir * remainingDrop;

    if (targetMs > endMs) {
      // Post-session: LOCK IN permanently at fullEffect.
      //
      // ── v4.13 FIX: CUMULATIVE LINE RECOVERS UPWARD AFTER SESSION ENDS ─────────
      //
      // ROOT CAUSE of the regression introduced by v4.9:
      //
      //   v4.9 split the post-session branch by whether T_target ≤ T_now:
      //     Historical: lock at `cumulative_bg_effect`   (API snapshot at T_now)
      //     Future:     lock at `fullEffect`              (total eventual drop)
      //
      //   The intent was to prevent a snap-up at session end for ACTIVE sessions
      //   where T_now < endMs: at that boundary the historical branch returned
      //   `cumulative_bg_effect` while the next (post-session future) tick returned
      //   `fullEffect = cumulative_bg_effect + remaining_bg_drop` — a discontinuity.
      //
      // WHY v4.9 caused the recovery artefact:
      //
      //   `cumulative_bg_effect` is a LIVE API snapshot — it reflects how much of
      //   the session's BG drop had been delivered at the moment the API was last
      //   called.  For a COMPLETED session (T_now > endMs, which is the most common
      //   state when the chart re-renders after the session is over):
      //
      //     • `remaining_bg_drop` is 0 (all drop delivered) OR slightly > 0 if the
      //       API response is a few seconds stale.
      //     • `fullEffect ≈ cumulative_bg_effect` (within rounding).
      //
      //   BUT: as time advances and the user keeps the chart open, `nowMs` increases.
      //   On each chart refresh `cumulative_bg_effect` comes from a new API call —
      //   it reflects only what was delivered up to THAT new T_now.  For a session
      //   that ended 3 hours ago `cumulative_bg_effect` is constant (the full drop
      //   was already delivered); but the v4.9 split means historical post-session
      //   points whose `targetMs <= nowMs` are locked at a `cumulative_bg_effect`
      //   that was snapshotted under different conditions.
      //
      //   More critically: for the edge case where T_now is still INSIDE the
      //   session (T_now < endMs) and a chart point with T_target > endMs falls
      //   in the historical branch (targetMs <= nowMs < endMs — structurally
      //   IMPOSSIBLE because targetMs > endMs > nowMs contradicts targetMs <= nowMs),
      //   the code fell through to `cumulative_bg_effect` anyway, locking the
      //   post-session plateau at a too-low value.  On the next chart refresh when
      //   T_now > endMs, those same points switch to the future branch and jump to
      //   `fullEffect`, producing the visible rebound artefact.
      //
      // CORRECT LOGIC:
      //
      //   The session is OVER at `targetMs` (targetMs > endMs by definition of
      //   this branch).  By the time `targetMs` arrives the full `fullEffect` has
      //   been delivered — regardless of whether `targetMs` is historical, "now",
      //   or future relative to the chart's reference timestamp.
      //
      //   Lock-in = `fullEffect`, unconditionally.
      //
      //   The v4.9 snap-up was a real bug for ACTIVE sessions (T_now < endMs,
      //   T_target just past endMs).  The correct fix for THAT case is the v4.10
      //   future ramp in the during-session branch: the ramp is C⁰-continuous at
      //   T_now, reaches `fullEffect` at `endMs`, so the post-session lock-in at
      //   `fullEffect` is already continuous with the ramp.  No special-casing of
      //   historical vs future post-session is needed.
      //
      // RESULT: green cumulative line locks in at session end and stays flat
      // permanently — no rebound, no drift, correct for T1D physiology (a BG drop
      // from exercise does not spontaneously reverse without food or correction).
      total += fullEffect;
    } else {
      // During session: linear ramp 0 → effect at targetMs
      //
      // v4.8 FIX: For T_target ≤ T_now (historical chart points), back-scale
      // from `cumulative_bg_effect` — the authoritative delivered amount at T_now.
      // Using `fullEffect` here overcounts because it includes drop yet to be
      // delivered between T_target and T_now.
      //
      // v4.10 FIX: For T_target > T_now (future points still inside the session),
      // interpolate from cumulative_bg_effect (at T_now) toward fullEffect (at endMs)
      // so the ramp is C⁰-continuous at the T_now boundary. See JSDoc for details.
      const fracAtTarget = (targetMs - startMs) / Math.max(durationMs, 1);

      if (targetMs <= nowMs) {
        // Historical or "now" point — back-scale from the T_now delivered amount.
        const fracAtNow = Math.min(1, Math.max(0, (nowMs - startMs) / Math.max(durationMs, 1)));
        const effectAtTarget = fracAtNow > 0
          ? (c.cumulative_bg_effect ?? 0) * (fracAtTarget / fracAtNow)
          : 0;
        total += effectAtTarget;
      } else {
        // Future point inside session — ramp continuously from the delivered amount
        // at T_now (cumulative_bg_effect) toward fullEffect at endMs.
        //
        // ── v4.10 FIX: NOW-BOUNDARY DISCONTINUITY ─────────────────────────────────
        //
        // BUG: The previous formula `fracAtTarget × fullEffect` produced a different
        // value at T_now+ε than the historical branch returned at T_now.
        //
        //   Historical at T_now:     cumulative_bg_effect
        //   Previous future at T_now+ε: fracAtNow × fullEffect
        //     = fracAtNow × (cumulative_bg_effect + bgDir × remaining_bg_drop)
        //
        // These are equal only if remaining_bg_drop = 0 (all drop delivered) or the
        // ODE ramp happens to be perfectly linear.  In the general case they differ —
        // the mismatch is visible as a sharp kink / step in the green bank-balance
        // line exactly at the red "now" dashed marker.
        //
        // FIX: two-segment ramp that is continuous at T_now:
        //   Historical (0 → T_now):     back-scaled from cumulative_bg_effect (unchanged)
        //   Future    (T_now → endMs):  linear from cumulative_bg_effect → fullEffect
        //
        // Boundary values:
        //   T_target = T_now:  deliveredAtNow + 0 × Δ = cumulative_bg_effect   ✓ (matches historical)
        //   T_target = endMs:  deliveredAtNow + 1 × Δ = fullEffect             ✓
        //
        const remainingDurationMs = Math.max(endMs - nowMs, 1);
        const fracIntoFuture = Math.min(1, (targetMs - nowMs) / remainingDurationMs);
        const deliveredAtNow = c.cumulative_bg_effect ?? 0;
        total += deliveredAtNow + fracIntoFuture * (fullEffect - deliveredAtNow);
      }
    }
  }
  return total;
}
// ─── v4.14: Universal cumulative insulin floor ────────────────────────────────

/**
 * Apply a running floor to `cumulativeInsulinEffect` across a time-ordered
 * array of cumulative-effects results.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `calculateInsulinCumulativeEffect` is a point-in-time function: it returns
 * the correct BG-lowering contribution for a SINGLE chart tick.  When called
 * across a time axis the per-tick values follow the product:
 *
 *   contribution(t) = -(doseAmount × absorptionFraction(t) × effectiveCF(t))
 *
 * where effectiveCF(t) = correctionFactor × sensitivityMultiplierAtTime(t).
 *
 * During the post-exercise sensitivity window sensitivityMultiplierAtTime decays
 * from its peak (e.g. 1.3) back toward 1.0.  Meanwhile absorptionFraction(t) is
 * still growing (the dose is still absorbing).  Their product has an interior
 * maximum — the contribution deepens, peaks, then rises back toward 0 — producing
 * the characteristic "mountain" shape in the green cumulative bank-balance line.
 *
 * ─── THE FIX ─────────────────────────────────────────────────────────────────
 *
 * Sweep the time-ordered array with a running floor `insulinFloor` (tracking the
 * most-negative value seen so far).  At each point:
 *
 *   1. If |cumulativeInsulinEffect| < 0.1 → no doses on board or daily reset
 *      boundary → clear the floor so the next dose cycle starts fresh.
 *   2. Otherwise → ratchet: insulinFloor = min(insulinFloor, value).
 *   3. If the current value has risen above the floor (delta < −0.01), clamp it
 *      back to the floor and shift cumulativeNetBaseline by the same delta so the
 *      bank-balance line tracks the corrected insulin depth correctly.
 *
 * ─── USAGE ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // EffectsVisualizationChart — after building the full points array
 * const points = timePoints.map(ts => buildChartPoint(ts, ...));
 * applyInsulinCumulativeFloor(points);          // ← single call, in-place
 * setChartData(points);
 *
 * // BloodGlucoseVisualization or any future time-series chart
 * const chartSeries = buildBGTimeSeries(...);   // returns ExtendedCumulativeEffectsResult[]
 * applyInsulinCumulativeFloor(chartSeries);
 * ```
 *
 * ─── CALLERS: WHEN TO USE / WHEN NOT TO ──────────────────────────────────────
 *
 * ✅ Use in any component that iterates `calculateTotalCumulativeEffects` (or
 *    `buildChartPoint`) across a TIME AXIS — EVC, BloodGlucoseVisualization,
 *    any future chart.
 *
 * ❌ Do NOT use in point-in-time hooks (useActiveEffects, useBloodGlucoseEstimation).
 *    Those evaluate at a single "now" timestamp; without a preceding series of
 *    values there is no floor to compare against and the call is a no-op at best,
 *    misleading at worst.
 *
 * ─── MUTATION SAFETY ─────────────────────────────────────────────────────────
 *
 * Mutates the input array in-place.  This is intentional and safe when called on
 * freshly-allocated arrays (e.g. immediately after a `.map()` before the array is
 * handed to React state).  If you need to preserve the original, spread a copy first:
 *   `applyInsulinCumulativeFloor([...points])`
 *
 * @template T  Any object type that has `cumulativeInsulinEffect: number` and
 *              `cumulativeNetBaseline: number`.  Matches `EffectsChartPoint`,
 *              `ExtendedCumulativeEffectsResult`, or any custom time-series shape.
 * @param points  Time-ordered array (earliest first).  Must be sorted ascending
 *                by timestamp for the running-min ratchet to be meaningful.
 * @returns       The same array reference (allows chaining).
 */
export function applyInsulinCumulativeFloor<T extends {
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline:   number;
}>(points: T[]): T[] {
  // Running floor: tracks the most-negative cumulativeInsulinEffect seen so far.
  // Initialised to 0 — before any doses are seen the floor is "no effect".
  let insulinFloor = 0;

  for (const p of points) {
    if (Math.abs(p.cumulativeInsulinEffect) < 0.1) {
      // ── Reset ─────────────────────────────────────────────────────────────
      // |cumulativeInsulinEffect| < 0.1 means either:
      //   a) No doses on board at all for this chart point, OR
      //   b) We've crossed a daily reset boundary and all doses from the
      //      previous window have fallen out of the accounting period.
      // In both cases the floor must be cleared so the next dose-absorption
      // cycle starts fresh and doesn't inherit a floor from a previous day.
      insulinFloor = 0;
    } else {
      // ── Ratchet ───────────────────────────────────────────────────────────
      // Only allow the insulin contribution to go deeper (more negative).
      insulinFloor = Math.min(insulinFloor, p.cumulativeInsulinEffect);

      const delta = insulinFloor - p.cumulativeInsulinEffect; // ≤ 0 when rising
      if (delta < -0.01) {
        // The point has risen above the floor — clamp it back.
        // Apply the same delta to cumulativeNetBaseline so the bank-balance line
        // (meals + insulin + activity) correctly reflects the clamped depth.
        p.cumulativeInsulinEffect = insulinFloor;
        p.cumulativeNetBaseline  += delta;
      }
    }
  }

  return points;
}