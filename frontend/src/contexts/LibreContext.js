/**
 * LibreContext.js — LibreLinkUp Single Source of Truth
 * Location: frontend/src/contexts/LibreContext.js
 *
 * Exports (all from one import path):
 *
 *   API             connectLibre, disconnectLibre, getLibreStatus,
 *                   getLibreReadings, syncLibre, updateLibreSettings
 *
 *   Display utils   getTrendArrow, getTrendLabel, getTrendColor,
 *                   getReadingColor, formatReadingTime, timeAgo,
 *                   formatDayLabel, groupReadingsByDay
 *
 *   Constants       LIBRE_REGION_OPTIONS, TREND_ARROW, TREND_LABEL
 *
 *   Context         LibreProvider, useLibre, useLibreState, useLibreActions
 *
 * Usage:
 *   import { LibreProvider, useLibre, formatReadingTime } from '../contexts/LibreContext';
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// § 1 · API helpers
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5000';

function authHeader() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(method, path, { body, params } = {}) {
  const url = new URL(API_BASE + path);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json();
}

/** GET /api/libre/status */
export async function getLibreStatus(fetchLatest = false) {
  return request('GET', '/api/libre/status', {
    params: fetchLatest ? { fetch_latest: 'true' } : undefined,
  });
}

/** GET /api/libre/readings */
export async function getLibreReadings({ hours = 24, sync = false, start_time, end_time } = {}) {
  return request('GET', '/api/libre/readings', {
    params: { hours, sync: sync ? 'true' : 'false', start_time, end_time },
  });
}

/** POST /api/libre/sync */
export async function syncLibre() {
  return request('POST', '/api/libre/sync');
}

/** POST /api/libre/connect */
export async function connectLibre(payload) {
  return request('POST', '/api/libre/connect', { body: payload });
}

/** DELETE /api/libre/disconnect */
export async function disconnectLibre(deleteReadings = false) {
  return request('DELETE', '/api/libre/disconnect', {
    params: deleteReadings ? { delete_readings: 'true' } : undefined,
  });
}

/** PUT /api/libre/settings */
export async function updateLibreSettings(settings) {
  return request('PUT', '/api/libre/settings', { body: settings });
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2 · Constants
// ─────────────────────────────────────────────────────────────────────────────

export const LIBRE_REGION_OPTIONS = [
  { value: 'EU',  label: 'Europe (default)' },
  { value: 'EU2', label: 'Europe 2' },
  { value: 'US',  label: 'United States' },
  { value: 'DE',  label: 'Germany' },
  { value: 'FR',  label: 'France' },
  { value: 'JP',  label: 'Japan' },
  { value: 'AP',  label: 'Asia Pacific' },
  { value: 'AU',  label: 'Australia' },
  { value: 'AE',  label: 'UAE / Middle East' },
];

export const TREND_ARROW = { 1: '↑↑', 2: '↑', 3: '→', 4: '↓', 5: '↓↓' };
export const TREND_LABEL = {
  1: 'Rapidly Rising',
  2: 'Rising',
  3: 'Stable',
  4: 'Falling',
  5: 'Rapidly Falling',
};

// ─────────────────────────────────────────────────────────────────────────────
// § 3 · Display helpers
// ─────────────────────────────────────────────────────────────────────────────

export const getTrendArrow = (trend) => TREND_ARROW[trend] ?? '–';
export const getTrendLabel = (trend) => TREND_LABEL[trend] ?? 'Unknown';

export function getTrendColor(trend) {
  if (!trend) return '#6b7280';
  if (trend === 1 || trend === 5) return '#ef4444';
  if (trend === 2 || trend === 4) return '#f97316';
  return '#22c55e';
}

export function getReadingColor({ is_low, is_high, status }) {
  if (is_low  || status === 'low')  return '#ef4444';
  if (is_high || status === 'high') return '#f97316';
  return '#22c55e';
}

function toUtcDate(iso) {
  const s = iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z';
  return new Date(s);
}

export function formatReadingTime(iso) {
  return toUtcDate(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  const diffMs  = Date.now() - toUtcDate(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2)  return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)  return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

export function formatDayLabel(dateStr) {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (dateStr === today)     return 'Today';
  if (dateStr === yesterday) return 'Yesterday';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

export function groupReadingsByDay(readings) {
  const map = new Map();
  for (const r of readings) {
    const d   = toUtcDate(r.bloodSugarTimestamp);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(r);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, dayReadings]) => ({
      date,
      readings: dayReadings.sort((a, b) =>
        b.bloodSugarTimestamp.localeCompare(a.bloodSugarTimestamp)
      ),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4 · Reducer
// ─────────────────────────────────────────────────────────────────────────────

const initialState = {
  status:           null,
  connected:        false,
  readings:         [],
  grouped:          [],
  readingCount:     0,
  statusLoading:    true,
  readingsLoading:  false,
  syncing:          false,
  connecting:       false,
  disconnecting:    false,
  updatingSettings: false,
  statusError:      null,
  readingsError:    null,
  actionError:      null,
  syncResult:       null,
};

function reducer(state, { type, payload }) {
  switch (type) {
    case 'STATUS_LOADING':
      return { ...state, statusLoading: true, statusError: null };
    case 'STATUS_SUCCESS':
      return { ...state, status: payload, connected: payload?.connected ?? false, statusLoading: false, statusError: null };
    case 'STATUS_ERROR':
      return { ...state, statusLoading: false, statusError: payload };

    case 'READINGS_LOADING':
      return { ...state, readingsLoading: true, readingsError: null };
    case 'READINGS_SUCCESS': {
      const readings = payload.readings ?? [];
      return {
        ...state,
        readings,
        grouped:         groupReadingsByDay(readings),
        readingCount:    payload.count ?? readings.length,
        readingsLoading: false,
        readingsError:   null,
      };
    }
    case 'READINGS_ERROR':
      return { ...state, readingsLoading: false, readingsError: payload };

    case 'SYNC_START':    return { ...state, syncing: true,  actionError: null };
    case 'SYNC_SUCCESS':  return { ...state, syncing: false, syncResult: payload };
    case 'SYNC_ERROR':    return { ...state, syncing: false, actionError: payload };

    case 'CONNECT_START':   return { ...state, connecting: true,  actionError: null };
    case 'CONNECT_SUCCESS': return { ...state, connecting: false, connected: true, status: payload.status, actionError: null };
    case 'CONNECT_ERROR':   return { ...state, connecting: false, actionError: payload };

    case 'DISCONNECT_START':
      return { ...state, disconnecting: true, actionError: null };
    case 'DISCONNECT_SUCCESS':
      return { ...state, disconnecting: false, connected: false, status: null, readings: [], grouped: [], readingCount: 0, actionError: null };
    case 'DISCONNECT_ERROR':
      return { ...state, disconnecting: false, actionError: payload };

    case 'SETTINGS_START':   return { ...state, updatingSettings: true,  actionError: null };
    case 'SETTINGS_SUCCESS': return {
      ...state,
      updatingSettings: false,
      status: state.status ? { ...state.status, ...payload.settings } : state.status,
    };
    case 'SETTINGS_ERROR':   return { ...state, updatingSettings: false, actionError: payload };

    case 'CLEAR_ACTION_ERROR': return { ...state, actionError: null };

    default: return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5 · Context + Provider
// ─────────────────────────────────────────────────────────────────────────────

const LibreStateContext   = createContext(null);
const LibreActionsContext = createContext(null);

/**
 * Wrap the Libre section of your app with <LibreProvider>.
 * @param {{ children: React.ReactNode, readingsHours?: number }} props
 */
export function LibreProvider({ children, readingsHours = 24 }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const bootstrapped = useRef(false);

  const fetchStatus = useCallback(async (fetchLatest = false) => {
    dispatch({ type: 'STATUS_LOADING' });
    try {
      const data = await getLibreStatus(fetchLatest);
      dispatch({ type: 'STATUS_SUCCESS', payload: data });
      return data;
    } catch (err) {
      dispatch({ type: 'STATUS_ERROR', payload: err.message });
      return null;
    }
  }, []);

  const fetchReadings = useCallback(async (opts = {}) => {
    dispatch({ type: 'READINGS_LOADING' });
    try {
      const data = await getLibreReadings({ hours: readingsHours, ...opts });
      dispatch({ type: 'READINGS_SUCCESS', payload: data });
      return data;
    } catch (err) {
      dispatch({ type: 'READINGS_ERROR', payload: err.message });
      return null;
    }
  }, [readingsHours]);

  // Bootstrap once on mount
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      const status = await fetchStatus(false);
      if (status?.connected) {
        await fetchReadings();
      } else {
        dispatch({ type: 'READINGS_SUCCESS', payload: { readings: [], count: 0 } });
      }
    })();
  }, [fetchStatus, fetchReadings]);

  const sync = useCallback(async () => {
    dispatch({ type: 'SYNC_START' });
    try {
      const result = await syncLibre();
      dispatch({ type: 'SYNC_SUCCESS', payload: result });
      await fetchReadings();
      return result;
    } catch (err) {
      dispatch({ type: 'SYNC_ERROR', payload: err.message });
      return null;
    }
  }, [fetchReadings]);

  const connect = useCallback(async (payload) => {
    dispatch({ type: 'CONNECT_START' });
    try {
      const result = await connectLibre(payload);
      dispatch({ type: 'CONNECT_SUCCESS', payload: result });
      await fetchReadings();
      return result;
    } catch (err) {
      dispatch({ type: 'CONNECT_ERROR', payload: err.message });
      return null;
    }
  }, [fetchReadings]);

  const disconnect = useCallback(async (deleteReadings = false) => {
    dispatch({ type: 'DISCONNECT_START' });
    try {
      const result = await disconnectLibre(deleteReadings);
      dispatch({ type: 'DISCONNECT_SUCCESS' });
      return result;
    } catch (err) {
      dispatch({ type: 'DISCONNECT_ERROR', payload: err.message });
      return null;
    }
  }, []);

  const updateSettings = useCallback(async (settings) => {
    dispatch({ type: 'SETTINGS_START' });
    try {
      const result = await updateLibreSettings(settings);
      dispatch({ type: 'SETTINGS_SUCCESS', payload: result });
      return result;
    } catch (err) {
      dispatch({ type: 'SETTINGS_ERROR', payload: err.message });
      return null;
    }
  }, []);

  const clearActionError = useCallback(() => dispatch({ type: 'CLEAR_ACTION_ERROR' }), []);

  const actions = { fetchStatus, fetchReadings, sync, connect, disconnect, updateSettings, clearActionError };

  return (
    <LibreStateContext.Provider value={state}>
      <LibreActionsContext.Provider value={actions}>
        {children}
      </LibreActionsContext.Provider>
    </LibreStateContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6 · Consumer hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useLibreState() {
  const ctx = useContext(LibreStateContext);
  if (!ctx) throw new Error('useLibreState must be used inside <LibreProvider>');
  return ctx;
}

export function useLibreActions() {
  const ctx = useContext(LibreActionsContext);
  if (!ctx) throw new Error('useLibreActions must be used inside <LibreProvider>');
  return ctx;
}

/** Convenience hook — state + actions in one call. */
export function useLibre() {
  return { ...useLibreState(), ...useLibreActions() };
}
