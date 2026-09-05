/**
 * ============================================================================
 * BLOOD GLUCOSE VISUALIZATION — Mobile Port (React Native)
 * ============================================================================
 *
 * Ported from: frontend/src/components/BloodSugarVisualization.js (v3.0)
 * Location:    mobile/components/charts/BloodGlucoseVisualization.tsx
 *
 * v1.1 FIXES — cumulative effect area was always invisible:
 *
 *   FIX 1 — normaliseMeal() now resolves all backend timestamp aliases
 *            (meal_time, logged_at, created_at, takenAt) in addition to
 *            `timestamp`. Without this, parseUTCMs(m?.timestamp) returned NaN
 *            for every meal because the backend often shapes meals with
 *            meal_time as the date key. This made allMealsInWindow always [],
 *            so calculateTotalCumulativeEffects was never called, and
 *            cumulativeNetBaseline was 0 for every chart point → the
 *            VictoryArea fill collapsed to zero height and was invisible
 *            despite the toggle being on.
 *
 *   FIX 2 — netEffectData now anchors to p.baseBG (baked into each chart
 *            point at generation time) instead of the outer effectiveBaseline
 *            (derived async from stableBaseline). This keeps the net-effect
 *            area and the cumulative area on the same baseline, preventing
 *            visual misalignment when stableBaseline resolves after chart
 *            generation has already run.
 *
 * v1.2 FIXES — align allMealsInWindow / allDosesInWindow with
 *              EffectsVisualizationChart.tsx reset-hour handling:
 *
 *   FIX 3 — allMealsInWindow now adds `mealMs <= now` upper bound so future
 *            meals are excluded from the cumulative bank-balance calculation.
 *            calculateMealCumulativeEffect already guards against this, but the
 *            explicit upper bound reduces array size and matches the intent of
 *            the EffectsVisualizationChart pattern.
 *
 *   FIX 4 — allMealsInWindow lower bound now documented as
 *            Math.min(rangeStart, lastResetMs). For '12h'/'24h' views
 *            rangeStart already equals the daily reset boundary so both are
 *            equivalent. For short views (e.g. '6h' at noon: rangeStart=8AM,
 *            reset=7AM) using lastResetMs ensures post-reset meals eaten
 *            BEFORE rangeStart are counted in the bank balance — matching the
 *            JS version's behaviour and preventing a 0-height cumulative area
 *            for the first hour after the reset window opens.
 *
 *   FIX 5 — Verbose / partially-incorrect comment block replaced with a
 *            concise explanation matching EffectsVisualizationChart.tsx so the
 *            two components stay easy to cross-reference.
 *
 * v1.3 FIXES — useGlucoseReadings returning far fewer points than JS version:
 *
 *   ROOT CAUSE A — Wrong API parameter names:
 *     The hook was sending `start` / `end` but the backend expects
 *     `start_time` / `end_time` (matching glucose.ts → GetGlucoseParams).
 *     The backend silently ignored the unknown keys, so no server-side
 *     filtering occurred and the response shape was unpredictable.
 *
 *   ROOT CAUSE B — Missing filter_by=reading_time:
 *     BloodSugarDataContext.js always passes `filter_by=reading_time` so the
 *     backend filters by bloodSugarTimestamp (actual reading time) rather than
 *     the database insertion timestamp. Without this, readings taken hours
 *     before insertion could fall outside the query window.
 *
 *   ROOT CAUSE C — Narrow fetch window tied to chart range:
 *     The JS context always pre-fetches a FULL 24-hour buffer and filters
 *     client-side. The TSX version was fetching only the visible chart range
 *     (e.g. 12h). A race condition (rangeStart not yet stable after the
 *     ChartUtils 7 AM anchor correction) caused the first fetch to fire with
 *     a future rangeStart → zero readings returned.
 *
 *   FIX 6 — useGlucoseReadings now:
 *     1. Always fetches a full 24-hour buffer using start_time / end_time
 *        with filter_by=reading_time (matching BloodSugarDataContext.js line 488)
 *     2. Also resolves bloodSugarTimestamp (the primary backend field name for
 *        LibreLinkUp / manual readings) in the timestamp normalisation map.
 *     3. Filters the 24h buffer client-side to [rangeStart, rangeEnd] before
 *        exposing `readings` to the chart, matching the JS pattern exactly and
 *        eliminating the rangeStart race condition.
 *
 * v1.4 FIXES — useGlucoseReadings multi-day window:
 *
 *   ROOT CAUSE — useGlucoseReadings always fetched a fixed 24-hour buffer
 *     (now-24h → now) regardless of the active time range. When the user
 *     selected 3D, week, or month views the buffer was capped at 24h, so
 *     actual reading dots and the connected-readings line only appeared for
 *     the most recent day even though the chart x-axis spanned the full range.
 *     The doctor chart avoids this by receiving all blood-sugar data as a prop
 *     and filtering client-side — this fix mirrors that behaviour.
 *
 *   FIX 7 — useGlucoseReadings now:
 *     1. Fetches from rangeStart → now (instead of now-24h → now), so the
 *        buffer covers the full selected time window.
 *     2. Adds rangeStart as a useCallback dep so a new fetch fires when the
 *        user switches to a longer view (3D, week, month).
 *     3. Keeps rangeEnd out of the dep list — no future readings exist, so
 *        the live "now" tick should not trigger a re-fetch.
 *     4. The client-side filter memo is unchanged — slices the buffer to
 *        [rangeStart, rangeEnd] synchronously on every tick.
 *
 * v1.5 FIXES — align activity model with EffectsVisualizationChart.tsx:
 *
 *   FIX 8 — calculateActivityEffectAtTime() updated to three-phase model:
 *     OLD: decayed with τ_W (90 min) directly from session end — no plateau,
 *          produced a smooth-but-wrong curve that diverged from the backend ODE
 *          and the EffectsVisualizationChart implementation.
 *     NEW: (1) linear ramp during session, (2) FLAT plateau for τ_W (90 min)
 *          post-exercise window (ISF still elevated), (3) fast τ_acute (15 min)
 *          exponential decay after the plateau expires. Matches the backend
 *          W-state ODE and EffectsVisualizationChart exactly.
 *
 *   FIX 9 — Added calculateActivityEffectForCumulative() (lock-in model).
 *     The old code passed calculateActivityEffectAtTime() (decaying signal)
 *     into the cumulative "bank balance", which was wrong: a BG drop from
 *     exercise is a real physiological change that does not reverse on its own.
 *     The lock-in model rises during training then stays flat — matching the
 *     green line logic in EffectsVisualizationChart.
 *
 *   FIX 10 — resetTimeMs now derived inside buildBGChartPoint() and passed to
 *     both activity helpers, so the activity contribution resets to 0 at the
 *     daily reset hour (matching meals and insulin). Previously there was no
 *     daily-reset guard at all for activity in this chart.
 *
 * v1.6 — Local useGlucoseReadings replaced by shared useGlucoseBuffer (P8 — §9-M-13):
 *     Both this component and BloodGlucoseChart now import useGlucoseBuffer from
 *     @/hooks/useBloodGlucoseEstimation (migrated from @/hooks/useGlucoseBuffer).
 *     The shared hook adopts BGC's double-bound fetch-start
 *     formula (min of rangeStart−30 min and now−max(24, pastHours+2) h), which is
 *     strictly more correct than the plain rangeStart used here previously. Any future
 *     changes to fetch strategy, auth headers, timestamp normalisation, or retry logic
 *     now apply to both charts automatically.
 *
 *
 * v1.7 — Activity model alignment + sensitivity multiplier per chart point (P7 / M-11):
 *
 *   FIX 11 (P7) — calculateActivityEffectAtTime() reverted to Z-state decay model,
 *     matching EffectsVisualizationChart exactly.
 *     INCORRECT MODEL (v1.5 FIX 8): flat plateau for τ_W (90 min) then fast τ_acute
 *       (15 min) decay. BGV’s FIX 8 comment claiming this “matches EffectsVisualizationChart
 *       exactly” was wrong — that plateau belongs to the W-state SENSITIVITY MULTIPLIER,
 *       not to the acute BG-lowering signal.
 *     CORRECT MODEL: Immediate Z-state (IIRd) exponential decay from session end,
 *       τ_Z = SHARED_CONSTANTS.HR_MODEL.tau_Z (default 10 min), no plateau.
 *       The τ_W plateau is retained in calculateSensitivityMultiplierAtTime (added
 *       in FIX 12) where it correctly models the post-exercise ISF/CR sensitivity window.
 *     TAU_ACUTE_MS constant removed (was only used by the incorrect plateau model).
 *
 *   FIX 12 (M-11) — buildBGChartPoint() now applies the W-state sensitivity multiplier
 *     per chart point, matching EffectsVisualizationChart’s behaviour during and after
 *     exercise sessions.
 *     ADDED: calculateSensitivityMultiplierAtTime() — local copy of the EVC function
 *       (W-state plateau + exponential decay model; peakMultiplier from API / intensity
 *       fallback). See §8-M-11 for the full omission analysis.
 *     ADDED: effectiveCFForCumulative / effectiveC2BForCumulative as described below.
 *     ADDED: peakSensitivityMultiplier param to buildBGChartPoint (resolvedActivityPD
 *       .sensitivity_multiplier ?? 1.0) — passes the live API scalar used by
 *       calculateSensitivityMultiplierAtTime as its per-contribution fallback.
 *     IMPACT: BGV’s orange cumulative area and projected BG line now agree with EVC’s
 *       green cumulative line during and after exercise, eliminating the visual
 *       divergence described in §8-M-11.
 *
 *   FIX 13 (v4.7 — indirect effect lock-in):
 *     BUG: effectiveCFForCumulative = correctionFactor x sensitivityMultiplierAtTime was
 *       computed unconditionally. As sensitivityMultiplierAtTime decays back to 1.0
 *       post-exercise, Phase 1/2 insulin contributions shrank, making cumulativeNetBaseline
 *       drift upward after meals ended (phantom rise, no new food or insulin).
 *     FIX: effectiveCFForCumulative is now undefined when sensitivityMultiplierAtTime
 *       <= 1.005, letting calculateInsulinCumulativeEffect use the base correction_factor.
 *       Mirrors the guard already present in EVC (v4.7).
 *
 *   FIX 14 (v4.6 port — Phase 3 meal sensitivity):
 *     BUG: effectiveC2BForCumulative was spread into patientConstantsForCumulative
 *       ({ ...constants, carb_to_bg_factor: effectiveC2BForCumulative }). Phase 3 in
 *       calculateMealCumulativeEffect reads patientConstants.carb_to_bg_factor directly,
 *       so spreading the override retroactively scaled down fully-absorbed meals as the
 *       sensitivity window grew — same v4.6 bug fixed in EVC but not ported to BGV.
 *     FIX: effectiveC2BForCumulative passed as the dedicated 10th arg to
 *       calculateTotalCumulativeEffects. patientConstantsForCumulative is now the raw
 *       constants object. Phase 3 ignores the 10th arg; Phase 1/2 uses it correctly.
 * CHART LIBRARY: victory-native
 *   Install: npx expo install victory-native react-native-svg
 *
 * KEY DIFFERENCES FROM WEB VERSION:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. DATA SOURCE
 *    Web:    useBloodSugarData() context → recentMealsData, last24hData,
 *            adjustedBaselineForProjection
 *    Mobile: useActiveEffects() → meals / insulinDoses / stableBaseline
 *            + shared useGlucoseBuffer() hook for actual BG readings.
 *
 * 2. CHART GENERATION
 *    Web:    generateChartTimeline() (async service call)
 *    Mobile: buildBGChartPoint() per time-point using the same mobile
 *            calculation stack as EffectsVisualizationChart + BG projection.
 *
 * 3. DUAL-AXIS APPROACH
 *    Web:    Recharts ComposedChart with two yAxisId (glucose left, cumulative right)
 *    Mobile: Single Victory Y-axis [40-400 mg/dL].
 *            Cumulative effect rendered as VictoryArea fill BETWEEN baseBG
 *            and estimatedBG (same y-space, no manual scaling needed).
 *            Right-axis delta labels via a secondary VictoryAxis.
 *
 * 4. CONFIDENCE LINES
 *    Web:    highConfidenceBG (solid) + lowConfidenceBG (dashed) series
 *    Mobile: Same split — two VictoryLine series with null gaps for inactive
 *            segments. Confidence derived from minutes-since-last-reading.
 *
 * 5. ACTUAL READING DOTS
 *    Web:    Custom SVG dots via dot renderer callback
 *    Mobile: VictoryScatter with per-datum style callback for status colours.
 *
 * 6. NO FULLSCREEN API
 *    document.requestFullscreen() removed; sticky tooltip replaced with
 *    the React Native Modal pattern (matching EffectsVisualizationChart).
 *
 * SERIES RENDERED (all toggleable):
 *   📈 Estimated BG     (purple/blue solid line)  — showEstimatedLine
 *   🔵 Baseline BG      (blue dashed step line)   — showBaseline
 *   🟠 Cumulative Area  (orange fill, right axis) — showCumulativeEffect
 *   🟢 Net Effect Area  (green fill, right axis)  — showNetEffect
 *   🔴 Actual Readings  (coloured scatter dots)   — showActualReadings
 *   🎯 Target / High / Low reference lines        — showTargetRange
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

// ── Chart library ──────────────────────────────────────────────────────────────
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryAxis,
  VictoryTheme,
  VictoryScatter,
} from 'victory-native';

// ── Mobile calculation stack ───────────────────────────────────────────────────
import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinEffect,
  calculateStackedInsulinChartEffect,
} from '@/utils/insulin/pharmacodynamics';
import {
  calculateTotalCumulativeEffects,
  calculateActivityEffectForCumulative,
  // v4.14: Universal floor utility — prevents cumulativeInsulinEffect from
  // rising back up as the post-exercise sensitivity multiplier decays.
  applyInsulinCumulativeFloor,
} from '@/utils/calculations/cumulative-effects';
import { SHARED_CONSTANTS, MEAL_ABSORPTION_PROFILES, getCircadianBaseline, DEFAULT_PATIENT_CONSTANTS, getCumulativeLookbackHours } from '@/constants/shared-constants';

// ── Activity PD types ──────────────────────────────────────────────────────────
import type { ActivityPDResult, ActivityContribution } from '@/services/api/activity-pharmacodynamics';

// ── Hooks ──────────────────────────────────────────────────────────────────────
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { useGlucoseBuffer, type GlucoseReading } from '@/hooks/useBloodGlucoseEstimation'; // P8 — migrated from useGlucoseBuffer (§9-M-13)
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

// ── API client ─────────────────────────────────────────────────────────────────
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

// ── Chart utilities ────────────────────────────────────────────────────────────
import {
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  getBloodSugarStatusColor,
  getConfidenceLevel,
  findMealsAtTime,
  findInsulinAtTime,
  parseUTCMs,
  VIEW_CONFIGS,
  getLastResetTimeMs,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  formatXAxis,
  type TimeRange,
} from '@/utils/ChartUtils';



// ============================================================
// CONSTANTS
// ============================================================

// VIEW_CONFIGS is imported from ChartUtils (merges shared-constants with safe defaults)

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT  = 320;
const CHART_WIDTH   = SCREEN_WIDTH - 32;

/** Primary BG axis domain — keeps chart stable regardless of actual readings. */
const BG_DOMAIN: [number, number] = [40, 400];


const ACTIVE_EFFECTS_OPTIONS_BASE = {
  autoRefresh:     true,
  refreshInterval: 60_000,
  debug:           false,
  skipIobCutoff:   true,  // chart re-filters doses per point; 48h pre-filter is redundant here
};

const LOAD_TIMEOUT_MS = 8_000;

/**
 * τ_W (90 min) — post-exercise W-state decay constant.
 * Sourced from SHARED_CONSTANTS.HR_MODEL.tau_W — never hardcoded.
 * Matches the same constant used in EffectsVisualizationChart.
 */
const TAU_W_MIN: number = (SHARED_CONSTANTS as any)?.HR_MODEL?.tau_W ?? 90; // was tau_w (wrong casing) — fix: matches EVC, backend, and ODE
const TAU_W_MS:  number = TAU_W_MIN * 60_000;


// ============================================================
// TYPES
// ============================================================

interface BGChartPoint {
  timestamp:  number;
  formattedTime: string;

  // ── Blood glucose series (left Y-axis, 40-400 mg/dL) ──
  /** Non-null only at actual reading timestamps. */
  actualBG:          number | null;
  /** Constant stable baseline for the current day. */
  baseBG:            number;
  /** baseline + cumulativeNetBaseline — shown when confidence ≥ high. */
  highConfidenceBG:  number | null;
  /** baseline + cumulativeNetBaseline — shown when confidence < high. */
  lowConfidenceBG:   number | null;

  // ── Cumulative "bank balance" (drives the area fill) ──
  cumulativeNetBaseline:   number;
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;

  // ── Instantaneous rate-of-change ──
  netEffect:     number;
  mealImpact:    number;
  insulinImpact: number;

  // ── Metadata ──
  isActualReading: boolean;
  isHistorical:    boolean;
  isFuture:        boolean;
  isNow:           boolean;
  confidenceLevel: string;
  confidenceColor: string;

  // ── Dose markers for tooltip ──
  mealsAdministered:   any[];
  insulinAdministered: any[];
}

interface TooltipData {
  point: BGChartPoint;
}

export interface BloodGlucoseVisualizationProps {
  height?:        number;
  showControls?:  boolean;
  embedded?:      boolean;
  defaultView?:   string;
  onDataUpdate?:  (data: BGChartPoint[]) => void;
  /**
   * Optional activity PD result from a parent hook (P6 — §9-M-10).
   *
   * When provided, BGV skips its internal `activityPDResult` from `useActiveEffects`
   * and uses this value directly. This eliminates the double hook call when a parent
   * screen renders both EVC and BGV — only one `useActiveEffects` call fires and the
   * result is passed down to both charts via this prop.
   *
   * When absent (self-contained mode), BGV fetches its own activity PD as before.
   *
   * Follows the EVC `activityPD` prop pattern exactly.
   */
  activityPD?:    ActivityPDResult | null;
}

// ============================================================
// HELPERS (same pattern as EffectsVisualizationChart)
// ============================================================

// parseUTCMs, getLastResetTimeMs, getMealDurationHours, normaliseDose,
// doseToStacking, and formatXAxis are all imported from ChartUtils.

/** Normalise a raw meal: resolve every timestamp alias the backend might use.
 *  Kept local because it carries extra timestamp-alias resolution logic specific
 *  to the BG visualization that differs from the EffectsVisualizationChart version. */
function normaliseMeal(raw: any): any {
  const timestamp =
    raw.timestamp  ??
    raw.meal_time  ??
    raw.logged_at  ??
    raw.created_at ??
    raw.takenAt    ??
    null;

  return {
    ...raw,
    id:                  raw.id ?? String(raw._id ?? ''),
    timestamp,
    calculation_summary: raw.calculation_summary ?? {},
    nutrition:           raw.nutrition ?? {},
  };
}

// ============================================================
// ACTIVITY EFFECT HELPER  (mirrors EffectsVisualizationChart)
// ============================================================

/**
 * Calculate the signed instantaneous activity BG effect at a given time point.
 *
 * Z-state decay model (FIX 11 — aligns with EffectsVisualizationChart exactly):
 *   • Before session start:                  0
 *   • During session (0 → duration):         linear ramp 0 → fullEffect
 *   • Post-exercise (t > duration):           immediate Z-state (IIRd) decay
 *       W(t) = fullEffect × exp(−(t − end) / τ_Z)
 *       τ_Z = SHARED_CONSTANTS.HR_MODEL.tau_Z (default 10 min)
 *
 * The τ_W (90 min) plateau applies ONLY to the W-state sensitivity multiplier
 * (calculateSensitivityMultiplierAtTime) — NOT to this acute BG-lowering signal.
 * BGV v1.5 FIX 8 incorrectly placed the plateau here; FIX 11 corrects that.
 *
 * @param resetTimeMs - Daily reset boundary; contributions before this are skipped.
 */
function calculateActivityEffectAtTime(
  targetMs:      number,
  contributions: ActivityContribution[],
  tauWMs:        number,   // kept in signature for compatibility; not used post-exercise
  resetTimeMs:   number = 0,
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    // Daily reset guard — matches the identical guard in calculateActivityEffectForCumulative.
    if (resetTimeMs > 0 && startMs < resetTimeMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      // During session: linear ramp 0 → fullEffect
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      total += frac * fullEffect;
    } else {
      // Z-state (acute IIRd) decays immediately when exercise ends — no plateau.
      // The 90-min τ_W plateau belongs only to the W-state / sensitivity
      // multiplier rendering, not to this acute teal line.
      const TAU_Z_MS = ((SHARED_CONSTANTS as any)?.HR_MODEL?.tau_Z ?? 10) * 60_000;
      const postExerciseMs = targetMs - endMs;
      const recoveryFrac = Math.exp(-postExerciseMs / TAU_Z_MS);
      total += recoveryFrac * fullEffect;
    }
  }
  return total;
}

// calculateActivityEffectForCumulative is imported from @/utils/calculations
// (cumulative-effects.ts — P1 fix §9). The local copy below has been removed;
// AED, EVC, BGV, and useActiveEffects all share one implementation.
//
// ⚠️  calculateActivityEffectAtTime (above) is intentionally kept local — it
// implements the three-phase plateau + exponential decay model for the teal
// rate line and has a different signature (tauWMs param). It is NOT the same function.

// ============================================================
// SENSITIVITY MULTIPLIER HELPER  (FIX 12 / M-11 — mirrors EffectsVisualizationChart)
// ============================================================

/**
 * Returns the effective insulin-sensitivity multiplier at `targetMs` for
 * a given set of activity contributions.
 *
 * W-state model (three phases — NOTE: the τ_W plateau is CORRECT here because
 * this function models ISF/CR sensitivity boost, not the acute BG-lowering drop):
 *   During session  (startMs → endMs):           ramps 0 → peakBoost
 *   Post-exercise plateau (endMs → endMs + τ_W): peakBoost (flat)
 *   After plateau   (> endMs + τ_W):             peakBoost × exp(−(t−end−τ_W) / τ_W)
 *
 * Mirrors EffectsVisualizationChart.calculateSensitivityMultiplierAtTime exactly.
 * Added by FIX 12 (M-11) — previously buildBGChartPoint used base patientConstants
 * only and never adjusted meal/insulin sensitivity during exercise windows.
 *
 * @param targetMs       Chart time point in Unix ms
 * @param contributions  activity_contributions from the PD response
 * @param peakMultiplier effectiveActivityPD.sensitivity_multiplier (live API value)
 * @param tauWMs         τ_W in ms (TAU_W_MS = 90 × 60 × 1000)
 */
function calculateSensitivityMultiplierAtTime(
  targetMs:       number,
  contributions:  ActivityContribution[],
  peakMultiplier: number,
  tauWMs:         number,
): number {
  if (contributions.length === 0) return 1.0;

  // Sourced from SHARED_CONSTANTS — single source of truth shared with EVC.
  // Population-calibrated chart fallback when live API scalar has decayed to baseline.
  // If HR_MODEL alpha or W dynamics are re-tuned, update SHARED_CONSTANTS.INTENSITY_PEAK_BOOST.
  const INTENSITY_PEAK_BOOST: Record<string, number> =
    (SHARED_CONSTANTS as any)?.INTENSITY_PEAK_BOOST ?? { light: 0.10, moderate: 0.25, vigorous: 0.40 };

  const MAX_BOOST = (SHARED_CONSTANTS as any)?.HR_MODEL?.max_sensitivity_boost ?? 0.60; // was hardcoded — now sourced from SHARED_CONSTANTS like all ODE params
  const globalPeakBoost = Math.max(0, peakMultiplier - 1);
  let totalBoost = 0;

  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    const durationMs  = (c.duration_minutes ?? 30) * 60_000;
    const endMs       = startMs + durationMs;

    // Per-contribution peak: prefer the global API scalar when live (> 0.005 above 1.0);
    // fall back to intensity-derived value for historical sessions whose live scalar
    // has already decayed to baseline. Mirrors EVC's identical logic.
    const intensityBoost = INTENSITY_PEAK_BOOST[c.intensity ?? 'moderate'] ?? 0.25;
    const peakBoost = globalPeakBoost > 0.005 ? globalPeakBoost : intensityBoost;

    if (targetMs <= endMs) {
      // During session: linear ramp 0 → peakBoost (matches calculateActivityEffectAtTime)
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      totalBoost += peakBoost * frac;
      continue;
    }

    const postMs = targetMs - endMs;
    if (postMs <= tauWMs) {
      totalBoost += peakBoost;                                          // plateau
    } else {
      totalBoost += peakBoost * Math.exp(-(postMs - tauWMs) / tauWMs); // decay
    }
  }

  return 1 + Math.min(totalBoost, MAX_BOOST);
}


// ============================================================
// PER-POINT CALCULATION
// ============================================================

/**
 * Build a single chart data point for the BG visualization.
 *
 * Calculates:
 *   1. Instantaneous meal / insulin effects (mealImpact, insulinImpact)
 *   2. Cumulative "bank balance" (cumulativeNetBaseline)
 *   3. BG projection = stableBaseline + cumulativeNetBaseline
 *   4. Confidence classification (drives high/low confidence line split)
 *   5. Actual reading overlay (matched from the readings array)
 */
function buildBGChartPoint(
  targetTimestamp:   number,
  processedMeals:    any[],
  processedInsulin:  any[],
  allMealsInWindow:  any[],
  allDosesInWindow:  any[],
  actualReadings:    Array<{ timestamp: number; bloodSugar: number }>,
  stableBaseline:    number,
  patientConstants:  any,
  minutesSinceReading: number,
  now:               number,
  halfIntervalMs:    number,
  viewConfig:        any,
  baselineMode?:     'dynamic' | 'preset',
  circadianProfile?: any,
  activityContributions: ActivityContribution[] = [],
  tauWMs:            number = TAU_W_MS,
  peakSensitivityMultiplier: number = 1.0,  // FIX 12 (M-11): live API sensitivity_multiplier for calculateSensitivityMultiplierAtTime
): BGChartPoint {
  const targetTime = new Date(targetTimestamp);
  const isHistorical = targetTimestamp <= now;
  const isFuture     = targetTimestamp > now;
  const isNow        = Math.abs(targetTimestamp - now) < halfIntervalMs;

  const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
  const tzOffset:  number = patientConstants?.timezone_offset_minutes ?? 0;
  const correctionFactor  = patientConstants?.correction_factor ?? 40;

  // ── FIX 12 (M-11): Sensitivity multiplier at this chart time point ────────────
  // Uses the W-state model (plateau + exponential decay), NOT the live API scalar.
  // The live scalar is only authoritative at "now"; historical/future points need
  // the time-resolved function. peakSensitivityMultiplier is the API scalar used
  // as the per-contribution peak when live; intensity fallback when decayed.
  // Mirrors EffectsVisualizationChart.buildChartPoint invariant #3.
  const sensitivityMultiplierAtTime = calculateSensitivityMultiplierAtTime(
    targetTimestamp,
    activityContributions,
    peakSensitivityMultiplier,
    tauWMs,
  );

  // ── v4.7 FIX: INDIRECT EFFECT LOCK-IN BUG — effectiveCFForCumulative guard ──
  //
  // BUG (cumulative line rises after meal ends):
  //   Previously `correctionFactor × sensitivityMultiplierAtTime` was computed
  //   unconditionally and passed to calculateTotalCumulativeEffects at every chart
  //   point. As sensitivityMultiplierAtTime decays back to 1.0 post-exercise, Phase
  //   1/2 insulin contributions shrank with it → cumulativeNetBaseline (meals +
  //   insulin) drifted upward — a phantom rise with no new food or insulin.
  //   This is the Phase 1/2 analogue of the v4.5 Phase 3 insulin bug.
  //
  // FIX: apply the same `> 1.005` guard used by effectiveC2BForCumulative.
  //   Active window (> 1.005) → boost applied; decayed (≤ 1.005) → undefined,
  //   which makes calculateInsulinCumulativeEffect use the base correction_factor.
  const effectiveCFForCumulative: number | undefined = sensitivityMultiplierAtTime > 1.005
    ? correctionFactor * sensitivityMultiplierAtTime
    : undefined;

  // ── v4.6 FIX: PHASE 3 MEAL SENSITIVITY BUG — dedicated arg, not spread ─────
  //
  // BUG (previous implementation):
  //   effectiveC2BForCumulative was spread into patientConstantsForCumulative
  //   ({ ...patientConstants, carb_to_bg_factor: effectiveC2BForCumulative }).
  //   calculateMealCumulativeEffect Phase 3 reads patientConstants.carb_to_bg_factor
  //   directly from the passed constants object — so spreading the override here
  //   caused fully-absorbed meals to have their locked-in contribution retroactively
  //   scaled down by 1/sensitivityMultiplier as the exercise window grew.
  //   This is the same v4.6 bug already fixed in EVC but never ported to BGV.
  //
  // FIX: pass effectiveC2BForCumulative as the dedicated 10th argument instead.
  //   Phase 3 in calculateMealCumulativeEffect explicitly ignores this argument and
  //   always reads the base carb_to_bg_factor — Phase 1/2 uses the override correctly.
  //   patientConstantsForCumulative is now the RAW constants (no C2B spread).
  const effectiveC2BForCumulative: number | undefined = sensitivityMultiplierAtTime > 1.005
    ? (patientConstants?.carb_to_bg_factor ?? 4.0) / sensitivityMultiplierAtTime
    : undefined;

  // Pass raw constants — C2B override goes as dedicated 10th arg, not spread here.
  const patientConstantsForCumulative: any = patientConstants;

  // baseBG: in preset mode evaluate the circadian curve at this specific hour;
  // in dynamic mode use the single back-calculated baseline (existing behaviour).
  const pointHour = ((targetTimestamp + tzOffset * 60_000) / 3_600_000) % 24;
  const baseBG = (baselineMode === 'preset' && circadianProfile)
    ? getCircadianBaseline(pointHour, circadianProfile)
    : stableBaseline;

  // ── Actual reading at this time slot ──────────────────────────────────────
  let actualBG: number | null = null;
  let isActualReading = false;
  for (const reading of actualReadings) {
    if (Math.abs(reading.timestamp - targetTimestamp) <= halfIntervalMs) {
      actualBG = reading.bloodSugar;
      isActualReading = true;
      break;
    }
  }

  // ── Meal effect (instantaneous rate-of-change) ────────────────────────────
  const activeMealsAtTime = processedMeals.filter((meal: any) => {
    const mealMs = typeof meal.timestamp === 'number'
      ? meal.timestamp
      : parseUTCMs(meal.timestamp);
    if (isNaN(mealMs) || mealMs > targetTimestamp) return false;
    return (targetTimestamp - mealMs) / (1_000 * 60 * 60) < getMealDurationHours(meal);
  });

  const mealResult = activeMealsAtTime.length > 0
    ? calculateStackedMealEffect(activeMealsAtTime, targetTime, patientConstants)
    : { totalBGElevation: 0 };
  const safeNumInline = (v: any): number => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : 0;
  const mealImpact = safeNumInline((mealResult as any)?.totalBGElevation);

  // ── Insulin effect (cumulative S-curve for chart area) ─────────────────────
  const dosesForStacking: InsulinDoseForStacking[] = processedInsulin
    .map((dose: any) => doseToStacking(dose, targetTime))
    .filter((d): d is InsulinDoseForStacking => d !== null);

  const chartInsulinResult = dosesForStacking.length > 0
    ? calculateStackedInsulinChartEffect(dosesForStacking, correctionFactor)
    : { totalBGImpact: 0, totalIOB: 0 };
  const insulinImpact = safeNumInline(chartInsulinResult.totalBGImpact); // always <= 0

  const netEffect = mealImpact + insulinImpact;

  // ── Cumulative baseline ("bank balance" at this time) ─────────────────────
  const allMealsUpToNow = allMealsInWindow.filter((meal: any) => {
    const ms = parseUTCMs(meal?.timestamp);
    return !isNaN(ms) && ms <= targetTimestamp;
  });
  const allDosesUpToNow = allDosesInWindow.filter((dose: any) => {
    const ms = parseUTCMs(dose?.administrationTime);
    return !isNaN(ms) && ms <= targetTimestamp;
  });

  const cumulative = (allMealsUpToNow.length > 0 || allDosesUpToNow.length > 0)
    ? calculateTotalCumulativeEffects(
        allMealsUpToNow,
        allDosesUpToNow,
        targetTime,
        patientConstantsForCumulative,  // v4.6 fix: raw constants — C2B override is now a dedicated arg
        MEAL_ABSORPTION_PROFILES as any,
        resetHour,
        tzOffset,
        // Do NOT pass activities here — activity injected manually via
        // calculateActivityEffectForCumulative below (double-count guard).
        undefined,
        effectiveCFForCumulative,       // v4.7 fix: undefined when multiplier <= 1.005 (no phantom rise)
        effectiveC2BForCumulative,      // v4.6 fix: dedicated arg — Phase 3 meals ignore this (base C2B used)
      )
    : { cumulativeMealEffect: 0, cumulativeInsulinEffect: 0, cumulativeNetBaseline: 0 };

  const safeNum = (v: any): number => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : 0;
  const cumulativeNetBaseline   = safeNum((cumulative as any).cumulativeNetBaseline);
  const cumulativeMealEffect    = safeNum((cumulative as any).cumulativeMealEffect);
  const cumulativeInsulinEffect = safeNum((cumulative as any).cumulativeInsulinEffect);

  // ── Daily reset boundary ────────────────────────────────────────────────────
  // Required by both activity helpers so the activity contribution resets at the
  // same daily boundary as meals and insulin (exactly like EffectsVisualizationChart).
  const resetTimeMs = getLastResetTimeMs(targetTime, resetHour, tzOffset);

  // ── Activity contribution to the cumulative "bank balance" (lock-in) ───────
  // Uses calculateActivityEffectForCumulative() — once training ends the BG drop
  // locks in permanently (no decay), matching the green line in EffectsVisualizationChart.
  // calculateActivityEffectAtTime() (plateau + fast decay) is NOT used here because
  // the cumulative area fill should reflect a persistent physiological shift, not
  // the decaying instantaneous signal.
  const activityCumulative = calculateActivityEffectForCumulative(targetTimestamp, activityContributions, resetTimeMs);

  // ── BG projection ──────────────────────────────────────────────────────────
  const totalCumulativeNetBaseline = cumulativeNetBaseline + activityCumulative;
  const estimatedBG = baseBG + totalCumulativeNetBaseline;

  // ── Confidence classification ─────────────────────────────────────────────
  const confidenceInfo = getConfidenceLevel(
    { isActualReading, isFuture, timestamp: targetTimestamp },
    minutesSinceReading
  );
  const isHighConfidence =
    confidenceInfo.level === 'actual' ||
    confidenceInfo.level === 'high' ||
    confidenceInfo.level === 'projected_high';

  // ── Dose markers ──────────────────────────────────────────────────────────
  const mealsAtTime   = findMealsAtTime(processedMeals, targetTimestamp, halfIntervalMs);
  const insulinAtTime = findInsulinAtTime(processedInsulin, targetTimestamp, halfIntervalMs);

  return {
    timestamp:    targetTimestamp,
    formattedTime: formatXAxis(targetTimestamp, viewConfig?.tickFormat),

    actualBG,
    baseBG,
    highConfidenceBG: isHighConfidence ? (actualBG ?? estimatedBG) : null,
    lowConfidenceBG:  !isHighConfidence ? estimatedBG : null,

    cumulativeNetBaseline: totalCumulativeNetBaseline,
    cumulativeMealEffect,
    cumulativeInsulinEffect,

    netEffect,
    mealImpact,
    insulinImpact,

    isActualReading,
    isHistorical,
    isFuture,
    isNow,
    confidenceLevel: confidenceInfo.level,
    confidenceColor: confidenceInfo.color,

    mealsAdministered:   mealsAtTime,
    insulinAdministered: insulinAtTime,
  };
}

// ============================================================


// ============================================================
// CUSTOM VIEW CONFIG  — auto-selects tick density from duration
// ============================================================

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

// ============================================================
// MAIN COMPONENT
// ============================================================

const BloodGlucoseVisualization: React.FC<BloodGlucoseVisualizationProps> = ({
  height       = CHART_HEIGHT,
  showControls = true,
  embedded     = false,
  defaultView  = '12h',
  onDataUpdate,
  activityPD,
}) => {
  // ── Patient constants ────────────────────────────────────────────────────────
  const { constants: patientConstants } = usePatientConstants();
  const effectiveTarget: number =
    patientConstants?.target_glucose ?? 100;

  // ── Stable callback ref (avoids deps on onDataUpdate) ────────────────────────
  const onDataUpdateRef = useRef(onDataUpdate);
  useEffect(() => { onDataUpdateRef.current = onDataUpdate; }, [onDataUpdate]);

  // ── View state ───────────────────────────────────────────────────────────────
  const [viewMode,    setViewMode]    = useState(defaultView);
  const [chartData,   setChartData]   = useState<BGChartPoint[]>([]);
  const [generating,  setGenerating]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // ── Series toggles ───────────────────────────────────────────────────────────
  const [showBaseline,          setShowBaseline]          = useState(true);
  const [showActualReadings,    setShowActualReadings]    = useState(true);
  const [showEstimatedLine,     setShowEstimatedLine]     = useState(true);
  const [showTargetRange,       setShowTargetRange]       = useState(false);
  const [showNetEffect,         setShowNetEffect]         = useState(false);
  const [showCumulativeEffect,  setShowCumulativeEffect]  = useState(true);

  // ── Tooltip state ────────────────────────────────────────────────────────────
  const [tooltipData,   setTooltipData]   = useState<TooltipData | null>(null);

  // ── About this Chart accordion ───────────────────────────────────────────────
  const [aboutExpanded, setAboutExpanded] = useState(false);

  // ── Custom date-range filter ──────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);


  // ── Time hooks ───────────────────────────────────────────────────────────────
  const currentMinute  = useCurrentMinute();
  // Always call hook unconditionally; override result when custom mode is active.
  const _hookTimeRange = useChartTimeRange(viewMode === 'custom' ? '24h' : viewMode, currentMinute);

  const timeRange: TimeRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied) {
      return { start: customRangeStart.getTime(), end: customRangeEnd.getTime(), now: Date.now() };
    }
    return _hookTimeRange;
  }, [viewMode, customApplied, customRangeStart, customRangeEnd, _hookTimeRange]);

  const viewConfig = useMemo(() =>
    viewMode === 'custom'
      ? getCustomViewConfig(customRangeStart, customRangeEnd)
      : (VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h']),
  [viewMode, customRangeStart, customRangeEnd]);

  const { start: rangeStart, end: rangeEnd } = timeRange;

  // ── Active effects options — window matches current view ─────────────────────
  // MUST be computed before useActiveEffects (avoids TDZ / "cannot access before
  // initialization" crash).  Passing windowHours causes the hook to fetch meals
  // and insulin for the full chart range from the backend (not just 24h).
  //
  // FIX (cumulative lookback): For short views (3H/6H/12H/24H) the visible
  // pastHours is smaller than the minimum fetch depth needed to cover the full
  // previous daily window. We always fetch at least getCumulativeLookbackHours
  // hours so meals/doses from this morning (before the chart's left edge) are
  // present in rawMeals and rawDoses — the per-point daily-reset filter inside
  // calculateTotalCumulativeEffects then sees the full day's data.
  const activeEffectsOptions = useMemo(() => {
    const resetHour: number =
      patientConstants?.daily_reset_hour ??
      DEFAULT_PATIENT_CONSTANTS.daily_reset_hour;

    const displayPastHours = viewMode === 'custom'
      ? Math.max(1, (Date.now() - customRangeStart.getTime()) / 3_600_000)
      : ((VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h']).pastHours ?? 24);

    const fetchHours = Math.max(displayPastHours, getCumulativeLookbackHours(resetHour));

    return { ...ACTIVE_EFFECTS_OPTIONS_BASE, windowHours: fetchHours };
  }, [viewMode, customRangeStart, patientConstants]);

  // ── Active effects (meals, insulin, baseline) ────────────────────────────────
  const {
    meals:        rawMeals,
    insulinDoses: rawDoses,
    stableBaseline,
    baselineMode,
    isLoading:    effectsLoading,
    refresh:      refreshEffects,
    activityPDResult,
    estimatedBG:  hookEstimatedBG,
  } = useActiveEffects(activeEffectsOptions);

  // P6 (§9-M-10): Prefer the prop when a parent screen already owns the PD fetch.
  // Falls back to the hook's own fetch for self-contained usage.
  const resolvedActivityPD = activityPD ?? activityPDResult;

  // ✅ FIX: Guard against NaN. `stableBaseline` from useActiveEffects can be NaN
  // (not null/undefined) when calculateStableBaselineFromReading receives a reading
  // whose .value field is undefined (API returns bloodSugar not value).
  // JavaScript's ?? operator does NOT catch NaN — only null/undefined — so
  // `NaN ?? fallback` returns NaN, propagating into every chart baseBG → SVG path
  // coordinates become "M56,NaN..." and the BG summary shows "NaN mg/dL".
  const effectiveBaseline: number =
    (stableBaseline !== null && stableBaseline !== undefined && !Number.isNaN(stableBaseline))
      ? stableBaseline
      : effectiveTarget;

  // ── Activity PD derived data (mirrors EffectsVisualizationChart §2a–2e) ───────
  // Per-session contributions — empty array when resolvedActivityPD is null so
  // calculateActivityEffectAtTime degrades to 0 with no code-path changes.
  const activityContributions: ActivityContribution[] = useMemo(
    () => resolvedActivityPD?.activity_contributions ?? [],
    [resolvedActivityPD],
  );

  // τ_W in ms: prefer the patient-specific value from the PD response
  // (w_state_tau_minutes), fall back to SHARED_CONSTANTS.HR_MODEL.tau_W.
  const tauWMs: number = useMemo(
    () => (resolvedActivityPD?.w_state_tau_minutes != null
      ? resolvedActivityPD.w_state_tau_minutes * 60_000
      : TAU_W_MS),
    [resolvedActivityPD],
  );

  // FIX 12 (M-11): Live API sensitivity multiplier — passed as peakSensitivityMultiplier
  // to buildBGChartPoint so calculateSensitivityMultiplierAtTime can use it as the
  // per-contribution peak when the API scalar is still above baseline (> 1.005).
  const peakSensitivityMultiplier: number = useMemo(
    () => resolvedActivityPD?.sensitivity_multiplier ?? 1.0,
    [resolvedActivityPD],
  );

  // ── Glucose readings (P8 — shared useGlucoseBuffer hook) ───────────────────────
  // Fetches a buffer covering [min(rangeStart−30 min, now−max(24,pastHours+2) h), now]
  // and filters client-side to [rangeStart, rangeEnd] — no new network request
  // fires on live "now" tick advances or view-mode switches within the buffer.
  const {
    readings: glucoseReadings,
    refresh:  refreshReadings,
  } = useGlucoseBuffer(
    rangeStart,
    rangeEnd,
    viewConfig.pastHours ?? 24,
    60_000,
    'BloodGlucoseVisualization',
  );

  /** Minutes since the most recent actual reading (used for confidence). */
  const minutesSinceReading = useMemo(() => {
    if (glucoseReadings.length === 0) return 999;
    const latest = glucoseReadings[glucoseReadings.length - 1].timestamp;
    return (Date.now() - latest) / 60_000;
  }, [glucoseReadings]);

  // ── Timeout escape hatch ─────────────────────────────────────────────────────
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!effectsLoading) return;
    const id = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [effectsLoading]);

  const refresh = useCallback(() => {
    refreshEffects();
    refreshReadings();
  }, [refreshEffects, refreshReadings]);

  // ── Processed meals / insulin (time-range filtered) ──────────────────────────
  const processedMeals = useMemo(
    () => processContextMealsForChart(
      rawMeals.map(normaliseMeal),  // ✅ FIX: normalise first so calculation_summary
      timeRange,                    //         and timestamp aliases (meal_time etc.)
      patientConstants,             //         are resolved before chart filtering
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawMeals, rangeStart, rangeEnd, patientConstants]
  );

  const processedInsulin = useMemo(
    () => processContextInsulinForChart(rawDoses.map(normaliseDose), timeRange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawDoses, rangeStart, rangeEnd]
  );

  // ── All-window arrays for correct cumulative baseline ────────────────────────
  // These are kept separate from processedMeals/processedInsulin: they include
  // FULLY-ABSORBED events (past their PK duration) so the persist-at-100% fix
  // in calculateTotalCumulativeEffects correctly holds their bank-balance value.
  //
  // LOWER BOUND — Math.min(rangeStart, lastResetMs):
  //   For '12h'/'24h' views rangeStart IS the daily reset boundary (useChartTimeRange
  //   anchors those views to 7AM), so both values are equal.  For short views
  //   (e.g. '6h' at noon: rangeStart=8AM but lastReset=7AM), Math.min gives 7AM,
  //   ensuring post-reset meals eaten BETWEEN the reset and rangeStart are still
  //   included in the bank balance.  This is more complete than using rangeStart
  //   alone (which would silently drop that first hour of meals from the cumulative).
  //   For multi-day views (3D): Math.min(72h_ago, today_7AM) = 72h_ago = rangeStart,
  //   so all historical meals are correctly included.
  //
  // UPPER BOUND — now:
  //   Future meals are excluded from the bank balance.
  //   calculateMealCumulativeEffect already returns 0 for mealMs > targetTime, so
  //   this is an upfront filter that reduces array size and makes intent explicit.
  //
  // Per-point daily-reset boundary is enforced INSIDE calculateTotalCumulativeEffects
  // → calculateMealCumulativeEffect / calculateInsulinCumulativeEffect, which call
  // _getLastResetTime(targetTime, resetHour, tz) for each chart point's own timestamp.
  // Each historical point therefore only counts meals/doses from its own daily window,
  // and the cumulative correctly resets to 0 at each day's reset hour.
  const { allMealsInWindow, allDosesInWindow } = useMemo(() => {
    if (!patientConstants) return { allMealsInWindow: [], allDosesInWindow: [] };

    const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
    const tzOffset:  number = (patientConstants as any)?.timezone_offset_minutes ?? 0;
    const now        = Date.now();

    // ── KEY FIX: anchor to the reset at the START of the chart window ────────
    //
    // BEFORE: getLastResetTimeMs(new Date(), ...) always returns TODAY's reset.
    // For multi-day views where rangeStart is days ago, using today's reset as
    // the lower bound drops historical meals from earlier daily windows.
    // For short views it also misses the edge case where rangeStart < lastReset.
    //
    // FIX: compute the reset applicable AT rangeStart (or now, whichever is
    // earlier). Math.min(rangeStart, now) guards against custom ranges with a
    // future start.
    //
    //   • Short views (3H/6H): rangeStart > lastReset → earliestResetMs = today's
    //     reset → startBound = earliestResetMs (carries in pre-window meals)
    //
    //   • Multi-day views (3D/Week): rangeStart < today's reset → earliestResetMs =
    //     reset at the START of the chart → startBound = rangeStart (no change)
    const earliestResetMs = getLastResetTimeMs(
      new Date(Math.min(rangeStart, now)), resetHour, tzOffset
    );
    const startBound = Math.min(rangeStart, earliestResetMs);

    return {
      allMealsInWindow: rawMeals
        .map(normaliseMeal)
        .filter((m: any) => {
          const ms = parseUTCMs(m?.timestamp);
          // ✅ FIX: use rangeEnd (not `now`) so future-snapped meals
          // (timestamp = insulinTime + offset) are included and reach
          // calculateTotalCumulativeEffects. calculateAbsorbedFraction
          // returns 0 for points before the meal's own timestamp, so
          // including future meals here is safe.
          return !isNaN(ms) && ms >= startBound && ms <= rangeEnd;
        }),
      allDosesInWindow: rawDoses
        .map(normaliseDose)
        .filter((d: any) => {
          const ms = parseUTCMs(d?.administrationTime);
          return !isNaN(ms) && ms >= startBound && ms <= now;
        }),
    };
  // rangeStart and rangeEnd are stable primitives from timeRange — safe as deps.
  }, [rawMeals, rawDoses, patientConstants, rangeStart, rangeEnd]);

  // ── Chart generation ──────────────────────────────────────────────────────────
  const generateChartData = useCallback(() => {
    if (!patientConstants) return;

    setGenerating(true);
    setError(null);

    try {
      const { start, end, now } = timeRange;
      const intervalMs   = (viewConfig.interpolationInterval ?? 10) * 60 * 1_000;
      const halfInterval = intervalMs / 2;

      // Build normalised time-point array (minute-aligned)
      const timePoints: number[] = [];
      for (let t = start; t <= end; t += intervalMs) {
        const normalised = Math.round(t / 60_000) * 60_000;
        if (timePoints.length === 0 || timePoints[timePoints.length - 1] !== normalised) {
          timePoints.push(normalised);
        }
      }

      const points: BGChartPoint[] = timePoints.map(ts =>
        buildBGChartPoint(
          ts,
          processedMeals,
          processedInsulin,
          allMealsInWindow,
          allDosesInWindow,
          glucoseReadings,
          effectiveBaseline,
          patientConstants,
          minutesSinceReading,
          now ?? Date.now(),
          halfInterval,
          viewConfig,
          (baselineMode ?? 'dynamic') as 'dynamic' | 'preset',
          (patientConstants as any)?.circadian_profile ?? undefined,
          activityContributions,
          tauWMs,
          peakSensitivityMultiplier,  // FIX 12 (M-11)
        )
      );

      // v4.14 — same flat-floor fix as EVC: prevent cumulativeInsulinEffect from
      // rising back up as sensitivityMultiplierAtTime decays post-exercise.
      // BGChartPoint satisfies the generic constraint (has both cumulativeInsulinEffect
      // and cumulativeNetBaseline). See cumulative-effects.ts v4.14 for full explanation.
      applyInsulinCumulativeFloor(points);

      setChartData(points);
      onDataUpdateRef.current?.(points);
    } catch (err) {
      console.error('[BloodGlucoseVisualization] generateChartData error:', err);
      setError('Failed to generate chart');
    } finally {
      setGenerating(false);
    }
  }, [
    patientConstants,
    processedMeals,
    processedInsulin,
    allMealsInWindow,
    allDosesInWindow,
    glucoseReadings,
    effectiveBaseline,
    baselineMode,
    minutesSinceReading,
    timeRange,
    viewConfig,
    activityContributions,
    tauWMs,
    peakSensitivityMultiplier,
    // onDataUpdate accessed via ref — intentionally omitted
  ]);

  // Debounced regeneration on any input change
  useEffect(() => {
    const id = setTimeout(generateChartData, 200);
    return () => clearTimeout(id);
  }, [generateChartData]);

  // P6 (§9-M-10): Immediate regeneration when the activityPD PROP changes.
  // The debounced effect above fires with a 200 ms delay whenever generateChartData
  // identity changes (which includes activityPD-driven changes via resolvedActivityPD
  // → activityContributions / tauWMs). This effect bypasses that debounce so EVC and
  // BGV update in the same render cycle when a parent screen passes the prop.
  // Intentionally excludes generateChartData from deps — we only want to fire
  // immediately on the prop reference change itself, not on every input change.
  useEffect(() => {
    if (activityPD === undefined) return;   // self-contained mode — let debounce handle it
    generateChartData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityPD]);

  // ── Victory data arrays ───────────────────────────────────────────────────────

  // Connected actual readings — joins nearby readings, breaks on gaps larger than
  // a threshold that scales with the view window.
  //
  // A fixed 20-min cap was fine for CGM data (5-min intervals) but broke SMBG
  // lines completely on multi-day views: readings 3–6 hours apart each produced
  // a null break, leaving every dot isolated.
  //
  // Formula: pastHours × 12 min, floored at 20 min.
  //   3h  → 20 min   (CGM: sensor gap detection still works)
  //   12h → 120 min  (SMBG: allows up to 2h between readings)
  //   3d  → 816 min  (~13.6h — keeps SMBG readings joined across a day)
  //   week→ ~20h     (one gap per day at most)
  //   month→ ~86h    (effectively never breaks)
  const MAX_READING_GAP_MS = Math.max(20, (viewConfig.pastHours ?? 3) * 12) * 60 * 1000;
  const connectedReadingsData = useMemo(() => {
    const pts = chartData
      .filter(p => p.isActualReading && p.actualBG !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (pts.length === 0) return [];
    const result: Array<{ x: number; y: number | null }> = [];
    for (let i = 0; i < pts.length; i++) {
      result.push({ x: pts[i].timestamp, y: pts[i].actualBG! });
      if (i < pts.length - 1 && pts[i + 1].timestamp - pts[i].timestamp > MAX_READING_GAP_MS) {
        result.push({ x: pts[i].timestamp + 1, y: null });
      }
    }
    return result;
  }, [chartData]);

  // Baseline step line — constant value
  const baselineData = useMemo(
    () => chartData.map(p => ({ x: p.timestamp, y: p.baseBG })),
    [chartData]
  );

  // ── Cumulative net baseline area ─────────────────────────────────────────────
  //
  // Single orange area matching BloodSugarVisualization.js exactly:
  //   JS: <Area yAxisId="cumulative" dataKey="cumulativeNetBaseline" fill="url(#gradient)" />
  //   The separate cumulative y-axis in JS auto-centres at 0, so the fill goes
  //   upward when net > 0 and downward when net < 0.
  //
  //   Mobile: y0=baseBG is the zero-line in BG space.
  //   y = baseBG + cumulativeNetBaseline — unconditional, no clamping.
  //   Fills upward (meals dominant) or downward (insulin dominant) naturally.

  const cumulativeNetData = useMemo(
    () => chartData.map(p => ({
      x:  p.timestamp,
      y:  p.baseBG + p.cumulativeNetBaseline,
      y0: p.baseBG,
    })),
    [chartData]
  );

  // Net effect area — instantaneous rate-of-change, same unconditional pattern.
  const netEffectData = useMemo(
    () => chartData.map(p => ({
      x:  p.timestamp,
      y:  p.baseBG + p.netEffect,
      y0: p.baseBG,
    })),
    [chartData]
  );

  // Actual readings scatter points (coloured by status)
  const actualReadingsData = useMemo(
    () => chartData
      .filter(p => p.isActualReading && p.actualBG !== null)
      .map(p => ({
        x:     p.timestamp,
        y:     p.actualBG!,
        color: getBloodSugarStatusColor(p.actualBG!, effectiveTarget),
        point: p,
      })),
    [chartData, effectiveTarget]
  );

  // ── X-axis ticks ─────────────────────────────────────────────────────────────
  const xTicks = useMemo(
    () => generateXAxisTicks(timeRange, viewConfig),
    [timeRange, viewConfig]
  );

  // ── Reference line values ─────────────────────────────────────────────────────
  const targetHigh = effectiveTarget * 1.3;
  const targetLow  = effectiveTarget * 0.7;

  // ── Loading / error states ────────────────────────────────────────────────────
  const showLoader = effectsLoading && !timedOut && chartData.length === 0;

  if (showLoader) {
    return (
      <View style={[styles.centered, { height }]}>
        <ActivityIndicator size="large" color="#8031A7" />
        <Text style={styles.loadingText}>Loading blood glucose data…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { height }]}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={refresh}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── "Now" point for summary strip ────────────────────────────────────────────
  const nowPoint = chartData.find(p => p.isNow) ?? chartData[Math.floor(chartData.length / 2)];

  // Use the live estimatedBG from useActiveEffects for the summary strip.
  // The chart point's baseBG + cumulativeNetBaseline is computed at chart-generation
  // time (potentially minutes ago) and does NOT include the activity delta applied
  // by the delta pattern in useActiveEffects.  hookEstimatedBG is always current
  // (recalculated every refresh cycle) and matches what ActiveEffectsDisplay shows.
  const currentEstimatedBG =
    (hookEstimatedBG !== null && hookEstimatedBG !== undefined && !Number.isNaN(hookEstimatedBG))
      ? hookEstimatedBG
      : (nowPoint ? nowPoint.baseBG + nowPoint.cumulativeNetBaseline : effectiveBaseline);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, embedded && styles.embedded]}>

      {/* ── Header ── */}
      {showControls && (
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Blood Glucose</Text>
            <Text style={styles.headerSubtitle}>
              Baseline + cumulative net effect = projected BG
            </Text>
          </View>
          <TouchableOpacity onPress={refresh} style={styles.refreshBtn} hitSlop={8}>
            <Text style={styles.refreshIcon}>
              {effectsLoading ? '⏳' : '🔄'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── View mode selector ── */}
      {showControls && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.viewModeScroll}
          contentContainerStyle={styles.viewModeRow}
        >
          {Object.entries(VIEW_CONFIGS).map(([key, cfg]) => (
            <TouchableOpacity
              key={key}
              style={[
                styles.viewModeBtn,
                viewMode === key && styles.viewModeBtnActive,
              ]}
              onPress={() => setViewMode(key)}
            >
              <Text style={[
                styles.viewModeBtnText,
                viewMode === key && styles.viewModeBtnTextActive,
              ]}>
                {(cfg as any).label ?? key}
              </Text>
            </TouchableOpacity>
          ))}
          {/* 📅 Custom date-range button */}
          <TouchableOpacity
            style={[styles.viewModeBtn, styles.viewModeBtnCustom, viewMode === 'custom' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('custom')}
          >
            <Text style={[styles.viewModeBtnText, viewMode === 'custom' && styles.viewModeBtnTextActive]}>
              📅 Range
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ── Custom date-range panel ── */}
      {showControls && viewMode === 'custom' && (
        <View style={styles.customRangePanel}>
          <View style={styles.customRangeRow}>
            <View style={styles.customRangePicker}>
              <UnifiedTimePicker
                label="From"
                value={customRangeStart}
                onChange={(iso) => { setCustomRangeStart(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
            <View style={styles.customRangePicker}>
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
            style={[styles.customRangeApplyBtn, customApplied && styles.customRangeAppliedBtn]}
            onPress={() => setCustomApplied(true)}
            disabled={customApplied}
          >
            <Text style={styles.customRangeApplyText}>
              {customApplied ? '✓ Applied' : 'Apply Range'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Series toggles ── */}
      {showControls && (
        <View style={styles.toggleGrid}>
          <ToggleRow
            label="🔵 T1D Baseline"
            color="#2196F3"
            value={showBaseline}
            onChange={setShowBaseline}
          />
          <ToggleRow
            label="🔴 Actual Readings"
            color="#E53935"
            value={showActualReadings}
            onChange={setShowActualReadings}
          />
          <ToggleRow
            label="🟣 BG Readings"
            color="#8031A7"
            value={showEstimatedLine}
            onChange={setShowEstimatedLine}
          />

          <ToggleRow
            label="🟠 Cumulative Shift ⭐"
            color="#FF9800"
            value={showCumulativeEffect}
            onChange={setShowCumulativeEffect}
            bold
          />

        </View>
      )}

      {/* ── Victory Chart ── */}
      <View style={styles.chartWrapper}>
        {chartData.length > 0 ? (
          <VictoryChart
            width={CHART_WIDTH}
            height={height}
            theme={VictoryTheme.material}
            domain={{ x: [timeRange.start, timeRange.end], y: BG_DOMAIN }}
            padding={{ top: 16, bottom: 48, left: 56, right: 56 }}
          >
            {/* X Axis — pinned to BG_DOMAIN[0] so ticks are always at the chart floor */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={(t: number) => formatXAxis(t, viewConfig?.tickFormat)}
              axisValue={BG_DOMAIN[0]}
              style={{
                tickLabels: { fontSize: 9, angle: -45, textAnchor: 'end', fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (left) — Blood Glucose */}
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

            {/* Y Axis (right) — mirrors left axis with identical BG tick values */}
            {showCumulativeEffect && (
              <VictoryAxis
                dependentAxis
                orientation="right"
                tickValues={[40, 80, 100, 120, 140, 180, 200, 250, 300, 350, 400]}
                tickFormat={(v: number) => `${Math.round(v)}`}
                label="mg/dL"
                style={{
                  axisLabel:  { fontSize: 10, fill: '#FF9800', padding: 38 },
                  axis:       { stroke: '#FF9800', strokeWidth: 1 },
                  tickLabels: { fontSize: 9, fill: '#FF9800' },
                  grid:       { stroke: 'none' },
                  ticks:      { stroke: '#FF9800', size: 4 },
                }}
              />
            )}

            {showTargetRange && (
              <VictoryAxis
                axisValue={targetHigh}
                tickFormat={() => ''}
                style={{ axis: { stroke: '#FF8800', strokeWidth: 1, strokeDasharray: '5 5' } }}
              />
            )}
            {showTargetRange && (
              <VictoryAxis
                axisValue={effectiveTarget}
                tickFormat={() => ''}
                style={{ axis: { stroke: '#4CAF50', strokeWidth: 1, strokeDasharray: '3 3' } }}
              />
            )}
            {showTargetRange && (
              <VictoryAxis
                axisValue={targetLow}
                tickFormat={() => ''}
                style={{ axis: { stroke: '#E53935', strokeWidth: 1, strokeDasharray: '5 5' } }}
              />
            )}

            {/* "Now" vertical reference line */}
            {timeRange.now && (
              <VictoryAxis
                dependentAxis
                axisValue={timeRange.now}
                tickFormat={() => ''}
                style={{
                  axis:       { stroke: '#da2a2a', strokeWidth: 1.5, strokeDasharray: '5 4' },
                  grid:       { stroke: 'none' },
                  ticks:      { stroke: 'none', size: 0 },
                  tickLabels: { fill: 'none', fontSize: 0 },
                }}
              />
            )}

            {/* ── Cumulative net effect area (orange) ── */}
            {showCumulativeEffect && (
              <VictoryArea
                data={cumulativeNetData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y) && d.y0 !== null && !isNaN(d.y0)}
                interpolation="monotoneX"
                style={{
                  data: {
                    fill: '#FF9800',
                    fillOpacity: 0.4,
                    stroke: '#FF9800',
                    strokeWidth: 1,
                  },
                }}
              />
            )}

            {/* ── Instantaneous net effect area (green) ── */}
            {showNetEffect && (
              <VictoryArea
                data={netEffectData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y) && d.y0 !== null && !isNaN(d.y0)}
                interpolation="monotoneX"
                style={{
                  data: {
                    fill: '#4CAF50',
                    fillOpacity: 0.25,
                    stroke: '#4CAF50',
                    strokeWidth: 1.5,
                  },
                }}
              />
            )}

            {/* ── T1D Baseline line (blue dashed step) ── */}
            {showBaseline && (
              <VictoryLine
                data={baselineData}
                interpolation="stepAfter"
                style={{
                  data: {
                    stroke: '#2196F3',
                    strokeWidth: 2,
                    strokeDasharray: '8 4',
                    opacity: 0.8,
                  },
                }}
              />
            )}

            {/* ── Connected readings line ── */}
            {showEstimatedLine && (
              <VictoryLine
                data={connectedReadingsData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y)}
                interpolation="monotoneX"
                style={{
                  data: {
                    stroke: '#8031A7',
                    strokeWidth: 2.5,
                  },
                }}
              />
            )}

            {/* ── Actual reading dots (coloured by BG status) ── */}
            {showActualReadings && actualReadingsData.length > 0 && (
              <VictoryScatter
                data={actualReadingsData}
                size={3}
                style={{
                  data: {
                    fill:        ({ datum }: any) => datum.color ?? '#2196F3',
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
          // ── Empty / generating state ──
          <View style={[styles.centered, { height: height * 0.7 }]}>
            {generating ? (
              <>
                <ActivityIndicator size="small" color="#8031A7" />
                <Text style={styles.emptyText}>Calculating…</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyIcon}>📊</Text>
                <Text style={styles.emptyText}>
                  No blood glucose data in this period.
                </Text>
                <TouchableOpacity style={styles.retryBtn} onPress={refresh}>
                  <Text style={styles.retryText}>Refresh</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </View>

      {/* ── About this Chart (collapsible, default collapsed) ── */}
      <View style={styles.aboutContainer}>
        <TouchableOpacity
          style={styles.aboutHeader}
          onPress={() => setAboutExpanded(prev => !prev)}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Text style={styles.aboutHeaderText}>About this Chart</Text>
          <Text style={styles.aboutChevron}>{aboutExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {aboutExpanded && (
          <View style={styles.aboutBody}>

            {/* Series */}
            <Text style={styles.aboutSectionLabel}>Series</Text>
            {[
              { color: '#8031A7', label: 'BG Readings',      desc: 'Connected actual glucose readings',            line: true,  dashed: false },
              { color: '#2196F3', label: 'T1D Baseline',     desc: baselineMode === 'preset' ? 'Circadian baseline (24h curve)' : 'Stable baseline (from reading)',  line: true,  dashed: true  },
              { color: '#FF9800', label: 'Cumulative Shift ⭐', desc: 'Net meal + insulin "bank balance" from baseline', line: false, dashed: false },
              { color: '#4CAF50', label: 'Net Effect',        desc: 'Instantaneous rate-of-change area',           line: false, dashed: false },
              { color: '#E53935', label: 'Actual Readings',   desc: 'Individual fingerstick / CGM dots',           dot: true },
            ].map(({ color, label, desc, line, dashed, dot }) => (
              <View key={label} style={styles.aboutSeriesRow}>
                {dot  ? <View style={[styles.aboutDot,  { backgroundColor: color }]} /> :
                 line ? <View style={[styles.aboutLine, { backgroundColor: color }, dashed && styles.aboutLineDashed]} /> :
                        <View style={[styles.aboutArea, { backgroundColor: color }]} />}
                <View style={styles.aboutSeriesText}>
                  <Text style={styles.aboutSeriesLabel}>{label}</Text>
                  <Text style={styles.aboutSeriesDesc}>{desc}</Text>
                </View>
              </View>
            ))}

            {/* Reference lines */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 12 }]}>Reference Lines</Text>
            {[
              { color: '#FF8800', desc: 'High threshold  (130% of target)' },
              { color: '#4CAF50', desc: 'Target glucose' },
              { color: '#E53935', desc: 'Low threshold   (70% of target)'  },
              { color: '#da2a2a', desc: 'Current time (Now)'               },
            ].map(({ color, desc }) => (
              <View key={desc} style={styles.aboutRefRow}>
                <Text style={[styles.aboutDash, { color }]}>– –</Text>
                <Text style={styles.aboutRefDesc}>{desc}</Text>
              </View>
            ))}

            {/* Right axis note */}
            <View style={styles.aboutNoteBox}>
              <Text style={styles.aboutNoteText}>
                The right axis mirrors the left axis, showing the same absolute mg/dL scale. Use it to read off the cumulative effect and net effect lines directly against blood glucose values without having to cross-reference the left side.
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* ── Now summary strip ── */}
      {chartData.length > 0 && nowPoint && (
        <View style={styles.nowSummary}>
          <View style={styles.nowSummaryMain}>
            <Text style={styles.nowLabel}>Current BG Estimate</Text>
            <Text style={[
              styles.nowBG,
              currentEstimatedBG > targetHigh ? styles.textHigh :
              currentEstimatedBG < targetLow  ? styles.textLow  :
              styles.textNormal,
            ]}>
              {Math.round(currentEstimatedBG)} mg/dL
            </Text>
            <Text style={styles.nowDetail}>
              Baseline {Math.round(effectiveBaseline)}{' '}
              {nowPoint.cumulativeNetBaseline >= 0 ? '+' : ''}
              {Math.round(nowPoint.cumulativeNetBaseline)} cumulative
            </Text>
          </View>

          <View style={styles.nowSummaryRight}>
            <SummaryPill
              label="Meals"
              value={`+${Math.round(nowPoint.cumulativeMealEffect)}`}
              color="#FF9800"
            />
            <SummaryPill
              label="Insulin"
              value={`${Math.round(nowPoint.cumulativeInsulinEffect)}`}
              color="#9C27B0"
            />
            <SummaryPill
              label="Net"
              value={`${nowPoint.cumulativeNetBaseline >= 0 ? '+' : ''}${Math.round(nowPoint.cumulativeNetBaseline)}`}
              color="#2196F3"
            />
          </View>
        </View>
      )}

      {/* ── Tap-to-inspect tooltip modal ── */}
      {tooltipData !== null && (
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

// ============================================================
// SUB-COMPONENTS
// ============================================================

// ── ToggleRow ──────────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label:    string;
  color:    string;
  value:    boolean;
  onChange: (v: boolean) => void;
  bold?:    boolean;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, color, value, onChange, bold }) => (
  <View style={styles.toggleRow}>
    <View style={[styles.toggleSwatch, { backgroundColor: color }]} />
    <Text style={[styles.toggleLabel, bold && styles.toggleLabelBold]}>{label}</Text>
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ true: color, false: '#ccc' }}
      thumbColor={value ? '#fff' : '#f4f3f4'}
      style={styles.toggleSwitch}
    />
  </View>
);

// ── LegendItem ─────────────────────────────────────────────────────────────────

const LegendItem: React.FC<{ color: string; label: string; dashed: boolean; isCircle?: boolean }> = ({
  color, label, dashed, isCircle
}) => (
  <View style={styles.legendItem}>
    {isCircle ? (
      <View style={[styles.legendDot, { backgroundColor: color }]} />
    ) : (
      <View style={[
        styles.legendLine,
        { backgroundColor: color },
        dashed && styles.legendLineDashed,
      ]} />
    )}
    <Text style={styles.legendLabel}>{label}</Text>
  </View>
);

// ── SummaryPill ────────────────────────────────────────────────────────────────

const SummaryPill: React.FC<{ label: string; value: string; color: string }> = ({
  label, value, color
}) => (
  <View style={[styles.pill, { borderColor: color }]}>
    <Text style={styles.pillLabel}>{label}</Text>
    <Text style={[styles.pillValue, { color }]}>{value}</Text>
  </View>
);

// ── BGTooltipModal ─────────────────────────────────────────────────────────────

interface BGTooltipModalProps {
  data:          BGChartPoint;
  stableBaseline: number;
  targetGlucose:  number;
  onClose:        () => void;
}

const BGTooltipModal: React.FC<BGTooltipModalProps> = ({
  data, stableBaseline, targetGlucose, onClose
}) => {
  const estimatedBG      = data.baseBG + data.cumulativeNetBaseline;
  const hasMeals         = data.mealsAdministered.length > 0;
  const hasInsulin       = data.insulinAdministered.length > 0;
  const bgColor          = getBloodSugarStatusColor(estimatedBG, targetGlucose);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={styles.modalOverlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} style={styles.modalCard}>

          {/* ── Header ── */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTime}>
              {data.formattedTime}
              {data.isNow   ? '  🔴 Now'    : ''}
              {data.isFuture ? '  🔮 Future' : ''}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView>
            {/* ── Blood Glucose section ── */}
            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>📊 Blood Glucose</Text>

              {data.actualBG != null && (
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Actual Reading:</Text>
                  <Text style={[styles.modalValue, { color: bgColor }]}>
                    {Math.round(data.actualBG)} mg/dL
                  </Text>
                </View>
              )}

              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>T1D Baseline:</Text>
                <Text style={[styles.modalValue, { color: '#2196F3' }]}>
                  {Math.round(data.baseBG)} mg/dL
                </Text>
              </View>

              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Cumulative Effect:</Text>
                <Text style={[
                  styles.modalValue,
                  { color: data.cumulativeNetBaseline >= 0 ? '#FF9800' : '#2196F3' },
                ]}>
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </View>

              <View style={[styles.modalRow, styles.modalRowHighlight]}>
                <Text style={[styles.modalLabel, { fontWeight: '700' }]}>Projected BG:</Text>
                <Text style={[styles.modalValue, { color: bgColor, fontWeight: '700' }]}>
                  {Math.round(estimatedBG)} mg/dL
                </Text>
              </View>

              <Text style={styles.modalFormula}>
                {Math.round(data.baseBG)} + {Math.round(data.cumulativeNetBaseline)} = {Math.round(estimatedBG)}
              </Text>
            </View>

            {/* ── Cumulative Bank Balance ── */}
            <View style={[styles.modalSection, { borderColor: '#FF9800' }]}>
              <Text style={styles.modalSectionTitle}>🏦 Cumulative Bank Balance</Text>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>🍽️ Meals (absorbed):</Text>
                <Text style={[styles.modalValue, { color: '#FF9800' }]}>
                  +{Math.round(data.cumulativeMealEffect)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>💉 Insulin (absorbed):</Text>
                <Text style={[styles.modalValue, { color: '#9C27B0' }]}>
                  {Math.round(data.cumulativeInsulinEffect)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Net:</Text>
                <Text style={[
                  styles.modalValue,
                  { color: data.cumulativeNetBaseline >= 0 ? '#FF9800' : '#2196F3' },
                ]}>
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </View>
            </View>

            {/* ── Instantaneous Rate of Change ── */}
            <View style={[styles.modalSection, { borderColor: '#4CAF50' }]}>
              <Text style={styles.modalSectionTitle}>⚡ Instantaneous Rate of Change</Text>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>🍽️ Meal Impact:</Text>
                <Text style={[styles.modalValue, { color: '#FF9800' }]}>
                  +{Math.round(data.mealImpact)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>💉 Insulin Impact:</Text>
                <Text style={[styles.modalValue, { color: '#9C27B0' }]}>
                  {Math.round(data.insulinImpact)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Net Effect:</Text>
                <Text style={[
                  styles.modalValue,
                  { color: data.netEffect >= 0 ? '#FF9800' : '#2196F3' },
                ]}>
                  {data.netEffect >= 0 ? '+' : ''}{Math.round(data.netEffect)} mg/dL
                </Text>
              </View>
            </View>

            {/* ── Confidence ── */}
            <View style={styles.modalSection}>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Confidence:</Text>
                <Text style={[styles.modalValue, { color: data.confidenceColor }]}>
                  {data.confidenceLevel.replace(/_/g, ' ')}
                </Text>
              </View>
            </View>

            {/* ── Meals at this time ── */}
            {hasMeals && (
              <View style={[styles.modalSection, { borderColor: '#FF9800' }]}>
                <Text style={styles.modalSectionTitle}>
                  🍽️ Meals ({data.mealsAdministered.length})
                </Text>
                {data.mealsAdministered.map((meal: any, idx: number) => {
                  const carbs =
                    meal.calculation_summary?.total_carb_equiv ??
                    meal.nutrition?.total_carb_equiv ??
                    meal.nutrition?.totalCarbEquiv ??
                    meal.carbEquiv ?? 0;
                  return (
                    <View key={idx} style={styles.doseItem}>
                      <Text style={styles.doseTime}>
                        {new Date(meal.timestamp).toLocaleTimeString([], {
                          hour: '2-digit', minute: '2-digit'
                        })}
                      </Text>
                      <Text style={styles.doseDetail}>
                        {carbs.toFixed(1)}g carb equiv
                      </Text>
                      {meal.foodItems?.slice(0, 3).map((item: any, i: number) => (
                        <Text key={i} style={styles.foodItem}>
                          • {item.name ?? item.food_name}
                        </Text>
                      ))}
                      {(meal.foodItems?.length ?? 0) > 3 && (
                        <Text style={styles.foodItemMore}>
                          … and {meal.foodItems.length - 3} more
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── Insulin at this time ── */}
            {hasInsulin && (
              <View style={[styles.modalSection, { borderColor: '#9C27B0' }]}>
                <Text style={styles.modalSectionTitle}>
                  💉 Insulin ({data.insulinAdministered.length})
                </Text>
                {data.insulinAdministered.map((dose: any, idx: number) => (
                  <View key={idx} style={styles.doseItem}>
                    <Text style={styles.doseTime}>
                      {new Date(dose.administrationTime ?? dose.taken_at).toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit'
                      })}
                    </Text>
                    <Text style={styles.doseDetail}>
                      {(dose.dose ?? dose.units ?? 0).toFixed(1)} U{' '}
                      {dose.medication ?? dose.insulinType ?? ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.modalFooter}>Tap outside to close</Text>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

// ============================================================
// STYLESHEET
// ============================================================

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  embedded: {
    borderRadius: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  errorText: {
    fontSize: 14,
    color: '#E53935',
    textAlign: 'center',
    marginBottom: 12,
  },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#8031A7',
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerText:     { flex: 1 },
  headerTitle:    { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  headerSubtitle: { fontSize: 11, color: '#888', marginTop: 2 },
  refreshBtn:     { padding: 4, marginLeft: 8 },
  refreshIcon:    { fontSize: 20 },

  // ── View mode ──
  viewModeScroll: {
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  viewModeRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  viewModeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#f5f5f5',
  },
  viewModeBtnActive: {
    backgroundColor: '#8031A7',
  },
  viewModeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
  },
  viewModeBtnTextActive: {
    color: '#fff',
  },

  // ── Custom date-range panel ──
  viewModeBtnCustom:      { borderWidth: 1.5, borderColor: '#8031A7', backgroundColor: 'transparent' },
  customRangePanel:       { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#fdf8ff' },
  customRangeRow:         { flexDirection: 'row', gap: 8, marginBottom: 4 },
  customRangePicker:      { flex: 1 },
  customRangeApplyBtn:    { backgroundColor: '#8031A7', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  customRangeAppliedBtn:  { backgroundColor: '#6a1b9a' },
  customRangeApplyText:   { color: '#fff', fontWeight: '700', fontSize: 14 },

  // ── Toggles ──
  toggleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '48%',
    marginBottom: 4,
  },
  toggleSwatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  toggleLabel: {
    flex: 1,
    fontSize: 11,
    color: '#444',
  },
  toggleLabelBold: {
    fontWeight: '700',
    color: '#E65100',
  },
  toggleSwitch: {
    transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }],
  },

  // ── Chart ──
  chartWrapper: {
    paddingHorizontal: 0,
  },

  // ── About this Chart (collapsible) ──
  aboutContainer: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    marginTop: 4,
  },
  aboutHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  aboutHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  aboutChevron: { fontSize: 11, color: '#9ca3af' },
  aboutBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  aboutSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  aboutSeriesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 10,
  },
  aboutDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#fff',
    flexShrink: 0,
  },
  aboutLine: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
    flexShrink: 0,
  },
  aboutLineDashed: {
    opacity: 0.55,
  },
  aboutArea: {
    width: 20,
    height: 10,
    borderRadius: 3,
    opacity: 0.45,
    flexShrink: 0,
  },
  aboutSeriesText: { flex: 1 },
  aboutSeriesLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  aboutSeriesDesc: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 1,
  },
  aboutRefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  aboutDash: {
    fontSize: 13,
    fontWeight: '700',
    width: 28,
    letterSpacing: 1,
  },
  aboutRefDesc: {
    fontSize: 12,
    color: '#374151',
  },
  aboutNoteBox: {
    marginTop: 12,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#d1d5db',
  },
  aboutNoteText: {
    fontSize: 11,
    color: '#6b7280',
    lineHeight: 16,
  },

  // ── Now summary ──
  nowSummary: {
    flexDirection: 'row',
    padding: 12,
    margin: 12,
    backgroundColor: '#f8f4ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0d4f0',
  },
  nowSummaryMain:  { flex: 1 },
  nowLabel:        { fontSize: 11, color: '#666', marginBottom: 2 },
  nowBG:           { fontSize: 28, fontWeight: '700' },
  textHigh:        { color: '#FF6B00' },
  textLow:         { color: '#E53935' },
  textNormal:      { color: '#8031A7' },
  nowDetail:       { fontSize: 11, color: '#888', marginTop: 2 },
  nowSummaryRight: { alignItems: 'flex-end', gap: 4 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: '#fff',
  },
  pillLabel: { fontSize: 10, color: '#888' },
  pillValue: { fontSize: 12, fontWeight: '700' },

  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  modalTime:  { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  modalClose: { fontSize: 18, color: '#888', padding: 4 },
  modalSection: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#f9fafb',
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
  },
  modalSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#333',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  modalRowHighlight: {
    backgroundColor: '#f0ebff',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 4,
  },
  modalLabel: {
    fontSize: 13,
    color: '#555',
  },
  modalValue: {
    fontSize: 13,
    fontWeight: '600',
  },
  modalFormula: {
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
    marginTop: 4,
    fontStyle: 'italic',
  },
  doseItem: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    marginBottom: 4,
  },
  doseTime:     { fontSize: 12, fontWeight: '600', color: '#333' },
  doseDetail:   { fontSize: 12, color: '#555' },
  foodItem:     { fontSize: 11, color: '#777', paddingLeft: 8, marginTop: 2 },
  foodItemMore: { fontSize: 11, color: '#999', fontStyle: 'italic', paddingLeft: 8 },
  modalFooter:  {
    textAlign: 'center',
    fontSize: 11,
    color: '#999',
    marginVertical: 12,
  },
});

export default React.memo(BloodGlucoseVisualization);