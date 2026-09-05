/**
 * Food Database Settings Screen
 * Location: mobile/app/(app)/settings/food-database.tsx
 *
 * Main Function: FoodDatabaseScreen
 * Description: Browse, search, and manage the food database from settings.
 *              Migrated from web FoodSection.js / FoodDatabase.js.
 *
 * Features:
 * - Search foods with debounce (300 ms)
 * - Filter by category (dropdown)
 * - Add / remove favorites
 * - Create custom food entries
 * - Dual measurement system toggle (weight ↔ volume) per item
 * - Nutrient breakdown (carbs / protein / fat / absorption)
 * - Full parity with FoodSection.js web component
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import SelectedFoodsList from '@/components/meal/SelectedFoodsList';

// Services
import foodService, {
  type FoodItem,
  type CategoriesResponse,
  type CustomFoodData,
} from '@/services/api/food';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import {
  VOLUME_MEASUREMENTS,
  WEIGHT_MEASUREMENTS,
} from '@/constants/shared-constants';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function absorptionColor(type: string): string {
  switch (type) {
    case 'very_fast': return colors.error ?? '#ef4444';
    case 'fast':      return '#f97316';
    case 'medium':    return '#eab308';
    case 'slow':      return '#22c55e';
    case 'very_slow': return '#3b82f6';
    default:          return colors.text?.secondary ?? '#6b7280';
  }
}

function formatCategoryLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// FoodCard — single search result row
// ─────────────────────────────────────────────────────────────────────────────

interface FoodCardProps {
  food: FoodItem;
  isFavorite: boolean;
  showRemoveButton?: boolean;
  onAddFavorite: (food: FoodItem) => void;
  onRemoveFavorite?: (food: FoodItem) => void;
  onSelect: (food: FoodItem) => void;
}

const FoodCard: React.FC<FoodCardProps> = ({ food, isFavorite, showRemoveButton, onAddFavorite, onRemoveFavorite, onSelect }) => (
  <View style={styles.foodCard}>
    <View style={styles.foodCardInfo}>
      <Text style={styles.foodCardName}>{food.name}</Text>
      {food.category && (
        <Text style={styles.foodCardCategory}>{formatCategoryLabel(food.category)}</Text>
      )}
      {food.details && (
        <Text style={styles.foodCardMacros}>
          C: {food.details.carbs}g · P: {food.details.protein}g · F: {food.details.fat}g
        </Text>
      )}
    </View>
    <View style={styles.foodCardActions}>
      {showRemoveButton ? (
        <TouchableOpacity
          style={styles.removeButton}
          onPress={() => onRemoveFavorite?.(food)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={14} color="#ef4444" />
          <Text style={styles.removeButtonText}>Remove</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.iconButton, isFavorite && styles.iconButtonActive]}
          onPress={() => isFavorite ? onRemoveFavorite?.(food) : onAddFavorite(food)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name={isFavorite ? 'heart' : 'heart-outline'}
            size={18}
            color={isFavorite ? '#ef4444' : colors.text?.secondary}
          />
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.addButton} onPress={() => onSelect(food)}>
        <Ionicons name="add" size={16} color="#fff" />
        <Text style={styles.addButtonText}>Add</Text>
      </TouchableOpacity>
    </View>
  </View>
);

// ─────────────────────────────────────────────────────────────────────────────
// CustomFoodModal
// ─────────────────────────────────────────────────────────────────────────────

interface CustomFoodModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: CustomFoodData) => Promise<void>;
}

const CustomFoodModal: React.FC<CustomFoodModalProps> = ({ visible, onClose, onSave }) => {
  const [name, setName]         = useState('');
  const [carbs, setCarbs]       = useState('');
  const [protein, setProtein]   = useState('');
  const [fat, setFat]           = useState('');
  const [amount, setAmount]     = useState('100');
  const [unit, setUnit]         = useState('g');
  const [saving, setSaving]     = useState(false);

  const reset = () => { setName(''); setCarbs(''); setProtein(''); setFat(''); setAmount('100'); setUnit('g'); };

  const handleSave = async () => {
    if (!name.trim() || !carbs || !protein || !fat) {
      Alert.alert('Missing fields', 'Please fill in name, carbs, protein and fat.');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        carbs: parseFloat(carbs),
        protein: parseFloat(protein),
        fat: parseFloat(fat),
        serving_size: { amount: parseFloat(amount) || 100, unit },
        absorption_type: 'medium',
      });
      reset();
      onClose();
    } catch {
      Alert.alert('Error', 'Failed to save custom food.');
    } finally {
      setSaving(false);
    }
  };

  const Field = ({ label, value, onChangeText, keyboardType = 'default' }: {
    label: string; value: string; onChangeText: (v: string) => void; keyboardType?: 'default' | 'numeric';
  }) => (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholderTextColor={colors.text?.secondary}
      />
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
        <View style={styles.customFoodSheet}>
          <View style={styles.customFoodHeader}>
            <Text style={styles.customFoodTitle}>Add Custom Food</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.text?.primary} />
            </TouchableOpacity>
          </View>
          <ScrollView>
            <Field label="Name" value={name} onChangeText={setName} />
            <Field label="Carbs (g)" value={carbs} onChangeText={setCarbs} keyboardType="numeric" />
            <Field label="Protein (g)" value={protein} onChangeText={setProtein} keyboardType="numeric" />
            <Field label="Fat (g)" value={fat} onChangeText={setFat} keyboardType="numeric" />
            <View style={styles.servingRow}>
              <View style={[styles.fieldRow, { flex: 2, marginRight: spacing.sm }]}>
                <Text style={styles.fieldLabel}>Serving amount</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="numeric"
                  placeholderTextColor={colors.text?.secondary}
                />
              </View>
              <View style={[styles.fieldRow, { flex: 1 }]}>
                <Text style={styles.fieldLabel}>Unit</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={unit}
                  onChangeText={setUnit}
                  autoCapitalize="none"
                  placeholderTextColor={colors.text?.secondary}
                />
              </View>
            </View>
          </ScrollView>
          <TouchableOpacity style={styles.saveButton} onPress={handleSave} disabled={saving}>
            {saving
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.saveButtonText}>Save Food</Text>
            }
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function FoodDatabaseScreen() {
  // Search / categories
  const [query, setQuery]               = useState('');
  const [category, setCategory]         = useState('');
  const [categories, setCategories]     = useState<string[]>([]);
  const [results, setResults]           = useState<FoodItem[]>([]);
  const [favorites, setFavorites]       = useState<FoodItem[]>([]);
  const [favoriteNames, setFavoriteNames] = useState<Set<string>>(new Set());
  const [tab, setTab]                   = useState<'search' | 'favorites' | 'selected'>('search');
  const [loading, setLoading]           = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);

  // Selected foods (with portion state) — shape matches SelectedFoodsList's Food interface
  const [selectedFoods, setSelectedFoods] = useState<any[]>([]);

  // Custom food modal
  const [customModalVisible, setCustomModalVisible] = useState(false);

  // Toast-like message
  const [toast, setToast] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load categories + favorites on mount ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [catRes, favRes] = await Promise.all([
          foodService.getCategories(),
          foodService.getFavorites(),
        ]);
        setCategories(Object.keys(catRes.categories ?? {}));
        setFavorites(favRes);
        setFavoriteNames(new Set(favRes.map((f) => f.name)));
      } catch (e) {
        showToast('Failed to load data');
      }
    })();
  }, []);

  // ── Debounced search ───────────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query && !category) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await foodService.searchFoods({ query, category: category || undefined });
        // Client-side filter: only keep items whose name includes the typed query
        const filtered = query.length >= 2
          ? res.filter((food: FoodItem) =>
              food.name?.toLowerCase().includes(query.toLowerCase())
            )
          : res;
        setResults(filtered);
      } catch {
        showToast('Search failed');
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, category]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const handleAddFavorite = useCallback(async (food: FoodItem) => {
    if (favoriteNames.has(food.name)) return;
    try {
      await foodService.addToFavorites(food.name);
      setFavoriteNames((prev) => new Set([...prev, food.name]));
      setFavorites((prev) => [...prev, food]);
      showToast('Added to favorites');
    } catch {
      showToast('Could not add to favorites');
    }
  }, [favoriteNames]);

  const handleRemoveFavorite = useCallback(async (food: FoodItem) => {
    try {
      await foodService.removeFromFavorites(food.name);
      setFavoriteNames((prev) => { const next = new Set(prev); next.delete(food.name); return next; });
      setFavorites((prev) => prev.filter((f) => f.name !== food.name));
      showToast('Removed from favorites');
    } catch {
      showToast('Could not remove from favorites');
    }
  }, []);

  const handleSelectFood = useCallback((food: FoodItem) => {
    const serving = food.details?.serving_size;
    const hasWeight = Boolean(serving?.w_amount);
    const roundToHalf = (v: number) => Math.round(v * 2) / 2;
    const entry = {
      id: Date.now() + Math.random(),
      name: food.name,
      portion: {
        activeMeasurement: (hasWeight ? 'weight' : 'volume') as 'weight' | 'volume',
        amount:   roundToHalf(serving?.amount   ?? 1),
        unit:     serving?.unit    ?? 'serving',
        w_amount: roundToHalf(serving?.w_amount ?? 100),
        w_unit:   serving?.w_unit  ?? 'g',
      },
      details: food.details,
    };
    setSelectedFoods((prev) => [...prev, entry]);
    setTab('selected');
    showToast(`${food.name} added`);
  }, []);

  // index-based update — matches SelectedFoodsList's onUpdatePortion(index, newPortion)
  const handleUpdateFood = useCallback((index: number, newPortion: any) => {
    setSelectedFoods((prev) => prev.map((f, i) => i === index ? { ...f, portion: newPortion } : f));
  }, []);

  // index-based remove — matches SelectedFoodsList's onRemove(index)
  const handleRemoveFood = useCallback((index: number) => {
    setSelectedFoods((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSaveCustomFood = async (data: CustomFoodData) => {
    await foodService.createCustomFood(data);
    showToast('Custom food saved');
    // Refresh results if query active
    if (query || category) {
      const res = await foodService.searchFoods({ query, category: category || undefined });
      const filtered = query.length >= 2
        ? res.filter((food: FoodItem) =>
            food.name?.toLowerCase().includes(query.toLowerCase())
          )
        : res;
      setResults(filtered);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      {/* ── Tab bar ── */}
      <View style={styles.tabBar}>
        {([
          { key: 'search',    icon: 'search',        label: 'Search'    },
          { key: 'favorites', icon: 'heart',          label: 'Favorites' },
          { key: 'selected',  icon: 'basket-outline', label: `Selected${selectedFoods.length ? ` (${selectedFoods.length})` : ''}` },
        ] as const).map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tabItem, tab === t.key && styles.tabItemActive]}
            onPress={() => setTab(t.key)}
          >
            <Ionicons name={t.icon as any} size={18} color={tab === t.key ? colors.primary : colors.text?.secondary} />
            <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Search tab ── */}
      {tab === 'search' && (
        <View style={styles.flex1}>
          {/* Search bar + category */}
          <View style={styles.searchBar}>
            <View style={styles.searchInputWrapper}>
              <Ionicons name="search" size={16} color={colors.text?.secondary} style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search foods…"
                placeholderTextColor={colors.text?.secondary}
                autoCapitalize="none"
                returnKeyType="search"
              />
              {query.length > 0 && (
                <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={16} color={colors.text?.secondary} />
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity style={styles.categoryTrigger} onPress={() => setCategoryPickerVisible(true)}>
              <Text style={styles.categoryTriggerText} numberOfLines={1}>
                {category ? formatCategoryLabel(category) : 'All'}
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.text?.secondary} />
            </TouchableOpacity>
          </View>

          {/* Add custom food button */}
          <TouchableOpacity style={styles.customFoodBtn} onPress={() => setCustomModalVisible(true)}>
            <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
            <Text style={styles.customFoodBtnText}>Add Custom Food</Text>
          </TouchableOpacity>

          {/* Results */}
          {loading ? (
            <ActivityIndicator style={styles.loader} color={colors.primary} />
          ) : (
            <ScrollView style={styles.resultsList} keyboardShouldPersistTaps="handled">
              {results.length === 0 && (query || category) && !loading && (
                <Text style={styles.emptyText}>No foods found</Text>
              )}
              {results.length === 0 && !query && !category && (
                <Text style={styles.emptyText}>Search or select a category to browse foods</Text>
              )}
              {results.map((food) => (
                <FoodCard
                  key={`${food.name}-${food.category}`}
                  food={food}
                  isFavorite={favoriteNames.has(food.name)}
                  onAddFavorite={handleAddFavorite}
                  onRemoveFavorite={handleRemoveFavorite}
                  onSelect={handleSelectFood}
                />
              ))}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── Favorites tab ── */}
      {tab === 'favorites' && (
        <ScrollView style={styles.flex1} contentContainerStyle={styles.listPadding}>
          {favorites.length === 0 && (
            <Text style={styles.emptyText}>No favorites yet — heart a food to save it here</Text>
          )}
          {favorites.map((food) => (
            <FoodCard
              key={food.name}
              food={food}
              isFavorite
              showRemoveButton
              onAddFavorite={handleAddFavorite}
              onRemoveFavorite={handleRemoveFavorite}
              onSelect={handleSelectFood}
            />
          ))}
        </ScrollView>
      )}

      {/* ── Selected tab ── */}
      {tab === 'selected' && (
        <View style={styles.flex1}>
          <SelectedFoodsList
            foods={selectedFoods}
            onRemove={handleRemoveFood}
            onUpdatePortion={handleUpdateFood}
          />
        </View>
      )}

      {/* ── Category picker modal ── */}
      <Modal
        visible={categoryPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCategoryPickerVisible(false)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setCategoryPickerVisible(false)}>
          <View style={styles.unitPickerSheet}>
            <Text style={styles.unitPickerTitle}>Filter by Category</Text>
            <ScrollView>
              <TouchableOpacity
                style={[styles.unitOption, !category && styles.unitOptionActive]}
                onPress={() => { setCategory(''); setCategoryPickerVisible(false); }}
              >
                <Text style={[styles.unitOptionText, !category && styles.unitOptionTextActive]}>All Categories</Text>
                {!category && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </TouchableOpacity>
              {categories.map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.unitOption, category === cat && styles.unitOptionActive]}
                  onPress={() => { setCategory(cat); setCategoryPickerVisible(false); }}
                >
                  <Text style={[styles.unitOptionText, category === cat && styles.unitOptionTextActive]}>
                    {formatCategoryLabel(cat)}
                  </Text>
                  {category === cat && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Custom food modal ── */}
      <CustomFoodModal
        visible={customModalVisible}
        onClose={() => setCustomModalVisible(false)}
        onSave={handleSaveCustomFood}
      />

      {/* ── Toast ── */}
      {toast.length > 0 && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea:    { flex: 1, backgroundColor: colors.background },
  flex1:       { flex: 1 },
  listPadding: { padding: spacing.md, paddingBottom: spacing.xl },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface ?? colors.background,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: 4,
  },
  tabItemActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabLabel:       { ...typography.small, color: colors.text?.secondary },
  tabLabelActive: { color: colors.primary, fontWeight: '600' },

  // Search bar
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    backgroundColor: colors.surface ?? colors.background,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
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
  searchIcon:  { marginRight: 6 },
  searchInput: { flex: 1, ...typography.body, color: colors.text?.primary, height: 42 },
  categoryTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f4ff',
    borderWidth: 1,
    borderColor: '#c5cae9',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 42,
    gap: 4,
    width: 110,
  },
  categoryTriggerText: { ...typography.small, color: '#1976d2', fontWeight: '600', flexShrink: 1 },

  // Custom food button
  customFoodBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: '#e8f0fe',
  },
  customFoodBtnText: { fontSize: 15, color: colors.primary, fontWeight: '700' },

  loader:      { marginTop: spacing.xl },
  resultsList: { flex: 1 },
  emptyText:   { ...typography.body, color: colors.text?.secondary, textAlign: 'center', marginTop: spacing.xl, paddingHorizontal: spacing.md },

  // Food card
  foodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface ?? '#fff',
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  foodCardInfo:     { flex: 1 },
  foodCardName:     { ...typography.body, color: colors.text?.primary, fontWeight: '600' },
  foodCardCategory: { ...typography.small, color: colors.text?.secondary, marginTop: 2 },
  foodCardMacros:   { ...typography.small, color: colors.text?.secondary, marginTop: 2 },
  foodCardActions:  { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginLeft: spacing.sm },
  removeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 4,
  },
  removeButtonText: { fontSize: 12, color: '#ef4444', fontWeight: '600' },
  iconButton:       { padding: 4 },
  iconButtonActive: {},
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 4,
  },
  addButtonText: { ...typography.small, color: '#fff', fontWeight: '600' },

  // Modals
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  unitPickerSheet: {
    backgroundColor: colors.surface ?? '#fff',
    borderTopLeftRadius: borderRadius.xl ?? 20,
    borderTopRightRadius: borderRadius.xl ?? 20,
    padding: spacing.md,
    maxHeight: '60%',
  },
  unitPickerTitle: { ...typography.h3, color: colors.text?.primary, marginBottom: spacing.sm },
  unitOption:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  unitOptionActive:    { backgroundColor: colors.primary + '10' },
  unitOptionText:      { ...typography.body, color: colors.text?.primary },
  unitOptionTextActive:{ color: colors.primary, fontWeight: '600' },

  // Custom food modal
  customFoodSheet: {
    backgroundColor: colors.surface ?? '#fff',
    borderTopLeftRadius: borderRadius.xl ?? 20,
    borderTopRightRadius: borderRadius.xl ?? 20,
    padding: spacing.md,
    maxHeight: '80%',
  },
  customFoodHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  customFoodTitle:  { ...typography.h3, color: colors.text?.primary },
  fieldRow:         { marginBottom: spacing.sm },
  fieldLabel:       { ...typography.small, color: colors.text?.secondary, marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    ...typography.body,
    color: colors.text?.primary,
  },
  servingRow:  { flexDirection: 'row' },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  saveButtonText: { ...typography.body, color: '#fff', fontWeight: '700' },

  // Toast
  toast: {
    position: 'absolute',
    bottom: 24,
    left: spacing.xl,
    right: spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    alignItems: 'center',
  },
  toastText: { ...typography.small, color: '#fff' },
});