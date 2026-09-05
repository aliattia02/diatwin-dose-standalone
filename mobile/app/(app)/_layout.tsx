/**
 * Main App Stack Layout
 * Location: mobile/app/(app)/_layout.tsx
 *
 * Main Function: AppLayout
 * Description: Root navigation stack for authenticated app screens including tabs, log, meal, and settings
 *
 * Features:
 * - Root stack navigator configuration
 * - Screen definitions for main app sections
 * - Consistent header styling across app
 * - Background color configuration
 */

import React from 'react';
import { Stack } from 'expo-router';

// Constants
import { colors } from '@/constants/theme';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.primary,
        },
        headerTintColor: colors.text.inverse,
        headerTitleStyle: {
          fontWeight: '600',
        },
        contentStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="log"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="meal"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          headerShown: false,
        }}
      />
    </Stack>
  );
}