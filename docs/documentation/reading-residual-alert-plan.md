# Reading-Residual Alert System — Analysis & Implementation Plan

## 1. What `readingResidual` Actually Measures

In **preset (circadian) mode**, the reading residual is computed once per fetch cycle inside `ActiveEffectsDisplay.fetchAndCalculate()`:

```
readingResidual = recentReading.bloodSugar
                − circadianAtReading          // circadian profile value at the hour the reading was taken
                − cumulAtReadingNet           // net PK effect of all logged meals + insulin at reading time
```

In plain English: **it is the portion of the measured BG that no logged event and no circadian curve can account for.**

If the model explains 98 mg/dL and the meter said 138 mg/dL, the residual is +40 mg/dL. Those 40 mg/dL came from somewhere the system does not know about.

### Sign semantics

| Sign | Meaning | Most likely cause |
|---|---|---|
| Positive (`residual > 0`) | BG is **higher** than the model predicts | Unlogged meal / snack, underestimated portion, illness/stress hyperglycaemia |
| Near zero (`|residual| < 20`) | BG matches model within noise | Normal — no action needed |
| Negative (`residual < 0`) | BG is **lower** than the model predicts | Unlogged insulin dose, unlogged exercise/activity, overestimated meal portion |

### Converting to actionable units

Because the residual is expressed in mg/dL, it can be translated into approximate carb or insulin equivalents using the patient's own constants — making it directly interpretable:

```
// Positive residual → carb equivalents
unloggedCarbsEstimate = residual / carb_to_bg_factor       // e.g. +40 / 4 = ~10 g carbs

// Negative residual → insulin equivalents
unloggedInsulinEstimate = |residual| / correction_factor   // e.g. -40 / 40 = ~1 u insulin
```

---

## 2. How `readingResidual` Is Currently Used in Calculations

### 2.1 `correctedEstimatedBG` — the primary downstream effect

The residual is added directly to the current BG estimate inside `fetchAndCalculate()`:

```ts
correctedEstimatedBG = correctedEstimatedBG_raw + readingResidual
// where:
// correctedEstimatedBG_raw = stableBaseline + cumulativeNetBaseline + activityDeltaSinceReading
```

This means the residual is **forward-propagated in time** as a constant offset. Every subsequent `estimatedBG` displayed in the three-card row includes it. The assumption is that the unexplained gap reflects a stable physiological shift (e.g. a meal that was eaten but not logged) rather than a transient fluctuation.

### 2.2 `simpleProjectedFinalBG`

```ts
simpleProjectedFinalBG = correctedEstimatedBG + frontendPendingNetEffect
```

Because `correctedEstimatedBG` carries the residual, the projected BG also carries it. A large positive residual therefore inflates both the "Estimated Now" and "Projected" cards.

### 2.3 `safetyStatus` / critical-low detection

```ts
safetyStatus: bgToSafetyStatus(correctedEstimatedBG)
```

The safety alert ("CRITICAL LOW") fires against `correctedEstimatedBG`, which includes the residual. A large negative residual can therefore trigger a critical-low warning even when the reading itself was not low — which may be valid (the patient may have taken unlogged insulin) but should be noted.

### 2.4 `MealForm` correction dose (post-fix)

After the fix landed in `MealForm.loadActiveInsulin()`, `bgEst.current_estimated_bg` (the backend's reading-anchored value, which already incorporates the residual) is used directly as `smartBG`. The correction dose is therefore:

```
correctionInsulin = (smartBG − target) / effectiveCF
```

A +40 mg/dL residual adds 1 unit of correction insulin. A −40 mg/dL residual removes 1 unit. The residual already has the correct clinical effect on dosing — **the gap is not only being displayed, it is actively shaping the suggested dose.**

### 2.5 Current display location

`readingResidual` is stored in `data.baseline.readingResidual` and is currently surfaced only in the **expanded formula strip** under "More details" on the "Estimated Now" card, labelled as `Δresid` in the formula:

```
circadian + Δnow + Δresid = est.
```

It appears as a signed number in the formula row, colour-coded orange (positive) or green (negative). There is no dedicated banner, no explanation of why it exists, and no guidance about what the patient should do.

### 2.6 Dynamic mode equivalent

Dynamic mode has no explicit `readingResidual` field. Instead, `calculateStableBaselineFromReading()` unwinds all logged effects from the reading value to derive a `stableBaseline`. If that baseline falls below physiological range, the existing **"Baseline Capped"** (`hard_clamped`) and **"Low Baseline Detected"** (55–75 mg/dL) banners fire. Those banners are functionally equivalent to a large negative residual detection — they already show meal / insulin / activity log-check hints. The plan below is therefore **preset mode only** to avoid duplication.

---

## 3. Why Threshold-Based Alerting Is Worth Adding

The residual already controls the estimate and the correction dose silently. The patient sees a number move but has no explanation. When the residual is large, the system is essentially compensating for a logging gap that the patient does not know exists — and the compensation directly alters insulin suggestions. Making this visible:

- Closes the gap between "the app suggests X" and "I understand why"
- Catches logging errors before they accumulate across multiple calculation cycles
- Is clinically grounded: the residual is expressed in units (carb grams, insulin units) the patient already understands
- Prevents a compounding problem — a large persistent positive residual inflates every correction dose until a new reading resets it

---

## 4. Proposed Threshold Tiers

Based on typical glucometer measurement error (±10–15 mg/dL) and normal BG variability around the circadian curve (±15–20 mg/dL), a 20 mg/dL dead zone is appropriate before alerting.

| Tier | Condition | Display level | Rationale |
|---|---|---|---|
| **Noise** | `|residual| < 20 mg/dL` | None | Within glucometer precision + normal variability |
| **Soft** | `20 ≤ |residual| < 50 mg/dL` | Inline note below formula strip | Worth noting; ~5–12 g carbs or ~0.5–1.25 u insulin unaccounted |
| **Strong** | `50 ≤ |residual| < 100 mg/dL` | Amber banner | ~12–25 g carbs or ~1.25–2.5 u insulin — likely a missed snack or dose |
| **Critical** | `|residual| ≥ 100 mg/dL` | Red banner | ≥25 g carbs or ≥2.5 u insulin — likely a full missed meal or significant dose |

The 50 mg/dL boundary translates to approximately one slice of bread (~12 g carbs) or one correction unit of insulin — the minimum logging gap a patient would realistically want to know about.

---

## 5. Directional Message Logic

The alert message should combine the residual sign, its magnitude in translated units, and the current log state to produce a specific, actionable hint rather than a generic warning.

```ts
function classifyResidual(
  residual: number,
  mealsCount: number,
  dosesCount: number,
  carbToBgFactor: number,
  correctionFactor: number,
): ResidualClassification {

  if (Math.abs(residual) < 20) return { tier: 'noise' };

  const tier =
    Math.abs(residual) >= 100 ? 'critical' :
    Math.abs(residual) >= 50  ? 'strong'   : 'soft';

  if (residual > 0) {
    // BG higher than model → unlogged carbs / elevated glucose
    const carbEquiv = Math.round(residual / carbToBgFactor);
    return {
      tier,
      direction: 'high',
      title:   tier === 'soft'
                 ? 'BG slightly above model'
                 : 'BG unexpectedly high',
      body:
        mealsCount === 0
          ? `No meals are logged today. Your BG is ~${carbEquiv} g of carbs higher than the circadian profile predicts — did you eat a meal or snack that wasn't logged?`
          : `Your logged meals account for most of your BG, but ~${carbEquiv} g of carbs (roughly ${Math.round(carbEquiv / 15)} small snack${Math.round(carbEquiv / 15) !== 1 ? 's' : ''}) appear unlogged. Check portion sizes or look for an unlogged snack.`,
      hint:  'Possible causes: unlogged meal · inaccurate portion · illness / stress',
    };
  } else {
    // BG lower than model → unlogged insulin / unlogged activity
    const insulinEquiv = Math.abs(residual) / correctionFactor;
    const activityEquiv = Math.round(Math.abs(residual) / 5); // rough: ~5 mg/dL per min moderate exercise
    return {
      tier,
      direction: 'low',
      title:   tier === 'soft'
                 ? 'BG slightly below model'
                 : 'BG unexpectedly low',
      body:
        dosesCount === 0
          ? `No insulin is logged today. Your BG is ~${insulinEquiv.toFixed(1)} units of insulin lower than expected — did you take a dose that wasn't logged?`
          : `Your logged insulin explains most of your BG, but ~${insulinEquiv.toFixed(1)} units of insulin (or ~${activityEquiv} min of moderate exercise) appear unaccounted for. Check if a dose or activity session was missed.`,
      hint:  'Possible causes: unlogged insulin dose · unlogged exercise · overestimated meal',
    };
  }
}
```

---

## 6. Where to Add the Alert in `ActiveEffectsDisplay`

### Render position

The alert should appear between the **baseline mode badge** and the **three-card BG row**, inside the existing scroll view. This is the same zone where the existing `clampBanner` and soft-baseline banner live. Ordering within that zone:

1. `clampBanner` (hard clamp — dynamic mode only) — already exists
2. Soft baseline warning (55–75 mg/dL — dynamic mode only) — already exists
3. **`ResidualAlertBanner`** (residual threshold — preset mode only) — new
4. `unreliableBanner` (`estimatedBG < 10`) — already exists
5. Three-card BG row

The residual banner fires **only when**:
- `resolvedMode === 'preset'`
- `data.baseline?.readingResidual != null`
- `Math.abs(data.baseline.readingResidual) >= 20`
- `!estimateIsUnreliable` (avoid stacking with the unreliable banner)

### Component shape

```tsx
{data.baseline?.isPreset &&
 data.baseline?.readingResidual != null &&
 Math.abs(data.baseline.readingResidual) >= 20 &&
 !estimateIsUnreliable && (() => {
   const cls = classifyResidual(
     data.baseline.readingResidual,
     data.metadata.mealsCount,
     data.metadata.dosesCount,
     data.aob.effectiveCarbToBgRatio,   // already in data.aob
     data.aob.effectiveCorrectionFactor,
   );
   if (cls.tier === 'noise') return null;

   const isHigh = cls.direction === 'high';
   const bannerColor = cls.tier === 'critical' ? '#fce4ec' : '#fff8e1';
   const borderColor = cls.tier === 'critical' ? '#c62828' : '#f9a825';
   const titleColor  = cls.tier === 'critical' ? '#b71c1c' : '#e65100';

   return (
     <View style={[styles.clampBanner, { backgroundColor: bannerColor, borderLeftColor: borderColor }]}>
       <View style={styles.clampBannerRow}>
         <Text style={styles.clampBannerIcon}>{isHigh ? '🍽️' : '💉'}</Text>
         <View style={styles.clampBannerTextCol}>
           <Text style={[styles.clampBannerTitle, { color: titleColor }]}>
             {cls.title}
           </Text>
           <Text style={styles.clampBannerBody}>
             Reading residual:{' '}
             <Text style={[styles.clampBannerHighlight, { color: titleColor }]}>
               {data.baseline.readingResidual >= 0 ? '+' : ''}
               {data.baseline.readingResidual.toFixed(0)} mg/dL
             </Text>
             {' '}unexplained by circadian profile + logged entries.
           </Text>
           <Text style={[styles.clampBannerReason, { marginTop: 4 }]}>
             {cls.body}
           </Text>
           <Text style={[styles.clampBannerReason, { marginTop: 4, color: '#888' }]}>
             {cls.hint}
           </Text>
         </View>
       </View>
     </View>
   );
 })()
}
```

---

## 7. What Needs to Change in the `ActiveEffectData` Type

`readingResidual` is already stored in `data.baseline.readingResidual` (line 853 of `ActiveEffectsDisplay.tsx`). No new field is needed. The `ActiveEffectData` interface already has:

```ts
baseline?: {
  // ...
  readingResidual: number | null;  // ← already exists, preset mode only
}
```

The `classifyResidual()` function needs `carbToBgFactor` and `correctionFactor`. Both are already computed in `fetchAndCalculate()` as `rawCarbFactor` / `rawCorrFactor` and stored in `data.aob.effectiveCarbToBgRatio` / `data.aob.effectiveCorrectionFactor` — no new state required.

---

## 8. How `readingResidual` Flows Into the MealForm Correction Dose (post-fix)

After the fix to `MealForm.loadActiveInsulin()`, the correction dose path in preset mode when a reading is available is:

```
bgEst.current_estimated_bg       ← backend value, reading-anchored
  = getActiveEffectsFull(...)     ← this is the backend's own net-effect estimate
                                     which includes the residual implicitly

setEstimatedBG({ value: bgEst.current_estimated_bg, confidence: 'estimated', ... })

// in performLocalCalculation:
smartBG = estimatedBG.value       ← = bgEst.current_estimated_bg (includes residual)
bgSource = 'estimated'
bgSourceAlreadyHasActivity = true ← confidence !== 'circadian'

// correctionInsulin uses smartBG, so it benefits from the residual correction.
correctionInsulin = (smartBG − target) / effectiveCF
```

However there is an important caveat: **the backend's `current_estimated_bg` may not compute the residual using the same formula as `ActiveEffectsDisplay`** (which does it entirely on the frontend). The backend's dynamic estimate is a reading-decay model, not a circadian+residual model. In practice the values will be close but not identical. The residual banner in `ActiveEffectsDisplay` is therefore the authoritative diagnostic signal; the correction dose in `MealForm` benefits from the reading anchor but does not independently compute or display the residual.

A future improvement (out of scope for this plan) would be to have `MealForm` receive `readingResidual` from `ActiveEffectsDisplay` via shared state (e.g. Zustand) rather than computing its BG estimate independently from the backend. This would make the correction dose exactly consistent with the displayed BG estimate.

---

## 9. Edge Cases and Guards

### 9.1 Stale reading
If `minutesSinceReading` is large (e.g. > 120 min), the residual becomes less reliable because BG has drifted since the reading. The banner should note reading age:

```ts
// Add to cls.body when minutesSinceReading > 120:
`(Note: this reading is ${minutesSinceReading} min old — residual reliability decreases over time.)`
```

`minutesSinceReading` is available in `data.baseline.readingTimestamp` — compute it at render time: `Math.round((Date.now() − parseUTCMs(data.baseline.readingTimestamp)) / 60_000)`.

### 9.2 Activity overlap
When `data.metadata.activityOverlapWarning` is true, the reading was taken during or after an exercise session. The exercise effect may not be fully unlogged and could explain some of the negative residual. In this case, suppress the "unlogged insulin" hint for negative residuals and substitute:

```
'The reading was taken during or after an exercise session — part of this gap may reflect exercise-induced BG lowering already captured by the activity tracker.'
```

### 9.3 First reading of the day
`cumulAtReadingNet` will be zero or near-zero if no meals or insulin have been logged before the reading. A large positive residual in this case is likely a true deviation from the personal circadian curve (e.g. dawn phenomenon variance or a night snack), not a logging error. The banner body should reflect this:

```ts
if (mealsCount === 0 && dosesCount === 0 && residual > 0) {
  body = `This is your first logged entry today. Your BG is ${residual.toFixed(0)} mg/dL above your circadian profile — this may reflect normal morning variance (dawn phenomenon) or an unlogged overnight snack.`;
}
```

### 9.4 Banner priority with existing alerts
The three existing banners (`clampBanner`, soft-baseline, `unreliableBanner`) are dynamic-mode or extreme-estimate signals. The residual banner is preset-mode specific and fires in a normal operating range. They do not logically conflict, but stacking multiple banners is visually noisy. Priority rule:

- If `estimateIsUnreliable` → show unreliable banner only (replaces BG cards entirely — moot)
- If `clampStatus === 'hard_clamped'` → dynamic mode only, cannot coincide with residual banner
- Residual banner + activity overlap warning can coexist (short inline text below, not a full banner)

---

## 10. Implementation Checklist

### `ActiveEffectsDisplay.tsx`

- [ ] Add `classifyResidual()` helper function (can be a module-level function above the component, or a separate utility file in `utils/glucose/`)
- [ ] Add `ResidualAlertBanner` render block in the existing banner zone (after soft-baseline warning, before `unreliableBanner`)
- [ ] Thread `minutesSinceReading` into the classification for stale-reading note
- [ ] Handle `activityOverlapWarning` to soften negative-residual messaging
- [ ] Handle the first-reading-of-day edge case (no meals, no doses, positive residual)
- [ ] No type changes needed — `readingResidual` is already in `data.baseline`

### `ActiveEffectsDisplay` — types (no changes needed)

`readingResidual: number | null` is already in the `baseline` field of `ActiveEffectData`. `effectiveCarbToBgRatio` and `effectiveCorrectionFactor` are already in `data.aob`.

### `MealForm.tsx` (informational only — no change needed)

The `readingResidual` value does not need to be explicitly used in `MealForm` — the correction dose already benefits from it implicitly via `bgEst.current_estimated_bg`. Future work could surface it in the "Current State Correction" breakdown card (e.g. "BG estimate includes +40 mg/dL residual from circadian model") but this is cosmetic.

### No backend changes needed

`readingResidual` is a purely frontend computation inside `ActiveEffectsDisplay.fetchAndCalculate()`. The backend is not involved.

---

## 11. Summary

`readingResidual` is the signed difference between what the patient actually measured and what the full model (circadian profile + all logged meals + all logged insulin) predicts. It propagates forward into every BG estimate, every projected value, and every correction dose. A large value almost always indicates a logging gap.

The current code computes the residual correctly and uses it silently in all estimates. The only missing piece is surfacing it to the patient when it exceeds the noise floor (20 mg/dL), with a directional message that names the specific likely cause (unlogged meal vs. unlogged insulin vs. unlogged activity) and translates it into familiar units (carb grams or insulin units).

The banner system already exists for similar cases (dynamic-mode baseline clamping). The residual alert fits naturally into the same visual pattern and requires no new state, no new API calls, and no type changes — only a new classification function and a conditional render block.
