/**
 * mobile/services/api/client.ts
 *
 * Changes in this version:
 *  1. Added `wakeUpServer()` — polls /api/health until the Render dyno is awake,
 *     with a user-visible progress callback (0→100 %). Call this before login.
 *  2. Retry interceptor bumped: MAX_RETRIES = 4, exponential back-off capped at 15 s.
 *     Total coverage ≈ 2+4+8+15 = 29 s of retries on top of the 90 s timeout,
 *     enough for a Render cold-start (typically 30–60 s).
 *  3. ERR_NETWORK added to the retry condition so the "sometimes" Network Error
 *     on login is now automatically retried instead of surfaced immediately.
 */

import axios from 'axios';
import { Platform } from 'react-native';
import { secureStorage, STORAGE_KEYS } from '../../utils/storage';
import API from './endpoints'; // I-23: use endpoints as single source of truth for HEALTH path

// ─── Config ───────────────────────────────────────────────────────────────────

const TIMEOUT_MS      = 90_000;  // 90 s per request — covers Render cold-start
const MAX_RETRIES     = 4;       // was 2 → now covers ~29 s of back-off
const RETRY_BASE_MS   = 2_000;   // doubles each retry, capped at 15 s
const RETRY_CAP_MS    = 15_000;

// wakeUpServer constants
const WAKE_POLL_MS    = 5_000;   // ping every 5 s
const WAKE_TIMEOUT_MS = 90_000;  // give up after 90 s
const HEALTH_ENDPOINT = API.INTERNAL.HEALTH; // I-23: was hardcoded '/api/health'

const getApiBaseUrl = (): string => {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl && envUrl.trim() !== '') {
    console.log('[API Client] Using URL from environment:', envUrl);
    return envUrl;
  }
  console.warn('[API Client] ⚠️ EXPO_PUBLIC_API_URL not set — falling back to localhost:5000');
  return 'http://localhost:5000';
};

const API_BASE_URL = getApiBaseUrl();
console.log('[API Client] Initialized with base URL:', API_BASE_URL);
console.log('[API Client] Platform:', Platform.OS);

// ─── Diagnosing "no response" ─────────────────────────────────────────────────

/**
 * Why a request produced no response.
 *
 * A CORS block and a cold start are indistinguishable to axios: in both cases
 * `error.response` is undefined and `error.code` is `ERR_NETWORK`. This module
 * used to report every one of them as a Render cold start, which cost a full
 * diagnostic round trip on 5 September — the server was awake and the browser
 * was discarding the response for a missing `Access-Control-Allow-Origin`.
 *
 * The two can be told apart. A `fetch(..., { mode: 'no-cors' })` is dispatched
 * by the browser without requiring CORS response headers and resolves to an
 * opaque response whenever the server is reachable. So:
 *
 *   probe resolves  → the server answered; the CORS headers are the problem
 *   probe rejects   → nothing answered; cold start, DNS, or offline
 *
 * There is no CORS on native, so that platform keeps the cold-start message.
 * The probe is diagnostic only: it runs after the request has already failed,
 * its result is logged rather than returned, and it never throws.
 */
const isCrossOriginWeb = (): boolean => {
  if (Platform.OS !== 'web') return false;
  try {
    const pageOrigin = globalThis.location?.origin;
    if (!pageOrigin) return false;
    return new URL(API_BASE_URL, pageOrigin).origin !== pageOrigin;
  } catch {
    return false;
  }
};

const reportNoResponseCause = async (): Promise<void> => {
  const isLocal =
    API_BASE_URL.includes('localhost') || API_BASE_URL.includes('127.0.0.1');

  if (!isCrossOriginWeb()) {
    console.error(
      isLocal
        ? `[API Error] No response from local server — is Flask running on ${API_BASE_URL}?`
        : '[API Error] No response after retries — Render free tier may need ~60 s to cold-start.',
    );
    return;
  }

  let reachable = false;
  try {
    await fetch(`${API_BASE_URL}${HEALTH_ENDPOINT}`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
    });
    reachable = true;
  } catch {
    reachable = false;
  }

  if (reachable) {
    console.error(
      `[API Error] The server at ${API_BASE_URL} is reachable, but the browser ` +
        `discarded its response.\n` +
        `  This is a CORS failure, not a cold start: the response carried no ` +
        `usable Access-Control-Allow-Origin\n` +
        `  for origin ${globalThis.location?.origin}.\n` +
        `  Check CORS_ORIGINS on the backend (backend/config.py) — the deployed ` +
        `web origin must be listed.`,
    );
  } else {
    console.error(
      `[API Error] No response from ${API_BASE_URL}, and it did not answer an ` +
        `opaque probe either.\n` +
        `  The server is not reachable: Render free tier may need ~60 s to ` +
        `cold-start, or the host/network is down.`,
    );
  }
};

// ─── Axios client ─────────────────────────────────────────────────────────────

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // Tells the backend this is a mobile client → 90-day token instead of 24 h
    'X-Client-Type': 'mobile',
  },
});

// ─── Request interceptor: attach stored token ────────────────────────────────

apiClient.interceptors.request.use(
  async (config) => {
    try {
      const token = await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);
      if (token) config.headers.Authorization = `Bearer ${token}`;
    } catch (err) {
      console.error('[API Client] Error reading token:', err);
    }
    console.log(`[API Request] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  },
  (error) => {
    console.error('[API Request Error]', error);
    return Promise.reject(error);
  }
);

// ─── Response interceptor: retry + error handling ────────────────────────────

apiClient.interceptors.response.use(
  (response) => {
    console.log(`[API Response] ${response.status} ← ${response.config.url}`);
    return response;
  },
  async (error) => {
    if (!axios.isAxiosError(error)) return Promise.reject(error);

    const config = error.config as any;
    config.__retryCount = config.__retryCount ?? 0;

    const isTimeout    = error.code === 'ECONNABORTED';
    const isNetwork    = error.code === 'ERR_NETWORK' || error.message.includes('Network Error');
    const isNoResponse = !error.response;
    const status       = error.response?.status ?? 0;
    const isServerErr  = status === 502 || status === 503 || status === 504;

    // Retry on network errors AND server errors (covers Render cold-start)
    const shouldRetry =
      (isTimeout || isNetwork || isNoResponse || isServerErr) &&
      config.__retryCount < MAX_RETRIES;

    if (shouldRetry) {
      config.__retryCount += 1;
      const delay = Math.min(RETRY_BASE_MS * Math.pow(2, config.__retryCount - 1), RETRY_CAP_MS);
      console.warn(
        `[API] Retry ${config.__retryCount}/${MAX_RETRIES} for ${config.url} ` +
        `(${error.code ?? status}) — waiting ${delay}ms`
      );
      await new Promise((res) => setTimeout(res, delay));
      return apiClient(config);
    }

    // Log final failure
    console.error('[API Error]', JSON.stringify({
      url:     error.config?.url,
      method:  error.config?.method,
      status:  error.response?.status,
      message: error.message,
      code:    error.code,
    }, null, 2));

    if (isNoResponse || isNetwork) {
      void reportNoResponseCause();
    }

    // Clear credentials on 401
    if (status === 401) {
      console.log('[API Error] Unauthorized — clearing stored credentials');
      await secureStorage.remove(STORAGE_KEYS.AUTH_TOKEN);
      await secureStorage.remove(STORAGE_KEYS.USER_DATA);
    }

    return Promise.reject(error);
  }
);

// ─── wakeUpServer ─────────────────────────────────────────────────────────────

export type WakeProgress = {
  /** 0–100, increases as polls succeed / timeout approaches */
  percent: number;
  /** Human-readable status line for display in UI */
  message: string;
  /** True once the server responded with 200 */
  ready: boolean;
};

/**
 * Poll /api/health every WAKE_POLL_MS until the server responds 200,
 * or until WAKE_TIMEOUT_MS elapses.
 *
 * Calls `onProgress` on every tick so the login screen can show a
 * "Server starting up… 34%" indicator instead of a frozen spinner.
 *
 * Returns `true` if the server woke up in time, `false` on timeout.
 *
 * Usage:
 *   const ready = await wakeUpServer((p) => setWakeProgress(p));
 *   if (!ready) { show error }
 *   else { proceed with login }
 */
export const wakeUpServer = async (
  onProgress?: (p: WakeProgress) => void
): Promise<boolean> => {
  const isLocal = API_BASE_URL.includes('localhost') || API_BASE_URL.includes('127.0.0.1');

  // For local development, skip the poller — the server is either up or not
  if (isLocal) {
    try {
      await apiClient.get(HEALTH_ENDPOINT, { timeout: 5_000 });
      onProgress?.({ percent: 100, message: 'Server ready', ready: true });
      return true;
    } catch {
      onProgress?.({ percent: 0, message: 'Local server not responding', ready: false });
      return false;
    }
  }

  const startTime = Date.now();
  let attempt = 0;

  onProgress?.({ percent: 0, message: 'Connecting to server…', ready: false });

  while (Date.now() - startTime < WAKE_TIMEOUT_MS) {
    attempt++;
    const elapsed  = Date.now() - startTime;
    const percent  = Math.min(Math.round((elapsed / WAKE_TIMEOUT_MS) * 90), 90); // cap at 90 until confirmed

    try {
      await apiClient.get(HEALTH_ENDPOINT, { timeout: 8_000 });
      onProgress?.({ percent: 100, message: 'Server ready!', ready: true });
      console.log(`[wakeUpServer] Server awake after ${elapsed}ms (attempt ${attempt})`);
      return true;
    } catch (err) {
      const msg = attempt === 1
        ? 'Server is starting up…'
        : `Server starting up… (${Math.round(elapsed / 1000)}s)`;
      onProgress?.({ percent, message: msg, ready: false });
      console.log(`[wakeUpServer] Attempt ${attempt} failed — retrying in ${WAKE_POLL_MS}ms`);
      await new Promise((res) => setTimeout(res, WAKE_POLL_MS));
    }
  }

  onProgress?.({ percent: 0, message: 'Server did not respond in time', ready: false });
  console.error('[wakeUpServer] Timed out after', WAKE_TIMEOUT_MS, 'ms');
  return false;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const isNetworkError = (error: unknown): boolean => {
  if (axios.isAxiosError(error)) {
    return (
      !error.response && (
        error.code === 'ERR_NETWORK'   ||
        error.code === 'ECONNREFUSED'  ||
        error.code === 'ECONNABORTED'  ||
        error.message.includes('Network Error')
      )
    );
  }
  return false;
};

export const isAuthError = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 401;

export const getBaseUrl = (): string => API_BASE_URL;

export default apiClient;