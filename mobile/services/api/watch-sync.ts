/**
 * watch-sync.ts — Google Fit Sync API service
 * Location: mobile/services/api/watch-sync.ts
 *
 * Wraps all /api/watch/* backend endpoints.
 * Mirrors libre.ts exactly.
 */

import apiClient from './client';
import type {
  WatchConnectionStatus,
  WatchConnectPayload,
  WatchConnectResponse,
  WatchOAuthUrlResponse,
  WatchSettingsPayload,
  WatchSyncResult,
} from '@/types/watch.types';

// ── Endpoint constants (add these to your endpoints.ts) ───────────────────────
//
//   WATCH: {
//     OAUTH_URL:  '/api/watch/oauth-url',
//     CONNECT:    '/api/watch/connect',
//     STATUS:     '/api/watch/status',
//     SYNC:       '/api/watch/sync',
//     SETTINGS:   '/api/watch/settings',
//     DISCONNECT: '/api/watch/disconnect',
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

const WATCH = {
  OAUTH_URL:  '/api/watch/oauth-url',
  CONNECT:    '/api/watch/connect',
  STATUS:     '/api/watch/status',
  SYNC:       '/api/watch/sync',
  SETTINGS:   '/api/watch/settings',
  DISCONNECT: '/api/watch/disconnect',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/watch/oauth-url
// ─────────────────────────────────────────────────────────────────────────────

export async function getWatchOAuthUrl(): Promise<string> {
  const { data } = await apiClient.get<WatchOAuthUrlResponse>(WATCH.OAUTH_URL);
  return data.url;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/watch/connect
// ─────────────────────────────────────────────────────────────────────────────

export async function connectWatch(
  payload: WatchConnectPayload,
): Promise<WatchConnectResponse> {
  const { data } = await apiClient.post<WatchConnectResponse>(
    WATCH.CONNECT,
    payload,
  );
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/watch/status
// ─────────────────────────────────────────────────────────────────────────────

export async function getWatchStatus(): Promise<WatchConnectionStatus> {
  const { data } = await apiClient.get<WatchConnectionStatus>(WATCH.STATUS);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/watch/sync
// ─────────────────────────────────────────────────────────────────────────────

export async function syncWatch(): Promise<WatchSyncResult & { message: string }> {
  const { data } = await apiClient.post(WATCH.SYNC);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/watch/settings
// ─────────────────────────────────────────────────────────────────────────────

export async function updateWatchSettings(
  settings: WatchSettingsPayload,
): Promise<{ message: string; settings: WatchSettingsPayload }> {
  const { data } = await apiClient.put(WATCH.SETTINGS, settings);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/watch/disconnect
// ─────────────────────────────────────────────────────────────────────────────

export async function disconnectWatch(
  deleteActivities = false,
): Promise<{ message: string; deleted_activities: number }> {
  const { data } = await apiClient.delete(WATCH.DISCONNECT, {
    params: deleteActivities ? { delete_activities: 'true' } : undefined,
  });
  return data;
}
