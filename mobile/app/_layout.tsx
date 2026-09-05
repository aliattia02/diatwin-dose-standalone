/**
 * Root App Layout
 * Location: mobile/app/_layout.tsx
 *
 * Main Function: RootLayout
 * Description: Root layout for the entire mobile app handling authentication state,
 *              navigation initialization, and app-wide providers
 *
 * Features:
 * - Authentication state management on startup
 * - Offline queue initialization
 * - SafeAreaProvider for safe area handling
 * - Stack navigation configuration
 * - Loading screen during auth check
 * - Root navigation structure (index, auth, app, not-found)
 */

import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Components
import { FullScreenLoading } from '@/components/ui';

// Store
import { useAuthStore } from '@/store/auth.store';
import { useOfflineStore } from '@/store/offline.store';

// Constants
import { colors } from '@/constants/theme';

export default function RootLayout() {
  const { isLoading, checkAuth } = useAuthStore();
  const { loadQueue } = useOfflineStore();

  // Check authentication status on app start
  useEffect(() => {
    checkAuth();
    loadQueue();
  }, []);

  // Show loading screen while checking auth
  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <FullScreenLoading text="Loading..." />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: colors.primary,
          },
          headerTintColor: colors.text.inverse,
          headerTitleStyle: {
            fontWeight: '600',
          },
          headerBackTitle: 'Back',
          contentStyle: {
            backgroundColor: colors.background,
          },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="(auth)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="(app)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="+not-found"
          options={{
            title: 'Not Found',
          }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
});