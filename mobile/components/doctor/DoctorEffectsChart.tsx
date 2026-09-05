/**
 * DoctorEffectsChart
 * Location: mobile/components/doctor/DoctorEffectsChart.tsx
 *
 * A data-driven adaptation of EffectsVisualizationChart for the doctor patient
 * view. Accepts pre-fetched meals + patient constants as props instead of
 * calling the patient's own hooks (useActiveEffects, usePatientConstants).
 *
 * WHAT'S SHOWN vs EffectsVisualizationChart:
 *   ✅ Meal effect area (orange)      — MOB curve across time
 *   ✅ Cumulative meal baseline (green) — bank-balance line
 *   ✅ Net effect line (blue dashed)
 *   ✅ Meal dose bars (orange)
 *   ✅ Stats summary (active carbs, peak impact, TIR equivalent)
 *   ⚠️ Insulin effects (purple area) — NOT available.
 *       The doctor API does not expose a patient's insulin dose history.
 *       The net-effect line therefore reflects meals only.
 *
 * Visual language mirrors EffectsVisualizationChart exactly.
 *
 * SYNCED WITH PATIENT CHART (EffectsVisualizationChart):
 *
 *   B-15: tau_W casing fix — TAU_W_MIN now reads HR_MODEL.tau_W (was tau_w).
 *
 *   P7 / §9-P7: calculateActivityEffectAtTime() reverted to Z-state decay.
 *     The old 3-phase plateau + TAU_ACUTE_MS model was incorrect.
 *     Now uses τ_Z = SHARED_CONSTANTS.HR_MODEL.tau_Z (default 10 min),
 *     decaying immediately from session end — no plateau. TAU_ACUTE_MS removed.
 *
 *   M-11: calculateSensitivityMultiplierAtTime() added. buildChartData() now
 *     applies the W-state sensitivity multiplier per point, scaling insulin
 *     and meal impacts exactly as EVC does. peakSensitivityMultiplier threaded
 *     from activityPD.sensitivity_multiplier → buildChartData.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Dimensions,
  Modal,
} from 'react-native';
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryBar,
  VictoryAxis,
  VictoryScatter,
} from 'victory-native';

import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinChartEffect,
} from '@/utils/insulin/pharmacodynamics';
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { MEAL_ABSORPTION_PROFILES, SHARED_CONSTANTS } from '@/constants/shared-constants';

// ── Activity PD types ──────────────────────────────────────────────────────────
import type { ActivityPDResult, ActivityContribution } from '@/services/api/activity-pharmacodynamics';

import {
  parseUTCMs,
  processContextMealsForChart,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  getLastResetTimeMs,
  formatXAxis,
  useCurrentMinute,
  VIEW_CONFIGS as BASE_VIEW_CONFIGS,
} from '@/utils/ChartUtils';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

import type { MealResponse } from '@/types/api';
import type { PatientConstantsData, InsulinDoseResponse } from '@/services/api/doctor';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT = 260;
const CHART_WIDTH  = SCREEN_WIDTH - 48;

/**
 * τ_W (90 min) — post-exercise W-state decay constant.
 * Sourced from SHARED_CONSTANTS.HR_MODEL.tau_W — never hardcoded (B-15 fix: tau_w → tau_W).
 * Matches the same constant used in EffectsVisualizationChart.
 */
const TAU_W_MIN:    number = (SHARED_CONSTANTS as any)?.HR_MODEL?.tau_W ?? 90; // B-15: was tau_w (wrong casing)
const TAU_W_MS:     number = TAU_W_MIN * 60_000;

// TAU_ACUTE_MS removed — the old 3-phase plateau + 15 min fast-decay model was incorrect.
// calculateActivityEffectAtTime() now uses Z-state decay (τ_Z from SHARED_CONSTANTS)
// matching EffectsVisualizationChart (P7 fix / §9-P7).

// Extend the shared VIEW_CONFIGS with doctor-only week/month views.
// Using BASE_VIEW_CONFIGS as the foundation keeps shared timing values in sync
// with the patient chart as ChartUtils evolves.
const VIEW_CONFIGS = {
  ...BASE_VIEW_CONFIGS,
  // BASE_VIEW_CONFIGS (from ChartUtils) merges SHARED_CONSTANTS.VIEW_MODE_CONFIGS,
  // which only provides `interpolationInterval` — never `stepMins`.  Without this
  // override, viewCfg.stepMins is undefined for 3h/6h/12h/24h, STEP becomes NaN,
  // the for-loop in buildChartData never advances, and the chart renders 0 points.
  // Derive stepMins directly from interpolationInterval so the two stay in sync
  // automatically when shared-constants.ts is regenerated from the backend.
  '3h':  { ...BASE_VIEW_CONFIGS['3h'],  stepMins: BASE_VIEW_CONFIGS['3h']?.interpolationInterval  ?? 1  },
  '6h':  { ...BASE_VIEW_CONFIGS['6h'],  stepMins: BASE_VIEW_CONFIGS['6h']?.interpolationInterval  ?? 5  },
  '12h': { ...BASE_VIEW_CONFIGS['12h'], stepMins: BASE_VIEW_CONFIGS['12h']?.interpolationInterval ?? 10 },
  '24h': { ...BASE_VIEW_CONFIGS['24h'], stepMins: BASE_VIEW_CONFIGS['24h']?.interpolationInterval ?? 15 },
  week:  { label: 'Week',  pastHours: 168, futureHours: 0, tickInterval: 24, tickFormat: 'DD/MM', stepMins: 60  },
  month: { label: 'Month', pastHours: 720, futureHours: 0, tickInterval: 72, tickFormat: 'DD/MM', stepMins: 120 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EffectsPoint {
  timestamp:        number;
  mealImpact:       number;
  insulinImpact:    number;
  cumulativeBaseline: number;
  netEffect:        number;
  doseMarker:       number | null;
  insulinDoseMarker: number | null;
  meals:            any[];
  insulinDoses:     any[];
  /**
   * Signed cumulative activity BG effect at this time point (mg/dL).
   * Already baked into cumulativeBaseline — stored separately so the
   * teal overlay line can show the isolated exercise signal.
   */
  activityEffect:   number;
}

interface TooltipData {
  point: EffectsPoint;
}

export interface DoctorEffectsChartProps {
  meals:        MealResponse[];
  insulinDoses: InsulinDoseResponse[];
  constants:    PatientConstantsData | null;
  /**
   * Pre-fetched activity pharmacodynamics result from the parent screen.
   * When provided, the chart overlays an activity effect line + session bands
   * that mirror EffectsVisualizationChart exactly.
   * When null/undefined the activity overlay is hidden — degrades gracefully.
   */
  activityPD?:  ActivityPDResult | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// parseUTCMs, getMealDurationHours, normaliseDose, doseToStacking,
// getLastResetTimeMs, formatXAxis all imported from ChartUtils.

// formatTick replaced by formatXAxis from ChartUtils.

// normaliseMeal removed — replaced by processContextMealsForChart (imported from
// ChartUtils) which gives identical meal processing to the patient chart, including
// timezone-aware carb-equiv computation and correct timestamp normalisation.

// ─────────────────────────────────────────────────────────────────────────────
// Activity effect helper  (mirrors EffectsVisualizationChart exactly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the signed cumulative activity BG effect at a given time point.
 * Used for the TEAL overlay line — shows the pharmacodynamic window.
 *
 * Z-state (acute IIRd) decay model — mirrors EffectsVisualizationChart (P7 / §9-P7):
 *   • Before session start:           0
 *   • During session (0 → duration):  linear ramp 0 → fullEffect
 *   • Post-exercise (t > end):        W(t) = fullEffect × exp(−t / τ_Z)
 *     τ_Z = SHARED_CONSTANTS.HR_MODEL.tau_Z (default 10 min)
 *
 * WHY no plateau here:
 *   The 90-min τ_W plateau belongs to the W-state SENSITIVITY MULTIPLIER
 *   (calculateSensitivityMultiplierAtTime). The acute BG-lowering Z-state
 *   decays immediately at session end — no plateau before decay. The old
 *   3-phase plateau + TAU_ACUTE_MS model was incorrect (§9-P7).
 *
 * Daily reset guard: sessions starting before resetTimeMs are excluded.
 *
 * Sign convention: cumulative_bg_effect is already signed (negative = aerobic).
 */
function calculateActivityEffectAtTime(
  targetMs:     number,
  contributions: ActivityContribution[],
  tauWMs:       number,
  resetTimeMs:  number = 0,
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    // Daily reset guard — mirrors calculateActivityEffectForCumulative()
    if (resetTimeMs > 0 && startMs < resetTimeMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      // During session: linear ramp 0 -> fullEffect
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      total += frac * fullEffect;
    } else {
      // Z-state (acute IIRd) decays immediately when exercise ends — no plateau.
      // TAU_ACUTE_MS removed: τ_W plateau belongs to sensitivity multiplier, not here.
      const TAU_Z_MS = ((SHARED_CONSTANTS as any)?.HR_MODEL?.tau_Z ?? 10) * 60_000;
      const postExerciseMs = targetMs - endMs;
      const recoveryFrac = Math.exp(-postExerciseMs / TAU_Z_MS);
      total += recoveryFrac * fullEffect;
    }
  }
  return total;
}

/**
 * Activity BG effect for the CUMULATIVE (green) series ONLY.
 *
 * Key differences from calculateActivityEffectAtTime():
 *  1. LOCK-IN: after training ends the effect locks in at fullEffect permanently.
 *     A BG drop from exercise does not reverse on its own — it persists until
 *     the patient eats. No plateau window, no decay.
 *  2. DAILY RESET: sessions starting before resetTimeMs are excluded, matching
 *     the reset logic of calculateTotalCumulativeEffects() for meals and insulin.
 */
function calculateActivityEffectForCumulative(
  targetMs:      number,
  contributions: ActivityContribution[],
  resetTimeMs:   number,
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    if (startMs < resetTimeMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      total += frac * fullEffect;
    } else {
      // Post-exercise: lock in permanently at fullEffect.
      total += fullEffect;
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensitivity multiplier  (M-11 — mirrors EffectsVisualizationChart exactly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the effective insulin-sensitivity multiplier at `targetMs`.
 *
 * W-state model — the τ_W plateau is CORRECT here (models ISF/CR boost):
 *   During session  (startMs → endMs):            ramps 0 → peakBoost
 *   Post-exercise plateau (endMs → endMs + τ_W):  peakBoost (flat)
 *   After plateau   (> endMs + τ_W):              peakBoost × exp(−(t−end−τ_W) / τ_W)
 *
 * Mirrors EffectsVisualizationChart.calculateSensitivityMultiplierAtTime exactly.
 */
function calculateSensitivityMultiplierAtTime(
  targetMs:       number,
  contributions:  ActivityContribution[],
  peakMultiplier: number,
  tauWMs:         number,
): number {
  if (contributions.length === 0) return 1.0;

  const INTENSITY_PEAK_BOOST: Record<string, number> =
    (SHARED_CONSTANTS as any)?.INTENSITY_PEAK_BOOST ?? { light: 0.10, moderate: 0.25, vigorous: 0.40 };

  const MAX_BOOST: number =
    (SHARED_CONSTANTS as any)?.HR_MODEL?.max_sensitivity_boost ?? 0.60;
  const globalPeakBoost = Math.max(0, peakMultiplier - 1);
  let totalBoost = 0;

  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;

    const intensityBoost = INTENSITY_PEAK_BOOST[c.intensity ?? 'moderate'] ?? 0.25;
    const peakBoost = globalPeakBoost > 0.005 ? globalPeakBoost : intensityBoost;

    if (targetMs <= endMs) {
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      totalBoost += peakBoost * frac;
      continue;
    }

    const postMs = targetMs - endMs;
    if (postMs <= tauWMs) {
      totalBoost += peakBoost;
    } else {
      totalBoost += peakBoost * Math.exp(-(postMs - tauWMs) / tauWMs);
    }
  }

  return 1 + Math.min(totalBoost, MAX_BOOST);
}

/**
 * Build chart data for the full time range using the same per-point
 * calculation pattern as EffectsVisualizationChart.buildChartPoint().
 * Now includes insulin effects from the doctor API.
 */
function buildChartData(
  normalisedMeals: any[],
  normalisedDoses: any[],
  rangeStart: number,
  rangeEnd: number,
  stepMins: number,
  constants: PatientConstantsData | null,
  now: number,
  activityContributions: ActivityContribution[] = [],
  peakSensitivityMultiplier: number = 1.0, // M-11: live API sensitivity_multiplier
): EffectsPoint[] {
  const resetHour        = (constants as any)?.daily_reset_hour ?? 7;
  const tzOffset         = (constants as any)?.timezone_offset_minutes ?? 0;
  const correctionFactor = (constants as any)?.correction_factor ?? 40;

  const HALF_STEP = (stepMins / 2) * 60_000;
  const STEP      = stepMins * 60_000;

  // ✅ FIX: processContextMealsForChart converts timestamps to numbers.
  // Use a numeric fast-path so both string and number timestamps work.
  const getMealMs = (m: any): number =>
    typeof m.timestamp === 'number' ? m.timestamp : parseUTCMs(m.timestamp);

  // ── Cumulative window — anchor to the reset at the start of the chart range ──
  //
  // BEFORE: getLastResetTimeMs(new Date(now), ...) always returns TODAY's reset.
  // For multi-day views where rangeStart is days ago, using today's reset as the
  // lower bound drops all historical meals from earlier daily windows, causing the
  // green cumulative line to be flat (0) for every historical chart point.
  //
  // FIX: compute the reset applicable AT rangeStart (or now, whichever is earlier).
  //   • Short views (3H/6H/12H): rangeStart > today's reset → earliestResetMs =
  //     today's reset → cumulativeWindowStart = earliestResetMs
  //   • Multi-day views (3D/Week): rangeStart < today's reset → earliestResetMs =
  //     the reset at rangeStart → cumulativeWindowStart = rangeStart (unchanged)
  const earliestResetMs       = getLastResetTimeMs(new Date(Math.min(rangeStart, now)), resetHour, tzOffset);
  const cumulativeWindowStart = Math.min(rangeStart, earliestResetMs);

  const allMealsInWindow = normalisedMeals.filter(m => {
    const ms = getMealMs(m);
    // ✅ FIX: use rangeEnd (not `now`) so future-snapped meals (timestamp =
    // insulinTime + offset) reach calculateTotalCumulativeEffects and appear
    // in the green cumulative line. Safe: calculateAbsorbedFraction returns
    // 0 for any chart point before the meal's own timestamp.
    return !isNaN(ms) && ms >= cumulativeWindowStart && ms <= rangeEnd;
  });
  const allDosesInWindow = normalisedDoses.filter(d => {
    const ms = parseUTCMs(d.administrationTime);
    return !isNaN(ms) && ms >= cumulativeWindowStart && ms <= now;
  });

  const points: EffectsPoint[] = [];

  for (let ts = rangeStart; ts <= rangeEnd; ts += STEP) {
    const targetTime = new Date(ts);

    // ── Meal effect ────────────────────────────────────────────────────────
    const activeMeals = normalisedMeals.filter(m => {
      const mealMs = getMealMs(m);
      if (isNaN(mealMs) || mealMs > ts) return false;
      return (ts - mealMs) / 3_600_000 < getMealDurationHours(m);
    });

    const mealResult = activeMeals.length > 0
      ? calculateStackedMealEffect(activeMeals, targetTime, constants ?? {})
      : { totalBGElevation: 0 };

    const mealImpact = (mealResult as any).totalBGElevation ?? 0;

    // ── Sensitivity multiplier at this chart point (M-11) ──────────────────
    // W-state model (plateau + exp decay) — time-resolved, not the live API scalar.
    const sensitivityMultiplierAtTime = calculateSensitivityMultiplierAtTime(
      ts, activityContributions, peakSensitivityMultiplier, TAU_W_MS,
    );

    // ── Insulin effect (S-curve, same as EffectsVisualizationChart) ────────
    const dosesForStacking = normalisedDoses
      .map(d => doseToStacking(d, targetTime))
      .filter((d): d is InsulinDoseForStacking => d !== null);

    // Base ISF (unscaled) — post-hoc multiply so we don't double-apply.
    const chartInsulinResult = dosesForStacking.length > 0
      ? calculateStackedInsulinChartEffect(dosesForStacking, correctionFactor)
      : { totalBGImpact: 0, totalIOB: 0 };

    const insulinImpact = chartInsulinResult.totalBGImpact * sensitivityMultiplierAtTime; // ≤ 0

    // Activity-adjusted meal impact (mirrors EVC invariant #3).
    const effectiveC2B = (((constants as any)?.carb_to_bg_factor ?? 4.0)) / sensitivityMultiplierAtTime;
    const activityAdjustedMealImpact: number = sensitivityMultiplierAtTime > 1.005
      ? ((calculateStackedMealEffect(
            activeMeals,
            targetTime,
            { ...(constants ?? {}), carb_to_bg_factor: effectiveC2B },
          ) as any)?.totalBGElevation ?? 0)
      : mealImpact;

    const netEffect = activityAdjustedMealImpact + insulinImpact;

    // ── Cumulative bank-balance ────────────────────────────────────────────
    const mealsUpToNow = allMealsInWindow.filter(m => getMealMs(m) <= ts);
    const dosesUpToNow = allDosesInWindow.filter(d => parseUTCMs(d.administrationTime) <= ts);

    // Effective CF and C2B for cumulative calc (matches EVC and BGV exactly).
    const effectiveCFForCumulative = correctionFactor * sensitivityMultiplierAtTime;
    const effectiveC2BForCumulative = ((constants as any)?.carb_to_bg_factor ?? 4.0) / sensitivityMultiplierAtTime;
    const constantsForCumulative: any = sensitivityMultiplierAtTime > 1.005
      ? { ...(constants ?? {}), carb_to_bg_factor: effectiveC2BForCumulative }
      : (constants ?? {});

    const cumulative = (mealsUpToNow.length > 0 || dosesUpToNow.length > 0)
      ? calculateTotalCumulativeEffects(
          mealsUpToNow,
          dosesUpToNow,
          targetTime,
          constantsForCumulative,         // M-11: effective C2B during exercise windows
          MEAL_ABSORPTION_PROFILES as any,
          resetHour,
          tzOffset,
          undefined,
          effectiveCFForCumulative,       // M-11: effective CF scales cumulative insulin depth
        )
      : { cumulativeNetBaseline: 0 };

    const cumulativeBaseline = (cumulative as any).cumulativeNetBaseline ?? 0;

    // ── Activity effect at this time point ─────────────────────────────────
    // resetTimeMs is derived per-point so the activity component resets at
    // the same daily boundary as meals and insulin.
    const resetTimeMs = getLastResetTimeMs(targetTime, resetHour, tzOffset);

    // Teal line: Z-state decay (shows the pharmacodynamic window).
    const activityEffect = calculateActivityEffectAtTime(ts, activityContributions, TAU_W_MS, resetTimeMs);

    // Green cumulative line: lock-in model (BG drop persists until patient eats).
    const totalCumulativeBaseline = cumulativeBaseline +
      calculateActivityEffectForCumulative(ts, activityContributions, resetTimeMs);

    // ── Dose markers ───────────────────────────────────────────────────────
    const mealsAtTs = normalisedMeals.filter(m => {
      const mealMs = getMealMs(m);
      return !isNaN(mealMs) && Math.abs(mealMs - ts) < HALF_STEP;
    });
    const dosesAtTs = normalisedDoses.filter(d => {
      const doseMs = parseUTCMs(d.administrationTime);
      return !isNaN(doseMs) && Math.abs(doseMs - ts) < HALF_STEP;
    });

    const totalCarbs = mealsAtTs.reduce((s, m) => {
      // ✅ FIX: processContextMealsForChart sets m.carbEquiv; also extend the
      // fallback chain to mirror EffectsVisualizationChart exactly.
      const c =
        m.carbEquiv                             ??
        m.calculation_summary?.total_carb_equiv ??
        m.nutrition?.total_carb_equiv           ??
        m.nutrition?.totalCarbEquiv             ??
        m.nutrition?.totalCarbs                 ??
        m.nutrition?.carbs                      ?? 0;
      return s + c;
    }, 0);
    const totalInsulin = dosesAtTs.reduce((s, d) => s + (d.units ?? d.dose ?? 0), 0);

    points.push({
      timestamp:          ts,
      mealImpact,
      insulinImpact,
      cumulativeBaseline: totalCumulativeBaseline,
      netEffect,
      doseMarker:         totalCarbs > 0   ? totalCarbs            : null,
      insulinDoseMarker:  totalInsulin > 0 ? -(totalInsulin * 5)   : null,
      meals:              mealsAtTs,
      insulinDoses:       dosesAtTs,
      activityEffect,
    });
  }

  return points;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom view config — derives tick density + step from selected date range
// ─────────────────────────────────────────────────────────────────────────────

function getCustomViewConfig(start: Date, end: Date): typeof VIEW_CONFIGS[string] {
  const durationHours = (end.getTime() - start.getTime()) / 3_600_000;
  const futureHours   = Math.max(0, (end.getTime() - Date.now()) / 3_600_000);
  const pastHours     = Math.max(0, (Date.now() - start.getTime()) / 3_600_000);
  let tickFormat: string;
  let tickInterval: number;
  let stepMins: number;
  if (durationHours <= 6)        { tickFormat = 'HH:mm'; tickInterval = 1;  stepMins = 5;   }
  else if (durationHours <= 24)  { tickFormat = 'HH:mm'; tickInterval = 3;  stepMins = 15;  }
  else if (durationHours <= 72)  { tickFormat = 'DD/MM'; tickInterval = 12; stepMins = 30;  }
  else if (durationHours <= 168) { tickFormat = 'DD/MM'; tickInterval = 24; stepMins = 60;  }
  else                           { tickFormat = 'DD/MM'; tickInterval = 72; stepMins = 120; }
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, stepMins };
}

// ─────────────────────────────────────────────────────────────────────────────
// 24H range helper — mirrors the patient chart which starts at the daily reset
// (default 7 AM) rather than a rolling 24-hour window.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For the '24h' view mode, return yesterday's daily-reset time (e.g. yesterday
 * at 07:00 local) as the range start, matching the patient chart's
 * useChartTimeRange('24h') which always shows the previous full reset-period.
 * All other view modes fall through to the standard now - pastHours formula.
 */
function get24hAwareRangeStart(
  viewMode: string,
  now: number,
  pastHours: number,
  constants: PatientConstantsData | null,
): number {
  if (viewMode !== '24h') return now - pastHours * 3_600_000;
  const resetHour = (constants as any)?.daily_reset_hour ?? 7;
  const tzOffset  = (constants as any)?.timezone_offset_minutes ?? 0;
  // getLastResetTimeMs returns TODAY's most recent reset (e.g. today at 07:00).
  // The patient chart's useChartTimeRange('24h') starts from YESTERDAY's reset
  // so the doctor gets the same 24-hour window of history.  Subtract one full
  // day to align with the patient view.
  return getLastResetTimeMs(new Date(now), resetHour, tzOffset) - 24 * 3_600_000;
}



export const DoctorEffectsChart: React.FC<DoctorEffectsChartProps> = ({
  meals,
  insulinDoses,
  constants,
  activityPD = null,
}) => {
  const [viewMode, setViewMode]       = useState<'3h' | '6h' | '12h' | '24h' | 'week' | 'month' | 'custom'>('12h');

  // ── Custom date-range filter ────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);

  const [showMealEffect, setMeal]     = useState(true);
  const [showCumulative, setCumul]    = useState(true);
  const [showDoseMarkers, setMarkers]     = useState(true);
  const [showInsulinEffect, setInsulin]   = useState(true);
  const [showActivityEffect, setActivity] = useState(true);
  const [tooltip, setTooltip]             = useState<TooltipData | null>(null);

  const viewCfg = viewMode === 'custom'
    ? getCustomViewConfig(customRangeStart, customRangeEnd)
    : VIEW_CONFIGS[viewMode];
  // useCurrentMinute() updates at each :00 wall-clock tick (same cadence as the
  // patient charts) so the "now" line and chart window advance automatically.
  const now        = useCurrentMinute();
  const rangeStart = viewMode === 'custom' && customApplied
    ? customRangeStart.getTime()
    : get24hAwareRangeStart(viewMode, now, viewCfg.pastHours, constants);
  const rangeEnd   = viewMode === 'custom' && customApplied ? customRangeEnd.getTime()   : now + viewCfg.futureHours * 3_600_000;

  const normMeals = useMemo(
    // ✅ FIX: Use processContextMealsForChart (same pipeline as patient chart) instead
    // of the local normaliseMeal. This ensures:
    //   1. Identical carbEquiv computation (including foodItems fallback)
    //   2. Numeric timestamps (avoids parseUTCMs string-only issues)
    //   3. 8-hour lookback so meals active at rangeStart are included
    //   4. Patient constants (protein/fat factors) applied correctly
    () => processContextMealsForChart(
      meals,
      { start: rangeStart, end: rangeEnd, now },
      constants as any,   // PatientConstantsData ≈ PatientConstants at runtime
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meals, rangeStart, rangeEnd, now, constants],
  );

  const normDoses = useMemo(
    () => (insulinDoses ?? []).map(normaliseDose),
    [insulinDoses],
  );

  // ── Activity PD derived data (mirrors EffectsVisualizationChart §2a–2e) ────
  /** Per-session contributions — empty when activityPD is null */
  const activityContributions = useMemo<ActivityContribution[]>(
    () => activityPD?.activity_contributions ?? [],
    [activityPD],
  );

  /** True when there is a real activity effect to display */
  const hasActivityEffect = useMemo(
    () =>
      Math.abs(activityPD?.cumulative_activity_effect ?? 0) > 0.01 ||
      (activityPD?.activity_on_board ?? 0) > 0 ||
      (activityPD?.sensitivity_multiplier ?? 1.0) > 1.005,
    [activityPD],
  );

  /** Per-session duration bands for the shaded column overlay.
   *  Spans start -> start + duration + TAU_W_MS so the band covers both the
   *  active training period and the post-exercise sensitivity window (90 min)
   *  during which ISF/ICR are still altered — matching the teal line's plateau.
   */
  const sessionDurationAreas = useMemo<Array<{ startMs: number; endMs: number; isActive: boolean }>>(() => {
    if (!hasActivityEffect) return [];
    return activityContributions
      .map(c => {
        const startMs = parseUTCMs(c.start_time);
        if (isNaN(startMs)) return null;
        return {
          startMs,
          endMs: startMs + (c.duration_minutes ?? 30) * 60_000 + TAU_W_MS,
          isActive: c.is_active,
        };
      })
      .filter((x): x is { startMs: number; endMs: number; isActive: boolean } => x !== null);
  }, [activityContributions, hasActivityEffect]);

  /** Session start markers with intensity label (L / M / V) */
  const sessionMarkers = useMemo(
    () => activityContributions
      .map(c => ({
        startMs:   parseUTCMs(c.start_time),
        intensity: c.intensity as string,
        label:     c.intensity === 'vigorous' ? 'V' : c.intensity === 'moderate' ? 'M' : 'L',
        isActive:  c.is_active,
      }))
      .filter(m => !isNaN(m.startMs)),
    [activityContributions],
  );

  // Defensive fallback: viewCfg.stepMins is set via VIEW_CONFIGS above, but guard
  // against future ChartUtils changes where BASE_VIEW_CONFIGS might drop it again.
  const stepMins = viewCfg.stepMins ?? (viewCfg as any).interpolationInterval ?? 10;

  const chartData = useMemo(
    () => buildChartData(
      normMeals, normDoses, rangeStart, rangeEnd, stepMins, constants, now,
      activityContributions,
      activityPD?.sensitivity_multiplier ?? 1.0, // M-11: live API scalar for sensitivity window
    ),
    [normMeals, normDoses, rangeStart, rangeEnd, stepMins, constants, now, activityContributions, activityPD],
  );

  // Victory data arrays
  const mealAreaData = chartData.map(p => ({ x: p.timestamp, y: p.mealImpact,  y0: 0 }));
  const cumulData    = chartData.map(p => ({ x: p.timestamp, y: p.cumulativeBaseline }));
  const netData      = chartData.map(p => ({ x: p.timestamp, y: p.netEffect }));
  const doseBarData  = chartData
    .filter(p => p.doseMarker !== null)
    .map(p => ({ x: p.timestamp, y: p.doseMarker! * 0.5 }));   // scale for visibility
  const insulinAreaData = chartData.map(p => ({ x: p.timestamp, y: p.insulinImpact, y0: 0 }));
  const insulinDoseBarData = chartData
    .filter(p => p.insulinDoseMarker !== null)
    .map(p => ({ x: p.timestamp, y: p.insulinDoseMarker! }));

  // ── Activity series data (mirrors EffectsVisualizationChart §2a / §2b) ────
  const activityEffectData = useMemo(
    () => chartData.map(p => ({ x: p.timestamp, y: p.activityEffect })),
    [chartData],
  );
  /** AOB shading — fill only for negative (BG-lowering) values */
  const activityAOBShadeData = useMemo(
    () => activityEffectData.map(p => ({ x: p.x, y: Math.min(0, p.y) })),
    [activityEffectData],
  );
  const activityEffectVisible = useMemo(
    () => hasActivityEffect && activityEffectData.some(p => Math.abs(p.y) > 0.1),
    [hasActivityEffect, activityEffectData],
  );

  // Y domain — symmetric around 0, matching EffectsVisualizationChart.
  // Uses the same calculateEffectsAxisDomain logic: take the max absolute value
  // of all series (meal, insulin, cumulative) + 15% padding, then mirror it.
  // The old asymmetric formula [minY*1.2, maxY*1.2] made the chart appear
  // differently scaled vs the patient view when cumulative went very negative.
  const _allAbsValues = [
    30, // minimum floor
    ...chartData.map(p => Math.abs(p.mealImpact)),
    ...chartData.map(p => Math.abs(p.insulinImpact)),
    ...chartData.map(p => Math.abs(p.cumulativeBaseline)),
    ...chartData.map(p => Math.abs(p.activityEffect)),
  ];
  const _maxAbsolute = Math.max(..._allAbsValues);
  const _limit = Math.ceil(_maxAbsolute * 1.15);
  const yDomain: [number, number] = [-_limit, _limit];

  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    const step = viewCfg.tickInterval * 3_600_000;
    let t = Math.ceil(rangeStart / step) * step;
    while (t <= rangeEnd) { ticks.push(t); t += step; }
    return ticks;
  }, [rangeStart, rangeEnd, viewCfg.tickInterval]);

  // Summary stats
  const activeMealsNow = normMeals.filter(m => {
    const mealMs = parseUTCMs(m.timestamp);
    if (isNaN(mealMs)) return false;
    const h = (now - mealMs) / 3_600_000;
    return h >= 0 && h < getMealDurationHours(m);
  });

  const currentEffect = chartData.find(p => Math.abs(p.timestamp - now) < stepMins * 60_000);
  const peakImpact    = Math.max(0, ...chartData.map(p => p.mealImpact));

  if (!meals.length) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyIcon}>🍽️</Text>
        <Text style={s.emptyTitle}>No meal data available</Text>
        <Text style={s.emptySubtitle}>No meals logged for this patient</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Summary bar */}
      <View style={s.summaryBar}>
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: '#f97316' }]}>{activeMealsNow.length}</Text>
          <Text style={s.summaryLabel}>Active{'\n'}Meals</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: currentEffect && currentEffect.netEffect < 0 ? '#9c27b0' : '#f97316' }]}>
            {currentEffect ? `${currentEffect.netEffect >= 0 ? '+' : ''}${Math.round(currentEffect.netEffect)}` : '—'}
          </Text>
          <Text style={s.summaryLabel}>Current{'\n'}Effect mg/dL</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: '#22c55e' }]}>
            {currentEffect ? `${currentEffect.cumulativeBaseline > 0 ? '+' : ''}${Math.round(currentEffect.cumulativeBaseline)}` : '—'}
          </Text>
          <Text style={s.summaryLabel}>Cumulative{'\n'}Shift mg/dL</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: '#374151' }]}>{Math.round(peakImpact)}</Text>
          <Text style={s.summaryLabel}>Peak{'\n'}Impact</Text>
        </View>
      </View>

      {/* View mode */}
      <View style={s.viewModeRow}>
        {(['3h', '6h', '12h', '24h', 'week', 'month'] as const).map(m => (
          <TouchableOpacity
            key={m}
            style={[s.viewBtn, viewMode === m && s.viewBtnActive]}
            onPress={() => setViewMode(m)}
          >
            <Text style={[s.viewBtnText, viewMode === m && s.viewBtnTextActive]}>
              {VIEW_CONFIGS[m].label}
            </Text>
          </TouchableOpacity>
        ))}
        {/* 📅 Custom date-range button */}
        <TouchableOpacity
          style={[s.viewBtn, s.viewBtnCustom, viewMode === 'custom' && s.viewBtnActive]}
          onPress={() => setViewMode('custom')}
        >
          <Text style={[s.viewBtnText, viewMode === 'custom' && s.viewBtnTextActive]}>
            📅 Range
          </Text>
        </TouchableOpacity>
      </View>

      {/* Custom date-range panel */}
      {viewMode === 'custom' && (
        <View style={s.customRangePanel}>
          <View style={s.customRangeRow}>
            <View style={s.customRangePicker}>
              <UnifiedTimePicker
                label="From"
                value={customRangeStart}
                onChange={(iso) => { setCustomRangeStart(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
            <View style={s.customRangePicker}>
              <UnifiedTimePicker
                label="To"
                value={customRangeEnd}
                onChange={(iso) => { setCustomRangeEnd(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
          </View>
          <TouchableOpacity
            style={[s.customRangeApplyBtn, customApplied && s.customRangeAppliedBtn]}
            onPress={() => setCustomApplied(true)}
            disabled={customApplied}
          >
            <Text style={s.customRangeApplyText}>
              {customApplied ? '✓ Applied' : 'Apply Range'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Chart */}
      <View style={s.chartWrap}>
        <VictoryChart
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          domain={{ x: [rangeStart, rangeEnd], y: yDomain }}
          padding={{ top: 16, bottom: 36, left: 52, right: 16 }}
        >
          {/* X axis — pinned to chart floor so ticks always appear at the bottom
               even when insulin pushes the y-domain below zero (mirrors the
               axisValue fix in EffectsVisualizationChart). */}
          <VictoryAxis
            tickValues={xTicks}
            tickFormat={ts => formatXAxis(ts, viewCfg.tickFormat)}
            axisValue={yDomain[0]}
            style={{ axis: { stroke: '#e5e7eb' }, tickLabels: { fontSize: 9, fill: '#9ca3af', angle: -45, textAnchor: 'end' }, grid: { stroke: '#f3f4f6', strokeWidth: 0.5 } }}
          />
          <VictoryAxis
            dependentAxis
            tickFormat={v => `${v > 0 ? '+' : ''}${Math.round(v)}`}
            style={{ axis: { stroke: '#e5e7eb' }, tickLabels: { fontSize: 9, fill: '#9ca3af' }, grid: { stroke: '#f3f4f6', strokeWidth: 0.5 } }}
          />

          {/* Zero reference line — VictoryAxis with axisValue={0} places a
               horizontal dashed line at y=0 (matches patient chart pattern).
               Using a VictoryAxis (not VictoryLine) ensures it is clipped
               correctly to the chart domain. */}
          <VictoryAxis
            axisValue={0}
            tickFormat={() => ''}
            style={{
              axis:  { stroke: '#999', strokeWidth: 1, strokeDasharray: '3 3' },
              ticks: { size: 0 },
              grid:  { stroke: 'none' },
            }}
          />

          {/* Now line */}
          <VictoryAxis
            dependentAxis
            axisValue={now}
            tickFormat={() => ''}
            style={{ axis: { stroke: '#da2a2a', strokeWidth: 1.5, strokeDasharray: '5 4' }, grid: { stroke: 'none' }, ticks: { stroke: 'none', size: 0 }, tickLabels: { fill: 'none', fontSize: 0 } }}
          />

          {/* ── Activity session duration bands ─────────────────────────────────
               One light-blue shaded column per session, spanning start → end.
               Co-located with the session start marker dashed line. */}
          {showActivityEffect && sessionDurationAreas.map((area, i) =>
            area.startMs <= rangeEnd && area.endMs >= rangeStart ? (
              <VictoryArea
                key={`session-band-${i}`}
                data={[
                  { x: Math.max(area.startMs, rangeStart), y: 0 },
                  { x: Math.min(area.endMs,   rangeEnd),   y: 0 },
                ]}
                y0={() => yDomain[0] * 0.38}
                style={{
                  data: {
                    fill:        area.isActive ? '#29B6F6' : '#B2EBF2',
                    fillOpacity: area.isActive ? 0.12 : 0.07,
                    stroke:      'none',
                  },
                }}
              />
            ) : null
          )}

          {/* ── Activity session start markers ──────────────────────────────────
               Short dashed vertical line at the left edge of each session band. */}
          {showActivityEffect && sessionMarkers.map((m, i) =>
            m.startMs >= rangeStart && m.startMs <= rangeEnd ? (
              <VictoryLine
                key={`session-start-${i}`}
                data={[
                  { x: m.startMs, y: 0 },
                  { x: m.startMs, y: yDomain[0] * 0.38 },
                ]}
                style={{
                  data: {
                    stroke:          m.isActive ? '#00897B' : '#26C6DA',
                    strokeWidth:     1.5,
                    strokeDasharray: '4 3',
                  },
                }}
              />
            ) : null
          )}

          {/* ── AOB shading — translucent fill for negative activity values ──────
               Indicates hypoglycaemia risk zone from aerobic exercise. */}
          {showActivityEffect && activityEffectVisible && (
            <VictoryArea
              data={activityAOBShadeData}
              y0={() => 0}
              interpolation="monotoneX"
              style={{
                data: { fill: '#29B6F6', fillOpacity: 0.22, stroke: 'none' },
              }}
            />
          )}

          {/* ── Activity effect line — teal signed cumulative BG contribution ────
               Mirrors EffectsVisualizationChart §2a. Hidden when no activity. */}
          {showActivityEffect && activityEffectVisible && (
            <VictoryLine
              data={activityEffectData}
              interpolation="monotoneX"
              style={{
                data: { stroke: '#00BFA5', strokeWidth: 2.5 },
              }}
            />
          )}

          {/* Meal dose bars */}
          {showDoseMarkers && doseBarData.length > 0 && (
            <VictoryBar
              data={doseBarData}
              barWidth={4}
              style={{ data: { fill: '#f97316', fillOpacity: 0.5 } }}
            />
          )}

          {/* Insulin dose bars */}
          {showDoseMarkers && insulinDoseBarData.length > 0 && (
            <VictoryBar
              data={insulinDoseBarData}
              barWidth={4}
              style={{ data: { fill: '#9c27b0', fillOpacity: 0.5 } }}
            />
          )}

          {/* Insulin effect area (purple, negative) */}
          {showInsulinEffect && (
            <VictoryArea
              data={insulinAreaData}
              interpolation="monotoneX"
              style={{ data: { fill: '#9c27b0', fillOpacity: 0.2, stroke: '#9c27b0', strokeWidth: 2 } }}
            />
          )}

          {/* Meal effect area */}
          {showMealEffect && (
            <VictoryArea
              data={mealAreaData}
              interpolation="monotoneX"
              style={{ data: { fill: '#f97316', fillOpacity: 0.25, stroke: '#f97316', strokeWidth: 2 } }}
            />
          )}

          {/* Cumulative baseline */}
          {showCumulative && (
            <VictoryLine
              data={cumulData}
              interpolation="monotoneX"
              style={{ data: { stroke: '#22c55e', strokeWidth: 2.5 } }}
            />
          )}

          {/* Net effect (dashed blue) */}
          <VictoryLine
            data={netData}
            interpolation="monotoneX"
            style={{ data: { stroke: '#3b82f6', strokeWidth: 1.5, strokeDasharray: '5 3', opacity: 0.7 } }}
          />
        </VictoryChart>
      </View>

      {/* Toggles */}
      <View style={s.toggleRow}>
        {[
          { label: '🍽️ Meal Effect',    value: showMealEffect,     setter: setMeal     },
          { label: '💉 Insulin Effect',   value: showInsulinEffect,  setter: setInsulin  },
          { label: '📈 Cumulative',       value: showCumulative,     setter: setCumul    },
          { label: '📍 Dose Markers',     value: showDoseMarkers,    setter: setMarkers  },
        ].map(({ label, value, setter }) => (
          <View key={label} style={s.toggleItem}>
            <Text style={s.toggleLabel}>{label}</Text>
            <Switch
              value={value}
              onValueChange={setter}
              trackColor={{ false: '#d1d5db', true: '#3b82f620' }}
              thumbColor={value ? '#3b82f6' : '#9ca3af'}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
        ))}
        {/* Activity toggle — only shown when activityPD data is present */}
        {hasActivityEffect && (
          <View style={s.toggleItem}>
            <Text style={s.toggleLabel}>🏃 Activity</Text>
            <Switch
              value={showActivityEffect}
              onValueChange={setActivity}
              trackColor={{ false: '#d1d5db', true: '#00BFA520' }}
              thumbColor={showActivityEffect ? '#00BFA5' : '#9ca3af'}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
        )}
      </View>

      {/* Tooltip modal */}
      {tooltip && (
        <Modal transparent animationType="fade" onRequestClose={() => setTooltip(null)}>
          <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setTooltip(null)}>
            <View style={s.tooltipCard}>
              <Text style={s.tooltipTime}>{formatXAxis(tooltip.point.timestamp, 'HH:mm')}</Text>
              <View style={s.tooltipRow}>
                <Text style={s.tooltipKey}>🍽️ Meal effect</Text>
                <Text style={[s.tooltipVal, { color: '#f97316' }]}>+{Math.round(tooltip.point.mealImpact)} mg/dL</Text>
              </View>
              <View style={s.tooltipRow}>
                <Text style={s.tooltipKey}>📈 Cumulative</Text>
                <Text style={[s.tooltipVal, { color: '#22c55e' }]}>
                  {tooltip.point.cumulativeBaseline >= 0 ? '+' : ''}{Math.round(tooltip.point.cumulativeBaseline)} mg/dL
                </Text>
              </View>
              {Math.abs(tooltip.point.activityEffect) > 0.05 && (
                <View style={s.tooltipRow}>
                  <Text style={s.tooltipKey}>🏃 Activity</Text>
                  <Text style={[s.tooltipVal, { color: tooltip.point.activityEffect < 0 ? '#E53935' : '#00BFA5' }]}>
                    {tooltip.point.activityEffect >= 0 ? '+' : ''}{Math.round(tooltip.point.activityEffect)} mg/dL
                  </Text>
                </View>
              )}
              {tooltip.point.meals.length > 0 && (
                <Text style={s.tooltipMeals}>
                  {tooltip.point.meals.map((m: any) => m.mealType ?? 'Meal').join(', ')}
                </Text>
              )}
              <Text style={s.tooltipClose}>Tap to close</Text>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },

  summaryBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  summaryItem:    { alignItems: 'center', flex: 1 },
  summaryValue:   { fontSize: 18, fontWeight: '700' },
  summaryLabel:   { fontSize: 9,  color: '#9ca3af', marginTop: 2, textAlign: 'center' },
  summaryDivider: { width: 1, height: 36, backgroundColor: '#e5e7eb' },

  viewModeRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  viewBtn:           { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, backgroundColor: '#f5f5f5' },
  viewBtnActive:     { backgroundColor: '#f97316' },
  viewBtnText:       { fontSize: 13, fontWeight: '600', color: '#555' },
  viewBtnTextActive: { color: '#fff' },

  // ── Custom date-range panel ──
  viewBtnCustom:         { borderWidth: 1.5, borderColor: '#f97316', backgroundColor: 'transparent' },
  customRangePanel:      { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#fffbf5' },
  customRangeRow:        { flexDirection: 'row' as const, gap: 8, marginBottom: 4 },
  customRangePicker:     { flex: 1 },
  customRangeApplyBtn:   { backgroundColor: '#f97316', borderRadius: 8, paddingVertical: 10, alignItems: 'center' as const },
  customRangeAppliedBtn: { backgroundColor: '#c2410c' },
  customRangeApplyText:  { color: '#fff', fontWeight: '700' as const, fontSize: 14 },

  chartWrap: {},

  toggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 4,
  },
  toggleItem:  { flexDirection: 'row', alignItems: 'center', marginRight: 12 },
  toggleLabel: { fontSize: 11, color: '#6b7280', marginRight: 4 },

  empty:        { paddingVertical: 48, alignItems: 'center' },
  emptyIcon:    { fontSize: 40, marginBottom: 12 },
  emptyTitle:   { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  emptySubtitle:{ fontSize: 12, color: '#9ca3af', marginTop: 4 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  tooltipCard:  { backgroundColor: '#fff', borderRadius: 12, padding: 20, minWidth: 200, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8 },
  tooltipTime:  { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8 },
  tooltipRow:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  tooltipKey:   { fontSize: 12, color: '#6b7280' },
  tooltipVal:   { fontSize: 12, fontWeight: '600' },
  tooltipMeals: { fontSize: 11, color: '#9ca3af', marginTop: 6 },
  tooltipClose: { fontSize: 11, color: '#d1d5db', marginTop: 12, textAlign: 'center' },
});

export default DoctorEffectsChart;