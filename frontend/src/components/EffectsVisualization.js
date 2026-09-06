/**
 * ============================================================================
 * EFFECTS VISUALIZATION - WITH CUMULATIVE BASELINE TRACKING
 * ============================================================================
 *
 * VERSION: 6.0 (W-State Activity Line + Session Band Shading + Intensity Markers)
 *
 * NEW IN v6.0 — Six parity gaps with EffectsVisualizationChart.tsx closed:
 *
 * P-1 (Priority 1) — W-state decay curve (activityEffect field + teal Line):
 *   New `activityEffect` data field computed by `computeActivityEffectAtTime()`.
 *   Model: linear ODE ramp during session → flat plateau for the full τ_W
 *   (90 min) sensitivity window → fast exponential decay (τ_acute = 15 min)
 *   after the window.  Rendered as a teal Line (stroke #00ACC1, dashed) on the
 *   effects axis.  Toggled by the existing `showActivityEffect` checkbox.
 *   This replaces the monotone `activityImpact` area as the primary W-state
 *   signal; the area remains visible (deliveredDrop semantics, bounded window).
 *
 * P-2 (Priority 2) — Session band shading (ReferenceArea):
 *   A semi-transparent teal `<ReferenceArea>` is rendered for each session,
 *   spanning `startMs → startMs + duration + τ_W` so the user can see the
 *   full influence window of each session at a glance.
 *   Toggled by new `showActivityMarkers` state (separate from the dose-marker
 *   bar toggle, matching the TSX `showActivityMarkers` / `showDoseMarkers`
 *   separation).
 *
 * P-3 (Priority 3) — Intensity-labeled session markers (ReferenceLine):
 *   A vertical `<ReferenceLine>` is rendered at each session's start time,
 *   labeled with the intensity initial (L / M / V) in teal.
 *   Toggled by the same `showActivityMarkers` state as the band shading.
 *
 * P-4 (Priority 4) — `showActivityMarkers` toggle:
 *   New checkbox "🏃 Session Bands & Markers" controls the band shading and
 *   labeled reference lines added in P-2/P-3.  The existing
 *   `showActivityDoseMarker` checkbox still controls only the magnitude bar.
 *
 * P-5/P-6 (Lower priority) — Deferred (require synthetic historical
 *   contribution generation for multi-day views; out of scope for this pass).
 *
 * Constants sourced from shared_constants (single source of truth):
 *   TAU_W_MS  = HR_MODEL.tau_W × 60 000 ms  (90 min)
 *   TAU_Z_MS  = HR_MODEL.tau_Z × 60 000 ms  (10 min, pre-existing)
 *   TAU_ACUTE_MS = 15 min (fast W-decay after sensitivity window, hardcoded
 *                  intentionally — no shared constant exists for this yet)
 *
 * MAINTAINED FROM v5.3:
 * - Activity-only rendering gate (no meals/insulin required).
 * - activityImpact bounded area (deliveredDrop, null outside ODE window).
 * - activityDoseMarker bar on the left effects axis (mg/dL, negated).
 * - React.memo comparison on actual prop names.
 * - All ChartUtils-based shared logic unchanged.
 *
 * PART 1 of 2: Imports, State, Data Processing
 * ============================================================================
 */

import React, { useState, useEffect, useCallback, useMemo, useContext, useRef } from 'react';
import axios from 'axios';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ReferenceArea,   // ✅ v6.0 P-2: session band shading (retained for potential future use)
} from 'recharts';

import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';
import TimeContext from '../contexts/TimeContext';
import TimeManager from '../utils/TimeManager';
import API_BASE_URL from '../config';

import {
  calculateNetEffectAtTime,
  NET_EFFECT_CONSTANTS
} from '../utils/netEffectCalculationService';

import {
  normalizeActivityRecord,
  calculateActivityCumulativeEffect,   // ✅ v6.0: also used for teal-line ramp
  getActivityOnBoard,
  calculateActivitySensitivityMultiplier,
  HR_MODEL,
} from '../utils/activityPharmacodynamics';

import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { FaSync, FaExpand, FaCompress } from 'react-icons/fa';
import './Charts/global-visualization.css';

import {
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  generateSymmetricTicks,
  calculateEffectsAxisDomain,
  calculateDoseAxisDomain,
  calculateDynamicBarSize,
  createXAxisFormatter,
  findMealsAtTime,
  findInsulinAtTime
} from '../utils/ChartUtils';

// =====================================
// CONSTANTS
// =====================================

const VIEW_CONFIGS = SHARED_CONSTANTS.VIEW_MODE_CONFIGS;
const DEBUG_MODE = false;

// Activity tail window: same as ActivityVisualization
const ACTIVITY_TAIL_MS = (4 * 10 + 8 * 60) * 60 * 1000; // ~8.67 h

// ✅ v5.2: τ_Z in milliseconds — sourced from shared_constants (single source of truth).
// Full ODE tail = 4 × τ_Z (40 min), matching postTail in calculateActivityCumulativeEffect.
const TAU_Z_MS = HR_MODEL.tau_Z * 60_000; // 10 min × 60 000 ms = 600 000 ms

// ✅ v6.0 P-1: τ_W in milliseconds — post-exercise sensitivity window.
// Sourced from HR_MODEL.tau_W (= 90 min in shared_constants) — never hardcoded.
const TAU_W_MS = HR_MODEL.tau_W * 60_000; // 90 min × 60 000 ms = 5 400 000 ms

// ✅ v6.0 P-1: τ_acute — time constant for the fast exponential recovery after the
// τ_W sensitivity window expires (mirrors the TSX `TAU_ACUTE_MS` constant).
// No shared_constants entry exists yet; 15 min is the value used in the TSX.
const TAU_ACUTE_MS = 15 * 60_000; // 15 min

// Intensity icons (mirrors ActivityVisualization)
const INTENSITY_ICONS = {
  light:    '🚶',
  moderate: '🏃',
  vigorous: '⚡',
};

// ✅ v6.0 P-3: Short labels rendered on session-start ReferenceLine markers.
const INTENSITY_LABELS = { light: 'L', moderate: 'M', vigorous: 'V' };

// ✅ v6.0 P-2: Teal shades per intensity for session band fill.
// More intense exercise gets a slightly deeper hue for quick visual discrimination.
const INTENSITY_BAND_FILL = {
  light:    '#80DEEA', // cyan-200
  moderate: '#26C6DA', // cyan-400
  vigorous: '#00BCD4', // cyan-500
};


// ─── Local helper: activity phase label ───────────────────────────────────────
function getActivityPhase(minutesElapsed, durationMinutes) {
  if (minutesElapsed < 0)                          return 'Upcoming';
  if (minutesElapsed < durationMinutes)            return 'In Progress';
  if (minutesElapsed < durationMinutes * 1.5)      return 'Peak Effect';
  if (minutesElapsed < durationMinutes * 3)        return 'Active Recovery';
  return 'Tail Effect';
}

// ============================================================
// ✅ v6.0 P-1: W-STATE ACTIVITY EFFECT HELPERS
// ============================================================

/**
 * Get the fully-delivered terminal BG effect for one activity session.
 *
 * Evaluates `calculateActivityCumulativeEffect` at session end + full ODE tail
 * (4 × τ_Z), which is the point where the Z state has fully decayed back to 0
 * and no further acute BG drop will be delivered.  This is the anchor value
 * used for the plateau and exponential-decay phases of the teal line.
 *
 * @param {object} activity        — Normalized activity record
 * @param {object} patientConstants — Patient constants (weight_kg, hr_base, …)
 * @returns {number} Signed BG effect in mg/dL (negative for aerobic)
 */
function getFullSessionEffect(activity, patientConstants) {
  const durationMs = (activity.duration_minutes ?? 30) * 60_000;
  // Evaluate at the end of the ODE tail so Z ≈ 0 and magnitude is final.
  const tailEndMs  = activity.timestamp + durationMs + 4 * TAU_Z_MS;
  return calculateActivityCumulativeEffect(activity, tailEndMs, patientConstants);
}

/**
 * Calculate the signed W-state activity BG effect at a single chart time point
 * for one session.  This is the teal line ("activityEffect" field) which
 * correctly shows the effect persisting through the post-exercise window.
 *
 * Three phases (mirrors EffectsVisualizationChart.tsx §calculateActivityEffectAtTime):
 *
 *   1. During session (targetMs ≤ endMs):
 *      ODE integral via calculateActivityCumulativeEffect — natural ramp from 0
 *      to fullEffect.  Linear-ramp approximation in the TSX; here we use the
 *      actual ODE (more accurate, especially for short sessions).
 *
 *   2. Post-exercise sensitivity window (endMs < targetMs ≤ endMs + τ_W):
 *      Flat at fullEffect.  ISF/ICR are still altered (W state elevated) but
 *      the acute BG drop has already been delivered — the cumulative value
 *      stays locked in.
 *
 *   3. After sensitivity window (targetMs > endMs + τ_W):
 *      Exponential recovery toward 0 with time constant τ_acute = 15 min.
 *      Mirrors the TSX: W(t) = fullEffect × exp(−(t − end − τ_W) / τ_acute).
 *      The curve effectively reaches 0 after ~3 × τ_acute (≈ 45 min), giving
 *      a steep but smooth drop that signals the end of the recovery window.
 *
 * @param {object} activity          — Normalized activity record
 * @param {number} targetMs          — Chart time point in UTC ms
 * @param {object} patientConstants  — Patient constants
 * @param {number} fullEffect        — Pre-computed terminal BG effect (mg/dL)
 * @returns {number} Signed BG contribution in mg/dL (negative = BG-lowering)
 */
function computeActivityEffectAtTime(activity, targetMs, patientConstants, fullEffect) {
  const startMs    = activity.timestamp;
  if (targetMs < startMs) return 0;

  const durationMs = (activity.duration_minutes ?? 30) * 60_000;
  const endMs      = startMs + durationMs;

  if (targetMs <= endMs) {
    // Phase 1: inside session window — use ODE for accurate ramp shape
    return calculateActivityCumulativeEffect(activity, targetMs, patientConstants);
  }

  if (targetMs <= endMs + TAU_W_MS) {
    // Phase 2: post-exercise sensitivity window — hold flat at peak effect
    return fullEffect;
  }

  // Phase 3: W-state decayed — fast exponential recovery toward 0
  const overMs = targetMs - endMs - TAU_W_MS;
  return fullEffect * Math.exp(-overMs / TAU_ACUTE_MS);
}


// =====================================
// MAIN COMPONENT
// =====================================

const EffectsVisualization = ({
  patientId = null,
  height = 500,
  showControls = true,
  embedded = false,
  onDataUpdate = null,
  defaultView = '12h'
}) => {
  // ===== CONTEXT & HOOKS =====
  const timeContext = useContext(TimeContext);
  const {
    targetGlucose,
    fetchLast24hData,
    activeEffects,
    recentMealsData,
    recentInsulinData,
    adjustedBaselineForProjection,
    handleViewModeChange
  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  // ===== STATE =====
  const [viewMode, setViewMode] = useState(defaultView);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Existing toggles
  const [showMealEffect, setShowMealEffect] = useState(true);
  const [showInsulinEffect, setShowInsulinEffect] = useState(true);
  const [showNetEffect, setShowNetEffect] = useState(true);
  const [showDoseMarkers, setShowDoseMarkers] = useState(true);
  const [showCumulativeBaseline, setShowCumulativeBaseline] = useState(true);

  // Activity toggles (pre-existing)
  const [showActivityEffect, setShowActivityEffect] = useState(true);
  const [showActivityDoseMarker, setShowActivityDoseMarker] = useState(true);

  // ✅ v6.0 P-4: New toggle — session band shading + intensity reference lines.
  // Separate from showActivityDoseMarker (which controls only the magnitude bar)
  // and showActivityEffect (which controls the area and the new teal line).
  const [showActivityMarkers, setShowActivityMarkers] = useState(true);

  // Raw activity records fetched from the backend
  const [rawActivities, setRawActivities] = useState([]);

  const [stickyTooltip, setStickyTooltip] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });

  const chartRef = useRef(null);
  const containerRef = useRef(null);

  // ===== SHARED HOOKS (from ChartUtils) =====
  const currentMinute = useCurrentMinute();
  const timeRange = useChartTimeRange(viewMode, currentMinute);

  // ===== DERIVED VALUES =====
  const effectiveTargetGlucose = targetGlucose || patientConstants?.target_glucose || 100;
  const viewConfig = VIEW_CONFIGS[viewMode];

  // ===== CONTEXT DATA (same as ActiveEffectsDisplay) =====
  const contextMeals = useMemo(() => {
    if (recentMealsData && recentMealsData.length > 0) {
      return recentMealsData;
    }

    if (activeEffects?.mob?.meal_contributions && activeEffects.mob.meal_contributions.length > 0) {
      return activeEffects.mob.meal_contributions.map(contrib => ({
        id: contrib.mealId,
        timestamp: contrib.timestamp || (Date.now() - (contrib.hoursSinceMeal * 3600 * 1000)),
        mealType: contrib.mealType,
        carbEquiv: contrib.carbEquiv,
        nutrition: {
          totalCarbEquiv: contrib.carbEquiv,
          absorptionType: contrib.absorptionType
        }
      }));
    }

    return [];
  }, [recentMealsData, activeEffects?.mob?.meal_contributions, viewMode]);

  const contextInsulin = useMemo(() => {
    if (recentInsulinData && recentInsulinData.length > 0) {
      return recentInsulinData;
    }

    if (activeEffects?.iob?.insulin_contributions && activeEffects.iob.insulin_contributions.length > 0) {
      const now = Date.now();
      return activeEffects.iob.insulin_contributions.map(contrib => ({
        id: `${contrib.insulinType}-${contrib.hoursSinceDose}`,
        administrationTime: now - (contrib.hoursSinceDose * 3600 * 1000),
        dose: contrib.dose,
        medication: contrib.insulinType,
        insulinType: contrib.insulinType
      }));
    }

    return [];
  }, [activeEffects, recentInsulinData]);

  // ===== MEMOIZED PROCESSING (via ChartUtils) =====
  const processedMeals = useMemo(() => {
    return processContextMealsForChart(contextMeals, timeRange, patientConstants);
  }, [contextMeals, timeRange.start, timeRange.end, patientConstants?.protein_factor, patientConstants?.fat_factor]);

  const processedInsulin = useMemo(() => {
    return processContextInsulinForChart(contextInsulin, timeRange);
  }, [contextInsulin, timeRange.start, timeRange.end]);

  // ===== FETCH ACTIVITY HISTORY =====
  const fetchActivities = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;

      const lookbackHours = Math.max(viewConfig.mealLookback || 24, 8);

      const response = await axios.get(`${API_BASE_URL}/api/activity-history`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 200, lookback_hours: lookbackHours },
      });

      if (response.data && Array.isArray(response.data)) {
        const normalized = response.data
          .map(normalizeActivityRecord)
          .filter(Boolean);

        if (DEBUG_MODE) {
          console.log(`[EffectsViz v6.0] fetched ${response.data.length} raw → ${normalized.length} normalized activities`);
        }

        setRawActivities(normalized);
      }
    } catch (err) {
      console.warn('[EffectsViz v6.0] activity-history fetch failed (non-fatal):', err.message);
    }
  }, [viewConfig.mealLookback]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  // ===== FILTER VISIBLE ACTIVITIES =====
  const visibleActivities = useMemo(() => {
    return rawActivities.filter(act => {
      const startMs = act.timestamp;
      const endMs   = startMs + (act.duration_minutes || 30) * 60_000 + ACTIVITY_TAIL_MS;
      return endMs >= timeRange.start && startMs <= timeRange.end;
    });
  }, [rawActivities, timeRange.start, timeRange.end]);

  // ✅ v6.0 P-2: Session bands — one per visible activity, spanning
  // [startMs … startMs + duration + τ_W].  τ_W (not τ_Z) defines the
  // influence window because the W state (post-exercise sensitivity) is
  // what we want to communicate to the reader.
  const sessionBands = useMemo(() => {
    return visibleActivities
      .map(act => ({
        startMs:   act.timestamp,
        // Band extends through the full sensitivity window, not just the ODE tail.
        endMs:     act.timestamp + (act.duration_minutes ?? 30) * 60_000 + TAU_W_MS,
        intensity: act.intensity ?? 'moderate',
      }))
      .filter(b => b.endMs >= timeRange.start && b.startMs <= timeRange.end);
  }, [visibleActivities, timeRange.start, timeRange.end]);

  // ✅ v6.0 P-3: Session markers — one ReferenceLine per session that starts
  // within the visible time range.
  const sessionMarkers = useMemo(() => {
    return visibleActivities
      .filter(act => act.timestamp >= timeRange.start && act.timestamp <= timeRange.end)
      .map(act => ({
        startMs:   act.timestamp,
        intensity: act.intensity ?? 'moderate',
        label:     INTENSITY_LABELS[act.intensity] ?? 'M',
      }));
  }, [visibleActivities, timeRange.start, timeRange.end]);

  // ===== GENERATE CHART DATA =====
  const generateChartData = useCallback(async () => {
    if (!patientConstants) return [];

    if (DEBUG_MODE) {
      console.log('🚀 Generating effects chart data (v6.0):', {
        meals: processedMeals.length,
        insulin: processedInsulin.length,
        activities: visibleActivities.length,
      });
    }

    const { start, end, now } = timeRange;
    const intervalMs = viewConfig.interpolationInterval * 60 * 1000;

    // ── Build base time-point list ─────────────────────────────────────────────
    const baseTimePoints = [];
    for (let time = start; time <= end; time += intervalMs) {
      const normalizedTime = TimeManager.normalize(time, TimeManager.precision.MINUTE);
      if (baseTimePoints.length === 0 || baseTimePoints[baseTimePoints.length - 1] !== normalizedTime) {
        baseTimePoints.push(normalizedTime);
      }
    }

    // ── Inject activity start/end anchors ──────────────────────────────────────
    const timePointSet = new Set(baseTimePoints);
    visibleActivities.forEach(act => {
      const s   = act.timestamp;
      const dur = (act.duration_minutes || 30) * 60_000;
      const e   = s + dur;
      if (s > start && s < end) {
        if (s - 1 > start) timePointSet.add(s - 1);
        timePointSet.add(s);
      }
      if (e > start && e < end) {
        timePointSet.add(e);
      }
      // ✅ v6.0 P-1: Also inject a point at the τ_W boundary so the plateau →
      // decay transition has a precise anchor pixel on the teal line.
      const wEnd = e + TAU_W_MS;
      if (wEnd > start && wEnd < end) {
        timePointSet.add(wEnd);
      }
    });
    const timePoints = [...timePointSet].sort((a, b) => a - b);

    // ── Per-tick activity state constants ─────────────────────────────────────
    const resetHour = patientConstants?.daily_reset_hour ?? 7;
    const tzOffset  = patientConstants?.timezone_offset_minutes ?? null;

    // ✅ v6.0 P-1: Pre-compute each activity's terminal BG effect ONCE.
    // This avoids running the ODE at tail-end time for every chart time point.
    // Shape: [fullEffect_activity0, fullEffect_activity1, …]
    const activityFullEffects = visibleActivities.map(act =>
      getFullSessionEffect(act, patientConstants)
    );

    // ── Compute activity values synchronously for every time point ─────────────
    const activityDataPerPoint = timePoints.map(time => {
      const isAtReset      = TimeManager.isAtResetTime(time, resetHour, tzOffset);
      const dailyResetTime = TimeManager.getDailyResetTime(time, resetHour, tzOffset);

      let totalDeliveredDrop = 0;
      let totalAOB           = 0;
      let totalActiveRate    = 0;
      const contributions    = [];
      const sessionsAtTime   = [];

      if (!isAtReset) {
        visibleActivities.forEach(activity => {
          const startMs = activity.timestamp;

          const isWithinCurrentDay = TimeManager.isWithinCurrentDay(
            startMs, time, resetHour, tzOffset
          );

          const signedEffect = calculateActivityCumulativeEffect(activity, time, patientConstants);
          const deliveredMag = Math.abs(signedEffect);

          const aobResult = getActivityOnBoard(activity, time, patientConstants);
          const {
            remaining_bg_drop,
            absorbed_fraction,
            minutes_elapsed,
            is_active,
            intensity,
          } = aobResult;

          const durationMin = activity.duration_minutes || 30;
          const endMs       = startMs + durationMin * 60_000;

          const aobAtStart = (time >= startMs && time < endMs)
            ? getActivityOnBoard(activity, startMs, patientConstants)
            : null;

          if (isWithinCurrentDay) {
            totalDeliveredDrop += deliveredMag;
          }

          if (time >= startMs) {
            if (time < endMs) {
              totalAOB += aobAtStart.remaining_bg_drop;
            } else {
              totalAOB += remaining_bg_drop;
            }
          }

          if (isWithinCurrentDay) {
            const prevTime        = Math.max(time - intervalMs, dailyResetTime);
            const deliveredAtPrev = Math.abs(
              calculateActivityCumulativeEffect(activity, prevTime, patientConstants)
            );
            const rateContrib = Math.max(0, deliveredMag - deliveredAtPrev);
            totalActiveRate += rateContrib;
          }

          const aobForTooltip = (time >= startMs && time < endMs)
            ? aobAtStart.remaining_bg_drop
            : remaining_bg_drop;

          if (minutes_elapsed >= 0 && minutes_elapsed < durationMin + 60 * 8) {
            contributions.push({
              activityId:       activity._id || String(startMs),
              intensity,
              durationMinutes:  durationMin,
              minutesElapsed:   minutes_elapsed,
              deliveredDrop:    Math.round(deliveredMag * 10) / 10,
              aob:              aobForTooltip,
              absorbedFraction: absorbed_fraction,
              isActive:         is_active,
              phase:            getActivityPhase(minutes_elapsed, durationMin),
              isWithinCurrentDay,
              bgDirection:      activity.bg_direction ?? -1,
              hasWearableHr:    !!(activity.hr_trace && activity.hr_trace.length > 0),
            });
          }

          if (startMs === time) {
            sessionsAtTime.push({ ...activity, durationMinutes: durationMin, intensity });
          }
        });
      }

      const activityDoseMarker = sessionsAtTime.length > 0
        ? (() => {
            let total = 0;
            for (const act of sessionsAtTime) {
              const aob = getActivityOnBoard(act, act.timestamp, patientConstants);
              total += aob.remaining_bg_drop;
            }
            return total > 0 ? total : null;
          })()
        : null;

      const sensitivityMult = calculateActivitySensitivityMultiplier(
        visibleActivities, time, patientConstants
      );

      return {
        totalDeliveredDrop,
        totalAOB,
        totalActiveRate,
        contributions,
        sessionsAtTime,
        activityDoseMarker,
        sensitivityMult,
        dailyResetTime,
      };
    });

    // ── Build calculateNetEffectAtTime promises — now with activityPD ──────────
    const netEffectPromises = timePoints.map((time, i) => {
      const ad = activityDataPerPoint[i];

      const activityPD = {
        cumulative_activity_effect: -ad.totalDeliveredDrop,
        sensitivity_multiplier:     ad.sensitivityMult,
        activity_on_board:          ad.totalAOB,
        activity_contributions:     ad.contributions,
      };

      return calculateNetEffectAtTime(
        processedMeals,
        processedInsulin,
        time,
        patientConstants,
        { t1dDuration: patientConstants.t1d_duration_years || 5, activityPD }
      );
    });

    const netEffectResults = await Promise.all(netEffectPromises);
    const halfInterval = intervalMs / 2;

    const timeline = timePoints.map((time, index) => {
      const isHistorical = time <= now;
      const isFuture = time > now;
      const isNow = Math.abs(time - now) < halfInterval;

      const netEffectData = netEffectResults[index];
      const ad            = activityDataPerPoint[index];

      const mealsAtTime   = findMealsAtTime(processedMeals, time, halfInterval);
      const insulinAtTime = findInsulinAtTime(processedInsulin, time, halfInterval);

      const totalCarbsAtTime   = mealsAtTime.reduce((sum, m) => sum + m.carbEquiv, 0);
      const totalInsulinAtTime = insulinAtTime.reduce((sum, d) => sum + d.dose, 0);

      const mealDoseMarkerValue   = totalCarbsAtTime   > 0 ? totalCarbsAtTime            : null;
      const insulinDoseMarkerValue = totalInsulinAtTime > 0 ? -(totalInsulinAtTime * 5)   : null;

      // ── v5.2: Bounded activity impact (cyan deliveredDrop area) ───────────────
      const hasActiveActivityWindow = visibleActivities.some(act => {
        const tailEndMs = act.timestamp
          + (act.duration_minutes || 30) * 60_000
          + 4 * TAU_Z_MS;
        return time >= act.timestamp && time <= tailEndMs;
      });

      const activityImpact = hasActiveActivityWindow
        ? (ad.totalDeliveredDrop > 0 ? -ad.totalDeliveredDrop : 0)
        : null;

      const activityActiveRate = ad.totalActiveRate > 0 ? -ad.totalActiveRate : 0;

      // ✅ v6.0 P-1: W-state teal line — plateau + exponential decay.
      //
      // Summed across all visible activities within the current daily reset window.
      // Uses the pre-computed `activityFullEffects[actIdx]` terminal values to
      // avoid re-running the ODE for the plateau/decay phases.
      //
      // Returns null when the sum is negligible (|effect| < 0.05 mg/dL) so that
      // Recharts <Line connectNulls={false}> draws a gap instead of a line hugging
      // the zero axis — consistent with activityImpact null behaviour outside the
      // ODE window.
      const activityEffectRaw = visibleActivities.reduce((sum, act, actIdx) => {
        // Skip sessions that belong to a previous daily reset period
        if (act.timestamp < ad.dailyResetTime) return sum;
        return sum + computeActivityEffectAtTime(
          act, time, patientConstants, activityFullEffects[actIdx]
        );
      }, 0);

      const activityEffect = Math.abs(activityEffectRaw) >= 0.05 ? activityEffectRaw : null;

      return {
        timestamp: time,
        formattedTime: TimeManager.formatDate(
          new Date(time),
          viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
        ),
        timestampPrecision: 'MINUTE',

        mealImpact: netEffectData.mealImpact || 0,
        currentAbsorbedCarbs: netEffectData.totalAbsorbedCarbs || 0,
        activeCarbs: netEffectData.totalActiveCarbs || 0,
        pendingMealRise: netEffectData.pendingMealRise || 0,

        insulinImpact: -Math.abs(netEffectData.insulinImpact || 0),
        insulinImpactAbs: Math.abs(netEffectData.insulinImpact || 0),
        currentAbsorbedInsulin: netEffectData.totalAbsorbedInsulin || 0,
        activeInsulin: netEffectData.totalActiveInsulin || 0,
        pendingInsulinReduction: netEffectData.pendingInsulinReduction || 0,

        netEffect: netEffectData.netEffect || 0,

        cumulativeMealEffect:     netEffectData.cumulativeMealEffect    || 0,
        cumulativeInsulinEffect:  netEffectData.cumulativeInsulinEffect || 0,
        cumulativeNetBaseline:    netEffectData.cumulativeNetBaseline   || 0,

        // ── Activity fields ──────────────────────────────────────────────────
        // v5.2 bounded area: deliveredDrop (null outside ODE window)
        activityImpact,
        // v6.0 W-state line: ramp → flat plateau (τ_W) → exp decay (null when negligible)
        activityEffect,
        // v6.0 AOB shading: W-state curve clipped to ≤0 (mirrors TSX activityAOBShadeData).
        // Only fills the negative (BG-lowering) portion between the curve and zero.
        // Null when activityEffect is null so Recharts draws a gap (connectNulls=false).
        activityAOBShade: activityEffect !== null ? Math.min(0, activityEffect) : null,
        // Instantaneous rate (tooltip only)
        activityActiveRate,
        // Remaining acute drop
        activityAOB: Math.round(ad.totalAOB * 10) / 10,
        // Post-exercise ISF/CR sensitivity boost as % above baseline (null when no boost)
        sensitivityBoostPct: (() => {
          const pct = Math.round((ad.sensitivityMult - 1) * 100 * 10) / 10;
          return pct > 0 ? pct : null;
        })(),
        // v5.3: negated so the bar extends downward on the effects axis
        activityDoseMarker:    ad.activityDoseMarker != null ? -ad.activityDoseMarker : null,
        activityDoseMarkerAbs: ad.activityDoseMarker ?? 0,
        activityContributions:    ad.contributions,
        cumulativeActivityEffect: netEffectData.cumulativeActivityEffect || 0,

        mealDoseMarker: mealDoseMarkerValue,
        insulinDoseMarker: insulinDoseMarkerValue,

        mealsAdministered: mealsAtTime,
        insulinAdministered: insulinAtTime,

        mealContributions: netEffectData.mobDetails?.mob?.meal_contributions || [],
        insulinContributions: netEffectData.iobDetails?.insulin_contributions || [],

        mealCumulativeContributions: netEffectData.mealCumulativeContributions || [],
        insulinCumulativeContributions: netEffectData.insulinCumulativeContributions || [],

        isHistorical,
        isFuture,
        isNow
      };
    });

    if (DEBUG_MODE) {
      console.log(`✅ Generated ${timeline.length} chart points (v6.0 with W-state teal line)`);
    }

    return timeline;
  }, [
    patientConstants,
    processedMeals,
    processedInsulin,
    timeRange,
    viewConfig,
    adjustedBaselineForProjection,
    visibleActivities,
  ]);

  // ===== EFFECTS =====

  useEffect(() => {
    const hasAnyData =
      contextMeals.length > 0 ||
      contextInsulin.length > 0 ||
      visibleActivities.length > 0;

    if (patientConstants && hasAnyData) {
      const timeoutId = setTimeout(() => {
        generateChartData().then(data => {
          setChartData(data);
          setLoading(false);

          if (onDataUpdate) {
            onDataUpdate(data);
          }
        }).catch(error => {
          console.error('Error generating chart data:', error);
          setError('Failed to generate chart data');
          setLoading(false);
        });
      }, 200);

      return () => clearTimeout(timeoutId);
    } else if (patientConstants && !hasAnyData) {
      setChartData([]);
      setLoading(false);
    }
  }, [generateChartData, patientConstants, onDataUpdate,
      contextMeals.length, contextInsulin.length, visibleActivities.length]);

  // ===== HANDLERS =====

  const handleRefresh = useCallback(() => {
    setLoading(true);
    if (fetchLast24hData) {
      fetchLast24hData();
    }
    fetchActivities();
    setTimeout(() => setLoading(false), 1000);
  }, [fetchLast24hData, fetchActivities]);

  const handleChartClick = (data) => {
    if (data && data.activePayload && data.activePayload.length) {
      setStickyTooltip(data.activePayload[0].payload);
      setTooltipPosition({
        left: data.chartX,
        top: data.chartY - 10
      });
    }
  };

  const handleCloseTooltip = () => {
    setStickyTooltip(null);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const formatXAxisLabel = useMemo(() => createXAxisFormatter(viewConfig), [viewConfig]);
  const ticks = useMemo(() => generateXAxisTicks(timeRange, viewConfig), [timeRange, viewConfig]);

  const dynamicBarSize = useMemo(() => {
    return calculateDynamicBarSize(
      chartRef.current?.offsetWidth,
      chartData.length
    );
  }, [chartData.length]);

  const effectsAxisDomain = useMemo(() => {
    return calculateEffectsAxisDomain(chartData, { includeCumulative: true });
  }, [chartData]);

 const doseAxisDomain = useMemo(() => {
  const base = calculateDoseAxisDomain(chartData);   // e.g. [0, 120]
  const maxMag = Math.max(Math.abs(base[0]), Math.abs(base[1]));
  return [-maxMag, maxMag];   // symmetric: insulin bars can go negative
}, [chartData]);

  const effectsTicks = useMemo(() => {
    return generateSymmetricTicks(effectsAxisDomain, {
      intervals: [10, 20, 50, 100, 200]
    });
  }, [effectsAxisDomain]);

  const doseTicks = useMemo(() => {
    return generateSymmetricTicks(doseAxisDomain, {
      intervals: [5, 10, 20, 50]
    });
  }, [doseAxisDomain]);

  // ===== CUSTOM TOOLTIP =====
  const CustomTooltipContent = ({ active, payload }) => {
    const data = stickyTooltip || (active && payload && payload.length ? payload[0].payload : null);

    if (!data) return null;

    const hasMealDose    = data.mealsAdministered   && data.mealsAdministered.length   > 0;
    const hasInsulinDose = data.insulinAdministered && data.insulinAdministered.length > 0;
    const hasActivity = data.activityContributions &&
                        data.activityContributions.length > 0 &&
                        (Math.abs(data.activityImpact ?? 0) > 0.1 || data.activityAOB > 0.1);

    const baseline = adjustedBaselineForProjection?.baselineValue || effectiveTargetGlucose;
    const currentBGFromCumulative = baseline + data.cumulativeNetBaseline;

    return (
      <div className="bg-visualization-tooltip">
        {stickyTooltip && (
          <button onClick={handleCloseTooltip} aria-label="Close tooltip">✕</button>
        )}

        <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '13px' }}>
          {data.formattedTime}
          {data.isNow && <span style={{ marginLeft: '8px', color: '#ff0000', fontSize: '12px' }}>🔴 Now</span>}
        </div>

        {data.isNow && (
          <div style={{
            backgroundColor: '#f0f9ff',
            padding: '8px',
            borderRadius: '4px',
            marginBottom: '8px',
            border: '2px solid #2196F3'
          }}>
            <div style={{ fontWeight: '600', marginBottom: '4px', color: '#1565c0', fontSize: '12px' }}>
              📊 Current Blood Sugar Estimate:
            </div>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#1976d2' }}>
              {Math.round(currentBGFromCumulative)} mg/dL
            </div>
            <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
              Baseline {baseline} + Cumulative {data.cumulativeNetBaseline > 0 ? '+' : ''}{Math.round(data.cumulativeNetBaseline)}
            </div>
          </div>
        )}

        {(hasMealDose || hasInsulinDose) && (
          <div style={{
            backgroundColor: '#e3f2fd',
            padding: '8px',
            borderRadius: '4px',
            marginTop: '8px',
            marginBottom: '8px',
            border: '2px solid #2196F3'
          }}>
            <div style={{ fontWeight: '600', marginBottom: '6px', color: '#1976d2', fontSize: '12px' }}>
              💊 Doses Administered:
            </div>

            {hasMealDose && (
              <div style={{ marginBottom: '6px' }}>
                <div style={{ fontWeight: '600', color: '#ff9800', fontSize: '11px' }}>
                  🍽️ Meals ({data.mealsAdministered.length}):
                </div>
                {data.mealsAdministered.map((meal, idx) => (
                  <div key={idx} style={{ fontSize: '10px', paddingLeft: '12px', marginTop: '2px' }}>
                    • {meal.mealType}: {(meal.carbEquiv ?? 0).toFixed(1)}g carbs
                    {meal.foodItems && meal.foodItems.length > 0 && (
                      <div style={{ fontSize: '9px', color: '#666', paddingLeft: '8px' }}>
                        ({meal.foodItems.slice(0, 2).map(f => f.name).join(', ')}
                        {meal.foodItems.length > 2 && ` +${meal.foodItems.length - 2} more`})
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {hasInsulinDose && (
              <div>
                <div style={{ fontWeight: '600', color: '#9c27b0', fontSize: '11px' }}>
                  💉 Insulin ({data.insulinAdministered.length}):
                </div>
                {data.insulinAdministered.map((dose, idx) => (
                  <div key={idx} style={{ fontSize: '10px', paddingLeft: '12px', marginTop: '2px' }}>
                    • {dose.medication}: {(dose.dose ?? 0).toFixed(1)}u
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(data.mealImpact > 0.1 || Math.abs(data.insulinImpactAbs) > 0.1 || Math.abs(data.activityImpact ?? 0) > 0.1 || data.sensitivityBoostPct != null) && (
          <div style={{
            backgroundColor: '#fff9e6',
            padding: '8px',
            borderRadius: '4px',
            marginTop: '8px',
            marginBottom: '8px'
          }}>
            <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '12px', color: '#e65100' }}>
              ⚡ Current Activity (Rate of Change):
            </div>

            {data.mealImpact > 0.1 && (
              <div style={{ marginTop: '6px', fontSize: '12px' }}>
                🍽️ Meal: <span style={{ color: '#ff9800', fontWeight: '600' }}>+{Math.round(data.mealImpact)} mg/dL</span>
                <span style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>
                  - Absorbed: {data.currentAbsorbedCarbs?.toFixed(1) || '0.0'}g
                  {data.activeCarbs > 0.1 && (
                    <> | MOB: {data.activeCarbs?.toFixed(1) || '0.0'}g</>
                  )}
                </span>
              </div>
            )}

            {Math.abs(data.insulinImpactAbs) > 0.1 && (
              <div style={{ marginTop: '6px', fontSize: '12px' }}>
                💉 Insulin: <span style={{ color: '#9c27b0', fontWeight: '600' }}>-{Math.round(data.insulinImpactAbs)} mg/dL</span>
                <span style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>
                  - Absorbed: {data.currentAbsorbedInsulin?.toFixed(2) || '0.00'}u
                  {data.activeInsulin > 0.01 && (
                    <> | IOB: {data.activeInsulin?.toFixed(2) || '0.00'}u</>
                  )}
                </span>
              </div>
            )}

            {hasActivity && (
              <div style={{ marginTop: '6px', fontSize: '12px' }}>
                🏃 Activity: <span style={{ color: '#00838F', fontWeight: '600' }}>{Math.round(data.cumulativeActivityEffect)} mg/dL</span>
                <span style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>
                  delivered
                  {data.activityAOB > 0.1 && (
                    <> | AOB: {data.activityAOB.toFixed(1)} mg/dL remaining</>
                  )}
                </span>
              </div>
            )}

            {/* ✅ v6.0 P-1: W-state line value in tooltip — shows the plateau + decay
                phase magnitude so the reader understands the teal line's current value. */}
            {data.activityEffect != null && Math.abs(data.activityEffect) > 0.1 && (
              <div style={{ marginTop: '4px', fontSize: '11px', color: '#00ACC1' }}>
                〰️ W-state effect: {Math.round(data.activityEffect * 10) / 10} mg/dL
                <span style={{ fontSize: '10px', color: '#888', marginLeft: '6px' }}>
                  (incl. {data.sensitivityBoostPct != null
                    ? `+${data.sensitivityBoostPct}% sensitivity window`
                    : 'sensitivity window'})
                </span>
              </div>
            )}

            {data.sensitivityBoostPct != null && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: '#00838F' }}>
                📈 Post-exercise sensitivity boost: +{data.sensitivityBoostPct}%
              </div>
            )}

            <div style={{
              marginTop: '6px',
              paddingTop: '6px',
              borderTop: '1px solid #e0e0e0',
              fontSize: '12px'
            }}>
              <span style={{ fontWeight: '600' }}>Current Net Effect:</span>
              <span style={{
                color: data.netEffect > 0 ? '#ff9800' : data.netEffect < 0 ? '#4caf50' : '#666',
                fontWeight: '700',
                marginLeft: '8px'
              }}>
                {data.netEffect > 0 ? '+' : ''}{Math.round(data.netEffect)} mg/dL
              </span>
            </div>
          </div>
        )}

        <div style={{
          backgroundColor: '#e8f5e9',
          padding: '8px',
          borderRadius: '4px',
          marginTop: '8px',
          border: '2px solid #4CAF50'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '12px', color: '#2e7d32' }}>
            Cumulative Baseline Shift (Bank Balance):
          </div>

          {Math.abs(data.cumulativeMealEffect) > 0.1 && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: '#666' }}>
              🍽️ Meal accumulated:
              <span style={{ color: '#ff9800', fontWeight: '600', marginLeft: '6px' }}>
                +{Math.round(data.cumulativeMealEffect)} mg/dL
              </span>
            </div>
          )}

          {Math.abs(data.cumulativeInsulinEffect) > 0.1 && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: '#666' }}>
              💉 Insulin accumulated:
              <span style={{ color: '#9c27b0', fontWeight: '600', marginLeft: '6px' }}>
                {Math.round(data.cumulativeInsulinEffect)} mg/dL
              </span>
            </div>
          )}

          {Math.abs(data.cumulativeActivityEffect) > 0.1 && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: '#666' }}>
              🏃 Activity delivered:
              <span style={{ color: '#00838F', fontWeight: '600', marginLeft: '6px' }}>
                {Math.round(data.cumulativeActivityEffect)} mg/dL
              </span>
            </div>
          )}

          <div style={{
            marginTop: '8px',
            paddingTop: '8px',
            borderTop: '2px solid #4CAF50',
            fontSize: '12px'
          }}>
            <span style={{ fontWeight: '600' }}>Net Baseline Shift:</span>
            <span style={{
              color: data.cumulativeNetBaseline > 0 ? '#ff6b00' : data.cumulativeNetBaseline < 0 ? '#2e7d32' : '#666',
              fontWeight: '700',
              marginLeft: '8px',
              fontSize: '14px'
            }}>
              {data.cumulativeNetBaseline > 0 ? '+' : ''}{Math.round(data.cumulativeNetBaseline)} mg/dL
            </span>
          </div>

          <div style={{ fontSize: '10px', color: '#555', marginTop: '6px', fontStyle: 'italic' }}>
            This is where you are relative to baseline
            {data.cumulativeNetBaseline > 0 ? ' (above ⬆️)' : data.cumulativeNetBaseline < 0 ? ' (below ⬇️)' : ' (at baseline ➡️)'}
          </div>
        </div>

        <div style={{
          marginTop: '8px',
          fontSize: '11px',
          color: '#666',
          textAlign: 'center'
        }}>
          {data.isHistorical ? '📊 Historical' : '🔮 Projected'}
        </div>
      </div>
    );
  };

  // ===== RENDER =====

  if (loading && chartData.length === 0) {
    return (
      <div className="bg-visualization-loading" style={{ height }}>
        <FaSync className="spin" />
        Loading effects data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-visualization-error" style={{ height }}>
        {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`bg-visualization-container ${embedded ? 'embedded' : ''} ${isFullscreen ? 'fullscreen' : ''}`}
    >
      {/* Header */}
      {showControls && (
        <div className="bg-visualization-header">
          <div>
            <h3>Insulin, Meal, Activity &amp; Net Effects Visualization</h3>
            <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              🔥 v6.0 • W-state plateau/decay line • Session band shading • Intensity markers
            </p>
          </div>

          <div>
            <div className="view-mode-toggle">
              {Object.entries(VIEW_CONFIGS).map(([key, config]) => (
                <button
                  key={key}
                  onClick={async () => {
                    if (key === viewMode) return;
                    setLoading(true);
                    setViewMode(key);
                    if (handleViewModeChange) {
                      await handleViewModeChange(key);
                    }
                    setTimeout(() => setLoading(false), 500);
                  }}
                  className={viewMode === key ? 'active' : ''}
                  disabled={loading}
                >
                  {config.label}
                </button>
              ))}
            </div>

            <button
              onClick={handleRefresh}
              disabled={loading}
              className="bg-action-button"
              title="Refresh data"
            >
              <FaSync className={loading ? 'spin' : ''} />
            </button>

            <button
              onClick={toggleFullscreen}
              className="bg-action-button"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <FaCompress /> : <FaExpand />}
            </button>
          </div>
        </div>
      )}

      {/* ===== Toggle Controls ===== */}
      {showControls && (
        <div className="toggle-controls" style={{ marginTop: '8px', marginBottom: '8px' }}>
          {/* ── Meal / Insulin / Net ── */}
          <label>
            <input
              type="checkbox"
              checked={showMealEffect}
              onChange={() => setShowMealEffect(!showMealEffect)}
            />
            Meal Effect
          </label>
          <label>
            <input
              type="checkbox"
              checked={showInsulinEffect}
              onChange={() => setShowInsulinEffect(!showInsulinEffect)}
            />
            Insulin Effect
          </label>
          <label>
            <input
              type="checkbox"
              checked={showNetEffect}
              onChange={() => setShowNetEffect(!showNetEffect)}
            />
            Net Effect (Current)
          </label>
          <label style={{ fontWeight: '600', color: '#4CAF50' }}>
            <input
              type="checkbox"
              checked={showCumulativeBaseline}
              onChange={() => setShowCumulativeBaseline(!showCumulativeBaseline)}
            />
            Cumulative Baseline ⭐
          </label>

          {/* ── Dose markers ── */}
          <label>
            <input
              type="checkbox"
              checked={showDoseMarkers}
              onChange={() => setShowDoseMarkers(!showDoseMarkers)}
            />
            Dose Markers
          </label>

          {/* ── Activity controls ── */}
          <label style={{ color: '#00838F' }}>
            <input
              type="checkbox"
              checked={showActivityEffect}
              onChange={() => setShowActivityEffect(!showActivityEffect)}
            />
            🏃 Activity Effect
          </label>



          {/* ✅ v6.0 P-4: New toggle — band shading + intensity reference lines (P-2/P-3) */}
          <label style={{ color: '#00ACC1' }}>
            <input
              type="checkbox"
              checked={showActivityMarkers}
              onChange={() => setShowActivityMarkers(!showActivityMarkers)}
            />
            🏃 Session Markers
          </label>
        </div>
      )}

      {/* ===== Chart ===== */}
      <div ref={chartRef} className="chart-container">
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={chartData}
            margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
            onClick={handleChartClick}
          >
            <defs>
              <linearGradient id="mealEffectGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff9800" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#ff9800" stopOpacity={0.1} />
              </linearGradient>

              <linearGradient id="insulinEffectGradient" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#9c27b0" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#9c27b0" stopOpacity={0.1} />
              </linearGradient>

              {/* v6.0: Activity AOB shading — uniform flat fill matching TSX (#29B6F6, 0.22 opacity).
                  Fills between the W-state curve and zero baseline. Gradient direction is
                  top→bottom (more opaque near zero, transparent at curve trough) so the
                  visual weight sits at the baseline, not at the deepest point of the drop. */}
              <linearGradient id="activityEffectGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#29B6F6" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#29B6F6" stopOpacity={0.10} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />

            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={[timeRange.start, timeRange.end]}
              ticks={ticks}
              tickFormatter={formatXAxisLabel}
              angle={-45}
              textAnchor="end"
              height={70}
              stroke="#666"
              fontSize={11}
            />

            <YAxis
              yAxisId="effects"
              domain={effectsAxisDomain}
              ticks={effectsTicks}
              tickFormatter={(value) => `${Math.round(value)}`}
              label={{
                value: 'Effect (mg/dL)',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: '12px', fill: '#666' }
              }}
              stroke="#666"
              fontSize={11}
            />

            <YAxis
              yAxisId="doses"
              orientation="right"
              domain={doseAxisDomain}
              ticks={doseTicks}
              tickFormatter={(value) => Math.abs(value).toFixed(0)}
              label={{
                value: 'Dose Amount (carbs g / insulin u×5)',
                angle: 90,
                position: 'insideRight',
                style: { fontSize: '12px', fill: '#666' }
              }}
              stroke="#666"
              fontSize={11}
            />

            <Tooltip content={<CustomTooltipContent />} />

            <Legend
              verticalAlign="top"
              height={36}
              wrapperStyle={{ paddingBottom: '10px' }}
              formatter={(value) => {
                const labels = {
                  'mealImpact':           '🍽️ Meal Effect (current activity)',
                  'insulinImpact':        '💉 Insulin Effect (current activity)',
                  'activityAOBShade':     '🏃 Activity Effect — AOB shading (area)',
                  'activityEffect':       '   Activity Effect',
                  'netEffect':            '📊 Net Effect (current rate)',
                  'cumulativeNetBaseline':'📈 Cumulative Baseline ',
                  'mealDoseMarker':       '🍽️ Meal Doses',
                  'insulinDoseMarker':    '💉 Insulin Doses (×5)',
                  'activityDoseMarker':   '🏃 Activity Sessions (expected BG drop, mg/dL)',
                };
                return labels[value] || value;
              }}
            />

            {/* ── Zero baseline ── */}
            <ReferenceLine
              yAxisId="effects"
              y={0}
              stroke="#999"
              strokeWidth={2}
              strokeDasharray="3 3"
              label={{
                value: 'Zero',
                position: 'right',
                fill: '#999',
                fontSize: 10
              }}
            />

            {/* ── Now marker ── */}
            <ReferenceLine
              yAxisId="effects"
              x={timeRange.now}
              stroke="#ff0000"
              strokeWidth={2}
              label={{
                value: 'Now',
                position: 'top',
                fill: '#ff0000',
                fontSize: 11
              }}
            />

            {/* ✅ v6.1: Short dashed vertical segment at each session start time,
                running from y=0 downward to 38% of the effects-axis minimum —
                mirrors the TSX VictoryLine marker (y:0 → yDomain[0]*0.38).
                Uses ReferenceLine segment prop so the line is confined to the
                lower portion of the chart and never obscures the data curves. */}
            {showActivityMarkers && sessionMarkers.map((marker, i) => (
              <ReferenceLine
                key={`session-marker-${i}`}
                yAxisId="effects"
                segment={[
                  { x: marker.startMs, y: 0 },
                  { x: marker.startMs, y: effectsAxisDomain[0] * 0.38 },
                ]}
                stroke="#26C6DA"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                ifOverflow="hidden"
              />
            ))}

            {/* ── Dose bars (meal + insulin on doses axis) ── */}
            {showDoseMarkers && (
              <Bar
                yAxisId="doses"
                dataKey="mealDoseMarker"
                fill="#ff9800"
                fillOpacity={0.8}
                barSize={dynamicBarSize}
                isAnimationActive={false}
                name="mealDoseMarker"
              />
            )}
            {showDoseMarkers && (
              <Bar
                yAxisId="doses"
                dataKey="insulinDoseMarker"
                fill="#9c27b0"
                fillOpacity={0.8}
                barSize={dynamicBarSize}
                isAnimationActive={false}
                name="insulinDoseMarker"
              />
            )}

            {/* v5.3: Activity dose magnitude bar on the effects axis (mg/dL, negated). */}
            {showActivityDoseMarker && (
              <Bar
                yAxisId="effects"
                dataKey="activityDoseMarker"
                fill="#00BCD4"
                fillOpacity={0.8}
                barSize={dynamicBarSize}
                minPointSize={5}
                isAnimationActive={false}
                name="activityDoseMarker"
              />
            )}

            {/* ── Meal and insulin effect areas ── */}
            {showMealEffect && (
              <Area
                yAxisId="effects"
                type="monotone"
                dataKey="mealImpact"
                name="mealImpact"
                stroke="#ff9800"
                strokeWidth={2}
                fill="url(#mealEffectGradient)"
                isAnimationActive={false}
              />
            )}

            {showInsulinEffect && (
              <Area
                yAxisId="effects"
                type="monotone"
                dataKey="insulinImpact"
                name="insulinImpact"
                stroke="#9c27b0"
                strokeWidth={2}
                fill="url(#insulinEffectGradient)"
                isAnimationActive={false}
              />
            )}

            {/* v6.0: Activity AOB shading — W-state curve clipped to ≤0, filling between
                the curve and zero (mirrors TSX activityAOBShadeData + y0={() => 0}).
                Uses activityAOBShade (= Math.min(0, activityEffect)) so only the
                BG-lowering portion is shaded. connectNulls={false} preserves gaps
                when there is no activity in view, matching TSX behaviour. */}
            {showActivityEffect && (
              <Area
                yAxisId="effects"
                type="monotone"
                dataKey="activityAOBShade"
                name="activityAOBShade"
                stroke="none"
                strokeWidth={0}
                fill="url(#activityEffectGradient)"
                isAnimationActive={false}
                connectNulls={false}
                legendType="none"
              />
            )}

            {/* ✅ v6.0 P-1: W-state teal line — ramp during session, flat plateau for
                τ_W (90 min), then fast exponential decay (τ_acute = 15 min).
                connectNulls={false} so the line disappears when activityEffect is null
                (i.e. before the first session of the day and long after the last one),
                keeping the zero baseline free of a persistent flat line.
                Dashed style distinguishes it from the solid deliveredDrop area above. */}
            {showActivityEffect && (
              <Line
                yAxisId="effects"
                type="monotone"
                dataKey="activityEffect"
                name="activityEffect"
                stroke="#00ACC1"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            )}

            {showNetEffect && (
              <Line
                yAxisId="effects"
                type="monotone"
                dataKey="netEffect"
                name="netEffect"
                stroke="#2196F3"
                strokeWidth={2.5}
                strokeDasharray="5 5"
                dot={false}
                isAnimationActive={false}
              />
            )}

            {showCumulativeBaseline && (
              <Line
                yAxisId="effects"
                type="monotone"
                dataKey="cumulativeNetBaseline"
                name="cumulativeNetBaseline"
                stroke="#4CAF50"
                strokeWidth={3}
                strokeDasharray="0"
                dot={false}
                isAnimationActive={false}
                style={{
                  filter: 'drop-shadow(0 0 2px rgba(76, 175, 80, 0.4))'
                }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>

        {/* Sticky Tooltip */}
        {stickyTooltip && (
          <div
            className="sticky-tooltip-container"
            style={{
              position: 'absolute',
              left: `${tooltipPosition.left}px`,
              top: `${tooltipPosition.top}px`,
              transform: 'translate(-50%, -100%)',
              zIndex: 1000
            }}
          >
            <CustomTooltipContent active={true} payload={[{ payload: stickyTooltip }]} />
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(EffectsVisualization, (prevProps, nextProps) => {
  // Compare only the props that actually exist on this component (v5.3 fix).
  return (
    prevProps.patientId    === nextProps.patientId    &&
    prevProps.embedded     === nextProps.embedded     &&
    prevProps.height       === nextProps.height       &&
    prevProps.showControls === nextProps.showControls &&
    prevProps.defaultView  === nextProps.defaultView
  );
});