# DiaTwin — Arm 1: Constants & Data Ingestion
**Reference Document — Current State**

```
================================================================
Scope
  Python:     constants.py · patient_routes.py · time_manager.py
              blood_sugar.py · activity.py · meal_insulin.py
              import_routes.py · libre_service.py · libre_routes.py
              watch_hr_routes.py · watch_sync_service.py · watch_hr_autosegment.py
  TypeScript: constants/shared-constants.ts · constants/index.ts
              constants_types.ts · usePatientConstants.ts · patient.store.ts
              utils/time/TimeManager.ts
              services/api/endpoints.ts · services/api/client.ts
              UnifiedBloodSugarInput.tsx · MealForm.tsx
              UnifiedActivityInput.tsx · UnifiedInsulinInput.tsx

Cross-references
  Arm 0 (App Infrastructure) owns: config.py · main.py · auth.py · schedulers
         · fhir_routes.py · doctor_routes.py
         → @token_required, CORS, scheduler lifecycle → Arm 0
  Arm 2 (Data Operations) owns: pharmacodynamics.py · calculation utils
  Arm 3 (Visualization)   owns: chart components · useActiveEffects hook
================================================================
```

---

## Table of Contents

- [§0 Architecture Overview](#0-architecture-overview)
- [§1 Constants System](#1-constants-system)
  - [§1.1 `constants.py`](#11-constantspy)
  - [§1.2 `constants/shared-constants.ts`](#12-constantsshared-constantsts)
  - [§1.3 `constants_types.ts`](#13-constants_typests)
  - [§1.4 `constants/index.ts`](#14-constantsindexts)
  - [§1.5 `patient_routes.py` — GET / PUT / PATCH /api/patient/constants](#15-patient_routespy)
  - [§1.6 `usePatientConstants.ts`](#16-usepatientconstantsts)
  - [§1.7 `patient.store.ts`](#17-patientstorets)
- [§2 TimeManager](#2-timemanager)
  - [§2.1 `time_manager.py`](#21-time_managerpy)
  - [§2.2 `utils/time/TimeManager.ts`](#22-utimestimemanagerts)
- [§3 Constants Numeric Cross-Reference](#3-constants-numeric-cross-reference)
- [§4 API Service Layer (Mobile)](#4-api-service-layer-mobile)
  - [§4.1 `services/api/endpoints.ts`](#41-servicesapiendpointsts)
  - [§4.2 `services/api/client.ts`](#42-servicesapiclientts)
- [§5 Manual Entry — Blood Sugar](#5-manual-entry--blood-sugar)
  - [§5-A `blood_sugar.py` — Write Path Detail](#5-a-blood_sugarpy--write-path-detail)
- [§6 Manual Entry — Meal + Insulin](#6-manual-entry--meal--insulin)
  - [§6-A `meal_insulin.py` — `submit_meal()` Write Path Detail](#6-a-meal_insulinpy--submit_meal-write-path-detail)
- [§7 Manual Entry — Activity](#7-manual-entry--activity)
- [§8 Manual Entry — Standalone Insulin](#8-manual-entry--standalone-insulin)
- [§9 CGM Sync — LibreLinkUp](#9-cgm-sync--librelinkup)
- [§10 Watch HR — Live Streaming & Google Fit](#10-watch-hr)
- [§11 CSV / JSON Import](#11-csv--json-import)
- [§12 Stored Document Schemas](#12-stored-document-schemas)
- [§13 Activity Source Taxonomy](#13-activity-source-taxonomy)
- [§14 Cross-Arm References](#14-cross-arm-references)
- [§15 Developer Rules](#15-developer-rules)

---

## §0 Architecture Overview

```
CONSTANTS DELIVERY CHAIN
────────────────────────
  constants.py  (Python source of truth)
    └─ GET /api/patient/constants  (patient_routes.py)
         └─ patient.store.ts (Zustand) → usePatientConstants hook
              └─ all calculation utilities + visualization components

MOBILE API SURFACE (endpoints.ts / client.ts)
─────────────────────────────────────────────
  Axios apiClient — 90s timeout, 4 retries, Bearer token, X-Client-Type: mobile
  API.PATIENT.CONSTANTS  = '/api/patient/constants'
  API.BLOOD_SUGAR.CREATE = '/api/blood-sugar'
  API.MEALS.CREATE       = '/api/meal'
  API.ACTIVITIES.CREATE  = '/api/record-activities'
  API.INTERNAL.HEALTH    = '/api/health'

MANUAL ENTRY FLOW
──────────────────
  Mobile Screen
    ├── UnifiedBloodSugarInput.tsx ──────────► POST /api/blood-sugar
    ├── MealForm.tsx                           POST /api/meal
    │     ├── UnifiedBloodSugarInput (embedded)    → meal_insulin.py::submit_meal()
    │     ├── UnifiedInsulinInput (embedded)
    │     └── UnifiedActivityInput (embedded) ──►  POST /api/record-activities
    └── Standalone: BS / Insulin / Activity        ↓ activity.py::record_activities()

CGM SYNC FLOW
─────────────
  Background scheduler (Arm 0 §4 — every 4 min keep-alive + sync)
    └─ libre_routes.py::_perform_sync()
         └─ libre_service.get_readings(utc_offset_hours)
         └─ _save_single_reading() → blood_sugar + meals collections

WATCH HR FLOWS
───────────────
  Live stream:  watch_hr_routes.py  (start → stream → end)
  Google Fit:   watch_sync_service.py → watch_hr_autosegment.py
                                      → activities collection

CSV/JSON IMPORT
───────────────
  POST /api/import/* → import_routes.py
    └─ Constants(user_id).get_patient_constants()
    └─ blood_sugar + meals + activities collections

MONGODB COLLECTIONS
────────────────────
  blood_sugar          BG readings (manual + CGM)
  meals                all events (unified log)
  meals_only           meal-only subset
  activities           exercise sessions (all sources)
  libre_connections    CGM auth + settings
  watch_connections    Google Fit OAuth tokens
```

---

## §1 Constants System

### §1.1 `constants.py`

**Role:** Single source of truth for all patient-configurable and population-level constants. Exports 22 top-level keys to TypeScript via `get_all_constants()`. Patient constants are delivered via `GET /api/patient/constants`.

#### Module-level functions

| Function | Signature | Returns |
|---|---|---|
| `get_default_circadian_profile` | `(target_glucose: float = 100) → dict` | `{anchors: list[{hour, value}], source: 'preset'}` |
| `get_circadian_baseline_at_hour` | `(hour_float: float, profile: dict) → float` | Interpolated baseline mg/dL; handles midnight wrap |
| `sanitize_baseline` | `(raw_baseline: float) → dict` | `{value, raw, status: 'ok'|'hard_clamped', warnings}` |

**Circadian profile — physiological features encoded:**
- Somogyi nadir ~3 AM (−15 mg/dL below target)
- Dawn phenomenon 5–8 AM (+20 mg/dL above target)
- Mid-day plateau 10 AM–3 PM (near target)
- Gentle overnight descent 10 PM → 3 AM

Raw anchors are defined for a 100 mg/dL target. When a patient has a different target, the whole curve shifts by `target_glucose - 100.0` so the shape is preserved.

#### Module-level constants

```python
BASELINE_HARD_MIN: float = 55.0   # mg/dL
BASELINE_HARD_MAX: float = 220.0  # mg/dL
```

Both mirror `mobile/utils/calculations/baseline.ts::BASELINE_BOUNDS`.

#### Process-level cache

```python
_PATIENT_CONSTANTS_CACHE: Dict[str, tuple]  # key: patient_id, value: (ConstantConfig, ts)
_CACHE_TTL_SECONDS = 60
```

A 60-second TTL eliminates redundant MongoDB reads during the burst of parallel API calls on mobile app startup.

#### `ConstantConfig` dataclass — patient-modifiable defaults

| Field | Default | Notes |
|---|---|---|
| `correction_factor` | 40 | Canonical default |
| `carb_to_bg_factor` | 4.0 | Primary carb ratio key |
| `carb_to_bg_ratio` | 4.0 | Alias; must be kept in sync via `update_patient_constants` |
| `insulin_to_carb_ratio` | 10 | ICR |
| `target_glucose` | 100 | mg/dL |
| `protein_factor` | 0.5 | Carb-equivalent |
| `fat_factor` | 0.2 | Carb-equivalent |
| `weight_kg` | 70.0 | Allometric scaling; formula: `drop *= (70 / weight_kg) ** 0.25` |
| `hr_base` | 70.0 | Patient resting HR (bpm) |
| `hr_max` | 190.0 | Patient max HR (bpm) |
| `daily_reset_hour` | 7 | Range 0–23 (UTC) |
| `timezone_offset_minutes` | 0 | UTC offset; never null |
| `baseline_mode` | `'dynamic'` | `'dynamic'` \| `'preset'` |
| `circadian_profile` | `{}` | Populated at runtime by `get_patient_constants()` |

`baseline_mode` values:
- `'dynamic'` — subtracts today's cumulative effects from the latest reading (requires a recent BG reading).
- `'preset'` — looks up the 24-hour circadian profile at the current hour (works without a recent reading).

#### `Constants` class — population-level constants

These are class-level attributes exported to TypeScript via `get_all_constants()`. They are not patient-modifiable.

| Constant | Value summary |
|---|---|
| `HR_MODEL` | 10 ODE parameters: `tau_HR=5.0`, `tau_Z=10.0`, `tau_W=90.0`, `a=0.05`, `alpha=0.0008`, `max_sensitivity_boost=0.60`, `dt=1.0`, `acute_rate_per_min=0.15`, `hr_max_pop=190.0`, `hr_base_pop=70.0` |
| `INTENSITY_HR_FRACTION` | `light: 0.50`, `moderate: 0.65`, `vigorous: 0.80` |
| `INTENSITY_PEAK_BOOST` | `light: 0.10`, `moderate: 0.25`, `vigorous: 0.40` |
| `LEVEL_TO_INTENSITY` | `{-2: None, -1: None, 0: 'light', 1: 'moderate', 2: 'vigorous'}` |
| `MEAL_ABSORPTION_PROFILES` | 6 profiles: `very_fast`, `fast`, `medium`, `slow`, `very_slow`, `mixed` |
| `BASELINE_HARD_MIN` | 55.0 mg/dL |
| `BASELINE_HARD_MAX` | 220.0 mg/dL |
| `VIEW_MODE_CONFIGS` | 7 configs: `3h`, `6h`, `12h`, `24h`, `3d`, `week`, `month` |
| `T1D_BG_CONSTANTS` | `iob_lookback_hours=48`, `mob_lookback_hours=12`, and 5 other timing fields |
| `NET_EFFECT_THRESHOLDS` | 8 BG direction bands (`high_rising=50` … `rapidly_falling=-50`) |
| `TIMING_THRESHOLDS` | `min_active_carbs=5`, `max_active_carbs=30`, `high_iob_threshold=2`, `slow_meal_activity_threshold=20` |
| `ACTIVITY_LEVELS` | 5 entries, values −2 to 2 |
| `ACTIVITY_INTENSITY_LEVELS` | `light/moderate/vigorous` with `hr_fraction` and `level` |

#### `Constants` class — key instance and class methods

| Method | Signature | Notes |
|---|---|---|
| `get_patient_constants()` | `() → dict` | Returns patient dict + `MEAL_ABSORPTION_PROFILES`; injects circadian profile when empty |
| `update_patient_constants(new)` | `(new: dict) → bool` | MongoDB write + dual-key sync for `carb_to_bg_factor` / `carb_to_bg_ratio` |
| `get_all_constants()` | `cls () → dict` | Full 22-key SHARED_CONSTANTS payload for TS export |
| `get_cumulative_lookback_hours(reset_hour)` | `(reset_hour: int = 7) → int` | Returns `reset_hour + 24 + 1` |
| `export_all_constants_safe()` | `cls () → bool` | Writes `.js` and `.ts` files in local dev; no-op on Render |
| `invalidate_patient_cache(patient_id)` | `cls (patient_id: str) → None` | Removes entry from `_PATIENT_CONSTANTS_CACHE` |
| `get_constant(key)` | `(key: str, default=None) → Any` | Checks `patient_config` then class attributes |

#### `VIEW_MODE_CONFIGS` — `cumulativeLookbackHours` formula

```
cumulativeLookbackHours = max(pastHours, daily_reset_hour + 24 + 1)
```

For the default reset hour of 7: minimum is 32 h. For multi-day views where `pastHours` already exceeds 32, `pastHours` is used as-is. At request time, use `get_cumulative_lookback_hours(daily_reset_hour)` with the patient's actual reset hour.

---

### §1.2 `constants/shared-constants.ts`

**Role:** TypeScript export of all 22 keys from `constants.py`. Single source of truth for all constants used by TS calculation utilities and visualization components.

**Important:** This file is generated by `constants.py::export_all_constants_safe()` and committed to source. It does NOT regenerate at runtime on Render. The committed snapshot must be kept in sync with `constants.py`.

#### All 22 SHARED_CONSTANTS keys

| Key | Type |
|---|---|
| `MEASUREMENT_SYSTEMS` | `MeasurementSystems` |
| `VOLUME_MEASUREMENTS` | `Record` (9 entries) |
| `WEIGHT_MEASUREMENTS` | `Record` (7 entries) |
| `ACTIVITY_LEVELS` | `ActivityLevel[]` (5 entries) |
| `MEAL_TYPES` | `MealType[]` (4 entries) |
| `FOOD_CATEGORIES` | `FoodCategory[]` (17 entries) |
| `DEFAULT_PATIENT_CONSTANTS` | `PatientConstants` |
| `VIEW_MODE_CONFIGS` | 7 configs (`3h`/`6h`/`12h`/`24h`/`3d`/`week`/`month`) |
| `T1D_BG_CONSTANTS` | `T1DBGConstants` |
| `NET_EFFECT_THRESHOLDS` | `NetEffectThresholds` |
| `TIMING_THRESHOLDS` | `TimingThresholds` |
| `INSULIN_MODELS` | `InsulinModel[]` (4 entries) |
| `MEAL_ABSORPTION_PROFILES` | `MealAbsorptionProfile[]` (6 entries) |
| `HR_MODEL` | `HrModel` (10 ODE params) |
| `INTENSITY_HR_FRACTION` | `Record` (3 entries) |
| `INTENSITY_PEAK_BOOST` | `Record` (3 entries) |
| `LEVEL_TO_INTENSITY` | `Record` (5 entries) |
| `ACTIVITY_MODEL_PARAMS` | `ActivityModelParams` |
| `INSULIN_TYPES` | `InsulinType[]` (4 entries) |
| `INSULIN_GL_PROFILES` | `Record` (4 entries) |
| `GLUCOSE_UNITS` | `GlucoseUnits[]` (2 entries) |
| `BASELINE_HARD_MIN` | `number` (55.0) |
| `BASELINE_HARD_MAX` | `number` (220.0) |

#### `validateAbsorptionConfig` IIFE

Runs at module load. Validates that every `typeFilter` string in `ABSORPTION_TO_INSULIN_CONFIG` matches a medication `type` category present in `medication_factors` (e.g. `"rapid_acting"`, `"short_acting"`). Throws in development; logs a warning in production.

#### `AbsorptionType`

```typescript
const _mealProfiles = SHARED_CONSTANTS.MEAL_ABSORPTION_PROFILES;
export type AbsorptionType = keyof typeof _mealProfiles;
```

Derived from `MEAL_ABSORPTION_PROFILES` keys — never hand-maintain this union.

#### Utility functions exported

`convertToGrams`, `convertToMl`, `calculateHealthFactors`, `getInsulinInfo`, `getMealAbsorptionProfile`, `getCircadianBaseline`, `getCumulativeLookbackHours`, `getActivityLevel`, `getMealType`, `getFoodCategory`, `getTimeOfDayFactor`, `getInsulinTimingGuideline`, `getInsulinsByType`.

---

### §1.3 `constants_types.ts`

**Role:** TypeScript interface definitions for the `PatientConstants` shape and related types.

#### `PatientConstants` interface — all fields

| Field | TS type | Required? | Notes |
|---|---|---|---|
| `insulin_to_carb_ratio` | `number` | required | |
| `correction_factor` | `number` | required | |
| `target_glucose` | `number` | required | |
| `protein_factor` | `number` | required | |
| `fat_factor` | `number` | required | |
| `carb_to_bg_factor` | `number` | required | Primary key |
| `daily_reset_hour` | `number` | required | |
| `timezone_offset_minutes` | `number` | required | Never null |
| `baseline_mode` | `'dynamic'\|'preset'` | required | |
| `circadian_profile` | `CircadianProfile` | required | Always populated |
| `activity_coefficients` | `{ [key: string]: number }` | required | |
| `absorption_modifiers` | `{ [key: string]: number }` | required | |
| `insulin_timing_guidelines` | `{ [key: string]: InsulinTimingGuideline }` | required | |
| `meal_timing_factors` | `{ [key: string]: number }` | required | |
| `time_of_day_factors` | `{ [key: string]: TimeOfDayFactor }` | required | |
| `meal_absorption_profiles` | `{ [key: string]: MealAbsorptionProfile }` | required | |
| `disease_factors` | `{ [key: string]: DiseaseFactor }` | required | |
| `medication_factors` | `{ [key: string]: MedicationFactor }` | required | |
| `carb_to_bg_ratio` | `number?` | optional | Alias for `carb_to_bg_factor` |
| `weight_kg` | `number?` | optional | |
| `hr_base` | `number?` | optional | |
| `hr_max` | `number?` | optional | |

`CircadianProfile.source` is narrowed to `'preset' | 'custom'`. The field is optional on the interface for backward compatibility with pre-existing profiles that lack it.

---

### §1.4 `constants/index.ts`

**Role:** Barrel file for `constants/`. Re-exports `SHARED_CONSTANTS` and helpers (`convertToGrams`, `convertToMl`, `getInsulinsByType`, etc.) from `shared-constants.ts`.

---

### §1.5 `patient_routes.py`

**Routes:** `GET /api/patient/constants` | `PUT /api/patient/constants` | `PATCH /api/patient/constants`

All three routes are decorated with `@token_required` and `@api_error_handler`. See Arm 0 §3.2 for decorator behaviour.

#### GET handler — `get_constants()`

Loads `_DEFAULT_CONSTANTS` at module init (cached; no DB hit on every request). Fetches patient document from `users` collection and merges with defaults. Returns active `medication_schedules` alongside constants.

**All fields returned:**

| Field | Source |
|---|---|
| `patient_id` | `user_id` |
| `insulin_to_carb_ratio` | user doc or default |
| `correction_factor` | user doc or default |
| `target_glucose` | user doc or default |
| `protein_factor` | user doc or default |
| `fat_factor` | user doc or default |
| `carb_to_bg_factor` | user doc or default |
| `carb_to_bg_ratio` | user doc → `carb_to_bg_factor` fallback |
| `weight_kg` | user doc or default |
| `hr_base` | user doc or default |
| `hr_max` | user doc or default |
| `daily_reset_hour` | user doc or default (7) |
| `timezone_offset_minutes` | user doc or default (0); never null |
| `baseline_mode` | user doc or `'dynamic'` |
| `circadian_profile` | user doc → default circadian → `get_default_circadian_profile(target_glucose)` |
| `activity_coefficients` | user doc or default |
| `absorption_modifiers` | user doc or default |
| `insulin_timing_guidelines` | user doc or default |
| `meal_timing_factors` | user doc or default |
| `time_of_day_factors` | user doc or default |
| `meal_absorption_profiles` | user doc or default |
| `disease_factors` | user doc or default |
| `medication_factors` | user doc or default |
| `active_conditions` | user doc or `[]` |
| `active_medications` | user doc or `[]` |
| `medication_schedules` | live DB query (active schedules only) |

#### PUT handler — `update_constants()`

`updatable_fields`:
```
insulin_to_carb_ratio, correction_factor, target_glucose,
protein_factor, fat_factor, carb_to_bg_factor, carb_to_bg_ratio,
daily_reset_hour, timezone_offset_minutes,
activity_coefficients, absorption_modifiers, insulin_timing_guidelines,
baseline_mode, circadian_profile
```

Validations applied before write:
- `daily_reset_hour`: must be `int`, `0 ≤ h ≤ 23`
- `baseline_mode`: must be `'dynamic'` or `'preset'`
- Numeric fields (`insulin_to_carb_ratio`, `correction_factor`, `target_glucose`, `protein_factor`, `fat_factor`, `carb_to_bg_factor`, `carb_to_bg_ratio`): must be positive numbers

**Dual-key sync** applied before `$set`:
```python
if 'carb_to_bg_factor' in update_data and 'carb_to_bg_ratio' not in update_data:
    update_data['carb_to_bg_ratio'] = update_data['carb_to_bg_factor']
elif 'carb_to_bg_ratio' in update_data and 'carb_to_bg_factor' not in update_data:
    update_data['carb_to_bg_factor'] = update_data['carb_to_bg_ratio']
```

After write, calls `Constants.invalidate_patient_cache(user_id)` to clear `_PATIENT_CONSTANTS_CACHE`.

#### PATCH handler — `patch_constants()`

Lightweight partial update. Accepts a flat JSON dict; restricts to `patchable_fields`:
```
timezone_offset_minutes, daily_reset_hour, baseline_mode
```

Used by `App.js` on startup to silently save `timezone_offset_minutes`. Validates each field and calls `Constants.invalidate_patient_cache(user_id)` after write.

#### Patient history delete routes

All require `@token_required` and `@api_error_handler`. Each handler validates ObjectId, checks record ownership, returns 403 on mismatch.

| Route | Collection |
|---|---|
| `DELETE /api/meal/<meal_id>` | `meals_only` |
| `DELETE /api/blood-sugar/<reading_id>` | `blood_sugar` |
| `DELETE /api/activity/<activity_id>` | `activities` |
| `DELETE /api/insulin/log/<log_id>` | `medication_logs` |

#### GDPR export route

`GET /api/patient/export` — returns a single JSON object covering every collection for the authenticated patient. Sensitive fields (`password`, `auth_token`, `refresh_token`, etc.) are stripped from the `account` section. Response schema version `"2.0"`.

---

### §1.6 `usePatientConstants.ts`

**Role:** React hook — single access point for patient constants throughout the mobile app. Wraps `usePatientStore` (Zustand) with TTL-based refresh, AppState foreground listener, doctor/admin guard, and `hasLoadedFromAPI` flag.

**Fetch endpoint:** `apiClient.get(API.PATIENT.CONSTANTS)`

#### Exports

| Export | Description |
|---|---|
| `constants` | Live `PatientConstants` or `DEFAULT_PATIENT_CONSTANTS` while loading |
| `isLoading` | True while in-flight |
| `hasLoadedFromAPI` | False until first successful fetch; initialised from `lastFetchedAt > 0` |
| `error` | Fetch error or null |
| `refresh()` | Forces immediate re-fetch (resets `lastFetchedAt = 0`) |
| `getConstant(key)` | Typed accessor |
| `updateConstants(patch)` | Calls PUT endpoint |

#### TTL (`CONSTANTS_TTL_MS = 5 min`)

Module-level `lastFetchedAt` starts at `0`. Initial-load effect fires when `lastFetchedAt === 0` (never fetched) **or** `Date.now() − lastFetchedAt > 5 min`. `constants` is excluded from the effect dependency array to prevent infinite re-fetch loops.

#### AppState foreground refresh

```
background / inactive → lastFetchedAt = 0   (cache invalidated)
active               → loadConstants()       (silent background refresh)
```

The `'active'` branch contains an `if (isLoading) return` guard to prevent parallel fetches. `isLoading` is in the dependency array.

#### Doctor/admin guard

```typescript
const isNonPatient = user?.user_type === 'doctor' || user?.user_type === 'admin';
```

Prevents 403 errors on non-patient accounts. Gates all auto-load paths, AppState listener, and `refresh()`.

#### `hasLoadedFromAPI` — mandatory consumer pattern

```typescript
const { constants, isLoading, hasLoadedFromAPI } = usePatientConstants();
useEffect(() => {
  if (isLoading || !hasLoadedFromAPI) return;   // wait for real data
  startCalculation(constants);
}, [isLoading, hasLoadedFromAPI, constants]);
```

Without this guard, `baseline_mode` reads as `undefined` → `'dynamic'` on first render, then flips to `'preset'` when real constants arrive.

#### Fallback

```typescript
const effectiveConstants = constants || DEFAULT_PATIENT_CONSTANTS;
```

#### Helper hooks

`useInsulinToCarbRatio`, `useCorrectionFactor`, `useTargetGlucose` — read from `usePatientStore` directly; do not trigger re-fetch.

---

### §1.7 `patient.store.ts`

Zustand store holding `constants`, `isLoading`, `error`, `lastFetchedAt`. Hydrated by `loadConstants()` called from `usePatientConstants`. All consuming hooks/screens re-render automatically when the store updates.

---

## §2 TimeManager

### §2.1 `time_manager.py`

**Version:** 4.3 (Timezone Alignment Fix)

**Role:** Centralised utility for all time-related operations in the Python backend. Mirrors `utils/time/TimeManager.ts` for consistency.

All datetime arithmetic is in UTC. `calendar.timegm()` is used instead of `datetime.timestamp()` because Python's `timestamp()` treats naive datetimes as local time, which would silently corrupt calculations on any server not running UTC.

#### `TimeManager` class — key methods

| Method | Signature | Notes |
|---|---|---|
| `get_daily_reset_time` | `(current_timestamp, reset_hour, timezone_offset_minutes=0) → int` | Returns UTC milliseconds; converts to patient local time, applies reset hour, converts back. Three call sites in Arm 2: `pharmacodynamics.py`, `activity_pharmacodynamics.py`, `activity_pharmacodynamics_routes.py` |
| `is_within_current_day` | `(dose_timestamp, current_timestamp, reset_hour, timezone_offset_minutes=0) → bool` | Uses `>` (not `>=`) to exclude doses exactly at reset time |
| `is_at_reset_time` | `(current_timestamp, reset_hour, timezone_offset_minutes=0) → bool` | True if at reset hour within 1 minute in patient's local time |
| `normalize_to_second_boundary` | `(timestamp) → int` | Used for pharmacodynamic calculations |
| `normalize_to_minute_boundary` | `(timestamp) → int` | Used for user-facing timestamps |
| `calculate_hours_since_with_second_precision` | `(current_time, event_time) → float` | PD calculations |
| `parse_timestamp` | `(timestamp) → int` | Handles `datetime`, `int`, `float`, ISO string |
| `to_milliseconds` | `(dt: datetime) → int` | Strips tzinfo; uses `_naive_utc_to_ms` |

**`get_daily_reset_time` algorithm:**
1. Convert `current_timestamp` to UTC-naive datetime.
2. Apply `timezone_offset_minutes` to get patient local time.
3. Set local time to `reset_hour:00:00`.
4. If current local time < reset local time, subtract one day.
5. Convert back to UTC and return as milliseconds.

---

### §2.2 `utils/time/TimeManager.ts`

**Version:** 4.3-TIMEZONE-FIX

All reset-time calculations use UTC Date methods exclusively, making them immune to device OS timezone.

```typescript
// getDailyResetTime
resetLocalTime.setUTCHours(resetHour, 0, 0, 0);
resetLocalTime.setUTCDate(resetLocalTime.getUTCDate() - 1);  // when before reset

// isAtResetTime
const hours   = currentLocal.getUTCHours();
const minutes = currentLocal.getUTCMinutes();
```

The offset-shifted timestamp is treated as a UTC value throughout. Logic is identical to `time_manager.py::get_daily_reset_time`.

---

## §3 Constants Numeric Cross-Reference

Canonical values across all layers. Any code using a different default is a bug.

| Constant | `constants.py` | `shared-constants.ts` | API (unset patient) |
|---|---|---|---|
| `correction_factor` | 40 | 40 | 40 |
| `target_glucose` | 100 | 100 | 100 |
| `insulin_to_carb_ratio` | 10 | 10 | 10 |
| `carb_to_bg_factor` | 4.0 | 4.0 | 4.0 |
| `carb_to_bg_ratio` | 4.0 | 4.0 | 4.0 |
| `weight_kg` | 70.0 | 70.0 | 70.0 |
| `hr_base` | 70.0 | 70.0 | 70.0 |
| `hr_max` | 190.0 | 190.0 | 190.0 |
| `daily_reset_hour` | 7 | 7 | 7 |
| `timezone_offset_minutes` | 0 | 0 | 0 (never null) |
| `protein_factor` | 0.5 | 0.5 | 0.5 |
| `fat_factor` | 0.2 | 0.2 | 0.2 |
| `BASELINE_HARD_MIN` | 55.0 | 55.0 | N/A |
| `BASELINE_HARD_MAX` | 220.0 | 220.0 | N/A |
| `HR_MODEL.tau_W` | 90.0 | 90.0 | N/A |
| `HR_MODEL.tau_Z` | 10.0 | 10.0 | N/A |
| `HR_MODEL.max_sensitivity_boost` | 0.60 | 0.60 | N/A |
| `INTENSITY_PEAK_BOOST.light` | 0.10 | 0.10 | N/A |
| `INTENSITY_PEAK_BOOST.moderate` | 0.25 | 0.25 | N/A |
| `INTENSITY_PEAK_BOOST.vigorous` | 0.40 | 0.40 | N/A |
| `FIBER_FACTOR` | 1.0 | 1.0 | N/A |

---

## §4 API Service Layer (Mobile)

### §4.1 `services/api/endpoints.ts`

```typescript
export const USE_VERSIONED_API = false; // All routes currently unversioned
```

`v()` helper transparently adds `/api/v1/` when the flag flips. Currently a no-op.

| Group | Key endpoints |
|---|---|
| `AUTH` | `LOGIN '/login'`, `REGISTER '/register'` — root level by design |
| `PATIENT` | `CONSTANTS = v('/api/patient/constants')` |
| `BLOOD_SUGAR` | `CREATE = '/api/blood-sugar'` |
| `MEALS` | `CREATE = '/api/meal'` |
| `ACTIVITIES` | `CREATE = '/api/record-activities'`, `HISTORY`, `BY_ID(id)` |
| `LIBRE` | 6 endpoints matching `libre_routes.py` |
| `WATCH` | 6 endpoints matching `watch_sync_routes.py` |
| `CALCULATIONS` | `IOB = '/api/insulin/active-effect'` aliased as `INSULIN.ACTIVE` |
| `INTERNAL` | `HEALTH = '/api/health'` used in `client.ts::wakeUpServer()` |

### §4.2 `services/api/client.ts`

**Base URL:** `process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:5000'`

| Config | Value | Purpose |
|---|---|---|
| `timeout` | `90_000` ms | Covers Render cold-start |
| `X-Client-Type` | `'mobile'` | Backend issues 90-day JWT |
| Auth | Secure storage, read per-request | Rotation-safe (no in-memory cache) |
| Retry | `MAX_RETRIES=4`, base 2s doubling, cap 15s | Covers `ECONNABORTED`, `ERR_NETWORK`, 502/503/504 |
| 401 handler | Clears `AUTH_TOKEN` and `USER_DATA` from secure storage | |
| Health | `API.INTERNAL.HEALTH` used for `wakeUpServer()` | |

---

## §5 Manual Entry — Blood Sugar

### §5.1 Frontend: `UnifiedBloodSugarInput.tsx`

| Field | Type | Notes |
|---|---|---|
| `value` (bloodSugar) | string → float | Sanitised with `/[^0-9.]/g` |
| `unit` | `'mg/dL' \| 'mmol/L'` | Toggle converts value (÷18 / ×18) |
| `timestamp` | ISO UTC string | Via UnifiedTimePicker; defaults to `new Date().toISOString()` |
| `status` | `'low' \| 'normal' \| 'high' \| null` | Derived: `target_glucose × 0.7` / `target_glucose × 1.3` |

The parent form (`MealForm`) must convert to mg/dL before submitting. The backend always expects mg/dL.

### §5.2 Backend: `blood_sugar.py` — POST /api/blood-sugar

**Auth:** `@token_required` (→ Arm 0 §3.2) **Error handler:** `@api_error_handler`

**Constants accessed:**

| Constant | Method | Default |
|---|---|---|
| `target_glucose` | `get_constant('target_glucose')` | no hardcoded fallback |
| `carb_to_bg_factor` | `.get('carb_to_bg_factor', 4.0)` | 4.0 |
| `correction_factor` | `.get('correction_factor', 40)` | 40 |

**Baseline calculation performed at write time:**
1. Fetch recent meals (last 12 h) and sum `absorbed_carbs` via `calculate_meal_active_carbs()` from `utils/pharmacodynamics`.
2. Fetch stacked insulin effect via `calculate_stacked_insulin_effect()`.
3. `net_effect = meal_impact - insulin_impact`
4. `baseline = blood_sugar - net_effect`
5. Stored under `baseline_calculation` embedded document.

**Write behaviour:**
- Inserts to `blood_sugar` collection.
- Also inserts a `blood_sugar_only` type record to `meals` collection.
- Cross-links both records (`meal_id` on `blood_sugar`, `blood_sugar_id` on `meals`).
- `bloodSugarTimestamp` is stored as `datetime` (not ISO string) in both collections.

### §5.3 Backend: GET /api/blood-sugar

Two GET routes:

| Route | Auth | Notes |
|---|---|---|
| `GET /api/blood-sugar` | `@token_required` | Supports `start_time`, `end_time`, `start_date`, `end_date`, `filter_by` (`timestamp` \| `reading_time`), `patient_id`. Defaults to last 30 days when no time params supplied. Returns `source` field for CGM detection. |
| `GET /api/blood-sugar/<patient_id>` | `@token_required` + doctor check | Doctor-only; supports `range` param (`day`/`week`/`month`) |

**`filter_by=reading_time`** queries `bloodSugarTimestamp` across three storage formats (datetime, ISO string, ISO+Z) with a fallback to `timestamp` for readings that predate the field.

---

## §5-A `blood_sugar.py` — Write Path Detail

### Decorators and imports

`POST /api/blood-sugar` is decorated `@token_required` / `@api_error_handler`. It imports `calculate_meal_active_carbs` from `utils.pharmacodynamics` (→ Arm 2 §2.1) and `calculate_stacked_insulin_effect` from `routes.medication_routes`.

### Timestamp parsing

`bloodSugarTimestamp` from the request body is normalised before any calculations:

```
Z suffix          → replaced with +00:00
no tz info        → +00:00 appended
datetime.fromisoformat() → parsed_timestamp (aware)
```

A `calc_timestamp` (naive UTC) is derived by stripping `tzinfo` from `parsed_timestamp`. All meal and baseline queries run against `calc_timestamp`. If parsing fails, `calc_timestamp` falls back to `datetime.utcnow()`.

### Constants accessed

| Constant | Access method | Default |
|---|---|---|
| `target_glucose` | `Constants(user_id).get_constant('target_glucose')` | no hardcoded fallback |
| `carb_to_bg_factor` | `patient_constants.get('carb_to_bg_factor', 4.0)` | 4.0 |
| `correction_factor` | `patient_constants.get('correction_factor', 40)` | 40 |
| `MEAL_ABSORPTION_PROFILES` | `Constants.MEAL_ABSORPTION_PROFILES` (class attr) | — |

### Baseline recalculation trigger

Performed at every write. The sequence:

```
1. cutoff_time = calc_timestamp − 12 hours

2. recent_meals = meals.find({
       user_id,
       timestamp: {$gte: cutoff_time, $lte: calc_timestamp},
       mealType: {$nin: ['blood_sugar_only', 'insulin_only', 'activity_only']}
   })

3. For each meal:
       carb_data = calculate_meal_active_carbs(
           meal, calc_timestamp, patient_constants, absorption_profiles
       )                             ← Arm 2 §2.1
       total_absorbed_carbs += carb_data['absorbed_carbs']

4. meal_impact    = total_absorbed_carbs × carb_to_bg_factor

5. iob_data       = calculate_stacked_insulin_effect(
       patient_id, target_time=calc_timestamp
   )
   insulin_impact = iob_data['current_bg_reduction']

6. net_effect = meal_impact − insulin_impact
   baseline   = blood_sugar − net_effect
```

Each step is wrapped in a separate `try/except`; a failure in meal or insulin impact calculation falls back to `0` and does not abort the write. Cross-reference Arm 2 §2.1 for the signature and internals of `calculate_meal_active_carbs`.

The resulting `baseline_calculation` embedded document is stored on the `blood_sugar` record:

```python
'baseline_calculation': {
    'baseline':         round(baseline),          # int mg/dL
    'net_effect':       round(net_effect, 1),
    'meal_impact':      round(meal_impact, 1),
    'insulin_impact':   round(insulin_impact, 1),
    'confidence':       'high',
    'calculation_time': calc_timestamp.isoformat()
}
```

### Dual-collection write sequence

```
1. blood_sugar.insert_one(new_reading)
       → blood_sugar_id

2. meals.insert_one(meal_doc)           ← mealType = 'blood_sugar_only'
       → meal_id

3. blood_sugar.update_one(
       {"_id": bs_result.inserted_id},
       {"$set": {"meal_id": meal_id}}
   )
```

The `meal_doc` inserted into `meals` carries `mealType: 'blood_sugar_only'`, `isStandaloneReading: True`, `foodItems: []`, `nutrition: {carbs: 0, ...}`, `suggestedInsulin: 0`, and `blood_sugar_id` for the reverse link. Both documents store `bloodSugarTimestamp` as a naive UTC `datetime` (tzinfo stripped). Cross-reference Rule 12.

### `bloodSugarSource` field

Read from `request.json['bloodSugarSource']`, defaulting to `'standalone'`. Stored verbatim on the `blood_sugar` document. Used by `GET /api/blood-sugar` to indicate CGM vs manual origin to the frontend.

### GET /api/blood-sugar — `filter_by` and default window

`filter_by=reading_time` activates a four-clause `$or` query covering all three `bloodSugarTimestamp` storage formats (datetime, ISO string, ISO+Z string) plus a fallback clause for documents where the field is absent (pre-field-introduction legacy records), in which case `timestamp` is used instead. Cross-reference Rule 13.

When no time params are supplied, the route defaults to the last 30 days (`timestamp >= now − 30d`). This prevents unbounded queries from blocking the single gunicorn worker on Render free tier when a patient has 2000+ CGM entries.

### GET /api/blood-sugar/`<patient_id>` (doctor route)

Requires `user_type == 'doctor'`; returns 403 otherwise. Accepts `range=day|week|month`. All returned documents have `_id`, `timestamp`, and `bloodSugarTimestamp` serialised to ISO strings with `Z` suffix. No `filter_by` support — the doctor view always queries by server `timestamp`. For the richer doctor-facing BG route with ISO datetime params, see Arm 0 §7.4.

---

### §6.1 Frontend: `MealForm.tsx`

**Patient constants:** `usePatientConstants()`. Also imports `SHARED_CONSTANTS` for insulin timing guidelines.

**Fallback defaults used:**

| Site | Fallback |
|---|---|
| `correction_factor ?? 40` | 40 |
| `insulin_to_carb_ratio ?? 10` | 10 |
| `carb_to_bg_factor ?? 4` | 4 |

**Unit handling:** `unit === 'mmol/L' ? Math.round(parseFloat(value) * 18) : …` — conversion to mg/dL enforced at frontend before payload submission.

**Activity submission endpoint:** `apiClient.post(API.ACTIVITIES.CREATE, activitiesData)`

### §6.2 Backend: `meal_insulin.py` — POST /api/meal

**Auth:** `@token_required` (→ Arm 0 §3.2) **Error handler:** `@api_error_handler`

Constants accessed from `patient_constants`:

| Constant | Access |
|---|---|
| `insulin_to_carb_ratio` | `patient_constants['insulin_to_carb_ratio']` |
| `target_glucose` | `patient_constants['target_glucose']` |
| `correction_factor` | `patient_constants['correction_factor']` |
| `carb_to_bg_factor` | `.get('carb_to_bg_factor', 4.0)` |

Inline activities generated by `submit_meal()` carry `'source': 'meal_submission'`.

`bloodSugarUnit` is not read server-side — unit conversion is enforced at the frontend.

---

## §6-A `meal_insulin.py` — `submit_meal()` Write Path Detail

**Route:** `POST /api/meal` — `@token_required` (→ Arm 0 §3.2) / `@api_error_handler`

### Request shape (required + notable fields)

| Field | Type | Notes |
|---|---|---|
| `mealType` | str | required |
| `foodItems` | list | required; each item validated against `supported_measurements` |
| `bloodSugar` | float \| null | mg/dL always; `null` when BG not directly entered |
| `bloodSugarTimestamp` | ISO string | stored as naive UTC datetime |
| `bloodSugarSource` | str | `'actual'` \| `'direct'` \| `'standalone'` \| `'meal_form'` \| `'estimated'` \| `'target_fallback'` |
| `mealTime` | ISO string | if absent, `datetime.utcnow()` is used |
| `insulinTimestamp` | ISO string | actual time the dose was given; preferred over `mealTime` for `taken_at` |
| `intendedInsulin` | float \| null | triggers insulin log write when present |
| `intendedInsulinType` | str \| null | insulin key in `medication_factors` |
| `activities` | list | new inline activities (creates records in `activities` collection) |
| `activityIds` | list | IDs of pre-existing activity records to link |
| `calculationFactors` | dict | full PK state from the mobile frontend (IOB, MOB, cumulative effects, etc.) |
| `notes` | str | |

### `bloodSugar` null-coalescing rule

When `data['bloodSugar']` is `null`, `submit_meal` falls back to `calculationFactors.bloodSugarUsed` for the insulin correction calculation. The frontend sends `null` for the top-level field when the BG was estimated (not directly measured), to prevent creating a `blood_sugar` DB record for a non-actual reading. The fallback ensures correction insulin is still computed correctly from the estimated value.

### `calculate_suggested_insulin()` — inputs

Called with: `(user_id, nutrition, activities, blood_glucose_for_calc, mealType, calculation_factors)`.

Key computation steps inside the function:

```
total_carb_equiv = carbs + (protein × protein_factor) + (fat × fat_factor) − fiber
                   (ADA net-carb standard; fiber_factor = 1.0)
base_insulin     = total_carb_equiv / insulin_to_carb_ratio
correction_insulin = (blood_glucose − target_glucose) / correction_factor
pre_active_total = base_insulin × activity_coefficient + correction_insulin

# Predictive overlap via shared pharmacodynamics (→ Arm 2)
mob_insulin_equivalent = active_meal_carbs / insulin_to_carb_ratio
projected_mob_at_peak  = project_mob_at_time(...)   ← utils.pharmacodynamics
projected_iob_at_peak  = project_iob_at_time(...)   ← utils.pharmacodynamics

total_insulin = max(0, round(pre_active_total
                             − active_insulin
                             + mob_insulin_equivalent)
                    × overlap_adjustment
                    × health_multiplier, 1)
```

`correction_factor` default inside this function is `40` (not `50`). Cross-reference Rule 2 and Arm 2 Rule 5.

### Write sequence — four collections

```
1. meals.insert_one(meal_doc)
       → meal_id

2. IF foodItems non-empty AND mealType not in
   ['blood_sugar_only', 'activity_only', 'insulin_only']:

     meals_only.insert_one(meals_only_doc)
       → meals_only_id

     meals.update_one(meal_id, {$set: {meals_only_id}})

     FOR each item in data['activityIds']:
         activities.update_one(id, {$set: {meal_id}})   ← link existing

     FOR each item in data['activities']:
         activities.insert_one({
             ..., 'source': 'meal_submission', 'meal_id': meal_id
         })                                              ← create new

     meals.update_one(meal_id, {$set: {activity_ids, activities}})

3. IF bloodSugar is not None AND bloodSugarSource in
   {'actual', 'direct', 'standalone', 'meal_form'}:

     blood_sugar.insert_one(blood_sugar_doc)
       → blood_sugar_id
       source = 'meal_record'

     meals.update_one(meal_id, {$set: {blood_sugar_id}})

4. IF intendedInsulin AND intendedInsulinType:

     medication_logs.insert_one(medication_log)
       → medication_log_id
       is_insulin = True
       effect_start_time, onset_time, peak_time, effect_end_time computed
         from administration_time + insulin profile timing

     meals.update_one(meal_id, {$set: {medication_log_id}})

     users.update_one(user_id,
         {$addToSet: {active_medications: intendedInsulinType}}
     )
```

### Blood sugar write guard — `bloodSugarSource` filter

Only sources `'actual'`, `'direct'`, `'standalone'`, `'meal_form'` create a `blood_sugar` document. Sources `'estimated'` and `'target_fallback'` are used for calculation only — they must never produce a DB record. This prevents phantom readings from estimated BG values polluting the CGM/manual history.

### Insulin log timing fields

`administration_time` is resolved with priority: `insulinTimestamp` > `medicationLog.scheduled_time` > `mealTime`. The timing fields written to `medication_logs`:

| Field | Value |
|---|---|
| `taken_at` / `scheduled_time` | `administration_time` |
| `effect_start_time` | `administration_time` |
| `onset_time` | `administration_time + timedelta(hours=onset_hours)` |
| `peak_time` | `administration_time + timedelta(hours=peak_hours)` |
| `effect_end_time` | `administration_time + timedelta(hours=duration_hours)` |

For peakless insulin (`is_peakless=True` or `peak_hours is None`), `peak_hours = duration_hours / 2`.

### `meals_only` collection — write condition and content

Written only for genuine food records (non-sentinel mealTypes). Carries: `user_id`, `timestamp`, `mealType`, `foodItems`, `nutrition`, `notes`, `meal_id`, `source: 'meal_submission'`, and a `calculation_summary` (base insulin, absorption factor, meal timing factor, meal-only suggested insulin, absorption type). Does not carry blood sugar, insulin, or patient-level data — it is a food-only extract used by the meal-on-board endpoint (→ `meal_routes.py`).

### `DELETE /api/meal/<meal_id>` — cascading delete

When a `meals` document is deleted, the handler also deletes:
- Associated `activities` documents (by `activity_ids`)
- The linked `blood_sugar` document (by `blood_sugar_id`)
- The linked `medication_logs` document (by `medication_log_id`)
- The linked `meals_only` document (by `meals_only_id`)

Ownership check: `meal['user_id'] == str(current_user['_id'])` or `user_type == 'doctor'`. Each cascading delete is wrapped in a separate `try/except` so a missing linked document does not abort the meal deletion.

### Embedded form component call pattern (`MealForm.tsx`)

`MealForm` embeds three sub-forms as controlled components:

```
MealForm
  ├── UnifiedBloodSugarInput  — emits bloodSugar, bloodSugarTimestamp, unit
  ├── UnifiedInsulinInput     — emits intendedInsulin, intendedInsulinType, insulinTimestamp
  └── UnifiedActivityInput    — emits activities[]
```

Activities are not submitted directly — they are collected into the `MealForm` payload and sent as `data['activities']` to `POST /api/meal`. `MealForm` is responsible for converting mmol/L → mg/dL before submission. `bloodSugarUnit` is forwarded in the payload for logging but is not used server-side.

---

### §7.1 Frontend: `UnifiedActivityInput.tsx`

**Constants:** `SHARED_CONSTANTS.ACTIVITY_LEVELS` (imported directly from `@/constants/shared-constants`).

Delegates activity submission via `onActivityUpdate` callback → `MealForm.tsx` → `API.ACTIVITIES.CREATE`.

### §7.2 Backend: `activity.py` — POST /api/record-activities

**Auth:** `@token_required` (→ Arm 0 §3.2) **Error handler:** `@api_error_handler`

Every `activity_record` in `process_activity()` receives `'source': 'manual'`. All exception handlers use `except Exception as e:` with `logger.warning`; no bare `except:` blocks.

---

## §8 Manual Entry — Standalone Insulin

### §8.1 Frontend: `UnifiedInsulinInput.tsx`

**Constants:** `usePatientConstants()`. Imports `DEFAULT_PATIENT_CONSTANTS`, `getInsulinsByType`, `SHARED_CONSTANTS`.

**Fallback defaults used (display-only IOB/MOB impact calculations):**

| Line | Default |
|---|---|
| `correction_factor ?? 40` | 40 |
| `carb_to_bg_factor ?? 4` | 4 |

The payload submitted to the parent callback carries `intendedInsulin`, `intendedInsulinType`, `insulinTimestamp` as separate fields; the parent (MealForm) handles submission.

---

## §9 CGM Sync — LibreLinkUp

### §9.1 `libre_service.py`

`_parse_libre_timestamp` default UTC offset: `0.0`. `get_readings()` accepts and passes through `utc_offset_hours`.

### §9.2 `libre_routes.py`

Module-level constants:
```python
DEFAULT_SYNC_INTERVAL_MINUTES = 5
MAX_READINGS_PER_SYNC = 500
LIBRE_SOURCE_TAG = "libre_cgm"
```

**Endpoint guard matrix:** All endpoints require `@token_required` (→ Arm 0 §3.2).

| Endpoint | Error handler | Notes |
|---|---|---|
| `POST /api/libre/connect` | granular try/except | `traceback.format_exc()` never in response body |
| `DELETE /api/libre/disconnect` | ✓ | |
| `GET /api/libre/status` | ✓ | `?fetch_and_save_latest=true` triggers a write |
| `POST /api/libre/sync` | ✓ | |
| `PUT /api/libre/settings` | ✓ | `5 ≤ sync_interval_minutes ≤ 60` |
| `GET /api/libre/readings` | ✓ | Filters by `bloodSugarTimestamp` |

**Background auto-sync scheduler:** → Arm 0 §4. `_perform_sync()` is called from there every 4 minutes per eligible user.

**`_perform_sync()` constants usage:**
```python
_pc = Constants(user_id).get_patient_constants()
utc_offset_hours = _pc.get("timezone_offset_minutes", 0) / 60
target_glucose   = ...  # fallback 100
```

**Deduplication:** `_save_single_reading()` performs an explicit `find_one` before `insert_one`. Dedup is at the route/service boundary, not via a DB unique index.

**Token security:** `_format_connection_status()` never exposes `auth_token`, `email_encrypted`, or `password_encrypted`.

`connected_at` stored as `datetime.utcnow()`. `bloodSugarTimestamp` stored as `datetime`.

---

## §10 Watch HR

### §10.1 `watch_hr_routes.py` — Live Streaming

All endpoints require `@token_required` (→ Arm 0 §3.2).

| Endpoint | Error handler |
|---|---|
| `POST /api/watch/activity/start` | ✓ |
| `POST /api/watch/hr/stream` | ✓ |
| `POST /api/watch/activity/end` | ✓ |
| `GET /api/watch/activity/status` | ✓ |

**Background Google Fit auto-sync scheduler:** → Arm 0 §5.

### §10.2 `watch_sync_service.py` — Google Fit OAuth Sync

Timestamps from Google Fit are UTC nanoseconds → `datetime.fromtimestamp(ns / 1e9, tz=timezone.utc)`. No UTC offset arithmetic needed (unlike LibreLinkUp).

`last_sync` string parsing uses `replace("Z", "+00:00")` with a defensive branch for naive datetimes from older documents.

`_build_status()` never exposes tokens.

### §10.3 `watch_hr_autosegment.py`

**Version:** 2.1

**Role:** Continuous HR stream → discrete exercise session segmentation. Used by the Google Fit sync path and the live streaming endpoint.

#### `SWIM_LANE_CONFIG` (module-level)

These are stream-level absolute BPM thresholds. They are intentionally outside the patient constants pipeline because they operate on raw HR values before any per-patient intensity classification.

| Constant | Value |
|---|---|
| `hr_sedentary_max` | 50 bpm |
| `hr_moderate_low` | 100 bpm |
| `hr_moderate_high` | 140 bpm |
| `debounce_start/end/transit` | 6 samples |
| `min_session_minutes` | 2.0 |
| `max_session_minutes` | 15.0 |

`segment_hr_stream()` accepts a `config_override` dict for per-user overrides. If per-patient swim-lane tuning is needed in the future (athletes, chronotropic incompetence), add `swim_lane_config` to `ConstantConfig` and pass it from the route layer.

#### `session_to_activity_doc()` — session HR field naming

Session-level min/max HR is stored under `session_hr_min` / `session_hr_peak`, not `hr_base` / `hr_max`. This prevents the ODE reader from using session extremes as patient resting/max HR:

```python
if session.get("hr_base") is not None:
    doc["session_hr_min"]  = session["hr_base"]   # display / debugging only
if session.get("hr_max") is not None:
    doc["session_hr_peak"] = session["hr_max"]    # display / debugging only
```

#### Input validation

- HR samples outside 20–300 bpm are discarded.
- Samples must provide one of: `timestamp_iso`, `t_sec`, or `t_min` (relative to `base_time`).
- Output is sorted by timestamp to handle out-of-order batches.

---

## §11 CSV / JSON Import

### `import_routes.py`

All call sites use `Constants(user_id).get_patient_constants()` to load constants. The `get_user_constants()` function has been removed entirely.

| Constant | Source | Default |
|---|---|---|
| `target_glucose` | `Constants(user_id).get_patient_constants()` | 100 |
| `insulin_to_carb_ratio` | same | 10 |
| `correction_factor` | same | 40 |
| `activity_coefficients` | same | string keys |

Source tags: `'source': 'imported'` on both BG records and activity records.

**Performance note:** `import_blood_sugar()` calls `Constants(user_id).get_patient_constants()` inside the per-record loop (O(N)). The 60-second `_PATIENT_CONSTANTS_CACHE` in `constants.py` mitigates this in practice.

---

## §12 Stored Document Schemas

### `blood_sugar` collection

```python
{
  'user_id':             str,
  'bloodSugar':          float,         # mg/dL
  'status':              str,           # 'low' | 'normal' | 'high'
  'target':              float,
  'timestamp':           datetime,      # server WRITE time
  'bloodSugarTimestamp': datetime,      # READING time (user-specified)
  'notes':               str,
  'source':              str,           # see §13
  'baseline_calculation': {
    'baseline':          int,
    'net_effect':        float,
    'meal_impact':       float,
    'insulin_impact':    float,
    'confidence':        str,
    'calculation_time':  str,
  },
  'meal_id':             str,           # linked meals._id
}
```

`timestamp` = server write time. `bloodSugarTimestamp` = when the patient measured. For patient-facing time-range queries, use `filter_by=reading_time` (maps to `bloodSugarTimestamp`).

CGM docs additionally contain: `reading_type`, `trend`, `trend_label`, `is_high`, `is_low`. Treat these as optional fields when querying across sources.

### `meals` collection (unified log)

```python
{
  'user_id':              str,
  'timestamp':            datetime,    # meal time
  'mealType':             str,         # 'blood_sugar_only' | meal type
  'foodItems':            list[dict],
  'bloodSugar':           float | None,
  'bloodSugarTimestamp':  datetime | None,
  'bloodSugarSource':     str,
  'intendedInsulin':      float | None,
  'intendedInsulinType':  str | None,
  'calculationFactors':   dict | None,
  'notes':                str,
  'suggestedInsulin':     float,
  'insulinCalculation':   dict,
  'nutrition':            dict,
  'source':               str,
  'activity_ids':         list[str],
  'meal_id' / 'blood_sugar_id' / 'medication_log_id': str | None,
}
```

### `activities` collection

```python
{
  'user_id':          str,
  'timestamp':        datetime,        # write time
  'type':             'expected' | 'completed' | 'in_progress',
  'level':            int,             # -2 to 2
  'impact':           float,
  'intensity':        'light' | 'moderate' | 'vigorous',
  'bg_direction':     int,             # -1 or +1
  'source':           str,             # see §13
  'startTime':        str | None,
  'endTime':          str | None,
  'duration':         str,             # 'HH:MM'
  'duration_minutes': float,
  'hr_trace':         list | None,
  'hr_base':          float | None,
  'hr_max':           float | None,
  'notes':            str | None,
  # Watch-session-only fields (see §10.3):
  'session_hr_min':   float | None,
  'session_hr_peak':  float | None,
}
```

### `libre_connections` collection

```python
{
  'user_id':               str,
  'email_encrypted':       str,    # Fernet — NEVER in API responses
  'password_encrypted':    str,    # Fernet — NEVER in API responses
  'auth_token':            str,    # JWT — NEVER in API responses
  'token_expires':         datetime,
  'auto_sync_enabled':     bool,
  'sync_interval_minutes': int,    # 5–60
  'last_sync':             datetime,
  'connected_at':          datetime,
}
```

### `watch_connections` collection

```python
{
  'user_id':               str,
  'access_token':          str,    # NEVER exposed
  'refresh_token':         str,    # NEVER exposed
  'token_expires_at':      float,  # Unix timestamp
  'google_email':          str,
  'auto_sync_enabled':     bool,
  'sync_interval_minutes': int,
  'connected_at':          str,    # ISO UTC
  'last_sync':             str | None,
}
```

---

## §13 Activity Source Taxonomy

| `source` value | Created by |
|---|---|
| `'manual'` | `activity.py::process_activity()` |
| `'meal_submission'` | `meal_insulin.py::submit_meal()` (inline activities) |
| `'imported'` | `import_routes.py::import_activities()` |
| `'watch'` | `watch_hr_routes.py` (live stream) |
| `'google_fit'` | `watch_sync_service.py::_perform_sync()` |

CGM blood sugar source: `'libre_cgm'` (module-level `LIBRE_SOURCE_TAG` in `libre_routes.py`).

---

## §14 Cross-Arm References

### Arm 0 owns (App Infrastructure)

- Flask app factory, blueprint registration, `/api/v1/*` proxy, CORS, environment config
- `@token_required` decorator and JWT generation — all auth guard details are in Arm 0 §3
- Background scheduler lifecycle for Libre (Arm 0 §4) and Watch (Arm 0 §5)
- FHIR export + GDPR erasure routes
- Doctor–patient access control and all `/api/doctor/*` routes

### Arm 1 owns (this document)

- Constants definition, export, and delivery (`constants.py` → `GET /api/patient/constants`)
- All `SHARED_CONSTANTS` TypeScript types and utility functions
- `TimeManager.py` and `TimeManager.ts` — reset-time and timestamp normalisation
- All data ingestion routes: manual entry, CGM sync, watch HR, CSV/JSON import
- MongoDB document schemas for `blood_sugar`, `meals`, `activities`, `libre_connections`, `watch_connections`

### Arm 2 owns (Data Operations)

- `pharmacodynamics.py` — insulin and meal PD curves
- `activity_pharmacodynamics.py` — HR ODE exercise model
- `activity_pharmacodynamics_routes.py` — active-effects API
- `calculate_meal_active_carbs()` — called by `blood_sugar.py` for baseline calculation
- `get_daily_reset_time()` — called from `time_manager.py`

### Arm 3 owns (Visualization)

- Chart components consuming `SHARED_CONSTANTS.VIEW_MODE_CONFIGS`
- `useActiveEffects` hook
- `INTENSITY_PEAK_BOOST` chart fallback usage (defined in Arm 1; consumed in Arm 3)

---

## §15 Developer Rules

These are permanent invariants. They are stated as rules, not history.

**Constants sourcing**

1. `SHARED_CONSTANTS` is the only permitted source for `HR_MODEL` parameters, `INTENSITY_PEAK_BOOST`, `ACTIVITY_LEVELS`, `LEVEL_TO_INTENSITY`, and all absorption profiles in TypeScript. Never redeclare these locally in any component or utility.

2. `correction_factor` defaults must use `40` everywhere — in Python constants, TypeScript fallbacks, and all consumer fallback expressions (`correction_factor ?? 40`). The value `50` is incorrect.

3. `carb_to_bg_factor` and `carb_to_bg_ratio` are aliases and must always be kept in sync. Any write path that updates one must update both. This applies to `constants.py::update_patient_constants()`, the PUT handler in `patient_routes.py`, and the PATCH handler.

4. `timezone_offset_minutes` must never be returned as `null` from `GET /api/patient/constants`. The fallback is `0`.

5. `circadian_profile` must never be an empty dict in the GET response. Always inject `get_default_circadian_profile(target_glucose)` when the stored profile lacks anchors.

6. All TS calculation utilities needing a numeric constant must import from `@/constants/shared-constants`. Local redeclarations of any `SHARED_CONSTANTS` value are not permitted.

**Constants delivery**

7. `shared-constants.ts` is generated by `constants.py::export_all_constants_safe()` and committed to source. It does not regenerate at runtime on Render. After any change to `constants.py`, regenerate and commit `shared-constants.ts`.

8. `AbsorptionType` must be derived from `keyof typeof _mealProfiles` (the live `MEAL_ABSORPTION_PROFILES` constant). Do not hand-maintain this union.

9. `ABSORPTION_TO_INSULIN_CONFIG.typeFilter` strings must match medication `type` categories (e.g. `"rapid_acting"`, `"short_acting"`), not medication key names. The `validateAbsorptionConfig` IIFE enforces this at module load.

**Data access**

10. All Python call sites must use `Constants(user_id).get_patient_constants()` to load patient constants. The removed function `get_user_constants()` must not be re-introduced.

11. `GET /api/blood-sugar/<patient_id>` requires `@token_required` and a doctor-type check. This route must not be accessible to unauthenticated callers.

12. `bloodSugarTimestamp` must be stored as a `datetime` object (not an ISO string) in both the `blood_sugar` and `meals` collections.

13. For patient-facing time-range queries on blood sugar, use `filter_by=reading_time` (maps to `bloodSugarTimestamp`). The default `timestamp` field reflects the server write time, not when the patient measured.

**Error handling**

14. `traceback.format_exc()` must never appear in any HTTP response body, including 500 responses.

15. Every Flask route handler that writes to the database must be decorated with `@api_error_handler`. No bare `except:` blocks — use `except Exception as e:` with `logger.warning` or `logger.error`.

**Activity records**

16. Every activity record written by `activity.py::process_activity()` must carry `'source': 'manual'`.

17. Inline activities generated by `meal_insulin.py::submit_meal()` must carry `'source': 'meal_submission'`.

18. Imported activity records must carry `'source': 'imported'`.

19. `API.ACTIVITIES.CREATE` must be used for all activity submissions in MealForm. Never hardcode `'/api/record-activities'` directly.

**Watch HR segmentation**

20. `session_to_activity_doc()` must store session-level HR extremes under `session_hr_min` and `session_hr_peak`, not `hr_base` and `hr_max`. Using `hr_base`/`hr_max` would cause the ODE reader to treat session extremes as the patient's resting and maximum heart rate.

**TimeManager**

21. All timezone-sensitive Date operations in `TimeManager.ts` must use UTC methods (`setUTCHours`, `getUTCHours`, `getUTCDate`, `setUTCDate`). Local-timezone Date methods produce incorrect reset times on devices in non-UTC timezones.

22. `time_manager.py` must use `calendar.timegm()` — not `datetime.timestamp()` — to convert naive UTC datetimes to milliseconds. Python's `timestamp()` treats naive datetimes as local time and silently introduces a timezone offset on any server not running UTC.

**LibreLinkUp**

23. `sync_interval_minutes` lower bound is `DEFAULT_SYNC_INTERVAL_MINUTES` (5). Values below 5 are rejected.

24. `connected_at` must be stored as `datetime.utcnow()` in the `libre_connections` collection.

25. The `GET /api/libre/status?fetch_and_save_latest=true` parameter triggers a database write. This is intentional and documented.

**usePatientConstants**

26. Consumers must guard on `isLoading && hasLoadedFromAPI` before using constants in calculations. Without this guard, `baseline_mode` and other required fields read from `DEFAULT_PATIENT_CONSTANTS` on first render, then flip when real constants arrive, causing a double-calculation.

27. The doctor/admin guard (`user_type === 'doctor' || user_type === 'admin'`) must gate all auto-load paths, the AppState listener, and `refresh()` to prevent 403 errors on non-patient accounts.

**`blood_sugar.py` write path**

28. `calculate_meal_active_carbs()` must always receive all four arguments: `(meal, calc_timestamp, patient_constants, absorption_profiles)`. The fourth argument (`absorption_profiles`) is `Constants.MEAL_ABSORPTION_PROFILES` — a class-level attribute, not an instance call. Omitting it causes the function to fall back to hardcoded profile values. Cross-reference Arm 2 §2.1.

29. The baseline recalculation in `POST /api/blood-sugar` queries the `meals` collection with `mealType: {$nin: ['blood_sugar_only', 'insulin_only', 'activity_only']}`. This exclusion must be preserved. Including sentinel types would double-count carb effects from standalone BG readings logged as `blood_sugar_only` records.

30. `bloodSugarTimestamp` must be stored as a naive UTC `datetime` in the `blood_sugar` collection (tzinfo stripped via `.replace(tzinfo=None)`). Storing it as an aware datetime or an ISO string introduces BSON type mismatches in range queries. Cross-reference Rule 12.

31. The `blood_sugar_only` record inserted into the `meals` collection by `POST /api/blood-sugar` must set `isStandaloneReading: True` and `foodItems: []`. Consumers that query `meals` for food-bearing records must exclude `mealType == 'blood_sugar_only'` from their queries.

32. `traceback.format_exc()` appears in the `except` block of `add_blood_sugar()` — written only to the server log (`logger.error`), never to the HTTP response body. The `return jsonify({'error': str(e)}), 500` line must never be changed to include `traceback.format_exc()`. Cross-reference Rule 14 and Arm 0 Rule 10.

**`meal_insulin.py` — `submit_meal()` write path**

33. Sources `'estimated'` and `'target_fallback'` in `bloodSugarSource` must never trigger a `blood_sugar` collection write. Only sources in `{'actual', 'direct', 'standalone', 'meal_form'}` create DB records. Adding a new source that represents a non-actual reading requires adding it to neither the allowed set nor the guard condition; it must be treated as non-writable by default.

34. `meals_only` is written only when `foodItems` is non-empty and `mealType` is not a sentinel type (`blood_sugar_only`, `activity_only`, `insulin_only`). Any new sentinel mealType introduced in the ingestion layer must be added to this exclusion list in `submit_meal()`.

35. The insulin log written to `medication_logs` must carry `is_insulin: True`. This field is the only reliable discriminator for insulin records in `medication_logs`, which also contains non-insulin medications. The doctor insulin history endpoint (Arm 0 §7.4) and the FHIR export (Arm 0 §6.1) both filter on this field.

36. `administration_time` resolution order in `submit_meal()` is: `insulinTimestamp` > `medicationLog.scheduled_time` > `mealTime`. This priority must not be reversed. `insulinTimestamp` represents the actual administration moment; `mealTime` is when the meal occurs, which may differ by the pre-bolus offset.
