/**
 * Dashboard widget showing recent meals
 */

import React from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { MealResponse } from '@/types/api';

export interface RecentMealsProps {
  meals: MealResponse[];
  onMealPress?: (meal: MealResponse) => void;
  onViewAll?: () => void;
  isLoading?: boolean;
  maxItems?: number;
}

export const RecentMeals: React.FC<RecentMealsProps> = ({
  meals,
  onMealPress,
  onViewAll,
  isLoading = false,
  maxItems = 3,
}) => {
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    return date.toLocaleDateString();
  };

  const getMealTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      breakfast: 'Breakfast',
      lunch: 'Lunch',
      dinner: 'Dinner',
      snack: 'Snack',
      normal: 'Meal',
    };
    return labels[type] || type;
  };

  const getMealTypeColor = (type: string) => {
    const colors_map: Record<string, string> = {
      breakfast: colors.warning,
      lunch: colors.secondary,
      dinner: colors.primary,
      snack: colors.success,
      normal: colors.text.secondary,
    };
    return colors_map[type] || colors.text.secondary;
  };

  const renderMealItem = ({ item: meal }: { item: MealResponse }) => {
    const timestamp = meal.mealTime || meal.timestamp;
    const foodNames = meal.foodItems.slice(0, 2).map((f) => f.name).join(', ');
    const moreItems = meal.foodItems.length > 2 ? ` +${meal.foodItems.length - 2}` : '';

    return (
      <Card
        variant="outlined"
        padding="small"
        style={styles.mealCard}
        onPress={onMealPress ? () => onMealPress(meal) : undefined}
      >
        <View style={styles.mealHeader}>
          <View style={[styles.mealTypeBadge, { backgroundColor: getMealTypeColor(meal.mealType) + '20' }]}>
            <Text style={[styles.mealTypeText, { color: getMealTypeColor(meal.mealType) }]}>
              {getMealTypeLabel(meal.mealType)}
            </Text>
          </View>
          <Text style={styles.mealTime}>{formatTime(timestamp)}</Text>
        </View>
        
        <Text style={styles.mealFoods} numberOfLines={1}>
          {foodNames}{moreItems}
        </Text>
        
        <View style={styles.mealNutrition}>
          <View style={styles.nutritionItem}>
            <Text style={styles.nutritionValue}>{meal.nutrition.carbs?.toFixed(0) || 0}g</Text>
            <Text style={styles.nutritionLabel}>Carbs</Text>
          </View>
          <View style={styles.nutritionItem}>
            <Text style={styles.nutritionValue}>{meal.nutrition.calories?.toFixed(0) || 0}</Text>
            <Text style={styles.nutritionLabel}>Cal</Text>
          </View>
          {meal.suggestedInsulin && (
            <View style={styles.nutritionItem}>
              <Text style={[styles.nutritionValue, styles.insulinValue]}>
                {meal.suggestedInsulin.toFixed(1)}u
              </Text>
              <Text style={styles.nutritionLabel}>Insulin</Text>
            </View>
          )}
        </View>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <Card variant="elevated" padding="medium">
        <Text style={styles.title}>Recent Meals</Text>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </Card>
    );
  }

  if (meals.length === 0) {
    return (
      <Card variant="elevated" padding="medium">
        <Text style={styles.title}>Recent Meals</Text>
        <View style={styles.noDataContainer}>
          <Text style={styles.noDataText}>No meals logged today</Text>
          <Text style={styles.noDataHint}>Tap Quick Log to add a meal</Text>
        </View>
      </Card>
    );
  }

  const displayMeals = meals.slice(0, maxItems);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Recent Meals</Text>
        {onViewAll && meals.length > maxItems && (
          <Text style={styles.viewAll} onPress={onViewAll}>
            View All
          </Text>
        )}
      </View>
      
      <FlatList
        data={displayMeals}
        renderItem={renderMealItem}
        keyExtractor={(item) => item.id}
        scrollEnabled={false}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
  },
  viewAll: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  listContent: {
    gap: spacing.sm,
  },
  mealCard: {
    backgroundColor: colors.surface,
  },
  mealHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  mealTypeBadge: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  mealTypeText: {
    ...typography.small,
    fontWeight: '600',
  },
  mealTime: {
    ...typography.small,
    color: colors.text.secondary,
  },
  mealFoods: {
    ...typography.body,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  mealNutrition: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  nutritionItem: {
    alignItems: 'center',
  },
  nutritionValue: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  insulinValue: {
    color: colors.primary,
  },
  nutritionLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },
  loadingContainer: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  loadingText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  noDataContainer: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  noDataText: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  noDataHint: {
    ...typography.small,
    color: colors.primary,
  },
});

export default RecentMeals;
