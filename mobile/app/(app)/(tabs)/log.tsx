/**
 * Quick Log Tab Screen
 * Location: mobile/app/(app)/(tabs)/log.tsx
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// Unified form components
import UnifiedBloodSugarInput, { type BloodSugarData } from '@/components/forms/UnifiedBloodSugarInput';
import UnifiedInsulinInput, { type InsulinData } from '@/components/forms/UnifiedInsulinInput';
import UnifiedActivityInput, { type UnifiedActivity } from '@/components/forms/UnifiedActivityInput';
import MealForm, { type MealFormData, type MealCalculationResult } from '@/components/forms/MealForm';

// Hooks
import { usePatientConstants } from '@/hooks/usePatientConstants';

// API services
import { createReading as createGlucose } from '@/services/api/glucose';
import { logDose as logInsulin } from '@/services/api/insulin';
import { calculateMeal, createMeal } from '@/services/api/meals';

type LogType = 'glucose' | 'insulin' | 'meal' | 'activity';

const LOG_TYPES: { id: LogType; label: string; icon: string }[] = [
  { id: 'glucose',  label: 'Blood Sugar', icon: '🩸' },
  { id: 'insulin',  label: 'Insulin',     icon: '💉' },
  { id: 'meal',     label: 'Meal',        icon: '🍽️' },
  { id: 'activity', label: 'Activity',    icon: '🏃' },
];

export default function QuickLogScreen() {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<LogType>('meal');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { constants } = usePatientConstants();

  // Glucose state
  const [bloodSugarData, setBloodSugarData] = useState<BloodSugarData | null>(null);

  // Insulin state
  const [insulinData, setInsulinData] = useState<InsulinData | null>(null);

  // Activity state
  const [activities, setActivities] = useState<UnifiedActivity[]>([]);
  const [activityImpact, setActivityImpact] = useState(1.0);

  // ── Glucose ────────────────────────────────────────────────────────────────

  const handleGlucoseSubmit = async () => {
    if (!bloodSugarData?.value || parseFloat(bloodSugarData.value) <= 0) {
      Alert.alert('Missing Value', 'Please enter a blood sugar reading.');
      return;
    }
    setIsSubmitting(true);
    try {
      await createGlucose({
        bloodSugar: parseFloat(bloodSugarData.value),
        bloodSugarTimestamp: bloodSugarData.timestamp,
        notes: '',
        bloodSugarSource: 'standalone',
      });
      Alert.alert('Success', 'Blood sugar reading saved!');
      setBloodSugarData(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to save reading.';
      Alert.alert('Error', msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Insulin ────────────────────────────────────────────────────────────────

  const handleInsulinSubmit = async () => {
    if (!insulinData?.medication || !insulinData?.dose || insulinData.dose <= 0) {
      Alert.alert('Missing Info', 'Please select an insulin type and enter a dose.');
      return;
    }
    setIsSubmitting(true);
    try {
      await logInsulin({
        medication: insulinData.medication,
        dose: insulinData.dose,
        taken_at: insulinData.timestamp,
        notes: insulinData.notes,
        meal_type: insulinData.mealType,
        blood_sugar: insulinData.bloodSugar,
        is_insulin: true,
      });
      Alert.alert('Success', `${insulinData.dose} units of ${insulinData.medication} logged!`);
      setInsulinData(null);
    } catch (error) {
      Alert.alert('Error', 'Failed to log insulin dose. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Activity ───────────────────────────────────────────────────────────────

  const handleActivitySubmit = async () => {
    if (activities.length === 0) {
      Alert.alert('No Activities', 'Please add at least one activity.');
      return;
    }
    setIsSubmitting(true);
    try {
      const { recordActivities } = await import('@/services/api/activities');
      const expectedActivities = activities.filter(a => a.isExpected).map(a => ({
        level: a.level, startTime: a.startTime, endTime: a.endTime,
        duration: a.duration, type: 'expected' as const, impact: a.impact, notes: a.notes,
      }));
      const completedActivities = activities.filter(a => !a.isExpected).map(a => ({
        level: a.level, startTime: a.startTime, endTime: a.endTime,
        duration: a.duration, type: 'completed' as const, impact: a.impact, notes: a.notes,
      }));
      await recordActivities({ expectedActivities, completedActivities, notes: '' });
      Alert.alert('Success', 'Activities recorded!');
      setActivities([]);
      setActivityImpact(1.0);
    } catch (error) {
      Alert.alert('Error', 'Failed to record activities. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Meal ──────────────────────────────────────────────────────────────────

  const handleMealCalculate = async (data: Partial<MealFormData>): Promise<MealCalculationResult> => {
    return await calculateMeal({
      mealType: data.mealType!,
      selectedFoods: data.selectedFoods,
      bloodSugar: data.bloodSugar,
      activities: data.activities,
    });
  };

  const handleMealSubmit = async (data: MealFormData): Promise<void> => {
    setIsSubmitting(true);
    try {
      await createMeal({
        mealType:            data.mealType,
        mealTime:            data.mealTime,
        selectedFoods:       data.selectedFoods,
        bloodSugar:          data.bloodSugar,
        bloodSugarTimestamp: data.bloodSugarTimestamp,
        activities:          data.activities,
        intendedInsulin:     data.intendedInsulin,
        intendedInsulinType: data.intendedInsulinType,
        insulinTimestamp:    data.insulinTimestamp,
        notes:               data.notes,
      });
      // ✅ MealForm handles the success alert, form reset, and navigation.
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to log meal.';
      // ✅ Re-throw so MealForm's catch block can display the error to the user.
      throw new Error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Render form by type ────────────────────────────────────────────────────

  const renderForm = () => {
    switch (selectedType) {

      case 'glucose': {
        const isValid = !!bloodSugarData?.value && parseFloat(bloodSugarData.value) > 0;
        return (
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <UnifiedBloodSugarInput
              onChange={setBloodSugarData}
              standalone={true}
              showTimestampSelector={true}
              showUnitSelector={true}
              showStatusIndicator={true}
              showReferenceRanges={true}
            />
            <View style={styles.buttons}>
              <TouchableOpacity style={styles.submitButton} onPress={handleGlucoseSubmit} disabled={!isValid || isSubmitting}>
                <View style={[styles.submitButtonInner, (!isValid || isSubmitting) && styles.submitButtonDisabled]}>
                  {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Save Reading</Text>}
                </View>
              </TouchableOpacity>
            </View>
          </ScrollView>
        );
      }

      case 'insulin': {
        const isValid = !!insulinData?.medication && !!insulinData?.dose && insulinData.dose > 0;
        return (
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <UnifiedInsulinInput
              onChange={setInsulinData}
              standalone={true}
              showTimestampSelector={true}
              showSuggestion={false}
              showNotes={true}
            />
            <View style={styles.buttons}>
              <TouchableOpacity style={styles.submitButton} onPress={handleInsulinSubmit} disabled={!isValid || isSubmitting}>
                <View style={[styles.submitButtonInner, (!isValid || isSubmitting) && styles.submitButtonDisabled]}>
                  {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Log Dose</Text>}
                </View>
              </TouchableOpacity>
            </View>
          </ScrollView>
        );
      }

      case 'meal':
        return (
          <View style={styles.mealWrapper}>
            <MealForm
              onSubmit={handleMealSubmit}
              onCalculate={handleMealCalculate}
              onCancel={() => router.replace('/(app)/(tabs)')}
              isLoading={isSubmitting}
            />
          </View>
        );

      case 'activity':
        return (
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <UnifiedActivityInput
              onActivityUpdate={(newActivities, totalImpact) => {
                setActivities(newActivities);
                setActivityImpact(totalImpact);
              }}
              initialActivities={activities}
              activityCoefficients={constants?.activity_coefficients || {}}
              standalone={true}
            />
            <View style={styles.buttons}>
              <TouchableOpacity onPress={handleActivitySubmit} disabled={activities.length === 0 || isSubmitting}>
                <View style={[styles.submitButtonInner, (activities.length === 0 || isSubmitting) && styles.submitButtonDisabled]}>
                  {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Record Activities</Text>}
                </View>
              </TouchableOpacity>
            </View>
          </ScrollView>
        );
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <View style={styles.container}>

        {/* Type Selector */}
        <View style={styles.typeSelector}>
          {LOG_TYPES.map((type) => (
            <TouchableOpacity
              key={type.id}
              style={[styles.typeButton, selectedType === type.id && styles.typeButtonActive]}
              onPress={() => setSelectedType(type.id)}
            >
              <Text style={styles.typeIcon}>{type.icon}</Text>
              <Text style={[styles.typeLabel, selectedType === type.id && styles.typeLabelActive]}>
                {type.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Form Area */}
        <View style={styles.formWrapper}>
          {renderForm()}
        </View>

      </View>
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
  typeSelector: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  typeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: borderRadius.md,
    marginHorizontal: 2,
  },
  typeButtonActive: {
    backgroundColor: colors.primary + '15',
  },
  typeIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  typeLabel: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  typeLabelActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  formWrapper: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl * 2,
  },
  buttons: {
    marginTop: spacing.sm,
  },
  submitButton: {
    width: '100%',
  },
  submitButtonInner: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  mealWrapper: {
    flex: 1,
  },
});