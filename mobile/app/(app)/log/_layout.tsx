/**
 * Log Stack Layout
 * Location: mobile/app/(app)/log/_layout.tsx
 *
 * Main Function: LogLayout
 * Description: Navigation stack configuration for logging screens (meal, glucose, insulin, activity)
 *
 * Features:
 * - Modal presentation for all log screens
 * - Consistent header styling
 * - Back navigation support
 */

import React from 'react';
import { Stack } from 'expo-router';

// Constants
import { colors } from '@/constants/theme';

export default function LogLayout() {
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
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen
        name="meal"
        options={{
          title: 'Log Meal',
          presentation: 'modal',
        }}
      />
      <Stack.Screen
        name="glucose"
        options={{
          title: 'Log Blood Sugar',
          presentation: 'modal',
        }}
      />
      <Stack.Screen
        name="insulin"
        options={{
          title: 'Log Insulin',
          presentation: 'modal',
        }}
      />
      <Stack.Screen
        name="activity"
        options={{
          title: 'Log Activity',
          presentation: 'modal',
        }}
      />
    </Stack>
  );
}