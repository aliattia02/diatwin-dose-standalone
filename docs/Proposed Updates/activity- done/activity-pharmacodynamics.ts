/**
 * activity-pharmacodynamics.ts — Dalla Man / Breton HR-Informed Exercise Model
 * =============================================================================
 * Replaces the previous categorical Gaussian model with the physiologically
 * grounded Y/Z/W ODE system (Dalla Man, Breton, Cobelli 2009; Romeres et al. 2021).
 *
 * BIMODAL MECHANISM
 * ─────────────────
 *   ① ACUTE DIRECT EFFECT (IIRd — insulin-independent glucose uptake)
 *      Driven by state variable Z. Contracting muscles consume glucose via
 *      GLUT4 transport regardless of insulin. Fast onset, decays with τ_Z ≈ 10 min
 *      after exercise ends. → cumulative_activity_effect (negative mg/dL)
 *
 *   ② PROLONGED SENSITIVITY EFFECT (IDRd — insulin-dependent)
 *      Driven by W (integral of Y over time). GLUT4 upregulation persists for
 *      hours post-exercise. Slow decay τ_W ≈ 90 min. → sensitivity_multiplier
 *      on correction_factor / carb_to_bg_ratio
 *
 * STATE VARIABLES (Euler integration, dt = 1 min)
 * ───────────────────────────────────────────────
 *   Y = filtered HR above baseline  (energy expenditure proxy)
 *   Z = acute IIRd signal           (fast-on during exercise, slow-off after)
 *   W = cumulative load ∫Y dt       (intensity × duration jointly)
 *
 * INPUT PRIORITY
 * ──────────────
 *   1. hr_trace — HRSample[] from wearable (Garmin / Fitbit / Apple Watch)
 *   2. intensity + duration_minutes — categorical fallback (synthetic trace built automatically)
 *
 * Mirrors: backend/utils/activity_pharmacodynamics.py (Python, v2.0)
 *
 * References:
 *   Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
 *   Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
 *   Breton MD                       — J Diabetes Sci Technol 2008;2(1):169-174
 *
 * @module utils/calculations/activity-pharmacodynamics
 * @version 2.0 (HR ODE Model)
 */

import type { PatientConstants } from '@/types/constants.types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActivityIntensity = 'light' | 'moderate' | 'vigorous';

/** Optional wearable HR sample — t_min relative to activity start */
export interface HRSample {
  t_min:  number;   // minutes from activity start
  hr_bpm: number;   // absolute HR in beats per minute
}

/** Normalized activity log — use normalizeActivityRecord() on legacy records */
export interface ActivityLog {
  _id?: string;
  /** UTC start timestamp */
  timestamp: Date | string;
  /** Session duration in minutes */
  duration_minutes: number;
  intensity: ActivityIntensity;
  /** Optional CGM-measured BG drop override (bypasses model) */
  bg_drop_override?: number;
  /** Wearable HR trace — if present, used instead of synthetic trace */
  hr_trace?: HRSample[];
  /** Patient resting HR (default 70 bpm) */
  hr_base?: number;
  /** Patient max HR (default 190 bpm) */
  hr_max?: number;
}

/** Raw record from the activities MongoDB collection */
export interface RawActivityRecord {
  _id?: string;
  /** Integer level: −2→2 */
  level?: number;
  /** Actual exercise start time */
  startTime?: Date | string;
  endTime?: Date | string;
  completedTime?: Date | string;
  /** Record creation time (fallback only) */
  timestamp?: Date | string;
  /** "HH:MM" formatted string */
  duration?: string;
  /** Direct overrides for new-style records */
  intensity?: ActivityIntensity;
  duration_minutes?: number;
  hr_trace?: HRSample[];
  hr_base?: number;
  hr_max?: number;
  bg_drop_override?: number;
  type?: 'expected' | 'completed';
}

/** Internal ODE state triple */
interface ODEState {
  Y: number;
  Z: number;
  W: number;
}

export interface ActivityCumulativeResult {
  cumulative_activity_effect: number;         // negative mg/dL
  sensitivity_multiplier: number;             // >= 1.0
  activity_on_board: number;                  // remaining drop still to come
  activity_contributions: ActivityContribution[];
  active_sessions: number;
}

export interface ActivityContribution {
  activity_id: string;
  start_time: string;
  intensity: ActivityIntensity;
  duration_minutes: number;
  cumulative_bg_effect: number;
  remaining_bg_drop: number;
  absorbed_fraction: number;
  is_active: boolean;
  model: 'hr_ode' | 'synthetic_hr';
}

export interface ActivityOnBoard {
  remaining_bg_drop: number;
  absorbed_fraction: number;
  minutes_elapsed: number;
  is_active: boolean;
  intensity: ActivityIntensity;
}

// ─── HR ODE Model Constants ───────────────────────────────────────────────────

const HR_MODEL = {
  tau_HR:               5,     // Low-pass filter time constant for HR→Y (min)
  tau_Z:               10,     // Z decay after exercise ends (min)
  tau_W:               90,     // W recovery decay (min)
  a:                    0.05,  // Exercise-onset threshold (fraction of HRb)
  alpha:                0.0008,// W·Z → sensitivity multiplier scaling factor
  max_sensitivity_boost:0.60,  // Hard cap: 60% boost max
  dt:                   1,     // Euler integration step (min)
  acute_rate_per_min:   0.15,  // mg/dL per minute at Z=1 (calibrated)
  hr_max_pop:         190,     // Population reference HRmax (bpm)
  hr_base_pop:         70,     // Population resting HR (bpm)
} as const;

/** HR as fraction of (HRmax − HRbase) above HRbase for each categorical intensity */
const INTENSITY_HR_FRACTION: Record<ActivityIntensity, number> = {
  light:    0.50,   // ~50% HRmax → HR ≈ 130 bpm at population values
  moderate: 0.65,   // ~65% HRmax → HR ≈ 154 bpm
  vigorous: 0.80,   // ~80% HRmax → HR ≈ 178 bpm
};

/**
 * Map legacy integer level → intensity string.
 * Levels ≤ −1 (sedentary / sick) return null — skip for BG effect.
 */
const LEVEL_TO_INTENSITY: Record<number, ActivityIntensity | null> = {
  [-2]: null,        // mode 1 — sedentary / illness
  [-1]: null,        // mode 2 — below-normal activity
  [0]:  'light',     // Normal Activity
  [1]:  'moderate',  // High Activity
  [2]:  'vigorous',  // Vigorous Activity
};

const DEFAULT_INTENSITY: ActivityIntensity = 'moderate';

// ─── Normalization: raw activity record → ActivityLog ─────────────────────────

function parseTimestamp(ts: Date | string | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return new Date(ts.getTime());
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function parseDurationField(duration: string | number | undefined): number {
  if (!duration) return 30;
  if (typeof duration === 'number') return duration * 60; // assume hours
  const parts = String(duration).split(':');
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  return parseFloat(parts[0]) * 60;
}

/**
 * Convert a raw record from the activities collection to a normalized ActivityLog.
 * Returns null when the record should be skipped (sedentary level, missing start).
 */
export function normalizeActivityRecord(raw: RawActivityRecord): ActivityLog | null {
  // ── Resolve intensity ────────────────────────────────────────────────────
  let intensity: ActivityIntensity;
  if (raw.intensity) {
    intensity = raw.intensity;
  } else if (raw.level !== undefined) {
    const mapped = LEVEL_TO_INTENSITY[raw.level];
    if (mapped === null || mapped === undefined) return null; // sedentary — skip
    intensity = mapped;
  } else {
    return null;
  }

  // ── Resolve start time ───────────────────────────────────────────────────
  const startTime =
    parseTimestamp(raw.startTime) ??
    parseTimestamp(raw.completedTime) ??
    parseTimestamp(raw.timestamp);
  if (!startTime) return null;

  // ── Resolve duration ─────────────────────────────────────────────────────
  let durationMinutes: number;
  if (raw.duration_minutes) {
    durationMinutes = raw.duration_minutes;
  } else if (raw.endTime) {
    const endTime = parseTimestamp(raw.endTime);
    if (endTime && endTime > startTime) {
      durationMinutes = (endTime.getTime() - startTime.getTime()) / 60_000;
    } else {
      durationMinutes = parseDurationField(raw.duration);
    }
  } else {
    durationMinutes = parseDurationField(raw.duration);
  }

  durationMinutes = Math.max(1, durationMinutes);

  const log: ActivityLog = {
    _id:              raw._id,
    timestamp:        startTime,
    duration_minutes: durationMinutes,
    intensity,
  };

  if (raw.hr_trace)         log.hr_trace        = raw.hr_trace;
  if (raw.hr_base)          log.hr_base          = raw.hr_base;
  if (raw.hr_max)           log.hr_max           = raw.hr_max;
  if (raw.bg_drop_override) log.bg_drop_override = raw.bg_drop_override;

  return log;
}

// ─── Synthetic HR trace ───────────────────────────────────────────────────────

function buildSyntheticTrace(
  intensity: ActivityIntensity,
  durationMinutes: number,
  hrMax: number = HR_MODEL.hr_max_pop,
  hrBase: number = HR_MODEL.hr_base_pop,
): [number, number][] {
  const frac     = INTENSITY_HR_FRACTION[intensity];
  const targetHR = hrBase + frac * (hrMax - hrBase);
  const ramp     = 3;
  const cool     = 5;
  const trace: [number, number][] = [];

  for (let t = 0; t <= durationMinutes + cool + 1; t++) {
    let hr: number;
    if (t < ramp) {
      hr = hrBase + (targetHR - hrBase) * (t / ramp);
    } else if (t <= durationMinutes) {
      hr = targetHR;
    } else {
      const tCool = t - durationMinutes;
      hr = hrBase + (targetHR - hrBase) * Math.exp(-tCool / 4);
    }
    trace.push([t, Math.max(hrBase, hr)]);
  }
  return trace;
}

function getTraceFromActivity(activity: ActivityLog): [number, number][] {
  const hrBase = activity.hr_base ?? HR_MODEL.hr_base_pop;
  const hrMax  = activity.hr_max  ?? HR_MODEL.hr_max_pop;

  if (activity.hr_trace?.length) {
    return activity.hr_trace.map(s => [s.t_min, s.hr_bpm]);
  }
  return buildSyntheticTrace(
    activity.intensity ?? DEFAULT_INTENSITY,
    activity.duration_minutes,
    hrMax, hrBase
  );
}

// ─── HR interpolation ─────────────────────────────────────────────────────────

function interpolateHR(
  trace: [number, number][],
  t: number,
  hrBase: number,
): number {
  if (!trace.length) return hrBase;
  if (t <= trace[0][0]) return trace[0][1];
  for (let i = 0; i < trace.length - 1; i++) {
    const [t0, h0] = trace[i];
    const [t1, h1] = trace[i + 1];
    if (t >= t0 && t <= t1) {
      const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return h0 + frac * (h1 - h0);
    }
  }
  return hrBase;
}

// ─── Core ODE simulation ──────────────────────────────────────────────────────

function simulateODE(
  trace: [number, number][],
  elapsedMinutes: number,
  hrBase: number,
): ODEState {
  let Y = 0, Z = 0, W = 0;
  const { dt, tau_HR, tau_Z, tau_W, a } = HR_MODEL;
  const threshold = hrBase * (1 + a);
  const lastT = trace[trace.length - 1]?.[0] ?? 0;
  const steps  = Math.ceil(elapsedMinutes / dt);

  for (let i = 0; i < steps; i++) {
    const t   = i * dt;
    const hr  = interpolateHR(trace, Math.min(t, lastT), hrBase);
    const hrAbove     = Math.max(0, hr - hrBase);
    const inExercise  = t <= lastT && hr > threshold;
    const onsetActive = Y > a * hrBase;

    const dY = (hrAbove / tau_HR) - (Y / tau_HR);
    Y = Math.max(0, Y + dY * dt);

    const dZ = (inExercise && onsetActive) ? (1 - Z) : (-Z / tau_Z);
    Z = Math.min(1, Math.max(0, Z + dZ * dt));

    const dW = inExercise ? Y : (-W / tau_W);
    W = Math.max(0, W + dW * dt);
  }

  return { Y, Z, W };
}

/**
 * Integrate Z × acute_rate over [fromMinute, toMinute] to compute BG drop (positive).
 * Runs the full ODE internally so all states are consistent.
 */
function integrateZDrop(
  trace: [number, number][],
  fromMinute: number,
  toMinute: number,
  hrBase: number,
  weightKg?: number,
): number {
  if (toMinute <= fromMinute) return 0;

  let Y = 0, Z = 0, W = 0;
  const { dt, tau_HR, tau_Z, tau_W, a, acute_rate_per_min } = HR_MODEL;
  const threshold = hrBase * (1 + a);
  const lastT  = trace[trace.length - 1]?.[0] ?? 0;
  const steps  = Math.ceil(toMinute / dt);
  let totalDrop = 0;

  for (let i = 0; i < steps; i++) {
    const t  = i * dt;
    const hr = interpolateHR(trace, Math.min(t, lastT), hrBase);
    const hrAbove     = Math.max(0, hr - hrBase);
    const inExercise  = t <= lastT && hr > threshold;
    const onsetActive = Y > a * hrBase;

    const dY = (hrAbove / tau_HR) - (Y / tau_HR);
    Y = Math.max(0, Y + dY * dt);

    const dZ = (inExercise && onsetActive) ? (1 - Z) : (-Z / tau_Z);
    Z = Math.min(1, Math.max(0, Z + dZ * dt));

    const dW = inExercise ? Y : (-W / tau_W);
    W = Math.max(0, W + dW * dt);

    if (t >= fromMinute) {
      totalDrop += Z * acute_rate_per_min * dt;
    }
  }

  if (weightKg) totalDrop *= (70 / weightKg) ** 0.25;
  return totalDrop;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Cumulative BG-lowering effect of a single activity session up to currentTime.
 * Returns a NEGATIVE value (mg/dL) — same convention as cumulative_insulin_effect.
 */
export function calculateActivityCumulativeEffect(
  activity: ActivityLog,
  currentTime: Date,
  patientConstants: PatientConstants,
): number {
  const startTime = parseTimestamp(activity.timestamp);
  if (!startTime || currentTime < startTime) return 0;

  // CGM-measured override bypasses the model
  if (activity.bg_drop_override !== undefined) {
    const durationMinutes = activity.duration_minutes;
    const tail = durationMinutes * 0.4;
    const elapsed = (currentTime.getTime() - startTime.getTime()) / 60_000;
    const frac = Math.min(1, Math.max(0, elapsed / (durationMinutes + tail)));
    return parseFloat((-activity.bg_drop_override * frac).toFixed(2));
  }

  const hrBase    = activity.hr_base ?? HR_MODEL.hr_base_pop;
  const weightKg  = (patientConstants as any).weight_kg as number | undefined;
  const trace     = getTraceFromActivity(activity);
  const elapsed   = (currentTime.getTime() - startTime.getTime()) / 60_000;
  const postTail  = 4 * HR_MODEL.tau_Z;
  const scanTo    = Math.min(elapsed, activity.duration_minutes + postTail);

  const drop = integrateZDrop(trace, 0, scanTo, hrBase, weightKg);
  return parseFloat((-drop).toFixed(2));
}

/**
 * Activity On Board (AOB) — remaining acute BG-lowering effect still to deliver.
 */
export function getActivityOnBoard(
  activity: ActivityLog,
  currentTime: Date,
  patientConstants: PatientConstants,
): ActivityOnBoard {
  const startTime = parseTimestamp(activity.timestamp);
  const intensity  = activity.intensity ?? DEFAULT_INTENSITY;
  const hrBase     = activity.hr_base ?? HR_MODEL.hr_base_pop;
  const weightKg   = (patientConstants as any).weight_kg as number | undefined;
  const trace      = getTraceFromActivity(activity);
  const lastT      = trace[trace.length - 1]?.[0] ?? activity.duration_minutes;
  const fullWindow = lastT + 4 * HR_MODEL.tau_Z;

  const elapsed = startTime
    ? Math.max(0, (currentTime.getTime() - startTime.getTime()) / 60_000)
    : 0;

  const totalDrop   = integrateZDrop(trace, 0, fullWindow, hrBase, weightKg);
  const elapsedDrop = integrateZDrop(trace, 0, Math.min(elapsed, fullWindow), hrBase, weightKg);

  const absorbed  = totalDrop > 0 ? Math.min(1, elapsedDrop / totalDrop) : 1;
  const remaining = Math.max(0, totalDrop * (1 - absorbed));

  return {
    remaining_bg_drop: parseFloat(remaining.toFixed(1)),
    absorbed_fraction: parseFloat(absorbed.toFixed(3)),
    minutes_elapsed:   parseFloat(elapsed.toFixed(1)),
    is_active:         elapsed < activity.duration_minutes,
    intensity,
  };
}

/**
 * Post-exercise ISF/CR sensitivity multiplier from the W state variable.
 * Sensitivity = 1.0 + α · W · (1 + Z), capped at max_sensitivity_boost.
 * Takes the maximum across all sessions.
 */
export function calculateActivitySensitivityMultiplier(
  activities: ActivityLog[],
  currentTime: Date,
): number {
  const { alpha, max_sensitivity_boost } = HR_MODEL;
  let best = 1.0;

  for (const activity of activities) {
    const startTime = parseTimestamp(activity.timestamp);
    if (!startTime || currentTime < startTime) continue;

    const elapsed = (currentTime.getTime() - startTime.getTime()) / 60_000;
    if (elapsed > 8 * 60) continue; // beyond 8h — W has fully decayed

    const hrBase = activity.hr_base ?? HR_MODEL.hr_base_pop;
    const trace  = getTraceFromActivity(activity);
    const { Z, W } = simulateODE(trace, elapsed, hrBase);

    const boost      = Math.min(alpha * W * (1 + Z), max_sensitivity_boost);
    const multiplier = parseFloat((1.0 + boost).toFixed(4));
    best = Math.max(best, multiplier);
  }

  return best;
}

/**
 * Return a modified copy of patientConstants with ISF and carb_to_bg_ratio
 * scaled by the current activity sensitivity multiplier.
 * The original object is NOT mutated.
 */
export function applyActivitySensitivity(
  patientConstants: PatientConstants,
  activities: ActivityLog[],
  currentTime: Date,
): PatientConstants {
  const multiplier = calculateActivitySensitivityMultiplier(activities, currentTime);
  if (multiplier === 1.0) return patientConstants;

  const modified = { ...patientConstants } as any;

  if (modified.correction_factor !== undefined) {
    modified.correction_factor = parseFloat((modified.correction_factor * multiplier).toFixed(2));
  }
  if (modified.carb_to_bg_ratio !== undefined) {
    modified.carb_to_bg_ratio = parseFloat((modified.carb_to_bg_ratio / multiplier).toFixed(2));
  }

  return modified as PatientConstants;
}

/**
 * Combine all activity sessions into a single result.
 *
 * Plug cumulative_activity_effect directly into cumulative_net_baseline:
 *   net = meal_effect + insulin_effect + cumulative_activity_effect
 *
 * Pass normalized ActivityLog[] — use normalizeActivityRecord() on raw records.
 */
export function calculateStackedActivityEffect(
  activities: ActivityLog[],
  currentTime: Date,
  patientConstants: PatientConstants,
): ActivityCumulativeResult {
  let cumulativeEffect = 0;
  let totalAob         = 0;
  let activeSessions   = 0;
  const contributions: ActivityContribution[] = [];

  for (const activity of activities) {
    const effect = calculateActivityCumulativeEffect(activity, currentTime, patientConstants);
    const aob    = getActivityOnBoard(activity, currentTime, patientConstants);

    cumulativeEffect += effect;
    totalAob         += aob.remaining_bg_drop;
    if (aob.is_active) activeSessions++;

    const startTime = parseTimestamp(activity.timestamp);
    contributions.push({
      activity_id:        activity._id ?? '',
      start_time:         startTime?.toISOString() ?? '',
      intensity:          activity.intensity ?? DEFAULT_INTENSITY,
      duration_minutes:   activity.duration_minutes,
      cumulative_bg_effect: parseFloat(effect.toFixed(1)),
      remaining_bg_drop:  aob.remaining_bg_drop,
      absorbed_fraction:  aob.absorbed_fraction,
      is_active:          aob.is_active,
      model:              activity.hr_trace?.length ? 'hr_ode' : 'synthetic_hr',
    });
  }

  return {
    cumulative_activity_effect: parseFloat(cumulativeEffect.toFixed(1)),
    sensitivity_multiplier:     calculateActivitySensitivityMultiplier(activities, currentTime),
    activity_on_board:          parseFloat(totalAob.toFixed(1)),
    activity_contributions:     contributions,
    active_sessions:            activeSessions,
  };
}
