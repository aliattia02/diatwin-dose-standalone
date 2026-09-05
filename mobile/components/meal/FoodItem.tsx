/**
 * Food Item Component
 * Location: mobile/components/meal/FoodItem.tsx
 *
 * Props: FoodItemProps
 * Description: Component for displaying and editing a selected food item with portion control and nutritional information
 *
 * Features:
 * - Weight/volume measurement system toggle
 * - Interactive portion control with +/- buttons
 * - Real-time nutritional calculations based on portion size
 * - Unit conversion when switching measurement systems
 * - Auto-convert amount when unit changes
 * - Absorption type badge with color coding
 * - Dropdown unit selector
 * - Portion validation (minimum 0.5)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';

// Constants
import { colors, spacing, borderRadius, typography } from '@/constants/theme';
import {
  MEASUREMENT_SYSTEMS,
  VOLUME_MEASUREMENTS,
  WEIGHT_MEASUREMENTS,
  convertToGrams,
  convertToMl,
} from '@/constants';

// Types
import type { SelectedFood, FoodPortion, CalculatedNutrients, MeasurementType } from '@/types/food';

export interface FoodItemProps {
  /** The selected food item to display */
  item: SelectedFood;
  /** Callback when portion is updated */
  onUpdatePortion: (foodId: number, newPortion: FoodPortion) => void;
  /** Callback when item is removed */
  onRemove: (foodId: number) => void;
  /** Optional callback for portion changes */
  onPortionChange?: (foodId: number, newPortion: FoodPortion) => void;
}

/**
 * Calculate nutrients based on portion size
 */
const calculateNutrients = (item: SelectedFood): CalculatedNutrients => {
  if (!item.details) {
    return { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };
  }

  let conversionRatio = 1;

  // Calculate conversion ratio based on measurement type
  if (item.portion.activeMeasurement === 'weight') {
    const portionInGrams = convertToGrams(
      item.portion.w_amount || 1,
      item.portion.w_unit || 'g'
    );
    const servingSizeInGrams = convertToGrams(
      item.details.serving_size?.w_amount || 100,
      item.details.serving_size?.w_unit || 'g'
    );
    conversionRatio = portionInGrams / servingSizeInGrams;
  } else {
    const portionInMl = convertToMl(
      item.portion.amount || 1,
      item.portion.unit || 'ml'
    );
    const servingSizeInMl = convertToMl(
      item.details.serving_size?.amount || 1,
      item.details.serving_size?.unit || 'serving'
    );
    conversionRatio = portionInMl / servingSizeInMl;
  }

  return {
    carbs: (item.details.carbs || 0) * conversionRatio,
    protein: (item.details.protein || 0) * conversionRatio,
    fat: (item.details.fat || 0) * conversionRatio,
    absorptionType: item.details.absorption_type || 'medium',
  };
};

export const FoodItem: React.FC<FoodItemProps> = ({
  item,
  onUpdatePortion,
  onRemove,
  onPortionChange,
}) => {
  const [measurementSystem, setMeasurementSystem] = useState<MeasurementType>(
    (item.portion?.activeMeasurement as MeasurementType) || 'weight'
  );
  const [amount, setAmount] = useState<number>(() => {
    return measurementSystem === 'volume'
      ? item.portion?.amount || 1
      : item.portion?.w_amount || item.details?.serving_size?.w_amount || 1;
  });
  const [inputText, setInputText] = useState<string>(() => {
    const initial = measurementSystem === 'volume'
      ? item.portion?.amount || 1
      : item.portion?.w_amount || item.details?.serving_size?.w_amount || 1;
    return initial.toString();
  });
  const [unit, setUnit] = useState<string>(() => {
    return measurementSystem === 'volume'
      ? item.portion?.unit || 'ml'
      : item.portion?.w_unit || item.details?.serving_size?.w_unit || 'g';
  });
  const [nutrients, setNutrients] = useState<CalculatedNutrients>({
    carbs: 0,
    protein: 0,
    fat: 0,
    absorptionType: 'medium',
  });
  const [showUnitPicker, setShowUnitPicker] = useState(false);

  // Calculate nutrients when item changes
  useEffect(() => {
    const newNutrients = calculateNutrients(item);
    setNutrients(newNutrients);
  }, [item]);

  // Update parent when portion changes
  useEffect(() => {
    const newPortion: FoodPortion = {
      amount: measurementSystem === 'volume' ? amount : null,
      unit: measurementSystem === 'volume' ? unit : null,
      w_amount: measurementSystem === 'weight' ? amount : null,
      w_unit: measurementSystem === 'weight' ? unit : null,
      activeMeasurement: measurementSystem,
    };

    // Only update if portion actually changed
    const hasChanged =
      newPortion.amount !== item.portion.amount ||
      newPortion.unit !== item.portion.unit ||
      newPortion.w_amount !== item.portion.w_amount ||
      newPortion.w_unit !== item.portion.w_unit ||
      newPortion.activeMeasurement !== item.portion.activeMeasurement;

    if (hasChanged) {
      onUpdatePortion(item.id, newPortion);
      onPortionChange?.(item.id, newPortion);
    }
  }, [amount, unit, measurementSystem, item.id, onUpdatePortion, onPortionChange, item.portion]);

  const handleMeasurementSystemChange = useCallback(
    (newSystem: MeasurementType) => {
      if (newSystem === measurementSystem) return;

      let newAmount = amount;
      let newUnit = newSystem === 'volume' ? 'ml' : 'g';

      // Convert amount when switching systems
      if (measurementSystem === 'volume' && newSystem === 'weight') {
        const currentMl = amount * (VOLUME_MEASUREMENTS[unit]?.ml || 1);
        newAmount = currentMl;
      } else if (measurementSystem === 'weight' && newSystem === 'volume') {
        const currentGrams = amount * (WEIGHT_MEASUREMENTS[unit]?.grams || 1);
        newAmount = currentGrams;
      }

      setAmount(newAmount);
      setInputText(newAmount.toString());
      setUnit(newUnit);
      setMeasurementSystem(newSystem);
    },
    [amount, unit, measurementSystem]
  );

  const handleAmountChange = useCallback((newAmount: number) => {
    const validAmount = Math.max(0.5, newAmount);
    setAmount(validAmount);
    setInputText(validAmount.toString());
  }, []);

  const handleUnitChange = useCallback(
    (newUnit: string) => {
      const measurements =
        measurementSystem === 'volume' ? VOLUME_MEASUREMENTS : WEIGHT_MEASUREMENTS;
      const oldUnitValue =
        measurementSystem === 'volume'
          ? measurements[unit]?.ml || 1
          : (measurements as typeof WEIGHT_MEASUREMENTS)[unit]?.grams || 1;
      const newUnitValue =
        measurementSystem === 'volume'
          ? measurements[newUnit]?.ml || 1
          : (measurements as typeof WEIGHT_MEASUREMENTS)[newUnit]?.grams || 1;

      const convertedAmount = (amount * oldUnitValue) / newUnitValue;
      const rounded = parseFloat(convertedAmount.toFixed(2));
      setAmount(rounded);
      setInputText(rounded.toString());
      setUnit(newUnit);
      setShowUnitPicker(false);
    },
    [amount, unit, measurementSystem]
  );

  const getAvailableUnits = useCallback(() => {
    const measurements =
      measurementSystem === 'volume' ? VOLUME_MEASUREMENTS : WEIGHT_MEASUREMENTS;
    return Object.entries(measurements).map(([key, value]) => ({
      value: key,
      label: (value as { display_name: string }).display_name,
    }));
  }, [measurementSystem]);

  const getAbsorptionColor = (type: string): string => {
    switch (type) {
      case 'very_fast':
        return colors.danger;
      case 'fast':
        return colors.warning;
      case 'medium':
        return colors.success;
      case 'mixed':
        return '#f57c00'; // burnt orange — distinct from both fast and slow
      case 'slow':
        return colors.secondary;
      case 'very_slow':
        return colors.primary;
      default:
        return colors.text.secondary;
    }
  };

  const formatAbsorption = (type: string): string => {
    return type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.foodName} numberOfLines={1}>
          {item.name}
        </Text>
        <TouchableOpacity
          style={styles.removeButton}
          onPress={() => onRemove(item.id)}
        >
          <Text style={styles.removeIcon}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Measurement Toggle */}
      <View style={styles.measurementToggle}>
        <TouchableOpacity
          style={[
            styles.toggleButton,
            measurementSystem === 'weight' && styles.toggleButtonActive,
          ]}
          onPress={() => handleMeasurementSystemChange('weight')}
        >
          <Text
            style={[
              styles.toggleText,
              measurementSystem === 'weight' && styles.toggleTextActive,
            ]}
          >
            Weight
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.toggleButton,
            measurementSystem === 'volume' && styles.toggleButtonActive,
          ]}
          onPress={() => handleMeasurementSystemChange('volume')}
        >
          <Text
            style={[
              styles.toggleText,
              measurementSystem === 'volume' && styles.toggleTextActive,
            ]}
          >
            Volume
          </Text>
        </TouchableOpacity>
      </View>

      {/* Portion Control */}
      <View style={styles.portionControl}>
        <View style={styles.amountControl}>
          <TouchableOpacity
            style={styles.controlButton}
            onPress={() => handleAmountChange(amount - 0.5)}
          >
            <Text style={styles.controlButtonText}>−</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.amountInput}
            value={inputText}
            onChangeText={(text) => {
              // Allow free typing: digits, one decimal point, leading decimal
              if (/^\d*\.?\d*$/.test(text)) {
                setInputText(text);
              }
            }}
            onBlur={() => {
              const num = parseFloat(inputText);
              if (!isNaN(num) && num > 0) {
                handleAmountChange(num);
              } else {
                // Reset to last valid amount if input is invalid/empty
                setInputText(amount.toString());
              }
            }}
            keyboardType="decimal-pad"
          />
          <TouchableOpacity
            style={styles.controlButton}
            onPress={() => handleAmountChange(amount + 0.5)}
          >
            <Text style={styles.controlButtonText}>+</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.unitSelector}
          onPress={() => setShowUnitPicker(!showUnitPicker)}
        >
          <Text style={styles.unitText}>
            {
              (measurementSystem === 'volume'
                ? VOLUME_MEASUREMENTS[unit]
                : WEIGHT_MEASUREMENTS[unit]
              )?.display_name || unit
            }
          </Text>
          <Text style={styles.dropdownIcon}>{showUnitPicker ? '▲' : '▼'}</Text>
        </TouchableOpacity>
      </View>

      {/* Unit Picker */}
      {showUnitPicker && (
        <View style={styles.unitPicker}>
          {getAvailableUnits().map(({ value, label }) => (
            <TouchableOpacity
              key={value}
              style={[
                styles.unitOption,
                unit === value && styles.unitOptionSelected,
              ]}
              onPress={() => handleUnitChange(value)}
            >
              <Text
                style={[
                  styles.unitOptionText,
                  unit === value && styles.unitOptionTextSelected,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Nutrients Display */}
      <View style={styles.nutrientsGrid}>
        <View style={styles.nutrientItem}>
          <Text style={styles.nutrientValue}>{nutrients.carbs.toFixed(1)}g</Text>
          <Text style={styles.nutrientLabel}>Carbs</Text>
        </View>
        <View style={styles.nutrientItem}>
          <Text style={styles.nutrientValue}>{nutrients.protein.toFixed(1)}g</Text>
          <Text style={styles.nutrientLabel}>Protein</Text>
        </View>
        <View style={styles.nutrientItem}>
          <Text style={styles.nutrientValue}>{nutrients.fat.toFixed(1)}g</Text>
          <Text style={styles.nutrientLabel}>Fat</Text>
        </View>
        <View style={styles.nutrientItem}>
          <View
            style={[
              styles.absorptionBadge,
              { backgroundColor: getAbsorptionColor(nutrients.absorptionType) + '20' },
            ]}
          >
            <Text
              style={[
                styles.absorptionText,
                { color: getAbsorptionColor(nutrients.absorptionType) },
              ]}
            >
              {formatAbsorption(nutrients.absorptionType)}
            </Text>
          </View>
          <Text style={styles.nutrientLabel}>Absorption</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  foodName: {
    ...typography.h3,
    color: colors.text.primary,
    flex: 1,
    marginRight: spacing.sm,
  },
  removeButton: {
    padding: spacing.xs,
  },
  removeIcon: {
    fontSize: 18,
    color: colors.danger,
    fontWeight: '600',
  },
  measurementToggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    padding: 2,
    marginBottom: spacing.md,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: borderRadius.sm,
  },
  toggleButtonActive: {
    backgroundColor: colors.primary,
  },
  toggleText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  toggleTextActive: {
    color: colors.text.inverse,
    fontWeight: '600',
  },
  portionControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  amountControl: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  controlButton: {
    width: 36,
    height: 36,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonText: {
    fontSize: 20,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  amountInput: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.xs,
    textAlign: 'center',
    ...typography.body,
    color: colors.text.primary,
  },
  unitSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minWidth: 100,
  },
  unitText: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  dropdownIcon: {
    fontSize: 10,
    color: colors.text.secondary,
    marginLeft: spacing.xs,
  },
  unitPicker: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    marginBottom: spacing.md,
    maxHeight: 200,
    overflow: 'hidden',
  },
  unitOption: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  unitOptionSelected: {
    backgroundColor: colors.primary + '15',
  },
  unitOptionText: {
    ...typography.body,
    color: colors.text.primary,
  },
  unitOptionTextSelected: {
    color: colors.primary,
    fontWeight: '600',
  },
  nutrientsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  nutrientItem: {
    alignItems: 'center',
    flex: 1,
  },
  nutrientValue: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  nutrientLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },
  absorptionBadge: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  absorptionText: {
    ...typography.small,
    fontWeight: '500',
  },
});

export default FoodItem;