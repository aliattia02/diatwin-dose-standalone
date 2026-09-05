/**
 * 404 Not Found Screen
 * Location: mobile/app/+not-found.tsx
 *
 * Main Function: NotFoundScreen
 * Description: Error screen displayed when user navigates to a non-existent route
 *
 * Features:
 * - 404 error display
 * - User-friendly error message
 * - Navigation back to home
 * - Centered layout design
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Link } from 'expo-router';

// Components
import { Button } from '@/components/ui';

// Constants
import { colors, spacing, typography } from '@/constants/theme';

export default function NotFoundScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>404</Text>
      <Text style={styles.message}>Page not found</Text>
      <Text style={styles.description}>
        The page you're looking for doesn't exist or has been moved.
      </Text>
      <Link href="/" asChild>
        <Button title="Go Home" variant="primary" style={styles.button} />
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  title: {
    fontSize: 72,
    fontWeight: 'bold',
    color: colors.primary,
  },
  message: {
    ...typography.h2,
    color: colors.text.primary,
    marginTop: spacing.md,
  },
  description: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  button: {
    minWidth: 150,
  },
});