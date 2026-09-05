/**
 * Tab Navigator Layout
 * Location: mobile/app/(app)/(tabs)/_layout.tsx
 *
 * Main Function: TabsLayout
 * Description: Configures the bottom tab navigation with role-based visibility
 *
 * Features:
 * - Patient tabs: Home, Log, History, Profile
 * - Doctor tabs: Patients, Profile
 * - Visualization screen hidden from tab bar (accessible via Profile)
 * - Custom icons and styling
 * - Dynamic tab visibility based on user role
 */


import React from 'react';
import { Tabs } from 'expo-router';
import { Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, typography } from '@/constants/theme';
import { useAuthStore } from '@/store/auth.store';

function TabBarIcon({ name, color }: { name: string; color: string }) {
  const icons: Record<string, string> = {
    home: '🏠',
    log: '➕',
    history: '📊',
    profile: '👤',
    patients: '👥',
    doctor: '👨‍⚕️',
  };
  return <Text style={[styles.icon, { color }]}>{icons[name] || '•'}</Text>;
}

export default function TabsLayout() {
  const { user } = useAuthStore();
  const isDoctor = user?.user_type === 'doctor';
  const insets = useSafeAreaInsets();

  // Use the inset directly if present (home indicator devices),
  // otherwise fall back to a small fixed padding (hardware button devices).
  const bottomInset = insets.bottom > 0 ? insets.bottom : 8;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.text.secondary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          paddingBottom: bottomInset,
          paddingTop: 4,
          height: 52 + bottomInset,
        },
        tabBarLabelStyle: {
          ...typography.small,
          fontWeight: '500',
        },
        headerStyle: {
          backgroundColor: colors.primary,
        },
        headerTintColor: colors.text.inverse,
        headerTitleStyle: {
          fontWeight: '600',
        },
      }}
    >
      {/* Patient Dashboard - visible only to patients */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
          href: isDoctor ? null : '/(app)/(tabs)/',
        }}
      />

      {/* Doctor Dashboard - visible only to doctors */}
      <Tabs.Screen
        name="doctor-dashboard"
        options={{
          title: 'Doctor Dashboard',
          tabBarLabel: 'Patients',
          tabBarIcon: ({ color }) => <TabBarIcon name="patients" color={color} />,
          href: isDoctor ? '/(app)/(tabs)/doctor-dashboard' : null,
        }}
      />

      {/* Log - visible only to patients */}
      <Tabs.Screen
        name="log"
        options={{
          title: 'Quick Log',
          tabBarLabel: 'Log',
          tabBarIcon: ({ color }) => <TabBarIcon name="log" color={color} />,
          href: isDoctor ? null : '/(app)/(tabs)/log',
        }}
      />

      {/* History - visible only to patients */}
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarLabel: 'History',
          tabBarIcon: ({ color }) => <TabBarIcon name="history" color={color} />,
          href: isDoctor ? null : '/(app)/(tabs)/history',
        }}
      />

      {/* Visualization - HIDDEN FROM TAB BAR */}
      <Tabs.Screen
        name="visualization"
        options={{
          href: null,
          title: 'Charts',
          headerShown: true,
        }}
      />

      {/* Profile - visible to all users */}
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: 'Profile',
          tabBarIcon: ({ color }) => <TabBarIcon name="profile" color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: {
    fontSize: 24,
  },
});