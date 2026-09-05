/**
 * FoodImageScanner.tsx
 * Location: mobile/components/meal/FoodImageScanner.tsx
 *
 * Platform strategy:
 *   Web    → imperatively creates a hidden <input type="file"> and calls .click().
 *            This bypasses the broken useRef + @ts-ignore approach that left the
 *            ref as null on Expo Web, causing a complete silent no-op on press.
 *   Native → expo-image-picker Alert sheet (camera vs. gallery).
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  TextInput,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import {
  scanFoodImage,
  pickImageFromCamera,
  pickImageFromGallery,
  mapScanResultsToSelectedFoods,
  type ScanResult,
  type ScannedFoodItem,
} from '@/services/api/food-scanning';
import type { SelectedFood } from '@/types/food';

// ============================================================================
// Props
// ============================================================================

interface FoodImageScannerProps {
  onFoodsDetected: (foods: SelectedFood[]) => void;
  disabled?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export default function FoodImageScanner({
  onFoodsDetected,
  disabled = false,
}: FoodImageScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [userNote, setUserNote] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // Web: open a file picker imperatively (no ref needed — avoids the null-ref
  // bug that silently swallowed every tap on Expo Web)
  // --------------------------------------------------------------------------

  const openWebFilePicker = useCallback(() => {
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
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });

        setPendingImageUri(dataUrl);
        setShowNoteInput(true);
      } catch (err: any) {
        Alert.alert('File Error', err?.message ?? 'Could not read the selected image.');
      }
    };

    // Must be in the DOM before .click() for some browsers (e.g. Safari)
    document.body.appendChild(input);
    input.click();
  }, []);

  // --------------------------------------------------------------------------
  // Scan press — branch on platform
  // --------------------------------------------------------------------------

  const handleScanPress = useCallback(() => {
    if (disabled || scanning) return;

    if (Platform.OS === 'web') {
      // On web, Alert.alert with multiple buttons is a no-op / shows a basic
      // browser alert with no custom actions. Skip it — go straight to the
      // file picker which the browser handles (camera + gallery in one sheet
      // on mobile browsers, file dialog on desktop).
      openWebFilePicker();
    } else {
      Alert.alert(
        'Scan Food',
        'Choose image source',
        [
          { text: '📷  Camera',       onPress: () => handleNativeSource('camera') },
          { text: '🖼️  Photo Library', onPress: () => handleNativeSource('gallery') },
          { text: 'Cancel', style: 'cancel' },
        ],
        { cancelable: true },
      );
    }
  }, [disabled, scanning, openWebFilePicker]);

  const handleNativeSource = useCallback(async (source: 'camera' | 'gallery') => {
    try {
      const uri =
        source === 'camera'
          ? await pickImageFromCamera()
          : await pickImageFromGallery();

      if (!uri) return;
      setPendingImageUri(uri);
      setShowNoteInput(true);
    } catch (err: any) {
      Alert.alert('Permission Error', err?.message ?? 'Could not access image source.');
    }
  }, []);

  // --------------------------------------------------------------------------
  // Run scan (after optional note)
  // --------------------------------------------------------------------------

  const runScan = useCallback(
    async (imageUri: string, note?: string) => {
      setShowNoteInput(false);
      setScanning(true);
      setScanResult(null);

      try {
        const result = await scanFoodImage(imageUri, {
          userNote: note || undefined,
        });

        if (!result.items.length) {
          Alert.alert(
            'No Food Detected',
            'AI could not identify any food in the image. Try a clearer photo or add a note.',
          );
          return;
        }

        setScanResult(result);
      } catch (err: any) {
        console.error('[FoodImageScanner] Scan error:', err);
        Alert.alert(
          'Scan Failed',
          err?.response?.data?.error ?? err?.message ?? 'Unknown error. Please try again.',
        );
      } finally {
        setScanning(false);
        setPendingImageUri(null);
        setUserNote('');
      }
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Confirm / discard
  // --------------------------------------------------------------------------

  const handleConfirm = useCallback(() => {
    if (!scanResult) return;
    onFoodsDetected(mapScanResultsToSelectedFoods(scanResult));
    setScanResult(null);
  }, [scanResult, onFoodsDetected]);

  const handleDismiss = useCallback(() => setScanResult(null), []);

  // --------------------------------------------------------------------------
  // Render helpers
  // --------------------------------------------------------------------------

  const renderConfidenceBadge = (confidence: number) => {
    const pct = Math.round(confidence * 100);
    const color =
      pct >= 80 ? '#22c55e'
      : pct >= 60 ? '#f59e0b'
      : '#ef4444';

    return (
      <View style={[styles.confidenceBadge, { backgroundColor: color + '22', borderColor: color }]}>
        <Text style={[styles.confidenceText, { color }]}>{pct}%</Text>
      </View>
    );
  };

  const renderFoodItem = (item: ScannedFoodItem, index: number) => (
    <View key={index} style={styles.foodItemRow}>
      <View style={styles.foodItemInfo}>
        <Text style={styles.foodItemName}>
          {item.name}
          {item.scan_meta.name_ar ? ` (${item.scan_meta.name_ar})` : ''}
        </Text>
        <Text style={styles.foodItemMacros}>
          {item.details.estimated_grams ?? item.details.serving_size.amount}g
          {' · '}C: {item.details.carbs}g
          {' · '}P: {item.details.protein}g
          {' · '}F: {item.details.fat}g
        </Text>
        <Text style={styles.foodItemSource}>
          {item.scan_meta.source === 'database' ? '✅ From DB' : '🤖 AI estimate'}
          {item.scan_meta.notes ? ` · ${item.scan_meta.notes}` : ''}
        </Text>
      </View>
      {renderConfidenceBadge(item.scan_meta.confidence)}
    </View>
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <>
      {/* ── Scan trigger button ── */}
      <TouchableOpacity
        style={[styles.scanButton, (disabled || scanning) && styles.scanButtonDisabled]}
        onPress={handleScanPress}
        disabled={disabled || scanning}
        accessibilityLabel="Scan food with camera"
      >
        {scanning ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.scanButtonText}>📷  Scan Food</Text>
        )}
      </TouchableOpacity>

      {scanning && (
        <Text style={styles.scanningHint}>Analysing with AI Tools…</Text>
      )}

      {/* ── Optional note modal ── */}
      <Modal
        visible={showNoteInput}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNoteInput(false)}
      >
        {/* KeyboardAvoidingView keeps the card vertically centred even when
            the soft keyboard opens for the TextInput. Without it the card
            gets pushed below the visible area on iOS and some Android devices. */}
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
        >
          <View style={styles.noteCard}>
            <Text style={styles.noteTitle}>Add a hint (optional)</Text>
            <Text style={styles.noteSubtitle}>
              Help AI to identify quantity and type dish, e.g. "half cheese Sandwich" or "نصف طبق ارز"
            </Text>
            <TextInput
              style={styles.noteInput}
              value={userNote}
              onChangeText={setUserNote}
              placeholder="[Food Name]"
              placeholderTextColor="#9ca3af"
              returnKeyType="done"
              autoFocus
            />
            <View style={styles.noteActions}>
              <TouchableOpacity
                style={styles.noteSkipBtn}
                onPress={() => pendingImageUri && runScan(pendingImageUri)}
              >
                <Text style={styles.noteSkipText}>Skip & Scan</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.noteScanBtn}
                onPress={() => pendingImageUri && runScan(pendingImageUri, userNote)}
              >
                <Text style={styles.noteScanText}>Scan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Scan results modal ── */}
      <Modal
        visible={!!scanResult}
        transparent
        animationType="slide"
        onRequestClose={handleDismiss}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.resultsCard}>
            <Text style={styles.resultsTitle}>Scan Results</Text>

            {scanResult && (
              <>
                <Text style={styles.sceneDescription}>
                  {scanResult.scene_description}
                </Text>

                <ScrollView style={styles.itemsList} showsVerticalScrollIndicator={false}>
                  {scanResult.items.map(renderFoodItem)}
                </ScrollView>

                <Text style={styles.resultsSummary}>
                  {scanResult.db_matched} from database · {scanResult.llm_estimated} AI estimated
                </Text>

                <Text style={styles.portionWarning}>
                  ⚠️  Review portions before confirming — AI estimates can vary.
                </Text>
              </>
            )}

            <View style={styles.resultsActions}>
              <TouchableOpacity style={styles.dismissBtn} onPress={handleDismiss}>
                <Text style={styles.dismissText}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
                <Text style={styles.confirmText}>Add to Meal</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginVertical: 8,
  },
  scanButtonDisabled: { opacity: 0.5 },
  scanButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  scanningHint: { textAlign: 'center', color: '#6b7280', fontSize: 13, marginBottom: 4 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },

  noteCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
  },
  noteTitle: { fontSize: 17, fontWeight: '700', color: '#111827', marginBottom: 4 },
  noteSubtitle: { fontSize: 13, color: '#6b7280', marginBottom: 16 },
  noteInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    marginBottom: 16,
  },
  noteActions: { flexDirection: 'row', gap: 12 },
  noteSkipBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  noteSkipText: { color: '#374151', fontWeight: '600' },
  noteScanBtn: {
    flex: 1,
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  noteScanText: { color: '#fff', fontWeight: '600' },

  resultsCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    maxHeight: '85%',
  },
  resultsTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 4 },
  sceneDescription: { fontSize: 13, color: '#6b7280', marginBottom: 12, fontStyle: 'italic' },
  itemsList: { maxHeight: 360 },
  foodItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    gap: 10,
  },
  foodItemInfo: { flex: 1 },
  foodItemName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  foodItemMacros: { fontSize: 12, color: '#374151', marginTop: 2 },
  foodItemSource: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  confidenceBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  confidenceText: { fontSize: 11, fontWeight: '700' },
  resultsSummary: { fontSize: 12, color: '#6b7280', textAlign: 'center', marginTop: 10 },
  portionWarning: { fontSize: 12, color: '#b45309', textAlign: 'center', marginTop: 6, marginBottom: 8 },
  resultsActions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  dismissBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  dismissText: { color: '#374151', fontWeight: '600' },
  confirmBtn: {
    flex: 2,
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  confirmText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});