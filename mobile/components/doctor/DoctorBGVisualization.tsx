/**
 * ============================================================================
 * DOCTOR BG VISUALIZATION
 * Location: mobile/components/doctor/DoctorBGVisualization.tsx
 * ============================================================================
 *
 * Prop-driven adaptation of BloodGlucoseVisualization.tsx for the doctor
 * patient view. Accepts pre-fetched data as props instead of calling patient
 * hooks (useActiveEffects, usePatientConstants, useGlucoseReadings).
 *
 * All chart math is identical to BloodGlucoseVisualization — same
 * buildBGChartPoint(), same calculation stack, same Victory series.
 * The only differences are:
 *
 *   1. DATA SOURCE — props instead of hooks:
 *        meals         MealResponse[]          (from PatientDataView)
 *        insulinDoses  InsulinDoseResponse[]   (from PatientDataView)
 *        bloodSugar    BloodSugarResponse[]     (from PatientDataView)
 *        constants     PatientConstantsData     (from PatientDataView)
 *
 *   2. NO AUTO-REFRESH — data is controlled by the parent.
 *
 *   3. BASELINE — derived from constants.target_glucose (no stableBaseline
 *      hook needed; doctor view is read-only historical data).
 *
 *   4. VIEW MODES — same 6H/12H/24H configs as the patient chart.
 *
 * SYNCED WITH PATIENT CHART (BloodGlucoseVisualization v1.7):
 *
 *   B-15: tau_W casing fix — TAU_W_MIN now reads HR_MODEL.tau_W (was tau_w).
 *
 *   P7 / FIX 11: calculateActivityEffectAtTime() reverted to Z-state decay.
 *     The old 3-phase plateau + TAU_ACUTE_MS (15 min) model was incorrect.
 *     Now: linear ramp during session, then exp decay with τ_Z = 10 min
 *     (SHARED_CONSTANTS.HR_MODEL.tau_Z). No plateau — the τ_W plateau belongs
 *     to calculateSensitivityMultiplierAtTime (ISF/CR boost), not the acute
 *     BG-lowering signal. TAU_ACUTE_MS constant removed.
 *
 *   M-11 / FIX 12: calculateSensitivityMultiplierAtTime() added. buildBGChartPoint()
 *     now applies the W-state sensitivity multiplier per chart point so the
 *     cumulative orange area and projected BG line agree with EVC's green line
 *     during and after exercise sessions. peakSensitivityMultiplier threaded
 *     from activityPD.sensitivity_multiplier → buildBGChartPoint.
 *
 * ============================================================================
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  Modal,
  Platform,
} from 'react-native';

import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryAxis,
  VictoryTheme,
  VictoryScatter,
} from 'victory-native';

import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinChartEffect,
} from '@/utils/insulin/pharmacodynamics';
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { MEAL_ABSORPTION_PROFILES, getCircadianBaseline, SHARED_CONSTANTS } from '@/constants/shared-constants';

// ── Activity PD types ──────────────────────────────────────────────────────────
import type { ActivityPDResult, ActivityContribution } from '@/services/api/activity-pharmacodynamics';

import {
  VIEW_CONFIGS,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  getBloodSugarStatusColor,
  getConfidenceLevel,
  findMealsAtTime,
  findInsulinAtTime,
  useCurrentMinute,
  useChartTimeRange,
  parseUTCMs,
  getLastResetTimeMs,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  formatXAxis,
} from '@/utils/ChartUtils';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

import type { MealResponse, BloodSugarResponse } from '@/types/api';
import type { PatientConstantsData, InsulinDoseResponse } from '@/services/api/doctor';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT = 300;
const CHART_WIDTH  = SCREEN_WIDTH - 48;

const BG_DOMAIN: [number, number] = [40, 400];
const CUMULATIVE_DELTAS = [-150, -100, -50, 0, 50, 100, 150];

/** Break the connected-readings line if two readings are more than 20 min apart. */
const MAX_READING_GAP_MS = 20 * 60 * 1_000;

/**
 * τ_W (90 min) — post-exercise W-state decay constant.
 * Sourced from SHARED_CONSTANTS.HR_MODEL.tau_W — never hardcoded (B-15 fix: tau_w → tau_W).
 * Matches the same constant used in EffectsVisualizationChart and BloodGlucoseVisualization.
 */
const TAU_W_MIN: number = (SHARED_CONSTANTS as any)?.HR_MODEL?.tau_W ?? 90; // B-15: was tau_w (wrong casing)
const TAU_W_MS:  number = TAU_W_MIN * 60_000;

// TAU_ACUTE_MS removed — the old 3-phase plateau + 15 min fast-decay model was incorrect.
// calculateActivityEffectAtTime() now uses Z-state decay (τ_Z = 10 min from SHARED_CONSTANTS)
// matching EffectsVisualizationChart and BloodGlucoseVisualization v1.7 (P7 fix / §9-P7).

// VIEW_CONFIGS imported from ChartUtils (includes 6h, 12h, 24h, 1w, 1m)

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface DoctorBGVisualizationProps {
  meals:        MealResponse[];
  insulinDoses: InsulinDoseResponse[];
  bloodSugar:   BloodSugarResponse[];
  constants:    PatientConstantsData | null;
  height?:      number;
  /**
   * Pre-fetched activity pharmacodynamics result from the parent screen.
   * When provided, activity is baked into the cumulative BG projection
   * (same as BloodGlucoseVisualization). When null the chart degrades gracefully.
   */
  activityPD?:  ActivityPDResult | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface BGChartPoint {
  timestamp:               number;
  formattedTime:           string;
  actualBG:                number | null;
  baseBG:                  number;
  highConfidenceBG:        number | null;
  lowConfidenceBG:         number | null;
  cumulativeNetBaseline:   number;
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;
  netEffect:               number;
  mealImpact:              number;
  insulinImpact:           number;
  isActualReading:         boolean;
  isHistorical:            boolean;
  isFuture:                boolean;
  isNow:                   boolean;
  confidenceLevel:         string;
  confidenceColor:         string;
  mealsAdministered:       any[];
  insulinAdministered:     any[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers  (identical to BloodGlucoseVisualization)
// ─────────────────────────────────────────────────────────────────────────────

// parseUTCMs, getLastResetTimeMs, getMealDurationHours, normaliseDose,
// doseToStacking, formatXAxis all imported from ChartUtils.

/** normaliseMeal keeps local — has extra timestamp-alias resolution specific to doctor API. */
function normaliseMeal(raw: any): any {
  const timestamp =
    raw.timestamp  ?? raw.meal_time ?? raw.logged_at ?? raw.created_at ?? raw.takenAt ?? null;
  return {
    ...raw,
    id:                  raw.id ?? String(raw._id ?? ''),
    timestamp,
    calculation_summary: raw.calculation_summary ?? {},
    nutrition:           raw.nutrition ?? {},
  };
}

/** normaliseReading — matches BloodGlucoseVisualization useGlucoseReadings resolution order. */
function normaliseReading(raw: BloodSugarResponse): { timestamp: number; bloodSugar: number } | null {
  // Same priority order as useGlucoseReadings in BloodGlucoseVisualization (FIX C)
  const ts =
    (raw as any).bloodSugarTimestamp != null ? parseUTCMs((raw as any).bloodSugarTimestamp) :
    (raw as any).timestamp           != null ? parseUTCMs((raw as any).timestamp)           :
    (raw as any).readingTime         != null ? parseUTCMs((raw as any).readingTime)         :
    (raw as any).reading_time        != null ? parseUTCMs((raw as any).reading_time)        :
    (raw as any).taken_at            != null ? parseUTCMs((raw as any).taken_at)            : NaN;

  // Same fallback chain as patient chart
  const bg =
    raw.bloodSugar           ??
    (raw as any).blood_sugar ??
    (raw as any).value       ??
    (raw as any).glucose_value ?? NaN;

  if (isNaN(ts) || isNaN(Number(bg)) || Number(bg) <= 0) return null;
  return { timestamp: ts, bloodSugar: Number(bg) };
}

// formatTickLabel replaced by formatXAxis from ChartUtils

const safeNum = (v: any): number =>
  (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : 0;

// ─────────────────────────────────────────────────────────────────────────────
// Activity effect helper  (mirrors BloodGlucoseVisualization exactly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the signed cumulative activity BG effect at a given time point.
 * Used for the teal overlay line — shows the pharmacodynamic window.
 *
 * Z-state (acute IIRd) decay model — mirrors EffectsVisualizationChart and
 * BloodGlucoseVisualization v1.7 (P7 fix / §9-P7):
 *   • Before session start:              0
 *   • During session (0 → duration):     linear ramp 0 → fullEffect
 *   • Post-exercise (t > end):           W(t) = fullEffect × exp(−t / τ_Z)
 *     τ_Z = SHARED_CONSTANTS.HR_MODEL.tau_Z (default 10 min)
 *
 * WHY no plateau here:
 *   The 90-min τ_W plateau belongs to the W-state SENSITIVITY MULTIPLIER
 *   (calculateSensitivityMultiplierAtTime). The acute BG-lowering Z-state
 *   decays immediately at session end — no plateau before decay. The old
 *   3-phase plateau + τ_acute model was incorrect (§9-P7 / BGV FIX 11).
 *
 * Daily reset guard: sessions starting before resetTimeMs are excluded so the
 * teal line resets at the same daily boundary as every other series.
 *
 * Sign convention: cumulative_bg_effect is already signed (negative = aerobic).
 */
function calculateActivityEffectAtTime(
  targetMs:      number,
  contributions: ActivityContribution[],
  tauWMs:        number,
  resetTimeMs:   number = 0,
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    // Daily reset guard — mirrors calculateActivityEffectForCumulative().
    if (resetTimeMs > 0 && startMs < resetTimeMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      // During session: linear ramp 0 → fullEffect.
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      total += frac * fullEffect;
    } else {
      // Z-state (acute IIRd) decays immediately when exercise ends — no plateau.
      // The 90-min τ_W plateau belongs only to the W-state sensitivity multiplier
      // rendering (calculateSensitivityMultiplierAtTime), not to this acute teal line.
      const TAU_Z_MS = ((SHARED_CONSTANTS as any)?.HR_MODEL?.tau_Z ?? 10) * 60_000;
      const postExerciseMs = targetMs - endMs;
      const recoveryFrac = Math.exp(-postExerciseMs / TAU_Z_MS);
      total += recoveryFrac * fullEffect;
    }
  }
  return total;
}

/**
 * Activity BG effect for the CUMULATIVE ("bank balance") series ONLY.
 *
 * Key differences from calculateActivityEffectAtTime():
 *  1. LOCK-IN: once training ends the effect locks in permanently at fullEffect.
 *     A BG drop from exercise is a real physiological change that does not
 *     reverse on its own — it persists until the patient eats. No plateau,
 *     no decay — the cumulative line rises while training then stays flat.
 *  2. DAILY RESET: sessions starting before resetTimeMs are excluded, matching
 *     calculateTotalCumulativeEffects() for meals and insulin.
 *
 * Mirrors calculateActivityEffectForCumulative() in every sibling chart.
 *
 * @param resetTimeMs - Daily reset boundary; sessions before this are excluded.
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

    // Daily reset guard — mirrors calculateMealCumulativeEffect().
    if (startMs < resetTimeMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      // During session: linear ramp 0 → fullEffect.
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      total += frac * fullEffect;
    } else {
      // Post-exercise: LOCK IN permanently at fullEffect.
      total += fullEffect;
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensitivity multiplier  (FIX 12 / M-11 — mirrors BloodGlucoseVisualization)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the effective insulin-sensitivity multiplier at `targetMs` for
 * a given set of activity contributions.
 *
 * W-state model (three phases — the τ_W plateau is CORRECT here because this
 * function models ISF/CR sensitivity boost, NOT the acute BG-lowering drop):
 *   During session  (startMs → endMs):            ramps 0 → peakBoost
 *   Post-exercise plateau (endMs → endMs + τ_W):  peakBoost (flat)
 *   After plateau   (> endMs + τ_W):              peakBoost × exp(−(t−end−τ_W) / τ_W)
 *
 * Mirrors BloodGlucoseVisualization.calculateSensitivityMultiplierAtTime and
 * EffectsVisualizationChart.calculateSensitivityMultiplierAtTime exactly.
 *
 * @param targetMs       Chart time point in Unix ms
 * @param contributions  activity_contributions from the PD response
 * @param peakMultiplier activityPD.sensitivity_multiplier (live API value)
 * @param tauWMs         τ_W in ms (TAU_W_MS = 90 × 60 × 1000)
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

  const MAX_BOOST = (SHARED_CONSTANTS as any)?.HR_MODEL?.max_sensitivity_boost ?? 0.60;
  const globalPeakBoost = Math.max(0, peakMultiplier - 1);
  let totalBoost = 0;

  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    const durationMs  = (c.duration_minutes ?? 30) * 60_000;
    const endMs       = startMs + durationMs;

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

// ─────────────────────────────────────────────────────────────────────────────
// Per-point calculation  (mirrors BloodGlucoseVisualization.buildBGChartPoint)
// ─────────────────────────────────────────────────────────────────────────────

function buildBGChartPoint(
  targetTimestamp:     number,
  processedMeals:      any[],
  processedInsulin:    any[],
  allMealsInWindow:    any[],
  allDosesInWindow:    any[],
  actualReadings:      Array<{ timestamp: number; bloodSugar: number }>,
  stableBaseline:      number,
  patientConstants:    any,
  minutesSinceReading: number,
  now:                 number,
  halfIntervalMs:      number,
  viewConfig:          any,
  activityContributions: ActivityContribution[] = [],
  tauWMs:              number = TAU_W_MS,
  peakSensitivityMultiplier: number = 1.0, // FIX 12 (M-11): live API sensitivity_multiplier
): BGChartPoint {
  const targetTime = new Date(targetTimestamp);
  const isHistorical = targetTimestamp <= now;
  const isFuture     = targetTimestamp > now;
  const isNow        = Math.abs(targetTimestamp - now) < halfIntervalMs;

  const resetHour:        number = patientConstants?.daily_reset_hour ?? 7;
  const tzOffset:         number = patientConstants?.timezone_offset_minutes ?? 0;
  const correctionFactor: number = patientConstants?.correction_factor ?? 40;

  // ── FIX 12 (M-11): Sensitivity multiplier at this chart time point ──────────
  // Uses the W-state model (plateau + exponential decay), NOT the live API scalar.
  // The live scalar is only authoritative at "now"; historical/future points need
  // the time-resolved function. peakSensitivityMultiplier is the API scalar used
  // as the per-contribution peak when live; intensity fallback when decayed.
  // Mirrors EffectsVisualizationChart.buildChartPoint and BGV.buildBGChartPoint.
  const sensitivityMultiplierAtTime = calculateSensitivityMultiplierAtTime(
    targetTimestamp,
    activityContributions,
    peakSensitivityMultiplier,
    tauWMs,
  );

  // Effective CF for cumulative insulin: insulin lowers BG more during post-exercise
  // sensitivity window (CF × multiplier). Equals correctionFactor when mult === 1.0.
  const effectiveCFForCumulative = correctionFactor * sensitivityMultiplierAtTime;

  // Effective C2B for cumulative meal: carbs raise BG less when sensitivity is
  // elevated (carb_to_bg_factor / multiplier). Mirrors EVC and BGV exactly.
  const effectiveC2BForCumulative =
    (patientConstants?.carb_to_bg_factor ?? 4.0) / sensitivityMultiplierAtTime;

  // patientConstantsForCumulative: inject effective C2B only when the multiplier
  // is meaningfully above 1 (threshold 1.005 suppresses floating-point noise).
  const patientConstantsForCumulative: any = sensitivityMultiplierAtTime > 1.005
    ? { ...patientConstants, carb_to_bg_factor: effectiveC2BForCumulative }
    : patientConstants;

  // baseBG: in preset mode evaluate the circadian curve at this specific hour;
  // in dynamic mode fall back to constants.target_glucose (existing behaviour).
  const resolvedMode = (patientConstants as any)?.baseline_mode ?? 'dynamic';
  const pointHour = ((targetTimestamp + tzOffset * 60_000) / 3_600_000) % 24;
  const baseBG = (resolvedMode === 'preset' && (patientConstants as any)?.circadian_profile)
    ? getCircadianBaseline(pointHour, (patientConstants as any).circadian_profile)
    : (patientConstants?.target_glucose ?? stableBaseline);

  // ── Actual reading at this slot ───────────────────────────────────────────
  let actualBG: number | null = null;
  let isActualReading = false;
  for (const r of actualReadings) {
    if (Math.abs(r.timestamp - targetTimestamp) <= halfIntervalMs) {
      actualBG = r.bloodSugar;
      isActualReading = true;
      break;
    }
  }

  // ── Meal instantaneous effect ─────────────────────────────────────────────
  const activeMealsAtTime = processedMeals.filter((m: any) => {
    const mealMs = typeof m.timestamp === 'number' ? m.timestamp : parseUTCMs(m.timestamp);
    if (isNaN(mealMs) || mealMs > targetTimestamp) return false;
    return (targetTimestamp - mealMs) / 3_600_000 < getMealDurationHours(m);
  });

  const mealResult  = activeMealsAtTime.length > 0
    ? calculateStackedMealEffect(activeMealsAtTime, targetTime, patientConstants)
    : { totalBGElevation: 0 };
  const mealImpact  = safeNum((mealResult as any)?.totalBGElevation);

  // ── Insulin instantaneous effect (S-curve) ────────────────────────────────
  const dosesForStacking: InsulinDoseForStacking[] = processedInsulin
    .map((d: any) => doseToStacking(d, targetTime))
    .filter((d): d is InsulinDoseForStacking => d !== null);

  const insulinResult  = dosesForStacking.length > 0
    ? calculateStackedInsulinChartEffect(dosesForStacking, correctionFactor)
    : { totalBGImpact: 0 };
  const insulinImpact  = safeNum(insulinResult.totalBGImpact);
  const netEffect      = mealImpact + insulinImpact;

  // ── Cumulative bank-balance ───────────────────────────────────────────────
  const allMealsUpToNow = allMealsInWindow.filter(
    (m: any) => !isNaN(parseUTCMs(m?.timestamp)) && parseUTCMs(m.timestamp) <= targetTimestamp
  );
  const allDosesUpToNow = allDosesInWindow.filter(
    (d: any) => !isNaN(parseUTCMs(d?.administrationTime)) && parseUTCMs(d.administrationTime) <= targetTimestamp
  );

  const cumulative = (allMealsUpToNow.length > 0 || allDosesUpToNow.length > 0)
    ? calculateTotalCumulativeEffects(
        allMealsUpToNow, allDosesUpToNow, targetTime,
        patientConstantsForCumulative,      // FIX 12: effective C2B during exercise windows
        MEAL_ABSORPTION_PROFILES as any, resetHour, tzOffset,
        // Do NOT pass activities here — activity injected manually via
        // calculateActivityEffectForCumulative below (double-count guard).
        undefined,
        effectiveCFForCumulative,           // FIX 12: effective CF so insulin depth scales with ISF boost
      )
    : { cumulativeMealEffect: 0, cumulativeInsulinEffect: 0, cumulativeNetBaseline: 0 };

  // ── Daily reset boundary ────────────────────────────────────────────────────
  // Required by both activity helpers so the activity component resets at the
  // same daily boundary as meals and insulin — same pattern as every sibling chart.
  const resetTimeMs = getLastResetTimeMs(targetTime, resetHour, tzOffset);

  // ── Activity contribution to the cumulative "bank balance" (lock-in model) ──
  // Uses calculateActivityEffectForCumulative() — effect locks in permanently
  // once training ends (no plateau, no decay). Matches the pattern in
  // BloodGlucoseVisualization, EffectsVisualizationChart, and DoctorEffectsChart.
  const cumulativeNetBaseline   = safeNum((cumulative as any).cumulativeNetBaseline) +
    calculateActivityEffectForCumulative(targetTimestamp, activityContributions, resetTimeMs);
  const cumulativeMealEffect    = safeNum((cumulative as any).cumulativeMealEffect);
  const cumulativeInsulinEffect = safeNum((cumulative as any).cumulativeInsulinEffect);

  const estimatedBG = baseBG + cumulativeNetBaseline;

  // ── Confidence ────────────────────────────────────────────────────────────
  const conf           = getConfidenceLevel({ isActualReading, isFuture, timestamp: targetTimestamp }, minutesSinceReading);
  const isHighConf     = conf.level === 'actual' || conf.level === 'high' || conf.level === 'projected_high';

  // ── Dose markers ──────────────────────────────────────────────────────────
  const mealsAtTime   = findMealsAtTime(processedMeals, targetTimestamp, halfIntervalMs);
  const insulinAtTime = findInsulinAtTime(processedInsulin, targetTimestamp, halfIntervalMs);

  return {
    timestamp: targetTimestamp,
    formattedTime: formatXAxis(targetTimestamp, viewConfig?.tickFormat ?? 'HH:mm'),

    actualBG,
    baseBG,
    highConfidenceBG: isHighConf  ? (actualBG ?? estimatedBG) : null,
    lowConfidenceBG:  !isHighConf ? estimatedBG              : null,

    cumulativeNetBaseline,
    cumulativeMealEffect,
    cumulativeInsulinEffect,
    netEffect,
    mealImpact,
    insulinImpact,

    isActualReading,
    isHistorical,
    isFuture,
    isNow,
    confidenceLevel: conf.level,
    confidenceColor: conf.color,

    mealsAdministered:   mealsAtTime,
    insulinAdministered: insulinAtTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom view config — derives tick density from selected date range
// ─────────────────────────────────────────────────────────────────────────────

function getCustomViewConfig(start: Date, end: Date): any {
  const durationHours = (end.getTime() - start.getTime()) / 3_600_000;
  const futureHours   = Math.max(0, (end.getTime() - Date.now()) / 3_600_000);
  const pastHours     = Math.max(0, (Date.now() - start.getTime()) / 3_600_000);
  let tickFormat: string;
  let tickInterval: number;
  let interpolationInterval: number;
  if (durationHours <= 6)        { tickFormat = 'HH:mm'; tickInterval = 1;  interpolationInterval = 5;  }
  else if (durationHours <= 24)  { tickFormat = 'HH:mm'; tickInterval = 3;  interpolationInterval = 15; }
  else if (durationHours <= 72)  { tickFormat = 'DD/MM'; tickInterval = 12; interpolationInterval = 30; }
  else if (durationHours <= 168) { tickFormat = 'DD/MM'; tickInterval = 24; interpolationInterval = 60; }
  else                           { tickFormat = 'DD/MM'; tickInterval = 72; interpolationInterval = 60; }
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, interpolationInterval, mealLookback: pastHours, insulinLookback: pastHours };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const DoctorBGVisualization: React.FC<DoctorBGVisualizationProps> = ({
  meals,
  insulinDoses,
  bloodSugar,
  constants,
  height = CHART_HEIGHT,
  activityPD = null,
}) => {
  const [viewMode,   setViewMode]   = useState<'6h' | '12h' | '24h' | 'week' | 'month' | 'custom'>('12h');

  // ── Custom date-range filter ────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);

  const [chartData,  setChartData]  = useState<BGChartPoint[]>([]);
  const [generating, setGenerating] = useState(false);

  // Series toggles
  const [showBaseline,         setShowBaseline]         = useState(true);
  const [showActualReadings,   setShowActualReadings]   = useState(true);
  const [showEstimatedLine,    setShowEstimatedLine]     = useState(true);
  const [showTargetRange,      setShowTargetRange]       = useState(true);
  const [showCumulativeEffect, setShowCumulativeEffect]  = useState(true);
  const [showNetEffect,        setShowNetEffect]         = useState(false);

  const [tooltipData, setTooltipData] = useState<{ point: BGChartPoint } | null>(null);

  const currentMinute  = useCurrentMinute();
  const _hookTimeRange = useChartTimeRange(viewMode === 'custom' ? '24h' : viewMode, currentMinute);

  const timeRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied) {
      return { start: customRangeStart.getTime(), end: customRangeEnd.getTime(), now: Date.now() };
    }
    // ── 24H: start from today's daily reset (e.g. 7 AM) to match the patient
    //         chart, rather than a rolling 24h window that shifts every minute.
    if (viewMode === '24h' && constants) {
      const resetHour = (constants as any)?.daily_reset_hour ?? 7;
      const tzOffset  = (constants as any)?.timezone_offset_minutes ?? 0;
      // getLastResetTimeMs returns TODAY's reset (e.g. today 07:00).
      // The patient chart's useChartTimeRange('24h') starts from YESTERDAY's reset
      // so the full prior day is visible. Subtract 24h to match that behaviour.
      const resetStart = getLastResetTimeMs(new Date(), resetHour, tzOffset) - 24 * 3_600_000;
      return { ..._hookTimeRange, start: resetStart };
    }
    return _hookTimeRange;
  }, [viewMode, customApplied, customRangeStart, customRangeEnd, _hookTimeRange, constants]);

  const viewConfig = useMemo(() =>
    viewMode === 'custom'
      ? getCustomViewConfig(customRangeStart, customRangeEnd)
      : VIEW_CONFIGS[viewMode],
  [viewMode, customRangeStart, customRangeEnd]);

  const { start: rangeStart, end: rangeEnd } = timeRange;

  // Derived values from constants
  const effectiveTarget: number   = constants?.target_glucose ?? 100;
  const effectiveBaseline: number = effectiveTarget; // doctor view uses target as baseline
  const patientConstants: any     = constants;

  // ── Normalise raw data ───────────────────────────────────────────────────
  const normMeals = useMemo(() => meals.map(normaliseMeal),        [meals]);
  const normDoses = useMemo(() => insulinDoses.map(normaliseDose), [insulinDoses]);

  // ── Activity contributions (baked into BG projection, same as patient chart) ─
  const activityContributions = useMemo<ActivityContribution[]>(
    () => activityPD?.activity_contributions ?? [],
    [activityPD],
  );

  const normReadings = useMemo(() =>
    bloodSugar
      .map(normaliseReading)
      .filter((r): r is { timestamp: number; bloodSugar: number } => r !== null)
      .sort((a, b) => a.timestamp - b.timestamp),
    [bloodSugar]
  );

  // ── Filter readings to current view window ───────────────────────────────
  const viewReadings = useMemo(
    () => normReadings.filter(r => r.timestamp >= rangeStart && r.timestamp <= rangeEnd),
    [normReadings, rangeStart, rangeEnd]
  );

  /** Minutes since most recent actual reading (for confidence level). */
  const minutesSinceReading = useMemo(() => {
    if (viewReadings.length === 0) return 999;
    return (Date.now() - viewReadings[viewReadings.length - 1].timestamp) / 60_000;
  }, [viewReadings]);

  // ── Processed meals / insulin (time-range filtered for active-effect calc) ─
  const processedMeals = useMemo(
    () => processContextMealsForChart(normMeals, timeRange, patientConstants),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normMeals, rangeStart, rangeEnd, patientConstants]
  );

  const processedInsulin = useMemo(
    () => processContextInsulinForChart(normDoses, timeRange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normDoses, rangeStart, rangeEnd]
  );

  // ── All-window arrays for cumulative bank-balance calc ───────────────────
  // Lower bound anchored to the reset at the START of the chart window (not
  // always today's reset) so post-reset meals from historical daily windows
  // are correctly included for multi-day views.  Mirrors the fix applied in
  // EffectsVisualizationChart and BloodGlucoseVisualization.
  const { allMealsInWindow, allDosesInWindow } = useMemo(() => {
    if (!constants) return { allMealsInWindow: [], allDosesInWindow: [] };
    const resetHour  = (constants as any)?.daily_reset_hour ?? 7;
    const tzOffset   = (constants as any)?.timezone_offset_minutes ?? 0;
    const now        = Date.now();

    // Anchor to the reset applicable at rangeStart (not always today's reset).
    // Math.min(rangeStart, now) guards against custom ranges with a future start.
    const earliestReset = getLastResetTimeMs(
      new Date(Math.min(rangeStart, now)), resetHour, tzOffset
    );
    const startBound = Math.min(rangeStart, earliestReset);

    return {
      allMealsInWindow: normMeals.filter(m => {
        const ms = parseUTCMs(m?.timestamp);
        // ✅ FIX: use rangeEnd (not `now`) so future-snapped meals reach
        // calculateTotalCumulativeEffects. Safe because
        // calculateAbsorbedFraction returns 0 before the meal's timestamp.
        return !isNaN(ms) && ms >= startBound && ms <= rangeEnd;
      }),
      allDosesInWindow: normDoses.filter(d => {
        const ms = parseUTCMs(d?.administrationTime);
        return !isNaN(ms) && ms >= startBound && ms <= now;
      }),
    };
  }, [normMeals, normDoses, constants, rangeStart, rangeEnd]);

  // ── Chart generation ─────────────────────────────────────────────────────
  const generateChartData = useCallback(() => {
    if (!constants) return;
    setGenerating(true);
    try {
      const { start, end, now } = timeRange;
      const intervalMs   = viewConfig.interpolationInterval * 60 * 1_000;
      const halfInterval = intervalMs / 2;

      const timePoints: number[] = [];
      for (let t = start; t <= end; t += intervalMs) {
        const n = Math.round(t / 60_000) * 60_000;
        if (!timePoints.length || timePoints[timePoints.length - 1] !== n) timePoints.push(n);
      }

      const points = timePoints.map(ts =>
        buildBGChartPoint(
          ts,
          processedMeals, processedInsulin,
          allMealsInWindow, allDosesInWindow,
          viewReadings,
          effectiveBaseline, patientConstants,
          minutesSinceReading,
          now ?? Date.now(), halfInterval, viewConfig,
          activityContributions,
          TAU_W_MS,
          activityPD?.sensitivity_multiplier ?? 1.0, // FIX 12 (M-11): live API scalar for sensitivity window
        )
      );
      setChartData(points);
    } catch (e) {
      console.error('[DoctorBGVisualization] generateChartData error:', e);
    } finally {
      setGenerating(false);
    }
  }, [
    constants, processedMeals, processedInsulin,
    allMealsInWindow, allDosesInWindow,
    viewReadings, effectiveBaseline, minutesSinceReading,
    timeRange, viewConfig, activityContributions,
  ]);

  useEffect(() => {
    const id = setTimeout(generateChartData, 200);
    return () => clearTimeout(id);
  }, [generateChartData]);

  // ── Victory data series ──────────────────────────────────────────────────
  const baselineData       = useMemo(() => chartData.map(p => ({ x: p.timestamp, y: p.baseBG           })), [chartData]);

  const cumulativeNetData = useMemo(() =>
    chartData.map(p => ({ x: p.timestamp, y: p.baseBG + p.cumulativeNetBaseline, y0: p.baseBG })),
    [chartData]
  );
  const netEffectData = useMemo(() =>
    chartData.map(p => ({ x: p.timestamp, y: p.baseBG + p.netEffect, y0: p.baseBG })),
    [chartData]
  );
  const actualReadingsData = useMemo(() =>
    chartData
      .filter(p => p.isActualReading && p.actualBG !== null)
      .map(p => ({ x: p.timestamp, y: p.actualBG!, color: getBloodSugarStatusColor(p.actualBG!, effectiveTarget), point: p })),
    [chartData, effectiveTarget]
  );

  // Connected readings line — joins consecutive actual readings, inserts a null
  // break when two readings are more than MAX_READING_GAP_MS apart so the line
  // does not draw a long diagonal across sensor gaps (matches patient chart exactly).
  const connectedReadingsData = useMemo(() => {
    const pts = chartData
      .filter(p => p.isActualReading && p.actualBG !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (pts.length === 0) return [];
    const result: Array<{ x: number; y: number | null }> = [];
    for (let i = 0; i < pts.length; i++) {
      result.push({ x: pts[i].timestamp, y: pts[i].actualBG! });
      if (
        i < pts.length - 1 &&
        pts[i + 1].timestamp - pts[i].timestamp > MAX_READING_GAP_MS
      ) {
        result.push({ x: pts[i].timestamp + 1, y: null });
      }
    }
    return result;
  }, [chartData]);

  const cumulativeAxisTicks = useMemo(() => CUMULATIVE_DELTAS.map(d => effectiveBaseline + d), [effectiveBaseline]);
  const xTicks              = useMemo(() => generateXAxisTicks(timeRange, viewConfig), [timeRange, viewConfig]);

  const targetHigh = effectiveTarget * 1.3;
  const targetLow  = effectiveTarget * 0.7;

  const nowPoint        = chartData.find(p => p.isNow) ?? chartData[Math.floor(chartData.length / 2)];
  const currentEstBG    = nowPoint ? nowPoint.baseBG + nowPoint.cumulativeNetBaseline : effectiveBaseline;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={s.container}>

      {/* View mode */}
      <View style={s.viewModeRow}>
        {(['6h', '12h', '24h', 'week', 'month'] as const).map(m => (
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

      {/* Series toggles */}
      <View style={s.toggleGrid}>
        <ToggleRow label="🔵 Baseline"         color="#2196F3" value={showBaseline}         onChange={setShowBaseline}         />
        <ToggleRow label="🔴 Readings"          color="#E53935" value={showActualReadings}   onChange={setShowActualReadings}   />
        <ToggleRow label="🟣 BG Readings"      color="#8031A7" value={showEstimatedLine}    onChange={setShowEstimatedLine}    />
        <ToggleRow label="🎯 Target Range"      color="#4CAF50" value={showTargetRange}      onChange={setShowTargetRange}      />
        <ToggleRow label="🟠 Cumulative ⭐"    color="#FF9800" value={showCumulativeEffect}  onChange={setShowCumulativeEffect}  bold />
        <ToggleRow label="🟢 Net Effect"        color="#4CAF50" value={showNetEffect}         onChange={setShowNetEffect}         />
      </View>

      {/* Chart */}
      <View style={s.chartWrapper}>
        {generating && chartData.length === 0 ? (
          <View style={[s.centered, { height }]}>
            <ActivityIndicator size="small" color="#8031A7" />
            <Text style={s.loadingText}>Calculating…</Text>
          </View>
        ) : chartData.length > 0 ? (
          <VictoryChart
            width={CHART_WIDTH}
            height={height}
            theme={VictoryTheme.material}
            domain={{ x: [timeRange.start, timeRange.end], y: BG_DOMAIN }}
            padding={{ top: 16, bottom: 48, left: 56, right: 56 }}
          >
            {/* X Axis — pinned to chart floor */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={(t: number) => formatXAxis(t, viewConfig.tickFormat)}
              axisValue={BG_DOMAIN[0]}
              style={{
                tickLabels: { fontSize: 9, angle: -45, textAnchor: 'end', fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (left) — Blood Glucose mg/dL */}
            <VictoryAxis
              dependentAxis
              tickValues={[40, 80, 100, 120, 140, 180, 200, 250, 300, 350, 400]}
              tickFormat={(v: number) => `${Math.round(v)}`}
              label="mg/dL"
              style={{
                axisLabel:  { fontSize: 10, fill: '#444', padding: 38 },
                tickLabels: { fontSize: 9,  fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (right) — Cumulative delta labels */}
            {showCumulativeEffect && (
              <VictoryAxis
                dependentAxis
                orientation="right"
                tickValues={cumulativeAxisTicks}
                tickFormat={(_v: number, i: number) => {
                  const d = CUMULATIVE_DELTAS[i];
                  return d === 0 ? '0' : d > 0 ? `+${d}` : `${d}`;
                }}
                style={{
                  axis:       { stroke: '#FF9800', strokeWidth: 1 },
                  tickLabels: { fontSize: 8, fill: '#FF9800' },
                  grid:       { stroke: 'none' },
                  ticks:      { stroke: '#FF9800', size: 4 },
                }}
              />
            )}

            {/* Target range reference lines */}
            {showTargetRange && (
              <VictoryAxis axisValue={targetHigh} tickFormat={() => ''}
                style={{ axis: { stroke: '#FF8800', strokeWidth: 1, strokeDasharray: '5 5' } }} />
            )}
            {showTargetRange && (
              <VictoryAxis axisValue={effectiveTarget} tickFormat={() => ''}
                style={{ axis: { stroke: '#4CAF50', strokeWidth: 1, strokeDasharray: '3 3' } }} />
            )}
            {showTargetRange && (
              <VictoryAxis axisValue={targetLow} tickFormat={() => ''}
                style={{ axis: { stroke: '#E53935', strokeWidth: 1, strokeDasharray: '5 5' } }} />
            )}

            {/* "Now" vertical line */}
            {timeRange.now && (
              <VictoryAxis
                dependentAxis
                axisValue={timeRange.now}
                tickFormat={() => ''}
                style={{
                  axis:       { stroke: '#da2a2a', strokeWidth: 1.5, strokeDasharray: '5 4' },
                  grid:       { stroke: 'none' },
                  ticks:      { size: 0 },
                  tickLabels: { fill: 'none', fontSize: 0 },
                }}
              />
            )}

            {/* Cumulative net effect area (orange) */}
            {showCumulativeEffect && (
              <VictoryArea
                data={cumulativeNetData}
                defined={(d: any) => d.y != null && !isNaN(d.y) && d.y0 != null && !isNaN(d.y0)}
                interpolation="monotoneX"
                style={{ data: { fill: '#FF9800', fillOpacity: 0.4, stroke: '#FF9800', strokeWidth: 1 } }}
              />
            )}

            {/* Net effect area (green) */}
            {showNetEffect && (
              <VictoryArea
                data={netEffectData}
                defined={(d: any) => d.y != null && !isNaN(d.y) && d.y0 != null && !isNaN(d.y0)}
                interpolation="monotoneX"
                style={{ data: { fill: '#4CAF50', fillOpacity: 0.25, stroke: '#4CAF50', strokeWidth: 1.5 } }}
              />
            )}

            {/* T1D Baseline (blue dashed step) */}
            {showBaseline && (
              <VictoryLine
                data={baselineData}
                interpolation="stepAfter"
                style={{ data: { stroke: '#2196F3', strokeWidth: 2, strokeDasharray: '8 4', opacity: 0.8 } }}
              />
            )}

            {/* Connected BG readings line (solid purple) — mirrors patient chart */}
            {showEstimatedLine && (
              <VictoryLine
                data={connectedReadingsData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y)}
                interpolation="monotoneX"
                style={{ data: { stroke: '#8031A7', strokeWidth: 2.5 } }}
              />
            )}

            {/* Actual reading dots */}
            {showActualReadings && actualReadingsData.length > 0 && (
              <VictoryScatter
                data={actualReadingsData}
                size={3}
                style={{
                  data: {
                    fill:        ({ datum }: any) => datum.color ?? '#E53935',
                    stroke:      '#fff',
                    strokeWidth: 1,
                  },
                }}
                events={Platform.OS !== 'web' ? [{
                  target: 'data',
                  eventHandlers: {
                    onPress: () => [{
                      target: 'data',
                      mutation: ({ datum }: any) => {
                        setTooltipData({ point: datum.point });
                        return null;
                      },
                    }],
                  },
                }] : []}
              />
            )}
          </VictoryChart>
        ) : (
          <View style={[s.centered, { height: height * 0.5 }]}>
            <Text style={s.emptyIcon}>📊</Text>
            <Text style={s.emptyText}>No blood glucose data in this period.</Text>
          </View>
        )}
      </View>

      {/* Legend */}
      <View style={s.legend}>
        {showBaseline         && <LegendItem color="#2196F3" label="Baseline"     dashed />}
        {showEstimatedLine    && <LegendItem color="#8031A7" label="BG Readings" dashed={false} />}
        {showActualReadings   && <LegendItem color="#E53935" label="Readings"     dashed={false} isCircle />}
        {showCumulativeEffect && <LegendItem color="#FF9800" label="Cumulative ⭐" dashed={false} />}
        {showNetEffect        && <LegendItem color="#4CAF50" label="Net Effect"   dashed={false} />}
      </View>

      {/* Now summary strip */}
      {nowPoint && (
        <View style={s.nowSummary}>
          <View style={s.nowSummaryMain}>
            <Text style={s.nowLabel}>Current BG Estimate</Text>
            <Text style={[
              s.nowBG,
              currentEstBG > targetHigh ? s.textHigh :
              currentEstBG < targetLow  ? s.textLow  : s.textNormal,
            ]}>
              {Math.round(currentEstBG)} mg/dL
            </Text>
            <Text style={s.nowDetail}>
              Baseline {Math.round(effectiveBaseline)}{' '}
              {nowPoint.cumulativeNetBaseline >= 0 ? '+' : ''}
              {Math.round(nowPoint.cumulativeNetBaseline)} cumulative
            </Text>
          </View>
          <View style={s.nowSummaryRight}>
            <SummaryPill label="Meals"   value={`+${Math.round(nowPoint.cumulativeMealEffect)}`}    color="#FF9800" />
            <SummaryPill label="Insulin" value={`${Math.round(nowPoint.cumulativeInsulinEffect)}`}  color="#9C27B0" />
            <SummaryPill
              label="Net"
              value={`${nowPoint.cumulativeNetBaseline >= 0 ? '+' : ''}${Math.round(nowPoint.cumulativeNetBaseline)}`}
              color="#2196F3"
            />
          </View>
        </View>
      )}

      {/* Tooltip modal */}
      {tooltipData && (
        <BGTooltipModal
          data={tooltipData.point}
          stableBaseline={effectiveBaseline}
          targetGlucose={effectiveTarget}
          onClose={() => setTooltipData(null)}
        />
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

const ToggleRow: React.FC<{
  label: string; color: string; value: boolean; onChange: (v: boolean) => void; bold?: boolean;
}> = ({ label, color, value, onChange, bold }) => (
  <View style={s.toggleRow}>
    <View style={[s.toggleSwatch, { backgroundColor: color }]} />
    <Text style={[s.toggleLabel, bold && s.toggleLabelBold]}>{label}</Text>
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ true: color, false: '#ccc' }}
      thumbColor={value ? '#fff' : '#f4f3f4'}
      style={s.toggleSwitch}
    />
  </View>
);

const LegendItem: React.FC<{ color: string; label: string; dashed: boolean; isCircle?: boolean }> = ({
  color, label, dashed, isCircle,
}) => (
  <View style={s.legendItem}>
    {isCircle
      ? <View style={[s.legendDot, { backgroundColor: color }]} />
      : <View style={[s.legendLine, { backgroundColor: color }, dashed && s.legendLineDashed]} />
    }
    <Text style={s.legendLabel}>{label}</Text>
  </View>
);

const SummaryPill: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <View style={[s.pill, { borderColor: color }]}>
    <Text style={s.pillLabel}>{label}</Text>
    <Text style={[s.pillValue, { color }]}>{value}</Text>
  </View>
);

const BGTooltipModal: React.FC<{
  data: BGChartPoint; stableBaseline: number; targetGlucose: number; onClose: () => void;
}> = ({ data, stableBaseline, targetGlucose, onClose }) => {
  const estimatedBG = data.baseBG + data.cumulativeNetBaseline;
  const bgColor     = getBloodSugarStatusColor(estimatedBG, targetGlucose);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={s.modalCard}>
          <View style={s.modalHeader}>
            <Text style={s.modalTime}>
              {data.formattedTime}{data.isNow ? '  🔴 Now' : ''}{data.isFuture ? '  🔮 Future' : ''}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView>
            {/* BG */}
            <View style={s.modalSection}>
              <Text style={s.modalSectionTitle}>📊 Blood Glucose</Text>
              {data.actualBG != null && (
                <View style={s.modalRow}>
                  <Text style={s.modalLabel}>Actual Reading:</Text>
                  <Text style={[s.modalValue, { color: bgColor }]}>{Math.round(data.actualBG)} mg/dL</Text>
                </View>
              )}
              <View style={s.modalRow}>
                <Text style={s.modalLabel}>Baseline:</Text>
                <Text style={[s.modalValue, { color: '#2196F3' }]}>{Math.round(data.baseBG)} mg/dL</Text>
              </View>
              <View style={s.modalRow}>
                <Text style={s.modalLabel}>Cumulative Effect:</Text>
                <Text style={[s.modalValue, { color: data.cumulativeNetBaseline >= 0 ? '#FF9800' : '#2196F3' }]}>
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}{Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </View>
              <View style={[s.modalRow, s.modalRowHighlight]}>
                <Text style={[s.modalLabel, { fontWeight: '700' }]}>Projected BG:</Text>
                <Text style={[s.modalValue, { color: bgColor, fontWeight: '700' }]}>{Math.round(estimatedBG)} mg/dL</Text>
              </View>
            </View>

            {/* Cumulative breakdown */}
            <View style={[s.modalSection, { borderColor: '#FF9800' }]}>
              <Text style={s.modalSectionTitle}>🏦 Cumulative Bank Balance</Text>
              <View style={s.modalRow}>
                <Text style={s.modalLabel}>🍽️ Meals:</Text>
                <Text style={[s.modalValue, { color: '#FF9800' }]}>+{Math.round(data.cumulativeMealEffect)} mg/dL</Text>
              </View>
              <View style={s.modalRow}>
                <Text style={s.modalLabel}>💉 Insulin:</Text>
                <Text style={[s.modalValue, { color: '#9C27B0' }]}>{Math.round(data.cumulativeInsulinEffect)} mg/dL</Text>
              </View>
              <View style={s.modalRow}>
                <Text style={s.modalLabel}>Net:</Text>
                <Text style={[s.modalValue, { color: data.cumulativeNetBaseline >= 0 ? '#FF9800' : '#2196F3' }]}>
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}{Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </View>
            </View>

            {/* Meals at this time */}
            {data.mealsAdministered.length > 0 && (
              <View style={[s.modalSection, { borderColor: '#FF9800' }]}>
                <Text style={s.modalSectionTitle}>🍽️ Meals ({data.mealsAdministered.length})</Text>
                {data.mealsAdministered.map((m: any, i: number) => {
                  const carbs =
                    m.calculation_summary?.total_carb_equiv ??
                    m.nutrition?.total_carb_equiv ?? m.nutrition?.carbs ?? 0;
                  return (
                    <View key={i} style={s.doseItem}>
                      <Text style={s.doseTime}>
                        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                      <Text style={s.doseDetail}>{(carbs).toFixed(1)}g carb equiv</Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Insulin at this time */}
            {data.insulinAdministered.length > 0 && (
              <View style={[s.modalSection, { borderColor: '#9C27B0' }]}>
                <Text style={s.modalSectionTitle}>💉 Insulin ({data.insulinAdministered.length})</Text>
                {data.insulinAdministered.map((d: any, i: number) => (
                  <View key={i} style={s.doseItem}>
                    <Text style={s.doseTime}>
                      {new Date(d.administrationTime ?? d.taken_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                    <Text style={s.doseDetail}>
                      {(d.dose ?? d.units ?? 0).toFixed(1)} U {d.medication ?? d.insulinType ?? ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={s.modalFooter}>Tap outside to close</Text>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:      { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  centered:       { alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText:    { marginTop: 8, fontSize: 13, color: '#666' },
  emptyIcon:      { fontSize: 32, marginBottom: 8 },
  emptyText:      { fontSize: 13, color: '#999', textAlign: 'center' },

  viewModeRow: {
    flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8,
    gap: 6, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  viewBtn:           { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, backgroundColor: '#f5f5f5' },
  viewBtnActive:     { backgroundColor: '#8031A7' },
  viewBtnText:       { fontSize: 13, fontWeight: '600', color: '#555' },
  viewBtnTextActive: { color: '#fff' },

  // ── Custom date-range panel ──
  viewBtnCustom:         { borderWidth: 1.5, borderColor: '#8031A7', backgroundColor: 'transparent' },
  customRangePanel:      { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#fdf8ff' },
  customRangeRow:        { flexDirection: 'row' as const, gap: 8, marginBottom: 4 },
  customRangePicker:     { flex: 1 },
  customRangeApplyBtn:   { backgroundColor: '#8031A7', borderRadius: 8, paddingVertical: 10, alignItems: 'center' as const },
  customRangeAppliedBtn: { backgroundColor: '#6a1b9a' },
  customRangeApplyText:  { color: '#fff', fontWeight: '700' as const, fontSize: 14 },

  toggleGrid: {
    flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12,
    paddingVertical: 8, gap: 4, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  toggleRow:       { flexDirection: 'row', alignItems: 'center', width: '48%', marginBottom: 4 },
  toggleSwatch:    { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  toggleLabel:     { flex: 1, fontSize: 11, color: '#444' },
  toggleLabelBold: { fontWeight: '700', color: '#E65100' },
  toggleSwitch:    { transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] },

  chartWrapper: {},

  legend: {
    flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16,
    paddingTop: 4, paddingBottom: 8, gap: 12,
    borderTopWidth: 1, borderTopColor: '#f0f0f0',
  },
  legendItem:      { flexDirection: 'row', alignItems: 'center' },
  legendLine:      { width: 20, height: 3, borderRadius: 1.5, marginRight: 4 },
  legendLineDashed: { opacity: 0.6 },
  legendDot:       { width: 10, height: 10, borderRadius: 5, marginRight: 4, borderWidth: 1.5, borderColor: '#fff' },
  legendLabel:     { fontSize: 11, color: '#555' },

  nowSummary: {
    flexDirection: 'row', padding: 12, margin: 12,
    backgroundColor: '#f8f4ff', borderRadius: 10, borderWidth: 1, borderColor: '#e0d4f0',
  },
  nowSummaryMain:  { flex: 1 },
  nowLabel:        { fontSize: 11, color: '#666', marginBottom: 2 },
  nowBG:           { fontSize: 28, fontWeight: '700' },
  textHigh:        { color: '#FF6B00' },
  textLow:         { color: '#E53935' },
  textNormal:      { color: '#8031A7' },
  nowDetail:       { fontSize: 11, color: '#888', marginTop: 2 },
  nowSummaryRight: { alignItems: 'flex-end', gap: 4 },
  pill:            { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1, backgroundColor: '#fff' },
  pillLabel:       { fontSize: 10, color: '#888' },
  pillValue:       { fontSize: 12, fontWeight: '700' },

  modalOverlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 24 },
  modalCard:        { backgroundColor: '#fff', borderRadius: 14, maxHeight: '85%', overflow: 'hidden' },
  modalHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  modalTime:        { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  modalClose:       { fontSize: 18, color: '#888', padding: 4 },
  modalSection:     { marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: '#f9fafb', borderWidth: 1.5, borderColor: '#e0e0e0' },
  modalSectionTitle:{ fontSize: 12, fontWeight: '700', color: '#333', textTransform: 'uppercase', marginBottom: 8 },
  modalRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  modalRowHighlight:{ backgroundColor: '#f0ebff', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginTop: 4 },
  modalLabel:       { fontSize: 13, color: '#555' },
  modalValue:       { fontSize: 13, fontWeight: '600' },
  doseItem:         { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', marginBottom: 4 },
  doseTime:         { fontSize: 12, fontWeight: '600', color: '#333' },
  doseDetail:       { fontSize: 12, color: '#555' },
  modalFooter:      { textAlign: 'center', fontSize: 11, color: '#999', marginVertical: 12 },
});

export default DoctorBGVisualization;