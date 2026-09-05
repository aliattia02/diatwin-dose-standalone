/**
 * Doctor Dashboard Screen
 * Shows patient list and patient data for doctors
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, RefreshControl, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '@/constants/theme';
import { useAuthStore } from '@/store/auth.store';
import { PatientList, PatientDataView } from '@/components/doctor';
import { getPatients, type DoctorPatient } from '@/services/api/doctor';

export default function DoctorDashboardScreen() {
  const { user } = useAuthStore();
  const [patients, setPatients] = useState<DoctorPatient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<DoctorPatient | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadPatients = useCallback(async () => {
    try {
      setError(null);
      const data = await getPatients();
      setPatients(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load patients';
      setError(message);
      console.error('Error loading patients:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPatients();
  }, [loadPatients]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPatients();
    setRefreshing(false);
  }, [loadPatients]);

  const handleSelectPatient = (patient: DoctorPatient) => {
    setSelectedPatient(patient);
  };

  const handleBack = () => {
    setSelectedPatient(null);
  };

  const greeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  // If a patient is selected, show their data
  if (selectedPatient) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <PatientDataView patient={selectedPatient} onBack={handleBack} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
          />
        }
      >
        {/* Welcome Section */}
        <View style={styles.welcomeSection}>
          <Text style={styles.greeting}>{greeting()}</Text>
          <Text style={styles.userName}>Dr. {user?.firstName || 'Doctor'}</Text>
          <Text style={styles.roleTag}>👨‍⚕️ Doctor Dashboard</Text>
        </View>

        {/* Error Display */}
        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {/* Patient List */}
        <View style={styles.patientListContainer}>
          <PatientList
            patients={patients}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
            isLoading={isLoading}
          />
        </View>
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
  welcomeSection: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  greeting: {
    ...typography.body,
    color: colors.text.secondary,
  },
  userName: {
    ...typography.h1,
    color: colors.text.primary,
  },
  roleTag: {
    ...typography.caption,
    color: colors.primary,
    marginTop: spacing.xs,
  },
  errorContainer: {
    margin: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.danger + '10',
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
  },
  patientListContainer: {
    flex: 1,
    minHeight: 400,
  },
});