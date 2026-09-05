/**
 * =============================================================================
 * activityPharmacodynamics.js — Dalla Man / Breton HR-Informed Exercise Model
 * =============================================================================
 *
 * JavaScript port of backend/utils/activity_pharmacodynamics.py.
 * Implements the Y/Z/W ODE system (Dalla Man, Breton, Cobelli 2009).
 *
 * BIMODAL MECHANISM
 * ─────────────────
 *  ① ACUTE DIRECT EFFECT (IIRd)  → Z state → cumulative_activity_effect (mg/dL)
 *  ② PROLONGED SENSITIVITY (IDRd) → W state → sensitivity_multiplier (ISF/CR boost)
 *
 * STATE VARIABLES (Euler, dt = 1 min)
 * ─────────────────────────────────────
 *  Y  dY/dt = (HRabove / τ_HR) − (Y / τ_HR)
 *  Z  dZ/dt = (1 − Z)   in-exercise + Y > a·HRbase
 *           = −Z / τ_Z  recovery
 *  W  dW/dt = Y         in-exercise
 *           = −W / τ_W  recovery
 *
 * References:
 *   Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
 *   Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
 *   Breton MD                       — J Diabetes Sci Technol 2008;2(1):169-174
 *
 * Version: 1.1
 * Changes in 1.1:
 *   - calculateActivitySensitivityMultiplier: skip activities that started before
 *     the patient's daily reset time (mirrors delivered-drop / IOB reset behaviour).
 *     The reset boundary is computed from pc.daily_reset_hour + pc.timezone_offset_minutes,
 *     matching _resolve_reset_time() in the Python backend.
 * =============================================================================
 */

import { SHARED_CONSTANTS } from '../constants/shared_constants';

// ─── Constants (sourced from shared_constants, not duplicated) ─────────────────

const HR_MODEL         = SHARED_CONSTANTS.HR_MODEL;
const INTENSITY_HR_FRACTION = SHARED_CONSTANTS.INTENSITY_HR_FRACTION;
const LEVEL_TO_INTENSITY    = SHARED_CONSTANTS.LEVEL_TO_INTENSITY;


// ─── Helpers: timestamp & duration parsing ─────────────────────────────────────

/**
 * Parse a Date, number (ms), or ISO string to milliseconds (UTC).
 * Mirrors Python _parse_dt(). Returns null on failure.
 * Bare ISO strings without tz info are treated as UTC (matches Python/TS port).
 */
function parseDt(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Bare ISO (no tz marker) → treat as UTC, appending 'Z'
    const normalized = /[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : value + 'Z';
    const ms = new Date(normalized).getTime();
    return isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Parse 'HH:MM' or numeric string → total minutes.
 */
function parseDurationField(str) {
  if (!str) return 30;
  const parts = String(str).split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  const n = parseFloat(parts[0]);
  return isNaN(n) ? 30 : n * 60;
}


// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Convert a raw activity record (from API or local state) to the standard
 * ActivityLog format expected by the ODE functions.
 *
 * Returns null for sedentary levels (≤ −1) or invalid records.
 * Mirrors normalize_activity_record() in the Python backend.
 */
export function normalizeActivityRecord(raw) {
  if (!raw) return null;

  // ── Resolve intensity ──────────────────────────────────────────────────────
  let intensity;
  if (raw.intensity && INTENSITY_HR_FRACTION[raw.intensity] !== undefined) {
    intensity = raw.intensity;
  } else {
    const level = raw.level != null ? parseInt(raw.level, 10) : null;
    if (level === null) return null;
    // LEVEL_TO_INTENSITY keys are strings in the JSON constant
    intensity = LEVEL_TO_INTENSITY[String(level)];
    if (intensity === null || intensity === undefined) return null; // sedentary
  }

  // ── Resolve start timestamp (ms) ──────────────────────────────────────────
  const startRaw = raw.startTime ?? raw.completedTime ?? raw.timestamp;
  const startMs  = parseDt(startRaw);
  if (startMs === null) return null;

  // ── Resolve duration ───────────────────────────────────────────────────────
  let durationMinutes;
  if (raw.duration_minutes) {
    durationMinutes = parseFloat(raw.duration_minutes);
  } else if (raw.endTime) {
    const endMs = parseDt(raw.endTime);
    if (endMs && endMs > startMs) {
      durationMinutes = (endMs - startMs) / 60000;
    } else {
      durationMinutes = parseDurationField(raw.duration || '00:30');
    }
  } else {
    durationMinutes = parseDurationField(raw.duration || '00:30');
  }
  durationMinutes = Math.max(1, durationMinutes);

  const normalized = {
    _id:             String(raw._id || raw.id || ''),
    timestamp:       startMs,   // stored as ms in JS (vs datetime in Python)
    duration_minutes: durationMinutes,
    intensity,
    bg_direction:    parseInt(raw.bg_direction ?? -1, 10),
  };

  for (const key of ['hr_trace', 'hr_base', 'hr_max', 'bg_drop_override']) {
    if (raw[key] !== undefined) normalized[key] = raw[key];
  }

  return normalized;
}


// ─── Synthetic HR trace builder ────────────────────────────────────────────────

/**
 * Build a (t_min, hr_bpm) array for the given intensity tier.
 * Mirrors Python _synthetic_hr_trace().
 * Shape: 2-min ramp → flat plateau → last sample at duration end.
 */
function buildSyntheticTrace(intensity, durationMinutes, hrMax, hrBase) {
  const fraction = INTENSITY_HR_FRACTION[intensity] ?? INTENSITY_HR_FRACTION.moderate;
  const peakHr   = hrBase + fraction * (hrMax - hrBase);
  const rampEnd  = Math.min(2.0, durationMinutes * 0.1);
  return [
    [0,              hrBase],
    [rampEnd,        peakHr],
    [durationMinutes, peakHr],
  ];
}

function getPatientHrDefaults(pc) {
  return {
    hrBase: parseFloat(pc?.hr_base || HR_MODEL.hr_base_pop),
    hrMax:  parseFloat(pc?.hr_max  || HR_MODEL.hr_max_pop),
  };
}

/**
 * Return the HR trace for an activity (wearable → synthetic fallback).
 * Returns array of [t_min, hr_bpm] tuples.
 */
function getTraceFromActivity(activity, pc) {
  if (activity.hr_trace && activity.hr_trace.length > 0) {
    return activity.hr_trace.map(s => [s.t_min, s.hr_bpm]);
  }
  const { hrBase: pHrBase, hrMax: pHrMax } = getPatientHrDefaults(pc);
  const hrBase = parseFloat(activity.hr_base || pHrBase);
  const hrMax  = parseFloat(activity.hr_max  || pHrMax);
  return buildSyntheticTrace(activity.intensity ?? 'moderate', activity.duration_minutes ?? 30, hrMax, hrBase);
}


// ─── Core ODE integration ──────────────────────────────────────────────────────

/** Linear interpolation of HR at time t from trace. Returns hrBase outside range. */
function interpolateHr(trace, t, hrBase) {
  if (!trace || trace.length === 0) return hrBase;
  if (t <= trace[0][0]) return trace[0][1];
  if (t >= trace[trace.length - 1][0]) return hrBase;
  for (let i = 0; i < trace.length - 1; i++) {
    const [t0, h0] = trace[i];
    const [t1, h1] = trace[i + 1];
    if (t0 <= t && t <= t1) {
      const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return h0 + frac * (h1 - h0);
    }
  }
  return hrBase;
}

/**
 * Euler-integrate Y/Z/W ODEs up to `elapsedMin` minutes.
 * Returns { Y, Z, W }.
 * Mirrors Python _simulate_hr_ode().
 */
function simulateHrOde(trace, elapsedMin, hrBase) {
  let Y = 0, Z = 0, W = 0;
  const { tau_HR, tau_Z, tau_W, a, dt } = HR_MODEL;
  const threshold = hrBase * (1 + a);
  const lastT     = trace.length > 0 ? trace[trace.length - 1][0] : 0;
  const steps     = Math.ceil(elapsedMin / dt);

  for (let i = 0; i < steps; i++) {
    const t        = i * dt;
    const hr       = interpolateHr(trace, Math.min(t, lastT), hrBase);
    const hrAbove  = Math.max(0, hr - hrBase);
    const inEx     = (t <= lastT) && (hr > threshold);
    const onsetOk  = Y > a * hrBase;

    const dY = (hrAbove / tau_HR) - (Y / tau_HR);
    Y = Math.max(0, Y + dY * dt);

    const dZ = (inEx && onsetOk) ? (1 - Z) : (-Z / tau_Z);
    Z = Math.min(1, Math.max(0, Z + dZ * dt));

    const dW = inEx ? Y : (-W / tau_W);
    W = Math.max(0, W + dW * dt);
  }
  return { Y, Z, W };
}

/**
 * Integrate Z * acute_rate_per_min from fromMin to toMin.
 * Returns UNSIGNED magnitude (sign applied by caller via bg_direction).
 * Mirrors Python _integrate_z_drop().
 */
function integrateZDrop(trace, fromMin, toMin, hrBase, weightKg) {
  if (toMin <= fromMin) return 0;

  let Y = 0, Z = 0, W = 0;
  const { tau_HR, tau_Z, tau_W, a, dt, acute_rate_per_min } = HR_MODEL;
  const threshold  = hrBase * (1 + a);
  const lastT      = trace.length > 0 ? trace[trace.length - 1][0] : 0;
  const steps      = Math.ceil(toMin / dt);
  let totalDrop    = 0;

  for (let i = 0; i < steps; i++) {
    const t       = i * dt;
    const hr      = interpolateHr(trace, Math.min(t, lastT), hrBase);
    const hrAbove = Math.max(0, hr - hrBase);
    const inEx    = (t <= lastT) && (hr > threshold);
    const onsetOk = Y > a * hrBase;

    const dY = (hrAbove / tau_HR) - (Y / tau_HR);
    Y = Math.max(0, Y + dY * dt);

    const dZ = (inEx && onsetOk) ? (1 - Z) : (-Z / tau_Z);
    Z = Math.min(1, Math.max(0, Z + dZ * dt));

    const dW = inEx ? Y : (-W / tau_W);
    W = Math.max(0, W + dW * dt);

    if (t >= fromMin) {
      totalDrop += Z * acute_rate_per_min * dt;
    }
  }

  // Allometric weight scaling (heavier patients → smaller per-kg BG drop)
  if (weightKg && weightKg > 0) {
    totalDrop *= Math.pow(70 / weightKg, 0.25);
  }

  return totalDrop; // always ≥ 0
}


// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Signed BG effect of a single activity session up to currentTimeMs.
 * Sign from activity.bg_direction: −1 = lowers BG (aerobic), +1 = raises.
 * Returns 0 when the session is in the future or has no effect.
 * Mirrors Python calculate_activity_cumulative_effect().
 *
 * @param {object} activity   - Normalized activity record (from normalizeActivityRecord)
 * @param {number} currentTimeMs - Current time in milliseconds
 * @param {object} pc         - Patient constants
 * @returns {number} Signed BG effect in mg/dL
 */
export function calculateActivityCumulativeEffect(activity, currentTimeMs, pc) {
  const startMs = activity.timestamp;
  if (!startMs || currentTimeMs < startMs) return 0;

  const bgDir = parseInt(activity.bg_direction ?? -1, 10);

  // CGM-measured override (bypasses ODE)
  if (activity.bg_drop_override != null) {
    const dropMag = parseFloat(activity.bg_drop_override);
    const dur     = parseFloat(activity.duration_minutes ?? 30);
    const tail    = dur * 0.4;
    const elapsed = (currentTimeMs - startMs) / 60000;
    const frac    = Math.min(1, Math.max(0, elapsed / (dur + tail)));
    return Math.round(bgDir * dropMag * frac * 100) / 100;
  }

  const { hrBase: pHrBase } = getPatientHrDefaults(pc);
  const hrBase  = parseFloat(activity.hr_base ?? pHrBase);
  const weightKg = pc?.weight_kg;
  const trace    = getTraceFromActivity(activity, pc);
  const elapsed  = (currentTimeMs - startMs) / 60000;
  const postTail = 4 * HR_MODEL.tau_Z;
  const scanTo   = Math.min(elapsed, parseFloat(activity.duration_minutes ?? 30) + postTail);

  const magnitude = integrateZDrop(trace, 0, scanTo, hrBase, weightKg);
  return Math.round(bgDir * magnitude * 100) / 100;
}

/**
 * Activity On Board — remaining acute BG effect still to be delivered.
 * Mirrors Python get_activity_on_board().
 *
 * @returns {{ remaining_bg_drop, absorbed_fraction, minutes_elapsed, is_active, intensity, bg_direction }}
 */
export function getActivityOnBoard(activity, currentTimeMs, pc) {
  const startMs        = activity.timestamp;
  const intensity      = activity.intensity ?? 'moderate';
  const durationMin    = parseFloat(activity.duration_minutes ?? 30);
  const bgDir          = parseInt(activity.bg_direction ?? -1, 10);
  const { hrBase: pHrBase } = getPatientHrDefaults(pc);
  const hrBase         = parseFloat(activity.hr_base ?? pHrBase);
  const weightKg       = pc?.weight_kg;
  const trace          = getTraceFromActivity(activity, pc);
  const lastTraceT     = trace.length > 0 ? trace[trace.length - 1][0] : durationMin;
  const fullWindow     = lastTraceT + 4 * HR_MODEL.tau_Z;

  if (!startMs) {
    return { remaining_bg_drop: 0, absorbed_fraction: 0, minutes_elapsed: 0, is_active: false, intensity, bg_direction: bgDir };
  }

  const elapsed     = Math.max(0, (currentTimeMs - startMs) / 60000);
  const totalDrop   = integrateZDrop(trace, 0, fullWindow, hrBase, weightKg);
  const elapsedDrop = integrateZDrop(trace, 0, Math.min(elapsed, fullWindow), hrBase, weightKg);

  const absorbed  = totalDrop > 0 ? Math.min(1, Math.max(0, elapsedDrop / totalDrop)) : 1;
  const remaining = Math.max(0, totalDrop * (1 - absorbed));

  return {
    remaining_bg_drop: Math.round(remaining * 10) / 10,
    absorbed_fraction: Math.round(absorbed * 1000) / 1000,
    minutes_elapsed:   Math.round(elapsed * 10) / 10,
    is_active:         elapsed < durationMin,
    intensity,
    bg_direction:      bgDir,
  };
}

/**
 * Post-exercise ISF/CR sensitivity multiplier from W state variable.
 * Uses max() across sessions (GLUT4 doesn't stack additively).
 * Returns float ≥ 1.0.  Only considers sessions within last 8 hours AND
 * within the current day's reset window (sensitivity clears at the daily
 * reset boundary, matching the delivered-drop and IOB reset behaviour).
 * Mirrors Python calculate_activity_sensitivity_multiplier().
 *
 * @param {Array}  activities    - Normalized activity records
 * @param {number} currentTimeMs - Current time in milliseconds
 * @param {object} pc            - Patient constants
 * @returns {number}
 */
export function calculateActivitySensitivityMultiplier(activities, currentTimeMs, pc = {}) {
  const { alpha, max_sensitivity_boost } = HR_MODEL;
  let best = 1.0;

  // ── Compute today's reset boundary (UTC-anchored with tz offset) ────────────
  // Mirrors _resolve_reset_time() in the Python backend and the
  // TimeManager.getDailyResetTime() logic used throughout the chart layer.
  const resetHour   = pc?.daily_reset_hour       ?? 7;
  const tzOffsetMin = pc?.timezone_offset_minutes ?? 0;
  // Shift to "patient local" time so we can find the correct calendar day
  const localMs     = currentTimeMs + tzOffsetMin * 60_000;
  const localNow    = new Date(localMs);
  const localResetMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    resetHour, 0, 0, 0,
  );
  // If we haven't yet reached today's reset hour, use yesterday's reset
  const todayLocalResetMs = localMs < localResetMs
    ? localResetMs - 86_400_000
    : localResetMs;
  // Convert back to UTC ms — this is the wall-clock moment of last reset
  const resetTimeMs = todayLocalResetMs - tzOffsetMin * 60_000;

  for (const activity of activities) {
    const startMs = activity.timestamp;
    if (!startMs || currentTimeMs < startMs) continue;

    // ✅ Skip sessions that started before today's reset — sensitivity resets
    // at the daily boundary just like delivered BG drop and IOB.
    if (startMs < resetTimeMs) continue;

    const elapsedMin = (currentTimeMs - startMs) / 60000;
    if (elapsedMin > 8 * 60) continue; // W fully decayed

    const { hrBase: pHrBase } = getPatientHrDefaults(pc);
    const hrBase   = parseFloat(activity.hr_base ?? pHrBase);
    const trace    = getTraceFromActivity(activity, pc);
    const { Z, W } = simulateHrOde(trace, elapsedMin, hrBase);
    const rawBoost = alpha * W * (1 + Z);
    const boost    = Math.min(rawBoost, max_sensitivity_boost);
    best = Math.max(best, Math.round((1 + boost) * 10000) / 10000);
  }

  return best;
}

/**
 * Return a modified copy of patientConstants with ISF and carb ratio
 * scaled by the current activity sensitivity multiplier.
 * Mirrors Python apply_activity_sensitivity().
 *
 * @param {object} pc            - Patient constants
 * @param {Array}  activities    - Normalized activity records
 * @param {number} currentTimeMs - Current time in milliseconds
 * @returns {object} Modified constants copy (original NOT mutated)
 */
export function applyActivitySensitivity(pc, activities, currentTimeMs) {
  const multiplier = calculateActivitySensitivityMultiplier(activities, currentTimeMs, pc);
  if (multiplier === 1.0) return pc;

  const modified = { ...pc };

  if ('correction_factor' in modified) {
    modified.correction_factor = Math.round(modified.correction_factor * multiplier * 100) / 100;
  }
  for (const crKey of ['carb_to_bg_ratio', 'carb_to_bg_factor']) {
    if (crKey in modified) {
      modified[crKey] = Math.round((modified[crKey] / multiplier) * 100) / 100;
    }
  }
  return modified;
}

/**
 * Combine all normalised activity sessions into one result dict.
 * The cumulative_activity_effect is SIGNED (negative = BG-lowering).
 * Mirrors Python calculate_stacked_activity_effect().
 *
 * @param {Array}  activities    - Normalized activity records
 * @param {number} currentTimeMs - Current time in milliseconds
 * @param {object} pc            - Patient constants
 * @returns {{
 *   cumulative_activity_effect: number,
 *   sensitivity_multiplier:     number,
 *   activity_on_board:          number,
 *   activity_contributions:     Array,
 *   active_sessions:            number,
 * }}
 */
export function calculateStackedActivityEffect(activities, currentTimeMs, pc) {
  let cumulativeEffect = 0;
  let totalAob         = 0;
  let activeCount      = 0;
  const contributions  = [];

  for (const activity of activities) {
    const effect = calculateActivityCumulativeEffect(activity, currentTimeMs, pc);
    const aob    = getActivityOnBoard(activity, currentTimeMs, pc);

    cumulativeEffect += effect;
    totalAob         += aob.remaining_bg_drop;
    if (aob.is_active) activeCount++;

    const startMs = activity.timestamp;
    contributions.push({
      activity_id:          activity._id || '',
      start_time:           startMs ? new Date(startMs).toISOString() : null,
      intensity:            activity.intensity ?? 'moderate',
      duration_minutes:     activity.duration_minutes ?? 30,
      bg_direction:         activity.bg_direction ?? -1,
      cumulative_bg_effect: Math.round(effect * 10) / 10,
      remaining_bg_drop:    aob.remaining_bg_drop,
      absorbed_fraction:    aob.absorbed_fraction,
      is_active:            aob.is_active,
      model:                activity.hr_trace ? 'hr_ode' : 'synthetic_hr',
    });
  }

  const sensitivity = calculateActivitySensitivityMultiplier(activities, currentTimeMs, pc);

  return {
    cumulative_activity_effect: Math.round(cumulativeEffect * 10) / 10,
    sensitivity_multiplier:     Math.round(sensitivity * 10000) / 10000,
    activity_on_board:          Math.round(totalAob * 10) / 10,
    activity_contributions:     contributions,
    active_sessions:            activeCount,
  };
}

// Re-export constants for consumers that need them without importing shared_constants directly
export { HR_MODEL, INTENSITY_HR_FRACTION, LEVEL_TO_INTENSITY };

export default {
  normalizeActivityRecord,
  calculateActivityCumulativeEffect,
  getActivityOnBoard,
  calculateActivitySensitivityMultiplier,
  applyActivitySensitivity,
  calculateStackedActivityEffect,
};