/**
 * Activity Logging Screen
 * Location: mobile/app/(app)/log/activity.tsx
 *
 * Main Function: ActivityScreen
 * Description: Screen for recording physical activities that affect insulin needs,
 *              supporting both expected (planned) and completed activities
 *
 * Features:
 * - Unified activity input component
 * - Real-time activity impact calculation
 * - Expected vs completed activity tracking
 * - Creates both activity records and meal timeline entries
 * - Activity impact summary display
 * - Notes and additional information support
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

// Components
import { Button, Loading } from '@/components/ui';
import UnifiedActivityInput, { UnifiedActivity } from '@/components/forms/UnifiedActivityInput';

// Hooks
import { usePatientConstants } from '@/hooks/usePatientConstants';

// Services
import { recordActivities, calculateDuration } from '@/services/api/activities';
import { createMeal } from '@/services/api/meals';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export default function ActivityScreen() {
  const router = useRouter();
  const { constants, loading: constantsLoading } = usePatientConstants();

  const [activities, setActivities] = useState<UnifiedActivity[]>([]);
  const [activityImpact, setActivityImpact] = useState(1.0);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleActivityUpdate = (newActivities: UnifiedActivity[], totalImpact: number) => {
    console.log('[ActivityScreen] Activities updated:', newActivities.length);
    setActivities(newActivities);
    setActivityImpact(totalImpact);
  };

  const handleSubmit = async () => {
    if (activities.length === 0) {
      Platform.OS === 'web' ? alert('Please add at least one activity') : Alert.alert('No Activities', 'Please add at least one activity');
      return;
    }

    setIsSubmitting(true);

    try {
      // Separate activities into expected and completed
      const expectedActivities = activities
        .filter(a => a.isExpected)
        .map(activity => ({
          level: activity.level,
          startTime: activity.startTime,
          endTime: activity.endTime,
          duration: activity.duration,
          type: 'expected' as const,
          impact: activity.impact,
          notes: activity.notes || notes
        }));

      const completedActivities = activities
        .filter(a => !a.isExpected)
        .map(activity => ({
          level: activity.level,
          startTime: activity.startTime,
          endTime: activity.endTime,
          duration: activity.duration,
          type: 'completed' as const,
          impact: activity.impact,
          notes: activity.notes || notes
        }));

      // STEP 1: Record activities in activities database
      console.log('📝 Recording activities...');
      const activityResponse = await recordActivities({
        expectedActivities,
        completedActivities,
        notes
      });

      console.log('✅ Activities recorded:', activityResponse.activity_ids);

      // STEP 2: Create meal record for timeline (ensures activities show in history)
      console.log('📝 Creating meal record for timeline...');

      // Convert all activities to the format expected by meal API
      const allActivitiesForMeal = activities.map(a => ({
        level: a.level,
        startTime: a.startTime,
        endTime: a.endTime,
        duration: a.duration,
        type: a.isExpected ? ('expected' as const) : ('completed' as const),
        impact: a.impact,
        notes: a.notes
      }));

      await createMeal({
        mealType: 'activity_only',
        mealTime: new Date().toISOString(),
        foodItems: [], // No food items for activity-only
        activities: allActivitiesForMeal,
        notes,
        // Pass the activity IDs so backend can link them
        activityIds: activityResponse.activity_ids
      });

      console.log('✅ Meal record created');

      if (Platform.OS === 'web') {
        alert('Activities recorded successfully!');
        setActivities([]);
        setNotes('');
        router.replace('/(app)/(tabs)');
      } else {
        Alert.alert(
          'Success',
          'Activities recorded successfully!',
          [
            {
              text: 'OK',
              onPress: () => {
                setActivities([]);
                setNotes('');
                router.replace('/(app)/(tabs)');
              }
            }
          ]
        );
      }
    } catch (error: any) {
      console.error('❌ Error submitting activities:', error);
      const errMsg = error?.response?.data?.error || 'Failed to record activities. Please try again.';
      Platform.OS === 'web' ? alert(`Error: ${errMsg}`) : Alert.alert('Error', errMsg, [{ text: 'OK' }]);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (constantsLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <Loading text="Loading activity settings..." />
      </SafeAreaView>
    );
  }

  const totalImpactText = activityImpact !== 1
    ? `${Math.abs((activityImpact - 1) * 100).toFixed(1)}% ${activityImpact > 1 ? 'increase' : 'decrease'}`
    : 'No overall impact';

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Record Activities</Text>
          <Text style={styles.subtitle}>
            Track physical activities that affect your insulin needs
          </Text>
        </View>

        {/* Activities Input - Using Unified Component */}
        <UnifiedActivityInput
          onActivityUpdate={handleActivityUpdate}
          initialActivities={activities}
          activityCoefficients={constants?.activity_coefficients || {}}
          standalone={true}
        />

        {/* Impact Summary */}
        {activities.length > 0 && (
          <View style={styles.impactCard}>
            <Text style={styles.impactTitle}>Total Activity Impact</Text>
            <Text style={[
              styles.impactValue,
              activityImpact > 1 ? styles.impactPositive :
              activityImpact < 1 ? styles.impactNegative : null
            ]}>
              {totalImpactText}
            </Text>
            <Text style={styles.impactDescription}>
              {activityImpact > 1
                ? 'These activities will increase your insulin needs'
                : activityImpact < 1
                ? 'These activities will decrease your insulin needs'
                : 'These activities will not change your insulin needs'}
            </Text>

            {/* Summary of expected vs completed */}
            <View style={styles.impactSummary}>
              <View style={styles.impactSummaryItem}>
                <Text style={styles.impactSummaryLabel}>Expected</Text>
                <Text style={styles.impactSummaryValue}>
                  {activities.filter(a => a.isExpected).length}
                </Text>
              </View>
              <View style={styles.impactSummaryDivider} />
              <View style={styles.impactSummaryItem}>
                <Text style={styles.impactSummaryLabel}>Completed</Text>
                <Text style={styles.impactSummaryValue}>
                  {activities.filter(a => !a.isExpected).length}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Notes Section */}
        <View style={styles.section}>
          <Text style={styles.label}>Notes (Optional)</Text>
          <Text style={styles.labelHelp}>
            Add general notes about your activities
          </Text>
          <TextInput
            style={styles.notesInput}
            value={notes}
            onChangeText={setNotes}
            placeholder="Add any notes about your activities..."
            placeholderTextColor={colors.text.secondary}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {/* Submit Button */}
        <Button
          title={isSubmitting ? 'Recording...' : 'Record Activities'}
          onPress={handleSubmit}
          disabled={isSubmitting || activities.length === 0}
          loading={isSubmitting}
          style={styles.submitButton}
        />

        {/* Info Card */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>💡 Tips</Text>
          <View style={styles.infoContent}>
            <Text style={styles.infoText}>
              • Mark activities as <Text style={styles.infoBold}>Expected</Text> if they're planned but not yet done
            </Text>
            <Text style={styles.infoText}>
              • Leave unchecked for activities you've already completed
            </Text>
            <Text style={styles.infoText}>
              • You can delete expected activities later if you don't do them
            </Text>
            <Text style={styles.infoText}>
              • Higher intensity activities have more impact on insulin needs
            </Text>
          </View>
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl * 2,
  },
  header: {
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.body,
    color: colors.text.secondary,
  },
  section: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  label: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  labelHelp: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  notesInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    minHeight: 100,
    color: colors.text.primary,
  },
  impactCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.primary + '30',
  },
  impactTitle: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  impactValue: {
    ...typography.h1,
    color: colors.primary,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  impactPositive: {
    color: colors.success,
  },
  impactNegative: {
    color: colors.danger,
  },
  impactDescription: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  impactSummary: {
    flexDirection: 'row',
    width: '100%',
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  impactSummaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  impactSummaryDivider: {
    width: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
  },
  impactSummaryLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  impactSummaryValue: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: '700',
  },
  submitButton: {
    marginBottom: spacing.lg,
  },
  infoCard: {
    backgroundColor: colors.primary + '10',
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary + '20',
  },
  infoTitle: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  infoContent: {
    gap: spacing.xs,
  },
  infoText: {
    ...typography.small,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  infoBold: {
    fontWeight: '600',
    color: colors.text.primary,
  },
});