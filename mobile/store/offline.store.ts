/**
 * mobile/store/offline.store.ts - Offline store for managing offline-first data and sync queue
 */

import { create } from 'zustand';
import { storage, STORAGE_KEYS } from '../utils/storage';
import apiClient, { isNetworkError } from '../services/api/client';

export interface OfflineAction {
  id: string;
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  endpoint: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload: Record<string, unknown>;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  status: 'pending' | 'syncing' | 'failed' | 'synced';
  errorMessage?: string;
}

interface OfflineState {
  isOnline: boolean;
  pendingActions: OfflineAction[];
  lastSync: number | null;
  isSyncing: boolean;
  syncError: string | null;

  // Actions
  setOnline: (status: boolean) => void;
  enqueue: (action: Omit<OfflineAction, 'id' | 'status' | 'retryCount'>) => string;
  dequeue: (id: string) => void;
  processQueue: () => Promise<void>;
  clearQueue: () => void;
  loadQueue: () => Promise<void>;
  saveQueue: () => Promise<void>;
  updateActionStatus: (id: string, status: OfflineAction['status'], errorMessage?: string) => void;
}

/**
 * Generate a unique ID for offline actions
 */
const generateId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

export const useOfflineStore = create<OfflineState>((set, get) => ({
  isOnline: true,
  pendingActions: [],
  lastSync: null,
  isSyncing: false,
  syncError: null,

  setOnline: (status: boolean) => {
    const wasOffline = !get().isOnline;
    set({ isOnline: status });

    // If we just came back online, try to process the queue
    if (wasOffline && status) {
      get().processQueue();
    }
  },

  enqueue: (action) => {
    const id = generateId();
    const newAction: OfflineAction = {
      ...action,
      id,
      status: 'pending',
      retryCount: 0,
    };

    set((state) => ({
      pendingActions: [...state.pendingActions, newAction],
    }));

    // Save queue to storage
    get().saveQueue();

    // If online, try to process immediately
    if (get().isOnline) {
      get().processQueue();
    }

    return id;
  },

  dequeue: (id: string) => {
    set((state) => ({
      pendingActions: state.pendingActions.filter((a) => a.id !== id),
    }));
    get().saveQueue();
  },

  processQueue: async () => {
    const state = get();

    if (!state.isOnline || state.isSyncing || state.pendingActions.length === 0) {
      return;
    }

    set({ isSyncing: true, syncError: null });

    const pendingActions = [...state.pendingActions].filter(
      (a) => a.status === 'pending' || a.status === 'failed'
    );

    for (const action of pendingActions) {
      if (!get().isOnline) break;

      try {
        // Update status to syncing
        get().updateActionStatus(action.id, 'syncing');

        // Make the API request
        switch (action.method) {
          case 'POST':
            await apiClient.post(action.endpoint, action.payload);
            break;
          case 'PUT':
            await apiClient.put(action.endpoint, action.payload);
            break;
          case 'PATCH':
            await apiClient.patch(action.endpoint, action.payload);
            break;
          case 'DELETE':
            await apiClient.delete(action.endpoint);
            break;
        }

        // Remove successful action from queue
        get().dequeue(action.id);
      } catch (error) {
        const isNetwork = isNetworkError(error);

        if (isNetwork) {
          // Network error - mark as pending and stop processing
          get().updateActionStatus(action.id, 'pending');
          set({ isOnline: false });
          break;
        } else {
          // Other error - check retry count
          const newRetryCount = action.retryCount + 1;
          if (newRetryCount >= action.maxRetries) {
            // Max retries reached - mark as failed
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            get().updateActionStatus(action.id, 'failed', errorMessage);
          } else {
            // Update retry count and mark as pending for next attempt
            set((state) => ({
              pendingActions: state.pendingActions.map((a) =>
                a.id === action.id
                  ? { ...a, retryCount: newRetryCount, status: 'pending' as const }
                  : a
              ),
            }));
          }
        }
      }
    }

    set({ isSyncing: false, lastSync: Date.now() });
    get().saveQueue();
  },

  clearQueue: () => {
    set({ pendingActions: [] });
    storage.remove(STORAGE_KEYS.OFFLINE_QUEUE);
  },

  loadQueue: async () => {
    try {
      const saved = await storage.getJSON<{
        actions: OfflineAction[];
        lastSync: number | null;
      }>(STORAGE_KEYS.OFFLINE_QUEUE);

      if (saved) {
        set({
          pendingActions: saved.actions || [],
          lastSync: saved.lastSync,
        });
      }
    } catch (error) {
      console.error('Error loading offline queue:', error);
    }
  },

  saveQueue: async () => {
    try {
      const { pendingActions, lastSync } = get();
      await storage.set(STORAGE_KEYS.OFFLINE_QUEUE, {
        actions: pendingActions,
        lastSync,
      });
    } catch (error) {
      console.error('Error saving offline queue:', error);
    }
  },

  updateActionStatus: (id: string, status: OfflineAction['status'], errorMessage?: string) => {
    set((state) => ({
      pendingActions: state.pendingActions.map((a) =>
        a.id === id ? { ...a, status, errorMessage } : a
      ),
    }));
  },
}));

export default useOfflineStore;