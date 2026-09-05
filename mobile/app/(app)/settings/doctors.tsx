/**
 * Doctor Management Screen
 * Location: mobile/app/(app)/settings/doctors.tsx
 *
 * Main Function: DoctorManagementScreen
 * Description: Manage authorized doctors who can access patient health data with authorization/revocation
 *
 * Features:
 * - View all available doctors
 * - View currently authorized doctors
 * - Authorize new doctors to access health data
 * - Revoke doctor access
 * - Doctor search and filtering
 * - Summary statistics (authorized vs available)
 * - Cross-platform alert handling (web vs mobile)
 * - Privacy protection notices
 * - Pull-to-refresh functionality
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { DoctorList } from '@/components/doctor/DoctorList';
import { Card, Loading } from '@/components/ui';

// Services
import {
  getAllDoctors,
  getAuthorizedDoctors,
  authorizeDoctor,
  revokeDoctor,
  type Doctor,
  type AuthorizedDoctor,
} from '@/services/api/doctor-management';

// Constants
import { colors, spacing, typography } from '@/constants/theme';

// Cross-platform alert function
const showAlert = (
  title: string,
  message: string,
  buttons: { text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }[]
) => {
  if (Platform.OS === 'web') {
    const confirmed = window.confirm(`${title}\n\n${message}`);
    if (confirmed) {
      const confirmButton = buttons.find(b => b.style !== 'cancel');
      confirmButton?.onPress?.();
    }
  } else {
    Alert.alert(title, message, buttons);
  }
};

export default function DoctorManagementScreen() {
  const router = useRouter();
  const [allDoctors, setAllDoctors] = useState<Doctor[]>([]);
  const [authorizedDoctors, setAuthorizedDoctors] = useState<AuthorizedDoctor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDoctors = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const [available, authorized] = await Promise.all([
        getAllDoctors(),
        getAuthorizedDoctors(),
      ]);

      setAllDoctors(available);
      setAuthorizedDoctors(authorized);
    } catch (err: any) {
      console.error('Error loading doctors:', err);
      setError(err.message || 'Failed to load doctors');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  const handleAuthorize = async (doctorId: string) => {
    const doctor = allDoctors.find(d => d.id === doctorId);
    if (!doctor) return;

    showAlert(
      'Authorize Doctor',
      `Allow Dr. ${doctor.firstName} ${doctor.lastName} to view your health data?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Authorize',
          style: 'default',
          onPress: async () => {
            try {
              setIsProcessing(true);
              await authorizeDoctor(doctorId);
              await loadDoctors();
              showAlert('Success', 'Doctor authorized successfully', [{ text: 'OK' }]);
            } catch (err: any) {
              showAlert('Error', err.message || 'Failed to authorize doctor', [{ text: 'OK' }]);
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ]
    );
  };

  const handleRevoke = async (doctorId: string) => {
    const doctor = authorizedDoctors.find(d => d.id === doctorId);
    if (!doctor) return;

    showAlert(
      'Revoke Access',
      `Remove Dr. ${doctor.firstName} ${doctor.lastName}'s access to your health data?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              setIsProcessing(true);
              await revokeDoctor(doctorId);
              await loadDoctors();
              showAlert('Success', 'Doctor access revoked', [{ text: 'OK' }]);
            } catch (err: any) {
              showAlert('Error', err.message || 'Failed to revoke access', [{ text: 'OK' }]);
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ]
    );
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <Stack.Screen
          options={{
            title: 'Manage Doctors',
            headerShown: true,
          }}
        />
        <Loading text="Loading doctors..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Manage Doctors',
          headerShown: true,
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Info Card */}
        <Card variant="filled" padding="medium" style={styles.infoCard}>
          <Text style={styles.infoTitle}>🏥 Doctor Authorization</Text>
          <Text style={styles.infoText}>
            Select which doctors can view your health data. Only authorized doctors will have
            access to your glucose readings, meals, and insulin data.
          </Text>
        </Card>

        {error && (
          <Card variant="outlined" padding="medium" style={styles.errorCard}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </Card>
        )}

        {/* Authorized Doctors Summary */}
        <Card variant="outlined" padding="medium" style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <View>
              <Text style={styles.summaryLabel}>Authorized Doctors</Text>
              <Text style={styles.summaryValue}>{authorizedDoctors.length}</Text>
            </View>
            <View>
              <Text style={styles.summaryLabel}>Available Doctors</Text>
              <Text style={styles.summaryValue}>{allDoctors.length}</Text>
            </View>
          </View>
        </Card>

        {/* Authorized Doctors Section */}
        {authorizedDoctors.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Your Authorized Doctors</Text>
            <Text style={styles.sectionSubtitle}>
              These doctors can currently view your health data
            </Text>
            <DoctorList
              doctors={authorizedDoctors}
              authorizedDoctorIds={authorizedDoctors.map(d => d.id)}
              onAuthorize={handleAuthorize}
              onRevoke={handleRevoke}
              isLoading={isProcessing}
            />
          </View>
        )}

        {/* Available Doctors Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {authorizedDoctors.length > 0 ? 'Add More Doctors' : 'Available Doctors'}
          </Text>
          <Text style={styles.sectionSubtitle}>
            Search and authorize doctors to view your data
          </Text>
          <DoctorList
            doctors={allDoctors.filter(
              d => !authorizedDoctors.find(ad => ad.id === d.id)
            )}
            authorizedDoctorIds={[]}
            onAuthorize={handleAuthorize}
            onRevoke={handleRevoke}
            isLoading={isProcessing}
          />
        </View>

        {/* Privacy Notice */}
        <Card variant="filled" padding="small" style={styles.privacyCard}>
          <Text style={styles.privacyText}>
            🔒 Your privacy is protected. You can revoke access at any time.
          </Text>
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
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  infoCard: {
    marginBottom: spacing.md,
  },
  infoTitle: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  infoText: {
    ...typography.small,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  errorCard: {
    marginBottom: spacing.md,
    borderColor: colors.danger,
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
  },
  summaryCard: {
    marginBottom: spacing.lg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  summaryLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  summaryValue: {
    ...typography.h2,
    color: colors.primary,
    textAlign: 'center',
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  sectionSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  privacyCard: {
    marginTop: spacing.md,
  },
  privacyText: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
  },
});