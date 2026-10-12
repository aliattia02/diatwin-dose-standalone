# Insulin Suggestion Logic — Detailed Documentation

**Files covered:**
- `insulinCalculationService.ts` — core on-device dose engine
- `MealForm.tsx` — meal-context dose calculation + insulin type/timing UI
- `UnifiedInsulinInput.tsx` — standalone correction suggestion card

**Version:** 2.5 (12 Oct 2026: Step 8 now describes the 26 Sep 2026 minimum-dose and round-down rule; the IOB surplus warning is stated as mobile-only; no logic changed). 2.4 — reflects QA-verified fixes: Bug 6 (fiber factor), Bugs 1/2/13/16 (ODE rewrite),
Bug 5 (carb_to_bg_factor fallback), Bugs 3/8 (trend rate), Bug 7 (teal τ_Z decay),
**Cross-file audit fix (2026):** `insulinCalculationService.ts` sensitivity multiplier formula
corrected from `α × W` to `α × W × (1 + Z)` to match Python ground truth and
`activity-pharmacodynamics.ts`. During active exercise (Z ≈ 1) the old formula
underestimated sensitivity by up to 50%.

---

## 1. Overview

The insulin suggestion system has **two distinct modes** depending on context.

| Mode | Where | Input | Output |
|------|--------|-------|--------|
| **Meal dose** | `MealForm` + `UnifiedInsulinInput` (with `suggestedDose` prop) | Foods, BG, activities, active effects | Total dose in units + insulin type + timing strategy |
| **Correction-only** | `UnifiedInsulinInput` standalone (`standalone=true`) | BG estimate, IOB, MOB | Correction dose recommendation card |

Both modes run entirely on-device — no backend round-trip for the dose calculation itself.

---

## 2. Meal Dose Pipeline (`insulinCalculationService.ts`)

Entry point: `calculateInsulinNeeds(selectedFoods, bloodSugar, activities, patientConstants, ...)`

This is a convenience wrapper that calls `calculateTotalNutrients()` and then `calculateInsulinDose()`.

### Step 1 — Nutrition Aggregation (`calculateTotalNutrients`)

Iterates over every selected food item:

1. **Portion scaling** — converts the user's portion (weight or volume) to a ratio against the food's reference serving size using `convertToGrams` / `convertToMl`. All household units (palm, handful, bowl, etc.) resolve through the shared constants converter, guaranteeing the number matches what `SelectedFoodsList` displays.
2. **Macro scaling** — multiplies the food's base carbs/protein/fat by the conversion ratio.
3. **Weighted absorption type** — each food's absorption type is mapped to a numeric value (`very_fast=5` → `very_slow=1`). The final type is the carb-weight-averaged score, rounded to the nearest integer and mapped back to a type string. This means a meal of 80 g fast-carb bread + 20 g very_slow lentils rounds to `fast`, not `medium`.

```
weightedAvg = Σ(ABSORPTION_VALUES[type] × carbs) / Σ(carbs)
absorptionType = ABSORPTION_REVERSE[round(weightedAvg)]
```

### Step 2 — Carb Equivalents (`calculateCarbEquivalents`)

Protein and fat do raise blood sugar, just more slowly. They are converted into gram-equivalent carbs using patient-specific factors. Dietary fiber is **fully subtracted** because it does not raise blood glucose (ADA / T1D Exchange net-carbs standard):

```
proteinCarbEquiv = protein × protein_factor   (default 0.5)
fatCarbEquiv     = fat × fat_factor           (default 0.2)
fiberDeduction   = fiber × FIBER_FACTOR       (FIBER_FACTOR = 1.0)
totalCarbEquiv   = carbs + proteinCarbEquiv + fatCarbEquiv − fiberDeduction
```

> **Why FIBER_FACTOR = 1.0:** Dietary fiber is indigestible and does not enter the bloodstream. Prior to this fix the factor was 0.1, which understated net carbs by up to 54% for high-fiber foods such as legumes, whole grains, and vegetables. The corrected value matches standard clinical practice.

**Example — black beans (40 g carbs, 15 g fiber, 8 g protein, 1 g fat):**
```
= 40 + (8 × 0.5) + (1 × 0.2) − (15 × 1.0)
= 40 + 4 + 0.2 − 15
= 29.2 g carbEquiv
```

### Step 3a — Base Insulin & Manual Activity

```
baseInsulin     = totalCarbEquiv / ICR
activityImpact  = calculateActivityImpact(activities, constants)
manualAdjusted  = baseInsulin × activityImpact
```

`calculateActivityImpact` iterates form-entered activities. For each one:
- Maps the numeric level (−2 to +2) to an `activity_coefficients` entry from patient constants.
- Computes a duration weight: `min(hours / 2, 1.0)` — capped at 1.0 so a 3-hour walk is not triple-counted.
- Applies: `weightedImpact = 1 + (coefficient − 1) × durationWeight`.
- Multiplies all activities together.

> **Note:** In the unified activity pathway (see §4), `activities=[]` is always passed to this step so `activityImpact` stays at `1.0`. The actual dose reduction comes from the sensitivity multiplier in Step 3b instead.

### Step 3b — Post-Exercise Sensitivity (`computeSyntheticSensitivityMultiplier`)

When the patient has exercised (either pre-logged via the backend PD endpoint, or entered manually in the form), GLUT4 upregulation makes their cells more insulin-sensitive. This is modelled with the Dalla Man / Breton HR exercise ODE (W-state), Euler-integrated at `dt = HR_MODEL.dt` minutes per session.

**ODE system — three coupled state variables:**

```
Y  (HR filter signal — energy expenditure proxy)
   dY/dt = (hrAboveFull − Y) / τ_HR
   where hrAboveFull = hrTarget − hrBase   (excess HR during exercise, 0 after)
   Y ≥ 0

Z  (binary saturation gate — exercise onset guard)
   dZ/dt = (1 − Z)   if inExercise AND Y > a·hrBase   (saturates to 1)
         = (−Z / τ_Z)  otherwise                        (decays back to 0)
   Z ∈ [0, 1]

W  (cumulative load integral — GLUT4 upregulation proxy)
   dW/dt = Y         during exercise   (accumulates area under Y)
         = (−W / τ_W)  in recovery     (decays only after exercise ends)
   W ≥ 0
```

Key behaviours:
- `Y` acts as a low-pass filter (τ_HR = 5 min) on excess HR, preventing instantaneous start-of-session spikes from gating Z and W prematurely.
- `Z` uses a **binary onset criterion** — it switches on only once Y crosses `a·hrBase` (5% of resting HR). It is not a smooth curve.
- `W` accumulates the area under the `Y` curve (not `a × Z`), encoding both intensity and duration jointly.
- The integration window covers `durationMins + recoveryMins`, where `recoveryMins = now − exerciseEndTime`, capped at `4 × τ_W`. This means W is evaluated at the moment the form is filled, not at the moment exercise ended — so the multiplier correctly decays as more time elapses post-exercise.

**Sensitivity multiplier per session:**

```
sessionBoost = min(α × W_at_now × (1 + Z_at_now), max_sensitivity_boost)
multiplier   = 1 + sessionBoost
```

`Z_at_now` is the Z-state value at the end of the integration window (i.e. after recovery has elapsed). During active exercise Z ≈ 1, so the boost is approximately `2 × α × W`. After exercise Z decays with τ_Z = 10 min, while W decays much more slowly with τ_W = 90 min — meaning the sensitivity window outlasts the acute exercise state by design. Omitting `(1 + Z)` underestimated the peak boost by up to 50% during exercise.

**Multiple sessions — `max()`, not additive sum:**

```
maxBoost = max(boost_session_1, boost_session_2, ...)
multiplier = 1 + maxBoost
```

GLUT4 receptors are already upregulated by the strongest session — a second session does not stack additively. This matches the backend's `sensitivity_multiplier` computation.

The multiplier is applied to both the base dose and the correction factor:

```
effectiveCF     = CF × sensitivityMultiplier    (widens CF → smaller correction per unit)
adjustedInsulin = manualAdjusted / sensitivityMultiplier
```

**Duration-only entries (no timestamps):** When `startTime`/`endTime` are absent, `recoveryMins = 0` is assumed ("exercise just ended"). The multiplier is therefore at its peak value for duration-only entries and will not decay until the user re-opens the form with timestamped activities.

**Manual vs pre-logged activities:**

| Source | How multiplier is computed |
|--------|---------------------------|
| Pre-logged (backend) | `activityPD.sensitivity_multiplier` from `GET /api/activity/pharmacodynamics` |
| Manual form entry | `computeSyntheticSensitivityMultiplier(savedActivities, constants)` |
| Both present | `max(syntheticMult, backendMult)` — stronger effect wins |

### Step 4 — Correction Insulin

```
bgForCorrection = (bgSource !== 'actual' && cumulativeActivityEffect ≠ 0)
                  ? max(40, bloodSugar + cumulativeActivityEffect)
                  : bloodSugar

correctionInsulin = (bgForCorrection − target) / effectiveCF
```

`cumulativeActivityEffect` (signed, usually negative for aerobic) is only applied when the BG estimate was built *without* it already baked in. The exact condition:

```
bgSourceAlreadyHasActivity =
    bgSource === 'actual'
    || (bgSource === 'estimated' && estimatedBG.confidence !== 'circadian')
```

- `actual` → patient just measured; exercise is already visible in the reading.
- `estimated` (dynamic mode) → backend's `current_estimated_bg` already ran its own net-effect pipeline including activity. Applying again would double-count.
- `circadian` (preset mode) → circadian baseline + PK net, no activity term. Safe to apply.

### Step 5 — IOB / MOB / AOB Deduction

Active insulin, meal carbs, and exercise all reduce how much new insulin is actually needed.

```
mobInsulinEquivalent = activeMealCarbs / ICR
aobInsulinEquivalent = activityOnBoard  / effectiveCF

postActiveTotal = preActiveTotal − activeInsulin + mobInsulinEquivalent − aobInsulinEquivalent
```

- **IOB (Insulin On Board)** — active insulin already delivered. Subtracted because it will still lower BG.
- **MOB (Meal On Board)** — grams of active meal carbs still digesting from a *prior* meal. Added back (as insulin equivalent) because those carbs will raise BG and need coverage.
- **AOB (Activity On Board)** — pending BG drop from exercise still to arrive, in mg/dL. Converted to insulin units via `effectiveCF` and subtracted. Functions like IOB: it will lower BG on its own.

**AOB for manual form activities (`computeSyntheticAOB`):**

Uses the Z-state arm of the same Breton ODE (the *acute* drop arm, separate from the W-state sensitivity pathway):

```
Y′ = (hrAbove − Y) / τ_HR         (excess-HR approach, 0 after exercise)
Z′ = (1 − Z)   if inExercise AND Y > a·hrBase   (saturates to 1 during exercise)
   = (−Z / τ_Z)  otherwise                        (decays with τ_Z = 10 min after)
acute_drop += Z × acute_rate_per_min × dt
```

Integration runs over the full window `durationMins + 4 × τ_Z` (exercise window + exponential decay tail of ~40 min). The remaining AOB is:

```
absorbedFraction = elapsedDrop / totalDrop
remaining        = totalDrop × (1 − absorbedFraction)
```

where `elapsedDrop` is the integral capped at `min(elapsed, fullWindow)`. Multiple sessions are **summed** independently (each delivers its own distinct remaining BG drop — additive, matching backend `total_aob` behaviour).

### Step 5b — IOB Surplus Warning (mobile only)

> **Where it exists:** only in the mobile engine (`mobile/services/insulinCalculationService.ts`, the
> `iobSurplusWarning` object). The web frontend (`frontend/src/`) and the Python backend (`dose_math.py`,
> `dose_cli.py`) have **no** surplus warning: they subtract active insulin, clamp the dose at 0 U and apply the
> minimum-dose rule, and the breakdown carries `post_active_total` (negative when active insulin exceeds the
> need), nothing more.

When `postActiveTotal < −0.5u`, the patient's existing IOB already exceeds their total meal + correction need. Injecting more insulin risks hypoglycaemia. The calculation triggers a warning:

```
iobSurplusWarning = {
  surplusUnits:     round2(|postActiveTotal|),
  extraCarbsNeeded: round(|postActiveTotal| × ICR),
}
```

The UI then hides the dose number entirely and instead tells the patient to eat fast carbs to offset the surplus insulin.

### Step 6 — Predictive Peak Overlap (`calculatePeakOverlap`)

When there is already active MOB or IOB, the *new* meal's glucose peak will coincide with those effects. This step predicts whether the overlap helps or hurts and adjusts the dose slightly.

```
mobAtPeak = estimateMobAtPeak(activeMealCarbs, newMeal.peak_hours, absorptionProfile)
iobAtPeak = estimateIobAtPeak(activeInsulin,   newMeal.peak_hours)

netBgImpact      = mobAtPeak × carbToBgFactor − iobAtPeak × corrFactor
adjustmentFactor = calculateAdjustmentFromOverlap(mobAtPeak, iobAtPeak)
                 ∈ [0.5, 1.5]

predictiveTotal  = postActiveTotal × adjustmentFactor
```

The adjustment is small (max ±50%), intended to catch cases like stacking a meal dose on top of a still-active prior bolus.

### Step 7 — Health Multiplier (`calculateHealthFactors`)

Multiplies all active disease conditions and medications into a single scalar. For duration-based medications (e.g. metformin, steroids), the effect is time-modulated:

- Rises linearly from 0 to `baseFactor` over `peak_hours`.
- Decays exponentially after peak using `exp(−2 × decay)` until `duration_hours` elapses.

```
multiplier   = Π(diseaseFactor) × Π(medFactor)
totalInsulin = max(0, predictiveTotal × healthMultiplier)
```

### Step 8 — Minimum dose and rounding down to the device step

Clinician decision of 26 Sep 2026. One definition per language, compared by the parity harness (family
`dose_final`): `mobile/utils/insulin/dose-rules.ts::finaliseDose`, `frontend/src/utils/doseRules.js::finaliseDose`,
`backend/utils/dose_math.py::finalise_dose`.

```
rawTotal = max(0, predictiveTotal × healthMultiplier)

if rawTotal < min_dose_units (default 0.5):   totalInsulin = 0
else:                                         totalInsulin = floor(rawTotal / step) × step
        step = dose_step_units, or 0.5 for pens / 0.1 for pumps (insulin_delivery)
```

A suggestion below the minimum is **not given at all (0 U)**; it is not raised to the minimum. The old rule
("round to 0.1 u, then floor at 0.5 u when `adjustedInsulin > 0` and `postActiveTotal > 0`") was removed because it
could add insulin on top of excess active insulin. Rounding is always **down** to the step, so the displayed dose is
never larger than the computed need.

> History: versions up to 2.4 of this document described the removed floor and 0.1 u rounding. The code and the
> three languages above agree on the rule in this section.

---

## 3. BG Source Resolution (`MealForm.performLocalCalculation`)

### Prerequisite: patient constants must be loaded

`performLocalCalculation` is gated at the top by:

```typescript
if (constantsLoading || !hasLoadedFromAPI) return;
```

`hasLoadedFromAPI` (from `usePatientConstants`) is `false` until `loadConstants()` has resolved at least once with real server data. This mirrors the guard in `ActiveEffectsDisplay` and prevents any dose calculation from running with `DEFAULT_PATIENT_CONSTANTS` (CF=40, ICR=10) while the API call is in-flight. Because `hasLoadedFromAPI` is in the `useCallback` dependency array, `performLocalCalculation` is recreated the moment real constants arrive, and the auto-recalculate effect re-fires automatically.

### Smart BG priority order

The "smart BG" selection chooses the most accurate blood glucose value available in a strict priority order, mirroring the JS web app exactly.

| Priority | Condition | `bgSource` | `bgConfidence` |
|----------|-----------|------------|----------------|
| 1 | Patient just entered a meter reading | `actual` | `very_high` |
| 2 | Backend estimated BG ≤ 360 min old | `estimated` | medium/high (from backend) |
| 3 | Backend estimated BG > 360 min old | `estimated` | `very_low` |
| 4 | No reading, but cumulative meal/insulin effects available | `estimated` | `very_low` |
| 5 | Absolute fallback | `target_fallback` | `very_low` |

**Case 4 formula (target_fallback with cumulative data):**

```
smartBG = max(40, targetGlucose + cumulativeMealEffect + cumulativeInsulinEffect)
```

This is more accurate than the raw `target_glucose` because it accounts for all meals and insulin delivered today.

### Circadian preset mode

When `baseline_mode === 'preset'`, the BG source logic splits on whether a reading is available.

**Reading exists** (`bgEst.current_estimated_bg != null`):

The backend's reading-anchored estimate is used directly, same as dynamic mode. `confidence` is set to `'estimated'` (not `'circadian'`), which makes `bgSourceAlreadyHasActivity = true` — preventing `cumulativeActivityEffect` from being applied a second time on top of a value that already includes it.

```
smartBG    = bgEst.current_estimated_bg
confidence = 'estimated'
```

> **Why not ignore the reading in preset mode?** "Preset" means the *circadian profile* is used as the pharmacodynamic baseline for chart/effect calculations — it does NOT mean the correction dose should ignore an actual meter reading. Using the raw circadian value when a reading is available would produce a correction dose computed from the wrong BG, potentially ~1.2 u too high.

**No reading available** (fallback path):

```
circadianBG = getCircadianBaseline(localHour, circadian_profile)
pkNet       = cumulativeMealEffect + cumulativeInsulinEffect   (absorbed PK only)
smartBG     = max(40, circadianBG + pkNet)
confidence  = 'circadian'
```

`confidence = 'circadian'` signals that this estimate was built without `cumulativeActivityEffect`, so the activity correction IS applied in Step 4 (`bgSourceAlreadyHasActivity = false`).

---

## 4. Unified Activity Pathway

All activity effects (whether from the form or the backend PD endpoint) now travel through the **same sensitivity multiplier pathway**, bypassing the legacy coefficient system entirely.

```
effectiveActivities = []   // always empty — disables coefficient route (activityImpact = 1.0)

if (savedActivities.length > 0):
    syntheticMult = computeSyntheticSensitivityMultiplier(savedActivities, constants)
    syntheticAOB  = computeSyntheticAOB(savedActivities, constants)

    effectiveSensitivityMult = max(syntheticMult, backendSensitivityMult)
    aobValue                 = pdAOB + syntheticAOB   // sessions are independent
else:
    effectiveSensitivityMult = backendSensitivityMult
    aobValue                 = pdAOB
```

Taking `max()` for the multiplier rather than multiplying prevents double-counting when a manual form entry and a pre-logged PD session happen to overlap in time. AOB values are additive because the sessions deliver distinct, independent BG drops.

---

## 5. Insulin Type Suggestion

Shown in the dose card whenever foods are selected (meal mode) or `absorptionType` prop is provided (standalone insulin input). Driven entirely from `shared-constants.ts` — no hardcoded brand names anywhere in the component.

### 5.1 Dominant Absorption Type

```typescript
getDominantAbsorptionType(foods):
  ABSORPTION_PRIORITY = { very_slow:5, slow:4, medium:3, fast:2, very_fast:1 }
  return foods.reduce(slowest wins by ABSORPTION_PRIORITY)
```

The **slowest food drives the suggestion** because slow-absorbing foods determine the risk window for hyperglycaemia. A meal of white rice (fast) + chickpeas (slow) → suggestion is for `slow`.

> This differs from `calculateTotalNutrients`, which uses a **carb-weighted average** for the actual dose calculation. The two may disagree for heavily mixed meals — that is intentional: the dose reflects the average glycaemic impact, while the type suggestion reflects the *worst-case timing risk*.

### 5.2 Mixed Meal Detection

```typescript
detectMixedMeal(foods):
  MIXED_SLOW = { slow, very_slow }
  MIXED_FAST = { very_fast, fast, medium }
  return hasSlow && hasFast
```

A "mixed meal" (pizza-effect scenario) occurs when the meal contains items from both groups. This overrides the single dominant-type suggestion and triggers the biphasic dosing strategy card.

### 5.3 Insulin Config Lookup

```typescript
insulinSuggestionConfig = ABSORPTION_TO_INSULIN_CONFIG[dominantAbsorption]
```

`ABSORPTION_TO_INSULIN_CONFIG` (from `shared-constants.ts`) maps each absorption type to:
- `label` — human-readable insulin type name (e.g. "Rapid-Acting")
- `color` — hex colour for UI emphasis
- `typeFilter` — array of `medication_factors` type strings to match against
- `preferredKeys` — optional specific medication keys to highlight

Brand names are resolved at render time via `getInsulinBrandNames`, which reads `medication_factors` from the patient's constants (falling back to `SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS`). This keeps brand names in sync with `constants.py` automatically.

---

## 6. Timing & Dosing Strategy UI

The timing card is suppressed when `iobSurplusWarning` is present (no dose needed).

### 6.1 Timing Minutes

```typescript
storedMins = patientConstants.insulin_timing_guidelines[absorptionType]?.timing_minutes
          ?? SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines[absorptionType].timing_minutes
          ?? 10

// Clinical safety floor — prevents server misconfiguration from giving dangerous advice
CLINICAL_MINIMUMS = { slow: 20, very_slow: 30 }
mins = max(storedMins, CLINICAL_MINIMUMS[absorptionType] ?? storedMins)
```

### 6.2 Fast / Medium / Very Fast — Single Line

```
Inject your bolus insulin, then eat your [Meal] [N] min later
// mins = 0 → "then eat immediately"
```

### 6.3 Slow / Very Slow — Three Options (A / B / C)

| Option | Insulin | Strategy |
|--------|---------|----------|
| **A** NovoLog split | Rapid-acting | `firstDose (50%) now → eat in [mins] min`, `secondDose (50%) at +90 min` |
| **B** Regular | Short-acting | Full dose at meal time — no wait, no split |
| **C** NovoLog single | Rapid-acting | Start eating → inject full dose after `afterMealMins` min |

Split dose math avoids double-rounding:
```
firstDose  = round(totalDose × 0.5, 1 decimal)
secondDose = round(totalDose − firstDose, 1 decimal)
```

`afterMealMins` and `tailHours` by type:

| Absorption | Post-meal inject (Option C) | BG high window (Option C) |
|------------|----------------------------|-----------------------------|
| `slow`     | 10 min after eating        | ~1.2 h                      |
| `very_slow`| 30 min after eating        | ~3.0 h                      |

`secondInjectFromMealStart = 90 − mins` shows the minutes between eating and the second injection in Option A.

### 6.4 Mixed Meal — Two Options (A / B)

| Option | Insulin | Strategy |
|--------|---------|----------|
| **A** NovoLog dual split | Rapid-acting | `60% (5 min before eating)` + `40% at +2.5 h after meal start` |
| **B** Regular | Short-acting | Full dose at meal time |

Split math:
```
firstDose  = round(totalDose × 0.6, 1 decimal)
secondDose = round(totalDose − firstDose, 1 decimal)
```

A BG check reminder is appended: "Check BG at +2 h and +5–6 h" to catch the fat-delayed peak at 3–5 h.

---

## 7. Standalone Correction Suggestion (`UnifiedInsulinInput`)

Shown only when `standalone=true`. Uses `buildSuggestion()` to generate a `CorrectionSuggestion` object displayed as `SuggestionCard`.

### 7.1 Active Effects Source

The component prefers an `activeEffectsSnapshot` prop passed by the parent (guarantees bit-for-bit match with `ActiveEffectsDisplay`). When absent, it falls back to its own `useActiveEffects` hook instance.

```
hasSnapshot = !!activeEffectsSnapshot

resolvedEstBG       = snapshot?.estimatedBG        ?? hookEstimatedBG
resolvedProjBG      = snapshot?.projectedFinalBG   ?? hookProjectedFinalBG
resolvedIOB         = snapshot?.totalIOB           ?? hookIOB
resolvedMOB         = snapshot?.totalMOB           ?? hookMOB
resolvedPendingDrop = snapshot?.pendingBGReduction ?? hookIOB × corrFactor
resolvedPendingRise = snapshot?.pendingBGRise      ?? hookMOB × carbToBgFactor
```

### 7.2 Projected BG

```
pendingNetEffect = pendingMealRise − pendingInsulinReduction
projectedBG      = snapshot?.projectedFinalBG
                ?? (estimatedBG !== null ? estimatedBG + pendingNetEffect : null)
```

### 7.3 `buildSuggestion` Decision Tree

```
if estimatedBG === null:
    night? → "No reading — nighttime basal dose likely"  [long-acting]
    day?   → "No BG reading — check before dosing"       [rapid]

if estimatedBG < target − 10  OR  projectedBG < target − 10:
    → "Blood sugar going low — take a snack"             [none]

if projectedBG ≤ target + 20:
    → "It's OK — no correction needed"                   [none]

if estimatedBG ≤ target:
    night? → "BG at target — nighttime basal likely"     [long-acting]
    day?   → "It's OK — no correction needed"            [none]

else (BG high):
    netCorrectionUnits = (projectedBG − target) / corrFactor
    dose = netCorrectionUnits ≥ 1.0 ? round(netCorrectionUnits, 1) : null
    dose ≠ null → "Suggested correction is ~{dose}u Rapid-Acting"   [rapid]
    dose = null → "Correction is small, no dose needed"              [rapid]
```

`projectedBG` already incorporates both `pendingMealRise` and `pendingInsulinReduction`, so the correction formula does **not** double-subtract IOB — the net of all active effects is already baked into the projected value.

The `bgSource` flag adds a "🌙 BG from circadian baseline" note when the mode is `preset`.

---

## 8. IOB Surplus Warning (mobile only; both mobile entry points)

Triggered in the mobile `calculateInsulinDose` when `postActiveTotal < −0.5u` and surfaced in both the MealForm dose card and `UnifiedInsulinInput` (via `iobSurplusWarning` prop). The web frontend and the Python backend do not have this warning (see Step 5b).

**What the patient sees:**
- "⚠️ IOB Covers This Meal" banner with left/right layout.
- Left: "No dose needed, injecting risks a low. Eat glucose tablets, juice, or fruit to offset."
- Right: Two pills — "Surplus Xu" and "Eat Yg" (fast carbs needed to absorb the incoming insulin).

**What is hidden when the warning is active:**
- The bolus insulin type recommendation.
- All timing and dosing strategy cards.

The dose number itself is still shown (0.0 units) so the patient understands the magnitude of the surplus. The warning is triggered by excess active insulin only; it is not a low-glucose or a large-dose warning.

---

## 9. Breakdown UI (`FullInsulinBreakdown`)

The "Show calculation details" toggle in MealForm expands a set of collapsible cards, one per calculation stage:

| Card | Content |
|------|---------|
| **Base Insulin Needs** | Carb equiv breakdown (carbs + protein equiv + fat equiv − fiber deduction), ICR division, exercise sensitivity if applied |
| **Activity Impact** | Percentage reduction from sensitivity multiplier (ODE W-state pathway) |
| **Pharmacodynamic Adjustments** | `absorptionFactor × mealTimingFactor` (currently both 1.0 per JS source) |
| **Current State Correction** | Current BG, target BG, effective CF, correction formula |
| **Active Effects Adjustment** | IOB (units + mg/dL drop), MOB (grams + units), AOB (mg/dL + units), net direction |
| **Predictive Peak Overlap** | MOB and IOB remaining at new meal peak, net BG impact, adjustment factor |
| **Health Factors** | Active conditions + medications with computed multipliers |

---

## 10. Data Flow Summary

```
Foods selected
    │
    ▼
[Gate] constantsLoading || !hasLoadedFromAPI → hold, re-fire when real constants arrive
    │
    ▼
calculateTotalNutrients()
    ├─ Portion scaling (weight / volume)
    ├─ Macro accumulation
    └─ Weighted absorption type
    │
    ▼
BG source resolution (MealForm.performLocalCalculation)
    ├─ 1. Actual meter reading                    (highest confidence)
    ├─ 2. Backend estimated BG ≤ 6 h
    ├─ 3. Backend estimated BG > 6 h              (stale but still useful)
    ├─ 4. target + cumulative effects             (computed fallback)
    └─ 5. raw target_glucose                      (last resort)

    Preset mode split:
    ├─ Reading exists  → backend current_estimated_bg, confidence='estimated'
    │                    bgSourceAlreadyHasActivity=true → activity not re-applied
    └─ No reading      → circadianBG + pkNet, confidence='circadian'
                         bgSourceAlreadyHasActivity=false → activity applied in Step 4
    │
    ▼
Unified Activity Pathway
    ├─ Manual activities → computeSyntheticSensitivityMultiplier (W-state ODE)
    │     Y = low-pass filter of excess HR
    │     Z = binary gate (saturates to 1 during exercise)
    │     W = ∫Y dt during exercise, decays with τ_W in recovery
    │     multiplier = 1 + min(α × W × (1 + Z), max_boost)
    │     Multiple sessions → max() across sessions, not additive sum
    ├─ Manual activities → computeSyntheticAOB (Z-state ODE)
    │     Z-integral over (durationMins + 4·τ_Z), remaining fraction only
    │     Multiple sessions → summed independently
    └─ max(syntheticMult, backendMult),  pdAOB + syntheticAOB
    │
    ▼
calculateInsulinDose()
    ├─ Step 1: carb equivalents (carbs + protein×0.5 + fat×0.2 − fiber×1.0)
    ├─ Step 2: baseInsulin = totalCarbEquiv / ICR
    ├─ Step 3a: × activityImpact (always 1.0 in unified pathway)
    ├─ Step 3b: ÷ sensitivityMultiplier,  effectiveCF = CF × mult
    ├─ Step 4: correctionInsulin = (BG − target) / effectiveCF
    ├─ Step 5: − IOB + MOB_equiv − AOB_equiv  →  postActiveTotal
    ├─ Step 5b: iobSurplusWarning if postActiveTotal < −0.5
    ├─ Step 6: × overlapAdjustmentFactor [0.5–1.5]
    ├─ Step 7: × healthMultiplier (conditions + medications)
    └─ Step 8: below min_dose_units → 0 u, else round DOWN to the device step (pen 0.5 u / pump 0.1 u)
    │
    ▼
Dose card render
    ├─ Warning banner (stale BG / no data)
    ├─ IOB surplus banner  ──→  hide type + timing, show "Eat Xg" instead
    ├─ Line 1: dose value + absorption type label
    ├─ Line 2: 💉 Bolus insulin type (from ABSORPTION_TO_INSULIN_CONFIG)
    └─ Line 3+4: Timing strategy
           ├─ fast/medium/very_fast  →  single timing line
           ├─ slow/very_slow         →  Options A (split) / B (Regular) / C (post-meal)
           └─ mixed meal             →  Options A (dual 60/40 split) / B (Regular)
```
