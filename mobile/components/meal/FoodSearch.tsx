// mobile/components/meal/FoodSearch.tsx
//
// FIXES vs original
// ─────────────────
// FIX #1 – N×category fan-out removed (main lag source)
//   Before: when no category was selected and the user typed a query,
//   performSearch fired Promise.all(categories.map(cat => searchFoods(…)))
//   — one HTTP request per category (≈16 parallel requests per keystroke).
//   This existed only because the backend silently ignored ?query= and only
//   read ?q=, returning no text-filtered results without a category.
//   After:  food_routes.py now reads ?query= correctly. A single request
//   without a category returns cross-category results from the backend.
//   The fan-out code is fully removed.
//
// FIX #2 – getCategories() TTL cache
//   Before: getCategories() was called unconditionally on every mount,
//   even though _cachedCategories already held a value. This caused an extra
//   HTTP + MongoDB round-trip every time the modal opened.
//   After:  _categoriesFetchedAt tracks the last successful fetch. The call
//   is skipped if the cache is fresher than CATEGORIES_TTL_MS (10 min).
//
// FIX #3 – performSearch dep-array loop causing double-search
//   Before: performSearch was a useCallback that listed `categories` as a
//   dep. When getCategories() resolved and setCategories() ran, React
//   created a new performSearch reference → the debounce useEffect
//   (which listed performSearch as a dep) re-fired → a second search ran
//   immediately after the first one while the user had already typed.
//   After:  performSearch is stable (empty dep array). It reads the latest
//   searchQuery / selectedCategory values from a ref that is kept current
//   on every render. The debounce effect depends only on the raw state
//   values, never on the function reference.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
} from 'react-native';
import { searchFoods, getCategories, getFavorites, addToFavorites, removeFromFavorites } from '@/services/api/food';

// Fallback so the category picker is never empty even if the API fails
import { FOOD_CATEGORIES } from '@/constants/shared-constants';

// ── Scanner imports ──────────────────────────────────────────────────────────
import {
  scanFoodImage,
  pickImageFromCamera,
  pickImageFromGallery,
  type ScanResult,
} from '@/services/api/food-scanning';
// ─────────────────────────────────────────────────────────────────────────────

// ── Module-level cache (persists across modal open/close within a session) ───
let _cachedCategories: string[] | null = FOOD_CATEGORIES.map((c) => c.value);
let _cachedFavorites:  any[] | null    = null;
// FIX #2: timestamp so getCategories() is skipped when the cache is fresh
let _categoriesFetchedAt               = 0;
const CATEGORIES_TTL_MS                = 10 * 60 * 1000; // 10 minutes
// ─────────────────────────────────────────────────────────────────────────────

interface FoodSearchProps {
  onSelect: (food: any) => void;
  /**
   * Called when multiple foods are confirmed at once (e.g. from a scan).
   * When provided, all scanned items are passed in a single batch call so
   * the parent can add them all atomically — fixing the stale-closure bug
   * that caused only the last item to be kept when onSelect was called
   * in a forEach loop.
   */
  onSelectMultiple?: (foods: any[]) => void;
  onClose: () => void;
}

const FoodSearch: React.FC<FoodSearchProps> = ({ onSelect, onSelectMultiple, onClose }) => {
  const [searchQuery,           setSearchQuery]           = useState('');
  const [selectedCategory,      setSelectedCategory]      = useState('');
  const [categories,            setCategories]            = useState<string[]>(_cachedCategories ?? []);
  const [searchResults,         setSearchResults]         = useState<any[]>([]);
  const [favorites,             setFavorites]             = useState<any[]>(_cachedFavorites ?? []);

  const [isSearchLoading,       setIsSearchLoading]       = useState(false);
  const [isInitialLoading,      setIsInitialLoading]      = useState(false);
  const [loadError,             setLoadError]             = useState<string | null>(null);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);

  // ── Scanner state ──────────────────────────────────────────────────────────
  const [isScanning,      setIsScanning]      = useState(false);
  const [scanResult,      setScanResult]      = useState<ScanResult | null>(null);
  const [scanNoteVisible, setScanNoteVisible] = useState(false);
  const [scanNote,        setScanNote]        = useState('');
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  // ──────────────────────────────────────────────────────────────────────────

  // FIX #3: ref always holds the latest query/category so performSearch
  // doesn't need them in its dep array (prevents the double-search loop).
  const searchParamsRef = useRef({ searchQuery, selectedCategory });
  searchParamsRef.current = { searchQuery, selectedCategory };

  // ── Load categories + favorites in parallel ────────────────────────────────
  useEffect(() => {
    const loadInitialData = async () => {
      // FIX #2: skip getCategories() when the cache is still fresh
      const needsCategories = Date.now() - _categoriesFetchedAt > CATEGORIES_TTL_MS;
      const needsFavorites  = !_cachedFavorites;

      if (needsCategories || needsFavorites) setIsInitialLoading(true);
      setLoadError(null);

      // Paint with cached values immediately — no blank flash
      setCategories(_cachedCategories!);
      setFavorites(_cachedFavorites ?? []);

      if (!needsCategories && !needsFavorites) {
        // Both caches are fresh — nothing to fetch
        setIsInitialLoading(false);
        return;
      }

      try {
        const [catResult, favResult] = await Promise.all([
          needsCategories ? getCategories()  : Promise.resolve(null),
          needsFavorites  ? getFavorites()   : Promise.resolve(null),
        ]);

        if (catResult) {
          const keys = Object.keys(catResult.categories || {});
          if (keys.length > 0) {
            _cachedCategories    = keys;
            _categoriesFetchedAt = Date.now(); // FIX #2: stamp the fresh fetch
          }
        }
        if (favResult) {
          _cachedFavorites = Array.isArray(favResult) ? favResult : [];
        }

        setCategories(_cachedCategories!);
        setFavorites(_cachedFavorites ?? []);
      } catch (error: any) {
        console.error('[FoodSearch] Failed to load initial data:', error);
        setLoadError('Could not load food data. Check your connection.');
        setFavorites(_cachedFavorites ?? []);
      } finally {
        setIsInitialLoading(false);
      }
    };

    loadInitialData();
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────

  /** Normalise whatever shape the backend returns into a flat array. */
  const extractResults = (raw: any): any[] => {
    if (Array.isArray(raw))                         return raw;
    if (raw && Array.isArray((raw as any).results)) return (raw as any).results;
    if (raw && Array.isArray((raw as any).foods))   return (raw as any).foods;
    return [];
  };

  // FIX #1 + FIX #3
  // – Stable callback (empty dep array): reads live values from searchParamsRef.
  // – Single HTTP request regardless of whether a category is selected.
  //   The backend (food_routes.py) now correctly reads ?query= and searches
  //   all categories in one pass when no category param is provided.
  const performSearch = useCallback(async () => {
    const { searchQuery: q, selectedCategory: cat } = searchParamsRef.current;

    setIsSearchLoading(true);
    try {
      const raw = await searchFoods({
        query:    q || undefined,
        category: cat || undefined,
      });

      let results = extractResults(raw);

      // Client-side safety-net: ensure the query text is actually present
      // (guards against backend returning broader results than expected)
      if (q) {
        const lower = q.toLowerCase();
        results = results.filter(
          (f) => (f.name ?? '').toLowerCase().includes(lower)
        );
      }

      setSearchResults(results);
    } catch (error) {
      console.error('[FoodSearch] Search failed:', error);
      Alert.alert('Search Error', 'Could not fetch results. Please try again.');
      setSearchResults([]);
    } finally {
      setIsSearchLoading(false);
    }
  }, []); // ← intentionally empty: reads from searchParamsRef, not closure vars

  // FIX #3: performSearch is NOT in the dep array — it's now a stable ref.
  // The effect only re-runs when the user actually changes the query or category.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery || selectedCategory) performSearch();
      else setSearchResults([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, selectedCategory]); // eslint-disable-line react-hooks/exhaustive-deps
  // performSearch deliberately excluded — it's stable and reads from a ref.

  // ── Favorites ─────────────────────────────────────────────────────────────
  const favoriteNames = new Set(favorites.map((f: any) => f.name));

  const refreshFavorites = async () => {
    _cachedFavorites = null;
    const updated = await getFavorites();
    const safe = Array.isArray(updated) ? updated : [];
    _cachedFavorites = safe;
    setFavorites(safe);
  };

  const handleToggleFavorite = async (e: any, food: any) => {
    e.stopPropagation();
    const isFav = favoriteNames.has(food.name);
    try {
      if (isFav) await removeFromFavorites(food.name);
      else       await addToFavorites(food.name);
      await refreshFavorites();
    } catch (error) {
      Alert.alert('Error', isFav ? 'Failed to remove from favorites' : 'Failed to add to favorites');
    }
  };

  // ── Build a SelectedFood object from a raw food/scan item ─────────────────
  /**
   * Shared mapping logic used by both handleSelectFood (single) and
   * handleConfirmScan (batch).  Keeping it here avoids duplicating the
   * serving-size / weight-unit logic.
   */
  const buildSelectedFood = (food: any): any | null => {
    if (!food.details) return null;

    const carbs   = parseFloat(food.details.carbs)   || 0;
    const protein = parseFloat(food.details.protein) || 0;
    const fat     = parseFloat(food.details.fat)     || 0;

    const servingSize      = food.details.serving_size || {};
    const WEIGHT_UNITS     = new Set(['g', 'kg', 'oz', 'lb']);
    const hasWeightServing = !!(servingSize.w_amount && servingSize.w_unit)
                             || WEIGHT_UNITS.has(servingSize.unit);

    const roundToHalf = (value: number): number => Math.round(value * 2) / 2;

    return {
      id: Date.now() + Math.random(), // unique even when called in quick succession
      name: food.name,
      portion: {
        amount:            roundToHalf(servingSize.amount   || 1),
        unit:              servingSize.unit   || 'serving',
        w_amount:          roundToHalf(servingSize.w_amount || 100),
        w_unit:            servingSize.w_unit || 'g',
        activeMeasurement: (hasWeightServing ? 'weight' : 'volume') as 'weight' | 'volume',
        baseAmount:        servingSize.amount   || 1,
        baseUnit:          servingSize.unit     || 'serving',
        baseWAmount:       servingSize.w_amount || 100,
        baseWUnit:         servingSize.w_unit   || 'g',
      },
      details: {
        carbs,
        protein,
        fat,
        absorption_type: food.details.absorption_type || 'medium',
        serving_size: {
          amount:   servingSize.amount   || 1,
          unit:     servingSize.unit     || 'serving',
          w_amount: servingSize.w_amount || 100,
          w_unit:   servingSize.w_unit   || 'g',
        },
      },
    };
  };

  // ── Select food ────────────────────────────────────────────────────────────
  const handleSelectFood = (food: any) => {
    if (!food.details) {
      Alert.alert('Error', 'Food item is missing nutritional information');
      return;
    }

    const selectedFood = buildSelectedFood(food);
    if (!selectedFood) return;

    const carbs   = parseFloat(food.details.carbs)   || 0;
    const protein = parseFloat(food.details.protein) || 0;
    const fat     = parseFloat(food.details.fat)     || 0;

    if (carbs === 0 && protein === 0 && fat === 0) {
      Alert.alert(
        'Warning',
        'This food has no nutritional data. It will not contribute to insulin calculations.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Add Anyway', onPress: () => onSelect(selectedFood) },
        ]
      );
      return;
    }

    onSelect(selectedFood);
  };

  // ── Scanner handlers ───────────────────────────────────────────────────────

  /**
   * Step 1 — open image picker.
   *
   * On web: Alert.alert with multiple buttons is a no-op on Expo Web —
   * none of the button callbacks ever fire, so the scanner appeared completely
   * broken. On web we skip the Alert entirely and open a hidden file input
   * imperatively. The browser's native sheet already lets the user pick
   * camera or gallery on mobile, and opens a file dialog on desktop.
   */
  const handleScanPress = () => {
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif';
      input.style.display = 'none';

      input.onchange = async () => {
        const file = input.files?.[0];
        document.body.removeChild(input);
        if (!file) return;

        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
          });
          setPendingImageUri(dataUrl);
          setScanNote('');
          setScanNoteVisible(true);
        } catch (err: any) {
          Alert.alert('File Error', err?.message ?? 'Could not read the selected image.');
        }
      };

      // Must be appended to DOM before .click() (required by Safari)
      document.body.appendChild(input);
      input.click();
    } else {
      Alert.alert(
        'Scan Food',
        'Choose image source',
        [
          { text: '📷  Camera',        onPress: () => handlePickImage('camera')  },
          { text: '🖼️  Photo Library', onPress: () => handlePickImage('gallery') },
          { text: 'Cancel', style: 'cancel' },
        ],
        { cancelable: true },
      );
    }
  };

  /** Step 2 (native only) — pick image, then show optional note modal */
  const handlePickImage = async (source: 'camera' | 'gallery') => {
    try {
      const uri =
        source === 'camera'
          ? await pickImageFromCamera()
          : await pickImageFromGallery();

      if (!uri) return;
      setPendingImageUri(uri);
      setScanNote('');
      setScanNoteVisible(true);
    } catch (err: any) {
      Alert.alert('Permission Error', err?.message ?? 'Could not access image source.');
    }
  };

  /** Step 3 — run Claude scan with optional note */
  const handleRunScan = async (note?: string) => {
    if (!pendingImageUri) return;
    setScanNoteVisible(false);
    setIsScanning(true);
    setScanResult(null);

    try {
      const result = await scanFoodImage(pendingImageUri, {
        userNote: note || undefined,
      });

      if (!result.items.length) {
        Alert.alert(
          'No Food Detected',
          'Claude could not identify any food. Try a clearer photo or add a description hint.',
        );
        return;
      }

      setScanResult(result);
    } catch (err: any) {
      Alert.alert(
        'Scan Failed',
        err?.response?.data?.error ?? err?.message ?? 'Unknown error. Please try again.',
      );
    } finally {
      setIsScanning(false);
      setPendingImageUri(null);
      setScanNote('');
    }
  };

  /**
   * Step 4 — add all confirmed scan items to the meal.
   *
   * FIX: Previously this called onSelect() in a forEach loop.
   * Each iteration captured the same stale snapshot of tempSelectedFoods
   * in MealForm, so only the last food survived (classic React stale-closure
   * bug).  Now we:
   *   1. Build all SelectedFood objects here in one pass.
   *   2. Call onSelectMultiple(foods) so the parent can do a single
   *      atomic state update — no stale closure possible.
   *   3. Fall back to the old loop only when onSelectMultiple is not
   *      provided (e.g. a different parent that hasn't been updated yet).
   */
  const handleConfirmScan = () => {
    if (!scanResult) return;

    // Filter low-confidence items (< 40%) silently
    const confirmed = scanResult.items.filter(
      (item) => item.scan_meta.confidence >= 0.4
    );

    if (confirmed.length === 0) {
      setScanResult(null);
      return;
    }

    // Build all mapped food objects up front
    const mappedFoods = confirmed
      .map((item) => buildSelectedFood(item))
      .filter(Boolean) as any[];

    if (onSelectMultiple) {
      // ✅ Batch path — parent receives all foods in one call
      onSelectMultiple(mappedFoods);
    } else {
      // Fallback for any parent that only provides onSelect.
      // Note: this path still has the stale-closure issue in the parent
      // unless the parent uses the functional updater form of setState.
      mappedFoods.forEach((food) => onSelect(food));
    }

    setScanResult(null);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  const renderConfidenceBadge = (confidence: number) => {
    const pct   = Math.round(confidence * 100);
    const color = pct >= 80 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
    return (
      <View style={[styles.confidenceBadge, { backgroundColor: color + '20', borderColor: color }]}>
        <Text style={[styles.confidenceText, { color }]}>{pct}%</Text>
      </View>
    );
  };

  // ── Absorption badge helpers (mirrors FoodItem.tsx colour mapping) ────────
  const getAbsorptionColor = (type: string): string => {
    switch (type) {
      case 'very_fast': return '#d32f2f';
      case 'fast':      return '#f57c00';
      case 'medium':    return '#388e3c';
      case 'slow':      return '#1565c0';
      case 'very_slow': return '#6a1b9a';
      default:          return '#757575';
    }
  };
  const formatAbsorption = (type: string): string =>
    (type ?? 'medium').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

  const renderFoodItem = (food: any, index: number) => {
    const isFav = favoriteNames.has(food.name);
    return (
      <TouchableOpacity
        key={index}
        style={styles.foodItem}
        onPress={() => handleSelectFood(food)}
      >
        <View style={styles.foodItemContent}>
          <Text style={styles.foodItemName}>{food.name}</Text>
          <View style={styles.foodItemDetails}>
            <Text style={styles.foodItemNutrient}>{food.details?.carbs || 0}g carbs</Text>
            <Text style={styles.nutrientDivider}>•</Text>
            <Text style={styles.foodItemNutrient}>{food.details?.protein || 0}g protein</Text>
            <Text style={styles.nutrientDivider}>•</Text>
            <Text style={styles.foodItemNutrient}>{food.details?.fat || 0}g fat</Text>
          </View>
          {food.details?.serving_size && (
            <Text style={styles.servingSize}>
              Serving: {food.details.serving_size.amount} {food.details.serving_size.unit}
              {food.details.serving_size.w_amount &&
                ` (${food.details.serving_size.w_amount}${food.details.serving_size.w_unit})`}
            </Text>
          )}
          {food.details?.absorption_type && (() => {
            const color = getAbsorptionColor(food.details.absorption_type);
            return (
              <View style={[styles.absorptionBadge, { backgroundColor: color + '18', borderColor: color + '55', borderWidth: 1 }]}>
                <Text style={[styles.absorptionBadgeText, { color }]}>
                  {formatAbsorption(food.details.absorption_type)}
                </Text>
              </View>
            );
          })()}
        </View>

        <View style={styles.foodItemActions}>
          <TouchableOpacity
            style={[styles.favoriteIconButton, isFav && styles.favoriteIconButtonActive]}
            onPress={(e) => handleToggleFavorite(e, food)}
          >
            <Text style={styles.favoriteIcon}>{isFav ? '⭐' : '☆'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.addIconButton}
            onPress={(e) => { e.stopPropagation(); handleSelectFood(food); }}
          >
            <Text style={styles.addIcon}>+</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  const categorySheet = (
    <>
      <View style={styles.categorySheetHandle} />
      <Text style={styles.categorySheetTitle}>Filter by Category</Text>
      {isInitialLoading ? (
        <ActivityIndicator size="small" color="#1976d2" style={{ marginVertical: 24 }} />
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          <TouchableOpacity
            style={[styles.categoryOption, !selectedCategory && styles.categoryOptionSelected]}
            onPress={() => { setSelectedCategory(''); setCategoryPickerVisible(false); }}
          >
            <Text style={[styles.categoryOptionText, !selectedCategory && styles.categoryOptionTextSelected]}>
              All Categories
            </Text>
            {!selectedCategory && <Text style={styles.checkmark}>✓</Text>}
          </TouchableOpacity>

          {categories.map((cat) => (
            <TouchableOpacity
              key={cat}
              style={[styles.categoryOption, selectedCategory === cat && styles.categoryOptionSelected]}
              onPress={() => { setSelectedCategory(cat); setCategoryPickerVisible(false); }}
            >
              <Text style={[styles.categoryOptionText, selectedCategory === cat && styles.categoryOptionTextSelected]}>
                {cat.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
              </Text>
              {selectedCategory === cat && <Text style={styles.checkmark}>✓</Text>}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </>
  );

  const isIdle = !searchQuery && !selectedCategory;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* Error banner */}
      {loadError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>⚠️ {loadError}</Text>
        </View>
      )}

      {/* ── Search controls row: [🔍 input] [category] [📷 scan] ── */}
      <View style={styles.searchControls}>
        <View style={styles.searchInputWrapper}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search for food..."
            placeholderTextColor="#888888"
            autoFocus
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.clearIcon}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={styles.categoryTrigger}
          onPress={() => setCategoryPickerVisible(true)}
          activeOpacity={0.7}
        >
          {isInitialLoading ? (
            <ActivityIndicator size="small" color="#1976d2" style={{ flex: 1 }} />
          ) : (
            <Text style={styles.categoryTriggerValue} numberOfLines={1}>
              {selectedCategory
                ? selectedCategory.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
                : 'All Categories'}
            </Text>
          )}
          <Text style={styles.categoryChevron}>▾</Text>
        </TouchableOpacity>

        {/* ── Scan button ── */}
        <TouchableOpacity
          style={[styles.scanButton, isScanning && styles.scanButtonDisabled]}
          onPress={handleScanPress}
          disabled={isScanning}
          accessibilityLabel="Scan food with camera"
        >
          {isScanning
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.scanButtonText}>📷</Text>
          }
        </TouchableOpacity>
      </View>

      {/* Scanning hint below the controls row */}
      {isScanning && (
        <Text style={styles.scanningHint}>Analysing with AI…</Text>
      )}

      {/* Category picker */}
      {Platform.OS === 'web' ? (
        categoryPickerVisible && (
          <View style={styles.webCategoryOverlay}>
            <TouchableOpacity
              style={styles.modalDismissArea}
              activeOpacity={1}
              onPress={() => setCategoryPickerVisible(false)}
            />
            <View style={styles.categorySheet}>{categorySheet}</View>
          </View>
        )
      ) : (
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
            <View style={styles.categorySheet}>{categorySheet}</View>
          </View>
        </Modal>
      )}

      {/* ── Optional note modal (shown before scan runs) ── */}
      <Modal
        visible={scanNoteVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setScanNoteVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.scanNoteCard}>
            <Text style={styles.scanNoteTitle}>Add a hint (optional)</Text>
            <Text style={styles.scanNoteSubtitle}>
              Help DiaTwin to identify quantity and type dish, e.g. "half cheese Sandwich" or "نصف طبق ارز"
            </Text>
            <TextInput
              style={styles.scanNoteInput}
              value={scanNote}
              onChangeText={setScanNote}
              placeholder="e.g. Bratwurst, grilled chicken…"
              placeholderTextColor="#9ca3af"
              returnKeyType="done"
              autoFocus
            />
            <View style={styles.scanNoteActions}>
              <TouchableOpacity
                style={styles.scanNoteSkipBtn}
                onPress={() => handleRunScan()}
              >
                <Text style={styles.scanNoteSkipText}>Skip & Scan</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.scanNoteScanBtn}
                onPress={() => handleRunScan(scanNote)}
              >
                <Text style={styles.scanNoteScanText}>Scan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Scan results modal ── */}
      <Modal
        visible={!!scanResult}
        transparent
        animationType="slide"
        onRequestClose={() => setScanResult(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.scanResultsCard}>
            <Text style={styles.scanResultsTitle}>Scan Results</Text>

            {scanResult && (
              <>
                <Text style={styles.scanSceneDesc}>
                  {scanResult.scene_description}
                </Text>

                <ScrollView style={styles.scanItemsList} showsVerticalScrollIndicator={false}>
                  {scanResult.items.map((item, idx) => (
                    <View key={idx} style={styles.scanItemRow}>
                      <View style={styles.scanItemInfo}>
                        <Text style={styles.scanItemName}>
                          {item.name}
                          {item.scan_meta?.name_ar ? ` (${item.scan_meta.name_ar})` : ''}
                        </Text>
                        <Text style={styles.scanItemMacros}>
                          {item.details.serving_size?.amount ?? '?'}g
                          {' · '}C: {item.details.carbs}g
                          {' · '}P: {item.details.protein}g
                          {' · '}F: {item.details.fat}g
                        </Text>
                        <Text style={styles.scanItemSource}>
                          {item.scan_meta?.source === 'database' ? '✅ From DB' : '🤖 AI estimate'}
                        </Text>
                      </View>
                      {renderConfidenceBadge(item.scan_meta?.confidence ?? 0)}
                    </View>
                  ))}
                </ScrollView>

                <Text style={styles.scanSummary}>
                  {scanResult.db_matched} from database · {scanResult.llm_estimated} AI estimated
                </Text>
                <Text style={styles.scanPortionWarning}>
                  ⚠️ Review portions after adding — AI estimates can vary.
                </Text>
              </>
            )}

            <View style={styles.scanResultsActions}>
              <TouchableOpacity
                style={styles.scanDiscardBtn}
                onPress={() => setScanResult(null)}
              >
                <Text style={styles.scanDiscardText}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.scanConfirmBtn}
                onPress={handleConfirmScan}
              >
                <Text style={styles.scanConfirmText}>Add to Meal</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Results area: favorites when idle, search results otherwise */}
      <ScrollView style={styles.results} nestedScrollEnabled>
        {isIdle ? (
          <>
            {favorites.length > 0 && (
              <Text style={styles.sectionHeader}>⭐ Favorites</Text>
            )}
            {isInitialLoading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#1976d2" />
              </View>
            ) : favorites.length > 0 ? (
              favorites.map(renderFoodItem)
            ) : (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No favorites yet</Text>
                <Text style={styles.emptySubtext}>
                  Search for food and tap ⭐ to save it here
                </Text>
              </View>
            )}
          </>
        ) : isSearchLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#1976d2" />
          </View>
        ) : searchResults.length > 0 ? (
          searchResults.map(renderFoodItem)
        ) : (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No foods found</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
};

// ============================================================================
// Styles
// ============================================================================
const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#fff' },
  sectionHeader:      { fontSize: 13, fontWeight: '700', color: '#888', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  errorBanner: {
    backgroundColor: '#fff3cd', borderColor: '#ffc107',
    borderWidth: 1, borderRadius: 6,
    marginHorizontal: 12, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  errorBannerText:    { fontSize: 13, color: '#856404' },

  // ── Search controls row ──────────────────────────────────────────────────
  searchControls: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    gap: 8, borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
  },
  searchInputWrapper: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0',
    borderRadius: 8, paddingHorizontal: 10, height: 42,
  },
  searchIcon:         { fontSize: 14, marginRight: 6 },
  clearIcon:          { fontSize: 13, color: '#888', paddingHorizontal: 4 },
  searchInput:        { flex: 1, fontSize: 14, color: '#000000', height: 42 },
  categoryTrigger: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f0f4ff', borderWidth: 1, borderColor: '#c5cae9',
    borderRadius: 8, paddingHorizontal: 10, height: 42, width: 120, gap: 4,
  },
  categoryTriggerValue: { flex: 1, fontSize: 12, color: '#1976d2', fontWeight: '600' },
  categoryChevron:      { fontSize: 14, color: '#1976d2' },

  // Scan button — sits at the right end of the controls row
  scanButton: {
    width: 42, height: 42, borderRadius: 8,
    backgroundColor: '#6366f1',
    alignItems: 'center', justifyContent: 'center',
  },
  scanButtonDisabled: { opacity: 0.5 },
  scanButtonText:     { fontSize: 20 },
  scanningHint: {
    textAlign: 'center', color: '#6b7280',
    fontSize: 12, paddingVertical: 4,
  },

  // ── Shared modal styles ──────────────────────────────────────────────────
  webCategoryOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 999, justifyContent: 'flex-end',
  },
  modalOverlay:     { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  modalDismissArea: { flex: 1 },
  categorySheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingBottom: 32, paddingTop: 12, maxHeight: '65%',
  },
  categorySheetHandle: {
    width: 40, height: 4, backgroundColor: '#ddd',
    borderRadius: 2, alignSelf: 'center', marginBottom: 14,
  },
  categorySheetTitle:       { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 12 },
  checkmark:                { fontSize: 16, color: '#1976d2', fontWeight: '700' },
  categoryOption: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 13, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  categoryOptionSelected:     { backgroundColor: '#e8f0fe' },
  categoryOptionText:         { fontSize: 14, color: '#333' },
  categoryOptionTextSelected: { color: '#1976d2', fontWeight: '600' },

  // ── Scanner — note input ─────────────────────────────────────────────────
  scanNoteCard: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 36,
  },
  scanNoteTitle:    { fontSize: 17, fontWeight: '700', color: '#111827', marginBottom: 4 },
  scanNoteSubtitle: { fontSize: 13, color: '#6b7280', marginBottom: 16 },
  scanNoteInput: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10,
    padding: 12, fontSize: 15, color: '#111827', marginBottom: 16,
  },
  scanNoteActions:    { flexDirection: 'row', gap: 12 },
  scanNoteSkipBtn: {
    flex: 1, borderWidth: 1, borderColor: '#d1d5db',
    borderRadius: 10, paddingVertical: 12, alignItems: 'center',
  },
  scanNoteSkipText: { color: '#374151', fontWeight: '600' },
  scanNoteScanBtn:  { flex: 1, backgroundColor: '#6366f1', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  scanNoteScanText: { color: '#fff', fontWeight: '600' },

  // ── Scanner — results card ───────────────────────────────────────────────
  scanResultsCard: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36, maxHeight: '85%',
  },
  scanResultsTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 4 },
  scanSceneDesc:    { fontSize: 13, color: '#6b7280', marginBottom: 12, fontStyle: 'italic' },
  scanItemsList:    { maxHeight: 320 },
  scanItemRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e5e7eb',
  },
  scanItemInfo:   { flex: 1 },
  scanItemName:   { fontSize: 15, fontWeight: '600', color: '#111827' },
  scanItemMacros: { fontSize: 12, color: '#374151', marginTop: 2 },
  scanItemSource: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  confidenceBadge: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  confidenceText:   { fontSize: 11, fontWeight: '700' },
  scanSummary:      { fontSize: 12, color: '#6b7280', textAlign: 'center', marginTop: 10 },
  scanPortionWarning: { fontSize: 12, color: '#b45309', textAlign: 'center', marginTop: 4, marginBottom: 8 },
  scanResultsActions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  scanDiscardBtn: {
    flex: 1, borderWidth: 1, borderColor: '#d1d5db',
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  scanDiscardText:  { color: '#374151', fontWeight: '600' },
  scanConfirmBtn:   { flex: 2, backgroundColor: '#6366f1', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  scanConfirmText:  { color: '#fff', fontWeight: '700', fontSize: 15 },

  // ── Food list ────────────────────────────────────────────────────────────
  results:          { flex: 1, maxHeight: 420 },
  loadingContainer: { padding: 32, alignItems: 'center' },
  emptyContainer:   { padding: 32, alignItems: 'center' },
  emptyText:        { fontSize: 14, color: '#999', textAlign: 'center' },
  emptySubtext:     { fontSize: 12, color: '#ccc', textAlign: 'center', marginTop: 4 },
  foodItem: {
    flexDirection: 'row', padding: 12,
    borderBottomWidth: 1, borderBottomColor: '#f0f0f0', alignItems: 'center',
  },
  foodItemContent:    { flex: 1 },
  foodItemName:       { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 4 },
  foodItemDetails:    { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  foodItemNutrient:   { fontSize: 11, color: '#666' },
  nutrientDivider:    { fontSize: 11, color: '#ccc', marginHorizontal: 4 },
  servingSize:        { fontSize: 11, color: '#999' },
  absorptionBadge: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: 5,
  },
  absorptionBadgeText: { fontSize: 10, fontWeight: '700' },
  foodItemActions:    { flexDirection: 'row', gap: 8, alignItems: 'center' },
  favoriteIconButton: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#f5f5f5', alignItems: 'center', justifyContent: 'center',
  },
  favoriteIconButtonActive: { backgroundColor: '#fff3cd' },
  favoriteIcon:       { fontSize: 18 },
  addIconButton: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#1976d2', alignItems: 'center', justifyContent: 'center',
  },
  addIcon:            { fontSize: 20, color: '#fff', fontWeight: '600' },
});

export default FoodSearch;