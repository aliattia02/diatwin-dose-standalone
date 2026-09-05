/**
 * Login Screen
 * Location: mobile/app/(auth)/login.tsx
 */

import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Input, Card } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

type UserType = 'patient' | 'doctor';

// ─── Small wake-up progress bar shown while server cold-starts ────────────────
function WakeUpBanner({ message, percent }: { message: string; percent: number }) {
  return (
    <View style={wakeStyles.container}>
      <Text style={wakeStyles.message}>{message}</Text>
      <View style={wakeStyles.track}>
        <View style={[wakeStyles.fill, { width: `${percent}%` }]} />
      </View>
    </View>
  );
}

const wakeStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.primary + '15',
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  message: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
    marginBottom: 6,
    textAlign: 'center',
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function LoginScreen() {
  const router = useRouter();
  const {
    login,
    isLoading,
    isWakingUp,
    wakeProgress,
    error,
    clearError,
  } = useAuth();

  const [username,          setUsername]         = useState('');
  const [password,          setPassword]         = useState('');
  const [userType,          setUserType]         = useState<UserType>('patient');
  const [showPassword,      setShowPassword]     = useState(false);
  const [validationErrors,  setValidationErrors] = useState<Record<string, string>>({});
  const passwordRef = useRef<any>(null);

  const validateForm = () => {
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = 'Username is required';
    if (!password)        errors.password = 'Password is required';
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleLogin = async () => {
    if (!validateForm()) return;
    clearError();

    try {
      await login({ username: username.trim(), password, user_type: userType });
    } catch (err: any) {
      const isNetworkIssue =
        err?.code === 'ERR_NETWORK' ||
        err?.message?.includes('Network Error') ||
        err?.message?.includes('did not respond');

      Alert.alert(
        isNetworkIssue ? 'Server Starting Up' : 'Login Failed',
        isNetworkIssue
          ? 'The server is waking up. Please wait a moment and try again.'
          : error || err?.message || 'Please check your credentials and try again.'
      );
    }
  };

  const busy = isLoading || isWakingUp;

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo */}
          <View style={styles.logoSection}>
            <Text style={styles.logo}>DiaTwin</Text>
            <Text style={styles.subtitle}>Personalised insulin dosing support for Type 1 Diabetes</Text>
          </View>

          {/* Form */}
          <Card variant="elevated" padding="large" style={styles.card}>
            <Text style={styles.title}>Welcome Back</Text>
            <Text style={styles.description}>Sign in to continue managing your health</Text>

            {/* User type toggle */}
            <View style={styles.userTypeSection}>
              <Text style={styles.label}>I am a</Text>
              <View style={styles.userTypeButtons}>
                {(['patient', 'doctor'] as UserType[]).map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[styles.userTypeButton, userType === type && styles.userTypeButtonActive]}
                    onPress={() => setUserType(type)}
                    disabled={busy}
                  >
                    <Text style={[styles.userTypeText, userType === type && styles.userTypeTextActive]}>
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <Input
              label="Username"
              value={username}
              onChangeText={(text) => { setUsername(text); setValidationErrors((p) => ({ ...p, username: '' })); }}
              placeholder="Enter your username"
              autoCapitalize="none"
              autoCorrect={false}
              error={validationErrors.username}
              editable={!busy}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              blurOnSubmit={false}
            />

            <Input
              ref={passwordRef}
              label="Password"
              value={password}
              onChangeText={(text) => { setPassword(text); setValidationErrors((p) => ({ ...p, password: '' })); }}
              placeholder="Enter your password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              error={validationErrors.password}
              editable={!busy}
              returnKeyType="done"
              onSubmitEditing={handleLogin}
              rightIcon={<Text style={styles.showPasswordText}>{showPassword ? 'Hide' : 'Show'}</Text>}
              onRightIconPress={() => setShowPassword(!showPassword)}
            />

            {/* ── Cold-start progress banner ── */}
            {isWakingUp && (
              <WakeUpBanner
                message={wakeProgress.message}
                percent={wakeProgress.percent}
              />
            )}

            {/* Auth error (wrong credentials etc.) */}
            {error && !isWakingUp && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Button
              title={isWakingUp ? 'Starting server…' : 'Sign In'}
              onPress={handleLogin}
              loading={busy}
              fullWidth
              style={styles.loginButton}
            />

            <Link href="/(auth)/forgot-password" asChild>
              <TouchableOpacity style={styles.forgotPassword} disabled={busy}>
                <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
              </TouchableOpacity>
            </Link>
          </Card>

          {/* Register link */}
          <View style={styles.registerSection}>
            <Text style={styles.registerText}>Don't have an account? </Text>
            <Link href="/(auth)/register" asChild>
              <TouchableOpacity disabled={busy}>
                <Text style={styles.registerLink}>Create Account</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea:         { flex: 1, backgroundColor: colors.primary },
  keyboardView:     { flex: 1 },
  scrollContent:    { flexGrow: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.xl },
  logoSection:      { alignItems: 'center', marginBottom: spacing.xl, paddingTop: spacing.xl },
  logo:             { fontSize: 40, fontWeight: 'bold', color: colors.text.inverse, letterSpacing: 3 },
  subtitle:         { ...typography.body, color: colors.text.inverse, opacity: 0.8, marginTop: spacing.xs },
  card:             { marginBottom: spacing.lg },
  title:            { ...typography.h2, color: colors.text.primary, marginBottom: spacing.xs },
  description:      { ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg },
  userTypeSection:  { marginBottom: spacing.md },
  label:            { ...typography.caption, color: colors.text.primary, fontWeight: '500', marginBottom: spacing.xs },
  userTypeButtons:  { flexDirection: 'row', borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  userTypeButton:   { flex: 1, paddingVertical: spacing.sm, alignItems: 'center', backgroundColor: colors.surface },
  userTypeButtonActive: { backgroundColor: colors.primary },
  userTypeText:     { ...typography.body, color: colors.text.primary, fontWeight: '500' },
  userTypeTextActive:   { color: colors.text.inverse },
  showPasswordText: { ...typography.caption, color: colors.primary, fontWeight: '600' },
  errorContainer:   { backgroundColor: colors.danger + '10', borderRadius: borderRadius.md, padding: spacing.sm, marginBottom: spacing.md },
  errorText:        { ...typography.caption, color: colors.danger, textAlign: 'center' },
  loginButton:      { marginTop: spacing.sm },
  forgotPassword:   { alignItems: 'center', marginTop: spacing.md },
  forgotPasswordText: { ...typography.caption, color: colors.primary, fontWeight: '500' },
  registerSection:  { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  registerText:     { ...typography.body, color: colors.text.inverse },
  registerLink:     { ...typography.body, color: colors.text.inverse, fontWeight: 'bold', textDecorationLine: 'underline' },
});