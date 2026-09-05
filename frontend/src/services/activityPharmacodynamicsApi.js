/**
 * =============================================================================
 * activityPharmacodynamicsApi.js — API Service Layer
 * =============================================================================
 *
 * Wraps the three backend Activity PD endpoints:
 *   GET  /api/activity/pharmacodynamics        — stacked effect for today's window
 *   GET  /api/activity/pharmacodynamics/aob    — Activity On Board per session
 *   POST /api/activity/pharmacodynamics/preview — simulate without persisting
 *
 * Pattern follows existing frontend API services (axios + Bearer token).
 *
 * Version: 1.0
 * =============================================================================
 */

import axios from 'axios';
import API_BASE_URL from '../config';

// ─── Auth header helper ────────────────────────────────────────────────────────

function getAuthHeader() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Endpoints ─────────────────────────────────────────────────────────────────

/**
 * Fetch the stacked pharmacodynamic effect of all exercise sessions
 * in today's window.
 *
 * Response shape:
 * {
 *   cumulative_activity_effect:  number   (signed mg/dL, negative = BG-lowering)
 *   sensitivity_multiplier:      number   (≥ 1.0 — post-exercise ISF/CR boost)
 *   activity_on_board:           number   (unsigned remaining drop)
 *   activity_contributions:      Array    (per-session breakdown)
 *   active_sessions:             number
 *   effective_correction_factor: number   (ISF × sensitivity)
 *   effective_carb_to_bg_ratio:  number   (CR ÷ sensitivity)
 *   window_start:                string   (ISO-8601)
 *   window_end:                  string   (ISO-8601)
 *   calculated_at:               string   (ISO-8601)
 * }
 *
 * @param {string} [targetTime] - ISO-8601 override for calculation reference time
 * @returns {Promise<object>}
 */
export async function fetchStackedActivityEffect(targetTime) {
  const params = {};
  if (targetTime) params.target_time = targetTime;

  const response = await axios.get(
    `${API_BASE_URL}/api/activity/pharmacodynamics`,
    {
      headers: getAuthHeader(),
      params,
    }
  );
  return response.data;
}

/**
 * Fetch per-session Activity On Board (AOB) breakdown.
 * Analogous to IOB — shows remaining BG-lowering effect per session.
 *
 * Response shape:
 * {
 *   sessions:      Array   (AOB dicts per session)
 *   total_aob:     number  (summed remaining drop, unsigned mg/dL)
 *   calculated_at: string
 * }
 *
 * @param {string} [targetTime] - ISO-8601 override
 * @returns {Promise<object>}
 */
export async function fetchActivityOnBoard(targetTime) {
  const params = {};
  if (targetTime) params.target_time = targetTime;

  const response = await axios.get(
    `${API_BASE_URL}/api/activity/pharmacodynamics/aob`,
    {
      headers: getAuthHeader(),
      params,
    }
  );
  return response.data;
}

/**
 * Simulate the pharmacodynamic effect of a planned/hypothetical activity
 * WITHOUT persisting to the database.
 *
 * Useful for the "preview" UI before logging an activity.
 *
 * @param {{
 *   intensity:        string,  // 'light' | 'moderate' | 'vigorous'
 *   duration_minutes: number,
 *   start_time?:      string,  // ISO-8601, defaults to now on backend
 *   hr_trace?:        Array,   // [{t_min, hr_bpm}]
 *   hr_base?:         number,
 *   hr_max?:          number,
 * }} params
 * @returns {Promise<object>}
 */
export async function previewActivityEffect(params) {
  const response = await axios.post(
    `${API_BASE_URL}/api/activity/pharmacodynamics/preview`,
    params,
    { headers: getAuthHeader() }
  );
  return response.data;
}

// ─── Convenience: safe fetch (non-throwing, returns null on error) ─────────────

/**
 * Like fetchStackedActivityEffect() but catches all errors and returns null.
 * Use this inside Promise.all() chains where the activity fetch is non-fatal.
 *
 * @param {string} [targetTime]
 * @returns {Promise<object|null>}
 */
export async function fetchStackedActivityEffectSafe(targetTime) {
  try {
    return await fetchStackedActivityEffect(targetTime);
  } catch (err) {
    console.warn('[activityPharmacodynamicsApi] ⚠️ fetchStackedActivityEffect failed — activity effect will be 0:', err);
    return null;
  }
}

export default {
  fetchStackedActivityEffect,
  fetchActivityOnBoard,
  previewActivityEffect,
  fetchStackedActivityEffectSafe,
};
