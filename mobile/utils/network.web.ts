/**
 * Network Utilities (Web)
 * Location: mobile/utils/network.web.ts
 * 
 * Description: Web platform network connectivity using browser APIs
 * 
 * Features:
 * - Browser online/offline event detection
 * - Navigator.onLine state checking
 * - Network Information API for connection type
 * - Window event listeners for online/offline
 * - isOnline and onNetworkChange helpers
 */

import type { NetworkState, NetworkStateListener, NetworkModule } from './network';

/**
 * Helper to detect connection type using Network Information API when available
 */
const getConnectionType = (): string => {
  if (typeof navigator !== 'undefined' && 'connection' in navigator) {
    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
    if (connection?.effectiveType) {
      return connection.effectiveType;
    }
  }
  return 'unknown';
};

export const Network: NetworkModule = {
  fetch: async (): Promise<NetworkState> => {
    if (typeof window !== 'undefined') {
      return {
        isConnected: navigator.onLine,
        isInternetReachable: navigator.onLine,
        type: navigator.onLine ? getConnectionType() : 'none',
      };
    }
    return { isConnected: true, isInternetReachable: true, type: 'unknown' };
  },

  addEventListener: (listener: NetworkStateListener): (() => void) => {
    if (typeof window === 'undefined') {
      return () => {};
    }

    const handleOnline = () => {
      listener({ isConnected: true, isInternetReachable: true, type: getConnectionType() });
    };

    const handleOffline = () => {
      listener({ isConnected: false, isInternetReachable: false, type: 'none' });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  },
};

/**
 * Check if device is currently online
 */
export const isOnline = async (): Promise<boolean> => {
  const state = await Network.fetch();
  return state.isConnected ?? false;
};

/**
 * Listen for network connectivity changes
 */
export const onNetworkChange = (callback: (isConnected: boolean) => void): (() => void) => {
  return Network.addEventListener((state) => {
    callback(state.isConnected ?? false);
  });
};

export default Network;