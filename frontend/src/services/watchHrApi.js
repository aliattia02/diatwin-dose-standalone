/**
 * =============================================================================
 * watchHrApi.js  —  Watch HR API service (web frontend)
 * =============================================================================
 *
 * Covers all six watch HR endpoints in watch_hr_routes.py:
 *
 *   Session-based (real-time recording during workout)
 *   ──────────────────────────────────────────────────
 *   startWatchSession        POST /api/watch/activity/start
 *   streamHrSamples          POST /api/watch/hr/stream
 *   endWatchSession          POST /api/watch/activity/end
 *   getWatchSessionStatus    GET  /api/watch/activity/status
 *   fetchRawHrTrace          GET  /api/watch/hr/raw/<session_id>
 *
 *   Continuous upload (end-of-day sync from wearable app)
 *   ──────────────────────────────────────────────────────
 *   uploadContinuousHr           POST /api/watch/hr/continuous
 *   parseWearableCsv             (local helper — no network call)
 *   uploadContinuousHrFromFile   parse CSV File then upload in one step
 *
 * The two approaches are complementary:
 *   Real-time recording during workout → startWatchSession / streamHrSamples / endWatchSession
 *   End-of-day sync from wearable app  → uploadContinuousHr
 *
 * Key design: samples accept t_sec (seconds elapsed) — perfect for per-second
 * watch data.  t_min and timestamp_iso are also accepted for flexibility.
 *
 * Usage:
 *   import {
 *     startWatchSession, streamHrSamples, endWatchSession,
 *     getWatchSessionStatus, fetchRawHrTrace,
 *     uploadContinuousHr, parseWearableCsv, uploadContinuousHrFromFile,
 *   } from '../services/watchHrApi';
 *
 *   // ── Session-based (real-time) ──────────────────────────────────────────
 *   const { session_id } = await startWatchSession({ intensity: 'moderate' });
 *   // called every ~5 s by the watch sync loop:
 *   await streamHrSamples({ session_id, samples: [{ t_sec: 5, hr_bpm: 122 }] });
 *   const result = await endWatchSession({ session_id });
 *   // for the HR Live visualization tab:
 *   const raw = await fetchRawHrTrace(session_id);
 *
 *   // ── Continuous upload (end-of-day) ─────────────────────────────────────
 *   const result = await uploadContinuousHr({ samples });
 *   // or from a CSV File object:
 *   const result = await uploadContinuousHrFromFile(file);
 *
 * SWIM-LANE ZONES (continuous endpoint)
 * ──────────────────────────────────────
 *  HR < hr_sedentary_max                   → SEDENTARY  (no session, truly resting)
 *  hr_sedentary_max ≤ HR < hr_moderate_low → LIGHT      (walking, standing activity)
 *  hr_moderate_low ≤ HR ≤ hr_moderate_high → MODERATE
 *  HR > hr_moderate_high                   → VIGOROUS
 *
 * SWIM-LANE DEFAULTS (can be overridden per call via the config param)
 * ─────────────────────────────────────────────────────────────────────
 *  hr_sedentary_max    50   bpm — below this: truly sedentary, no session
 *  hr_moderate_low    100   bpm — LIGHT / MODERATE boundary
 *  hr_moderate_high   140   bpm — MODERATE / VIGOROUS boundary
 *  debounce_start       6        — consecutive readings needed to START a session
 *  debounce_end         6        — consecutive readings needed to END a session
 *  debounce_transit     6        — consecutive readings needed to SWITCH intensity
 *  min_session_minutes  2.0      — shorter sessions are filtered out as artefacts
 *  max_session_minutes 60.0      — sessions split at full clock-hour boundaries
 *
 * Version: 2.0
 * =============================================================================
 */

import axios from 'axios';
import API_BASE_URL from '../config';

function getAuthHeader() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}


// =============================================================================
// Session-based endpoints (real-time recording)
// =============================================================================

/**
 * Begin a watch-driven activity session on the server.
 *
 * @param {{
 *   intensity?:  'light'|'moderate'|'vigorous',
 *   hr_base?:    number,
 *   hr_max?:     number,
 *   start_time?: string,   // ISO-8601
 *   notes?:      string,
 * }} params
 * @returns {Promise<{ session_id: string, started_at: string, message: string }>}
 */
export async function startWatchSession(params = {}) {
  const response = await axios.post(
    `${API_BASE_URL}/api/watch/activity/start`,
    params,
    { headers: getAuthHeader() }
  );
  return response.data;
}

/**
 * Push a batch of HR readings to an in-progress session.
 *
 * Each sample needs hr_bpm plus ONE of:
 *   t_sec         — seconds elapsed since session start  [preferred for watches]
 *   t_min         — minutes elapsed (float ok, e.g. 0.5 = 30 s)
 *   timestamp_iso — ISO-8601 wall-clock time (server computes t_sec)
 *
 * @param {{
 *   session_id: string,
 *   samples:    Array<{ hr_bpm: number } & ({ t_sec: number } | { t_min: number } | { timestamp_iso: string })>
 * }} params
 * @returns {Promise<{ session_id: string, samples_added: number, total_raw: number, total_minutes: number }>}
 */
export async function streamHrSamples(params) {
  const response = await axios.post(
    `${API_BASE_URL}/api/watch/hr/stream`,
    params,
    { headers: getAuthHeader() }
  );
  return response.data;
}

/**
 * Finalise the session.  Server converts to type="completed" and the ODE
 * pharmacodynamics engine picks it up automatically.
 *
 * @param {{
 *   session_id:  string,
 *   end_time?:   string,                         // ISO-8601
 *   intensity?:  'light'|'moderate'|'vigorous',  // override auto-inferred
 * }} params
 * @returns {Promise<{
 *   session_id: string, duration_minutes: number, intensity: string,
 *   total_raw_samples: number, total_min_buckets: number,
 *   hr_base: number, hr_max: number, completed_at: string
 * }>}
 */
export async function endWatchSession(params) {
  const response = await axios.post(
    `${API_BASE_URL}/api/watch/activity/end`,
    params,
    { headers: getAuthHeader() }
  );
  return response.data;
}

/**
 * Check for an active in-progress session — call on app start for crash recovery.
 *
 * @returns {Promise<{
 *   active: boolean, session_id: string|null, started_at: string|null,
 *   total_raw: number, total_minutes: number, intensity: string|null
 * }>}
 */
export async function getWatchSessionStatus() {
  const response = await axios.get(
    `${API_BASE_URL}/api/watch/activity/status`,
    { headers: getAuthHeader() }
  );
  return response.data;
}

/**
 * Fetch the full per-second HR trace for a completed (or in-progress) session.
 * Used by ActivityVisualization's "HR Live" tab to render second-resolution data.
 *
 * @param {string} sessionId
 * @returns {Promise<{
 *   session_id: string, started_at: string, duration_minutes: number,
 *   intensity: string, hr_base: number, hr_max: number,
 *   hr_trace_raw: Array<{t_sec: number, hr_bpm: number}>,
 *   hr_trace:     Array<{t_min: number, hr_bpm: number}>,
 *   total_raw: number, source: string, type: string
 * }>}
 */
export async function fetchRawHrTrace(sessionId) {
  const response = await axios.get(
    `${API_BASE_URL}/api/watch/hr/raw/${sessionId}`,
    { headers: getAuthHeader() }
  );
  return response.data;
}


// =============================================================================
// Continuous upload endpoint (end-of-day / all-day sync)
// =============================================================================

/**
 * Upload a continuous HR stream to the backend for auto-segmentation.
 *
 * The backend will create one activity record per detected session.
 * Each session belongs to one intensity lane (light / moderate / vigorous)
 * and is capped at 60 minutes, splitting at full clock-hour boundaries.
 *
 * SAMPLE FORMAT (any of the three timing styles accepted by the backend)
 * ───────────────────────────────────────────────────────────────────────
 *  { timestamp_iso: '2025-05-01T07:32:15', hr_bpm: 122.5 }   ← preferred (all-day)
 *  { t_sec: 245, hr_bpm: 122.5 }                             ← session-relative
 *  { t_min: 4.08, hr_bpm: 122.5 }                            ← session-relative minutes
 *
 * @param {{
 *   samples:     Array<{ hr_bpm: number } & (
 *                  { timestamp_iso: string } |
 *                  { t_sec: number }         |
 *                  { t_min: number }
 *                )>,
 *   base_time?:  string,   // ISO-8601 — required when samples use t_sec / t_min
 *   hr_base?:    number,   // resting HR override applied to ALL sessions
 *   hr_max?:     number,   // max HR override applied to ALL sessions
 *   config?: {             // override swim-lane defaults (all optional)
 *     hr_sedentary_max?:    number,  // default 50
 *     hr_moderate_low?:     number,  // default 100
 *     hr_moderate_high?:    number,  // default 140
 *     debounce_start?:      number,  // default 6
 *     debounce_end?:        number,  // default 6
 *     debounce_transit?:    number,  // default 6
 *     min_session_minutes?: number,  // default 2.0
 *     max_session_minutes?: number,  // default 60.0
 *   }
 * }} params
 *
 * @returns {Promise<{
 *   sessions_created: number,
 *   sessions: Array<{
 *     session_id:       string,
 *     intensity:        'light' | 'moderate' | 'vigorous',
 *     start_time:       string,
 *     end_time:         string,
 *     duration_minutes: number,
 *     sample_count:     number,
 *   }>,
 *   samples_received: number,
 *   by_intensity:     Record<string, number>,
 *   message:          string,
 * }>}
 */
export async function uploadContinuousHr(params) {
  const { samples, base_time, hr_base, hr_max, config } = params;

  if (!samples || samples.length === 0) {
    throw new Error('samples array is required and must not be empty');
  }

  const body = { samples };
  if (base_time !== undefined && base_time !== null) body.base_time = base_time;
  if (hr_base   !== undefined && hr_base   !== null) body.hr_base   = hr_base;
  if (hr_max    !== undefined && hr_max    !== null) body.hr_max    = hr_max;
  if (config)                                        body.config    = config;

  const response = await axios.post(
    `${API_BASE_URL}/api/watch/hr/continuous`,
    body,
    { headers: getAuthHeader() }
  );
  return response.data;
}

/**
 * Parse a wearable CSV export into the sample format expected by uploadContinuousHr().
 *
 * Supports three layouts (auto-detected from header row):
 *
 *   Layout A — timestamp_iso format (preferred, for all-day sync):
 *     timestamp_iso,hr_bpm[,optional_extra_cols...]
 *     2025-05-01T07:00:00,68.5,...
 *
 *   Layout B — session-relative seconds:
 *     t_sec,hr_bpm[,optional_extra_cols...]
 *     0,72.0,...
 *
 *   Layout C — session-relative minutes:
 *     t_min,hr_bpm[,optional_extra_cols...]
 *     0.5,72.0,...
 *
 * Extra columns are silently ignored.
 *
 * @param {string} csvText — full CSV string (including header row)
 * @returns {Array<{ hr_bpm: number } & ({ timestamp_iso: string } | { t_sec: number } | { t_min: number })>}
 */
export function parseWearableCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
  const hrIdx   = headers.indexOf('hr_bpm');
  if (hrIdx === -1) throw new Error('CSV must have a hr_bpm column');

  const tsIdx   = headers.indexOf('timestamp_iso');
  const tSecIdx = headers.indexOf('t_sec');
  const tMinIdx = headers.indexOf('t_min');

  if (tsIdx === -1 && tSecIdx === -1 && tMinIdx === -1) {
    throw new Error('CSV must have a timing column: timestamp_iso, t_sec, or t_min');
  }

  const samples = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map(c => c.trim());
    const hr   = parseFloat(cols[hrIdx]);
    if (isNaN(hr) || hr < 20 || hr > 300) continue;

    if (tsIdx !== -1) {
      const ts = cols[tsIdx];
      if (ts) samples.push({ timestamp_iso: ts, hr_bpm: hr });
    } else if (tSecIdx !== -1) {
      const t = parseFloat(cols[tSecIdx]);
      if (!isNaN(t)) samples.push({ t_sec: t, hr_bpm: hr });
    } else if (tMinIdx !== -1) {
      const t = parseFloat(cols[tMinIdx]);
      if (!isNaN(t)) samples.push({ t_min: t, hr_bpm: hr });
    }
  }

  return samples;
}

/**
 * Convenience: parse CSV file (File object from <input type="file">)
 * then upload in one step.
 *
 * @param {File}   file
 * @param {object} uploadOptions — passed to uploadContinuousHr (base_time, hr_base, config, etc.)
 * @returns {Promise<object>} — uploadContinuousHr response
 */
export async function uploadContinuousHrFromFile(file, uploadOptions = {}) {
  const text    = await file.text();
  const samples = parseWearableCsv(text);

  if (samples.length === 0) {
    throw new Error('No valid HR samples found in CSV file');
  }

  return uploadContinuousHr({ samples, ...uploadOptions });
}


export default {
  // Session-based
  startWatchSession,
  streamHrSamples,
  endWatchSession,
  getWatchSessionStatus,
  fetchRawHrTrace,
  // Continuous upload
  uploadContinuousHr,
  parseWearableCsv,
  uploadContinuousHrFromFile,
};