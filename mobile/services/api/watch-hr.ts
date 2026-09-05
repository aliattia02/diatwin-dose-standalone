/**
 * =============================================================================
 * watch-hr.ts  —  Watch HR API service  (React Native / mobile)
 * =============================================================================
 *
 * TypeScript port of watchHrApi.js.  Drop in mobile/services/api/
 * alongside the existing API modules.  Uses the same client.ts setup
 * already present in that folder.
 *
 * Changes (fix 11.3):
 *   - streamHrSamples() now catches HTTP 429 (hard session cap: 15 min /
 *     1 800 samples) and returns { sessionCapReached: true } instead of
 *     throwing.  Callers MUST NOT retry 429 — it is a hard limit.
 *   - StreamHrSamplesResult extended with optional sessionCapReached flag.
 *   - Caller responsibility: when sessionCapReached === true, automatically
 *     call endWatchSession() and show the user an alert.
 *
 * Usage (in a hook or screen):
 *
 *   import { startWatchSession, streamHrSamples, endWatchSession } from '../services/api/watch-hr';
 *
 *   const { session_id } = await startWatchSession({ intensity: 'moderate' });
 *   const result = await streamHrSamples({ session_id, samples: [...] });
 *   if (result.sessionCapReached) {
 *     await endWatchSession({ session_id });
 *     Alert.alert('Session Complete', 'Maximum session duration reached (15 min). Session saved.');
 *     return;
 *   }
 *
 * Version: 1.1
 * =============================================================================
 */

import axios from 'axios';
import { apiClient } from './client';  // adjust path to your existing axios wrapper

// ─── Types ─────────────────────────────────────────────────────────────────

export type ActivityIntensity = 'light' | 'moderate' | 'vigorous';

export interface HrSampleByMinute {
  t_min:   number;
  hr_bpm:  number;
}

export interface HrSampleByTimestamp {
  timestamp_iso: string;
  hr_bpm:        number;
}

export type HrSample = HrSampleByMinute | HrSampleByTimestamp;

export interface StartWatchSessionParams {
  intensity?:  ActivityIntensity;
  hr_base?:    number;
  hr_max?:     number;
  start_time?: string;   // ISO-8601
  notes?:      string;
}

export interface StartWatchSessionResult {
  session_id:  string;
  started_at:  string;
  message:     string;
}

export interface StreamHrSamplesParams {
  session_id: string;
  samples:    HrSample[];
}

export interface StreamHrSamplesResult {
  session_id:     string;
  samples_added:  number;
  total_samples:  number;
  /**
   * True when the endpoint returned HTTP 429 (hard 15-min / 1 800-sample cap).
   *
   * ⚠️  Caller MUST:
   *   1. Call endWatchSession({ session_id }) automatically.
   *   2. Show alert: "Maximum session duration reached (15 min). Session saved."
   *   3. NEVER retry — 429 is a hard limit, not a transient error.
   */
  sessionCapReached?: boolean;
}

export interface EndWatchSessionParams {
  session_id:  string;
  end_time?:   string;           // ISO-8601
  intensity?:  ActivityIntensity;  // override auto-inferred label
}

export interface EndWatchSessionResult {
  session_id:       string;
  duration_minutes: number;
  intensity:        ActivityIntensity;
  total_samples:    number;
  hr_base:          number;
  hr_max:           number;
  completed_at:     string;
  message:          string;
}

export interface WatchSessionStatus {
  active:        boolean;
  session_id:    string | null;
  started_at:    string | null;
  total_samples: number;
  intensity:     ActivityIntensity | null;
}

// ─── API functions ──────────────────────────────────────────────────────────

/**
 * Begin a watch-driven activity session on the server.
 */
export async function startWatchSession(
  params: StartWatchSessionParams = {}
): Promise<StartWatchSessionResult> {
  const response = await apiClient.post<StartWatchSessionResult>(
    '/api/watch/activity/start',
    params
  );
  return response.data;
}

/**
 * Push a batch of HR readings to an in-progress session.
 * Call periodically from the watch sync loop (e.g. every 30 s).
 *
 * Fix 11.3: returns { sessionCapReached: true } on HTTP 429 instead of
 * throwing.  The cap is 1 800 samples / 15 minutes — a hard limit.
 * DO NOT retry on 429.
 */
export async function streamHrSamples(
  params: StreamHrSamplesParams
): Promise<StreamHrSamplesResult & { sessionCapReached?: boolean }> {
  try {
    const response = await apiClient.post<StreamHrSamplesResult>(
      '/api/watch/hr/stream',
      params
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      // Hard cap reached (15 min / 1 800 samples). Do NOT retry.
      // Return a sentinel that tells the caller to end the session.
      console.warn(
        '[WatchHR] streamHrSamples: HTTP 429 — session cap reached.',
        'Call endWatchSession() and notify the user.'
      );
      return {
        session_id:       params.session_id,
        samples_added:    0,
        total_samples:    1800,
        sessionCapReached: true,
      };
    }
    // All other errors re-throw so the caller's error handler fires normally
    throw error;
  }
}

/**
 * Finalise the session and convert it to a completed activity.
 * The ODE pharmacodynamics engine picks it up automatically.
 */
export async function endWatchSession(
  params: EndWatchSessionParams
): Promise<EndWatchSessionResult> {
  const response = await apiClient.post<EndWatchSessionResult>(
    '/api/watch/activity/end',
    params
  );
  return response.data;
}

/**
 * Recover an existing in-progress session after app restart / disconnect.
 */
export async function getWatchSessionStatus(): Promise<WatchSessionStatus> {
  const response = await apiClient.get<WatchSessionStatus>(
    '/api/watch/activity/status'
  );
  return response.data;
}