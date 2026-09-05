/**
 * Authentication store using Zustand
 * Self-contained with all API calls inline
 */

import { create } from 'zustand';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import apiClient from '../services/api/client';

// Storage helper that works on both web and native
const storage = {
  async get(key: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') {
        return localStorage.getItem(key);
      }
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      console.error(`Storage get error for "${key}":`, error);
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        localStorage.setItem(key, value);
      } else {
        await SecureStore.setItemAsync(key, value);
      }
    } catch (error) {
      console.error(`Storage set error for "${key}":`, error);
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
      console.error(`Storage remove error for "${key}":`, error);
    }
  },
};


interface LoginCredentials {
  username: string;
  password: string;
  user_type: string;
}

interface UserData {
  token: string;
  userType: string;
  firstName: string;
  lastName: string;
}

interface AuthState {
  user: UserData | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });

    console.log('Attempting login with:', JSON.stringify(credentials));

    try {
      const response = await apiClient.post('/login', credentials);

      console.log('Login response:', JSON.stringify(response.data));

      const userData: UserData = {
        token: response.data.token,
        userType: response.data.user_type,
        firstName: response.data.firstName || '',
        lastName: response.data.lastName || '',
      };

      // Store token
      await storage.set('auth_token', userData.token);
      await storage.set('user_data', JSON.stringify(userData));

      set({
        user: userData,
        token: userData.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });

      console.log('Login successful! ');
    } catch (error: any) {
      console.error('Login error:', error.response?. data || error.message);
      const errorMessage = error.response?.data?.error || error.message || 'Login failed';
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }
  },

  logout: async () => {
    set({ isLoading: true });
    try {
      await storage.remove('auth_token');
      await storage.remove('user_data');
    } catch (error) {
      console.error('Logout error:', error);
    }
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const token = await storage.get('auth_token');
      const userDataStr = await storage.get('user_data');

      console.log('Checking auth - token exists:', !!token);

      if (token && userDataStr) {
        const userData = JSON.parse(userDataStr) as UserData;
        set({
          user: userData,
          token: token,
          isAuthenticated: true,
          isLoading: false,
        });
      } else {
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          isLoading: false,
        });
      }
    } catch (error) {
      console. error('Error checking auth:', error);
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));

export default useAuthStore;