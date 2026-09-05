/**
 * useLibre hook
 * Location: mobile/hooks/useLibre.ts
 *
 * Wraps the libre API service with loading/error state management,
 * using the same useApi / useApiEffect patterns as the rest of the app.
 *
 * Provides:
 *   - CGM reading history (grouped by day, paginated by hours)
 *   - Connection status
 *   - Manual sync
 *   - Latest reading
 */

import { useCallback, useState } from 'react';
import { useApi, useApiEffect } from './useApi';
import {
  getLibreReadings,
  getLibreStatus,
  syncLibre,
  connectLibre,
  disconnectLibre,
  updateLibreSettings,
  type GetLibreReadingsParams,
} from '@/services/api/libre';
import type {
  LibreConnectionStatus,
  LibreReading,
  LibreConnectPayload,
  LibreSettingsPayload,
  LibreSyncResult,
} from '@/types/libre.types';
import { groupReadingsByDay } from '@/types/libre.types';

// ─────────────────────────────────────────────────────────────────────────────
// useLibreStatus — connection status + latest live reading
// ─────────────────────────────────────────────────────────────────────────────

export function useLibreStatus(fetchLatest = false) {
  const fetcher = useCallback(
    () => getLibreStatus(fetchLatest),
    [fetchLatest]
  );

  const { data, isLoading, error, refetch } = useApiEffect<LibreConnectionStatus>(
    fetcher,
    [fetchLatest]
  );

  return {
    status:    data,
    connected: data?.connected ?? false,
    isLoading,
    error,
    refresh:   refetch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// useLibreReadings — CGM history with day grouping
// ─────────────────────────────────────────────────────────────────────────────

export interface UseLibreReadingsOptions {
  /** Hours of history to fetch. Default 24. Max 168 (7 days). */
  hours?: number;
  /** Perform a live sync before returning readings */
  syncOnLoad?: boolean;
}

export function useLibreReadings(options: UseLibreReadingsOptions = {}) {
  const { hours = 24, syncOnLoad = false } = options;

  const [syncResult, setSyncResult] = useState<LibreSyncResult | null>(null);

  const fetcher = useCallback(
    () => getLibreReadings({ hours, sync: syncOnLoad }),
    [hours, syncOnLoad]
  );

  const { data, isLoading, error, refetch } = useApiEffect(fetcher, [hours, syncOnLoad]);

  const readings: LibreReading[] = data?.readings ?? [];
  const grouped  = groupReadingsByDay(readings);
  const latest   = readings.length > 0 ? readings[readings.length - 1] : null;

  // Manual sync then refresh stored readings
  const { execute: executeSync, isLoading: isSyncing } = useApi(syncLibre);

  const sync = useCallback(async () => {
    const result = await executeSync();
    if (result) {
      setSyncResult({
        new_count:      result.new_count,
        skipped_count:  result.skipped_count,
        latest_reading: result.latest_reading,
      });
      await refetch();
    }
    return result;
  }, [executeSync, refetch]);

  return {
    readings,
    grouped,
    latest,
    count:      data?.count ?? 0,
    isLoading,
    isSyncing,
    error,
    syncResult,
    refresh:    refetch,
    sync,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// useLibreConnect — connect / disconnect / settings mutations
// ─────────────────────────────────────────────────────────────────────────────

export function useLibreConnect() {
  const { execute: executeConnect, isLoading: isConnecting, error: connectError } =
    useApi(connectLibre);

  const { execute: executeDisconnect, isLoading: isDisconnecting } =
    useApi((deleteReadings: boolean) => disconnectLibre(deleteReadings));

  const { execute: executeUpdateSettings, isLoading: isUpdatingSettings } =
    useApi(updateLibreSettings);

  const connect = useCallback(
    (payload: LibreConnectPayload) => executeConnect(payload),
    [executeConnect]
  );

  const disconnect = useCallback(
    (deleteReadings = false) => executeDisconnect(deleteReadings),
    [executeDisconnect]
  );

  const updateSettings = useCallback(
    (settings: LibreSettingsPayload) => executeUpdateSettings(settings),
    [executeUpdateSettings]
  );

  return {
    connect,
    disconnect,
    updateSettings,
    isConnecting,
    isDisconnecting,
    isUpdatingSettings,
    connectError,
  };
}
