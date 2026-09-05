# DiaTwin — Arm 2: Data Operations
**Reference Document — Current State**

```
================================================================
Scope
  Python:     pharmacodynamics.py · activity_pharmacodynamics.py
              activity_pharmacodynamics_routes.py
              cumulative_effects_routes.py
              medication_routes.py · meal_routes.py · error_handler.py

  TypeScript: utils/calculations/cumulative-effects.ts · net-effect.ts
              utils/calculations/baseline.ts · utils/calculations/index.ts
              utils/calculations/resolve-live-effects.ts
              utils/glucose/blood-glucose-estimation.ts
              utils/glucose/meal-pharmacodynamics.ts · meal-impact.ts
              utils/glucose/meal-impact-curves.ts · carb-equivalents.ts
              utils/glucose/index.ts
              utils/insulin/pharmacodynamics.ts · pharmacokinetics.ts
              utils/activity/activity-pharmacodynamics.ts
              services/api/calculations.ts
              services/api/activity-pharmacodynamics.ts
              services/insulinCalculationService.ts
              services/api/doctor.ts
              services/api/doctor-management.ts
              types/calculation.types.ts · types/pharmacodynamics.types.ts
              types/active-effects.types.ts

Cross-references
  Arm 1 (Constants & Ingestion) owns: constants.py · shared-constants.ts
         · usePatientConstants.ts · patient_routes.py · TimeManager
         → Always import constants from SHARED_CONSTANTS / @/constants/shared-constants
  Arm 3 (Visualization) owns: chart components · useActiveEffects hook
         → calculateActivityEffectForCumulative exported from this arm (§5.1)
         → ODE ground truth documented here (§2) — not re-documented in Arm 3
  Forms (MealForm · UnifiedInsulinInput · QuickMealForm) consume AED snapshot
         via resolveLiveEffects() (§4.4-A) — documented here as a Arm 2 utility
         even though the data originates from the Arm 3 ActiveEffectsDisplay
================================================================
```

---

## Table of Contents

- [§0 Architecture Overview](#0-architecture-overview)
- [§1 ODE Model Ground Truth — Z/W State](#1-ode-model-ground-truth)
  - [§1.1 State Variable Architecture](#11-state-variable-architecture)
  - [§1.2 Acute BG-Lowering Path (Z-state only)](#12-acute-bg-lowering-path)
  - [§1.3 Sensitivity Multiplier Path (W-state only)](#13-sensitivity-multiplier-path)
  - [§1.4 Canonical Post-Session Model Summary](#14-canonical-post-session-model-summary)
  - [§1.5 Exact ODE Constants](#15-exact-ode-constants)
- [§2 Backend Calculation Engine](#2-backend-calculation-engine)
  - [§2.1 `pharmacodynamics.py`](#21-pharmacodynamicspy)
  - [§2.2 `activity_pharmacodynamics.py`](#22-activity_pharmacodynamicspy)
  - [§2.3 `error_handler.py`](#23-error_handlerpy)
- [§3 Backend Route Assembly](#3-backend-route-assembly)
  - [§3.1 `activity_pharmacodynamics_routes.py`](#31-activity_pharmacodynamics_routespy)
  - [§3.2 `cumulative_effects_routes.py`](#32-cumulative_effects_routespy)
  - [§3.3 `medication_routes.py`](#33-medication_routespy)
  - [§3.4 `meal_routes.py`](#34-meal_routespy)
- [§4 TypeScript Calculation Utilities](#4-typescript-calculation-utilities)
  - [§4.1 `utils/calculations/cumulative-effects.ts`](#41-utilscalculationscumulative-effectsts)
  - [§4.2 `utils/calculations/net-effect.ts`](#42-utilscalculationsnet-effectts)
  - [§4.3 `utils/calculations/baseline.ts`](#43-utilscalculationsbaselinets)
  - [§4.4 `utils/calculations/index.ts`](#44-utilscalculationsindexts)
  - [§4.4-A `utils/calculations/resolve-live-effects.ts`](#44-a-utilscalculationsresolve-live-effectsts)
  - [§4.5 `utils/glucose/blood-glucose-estimation.ts`](#45-utilsglucoseblood-glucose-estimationts)
  - [§4.6 `utils/glucose/meal-pharmacodynamics.ts`](#46-utilsglucosemeal-pharmacodynamicsts)
  - [§4.7 `utils/glucose/meal-impact.ts`](#47-utilsglucosemeal-impactts)
  - [§4.8 `utils/glucose/meal-impact-curves.ts`](#48-utilsglucosemeal-impact-curvests)
  - [§4.9 `utils/glucose/carb-equivalents.ts`](#49-utilsglucosecarb-equivalentsts)
  - [§4.10 `utils/glucose/index.ts`](#410-utilsglucoseindexts)
  - [§4.11 `utils/insulin/pharmacodynamics.ts`](#411-utilsinsulinpharmacodynamicsts)
  - [§4.12 `utils/insulin/pharmacokinetics.ts`](#412-utilsinsulinpharmacokineticts)
  - [§4.13 `utils/activity/activity-pharmacodynamics.ts`](#413-utilsactivityactivity-pharmacodynamicsts)
- [§5 TypeScript Service Layer](#5-typescript-service-layer)
  - [§5.1 `services/api/calculations.ts`](#51-servicesapicalculationsts)
  - [§5.2 `services/api/activity-pharmacodynamics.ts`](#52-servicesapiactivity-pharmacodynamicsts)
  - [§5.3 `services/insulinCalculationService.ts`](#53-servicesinsulinCalculationServicets)
  - [§5.4 `services/api/doctor.ts`](#54-servicesapidoctorts)
  - [§5.5 `services/api/doctor-management.ts`](#55-servicesapidoctor-managementts)
- [§6 TypeScript Types](#6-typescript-types)
- [§7 API Response Field Reference](#7-api-response-field-reference)
- [§8 Constants Registry](#8-constants-registry)
- [§9 Sign Conventions](#9-sign-conventions)
- [§10 Dead Code Inventory](#10-dead-code-inventory)
- [§11 Cross-Arm References](#11-cross-arm-references)
- [§12 Developer Rules](#12-developer-rules)

---

## §0 Architecture Overview

```
╔══════════════════════════════════════════════════════════════════╗
║           DiaTwin — Data Operations Arm                         ║
╚══════════════════════════════════════════════════════════════════╝

CONSTANTS LAYER (→ Arm 1)
──────────────────────────
  constants.py → shared-constants.ts
  All calculation files import from there. No local constant redeclarations.

BACKEND — PYTHON CALCULATION ENGINE
────────────────────────────────────
  pharmacodynamics.py          (meal PD · insulin PK/PD · baseline)
  activity_pharmacodynamics.py (HR ODE: Y/Z/W state model)
        ↓
  Route Assembly Layer
    activity_pharmacodynamics_routes.py  GET /api/activity/pharmacodynamics
    cumulative_effects_routes.py         GET /api/cumulative-effects
                                         GET /api/active-effects-full
    medication_routes.py                 GET /api/insulin/active-effect
    meal_routes.py                       GET /api/meal-on-board

TYPESCRIPT — CALCULATION UTILITIES
────────────────────────────────────
  utils/calculations/  ← cumulative-effects, net-effect, baseline
  utils/glucose/       ← blood-glucose-estimation, meal-pharmacodynamics,
                          meal-impact-curves, carb-equivalents
  utils/insulin/       ← pharmacodynamics, pharmacokinetics
  utils/activity/      ← activity-pharmacodynamics (HR ODE port)

  services/api/calculations.ts              IOB/MOB/cumulative/combo API
  services/api/activity-pharmacodynamics.ts activity PD API service
  services/insulinCalculationService.ts     on-device dose calculation (LIVE)
  services/api/doctor.ts                    doctor-facing patient data API
  services/api/doctor-management.ts         patient-facing doctor authorization API

DOWNSTREAM CONSUMERS (→ Arm 3)
────────────────────────────────
  hooks/useActiveEffects
  hooks/useBloodGlucoseEstimation
  EffectsVisualizationChart.tsx
  BloodGlucoseVisualization.tsx
  ActiveEffectsDisplay.tsx          ← emits live PK snapshot via onEffectsComputed
  BloodGlucoseChart.tsx
  MealForm                          ← consumes AED snapshot via liveActiveEffects prop
  UnifiedInsulinInput               ←   (all three: resolveLiveEffects() merges
  QuickMealForm                     ←    live AED data with stale API snapshot)
```

---

## §1 ODE Model Ground Truth

**This is the single authoritative documentation for the Z/W state model.** Do not re-document in Arm 3 — reference this section.

### §1.1 State Variable Architecture

```
Y  — filtered HR above resting (energy expenditure proxy)
     dY/dt = (HRabove / τ_HR) − (Y / τ_HR)           [τ_HR = 5 min]

Z  — acute IIRd signal (insulin-independent glucose uptake)
     dZ/dt = (1 − Z)  when in_exercise AND onset_active
           = −Z / τ_Z  post-exercise                  [τ_Z = 10 min]
     Z ∈ [0, 1]

W  — cumulative load integral (intensity × duration)
     dW/dt = Y  during exercise
           = −W / τ_W  in recovery                    [τ_W = 90 min]
     W ∈ [0, ∞)
```

### §1.2 Acute BG-Lowering Path (Z-state only)

The function `_integrate_z_drop()` drives the acute BG-lowering signal:

```python
# activity_pharmacodynamics.py
if t >= from_minute:
    total_drop += Z * acute_rate * dt
```

- Only Z is multiplied by `acute_rate_per_min` to accumulate the drop.
- W is computed alongside Z for ODE integrity but is not used in the accumulation.
- Post-session Z decays with `dZ/dt = −Z / τ_Z` (τ_Z = 10 min).
- Scan window capped at `duration + 4 × τ_Z = duration + 40 min`.
- τ_W = 90 min plays zero role in the acute BG-lowering signal.

TypeScript equivalent (EVC and BGV `calculateActivityEffectAtTime`):
```typescript
const TAU_Z_MS = (SHARED_CONSTANTS?.HR_MODEL?.tau_Z ?? 10) * 60_000;
const postExerciseMs = targetMs - endMs;
total += Math.exp(-postExerciseMs / TAU_Z_MS) * fullEffect;
```

### §1.3 Sensitivity Multiplier Path (W-state only)

```python
# activity_pharmacodynamics.py
raw_boost  = alpha * W * (1.0 + Z)
boost      = min(raw_boost, max_boost)   # cap at 0.60
multiplier = round(1.0 + boost, 4)
```

- W drives the prolonged ISF/CR boost (IDRd mechanism).
- Z appears as a multiplicative amplifier `(1 + Z)` during active exercise only.
- Post-session: as Z → 0, the formula simplifies to `1 + α·W` driven by W alone.
- W decays with τ_W = 90 min.

TypeScript equivalent (`calculateSensitivityMultiplierAtTime` — local in EVC and BGV):
```
During session  (start → end):           linear ramp 0 → peakBoost
Post-exercise plateau (end → end + τ_W): peakBoost (flat)
After plateau   (> end + τ_W):           peakBoost × exp(−(t − end − τ_W) / τ_W)
```

### §1.4 Canonical Post-Session Model Summary

| Signal | State variable | τ | Formula | Used for |
|---|---|---|---|---|
| Acute BG-lowering (IIRd) | Z | τ_Z = **10 min** | ∫Z · 0.15 dt, allometric-scaled | `cumulative_activity_effect` (signed mg/dL) |
| Prolonged ISF/CR boost (IDRd) | W | τ_W = **90 min** | 1 + α·W·(1+Z), cap 60% | `sensitivity_multiplier` (≥ 1.0) |
| Lock-in cumulative ("bank balance") | — | permanent until daily reset | linear ramp → flat at fullEffect | visualization cumulative line only (Arm 3) |

### §1.5 Exact ODE Constants

All authoritative in `constants.py` (`Constants.HR_MODEL`), exported to `SHARED_CONSTANTS.HR_MODEL`.

```
tau_HR              =   5.0   min   (HR low-pass filter)
tau_Z               =  10.0   min   (acute Z decay post-exercise)
tau_W               =  90.0   min   (ISF/CR W recovery decay)
a                   =   0.05        (exercise onset threshold)
alpha               =   0.0008      (W·Z → sensitivity boost scaling)
max_sensitivity_boost = 0.60       (60% hard cap)
dt                  =   1.0   min   (Euler step)
acute_rate_per_min  =   0.15  mg/dL/min at Z=1 (calibrated)
hr_max_pop          = 190.0   bpm
hr_base_pop         =  70.0   bpm
allometric_exp      =   0.25        (weight scaling: ×(70/weight_kg)^0.25)
post_tail_window    =  40.0   min   (4 × tau_Z)
```

---

## §2 Backend Calculation Engine

### §2.1 `pharmacodynamics.py`

**Role:** Core PD calculation engine. Pure functions only — no Flask routes.

#### Meal absorption pipeline

| Function | Signature | Notes |
|---|---|---|
| `calculate_gamma_absorption(hours, profile)` | `→ float` | Returns activity % (0–100); gamma density `x^(k-1)·e^(-x/θ)` normalised by its **true maximum** at `x = (k-1)·θ`. Returns **0 before `onset_hours`**. Both were changed on 2026-09-05 (**D21**) — see the note below. |
| `calculate_meal_activity_percentage(hours, meal_profile, absorption_profiles)` | `→ float` | Resolves absorption type then delegates to `calculate_gamma_absorption` |
| `get_meal_absorption_profile(meal, patient_constants, absorption_profiles)` | `→ dict` | Resolves type from `calculation_summary` → `nutrition` → `'medium'`; applies patient `absorption_modifiers` |
| `calculate_absorbed_fraction(hours, profile, absorption_profiles)` | `→ float` (0–1) | 100-step **left-Riemann** sum, normalised by the same sum over the full duration; returns 1.0 after duration, and is **clamped to [0, 1]** (D21, 2026-09-05). This entry said "trapezoidal" until 2026-09-05; it never was, and `frontend/src/utils/mealPharmacodynamics.js` had implemented a trapezoid to match the description (D16). |

> **D21 — the meal curve's shape, corrected 2026-09-05.** Three problems sat
> under one defect number; two are fixed, one is deliberately open.
>
> * **The plateau (fixed).** The curve was normalised by its value at
>   `peak_hours`, but the density peaks at `x = (k-1)·θ`. Those coincide only
>   when `(k-1)·scale_param == 1`, which held for **none** of the six shipped
>   profiles — so the ratio exceeded 1 either side of the true mode and
>   `min(100, …)` clamped it flat. Measured: **18.6% (very_fast) to 38.5%
>   (very_slow)** of every absorption window sat at exactly 100, carrying no
>   information. Normalising by the true maximum removes the plateau without
>   changing the curve's shape, and `calculate_absorbed_fraction` divides by
>   total area, so it is invariant to the rescaling.
> * **The discontinuity at onset (fixed).** Below onset the curve ramped
>   linearly to exactly 5, while the gamma branch opens at ~0 because
>   `t^(k-1) → 0` for every `k > 1`. Absorption rate therefore *fell* by a full
>   5 percentage points at the instant gastric emptying completed. It now
>   returns 0 before onset, which is continuous and matches what `onset_hours`
>   describes: before emptying is done, carbohydrate has not reached the
>   absorptive surface.
> * **`peak_hours` is not the mode (OPEN).** The curve now peaks where the
>   density peaks, but `peak_hours` still names the *normalisation* parameter.
>   The gap is up to 1.6 h (`very_slow`: mode 1.90 h, `peak_hours` 3.50 h).
>   **Editing `peak_hours` changes the curve's shape, not the position of its
>   peak.** Closing this means reparameterising every profile so
>   `(k-1)·scale == 1`, which changes each tail — a clinical decision.
>
> Changed in all three implementations at once (Python, mobile, web frontend);
> the parity harness reports no new divergence. Pinned in
> `backend/tests/test_model_shape_defects.py`.
| `calculate_meal_active_carbs(meal, current_time, patient_constants, absorption_profiles)` | `→ dict` | Full T1D model: `active_carbs`, `absorbed_carbs`, `current_bg_elevation`, `pending_bg_rise` |
| `calculate_meal_total_carbs_for_window(meal, current_time, patient_constants, absorption_profiles)` | `→ dict` | Returns total carbs regardless of absorption state; used by MOB comparison panel |

**Carb field priority chain in `calculate_meal_active_carbs`:**
1. `nutrition.totalCarbEquiv`
2. `nutrition.total_carb_equiv`
3. Computed: `carbs + protein × protein_factor + fat × fat_factor − fiber × 1.0`

Fiber uses a factor of `1.0` (ADA net-carb standard: subtract fully).

#### Insulin PK/PD pipeline

| Function | Signature | Notes |
|---|---|---|
| `calculate_insulin_activity(hours, params)` | `→ float` (0–100) | Gamma distribution for peaked insulins; plateau model for peakless (long-acting) |
| `calculate_iob(hours, initial_dose, profile)` | `→ float` | Trapezoidal integration; returns remaining active units |
| `calculate_insulin_absorption_fraction(hours, profile)` | `→ float` (0–1) | `1.0 − IOB_fraction`; persists at 1.0 after duration |
| `calculate_insulin_cumulative_effect(dose, current_time, patient_constants, reset_hour, tz_offset)` | `→ float` (negative) | Phase 3 persistence: locked at `−(dose × correction_factor)` after absorption. Default fallback medication: `'insulin_aspart'` |
| `project_mob_at_time(active_carbs, elapsed, projection_hours, absorption_type, profiles)` | `→ float` | Projects remaining MOB at a future time using the real absorption model |
| `project_iob_at_time(active_insulin, elapsed, projection_hours, profile)` | `→ float` | Projects remaining IOB at a future time using the real insulin model |

Default insulin fallback (applied when no medication is specified or medication profile is missing):
```python
{
    'onset_hours': 0.375,
    'peak_hours':  2.25,
    'duration_hours': 4.5,
    'type': 'rapid_acting',
    'is_peakless': False,
    'curve_type': 'gamma_steep',
}
```

#### Cumulative effects and baseline pipeline

| Function | Signature | Notes |
|---|---|---|
| `calculate_meal_cumulative_effect(meal, current_time, patient_constants, absorption_profiles, reset_hour, tz_offset)` | `→ float` | Phase 3: persists at `total_carbs × carb_to_bg_factor` after absorption; resets daily |
| `calculate_total_cumulative_effects(meals, insulin_doses, current_time, patient_constants, absorption_profiles, reset_hour, tz_offset)` | `→ dict` | Uses Convention A (see §9). Returns `cumulative_net_baseline` = meal + insulin (insulin already negative) |
| `calculate_instantaneous_meal_effect(meals, current_time, patient_constants, absorption_profiles)` | `→ float` | Only counts active meals (within duration); drops to 0 after absorption |
| `calculate_stable_baseline_from_reading(reading_value, reading_timestamp, meals, insulin_doses, patient_constants, absorption_profiles, reset_hour, tz_offset, activity_effect_at_reading)` | `→ dict` | Uses Convention B (see §9). Skips events after reading time. Hard-clamps via `sanitize_baseline()` |
| `build_circadian_baseline_result(current_time, patient_constants, tz_offset)` | `→ dict` | Preset mode: reads circadian profile at local hour. Returns same shape as `calculate_stable_baseline_from_reading` |
| `get_baseline_result(baseline_mode, current_time, patient_constants, ...)` | `→ dict` | Unified resolver: dispatches to preset or dynamic mode. Falls back to preset when dynamic has no reading |
| `get_daily_reset_time(current_time, reset_hour, tz_offset)` | `→ datetime` | Delegates to `TimeManager.get_daily_reset_time()` |
| `is_within_current_day(dose_time, current_time, reset_hour, tz_offset)` | `→ bool` | Uses `>` (not `>=`) to exclude events exactly at reset time |

#### `calculate_stable_baseline_from_reading` — formula and return shape

```
Formula (Convention B):
  cumulative_net_effect = cumulative_meal_effect − cumulative_insulin_effect + activity_effect_at_reading
  stable_baseline = reading_value − cumulative_net_effect
```

`activity_effect_at_reading` is a signed float (negative = BG-lowering). Subtracting it removes the exercise contribution from the net effect, so the extracted baseline reflects true fasting BG.

The result is hard-clamped by `sanitize_baseline()` from `constants.py`.

Return shape:
```python
{
    'stable_baseline':           float,
    'reading_value':             float,
    'reading_timestamp':         str,
    'cumulative_meal_effect':    float,
    'cumulative_insulin_effect': float,   # positive magnitude (Convention B)
    'cumulative_net_effect':     float,
    'activity_effect_at_reading': float,
    'meals_at_reading':          list,
    'insulin_at_reading':        list,
    'meals_count':               int,
    'insulin_count':             int,
    'baseline_sanitize_status':  str,     # 'ok' | 'hard_clamped'
    'baseline_warnings':         list,
}
```

#### `build_circadian_baseline_result` — return shape

Returns the same keys as `calculate_stable_baseline_from_reading` with these differences:

```python
{
    'stable_baseline':   float,   # from circadian profile at local hour
    'baseline_mode':     'preset',
    'reading_value':     None,
    'reading_timestamp': None,
    'cumulative_meal_effect':    0.0,
    'cumulative_insulin_effect': 0.0,
    'cumulative_net_effect':     0.0,
    'meals_count':       0,
    'insulin_count':     0,
    'circadian_hour':    float,
    'profile_source':    str,     # 'preset' | 'custom'
}
```

`get_baseline_result` returns `baseline_mode = 'dynamic_fallback'` if dynamic mode is requested but no reading is available.

---

### §2.2 `activity_pharmacodynamics.py`

**Version:** 2.2

**Role:** HR ODE exercise model. Pure calculation — no Flask routes.

#### Module-level constants

All imported from `constants.py` — no local copies:

```python
from constants import Constants
from utils.pharmacodynamics import get_daily_reset_time

HR_MODEL              = Constants.HR_MODEL
INTENSITY_HR_FRACTION = Constants.INTENSITY_HR_FRACTION
LEVEL_TO_INTENSITY    = Constants.LEVEL_TO_INTENSITY
```

#### `normalize_activity_record(raw)` — field resolution

| Input field | Resolution | Fallback |
|---|---|---|
| `intensity` (str) | Direct if in INTENSITY_HR_FRACTION | — |
| `level` (int) | Via `LEVEL_TO_INTENSITY` | `None` → returns `None` (sedentary/skip) |
| `startTime` | Primary | → `completedTime` → `timestamp` |
| `duration_minutes` | Direct float; `is not None` check (not truthiness) | → endTime diff → `duration` "HH:MM" → 30.0 |
| `hr_trace` | Passed through | — (synthetic fallback in callers) |
| `bg_direction` | `int(raw.get('bg_direction', -1))` | −1 |

Returns `None` for sedentary levels (≤ −1) and records missing timestamp. `duration_minutes = 0` is clamped to 1.0 min with a warning log.

#### `_get_reset_time(patient_constants, current_time)`

```python
reset_hour    = patient_constants.get("daily_reset_hour", 7)
tz_offset_min = patient_constants.get("timezone_offset_minutes", 0)
return get_daily_reset_time(current_time, reset_hour, tz_offset_min)
```

Delegates to `get_daily_reset_time()` — single source of truth.

#### `_integrate_z_drop(trace, from_minute, to_minute, hr_base, weight_kg)`

Integrates `Z × acute_rate_per_min × dt` from `from_minute` to `to_minute`. Returns unsigned magnitude. Applies allometric weight scaling: `total_drop *= (70.0 / weight_kg) ** 0.25`.

#### `_simulate_hr_ode(trace, elapsed, hr_base)`

Euler-integrates Y/Z/W ODE up to `elapsed` minutes. Returns `(Y, Z, W)`. Used by `calculate_activity_sensitivity_multiplier`.

#### `calculate_activity_cumulative_effect(activity, current_time, patient_constants)`

Returns signed BG effect. Scan window: `min(elapsed, duration + 4 × τ_Z)`. CGM-measured `bg_drop_override` bypasses the ODE with a linear absorption model.

#### `get_activity_on_board(activity, current_time, patient_constants)`

Returns:
```python
{
    "remaining_bg_drop": float,   # unsigned
    "absorbed_fraction": float,   # 0–1
    "minutes_elapsed":   float,
    "is_active":         bool,    # True if still within duration_minutes
    "intensity":         str,
    "bg_direction":      int,
}
```

#### `calculate_activity_sensitivity_multiplier(activities, current_time, patient_constants)`

- Only considers sessions within the last 8 hours.
- Only considers sessions that started after today's reset boundary.
- Takes the maximum multiplier across all sessions (not additive).
- Formula: `1.0 + min(α · W · (1 + Z), max_sensitivity_boost)`

#### `apply_activity_sensitivity(patient_constants, activities, current_time)`

Returns a modified copy (does not mutate the input dict):
- `correction_factor` is multiplied by the multiplier.
- Both `carb_to_bg_ratio` and `carb_to_bg_factor` are divided by the multiplier (whichever keys are present).

#### `calculate_stacked_activity_effect(activities, current_time, patient_constants)` — canonical output shape

```python
{
    "cumulative_activity_effect": float,   # signed mg/dL
    "sensitivity_multiplier":     float,   # ≥ 1.0
    "activity_on_board":          float,   # unsigned remaining drop
    "activity_contributions": [
        {
            "activity_id":          str,
            "start_time":           str | None,   # ISO-8601
            "intensity":            str,
            "duration_minutes":     float,
            "bg_direction":         int,
            "cumulative_bg_effect": float,        # signed per-session
            "remaining_bg_drop":    float,
            "absorbed_fraction":    float,
            "is_active":            bool,
            "model":                str,           # 'hr_ode' | 'synthetic_hr'
        }
    ],
    "active_sessions": int,
}
```

`calculateActivityEffectForCumulative` in TypeScript requires `start_time`, `duration_minutes`, `cumulative_bg_effect` — all present.

---

### §2.3 `error_handler.py`

```python
def api_error_handler(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except Exception as e:
            logger.error(f"API Error: {str(e)}")
            return jsonify({'error': 'An unexpected error occurred'}), 500
    return decorated
```

Returns a generic message — no exception detail exposed. All PD routes use this as the sole outer safety net. No inner `try/except` blocks that leak `str(e)` exist in any route file.

---

## §3 Backend Route Assembly

### §3.1 `activity_pharmacodynamics_routes.py`

**Version:** 1.1 (per-user 60 s TTL cache)

| Route | Method | Auth | Error handler | Cache |
|---|---|---|---|---|
| `/api/activity/pharmacodynamics` | GET | ✓ | ✓ | 60 s TTL; bypassed by explicit `target_time` or `force_refresh=1` |
| `/api/activity/pharmacodynamics/aob` | GET | ✓ | ✓ | None |
| `/api/activity/pharmacodynamics/preview` | POST | ✓ | ✓ | None |

#### Cache implementation

```python
_PD_CACHE_TTL_SECONDS = 60
_cache_lock: threading.RLock
_pd_cache: dict[str, dict]   # {cache_key: {payload, expires_at}}
```

Cache key: `"{user_id}|{reset_date_iso}"` — auto-invalidates at daily reset. Call `invalidate_pd_cache(user_id)` from `watch_hr_routes.end_watch_activity()` after a session ends.

Cache is bypassed when: (1) `?target_time=` is supplied (historical/debug query), or (2) `?force_refresh=1` is passed by the frontend after ending a session.

#### `_resolve_reset_time(patient_constants, target_time)`

```python
reset_hour    = patient_constants.get("daily_reset_hour", 7)
tz_offset_min = patient_constants.get("timezone_offset_minutes", 0)
return get_daily_reset_time(target_time, reset_hour, tz_offset_min)
```

Delegates to `get_daily_reset_time()` — single source of truth.

#### `_build_stacked_response(user_id, target_time, pc)` — full output shape

```python
{
    "cumulative_activity_effect":  float,
    "sensitivity_multiplier":      float,
    "activity_on_board":           float,
    "activity_contributions":      list,
    "active_sessions":             int,
    "effective_correction_factor": float,   # from apply_activity_sensitivity; default 40
    "effective_carb_to_bg_ratio":  float,   # dual-key guard: ratio or factor
    "window_start":                str,
    "window_end":                  str,
    "calculated_at":               str,
    "cached":                      bool,    # observability only
}
```

#### Preview endpoint — request body

```json
{
  "intensity":        "light|moderate|vigorous",
  "duration_minutes": 30,
  "start_time":       "ISO-8601",   // optional
  "hr_trace":         [{...}],      // optional
  "hr_base":          70.0,         // optional
  "hr_max":           190.0         // optional
}
```

---

### §3.2 `cumulative_effects_routes.py`

**Version:** 1.2

| Route | Method | Auth | Error handler | Notes |
|---|---|---|---|---|
| `/api/cumulative-effects` | GET | ✓ | ✓ | No inner try/except |
| `/api/active-effects-full` | GET | ✓ | ✓ | `bg_estimates` block in inner try/except (intentional — returns 200 with `null` on failure) |

#### `get_cumulative_effects()` — top-level response shape

```python
{
    "cumulative_meal_effect":     float,   # +ve
    "cumulative_insulin_effect":  float,   # −ve (Convention A)
    "cumulative_net_baseline":    float,   # signed (includes activity)
    "meal_contributions":         list,
    "insulin_contributions":      list,
    "cumulative_activity_effect": float,
    "activity_on_board":          float,
    "sensitivity_multiplier":     float,   # ≥ 1.0
    "activity_contributions":     list,    # at top level
    "reset_hour":                 int,
    "calculation_time":           str,
    "next_reset":                 str,
}
```

Carb-ratio dual-key guard applied on both paths:
```python
carb_to_bg_ratio = (
    effective_constants.get('carb_to_bg_ratio')
    or effective_constants.get('carb_to_bg_factor', 4.0)
)
```

#### `get_active_effects_full()` — top-level response shape

```python
{
    "iob":                        dict,
    "mob":                        dict,
    "cumulative":                 dict,
    "bg_estimates":               dict | None,
    "totalIOB":                   float,
    "totalActiveCarbs":           float,
    "cumulative_meal_effect":     float,
    "cumulative_insulin_effect":  float,
    "cumulative_net_baseline":    float,
    "instantaneous_meal_effect":  float,
    "cumulative_activity_effect": float,
    "activity_on_board":          float,
    "sensitivity_multiplier":     float,   # at top level
    "activity_contributions":     list,    # at top level
    "calculation_time":           str,
    "patient_id":                 str,
    "reset_hour":                 int,
    "next_reset":                 str,
}
```

`reset_time` is computed once and reused for both the MOB query and the cumulative query.

**MOB query window:**
```python
cutoff_time = target_time - timedelta(hours=12)
effective_cutoff = max(reset_time, cutoff_time)   # prevents pre-reset meals from counting
```

#### `bg_estimates` sub-object

**Reading-available path:**

```python
{
    "stable_baseline":                        float,   # from calculate_stable_baseline_from_reading
    "current_estimated_bg":                   float,   # reading-anchored (not from stable_baseline)
    "projected_final_bg":                     float,
    "cumulative_net_baseline":                float,
    "pending_net_effect":                     float,
    "pending_mob_rise":                       float,
    "pending_iob_reduction":                  float,
    "reading_value":                          float,
    "reading_timestamp":                      str,
    "minutes_since_reading":                  float,
    "cumulative_meal_effect_at_reading":      float,
    "cumulative_insulin_effect_at_reading":   float,
    "cumulative_net_effect_at_reading":       float,
    "activity_effect_at_reading":             float,
    "meals_at_reading_count":                 int,
    "insulin_at_reading_count":               int,
    "cumulative_activity_effect":             float,
    "activity_on_board":                      float,
    "sensitivity_multiplier":                 float,
    "activity_contributions":                 list,
}
```

`current_estimated_bg` formula (reading-anchored, immune to `sanitize_baseline` clamp artefact):
```
current_estimated_bg = reading_value + (total_net_now − total_net_at_reading)
where:
  total_net_now       = cumulative_net_baseline + activity_bg_effect
  total_net_at_reading = baseline_data['cumulative_net_effect']
```

`stable_baseline` is retained in the response for debugging only. It is not used to compute `current_estimated_bg`.

**No-reading fallback path:** same shape with `reading_value=None`, `reading_timestamp=None`, `minutes_since_reading=None`, `baseline_source='target_fallback'`, `confidence='very_low'`. Uses `patient_constants['target_glucose']` as `stable_baseline`.

**Reading selection:** The route fetches all `blood_sugar` documents in the current daily period using an `$or` across both datetime and ISO-string storage formats, then sorts in Python by parsed `bloodSugarTimestamp` to select the most-recently-measured reading.

---

### §3.3 `medication_routes.py`

**Version:** 4.2

All routes: `@token_required` + `@api_error_handler`. No `str(e)` in any response body.

Key route: `GET /api/insulin/active-effect` → reads `target_time` from `request.args.get('target_time')`.

#### `calculate_stacked_insulin_effect()` — constants sourcing

| Constant | Access | Default |
|---|---|---|
| `correction_factor` | `.get('correction_factor', 40)` | 40 |
| `medication_factors` | `.get('medication_factors', {})` | `{}` |
| Default medication | `dose.get('medication', 'insulin_aspart')` | `'insulin_aspart'` |
| Fallback profile | `onset=0.375h, peak=2.25h, duration=4.5h, gamma_steep` | full profile |

#### `/api/insulin/active-effect` response shape

| Field | Notes |
|---|---|
| `totalIOB` | = `total_active_insulin` (duplicate for compat) |
| `contributions` | = `insulin_contributions` |
| `pending_bg_reduction` | IOB × correction_factor |
| `stackingRisk` | `'low'` / `'moderate'` / `'high'` / `'severe'` |
| `calculation_timezone` | always `'UTC'` |

Query param: `?target_time=` (ISO string).

---

### §3.4 `meal_routes.py`

**Version:** 5.1

All routes: `@token_required` + `@api_error_handler`. No outer try/except in any of the 5 routes. Inner try/except blocks for `target_time` and date-range parsing (returning 400) are preserved.

#### `get_meal_on_board()` — query window

```python
reset_hour       = patient_constants.get('daily_reset_hour', 7)
tz_offset        = patient_constants.get('timezone_offset_minutes', 0)
reset_time       = get_daily_reset_time(target_time, reset_hour, tz_offset)
cutoff_time      = target_time - timedelta(hours=max_hours_back)
effective_cutoff = max(reset_time, cutoff_time)
```

#### `format_meal_contribution()` — constants sourcing

```python
carb_to_bg_factor = (
    patient_constants.get('carb_to_bg_factor')
    or patient_constants.get('carb_to_bg_ratio', 4.0)
)
```

`MEAL_ABSORPTION_PROFILES` read from `Constants.MEAL_ABSORPTION_PROFILES` (class-level).

#### `/api/meal-on-board` response

| Field | Notes |
|---|---|
| `total_active_carbs` | Current MOB in grams |
| `expected_bg_impact` | `carbs × carb_to_bg_factor` |

---

## §4 TypeScript Calculation Utilities

All files in this section source constants from `SHARED_CONSTANTS` (`@/constants/shared-constants`). Local constant redeclarations are not permitted.

### §4.1 `utils/calculations/cumulative-effects.ts`

**Version:** 4.14

**Role:** Aggregates insulin, meal, and activity effects into the cumulative "bank balance" BG impact.

#### Exported functions

| Export | Purpose |
|---|---|
| `calculateTotalCumulativeEffects()` | All meals + insulin → signed cumulative net effect |
| `calculateMealCumulativeEffect()` | Per-meal absorbed BG effect since reset |
| `calculateInsulinCumulativeEffect()` | Per-dose absorbed BG reduction since reset |
| `calculateActivityEffectForCumulative()` | Lock-in model for activity bank balance |
| `applyInsulinCumulativeFloor<T>(points)` | Post-pass running-min ratchet on `cumulativeInsulinEffect` across a time-ordered array. Prevents the green cumulative line from rising back up as the post-exercise sensitivity multiplier decays. In-place mutation; returns the same array reference. Not for point-in-time hooks. |

#### `calculateActivityEffectForCumulative` — lock-in model

**Signature:** `(targetMs: number, contributions: ActivityEffectContribution[], resetTimeMs: number, nowMs?: number) → number`

The optional 4th argument `nowMs` (default: `Date.now()`) was added in v4.8 so chart consumers can pass their reference "now" timestamp. This enables correct back-scaling for historical chart points inside an active session:

```
During session (targetMs ≤ nowMs — historical):
  effectAtTarget = cumulative_bg_effect × (fracAtTarget / fracAtNow)
  (back-scales from the delivered amount at nowMs, not the eventual fullEffect)

During session (targetMs > nowMs — future):
  effectAtTarget = cumulative_bg_effect + fracIntoFuture × (fullEffect − cumulative_bg_effect)
  (two-segment ramp, C⁰-continuous at nowMs — v4.10)

Post-session (targetMs > endMs):
  LOCKED at fullEffect permanently — unconditional, regardless of nowMs (v4.13)

Daily reset guard: sessions with startMs < resetTimeMs excluded
```

A delivered BG drop from exercise is a real physiological shift that stays in the bank balance until the daily reset. This is distinct from `calculateActivityEffectAtTime` (which uses Z-state decay — local to EVC/BGV in Arm 3).

**Chart consumers** (EVC, BGV) MUST pass their chart-generation "now" timestamp as `nowMs`. Point-in-time hooks (AED, `useActiveEffects`) evaluate at actual "now" — they can rely on the default `Date.now()`.

**Consumers:** `useActiveEffects.ts`, `ActiveEffectsDisplay.tsx`, `EffectsVisualizationChart.tsx`, `BloodGlucoseVisualization.tsx` — all import from this single location.

**`ActivityEffectContribution` interface** (structural): requires only `start_time: string`, `duration_minutes: number`, `cumulative_bg_effect: number`. `ActivityContribution` from `activity-pharmacodynamics.ts` service satisfies this structurally.

#### `calculateTotalCumulativeEffects` — Phase 3 persistence

Meals and doses persist at 100% effect after fully absorbed (Phase 3) until daily reset, matching backend behavior:

```
Phase 3 (hours-since ≥ duration):
  meal:    return totalCarbs × carb_to_bg_factor  (positive, locked)
  insulin: return −(doseAmount × base_correction_factor)  (negative, locked)
```

Phase 3 always uses `base_correction_factor` (the patient's raw constant), not the exercise-overridden value. `effectiveCorrectionFactor` from exercise scaling applies only to Phases 1 and 2.

**Caller contract:**
```typescript
calculateTotalCumulativeEffects(
  meals,                      // ALL meals in daily window (including fully-absorbed)
  insulinDoses,               // ALL doses in daily window
  currentTime,
  patientConstants,
  absorptionProfiles,
  resetHour,
  timezoneOffsetMinutes,
  activities?,                // ← NEVER pass when adding activity term manually afterward
  effectiveCorrectionFactor?, // Phase 1/2 insulin only; Phase 3 ignores (v4.5)
  overrideCarbToBGFactor?,    // Phase 1/2 meals only; Phase 3 ignores (v4.6)
                              // Pass as a DEDICATED arg — do NOT inject into patientConstants
  absorptionReferenceTime?,   // v4.10: freezes the absorption ramp at "now" for future chart
                              // points while currentTime continues to own the daily-reset check.
                              // Pass undefined in point-in-time evaluators.
  resolvePhase3OverrideCF?,   // v4.13: (absorptionEndMs) => number | undefined
                              // Frozen CF resolver for the Phase 3 clamp (prevents drift as
                              // sensitivityMultiplier decays). Build once per generateChartData
                              // run using makePhase3Resolvers() in EVC/BGV.
  resolvePhase3OverrideC2B?,  // v4.13: (absorptionEndMs) => number | undefined
                              // Frozen C2B resolver for the Phase 3 clamp — same pattern.
)
```

> **v4.6 CRITICAL**: `overrideCarbToBGFactor` must be passed as the dedicated 10th argument. Injecting it into `patientConstants.carb_to_bg_factor` instead would cause Phase 3 meals (which read `patientConstants.carb_to_bg_factor` directly) to use the exercise-reduced value, causing the cumulative green line to plunge during the sensitivity window for fully-absorbed meals.

#### Dual-key carb guard

```typescript
const carbToBgFactor = patientConstants.carb_to_bg_factor
  ?? patientConstants.carb_to_bg_ratio
  ?? 4.0;
```

---

### §4.1-A `applyInsulinCumulativeFloor` (new — v4.14)

#### `applyInsulinCumulativeFloor<T>(points: T[]): T[]`

**Signature:**
```typescript
applyInsulinCumulativeFloor<T extends {
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline:   number;
}>(points: T[]): T[]
```

**Root cause it fixes:**  
`calculateInsulinCumulativeEffect` is a point-in-time function. When swept across a time axis its per-tick values follow the product:

```
contribution(t) = -(doseAmount × absorptionFraction(t) × effectiveCF(t))
```

where `effectiveCF(t) = correctionFactor × sensitivityMultiplierAtTime(t)`. During the post-exercise sensitivity window `sensitivityMultiplierAtTime` decays from its peak (e.g. 1.3) back toward 1.0 while `absorptionFraction(t)` is still growing. Their product has an interior maximum — the contribution deepens, peaks, then rises back toward 0 — producing a characteristic **mountain shape** in the green cumulative bank-balance line.

**Algorithm:**  
Sweeps the time-ordered array with a running floor `insulinFloor` (tracking the most-negative value seen so far):

1. If `|cumulativeInsulinEffect| < 0.1` → no doses on board or daily reset boundary → clear the floor.
2. Otherwise → ratchet: `insulinFloor = min(insulinFloor, value)`.
3. If the current value has risen above the floor (`delta < -0.01`) → clamp it back to the floor and apply the same delta to `cumulativeNetBaseline`.

**Call sites** (all mandatory):

| Component | When called |
|---|---|
| `EffectsVisualizationChart.tsx` | After `generateChartData` builds the full `EffectsChartPoint[]` array, before `setChartData` |
| `BloodGlucoseVisualization.tsx` | After building the full `BGChartPoint[]` array |
| Any future time-series chart that iterates `calculateTotalCumulativeEffects` | Same pattern |

**Not applicable to:**  
`useActiveEffects`, `useBloodGlucoseEstimation`, `ActiveEffectsDisplay` — these evaluate at a single "now" timestamp; without a preceding series there is no floor to compare against.

**Mutation safety:** Mutates the input array in-place. Always called on freshly-allocated arrays from `.map()` before they are handed to React state; this is safe.

---

### §4.2 `utils/calculations/net-effect.ts`

**Version:** 2.0

**Role:** Computes the net effect of all active factors on blood glucose. Wraps `calculateNetEffect` for `useActiveEffects`.

#### Current usage — 6-argument call only

`useActiveEffects` calls this wrapper with 6 arguments — `activityPD` is intentionally NOT passed as the 7th argument. Activity is applied as `activityDeltaSinceReading` in the hook body to avoid double-counting the portion already baked into `stableBaseline`.

⚠️ **The 7th-argument path is currently dead code.** The JSDoc contains prominent `⚠️ 7TH-ARGUMENT PATH IS CURRENTLY DEAD CODE` and `⚠️ DOUBLE-COUNT WARNING` sections. Any future developer adding a consumer must read these before using the 7th arg.

**Preset mode exception:** In preset mode the baseline is circadian-derived (not reading-anchored), so the full `cumulativeActivityEffect` is added directly without delta subtraction.

`getNetEffect()` has been entirely removed from this file. The service-layer `calculations.ts` throws immediately if called.

---

### §4.3 `utils/calculations/baseline.ts`

**Version:** 1.0

**Role:** Calculates the stable baseline BG from recent readings.

```typescript
import { BASELINE_HARD_MIN, BASELINE_HARD_MAX } from '@/constants/shared-constants';
```

`sanitizeBaseline()` is exported from `baseline.ts` but is not re-exported from `calculations/index.ts`. Consumers must import directly from the file.

---

### §4.4 `utils/calculations/index.ts`

Barrel file. Re-exports from `cumulative-effects`, `net-effect`, `baseline`. Exports `calculateActivityEffectForCumulative` and the `ActivityEffectContribution` interface.

---

### §4.4-A `utils/calculations/resolve-live-effects.ts`

**Location:** `mobile/utils/calculations/resolve-live-effects.ts`

**Role:** Merges two competing sources of active-effects data into a single flat
`ResolvedActiveEffects` object that `MealForm`, `UnifiedInsulinInput`, and
`QuickMealForm` can read directly without caring which source was used.

#### Priority rules

| Source | When active | Fields it wins |
|---|---|---|
| `lae` — live `ActiveEffectData` from `ActiveEffectsDisplay.onEffectsComputed()` | When non-null/undefined | All fields it provides: MOB, IOB, AOB, estimatedBG, projectedBG, sensitivityMultiplier |
| `apiSnapshot` — stale `ActiveEffectsFullResult` from `getActiveEffectsFull()` | `lae` absent | activeMealCarbs, activeInsulinUnits, pendingInsulinReduction, sensitivityMultiplier |
| `activityPD` — `ActivityPDResult` from `fetchStackedActivityEffectSafe()` | `lae` absent | sensitivityMultiplier, activityOnBoard |

#### Exported types

```typescript
export interface ResolvedActiveEffects {
  // MOB
  activeMealCarbs:         number;   // g of carbs pharmacologically active
  pendingMealRise:         number;   // mg/dL BG rise still pending (sensitivity-adjusted)

  // IOB
  activeInsulinUnits:      number;   // units of insulin still active
  pendingInsulinReduction: number;   // mg/dL BG drop still to arrive (sensitivity-adjusted)

  // AOB
  sensitivityMultiplier:   number;   // ≥ 1.0
  activityOnBoard:         number;   // unsigned future BG drop remaining

  // BG
  estimatedBG:             number | null;   // null when no reading and no live data
  projectedBG:             number | null;

  // Source flags
  bgSource:                'live' | 'api' | 'target_fallback';
  bgAlreadyHasActivity:    boolean;   // true when estimatedBG came from live AED (activity already included)
}
```

#### `resolveLiveEffects` signature

```typescript
function resolveLiveEffects(
  lae:           ActiveEffectData | undefined,
  apiSnapshot:   ActiveEffectsFullResult | null,
  activityPD:    ActivityPDResult | null,
  carbToBgFactor: number,
): ResolvedActiveEffects
```

#### Path A — live AED data (`lae` present)

All fields are read directly from the `ActiveEffectData` snapshot emitted by
`ActiveEffectsDisplay.onEffectsComputed`. No API call is made.

- `estimatedBG` ← `lae.netEffect.estimatedBG`
- `projectedBG` ← `lae.netEffect.projectedFinalBG`
- `activeMealCarbs` ← `lae.mob.totalActiveCarbs`
- `pendingMealRise` ← `lae.mob.pendingBGRise`
- `activeInsulinUnits` ← `lae.iob.totalActiveInsulin`
- `pendingInsulinReduction` ← `lae.iob.pendingBGReduction`
- `sensitivityMultiplier` ← `lae.aob.sensitivityMultiplier`
- `activityOnBoard` ← `lae.aob.totalAOB`
- `bgAlreadyHasActivity` ← `true` (AED already incorporates `activityDeltaSinceReading`)
- `bgSource` ← `'live'` (or `'target_fallback'` when `lae.metadata.usingTargetFallback`)

#### Path B — stale API snapshot (`lae` absent)

Fields are read from `apiSnapshot` (the `getActiveEffectsFull()` result) and
`activityPD`. `bgAlreadyHasActivity` is `false`.

---

### §4.5 `utils/glucose/blood-glucose-estimation.ts`

**Version:** 5.0

**Role:** Core engine for blood glucose estimation, including unified meal impact and weighted absorption type.

All four numeric defaults replaced with named imports from `SHARED_CONSTANTS`. `absorption_modifiers` fallback reads from `SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.absorption_modifiers`. No production `console.log` calls.

---

### §4.6 `utils/glucose/meal-pharmacodynamics.ts`

**Version:** 3.0

**Role:** Implements the gamma absorption model for meal impact.

`absorption_modifiers` fallback from `SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.absorption_modifiers`. `FIBER_FACTOR` imported from `SHARED_CONSTANTS`. No production `console.log` in `computeCarbEquivFromFoodItems`.

---

### §4.7 `utils/glucose/meal-impact.ts`

**Version:** 2.0

**Role:** UI impact curves (legacy interface). Does NOT contain its own implementation of `generateMealImpactCurve` — re-exports from `meal-impact-curves.ts`.

---

### §4.8 `utils/glucose/meal-impact-curves.ts`

**Version:** 1.0

**Role:** Canonical and sole implementation of the sigmoid/cosine blended absorption curve (`generateMealImpactCurve`). All other files that need this function re-export from here.

---

### §4.9 `utils/glucose/carb-equivalents.ts`

**Version:** 1.0

**Role:** Calculates carb equivalents from protein and fat. `FIBER_FACTOR` imported from `SHARED_CONSTANTS` (in sync with `meal-pharmacodynamics.ts`).

---

### §4.10 `utils/glucose/index.ts`

Barrel file for `utils/glucose`. Exports `generateMealImpactCurve` (from `meal-impact-curves.ts` via `meal-impact.ts` re-export). No name collisions.

---

### §4.11 `utils/insulin/pharmacodynamics.ts`

**Version:** 4.0

**Role:** Complete insulin PD system — IOB, BG impact, stacking analysis, S-curve chart series.

All four exported functions use `correctionFactor = 40` as the parameter default. Unknown-type fallback: `insulin_aspart` profile from `DEFAULT_PATIENT_CONSTANTS.medication_factors`. All PK parameters sourced from `SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors`.

---

### §4.12 `utils/insulin/pharmacokinetics.ts`

**Role:** S3 Guidelines-based insulin activity curves with kurtosis modeling.

`calculateActiveInsulin` uses camelCase `targetTime` — this is the local utility parameter name, distinct from the API query param `target_time`. No conflict.

---

### §4.13 `utils/activity/activity-pharmacodynamics.ts`

**Version:** 1.2-ts

**Role:** TypeScript port of the HR-informed exercise model (Y/Z/W ODE). Pure calculation module.

#### Module-level constants

```typescript
const HR_MODEL              = SHARED_CONSTANTS.HR_MODEL;
const INTENSITY_HR_FRACTION = SHARED_CONSTANTS.INTENSITY_HR_FRACTION;
const LEVEL_TO_INTENSITY    = SHARED_CONSTANTS.LEVEL_TO_INTENSITY;
```

All 10 ODE parameters accessed via `HR_MODEL`.

`computeSyntheticSensitivityMultiplier` uses `alpha * W * (1 + Z)` — matches backend and `insulinCalculationService.ts`.

---

## §5 TypeScript Service Layer

### §5.1 `services/api/calculations.ts`

**Role:** Single source of truth for all active-effect API calls. `mob.ts` re-exports from this file.

#### Endpoints

| Function | Endpoint | Method | Notes |
|---|---|---|---|
| `getActiveInsulin(time?)` | `GET /api/insulin/active-effect` | `?target_time=` | Uses snake_case `target_time` |
| `getMealOnBoard(params?)` | `GET /api/meal-on-board` | `?target_time=` | |
| `getActiveMeals(params?)` | `GET /api/active-meals` | — | |
| `getMealTimingAssessment(params?)` | `GET /api/meal-timing-assessment` | — | |
| `getCumulativeEffects(time?, patientId?, tzOffset?)` | `GET /api/cumulative-effects` | `?target_time=` | |
| `getActiveEffectsFull(time?, patientId?, tzOffset?)` | `GET /api/active-effects-full` | `?target_time=` | |
| `getNetEffect()` | *(no route)* | Throws immediately | Excluded from default export |

`getActiveInsulin` query param:
```typescript
const params = time ? { target_time: new Date(time).toISOString() } : {};
```

No production `console.log` in any function. `carbToBgFactor` is a required parameter in `calculateMOBBgImpact`.

#### Key response interfaces

| Interface | Endpoint | Activity fields |
|---|---|---|
| `CumulativeEffectsResult` | `/api/cumulative-effects` | `cumulative_activity_effect`, `activity_on_board`, `sensitivity_multiplier`, `activity_contributions[]` |
| `ActiveEffectsFullResult` | `/api/active-effects-full` | `cumulative_activity_effect`, `activity_on_board`, `sensitivity_multiplier` (top-level) |
| `BGEstimates` | nested in `ActiveEffectsFullResult` | `cumulative_activity_effect`, `activity_effect_at_reading`, `activity_on_board`, `sensitivity_multiplier` |

`sensitivity_multiplier` is the uniform field name across all three endpoints.

---

### §5.2 `services/api/activity-pharmacodynamics.ts`

**Role:** API service layer for the three HR ODE exercise model endpoints.

| Function | Endpoint | Notes |
|---|---|---|
| `fetchActivityPD(targetTime?)` | `GET /api/activity/pharmacodynamics` | `?target_time=` |
| `fetchActivityOnBoard(targetTime?)` | `GET /api/activity/pharmacodynamics/aob` | |
| `previewActivityEffect(body)` | `POST /api/activity/pharmacodynamics/preview` | |
| `fetchStackedActivityEffectSafe(targetTime?)` | same as `fetchActivityPD` | Catches all errors → `null` |

`fetchStackedActivityEffectSafe` returning `null` must be treated as zero effect — must never break the BG pipeline.

#### `ActivityPDResult` interface

```typescript
interface ActivityPDResult {
  cumulative_activity_effect:  number;
  sensitivity_multiplier:      number;
  activity_on_board:           number;
  activity_contributions:      ActivityContribution[];
  active_sessions:             number;
  effective_correction_factor: number;
  effective_carb_to_bg_ratio:  number;
  w_state_tau_minutes?:        never;   // not serialised by backend ODE
  cached:                      boolean; // observability only — do not branch on this
}
```

`ActivityContribution` fields: `start_time`, `duration_minutes`, `cumulative_bg_effect`, `remaining_bg_drop`, `absorbed_fraction`, `is_active`, `model`.

---

### §5.3 `services/insulinCalculationService.ts`

**Version:** 1.0

**Status:** LIVE, not legacy. Actively called by `MealInput` / `MealForm` for synchronous on-device bolus calculation.

#### Calculation pipeline (9 steps)

```
1. calculateTotalNutrients()    carbs/protein/fat + weighted absorption type
2. calculateCarbEquivalents()   protein & fat → carb-equivalent grams
3. calculateUnifiedMealImpact() base insulin from carb equivalents / ICR
4. calculateActivityImpact()    scale insulin by legacy level & duration
5. correctionInsulin            (BG − target) / effectiveCF
6. IOB/MOB/AOB deduction        subtract IOB, add MOB equiv, subtract AOB equiv
7. peakOverlapAdjustment        predictive overlap of existing MOB/IOB
8. calculateHealthFactors()     disease + medication multipliers
9. Round to 0.1u, apply 0.5u safety floor
```

#### ODE implementation

`computeSyntheticSensitivityMultiplier` runs Y/Z/W Euler ODE using `HR_MODEL` from `SHARED_CONSTANTS`. Uses `alpha * W * (1 + Z)`.

`computeSyntheticAOB` integrates Z-state only for acute BG-drop — no W, no plateau.

#### Key constants sourcing

| Constant | Source |
|---|---|
| `HR_MODEL` | `SHARED_CONSTANTS.HR_MODEL` |
| `LEVEL_TO_INTENSITY` | `SHARED_CONSTANTS.LEVEL_TO_INTENSITY` |
| `MEAL_ABSORPTION_PROFILES` | `SHARED_CONSTANTS.MEAL_ABSORPTION_PROFILES` |
| `INTENSITY_HR_FRACTION` | `SHARED_CONSTANTS.INTENSITY_HR_FRACTION` |
| `correction_factor` default | `?? 40` |
| `carb_to_bg_factor ?? carb_to_bg_ratio ?? 4.0` | dual-key guard in `calculatePeakOverlap` |

Local `PatientConstants` interface mirrors `constants_types.ts`. Includes `carb_to_bg_ratio?: number`.

#### Key exports

| Export | Purpose |
|---|---|
| `calculateNutrients(food)` | Per-food nutrient extraction with portion scaling |
| `calculateTotalNutrients(foods)` | Aggregate nutrients + weighted absorption type |
| `calculateCarbEquivalents(c,p,f,consts)` | Protein/fat → carb equivalent grams |
| `calculateActivityImpact(activities,consts)` | Legacy coefficient-based scaling |
| `calculateHealthFactors(consts,date)` | Disease + medication multiplier |
| `computeSyntheticSensitivityMultiplier(acts,consts,now)` | Full Y/Z/W ODE |
| `computeSyntheticAOB(acts,consts,now)` | Z-state AOB |
| `calculateInsulinDose(params)` | Full pipeline — main entry point |
| `calculateInsulinNeeds(foods,bg,acts,consts,...)` | Convenience wrapper for UI layer |

---

### §5.4 `services/api/doctor.ts`

**Role:** Doctor-facing API service. All functions call the `GET /api/doctor/…` route namespace which enforces `check_doctor_patient_access()` on the backend. None of these endpoints are accessible with a patient token.

**Location:** `mobile/services/api/doctor.ts`

#### Exported functions

| Function | Endpoint | Method | Response type | Notes |
|---|---|---|---|---|
| `getPatients()` | `GET /api/doctor/patients` | GET | `DoctorPatient[]` | Lists all patients the doctor is authorized for |
| `getPatientConstants(patientId)` | `GET /api/doctor/patient/:id/constants` | GET | `PatientConstantsData` | Unwraps `response.data.constants` |
| `updatePatientConstants(patientId, partial)` | `PUT /api/doctor/patient/:id/constants` | PUT | `PatientConstantsData` | Body: `{ constants: Partial<PatientConstantsData> }` |
| `resetPatientConstants(patientId)` | `POST /api/doctor/patient/:id/constants/reset` | POST | `PatientConstantsData` | Restores server-side defaults |
| `updatePatientConditions(patientId, conditions)` | `PUT /api/doctor/patient/:id/conditions` | PUT | `{ active_conditions: string[] }` | Body: `{ conditions: string[] }` |
| `updatePatientMedications(patientId, medications)` | `PUT /api/doctor/patient/:id/medications` | PUT | `{ active_medications: string[] }` | Body: `{ medications: string[] }` |
| `getDoctorPatientMeals(patientId, params?)` | `GET /api/meals/patient/:id` | GET | `{ meals: MealResponse[]; pagination: { total: number } }` | `params`: `{ limit?, skip? }` |
| `getPatientBloodSugar(patientId, params?)` | `GET /api/blood-sugar/patient/:id` | GET | `BloodSugarResponse[]` | `params`: `{ start_date?, end_date?, start_time?, end_time?, limit? }` |
| `getPatientActivities(patientId, params?)` | `GET /api/activities/patient/:id/history` | GET | `ActivityResponse[]` | `params`: `{ limit?, skip? }` |
| `getPatientInsulinDoses(patientId, params?)` | `GET /api/doctor/patient/:id/insulin` | GET | `InsulinDoseResponse[]` | See below |

#### `getPatientInsulinDoses` — special handling

This function always calls the **doctor-namespaced** route `/api/doctor/patient/<id>/insulin`. The patient-scoped equivalent (`/api/patient/<id>/insulin`) returns 404 for doctor tokens. The function:

- Handles both `{ doses: InsulinDoseResponse[] }` and bare `InsulinDoseResponse[]` response shapes defensively.
- Returns `[]` silently on 404 or 403 (logs a `console.warn`). Any other status re-throws.
- Query params: `{ limit?, start_date?, end_date? }`.

```typescript
// Shape guard — backend may return either form:
const raw = response.data;
if (Array.isArray(raw)) return raw;
return (raw as { doses: InsulinDoseResponse[] }).doses ?? [];
```

#### Key types

```typescript
interface DoctorPatient {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  activeConditions?: string[];
  activeMedications?: string[];
}

interface PatientConstantsData {
  insulin_to_carb_ratio: number;
  correction_factor: number;
  target_glucose: number;
  protein_factor: number;
  fat_factor: number;
  carb_to_bg_factor: number;
  daily_reset_hour: number;           // 0–23
  timezone_offset_minutes?: number;   // e.g. 120 = UTC+2
  activity_coefficients: Record<string, number>;
  absorption_modifiers: Record<string, number>;
  insulin_timing_guidelines: Record<string, unknown>;
  disease_factors: Record<string, unknown>;
  medication_factors: Record<string, unknown>;
  active_conditions: string[];
  active_medications: string[];
}

interface InsulinDoseResponse {
  id?: string;
  _id?: string;
  insulinType: string;       // e.g. 'rapid_acting', 'long_acting'
  units: number;
  timestamp?: string;
  doseTime?: string;
  notes?: string;
  iobContribution?: number;  // mg/dL still active (optional, backend may omit)
}
```

#### Relationship to backend routes

`getPatientConstants`, `updatePatientConstants`, `resetPatientConstants`, `updatePatientConditions`, and `updatePatientMedications` map to CRUD routes under `api/doctor/patient/<id>/…`. All are gated by `check_doctor_patient_access()` on the backend — a doctor who is not authorized for the patient will receive 403, and this file does not add explicit 403 guards on those calls (only `getPatientInsulinDoses` does).

`getDoctorPatientMeals`, `getPatientBloodSugar`, and `getPatientActivities` use shared patient-data route prefixes (`API.MEALS.PATIENT_MEALS`, `API.BLOOD_SUGAR.BY_PATIENT`, `API.ACTIVITIES.PATIENT_HISTORY`) — these are distinct from the doctor-namespaced routes. Access control for these is enforced by the backend, not by the client.

MealResponse, BloodSugarResponse, and ActivityResponse are imported from `@/types/api`; they are not redeclared here.

---

### §5.5 `services/api/doctor-management.ts`

**Role:** Patient-facing doctor authorization management. Allows a patient to list available doctors, authorize one or more, and revoke access. **This is explicitly NOT the doctor-facing service** — `doctor.ts` (§5.4) covers that. Calling this file's functions from a doctor session returns 403 from the backend; both `getAllDoctors` and `getAuthorizedDoctors` degrade gracefully on 403 rather than crashing.

**Location:** `mobile/services/api/doctor-management.ts`

#### Exported functions

| Function | Endpoint | Method | Auth role | Behavior on 403 |
|---|---|---|---|---|
| `getAllDoctors()` | `API.DOCTORS.LIST` | GET | Patient only | Returns `[]`, logs `console.warn` |
| `getAuthorizedDoctors()` | `API.PATIENT.AUTHORIZED_DOCTORS` | GET | Patient only | Returns `[]`, logs `console.warn` |
| `authorizeDoctor(doctorId)` | `API.PATIENT.AUTHORIZE_DOCTOR` | POST | Patient only | Re-throws (no 403 guard) |
| `revokeDoctor(doctorId)` | `API.PATIENT.REVOKE_DOCTOR` | POST | Patient only | Re-throws (no 403 guard) |

#### Graceful 403 degradation

`getAllDoctors` is called from a settings screen that can pre-render during a doctor session. Rather than surfacing a confusing error, it returns an empty array:

```typescript
if (status === 403) {
  console.warn(
    '[Doctor Management] getAllDoctors returned 403 — this is expected when ' +
    'a doctor account reaches the patient doctor-management screen. ' +
    'Ensure the settings/doctors screen is hidden for doctor users.'
  );
  return [];
}
```

The same pattern applies to `getAuthorizedDoctors`. The warning log is the signal to fix the UI routing — it should not be silenced.

#### Key types

```typescript
interface Doctor {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface AuthorizedDoctor extends Doctor {
  authorizedAt?: string;   // ISO-8601 timestamp when the patient granted access
}
```

#### Request / response shapes

`authorizeDoctor(doctorId)`:
- Body: `{ doctor_id: string }`
- Response: `{ message: string; doctor?: Doctor }`

`revokeDoctor(doctorId)`:
- Body: `{ doctor_id: string }`
- Response: `{ message: string }`

#### Relationship to doctor.ts (§5.4)

These two files are complementary. `doctor-management.ts` manages the **authorization relationship** (which doctors can see which patients). `doctor.ts` uses that authorization to **read and write patient clinical data** through doctor-namespaced endpoints. They are imported independently; neither re-exports from the other.

---

## §6 TypeScript Types

### `types/calculation.types.ts`

Defines types related to calculations. No dead types.

### `types/pharmacodynamics.types.ts`

The following interfaces have been removed (pre-service-layer artifacts): `GammaDistributionParams`, `IOBResult`, `MOBResult`, `InsulinActivityResult`, `MealActivityResult`, `PharmacodynamicTimelinePoint`, `StackedPharmacodynamicEffect`.

**Retained pending chart-layer scan:** `PharmacodynamicProfile`, `ActivityCurvePoint`, `ActivityCurveData`.

### `types/active-effects.types.ts`

**Canonical location for `ActiveEffectData` and `AobIndirectEffects`.** Import from this file in all consumers — `ActiveEffectsDisplay`, `MealForm`, `UnifiedInsulinInput`, `QuickMealForm`. Do not redeclare locally.

#### `AobIndirectEffects`

```typescript
interface AobIndirectEffects {
  iobPending:    number;   // extra IOB drop still to arrive (unsigned, mg/dL)
  iobDelivered:  number;   // extra IOB drop already happened (unsigned, mg/dL)
  mobPending:    number;   // BG spike saving still pending (unsigned, mg/dL)
  mobDelivered:  number;   // BG spike already suppressed (unsigned, mg/dL)
  // All four are 0 when sensitivityMultiplier ≤ 1.005
}
```

#### `ActiveEffectData`

Full frontend PK snapshot.  Canonical definition — import from this file in all
consumers.  The shape documented in Arm 3 §5.4 is the display reference;
this file is the type authority.

```typescript
interface ActiveEffectData {
  iob: {
    totalActiveInsulin:    number;
    activeDoses:           number;
    currentBGReduction:    number;   // mg/dL already lowered (sensitivity-adjusted)
    rawCurrentBGReduction: number;   // mg/dL already lowered at BASE correction factor
    pendingBGReduction:    number;   // mg/dL still to arrive (sensitivity-adjusted)
    rawPendingBGReduction: number;   // mg/dL still to arrive at BASE correction factor
  };

  mob: {
    totalActiveCarbs:    number;
    activeMealCount:     number;
    currentBGElevation:  number;
    pendingBGRise:       number;     // sensitivity-adjusted
    rawPendingBGRise:    number;     // at raw C2B ratio (no exercise suppression)
  };

  aob: {
    totalAOB:                  number;
    activeSessions:            number;
    cumulativeActivityEffect:  number;   // signed mg/dL
    sensitivityMultiplier:     number;   // ≥ 1.0
    activityContributions:     ActivityContribution[];
    effectiveCorrectionFactor: number;
    effectiveCarbToBgRatio:    number;
    indirectEffects:           AobIndirectEffects;   // always present; zero when sm ≤ 1.005
  };

  netEffect: {
    estimatedBG:               number;
    projectedFinalBG:          number;
    simpleProjectedFinalBG:    number;   // estimatedBG + pendingNetEffect — use this in suggestion cards
    pendingNetEffect:          number;
    cumulativeBaseline:        number;
    cumulativeMealEffect:      number;
    cumulativeInsulinEffect:   number;
    cumulativeActivityEffect:  number;   // informational — full daily value
    activityDeltaSinceReading: number;   // delta actually applied to estimatedBG
    safetyStatus:              string;
    trend:                     string;
    sensitivityMultiplier:     number;
  };

  baseline?: {
    value: number; readingValue: number; readingTimestamp: string | null;
    cumulativeMealEffect: number; cumulativeInsulinEffect: number;
    cumulativeNetEffect: number; mealsCount: number; insulinCount: number;
    isPreset?: boolean; readingDelta?: number | null; hourFloat?: number;
    circadianAtReading?: number | null; cumulAtReadingNet?: number | null;
    clampStatus?: 'ok' | 'hard_clamped'; clampWarnings?: string[];
    rawBaselineValue?: number; readingResidual?: number | null;
  };

  metadata: {
    calculatedAt: string; mealsCount: number; dosesCount: number;
    hasRecentReading: boolean; nextResetMs: number;
    absorbedOnlyDoses: number; absorbedOnlyMeals: number;
    projectedClearMs: number; futureMealsCount: number; futureDosesCount: number;
    usingTargetFallback: boolean; activityOverlapWarning: boolean;
  };

  dosesInWindow: Array<{
    id: string; units: number; insulinType: string;
    administrationTime: string | null;
    isActive: boolean; isAbsorbed: boolean; isFuture: boolean;
    bgAbsorbed: number; bgPending: number;
  }>;

  mealsInWindow: Array<{
    id: string; mealType: string; timestamp: string | null;
    carbs: number; absorptionType: string;
    isActive: boolean; isAbsorbed: boolean; isFuture: boolean;
    bgAbsorbed: number; bgPending: number;
  }>;
}
```

**Note on `mob.rawPendingBGRise`:** Added alongside `rawCurrentBGReduction` / `rawPendingBGReduction` on IOB. Exposes the unmodified carb-to-BG rise for the indirect-effects breakdown in the Activity card (same role as `rawPendingBGReduction` on the IOB side).

**Note on `aob.indirectEffects`:** Changed from an optional `?` field with the old `extraIOBReduction` / `mobSuppression` / `aobExtraDrop` shape to a non-optional `AobIndirectEffects` value that is always present (zeroed when `sensitivityMultiplier ≤ 1.005`). The four sub-fields (pending / delivered × IOB / MOB) replace the three older fields and distinguish between effects not yet arrived vs already delivered.

---

## §7 API Response Field Reference

### §7.1 `GET /api/activity/pharmacodynamics`

| Field | Type | TS consumer |
|---|---|---|
| `cumulative_activity_effect` | float (signed mg/dL) | `calculateActivityEffectForCumulative` |
| `sensitivity_multiplier` | float ≥ 1.0 | `calculateSensitivityMultiplierAtTime` |
| `activity_on_board` | float (unsigned mg/dL) | AOB display |
| `activity_contributions` | list | `calculateActivityEffectForCumulative` (iterates) |
| `effective_correction_factor` | float | correction dose calculation |
| `effective_carb_to_bg_ratio` | float | carb coverage calculation |
| `window_start`, `window_end`, `calculated_at` | ISO-8601 | display |
| `cached` | bool | observability only — do not branch on this |

`activity_contributions` sub-fields required by TS: `start_time`, `duration_minutes`, `cumulative_bg_effect`.

### §7.2 `GET /api/cumulative-effects`

| Field | Type | Notes |
|---|---|---|
| `cumulative_meal_effect` | float | +ve |
| `cumulative_insulin_effect` | float | negative (Convention A) |
| `cumulative_net_baseline` | float (signed) | includes activity |
| `cumulative_activity_effect` | float (signed) | |
| `activity_on_board` | float | |
| `sensitivity_multiplier` | float ≥ 1.0 | uniform field name |
| `activity_contributions` | list | at top level |
| `meal_contributions`, `insulin_contributions` | list | display |

### §7.3 `GET /api/active-effects-full`

Activity fields present at top level: `sensitivity_multiplier`, `activity_contributions`, `cumulative_activity_effect`, `activity_on_board`.

`bg_estimates` sub-object additionally contains all of the above, plus `activity_effect_at_reading`, `baseline_source`, `confidence`.

### §7.4 `GET /api/insulin/active-effect`

See §3.3. Key fields: `totalIOB`, `contributions`, `pending_bg_reduction`, `stackingRisk`, `calculation_timezone`.

### §7.5 `GET /api/meal-on-board`

See §3.4. Key fields: `total_active_carbs`, `expected_bg_impact`. Reset-time guard applied.

---

## §8 Constants Registry

### §8.1 HR ODE Model Constants — single source

All authoritative in `constants.py::Constants.HR_MODEL`, exported to `SHARED_CONSTANTS.HR_MODEL`.

| Constant | Value | Python | TS util | TS service |
|---|---|---|---|---|
| `tau_HR` | 5.0 | ✓ via `Constants.HR_MODEL` | ✓ via `SHARED_CONSTANTS` | ✓ |
| `tau_Z` | 10.0 | ✓ | ✓ | ✓ |
| `tau_W` | 90.0 | ✓ | ✓ | ✓ |
| `a` | 0.05 | ✓ | ✓ | ✓ |
| `alpha` | 0.0008 | ✓ | ✓ | ✓ |
| `max_sensitivity_boost` | 0.60 | ✓ | ✓ | ✓ |
| `dt` | 1.0 | ✓ | ✓ | ✓ |
| `acute_rate_per_min` | 0.15 | ✓ | ✓ | ✓ |
| `hr_max_pop` | 190.0 | ✓ | ✓ | ✓ |
| `hr_base_pop` | 70.0 | ✓ | ✓ | ✓ |

### §8.2 Intensity Classification — single source

| Constant | Value | Python | TS (util + service) |
|---|---|---|---|
| `INTENSITY_HR_FRACTION.light` | 0.50 | ✓ | ✓ |
| `INTENSITY_HR_FRACTION.moderate` | 0.65 | ✓ | ✓ |
| `INTENSITY_HR_FRACTION.vigorous` | 0.80 | ✓ | ✓ |
| `LEVEL_TO_INTENSITY[-2]` | None | ✓ | ✓ (null → skip ODE) |
| `LEVEL_TO_INTENSITY[0]` | `'light'` | ✓ | ✓ |
| `INTENSITY_PEAK_BOOST.moderate` | 0.25 | ✓ | ✓ from `SHARED_CONSTANTS` |

### §8.3 Patient-Configurable Fallbacks — route consistency

| Constant | Default | Python route fallbacks | TS fallbacks |
|---|---|---|---|
| `correction_factor` | 40 | `pharmacodynamics.py`: 40; `medication_routes`: 40 | all: `?? 40` |
| `carb_to_bg_factor` | 4.0 | `meal_routes`: 4.0; `pharmacodynamics`: 4.0 | `?? 4.0` |
| `carb_to_bg_ratio` | 4.0 | `cumulative_effects` dual-key; `meal_routes` dual-key | dual-key guard |
| `protein_factor` | 0.5 | `.get('protein_factor', 0.5)` | ✓ |
| `fat_factor` | 0.2 | `.get('fat_factor', 0.2)` | ✓ |
| `weight_kg` | 70.0 | `.get("weight_kg")` → HR_MODEL `hr_base_pop` fallback | ✓ |
| `hr_base` | 70.0 | `.get("hr_base") or HR_MODEL["hr_base_pop"]` | ✓ |
| `daily_reset_hour` | 7 | all: `.get('daily_reset_hour', 7)` | ✓ |

### §8.4 Baseline Bounds — cross-file consistency

| Constant | `constants.py` | `pharmacodynamics.py` | `baseline.ts` |
|---|---|---|---|
| `BASELINE_HARD_MIN` | 55.0 | via `sanitize_baseline()` import | 55.0 from `SHARED_CONSTANTS` |
| `BASELINE_HARD_MAX` | 220.0 | via `sanitize_baseline()` import | 220.0 from `SHARED_CONSTANTS` |

---

## §9 Sign Conventions

Two coexisting conventions apply to `cumulative_insulin_effect`. Their intermediate values are not interchangeable.

| Quantity | Sign | Convention | Notes |
|---|---|---|---|
| `insulinImpact` / `cumulative_insulin_effect` (Convention A) | **Negative** | `calculate_total_cumulative_effects` | Net = meal_effect **+** insulin_effect (already negative) |
| `cumulative_insulin_effect` (Convention B) | **Positive magnitude** | `calculate_stable_baseline_from_reading` | Net = meal_effect **−** insulin_effect |
| `cumulative_meal_effect` | Positive | Both | Meals raise BG |
| `cumulative_activity_effect` | Signed | Both | **Add** directly — never subtract |
| `insulinSensitivityBoost` | Negative | — | Extra BG reduction from post-exercise ISF boost |
| `activityDeltaSinceReading` | Signed | — | `cumulativeActivityEffect − activityEffectAtReading` |
| `sensitivity_multiplier` | ≥ 1.0 | — | Scales CF upward and C2B downward during exercise window |

When passing `cumulative_insulin_effect` between these two functions, negate the value first.

---

## §10 Dead Code Inventory

| Function | File | Status |
|---|---|---|
| `getNetEffect()` | `calculations.ts` | Named-export but throws; excluded from default export |
| `NetEffectResult` interface | `calculations.ts` | Legacy shape — kept for migration guidance |
| `requiresAttention()` | `net-effect.ts` | Exported; caller in UI layer (not supplied) |
| `getTrendArrow()` | `net-effect.ts` | Exported; caller likely UI layer |
| `assessBaselineConfidence()` | `baseline.ts` | Exported from index; no call-site in supplied files |
| `sanitizeBaseline()` | `baseline.ts` | Exported from `baseline.ts` but NOT from `calculations/index.ts` — direct import required |
| `recommendInsulinType()` | `pharmacodynamics.ts` | Exported; no caller in supplied files |
| `calculateMOBBgImpact()` | `calculations.ts` | Exported pure helper; caller unknown |
| `assessMealSafety()` | `calculations.ts` | Exported; caller in UI layer |
| `fetchActivityOnBoard()` | `activity-pharmacodynamics.ts` svc | Likely used in AOB widget |
| `previewActivityEffect()` | `activity-pharmacodynamics.ts` svc | Likely used in workout preview UI |
| `PharmacodynamicProfile`, `ActivityCurvePoint`, `ActivityCurveData` | `pharmacodynamics.types.ts` | Retained pending chart-layer scan |

---

## §11 Cross-Arm References

### Arm 2 owns (this document)

- All PD calculation engines: `pharmacodynamics.py`, `activity_pharmacodynamics.py`
- All calculation API routes: `activity_pharmacodynamics_routes.py`, `cumulative_effects_routes.py`, `medication_routes.py`, `meal_routes.py`
- All TypeScript calculation utilities: `utils/calculations/` (including `resolve-live-effects.ts` — §4.4-A), `utils/glucose/`, `utils/insulin/`, `utils/activity/`
- TypeScript service layer: `services/api/calculations.ts`, `services/api/activity-pharmacodynamics.ts`, `services/insulinCalculationService.ts`, `services/api/doctor.ts`, `services/api/doctor-management.ts`
- Type file: `types/active-effects.types.ts` (§6) — canonical `ActiveEffectData` and `AobIndirectEffects`; imported by AED, MealForm, UnifiedInsulinInput, QuickMealForm
- ODE model ground truth (§1) — authoritative; not re-documented in Arm 3
- Sign convention documentation (§9)

### Arm 1 owns (Constants & Ingestion)

- `constants.py` — source of all HR ODE constants, patient defaults, absorption profiles
- `shared-constants.ts` — TS export of all 22 keys; all calculation files import from here
- `TimeManager.py` / `TimeManager.ts` — reset-time and timestamp normalisation
- `usePatientConstants.ts`, `patient.store.ts`, `patient_routes.py`

### Arm 3 owns (Visualization)

- `useActiveEffects` hook and `useBloodGlucoseEstimation` hook
- Chart components: `EffectsVisualizationChart.tsx`, `BloodGlucoseVisualization.tsx`, `ActiveEffectsDisplay.tsx`, `BloodGlucoseChart.tsx`
- `ActiveEffectsDisplay.onEffectsComputed` callback — emits `ActiveEffectData` to the parent screen; the parent passes it as `liveActiveEffects` to MealForm / UnifiedInsulinInput / QuickMealForm
- `calculateActivityEffectAtTime` — local instantaneous-rate model using Z-state decay (distinct from `calculateActivityEffectForCumulative` exported by this arm)
- `calculateSensitivityMultiplierAtTime` — local sensitivity model using W-state approximation
- `applyInsulinCumulativeFloor` is **called by** Arm 3 chart components (EVC, BGV) after building their chart point arrays, but the implementation lives in `@/utils/calculations/cumulative-effects` (Arm 2). Arm 3 must not re-implement it locally. See §4.1-A.

---

## §12 Developer Rules

These are permanent invariants.

**ODE constants**

1. `HR_MODEL`, `INTENSITY_HR_FRACTION`, and `LEVEL_TO_INTENSITY` must be imported from `constants.py` (Python) or `SHARED_CONSTANTS` (TypeScript). Local copies are never permitted.

2. `tau_W = 90 min` governs only the sensitivity multiplier (W-state path). It plays zero role in the acute BG-lowering signal. Never use `tau_W` in `_integrate_z_drop` or any Z-state accumulation.

3. The sensitivity multiplier formula is `1 + α·W·(1+Z)` with a hard cap at `max_sensitivity_boost = 0.60`. This exact formula must be used in Python (`activity_pharmacodynamics.py`), the TypeScript ODE utility (`activity-pharmacodynamics.ts`), and `insulinCalculationService.ts`.

4. `INTENSITY_PEAK_BOOST` and `MAX_BOOST` must be read from `SHARED_CONSTANTS` in all EVC and BGV consumers. Never redeclare locally.

**Correction factor**

5. `correction_factor` defaults must use `40` everywhere — Python `.get('correction_factor', 40)` and TypeScript `?? 40`. The value `50` is incorrect.

6. Phase 3 of `calculateTotalCumulativeEffects` (and its Python equivalent) must always use `base_correction_factor` (the patient's raw constant). The exercise-overridden `effectiveCorrectionFactor` applies only to Phases 1 and 2.

**Carb ratio dual-key guard**

7. All code reading `carb_to_bg_ratio` or `carb_to_bg_factor` must apply the dual-key guard: check `carb_to_bg_ratio` first, then fall back to `carb_to_bg_factor`, then default to `4.0`. This applies to both Python routes and TypeScript utilities. A single-key lookup is a bug.

8. `apply_activity_sensitivity` must update both `carb_to_bg_ratio` and `carb_to_bg_factor` when either is present. Never update only one key.

**Field naming**

9. The sensitivity multiplier field name is `sensitivity_multiplier` uniformly across all three API endpoints (`/api/activity/pharmacodynamics`, `/api/cumulative-effects`, `/api/active-effects-full`) and across all TS response interfaces. Any variation of this name (`activity_sensitivity_mult`, `activity_sensitivity_multiplier`) is incorrect.

10. `activity_contributions` must be present at the top level of both `/api/cumulative-effects` and `/api/active-effects-full` responses. It must not be present only inside `bg_estimates`.

**Reset-time arithmetic**

11. All reset-time computation must delegate to `get_daily_reset_time()` from `utils/pharmacodynamics.py`. No route or module may re-implement this arithmetic locally.

12. `_get_reset_time()` in `activity_pharmacodynamics.py` delegates to `get_daily_reset_time()`. This chain must not be broken.

13. `is_within_current_day` uses strict `>` (not `>=`) to exclude events exactly at the reset time. This provides a clean reset — events at 7:00:00.000 exactly are excluded from the new day.

**Sign conventions**

14. `cumulative_activity_effect` is a signed value and must always be **added** to the cumulative net baseline — never subtracted. (Aerobic exercise produces a negative value that reduces the net baseline; subtracting it would invert the direction.)

15. Never pass `cumulative_insulin_effect` from `calculate_total_cumulative_effects` (Convention A — negative) directly into `calculate_stable_baseline_from_reading` (Convention B — expects positive magnitude) or vice versa without negating first.

**`calculateTotalCumulativeEffects` caller contract**

16. Do not pass the `activities` argument to `calculateTotalCumulativeEffects` when the caller adds the activity term manually afterward. Doing so causes double-counting the activity contribution.

17. `calculateActivityEffectForCumulative` must never be re-introduced as a local copy in any visualization component. All four consumers import from `utils/calculations/cumulative-effects.ts`.

**`getNetEffect` / net-effect.ts**

18. `getNetEffect()` has been removed from `calculations.ts` and throws immediately. It must not be reintroduced. Any new consumer needing the net effect must use the `calculateNetEffect` wrapper in `net-effect.ts`.

19. The 7th-argument path in `net-effect.ts` is dead code. Any developer adding a new consumer must read the `⚠️ DOUBLE-COUNT WARNING` JSDoc before using the 7th argument.

**`fetchStackedActivityEffectSafe`**

20. A `null` return from `fetchStackedActivityEffectSafe` must be treated as zero effect (no activity). It must never break or early-return the BG estimation pipeline.

**Activity cache**

21. `invalidate_pd_cache(user_id)` must be called from `watch_hr_routes.end_watch_activity()` after a session is finalised. The `cached` field in responses is for observability only — no application logic may branch on its value.

**IOB / `target_time` param**

22. `getActiveInsulin` in `calculations.ts` passes `target_time` (snake_case) as the query parameter — not `time`. All callers must pass an ISO string to this parameter, not a bare timestamp integer.

**Default insulin fallback**

23. The default fallback medication for unknown or missing insulin types is `'insulin_aspart'` (rapid-acting: `onset=0.375h`, `peak=2.25h`, `duration=4.5h`, `gamma_steep`). Any other fallback (e.g., `'regular_insulin'`) is incorrect.

**`sanitizeBaseline` export**

24. `sanitizeBaseline()` is exported from `utils/calculations/baseline.ts` but is not re-exported from `calculations/index.ts`. Import it directly from the file path.

**`w_state_tau_minutes` field**

25. The `w_state_tau_minutes` field on `ActivityPDResult` is typed as `never` — it is not serialised by the backend ODE. Any consumer expecting this field is in error.

**`insulinCalculationService.ts` — ODE parity**

26. `insulinCalculationService.ts` must use the sensitivity multiplier formula `1 + α·W·(1+Z)` (cross-reference Rule 3 and §1.3) for both `computeSyntheticSensitivityMultiplier` and any future path that derives a sensitivity multiplier on-device. The older formula `alpha * W` (without the `(1+Z)` amplifier) underestimates sensitivity by up to 50% during active exercise and must not be reintroduced. The inline `TODO (resolved)` comment in the source is the historical record of this fix — do not remove it.

27. `computeSyntheticSensitivityMultiplier` must source all ODE constants (`tau_HR`, `tau_Z`, `tau_W`, `alpha`, `max_sensitivity_boost`, `a`, `dt`, `hr_max_pop`, `hr_base_pop`) from `SHARED_CONSTANTS.HR_MODEL` (cross-reference Arm 1 §1.2 and Rule 1). No numeric literal substitutes are permitted inside either ODE function. `hr_base` and `hr_max` may be read from patient constants as an override but must fall back to `HR_MODEL.hr_base_pop` and `HR_MODEL.hr_max_pop` if absent.

28. `computeSyntheticAOB` implements the Z-state (acute drop) path only. It must never incorporate W-state logic or the sensitivity multiplier path. The two ODE paths (`computeSyntheticSensitivityMultiplier` for W, `computeSyntheticAOB` for Z) must remain separate functions. Merging them or sharing state across the W and Z return paths is a correctness violation.

**Doctor API — authorization boundary**

29. All functions in `services/api/doctor.ts` (§5.4) must use the doctor-namespaced route prefix `/api/doctor/…` for endpoints that require `check_doctor_patient_access()`. No function in that file may call a patient-scoped route (e.g. `/api/patient/:id/…`) for clinical data retrieval — doing so will return 404 for doctor tokens. The one currently identified boundary case is `getPatientInsulinDoses`, which explicitly documents this constraint; the same rule applies to any future data-retrieval function added to the file.

30. Doctor-facing API functions must never embed patient pharmacodynamic data (PD constants, sensitivity multipliers, cumulative activity effects, or any field derived from `PatientConstantsData`) in requests routed to a non-authorized doctor. The backend enforces `check_doctor_patient_access()` as the primary guard; the frontend must not attempt to work around this by pre-fetching PD data from one patient session and passing it through a request for a different patient. Each call to `getPatientConstants`, `updatePatientConstants`, or any data-write function must carry only the `patientId` and the intended update payload — no cross-patient data.

**`doctor-management.ts` — session routing**

31. The 403-silent-return behavior in `getAllDoctors` and `getAuthorizedDoctors` (§5.5) is intentional defensive code, not permission to leave the settings/doctors screen visible during doctor sessions. The `console.warn` log is the enforcement signal. Any new settings screen that calls either function must be gated on the user role before mounting, so that the 403 path is unreachable in production. The silent return exists only as a safety net for unexpected pre-renders, not as a supported code path.

**`applyInsulinCumulativeFloor`**

**Rule 31. `applyInsulinCumulativeFloor` is mandatory for any chart component that sweeps `calculateTotalCumulativeEffects` across a time axis.** Call it on the completed points array before passing it to React state. Omitting it causes the green cumulative line (and any downstream cumulative series) to exhibit a mountain shape — deepening, peaking, then rising back up — during the post-exercise sensitivity window.

**Rule 32. `applyInsulinCumulativeFloor` must NOT be called from `useActiveEffects`, `useBloodGlucoseEstimation`, `ActiveEffectsDisplay.fetchAndCalculate`, or any other point-in-time evaluator.** Those functions compute a single "now" value; calling the floor utility on a single-element array is a no-op at best and misleading at worst. The floor is only meaningful when comparing a time-ordered sequence of values.

**`resolveLiveEffects` — form consumers**

**Rule 33. `resolveLiveEffects` is the single merge point for live AED data and stale API snapshots in all form components.** `MealForm`, `UnifiedInsulinInput`, and `QuickMealForm` must call `resolveLiveEffects(liveActiveEffects, apiSnapshot, activityPD, carbToBgFactor)` and read scalars from the returned `ResolvedActiveEffects` object. Duplicating the priority logic inline is a violation.

**Rule 34. A form component must never apply `cumulativeActivityEffect` a second time when `r.bgAlreadyHasActivity` is `true`.** In Path A (live AED), `estimatedBG` already includes `activityDeltaSinceReading`. Adding `cumulativeActivityEffect` on top would double-count the exercise contribution. The flag `bgSourceAlreadyHasActivity` in `performLocalCalculation` / form `useMemo` must be set from `r.bgAlreadyHasActivity`, not hardcoded.

**`types/active-effects.types.ts`**

**Rule 35. `ActiveEffectData` and `AobIndirectEffects` must be imported from `@/types/active-effects.types`, not redeclared locally.** `ActiveEffectsDisplay.tsx` imports from the same file — a local redeclaration risks silent drift between the AED emitter and the form consumer, breaking the type contract without a compile error if the shapes diverge.
