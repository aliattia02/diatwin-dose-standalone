/**
 * Selected Foods List Component
 * Location: mobile/components/meal/SelectedFoodsList.tsx
 *
 * Main Function: SelectedFoodsList
 * Description: Displays and manages the list of selected foods with portion editing and nutritional calculations
 *
 * Features:
 * - Weight/volume measurement system toggle
 * - Interactive portion control with +/- buttons
 * - Real-time nutritional calculations
 * - Unit conversion when switching measurement systems
 * - Auto-convert amount when unit changes
 * - Absorption type badges with color coding
 * - Round to nearest 0.5 for portions
 * - Empty state handling
 * - ⭐ Unit picker as Modal popup (not inline)
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  SafeAreaView,
  Pressable
} from 'react-native';

// Constants
import { VOLUME_MEASUREMENTS, WEIGHT_MEASUREMENTS } from '@/constants';

interface Food {
  id: number;
  name: string;
  portion: {
    amount?: number;
    unit?: string;
    activeMeasurement: 'weight' | 'volume';
    w_amount?: number;
    w_unit?: string;
  };
  details?: {
    carbs?: number;
    protein?: number;
    fat?: number;
    absorption_type?: string;
    serving_size?: {
      amount?: number;
      unit?: string;
      w_amount?: number;
      w_unit?: string;
    };
  };
}

interface SelectedFoodsListProps {
  foods: Food[];
  onRemove: (index: number) => void;
  onUpdatePortion?: (index: number, newPortion: any) => void;
}

const SelectedFoodsList: React.FC<SelectedFoodsListProps> = ({
  foods,
  onRemove,
  onUpdatePortion,
}) => {
  // ⭐ Changed from editingFood index to a modal state object
  const [unitPickerModal, setUnitPickerModal] = useState<{
    visible: boolean;
    foodIndex: number | null;
    isWeight: boolean;
    currentUnit: string;
    foodName: string;
  }>({
    visible: false,
    foodIndex: null,
    isWeight: true,
    currentUnit: 'g',
    foodName: ''
  });

  // Local input text per food id — allows free typing without snapping mid-input
  const [inputTexts, setInputTexts] = useState<Record<number, string>>({});

  // Helper to safely format numbers
  const safeToFixed = (value: number | undefined, decimals: number = 1): string => {
    if (value === undefined || value === null || isNaN(value)) {
      return '0.0';
    }
    return value.toFixed(decimals);
  };

  // Helper to get display name for unit
  const getUnitDisplayName = (unit: string, isWeight: boolean): string => {
    const measurements = isWeight ? WEIGHT_MEASUREMENTS : VOLUME_MEASUREMENTS;
    return measurements[unit]?.display_name || unit;
  };

  // Helper to get available units
  const getAvailableUnits = (isWeight: boolean) => {
    const measurements = isWeight ? WEIGHT_MEASUREMENTS : VOLUME_MEASUREMENTS;
    return Object.entries(measurements).map(([key, value]) => ({
      value: key,
      label: value.display_name
    }));
  };

  // Helper to calculate nutrients based on portion
  const calculateNutrients = (food: Food) => {
    if (!food.details) {
      return { carbs: 0, protein: 0, fat: 0 };
    }

    const isWeight = food.portion?.activeMeasurement === 'weight';
    let conversionRatio = 1;

    if (isWeight) {
      const portionGrams = (food.portion?.w_amount ?? 1) * (WEIGHT_MEASUREMENTS[food.portion?.w_unit || 'g']?.grams || 1);
      const servingGrams = (food.details?.serving_size?.w_amount || 100) * (WEIGHT_MEASUREMENTS[food.details?.serving_size?.w_unit || 'g']?.grams || 1);
      conversionRatio = portionGrams / servingGrams;
    } else {
      const portionMl = (food.portion?.amount ?? 1) * (VOLUME_MEASUREMENTS[food.portion?.unit || 'ml']?.ml || 1);
      const servingMl = (food.details?.serving_size?.amount || 1) * (VOLUME_MEASUREMENTS[food.details?.serving_size?.unit || 'serving']?.ml || 1);
      conversionRatio = portionMl / servingMl;
    }

    return {
      carbs: (food.details.carbs || 0) * conversionRatio,
      protein: (food.details.protein || 0) * conversionRatio,
      fat: (food.details.fat || 0) * conversionRatio
    };
  };

  // Helper to get absorption badge color
  const getAbsorptionColor = (type?: string): string => {
    switch (type) {
      case 'very_fast': return '#f44336';
      case 'fast':      return '#ff9800';
      case 'medium':    return '#4caf50';
      case 'mixed':     return '#f57c00';
      case 'slow':      return '#2196f3';
      case 'very_slow': return '#9c27b0';
      default:          return '#9e9e9e';
    }
  };

  // Helper to format absorption type
  const formatAbsorptionType = (type?: string): string => {
    if (!type) return 'Unknown';
    return type.split('_').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  };

  // Handle measurement system toggle
  const handleMeasurementToggle = (index: number) => {
    if (!onUpdatePortion) return;

    const food = foods[index];
    const isCurrentlyWeight = food.portion?.activeMeasurement === 'weight';
    const newSystem = isCurrentlyWeight ? 'volume' : 'weight';

    let newAmount = isCurrentlyWeight ? (food.portion?.w_amount ?? 1) : (food.portion?.amount ?? 1);
    let newUnit = newSystem === 'weight' ? 'g' : 'ml';

    const newPortion = {
      ...food.portion,
      activeMeasurement: newSystem,
      amount: newSystem === 'volume' ? newAmount : food.portion?.amount,
      unit: newSystem === 'volume' ? newUnit : food.portion?.unit,
      w_amount: newSystem === 'weight' ? newAmount : food.portion?.w_amount,
      w_unit: newSystem === 'weight' ? newUnit : food.portion?.w_unit
    };

    onUpdatePortion(index, newPortion);
    setInputTexts(prev => ({ ...prev, [food.id]: String(newAmount) }));
  };

  // Helper to round to nearest 0.5
  const roundToHalf = (value: number): number => {
    return Math.round(value * 2) / 2;
  };

  // Handle amount text change — just track what the user is typing, no rounding yet
  const handleAmountTextChange = (food: Food, text: string) => {
    // Allow digits, a single decimal point, and leading decimal
    if (/^\d*\.?\d*$/.test(text)) {
      setInputTexts(prev => ({ ...prev, [food.id]: text }));
    }
  };

  // Commit amount on blur — parse, clamp, round, then push to parent
  const handleAmountBlur = (index: number, food: Food) => {
    if (!onUpdatePortion) return;
    const text = inputTexts[food.id] ?? String(
      food.portion?.activeMeasurement === 'weight'
        ? (food.portion?.w_amount ?? 1)
        : (food.portion?.amount ?? 1)
    );
    const parsed = parseFloat(text);
    const amount = Math.max(0.5, roundToHalf(isNaN(parsed) || parsed <= 0 ? 0.5 : parsed));
    const isWeight = food.portion?.activeMeasurement === 'weight';
    // Sync displayed text to final committed value
    setInputTexts(prev => ({ ...prev, [food.id]: String(amount) }));
    const newPortion = {
      ...food.portion,
      ...(isWeight ? { w_amount: amount } : { amount: amount })
    };
    onUpdatePortion(index, newPortion);
  };

  // ⭐ Open the unit picker modal
  const openUnitPicker = (index: number) => {
    const food = foods[index];
    const isWeight = food.portion?.activeMeasurement === 'weight';
    const currentUnit = isWeight ? (food.portion?.w_unit ?? 'g') : (food.portion?.unit ?? 'ml');

    setUnitPickerModal({
      visible: true,
      foodIndex: index,
      isWeight,
      currentUnit,
      foodName: food.name
    });
  };

  // ⭐ Close the unit picker modal
  const closeUnitPicker = () => {
    setUnitPickerModal(prev => ({ ...prev, visible: false, foodIndex: null }));
  };

  // Handle unit change with auto-convert
  const handleUnitChange = (newUnit: string) => {
    const index = unitPickerModal.foodIndex;
    if (index === null || !onUpdatePortion) return;

    const food = foods[index];
    const isWeight = food.portion?.activeMeasurement === 'weight';
    const currentAmount = isWeight ? (food.portion?.w_amount ?? 1) : (food.portion?.amount ?? 1);
    const currentUnit = isWeight ? (food.portion?.w_unit ?? 'g') : (food.portion?.unit ?? 'ml');

    let convertedAmount = currentAmount;

    if (isWeight) {
      const currentGrams = currentAmount * (WEIGHT_MEASUREMENTS[currentUnit]?.grams || 1);
      const newUnitGrams = WEIGHT_MEASUREMENTS[newUnit]?.grams || 1;
      convertedAmount = currentGrams / newUnitGrams;
    } else {
      const currentMl = currentAmount * (VOLUME_MEASUREMENTS[currentUnit]?.ml || 1);
      const newUnitMl = VOLUME_MEASUREMENTS[newUnit]?.ml || 1;
      convertedAmount = currentMl / newUnitMl;
    }

    const roundedAmount = roundToHalf(convertedAmount);

    const newPortion = {
      ...food.portion,
      ...(isWeight
        ? { w_amount: roundedAmount, w_unit: newUnit }
        : { amount: roundedAmount, unit: newUnit }
      )
    };

    onUpdatePortion(index, newPortion);
    setInputTexts(prev => ({ ...prev, [foods[index].id]: String(roundedAmount) }));
    closeUnitPicker();
  };

  if (foods.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Tap "+ Add Food" to get started</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        {foods.map((food, index) => {
          const isWeight = food.portion?.activeMeasurement === 'weight';
          const amount = isWeight ? (food.portion?.w_amount ?? 1) : (food.portion?.amount ?? 1);
          const unit = isWeight ? (food.portion?.w_unit ?? 'g') : (food.portion?.unit ?? 'serving');
          const unitDisplay = getUnitDisplayName(unit, isWeight);
          const nutrients = calculateNutrients(food);
          const absorption = food.details?.absorption_type;

          return (
            <View key={food.id || index} style={styles.foodCard}>
              {/* Food Header */}
              <View style={styles.foodHeader}>
                <View style={styles.foodTitleContainer}>
                  <View style={styles.foodNameRow}>
                    <Text style={styles.foodName} numberOfLines={2}>
                      {food.name}
                    </Text>
                    {absorption && (
                      <View
                        style={[
                          styles.absorptionBadge,
                          { backgroundColor: getAbsorptionColor(absorption) + '20' }
                        ]}
                      >
                        <Text
                          style={[
                            styles.absorptionText,
                            { color: getAbsorptionColor(absorption) }
                          ]}
                        >
                          {formatAbsorptionType(absorption)}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => onRemove(index)}
                >
                  <Text style={styles.removeButtonText}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Measurement Toggle */}
              {onUpdatePortion && (
                <View style={styles.measurementToggle}>
                  <TouchableOpacity
                    style={[styles.toggleButton, isWeight && styles.toggleButtonActive]}
                    onPress={() => handleMeasurementToggle(index)}
                  >
                    <Text style={[styles.toggleText, isWeight && styles.toggleTextActive]}>
                      Weight
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.toggleButton, !isWeight && styles.toggleButtonActive]}
                    onPress={() => handleMeasurementToggle(index)}
                  >
                    <Text style={[styles.toggleText, !isWeight && styles.toggleTextActive]}>
                      Volume
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Portion Control */}
              {onUpdatePortion ? (
                <View style={styles.portionControl}>
                  <View style={styles.amountControl}>
                    <TouchableOpacity
                      style={styles.controlButton}
                      onPress={() => {
                        const next = Math.max(0.5, roundToHalf(amount - 0.5));
                        setInputTexts(prev => ({ ...prev, [food.id]: String(next) }));
                        const newPortion = {
                          ...food.portion,
                          ...(isWeight ? { w_amount: next } : { amount: next })
                        };
                        onUpdatePortion(index, newPortion);
                      }}
                    >
                      <Text style={styles.controlButtonText}>−</Text>
                    </TouchableOpacity>
                    <TextInput
                      style={styles.amountInput}
                      value={inputTexts[food.id] ?? safeToFixed(amount, 1)}
                      onChangeText={(text) => handleAmountTextChange(food, text)}
                      onBlur={() => handleAmountBlur(index, food)}
                      keyboardType="decimal-pad"
                    />
                    <TouchableOpacity
                      style={styles.controlButton}
                      onPress={() => {
                        const next = roundToHalf(amount + 0.5);
                        setInputTexts(prev => ({ ...prev, [food.id]: String(next) }));
                        const newPortion = {
                          ...food.portion,
                          ...(isWeight ? { w_amount: next } : { amount: next })
                        };
                        onUpdatePortion(index, newPortion);
                      }}
                    >
                      <Text style={styles.controlButtonText}>+</Text>
                    </TouchableOpacity>
                  </View>

                  {/* ⭐ Unit selector now opens a modal instead of inline list */}
                  <TouchableOpacity
                    style={styles.unitSelector}
                    onPress={() => openUnitPicker(index)}
                  >
                    <Text style={styles.unitText}>{unitDisplay}</Text>
                    <Text style={styles.dropdownIcon}>▼</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.portionBadge}>
                  <Text style={styles.portionText}>
                    {safeToFixed(amount, 1)} {unitDisplay}
                  </Text>
                </View>
              )}

              {/* Nutrients Grid */}
              <View style={styles.nutrientsGrid}>
                <View style={styles.nutrientItem}>
                  <Text style={styles.nutrientValue}>{safeToFixed(nutrients.carbs, 1)}</Text>
                  <Text style={styles.nutrientLabel}>Carbs</Text>
                </View>
                <View style={styles.nutrientDivider} />
                <View style={styles.nutrientItem}>
                  <Text style={styles.nutrientValue}>{safeToFixed(nutrients.protein, 1)}</Text>
                  <Text style={styles.nutrientLabel}>Protein</Text>
                </View>
                <View style={styles.nutrientDivider} />
                <View style={styles.nutrientItem}>
                  <Text style={styles.nutrientValue}>{safeToFixed(nutrients.fat, 1)}</Text>
                  <Text style={styles.nutrientLabel}>Fat</Text>
                </View>
              </View>


            </View>
          );
        })}
      </ScrollView>

      {/* ⭐ Unit Picker Modal */}
      <Modal
        visible={unitPickerModal.visible}
        transparent
        animationType="slide"
        onRequestClose={closeUnitPicker}
      >
        {/* Backdrop — tap outside to dismiss */}
        <Pressable style={styles.modalBackdrop} onPress={closeUnitPicker}>
          {/* Stop touch propagation so tapping inside the sheet doesn't close it */}
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <SafeAreaView>
              {/* Handle bar */}
              <View style={styles.modalHandle} />

              {/* Header */}
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.modalTitle}>Select Unit</Text>
                  <Text style={styles.modalSubtitle} numberOfLines={1}>
                    {unitPickerModal.foodName}
                  </Text>
                </View>
                <TouchableOpacity style={styles.modalCloseBtn} onPress={closeUnitPicker}>
                  <Text style={styles.modalCloseBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Unit list */}
              <ScrollView
                style={styles.modalList}
                showsVerticalScrollIndicator={false}
              >
                {getAvailableUnits(unitPickerModal.isWeight).map(({ value, label }) => {
                  const isSelected = unitPickerModal.currentUnit === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      style={[styles.modalOption, isSelected && styles.modalOptionSelected]}
                      onPress={() => handleUnitChange(value)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.modalOptionText, isSelected && styles.modalOptionTextSelected]}>
                        {label}
                      </Text>
                      {isSelected && (
                        <Text style={styles.modalCheckmark}>✓</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
                {/* Bottom padding so last item isn't cut off */}
                <View style={{ height: 24 }} />
              </ScrollView>
            </SafeAreaView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    maxHeight: 400
  },
  emptyContainer: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center'
  },
  emptyText: {
    fontSize: 16,
    color: '#999',
    fontWeight: '500',
    marginBottom: 4
  },
  foodCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  foodHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12
  },
  foodTitleContainer: {
    flex: 1,
    marginRight: 8
  },
  foodName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333'
  },
  removeButton: {
    padding: 4,
    borderRadius: 16,
    backgroundColor: '#ffebee',
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  removeButtonText: {
    fontSize: 18,
    color: '#f44336',
    fontWeight: 'bold'
  },
  measurementToggle: {
    flexDirection: 'row',
    backgroundColor: '#e0e0e0',
    borderRadius: 8,
    padding: 2,
    marginBottom: 12
  },
  toggleButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6
  },
  toggleButtonActive: {
    backgroundColor: '#1976d2'
  },
  toggleText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500'
  },
  toggleTextActive: {
    color: '#fff',
    fontWeight: '600'
  },
  portionControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12
  },
  amountControl: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 4
  },
  controlButton: {
    width: 32,
    height: 32,
    backgroundColor: '#1976d2',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  controlButtonText: {
    fontSize: 18,
    color: '#fff',
    fontWeight: '600'
  },
  amountInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  unitSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    minWidth: 100,
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  unitText: {
    fontSize: 13,
    color: '#333',
    fontWeight: '500',
    flex: 1
  },
  dropdownIcon: {
    fontSize: 10,
    color: '#666',
    marginLeft: 4
  },
  portionBadge: {
    backgroundColor: '#e3f2fd',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    alignSelf: 'flex-start',
    marginBottom: 12
  },
  portionText: {
    fontSize: 13,
    color: '#1976d2',
    fontWeight: '600'
  },
  nutrientsGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8
  },
  nutrientItem: {
    alignItems: 'center',
    flex: 1
  },
  nutrientValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1976d2',
    marginBottom: 2
  },
  nutrientLabel: {
    fontSize: 11,
    color: '#666',
    fontWeight: '500'
  },
  nutrientDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#e0e0e0'
  },
  foodNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6
  },
  absorptionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    alignSelf: 'center'
  },
  absorptionText: {
    fontSize: 11,
    fontWeight: '600'
  },
  // ⭐ Modal styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end'
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    paddingHorizontal: 16,
    paddingTop: 8
  },
  modalHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#ddd',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    marginBottom: 4
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#333'
  },
  modalSubtitle: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
    maxWidth: 220
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center'
  },
  modalCloseBtnText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600'
  },
  modalList: {
    marginTop: 4
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5'
  },
  modalOptionSelected: {
    backgroundColor: '#e3f2fd',
    marginHorizontal: -4,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderBottomColor: 'transparent'
  },
  modalOptionText: {
    fontSize: 15,
    color: '#333'
  },
  modalOptionTextSelected: {
    color: '#1976d2',
    fontWeight: '600'
  },
  modalCheckmark: {
    fontSize: 16,
    color: '#1976d2',
    fontWeight: '700'
  }
});

export default SelectedFoodsList;