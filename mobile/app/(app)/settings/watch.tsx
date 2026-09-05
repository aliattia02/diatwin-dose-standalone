/**
 * watch.tsx — Google Fit Watch HR Settings & Status Screen
 * Location: mobile/app/(app)/settings/watch.tsx
 *
 * Shows connection status, last sync info, manual sync trigger,
 * auto-sync toggle, sync interval picker, and disconnect option.
 * Mirrors the structure of libre.tsx.
 *
 * [TEST MODE] A "Developer · Test Data" section is shown on the
 * not-connected screen. It generates fake HR samples locally and
 * POSTs them to POST /api/watch/test/inject, which runs them through
 * the unchanged segment_hr_stream() pipeline. The connected screen
 * shows an amber "🧪 Test" badge when status.test_mode is true.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { colors, spacing } from '@/constants/theme';
import apiClient from '@/services/api/client';
import {
  getWatchStatus,
  syncWatch,
  updateWatchSettings,
  disconnectWatch,
} from '@/services/api/watch-sync';
import { API_BASE_URL } from '@/services/api/endpoints';
import type { WatchConnectionStatus, WatchSyncResult } from '@/types/watch.types';
import { timeAgo } from '@/types/watch.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_BLUE = '#4285F4';
const TEST_AMBER  = '#f59e0b';
const INTERVAL_OPTIONS = [15, 30, 60] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function Divider() {
  return <View style={styles.divider} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake HR generator — runs entirely on-device, no CSV needed
//
// Mirrors the Kaggle Fitbit heartrate_seconds_merged.csv shape:
//   { timestamp_iso: string, hr_bpm: number }[]
// Three sessions: morning run · lunch walk · evening gym
// ─────────────────────────────────────────────────────────────────────────────

const ZONE_BPM = { resting: 65, light: 88, moderate: 122, vigorous: 158 } as const;
type Zone = keyof typeof ZONE_BPM;

function buildFakeHRSamples(): Array<{ timestamp_iso: string; hr_bpm: number }> {
  const t0 = new Date(Date.now() - 8 * 60 * 60 * 1000); // anchor 8 h ago
  const out: Array<{ timestamp_iso: string; hr_bpm: number }> = [];

  function addSession(
    startOffsetMin: number,
    phases: Array<[Zone, number]>, // [zone, duration_in_minutes]
  ) {
    let offset = startOffsetMin;
    let prevHr  = ZONE_BPM.resting;

    for (const [zone, mins] of phases) {
      const target = ZONE_BPM[zone];
      for (let i = 0; i < mins; i++) {
        const ramp  = Math.min(1, i / Math.max(1, mins * 0.2));
        const mid   = prevHr + (target - prevHr) * ramp;
        const noise = (Math.random() - 0.5) * 10;
        const hr    = Math.round(Math.max(40, Math.min(200, mid + noise)));
        const ts    = new Date(t0.getTime() + (offset + i) * 60_000);
        out.push({ timestamp_iso: ts.toISOString(), hr_bpm: hr });
        prevHr = hr;
      }
      offset += mins;
    }
  }

  // Morning run — 50 min
  addSession(10, [
    ['resting',  5],
    ['light',    5],
    ['moderate', 13],
    ['vigorous', 17],
    ['moderate', 5],
    ['light',    5],
  ]);

  // Lunch walk — 24 min
  addSession(130, [
    ['resting', 4],
    ['light',   16],
    ['resting', 4],
  ]);

  // Evening gym — 55 min
  addSession(230, [
    ['resting',  4],
    ['light',    5],
    ['moderate', 8],
    ['vigorous', 25],
    ['moderate', 8],
    ['light',    5],
  ]);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function WatchSettingsScreen() {
  const [status,         setStatus]         = useState<WatchConnectionStatus | null>(null);
  const [isLoading,      setIsLoading]      = useState(true);
  const [isSyncing,      setIsSyncing]      = useState(false);
  const [isRefreshing,   setIsRefreshing]   = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<WatchSyncResult | null>(null);
  const [isTestLoading,  setIsTestLoading]  = useState(false);

  // ── Fetch connection status ───────────────────────────────────────────────
  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true);
    try {
      const s = await getWatchStatus();
      setStatus(s);
    } catch {
      // Non-fatal — keep showing last state
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const onRefresh = () => {
    setIsRefreshing(true);
    loadStatus(true);
  };

  // ── Manual sync ───────────────────────────────────────────────────────────
  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const result = await syncWatch();
      setLastSyncResult(result);
      await loadStatus(true);
      Alert.alert(
        'Sync complete',
        result.new_count > 0
          ? `${result.new_count} new activity session${result.new_count !== 1 ? 's' : ''} created.`
          : 'No new activity sessions found.',
      );
    } catch (e: any) {
      Alert.alert('Sync failed', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
    } finally {
      setIsSyncing(false);
    }
  };

  // ── Toggle auto-sync ──────────────────────────────────────────────────────
  const handleToggleAutoSync = async (value: boolean) => {
    if (!status) return;
    const prev = status.auto_sync_enabled;
    setStatus(s => s ? { ...s, auto_sync_enabled: value } : s);
    try {
      await updateWatchSettings({ auto_sync_enabled: value });
    } catch {
      setStatus(s => s ? { ...s, auto_sync_enabled: prev } : s);
      Alert.alert('Error', 'Could not update settings. Please try again.');
    }
  };

  // ── Change sync interval ──────────────────────────────────────────────────
  const handleChangeInterval = async (minutes: number) => {
    if (!status) return;
    const prev = status.sync_interval_minutes;
    setStatus(s => s ? { ...s, sync_interval_minutes: minutes } : s);
    try {
      await updateWatchSettings({ sync_interval_minutes: minutes });
    } catch {
      setStatus(s => s ? { ...s, sync_interval_minutes: prev } : s);
      Alert.alert('Error', 'Could not update sync interval.');
    }
  };

  // ── Disconnect ────────────────────────────────────────────────────────────
  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect Google Fit',
      'Stop syncing heart rate data from Google Fit?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Keep activity data',
          style: 'default',
          onPress: () => confirmDisconnect(false),
        },
        {
          text: 'Delete activity data too',
          style: 'destructive',
          onPress: () => confirmDisconnect(true),
        },
      ],
    );
  };

  const confirmDisconnect = async (deleteActivities: boolean) => {
    try {
      await disconnectWatch(deleteActivities);
      setStatus({ connected: false });
      Alert.alert('Disconnected', 'Google Fit has been disconnected.');
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error ?? 'Could not disconnect.');
    }
  };

  // ── [TEST] Load fake HR data ──────────────────────────────────────────────
  // Note: Alert.alert confirmation removed — it silently drops on Expo Go.
  // The loading spinner on the button is sufficient feedback for a dev tool.
  // Also switched from raw axios → apiClient so the auth token is included.
  const handleLoadTestData = async () => {
    setIsTestLoading(true);
    try {
      const samples = buildFakeHRSamples();
      const { data } = await apiClient.post(
        '/api/watch/test/inject',
        { samples },
      );
      await loadStatus(true);
      Alert.alert(
        '🧪 Test data loaded',
        `${data.new_count ?? 0} session(s) created from ${samples.length} HR samples.`,
      );
    } catch (e: any) {
      Alert.alert('Failed', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
    } finally {
      setIsTestLoading(false);
    }
  };

  // ── [TEST] Clear fake HR data ─────────────────────────────────────────────
  // Note: Alert confirmation kept here (destructive action) but using apiClient
  // for the actual request so the auth token is included.
  const handleClearTestData = () => {
    Alert.alert(
      'Clear test data',
      'Remove all injected test sessions and disconnect?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiClient.delete('/api/watch/test/inject');
              setStatus({ connected: false });
              Alert.alert('Cleared', 'Test data removed.');
            } catch (e: any) {
              Alert.alert('Error', e?.response?.data?.error ?? 'Could not clear test data.');
            }
          },
        },
      ],
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render — loading
  // ─────────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={GOOGLE_BLUE} />
      </View>
    );
  }

  const connected = status?.connected ?? false;
  const testMode  = (status as any)?.test_mode === true;

  // ─────────────────────────────────────────────────────────────────────────
  // Render — not connected
  // ─────────────────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={GOOGLE_BLUE} />
        }
      >
        {/* Hero card */}
        <View style={styles.heroCard}>
          <Text style={styles.heroIcon}>⌚</Text>
          <Text style={styles.heroTitle}>Google Fit not connected</Text>
          <Text style={styles.heroSubtitle}>
            Connect to automatically sync heart rate data from your watch into
            DiaTwin's glucose model.
          </Text>
        </View>

        {/* Supported devices */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Works with</Text>
          {[
            { icon: '⌚', label: 'Pixel Watch (1, 2, 3)' },
            { icon: '⌚', label: 'Samsung Galaxy Watch (via Health Connect)' },
            { icon: '⌚', label: 'Wear OS devices (Fossil, Mobvoi, etc.)' },
            { icon: '📱', label: 'Fitbit via Health Connect' },
          ].map((item, i) => (
            <View key={i} style={styles.deviceRow}>
              <Text style={styles.deviceIcon}>{item.icon}</Text>
              <Text style={styles.deviceLabel}>{item.label}</Text>
            </View>
          ))}
        </View>

        {/* Sign in button */}
        <TouchableOpacity
          style={styles.connectBtn}
          onPress={() => router.push('/(app)/settings/watch-connect' as any)}
          activeOpacity={0.85}
        >
          <Text style={styles.googleG}>G</Text>
          <Text style={styles.connectBtnText}>Sign in with Google</Text>
        </TouchableOpacity>

        {/* ── DEV / TEST MODE ─────────────────────────────────────────────── */}
        <SectionLabel>DEV · TEST MODE</SectionLabel>
        <View style={styles.testCard}>
          <View style={styles.testCardHeader}>
            <Text style={styles.testCardIcon}>🧪</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.testCardTitle}>Use synthetic HR data</Text>
              <Text style={styles.testCardDesc}>
                No watch? Injects 3 Fitbit-style sessions (morning run, lunch
                walk, evening gym) directly into the pipeline — no Google
                account required.
              </Text>
            </View>
          </View>

          {/* Preview chips */}
          <View style={styles.testChips}>
            {[
              { label: 'Morning run',  detail: '50 min · vigorous' },
              { label: 'Lunch walk',   detail: '24 min · light'    },
              { label: 'Evening gym',  detail: '55 min · vigorous' },
            ].map((s, i) => (
              <View key={i} style={styles.testChip}>
                <Text style={styles.testChipLabel}>{s.label}</Text>
                <Text style={styles.testChipDetail}>{s.detail}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.testBtn, isTestLoading && styles.testBtnDisabled]}
            onPress={handleLoadTestData}
            disabled={isTestLoading}
            activeOpacity={0.8}
          >
            {isTestLoading
              ? <ActivityIndicator color={TEST_AMBER} size="small" />
              : <Text style={styles.testBtnText}>↑  Inject test data</Text>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render — connected (real or test)
  // ─────────────────────────────────────────────────────────────────────────

  const accentColor = testMode ? TEST_AMBER : GOOGLE_BLUE;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={accentColor} />
      }
    >

      {/* ── Status card ─────────────────────────────────────────────────── */}
      <View style={styles.card}>
        {/* Connected badge */}
        <View style={styles.statusRow}>
          <View style={[styles.connectedDot, testMode && { backgroundColor: TEST_AMBER }]} />
          <Text style={[styles.connectedLabel, testMode && { color: TEST_AMBER }]}>
            {testMode ? 'Test Mode' : 'Connected'}
          </Text>
          <View style={{ flex: 1 }} />
          <View style={[styles.googleBadge, { backgroundColor: accentColor + '18' }]}>
            <Text style={[styles.googleBadgeText, { color: accentColor }]}>
              {testMode ? '🧪' : 'G'}
            </Text>
            <Text style={[styles.googleBadgeName, { color: accentColor }]}>
              {testMode ? 'Test Data' : 'Google Fit'}
            </Text>
          </View>
        </View>

        <Divider />

        {/* Account info */}
        {(status?.google_name || status?.google_email) && (
          <>
            <View style={styles.infoRow}>
              <Text style={styles.infoKey}>Account</Text>
              <View style={styles.infoValueCol}>
                {status.google_name && (
                  <Text style={styles.infoValue}>{status.google_name}</Text>
                )}
                {status.google_email && (
                  <Text style={styles.infoValueSub}>{status.google_email}</Text>
                )}
              </View>
            </View>
            <Divider />
          </>
        )}

        {/* Last sync */}
        <View style={styles.infoRow}>
          <Text style={styles.infoKey}>Last sync</Text>
          <Text style={styles.infoValue}>
            {status?.last_sync ? timeAgo(status.last_sync) : 'Never'}
          </Text>
        </View>

        {lastSyncResult && (
          <View style={[styles.syncResultBanner, testMode && { backgroundColor: TEST_AMBER + '18' }]}>
            <Text style={[styles.syncResultText, testMode && { color: TEST_AMBER }]}>
              Last sync: {lastSyncResult.new_count} new session{lastSyncResult.new_count !== 1 ? 's' : ''}
              {lastSyncResult.latest_session
                ? ` · ${lastSyncResult.latest_session.intensity} intensity`
                : ''}
            </Text>
          </View>
        )}
      </View>

      {/* ── Manual sync (hidden in test mode — backend scheduler not running) */}
      {!testMode && (
        <TouchableOpacity
          style={[styles.syncBtn, isSyncing && styles.syncBtnDisabled]}
          onPress={handleSync}
          disabled={isSyncing}
          activeOpacity={0.8}
        >
          {isSyncing
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.syncBtnText}>↺  Sync now</Text>
          }
        </TouchableOpacity>
      )}

      {/* ── Auto-sync settings (hidden in test mode) ─────────────────────── */}
      {!testMode && (
        <>
          <SectionLabel>SYNC SETTINGS</SectionLabel>
          <View style={styles.card}>
            {/* Auto-sync toggle */}
            <View style={styles.settingRow}>
              <View style={styles.settingLabelCol}>
                <Text style={styles.settingLabel}>Auto-sync</Text>
                <Text style={styles.settingDesc}>
                  Fetch HR data from Google Fit automatically
                </Text>
              </View>
              <Switch
                value={status?.auto_sync_enabled ?? true}
                onValueChange={handleToggleAutoSync}
                trackColor={{ false: colors.border ?? '#2a2d3a', true: GOOGLE_BLUE + '80' }}
                thumbColor={status?.auto_sync_enabled ? GOOGLE_BLUE : '#6b7280'}
              />
            </View>

            <Divider />

            {/* Sync interval */}
            <View style={styles.settingLabelCol}>
              <Text style={styles.settingLabel}>Sync interval</Text>
              <Text style={styles.settingDesc}>
                How often DiaTwin polls Google Fit (minimum 15 min)
              </Text>
            </View>
            <View style={styles.intervalRow}>
              {INTERVAL_OPTIONS.map(min => {
                const active = (status?.sync_interval_minutes ?? 15) === min;
                return (
                  <TouchableOpacity
                    key={min}
                    style={[styles.intervalChip, active && styles.intervalChipActive]}
                    onPress={() => handleChangeInterval(min)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.intervalChipText, active && styles.intervalChipTextActive]}>
                      {min} min
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </>
      )}

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <SectionLabel>HOW IT WORKS</SectionLabel>
      <View style={styles.card}>
        {[
          { n: '1', t: 'HR data is fetched in 1-minute buckets from Google Fit' },
          { n: '2', t: 'Buckets are segmented into activity sessions by intensity' },
          { n: '3', t: 'Sessions are fed into the glucose pharmacodynamics model' },
          { n: '4', t: 'Post-exercise insulin sensitivity adjusts your BG estimate' },
        ].map(step => (
          <View key={step.n} style={styles.howRow}>
            <View style={[styles.howBadge, { borderColor: accentColor, backgroundColor: accentColor + '22' }]}>
              <Text style={[styles.howNum, { color: accentColor }]}>{step.n}</Text>
            </View>
            <Text style={styles.howText}>{step.t}</Text>
          </View>
        ))}
      </View>

      {/* ── Account / danger zone ─────────────────────────────────────────── */}
      <SectionLabel>ACCOUNT</SectionLabel>
      <View style={styles.card}>
        {testMode ? (
          <TouchableOpacity style={styles.disconnectRow} onPress={handleClearTestData} activeOpacity={0.7}>
            <Text style={styles.disconnectText}>Clear test data</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.disconnectRow} onPress={handleDisconnect} activeOpacity={0.7}>
            <Text style={styles.disconnectText}>Disconnect Google Fit</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.footer}>
        {testMode
          ? '🧪 Running on synthetic Fitbit data — not a real Google Fit connection.'
          : `Connected ${status?.connected_at ? timeAgo(status.connected_at) : ''}\nDiaTwin requests read-only access to heart rate data only.`
        }
      </Text>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md ?? 16,
    paddingBottom: 48,
    backgroundColor: colors.background,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: colors.text?.secondary ?? '#64748b',
    marginTop: 20,
    marginBottom: 6,
    marginLeft: 4,
  },

  // ── Generic card ───────────────────────────────────────────────────────────
  card: {
    backgroundColor: colors.card ?? '#1a1d27',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    padding: spacing.md ?? 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border ?? '#2a2d3a',
    marginVertical: 12,
  },

  // ── Status row ─────────────────────────────────────────────────────────────
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  connectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
  },
  connectedLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#22c55e',
  },
  googleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 5,
  },
  googleBadgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  googleBadgeName: {
    fontSize: 12,
    fontWeight: '600',
  },

  // ── Info rows ──────────────────────────────────────────────────────────────
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  infoKey: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    paddingTop: 1,
    minWidth: 80,
  },
  infoValueCol: {
    flex: 1,
    alignItems: 'flex-end',
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
    textAlign: 'right',
  },
  infoValueSub: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'right',
    marginTop: 2,
  },

  // ── Sync result banner ─────────────────────────────────────────────────────
  syncResultBanner: {
    backgroundColor: '#22c55e18',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 10,
  },
  syncResultText: {
    fontSize: 12,
    color: '#22c55e',
    fontWeight: '600',
  },

  // ── Sync now button ────────────────────────────────────────────────────────
  syncBtn: {
    backgroundColor: GOOGLE_BLUE,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 12,
  },
  syncBtnDisabled: { opacity: 0.5 },
  syncBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Settings rows ──────────────────────────────────────────────────────────
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  settingLabelCol: {
    flex: 1,
    marginBottom: 10,
  },
  settingLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
  },
  settingDesc: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    marginTop: 2,
    lineHeight: 16,
  },

  // ── Interval chips ─────────────────────────────────────────────────────────
  intervalRow: {
    flexDirection: 'row',
    gap: 8,
  },
  intervalChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    alignItems: 'center',
  },
  intervalChipActive: {
    backgroundColor: GOOGLE_BLUE + '18',
    borderColor: GOOGLE_BLUE,
  },
  intervalChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
  },
  intervalChipTextActive: {
    color: GOOGLE_BLUE,
  },

  // ── How it works ───────────────────────────────────────────────────────────
  howRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  },
  howBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  howNum: {
    fontSize: 11,
    fontWeight: '700',
  },
  howText: {
    flex: 1,
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 18,
  },

  // ── Disconnect ─────────────────────────────────────────────────────────────
  disconnectRow: { paddingVertical: 2 },
  disconnectText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ef4444',
  },

  // ── Not-connected hero ─────────────────────────────────────────────────────
  heroCard: {
    backgroundColor: GOOGLE_BLUE + '12',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GOOGLE_BLUE + '30',
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
  },
  heroIcon: { fontSize: 36, marginBottom: 10 },
  heroTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 8,
    textAlign: 'center',
  },
  heroSubtitle: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'center',
    lineHeight: 19,
  },

  // ── Supported devices ─────────────────────────────────────────────────────
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  deviceIcon: { fontSize: 16 },
  deviceLabel: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
  },

  // ── Connect button ─────────────────────────────────────────────────────────
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: GOOGLE_BLUE,
    borderRadius: 12,
    paddingVertical: 14,
    gap: 10,
    marginBottom: 4,
  },
  googleG: {
    fontSize: 17,
    fontWeight: '800',
    color: '#fff',
  },
  connectBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Test data card ─────────────────────────────────────────────────────────
  testCard: {
    backgroundColor: TEST_AMBER + '0d',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: TEST_AMBER + '35',
    padding: spacing.md ?? 16,
    marginBottom: 12,
  },
  testCardHeader: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  testCardIcon: { fontSize: 22, marginTop: 1 },
  testCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 4,
  },
  testCardDesc: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 17,
  },
  testChips: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  testChip: {
    backgroundColor: TEST_AMBER + '18',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  testChipLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: TEST_AMBER,
  },
  testChipDetail: {
    fontSize: 10,
    color: TEST_AMBER + 'bb',
    marginTop: 1,
  },
  testBtn: {
    borderWidth: 1.5,
    borderColor: TEST_AMBER,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  testBtnDisabled: { opacity: 0.45 },
  testBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: TEST_AMBER,
  },

  // ── Footer note ────────────────────────────────────────────────────────────
  footer: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#64748b',
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 8,
    paddingHorizontal: 16,
  },
});