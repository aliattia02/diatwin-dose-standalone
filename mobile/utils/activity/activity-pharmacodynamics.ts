/**
 * =============================================================================
 * activity-pharmacodynamics.ts — Dalla Man / Breton HR-Informed Exercise Model
 * =============================================================================
 *
 * TypeScript port of activityPharmacodynamics.js v1.1 (frontend) which itself
 * ports backend/utils/activity_pharmacodynamics.py.
 *
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
 * HARD REQUIREMENTS (per spec §10.2)
 * ────────────────────────────────────
 *  • ALL Euler parameters sourced from SHARED_CONSTANTS.HR_MODEL — never
 *    duplicated as local constants.
 *  • parseDt() appends 'Z' to bare ISO strings so they parse as UTC.
 *  • calculateActivitySensitivityMultiplier() skips sessions with
 *    start_time < reset_time (H-3 fix, already in JS v1.1).
 *  • ActivityContribution imported from service layer — not redefined here.
 *
 * References:
 *   Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
 *   Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
 *   Breton MD                       — J Diabetes Sci Technol 2008;2(1):169-174
 *
 * Location: mobile/utils/activity/activity-pharmacodynamics.ts
 * Version: 1.2-ts
 *
 * Changes vs 1.1-ts:
 *   - React D-1 fix: _sessionAOB() now implements the bg_drop_override linear
 *     absorption path before falling through to the ODE path, exactly mirroring
 *     Python get_activity_on_board().  Previously, CGM-confirmed sessions always
 *     took the ODE path, producing AOB values inconsistent with the backend.
 * =============================================================================
 */

import { SHARED_CONSTANTS } from '@/constants/shared-constants';
import type { PatientConstants } from '@/constants/shared-constants';
import type { ActivityContribution } from '@/services/api/activity-pharmacodynamics';

// ─── Constants (from SHARED_CONSTANTS — never duplicated locally) ─────────────

const HR_MODEL              = SHARED_CONSTANTS.HR_MODEL;
const INTENSITY_HR_FRACTION = SHARED_CONSTANTS.INTENSITY_HR_FRACTION;
const LEVEL_TO_INTENSITY    = SHARED_CONSTANTS.LEVEL_TO_INTENSITY;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** HR trace sample — mirrors the {t_min, hr_bpm} dict from the backend */
export interface HrTraceSample {
  t_min:  number;
  hr_bpm: number;
}

/** Normalized activity record ready for ODE consumption */
export interface NormalizedActivity {
  _id:              string;
  /** Session start in milliseconds (UTC) */
  timestamp:        number;
  duration_minutes: number;
  intensity:        'light' | 'moderate' | 'vigorous';
  /** -1 = BG-lowering (aerobic default), +1 = BG-raising */
  bg_direction:     number;
  hr_trace?:        HrTraceSample[];
  hr_base?:         number;
  hr_max?:          number;
  bg_drop_override?: number;
}

/** Raw activity record as received from API or local state (before normalization) */
export interface RawActivity {
  _id?:              string;
  id?:               string;
  intensity?:        string;
  level?:            number | string | null;
  startTime?:        string | number | Date;
  completedTime?:    string | number | Date;
  timestamp?:        string | number | Date;
  endTime?:          string | number | Date;
  duration_minutes?: number | string;
  duration?:         string | number;
  bg_direction?:     number | string;
  hr_trace?:         HrTraceSample[];
  hr_base?:          number;
  hr_max?:           number;
  bg_drop_override?: number;
}

/**
 * Activity On Board result for a single session.
 * Exported interface matches the spec-required shape (§STEP 2).
 */
export interface AOBResult {
  total_aob: number;
  sessions: Array<{
    activity_id:      string;
    remaining_bg_drop: number;
    absorbed_fraction: number;
    is_active:         boolean;
  }>;
}

/**
 * Stacked activity effect result.
 * Mirrors the shape returned by the backend's calculate_stacked_activity_effect().
 */
export interface StackedActivityResult {
  cumulative_activity_effect: number;
  sensitivity_multiplier:     number;
  activity_on_board:          number;
  activity_contributions:     ActivityContribution[];
  active_sessions:            number;
  /**
   * FIX N-4: Patient-specific W-state time constant (minutes).
   * When present, consumers (EVC, BGV, AED) should use this instead of
   * SHARED_CONSTANTS.HR_MODEL.tau_w (90 min default).
   * Absent from responses when the backend uses the default value.
   * ⚠️ Backend cross-check required: confirm /api/activity/pharmacodynamics
   *    actually returns this field before relying on a non-default value.
   */
  w_state_tau_minutes?: number;
}

/** Internal single-session AOB dict (before aggregation into AOBResult) */
interface SessionAOB {
  remaining_bg_drop: number;
  absorbed_fraction: number;
  minutes_elapsed:   number;
  is_active:         boolean;
  intensity:         string;
  bg_direction:      number;
}

// ─── Helpers: timestamp & duration parsing ─────────────────────────────────────

/**
 * Parse a Date, number (ms), or ISO string to milliseconds (UTC).
 * Mirrors Python _parse_dt().
 * Bare ISO strings without timezone marker are treated as UTC by appending 'Z'.
 * Returns null on failure.
 */
export function parseDt(value: string | number | Date | null | undefined): number | null {
  if (!value && value !== 0) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Append 'Z' to bare ISO strings with no timezone marker — ensures UTC parsing.
    const normalized = /[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : value + 'Z';
    const ms = new Date(normalized).getTime();
    return isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Parse 'HH:MM' or numeric string → total minutes.
 */
function parseDurationField(str: string | number | undefined): number {
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
 * NormalizedActivity format expected by the ODE functions.
 *
 * Returns null for sedentary levels (≤ −1) or invalid records.
 * Mirrors normalize_activity_record() in the Python backend.
 */
export function normalizeActivityRecord(raw: RawActivity): NormalizedActivity | null {
  if (!raw) return null;

  // ── Resolve intensity ──────────────────────────────────────────────────────
  let intensity: 'light' | 'moderate' | 'vigorous' | undefined;

  if (raw.intensity && INTENSITY_HR_FRACTION[raw.intensity as keyof typeof INTENSITY_HR_FRACTION] !== undefined) {
    intensity = raw.intensity as 'light' | 'moderate' | 'vigorous';
  } else {
    const level = raw.level != null ? parseInt(String(raw.level), 10) : null;
    if (level === null || isNaN(level)) return null;
    const mapped = LEVEL_TO_INTENSITY[String(level) as keyof typeof LEVEL_TO_INTENSITY];
    if (mapped === null || mapped === undefined) return null; // sedentary
    intensity = mapped as 'light' | 'moderate' | 'vigorous';
  }

  // ── Resolve start timestamp (ms) ──────────────────────────────────────────
  const startRaw = raw.startTime ?? raw.completedTime ?? raw.timestamp;
  const startMs  = parseDt(startRaw as string | number | Date | null);
  if (startMs === null) return null;

  // ── Resolve duration ───────────────────────────────────────────────────────
  let durationMinutes: number;
  if (raw.duration_minutes) {
    durationMinutes = parseFloat(String(raw.duration_minutes));
  } else if (raw.endTime) {
    const endMs = parseDt(raw.endTime as string | number | Date | null);
    if (endMs && endMs > startMs) {
      durationMinutes = (endMs - startMs) / 60000;
    } else {
      durationMinutes = parseDurationField(raw.duration ?? '00:30');
    }
  } else {
    durationMinutes = parseDurationField(raw.duration ?? '00:30');
  }
  durationMinutes = Math.max(1, durationMinutes);

  const normalized: NormalizedActivity = {
    _id:              String(raw._id ?? raw.id ?? ''),
    timestamp:        startMs,
    duration_minutes: durationMinutes,
    intensity,
    bg_direction:     parseInt(String(raw.bg_direction ?? -1), 10),
  };

  for (const key of ['hr_trace', 'hr_base', 'hr_max', 'bg_drop_override'] as const) {
    if (raw[key] !== undefined) {
      (normalized as any)[key] = raw[key];
    }
  }

  return normalized;
}

// ─── Synthetic HR trace builder ────────────────────────────────────────────────

/** [t_min, hr_bpm] tuple for internal ODE use */
type TraceTuple = [number, number];

/**
 * Build a (t_min, hr_bpm) array for the given intensity tier.
 * Mirrors Python _synthetic_hr_trace().
 * Shape: 2-min ramp → flat plateau → last sample at duration end.
 */
function buildSyntheticTrace(
  intensity: string,
  durationMinutes: number,
  hrMax: number,
  hrBase: number
): TraceTuple[] {
  const fraction = INTENSITY_HR_FRACTION[intensity as keyof typeof INTENSITY_HR_FRACTION]
    ?? INTENSITY_HR_FRACTION.moderate;
  const peakHr  = hrBase + fraction * (hrMax - hrBase);
  const rampEnd = Math.min(2.0, durationMinutes * 0.1);
  return [
    [0,              hrBase],
    [rampEnd,        peakHr],
    [durationMinutes, peakHr],
  ];
}

function getPatientHrDefaults(pc: Partial<PatientConstants>): { hrBase: number; hrMax: number } {
  return {
    hrBase: parseFloat(String(pc?.hr_base ?? HR_MODEL.hr_base_pop)),
    hrMax:  parseFloat(String(pc?.hr_max  ?? HR_MODEL.hr_max_pop)),
  };
}

/**
 * Return the HR trace for an activity as [t_min, hr_bpm] tuples.
 * Uses wearable trace when available, falls back to synthetic.
 */
function getTraceFromActivity(
  activity: NormalizedActivity,
  pc: Partial<PatientConstants>
): TraceTuple[] {
  if (activity.hr_trace && activity.hr_trace.length > 0) {
    return activity.hr_trace.map(s => [s.t_min, s.hr_bpm] as TraceTuple);
  }
  const { hrBase: pHrBase, hrMax: pHrMax } = getPatientHrDefaults(pc);
  const hrBase = parseFloat(String(activity.hr_base ?? pHrBase));
  const hrMax  = parseFloat(String(activity.hr_max  ?? pHrMax));
  return buildSyntheticTrace(
    activity.intensity ?? 'moderate',
    activity.duration_minutes ?? 30,
    hrMax,
    hrBase
  );
}

// ─── Core ODE integration ──────────────────────────────────────────────────────

/** Linear interpolation of HR at time t from trace. Returns hrBase outside range. */
function interpolateHr(trace: TraceTuple[], t: number, hrBase: number): number {
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

interface OdeState { Y: number; Z: number; W: number; }

/**
 * Euler-integrate Y/Z/W ODEs up to elapsedMin minutes.
 * All parameters from HR_MODEL — none duplicated locally.
 * Mirrors Python _simulate_hr_ode().
 */
function simulateHrOde(trace: TraceTuple[], elapsedMin: number, hrBase: number): OdeState {
  let Y = 0, Z = 0, W = 0;
  const { tau_HR, tau_Z, tau_W, a, dt } = HR_MODEL;
  const threshold = hrBase * (1 + a);
  const lastT     = trace.length > 0 ? trace[trace.length - 1][0] : 0;
  const steps     = Math.ceil(elapsedMin / dt);

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
  }
  return { Y, Z, W };
}

/**
 * Integrate Z * acute_rate_per_min from fromMin to toMin.
 * Returns UNSIGNED magnitude (sign applied by caller via bg_direction).
 * All Euler parameters from HR_MODEL.
 * Mirrors Python _integrate_z_drop().
 */
function integrateZDrop(
  trace: TraceTuple[],
  fromMin: number,
  toMin: number,
  hrBase: number,
  weightKg: number | undefined
): number {
  if (toMin <= fromMin) return 0;

  let Y = 0, Z = 0, W = 0;
  const { tau_HR, tau_Z, tau_W, a, dt, acute_rate_per_min } = HR_MODEL;
  const threshold = hrBase * (1 + a);
  const lastT     = trace.length > 0 ? trace[trace.length - 1][0] : 0;
  const steps     = Math.ceil(toMin / dt);
  let totalDrop   = 0;

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

  // Allometric weight scaling: heavier patients → smaller per-kg BG drop
  if (weightKg && weightKg > 0) {
    totalDrop *= Math.pow(70 / weightKg, 0.25);
  }

  return totalDrop; // always ≥ 0
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Signed BG effect of a single activity session up to targetTime (or now).
 *
 * Sign from activity.bg_direction: −1 = lowers BG (aerobic), +1 = raises.
 * Returns 0 when the session is in the future or has no effect.
 *
 * Mirrors Python calculate_activity_cumulative_effect().
 *
 * @param activity     Normalized activity record
 * @param patientConstants Patient constants (hr_base, hr_max, weight_kg, …)
 * @param targetTime   Reference time (defaults to Date.now())
 */
export function calculateActivityCumulativeEffect(
  activity: NormalizedActivity,
  patientConstants: Partial<PatientConstants>,
  targetTime?: Date
): number {
  const currentTimeMs = targetTime ? targetTime.getTime() : Date.now();
  const startMs = activity.timestamp;
  if (!startMs || currentTimeMs < startMs) return 0;

  const bgDir = parseInt(String(activity.bg_direction ?? -1), 10);

  // CGM-measured override — bypasses ODE entirely
  if (activity.bg_drop_override != null) {
    const dropMag = parseFloat(String(activity.bg_drop_override));
    const dur     = parseFloat(String(activity.duration_minutes ?? 30));
    const tail    = dur * 0.4;
    const elapsed = (currentTimeMs - startMs) / 60000;
    const frac    = Math.min(1, Math.max(0, elapsed / (dur + tail)));
    return Math.round(bgDir * dropMag * frac * 100) / 100;
  }

  const { hrBase: pHrBase } = getPatientHrDefaults(patientConstants);
  const hrBase   = parseFloat(String(activity.hr_base ?? pHrBase));
  const weightKg = patientConstants?.weight_kg;
  const trace    = getTraceFromActivity(activity, patientConstants);
  const elapsed  = (currentTimeMs - startMs) / 60000;
  const postTail = 4 * HR_MODEL.tau_Z;
  const scanTo   = Math.min(elapsed, parseFloat(String(activity.duration_minutes ?? 30)) + postTail);

  const magnitude = integrateZDrop(trace, 0, scanTo, hrBase, weightKg);
  return Math.round(bgDir * magnitude * 100) / 100;
}

/**
 * Activity On Board for a single session — internal helper used by
 * getActivityOnBoard() aggregator below.
 *
 * Returns unsigned remaining BG drop and absorption fraction.
 * Mirrors Python get_activity_on_board() (single-session path).
 *
 * Two computation paths — must stay in sync with calculateActivityCumulativeEffect:
 *
 *   1. bg_drop_override (CGM-measured): linear absorption over duration + 40% tail.
 *      Uses abs(bg_drop_override) so the unsigned AOB magnitude is always positive
 *      regardless of bg_direction.  Mirrors Python get_activity_on_board() exactly.
 *
 *   2. ODE path (default): integrates Z-state to find total drop, then compares
 *      elapsed integral to derive absorbed_fraction and remaining_bg_drop.
 *
 * ⚠️  PREVIOUSLY MISSING (React D-1): path 1 was absent, so CGM-confirmed sessions
 *     always took the ODE path and returned inconsistent AOB values vs the backend.
 */
function _sessionAOB(
  activity: NormalizedActivity,
  currentTimeMs: number,
  pc: Partial<PatientConstants>
): SessionAOB {
  const startMs     = activity.timestamp;
  const intensity   = activity.intensity ?? 'moderate';
  const durationMin = parseFloat(String(activity.duration_minutes ?? 30));
  const bgDir       = parseInt(String(activity.bg_direction ?? -1), 10);

  if (!startMs) {
    return { remaining_bg_drop: 0, absorbed_fraction: 0, minutes_elapsed: 0, is_active: false, intensity, bg_direction: bgDir };
  }

  const elapsed = Math.max(0, (currentTimeMs - startMs) / 60000);

  // ── Path 1: CGM-measured override — linear absorption over duration + 40% tail ──
  // Mirrors Python get_activity_on_board() bg_drop_override branch exactly.
  // Uses abs() so the unsigned AOB magnitude is always positive regardless of
  // bg_direction.  The sign is only applied when computing cumulative_activity_effect.
  if (activity.bg_drop_override != null) {
    const dropMag  = Math.abs(parseFloat(String(activity.bg_drop_override)));
    const tail     = durationMin * 0.4;
    const full     = durationMin + tail;
    const absorbed = full > 0 ? Math.min(1, Math.max(0, elapsed / full)) : 1;
    const remaining = Math.max(0, dropMag * (1 - absorbed));
    return {
      remaining_bg_drop: Math.round(remaining * 10) / 10,
      absorbed_fraction: Math.round(absorbed * 1000) / 1000,
      minutes_elapsed:   Math.round(elapsed * 10) / 10,
      is_active:         elapsed < durationMin,
      intensity,
      bg_direction:      bgDir,
    };
  }

  // ── Path 2: ODE path (no CGM override) ────────────────────────────────────────
  const { hrBase: pHrBase } = getPatientHrDefaults(pc);
  const hrBase     = parseFloat(String(activity.hr_base ?? pHrBase));
  const weightKg   = pc?.weight_kg;
  const trace      = getTraceFromActivity(activity, pc);
  const lastTraceT = trace.length > 0 ? trace[trace.length - 1][0] : durationMin;
  const fullWindow = lastTraceT + 4 * HR_MODEL.tau_Z;

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
 * Activity On Board — aggregated across all provided sessions.
 *
 * Returns total_aob and per-session breakdown.
 * Mirrors the structure required by §STEP 2 spec (AOBResult interface).
 *
 * @param activity     Array of normalized activity records (or a single record)
 * @param patientConstants Patient constants
 * @param targetTime   Reference time (defaults to Date.now())
 */
export function getActivityOnBoard(
  activity: NormalizedActivity | NormalizedActivity[],
  patientConstants: Partial<PatientConstants>,
  targetTime?: Date
): AOBResult {
  const currentTimeMs = targetTime ? targetTime.getTime() : Date.now();
  const activities    = Array.isArray(activity) ? activity : [activity];

  let totalAob = 0;
  const sessions: AOBResult['sessions'] = [];

  for (const act of activities) {
    const aob = _sessionAOB(act, currentTimeMs, patientConstants);
    totalAob += aob.remaining_bg_drop;
    sessions.push({
      activity_id:       act._id || '',
      remaining_bg_drop: aob.remaining_bg_drop,
      absorbed_fraction: aob.absorbed_fraction,
      is_active:         aob.is_active,
    });
  }

  return {
    total_aob: Math.round(totalAob * 10) / 10,
    sessions,
  };
}

/**
 * Post-exercise ISF/CR sensitivity multiplier from W state variable.
 *
 * Uses max() across sessions (GLUT4 doesn't stack additively).
 * Skips sessions before the daily reset boundary (H-3 fix).
 * Returns float ≥ 1.0.
 *
 * Mirrors Python calculate_activity_sensitivity_multiplier() and
 * JS v1.1 calculateActivitySensitivityMultiplier().
 *
 * @param activities     Normalized activity records
 * @param patientConstants Patient constants (daily_reset_hour, timezone_offset_minutes, …)
 * @param targetTime     Reference time (defaults to Date.now())
 */
export function calculateActivitySensitivityMultiplier(
  activities: NormalizedActivity[],
  patientConstants: Partial<PatientConstants>,
  targetTime?: Date
): number {
  const currentTimeMs = targetTime ? targetTime.getTime() : Date.now();
  const { alpha, max_sensitivity_boost } = HR_MODEL;
  let best = 1.0;

  // ── Compute today's reset boundary (UTC-anchored with tz offset) ────────────
  // Mirrors _resolve_reset_time() in the Python backend and JS v1.1.
  const resetHour   = patientConstants?.daily_reset_hour       ?? 7;
  const tzOffsetMin = patientConstants?.timezone_offset_minutes ?? 0;

  // Shift to "patient local" time to find the correct calendar day
  const localMs     = currentTimeMs + tzOffsetMin * 60_000;
  const localNow    = new Date(localMs);
  const localResetMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    resetHour, 0, 0, 0,
  );
  // If we haven't yet reached today's reset hour, roll back to yesterday's
  const todayLocalResetMs = localMs < localResetMs
    ? localResetMs - 86_400_000
    : localResetMs;
  // Convert back to UTC — this is the wall-clock moment of last reset
  const resetTimeMs = todayLocalResetMs - tzOffsetMin * 60_000;

  for (const activity of activities) {
    const startMs = activity.timestamp;
    if (!startMs || currentTimeMs < startMs) continue;

    // ✅ H-3 fix: skip sessions that started before today's reset boundary
    if (startMs < resetTimeMs) continue;

    const elapsedMin = (currentTimeMs - startMs) / 60000;
    if (elapsedMin > 8 * 60) continue; // W fully decayed beyond 8 h

    const { hrBase: pHrBase } = getPatientHrDefaults(patientConstants);
    const hrBase   = parseFloat(String(activity.hr_base ?? pHrBase));
    const trace    = getTraceFromActivity(activity, patientConstants);
    const { Z, W } = simulateHrOde(trace, elapsedMin, hrBase);
    // Confirmed: Python uses α·W·(1+Z) — backend audit v2.0 §2.3.
    // insulinCalculationService.ts also uses α·W·(1+Z) (resolved in batch 2).
    const rawBoost  = alpha * W * (1 + Z);
    const boost     = Math.min(rawBoost, max_sensitivity_boost);
    best = Math.max(best, Math.round((1 + boost) * 10000) / 10000);
  }

  return best;
}

/**
 * Combine all normalised activity sessions into one stacked result.
 *
 * cumulative_activity_effect is SIGNED (negative = BG-lowering).
 * Mirrors Python calculate_stacked_activity_effect().
 *
 * @param activities     Normalized activity records
 * @param patientConstants Patient constants
 * @param targetTime     Reference time (defaults to Date.now())
 */
export function calculateStackedActivityEffect(
  activities: NormalizedActivity[],
  patientConstants: Partial<PatientConstants>,
  targetTime?: Date
): StackedActivityResult {
  const currentTimeMs = targetTime ? targetTime.getTime() : Date.now();

  let cumulativeEffect = 0;
  let totalAob         = 0;
  let activeCount      = 0;
  const contributions: ActivityContribution[] = [];

  for (const activity of activities) {
    const effect = calculateActivityCumulativeEffect(activity, patientConstants, targetTime);
    const aob    = _sessionAOB(activity, currentTimeMs, patientConstants);

    cumulativeEffect += effect;
    totalAob         += aob.remaining_bg_drop;
    if (aob.is_active) activeCount++;

    const startMs = activity.timestamp;
    contributions.push({
      activity_id:          activity._id || '',
      start_time:           startMs ? new Date(startMs).toISOString() : '',
      intensity:            activity.intensity ?? 'moderate',
      duration_minutes:     activity.duration_minutes ?? 30,
      bg_direction:         (activity.bg_direction ?? -1) as -1 | 1,
      cumulative_bg_effect: Math.round(effect * 10) / 10,
      remaining_bg_drop:    aob.remaining_bg_drop,
      absorbed_fraction:    aob.absorbed_fraction,
      is_active:            aob.is_active,
      model:                activity.hr_trace ? 'hr_ode' : 'synthetic_hr',
    });
  }

  const sensitivity = calculateActivitySensitivityMultiplier(
    activities, patientConstants, targetTime
  );

  return {
    cumulative_activity_effect: Math.round(cumulativeEffect * 10) / 10,
    sensitivity_multiplier:     Math.round(sensitivity * 10000) / 10000,
    activity_on_board:          Math.round(totalAob * 10) / 10,
    activity_contributions:     contributions,
    active_sessions:            activeCount,
  };
}

/**
 * Return a modified copy of patientConstants with ISF and carb ratio
 * scaled by the current activity sensitivity multiplier.
 * Mirrors Python apply_activity_sensitivity().
 *
 * @param pc          Patient constants (not mutated)
 * @param activities  Normalized activity records
 * @param targetTime  Reference time (defaults to Date.now())
 * @returns Modified constants copy
 */
export function applyActivitySensitivity(
  pc: Partial<PatientConstants>,
  activities: NormalizedActivity[],
  targetTime?: Date
): Partial<PatientConstants> {
  const multiplier = calculateActivitySensitivityMultiplier(activities, pc, targetTime);
  if (multiplier === 1.0) return pc;

  const modified = { ...pc } as any;

  if ('correction_factor' in modified && modified.correction_factor != null) {
    modified.correction_factor =
      Math.round(modified.correction_factor * multiplier * 100) / 100;
  }
  for (const crKey of ['carb_to_bg_ratio', 'carb_to_bg_factor'] as const) {
    if (crKey in modified && modified[crKey] != null) {
      modified[crKey] = Math.round((modified[crKey] / multiplier) * 100) / 100;
    }
  }
  return modified;
}

// Re-export constants for consumers that need them directly
export { HR_MODEL, INTENSITY_HR_FRACTION, LEVEL_TO_INTENSITY };

export default {
  parseDt,
  normalizeActivityRecord,
  calculateActivityCumulativeEffect,
  getActivityOnBoard,
  calculateActivitySensitivityMultiplier,
  applyActivitySensitivity,
  calculateStackedActivityEffect,
};