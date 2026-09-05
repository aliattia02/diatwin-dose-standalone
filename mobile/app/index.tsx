/**
 * App Entry Point
 * Location: mobile/app/index.tsx
 *
 * Main Function: Index
 * Description: Initial route that handles app initialization and redirects to appropriate screen
 *
 * Features:
 * - App initialization delay
 * - Loading indicator during startup
 * - Automatic redirect to login screen
 * - Branded loading message
 */

import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { Redirect } from 'expo-router';

// Constants
import { colors } from '@/constants/theme';

export default function Index() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Simple timeout to let the app initialize
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 500);

    return () => clearTimeout(timer);
  }, []);

  // Once ready, redirect to login (we'll add proper auth check later)
  if (isReady) {
    return <Redirect href="/(auth)/login" />;
  }

  // Show loading while initializing
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.text}>Loading NATIVE... </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  text: {
    marginTop: 16,
    fontSize: 16,
    color: colors.text.secondary,
  },
});