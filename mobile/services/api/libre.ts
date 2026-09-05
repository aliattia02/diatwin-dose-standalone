/**
 * LibreLinkUp API service
 * Location: mobile/services/api/libre.ts
 *
 * Wraps all /api/libre/* backend endpoints.
 * Called by useLibre.ts hooks.
 */

import apiClient from './client';
import API from './endpoints';
import type {
  LibreConnectionStatus,
  LibreConnectPayload,
  LibreConnectResponse,
  LibreReadingsResponse,
  LibreSyncResult,
  LibreSettingsPayload,
} from '@/types/libre.types';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/libre/status
// ─────────────────────────────────────────────────────────────────────────────

export async function getLibreStatus(
  fetchLatest = false
): Promise<LibreConnectionStatus> {
  const { data } = await apiClient.get<LibreConnectionStatus>(API.LIBRE.STATUS, {
    params: fetchLatest ? { fetch_latest: 'true' } : undefined,
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/libre/readings
// ─────────────────────────────────────────────────────────────────────────────

export interface GetLibreReadingsParams {
  hours?: number;
  sync?: boolean;
  start_time?: string;
  end_time?: string;
}

export async function getLibreReadings(
  params: GetLibreReadingsParams = {}
): Promise<LibreReadingsResponse> {
  const { data } = await apiClient.get<LibreReadingsResponse>(API.LIBRE.READINGS, {
    params: {
      hours:      params.hours ?? 24,
      sync:       params.sync ? 'true' : 'false',
      start_time: params.start_time,
      end_time:   params.end_time,
    },
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/libre/sync
// ─────────────────────────────────────────────────────────────────────────────

export async function syncLibre(): Promise<
  LibreSyncResult & { message: string }
> {
  const { data } = await apiClient.post(API.LIBRE.SYNC);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/libre/connect
// ─────────────────────────────────────────────────────────────────────────────

export async function connectLibre(
  payload: LibreConnectPayload
): Promise<LibreConnectResponse> {
  const { data } = await apiClient.post<LibreConnectResponse>(
    API.LIBRE.CONNECT,
    payload
  );
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/libre/disconnect
// ─────────────────────────────────────────────────────────────────────────────

export async function disconnectLibre(
  deleteReadings = false
): Promise<{ message: string; deleted_readings: number }> {
  const { data } = await apiClient.delete(API.LIBRE.DISCONNECT, {
    params: deleteReadings ? { delete_readings: 'true' } : undefined,
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/libre/settings
// ─────────────────────────────────────────────────────────────────────────────

export async function updateLibreSettings(
  settings: LibreSettingsPayload
): Promise<{ message: string; settings: LibreSettingsPayload }> {
  const { data } = await apiClient.put(API.LIBRE.SETTINGS, settings);
  return data;
}