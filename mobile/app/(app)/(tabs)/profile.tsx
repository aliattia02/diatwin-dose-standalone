/**
 * Profile / Settings Tab Screen
 * Location: mobile/app/(app)/(tabs)/profile.tsx
 *
 * Renders two completely separate content sections based on user role:
 *   - Patient  → constants stats, BG charts, Libre widget, Watch widget,
 *                patient settings links
 *   - Doctor   → practice info, patient management links, account settings
 *
 * Shared sections (user card, support links, logout) are extracted into
 * helper components used by both branches.
 *
 * API-call safety:
 *   - usePatientConstants(!isDoctor)  → never hits /api/patient/constants for doctors
 *   - useBloodGlucoseEstimation only called when !isDoctor (hook rules respected via
 *     conditional `enabled` flag passed to the hook)
 *   - useLibreStatus only rendered inside <LibreLiveWidget> which is patient-only
 *   - getWatchStatus only rendered inside <WatchSyncWidget> which is patient-only
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Button, Loading } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { useBloodGlucoseEstimation } from '@/hooks/useBloodGlucoseEstimation';
import { useOffline } from '@/hooks/useOffline';
import { useLibreStatus } from '@/hooks/useLibre';
import {
  getReadingColor,
  getTrendArrow,
  getTrendColor,
  timeAgo,
} from '@/types/libre.types';
import { getWatchStatus } from '@/services/api/watch-sync';
import type { WatchConnectionStatus } from '@/types/watch.types';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SettingsLinkProps {
  title: string;
  subtitle?: string;
  icon: string;
  onPress: () => void;
}

const SettingsLink: React.FC<SettingsLinkProps> = ({ title, subtitle, icon, onPress }) => (
  <TouchableOpacity style={styles.settingsLink} onPress={onPress}>
    <Text style={styles.linkIcon}>{icon}</Text>
    <View style={styles.linkContent}>
      <Text style={styles.linkTitle}>{title}</Text>
      {subtitle && <Text style={styles.linkSubtitle}>{subtitle}</Text>}
    </View>
    <Text style={styles.linkArrow}>›</Text>
  </TouchableOpacity>
);

const showAlert = (
  title: string,
  message: string,
  buttons: { text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }[]
) => {
  if (Platform.OS === 'web') {
    const confirmed = window.confirm(`${title}\n\n${message}`);
    if (confirmed) {
      const confirmButton = buttons.find((b) => b.style !== 'cancel');
      confirmButton?.onPress?.();
    }
  } else {
    Alert.alert(title, message, buttons);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LibreLiveWidget — patient-only, renders only when a sensor is connected
// ─────────────────────────────────────────────────────────────────────────────

interface LibreLiveWidgetProps {
  onPress: () => void;
}

const LibreLiveWidget: React.FC<LibreLiveWidgetProps> = ({ onPress }) => {
  const { status, connected, isLoading } = useLibreStatus(true);

  if (isLoading || !connected || !status) return null;

  const reading = status.latest_reading;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}>
      <View style={styles.libreWidget}>
        <View style={styles.libreWidgetLeft}>
          <View style={styles.libreWidgetHeader}>
            <View style={styles.libreSensorDot} />
            <Text style={styles.libreSensorLabel}>LIBRE CGM</Text>
          </View>
          <Text style={styles.libreWidgetSub}>
            {status.last_sync
              ? `Synced ${timeAgo(status.last_sync)}`
              : 'Connected — tap to sync'}
          </Text>
        </View>

        {reading ? (
          <View style={styles.libreWidgetRight}>
            <Text
              style={[
                styles.libreWidgetValue,
                { color: getReadingColor(reading) },
              ]}
            >
              {reading.bloodSugar}
            </Text>
            <View style={styles.libreWidgetMeta}>
              <Text style={styles.libreWidgetUnit}>mg/dL</Text>
              <Text
                style={[
                  styles.libreWidgetArrow,
                  { color: getTrendColor(reading.trend) },
                ]}
              >
                {getTrendArrow(reading.trend)}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={styles.libreWidgetNoReading}>No reading</Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// WatchSyncWidget — patient-only, renders only when Google Fit is connected
// Mirrors LibreLiveWidget — shows last sync time + a pulsing "WATCH HR" badge.
// ─────────────────────────────────────────────────────────────────────────────

interface WatchSyncWidgetProps {
  onPress: () => void;
}

const WatchSyncWidget: React.FC<WatchSyncWidgetProps> = ({ onPress }) => {
  const [status, setStatus] = useState<WatchConnectionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWatchStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {});           // silently ignore — widget just won't render
    return () => { cancelled = true; };
  }, []);

  if (!status?.connected) return null;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}>
      <View style={styles.watchWidget}>
        <View style={styles.watchWidgetLeft}>
          <View style={styles.watchWidgetHeader}>
            <View style={styles.watchSensorDot} />
            <Text style={styles.watchSensorLabel}>WATCH HR</Text>
          </View>
          <Text style={styles.watchWidgetName}>
            {status.google_name ?? status.google_email ?? 'Google Fit'}
          </Text>
          <Text style={styles.watchWidgetSub}>
            {status.last_sync
              ? `Synced ${timeAgo(status.last_sync)}`
              : 'Connected — auto-sync active'}
          </Text>
        </View>

        <View style={styles.watchWidgetRight}>
          <Text style={styles.watchWidgetIcon}>⌚</Text>
          <Text style={styles.watchWidgetInterval}>
            {`Every ${status.sync_interval_minutes ?? 15} min`}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// UserInfoCard — shared between both roles
// ─────────────────────────────────────────────────────────────────────────────

interface UserInfoCardProps {
  firstName?: string;
  lastName?: string;
  userType?: string;
  isOnline: boolean;
  pendingCount: number;
}

const UserInfoCard: React.FC<UserInfoCardProps> = ({
  firstName,
  lastName,
  userType,
  isOnline,
  pendingCount,
}) => (
  <Card variant="elevated" padding="large" style={styles.userCard}>
    <View style={styles.avatarContainer}>
      <View style={[styles.avatar, userType === 'doctor' && styles.avatarDoctor]}>
        <Text style={styles.avatarText}>
          {firstName?.[0] || 'U'}
        </Text>
      </View>
    </View>
    <Text style={styles.userName}>
      {userType === 'doctor' ? 'Dr. ' : ''}
      {`${firstName ?? ''} ${lastName ?? ''}`.trim()}
    </Text>
    <Text style={styles.userType}>
      {userType === 'doctor' ? '👨‍⚕️ Healthcare Provider' : '🧑 Patient'}
    </Text>
    <View style={styles.statusRow}>
      <View
        style={[
          styles.statusBadge,
          { backgroundColor: isOnline ? colors.success + '20' : colors.warning + '20' },
        ]}
      >
        <View
          style={[
            styles.statusDot,
            { backgroundColor: isOnline ? colors.success : colors.warning },
          ]}
        />
        <Text
          style={[
            styles.statusText,
            { color: isOnline ? colors.success : colors.warning },
          ]}
        >
          {isOnline ? 'Online' : 'Offline'}
        </Text>
      </View>
      {pendingCount > 0 && (
        <View style={[styles.statusBadge, { backgroundColor: colors.warning + '20' }]}>
          <Text style={[styles.statusText, { color: colors.warning }]}>
            {`${pendingCount} pending sync`}
          </Text>
        </View>
      )}
    </View>
  </Card>
);

// ─────────────────────────────────────────────────────────────────────────────
// SupportLinksCard — shared between both roles
// ─────────────────────────────────────────────────────────────────────────────

const SupportLinksCard: React.FC = () => (
  <Card variant="outlined" padding="none" style={styles.linksCard}>
    <SettingsLink
      title="Help & Support"
      icon="❓"
      onPress={() =>
        showAlert('Help', 'Support documentation coming soon.', [{ text: 'OK' }])
      }
    />
    <View style={styles.linkDivider} />
    <SettingsLink
      title="Privacy Policy"
      icon="🔒"
      onPress={() =>
        showAlert('Privacy', 'Privacy policy coming soon.', [{ text: 'OK' }])
      }
    />
    <View style={styles.linkDivider} />
    <SettingsLink
      title="Terms of Service"
      icon="📄"
      onPress={() =>
        showAlert('Terms', 'Terms of service coming soon.', [{ text: 'OK' }])
      }
    />
  </Card>
);

// ─────────────────────────────────────────────────────────────────────────────
// PatientProfileContent — all patient-specific sections
// ─────────────────────────────────────────────────────────────────────────────

interface PatientProfileContentProps {
  constants: ReturnType<typeof usePatientConstants>['constants'];
  activeConditions: ReturnType<typeof usePatientConstants>['activeConditions'];
  activeMedications: ReturnType<typeof usePatientConstants>['activeMedications'];
  estimatedBG: ReturnType<typeof useBloodGlucoseEstimation>['estimatedBG'];
  stabilizationHours: ReturnType<typeof useBloodGlucoseEstimation>['stabilizationHours'];
  onViewCharts: () => void;
  onManageDoctors: () => void;
  onLibre: () => void;
  onWatch: () => void;
  router: ReturnType<typeof useRouter>;
}

const PatientProfileContent: React.FC<PatientProfileContentProps> = ({
  constants,
  activeConditions,
  activeMedications,
  estimatedBG,
  stabilizationHours,
  onViewCharts,
  onManageDoctors,
  onLibre,
  onWatch,
  router,
}) => (
  <>
    {/* Libre Live Widget — renders itself only when sensor is connected */}
    <LibreLiveWidget onPress={onLibre} />

    {/* Watch Sync Widget — renders itself only when Google Fit is connected */}
    <WatchSyncWidget onPress={onWatch} />

    {/* Quick Stats */}
    <Card variant="outlined" padding="medium" style={styles.statsCard}>
      <Text style={styles.sectionTitle}>My Settings</Text>
      <View style={styles.statsGrid}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{constants?.target_glucose ?? 100}</Text>
          <Text style={styles.statLabel}>Target (mg/dL)</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{`1:${constants?.insulin_to_carb_ratio ?? 10}`}</Text>
          <Text style={styles.statLabel}>I:C Ratio</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{constants?.correction_factor ?? 50}</Text>
          <Text style={styles.statLabel}>Correction</Text>
        </View>
      </View>
    </Card>

    {/* Charts Link Card */}
    <Card
      variant="outlined"
      padding="medium"
      style={styles.chartsLinkCard}
      onPress={onViewCharts}
    >
      <View style={styles.chartsLinkHeader}>
        <View style={styles.chartsLinkLeft}>
          <Text style={styles.chartsLinkIcon}>📈</Text>
          <View>
            <Text style={styles.chartsLinkTitle}>Blood Glucose Charts</Text>
            <Text style={styles.chartsLinkSubtitle}>
              {`View Baseline & Glycemic Response • ${stabilizationHours}h decay`}
            </Text>
          </View>
        </View>
        <Text style={styles.chartsLinkArrow}>›</Text>
      </View>
      {estimatedBG && (
        <View style={styles.baselinePreview}>
          <View style={styles.baselinePreviewRow}>
            <Text style={styles.baselinePreviewLabel}>Current Baseline:</Text>
            <Text
              style={[
                styles.baselinePreviewValue,
                {
                  color:
                    estimatedBG.value > (constants?.target_glucose ?? 100) * 1.3
                      ? colors.danger
                      : estimatedBG.value < (constants?.target_glucose ?? 100) * 0.7
                      ? colors.warning
                      : colors.success,
                },
              ]}
            >
              {`${estimatedBG.value} mg/dL`}
            </Text>
          </View>
          <Text style={styles.baselinePreviewSource}>
            {estimatedBG.source === 'actual'
              ? '✓ From current reading'
              : estimatedBG.source === 'estimated'
              ? `ℹ️ ${stabilizationHours}h decay`
              : estimatedBG.source === 'last_actual'
              ? '⚠️ From last reading'
              : estimatedBG.source === 'target'
              ? 'ℹ️ Target value'
              : ''}
          </Text>
        </View>
      )}
    </Card>

    {/* Patient Settings Links */}
    <Card variant="outlined" padding="none" style={styles.linksCard}>
      <SettingsLink
        title="Patient Constants"
        subtitle="Insulin ratios, correction factors"
        icon="⚙️"
        onPress={() => router.push('/(app)/settings/constants')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Medications"
        subtitle={`${activeMedications.length} active medication(s)`}
        icon="💊"
        onPress={() => router.push('/(app)/settings/medications')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Health Conditions"
        subtitle={`${activeConditions.length} active condition(s)`}
        icon="🏥"
        onPress={() => router.push('/(app)/settings/constants')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Manage My Doctors"
        subtitle="Authorize doctors to view your data"
        icon="👨‍⚕️"
        onPress={onManageDoctors}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="FreeStyle Libre CGM"
        subtitle="Connect sensor · view readings · sync"
        icon="📡"
        onPress={onLibre}
      />
      <View style={styles.linkDivider} />
      {/* ── NEW: Google Fit Watch HR ──────────────────────────────────── */}
      <SettingsLink
        title="Google Fit / Watch HR"
        subtitle="Auto-sync heart rate · activity sessions"
        icon="⌚"
        onPress={onWatch}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Export Data"
        subtitle="Download your health data (GDPR)"
        icon="📤"
        onPress={() => router.push('/(app)/settings/export')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="FHIR Export & Data Privacy"
        subtitle="FHIR R4 clinical export · GDPR Art. 17 erasure"
        icon="🏥"
        onPress={() => router.push('/(app)/settings/fhir-export')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Food Database"
        subtitle="Browse, search & manage food entries"
        icon="🍎"
        onPress={() => router.push('/(app)/settings/food-database')}
      />
    </Card>
  </>
);

// ─────────────────────────────────────────────────────────────────────────────
// DoctorProfileContent — doctor-specific patient management sections
// ─────────────────────────────────────────────────────────────────────────────

interface DoctorProfileContentProps {
  router: ReturnType<typeof useRouter>;
}

const DoctorProfileContent: React.FC<DoctorProfileContentProps> = ({ router }) => (
  <>
    {/* Practice Overview Card */}
    <Card variant="outlined" padding="medium" style={styles.statsCard}>
      <Text style={styles.sectionTitle}>Practice</Text>
      <View style={styles.doctorInfoRow}>
        <Text style={styles.doctorInfoIcon}>🏥</Text>
        <View>
          <Text style={styles.doctorInfoLabel}>Doctor Dashboard</Text>
          <Text style={styles.doctorInfoSub}>
            Manage your patients from the Patients tab
          </Text>
        </View>
      </View>
    </Card>

    {/* Patient Management Links */}
    <Card variant="outlined" padding="none" style={styles.linksCard}>
      <Text style={[styles.sectionTitle, styles.sectionTitlePadded]}>
        Patient Management
      </Text>

      <SettingsLink
        title="My Patients"
        subtitle="View and manage all assigned patients"
        icon="👥"
        onPress={() => router.push('/(app)/(tabs)/doctor-dashboard')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Patient Search"
        subtitle="Find a patient by name or ID"
        icon="🔍"
        onPress={() => router.push('/(app)/(tabs)/doctor-dashboard')}
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Pending Invitations"
        subtitle="Patients awaiting your acceptance"
        icon="📨"
        onPress={() =>
          showAlert(
            'Pending Invitations',
            'This feature is coming soon.',
            [{ text: 'OK' }]
          )
        }
      />
    </Card>

    {/* Account Settings Links */}
    <Card variant="outlined" padding="none" style={styles.linksCard}>
      <Text style={[styles.sectionTitle, styles.sectionTitlePadded]}>
        Account
      </Text>

      <SettingsLink
        title="Notification Preferences"
        subtitle="Alerts for patient activity"
        icon="🔔"
        onPress={() =>
          showAlert(
            'Notifications',
            'Notification settings coming soon.',
            [{ text: 'OK' }]
          )
        }
      />
      <View style={styles.linkDivider} />
      <SettingsLink
        title="Export Reports"
        subtitle="Download patient summary reports"
        icon="📤"
        onPress={() => router.push('/(app)/settings/export')}
      />
    </Card>
  </>
);

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { isOnline, pendingCount } = useOffline();

  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';

  // ── Patient-only hooks ────────────────────────────────────────────────────
  // Both hooks accept a boolean guard so they never fire API calls for doctors.
  // React's rules of hooks are satisfied — they are always called,
  // but with `enabled = false` they perform no network activity.
  const {
    constants,
    activeConditions,
    activeMedications,
    isLoading: constantsLoading,
  } = usePatientConstants(!isDoctor);

  const { estimatedBG, stabilizationHours } = useBloodGlucoseEstimation({
    targetGlucose: constants?.target_glucose ?? 100,
    stabilizationHours: 3,
    // Disable hook effects when this is a doctor session.
    // The hook must support an `enabled` option (same pattern as usePatientConstants).
    enabled: !isDoctor,
  });

  const handleLogout = () => {
    showAlert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  };

  const handleViewCharts    = () => router.push('/(app)/(tabs)/visualization');
  const handleManageDoctors = () => router.push('/(app)/settings/doctors');
  const handleLibre         = () => router.push('/(app)/settings/libre');
  const handleWatch         = () => router.push('/(app)/settings/watch');   // ← NEW

  // Show loading indicator only for patients waiting on constants
  if (!isDoctor && constantsLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <Loading text="Loading profile..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

        {/* ── Shared: User Info Card ───────────────────────────────────── */}
        <UserInfoCard
          firstName={user?.firstName}
          lastName={user?.lastName}
          userType={user?.user_type}
          isOnline={isOnline}
          pendingCount={pendingCount}
        />

        {/* ── Role-split content ───────────────────────────────────────── */}
        {isDoctor ? (
          <DoctorProfileContent router={router} />
        ) : (
          <PatientProfileContent
            constants={constants}
            activeConditions={activeConditions}
            activeMedications={activeMedications}
            estimatedBG={estimatedBG}
            stabilizationHours={stabilizationHours}
            onViewCharts={handleViewCharts}
            onManageDoctors={handleManageDoctors}
            onLibre={handleLibre}
            onWatch={handleWatch}
            router={router}
          />
        )}

        {/* ── Shared: Support Links ────────────────────────────────────── */}
        <SupportLinksCard />

        {/* ── Shared: Logout ───────────────────────────────────────────── */}
        <Button
          title="Sign Out"
          variant="outline"
          onPress={handleLogout}
          fullWidth
          style={styles.logoutButton}
        />

        <Text style={styles.version}>NATIVE v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },

  // ── User card ──────────────────────────────────────────────────────────
  userCard: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  avatarContainer: {
    marginBottom: spacing.md,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarDoctor: {
    backgroundColor: colors.secondary ?? colors.primary,
  },
  avatarText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: colors.text.inverse,
  },
  userName: {
    ...typography.h2,
    color: colors.text.primary,
  },
  userType: {
    ...typography.body,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  statusRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.full,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  statusText: {
    ...typography.small,
    fontWeight: '500',
  },

  // ── Libre live widget ──────────────────────────────────────────────────
  libreWidget: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.primary + '40',
    backgroundColor: colors.primary + '08',
  },
  libreWidgetLeft: {
    flex: 1,
  },
  libreWidgetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  libreSensorDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.success ?? '#22c55e',
  },
  libreSensorLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.primary,
  },
  libreWidgetSub: {
    ...typography.small,
    color: colors.text.secondary,
  },
  libreWidgetRight: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  libreWidgetValue: {
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 36,
  },
  libreWidgetMeta: {
    paddingBottom: 4,
    alignItems: 'flex-start',
    gap: 1,
  },
  libreWidgetUnit: {
    fontSize: 11,
    color: colors.text.secondary,
  },
  libreWidgetArrow: {
    fontSize: 16,
    fontWeight: '700',
  },
  libreWidgetNoReading: {
    ...typography.small,
    color: colors.text.secondary,
  },

  // ── Watch sync widget ──────────────────────────────────────────────────
  watchWidget: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: '#4285F4' + '40',     // Google blue tint
    backgroundColor: '#4285F4' + '08',
  },
  watchWidgetLeft: {
    flex: 1,
  },
  watchWidgetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  watchSensorDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#4285F4',
  },
  watchSensorLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: '#4285F4',
  },
  watchWidgetName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 1,
  },
  watchWidgetSub: {
    ...typography.small,
    color: colors.text.secondary,
  },
  watchWidgetRight: {
    alignItems: 'center',
    gap: 4,
  },
  watchWidgetIcon: {
    fontSize: 28,
  },
  watchWidgetInterval: {
    fontSize: 10,
    color: '#4285F4',
    fontWeight: '600',
  },

  // ── Stats / info cards ─────────────────────────────────────────────────
  statsCard: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  sectionTitlePadded: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    marginBottom: spacing.xs,
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    ...typography.h3,
    color: colors.primary,
  },
  statLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },

  // ── Doctor info row ────────────────────────────────────────────────────
  doctorInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  doctorInfoIcon: {
    fontSize: 28,
  },
  doctorInfoLabel: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
  },
  doctorInfoSub: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },

  // ── Charts link card ───────────────────────────────────────────────────
  chartsLinkCard: {
    marginBottom: spacing.md,
    borderColor: colors.primary,
    borderWidth: 2,
  },
  chartsLinkHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  chartsLinkLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  chartsLinkIcon: {
    fontSize: 32,
    marginRight: spacing.sm,
  },
  chartsLinkTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 16,
  },
  chartsLinkSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  chartsLinkArrow: {
    fontSize: 32,
    color: colors.primary,
    fontWeight: 'bold',
  },
  baselinePreview: {
    backgroundColor: colors.primary + '10',
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
  },
  baselinePreviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  baselinePreviewLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  baselinePreviewValue: {
    ...typography.body,
    fontWeight: 'bold',
    fontSize: 18,
  },
  baselinePreviewSource: {
    ...typography.caption,
    color: colors.text.secondary,
    fontStyle: 'italic',
  },

  // ── Settings links ─────────────────────────────────────────────────────
  linksCard: {
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  settingsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  linkIcon: {
    fontSize: 24,
    marginRight: spacing.md,
  },
  linkContent: {
    flex: 1,
  },
  linkTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '500',
  },
  linkSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
  },
  linkArrow: {
    fontSize: 24,
    color: colors.text.secondary,
  },
  linkDivider: {
    height: 1,
    backgroundColor: colors.divider,
    marginLeft: 56,
  },

  // ── Bottom ─────────────────────────────────────────────────────────────
  logoutButton: {
    marginTop: spacing.md,
    borderColor: colors.danger,
  },
  version: {
    ...typography.small,
    color: colors.text.disabled,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});