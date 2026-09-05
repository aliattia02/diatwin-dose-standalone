/**
 * Medications Settings Screen
 * Location: mobile/app/(app)/settings/medications.tsx
 *
 * Main Function: MedicationsScreen
 * Description: Display active medications and available insulin types with pharmacokinetic profiles
 *
 * Features:
 * - Active medications list with profiles
 * - Insulin type categorization (rapid, short, intermediate, long-acting)
 * - Pharmacokinetic details (onset, peak, duration)
 * - Medication schedules display
 * - All available insulin types based on German S3 Guidelines
 * - Visual type badges (rapid vs long-acting colors)
 * - Read-only view (changes via healthcare provider)
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Card, Button } from '@/components/ui';

// Hooks
import { usePatientConstants } from '@/hooks/usePatientConstants';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { ALL_INSULIN_PROFILES } from '@/constants';

export default function MedicationsScreen() {
  const { activeMedications, medicationSchedules } = usePatientConstants();

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Active Medications */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Active Medications</Text>
          {activeMedications.length === 0 ? (
            <Text style={styles.emptyText}>No active medications</Text>
          ) : (
            activeMedications.map((medication) => {
              const profile = ALL_INSULIN_PROFILES.find((p) => p.id === medication);
              const schedule = medicationSchedules[medication];

              return (
                <View key={medication} style={styles.medicationCard}>
                  <View style={styles.medicationHeader}>
                    <Text style={styles.medicationName}>
                      {profile?.name || medication.replace(/_/g, ' ')}
                    </Text>
                    <View style={[
                      styles.typeBadge,
                      { backgroundColor: profile?.type === 'rapid_acting' ? colors.insulin.rapid + '20' : colors.insulin.long + '20' }
                    ]}>
                      <Text style={[
                        styles.typeText,
                        { color: profile?.type === 'rapid_acting' ? colors.insulin.rapid : colors.insulin.long }
                      ]}>
                        {profile?.type?.replace(/_/g, ' ') || 'Unknown type'}
                      </Text>
                    </View>
                  </View>

                  {profile && (
                    <View style={styles.pharmacokinetics}>
                      <Text style={styles.pkItem}>
                        Onset: {profile.onset_hours}h
                      </Text>
                      <Text style={styles.pkItem}>
                        Peak: {profile.peak_hours || 'N/A'}h
                      </Text>
                      <Text style={styles.pkItem}>
                        Duration: {profile.duration_hours}h
                      </Text>
                    </View>
                  )}

                  {schedule && (
                    <View style={styles.scheduleInfo}>
                      <Text style={styles.scheduleLabel}>Schedule</Text>
                      <Text style={styles.scheduleText}>
                        {schedule.dailyTimes.join(', ')}
                      </Text>
                      <Text style={styles.scheduleDates}>
                        {new Date(schedule.startDate).toLocaleDateString()} - {new Date(schedule.endDate).toLocaleDateString()}
                      </Text>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </Card>

        {/* Available Insulin Types */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Available Insulin Types</Text>
          <Text style={styles.helperText}>
            Based on German S3 Guidelines for Diabetes Management
          </Text>

          {['rapid_acting', 'short_acting', 'intermediate_acting', 'long_acting'].map((type) => {
            const insulins = ALL_INSULIN_PROFILES.filter((p) => p.type === type);
            if (insulins.length === 0) return null;

            return (
              <View key={type} style={styles.insulinCategory}>
                <Text style={styles.categoryTitle}>
                  {type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Text>
                {insulins.map((insulin) => (
                  <View key={insulin.id} style={styles.insulinItem}>
                    <Text style={styles.insulinName}>{insulin.name}</Text>
                    <Text style={styles.insulinDetails}>
                      {insulin.onset_hours}h → {insulin.peak_hours || '-'}h → {insulin.duration_hours}h
                    </Text>
                  </View>
                ))}
              </View>
            );
          })}
        </Card>

        <Text style={styles.disclaimer}>
          Note: Medication changes must be made by your healthcare provider.
        </Text>
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
  section: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  helperText: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  emptyText: {
    ...typography.body,
    color: colors.text.secondary,
    fontStyle: 'italic',
  },
  medicationCard: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  medicationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  medicationName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    flex: 1,
  },
  typeBadge: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  typeText: {
    ...typography.small,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  pharmacokinetics: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  pkItem: {
    ...typography.small,
    color: colors.text.secondary,
  },
  scheduleInfo: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
  },
  scheduleLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '500',
  },
  scheduleText: {
    ...typography.body,
    color: colors.text.primary,
  },
  scheduleDates: {
    ...typography.small,
    color: colors.text.secondary,
  },
  insulinCategory: {
    marginBottom: spacing.md,
  },
  categoryTitle: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  insulinItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    marginBottom: 2,
  },
  insulinName: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  insulinDetails: {
    ...typography.small,
    color: colors.text.secondary,
  },
  disclaimer: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.md,
    fontStyle: 'italic',
  },
});