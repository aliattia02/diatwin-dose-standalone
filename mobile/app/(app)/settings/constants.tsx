/**
 * Patient Constants Settings Screen
 * Location: mobile/app/(app)/settings/constants.tsx
 *
 * Main Function: ConstantsScreen
 * Description: Display patient-specific diabetes management constants including insulin ratios,
 *              activity coefficients, absorption modifiers, and active conditions/medications
 *
 * Features:
 * - Core settings display (target glucose, insulin ratios, correction factors)
 * - Activity coefficients for different activity levels
 * - Absorption modifiers for food types
 * - Meal timing factors
 * - Active health conditions list
 * - Active medications display
 * - Read-only view (changes via healthcare provider)
 * - Loading state management
 */

import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Card } from '@/components/ui';

// Hooks
import { usePatientConstants } from '@/hooks/usePatientConstants';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import {
  BASELINE_MODES,
  DEFAULT_CIRCADIAN_PROFILE,
  type BaselineMode,
  type CircadianAnchor,
} from '@/constants/shared-constants';
import apiClient from '@/services/api/client';

export default function ConstantsScreen() {
  const { constants, activeConditions, activeMedications, isLoading, refresh } = usePatientConstants();

  // 🆕 v4.3: Baseline mode toggle state — initialised from constants once loaded
  const [selectedMode, setSelectedMode] = useState<BaselineMode | null>(null);
  const [modeUpdating, setModeUpdating] = useState(false);

  // Resolved mode: prefer local selection once set, else fall back to what the
  // server returned, then default to 'dynamic'.
  const activeMode = (selectedMode ?? constants?.baseline_mode ?? 'dynamic') as BaselineMode;

  const handleModeSelect = useCallback(async (mode: BaselineMode) => {
    if (mode === activeMode || modeUpdating) return;
    setModeUpdating(true);
    // Optimistically update local UI immediately so the toggle feels instant.
    setSelectedMode(mode);
    try {
      await apiClient.patch('/api/patient/constants', { baseline_mode: mode });
      // Force-refresh the Zustand patient store so every screen that reads
      // constants (useActiveEffects, useBloodGlucoseEstimation, etc.) sees the
      // new baseline_mode immediately — without waiting for the 5-minute TTL
      // or an app foreground event.
      await refresh();
    } catch (err) {
      // Roll back the optimistic update so the toggle reflects reality
      setSelectedMode(null);
      Alert.alert(
        'Update Failed',
        'Could not save baseline mode. Please try again.',
        [{ text: 'OK' }]
      );
    } finally {
      setModeUpdating(false);
    }
  }, [activeMode, modeUpdating, refresh]);

  // ── Circadian profile chart data ────────────────────────────────────────────
  // Use the patient's stored profile if available, else the shared default.
  const anchors: CircadianAnchor[] = useMemo(() => {
    const stored = (constants as any)?.circadian_profile?.anchors;
    return (stored && stored.length === 24)
      ? stored
      : DEFAULT_CIRCADIAN_PROFILE.anchors;
  }, [constants]);

  const { minBG, maxBG, bgRange } = useMemo(() => {
    const values = anchors.map(a => a.value);
    const minBG  = Math.min(...values);
    const maxBG  = Math.max(...values);
    return { minBG, maxBG, bgRange: maxBG - minBG || 1 };
  }, [anchors]);

  // Named landmarks to call out below the chart
  const landmarks = useMemo(() => [
    { label: 'Overnight nadir',  hour: 3,  emoji: '🌙' },
    { label: 'Dawn phenomenon',  hour: 7,  emoji: '🌅' },
    { label: 'Midday',           hour: 12, emoji: '☀️' },
    { label: 'Evening',          hour: 22, emoji: '🌆' },
  ].map(lm => {
    const anchor = anchors.find(a => a.hour === lm.hour);
    return { ...lm, value: anchor?.value ?? 0 };
  }), [anchors]);

  // Colour a bar based on its BG value relative to target glucose
  const barColor = useCallback((value: number): string => {
    const target = (constants as any)?.target_glucose ?? 100;
    if (value > target + 20) return '#e57373'; // above target
    if (value < target - 10) return '#64b5f6'; // below target
    return colors.primary;                     // at target
  }, [constants]);

  const renderConstant = (label: string, value: string | number, unit?: string) => (
    <View style={styles.constantRow}>
      <Text style={styles.constantLabel}>{label}</Text>
      <Text style={styles.constantValue}>
        {value}{unit && <Text style={styles.constantUnit}> {unit}</Text>}
      </Text>
    </View>
  );

  // Show loading state while constants are being fetched
  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading constants...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* 🆕 v4.3: Baseline Mode Toggle */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Baseline Mode</Text>
          <Text style={styles.helperText}>
            Controls how your stable blood glucose baseline is calculated.
          </Text>
          {Object.entries(BASELINE_MODES).map(([key, info]) => {
            const modeKey = key as BaselineMode;
            const isActive = activeMode === modeKey;
            return (
              <TouchableOpacity
                key={modeKey}
                onPress={() => handleModeSelect(modeKey)}
                disabled={modeUpdating}
                style={[
                  styles.modeOption,
                  isActive && styles.modeOptionActive,
                  modeUpdating && styles.modeOptionDisabled,
                ]}
                accessibilityRole="radio"
                accessibilityState={{ checked: isActive }}
              >
                <View style={styles.modeOptionHeader}>
                  <View style={[styles.modeRadio, isActive && styles.modeRadioActive]}>
                    {isActive && <View style={styles.modeRadioDot} />}
                  </View>
                  <Text style={[styles.modeLabel, isActive && styles.modeLabelActive]}>
                    {info.label}
                  </Text>
                </View>
                <Text style={styles.modeDesc}>{info.description}</Text>
              </TouchableOpacity>
            );
          })}
          {modeUpdating && (
            <View style={styles.modeUpdatingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.modeUpdatingText}>Saving…</Text>
            </View>
          )}
        </Card>

        {/* 🆕 v4.3: Circadian Baseline Profile Preview */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>24-Hour Baseline Profile</Text>
          <Text style={styles.helperText}>
            Fasting BG curve used when Preset mode is active.
            Captures the dawn rise, overnight dip, and daytime plateau.
          </Text>

          {/* ── Sparkline chart ── */}
          <View style={styles.chartContainer}>
            {/* Horizontal reference line at target glucose */}
            <View
              style={[
                styles.chartRefLine,
                {
                  bottom:
                    (((constants as any)?.target_glucose ?? 100) - minBG) /
                    bgRange *
                    CHART_HEIGHT,
                },
              ]}
            />

            {/* Bars — one per hour */}
            <View style={styles.chartBars}>
              {anchors.map((anchor) => {
                const barH = Math.max(2, ((anchor.value - minBG) / bgRange) * CHART_HEIGHT);
                return (
                  <View key={anchor.hour} style={styles.chartBarWrapper}>
                    <View
                      style={[
                        styles.chartBar,
                        { height: barH, backgroundColor: barColor(anchor.value) },
                      ]}
                    />
                  </View>
                );
              })}
            </View>

            {/* Min / max labels on left axis */}
            <View style={styles.chartAxis}>
              <Text style={styles.chartAxisLabel}>{maxBG}</Text>
              <Text style={styles.chartAxisLabel}>{minBG}</Text>
            </View>
          </View>

          {/* X-axis hour labels */}
          <View style={styles.chartXAxis}>
            {['12 AM', '6 AM', '12 PM', '6 PM', '11 PM'].map((label) => (
              <Text key={label} style={styles.chartXLabel}>{label}</Text>
            ))}
          </View>

          {/* Colour legend */}
          <View style={styles.chartLegend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: '#64b5f6' }]} />
              <Text style={styles.legendText}>Below target</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
              <Text style={styles.legendText}>At target</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: '#e57373' }]} />
              <Text style={styles.legendText}>Above target</Text>
            </View>
          </View>

          {/* ── Landmark rows ── */}
          <View style={styles.landmarkDivider} />
          {landmarks.map((lm) => (
            <View key={lm.hour} style={styles.landmarkRow}>
              <Text style={styles.landmarkEmoji}>{lm.emoji}</Text>
              <View style={styles.landmarkTextGroup}>
                <Text style={styles.landmarkLabel}>
                  {lm.hour === 0 ? '12' : lm.hour > 12 ? lm.hour - 12 : lm.hour}
                  {lm.hour < 12 ? ' AM' : ' PM'} — {lm.label}
                </Text>
              </View>
              <Text style={styles.landmarkValue}>{lm.value} mg/dL</Text>
            </View>
          ))}
        </Card>

        {/* Core Values */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Core Settings</Text>
          {renderConstant('Target Blood Glucose', constants.target_glucose, 'mg/dL')}
          {renderConstant('Insulin:Carb Ratio', `1:${constants.insulin_to_carb_ratio}`)}
          {renderConstant('Correction Factor', constants.correction_factor, 'mg/dL per unit')}
          {renderConstant('Protein Factor', constants.protein_factor)}
          {renderConstant('Fat Factor', constants.fat_factor)}
        </Card>

        {/* Activity Coefficients */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Activity Coefficients</Text>
          <Text style={styles.helperText}>
            These values adjust insulin needs based on activity level
          </Text>
          {Object.entries(constants.activity_coefficients || {}).map(([level, value]) => {
            const levelLabels: Record<string, string> = {
              '-2': 'Very Sedentary',
              '-1': 'Sedentary',
              '0': 'Normal',
              '1': 'Active',
              '2': 'Very Active',
            };
            return renderConstant(levelLabels[level] || level, value as number);
          })}
        </Card>

        {/* Absorption Modifiers */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Absorption Modifiers</Text>
          <Text style={styles.helperText}>
            Food absorption rates affect insulin timing
          </Text>
          {Object.entries(constants.absorption_modifiers || {}).map(([type, value]) =>
            renderConstant(type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), value as number)
          )}
        </Card>

        {/* Meal Timing Factors */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Meal Timing Factors</Text>
          {Object.entries(constants.meal_timing_factors || {}).map(([meal, value]) =>
            renderConstant(meal.charAt(0).toUpperCase() + meal.slice(1), value as number)
          )}
        </Card>

        {/* Active Conditions */}
        {activeConditions.length > 0 && (
          <Card variant="outlined" padding="medium" style={styles.section}>
            <Text style={styles.sectionTitle}>Active Health Conditions</Text>
            {activeConditions.map((condition) => (
              <View key={condition} style={styles.conditionItem}>
                <View style={styles.conditionDot} />
                <Text style={styles.conditionText}>
                  {condition.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {/* Active Medications */}
        {activeMedications.length > 0 && (
          <Card variant="outlined" padding="medium" style={styles.section}>
            <Text style={styles.sectionTitle}>Active Medications</Text>
            {activeMedications.map((medication) => (
              <View key={medication} style={styles.conditionItem}>
                <View style={[styles.conditionDot, { backgroundColor: colors.secondary }]} />
                <Text style={styles.conditionText}>
                  {medication.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </Text>
              </View>
            ))}
          </Card>
        )}

        <Text style={styles.disclaimer}>
          Note: These values are set by your healthcare provider. Contact them to request changes.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// Chart height in dp — tall enough to read but compact enough for a settings screen
const CHART_HEIGHT = 72;

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    ...typography.body,
    color: colors.text.secondary,
    marginTop: spacing.md,
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
  constantRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  constantLabel: {
    ...typography.body,
    color: colors.text.secondary,
    flex: 1,
  },
  constantValue: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  constantUnit: {
    fontWeight: 'normal',
    color: colors.text.secondary,
  },
  conditionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  conditionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginRight: spacing.sm,
  },
  conditionText: {
    ...typography.body,
    color: colors.text.primary,
  },
  disclaimer: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.md,
    fontStyle: 'italic',
  },
  // ── v4.3: Baseline mode toggle ─────────────────────────────────────────────
  modeOption: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  modeOptionActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '10', // 6 % tint
  },
  modeOptionDisabled: {
    opacity: 0.55,
  },
  modeOptionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  modeRadio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.text.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  modeRadioActive: {
    borderColor: colors.primary,
  },
  modeRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  modeLabel: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  modeLabelActive: {
    color: colors.primary,
  },
  modeDesc: {
    ...typography.small,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  modeUpdatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  modeUpdatingText: {
    ...typography.small,
    color: colors.text.secondary,
    marginLeft: spacing.xs,
  },
  // ── v4.3: Circadian profile chart ──────────────────────────────────────────
  chartContainer: {
    height: CHART_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: spacing.sm,
    marginBottom: 2,
    position: 'relative',
  },
  chartBars: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: CHART_HEIGHT,
  },
  chartBarWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    height: CHART_HEIGHT,
    paddingHorizontal: 0.5,
  },
  chartBar: {
    width: '100%',
    borderRadius: 1,
    minHeight: 2,
  },
  chartRefLine: {
    position: 'absolute',
    left: 28,
    right: 0,
    height: 1,
    backgroundColor: colors.text.secondary + '55',
    borderStyle: 'dashed',
    zIndex: 1,
  },
  chartAxis: {
    width: 28,
    height: CHART_HEIGHT,
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingRight: 4,
    position: 'absolute',
    left: 0,
    bottom: 0,
  },
  chartAxisLabel: {
    ...typography.small,
    fontSize: 9,
    color: colors.text.secondary,
    lineHeight: 10,
  },
  chartXAxis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingLeft: 28,
    marginBottom: spacing.sm,
  },
  chartXLabel: {
    ...typography.small,
    fontSize: 9,
    color: colors.text.secondary,
  },
  chartLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    ...typography.small,
    fontSize: 10,
    color: colors.text.secondary,
  },
  landmarkDivider: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: spacing.sm,
  },
  landmarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
  },
  landmarkEmoji: {
    fontSize: 16,
    marginRight: spacing.sm,
    width: 22,
    textAlign: 'center',
  },
  landmarkTextGroup: {
    flex: 1,
  },
  landmarkLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },
  landmarkValue: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 13,
  },
});