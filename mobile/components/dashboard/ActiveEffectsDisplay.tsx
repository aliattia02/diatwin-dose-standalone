/**
 * ActiveEffectDisplay
 * Location: mobile/components/ActiveEffectDisplay.tsx
 *
 * Displays live frontend-calculated active effects:
 *   – Insulin On Board (IOB) and its BG impact
 *   – Meal On Board (MOB) and its BG impact
 *   – Activity On Board (AOB) — HR ODE exercise PD model
 *   – Stable T1D baseline derived from the last reading
 *   – Net effect: estimated BG, projected final BG, trend, safety status
 *
 * All values come exclusively from frontend pharmacodynamic calculations.
 * No backend API comparison is performed.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { usePatientConstants } from '@/hooks/usePatientConstants';

import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

import {
  calculateNetEffect,
  calculateStableBaselineFromReading,
} from '@/utils/glucose/blood-glucose-estimation';
import { sanitizeBaseline } from '@/utils/calculations/baseline';
import { calculateTotalCumulativeEffects, calculateActivityEffectForCumulative } from '@/utils/calculations';
import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinEffect,
  type InsulinDoseForStacking,
} from '@/utils/insulin/pharmacodynamics';
import { MEAL_ABSORPTION_PROFILES, getCircadianBaseline } from '@/constants/shared-constants';
import {
  parseUTCMs,
  normaliseMeal,
  normaliseDose,
  getLastResetTimeMs,
  getMealDurationHours,
} from '@/utils/ChartUtils';
import type { ActivityContribution, ActivityPDResult } from '@/services/api/activity-pharmacodynamics';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────
// parseUTCMs, normaliseMeal, normaliseDose, getLastResetTimeMs, and
// getMealDurationHours are imported from @/utils/ChartUtils (P2/P3 consolidation).
// The ChartUtils versions are authoritative; importing them here ensures
// consistent meal-absorption windows and — critically — that parseUTCMs
// accepts numeric timestamps (M-4 fix: the former local copy only accepted
// strings, so a numeric fallback `timestamp` field triggered a runtime crash
// and made activityDeltaSinceReading equal the full cumulativeActivityEffect
// with no reading-time offset).

function safeArray<T>(value: unknown, ...fallbackKeys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === 'object') {
    for (const key of fallbackKeys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

/**
 * Convert a normalised dose to the stacking shape at a given point in time.
 * Uses the imported ChartUtils `parseUTCMs` so numeric timestamps (set by
 * useActiveEffects.normaliseReading) are handled correctly (M-4 fix).
 */
function rawDoseToStacking(dose: any, currentTime: Date): InsulinDoseForStacking | null {
  const units: number = dose?.units ?? dose?.dose ?? 0;
  const takenAt = dose?.administrationTime ?? dose?.taken_at ?? null;
  if (!takenAt || units <= 0) return null;

  const doseMs = parseUTCMs(takenAt);  // imported from ChartUtils — accepts string | number
  if (isNaN(doseMs)) return null;

  const hoursSinceDose = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
  if (hoursSinceDose < 0) return null;

  return { dose: units, hoursSinceDose, insulinType: dose?.insulinType ?? dose?.medication ?? 'regular_insulin' };
}

/** One daily-reset period forward from getLastResetTimeMs. */
function getNextResetTimeMs(currentTime: Date, resetHour: number, tzOffsetMinutes: number): number {
  return getLastResetTimeMs(currentTime, resetHour, tzOffsetMinutes) + 24 * 60 * 60 * 1000;
}

// calculateActivityEffectForCumulative is imported from @/utils/calculations
// (cumulative-effects.ts — P1 fix §9). The local copy below has been removed;
// AED, EVC, BGV, and useActiveEffects all share one implementation.

/** Format an absolute timestamp as local clock time, e.g. "7:15 PM" */
function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

/** Format a millisecond countdown as "Xh Ym" or "Xm" */
function formatCountdown(msUntil: number): string {
  if (msUntil <= 0) return '0m';
  const totalMin = Math.ceil(msUntil / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Format elapsed ms as "Xm ago", "Xh Ym ago", or "just now" */
function formatRelativeTime(msSince: number): string {
  if (msSince < 60_000) return 'just now';
  const totalMin = Math.floor(msSince / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

function getDoseDurationHours(dose: any, constants: any): number {
  // FIX (Bug 2): cumulative-effects.ts checks camelCase durationHours first,
  // falls back to insulin_aspart profile, and uses insulinType field in addition
  // to medication. Previously only duration_hours was checked with no fallback profile.
  const insulinType: string =
    dose?.insulinType ?? dose?.medication ?? 'insulin_aspart';
  const medicationFactors: Record<string, any> = constants?.medication_factors ?? {};
  const profile: any =
    medicationFactors[insulinType] ??
    medicationFactors['insulin_aspart'] ??
    {};
  return profile?.durationHours ?? profile?.duration_hours ?? 4.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Residual alert classification (preset / circadian mode only)
// See: reading-residual-alert-plan.md
// ─────────────────────────────────────────────────────────────────────────────

interface ResidualClassification {
  tier: 'noise' | 'soft' | 'strong' | 'critical';
  direction?: 'high' | 'low';
  title?: string;
  body?: string;
  hint?: string;
}

/**
 * Classify the reading residual into an alert tier and produce
 * human-readable, directional guidance for the patient.
 *
 * readingResidual = bloodSugar − circadianAtReading − cumulAtReadingNet
 *
 * Positive  → BG is higher than the model predicts (unlogged carbs / illness)
 * Near zero → within glucometer noise, no alert
 * Negative  → BG is lower than the model predicts (unlogged insulin / activity)
 */
function classifyResidual(
  residual: number,
  mealsCount: number,
  dosesCount: number,
  carbToBgFactor: number,
  correctionFactor: number,
  minutesSinceReading: number,
  activityOverlapWarning: boolean,
): ResidualClassification {
  const abs = Math.abs(residual);

  // Tier 1 — within glucometer precision + normal circadian variability
  if (abs < 20) return { tier: 'noise' };

  const tier: ResidualClassification['tier'] =
    abs >= 100 ? 'critical' :
    abs >= 50  ? 'strong'   : 'soft';

  const staleNote = minutesSinceReading > 120
    ? ` (Note: this reading is ${minutesSinceReading} min old — residual reliability decreases over time.)`
    : '';

  if (residual > 0) {
    // BG is higher than the model predicts
    const carbEquiv = Math.round(residual / (carbToBgFactor || 4));
    const isFirstEntry = mealsCount === 0 && dosesCount === 0;

    let body: string;
    if (isFirstEntry) {
      body = `Your BG is ${residual.toFixed(0)} mg/dL above your circadian profile with no entries logged today. This may reflect normal morning variance (dawn phenomenon) or an unlogged overnight snack.${staleNote}`;
    } else if (tier === 'soft') {
      body = `Your BG is roughly ${carbEquiv} g of unaccounted carbs (~${residual.toFixed(0)} mg/dL) above what the model expects from your logged entries.${staleNote}`;
    } else {
      body = `Your BG is ${residual.toFixed(0)} mg/dL (~${carbEquiv} g carbs) higher than the circadian profile + all logged entries can explain.${staleNote}`;
    }

    const hint =
      tier === 'soft'   ? 'Was there a small snack or drink not logged? Check your meal entries.' :
      tier === 'strong' ? 'A missed snack or larger portion is likely. Review todays meal entries.' :
                          'A complete meal may not be logged. Check all entries for today.';

    return { tier, direction: 'high', title: tier === 'soft' ? 'BG Above Prediction' : 'Unaccounted BG Rise', body, hint };
  } else {
    // BG is lower than the model predicts
    const insulinEquiv = Math.round(abs / (correctionFactor || 40) * 10) / 10;

    let body: string;
    if (activityOverlapWarning) {
      body = `Your BG is ${abs.toFixed(0)} mg/dL below prediction. The reading was taken during or after an exercise session — part of this gap may reflect exercise-induced BG lowering already captured by the activity tracker.${staleNote}`;
    } else if (tier === 'soft') {
      body = `Your BG is roughly ${insulinEquiv} u of unaccounted insulin effect (~${abs.toFixed(0)} mg/dL) below what the model expects.${staleNote}`;
    } else {
      body = `Your BG is ${abs.toFixed(0)} mg/dL (~${insulinEquiv} u insulin equivalent) lower than the circadian profile + all logged entries can explain.${staleNote}`;
    }

    const hint = activityOverlapWarning
      ? 'If the gap is larger than exercise alone explains, check for an unlogged insulin dose.'
      : tier === 'soft'   ? 'Was there a small insulin dose or extra activity not logged?'
      : tier === 'strong' ? 'A correction dose or active session may not be logged. Check insulin and activity entries.'
      :                     'A significant insulin dose or extended activity is likely missing from today logs.';

    return { tier, direction: 'low', title: tier === 'soft' ? 'BG Below Prediction' : 'Unaccounted BG Drop', body, hint };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Types  (canonical definitions live in @/types/active-effects.types)
// ─────────────────────────────────────────────────────────────────────────────
import type { AobIndirectEffects, ActiveEffectData } from '@/types/active-effects.types';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveEffectDisplayProps {
  /**
   * Pre-fetched stacked PD result from a parent that owns useActiveEffects().
   *
   * When provided AND non-null, fetchAndCalculate() skips the GET /api/activity/pharmacodynamics
   * call and uses this value directly — eliminating the double-ODE-run described
   * in issue D-3.  When absent (standalone usage), the component fetches as usual.
   *
   * Pass activityPDResult from useActiveEffects() in any screen where both
   * ActiveEffectsDisplay and EffectsVisualizationChart are mounted simultaneously.
   *
   * ⚠️  Pass `undefined` (not null) while the parent hasn't yet completed its
   * first fetch.  `null` is interpreted as "fetched, no sessions today" and
   * short-circuits the ODE call to zero activity immediately — which is wrong
   * during the initial load window.  Use `lastUpdate ? activityPDResult : undefined`
   * at the call-site (see index.tsx FIX 5).
   */
  activityPDResult?: ActivityPDResult | null;

  /**
   * Pre-fetched meal array from the parent's useActiveEffects().
   *
   * When provided, fetchAndCalculate() skips GET /api/meals-only entirely and
   * uses this array directly (after applying the same normaliseMeal step).
   * Eliminates the duplicate meals fetch that previously fired on every 60-second
   * tick alongside the screen-level useActiveEffects poll.
   *
   * Pass meals from useActiveEffects() at the screen level.
   * Leave undefined for standalone usage — the component will fetch its own data.
   */
  meals?: any[];

  /**
   * Pre-fetched insulin dose array from the parent's useActiveEffects().
   *
   * When provided, fetchAndCalculate() skips GET /api/insulin-data entirely.
   * Same rationale as the meals prop above.
   *
   * Leave undefined for standalone usage.
   */
  insulinDoses?: any[];

  /**
   * Called every time fetchAndCalculate() completes successfully with the
   * fully-assembled ActiveEffectData snapshot.
   *
   * Lets any parent that renders AED receive the live PK snapshot without a
   * second fetch, so MealForm and UnifiedInsulinInput can share the same data.
   * Wire it up via:
   *   const [aedSnapshot, setAedSnapshot] = useState<ActiveEffectData | null>(null);
   *   <ActiveEffectDisplay onEffectsComputed={setAedSnapshot} />
   */
  onEffectsComputed?: (data: ActiveEffectData) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ActiveEffectDisplay({
  activityPDResult: propPDResult,
  meals:            propMeals,
  insulinDoses:     propInsulinDoses,
  onEffectsComputed,
}: ActiveEffectDisplayProps = {}) {
  const [data, setData] = useState<ActiveEffectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [netExpanded, setNetExpanded] = useState(false);
  const [aobExpanded, setAobExpanded] = useState(false);
  const [iobDosesExpanded, setIobDosesExpanded] = useState(false);
  const [mobMealsExpanded, setMobMealsExpanded] = useState(false);
  const [iobExpanded, setIobExpanded] = useState(false);
  const [mobExpanded, setMobExpanded] = useState(false);
  const [aobCardExpanded, setAobCardExpanded] = useState(false);
  const [indirectExpanded, setIndirectExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { constants, isLoading: constantsLoading, hasLoadedFromAPI } = usePatientConstants();

  // ── Debug: stable instance ID so every log line identifies its source ────────
  // Format: [AED:xxxx] — unique per component mount.  Lets you correlate log
  // lines across AED, EVC, and useActiveEffects instances in the same session.
  const instanceIdRef = useRef(`AED:${Math.random().toString(36).slice(2, 6)}`);

  // ── In-flight guard (mirrors useActiveEffects Fix A) ─────────────────────────
  // Prevents concurrent fetchAndCalculate() calls from piling up when:
  //   • the `constants` dep bounces (false→true→false during background TTL refresh)
  //   • the propPDResult effect fires on the same render cycle as the timer effect
  // Each call checks this flag; if already true it logs and returns immediately.
  // The finally block always clears it so the next tick or manual refresh works.
  const aedFetchInFlightRef = useRef(false);

  // ── One-time interval setup guard (mirrors useActiveEffects Fix B) ────────────
  // The `constants` dep in the timer effect re-fires whenever usePatientConstants()
  // returns a new object reference (even with identical values — happens on every
  // background TTL refresh).  Without this flag each bounce tears down the existing
  // timeout/interval and spawns a new one on top of the still-running previous one,
  // doubling (then tripling) the 60-second poll cadence.
  //
  // Behaviour after this fix:
  //   • First invocation → sets up interval normally, sets flag = true
  //   • Bounce invocation (constants object changed) → fires one immediate
  //     fetchAndCalculate(), then returns — existing interval keeps running
  //   • hasLoadedFromAPI / constantsLoading change → cleanup fires (flag reset),
  //     new invocation sets up a fresh interval as intended
  const aedIntervalSetupDoneRef = useRef(false);

  const fetchAndCalculate = async (reason = 'unknown') => {
    // In-flight guard — reject concurrent calls; clear in finally block.
    if (aedFetchInFlightRef.current) {
      console.log(`[${instanceIdRef.current}] 🚫 fetchAndCalculate skipped (already in-flight) reason=${reason}`);
      return;
    }
    aedFetchInFlightRef.current = true;
    console.log(`[${instanceIdRef.current}] 📡 fetchAndCalculate START reason=${reason} meals=${propMeals !== undefined ? 'prop' : 'fetch'} doses=${propInsulinDoses !== undefined ? 'prop' : 'fetch'} actPD=${propPDResult !== undefined ? 'prop' : 'fetch'}`);
    try {
      setError(null);
      const currentTime = new Date();

      // ── 1. Fetch meals, doses, readings, and activity PD ─────────────────
      // FIX: fetch from the daily reset time, not a fixed 24 h lookback.
      //
      // The old hardcoded 24 h window caused two bugs:
      //   1. At 9 PM with a 7 AM reset, the window reached back to 9 PM
      //      yesterday — pulling in ~38 h of meals/doses instead of today's
      //      14 h.  allMeals.length reflected all 24 h, so the "unreliable
      //      estimate" checklist showed 81 meals instead of today's actual count.
      //   2. mealsCount / dosesCount in metadata (used for the checklist and
      //      residual alert) were computed from the raw unfiltered arrays, making
      //      the counts wrong regardless of any downstream allMealsInWindow filter.
      //
      // Fix: compute the fetch start from the same lastResetMs the filters use,
      // then add a 6 h buffer behind it to cover any long-acting insulin doses
      // that started before today's reset but are still pharmacologically active.
      // This keeps the fetch cheap while being correct for both counts and PK math.
      const resetHourForFetch: number = constants?.daily_reset_hour ?? 7;
      const tzOffsetForFetch: number  = (constants as any)?.timezone_offset_minutes ?? 0;
      const lastResetMsForFetch = getLastResetTimeMs(currentTime, resetHourForFetch, tzOffsetForFetch);
      const windowEnd   = currentTime.toISOString();
      // 6 h buffer before reset so long-acting doses that started pre-reset
      // are still included in the PK calculation.
      const windowStart = new Date(lastResetMsForFetch - 6 * 60 * 60 * 1000).toISOString();

      const [mealsRes, insulinRes, readingsRes, activityPDRes] = await Promise.all([
        // ── FIX (Phase 2): use parent-provided meals when available ─────────
        // Skips GET /api/meals-only entirely when the screen-level
        // useActiveEffects has already fetched within the same 60-second window.
        // Leave undefined in standalone usage — falls through to the API call.
        propMeals !== undefined
          ? Promise.resolve({ data: propMeals })
          : apiClient.get(API.MEALS.MEALS_ONLY, {
              params: { start: windowStart, end: windowEnd },
            }),
        // ── FIX (Phase 2): use parent-provided doses when available ─────────
        // Same rationale as propMeals — skips GET /api/insulin-data.
        propInsulinDoses !== undefined
          ? Promise.resolve({ data: propInsulinDoses })
          : apiClient.get(API.INSULIN.DATA, {
              params: { start: windowStart, end: windowEnd },
            }),
        apiClient.get(API.BLOOD_SUGAR.LIST, {
          params: { start_time: windowStart, end_time: windowEnd, filter_by: 'reading_time' },
        }).catch(() => null),
        // ── Activity PD: non-fatal — no exercise today is fine ───────────────
        // D-3 fix: if the parent passed activityPDResult as a prop, use it
        // directly and skip the fetch entirely.  This prevents the double ODE
        // run that occurs when ActiveEffectsDisplay and EffectsVisualizationChart
        // are both mounted and both independently fire during the 60-second
        // cache-miss window after a session ends.
        propPDResult !== undefined
          ? Promise.resolve(propPDResult ? { data: propPDResult } : null)
          : apiClient.get(API.ACTIVITY_PD.STACKED).catch((err) => {
              console.warn('[ActiveEffectsDisplay] ⚠️ activityPD fetch failed — card hidden:', err);
              return null;
            }),
      ]);

      // ── 2. Extract and normalise ──────────────────────────────────────────
      // When prop arrays are provided, they're already extracted — skip safeArray.
      // When fetched by this component, extract from the response envelope as before.
      const rawMeals: any[] = propMeals !== undefined
        ? propMeals
        : safeArray(mealsRes?.data, 'meals', 'data');
      const rawDoses: any[] = propInsulinDoses !== undefined
        ? propInsulinDoses
        : safeArray(insulinRes?.data, 'insulin_logs', 'insulinDoses', 'doses', 'data');

      const allMeals = rawMeals.map(normaliseMeal);
      const allRawDoses = rawDoses.map(normaliseDose);

      const allDosesForCalc = allRawDoses.map((d: any) => ({
        ...d,
        id: String(d._id ?? d.id ?? ''),
        units: d.dose ?? d.units ?? 0,
        administrationTime: d.taken_at ?? d.administrationTime ?? d.takenAt ?? null,
        insulinType: d.medication ?? d.insulinType ?? d.insulin_type ?? 'regular_insulin',
      }));

      // ── 2b. Extract activity PD ───────────────────────────────────────────
      // Defensive validation: must have the three key numeric fields.
      const activityPDData = activityPDRes?.data;
      const activityPDValid =
        activityPDData &&
        typeof activityPDData.cumulative_activity_effect === 'number' &&
        typeof activityPDData.sensitivity_multiplier     === 'number' &&
        typeof activityPDData.activity_on_board          === 'number';

      const cumulativeActivityEffect: number = activityPDValid
        ? (activityPDData.cumulative_activity_effect as number)
        : 0;
      const sensitivityMultiplier: number = activityPDValid
        ? (activityPDData.sensitivity_multiplier as number)
        : 1.0;
      const activityOnBoard: number = activityPDValid
        ? (activityPDData.activity_on_board as number)
        : 0;
      const activityContributions: ActivityContribution[] = activityPDValid
        ? safeArray<ActivityContribution>(activityPDData.activity_contributions, 'activity_contributions')
        : [];
      const activeSessions: number = activityPDValid
        ? (activityPDData.active_sessions as number ?? 0)
        : 0;
      // Effective (sensitivity-adjusted) constants — fall back to patient constants
      const rawCorrFactor = constants?.correction_factor ?? 40;
      const rawCarbFactor = (constants as any)?.carb_to_bg_ratio ?? (constants as any)?.carb_to_bg_factor ?? 4.0;
      const effectiveCorrectionFactor: number = (sensitivityMultiplier > 1.0 && activityPDValid && activityPDData.effective_correction_factor)
        ? (activityPDData.effective_correction_factor as number)
        : rawCorrFactor;
      const effectiveCarbToBgRatio: number = (sensitivityMultiplier > 1.0 && activityPDValid && activityPDData.effective_carb_to_bg_ratio)
        ? (activityPDData.effective_carb_to_bg_ratio as number)
        : rawCarbFactor;

      // ── 3. Reset window ───────────────────────────────────────────────────
      const resetHour: number = constants?.daily_reset_hour ?? 7;
      const tzOffset: number = (constants as any)?.timezone_offset_minutes ?? 0;
      const lastResetMs = getLastResetTimeMs(currentTime, resetHour, tzOffset);

      // ── 3b. Baseline mode ──────────────────────────────────────────────────
      const resolvedMode: 'dynamic' | 'preset' =
        ((constants as any)?.baseline_mode === 'preset') ? 'preset' : 'dynamic';

      // ── 4. Filter to active window ────────────────────────────────────────
      // FIX (Bug 4 & 5): cumulative-effects.ts returns 0 for items with
      // timestamp < lastResetMs (strict less-than), meaning items AT the exact
      // reset ms ARE included. Using <= / > here was inconsistent — the boundary
      // item would pass the cumulative calculation but be excluded from these
      // arrays. Changed to < / >= to match cumulative-effects.ts exactly.
      const activeMeals = allMeals.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        if (isNaN(mealMs) || mealMs < lastResetMs) return false;  // FIX: <= → <
        const hoursSince = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);
        if (hoursSince < 0) return false;
        return hoursSince < getMealDurationHours(meal);
      });

      const allMealsInWindow = allMeals.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        return !isNaN(mealMs) && mealMs >= lastResetMs;  // FIX: > → >=
      });

      const activeDosesRaw = allDosesForCalc.filter((dose: any) => {
        const doseMs = parseUTCMs(dose?.administrationTime);
        if (isNaN(doseMs) || doseMs < lastResetMs) return false;  // FIX: <= → <
        const hoursSince = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
        if (hoursSince < 0) return false;
        return hoursSince < getDoseDurationHours(dose, constants);
      });

      const allDosesInWindow = allDosesForCalc.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return !isNaN(doseMs) && doseMs >= lastResetMs;  // FIX: > → >=
      });

      // ── 4b. Doses/meals that are fully absorbed but still in Phase 3 persist ─
      const nextResetMs = getNextResetTimeMs(currentTime, resetHour, tzOffset);
      const absorbedOnlyDoses = allDosesInWindow.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        const hoursSince = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
        return hoursSince >= getDoseDurationHours(d, constants);
      }).length;
      const absorbedOnlyMeals = allMealsInWindow.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        const hoursSince = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);
        return hoursSince >= getMealDurationHours(meal);
      }).length;

      const futureMealsCount = allMealsInWindow.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        return (currentTime.getTime() - mealMs) / (1000 * 60 * 60) < 0;
      }).length;

      const futureDosesCount = allDosesInWindow.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return (currentTime.getTime() - doseMs) / (1000 * 60 * 60) < 0;
      }).length;

      // ── 4c. Projected clear time ──────────────────────────────────────────
      const doseEndTimes = activeDosesRaw.map((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return isNaN(doseMs) ? 0 : doseMs + getDoseDurationHours(d, constants) * 3_600_000;
      });
      const mealEndTimes = allMealsInWindow.map((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        return isNaN(mealMs) ? 0 : mealMs + getMealDurationHours(meal) * 3_600_000;
      });
      const projectedClearMs = Math.max(0, ...doseEndTimes, ...mealEndTimes);

      // ── 5. Map doses → stacking shape ─────────────────────────────────────
      const dosesForStacking: InsulinDoseForStacking[] = activeDosesRaw
        .map((d) => rawDoseToStacking(d, currentTime))
        .filter((d): d is InsulinDoseForStacking => d !== null);

      // ── 6. Frontend IOB / MOB ─────────────────────────────────────────────
      // When sensitivityMultiplier > 1.0 (post-exercise GLUT4 upregulation),
      // use effective_correction_factor for the pending IOB projection so the
      // "remaining BG impact" shown to the user reflects the heightened sensitivity.
      // Use 1.005 threshold to suppress floating-point noise (H-1 fix)
      //
      // ⚠️  SCOPE NOTE (M-3): correctionFactor and carbToBgRatio below are
      // evaluated at "now" using the API's current sensitivity_multiplier.
      // They are authoritative for the single-point-in-time "now" card only.
      //
      // Historical comparison with EVC or BGV chart values at past or future
      // time points will reflect a DIFFERENT sensitivityMultiplierAtTime
      // (time-resolved W-state model, one per chart grid point).  At those
      // points the effective CF = rawCorrFactor × sensitivityMultiplierAtTime(t),
      // not the scalar derived here.  This is expected and intentional: AED is
      // a snapshot, not a time series.  Do not attempt to unify these scalars
      // with EVC/BGV per-point values — they represent different moments in time.
      const correctionFactor = sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : rawCorrFactor;
      const carbToBgRatio    = sensitivityMultiplier > 1.005 ? effectiveCarbToBgRatio    : rawCarbFactor;

      const frontendMOB = calculateStackedMealEffect(allMealsInWindow, currentTime, constants);
      const frontendIOB = calculateStackedInsulinEffect(dosesForStacking, correctionFactor);

      const activeAbsorbedIOBReduction = (frontendIOB?.contributions ?? []).reduce(
        (sum: number, c: any) => sum + Math.max(0, ((c.dose ?? 0) - (c.iob ?? 0))) * correctionFactor,
        0
      );
      // Raw absorbed drop — same insulin units, raw ISF (no post-exercise boost).
      // Used by the IOB card so the absorbed block shows the baseline independently.
      const rawAbsorbedIOBReduction = (frontendIOB?.contributions ?? []).reduce(
        (sum: number, c: any) => sum + Math.max(0, ((c.dose ?? 0) - (c.iob ?? 0))) * rawCorrFactor,
        0
      );

      // ── Per-dose IOB map: administrationTime → remaining IOB units ────────
      // Built by re-running rawDoseToStacking in the same order as dosesForStacking
      // so index aligns with frontendIOB.contributions[].
      const doseMappedToIOB = new Map<string, number>();
      {
        let contribIdx = 0;
        activeDosesRaw.forEach((d: any) => {
          const s = rawDoseToStacking(d, currentTime);
          if (s !== null) {
            const c = (frontendIOB?.contributions ?? [])[contribIdx];
            if (c && d.administrationTime) {
              doseMappedToIOB.set(d.administrationTime, c.iob ?? 0);
            }
            contribIdx++;
          }
        });
      }

      // ── Per-meal BG map: mealId → { bgAbsorbed, bgPending } ──────────────
      const mealMappedToBG = new Map<string, { bgAbsorbed: number; bgPending: number }>();
      (frontendMOB?.contributions ?? []).forEach((c: any) => {
        const id = c.mealId ?? c.id ?? '';
        if (id) {
          mealMappedToBG.set(id, {
            bgAbsorbed: c.currentBgElevation ?? 0,
            bgPending:  c.pendingBgRise     ?? 0,
          });
        }
      });

      // ── 7. Most recent glucose reading ────────────────────────────────────
      const readingRaw = readingsRes?.data;
      const readingArray: any[] = Array.isArray(readingRaw)
        ? readingRaw
        : readingRaw?.readings ?? readingRaw?.data ?? [];

      const readingsInCurrentPeriod = readingArray.filter((r: any) => {
        const ts = parseUTCMs(r?.bloodSugarTimestamp ?? r?.timestamp);
        return !isNaN(ts) && ts >= lastResetMs;
      });

      const recentReading = readingsInCurrentPeriod.length > 0
        ? [...readingsInCurrentPeriod].sort((a: any, b: any) =>
            parseUTCMs(b.bloodSugarTimestamp ?? b.timestamp) -
            parseUTCMs(a.bloodSugarTimestamp ?? a.timestamp)
          )[0]
        : null;

      // ── 7b. Activity–reading overlap detection ────────────────────────────
      // If the reading was taken inside an active session's PD window,
      // calculateStableBaselineFromReading did NOT unwind the activity effect —
      // so cumulativeActivityEffect added in step 10 may double-count exercise impact.
      let activityOverlapWarning = false;
      if (activityPDValid && recentReading) {
        const readingMs = parseUTCMs(
          recentReading.bloodSugarTimestamp ?? recentReading.timestamp
        );
        activityOverlapWarning = activityContributions.some((session: any) => {
          const sessionStart = parseUTCMs(session.start_time);
          const sessionEnd   = parseUTCMs(session.end_time ?? session.start_time) +
                               (session.duration_minutes ?? 60) * 60_000 +
                               (session.pd_tail_hours ?? 2) * 3_600_000;
          return !isNaN(readingMs) && readingMs >= sessionStart && readingMs <= sessionEnd;
        });
      }

      // ── 8. Stable baseline ────────────────────────────────────────────────
      const targetGlucose = constants?.target_glucose ?? 100;
      let frontendBaseline: any = null;

      if (resolvedMode === 'preset') {
        const offsetMs = tzOffset * 60_000;
        const localDate = new Date(currentTime.getTime() + offsetMs);
        const hourFloat = localDate.getUTCHours() + localDate.getUTCMinutes() / 60;

        const circadianProfile = (constants as any)?.circadian_profile;
        const presetValue = getCircadianBaseline(hourFloat, circadianProfile ?? undefined);

        const readingDelta = recentReading?.bloodSugar != null
          ? recentReading.bloodSugar - presetValue
          : null;

        let circadianAtReading: number | null = null;
        let cumulAtReadingNet: number | null = null;
        if (recentReading?.bloodSugar) {
          const readingTs = recentReading.bloodSugarTimestamp ?? recentReading.timestamp;
          const readingMs = parseUTCMs(readingTs);
          if (!isNaN(readingMs)) {
            const localReadingDate = new Date(readingMs + offsetMs);
            const readingHourFloat =
              localReadingDate.getUTCHours() + localReadingDate.getUTCMinutes() / 60;
            circadianAtReading = getCircadianBaseline(readingHourFloat, circadianProfile ?? undefined);

            // ─────────────────────────────────────────────────────────────────
            // BUG FIXED (double-count #1): sensitivity overrides were missing here.
            //
            // ROOT CAUSE:
            //   cumulAtReading was computed with BASE correction_factor and
            //   carb_to_bg_factor, but correctedCumulative (Δnow, computed at
            //   step 10 below) uses BOOSTED effective factors when
            //   sensitivityMultiplier > 1.005.  When the exercise sensitivity
            //   window was active at reading time (e.g. reading at 09:16 PM,
            //   boost ends 09:32 PM), this inconsistency causes readingResidual
            //   to absorb the indirect activity effect at reading time
            //   (boosted insulin absorption + suppressed meal absorption) as
            //   unexplained negativity.  That phantom negativity then propagates
            //   directly into correctedEstimatedBG, inflating the apparent BG
            //   drop beyond what the PK model alone can account for.
            //
            // FIX: mirror the identical pattern from useActiveEffects.ts
            //   lines 1488–1529 — pass the same sensitivity overrides to
            //   cumulAtReading that correctedCumulative receives, so both
            //   cumulative calls use a consistent basis.  When the multiplier
            //   is ≤ 1.005 both calls receive undefined and fall back to base
            //   rates, keeping them self-consistent in the no-exercise case.
            // ─────────────────────────────────────────────────────────────────
            const cumulAtReading = calculateTotalCumulativeEffects(
              allMealsInWindow,
              allDosesInWindow,
              new Date(readingMs),
              constants,
              MEAL_ABSORPTION_PROFILES,
              resetHour,
              tzOffset,
              undefined,                                                              // activities — unwound separately via activityEffectAtReading (Bug 2 fix below)
              sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined, // ← FIX #1: match correctedCumulative basis
              sensitivityMultiplier > 1.005 ? effectiveCarbToBgRatio    : undefined, // ← FIX #1: match correctedCumulative basis
            );
            cumulAtReadingNet = cumulAtReading.cumulativeNetBaseline;
          }
        }

        frontendBaseline = {
          stableBaseline:           presetValue,
          readingValue:             recentReading?.bloodSugar ?? presetValue,
          cumulativeMealEffect:     0,
          cumulativeInsulinEffect:  0,
          cumulativeNetEffect:      readingDelta ?? 0,
          mealsCount:               allMealsInWindow.length,
          insulinCount:             allDosesInWindow.length,
          _isPreset:                true,
          _hourFloat:               hourFloat,
          _readingDelta:            readingDelta,
          _circadianAtReading:      circadianAtReading,
          _cumulAtReadingNet:       cumulAtReadingNet,
        };
      } else {
        if (recentReading?.bloodSugar) {
          frontendBaseline = calculateStableBaselineFromReading(
            {
              id: String(recentReading._id ?? recentReading.id ?? ''),
              value: recentReading.bloodSugar,
              timestamp: recentReading.bloodSugarTimestamp ?? recentReading.timestamp,
              userId: 'current',
              status: recentReading.status,
              source: 'manual',
            },
            allMealsInWindow,
            allDosesInWindow,
            currentTime,
            constants,
            MEAL_ABSORPTION_PROFILES,
            resetHour,
            tzOffset,
            sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined, // ← Step 5
          );

          if (frontendBaseline) {
            const sanitized = sanitizeBaseline(frontendBaseline.stableBaseline);
            if (sanitized.status !== 'ok') {
              frontendBaseline = {
                ...frontendBaseline,
                stableBaseline: sanitized.value,
                warnings: [...(frontendBaseline.warnings ?? []), ...sanitized.warnings],
              };
            }
            (frontendBaseline as any)._clampStatus = sanitized.status;
            (frontendBaseline as any)._clampWarnings = sanitized.warnings;
            (frontendBaseline as any)._rawBaselineValue = sanitized.rawValue;
          }
        }
      }

      // ── 9. Net effect (for safetyStatus / trend) ──────────────────────────
      // FIX (Goal 4 / audit): Pass activityPD so the trend arrow is
      // exercise-adjusted.  The net-effect.ts wrapper accepts exactly 7 params:
      //   (baseline, meals, doses, currentTime, constants, profiles, activityPD?)
      // resetHour / tzOffset are NOT params of this wrapper — the wrapper calls
      // _calculateNetEffect which reads them from patientConstants internally.
      // Previously, resetHour was incorrectly passed as the 7th arg (activityPD
      // slot), so the trend always saw null activity AND the wrong reset hour.
      const frontendNetEffect = calculateNetEffect(
        frontendBaseline,
        allMealsInWindow,   // fix: was activeMeals — omitted fully-absorbed Phase-3 meals
        allDosesInWindow,
        currentTime,
        constants,
        MEAL_ABSORPTION_PROFILES,
        activityPDValid ? (activityPDData as ActivityPDResult) : null,
      );

      // ── 10. Corrected cumulative & estimated BG ───────────────────────────
      const correctedCumulative = calculateTotalCumulativeEffects(
        allMealsInWindow,
        allDosesInWindow,
        currentTime,
        constants,
        MEAL_ABSORPTION_PROFILES,
        resetHour,
        tzOffset,
        undefined,                                                              // activities
        sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined, // param 9: boosted ISF → IOB ✅
        sensitivityMultiplier > 1.005 ? effectiveCarbToBgRatio    : undefined, // param 10: reduced C2B → MOB ✅ (fix)
      );

      const stableBaseline = frontendBaseline?.stableBaseline ?? targetGlucose;

      // ── Activity delta since reading (prevents double-counting already-delivered exercise) ──
      // If a session was fully absorbed before the reading was taken, its BG effect is already
      // baked into the reading value (and therefore into stableBaseline via unwinding).
      // If a session was partially absorbed at reading time, the ramp fraction that had already
      // been delivered is similarly baked in.
      // Adding the full cumulativeActivityEffect in either case would count those portions twice.
      //
      // FIX vs old code:
      //   OLD: binary check — only counted full sessions (readingMs >= sessionEnd).
      //        Sessions active at reading time contributed 0, so the full cumulative_bg_effect
      //        was added as "new delta" even though part of it was already in the reading.
      //        Also: no daily reset guard — yesterday's completed sessions could leak through.
      //   NEW: calculateActivityEffectForCumulative(readingMs) — lock-in model evaluated at
      //        the reading timestamp with the same daily-reset guard used by all four chart
      //        components. Correctly handles full sessions, partial sessions, and pre-reset sessions.
      let activityEffectAtReading = 0;
      if (recentReading?.bloodSugar && activityPDValid) {
        const readingMs = parseUTCMs(
          recentReading.bloodSugarTimestamp ?? recentReading.timestamp
        );
        if (!isNaN(readingMs)) {
activityEffectAtReading = calculateActivityEffectForCumulative(
  readingMs,
  activityContributions,
  lastResetMs,
  readingMs,   // ← ADD THIS: use reading time as "now", not Date.now()
);
        }
      }

      // Delta = what activity has done since (or will do after) the reading.
      // • Sessions fully done before reading → delta = 0 (no new adjustment needed)
      // • Session active at reading time     → partial delta (only the tail)
      // • New session started after reading  → full contribution applied
      const activityDeltaSinceReading = cumulativeActivityEffect - activityEffectAtReading;

      // Activity is the third signed term in the bank-balance model:
      //   estimatedBG = stableBaseline + ΔMeal + ΔInsulin + ΔActivity_since_reading
      const correctedEstimatedBG_raw =
        stableBaseline +
        correctedCumulative.cumulativeNetBaseline +
        activityDeltaSinceReading;

      // ── Reading-residual correction (preset mode only) ────────────────────
      let correctedEstimatedBG = correctedEstimatedBG_raw;
      let readingResidual: number | null = null;

      if (
        resolvedMode === 'preset' &&
        recentReading?.bloodSugar != null &&
        frontendBaseline?._circadianAtReading != null &&
        frontendBaseline?._cumulAtReadingNet != null
      ) {
        // ─────────────────────────────────────────────────────────────────────
        // BUG FIXED (double-count #2): activityEffectAtReading was not subtracted
        // from the residual (N-1 unwind missing).
        //
        // ROOT CAUSE:
        //   correctedEstimatedBG_raw is built as:
        //     circadian@now + pkCumBoosted@now + activityDeltaSinceReading
        //   where activityDeltaSinceReading = cumulativeActivityEffect − activityEffectAtReading.
        //
        //   The reading value itself already reflects whatever exercise effect had
        //   been delivered up to the reading moment.  The residual must therefore
        //   also unwind that portion so it is not counted a second time:
        //     correct residual = reading − circadian@reading − pkCum@reading − activityEffectAtReading
        //
        //   Without the subtraction the direct exercise effect that was already
        //   in the reading leaks into the residual as unexplained negativity,
        //   which then gets added on top of the activityDeltaSinceReading term —
        //   double-counting the delivered portion.
        //
        //   In the scenario where the session fully finished before the reading
        //   (activityEffectAtReading ≈ cumulativeActivityEffect, Δact ≈ 0), the
        //   whole direct effect was in the reading.  Without this fix the entire
        //   direct BG drop (~10 mg/dL) inflates the residual unnecessarily.
        //
        // FIX: mirror the N-1 fix from useActiveEffects.ts lines 1563–1574.
        //   activityEffectAtReading is already computed above for the
        //   activityDeltaSinceReading calculation — reuse it here.
        // ─────────────────────────────────────────────────────────────────────
        readingResidual =
          recentReading.bloodSugar
          - frontendBaseline._circadianAtReading
          - frontendBaseline._cumulAtReadingNet
          - activityEffectAtReading;              // ← FIX #2: N-1 unwind
        correctedEstimatedBG = correctedEstimatedBG_raw + readingResidual;
      }

      // Bug 4 fix: use pending carb grams × sensitivity-adjusted carbToBgRatio instead of
      // totalPendingRise (which was computed with raw C2B, ignoring the GLUT4 sensitivity boost).
      // carbToBgRatio is already set to effectiveCarbToBgRatio when sensitivityMultiplier > 1.005
      // (line 659). totalMOB is the pending carb grams exposed by calculateStackedMealEffect.
      // Confirmed 48–54 mg/dL overcount in two screenshots when sensitivityMultiplier = 1.6.
      const frontendPendingMOBRise   = (frontendMOB?.totalMOB ?? 0) * carbToBgRatio;
      // Use effective correction factor when post-exercise sensitivity is elevated
      const frontendPendingIOBRedux  = (frontendIOB?.totalIOB ?? 0) * correctionFactor;

      // ── Raw-baseline pending: what IOB/MOB would show without the activity boost ──
      // These are the "pure" PK numbers before post-exercise GLUT4 upregulation.
      // Used by the IOB/MOB cards to display the baseline component independently
      // from the ⚡ indirect boost so each card is self-contained and the formula
      // strip breaks out each component cleanly.
      const rawPendingIOBRedux = (frontendIOB?.totalIOB ?? 0) * rawCorrFactor;
      const rawPendingMOBRise  = (frontendMOB?.totalMOB  ?? 0) * rawCarbFactor;
      // Bug 3 fix: subtract activityOnBoard (remaining lock-in ramp direct drop) from projection.
      // AOB is BG-lowering that will arrive after now — structurally identical to pending IOB.
      // activityOnBoard is declared at line ~542 from activityPDData.activity_on_board.
      const frontendPendingNetEffect = frontendPendingMOBRise - frontendPendingIOBRedux - activityOnBoard;

      // simpleProjectedFinalBG — naive projection:
      //   current BG estimate (activity-corrected, residual-corrected) + pending effects.
      //   Matches the formula strip: estimatedBG + Δpending = proj.
      const simpleProjectedFinalBG = correctedEstimatedBG + frontendPendingNetEffect;

      // ── 10b. Indirect activity effects ────────────────────────────────────
      // Post-exercise GLUT4 upregulation has two secondary BG effects beyond the
      // direct AOB drop: (1) IOB more effective — higher ISF, (2) MOB moderated
      // — lower carb-to-BG ratio.  All four numbers are pre-computed here so the
      // four AOB card render IIFEs (header, pending, delivered, indirect) are pure
      // display — no arithmetic.  Adding a 5th sub-section requires zero changes here.
      //
      // sm > 1.005 threshold (H-1 fix): suppresses floating-point noise.
      const _sm = sensitivityMultiplier;
      const _rawISF = _sm > 1.005 ? effectiveCorrectionFactor / _sm : 0;
      const indirectEffects: AobIndirectEffects = _sm > 1.005 ? {
        iobPending: frontendIOB?.totalIOB != null && frontendIOB.totalIOB > 0
          ? frontendIOB.totalIOB * (effectiveCorrectionFactor - _rawISF)
          : 0,
        iobDelivered: activeAbsorbedIOBReduction > 0
          ? activeAbsorbedIOBReduction * (1 - 1 / _sm)
          : 0,
        mobPending: frontendMOB?.totalPendingRise != null && frontendMOB.totalPendingRise > 0
          ? frontendMOB.totalPendingRise * (1 - 1 / _sm)
          : 0,
        mobDelivered: frontendMOB?.totalBGElevation != null && frontendMOB.totalBGElevation > 0
          ? frontendMOB.totalBGElevation * (1 - 1 / _sm)
          : 0,
      } : { iobPending: 0, iobDelivered: 0, mobPending: 0, mobDelivered: 0 };

      // ── 11. Assemble ──────────────────────────────────────────────────────
      const assembled: ActiveEffectData = {
        iob: {
          totalActiveInsulin: frontendIOB?.totalIOB ?? 0,
          activeDoses: dosesForStacking.length,
          currentBGReduction: activeAbsorbedIOBReduction,
          rawCurrentBGReduction: rawAbsorbedIOBReduction,
          pendingBGReduction: frontendPendingIOBRedux,
          rawPendingBGReduction: rawPendingIOBRedux,
        },
        mob: {
          totalActiveCarbs: frontendMOB?.totalMOB ?? 0,
          activeMealCount: activeMeals.length,
          currentBGElevation: frontendMOB?.totalBGElevation ?? 0,
          pendingBGRise: frontendPendingMOBRise,
          rawPendingBGRise: rawPendingMOBRise,
        },
        aob: {
          totalAOB:                activityOnBoard,
          activeSessions,
          cumulativeActivityEffect,
          sensitivityMultiplier,
          activityContributions,
          effectiveCorrectionFactor,
          effectiveCarbToBgRatio,
          indirectEffects,
        },
        netEffect: {
          estimatedBG: correctedEstimatedBG,
          projectedFinalBG: simpleProjectedFinalBG,
          simpleProjectedFinalBG,
          pendingNetEffect: frontendPendingNetEffect,
          cumulativeBaseline: correctedCumulative.cumulativeNetBaseline,
          cumulativeMealEffect: correctedCumulative.cumulativeMealEffect,
          cumulativeInsulinEffect: correctedCumulative.cumulativeInsulinEffect,
          cumulativeActivityEffect,
          activityDeltaSinceReading,
          safetyStatus: bgToSafetyStatus(correctedEstimatedBG),
          trend: frontendNetEffect?.trend ?? 'stable',
          sensitivityMultiplier,
        },
        baseline: frontendBaseline ? {
          value: frontendBaseline.stableBaseline,
          readingValue: frontendBaseline.readingValue,
          readingTimestamp: recentReading?.bloodSugarTimestamp ?? recentReading?.timestamp ?? null,
          cumulativeMealEffect: frontendBaseline.cumulativeMealEffect,
          cumulativeInsulinEffect: frontendBaseline.cumulativeInsulinEffect,
          cumulativeNetEffect: frontendBaseline.cumulativeNetEffect,
          mealsCount: frontendBaseline.mealsCount,
          insulinCount: frontendBaseline.insulinCount,
          isPreset: frontendBaseline._isPreset ?? false,
          readingDelta: frontendBaseline._readingDelta ?? null,
          hourFloat: frontendBaseline._hourFloat ?? null,
          circadianAtReading: frontendBaseline._circadianAtReading ?? null,
          cumulAtReadingNet: frontendBaseline._cumulAtReadingNet ?? null,
          clampStatus: (frontendBaseline as any)._clampStatus ?? 'ok',
          clampWarnings: (frontendBaseline as any)._clampWarnings ?? [],
          rawBaselineValue: (frontendBaseline as any)._rawBaselineValue ?? frontendBaseline.stableBaseline,
          readingResidual: resolvedMode === 'preset' ? (readingResidual ?? null) : null,
        } : undefined,
        metadata: {
          calculatedAt: currentTime.toISOString(),
          // FIX: count only entries since the daily reset (allMealsInWindow), not
          // the full fetch buffer (allMeals) which includes pre-reset history.
          mealsCount: allMealsInWindow.length,
          dosesCount: allDosesInWindow.length,
          hasRecentReading: readingsInCurrentPeriod.length > 0 && !!(recentReading?.bloodSugar),
          nextResetMs,
          absorbedOnlyDoses,
          absorbedOnlyMeals,
          projectedClearMs,
          futureMealsCount,
          futureDosesCount,
          usingTargetFallback: !frontendBaseline,
          activityOverlapWarning,
        },
        dosesInWindow: allDosesInWindow.map((d: any) => {
          const doseMs = parseUTCMs(d.administrationTime);
          const hoursSince = isNaN(doseMs) ? 0 : (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
          const duration = getDoseDurationHours(d, constants);
          const units: number = d.units ?? d.dose ?? 0;
          // Use raw ISF for per-dose BG display — the IOB card shows baseline values only.
          // The indirect (post-exercise) boost is owned by the Activity card.
          const totalBgEffect = units * rawCorrFactor;
          const isActive   = hoursSince >= 0 && hoursSince < duration;
          const isAbsorbed = hoursSince >= duration;
          const isFuture   = hoursSince < 0;

          let bgAbsorbed: number;
          let bgPending: number;
          if (isFuture) {
            bgAbsorbed = 0;
            bgPending  = totalBgEffect;
          } else if (isAbsorbed) {
            bgAbsorbed = totalBgEffect;
            bgPending  = 0;
          } else {
            // Active dose — use PD-accurate IOB from contributions map
            const remainingIOB = doseMappedToIOB.get(d.administrationTime) ?? null;
            if (remainingIOB !== null) {
              bgPending  = remainingIOB * rawCorrFactor;
              bgAbsorbed = Math.max(0, totalBgEffect - bgPending);
            } else {
              // Fallback: linear approximation of absorbed fraction
              const absorbedFrac = Math.min(1, Math.max(0, hoursSince / duration));
              bgAbsorbed = totalBgEffect * absorbedFrac;
              bgPending  = totalBgEffect * (1 - absorbedFrac);
            }
          }

          return {
            id: d.id ?? String(d._id ?? ''),
            units,
            insulinType: d.insulinType ?? d.medication ?? 'insulin',
            administrationTime: d.administrationTime,
            isActive,
            isAbsorbed,
            isFuture,
            bgAbsorbed,
            bgPending,
          };
        }).sort((a: any, b: any) =>
          parseUTCMs(b.administrationTime) - parseUTCMs(a.administrationTime)
        ),
        mealsInWindow: allMealsInWindow.map((meal: any) => {
          const mealMs = parseUTCMs(meal?.timestamp);
          const hoursSince = isNaN(mealMs) ? 0 : (currentTime.getTime() - mealMs) / (1000 * 60 * 60);
          const duration = getMealDurationHours(meal);
          const absType = meal?.calculation_summary?.absorption_type
            ?? meal?.nutrition?.absorption_type
            ?? meal?.nutrition?.absorptionType
            ?? 'medium';
          const mealId = meal.id ?? String(meal._id ?? '');

          // Per-meal BG effect from stacked MOB contributions; fallback to carbs×factor.
          // Always use rawCarbFactor — the MOB card shows baseline values only.
          // The indirect (post-exercise GLUT4) saving is owned by the Activity card.
          const carbToBgFactor = rawCarbFactor;
          const totalCarbs: number =
            meal?.nutrition?.carbs ??
            meal?.nutrition?.total_carbs ??
            meal?.calculation_summary?.total_carbs ?? 0;
          const carbEquiv: number =
            meal?.calculation_summary?.total_carb_equiv ??
            meal?.nutrition?.totalCarbEquiv ??
            totalCarbs;
          const totalBgEffect = carbEquiv * carbToBgFactor;
          const isFuture   = hoursSince < 0;
          const isAbsorbed = hoursSince >= duration;
          const isActive   = !isFuture && !isAbsorbed;

          let bgAbsorbed: number;
          let bgPending: number;
          const contrib = mealMappedToBG.get(mealId);
          if (contrib) {
            bgAbsorbed = contrib.bgAbsorbed;
            bgPending  = contrib.bgPending;
          } else if (isFuture) {
            bgAbsorbed = 0;
            bgPending  = totalBgEffect;
          } else if (isAbsorbed) {
            bgAbsorbed = totalBgEffect;
            bgPending  = 0;
          } else {
            const absorbedFrac = Math.min(1, Math.max(0, hoursSince / duration));
            bgAbsorbed = totalBgEffect * absorbedFrac;
            bgPending  = totalBgEffect * (1 - absorbedFrac);
          }

          return {
            id: mealId,
            mealType: meal.mealType ?? meal.meal_type ?? 'meal',
            timestamp: meal.timestamp ?? null,
            carbs: totalCarbs,
            absorptionType: absType,
            isActive,
            isAbsorbed,
            isFuture,
            bgAbsorbed,
            bgPending,
          };
        }).sort((a: any, b: any) =>
          parseUTCMs(b.timestamp) - parseUTCMs(a.timestamp)
        ),
      };

      setData(assembled);
      // Emit live PK snapshot to parent (MealForm / UnifiedInsulinInput via index.tsx).
      // This is the single source of truth that eliminates the panel discrepancy:
      // both forms read the same estimatedBG / pendingMOB / pendingIOB that AED shows.
      onEffectsComputed?.(assembled);
    } catch (err) {
      console.error('[ActiveEffectDisplay] Error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
      // Always clear the in-flight flag so the next scheduled tick or manual
      // refresh can proceed normally (mirrors useActiveEffects Fix A).
      aedFetchInFlightRef.current = false;
      console.log(`[${instanceIdRef.current}] ✅ fetchAndCalculate DONE`);
    }
  };

  useEffect(() => {
    // Wait until we have real constants from the API, not just defaults.
    // Without `hasLoadedFromAPI` the component fires fetchAndCalculate() twice:
    //   1st with DEFAULT_PATIENT_CONSTANTS (baseline_mode = undefined → dynamic)
    //   2nd with real constants (baseline_mode = 'preset')
    // causing the wrong baseline system to flash briefly before the correct one loads.
    if (constantsLoading || !hasLoadedFromAPI) return;

    // ── Fix B: one-time interval setup (mirrors useActiveEffects intervalSetupDoneRef) ──
    // When usePatientConstants() returns a new `constants` object reference (even
    // with identical values — happens on every 5-min background TTL refresh), this
    // effect re-fires and would otherwise tear down + re-register the interval on
    // top of the still-running previous one.
    //
    // With this guard:
    //   • First invocation  → calls fetchAndCalculate(), sets up interval, sets flag
    //   • Bounce invocation → calls fetchAndCalculate() once (fresh data), returns
    //   • Real dep change (hasLoadedFromAPI / constantsLoading) → cleanup resets flag,
    //     new invocation sets up a fresh interval as intended
    console.log(`[${instanceIdRef.current}] ⚙️ timer-effect fired — intervalSetupDone=${aedIntervalSetupDoneRef.current} reason=constants-change`);
    fetchAndCalculate('timer-effect-mount-or-dep-change');

    if (aedIntervalSetupDoneRef.current) {
      // A constants object bounce re-fired this effect; the interval is still
      // running from the first setup — nothing else needed.
      return;
    }
    aedIntervalSetupDoneRef.current = true;

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;

    const timeoutId = setTimeout(() => {
      fetchAndCalculate('interval-tick');
      intervalId = setInterval(() => fetchAndCalculate('interval-tick'), 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      // Reset flag so navigation-away + back or a genuine dep change starts fresh.
      aedIntervalSetupDoneRef.current = false;
    };
  // ── FIX: was `constants` (full object reference). ────────────────────────────
  // `constants` is a new object on every background TTL re-fetch even when all
  // values are identical, causing this effect to re-fire and re-register the
  // interval.  Only baseline_mode and daily_reset_hour are needed here:
  //   • baseline_mode changes  → different calculation path, must re-run
  //   • daily_reset_hour changes → affects the reset window, must re-run
  // Other constant fields (CF, carb ratio, etc.) are picked up automatically
  // because fetchAndCalculate() always captures the current `constants` via closure
  // (it is re-created on every render).
  //
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constants?.baseline_mode, constants?.daily_reset_hour, constantsLoading, hasLoadedFromAPI]);

  // ── FIX: React to fresh activityPD prop without resetting the 60s timer ────
  //
  // ROOT CAUSE OF THE DELAY:
  //   The timer effect above only re-runs when `constants` or `constantsLoading`
  //   changes. When the parent's useActiveEffects() fetches fresh activity data
  //   and passes it down as `activityPDResult`, the new prop sits unused until
  //   the next 60-second timer tick — causing up to a full minute of stale display.
  //
  //   Meanwhile, EffectsVisualizationChart gets the update instantly because it
  //   consumes the activityPD value directly from useActiveEffects() state, which
  //   re-renders as soon as the fetch resolves.
  //
  // FIX:
  //   A separate, focused effect watches only `propPDResult`. When it changes,
  //   fetchAndCalculate() is called immediately. Since fetchAndCalculate() always
  //   captures the current propPDResult via closure (it is re-created on every
  //   render), the call at lines 345–350 short-circuits the API fetch and uses
  //   the already-available prop value directly — zero extra network requests.
  //
  // prevPDRef prevents a duplicate call on the first render:
  //   - Starts as `undefined` (sentinel meaning "nothing received yet").
  //   - The timer effect already calls fetchAndCalculate() on mount, so we must
  //     skip the first render here to avoid a double-fire.
  //   - On subsequent renders where propPDResult actually changes (new session
  //     logged, refresh() called from parent), prevPDRef !== propPDResult and
  //     fetchAndCalculate() fires immediately.
  //
  // propPDResult === undefined means the prop was never passed (standalone usage).
  // In that case this effect is a no-op and the timer drives fetches as usual.
  const prevPDRef = useRef<ActivityPDResult | null | undefined>(undefined);
  useEffect(() => {
    // Prop not in use (standalone component) — let the timer handle everything
    if (propPDResult === undefined) return;
    // No actual change — skip (also guards the first render)
    if (propPDResult === prevPDRef.current) return;
    prevPDRef.current = propPDResult;
    // Constants not ready yet — the timer effect will call fetchAndCalculate()
    // once constantsLoading flips to false, so nothing is lost here
    if (constantsLoading || !hasLoadedFromAPI) return;
    console.log(`[${instanceIdRef.current}] 📬 propPDResult changed — triggering recalculation`);
    fetchAndCalculate('propPDResult-changed');
  // fetchAndCalculate is intentionally omitted from deps — it is re-created on
  // every render and always captures the current propPDResult via closure, so
  // stale-closure is not a risk. Including it would cause an infinite loop
  // because fetchAndCalculate itself calls setData(), triggering a re-render.
  //
  // FIX: `constants` replaced with stable primitives for the same reason as
  // the timer effect above — a new object reference on every TTL refresh would
  // re-fire this effect and call fetchAndCalculate() redundantly every 5 min.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propPDResult, constantsLoading, constants?.baseline_mode, constants?.daily_reset_hour, hasLoadedFromAPI]);

  // ── FIX: React to fresh meals prop without waiting for the 60s timer ────────
  //
  // ROOT CAUSE OF THE DELAY (same as the propPDResult fix above):
  //   When the parent's useActiveEffects() fetches new meal data and passes it
  //   down as `propMeals`, the component only consumes it on the NEXT 60-second
  //   timer tick — so the MOB / meal card can lag up to a full minute behind.
  //
  // FIX: A focused effect watches propMeals by reference. When the parent's
  //   fetch resolves and produces a new array, this effect fires fetchAndCalculate()
  //   immediately. fetchAndCalculate() sees propMeals !== undefined and uses the
  //   prop directly (Promise.resolve({ data: propMeals })) — zero extra network
  //   requests, just a fast recalculation with the already-available data.
  //
  // prevMealsRef prevents a duplicate call on the first render (same sentinel
  //   logic as prevPDRef above).
  const prevMealsRef = useRef<any[] | undefined>(undefined);
  useEffect(() => {
    // Prop not in use (standalone component) — let the timer handle everything
    if (propMeals === undefined) return;
    // No actual change (same array reference) — skip
    if (propMeals === prevMealsRef.current) return;
    prevMealsRef.current = propMeals;
    if (constantsLoading || !hasLoadedFromAPI) return;
    console.log(`[${instanceIdRef.current}] 🍽️ propMeals changed — triggering recalculation`);
    fetchAndCalculate('propMeals-changed');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propMeals, constantsLoading, constants?.baseline_mode, constants?.daily_reset_hour, hasLoadedFromAPI]);

  // ── FIX: React to fresh insulin doses prop without waiting for the 60s timer ─
  //
  // Same issue and fix as propMeals above — propInsulinDoses arriving from the
  // parent's useActiveEffects() would otherwise sit unused until the next timer
  // tick, causing the IOB / insulin card to appear stale for up to 60 seconds.
  const prevDosesRef = useRef<any[] | undefined>(undefined);
  useEffect(() => {
    // Prop not in use (standalone component) — let the timer handle everything
    if (propInsulinDoses === undefined) return;
    // No actual change (same array reference) — skip
    if (propInsulinDoses === prevDosesRef.current) return;
    prevDosesRef.current = propInsulinDoses;
    if (constantsLoading || !hasLoadedFromAPI) return;
    console.log(`[${instanceIdRef.current}] 💉 propInsulinDoses changed — triggering recalculation`);
    fetchAndCalculate('propInsulinDoses-changed');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propInsulinDoses, constantsLoading, constants?.baseline_mode, constants?.daily_reset_hour, hasLoadedFromAPI]);

  const onRefresh = () => { setRefreshing(true); fetchAndCalculate('pull-to-refresh'); };

  // ── Waiting for real patient constants (pre-load guard) ─────────────────
  // Without this guard the component would render with DEFAULT_PATIENT_CONSTANTS
  // (baseline_mode = undefined → dynamic) before the API responds, then
  // re-render with the correct preset/dynamic mode — causing a visible flash of
  // the wrong baseline system.  Show a neutral spinner instead.
  if (!hasLoadedFromAPI || constantsLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading your profile…</Text>
      </View>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Calculating active effects…</Text>
      </View>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => fetchAndCalculate('button-tap')}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!data) return null;

  const bgHighlight = getHighlight(data.netEffect.estimatedBG);

  const ESTIMATE_UNRELIABLE_THRESHOLD = 10;
  const estimateIsUnreliable = data.netEffect.estimatedBG < ESTIMATE_UNRELIABLE_THRESHOLD;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>⚡ Active Effects</Text>
        <Text style={styles.subtitle}>Live pharmacodynamic summary</Text>
        {/* ── Baseline system badge ── clearly shows which system is active ────── */}
        {/* Two mutually exclusive systems:                                          */}
        {/*   CIRCADIAN (preset) — baseline anchored to the patient's personal       */}
        {/*     circadian BG profile, not to individual readings.                    */}
        {/*   DYNAMIC — baseline derived by unwinding all logged PK effects from     */}
        {/*     the most recent CGM / manual reading.                                */}
        <View style={styles.modeBadgeRow}>
          <View style={[
            styles.modeBadge,
            data.baseline?.isPreset ? styles.modeBadgePreset : styles.modeBadgeDynamic,
          ]}>
            <Text style={[
              styles.modeBadgeText,
              data.baseline?.isPreset ? styles.modeBadgeTextPreset : styles.modeBadgeTextDynamic,
            ]}>
              {data.baseline?.isPreset ? '🌙 Circadian baseline' : '📍 Dynamic baseline'}
            </Text>
          </View>
          <Text style={styles.modeBadgeHint}>
            {data.baseline?.isPreset
              ? (() => {
                  const hf = data.baseline?.hourFloat;
                  const timeStr = hf != null
                    ? `${hf | 0}:${String(Math.round((hf % 1) * 60)).padStart(2, '0')}`
                    : '—';
                  const baselineVal = data.baseline?.value != null
                    ? ` · ${data.baseline.value.toFixed(0)} mg/dL`
                    : '';
                  return `Profile at ${timeStr}${baselineVal}`;
                })()
              : data.baseline?.value != null
                ? `From last reading · ${data.baseline.value.toFixed(0)} mg/dL`
                : 'From last reading'}
          </Text>
        </View>
        <Text style={styles.timestamp}>
        </Text>
      </View>

      {/* ── Baseline clamp warning banner ─────────────────────────────────── */}
      {data.baseline?.clampStatus === 'hard_clamped' && (
        <View style={styles.clampBanner}>
          <View style={styles.clampBannerRow}>
            <Text style={styles.clampBannerIcon}>⚠️</Text>
            <View style={styles.clampBannerTextCol}>
              <Text style={styles.clampBannerTitle}>Baseline Capped</Text>
              <Text style={styles.clampBannerBody}>
                Raw baseline was{' '}
                <Text style={styles.clampBannerHighlight}>
                  {data.baseline.rawBaselineValue?.toFixed(0)} mg/dL
                </Text>
                {' '}— outside the physiological range.{' '}
                Capped at{' '}
                <Text style={styles.clampBannerHighlight}>
                  {data.baseline.value.toFixed(0)} mg/dL
                </Text>
                .
              </Text>
              <Text style={styles.clampBannerReason}>
                {(data.baseline.rawBaselineValue ?? 0) < 55
                  ? '💉 Likely cause: unlogged insulin dose or unexpected physical activity.'
                  : '🍽️ Likely cause: unlogged meal or snack.'}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* ── Soft baseline warning: 55–75 mg/dL (dynamic mode, below hard clamp) ── */}
      {/* Fires when baseline passed the hard clamp (>= 55) but is still unusually    */}
      {/* low — a range that often reflects unlogged insulin or an activity blind-spot.*/}
      {/* Preset mode is excluded: circadian profile values are clinically bounded and */}
      {/* cannot reach this range under normal operation.                              */}
      {!data.baseline?.isPreset &&
       data.baseline?.clampStatus !== 'hard_clamped' &&
       data.baseline?.value != null &&
       data.baseline.value >= 55 &&
       data.baseline.value < 75 && (
        <View style={[styles.clampBanner, { borderLeftColor: '#f9a825', backgroundColor: '#fffde7' }]}>
          <View style={styles.clampBannerRow}>
            <Text style={styles.clampBannerIcon}>⚠️</Text>
            <View style={styles.clampBannerTextCol}>
              <Text style={[styles.clampBannerTitle, { color: '#e65100' }]}>Low Baseline Detected</Text>
              <Text style={styles.clampBannerBody}>
                Derived baseline is{' '}
                <Text style={[styles.clampBannerHighlight, { color: '#e65100' }]}>
                  {data.baseline.value.toFixed(0)} mg/dL
                </Text>
                {' '}— lower than a typical fasting level. Possible causes:
              </Text>
              <Text style={[styles.clampBannerReason, { marginTop: 4 }]}>
                {'💉 Unlogged insulin dose suppressing the baseline\n'}
                {'🏃 Recent exercise that wasn\'t recorded\n'}
                {'🍽️ Fewer meals logged than actually eaten'}
              </Text>
              <Text style={[styles.clampBannerReason, { marginTop: 4 }]}>
                Review today's logs and pull down to refresh.
              </Text>
            </View>
          </View>
        </View>
      )}


      {/* ── Reading-residual alert (preset/circadian mode only) ──────────────── */}
      {/* Fires when the actual BG reading diverges from what the circadian        */}
      {/* profile + all logged entries predict.  Translates the gap into carb or   */}
      {/* insulin equivalents and surfaces the most likely cause to the patient.   */}
      {/* Does NOT fire in dynamic mode — baseline clamping banners cover that.    */}
      {(() => {
        if (!data.baseline?.isPreset) return null;
        if (estimateIsUnreliable) return null;
        const residual = data.baseline?.readingResidual;
        if (residual == null) return null;

        const carbFactor  = data.aob.effectiveCarbToBgRatio  || 4;
        const corrFactor  = data.aob.effectiveCorrectionFactor || 40;
        const readingTs   = data.baseline?.readingTimestamp;
        const minutesSinceReading = readingTs
          ? Math.round((Date.now() - new Date(readingTs).getTime()) / 60_000)
          : 0;

        const cls = classifyResidual(
          residual,
          data.baseline.mealsCount ?? 0,
          data.baseline.insulinCount ?? 0,
          carbFactor,
          corrFactor,
          minutesSinceReading,
          data.metadata.activityOverlapWarning,
        );

        if (cls.tier === 'noise') return null;

        const isHigh       = cls.direction === 'high';
        const bannerColor  = cls.tier === 'critical' ? '#ffebee' : '#fff8e1';
        const borderColor  = cls.tier === 'critical' ? '#c62828' : '#f9a825';
        const titleColor   = cls.tier === 'critical' ? '#b71c1c' : '#e65100';

        return (
          <View style={[styles.clampBanner, { backgroundColor: bannerColor, borderLeftColor: borderColor }]}>
            <View style={styles.clampBannerRow}>
              <Text style={styles.clampBannerIcon}>{isHigh ? '🍽️' : '💉'}</Text>
              <View style={styles.clampBannerTextCol}>
                <Text style={[styles.clampBannerTitle, { color: titleColor }]}>
                  {cls.title}
                </Text>
                <Text style={styles.clampBannerBody}>
                  {'Reading residual: '}
                  <Text style={[styles.clampBannerHighlight, { color: titleColor }]}>
                    {residual >= 0 ? '+' : ''}{residual.toFixed(0)} mg/dL
                  </Text>
                  {' unexplained by circadian profile + logged entries.'}
                </Text>
                {cls.body ? (
                  <Text style={[styles.clampBannerReason, { marginTop: 4 }]}>
                    {cls.body}
                  </Text>
                ) : null}
                {cls.hint ? (
                  <Text style={[styles.clampBannerReason, { marginTop: 4, color: '#888' }]}>
                    {cls.hint}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        );
      })()}

      {/* ── Unreliable estimate alert (replaces three BG cards) ──────────────── */}
      {estimateIsUnreliable && (
        <View style={styles.unreliableBanner}>
          <View style={styles.unreliableBannerHeader}>
            <Text style={styles.unreliableBannerIcon}>⚠️</Text>
            <Text style={styles.unreliableBannerTitle}>Estimation Unreliable</Text>
          </View>
          <Text style={styles.unreliableBannerBody}>
            The calculated BG estimate ({data.netEffect.estimatedBG.toFixed(0)} mg/dL) is
            below the physiologically possible range. This almost always means today's
            logs are incomplete or contain an error.
          </Text>
          <Text style={styles.unreliableBannerSubtitle}>
            Check that all of today's entries are logged correctly:
          </Text>
          <View style={styles.unreliableChecklist}>

            {/* ── Meals ── */}
            <View style={styles.unreliableCheckRow}>
              <Text style={styles.unreliableCheckIcon}>🍽️</Text>
              <View style={styles.unreliableCheckText}>
                <Text style={styles.unreliableCheckLabel}>Meals logged today</Text>
                <Text style={styles.unreliableCheckHint}>
                  {data.metadata.mealsCount > 0
                    ? `${data.metadata.mealsCount} meal${data.metadata.mealsCount !== 1 ? 's' : ''} found — verify portion sizes, carb counts, and timestamps`
                    : 'No meals logged — log any meals or snacks eaten since your daily reset'}
                </Text>
              </View>
              <Text style={[
                styles.unreliableCheckStatus,
                data.metadata.mealsCount > 0 ? styles.unreliableCheckOk : styles.unreliableCheckWarn,
              ]}>
                {data.metadata.mealsCount > 0 ? `${data.metadata.mealsCount} ✓` : '0 ✗'}
              </Text>
            </View>

            <View style={styles.unreliableCheckDivider} />

            {/* ── Insulin doses ── */}
            <View style={styles.unreliableCheckRow}>
              <Text style={styles.unreliableCheckIcon}>💉</Text>
              <View style={styles.unreliableCheckText}>
                <Text style={styles.unreliableCheckLabel}>Insulin doses logged today</Text>
                <Text style={styles.unreliableCheckHint}>
                  {data.metadata.dosesCount > 0
                    ? `${data.metadata.dosesCount} dose${data.metadata.dosesCount !== 1 ? 's' : ''} found — verify units and times, especially basal or correction doses`
                    : 'No doses logged — if you took insulin today, log each dose with the correct time and units'}
                </Text>
              </View>
              <Text style={[
                styles.unreliableCheckStatus,
                data.metadata.dosesCount > 0 ? styles.unreliableCheckOk : styles.unreliableCheckWarn,
              ]}>
                {data.metadata.dosesCount > 0 ? `${data.metadata.dosesCount} ✓` : '0 ✗'}
              </Text>
            </View>

            <View style={styles.unreliableCheckDivider} />

            {/* ── BG reading ── */}
            <View style={styles.unreliableCheckRow}>
              <Text style={styles.unreliableCheckIcon}>🩸</Text>
              <View style={styles.unreliableCheckText}>
                <Text style={styles.unreliableCheckLabel}>Blood glucose reading today</Text>
                <Text style={styles.unreliableCheckHint}>
                  {data.metadata.hasRecentReading
                    ? 'Reading found — confirm the value and time are correct'
                    : 'No reading from today — log a manual reading or sync your CGM to anchor the estimate'}
                </Text>
              </View>
              <Text style={[
                styles.unreliableCheckStatus,
                data.metadata.hasRecentReading ? styles.unreliableCheckOk : styles.unreliableCheckWarn,
              ]}>
                {data.metadata.hasRecentReading ? '✓' : '✗'}
              </Text>
            </View>

          </View>

          <Text style={styles.unreliableBannerFooter}>
            Once your logs are corrected, pull down to refresh — the estimate will
            recalculate automatically.
          </Text>
        </View>
      )}

      {/* ── Three-card row: Last Reading → Estimated Now → Projected ─── */}
      {!estimateIsUnreliable && <View style={styles.bgTriRow}>

        {/* CARD 1 — Last measured reading */}
        <View style={[styles.bgTriCard, styles.bgTriCardLeft]}>
          <Text style={styles.bgCardEyebrow}>LAST READING</Text>
          {data.baseline ? (
            <>
              <Text style={[styles.bgTriValue, styles[getHighlight(data.baseline.readingValue)]]}>
                {data.baseline.readingValue.toFixed(0)}
              </Text>
              <Text style={styles.bgCardUnit}>mg/dL</Text>

              {data.baseline.readingTimestamp ? (
                <Text style={styles.bgReadingAge}>
                  {new Date(parseUTCMs(data.baseline.readingTimestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {'  ·  '}
                  {formatRelativeTime(Date.now() - parseUTCMs(data.baseline.readingTimestamp))}
                </Text>
              ) : data.baseline.isPreset ? (
                <Text style={styles.bgReadingAge}>No reading today — using circadian</Text>
              ) : null}

              {detailsExpanded && (
                <Text style={styles.bgAnchorMeta}>
                  {data.baseline.mealsCount}🍽️ · {data.baseline.insulinCount}💉 since reset
                </Text>
              )}

              {detailsExpanded && (
                data.baseline.isPreset ? (
                  data.baseline.circadianAtReading != null && data.baseline.readingTimestamp ? (
                    <>
                      <View style={styles.bgFormulaStrip}>
                        <Text style={styles.bgFormulaText}>
                          {data.baseline.readingValue.toFixed(0)}
                        </Text>
                        <Text style={styles.bgFormulaMuted}> − </Text>
                        <Text style={[styles.bgFormulaText, styles.good]}>
                          {data.baseline.circadianAtReading.toFixed(0)}
                        </Text>
                        <Text style={styles.bgFormulaMuted}> = </Text>
                        <Text style={[
                          styles.bgFormulaResult,
                          (data.baseline.readingValue - data.baseline.circadianAtReading) >= 0
                            ? styles.warning : styles.good,
                        ]}>
                          {(data.baseline.readingValue - data.baseline.circadianAtReading) >= 0 ? '+' : ''}
                          {(data.baseline.readingValue - data.baseline.circadianAtReading).toFixed(0)}
                        </Text>
                      </View>
                      <Text style={styles.bgFormulaLabel}>reading − circadian = Δ observed</Text>

                      {data.baseline.cumulAtReadingNet != null && (
                        <Text style={[styles.bgAnchorMeta, { marginTop: 3 }]}>
                          PK model at reading:{' '}
                          <Text style={{ fontWeight: '700' }}>
                            {data.baseline.cumulAtReadingNet >= 0 ? '+' : ''}
                            {data.baseline.cumulAtReadingNet.toFixed(0)} mg/dL
                          </Text>
                          {' '}(
                          {Math.abs((data.baseline.readingValue - data.baseline.circadianAtReading) - data.baseline.cumulAtReadingNet) <= 10
                            ? '✓ consistent'
                            : (data.baseline.readingValue - data.baseline.circadianAtReading) > data.baseline.cumulAtReadingNet
                              ? '↑ reading > model'
                              : '↓ reading < model'
                          })
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      <View style={styles.bgFormulaStrip}>
                        <Text style={styles.bgFormulaText}>
                          {data.baseline.value.toFixed(0)}
                        </Text>
                        <Text style={styles.bgFormulaMuted}> + </Text>
                        <Text style={[
                          styles.bgFormulaText,
                          data.netEffect.cumulativeBaseline >= 0 ? styles.warning : styles.good,
                        ]}>
                          ({data.netEffect.cumulativeBaseline >= 0 ? '+' : ''}{data.netEffect.cumulativeBaseline.toFixed(0)})
                        </Text>
                        <Text style={styles.bgFormulaMuted}> = </Text>
                        <Text style={styles.bgFormulaResult}>
                          {data.netEffect.estimatedBG.toFixed(0)}
                        </Text>
                      </View>
                      <Text style={styles.bgFormulaLabel}>circadian + PK Δ = est. BG</Text>
                      <Text style={[styles.bgAnchorMeta, { marginTop: 2 }]}>No reading today</Text>
                    </>
                  )
                ) : (
                  <>
                    <View style={styles.bgFormulaStrip}>
                      <Text style={styles.bgFormulaText}>
                        {data.baseline.readingValue.toFixed(0)}
                      </Text>
                      <Text style={styles.bgFormulaMuted}> − </Text>
                      <Text style={[
                        styles.bgFormulaText,
                        data.baseline.cumulativeNetEffect >= 0 ? styles.warning : styles.good,
                      ]}>
                        ({data.baseline.cumulativeNetEffect >= 0 ? '+' : ''}{data.baseline.cumulativeNetEffect.toFixed(0)})
                      </Text>
                      <Text style={styles.bgFormulaMuted}> = </Text>
                      <Text style={styles.bgFormulaResult}>
                        {data.baseline.value.toFixed(0)}
                      </Text>
                    </View>
                    <Text style={styles.bgFormulaLabel}>reading − effects = baseline</Text>
                  </>
                )
              )}
            </>
          ) : (
            <>
              <Text style={[styles.bgTriValue, styles.good]}>—</Text>
              <Text style={styles.bgCardUnit}>mg/dL</Text>
              <Text style={styles.bgAnchorMeta}>No reading today</Text>
              <Text style={styles.bgAnchorBaseline}>Using target fallback</Text>
            </>
          )}
        </View>

        {/* Arrow 1 */}
        {(() => {
          const delta = data.baseline ? data.netEffect.estimatedBG - data.baseline.readingValue : null;
          const arrowSym = delta == null ? '→' : delta > 5 ? '↗' : delta < -5 ? '↘' : '→';
          const arrowClr = delta == null ? '#bbb' : delta > 5 ? '#FF9800' : delta < -5 ? '#9C27B0' : '#4CAF50';
          const sign = delta != null && delta >= 0 ? '+' : '';
          return (
            <View style={styles.bgArrowCol}>
              <Text style={[styles.bgArrow, { color: arrowClr }]}>{arrowSym}</Text>
              {delta != null && (
                <Text style={[styles.bgArrowLabel, { color: arrowClr, fontSize: 10, fontWeight: '700' }]}>
                  {sign}{delta.toFixed(0)}
                </Text>
              )}
              <Text style={styles.bgArrowLabel}>Δ from reading</Text>
            </View>
          );
        })()}

        {/* CARD 2 — Current PK estimate */}
        <View style={[styles.bgTriCard, styles.bgTriCardMid]}>
          <Text style={styles.bgCardEyebrow}>ESTIMATED NOW</Text>
          <Text style={[styles.bgTriValue, styles[bgHighlight]]}>
            {data.netEffect.estimatedBG.toFixed(0)}
          </Text>
          <Text style={styles.bgCardUnit}>mg/dL</Text>
          <Text style={styles.bgReadingAge}>
            {new Date(data.metadata.calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {'  ·  now'}
          </Text>
          <Text style={[styles.bgEstStatus, styles[bgHighlight]]}>
            {data.netEffect.safetyStatus.replace(/_/g, ' ')}
          </Text>
          {data.metadata.usingTargetFallback && (
            <Text style={[styles.bgAnchorMeta, { color: '#888', fontStyle: 'italic' }]}>
              ⚠ No reading — target anchor
            </Text>
          )}
          {detailsExpanded && data.baseline && (
            <>
              <View style={styles.bgFormulaStrip}>
                <Text style={styles.bgFormulaText}>
                  {data.baseline.value.toFixed(0)}
                </Text>
                <Text style={styles.bgFormulaMuted}> + </Text>
                <Text style={[
                  styles.bgFormulaText,
                  data.netEffect.cumulativeBaseline >= 0 ? styles.warning : styles.good,
                ]}>
                  ({data.netEffect.cumulativeBaseline >= 0 ? '+' : ''}{data.netEffect.cumulativeBaseline.toFixed(0)})
                </Text>
                {/* Activity delta — shown when non-zero OR when post-exercise sensitivity is still active */}
                {(data.netEffect.activityDeltaSinceReading !== 0 || data.aob.sensitivityMultiplier > 1.0) && (
                  <>
                    <Text style={styles.bgFormulaMuted}> + </Text>
                    <Text style={[styles.bgFormulaText, styles.aobValue]}>
                      ({data.netEffect.activityDeltaSinceReading >= 0 ? '+' : ''}{data.netEffect.activityDeltaSinceReading.toFixed(0)})
                    </Text>
                  </>
                )}
                {/* Reading residual — preset/circadian mode only */}
                {data.baseline?.isPreset && data.baseline?.readingResidual != null && (
                  <>
                    <Text style={styles.bgFormulaMuted}> + </Text>
                    <Text style={[
                      styles.bgFormulaText,
                      (data.baseline.readingResidual ?? 0) >= 0 ? styles.warning : styles.good,
                    ]}>
                      ({(data.baseline.readingResidual ?? 0) >= 0 ? '+' : ''}
                       {(data.baseline.readingResidual ?? 0).toFixed(0)})
                    </Text>
                  </>
                )}
                <Text style={styles.bgFormulaMuted}> = </Text>
                <Text style={styles.bgFormulaResult}>
                  {data.netEffect.estimatedBG.toFixed(0)}
                </Text>
              </View>
              <Text style={styles.bgFormulaLabel}>
                {data.baseline?.isPreset
                  ? (data.netEffect.activityDeltaSinceReading !== 0 || data.aob.sensitivityMultiplier > 1.0)
                    ? (data.baseline?.readingResidual != null
                        ? 'circadian + Δnow + Δact + Δresid = est.'
                        : 'circadian + Δnow + Δact = est.')
                    : (data.baseline?.readingResidual != null
                        ? 'circadian + Δnow + Δresid = est.'
                        : 'circadian + Δnow = est.')
                  : (data.netEffect.activityDeltaSinceReading !== 0 || data.aob.sensitivityMultiplier > 1.0)
                    ? 'baseline + Δnow + Δact = est.'
                    : 'baseline + Δnow = est.'}
              </Text>
            </>
          )}
        </View>

        {/* Arrow 2 */}
        {(() => {
          const delta2 = data.netEffect.projectedFinalBG - data.netEffect.estimatedBG;
          const arrowSym2 = delta2 > 5 ? '↗' : delta2 < -5 ? '↘' : '→';
          const arrowClr2 = delta2 > 5 ? '#FF9800' : delta2 < -5 ? '#9C27B0' : '#4CAF50';
          const sign2 = delta2 >= 0 ? '+' : '';
          return (
            <View style={styles.bgArrowCol}>
              <Text style={[styles.bgArrow, { color: arrowClr2 }]}>{arrowSym2}</Text>
              <Text style={[styles.bgArrowLabel, { color: arrowClr2, fontSize: 10, fontWeight: '700' }]}>
                {sign2}{delta2.toFixed(0)}
              </Text>
              <Text style={styles.bgArrowLabel}>pending</Text>
            </View>
          );
        })()}

        {/* CARD 3 — Projected final */}
        <View style={[styles.bgTriCard, styles.bgTriCardRight]}>
          <Text style={styles.bgCardEyebrow}>PROJECTED</Text>
          <Text style={[
            styles.bgTriValue,
            data.netEffect.pendingNetEffect >= 0 ? styles.warning : styles.good,
          ]}>
            {data.netEffect.projectedFinalBG.toFixed(0)}
          </Text>
          <Text style={styles.bgCardUnit}>mg/dL</Text>
          {data.metadata.projectedClearMs > Date.now() ? (
            <Text style={styles.bgReadingAge}>
              clears in {formatCountdown(data.metadata.projectedClearMs - Date.now())}
            </Text>
          ) : (
            <Text style={styles.bgReadingAge}>effects cleared</Text>
          )}
          {detailsExpanded && (
            <Text style={[
              styles.bgEstStatus,
              data.netEffect.pendingNetEffect >= 0 ? styles.warning : styles.good,
            ]}>
              {data.netEffect.pendingNetEffect >= 0 ? '+' : ''}{data.netEffect.pendingNetEffect.toFixed(0)} pending
            </Text>
          )}

          {detailsExpanded && data.baseline && (
            <>
              <View style={styles.bgFormulaStrip}>
                <Text style={styles.bgFormulaText}>{data.netEffect.estimatedBG.toFixed(0)}</Text>
                <Text style={styles.bgFormulaMuted}> + </Text>
                <Text style={[
                  styles.bgFormulaText,
                  data.netEffect.pendingNetEffect >= 0 ? styles.warning : styles.good,
                ]}>
                  ({data.netEffect.pendingNetEffect >= 0 ? '+' : ''}
                  {data.netEffect.pendingNetEffect.toFixed(0)})
                </Text>
                <Text style={styles.bgFormulaMuted}> = </Text>
                <Text style={styles.bgFormulaResult}>{data.netEffect.projectedFinalBG.toFixed(0)}</Text>
              </View>
              <Text style={styles.bgFormulaLabel}>estimated now + pending = proj.</Text>
            </>
          )}

        </View>

      </View>}

      {/* ── Activity–reading overlap warning ─────────────────────────────── */}
      {!estimateIsUnreliable && data.metadata.activityOverlapWarning && (
        <Text style={{ color: '#FF9800', fontSize: 11, marginHorizontal: 16, marginTop: 4, fontStyle: 'italic' }}>
          ⚡ Reading taken during/after exercise — baseline may reflect activity effect
        </Text>
      )}

      {/* ── More details toggle ────────────────────────────────────────── */}
      {!estimateIsUnreliable && (
        <TouchableOpacity
          onPress={() => setDetailsExpanded(prev => !prev)}
          style={styles.detailsToggle}
        >
          <Text style={styles.detailsToggleText}>
            {detailsExpanded ? '▲ Hide details' : '▼ More details'}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Two-column: IOB + MOB ──────────────────────────────────────── */}
      <View style={styles.columns}>

        {/* LEFT — IOB */}
        <View style={[styles.column, styles.columnLeft, styles.columnIOB]}>
          <TouchableOpacity
            onPress={() => setIobExpanded(prev => !prev)}
            activeOpacity={0.75}
            style={styles.cardCollapseHeader}
          >
            <View style={styles.cardCollapseHeaderLeft}>
              <Text style={[styles.colTitle, styles.colTitleIOB]}>💉 Insulin On Board</Text>
              {data.iob.rawPendingBGReduction > 0 ? (
                <Text style={[styles.colMainValue, styles.negative]}>
                  −{data.iob.rawPendingBGReduction.toFixed(0)} mg/dL
                </Text>
              ) : (
                <>
                  <Text style={styles.colNoPending}>No future insulin effect</Text>
                  <Text style={styles.colNoPendingHint}>based on logged data</Text>
                </>
              )}
              <Text style={styles.colSubValue}>
                {data.iob.totalActiveInsulin.toFixed(2)}u · {data.iob.activeDoses} dose{data.iob.activeDoses !== 1 ? 's' : ''}
              </Text>
            </View>
            <Text style={styles.cardCollapseChevron}>{iobExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {iobExpanded && (
            <>
              <View style={[styles.impactBlock, styles.impactBlockPending]}>
                <Text style={styles.impactPending}>
                  ⏳ -{data.iob.rawPendingBGReduction.toFixed(0)} mg/dL pending
                </Text>
                <Text style={styles.impactNote}>
                  From IOB ({data.iob.totalActiveInsulin.toFixed(1)}u){'\n'}PRESENT→FUTURE
                </Text>
                {data.metadata.futureDosesCount > 0 && data.iob.totalActiveInsulin === 0 && (
                  <Text style={[styles.impactNote, { color: '#ab47bc', marginTop: 3 }]}>
                    +{data.metadata.futureDosesCount} coming dose{data.metadata.futureDosesCount !== 1 ? 's' : ''} not yet counted
                  </Text>
                )}
              </View>

              <View style={styles.impactBlock}>
            {data.iob.activeDoses > 0 && data.iob.rawCurrentBGReduction > 0 ? (
              <>
                <Text style={styles.impactAbsorbed}>
                  ✅ -{data.iob.rawCurrentBGReduction.toFixed(0)} mg/dL absorbed
                </Text>
                <Text style={styles.impactNote}>
                  From active dose(s) so far{'\n'}(PAST→PRESENT)
                </Text>
              </>
            ) : data.metadata.futureDosesCount > 0 ? (
              <>
                <Text style={styles.impactAbsorbed}>
                  ⏳ {data.metadata.futureDosesCount} dose{data.metadata.futureDosesCount !== 1 ? 's' : ''} starting soon
                </Text>
                <Text style={styles.impactNote}>
                  Logged — effect not yet started{'\n'}
                  Reduction pending — not yet absorbed{'\n'}
                </Text>
              </>
            ) : data.metadata.absorbedOnlyDoses > 0 ? (
              <>
                <Text style={styles.impactAbsorbed}>✅ No active insulin</Text>
                <Text style={styles.impactNote}>
                  {data.metadata.absorbedOnlyDoses} dose{data.metadata.absorbedOnlyDoses !== 1 ? 's' : ''} fully absorbed today · ↓ BG
                </Text>
                <Text style={styles.resetCountdown}>
                  ↻ Clears at reset ({formatCountdown(data.metadata.nextResetMs - Date.now())})
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.impactAbsorbed}>✅ No insulin today</Text>
                <Text style={styles.impactNote}>(PAST→PRESENT)</Text>
              </>
            )}
              </View>

              {/* ── Per-dose breakdown (collapsible) ── */}
              {data.dosesInWindow.length > 0 && (
                <>
                  <TouchableOpacity
                    style={styles.subCollapseToggle}
                    onPress={() => setIobDosesExpanded(prev => !prev)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.subCollapseLabel}>
                      {data.dosesInWindow.length} dose{data.dosesInWindow.length !== 1 ? 's' : ''} this window
                    </Text>
                    <Text style={styles.subCollapseChevron}>{iobDosesExpanded ? '▲' : '▼'}</Text>
                  </TouchableOpacity>

                  {iobDosesExpanded && (
                    <View style={styles.subItemList}>
                      {data.dosesInWindow.map((dose, idx) => (
                        <View key={dose.id || idx} style={styles.subItemRow}>
                          {/* Status pill */}
                          <View style={[
                            styles.subStatusPill,
                            dose.isFuture   ? styles.subPillFuture
                            : dose.isActive ? styles.subPillActive
                            :                 styles.subPillAbsorbed,
                          ]}>
                            <Text style={styles.subStatusPillText}>
                              {dose.isFuture ? 'F' : dose.isActive ? 'A' : '✓'}
                            </Text>
                          </View>

                          <View style={styles.subItemInfo}>
                            <Text style={styles.subItemLabel}>
                              {dose.units.toFixed(1)}u · {dose.insulinType.replace(/_/g, ' ')}
                            </Text>
                            <Text style={styles.subItemMeta}>
                              {dose.administrationTime
                                ? formatLocalTime(parseUTCMs(dose.administrationTime)) +
                                  '  ·  ' +
                                  (dose.isFuture
                                    ? 'upcoming'
                                    : formatRelativeTime(Date.now() - parseUTCMs(dose.administrationTime)))
                                : '—'}
                            </Text>
                            {/* BG effect line */}
                            <Text style={styles.subItemBgEffect}>
                              {dose.isFuture ? (
                                `⏳ −${dose.bgPending.toFixed(0)} mg/dL pending`
                              ) : dose.isAbsorbed ? (
                                `✓ −${dose.bgAbsorbed.toFixed(0)} mg/dL delivered`
                              ) : (
                                `−${dose.bgAbsorbed.toFixed(0)} done · −${dose.bgPending.toFixed(0)} pending`
                              )}
                            </Text>
                          </View>

                          <Text style={[
                            styles.subItemStatus,
                            dose.isFuture   ? styles.subStatusFutureText
                            : dose.isActive ? styles.subStatusActiveText
                            :                 styles.subStatusAbsorbedText,
                          ]}>
                            {dose.isFuture ? 'upcoming' : dose.isActive ? 'active' : 'done'}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}
            </>
          )}
        </View>

        {/* RIGHT — MOB */}
        <View style={[styles.column, styles.columnRight, styles.columnMOB]}>
          <TouchableOpacity
            onPress={() => setMobExpanded(prev => !prev)}
            activeOpacity={0.75}
            style={styles.cardCollapseHeader}
          >
            <View style={styles.cardCollapseHeaderLeft}>
              <Text style={[styles.colTitle, styles.colTitleMOB]}>🍽️ Meal On Board (MOB)</Text>
              {data.mob.rawPendingBGRise > 0 ? (
                <Text style={[styles.colMainValue, styles.warning]}>
                  +{data.mob.rawPendingBGRise.toFixed(0)} mg/dL
                </Text>
              ) : (
                <>
                  <Text style={styles.colNoPending}>No future meal effect</Text>
                  <Text style={styles.colNoPendingHint}>based on logged data</Text>
                </>
              )}
              <Text style={styles.colSubValue}>
                {data.mob.totalActiveCarbs.toFixed(1)}g · {data.mob.activeMealCount} meal{data.mob.activeMealCount !== 1 ? 's' : ''}
                {data.mob.activeMealCount > 0 ? ' · digesting' : ''}
              </Text>
            </View>
            <Text style={styles.cardCollapseChevron}>{mobExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {mobExpanded && (
            <>
              <View style={[styles.impactBlock, styles.impactBlockPendingMeal]}>
                <Text style={styles.impactMealPending}>
                  ⏳ +{data.mob.rawPendingBGRise.toFixed(0)} mg/dL pending
                </Text>
                <Text style={styles.impactNote}>
                  From MOB ({data.mob.totalActiveCarbs.toFixed(1)}g){'\n'}PRESENT→FUTURE
                </Text>
              </View>

              <View style={styles.impactBlock}>
            {data.mob.activeMealCount > 0 && data.mob.currentBGElevation > 0 ? (
              <>
                <Text style={styles.impactMealAbsorbed}>
                  ✅ +{data.mob.currentBGElevation.toFixed(0)} mg/dL absorbed
                </Text>
                <Text style={styles.impactNote}>
                  From active meal(s) so far{'\n'}(PAST→PRESENT)
                </Text>
              </>
            ) : data.metadata.futureMealsCount > 0 ? (
              <>
                <Text style={styles.impactMealAbsorbed}>⏳ {data.metadata.futureMealsCount} meal(s) starting soon</Text>
                <Text style={styles.impactNote}>
                  Logged with pre-meal insulin offset{'\n'}
                  Effect pending — not yet absorbed{'\n'}
                </Text>
              </>
            ) : data.metadata.absorbedOnlyMeals > 0 ? (
              <>
                <Text style={styles.impactMealAbsorbed}>✅ No active meals</Text>
                <Text style={styles.impactNote}>
                  {data.metadata.absorbedOnlyMeals} meal{data.metadata.absorbedOnlyMeals !== 1 ? 's' : ''} fully digested today · ↑ BG
                </Text>
                <Text style={styles.resetCountdown}>
                  ↻ Clears at reset ({formatCountdown(data.metadata.nextResetMs - Date.now())})
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.impactMealAbsorbed}>✅ No meals today</Text>
                <Text style={styles.impactNote}>(PAST→PRESENT)</Text>
              </>
            )}
              </View>

              {/* ── Per-meal breakdown (collapsible) ── */}
              {data.mealsInWindow.length > 0 && (
                <>
                  <TouchableOpacity
                    style={styles.subCollapseToggle}
                    onPress={() => setMobMealsExpanded(prev => !prev)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.subCollapseLabel}>
                      {data.mealsInWindow.length} meal{data.mealsInWindow.length !== 1 ? 's' : ''} this window
                    </Text>
                    <Text style={styles.subCollapseChevron}>{mobMealsExpanded ? '▲' : '▼'}</Text>
                  </TouchableOpacity>

                  {mobMealsExpanded && (
                    <View style={styles.subItemList}>
                      {data.mealsInWindow.map((meal, idx) => (
                        <View key={meal.id || idx} style={styles.subItemRow}>
                          {/* Status pill */}
                          <View style={[
                            styles.subStatusPill,
                            meal.isFuture   ? styles.subPillFuture
                            : meal.isActive ? styles.subPillMealActive
                            :                 styles.subPillAbsorbed,
                          ]}>
                            <Text style={styles.subStatusPillText}>
                              {meal.isFuture ? 'F' : meal.isActive ? 'A' : '✓'}
                            </Text>
                          </View>

                          <View style={styles.subItemInfo}>
                            <Text style={styles.subItemLabel}>
                              {meal.carbs.toFixed(0)}g · {meal.mealType.replace(/_/g, ' ')}
                            </Text>
                            <Text style={styles.subItemMeta}>
                              {meal.timestamp
                                ? formatLocalTime(parseUTCMs(meal.timestamp)) +
                                  '  ·  ' +
                                  (meal.isFuture
                                    ? 'upcoming'
                                    : formatRelativeTime(Date.now() - parseUTCMs(meal.timestamp)))
                                : '—'}
                              {'  ·  '}{meal.absorptionType.replace(/_/g, ' ')}
                            </Text>
                            {/* BG effect line */}
                            <Text style={styles.subItemBgEffectMeal}>
                              {meal.isFuture ? (
                                `⏳ +${meal.bgPending.toFixed(0)} mg/dL pending`
                              ) : meal.isAbsorbed ? (
                                `✓ +${meal.bgAbsorbed.toFixed(0)} mg/dL raised`
                              ) : (
                                `+${meal.bgAbsorbed.toFixed(0)} raised · +${meal.bgPending.toFixed(0)} pending`
                              )}
                            </Text>
                          </View>

                          <Text style={[
                            styles.subItemStatus,
                            meal.isFuture   ? styles.subStatusFutureText
                            : meal.isActive ? styles.subStatusMealActiveText
                            :                 styles.subStatusAbsorbedText,
                          ]}>
                            {meal.isFuture ? 'upcoming' : meal.isActive ? 'digesting' : 'done'}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}
            </>
          )}
        </View>
      </View>

          {/* ── Activity Effects card ─────────────────────────────────────────────
       *  Placed in a columns row (left half only) so that:
       *    LEFT  = BG-lowering effects (IOB above, Activity here)
       *    RIGHT = BG-raising effects  (MOB above, empty space here)
       ─────────────────────────────────────────────────────────────────────── */}
      {/* Activity card — always rendered; inner content handles the empty state */}
      <View style={styles.columns}>
          {/* LEFT half — Activity (BG-lowering, matching IOB column above) */}
          <View style={[styles.column, styles.columnAOB]}>

          {/* Title row — tappable collapse header */}
          <TouchableOpacity
            onPress={() => setAobCardExpanded(prev => !prev)}
            activeOpacity={0.75}
            style={styles.cardCollapseHeader}
          >
            <View style={styles.aobTitleLeft}>
              <Text style={[styles.colTitle, styles.colTitleAOB]}>🏃 Activity Effects</Text>
              {data.aob.activeSessions > 0 && (
                <Text style={styles.aobActiveChip}>
                  {data.aob.activeSessions} active
                </Text>
              )}
            </View>
            <Text style={styles.cardCollapseChevron}>{aobCardExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {/* Main value + sensitivity badge — always visible (collapsed & expanded)
           *
           * Shows a single combined total: direct AOB (pending BG drop from the
           * exercise model itself) + indirect effects (IOB boost + MOB suppression
           * from post-exercise insulin sensitivity).  A one-line breakdown sub-text
           * ("X.X direct · Y.Y indirect") appears when both components are present
           * so the patient can see the split at a glance without expanding.
           * Full per-component details are in the expanded section below.
           ─────────────────────────────────────────────────────────────────── */}
          {(() => {
            const POST_EXERCISE_SENSITIVITY_MS = 4 * 60 * 60 * 1000;
            const latestSessionEndMs = data.aob.activityContributions.length > 0
              ? Math.max(...data.aob.activityContributions.map(c =>
                  parseUTCMs(c.start_time) + c.duration_minutes * 60 * 1000
                ))
              : Date.now();
            const sensitivityExpiresMs = Math.min(
              latestSessionEndMs + POST_EXERCISE_SENSITIVITY_MS,
              data.metadata.nextResetMs
            );
            const sensitivityEndsAt = formatLocalTime(sensitivityExpiresMs);
            const showSensitivity = data.aob.sensitivityMultiplier > 1.005;

            // ── Indirect + direct components — read from pre-computed indirectEffects ──
            const { iobPending, mobPending } = data.aob.indirectEffects;
            const sm          = data.aob.sensitivityMultiplier;
            const indirectTotal = iobPending + mobPending;

            // ── Direct component ────────────────────────────────────────────
            const directTotal   = data.aob.totalAOB;          // pending future AOB drop
            const combinedTotal = directTotal + indirectTotal;
            const hasAnyEffect  = combinedTotal > 0.5;

            // Breakdown sub-line: only when both parts are non-trivial
            const showBreakdown = directTotal > 0.05 && indirectTotal > 0.5;

            return (
              <View style={styles.aobMainRow}>
                {/* Left — combined effect value */}
                <View style={styles.aobMainLeft}>
                  {hasAnyEffect ? (
                    <>
                      <Text style={[styles.colMainValue, styles.aobLoweringValue]}>
                        −{combinedTotal.toFixed(1)} mg/dL
                      </Text>
                      {showBreakdown ? (
                        <Text style={styles.aobCombinedBreakdown}>
                          {directTotal.toFixed(1)} direct · {indirectTotal.toFixed(1)} indirect
                        </Text>
                      ) : indirectTotal > 0.5 && directTotal <= 0.05 ? (
                        <Text style={styles.aobCombinedBreakdown}>
                          ⚡ sensitivity boost only
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Text style={styles.colNoPending}>No activity effect</Text>
                      <Text style={styles.colNoPendingHint}>based on logged data</Text>
                    </>
                  )}
                </View>

                {/* Sensitivity — compact one-liner, expanded view only */}
                {showSensitivity && aobCardExpanded && (
                  <Text style={styles.aobIndirectCollapsedHint}>
                    ⚡ {((sm - 1) * 100).toFixed(0)}% sensitivity boost · ends {sensitivityEndsAt}
                  </Text>
                )}
              </View>
            );
          })()}

          {aobCardExpanded && <>
          {/* Sub — sessions count (mirrors IOB "X active doses") */}
          <Text style={styles.colSubValue}>
            {data.aob.activityContributions.length} session{data.aob.activityContributions.length !== 1 ? 's' : ''}
            {data.aob.activeSessions > 0 ? ' · Still active' : ''}
          </Text>

          {/* AOB pending block — present→future (mirrors IOB impactBlockPending) */}
          {(() => {
            const directPending = data.aob.totalAOB;
            // ── Read from pre-computed indirectEffects — no arithmetic here ──
            const { iobPending: iobPnd, mobPending: mobPnd } = data.aob.indirectEffects;
            const indirectPending = iobPnd + mobPnd;
            const showBreakdown = data.aob.sensitivityMultiplier > 1.005 && indirectPending >= 0.5;
            const combinedPending = directPending + indirectPending;

            return (
              <View style={[styles.impactBlock, styles.impactBlockPendingAOB]}>
                <Text style={styles.impactActivityPending}>
                  ⏳ {combinedPending > 0.05
                    ? `−${combinedPending.toFixed(1)} mg/dL pending`
                    : '—  AOB cleared'}
                </Text>
                <Text style={styles.impactNote}>
                  {combinedPending > 0.05
                    ? `BG-lowering still to arrive\nPRESENT→FUTURE`
                    : 'Full effect already delivered'}
                </Text>
                {showBreakdown && (
                  <Text style={[styles.aobCombinedBreakdown, { fontStyle: 'italic' }]}>
                    {directPending.toFixed(1)} direct · {indirectPending.toFixed(1)} indirect
                  </Text>
                )}
                {showBreakdown && (
                  <Text style={[styles.aobCombinedBreakdown, { fontStyle: 'italic', color: '#00695c' }]}>
                    💉 −{iobPnd.toFixed(1)} IOB boost · 🍽️ −{mobPnd.toFixed(1)} meal saving
                  </Text>
                )}
              </View>
            );
          })()}

          {/* Delivered block — past→present (mirrors IOB absorbed impactBlock)
           *
           * "Still physiologically active" = session is within its duration window
           * OR the post-exercise W-state decay (AOB) is still draining.
           * activeSessions only counts sessions inside duration_minutes; AOB/sensitivity
           * persist for up to ~4.5 h afterwards, so we must check totalAOB > 0.05 too.
           */}
          {(() => {
            const directDelivered = data.aob.cumulativeActivityEffect; // signed; negative = BG-lowering
            // ── Read from pre-computed indirectEffects — no arithmetic here ──
            const { iobDelivered: iobAbs, mobDelivered: mobAbs } = data.aob.indirectEffects;
            const indirectDelivered = iobAbs + mobAbs;
            const showBreakdown = data.aob.sensitivityMultiplier > 1.005 && indirectDelivered >= 0.5;
            // Indirect also lowers BG, so subtract from the (negative) direct value
            const combinedDelivered = directDelivered - indirectDelivered;
            const isActive = (data.aob.activeSessions > 0 || data.aob.totalAOB > 0.05) && directDelivered !== 0;
            const hasSessions = data.aob.activityContributions.length > 0;

            return (
              <View style={styles.impactBlock}>
                {isActive ? (
                  <>
                    <Text style={styles.impactActivityAbsorbed}>
                      {combinedDelivered < 0
                        ? `✅ ${combinedDelivered.toFixed(1)} mg/dL delivered`
                        : `✅ +${combinedDelivered.toFixed(1)} mg/dL delivered`}
                    </Text>
                    <Text style={styles.impactNote}>
                      {data.aob.activeSessions > 0 ? 'Session in progress' : 'Post-exercise · draining'}{' '}
                      {combinedDelivered < 0 ? '· BG-lowering' : '· BG-raising'}{'\n'}
                      (PAST→PRESENT)
                    </Text>
                    {showBreakdown && (
                      <Text style={[styles.aobCombinedBreakdown, { fontStyle: 'italic', marginTop: 4 }]}>
                        {Math.abs(directDelivered).toFixed(1)} direct · {indirectDelivered.toFixed(1)} indirect
                      </Text>
                    )}
                  </>
                ) : hasSessions ? (
                  <>
                    <Text style={styles.impactActivityAbsorbed}>✅ Effect fully delivered</Text>
                    <Text style={styles.impactNote}>
                      {data.aob.activityContributions.length} session{data.aob.activityContributions.length !== 1 ? 's' : ''} fully absorbed today · ↓ BG
                    </Text>
                    <Text style={styles.resetCountdown}>
                      ↻ Clears at reset ({formatCountdown(data.metadata.nextResetMs - Date.now())})
                    </Text>
                    {showBreakdown && (
                      <Text style={[styles.aobCombinedBreakdown, { fontStyle: 'italic', marginTop: 4 }]}>
                        {Math.abs(directDelivered).toFixed(1)} direct · {indirectDelivered.toFixed(1)} indirect
                      </Text>
                    )}
                  </>
                ) : (
                  <>
                    <Text style={styles.impactActivityAbsorbed}>✅ No activity today</Text>
                    <Text style={styles.impactNote}>(PAST→PRESENT)</Text>
                  </>
                )}
              </View>
            );
          })()}

          {/* ── Indirect activity effects on IOB & MOB ────────────────────────
           *
           * Post-exercise GLUT4 upregulation has two distinct secondary impacts
           * that are easy to miss if you only read the sensitivity badge:
           *
           *  1. IOB boost — each active insulin unit corrects MORE mg/dL because
           *     effective ISF = rawISF × sensitivityMultiplier. The extra drop =
           *     totalActiveInsulin × (effectiveISF − rawISF).
           *
           *  2. MOB suppression — active carbs will spike BG LESS because the
           *     effective CR is lower (cells take up glucose faster). Approximate
           *     savings = pendingBGRise × (1 − 1/sensitivityMultiplier).
           *     (Exact value would require re-running the full MOB absorption
           *     model with effectiveCarbToBgRatio; this linear approximation is
           *     within ~5% for multipliers up to 1.6.)
           *
           * Only rendered when sensitivityMultiplier > 1.005 AND at least one
           * of the two effects is non-trivial (> 0.5 mg/dL).
           ─────────────────────────────────────────────────────────────────── */}
          {data.aob.sensitivityMultiplier > 1.005 && (() => {
            const sm    = data.aob.sensitivityMultiplier;
            const rawISF = data.aob.effectiveCorrectionFactor / sm;
            const rawCR  = data.aob.effectiveCarbToBgRatio    * sm;

            // ── Read from pre-computed indirectEffects — no arithmetic here ──
            const { iobPending, mobPending, iobDelivered: iobAbsorbed, mobDelivered: mobAbsorbed } =
              data.aob.indirectEffects;

            const hasIOB = iobPending > 0.5;
            const hasMOB = mobPending > 0.5;
            const hasAnyIndirect = hasIOB || hasMOB || data.mob.pendingBGRise > 0.5;
            if (!hasAnyIndirect) return null;

            const pct = ((sm - 1) * 100).toFixed(0);

            return (
              <View style={styles.aobIndirectBlock}>
                {/* Collapsible header toggle */}
                <TouchableOpacity
                  onPress={() => setIndirectExpanded(prev => !prev)}
                  activeOpacity={0.75}
                  style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <Text style={[styles.aobIndirectTitle, { marginBottom: 0 }]}>
                    ⚡ Indirect effects on active entries
                  </Text>
                  <Text style={[styles.subCollapseChevron, { color: '#00695c' }]}>
                    {indirectExpanded ? '▲' : '▼'}
                  </Text>
                </TouchableOpacity>

                {indirectExpanded && (
                  <>
                    <Text style={[styles.aobIndirectHint, { marginTop: 6 }]}>
                      {pct}% post-exercise insulin sensitivity boost is affecting your logged insulin and meals
                    </Text>

                    {/* ── IOB indirect section ─────────────────────────────────── */}
                    {hasIOB && (
                      <View style={styles.aobIndirectSection}>
                        {/* Header row — label + ISF info */}
                        <View style={styles.aobIndirectRow}>
                          <Text style={styles.aobIndirectIcon}>💉</Text>
                          <View style={styles.aobIndirectInfo}>
                            <Text style={styles.aobIndirectLabel}>
                              IOB more effective
                            </Text>
                            <Text style={styles.aobIndirectMeta}>
                              ISF {rawISF.toFixed(0)} → {data.aob.effectiveCorrectionFactor.toFixed(0)} mg/dL/u
                              {'  ·  '}{data.iob.totalActiveInsulin.toFixed(1)}u active insulin
                            </Text>
                          </View>
                        </View>

                        {/* Pending sub-block (PRESENT→FUTURE) */}
                        <View style={styles.aobIndirectSubPending}>
                          <Text style={styles.aobIndirectSubPendingText}>
                            ⏳ −{iobPending.toFixed(1)} mg/dL pending
                          </Text>
                          <Text style={styles.aobIndirectSubNote}>
                            Extra IOB drop still to arrive{'\n'}PRESENT→FUTURE
                          </Text>
                        </View>

                        {/* Absorbed sub-block (PAST→PRESENT) — only when non-trivial */}
                        {iobAbsorbed > 0.5 && (
                          <View style={styles.aobIndirectSubAbsorbed}>
                            <Text style={styles.aobIndirectSubAbsorbedText}>
                              ✅ −{iobAbsorbed.toFixed(1)} mg/dL delivered
                            </Text>
                            <Text style={styles.aobIndirectSubNote}>
                              Extra drop already delivered by boosted ISF{'\n'}(PAST→PRESENT)
                            </Text>
                          </View>
                        )}
                      </View>
                    )}

                    {/* ── MOB indirect section ─────────────────────────────────── */}
                    {hasMOB && (
                      <View style={[styles.aobIndirectSection, {
                        borderTopWidth: hasIOB ? 1 : 0,
                        borderTopColor: '#b2dfdb',
                        marginTop: hasIOB ? 8 : 0,
                        paddingTop: hasIOB ? 8 : 0,
                      }]}>
                        {/* Header row — label + CR info */}
                        <View style={styles.aobIndirectRow}>
                          <Text style={styles.aobIndirectIcon}>🍽️</Text>
                          <View style={styles.aobIndirectInfo}>
                            <Text style={styles.aobIndirectLabel}>
                              Meal rise moderated
                            </Text>
                            <Text style={styles.aobIndirectMeta}>
                              CR {rawCR.toFixed(1)} → {data.aob.effectiveCarbToBgRatio.toFixed(1)} mg/dL per g
                              {'  ·  '}{data.mob.totalActiveCarbs.toFixed(0)}g carbs pending
                            </Text>
                            <Text style={styles.aobIndirectMeta}>
                              Cells absorb glucose faster post-exercise (GLUT4↑)
                            </Text>
                          </View>
                        </View>

                        {/* Pending sub-block (PRESENT→FUTURE) */}
                        <View style={styles.aobIndirectSubPending}>
                          <Text style={styles.aobIndirectSubPendingText}>
                            ⏳ −{mobPending.toFixed(1)} mg/dL saving
                          </Text>
                          <Text style={styles.aobIndirectSubNote}>
                            Reduced spike still ahead from pending carbs{'\n'}PRESENT→FUTURE
                          </Text>
                        </View>

                        {/* Absorbed sub-block (PAST→PRESENT) — only when non-trivial */}
                        {mobAbsorbed > 0.5 && (
                          <View style={styles.aobIndirectSubAbsorbed}>
                            <Text style={styles.aobIndirectSubAbsorbedText}>
                              ✅ −{mobAbsorbed.toFixed(1)} mg/dL moderated
                            </Text>
                            <Text style={styles.aobIndirectSubNote}>
                              Spike already suppressed for absorbed carbs{'\n'}(PAST→PRESENT)
                            </Text>
                          </View>
                        )}
                      </View>
                    )}
                  </>
                )}
              </View>
            );
          })()}

          {/* ── Per-session breakdown (collapsible) ─────────────────────────── */}
          {data.aob.activityContributions.length > 0 && (
            <>
              <TouchableOpacity
                style={styles.aobCollapseToggle}
                onPress={() => setAobExpanded(prev => !prev)}
                activeOpacity={0.7}
              >
                <Text style={styles.aobCollapseLabel}>
                  {data.aob.activityContributions.length} session{data.aob.activityContributions.length !== 1 ? 's' : ''} this window
                </Text>
                <Text style={styles.aobCollapseChevron}>{aobExpanded ? '▲' : '▼'}</Text>
              </TouchableOpacity>

              {aobExpanded && (
                <View style={styles.subItemList}>
                  {data.aob.activityContributions.map((contrib, idx) => {
                    const startMs  = parseUTCMs(contrib.start_time);
                    const isActive = contrib.is_active;
                    const isFuture = !isNaN(startMs) && startMs > Date.now();
                    const isDone   = !isActive && !isFuture;

                    // Estimate pending BG effect from absorbed fraction
                    const delivered = contrib.cumulative_bg_effect;
                    const pendingBg =
                      contrib.absorbed_fraction > 0 && contrib.absorbed_fraction < 1
                        ? delivered * (1 - contrib.absorbed_fraction) / contrib.absorbed_fraction
                        : 0;
                    const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
                    const modelLabel = contrib.model === 'hr_ode' ? 'HR trace' : 'synthetic HR';

                    return (
                      <View key={contrib.activity_id ?? idx} style={styles.subItemRow}>
                        {/* Intensity pill — sized like IOB/MOB pills, coloured by intensity */}
                        <View style={[
                          styles.subStatusPill,
                          contrib.intensity === 'vigorous' ? styles.aobPillVigorous
                            : contrib.intensity === 'moderate' ? styles.aobPillModerate
                            : styles.aobPillLight,
                        ]}>
                          <Text style={styles.subStatusPillText}>
                            {contrib.intensity === 'vigorous' ? 'V'
                              : contrib.intensity === 'moderate' ? 'M'
                              : 'L'}
                          </Text>
                        </View>

                        <View style={styles.subItemInfo}>
                          <Text style={styles.subItemLabel}>
                            {contrib.intensity} · {contrib.duration_minutes} min
                          </Text>
                          <Text style={styles.subItemMeta}>
                            {!isNaN(startMs)
                              ? formatLocalTime(startMs) +
                                '  ·  ' +
                                (isFuture
                                  ? 'upcoming'
                                  : formatRelativeTime(Date.now() - startMs))
                              : '—'}
                            {'  ·  '}{modelLabel}
                          </Text>
                          {/* BG effect line — mirrors subItemBgEffect / subItemBgEffectMeal */}
                          <Text style={styles.subItemBgEffectAOB}>
                            {isFuture
                              ? `⏳ ${fmt(pendingBg)} mg/dL pending`
                              : isDone
                                ? `✓ ${fmt(delivered)} mg/dL delivered`
                                : `${fmt(delivered)} done · ${fmt(pendingBg)} pending`}
                          </Text>
                        </View>

                        <Text style={[
                          styles.subItemStatus,
                          isFuture  ? styles.subStatusFutureText
                          : isActive ? styles.subStatusAOBActiveText
                          :            styles.subStatusAbsorbedText,
                        ]}>
                          {isFuture ? 'upcoming' : isActive ? 'active' : 'done'}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          )}
          </>}
          </View>
          {/* RIGHT half — empty spacer, keeping semantic alignment with MOB column above */}
          <View style={{ flex: 1 }} />
        </View>


      {/* ── Status assessment ─────────────────────────────────────────── */}
      {(() => {
        const assessment            = getProjectedAssessment(data.iob, data.mob, data.netEffect);
        const pendingMealRise       = data.mob.pendingBGRise;
        const pendingInsulinRedux   = data.iob.pendingBGReduction;
        const netPending            = data.netEffect.pendingNetEffect;
        const bothActive            = data.iob.totalActiveInsulin > 0.5 && data.mob.totalActiveCarbs > 5;

        const baselineBG            = data.baseline?.value ?? null;
        const nowBG                 = data.netEffect.estimatedBG;
        const projBG                = data.netEffect.projectedFinalBG;

        const isRising              = netPending > 5;
        const isFalling             = netPending < -5;
        const trendColor            = isRising ? '#FF9800' : isFalling ? '#9C27B0' : '#4CAF50';
        const trendArrow            = isRising ? '↗' : isFalling ? '↘' : '→';
        const deltaSign             = netPending >= 0 ? '+' : '';

        // Delta shown on the arrow between RIGHT NOW and PROJECTED must reflect the
        // actual visual gap between the two displayed numbers — not netPending.
        // projectedFinalBG omits the activity term that estimatedBG carries, so
        // these can diverge (e.g. screen shows +10 while netPending = -5).
        const nowToProjDelta = projBG - nowBG;
        const nowToProjArrow = nowToProjDelta > 5 ? '↗' : nowToProjDelta < -5 ? '↘' : '→';
        const nowToProjColor = nowToProjDelta > 5 ? '#FF9800' : nowToProjDelta < -5 ? '#9C27B0' : '#4CAF50';
        const nowToProjSign  = nowToProjDelta >= 0 ? '+' : '';

        const totalForce            = pendingMealRise + pendingInsulinRedux;
        const mealPct               = totalForce > 0 ? (pendingMealRise / totalForce) * 100 : 50;
        const insulinPct            = 100 - mealPct;

        const baselineToNowDelta    = baselineBG != null ? nowBG - baselineBG : null;

        return (
          <View style={[styles.assessmentCard, styles[assessment.bgStyle as keyof typeof styles]]}>

            {/* ── Title + chips ─────────────────────────────────────────── */}
            <View style={styles.assHeaderRow}>
              <Text style={[styles.assessmentTitle, { color: assessment.titleColor }]}>
                {assessment.icon}{'  '}{assessment.title}
              </Text>
              <View style={styles.assChipsInline}>
                {data.iob.totalActiveInsulin > 0 && (
                  <View style={styles.chipIOB}>
                    <Text style={styles.chipIOBText}>💉 {data.iob.totalActiveInsulin.toFixed(1)}u</Text>
                  </View>
                )}
                {data.mob.totalActiveCarbs > 0 && (
                  <View style={styles.chipMOB}>
                    <Text style={styles.chipMOBText}>🍽️ {data.mob.totalActiveCarbs.toFixed(0)}g</Text>
                  </View>
                )}
                {data.aob.activeSessions > 0 && (
                  <View style={styles.chipAOB}>
                    <Text style={styles.chipAOBText}>
                      🏃 {data.aob.activeSessions}
                      {data.aob.sensitivityMultiplier > 1.005
                        ? ` ×${data.aob.sensitivityMultiplier.toFixed(2)}`
                        : ''}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* ── Plain-English recommendation ──────────────────────────── */}
            <Text style={styles.assessmentBody}>{assessment.recommendation}</Text>

            {/* ── Tug-of-war ─────────────────────────────────────────────── */}
            {bothActive && totalForce > 0 && (
              <View style={styles.tugSection}>
                <View style={styles.tugLabelRow}>
                  <Text style={styles.tugLabelMeal}>🍽️ Carbs pushing up</Text>
                  <Text style={styles.tugLabelInsulin}>Insulin pulling down 💉</Text>
                </View>
                <View style={styles.tugBarTrack}>
                  <View style={[styles.tugBarMeal,    { flex: mealPct }]} />
                  <View style={[styles.tugBarInsulin, { flex: insulinPct }]} />
                </View>
                <View style={styles.tugValueRow}>
                  <Text style={styles.tugValueMeal}>+{pendingMealRise.toFixed(0)}</Text>
                  <Text style={[styles.tugNetBadge, {
                    backgroundColor: trendColor + '22', color: trendColor,
                  }]}>
                    net {deltaSign}{Math.abs(netPending).toFixed(0)}
                  </Text>
                  <Text style={styles.tugValueInsulin}>−{pendingInsulinRedux.toFixed(0)}</Text>
                </View>
                <Text style={styles.tugCaption}>
                  {isRising
                    ? 'Food is raising BG faster than insulin is lowering it'
                    : isFalling
                    ? 'Insulin is lowering BG faster than food is raising it'
                    : 'Food and insulin are roughly cancelling each other out'}
                </Text>
              </View>
            )}
          </View>
        );
      })()}

      {/* ── Net Effect Analysis (collapsible) ────────────────────────── */}
      <TouchableOpacity
        style={styles.netCard}
        onPress={() => setNetExpanded(prev => !prev)}
        activeOpacity={0.85}
      >
        <View style={styles.netCardHeader}>
          <Text style={styles.netCardTitle}>⚖️ T1D Net Effect Analysis</Text>
          <Text style={styles.netCardChevron}>{netExpanded ? '▲' : '▼'}</Text>
        </View>

        {!netExpanded && (
          <Text style={styles.netCardCollapsedHint}>Tap to expand breakdown</Text>
        )}

        {netExpanded && (
          <>
            {/* Daily cumulative — feeds into estimatedBG */}
            <View style={styles.cumulBlock}>
              <View style={styles.cumulBlockHeader}>
                <Text style={styles.cumulBlockTitle}>📊 Today's Cumulative BG Effect till now</Text>
                <Text style={[
                  styles.cumulBlockValue,
                  (data.netEffect.cumulativeBaseline + data.netEffect.cumulativeActivityEffect) >= 0
                    ? styles.positive : styles.negative,
                ]}>
                  {(data.netEffect.cumulativeBaseline + data.netEffect.cumulativeActivityEffect) >= 0 ? '+' : ''}
                  {(data.netEffect.cumulativeBaseline + data.netEffect.cumulativeActivityEffect).toFixed(0)} mg/dL
                </Text>
              </View>
              <Text style={styles.cumulBlockSub}>
                All meals, insulin & activity since daily reset (incl. fully absorbed)
              </Text>
            </View>

            {/* Formula breakdown: baseline + ΔMeal + ΔInsulin + ΔActivity */}
            <EffectRow
              label="🍽️ Daily meal effect"
              sublabel={`${data.metadata.absorbedOnlyMeals + data.mob.activeMealCount + data.metadata.futureMealsCount} meal(s) since reset`}
              value={`+${data.netEffect.cumulativeMealEffect.toFixed(1)} mg/dL`}
              valueStyle="positive"
            />
            <EffectRow
              label="💉 Daily insulin effect"
              sublabel={`${data.metadata.absorbedOnlyDoses + data.iob.activeDoses} dose(s) since reset`}
              value={`${data.netEffect.cumulativeInsulinEffect.toFixed(1)} mg/dL`}
              valueStyle="negative"
            />
            {/* Activity row — always rendered in the expanded section so users can
                confirm zero effect days explicitly */}
            <EffectRow
              label="🏃 Daily activity effect"
              sublabel={
                data.aob.activeSessions > 0
                  ? `${data.aob.activeSessions} session(s) · ${data.aob.totalAOB.toFixed(1)} mg/dL AOB remaining`
                  : 'No exercise sessions today'
              }
              value={`${data.netEffect.cumulativeActivityEffect >= 0 ? '+' : ''}${data.netEffect.cumulativeActivityEffect.toFixed(1)} mg/dL`}
              valueStyle={data.netEffect.cumulativeActivityEffect < 0 ? 'negative' : 'positive'}
            />
            {/* Sensitivity note — only shown when ISF is boosted above noise floor */}
            {data.netEffect.sensitivityMultiplier > 1.005 && (
              <View style={styles.aobNetSensRow}>
                <Text style={styles.aobNetSensText}>
                  ⚡ Post-exercise sensitivity ×{data.netEffect.sensitivityMultiplier.toFixed(2)} applied to pending IOB/MOB projection
                </Text>
              </View>
            )}

            <View style={styles.netDivider} />

            {/* Active-only: what's still happening RIGHT NOW */}
            <View style={styles.cumulBlock}>
              <View style={styles.cumulBlockHeader}>
                <Text style={styles.cumulBlockTitle}>⚡ Currently Active</Text>
                <Text style={styles.cumulBlockValue}>
                  {data.iob.activeDoses} dose{data.iob.activeDoses !== 1 ? 's' : ''} · {data.mob.activeMealCount} meal{data.mob.activeMealCount !== 1 ? 's' : ''}
                  {data.aob.activeSessions > 0 ? ` · ${data.aob.activeSessions} session${data.aob.activeSessions !== 1 ? 's' : ''}` : ''}
                </Text>
              </View>
              <Text style={styles.cumulBlockSub}>
                Still absorbing / active right now
              </Text>
            </View>
            <EffectRow
              label="✅ Active meal absorbed so far"
              sublabel="PAST→PRESENT: Absorbed carbs in bloodstream"
              value={`+${data.mob.currentBGElevation.toFixed(1)} mg/dL`}
              valueStyle="positive"
            />
            <EffectRow
              label="⏳ Active meal pending"
              sublabel={`PRESENT→FUTURE: MOB (${data.mob.totalActiveCarbs.toFixed(1)}g still digesting)`}
              value={`+${data.mob.pendingBGRise.toFixed(1)} mg/dL`}
              valueStyle="warning"
            />
            <EffectRow
              label="✅ Active insulin absorbed so far"
              sublabel="PAST→PRESENT: From currently-absorbing dose(s)"
              value={`-${data.iob.currentBGReduction.toFixed(1)} mg/dL`}
              valueStyle="negative"
            />
            <EffectRow
              label="⏳ Active insulin pending (IOB)"
              sublabel={`From IOB (${data.iob.totalActiveInsulin.toFixed(2)}u still active)`}
              value={`-${data.iob.pendingBGReduction.toFixed(1)} mg/dL`}
              valueStyle="negative"
            />

            {/* Projected final */}
            <View style={styles.projectedRow}>
              <View>
                <Text style={styles.projectedLabel}>Projected Final BG</Text>
                <Text style={styles.projectedSub}>After IOB acts completely</Text>
              </View>
              <Text style={[styles.projectedValue, styles[getHighlight(data.netEffect.projectedFinalBG)]]}>
                {data.netEffect.projectedFinalBG.toFixed(0)} mg/dL
              </Text>
            </View>
          </>
        )}
      </TouchableOpacity>

      {/* Footer metadata */}
      <View style={styles.meta}>
        <Text style={styles.metaText}>📊 {data.metadata.mealsCount} meals</Text>
        <Text style={styles.metaText}>💉 {data.metadata.dosesCount} doses</Text>
        <Text style={styles.metaText}>
          📱 {data.metadata.hasRecentReading ? 'Reading ✓' : 'No reading today'}
        </Text>
        {data.aob.activeSessions > 0 && (
          <Text style={styles.metaText}>🏃 {data.aob.activeSessions} session{data.aob.activeSessions !== 1 ? 's' : ''}</Text>
        )}
      </View>

      <TouchableOpacity style={styles.refreshButton} onPress={() => fetchAndCalculate('button-tap')}>
        <Text style={styles.refreshButtonText}>🔄 Refresh</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function EffectRow({
  label, sublabel, value, valueStyle,
}: {
  label: string;
  sublabel: string;
  value: string;
  valueStyle: 'positive' | 'negative' | 'warning';
}) {
  return (
    <View style={styles.effectRow}>
      <View style={styles.effectLeft}>
        <Text style={styles.effectLabel}>{label}</Text>
        <Text style={styles.effectSublabel}>{sublabel}</Text>
      </View>
      <Text style={[styles.effectValue, styles[valueStyle]]}>{value}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getHighlight(bg: number): 'positive' | 'negative' | 'warning' | 'good' {
  if (bg < 70) return 'negative';
  if (bg > 180) return 'warning';
  if (bg >= 70 && bg <= 140) return 'good';
  return 'positive';
}

function bgToSafetyStatus(bg: number): string {
  if (bg < 54)  return 'critical_low';
  if (bg < 70)  return 'hypoglycemia_risk';
  if (bg > 250) return 'critical_high';
  if (bg > 180) return 'hyperglycemia_risk';
  return 'optimal';
}

function getSafetyHighlight(s: string): 'positive' | 'negative' | 'warning' | 'good' {
  if (s === 'critical_low' || s === 'critical_high') return 'negative';
  if (s === 'hypoglycemia_risk' || s === 'hyperglycemia_risk') return 'warning';
  if (s === 'optimal') return 'good';
  return 'positive';
}

function getRecommendation(status: string): string {
  switch (status) {
    case 'optimal':             return 'Blood sugar is in a good range.';
    case 'hypoglycemia_risk':   return 'Risk of low blood sugar. Monitor closely.';
    case 'hyperglycemia_risk':  return 'Risk of high blood sugar. Consider correction.';
    case 'critical_low':        return 'Critically low blood sugar. Take action immediately.';
    case 'critical_high':       return 'Critically high blood sugar. Take action immediately.';
    default:                    return 'Insulin and carbs are both active. Monitor closely.';
  }
}

const NET_PENDING_THRESHOLD = 20;

function getProjectedAssessment(
  iob: ActiveEffectData['iob'],
  mob: ActiveEffectData['mob'],
  netEffect: ActiveEffectData['netEffect'],
): {
  icon: string;
  title: string;
  titleColor: string;
  recommendation: string;
  projectedOutcome: string;
  bgStyle: string;
} {
  const pendingMealRise         = mob.pendingBGRise;
  const pendingInsulinReduction = iob.pendingBGReduction;
  const netPending              = pendingMealRise - pendingInsulinReduction;

  const hasMeaningfulIOB = iob.totalActiveInsulin > 0.5;
  const hasMeaningfulMOB = mob.totalActiveCarbs    > 5;
  const bothActive       = hasMeaningfulIOB && hasMeaningfulMOB;

  if (netEffect.safetyStatus === 'critical_low') {
    return { icon: '🚨', title: 'CRITICAL LOW', titleColor: '#F44336',
             recommendation: 'Critically low blood sugar — take action immediately.',
             projectedOutcome: 'critical_low', bgStyle: 'assessment_negative' };
  }
  if (netEffect.safetyStatus === 'critical_high') {
    return { icon: '🚨', title: 'CRITICAL HIGH', titleColor: '#F44336',
             recommendation: 'Critically high blood sugar — take action immediately.',
             projectedOutcome: 'critical_high', bgStyle: 'assessment_negative' };
  }

  if (bothActive) {
    if (netPending < -NET_PENDING_THRESHOLD) {
      return {
        icon: '⬇️', title: 'BOTH ACTIVE — FALLING RISK', titleColor: '#9C27B0',
        recommendation:
          'Insulin is outpacing meal absorption — BG is likely to fall. ' +
          'Consider a small snack if not eating again soon.',
        projectedOutcome: 'hypo_risk', bgStyle: 'assessment_good',
      };
    }
    if (netPending > NET_PENDING_THRESHOLD) {
      return {
        icon: '⬆️', title: 'BOTH ACTIVE — RISING RISK', titleColor: '#FF9800',
        recommendation:
          'Meal carbs are outpacing active insulin — BG is likely to rise. ' +
          'Monitor closely and consider a correction dose if needed.',
        projectedOutcome: 'hyper_risk', bgStyle: 'assessment_warning',
      };
    }
    return {
      icon: '⚖️', title: 'BOTH ACTIVE — BALANCED', titleColor: '#2196F3',
      recommendation:
        'Insulin and carbs are closely matched. Monitor BG closely over the next hour.',
      projectedOutcome: 'balanced', bgStyle: 'assessment_good',
    };
  }

  if (hasMeaningfulIOB) {
    return {
      icon: pendingInsulinReduction > NET_PENDING_THRESHOLD ? '⬇️' : '💉',
      title: 'HIGH IOB',
      titleColor: '#9C27B0',
      recommendation: pendingInsulinReduction > NET_PENDING_THRESHOLD
        ? 'Active insulin may lower your BG significantly. Consider a snack if not eating soon.'
        : 'Insulin is active. Monitor BG before your next meal.',
      projectedOutcome: 'iob_only', bgStyle: 'assessment_good',
    };
  }

  if (hasMeaningfulMOB) {
    return {
      icon: pendingMealRise > NET_PENDING_THRESHOLD ? '⬆️' : '🍽️',
      title: 'HIGH MOB',
      titleColor: '#FF9800',
      recommendation:
        'Carbs still absorbing — account for them before dosing again.',
      projectedOutcome: 'mob_only', bgStyle: 'assessment_warning',
    };
  }

  return {
    icon: netEffect.safetyStatus.includes('risk') ? '⚠️' : '✅',
    title: netEffect.safetyStatus.replace(/_/g, ' ').toUpperCase(),
    titleColor: netEffect.safetyStatus.includes('risk') ? '#FF9800'
               : netEffect.safetyStatus === 'optimal' ? '#4CAF50' : '#666',
    recommendation: getRecommendation(netEffect.safetyStatus),
    projectedOutcome: 'stable',
    bgStyle: `assessment_${getSafetyHighlight(netEffect.safetyStatus)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f2f5' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#e8e8e8',
    alignItems: 'center',
  },
  title:     { fontSize: 20, fontWeight: '800', color: '#1a1a1a' },
  subtitle:  { fontSize: 13, color: '#888', marginTop: 2 },
  timestamp: { fontSize: 11, color: '#aaa', marginTop: 6 },

  // ── BG triple card ─────────────────────────────────────────────────────────
  bgTriRow: {
    flexDirection: 'row', alignItems: 'stretch',
    marginHorizontal: 12, marginTop: 12,
    backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 3,
  },
  bgTriCard: {
    flex: 3, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center',
  },
  bgTriCardLeft:  { borderRightWidth: 1, borderRightColor: '#f0f0f0' },
  bgTriCardMid:   { borderRightWidth: 1, borderRightColor: '#f0f0f0' },
  bgTriCardRight: {},
  cardCollapseHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  cardCollapseHeaderLeft: { flex: 1 },
  cardCollapseChevron: {
    fontSize: 11,
    color: '#bbb',
    marginTop: 2,
    marginLeft: 4,
  },

  bgArrowCol: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14,
  },
  bgArrow:      { fontSize: 16, color: '#bbb' },
  bgArrowLabel: { fontSize: 9, color: '#ccc', marginTop: 2, textAlign: 'center' },
  bgCardEyebrow: { fontSize: 9, fontWeight: '700', color: '#aaa', letterSpacing: 0.8, marginBottom: 4 },
  bgTriValue:   { fontSize: 26, fontWeight: '900' },
  bgCardUnit:   { fontSize: 10, color: '#999', marginTop: 1 },
  bgReadingAge: { fontSize: 10, color: '#aaa', marginTop: 3, textAlign: 'center' },
  bgEstStatus:  { fontSize: 10, fontWeight: '600', marginTop: 3, textAlign: 'center' },
  bgAnchorMeta: { fontSize: 10, color: '#aaa', marginTop: 4, textAlign: 'center' },
  bgAnchorBaseline: { fontSize: 10, color: '#bbb', marginTop: 2, textAlign: 'center' },
  bgFormulaStrip: {
    flexDirection: 'row', alignItems: 'center',
    flexWrap: 'wrap', justifyContent: 'center', marginTop: 6,
  },
  bgFormulaText:   { fontSize: 11, fontWeight: '700', color: '#444' },
  bgFormulaMuted:  { fontSize: 10, color: '#bbb' },
  bgFormulaResult: { fontSize: 12, fontWeight: '800', color: '#333' },
  bgFormulaLabel:  { fontSize: 9, color: '#ccc', marginTop: 2, textAlign: 'center' },

  // ── Two-column IOB / MOB ───────────────────────────────────────────────────
  columns: {
    flexDirection: 'row', marginHorizontal: 12, marginTop: 12, gap: 12,
  },
  column: {
    flex: 1, backgroundColor: '#fff', borderRadius: 14, padding: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 6, elevation: 2,
  },
  columnLeft:  {},
  columnRight: {},
  // ── Per-card top-accent borders ──────────────────────────────────────────────
  columnIOB: { borderTopWidth: 3, borderTopColor: '#9C27B0' },
  columnMOB: { borderTopWidth: 3, borderTopColor: '#FF9800' },
  columnAOB: { borderTopWidth: 3, borderTopColor: '#00BFA5' },
  // ── Themed colTitle overrides (matching EffectsVisualizationChart series) ─────
  colTitleIOB: { color: '#7b1fa2' },   // insulin purple
  colTitleMOB: { color: '#e65100' },   // meal orange
  colTitleAOB: { color: '#00897b' },   // activity teal (#00BFA5 series)
  colTitle:     { fontSize: 12, fontWeight: '700', color: '#333', marginBottom: 6 },
  colMainValue: { fontSize: 22, fontWeight: '900', color: '#1a1a1a' },
  colNoPending: {
    fontSize: 15, fontWeight: '600', color: '#bbb',
    lineHeight: 20, marginBottom: 2,
  },
  colNoPendingHint: {
    fontSize: 10, fontWeight: '500', color: '#ccc',
    fontStyle: 'italic', marginBottom: 2,
  },
  colSubValue:  { fontSize: 11, color: '#888', marginTop: 2, marginBottom: 8 },

  impactBlock: {
    backgroundColor: '#f8f9fa', borderRadius: 8, padding: 8, marginTop: 6,
  },
  impactBlockPending:     { backgroundColor: '#fce4ec' },
  impactBlockPendingMeal: { backgroundColor: '#fff8e1' },
  impactBlockPendingAOB:  { backgroundColor: '#e0f2f1' },  // teal tint — activity series
  impactAbsorbed:     { fontSize: 12, fontWeight: '700', color: '#9C27B0' },
  impactMealAbsorbed: { fontSize: 12, fontWeight: '700', color: '#FF9800' },
  impactPending:      { fontSize: 12, fontWeight: '700', color: '#F44336' },
  impactMealPending:  { fontSize: 12, fontWeight: '700', color: '#FF9800' },
  impactNote:         { fontSize: 10, color: '#888', marginTop: 2 },
  resetCountdown:     { fontSize: 10, color: '#2196f3', marginTop: 3, fontStyle: 'italic' },

  // ── Activity Effects card ──────────────────────────────────────────────────
  aobCard: {
    marginHorizontal: 12, marginTop: 12,
    backgroundColor: '#fff', borderRadius: 14, padding: 14,
    borderLeftWidth: 4, borderLeftColor: '#00BFA5',  // teal — matches activity series in chart
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07, shadowRadius: 6, elevation: 2,
  },

  // ── 1b. Aggregate sensitivity badge (spec H-1 fix) ─────────────────────────
  sensitivityBadge: {
    backgroundColor: '#fff8e1', borderRadius: 10,
    borderWidth: 1, borderColor: '#FFB300',
    padding: 10, marginBottom: 10,
  },
  sensitivityLabel: { fontSize: 12, fontWeight: '800', color: '#E65100' },
  sensitivityValue: { fontSize: 15, fontWeight: '900', color: '#BF360C', marginTop: 2 },
  sensitivityNote:  { fontSize: 11, color: '#8D6E63', marginTop: 3, fontStyle: 'italic' },

  aobTitleRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    justifyContent: 'space-between', marginBottom: 10,
    gap: 8,
  },
  aobTitleLeft: {
    flexDirection: 'column', gap: 3,
  },
  aobMainRow: {
    flexDirection: 'column', alignItems: 'flex-start',
    gap: 4, marginBottom: 2,
  },
  aobMainLeft: {
    width: '100%',
  },
  aobInlineSensitivity: {
    alignSelf: 'stretch',
    backgroundColor: '#fffde7',
    borderRadius: 8, borderWidth: 1, borderColor: '#ffe082',
    paddingHorizontal: 8, paddingVertical: 6,
    alignItems: 'flex-start', justifyContent: 'center',
  },
  aobInlineSensitivityTitle: {
    fontSize: 10, fontWeight: '700', color: '#e65100',
    textAlign: 'left', lineHeight: 14,
  },
  aobInlineSensitivitySub: {
    fontSize: 9, color: '#795548',
    textAlign: 'left', marginTop: 2, lineHeight: 13,
  },
  aobTitle:      { fontSize: 13, fontWeight: '800', color: '#333' },
  aobActiveChip: {
    fontSize: 11, fontWeight: '700', color: '#00897b',
    backgroundColor: '#e0f2f1', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 2,
    alignSelf: 'flex-start',
  },

  // ── 1a. Primary effect row ─────────────────────────────────────────────────
  aobEffectRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: '#f5f5f5',
  },
  aobEffectLeft:  { flex: 1, paddingRight: 8 },
  aobEffectLabel: { fontSize: 13, fontWeight: '700', color: '#333' },
  aobEffectSublabel: { fontSize: 10, color: '#888', marginTop: 2 },
  aobEffectValueCol: { alignItems: 'flex-end' },
  aobEffectArrow: { fontSize: 16, fontWeight: '900' },
  aobEffectValue: { fontSize: 18, fontWeight: '900' },
  aobEffectSubtext: { fontSize: 10, color: '#aaa', marginTop: 1 },

  /** Red/orange tint for BG-lowering effect (negative cumulative_activity_effect) */
  aobLoweringValue: { color: '#E53935' },
  /** Accent for neutral / BG-raising effect */
  aobRaisingValue:  { color: '#4CAF50' },
  /** Alias kept for formula strip */
  aobDropValue:     { color: '#E53935' },
  aobValue:         { color: '#E53935' },

  aobSensitivityRow: {
    marginTop: 10, backgroundColor: '#fff8e1',
    borderRadius: 8, padding: 8,
  },
  aobSensitivityText: { fontSize: 11, color: '#E65100', fontWeight: '600' },

  // ── 1c. Collapsible per-session breakdown ──────────────────────────────────
  aobCollapseToggle: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, marginTop: 6,
    borderTopWidth: 1, borderTopColor: '#f0f0f0',
  },
  aobCollapseLabel:   { fontSize: 11, color: '#888', fontWeight: '600' },
  aobCollapseChevron: { fontSize: 11, color: '#bbb' },

  aobSessionList: { marginTop: 6, gap: 8 },
  aobSessionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: '#f9f9f9',
  },

  // Intensity pills: L / M / V
  aobIntensityPill: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  aobPillLight:    { backgroundColor: '#C8E6C9' },
  aobPillModerate: { backgroundColor: '#FFE082' },
  aobPillVigorous: { backgroundColor: '#FFCCBC' },
  aobIntensityPillText: { fontSize: 11, fontWeight: '900', color: '#333' },

  aobSessionInfo:    { flex: 1 },
  aobSessionTopRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  aobSessionLabel:   { fontSize: 12, fontWeight: '700', color: '#333', flex: 1 },
  aobActiveDot:      { backgroundColor: '#E8F5E9', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  aobActiveDotText:  { fontSize: 9, fontWeight: '700', color: '#2E7D32' },

  // absorbed_fraction progress bar
  aobProgressTrack: {
    height: 4, backgroundColor: '#f0f0f0', borderRadius: 2, marginBottom: 3, overflow: 'hidden',
  },
  aobProgressFill: {
    height: 4, backgroundColor: '#FF8F00', borderRadius: 2,
  },

  aobSessionMeta:   { fontSize: 10, color: '#888' },
  aobSessionEffect: { fontSize: 13, fontWeight: '800', minWidth: 48, textAlign: 'right' },

  /** Net effect section sensitivity note */
  aobNetSensRow: {
    marginTop: 6, marginBottom: 2,
    backgroundColor: '#fff8e1', borderRadius: 8, padding: 8,
  },
  aobNetSensText: { fontSize: 11, color: '#E65100', fontWeight: '600' },

  // ── Assessment card ────────────────────────────────────────────────────────
  assessmentCard: {
    marginHorizontal: 12, marginTop: 12, borderRadius: 14, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
  },
  assessment_good:     { backgroundColor: '#f1f8e9' },
  assessment_warning:  { backgroundColor: '#fff8e1' },
  assessment_negative: { backgroundColor: '#fce4ec' },
  assessment_positive: { backgroundColor: '#e3f2fd' },
  assHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  assessmentTitle: { fontSize: 15, fontWeight: '800', flex: 1 },
  assessmentBody:  { fontSize: 13, color: '#555', marginBottom: 12, lineHeight: 18 },

  assChipsInline: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chipIOB: { backgroundColor: '#f3e5f5', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  chipIOBText: { fontSize: 11, fontWeight: '700', color: '#7b1fa2' },
  chipMOB: { backgroundColor: '#fff3e0', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  chipMOBText: { fontSize: 11, fontWeight: '700', color: '#e65100' },
  chipAOB: { backgroundColor: '#e8f5e9', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  chipAOBText: { fontSize: 11, fontWeight: '700', color: '#2e7d32' },

  assJourneyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  assJourneyBox: { alignItems: 'center', minWidth: 56 },
  assJourneyBoxNow: {
    backgroundColor: '#fff', borderRadius: 10, padding: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
  },
  assJourneyEyebrow: { fontSize: 8, fontWeight: '700', color: '#aaa', letterSpacing: 0.5, marginBottom: 2 },
  assJourneyValue:   { fontSize: 20, fontWeight: '900' },
  assJourneyUnit:    { fontSize: 9, color: '#999' },
  assJourneyHint:    { fontSize: 9, color: '#bbb', marginTop: 2 },
  assJourneyArrowBox: { alignItems: 'center', minWidth: 28 },
  assJourneyArrowGrey: { fontSize: 16, color: '#ccc' },
  assJourneyArrowDelta: { fontSize: 11, fontWeight: '800', marginTop: 2 },

  // Tug of war
  tugSection: { marginTop: 12 },
  tugLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  tugLabelMeal:    { fontSize: 11, color: '#FF9800', fontWeight: '700' },
  tugLabelInsulin: { fontSize: 11, color: '#9C27B0', fontWeight: '700' },
  tugBarTrack: {
    flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden',
    backgroundColor: '#eee',
  },
  tugBarMeal:    { backgroundColor: '#FF9800' },
  tugBarInsulin: { backgroundColor: '#9C27B0' },
  tugValueRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  tugValueMeal:    { fontSize: 12, fontWeight: '700', color: '#FF9800' },
  tugValueInsulin: { fontSize: 12, fontWeight: '700', color: '#9C27B0' },
  tugNetBadge: {
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2,
    fontSize: 11, fontWeight: '800',
  },
  tugCaption: { fontSize: 11, color: '#888', marginTop: 6, textAlign: 'center', fontStyle: 'italic' },

  // ── More details toggle ───────────────────────────────────────────────────
  detailsToggle: {
    alignSelf: 'center',
    marginTop: 6,
    marginBottom: 2,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#f0f4ff',
    borderWidth: 1,
    borderColor: '#c5cfe8',
  },
  detailsToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4a6fa5',
    letterSpacing: 0.3,
  },

  // ── Net effect collapsible ────────────────────────────────────────────────
  netCard: {
    marginHorizontal: 12, marginTop: 12, backgroundColor: '#fff', borderRadius: 14, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 6, elevation: 2,
  },
  netCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  netCardTitle:  { fontSize: 14, fontWeight: '700', color: '#2e7d32' },
  netCardChevron: { fontSize: 14, color: '#999' },
  netCardCollapsedHint: { fontSize: 11, color: '#bbb', marginTop: 6 },
  netDivider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 10 },

  effectRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f5f5f5',
  },
  effectLeft:     { flex: 1, paddingRight: 8 },
  effectLabel:    { fontSize: 13, fontWeight: '600', color: '#333' },
  effectSublabel: { fontSize: 10, color: '#999', marginTop: 2 },
  effectValue:    { fontSize: 14, fontWeight: '700' },

  netRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, marginTop: 4,
    borderTopWidth: 2, borderTopColor: '#eeeeee',
  },
  netRowLabel: { fontSize: 13, fontWeight: '700', color: '#333' },
  netRowValue: { fontSize: 15, fontWeight: '800' },

  cumulBlock: {
    marginTop: 10, padding: 10, borderRadius: 8,
    backgroundColor: '#f0f9ff', borderLeftWidth: 4, borderLeftColor: '#2196f3',
  },
  cumulBlockNet: { backgroundColor: '#e8f5e9', borderLeftColor: '#4caf50', marginTop: 6 },
  cumulBlockHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cumulBlockTitle:  { fontSize: 12, fontWeight: '700', color: '#333', flex: 1 },
  cumulBlockValue:  { fontSize: 15, fontWeight: '700' },
  cumulNetValue:    { fontSize: 17, fontWeight: '800' },
  cumulBlockSub:    { fontSize: 10, color: '#888', marginTop: 3 },

  projectedRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 10, paddingTop: 10,
    borderTopWidth: 2, borderTopColor: '#eeeeee',
  },
  projectedLabel: { fontSize: 13, fontWeight: '700', color: '#333' },
  projectedSub:   { fontSize: 10, color: '#aaa', marginTop: 2 },
  projectedValue: { fontSize: 22, fontWeight: '800' },

  // ── Shared highlight colours ──────────────────────────────────────────────
  positive: { color: '#4CAF50' },
  negative: { color: '#F44336' },
  warning:  { color: '#FF9800' },
  good:     { color: '#2196F3' },

  // ── Footer ────────────────────────────────────────────────────────────────
  meta: {
    flexDirection: 'row', justifyContent: 'space-around', flexWrap: 'wrap',
    backgroundColor: '#fff', marginHorizontal: 12, marginTop: 8,
    padding: 12, borderRadius: 12,
  },
  metaText: { fontSize: 12, color: '#aaa' },

  refreshButton: {
    backgroundColor: '#007AFF', margin: 12, padding: 14,
    borderRadius: 12, alignItems: 'center',
  },
  refreshButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // ── Loading / error ───────────────────────────────────────────────────────
  loadingText: { fontSize: 15, color: '#666', marginTop: 16 },
  errorText:   { fontSize: 15, color: '#F44336', textAlign: 'center', marginBottom: 16 },
  retryButton: {
    backgroundColor: '#007AFF', padding: 14, borderRadius: 12,
    alignItems: 'center', marginHorizontal: 32,
  },
  retryText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // ── Mode badge ──────────────────────────────────────────────────────────────
  modeBadgeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 6, marginBottom: 2,
  },
  modeBadge: {
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1,
  },
  modeBadgeDynamic: { backgroundColor: '#e3f2fd', borderColor: '#2196f3' },
  modeBadgePreset:  { backgroundColor: '#e8f5e9', borderColor: '#4caf50' },
  modeBadgeText:    { fontSize: 11, fontWeight: '600' },
  modeBadgeTextDynamic: { color: '#1565c0' },
  modeBadgeTextPreset:  { color: '#2e7d32' },
  modeBadgeHint: { fontSize: 11, color: '#aaa' },

  // ── Baseline clamp warning banner ─────────────────────────────────────────
  clampBanner: {
    marginHorizontal: 12, marginTop: 8, marginBottom: 2,
    backgroundColor: '#fff3e0', borderRadius: 10,
    borderLeftWidth: 4, borderLeftColor: '#e65100', padding: 12,
    shadowColor: '#e65100', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12, shadowRadius: 4, elevation: 2,
  },
  clampBannerRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  clampBannerIcon:     { fontSize: 20, marginTop: 1 },
  clampBannerTextCol:  { flex: 1, gap: 3 },
  clampBannerTitle:    { fontSize: 13, fontWeight: '700', color: '#bf360c', letterSpacing: 0.2 },
  clampBannerBody:     { fontSize: 12, color: '#5d4037', lineHeight: 17 },
  clampBannerHighlight: { fontWeight: '700', color: '#bf360c' },
  clampBannerReason:   { fontSize: 11, color: '#8d6e63', marginTop: 2, fontStyle: 'italic' },

  // ── Unreliable estimate alert ─────────────────────────────────────────────
  unreliableBanner: {
    marginHorizontal: 12, marginTop: 10, marginBottom: 4,
    backgroundColor: '#fff8e1', borderRadius: 14,
    borderWidth: 1.5, borderColor: '#f9a825', padding: 16,
    shadowColor: '#f57f17', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14, shadowRadius: 6, elevation: 3,
  },
  unreliableBannerHeader:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  unreliableBannerIcon:     { fontSize: 22 },
  unreliableBannerTitle:    { fontSize: 16, fontWeight: '800', color: '#e65100', letterSpacing: 0.1, flex: 1 },
  unreliableBannerBody:     { fontSize: 13, color: '#5d4037', lineHeight: 19, marginBottom: 14 },
  unreliableBannerSubtitle: {
    fontSize: 12, fontWeight: '700', color: '#6d4c41',
    marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4,
  },
  unreliableChecklist: {
    backgroundColor: '#fff', borderRadius: 10,
    borderWidth: 1, borderColor: '#ffe0b2',
    overflow: 'hidden', marginBottom: 14,
  },
  unreliableCheckRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 12, paddingVertical: 11, gap: 10,
  },
  unreliableCheckDivider: { height: 1, backgroundColor: '#fff3e0', marginHorizontal: 12 },
  unreliableCheckIcon:    { fontSize: 18, marginTop: 1 },
  unreliableCheckText:    { flex: 1, gap: 3 },
  unreliableCheckLabel:   { fontSize: 13, fontWeight: '700', color: '#4e342e' },
  unreliableCheckHint:    { fontSize: 11, color: '#795548', lineHeight: 16 },
  unreliableCheckStatus:  { fontSize: 13, fontWeight: '800', marginTop: 2 },
  unreliableCheckOk:      { color: '#2e7d32' },
  unreliableCheckWarn:    { color: '#c62828' },
  unreliableBannerFooter: {
    fontSize: 11, color: '#8d6e63', textAlign: 'center',
    fontStyle: 'italic', lineHeight: 16,
  },

  // ── Per-dose / per-meal sub-breakdown (mirrors AOB session list) ──────────
  subCollapseToggle: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, marginTop: 6,
    borderTopWidth: 1, borderTopColor: '#f0f0f0',
  },
  subCollapseLabel:   { fontSize: 11, color: '#888', fontWeight: '600' },
  subCollapseChevron: { fontSize: 11, color: '#bbb' },
  subItemList: { marginTop: 4, gap: 6 },
  subItemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 5,
    borderBottomWidth: 1, borderBottomColor: '#f9f9f9',
  },
  subStatusPill: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  // IOB pills
  subPillActive:   { backgroundColor: '#e1bee7' },  // purple tint — active insulin
  subPillAbsorbed: { backgroundColor: '#e8f5e9' },  // green tint — absorbed/done
  subPillFuture:   { backgroundColor: '#fff9c4' },  // yellow tint — upcoming
  // MOB active pill (orange to match meal theme)
  subPillMealActive: { backgroundColor: '#ffe0b2' },
  subStatusPillText: { fontSize: 10, fontWeight: '900', color: '#555' },
  subItemInfo: { flex: 1 },
  subItemLabel: { fontSize: 12, fontWeight: '700', color: '#333' },
  subItemMeta:  { fontSize: 10, color: '#999', marginTop: 1 },
  subItemStatus: { fontSize: 10, fontWeight: '700', minWidth: 52, textAlign: 'right' },
  /** BG effect line inside an IOB dose sub-item */
  subItemBgEffect: {
    fontSize: 10,
    fontWeight: '600',
    color: '#7b1fa2',   // purple — matches IOB active colour
    marginTop: 2,
  },
  /** BG effect line inside a MOB meal sub-item */
  subItemBgEffectMeal: {
    fontSize: 10,
    fontWeight: '600',
    color: '#e65100',   // orange — matches meal active colour
    marginTop: 2,
  },
  /** BG effect line inside an AOB session sub-item */
  subItemBgEffectAOB: {
    fontSize: 10,
    fontWeight: '600',
    color: '#00695c',   // teal — matches activity theme
    marginTop: 2,
  },
  /** Status text colour for an active AOB session */
  subStatusAOBActiveText: { color: '#00695c' },
  subStatusActiveText:     { color: '#7b1fa2' },   // purple — insulin active
  subStatusMealActiveText: { color: '#e65100' },   // orange — meal digesting
  subStatusAbsorbedText:   { color: '#4caf50' },   // green — done
  subStatusFutureText:     { color: '#f9a825' },   // amber — upcoming

  // ── Activity indirect-effect block ────────────────────────────────────────
  /**
   * Container for the "indirect effects on IOB & MOB" section rendered inside
   * the expanded activity card when sensitivityMultiplier > 1.005.
   *
   * Teal-tinted to match the activity theme; left-border accent matches the
   * style used by cumulBlock and the AOB impact blocks above it.
   */
  aobIndirectBlock: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#e0f2f1',   // light teal background
    borderLeftWidth: 3,
    borderLeftColor: '#00897b',   // teal-700
  },
  /** Bold section title — "⚡ Indirect effects on active entries" */
  aobIndirectTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#00695c',             // teal-800
    marginBottom: 3,
  },
  /** One-line explanatory subtitle below the title */
  aobIndirectHint: {
    fontSize: 11,
    color: '#00695c',
    marginBottom: 8,
    lineHeight: 16,
    fontStyle: 'italic',
  },
  /** Horizontal row for a single indirect-effect entry (IOB or MOB) */
  aobIndirectRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  /** Emoji icon on the left of each indirect-effect row */
  aobIndirectIcon: {
    fontSize: 18,
    marginTop: 1,
  },
  /** Text column inside each indirect-effect row */
  aobIndirectInfo: {
    flex: 1,
    gap: 2,
  },
  /** Primary label — effect name and magnitude */
  aobIndirectLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#004d40',             // teal-900 — high contrast for the key number
  },
  /** Secondary detail — raw vs effective constant, units active / carbs pending */
  aobIndirectMeta: {
    fontSize: 10,
    color: '#00695c',             // teal-800
    lineHeight: 15,
  },

  /**
   * Single-line hint rendered below the main AOB value row when the card is
   * COLLAPSED but sensitivityMultiplier > 1.005 AND at least one indirect
   * effect is non-trivial.  Gives the patient just enough information to know
   * something meaningful is happening without requiring them to expand.
   */
  aobIndirectCollapsedHint: {
    fontSize: 11,
    color: '#00695c',
    fontStyle: 'italic',
    marginTop: 4,
    marginBottom: 2,
  },

  /**
   * One-line breakdown sub-text shown beneath the combined main value when
   * both direct AOB and indirect (sensitivity boost) components are present.
   * e.g. "2.3 direct · 48.0 indirect"
   */
  aobCombinedBreakdown: {
    fontSize: 11,
    color: '#00897b',           // teal-600 — softer than the main value
    fontWeight: '600',
    marginTop: 2,
  },

  // ── Indirect effect per-entry sections (IOB / MOB split) ─────────────────
  /**
   * Wrapper for one indirect-effect entry (IOB or MOB).
   * Contains the header row plus the pending and absorbed sub-blocks.
   */
  aobIndirectSection: {
    gap: 5,
  },
  /**
   * Pending sub-block inside an indirect-effect entry.
   * Teal-tinted — matches the AOB pending block palette; indented under the
   * emoji icon to visually attach to the header row above it.
   */
  aobIndirectSubPending: {
    marginLeft: 26,
    padding: 8,
    borderRadius: 6,
    backgroundColor: '#b2dfdb',   // teal-100 — slightly more saturated than outer block
    borderLeftWidth: 2,
    borderLeftColor: '#00897b',   // teal-700
  },
  /**
   * Absorbed sub-block inside an indirect-effect entry.
   * Green-tinted — matches the IOB/MOB absorbed block palette; same indent as
   * the pending block so the two form a clear visual pair.
   */
  aobIndirectSubAbsorbed: {
    marginLeft: 26,
    padding: 8,
    borderRadius: 6,
    backgroundColor: '#e8f5e9',   // green-50 — absorbed / delivered
    borderLeftWidth: 2,
    borderLeftColor: '#4caf50',   // green-500
  },
  /** Primary value text inside the pending sub-block */
  aobIndirectSubPendingText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#004d40',             // teal-900
  },
  /** Primary value text inside the absorbed sub-block */
  aobIndirectSubAbsorbedText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2e7d32',             // green-800
  },
  /** Secondary note line shared by both sub-blocks */
  aobIndirectSubNote: {
    fontSize: 10,
    color: '#546e7a',             // blue-grey — neutral, readable on both teal and green */
    marginTop: 2,
    lineHeight: 14,
  },
});