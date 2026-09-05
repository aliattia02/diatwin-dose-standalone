# Dual Baseline System — Technical Documentation

**Project:** DiaTwin Mobile (native3/mobile)
**Primary consumer:** `ActiveEffectsDisplay.tsx`
**Last updated:** 2026-05 — covers `hasLoadedFromAPI`, `classifyResidual`, mode-badge baseline value, lock-in activity delta, two-phase store load, console-spam removal, **audit fix (Goal 4):** `calculateNetEffect` Step 9 now passes `activityPD` so trend arrow is exercise-adjusted, **audit fix (Goal 5):** `EffectsVisualizationChart.generateChartData` gated on `hasLoadedFromAPI` to prevent renders with default constants

---

## Table of Contents

1. [What is the Baseline?](#1-what-is-the-baseline)
2. [Two Modes](#2-two-modes)
3. [The Daily Reset Window](#3-the-daily-reset-window)
4. [Dynamic Mode](#4-dynamic-mode)
5. [Preset / Circadian Mode](#5-preset--circadian-mode)
6. [Estimated BG Assembly (Both Modes)](#6-estimated-bg-assembly-both-modes)
7. [Projected Final BG](#7-projected-final-bg)
8. [Data Flow Diagram](#8-data-flow-diagram)
9. [Patient Constants Lifecycle](#9-patient-constants-lifecycle)
10. [ActiveEffectsDisplay — Render Guards](#10-activeeffectsdisplay--render-guards)
11. [Reading-Residual Alert System](#11-reading-residual-alert-system)
12. [Activity PD Integration (AOB)](#12-activity-pd-integration-aob)
13. [What ActiveEffectsDisplay Shows](#13-what-activeeffectsdisplay-shows)
14. [Component Features & Patient Value](#14-component-features--patient-value)
15. [Mode Separation Analysis](#15-mode-separation-analysis)
16. [Mode Selection Guide](#16-mode-selection-guide)
17. [Configuration Reference](#17-configuration-reference)
18. [Key Invariants](#18-key-invariants)
19. [Files Reference](#19-files-reference)

---

## 1. What is the Baseline?

The *stable baseline* is the estimated blood glucose value the patient would have if every meal and every insulin dose they logged today had already fully resolved — in other words, their effective fasting level for the current daily window.

It is the anchor point of the bank-balance BG model:

```
estimatedBG = stableBaseline
            + cumulativeNetBaseline   (Σmeal − Σinsulin since reset)
            + activityDeltaSinceReading
           [+ readingResidual          — preset mode only]
```

Without an accurate baseline, every downstream number — estimated BG, projected final BG, safety status, trend — drifts proportionally. The entire Active Effects Display is only as trustworthy as its baseline.

---

## 2. Two Modes

The system implements two mutually exclusive strategies for determining the baseline, controlled by the `baseline_mode` field on `PatientConstants`:

| Mode | Value | Source |
|---|---|---|
| **Dynamic** | `'dynamic'` | Latest BG reading → unwind active effects → derive fasting BG |
| **Preset** | `'preset'` | Pre-loaded 24-hour circadian profile → look up current hour |

The mode is read in `ActiveEffectsDisplay.tsx` step 3b:

```typescript
const resolvedMode: 'dynamic' | 'preset' =
  (constants?.baseline_mode === 'preset') ? 'preset' : 'dynamic';
```

`'dynamic'` is the default when the field is absent or any other value. `DEFAULT_PATIENT_CONSTANTS.baseline_mode` is explicitly `"dynamic"`, so the default is unambiguous.

The mode choice persists across sessions because it lives on the server-stored `PatientConstants` object, loaded via `usePatientStore` / `usePatientConstants`.

---

## 3. The Daily Reset Window

Both modes operate within a *daily window* — only events logged after the most recent daily reset are considered. This prevents yesterday's meals and insulin from distorting today's baseline.

```typescript
// Step 3 in fetchAndCalculate()
const resetHour: number = constants?.daily_reset_hour ?? 7;      // default 7 AM
const tzOffset:  number = constants?.timezone_offset_minutes ?? 0;
const lastResetMs = getLastResetTimeMs(currentTime, resetHour, tzOffset);
```

`getLastResetTimeMs` computes the wall-clock UTC timestamp of the most recent `resetHour` occurrence in the patient's local timezone. If the patient is before 7 AM, `lastResetMs` points to yesterday's 7 AM; after 7 AM it points to today's 7 AM.

All meal and dose arrays are filtered against this boundary before any calculation runs:

```typescript
const allMealsInWindow = allMeals.filter(meal =>
  parseUTCMs(meal.timestamp) > lastResetMs
);
const allDosesInWindow = allDosesForCalc.filter(d =>
  parseUTCMs(d.administrationTime) > lastResetMs
);
```

> **Critical:** Both baseline and cumulative-effects functions receive `allMealsInWindow` / `allDosesInWindow`, not just still-absorbing events. Fully absorbed events must be included because their Phase 3 (persist-at-100%) contributions are still part of the cumulative sum.

---

## 4. Dynamic Mode

### 4.1 Concept

Dynamic mode derives the baseline by *reverse-engineering* a recent blood glucose reading:

```
stableBaseline = reading − cumulativeMealEffect(at reading time)
                          + cumulativeInsulinEffect(at reading time)
```

This "unwinds" whatever meals and doses were active at the exact moment the reading was taken, revealing the underlying fasting level.

### 4.2 Entry Point

```typescript
// Step 8 in fetchAndCalculate() — dynamic branch
if (resolvedMode !== 'preset' && recentReading?.bloodSugar) {
  frontendBaseline = calculateStableBaselineFromReading(
    {
      id:        String(recentReading._id ?? recentReading.id ?? ''),
      value:     recentReading.bloodSugar,
      timestamp: recentReading.bloodSugarTimestamp ?? recentReading.timestamp,
      userId:    'current',
      status:    recentReading.status,
      source:    'manual',
    },
    allMealsInWindow,
    allDosesInWindow,
    currentTime,
    constants,
    MEAL_ABSORPTION_PROFILES,
    resetHour,
    tzOffset,
    sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined,
  );
}
```

The function is imported from `@/utils/glucose/blood-glucose-estimation` (the canonical implementation) via the re-export wrapper in `@/utils/calculations/baseline`.

### 4.3 What the Function Does

`calculateStableBaselineFromReading` evaluates cumulative meal and insulin effects **at the reading's own timestamp** (not the current time). This is critical — it captures the pharmacodynamic state at the moment of measurement, not the state now.

The result object includes:

```typescript
{
  stableBaseline:          number,   // the derived fasting BG
  readingValue:            number,   // original reading
  cumulativeMealEffect:    number,   // BG raised by meals at reading time
  cumulativeInsulinEffect: number,   // BG lowered by insulin at reading time (negative)
  cumulativeNetEffect:     number,   // meal + insulin (net signed delta)
  mealsCount:              number,
  insulinCount:            number,
  confidence?:             number,
  warnings?:               string[],
}
```

### 4.4 Phase 3: Persist-at-100% (v4.4 fix)

Both `calculateMealCumulativeEffect` and `calculateInsulinCumulativeEffect` implement backend-matching Phase 3 behaviour: once a meal or dose has fully absorbed (hours since event ≥ PK duration), its BG contribution is locked at its maximum value and held there until the next daily reset.

This matches the backend Python exactly:

```python
# pharmacodynamics.py — meal
if current_time >= end_time:
    return total_carbs * carb_to_bg_factor   # PERSISTS

# pharmacodynamics.py — insulin
if current_time >= end_time:
    return -(dose_amount * correction_factor) # PERSISTS
```

Without this, the frontend would report zero contribution for absorbed events, producing a lower `cumulativeMealEffect` and therefore an *inflated* `stableBaseline` — which would propagate as a systematically high `estimatedBG`.

### 4.5 Post-exercise Correction Factor Override

When the activity PD model reports `sensitivityMultiplier > 1.005` (post-exercise GLUT4 upregulation is active), the effective correction factor from the backend is passed to `calculateStableBaselineFromReading`:

```typescript
sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined
```

This ensures the baseline unwind uses the same heightened ISF that was in effect when the reading was taken. The `1.005` threshold suppresses floating-point noise that would otherwise spuriously activate the override.

### 4.6 Sanitization (Clamping)

After `calculateStableBaselineFromReading` returns, the raw value is passed through `sanitizeBaseline()`:

| Condition | Action | Banner |
|---|---|---|
| `stableBaseline < 55 mg/dL` | Clamp to 55 | 🔴 "Baseline Capped" — likely unlogged insulin |
| `55–74 mg/dL` (passed, not clamped) | Pass through | 🟡 "Low Baseline Detected" soft warning |
| `55–220 mg/dL` | Pass through | None |
| `stableBaseline > 220 mg/dL` | Clamp to 220 | 🔴 "Baseline Capped" — likely unlogged meal |

These are hard limits from `BASELINE_HARD_MIN = 55` / `BASELINE_HARD_MAX = 220` in `shared-constants.ts`. There is no soft blending toward the circadian model. The raw pre-clamp value is preserved in `_rawBaselineValue` for display transparency.

### 4.7 No-reading Fallback

If there is no blood glucose reading in the current window, dynamic mode cannot derive a baseline. `frontendBaseline` remains `null` and the component falls back to `target_glucose`:

```typescript
const stableBaseline = frontendBaseline?.stableBaseline ?? targetGlucose;
// metadata.usingTargetFallback = !frontendBaseline
```

`usingTargetFallback = true` triggers the "Estimation Unreliable" banner with a checklist.

---

## 5. Preset / Circadian Mode

### 5.1 Concept

Preset mode bypasses all reading-based derivation and instead uses a clinically-modelled 24-hour circadian profile that captures expected population-level fasting BG across the day. This mode works even without a recent reading.

### 5.2 Default Circadian Profile

The default profile is defined in `SHARED_CONSTANTS.DEFAULT_CIRCADIAN_PROFILE` as 24 hourly anchor points (all in mg/dL):

| Hour | mg/dL | Hour | mg/dL | Hour | mg/dL |
|---|---|---|---|---|---|
| 00:00 | 90.0 | 08:00 | 120.0 | 16:00 | 100.0 |
| 01:00 | 88.0 | 09:00 | 115.0 | 17:00 | 102.0 |
| 02:00 | 87.0 | 10:00 | 108.0 | 18:00 | 100.0 |
| 03:00 | **85.0** ← nadir | 11:00 | 103.0 | 19:00 | 99.0 |
| 04:00 | 87.0 | 12:00 | 100.0 | 20:00 | 97.0 |
| 05:00 | 93.0 | 13:00 | 98.0 | 21:00 | 95.0 |
| 06:00 | 108.0 | 14:00 | 97.0 | 22:00 | 93.0 |
| 07:00 | **118.0** ← dawn rise | 15:00 | 97.0 | 23:00 | 91.0 |

Notable features: overnight nadir at 03:00 (85 mg/dL), dawn phenomenon rise peaking at 08:00 (120 mg/dL), midday trough around 13–15:00 (97–98 mg/dL), gentle evening taper.

A patient-specific override can be stored in `constants.circadian_profile.anchors` with `source: 'custom'`. If absent, the default profile is used.

### 5.3 Interpolation (`getCircadianBaseline`)

```typescript
export const getCircadianBaseline = (hourFloat: number, profile?: CircadianProfile): number => {
  const anchors = profile?.anchors ?? SHARED_CONSTANTS.DEFAULT_CIRCADIAN_PROFILE.anchors;
  if (!anchors || anchors.length === 0) return 100;

  const h = ((hourFloat % 24) + 24) % 24;   // normalise: handles midnight wraparound

  // Find the two bounding anchors
  let lower: CircadianAnchor | null = null;
  let upper: CircadianAnchor | null = null;
  for (const anchor of anchors) {
    if (anchor.hour <= h) lower = anchor;
    if (upper === null && anchor.hour > h) upper = anchor;
  }
  // Wraparound: if no lower, use last anchor; if no upper, use first anchor
  if (lower === null) lower = anchors[anchors.length - 1];
  if (upper === null) upper = anchors[0];

  let loH = lower.hour;
  let hiH = upper.hour;
  if (hiH < loH) hiH += 24;     // midnight wraparound (e.g. hour 23 → hour 0)
  if (loH === hiH) return lower.value;

  const t = (h - loH) / (hiH - loH);
  return Math.round((lower.value + t * (upper.value - lower.value)) * 10) / 10;
};
```

**Algorithm:** Linear interpolation between the two anchor points that bracket `hourFloat`, with midnight wraparound. Output is rounded to one decimal place.

**Example:** At 06:30 local time, `hourFloat = 6.5`. The bounding anchors are hour 6 (108.0) and hour 7 (118.0). `t = 0.5`, result = `108.0 + 0.5 × 10.0 = 113.0 mg/dL`.

### 5.4 Entry Point

```typescript
// Step 8 in fetchAndCalculate() — preset branch
if (resolvedMode === 'preset') {
  const offsetMs    = tzOffset * 60_000;
  const localDate   = new Date(currentTime.getTime() + offsetMs);
  const hourFloat   = localDate.getUTCHours() + localDate.getUTCMinutes() / 60;

  const circadianProfile = constants?.circadian_profile;
  const presetValue = getCircadianBaseline(hourFloat, circadianProfile ?? undefined);

  frontendBaseline = {
    stableBaseline:          presetValue,
    readingValue:            recentReading?.bloodSugar ?? presetValue,
    cumulativeMealEffect:    0,      // preset does not unwind events
    cumulativeInsulinEffect: 0,
    cumulativeNetEffect:     readingDelta ?? 0,
    mealsCount:              allMealsInWindow.length,
    insulinCount:            allDosesInWindow.length,
    _isPreset:               true,
    _hourFloat:              hourFloat,
    _readingDelta:           readingDelta,
    _circadianAtReading:     circadianAtReading,
    _cumulAtReadingNet:      cumulAtReadingNet,
  };
}
```

`cumulativeMealEffect` and `cumulativeInsulinEffect` on the baseline object are 0 in preset mode. The real cumulative terms come entirely from `correctedCumulative` in step 10.

**Mode badge hint:** `Profile at HH:MM · <value> mg/dL` — added in the latest update, makes the active baseline value unambiguous at a glance.

### 5.5 Additional Fields for Reading-Residual Correction

When a reading exists, the preset branch also computes:

**`_circadianAtReading`** — the circadian profile value at the reading's timestamp (not the current time):

```typescript
const readingHourFloat = localReadingDate.getUTCHours() + localReadingDate.getUTCMinutes() / 60;
circadianAtReading = getCircadianBaseline(readingHourFloat, circadianProfile ?? undefined);
```

**`_cumulAtReadingNet`** — the cumulative net baseline (meals − insulin) at the reading timestamp:

```typescript
const cumulAtReading = calculateTotalCumulativeEffects(
  allMealsInWindow,
  allDosesInWindow,
  new Date(readingMs),
  constants,
  MEAL_ABSORPTION_PROFILES,
  resetHour,
  tzOffset,
);
cumulAtReadingNet = cumulAtReading.cumulativeNetBaseline;
```

These two fields feed the reading-residual correction in step 10 (see §6.4) and are also used in the expanded formula strip in the UI.

---

## 6. Estimated BG Assembly (Both Modes)

After the baseline is established (step 8), steps 9–10 assemble `estimatedBG`.

### 6.1 Step 9 — Net Effect (trend and safety status only)

```typescript
// FIX (Goal 4 / audit): pass activityPD so trend arrow is exercise-adjusted.
// The net-effect.ts wrapper accepts exactly 7 params — activityPD is the 7th.
// resetHour / tzOffset are NOT params of this wrapper; it reads them from
// patientConstants internally. Previously resetHour was passed in the activityPD
// slot and tzOffset was a silent 8th arg, so trend never saw exercise data.
const frontendNetEffect = calculateNetEffect(
  frontendBaseline,
  allMealsInWindow,
  allDosesInWindow,
  currentTime,
  constants,
  MEAL_ABSORPTION_PROFILES,
  activityPDValid ? (activityPDData as ActivityPDResult) : null,
);
```

This call is used **exclusively** for `trend` and `safetyStatus` signal generation. The `estimatedBG` value it returns is NOT used in the final displayed number — it is superseded by the corrected calculation in step 10.

> **Coupling note (updated):** Both modes call `calculateNetEffect` identically. Since `activityPD` is now passed as the 7th argument, the trend arrow is exercise-adjusted and tracks `correctedEstimatedBG` more closely than before. The remaining divergence risk is only in the cumulative meal/insulin arithmetic (step 9 uses `_calculateNetEffect` internally; step 10 uses `calculateTotalCumulativeEffects`) — not in the activity term. If the two cumulative paths ever diverge, `trend` could reflect a subtly different BG than the card shows, but the exercise contribution will be consistent.

### 6.2 Step 10 — Corrected Cumulative Effects

```typescript
const correctedCumulative = calculateTotalCumulativeEffects(
  allMealsInWindow,
  allDosesInWindow,
  currentTime,
  constants,
  MEAL_ABSORPTION_PROFILES,
  resetHour,
  tzOffset,
  undefined,
  sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined,
);
```

`correctedCumulative.cumulativeNetBaseline` is the current net BG displacement from all today's meals and doses, evaluated at **now** (not the reading time).

### 6.3 Activity Delta Since Reading (Lock-In Model)

The activity PD model provides a signed `cumulative_activity_effect`. Adding the full value to `stableBaseline + Δcumulative` would double-count exercise that occurred before the most recent reading, because that exercise effect was already baked into the reading value.

**Previous implementation (binary check — replaced):**

The old code only excluded sessions whose full duration had elapsed before the reading. Sessions that were *active at reading time* contributed 0 to `activityEffectAtReading`, so the full `cumulative_bg_effect` was added as "new delta" even though part of it had already been delivered.

**Current implementation (lock-in model):**

```typescript
// calculateActivityEffectForCumulative() — lock-in model
function calculateActivityEffectForCumulative(
  targetMs: number,
  contributions: ActivityContribution[],
  resetTimeMs: number,
): number {
  let total = 0;
  for (const c of contributions) {
    const startMs = parseUTCMs(c.start_time);
    if (isNaN(startMs) || targetMs < startMs) continue;
    if (startMs < resetTimeMs) continue;        // daily reset guard

    const durationMs = (c.duration_minutes ?? 30) * 60_000;
    const endMs      = startMs + durationMs;
    const fullEffect = c.cumulative_bg_effect ?? 0;

    if (targetMs <= endMs) {
      // During session: linear ramp 0 → fullEffect
      const frac = (targetMs - startMs) / Math.max(durationMs, 1);
      total += frac * fullEffect;
    } else {
      // Post-session: lock in permanently at fullEffect
      total += fullEffect;
    }
  }
  return total;
}
```

Key properties:
- **Lock-in:** once a session ends, its `cumulative_bg_effect` is locked permanently — a BG drop from exercise is a real physiological change, not a transient. During a session, the effect ramps linearly 0 → fullEffect.
- **Daily reset guard:** sessions that started before `lastResetMs` are excluded, matching the identical guard in all four chart components.

```typescript
// Compute how much activity was already baked into the reading
let activityEffectAtReading = 0;
if (recentReading?.bloodSugar && activityPDValid) {
  const readingMs = parseUTCMs(recentReading.bloodSugarTimestamp ?? recentReading.timestamp);
  if (!isNaN(readingMs)) {
    activityEffectAtReading = calculateActivityEffectForCumulative(
      readingMs, activityContributions, lastResetMs
    );
  }
}

// Only the delta new since the reading is added
const activityDeltaSinceReading = cumulativeActivityEffect - activityEffectAtReading;
```

`activityDeltaSinceReading` is added (never subtracted) because `cumulativeActivityEffect` is already signed negative for aerobic exercise.

### 6.4 Reading-Residual Correction (Preset Mode Only)

In preset mode, the circadian profile is a population average. An individual patient may consistently run higher or lower than the profile at a given time of day. The residual captures this offset:

```typescript
if (resolvedMode === 'preset' && recentReading?.bloodSugar != null) {
  readingResidual =
    recentReading.bloodSugar
    - frontendBaseline._circadianAtReading    // what profile expected at reading time
    - frontendBaseline._cumulAtReadingNet;    // PK effects already active at reading time

  correctedEstimatedBG = correctedEstimatedBG_raw + readingResidual;
}
```

**Example:** Profile expected 95 mg/dL at 09:15; patient measured 112 mg/dL; cumulative PK at that time was +10 mg/dL. Residual = `112 − 95 − 10 = +7 mg/dL`. This +7 is persistently added to all subsequent estimates until a new reading arrives.

In dynamic mode `readingResidual` is `null` and not applied — the dynamic unwind already captures the patient-specific offset implicitly.

### 6.5 Final Formula Summary

**Dynamic mode:**

```
stableBaseline           = reading − Σmeal_at_reading + Σinsulin_at_reading
correctedEstimatedBG     = stableBaseline
                          + (Σmeal_now − Σinsulin_now)
                          + activityDeltaSinceReading
```

**Preset mode:**

```
stableBaseline           = circadianProfile(currentHour)
readingResidual          = reading − circadianProfile(readingHour) − Σnet_at_reading
correctedEstimatedBG     = stableBaseline
                          + (Σmeal_now − Σinsulin_now)
                          + activityDeltaSinceReading
                          + readingResidual
```

---

## 7. Projected Final BG

```typescript
const frontendPendingMOBRise  = frontendMOB?.totalPendingRise ?? 0;
const frontendPendingIOBRedux = (frontendIOB?.totalIOB ?? 0) * correctionFactor;
const frontendPendingNetEffect = frontendPendingMOBRise - frontendPendingIOBRedux;

const simpleProjectedFinalBG = correctedEstimatedBG + frontendPendingNetEffect;
```

`correctionFactor` used here is `effectiveCorrectionFactor` when `sensitivityMultiplier > 1.005`, reflecting that post-exercise IOB will lower BG more than the baseline CF would suggest.

---

## 8. Data Flow Diagram

```
fetchAndCalculate()
│
├─ Step 1: Parallel API calls (24-h window)
│   ├─ GET /api/meals-only                          → rawMeals
│   ├─ GET /api/insulin-data                        → rawDoses
│   ├─ GET /api/blood-sugar                         → readingArray
│   └─ GET /api/activity/pharmacodynamics           → activityPDData
│       (or propPDResult prop — skips fetch; fix D-3)
│
├─ Step 2: Normalise + extract activity PD fields
│   ├─ cumulativeActivityEffect, sensitivityMultiplier, activityOnBoard
│   ├─ activityContributions[], activeSessions
│   └─ effectiveCorrectionFactor, effectiveCarbToBgRatio
│
├─ Step 3: Reset window + mode
│   ├─ lastResetMs = getLastResetTimeMs(now, resetHour, tzOffset)
│   └─ resolvedMode = 'dynamic' | 'preset'
│
├─ Step 4: Filter events into window
│   ├─ allMealsInWindow (after reset, any absorption state)
│   └─ allDosesInWindow (after reset, any absorption state)
│
├─ Step 6: Frontend IOB / MOB
│   ├─ frontendMOB = calculateStackedMealEffect(allMealsInWindow, ...)
│   └─ frontendIOB = calculateStackedInsulinEffect(dosesForStacking, correctionFactor)
│
├─ Step 7: Most recent reading + activity overlap check
│   └─ activityOverlapWarning = reading taken inside a session's PD window
│
├─ Step 8: BASELINE ─────────────────────────────────────────────────────────
│   │
│   ├─ [dynamic] calculateStableBaselineFromReading(reading, allMealsInWindow,
│   │             allDosesInWindow, readingTime, constants, profiles, ...)
│   │   ├─ Evaluates Σmeal + Σinsulin at reading timestamp (Phase-3-aware)
│   │   ├─ stableBaseline = reading − cumulativeNetAtReading
│   │   └─ sanitizeBaseline() → clamp to [55, 220] mg/dL
│   │
│   └─ [preset]  getCircadianBaseline(hourFloat, circadianProfile)
│       ├─ Linear interpolation between hourly anchors (midnight wraparound)
│       ├─ Compute _circadianAtReading + _cumulAtReadingNet for residual
│       └─ No clamping applied in preset mode
│
├─ Step 9: calculateNetEffect(baseline, meals, doses, now, constants, profiles,
│           activityPDValid ? activityPDData : null)
│           → trend + safetyStatus (display metadata only)
│           → estimatedBG from this call is DISCARDED
│           → activityPD is passed so trend IS exercise-adjusted (Goal 4 fix)
│             previously resetHour was in the activityPD slot — trend never saw exercise
│
├─ Step 10: calculateTotalCumulativeEffects(allMealsInWindow, allDosesInWindow, NOW, ...)
│   └─ correctedCumulative.cumulativeNetBaseline  (Σmeal_now − Σinsulin_now)
│
├─ Activity delta since reading
│   ├─ activityEffectAtReading = calculateActivityEffectForCumulative(readingMs, ..., lastResetMs)
│   └─ activityDeltaSinceReading = cumulativeActivityEffect − activityEffectAtReading
│
├─ [preset only] readingResidual = reading − circadian_at_reading − cumul_at_reading
│
└─ FINAL ASSEMBLY
    correctedEstimatedBG = stableBaseline
                          + cumulativeNetBaseline
                          + activityDeltaSinceReading
                         [+ readingResidual if preset]
    simpleProjectedFinalBG = correctedEstimatedBG + pendingMOBRise − pendingIOBRedux
```

---

## 9. Patient Constants Lifecycle

### 9.1 Patient Store — Two-Phase Load (`patient.store.ts`)

`loadConstants()` in `usePatientStore` runs a two-phase pattern to eliminate the "stale defaults flash":

**Phase 1 — Immediate cache population:**

```typescript
const cached = await storage.getJSON(STORAGE_KEYS.PATIENT_CONSTANTS);
if (cached?.constants) {
  const isFresh = cached.lastFetched != null
    && Date.now() - cached.lastFetched < 5 * 60 * 1000;

  set({
    constants: cached.constants,
    activeConditions: cached.activeConditions || [],
    activeMedications: cached.activeMedications || [],
    lastFetched: cached.lastFetched ?? null,
    ...(isFresh ? { isLoading: false } : {}),  // mark done only if fresh
  });

  if (isFresh) return;  // skip network call — cache is fresh
}
// stale cache → isLoading stays true → fall through to Phase 2
```

After Phase 1, `constants` in the store is the last-known server value (or still null on first install). `isLoading` stays `true` unless the cache was genuinely fresh, so all downstream guards block until Phase 2 resolves.

**Phase 2 — API fetch:**

```typescript
const response = await apiClient.get(API.PATIENT.CONSTANTS);
const data = response.data.constants;

await storage.set(STORAGE_KEYS.PATIENT_CONSTANTS, {
  constants: data,
  activeConditions: data.active_conditions || [],
  activeMedications: data.active_medications || [],
  lastFetched: now,
});

set({ constants: data, ..., isLoading: false });
```

**Error handling:**
- Network fails **with** cached data → `isLoading: false`, `error: 'Using cached data'` — UI proceeds with stale-but-valid constants.
- Network fails **without** any cache → falls back to `DEFAULT_PATIENT_CONSTANTS` so the app doesn't stay in an infinite loading state on first install with no network.

### 9.2 `usePatientConstants` — `hasLoadedFromAPI`

A boolean field added to `UsePatientConstantsResult`. `true` once at least one successful API fetch has completed in the current JS session.

**Why it matters:** Before `hasLoadedFromAPI` is `true`, the hook returns `DEFAULT_PATIENT_CONSTANTS`. `DEFAULT_PATIENT_CONSTANTS.baseline_mode` is `"dynamic"`. If a component ran calculations at that point for a patient configured as `"preset"`, it would flash the wrong baseline system before the real constants arrived.

**Implementation:**

```typescript
const CONSTANTS_TTL_MS = 5 * 60 * 1000; // 5 minutes
let lastFetchedAt = 0;  // module-level — persists across re-renders; resets on full app restart

const [hasLoadedFromAPI, setHasLoadedFromAPI] = useState<boolean>(
  () => lastFetchedAt > 0  // lazy init — true for screens mounting after first fetch
);
```

`setHasLoadedFromAPI(true)` is called in exactly three places (all of which also advance `lastFetchedAt`):

1. **TTL effect** — initial load or stale refresh
2. **AppState `'active'` handler** — foreground refresh
3. **`refresh()`** — manual pull-to-refresh

### 9.3 TTL Refresh

```typescript
useEffect(() => {
  if (!autoLoad || isNonPatient || isLoading) return;
  const neverFetched = lastFetchedAt === 0;
  const isStale = Date.now() - lastFetchedAt > CONSTANTS_TTL_MS;
  if (neverFetched || isStale) {
    loadConstants().then(() => {
      lastFetchedAt = Date.now();
      setHasLoadedFromAPI(true);
    });
  }
}, [autoLoad, isNonPatient, isLoading, loadConstants]);
// `constants` deliberately excluded — see dep-array loop fix below
```

`constants` is intentionally excluded from the dependency array. Including it caused a feedback loop: `loadConstants()` resolving would flip `constants` null → object, re-trigger the effect, and in a race with the AppState listener resetting `lastFetchedAt = 0`, could launch a second `loadConstants()` in the same session.

### 9.4 AppState Foreground Refresh

```
app goes to background  →  lastFetchedAt = 0         (marks cache stale)
app comes to foreground →  TTL effect fires            (neverFetched = true)
                        →  loadConstants() called      (silent background fetch)
                        →  store updates               (all screens re-render via Zustand)
```

Primary fix for the "doctor edits patient constants — patient sees stale values" problem. Previously the only recovery was waiting for the TTL or restarting the app.

### 9.5 Doctor / Admin Guard

`isNonPatient = user?.user_type === 'doctor' || user?.user_type === 'admin'` prevents any auto-load. Doctors calling `/api/patient/constants` receive 403; the guard ensures this never happens. The `autoLoad` parameter (default `true`) can also be set to `false` for non-patient screens.

---

## 10. ActiveEffectsDisplay — Render Guards

Three distinct loading states gate execution before any calculation runs:

### Guard 1 — Pre-load spinner (profile not yet loaded)

```tsx
if (!hasLoadedFromAPI || constantsLoading) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#007AFF" />
      <Text style={styles.loadingText}>Loading your profile…</Text>
    </View>
  );
}
```

Prevents *any* PK calculation from running with `DEFAULT_PATIENT_CONSTANTS`. Without this guard, `fetchAndCalculate()` would fire with wrong defaults (e.g. `baseline_mode: 'dynamic'` for a patient configured as `'preset'`), causing a visible flash of the wrong baseline system before the correct constants load.

### Guard 2 — `useEffect` gate

```typescript
useEffect(() => {
  if (constantsLoading || !hasLoadedFromAPI) return;
  fetchAndCalculate();
  // ... 60-second polling setup aligned to wall-clock minute boundary
}, [constants, constantsLoading, hasLoadedFromAPI]);
```

The previous `!constants` check was a dead guard — `usePatientConstants` always returns `effectiveConstants` (never null). Replaced with `!hasLoadedFromAPI`.

### Guard 3 — `propPDResult` focused effect

```typescript
const prevPDRef = useRef<ActivityPDResult | null | undefined>(undefined);

useEffect(() => {
  if (propPDResult === undefined) return;           // standalone component — timer handles everything
  if (propPDResult === prevPDRef.current) return;  // no actual change; guards first render
  prevPDRef.current = propPDResult;
  if (constantsLoading || !hasLoadedFromAPI) return;
  fetchAndCalculate();
}, [propPDResult, constantsLoading, constants, hasLoadedFromAPI]);
```

When a parent screen (e.g. one that also mounts `EffectsVisualizationChart`) passes its already-fetched `activityPDResult` as a prop, this effect calls `fetchAndCalculate()` immediately when the prop changes — without waiting for the next 60-second timer tick and without resetting the polling interval. The `fetchAndCalculate` closure always captures the current `propPDResult`, so no extra network request is made.

`prevPDRef` initialised to `undefined` (not `null`) is the sentinel meaning "nothing received yet — skip first render" to avoid a double-fire on mount.

---

## 11. Reading-Residual Alert System

**Applies to:** preset/circadian mode only. Dynamic mode uses hard-clamp and soft-baseline banners instead.

### 11.1 What `readingResidual` Measures

```
readingResidual = recentReading.bloodSugar
               − circadianAtReading          // profile value at the reading hour
               − cumulAtReadingNet           // net PK Δ of logged meals+insulin at reading time
```

In plain English: **the portion of the measured BG that no logged event and no circadian curve can account for.**

| Sign | Meaning | Most likely cause |
|---|---|---|
| Positive | BG higher than model predicts | Unlogged meal / snack, underestimated portion, illness/stress |
| Near zero (< 20 mg/dL) | Within noise | Normal — no action |
| Negative | BG lower than model predicts | Unlogged insulin dose, unlogged exercise, overestimated meal |

The residual is forward-propagated as a constant offset into every subsequent `estimatedBG`, every `projectedFinalBG`, and every correction dose suggestion — making it critical to surface when large.

### 11.2 `classifyResidual()` — Tier System

```typescript
function classifyResidual(
  residual: number,
  mealsCount: number,
  dosesCount: number,
  carbToBgFactor: number,
  correctionFactor: number,
  minutesSinceReading: number,
  activityOverlapWarning: boolean,
): ResidualClassification
```

**Tiers:**

| Tier | Condition | Banner | Rationale |
|---|---|---|---|
| **Noise** | `|residual| < 20` | None | Within glucometer precision + normal circadian variability |
| **Soft** | `20 ≤ |residual| < 50` | 🟡 Amber | ~5–12 g carbs or ~0.5–1.25 u insulin unaccounted |
| **Strong** | `50 ≤ |residual| < 100` | 🟠 Orange | ~12–25 g carbs or ~1.25–2.5 u — likely a missed snack or dose |
| **Critical** | `|residual| ≥ 100` | 🔴 Red | ≥ 25 g carbs or ≥ 2.5 u — likely a full missed meal or significant dose |

**Positive residual (BG above model):** translates gap to carb equivalent (`residual ÷ carbToBgFactor`). Body text gives directional guidance: check meal entries for missed snacks or inaccurate portion sizes.

**Negative residual (BG below model):** translates gap to insulin equivalent (`|residual| ÷ correctionFactor`). Body text: check for unlogged insulin dose or activity session.

### 11.3 Edge Cases

| Edge case | Guard | Modified message |
|---|---|---|
| **Stale reading** (`minutesSinceReading > 120`) | Append note to body | `(Note: this reading is X min old — residual reliability decreases over time.)` |
| **Activity overlap** (`activityOverlapWarning = true`) | Negative residual only | Body attributes part of the gap to exercise already captured by the activity tracker before suggesting unlogged insulin |
| **First entry of day** (`mealsCount === 0 && dosesCount === 0 && residual > 0`) | Positive residual | Body mentions dawn phenomenon variance and overnight snack possibility rather than a logging error |

### 11.4 Banner Position in Render Tree

```
[Baseline Capped banner]           ← dynamic mode, hard clamp (clampStatus === 'hard_clamped')
[Low Baseline Detected banner]     ← dynamic mode, 55–74 mg/dL soft warning
[Reading-residual alert banner]    ← preset mode, tier != 'noise', !estimateIsUnreliable
[Unreliable-estimate banner]       ← both modes, estimatedBG < 10 mg/dL
[Three-card BG row]
```

The residual banner uses the same `clampBanner` style container as the existing banners, colour-coded by tier. `data.aob.effectiveCarbToBgRatio` and `data.aob.effectiveCorrectionFactor` (already in state) are used for unit conversion — no new state required.

---

## 12. Activity PD Integration (AOB)

### 12.1 API Service (`activity-pharmacodynamics.ts`)

Three endpoints are proxied:

| Function | Method | Endpoint | Use |
|---|---|---|---|
| `fetchActivityPD(targetTime?)` | GET | `/api/activity/pharmacodynamics` | Primary — stacked effect of all today's sessions |
| `fetchActivityOnBoard(targetTime?)` | GET | `/api/activity/pharmacodynamics/aob` | Per-session AOB breakdown |
| `previewActivityEffect(body)` | POST | `/api/activity/pharmacodynamics/preview` | Simulate a planned session without persisting |
| `fetchStackedActivityEffectSafe(targetTime?)` | GET | same as above | Non-fatal wrapper — returns `null` on any error |

`fetchStackedActivityEffectSafe` is the function used inside `Promise.all()` chains. A `null` return must always be treated as zero effect — it must never break the BG pipeline.

### 12.2 `ActivityPDResult` Fields

| Field | Type | Description |
|---|---|---|
| `cumulative_activity_effect` | `number` | Net signed BG effect of all today's sessions (mg/dL). Negative = BG-lowering aerobic. |
| `sensitivity_multiplier` | `number` | Post-exercise ISF/CR boost (≥ 1.0). MAX across sessions (GLUT4 receptors don't stack additively). |
| `activity_on_board` | `number` | Unsigned total remaining acute BG drop still to arrive (mg/dL). |
| `activity_contributions` | `ActivityContribution[]` | Per-session breakdowns. |
| `active_sessions` | `number` | Sessions currently within their exercise duration window. |
| `effective_correction_factor` | `number` | ISF scaled up by `sensitivity_multiplier`. **Pre-multiplied — do NOT re-apply.** |
| `effective_carb_to_bg_ratio` | `number` | CR scaled down by `sensitivity_multiplier`. **Pre-divided — do NOT re-divide.** |
| `cached` | `boolean` | Observability only — backend served from 60-second TTL cache. No consumer should branch on this. |

### 12.3 `ActivityContribution` Fields

| Field | Type | Description |
|---|---|---|
| `activity_id` | `string` | MongoDB ObjectId or `"preview"` |
| `start_time` | `string` | ISO-8601 session start |
| `intensity` | `'light' \| 'moderate' \| 'vigorous'` | Categorical tier |
| `duration_minutes` | `number` | Session length |
| `bg_direction` | `-1 \| 1` | -1 = lowers BG (aerobic); +1 = raises BG (anaerobic) |
| `cumulative_bg_effect` | `number` | Signed mg/dL from THIS session |
| `remaining_bg_drop` | `number` | Unsigned AOB still to be delivered |
| `absorbed_fraction` | `number` | 0.0–1.0 — fraction of acute drop already delivered |
| `is_active` | `boolean` | Session within its `duration_minutes` window |
| `model` | `'hr_ode' \| 'synthetic_hr'` | HR trace model vs categorical fallback |

### 12.4 Sign Convention

`cumulativeActivityEffect` is **added** to `estimatedBG`, never subtracted. The value is already signed negative for aerobic (BG-lowering) exercise. No extra negation anywhere in the pipeline.

### 12.5 Sensitivity Threshold

`sensitivityMultiplier > 1.005` is used as the threshold before applying `effectiveCorrectionFactor` or `effectiveCarbToBgRatio`. The 0.5% dead-band suppresses floating-point noise that would otherwise spuriously activate the override on days with no exercise.

### 12.6 Prop Injection (Fix D-3)

`ActiveEffectDisplay` accepts an optional `activityPDResult` prop. When a parent screen already holds a freshly-fetched `ActivityPDResult` (e.g. from `useActiveEffects()`), passing it as a prop eliminates a redundant ODE run during the 60-second cache-miss window. The component short-circuits the `GET /api/activity/pharmacodynamics` call and uses the prop directly.

---

## 13. What ActiveEffectsDisplay Shows

The `baseline` object assembled in step 11 drives the UI:

| UI Field | Source |
|---|---|
| Baseline value | `baseline.value` = `frontendBaseline.stableBaseline` |
| Reading value | `baseline.readingValue` |
| Reading timestamp | `baseline.readingTimestamp` |
| Mode badge (🌙 Circadian / 📍 Dynamic) | `baseline.isPreset` |
| Badge hint | `Profile at HH:MM · X mg/dL` (preset) or `From last reading · X mg/dL` (dynamic) |
| Raw (pre-clamp) value | `baseline.rawBaselineValue` |
| Clamp warning banner | `baseline.clampStatus === 'hard_clamped'` + `baseline.clampWarnings` |
| Meals active at reading | `baseline.mealsCount` |
| Insulin active at reading | `baseline.insulinCount` |
| Reading residual | `baseline.readingResidual` (preset only) |
| Circadian value at reading hour | `baseline.circadianAtReading` (preset only) |
| Net PK at reading | `baseline.cumulAtReadingNet` (preset only) |
| Target fallback warning | `metadata.usingTargetFallback` |
| Activity overlap warning | `metadata.activityOverlapWarning` |

---

## 14. Component Features & Patient Value

### 14.1 Architecture

```
ActiveEffectDisplay
│
├─ usePatientConstants()     — constants + hasLoadedFromAPI
├─ fetchAndCalculate()       — runs on mount + every 60 s (wall-clock aligned)
│   ├─ Parallel: meals, insulin, blood-sugar, activity PD (24-h window)
│   ├─ Normalise → filter to daily window → compute IOB / MOB / AOB
│   ├─ Derive baseline (dynamic or preset)
│   └─ Assemble: estimatedBG, projectedFinalBG, per-dose/meal breakdowns
│
└─ Render
    ├─ Pre-load guard spinner ("Loading your profile…")
    ├─ Header — mode badge + baseline value hint, last update timestamp
    ├─ Safety banners (clamp / low baseline / residual alert / unreliable estimate)
    ├─ Three-card BG strip (Last Reading → Estimated Now → Projected)
    ├─ "More details" toggle (formula strips per card)
    ├─ Two-column: IOB card (left) + MOB card (right)
    ├─ AOB card (activity — always rendered, handles empty state)
    ├─ Status assessment card (tug-of-war, recommendation)
    ├─ Net Effect Analysis card (collapsible cumulative breakdown)
    └─ Footer metadata + Refresh button
```

### 14.2 Three-Card Blood Glucose Strip

| Card | Label | Content |
|---|---|---|
| Left | LAST READING | Most recent BG value, clock time, relative age ("3h 12m ago") |
| Centre | ESTIMATED NOW | PK-computed current BG; safety status label; formula strip when expanded |
| Right | PROJECTED | Final BG once all active meals digest and insulin fully absorbs |

Between cards: directional arrows (↗ → ↘) with signed delta. Strip hidden and replaced by the unreliable-estimate banner when `estimatedBG < 10 mg/dL`.

### 14.3 IOB / MOB / AOB Cards

**IOB (left column, purple accent):** pending BG reduction, absorbed BG reduction, per-dose breakdown with status pills (Active/Absorbed/Future) and per-dose BG effect line. Uses `effectiveCorrectionFactor` when `sensitivityMultiplier > 1.005`.

**MOB (right column, orange accent):** pending BG rise, absorbed BG elevation, per-meal breakdown with absorption type, carb count, and per-meal BG effect line.

**AOB (teal accent, always rendered):** `totalAOB` (unsigned remaining drop), `cumulativeActivityEffect` (signed total), sensitivity multiplier badge when `> 1.005` with effective ISF/CR values and expiry time, per-session breakdown with intensity pills (L/M/V).

### 14.4 Safety Banners (Full Set)

| Banner | Trigger | Colour | Mode |
|---|---|---|---|
| Baseline Capped | `clampStatus === 'hard_clamped'` | 🔴 Orange-red | Dynamic only |
| Low Baseline Detected | baseline 55–74 mg/dL, not clamped | 🟡 Amber | Dynamic only |
| Reading-Residual Alert | preset, `|residual| ≥ 20`, not unreliable | Tier-coloured | Preset only |
| Estimation Unreliable | `estimatedBG < 10 mg/dL` | 🟡 Amber + checklist | Both |
| Activity–Reading Overlap | `activityOverlapWarning = true` | Inline amber italic | Both |

### 14.5 Patient Value

**Closing the "what is my BG right now?" gap.** The three-card strip gives a reasoned pharmacodynamic estimate between finger-stick checks, anchored to actual logged data.

**Preventing over-correction.** Seeing pending MOB alongside pending IOB lets the patient assess whether active insulin is sufficient before reaching for a correction dose.

**Explaining hypoglycaemia risk.** IOB pending reduction + activity sensitivity multiplier + AOB value together show how much additional BG lowering is still in the pipeline — critical post-exercise.

**Detecting logging errors early.** The safety banners, unreliable-estimate checklist, and per-dose/meal breakdowns give concrete, actionable feedback when the model detects a discrepancy.

---

## 15. Mode Separation Analysis

**Clean split — baseline computation:**

| Concern | Dynamic | Circadian |
|---|---|---|
| Baseline function | `calculateStableBaselineFromReading()` | `getCircadianBaseline()` |
| Clamp / warn | `sanitizeBaseline()` → hard-clamp banners | `classifyResidual()` → residual alert banners |
| Reading use | Unwound to derive baseline | Compared to circadian to compute residual |
| Missing reading | Falls back to `target_glucose` | Uses circadian; `readingResidual = null` |
| Mode badge hint | `From last reading · X mg/dL` | `Profile at HH:MM · X mg/dL` |

**Shared code (intentional):**

Both modes call identical `calculateTotalCumulativeEffects()`, `calculateStackedMealEffect()`, `calculateStackedInsulinEffect()`, `calculateActivityEffectForCumulative()`, and the same `estimatedBG` assembly formula — only `stableBaseline` differs.

**Two coupling points:**

1. `calculateNetEffect()` (step 9) is called identically for both modes and its `trend` field is consumed. Since the **Goal 4 fix**, `activityPD` is passed as the 7th argument, so the trend arrow is exercise-adjusted and consistent with `correctedEstimatedBG`. The remaining latent risk is only in the cumulative meal/insulin arithmetic (step 9 uses `_calculateNetEffect` internally; step 10 calls `calculateTotalCumulativeEffects`) — not in the activity contribution. If those two cumulative paths diverge, `trend` would reflect a slightly different BG than the card shows, but this is a low-probability edge case, not an active bug.
2. `hasLoadedFromAPI` gates both modes equally — `resolvedMode` is not determined until after the guard clears. Correct behaviour.

---

## 16. Mode Selection Guide

| Situation | Recommended Mode |
|---|---|
| Patient checks BG frequently (manual or CGM) | **Dynamic** — unwind gives an individualised baseline for every reading |
| Testing / development without real readings | **Preset** — produces stable numbers without needing data |
| Patient consistently deviates from population average | **Preset** with custom `circadian_profile` anchors set by a doctor |
| CGM data available | **Dynamic** — fresh readings every 5 min keep the baseline very accurate |
| Patient has irregular logging habits | **Preset** — avoids stale-reading drift that would corrupt dynamic mode |
| Post-exercise window (`sensitivityMultiplier > 1`) | **Dynamic** preferred — effective CF override is applied to the unwind |

---

## 17. Configuration Reference

All configuration lives in `PatientConstants`, loaded via `usePatientConstants()`. Default values from `DEFAULT_PATIENT_CONSTANTS`:

```typescript
// Controls mode selection
baseline_mode?: 'dynamic' | 'preset'      // default: 'dynamic'

// Used by preset mode
circadian_profile?: {
  anchors: Array<{ hour: number; value: number }>;  // 24 hourly anchors, 0–23
  source: 'preset' | 'custom';
}
// Default profile range: 85 mg/dL (03:00) → 120 mg/dL (08:00)

// Used by both modes
daily_reset_hour?: number                 // default: 7 (7 AM local time)
timezone_offset_minutes?: number          // default: 0 (UTC)
target_glucose: number                    // default: 100 — no-reading fallback
weight_kg: number                         // default: 70.0 — used by HR ODE model
hr_base: number                           // default: 70.0 bpm — resting HR
hr_max: number                            // default: 190.0 bpm — max HR

// Used by dynamic mode for unwind calculations
carb_to_bg_factor: number                 // default: 4.0 mg/dL per g carb
correction_factor: number                 // default: 40 mg/dL per unit insulin
insulin_to_carb_ratio: number             // default: 10

// Hard clamp bounds (from shared-constants.ts — not patient-configurable)
BASELINE_HARD_MIN = 55    // mg/dL
BASELINE_HARD_MAX = 220   // mg/dL
```

---

## 18. Key Invariants

1. **Both modes use the same cumulative-effects calculation at step 10.** The difference is only in how `stableBaseline` is obtained; the meal/insulin bank balance layered on top is identical.

2. **Activity delta (not full activity effect) is added to `estimatedBG`.** The lock-in model correctly handles partial sessions at reading time — sessions fully delivered before the reading contribute zero new delta; sessions active at reading time contribute only the tail; new sessions after the reading contribute fully.

3. **Clamping only applies in dynamic mode.** Preset values come from a bounded clinically-modelled profile and cannot produce physiologically impossible outputs.

4. **Phase 3 persist-at-100% is always active.** Both `calculateMealCumulativeEffect` and `calculateInsulinCumulativeEffect` hold absorbed events at their maximum contribution until the next daily reset, matching backend Python exactly.

5. **`target_glucose` is the last resort.** If there is no reading (dynamic) and no baseline at all, `stableBaseline = constants.target_glucose`. `metadata.usingTargetFallback` flags this state.

6. **`sensitivityMultiplier` threshold is 1.005.** This 0.5% dead-band suppresses floating-point noise. Used consistently for IOB pending reduction, MOB pending rise, cumulative calculation override, and the baseline unwind CF override.

7. **`hasLoadedFromAPI` gates all calculations in `ActiveEffectsDisplay`.** Both the render pre-load guard and the `useEffect` gate check this flag. No PK calculation ever fires with `DEFAULT_PATIENT_CONSTANTS`.

8. **`activeEffectDisplay` is the sole UI consumer of the dual-baseline system.** Other components that need glucose estimates receive their data from hooks or props derived from the same pipeline — they do not run independent baselines.

---

## 19. Files Reference

| File | Location | Role |
|---|---|---|
| `ActiveEffectDisplay.tsx` | `mobile/components/` | Main display component. Owns `fetchAndCalculate`, all render guards, `classifyResidual`, `calculateActivityEffectForCumulative` |
| `usePatientConstants.ts` | `mobile/hooks/` | Hook: loads/caches constants, exposes `hasLoadedFromAPI`, TTL + AppState refresh |
| `patient.store.ts` | `mobile/store/` | Zustand store: two-phase load (cache → API), `loadConstants()`, `updateConstants()` |
| `baseline.ts` | `mobile/utils/calculations/` | Re-exports `calculateStableBaselineFromReading`, `sanitizeBaseline`, `assessBaselineConfidence` |
| `net-effect.ts` | `mobile/utils/calculations/` | Re-exports `calculateNetEffect` with activity PD fields (`NetEffectResultWithActivity`) |
| `cumulative-effects.ts` | `mobile/utils/calculations/` | Re-exports `calculateTotalCumulativeEffects` with Phase-3 persist-at-100% fix |
| `blood-glucose-estimation.ts` | `mobile/utils/glucose/` | Core PK math. All calculation utils delegate to this. No console calls (removed in latest update). |
| `activity-pharmacodynamics.ts` | `mobile/services/api/` | Activity PD API service: `fetchActivityPD`, `fetchStackedActivityEffectSafe`, type definitions |
| `shared-constants.ts` | `mobile/constants/` | `getCircadianBaseline`, `DEFAULT_CIRCADIAN_PROFILE`, `DEFAULT_PATIENT_CONSTANTS`, `BASELINE_HARD_MIN/MAX`, `MEAL_ABSORPTION_PROFILES` |
| `reading-residual-alert-plan.md` | `docs/` | Original plan document that `classifyResidual()` implements |
