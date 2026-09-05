/**
 * Calculation Comparison Component
 * Location: mobile/components/debug/CalculationComparison.tsx
 *
 * ─── ROOT CAUSE SUMMARY ──────────────────────────────────────────────────────
 *
 * Root bug 1 (Doses: 0) — wrong API endpoint
 *   getDoses({ days: 1 }) maps to a different endpoint than the one that actually
 *   works. useActiveEffects uses API.INSULIN.DATA → /api/insulin-data which
 *   returns { insulinDoses: [...] }. This component now uses the same endpoint
 *   via apiClient directly, extracting insulinDoses || doses exactly as
 *   useActiveEffects does (line 213 of useActiveEffects.ts).
 *
 * Root bug 2 (timezone shift on bare ISO strings) — fixed in TimeManager.ts
 *   parseTimestampRaw() passed bare strings like "2026-02-13T22:38:00" (no Z)
 *   to `new Date()` which interpreted them as browser-local time, shifting
 *   every IOB/MOB timestamp by ±hours equal to the UTC offset. The fix in
 *   TimeManager.ts makes parseTimestampRaw treat no-timezone strings as UTC
 *   (matching the existing correct behaviour of parseTimestamp). All downstream
 *   calculations (hoursSinceDose, reset-window checks, isWithinCurrentDay) now
 *   receive correct UTC millisecond values automatically.
 *
 * Root bug 3 (Cumulative Insulin = 0) — consequence of bugs 1 & 2
 *   calculateStableBaselineFromReading received an empty dose list (bug 1) and
 *   would have shifted timestamps even if doses were present (bug 2).
 *   Fixed by fixing the two root causes above.
 *
 * Root bug 4 (Meals show 0 carbs) — fixed in v4, carried forward
 *   normaliseMeal() maps _id → id and ensures calculation_summary is present.
 *
 * Root bug 5 (Backend MOB field mapping) — fixed in v4, carried forward
 *   current_bg_elevation is summed from meal_contributions, not from
 *   expected_bg_impact which equals pending_bg_rise.
 */

import React, { useEffect, useState } from 'react';
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

// Use apiClient + API constants — same as useActiveEffects.ts does
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

// Backend API imports (read-only — we do not modify their return values)
// Single authoritative backend source: /api/active-effects-full
// This endpoint uses reset-hour-aware meal filtering identical to the frontend.
// /api/active-insulin and /api/meal-on-board used a plain 12-hour lookback
// with NO reset-hour boundary — comparing them against frontend values that
// DO respect the reset hour produced phantom mismatches around the reset window.
import { getActiveEffectsFull } from '@/services/api/calculations';

// Frontend calculation imports
import {
  calculateNetEffect,
  calculateStableBaselineFromReading,
} from '@/utils/glucose/blood-glucose-estimation';
// calculateTotalCumulativeEffects is imported from the calculations module (not
// blood-glucose-estimation directly) so we get the v4.4 persist-at-100% fix.
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinEffect,
  type InsulinDoseForStacking,
} from '@/utils/insulin/pharmacodynamics';
import { MEAL_ABSORPTION_PROFILES } from '@/constants/shared-constants';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely extract an array from an API response that may be a plain array
 * OR a wrapper object such as { doses: [...] } / { insulinDoses: [...] }.
 */
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
 * Parse a timestamp string to UTC milliseconds.
 *
 * The backend stores timestamps in UTC but often omits the 'Z' suffix
 * (e.g. "2026-02-13T22:38:00"). Browsers treat bare ISO strings as
 * LOCAL time, introducing a ±hours offset. This function appends 'Z'
 * when no timezone indicator is present, mirroring the fix in TimeManager.ts
 * parseTimestampRaw() (v4.3).
 */
function parseUTCMs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
  return hasZone
    ? new Date(ts).getTime()
    : new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Normalise a raw API meal object so getTotalCarbsFromMeal() and
 * calculateMealActivity() work correctly regardless of field naming.
 *
 * The Meal type expects `id` but MongoDB returns `_id`.
 */
function normaliseMeal(raw: any): any {
  return {
    ...raw,
    id: raw.id ?? String(raw._id ?? ''),
    calculation_summary: raw.calculation_summary ?? {},
    nutrition: raw.nutrition ?? {},
  };
}

/**
 * Normalise a raw API dose object to canonical field names.
 *
 * Field name variants seen across API versions:
 *   amount : dose | units | doseAmount | amount | doseUnits
 *   time   : taken_at | administrationTime | takenAt | timestamp
 *   type   : medication | insulinType | insulin_type | type
 */
function normaliseDose(raw: any): any {
  const amount = raw?.dose ?? raw?.units ?? raw?.doseAmount ?? raw?.amount ?? raw?.doseUnits ?? 0;
  const takenAt = raw?.taken_at ?? raw?.administrationTime ?? raw?.takenAt ?? raw?.timestamp ?? null;
  const medication = raw?.medication ?? raw?.insulinType ?? raw?.insulin_type ?? raw?.type ?? 'regular_insulin';
  return { ...raw, dose: amount, taken_at: takenAt, medication };
}

/**
 * Convert a normalised dose object to the shape calculateStackedInsulinEffect() expects.
 * Returns null for future doses or doses with missing/invalid data.
 */
function rawDoseToStacking(dose: any, currentTime: Date): InsulinDoseForStacking | null {
  const units: number = dose?.units ?? dose?.dose ?? 0;
  // After allDosesForCalc mapping, field is administrationTime (InsulinDose shape)
  const takenAt: string | null = dose?.administrationTime ?? dose?.taken_at ?? null;
  if (!takenAt || units <= 0) return null;

  const doseMs = parseUTCMs(takenAt);
  if (isNaN(doseMs)) return null;

  const hoursSinceDose = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
  if (hoursSinceDose < 0) return null;

  return { dose: units, hoursSinceDose, insulinType: dose?.insulinType ?? dose?.medication ?? 'regular_insulin' };
}

/**
 * Compute the last daily reset time in UTC milliseconds.
 * Mirrors backend TimeManager.get_daily_reset_time().
 *
 * Uses the patient's timezone offset (from constants) to find the most
 * recent occurrence of resetHour:00:00 in their local time, then converts
 * back to UTC. Falls back to browser local time if offset is unavailable.
 */
function getLastResetTimeMs(currentTime: Date, resetHour: number, tzOffsetMinutes: number): number {
  const offsetMs = tzOffsetMinutes * 60 * 1000;
  const localMs = currentTime.getTime() + offsetMs;

  const resetLocal = new Date(localMs);
  resetLocal.setUTCHours(resetHour, 0, 0, 0);

  if (localMs < resetLocal.getTime()) {
    resetLocal.setUTCDate(resetLocal.getUTCDate() - 1);
  }

  return resetLocal.getTime() - offsetMs;
}

/** Absorption duration for a meal using its profile. */
function getMealDurationHours(meal: any): number {
  const absType =
    meal?.calculation_summary?.absorption_type ||
    meal?.nutrition?.absorption_type ||
    meal?.nutrition?.absorptionType ||
    'medium';
  return (MEAL_ABSORPTION_PROFILES as any)?.[absType]?.duration_hours ?? 4.0;
}

/** PK duration for a raw dose object. */
function getDoseDurationHours(dose: any, constants: any): number {
  return constants?.medication_factors?.[dose?.medication]?.duration_hours ?? 4.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ComparisonData {
  backend: {
    iob: { totalActiveInsulin: number; activeDoses: number; currentBGReduction: number; pendingBGReduction: number };
    mob: { totalActiveCarbs: number; activeMealCount: number; currentBGElevation: number; pendingBGRise: number };
    netEffect: {
      estimatedBG: number; projectedFinalBG: number; pendingNetEffect: number;
      cumulativeBaseline: number; available: boolean;
    };
  };
  frontend: {
    iob: { totalActiveInsulin: number; activeDoses: number; currentBGReduction: number; pendingBGReduction: number };
    mob: { totalActiveCarbs: number; activeMealCount: number; currentBGElevation: number; pendingBGRise: number };
    netEffect: {
      estimatedBG: number; projectedFinalBG: number; currentNetEffect: number;
      cumulativeBaseline: number; cumulativeMealEffect: number; cumulativeInsulinEffect: number;
      safetyStatus: string; trend: string;
    };
    baseline?: {
      value: number; readingValue: number;
      cumulativeMealEffect: number; cumulativeInsulinEffect: number; cumulativeNetEffect: number;
      mealsCount: number; insulinCount: number;
    };
  };
  metadata: { calculatedAt: string; mealsCount: number; dosesCount: number; hasRecentReading: boolean };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function CalculationComparison() {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { constants } = usePatientConstants();

  const fetchAndCompare = async () => {
    try {
      setError(null);
      const currentTime = new Date();

      // ── 1. Fetch all data ──────────────────────────────────────────────────
      // IMPORTANT: Insulin doses are fetched from API.INSULIN.DATA (/api/insulin-data)
      // — the same endpoint used by useActiveEffects.ts. getDoses() maps to a
      // different, non-working endpoint and must NOT be used here.
      //
      // BACKEND: We use ONLY /api/active-effects-full for all backend values.
      // It applies max(reset_time, 12h_cutoff) meal filtering — identical to the
      // frontend — so iob, mob, cumulative, and bg_estimates are all computed
      // from the same meal/dose window. The former separate /api/active-insulin
      // and /api/meal-on-board calls used a plain 12-hour lookback with NO
      // reset-hour boundary, creating phantom mismatches near the reset window.
      const [backendFull, mealsRes, insulinRes, readingsRes] = await Promise.all([
        getActiveEffectsFull(undefined, undefined, (constants as any)?.timezone_offset_minutes ?? 0)
          .catch((e) => { console.warn('[CC] getActiveEffectsFull failed:', e); return null; }),
        apiClient.get(API.MEALS.MEALS_ONLY),
        apiClient.get(API.INSULIN.DATA),
        apiClient.get(API.BLOOD_SUGAR.LIST).catch(() => null),
      ]);

      // ── 2. Extract and normalise ───────────────────────────────────────────
      const rawMeals: any[] = safeArray(mealsRes?.data, 'meals', 'data');
      // FIXED: Backend /api/insulin-data returns 'insulin_logs' key (not 'insulinDoses')
      const rawDoses: any[] = safeArray(insulinRes?.data, 'insulin_logs', 'insulinDoses', 'doses', 'data');

      const allMeals = rawMeals.map(normaliseMeal);
      const allRawDoses = rawDoses.map(normaliseDose);

      // ✅ Re-map doses to InsulinDose shape expected by PK calculation functions.
      // normaliseDose() uses taken_at/dose/medication — PK functions need
      // administrationTime/units/insulinType.
      const allDosesForCalc = allRawDoses.map((d: any) => ({
        ...d,
        id: String(d._id ?? d.id ?? ''),
        units: d.dose ?? d.units ?? 0,
        administrationTime: d.taken_at ?? d.administrationTime ?? d.takenAt ?? null,
        insulinType: d.medication ?? d.insulinType ?? d.insulin_type ?? 'regular_insulin',
      }));

      // Diagnostic — verify fields in dev console
      console.log('[CC] meals raw sample:', rawMeals[0] ? {
        _id: rawMeals[0]._id, calc_carbs: rawMeals[0].calculation_summary?.total_carb_equiv,
      } : 'none');
      console.log('[CC] doses raw sample:', rawDoses[0] ?? 'none');
      console.log('[CC] doses normalised:', allRawDoses[0] ?? 'none');

      // ── 3. Reset window ────────────────────────────────────────────────────
      const resetHour: number = constants?.daily_reset_hour ?? 7;
      const tzOffset: number = (constants as any)?.timezone_offset_minutes ?? 0;
      const lastResetMs = getLastResetTimeMs(currentTime, resetHour, tzOffset);

      console.log('[CC] reset window:', new Date(lastResetMs).toISOString(),
        '→', currentTime.toISOString(), `(tz=${tzOffset}min, hour=${resetHour})`);

      // ── 4. Filter to active window ─────────────────────────────────────────
      // Meals: after last reset AND still within their absorption duration
      const activeMeals = allMeals.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        if (isNaN(mealMs) || mealMs <= lastResetMs) return false;
        const hoursSince = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);
        if (hoursSince < 0) return false;
        return hoursSince < getMealDurationHours(meal);
      });

      // ALL meals after last reset (including fully-absorbed ones).
      // Required for correct cumulative baseline — fully-absorbed meals must be
      // included so the persist-at-100% effect is counted (see cumulative-effects.ts
      // v4.4 fix).  activeMeals only covers still-absorbing meals, causing the
      // cumulative to be systematically too low and to go negative when IOB > MOB.
      const allMealsInWindow = allMeals.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        if (isNaN(mealMs) || mealMs <= lastResetMs) return false;
        return (currentTime.getTime() - mealMs) / (1000 * 60 * 60) >= 0;
      });

      // Doses: after last reset AND still within their PK duration.
      // Uses allDosesForCalc (InsulinDose-shaped) so administrationTime field is present.
      const activeDosesRaw = allDosesForCalc.filter((dose: any) => {
        const doseMs = parseUTCMs(dose?.administrationTime);
        if (isNaN(doseMs) || doseMs <= lastResetMs) return false;
        const hoursSince = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
        if (hoursSince < 0) return false;
        return hoursSince < getDoseDurationHours(dose, constants);
      });

      console.log('[CC] activeMeals:', activeMeals.length, '/', allMeals.length);
      console.log('[CC] activeDoses:', activeDosesRaw.length, '/', allRawDoses.length);

      // ── 5. Map doses → InsulinDoseForStacking ──────────────────────────────
      const dosesForStacking: InsulinDoseForStacking[] = activeDosesRaw
        .map((d) => rawDoseToStacking(d, currentTime))
        .filter((d): d is InsulinDoseForStacking => d !== null);

      console.log('[CC] dosesForStacking:', dosesForStacking);

      // ── 6. Frontend calculations ───────────────────────────────────────────
      const correctionFactor = constants?.correction_factor ?? 40;

      const frontendMOB = calculateStackedMealEffect(activeMeals, currentTime, constants);
      const frontendIOB = calculateStackedInsulinEffect(dosesForStacking, correctionFactor);

      console.log('[CC] frontendMOB:', { mob: frontendMOB.totalMOB, elev: frontendMOB.totalBGElevation });
      console.log('[CC] frontendIOB:', { iob: frontendIOB.totalIOB, bg: frontendIOB.totalBGImpact });

      // ── 7. Most recent glucose reading ─────────────────────────────────────
      // /api/blood-sugar (BLOOD_SUGAR.LIST) returns an ARRAY sorted by time.
      // Treating the array as a single object means readingData?.reading is always
      // undefined → recentReading was the whole array → bloodSugar lookup fails
      // → frontendBaseline was always null → stable baseline fell back to
      // target_glucose constant, never reading-derived.
      const readingRaw = readingsRes?.data;
      const readingArray: any[] = Array.isArray(readingRaw)
        ? readingRaw
        : readingRaw?.readings ?? readingRaw?.data ?? [];
      // ✅ FIX: Only use readings from the CURRENT DAILY PERIOD (after lastResetMs).
      //
      // ROOT CAUSE of the 14.4 mg/dL baseline bug:
      //   The previous code picked the most recent reading regardless of when it was
      //   taken. When the most recent reading (e.g. 450 mg/dL) is from BEFORE today's
      //   reset, calculateStableBaselineFromReading computes:
      //     baseline = 450 - cumulative_effects_at_reading_time
      //   Those effects include meals eaten AFTER the reading (still in allMeals),
      //   producing an absurd result like 450 - 435.6 = 14.4 mg/dL.
      //
      // The backend only queries readings WHERE bloodSugarTimestamp >= reset_time.
      // We mirror that: if no reading is in today's period, recentReading = null
      // and we fall back to target_glucose — exactly matching backend behaviour.
      const readingsInCurrentPeriod = readingArray.filter((r: any) => {
        const ts = parseUTCMs(r?.bloodSugarTimestamp ?? r?.timestamp);
        return !isNaN(ts) && ts >= lastResetMs;
      });

      const recentReading = readingsInCurrentPeriod.length > 0
        ? [...readingsInCurrentPeriod].sort((a: any, b: any) =>
            parseUTCMs(b.bloodSugarTimestamp ?? b.timestamp) -
            parseUTCMs(a.bloodSugarTimestamp ?? a.timestamp)
          )[0]
        : null;  // No reading in current period → fall back to target_glucose

      console.log('[CC] readings total:', readingArray.length,
        '| in current period:', readingsInCurrentPeriod.length,
        '| reset was:', new Date(lastResetMs).toISOString());
      if (readingArray.length > 0 && recentReading === null) {
        console.warn('[CC] Most recent reading is BEFORE todays reset — using target_glucose fallback (matches backend)');
      }

      // ── 8. Baseline ────────────────────────────────────────────────────────
      // calculateStableBaselineFromReading expects InsulinDose shape with:
      //   - administrationTime  (not taken_at)
      //   - units               (not dose)
      //   - insulinType         (not medication)
      // allDosesForCalc (mapped above in step 2) already has the correct shape.

      // Only pass doses from CURRENT daily period to the PK functions
      // (matches backend: doses after reset_time only)
      const allDosesInWindow = allDosesForCalc.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return !isNaN(doseMs) && doseMs > lastResetMs;
      });

      console.log('[CC] allDosesForCalc sample:', allDosesForCalc[0] ?? 'none');
      console.log('[CC] allDosesInWindow count:', allDosesInWindow.length, '/', allDosesForCalc.length);

      let frontendBaseline = null;
      // Only attempt baseline if we have a real reading (not target_glucose default)
      const targetGlucose = constants?.target_glucose ?? 100;
      const hasRealReading = recentReading?.bloodSugar && recentReading.bloodSugar !== targetGlucose;
      if (recentReading?.bloodSugar) {
        if (!hasRealReading) {
          console.warn('[CC] ⚠️ recentReading.bloodSugar === target_glucose — may be a fallback, not a real reading');
        }
        frontendBaseline = calculateStableBaselineFromReading(
          {
            id: String(recentReading._id ?? recentReading.id ?? ''),
            value: recentReading.bloodSugar,
            timestamp: recentReading.bloodSugarTimestamp ?? recentReading.timestamp,
            userId: 'current',
            status: recentReading.status,
            source: 'manual',
          },
          allMeals,
          allDosesInWindow,   // ✅ FIX: InsulinDose-shaped, window-filtered
          currentTime,
          constants,
          MEAL_ABSORPTION_PROFILES,
          resetHour,
          tzOffset,
        );
        console.log('[CC] frontendBaseline:', frontendBaseline);
      }

      // ── 9. Net effect ──────────────────────────────────────────────────────
      // calculateNetEffect is still used for safetyStatus, trend, and the
      // instantaneous IOB/MOB breakdown — but its estimatedBG / cumulativeBaseline
      // are NOT reliable because it internally calls calculateTotalCumulativeEffects
      // with only the meals it was given (activeMeals here), and blood-glucose-
      // estimation.ts may lack the Phase 3 persist-at-100% fix.
      // We replace those two values below with the corrected computation.
      const frontendNetEffect = calculateNetEffect(
        frontendBaseline,
        activeMeals,
        allDosesInWindow,     // ✅ FIX: InsulinDose-shaped, window-filtered
        currentTime,
        constants,
        MEAL_ABSORPTION_PROFILES,
      );

      // ── 9b. Corrected cumulative baseline and estimatedBG ─────────────────
      //
      // Backend formula (cumulative_effects_routes.py lines 476-478):
      //   current_estimated_bg = stable_baseline + cumulative_net_baseline
      //
      // Two requirements to match the backend:
      //   (A) Pass ALL meals in today's window (not just active/still-absorbing ones).
      //       Fully-absorbed meals persist their full effect in the backend's
      //       "bank balance" model — the frontend must include them too.
      //   (B) Use calculateTotalCumulativeEffects from @/utils/calculations which
      //       includes the v4.4 persist-at-100% fix for both meals and insulin
      //       (see cumulative-effects.ts).  The version inside blood-glucose-
      //       estimation.ts does NOT have this fix.
      const correctedCumulative = calculateTotalCumulativeEffects(
        allMealsInWindow,     // (A) ALL meals after reset, not just activeMeals
        allDosesInWindow,     // all doses after reset
        currentTime,
        constants,
        MEAL_ABSORPTION_PROFILES,
        resetHour,
        tzOffset,
      );

      // correctedEstimatedBG = stable_baseline + cumulative_net_baseline
      // Falls back to target_glucose when no real reading is available.
      const stableBaseline = frontendBaseline?.stableBaseline ?? targetGlucose;
      const correctedEstimatedBG =
        stableBaseline + correctedCumulative.cumulativeNetBaseline;

      console.log('[CC] correctedCumulative:', correctedCumulative);
      console.log('[CC] correctedEstimatedBG:', correctedEstimatedBG,
        `(baseline ${stableBaseline} + cumNet ${correctedCumulative.cumulativeNetBaseline})`);

      // ✅ FIX 2 & 3: Compute pendingNetEffect and projectedFinalBG to match backend formula.
      //
      // Backend formula (cumulative_effects_routes.py lines 427-432):
      //   pending_mob_rise      = total_active_carbs × carb_to_bg_ratio
      //   pending_iob_reduction = iob_data['pending_bg_reduction']  (= totalIOB × correctionFactor)
      //   pending_net_effect    = pending_mob_rise − pending_iob_reduction
      //   projected_final_bg    = current_estimated_bg + pending_net_effect
      //
      // Uses correctedEstimatedBG (from 9b) as the base — NOT frontendNetEffect.estimatedBG.
      const carbToBgRatio = (constants as any)?.carb_to_bg_ratio ?? (constants as any)?.carb_to_bg_factor ?? 4.0;
      const frontendPendingMOBRise    = (frontendMOB?.totalMOB ?? 0) * carbToBgRatio;
      const frontendPendingIOBRedux   = (frontendIOB?.totalIOB ?? 0) * correctionFactor;
      const frontendPendingNetEffect  = frontendPendingMOBRise - frontendPendingIOBRedux;
      // projectedFinalBG uses the corrected BG base so both values align with backend
      const frontendProjectedFinalBG  = correctedEstimatedBG + frontendPendingNetEffect;

      // ── 10. Backend display values ─────────────────────────────────────────
      // All backend values now come from backendFull (active-effects-full) which
      // exposes iob and mob sub-objects using the same reset-hour-aware filtering
      // as the frontend.  After Fix A in cumulative_effects_routes.py, mob_data
      // now includes current_bg_elevation, pending_bg_rise, expected_bg_impact.
      const beIOB = backendFull?.iob;
      const beMOB = backendFull?.mob;

      const backendCurrentBGReduction = safeArray<any>(beIOB?.insulin_contributions)
        .reduce((sum: number, c: any) => sum + (c?.active_units ?? 0) * correctionFactor, 0);
      const backendPendingBGReduction = (beIOB?.total_active_insulin ?? 0) * correctionFactor;

      // ✅ FIX 1: Use instantaneous_meal_effect from the top-level response.
      // beMOB.current_bg_elevation = instantaneous_meal_effect computed by
      // calculate_instantaneous_meal_effect() on the backend — this is the correct
      // "current BG elevation from active meals" value.
      // meal_contributions inside beMOB do NOT have per-meal current_bg_elevation
      // fields, so summing them always returns 0. Use the summary field directly.
      const backendCurrentBGElevation =
        backendFull?.instantaneous_meal_effect ??
        beMOB?.current_bg_elevation ?? 0;

      // ── 11. Assemble ───────────────────────────────────────────────────────
      const bgEst = backendFull?.bg_estimates ?? null;

      console.log('[CC] backendFull bg_estimates:', bgEst);
      console.log('[CC] backendFull cumulative_net_baseline:', backendFull?.cumulative_net_baseline);

      setData({
        backend: {
          iob: {
            totalActiveInsulin: beIOB?.total_active_insulin ?? 0,
            activeDoses: beIOB?.active_doses ?? 0,
            currentBGReduction: backendCurrentBGReduction,
            pendingBGReduction: backendPendingBGReduction,
          },
          mob: {
            totalActiveCarbs: beMOB?.total_active_carbs ?? 0,
            // active-effects-full uses active_meals_count; alias active_meal_count also added by Fix A
            activeMealCount: beMOB?.active_meals_count ?? beMOB?.active_meal_count ?? 0,
            currentBGElevation: backendCurrentBGElevation,
            // ✅ FIX: mob_data does NOT contain pending_bg_rise — that field lives in
            // bg_estimates.pending_mob_rise (computed only when a blood sugar reading is present).
            // Fallback chain: bg_estimates → mob object aliases → 0.
            pendingBGRise: backendFull?.bg_estimates?.pending_mob_rise ??
                           beMOB?.pending_bg_rise ??
                           beMOB?.expected_bg_impact ?? 0,
          },
          netEffect: {
            available: bgEst !== null,
            estimatedBG: bgEst?.current_estimated_bg ?? 0,
            projectedFinalBG: bgEst?.projected_final_bg ?? 0,
            // pending_net_effect = pending MOB rise − pending IOB reduction (future effect)
            // matches frontend currentNetEffect which is activeMeal − activeInsulin effect
            pendingNetEffect: bgEst?.pending_net_effect ?? 0,
            cumulativeBaseline: backendFull?.cumulative_net_baseline ?? 0,
          },
        },
        frontend: {
          iob: {
            totalActiveInsulin: frontendIOB?.totalIOB ?? 0,
            activeDoses: dosesForStacking.length,
            // ✅ FIX: Same as ActiveEffectsDisplay.tsx — use the cumulative absorbed
            // effect (PAST→PRESENT), NOT frontendIOB.totalBGImpact which is the
            // instantaneous gamma-PDF activity rate × CF and is wildly inflated.
            currentBGReduction: Math.abs(correctedCumulative.cumulativeInsulinEffect),
            pendingBGReduction: (frontendIOB?.totalIOB ?? 0) * correctionFactor,
          },
          mob: {
            totalActiveCarbs: frontendMOB?.totalMOB ?? 0,
            // ✅ FIX: Backend counts ALL meals in the daily window where total_carbs > 0
            // — including fully-absorbed meals. Using activeMeals.length (only still-absorbing
            // meals) under-counts by excluding meals past their duration.
            // allMealsInWindow includes every meal after the reset regardless of absorption
            // completion, which matches the backend's active_meals_count definition.
            activeMealCount: allMealsInWindow.length,
            currentBGElevation: frontendMOB?.totalBGElevation ?? 0,
            pendingBGRise: frontendMOB?.totalPendingRise ?? 0,
          },
          netEffect: {
            // ✅ Use correctedEstimatedBG (stable_baseline + cumulative_net_baseline)
            // which matches the backend formula exactly. frontendNetEffect.estimatedBG
            // is NOT used here because it came from blood-glucose-estimation.ts which
            // lacks the Phase 3 persist-at-100% fix and only received activeMeals.
            estimatedBG: correctedEstimatedBG,
            // ✅ FIX 2: Use explicitly computed projectedFinalBG (matches backend formula)
            projectedFinalBG: frontendProjectedFinalBG,
            // ✅ FIX 3: Use explicitly computed pendingNetEffect (matches backend pending_net_effect)
            currentNetEffect: frontendPendingNetEffect,
            // ✅ Use corrected cumulative baseline from allMealsInWindow calculation
            cumulativeBaseline: correctedCumulative.cumulativeNetBaseline,
            cumulativeMealEffect: correctedCumulative.cumulativeMealEffect,
            cumulativeInsulinEffect: correctedCumulative.cumulativeInsulinEffect,
            safetyStatus: frontendNetEffect?.safetyStatus ?? 'unknown',
            trend: frontendNetEffect?.trend ?? 'stable',
          },
          baseline: frontendBaseline ? {
            value: frontendBaseline.stableBaseline,
            readingValue: frontendBaseline.readingValue,
            cumulativeMealEffect: frontendBaseline.cumulativeMealEffect,
            cumulativeInsulinEffect: frontendBaseline.cumulativeInsulinEffect,
            cumulativeNetEffect: frontendBaseline.cumulativeNetEffect,
            mealsCount: frontendBaseline.mealsCount,
            insulinCount: frontendBaseline.insulinCount,
          } : undefined,
        },
        metadata: {
          calculatedAt: currentTime.toISOString(),
          mealsCount: allMeals.length,
          dosesCount: allRawDoses.length,
          hasRecentReading: !!(recentReading?.bloodSugar) && readingsInCurrentPeriod.length > 0,
        },
      });
    } catch (err) {
      console.error('[CC] Error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (constants) fetchAndCompare();
  }, [constants]);

  const onRefresh = () => { setRefreshing(true); fetchAndCompare(); };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading comparison...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={fetchAndCompare}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!data) return null;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <Text style={styles.title}>🔬 Calculation Comparison</Text>
        <Text style={styles.subtitle}>Backend API vs Frontend Calculations</Text>
        <Text style={styles.timestamp}>
          Updated: {new Date(data.metadata.calculatedAt).toLocaleTimeString()}
        </Text>
      </View>

      <ComparisonSection
        title="💉 Insulin On Board (IOB)"
        backend={data.backend.iob}
        frontend={data.frontend.iob}
        fields={[
          { key: 'totalActiveInsulin', label: 'Total IOB', unit: 'units', decimals: 2 },
          { key: 'activeDoses', label: 'Active Doses', unit: 'doses', decimals: 0 },
          { key: 'currentBGReduction', label: '✅ Current BG Reduction', unit: 'mg/dL', decimals: 1 },
          { key: 'pendingBGReduction', label: '⏳ Pending BG Reduction', unit: 'mg/dL', decimals: 1 },
        ]}
      />

      <ComparisonSection
        title="🍽️ Meal On Board (MOB)"
        backend={data.backend.mob}
        frontend={data.frontend.mob}
        fields={[
          { key: 'totalActiveCarbs', label: 'Total MOB', unit: 'g', decimals: 1 },
          { key: 'activeMealCount', label: 'Active Meals', unit: 'meals', decimals: 0 },
          { key: 'currentBGElevation', label: '✅ Current BG Elevation', unit: 'mg/dL', decimals: 1 },
          { key: 'pendingBGRise', label: '⏳ Pending BG Rise', unit: 'mg/dL', decimals: 1 },
        ]}
      />

      {data.frontend.baseline && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📱 T1D Stable Baseline (Frontend Only)</Text>
          <DataRow label="Baseline Value" value={data.frontend.baseline.value} unit="mg/dL" />
          <DataRow label="Reading Value" value={data.frontend.baseline.readingValue} unit="mg/dL" />
          <DataRow label="Cumulative Meal Effect" value={data.frontend.baseline.cumulativeMealEffect} unit="mg/dL" highlight="positive" />
          <DataRow label="Cumulative Insulin Effect" value={data.frontend.baseline.cumulativeInsulinEffect} unit="mg/dL" highlight="negative" />
          <DataRow label="Net Cumulative Effect" value={data.frontend.baseline.cumulativeNetEffect} unit="mg/dL" />
          <DataRow label="Meals Counted" value={data.frontend.baseline.mealsCount} unit="meals" />
          <DataRow label="Insulin Doses Counted" value={data.frontend.baseline.insulinCount} unit="doses" />
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⚖️ Net Effect Analysis</Text>
        {!data.backend.netEffect?.available && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>
              ⚠️ Backend BG estimates unavailable — no blood sugar reading found after today's reset.
              Record a reading to enable backend comparison for Estimated BG and Projected Final BG.
            </Text>
          </View>
        )}
        <ComparisonRow
          label="Current Estimated BG"
          backendValue={data.backend.netEffect?.estimatedBG ?? 0}
          frontendValue={data.frontend.netEffect.estimatedBG}
          unit="mg/dL" decimals={1}
          backendUnavailable={!data.backend.netEffect?.available}
        />
        <ComparisonRow
          label="Projected Final BG"
          backendValue={data.backend.netEffect?.projectedFinalBG ?? 0}
          frontendValue={data.frontend.netEffect.projectedFinalBG}
          unit="mg/dL" decimals={1}
          backendUnavailable={!data.backend.netEffect?.available}
        />
        <ComparisonRow
          label="Pending Net Effect"
          backendValue={data.backend.netEffect?.pendingNetEffect ?? 0}
          frontendValue={data.frontend.netEffect.currentNetEffect}
          unit="mg/dL" decimals={1}
          backendUnavailable={!data.backend.netEffect?.available}
        />
        <ComparisonRow
          label="Cumulative Baseline"
          backendValue={data.backend.netEffect?.cumulativeBaseline ?? 0}
          frontendValue={data.frontend.netEffect.cumulativeBaseline}
          unit="mg/dL" decimals={1}
        />
        <DataRow label="Safety Status" value={data.frontend.netEffect.safetyStatus} unit="" highlight={getSafetyHighlight(data.frontend.netEffect.safetyStatus)} />
        <DataRow label="Trend" value={data.frontend.netEffect.trend} unit="" />

        {/* ── Assessment summary ────────────────────────────────────────── */}
        {(() => {
          const fe      = data.frontend;
          const assess  = getProjectedAssessment(fe.iob, fe.mob, fe.netEffect);
          const netPend = fe.mob.pendingBGRise - fe.iob.pendingBGReduction;
          const both    = fe.iob.totalActiveInsulin > 0.5 && fe.mob.totalActiveCarbs > 5;
          return (
            <View style={[styles.assessmentCard, styles[assess.bgStyle as keyof typeof styles]]}>
              <Text style={[styles.assessmentTitle, { color: assess.titleColor }]}>
                {assess.icon}{'  '}{assess.title}
              </Text>
              <View style={styles.assessmentChips}>
                {fe.iob.totalActiveInsulin > 0 && (
                  <View style={styles.chipIOB}>
                    <Text style={styles.chipIOBText}>💉 {fe.iob.totalActiveInsulin.toFixed(1)}u IOB</Text>
                  </View>
                )}
                {fe.mob.totalActiveCarbs > 0 && (
                  <View style={styles.chipMOB}>
                    <Text style={styles.chipMOBText}>🍽️ {fe.mob.totalActiveCarbs.toFixed(0)}g MOB</Text>
                  </View>
                )}
              </View>
              <Text style={styles.assessmentBody}>{assess.recommendation}</Text>
              {both && (fe.mob.pendingBGRise > 0 || fe.iob.pendingBGReduction > 0) && (
                <View style={styles.assessmentPendingRow}>
                  <Text style={styles.assessmentPendingLabel}>Projected net pending effect</Text>
                  <View style={styles.assessmentPendingValues}>
                    <Text style={styles.pendingMeal}>▲ +{fe.mob.pendingBGRise.toFixed(0)} mg/dL</Text>
                    <Text style={styles.pendingVs}> vs </Text>
                    <Text style={styles.pendingInsulin}>▼ −{fe.iob.pendingBGReduction.toFixed(0)} mg/dL</Text>
                    <Text style={[styles.pendingNet,
                      netPend > 5 ? styles.pendingNetHigh : netPend < -5 ? styles.pendingNetLow : styles.pendingNetNeutral]}>
                      {'  '}= {netPend > 0 ? '+' : ''}{netPend.toFixed(0)} net
                    </Text>
                  </View>
                  {fe.netEffect.projectedFinalBG > 0 && (
                    <Text style={styles.assessmentProjectedBG}>
                      Projected final BG ≈ <Text style={styles.assessmentProjectedBGBold}>
                        {fe.netEffect.projectedFinalBG.toFixed(0)} mg/dL
                      </Text>
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })()}
      </View>

      <View style={styles.metadata}>
        <Text style={styles.metaText}>📊 Meals: {data.metadata.mealsCount}</Text>
        <Text style={styles.metaText}>💉 Doses: {data.metadata.dosesCount}</Text>
        <Text style={styles.metaText}>📱 Reading: {data.metadata.hasRecentReading ? 'Yes' : 'No'}</Text>
      </View>

      <TouchableOpacity style={styles.refreshButton} onPress={fetchAndCompare}>
        <Text style={styles.refreshButtonText}>🔄 Refresh Comparison</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ComparisonSection({ title, backend, frontend, fields }: {
  title: string; backend: any; frontend: any;
  fields: Array<{ key: string; label: string; unit: string; decimals: number }>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {fields.map((f) => (
        <ComparisonRow key={f.key} label={f.label}
          backendValue={backend[f.key] ?? 0} frontendValue={frontend[f.key] ?? 0}
          unit={f.unit} decimals={f.decimals} />
      ))}
    </View>
  );
}

function ComparisonRow({ label, backendValue, frontendValue, unit, decimals, backendUnavailable }: {
  label: string; backendValue: number; frontendValue: number; unit: string; decimals: number;
  backendUnavailable?: boolean;
}) {
  const diff = Math.abs(backendValue - frontendValue);
  const isMatch = !backendUnavailable && diff < 1.0;
  return (
    <View style={styles.compRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.valuesRow}>
        <View style={styles.valCol}>
          <Text style={styles.valLabel}>Backend</Text>
          <Text style={[styles.valText, backendUnavailable && styles.unavailable]}>
            {backendUnavailable ? 'N/A' : `${backendValue.toFixed(decimals)} ${unit}`}
          </Text>
        </View>
        <View style={styles.valCol}>
          <Text style={styles.valLabel}>Frontend</Text>
          <Text style={styles.valText}>{frontendValue.toFixed(decimals)} {unit}</Text>
        </View>
        <View style={styles.valCol}>
          <Text style={[styles.matchIcon, backendUnavailable ? styles.matchNa : isMatch ? styles.matchGood : styles.matchBad]}>
            {backendUnavailable ? '—' : isMatch ? '✅' : '❌'}
          </Text>
          <Text style={styles.diffText}>{backendUnavailable ? '' : `Δ ${diff.toFixed(decimals)}`}</Text>
        </View>
      </View>
    </View>
  );
}

function DataRow({ label, value, unit, highlight, large }: {
  label: string; value: number | string; unit: string;
  highlight?: 'positive' | 'negative' | 'warning' | 'good'; large?: boolean;
}) {
  const fmt = typeof value === 'number' ? value.toFixed(1) : value;
  return (
    <View style={styles.dataRow}>
      <Text style={styles.dataLabel}>{label}</Text>
      <Text style={[
        styles.dataValue, large && styles.dataLarge,
        highlight === 'positive' && styles.pos, highlight === 'negative' && styles.neg,
        highlight === 'warning' && styles.warn, highlight === 'good' && styles.good,
      ]}>
        {fmt} {unit}
      </Text>
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

function getSafetyHighlight(s: string): 'positive' | 'negative' | 'warning' | 'good' {
  if (s === 'critical_low' || s === 'critical_high') return 'negative';
  if (s === 'hypoglycemia_risk' || s === 'hyperglycemia_risk') return 'warning';
  if (s === 'optimal') return 'good';
  return 'positive';
}

const NET_PENDING_THRESHOLD = 20;

function getProjectedAssessment(
  iob: { totalActiveInsulin: number; pendingBGReduction: number },
  mob: { totalActiveCarbs: number; pendingBGRise: number },
  netEffect: { safetyStatus: string; projectedFinalBG?: number },
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

  if (netEffect.safetyStatus === 'critical_low')
    return { icon: '🚨', title: 'CRITICAL LOW', titleColor: '#F44336',
             recommendation: 'Critically low blood sugar — take action immediately.',
             projectedOutcome: 'critical_low', bgStyle: 'assessment_negative' };
  if (netEffect.safetyStatus === 'critical_high')
    return { icon: '🚨', title: 'CRITICAL HIGH', titleColor: '#F44336',
             recommendation: 'Critically high blood sugar — take action immediately.',
             projectedOutcome: 'critical_high', bgStyle: 'assessment_negative' };

  if (bothActive) {
    if (netPending < -NET_PENDING_THRESHOLD)
      return { icon: '⬇️', title: 'BOTH ACTIVE — FALLING RISK', titleColor: '#9C27B0',
               recommendation: 'Insulin is outpacing meal absorption — BG is likely to fall. ' +
                 'Consider a small snack if not eating again soon.',
               projectedOutcome: 'hypo_risk', bgStyle: 'assessment_good' };
    if (netPending > NET_PENDING_THRESHOLD)
      return { icon: '⬆️', title: 'BOTH ACTIVE — RISING RISK', titleColor: '#FF9800',
               recommendation: 'Meal carbs are outpacing active insulin — BG is likely to rise. ' +
                 'Monitor closely and consider a correction dose if needed.',
               projectedOutcome: 'hyper_risk', bgStyle: 'assessment_warning' };
    return { icon: '⚖️', title: 'BOTH ACTIVE — BALANCED', titleColor: '#2196F3',
             recommendation: 'Insulin and carbs are closely matched. Monitor BG closely over the next hour.',
             projectedOutcome: 'balanced', bgStyle: 'assessment_good' };
  }
  if (hasMeaningfulIOB)
    return { icon: pendingInsulinReduction > NET_PENDING_THRESHOLD ? '⬇️' : '💉',
             title: 'HIGH IOB', titleColor: '#9C27B0',
             recommendation: pendingInsulinReduction > NET_PENDING_THRESHOLD
               ? 'Active insulin may lower your BG significantly. Consider a snack if not eating soon.'
               : 'Insulin is active. Monitor BG before your next meal.',
             projectedOutcome: 'iob_only', bgStyle: 'assessment_good' };
  if (hasMeaningfulMOB)
    return { icon: pendingMealRise > NET_PENDING_THRESHOLD ? '⬆️' : '🍽️',
             title: 'HIGH MOB', titleColor: '#FF9800',
             recommendation: 'Carbs still absorbing — account for them before dosing again.',
             projectedOutcome: 'mob_only', bgStyle: 'assessment_warning' };

  const safetyHighlight = getSafetyHighlight(netEffect.safetyStatus);
  return { icon: safetyHighlight === 'negative' || safetyHighlight === 'warning' ? '⚠️' : '✅',
           title: netEffect.safetyStatus.replace(/_/g, ' ').toUpperCase(),
           titleColor: safetyHighlight === 'warning' ? '#FF9800'
                      : safetyHighlight === 'good' ? '#4CAF50' : '#666',
           recommendation: netEffect.safetyStatus === 'optimal' ? 'Blood sugar is in a good range.'
                          : 'Monitor as needed.',
           projectedOutcome: 'stable', bgStyle: `assessment_${safetyHighlight}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  header: { backgroundColor: '#fff', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#333' },
  subtitle: { fontSize: 14, color: '#666', marginTop: 4 },
  timestamp: { fontSize: 12, color: '#999', marginTop: 4 },
  section: {
    backgroundColor: '#fff', marginTop: 16, padding: 16, borderRadius: 8,
    marginHorizontal: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1, shadowRadius: 4, elevation: 2,
  },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 16 },
  compRow: { marginBottom: 16, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  rowLabel: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 8 },
  valuesRow: { flexDirection: 'row', justifyContent: 'space-between' },
  valCol: { flex: 1, alignItems: 'center' },
  valLabel: { fontSize: 12, color: '#999', marginBottom: 4 },
  valText: { fontSize: 16, fontWeight: '500', color: '#333' },
  matchIcon: { fontSize: 20, marginBottom: 4 },
  matchGood: { color: '#4CAF50' },
  matchBad: { color: '#F44336' },
  matchNa: { color: '#9E9E9E' },
  diffText: { fontSize: 12, color: '#666' },
  unavailable: { color: '#9E9E9E', fontStyle: 'italic' },
  warningBox: {
    backgroundColor: '#FFF3E0', borderRadius: 6, padding: 10, marginBottom: 12,
    borderLeftWidth: 3, borderLeftColor: '#FF9800',
  },
  warningText: { fontSize: 12, color: '#E65100', lineHeight: 18 },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  dataLabel: { fontSize: 14, color: '#666', flex: 1 },
  dataValue: { fontSize: 16, fontWeight: '600', color: '#333' },
  dataLarge: { fontSize: 20, fontWeight: 'bold' },
  pos: { color: '#4CAF50' },
  neg: { color: '#F44336' },
  warn: { color: '#FF9800' },
  good: { color: '#2196F3' },
  metadata: {
    flexDirection: 'row', justifyContent: 'space-around', backgroundColor: '#fff',
    marginTop: 16, marginHorizontal: 16, padding: 16, borderRadius: 8,
  },
  metaText: { fontSize: 14, color: '#666' },
  refreshButton: { backgroundColor: '#007AFF', margin: 16, padding: 16, borderRadius: 8, alignItems: 'center' },
  refreshButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loadingText: { fontSize: 16, color: '#666', marginTop: 16 },
  errorText: { fontSize: 16, color: '#F44336', textAlign: 'center', marginBottom: 16 },
  retryButton: { backgroundColor: '#007AFF', padding: 16, borderRadius: 8, alignItems: 'center', marginHorizontal: 32 },
  retryText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // ── Assessment card ───────────────────────────────────────────────────────
  assessmentCard: {
    marginTop: 12, borderRadius: 10, padding: 12, borderLeftWidth: 4,
    backgroundColor: '#f5f5f5', borderLeftColor: '#9e9e9e',
  },
  assessment_positive: { backgroundColor: '#e8f5e9', borderLeftColor: '#4caf50' },
  assessment_negative: { backgroundColor: '#ffebee', borderLeftColor: '#f44336' },
  assessment_warning:  { backgroundColor: '#fff3e0', borderLeftColor: '#ff9800' },
  assessment_good:     { backgroundColor: '#e3f2fd', borderLeftColor: '#2196f3' },
  assessmentTitle: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
  assessmentBody:  { fontSize: 13, color: '#444', lineHeight: 18, marginBottom: 4 },
  assessmentChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chipIOB: {
    backgroundColor: '#f3e5f5', borderWidth: 1, borderColor: '#9c27b0',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3,
  },
  chipIOBText: { fontSize: 12, fontWeight: '600', color: '#9c27b0' },
  chipMOB: {
    backgroundColor: '#fff3e0', borderWidth: 1, borderColor: '#ff9800',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3,
  },
  chipMOBText: { fontSize: 12, fontWeight: '600', color: '#ff9800' },
  assessmentPendingRow: {
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
  },
  assessmentPendingLabel:  { fontSize: 11, color: '#999', marginBottom: 4 },
  assessmentPendingValues: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  pendingMeal:       { fontSize: 12, fontWeight: '600', color: '#FF9800' },
  pendingVs:         { fontSize: 12, color: '#999' },
  pendingInsulin:    { fontSize: 12, fontWeight: '600', color: '#9C27B0' },
  pendingNet:        { fontSize: 12, fontWeight: '700' },
  pendingNetHigh:    { color: '#FF9800' },
  pendingNetLow:     { color: '#9C27B0' },
  pendingNetNeutral: { color: '#4CAF50' },
  assessmentProjectedBG:     { fontSize: 11, color: '#666', marginTop: 4 },
  assessmentProjectedBGBold: { fontWeight: '700' },
});