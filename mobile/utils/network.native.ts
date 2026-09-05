/**
 * Network Utilities (React Native)
 * Location: mobile/utils/network.native.ts
 *
 * Description: Native platform network connectivity using @react-native-community/netinfo
 *
 * Features:
 * - Real-time network state detection
 * - Internet reachability checking
 * - Connection type detection (wifi, cellular, etc.)
 * - Network change event listeners
 * - isOnline and onNetworkChange helpers
 */

import NetInfo from '@react-native-community/netinfo';
import type { NetworkState, NetworkStateListener, NetworkModule } from './network';

export const Network: NetworkModule = {
  fetch: async (): Promise<NetworkState> => {
    const state = await NetInfo.fetch();
    return {
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
      type: state.type,
    };
  },

  addEventListener: (listener: NetworkStateListener): (() => void) => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      listener({
        isConnected: state.isConnected,
        isInternetReachable: state.isInternetReachable,
        type: state.type,
      });
    });
    return unsubscribe;
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