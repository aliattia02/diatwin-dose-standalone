/**
 * Meal Logging Screen
 * Location: mobile/app/(app)/log/meal.tsx
 *
 * Main Function: MealScreen
 * Description: Comprehensive meal logging screen with insulin calculation, food items,
 *              blood glucose reading, and activity tracking
 *
 * Features:
 * - MealForm component integration with calculation
 * - Food item selection and macronutrient tracking
 * - Blood glucose reading with timing
 * - Activity impact calculation
 * - Insulin dose recommendation and logging
 * - Real-time meal calculations
 * - Platform-specific success/error handling (web vs mobile)
 */

import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

// Components
import MealForm, { MealFormData, MealCalculationResult } from '@/components/forms/MealForm';

// Services
import { calculateMeal, createMeal } from '@/services/api/meals';

export default function MealScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleCalculate = async (data: Partial<MealFormData>): Promise<MealCalculationResult> => {
    console.log('\n[MealScreen] handleCalculate called');
    console.log('[MealScreen] Data:', JSON.stringify(data, null, 2));

    try {
      const result = await calculateMeal({
        mealType: data.mealType!,
        selectedFoods: data.selectedFoods,
        bloodSugar: data.bloodSugar,
        activities: data.activities
      });

      console.log('[MealScreen] Calculation result:', JSON.stringify(result, null, 2));

      return result;
    } catch (error: any) {
      console.error('[MealScreen] Calculation failed:', error);
      console.error('[MealScreen] Error details:', error.response?.data);
      throw error;
    }
  };

  const handleSubmit = async (data: MealFormData): Promise<void> => {
    console.log('\n[MealScreen] handleSubmit called');

    setIsLoading(true);
    try {
      const result = await createMeal({
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

      console.log('[MealScreen] Meal created successfully:', result);
      // ✅ MealForm handles the success alert, form reset, and navigation.
      // Do NOT show an alert or call router.back() here — MealForm does it
      // after this promise resolves, via its onCancel prop → router.back().
    } catch (error: any) {
      console.error('[MealScreen] Failed to submit meal:', error);
      const errorMessage = error?.response?.data?.error || error?.message || 'Failed to log meal. Please try again.';
      // ✅ Re-throw so MealForm's catch block can display the error to the user.
      throw new Error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    console.log('[MealScreen] Cancel pressed');
    router.replace('/(app)/(tabs)');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <MealForm
          onSubmit={handleSubmit}
          onCalculate={handleCalculate}
          onCancel={handleCancel}
          isLoading={isLoading}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5'
  },
  content: {
    flex: 1
  }
});