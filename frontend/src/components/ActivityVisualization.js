/**
 * ============================================================================
 * ACTIVITY EFFECT VISUALIZATION v3.0
 * ============================================================================
 *
 * CHANGES IN v3.0 — Axis Unification with Meal / Insulin Charts
 * ──────────────────────────────────────────────────────────────
 *  The previous layout had a structural mismatch vs. Meal and Insulin:
 *
 *  Meal / Insulin pattern:
 *    Left  axis  → BG impact (mg/dL)    — secondary / derived
 *    Right axis  → Raw physical unit    — carbs (g) or insulin (units)
 *    Dose bar    → on the right axis    — height = raw input quantity
 *    3 PD lines  → on the right axis    — absorbed / active rate / on-board
 *
 *  Activity had:
 *    Left  axis  → BG Drop (mg/dL)      — all three PD lines here ✅
 *    Right axis  → Duration (min) / Sensitivity (%) — two unrelated things ❌
 *    Dose bar    → on LEFT axis in mg/dL ❌ (should be on right, raw units)
 *
 *  v3.0 fix:
 *    Left  axis  → BG Drop (mg/dL)      — all three PD lines + Sensitivity Boost
 *    Right axis  → Duration (min) ONLY  — the "raw input" proxy (session length)
 *    Dose bar    → on RIGHT axis (duration minutes) ✅ mirrors carbs/units bars
 *    Sensitivity Boost → moved to LEFT axis as a 4th optional BG-% line ✅
 *
 *  AOB note: AOB is intentionally different from IOB / MOB but NOT in the
 *  current wrong way. AOB (starts high, decays to 0) is semantically identical
 *  to MOB. Both represent a pending effect that diminishes over time. The
 *  difference is only sign (BG-lowering vs raising), which is already encoded
 *  in the axis label ("BG Drop"). No further special treatment needed.
 *
 * NEW IN v2.0 — Activity Context Sub-chart
 * ─────────────────────────────────────────
 *  A compact panel below the main PD effect chart that renders session context
 *  in two switchable modes:
 *
 *  📊 INTENSITY MODE  (default)
 *     Swim-lane ReferenceArea blocks, time-aligned with the main chart.
 *     Three horizontal bands — one per intensity tier:
 *       Light    (bottom band, y 0–1, green)   — 🚶 walking, easy cycling
 *       Moderate (middle band, y 1–2, orange)  — 🏃 running, moderate cycling
 *       Vigorous (top band,   y 2–3, red)      — ⚡ HIIT, sprinting
 *     Each completed session is a filled block spanning [startTime, endTime]
 *     at its intensity lane.  Wearable sessions show a "⌚" badge in tooltip;
 *     preset sessions show "🏃".
 *     → Answers: "what did I do and when?"
 *
 *  💗 HEART RATE MODE
 *     Same swim-lane intensity blocks + a continuous HR trace line overlay.
 *     • Wearable sessions: actual HR trace from activity.hr_trace field
 *     • Preset sessions:   synthetic HR trace (2-min ramp → plateau → end)
 *     Right Y-axis: HR bpm, domain 40–220.
 *     The line breaks between sessions (connectNulls=false) so gaps are clear.
 *     → Answers: "how hard was each session actually?"
 *
 *  Both modes share the same X-axis time domain as the main chart,
 *  so peaks/drops in the main PD lines align perfectly with sessions below.
 *
 * WHY A SUB-CHART INSTEAD OF BARS ON THE MAIN CHART
 * ──────────────────────────────────────────────────
 *  The existing "sessionBarMinutes" bars on the right axis worked for quick
 *  glancing but:
 *    ① They compete visually with sensitivityBoostPct (same right axis).
 *    ② A single bar gives no intensity context — a 30-min vigorous session
 *       looks identical to a 30-min light stroll.
 *    ③ The HR trace line would be impossible to show without a 3rd axis.
 *  The sub-chart keeps the main chart uncluttered while adding the richer
 *  context the activity model actually needs.
 *
 * DESIGN CHANGES FROM v1.0
 * ─────────────────────────
 *  ✅ NEW: ActivityContextSubChart section below main chart
 *  ✅ NEW: subChartMode state toggle ('intensity' | 'hr')
 *  ✅ NEW: subChartData useMemo — enriches chartData with hrValue per tick
 *  ✅ NEW: buildSyntheticHrTrace / interpolateHrAtTime local helpers
 *  ✅ NEW: subChartAreas — ReferenceArea spec per visible session
 *  ✅ NEW: Wearable HR badge detection
 *  ─ Unchanged: main chart PD lines, tooltips, controls, fullscreen
 *
 * THREE-LINE SYSTEM (unchanged from v1.0)
 * ─────────────────
 *  1. Delivered BG Drop  (TEAL AREA)    — cumulative effect already delivered
 *  2. Active Rate        (ORANGE DASHED) — instantaneous rate of BG change
 *  3. AOB               (PURPLE DOTTED)  — Activity On Board, remaining drop
 *
 * SECONDARY LINES (unchanged from v1.0)
 * ───────────────
 *  4. Sensitivity Boost  (GREEN LINE)    — post-exercise ISF/CR multiplier %
 *  5. Session Bars       (CORAL BARS)    — kept for backward compat, shown on right axis
 *
 * Author:  DiaTwin Team
 * Version: 3.0
 * ============================================================================
 *
 * CHANGES IN v2.1 (kept for history)
 * ────────────────
 *  ✅ FIX:  Sensitivity Boost toggle now defaults to OFF — users opt in
 *  ✅ NEW:  Activity Effect Bars on main chart
 *           • One coral bar per activity start time, on the bgdrop Y-axis
 *           • Bar height = total expected BG drop of that session (mag/dL)
 *             calculated as AOB.remaining_bg_drop at t=start (absorbed=0)
 *           • Same visual idiom as insulinDoseMarker / mealDoseMarker
 *           • Toggle: "Activity Effect Bars" (on by default)
 *  ✅ FIX:  calculateActivitySensitivityMultiplier (activityPharmacodynamics.js)
 *           now discards sessions that started before the daily reset time,
 *           so pre-reset workouts no longer boost post-reset sensitivity.
 *           Matches the delivered-drop and IOB reset behaviour.
 * ============================================================================
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useContext,
  useRef,
} from 'react';
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
  ReferenceArea,
} from 'recharts';

import { useBloodSugarData }  from '../contexts/BloodSugarDataContext';
import { useConstants }        from '../contexts/ConstantsContext';
import TimeContext             from '../contexts/TimeContext';
import TimeManager             from '../utils/TimeManager';
import API_BASE_URL            from '../config';

import {
  normalizeActivityRecord,
  calculateActivityCumulativeEffect,
  getActivityOnBoard,
  calculateActivitySensitivityMultiplier,
  HR_MODEL,                              // v3.1: needed for τ_Z tail-window constant
} from '../utils/activityPharmacodynamics';

import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { FaSync, FaExpand, FaCompress, FaRunning, FaWatch } from 'react-icons/fa';
import './Charts/global-visualization.css';
import { fetchRawHrTrace, getWatchSessionStatus } from '../services/watchHrApi';

import {
  useCurrentMinute,
  useChartTimeRange,
  generateXAxisTicks,
  createXAxisFormatter,
  calculateDynamicBarSize,
  TooltipSection,
  TooltipHeader,
  TooltipRow,
} from '../utils/ChartUtils';


// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_CONFIGS = SHARED_CONSTANTS.VIEW_MODE_CONFIGS;
const DEBUG_MODE   = false;

// ── Activity tail window ──────────────────────────────────────────────────────
// Single source of truth: HR_MODEL.tau_Z = 10 min (from shared_constants).
// The pharmacodynamic tail is 4 × τ_Z = 40 min after the session ends.
// This constant is intentionally identical to ACTIVITY_TAIL_MS in
// EffectsVisualization so both charts include/exclude activities over the
// same time window, keeping CGM comparison and SMBG prediction consistent.
//
// IMPORTANT: do NOT confuse this with the raw lookback window used in
// fetchActivities (viewConfig.mealLookback, typically 8-24 h).  That controls
// how far back the API call reaches.  ACTIVITY_TAIL_MS controls how far
// *past* a session's end the session still contributes to the chart.
const ACTIVITY_TAIL_MS = HR_MODEL.tau_Z * 4 * 60_000; // 4 × 10 min = 40 min

const INTENSITY_COLORS = {
  light:    '#66bb6a',
  moderate: '#ffa726',
  vigorous: '#ef5350',
};

const INTENSITY_ICONS = {
  light:    '🚶',
  moderate: '🏃',
  vigorous: '⚡',
};

/** Maps intensity string → swim-lane Y origin (0, 1, or 2). */
const INTENSITY_LANE = {
  light:    0,
  moderate: 1,
  vigorous: 2,
};

function getIntensityDisplay(intensity) {
  return {
    label: intensity ? intensity.charAt(0).toUpperCase() + intensity.slice(1) : 'Unknown',
    color: INTENSITY_COLORS[intensity] || '#9e9e9e',
    icon:  INTENSITY_ICONS[intensity]  || '🏃',
  };
}

function getActivityPhase(minutesElapsed, durationMinutes) {
  if (minutesElapsed < 0)                          return 'Upcoming';
  if (minutesElapsed < durationMinutes)            return 'In Progress';
  if (minutesElapsed < durationMinutes * 1.5)      return 'Peak Effect';
  if (minutesElapsed < durationMinutes * 3)        return 'Active Recovery';
  return 'Tail Effect';
}


// ─── Sub-chart HR helpers ──────────────────────────────────────────────────────

/**
 * HR fraction of (hrMax - hrBase) for each intensity tier.
 * Mirrors INTENSITY_HR_FRACTION in shared_constants + Python backend.
 */
const HR_FRACTIONS = { light: 0.5, moderate: 0.65, vigorous: 0.8 };

/**
 * Build a synthetic [t_min, hr_bpm] trace for a preset (non-wearable) activity.
 * Shape: 2-min ramp → flat plateau → last sample at durationMinutes.
 * Mirrors Python _synthetic_hr_trace() and JS buildSyntheticTrace().
 *
 * @returns {[number, number][]}  array of [t_min, hr_bpm] tuples
 */
function buildSyntheticHrTrace(intensity, durationMinutes, hrBase, hrMax) {
  const fraction = HR_FRACTIONS[intensity] || 0.65;
  const peakHr   = hrBase + fraction * (hrMax - hrBase);
  const rampEnd  = Math.min(2.0, durationMinutes * 0.1);
  return [
    [0,              hrBase],
    [rampEnd,        peakHr],
    [durationMinutes, peakHr],
  ];
}

/**
 * Linear interpolation of HR at elapsedMin from a trace array.
 * Returns null when outside the session window (before or after).
 *
 * @param {[number, number][]} trace   - [[t_min, hr_bpm], ...]
 * @param {number}             elapsedMin
 * @returns {number|null}
 */
function interpolateHrAtTime(trace, elapsedMin) {
  if (!trace || trace.length === 0) return null;
  if (elapsedMin < 0)                            return null;
  if (elapsedMin > trace[trace.length - 1][0])   return null;
  if (elapsedMin <= trace[0][0])                  return trace[0][1];

  for (let i = 0; i < trace.length - 1; i++) {
    const [t0, h0] = trace[i];
    const [t1, h1] = trace[i + 1];
    if (t0 <= elapsedMin && elapsedMin <= t1) {
      const frac = t1 > t0 ? (elapsedMin - t0) / (t1 - t0) : 0;
      return h0 + frac * (h1 - h0);
    }
  }
  return trace[trace.length - 1][1];
}

/**
 * Normalise an hr_trace field (supports both object {t_min, hr_bpm} and tuple
 * [t_min, hr_bpm] formats) into [[t_min, hr_bpm], ...].
 */
function normalizeHrTrace(raw) {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
  return raw.map(s =>
    Array.isArray(s) ? s : [s.t_min ?? 0, s.hr_bpm ?? 0]
  );
}


// ─── Main Component ────────────────────────────────────────────────────────────

const ActivityVisualization = ({
  patientId    = null,
  isDoctor     = false,
  height       = 600,
  showControls = true,
  embedded     = false,
  onDataUpdate = null,
  defaultView  = '12h',
}) => {
  // ===== CONTEXT & HOOKS =====
  const timeContext = useContext(TimeContext);
  const { fetchLast24hData, handleViewModeChange } = useBloodSugarData();
  const { patientConstants: ownConstants } = useConstants();

  // D28: this component previously took an `isDoctor`/`patientId` pair from
  // the doctor dashboard and ignored both — it always fetched from
  // /api/activity-history (the CALLER's own activities, i.e. the doctor's,
  // not the selected patient's) and always read `useConstants()` (the
  // doctor's own reset hour, HR base/max), which every PD calculation below
  // depends on. A doctor viewing a patient's activity tab therefore saw
  // either their own (usually empty) activity history recomputed with their
  // own physiology, or nothing — under that patient's name.
  //
  // Fetched via /api/doctor/patient/<id>/constants, the same endpoint
  // ClinicalValidationDashboard already uses (D24's fix made it return
  // timezone_offset_minutes too). `patientConstants` below is shadowed so the
  // ~15 downstream reads of it need no further changes — each already
  // resolves to the right patient's constants for whichever mode is active.
  const [doctorViewConstants, setDoctorViewConstants] = useState(null);

  useEffect(() => {
    if (!isDoctor || !patientId) {
      setDoctorViewConstants(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        if (!token) return;
        const response = await axios.get(
          `${API_BASE_URL}/api/doctor/patient/${patientId}/constants`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!cancelled) setDoctorViewConstants(response.data?.constants ?? null);
      } catch (err) {
        if (!cancelled) setDoctorViewConstants(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isDoctor, patientId]);

  const patientConstants = (isDoctor && patientId) ? doctorViewConstants : ownConstants;

  // ===== STATE =====
  const [viewMode, setViewMode]           = useState(defaultView);
  const [chartData, setChartData]         = useState([]);
  const [rawActivities, setRawActivities] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [isFullscreen, setIsFullscreen]   = useState(false);

  // Main chart series toggles
  const [showDelivered,   setShowDelivered]   = useState(false);
  const [showActiveRate,  setShowActiveRate]  = useState(true);
  const [showAOB,         setShowAOB]         = useState(true);
  const [showSensitivity, setShowSensitivity] = useState(false); // off by default — BG % overlay, opt-in
  const [showSessionBars, setShowSessionBars] = useState(false); // v3.0: session duration bars OFF by default
  const [showActivityBars, setShowActivityBars] = useState(true); // BG-drop effect bars at session start

  // Sub-chart mode
  const [subChartMode, setSubChartMode] = useState('intensity'); // 'intensity' | 'hr'

  // HR Live tab state
  const [hrLiveSessionId, setHrLiveSessionId]   = useState('');
  const [hrLiveData, setHrLiveData]             = useState(null);   // fetchRawHrTrace response
  const [hrLiveLoading, setHrLiveLoading]       = useState(false);
  const [hrLiveError, setHrLiveError]           = useState(null);
  const [hrLiveAutoRefresh, setHrLiveAutoRefresh] = useState(false);

  const [stickyTooltip,   setStickyTooltip]   = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });

  const chartRef     = useRef(null);
  const containerRef = useRef(null);

  // ===== SHARED HOOKS =====
  const currentMinute = useCurrentMinute();
  const timeRange     = useChartTimeRange(viewMode, currentMinute);

  // ===== HR LIVE FETCH =====
  const fetchHrLive = useCallback(async (sid) => {
    const id = (sid ?? hrLiveSessionId).trim();
    if (!id) return;
    setHrLiveLoading(true);
    setHrLiveError(null);
    try {
      const data = await fetchRawHrTrace(id);
      setHrLiveData(data);
      setHrLiveSessionId(id);
    } catch (err) {
      setHrLiveError(err?.response?.data?.error || err.message || 'Failed to fetch HR trace');
    } finally {
      setHrLiveLoading(false);
    }
  }, [hrLiveSessionId]);

  // Auto-detect an in-progress session for the HR Live tab
  useEffect(() => {
    getWatchSessionStatus().then(status => {
      if (status.active && status.session_id) {
        setHrLiveSessionId(status.session_id);
      }
    }).catch(() => {});
  }, []);

  // Auto-refresh live session every 5 s when toggled on
  useEffect(() => {
    if (!hrLiveAutoRefresh || !hrLiveSessionId) return;
    const interval = setInterval(() => fetchHrLive(hrLiveSessionId), 5000);
    return () => clearInterval(interval);
  }, [hrLiveAutoRefresh, hrLiveSessionId, fetchHrLive]);

  // ===== DERIVED =====
  const viewConfig = VIEW_CONFIGS[viewMode];
  const resetHour  = patientConstants?.daily_reset_hour ?? 7;
  const resetLabel = resetHour === 0 ? '12 AM'
    : resetHour < 12  ? `${resetHour} AM`
    : resetHour === 12 ? '12 PM'
    : `${resetHour - 12} PM`;

  const hrBase = parseFloat(patientConstants?.hr_base || 70);
  const hrMax  = parseFloat(patientConstants?.hr_max  || 185);


  // ===== FETCH ACTIVITY HISTORY =====
  const fetchActivities = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;

      const lookbackHours = Math.max(viewConfig.mealLookback || 24, 8);

      // D28: /api/doctor/patient/<id>/activity-history (the sibling doctor
      // endpoint) returns a materially different, narrower shape —
      // activityType/activityLevel rather than type/level/intensity/
      // duration_minutes/bg_direction — which normalizeActivityRecord cannot
      // read at all; every record from it maps to null and is filtered out.
      // /api/patient/<id>/activity-history (fixed for authorization as D27)
      // returns the same shape /api/activity-history does, so the normalizer
      // needs no branch of its own.
      const url = (isDoctor && patientId)
        ? `${API_BASE_URL}/api/patient/${patientId}/activity-history`
        : `${API_BASE_URL}/api/activity-history`;

      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { limit: 200, lookback_hours: lookbackHours },
      });

      if (response.data && Array.isArray(response.data)) {
        const normalized = response.data
          .map(normalizeActivityRecord)
          .filter(Boolean);

        if (DEBUG_MODE) {
          console.log(`[ActivityViz v2] fetched ${response.data.length} raw → ${normalized.length} normalized`);
        }

        setRawActivities(normalized);
      }
    } catch (err) {
      console.warn('[ActivityViz v2] activity-history fetch failed:', err.message);
    }
  }, [viewConfig.mealLookback, isDoctor, patientId]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);


  // ===== FILTER VISIBLE ACTIVITIES =====
  // Uses module-level ACTIVITY_TAIL_MS (4 × τ_Z = 40 min) — same value as
  // EffectsVisualization so both charts agree on which sessions are visible.

  const visibleActivities = useMemo(() => {
    return rawActivities.filter(act => {
      const startMs = act.timestamp;
      const endMs   = startMs + (act.duration_minutes || 30) * 60_000 + ACTIVITY_TAIL_MS;
      return endMs >= timeRange.start && startMs <= timeRange.end;
    });
  }, [rawActivities, timeRange.start, timeRange.end]);


  // ===== GENERATE MAIN CHART DATA =====
  const generateChartData = useCallback(() => {
    if (!patientConstants) return [];

    const { start, end, now } = timeRange;
    const intervalMs           = viewConfig.interpolationInterval * 60 * 1000;

    const timePoints = [];
    for (let t = start; t <= end; t += intervalMs) {
      const norm = TimeManager.normalize(t, TimeManager.precision.MINUTE);
      if (!timePoints.length || timePoints[timePoints.length - 1] !== norm) {
        timePoints.push(norm);
      }
    }

    // ✅ FIX (Bugs 1-3): Inject the exact start timestamp of every visible
    //    activity into the time-point array.  This guarantees that each
    //    activityDoseMarker bar lands at the same pixel as the swimlane
    //    ReferenceArea (both use act.timestamp on the same continuous XAxis)
    //    AND at the same tick where AOB first becomes non-zero (time >= startMs).
    //    Without this, the halfInterval snap could place the bar on a tick that
    //    is *before* the true start, making it appear ahead of both the AOB
    //    line and the swimlane block.
    const timePointSet = new Set(timePoints);
    visibleActivities.forEach(act => {
      const s   = act.timestamp;
      const dur = (act.duration_minutes || 30) * 60_000;
      const e   = s + dur;
      if (s > start && s < end) {
        if (s - 1 > start) timePointSet.add(s - 1); // zero-anchor 1 ms before start
        timePointSet.add(s);
      }
      // Anchor at endMs so the plateau→decay edge is sharp.
      // NOTE: endMs+1 was previously injected here but caused a double-spike on
      // the Active Rate (orange) line: the 1ms window produced a near-zero delta,
      // then the next regular tick accumulated the full interval as a spike.
      // endMs alone is sufficient — recharts draws the sharp edge at that point.
      if (e > start && e < end) {
        timePointSet.add(e);
      }
    });
    const sortedTimePoints = [...timePointSet].sort((a, b) => a - b);

    const halfInterval  = intervalMs / 2;   // still used for isNow only

    const timeline = sortedTimePoints.map((time) => {
      const isHistorical = time <= now;
      const isFuture     = time > now;
      const isNow        = Math.abs(time - now) < halfInterval;

      // ✅ Match InsulinVisualization / MealVisualization pattern:
      //    resolve resetHour and tzOffset per time-point so multi-day charts
      //    correctly apply the patient's own reset time on every calendar day.
      const resetHour      = patientConstants?.daily_reset_hour ?? 7;
      const tzOffset       = patientConstants?.timezone_offset_minutes ?? null;
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

          // ✅ Pass tzOffset so isWithinCurrentDay uses the patient's timezone,
          //    matching the backend and InsulinVisualization behaviour.
          const isWithinCurrentDay = TimeManager.isWithinCurrentDay(
            startMs, time, resetHour, tzOffset
          );

          const signedEffect = calculateActivityCumulativeEffect(activity, time, patientConstants);
          const deliveredMag = Math.abs(signedEffect);

          const aobResult = getActivityOnBoard(activity, time, patientConstants);
          const { remaining_bg_drop, absorbed_fraction, minutes_elapsed, is_active, intensity } = aobResult;

          const durationMin = activity.duration_minutes || 30;
          const endMs       = startMs + durationMin * 60_000;

          // Pre-compute AOB at session start (absorbed=0 → full predicted drop).
          // Only needed while the session is in progress; null otherwise.
          const aobAtStart = (time >= startMs && time < endMs)
            ? getActivityOnBoard(activity, startMs, patientConstants)
            : null;

          if (isWithinCurrentDay) {
            totalDeliveredDrop += deliveredMag;
          }

          // AOB shape: 0 → (startMs-1) | jump to max at startMs →
          //            ████ plateau for full session duration ████ →
          //            decay to 0 after endMs.
          // "BG drop still to come" doesn't shrink while the session is still
          // happening; it only starts reducing once the activity ends.
          if (time >= startMs) {
            if (time < endMs) {
              totalAOB += aobAtStart.remaining_bg_drop;
            } else {
              totalAOB += remaining_bg_drop;
            }
          }

          // Active rate: derivative of delivered drop over a fixed intervalMs window.
          // Previously used a tick-to-tick prevDelivered map, which caused a
          // zero-then-spike artifact whenever injected anchor points (s-1, s, endMs)
          // created sub-millisecond gaps — the 1ms window collapsed the delta to ~0,
          // then the next real tick accumulated the full interval at once.
          // Computing the derivative over a fixed window is immune to anchor spacing.
          if (isWithinCurrentDay) {
            // Clamp prevTime to the daily reset so we never look across a day boundary.
            const prevTime        = Math.max(time - intervalMs, dailyResetTime);
            const deliveredAtPrev = Math.abs(
              calculateActivityCumulativeEffect(activity, prevTime, patientConstants)
            );
            const rateContrib = Math.max(0, deliveredMag - deliveredAtPrev);
            totalActiveRate += rateContrib;
          }

          // Tooltip AOB mirrors the plateau logic so the displayed value
          // always matches what the chart line is showing.
          const aobForTooltip = (time >= startMs && time < endMs)
            ? aobAtStart.remaining_bg_drop
            : remaining_bg_drop;

          if (minutes_elapsed >= 0 && minutes_elapsed < durationMin + 60 * 8) {
            contributions.push({
              activityId:        activity._id || String(startMs),
              intensity,
              durationMinutes:   durationMin,
              minutesElapsed:    minutes_elapsed,
              deliveredDrop:     Math.round(deliveredMag * 10) / 10,
              aob:               aobForTooltip,
              absorbedFraction:  absorbed_fraction,
              isActive:          is_active,
              phase:             getActivityPhase(minutes_elapsed, durationMin),
              isWithinCurrentDay,
              bgDirection:       activity.bg_direction ?? -1,
              hasWearableHr:     !!(activity.hr_trace && activity.hr_trace.length > 0),
            });
          }

          // ✅ FIX: exact match only — the injected data point for this
          //    activity's start timestamp ensures there is always a chart
          //    point at precisely act.timestamp, so strict equality is safe.
          //    The old halfInterval window could match a tick *before*
          //    startMs, decoupling the bar from both the AOB line and the
          //    swimlane block.
          if (startMs === time) {
            sessionsAtTime.push({ ...activity, durationMinutes: durationMin, intensity });
          }
        });
      }

      // ✅ NEW: Activity dose marker — bar height = total expected BG drop for
      // sessions that *start* at this tick, computed via AOB at t=startMs
      // (absorbed fraction = 0 at start, so remaining_bg_drop = total drop).
      // Mirrors the insulinDoseMarker / mealDoseMarker pattern.
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

      const sensitivityMult     = calculateActivitySensitivityMultiplier(
        visibleActivities, time, patientConstants
      );
      const sensitivityBoostPct = Math.round((sensitivityMult - 1) * 100 * 10) / 10;

      const sessionBarMinutes = sessionsAtTime.reduce(
        (sum, s) => sum + s.durationMinutes, 0
      ) || null;

      return {
        timestamp: time,
        formattedTime: TimeManager.formatDate(
          new Date(time),
          viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
        ),
        timestampPrecision: 'MINUTE',

        deliveredBGDrop:   Math.round(totalDeliveredDrop * 10) / 10,
        activeRate:        Math.round(totalActiveRate    * 10) / 10,
        aob:               Math.round(totalAOB           * 10) / 10,

        sessionBarMinutes,
        sensitivityBoostPct,

        activityDoseMarker, // ✅ NEW: BG-effect bar at session start time

        sessionsStarted: sessionsAtTime,
        contributions,
        sensitivityMult,

        isHistorical,
        isFuture,
        isNow,
        isAtReset,
        dailyResetTime, // ✅ Exposed for tooltip display — matches InsulinVisualization
      };
    });

    if (DEBUG_MODE) {
      console.log(`[ActivityViz v2] generated ${timeline.length} chart points`);
    }
    return timeline;
  }, [patientConstants, visibleActivities, timeRange, viewConfig, resetHour]);

  useEffect(() => {
    if (!patientConstants) return;
    const timeoutId = setTimeout(() => {
      try {
        const data = generateChartData();
        setChartData(data);
        setLoading(false);
        if (onDataUpdate) onDataUpdate(data);
      } catch (err) {
        console.error('[ActivityViz v2] Error generating chart data:', err);
        setError('Failed to generate activity chart data');
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timeoutId);
  }, [generateChartData, patientConstants, onDataUpdate]);


  // ===== SUB-CHART DATA =====
  // Enriches each main chart point with hrValue for the HR trace line.
  // hrValue is null when not inside any session, otherwise interpolated from
  // the wearable trace (if present) or synthetic trace (for preset activities).
  const subChartData = useMemo(() => {
    if (!chartData.length) return [];

    return chartData.map(point => {
      const time = point.timestamp;
      let hrValue = null;

      visibleActivities.forEach(act => {
        const startMs = act.timestamp;
        const endMs   = startMs + (act.duration_minutes || 30) * 60_000;

        if (time >= startMs && time <= endMs) {
          const elapsedMin = (time - startMs) / 60_000;

          // Use wearable trace if available, otherwise build synthetic
          const rawTrace = normalizeHrTrace(act.hr_trace);
          const trace    = rawTrace
            ? rawTrace
            : buildSyntheticHrTrace(
                act.intensity || 'moderate',
                act.duration_minutes || 30,
                hrBase,
                hrMax
              );

          const hr = interpolateHrAtTime(trace, elapsedMin);
          if (hr !== null) {
            hrValue = hrValue === null ? hr : Math.max(hrValue, hr);
          }
        }
      });

      return { ...point, hrValue };
    });
  }, [chartData, visibleActivities, hrBase, hrMax]);

  // ===== SUB-CHART REFERENCE AREAS =====
  // One ReferenceArea spec per visible session — positioned in its intensity lane.
  const subChartAreas = useMemo(() => {
    return visibleActivities.map((act, i) => {
      const startMs   = act.timestamp;
      const endMs     = startMs + (act.duration_minutes || 30) * 60_000;
      const laneY     = INTENSITY_LANE[act.intensity] ?? 0;
      const hasWearHr = !!(act.hr_trace && act.hr_trace.length > 0);
      return {
        key:      i,
        x1:       startMs,
        x2:       Math.min(endMs, timeRange.end),
        y1:       laneY,
        y2:       laneY + 1,
        fill:     INTENSITY_COLORS[act.intensity] || '#9e9e9e',
        intensity: act.intensity,
        hasWearHr,
      };
    });
  }, [visibleActivities, timeRange.end]);

  // Count wearable sessions for badge display
  const wearableCount = visibleActivities.filter(
    a => a.hr_trace && a.hr_trace.length > 0
  ).length;


  // ===== HANDLERS =====
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await fetchActivities();
    // D28: fetchLast24hData reads/writes the shared BloodSugarDataContext,
    // which is scoped to whoever is logged in — the doctor, in this mode.
    // Calling it here would pull the doctor's own glucose data into state
    // that BloodSugarVisualization (rendered alongside this component in the
    // doctor dashboard) also reads, for the SAME patient slot. Harmless in
    // patient mode, where "whoever is logged in" is the right person.
    if (fetchLast24hData && !isDoctor) fetchLast24hData();
    setTimeout(() => setLoading(false), 800);
  }, [fetchActivities, fetchLast24hData, isDoctor]);

  const handleChartClick = (data) => {
    if (data?.activePayload?.length) {
      setStickyTooltip(data.activePayload[0].payload);
      setTooltipPosition({ left: data.chartX, top: data.chartY - 10 });
    }
  };

  const handleCloseTooltip  = () => setStickyTooltip(null);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleViewChange = useCallback((newMode) => {
    if (newMode === viewMode) return;
    setViewMode(newMode);
    // Same reasoning as handleRefresh above: this drives the shared
    // patient-scoped context, which is the doctor's own in doctor mode.
    if (handleViewModeChange && !isDoctor) handleViewModeChange(newMode);
  }, [viewMode, handleViewModeChange, isDoctor]);


  // ===== FORMATTERS =====
  const formatXAxisLabel = useMemo(() => createXAxisFormatter(viewConfig), [viewConfig]);
  const ticks            = useMemo(() => generateXAxisTicks(timeRange, viewConfig), [timeRange, viewConfig]);
  const dynamicBarSize   = useMemo(
    () => calculateDynamicBarSize(chartRef.current?.offsetWidth, chartData.length),
    [chartData.length]
  );


  // ===== Y-AXIS DOMAINS =====
  //
  // v3.1 axis layout:
  //   Left        (bgdrop)      → BG Drop (mg/dL): three PD lines only
  //   Right inner (duration)    → Duration (min) : session bars (raw-input proxy)
  //   Right outer (sensitivity) → Sensitivity Boost (%): own axis, 0–100 fixed
  //                               only rendered when showSensitivity is ON
  //
  const { bgDropDomain, durationDomain } = useMemo(() => {
    if (!chartData.length) {
      return { bgDropDomain: [0, 60], durationDomain: [0, 120] };
    }

    // Left axis: PD lines only — sensitivity is now on its own axis.
    const maxDelivered = Math.max(...chartData.map(d => d.deliveredBGDrop || 0), 0);
    const maxActive    = Math.max(...chartData.map(d => d.activeRate      || 0), 0);
    const maxAOB       = Math.max(...chartData.map(d => d.aob            || 0), 0);
    const maxBGDrop    = Math.max(maxDelivered, maxActive, maxAOB);

    // Right inner axis: session duration bars only
    const maxDuration  = Math.max(...chartData.map(d => d.sessionBarMinutes || 0), 0);

    return {
      bgDropDomain:  [0, Math.min(Math.max(Math.ceil(maxBGDrop)  + 10, 30), 300)],
      durationDomain:[0, Math.min(Math.max(Math.ceil(maxDuration) + 15, 60), 300)],
    };
  }, [chartData]);


  // ===== CUSTOM TOOLTIP =====
  const CustomTooltipContent = ({ active, payload }) => {
    const data = stickyTooltip ||
      (active && payload?.length ? payload[0].payload : null);
    if (!data) return null;

    const hasSession = data.sessionsStarted?.length > 0;

    return (
      <div className="bg-visualization-tooltip" style={{ maxWidth: '320px' }}>
        {stickyTooltip && (
          <button
            onClick={handleCloseTooltip}
            aria-label="Close tooltip"
            style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px' }}
          >
            ✕
          </button>
        )}

        {/* Time header */}
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
          {data.formattedTime}
          {data.isNow && (
            <span style={{ marginLeft: 8, color: '#f44336', fontSize: 12 }}>🔴 Now</span>
          )}
          {data.isAtReset && (
            <span style={{ marginLeft: 8, color: '#4CAF50', fontSize: 12 }}>
              🔄 {resetLabel} Reset
            </span>
          )}
        </div>

        {data.isAtReset && (
          <TooltipSection backgroundColor="#e8f5e9" borderColor="#4CAF50" marginBottom="8px">
            <TooltipHeader icon="🔄" color="#2e7d32">Daily Reset Point:</TooltipHeader>
            <div style={{ fontSize: 11, color: '#2e7d32', marginTop: 4 }}>
              ✅ Cumulative delivered BG drop resets to 0
              <br />
              📊 AOB and active rate continue normally
            </div>
          </TooltipSection>
        )}

        {hasSession && (
          <TooltipSection backgroundColor="#fff3e0" borderColor="#ff7043" marginBottom="8px">
            <TooltipHeader icon="🏃" color="#bf360c">
              Activity Started ({data.sessionsStarted.length}):
            </TooltipHeader>
            {data.sessionsStarted.map((s, i) => {
              const disp = getIntensityDisplay(s.intensity);
              const isWearable = !!(s.hr_trace && s.hr_trace.length > 0);
              return (
                <div key={i} style={{
                  padding: '5px 6px',
                  marginTop: 4,
                  background: '#fafafa',
                  borderRadius: 4,
                  borderLeft: `3px solid ${disp.color}`,
                  fontSize: 11,
                }}>
                  <span style={{ fontWeight: 600, color: disp.color }}>
                    {disp.icon} {disp.label}
                  </span>
                  <span style={{ color: '#666', marginLeft: 6 }}>
                    {s.durationMinutes} min
                  </span>
                  <span style={{
                    marginLeft: 6,
                    fontSize: 10,
                    background: isWearable ? '#e3f2fd' : '#f3e5f5',
                    color:      isWearable ? '#1565c0' : '#6a1b9a',
                    padding: '1px 5px',
                    borderRadius: 3,
                  }}>
                    {isWearable ? '⌚ Wearable HR' : '📋 Preset'}
                  </span>
                </div>
              );
            })}
            {data.activityDoseMarker != null && (
              <div style={{ marginTop: 6, fontSize: 10, color: '#bf360c' }}>
                📉 Expected total BG drop: {data.activityDoseMarker.toFixed(1)} mg/dL
                &nbsp;•&nbsp;⏱️ {data.sessionsStarted?.reduce((s, a) => s + (a.durationMinutes || 0), 0)} min total
              </div>
            )}
          </TooltipSection>
        )}

        {/* Three activity effect lines */}
        <TooltipSection backgroundColor="#e3f2fd" borderColor="#1976d2" marginBottom="8px">
          <TooltipHeader icon="🏋️" color="#0d47a1">Activity Effect (Three Lines):</TooltipHeader>

          <div style={{ marginTop: 6 }}>
            <div style={{ fontWeight: 600, color: '#00897b', fontSize: 11, marginBottom: 3 }}>
              1️⃣ Delivered BG Drop (TEAL AREA):
            </div>
            <TooltipRow
              label="Delivered"
              value={`${data.deliveredBGDrop.toFixed(1)} mg/dL drop`}
              valueColor="#00897b"
            />
            <div style={{ fontSize: 10, color: '#666', fontStyle: 'italic', marginTop: 2 }}>
              ✅ Cumulative drop delivered today (resets at {resetLabel})
            </div>
          </div>

          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontWeight: 600, color: '#f57c00', fontSize: 11, marginBottom: 3 }}>
              2️⃣ Active Drop Rate (ORANGE DASHED):
            </div>
            <TooltipRow
              label="Current Rate"
              value={`${data.activeRate.toFixed(1)} mg/dL / ${viewConfig.interpolationInterval} min`}
              valueColor="#f57c00"
            />
          </div>

          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontWeight: 600, color: '#7b1fa2', fontSize: 11, marginBottom: 3 }}>
              3️⃣ Activity On Board — AOB (PURPLE DOTTED):
            </div>
            <TooltipRow
              label="Remaining Drop"
              value={`${data.aob.toFixed(1)} mg/dL remaining`}
              valueColor="#7b1fa2"
            />
          </div>
        </TooltipSection>

        {data.sensitivityMult > 1.0 && (
          <TooltipSection backgroundColor="#e8f5e9" borderColor="#43a047" marginBottom="8px">
            <TooltipHeader icon="🔬" color="#2e7d32">Post-Exercise Sensitivity:</TooltipHeader>
            <TooltipRow
              label="ISF/CR Multiplier"
              value={`×${data.sensitivityMult.toFixed(3)}`}
              valueColor="#2e7d32"
            />
            <TooltipRow
              label="Boost"
              value={`+${data.sensitivityBoostPct.toFixed(1)}%`}
              valueColor="#2e7d32"
            />
          </TooltipSection>
        )}

        {data.contributions?.length > 0 && (
          <TooltipSection backgroundColor="#f3e5f5" borderColor="#8e24aa" marginBottom="8px">
            <TooltipHeader icon="📊" color="#6a1b9a">
              Active Sessions ({data.contributions.length}):
            </TooltipHeader>
            {data.contributions.slice(0, 3).map((c, i) => {
              const disp = getIntensityDisplay(c.intensity);
              return (
                <div key={i} style={{
                  padding: '5px 6px',
                  marginTop: 5,
                  background: '#fafafa',
                  borderRadius: 4,
                  borderLeft: `3px solid ${disp.color}`,
                  fontSize: 10,
                }}>
                  <div style={{ fontWeight: 600, color: disp.color, marginBottom: 2 }}>
                    {disp.icon} {disp.label} — {c.durationMinutes} min
                    {c.hasWearableHr && (
                      <span style={{ color: '#1565c0', fontSize: 9, marginLeft: 4 }}>⌚</span>
                    )}
                    {!c.isWithinCurrentDay && (
                      <span style={{ color: '#999', fontSize: 9, marginLeft: 4 }}>
                        (before {resetLabel} reset)
                      </span>
                    )}
                  </div>
                  <div style={{ color: '#555' }}>
                    ⏱️ {c.minutesElapsed.toFixed(0)} min ago • {c.phase}
                  </div>
                  <div style={{ color: '#555', marginTop: 2 }}>
                    Delivered: {c.deliveredDrop} mg/dL drop &nbsp;|&nbsp;
                    AOB: {c.aob} mg/dL remaining &nbsp;|&nbsp;
                    Absorbed: {(c.absorbedFraction * 100).toFixed(0)}%
                  </div>
                </div>
              );
            })}
            {data.contributions.length > 3 && (
              <div style={{ fontSize: 10, color: '#666', marginTop: 4, fontStyle: 'italic' }}>
                +{data.contributions.length - 3} more sessions…
              </div>
            )}
          </TooltipSection>
        )}

        <div style={{ marginTop: 8, fontSize: 11, color: '#888', textAlign: 'center' }}>
          {data.isHistorical ? '📊 Historical' : '🔮 Projected'}
        </div>
      </div>
    );
  };


  // ===== LOADING & ERROR STATES =====
  if (loading && chartData.length === 0) {
    return (
      <div className="bg-visualization-loading" style={{ height }}>
        <FaSync className="spin" />
        Loading activity data…
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


  // ===== RENDER =====
  return (
    <div
      ref={containerRef}
      className={`bg-visualization-container ${embedded ? 'embedded' : ''} ${isFullscreen ? 'fullscreen' : ''}`}
    >
      {/* ── Header ── */}
      {showControls && (
        <div className="bg-visualization-header">
          <div>
            <h3>Activity Effect Visualization</h3>
            <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              🏃 v3.0 &nbsp;•&nbsp;
              <span style={{ color: '#00897b' }}>Teal = Delivered Drop</span>
              &nbsp;•&nbsp;
              <span style={{ color: '#f57c00' }}>Orange = Active Rate</span>
              &nbsp;•&nbsp;
              <span style={{ color: '#7b1fa2' }}>Purple = AOB</span>
              &nbsp;•&nbsp;
              <span style={{ color: '#ef6c00' }}>Bars = Session Duration (min)</span>
              &nbsp;•&nbsp;
              <span style={{ color: '#43a047' }}>Green = Sensitivity Boost (off by default)</span>
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="view-mode-toggle">
              {Object.entries(VIEW_CONFIGS).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => handleViewChange(key)}
                  className={viewMode === key ? 'active' : ''}
                  disabled={loading}
                >
                  {cfg.label}
                </button>
              ))}
            </div>

            <button
              onClick={handleRefresh}
              disabled={loading}
              className="bg-action-button"
              title="Refresh"
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

      {/* ── Toggle Controls ── */}
      {showControls && (
        <div className="toggle-controls" style={{ marginTop: 8, marginBottom: 8 }}>
          <label style={{ fontWeight: 600, color: '#00897b' }}>
            <input type="checkbox" checked={showDelivered}   onChange={() => setShowDelivered(v => !v)} />
            &nbsp;Delivered Drop
          </label>
          <label style={{ color: '#f57c00' }}>
            <input type="checkbox" checked={showActiveRate}  onChange={() => setShowActiveRate(v => !v)} />
            &nbsp;Active Rate
          </label>
          <label style={{ color: '#7b1fa2' }}>
            <input type="checkbox" checked={showAOB}         onChange={() => setShowAOB(v => !v)} />
            &nbsp;AOB (Remaining)
          </label>
          <label style={{ color: '#43a047' }}>
            <input type="checkbox" checked={showSensitivity} onChange={() => setShowSensitivity(v => !v)} />
            &nbsp;Sensitivity Boost % (left axis)
          </label>
          <label style={{ color: '#ef6c00' }}>
            <input type="checkbox" checked={showSessionBars} onChange={() => setShowSessionBars(v => !v)} />
            &nbsp;Session Duration Bars (right axis)
          </label>
          <label style={{ color: '#e53935' }}>
            <input type="checkbox" checked={showActivityBars} onChange={() => setShowActivityBars(v => !v)} />
            &nbsp;Activity Effect Bars (BG drop at start)
          </label>
        </div>
      )}

      {/* ── Empty state ── */}
      {chartData.length === 0 && !loading ? (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: '#666',
          background: '#f9f9f9',
          borderRadius: 8,
          margin: '20px 0',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🏃</div>
          <h3 style={{ margin: '0 0 8px', color: '#333' }}>No Activity Data Available</h3>
          <p style={{ margin: 0, fontSize: 14 }}>
            No recent activity sessions found. Log an activity to see the pharmacodynamic visualization.
          </p>
        </div>
      ) : (
        <>
          {/* ── Main PD Effect Chart ── */}
          <div ref={chartRef} className="chart-container">
            <ResponsiveContainer width="100%" height={height}>
              <ComposedChart
                data={chartData}
                margin={{ top: 20, right: 100, left: 20, bottom: 60 }}
                onClick={handleChartClick}
              >
                <defs>
                  <linearGradient id="actDeliveredGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#00897b" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#00897b" stopOpacity={0.05} />
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
                  yAxisId="bgdrop"
                  domain={bgDropDomain}
                  tickFormatter={v => `${Math.round(v)}`}
                  label={{
                    value: 'BG Drop (mg/dL)',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 12, fill: '#444' },
                  }}
                  stroke="#444"
                  fontSize={11}
                />

                {/* v3.0: Right axis = session duration (min) — the "raw input" proxy,
                    analogous to carbs (g) on Meal chart and units (U) on Insulin chart. */}
                <YAxis
                  yAxisId="duration"
                  orientation="right"
                  domain={durationDomain}
                  tickFormatter={v => `${Math.round(v)}`}
                  label={{
                    value: 'Duration (min)',
                    angle: 90,
                    position: 'insideRight',
                    style: { fontSize: 12, fill: '#43a047' },
                  }}
                  stroke="#43a047"
                  fontSize={11}
                />

                {/* v3.1: Third axis — Sensitivity Boost (%) on far right.
                    Only rendered when the toggle is ON so it doesn't clutter
                    the chart when the line is hidden. Fixed 0–100 domain. */}
                {showSensitivity && (
                  <YAxis
                    yAxisId="sensitivity"
                    orientation="right"
                    domain={[0, 100]}
                    tickFormatter={v => `${v}%`}
                    label={{
                      value: 'Sensitivity Boost (%)',
                      angle: 90,
                      position: 'insideRight',
                      dx: 55,
                      style: { fontSize: 12, fill: '#7b1fa2' },
                    }}
                    stroke="#7b1fa2"
                    fontSize={11}
                    width={55}
                  />
                )}

                <Tooltip content={<CustomTooltipContent />} />

                <Legend
                  verticalAlign="top"
                  height={36}
                  formatter={(value) => {
                    const labels = {
                      deliveredBGDrop:     '① Delivered Drop (mg/dL)',
                      activeRate:          '② Active Rate (mg/dL)',
                      aob:                 '③ AOB — Remaining Drop (mg/dL)',
                      sensitivityBoostPct: '④ Sensitivity Boost %',
                      sessionBarMinutes:   '🏃 Session Duration (min)',
                      activityDoseMarker:  '📉 Activity Effect (BG drop)',
                    };
                    return labels[value] || value;
                  }}
                />

                <ReferenceLine
                  yAxisId="bgdrop"
                  x={timeRange.now}
                  stroke="#ff0000"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{ value: 'Now', position: 'top', fontSize: 10, fill: '#ff0000' }}
                />

                {chartData.some(d => d.isAtReset) && (() => {
                  const resetPoint = chartData.find(d => d.isAtReset);
                  return resetPoint ? (
                    <ReferenceLine
                      key="reset"
                      yAxisId="bgdrop"
                      x={resetPoint.timestamp}
                      stroke="#4CAF50"
                      strokeDasharray="6 3"
                      strokeWidth={1.5}
                      label={{
                        value: `${resetLabel} Reset`,
                        position: 'top',
                        fontSize: 10,
                        fill: '#4CAF50',
                      }}
                    />
                  ) : null;
                })()}

                {/* ── Activity Effect Bars (BG drop at session start) ──────────────
                    Recharts <Bar> is broken on XAxis type="number" scale="time":
                    it calculates width from a categorical band scale that doesn't
                    exist on a continuous axis, producing zero-width invisible bars.
                    ReferenceArea is reliable here — it's what the sub-chart already
                    uses for session blocks.
                    Bar width = one chart interpolation interval (e.g. 5 min on 12H
                    view) so it looks proportionally correct at every zoom level.
                    Height = full AOB at t=startMs (absorbed=0 → max expected drop).
                    yAxisId="bgdrop" so the height reads directly in mg/dL. */}
                {showActivityBars && patientConstants && visibleActivities.map((act, i) => {
                  const startMs    = act.timestamp;
                  const barWidthMs = (viewConfig.interpolationInterval * 60 * 1000) / 3;
                  const aobStart   = getActivityOnBoard(act, startMs, patientConstants);
                  const barHeight  = aobStart?.remaining_bg_drop;
                  if (!barHeight) return null;
                  return (
                    <ReferenceArea
                      key={`activity-effect-bar-${i}`}
                      yAxisId="bgdrop"
                      x1={startMs}
                      x2={startMs + barWidthMs}
                      y1={0}
                      y2={barHeight}
                      fill="#1b5e20"
                      fillOpacity={0.70}
                      stroke="#1b5e20"
                      strokeOpacity={0.9}
                      strokeWidth={1}
                    />
                  );
                })}

                {/* ── Session Duration Bars (raw logged input, right axis) ──────
                    Same ReferenceArea technique; height = session duration in
                    minutes on the right (duration) axis. */}
                {showSessionBars && visibleActivities.map((act, i) => {
                  const startMs     = act.timestamp;
                  const durationMin = act.duration_minutes || 30;
                  const durationMs  = durationMin * 60_000; // actual session duration
                  return (
                    <ReferenceArea
                      key={`session-duration-bar-${i}`}
                      yAxisId="duration"
                      x1={startMs}
                      x2={startMs + durationMs}
                      y1={0}
                      y2={durationMin}
                      fill="#43a047"
                      fillOpacity={0.25}
                      stroke="#43a047"
                      strokeOpacity={0.5}
                      strokeWidth={1}
                    />
                  );
                })}

                {showDelivered && (
                  <Area
                    yAxisId="bgdrop"
                    type="monotone"
                    dataKey="deliveredBGDrop"
                    name="deliveredBGDrop"
                    stroke="#00897b"
                    strokeWidth={2.5}
                    fill="url(#actDeliveredGradient)"
                    isAnimationActive={false}
                  />
                )}

                {showActiveRate && (
                  <Line
                    yAxisId="bgdrop"
                    type="monotone"
                    dataKey="activeRate"
                    name="activeRate"
                    stroke="#f57c00"
                    strokeWidth={2.5}
                    strokeDasharray="6 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                )}

                {showAOB && (
                  <Line
                    yAxisId="bgdrop"
                    type="linear"
                    dataKey="aob"
                    name="aob"
                    stroke="#7b1fa2"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                )}

                {/* v3.1: Sensitivity Boost on its own right axis (sensitivity).
                    Domain is fixed 0–100 %, so 60% reads as 60% not 60 mg/dL. */}
                {showSensitivity && (
                  <Line
                    yAxisId="sensitivity"
                    type="monotone"
                    dataKey="sensitivityBoostPct"
                    name="sensitivityBoostPct"
                    stroke="#7b1fa2"
                    strokeWidth={2}
                    strokeDasharray="8 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>

            {stickyTooltip && (
              <div
                className="sticky-tooltip-container"
                style={{
                  position:  'absolute',
                  left:      `${tooltipPosition.left}px`,
                  top:       `${tooltipPosition.top}px`,
                  transform: 'translate(-50%, -100%)',
                  zIndex:    1000,
                }}
              >
                <CustomTooltipContent active={true} payload={[{ payload: stickyTooltip }]} />
              </div>
            )}
          </div>

          {/* ================================================================
              ACTIVITY CONTEXT SUB-CHART
              Time-aligned with the main chart above.  Shows:
              • Intensity mode: swim-lane blocks per session (by intensity tier)
              • HR mode:        same blocks + continuous HR trace line
          ================================================================ */}
          <div style={{
            marginTop: 8,
            borderTop: '1px solid #eeeeee',
            paddingTop: 10,
          }}>
            {/* Sub-chart header row */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 6,
              flexWrap: 'wrap',
            }}>
              {/* Title */}
              <span style={{ fontSize: 12, fontWeight: 600, color: '#444' }}>
                Activity Sessions
              </span>

              {/* Session count + wearable badge */}
              {visibleActivities.length > 0 && (
                <span style={{ fontSize: 10, color: '#888' }}>
                  {visibleActivities.length} session{visibleActivities.length !== 1 ? 's' : ''}
                  {wearableCount > 0 && (
                    <span style={{
                      marginLeft: 6,
                      background: '#e3f2fd',
                      color: '#1565c0',
                      padding: '1px 6px',
                      borderRadius: 3,
                      fontSize: 9,
                    }}>
                      ⌚ {wearableCount} wearable HR
                    </span>
                  )}
                </span>
              )}

              {/* Mode toggle */}
              <div style={{
                display: 'flex',
                border: '1px solid #ddd',
                borderRadius: 6,
                overflow: 'hidden',
                fontSize: 11,
              }}>
                {[
                  { mode: 'intensity', label: '📊 Intensity' },
                  { mode: 'hr',        label: '💗 Heart Rate' },
                  { mode: 'hr_live',   label: '⌚ HR Live' },
                ].map(({ mode, label }) => (
                  <button
                    key={mode}
                    onClick={() => setSubChartMode(mode)}
                    style={{
                      padding:     '3px 12px',
                      background:  subChartMode === mode ? '#1976d2' : 'transparent',
                      color:       subChartMode === mode ? '#fff' : '#555',
                      border:      'none',
                      cursor:      'pointer',
                      fontWeight:  subChartMode === mode ? 600 : 400,
                      fontSize:    11,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Legend */}
              <div style={{
                display: 'flex',
                gap: 10,
                marginLeft: 'auto',
                fontSize: 10,
                color: '#666',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}>
                {Object.entries(INTENSITY_COLORS).map(([k, c]) => (
                  <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{
                      width: 10, height: 10, borderRadius: 2,
                      background: c, opacity: 0.7,
                      display: 'inline-block',
                    }} />
                    {k.charAt(0).toUpperCase() + k.slice(1)}
                  </span>
                ))}
                {subChartMode === 'hr' && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{
                      width: 16, height: 2,
                      background: '#e91e63',
                      display: 'inline-block',
                    }} />
                    HR bpm {wearableCount === 0 ? '(synthetic)' : ''}
                  </span>
                )}
              </div>
            </div>

            {/* Sub-chart: intensity swim lanes (+ optional HR line) — hidden in HR Live mode */}
            {subChartMode !== 'hr_live' && (
            <ResponsiveContainer width="100%" height={130}>
              <ComposedChart
                data={subChartData}
                margin={{
                  top:    4,
                  right:  120,
                  left:   20,
                  bottom: 4,
                }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#f5f5f5"
                  vertical={false}
                />

                {/* Shared time X-axis (hidden — same labels as main chart) */}
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={[timeRange.start, timeRange.end]}
                  ticks={ticks}
                  tickFormatter={formatXAxisLabel}
                  hide
                />

                {/* Left Y-axis: swim-lane labels (Light / Moderate / Vigorous) */}
                <YAxis
                  yAxisId="intensity"
                  domain={[0, 3]}
                  ticks={[0.5, 1.5, 2.5]}
                  tickFormatter={v =>
                    v === 0.5 ? 'Light' : v === 1.5 ? 'Moderate' : v === 2.5 ? 'Vigorous' : ''
                  }
                  stroke="#aaa"
                  fontSize={9}
                  width={62}
                  tickLine={false}
                  axisLine={false}
                />

                {/* Right Y-axis: HR bpm (HR mode only) */}
                {subChartMode === 'hr' && (
                  <YAxis
                    yAxisId="hr"
                    orientation="right"
                    domain={[40, 220]}
                    ticks={[60, 100, 140, 180]}
                    tickFormatter={v => `${v}`}
                    stroke="#e91e63"
                    fontSize={9}
                    width={36}
                    tickLine={false}
                    label={{
                      value: 'bpm',
                      angle: 90,
                      position: 'insideRight',
                      style: { fontSize: 9, fill: '#e91e63' },
                    }}
                  />
                )}

                {/* Subtle lane background shading (always visible) */}
                <ReferenceArea
                  yAxisId="intensity"
                  y1={0} y2={1}
                  fill={INTENSITY_COLORS.light}
                  fillOpacity={0.05}
                  stroke="none"
                />
                <ReferenceArea
                  yAxisId="intensity"
                  y1={1} y2={2}
                  fill={INTENSITY_COLORS.moderate}
                  fillOpacity={0.05}
                  stroke="none"
                />
                <ReferenceArea
                  yAxisId="intensity"
                  y1={2} y2={3}
                  fill={INTENSITY_COLORS.vigorous}
                  fillOpacity={0.05}
                  stroke="none"
                />

                {/* Session blocks — positioned in their intensity swim lane */}
                {subChartAreas.map(area => (
                  <ReferenceArea
                    key={area.key}
                    yAxisId="intensity"
                    x1={area.x1}
                    x2={area.x2}
                    y1={area.y1}
                    y2={area.y2}
                    fill={area.fill}
                    fillOpacity={0.40}
                    stroke={area.fill}
                    strokeWidth={1}
                    strokeOpacity={0.80}
                  />
                ))}

                {/* HR trace line (HR mode only) */}
                {subChartMode === 'hr' && (
                  <Line
                    yAxisId="hr"
                    type="monotone"
                    dataKey="hrValue"
                    name="hrValue"
                    stroke="#e91e63"
                    strokeWidth={1.8}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                )}

                {/* Now reference line */}
                <ReferenceLine
                  yAxisId="intensity"
                  x={timeRange.now}
                  stroke="#ff0000"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              </ComposedChart>
            </ResponsiveContainer>
            )} {/* end subChartMode !== 'hr_live' */}

            {/* Sub-chart footer note */}
            <div style={{
              fontSize: 10,
              color: '#aaa',
              marginTop: 2,
              paddingRight: 4,
              textAlign: 'right',
            }}>
              {subChartMode === 'intensity'
                ? 'Block width = session duration • Lane = intensity tier'
                : wearableCount > 0
                  ? `HR trace: ⌚ wearable data for ${wearableCount} session${wearableCount !== 1 ? 's' : ''}, synthetic for others`
                  : 'HR trace: synthetic (no wearable data) — modeled from intensity + patient HR range'
              }
            </div>
          </div>

          {/* ⌚ HR Live tab — per-second raw trace from watch_hr_routes */}
          {subChartMode === 'hr_live' && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: '#f9f9f9', borderRadius: 8, border: '1px solid #e0e0e0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>⌚ HR Live — Per-Second Watch Trace</span>
                <input
                  type="text"
                  placeholder="Session ID (auto-detected if recording)"
                  value={hrLiveSessionId}
                  onChange={e => setHrLiveSessionId(e.target.value)}
                  style={{ flex: 1, minWidth: 220, padding: '3px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 12 }}
                />
                <button
                  onClick={() => fetchHrLive()}
                  disabled={hrLiveLoading || !hrLiveSessionId.trim()}
                  style={{ padding: '4px 12px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
                >
                  {hrLiveLoading ? '…' : 'Fetch'}
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={hrLiveAutoRefresh}
                    onChange={e => setHrLiveAutoRefresh(e.target.checked)}
                    disabled={!hrLiveSessionId.trim()}
                  />
                  Auto-refresh (5 s)
                </label>
              </div>

              {hrLiveError && (
                <div style={{ color: '#c62828', fontSize: 12, marginBottom: 6 }}>⚠ {hrLiveError}</div>
              )}

              {hrLiveData && (() => {
                const raw = hrLiveData.hr_trace_raw || [];
                const minTrace = hrLiveData.hr_trace || [];
                return (
                  <div>
                    {/* Session metadata */}
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: '#555', marginBottom: 8 }}>
                      <span>⏱ {hrLiveData.duration_minutes != null ? `${hrLiveData.duration_minutes} min` : 'In progress'}</span>
                      <span>🏃 {hrLiveData.intensity || '—'}</span>
                      <span>💓 Base {hrLiveData.hr_base} / Max {hrLiveData.hr_max} bpm</span>
                      <span>📡 {raw.length} raw samples • {minTrace.length} min buckets</span>
                      <span style={{ color: hrLiveData.type === 'in_progress' ? '#e53935' : '#43a047' }}>
                        {hrLiveData.type === 'in_progress' ? '● Recording' : '✓ Completed'}
                      </span>
                    </div>

                    {/* Per-second HR chart */}
                    {raw.length > 0 ? (
                      <ResponsiveContainer width="100%" height={160}>
                        <ComposedChart
                          data={raw.map(s => ({ t_sec: s.t_sec, hr: s.hr_bpm }))}
                          margin={{ top: 4, right: 8, left: -10, bottom: 4 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                          <XAxis
                            dataKey="t_sec"
                            type="number"
                            domain={['dataMin', 'dataMax']}
                            tickFormatter={s => `${Math.floor(s / 60)}m`}
                            tick={{ fontSize: 10 }}
                          />
                          <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} unit=" bpm" width={55} />
                          <Tooltip
                            formatter={(v, n) => [`${v} bpm`, 'HR']}
                            labelFormatter={s => `${Math.floor(s / 60)}m ${s % 60}s`}
                            contentStyle={{ fontSize: 11 }}
                          />
                          <Line
                            type="monotone"
                            dataKey="hr"
                            stroke="#e91e63"
                            strokeWidth={1.2}
                            dot={false}
                            isAnimationActive={false}
                            name="HR (bpm)"
                          />
                          {/* Per-minute average overlay */}
                          {minTrace.map((pt, i) => (
                            <ReferenceLine
                              key={i}
                              x={pt.t_min * 60}
                              stroke="#1976d2"
                              strokeDasharray="2 4"
                              strokeWidth={1}
                              strokeOpacity={0.5}
                              label={i === 0 ? { value: 'min avg', position: 'insideTopRight', fontSize: 9, fill: '#1976d2' } : undefined}
                            />
                          ))}
                        </ComposedChart>
                      </ResponsiveContainer>
                    ) : (
                      <div style={{ color: '#999', fontSize: 12, textAlign: 'center', padding: 20 }}>
                        No per-second samples recorded yet. Start streaming from your watch.
                      </div>
                    )}

                    <div style={{ fontSize: 10, color: '#aaa', marginTop: 4, textAlign: 'right' }}>
                      Pink line = per-second HR • Blue dashes = minute bucket boundaries (used by ODE model)
                    </div>
                  </div>
                );
              })()}

              {!hrLiveData && !hrLiveLoading && !hrLiveError && (
                <div style={{ color: '#999', fontSize: 12, textAlign: 'center', padding: 16 }}>
                  Enter a session ID and click Fetch, or start a ⌚ Watch Session in Activity Recording.
                  <br />
                  <span style={{ fontSize: 10 }}>The session ID appears after starting a watch session.</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default React.memo(ActivityVisualization, (prev, next) =>
  prev.patientId === next.patientId &&
  prev.isDoctor  === next.isDoctor  &&
  prev.embedded  === next.embedded  &&
  prev.height    === next.height
);


/**
 * ============================================================================
 * DESIGN NOTES — ActivityVisualization v3.0
 * ============================================================================
 *
 * AXIS UNIFICATION (v3.0)
 * ────────────────────────
 *  The three visualization types now share a consistent two-layer axis model:
 *
 *  Chart       Left axis (BG effect)    Right axis (raw input)    Bar axis
 *  ──────────  ──────────────────────   ───────────────────────   ──────────
 *  Meal        mg/dL BG Rise            Carbs (g)                 Right
 *  Insulin     mg/dL BG Drop            Units (U)                 Right
 *  Activity    mg/dL BG Drop            Duration (min)            Right ✅ v3.0
 *
 *  In all three charts the bar (dose marker) lives on the right axis, so its
 *  height directly communicates "how much raw input was given" at a glance:
 *    Meal:     bar height = carbs in grams
 *    Insulin:  bar height = units of insulin
 *    Activity: bar height = session duration in minutes  ← v3.0
 *
 *  Why session duration and not BG drop?
 *    Session duration is what the user *logs* — it's the raw input before any
 *    pharmacodynamic model converts it to a BG effect.  This mirrors the pattern
 *    where carbs and units are also what the user logs, with BG impact derived.
 *    The expected BG drop is still shown in the tooltip for precision.
 *
 *  Why sensitivityBoostPct moved to the left axis?
 *    Sensitivity boost (%) is dimensionally a BG modifier, not a time measure.
 *    Placing it on the right (duration) axis made it a "squatter" — semantically
 *    unrelated to the axis label.  On the left axis it reads naturally alongside
 *    the three PD lines and is clearly an optional informational overlay.
 *
 * AOB SEMANTICS
 * ──────────────
 *  AOB (Activity On Board) is semantically identical to MOB (Meal On Board):
 *  both start at their maximum at the event time and decay monotonically to 0
 *  as the effect is delivered.  IOB is different — it rises then decays because
 *  insulin absorption lags.
 *
 *  AOB represents "BG drop still to come" — it is correct that it decreases as
 *  deliveredBGDrop increases (they are inverses summing to the total expected
 *  drop).  The negative direction (BG-lowering vs BG-raising for MOB) is already
 *  semantically encoded in the axis label "BG Drop" and tooltip sign convention.
 *  No special visual treatment is needed.
 *
 * SUB-CHART COORDINATE SYSTEM (unchanged from v2.0)
 * ────────────────────────────
 *  Left Y-axis "intensity" spans domain [0, 3]:
 *    y 0–1 → Light   lane  (green)
 *    y 1–2 → Moderate lane (orange)
 *    y 2–3 → Vigorous lane (red)
 *
 *  Each session is a ReferenceArea placed at:
 *    x1 = session.timestamp (ms)
 *    x2 = session.timestamp + duration_minutes * 60_000 (capped at window end)
 *    y1 = INTENSITY_LANE[intensity]       (0, 1, or 2)
 *    y2 = INTENSITY_LANE[intensity] + 1   (1, 2, or 3)
 *
 *  Tick labels at 0.5, 1.5, 2.5 hit the centre of each lane —
 *  the only reliable way to label ReferenceArea bands in Recharts.
 *
 * HR TRACE DATA
 * ─────────────
 *  `subChartData` is chartData enriched with `hrValue`:
 *    • Non-null only when time falls inside [session.start, session.end].
 *    • Between sessions hrValue = null → Line breaks (connectNulls=false).
 *    • For wearable sessions: actual hr_trace field, format-normalised to
 *      [[t_min, hr_bpm], ...].
 *    • For preset sessions: synthetic trace via buildSyntheticHrTrace(),
 *      matching the shape used by the Python backend and JS ODE solver.
 *    • When two sessions overlap (unlikely), hrValue = Math.max across them.
 *
 * TWO INPUT MODES
 * ───────────────
 *  Preset activities:   intensity + duration → all HR is synthetic.
 *                       Sub-chart shows intensity blocks; HR mode shows
 *                       idealised bell-curve trace.
 *
 *  Wearable activities: intensity + duration + hr_trace[{t_min, hr_bpm}].
 *                       Same intensity blocks; HR mode shows actual recorded
 *                       values with a ⌚ badge.
 *
 * WHY NOT THREE SEPARATE SUB-CHARTS
 * ───────────────────────────────────
 *  Considered: one sub-chart per intensity tier (like pool swim-lane rows).
 *  Rejected: wastes vertical space; empty lanes confuse users with no vigorous
 *  sessions.  The stacked swim-lane approach keeps it compact (130px) while
 *  conveying the same information.
 *
 * FUTURE WORK
 * ───────────
 *  - Hypo-risk overlay: flag time windows where AOB + IOB exceed a threshold
 *    (requires combined Activity + Insulin chart — see next milestone).
 *  - Real-time wearable streaming: update hr_trace live during an active session.
 *  - Click on a session block → show session detail modal.
 *  - Activity + Insulin combined chart using this sub-chart pattern.
 * ============================================================================
 */