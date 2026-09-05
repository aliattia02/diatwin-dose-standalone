/**
 * Active Effects Hook
 *
 * 🐛 FIXES:
 * 1. Added detailed logging for calculateNetEffect() return values
 * 2. Added field name checking for cumulative values
 * 3. Added fallback to backend API if local calculations fail
 * 4. Enhanced error tracking for each calculation step
 * 5. Preset (circadian) mode now applies calculateTotalCumulativeEffects after
 *    calculateNetEffect so estimatedBG / projectedFinalBG include meals and
 *    insulin correctly — the zeroed cumulative fields on the preset BaselineResult
 *    were causing estimatedBG = circadianBG + 0 (meals/insulin silently ignored).
 *    The backend fallback is also suppressed in preset mode since it cannot
 *    patch estimatedBG/projectedFinalBG, only the three cumulative fields.
 * 6. FIX: Insulin API endpoint only accepts `days` (not `start`/`end`).
 *    Previously the fetch used { start: startISO, end: endISO } which the
 *    backend silently ignored, so insulin was always fetched with the default
 *    window (~24-48h). Doses older than ~2 days were therefore missing from
 *    the chart even though meals in the same period showed correctly.
 *    Fixed by converting the window to a `days` integer parameter.
 * 7. Activity PD integration: GET /api/activity/pharmacodynamics is fetched
 *    concurrently in fetchData() and its cumulative_activity_effect is added
 *    as the third signed term into estimatedBG (both dynamic and preset modes).
 *    When sensitivityMultiplier > 1.0 the effective_correction_factor /
 *    effective_carb_to_bg_ratio are used for pending IOB/MOB projection.
 * 8. FIX (D-2): calculateNetEffect is now imported from the canonical
 *    @/utils/calculations/net-effect wrapper, which accepts activityPD as a
 *    7th argument and integrates cumulative_activity_effect into estimatedBG
 *    in one place. The dynamic-mode manual estimatedBG patch is removed;
 *    only the projectedFinalBG IOB-double-count fix is kept. Preset mode is
 *    unchanged (it rebuilds estimatedBG from scratch, so no double-count risk).
 * 9. FIX (D-6): 30-second client-side debounce on the Activity PD fetch,
 *    matching the React frontend fix 11.5. Prevents hammering the ODE endpoint
 *    on rapid re-renders or consecutive refresh() calls. Debounce is reset to
 *    0 on manual refresh() so post-session updates are never blocked.
 *
 * @module hooks/useActiveEffects
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePatientConstants } from './usePatientConstants';
import { useAuthStore } from '@/store/auth.store';
import API from '@/services/api/endpoints';
import apiClient from '@/services/api/client';
import {
  calculateStableBaselineFromReading,
} from '@/utils/glucose/blood-glucose-estimation';
// ✅ FIX (D-2): import the canonical net-effect wrapper that accepts activityPD
// as a 7th argument and integrates cumulative_activity_effect into estimatedBG.
// Previously calculateNetEffect was imported from blood-glucose-estimation, which
// knows nothing about activity — the effect was then manually patched inline for
// dynamic mode only.  Using the wrapper unifies the integration point so any
// future change to activity handling in net-effect.ts propagates automatically.
import { calculateNetEffect } from '@/utils/calculations/net-effect';
import { sanitizeBaseline } from '@/utils/calculations/baseline';
// ✅ FIX: import the Phase 3 "persist-at-100%" fixed version of
// calculateTotalCumulativeEffects from @/utils/calculations (cumulative-effects.ts v4.4).
// The version exported by blood-glucose-estimation.ts lacks Phase 3 — for fully-absorbed
// meals/doses it returns 0 instead of persisting totalCarbs × carbToBgFactor, causing
// correctedEstimatedBG and correctedProjected in preset mode to ignore any meal that has
// finished absorbing.  The old import is removed to prevent accidental use elsewhere.
import {
  calculateTotalCumulativeEffects,
  // P1 fix (§9): shared lock-in model — extracted from the private
  // _activityEffectAtTime so EVC, AED, BGV, and this hook all
  // use one implementation instead of four drifting copies.
  calculateActivityEffectForCumulative,
} from '@/utils/calculations';
import { getTotalCarbsFromMeal } from '@/utils/glucose/meal-pharmacodynamics';
import {
  MEAL_ABSORPTION_PROFILES,
  getCircadianBaseline,
  type BaselineMode,
  type CircadianProfile,
} from '@/constants/shared-constants';
// ── Activity PD ─────────────────────────────────────────────────────────────
import type {
  ActivityPDResult,
  ActivityContribution,
} from '@/services/api/activity-pharmacodynamics';
import type { ActivityHistoryResponse } from '@/services/api/activities';

import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { GlucoseReading } from '@/types/glucose.types';
import type { BaselineResult, NetEffectResult } from '@/types/calculation.types';
import type { SafetyStatusLevel, GlucoseTrend } from '@/types/safety.types';

// ─── Activity delta helper ────────────────────────────────────────────────────
// calculateActivityEffectForCumulative is imported from @/utils/calculations
// (cumulative-effects.ts).  The previous private _activityEffectAtTime was
// identical logic; it is removed here as part of P1 fix (§9) so that EVC,
// AED, BGV, and this hook all share one implementation.

// ─── Module-level UTC timestamp parser (mirrors EVC / cumulative-effects.ts) ──
// Handles: number (UTC ms), numeric string, bare ISO, Z-suffixed ISO.
// Kept module-level so the activity-history dedup closure (below) can reference
// it without capturing a per-render closure.
function _parseUTCMsHook(ts: string | number | null | undefined): number {
  if (ts === null || ts === undefined || ts === '') return NaN;
  if (typeof ts === 'number') return ts;
  if (/^\d+$/.test(String(ts))) return parseInt(String(ts), 10);
  const s = String(ts);
  const hasZone = s.endsWith('Z') || s.includes('+') || /T.*-\d{2}:\d{2}$/.test(s);
  return hasZone ? new Date(s).getTime() : new Date(s.replace(' ', 'T') + 'Z').getTime();
}

// Parse "HH:MM" or numeric string to total minutes (mirrors EVC parseDurationStr).
function _parseDurMinHook(dur: string | number | undefined): number {
  if (!dur) return 30;
  if (typeof dur === 'number') return isFinite(dur) ? dur : 30;
  const parts = String(dur).split(':');
  if (parts.length === 2) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    return isNaN(h) || isNaN(m) ? 30 : h * 60 + m;
  }
  const n = parseFloat(String(dur));
  return isNaN(n) ? 30 : n;
}

/**
 * Converts a plain object with numeric string keys ({"0": x, "1": y, …})
 * to a proper array.  This is needed because some backend endpoints serialise
 * Python lists/dicts incorrectly via jsonify(), producing {"0":…,"1":…}
 * instead of a JSON array.
 */
function objectWithNumericKeysToArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object);
    // FIX (Bug A): was .every() — if ANY non-numeric key existed (e.g. "count",
    // "total", "status" appended by the backend) the whole check failed and
    // returned [].  We now extract ONLY the numeric-keyed values, sorted in
    // order, ignoring any metadata keys that may be present.
    const numericKeys = keys
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      return numericKeys.map(k => (value as Record<string, unknown>)[k]) as T[];
    }
  }
  return [];
}

/**
 * Robustly extract an array from an API response object.
 *
 * Problems with the naive `??` chain:
 *   1. `??` only skips null/undefined — NOT empty arrays `[]`.
 *      If the backend returns { "data": [], "0": meal, "1": meal, ... }
 *      the chain stops at `data` and returns [] instead of falling through.
 *   2. Non-array named keys (numbers, strings) are silently ignored.
 *
 * This helper tries each named key in order, skipping any that produce an
 * empty array, then falls back to numeric-key extraction on the root object.
 */
function pickResponseArray<T>(root: unknown, namedKeys: string[]): T[] {
  if (Array.isArray(root) && (root as T[]).length > 0) return root as T[];

  if (root !== null && typeof root === 'object') {
    // 1. Try each named key — skip empty arrays
    for (const key of namedKeys) {
      const candidate = (root as Record<string, unknown>)[key];
      if (Array.isArray(candidate) && candidate.length > 0) return candidate as T[];
    }
    // 2. Fall back: extract numeric-keyed values from the root object itself
    const numeric = objectWithNumericKeysToArray<T>(root);
    if (numeric.length > 0) return numeric;
  }

  return [];
}

export interface UseActiveEffectsOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
  includeProjections?: boolean;
  patientId?: string;
  debug?: boolean;
  /** 🆕 Fallback to backend if frontend calculations return zeros */
  useFallback?: boolean;
  /**
   * 🆕 How many hours back to fetch meals and insulin doses.
   * Defaults to 24.  Pass the chart's total view window so that switching
   * to 3D/7D view fetches enough data for the full range.
   */
  windowHours?: number;
  /**
   * 🆕 Skip the 48-hour IOB cutoff filter when true.
   *
   * ActiveEffectsDisplay (live IOB / estimatedBG) needs the cutoff — it must
   * only see pharmacologically active doses so the BG estimate is accurate.
   *
   * Visualization charts (EffectsVisualizationChart, BloodGlucoseVisualization)
   * manage their own per-point window filter (cumulativeWindowStart) internally,
   * so the 48-hour pre-filter is redundant and actively harmful for multi-day
   * views (3D / 7D) where valid historical doses were being dropped early.
   *
   * Default: false (safe for live display).
   */
  skipIobCutoff?: boolean;
}

export interface UseActiveEffectsResult {
  // Display Values
  stableBaseline: number | null;
  estimatedBG: number | null;
  projectedFinalBG: number | null;

  // Active Effects
  totalIOB: number;
  totalMOB: number;
  activeInsulinEffect: number;
  activeMealEffect: number;
  currentNetEffect: number;

  // Cumulative Effects (Bank Balance)
  cumulativeMealEffect: number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline: number;

  // ── Activity PD ────────────────────────────────────────────────────────────
  /** Signed cumulative BG effect of all today's exercise sessions (mg/dL).
   *  Negative = net BG-lowering. 0 when no sessions exist. */
  activityEffect: number;
  /** Post-exercise ISF/CR sensitivity boost.  ≥ 1.0.  1.0 = no boost. */
  sensitivityMultiplier: number;
  /** Unsigned remaining acute BG drop still to arrive across all sessions (mg/dL). */
  activityOnBoard: number;
  /** Per-session breakdown from the stacked PD endpoint. */
  activityContributions: ActivityContribution[];
  /**
   * Raw stacked PD response from GET /api/activity/pharmacodynamics.
   * Null when no sessions exist today or the fetch failed.
   *
   * Exposed so that child components (e.g. EffectsVisualizationChart) can use
   * it directly without a second API call, instead of requiring a prop-drilled
   * ActivityPDResult from a grandparent screen.
   */
  /**
   * Null once the first fetch confirms no exercise sessions today.
   * Undefined only during the very first fetch before any data has arrived.
   * Gate prop-passing on lastUpdate (see index.tsx FIX 5) to avoid passing
   * null to child components before the fetch has actually resolved.
   */
  activityPDResult: ActivityPDResult | null | undefined;
  /**
   * Raw activity history records for the full fetch window.
   * Only populated when windowHours > 24 (multi-day chart views).
   * Used by EffectsVisualizationChart to build synthetic historical
   * ActivityContribution objects for chart points beyond today's daily reset.
   */
  activityHistory: ActivityHistoryResponse[];

  // Safety & Trends
  safetyStatus: SafetyStatusLevel | null;
  trend: GlucoseTrend | null;

  // Detailed Breakdowns
  baselineDetails: BaselineResult | null;
  netEffectDetails: NetEffectResult | null;

  // 🆕 Backend fallback data
  backendData: any | null;
  usingBackend: boolean;

  // 🆕 Raw fetched arrays — exposed so chart components (e.g. EffectsVisualizationChart)
  //    can pass them directly to processMealsForChart / processInsulinForChart
  //    without a second API call.
  meals: Meal[];
  insulinDoses: InsulinDose[];

  // Meta
  isLoading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  calculationErrors: string[];

  // 🆕 Active baseline mode resolved from patient constants
  baselineMode: 'dynamic' | 'preset';

  // 🆕 Baseline sanitization — set when the raw value was outside hard bounds
  baselineWarnings: string[];
  baselineSanitizeStatus: 'ok' | 'hard_clamped' | null;

  // Actions
  refresh: () => Promise<void>;
  setMeals: (meals: Meal[]) => void;
  setInsulinDoses: (doses: InsulinDose[]) => void;
  setLatestReading: (reading: GlucoseReading | null) => void;
}

/**
 * Hook for calculating active effects with comprehensive debugging
 */
export function useActiveEffects(
  options: UseActiveEffectsOptions = {}
): UseActiveEffectsResult {
  const {
    autoRefresh = true,
    refreshInterval = 60000,
    includeProjections = true,
    debug = false,   // ✅ false in production; pass debug:true explicitly when needed
    useFallback = true,
    windowHours = 24,
    skipIobCutoff = false,
  } = options;

  // Get patient constants
  const { constants, isLoading: constantsLoading } = usePatientConstants();

  // Get token from auth store
  const token = useAuthStore((state) => state.token);

  // ── Atomic data state ────────────────────────────────────────────────────
  // All four are updated in ONE setState call inside fetchData() so that
  // calculateEffects() is never triggered with a partially-loaded snapshot
  // (e.g. doses populated but meals still empty → estimatedBG = -67 mg/dL).
  const [fetchedData, setFetchedData] = useState<{
    meals: Meal[];
    doses: InsulinDose[];
    reading: GlucoseReading | null;
    activityPD: ActivityPDResult | null | undefined;  // undefined = never fetched; null = fetched, no sessions
    activityHistory: ActivityHistoryResponse[];
    ready: boolean;
  }>({ meals: [], doses: [], reading: null, activityPD: undefined, activityHistory: [], ready: false });

  // Convenience aliases — keep existing internal usage working without churn
  const meals        = fetchedData.meals;
  const insulinDoses = fetchedData.doses;
  const latestReading = fetchedData.reading;
  const activityPD   = fetchedData.activityPD;
  const activityHistory = fetchedData.activityHistory;

  // Setters still exposed in the public API (used by chart components)
  const setMeals        = (m: Meal[])                 => setFetchedData(prev => ({ ...prev, meals: m }));
  const setInsulinDoses = (d: InsulinDose[])          => setFetchedData(prev => ({ ...prev, doses: d }));
  const setLatestReading = (r: GlucoseReading | null) => setFetchedData(prev => ({ ...prev, reading: r }));

  // Calculation results
  const [baselineDetails, setBaselineDetails] = useState<BaselineResult | null>(null);
  const [netEffectDetails, setNetEffectDetails] = useState<NetEffectResult | null>(null);

  // 🆕 Backend fallback
  const [backendData, setBackendData] = useState<any | null>(null);
  const [usingBackend, setUsingBackend] = useState(false);

  // Meta state
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [calculationErrors, setCalculationErrors] = useState<string[]>([]);
  const [baselineWarnings, setBaselineWarnings] = useState<string[]>([]);
  const [baselineSanitizeStatus, setBaselineSanitizeStatus] = useState<'ok' | 'hard_clamped' | null>(null);

  // Derive baseline mode directly from constants so it is never one render
  // behind the actual value.  Previously this was stored in a useState and set
  // inside calculateEffects(), causing a one-cycle lag: the UI would display
  // the old mode label for one full render after the user switched.
  const resolvedBaselineMode: 'dynamic' | 'preset' =
    ((constants as any)?.baseline_mode === 'preset') ? 'preset' : 'dynamic';

  // Refs for throttling
  const lastCalculationMinute = useRef<number>(0);
  const refreshTimer = useRef<NodeJS.Timeout | null>(null);

  // ── Debug: stable instance ID so every log line identifies its source ────────
  // Format: [UAF:xxxx] — "UseActiveEffects".  Multiple hook instances on one
  // screen each get a unique suffix so you can tell EVC's instance from the
  // parent screen's instance in the console.
  const instanceIdRef = useRef(`UAF:${Math.random().toString(36).slice(2, 6)}`);
  // Track the previous baseline_mode so we can detect changes and bypass the
  // per-minute throttle when the user switches modes.  Stored in a ref (not
  // state) so the comparison doesn't trigger additional re-renders.
  //
  // ✅ FIX: Seed from the initial constants value instead of `undefined`.
  // Previously this started as `undefined`, which caused `modeJustChanged` to
  // be `true` on every first calculateEffects() call (undefined !== 'dynamic'),
  // resetting lastCalculationMinute to 0 before it was set to currentMinute.
  // This was benign but caused a redundant [baselineMode] effect call immediately
  // after mount. Seeding from constants ensures the first call never looks like
  // a mode change, so the throttle-bypass only fires on actual toggle events.
  const lastBaselineModeRef = useRef<string | undefined>(
    (constants as any)?.baseline_mode ?? 'dynamic'
  );

  // ── Render-loop guards ────────────────────────────────────────────────────
  //
  // ROOT CAUSE SUMMARY (render-loop ticket):
  // The API call storm (10+ concurrent fetchData batches) has two layers:
  //
  // Layer 1 — Multi-instance: every component that calls useActiveEffects()
  //   (parent screen, EVC, AED-internal fetchAndCalculate, BGV, etc.) fires its
  //   own Promise.all on mount simultaneously. Each instance is independent and
  //   has no knowledge of the others.
  //
  // Layer 2 — constantsLoading bounce: usePatientConstants re-fetches constants
  //   in the background after initial load, toggling constantsLoading false→true→false.
  //   Because constantsLoading is in the auto-refresh effect's dep array, each
  //   bounce tears down the existing interval (cleanup) and immediately calls
  //   fetchDataRef.current() again in the new effect invocation. With N instances
  //   of the hook, N extra fetches fire per bounce.
  //
  // Fix A (here) — in-flight guard: prevents any single hook instance from
  //   having more than one concurrent fetchData() call in flight. Belt-and-
  //   suspenders for Layer 1 and fully fixes the Layer 2 double-fire.
  //
  // Fix B (here) — intervalSetupDoneRef: the auto-refresh effect marks itself
  //   "done" after first setup. Subsequent re-invocations from constantsLoading
  //   bounces STILL call fetchDataRef.current() once (correct — fresh data after
  //   a constants reload) but skip re-creating the interval, preventing stacking
  //   of concurrent polling loops.
  //
  // Architectural fix (separate PR): lift useActiveEffects to the parent screen
  //   and pass activityPDResult + meals + doses as props to EVC and AED.
  //   That eliminates Layer 1 entirely. See handoff doc "Known remaining concern."
  const fetchInFlightRef    = useRef(false);   // Fix A: in-flight guard
  const intervalSetupDoneRef = useRef(false);  // Fix B: one-time interval setup

  // ── Activity PD fetch debounce (fix D-6 / mirrors React fix 11.5) ─────────
  // The ODE endpoint is expensive on free-tier compute.  We enforce a 30s
  // minimum interval and serve the cached last result for any call within that
  // window.  The debounce is reset to 0 on manual refresh() so post-session
  // PD updates always fire immediately when the user explicitly refreshes.
  //
  // FIX: lastActivityPDResult is initialised to `undefined`, NOT `null`.
  // The debounce short-circuit checks `!== undefined` to decide whether a
  // cached value is available.  Initialising to `null` meant `null !== undefined`
  // evaluated to true on the very first render, so any rapid second fetch
  // (triggered by the concurrent multi-hook re-render storm visible in the logs)
  // returned `Promise.resolve(null)` instead of firing the real API call.
  // That null propagated into fetchedActivityPD → activityPD → the activity
  // overlay disappeared immediately after first render.
  //
  // With `undefined` as the sentinel:
  //   undefined  → "never fetched"  → always fires the real API call
  //   null       → "fetched, no data" → serves null from cache (correct)
  //   PDResult   → "fetched, has data" → serves result from cache (correct)
  const ACTIVITY_PD_MIN_INTERVAL_MS = 30_000;
  const lastActivityPDFetchMs  = useRef<number>(0);
  const lastActivityPDResult   = useRef<ActivityPDResult | null | undefined>(undefined);

  // ── Activity history fetch cache (fix: mirrors activityPD debounce pattern) ──
  // Activity history is "today's completed sessions" — it does NOT change with
  // the chart windowHours. Previously it was fetched fresh on every fetchData()
  // call, including every chart view switch (12h→3D→7D). This was the primary
  // driver of the redundant activityHistory FETCH bursts seen in the logs.
  //
  // TTL = 60 s (matches the auto-refresh cadence). Manual refresh() resets it
  // to 0 so post-session data always appears immediately on an explicit pull.
  //
  // Sentinel semantics (identical to lastActivityPDResult):
  //   undefined  → "never fetched"  → always fires the real API call
  //   []         → "fetched, no sessions today" → serves [] from cache
  //   [...]      → "fetched, has sessions"       → serves array from cache
  const ACTIVITY_HISTORY_MIN_INTERVAL_MS = 60_000;
  const lastActivityHistoryFetchMs = useRef<number>(0);
  const lastActivityHistoryResult  = useRef<ActivityHistoryResponse[] | undefined>(undefined);

  // ── One-time timezone mismatch check after patient constants load ────────
  // Detects when the stored timezone_offset_minutes diverges from the device's
  // actual offset by more than 60 min — which would cause CGM timestamps and
  // cumulative effect windows to be anchored at the wrong local time.
  //
  // JS getTimezoneOffset() returns NEGATIVE for east-of-UTC; flip the sign so
  // it matches the positive-east convention of timezone_offset_minutes.
  //
  // Convention: deviceOffsetMin = -new Date().getTimezoneOffset()
  //   Egypt (UTC+2)   → getTimezoneOffset() = -120  → deviceOffsetMin = +120
  //   Germany (UTC+1) → getTimezoneOffset() = -60   → deviceOffsetMin = +60
  //   UTC             → getTimezoneOffset() =  0    → deviceOffsetMin =  0
  useEffect(() => {
    if (!constants || constantsLoading) return;
    const deviceOffsetMin = -new Date().getTimezoneOffset();
    const storedOffsetMin = (constants as any)?.timezone_offset_minutes ?? 0;
    if (Math.abs(deviceOffsetMin - storedOffsetMin) > 60) {
      console.warn(
        `[useActiveEffects] timezone_offset_minutes mismatch: ` +
        `stored=${storedOffsetMin}, device=${deviceOffsetMin}. ` +
        `CGM timestamps and cumulative effects may be offset. ` +
        `Update timezone_offset_minutes in patient constants ` +
        `(positive = east of UTC, e.g. Egypt UTC+2 = 120).`
      );
    }
  // Run once when constants first become available (or when they change)
  }, [constants, constantsLoading]);

  /**
   * 🆕 Fetch backend data as fallback
   */
  const fetchBackendFallback = useCallback(async () => {
    try {
      if (debug) console.log('[useActiveEffects] 🌐 Fetching backend fallback...');

      const timezoneOffsetMinutes = -new Date().getTimezoneOffset();
      // FIX N-2: use the versioned constant so the v() helper applies when
      // USE_VERSIONED_API is toggled.  The previous hardcoded string would
      // produce a 404 on the backend fallback path once versioning is enabled,
      // because every other endpoint would transparently upgrade to /api/v1/…
      // while this one remained at /api/active-effects-full.
      const response = await apiClient.get(API.CALCULATIONS.ACTIVE_EFFECTS_FULL, {
        params: { timezone_offset_minutes: timezoneOffsetMinutes },
      });

      if (debug) console.log('[useActiveEffects] ✅ Backend fallback received:', JSON.stringify(response.data, null, 2));

      setBackendData(response.data);
      setUsingBackend(true);

      return response.data;
    } catch (err) {
      console.error('[useActiveEffects] ❌ Backend fallback failed:', err);
      setCalculationErrors(prev => [...prev, 'Backend fallback failed']);
      return null;
    }
  }, [debug]);

  /**
   * Helper to extract carbs from meal
   */
  const debugMealCarbs = (meal: Meal, index: number): number => {
    const finalCarbs = getTotalCarbsFromMeal(meal);

    if (debug) {
      console.log(`[useActiveEffects] 🍽️ Meal ${index + 1} carb extraction:`, {
        id: meal.id,
        type: meal.mealType,
        timestamp: meal.timestamp,
        'calculation_summary.total_carb_equiv': meal.calculation_summary?.total_carb_equiv,
        'nutrition.totalCarbEquiv': meal.nutrition?.totalCarbEquiv,
        'nutrition.carbs': meal.nutrition?.carbs,
        'foodItems count': meal.foodItems?.length || 0,
        'FINAL carbs': finalCarbs,
        '⚠️ WARNING': finalCarbs === 0 ? 'NO CARBS FOUND!' : null
      });

      // 🆕 Check each food item
      if (meal.foodItems && meal.foodItems.length > 0) {
        console.log(`[useActiveEffects]    📊 Food items breakdown:`);
        meal.foodItems.forEach((item: any, idx: number) => {
          console.log(`[useActiveEffects]       ${idx + 1}. ${item.name || 'Unknown'}:`, {
            carbs: item.carbs,
            carbEquiv: item.carbEquiv,
            quantity: item.quantity,
          });
        });
      } else {
        console.log(`[useActiveEffects]    ⚠️ NO FOOD ITEMS ARRAY`);
      }
    }

    return finalCarbs;
  };

  /**
   * Fetch data from backend
   */
  const fetchData = useCallback(async (reason = 'unknown') => {
    // Fix A: reject concurrent calls — if a fetch is already in flight for this
    // hook instance, skip rather than pile up a duplicate Promise.all batch.
    // The in-flight window is cleared in the finally block so the next scheduled
    // tick (60-second interval or manual refresh) always fires normally.
    if (fetchInFlightRef.current) {
      if (debug) console.log(`[${instanceIdRef.current}] 🚫 Skipping concurrent fetch (already in-flight) reason=${reason}`);
      return null;
    }
    fetchInFlightRef.current = true;
    if (debug) console.log(`[${instanceIdRef.current}] 📡 fetchData START reason=${reason} windowHours=${windowHours}`);

    try {
      if (!token) {
        throw new Error('No authentication token');
      }

      const currentTime = new Date();

      if (debug) {
        console.log('[useActiveEffects] 📡 Fetching data from API...');
      }

      // Calculate fetch window — add 8h buffer beyond the chart range so
      // meals/insulin that started before the window edge still have their
      // full absorption curve available.
      const windowEnd   = new Date();
      const windowStart = new Date(windowEnd.getTime() - (windowHours + 8) * 60 * 60 * 1000);
      const startISO    = windowStart.toISOString();
      const endISO      = windowEnd.toISOString();

      // ── FIX: Insulin endpoint only accepts `days`, not `start`/`end` ──────
      // The GET /api/insulin-data endpoint (insulin.ts → getDoses) only reads
      // the `days` query param. Passing `start`/`end` is silently ignored by
      // the backend, which then falls back to its default window (~24-48h).
      // This caused doses older than ~2 days to vanish from the chart even
      // though meals in the same period displayed correctly (meals endpoint
      // does support `start`/`end`).
      //
      // Fix: convert the desired window to a `days` integer.
      // +8h buffer is already baked into windowHours by the lines above;
      // we add +1 to round up so a fractional day is never truncated.
      const insulinDays = Math.ceil((windowHours + 8) / 24) + 1;

      if (debug) {
        console.log(`[useActiveEffects] 💉 Fetching insulin with days=${insulinDays} (windowHours=${windowHours})`);
      }

      // Use apiClient (not bare axios) so the configured baseURL is applied and
      // the request interceptor attaches the Bearer token automatically.
      // Bare axios.get with a path-only string resolves relative to the page
      // origin, which on Expo web is the dev server (localhost:8081), not Flask.
      //
      // IMPORTANT: Blood sugar is date-filtered to the last 24 h.
      // Without a filter the backend returns ALL readings (2 500+, ~490 KB).
      // On Render free tier this causes ECONNABORTED timeouts when several
      // concurrent callers each download the full payload simultaneously.
      const bsWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const bsWindowEnd   = new Date().toISOString();

      const [mealsRes, insulinRes, readingRes, activityPDRes, activityHistoryRes] = await Promise.all([
        apiClient.get(API.MEALS.MEALS_ONLY,    { params: { start: startISO, end: endISO } }),
        // ✅ FIX: use `days` param — the only param the insulin endpoint respects
        apiClient.get(API.INSULIN.DATA,         { params: { days: insulinDays } }),
        apiClient.get(API.BLOOD_SUGAR.LIST, {
          params: {
            start_time: bsWindowStart,
            end_time:   bsWindowEnd,
            filter_by:  'reading_time',
          }
        }).catch(() => null),
        // ── Activity PD (today's window, debounced) ───────────────────────────
        (() => {
          const now = Date.now();
          if (now - lastActivityPDFetchMs.current < ACTIVITY_PD_MIN_INTERVAL_MS && lastActivityPDResult.current !== undefined) {
            if (debug) {
              console.log(
                '[useActiveEffects] 🏃 activityPD debounce — reusing cached result, next fetch in',
                Math.ceil((ACTIVITY_PD_MIN_INTERVAL_MS - (now - lastActivityPDFetchMs.current)) / 1000), 's'
              );
            }
            return Promise.resolve(lastActivityPDResult.current ? { data: lastActivityPDResult.current } : null);
          }
          lastActivityPDFetchMs.current = now;
          return apiClient.get(API.ACTIVITY_PD.STACKED).catch((err) => {
            console.warn('[useActiveEffects] ⚠️ activityPD fetch failed — activity effect will be 0:', err);
            return null;
          });
        })(),
        // ── Activity history (ALL chart views, cached) ───────────────────────
        // FIX 1: removed windowHours > 24 guard — history is now fetched for all
        // view modes so short views (12h/24h) can also show activity effects for
        // sessions earlier in the same day (e.g. morning run visible at 14:00).
        //
        // FIX 2: backend /api/activity-history returns 400 for start_date/end_date
        // params — it only accepts start_time/end_time (confirmed via 400 error in
        // console). Switched to the correct param names.
        //
        // FIX 3 (performance): added TTL cache identical to the activityPD debounce.
        // Activity history is "today's completed sessions" — it does NOT change when
        // the chart windowHours changes (12h→3D etc.), so re-fetching it on every
        // view switch was pure waste. Serve the cached array within 60 s; reset on
        // manual refresh() so post-session data always appears immediately.
        //
        // limit: 50 for short views (covers any realistic day), 500 for multi-day.
        // Non-fatal: falls back to [] so the BG pipeline is never blocked.
        (() => {
          const now = Date.now();
          if (
            now - lastActivityHistoryFetchMs.current < ACTIVITY_HISTORY_MIN_INTERVAL_MS &&
            lastActivityHistoryResult.current !== undefined
          ) {
            if (debug) {
              console.log(
                '[useActiveEffects] 📋 activityHistory cache hit — reusing, next fetch in',
                Math.ceil((ACTIVITY_HISTORY_MIN_INTERVAL_MS - (now - lastActivityHistoryFetchMs.current)) / 1000), 's'
              );
            }
            return Promise.resolve({ data: lastActivityHistoryResult.current });
          }
          lastActivityHistoryFetchMs.current = now;
          const histLimit = windowHours > 24 ? 500 : 50;
          if (debug) {
            console.log(
              `[useActiveEffects] activityHistory FETCH — windowHours=${windowHours}` +
              ` start=${startISO} end=${endISO} limit=${histLimit}`
            );
          }
          return apiClient.get(API.ACTIVITIES.HISTORY, {
            params: {
              start_time: startISO,   // FIX: was start_date — backend rejects that with 400
              end_time:   endISO,     // FIX: was end_date
              limit:      histLimit,
            },
          }).catch((err) => {
            console.warn('[useActiveEffects] activityHistory fetch failed:', err?.response?.status, err?.message);
            return null;
          });
        })(),
      ]);

      // ── DEBUG: log full response structure so we can see the shape ─────────
      if (debug) {
        console.log('[useActiveEffects] mealsRes.data shape:',
          JSON.stringify(mealsRes.data).slice(0, 300));
        console.log('[useActiveEffects] insulinRes.data shape:',
          JSON.stringify(insulinRes.data).slice(0, 300));
      }

      if (debug && activityPDRes) {
        console.log('[useActiveEffects] 🏃 activityPD response:',
          JSON.stringify(activityPDRes.data).slice(0, 300));
      }

      // ── Extract meals ──────────────────────────────────────────────────────
      // FIX (Bug C): replaced ?? chain with pickResponseArray().
      // `??` does NOT skip empty arrays — if any named key resolves to []
      // the chain stops there and never reaches the numeric-keyed root object.
      // pickResponseArray() explicitly skips empty-array candidates and falls
      // back to numeric-key extraction on the root, handling all known shapes:
      //   { meals: [...] }  |  { "0":{}, "1":{} }  |  [...]  |  { data: [], "0":{} }
      const fetchedMeals: Meal[] = pickResponseArray<Meal>(
        mealsRes.data,
        ['meals', 'meal_list', 'data', 'items', 'results'],
      );

      // ── Extract insulin doses ──────────────────────────────────────────────
      const rawDoses: InsulinDose[] = pickResponseArray<InsulinDose>(
        insulinRes.data,
        ['insulin_logs', 'insulinDoses', 'doses', 'data', 'items', 'results', 'logs'],
      );

      // ── Normalise dose field names ─────────────────────────────────────────
      // The backend returns { taken_at, medication, dose } but the stacking
      // functions (calculateStackedInsulinEffect, calculateInsulinCumulativeEffect)
      // look for { administrationTime, insulinType, units }.
      // Without this step both fields are `undefined` for every dose, so
      // activeDoses is always 0 and IOB / cumulative insulin effect are always 0.
      const normalisedDoses: InsulinDose[] = rawDoses.map((d: any) => ({
        ...d,
        // Resolve administrationTime from whichever field the backend sent
        administrationTime: d.administrationTime ?? d.taken_at ?? d.takenAt ?? null,
        // Resolve insulinType from whichever field the backend sent
        insulinType: d.insulinType ?? d.insulin_type ?? d.medication ?? 'regular_insulin',
        // Resolve units — calculation functions prefer `units` over `dose`
        units: d.units ?? d.dose ?? 0,
      }));

      // ── Filter to relevant window ──────────────────────────────────────────
      // The API returns every dose ever logged (oldest was 345 hours ago).
      //
      // Two boundaries determine relevance:
      //
      // 1. IOB lookback (48h from T1D_BG_CONSTANTS).
      //    Long-acting insulins can be active for up to 42h (degludec), 31h
      //    (glargine U300), 23.5h (glargine). A flat 24h cutoff silently drops
      //    doses that are still pharmacologically active. We use the constant
      //    already defined for this purpose: iob_lookback_hours = 48.
      //
      // 2. Daily reset boundary (lastResetMs).
      //    Doses before the last reset cannot contribute to the current day's
      //    cumulative baseline regardless of how long-acting they are — the
      //    reset defines "today's" accounting window. This is timezone-aware:
      //    at 6:59 AM with a 7 AM reset, lastResetMs is yesterday 7 AM (≈23h
      //    ago), not midnight.
      //
      // We keep doses that pass EITHER boundary — i.e. the earlier cutoff wins.
      // This means: keep if (doseMs >= iobCutoffMs) OR (doseMs >= lastResetMs).
      // Equivalently: drop only if doseMs < BOTH cutoffs.
      //
      // Downstream cumulative-effects.ts already applies the reset filter
      // internally, so pre-reset doses that slip through the IOB window are
      // still correctly excluded from today's baseline calculation.
      //
      // NOTE: For multi-day chart views the caller passes windowHours > 48, so
      // insulinDays covers the full range. We still apply the IOB/reset filter
      // here to avoid accumulating stale doses in the calculation arrays, but
      // the chart's allDosesInWindow filter in EffectsVisualizationChart uses
      // rangeStart (the chart's left edge) as its lower bound, so historical
      // chart points correctly see doses from their own daily windows.
      const iobLookbackHours = 48; // T1D_BG_CONSTANTS.iob_lookback_hours
      const iobCutoffMs = currentTime.getTime() - iobLookbackHours * 60 * 60 * 1000;

      // Compute lastResetMs using the patient's actual reset hour + timezone.
      // Falls back to constants defaults if not yet loaded.
      const resetHour   = constants?.daily_reset_hour ?? 7;
      const tzOffset    = (constants as any)?.timezone_offset_minutes ?? 0;
      const offsetMs    = tzOffset * 60 * 1000;
      const localNow    = new Date(currentTime.getTime() + offsetMs);
      const localReset  = new Date(localNow);
      localReset.setUTCHours(resetHour, 0, 0, 0);
      if (localNow.getTime() < localReset.getTime()) {
        localReset.setUTCDate(localReset.getUTCDate() - 1);
      }
      const lastResetMs = localReset.getTime() - offsetMs;

      const fetchedDoses: InsulinDose[] = normalisedDoses.filter((d: any) => {
        const ts = d.administrationTime;
        if (!ts) return false;
        const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
        const doseMs = hasZone
          ? new Date(ts).getTime()
          : new Date(ts.replace(' ', 'T') + 'Z').getTime();
        if (isNaN(doseMs)) return false;

        // Visualization charts (skipIobCutoff=true) re-filter doses per chart
        // point using cumulativeWindowStart, so the 48h pre-filter here is
        // redundant and harmful for multi-day views — skip it entirely.
        //
        // Live display (skipIobCutoff=false, the default) must keep both
        // boundaries so estimatedBG / IOB only reflect active pharmacology.
        if (skipIobCutoff) return true;

        // Keep if within IOB lookback window OR within today's reset window
        return doseMs >= iobCutoffMs || doseMs >= lastResetMs;
      });

      if (debug && normalisedDoses.length !== fetchedDoses.length) {
        console.log(
          `[useActiveEffects] 🗑️ Dropped ${normalisedDoses.length - fetchedDoses.length} stale dose(s)` +
          ` (kept ${fetchedDoses.length}${skipIobCutoff ? ' — IOB cutoff skipped (chart mode)' : ` within ${iobLookbackHours}h IOB window or today's reset window`})`
        );
      }

      // ── Normalise reading to GlucoseReading shape ───────────────────────────
      // The backend API returns readings with `bloodSugar` and `bloodSugarTimestamp`
      // (or `timestamp`) fields, but calculateStableBaselineFromReading() expects:
      //   - reading.value      (number  — the BG value in mg/dL)
      //   - reading.timestamp  (number  — UTC milliseconds)
      //
      // Without this normalisation:
      //   reading.value === undefined  →  readingValue = NaN
      //   NaN - cumulativeNetEffect   = NaN  →  stableBaseline = NaN
      //   NaN ?? fallback             = NaN  (not caught by ??)
      //   baseBG = NaN  →  SVG path: "M56,NaN..."  →  chart broken
      //
      // ✅ FIX: Explicitly resolve both field variants here before storing.
      function normaliseReading(r: any): any | null {
        if (!r) return null;
        const rawTs = r.bloodSugarTimestamp ?? r.timestamp ?? r.readingTime ?? r.reading_time ?? r.taken_at ?? null;
        const tsMs = (typeof rawTs === 'number' && isFinite(rawTs))
          ? rawTs
          : rawTs
            ? (() => {
                const hasZone = String(rawTs).endsWith('Z') || String(rawTs).includes('+') || /T.*-\d{2}:\d{2}$/.test(String(rawTs));
                return hasZone ? new Date(rawTs).getTime() : new Date(String(rawTs).replace(' ', 'T') + 'Z').getTime();
              })()
            : NaN;
        const bgValue = r.bloodSugar ?? r.blood_sugar ?? r.value ?? r.glucose_value ?? NaN;
        if (isNaN(tsMs) || isNaN(Number(bgValue))) return null;
        return {
          ...r,
          value:     Number(bgValue),    // field expected by calculateStableBaselineFromReading
          timestamp: tsMs,               // UTC ms — expected by getDoseTimestamp / getMealTimestamp
          bloodSugar: Number(bgValue),   // keep for downstream consumers
        };
      }

      const fetchedReading: GlucoseReading | null =
        normaliseReading(
          readingRes?.data?.reading ??
          readingRes?.data?.readings?.[0] ??
          (Array.isArray(readingRes?.data) ? readingRes.data[0] : null) ??
          null
        );

      // ── Extract activity PD result ─────────────────────────────────────────
      // Defensively validate the response so a malformed payload never breaks
      // the calculation pipeline.  null means "no activity effect this window".
      const fetchedActivityPD: ActivityPDResult | null = (() => {
        const d = activityPDRes?.data;
        if (!d || typeof d !== 'object') return null;
        // Must have at least the three key numeric fields
        if (
          typeof d.cumulative_activity_effect !== 'number' ||
          typeof d.sensitivity_multiplier     !== 'number' ||
          typeof d.activity_on_board          !== 'number'
        ) return null;
        return d as ActivityPDResult;
      })();

      // Update the debounce cache so subsequent calls within 30 s serve this result.
      lastActivityPDResult.current = fetchedActivityPD;

      // ── Extract activity history records (ALL views) ─────────────────────
      // FIX: removed windowHours <= 24 guard — history is fetched for all views.
      //
      // FIX (source dedup): /api/activity-history can return multiple `completed`
      // records for the same physical session — e.g. one per watch-sync event,
      // one per manual edit, one per correction.  Each passes the type filter and
      // each becomes a separate synthetic ActivityContribution in EVC, multiplying
      // the green cumulative line by the duplicate count (7× overstatement observed).
      //
      // Root cause diagnosis:
      //   • The EVC Fix-A id-dedup never worked: `rec.id` (history record ObjectId)
      //     is a DIFFERENT MongoDB document from `activity_id` in the ODE response
      //     (which is the linked activity ObjectId).  Set.has() always returns false.
      //   • Fix-B (time+duration dedup in mergedActivityContributions) is the correct
      //     guard but only runs AFTER the synthetic array is built from the duplicates.
      //
      // Definitive fix: deduplicate here at the source before the array leaves the
      // hook.  Key = (startMs rounded to nearest minute) + ":" + durationMinutes.
      // This is the same key used by EVC Fix-B so both layers agree on what
      // constitutes "the same session".  Belt-and-suspenders: EVC Fix-B is kept.
      const fetchedActivityHistory: ActivityHistoryResponse[] = (() => {
        if (!activityHistoryRes?.data) {
          if (debug) console.warn('[useActiveEffects] activityHistory: response null/empty — returning []');
          return [];
        }
        const raw = activityHistoryRes.data;
        if (debug) console.log('[useActiveEffects] activityHistory raw shape:', JSON.stringify(raw).slice(0, 300));
        // Backend may return { activities: [...] }, { data: [...] } or a bare array
        const arr = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.activities)
            ? raw.activities
            : Array.isArray(raw?.data)
              ? raw.data
              : [];
        const completed = arr.filter((r: any) => r?.type === 'completed');

        if (debug) {
          console.log(
            `[useActiveEffects] activityHistory: ${arr.length} total, ` +
            `${completed.length} completed (before source dedup)`
          );
          completed.forEach((r: any, i: number) => {
            console.log(
              `[useActiveEffects]   record[${i}]: id=${r.id} ` +
              `start=${r.startTime ?? r.completedTime ?? r.timestamp} ` +
              `duration=${r.duration ?? r.duration_minutes} ` +
              `level=${r.level} intensity=${r.intensity}`
            );
          });
        }

        // ── SOURCE DEDUP: (startMs rounded to minute, durationMinutes) ────────
        // Keep the FIRST record for each key (assumed to be the authoritative one).
        // Subsequent records for the same session are watch-sync events / edits.
        const seen = new Set<string>();
        const deduped = completed.filter((r: any) => {
          const startMs = _parseUTCMsHook(
            r.startTime ?? r.completedTime ?? r.timestamp
          );
          if (isNaN(startMs)) return true; // unparseable — keep, downstream will skip
          const dur = _parseDurMinHook(r.duration ?? r.duration_minutes);
          const key = `${Math.round(startMs / 60_000)}:${dur}`;
          if (seen.has(key)) {
            if (debug) {
              console.warn(
                `[useActiveEffects] activityHistory source-dedup: dropped duplicate record ` +
                `id=${r.id} start=${r.startTime ?? r.timestamp} dur=${dur} key=${key}`
              );
            }
            return false;
          }
          seen.add(key);
          return true;
        });

        if (debug) {
          console.log(
            `[useActiveEffects] activityHistory: ${deduped.length} after source dedup ` +
            `(dropped ${completed.length - deduped.length} duplicate(s))`
          );
          if (deduped[0]) {
            console.log(
              `[useActiveEffects]   first kept: id=${deduped[0].id} ` +
              `start=${(deduped[0] as any).startTime ?? (deduped[0] as any).timestamp}`
            );
          }
        }

        return deduped;
      })();

      // ── Update activity history cache ──────────────────────────────────────
      // Must happen after extraction so the next call within the TTL can serve
      // this result from lastActivityHistoryResult.current instead of refetching.
      lastActivityHistoryResult.current = fetchedActivityHistory;

      if (debug) {
        if (fetchedActivityPD) {
          console.log('[useActiveEffects] 🏃 Activity PD:', {
            cumulative_activity_effect: fetchedActivityPD.cumulative_activity_effect,
            sensitivity_multiplier:     fetchedActivityPD.sensitivity_multiplier,
            activity_on_board:          fetchedActivityPD.activity_on_board,
            active_sessions:            fetchedActivityPD.active_sessions,
          });
        } else {
          console.log('[useActiveEffects] 🏃 Activity PD: no data (no sessions or fetch failed)');
        }
      }

      // Warn with full shape to diagnose extraction failures
      if (fetchedMeals.length === 0) {
        console.warn('[useActiveEffects] ⚠️ fetchedMeals is EMPTY.',
          'mealsRes.data keys:', Object.keys(mealsRes.data ?? {}).slice(0, 15),
          'fetchedMeals type:', typeof fetchedMeals, Array.isArray(fetchedMeals) ? '(array)' : '');
      }
      if (fetchedDoses.length === 0) {
        console.warn('[useActiveEffects] ⚠️ fetchedDoses is EMPTY.',
          'insulinRes.data keys:', Object.keys(insulinRes.data ?? {}).slice(0, 15),
          'fetchedDoses type:', typeof fetchedDoses, Array.isArray(fetchedDoses) ? '(array)' : '');
      }

      // Debug-only verbose block (debug: false in production)
      if (debug) {
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] 📊 DATA FETCH COMPLETE');
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] Fetched meals:', fetchedMeals.length);
        console.log('[useActiveEffects] Fetched doses:', fetchedDoses.length);
        console.log('[useActiveEffects] Latest reading:', fetchedReading?.bloodSugar || 'none');

        console.log('');
        console.log('[useActiveEffects] 🔍 MEAL CARB EXTRACTION DEBUG:');
        fetchedMeals.forEach((meal: Meal, idx: number) => {
          debugMealCarbs(meal, idx);
        });

        const totalCarbs = fetchedMeals.reduce((sum: number, meal: Meal) =>
          sum + getTotalCarbsFromMeal(meal), 0
        );

        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] 📈 TOTAL CARBS ACROSS ALL MEALS:', totalCarbs, 'g');

        if (totalCarbs === 0 && fetchedMeals.length > 0) {
          console.error('[useActiveEffects] ⚠️ CRITICAL: ALL MEALS HAVE ZERO CARBS!');
          console.error('[useActiveEffects] This will cause all calculations to return 0.');
          setCalculationErrors(prev => [...prev, 'All meals have zero carbs']);
        }
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
      }

      // ── ATOMIC UPDATE ────────────────────────────────────────────────────
      // All four pieces of data land in one setState call so React batches
      // them into a single re-render. The useEffect below watches `fetchedData`
      // and only fires calculateEffects() once, with a coherent snapshot.
      // Previously these were three separate setStates, causing calculateEffects
      // to run after each one — e.g. meals populated but doses still [], which
      // produced estimatedBG = baseline + (−full insulin effect) = −67 mg/dL.
      setFetchedData({
        meals:      fetchedMeals,
        doses:      fetchedDoses,
        reading:    fetchedReading,
        activityPD: fetchedActivityPD,
        activityHistory: fetchedActivityHistory,
        ready:      true,
      });

      // Release the spinner when there is genuinely no data to calculate with.
      if (fetchedMeals.length === 0 && fetchedDoses.length === 0 && !fetchedReading) {
        setIsLoading(false);
        setLastUpdate(new Date());
      }

      return { meals: fetchedMeals, doses: fetchedDoses, reading: fetchedReading, activityPD: fetchedActivityPD, activityHistory: fetchedActivityHistory };
    } catch (err) {
      console.error(`[${instanceIdRef.current}] ❌ Error fetching data:`, err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setCalculationErrors(prev => [...prev, 'Data fetch failed']);
      return null;
    } finally {
      // Fix A: always release the in-flight guard so the next scheduled
      // interval tick or manual refresh() can proceed normally.
      fetchInFlightRef.current = false;
      if (debug) console.log(`[${instanceIdRef.current}] ✅ fetchData DONE reason=${reason}`);
    }
  // ── BUG FIX: windowHours was missing from the dep array. ────────────────────
  // fetchData previously closed over the INITIAL windowHours=24 permanently,
  // so even if EffectsVisualizationChart passed pastHours=168 for the week
  // view, the API always fetched only the last 32h of meals and doses.
  // Historical chart points (e.g. 18/02 on a 7-day view) had no data in
  // rawMeals, so allMealsUpToNow was always empty → cumulativeNetBaseline = 0.
  // Adding windowHours to the dep array ensures fetchData is recreated and
  // re-runs whenever the caller changes the fetch window.
  }, [token, debug, windowHours]);

  /**
   * Perform all calculations with enhanced debugging
   */
  const calculateEffects = useCallback(async () => {
    if (!constants || constantsLoading) {
      if (debug) {
        console.log(`[${instanceIdRef.current}] ⏳ Waiting for constants...`);
      }
      return;
    }

    // Throttle to once per minute — BUT bypass when baseline_mode just changed
    // so the new mode takes effect immediately instead of waiting up to 59 s.
    const currentMinute = Math.floor(Date.now() / 60000);
    const modeJustChanged = (constants as any)?.baseline_mode !== lastBaselineModeRef.current;
    if (modeJustChanged) {
      // Record the new mode so the next call within the same minute doesn't
      // bypass the throttle again (avoids redundant back-to-back runs).
      lastBaselineModeRef.current = (constants as any)?.baseline_mode;
      // Reset the throttle clock so this run is not counted against the minute
      // bucket — the next regular poll will still fire on time.
      lastCalculationMinute.current = 0;
    } else if (currentMinute === lastCalculationMinute.current) {
      if (debug) {
        console.log('[useActiveEffects] 🚫 Calculation throttled (same minute)');
      }
      return;
    }
    lastCalculationMinute.current = currentMinute;

    try {
      setIsLoading(true);
      setError(null);
      // FIX: Avoid creating a new empty array reference if errors are already
      // cleared — useState bails out only on primitive equality, so [] !== []
      // always triggers a re-render even when there's nothing to clear.
      setCalculationErrors(prev => (prev.length === 0 ? prev : []));
      setUsingBackend(false);

      const currentTime = new Date();

      if (debug) {
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] 🔬 STARTING CALCULATIONS');
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] Current time:', currentTime.toISOString());
        console.log('[useActiveEffects] Meals to process:', meals.length);
        console.log('[useActiveEffects] Doses to process:', insulinDoses.length);
        console.log('[useActiveEffects] Has reading:', !!latestReading);
        console.log('[useActiveEffects] Constants loaded:', !!constants);
        console.log('[useActiveEffects] Activity sessions:', activityPD?.active_sessions ?? 0,
          '| effect:', activityPD?.cumulative_activity_effect ?? 0, 'mg/dL',
          '| sensitivity ×', activityPD?.sensitivity_multiplier ?? 1.0);
      }

      // 1. Calculate baseline
      // ── Stable baseline (mode-aware) ─────────────────────────────────────────
      const resolvedMode: 'dynamic' | 'preset' =
        ((constants as any)?.baseline_mode === 'preset') ? 'preset' : 'dynamic';

      let baseline: BaselineResult | null = null;
      try {
        if (resolvedMode === 'preset') {
          // ── Preset: circadian profile lookup at current local hour ──
          if (debug) {
            console.log('[useActiveEffects] 📊 Calculating baseline from circadian profile (preset mode)...');
          }

          const tzOffsetMin = (constants as any)?.timezone_offset_minutes ?? 0;
          const localHour = (
            currentTime.getUTCHours() +
            currentTime.getUTCMinutes() / 60 +
            currentTime.getUTCSeconds() / 3600 +
            tzOffsetMin / 60
          ) % 24;

          const circadianBG = getCircadianBaseline(
            localHour,
            (constants as any)?.circadian_profile as CircadianProfile | undefined
          );

          baseline = {
            stableBaseline: circadianBG,
            baselineMode: 'preset',
            readingValue: latestReading?.value ?? circadianBG,
            readingTimestamp: null,
            cumulativeMealEffect: 0,
            cumulativeInsulinEffect: 0,
            cumulativeNetEffect: latestReading != null
              ? latestReading.value - circadianBG
              : 0,
            mealsCount: meals.length,
            insulinCount: insulinDoses.length,
            confidence: 1.0,
            warnings: [],
          } as unknown as BaselineResult;

          if (debug) {
            console.log('[useActiveEffects] 🌙 Preset baseline', {
              hourFloat: localHour.toFixed(2),
              presetValue: circadianBG,
              readingDelta: (baseline as any).cumulativeNetEffect,
            });
          }

        } else if (latestReading) {
          // ── Dynamic mode: back-calculate from the most recent reading ──
          if (debug) {
            console.log('[useActiveEffects] 📊 Calculating baseline from reading (dynamic mode)...');
          }

          try {
            const rawBaselineResult = calculateStableBaselineFromReading(
              latestReading,
              meals,
              insulinDoses,
              currentTime,
              constants,
              MEAL_ABSORPTION_PROFILES,
              constants.daily_reset_hour || 7,
              constants.timezone_offset_minutes || 0
            );

            // ── Hard-clamp baseline to physiological limits ──────────────────
            // Clamps values < 55 or > 220 mg/dL and emits a CRITICAL warning.
            // Does NOT do soft blending — values inside the hard bounds pass through unchanged.
            const sanitized = sanitizeBaseline(rawBaselineResult.stableBaseline);
            if (sanitized.warnings.length > 0) {
              console.warn('[useActiveEffects] ⚠️ Baseline clamped:', sanitized);
              setBaselineWarnings(sanitized.warnings);
              setBaselineSanitizeStatus(sanitized.status);
            } else {
              setBaselineWarnings([]);
              setBaselineSanitizeStatus('ok');
            }

            baseline = {
              ...rawBaselineResult,
              stableBaseline: sanitized.value,
              warnings: [...(rawBaselineResult.warnings ?? []), ...sanitized.warnings],
            };

            if (debug) {
              console.log('[useActiveEffects] 📍 Dynamic baseline', {
                stableBaseline: baseline?.stableBaseline,
                readingValue:   baseline?.readingValue,
                cumulativeNet:  (baseline as any)?.cumulativeNetEffect,
              });
            }
          } catch (err) {
            console.error('[useActiveEffects] ❌ Dynamic baseline failed:', err);
            setCalculationErrors(prev => [...prev, 'Dynamic baseline failed']);
          }
        } else {
          if (debug) {
            console.log('[useActiveEffects] ⚠️ Dynamic mode but no reading available — baseline will be null');
          }
        }

        setBaselineDetails(baseline);
      } catch (err) {
        console.error('[useActiveEffects] ❌ Baseline calculation failed:', err);
        setCalculationErrors(prev => [...prev, 'Baseline calculation failed']);
      }

      // 2. Calculate net effect
      let netEffect: NetEffectResult | null = null;
      try {
        if (debug) {
          console.log('[useActiveEffects] 📊 Calculating net effect...');
        }

        // ── FIX (Goal 3): Do NOT pass activityPD to the wrapper here. ──────────
        // The net-effect.ts wrapper adds the FULL cumulativeActivityEffect to
        // estimatedBG. But calculateStableBaselineFromReading() (dynamic mode)
        // unwinds meal/insulin effects at the reading timestamp without unwinding
        // the activity effect — so activityEffectAtReading is already baked into
        // the reading value, and therefore into stableBaseline.
        //
        // Adding the full cumulativeActivityEffect would double-count the portion
        // that was already delivered when the reading was taken.
        //
        // Correct formula (mirrors ActiveEffectsDisplay):
        //   estimatedBG += activityDeltaSinceReading
        //                = cumulativeActivityEffect − activityEffectAtReading
        //
        // This means: only the activity change AFTER (or before) the reading
        // contributes to the BG estimate. If the patient exercised before their
        // last reading, delta ≈ 0 (effect already in the reading). If they started
        // a session after the reading, delta = full new effect.
        netEffect = calculateNetEffect(
          baseline,
          meals,
          insulinDoses,
          currentTime,
          constants,
          MEAL_ABSORPTION_PROFILES,
          // activityPD intentionally NOT passed — applied manually below as a delta
        );

        // ── Dynamic mode: apply activity delta + fix projectedFinalBG ────────
        if (resolvedMode === 'dynamic' && netEffect) {
          const baseCorrFactor = constants.correction_factor ?? 40;
          const baseCarbFactor = (constants as any)?.carb_to_bg_factor
                               ?? (constants as any)?.carb_to_bg_ratio ?? 4;

          const sensitivityMultiplier = activityPD?.sensitivity_multiplier ?? 1.0;
          const cumulativeActivityEffect = activityPD?.cumulative_activity_effect ?? 0;

          // ── Compute the daily reset boundary for the activity delta guard ──
          const _resetHour = constants.daily_reset_hour ?? 7;
          const _tzOffset  = constants.timezone_offset_minutes ?? 0;
          const _offsetMs  = _tzOffset * 60_000;
          const _localNow  = new Date(currentTime.getTime() + _offsetMs);
          const _localReset = new Date(_localNow);
          _localReset.setUTCHours(_resetHour, 0, 0, 0);
          if (_localNow.getTime() < _localReset.getTime()) {
            _localReset.setUTCDate(_localReset.getUTCDate() - 1);
          }
          const _lastResetMs = _localReset.getTime() - _offsetMs;

          // How much activity effect was already in the reading (lock-in model).
          // Zero when there is no reading (latestReading is null) — in that case
          // we have no baseline to unwind from, so the full effect is new.
          //
          // Bug 2 fix: pass readingMs as the 4th `nowMs` arg so the back-scaling
          // denominator is locked at the reading moment, not Date.now().
          // Without this, the ramp fraction is computed against the current elapsed
          // time rather than the elapsed time when the reading was taken, producing
          // a wrong activityEffectAtReading and a phantom offset in the BG estimate.
          // Mirrors the identical fix already applied in ActiveEffectsDisplay.tsx:880–885.
          const activityEffectAtReading = latestReading?.timestamp
            ? calculateActivityEffectForCumulative(
                latestReading.timestamp as number,
                activityPD?.activity_contributions ?? [],
                _lastResetMs,
                latestReading.timestamp as number,  // Bug 2 fix: lock denominator at reading moment
              )
            : 0;

          // Only add the portion of the activity effect that occurred AFTER
          // (or before) the reading — the rest is already in stableBaseline.
          const activityDeltaSinceReading = cumulativeActivityEffect - activityEffectAtReading;

          // Use effective (sensitivity-adjusted) factors when post-exercise GLUT4 is active
          const effectiveCorrFactor = (sensitivityMultiplier > 1.0 && activityPD?.effective_correction_factor)
            ? activityPD.effective_correction_factor
            : baseCorrFactor;
          const effectiveCarbFactor = (sensitivityMultiplier > 1.0 && activityPD?.effective_carb_to_bg_ratio)
            ? activityPD.effective_carb_to_bg_ratio
            : baseCarbFactor;

          // Activity-corrected estimatedBG (delta only — no double-count).
          const activityAdjustedBG = (netEffect.estimatedBG ?? 0) + activityDeltaSinceReading;

          // Rebuild projectedFinalBG from the corrected base + pending-only IOB/MOB.
          //
          // Bug 3 fix: subtract activityOnBoard (the remaining lock-in ramp direct drop)
          // from pendingNetEffect. AOB is BG-lowering that will arrive after now —
          // structurally identical to pending IOB and must be included in the projection.
          const aob_dynamic = activityPD?.activity_on_board ?? 0;
          const pendingNetEffect   = (netEffect.totalMOB ?? 0) * effectiveCarbFactor
                                   - (netEffect.totalIOB ?? 0) * effectiveCorrFactor
                                   - aob_dynamic;             // Bug 3 fix: deduct pending AOB
          const correctedProjected = activityAdjustedBG + pendingNetEffect;

          if (debug) {
            console.log('[useActiveEffects] 🩺 Dynamic: activity delta applied', {
              cumulativeActivityEffect,
              activityEffectAtReading,
              activityDeltaSinceReading,
              estimatedBG_before:  netEffect.estimatedBG,
              estimatedBG_after:   activityAdjustedBG,
              sensitivityMultiplier,
              effectiveCorrFactor,
              effectiveCarbFactor,
              pendingNetEffect,
              correctedProjected,
            });
          }

          netEffect = {
            ...netEffect,
            estimatedBG:      activityAdjustedBG,
            projectedFinalBG: correctedProjected,
          } as NetEffectResult;
        }

        // ── Preset mode correction ──────────────────────────────────────────────
        // calculateNetEffect receives a preset baseline whose cumulativeMealEffect
        // and cumulativeInsulinEffect are both zeroed (preset baselines carry no
        // reading to back-calculate from).  This causes:
        //
        //   estimatedBG      = circadianBG + 0          ← meals/insulin ignored
        //   projectedFinalBG = circadianBG + pendingOnly ← anchored to wrong base
        //   cumulativeMealEffect/InsulinEffect           ← both show 0 to callers
        //
        // Fix: run the Phase 3-fixed calculateTotalCumulativeEffects (imported
        // from @/utils/calculations, NOT from blood-glucose-estimation) to get the
        // real absorbed-PK cumulative, then overwrite the stale fields.
        //
        // ⚠️  IMPORTANT — must use the @/utils/calculations version:
        //   blood-glucose-estimation's version lacks the Phase 3 "persist-at-100%"
        //   behaviour.  For meals/doses past their absorption duration it returns 0,
        //   making correctedEstimatedBG = circadianBG (ignores the finished meal).
        //   The fixed version persists totalCarbs × carbToBgFactor until the
        //   daily reset, matching the backend and ActiveEffectsDisplay.
        //
        // FIX: Compute the pending BG delta directly from netEffect.totalIOB /
        // netEffect.totalMOB rather than extracting it from calculateNetEffect's
        // raw projectedFinalBG.
        //
        // WHY the old approach was wrong in preset mode
        // ─────────────────────────────────────────────
        // The preset baseline carries:
        //   cumulativeNetEffect = latestReading.value − circadianBG  (e.g. 130 − 87 = +43)
        // calculateNetEffect bakes this offset into its internal estimatedBG:
        //   netEffect.estimatedBG = circadianBG + 43 = 130
        // calculateNetEffect then computes projectedFinalBG using the FULL initial
        // dose size (e.g. 0.52 u) rather than just the active IOB fraction (0.11 u):
        //   projectedFinalBG = 130 − (0.52 × 40) = 109
        //   pendingDelta     = 109 − 130 = −20.8      ← wildly inflated
        //   correctedProjected = 38 + (−20.8) = 17 ❌  (should be ~34)
        //
        // The comment "pendingDelta is independent of the baseline's cumulative fields"
        // was incorrect: the reading-based offset in cumulativeNetEffect leaks through
        // netEffect.estimatedBG and inflates the extracted pendingDelta.
        //
        // FIX: build pendingNetEffect directly from the correctly active-only IOB/MOB
        // fractions that calculateNetEffect exposes on its return value.  This matches
        // the backend formula and CalculationComparison.tsx:
        //   pending_net_effect = totalMOB × carbFactor − totalIOB × corrFactor
        //
        // Example: 0 × 4 − 0.11 × 40 = −4.4 → correctedProjected = 38 − 4.4 = 33.6 ✅
        if (resolvedMode === 'preset' && netEffect) {
          const resetHour = constants.daily_reset_hour ?? 7;
          const tzOffset  = constants.timezone_offset_minutes ?? 0;

          // Activity terms — scoped locally here; dynamic mode reads them
          // from the net-effect.ts wrapper return value instead.
          const cumulativeActivityEffect = activityPD?.cumulative_activity_effect ?? 0;
          const sensitivityMultiplier    = activityPD?.sensitivity_multiplier    ?? 1.0;

          // ── Activity sensitivity overrides for Phase 1/2 absorption (v4.12 fix) ──
          //
          // The v4.12 fix in cumulative-effects.ts corrected the Phase 2→3 boundary
          // step by clamping the Phase 3 entry so it is never less negative (insulin)
          // or less positive (meal) than where Phase 2 left off.  The clamp is:
          //
          //   insulin:  Math.min(phase3, phase2Exit)
          //     phase3    = -(doseAmount × baseCF)
          //     phase2Exit = -(doseAmount × effectiveCF)          ← effectiveCF > baseCF
          //   meal:     Math.min(phase3, phase2Exit)  [both positive]
          //     phase3    = totalCarbs × baseC2B
          //     phase2Exit = totalCarbs × effectiveC2B            ← effectiveC2B < baseC2B
          //
          // For the clamp to fire correctly at the boundary, the Phase 2 absorption
          // branch must receive the same boosted CF / reduced C2B that was applied
          // during the session.  Without these overrides, both phase2Exit values
          // collapse to the base values, the clamp becomes a no-op, and any dose
          // or meal still absorbing at session end reverts to the pre-fix behaviour.
          //
          // Gate: use a flat binary window (sensitivityMultiplier > 1.005) rather
          // than a continuously-decaying time-varying multiplier.  This matches the
          // v4.11 / EVC pattern: the boosted absorption happened at the boosted rate
          // and is locked in for the duration of the sensitivity window; it should
          // not be retroactively un-applied as the W-state decays.
          //
          // For the "pkCumulative at currentTime" call, activityPD.sensitivity_multiplier
          // is the authoritative live scalar from the API — equivalent to what EVC's
          // calculateFlatWindowMultiplier returns at targetMs = Date.now().
          // We use the API-provided effective_correction_factor / effective_carb_to_bg_ratio
          // when available (pre-multiplied by backend), falling back to manual scaling.
          const baseCF  = constants.correction_factor ?? 40;
          const baseC2B = (constants as any)?.carb_to_bg_factor
                        ?? (constants as any)?.carb_to_bg_ratio ?? 4;

          const effectiveCFForCumulative: number | undefined =
            sensitivityMultiplier > 1.005
              ? (activityPD?.effective_correction_factor ?? baseCF * sensitivityMultiplier)
              : undefined;

          const effectiveC2BForCumulative: number | undefined =
            sensitivityMultiplier > 1.005
              ? (activityPD?.effective_carb_to_bg_ratio ?? baseC2B / sensitivityMultiplier)
              : undefined;

          // ✅ Phase 3-fixed cumulative (from @/utils/calculations)
          // effectiveCFForCumulative and effectiveC2BForCumulative are forwarded to
          // Phase 1/2 of each item's absorption so that:
          //   • In-flight insulin absorbs at boosted CF  → more negative contribution
          //   • In-flight meals absorb at reduced C2B    → smaller positive contribution
          // Phase 3 (fully absorbed, persist-at-100%) ignores both overrides and
          // always uses base CF / base C2B — matching the v4.5 / v4.6 invariant.
          const pkCumulative = calculateTotalCumulativeEffects(
            meals,
            insulinDoses,
            currentTime,
            constants,
            MEAL_ABSORPTION_PROFILES,
            resetHour,
            tzOffset,
            undefined,                  // activities — added manually below (double-count guard)
            effectiveCFForCumulative,   // Phase 1/2 insulin: boosted CF during sensitivity window
            effectiveC2BForCumulative,  // Phase 1/2 meals:   reduced C2B during sensitivity window
          );

          const stableBaseline = baseline?.stableBaseline ?? (constants.target_glucose ?? 100);

          // ── Activity term: add to correctedEstimatedBG ───────────────────
          let correctedEstimatedBG = stableBaseline
                                   + pkCumulative.cumulativeNetBaseline
                                   + cumulativeActivityEffect;

          // ── Reading-residual correction (preset mode only) ────────────────
          // The pure-model estimate above is circadian@now + Σmeal/insulin@now
          // + activity.  If the patient's last real reading was lower (or higher)
          // than that model predicted at the reading moment, we apply that gap as
          // a constant offset so the estimate is anchored to the last measurement.
          //
          //   residual = reading − circadian@readingTime − cumul@readingTime
          //   correctedEstimatedBG += residual
          //
          // This mirrors the identical logic in ActiveEffectsDisplay.fetchAndCalculate()
          // (search for "readingResidual") so both components stay in sync.
          if (latestReading?.value != null && typeof latestReading.timestamp === 'number') {
            try {
              const readingMs   = latestReading.timestamp as number;
              const readingDate = new Date(readingMs);
              const localRead   = new Date(readingMs + tzOffset * 60_000);
              const readingHour = localRead.getUTCHours() + localRead.getUTCMinutes() / 60;

              const circadianAtReading = getCircadianBaseline(
                readingHour,
                (constants as any)?.circadian_profile as CircadianProfile | undefined
              );
              const cumulAtReading = calculateTotalCumulativeEffects(
                meals,
                insulinDoses,
                readingDate,
                constants,
                MEAL_ABSORPTION_PROFILES,
                resetHour,
                tzOffset,
                undefined,                  // activities — unwound separately via activityAtReadingTime
                // ── v4.12 fix: pass the same sensitivity overrides used for pkCumulative ──
                //
                // cumulAtReading is subtracted from the reading value to compute the
                // residual offset that anchors the model to the patient's last measurement:
                //
                //   readingResidual = reading − circadian@T_read − cumulAtReading − activityAtReading
                //
                // If the patient was inside a sensitivity window when the reading was
                // taken, the model at T_read should reflect the same boosted absorption
                // it used for pkCumulative at T_now — otherwise the two cumulative
                // estimates use inconsistent bases and the residual carries a phantom
                // offset equal to (effectiveCF − baseCF) × absorbedFraction × dose,
                // which is baked into correctedEstimatedBG as a permanent bias.
                //
                // Approximation: we use the CURRENT sensitivityMultiplier rather than
                // the multiplier that was active at T_read.  This is conservative and
                // correct in the common cases:
                //
                //   • Multiplier > 1.005 now  → exercise is recent; it was also active
                //     (or just beginning) at the reading moment → override is appropriate.
                //   • Multiplier ≤ 1.005 now  → window has closed; we pass undefined →
                //     base rates used for both calls → residual is self-consistent.
                //   • Edge case: reading taken mid-session but multiplier has since
                //     decayed → both calls use base → slight underestimate of residual,
                //     but the error is smaller than applying boosted rates to only one
                //     of the two calls.
                //
                // The activityAtReadingTime subtraction (FIX N-1 below) handles the
                // direct activity effect at T_read; these overrides handle only the
                // indirect effect on in-flight meal/insulin absorption at T_read.
                effectiveCFForCumulative,   // Phase 1/2 insulin at reading time
                effectiveC2BForCumulative,  // Phase 1/2 meals at reading time
              );

              // ── FIX N-1: subtract the activity effect that was already
              // delivered at the reading moment so it is not double-counted.
              //
              // Without this, correctedEstimatedBG over-corrects by exactly
              // activityAtReadingTime:
              //
              //   correctedEstimatedBG = circadian@now + pkCumNow + activityNow
              //     + (reading − circadian@readingTime − pkCumReading)
              //
              // The reading already reflects whatever exercise had occurred up
              // to that moment, so we must unwind that portion from the residual:
              //
              //   correct formula:
              //   correctedEstimatedBG = circadian@now + pkCumNow + activityNow
              //     + (reading − circadian@readingTime − pkCumReading − activityAtReading)
              //
              // calculateActivityEffectForCumulative is already imported (line 67).
              // _lastResetMs is computed from resetHour + tzOffset above, so we
              // derive it here using the same variables to stay in scope.
              const _resetOffsetMs  = tzOffset * 60_000;
              const _localNowForReset = new Date(readingMs + _resetOffsetMs);
              const _localResetPoint  = new Date(_localNowForReset);
              _localResetPoint.setUTCHours(resetHour, 0, 0, 0);
              if (_localNowForReset.getTime() < _localResetPoint.getTime()) {
                _localResetPoint.setUTCDate(_localResetPoint.getUTCDate() - 1);
              }
              const _lastResetMsForReading = _localResetPoint.getTime() - _resetOffsetMs;

              // Bug 5 fix: pass readingMs as the 4th `nowMs` arg so the back-scaling
              // denominator is locked at the reading moment, not Date.now().
              // Same pattern as Bug 2 fix in dynamic mode above, and matches the
              // fix already present in ActiveEffectsDisplay.tsx:880–885.
              const activityAtReadingTime = calculateActivityEffectForCumulative(
                readingMs,
                activityPD?.activity_contributions ?? [],
                _lastResetMsForReading,
                readingMs,   // Bug 5 fix: lock ramp denominator at reading moment
              );

              const readingResidual =
                (latestReading.value as number)
                - circadianAtReading
                - cumulAtReading.cumulativeNetBaseline
                - activityAtReadingTime;  // ← N-1 fix: prevents double-count

              correctedEstimatedBG += readingResidual;

              if (debug) {
                console.log('[useActiveEffects] 🌙 Preset: reading residual applied', {
                  readingValue:       latestReading.value,
                  circadianAtReading,
                  cumulAtReadingNet:  cumulAtReading.cumulativeNetBaseline,
                  readingResidual,
                  correctedEstimatedBG,
                });
              }
            } catch {
              // Bad timestamp — keep the raw model estimate; do not crash.
            }
          }

          // ✅ FIX: Compute pending delta directly from exposed IOB/MOB values.
          // Use sensitivity-adjusted factors when post-exercise GLUT4 is active.
          // baseCF / baseC2B are declared above alongside effectiveCFForCumulative
          // and effectiveC2BForCumulative — reused here to avoid duplicate declarations.
          const effectiveCorrFactor = (sensitivityMultiplier > 1.0 && activityPD?.effective_correction_factor)
            ? activityPD.effective_correction_factor
            : baseCF;
          const effectiveCarbFactor = (sensitivityMultiplier > 1.0 && activityPD?.effective_carb_to_bg_ratio)
            ? activityPD.effective_carb_to_bg_ratio
            : baseC2B;

          // Bug 3 fix: subtract activityOnBoard (the remaining lock-in ramp direct drop)
          // from pendingNetEffect. AOB is BG-lowering that will arrive after now —
          // structurally identical to pending IOB and must be included in the projection.
          const aob_preset = activityPD?.activity_on_board ?? 0;
          const pendingNetEffect   = (netEffect.totalMOB ?? 0) * effectiveCarbFactor
                                   - (netEffect.totalIOB ?? 0) * effectiveCorrFactor
                                   - aob_preset;              // Bug 3 fix: deduct pending AOB
          const correctedProjected = correctedEstimatedBG + pendingNetEffect;

          netEffect = {
            ...netEffect,
            estimatedBG:             correctedEstimatedBG,
            projectedFinalBG:        correctedProjected,
            cumulativeMealEffect:    pkCumulative.cumulativeMealEffect,
            cumulativeInsulinEffect: pkCumulative.cumulativeInsulinEffect,
            cumulativeBaseline:      pkCumulative.cumulativeNetBaseline,
          } as NetEffectResult;

          if (debug) {
            console.log('[useActiveEffects] 🌙 Preset: patched estimatedBG with PK cumulative + activity', {
              circadian:                stableBaseline,
              pkCumulativeNet:          pkCumulative.cumulativeNetBaseline,
              cumulativeActivityEffect,
              correctedEstimatedBG,
              sensitivityMultiplier,
              effectiveCFForCumulative:  effectiveCFForCumulative ?? '(base)',
              effectiveC2BForCumulative: effectiveC2BForCumulative ?? '(base)',
              effectiveCorrFactor,
              effectiveCarbFactor,
              correctedProjected,
            });
          }
        }

        if (debug) {
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('[useActiveEffects] 🔍 NET EFFECT OBJECT STRUCTURE:');
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(JSON.stringify(netEffect, null, 2));
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('');

          console.log('[useActiveEffects] 🆕 FIELD NAME CHECK:');
          console.log('[useActiveEffects]   Has cumulativeMealEffect?', 'cumulativeMealEffect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulativeInsulinEffect?', 'cumulativeInsulinEffect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulativeBaseline?', 'cumulativeBaseline' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulative_meal_effect?', 'cumulative_meal_effect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulative_insulin_effect?', 'cumulative_insulin_effect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulative_net_baseline?', 'cumulative_net_baseline' in (netEffect || {}));
          console.log('');

          console.log('[useActiveEffects] 📊 EXTRACTED VALUES:');
          console.log('[useActiveEffects]   Total IOB:', netEffect?.totalIOB || 0, 'units');
          console.log('[useActiveEffects]   Total MOB:', netEffect?.totalMOB || 0, 'g');
          console.log('[useActiveEffects]   Active Insulin Effect:', netEffect?.activeInsulinEffect || 0, 'mg/dL/hr');
          console.log('[useActiveEffects]   Active Meal Effect:', netEffect?.activeMealEffect || 0, 'mg/dL/hr');
          console.log('[useActiveEffects]   Current Net Effect:', netEffect?.currentNetEffect || 0, 'mg/dL/hr');
          console.log('[useActiveEffects]   Cumulative Meal:', netEffect?.cumulativeMealEffect || 0, 'mg/dL');
          console.log('[useActiveEffects]   Cumulative Insulin:', netEffect?.cumulativeInsulinEffect || 0, 'mg/dL');
          console.log('[useActiveEffects]   Cumulative Baseline:', netEffect?.cumulativeBaseline || 0, 'mg/dL');
          console.log('[useActiveEffects]   Activity Effect:', activityPD?.cumulative_activity_effect ?? 0, 'mg/dL');
          console.log('[useActiveEffects]   Sensitivity Multiplier:', activityPD?.sensitivity_multiplier ?? 1.0);
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('');
        }

        // 🆕 Check if cumulative values are all zero — but only trigger the
        // backend fallback when there are meals/doses AFTER today's reset that
        // should have contributed.  If every item is legitimately pre-reset
        // (e.g. the user hasn't eaten yet today) then zero is CORRECT and
        // fetching the backend just wastes bandwidth and causes extra re-renders.
        const cumulativeIsZero = (
          (netEffect?.cumulativeMealEffect || 0) === 0 &&
          (netEffect?.cumulativeInsulinEffect || 0) === 0 &&
          (netEffect?.cumulativeBaseline || 0) === 0
        );

        // Determine the daily reset boundary so we can count post-reset items
        const resetHour = constants.daily_reset_hour ?? 7;
        const tzOffset  = constants.timezone_offset_minutes ?? 0;
        const utcMidnight = new Date(currentTime);
        utcMidnight.setUTCHours(0, 0, 0, 0);
        const patientMidnight = new Date(utcMidnight.getTime() - tzOffset * 60 * 1000);
        const todayResetMs = patientMidnight.getTime() + resetHour * 60 * 60 * 1000;
        const lastResetMs  = currentTime.getTime() >= todayResetMs
          ? todayResetMs
          : todayResetMs - 24 * 60 * 60 * 1000;

        const mealsAfterReset = meals.filter(m => {
          const ts = String((m as any).timestamp ?? '');
          const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
          const ms = hasZone ? new Date(ts).getTime() : new Date(ts.replace(' ', 'T') + 'Z').getTime();
          return !isNaN(ms) && ms >= lastResetMs;
        });
        const dosesAfterReset = insulinDoses.filter(d => {
          const ts = String((d as any).taken_at ?? (d as any).administrationTime ?? '');
          const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
          const ms = hasZone ? new Date(ts).getTime() : new Date(ts.replace(' ', 'T') + 'Z').getTime();
          return !isNaN(ms) && ms >= lastResetMs;
        });
        const hasPostResetData = mealsAfterReset.length > 0 || dosesAfterReset.length > 0;

        if (cumulativeIsZero && hasPostResetData && useFallback && resolvedMode !== 'preset') {
          console.warn('[useActiveEffects] ⚠️ All cumulative values are 0 - using backend fallback');
          const backend = await fetchBackendFallback();

          if (backend) {
            // Map backend data to frontend structure
            netEffect = {
              ...netEffect,
              cumulativeMealEffect: backend.cumulative?.cumulative_meal_effect ||
                                   backend.cumulative_meal_effect || 0,
              cumulativeInsulinEffect: backend.cumulative?.cumulative_insulin_effect ||
                                      backend.cumulative_insulin_effect || 0,
              cumulativeBaseline: backend.cumulative?.cumulative_net_baseline ||
                                  backend.cumulative_net_baseline || 0,
            } as NetEffectResult;

            console.log('[useActiveEffects] ✅ Backend fallback applied:', {
              cumulativeMeal:    netEffect.cumulativeMealEffect,
              cumulativeInsulin: netEffect.cumulativeInsulinEffect,
              cumulativeBaseline: netEffect.cumulativeBaseline,
            });
          }
        }

        setNetEffectDetails(netEffect);

      } catch (err) {
        console.error('[useActiveEffects] ❌ Net effect calculation failed:', err);
        setCalculationErrors(prev => [...prev, 'Net effect calculation failed']);

        // Try backend fallback on error
        if (useFallback) {
          await fetchBackendFallback();
        }
      }

      setLastUpdate(new Date());
      setIsLoading(false);

    } catch (err) {
      console.error('[useActiveEffects] ❌ Error calculating active effects:', err);
      setError(err instanceof Error ? err.message : 'Calculation error');
      setCalculationErrors(prev => [...prev, 'General calculation error']);
      setIsLoading(false);
    }
  }, [constants, constantsLoading, meals, insulinDoses, latestReading, activityPD, debug, useFallback, fetchBackendFallback]);

  /**
   * Refresh calculations
   */
  const refresh = useCallback(async () => {
    lastCalculationMinute.current = 0;
    // ✅ FIX (D-6): reset the activity PD debounce so a manual refresh always
    // triggers a fresh ODE fetch regardless of how recently it last ran.
    // This ensures post-session PD data appears immediately when the user
    // explicitly refreshes rather than waiting up to 30 s.
    lastActivityPDFetchMs.current = 0;
    // Reset the activity history cache so a manual refresh always fetches
    // fresh session data (e.g. after logging a new completed activity).
    lastActivityHistoryFetchMs.current = 0;

    if (debug) {
      console.log(`[${instanceIdRef.current}] 🔄 Manual refresh triggered`);
    }

    // Only fetch — the useEffect watching [fetchedData] will trigger
    // calculateEffects() once state propagates, avoiding the stale-closure
    // bug where calculateEffects() would see the old empty arrays.
    await fetchData('manual-refresh');
  }, [fetchData, debug]);

  // ── Stable ref so the polling effect never needs fetchData in its dep array ──
  // fetchData is a useCallback that changes whenever token/debug/windowHours
  // changes. Putting it directly in the effect's dep array caused the effect
  // to re-run (and therefore re-register the interval) on every parent
  // re-render, stacking concurrent fetch loops on Render free tier until
  // timeouts occurred. The ref always points to the latest version of
  // fetchData without being a reactive dependency.
  const fetchDataRef = useRef(fetchData);
  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);

  // FIX N-3: stable ref for calculateEffects so the baseline-mode effect
  // can call the latest version without listing it as a reactive dependency.
  // Mirrors the fetchDataRef pattern — always points to the current closure.
  const calculateEffectsRef = useRef(calculateEffects);
  useEffect(() => { calculateEffectsRef.current = calculateEffects; }, [calculateEffects]);

  // ── Immediate re-fetch on window-size change (Bug 1 fix) ──────────────────
  // The minute-boundary interval won't fire for up to 60 s after a view switch.
  // When windowHours changes (e.g. 12h → 3D), activityHistory stays []  and
  // fetchedData.meals covers only the old range until the next interval tick.
  // fetchData IS recreated (windowHours is in its dep array), and fetchDataRef
  // is immediately updated by the effect above — but nothing calls it.
  //
  // Fix: track the previous windowHours in a ref; fire fetchDataRef.current()
  // on any change.  The ref pattern avoids adding fetchData to this effect's
  // dep array (which would rerun the interval registration) while still calling
  // the latest version of fetchData.
  const prevWindowHoursRef = useRef(windowHours);
  useEffect(() => {
    if (prevWindowHoursRef.current === windowHours) return;
    prevWindowHoursRef.current = windowHours;
    if (debug) console.log(`[${instanceIdRef.current}] 🔄 windowHours changed → ${windowHours}, triggering fetch`);
    fetchDataRef.current('windowHours-changed');
  }, [windowHours]);

  // Auto-refresh setup — aligned to minute boundary (:00 seconds)
  // Mirrors the pattern used in ActiveEffectsDisplay so all live data
  // updates fire at the same wall-clock tick as the chart recalculation
  // driven by useCurrentMinute() in ChartUtils.
  useEffect(() => {
    if (!autoRefresh || constantsLoading) return;  // ✅ FIX: wait for real constants

    if (debug) {
      console.log(`[${instanceIdRef.current}] ⚙️ auto-refresh effect fired — intervalSetupDone=${intervalSetupDoneRef.current} refreshInterval=${refreshInterval}ms`);
    }

    // Immediate fetch on mount so data is available right away.
    // calculateEffects() is triggered reactively via the useEffect below
    // that watches fetchedData — calling calculateEffects directly here
    // would capture stale closure values.
    fetchDataRef.current('auto-refresh-effect-mount-or-dep-change');

    // Fix B: intervalSetupDoneRef prevents stacked polling loops when
    // usePatientConstants re-fetches in the background.  The bounce sequence:
    //   constantsLoading: false → true → false
    // tears down this effect (cleanup) and re-invokes it.  Without this guard
    // each bounce spawned a new setTimeout + setInterval on top of the still-live
    // previous one, doubling (then tripling) the fetch cadence.
    //
    // Behaviour after this fix:
    //   • First invocation (constants just loaded)  → sets up interval normally
    //   • Bounce invocation (constants reloaded)    → fires one immediate fetch
    //     above, then returns — existing interval keeps running undisturbed
    //   • autoRefresh / refreshInterval change      → cleanup fires (flag reset),
    //     new invocation sets up a fresh interval as intended
    if (intervalSetupDoneRef.current) {
      // constants reloaded mid-session — immediate fetch already issued above;
      // the interval is still running from the first setup, nothing else needed.
      return;
    }
    intervalSetupDoneRef.current = true;

    // Snap the first interval tick to the next :00 boundary, then keep a
    // steady 60 s cadence from there — same as ActiveEffectsDisplay.
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;

    const timeoutId = setTimeout(() => {
      fetchDataRef.current('interval-tick');
      intervalId = setInterval(() => fetchDataRef.current('interval-tick'), refreshInterval);
      refreshTimer.current = intervalId;
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
      if (refreshTimer.current) {
        clearInterval(refreshTimer.current);
        refreshTimer.current = null;
      }
      // Reset so a genuine re-mount (navigation away + back) or a change to
      // autoRefresh / refreshInterval starts a fresh interval correctly.
      intervalSetupDoneRef.current = false;
    };
  // fetchData intentionally EXCLUDED — the ref pattern above handles updates.
  // Including fetchData here caused an infinite re-registration loop.
  }, [autoRefresh, refreshInterval, debug, constantsLoading]);

  // Calculate when data changes — fires once per fetch because fetchedData is
  // updated atomically (all four fields land in one setState call above).
  // The old pattern watched [meals, insulinDoses, latestReading] separately,
  // which triggered up to 3 calculateEffects() calls per fetch cycle.
  useEffect(() => {
    if (fetchedData.ready && (fetchedData.meals.length > 0 || fetchedData.doses.length > 0 || fetchedData.reading)) {
      calculateEffects();
    }
  }, [fetchedData, constants, calculateEffects]);

  // ── Baseline-mode change: immediate recalculation ──────────────────────────
  // When the user (or doctor) switches baseline_mode between 'dynamic' and
  // 'preset', the new mode must take effect immediately — not on the next
  // minute-boundary poll.
  //
  // The throttle inside calculateEffects() normally blocks re-runs within the
  // same minute.  The lastBaselineModeRef trick above bypasses it when the mode
  // string changes, but we still need a React effect to actually CALL
  // calculateEffects() when constants update.  The effect above only fires when
  // fetchedData changes; this one fires when constants change so a mode switch
  // triggers recalculation even if no new fetch has happened.
  //
  // ✅ `calculateEffects` IS included in the dep array here.  It is a useCallback
  // whose own deps (constants, meals, doses, etc.) do NOT include baselineMode —
  // so it remains referentially stable across mode changes and never causes this
  // effect to re-register unnecessarily.  The eslint-disable is removed because
  // the deps are now complete and correct.
  const baselineMode = (constants as any)?.baseline_mode;
  useEffect(() => {
    if (!fetchedData.ready || constantsLoading) return;
    // Only re-run if we already have data to work with
    if (fetchedData.meals.length > 0 || fetchedData.doses.length > 0 || fetchedData.reading) {
      // FIX N-3: call via ref (always the latest closure, no dep needed)
      calculateEffectsRef.current();
    }
  // FIX N-3: removed fetchedData and calculateEffects from this dep array.
  // This effect's sole purpose is to respond to baseline_mode changes —
  // including fetchedData caused it to fire on every data fetch in the same
  // React cycle as the primary effect above, calling calculateEffects() twice.
  // The second call was caught by the per-minute throttle but still caused
  // an extra layout effect and "🚫 Calculation throttled" noise in debug mode.
  //
  // calculateEffects is now called via calculateEffectsRef (stable ref) so
  // it always invokes the latest version without being a reactive dependency.
  }, [baselineMode, constantsLoading]);

  // Extract display values with backend fallback
  const extractValue = (
    frontendValue: any,
    backendPath: string,
    defaultValue: any = 0
  ) => {
    if (usingBackend && backendData) {
      const keys = backendPath.split('.');
      let value = backendData;
      for (const key of keys) {
        value = value?.[key];
      }
      return value ?? defaultValue;
    }
    return frontendValue ?? defaultValue;
  };

  const stableBaseline = baselineDetails?.stableBaseline ??
                        (usingBackend ? backendData?.bg_estimates?.stable_baseline : null);
  const estimatedBG = netEffectDetails?.estimatedBG ??
                     (usingBackend ? backendData?.bg_estimates?.current_estimated_bg : null);
  const projectedFinalBG = netEffectDetails?.projectedFinalBG ?? null;

  const totalIOB = extractValue(netEffectDetails?.totalIOB, 'iob.total_active_insulin');
  const totalMOB = extractValue(netEffectDetails?.totalMOB, 'mob.total_active_carbs');
  const activeInsulinEffect = extractValue(netEffectDetails?.activeInsulinEffect, 'iob.total_bg_reduction');
  const activeMealEffect = extractValue(netEffectDetails?.activeMealEffect, 'mob.expected_bg_impact');
  const currentNetEffect = extractValue(netEffectDetails?.currentNetEffect, 'net_effect');

  const cumulativeMealEffect = extractValue(
    netEffectDetails?.cumulativeMealEffect,
    'cumulative.cumulative_meal_effect'
  );
  const cumulativeInsulinEffect = extractValue(
    netEffectDetails?.cumulativeInsulinEffect,
    'cumulative.cumulative_insulin_effect'
  );
  const cumulativeNetBaseline = extractValue(
    netEffectDetails?.cumulativeBaseline,
    'cumulative.cumulative_net_baseline'
  );

  const safetyStatus = netEffectDetails?.safetyStatus ?? null;
  const trend = netEffectDetails?.trend ?? null;

  return {
    // Display Values
    stableBaseline,
    estimatedBG,
    projectedFinalBG,

    // Active Effects
    totalIOB,
    totalMOB,
    activeInsulinEffect,
    activeMealEffect,
    currentNetEffect,

    // Cumulative Effects
    cumulativeMealEffect,
    cumulativeInsulinEffect,
    cumulativeNetBaseline,

    // ── Activity PD ──────────────────────────────────────────────────────────
    activityEffect:          activityPD?.cumulative_activity_effect ?? 0,
    sensitivityMultiplier:   activityPD?.sensitivity_multiplier    ?? 1.0,
    activityOnBoard:         activityPD?.activity_on_board         ?? 0,
    activityContributions:   activityPD?.activity_contributions    ?? [],
    activityPDResult:        activityPD,  // undefined until first fetch; null after fetch confirms no sessions
    activityHistory,

    // Safety & Trends
    safetyStatus,
    trend,

    // Detailed Breakdowns
    baselineDetails,
    netEffectDetails,

    // Backend fallback
    backendData,
    usingBackend,

    // Raw fetched arrays — consumed by EffectsVisualizationChart so it can
    // pass real Meal / InsulinDose objects to processMealsForChart /
    // processInsulinForChart without making a second network request.
    meals,
    insulinDoses,

    // Meta
    isLoading,
    error,
    lastUpdate,
    calculationErrors,

    // Active baseline mode
    baselineMode: resolvedBaselineMode,

    // Baseline sanitization
    baselineWarnings,
    baselineSanitizeStatus,

    // Actions
    refresh,
    setMeals,
    setInsulinDoses,
    setLatestReading,
  };
}

export default useActiveEffects;