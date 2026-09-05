/**
 * resolve-live-effects
 * Location: mobile/utils/calculations/resolve-live-effects.ts
 *
 * Merges two competing sources of active-effects data into a single flat
 * object that MealForm and UnifiedInsulinInput can read directly:
 *
 *   1. lae  — live snapshot from ActiveEffectsDisplay.onEffectsComputed()
 *              (runs calculateStackedMealEffect on every tick → always current)
 *   2. api  — stale snapshot from getActiveEffectsFull() (fetched once on mount)
 *   3. pd   — activity PD from fetchStackedActivityEffectSafe() (fetched on mount)
 *
 * When `lae` is present it takes full priority for MOB, IOB, AOB, estimatedBG,
 * and projectedBG.  The API snapshot remains the authoritative source for
 * absorbedCarbs / absorbedInsulin / cumulativeNetBaseline because those fields
 * feed the breakdown card detail and are NOT the source of the panel discrepancy.
 *
 * USAGE (identical in both forms)
 * ────────────────────────────────
 *
 *   import { resolveLiveEffects } from '@/utils/calculations/resolve-live-effects';
 *
 *   // Inside performLocalCalculation / useMemo:
 *   const r = resolveLiveEffects(liveActiveEffects, activeEffects, activityPD);
 *
 *   const activeMealCarbs          = r.activeMealCarbs;
 *   const pendingMealRise          = r.pendingMealRise;
 *   const activeInsulinUnits       = r.activeInsulinUnits;
 *   const pendingInsulinReduction  = r.pendingInsulinReduction;
 *   const effectiveSensitivityMult = r.sensitivityMultiplier;   // before manual-activity boost
 *   const aobValue                 = r.activityOnBoard;
 *
 *   // BG — only override the form's own selection when a live snapshot exists:
 *   if (r.isLive) {
 *     smartBG                  = r.estimatedBG!;
 *     projectedBG              = r.projectedBG!;
 *     bgSourceAlreadyHasActivity = true;  // r.bgAlreadyHasActivity is always true when isLive
 *   }
 */

import type { ActiveEffectData } from '@/types/active-effects.types';
import type { ActiveEffectsFullResult } from '@/services/api/calculations';
import type { ActivityPDResult }        from '@/services/api/activity-pharmacodynamics';

// ─────────────────────────────────────────────────────────────────────────────
// Output type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flat, normalised active-effects scalars ready for direct use in dose
 * calculations.  Both MealForm and UnifiedInsulinInput destructure this
 * instead of reading from two different sources with different key names.
 */
export interface ResolvedActiveEffects {
  // ── MOB ────────────────────────────────────────────────────────────────────
  /** Grams of carbohydrate still pharmacologically active right now */
  activeMealCarbs: number;
  /** mg/dL BG rise still pending from active carbs (sensitivity-adjusted) */
  pendingMealRise: number;

  // ── IOB ────────────────────────────────────────────────────────────────────
  /** Units of insulin still pharmacologically active right now */
  activeInsulinUnits: number;
  /** mg/dL BG drop still pending from active insulin (sensitivity-adjusted) */
  pendingInsulinReduction: number;

  // ── AOB / sensitivity ──────────────────────────────────────────────────────
  /**
   * Post-exercise ISF multiplier ≥ 1.0.
   * Divide base dose by this; multiply correction factor by this.
   * Manual-activity boost should be max()'d on top of this value in the caller.
   */
  sensitivityMultiplier: number;
  /** mg/dL of acute BG drop still outstanding from exercise (treated like IOB) */
  activityOnBoard: number;

  // ── BG estimate ────────────────────────────────────────────────────────────
  /**
   * Bank-balance estimated BG from the live AED snapshot.
   * null when `isLive` is false — the caller must run its own BG selection.
   */
  estimatedBG: number | null;
  /**
   * Pre-computed projection: estimatedBG + pendingMOB − pendingIOB − AOB.
   * null when `isLive` is false.
   * Pass directly to buildSuggestion() / the dose card projected-BG row
   * so all three panels show the same number.
   */
  projectedBG: number | null;
  /** ISO timestamp of the most recent glucose reading used to anchor the estimate */
  readingTimestamp: string | null;
  /** Minutes elapsed since that reading (0 when isLive = false) */
  minutesSinceReading: number;

  // ── Source flags ───────────────────────────────────────────────────────────
  /**
   * True when estimatedBG already incorporates the activity delta.
   * When true the caller must NOT apply cumulativeActivityEffect a second time
   * (bgSourceAlreadyHasActivity = true in performLocalCalculation / useMemo).
   * Always true when isLive is true; depends on the API path when false.
   */
  bgAlreadyHasActivity: boolean;
  /**
   * True  → values come from the live AED frontend-PK snapshot.
   * False → values come from the stale mount-time API snapshot.
   *
   * Use this flag to decide whether to skip the form's own BG selection:
   *   if (r.isLive) { smartBG = r.estimatedBG!; }
   */
  isLive: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge live AED data and the stale API snapshot into ResolvedActiveEffects.
 *
 * Priority rules
 * ──────────────
 *   lae present  → live snapshot wins for ALL fields it provides.
 *   lae absent   → fall through to api + pd (mount-time snapshots).
 *
 * @param lae           Live snapshot from ActiveEffectsDisplay.onEffectsComputed().
 *                      Pass `undefined` while AED hasn't completed its first render.
 * @param apiSnapshot   Stale snapshot from getActiveEffectsFull() (fetched on mount).
 * @param activityPD    Activity PD from fetchStackedActivityEffectSafe() (fetched on mount).
 * @param carbToBgFactor Patient's carb-to-BG factor (mg/dL per gram of carbs).
 *                      Used as a fallback for `pendingMealRise` in Path B when the
 *                      API snapshot doesn't carry the field (it is a frontend-only
 *                      PK computation — `getActiveEffectsFull()` never emits it).
 *                      Falls back to 4.0 if omitted.
 */
export function resolveLiveEffects(
  lae:            ActiveEffectData        | null | undefined,
  apiSnapshot:    ActiveEffectsFullResult | null | undefined,
  activityPD:     ActivityPDResult        | null | undefined,
  carbToBgFactor?: number,
): ResolvedActiveEffects {

  // ── Path A: live AED snapshot ──────────────────────────────────────────────
  if (lae) {
    const readingTs = lae.baseline?.readingTimestamp ?? null;
    const minutesSinceReading = readingTs
      ? Math.max(0, Math.round((Date.now() - new Date(readingTs).getTime()) / 60_000))
      : 0;

    return {
      // MOB
      activeMealCarbs:         lae.mob.totalActiveCarbs,
      pendingMealRise:         lae.mob.pendingBGRise,
      // IOB
      activeInsulinUnits:      lae.iob.totalActiveInsulin,
      pendingInsulinReduction: lae.iob.pendingBGReduction,
      // AOB / sensitivity
      sensitivityMultiplier:   lae.aob.sensitivityMultiplier,
      activityOnBoard:         lae.aob.totalAOB,
      // BG
      estimatedBG:             lae.netEffect.estimatedBG,
      // simpleProjectedFinalBG already nets pendingMOB − pendingIOB − AOB with
      // sensitivity-adjusted factors — identical formula to what the AED card shows.
      projectedBG:             lae.netEffect.simpleProjectedFinalBG,
      readingTimestamp:        readingTs,
      minutesSinceReading,
      // AED's estimatedBG always includes activityDeltaSinceReading
      bgAlreadyHasActivity:    true,
      isLive:                  true,
    };
  }

  // ── Path B: stale API snapshot ─────────────────────────────────────────────
  // Key names in the API response are a mix of camelCase and snake_case depending
  // on which backend serialiser emitted them.  Both variants are guarded below.
  const mob = apiSnapshot?.mob as any;
  const iob = apiSnapshot?.iob as any;
  const pd  = activityPD;

  // `pendingBGRise` / `pending_bg_rise` are frontend-only PK computations —
  // `getActiveEffectsFull()` never emits them.  When neither field is present,
  // fall back to activeMealCarbs × carbToBgFactor (the same arithmetic AED uses).
  const activeMealCarbsVal = mob?.totalActiveCarbs ?? mob?.total_active_carbs ?? 0;
  const c2b                = carbToBgFactor ?? 4;

  return {
    // MOB
    activeMealCarbs:  activeMealCarbsVal,
    pendingMealRise:
      mob?.pendingBGRise   ??
      mob?.pending_bg_rise ??
      (activeMealCarbsVal * c2b),
    // IOB — API response may nest totalIOB at the root or inside .iob
    activeInsulinUnits:
      (apiSnapshot as any)?.totalIOB             ??
      iob?.totalIOB                              ??
      iob?.total_active_insulin                  ?? 0,
    pendingInsulinReduction: iob?.pendingBGReduction ?? iob?.pending_bg_reduction ?? 0,
    // AOB / sensitivity
    sensitivityMultiplier:   pd?.sensitivity_multiplier ?? 1.0,
    activityOnBoard:         pd?.activity_on_board      ?? 0,
    // BG — the form's own BG selection runs when isLive = false; return nulls here.
    estimatedBG:             null,
    projectedBG:             null,
    readingTimestamp:        null,
    minutesSinceReading:     0,
    // Cannot determine without knowing how the form's BG was built;
    // the caller must evaluate bgSourceAlreadyHasActivity using its own bgSource flag.
    bgAlreadyHasActivity:    false,
    isLive:                  false,
  };
}