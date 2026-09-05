/**
 * Meal Detail View Screen
 * Location: mobile/app/(app)/meal/[id].tsx
 *
 * Main Function: MealDetailScreen
 * Description: Detailed view of a specific meal entry with nutrition, insulin, blood sugar, and notes
 *
 * Features:
 * - Full meal information display
 * - Food items list with portions
 * - Nutrition breakdown (carbs, protein, fat, calories)
 * - Blood sugar reading with timestamp
 * - Insulin doses (suggested vs taken)
 * - Meal notes display
 * - Error handling with user-friendly messages
 * - Loading state management
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Card, Loading, Button } from '@/components/ui';

// Services
import { getMealById } from '@/services/api/meals';
import { getDoctorPatientMeals, getPatientConstants } from '@/services/api/doctor';

// Hooks
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { useAuthStore } from '@/store/auth.store';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// Types
import type { MealResponse } from '@/types/api';

// Extended locally to include meals_only fields not yet in the shared type
type MealDetail = MealResponse & {
  nutrition: MealResponse['nutrition'] & {
    total_carb_equiv?: number;
  };
  calculation_summary?: {
    base_insulin?: number;
    meal_only_suggested_insulin?: number;
    absorption_type?: string;
    adjustment_factors?: {
      absorption_rate?: number;
      meal_timing?: number;
    };
  };
};

export default function MealDetailScreen() {
  const { id, patientId } = useLocalSearchParams<{ id: string; patientId?: string }>();
  const router = useRouter();
  const [meal, setMeal] = useState<MealDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuthStore();
  const isDoctor = !!(patientId && user?.user_type === 'doctor');
  // Patients use their own constants; doctors fetch the patient's constants
  const { constants: patientOwnConstants } = usePatientConstants(!isDoctor);
  const [doctorPatientConstants, setDoctorPatientConstants] = useState<any>(null);
  const constants = isDoctor ? doctorPatientConstants : patientOwnConstants;

  useEffect(() => {
    loadMeal();
  }, [id]);

  const loadMeal = async () => {
    if (!id) {
      setError('Meal ID not provided');
      setIsLoading(false);
      return;
    }

    try {
      if (isDoctor && patientId) {
        // Doctor path: fetch from doctor endpoint + patient's own constants
        const [mealsData, patientConsts] = await Promise.all([
          getDoctorPatientMeals(patientId, { limit: 200 }),
          getPatientConstants(patientId),
        ]);
        const found = mealsData.meals?.find((m: any) => m.id === id) as MealDetail | undefined;
        if (!found) throw new Error('Meal not found');
        setMeal(found);
        setDoctorPatientConstants(patientConsts);
      } else {
        const data = await getMealById(id) as MealDetail;
        setMeal(data);
      }
    } catch (err) {
      setError('Failed to load meal details');
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString([], {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Stack.Screen options={{ title: 'Meal Details' }} />
        <Loading text="Loading meal details..." />
      </SafeAreaView>
    );
  }

  if (error || !meal) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Stack.Screen options={{ title: 'Meal Details' }} />
        <View style={styles.errorContainer}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorTitle}>Error</Text>
          <Text style={styles.errorText}>{error || 'Meal not found'}</Text>
          <Button title="Go Back" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const timestamp = meal.mealTime || meal.timestamp;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1),
          headerStyle: { backgroundColor: colors.primary },
          headerTintColor: colors.text.inverse,
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Time and Type */}
        <Card variant="elevated" padding="medium" style={styles.headerCard}>
          <Text style={styles.mealType}>
            {meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1)}
          </Text>
          <Text style={styles.timestamp}>{formatDate(timestamp)}</Text>
        </Card>

        {/* Food Items */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Food Items</Text>
          {meal.foodItems.map((item, index) => (
            <View key={index} style={styles.foodItem}>
              <Text style={styles.foodName}>{item.name}</Text>
              <Text style={styles.foodPortion}>
                {(() => {
                  const p = item.portion;
                  const portionStr = typeof p === 'object' && p !== null
                    ? `${(p as any).amount ?? ''} ${(p as any).unit ?? (p as any).measurement_type ?? ''}`.trim()
                    : String(p ?? '');
                  return item.measurement ? `${portionStr} ${item.measurement}` : portionStr;
                })()}
              </Text>
            </View>
          ))}
        </Card>

        {/* Nutrition Summary */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Nutrition</Text>
          <View style={styles.nutritionGrid}>
            <View style={styles.nutritionItem}>
              <Text style={styles.nutritionValue}>{meal.nutrition.carbs?.toFixed(1) || 0}g</Text>
              <Text style={styles.nutritionLabel}>Carbs</Text>
            </View>
            <View style={styles.nutritionItem}>
              <Text style={styles.nutritionValue}>{meal.nutrition.protein?.toFixed(1) || 0}g</Text>
              <Text style={styles.nutritionLabel}>Protein</Text>
            </View>
            <View style={styles.nutritionItem}>
              <Text style={styles.nutritionValue}>{meal.nutrition.fat?.toFixed(1) || 0}g</Text>
              <Text style={styles.nutritionLabel}>Fat</Text>
            </View>
            <View style={styles.nutritionItem}>
              <Text style={styles.nutritionValue}>{meal.nutrition.calories?.toFixed(0) || 0}</Text>
              <Text style={styles.nutritionLabel}>Calories</Text>
            </View>
          </View>
        </Card>

        {/* ── Carb Equivalent & Expected BG Rise ── */}
        {(meal.nutrition?.total_carb_equiv != null || meal.calculation_summary) && (
          <Card variant="outlined" padding="medium" style={styles.section}>
            <Text style={styles.sectionTitle}>Insulin Calculation Data</Text>
            <View style={styles.calcGrid}>

              {/* Carb Equivalent */}
              {meal.nutrition?.total_carb_equiv != null && (
                <View style={styles.calcItem}>
                  <Text style={styles.calcValue}>
                    {Number(meal.nutrition.total_carb_equiv).toFixed(1)}g
                  </Text>
                  <Text style={styles.calcLabel}>Carb Equivalent</Text>
                  <Text style={styles.calcSub}>
                    {Number(meal.nutrition.carbs ?? 0).toFixed(1)}g carbs
                    {meal.nutrition.protein ? ` + ${(meal.nutrition.protein * (constants?.protein_factor ?? 0.5)).toFixed(1)}g protein equiv` : ''}
                    {meal.nutrition.fat ? ` + ${(meal.nutrition.fat * (constants?.fat_factor ?? 0.2)).toFixed(1)}g fat equiv` : ''}
                  </Text>
                </View>
              )}

              {/* Expected BG Rise */}
              {meal.nutrition?.total_carb_equiv != null && constants?.carb_to_bg_factor != null && (
                <View style={styles.calcItem}>
                  <Text style={[styles.calcValue, { color: colors.warning }]}>
                    +{(Number(meal.nutrition.total_carb_equiv) * (constants.carb_to_bg_factor ?? 4)).toFixed(0)} mg/dL
                  </Text>
                  <Text style={styles.calcLabel}>Expected BG Rise</Text>
                  <Text style={styles.calcSub}>
                    {Number(meal.nutrition.total_carb_equiv).toFixed(1)}g × {constants.carb_to_bg_factor ?? 4} factor
                  </Text>
                </View>
              )}

              {/* Baseline Insulin */}
              {meal.calculation_summary?.base_insulin != null && (
                <View style={styles.calcItem}>
                  <Text style={[styles.calcValue, { color: colors.primary }]}>
                    {Number(meal.calculation_summary.base_insulin).toFixed(2)}u
                  </Text>
                  <Text style={styles.calcLabel}>Baseline Insulin</Text>
                  <Text style={styles.calcSub}>Before adjustments</Text>
                </View>
              )}

              {/* Meal-Only Suggested */}
              {meal.calculation_summary?.meal_only_suggested_insulin != null && (
                <View style={styles.calcItem}>
                  <Text style={[styles.calcValue, { color: colors.success }]}>
                    {Number(meal.calculation_summary.meal_only_suggested_insulin).toFixed(1)}u
                  </Text>
                  <Text style={styles.calcLabel}>Meal-Only Dose</Text>
                  <Text style={styles.calcSub}>
                    {meal.calculation_summary.absorption_type ?? 'medium'} absorption
                  </Text>
                </View>
              )}
            </View>

            {/* Adjustment factors */}
            {meal.calculation_summary?.adjustment_factors && (
              <View style={styles.factorsRow}>
                <Text style={styles.factorsLabel}>Adjustments applied: </Text>
                <Text style={styles.factorsValue}>
                  Absorption ×{Number(meal.calculation_summary.adjustment_factors.absorption_rate ?? 1).toFixed(2)}
                  {'  '}Timing ×{Number(meal.calculation_summary.adjustment_factors.meal_timing ?? 1).toFixed(2)}
                </Text>
              </View>
            )}
          </Card>
        )}

        {/* Blood Sugar */}
        {meal.bloodSugar && (
          <Card variant="outlined" padding="medium" style={styles.section}>
            <Text style={styles.sectionTitle}>Blood Sugar</Text>
            <View style={styles.bloodSugarRow}>
              <Text style={styles.bloodSugarValue}>{meal.bloodSugar} mg/dL</Text>
              {meal.bloodSugarTimestamp && (
                <Text style={styles.bloodSugarTime}>
                  at {new Date(meal.bloodSugarTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              )}
            </View>
          </Card>
        )}

        {/* Insulin */}
        {(meal.suggestedInsulin || meal.intendedInsulin) && (
          <Card variant="filled" padding="medium" style={styles.section}>
            <Text style={styles.sectionTitle}>Insulin</Text>
            <View style={styles.insulinRow}>
              {meal.suggestedInsulin && (
                <View style={styles.insulinItem}>
                  <Text style={styles.insulinLabel}>Suggested</Text>
                  <Text style={styles.insulinValue}>{meal.suggestedInsulin.toFixed(1)} units</Text>
                </View>
              )}
              {meal.intendedInsulin && (
                <View style={styles.insulinItem}>
                  <Text style={styles.insulinLabel}>Taken</Text>
                  <Text style={[styles.insulinValue, { color: colors.success }]}>
                    {meal.intendedInsulin.toFixed(1)} units
                  </Text>
                </View>
              )}
            </View>
          </Card>
        )}

        {/* Notes */}
        {meal.notes && (
          <Card variant="outlined" padding="medium" style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notes}>{meal.notes}</Text>
          </Card>
        )}
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
  headerCard: {
    alignItems: 'center',
    marginBottom: spacing.md,
    backgroundColor: colors.primary + '10',
  },
  mealType: {
    ...typography.h2,
    color: colors.primary,
  },
  timestamp: {
    ...typography.body,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  section: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  foodItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  foodName: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  foodPortion: {
    ...typography.body,
    color: colors.text.secondary,
  },
  nutritionGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  nutritionItem: {
    alignItems: 'center',
  },
  nutritionValue: {
    ...typography.h3,
    color: colors.text.primary,
  },
  nutritionLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },
  bloodSugarRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  bloodSugarValue: {
    ...typography.h2,
    color: colors.glucose.normal,
  },
  bloodSugarTime: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  insulinRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  insulinItem: {
    alignItems: 'center',
  },
  insulinLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  insulinValue: {
    ...typography.h2,
    color: colors.primary,
  },
  notes: {
    ...typography.body,
    color: colors.text.primary,
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  errorTitle: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  errorText: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },

  // ── Calculation data grid ──────────────────────────────────────────────────
  calcGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  calcItem: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  calcValue: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: '700',
  },
  calcLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
  calcSub: {
    fontSize: 10,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: 2,
    lineHeight: 13,
  },
  factorsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
    alignItems: 'center',
  },
  factorsLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  factorsValue: {
    ...typography.small,
    color: colors.text.primary,
  },
  // ───────────────────────────────────────────────────────────────────────────
});