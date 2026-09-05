// mobile/app/(app)/settings/fhir-export.tsx
// FHIR R4 Export + GDPR Delete screen
// Add to settings navigation stack

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Alert, ActivityIndicator, Platform,
} from 'react-native';
// Use legacy import path to avoid deprecated writeAsStringAsync warning
// while keeping the stable, well-tested API (expo-file-system/next is still unstable)
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/auth.store';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? '';

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ─── Clinical terminology reference ──────────────────────────────────────────
const INCLUDED_RESOURCES = [
  { icon: '🩸', label: 'Blood glucose',      detail: 'All readings within the selected window (LOINC 15074-8)' },
  { icon: '💉', label: 'Insulin doses',       detail: 'Subcutaneous administrations (SNOMED 67866001)' },
  { icon: '🍽️', label: 'Meals',              detail: 'Carbohydrate, protein and fat intake (LOINC 9059-7)' },
  { icon: '🏃', label: 'Activity sessions',   detail: 'Completed sessions with intensity and duration (LOINC 55423-8)' },
  { icon: '❤️', label: 'Heart rate',          detail: 'Mean and peak HR per session from wearable trace (LOINC 8867-4)' },
] as const;

const TERMINOLOGY = [
  {
    system:      'LOINC',
    code:        '15074-8',
    description: 'Blood glucose (mmol/L)',
  },
  {
    system:      'SNOMED',
    code:        '67866001',
    description: 'Diabetes mellitus (diagnosis)',
  },
  {
    system:      'LOINC',
    code:        '9059-7',
    description: 'Insulin dose — subcutaneous (units)',
  },
  {
    system:      'LOINC',
    code:        '8867-4',
    description: 'Heart rate (beats/min)',
  },
  {
    system:      'LOINC',
    code:        '55423-8',
    description: 'Physical activity — step count / session',
  },
] as const;

// ─── FHIR Export Section ──────────────────────────────────────────────────────
function FHIRExportSection({ token }: { token: string }) {
  const [days, setDays]       = useState(30);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta]       = useState<{ entries: string } | null>(null);
  const [error, setError]     = useState('');

  async function handleExport() {
    setLoading(true);
    setError('');
    setMeta(null);
    try {
      const res = await fetch(`${API_BASE}/api/export/fhir?days=${days}`, {
        headers: authHeaders(token),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error ?? `HTTP ${res.status}`);
      }

      const entries = res.headers.get('X-DiaTwin-Entry-Count') ?? '?';
      const text    = await res.text();

      const today    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = `diatwin_fhir_r4_${today}.json`;

      if (Platform.OS === 'web') {
        // ── Web: trigger a browser download ──────────────────────────────
        const blob = new Blob([text], { type: 'application/fhir+json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        // ── Native: write to cache dir, then share ────────────────────────
        const path = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(path, text, { encoding: 'utf8' });

        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, {
            mimeType: 'application/fhir+json',
            dialogTitle: 'Save FHIR R4 Bundle',
          });
        } else {
          Alert.alert('Saved', `File saved to: ${path}`);
        }
      }

      setMeta({ entries });
    } catch (err: any) {
      setError(err.message ?? 'Export failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.fhirBadge}>
          <Text style={styles.fhirBadgeText}>FHIR R4</Text>
        </View>
        <Text style={styles.cardTitle}>Clinical Data Export</Text>
      </View>

      <Text style={styles.subtitle}>
        Export as a FHIR R4 Bundle — pseudonymised identifiers compatible with{' '}
        <Text style={styles.bold}>MII Treuhandstelle</Text> workflows.
      </Text>

      <Text style={styles.label}>What's included</Text>
      <View style={styles.includesList}>
        {INCLUDED_RESOURCES.map(({ icon, label, detail }) => (
          <View key={label} style={styles.includeRow}>
            <Text style={styles.includeIcon}>{icon}</Text>
            <View style={styles.includeText}>
              <Text style={styles.includeLabel}>{label}</Text>
              <Text style={styles.includeDetail}>{detail}</Text>
            </View>
          </View>
        ))}
      </View>

      <Text style={styles.label}>Look-back window</Text>
      <View style={styles.daysRow}>
        {[7, 14, 30, 60, 90].map(d => (
          <TouchableOpacity
            key={d}
            onPress={() => setDays(d)}
            style={[styles.dayBtn, d === days && styles.dayBtnActive]}
          >
            <Text style={[styles.dayBtnText, d === days && styles.dayBtnTextActive]}>
              {d}d
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.infoBox}>
        <Text style={styles.infoIcon}>🔒</Text>
        <Text style={styles.infoText}>
          No name, email, or personal identifiers are included in the export.
        </Text>
      </View>

      <Text style={styles.label}>Coded terminology</Text>
      <View style={styles.terminologyList}>
        {TERMINOLOGY.map(({ code, system, description }) => (
          <View key={code} style={styles.terminologyRow}>
            <View style={styles.terminologyLeft}>
              <Text style={styles.loincTag}>{system} {code}</Text>
            </View>
            <Text style={styles.terminologyDesc}>{description}</Text>
          </View>
        ))}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {meta  ? (
        <Text style={styles.successText}>✓ Exported {meta.entries} FHIR entries</Text>
      ) : null}

      <TouchableOpacity
        onPress={handleExport}
        disabled={loading}
        style={[styles.btn, loading && styles.btnDisabled]}
      >
        {loading
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.btnText}>Download FHIR Bundle ({days} days)</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

// ─── GDPR Delete Section ──────────────────────────────────────────────────────
function GDPRDeleteSection({ token }: { token: string }) {
  const router   = useRouter();
  const signOut  = useAuthStore((s: any) => s.signOut);
  const [loading, setLoading] = useState(false);

  async function handleDelete(type: 'data' | 'account') {
    const isAccount   = type === 'account';
    const confirmText = isAccount ? 'DELETE MY ACCOUNT' : 'DELETE MY DATA';
    const endpoint    = isAccount ? '/api/patient/account' : '/api/patient/data';

    Alert.alert(
      isAccount ? 'Delete Account' : 'Delete All Medical Data',
      isAccount
        ? 'This will permanently delete ALL your medical data AND your account. This cannot be undone.'
        : 'This will permanently delete all your blood glucose, meal, insulin, and activity data. Your account login will remain active.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              `Type action: "${confirmText}"`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: isAccount ? 'Delete forever' : 'Delete data',
                  style: 'destructive',
                  onPress: async () => {
                    setLoading(true);
                    try {
                      const res = await fetch(`${API_BASE}${endpoint}`, {
                        method:  'DELETE',
                        headers: authHeaders(token),
                        body:    JSON.stringify({ confirm: confirmText }),
                      });
                      const body = await res.json();
                      if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);

                      Alert.alert(
                        '✓ Done',
                        body.message,
                        [{
                          text: 'OK',
                          onPress: () => {
                            if (isAccount) {
                              signOut?.();
                              router.replace('/(auth)/login');
                            }
                          },
                        }]
                      );
                    } catch (err: any) {
                      Alert.alert('Error', err.message ?? 'Deletion failed');
                    } finally {
                      setLoading(false);
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.gdprBadge}>
          <Text style={styles.gdprBadgeText}>GDPR Art. 17</Text>
        </View>
        <Text style={styles.cardTitle}>Right to Erasure</Text>
      </View>

      <Text style={styles.subtitle}>
        Under GDPR Article 17, you have the right to have your personal data erased.
      </Text>

      {loading && <ActivityIndicator style={{ marginBottom: 10 }} />}

      <TouchableOpacity
        onPress={() => handleDelete('data')}
        disabled={loading}
        style={styles.softDeleteBtn}
      >
        <Text style={styles.softDeleteTitle}>🗑  Delete all medical data</Text>
        <Text style={styles.softDeleteSub}>Keep account active</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => handleDelete('account')}
        disabled={loading}
        style={[styles.softDeleteBtn, styles.hardDeleteBtn]}
      >
        <Text style={styles.hardDeleteTitle}>✕  Delete account & all data</Text>
        <Text style={styles.hardDeleteSub}>Permanent — cannot undo</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function FHIRExportScreen() {
  const token = useAuthStore((s: any) => s.token ?? '');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <FHIRExportSection token={token} />
      <GDPRDeleteSection token={token} />
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen:           { flex: 1, backgroundColor: '#f9fafb' },
  content:          { padding: 16, gap: 16 },
  card:             { backgroundColor: '#fff', borderRadius: 12, padding: 16,
                      shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4,
                      shadowOffset: { width: 0, height: 2 }, elevation: 2, marginBottom: 16 },
  headerRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  cardTitle:        { fontSize: 16, fontWeight: '600', color: '#111' },
  subtitle:         { fontSize: 13, color: '#6b7280', lineHeight: 19, marginBottom: 12 },
  bold:             { fontWeight: '600', color: '#374151' },
  label:            { fontSize: 12, fontWeight: '600', color: '#374151', marginBottom: 6 },
  fhirBadge:        { backgroundColor: '#dbeafe', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  fhirBadgeText:    { fontSize: 11, fontWeight: '700', color: '#1d4ed8' },
  gdprBadge:        { backgroundColor: '#fef3c7', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  gdprBadgeText:    { fontSize: 11, fontWeight: '700', color: '#92400e' },
  daysRow:          { flexDirection: 'row', gap: 6, marginBottom: 12 },
  dayBtn:           { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
                      borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#f9fafb' },
  dayBtnActive:     { borderColor: '#2563eb', backgroundColor: '#2563eb' },
  dayBtnText:       { fontSize: 12, color: '#374151' },
  dayBtnTextActive: { color: '#fff', fontWeight: '600' },
  infoBox:          { flexDirection: 'row', alignItems: 'flex-start', gap: 6,
                      backgroundColor: '#f0fdf4', borderColor: '#bbf7d0', borderWidth: 1,
                      borderRadius: 6, padding: 10, marginBottom: 10 },
  infoIcon:         { fontSize: 14 },
  infoText:         { fontSize: 12, color: '#166534', flex: 1 },
  loincTag:         { fontSize: 10, backgroundColor: '#f1f5f9', color: '#475569',
                      paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3,
                      fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  terminologyList:  { gap: 6, marginBottom: 14 },
  terminologyRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  terminologyLeft:  { width: 110 },
  terminologyDesc:  { fontSize: 11, color: '#6b7280', flex: 1 },
  includesList:     { gap: 8, marginBottom: 14 },
  includeRow:       { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  includeIcon:      { fontSize: 14, width: 20, textAlign: 'center', marginTop: 1 },
  includeText:      { flex: 1 },
  includeLabel:     { fontSize: 12, fontWeight: '600', color: '#374151' },
  includeDetail:    { fontSize: 11, color: '#6b7280', marginTop: 1 },
  btn:              { backgroundColor: '#2563eb', borderRadius: 8, padding: 13,
                      alignItems: 'center', justifyContent: 'center' },
  btnDisabled:      { backgroundColor: '#93c5fd', borderRadius: 8, padding: 13,
                      alignItems: 'center', justifyContent: 'center' },
  btnText:          { color: '#fff', fontWeight: '600', fontSize: 14 },
  errorText:        { color: '#dc2626', fontSize: 12, marginBottom: 8 },
  successText:      { color: '#16a34a', fontSize: 13, fontWeight: '500', marginBottom: 8 },
  softDeleteBtn:    { borderWidth: 1, borderColor: '#fde68a', backgroundColor: '#fef9c3',
                      borderRadius: 8, padding: 12, marginBottom: 8 },
  softDeleteTitle:  { fontSize: 13, fontWeight: '600', color: '#713f12' },
  softDeleteSub:    { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  hardDeleteBtn:    { borderColor: '#fca5a5', backgroundColor: '#fee2e2' },
  hardDeleteTitle:  { fontSize: 13, fontWeight: '600', color: '#991b1b' },
  hardDeleteSub:    { fontSize: 11, color: '#9ca3af', marginTop: 2 },
});