/**
 * Storage Utilities
 * Location: mobile/utils/storage.ts
 *
 * Description: Platform-agnostic storage utilities with secure and regular storage
 *
 * Features:
 * - Secure storage for sensitive data (tokens, credentials)
 * - Regular storage for non-sensitive data
 * - Platform detection (web vs native)
 * - JSON serialization/deserialization
 * - Multi-remove and clear operations
 * - Predefined storage keys
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Secure storage methods for sensitive data (tokens, credentials)
 * Uses SecureStore on native, localStorage on web
 */
export const secureStorage = {
  async set(key: string, value: string | object): Promise<void> {
    try {
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
      if (Platform.OS === 'web') {
        localStorage.setItem(key, stringValue);
      } else {
        await SecureStore.setItemAsync(key, stringValue);
      }
    } catch (error) {
      console.error(`SecureStore set error for key "${key}":`, error);
    }
  },

  async get(key: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') {
        return localStorage.getItem(key);
      } else {
        return await SecureStore.getItemAsync(key);
      }
    } catch (error) {
      console.error(`SecureStore get error for key "${key}":`, error);
      return null;
    }
  },

  async getJSON<T>(key: string): Promise<T | null> {
    try {
      let value: string | null;
      if (Platform.OS === 'web') {
        value = localStorage.getItem(key);
      } else {
        value = await SecureStore.getItemAsync(key);
      }
      if (value) {
        return JSON.parse(value) as T;
      }
      return null;
    } catch (error) {
      console.error(`SecureStore getJSON error for key "${key}":`, error);
      return null;
    }
  },

  async remove(key: string): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        localStorage.removeItem(key);
      } else {
        await SecureStore.deleteItemAsync(key);
      }
    } catch (error) {
      console.error(`SecureStore remove error for key "${key}":`, error);
    }
  },
};

/**
 * Regular storage methods for non-sensitive data
 */
export const storage = {
  async set(key: string, value: string | object): Promise<void> {
    try {
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
      if (Platform.OS === 'web') {
        localStorage.setItem(key, stringValue);
      } else {
        await AsyncStorage.setItem(key, stringValue);
      }
    } catch (error) {
      console.error(`AsyncStorage set error for key "${key}":`, error);
    }
  },

  async get(key: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') {
        return localStorage.getItem(key);
      } else {
        return await AsyncStorage.getItem(key);
      }
    } catch (error) {
      console.error(`AsyncStorage get error for key "${key}":`, error);
      return null;
    }
  },

  async getJSON<T>(key: string): Promise<T | null> {
    try {
      let value: string | null;
      if (Platform.OS === 'web') {
        value = localStorage.getItem(key);
      } else {
        value = await AsyncStorage.getItem(key);
      }
      if (value) {
        return JSON.parse(value) as T;
      }
      return null;
    } catch (error) {
      console.error(`AsyncStorage getJSON error for key "${key}":`, error);
      return null;
    }
  },

  async remove(key: string): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        localStorage.removeItem(key);
      } else {
        await AsyncStorage.removeItem(key);
      }
    } catch (error) {
      console.error(`AsyncStorage remove error for key "${key}":`, error);
    }
  },

  async multiRemove(keys: string[]): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        keys.forEach(key => localStorage.removeItem(key));
      } else {
        await AsyncStorage.multiRemove(keys);
      }
    } catch (error) {
      console.error('AsyncStorage multiRemove error:', error);
    }
  },

  async clear(): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        localStorage.clear();
      } else {
        await AsyncStorage.clear();
      }
    } catch (error) {
      console.error('AsyncStorage clear error:', error);
    }
  },
};

/**
 * Predefined storage keys for consistency
 */
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  REFRESH_TOKEN: 'refresh_token',
  USER_DATA: 'user_data',
  SHARED_CONSTANTS: 'shared_constants',
  PATIENT_CONSTANTS: 'patient_constants',
  OFFLINE_QUEUE: 'offline_queue',
  LAST_SYNC: 'last_sync',
  PREFERENCES: 'preferences',
  CACHED_MEALS: 'cached_meals',
  CACHED_GLUCOSE: 'cached_glucose',
} as const;

export default {
  secureStorage,
  storage,
  STORAGE_KEYS,
};