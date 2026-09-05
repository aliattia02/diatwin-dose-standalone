/**
 * LibreLinkUp CGM History Screen
 * Location: mobile/app/(app)/settings/libre.tsx
 *
 * Screens:
 *   Not connected → prompt card with link to connect
 *   Connected     → live reading header + auto-sync settings + day-grouped CGM readings list
 *
 * Data flow:
 *   useLibreStatus()   → connection state + latest reading
 *   useLibreReadings() → grouped CGM history, sync controls
 *   useLibreConnect()  → updateSettings for auto-sync toggle
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { colors } from '@/constants/theme';
import { useLibreReadings, useLibreStatus, useLibreConnect } from '@/hooks/useLibre';
import type { LibreReading } from '@/types/libre.types';
import {
  formatDayLabel,
  formatReadingTime,
  getReadingColor,
  getTrendArrow,
  getTrendColor,
  READING_TYPE_LABEL,
  timeAgo,
} from '@/types/libre.types';

// ─────────────────────────────────────────────────────────────────────────────
// Hours picker options
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_OPTIONS = [
  { label: '6 h',   value: 6   },
  { label: '24 h',  value: 24  },
  { label: '3 d',   value: 72  },
  { label: '7 d',   value: 168 },
];

// Sync interval options shown in the auto-sync card
const INTERVAL_OPTIONS = [
  { label: '4 min',  value: 4  },
  { label: '5 min',  value: 5  },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
];


// ─────────────────────────────────────────────────────────────────────────────
// TZ Debug Panel — shows browser timezone, UTC offset, and sample reading times
// Remove or hide behind __DEV__ once confirmed correct.
// ─────────────────────────────────────────────────────────────────────────────

function TzDebugPanel({ readings }: { readings: LibreReading[] }) {
  const now         = new Date();
  const tzName      = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utcOffsetMin = -now.getTimezoneOffset();           // getTimezoneOffset() is negated
  const utcOffsetH   = utcOffsetMin / 60;
  const sample       = readings[0];                        // most recent reading

  // What toLocaleTimeString produces (the browser's local time)
  const localTime  = sample
    ? new Date(sample.bloodSugarTimestamp.endsWith('Z') || sample.bloodSugarTimestamp.includes('+')
        ? sample.bloodSugarTimestamp
        : sample.bloodSugarTimestamp + 'Z'
      ).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—';

  // Raw UTC of the stored timestamp
  const utcTime = sample
    ? new Date(sample.bloodSugarTimestamp.endsWith('Z') || sample.bloodSugarTimestamp.includes('+')
        ? sample.bloodSugarTimestamp
        : sample.bloodSugarTimestamp + 'Z'
      ).toISOString().slice(11, 16)
    : '—';

  // What it would look like pinned to UTC+2 (Egypt standard / EET, no DST)
  const pinned = sample
    ? (() => {
        const ms  = new Date(sample.bloodSugarTimestamp.endsWith('Z') || sample.bloodSugarTimestamp.includes('+')
          ? sample.bloodSugarTimestamp
          : sample.bloodSugarTimestamp + 'Z'
        ).getTime();
        const d   = new Date(ms + 2 * 3600_000);
        return d.toISOString().slice(11, 16);
      })()
    : '—';

  return (
    <View style={dbg.wrap}>
      <Text style={dbg.title}>🔍 TZ Debug Panel</Text>
      <Text style={dbg.row}><Text style={dbg.key}>Browser TZ:       </Text>{tzName}</Text>
      <Text style={dbg.row}><Text style={dbg.key}>UTC offset:       </Text>UTC{utcOffsetH >= 0 ? '+' : ''}{utcOffsetH} ({utcOffsetMin} min)</Text>
      <Text style={dbg.row}><Text style={dbg.key}>Now (local):      </Text>{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</Text>
      <Text style={dbg.row}><Text style={dbg.key}>Now (UTC):        </Text>{now.toISOString().slice(11, 16)}</Text>
      {sample && <>
        <View style={dbg.divider} />
        <Text style={dbg.row}><Text style={dbg.key}>Latest stored UTC:</Text> {utcTime}Z   ({sample.bloodSugar} mg/dL)</Text>
        <Text style={dbg.row}><Text style={dbg.key}>Displayed (local):</Text> {localTime}  ← toLocaleTimeString</Text>
        <Text style={dbg.row}><Text style={dbg.key}>Pinned UTC+2 EET: </Text> {pinned}  ← if Egypt = UTC+2 always</Text>
        <Text style={dbg.hint}>
          If displayed ≠ pinned, browser is applying DST (EEST = UTC+3 in summer).{'\n'}
          LibreLinkUp app shows EET (UTC+2) regardless of DST.
        </Text>
      </>}
    </View>
  );
}

const dbg = StyleSheet.create({
  wrap: {
    margin: 12,
    padding: 12,
    backgroundColor: 'rgba(99,102,241,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.25)',
    borderRadius: 10,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6366f1',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: {
    fontSize: 12,
    color: '#94a3b8',
    fontFamily: 'monospace' as any,
    marginBottom: 2,
  },
  key: {
    color: '#f1f5f9',
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(99,102,241,0.15)',
    marginVertical: 6,
  },
  hint: {
    fontSize: 11,
    color: '#6366f1',
    marginTop: 6,
    lineHeight: 16,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** Single CGM reading row */
function ReadingRow({ item }: { item: LibreReading }) {
  const valueColor = getReadingColor(item);
  const arrowColor = getTrendColor(item.trend);
  const arrow      = getTrendArrow(item.trend);
  const typeLabel  = READING_TYPE_LABEL[item.reading_type] ?? 'CGM';
  const time       = formatReadingTime(item.bloodSugarTimestamp);

  return (
    <View style={styles.row}>
      {/* Time */}
      <Text style={styles.rowTime}>{time}</Text>

      {/* Value */}
      <View style={styles.rowValueWrap}>
        <Text style={[styles.rowValue, { color: valueColor }]}>
          {item.bloodSugar}
        </Text>
        <Text style={styles.rowUnit}>mg/dL</Text>
      </View>

      {/* Trend arrow */}
      <Text style={[styles.rowArrow, { color: arrowColor }]}>{arrow}</Text>

      {/* Status pill */}
      <View style={[styles.statusPill, statusPillStyle(item)]}>
        <Text style={[styles.statusPillText, statusPillTextStyle(item)]}>
          {item.status.toUpperCase()}
        </Text>
      </View>

      {/* Reading type badge — only show non-CGM */}
      {item.reading_type !== 0 && (
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{typeLabel}</Text>
        </View>
      )}
    </View>
  );
}

function statusPillStyle(r: LibreReading) {
  if (r.status === 'low')  return { backgroundColor: 'rgba(239,68,68,0.12)'  };
  if (r.status === 'high') return { backgroundColor: 'rgba(249,115,22,0.12)' };
  return { backgroundColor: 'rgba(34,197,94,0.10)' };
}

function statusPillTextStyle(r: LibreReading) {
  if (r.status === 'low')  return { color: '#ef4444' };
  if (r.status === 'high') return { color: '#f97316' };
  return { color: '#22c55e' };
}

/** Section header showing the day label + reading count */
function DayHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.dayHeader}>
      <Text style={styles.dayLabel}>{title}</Text>
      <Text style={styles.dayCount}>{count} readings</Text>
    </View>
  );
}

/** Shown when there is no LibreLinkUp connection */
function NotConnectedCard() {
  return (
    <View style={styles.notConnectedWrap}>
      <Text style={styles.notConnectedIcon}>📡</Text>
      <Text style={styles.notConnectedTitle}>No CGM Connected</Text>
      <Text style={styles.notConnectedBody}>
        Connect your FreeStyle Libre sensor via LibreLinkUp to see your
        continuous glucose readings here.
      </Text>
      <TouchableOpacity
        style={styles.connectBtn}
        onPress={() => router.push('/(app)/settings/libre-connect' as any)}
        activeOpacity={0.8}
      >
        <Text style={styles.connectBtnText}>Connect LibreLinkUp</Text>
      </TouchableOpacity>
    </View>
  );
}

/** Live reading hero card at the top of the connected screen */
function LiveReadingCard({
  reading,
  lastSync,
}: {
  reading: LibreReading | null;
  lastSync: string | null | undefined;
}) {
  if (!reading) {
    return (
      <View style={styles.heroCard}>
        <Text style={styles.heroNoReading}>No recent reading</Text>
        <Text style={styles.heroSyncHint}>Tap Sync to fetch the latest data</Text>
      </View>
    );
  }

  const valueColor = getReadingColor(reading);
  const arrowColor = getTrendColor(reading.trend);
  const arrow      = getTrendArrow(reading.trend);

  return (
    <View style={styles.heroCard}>
      <View style={styles.heroTop}>
        <View>
          <Text style={styles.heroLabel}>Current Glucose</Text>
          {lastSync && (
            <Text style={styles.heroSync}>
              Synced {timeAgo(lastSync)}
            </Text>
          )}
        </View>
        {/* Sensor badge */}
        <View style={styles.sensorBadge}>
          <Text style={styles.sensorBadgeText}>LIBRE</Text>
        </View>
      </View>

      <View style={styles.heroValueRow}>
        <Text style={[styles.heroValue, { color: valueColor }]}>
          {reading.bloodSugar}
        </Text>
        <View style={styles.heroValueMeta}>
          <Text style={styles.heroUnit}>mg/dL</Text>
          <Text style={[styles.heroArrow, { color: arrowColor }]}>{arrow}</Text>
        </View>
      </View>

      <Text style={styles.heroTime}>{`Reading at ${formatReadingTime(reading.bloodSugarTimestamp)}  ·  ${timeAgo(reading.bloodSugarTimestamp)}`}</Text>
    </View>
  );
}

/** Horizontal hour-range picker */
function HourPicker({
  selected,
  onChange,
}: {
  selected: number;
  onChange: (h: number) => void;
}) {
  return (
    <View style={styles.hourPicker}>
      {HOUR_OPTIONS.map((opt) => {
        const active = opt.value === selected;
        return (
          <Pressable
            key={opt.value}
            style={[styles.hourChip, active && styles.hourChipActive]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.hourChipText, active && styles.hourChipTextActive]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AutoSyncCard — toggle + interval selector
// ─────────────────────────────────────────────────────────────────────────────

interface AutoSyncCardProps {
  autoSyncEnabled: boolean;
  syncInterval: number;
  onToggle: (enabled: boolean) => void;
  onIntervalChange: (minutes: number) => void;
  isSaving: boolean;
}

function AutoSyncCard({
  autoSyncEnabled,
  syncInterval,
  onToggle,
  onIntervalChange,
  isSaving,
}: AutoSyncCardProps) {
  return (
    <View style={styles.autoSyncCard}>
      {/* Header row */}
      <View style={styles.autoSyncHeader}>
        <View style={styles.autoSyncTitleWrap}>
          <Text style={styles.autoSyncTitle}>Auto Sync</Text>
          <Text style={styles.autoSyncSubtitle}>
            Automatically pull readings in the background
          </Text>
        </View>

        <View style={styles.autoSyncToggleWrap}>
          {isSaving && (
            <ActivityIndicator
              size="small"
              color={colors.primary ?? '#6366f1'}
              style={{ marginRight: 8 }}
            />
          )}
          <Switch
            value={autoSyncEnabled}
            onValueChange={onToggle}
            disabled={isSaving}
            trackColor={{
              false: colors.border ?? '#2a2d3a',
              true:  (colors.primary ?? '#6366f1') + '88',
            }}
            thumbColor={
              autoSyncEnabled
                ? (colors.primary ?? '#6366f1')
                : (colors.text?.secondary ?? '#94a3b8')
            }
          />
        </View>
      </View>

      {/* Status badge */}
      <View style={[
        styles.autoSyncStatus,
        autoSyncEnabled ? styles.autoSyncStatusOn : styles.autoSyncStatusOff,
      ]}>
        <Text style={[
          styles.autoSyncStatusText,
          autoSyncEnabled ? styles.autoSyncStatusTextOn : styles.autoSyncStatusTextOff,
        ]}>
          {autoSyncEnabled ? '● Active' : '○ Paused'}
        </Text>
      </View>

      {/* Interval picker — only visible when enabled */}
      {autoSyncEnabled && (
        <View style={styles.intervalWrap}>
          <Text style={styles.intervalLabel}>Sync every</Text>
          <View style={styles.intervalRow}>
            {INTERVAL_OPTIONS.map((opt) => {
              const active = opt.value === syncInterval;
              return (
                <Pressable
                  key={opt.value}
                  style={[styles.intervalChip, active && styles.intervalChipActive]}
                  onPress={() => onIntervalChange(opt.value)}
                  disabled={isSaving}
                >
                  <Text style={[
                    styles.intervalChipText,
                    active && styles.intervalChipTextActive,
                  ]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.intervalHint}>
            ⚡ Also keeps the server alive on Render free tier
          </Text>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function LibreScreen() {
  // Status (connection + latest reading)
  const { status, connected, isLoading: statusLoading } = useLibreStatus(true);

  // ── Loading skeleton ───────────────────────────────────────────────────
  if (statusLoading && !status) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // ── Not connected: render without ever calling useLibreReadings ────────
  if (!connected) {
    return (
      <View style={styles.root}>
        <NotConnectedCard />
      </View>
    );
  }

  // ── Connected: delegate to inner component that calls useLibreReadings ─
  return <ConnectedView status={status} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// ConnectedView — only mounted when sensor is connected, so
// useLibreReadings never fires the API call on unauthenticated screens.
// ─────────────────────────────────────────────────────────────────────────────

function ConnectedView({ status }: { status: any }) {
  const [hours, setHours] = useState(24);

  // Local mirrors of auto-sync state (optimistic UI)
  const [autoSyncEnabled, setAutoSyncEnabled] = useState<boolean>(
    status?.auto_sync_enabled ?? true
  );
  const [syncInterval, setSyncInterval] = useState<number>(
    status?.sync_interval_minutes ?? 5
  );

  const {
    grouped,
    latest,
    count,
    isLoading: readingsLoading,
    isSyncing,
    error,
    syncResult,
    refresh,
    sync,
  } = useLibreReadings({ hours, syncOnLoad: false });

  const { updateSettings, isUpdatingSettings } = useLibreConnect();

  const refreshing  = readingsLoading && !isSyncing;

  // ── Sync handler ───────────────────────────────────────────────────────
  const handleSync = async () => {
    await sync();
  };

  // ── Auto-sync toggle ───────────────────────────────────────────────────
  const handleToggleAutoSync = async (enabled: boolean) => {
    setAutoSyncEnabled(enabled); // Optimistic update
    try {
      await updateSettings({ auto_sync_enabled: enabled, sync_interval_minutes: syncInterval });
    } catch {
      setAutoSyncEnabled(!enabled); // Revert on failure
      Alert.alert('Error', 'Failed to update auto-sync setting. Please try again.');
    }
  };

  // ── Interval change ────────────────────────────────────────────────────
  const handleIntervalChange = async (minutes: number) => {
    const prev = syncInterval;
    setSyncInterval(minutes); // Optimistic update
    try {
      await updateSettings({ auto_sync_enabled: autoSyncEnabled, sync_interval_minutes: minutes });
    } catch {
      setSyncInterval(prev); // Revert on failure
      Alert.alert('Error', 'Failed to update sync interval. Please try again.');
    }
  };

  // ── Build SectionList sections ─────────────────────────────────────────
  const sections = grouped.map(({ date, readings }) => ({
    title: formatDayLabel(date),
    count: readings.length,
    data:  readings,
  }));

  return (
    <View style={styles.root}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => <ReadingRow item={item} />}
        renderSectionHeader={({ section }) => (
          <DayHeader title={section.title} count={section.count} />
        )}
        stickySectionHeadersEnabled
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <>
            {/* Live reading hero */}
            <LiveReadingCard
              reading={status?.latest_reading ?? latest}
              lastSync={status?.last_sync}
            />

            {/* ── TZ Debug Panel (remove once timezone confirmed correct) ── */}
            <TzDebugPanel readings={grouped.flatMap(g => g.readings)} />

            {/* ── Auto-sync settings card ────────────────────────────── */}
            <AutoSyncCard
              autoSyncEnabled={autoSyncEnabled}
              syncInterval={syncInterval}
              onToggle={handleToggleAutoSync}
              onIntervalChange={handleIntervalChange}
              isSaving={isUpdatingSettings}
            />

            {/* Sync result banner */}
            {syncResult && (
              <View style={[
                styles.syncBanner,
                syncResult.new_count > 0 ? styles.syncBannerSuccess : styles.syncBannerIdle,
              ]}>
                <Text style={styles.syncBannerText}>
                  {syncResult.new_count > 0
                    ? `✓ ${syncResult.new_count} new reading${syncResult.new_count === 1 ? '' : 's'} synced`
                    : '✓ Already up to date'}
                </Text>
              </View>
            )}

            {/* Error banner */}
            {error && (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>⚠ {error}</Text>
              </View>
            )}

            {/* Controls row: sync button + hour picker */}
            <View style={styles.controlsRow}>
              <TouchableOpacity
                style={[styles.syncBtn, isSyncing && styles.syncBtnDisabled]}
                onPress={handleSync}
                disabled={isSyncing}
                activeOpacity={0.8}
              >
                {isSyncing ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.syncBtnText}>↻ Sync Now</Text>
                )}
              </TouchableOpacity>

              <HourPicker selected={hours} onChange={setHours} />
            </View>

            {/* Count label */}
            <Text style={styles.countLabel}>{`${count} reading${count === 1 ? '' : 's'} · last ${HOUR_OPTIONS.find((o) => o.value === hours)?.label ?? `${hours}h`}`}</Text>
          </>
        }
        ListEmptyComponent={
          !readingsLoading ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No readings in this period.</Text>
              <Text style={styles.emptyHint}>
                Try a longer range or tap Sync Now to pull new data.
              </Text>
            </View>
          ) : null
        }
      />
    </View>
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
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  listContent: {
    paddingBottom: 40,
  },

  // ── Hero card ──────────────────────────────────────────────────────────
  heroCard: {
    margin: 16,
    padding: 20,
    backgroundColor: colors.card ?? '#1a1d27',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: colors.text?.secondary ?? '#94a3b8',
    textTransform: 'uppercase',
  },
  heroSync: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#94a3b8',
    marginTop: 2,
  },
  sensorBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(59,130,246,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.30)',
  },
  sensorBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    color: '#3b82f6',
  },
  heroValueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 6,
  },
  heroValue: {
    fontSize: 56,
    fontWeight: '700',
    lineHeight: 60,
  },
  heroValueMeta: {
    paddingBottom: 8,
    gap: 2,
  },
  heroUnit: {
    fontSize: 14,
    color: colors.text?.secondary ?? '#94a3b8',
  },
  heroArrow: {
    fontSize: 22,
    fontWeight: '700',
  },
  heroTime: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
  },
  heroNoReading: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
    textAlign: 'center',
    paddingVertical: 8,
  },
  heroSyncHint: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'center',
  },

  // ── Auto-sync card ─────────────────────────────────────────────────────
  autoSyncCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    backgroundColor: colors.card ?? '#1a1d27',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
  },
  autoSyncHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  autoSyncTitleWrap: {
    flex: 1,
    marginRight: 12,
  },
  autoSyncTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 2,
  },
  autoSyncSubtitle: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 17,
  },
  autoSyncToggleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  autoSyncStatus: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    marginBottom: 12,
  },
  autoSyncStatusOn: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.30)',
  },
  autoSyncStatusOff: {
    backgroundColor: 'rgba(148,163,184,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.15)',
  },
  autoSyncStatusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  autoSyncStatusTextOn: {
    color: '#22c55e',
  },
  autoSyncStatusTextOff: {
    color: colors.text?.secondary ?? '#94a3b8',
  },
  intervalWrap: {
    borderTopWidth: 1,
    borderTopColor: colors.border ?? '#2a2d3a',
    paddingTop: 12,
  },
  intervalLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  intervalRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  intervalChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
  },
  intervalChipActive: {
    backgroundColor: (colors.primary ?? '#6366f1') + '22',
    borderColor: colors.primary ?? '#6366f1',
  },
  intervalChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text?.secondary ?? '#94a3b8',
  },
  intervalChipTextActive: {
    color: colors.primary ?? '#6366f1',
    fontWeight: '700',
  },
  intervalHint: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#64748b',
    lineHeight: 16,
  },

  // ── Banners ────────────────────────────────────────────────────────────
  syncBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  syncBannerSuccess: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.25)',
  },
  syncBannerIdle: {
    backgroundColor: 'rgba(148,163,184,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.15)',
  },
  syncBannerText: {
    fontSize: 13,
    color: colors.text?.primary ?? '#f1f5f9',
  },
  errorBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
  },
  errorBannerText: {
    fontSize: 13,
    color: '#ef4444',
  },

  // ── Controls row ───────────────────────────────────────────────────────
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 4,
  },
  syncBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.primary,
    minWidth: 90,
    alignItems: 'center',
  },
  syncBtnDisabled: {
    opacity: 0.5,
  },
  syncBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },

  // ── Hour picker ────────────────────────────────────────────────────────
  hourPicker: {
    flexDirection: 'row',
    gap: 6,
    flex: 1,
  },
  hourChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: colors.card ?? '#1a1d27',
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
  },
  hourChipActive: {
    backgroundColor: colors.primary + '22',
    borderColor: colors.primary,
  },
  hourChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.text?.secondary ?? '#94a3b8',
  },
  hourChipTextActive: {
    color: colors.primary,
    fontWeight: '700',
  },

  // ── Count label ────────────────────────────────────────────────────────
  countLabel: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 4,
  },

  // ── Day section header ─────────────────────────────────────────────────
  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border ?? '#1e2130',
  },
  dayLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
  },
  dayCount: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
  },

  // ── Reading row ────────────────────────────────────────────────────────
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border ?? '#1e2130',
    gap: 10,
  },
  rowTime: {
    width: 48,
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    fontVariant: ['tabular-nums'],
  },
  rowValueWrap: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
    flex: 1,
  },
  rowValue: {
    fontSize: 20,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  rowUnit: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#94a3b8',
  },
  rowArrow: {
    fontSize: 18,
    fontWeight: '700',
    width: 24,
    textAlign: 'center',
  },
  statusPill: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(148,163,184,0.10)',
  },
  typeBadgeText: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
    letterSpacing: 0.3,
  },

  // ── Empty ──────────────────────────────────────────────────────────────
  emptyWrap: {
    paddingTop: 48,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 6,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'center',
  },

  // ── Not connected ──────────────────────────────────────────────────────
  notConnectedWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  notConnectedIcon: {
    fontSize: 52,
    marginBottom: 4,
  },
  notConnectedTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
  },
  notConnectedBody: {
    fontSize: 14,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'center',
    lineHeight: 20,
  },
  connectBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  connectBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
});