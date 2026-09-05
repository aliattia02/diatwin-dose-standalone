/**
 * Active Effects Types
 * Location: mobile/types/active-effects.types.ts
 *
 * Canonical type definitions for the frontend pharmacokinetic snapshot
 * produced by ActiveEffectsDisplay.tsx.
 *
 * Extracted here so MealForm and UnifiedInsulinInput can import them
 * without creating a circular dependency (forms → AED → forms).
 *
 * USAGE
 * ─────
 * // In ActiveEffectsDisplay.tsx — remove local definitions, import these:
 * import type { AobIndirectEffects, ActiveEffectData } from '@/types/active-effects.types';
 *
 * // In MealForm.tsx and UnifiedInsulinInput.tsx:
 * import type { ActiveEffectData } from '@/types/active-effects.types';
 * // Then use resolveLiveEffects() from @/utils/calculations/resolve-live-effects
 */

import type { ActivityContribution } from '@/services/api/activity-pharmacodynamics';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-computed indirect BG effect components from post-exercise insulin sensitivity.
 *
 * Post-exercise GLUT4 upregulation has two secondary effects beyond the direct AOB drop:
 *   1. IOB more effective — each active insulin unit lowers BG more (higher ISF)
 *   2. MOB moderated    — active carbs raise BG less (lower carb-to-BG ratio)
 *
 * All values are unsigned positive magnitudes (mg/dL).
 * "Pending"   = effect still to arrive (PRESENT→FUTURE).
 * "Delivered" = effect already happened (PAST→PRESENT).
 *
 * All fields are 0 when sensitivityMultiplier ≤ 1.005 (H-1 noise threshold).
 */
export interface AobIndirectEffects {
  /** Extra IOB drop pending — remaining units × (effectiveISF − rawISF) */
  iobPending: number;
  /** Extra IOB drop delivered — absorbed units × (1 − 1/sm) */
  iobDelivered: number;
  /** BG spike saving pending — pending carbs × (1 − 1/sm) */
  mobPending: number;
  /** BG spike already suppressed — absorbed carbs × (1 − 1/sm) */
  mobDelivered: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main snapshot type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full frontend PK snapshot produced by ActiveEffectsDisplay.fetchAndCalculate().
 *
 * This is the single source of truth for:
 *   - Active insulin (IOB) and its pending BG reduction
 *   - Active meal carbs (MOB) and their pending BG rise
 *   - Activity on board (AOB) and post-exercise sensitivity
 *   - The bank-balance estimated BG and its simple projection
 *
 * MealForm and UnifiedInsulinInput should prefer these values over the stale
 * getActiveEffectsFull() API snapshot whenever a live snapshot is available.
 * Use resolveLiveEffects() to merge the two sources with correct priority.
 */
export interface ActiveEffectData {
  iob: {
    totalActiveInsulin: number;
    activeDoses: number;
    /** BG already lowered by absorbed insulin (PAST→PRESENT), mg/dL */
    currentBGReduction: number;
    /**
     * Absorbed IOB drop at the raw (un-boosted) ISF.
     * Equal to currentBGReduction when sensitivityMultiplier ≤ 1.005.
     */
    rawCurrentBGReduction: number;
    /** Total pending IOB drop at the boosted ISF (= rawPending + indirect boost) */
    pendingBGReduction: number;
    /**
     * Pending IOB drop at the raw ISF — baseline before post-exercise sensitivity.
     * Equal to pendingBGReduction when sensitivityMultiplier ≤ 1.005.
     */
    rawPendingBGReduction: number;
  };

  mob: {
    totalActiveCarbs: number;
    activeMealCount: number;
    /** BG already raised by absorbed carbs (PAST→PRESENT), mg/dL */
    currentBGElevation: number;
    /** Total pending MOB rise at the boosted C2B ratio (= rawPending − indirect suppression) */
    pendingBGRise: number;
    /**
     * Pending MOB rise at the raw C2B ratio — baseline before post-exercise GLUT4 suppression.
     * Equal to pendingBGRise when sensitivityMultiplier ≤ 1.005.
     */
    rawPendingBGRise: number;
  };

  /** Activity On Board — HR ODE exercise pharmacodynamic model */
  aob: {
    /** Unsigned remaining acute BG drop still to arrive (mg/dL) */
    totalAOB: number;
    /** Sessions currently within their exercise PD window */
    activeSessions: number;
    /** Signed net BG effect of all today's sessions (mg/dL). Negative = lowering. */
    cumulativeActivityEffect: number;
    /** Post-exercise ISF/CR sensitivity multiplier ≥ 1.0 */
    sensitivityMultiplier: number;
    /** Per-session breakdowns */
    activityContributions: ActivityContribution[];
    /** ISF scaled up by sensitivityMultiplier */
    effectiveCorrectionFactor: number;
    /** Carb-to-BG ratio scaled down by sensitivityMultiplier */
    effectiveCarbToBgRatio: number;
    /** Pre-computed indirect effect components — zero when sensitivityMultiplier ≤ 1.005 */
    indirectEffects: AobIndirectEffects;
  };

  netEffect: {
    /** Bank-balance estimated BG: stableBaseline + PK delta + activity delta + residual */
    estimatedBG: number;
    /** Full PK projection (stableBaseline + cumulativeNet + pendingNet) */
    projectedFinalBG: number;
    /**
     * Simple projection: estimatedBG + pendingNet.
     * Use this for the suggestion card — it matches the formula strip the patient sees.
     */
    simpleProjectedFinalBG: number;
    pendingNetEffect: number;
    cumulativeBaseline: number;
    cumulativeMealEffect: number;
    cumulativeInsulinEffect: number;
    /** Signed full-day activity term (informational) */
    cumulativeActivityEffect: number;
    /** Activity delta actually applied to estimatedBG: excludes portion already in the reading */
    activityDeltaSinceReading: number;
    safetyStatus: string;
    trend: string;
    sensitivityMultiplier: number;
  };

  baseline?: {
    value: number;
    readingValue: number;
    readingTimestamp: string | null;
    cumulativeMealEffect: number;
    cumulativeInsulinEffect: number;
    cumulativeNetEffect: number;
    mealsCount: number;
    insulinCount: number;
    isPreset?: boolean;
    readingDelta?: number | null;
    hourFloat?: number;
    circadianAtReading?: number | null;
    cumulAtReadingNet?: number | null;
    clampStatus?: 'ok' | 'hard_clamped';
    clampWarnings?: string[];
    rawBaselineValue?: number;
    readingResidual?: number | null;
  };

  metadata: {
    calculatedAt: string;
    mealsCount: number;
    dosesCount: number;
    hasRecentReading: boolean;
    nextResetMs: number;
    absorbedOnlyDoses: number;
    absorbedOnlyMeals: number;
    projectedClearMs: number;
    futureMealsCount: number;
    futureDosesCount: number;
    usingTargetFallback: boolean;
    activityOverlapWarning: boolean;
  };

  /** Raw dose records in today's window — for per-dose breakdown lists */
  dosesInWindow: Array<{
    id: string;
    units: number;
    insulinType: string;
    administrationTime: string | null;
    isActive: boolean;
    isAbsorbed: boolean;
    isFuture: boolean;
    bgAbsorbed: number;
    bgPending: number;
  }>;

  /** Raw meal records in today's window — for per-meal breakdown lists */
  mealsInWindow: Array<{
    id: string;
    mealType: string;
    timestamp: string | null;
    carbs: number;
    absorptionType: string;
    isActive: boolean;
    isAbsorbed: boolean;
    isFuture: boolean;
    bgAbsorbed: number;
    bgPending: number;
  }>;
}
