/**
 * Chart Tooltip Component
 * Location: mobile/components/charts/ChartTooltip.tsx
 *
 * Main Component: ChartTooltip
 * Description: Enhanced tooltip component for displaying detailed information about chart data points
 *
 * Features:
 * - Formatted timestamp display
 * - Blood glucose values (actual and estimated)
 * - Meal effect with color coding
 * - Insulin effect with color coding
 * - Active insulin display
 * - Meal information section (type, carbs, protein, fat)
 * - Target glucose comparison
 * - Elevation and shadow for visibility
 * - Responsive layout
 *
 * Usage:
 * ```tsx
 * <ChartTooltip
 *   timestamp={Date.now()}
 *   bloodSugar={120}
 *   estimatedBloodSugar={115}
 *   mealEffect={25}
 *   insulinEffect={-15}
 *   activeInsulin={2.5}
 *   meals={[{ mealType: 'breakfast', carbs: 45, protein: 15, fat: 10 }]}
 *   targetGlucose={100}
 * />
 * ```
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { format } from 'date-fns';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export interface ChartTooltipProps {
  /** Timestamp of the data point */
  timestamp: number;
  /** Blood glucose value */
  bloodSugar?: number;
  /** Estimated blood glucose */
  estimatedBloodSugar?: number;
  /** Meal effect value */
  mealEffect?: number;
  /** Insulin effect value */
  insulinEffect?: number;
  /** Active insulin units */
  activeInsulin?: number;
  /** Meal information */
  meals?: Array<{
    mealType?: string;
    carbs: number;
    protein: number;
    fat: number;
  }>;
  /** Target glucose */
  targetGlucose?: number;
}

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  timestamp,
  bloodSugar,
  estimatedBloodSugar,
  mealEffect,
  insulinEffect,
  activeInsulin,
  meals,
  targetGlucose = 100,
}) => {
  const formattedTime = format(new Date(timestamp), 'MMM d, HH:mm');

  return (
    <View style={styles.container}>
      <Text style={styles.time}>{formattedTime}</Text>

      {bloodSugar !== undefined && (
        <View style={styles.row}>
          <Text style={styles.label}>Blood Glucose:</Text>
          <Text style={styles.value}>{bloodSugar.toFixed(0)} mg/dL</Text>
        </View>
      )}

      {estimatedBloodSugar !== undefined && (
        <View style={styles.row}>
          <Text style={styles.label}>Estimated BG:</Text>
          <Text style={styles.value}>{estimatedBloodSugar.toFixed(0)} mg/dL</Text>
        </View>
      )}

      {mealEffect !== undefined && mealEffect > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Meal Effect:</Text>
          <Text style={[styles.value, { color: colors.success }]}>
            +{mealEffect.toFixed(0)} mg/dL
          </Text>
        </View>
      )}

      {insulinEffect !== undefined && insulinEffect < 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Insulin Effect:</Text>
          <Text style={[styles.value, { color: colors.danger }]}>
            {insulinEffect.toFixed(0)} mg/dL
          </Text>
        </View>
      )}

      {activeInsulin !== undefined && activeInsulin > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Active Insulin:</Text>
          <Text style={styles.value}>{activeInsulin.toFixed(2)} units</Text>
        </View>
      )}

      {meals && meals.length > 0 && (
        <View style={styles.mealSection}>
          <Text style={styles.sectionTitle}>Meals:</Text>
          {meals.map((meal, index) => (
            <View key={index} style={styles.mealRow}>
              <Text style={styles.mealType}>{meal.mealType || 'Meal'}</Text>
              <Text style={styles.mealNutrition}>
                C: {meal.carbs.toFixed(0)}g | P: {meal.protein.toFixed(0)}g | F: {meal.fat.toFixed(0)}g
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  time: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  label: {
    ...typography.small,
    color: colors.text.secondary,
  },
  value: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
  },
  mealSection: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  sectionTitle: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  mealRow: {
    marginBottom: spacing.xs,
  },
  mealType: {
    ...typography.small,
    fontWeight: '600',
    color: colors.primary,
    textTransform: 'capitalize',
  },
  mealNutrition: {
    ...typography.small,
    color: colors.text.secondary,
  },
});

export default ChartTooltip;