/**
 * Blood Glucose Logging Screen
 * Location: mobile/app/(app)/log/glucose.tsx
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, Alert, TouchableOpacity, Text, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import UnifiedBloodSugarInput, { type BloodSugarData } from '@/components/forms/UnifiedBloodSugarInput';

// Services
import { createReading } from '@/services/api/glucose';

// Constants
import { colors, spacing, borderRadius, typography } from '@/constants/theme';

export default function GlucoseScreen() {
  const router = useRouter();
  const [bloodSugarData, setBloodSugarData] = useState<BloodSugarData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (data: BloodSugarData) => {
    setBloodSugarData(data);
  };

  const handleSubmit = async () => {
    if (!bloodSugarData?.value || parseFloat(bloodSugarData.value) <= 0) {
      Platform.OS === 'web' ? alert('Please enter a blood sugar reading.') : Alert.alert('Missing Value', 'Please enter a blood sugar reading.');
      return;
    }

    setIsSubmitting(true);
    try {
      await createReading({
        bloodSugar: parseFloat(bloodSugarData.value),
        bloodSugarTimestamp: bloodSugarData.timestamp,
        notes: '',
        bloodSugarSource: 'standalone',
      });

      if (Platform.OS === 'web') {
        alert('Blood sugar reading saved!');
        router.replace('/(app)/(tabs)');
      } else {
        Alert.alert('Success', 'Blood sugar reading saved!', [
          { text: 'OK', onPress: () => router.replace('/(app)/(tabs)') },
        ]);
      }
    } catch (error) {
      let errorMessage = 'Failed to save reading. Please try again.';
      if (error instanceof Error) errorMessage += `\n\nDetails: ${error.message}`;
      Platform.OS === 'web' ? alert(`Error: ${errorMessage}`) : Alert.alert('Error', errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = !!bloodSugarData?.value && parseFloat(bloodSugarData.value) > 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <UnifiedBloodSugarInput
          onChange={handleChange}
          standalone={true}
          showTimestampSelector={true}
          showUnitSelector={true}
          showStatusIndicator={true}
          showReferenceRanges={true}
        />

        <View style={styles.buttons}>
          <TouchableOpacity style={styles.cancelButton} onPress={() => router.replace('/(app)/(tabs)')} disabled={isSubmitting}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.submitButton, (!isValid || isSubmitting) && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitButtonText}>Save Reading</Text>
            }
          </TouchableOpacity>
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
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    alignItems: 'center',
  },
  cancelButtonText: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  submitButton: {
    flex: 2,
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
});