/**
 * Settings Stack Layout
 * Location: mobile/app/(app)/settings/_layout.tsx
 *
 * Main Function: SettingsLayout
 * Description: Navigation stack configuration for settings screens.
 *              Includes libre (CGM history) and libre-connect (connect form).
 */

import React from 'react';
import { Stack } from 'expo-router';
import { colors } from '@/constants/theme';

export default function SettingsLayout() {
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
        name="constants"
        options={{ title: 'Patient Constants' }}
      />
      <Stack.Screen
        name="medications"
        options={{ title: 'Medications' }}
      />
      <Stack.Screen
        name="doctors"
        options={{ title: 'Manage Doctors' }}
      />
      <Stack.Screen
        name="export"
        options={{ title: 'Export Data' }}
      />
      <Stack.Screen
        name="libre"
        options={{ title: 'FreeStyle Libre CGM' }}
      />
      {/* ── LibreLinkUp connect form ───────────────────────────────────── */}
      <Stack.Screen
        name="libre-connect"
        options={{ title: 'Connect LibreLinkUp' }}
      />
      {/* ── Food Database ─────────────────────────────────────────────── */}
      <Stack.Screen
        name="food-database"
        options={{ title: 'Food Database' }}
      />
      {/* ── FHIR R4 Export + GDPR Erasure ─────────────────────────────── */}
      <Stack.Screen
        name="fhir-export"
        options={{ title: 'Data Export & Privacy', headerBackTitle: 'Settings' }}
      />
    </Stack>
  );
}