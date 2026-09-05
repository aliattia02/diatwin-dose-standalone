/**
 * Food Scanning API Service
 * Location: mobile/services/api/food-scanning.ts
 *
 * Platform strategy:
 *   Web    → imageUri may be a data: URL (FileReader) or blob: URL (createObjectURL).
 *            Both are compressed via Canvas API (max 1 024 px, JPEG 0.70) before
 *            sending, mirroring the quality: 0.7 that ImagePicker applies on native.
 *            Without compression a phone photo becomes a 5–8 MB base64 JSON body
 *            that the backend rejects with 400.
 *   Native → ImagePicker compresses at pick time (quality: 0.7).
 *            File is copied out of Android's restricted cache dir before
 *            base64 encoding — this fixes the "Loading bitmap failed" crash
 *            that occurs when expo-image-manipulator tries to renderAsync
 *            a file:// URI still sitting in the ImagePicker cache directory.
 */

import { Platform } from 'react-native';
import apiClient from './client';
import API from './endpoints';
import type { SelectedFood, FoodDetails } from '@/types/food';

// ============================================================================
// Types
// ============================================================================

export type ScanSource = 'database' | 'llm_estimate';

export interface ScanMeta {
  source: ScanSource;
  detected_name: string;
  confidence: number;
  estimated_grams: number;
  notes?: string;
  name_ar?: string | null;
  name_de?: string | null;
}

export interface ScannedFoodItem {
  name: string;
  category: string;
  details: FoodDetails;
  scan_meta: ScanMeta;
}

export interface ScanResult {
  items: ScannedFoodItem[];
  scene_description: string;
  overall_confidence: number;
  db_matched: number;
  llm_estimated: number;
}

export interface ScanOptions {
  /** Optional free-text hint sent to Gemini, e.g. "this is koshari" */
  userNote?: string;
}

// ============================================================================
// Image helpers — Native only
// ============================================================================

/**
 * Copy the image out of Android's restricted ImagePicker cache directory
 * into the app's own documentDirectory, then read it as base64.
 */
async function uriToBase64Native(uri: string): Promise<string> {
  const FileSystem = await import('expo-file-system/legacy');

  const destUri =
    (FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '') +
    `food_scan_${Date.now()}.jpg`;

  try {
    await FileSystem.copyAsync({ from: uri, to: destUri });

    const base64 = await FileSystem.readAsStringAsync(destUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    return base64;
  } finally {
    FileSystem.deleteAsync(destUri, { idempotent: true }).catch(() => {});
  }
}

// ============================================================================
// Web helpers
// ============================================================================

/**
 * Compress and resize an image on web using the Canvas API.
 *
 * WHY THIS IS NEEDED:
 *   Native uses ImagePicker's quality: 0.7 — a typical phone JPEG comes out
 *   at ~100–200 KB. On web, FileReader.readAsDataURL gives you the raw original,
 *   which can be 3–5 MB. Base64-encoded inside a JSON body that's 7+ MB, many
 *   servers / reverse proxies return 400 or 413 before the handler even runs.
 *
 *   Canvas re-encodes to JPEG at quality 0.7 and caps the longest side at
 *   1 024 px — identical in effect to what ImagePicker does on native.
 *
 * @param srcUrl  A data: URL or blob: URL pointing at the image.
 * @param quality JPEG quality 0.0–1.0 (default 0.7 — matches native picker)
 * @param maxSide Longest edge in pixels (default 1 024)
 */
async function compressImageWeb(
  srcUrl: string,
  quality = 0.7,
  maxSide = 1024,
): Promise<{ base64: string; mimeType: 'image/jpeg' }> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      // Compute scaled dimensions
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxSide || h > maxSide) {
        if (w >= h) {
          h = Math.round(h * maxSide / w);
          w = maxSide;
        } else {
          w = Math.round(w * maxSide / h);
          h = maxSide;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }

      ctx.drawImage(img, 0, 0, w, h);

      // toDataURL always produces a data: URL — strip the prefix for base64
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const comma = dataUrl.indexOf(',');
      if (comma === -1) {
        reject(new Error('Canvas produced an unexpected data URL format'));
        return;
      }

      resolve({
        base64:   dataUrl.slice(comma + 1),
        mimeType: 'image/jpeg',
      });
    };

    img.onerror = () =>
      reject(new Error('Failed to load image for compression. Try a different file.'));

    // Works for both data: and blob: URLs
    img.src = srcUrl;
  });
}

// ============================================================================
// Camera / Gallery pickers — Native only
// ============================================================================

export async function pickImageFromCamera(): Promise<string | null> {
  const ImagePicker = await import('expo-image-picker');
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Camera permission is required to scan food.');
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.7,
    allowsEditing: false,
  });

  if (result.canceled || !result.assets?.length) return null;
  return result.assets[0].uri;
}

export async function pickImageFromGallery(): Promise<string | null> {
  const ImagePicker = await import('expo-image-picker');
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo library permission is required.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.7,
    allowsEditing: false,
  });

  if (result.canceled || !result.assets?.length) return null;
  return result.assets[0].uri;
}

// ============================================================================
// Core scan function
// ============================================================================

export async function scanFoodImage(
  imageUri: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const { userNote } = options;

  let base64Data: string;
  let mimeType: string = 'image/jpeg';

  if (Platform.OS === 'web') {
    // ── Web path ─────────────────────────────────────────────────────────────
    // imageUri is a data: URL (FileReader) or blob: URL (createObjectURL).
    // Compress via Canvas first — this is the equivalent of quality: 0.7
    // that the native ImagePicker applies, and prevents the 400 caused by
    // sending a 5–8 MB base64 JSON body to the backend.
    //
    // IMPORTANT: The entire web block (compression + API call) is wrapped in
    // one try/catch so that a backend 400 response body is always logged.
    // Previously the catch only covered compressImageWeb, so API errors were
    // swallowed silently and the real backend message was never surfaced.
    console.log('[FoodScan] Web path — compressing image…');
    try {
      const compressed = await compressImageWeb(imageUri);
      base64Data = compressed.base64;
      mimeType   = compressed.mimeType;

      // Revoke blob URLs immediately after the canvas has loaded them
      if (imageUri.startsWith('blob:')) {
        URL.revokeObjectURL(imageUri);
      }

      const estimatedKB = Math.round((base64Data.length * 3) / 4 / 1024);
      console.log(`[FoodScan] Web — compressed to ~${estimatedKB} KB, sending…`);
      console.log('[FoodScan DEBUG] Payload keys:', {
        image_base64_length: base64Data.length,
        mime_type: mimeType,
        has_user_note: !!userNote,
      });

      // Explicit Content-Type: application/json is required on Expo Web.
      // Without it, some axios builds (or Expo's bundled XHR shim) may omit
      // or mangle the header, causing Flask's `request.content_type` check to
      // misidentify the body as multipart/form-data and look for
      // `request.files["image"]` — which doesn't exist → 400.
      const webResponse = await apiClient.post<ScanResult>(
        API.FOOD.SCAN,
        {
          image_base64: base64Data,
          mime_type:    mimeType,
          ...(userNote ? { user_note: userNote } : {}),
        },
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );

      console.log(
        `[FoodScan] Done — ${webResponse.data.items.length} items ` +
        `(${webResponse.data.db_matched} DB, ${webResponse.data.llm_estimated} AI)`,
      );

      return webResponse.data;
    } catch (err: any) {
      // Surface the actual backend error message (e.g. the 400 reason string)
      // so it appears in the console and in the Alert shown to the user.
      const backendMsg = err?.response?.data?.error ?? err?.response?.data?.message;
      console.error(
        '[FoodScan] Web scan failed —',
        `HTTP ${err?.response?.status ?? 'network error'}:`,
        backendMsg ?? err?.message,
      );
      console.error('[FoodScan] Full backend body:', JSON.stringify(err?.response?.data));
      // Attach the backend message to the error so FoodImageScanner's Alert
      // shows "AI analysis failed: <reason>" instead of the generic axios text.
      if (backendMsg && err.message !== backendMsg) {
        err.message = backendMsg;
      }
      throw err;
    }
  } else {
    // ── Native path ───────────────────────────────────────────────────────────
    console.log('[FoodScan] Native path — copying + encoding image…');
    base64Data = await uriToBase64Native(imageUri);
  }

  // Shared post-encoding path for native only (web returns early above)
  const estimatedKB = Math.round((base64Data.length * 3) / 4 / 1024);
  console.log(`[FoodScan] Sending to backend — ~${estimatedKB} KB image…`);
  console.log('[FoodScan DEBUG] Payload keys:', {
    image_base64_length: base64Data.length,
    mime_type: mimeType,
    has_user_note: !!userNote,
  });

  const response = await apiClient.post<ScanResult>(API.FOOD.SCAN, {
    image_base64: base64Data,
    mime_type:    mimeType,
    ...(userNote ? { user_note: userNote } : {}),
  });

  console.log(
    `[FoodScan] Done — ${response.data.items.length} items ` +
    `(${response.data.db_matched} DB, ${response.data.llm_estimated} AI)`,
  );

  return response.data;
}

// ============================================================================
// Weight unit set — used to pick the correct activeMeasurement
// ============================================================================

const WEIGHT_UNITS = new Set(['g', 'kg', 'oz', 'lb']);

// ============================================================================
// Mapper: ScanResult → SelectedFood[]
// ============================================================================

export function mapScanResultsToSelectedFoods(
  result: ScanResult,
  minConfidence = 0.4,
): SelectedFood[] {
  return result.items
    .filter((item) => item.scan_meta.confidence >= minConfidence)
    .map((item, index) => {
      const serving = item.details.serving_size ?? { amount: 100, unit: 'g' };

      const activeMeasurement: 'weight' | 'volume' = WEIGHT_UNITS.has(serving.unit)
        ? 'weight'
        : 'volume';

      return {
        id: Date.now() + index,
        name: item.name,
        category: item.category,
        details: item.details,
        portion: {
          amount:      serving.amount,
          unit:        serving.unit,
          w_amount:    activeMeasurement === 'weight' ? serving.amount : null,
          w_unit:      activeMeasurement === 'weight' ? serving.unit : null,
          activeMeasurement,
          baseAmount:  serving.amount,
          baseUnit:    serving.unit,
          baseWAmount: activeMeasurement === 'weight' ? serving.amount : null,
          baseWUnit:   activeMeasurement === 'weight' ? serving.unit : null,
        },
      } satisfies SelectedFood;
    });
}

export default {
  pickImageFromCamera,
  pickImageFromGallery,
  scanFoodImage,
  mapScanResultsToSelectedFoods,
};