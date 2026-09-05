# DiaTwin — Arm 3: Visualization Layer Reference

**Components:** `EffectsVisualizationChart.tsx` · `ActiveEffectsDisplay.tsx` ·
`BloodGlucoseVisualization.tsx` · `BloodGlucoseChart.tsx`  
**Hooks:** `useActiveEffects.ts` · `useBloodGlucoseEstimation.ts`  
**Platform:** React Native (Expo) — Mobile  
**Last reviewed against source:** May 2026

---

## §0 Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Visualization Arm                                 │
│                                                                              │
│  EffectsVisualizationChart (EVC)      ActiveEffectsDisplay (AED)             │
│  ─────────────────────────────────    ────────────────────────────           │
│  PK rate-of-change areas              Live numeric summary                   │
│  + cumulative green line              single-point-in-time                   │
│  victory-native (SVG)                 ScrollView / cards                     │
│                                                                              │
│  BloodGlucoseVisualization (BGV)      BloodGlucoseChart (BGC)                │
│  ─────────────────────────────────    ────────────────────────               │
│  BG readings + projected BG line      Pure glucose signal only               │
│  + cumulative area fill               colour-coded band segments             │
│  (encompasses EVC + BGC intent)       no PK model                           │
│                                                                              │
│  DATA SOURCE                          DATA SOURCE                            │
│  EVC: useActiveEffects() hook         AED: direct apiClient calls            │
│       (shared fetch + cache)               (reset-anchored window + 6 h buf) │
│                                            emits ActiveEffectData via        │
│                                            onEffectsComputed →               │
│                                            liveActiveEffects → MealForm /    │
│                                            UnifiedInsulinInput / QuickMealForm│
│  BGV: useActiveEffects() hook         BGC: useGlucoseBuffer()                │
│       + useGlucoseBuffer()                 (shared hook, no PK model)        │
│       (both from useBloodGlucoseEstimation)                                  │
│                                                                              │
│  ACTIVITY DATA                        ACTIVITY DATA                          │
│  EVC: activityPD prop (preferred)     AED: activityPDResult prop             │
│       OR hookActivityPD fallback           OR self-fetch fallback            │
│       + syntheticContributions        BGV: activityPD prop                   │
│       (multi-day historical)               OR hookActivityPD fallback        │
│                                       BGC: none (no PK model)               │
└──────────────────────────────────────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────────────────────┐
│                              Shared hooks                                    │
│  useActiveEffects()        Full PK data pipeline (EVC / AED / BGV)          │
│  useBloodGlucoseEstimation() Lightweight decay model — home-screen           │
│                              indicators, not charts                          │
└─────────────┬───────────────────────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────────────────────┐
│                           Shared utilities                                   │
│  calculateTotalCumulativeEffects (v4.14)                                      │
│  calculateActivityEffectForCumulative  (single shared copy — see §7)        │
│  calculateStackedMealEffect                                                  │
│  calculateStackedInsulinEffect / calculateStackedInsulinChartEffect          │
│  calculateStableBaselineFromReading                                          │
│  calculateNetEffect (net-effect.ts wrapper)                                  │
│  MEAL_ABSORPTION_PROFILES · SHARED_CONSTANTS                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component roles

| Component | Role | Chart library | Data scope |
|---|---|---|---|
| **EVC** | Time-resolved PK breakdown: how meals, insulin, and exercise contribute instantaneously and cumulatively to BG change | victory-native | Multi-day time axis |
| **AED** | Snapshot at "now": numeric IOB / MOB / AOB summary and projected BG | ScrollView | Single point + one projection |
| **BGV** | Comprehensive BG view: actual readings plotted against projected BG, with cumulative effect area fill as context | victory-native | Full selected range |
| **BGC** | Pure glucose signal: raw readings colour-coded by glycaemic zone, with smoothstep interpolation for SMBG and time-in-range statistics. No projection, no PK model | victory-native | Full selected range |

The shared BG model is:

```
estimatedBG = stableBaseline + ΔMeal + ΔInsulin + ΔActivity_since_reading
```

EVC resolves this across the full time axis, producing rate-of-change series and a cumulative "green line". BGV resolves it per-point to produce a projected BG trajectory anchored to `baseBG`, overlaying actual readings for comparison. AED resolves it at a single moment in time. BGC bypasses the model entirely.

---

## §1 Shared Data Model

### 1.1 Concepts

| Concept | Description |
|---|---|
| **Stable Baseline** | The patient's effective fasting BG, derived by "unwinding" all active PK effects from the most recent reading (dynamic mode) or read from the circadian profile (preset mode). |
| **Cumulative Net Baseline** | The running bank balance from the daily reset hour: `ΔMeal + ΔInsulin + ΔActivity`. What the green line (EVC) and orange area fill (BGV) show; what the "estimated now" card (AED) adds to the baseline. |
| **Rate series** | Instantaneous BG rate of change at a given moment from active absorption. EVC renders these as areas; BGV uses them for `netEffect` only; AED shows their totals (MOB / IOB). |
| **IOB** | Insulin on board — units of insulin not yet absorbed. Converted to mg/dL via `correctionFactor`. |
| **MOB** | Meal on board — carb-equivalent grams not yet absorbed. Converted to mg/dL via `carb_to_bg_factor`. |
| **AOB** | Activity on board — unsigned future BG drop remaining from exercise. Separate from `cumulativeActivityEffect` which is the already-delivered signed change. |
| **Daily reset** | Configurable hour (default 07:00 local) at which the cumulative bank balance resets to 0. All PK windows respect this boundary. |
| **Phase 3 / persist-at-100%** | Once an absorption window ends, the event's full effect is locked into the cumulative baseline permanently until the daily reset. Implemented in `calculateTotalCumulativeEffects` v4.4+. |
| **Lock-in model** | The cumulative activity contribution rises linearly during a session then locks in permanently at `fullEffect` after session end. Used exclusively for the "bank balance" (cumulative) series. Not the same as the instantaneous W-state model. |

### 1.2 Key data types

```typescript
// From @/services/api/activity-pharmacodynamics
interface ActivityPDResult {
  cumulative_activity_effect:  number;   // signed mg/dL; negative = BG-lowering
  sensitivity_multiplier:      number;   // ≥ 1.0 post-exercise GLUT4 boost
  activity_on_board:           number;   // unsigned future drop (AOB)
  activity_contributions:      ActivityContribution[];
  active_sessions:             number;
  effective_correction_factor: number;   // pre-multiplied by backend
  effective_carb_to_bg_ratio:  number;   // pre-divided by backend
  w_state_tau_minutes?:        number;   // patient-specific τ_W; fallback to SHARED_CONSTANTS.HR_MODEL.tau_W
}

interface ActivityContribution {
  activity_id:          string;
  start_time:           string;          // ISO-8601 UTC
  intensity:            'light' | 'moderate' | 'vigorous';
  duration_minutes:     number;
  bg_direction:         -1 | 1;
  cumulative_bg_effect: number;          // signed mg/dL for this session
  remaining_bg_drop:    number;          // unsigned AOB for this session
  absorbed_fraction:    number;          // 0.0–1.0
  is_active:            boolean;
  model:                'hr_ode' | 'synthetic_hr';
}
```

### 1.3 Sign conventions

| Quantity | Sign | Notes |
|---|---|---|
| `insulinImpact` / `cumulativeInsulinEffect` | Negative | Insulin lowers BG |
| `mealImpact` / `cumulativeMealEffect` | Positive | Meals raise BG |
| `cumulative_activity_effect` | Negative (aerobic) or Positive (anaerobic) | Already signed — **add**, never subtract |
| `insulinSensitivityBoost` | Negative | Extra BG reduction from post-exercise ISF boost; extension below the purple insulin area in EVC |
| `activityDeltaSinceReading` | Signed | `cumulativeActivityEffect − activityEffectAtReading`; only the portion of exercise not yet baked into the reading |

---

## §2 useActiveEffects

**File:** `hooks/useActiveEffects.ts`  
**Purpose:** Central PK data pipeline consumed by EVC, BGV, and AED (as fallback). Fetches all raw data, runs the full calculation pipeline, and exposes both display-ready values and raw arrays for chart components.

### 2.1 Options interface

```typescript
export interface UseActiveEffectsOptions {
  autoRefresh?:     boolean;        // default: true
  refreshInterval?: number;         // ms, default: 60 000
  includeProjections?: boolean;     // default: true
  patientId?:       string;
  debug?:           boolean;        // default: false; pass true only when debugging
  useFallback?:     boolean;        // backend fallback when frontend calcs return zeros; default: true
  windowHours?:     number;         // fetch window depth; default: 24
                                    // pass chart's pastHours so multi-day views get enough data
  skipIobCutoff?:   boolean;        // default: false
                                    // true for chart components (they re-filter per point)
                                    // false for live display (AED)
}
```

### 2.2 Return interface

```typescript
export interface UseActiveEffectsResult {
  // ── Display values ──────────────────────────────────────────────────────────
  stableBaseline:       number | null;
  estimatedBG:          number | null;
  projectedFinalBG:     number | null;

  // ── Active PK effects ────────────────────────────────────────────────────────
  totalIOB:             number;
  totalMOB:             number;
  activeInsulinEffect:  number;   // mg/dL/hr
  activeMealEffect:     number;   // mg/dL/hr
  currentNetEffect:     number;   // mg/dL/hr

  // ── Cumulative bank balance ──────────────────────────────────────────────────
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline:   number;

  // ── Activity PD ─────────────────────────────────────────────────────────────
  activityEffect:         number;               // signed cumulative BG effect (mg/dL); negative = lowering
  sensitivityMultiplier:  number;               // ≥ 1.0; 1.0 = no post-exercise boost
  activityOnBoard:        number;               // unsigned remaining acute drop (mg/dL)
  activityContributions:  ActivityContribution[];
  activityPDResult:       ActivityPDResult | null;   // raw stacked PD response
  activityHistory:        ActivityHistoryResponse[]; // populated for all view sizes (source-deduped)

  // ── Safety & trends ─────────────────────────────────────────────────────────
  safetyStatus:  SafetyStatusLevel | null;
  trend:         GlucoseTrend | null;

  // ── Detailed breakdowns ─────────────────────────────────────────────────────
  baselineDetails:    BaselineResult | null;
  netEffectDetails:   NetEffectResult | null;

  // ── Backend fallback ────────────────────────────────────────────────────────
  backendData:    any | null;
  usingBackend:   boolean;

  // ── Raw arrays for chart components ─────────────────────────────────────────
  meals:        Meal[];          // pass directly to processContextMealsForChart
  insulinDoses: InsulinDose[];   // pass directly to processContextInsulinForChart

  // ── Meta ─────────────────────────────────────────────────────────────────────
  isLoading:          boolean;
  error:              string | null;
  lastUpdate:         Date | null;
  calculationErrors:  string[];
  baselineMode:       'dynamic' | 'preset';
  baselineWarnings:   string[];
  baselineSanitizeStatus: 'ok' | 'hard_clamped' | null;

  // ── Actions ──────────────────────────────────────────────────────────────────
  refresh:          () => Promise<void>;
  setMeals:         (meals: Meal[]) => void;
  setInsulinDoses:  (doses: InsulinDose[]) => void;
  setLatestReading: (reading: GlucoseReading | null) => void;
}
```

### 2.3 Data fetch pipeline

`fetchData()` fires five concurrent requests:

| Request | Endpoint | Params | Notes |
|---------|----------|--------|-------|
| Meals | `API.MEALS.MEALS_ONLY` | `start`, `end` (ISO) | window = `windowHours + 8` h |
| Insulin | `API.INSULIN.DATA` | `days` (integer) | `days = ceil((windowHours + 8) / 24) + 1`; endpoint only accepts `days`, never `start`/`end` |
| Blood sugar | `API.BLOOD_SUGAR.LIST` | `start_time`, `end_time`, `filter_by=reading_time` | Fixed last-24h window; non-fatal |
| Activity PD | `API.ACTIVITY_PD.STACKED` | — | 30-second client-side debounce; reset to 0 on `refresh()` |
| Activity history | `API.ACTIVITIES.HISTORY` | `start_time`, `end_time`, `limit` | 60-second TTL cache; limit=50 for ≤24h views, 500 for multi-day; **fetched for ALL view sizes** (windowHours > 24 guard removed); source-deduped by (startMs rounded to minute, durationMinutes); non-fatal; used by EVC for `syntheticContributions` |

All five are written to state **atomically** in a single `setFetchedData` call, preventing partial-data calculation cycles (e.g. doses populated but meals still empty).

#### Dose normalisation
Raw API doses are normalised before use:
- `administrationTime` ← `d.administrationTime ?? d.taken_at ?? d.takenAt`
- `insulinType` ← `d.insulinType ?? d.insulin_type ?? d.medication ?? 'regular_insulin'`
- `units` ← `d.units ?? d.dose ?? 0`

#### IOB cutoff filter
When `skipIobCutoff = false` (live display, default), doses are kept only if within the 48-hour IOB lookback window **or** within today's reset window. When `skipIobCutoff = true` (chart components), all doses pass through; the chart re-filters per point using `cumulativeWindowStart`.

### 2.4 Calculation pipeline — `calculateEffects()`

Throttled to once per minute. Bypasses throttle when `baseline_mode` changes (immediate re-run).

**Step 1 — Stable Baseline**

| Mode | Method |
|------|--------|
| `dynamic` | `calculateStableBaselineFromReading(reading, meals, doses, now, constants, MEAL_ABSORPTION_PROFILES, resetHour, tzOffset)` → clamped by `sanitizeBaseline` (hard bounds: 55–220 mg/dL) |
| `preset` | `getCircadianBaseline(localHour, circadianProfile)` → preset `BaselineResult` with zeroed cumulative fields |

**Step 2 — Net effect**

```typescript
netEffect = calculateNetEffect(
  baseline,
  meals,
  insulinDoses,
  currentTime,
  constants,
  MEAL_ABSORPTION_PROFILES,
  // activityPD intentionally NOT passed — applied below as a delta
);
```

`activityPD` is not the 7th argument here. It is applied manually afterward as `activityDeltaSinceReading`. See §7.2 for the full rationale.

**Step 3 — Activity delta (dynamic mode)**

```typescript
// Activity effect already baked into the reading at reading time:
const activityEffectAtReading = calculateActivityEffectForCumulative(
  latestReading.timestamp as number,
  activityPD.activity_contributions ?? [],
  lastResetMs,
);

// Only the portion that changed since (or after) the reading:
const activityDeltaSinceReading = cumulativeActivityEffect - activityEffectAtReading;

// Applied to estimatedBG:
const activityAdjustedBG = netEffect.estimatedBG + activityDeltaSinceReading;
```

**Step 4 — Sensitivity-adjusted projection (dynamic mode)**

```typescript
const effectiveCorrFactor = (sensitivityMultiplier > 1.0 && activityPD?.effective_correction_factor)
  ? activityPD.effective_correction_factor : baseCorrFactor;
const effectiveCarbFactor = (sensitivityMultiplier > 1.0 && activityPD?.effective_carb_to_bg_ratio)
  ? activityPD.effective_carb_to_bg_ratio  : baseCarbFactor;

const pendingNetEffect   = totalMOB × effectiveCarbFactor − totalIOB × effectiveCorrFactor;
const correctedProjected = activityAdjustedBG + pendingNetEffect;
```

**Step 5 — Preset mode: PK cumulative + reading residual**

Preset mode rebuilds `estimatedBG` from scratch using `calculateTotalCumulativeEffects` (NOT from `blood-glucose-estimation.ts` — that version lacks Phase 3):

```
correctedEstimatedBG = circadian@now
                     + calculateTotalCumulativeEffects(...).cumulativeNetBaseline
                     + cumulativeActivityEffect      ← full amount (no delta, no reading baked in)
                     + readingResidual

readingResidual = reading.value
                − circadianAtReading
                − cumulAtReading.cumulativeNetBaseline
                − activityAtReadingTime              ← prevents double-counting activity in reading
```

The residual anchors the pure-model estimate to the last measurement. `activityAtReadingTime` is subtracted to prevent double-counting the activity effect already reflected in the reading value.

### 2.5 Auto-refresh behaviour

- Aligns to the next `:00` minute boundary on mount, then fires every `refreshInterval` ms.
- `windowHours` changes trigger an immediate re-fetch (tracked via `prevWindowHoursRef`).
- `refresh()` resets: calculation throttle clock, activity PD debounce, activity history TTL cache.
- `calculateEffects()` is triggered reactively via a `useEffect` watching `fetchedData` — never called directly from `fetchData()`.

### 2.6 Key implementation detail

`useActiveEffects` imports `calculateTotalCumulativeEffects` from `@/utils/calculations`, not from `@/utils/glucose/blood-glucose-estimation`. The version in `blood-glucose-estimation` lacks the Phase 3 persist-at-100% fix. Using it in preset mode would return 0 for any fully-absorbed meal, causing `estimatedBG` to ignore meals that had finished absorbing.

---

## §3 useBloodGlucoseEstimation

**File:** `hooks/useBloodGlucoseEstimation.ts`  
**Purpose:** Lightweight hook for home-screen BG indicators and estimation widgets. Owns its own glucose buffer (inlined), activity PD fetch, and baseline estimation. Not used by any of the four visualization components — charts use `useGlucoseBuffer` directly.

### 3.1 Types

```typescript
export interface GlucoseReading {
  timestamp:  number;   // ms since epoch
  bloodSugar: number;
  source?:    string;
}

export interface EstimatedBG {
  value:      number;
  timestamp:  number;
  source:     'actual' | 'last_actual' | 'estimated' | 'target' | 'loading';
  isActual:   boolean;
  confidence: 'high' | 'medium' | 'low' | 'initializing';
  dataPoint?: BloodSugarResponse;
}

export interface UseBloodGlucoseEstimationOptions {
  targetGlucose?:      number;           // default: 100
  refreshInterval?:    number;           // ms, default: 120 000 (2 min)
  stabilizationHours?: number;           // decay horizon, default: 3 h
  enabled?:            boolean;          // false = inert (doctor sessions); default: true
  patientConstants?:   PatientConstants; // drives baseline_mode and circadian_profile
}
```

### 3.2 Return shape

```typescript
{
  estimatedBG:                 EstimatedBG;
  recentReadings:              BloodSugarResponse[];
  combinedData:                ProcessedReading[];    // actual + interpolated
  isLoading:                   boolean;               // bufferLoading || activityFetching
  error:                       string | null;         // bufferError ?? activityError
  refresh:                     () => Promise<void>;
  modelBloodGlucose:           (reading, elapsedMinutes) => number;
  stabilizationHours:          number;
  activityPD:                  ActivityPDResult | null;
  cumulativeActivityEffect:    number;                // mg/dL; 0 when null
  activitySensitivityMultiplier: number;              // ≥ 1.0
  activityOnBoard:             number;                // mg/dL
}
```

### 3.3 Inlined glucose buffer

The glucose buffer is inlined directly inside this hook. It is not a separate file. Fetch formula:

```
startTime = Math.min(rangeStart − 30 min, now − 26 h)
```

Fires immediately on mount, snaps to the next `:00` minute boundary, repeats at `refreshInterval`. `bufferReadings` slices the in-memory buffer to `[rangeStart, now]` synchronously — zero network cost on live minute ticks.

Timestamp resolution order: `bloodSugarTimestamp → timestamp → readingTime → reading_time → taken_at`.

### 3.4 Baseline estimation

**Preset mode** (`baselineModeRef.current === 'preset'`):  
Returns `getCircadianBaseline(localHour, circadianProfile)` directly. Confidence = `'medium'`.

The mode is read from `baselineModeRef.current` (a ref updated on every render), not from the closed-over const, so mode changes are picked up without recreating the callback.

**Dynamic mode — `calculateBaselineFromData(combinedData)`:**  
Finds the most recent actual reading and returns the current position along an exponential decay curve toward `targetGlucose`.

**Decay model (`modelBloodGlucose`):**
```
ratio = elapsedMinutes / (stabilizationHours × 60)
BG(t) = target + (initial − target) × (1 − (1 − e^(−3 × ratio)))
```
Returns `target` once `elapsedMinutes ≥ stabilizationHours × 60`.

### 3.5 Activity PD fetch

`fetchActivityPD()` calls `fetchStackedActivityEffectSafe(new Date())` with a **30-second debounce** (`ACTIVITY_FETCH_MIN_INTERVAL_MS = 30 000`). A null result is treated as zero effect — never breaks the BG pipeline. `refresh()` resets the debounce to 0 so a manual pull always triggers a fresh fetch.

### 3.6 `useGlucoseBuffer` — exported standalone hook

Also exported from this file for use by BGV and BGC.

```typescript
export function useGlucoseBuffer(
  rangeStart:        number,          // visible window start (ms)
  rangeEnd:          number,          // visible window end (ms) — filter only, no new fetch
  pastHours:         number = 24,     // minimum lookback for fetch formula
  refreshIntervalMs: number = 60_000,
  logPrefix:         string = 'GlucoseBuffer',
): {
  readings:  GlucoseReading[];        // client-filtered to [rangeStart, rangeEnd]
  isLoading: boolean;
  error:     string | null;
  refresh:   () => void;
}
```

Fetch formula:
```
startTime = Math.min(rangeStart − 30 min, now − max(24, pastHours + 2) h)
```

Fires immediately + snaps to `:00` boundary + re-fires every `refreshIntervalMs`. `rangeEnd` changes never trigger a new fetch (no future readings). `readings` is a synchronous `useMemo` slice — zero network cost on minute-tick re-renders. `isCGM` detection (BGC): majority vote on `r.source ∈ {'cgm', 'libre_cgm', 'libre'}`, requiring the `source` field to be present on API readings.

---

## §4 EffectsVisualizationChart

**File:** `components/charts/EffectsVisualizationChart.tsx`  
**Ported from:** `frontend/src/components/EffectsVisualization.js` (v5.0)  
**Chart library:** victory-native

### 4.1 Props

```typescript
export interface EffectsVisualizationChartProps {
  height?:       number;                       // default: 280
  showControls?: boolean;                      // default: true
  embedded?:     boolean;                      // default: false
  defaultView?:  string;                       // default: '12h'
  onDataUpdate?: (data: EffectsChartPoint[]) => void;
  activityPD?:   ActivityPDResult | null;
  // Pass from any parent that already owns useActiveEffects(). When absent,
  // the chart self-fetches via its own internal useActiveEffects call.
}
```

### 4.2 Data source

```
useActiveEffects(activeEffectsOptions)
  ├── meals:            rawMeals   (window = max(displayPastHours, getCumulativeLookbackHours))
  ├── insulinDoses:     rawDoses
  ├── stableBaseline:   number | null
  ├── baselineMode:     'dynamic' | 'preset'
  ├── activityPDResult: ActivityPDResult | null  ← hookActivityPD fallback
  ├── estimatedBG:      number | null            ← hookEstimatedBG (preset + residual)
  └── activityHistory:  ActivityHistoryResponse[] ← for syntheticContributions

effectiveActivityPD = activityPD_prop ?? hookActivityPD ?? null
```

`activeEffectsOptions` is computed via `useMemo` (not an inline literal) keyed on view mode, so the fetch depth matches the visible chart range and a new options reference is never created on every render.

`skipIobCutoff: true` — EVC re-filters doses per chart point.

### 4.3 View modes

| Key | Label | pastHours | futureHours | tickInterval | interpolationInterval |
|---|---|---|---|---|---|
| `3h` | 3H | 2 | 1 | 0.5 h | 5 min |
| `6h` | 6H | 4 | 2 | 1 h | 5 min |
| `12h` | 12H | 10 | **6** ⭐ | 2 h | 10 min |
| `24h` | 24H | 20 | 4 | 3 h | 15 min |
| `3d` | 3D | 68 | 4 | 6 h | 30 min |
| `week` | Week | (SHARED_CONSTANTS) | (SHARED_CONSTANTS) | — | — |
| `custom` | 📅 Range | user-defined | user-defined | auto | auto |

⭐ The 12h view intentionally overrides `futureHours` to 6 (the VIEW_CONFIGS default is 2) to show the full projected PK curve.

### 4.4 Chart point type

```typescript
interface EffectsChartPoint {
  timestamp:            number;
  formattedTime:        string;

  // Rate-of-change series
  mealImpact:           number;    // base meal BG rate (mg/dL); ≥ 0
  insulinImpact:        number;    // boosted insulin BG impact; always ≤ 0
  netEffect:            number;    // activityAdjustedMealImpact + insulinImpact + activityEffectAtPoint

  // Cumulative bank balance
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline:   number; // meals + insulin + calculateActivityEffectForCumulative

  // Dose markers
  mealDoseMarker:       number | null;    // total carbs at this point, or null
  insulinDoseMarker:    number | null;    // −(totalInsulin × 5), or null

  mealsAdministered:    any[];
  insulinAdministered:  any[];

  isHistorical: boolean; isFuture: boolean; isNow: boolean;

  // Activity fields
  activityEffect:             number;   // teal line — calculateActivityEffectAtTime result (Z-state decay)
  insulinImpactBase:          number;   // unscaled (base CF); always ≤ 0; snaps to 0 when dose expires
  insulinSensitivityBoost:    number;   // extra reduction from ISF boost; always ≤ 0
  /**
   * Phase-3-persist version of insulinImpactBase.
   * Use for the DISPLAY area (purple VictoryArea): expired doses stay at -(dose×CF) instead
   * of snapping to 0, eliminating the "peak" artefact at dose-expiry time.
   * Do NOT use for netEffect (the rate line) — snapping to 0 IS correct there.
   */
  insulinImpactBaseDisplay:   number;
  activityAdjustedMealImpact: number;   // mealImpact recalculated with effectiveC2B
  sensitivityMultiplier:      number;   // W-state multiplier at this chart time point
  /**
   * Lock-in cumulative activity BG effect (same model as the activity component
   * of cumulativeNetBaseline). Used for the blue activity VictoryArea so its depth
   * tracks the green line's activity component. Distinct from activityEffect (Z-state
   * exponential decay) which drives only the netEffect/rate line.
   */
  activityCumulativeEffect:   number;
}
```

### 4.5 Chart series

| Toggle | Colour | Type | Field |
|---|---|---|---|
| Meal Effect | `#FF9800` orange | VictoryArea | `mealImpact` |
| Insulin Effect (base) | `#9C27B0` purple | VictoryArea | `insulinImpactBaseDisplay` (Phase-3-persist; holds depth after dose expires) |
| Insulin Sensitivity Boost | `#29B6F6` light blue | VictoryArea (stacked below purple) | `insulinImpactBaseDisplay × sensitivityMultiplier` with running `yFloor` ratchet |
| Meal Sensitivity Reduction | `#29B6F6` light blue | VictoryArea (overlay) | `mealImpact − activityAdjustedMealImpact` |
| Net Effect | `#2196F3` blue dashed | VictoryLine | `netEffect` |
| Cumulative Shift | `#4CAF50` green | VictoryLine | `cumulativeNetBaseline` |
| Activity Effect | `#1565C0` dark blue | VictoryArea + VictoryLine | `activityEffect` |
| Session duration band | `#B2EBF2` / `#29B6F6` | VictoryArea | per-session |
| Post-exercise sensitivity strip | `#29B6F6` | VictoryArea (bottom 7%) | per-session |
| Session end tick / start markers | `#0288D1` / `#1976D2` dashed | VictoryLine | per-session |
| Meal dose bars | `#FF9800` | VictoryBar (dual-axis scaled) | `mealDoseMarker` |
| Insulin dose bars | `#9C27B0` | VictoryBar (dual-axis scaled) | `insulinDoseMarker` |

Toggle state fields: `showMealEffect`, `showInsulinEffect`, `showNetEffect`, `showCumulativeBaseline`, `showDoseMarkers`, `showActivityEffect`, `showActivityMarkers`.

### 4.6 Local activity functions

#### `calculateActivityEffectAtTime(targetMs, contributions, tauWMs, resetTimeMs)`
Z-state exponential decay model for the **teal rate line**:
- Before session start: `0`
- During session: linear ramp `0 → fullEffect`
- Post-exercise: `fullEffect × exp(−postExerciseMs / τ_Z)` where `τ_Z = SHARED_CONSTANTS.HR_MODEL.tau_Z ?? 10 min`

The τ_W (90-min) plateau does NOT apply here. It belongs only to the W-state sensitivity multiplier.

#### `calculateSensitivityMultiplierAtTime(targetMs, contributions, peakMultiplier, tauWMs)`
W-state model for ISF/CR sensitivity boost — three phases:
- **During session (startMs → endMs): full `peakBoost` applied instantly** (sensitivity starts at session start, not end). GLUT4 translocation begins within the first minutes of aerobic exercise; the previous linear ramp `0 → peakBoost` understated the indirect effect during long sessions.
- Post-exercise plateau `(endMs → endMs + τ_W)`: `peakBoost` (flat)
- After plateau: `peakBoost × exp(−(postMs − τ_W) / τ_W)`

> ⚠️ **CHANGE from earlier description:** The during-session phase was previously a linear ramp from 0 → peakBoost. It now applies the full `peakBoost` the moment `targetMs ≥ startMs` (instant onset). The rate line (`activityEffect`) is unchanged — it still ramps linearly because cumulative glucose uptake genuinely accumulates over time. Only this indirect sensitivity multiplier uses instant onset.

`peakBoost` per contribution: uses `globalPeakBoost = sensitivityMultiplier − 1` when `> 0.005` (live session); falls back to `INTENSITY_PEAK_BOOST[intensity]` for historical sessions whose live API scalar has already decayed to baseline. Returns `1 + min(totalBoost, MAX_BOOST)`.

```typescript
const INTENSITY_PEAK_BOOST: Record<string, number> =
  (SHARED_CONSTANTS as any)?.INTENSITY_PEAK_BOOST
  ?? { light: 0.10, moderate: 0.25, vigorous: 0.40 };

const MAX_BOOST: number =
  (SHARED_CONSTANTS as any)?.HR_MODEL?.max_sensitivity_boost ?? 0.60;
```

Both are read from `SHARED_CONSTANTS`, never declared as local constants.

#### `calculateFlatWindowMultiplier(targetMs, contributions, peakMultiplier, tauWMs)`

**Added in v4.11.** Returns the **constant peak** multiplier inside the session + plateau flat window `[startMs, endMs + τ_W]`, and exactly `1.0` outside it (no continuous decay).

```
Inside  [startMs, endMs + τ_W]:  1 + peakBoost  (flat)
Outside the window:               1.0
```

**Purpose:** Drives `effectiveCFForCumulative` and `effectiveC2BForCumulative` inside `buildChartPoint`. Using the continuously-decaying `calculateSensitivityMultiplierAtTime` for these overrides caused the bank-balance green line to drift upward as the multiplier decayed post-plateau — the Phase 1/2 insulin contribution shrank at each tick, making the net line rise with no new insulin. The flat-window model prevents this: the boosted absorption benefit is locked in for the duration of the window and stops, never un-delivered.

**The two functions serve distinct purposes:**

| Function | Used for | Decay model |
|---|---|---|
| `calculateSensitivityMultiplierAtTime` | Visual display areas (purple/rose, teal, orange reduction), `sensitivityMultiplier` chart field | Smooth exponential decay post-plateau |\
| `calculateFlatWindowMultiplier` | `effectiveCFForCumulative` and `effectiveC2BForCumulative` for `calculateTotalCumulativeEffects` | Binary on/off at window boundary |

### 4.7 `buildChartPoint()` — calculation sequence

```
1.  sensitivityMultiplierAtTime  = calculateSensitivityMultiplierAtTime(...)
                                    W-state model, time-resolved (not live API scalar)
2.  effectiveC2B                 = carb_to_bg_factor / sensitivityMultiplierAtTime
3.  activeMealsAtTime            = processedMeals filtered to active at targetMs
4.  mealImpact                   = calculateStackedMealEffect(activeMeals, targetTime, constants)
5.  activityAdjustedMealImpact   = calculateStackedMealEffect(activeMeals, targetTime, {effectiveC2B})
                                    (when sensitivityMultiplierAtTime > 1.005, else mealImpact)
6.  dosesForStackingAtTime       = processedInsulin via doseToStacking(dose, targetTime)
7.  insulinImpactBase            = calculateStackedInsulinChartEffect(doses, correctionFactor).totalBGImpact
                                    (S-curve, base ISF — NEVER pass effectiveCF here)
8.  insulinImpactBoosted         = insulinImpactBase × sensitivityMultiplierAtTime
9.  insulinSensitivityBoost      = insulinImpactBoosted − insulinImpactBase
10. insulinImpact                = insulinImpactBoosted
11. insulinImpactBaseDisplay     = calculateStackedInsulinChartEffect(dosesInCurrentDay, CF, persistExpired=true)
                                    Phase-3-persist version — expired doses stay at -(dose×CF) for
                                    the DISPLAY area. Only includes doses from the current daily window
                                    (hoursToLastReset filter to exclude prior-day doses).
12. resetTimeMs                  = getLastResetTimeMs(targetTime, resetHour, tzOffset)
13. activityEffectAtPoint        = calculateActivityEffectAtTime(targetMs, contributions, tauWMs, resetTimeMs)
                                    Z-state (τ_Z = 10 min) — for netEffect ONLY
14. activityEffectForDisplay     = W-state plateau + τ_W exponential decay
                                    for the blue AREA — ramps during session, flat τ_W plateau, then decays
15. activityCumulativeEffect     = calculateActivityEffectForCumulative(targetMs, contributions, resetTimeMs, now)
                                    lock-in model — for the blue VictoryArea y-value
16. netEffect                    = activityAdjustedMealImpact + insulinImpact + activityEffectAtPoint
17. allMealsUpToNow              = allMealsInWindow filtered to ms ≤ targetTimestamp
18. allDosesUpToNow              = allDosesInWindow filtered to ms ≤ targetTimestamp

19. effectiveCFForCumulative     = correctionFactor × calculateFlatWindowMultiplier(...)
                                    when flatWindowMultiplier > 1.005, else undefined
                                    FLAT WINDOW (binary on/off) — not the continuously-decaying
                                    sensitivityMultiplierAtTime (see §4.6 for rationale)
20. effectiveC2BForCumulative    = carb_to_bg_factor / calculateFlatWindowMultiplier(...)
                                    when flatWindowMultiplier > 1.005, else undefined
                                    Passed as dedicated 10th arg — NOT injected into patientConstants

21. ← PRE-LOOP STEP (called ONCE before the map(), not inside buildChartPoint) ←
    phase3Resolvers = makePhase3Resolvers(
      activityContributions, peakSensitivityMultiplier, TAU_W_MS,
      correctionFactor, carb_to_bg_factor
    )
    Builds two resolvers that evaluate the sensitivity multiplier at the
    absorption-end timestamp of each event (not at targetTimestamp).
    Frozen per event, not per chart tick — prevents Phase 3 clamp from drifting
    as sensitivityMultiplier decays post-session. (v4.13)

22. cumulative                   = calculateTotalCumulativeEffects(
                                     allMealsUpToNow, allDosesUpToNow, targetTime,
                                     patientConstants,  ← NOT modified (no effectiveC2B injection!)
                                     profiles,
                                     resetHour, tzOffset,
                                     undefined,                    ← activities NEVER passed here
                                     effectiveCFForCumulative,     ← 9th arg: Phase 1/2 insulin only
                                     effectiveC2BForCumulative,    ← 10th arg: Phase 1/2 meals only
                                     undefined,                    ← absorptionReferenceTime
                                     phase3Resolvers.resolvePhase3CF,   ← 12th arg (v4.13)
                                     phase3Resolvers.resolvePhase3C2B,  ← 13th arg (v4.13)
                                   )
23. cumulativeNetBaseline        = cumulative.cumulativeNetBaseline
                                   + calculateActivityEffectForCumulative(targetMs, contributions, resetTimeMs, now)
                                     ← lock-in model; now passed as 4th arg (v4.8)
                                     DOUBLE-COUNT GUARD: activities NOT in arg 8 above AND added here only

24. ← POST-PASS STEP (applied after all points are built) ←
    applyInsulinCumulativeFloor(points)
    Prevents cumulativeInsulinEffect from rising as sensitivityMultiplier decays.
    Propagates the clamp delta to cumulativeNetBaseline.
    Called once on the complete array, not inside buildChartPoint() itself.
```

**Key invariants:**
- `calculateTotalCumulativeEffects` is called **without** the `activities` argument. The activity term is added manually at step 23. Passing both would double-count.
- `patientConstants` is passed **unmodified** to `calculateTotalCumulativeEffects`. `effectiveC2BForCumulative` is passed as the dedicated 10th argument — never injected into `patientConstants.carb_to_bg_factor` (that would corrupt Phase 3 meal values which read the constant directly).
- `calculateSensitivityMultiplierAtTime` is always time-resolved. The live API's `sensitivity_multiplier` scalar is only authoritative at "now".
- `effectiveCFForCumulative` and `effectiveC2BForCumulative` use `calculateFlatWindowMultiplier` (flat binary window), not `calculateSensitivityMultiplierAtTime` (continuous decay). See §4.6 for the detailed rationale.
- Phase 3 (fully absorbed) meals/doses persist at 100% effect via `calculateTotalCumulativeEffects` v4.5+.
- `insulinImpactBase` uses the base `correctionFactor`. The sensitivity multiplier is applied post-hoc at step 8. Never pass `effectiveCF` into `calculateStackedInsulinChartEffect` — that would square the multiplier.
- The purple DISPLAY area uses `insulinImpactBaseDisplay` (Phase-3-persist), not `insulinImpactBase` (snaps to 0 at expiry).

### 4.8 `allMealsInWindow` / `allDosesInWindow` construction

Lower bound = `min(rangeStart, earliestResetMs)` where `earliestResetMs = getLastResetTimeMs(new Date(min(rangeStart, now)), resetHour, tzOffset)`. This carries in pre-window meals when the chart range starts after today's reset (short views), and reaches back to historical daily resets for multi-day views.

Upper bound for meals = `rangeEnd` (includes future-snapped meals whose absorption starts after "now"). Upper bound for doses = `now`.

### 4.9 Synthetic historical contributions

For multi-day views, `rawActivityHistory` records outside today's ODE window are converted to synthetic `ActivityContribution` objects. These fill the gap where today's `activityPD.activity_contributions` does not reach (prior daily windows).

Sessions already present in `activityContributions` (matched by `activity_id`) are excluded from the synthetic set to prevent double-counting. ODE-accurate results always take priority over synthetic approximations.

Synthetic cumulative BG effect formula:
```
Z_avg   = 1 − exp(−min(duration, 90) / SYNTHETIC_TAU_Z)   [SYNTHETIC_TAU_Z = 15 min]
drop    = ACUTE_RATE_PER_MIN × min(duration, 90) × Z_avg × intensityScale × weightScale
result  = bgDirection × (−drop)
```
`SYNTHETIC_TAU_Z = 15` and `ACUTE_RATE_PER_MIN = 0.15 mg/dL/min` are chart-display approximations for historical sessions with no HR trace. They are not sourced from `HR_MODEL` / `SHARED_CONSTANTS`.

Intensity mapping uses `SHARED_CONSTANTS.LEVEL_TO_INTENSITY` for the numeric-level → string conversion:

| level | intensity |
|-------|-----------|
| `-2`, `-1` | `null` (sedentary — skipped) |
| `0` | `'light'` |
| `1` | `'moderate'` |
| `2` | `'vigorous'` |

### 4.10 Now-summary BG estimate

```
Dynamic mode:
  modelEstimatedBG = stableBaseline + nowPoint.cumulativeNetBaseline
  estimatedBG      = modelEstimatedBG   (activity already in cumulative)

Preset mode (when hookEstimatedBG is available):
  estimatedBG      = hookEstimatedBG                     (includes reading residual)
  residualOffset   = hookEstimatedBG − modelEstimatedBG  (applied to all tooltip BG values)
```

### 4.11 `generateChartData` post-processing

After `buildChartPoint` runs for all time points, EVC applies a single post-pass floor:

```typescript
// v4.14: prevent cumulativeInsulinEffect from rising as sensitivityMultiplier decays
applyInsulinCumulativeFloor(points);
setChartData(points);
```

This is structurally equivalent to — but more composable than — an inline running-min loop inside `generateChartData`. The utility is the same function exported from `cumulative-effects.ts` and used by BGV (see §6.7).

### 4.12 `insulinBoostData` flat-floor fix

**File:** `EffectsVisualizationChart.tsx` — `insulinBoostData` useMemo  
**Version:** introduced in v4.14

**Problem:** The light-blue sensitivity-boost area (rendered between `insulinImpactBaseDisplay` and `insulinImpactBaseDisplay × sensitivityMultiplier`) had a mountain/peak shape — it would deepen, reach a maximum, then rise back toward `insulinImpactBaseDisplay` before the purple insulin area ended.

**Root cause:** The band's bottom edge was computed as:
```
y = insulinImpactBaseDisplay × sensitivityMultiplier
```
As the post-exercise multiplier decays (`1.3 → 1.0`) while the dose is still absorbing, the product `(multiplier − 1) × |base|` peaks then shrinks, pulling the bottom edge back up toward the purple area.

**Fix:** The `insulinBoostData` useMemo is now a stateful loop tracking a running `yFloor`. The band's bottom edge may only go deeper (more negative), never shallower:

```typescript
const insulinBoostData = useMemo(() => {
  let yFloor = 0;
  return chartData.map(p => {
    const y = p.insulinImpactBaseDisplay * p.sensitivityMultiplier;
    if (Math.abs(p.insulinImpactBaseDisplay) < 0.01) {
      yFloor = 0;  // no doses on board / daily reset — clear floor
    } else {
      yFloor = Math.min(yFloor, y);  // ratchet: only deeper
    }
    return {
      x:  p.timestamp,
      y:  yFloor,                      // flat once max depth is reached
      y0: p.insulinImpactBaseDisplay,  // bottom of purple = top of blue band
    };
  });
}, [chartData]);
```

Floor resets when `|insulinImpactBaseDisplay| < 0.01` (no IOB / daily reset boundary).

**Scope:** Display-only change. Stays entirely inside `EffectsVisualizationChart.tsx`. Does not affect the `cumulativeNetBaseline` calculation or any other chart component.

### 4.13 State summary

| State | Purpose |
|---|---|
| `viewMode` | Active view key; drives `timeRange`, `viewConfig`, `activeEffectsOptions` |
| `customRangeStart / End / Applied` | Custom date picker state |
| `chartData` | `EffectsChartPoint[]` from `generateChartData` |
| `generating` | Inner spinner while `buildChartPoint` runs |
| `timedOut` | Escape hatch — clears spinner after 8 s if `effectsLoading` never resolves |
| `tooltipData` | Currently open tap-to-inspect modal |
| `show*` toggles | Per-series visibility |
| `aboutExpanded` | "About this Chart" accordion |

---

## §5 ActiveEffectsDisplay

**File:** `components/ActiveEffectDisplay.tsx`  
**Purpose:** Live snapshot card showing IOB, MOB, AOB, estimated BG, projected BG, trend, and safety status. Performs its own API fetch every 60 seconds. Accepts `activityPDResult` as a prop to skip a redundant ODE fetch when mounted alongside other components on the same screen.

### 5.1 Props

```typescript
interface ActiveEffectDisplayProps {
  activityPDResult?: ActivityPDResult | null;
  // When provided AND non-null: fetchAndCalculate() skips GET /api/activity/pharmacodynamics
  // and uses this value directly. A dedicated useEffect triggers fetchAndCalculate()
  // immediately when the prop reference changes, avoiding a 60-second timer wait.
  // When absent (standalone): component self-fetches as usual.
  //
  // ⚠️  Pass `undefined` (not null) while the parent hasn't yet completed its first
  // fetch. `null` is interpreted as "fetched, no sessions today" and short-circuits
  // the ODE call to zero activity — which is wrong during the initial load window.
  // Use `lastUpdate ? activityPDResult : undefined` at the call-site.

  meals?: any[];
  // When provided: fetchAndCalculate() skips GET /api/meals-only entirely and uses
  // this array directly (after the standard normaliseMeal step). Both this prop AND
  // insulinDoses must be non-undefined to activate the skip — passing only one has no effect.
  // Pass from screen-level useActiveEffects to eliminate duplicate meals fetches.

  insulinDoses?: any[];
  // When provided: fetchAndCalculate() skips GET /api/insulin-data entirely.
  // Same rationale and constraint as meals above.

  onEffectsComputed?: (data: ActiveEffectData) => void;
  // Called every time fetchAndCalculate() completes successfully with the
  // fully-assembled ActiveEffectData snapshot.
  //
  // Lets any parent that renders AED pass the live PK snapshot to co-mounted forms
  // (MealForm, UnifiedInsulinInput, QuickMealForm) without a second fetch — the
  // single source of truth that eliminates the historic panel discrepancy where the
  // forms used a stale getActiveEffectsFull() estimate while AED showed a fresher value.
  //
  // Wire-up pattern (screen level):
  //   const [aedSnapshot, setAedSnapshot] = useState<ActiveEffectData | null>(null);
  //   <ActiveEffectDisplay onEffectsComputed={setAedSnapshot} />
  //   <MealForm liveActiveEffects={aedSnapshot ?? undefined} />
  //
  // Type: imported from @/types/active-effects.types (Arm 2 §6).
}
```

### 5.2 Data fetch

`fetchAndCalculate()` makes up to four parallel requests, with prop-based skips:

```
Promise.all([
  meals prop provided?        → skip GET /api/meals/meals-only  (use prop directly after normaliseMeal)
                              → else GET /api/meals/meals-only?start=windowStart&end=windowEnd

  insulinDoses prop provided? → skip GET /api/insulin/data      (use prop directly after normaliseDose)
                              → else GET /api/insulin/data?start=windowStart&end=windowEnd

  GET /api/blood-sugar/list?start_time=...&end_time=...

  activityPDResult prop non-null? → skip GET /api/activity/pharmacodynamics/stacked
                                  → else GET /api/activity/pharmacodynamics/stacked
])
```

**Prop-skip contract:** Both `meals` **and** `insulinDoses` must be provided to activate the fetch skip for those two calls. Passing only one has no effect — AED will still fetch both from the API. This matches the dashboard screen `DR-Dashboard-02` rule.

`windowStart = lastResetMs − 6 h`. The fetch window is anchored to the current daily reset time, not a fixed 24-hour lookback. The 6-hour buffer behind the reset covers long-acting insulin doses that started before today's reset but are still pharmacologically active.

**Why the change mattered:** The old fixed 24 h window caused two problems: (1) at 9 PM with a 7 AM reset it reached back ~38 h, inflating `mealsCount` / `dosesCount` in metadata (and therefore the "unreliable estimate" checklist); (2) the counts were computed from raw unfiltered arrays, making them wrong regardless of any downstream `allMealsInWindow` filter.  The reset-anchored window makes the fetch boundary match the filter boundary.

Polling: fires at `hasLoadedFromAPI = true`, snaps to the next minute boundary, then repeats every 60 seconds. A separate `useEffect` fires `fetchAndCalculate()` immediately when `propPDResult` changes reference, so EVC and AED update in the same render cycle when a parent refreshes activity data.

All utility functions (`parseUTCMs`, `normaliseMeal`, `normaliseDose`, `getMealDurationHours`, `getLastResetTimeMs`) are imported from `@/utils/ChartUtils`. No local copies exist. `calculateActivityEffectForCumulative` is imported from `@/utils/calculations`.

### 5.3 `fetchAndCalculate()` — calculation steps

1. Fetch meals, insulin, readings, activityPD (prop or API).
2. Normalise meals via `normaliseMeal()` (ChartUtils); doses via `normaliseDose()` (ChartUtils).
3. Compute reset window: `lastResetMs = getLastResetTimeMs(currentTime, resetHour, tzOffset)`.
4. Filter to active window: `allMealsInWindow` (≥ `lastResetMs`), `allDosesInWindow` (≥ `lastResetMs`). Both use `>=` boundary, matching `calculateTotalCumulativeEffects`.
5. Map `activeDosesRaw` → `InsulinDoseForStacking[]` via `rawDoseToStacking()`.
6. Calculate `frontendIOB` and `frontendMOB` using `sensitivityMultiplier > 1.005` threshold to select effective vs raw constants.
7. Find most recent reading in `[lastResetMs, now]`.
8. Detect activity-reading overlap: if the reading was taken inside an active session's PD window, flag `activityOverlapWarning`.
9. Calculate baseline: circadian (preset) or `calculateStableBaselineFromReading` (dynamic), with `sanitizeBaseline` applied.
10. Calculate net effect: `calculateNetEffect(baseline, allMealsInWindow, allDosesInWindow, currentTime, constants, MEAL_ABSORPTION_PROFILES, activityPD)` — activityPD IS passed here as the 7th argument, but **only** for computing `trend` and `safetyStatus`. `estimatedBG` is built independently from the bank-balance formula below.
11. Calculate corrected cumulative:
    ```typescript
    calculateTotalCumulativeEffects(
      allMealsInWindow, allDosesInWindow, now, constants, profiles,
      resetHour, tzOffset,
      undefined,           // ← activities NEVER passed (double-count guard)
      effectiveCFWhenActive,   // ← 9th arg: Phase 1/2 insulin CF override
      effectiveC2BWhenActive,  // ← 10th arg: Phase 1/2 meal C2B override
                               //   = baseCarbToBGFactor / sensitivityMultiplier when > 1.005
                               //   Pass as dedicated arg — NOT injected into patientConstants
    )
    ```
    `effectiveCFWhenActive` and `effectiveC2BWhenActive` are computed as:
    ```typescript
    const effectiveCFWhenActive  = sensitivityMultiplier > 1.005 ? baseCF * sensitivityMultiplier : undefined;
    const effectiveC2BWhenActive = sensitivityMultiplier > 1.005 ? baseCarbToBGFactor / sensitivityMultiplier : undefined;
    ```
12. Compute `activityEffectAtReading = calculateActivityEffectForCumulative(readingMs, contributions, lastResetMs)`.
13. `activityDeltaSinceReading = cumulativeActivityEffect − activityEffectAtReading`.
14. `correctedEstimatedBG = stableBaseline + correctedCumulative.cumulativeNetBaseline + activityDeltaSinceReading`.
15. Preset mode adds `readingResidual = reading − circadianAtReading − cumulAtReadingNet`.
16. `simpleProjectedFinalBG = correctedEstimatedBG + (pendingMOBRise − pendingIOBReduction)`.

The sensitivity multiplier threshold throughout AED is `> 1.005` (not `> 1.0`), suppressing floating-point noise.

### 5.4 Internal data shape — `ActiveEffectData`

```typescript
// ── Canonical definition lives in @/types/active-effects.types (Arm 2 §6) ──
// Import from there in ALL consumers (AED, MealForm, UnifiedInsulinInput, QuickMealForm).
// The shape below is the display reference; the type file is the authority.

interface AobIndirectEffects {
  iobPending:    number;   // extra IOB drop still to arrive (unsigned, mg/dL)
  iobDelivered:  number;   // extra IOB drop already happened (unsigned, mg/dL)
  mobPending:    number;   // BG spike saving still pending (unsigned, mg/dL)
  mobDelivered:  number;   // BG spike already suppressed (unsigned, mg/dL)
  // All four are 0 when sensitivityMultiplier ≤ 1.005
}

interface ActiveEffectData {
  iob: {
    totalActiveInsulin:    number;    // units
    activeDoses:           number;
    currentBGReduction:    number;    // mg/dL already lowered (sensitivity-adjusted)
    rawCurrentBGReduction: number;    // mg/dL already lowered at BASE correction factor
    pendingBGReduction:    number;    // mg/dL still to arrive (sensitivity-adjusted)
    rawPendingBGReduction: number;    // mg/dL still to arrive at BASE correction factor
  };
  mob: {
    totalActiveCarbs:    number;    // g active carbs
    activeMealCount:     number;
    currentBGElevation:  number;
    pendingBGRise:       number;     // sensitivity-adjusted
    rawPendingBGRise:    number;     // at raw C2B ratio — baseline before GLUT4 suppression
  };
  aob: {
    totalAOB:                  number;
    activeSessions:            number;
    cumulativeActivityEffect:  number;   // signed (mg/dL)
    sensitivityMultiplier:     number;   // ≥ 1.0
    activityContributions:     ActivityContribution[];
    effectiveCorrectionFactor: number;
    effectiveCarbToBgRatio:    number;
    indirectEffects:           AobIndirectEffects;   // always present; zeroed when sm ≤ 1.005
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
  dosesInWindow: Array<{ id: string; units: number; insulinType: string;
    administrationTime: string | null; isActive: boolean; isAbsorbed: boolean;
    isFuture: boolean; bgAbsorbed: number; bgPending: number; }>;
  mealsInWindow: Array<{ id: string; mealType: string; timestamp: string | null;
    carbs: number; absorptionType: string; isActive: boolean; isAbsorbed: boolean;
    isFuture: boolean; bgAbsorbed: number; bgPending: number; }>;
}
```

**`rawCurrentBGReduction` / `rawPendingBGReduction` (IOB):** Computed at the base `correction_factor` with no exercise boost. The UI shows the raw vs sensitivity-adjusted delta as the "IOB indirect effect" in the Activity Effects card.

**`rawPendingBGRise` (MOB):** Added alongside the IOB raw fields. Exposes the unmodified carb-to-BG rise before post-exercise GLUT4 suppression. Equivalent role to `rawPendingBGReduction` on the IOB side.

**`aob.indirectEffects`:** Changed from an optional `?` field with the old `extraIOBReduction` / `mobSuppression` / `aobExtraDrop` shape to a **non-optional** `AobIndirectEffects` value that is always present (all four sub-fields zeroed when `sensitivityMultiplier ≤ 1.005`). The four sub-fields distinguish pending vs delivered for both IOB and MOB indirect effects.

**Canonical type location:** `@/types/active-effects.types` (Arm 2 §6). Do not redeclare locally.

### 5.5 UI layout

```
Header
  ├── Baseline system badge (🌙 Circadian / 📍 Dynamic)
  └── Timestamp

Banners (conditional)
  ├── Hard clamp warning (raw baseline < 55 or > 220 mg/dL)
  ├── Soft low baseline warning (55–75 mg/dL, dynamic mode)
  └── Reading residual alert (preset mode, |residual| ≥ 20 mg/dL)

Unreliable estimate alert (when estimatedBG < 10 — replaces the three BG cards)

Three-card BG row:  Last Reading → Estimated Now → Projected

"More details" toggle (formula strips)

Two-column row
  ├── IOB card (💉)
  │     ├── Pending BG reduction / Absorbed so far
  │     └── Per-dose breakdown (collapsible)
  └── MOB card (🍽️)
        ├── Pending BG rise / Absorbed so far
        └── Per-meal breakdown (collapsible)

Activity Effects card (🏃)
  ├── Combined AOB + indirect effect value
  ├── Per-session breakdown (collapsible)
  └── Indirect effects block (IOB boost + MOB suppression, when sensitivityMultiplier > 1.005)

Status assessment card (tug-of-war display when both IOB and MOB are active)

Net Effect Analysis (collapsible — full formula breakdown)

Footer metadata
```

### 5.6 Residual alert classification (preset mode)

`classifyResidual(residual, mealsCount, dosesCount, carbToBgFactor, correctionFactor, minutesSinceReading, activityOverlapWarning)` maps the gap between the reading and the circadian model into four tiers:

| Tier | Threshold |
|------|-----------|
| `noise` | `|residual| < 20 mg/dL` |
| `soft` | 20–49 mg/dL |
| `strong` | 50–99 mg/dL |
| `critical` | ≥ 100 mg/dL |

Positive residual → BG higher than model (unlogged carbs / illness). Negative → BG lower (unlogged insulin / activity). Alerts include a carb-equivalent (high) or insulin-equivalent (low) translation and context-aware copy (first entry of day, stale reading, activity overlap).

---

## §6 BloodGlucoseVisualization

**File:** `components/charts/BloodGlucoseVisualization.tsx`  
**Ported from:** `frontend/src/components/BloodSugarVisualization.js` (v3.0)  
**Chart library:** victory-native

Primary patient-facing chart. Plots actual BG readings against a projected BG line anchored to `baseBG`, with an orange area fill showing the cumulative net effect.

### 6.1 Props

```typescript
export interface BloodGlucoseVisualizationProps {
  height?:       number;    // default: 320
  showControls?: boolean;   // default: true
  embedded?:     boolean;   // default: false
  defaultView?:  string;    // default: '12h'
  onDataUpdate?: (data: BGChartPoint[]) => void;
  activityPD?:   ActivityPDResult | null;
  // When provided, BGV uses this directly and skips its own hook activityPDResult.
  // Pass from any parent that already owns the PD fetch to eliminate double hook calls.
  // When absent, BGV falls back to its own useActiveEffects activityPDResult.
}
```

### 6.2 Data sources

```
useActiveEffects(activeEffectsOptions)
  ├── meals:          rawMeals
  ├── insulinDoses:   rawDoses
  ├── stableBaseline: number | null  (NaN-guarded — see note below)
  ├── baselineMode:   'dynamic' | 'preset'
  └── activityPDResult: ActivityPDResult | null  ← fallback when activityPD prop absent

resolvedActivityPD = activityPD_prop ?? activityPDResult

useGlucoseBuffer(rangeStart, rangeEnd, viewConfig.pastHours, 60_000, 'BloodGlucoseVisualization')
  └── readings: GlucoseReading[]  ← shared hook from useBloodGlucoseEstimation
```

`skipIobCutoff: true` — BGV re-filters doses per chart point.

`windowHours` follows the same `max(displayPastHours, getCumulativeLookbackHours(resetHour))` pattern as EVC.

**NaN guard:** `stableBaseline` can arrive as `NaN` (not `null`) when the API returns `bloodSugar` instead of `value`. The `??` operator does not catch `NaN`, so BGV uses an explicit `Number.isNaN` guard and falls back to `patientConstants.target_glucose`. Without this, `baseBG` becomes `NaN` and all SVG paths collapse.

### 6.3 View modes

| Key | pastHours | futureHours | interpolationInterval |
|---|---|---|---|
| `3h` | 2 | 1 | 5 min |
| `6h` | 4 | 2 | 5 min |
| `12h` | 10 | 2 | 10 min |
| `24h` | 20 | 4 | 15 min |
| `3d` | 68 | 4 | 30 min |
| `week` | (SHARED_CONSTANTS) | (SHARED_CONSTANTS) | — |
| `custom` | user-defined | user-defined | auto |

BGV does **not** apply the 12h future-window override present in EVC. If EVC and BGV are embedded side-by-side with `defaultView='12h'`, EVC projects 4 additional hours further than BGV.

### 6.4 Chart point type

```typescript
interface BGChartPoint {
  timestamp:     number;
  formattedTime: string;

  // Blood glucose series (left Y-axis, 40–400 mg/dL)
  actualBG:          number | null;    // non-null only at actual reading timestamps
  baseBG:            number;           // circadian value (preset) or stableBaseline (dynamic)
  highConfidenceBG:  number | null;    // baseBG + cumulativeNetBaseline when confidence ≥ high
  lowConfidenceBG:   number | null;    // baseBG + cumulativeNetBaseline when confidence < high

  // Cumulative bank balance
  cumulativeNetBaseline:   number;     // includes activity lock-in contribution
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;

  // Instantaneous rate-of-change
  netEffect:     number;
  mealImpact:    number;
  insulinImpact: number;    // always ≤ 0

  isActualReading: boolean; isHistorical: boolean; isFuture: boolean; isNow: boolean;
  confidenceLevel: string;
  confidenceColor: string;

  mealsAdministered:   any[];
  insulinAdministered: any[];
}
```

### 6.5 Chart series

| Toggle | Colour | Type | Notes |
|---|---|---|---|
| 📈 Estimated BG | `#8031A7` purple | VictoryLine (2 segments) | `highConfidenceBG` (solid) and `lowConfidenceBG` (dashed) |
| 🔵 Baseline BG | `#2196F3` blue dashed | VictoryLine (step) | Constant `baseBG`; shifts per point in preset mode |
| 🟠 Cumulative Area | `#FF9800` orange | VictoryArea (`y0=baseBG`) | Fills upward (meal-dominant) or downward (insulin-dominant) |
| 🟢 Net Effect Area | `#4CAF50` green | VictoryArea (`y0=baseBG`) | Instantaneous rate; default off |
| 🔴 Actual Readings | status-coloured scatter | VictoryScatter | Per-datum colour via `getBloodSugarStatusColor` |
| Connected readings | status-coloured | VictoryLine | Gap-aware: null inserted when adjacent readings exceed `MAX_READING_GAP_MS` |
| 🎯 Target / High / Low | reference colours | VictoryLine (dashed) | `target`, `target × 1.3`, `target × 0.7` |

**Right axis:** `CUMULATIVE_DELTAS = [−150, −100, −50, 0, 50, 100, 150]` mg/dL from baseline, positioned in BG space as `effectiveBaseline + delta`.

**Connected readings gap threshold:** `MAX_READING_GAP_MS = max(20, viewConfig.pastHours × 12) × 60 000`. Scales null-break gap with view window (20 min for 3H to ~14 h for 3D).

### 6.6 Local activity functions

BGV defines the **same two local functions** as EVC with identical logic:

`calculateActivityEffectAtTime(targetMs, contributions, tauWMs, resetTimeMs)` — Z-state decay, no plateau; same formula as EVC §4.6.

`calculateSensitivityMultiplierAtTime(targetMs, contributions, peakMultiplier, tauWMs)` — W-state plateau + decay; identical to EVC §4.6. Both read `INTENSITY_PEAK_BOOST` and `MAX_BOOST` from `SHARED_CONSTANTS`.

### 6.7 `buildBGChartPoint()` — calculation sequence

```
1.  sensitivityMultiplierAtTime  = calculateSensitivityMultiplierAtTime(...)
2.  effectiveCFForCumulative     = correctionFactor × sensitivityMultiplierAtTime
3.  effectiveC2BForCumulative    = carb_to_bg_factor / sensitivityMultiplierAtTime
4.  patientConstantsForCumulative = inject effectiveC2B when > 1.005, else raw constants
5.  baseBG  = getCircadianBaseline(pointHour)  (preset) OR stableBaseline (dynamic)
6.  actualBG lookup — match reading within halfIntervalMs
7.  activeMealsAtTime filter → calculateStackedMealEffect → mealImpact
8.  dosesForStackingAtTime → calculateStackedInsulinChartEffect → insulinImpact (S-curve, base CF)
9.  netEffect = mealImpact + insulinImpact
10. allMealsUpToNow / allDosesUpToNow filtered to ≤ targetTimestamp
11. cumulative = calculateTotalCumulativeEffects(
                   allMealsUpToNow, allDosesUpToNow, targetTime,
                   patientConstantsForCumulative, profiles, resetHour, tzOffset,
                   undefined,               ← activities NEVER passed here
                   effectiveCFForCumulative ← Phase 1/2 only; Phase 3 uses base CF (v4.5)
                 )
12. resetTimeMs         = getLastResetTimeMs(targetTime, resetHour, tzOffset)
13. activityCumulative  = calculateActivityEffectForCumulative(targetMs, contributions, resetTimeMs)
14. totalCumulativeNetBaseline = cumulative.cumulativeNetBaseline + activityCumulative
15. estimatedBG = baseBG + totalCumulativeNetBaseline
16. confidence → highConfidenceBG / lowConfidenceBG split

17. ← POST-PASS STEP (applied after all points are built) ←
    applyInsulinCumulativeFloor(points)
    Same motivation and mechanics as EVC §4.11.
    Prevents cumulativeInsulinEffect and cumulativeNetBaseline from exhibiting
    the mountain shape during the post-exercise sensitivity window.
    Called once on the complete BGChartPoint[] array before it is committed to state.
```

### 6.8 EVC vs BGV `buildChartPoint` differences

| Aspect | EVC | BGV |
|---|---|---|
| Sensitivity multiplier | `calculateSensitivityMultiplierAtTime()` per point | `calculateSensitivityMultiplierAtTime()` per point — identical |
| Insulin ISF boost | `insulinSensitivityBoost` rendered as a separate series | `effectiveCFForCumulative` applied to cumulative only; not a separate series |
| Meal ISF reduction | `activityAdjustedMealImpact` re-computed with `effectiveC2B` | `effectiveC2BForCumulative` injected into `patientConstantsForCumulative` for cumulative |
| Instantaneous activity | `calculateActivityEffectAtTime()` — Z-state (`τ_Z = 10 min`) | `calculateActivityEffectAtTime()` — Z-state (`τ_Z = 10 min`) — identical |
| `baseBG` | Always `stableBaseline` | Circadian curve per point in preset mode; `stableBaseline` in dynamic mode |

---

## §7 BloodGlucoseChart

**File:** `components/charts/BloodGlucoseChart.tsx`  
**Ported from:** `frontend/src/components/PureGlucoseVisualization.js`  
**Chart library:** victory-native

Clean visualization of raw blood glucose readings only. No PK overlay, no projection, no cumulative model.

### 7.1 Props

```typescript
export interface BloodGlucoseChartProps {
  height?:       number;    // default: 320
  showControls?: boolean;   // default: true
  embedded?:     boolean;   // default: false
  defaultView?:  string;    // default: '12h'
}
```

No `activityPD` prop. No `useActiveEffects` call.

### 7.2 Data source

```typescript
const { readings, isLoading, error, refresh } = useGlucoseBuffer(
  rangeStart, rangeEnd, viewConfig.pastHours, 60_000, 'BloodGlucoseChart',
);
```

Readings are the only data source. The shared `useGlucoseBuffer` hook is imported from `@/hooks/useBloodGlucoseEstimation`.

### 7.3 Glucose bands

```typescript
const GLUCOSE_BANDS = {
  veryHigh: { min: 250, max: 400, color: '#ef4444', bgColor: 'rgba(239,68,68,0.08)'  },
  high:     { min: 180, max: 250, color: '#f97316', bgColor: 'rgba(249,115,22,0.08)' },
  target:   { min: 70,  max: 180, color: '#22c55e', bgColor: 'rgba(34,197,94,0.10)'  },
  low:      { min: 54,  max: 70,  color: '#f97316', bgColor: 'rgba(249,115,22,0.08)' },
  veryLow:  { min: 40,  max: 54,  color: '#ef4444', bgColor: 'rgba(239,68,68,0.08)'  },
};
```

Line colour groups: `veryHigh + veryLow → red`, `high + low → orange`, `target → green`. At colour-group transitions, the boundary point is included in both adjacent colour arrays so the lines join seamlessly.

### 7.4 CGM vs SMBG mode

`isCGM` = majority of readings have `source ∈ {'cgm', 'libre_cgm', 'libre'}` (requires `source` field from the API response).

**CGM:** raw point plotting, no interpolation.  
**SMBG:** smoothstep (S-curve) interpolation between consecutive readings at `interpolationIntervalMin` spacing:
```
smooth(t) = t² × (3 − 2t)
glucose(t) = a.bloodSugar + smooth(t) × (b.bloodSugar − a.bloodSugar)
```
Interpolated points carry `isActual: false` and `source: 'interpolated'`.

### 7.5 Chart series

| Feature | Type | Notes |
|---|---|---|
| Glucose curve | 3 × VictoryLine | Red / orange / green segments split by band |
| Soft area fill | VictoryArea | Under-curve fill following the glucose line |
| Zone background tints | 5 × VictoryArea | Two-point horizontal bands per glycaemic zone |
| Reference lines | VictoryLine (dashed) | High threshold, target, low threshold |
| Now marker | VictoryLine (dotted) | Current time — `#6b7280` grey |
| Actual reading dots | VictoryScatter | Larger for SMBG, tiny for CGM |

### 7.6 Statistics bar

Computed from `PlotPoint[]` after `buildPlotPoints`:

| Stat | Formula |
|---|---|
| Most Recent | Latest `isActual = true` reading: value, band label, timestamp |
| Avg | Mean of all `isActual = true` readings in window |
| Min / Max | Min / max of all `isActual = true` readings |
| TIR | % readings where `70 ≤ glucose ≤ 180` mg/dL |
| Count | Count of actual readings |

TIR colour: green ≥ 70%, orange ≥ 50%, red < 50%.

### 7.7 No shared PK calculation stack

BGC does not use `calculateTotalCumulativeEffects`, `calculateStackedMealEffect`, `calculateStackedInsulinEffect`, or any other PK function. Its only shared imports from the wider codebase are `useCurrentMinute`, `useChartTimeRange`, `parseUTCMs`, `VIEW_CONFIGS`, `generateXAxisTicks`, `formatXAxis`, `type TimeRange` (all from `@/utils/ChartUtils`), and `useGlucoseBuffer` (from `@/hooks/useBloodGlucoseEstimation`).

### 7.8 View modes

View mode buttons are derived dynamically from `VIEW_CONFIGS` keys. A separate "📅 Range" button activates the custom date-range picker backed by `getCustomViewConfig(start, end)`, which auto-selects tick density from duration:

| Duration | tickInterval | interpolationInterval |
|----------|-------------|----------------------|
| ≤ 6 h | 1 h | 5 min |
| ≤ 24 h | 3 h | 15 min |
| ≤ 72 h | 12 h | 30 min |
| ≤ 168 h | 24 h | 60 min |
| > 168 h | 72 h | 60 min |

---

## §8 Shared Calculation Stack

| Function | Location | Used by |
|---|---|---|
| `calculateStackedMealEffect` | `@/utils/glucose/meal-pharmacodynamics` | EVC, BGV |
| `calculateStackedInsulinEffect` | `@/utils/insulin/pharmacodynamics` | AED |
| `calculateStackedInsulinChartEffect` | `@/utils/insulin/pharmacodynamics` | EVC, BGV |
| `calculateTotalCumulativeEffects` v4.14 | `@/utils/calculations/cumulative-effects` | EVC, AED, BGV, useActiveEffects |
| `calculateActivityEffectForCumulative` | `@/utils/calculations/cumulative-effects` | EVC, AED, BGV, useActiveEffects |
| `applyInsulinCumulativeFloor<T>(points)` | `@/utils/calculations/cumulative-effects` | EVC (post-pass after `generateChartData`), BGV (post-pass after points build). **Not** AED, `useActiveEffects`, or `useBloodGlucoseEstimation`. |
| `calculateStableBaselineFromReading` | `@/utils/calculations/baseline` | AED, useActiveEffects |
| `calculateNetEffect` wrapper | `@/utils/calculations/net-effect` | useActiveEffects (6-arg call), AED (7-arg call for trend/safety only) |
| `sanitizeBaseline` | `@/utils/calculations/baseline` | AED, useActiveEffects |
| `getCircadianBaseline` | `@/constants/shared-constants` | AED, useActiveEffects, BGV |
| `MEAL_ABSORPTION_PROFILES` | `@/constants/shared-constants` | EVC, AED, BGV, useActiveEffects |
| `SHARED_CONSTANTS` | `@/constants/shared-constants` | EVC, BGV |
| `parseUTCMs` | `@/utils/ChartUtils` | All four components |
| `getMealDurationHours` | `@/utils/ChartUtils` | EVC, AED, BGV |
| `normaliseDose` / `normaliseMeal` | `@/utils/ChartUtils` | EVC, AED, BGV |
| `getLastResetTimeMs` | `@/utils/ChartUtils` | EVC, AED, BGV |

### 8.1 `calculateTotalCumulativeEffects` — v4.14

**v4.4 — Persist-at-100% (Phase 3):** Once an absorption window ends, the event's full effect is locked into the cumulative baseline until the daily reset:
```
Phase 3 (hours-since ≥ duration):
  meal:    return totalCarbs × carb_to_bg_factor          (positive)
  insulin: return −(doseAmount × base_correction_factor)  (negative)
```
Phase 3 always uses the **base** `correction_factor`, not the `overrideCorrectionFactor` (effective CF). The override applies only to Phases 1 and 2 (active partial absorption).

**v4.5 — Phase 3 crash + CF bug:**
A `tzOffsetMinutes` scope error in the Phase 3 insulin branch caused a `ReferenceError` on every chart render, silently swallowed by `generateChartData`'s try-catch. Phase 3 also incorrectly applied `overrideCorrectionFactor`, causing the cumulative green line to drop during exercise windows for doses that were already fully absorbed.

**Caller contract:**
```typescript
calculateTotalCumulativeEffects(
  meals,                      // ALL meals in daily window — Phase 3 requires fully-absorbed items
  insulinDoses,               // ALL doses in daily window
  currentTime,
  patientConstants,           // pass UNMODIFIED — never inject effectiveC2B into this object
  absorptionProfiles,
  resetHour,
  timezoneOffsetMinutes,
  activities?,                // ← NEVER pass when adding activity term manually afterward
  effectiveCorrectionFactor?, // 9th arg: Phase 1/2 insulin only; Phase 3 ignores (v4.5 fix)
  overrideCarbToBGFactor?,    // 10th arg: Phase 1/2 meals only; Phase 3 ignores (v4.6 fix)
                              //   Pass as DEDICATED arg — do NOT inject into patientConstants
  absorptionReferenceTime?,   // 11th arg: v4.10 — freezes the absorption ramp at "now" for future
                              //   chart points while currentTime continues to own the reset check.
                              //   Pass undefined in point-in-time evaluators (AED, useActiveEffects).
  resolvePhase3OverrideCF?,   // 12th arg: v4.13 — (absorptionEndMs) => number | undefined
                              //   Frozen CF resolver for the Phase 3 clamp (prevents drift as
                              //   sensitivityMultiplier decays). Build once per generateChartData
                              //   run using makePhase3Resolvers() in EVC/BGV.
  resolvePhase3OverrideC2B?,  // 13th arg: v4.13 — (absorptionEndMs) => number | undefined
                              //   Frozen C2B resolver for the Phase 3 clamp — same pattern as CF.
)
```

> **v4.6 CRITICAL**: `overrideCarbToBGFactor` must be passed as the dedicated 10th argument. Injecting it into `patientConstants.carb_to_bg_factor` instead would cause Phase 3 meals (which read `patientConstants.carb_to_bg_factor` directly) to use the exercise-reduced value, causing the cumulative green line to plunge during the sensitivity window for fully-absorbed meals.

> **v4.13**: `resolvePhase3OverrideCF` / `resolvePhase3OverrideC2B` are built once before the chart map loop using `makePhase3Resolvers()`. They evaluate the sensitivity multiplier at each event's absorption-end timestamp — a constant per event, not per chart tick. This prevents Phase 3 clamp values from drifting upward as `sensitivityMultiplier` decays post-session.

### 8.2 `calculateActivityEffectForCumulative` — lock-in model

**Location:** `@/utils/calculations/cumulative-effects` (exported from `@/utils/calculations` barrel)

**Signature:** `(targetMs: number, contributions: ActivityEffectContribution[], resetTimeMs: number, nowMs?: number) => number`

The optional 4th argument `nowMs` (default: `Date.now()`) was added in v4.8 so chart consumers can pass their reference "now" timestamp. This enables correct back-scaling for historical chart points inside an active session and the C⁰-continuous future ramp (v4.10).

**Model:**
```
During session (targetMs ≤ nowMs — historical):
  effectAtTarget = cumulative_bg_effect × (fracAtTarget / fracAtNow)
  (back-scales from the delivered amount at nowMs, not the eventual fullEffect)

During session (targetMs > nowMs — future):
  effectAtTarget = cumulative_bg_effect + fracIntoFuture × (fullEffect − cumulative_bg_effect)
  (two-segment ramp, C⁰-continuous at nowMs — v4.10)

Post-session (targetMs > endMs):
  LOCKED at fullEffect permanently — unconditional, regardless of nowMs (v4.13)
```

A BG drop from exercise is a real physiological shift that persists until the daily reset. This is the correct model for the cumulative green line and the `activityDeltaSinceReading` calculation.

**Chart consumers (EVC, BGV) MUST pass their chart-generation "now" timestamp as `nowMs`.** Point-in-time hooks (AED, `useActiveEffects`) evaluate at actual "now" — they can rely on the default `Date.now()`.

**Call-sites:**

| Consumer | `targetMs` | `contributions` | `resetTimeMs` | `nowMs` |
|---|---|---|---|---|
| `useActiveEffects.ts` | `latestReading.timestamp as number` | `activityPD?.activity_contributions ?? []` | `_lastResetMs` | *(default `Date.now()`)* |
| `ActiveEffectsDisplay.tsx` | `parseUTCMs(bloodSugarTimestamp ?? timestamp)` | `activityContributions` | `lastResetMs` | *(default `Date.now()`)* |
| `EffectsVisualizationChart.tsx` | `targetTimestamp` | `activityContributions` | `resetTimeMs` | chart-generation `now` timestamp (required) |
| `BloodGlucoseVisualization.tsx` | `targetTimestamp` | `activityContributions` | `resetTimeMs` | chart-generation `now` timestamp (required) |

**This is not `calculateActivityEffectAtTime`** (the teal instantaneous-rate line). The two functions have different physics and different signatures:

| Function | Location | Physics | Signature |
|---|---|---|---|
| `calculateActivityEffectForCumulative` | `@/utils/calculations` shared | Lock-in: ramp then flat; `nowMs` back-scaling | `(targetMs, contributions, resetTimeMs, nowMs?)` |
| `calculateActivityEffectAtTime` (EVC) | EVC local | Z-state: `exp(−postExerciseMs / τ_Z)` | `(targetMs, contributions, tauWMs, resetTimeMs?)` |
| `calculateActivityEffectAtTime` (BGV) | BGV local | Z-state: `exp(−postExerciseMs / τ_Z)` — identical to EVC | `(targetMs, contributions, tauWMs, resetTimeMs?)` |

### 8.3 `calculateNetEffect` wrapper — current usage

The wrapper in `net-effect.ts` accepts `activityPD` as an optional 7th argument that adds `cumulativeActivityEffect` to `estimatedBG` when provided.

**`useActiveEffects` calls the wrapper with 6 arguments only.** Activity is applied manually afterward as `activityDeltaSinceReading`. The reason: `calculateStableBaselineFromReading` (dynamic mode) unwinds meal and insulin effects at the reading timestamp but does NOT unwind the activity effect. The activity contribution at the reading moment is therefore already baked into `stableBaseline`. Passing the full `cumulativeActivityEffect` to the wrapper would double-count the portion delivered before the reading was taken.

**AED calls the wrapper with activityPD as the 7th argument** — but only for computing `trend` and `safetyStatus`. AED builds `estimatedBG` independently using the same delta pattern as `useActiveEffects`.

**Preset mode exception:** In preset mode the baseline is derived from the circadian profile (not a reading), so no portion of the activity effect is baked into the baseline. The hook adds the FULL `cumulativeActivityEffect` directly — no delta subtraction.

The wrapper's JSDoc includes a `⚠️ DOUBLE-COUNT WARNING`: when `activityPD` is passed as the 7th argument, the `estimatedBG` in the return value already includes `cumulativeActivityEffect`. Downstream consumers must not add it again. A `⚠️ 7TH-ARGUMENT PATH IS CURRENTLY DEAD CODE` section documents why, alongside `@example` blocks for correct dynamic, correct preset, and incorrect double-count patterns.

### 8.4 `usePatientConstants` — implementation details

All four components receive `PatientConstants` via this hook. Key behaviours:

**Doctor/admin guard:** Skips all auto-loading for `user.user_type === 'doctor'` or `'admin'`, preventing 403 errors.

**TTL-based staleness (5 min):** Module-level `lastFetchedAt` timestamp. Fetches when `lastFetchedAt === 0` (never fetched) or stale (> 5 min). Replaces the previous `!constants` guard that blocked all refreshes after the first fetch.

**AppState foreground refresh:** On `background`/`inactive`, `lastFetchedAt` resets to 0. On `active`, `loadConstants()` fires silently. This is the primary fix for "doctor updates constants → patient sees stale values".

**`hasLoadedFromAPI` flag:** `false` while the hook is serving `DEFAULT_PATIENT_CONSTANTS` as a placeholder. `true` after the first successful `loadConstants()`. Components must gate PK calculations on this flag to prevent a wrong-baseline-mode flash on first render:
```typescript
const { constants, isLoading, hasLoadedFromAPI } = usePatientConstants();
useEffect(() => {
  if (isLoading || !hasLoadedFromAPI) return;
  startCalculation(constants);
}, [isLoading, hasLoadedFromAPI, constants]);
```

---

## §9 Cross-Arm References

### What Arm 3 owns

- All React components and hooks in the visualization layer.
- `calculateActivityEffectAtTime` — local to EVC and BGV (Z-state exponential decay for the teal rate line). Identical implementation in both files. Not exported from `@/utils/calculations`.
- `calculateSensitivityMultiplierAtTime` — local to EVC and BGV (W-state plateau + decay for ISF/CR boost). Identical implementation in both files. Not exported from `@/utils/calculations`.
- `useGlucoseBuffer` — exported from `useBloodGlucoseEstimation.ts`; shared by BGV and BGC.
- `activityDeltaSinceReading` logic — implemented independently in `useActiveEffects` and `ActiveEffectsDisplay` using the same formula.

### What Arm 3 delegates to Arm 2

- `calculateActivityEffectForCumulative` — single canonical implementation in `@/utils/calculations`. All four consumers import from this location.
- `calculateTotalCumulativeEffects` — `@/utils/calculations`.
- `calculateNetEffect` — `@/utils/calculations/net-effect`.
- `calculateStableBaselineFromReading`, `sanitizeBaseline` — `@/utils/calculations/baseline`.
- `calculateStackedMealEffect`, `calculateStackedInsulinEffect`, `calculateStackedInsulinChartEffect` — Arm 2.
- `applyInsulinCumulativeFloor` — `@/utils/calculations/cumulative-effects`. EVC and BGV import and call this after their chart point arrays are built.

### What Arm 3 delegates to Arm 1

- `SHARED_CONSTANTS`, `MEAL_ABSORPTION_PROFILES`, `getCircadianBaseline`, `getCumulativeLookbackHours` — `@/constants/shared-constants`.
- ODE model parameters (`tau_Z`, `tau_W`, `max_sensitivity_boost`, `INTENSITY_PEAK_BOOST`) — all sourced from `SHARED_CONSTANTS`; never hardcoded in Arm 3.

### `allMealsInWindow` lower-bound comparison

| Component | Lower bound | Notes |
|---|---|---|
| AED | `mealMs >= lastResetMs` (today only) | Fixed 24h window — always correct |
| EVC | `Math.min(rangeStart, earliestResetMs)` | `earliestResetMs` computed at `min(rangeStart, now)` |
| BGV | `Math.min(rangeStart, getLastResetTimeMs(new Date(min(rangeStart, now)), ...))` | Most defensive — anchored at rangeStart's date, not current date |

---

## §10 Developer Rules

**Rule 1.** `calculateActivityEffectForCumulative` must always be imported from `@/utils/calculations`. Never redeclare it locally in any visualization file. All four consumers share the single canonical implementation.

**Rule 2.** `calculateTotalCumulativeEffects` must never receive the `activities` argument in any chart or hook file. The activity term is always added manually afterward via `calculateActivityEffectForCumulative`. Passing both double-counts the effect.

**Rule 3.** `INTENSITY_PEAK_BOOST` must never be declared as a local constant in EVC or BGV. It must always be read as `(SHARED_CONSTANTS as any)?.INTENSITY_PEAK_BOOST ?? { light: 0.10, moderate: 0.25, vigorous: 0.40 }`. Same applies to `MAX_BOOST` (`HR_MODEL.max_sensitivity_boost ?? 0.60`).

**Rule 4.** `TAU_W_MIN` in both EVC and BGV must use the key `HR_MODEL.tau_W` (capital W), not `HR_MODEL.tau_w`. The wrong casing returns `undefined` and falls back to the default silently — correct now, but would diverge if a patient-specific `tau_W` is ever introduced.

**Rule 5.** `activityPD` must NOT be passed as the 7th argument to `calculateNetEffect` inside `useActiveEffects.calculateEffects()`. The activity effect is applied manually as `activityDeltaSinceReading` to avoid double-counting the portion already baked into `stableBaseline`.

**Rule 6.** In `ActiveEffectsDisplay.fetchAndCalculate()`, `activityPD` IS passed as the 7th argument to `calculateNetEffect` — but only to compute `trend` and `safetyStatus`. The `estimatedBG` in AED is built from the bank-balance formula directly, not from `calculateNetEffect.estimatedBG`.

**Rule 7.** The post-exercise τ_W (90-min) plateau applies exclusively to `calculateSensitivityMultiplierAtTime`. It must not appear in `calculateActivityEffectAtTime`. The acute BG-lowering signal (teal line) uses Z-state (τ_Z ≈ 10 min) immediate exponential decay with no plateau.

**Rule 8.** `insulinImpactBase` is computed using the base `correctionFactor` only. The sensitivity multiplier is applied post-hoc: `insulinImpactBoosted = insulinImpactBase × sensitivityMultiplierAtTime`. Do not also pass `effectiveCF` into `calculateStackedInsulinChartEffect` — that would square the multiplier.

**Rule 9.** Chart components (`EVC`, `BGV`) must call `useActiveEffects` with `skipIobCutoff: true`. They re-filter doses per chart point via `cumulativeWindowStart`. The 48-hour pre-filter is redundant and harmful for multi-day views.

**Rule 10.** `activeEffectsOptions` passed to `useActiveEffects` in chart components must be computed via `useMemo`, never as an inline object literal. An inline object creates a new reference on every render, causing `useActiveEffects` to re-register its interval loop.

**Rule 11.** `allMealsInWindow` lower bound for EVC and BGV must be `min(rangeStart, earliestResetMs)` — not `lastResetMs` anchored to the current time. Using a now-anchored reset drops all historical meals in multi-day views, flattening the cumulative green line for every past day.

**Rule 12.** `calculateTotalCumulativeEffects` Phase 3 (fully absorbed) always uses the base `correction_factor`. The `overrideCorrectionFactor` (effective CF) applies only to Phases 1 and 2. Passing `effectiveCFForCumulative` as the 9th arg does not affect Phase 3 — this is enforced internally since v4.5.

**Rule 13.** `useGlucoseBuffer` is the single shared glucose fetch hook for BGV and BGC. Do not inline a separate glucose fetch inside either chart component.

**Rule 14.** `calculateBaselineFromData` inside `useBloodGlucoseEstimation` reads `baselineModeRef.current`, not a closed-over const. The ref is updated on every render. Do not convert this to a plain variable.

**Rule 15.** All components that gate calculations on `usePatientConstants()` must also check `hasLoadedFromAPI` before running, not just `isLoading`. Without this guard, the wrong baseline mode flashes on first render while `DEFAULT_PATIENT_CONSTANTS` is still the active data.

**Rule 16.** When `ActiveEffectsDisplay` and `EffectsVisualizationChart` are both mounted on the same screen, the parent must own one `useActiveEffects()` call and pass `activityPDResult` as a prop to both components. This prevents three simultaneous ODE endpoint calls per 60-second poll cycle.

**Rule 17.** When `BloodGlucoseVisualization` is mounted alongside other components on a screen that already calls `useActiveEffects()`, pass the result as the `activityPD` prop. BGV's dedicated `useEffect` triggers `generateChartData()` immediately when the prop reference changes, keeping EVC and BGV in the same render cycle.

**Rule 18.** `correction_factor` defaults must use `40`, never `50`. All fallbacks in Arm 3 that reference correction factor must use `constants.correction_factor ?? 40`.

**Rule 19.** The insulin endpoint `GET /api/insulin-data` only accepts the `days` query parameter. Never pass `start` / `end` — they are silently ignored. Always compute `days = ceil((windowHours + 8) / 24) + 1`.

**Rule 20.** `SYNTHETIC_TAU_Z = 15` and `ACUTE_RATE_PER_MIN = 0.15 mg/dL/min` in EVC are visual-display approximations for historical synthetic sessions only. They are not sourced from `HR_MODEL` / `SHARED_CONSTANTS` and must not be used in any dose calculation path. If `tau_Z` is re-tuned in `HR_MODEL`, update `SYNTHETIC_TAU_Z` manually to match.

**Rule 21. Forms that co-mount with `ActiveEffectsDisplay` must receive the live PK snapshot via the `liveActiveEffects` prop.** Wire up `onEffectsComputed` at the screen level:
```typescript
const [aedSnapshot, setAedSnapshot] = useState<ActiveEffectData | null>(null);
<ActiveEffectsDisplay onEffectsComputed={setAedSnapshot} />
<MealForm liveActiveEffects={aedSnapshot ?? undefined} />
```
Omitting this wiring means the form uses a stale `getActiveEffectsFull()` estimate for MOB, IOB, and `estimatedBG` while AED shows a fresher value — the panel discrepancy this prop was designed to eliminate.

**Rule 22. Never pass `null` to `activityPDResult` until the parent's `useActiveEffects` has completed its first fetch.** `null` is the sentinel for "fetched, no active sessions today" and short-circuits the ODE call to zero. Use `lastUpdate ? activityPDResult : undefined` as the prop expression — `undefined` causes AED to self-fetch, not skip.

**Rule 23. `ActiveEffectData` and `AobIndirectEffects` must be imported from `@/types/active-effects.types`.** Do not redeclare them in AED or in any form component. The type file is the single source of truth; a local copy silently drifts from the emitter type without a compile error.

---

## §8-A `hooks/useTimeSyncValidation.ts`

**File:** `mobile/hooks/useTimeSyncValidation.ts`  
**Purpose:** Diagnostic validation hook. Compares client-computed elapsed-time values against the `hours_elapsed` / `hours_since_dose` fields that the backend calculated at the moment of its API response, surfacing any timezone or clock-skew discrepancy to the developer console.

### 8-A.1 Problem statement

Both MOB and IOB values depend on elapsed time: how many hours ago a meal was eaten, or how many hours ago a dose was administered. The backend stamps these durations at response time; the client independently derives them from the same ISO-8601 timestamps by computing `(now − eventTime) / 3,600,000`.

If the device's timezone offset is misapplied — for example, if a UTC timestamp is inadvertently interpreted as local time, or a local timestamp is double-offset by both the device and a parsing helper — the two elapsed-time values diverge silently. The divergence does not surface as an error; MOB and IOB simply appear smaller or larger than they should, distorting the estimated BG.

`useTimeSyncValidation` detects this divergence at runtime and logs a structured report before any chart or display component consumes the data.

### 8-A.2 Inputs

```typescript
useTimeSyncValidation(
  mobData: MealOnBoardResponse | null,
  iobData: ActiveInsulinResponse | null,
): void
```

The hook has no return value and produces no state; it is a pure side-effect hook that runs inside `useEffect` whenever `mobData` or `iobData` changes. It is safe to add to any component that already holds both responses.

### 8-A.3 Validation logic

For each `MealOnBoardResponse.contributions` item:

```
backendHours = contrib.hours_elapsed            // backend-stamped elapsed time
clientHours  = (now − new Date(contrib.meal_time)) / 3_600_000
discrepancy  = |backendHours − clientHours|

if discrepancy > 0.1 h (6 min) → push TimeSyncIssue
```

For each `ActiveInsulinResponse.insulin_contributions` item:

```
backendHours = contrib.hours_since_dose         // backend-stamped elapsed time
clientHours  = (now − new Date(contrib.taken_at)) / 3_600_000
discrepancy  = |backendHours − clientHours|

if discrepancy > 0.1 h (6 min) → push TimeSyncIssue
```

The 6-minute threshold absorbs normal HTTP round-trip latency. Genuine timezone problems produce discrepancies of 60 min or more (whole-hour offsets), so false positives are rare in practice.

### 8-A.4 `TimeSyncIssue` shape

```typescript
interface TimeSyncIssue {
  type:                'MOB' | 'IOB';
  itemType:            string;    // meal_type or medication name
  timestamp:           string;    // ISO-8601 UTC of the event
  backendHours:        number;    // hours elapsed per backend
  clientHours:         number;    // hours elapsed per client clock
  discrepancyMinutes:  number;    // |backendHours − clientHours| × 60
}
```

### 8-A.5 Console output

When issues are detected the hook emits to `console.error`:

1. One line per affected item: type, label, timestamp, both elapsed values, and discrepancy in minutes.
2. A summary banner listing total count split by `MOB` / `IOB`.
3. A four-step troubleshooting checklist: device timezone settings → `TimeManager.parseTimestamp()` implementation → double-offset application → backend UTC generation.
4. A `console.table` of all `TimeSyncIssue` records.

No in-app UI is rendered; the hook is a developer diagnostic only.

### 8-A.6 Auxiliary exports

| Export | Signature | Purpose |
|---|---|---|
| `validateTimestamp` | `(timestamp, expectedHoursAgo) → { valid, discrepancyMinutes }` | One-shot check for unit tests and manual ad-hoc validation |
| `getTimezoneDebugInfo` | `() → { localTime, utcTime, timezoneName, timezoneOffset, timezoneString }` | Dumps the device's resolved timezone for inclusion in bug reports |

### 8-A.7 Interaction with `TimeManager.ts` (cross-reference Arm 1 §2.2)

`useTimeSyncValidation` and `TimeManager.ts` occupy different layers and must not be confused:

- `TimeManager.ts` (Arm 1 §2.2) is the authoritative timestamp parser and reset-time arithmetic engine. It converts raw API strings into milliseconds-since-epoch and is the sole correct path for any calculation that depends on a timestamp value.
- `useTimeSyncValidation` is a passive diagnostic. It uses plain `new Date(isoString)` to compute elapsed time independently, then compares the result against the backend's own pre-computed duration. It does not replace `TimeManager.ts`; it verifies that the rest of the pipeline (including `TimeManager`) is not misinterpreting timestamps.

If `useTimeSyncValidation` reports a discrepancy, the investigation should start at `TimeManager.parseTimestamp()` — not at `useTimeSyncValidation` itself. See §10 Rule 23 for the enforcement boundary.

### 8-A.8 Exposure to chart components

`useTimeSyncValidation` exposes nothing to chart components. It has no return value and does not write to any store or context. Chart components — EVC, BGV, BGC, AED — do not import it; it should be added one level above them (e.g. in the screen that fetches MOB/IOB data) so the validation fires once per data refresh cycle, not once per chart render.

---

## §8-B `store/patient.store.ts`

**File:** `mobile/store/patient.store.ts`  
**Purpose:** Zustand store that loads, caches, and exposes `PatientConstants` to the rest of the application. This is the backing store that `usePatientConstants` (§8.4) reads from; understanding the store's two-phase loading and TTL behaviour is required to reason about the `isLoading` / `hasLoadedFromAPI` guards that gate all PK calculations in Arm 3.

### 8-B.1 Zustand state shape

```typescript
interface PatientState {
  // ── Data ─────────────────────────────────────────────────────────────────────
  constants:           PatientConstants | null;
  activeConditions:    string[];
  activeMedications:   string[];
  medicationSchedules: Record<string, {
    id:         string;
    startDate:  string;
    endDate:    string;
    dailyTimes: string[];
  }>;

  // ── Loading meta ──────────────────────────────────────────────────────────────
  isLoading:    boolean;
  error:        string | null;
  lastFetched:  number | null;   // epoch ms of last successful API response

  // ── Actions ───────────────────────────────────────────────────────────────────
  loadConstants:  () => Promise<void>;
  updateConstants:(constants: Partial<PatientConstants>) => Promise<void>;
  getConstant:    <K extends keyof PatientConstants>(key: K) => PatientConstants[K];
  clearConstants: () => void;
}
```

`constants` starts as `null`. It transitions through: `null` (before mount) → cached value from disk (Phase 1, within the same `loadConstants` call) → server value (Phase 2). `isLoading` remains `true` across both phases until Phase 2 settles; see §8-B.3.

### 8-B.2 How `usePatientConstants` reads from the store (cross-reference §8.4)

`usePatientConstants` (§8.4) sits above `usePatientStore` and wraps it with the doctor/admin guard, the `hasLoadedFromAPI` flag, and the AppState foreground-refresh trigger. The relationship is:

```
usePatientConstants (§8.4)
  ├── reads:  usePatientStore().constants
  ├── reads:  usePatientStore().isLoading
  ├── reads:  usePatientStore().error
  ├── calls:  usePatientStore().loadConstants()  on mount and on foreground transition
  └── owns:   hasLoadedFromAPI flag (module-level, true after first successful loadConstants)
              lastFetchedAt    flag (module-level, drives 5-min TTL in the hook layer)
```

The hook does not expose the store's `lastFetched` field directly; it maintains its own `lastFetchedAt` timestamp for TTL decisions. `lastFetched` in the store is persisted to disk as part of the cache blob and is used only by Phase 1 to determine cache freshness on the next mount.

`getConstant<K>(key)` is a convenience selector that returns `constants[key]` when available and falls back to `DEFAULT_PATIENT_CONSTANTS[key]`. Arm 3 components do not call it directly — they receive the full `PatientConstants` object from `usePatientConstants()` and read fields directly.

### 8-B.3 Two-phase loading and `isLoading` semantics

`loadConstants()` runs two sequential phases inside a single async function. `isLoading` is `true` for the entire duration unless Phase 1 finds a **fresh** cache hit.

**Phase 1 — Synchronous cache read:**

`storage.getJSON(STORAGE_KEYS.PATIENT_CONSTANTS)` is awaited. If a cached blob is found and its `lastFetched` timestamp is within 5 minutes of `Date.now()`:

- `constants`, `activeConditions`, `activeMedications`, `lastFetched` are written to state.
- `isLoading` is set to `false`.
- `loadConstants` returns early — Phase 2 is skipped.

If the cache exists but is stale, state is populated with the cached values but `isLoading` stays `true` and Phase 2 proceeds. This eliminates the `null → DEFAULT → server` three-render flash: the UI sees a non-null `constants` immediately while the network call is in flight.

**Phase 2 — Network fetch:**

`apiClient.get(API.PATIENT.CONSTANTS)` is awaited. On success, the fresh data replaces the cached data in both memory and disk, and `isLoading` is set to `false`.

On failure:

| Cache state after Phase 1 | Outcome |
|---|---|
| Cache was populated (`hasCachedConstants = true`) | `isLoading → false`, `error → 'Using cached data — failed to reach server'`. Cached constants remain active. |
| No cache (`hasCachedConstants = false`) | `constants → DEFAULT_PATIENT_CONSTANTS`, `isLoading → false`, `error → message`. Prevents infinite loading on first install with no network. |

**Consequence for Arm 3 components:** The `isLoading || !hasLoadedFromAPI` guard in §8.4 blocks PK calculations until Phase 2 completes (or the cache-fresh early-exit of Phase 1), ensuring no calculation ever fires against `DEFAULT_PATIENT_CONSTANTS` values. The two-phase design means this block is short-lived on repeat launches — Phase 1 fills `constants` from disk before the guard even checks.

### 8-B.4 TTL invalidation and AppState foreground refresh

The 5-minute TTL is enforced at two separate layers that must remain consistent with each other.

**Store layer (`patient.store.ts`):** `lastFetched` is the epoch-ms timestamp written to the cache blob on every successful Phase 2 response. Phase 1 uses it to decide whether the cache is fresh (`Date.now() − lastFetched < 5 × 60 × 1000`). The store itself has no AppState listener; TTL decisions within the store are driven only by the value on disk.

**Hook layer (`usePatientConstants`, §8.4):** Maintains a module-level `lastFetchedAt` (separate from the store's `lastFetched`). On foreground transition (`active`), the hook resets `lastFetchedAt` to 0 before calling `loadConstants()`, forcing Phase 2 to run regardless of the on-disk `lastFetched`. This mirrors the TTL reset behaviour documented in §8.4 and is the primary mechanism by which a doctor's constant update reaches the patient device promptly.

```
AppState → 'background' / 'inactive'
  └── usePatientConstants: lastFetchedAt = 0

AppState → 'active'
  └── usePatientConstants: loadConstants()
        ├── Phase 1: reads disk cache (may be < 5 min old → skips Phase 2)
        └── Phase 2 (if stale): fetches from API → updates store + disk
```

Because `lastFetchedAt` in the hook is reset to 0 on background — not on foreground — a device that goes to background and returns immediately will still trigger a Phase 2 fetch even if the cache is only seconds old. This is intentional: background transitions are the primary vector for a clinician to push constant updates.

**Invariant (cross-reference §8.4):** The store's Phase 1 5-minute freshness window and the hook's `lastFetchedAt` TTL must always use the same threshold (`5 × 60 × 1000 ms`). See §10 Rule 21.

### 8-B.5 `updateConstants` — local-only path

`updateConstants(partial)` merges `partial` into the current constants and writes the result to disk, but **does not call any API endpoint** (the API endpoint is not yet implemented — a `// TODO` comment marks the gap). Changes made via `updateConstants` persist only for the lifetime of the cache until the next successful Phase 2 fetch overwrites them. This path is intended for patient-side preference overrides; it is not the mechanism for clinician-prescribed constant changes.

### 8-B.6 `clearConstants`

Removes the cached blob from `storage` and resets all fields to their initial values, including `constants → null`. After `clearConstants`, the next `loadConstants()` call will have no Phase 1 cache and will apply `DEFAULT_PATIENT_CONSTANTS` as a last-resort fallback only if Phase 2 also fails. Used during logout.

---

## §10 Developer Rules (continued)

**Rule 21.** The Phase 1 cache-freshness threshold in `patient.store.ts` (`Date.now() − lastFetched < 5 × 60 × 1000`) and the hook-layer TTL in `usePatientConstants` must always use the same 5-minute value. If the threshold is changed in one file it must be changed in both. A mismatch causes Phase 1 to skip a fetch that the hook considers stale (or vice versa), defeating the "doctor updates constants → patient sees them promptly" guarantee.

**Rule 22.** `patient.store.ts`'s Phase 1 populates `constants` with cached data but leaves `isLoading: true` whenever the cache is stale. Do not interpret a non-null `constants` as proof that loading is complete. The `isLoading` flag and `hasLoadedFromAPI` (in `usePatientConstants`) are the correct signals to gate PK calculations — not the nullability of `constants`.

**Rule 23.** `useTimeSyncValidation` must not be used as a substitute for correct timestamp parsing elsewhere in the pipeline. If the hook reports a discrepancy, the fix belongs in `TimeManager.parseTimestamp()` (Arm 1 §2.2) or in whichever utility is constructing the timestamp — not in `useTimeSyncValidation` itself, and not by adjusting elapsed-time thresholds within the hook. The hook is a diagnostic instrument, not a correction mechanism.

**Rule 24.** `useTimeSyncValidation` must not be called inside chart components (EVC, BGV, BGC, AED). It should be mounted once at the screen level that owns the MOB and IOB fetch, so the validation fires once per data refresh cycle. Mounting it inside a chart component causes it to re-run on every chart re-render, flooding the console during normal operation.

**Rule 25.** The `updateConstants` action in `patient.store.ts` is a local-only write path with no backing API endpoint. Do not use it to propagate clinician-prescribed constant changes to the backend. All persisted constant updates from the clinical side arrive via the Phase 2 API fetch triggered by the AppState foreground-refresh cycle (§8-B.4). Using `updateConstants` for clinical data risks silent overwrite on the next foreground transition.

**Rule 26. `applyInsulinCumulativeFloor` must be called on every time-series chart's completed points array immediately before committing to React state.** This applies to any component that iterates `calculateTotalCumulativeEffects` (or `buildChartPoint`) across a time axis. Currently: EVC (after `generateChartData`) and BGV (after building its chart points). Omitting it causes the cumulative green line to exhibit a mountain shape during the post-exercise sensitivity window — deepening and then rising back up while doses are still absorbing.

**Rule 27. `applyInsulinCumulativeFloor` must NOT be called from point-in-time evaluators** (`useActiveEffects`, `useBloodGlucoseEstimation`, `ActiveEffectsDisplay.fetchAndCalculate`). Those evaluate at a single timestamp; the floor concept is only defined over a time-ordered sequence.

**Rule 28. `insulinBoostData` useMemo in EVC must maintain the `yFloor` running floor.** The useMemo must be a stateful loop, not a pure `.map()`. The floor resets when `|p.insulinImpactBaseDisplay| < 0.01` (no doses on board / daily reset boundary). Reverting to a pure `.map()` reintroduces the mountain-peak shape in the light-blue sensitivity-boost band.

**Rule 29. The `yFloor` in `insulinBoostData` is a display-only construct.** It operates on the `y` value fed to the victory-native VictoryArea component; it does not mutate `p.insulinSensitivityBoost`, `p.cumulativeInsulinEffect`, or any field of `EffectsChartPoint`. Mutating chart-point fields inside the `insulinBoostData` useMemo is a correctness violation.
---

## §11 Dashboard Screen (`app/(app)/(tabs)/index.tsx`)

**File:** `mobile/app/(app)/(tabs)/index.tsx`  
**Purpose:** Root dashboard tab. Coordinates the three chart components (BGC, EVC, BGV) and `ActiveEffectsDisplay` and owns the screen-level data fetch.

### Changes introduced in v4.14

This revision introduces four fixes that reduce the per-minute API call count from 4× to approximately 1× for the default 24h dashboard view.

#### Fix 1 — Dead props removed from `ActiveEffectsDisplay`

The component was called with 8 props that no longer exist in its interface:
`iobData`, `mobData`, `estimatedBG`, `timingAssessment`, `correctionFactor`, `isLoading`, `compact`, `onRefresh`.

React silently drops unknown props, so `ActiveEffectsDisplay` was ignoring everything the screen computed and running its own independent 60-second fetch loop regardless. The actual interface has exactly one prop: `activityPDResult?: ActivityPDResult | null`. This is now the only prop passed.

#### Fix 2 — Duplicate fetch loops eliminated (Phase 2)

Before this change, the dashboard fired on every 60-second tick:
- `ActiveEffectsDisplay.fetchAndCalculate` → meals + insulin + blood-sugar + activityPD
- `useActiveEffects` (EVC) → meals + insulin + blood-sugar + activityPD
- `useActiveEffects` (BGV) → meals + insulin + blood-sugar + activityPD
- `loadDashboardData` → meals + insulin + MOB + timing

Phase 1 fix (previous revision) lifted `useActiveEffects` to screen level and passed `activityPDResult` as a prop to all three components, reducing ODE calls from 3 to 1.

Phase 2 fix (this revision):
- `meals` and `insulinDoses` are now destructured from the screen-level `useActiveEffects` and passed as props to `ActiveEffectsDisplay`. When both arrays are provided, `fetchAndCalculate()` skips `GET /api/meals-only` and `GET /api/insulin-data` entirely.
- The same props are passed to `EffectsVisualizationChart` for the default 24h view. EVC uses the props directly as `rawMeals`/`rawInsulin` and skips its internal fetch when `windowHours` matches the screen-level window. **EVC re-fetches for 3D/7D views** — these require a wider window than the 24h data owned by the screen; this is by design.

Result: duplicate meals + insulin fetches per minute: **3 → 1** for the default 24h dashboard view.

#### Fix 3 — Dead state and dead fetches removed

`activeInsulin`, `mealOnBoard`, and `mealTiming` were only used to populate the now-removed dead props. Their fetch calls (`getActiveDoses`, `getMealOnBoard`, `getMealTimingAssessment`) are also removed. `loadDashboardData` now only fetches the 5 most-recent meal summaries for `<RecentMeals>`.

#### Fix 4 — `useFocusEffect` now triggers `activeEffects.refresh()`

Previously only `loadDashboardData` + `refreshBGEstimation` ran on screen focus. The screen-level `useActiveEffects` was never told to refresh when the user navigated back from meal/insulin/activity logging screens, so the charts showed stale data after logging a new event. `activeEffects.refresh()` is now called inside `useFocusEffect`.

### Fetch topology after v4.14 (default 24h view, per 60-second cycle)

| Fetch | Owner | Count |
|---|---|---|
| Meals | screen-level `useActiveEffects` | 1 |
| Insulin | screen-level `useActiveEffects` | 1 |
| Blood sugar | screen-level `useActiveEffects` | 1 |
| Activity PD (ODE) | screen-level `useActiveEffects` → prop to AED/EVC/BGV | 1 |
| Recent meal summaries | `loadDashboardData` | 1 |
| **Total** | | **5** (was ~16) |

### Developer rules (Dashboard screen)

**DR-Dashboard-01.** `ActiveEffectsDisplay` accepts exactly four props: `activityPDResult?`, `meals?`, `insulinDoses?`, and `onEffectsComputed?`. Do not pass `iobData`, `mobData`, `estimatedBG`, `timingAssessment`, `correctionFactor`, `isLoading`, `compact`, or `onRefresh` — they do not exist in the interface and are silently dropped by React.

Pass `onEffectsComputed={setAedSnapshot}` on any screen that also renders `MealForm`, `UnifiedInsulinInput`, or `QuickMealForm`, so those forms receive the same live PK snapshot AED computed rather than running a stale `getActiveEffectsFull()` call. See §5.1.

**DR-Dashboard-02.** When `meals` and `insulinDoses` are both passed as props to `ActiveEffectsDisplay`, the component's internal `fetchAndCalculate()` skips the meals and insulin API calls. **Both** props must be provided to activate this optimisation; passing only one has no effect.

**DR-Dashboard-03.** `EffectsVisualizationChart` ignores `meals`/`insulinDoses` props and re-fetches internally for 3D/7D views that require a wider window than the screen's 24h data. This is intentional and must not be changed — the parent screen does not maintain a multi-day data buffer.

**DR-Dashboard-04.** `activeEffects.refresh()` must be called from `useFocusEffect` so charts update after the user navigates back from logging screens. Removing this call reintroduces stale-data display post-logging.
