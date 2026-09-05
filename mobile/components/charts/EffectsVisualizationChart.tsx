/**
 * ============================================================================
 * EFFECTS VISUALIZATION CHART — Mobile Port (React Native)
 * ============================================================================
 *
 * Ported from: frontend/src/components/EffectsVisualization.js (v5.0)
 * Location:    mobile/components/charts/EffectsVisualizationChart.tsx
 *
 * CHART LIBRARY: victory-native
 *   Install: npx expo install victory-native react-native-svg
 *   Docs:    https://formidable.com/open-source/victory/docs/native
 *
 * KEY DIFFERENCES FROM WEB VERSION:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. DATA SOURCE
 *    Web:    useBloodSugarData() context → recentMealsData / recentInsulinData
 *    Mobile: useActiveEffects() hook → meals / insulinDoses (already fetched)
 *            No second API call needed; hook exposes raw arrays directly.
 *
 * 2. PER-POINT CALCULATION
 *    Web:    calculateNetEffectAtTime() (single all-in-one function)
 *    Mobile: calculateStackedMealEffect() + calculateStackedInsulinEffect()
 *            + calculateTotalCumulativeEffects() (three separate calls per point)
 *            Uses the v4.4 persist-at-100% fix from @/utils/calculations.
 *
 * 3. CUMULATIVE BASELINE CORRECTNESS (from ActiveEffectsDisplay_comparison.tsx)
 *    - allMealsInWindow (not just activeMeals) fed to calculateTotalCumulativeEffects
 *    - Only meals/doses after the daily reset are counted
 *    - Doses normalised to InsulinDose shape before passing to PK functions
 *    - Readings filtered to current daily period only
 *
 * 4. RENDERING
 *    Web:    Recharts ComposedChart (SVG, web)
 *    Mobile: victory-native VictoryChart (SVG via react-native-svg)
 *
 * 5. NO FULLSCREEN API
 *    document.requestFullscreen() removed; replaced with RN Modal pattern (TODO).
 *
 * SERIES RENDERED:
 *   🍽️ Meal Effect       (orange area)    — showMealEffect toggle
 *   💉 Insulin Effect    (purple area)    — showInsulinEffect toggle
 *   📊 Net Effect        (blue dashed)    — showNetEffect toggle
 *   📈 Cumulative Shift  (green solid ⭐) — showCumulativeBaseline toggle
 *   🔶 Meal Dose Bars    (orange bar)     — showDoseMarkers toggle
 *   🔷 Insulin Dose Bars (purple bar)     — showDoseMarkers toggle
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
} from 'react-native';

// ── Chart library ──────────────────────────────────────────────────────────────
// Install: npx expo install victory-native react-native-svg
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryBar,
  VictoryAxis,
  VictoryTheme,
  VictoryScatter,
  VictoryTooltip,
  VictoryVoronoiContainer,
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
  // v4.14: Universal floor utility — prevents the cumulative insulin effect from
  // rising back up as the post-exercise sensitivity multiplier decays.
  applyInsulinCumulativeFloor,
} from '@/utils/calculations/cumulative-effects';
import { SHARED_CONSTANTS, MEAL_ABSORPTION_PROFILES, DEFAULT_PATIENT_CONSTANTS, getCumulativeLookbackHours } from '@/constants/shared-constants';

// ── Hooks ──────────────────────────────────────────────────────────────────────
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

// ── Chart utilities (from ChartUtils.tsx) ─────────────────────────────────────
import {
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  generateSymmetricTicks,
  calculateEffectsAxisDomain,
  calculateDoseAxisDomain,
  formatXAxis,
  findMealsAtTime,
  findInsulinAtTime,
  parseUTCMs,
  VIEW_CONFIGS,
  getLastResetTimeMs,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  type TimeRange,
} from '@/utils/ChartUtils';

// ── Types ──────────────────────────────────────────────────────────────────────
import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { ActivityPDResult, ActivityContribution } from '@/services/api/activity-pharmacodynamics';
import type { ActivityHistoryResponse } from '@/services/api/activities';
// FIX (Bug 3): InsulinDoseForStacking is used in buildChartPoint's type guard but
// was never imported.  ChartUtils imports it internally and does not re-export it,
// so we pull it directly from the pharmacodynamics module.
import type { InsulinDoseForStacking } from '@/utils/insulin/pharmacodynamics';

// ============================================================
// CONSTANTS
// ============================================================

// VIEW_CONFIGS is imported from ChartUtils (merges shared-constants with safe defaults)

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT = 280;
const CHART_WIDTH  = SCREEN_WIDTH - 32; // 16px padding each side

// ============================================================
// INTERNAL TYPES
// ============================================================

interface EffectsChartPoint {
  timestamp: number;
  formattedTime: string;

  // Rate-of-change series
  mealImpact: number;
  insulinImpact: number;   // always <= 0
  netEffect: number;

  // Cumulative "bank balance"
  cumulativeMealEffect: number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline: number;

  // Dose markers (null = no dose at this point)
  mealDoseMarker: number | null;
  insulinDoseMarker: number | null;

  // Tooltip extras
  mealsAdministered: any[];
  insulinAdministered: any[];

  isHistorical: boolean;
  isFuture: boolean;
  isNow: boolean;

  /**
   * Signed cumulative activity BG effect at this time point (mg/dL).
   * Computed from activity_contributions using the W-state exponential decay
   * model that mirrors the backend ODE.
   * Negative = BG-lowering (aerobic). Positive = BG-raising (anaerobic/stress).
   * 0 when no activityPD data is available.
   */
  activityEffect: number;

  // ── Activity sensitivity indirect effects (Phase 2 additions) ────────────

  /** Unscaled insulin BG impact (base CF, no sensitivity boost). Always ≤ 0.
   *  RATE/netEffect use only — snaps to 0 when a dose expires (correct for rate). */
  insulinImpactBase: number;

  /** Extra BG reduction from post-exercise ISF boost. Always ≤ 0.
   *  Contract: insulinImpact === insulinImpactBase + insulinSensitivityBoost. */
  insulinSensitivityBoost: number;

  /**
   * Phase-3-persist version of insulinImpactBase — use for the purple DISPLAY area.
   * Expired doses persist at -(dose × baseCF) so the area never snaps back toward
   * zero at dose expiry (eliminates the "peak" artefact).
   * Always ≤ insulinImpactBase (more negative once any dose has expired).
   */
  insulinImpactBaseDisplay: number;

  /** mealImpact recalculated with effectiveC2B = carb_to_bg_factor / sensitivityMultiplier.
   *  Equals mealImpact when sensitivityMultiplier === 1.0. Always ≥ 0. */
  activityAdjustedMealImpact: number;

  /** Effective W-state multiplier at this chart time point. 1.0 = no activity. */
  sensitivityMultiplier: number;

  /**
   * Lock-in cumulative activity BG effect — same model as cumulativeNetBaseline.
   * Used for the blue shaded area so it tracks the green line's activity component.
   * Negative = BG-lowering (aerobic).
   */
  activityCumulativeEffect: number;
}

interface TooltipData {
  point: EffectsChartPoint;
  x: number;
  y: number;
}

export interface EffectsVisualizationChartProps {
  height?: number;
  showControls?: boolean;
  embedded?: boolean;
  defaultView?: string;
  onDataUpdate?: (data: EffectsChartPoint[]) => void;
  /**
   * SPEC §2f — Data source choice: accept activityPD as a prop from the parent
   * screen (e.g. the dashboard that already fetches it for ActiveEffectsDisplay).
   *
   * This avoids a duplicate API call. The parent simply passes:
   *   <EffectsVisualizationChart activityPD={activityPDResult} />
   *
   * When null/undefined (no activity today or network failure) the chart
   * renders without the activity overlay — degrades gracefully per spec.
   *
   * If the chart is rendered standalone (no parent fetch), wrap it in a
   * container that calls fetchStackedActivityEffectSafe() with a 30 s
   * debounce and passes the result here.
   */
  activityPD?: ActivityPDResult | null;
}

// ============================================================
// HELPER UTILITIES
// (Ported from ActiveEffectsDisplay_comparison.tsx)
// ============================================================

// parseUTCMs, getLastResetTimeMs, getMealDurationHours, normaliseDose, and
// doseToStacking are imported from ChartUtils.

/** Normalise raw API meal → guaranteed id + calculation_summary fields. */
function normaliseMeal(raw: any): any {
  return {
    ...raw,
    id: raw.id ?? String(raw._id ?? ''),
    calculation_summary: raw.calculation_summary ?? {},
    nutrition: raw.nutrition ?? {},
  };
}

/** Get PK duration for a dose (hours). */
function getDoseDurationHours(dose: any, constants: any): number {
  return constants?.medication_factors?.[dose?.insulinType ?? dose?.medication]?.duration_hours ?? 4.0;
}

// ============================================================
// ACTIVITY EFFECT HELPERS (Spec §STEP 2 — §2a / §2d / §2e)
// ============================================================

/**
 * τ_W (90 min) — post-exercise sensitivity window duration.
 * Sourced from SHARED_CONSTANTS.HR_MODEL.tau_W — never hardcoded (spec constraint).
 * Uses the same key casing as activity-pharmacodynamics.ts destructuring.
 */
const TAU_W_MIN: number = (SHARED_CONSTANTS as any)?.HR_MODEL?.tau_W ?? 90;
const TAU_W_MS:  number = TAU_W_MIN * 60_000;

// ============================================================
// SYNTHETIC HISTORICAL ACTIVITY CONTRIBUTION HELPERS
// ============================================================

/**
 * ODE model constants (mirrors activity_pharmacodynamics.py HR_MODEL).
 * Used for the client-side synthetic BG drop approximation for historical sessions.
 */
const ACUTE_RATE_PER_MIN = 0.135;  // mg/dL per minute at Z=1
// ⚠️ CHART DISPLAY ONLY — NOT from HR_MODEL / SHARED_CONSTANTS.
// SYNTHETIC_TAU_Z is a visual approximation of Z-rise for historical sessions
// that have no HR trace (categorical path).  It is NOT used in dose calculations.
// If the true τ_Z param is tuned in HR_MODEL, update this value to match manually.
const SYNTHETIC_TAU_Z    = 15;    // effective Z rise τ for categorical HR path (min)

const INTENSITY_HR_FRACTION: Record<string, number> = {
  light:    0.50,
  moderate: 0.65,
  vigorous: 0.80,
};

/**
 * Parse "HH:MM" or numeric string to total minutes.
 * Mirrors activity_pharmacodynamics.py::_parse_duration_field().
 */
function parseDurationStr(dur: string | number | undefined): number {
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

/** Map ActivityHistoryResponse.level to intensity string using SHARED_CONSTANTS.
 *
 * SHARED_CONSTANTS.LEVEL_TO_INTENSITY (source of truth):
 *   "-2" → null (sedentary / rest)
 *   "-1" → null (sedentary / rest)
 *    "0" → "light"
 *    "1" → "moderate"
 *    "2" → "vigorous"
 *
 * FIX (Bug 2): The previous hardcoded thresholds were wrong:
 *   >=3 → "vigorous"  (level 3 doesn't exist; vigorous is level 2)
 *   >=2 → "moderate"  (level 2 should be "vigorous")
 *   else → "light"    (level 1 should be "moderate")
 *
 * This caused every level-2 (vigorous) session to be classified as
 * "moderate" — underestimating the synthetic BG effect by ~30%.
 * Level -1/-2 (sedentary) were incorrectly classified as "light".
 *
 * Fix: delegate to SHARED_CONSTANTS.LEVEL_TO_INTENSITY so the mapping
 * stays in sync with the backend.  Returns null for sedentary/unmapped
 * levels so historyRecordToContribution can filter them out.
 */
function levelToIntensity(level: number | undefined): 'light' | 'moderate' | 'vigorous' | null {
  if (level === undefined || level === null) return null;
  const key = String(Math.round(level));
  const intensity = (SHARED_CONSTANTS as any).LEVEL_TO_INTENSITY?.[key];
  // null = sedentary (-1 / -2); undefined = unmapped level — both skip
  if (intensity === null || intensity === undefined) return null;
  return intensity as 'light' | 'moderate' | 'vigorous';
}

/**
 * Approximate signed cumulative BG effect for a historical activity session.
 *
 * Mirrors the categorical (synthetic_hr) path in activity_pharmacodynamics.py.
 * Formula:
 *   Z_avg  = 1 − exp(−min(duration, 90) / SYNTHETIC_TAU_Z)
 *              (Z-state saturation approximation for categorical HR)
 *   drop   = ACUTE_RATE × min(duration, 90) × Z_avg × intensityScale × weightScale
 *   result = bg_direction × (−drop)  [negative for aerobic]
 *
 * Cross-check vs backend ODE for population values (hr_base=70, hr_max=190, 70 kg):
 *   Light    30 min →  −2.3 mg/dL   (backend ≈ −2.0 – −2.8)
 *   Moderate 30 min →  −3.8 mg/dL   (backend ≈ −3.3 – −4.2)
 *   Vigorous 60 min → −10.3 mg/dL   (backend ≈ −9.0 – −12.0)
 *
 * @param intensity       - 'light' | 'moderate' | 'vigorous'
 * @param durationMinutes - Session length in minutes
 * @param weightKg        - Patient weight (default 70 kg — population allometry)
 * @param bgDirection     - -1 = aerobic/BG-lowering (default); +1 = BG-raising
 */
function syntheticCumulativeBgEffect(
  intensity: 'light' | 'moderate' | 'vigorous',
  durationMinutes: number,
  weightKg: number = 70,
  bgDirection: -1 | 1 = -1,
): number {
  const fraction      = INTENSITY_HR_FRACTION[intensity] ?? INTENSITY_HR_FRACTION.moderate;
  const intensityScale = fraction / INTENSITY_HR_FRACTION.moderate; // relative to moderate
  const dEff           = Math.min(Math.max(durationMinutes, 1), 90);
  const zAvg           = 1 - Math.exp(-dEff / SYNTHETIC_TAU_Z);
  const weightScale    = Math.pow(70 / Math.max(weightKg, 40), 0.25);
  const magnitude      = ACUTE_RATE_PER_MIN * dEff * zAvg * intensityScale * weightScale;
  // bgDirection=-1 → result is negative (BG-lowering); +1 → positive (BG-raising)
  return bgDirection * magnitude;
}

/**
 * Convert a raw ActivityHistoryResponse record to a synthetic ActivityContribution
 * that calculateActivityEffectAtTime() can consume.
 *
 * Returns null when the record cannot be reliably converted (missing timestamp,
 * sedentary level, or future start time).
 *
 * @param rec              - Activity history record from GET /api/activity-history
 * @param patientConstants - Used for weight_kg allometric scaling (optional)
 */
function historyRecordToContribution(
  rec: ActivityHistoryResponse,
  patientConstants?: any,
): ActivityContribution | null {
  // Only completed activities have a real BG effect
  if (rec.type && rec.type !== 'completed') return null;

  // Resolve start time — prefer startTime, fall back to completedTime / timestamp
  const startMs = parseUTCMs(
    (rec as any).startTime ?? (rec as any).completedTime ?? (rec as any).timestamp
  );
  if (isNaN(startMs)) return null;

  // Resolve intensity — prefer string field, fall back to numeric level.
  // levelToIntensity now returns null for sedentary/unmapped levels (Bug 2 fix).
  const intensityStr = (rec as any).intensity as string | undefined;
  const intensity: 'light' | 'moderate' | 'vigorous' | null =
    intensityStr && INTENSITY_HR_FRACTION[intensityStr]
      ? (intensityStr as 'light' | 'moderate' | 'vigorous')
      : levelToIntensity((rec as any).level);

  // Sedentary or unmapped level — no BG effect, skip this record
  if (!intensity) return null;

  const durationMinutes = parseDurationStr((rec as any).duration ?? (rec as any).duration_minutes);
  const weightKg: number = patientConstants?.weight_kg ?? 70;
  const bgDirection: -1 | 1 = (rec as any).bg_direction === 1 ? 1 : -1;

  const cumulativeBgEffect = syntheticCumulativeBgEffect(
    intensity, durationMinutes, weightKg, bgDirection
  );

  return {
    activity_id:         rec.id ?? String((rec as any)._id ?? ''),
    start_time:          new Date(startMs).toISOString(),
    intensity,
    duration_minutes:    durationMinutes,
    bg_direction:        bgDirection,
    cumulative_bg_effect: cumulativeBgEffect,
    remaining_bg_drop:   0,    // historical — acute drop fully delivered
    absorbed_fraction:   1.0,  // historical — fully absorbed
    is_active:           false,
    model:               'synthetic_hr',
  };
}

/**
 * Calculate the signed cumulative activity BG effect at a given time point.
 *
 * Model (exponential W-state decay — mirrors the backend ODE):
 *   • Before session start:           0
 *   • During session (0 → duration):  ramps linearly to cumulative_bg_effect
 *     (linear ramp is a valid approximation for the Y/Z ODE states during
 *     moderate sustained exercise — the states rise near-linearly before
 *     reaching steady state for session durations ≤ 90 min)
 *   • Post-exercise (t > duration):   W(t) = fullEffect × exp(−(t−end) / τ_W)
 *     Exponential decay with time constant τ_W (90 min from HR_MODEL.tau_w).
 *     This replaces the previous linear recovery, which diverged from the
 *     backend ODE especially for the tail of the recovery window.
 *     After ~3 × τ_W (≈ 4.5 h) the effect is < 5 % of peak — negligible.
 *
 * FIX (D-1): post-exercise phase changed from linear to exponential, matching
 * the W-state ODE: dW/dt = −W/τ_W → W(t) = W_peak × exp(−t/τ_W).
 * The previous linear model always recovered to exactly 0 at end + τ_W,
 * producing a hard kink in the curve.  Exponential decay is smooth and
 * consistent with the backend's activity_contributions values.
 *
 * Sign convention: cumulative_bg_effect is already signed (negative for aerobic).
 * Sum contributions from all sessions.
 *
 * @param targetMs        - Chart time point in UTC ms
 * @param contributions   - Per-session activity_contributions from the PD response
 * @param tauWMs          - Post-exercise W-state time constant in ms (TAU_W_MS)
 * @param resetTimeMs     - Daily reset boundary for this chart point (UTC ms).
 *                          Contributions whose start_time falls before this are
 *                          excluded, matching the reset logic used by
 *                          calculateActivityEffectForCumulative() and
 *                          calculateTotalCumulativeEffects().  Pass 0 (or omit)
 *                          to disable the reset guard (not recommended).
 */
function calculateActivityEffectAtTime(
  targetMs: number,
  contributions: ActivityContribution[],
  tauWMs: number,
  resetTimeMs: number = 0,
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    // ── Daily reset guard ────────────────────────────────────────────────────
    // Skip sessions that started before this chart point's reset boundary so
    // the teal line resets to 0 at the daily reset hour, consistent with every
    // other series.  Mirrors the identical guard in calculateActivityEffectForCumulative().
    if (resetTimeMs > 0 && startMs < resetTimeMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      // During session: linear ramp from 0 → fullEffect
      // (approximates Y/Z ODE states for sustained moderate exercise)
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
// implements the three-phase exponential decay model for the teal rate line
// and has a different signature (tauWMs param). It is NOT the same function.

/**
 * Returns the effective insulin-sensitivity multiplier at `targetMs` for
 * a given set of activity contributions.
 *
 * W-state model (UPDATED — sensitivity starts at session start, not end):
 *
 *   During session  (startMs → endMs):             peakBoost (flat — instant onset)
 *   Post-exercise plateau (endMs → endMs + τ_W):   peakBoost (flat)
 *   After plateau   (> endMs + τ_W):               peakBoost × exp(−(t−end−τ_W) / τ_W)
 *
 * CHANGE (sensitivity-at-start):
 *   Previously the during-session phase ramped linearly from 0 → peakBoost.
 *   Physiologically, insulin sensitivity begins improving within the first
 *   minutes of aerobic exercise (GLUT4 translocation is near-instantaneous
 *   relative to typical session durations). The ramp was a visual approximation
 *   that understated the indirect effect during the session — especially for
 *   long sessions (60–90 min) where half or more of the session was spent at
 *   reduced sensitivity.
 *
 *   The fix: once targetMs >= startMs the full peakBoost is applied immediately,
 *   matching the plateau behaviour post-exercise. The step is intentional; the
 *   caller (PS-1) accepted the instant-onset as an acceptable simplification.
 *
 *   The DIRECT BG-lowering series (activityEffectAtTime / activityEffectForDisplay)
 *   is unchanged — it still ramps linearly during the session because the
 *   cumulative glucose uptake genuinely accumulates over time. Only the
 *   INDIRECT sensitivity multiplier uses instant onset.
 *
 * NOTE (Q1 confirmed): ActivityContribution does NOT carry a per-session
 * sensitivity_multiplier. `peakMultiplier` (from activityPDResult.sensitivity_multiplier)
 * is the live API value and is only authoritative for points near "now".
 *
 * FIX — per-contribution intensity fallback:
 *   The previous code had a global early-exit: `if (peakMultiplier <= 1.005) return 1.0`.
 *   Once the live API scalar decays to baseline (~2–3 h post-exercise), every chart
 *   point — including historical ones still inside the plateau window — returned 1.0.
 *   This caused hasSensitivityBoost to become false, erasing all boost overlays and
 *   zeroing out the indirect meal/insulin adjustments retroactively.
 *
 *   Fix: remove the global early-exit. For each contribution, use the global API
 *   peak when it is meaningful (globalPeakBoost > 0.005); otherwise fall back to
 *   an intensity-derived approximate peak so historical boost windows stay visible.
 *   The INTENSITY_PEAK_BOOST values are population-calibrated approximations of
 *   HR_MODEL alpha × W_peak × (1 + Z_peak) for each intensity level.
 *
 * @param targetMs         Chart time point in Unix ms
 * @param contributions    mergedActivityContributions (ActivityContribution[])
 * @param peakMultiplier   effectiveActivityPD.sensitivity_multiplier (live API value)
 * @param tauWMs           τ_W in ms (TAU_W_MS = 90 × 60 × 1000)
 */
function calculateSensitivityMultiplierAtTime(
  targetMs: number,
  contributions: ActivityContribution[],
  peakMultiplier: number,
  tauWMs: number,
): number {
  if (contributions.length === 0) return 1.0;

  // Sourced from SHARED_CONSTANTS — single source of truth shared with BGV.
  // Population-calibrated chart fallback when live API scalar has decayed to baseline.
  // If HR_MODEL alpha or W dynamics are re-tuned, update SHARED_CONSTANTS.INTENSITY_PEAK_BOOST.
  const INTENSITY_PEAK_BOOST: Record<string, number> =
    (SHARED_CONSTANTS as any)?.INTENSITY_PEAK_BOOST ?? { light: 0.10, moderate: 0.25, vigorous: 0.40 };

  const MAX_BOOST: number =
    (SHARED_CONSTANTS as any)?.HR_MODEL?.max_sensitivity_boost ?? 0.60;
  const globalPeakBoost = Math.max(0, peakMultiplier - 1); // e.g. 0.4 for ×1.4
  let totalBoost = 0;

  for (const c of contributions) {
    // Q1 confirmed: field names are start_time and duration_minutes
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;

    // Per-contribution peak: prefer the global API scalar when it reflects a live
    // session (globalPeakBoost > 0.005). Fall back to intensity-derived value for
    // historical sessions whose live scalar has already decayed to baseline.
    const intensityBoost = INTENSITY_PEAK_BOOST[c.intensity ?? 'moderate'] ?? 0.25;
    const peakBoost = globalPeakBoost > 0.005 ? globalPeakBoost : intensityBoost;

    if (targetMs <= endMs) {
      // During session: sensitivity is at full peakBoost from the moment exercise
      // starts. GLUT4 translocation begins within the first minutes of aerobic
      // exercise, so the indirect effect (meal CR reduction, ISF boost) is present
      // throughout the session — not just at the end.
      // NOTE: the DIRECT BG-lowering ramp (activityEffectAtTime) is unchanged;
      // only this indirect sensitivity function uses instant onset.
      totalBoost += peakBoost;
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

/**
 * Returns the PEAK (constant) sensitivity multiplier for the session + plateau
 * flat window: [startMs, endMs + τ_W].
 *
 * ─── v4.11 FIX: INDIRECT EFFECT DECAY IN POST-PLATEAU PERIOD ─────────────────
 *
 * BUG: `effectiveCFForCumulative` and `effectiveC2BForCumulative` were computed
 *   from the time-varying `sensitivityMultiplierAtTime`.  After the post-exercise
 *   plateau ends (endMs + τ_W), `sensitivityMultiplierAtTime` decays exponentially.
 *   At each subsequent chart point the CF override SHRANK and the C2B override GREW,
 *   so Phase 1/2 insulin contributions became progressively less negative while meal
 *   contributions became more positive — the cumulative green line drifted UPWARD
 *   even though no new food or insulin had been introduced.
 *
 *   The v4.7 `> 1.005` threshold guard prevented drift below the noise floor, but
 *   left the full decay region above 1.005 unprotected.  The visible artefact was
 *   the green line "reversing" or "cancelling" the augmented indirect effect right
 *   after the session ended, even while the blue sensitivity bar was still showing
 *   the window as active.
 *
 * FIX: Use a FLAT (binary) window for the cumulative CF/C2B overrides:
 *   Inside  [startMs, endMs + τ_W]: apply the constant peakBoost multiplier.
 *   Outside the window              : return 1.0 → no override.
 *
 *   `calculateSensitivityMultiplierAtTime` is unchanged — it continues to drive
 *   the VISUAL indirect-effect areas (purple/rose insulin boost, orange/green meal
 *   reduction, and the `sensitivityMultiplier` field) where the smooth decay is
 *   correct.  The two functions now serve distinct purposes:
 *
 *     calculateSensitivityMultiplierAtTime  → visual display series (decays)
 *     calculateFlatWindowMultiplier         → cumulative bank-balance overrides (flat)
 *
 * Physiological rationale: the metabolic benefit delivered during the sensitivity
 * window is locked in — it cannot be retroactively reduced just because the W-state
 * has begun decaying.  The bank balance should reflect the full augmented action
 * throughout the window and then stop, not gradually un-deliver it.
 *
 * @param targetMs          Chart time point in UTC ms
 * @param contributions     mergedActivityContributions
 * @param peakMultiplier    effectiveActivityPD.sensitivity_multiplier (live API value)
 * @param tauWMs            τ_W in ms (TAU_W_MS)
 */
function calculateFlatWindowMultiplier(
  targetMs: number,
  contributions: ActivityContribution[],
  peakMultiplier: number,
  tauWMs: number,
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
    const endMs = startMs + durationMs;
    const intensityBoost = INTENSITY_PEAK_BOOST[c.intensity ?? 'moderate'] ?? 0.25;
    const peakBoost = globalPeakBoost > 0.005 ? globalPeakBoost : intensityBoost;

    // Flat window: session start → session end + τ_W plateau.
    // Outside this window: no contribution (indirect boost has concluded).
    if (targetMs <= endMs + tauWMs) {
      totalBoost += peakBoost;
    }
  }
  return 1 + Math.min(totalBoost, MAX_BOOST);
}

// ============================================================
// PER-POINT CALCULATION
// ============================================================

/**
 * Create the pair of Phase 3 clamp resolvers for a single generateChartData run.
 *
 * ── Why this is a factory and not inline closures ────────────────────────────
 * `buildChartPoint` is called once per chart tick (e.g. 144 times for a 24 h
 * view at 10-min intervals).  In v4.13 the resolvers close over
 * `activityContributions`, `peakSensitivityMultiplier`, `tauWMs`, `correctionFactor`,
 * and `carbToBGFactor` — all of which are STABLE for the entire map() loop.
 * Creating two new closure objects on every tick wasted allocations for no reason.
 *
 * Call this ONCE in generateChartData before the loop and pass the returned
 * pair into every buildChartPoint call.  buildChartPoint falls back to
 * creating inline resolvers if no pair is supplied (backward-compatible).
 */
function makePhase3Resolvers(
  activityContributions: ActivityContribution[],
  peakSensitivityMultiplier: number,
  tauWMs: number,
  correctionFactor: number,
  carbToBGFactor: number,
): {
  resolvePhase3CF:  (absorptionEndMs: number) => number | undefined;
  resolvePhase3C2B: (absorptionEndMs: number) => number | undefined;
} {
  const resolvePhase3CF = (absorptionEndMs: number): number | undefined => {
    const mult = calculateSensitivityMultiplierAtTime(
      absorptionEndMs, activityContributions, peakSensitivityMultiplier, tauWMs,
    );
    return mult > 1.005 ? correctionFactor * mult : undefined;
  };
  const resolvePhase3C2B = (absorptionEndMs: number): number | undefined => {
    const mult = calculateSensitivityMultiplierAtTime(
      absorptionEndMs, activityContributions, peakSensitivityMultiplier, tauWMs,
    );
    return mult > 1.005 ? carbToBGFactor / mult : undefined;
  };
  return { resolvePhase3CF, resolvePhase3C2B };
}

/**
 * Calculate all chart series values at a single time point.
 *
 * Mirrors what calculateNetEffectAtTime() does on the web, but using
 * the mobile calculation stack with the v4.4 persist-at-100% fix.
 */
function buildChartPoint(
  targetTimestamp: number,
  processedMeals: any[],
  processedInsulin: any[],
  allMealsInWindow: any[],
  allDosesInWindow: any[],
  patientConstants: any,
  now: number,
  halfIntervalMs: number,
  viewConfig: any,
  activityContributions: ActivityContribution[],
  tauWMs: number,
  peakSensitivityMultiplier: number = 1.0,  // effectiveActivityPD.sensitivity_multiplier ?? 1.0
  phase3Resolvers?: ReturnType<typeof makePhase3Resolvers>,  // pre-built once per generateChartData run
): EffectsChartPoint {
  const targetTime = new Date(targetTimestamp);
  const isHistorical = targetTimestamp <= now;
  const isFuture     = targetTimestamp > now;
  const isNow        = Math.abs(targetTimestamp - now) < halfIntervalMs;

  const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
  const tzOffset:  number = patientConstants?.timezone_offset_minutes ?? 0;

  // ── Meal effect at this time ───────────────────────────────────────────────
  // calculateStackedMealEffect takes (meals, currentTime, constants)
  // Filter to meals that are active at targetTime (not future meals)
  const activeMealsAtTime = processedMeals.filter((meal: any) => {
    const mealMs = typeof meal.timestamp === 'number'
      ? meal.timestamp
      : parseUTCMs(meal.timestamp);
    if (isNaN(mealMs) || mealMs > targetTimestamp) return false;
    const hoursSince = (targetTimestamp - mealMs) / (1000 * 60 * 60);
    return hoursSince < getMealDurationHours(meal);
  });

  const mealResult = activeMealsAtTime.length > 0
    ? calculateStackedMealEffect(activeMealsAtTime, targetTime, patientConstants)
    : { totalBGElevation: 0, totalMOB: 0, totalPendingRise: 0 };

  const mealImpact = (mealResult as any)?.totalBGElevation ?? 0;  // base — unchanged

  // ── Insulin effect at this time ────────────────────────────────────────────
  const correctionFactor: number = patientConstants?.correction_factor ?? 40;

  // ── Sensitivity multiplier at this chart time point ───────────────────────
  // Uses calculateSensitivityMultiplierAtTime (W-state model, not live API scalar).
  // The API's sensitivity_multiplier is only authoritative AT NOW; historical and
  // future points must use the time-resolved function (Invariant #3).
  const sensitivityMultiplierAtTime = calculateSensitivityMultiplierAtTime(
    targetTimestamp,
    activityContributions,
    peakSensitivityMultiplier,
    tauWMs,
  );
  // Q3 confirmed: carb_to_bg_factor is not readonly — spread is type-safe.
  // effectiveCF (correctionFactor × multiplier) is intentionally NOT stored as a
  // variable — it must only be applied via the post-hoc multiply on insulinImpactBase
  // below, never passed into calculateStackedInsulinChartEffect (Fix 4).
  // Bug 5 fix: fallback was ?? 20 (5× the physiological upper bound of ~4 mg/dL/g).
  // Correct fallback is DEFAULT_CARB_TO_BG_FACTOR = 4.0, matching blood-glucose-estimation.ts.
  // The wrong default caused a 5× overstatement of the meal orange area and green
  // cumulative line whenever patientConstants was null during initial render.
  const effectiveC2B = (patientConstants?.carb_to_bg_factor ?? 4.0) / sensitivityMultiplierAtTime;

  // Adjusted meal impact: same carbs, lower BG rise because sensitivity is elevated.
  // Path A (Q3 confirmed viable): pass overridden constants so the full PK curve
  // is scaled by the effective C2B, not just the final number.
  const activityAdjustedMealImpact: number = sensitivityMultiplierAtTime > 1.005
    ? (calculateStackedMealEffect(
        activeMealsAtTime,
        targetTime,
        { ...patientConstants, carb_to_bg_factor: effectiveC2B }
      ) as any)?.totalBGElevation ?? 0
    : mealImpact;

  const dosesForStackingAtTime: InsulinDoseForStacking[] = processedInsulin
    .map((dose: any) => doseToStacking(dose, targetTime))
    .filter((d): d is InsulinDoseForStacking => d !== null);

  // ── S-CURVE FIX ────────────────────────────────────────────────────────────
  // Base (unscaled CF) — renders as the purple area.
  // calculateStackedInsulinChartEffect uses (dose − IOB) × ISF per dose,
  // producing a monotonically-growing S-curve that matches the web version's
  // purple area.  calculateStackedInsulinEffect (activity-rate bell curve)
  // is kept below for IOB / stacking-risk tooltip display only.
  // See pharmacodynamics.ts "S-CURVE CHART API" section for full rationale.
  //
  // SINGLE-MULTIPLY CONTRACT (Fix 4):
  //   insulinImpactBase  = base ISF (correctionFactor, NOT effectiveCF)
  //   insulinImpactBoosted = insulinImpactBase × sensitivityMultiplier  (post-hoc)
  //   Do NOT also pass effectiveCF into calculateStackedInsulinChartEffect —
  //   that would square the multiplier. effectiveCF is intentionally not
  //   computed here to remove the temptation.
  const baseChartInsulinResult = dosesForStackingAtTime.length > 0
    ? calculateStackedInsulinChartEffect(dosesForStackingAtTime, correctionFactor)
    : { totalBGImpact: 0, totalIOB: 0 };

  const insulinImpactBase = baseChartInsulinResult.totalBGImpact;   // ≤ 0

  // Boosted total — same absorbed units, larger BG reduction at elevated ISF.
  // Do NOT pass effectiveCF into calculateStackedInsulinChartEffect and also
  // multiply here — pick one. Multiply post-hoc to stay consistent with how
  // ActiveEffectsDisplay derives its boosted IOB display.
  const insulinImpactBoosted    = insulinImpactBase * sensitivityMultiplierAtTime;  // ≤ 0
  const insulinSensitivityBoost = insulinImpactBoosted - insulinImpactBase;          // ≤ 0

  // insulinImpact = boosted total (backwards-compatible: all existing consumers correct)
  const insulinImpact = insulinImpactBoosted;

  // Phase-3-persist display version — avoids the snap-to-0 "peak" when doses expire.
  // `persistExpired=true` keeps expired doses at -(dose × CF) so the purple area
  // holds its depth instead of jumping upward at expiry time.
  //
  // DAILY RESET GUARD: only include doses administered after the last daily reset.
  // Doses from a previous daily period have already been folded into
  // cumulativeNetBaseline and must NOT persist into the display area beyond the
  // reset boundary — otherwise the purple area stays flat all day even when there
  // is no insulin on board.
  //
  // hoursToLastReset = how many hours ago the daily reset occurred at targetTime.
  // Any dose with hoursSinceDose > hoursToLastReset was administered before the
  // reset and should be excluded from the display area for this day.
  //
  // WHY keep insulinImpactBase (snap) for netEffect:
  //   netEffect is the instantaneous BG-change RATE.  An expired dose's rate IS 0 —
  //   its action has already been delivered to the actual blood glucose level.
  //   insulinImpactBoosted (snap-to-0) is correct there.
  //
  // WHY use insulinImpactBaseDisplay for the purple area:
  //   The area represents accumulated delivered effect. Once -(dose×CF) is
  //   delivered it cannot un-deliver itself — persisting at that level matches
  //   the physiological model and the meal orange area's Phase-3 behavior.
  const displayResetMs = getLastResetTimeMs(targetTime, resetHour, tzOffset);
  const hoursToLastReset = (targetTimestamp - displayResetMs) / 3_600_000;
  const dosesInCurrentDayForDisplay = dosesForStackingAtTime.filter(
    (d: InsulinDoseForStacking) => d.hoursSinceDose <= hoursToLastReset
  );

  const displayChartInsulinResult = dosesInCurrentDayForDisplay.length > 0
    ? calculateStackedInsulinChartEffect(dosesInCurrentDayForDisplay, correctionFactor, true)
    : { totalBGImpact: 0 };

  // expiredContrib ≤ 0: extra depth from Phase-3-persisted expired doses.
  const expiredInsulinContrib = displayChartInsulinResult.totalBGImpact - insulinImpactBase;
  const insulinImpactBaseDisplay = insulinImpactBase + expiredInsulinContrib;
  // insulinImpactBoostedDisplay = active portion boosted + expired at base CF
  const insulinImpactBoostedDisplay = insulinImpactBoosted + expiredInsulinContrib;

  // Keep stacking result available for IOB display / tooltip (not used for chart area)
  const insulinResult = dosesForStackingAtTime.length > 0
    ? calculateStackedInsulinEffect(dosesForStackingAtTime, correctionFactor)
    : { totalIOB: 0, totalBGImpact: 0 };

  // Activity effect — TWO separate values for two distinct purposes.
  // resetTimeMs is shared by both and reused below for cumulativeNetBaseline.
  const resetTimeMs = getLastResetTimeMs(targetTime, resetHour, tzOffset);

  // ── Rate value (Z-state, τ_Z = 10 min): for netEffect ONLY ──────────────────
  // Correct for the blue dashed "current rate" line: after ~40 min post-exercise
  // the acute BG-lowering signal has delivered its drop and the rate IS ~0.
  // Do NOT use this for the area display — it collapses to ~0 far too quickly.
  const activityEffectAtPoint = calculateActivityEffectAtTime(
    targetTimestamp, activityContributions, tauWMs, resetTimeMs,
  );

  // ── Display value (W-state decay): for the blue activity AREA ───────────────
  // Uses a W-state plateau + exponential decay model so the blue shaded area:
  //   • Ramps linearly 0 → fullEffect DURING the session
  //   • Holds flat for τ_W (90 min) after session end (post-exercise plateau)
  //   • Decays exponentially to ~0 after ~3 × τ_W (≈ 4.5 h post-session)
  //
  // This prevents the area from extending flat forever to the right edge of
  // the chart. The green cumulative line (cumulativeNetBaseline) still uses
  // calculateActivityEffectForCumulative (true lock-in) because the BG drop
  // from exercise genuinely persists until the patient eats — that physiology
  // is correct for the bank-balance line. The blue area is a VISUAL indicator
  // of the active exercise effect window, so W-state decay is appropriate here.
  //
  // resetTimeMs is per-point (getLastResetTimeMs uses targetTime, not Date.now()),
  // so multi-day views correctly scope each point to its own daily window. ✓
  const activityEffectForDisplay = (() => {
    let total = 0;
    for (const c of activityContributions) {
      const startMs = parseUTCMs(c.start_time);
      if (isNaN(startMs) || targetTimestamp < startMs) continue;
      if (startMs < resetTimeMs) continue; // daily reset guard
      const durationMs = (c.duration_minutes ?? 30) * 60_000;
      const endMs      = startMs + durationMs;
      const fullEffect = c.cumulative_bg_effect ?? 0;
      if (targetTimestamp <= endMs) {
        // During session: linear ramp 0 → fullEffect
        const frac = (targetTimestamp - startMs) / Math.max(durationMs, 1);
        total += frac * fullEffect;
      } else {
        const postMs = targetTimestamp - endMs;
        if (postMs <= tauWMs) {
          // Post-exercise plateau (τ_W): hold at fullEffect
          total += fullEffect;
        } else {
          // After plateau: exponential decay with τ_W time constant
          total += fullEffect * Math.exp(-(postMs - tauWMs) / tauWMs);
        }
      }
    }
    return total;
  })();

  // Fix 1: include activityEffectAtPoint (pre-signed per spec §7 — ADD, never subtract).
  // Fix 3: use activityAdjustedMealImpact (CR scaled by sensitivityMultiplier);
  //   equals mealImpact when sensitivityMultiplier === 1.0, so no-op without exercise.
  // Uses Z-state (activityEffectAtPoint) — correct for the instantaneous rate line.
  const netEffect = activityAdjustedMealImpact + insulinImpact + activityEffectAtPoint;

  // ── Cumulative baseline at this time (the "bank balance") ─────────────────
  // Use allMealsInWindow + allDosesInWindow so fully-absorbed events persist.
  // This is the v4.4 fix from cumulative-effects.ts.
  const allMealsUpToNow = allMealsInWindow.filter((meal: any) => {
    const mealMs = parseUTCMs(meal?.timestamp);
    return !isNaN(mealMs) && mealMs <= targetTimestamp;
  });
  const allDosesUpToNow = allDosesInWindow.filter((dose: any) => {
    const doseMs = parseUTCMs(dose?.administrationTime);
    return !isNaN(doseMs) && doseMs <= targetTimestamp;
  });

  // Effective CF for cumulative insulin: during post-exercise sensitivity window,
  // insulin lowers BG more aggressively (CF × sensitivityMultiplier). Passing this
  // as effectiveCF makes the green bank-balance line reflect real augmented insulin
  // action.
  //
  // ── v4.7 FIX: INDIRECT EFFECT LOCK-IN BUG ────────────────────────────────────
  //
  // BUG (green line rises after meal ends, with no new insulin):
  //   The previous code unconditionally computed `correctionFactor × sensitivityMultiplierAtTime`.
  //   Because sensitivityMultiplierAtTime decays continuously post-exercise (exponential
  //   W-state decay after τ_W), the Phase 1/2 insulin contribution shrank at every
  //   chart point as the multiplier decayed — making the bank-balance net (meals + insulin)
  //   RISE as insulin became less negative. This is visible as the green cumulative line
  //   drifting upward after meal absorption ends, with no new food or insulin to explain it.
  //
  //   This is the Phase 1/2 analogue of the v4.5 Phase 3 insulin bug: a time-varying
  //   multiplier retroactively alters the contribution of a dose that has already (or
  //   is currently) absorbing — producing a phantom line movement.
  //
  // FIX: Mirror the `> 1.005` guard that `effectiveC2BForCumulative` already uses.
  //   - When sensitivityMultiplierAtTime > 1.005: apply the boost (exercise window active)
  //   - When sensitivityMultiplierAtTime ≤ 1.005: pass `undefined` → base CF used
  //     (no override path in calculateInsulinCumulativeEffect, Phase 3 guard irrelevant)
  //
  // This means the indirect insulin deepening only applies while the sensitivity
  // window is genuinely active, and never during or after its decay — matching the
  // physiological model: once the W-state has returned to baseline the boosted action
  // has already been delivered and its BG-lowering impact is baked into the bank balance.
  const effectiveCFForCumulative: number | undefined =
    sensitivityMultiplierAtTime > 1.005
      ? correctionFactor * sensitivityMultiplierAtTime
      : undefined;

  // ── v4.6 FIX: Effective C2B for cumulative meal effect (Phase 1 & 2 ONLY) ──
  //
  // During active absorption (Phase 1/2) inside the post-exercise sensitivity
  // window, carbs genuinely raise BG less (insulin is more effective), so
  // effectiveC2B = carb_to_bg_factor / sensitivityMultiplier is physiologically
  // correct for those phases.
  //
  // Phase 3 meals (fully absorbed, persist-at-100%) must NOT use the override.
  // Their BG-raising action already happened at the base rate and cannot be
  // retroactively scaled down by a later exercise session.  Applying the override
  // to Phase 3 caused the bank-balance line to plunge during the sensitivity
  // window even when there were no active meals — an exact parallel of the
  // v4.5 bug for Phase 3 insulin.
  //
  // FIX: No longer injected into patientConstantsForCumulative (removed).
  // Instead passed as the dedicated `overrideCarbToBGFactor` argument to
  // calculateTotalCumulativeEffects → calculateMealCumulativeEffect, where
  // Phase 3 explicitly ignores it and reads the base value directly.
  const effectiveC2BForCumulative =
    sensitivityMultiplierAtTime > 1.005
      ? (patientConstants?.carb_to_bg_factor ?? 4.0) / sensitivityMultiplierAtTime
      : undefined;

  // ── v4.13 FIX: Frozen Phase 3 clamp resolvers ─────────────────────────────
  //
  // ROOT CAUSE of the Phase 3 drift: the Phase 3 clamp in cumulative-effects.ts
  // is  Math.min(phase3, phase2Exit)  where
  //   phase2Exit (insulin) = -(dose × overrideCorrectionFactor)
  //   phase2Exit (meal)    =  carbs × overrideCarbToBGFactor
  //
  // When overrideCorrectionFactor / overrideCarbToBGFactor are derived from
  // sensitivityMultiplierAtTime(targetTimestamp), they decay at EVERY chart point
  // as the multiplier falls from 1.3 → 1.0.  That makes phase2Exit drift, so
  // the Phase 3 return value drifts too — the green line moves ~120 mg/dL with
  // no new food or insulin to justify it.
  //
  // FIX: evaluate the multiplier ONCE, at the moment the dose/meal finished
  // absorbing (absorptionEndMs = eventMs + durationMs), not at targetTimestamp.
  // That value is constant for a given event regardless of which chart point we
  // are rendering → Phase 3 is truly flat after absorption completes.
  //
  // If `phase3Resolvers` was provided by generateChartData (the common path),
  // reuse those pre-built closures — zero extra allocations per tick.
  // Fall back to makePhase3Resolvers inline only when buildChartPoint is called
  // outside generateChartData (e.g. tests, one-off snapshots).
  const { resolvePhase3CF, resolvePhase3C2B } = phase3Resolvers ?? makePhase3Resolvers(
    activityContributions,
    peakSensitivityMultiplier,
    tauWMs,
    correctionFactor,
    patientConstants?.carb_to_bg_factor ?? 4.0,
  );

  // patientConstantsForCumulative is now UNMODIFIED for the C2B side.
  // effectiveCFForCumulative (insulin) continues to be passed as a dedicated arg.
  // ✅ No longer spreads carb_to_bg_factor override here — that caused Phase 3 meals
  // to have their contribution reduced by 1/sensitivityMultiplier (v4.6 bug fix).
  const patientConstantsForCumulative = patientConstants;

  const cumulative = (allMealsUpToNow.length > 0 || allDosesUpToNow.length > 0)
    ? calculateTotalCumulativeEffects(
        allMealsUpToNow,
        allDosesUpToNow,
        targetTime,
        patientConstantsForCumulative,
        MEAL_ABSORPTION_PROFILES as any,
        resetHour,
        tzOffset,
        // Do NOT pass `activities` here — activity injected manually below
        // via calculateActivityEffectForCumulative (double-count guard, Fix 2).
        undefined,
        // Pass effective CF so cumulative insulin depth grows with sensitivity boost.
        effectiveCFForCumulative,
        // Pass effective C2B for Phase 1/2 meals only — Phase 3 ignores it (v4.6 fix).
        effectiveC2BForCumulative,
        // absorptionReferenceTime — not used here; targetTime IS the reference.
        undefined,
        // v4.13 FIX: frozen Phase 3 resolvers evaluated at absorption-end time.
        // Prevents phase2Exit from drifting as sensitivityMultiplier decays.
        resolvePhase3CF,
        resolvePhase3C2B,
      )
    : { cumulativeMealEffect: 0, cumulativeInsulinEffect: 0, cumulativeNetBaseline: 0 };

  // ── Dose markers ───────────────────────────────────────────────────────────
  const mealsAtTime   = findMealsAtTime(processedMeals, targetTimestamp, halfIntervalMs);
  const insulinAtTime = findInsulinAtTime(processedInsulin, targetTimestamp, halfIntervalMs);

  // carbEquiv is NOT set by processContextMealsForChart — it just spreads the
  // raw API meal object. Read total_carb_equiv from calculation_summary (backend
  // field), then fall back through the nutrition object variants, then raw carbs.
  const totalCarbsAtTime = mealsAtTime.reduce((s: number, m: any) => {
    const carbEquiv =
      m.calculation_summary?.total_carb_equiv ??
      m.nutrition?.total_carb_equiv           ??
      m.nutrition?.totalCarbEquiv             ??
      m.nutrition?.totalCarbs                 ??
      m.nutrition?.carbs                      ??
      0;
    return s + carbEquiv;
  }, 0);
  const totalInsulinAtTime = insulinAtTime.reduce((s: number, d: any) => s + (d.dose ?? d.units ?? 0), 0);


  return {
    timestamp: targetTimestamp,
    formattedTime: formatXAxis(
      targetTimestamp,
      viewConfig?.tickFormat === 'HH:mm' ? 'HH:mm' : 'MM/DD HH:mm'
    ),

    mealImpact,
    insulinImpact,
    netEffect,

    cumulativeMealEffect:    (cumulative as any).cumulativeMealEffect    ?? 0,
    cumulativeInsulinEffect: (cumulative as any).cumulativeInsulinEffect ?? 0,
    // ── Activity baked into the green "bank balance" line ─────────────────────
    // Uses calculateActivityEffectForCumulative() — lock-in (permanent) model.
    //
    // DOUBLE-COUNT GUARD (Fix 2): calculateTotalCumulativeEffects() above is called
    // WITHOUT the `activities` argument, so its returned cumulativeNetBaseline
    // contains only meals + insulin. The activity term is added HERE and ONLY HERE.
    // Never pass `activities` to calculateTotalCumulativeEffects in this function —
    // that would add it again inside the function, doubling the effect.
    //
    // Lock-in rationale: a BG drop from exercise does not reverse on its own —
    // it persists until the patient eats. The cumulative line locks at peak once
    // training ends and resets at the daily boundary (via resetTimeMs).
    //
    // The teal activityEffect field uses calculateActivityEffectAtTime() instead
    // (plateau + exponential decay) for the pharmacodynamic window display.
    //
    // ── v4.8 FIX: pass `now` (the chart's reference "now") as the 4th arg ──────
    // calculateActivityEffectForCumulative v4.8 added a `nowMs` parameter so that
    // historical chart points (targetTimestamp < now) use the back-scaled ramp:
    //
    //   effectAtTarget = cumulative_bg_effect × (fracAtTarget / fracAtNow)
    //
    // instead of the overcounting:
    //
    //   effectAtTarget = fracAtTarget × fullEffect
    //
    // Without this argument the function defaults to Date.now() at call time,
    // which drifts between map iterations and causes the lock-in plateau to be
    // set at the wrong (too-high) level for historical points inside an active
    // session — exactly the "green line rises after meal ends" symptom.
    //
    // `now` is the 7th parameter of buildChartPoint (= timeRange.now passed from
    // generateChartData) and is the correct authoritative reference timestamp.
    cumulativeNetBaseline: ((cumulative as any).cumulativeNetBaseline ?? 0) +
      calculateActivityEffectForCumulative(targetTimestamp, activityContributions, resetTimeMs, now),

    mealDoseMarker:    totalCarbsAtTime > 0   ? totalCarbsAtTime             : null,
    insulinDoseMarker: totalInsulinAtTime > 0 ? -(totalInsulinAtTime * 5)   : null,

    mealsAdministered:   mealsAtTime,
    insulinAdministered: insulinAtTime,

    isHistorical,
    isFuture,
    isNow,



    // Lock-in model: ramps during session, flat after — no post-exercise decline.
    // Matches the contribution baked into cumulativeNetBaseline (same function).
    // activityEffectAtPoint (Z-state) is used only in netEffect — not here.
    activityEffect: activityEffectForDisplay,

    // Lock-in activity effect — same calculateActivityEffectForCumulative used by
    // cumulativeNetBaseline. Used for the blue area so it tracks the green line.
    activityCumulativeEffect: calculateActivityEffectForCumulative(
      targetTimestamp, activityContributions, resetTimeMs, now,
    ),

    // NEW: activity sensitivity indirect effect fields
    insulinImpactBase,
    insulinSensitivityBoost,
    insulinImpactBaseDisplay,
    activityAdjustedMealImpact,
    sensitivityMultiplier: sensitivityMultiplierAtTime,
  };
}

// ACTIVE_EFFECTS_OPTIONS is now built inside the component via useMemo
// (keyed on pastHours) so the fetch window automatically matches the
// selected view. It is NOT a static constant any more — see the useMemo
// below.  A useMemo dep-keyed object is NOT recreated every render; it
// is stable for as long as viewConfig.pastHours stays the same, so the
// infinite-loop risk of an inline object literal is avoided.


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
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, interpolationInterval };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

const EffectsVisualizationChart: React.FC<EffectsVisualizationChartProps> = ({
  height        = CHART_HEIGHT,
  showControls  = true,
  embedded      = false,
  defaultView   = '12h',
  onDataUpdate,
  activityPD    = null,
}) => {
  // ── Patient constants ────────────────────────────────────────────────────────
  // hasLoadedFromAPI: false while the hook is still using DEFAULT_PATIENT_CONSTANTS
  // as a placeholder (Phase 1 cache hit or first-install fallback).  We must
  // gate generateChartData on this flag so the chart never renders with the
  // default CF=40 / carb=4 values — which would produce a visible line
  // discontinuity on every load when real constants arrive (CF=70, carb=10).
  const { constants: patientConstants, hasLoadedFromAPI: patientConstantsReady } = usePatientConstants();

  // ── View state ───────────────────────────────────────────────────────────────
  // Declared FIRST so it is available to the activeEffectsOptions useMemo below.
  // (Previously declared after that memo, causing a TDZ "Cannot access 'viewMode'
  // before initialization" crash.)
  const [viewMode, setViewMode]                       = useState(defaultView);

  // ── Custom date-range filter ──────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);


  // ── Active effects hook (single source for meals + doses) ────────────────────
  // windowHours is derived from the current view mode so the API fetch window
  // always covers the full chart range. useMemo ensures the options object is
  // only recreated when pastHours changes (i.e. the user switches view modes),
  // not on every render — preventing the useActiveEffects infinite-loop issue.
  //
  // BUG FIX: the previous ACTIVE_EFFECTS_OPTIONS static constant had no
  // windowHours, so useActiveEffects always fetched only 24h (32h with buffer).
  // For week/month views this meant rawMeals contained no historical meals,
  // allMealsUpToNow was always empty for historical chart points, and
  // cumulativeNetBaseline was 0 across the entire old portion of the chart.
  //
  // FIX (cumulative lookback): For short views (3H/6H/12H/24H) the visible
  // pastHours is smaller than the minimum fetch depth needed to cover the full
  // previous daily window.  We always fetch at least getCumulativeLookbackHours
  // hours so meals/doses from this morning (before the chart's left edge) are
  // present in rawMeals and rawDoses — the per-point daily-reset filter inside
  // calculateTotalCumulativeEffects then sees the full day's data.
  const activeEffectsOptions = useMemo(() => {
    const resetHour: number =
      patientConstants?.daily_reset_hour ??
      DEFAULT_PATIENT_CONSTANTS.daily_reset_hour;

    // For custom mode derive pastHours from the selected start date; otherwise
    // use the VIEW_CONFIGS entry as before.
    const displayPastHours = viewMode === 'custom'
      ? Math.max(1, (Date.now() - customRangeStart.getTime()) / 3_600_000)
      : ((VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h']).pastHours ?? 24);

    // Always fetch enough history to cover the previous daily window,
    // regardless of how short the visible range is.
    const fetchHours = Math.max(displayPastHours, getCumulativeLookbackHours(resetHour));

    return { autoRefresh: true, refreshInterval: 60_000, debug: false, windowHours: fetchHours, skipIobCutoff: true };
  }, [viewMode, customRangeStart, patientConstants]);   // customRangeStart only matters when viewMode === 'custom'

  const {
    meals: rawMeals,
    insulinDoses: rawDoses,
    stableBaseline,
    baselineMode,
    isLoading: effectsLoading,
    refresh,
    activityPDResult: hookActivityPD,
    estimatedBG: hookEstimatedBG,   // reading-anchored (includes residual in preset mode)
    activityHistory: rawActivityHistory,
  } = useActiveEffects(activeEffectsOptions);

  // ── Stable callback ref for onDataUpdate ─────────────────────────────────────
  // Storing the prop in a ref means generateChartData doesn't need it in its
  // dependency array, preventing a new callback reference on every render.
  const onDataUpdateRef = useRef(onDataUpdate);
  useEffect(() => { onDataUpdateRef.current = onDataUpdate; }, [onDataUpdate]);
  const [chartData, setChartData]                     = useState<EffectsChartPoint[]>([]);
  const [generating, setGenerating]                   = useState(false);
  const [error, setError]                             = useState<string | null>(null);

  // ── Series toggles ───────────────────────────────────────────────────────────
  const [showMealEffect,        setShowMealEffect]        = useState(true);
  const [showInsulinEffect,     setShowInsulinEffect]      = useState(true);
  const [showNetEffect,         setShowNetEffect]          = useState(false);
  const [showCumulativeBaseline, setShowCumulativeBaseline] = useState(true);
  const [showDoseMarkers,       setShowDoseMarkers]        = useState(true);
  /** Spec §2a/2b/2c — activity line + AOB shading + legend */
  const [showActivityEffect,    setShowActivityEffect]     = useState(true);
  /** Spec §2d — vertical tick marks at session start times */
  const [showActivityMarkers,   setShowActivityMarkers]    = useState(true);

  // ── Tooltip state ────────────────────────────────────────────────────────────
  const [tooltipData, setTooltipData] = useState<TooltipData | null>(null);

  // ── About this Chart accordion ───────────────────────────────────────────────
  const [aboutExpanded, setAboutExpanded] = useState(false);

  // ── Shared time hooks (from ChartUtils) ──────────────────────────────────────
  const currentMinute  = useCurrentMinute();
  // Always call hook unconditionally; override result when custom mode is active.
  const _hookTimeRange = useChartTimeRange(viewMode === 'custom' ? '24h' : viewMode, currentMinute);

  const timeRange: TimeRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied) {
      return { start: customRangeStart.getTime(), end: customRangeEnd.getTime(), now: Date.now() };
    }
    // Extend the default future window for the 12h view from 2 h → 6 h so the
    // user can see the full projected effect curve for the next 6 hours.
    if (viewMode === '12h') {
      const nowMs = Date.now();
      return { ..._hookTimeRange, end: nowMs + 6 * 60 * 60 * 1_000 };
    }
    return _hookTimeRange;
  }, [viewMode, customApplied, customRangeStart, customRangeEnd, _hookTimeRange]);

  const viewConfig = useMemo(() => {
    if (viewMode === 'custom') return getCustomViewConfig(customRangeStart, customRangeEnd);
    const cfg = VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h'];
    // Keep futureHours in sync with the extended 6h future window above so that
    // generateXAxisTicks produces ticks across the full future range.
    if (viewMode === '12h') return { ...cfg, futureHours: 6 };
    return cfg;
  }, [viewMode, customRangeStart, customRangeEnd]);

  // ── Timeout escape hatch ─────────────────────────────────────────────────────
  // useActiveEffects.isLoading can stay true indefinitely if the API returns
  // empty data and calculateEffects() never fires (it is gated on data presence).
  // After LOAD_TIMEOUT_MS we force-clear our spinner regardless, showing the
  // empty-state UI so the screen is never stuck on a loader forever.
  const LOAD_TIMEOUT_MS = 8_000;
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!effectsLoading) return; // already resolved — no timer needed
    const id = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [effectsLoading]);

  // ── Processed meals / insulin (time-range filtered) ──────────────────────────
  // Use primitive start/end as deps (not the timeRange object) to avoid
  // triggering new memos when the hook returns a structurally-identical object.
  const { start: rangeStart, end: rangeEnd } = timeRange;

  // ── Cumulative window start (shared lower bound) ──────────────────────────────
  //
  // BUG: processedMeals and processedInsulin were filtered from rangeStart (the
  // chart's visible left edge). When the user switched to a short view (3H/6H/12H),
  // rangeStart moved forward, cutting off meals/doses that were eaten after the
  // daily reset but before the visible window. Their PK tails (orange meal area,
  // purple insulin area) therefore disappeared at the window edge even though:
  //   (a) the green cumulative line already saw them via allMealsInWindow, and
  //   (b) calculateStackedMealEffect / calculateStackedInsulinChartEffect would
  //       correctly produce non-zero values if given those meals.
  //
  // FIX: both processedMeals and processedInsulin now extend back to
  // cumulativeWindowStartMs (= the daily reset before rangeStart), matching the
  // lower bound already used by allMealsInWindow. Dose markers are unaffected —
  // chart time points start at rangeStart, so findMealsAtTime / findInsulinAtTime
  // never match a pre-window timestamp anyway.
  //
  //   Short views (3H/6H/12H/24H):  cumulativeWindowStartMs = today's reset (7am)
  //   Multi-day views (3D/Week):     cumulativeWindowStartMs = rangeStart
  //   Both: each chart point's own daily window is still enforced INSIDE
  //         calculateTotalCumulativeEffects → _getLastResetTime.
  const cumulativeWindowStartMs = useMemo(() => {
    const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
    const tzOffset: number  = (patientConstants as any)?.timezone_offset_minutes ?? 0;
    const earliestResetMs   = getLastResetTimeMs(
      new Date(Math.min(rangeStart, Date.now())), resetHour, tzOffset,
    );
    return Math.min(rangeStart, earliestResetMs);
  }, [patientConstants, rangeStart]);

  const processedMeals = useMemo(
    () => processContextMealsForChart(
      rawMeals.map(normaliseMeal), // ✅ FIX: resolve timestamp aliases + calculation_summary
      // FIX (pre-window rate effects): extend start to cumulativeWindowStartMs so
      // meals eaten before the chart window but after the daily reset contribute
      // their PK tail to the orange meal area. Green cumulative line was already
      // correct; this makes the orange area consistent with it.
      { start: cumulativeWindowStartMs, end: rangeEnd, now: Date.now() },
      patientConstants ?? undefined, // ✅ FIX: pass constants so protein/fat factors are patient-specific
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawMeals, cumulativeWindowStartMs, rangeEnd, patientConstants]
  );

  // ✅ FIX (insulin dose markers): Pre-normalise raw API doses before passing to
  // processContextInsulinForChart. Raw doses from useActiveEffects have their
  // timestamp in 'taken_at' (not 'administrationTime'), so the mobile ChartUtils
  // filter was discarding every dose as "outside time range" → insulinDoseData
  // was always empty → no purple bars rendered.
  //
  // normaliseDose() maps taken_at → administrationTime (string/number), which is
  // the field processContextInsulinForChart and findInsulinAtTime both expect.
  const processedInsulin = useMemo(
    () => processContextInsulinForChart(
      rawDoses.map(normaliseDose),
      // FIX (pre-window rate effects): same extension as processedMeals — include
      // doses given before the chart window but after the daily reset so their
      // PK tail (purple insulin area) is visible at the window start.
      { start: cumulativeWindowStartMs, end: rangeEnd, now: Date.now() },
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawDoses, cumulativeWindowStartMs, rangeEnd]
  );

  // ── All-window arrays for correct cumulative baseline ────────────────────────
  // We need these separately: allMealsInWindow keeps fully-absorbed meals so the
  // persist-at-100% fix in calculateTotalCumulativeEffects is applied correctly.
  //
  // Both arrays use cumulativeWindowStartMs (shared memo above) as their lower
  // bound — the daily-reset boundary before the chart's visible range start.
  // This is the same bound now used by processedMeals and processedInsulin,
  // making all three arrays consistent. The per-point daily window is re-enforced
  // inside calculateTotalCumulativeEffects → _getLastResetTime(targetTime, ...)
  // so each chart point only accumulates meals/doses from its own daily period.
  const { allMealsInWindow, allDosesInWindow } = useMemo(() => {
    if (!patientConstants) return { allMealsInWindow: [], allDosesInWindow: [] };

    const now = Date.now();

    // cumulativeWindowStartMs (computed above) is the daily-reset-aware lower
    // bound shared by processedMeals, processedInsulin, and these arrays.
    // The per-point daily window is re-enforced inside calculateTotalCumulativeEffects
    // → _getLastResetTime(targetTime, ...) so each chart point only counts
    // meals/doses from its own daily window.

    const mealsInWindow = rawMeals
      .map(normaliseMeal)
      .filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        // ✅ FIX: use rangeEnd (not `now`) as the upper bound so that
        // future-snapped meals (timestamp = insulinTime + offset) are included.
        // Without this, a pre-meal snap produces a future timestamp that is
        // silently dropped here → calculateTotalCumulativeEffects never sees it
        // → cumulativeNetBaseline stays flat (green line shows no meal effect)
        // even though the orange meal-area renders correctly via processedMeals.
        //
        // calculateAbsorbedFraction(hoursSince <= 0) = 0, so future meals
        // contribute nothing to points before their own timestamp, and the
        // correct cumulative value for points at or after their timestamp.
        return !isNaN(mealMs) && mealMs >= cumulativeWindowStartMs && mealMs <= rangeEnd;
      });

    const dosesInWindow = rawDoses
      .map(normaliseDose)
      .filter((dose: any) => {
        const doseMs = parseUTCMs(dose?.administrationTime);
        return !isNaN(doseMs) && doseMs >= cumulativeWindowStartMs && doseMs <= now;
      });

    return { allMealsInWindow: mealsInWindow, allDosesInWindow: dosesInWindow };
  }, [rawMeals, rawDoses, patientConstants, cumulativeWindowStartMs, rangeEnd]);

  // ── Activity PD derived data (spec §2a–2e) ────────────────────────────────────
  //
  // Spec §2f data source: activityPD is accepted as a prop (not fetched internally).
  // See EffectsVisualizationChartProps.activityPD JSDoc for rationale.
  //
  // SELF-SUFFICIENT FALLBACK: when the prop is absent (the common case where the
  // parent screen doesn't explicitly pass activityPD), use the activityPDResult
  // already fetched by the internal useActiveEffects call above. This means the
  // chart works correctly with zero parent-side wiring.
  const effectiveActivityPD = activityPD ?? hookActivityPD ?? null;

  /** Per-session contributions — empty array when activityPD is null (graceful degrade) */
  const activityContributions: ActivityContribution[] = useMemo(
    () => effectiveActivityPD?.activity_contributions ?? [],
    [effectiveActivityPD]
  );

  /**
   * Synthetic ActivityContribution objects built from raw activity history records
   * for sessions that fall BEFORE today's daily reset window.
   *
   * These fill the gap for multi-day chart views (3D / 7D) where today's
   * activityPD.activity_contributions only covers the current reset→now window.
   * Sessions in prior daily windows would otherwise produce activityEffect = 0
   * at every historical chart point.
   *
   * Uses the same synthetic_hr approximation as the backend's categorical fallback.
   * ODE-accurate results (model: 'hr_ode') from today's activityPD are always
   * preferred — synthetic contributions are filtered to exclude any session that
   * already appears in today's activityContributions (matched by activity_id).
   */
  const syntheticContributions = useMemo<ActivityContribution[]>(() => {
    if (!rawActivityHistory?.length || !patientConstants) return [];

    // IDs already covered by today's ODE activityPD — exclude to avoid
    // double-counting. These have accurate backend ODE results, so we keep
    // them in activityContributions and skip them here.
    const todayOdeIds = new Set(activityContributions.map(c => c.activity_id));

    return rawActivityHistory
      .map(rec => historyRecordToContribution(rec, patientConstants))
      .filter((c): c is ActivityContribution => {
        if (!c) return false;
        const startMs = parseUTCMs(c.start_time);
        if (isNaN(startMs)) return false;
        // Skip if already covered by the ODE result (no double-counting).
        if (todayOdeIds.has(c.activity_id)) return false;

        // ── Effect-overlap filter ────────────────────────────────────────────
        // FIX: was `if (startMs < timeRange.start) return false` — this
        // incorrectly dropped sessions that started before the chart's visible
        // left edge but still have a bank-balance contribution or rate/sensitivity
        // tail visible in the chart range.
        //
        // Example: a run starting at 06:45 when the chart starts at the 07:00
        // reset. The session started after yesterday's reset so its lock-in
        // effect is part of today's bank balance from 07:00 onward — but the
        // old guard dropped it entirely, leaving the green line flat.
        //
        // Correct test: include the session if its effect window OVERLAPS
        // the chart's data range [cumulativeWindowStartMs, timeRange.end].
        //   • sessionEndMs < cumulativeWindowStartMs → effect entirely before the
        //     chart range; safe to drop.
        //   • startMs > timeRange.end → session entirely in the future; drop.
        //
        // The daily reset boundary is NOT re-enforced here — that is the job of
        // calculateActivityEffectForCumulative and calculateActivityEffectAtTime
        // (both have `if (startMs < resetTimeMs) continue`).  Duplicating it
        // here with a narrower window was the original mistake.
        const sessionEndMs = startMs + (c.duration_minutes ?? 30) * 60_000;
        if (sessionEndMs < cumulativeWindowStartMs) return false;
        if (startMs > timeRange.end) return false;

        return true;
      });
  }, [rawActivityHistory, patientConstants, timeRange.end, cumulativeWindowStartMs, activityContributions]);

  /**
   * Merged contributions: ODE-accurate results for today + synthetic for historical days.
   * Today's activity_id values take priority — any duplicate is dropped from synthetic.
   */
  const mergedActivityContributions = useMemo<ActivityContribution[]>(() => {
    if (!syntheticContributions.length) return activityContributions;
    const todayIds = new Set(activityContributions.map(c => c.activity_id));
    const historicalOnly = syntheticContributions.filter(c => !todayIds.has(c.activity_id));
    return [...activityContributions, ...historicalOnly];
  }, [activityContributions, syntheticContributions]);

  /**
   * Spec §1d / §2c visibility condition:
   * Show activity overlay only when there is a real effect to display.
   * Threshold 1.005 suppresses floating-point noise (H-1 fix).
   */
  const hasActivityEffect = useMemo(
    () =>
      Math.abs(effectiveActivityPD?.cumulative_activity_effect ?? 0) > 0.01 ||
      (effectiveActivityPD?.activity_on_board ?? 0) > 0 ||
      (effectiveActivityPD?.sensitivity_multiplier ?? 1.0) > 1.005 ||
      syntheticContributions.length > 0,          // historical sessions exist
    [effectiveActivityPD, syntheticContributions]
  );

  /**
   * Per-session duration bands — one entry per activity contribution.
   * Each band spans ONLY the actual training period:
   *   start_time → start_time + duration_minutes
   *
   * The post-exercise sensitivity window (τ_W = 90 min) is shown separately
   * via sensitivityWindowAreas (the amber strip near the x-axis), so the grey
   * session band does NOT extend into it. This prevents the light-blue shaded
   * area from appearing to stretch indefinitely beyond the actual activity.
   */
  const sessionDurationAreas = useMemo<Array<{ startMs: number; endMs: number; isActive: boolean }>>(() => {
    if (!hasActivityEffect) return [];
    return mergedActivityContributions
      .map(c => {
        const startMs = parseUTCMs(c.start_time);
        if (isNaN(startMs)) return null;
        return {
          startMs,
          // End exactly when the activity ends — no τ_W extension.
          // The sensitivity window strip (sensitivityWindowAreas) handles
          // the post-exercise period separately.
          endMs:    startMs + (c.duration_minutes ?? 30) * 60_000,
          isActive: c.is_active,
        };
      })
      .filter((x): x is { startMs: number; endMs: number; isActive: boolean } => x !== null);
  }, [mergedActivityContributions, hasActivityEffect]);

  /**
   * Spec §2d — Session start markers with intensity label (L / M / V).
   */
  const sessionMarkers = useMemo(
    () =>
      mergedActivityContributions
        .map(c => ({
          startMs:   parseUTCMs(c.start_time),
          intensity: c.intensity as string,
          label:     c.intensity === 'vigorous' ? 'V' : c.intensity === 'moderate' ? 'M' : 'L',
          isActive:  c.is_active,
        }))
        .filter(m => !isNaN(m.startMs)),
    [mergedActivityContributions]
  );

  // ── Chart generation ──────────────────────────────────────────────────────────
  const generateChartData = useCallback(() => {
    // FIX (Goal 5 / audit): patient.store always populates `constants` immediately
    // (either from cache or DEFAULT_PATIENT_CONSTANTS), so `!patientConstants` is
    // always false and was never actually guarding against default values.
    // Gate on `patientConstantsReady` instead — it is false until at least one
    // successful API fetch has completed in this JS session, preventing the chart
    // from rendering with CF=40/carb=4 and then jumping to real values.
    if (!patientConstants || !patientConstantsReady) return;

    // ── STABLE EARLY-EXIT: Don't loop on empty data ──────────────────────────
    // If there are no meals or insulin at all, show empty state immediately
    // rather than spinning.  This is the primary guard against the render loop
    // when the API returns empty arrays.
    if (processedMeals.length === 0 && processedInsulin.length === 0) {
      setChartData([]);
      setGenerating(false);
      return;
    }

    setGenerating(true);
    setError(null);

    try {
      const { start, end, now } = timeRange;
      const intervalMs = (viewConfig.interpolationInterval ?? 10) * 60 * 1_000;
      const halfInterval = intervalMs / 2;

      // Build time-point array
      const timePoints: number[] = [];
      for (let t = start; t <= end; t += intervalMs) {
        // Round to minute boundary
        const normalised = Math.round(t / 60_000) * 60_000;
        if (timePoints.length === 0 || timePoints[timePoints.length - 1] !== normalised) {
          timePoints.push(normalised);
        }
      }

      // Declare once before the map — valid for all chart points in this render.
      // effectiveActivityPD (line 971) is already in scope via closure.
      // Q7 confirmed: sensitivityMultiplier is the top-level scalar from the API.
      const peakSensitivityMultiplier: number =
        effectiveActivityPD?.sensitivity_multiplier ?? 1.0;

      // Build Phase 3 resolvers ONCE — stable deps across the entire map() loop.
      // Avoids creating two new closure objects per chart tick (~144× for 24 h view).
      const phase3Resolvers = makePhase3Resolvers(
        mergedActivityContributions,
        peakSensitivityMultiplier,
        TAU_W_MS,
        patientConstants.correction_factor   ?? 40,
        (patientConstants as any).carb_to_bg_factor ?? 4.0,
      );

      const points: EffectsChartPoint[] = timePoints.map((ts) =>
        buildChartPoint(
          ts,
          processedMeals,
          processedInsulin,
          allMealsInWindow,
          allDosesInWindow,
          patientConstants,
          now ?? Date.now(),
          halfInterval,
          viewConfig,
          mergedActivityContributions,
          TAU_W_MS,
          peakSensitivityMultiplier,
          phase3Resolvers,   // pre-built — no per-tick allocation
        )
      );

      // ── Cumulative insulin floor (v4.14 — delegates to applyInsulinCumulativeFloor) ─
      // The floor logic now lives in cumulative-effects.ts so EVC, BloodGlucoseVisualization,
      // and any future time-series chart can all import and call the same implementation.
      // See cumulative-effects.ts v4.14 JSDoc for the full root-cause explanation.
      applyInsulinCumulativeFloor(points);

      setChartData(points);
      // Use the ref so onDataUpdate is NOT in the dependency array.
      // Adding it as a dep would cause a new callback on every render if
      // the parent passes an inline function, restarting the loop.
      onDataUpdateRef.current?.(points);
    } catch (err) {
      console.error('[EffectsVisualizationChart] generateChartData error:', err);
      setError('Failed to generate chart data');
    } finally {
      setGenerating(false);
    }
  }, [
    patientConstants,
    patientConstantsReady,   // FIX: re-run when real constants arrive from API
    processedMeals,
    processedInsulin,
    allMealsInWindow,
    allDosesInWindow,
    timeRange,
    viewConfig,
    mergedActivityContributions,
    effectiveActivityPD,   // NEW — drives peakSensitivityMultiplier
    // onDataUpdate intentionally omitted — accessed via onDataUpdateRef
  ]);

  // Regenerate when inputs change (debounced by 200ms to batch rapid updates)
  useEffect(() => {
    const id = setTimeout(generateChartData, 200);
    return () => clearTimeout(id);
  }, [generateChartData]);

  // ── Derived chart config ──────────────────────────────────────────────────────
  const effectsDomain = useMemo(
    () => calculateEffectsAxisDomain(chartData, { includeCumulative: true }),
    [chartData]
  );

  const doseDomain = useMemo(
    () => calculateDoseAxisDomain(chartData),
    [chartData]
  );

  const xTicks = useMemo(
    () => generateXAxisTicks(timeRange, viewConfig),
    [timeRange, viewConfig]
  );

  // ── Victory data formatters ───────────────────────────────────────────────────
  // Victory requires data as { x, y } arrays
  const toXY = (key: keyof EffectsChartPoint) =>
    chartData.map((p) => ({
      x: p.timestamp,
      y: (p[key] as number) ?? 0,
    }));

  const mealEffectData       = useMemo(() => toXY('mealImpact'),            [chartData]);
  const insulinEffectData    = useMemo(() => toXY('insulinImpact'),         [chartData]);
  const netEffectData        = useMemo(() => toXY('netEffect'),             [chartData]);
  const cumulativeData       = useMemo(() => toXY('cumulativeNetBaseline'), [chartData]);
  const mealDoseData         = useMemo(
    () => chartData.filter(p => p.mealDoseMarker !== null).map(p => ({ x: p.timestamp, y: p.mealDoseMarker! })),
    [chartData]
  );
  const insulinDoseData      = useMemo(
    () => chartData.filter(p => p.insulinDoseMarker !== null).map(p => ({ x: p.timestamp, y: p.insulinDoseMarker! })),
    [chartData]
  );

  // ── Activity effect series data (spec §2a / §2b) ──────────────────────────────
  // Uses activityCumulativeEffect (lock-in model, same as the green line's activity
  // component) so the blue shaded area depth tracks the green line's drop.
  // Clipped to session start → session end + 30 min so the area doesn't extend
  // flat across the whole chart. Anchors injected at each session start (y=0)
  // prevent Victory from interpolating the left edge leftward.
  const POST_SESSION_TAIL_MS = 30 * 60_000;
  const activityEffectData = useMemo(() => {
    const windows = mergedActivityContributions
      .map(c => {
        const startMs = parseUTCMs(c.start_time);
        if (isNaN(startMs)) return null;
        const endMs = startMs + (c.duration_minutes ?? 30) * 60_000;
        return { startMs, endMs, cutoffMs: endMs + POST_SESSION_TAIL_MS };
      })
      .filter((w): w is { startMs: number; endMs: number; cutoffMs: number } => w !== null);

    const base = chartData.map(p => {
      const win = windows.find(w => p.timestamp >= w.startMs && p.timestamp <= w.cutoffMs);
      if (!win) return { x: p.timestamp, y: null as number | null };
      const duringSession = p.timestamp <= win.endMs;
      const val = p.activityCumulativeEffect;
      const show = duringSession || Math.abs(val) > 0.1;
      return { x: p.timestamp, y: show ? val : (null as number | null) };
    });

    const anchors = windows.map(w => ({ x: w.startMs, y: 0 as number | null }));
    return [...base, ...anchors].sort((a, b) => a.x - b.x);
  }, [chartData, mergedActivityContributions]);
  /** True when any chart point has a non-trivial activity effect */
  const activityEffectVisible = useMemo(
    () =>
      (hasActivityEffect || mergedActivityContributions.length > 0) &&
      activityEffectData.some(p => p.y != null),
    [hasActivityEffect, mergedActivityContributions, activityEffectData]
  );

  // ── Activity sensitivity indirect effect series ───────────────────────────

  // Purple base insulin area — uses insulinImpactBaseDisplay (Phase-3 persist) so
  // the area holds its depth when doses expire instead of snapping back toward
  // zero ("peak" artefact fix).
  const insulinBaseData = useMemo(
    () => chartData.map(p => ({ x: p.timestamp, y: p.insulinImpactBaseDisplay })),
    [chartData],
  );

  // Rose/magenta sensitivity boost — stacked directly below the purple base area.
  //
  // PEAKLESS FIX (v1): Use `insulinImpactBaseDisplay × sensitivityMultiplier` for y.
  //
  // Previously: y = insulinImpactBaseDisplay + insulinSensitivityBoost
  //   where insulinSensitivityBoost = insulinImpactBase × (multiplier − 1)
  //   At dose expiry, insulinImpactBase snaps to 0 → insulinSensitivityBoost snaps
  //   to 0 → y snaps UP to y0. This sudden collapse was the visible "peak" bump.
  //
  // After v1: y = insulinImpactBaseDisplay × sensitivityMultiplier
  //   = insulinImpactBaseDisplay + insulinImpactBaseDisplay × (multiplier − 1)
  //   Before expiry: insulinImpactBaseDisplay = insulinImpactBase (same, expiredContrib=0)
  //     → y = insulinImpactBase × multiplier = insulinImpactBoosted (unchanged ✓)
  //   After expiry:  insulinImpactBaseDisplay = −(dose×CF) (persisted)
  //     → y = −(dose×CF) × multiplier.  Band height = (dose×CF)×(multiplier−1)
  //     → decays smoothly to 0 as the sensitivity window closes (no snap ✓)
  //   No exercise (multiplier=1): y = insulinImpactBaseDisplay × 1 = y0 → height=0 ✓
  //
  // FLAT-FLOOR FIX (v2): Running floor — y may only go deeper (more negative).
  //
  // REMAINING ISSUE after v1 (mountain / peak shape in the blue area):
  //   During active absorption `insulinImpactBaseDisplay` is growing (more negative,
  //   S-curve) while `sensitivityMultiplier` decays post-exercise.  Their product
  //   peaks at some intermediate time and then rises back toward y0, creating a
  //   downward-pointing mountain shape instead of the intended flat bottom.
  //
  //   Root cause: the multiplier decays faster than the base deepens once the
  //   post-exercise plateau ends, so (multiplier−1)×|base| has an interior maximum.
  //
  // FIX: track a running floor `yFloor`.  At each chart tick:
  //   • If insulinImpactBaseDisplay ≈ 0 (no doses on board / daily reset boundary),
  //     clear the floor so the next dose-absorption cycle starts fresh.
  //   • Otherwise ratchet: yFloor = min(yFloor, y).
  //   The area's bottom edge (`y`) is then clamped to yFloor — it can only move
  //   deeper, never shallower.  This makes the band stay flat once it reaches its
  //   maximum depth, matching the physiological model: the boosted insulin action
  //   that was already delivered cannot un-deliver itself.
  const insulinBoostData = useMemo(() => {
    // Running floor: tracks the most-negative y seen so far.
    // Resets to 0 when there are no doses on board (insulinImpactBaseDisplay ≈ 0)
    // so the floor doesn't bleed across a daily reset boundary into the next day.
    let yFloor = 0;
    return chartData.map(p => {
      const y = p.insulinImpactBaseDisplay * p.sensitivityMultiplier;
      if (Math.abs(p.insulinImpactBaseDisplay) < 0.01) {
        // No doses on board or daily reset boundary — clear the floor.
        yFloor = 0;
      } else {
        // Ratchet: only allow the band to go deeper (more negative), never shallower.
        yFloor = Math.min(yFloor, y);
      }
      return {
        x:  p.timestamp,
        y:  yFloor,                      // flat once max depth is reached
        y0: p.insulinImpactBaseDisplay,  // bottom of purple = top of rose band
      };
    });
  }, [chartData]);

  // Adjusted orange meal area — the REDUCTION in meal BG impact due to elevated sensitivity.
  // This is mealImpact − activityAdjustedMealImpact: always ≥ 0 during the window.
  // Rendered as a green overlay on top of the full orange area (mirrors insulin approach:
  // purple base + rose boost, so here: orange base + green reduction overlay).
  const mealSensitivityReductionData = useMemo(
    () => chartData.map(p => ({
      x: p.timestamp,
      // The top of the orange area sits at mealImpact; the reduction sits between
      // activityAdjustedMealImpact (bottom of reduction band) and mealImpact (top).
      y: p.mealImpact,                          // top edge = full unscaled impact
      y0: p.activityAdjustedMealImpact,          // bottom edge = adjusted (lower) impact
    })),
    [chartData],
  );

  // Gate for legend + rose area + amber band rendering
  const hasSensitivityBoost = useMemo(
    () => chartData.some(p => p.sensitivityMultiplier > 1.005),
    [chartData],
  );

  /**
   * Sensitivity window bands: each session's full sensitivity window.
   * Spans session startMs → sessionEnd + τ_W + decayTail.
   *
   * CHANGE (sensitivity-at-start): Previously spanned sessionEnd → sessionEnd + τ_W
   * (post-exercise only). Updated to start at session startMs because insulin
   * sensitivity improves from the moment exercise begins — GLUT4 translocation
   * is active throughout the session, not just after it ends.
   * Matches the updated calculateSensitivityMultiplierAtTime (instant onset).
   */
  const sensitivityWindowAreas = useMemo<Array<{ startMs: number; endMs: number }>>(() => {
    if (!hasSensitivityBoost) return [];
    // Population-calibrated peak boosts (mirrors INTENSITY_PEAK_BOOST above)
    const PEAK_BOOST: Record<string, number> = {
      light:    0.10,
      moderate: 0.25,
      vigorous: 0.40,
    };
    // Strip ends when boost drops below ×1.05 ISF (5% above baseline).
    // Below this, the extra BG impact is < ~3–5 mg/dL — below measurement noise.
    // No hard cap needed; the threshold alone gives clinically correct boundaries:
    //   Light    (×1.10): strip ends ~2.5 h after session end
    //   Moderate (×1.25): strip ends ~3.9 h after session end
    //   Vigorous (×1.40): strip ends ~4.6 h after session end → ~13:37 for 08:00 session ✓
    const BOOST_THRESHOLD = 0.05;

    return mergedActivityContributions
      .map(c => {
        const startMs    = parseUTCMs(c.start_time);
        if (isNaN(startMs)) return null;
        const durationMs = (c.duration_minutes ?? 30) * 60_000;
        const sessionEnd = startMs + durationMs;

        // t = τ_W × ln(peakBoost / BOOST_THRESHOLD)
        const peakBoost   = PEAK_BOOST[c.intensity as string] ?? PEAK_BOOST.moderate;
        const decayTailMs = peakBoost > BOOST_THRESHOLD
          ? TAU_W_MS * Math.log(peakBoost / BOOST_THRESHOLD)
          : 0;

        // Bar starts at session start (not sessionEnd) — sensitivity is active
        // throughout the session, not just after it ends.
        return { startMs, endMs: sessionEnd + TAU_W_MS + decayTailMs };
      })
      .filter((x): x is { startMs: number; endMs: number } => x !== null);
  }, [mergedActivityContributions, hasSensitivityBoost]);


  // ── Combined Y domain — shared between VictoryChart domain prop and X-axis pin ──
  // Must come AFTER insulinDoseData (which it depends on). Extracted so that
  // yDomain[0] can be passed as axisValue to the X-axis, pinning its ticks to the
  // chart bottom rather than floating at y=0 mid-chart when insulin effects push
  // the domain below zero — matching the web Recharts XAxis bottom behaviour.
  const yDomain = useMemo<[number, number]>(() => {
    const insulinMin = insulinDoseData.length > 0
      ? Math.min(...insulinDoseData.map(d => d.y))
      : 0;
    return [
      Math.min(effectsDomain[0], doseDomain[0], insulinMin, -10),
      Math.max(effectsDomain[1], doseDomain[1]),
    ];
  }, [effectsDomain, doseDomain, insulinDoseData]);

  // ── Dual-axis scaling ────────────────────────────────────────────────────────
  // Victory Native has a single shared y-domain per chart.  To show an
  // independent right axis (0–60 dose scale) alongside the left effects axis
  // (e.g. -260 to +200), we:
  //   1. Map bar data from dose-space [-60,60] → main yDomain via scaleToMain().
  //   2. Position right-axis ticks at those same scaled coordinates.
  //   3. Label each tick with its original dose value (absolute, so both sides
  //      read 0→60 upward from zero).
  // This is the standard Victory dual-axis pattern.
  const DOSE_SCALE: [number, number] = [-60, 60];
  const DOSE_RAW_TICKS = [-60, -40, -20, 0, 20, 40, 60];

  // Map a value from dose-space to main y-space
  const scaleToMain = useCallback(
    (doseValue: number): number => {
      const [dMin, dMax] = DOSE_SCALE;
      const [yMin, yMax] = yDomain;
      return yMin + ((doseValue - dMin) / (dMax - dMin)) * (yMax - yMin);
    },
    [yDomain]
  );

  // Scaled bar data — bars now live in main y-space but represent dose amounts
  const scaledMealDoseData = useMemo(
    () => mealDoseData.map(p => ({ x: p.x, y: scaleToMain(Math.min(p.y, 60)) })),
    [mealDoseData, scaleToMain]
  );
  const scaledInsulinDoseData = useMemo(
    () => insulinDoseData.map(p => ({ x: p.x, y: scaleToMain(Math.max(p.y, -60)) })),
    [insulinDoseData, scaleToMain]
  );

  // Right-axis tick positions (in main y-space) paired with their dose labels
  const doseAxisTicks = useMemo(
    () => DOSE_RAW_TICKS.map(v => scaleToMain(v)),
    [scaleToMain]
  );

  // ── Loading / error states ────────────────────────────────────────────────────
  // Only show full-screen spinner on the FIRST load (effects are still fetching
  // AND we have no chart data yet).  Once effectsLoading is false — even with
  // empty data — we fall through to the chart render which shows the "no data"
  // empty state instead of spinning forever.
  // Show spinner only while genuinely loading AND not yet timed out.
  // timedOut = true after LOAD_TIMEOUT_MS — breaks the infinite spinner
  // caused by useActiveEffects.isLoading never flipping to false on empty data.
  const showFullScreenLoader = effectsLoading && !timedOut && chartData.length === 0;

  if (showFullScreenLoader) {
    return (
      <View style={[styles.centered, { height }]}>
        <ActivityIndicator size="large" color="#2196F3" />
        <Text style={styles.loadingText}>Loading effects data…</Text>
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

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, embedded && styles.embedded]}>

      {/* ── Header ── */}
      {showControls && (
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Insulin, Meal &amp; Net Effects</Text>
            <Text style={styles.headerSubtitle}>
              Blue dashed = Current rate · Green = Cumulative shift
            </Text>
          </View>
          <TouchableOpacity
            onPress={refresh}
            style={styles.refreshBtn}
            hitSlop={8}
          >
            <Text style={styles.refreshIcon}>{effectsLoading ? '⏳' : '🔄'}</Text>
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
              <Text
                style={[
                  styles.viewModeBtnText,
                  viewMode === key && styles.viewModeBtnTextActive,
                ]}
              >
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
          <ToggleRow label="🍽️ Meal Effect"     color="#FF9800" value={showMealEffect}        onChange={setShowMealEffect}        />
          <ToggleRow label="💉 Insulin Effect"   color="#9C27B0" value={showInsulinEffect}     onChange={setShowInsulinEffect}     />
          <ToggleRow label="📈 Cumulative ⭐"    color="#4CAF50" value={showCumulativeBaseline} onChange={setShowCumulativeBaseline} bold />
          <ToggleRow label="📌 Dose Markers"    color="#607D8B" value={showDoseMarkers}        onChange={setShowDoseMarkers}        />
          {/* Spec §2c — Activity legend: hidden when no activity data (1d condition) */}
          {hasActivityEffect && (
            <ToggleRow label="🏃 Activity"       color="#1565C0" value={showActivityEffect}    onChange={setShowActivityEffect}     />
          )}
          {/* Phase 7 — Sensitivity boost legend entries.
              FIX: was gated on activityEffectVisible && hasSensitivityBoost, which hid
              the legend once the direct teal effect decayed (~2.5 h post-exercise) even
              while the indirect boost overlays on meal/insulin were still rendering.
              Decoupled: show whenever there is a meaningful sensitivity boost, regardless
              of whether the direct activity line is still visible. */}
          {hasSensitivityBoost && (
            <View style={styles.toggleRow}>
              <View style={[styles.toggleSwatch, { backgroundColor: '#29B6F6', opacity: 0.7 }]} />
              <Text style={styles.toggleLabel}>💪 Sensitivity boost</Text>
            </View>
          )}
          {hasSensitivityBoost && (
            <View style={styles.toggleRow}>
              <View style={[styles.toggleSwatch, { backgroundColor: '#FFC107', opacity: 0.5 }]} />
              <Text style={styles.toggleLabel}>↑ Insulin sensitivity window</Text>
            </View>
          )}
        </View>
      )}

      {/* ── Victory Chart ── */}
      <View style={styles.chartWrapper}>
        {chartData.length > 0 ? (
          <VictoryChart
            width={CHART_WIDTH}
            height={height}
            theme={VictoryTheme.material}
            domain={{
              x: [timeRange.start, timeRange.end],
              y: yDomain,
            }}
            padding={{ top: 16, bottom: 48, left: 56, right: 56 }}
          >
            {/* X Axis — pinned to the bottom of the y domain via axisValue={yDomain[0]}.
                By default Victory anchors the X-axis at y=0, which sits mid-chart
                whenever the domain extends below zero (insulin effects). Setting
                axisValue to the minimum y value locks it to the chart floor, matching
                the web Recharts XAxis behaviour where ticks always appear at the bottom. */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={(t: number) => formatXAxis(t, viewConfig?.tickFormat)}
              axisValue={yDomain[0]}
              style={{
                tickLabels: { fontSize: 9, angle: -45, textAnchor: 'end', fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis — effects */}
            <VictoryAxis
              dependentAxis
              tickFormat={(v: number) => `${Math.round(v)}`}
              style={{
                tickLabels: { fontSize: 9, fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (right) — independent 0–60 dose scale.
                Ticks are positioned in main y-space (doseAxisTicks = scaled
                coordinates of [-60,-40,-20,0,20,40,60]) but labelled with their
                original dose values so the axis reads 0→60 on both sides of zero,
                completely independent of the left effects scale. */}
            <VictoryAxis
              dependentAxis
              orientation="right"
              tickValues={doseAxisTicks}
              tickFormat={(_v: number, i: number) => `${Math.abs(DOSE_RAW_TICKS[i])}`}
              style={{
                axis:       { stroke: '#607D8B', strokeWidth: 1 },
                tickLabels: { fontSize: 8, fill: '#607D8B' },
                grid:       { stroke: 'none' },
                ticks:      { stroke: '#607D8B', size: 4 },
              }}
            />

            {/* Zero reference — horizontal line at y=0.
                Must NOT use dependentAxis: without it Victory treats this as an
                X-type axis and axisValue={0} positions it at y=0 in chart space,
                creating the dashed horizontal baseline we want.
                With dependentAxis it would be a second Y-axis placed at x=0,
                which lands directly on top of the primary Y-axis (the left-overlap bug). */}
            <VictoryAxis
              axisValue={0}
              tickFormat={() => ''}
              style={{
                axis:  { stroke: '#999', strokeWidth: 1.5, strokeDasharray: '3 3' },
                ticks: { size: 0 },
                grid:  { stroke: 'none' },
              }}
            />

            {/* "Now" vertical reference line
                ─────────────────────────────────────────────────────────────
                WHY dependentAxis is required here (mirrors BloodGlucoseVisualization):
                  Victory interprets `axisValue` differently depending on axis type:
                    • Non-dependentAxis (X-axis):  axisValue = Y position
                      → draws a HORIZONTAL line at that Y value.
                    • dependentAxis    (Y-axis):  axisValue = X position
                      → draws a VERTICAL line at that X value.
                  Without `dependentAxis`, Victory treats timeRange.now
                  (a Unix ms timestamp, ~1.7 × 10¹²) as a Y position —
                  far outside yDomain — and the line is drawn off-screen.
                  `dependentAxis` places the axis at the correct X timestamp,
                  producing the visible vertical "now" separator.
            */}
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

            {/* Dose markers — bars pre-scaled into main y-space so they render
                correctly on the shared domain while the right axis labels show
                the original dose units (0–60 independent scale). */}
            {showDoseMarkers && scaledMealDoseData.length > 0 && (
              <VictoryBar
                data={scaledMealDoseData}
                barWidth={6}
                style={{ data: { fill: '#FF9800', opacity: 0.8 } }}
              />
            )}
            {showDoseMarkers && scaledInsulinDoseData.length > 0 && (
              <VictoryBar
                data={scaledInsulinDoseData}
                barWidth={6}
                style={{ data: { fill: '#9C27B0', opacity: 0.8 } }}
              />
            )}

            {/* ── Session duration bands ────────────────────────────────────────
                One light-blue shaded column per activity session, spanning the
                session's own start → end time. This replaces the old
                "sensitivity window" area which started at session END (+τ_W),
                placing the shaded box far to the right of the start marker.
                Now both elements are co-located: the band covers the session
                duration and the dashed start-line marks its left edge. */}
            {showActivityEffect && sessionDurationAreas.map((area, i) =>
              area.startMs <= timeRange.end && area.endMs >= timeRange.start ? (
                <VictoryArea
                  key={`session-band-${i}`}
                  data={[
                    { x: Math.max(area.startMs, timeRange.start), y: 0 },
                    { x: Math.min(area.endMs,   timeRange.end),   y: 0 },
                  ]}
                  y0={() => yDomain[0] * 0.38}
                  style={{
                    data: {
                      fill:        area.isActive ? '#29B6F6' : '#B2EBF2',
                      fillOpacity: area.isActive ? 0.02 : 0.01,
                      stroke:      'none',
                    },
                  }}
                />
              ) : null
            )}

            {/* ── Post-exercise sensitivity window — thin amber strip near x-axis ──────
                Replaces the old full-height amber block (removed: "large confusing
                yellow block"). Spans session end → end + τ_W (90 min) — the window
                where elevated ISF (W-state) is actively boosting insulin effect.

                WHY this matters for the green cumulative rebound:
                  During this strip, Phase 1/2 insulin is calculated with
                  CF × sensitivityMultiplier (boosted = more negative contribution).
                  Once a dose transitions to Phase 3 (fully absorbed) the contribution
                  reverts to base CF — less negative — so cumulativeNetBaseline moves
                  upward even with no new meals. The strip shows exactly WHEN that
                  Phase 2→3 boundary can occur, making the rebound interpretable.

                Height = bottom 14% of negative domain (just above x-axis ticks).
                Gated on hasSensitivityBoost so it never shows when multiplier = 1.0. */}
            {showActivityEffect && hasSensitivityBoost && sensitivityWindowAreas.map((area, i) =>
              area.startMs <= timeRange.end && area.endMs >= timeRange.start ? (
                <VictoryArea
                  key={`sensitivity-strip-${i}`}
                  data={[
                    { x: Math.max(area.startMs, timeRange.start), y: yDomain[0] * 0.93 },
                    { x: Math.min(area.endMs,   timeRange.end),   y: yDomain[0] * 0.93 },
                  ]}
                  y0={() => yDomain[0]}
                  style={{
                    data: {
                      fill:        '#29B6F6',
                      fillOpacity: 0.45,
                      stroke:      '#0288D1',
                      strokeWidth: 0.5,
                    },
                  }}
                />
              ) : null
            )}

            {/* ── Session-end boundary marker ──────────────────────────────────────
                Solid tick at the exact moment training ends — marks the boundary
                between "exercising" (sensitivity bar left portion) and "post-exercise
                plateau" (sensitivity bar right portion). Height matches the sensitivity strip. */}
            {showActivityEffect && hasSensitivityBoost && mergedActivityContributions.map((c, i) => {
              const startMs    = parseUTCMs(c.start_time);
              if (isNaN(startMs)) return null;
              const sessionEndMs = startMs + (c.duration_minutes ?? 30) * 60_000;
              if (sessionEndMs < timeRange.start || sessionEndMs > timeRange.end) return null;
              return (
                <VictoryLine
                  key={`session-end-tick-${i}`}
                  data={[
                    { x: sessionEndMs, y: yDomain[0] },
                    { x: sessionEndMs, y: yDomain[0] * 0.93 },
                  ]}
                  style={{
                    data: {
                      stroke:      '#0288D1',
                      strokeWidth: 1.5,
                    },
                  }}
                />
              );
            })}

            {/* ── Session start markers ────────────────────────────────────────────
                Short dashed vertical line at the left edge of each session band,
                marking the precise start time. Sits in the lower third of the
                chart (below baseline) so it doesn't obscure the effect curves. */}
            {showActivityEffect && sessionMarkers.map((m, i) =>
              m.startMs >= timeRange.start && m.startMs <= timeRange.end ? (
                <VictoryLine
                  key={`session-start-${i}`}
                  data={[
                    { x: m.startMs, y: 0 },
                    { x: m.startMs, y: yDomain[0] * 0.38 },
                  ]}
                  style={{
                    data: {
                      stroke:          m.isActive ? '#1565C0' : '#1976D2',
                      strokeWidth:     1.5,
                      strokeDasharray: '4 3',
                    },
                  }}
                />
              ) : null
            )}

            {/* ── Spec §2a+§2b — Activity effect: fill + curve stroke ────────────────
                Split into two layers to avoid VictoryArea closing its perimeter
                stroke along the y0=0 baseline (which was drawing a continuous blue
                line over the meal/insulin areas even when activityEffect=0):
                  1. VictoryArea  — fill only (stroke:'none'), y0=0, null-clipped y
                  2. VictoryLine  — curve stroke only, same null-clipped data
                Null-clipped data ensures neither renders in zero-effect segments. */}
            {showActivityEffect && activityEffectVisible && (
              <VictoryArea
                data={activityEffectData}
                y0={() => 0}
                interpolation="linear"
                style={{
                  data: {
                    stroke:      'none',
                    fill:        '#1565C0',
                    fillOpacity: 0.40,
                  },
                }}
              />
            )}
            {showActivityEffect && activityEffectVisible && (
              <VictoryLine
                data={activityEffectData}
                interpolation="linear"
                style={{
                  data: { stroke: '#1565C0', strokeWidth: 2.5 },
                }}
              />
            )}

            {/* Meal effect area (orange) — full unscaled base, unchanged from pre-activity */}
            {showMealEffect && (
              <VictoryArea
                data={mealEffectData}
                interpolation="monotoneX"
                style={{
                  data: { fill: '#FF9800', fillOpacity: 0.25, stroke: 'none' },
                }}
              />
            )}

            {/* Teal meal sensitivity reduction overlay — sits between activityAdjustedMealImpact
                (bottom) and mealImpact (top), showing the portion of carb absorption that is
                blunted by the post-exercise sensitivity boost.
                Mirrors the rose/insulin approach: full base + colored delta on top.
                Zero-width band when multiplier === 1.0 — renders nothing. */}
            {showMealEffect && hasSensitivityBoost && (
              <VictoryArea
                data={mealSensitivityReductionData}
                interpolation="monotoneX"
                style={{
                  data: { fill: '#29B6F6', fillOpacity: 0.45, stroke: 'none' },
                }}
              />
            )}

            {/* Purple insulin base area — unscaled CF, no sensitivity boost */}
            {showInsulinEffect && (
              <VictoryArea
                data={insulinBaseData}
                interpolation="monotoneX"
                style={{
                  data: { fill: '#9C27B0', fillOpacity: 0.40, stroke: 'none' },
                }}
              />
            )}

            {/* Rose/magenta sensitivity boost — stacked on top of (below) the purple base.
                y0 per point = insulinImpactBase (bottom of purple area, ≤ 0).
                y  per point = insulinImpactBoosted (the further-negative boosted total).
                Result: the rose band fills the gap between the purple base and the full
                boosted depth, visually extending the purple block downward.
                Zero-width band when multiplier === 1.0 — renders nothing. */}
            {showInsulinEffect && hasSensitivityBoost && (
              <VictoryArea
                data={insulinBoostData}
                y0={(d: any) => d.y0}
                interpolation="monotoneX"
                style={{
                  data: { fill: '#29B6F6', fillOpacity: 0.55, stroke: 'none' },
                }}
              />
            )}

            {/* Net effect line (blue dashed) */}
            {showNetEffect && (
              <VictoryLine
                data={netEffectData}
                interpolation="monotoneX"
                style={{
                  data: { stroke: '#2196F3', strokeWidth: 2.5, strokeDasharray: '5 5' },
                }}
              />
            )}

            {/* Cumulative baseline line (green solid ⭐) */}
            {showCumulativeBaseline && (
              <VictoryLine
                data={cumulativeData}
                interpolation="monotoneX"
                style={{
                  data: { stroke: '#4CAF50', strokeWidth: 3 },
                }}
              />
            )}
          </VictoryChart>
        ) : (
          <View style={[styles.centered, { height: height * 0.7 }]}>
            {generating ? (
              <>
                <ActivityIndicator size="small" color="#2196F3" />
                <Text style={styles.emptyText}>Calculating…</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyIcon}>📊</Text>
                <Text style={styles.emptyText}>No meal or insulin data in this period.</Text>
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
              { color: '#FF9800', label: 'Meal Effect',        desc: 'Instantaneous BG elevation from active meals',             area: true  },
              { color: '#9C27B0', label: 'Insulin Effect',     desc: 'Instantaneous BG reduction from active insulin (negative)', area: true  },
              { color: '#2196F3', label: 'Net Effect',         desc: 'Combined meal + insulin rate-of-change',                   line: true, dashed: true  },
              { color: '#4CAF50', label: 'Cumulative Shift ⭐', desc: 'Running "bank balance" from the day\'s reset hour',        line: true, dashed: false },
              { color: '#1565C0', label: 'Activity Effect',    desc: 'Signed BG contribution from exercise (negative = aerobic BG-lowering)',  line: true, dashed: false },
              { color: '#29B6F6', label: 'Sensitivity Boost',  desc: 'Extra insulin effect from post-exercise ISF elevation (light blue = boost above base)',  area: true  },
              { color: '#29B6F6', label: 'Meal Reduction',     desc: 'Portion of meal BG rise blunted by post-exercise sensitivity (light blue = absorbed reduction)', area: true  },
              { color: '#FFC107', label: 'Sensitivity Window',  desc: `Post-exercise τ_W (${TAU_W_MIN} min) strip near x-axis — insulin sensitivity elevated; Phase 2→3 transition here causes cumulative rebound`, area: true  },
            ].map(({ color, label, desc, area, line, dashed }) => (
              <View key={label} style={styles.aboutSeriesRow}>
                {area
                  ? <View style={[styles.aboutArea, { backgroundColor: color }]} />
                  : <View style={[styles.aboutLine, { backgroundColor: color }, dashed && styles.aboutLineDashed]} />
                }
                <View style={styles.aboutSeriesText}>
                  <Text style={styles.aboutSeriesLabel}>{label}</Text>
                  <Text style={styles.aboutSeriesDesc}>{desc}</Text>
                </View>
              </View>
            ))}

            {/* Dose markers */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 12 }]}>Dose Markers</Text>
            {[
              { color: '#FF9800', label: 'Meal bar',    desc: 'Carb-equivalent at logged meal time'   },
              { color: '#9C27B0', label: 'Insulin bar', desc: 'Units × scale at injection time'       },
            ].map(({ color, label, desc }) => (
              <View key={label} style={styles.aboutSeriesRow}>
                <View style={[styles.aboutBar, { backgroundColor: color }]} />
                <View style={styles.aboutSeriesText}>
                  <Text style={styles.aboutSeriesLabel}>{label}</Text>
                  <Text style={styles.aboutSeriesDesc}>{desc}</Text>
                </View>
              </View>
            ))}

            {/* Reference lines */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 12 }]}>Reference Lines</Text>
            {[
              { color: '#da2a2a', desc: 'Current time (Now)'               },
              { color: '#2196F3', desc: 'Zero baseline (no net effect)'     },
            ].map(({ color, desc }) => (
              <View key={desc} style={styles.aboutRefRow}>
                <Text style={[styles.aboutDash, { color }]}>– –</Text>
                <Text style={styles.aboutRefDesc}>{desc}</Text>
              </View>
            ))}

            {/* How it works note */}
            <View style={styles.aboutNoteBox}>
              <Text style={styles.aboutNoteText}>
                The Cumulative Shift resets each day at your configured reset hour (default 7 AM). Meals push it up; insulin pushes it down. The "bank balance" persists at full effect once absorption is complete.{'\n\n'}
                The Activity Effect line shows the signed BG change from exercise. Aerobic sessions push it negative (BG-lowering). The amber shaded area under zero highlights the active hypoglycaemia risk window. Vertical tick marks (L / M / V) show session start times. The amber strip near the x-axis marks the post-exercise insulin sensitivity window (τ_W = {TAU_W_MIN} min): during this window elevated ISF boosts insulin effect (Phase 2). When a dose transitions to Phase 3 (fully absorbed) inside or just after this strip, the cumulative line can rebound upward — that is the expected Phase 2→3 boundary discontinuity, not an error. The solid amber tick at the right edge of the strip marks the precise moment training ended.{'\n\n'}
                The rose/magenta area shows the extra insulin effect from post-exercise ISF elevation (sensitivity boost). The amber band marks the peak sensitivity plateau window. During this window, the orange meal area is flatter because elevated insulin sensitivity lowers the effective carb-to-BG factor.
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* ── Now summary ── */}
      {chartData.length > 0 && (() => {
        const nowPoint = chartData.find(p => p.isNow) ?? chartData[Math.floor(chartData.length / 2)];
        const baseline = stableBaseline ?? patientConstants?.target_glucose ?? 100;
        // Pure-model: baseline + cumulative (activity already included in
        // cumulativeNetBaseline via calculateActivityEffectAtTime, decayed correctly).
        const modelEstimatedBG = baseline + nowPoint.cumulativeNetBaseline;
        // BG ESTIMATE SELECTION:
        //
        // Dynamic mode: stableBaseline is back-calculated from the last reading by
        //   unwinding meals+insulin at the reading moment, so it is already reading-
        //   anchored.  modelEstimatedBG = stableBaseline + cumulative is therefore
        //   the correct estimate, and always matches the "Baseline + Cumulative" text.
        //
        //   hookEstimatedBG (from useActiveEffects / net-effect.ts) applies the FULL
        //   API-reported cumulative_activity_effect unconditionally, without the
        //   "activityDeltaSinceReading" correction used in ActiveEffectsDisplay.
        //   When exercise sessions ended before the reading, their effect is already
        //   baked into stableBaseline via the unwinding step, so adding it again
        //   double-counts the activity and produces a value ~15 mg/dL too low.
        //
        // Preset mode: stableBaseline is a circadian lookup with no reading anchor.
        //   The hook applies a reading residual (reading − circadian@readingTime −
        //   cumul@readingTime) that the pure model cannot compute, so hookEstimatedBG
        //   is more accurate and should be preferred.
        const estimatedBG = (baselineMode === 'preset' && hookEstimatedBG != null)
          ? hookEstimatedBG
          : modelEstimatedBG;
        // Residual offset: non-zero only in preset mode when the hook has anchored to
        // the last reading.  Used to shift all tooltip BG values by the same amount
        // so every point is consistent with the Now Summary.
        const residualOffset = (baselineMode === 'preset' && hookEstimatedBG != null)
          ? hookEstimatedBG - modelEstimatedBG
          : 0;

        return (
          <View style={styles.nowSummary}>
            <View style={styles.nowSummaryMain}>
              <Text style={styles.nowLabel}>Current BG Estimate</Text>
              <Text style={[
                styles.nowBG,
                estimatedBG > 180 ? styles.textHigh :
                estimatedBG < 70  ? styles.textLow  :
                styles.textNormal
              ]}>
                {Math.round(estimatedBG)} mg/dL
              </Text>
              <Text style={styles.nowDetail}>
                Baseline {Math.round(baseline)} + Cumulative{' '}
                {nowPoint.cumulativeNetBaseline > 0 ? '+' : ''}
                {Math.round(nowPoint.cumulativeNetBaseline)}
                {baselineMode === 'preset' ? ' vs circadian' : ' vs reading baseline'}
              </Text>
            </View>

            <View style={styles.nowSummaryRight}>
              <SummaryPill
                label="Meal"
                value={`+${Math.round(nowPoint.mealImpact)}`}
                color="#FF9800"
              />
              <SummaryPill
                label="Insulin"
                value={`${Math.round(nowPoint.insulinImpact)}`}
                color="#9C27B0"
              />
              <SummaryPill
                label="Net"
                value={`${nowPoint.netEffect > 0 ? '+' : ''}${Math.round(nowPoint.netEffect)}`}
                color="#2196F3"
              />
              {/* Spec §2c — Activity pill: hidden when no meaningful activity effect.
                  hasActivityEffect guards against no sessions at all.
                  The second check (rounded value !== 0) prevents showing "Activity 0"
                  when sessions are fully absorbed and the exponential W-state decay
                  has reduced the remaining BG effect to < 0.5 mg/dL. Sensitivity-
                  multiplier elevation can keep hasActivityEffect true long after the
                  acute BG effect has decayed, so we guard on the rounded value too. */}
              {hasActivityEffect && Math.round(nowPoint.activityEffect) !== 0 && (
                <SummaryPill
                  label="Activity"
                  value={`${nowPoint.activityEffect >= 0 ? '+' : ''}${Math.round(nowPoint.activityEffect)}`}
                  color="#1565C0"
                />
              )}
            </View>
          </View>
        );
      })()}

      {/* ── Tap-to-inspect tooltip modal ── */}
      {tooltipData !== null && (
        <TooltipModal
          data={tooltipData.point}
          stableBaseline={stableBaseline ?? patientConstants?.target_glucose ?? 100}
          residualOffset={(() => {
            // Mirror the same dynamic/preset split used in the Now Summary above.
            // In dynamic mode the offset is 0 (stableBaseline is already reading-anchored).
            // In preset mode the hook applies a reading residual that the model lacks.
            if (baselineMode !== 'preset' || hookEstimatedBG == null) return 0;
            const baseline = stableBaseline ?? patientConstants?.target_glucose ?? 100;
            const nowPoint = chartData.find(p => p.isNow) ?? chartData[Math.floor(chartData.length / 2)];
            return hookEstimatedBG - (baseline + nowPoint.cumulativeNetBaseline);
          })()}
          onClose={() => setTooltipData(null)}
        />
      )}
    </View>
  );
};

// ============================================================
// SUB-COMPONENTS
// ============================================================

// ── ToggleRow ─────────────────────────────────────────────────

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

// ── LegendItem ───────────────────────────────────────────────

const LegendItem: React.FC<{ color: string; label: string; dashed: boolean }> = ({
  color, label, dashed
}) => (
  <View style={styles.legendItem}>
    <View style={[
      styles.legendLine,
      { backgroundColor: color },
      dashed && styles.legendLineDashed,
    ]} />
    <Text style={styles.legendLabel}>{label}</Text>
  </View>
);

// ── SummaryPill ──────────────────────────────────────────────

const SummaryPill: React.FC<{ label: string; value: string; color: string }> = ({
  label, value, color
}) => (
  <View style={[styles.pill, { borderColor: color }]}>
    <Text style={styles.pillLabel}>{label}</Text>
    <Text style={[styles.pillValue, { color }]}>{value}</Text>
  </View>
);

// ── TooltipModal ─────────────────────────────────────────────

interface TooltipModalProps {
  data:            EffectsChartPoint;
  stableBaseline:  number;
  /** Reading-anchor offset (preset mode) so tooltip BG matches the Now Summary. 0 in dynamic mode. */
  residualOffset?: number;
  onClose:         () => void;
}

const TooltipModal: React.FC<TooltipModalProps> = ({ data, stableBaseline, residualOffset = 0, onClose }) => {
  const estimatedBG  = stableBaseline + data.cumulativeNetBaseline + residualOffset;
  const hasMealDose  = data.mealsAdministered.length > 0;
  const hasInsulinDose = data.insulinAdministered.length > 0;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.modalCard}>
          {/* Header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTime}>
              {data.formattedTime}
              {data.isNow ? '  🔴 Now' : ''}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView>
            {/* Current BG estimate (shown only at "Now") */}
            {data.isNow && (
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>📊 Current BG Estimate</Text>
                <Text style={styles.modalBig}>{Math.round(estimatedBG)} mg/dL</Text>
                <Text style={styles.modalMuted}>
                  Baseline {Math.round(stableBaseline)}{' '}
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} cumulative
                </Text>
              </View>
            )}

            {/* Doses */}
            {(hasMealDose || hasInsulinDose) && (
              <View style={[styles.modalSection, { borderColor: '#2196F3' }]}>
                <Text style={styles.modalSectionTitle}>💊 Doses at this time</Text>

                {hasMealDose && (
                  <>
                    <Text style={[styles.modalLabel, { color: '#FF9800' }]}>
                      🍽️ Meals ({data.mealsAdministered.length})
                    </Text>
                    {data.mealsAdministered.map((m: any, i: number) => (
                      <Text key={i} style={styles.modalItem}>
                        • {m.mealType ?? 'Meal'}: {(m.carbEquiv ?? 0).toFixed(1)}g carbs
                      </Text>
                    ))}
                  </>
                )}

                {hasInsulinDose && (
                  <>
                    <Text style={[styles.modalLabel, { color: '#9C27B0', marginTop: 8 }]}>
                      💉 Insulin ({data.insulinAdministered.length})
                    </Text>
                    {data.insulinAdministered.map((d: any, i: number) => (
                      <Text key={i} style={styles.modalItem}>
                        • {d.insulinType ?? d.medication}: {(d.dose ?? d.units ?? 0).toFixed(1)}u
                      </Text>
                    ))}
                  </>
                )}
              </View>
            )}

            {/* Current activity */}
            {(data.mealImpact > 0.1 || Math.abs(data.insulinImpact) > 0.1) && (
              <View style={[styles.modalSection, { backgroundColor: '#fff9e6' }]}>
                <Text style={[styles.modalSectionTitle, { color: '#1565C0' }]}>
                  ⚡ Current Activity (Rate)
                </Text>
                {data.mealImpact > 0.1 && (
                  <Text style={styles.modalRow}>
                    🍽️ Meal:{' '}
                    <Text style={{ color: '#FF9800', fontWeight: '700' }}>
                      +{Math.round(data.mealImpact)} mg/dL
                    </Text>
                  </Text>
                )}
                {Math.abs(data.insulinImpact) > 0.1 && (
                  <Text style={styles.modalRow}>
                    💉 Insulin:{' '}
                    <Text style={{ color: '#9C27B0', fontWeight: '700' }}>
                      {Math.round(data.insulinImpact)} mg/dL
                    </Text>
                  </Text>
                )}
                <Text style={[styles.modalRow, { marginTop: 6, fontWeight: '600' }]}>
                  Net:{' '}
                  <Text style={{
                    color: data.netEffect > 0 ? '#FF9800' : data.netEffect < 0 ? '#4CAF50' : '#666',
                    fontWeight: '700',
                  }}>
                    {data.netEffect > 0 ? '+' : ''}{Math.round(data.netEffect)} mg/dL
                  </Text>
                </Text>
              </View>
            )}

            {/* Exercise sensitivity boost breakdown */}
            {Math.abs(data.insulinSensitivityBoost) > 0.5 && (
              <View style={[styles.modalSection, { borderColor: '#29B6F6', backgroundColor: '#e1f5fe' }]}>
                <Text style={[styles.modalSectionTitle, { color: '#0288D1' }]}>
                  💪 Sensitivity boost
                </Text>
                <Text style={styles.modalRow}>
                  Base insulin:{' '}
                  <Text style={{ color: '#9C27B0', fontWeight: '700' }}>
                    {Math.round(data.insulinImpactBase)} mg/dL
                  </Text>
                </Text>
                <Text style={styles.modalRow}>
                  Exercise boost:{' '}
                  <Text style={{ color: '#29B6F6', fontWeight: '700' }}>
                    {Math.round(data.insulinSensitivityBoost)} mg/dL
                  </Text>
                </Text>
                <Text style={[styles.modalRow, { fontWeight: '700', marginTop: 4 }]}>
                  Total: {Math.round(data.insulinImpact)} mg/dL
                  {'  '}×{data.sensitivityMultiplier.toFixed(2)}
                </Text>
              </View>
            )}

            {/* Adjusted meal impact */}
            {data.activityAdjustedMealImpact !== data.mealImpact &&
              data.mealImpact > 0.1 && (
              <View style={[styles.modalSection, { borderColor: '#29B6F6', backgroundColor: '#e1f5fe' }]}>
                <Text style={[styles.modalSectionTitle, { color: '#0288D1' }]}>
                  🍽️ Meal — sensitivity adjusted
                </Text>
                <Text style={styles.modalRow}>
                  Full impact:{' '}
                  <Text style={{ color: '#FF9800', fontWeight: '700' }}>
                    +{Math.round(data.mealImpact)} mg/dL
                  </Text>
                </Text>
                <Text style={styles.modalRow}>
                  Blunted by exercise:{' '}
                  <Text style={{ color: '#29B6F6', fontWeight: '700' }}>
                    −{Math.round(data.mealImpact - data.activityAdjustedMealImpact)} mg/dL
                  </Text>
                </Text>
                <Text style={[styles.modalRow, { fontWeight: '700', marginTop: 4 }]}>
                  Net meal effect:{' '}
                  <Text style={{ color: '#FF6D00', fontWeight: '700' }}>
                    +{Math.round(data.activityAdjustedMealImpact)} mg/dL
                  </Text>
                </Text>
              </View>
            )}

            {/* Cumulative bank balance */}
            <View style={[styles.modalSection, { borderColor: '#4CAF50', backgroundColor: '#e8f5e9' }]}>
              <Text style={[styles.modalSectionTitle, { color: '#2E7D32' }]}>
                📈 Cumulative Shift (Bank Balance)
              </Text>
              <Text style={styles.modalRow}>
                Meals:    <Text style={{ color: '#FF9800' }}>+{Math.round(data.cumulativeMealEffect)}</Text>
              </Text>
              <Text style={styles.modalRow}>
                Insulin:  <Text style={{ color: '#9C27B0' }}>{Math.round(data.cumulativeInsulinEffect)}</Text>
              </Text>
              {/* Spec §2a — Activity effect in tooltip */}
              {Math.abs(data.activityEffect) > 0.05 && (
                <Text style={styles.modalRow}>
                  Activity:{' '}
                  <Text style={{ color: data.activityEffect < 0 ? '#E53935' : '#1565C0', fontWeight: '700' }}>
                    {data.activityEffect >= 0 ? '+' : ''}{Math.round(data.activityEffect)} mg/dL
                  </Text>
                  <Text style={{ color: '#888', fontSize: 11 }}>
                    {data.activityEffect < 0 ? '  ↓ BG-lowering' : '  ↑ BG-raising'}
                  </Text>
                </Text>
              )}
              <Text style={[styles.modalRow, { fontWeight: '700', marginTop: 6 }]}>
                Net shift:{' '}
                <Text style={{
                  color: data.cumulativeNetBaseline > 0 ? '#FF6B00'
                       : data.cumulativeNetBaseline < 0 ? '#2E7D32'
                       : '#666',
                  fontSize: 16,
                }}>
                  {data.cumulativeNetBaseline > 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </Text>
              <Text style={styles.modalMuted}>
                {data.cumulativeNetBaseline > 0 ? 'Above baseline ⬆️'
                : data.cumulativeNetBaseline < 0 ? 'Below baseline ⬇️'
                : 'At baseline ➡️'}
              </Text>
            </View>

            <Text style={styles.modalFooter}>
              {data.isHistorical ? '📊 Historical' : '🔮 Projected'}
            </Text>
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
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
  },
  embedded: {
    borderRadius: 0,
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
    backgroundColor: '#2196F3',
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
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  refreshBtn: {
    padding: 4,
    marginLeft: 8,
  },
  refreshIcon: {
    fontSize: 20,
  },

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
    backgroundColor: '#2196F3',
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
  viewModeBtnCustom:     { borderWidth: 1.5, borderColor: '#2196F3', backgroundColor: 'transparent' },
  customRangePanel:      { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#f0f8ff' },
  customRangeRow:        { flexDirection: 'row', gap: 8, marginBottom: 4 },
  customRangePicker:     { flex: 1 },
  customRangeApplyBtn:   { backgroundColor: '#2196F3', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  customRangeAppliedBtn: { backgroundColor: '#1565C0' },
  customRangeApplyText:  { color: '#fff', fontWeight: '700', fontSize: 14 },

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
    color: '#2E7D32',
  },
  toggleSwitch: {
    transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }],
  },

  // ── Chart wrapper ──
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
  aboutBar: {
    width: 6,
    height: 16,
    borderRadius: 2,
    opacity: 0.8,
    flexShrink: 0,
    marginLeft: 7,
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
    backgroundColor: '#f8f9ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e8ff',
  },
  nowSummaryMain: {
    flex: 1,
  },
  nowLabel: {
    fontSize: 11,
    color: '#666',
    marginBottom: 2,
  },
  nowBG: {
    fontSize: 28,
    fontWeight: '700',
  },
  textHigh:   { color: '#FF6B00' },
  textLow:    { color: '#E53935' },
  textNormal: { color: '#2196F3' },
  nowDetail: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  nowSummaryRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
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
  pillLabel: {
    fontSize: 10,
    color: '#888',
  },
  pillValue: {
    fontSize: 12,
    fontWeight: '700',
  },

  // ── Tooltip modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    maxHeight: '80%',
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
  modalTime: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  modalClose: {
    fontSize: 18,
    color: '#888',
    padding: 4,
  },
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
  modalBig: {
    fontSize: 28,
    fontWeight: '700',
    color: '#2196F3',
  },
  modalLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  modalItem: {
    fontSize: 12,
    color: '#444',
    paddingLeft: 8,
    marginBottom: 2,
  },
  modalRow: {
    fontSize: 13,
    color: '#444',
    marginBottom: 4,
  },
  modalMuted: {
    fontSize: 11,
    color: '#888',
    marginTop: 4,
    fontStyle: 'italic',
  },
  modalFooter: {
    textAlign: 'center',
    fontSize: 11,
    color: '#999',
    marginVertical: 12,
  },
});

export default React.memo(EffectsVisualizationChart);