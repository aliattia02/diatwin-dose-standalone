/**
 * Forgot Password Screen
 * Location: mobile/app/(auth)/forgot-password.tsx
 *
 * Main Function: ForgotPasswordScreen
 * Description: Password reset request screen with email validation and success confirmation
 *
 * Features:
 * - Email input with validation
 * - Password reset email trigger
 * - Success confirmation screen
 * - Email validation
 * - Loading state during API call
 * - Back to login navigation
 * - User-friendly instructions
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Button, Input, Card } from '@/components/ui';

// Utils
import { validateEmail } from '@/utils/validation';

// Constants
import { colors, spacing, typography } from '@/constants/theme';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async () => {
    const validation = validateEmail(email);
    if (!validation.isValid) {
      setError(validation.error || 'Invalid email');
      return;
    }

    setError('');
    setIsLoading(true);

    try {
      // TODO: Implement password reset API call
      // For now, we'll just show a success message
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Simulate API call
      setIsSubmitted(true);
    } catch (err) {
      Alert.alert('Error', 'Failed to send reset email. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (isSubmitted) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Card variant="elevated" padding="large" style={styles.card}>
            <View style={styles.successContainer}>
              <Text style={styles.successIcon}>✓</Text>
              <Text style={styles.successTitle}>Check Your Email</Text>
              <Text style={styles.successDescription}>
                We've sent password reset instructions to {email}
              </Text>
              <Text style={styles.successNote}>
                If you don't see the email, check your spam folder.
              </Text>
              <Button
                title="Back to Sign In"
                onPress={() => router.replace('/(auth)/login')}
                fullWidth
                style={styles.backButton}
              />
            </View>
          </Card>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Card variant="elevated" padding="large" style={styles.card}>
          <Text style={styles.title}>Reset Password</Text>
          <Text style={styles.description}>
            Enter your email address and we'll send you instructions to reset your password.
          </Text>

          <Input
            label="Email Address"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setError('');
            }}
            placeholder="Enter your email"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            error={error}
          />

          <Button
            title="Send Reset Instructions"
            onPress={handleSubmit}
            loading={isLoading}
            fullWidth
            style={styles.submitButton}
          />

          <Button
            title="Back to Sign In"
            variant="ghost"
            onPress={() => router.back()}
            fullWidth
          />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.lg,
  },
  card: {
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  description: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.lg,
  },
  submitButton: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  successContainer: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  successIcon: {
    fontSize: 64,
    color: colors.success,
    marginBottom: spacing.md,
  },
  successTitle: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  successDescription: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  successNote: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  backButton: {
    marginTop: spacing.md,
  },
});