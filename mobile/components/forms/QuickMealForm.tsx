/**
 * QuickMealForm
 * Location: mobile/components/forms/QuickMealForm.tsx
 *
 * Single-screen quick meal logger with FoodSearch inlined directly.
 * No modals for food search — everything visible at once.
 * Activity / blood sugar / insulin fields omitted (submitted as undefined).
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Alert,
} from 'react-native';

import SelectedFoodsList from '../meal/SelectedFoodsList';
import UnifiedTimePicker, { type TimeMode } from './UnifiedTimePicker';
import { searchFoods, getCategories, getFavorites, addToFavorites } from '@/services/api/food';
// ✅ Live PK snapshot resolver — merges AED live data with stale API snapshot
import { resolveLiveEffects } from '@/utils/calculations/resolve-live-effects';
import type { ActiveEffectData } from '@/types/active-effects.types';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface MealFormData {
  mealType: string;
  mealTime: string;
  selectedFoods: any[];
  activityIds?: string[];
  bloodSugar?: number;
  bloodSugarTimestamp?: string;
  bloodSugarUnit?: string;
  intendedInsulin?: number;
  intendedInsulinType?: string;
  insulinTimestamp?: string;
  notes?: string;
  calculationFactors?: any;
}

interface QuickMealFormProps {
  onSubmit: (data: MealFormData) => void;
  onCancel: () => void;
  isLoading: boolean;
  /**
   * Live PK snapshot from ActiveEffectsDisplay.onEffectsComputed().
   *
   * When provided, the resolved active-effects scalars (IOB, MOB, AOB,
   * sensitivityMultiplier, estimatedBG) are attached to the submission as
   * `calculationFactors` so the backend / parent has pharmacokinetic context
   * at the time of logging — consistent with what MealForm sends.
   *
   * Wire up at the screen level:
   *   const [aedSnapshot, setAedSnapshot] = useState<ActiveEffectData | null>(null);
   *   <ActiveEffectDisplay onEffectsComputed={setAedSnapshot} />
   *   <QuickMealForm liveActiveEffects={aedSnapshot ?? undefined} … />
   */
  liveActiveEffects?: ActiveEffectData;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MEAL_TYPES = [
  { value: 'breakfast', label: 'Breakfast', icon: '🌅' },
  { value: 'lunch',     label: 'Lunch',     icon: '☀️' },
  { value: 'dinner',    label: 'Dinner',    icon: '🌙' },
  { value: 'snack',     label: 'Snack',     icon: '🍎' },
];

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const QuickMealForm: React.FC<QuickMealFormProps> = ({ onSubmit, onCancel, isLoading, liveActiveEffects }) => {

  // ── Form state ────────────────────────────────────────────────────────────
  const [mealType,     setMealType]     = useState('breakfast');
  const [mealTimeUTC,  setMealTimeUTC]  = useState<string>(new Date().toISOString());
  const [mealTimeMode, setMealTimeMode] = useState<TimeMode>('now');
  const [selectedFoods, setSelectedFoods] = useState<any[]>([]);
  const [notes,        setNotes]        = useState('');
  const [message,      setMessage]      = useState('');

  // ── Food search state (inlined from FoodSearch) ───────────────────────────
  const [searchQuery,           setSearchQuery]           = useState('');
  const [selectedCategory,      setSelectedCategory]      = useState('');
  const [categories,            setCategories]            = useState<any[]>([]);
  const [searchResults,         setSearchResults]         = useState<any[]>([]);
  const [favorites,             setFavorites]             = useState<any[]>([]);
  const [isSearchLoading,       setIsSearchLoading]       = useState(false);
  const [searchTab,             setSearchTab]             = useState<'search' | 'favorites'>('search');
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadCategories();
    loadFavorites();
  }, []);

  // ── Debounced search ──────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.length >= 2 || (searchQuery.length === 0 && selectedCategory)) {
        performSearch();
      } else if (searchQuery.length < 2 && !selectedCategory) {
        setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, selectedCategory]);

  // ── Food search helpers ───────────────────────────────────────────────────

  const loadCategories = async () => {
    try {
      const data = await getCategories();
      setCategories(Object.keys(data.categories || {}));
    } catch (e) {
      console.error('Failed to load categories:', e);
    }
  };

  const loadFavorites = async () => {
    try {
      const data = await getFavorites();
      setFavorites(data);
    } catch (e) {
      console.error('Failed to load favorites:', e);
    }
  };

  const performSearch = async () => {
    setIsSearchLoading(true);
    try {
      const results = await searchFoods({ query: searchQuery, category: selectedCategory });
      // Client-side filter: only keep items whose name includes the typed query
      const filtered = searchQuery.length >= 2
        ? results.filter((food: any) =>
            food.name?.toLowerCase().includes(searchQuery.toLowerCase())
          )
        : results;
      setSearchResults(filtered);
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      setIsSearchLoading(false);
    }
  };

  const handleAddToFavorites = async (food: any) => {
    try {
      await addToFavorites(food.name);
      Alert.alert('Success', `${food.name} added to favorites`);
      loadFavorites();
    } catch (e) {
      Alert.alert('Error', 'Failed to add to favorites');
    }
  };

  const buildSelectedFood = (food: any): any | null => {
    if (!food.details) {
      Alert.alert('Error', 'Food item is missing nutritional information');
      return null;
    }
    const carbs   = parseFloat(food.details.carbs)   || 0;
    const protein = parseFloat(food.details.protein) || 0;
    const fat     = parseFloat(food.details.fat)     || 0;
    const serving = food.details.serving_size || {};
    const hasWeight = Boolean(serving.w_amount && serving.w_unit);
    const roundToHalf = (v: number) => Math.round(v * 2) / 2;

    return {
      id: Date.now(),
      name: food.name,
      portion: {
        amount:            roundToHalf(serving.amount   || 1),
        unit:              serving.unit    || 'serving',
        w_amount:          roundToHalf(serving.w_amount || 100),
        w_unit:            serving.w_unit  || 'g',
        activeMeasurement: (hasWeight ? 'weight' : 'volume') as 'weight' | 'volume',
        baseAmount:        serving.amount   || 1,
        baseUnit:          serving.unit     || 'serving',
        baseWAmount:       serving.w_amount || 100,
        baseWUnit:         serving.w_unit   || 'g',
      },
      details: {
        carbs, protein, fat,
        absorption_type: food.details.absorption_type || 'medium',
        serving_size: {
          amount:   serving.amount   || 1,
          unit:     serving.unit     || 'serving',
          w_amount: serving.w_amount || 100,
          w_unit:   serving.w_unit   || 'g',
        },
      },
    };
  };

  const handleFoodSelect = (food: any) => {
    const built = buildSelectedFood(food);
    if (!built) return;
    if (built.details.carbs === 0 && built.details.protein === 0 && built.details.fat === 0) {
      Alert.alert(
        'Warning',
        'This food has no nutritional data.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Add Anyway', onPress: () => setSelectedFoods(prev => [...prev, built]) },
        ],
      );
      return;
    }
    setSelectedFoods(prev => [...prev, built]);
  };

  const handleFoodRemove = (index: number) => {
    setSelectedFoods(prev => prev.filter((_, i) => i !== index));
  };

  const handleFoodPortionUpdate = (index: number, portion: any) => {
    setSelectedFoods(prev =>
      prev.map((food, i) => (i === index ? { ...food, portion } : food)),
    );
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = () => {
    if (selectedFoods.length === 0) {
      setMessage('Please add at least one food item.');
      return;
    }

    // ── Resolve live active effects snapshot for submission context ───────────
    // QuickMealForm doesn't carry a stale API snapshot or activityPD — only the
    // live AED snapshot is available here. Path B (lae absent) falls through to
    // all-zeros gracefully, so resolveLiveEffects is always safe to call.
    const r = resolveLiveEffects(liveActiveEffects, undefined, undefined);

    const formData: MealFormData = {
      mealType,
      mealTime: mealTimeUTC,
      selectedFoods: selectedFoods.map(food => {
        const isWeight = food.portion?.activeMeasurement === 'weight';
        return {
          name: food.name,
          portion: {
            amount:           isWeight ? (food.portion.w_amount || food.portion.amount) : (food.portion.amount || 1),
            unit:             isWeight ? (food.portion.w_unit   || food.portion.unit)   : (food.portion.unit   || 'serving'),
            measurement_type: food.portion.activeMeasurement || 'weight',
          },
          details: {
            carbs:           parseFloat(food.details?.carbs)   || 0,
            protein:         parseFloat(food.details?.protein) || 0,
            fat:             parseFloat(food.details?.fat)     || 0,
            absorption_type: food.details?.absorption_type     || 'medium',
            serving_size:    food.details?.serving_size        || { amount: 1, unit: 'serving' },
          },
        };
      }),
      notes: notes.trim() || undefined,
      // Attach the PK snapshot as calculationFactors when the live AED data is
      // available — gives the backend pharmacokinetic context at logging time.
      // Mirrors the calculationFactors shape emitted by MealForm on submit.
      calculationFactors: r.isLive ? {
        activeInsulin:           r.activeInsulinUnits,
        activeMealCarbs:         r.activeMealCarbs,
        pendingInsulinReduction: r.pendingInsulinReduction,
        pendingMealRise:         r.pendingMealRise,
        sensitivityMultiplier:   r.sensitivityMultiplier,
        activityOnBoard:         r.activityOnBoard,
        estimatedBG:             r.estimatedBG ?? undefined,
        pkSnapshotAt:            new Date().toISOString(),
      } : undefined,
    };
    onSubmit(formData);
  };

  // ── Food result row ───────────────────────────────────────────────────────

  const renderFoodItem = (food: any, index: number) => (
    <TouchableOpacity
      key={index}
      style={styles.foodItem}
      onPress={() => handleFoodSelect(food)}
    >
      <View style={styles.foodItemContent}>
        <Text style={styles.foodItemName}>{food.name}</Text>
        <View style={styles.foodItemMacros}>
          <Text style={styles.foodItemNutrient}>{food.details?.carbs || 0}g carbs</Text>
          <Text style={styles.nutrientDot}>·</Text>
          <Text style={styles.foodItemNutrient}>{food.details?.protein || 0}g protein</Text>
          <Text style={styles.nutrientDot}>·</Text>
          <Text style={styles.foodItemNutrient}>{food.details?.fat || 0}g fat</Text>
        </View>
        {food.details?.serving_size && (
          <Text style={styles.servingSize}>
            Serving: {food.details.serving_size.amount} {food.details.serving_size.unit}
            {food.details.serving_size.w_amount
              ? ` (${food.details.serving_size.w_amount}${food.details.serving_size.w_unit})`
              : ''}
          </Text>
        )}
      </View>
      <View style={styles.foodItemActions}>
        <TouchableOpacity
          style={styles.favBtn}
          onPress={() => handleAddToFavorites(food)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.favIcon}>⭐</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => handleFoodSelect(food)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.addIcon}>+</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Header ── */}
      <Text style={styles.title}>Quick Meal Log</Text>

      {!!message && (
        <View style={styles.messageBox}>
          <Text style={styles.messageText}>{message}</Text>
        </View>
      )}

      {/* ── Meal Type chips ── */}
      <Text style={styles.label}>Meal Type *</Text>
      <View style={styles.chipRow}>
        {MEAL_TYPES.map(t => (
          <TouchableOpacity
            key={t.value}
            style={[styles.chip, mealType === t.value && styles.chipActive]}
            onPress={() => setMealType(t.value)}
          >
            <Text style={styles.chipIcon}>{t.icon}</Text>
            <Text style={[styles.chipText, mealType === t.value && styles.chipTextActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Food Search + Selected Foods (inlined) ── */}
      <View style={styles.card}>
        <Text style={styles.label}>Food Items *</Text>

        {/* Search / Favorites tabs */}
        <View style={styles.searchTabs}>
          <TouchableOpacity
            style={[styles.searchTab, searchTab === 'search' && styles.searchTabActive]}
            onPress={() => setSearchTab('search')}
          >
            <Text style={[styles.searchTabText, searchTab === 'search' && styles.searchTabTextActive]}>
              🔍 Search
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.searchTab, searchTab === 'favorites' && styles.searchTabActive]}
            onPress={() => setSearchTab('favorites')}
          >
            <Text style={[styles.searchTabText, searchTab === 'favorites' && styles.searchTabTextActive]}>
              ⭐ Favorites
            </Text>
          </TouchableOpacity>
        </View>

        {/* Search input + category trigger */}
        {searchTab === 'search' && (
          <View style={styles.searchControls}>
            <View style={styles.searchInputWrapper}>
              <Text style={styles.searchIcon}>🔍</Text>
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search for food..."
                placeholderTextColor="#888888"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.clearIcon}>✕</Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={styles.categoryTrigger}
              onPress={() => setCategoryPickerVisible(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.categoryTriggerValue} numberOfLines={1}>
                {selectedCategory
                  ? selectedCategory.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                  : 'All Categories'}
              </Text>
              <Text style={styles.categoryChevron}>▾</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Results */}
        <View style={styles.resultsList}>
          {searchTab === 'search' && (
            isSearchLoading ? (
              <ActivityIndicator style={styles.loader} color="#1976d2" />
            ) : searchResults.length > 0 ? (
              searchResults.map(renderFoodItem)
            ) : (
              <Text style={styles.emptyText}>
                {searchQuery || selectedCategory ? 'No foods found' : searchQuery.length === 1 ? 'Keep typing…' : 'Type at least 2 characters or pick a category'}
              </Text>
            )
          )}
          {searchTab === 'favorites' && (
            favorites.length > 0
              ? favorites.map(renderFoodItem)
              : <Text style={styles.emptyText}>No favorites yet — tap ⭐ on any food to save it</Text>
          )}
        </View>

        {/* Selected foods */}
        {selectedFoods.length > 0 && (
          <View style={styles.selectedSection}>
            <Text style={styles.selectedHeader}>Added ({selectedFoods.length})</Text>
            <SelectedFoodsList
              foods={selectedFoods}
              onRemove={handleFoodRemove}
              onUpdatePortion={handleFoodPortionUpdate}
            />
          </View>
        )}
      </View>

      {/* ── Meal Time ── */}
      <View style={styles.card}>
        <UnifiedTimePicker
          value={mealTimeUTC}
          onChange={(val: string) => setMealTimeUTC(val)}
          mode={mealTimeMode}
          onModeChange={(m: TimeMode) => setMealTimeMode(m)}
          label="When did you eat? *"
          showModeSelector={true}
          displayFormat="datetime"
        />
      </View>

      {/* ── Notes ── */}
      <View style={styles.card}>
        <Text style={styles.label}>Notes (optional)</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Any notes about this meal…"
          placeholderTextColor="#888"
          multiline
          numberOfLines={3}
        />
      </View>

      {/* ── Actions ── */}
      <View style={styles.btnRow}>
        <TouchableOpacity
          style={[styles.btn, styles.cancelBtn]}
          onPress={onCancel}
          disabled={isLoading}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.submitBtn, (isLoading || selectedFoods.length === 0) && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={isLoading || selectedFoods.length === 0}
        >
          {isLoading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.submitBtnText}>Log Meal</Text>}
        </TouchableOpacity>
      </View>

      {/* ── Category picker bottom-sheet ── */}
      <Modal
        visible={categoryPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCategoryPickerVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalDismissArea}
            activeOpacity={1}
            onPress={() => setCategoryPickerVisible(false)}
          />
          <View style={styles.categorySheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Filter by Category</Text>
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              <TouchableOpacity
                style={[styles.categoryOption, !selectedCategory && styles.categoryOptionActive]}
                onPress={() => { setSelectedCategory(''); setCategoryPickerVisible(false); }}
              >
                <Text style={[styles.categoryOptionText, !selectedCategory && styles.categoryOptionTextActive]}>
                  All Categories
                </Text>
                {!selectedCategory && <Text style={styles.checkmark}>✓</Text>}
              </TouchableOpacity>
              {categories.map(cat => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.categoryOption, selectedCategory === cat && styles.categoryOptionActive]}
                  onPress={() => { setSelectedCategory(cat); setCategoryPickerVisible(false); }}
                >
                  <Text style={[styles.categoryOptionText, selectedCategory === cat && styles.categoryOptionTextActive]}>
                    {cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </Text>
                  {selectedCategory === cat && <Text style={styles.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

    </ScrollView>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:   { flex: 1, backgroundColor: '#f5f5f5' },
  content:  { padding: 16, paddingBottom: 40 },

  title:    { fontSize: 22, fontWeight: 'bold', color: '#333', marginBottom: 16 },
  label:    { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 8 },

  messageBox:  { backgroundColor: '#fce4ec', borderRadius: 8, padding: 10, marginBottom: 12 },
  messageText: { color: '#c62828', fontSize: 14 },

  // ── Meal type chips ────────────────────────────────────────────────────────
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  chip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    backgroundColor: '#f8f9fa',
    gap: 3,
  },
  chipActive:     { borderColor: '#1976d2', backgroundColor: '#e3f2fd' },
  chipIcon:       { fontSize: 18 },
  chipText:       { fontSize: 11, fontWeight: '600', color: '#666' },
  chipTextActive: { color: '#1976d2' },

  // ── Card wrapper ───────────────────────────────────────────────────────────
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 12 },

  // ── Search tabs ────────────────────────────────────────────────────────────
  searchTabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    marginBottom: 10,
  },
  searchTab:           { flex: 1, paddingVertical: 10, alignItems: 'center' },
  searchTabActive:     { borderBottomWidth: 2, borderBottomColor: '#1976d2' },
  searchTabText:       { fontSize: 13, color: '#888' },
  searchTabTextActive: { color: '#1976d2', fontWeight: '600' },

  // ── Search controls ────────────────────────────────────────────────────────
  searchControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  searchInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 42,
  },
  searchIcon:  { fontSize: 14, marginRight: 6 },
  clearIcon:   { fontSize: 13, color: '#888', paddingHorizontal: 4 },
  searchInput: { flex: 1, fontSize: 14, color: '#000', height: 42 },

  categoryTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f4ff',
    borderWidth: 1,
    borderColor: '#c5cae9',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 42,
    width: 130,
    gap: 4,
  },
  categoryTriggerValue: { flex: 1, fontSize: 12, color: '#1976d2', fontWeight: '600' },
  categoryChevron:      { fontSize: 14, color: '#1976d2' },

  // ── Results ────────────────────────────────────────────────────────────────
  resultsList: { minHeight: 60 },
  loader:      { paddingVertical: 20 },
  emptyText:   { fontSize: 13, color: '#aaa', textAlign: 'center', paddingVertical: 20 },

  foodItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  foodItemContent:  { flex: 1 },
  foodItemName:     { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 3 },
  foodItemMacros:   { flexDirection: 'row', alignItems: 'center' },
  foodItemNutrient: { fontSize: 11, color: '#666' },
  nutrientDot:      { fontSize: 11, color: '#ccc', marginHorizontal: 4 },
  servingSize:      { fontSize: 11, color: '#aaa', marginTop: 2 },

  foodItemActions: { flexDirection: 'row', gap: 8, alignItems: 'center', marginLeft: 8 },
  favBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#fff3cd',
    alignItems: 'center', justifyContent: 'center',
  },
  favIcon: { fontSize: 16 },
  addBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#1976d2',
    alignItems: 'center', justifyContent: 'center',
  },
  addIcon: { fontSize: 20, color: '#fff', fontWeight: '700' },

  // ── Selected foods ─────────────────────────────────────────────────────────
  selectedSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    paddingTop: 12,
  },
  selectedHeader: { fontSize: 13, fontWeight: '600', color: '#1976d2', marginBottom: 8 },

  // ── Notes ──────────────────────────────────────────────────────────────────
  input:    { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, padding: 12, fontSize: 14, color: '#000' },
  textArea: { height: 80, textAlignVertical: 'top' },

  // ── Action buttons ─────────────────────────────────────────────────────────
  btnRow:        { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn:           { flex: 1, padding: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cancelBtn:     { backgroundColor: '#f5f5f5', borderWidth: 1, borderColor: '#e0e0e0' },
  cancelBtnText: { color: '#666', fontSize: 15, fontWeight: '600' },
  submitBtn:     { backgroundColor: '#1976d2' },
  submitBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  btnDisabled:   { opacity: 0.5 },

  // ── Category bottom-sheet ──────────────────────────────────────────────────
  modalOverlay:     { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  modalDismissArea: { flex: 1 },
  categorySheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 12,
    maxHeight: '65%',
  },
  sheetHandle:              { width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2, alignSelf: 'center', marginBottom: 14 },
  sheetTitle:               { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 12 },
  categoryOption:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  categoryOptionActive:     { backgroundColor: '#e8f0fe' },
  categoryOptionText:       { fontSize: 14, color: '#333' },
  categoryOptionTextActive: { color: '#1976d2', fontWeight: '600' },
  checkmark:                { fontSize: 16, color: '#1976d2', fontWeight: '700' },
});

export default QuickMealForm;