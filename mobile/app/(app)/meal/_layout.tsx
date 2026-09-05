/**
 * Meal Stack Layout
 * Location: mobile/app/(app)/meal/_layout.tsx
 *
 * Main Function: MealLayout
 * Description: Navigation stack configuration for meal-related screens (detail views, history)
 *
 * Features:
 * - Consistent header styling for meal screens
 * - Navigation configuration for meal stack
 * - Primary color header with inverse text
 */

import React from 'react';
import { Stack } from 'expo-router';

// Constants
import { colors } from '@/constants/theme';

export default function MealLayout() {
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
    />
  );
}