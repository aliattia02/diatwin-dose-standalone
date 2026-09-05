/**
 * Insulin Dose Logging Screen
 * Location: mobile/app/(app)/log/insulin.tsx
 *
 * The correction suggestion card, active-effects fetch, and buildSuggestion
 * logic all live inside UnifiedInsulinInput (shown only when standalone={true}).
 * This screen is now a thin shell that handles submission.
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Alert,
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Platform,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import UnifiedInsulinInput, { type InsulinData } from '@/components/forms/UnifiedInsulinInput';

// Services
import { logDose } from '@/services/api/insulin';

// Constants
import { colors, spacing, borderRadius, typography } from '@/constants/theme';

export default function InsulinScreen() {
  const router = useRouter();
  const [insulinData, setInsulinData]     = useState<InsulinData | null>(null);
  const [isSubmitting, setIsSubmitting]   = useState(false);
  const [showSuccess, setShowSuccess]     = useState(false);

  const handleChange = (data: InsulinData) => setInsulinData(data);

  const navigateHome = () => {
    setShowSuccess(false);
    router.replace('/(app)/(tabs)');
  };

  const handleSubmit = async () => {
    if (!insulinData?.medication || !insulinData?.dose || insulinData.dose <= 0) {
      if (Platform.OS === 'web') {
        alert('Please select an insulin type and enter a dose.');
      } else {
        Alert.alert('Missing Info', 'Please select an insulin type and enter a dose.');
      }
      return;
    }

    setIsSubmitting(true);
    try {
      await logDose({
        medication:   insulinData.medication,
        dose:         insulinData.dose,
        taken_at:     insulinData.timestamp,
        notes:        insulinData.notes,
        meal_type:    insulinData.mealType,
        blood_sugar:  insulinData.bloodSugar,
        is_insulin:   true,
      });

      // Show in-app success modal — works reliably on web and native alike,
      // unlike browser alert() which is blocked in many Expo web environments.
      if (Platform.OS !== 'web') {
        // On native keep the familiar Alert so the OS handles the dialog chrome
        Alert.alert('Success', 'Insulin dose logged!', [
          { text: 'OK', onPress: navigateHome },
        ]);
      } else {
        setShowSuccess(true);
      }
    } catch (error) {
      if (Platform.OS === 'web') {
        alert('Error: Failed to log dose. Please try again.');
      } else {
        Alert.alert('Error', 'Failed to log dose. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = !!insulinData?.medication && !!insulinData?.dose && insulinData.dose > 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Suggestion card + form — all managed inside UnifiedInsulinInput */}
        <UnifiedInsulinInput
          onChange={handleChange}
          standalone={true}
          showTimestampSelector={true}
          showSuggestion={false}
          showNotes={true}
        />

        <View style={styles.buttons}>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => router.replace('/(app)/(tabs)')}
            disabled={isSubmitting}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.submitButton, (!isValid || isSubmitting) && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitButtonText}>Log Dose</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* ── Web-safe success modal ── */}
      <Modal
        visible={showSuccess}
        transparent
        animationType="fade"
        onRequestClose={navigateHome}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalIcon}>✅</Text>
            <Text style={styles.modalTitle}>Dose Logged!</Text>
            <Text style={styles.modalMessage}>
              Your insulin dose has been recorded successfully.
            </Text>
            <TouchableOpacity style={styles.modalButton} onPress={navigateHome}>
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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

  // ── Success modal ──────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.surface ?? '#fff',
    borderRadius: borderRadius.lg ?? 16,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalIcon: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  modalTitle: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  modalMessage: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
    lineHeight: 22,
  },
  modalButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minWidth: 120,
    alignItems: 'center',
  },
  modalButtonText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '700',
  },
});