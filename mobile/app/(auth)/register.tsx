/**
 * Registration Screen
 * Location: mobile/app/(auth)/register.tsx
 *
 * Main Function: RegisterScreen
 * Description: User registration screen with form validation and user type selection
 *
 * Features:
 * - User type selection (patient vs doctor)
 * - Multi-field registration form (username, email, password, names, DOB)
 * - Comprehensive form validation
 * - Password confirmation matching
 * - Show/hide password toggle
 * - Real-time validation error display
 * - Loading state during registration
 * - Keyboard handling for smooth UX
 * - Success alert with redirect to login
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Button, Input, Card } from '@/components/ui';

// Hooks
import { useAuth } from '@/hooks/useAuth';

// Utils
import {
  validateEmail,
  validatePassword,
  validateUsername,
  validateDateOfBirth,
  validateRequired
} from '@/utils/validation';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// Types
type UserType = 'patient' | 'doctor';

export default function RegisterScreen() {
  const router = useRouter();
  const { register, isLoading } = useAuth();

  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: '',
    dateOfBirth: '',
  });
  const [userType, setUserType] = useState<UserType>('patient');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Username
    const usernameResult = validateUsername(formData.username);
    if (!usernameResult.isValid) newErrors.username = usernameResult.error || '';

    // Email
    const emailResult = validateEmail(formData.email);
    if (!emailResult.isValid) newErrors.email = emailResult.error || '';

    // Password
    const passwordResult = validatePassword(formData.password);
    if (!passwordResult.isValid) newErrors.password = passwordResult.error || '';

    // Confirm password
    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    // First name
    const firstNameResult = validateRequired(formData.firstName, 'First name');
    if (!firstNameResult.isValid) newErrors.firstName = firstNameResult.error || '';

    // Last name
    const lastNameResult = validateRequired(formData.lastName, 'Last name');
    if (!lastNameResult.isValid) newErrors.lastName = lastNameResult.error || '';

    // Date of birth
    const dobResult = validateDateOfBirth(formData.dateOfBirth);
    if (!dobResult.isValid) newErrors.dateOfBirth = dobResult.error || '';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleRegister = async () => {
    if (!validateForm()) return;

    try {
      await register({
        username: formData.username.trim(),
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
        firstName: formData.firstName.trim(),
        lastName: formData.lastName.trim(),
        dateOfBirth: formData.dateOfBirth,
        user_type: userType,
      });

      Alert.alert(
        'Registration Successful',
        'Your account has been created. Please sign in.',
        [{ text: 'OK', onPress: () => router.replace('/(auth)/login') }]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed';
      Alert.alert('Registration Failed', message);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Card variant="elevated" padding="large" style={styles.card}>
            <Text style={styles.title}>Create Account</Text>
            <Text style={styles.description}>Join NATIVE to manage your diabetes effectively</Text>

            {/* User Type Selection */}
            <View style={styles.userTypeSection}>
              <Text style={styles.label}>I am a</Text>
              <View style={styles.userTypeButtons}>
                <TouchableOpacity
                  style={[
                    styles.userTypeButton,
                    userType === 'patient' && styles.userTypeButtonActive,
                  ]}
                  onPress={() => setUserType('patient')}
                >
                  <Text
                    style={[
                      styles.userTypeText,
                      userType === 'patient' && styles.userTypeTextActive,
                    ]}
                  >
                    Patient
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.userTypeButton,
                    userType === 'doctor' && styles.userTypeButtonActive,
                  ]}
                  onPress={() => setUserType('doctor')}
                >
                  <Text
                    style={[
                      styles.userTypeText,
                      userType === 'doctor' && styles.userTypeTextActive,
                    ]}
                  >
                    Doctor
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.row}>
              <View style={styles.halfInput}>
                <Input
                  label="First Name"
                  value={formData.firstName}
                  onChangeText={(v) => updateField('firstName', v)}
                  placeholder="John"
                  autoCapitalize="words"
                  error={errors.firstName}
                  required
                />
              </View>
              <View style={styles.halfInput}>
                <Input
                  label="Last Name"
                  value={formData.lastName}
                  onChangeText={(v) => updateField('lastName', v)}
                  placeholder="Doe"
                  autoCapitalize="words"
                  error={errors.lastName}
                  required
                />
              </View>
            </View>

            <Input
              label="Username"
              value={formData.username}
              onChangeText={(v) => updateField('username', v)}
              placeholder="johndoe"
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.username}
              required
            />

            <Input
              label="Email"
              value={formData.email}
              onChangeText={(v) => updateField('email', v)}
              placeholder="john@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.email}
              required
            />

            <Input
              label="Date of Birth"
              value={formData.dateOfBirth}
              onChangeText={(v) => updateField('dateOfBirth', v)}
              placeholder="YYYY-MM-DD"
              error={errors.dateOfBirth}
              helperText="Format: YYYY-MM-DD"
              required
            />

            <Input
              label="Password"
              value={formData.password}
              onChangeText={(v) => updateField('password', v)}
              placeholder="Create a password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              error={errors.password}
              helperText="At least 8 characters with letters and numbers"
              required
              rightIcon={
                <Text style={styles.showPasswordText}>
                  {showPassword ? 'Hide' : 'Show'}
                </Text>
              }
              onRightIconPress={() => setShowPassword(!showPassword)}
            />

            <Input
              label="Confirm Password"
              value={formData.confirmPassword}
              onChangeText={(v) => updateField('confirmPassword', v)}
              placeholder="Confirm your password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              error={errors.confirmPassword}
              required
            />

            <Button
              title="Create Account"
              onPress={handleRegister}
              loading={isLoading}
              fullWidth
              style={styles.registerButton}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: {
    flex: 1,
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
  userTypeSection: {
    marginBottom: spacing.md,
  },
  label: {
    ...typography.caption,
    color: colors.text.primary,
    fontWeight: '500',
    marginBottom: spacing.xs,
  },
  userTypeButtons: {
    flexDirection: 'row',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  userTypeButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  userTypeButtonActive: {
    backgroundColor: colors.primary,
  },
  userTypeText: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '500',
  },
  userTypeTextActive: {
    color: colors.text.inverse,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  halfInput: {
    flex: 1,
  },
  showPasswordText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  registerButton: {
    marginTop: spacing.md,
  },
});