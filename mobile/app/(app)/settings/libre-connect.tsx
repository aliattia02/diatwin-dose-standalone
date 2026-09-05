/**
 * LibreLinkUp Connect Screen
 * Location: mobile/app/(app)/settings/libre-connect.tsx
 *
 * Allows the user to enter their LibreLinkUp account credentials and
 * choose a regional server, then calls POST /api/libre/connect.
 *
 * After a successful connection the screen navigates back to the
 * Libre history screen (/(app)/settings/libre).
 *
 * Important: LibreLinkUp is a *follower* / *sharing* account, NOT the
 * same login as the Abbott LibreView patient account.  Users must have
 * set up a sharing connection inside the official LibreLinkUp app first.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { useLibreConnect } from '@/hooks/useLibre';
import { LIBRE_REGION_OPTIONS, type LibreRegion } from '@/types/libre.types';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** Simple labelled text-input */
function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  autoCapitalize = 'none',
  keyboardType = 'default',
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'email-address';
  editable?: boolean;
}) {
  return (
    <View style={field.wrap}>
      <Text style={field.label}>{label}</Text>
      <TextInput
        style={[field.input, !editable && field.inputDisabled]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text?.secondary ?? '#94a3b8'}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        autoCorrect={false}
        editable={editable}
      />
    </View>
  );
}

const field = StyleSheet.create({
  wrap:  { marginBottom: spacing.md ?? 16 },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: colors.card ?? '#1a1d27',
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text?.primary ?? '#f1f5f9',
  },
  inputDisabled: {
    opacity: 0.5,
  },
});

/** Region selector row */
function RegionPicker({
  selected,
  onChange,
}: {
  selected: LibreRegion;
  onChange: (r: LibreRegion) => void;
}) {
  return (
    <View style={rp.wrap}>
      <Text style={rp.label}>Server Region</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={rp.scroll}>
        {LIBRE_REGION_OPTIONS.map((opt) => {
          const active = opt.value === selected;
          return (
            <Pressable
              key={opt.value}
              style={[rp.chip, active && rp.chipActive]}
              onPress={() => onChange(opt.value)}
            >
              <Text style={[rp.chipText, active && rp.chipTextActive]}>
                {opt.value}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Text style={rp.hint}>
        {LIBRE_REGION_OPTIONS.find((o) => o.value === selected)?.label ?? ''}
      </Text>
    </View>
  );
}

const rp = StyleSheet.create({
  wrap:   { marginBottom: spacing.md ?? 16 },
  label:  {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  scroll: { flexGrow: 0, marginBottom: 6 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    marginRight: 8,
    backgroundColor: colors.card ?? '#1a1d27',
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
  },
  chipActive: {
    backgroundColor: (colors.primary ?? '#6366f1') + '22',
    borderColor: colors.primary ?? '#6366f1',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
  },
  chipTextActive: {
    color: colors.primary ?? '#6366f1',
  },
  hint: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    marginTop: 2,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function LibreConnectScreen() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [region,   setRegion]   = useState<LibreRegion>('EU');
  const [showPass, setShowPass] = useState(false);

  const { connect, isConnecting, connectError } = useLibreConnect();

  const handleConnect = async () => {
    const trimEmail = email.trim().toLowerCase();
    if (!trimEmail) {
      Alert.alert('Missing email', 'Please enter your LibreLinkUp email address.');
      return;
    }
    if (!password) {
      Alert.alert('Missing password', 'Please enter your LibreLinkUp password.');
      return;
    }

    const result = await connect({ email: trimEmail, password, region });

    if (result) {
      // Success — go back to the history screen (which will now show connected state)
      Alert.alert(
        'Connected! 🎉',
        `Linked to ${result.status?.first_name ?? 'your'} LibreLinkUp account.\n` +
        `${result.sync_result?.new_count ?? 0} reading(s) synced.`,
        [
          {
            text: 'View Readings',
            onPress: () => router.replace('/(app)/settings/libre' as any),
          },
        ]
      );
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >

        {/* ── Explainer card ─────────────────────────────────────────── */}
        <View style={styles.infoCard}>
          <Text style={styles.infoIcon}>ℹ️</Text>
          <View style={styles.infoBody}>
            <Text style={styles.infoTitle}>How it works</Text>
            <Text style={styles.infoText}>
              DiaTwin connects to <Text style={styles.infoBold}>LibreLinkUp</Text> — Abbott's
              sharing platform — using your <Text style={styles.infoBold}>LibreLinkUp follower
              account</Text> (not your LibreView patient account).
            </Text>
            <Text style={[styles.infoText, { marginTop: 6 }]}>
              Make sure you have set up a sharing connection in the official
              LibreLinkUp app first.
            </Text>
          </View>
        </View>

        {/* ── Form ───────────────────────────────────────────────────── */}
        <View style={styles.form}>
          <Field
            label="LibreLinkUp Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            editable={!isConnecting}
          />

          {/* Password field with show/hide toggle */}
          <View style={field.wrap}>
            <Text style={field.label}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                style={[field.input, styles.passwordInput]}
                value={password}
                onChangeText={setPassword}
                placeholder="LibreLinkUp password"
                placeholderTextColor={colors.text?.secondary ?? '#94a3b8'}
                secureTextEntry={!showPass}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isConnecting}
              />
              <Pressable
                style={styles.showHideBtn}
                onPress={() => setShowPass((v) => !v)}
              >
                <Text style={styles.showHideText}>{showPass ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
          </View>

          <RegionPicker selected={region} onChange={setRegion} />

          {/* Error banner */}
          {connectError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>⚠ {connectError}</Text>
            </View>
          )}

          {/* Connect button */}
          <TouchableOpacity
            style={[styles.connectBtn, isConnecting && styles.connectBtnDisabled]}
            onPress={handleConnect}
            disabled={isConnecting}
            activeOpacity={0.8}
          >
            {isConnecting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.connectBtnText}>Connect LibreLinkUp</Text>
            )}
          </TouchableOpacity>

          {/* Cancel */}
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => router.back()}
            disabled={isConnecting}
            activeOpacity={0.7}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>

        {/* ── Privacy note ───────────────────────────────────────────── */}
        <Text style={styles.privacyNote}>
          🔒 Your credentials are encrypted and stored securely on the DiaTwin
          server. They are never shared with third parties.
        </Text>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md ?? 16,
    paddingBottom: 40,
  },

  // ── Info card ──────────────────────────────────────────────────────────
  infoCard: {
    flexDirection: 'row',
    backgroundColor: (colors.primary ?? '#6366f1') + '12',
    borderWidth: 1,
    borderColor: (colors.primary ?? '#6366f1') + '30',
    borderRadius: 12,
    padding: 14,
    marginBottom: spacing.lg ?? 24,
    gap: 10,
  },
  infoIcon: { fontSize: 20, marginTop: 1 },
  infoBody: { flex: 1 },
  infoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 4,
  },
  infoText: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 18,
  },
  infoBold: {
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
  },

  // ── Form ───────────────────────────────────────────────────────────────
  form: {
    backgroundColor: colors.card ?? '#1a1d27',
    borderRadius: 14,
    padding: spacing.md ?? 16,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    marginBottom: spacing.md ?? 16,
  },

  // ── Password row ───────────────────────────────────────────────────────
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  passwordInput: {
    flex: 1,
  },
  showHideBtn: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
  },
  showHideText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary ?? '#6366f1',
  },

  // ── Error banner ───────────────────────────────────────────────────────
  errorBanner: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 10,
    padding: 12,
    marginBottom: spacing.md ?? 16,
  },
  errorText: {
    fontSize: 13,
    color: '#ef4444',
    lineHeight: 18,
  },

  // ── Buttons ────────────────────────────────────────────────────────────
  connectBtn: {
    backgroundColor: colors.primary ?? '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  connectBtnDisabled: {
    opacity: 0.5,
  },
  connectBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  cancelBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    color: colors.text?.secondary ?? '#94a3b8',
  },

  // ── Privacy note ───────────────────────────────────────────────────────
  privacyNote: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#64748b',
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 8,
  },
});
