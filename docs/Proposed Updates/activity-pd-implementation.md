# Activity Pharmacodynamics — Implementation Overview

## Model

The activity effect is computed using a **heart-rate-driven ODE model** (Y/Z/W state variables, Euler integration) based on Romeres et al. (2021). Three states are tracked per session:

* **Y** — HR-driven acute glucose uptake signal
* **Z** — lagged glucose disposal (τ\_Z = 10 min)
* **W** — post-exercise GLUT4 sensitivity window (τ\_W = 90 min)

When a wearable HR trace is available the model runs on actual BPM data (`hr\_ode` path). Without it, a synthetic HR curve is generated from intensity tier (`synthetic\_hr` path). All model parameters come from `SHARED\_CONSTANTS.HR\_MODEL` — nothing is hardcoded.

\---

## Backend (`activity\_pharmacodynamics.py` + routes)

**Three endpoints:**

|Endpoint|Method|Purpose|
|-|-|-|
|`/api/activity/pharmacodynamics`|GET|Stacked effect for all sessions in today's window|
|`/api/activity/pharmacodynamics/aob`|GET|Per-session Activity On Board (AOB) breakdown|
|`/api/activity/pharmacodynamics/preview`|POST|Simulate a hypothetical session without persisting|

**Key outputs from the stacked endpoint:**

* `cumulative\_activity\_effect` — signed net BG shift (mg/dL). Negative = aerobic/BG-lowering.
* `sensitivity\_multiplier` — post-exercise ISF/CR boost ≥ 1.0, taken as `max()` across sessions (GLUT4 receptors don't stack additively).
* `activity\_on\_board` — unsigned remaining acute BG drop still to be delivered, summed across sessions.
* `activity\_contributions` — per-session breakdown including `absorbed\_fraction`, `remaining\_bg\_drop`, `is\_active`, `model`, `bg\_direction`.
* `effective\_correction\_factor` / `effective\_carb\_to\_bg\_ratio` — ISF/CR pre-scaled by `sensitivity\_multiplier`. Consumers must **not** re-apply the multiplier.

**Caching:** Results are cached server-side with a 60-second TTL per user. The cache is invalidated when a session ends via `watch\_hr\_routes`.

**Daily window:** Accounts for the patient's timezone offset and `daily\_reset\_hour`. Sessions from the previous reset to now are included.

**`bg\_direction`:** Each session carries a sign flag (`-1` aerobic / `+1` anaerobic-stress). The effect is applied with the correct sign — the model supports BG-raising sessions.

\---

## Native Frontend

### API layer — `activity-pharmacodynamics.ts`

Thin typed wrappers over the three backend endpoints using `apiClient`. `fetchStackedActivityEffectSafe()` catches all errors and returns `null` so callers never need a try/catch — a `null` result is treated as zero effect throughout the pipeline.

### Data flow

```
fetchData() in useActiveEffects
    └─ Promise.all(\[meals, insulin, reading, activityPD])   ← 30s debounced
            │
            ▼
    calculateEffects()
        ├─ dynamic mode:  calculateNetEffect(..., activityPD)  ← net-effect.ts wrapper
        │                 → estimatedBG already includes cumulative\_activity\_effect
        │                 → projectedFinalBG rebuilt with effective ISF/CR
        │
        └─ preset mode:   circadianBG + pkCumulative + cumulativeActivityEffect
                          → projectedFinalBG rebuilt with effective ISF/CR
```

### `useActiveEffects.ts`

* Fetches `API.ACTIVITY\_PD.STACKED` concurrently with meals/insulin/reading in a single `Promise.all`.
* **30-second client-side debounce** (`lastActivityPDFetchMs` ref) prevents hammering the ODE endpoint on rapid re-renders. Debounce resets to 0 on `refresh()` so post-session updates always fire immediately.
* Exposes `activityPDResult` on the return value so child chart components can consume it without a second API call.
* Activity fields returned: `activityEffect`, `sensitivityMultiplier`, `activityOnBoard`, `activityContributions`, `activityPDResult`.

### `net-effect.ts` wrapper

Canonical integration point for activity into the BG estimate:

```
estimatedBG = (core meal+insulin result) + cumulative\_activity\_effect
```

`useActiveEffects` imports `calculateNetEffect` from here (not from `blood-glucose-estimation`) so the integration is in one place.

### `ActiveEffectsDisplay.tsx`

* Fetches `API.ACTIVITY\_PD.STACKED` independently on its own 60-second minute-aligned tick.
* Renders an **AOB card** (hidden when `cumulativeActivityEffect === 0` AND `activityOnBoard === 0` AND `sensitivityMultiplier ≤ 1.005`).
* Uses `effectiveCorrectionFactor` / `effectiveCarbToBgRatio` from the PD response for the pending IOB/MOB projection when sensitivity is elevated — the multiplier is **not** re-applied locally.
* Applies a `1.005` floating-point noise threshold before showing the sensitivity badge.

### `EffectsVisualizationChart.tsx`

* Receives `activityPD` as a prop (preferred) or falls back to `hookActivityPD` from its internal `useActiveEffects` instance.
* **`calculateActivityEffectAtTime()`** — per-chart-point activity curve:

  * *During session:* linear ramp 0 → `cumulative\_bg\_effect` (valid approximation for Y/Z ODE states).
  * *Post-exercise:* **exponential decay** `exp(−t / τ\_W)` with τ\_W = 90 min. Matches the backend W-state ODE; replaces the previous linear recovery which produced a hard kink at `end + τ\_W`.
* Activity is baked into `cumulativeNetBaseline` (green prediction line = full BG shift including exercise) **and** returned separately as `activityEffect` (teal overlay = isolated exercise signal). This is intentional — not double-counting.
* Session markers (`sessionMarkers`) and duration bands (`sessionDurationAreas`) are rendered at session start times.

\---

## Sign Convention (critical — applies everywhere)

`cumulative\_activity\_effect` is **always added, never subtracted**. It is pre-signed:

* Aerobic / BG-lowering → negative value → adding it lowers BG ✓
* Anaerobic / stress / BG-raising → positive value → adding it raises BG ✓

`effective\_correction\_factor` and `effective\_carb\_to\_bg\_ratio` from the PD response are **pre-multiplied/divided** by the backend. Re-applying `sensitivity\_multiplier` locally would double-scale them.

\---

## Known Gaps

|ID|Issue|Where|
|-|-|-|
|D-3|`ActiveEffectsDisplay` and `EffectsVisualizationChart` can both fetch the PD endpoint independently on the same screen if `activityPDResult` is not prop-drilled from a common parent|`ActiveEffectsDisplay.tsx`|
|D-4|`simpleProjectedFinalBG` is computed identically to `projectedFinalBG` — the distinction was never implemented|`ActiveEffectsDisplay.tsx` L577–578|
|React D-1|`getActivityOnBoard()` in `activityPharmacodynamics.js` (React frontend) skips the `bg\_drop\_override` path present in the Python backend|React only|



