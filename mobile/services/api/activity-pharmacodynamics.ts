/**
 * Activity Pharmacodynamics API Service
 * Location: mobile/services/api/activity-pharmacodynamics.ts
 *
 * API service layer for the three HR ODE exercise model endpoints.
 * Follows the exact same pattern as mobile/services/api/activities.ts.
 *
 * Endpoints proxied:
 *   GET  /api/activity/pharmacodynamics        → fetchActivityPD()
 *   GET  /api/activity/pharmacodynamics/aob    → fetchActivityOnBoard()
 *   POST /api/activity/pharmacodynamics/preview → previewActivityEffect()
 *
 * Changes:
 *   - Added `cached: boolean` to ActivityPDResult (observability only — no consumer
 *     should branch on this field; it reflects whether the backend served from TTL cache).
 *   - Added fetchStackedActivityEffectSafe() wrapper (fix C-1 / 11.5).
 *
 * References:
 *   Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
 *   Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
 */

import apiClient from './client';
import API from './endpoints';

// ─── Response interfaces ──────────────────────────────────────────────────────

/**
 * Per-session breakdown from the activity_contributions array.
 * One entry per exercise session that contributed to the stacked effect.
 */
export interface ActivityContribution {
  /** MongoDB ObjectId stringified, or "preview" for simulated sessions */
  activity_id: string;
  /** ISO-8601 start timestamp of the session */
  start_time: string;
  /** Categorical intensity tier */
  intensity: 'light' | 'moderate' | 'vigorous';
  /** Session length in minutes */
  duration_minutes: number;
  /**
   * Sign of BG direction:
   *   -1 = lowers BG (default aerobic)
   *   +1 = raises BG (stress / anaerobic recorded explicitly)
   */
  bg_direction: -1 | 1;
  /** Signed mg/dL contributed by THIS session to the cumulative effect */
  cumulative_bg_effect: number;
  /** Unsigned mg/dL of acute BG-lowering still to be delivered (AOB per session) */
  remaining_bg_drop: number;
  /** 0.0–1.0 fraction of total acute drop that has already occurred */
  absorbed_fraction: number;
  /** True while the session is within its duration_minutes window */
  is_active: boolean;
  /** 'hr_ode' when wearable HR trace was used, 'synthetic_hr' for the categorical fallback */
  model: 'hr_ode' | 'synthetic_hr';
}

/**
 * Full stacked response from GET /api/activity/pharmacodynamics.
 * This is the primary payload consumed by ActiveEffectsDisplay and useActiveEffects.
 */
export interface ActivityPDResult {
  /**
   * Net signed BG effect of ALL today's exercise sessions (mg/dL).
   * Negative = net BG-lowering (typical aerobic day).
   */
  cumulative_activity_effect: number;
  /**
   * Post-exercise ISF/CR sensitivity multiplier from the W state variable.
   * ≥ 1.0  (e.g. 1.30 = 30 % more insulin-sensitive than baseline).
   * Takes the MAX across all sessions (GLUT4 receptors don't stack additively).
   */
  sensitivity_multiplier: number;
  /**
   * Unsigned total remaining acute BG drop still to arrive (mg/dL).
   * Equivalent to summed remaining_bg_drop across all active sessions.
   */
  activity_on_board: number;
  /** Per-session breakdowns */
  activity_contributions: ActivityContribution[];
  /** Number of sessions currently within their exercise window */
  active_sessions: number;
  /**
   * ISF (correction_factor) after being scaled up by sensitivity_multiplier.
   * Use this when sensitivityMultiplier > 1.0 to display IOB BG-reduction impact.
   * ⚠️ Pre-multiplied by the backend — do NOT re-apply sensitivity_multiplier.
   */
  effective_correction_factor: number;
  /**
   * Carb-to-BG ratio after being scaled DOWN by sensitivity_multiplier.
   * Use this when sensitivityMultiplier > 1.0 to display MOB BG-elevation impact.
   * ⚠️ Pre-divided by the backend — do NOT re-divide by sensitivity_multiplier.
   */
  effective_carb_to_bg_ratio: number;
  /** ISO-8601 start of the daily accounting window (reset time) */
  window_start: string;
  /** ISO-8601 end of the window (= target_time) */
  window_end: string;
  /** ISO-8601 server calculation timestamp */
  calculated_at: string;
  /**
   * True when this response was served from the backend's 60-second TTL cache;
   * false when the ODE ran fresh.
   *
   * ⚠️ OBSERVABILITY ONLY — no consumer should branch on this value.
   * It exists purely for debugging / monitoring cache hit rates.
   */
  cached: boolean;
  /**
   * FIX N-7: NOT YET SERIALIZED BY BACKEND.
   *
   * The ODE engine (activity_pharmacodynamics.py) reads tau_W exclusively from
   * the module-level HR_MODEL constant (90 min). It does not accept a per-patient
   * override, and _build_stacked_response() does not include this field in the
   * response payload. This field will always be undefined at runtime.
   *
   * ⚠️ DO NOT branch on this value in consumers — it is never present.
   *    Use SHARED_CONSTANTS.HR_MODEL.tau_w (90 min) directly until the backend
   *    wires per-patient tau_W support through the ODE functions and serialises
   *    it here.
   *
   * TODO (backend): add optional `w_state_tau_minutes` to patient constants schema,
   *   thread it into _simulate_hr_ode() / _integrate_z_drop(), and emit it from
   *   _build_stacked_response() only when it differs from the 90-min default.
   */
  w_state_tau_minutes?: never;  // intentionally typed never until backend implements it
}

/**
 * Activity On Board per session — response shape for each item in
 * GET /api/activity/pharmacodynamics/aob sessions array.
 */
export interface ActivityOnBoardSession {
  activity_id: string;
  intensity: 'light' | 'moderate' | 'vigorous';
  duration_minutes: number;
  /** Unsigned remaining acute BG drop for THIS session (mg/dL) */
  remaining_bg_drop: number;
  /** 0.0–1.0 absorbed fraction */
  absorbed_fraction: number;
  /** Minutes elapsed since session start */
  minutes_elapsed: number;
  /** True while within duration_minutes window */
  is_active: boolean;
  bg_direction: -1 | 1;
}

/**
 * Response from GET /api/activity/pharmacodynamics/aob.
 */
export interface ActivityOnBoardResponse {
  sessions: ActivityOnBoardSession[];
  /** Sum of remaining_bg_drop across all sessions (unsigned mg/dL) */
  total_aob: number;
  calculated_at: string;
}

/**
 * Request body for POST /api/activity/pharmacodynamics/preview.
 */
export interface ActivityPreviewBody {
  /** Required: intensity tier */
  intensity: 'light' | 'moderate' | 'vigorous';
  /** Required: session length in minutes */
  duration_minutes: number;
  /** Optional: ISO-8601 hypothetical start time; defaults to server now */
  start_time?: string;
  /** Optional: real wearable HR trace [{t_min, hr_bpm}, …] */
  hr_trace?: Array<{ t_min: number; hr_bpm: number }>;
  /** Optional: resting HR override (bpm) */
  hr_base?: number;
  /** Optional: max HR override (bpm) */
  hr_max?: number;
}

/**
 * Response from POST /api/activity/pharmacodynamics/preview.
 * Same shape as ActivityPDResult minus the window/server timestamps, plus
 * a simulated flag so the UI can distinguish a live fetch from a preview.
 */
export interface ActivityPreviewResult {
  cumulative_activity_effect: number;
  sensitivity_multiplier: number;
  activity_on_board: number;
  activity_contributions: ActivityContribution[];
  active_sessions: number;
  /** Always true for preview responses */
  simulated: true;
  calculated_at: string;
}

// ─── API Functions ────────────────────────────────────────────────────────────

/**
 * Fetch the stacked pharmacodynamic effect of all today's exercise sessions.
 *
 * @param targetTime  Optional reference time; defaults to server now.
 *                    Pass a Date to back-calculate effects at a specific moment
 *                    (useful for chart builds that step through historical time points).
 */
export const fetchActivityPD = async (
  targetTime?: Date
): Promise<ActivityPDResult> => {
  const params: Record<string, string> = {};
  if (targetTime) {
    params.target_time = targetTime.toISOString();
  }
  const response = await apiClient.get<ActivityPDResult>(
    API.ACTIVITY_PD.STACKED,
    { params }
  );
  return response.data;
};

/**
 * Fetch the Activity On Board (AOB) breakdown per session.
 *
 * Analogous to IOB — shows how much BG-lowering effect is still outstanding
 * for each session, useful for hypoglycaemia risk prediction.
 *
 * @param targetTime  Optional reference time; defaults to server now.
 */
export const fetchActivityOnBoard = async (
  targetTime?: Date
): Promise<ActivityOnBoardResponse> => {
  const params: Record<string, string> = {};
  if (targetTime) {
    params.target_time = targetTime.toISOString();
  }
  const response = await apiClient.get<ActivityOnBoardResponse>(
    API.ACTIVITY_PD.AOB,
    { params }
  );
  return response.data;
};

/**
 * Simulate the pharmacodynamic effect of a planned or hypothetical activity
 * WITHOUT persisting anything to the database.
 *
 * Useful for the "what if I go for a run now?" preview feature in the UI.
 *
 * @param body  Session description — intensity + duration are required.
 */
export const previewActivityEffect = async (
  body: ActivityPreviewBody
): Promise<ActivityPreviewResult> => {
  const response = await apiClient.post<ActivityPreviewResult>(
    API.ACTIVITY_PD.PREVIEW,
    body
  );
  return response.data;
};

/**
 * Like fetchActivityPD() but catches ALL errors and returns null instead of
 * throwing. Use this inside Promise.all() chains where the activity fetch is
 * non-fatal (fix C-1 / fix 11.5).
 *
 * A null return must be treated as zero effect — it must never break the BG
 * pipeline.
 *
 * @param targetTime  Optional reference time; passed through to fetchActivityPD().
 */
export const fetchStackedActivityEffectSafe = async (
  targetTime?: Date
): Promise<ActivityPDResult | null> => {
  try {
    return await fetchActivityPD(targetTime);
  } catch (error) {
    console.warn('[ActivityPD] fetchStackedActivityEffectSafe failed:', error);
    return null;
  }
};

export default {
  fetchActivityPD,
  fetchActivityOnBoard,
  previewActivityEffect,
  fetchStackedActivityEffectSafe,
};