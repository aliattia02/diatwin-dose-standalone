# DiaTwin — Arm 4: Mobile Client Layer

**Document version:** 2.1  
**Scope:** Everything between the mobile UI screens and the backend API — API services, Zustand stores, React hooks, storage utilities, and offline infrastructure.  
**Companion arms:**
- Arm 0 — Backend API & Auth (backend routes, token lifecycle, user types)
- Arm 1 — Shared Data Contracts (API constants, request/response types)
- Arm 2 — Data Operations Reference (patient-data computation shapes)
- Arm 3 — Visualization Layer (the three visualization hooks: `useActiveEffects`, `useBloodGlucoseEstimation`, `usePatientConstants`)

---

## Table of Contents

1. [Arm Ownership & Boundaries](#1-arm-ownership--boundaries)
2. [API Client Foundation (cross-reference)](#2-api-client-foundation-cross-reference)
3. [Auth Service — `services/api/auth.ts`](#3-auth-service)
4. [Data Services](#4-data-services)
5. [Integration Services](#5-integration-services)
6. [Doctor Services](#6-doctor-services)
7. [Stores — Auth & Meal](#7-stores--auth--meal)
8. [Hooks](#8-hooks)
9. [Offline Store — `store/offline.store.ts`](#9-offline-store)
10. [Storage Utility — `utils/storage.ts`](#10-storage-utility)
11. [Cross-Arm References](#11-cross-arm-references)
12. [Developer Rules](#12-developer-rules)

---

## 1. Arm Ownership & Boundaries

Arm 4 owns the complete mobile client layer: every file that sits between a React Native screen and the backend HTTP API.

**Owned by Arm 4:**

| Directory | Files |
|-----------|-------|
| `mobile/services/api/` | `auth.ts`, `meals.ts`, `glucose.ts`, `insulin.ts`, `activities.ts`, `patient.ts`, `food.ts`, `food-scanning.ts`, `libre.ts`, `watch-sync.ts`, `watch-hr.ts`, `doctor.ts`, `doctor-management.ts` |
| `mobile/store/` | `auth.store.ts`, `meal.store.ts`, `offline.store.ts`, `patient.store.ts` |
| `mobile/hooks/` | `useAuth.ts`, `useApi.ts`, `useOffline.ts`, `useLibre.ts`, `usePatientConstants.ts` |
| `mobile/utils/` | `storage.ts`, `connectivity.ts` |

**Not owned by Arm 4 — do not duplicate:**

| File | Owned by |
|------|----------|
| `services/api/client.ts` | Arm 1 §4.1 (cross-reference only) |
| `services/api/endpoints.ts` | Arm 1 §4.2 (cross-reference only) |
| `hooks/useActiveEffects.ts` | Arm 3 |
| `hooks/useBloodGlucoseEstimation.ts` | Arm 3 |
| `hooks/usePatientConstants.ts` (visualization role) | Arm 3 |

> **Note on `usePatientConstants.ts`:** The hook file itself lives in `mobile/hooks/` and is partially documented here in §8.5 for its store integration, cache, and AppState refresh behaviour. Its visualization-facing contract (how `hasLoadedFromAPI` gates circadian calculations, how it interacts with `useActiveEffects`) is documented in Arm 3. The two perspectives are complementary, not duplicate.

---

## 2. API Client Foundation (cross-reference)

**Documented in Arm 1 §4.1 (`client.ts`) and §4.2 (`endpoints.ts`).** Do not re-document here.

Arm 4 builds directly on top of these two files:

- Every service in `services/api/` imports the default `apiClient` axios instance from `client.ts`. This instance attaches the `Authorization: Bearer <token>` header and the `X-Client-Type: mobile` header on every outgoing request via an axios request interceptor. See **Developer Rule DR-01**.
- Every `API.*` constant used in data services resolves to a path string defined in `endpoints.ts`. Cross-references in §4, §5, and §6 below cite the `API.*` name so readers can look up the full URL in Arm 1 §4.2.
- The `wakeUpServer` / `WakeProgress` exports from `client.ts` are consumed by `useAuth.ts` (§8.1) — this is an Arm 4 consumer pattern, not a re-documentation of the client itself.
- `isNetworkError(error)` from `client.ts` is the canonical network-error discriminator used by `offline.store.ts` (§9) and `useApi.ts` (§8.2) to distinguish a connectivity failure from a server-side error.

---

## 3. Auth Service

**File:** `mobile/services/api/auth.ts`  
**Backend counterpart:** Arm 0 §3 (login endpoint, token lifecycle, user types)

### 3.1 Purpose

Encapsulates all HTTP calls related to authentication and session management. Handles token persistence, credential storage, shared constants retrieval, and client-side JWT expiry checks. The auth store (`§7.1`) delegates all I/O to this service.

### 3.2 Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `login` | `(credentials: LoginCredentials) => Promise<UserData>` | Resolved `UserData`; throws on 4xx/5xx |
| `register` | `(data: RegisterData) => Promise<RegisterResponse>` | `{ message: string; id: string }` |
| `logout` | `() => Promise<void>` | Clears token and user data from secure storage |
| `isAuthenticated` | `() => Promise<boolean>` | `true` if a valid, non-expired token exists |
| `getStoredToken` | `() => Promise<string \| null>` | Raw JWT string or `null` |
| `getStoredUserData` | `() => Promise<UserData \| null>` | Parsed `UserData` or `null` |
| `getSharedConstants` | `() => Promise<Record<string, any> \| null>` | Server-supplied shared constants |
| `refreshToken` | `() => Promise<string \| null>` | `null` (placeholder — not yet implemented) |

### 3.3 Type Definitions

```typescript
export interface LoginCredentials {
  username: string;
  password: string;
  user_type: 'patient' | 'doctor' | 'admin';
}

export interface RegisterData {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  user_type: 'patient' | 'doctor' | 'admin';
}

export interface UserData {
  token: string;
  userType: 'patient' | 'doctor' | 'admin';
  firstName: string;
  lastName: string;
}

// Internal — not exported
interface LoginResponse {
  message: string;
  token: string;
  user_type: string;
  firstName: string;
  lastName: string;
  shared_constants?: Record<string, any>;
}

interface RegisterResponse {
  message: string;
  id: string;
}
```

### 3.4 Endpoints Called

| Operation | Method | `API.*` constant | Auth required |
|-----------|--------|-----------------|---------------|
| Login | `POST` | `API.AUTH.LOGIN` | No |
| Register | `POST` | `API.AUTH.REGISTER` | No |
| Logout | (local only) | — | Token cleared from storage; no HTTP call |

### 3.5 Login Flow

1. POST credentials to `API.AUTH.LOGIN`.
2. On success: build `UserData` from response fields.
3. Store token under `STORAGE_KEYS.AUTH_TOKEN` via `secureStorage`.
4. Store serialized `UserData` under `STORAGE_KEYS.USER_DATA` via `secureStorage`.
5. If `response.data.shared_constants` is present: store under `STORAGE_KEYS.SHARED_CONSTANTS`.
6. Return resolved `UserData`.

### 3.6 Client-Side Token Validation (`isAuthenticated`)

`isAuthenticated()` decodes the stored JWT payload with `atob()` (no signature verification — client-side read only) and checks the `exp` claim:

- If token missing: `false`.
- If token present but `exp` has passed: clears both `STORAGE_KEYS.AUTH_TOKEN` and `STORAGE_KEYS.USER_DATA`, returns `false`.
- If token present and `exp` is in the future (or no `exp` claim): `true`.

This prevents a silent 401 loop on app re-launch when an old 24-hour token remains in secure storage. The same `isTokenValid` helper is duplicated in `auth.store.ts` for the `checkAuth` path — both implementations are identical.

### 3.7 Token Storage Behaviour

- Platform-agnostic: `expo-secure-store` on iOS/Android, `localStorage` on web (see §10.1).
- All storage operations use `STORAGE_KEYS.*` constants — never hardcoded strings (DR-04).
- `getStoredToken` and `getStoredUserData` are read-only; they do not call the network.
- `getSharedConstants` reads `STORAGE_KEYS.SHARED_CONSTANTS` from `secureStorage`. Written on login. Re-read by `auth.store.ts → checkAuth()` on every session restore.

---

## 4. Data Services

Each data service file follows the same structural pattern:

1. Imports `apiClient` from `client.ts` and relevant `API.*` constants from `endpoints.ts`.
2. Exports async functions that call `apiClient.get/post/put/delete`.
3. Returns typed response data (unwrapping `response.data`).
4. Does **not** catch errors internally except where noted — callers (`store/` and `hooks/`) handle error state.

### 4.1 Meals Service — `services/api/meals.ts`

**Store consumer:** `meal.store.ts` (§7.2)  
**API constants:** `API.MEALS.*` (Arm 1 §4.2)

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `calculateMeal` | `(data: CalculateMealData) => Promise<any>` | Insulin calculation result from backend |
| `createMeal` | `(data: CreateMealData) => Promise<MealResponse>` | Created meal record |
| `getMeals` | `(params?) => Promise<MealsListResponse>` | Paginated meal list |
| `getMealById` | `(id: string) => Promise<MealResponse>` | Single meal record |
| `getPatientMeals` | `(patientId: string, params?) => Promise<MealsListResponse>` | Doctor-view patient meal list |

#### Type Definitions

```typescript
export interface CreateMealData {
  mealType: string;
  mealTime: string;
  selectedFoods: any[];
  bloodSugar?: number;
  bloodSugarTimestamp?: string;
  bloodSugarUnit?: string;
  activities?: any[];
  intendedInsulin?: number;
  intendedInsulinType?: string;
  insulinTimestamp?: string;
  notes?: string;
  activityIds?: string[];
  calculationFactors?: any;
}

export interface CalculateMealData {
  mealType: string;
  selectedFoods: any[];
  bloodSugar?: number;
  activities?: any[];
}
```

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `calculateMeal` | `POST` | `API.MEALS.CALCULATE` |
| `createMeal` | `POST` | `API.MEALS.CREATE` |
| `getMeals` | `GET` | `API.MEALS.LIST` |
| `getMealById` | `GET` | `API.MEALS.LIST` (paginated list, filtered by id — see note) |
| `getPatientMeals` | `GET` | `API.MEALS.PATIENT_MEALS(patientId)` |

> **Note on `getMealById`:** `GET /api/meal/<id>` returns HTTP 405 on the backend — only DELETE is supported at that path. `getMealById` instead fetches the paginated list with `limit: 200` and finds the matching entry by `id`. This is a known workaround until the backend exposes a direct GET-by-ID route.

#### Payload Shaping — Activities

`createMeal` and `calculateMeal` both pass activities through an internal `formatActivitiesForBackend()` helper before sending. The helper normalizes the `type` field:

```typescript
// CORRECT: ternary priority — explicit type wins, then isExpected flag
type: activity.type ? activity.type : (activity.isExpected ? 'expected' : 'completed')
// INCORRECT (old bug): activity.type || activity.isExpected ? 'expected' : 'completed'
// The old form had JS precedence issues: any truthy activity.type resolved to 'expected'
```

#### Payload Shaping — Blood Sugar & Insulin

Both `bloodSugar` and `intendedInsulin` fields are conditionally included using spread syntax (`...(data.bloodSugar != null && { ... })`). Neither field is sent when absent, preventing the backend from storing zero-values for readings that were not entered.

#### Error Handling

`createMeal` catches errors and extracts the backend message from `error?.response?.data?.error` before re-throwing with the human-readable message attached to `error.message`. This surfaces the exact backend reason in the UI alert.

### 4.2 Glucose Service — `services/api/glucose.ts`

**API constants:** `API.BLOOD_SUGAR.*` (Arm 1 §4.2)  
**Related types:** Arm 1 — `BloodSugarResponse`, `BloodSugarCreateResponse`

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getReadings` | `(params?: GetGlucoseParams) => Promise<BloodSugarResponse[]>` | List of blood sugar readings |
| `createReading` | `(data: CreateGlucoseData) => Promise<BloodSugarCreateResponse>` | Created reading |
| `getLatestReading` | `() => Promise<BloodSugarResponse \| null>` | Most recent reading in past 24 h, or `null` |
| `getGlucoseStatus` | `(value: number, target?: number) => GlucoseStatus` | Classification string (pure function, no network) |
| `getPatientReadings` | `(patientId: string, params?) => Promise<BloodSugarResponse[]>` | Doctor-view patient readings |

#### Type Definitions

```typescript
export interface GetGlucoseParams {
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  filter_by?: 'timestamp' | 'reading_time';
  patient_id?: string;
}

export interface CreateGlucoseData {
  bloodSugar: number;
  bloodSugarTimestamp?: string;
  notes?: string;
  bloodSugarSource?: 'standalone' | 'meal' | 'cgm' | 'manual';
}

type GlucoseStatus = 'low' | 'normal' | 'high' | 'veryLow' | 'veryHigh';
```

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `getReadings` | `GET` | `API.BLOOD_SUGAR.LIST` |
| `createReading` | `POST` | `API.BLOOD_SUGAR.CREATE` |
| `getLatestReading` | `GET` | `API.BLOOD_SUGAR.LIST` (24-h window, sorted by timestamp) |
| `getPatientReadings` | `GET` | `API.BLOOD_SUGAR.BY_PATIENT(patientId)` |

#### `getGlucoseStatus` Thresholds (pure function)

| Return value | Condition |
|--------------|-----------|
| `'veryLow'` | `value < 54` |
| `'low'` | `value < target * 0.7` |
| `'veryHigh'` | `value > 250` |
| `'high'` | `value > target * 1.3` |
| `'normal'` | otherwise |

Default `target` is 100 mg/dL when not supplied.

### 4.3 Insulin Service — `services/api/insulin.ts`

**Store consumer:** `meal.store.ts` via `getActiveInsulin()`  
**API constants:** `API.INSULIN.*` (Arm 1 §4.2)  
**Related types:** Arm 1 — `InsulinDataResponse`, `InsulinLogResponse`, `ActiveInsulinResponse`

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getDoses` | `(params?: GetInsulinParams) => Promise<InsulinDataResponse>` | Historical doses + metadata |
| `logDose` | `(data: LogInsulinData) => Promise<InsulinLogResponse>` | Logged dose record |
| `getActiveDoses` | `(targetTime?: string) => Promise<ActiveInsulinResponse>` | Currently active insulin (IOB) |
| `getActiveInsulin` | `() => Promise<ActiveInsulinResponse>` | Alias for `getActiveDoses()` |
| `getAnalytics` | `(params?) => Promise<Record<string, unknown>>` | Insulin usage analytics |
| `calculateIOB` | `(activeInsulin: ActiveInsulinResponse) => number` | Pure helper — extracts `total_active_insulin` |
| `getInsulinTypeDisplayName` | `(medication: string) => string` | Pure helper — human-readable brand/type name |
| `getInsulinTypes` | `() => { value: string; label: string }[]` | Dropdown options list |

#### Type Definitions

```typescript
export interface GetInsulinParams {
  days?: number;
  end_date?: string;
  patient_id?: string;
}

export interface LogInsulinData {
  medication: string;
  dose: number;
  taken_at?: string;
  scheduled_time?: string;
  notes?: string;
  meal_type?: string;
  blood_sugar?: number;
  is_insulin: boolean;   // always set to true
}
```

#### API Constants Used — Corrected Routes

| Function | Method | Endpoint | Historical bug |
|----------|--------|----------|----------------|
| `getDoses` | `GET` | `API.INSULIN.DATA` → `/api/insulin-data` | — |
| `logDose` | `POST` | `API.INSULIN.LOG` → `/api/insulin/log` | Was `API.MEDICATION.CREATE_LOG` → 404 |
| `getActiveDoses` / `getActiveInsulin` | `GET` | `API.INSULIN.ACTIVE` → `/api/insulin/active-effect` | Was `/api/active-insulin` → 404 |
| `getAnalytics` | `GET` | `API.INSULIN.ANALYTICS` → `/api/insulin-analytics` | — |

> **Routing fix note:** Both `logDose` and `getActiveDoses` were previously calling non-existent routes. The fixes are in `endpoints.ts` — `API.INSULIN.LOG` and `API.INSULIN.ACTIVE` must map to the paths above.

#### Insulin Type Display Name Map

```
insulin_lispro     → Insulin Lispro (Humalog)
insulin_aspart     → Insulin Aspart (NovoLog)
insulin_glulisine  → Insulin Glulisine (Apidra)
insulin_regular    → Regular Insulin
insulin_nph        → NPH Insulin
insulin_glargine   → Insulin Glargine (Lantus)
insulin_detemir    → Insulin Detemir (Levemir)
insulin_degludec   → Insulin Degludec (Tresiba)
rapid_acting       → Rapid Acting
short_acting       → Short Acting
intermediate_acting → Intermediate Acting
long_acting        → Long Acting
```

### 4.4 Activities Service — `services/api/activities.ts`

**API constants:** `API.ACTIVITIES.*` (Arm 1 §4.2)

> Activities service file was not included in this session's upload. Full function surface will be documented once attached. Known consumer: `meals.ts` — activity records are formatted via `formatActivitiesForBackend()` and attached to meal create/calculate payloads (§4.1). Doctor view: `doctor.ts` calls `API.ACTIVITIES.PATIENT_HISTORY(patientId)` directly.

### 4.5 Patient Service — `services/api/patient.ts`

**Store consumer:** `patient.store.ts` (§7.3)  
**API constants:** `API.PATIENT.*` (Arm 1 §4.2)  
**Backend counterpart:** Arm 0 §(patient constants endpoint)

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getConstants` | `() => Promise<PatientConstantsResponse>` | Full patient constants + conditions/medications |
| `updateConstants` | `(constants: Partial<PatientConstants>) => Promise<PatientConstantsResponse>` | Updated constants |
| `getProfile` | `() => Promise<PatientProfile>` | Patient demographic/preference data |
| `updateProfile` | `(profileData: Partial<PatientProfile>) => Promise<PatientProfile>` | Updated profile |

#### Type Definitions

```typescript
// Extends the base PatientConstants from shared-constants barrel
export interface PatientConstantsResponse extends PatientConstants {
  patient_id: string;
  active_conditions?: string[];
  active_medications?: string[];
  medication_schedules?: Record<string, {
    id: string;
    startDate: string;
    endDate: string;
    dailyTimes: string[];
  }>;
}

export interface PatientProfile {
  firstName?: string;
  lastName?: string;
  email?: string;
  dateOfBirth?: string;
  weight?: number;
  height?: number;
  diabetesType?: string;
  diagnosisDate?: string;
  preferredUnits?: 'metric' | 'imperial';
  timezone?: string;
}
```

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `getConstants` | `GET` | `API.PATIENT.CONSTANTS` |
| `updateConstants` | `PUT` | `API.PATIENT.CONSTANTS` |
| `getProfile` | `GET` | `API.PATIENT.PROFILE` |
| `updateProfile` | `PUT` | `API.PATIENT.PROFILE` |

### 4.6 Food Service — `services/api/food.ts`

**API constants:** `API.FOOD.*` (Arm 1 §4.2)

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `searchFoods` | `(params?: SearchFoodsParams) => Promise<FoodItem[]>` | Matching food records |
| `getCategories` | `() => Promise<CategoriesResponse>` | Category tree + measurement units |
| `getFavorites` | `() => Promise<FoodItem[]>` | User's favorited foods (returns `[]` on error — non-throwing) |
| `addToFavorites` | `(foodName: string) => Promise<void>` | Adds food by name |
| `removeFromFavorites` | `(foodName: string) => Promise<void>` | Removes food by name |
| `createCustomFood` | `(data: CustomFoodData) => Promise<FoodItem>` | Created custom food record |
| `getMeasurements` | `() => Promise<MeasurementsResponse>` | Available measurement unit catalog |
| `getNutritionalSummary` | `(params: NutritionalSummaryParams) => Promise<NutritionalSummary>` | Aggregated nutrition for a food list |

#### Type Definitions

```typescript
export interface FoodItem {
  id?: string;
  name: string;
  category?: string;
  details: FoodDetails;
  is_favorite?: boolean;
  is_custom?: boolean;
}

export interface FoodDetails {
  carbs: number;
  protein: number;
  fat: number;
  absorption_type: 'fast' | 'medium' | 'slow';
  serving_size: ServingSize;
  fiber?: number;
  calories?: number;
  glycemicIndex?: number;
}

export interface ServingSize {
  amount: number;
  unit: string;
  w_amount?: number;
  w_unit?: string;
}

export interface SearchFoodsParams {
  query?: string;
  category?: string;
  limit?: number;
  skip?: number;
}

export interface CategoriesResponse {
  categories: Record<string, string[]>;
  measurements?: {
    volume: Record<string, { ml: number; display_name: string }>;
    weight: Record<string, { grams: number; display_name: string }>;
  };
}

export interface CustomFoodData {
  name: string;
  category?: string;
  carbs: number;
  protein: number;
  fat: number;
  serving_size: ServingSize;
  absorption_type?: 'fast' | 'medium' | 'slow';
  fiber?: number;
  calories?: number;
}

export interface NutritionalSummaryParams {
  foods: Array<{ name: string; amount: number; unit: string }>;
}

export interface NutritionalSummary {
  total_carbs: number;
  total_protein: number;
  total_fat: number;
  total_calories: number;
  items: Array<{ name: string; carbs: number; protein: number; fat: number; calories: number }>;
}
```

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `searchFoods` | `GET` | `API.FOOD.SEARCH` |
| `getCategories` | `GET` | `API.FOOD.CATEGORIES` |
| `getFavorites` | `GET` | `API.FOOD.FAVORITE` |
| `addToFavorites` | `POST` | `API.FOOD.FAVORITE` |
| `removeFromFavorites` | `DELETE` | `API.FOOD.FAVORITE` |
| `createCustomFood` | `POST` | `API.FOOD.CUSTOM` |
| `getMeasurements` | `GET` | `API.FOOD.MEASUREMENTS` |
| `getNutritionalSummary` | `POST` | `API.FOOD.NUTRITIONAL_SUMMARY` |

#### Error Handling

`getFavorites` returns `[]` on error instead of throwing. This prevents component crashes when the favorites endpoint is not yet set up for a new user. All other food service functions let errors propagate to their callers.

`addToFavorites` sends `{ food_name: string }` — not an object ID. This mirrors the web implementation in `FoodSection.js`.

### 4.7 Food Scanning Service — `services/api/food-scanning.ts`

**API constants:** `API.FOOD.SCAN` (Arm 1 §4.2)

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `pickImageFromCamera` | `() => Promise<string \| null>` | URI of captured image, or `null` if cancelled |
| `pickImageFromGallery` | `() => Promise<string \| null>` | URI of selected image, or `null` if cancelled |
| `scanFoodImage` | `(imageUri: string, options?: ScanOptions) => Promise<ScanResult>` | AI scan result with items + confidence |
| `mapScanResultsToSelectedFoods` | `(result: ScanResult, minConfidence?: number) => SelectedFood[]` | Mapped `SelectedFood[]` for the meal form |

#### Type Definitions

```typescript
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
  userNote?: string;   // Free-text hint sent to Gemini, e.g. "this is koshari"
}
```

#### Platform Strategy — Image Encoding

The service diverges by platform to deliver consistent payload sizes:

**Native (iOS/Android):**
- `ImagePicker` compresses at pick time (`quality: 0.7`).
- Image file is **copied** from the ImagePicker cache directory to `documentDirectory` before base64 encoding. Encoding directly from the cache directory causes `"Loading bitmap failed"` crashes on Android.
- Temporary copy is deleted after encoding regardless of success or failure.

**Web:**
- `ImagePicker` is not available on web. The image URI is a `data:` URL (FileReader) or `blob:` URL (createObjectURL).
- Web images are **compressed via Canvas API** before sending: max longest-side 1024 px, JPEG quality 0.7. This mirrors native picker compression. Without it, a phone photo becomes a 5–8 MB base64 body that the backend rejects with HTTP 400.
- Blob URLs are revoked after the Canvas has loaded them to avoid memory leaks.
- Axios `Content-Type: application/json` is set explicitly. Without it, Expo Web's XHR shim may misidentify the body as multipart and the backend returns 400.

#### Payload Shape (POST to `API.FOOD.SCAN`)

```json
{
  "image_base64": "<base64 string>",
  "mime_type": "image/jpeg",
  "user_note": "<optional free-text hint>"
}
```

#### Error Handling

On web, the entire compress + API call block is wrapped in one `try/catch`. The backend error message is extracted from `err?.response?.data?.error` and re-attached to `err.message` before re-throwing, so the UI alert shows the actual backend reason rather than the generic axios error text.

#### `mapScanResultsToSelectedFoods`

Filters items below `minConfidence` (default 0.4). For each item, derives the `activeMeasurement` from the serving unit:
- Units in `{ 'g', 'kg', 'oz', 'lb' }` → `activeMeasurement: 'weight'`
- All other units → `activeMeasurement: 'volume'`

Assigns unique IDs via `Date.now() + index`.

---

## 5. Integration Services

**Backend counterparts:** Arm 1 §9 (LibreLink integration), Arm 1 §10 (Watch/HR integration)

### 5.1 LibreLink Service — `services/api/libre.ts`

**Hook consumer:** `useLibre.ts` (§8.4)  
**Backend counterpart:** Arm 1 §9  
**Type imports:** `@/types/libre.types`

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getLibreStatus` | `(fetchLatest?: boolean) => Promise<LibreConnectionStatus>` | Connection status; optionally triggers live fetch |
| `getLibreReadings` | `(params?: GetLibreReadingsParams) => Promise<LibreReadingsResponse>` | CGM reading history |
| `syncLibre` | `() => Promise<LibreSyncResult & { message: string }>` | New/skipped reading counts |
| `connectLibre` | `(payload: LibreConnectPayload) => Promise<LibreConnectResponse>` | Connection result |
| `disconnectLibre` | `(deleteReadings?: boolean) => Promise<{ message: string; deleted_readings: number }>` | Disconnection result |
| `updateLibreSettings` | `(settings: LibreSettingsPayload) => Promise<{ message: string; settings: LibreSettingsPayload }>` | Settings update result |

#### Parameter Types

```typescript
export interface GetLibreReadingsParams {
  hours?: number;          // Default 24; passed as query param
  sync?: boolean;          // 'true' / 'false' stringified as query param
  start_time?: string;     // ISO-8601
  end_time?: string;       // ISO-8601
}
```

All types (`LibreConnectionStatus`, `LibreConnectPayload`, `LibreConnectResponse`, `LibreReadingsResponse`, `LibreSyncResult`, `LibreSettingsPayload`) are imported from `@/types/libre.types` — see Arm 1 for their definitions.

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `getLibreStatus` | `GET` | `API.LIBRE.STATUS` |
| `getLibreReadings` | `GET` | `API.LIBRE.READINGS` |
| `syncLibre` | `POST` | `API.LIBRE.SYNC` |
| `connectLibre` | `POST` | `API.LIBRE.CONNECT` |
| `disconnectLibre` | `DELETE` | `API.LIBRE.DISCONNECT` |
| `updateLibreSettings` | `PUT` | `API.LIBRE.SETTINGS` |

#### Query Param Encoding

`getLibreStatus`: passes `{ fetch_latest: 'true' }` only when `fetchLatest` is `true`.  
`getLibreReadings`: always sends `hours` and `sync`; only sends `start_time` / `end_time` when provided.  
`disconnectLibre`: passes `{ delete_readings: 'true' }` only when `deleteReadings` is `true`.

### 5.2 Watch Sync Service — `services/api/watch-sync.ts`

**Backend counterpart:** Arm 1 §10  
**Type imports:** `@/types/watch.types`

#### Endpoint Constants (defined locally — not in `endpoints.ts`)

```typescript
const WATCH = {
  OAUTH_URL:  '/api/watch/oauth-url',
  CONNECT:    '/api/watch/connect',
  STATUS:     '/api/watch/status',
  SYNC:       '/api/watch/sync',
  SETTINGS:   '/api/watch/settings',
  DISCONNECT: '/api/watch/disconnect',
} as const;
```

> **Note:** These constants are defined inline in `watch-sync.ts` rather than in `endpoints.ts`. They should be migrated to `endpoints.ts` as `API.WATCH.*` to maintain consistency with the rest of the codebase (DR-01 dependency).

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getWatchOAuthUrl` | `() => Promise<string>` | OAuth redirect URL string |
| `connectWatch` | `(payload: WatchConnectPayload) => Promise<WatchConnectResponse>` | Connection result |
| `getWatchStatus` | `() => Promise<WatchConnectionStatus>` | Current connection and sync status |
| `syncWatch` | `() => Promise<WatchSyncResult & { message: string }>` | Sync result |
| `updateWatchSettings` | `(settings: WatchSettingsPayload) => Promise<{ message: string; settings: WatchSettingsPayload }>` | Updated settings |
| `disconnectWatch` | `(deleteActivities?: boolean) => Promise<{ message: string; deleted_activities: number }>` | Disconnection result |

All types are imported from `@/types/watch.types` — see Arm 1 for their definitions.

### 5.3 Watch HR Service — `services/api/watch-hr.ts`

**Backend counterpart:** Arm 1 §10  
**Dependency:** `axios` (imported directly alongside `apiClient` for `axios.isAxiosError` check)

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `startWatchSession` | `(params?: StartWatchSessionParams) => Promise<StartWatchSessionResult>` | Session ID + start time |
| `streamHrSamples` | `(params: StreamHrSamplesParams) => Promise<StreamHrSamplesResult>` | Samples added + total; or session-cap sentinel |
| `endWatchSession` | `(params: EndWatchSessionParams) => Promise<EndWatchSessionResult>` | Completed session summary |
| `getWatchSessionStatus` | `() => Promise<WatchSessionStatus>` | Active session state (for reconnect after crash) |

#### Type Definitions

```typescript
export type ActivityIntensity = 'light' | 'moderate' | 'vigorous';

export interface StartWatchSessionParams {
  intensity?: ActivityIntensity;
  hr_base?: number;
  hr_max?: number;
  start_time?: string;   // ISO-8601
  notes?: string;
}

export interface StartWatchSessionResult {
  session_id: string;
  started_at: string;
  message: string;
}

export interface HrSampleByMinute    { t_min: number; hr_bpm: number; }
export interface HrSampleByTimestamp { timestamp_iso: string; hr_bpm: number; }
export type HrSample = HrSampleByMinute | HrSampleByTimestamp;

export interface StreamHrSamplesParams {
  session_id: string;
  samples: HrSample[];
}

export interface StreamHrSamplesResult {
  session_id: string;
  samples_added: number;
  total_samples: number;
  sessionCapReached?: boolean;   // true on HTTP 429 — hard 15-min / 1800-sample cap
}

export interface EndWatchSessionParams {
  session_id: string;
  end_time?: string;
  intensity?: ActivityIntensity;   // overrides auto-inferred label
}

export interface EndWatchSessionResult {
  session_id: string;
  duration_minutes: number;
  intensity: ActivityIntensity;
  total_samples: number;
  hr_base: number;
  hr_max: number;
  completed_at: string;
  message: string;
}

export interface WatchSessionStatus {
  active: boolean;
  session_id: string | null;
  started_at: string | null;
  total_samples: number;
  intensity: ActivityIntensity | null;
}
```

#### Endpoints (hardcoded in watch-hr.ts)

| Function | Method | Path |
|----------|--------|------|
| `startWatchSession` | `POST` | `/api/watch/activity/start` |
| `streamHrSamples` | `POST` | `/api/watch/hr/stream` |
| `endWatchSession` | `POST` | `/api/watch/activity/end` |
| `getWatchSessionStatus` | `GET` | `/api/watch/activity/status` |

#### Session Cap Handling (HTTP 429)

`streamHrSamples` catches HTTP 429 (hard cap: 15 minutes / 1800 samples) and returns a sentinel instead of throwing:

```typescript
{ session_id, samples_added: 0, total_samples: 1800, sessionCapReached: true }
```

**Caller contract when `sessionCapReached === true`:**
1. Call `endWatchSession({ session_id })` automatically.
2. Alert user: "Maximum session duration reached (15 min). Session saved."
3. **Never retry** — 429 is a hard limit, not a transient error.

All other errors from `streamHrSamples` re-throw normally.

---

## 6. Doctor Services

**Backend counterpart:** Arm 0 §7 (doctor routes, patient management)  
**Patient data shapes returned:** Arm 2

### 6.1 Doctor Service — `services/api/doctor.ts`

**API constants:** `API.DOCTOR.*`, `API.MEALS.*`, `API.BLOOD_SUGAR.*`, `API.ACTIVITIES.*` (Arm 1 §4.2)  
**Related types:** Arm 1 — `MealResponse`, `BloodSugarResponse`, `ActivityResponse`

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getPatients` | `() => Promise<DoctorPatient[]>` | Doctor's patient list |
| `getPatientConstants` | `(patientId: string) => Promise<PatientConstantsData>` | Patient's clinical constants |
| `updatePatientConstants` | `(patientId: string, constants: Partial<PatientConstantsData>) => Promise<PatientConstantsData>` | Updated constants |
| `resetPatientConstants` | `(patientId: string) => Promise<PatientConstantsData>` | Constants reset to defaults |
| `updatePatientConditions` | `(patientId: string, conditions: string[]) => Promise<{ active_conditions: string[] }>` | Updated conditions list |
| `updatePatientMedications` | `(patientId: string, medications: string[]) => Promise<{ active_medications: string[] }>` | Updated medications list |
| `getDoctorPatientMeals` | `(patientId: string, params?) => Promise<{ meals: MealResponse[]; pagination: { total: number } }>` | Patient meal history |
| `getPatientBloodSugar` | `(patientId: string, params?) => Promise<BloodSugarResponse[]>` | Patient blood sugar history |
| `getPatientActivities` | `(patientId: string, params?) => Promise<ActivityResponse[]>` | Patient activity history |
| `getPatientInsulinDoses` | `(patientId: string, params?) => Promise<InsulinDoseResponse[]>` | Patient insulin dose history |

#### Type Definitions

```typescript
export interface DoctorPatient {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  activeConditions?: string[];
  activeMedications?: string[];
}

export interface PatientConstantsData {
  insulin_to_carb_ratio: number;
  correction_factor: number;
  target_glucose: number;
  protein_factor: number;
  fat_factor: number;
  carb_to_bg_factor: number;
  daily_reset_hour: number;
  timezone_offset_minutes?: number;
  activity_coefficients: Record<string, number>;
  absorption_modifiers: Record<string, number>;
  insulin_timing_guidelines: Record<string, unknown>;
  disease_factors: Record<string, unknown>;
  medication_factors: Record<string, unknown>;
  active_conditions: string[];
  active_medications: string[];
}

export interface InsulinDoseResponse {
  id?: string;
  _id?: string;
  insulinType: string;
  units: number;
  timestamp?: string;
  doseTime?: string;
  notes?: string;
  iobContribution?: number;
}
```

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `getPatients` | `GET` | `API.DOCTOR.PATIENTS` |
| `getPatientConstants` | `GET` | `API.DOCTOR.PATIENT_CONSTANTS(patientId)` |
| `updatePatientConstants` | `PUT` | `API.DOCTOR.PATIENT_CONSTANTS(patientId)` |
| `resetPatientConstants` | `POST` | `API.DOCTOR.PATIENT_CONSTANTS_RESET(patientId)` |
| `updatePatientConditions` | `PUT` | `API.DOCTOR.PATIENT_CONDITIONS(patientId)` |
| `updatePatientMedications` | `PUT` | `API.DOCTOR.PATIENT_MEDICATIONS(patientId)` |
| `getDoctorPatientMeals` | `GET` | `API.MEALS.PATIENT_MEALS(patientId)` |
| `getPatientBloodSugar` | `GET` | `API.BLOOD_SUGAR.BY_PATIENT(patientId)` |
| `getPatientActivities` | `GET` | `API.ACTIVITIES.PATIENT_HISTORY(patientId)` |
| `getPatientInsulinDoses` | `GET` | `/api/doctor/patient/${patientId}/insulin` (hardcoded) |

#### `getPatientInsulinDoses` — Route Rationale

This function uses the doctor-namespaced route `/api/doctor/patient/<patient_id>/insulin` rather than any patient-scoped insulin route. The patient-scoped route returns 404 for doctor tokens. The doctor route enforces `check_doctor_patient_access()` on the backend (Arm 0 §7).

The function handles both response shapes defensively: `{ doses: InsulinDoseResponse[] }` (primary) and `InsulinDoseResponse[]` (fallback). HTTP 404 and 403 return `[]` with a warning log; other errors re-throw.

#### `getPatientConstants` / `updatePatientConstants` — Unwrapping

The API returns `{ constants: PatientConstantsData }`. Both functions unwrap the `constants` key before returning, so callers receive `PatientConstantsData` directly.

### 6.2 Doctor Management Service — `services/api/doctor-management.ts`

**Purpose:** Patient-facing operations — authorizing and revoking doctor access to patient data.  
**Backend counterpart:** Arm 0 §7

#### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getAllDoctors` | `() => Promise<Doctor[]>` | All available doctors (for patient selection) |
| `getAuthorizedDoctors` | `() => Promise<AuthorizedDoctor[]>` | Doctors with current access to this patient |
| `authorizeDoctor` | `(doctorId: string) => Promise<{ message: string; doctor?: Doctor }>` | Authorization result |
| `revokeDoctor` | `(doctorId: string) => Promise<{ message: string }>` | Revocation result |

#### Type Definitions

```typescript
export interface Doctor {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface AuthorizedDoctor extends Doctor {
  authorizedAt?: string;
}
```

#### API Constants Used

| Function | Method | Endpoint |
|----------|--------|----------|
| `getAllDoctors` | `GET` | `API.DOCTORS.LIST` |
| `getAuthorizedDoctors` | `GET` | `API.PATIENT.AUTHORIZED_DOCTORS` |
| `authorizeDoctor` | `POST` | `API.PATIENT.AUTHORIZE_DOCTOR` |
| `revokeDoctor` | `POST` | `API.PATIENT.REVOKE_DOCTOR` |

#### 403 Degradation Behaviour

Both `getAllDoctors` and `getAuthorizedDoctors` catch HTTP 403 and return `[]` instead of throwing. These are patient-only endpoints. If a doctor account reaches the settings/doctors screen (e.g., during development or an incomplete UI guard), the degraded return prevents a crash.

`getAllDoctors` logs: `"getAllDoctors returned 403 — this is expected when a doctor account reaches the patient doctor-management screen. Ensure the settings/doctors screen is hidden for doctor users."`

---

## 7. Stores — Auth & Meal

Arm 4 owns four Zustand stores. The offline store is documented separately in §9 due to its complexity. The patient store is closely tied to `usePatientConstants.ts` and is documented in §7.3.

### 7.1 Auth Store — `store/auth.store.ts`

**File:** `mobile/store/auth.store.ts`  
**Hook consumer:** `useAuth.ts` (§8.1)  
**Service dependency:** `services/api/auth.ts` (§3)

#### State Shape

```typescript
interface AuthState {
  user: User | null;          // Logged-in user profile
  token: string | null;       // Raw JWT string
  isAuthenticated: boolean;   // Derived login state
  isLoading: boolean;         // Active async operation in progress
  error: string | null;       // Last error message (cleared by clearError())
  sharedConstants: Record<string, any> | null;  // App-wide constants from server
}

interface User {
  _id?: string;
  username?: string;
  email?: string;
  user_type?: 'patient' | 'doctor' | 'admin';
  firstName?: string;
  lastName?: string;
}
```

#### Actions

| Action | Behaviour |
|--------|-----------|
| `login(credentials)` | Calls `authService.login()`, stores token/user via `authService`, sets `user`, `token`, `isAuthenticated: true`. Also fetches `sharedConstants` in the same action. Throws on error. |
| `logout()` | Calls `authService.logout()` (clears storage). Does **not** set `isLoading: true` before clearing state — doing so unmounts the navigator. All state is cleared atomically in a single `set()` call. |
| `checkAuth()` | Reads stored token via `authService.getStoredToken()`. Validates token client-side via `isTokenValid()` (checks `exp` claim without signature verification). If expired: clears storage via `authService.logout()`, sets `isAuthenticated: false`. If valid: rehydrates `user` from `getStoredUserData()` and fetches `sharedConstants`. |
| `clearError()` | Sets `error: null`. |

#### Client-Side JWT Validation

`isTokenValid(token)` decodes the JWT payload with `atob()` (no signature verification — client-side only) and checks `payload.exp > Math.floor(Date.now() / 1000)`. A token missing an `exp` claim is treated as non-expiring. This prevents a silent 401 loop when an old 24-hour token remains in secure storage.

#### Persistence Strategy

Token and user data are stored in `secureStorage` (expo-secure-store on native, localStorage on web) under `STORAGE_KEYS.AUTH_TOKEN` and `STORAGE_KEYS.USER_DATA` respectively. See §10.1.

**Important:** `auth.ts` (an older duplicate in some directory structures) also implements a Zustand auth store using direct `apiClient.post('/login', ...)` calls instead of the `authService` abstraction. `auth.store.ts` is the canonical version — it uses the service layer and includes the JWT expiry guard. If both exist in the codebase, `auth.store.ts` takes precedence. See DR-10.

### 7.2 Meal Store — `store/meal.store.ts`

**File:** `mobile/store/meal.store.ts`  
**Service dependencies:** `services/api/insulin.ts`, `services/api/meals.ts`

#### State Shape

```typescript
interface MealState {
  activeInsulin: number;        // Units of active insulin on board
  patientConstants: any;        // Unused field — reserved for future use
  recentMeals: any[];           // Last N meals from API
  isLoading: boolean;           // Fetch in progress
  error: string | null;         // Last error message
}
```

#### Actions

| Action | Behaviour |
|--------|-----------|
| `updateActiveInsulin(value)` | Synchronous local update. Does not call API. |
| `fetchActiveInsulin()` | Calls `getActiveInsulin()` from insulin service. Sets `activeInsulin` from `result.total_active_insulin`. Errors are caught internally and set `error` without throwing. |
| `fetchRecentMeals()` | Calls `getMeals({ limit: 10 })`. Sets `recentMeals` from `result.meals`. Errors set `error` and `isLoading: false` without throwing. |
| `clearError()` | Sets `error: null`. |

#### Persistence Strategy

No persistence — all state is in-memory and reloads from API on each session. The offline queue (§9) does not currently queue meal operations through this store.

### 7.3 Patient Store — `store/patient.store.ts`

**File:** `mobile/store/patient.store.ts`  
**Hook consumer:** `usePatientConstants.ts` (§8.5)  
**Arm 3 cross-reference:** `useActiveEffects.ts`, `useBloodGlucoseEstimation.ts` gate their calculations on `hasLoadedFromAPI` exposed by `usePatientConstants` — see Arm 3.

#### State Shape

```typescript
interface PatientState {
  constants: PatientConstants | null;   // Server-fetched patient constants
  activeConditions: string[];           // e.g. ['type_1_diabetes']
  activeMedications: string[];          // Medication identifiers
  medicationSchedules: Record<string, MedicationSchedule>;
  isLoading: boolean;                   // True during any async fetch
  error: string | null;
  lastFetched: number | null;           // Timestamp of last successful API fetch
}

interface MedicationSchedule {
  id: string;
  startDate: string;
  endDate: string;
  dailyTimes: string[];
}
```

#### Two-Phase Cache Loading (Phase 1 → Phase 2)

`loadConstants()` implements a two-phase load to eliminate the stale-defaults flicker:

**Phase 1 — Immediate cache hydration (synchronous read from AsyncStorage):**
- Reads `STORAGE_KEYS.PATIENT_CONSTANTS` from storage before any network call.
- If cached and **fresh** (< 5 min old): populates state immediately and returns early — no network call in this cycle.
- If cached and **stale**: populates state with stale values but keeps `isLoading: true` so calculation guards in hook consumers stay blocked. Falls through to Phase 2.
- If **no cache**: `isLoading` stays `true`, falls through to Phase 2 with `constants: null`.

**Phase 2 — Fresh API fetch:**
- Calls `apiClient.get<PatientConstantsResponse>(API.PATIENT.CONSTANTS)`.
- On success: updates store with fresh data, persists new cache, sets `isLoading: false`.
- On error with cached data: releases loading flag with `error: 'Using cached data — failed to reach server'`. Stale data is better than an infinite loading state.
- On error without any cache (first install, no network): falls back to `DEFAULT_PATIENT_CONSTANTS` to prevent the app from being permanently stuck.

#### Actions

| Action | Behaviour |
|--------|-----------|
| `loadConstants()` | Two-phase load described above. |
| `updateConstants(partial)` | Merges partial constants into current state. Currently local-only (no API endpoint for pushing constants from patient side). Updates cache with new merged values. |
| `getConstant(key)` | Returns `constants[key]` if constants are loaded, otherwise `DEFAULT_PATIENT_CONSTANTS[key]`. |
| `clearConstants()` | Removes `STORAGE_KEYS.PATIENT_CONSTANTS` from storage and resets all state. |

#### Cache Persistence

Stored as a JSON blob under `STORAGE_KEYS.PATIENT_CONSTANTS` in regular `AsyncStorage` (not secure storage). Structure:

```typescript
{
  constants: PatientConstants;
  activeConditions: string[];
  activeMedications: string[];
  lastFetched: number;  // Date.now() at fetch time
}
```

---

## 8. Hooks

Arm 4 hooks are thin wrappers over stores and service functions. They manage component-local loading/error UI state and expose a clean, typed interface to screens.

**Three visualization hooks are NOT documented here.** They live in `mobile/hooks/` but are owned by Arm 3:
- `useActiveEffects.ts` → Arm 3
- `useBloodGlucoseEstimation.ts` → Arm 3
- The visualization contract of `usePatientConstants.ts` → Arm 3 (§8.5 below covers only its store-integration mechanics)

### 8.1 `useAuth.ts`

**File:** `mobile/hooks/useAuth.ts`  
**Store dependency:** `auth.store.ts` (§7.1)  
**Service dependencies:** `services/api/auth.ts` → `register as apiRegister`; `services/api/client.ts` → `wakeUpServer`, `WakeProgress`  
**Router:** `expo-router` — `useRouter`, `useSegments`, `useRootNavigationState`

#### Purpose

Wraps the auth store with navigation integration (Expo Router) and a server wake-up flow for Render free-tier cold starts. Exposes `isWakingUp` and `wakeProgress` so the login screen can display a friendly progress bar instead of a frozen spinner while the dyno warms up.

#### Returned Interface

```typescript
{
  // from auth store (pass-through):
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  checkAuth: () => Promise<void>;
  clearError: () => void;

  // hook-local wake-up state:
  isWakingUp: boolean;           // true while wakeUpServer poll is running
  wakeProgress: WakeProgress;    // { percent: number; message: string; ready: boolean }

  // actions (hook-wrapped):
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  register: (data: RegisterData) => Promise<RegisterResponse>;
}
```

#### `login()` Flow

1. Guard against duplicate concurrent calls via `wakeInProgress` ref (a `useRef<boolean>` set to `true` on entry, `false` in `finally`). Returns immediately if already in-progress.
2. Set `isWakingUp: true` and emit `{ percent: 0, message: 'Connecting to server…', ready: false }`.
3. Await `wakeUpServer(progressCallback)` — polls the health endpoint and streams `WakeProgress` updates via callback until the server responds or times out.
4. Set `isWakingUp: false` (in `finally`, so it always clears).
5. If `serverReady === false`: throw `'The server did not respond in time.\nPlease check your connection and try again.'`
6. Await `storeLogin(credentials)` — delegates all credential handling and token storage to `auth.store.ts → login()`.
7. Navigation is handled by the `useEffect` guard below, not inside `login()`.

#### Navigation Guard

A `useEffect` monitors `[isAuthenticated, isLoading, segments, navState?.key]`. It is skipped while `navState?.key` is undefined (navigation not yet mounted) or while `isLoading` is true. Once navigation is ready:

- `isAuthenticated && segments[0] === '(auth)'` → `router.replace('/(app)/(tabs)')`
- `!isAuthenticated && segments[0] !== '(auth)' && segments[0] !== undefined` → `router.replace('/(auth)/login')`

`logout()` does not navigate explicitly — the guard handles it reactively when `isAuthenticated` flips to `false`.

#### `register()`

Delegates directly to `apiRegister(data)` from the auth service. Does not go through the auth store. Returns the raw `RegisterResponse` to the caller. Does not set any auth state — the user must log in after registering.

#### `wakeInProgress` Ref

A `useRef<boolean>` (not state) prevents concurrent wakeup polls when the user taps Sign In twice quickly. Because it is a ref, toggling it does not trigger a re-render — it is purely a guard mechanism.

### 8.2 `useApi.ts`

**File:** `mobile/hooks/useApi.ts`  
**Store dependency:** `offline.store.ts → setOnline` (via `useOfflineStore`)  
**Error utilities:** `isNetworkError`, `isAuthError` from `services/api/client`

#### Purpose

Generic loading/error state wrapper for any async API function. The foundation hook used by all data-fetching hooks in the app. Two variants are exported: `useApi` for on-demand execution and `useApiEffect` for fire-on-mount.

#### `useApi<T, P>` — On-demand execution

```typescript
function useApi<T, P extends unknown[] = []>(
  apiFunction: (...params: P) => Promise<T>,
  options?: UseApiOptions
): UseApiResult<T, P>

interface UseApiResult<T, P extends unknown[]> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  execute: (...params: P) => Promise<T | null>;
  reset: () => void;
  setData: (data: T | null) => void;
  clearError: () => void;
}
```

**Behaviour:**

- `execute(...params)` sets `isLoading: true` and `error: null` (when `showLoading: true`), calls `apiFunction(...params)`, then:
  - **Success:** sets `{ data: result, isLoading: false, error: null }`.
  - **Network error** (`isNetworkError(error) === true`): calls `setOnline(false)` on the offline store so the queue knows the device is offline, then falls through to error handling.
  - **Any error:** extracts `error.message` (or `'An error occurred'`), sets `{ isLoading: false, error: message }`. Returns `null` — never throws.
- An `isMounted` ref (set to `false` in the cleanup of a `useEffect`) prevents state updates on unmounted components. All `setState` calls are guarded by `if (isMounted.current)`.
- `reset()` restores state to `{ data: initialData, isLoading: false, error: null }`.
- `setData(data)` updates `data` without touching loading or error state.
- `clearError()` sets `error: null` only.

#### `useApiEffect<T>` — Immediate on mount

```typescript
function useApiEffect<T>(
  apiFunction: () => Promise<T>,
  deps?: React.DependencyList,
  options?: UseApiOptions
): ApiState<T> & { refetch: () => Promise<T | null> }
```

Wraps `useApi` and calls `execute()` immediately on mount and whenever `deps` change. Exposes `refetch` (same reference as `execute`) for manual re-triggering. The `apiFunction` must be stable or wrapped in `useCallback` to avoid stale closure issues.

#### Options

```typescript
interface UseApiOptions {
  cache?: boolean;         // Reserved — not yet implemented
  cacheKey?: string;       // Reserved — not yet implemented
  showLoading?: boolean;   // Default true. Set false to suppress loading spinner for background fetches.
  initialData?: unknown;   // Seed value for data before first execute() call
}
```

#### Error Handling Contract

`execute()` always returns `T | null` — it never throws. Callers must check the returned value and/or the `error` string. This is the intended pattern across all hook consumers:

```typescript
const result = await execute(params);
if (!result) {
  // error is already in state.error
  return;
}
// use result
```

### 8.3 `useOffline.ts`

**File:** `mobile/hooks/useOffline.ts`  
**Store dependency:** `offline.store.ts` (§9) — `useOfflineStore`  
**Utility dependency:** `utils/network.ts` → `Network` (wraps `@react-native-community/netinfo`)

#### Purpose

Network status monitoring and offline queue management. Sets up the `Network.addEventListener` listener on mount, reads the initial network state, and bridges both to the offline store's `setOnline`. Exposes the full queue interface to screens and components.

#### Returned Interface

```typescript
interface UseOfflineResult {
  isOnline: boolean;
  pendingActions: OfflineAction[];
  pendingCount: number;      // count of actions with status === 'pending'
  failedCount: number;       // count of actions with status === 'failed'
  isSyncing: boolean;
  lastSync: number | null;   // timestamp of last successful queue flush
  syncError: string | null;

  queueAction: (action: Omit<OfflineAction, 'id' | 'status' | 'retryCount'>) => string;
  processQueue: () => Promise<void>;
  clearQueue: () => void;
  removeAction: (id: string) => void;
  retryFailed: () => Promise<void>;
}
```

#### Mount Side Effects

On mount (single `useEffect` with `[loadQueue, setOnline]` deps):

1. `loadQueue()` — reads the persisted queue JSON from `STORAGE_KEYS.OFFLINE_QUEUE` into the store.
2. `Network.addEventListener(state => setOnline(state.isConnected ?? false))` — subscribes to native network change events. Stores the unsubscribe function.
3. `Network.fetch()` — one-shot read of the current network state to seed `isOnline` immediately.

On unmount: calls `unsubscribe()` returned by `addEventListener`.

#### `queueAction()`

A `useCallback` wrapper around `store.enqueue(action)`. Accepts an `OfflineAction` without `id`, `status`, or `retryCount` (the store assigns these). Returns the generated `id` string so the caller can track or cancel the action.

#### `removeAction(id)`

A `useCallback` wrapper around `store.dequeue(id)`. Removes a specific action by ID regardless of status.

#### `retryFailed()` Behaviour

1. Calls `useOfflineStore.getState()` directly (bypasses reactive subscription — reads the latest snapshot without triggering a re-render).
2. Filters `pendingActions` for `status === 'failed'`.
3. Calls `store.updateActionStatus(a.id, 'pending')` for each. Does **not** reset `retryCount` — retries still count toward the max retry limit.
4. Calls `processQueue()`.

#### `pendingCount` / `failedCount`

Computed inline from `pendingActions` on each render:
```typescript
const pendingCount = pendingActions.filter(a => a.status === 'pending').length;
const failedCount  = pendingActions.filter(a => a.status === 'failed').length;
```
These are not stored in the offline store — they are derived values exposed for UI badge counts.

### 8.4 `useLibre.ts`

**File:** `mobile/hooks/useLibre.ts`  
**Service dependencies:** All exports from `services/api/libre.ts` (§5.1)  
**Hook dependencies:** `useApi`, `useApiEffect` (§8.2)  
**Type utilities:** `groupReadingsByDay` from `@/types/libre.types`

Three sub-hooks are exported from this file. All build on top of `useApi` / `useApiEffect`.

#### `useLibreStatus(fetchLatest?)`

```typescript
function useLibreStatus(fetchLatest = false): {
  status: LibreConnectionStatus | null;
  connected: boolean;       // status?.connected ?? false
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<LibreConnectionStatus | null>;
}
```

The `fetcher` callback is memoised with `useCallback([fetchLatest])` before being passed to `useApiEffect`. Polls `getLibreStatus(fetchLatest)` on mount and whenever `fetchLatest` changes. `connected` is a boolean shortcut — `false` when `status` is `null`.

#### `useLibreReadings(options?)`

```typescript
interface UseLibreReadingsOptions {
  hours?: number;        // History window. Default 24. Max 168 (7 days).
  syncOnLoad?: boolean;  // Trigger a live LibreLink sync before returning readings.
}

function useLibreReadings(options?: UseLibreReadingsOptions): {
  readings: LibreReading[];
  grouped: ReturnType<typeof groupReadingsByDay>;   // day-keyed map of readings
  latest: LibreReading | null;                      // last element of readings[], or null
  count: number;                                    // data?.count ?? 0
  isLoading: boolean;
  isSyncing: boolean;    // true while manual sync is in-flight
  error: string | null;
  syncResult: LibreSyncResult | null;
  refresh: () => Promise<unknown>;
  sync: () => Promise<LibreSyncResult | null>;
}
```

**Data flow:**

- `fetcher` calls `getLibreReadings({ hours, sync: syncOnLoad })` — memoised on `[hours, syncOnLoad]`.
- `useApiEffect(fetcher, [hours, syncOnLoad])` fires on mount and when either option changes.
- `readings` is extracted from `data?.readings ?? []`. `grouped` and `latest` are derived on each render.
- `sync()` — calls `executeSync()` (wraps `syncLibre` via `useApi`), stores result shape in local `useState<LibreSyncResult | null>`, then calls `refetch()` to reload the readings list. Returns the raw result. `isSyncing` reflects the `syncLibre` call only, not the subsequent `refetch`.

`LibreSyncResult` shape:
```typescript
interface LibreSyncResult {
  new_count: number;
  skipped_count: number;
  latest_reading: LibreReading | undefined;
}
```

#### `useLibreConnect()`

```typescript
function useLibreConnect(): {
  connect: (payload: LibreConnectPayload) => Promise<unknown>;
  disconnect: (deleteReadings?: boolean) => Promise<unknown>;
  updateSettings: (settings: LibreSettingsPayload) => Promise<unknown>;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isUpdatingSettings: boolean;
  connectError: string | null;   // error from the connect call only
}
```

Each mutation wraps its service function in a separate `useApi` instance. All three are non-reactive — callers trigger them by invoking the returned function. Loading flags (`isConnecting`, `isDisconnecting`, `isUpdatingSettings`) are independent and can be truthy simultaneously if multiple operations are in-flight.

`disconnect` signature: `(deleteReadings = false)` — defaults to preserving readings. The `deleteReadings` flag is forwarded to `disconnectLibre(deleteReadings)` in the service.

### 8.5 `usePatientConstants.ts` — Store-integration perspective

**File:** `mobile/hooks/usePatientConstants.ts`  
**Store dependencies:** `patient.store.ts` (§7.3), `auth.store.ts` (§7.1)  
**React Native dependency:** `AppState`, `AppStateStatus` from `react-native`  
**Arm 3 cross-reference:** For the visualization role of `hasLoadedFromAPI` and how this hook gates circadian calculations, see Arm 3.

#### Doctor/Admin Guard

If `user?.user_type === 'doctor' || user?.user_type === 'admin'`, the hook sets `isNonPatient = true` and skips all auto-loading. Calling `/api/patient/constants` with a doctor token returns 403. This guard applies to both the TTL effect and the AppState listener.

#### `autoLoad` Parameter

`usePatientConstants(autoLoad = true)` — pass `false` to prevent any automatic loading (e.g., from non-patient screens). `index.tsx` passes `!isDoctor`. When `autoLoad` is `false`, neither the TTL effect nor the AppState listener is registered.

#### Returned Interface

```typescript
interface UsePatientConstantsResult {
  constants: PatientConstants;          // effectiveConstants = constants ?? DEFAULT_PATIENT_CONSTANTS
  hasLoadedFromAPI: boolean;            // true once any successful loadConstants() has resolved
  activeConditions: string[];
  activeMedications: string[];
  medicationSchedules: Record<string, {
    id: string;
    startDate: string;
    endDate: string;
    dailyTimes: string[];
  }>;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getConstant: <K extends keyof PatientConstants>(key: K) => PatientConstants[K];
  updateConstants: (constants: Partial<PatientConstants>) => Promise<void>;
}
```

`constants` is never `null` from the hook's perspective — the hook substitutes `DEFAULT_PATIENT_CONSTANTS` if the store's `constants` is still `null`. Consumers should check `hasLoadedFromAPI` rather than checking for null.

#### Module-level `lastFetchedAt`

A module-level `let lastFetchedAt = 0` persists across component re-renders and remounts within the same JS session, but resets to `0` on full app restart. Starts at `0` — equivalent to "never fetched."

`hasLoadedFromAPI` state is initialised from `lastFetchedAt > 0` (via lazy `useState` initializer) so components that mount *after* the first successful fetch (e.g., navigating back to a screen) start as `true` immediately without waiting for another network call.

#### TTL Effect

```typescript
// Dependency array: [autoLoad, isNonPatient, isLoading, loadConstants]
// `constants` intentionally excluded — see dep-array loop fix
useEffect(() => {
  if (!autoLoad || isNonPatient || isLoading) return;

  const neverFetched = lastFetchedAt === 0;
  const isStale = Date.now() - lastFetchedAt > CONSTANTS_TTL_MS;  // 5 minutes

  if (neverFetched || isStale) {
    loadConstants().then(() => {
      lastFetchedAt = Date.now();
      setHasLoadedFromAPI(true);
    });
  }
}, [autoLoad, isNonPatient, isLoading, loadConstants]);
```

`CONSTANTS_TTL_MS = 5 * 60 * 1000` — in practice this is rarely the trigger because the AppState listener resets `lastFetchedAt = 0` on every background event, making `neverFetched` true on every foreground.

**Dep-array loop fix:** `constants` is deliberately excluded from the dependency array. When it was included, `loadConstants()` resolving and updating `constants` in the store caused the effect to re-fire, re-evaluate staleness (which was now false), and occasionally launch a second load in the same session due to a race between the AppState reset and the `.then()` callback. Replaced `!constants` (neverLoaded check) with `lastFetchedAt === 0`, which has identical semantics without creating the feedback loop.

#### AppState Listener

```typescript
// Dependency array: [autoLoad, isNonPatient, isLoading, loadConstants]
useEffect(() => {
  if (!autoLoad || isNonPatient) return;

  const handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'background' || nextState === 'inactive') {
      lastFetchedAt = 0;  // mark stale unconditionally
    }
    if (nextState === 'active') {
      if (isLoading) return;  // guard against parallel fetches
      loadConstants()
        .then(() => { lastFetchedAt = Date.now(); setHasLoadedFromAPI(true); })
        .catch(() => { /* silently ignore — stale data preferred over crash */ });
    }
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  return () => subscription.remove();
}, [autoLoad, isNonPatient, isLoading, loadConstants]);
```

Effect on patient experience:
- App goes to background → `lastFetchedAt = 0`
- App comes to foreground → `active` handler fires → `loadConstants()` called → store updates → all screens re-render via Zustand

This is the primary fix for the doctor-edits-constants-but-patient-sees-stale-values problem. Doctor edits are visible within one app lifecycle. See DR-07.

#### `refresh()` — Manual reload

```typescript
const refresh = useCallback(async () => {
  if (isNonPatient) return;
  await loadConstants();
  lastFetchedAt = Date.now();
  setHasLoadedFromAPI(true);
}, [loadConstants, isNonPatient]);
```

Safe to call from any user-initiated action (pull-to-refresh, settings save). No-op for doctor/admin accounts.

#### Helper Hooks

Three convenience hooks exported from the same file, reading directly from `usePatientStore` (bypassing `usePatientConstants`):

| Hook | Returns | Note |
|------|---------|------|
| `useInsulinToCarbRatio()` | `number` | `getConstant('insulin_to_carb_ratio')` |
| `useCorrectionFactor()` | `number` | `getConstant('correction_factor')` |
| `useTargetGlucose()` | `number` | `getConstant('target_glucose')` |

These do not expose `hasLoadedFromAPI` — use `usePatientConstants()` when load-gating is needed.

---

## 9. Offline Store

**File:** `mobile/store/offline.store.ts`  
**Hook consumer:** `useOffline.ts` (§8.3)  
**Storage key:** `STORAGE_KEYS.OFFLINE_QUEUE`

### 9.1 `OfflineAction` Interface

```typescript
export interface OfflineAction {
  id: string;              // Timestamp + random suffix: `${Date.now()}-${random}`
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  endpoint: string;        // API path, e.g. '/api/meals'
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload: Record<string, unknown>;
  timestamp: number;       // Date.now() at enqueue time
  retryCount: number;      // Incremented on non-network failure; starts at 0
  maxRetries: number;      // Caller-specified ceiling; action is failed at this threshold
  status: 'pending' | 'syncing' | 'failed' | 'synced';
  errorMessage?: string;   // Last error message on failed actions
}
```

### 9.2 State Shape

```typescript
interface OfflineState {
  isOnline: boolean;
  pendingActions: OfflineAction[];   // All non-synced actions (pending + syncing + failed)
  lastSync: number | null;           // Timestamp of most recent processQueue() completion
  isSyncing: boolean;
  syncError: string | null;
}
```

### 9.3 Queue Lifecycle

```
enqueue(action)
  ├── Generates id
  ├── Sets status: 'pending', retryCount: 0
  ├── Appends to pendingActions
  ├── Calls saveQueue() → AsyncStorage
  └── If isOnline: triggers processQueue()

processQueue()
  ├── Guard: skip if !isOnline || isSyncing || pendingActions.length === 0
  ├── Sets isSyncing: true
  ├── Iterates actions where status === 'pending' || 'failed'
  │   ├── updateActionStatus(id, 'syncing')
  │   ├── Makes HTTP request via apiClient (POST/PUT/PATCH/DELETE)
  │   ├── On success → dequeue(id)   [removes from array + saves queue]
  │   └── On error:
  │       ├── isNetworkError(error) → updateActionStatus(id, 'pending')
  │       │                           setOnline(false)
  │       │                           BREAK (stop processing remaining actions)
  │       └── !isNetworkError:
  │           ├── retryCount + 1 < maxRetries → increment retryCount, keep 'pending'
  │           └── retryCount + 1 >= maxRetries → updateActionStatus(id, 'failed', errorMessage)
  ├── Sets isSyncing: false, lastSync: Date.now()
  └── saveQueue()
```

### 9.4 Network vs Non-Network Error Branching

This is the most critical invariant in the offline store:

| Error type | `status` result | Queue continues? |
|------------|-----------------|-----------------|
| Network error (`isNetworkError()` returns `true`) | `'pending'` | **No** — breaks loop, sets `isOnline: false` |
| Server/application error (`isNetworkError()` returns `false`) | `'pending'` until `maxRetries`; then `'failed'` | **Yes** — continues to next action |

Network errors are transient (connectivity lost mid-sync) — preserving as `pending` allows automatic retry when connectivity returns. Non-network errors (4xx, 5xx from server) are permanent failures — they consume retries and eventually become `failed` so they don't block the queue indefinitely.

### 9.5 Online Re-entry Trigger

`setOnline(status)` checks `wasOffline && status === true`. If the device transitions from offline to online, `processQueue()` is called automatically — no external trigger needed.

### 9.6 `maxRetries` Semantics

`maxRetries` is specified per-action by the caller at enqueue time. It is not a global setting. This allows different action types to have different retry budgets:
- A meal log might use `maxRetries: 3` (low-stakes, re-enterable)
- An insulin dose correction might use `maxRetries: 5` (higher safety stakes)

Once `retryCount >= maxRetries`, the action status becomes `'failed'` permanently until `retryFailed()` is called from `useOffline.ts`.

### 9.7 Persistence

Queue is persisted to `STORAGE_KEYS.OFFLINE_QUEUE` in regular `AsyncStorage` (non-secure). Structure:

```typescript
{
  actions: OfflineAction[];
  lastSync: number | null;
}
```

`loadQueue()` is called on `useOffline` mount to restore the queue from the previous session. `saveQueue()` is called after every enqueue, dequeue, and processQueue completion.

---

## 10. Storage Utility

**File:** `mobile/utils/storage.ts`

### 10.1 Two Storage Tiers

| Tier | Export | Underlying implementation | When to use |
|------|--------|--------------------------|-------------|
| Secure | `secureStorage` | `expo-secure-store` (native) / `localStorage` (web) | Auth tokens, credentials |
| Regular | `storage` | `AsyncStorage` (native) / `localStorage` (web) | App data (meals, constants, queue) |

Both tiers are platform-agnostic: the `Platform.OS === 'web'` branch uses `localStorage` on web, native storage on iOS/Android.

### 10.2 Storage API Surface

Both `secureStorage` and `storage` expose the same interface:

| Method | Signature | Notes |
|--------|-----------|-------|
| `set` | `(key: string, value: string \| object) => Promise<void>` | Objects are `JSON.stringify`-ed automatically |
| `get` | `(key: string) => Promise<string \| null>` | Returns raw string |
| `getJSON<T>` | `(key: string) => Promise<T \| null>` | Parses JSON; returns `null` on parse error |
| `remove` | `(key: string) => Promise<void>` | Silently succeeds if key absent |

`storage` (regular) additionally exposes:

| Method | Signature |
|--------|-----------|
| `multiRemove` | `(keys: string[]) => Promise<void>` |
| `clear` | `() => Promise<void>` — clears **all** AsyncStorage |

> **Warning:** `storage.clear()` clears the entire AsyncStorage namespace, not just DiaTwin keys. Use `multiRemove(Object.values(STORAGE_KEYS))` for selective cleanup.

### 10.3 `STORAGE_KEYS` Enum

All storage access must use these constants — never hardcoded strings.

```typescript
export const STORAGE_KEYS = {
  AUTH_TOKEN:        'auth_token',        // secureStorage
  REFRESH_TOKEN:     'refresh_token',     // secureStorage (reserved)
  USER_DATA:         'user_data',         // secureStorage
  SHARED_CONSTANTS:  'shared_constants',  // secureStorage
  PATIENT_CONSTANTS: 'patient_constants', // storage (regular)
  OFFLINE_QUEUE:     'offline_queue',     // storage (regular)
  LAST_SYNC:         'last_sync',         // storage (regular)
  PREFERENCES:       'preferences',       // storage (regular)
  CACHED_MEALS:      'cached_meals',      // storage (regular)
  CACHED_GLUCOSE:    'cached_glucose',    // storage (regular)
} as const;
```

**Tier assignment per key:**

| Key | Tier | Rationale |
|-----|------|-----------|
| `AUTH_TOKEN`, `REFRESH_TOKEN`, `USER_DATA`, `SHARED_CONSTANTS` | `secureStorage` | Contains credentials or auth-adjacent data |
| All others | `storage` | Non-sensitive app data |

---

## 11. Cross-Arm References

### What Arm 4 Owns

Arm 4 is the complete mobile client layer: everything between the React Native UI screens and the backend HTTP API. This includes all network calls, Zustand state management, hooks, and storage utilities.

### What Arm 4 Delegates

| Concern | Delegated to | Arm reference |
|---------|--------------|---------------|
| Backend route implementations | Arm 0 | Auth: §3; Patients: §5–6; Doctors: §7; LibreLink: §9 |
| API URL constants (`API.*`) | Arm 1 | §4.2 |
| `apiClient` instance and interceptors | Arm 1 | §4.1 |
| Request/response type definitions | Arm 1 | §4.3+ |
| Patient data computation shapes (PD types) | Arm 2 | All |
| Visualization hooks (`useActiveEffects`, `useBloodGlucoseEstimation`) | Arm 3 | All |
| Visualization contract of `usePatientConstants` | Arm 3 | `hasLoadedFromAPI` gating |

### What Arm 3 Takes from Arm 4

Arm 3 visualization hooks consume:
- `usePatientConstants()` (documented in §8.5 here for store mechanics; Arm 3 for visualization contract)
- `constants.baseline_mode`, `constants.circadian_profile`, and other `PatientConstants` fields via `getConstant()`
- `isLoading` and `hasLoadedFromAPI` as guard flags
- `patient.store.ts → loadConstants()` indirectly (via the hook)

### What the Offline Store Needs from Arm 1

`offline.store.ts` imports `apiClient` and `isNetworkError` from `services/api/client.ts` (Arm 1 §4.1). The `processQueue` loop calls `apiClient.post/put/patch/delete` directly — it does not go through any service file in §4–§6.

### Connectivity Utility — `utils/connectivity.ts`

`checkApiConnectivity()` probes `GET /api/doctor/patients` as its health-check endpoint. This was a deliberate fix from the earlier `/api/doctors` endpoint: `/api/doctors` returns HTTP 403 for doctor tokens (patient-only), which the `apiClient` interceptor re-throws even with `validateStatus: () => true`. `/api/doctor/patients` returns 200 for all authenticated user types and is safe as a universal health probe.

---

## 12. Developer Rules

### DR-01 — `X-Client-Type: mobile` header on every request

Every `apiClient` request must include `X-Client-Type: mobile`. This header is attached by the axios request interceptor in `services/api/client.ts` (Arm 1 §4.1). Do not create raw `fetch()` or alternative axios instances that bypass this interceptor. If a service needs a custom timeout or `validateStatus`, use `apiClient.get(url, { timeout, validateStatus })` — not a new axios instance.

**Why:** The backend uses `X-Client-Type` to differentiate mobile vs web traffic for logging, rate limiting, and response shaping (Arm 0 §3). Requests without this header may receive unexpected responses or be rejected.

**Violation in current codebase:** `watch-hr.ts` imports `axios` directly alongside `apiClient` for the `axios.isAxiosError` type guard. The `axios` import is used only for error detection (`axios.isAxiosError(error)`), not for making requests. All HTTP calls still go through `apiClient`. This is acceptable.

### DR-02 — Offline queue: network errors must remain `pending`, not `failed`

In `offline.store.ts → processQueue()`, `isNetworkError(error)` must be checked before evaluating retry count. Network errors reset the action to `pending` and stop the sync loop. They must never increment `retryCount` or transition to `failed`. Non-network errors (server errors, 4xx) consume retries.

**Why:** A `failed` action requires explicit user or developer intervention (`retryFailed()`). A transient connectivity loss should heal automatically when the network returns — demoting it to `failed` would silently discard pending medical data.

### DR-03 — `null` return from `processQueue` must not break the sync loop

`useApi.execute()` returns `null` on error (it does not throw). `processQueue` is called from `setOnline(true)`, `enqueue()`, and `useOffline → retryFailed()`. None of these callers check the return value. The queue processor must be defensive: if `apiClient` returns `null` for a request, treat it as an error (non-network, increment retryCount) rather than a success.

### DR-04 — Token storage must use `STORAGE_KEYS.AUTH_TOKEN` only

Never use a hardcoded string like `'auth_token'` or `'token'` directly in storage calls. Always use `STORAGE_KEYS.AUTH_TOKEN` from `utils/storage.ts`. This applies to `auth.store.ts`, `services/api/auth.ts`, and any future auth-adjacent code.

**Note:** `auth.ts` (the older duplicate store) uses `storage.set('auth_token', ...)` with a hardcoded string. This is a known inconsistency — `auth.store.ts` (via `authService`) uses `STORAGE_KEYS.AUTH_TOKEN`. The canonical version (`auth.store.ts`) must be used; the older file should be removed.

### DR-05 — Visualization hooks (`useActiveEffects`, `useBloodGlucoseEstimation`, `usePatientConstants` visualization role) are owned by Arm 3

Do not copy or re-implement visualization hook logic in Arm 4 files. If a screen needs blood glucose estimation or active effects data, import from `hooks/useActiveEffects` or `hooks/useBloodGlucoseEstimation` (Arm 3). Do not pull patient constants directly from `patient.store.ts` in visualization components — always go through `usePatientConstants()` which provides the `hasLoadedFromAPI` guard.

### DR-06 — Doctor/admin accounts must never call patient-only endpoints

Any code path that calls `API.PATIENT.CONSTANTS` or other patient-scoped endpoints must be guarded by `user?.user_type !== 'doctor' && user?.user_type !== 'admin'`. The guard is already implemented in `usePatientConstants` (§8.5). If new hooks or stores are added that access patient APIs, they must include the same guard.

### DR-07 — AppState foreground refresh must fire on every active transition

The `lastFetchedAt = 0` reset in the `AppState 'background'` handler ensures every foreground transition triggers a fresh constants fetch, regardless of elapsed time. Do not add a time-based guard inside the AppState `'active'` handler (e.g., "skip if backgrounded for < 1 min") — the purpose is to pick up doctor edits immediately, not to rate-limit refreshes.

### DR-08 — `processQueue` must not be called while `isSyncing: true`

The guard at the top of `processQueue()` (`if (!state.isOnline || state.isSyncing || state.pendingActions.length === 0) return`) prevents concurrent sync runs. Never bypass this guard by calling store actions directly. The `retryFailed()` function in `useOffline` resets action statuses to `pending` before calling `processQueue()`, which is safe because it only changes `status` fields, not `isSyncing`.

### DR-09 — Patient constants cache uses regular storage, not secure storage

`STORAGE_KEYS.PATIENT_CONSTANTS` must be stored via `storage` (AsyncStorage), not `secureStorage` (SecureStore). Patient constants are non-sensitive medical parameters (carb ratios, glucose targets) — they do not require the secure enclave. Using SecureStore for large JSON objects causes performance issues on some Android devices.

### DR-10 — `auth.store.ts` is the canonical auth store

Two auth store implementations exist: `store/auth.store.ts` (canonical — uses `authService` abstraction, JWT expiry guard, `sharedConstants`) and `auth.ts` (legacy duplicate — uses raw `apiClient.post` directly). All imports must reference `store/auth.store.ts`. The legacy `auth.ts` should be removed in a future cleanup sprint.

### DR-11 — `watch-sync.ts` endpoint constants must be migrated to `endpoints.ts`

`watch-sync.ts` defines its own `WATCH` endpoint constant object inline. This is inconsistent with all other services which use `API.*` from `endpoints.ts`. Migrate these constants to `endpoints.ts` as `API.WATCH.*` in a future refactor to ensure they are captured in Arm 1's endpoint catalog and receive the same cross-arm visibility.

### DR-12 — `streamHrSamples` HTTP 429 must trigger session end, never retry

When `streamHrSamples` returns `{ sessionCapReached: true }`, the caller must: (1) call `endWatchSession()` immediately, (2) notify the user that the 15-minute cap was reached, and (3) never retry the stream. The 1800-sample / 15-minute cap is a hard backend limit, not a transient rate limit. Treating it as transient and retrying will cause the session to be aborted without completion data.

### DR-13 — `getMealById` must use the list-scan workaround until backend is fixed

`GET /api/meal/<id>` returns HTTP 405 (backend supports only DELETE at that path). `getMealById` currently fetches the paginated list with `limit: 200` and finds the matching entry. Do not attempt to call the direct GET endpoint. When the backend adds a GET-by-ID route, update `getMealById` and the corresponding `API.MEALS.*` constant in `endpoints.ts` simultaneously.

### DR-14 — `formatActivitiesForBackend` must always use explicit type-first ternary

The activity `type` field must be resolved as:
```typescript
type: activity.type ? activity.type : (activity.isExpected ? 'expected' : 'completed')
```
Never as:
```typescript
type: activity.type || activity.isExpected ? 'expected' : 'completed'
```
The second form has JS operator precedence issues: any truthy `activity.type` (including the string `'completed'`) resolves to `'expected'` due to how `||` binds with `?`. This was a known bug (B-5) that has been fixed; do not reintroduce it.

---

*End of DiaTwin Arm 4: Mobile Client Layer — Document version 2.1*  
*Hooks section (§8) updated from source files: `useAuth.ts`, `useApi.ts`, `useOffline.ts`, `useLibre.ts`, `usePatientConstants.ts`.*
