/**
 * Offline Hook
 * Location: mobile/hooks/useOffline.ts
 *
 * Main Hook: useOffline
 * Description: Hook for network status monitoring and offline queue management with automatic sync
 *
 * Features:
 * - Real-time network status monitoring
 * - Offline action queue management
 * - Automatic sync when connection restores
 * - Failed action retry mechanism
 * - Queue persistence across sessions
 * - Action status tracking (pending, syncing, failed)
 * - Last sync timestamp tracking
 */

import { useEffect, useCallback } from 'react';

// Utils
import { Network } from '@/utils/network';

// Store
import { useOfflineStore } from '@/store/offline.store';

// Types
import type { OfflineAction } from '@/store/offline.store';

export interface UseOfflineResult {
  isOnline: boolean;
  pendingActions: OfflineAction[];
  pendingCount: number;
  failedCount: number;
  isSyncing: boolean;
  lastSync: number | null;
  syncError: string | null;

  /** Queue an action for offline sync */
  queueAction: (action: Omit<OfflineAction, 'id' | 'status' | 'retryCount'>) => string;
  /** Process the offline queue */
  processQueue: () => Promise<void>;
  /** Clear all queued actions */
  clearQueue: () => void;
  /** Remove a specific action from queue */
  removeAction: (id: string) => void;
  /** Retry failed actions */
  retryFailed: () => Promise<void>;
}

/**
 * Hook for offline detection and queue management
 */
export const useOffline = (): UseOfflineResult => {
  const {
    isOnline,
    pendingActions,
    isSyncing,
    lastSync,
    syncError,
    setOnline,
    enqueue,
    dequeue,
    processQueue,
    clearQueue,
    loadQueue,
  } = useOfflineStore();

  // Set up network listener
  useEffect(() => {
    // Load saved queue on mount
    loadQueue();

    // Subscribe to network state changes
    const unsubscribe = Network.addEventListener((state) => {
      setOnline(state.isConnected ?? false);
    });

    // Check initial network state
    Network.fetch().then((state) => {
      setOnline(state.isConnected ?? false);
    });

    return () => {
      unsubscribe();
    };
  }, [loadQueue, setOnline]);

  const queueAction = useCallback(
    (action: Omit<OfflineAction, 'id' | 'status' | 'retryCount'>) => {
      return enqueue(action);
    },
    [enqueue]
  );

  const removeAction = useCallback(
    (id: string) => {
      dequeue(id);
    },
    [dequeue]
  );

  const retryFailed = useCallback(async () => {
    // Reset failed actions to pending
    const { pendingActions: actions, updateActionStatus } = useOfflineStore.getState();
    actions
      .filter((a) => a.status === 'failed')
      .forEach((a) => {
        updateActionStatus(a.id, 'pending');
      });

    // Process queue
    await processQueue();
  }, [processQueue]);

  const pendingCount = pendingActions.filter((a) => a.status === 'pending').length;
  const failedCount = pendingActions.filter((a) => a.status === 'failed').length;

  return {
    isOnline,
    pendingActions,
    pendingCount,
    failedCount,
    isSyncing,
    lastSync,
    syncError,
    queueAction,
    processQueue,
    clearQueue,
    removeAction,
    retryFailed,
  };
};

export default useOffline;