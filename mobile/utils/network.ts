/**
 * Network Utilities (Base/Fallback)
 * Location: mobile/utils/network.ts
 * 
 * Description: Base network module with type definitions and fallback implementation
 * 
 * Features:
 * - Network state type definitions
 * - Network state listener types
 * - Default fallback implementation for unknown platforms
 * - isOnline and onNetworkChange helper functions
 * 
 * Note: Platform-specific implementations in network.native.ts and network.web.ts
 */

export interface NetworkState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type: string;
}

export type NetworkStateListener = (state: NetworkState) => void;

export interface NetworkModule {
  fetch: () => Promise<NetworkState>;
  addEventListener: (listener: NetworkStateListener) => () => void;
}

/**
 * Default fallback implementation
 * Assumes online with unknown connection type
 */
export const Network: NetworkModule = {
  fetch: async () => ({ 
    isConnected: true, 
    isInternetReachable: true, 
    type: 'unknown' 
  }),
  addEventListener: () => () => {},
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