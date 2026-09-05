/**
 * Auth Stack Layout
 * Location: mobile/app/(auth)/_layout.tsx
 *
 * Main Function: AuthLayout
 * Description: Navigation stack configuration for authentication screens (login, register, forgot password)
 *
 * Features:
 * - Stack navigation for auth flow
 * - Consistent header styling
 * - Surface background with primary tint
 * - Screen definitions for login, register, and password reset
 */

import React from 'react';
import { Stack } from 'expo-router';

// Constants
import { colors } from '@/constants/theme';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.surface,
        },
        headerTintColor: colors.primary,
        headerTitleStyle: {
          fontWeight: '600',
        },
        contentStyle: {
          backgroundColor: colors.background,
        },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen
        name="login"
        options={{
          title: 'Sign In',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="register"
        options={{
          title: 'Create Account',
          headerBackTitle: 'Back',
        }}
      />
      <Stack.Screen
        name="forgot-password"
        options={{
          title: 'Reset Password',
          headerBackTitle: 'Back',
        }}
      />
    </Stack>
  );
}