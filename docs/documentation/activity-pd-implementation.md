# Activity Pharmacodynamics — Detailed Implementation Reference

> **Scope:** Backend ODE engine · Flask API layer · Watch HR integration · auto-segmentation · Frontend service layer
> **Version:** 2.4 (backend) / 2.4 (frontend TypeScript)
>
> **Changelog from v2.3/2.2:**
> - Bug 1/2/13 resolved: ODE W-state rewritten — Z is now a binary saturation gate (not smooth);
>   W accumulates ∫Y dt (not a×Z); W decay applies only in recovery; integration extends past
>   durationMins to include elapsed recovery time at the moment of the dose calculation.
> - Bug 16 resolved: Multiple sessions use `max()` across W-states for sensitivity_multiplier
>   (GLUT4 receptors do not stack additively). Frontend now matches backend.
> - Bug 6 resolved: FIBER_FACTOR corrected to 1.0 in meal carb-equivalent calculation.
> - Bug 5 resolved: `carb_to_bg_factor` null-state fallback corrected from 20 → 4.0 in
>   `EffectsVisualizationChart`.
> - Bug 3/8 resolved: Trend arrow now uses instantaneous gamma-PDF rate (totalActiveEffect),
>   not cumulative absorbed amount (totalBGElevation).
> - Bug 7 resolved: Teal activity line decays with τ_Z immediately at exercise end; the
>   τ_W plateau is isolated to the sensitivity multiplier overlay only.
> - Fix C-1 / 11.5: `fetchStackedActivityEffectSafe()` added — non-throwing wrapper returns
>   null on any error; null is treated as zero effect throughout the pipeline.
> - **Cross-file audit fix (2026):** `computeSyntheticSensitivityMultiplier` in
>   `insulinCalculationService.ts` corrected from `α × W` to `α × W × (1 + Z)`, matching
>   the Python backend and `activity-pharmacodynamics.ts`. The missing `(1 + Z)` factor caused
>   up to 50% underestimation of the sensitivity boost during active exercise (Z ≈ 1).
>   Frontend formula now matches backend exactly. Tracked as closed item TS-α in §9.
> - **Audit fix Goal-4 (2026):** `ActiveEffectsDisplay.calculateNetEffect` (Step 9) now
>   receives `activityPD` as its 7th argument. Previously `resetHour` occupied that slot,
>   so the trend arrow never saw exercise data — it could show `↗ rising` during a vigorous
>   run when BG was actually falling. Tracked as closed item Goal-4 in §9.
> - **Audit fix Goal-5 (2026):** `EffectsVisualizationChart.generateChartData` now gates on
>   `hasLoadedFromAPI` (aliased `patientConstantsReady`). The previous `!patientConstants`
>   guard was always false because `patient.store` pre-populates with defaults immediately,
>   producing a visible chart line discontinuity on every load. Tracked as closed item Goal-5 in §9.

---

## Table of Contents

1. [Physiological Model](#1-physiological-model)
2. [ODE Engine — `activity_pharmacodynamics.py`](#2-ode-engine)
3. [Flask API — `activity_pharmacodynamics_routes.py`](#3-flask-api)
4. [Watch HR Session Flow — `watch_hr_routes.py`](#4-watch-hr-session-flow)
5. [Continuous HR Auto-Segmentation — `watch_hr_autosegment.py`](#5-continuous-hr-auto-segmentation)
6. [API Service Layer — `activity-pharmacodynamics.ts`](#6-api-service-layer)
7. [Sign Convention](#7-sign-convention)
8. [Data Flow Diagrams](#8-data-flow-diagrams)
9. [Known Gaps & Open Issues](#9-known-gaps--open-issues)

---

## 1. Physiological Model

### Overview

The activity effect uses a **heart-rate-driven ODE model** derived from the Dalla Man / Breton / Cobelli physiological framework (Cobelli 2009; Romeres 2021). It replaces the previous categorical Gaussian model. The model is bimodal — it captures two distinct physiological mechanisms:

| Mechanism | State Variable | Time Constant | Output |
|---|---|---|---|
| **Acute IIRd** — insulin-*independent* glucose uptake via contracting muscles (GLUT4 transport) | `Z` | τ_Z = 10 min (decay after exercise) | `cumulative_activity_effect` (signed mg/dL) |
| **Prolonged IDRd** — insulin-*dependent* sensitivity boost from GLUT4 upregulation | `W` | τ_W = 90 min (recovery decay) | `sensitivity_multiplier` on ISF and CR |

### State Variables

Three coupled states are Euler-integrated at dt = 1 min per session:

```
Y  (HR filter signal — energy expenditure proxy)
   dY/dt = (hrAbove − Y) / τ_HR
   where hrAbove = max(0, HR_bpm − HR_base)   (excess HR; 0 after exercise ends)
   Y ≥ 0

Z  (binary saturation gate — acute IIRd signal)
   dZ/dt = (1 − Z)   while inExercise AND Y > a·HR_base   (saturates to 1)
         = (−Z / τ_Z)  otherwise                            (decays back to 0)
   Z ∈ [0, 1]

W  (cumulative load integral — GLUT4 upregulation proxy)
   dW/dt = Y           during exercise   (accumulates area under Y curve)
         = (−W / τ_W)  in recovery       (decays only after exercise ends)
   W ≥ 0
```

`Y` acts as a low-pass filter with τ_HR = 5 min on the HR signal above resting. It prevents instantaneous spikes from the HR trace having a disproportionate effect on Z and W.

`Z` uses a **binary onset criterion**: the exercise effect "switches on" (dZ/dt = 1 − Z) only once Y crosses `a·HR_base` (threshold = 5% of resting HR), protecting against artefactual start-of-session noise. Z is not a smooth curve — it saturates to 1 within approximately one integration step once the threshold is met.

`W` accumulates the area under the `Y` curve (not `a × Z`). This encodes both intensity and duration jointly, which is the physiological basis for the prolonged post-exercise sensitivity window. W decays only in recovery — during exercise it accumulates monotonically.

**Multiple sessions:** `sensitivity_multiplier` takes the **max** across all sessions because GLUT4 receptors are already upregulated — a second session does not produce additional receptor upregulation beyond what the strongest session already achieved. `cumulative_activity_effect` (acute BG drop) is **summed** across sessions.

### Fixed ODE Parameters

All are population values from the literature — patient physiology is handled separately via `hr_base`, `hr_max`, and `weight_kg` in patient constants, not by changing these:

```python
HR_MODEL = {
    "tau_HR":                5.0,    # Y low-pass filter (min)
    "tau_Z":                10.0,    # Z post-exercise decay (min)
    "tau_W":                90.0,    # W sensitivity recovery (min)
    "a":                    0.05,    # exercise-onset threshold (fraction of HR_base)
    "alpha":                0.0008,  # W → sensitivity multiplier scaling
    "max_sensitivity_boost": 0.60,   # hard cap at +60% ISF/CR boost
    "dt":                   1.0,     # Euler step (min)
    "acute_rate_per_min":   0.15,    # mg/dL drop per minute at Z = 1
    "hr_max_pop":          190.0,    # population reference HRmax
    "hr_base_pop":          70.0,    # population resting HR
}
```

### Patient Constants Consumed

Read from `patient_constants` dict, populated by `constants.py`:

| Field | Description | Default |
|---|---|---|
| `weight_kg` | Used for allometric BG-drop scaling: `drop × (70 / weight)^0.25` | 70.0 kg |
| `hr_base` | Patient resting HR | 70.0 bpm |
| `hr_max` | Patient maximum HR | 190.0 bpm |
| `correction_factor` | ISF — multiplied by `sensitivity_multiplier` | — |
| `carb_to_bg_ratio` / `carb_to_bg_factor` | CR — divided by `sensitivity_multiplier` | — |

### HR Trace Priority

The model runs on one of two HR trace paths, determined at record time:

1. **`hr_ode` path** — wearable `hr_trace` array (`[{t_min, hr_bpm}]`) is present on the activity record. The actual measured HR values drive the ODE.
2. **`synthetic_hr` path** — no wearable data. A synthetic trace is built from intensity tier, `hr_base`, `hr_max`, and duration: 2-min ramp-up to peak HR, then a flat plateau to `duration_minutes`. This path is fully supported and physiologically plausible.

```
Synthetic HR peak = hr_base + fraction × (hr_max − hr_base)

Intensity fractions:
  light    = 0.50   (~50% HRmax, ~130 bpm at population defaults)
  moderate = 0.65   (~65% HRmax, ~154 bpm)
  vigorous = 0.80   (~80% HRmax, ~178 bpm)
```

Each activity's `activity_contributions` entry includes a `model` field (`"hr_ode"` or `"synthetic_hr"`) so callers can distinguish the two paths.

### Intensity Levels & Legacy Mapping

New-style records carry `intensity: "light" | "moderate" | "vigorous"`. Legacy records carry an integer `level` field mapped as:

| Level | Intensity | Notes |
|---|---|---|
| `-2` | `None` — skipped | Sedentary/illness mode — affects insulin coefficients but no exercise effect |
| `-1` | `None` — skipped | Below-normal activity — same as above |
| `0` | `light` | Normal activity: daily walking, standing tasks |
| `1` | `moderate` | High activity: jogging, cycling, swimming |
| `2` | `vigorous` | Vigorous: HIIT, fast running, competitive sport |

`normalize_activity_record()` handles the conversion and returns `None` for sedentary levels.

---

## 2. ODE Engine

**File:** `utils/activity_pharmacodynamics.py`
**Version:** 2.3

This module is the single authoritative source for all BG effect calculations. It contains no Flask code — it is purely a computation library imported by the routes layer.

### `normalize_activity_record(raw) → dict | None`

Converts a raw MongoDB `activities` document into the standard `ActivityLog` format expected by all downstream functions. Handles both new-style (`intensity` string) and legacy (`level` integer) records. Returns `None` for sedentary/sick levels (levels ≤ −1) so the caller never needs to filter them out.

**Field resolution order:**

- **Intensity:** `intensity` string field → `LEVEL_TO_INTENSITY[level]` → `None` (skip)
- **Start time:** `startTime` → `completedTime` → `timestamp` → skip if none present
- **Duration:** `duration_minutes` (direct) → `endTime − startTime` → `duration` ("HH:MM" string) → 30 min fallback

A `duration_minutes = 0` edge case is explicitly handled with a warning log — it is clamped to 1.0 by `max()` downstream rather than silently producing phantom zero-duration sessions.

**Passthrough fields** (copied if present): `hr_trace`, `hr_base`, `hr_max`, `bg_drop_override`.

### `calculate_activity_cumulative_effect(activity, current_time, patient_constants) → float`

Returns the **signed** net BG effect of a single activity session up to `current_time` in mg/dL. Sign is controlled by `activity['bg_direction']` (default −1 = aerobic/lowering).

**Two computation paths:**

**1. `bg_drop_override` path (CGM-measured):** When a CGM-confirmed drop magnitude is present on the record, the ODE is bypassed entirely. The effect is absorbed linearly over `duration_minutes + 40%` tail:

```
fraction = min(1.0, elapsed / (duration + duration × 0.4))
effect   = bg_direction × bg_drop_override × fraction
```

**2. ODE path (default):** The HR trace is obtained (wearable or synthetic), then `_integrate_z_drop()` is called from `t=0` to `min(elapsed, duration + 4·τ_Z)`. The post-exercise scan window `4·τ_Z = 40 min` covers the Z decay tail. Allometric weight scaling is applied inside `_integrate_z_drop()`:

```
drop_magnitude *= (70.0 / weight_kg) ^ 0.25
```

This makes heavier patients have a smaller per-kg BG drop at equal workload, matching observed physiology.

### `get_activity_on_board(activity, current_time, patient_constants) → dict`

Analogous to IOB — returns the **remaining** acute BG-lowering effect still to be delivered. The computation integrates the full Z-drop from `t=0` to the complete tail window, then divides by that total to find `absorbed_fraction`.

**Return shape:**

```json
{
  "remaining_bg_drop":  12.5,
  "absorbed_fraction":  0.64,
  "minutes_elapsed":    18.0,
  "is_active":          true,
  "intensity":          "moderate",
  "bg_direction":       -1
}
```

> **Open Gap D-1 (TypeScript):** `computeSyntheticAOB()` in `insulinCalculationService.ts` skips the `bg_drop_override` linear path present here in Python, so AOB values for CGM-confirmed sessions will differ between the backend API response and any TypeScript-side recalculation. See §9.

### `calculate_activity_sensitivity_multiplier(activities, current_time, patient_constants) → float`

Computes the post-exercise ISF/CR boost from the `W` state variable. Integrates the full Y/Z/W ODE system per session and takes `max()` across sessions:

```
W_at_now   = ∫Y dt over exercise window, then decayed by e^(−recoveryTime / τ_W)
sessionBoost = min(α × W_at_now × (1 + Z_at_now), max_sensitivity_boost)
multiplier   = 1.0 + max(sessionBoost_1, sessionBoost_2, ...)
```

Taking `max()` rather than summing reflects the physiological ceiling on GLUT4 receptor upregulation — sessions do not stack additively. Sessions older than `5 × τ_W` (~7.5 hours) are skipped (W has decayed to < 1% of peak).

**Daily reset boundary (fix H-3):** Sessions that started *before* `daily_reset_hour` today are excluded, so yesterday's evening exercise does not carry over into the next morning's calculations:

```python
local_now   = current_time + timedelta(minutes=timezone_offset_minutes)
reset_local = local_now.replace(hour=daily_reset_hour, minute=0, second=0)
if local_now < reset_local:
    reset_local -= timedelta(days=1)
reset_utc = reset_local - timedelta(minutes=timezone_offset_minutes)
```

### `apply_activity_sensitivity(patient_constants, activities, current_time) → dict`

Returns a **modified copy** of `patient_constants` with ISF and CR already scaled by the multiplier. The original dict is not mutated. Used by the routes layer to compute `effective_correction_factor` / `effective_carb_to_bg_ratio` in the API response.

```
effective_correction_factor = correction_factor × multiplier   (bigger ISF → more sensitive)
effective_carb_to_bg_ratio  = carb_to_bg_ratio  ÷ multiplier   (smaller CR → smaller BG rise per carb)
```

Both `carb_to_bg_ratio` and `carb_to_bg_factor` are handled (legacy alias support).

### `calculate_stacked_activity_effect(activities, current_time, patient_constants) → dict`

Top-level aggregator. Iterates over all normalized activities, calls `calculate_activity_cumulative_effect()` and `get_activity_on_board()` for each, and returns the combined result.

`cumulative_activity_effect` is a **sum** across sessions (effects can partially cancel if mixed aerobic/anaerobic sessions are present). `sensitivity_multiplier` is a **max** across sessions (GLUT4 non-additivity).

**Full return shape:**

```json
{
  "cumulative_activity_effect":  -18.5,
  "sensitivity_multiplier":       1.24,
  "activity_on_board":            7.3,
  "activity_contributions": [
    {
      "activity_id":          "abc123",
      "start_time":           "2025-05-01T08:30:00",
      "intensity":            "moderate",
      "duration_minutes":     45.0,
      "bg_direction":         -1,
      "cumulative_bg_effect": -18.5,
      "remaining_bg_drop":    7.3,
      "absorbed_fraction":    0.61,
      "is_active":            false,
      "model":                "hr_ode"
    }
  ],
  "active_sessions": 0
}
```

---

## 3. Flask API

**File:** `routes/activity_pharmacodynamics_routes.py`
**Blueprint:** `activity_pd_bp`
**Version:** 1.1

This Blueprint is read-only — it does not record activity events (that is handled by `activity.py`). It exposes three endpoints that query `mongo.db.activities` and run the ODE engine.

### Per-User TTL Cache (fix 11.5)

The stacked endpoint runs a full ODE simulation across all of today's sessions. With the frontend polling every 60 seconds plus additional calls on view-mode changes and retroactive-data events, a busy dashboard can trigger 5–10 ODE runs per minute with identical inputs.

A lightweight in-process dict-based TTL cache (60 s, thread-safe via `threading.RLock`) is added to the stacked endpoint only. The AOB and preview endpoints are intentionally uncached:

- `/aob` — AOB values change every minute; a 60 s cache would make the progress bar appear frozen.
- `/preview` — always receives synthetic user-supplied inputs, must never be cached.

**Cache key:** `"{user_id}|{reset_date_iso}"` — automatically invalidates at the daily reset boundary with zero explicit logic.

**Explicit invalidation:** `invalidate_pd_cache(user_id)` is called by `watch_hr_routes.end_watch_activity()` via a lazy import when a session is finalized, so the new session is visible on the next poll rather than waiting up to 60 s. Clients may also pass `?force_refresh=1` to bypass the cache manually.

**Multi-worker note:** The cache is in-process. On single-Gunicorn-worker deployments (e.g. Render free tier) this covers 100% of requests. Multi-worker deployments each maintain their own cache — worst case is one extra ODE run per worker per TTL window, which is acceptable. If true cross-process caching is required, swap the internal dict for Flask-Caching with a Redis backend — the public `_cache_get`/`_cache_set`/`invalidate_pd_cache` API stays identical.

### Session Query Logic (`_fetch_activities`)

Queries `mongo.db.activities` for `type: "completed"` records within `[reset_time, target_time]`, matching on any of `startTime`, `completedTime`, or `timestamp` to support both new and legacy schema. Results are normalized via `normalize_activity_record()` and sedentary records are filtered out before the ODE runs.

### `GET /api/activity/pharmacodynamics`

Stacked pharmacodynamic effect for all exercise sessions in today's window.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `target_time` | ISO-8601 string (optional) | Reference time for calculation. When supplied, bypasses the cache entirely (historical / debug). |
| `force_refresh` | `0\|1` (optional) | Bypass and repopulate the cache. Use after ending a session for immediate visibility. |

**Response fields:**

| Field | Type | Description |
|---|---|---|
| `cumulative_activity_effect` | float | Signed net BG shift in mg/dL. Negative = aerobic/lowering. |
| `sensitivity_multiplier` | float ≥ 1.0 | Post-exercise ISF/CR boost factor. Max across sessions. |
| `activity_on_board` | float | Unsigned remaining acute BG drop still to be delivered (mg/dL). |
| `activity_contributions` | list | Per-session breakdown — see `calculate_stacked_activity_effect` shape above. |
| `active_sessions` | int | Number of sessions currently within their `duration_minutes` window. |
| `effective_correction_factor` | float | ISF after sensitivity adjustment. **Do not re-apply the multiplier locally.** |
| `effective_carb_to_bg_ratio` | float | CR after sensitivity adjustment. **Do not re-apply the multiplier locally.** |
| `window_start` | ISO-8601 | Today's reset time (UTC). |
| `window_end` | ISO-8601 | `target_time` used for calculation. |
| `calculated_at` | ISO-8601 | Server UTC timestamp. |
| `cached` | bool | `true` when result was served from the 60 s cache. Observability only — do not branch on this value. |

### `GET /api/activity/pharmacodynamics/aob`

Per-session Activity On Board breakdown. Useful for hypoglycaemia risk prediction — shows how much effect remains to be delivered from each session individually.

**Query parameters:** `target_time` (optional ISO-8601)

**Response:**

```json
{
  "sessions": [
    {
      "activity_id":       "abc123",
      "intensity":         "moderate",
      "duration_minutes":  45.0,
      "remaining_bg_drop": 7.3,
      "absorbed_fraction": 0.61,
      "minutes_elapsed":   28.0,
      "is_active":         true,
      "bg_direction":      -1
    }
  ],
  "total_aob":     7.3,
  "calculated_at": "2025-05-01T09:02:00"
}
```

### `POST /api/activity/pharmacodynamics/preview`

Simulate the pharmacodynamic effect of a planned/hypothetical activity without persisting anything to the database. A synthetic normalized activity record is constructed in memory and passed to `calculate_stacked_activity_effect()`.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `intensity` | `"light" \| "moderate" \| "vigorous"` | Yes | |
| `duration_minutes` | float | Yes | |
| `start_time` | ISO-8601 string | No | Defaults to server UTC now. |
| `hr_trace` | `[{t_min, hr_bpm}]` | No | Real HR data for a more accurate preview. |
| `hr_base` | float | No | Resting HR override. |
| `hr_max` | float | No | Max HR override. |

**Response:** Same shape as the stacked endpoint, plus `"simulated": true`. Always `"cached": false`.

---

## 4. Watch HR Session Flow

**File:** `routes/watch_hr_routes.py`
**Blueprint:** `watch_hr_bp`
**Version:** 2.1

All watch session records are written to `mongo.db.activities` with the same schema as regular activity records, plus two extra fields (`hr_trace_raw` and `hr_trace`). Zero schema changes are required in the PD routes.

### Dual HR Trace Storage

| Field | Format | Consumer |
|---|---|---|
| `hr_trace_raw` | `[{t_sec, hr_bpm}]` — every raw sample at watch resolution | ActivityVisualization "HR Live" tab |
| `hr_trace` | `[{t_min, hr_bpm}]` — 1-minute bucket averages | ODE pharmacodynamics model |

The per-minute averages are computed by `_downsample_to_minutes()` using the midpoint convention: bucket `n` gets `t_min = n + 0.5` (e.g. samples in seconds 0–59 → `t_min = 0.5`). This matches the ODE model's expectation of the trace being sampled at representative times within each minute.

### Raw Sample Cap (fix 11.3)

Sessions are capped at 15 minutes. At 1 Hz that is 900 samples. A hard cap of **1,800 samples** (2× headroom for burst sends and watch-SDK timing jitter) is enforced per session via a MongoDB `$size` projection on `hr_trace_raw`. Once reached, subsequent stream calls return HTTP 429. Oversized batches that would partially exceed the cap are silently truncated to fill the remaining slots.

### Intensity Classification at Session End

When `end_watch_activity` is called and no `intensity` override is supplied in the request, intensity is inferred from the mean HR relative to the patient's HR reserve:

```
mean_fraction = (mean_hr − hr_base) / (hr_max − hr_base)

0.00 – 0.50 → light
0.50 – 0.70 → moderate
0.70 – 1.00 → vigorous
```

The `intensity` from the start call, if provided, takes precedence over the auto-inferred value. The caller's explicit body override takes precedence over both.

### Level Field Fix (M-4) ✅

`end_watch_activity` now writes the correct `level` integer (`0=light, 1=moderate, 2=vigorous`) derived from `final_intensity` rather than hard-coding `1`. Previously, all watch sessions were displayed as "Moderate" in `ActivityCard` regardless of actual effort, because `ActivityCard` reads `activity.level` to look up the display label.

### Session Lifecycle

```
POST /api/watch/activity/start
  • Abandons any existing in_progress session for the user (auto-stale guard)
  • Inserts document with type="in_progress", hr_trace_raw=[], hr_trace=[]
  • Returns session_id

POST /api/watch/hr/stream  (called every ~5 s by the watch sync loop)
  • Validates session_id, looks up in_progress document
  • Normalises sample timing: t_sec / t_min / timestamp_iso → all stored as t_sec
  • Enforces 1,800-sample hard cap
  • $push normalised samples into hr_trace_raw
  • Recomputes and $sets hr_trace (per-minute averages) from full hr_trace_raw

POST /api/watch/activity/end
  • Computes duration_minutes from startTime → end_time
  • Infers intensity from HR reserve fraction (if not overridden)
  • Downgrades hr_trace from raw if not already computed
  • Updates type → "completed"
  • Writes level integer, intensity string, duration fields, hr_base, hr_max
  • Calls invalidate_pd_cache(user_id)  ← clears 60 s cache immediately

GET /api/watch/activity/status
  • Returns active session info — used on app start for crash/disconnect recovery

GET /api/watch/hr/raw/<session_id>
  • Returns hr_trace_raw and hr_trace for a given session (completed or in-progress)
  • Used by ActivityVisualization HR Live tab
```

---

## 5. Continuous HR Auto-Segmentation

**File:** `utils/watch_hr_autosegment.py`
**Version:** 2.1

Converts a continuous all-day HR stream (e.g. a full day's export from a smartwatch) into discrete activity session records using **absolute BPM swim-lane thresholds** with debouncing and time-boundary splitting.

### Why Separate from the ODE Classifier

The ODE model uses a **relative HR-reserve fraction** to classify intensity at the session level (after all samples are collected). This module classifies at the **stream level** using **absolute BPM thresholds**. The two are complementary:

- Swim-lane thresholds decide *when* a session starts, ends, or transitions
- The ODE model uses the actual HR trace to compute BG effect magnitude

### Swim-Lane Configuration

All thresholds are in `SWIM_LANE_CONFIG` and overridable per-call via `config_override`:

| Key | Default | Description |
|---|---|---|
| `hr_sedentary_max` | 50 bpm | Below this → SEDENTARY, no session created |
| `hr_moderate_low` | 100 bpm | LIGHT / MODERATE boundary |
| `hr_moderate_high` | 140 bpm | MODERATE / VIGOROUS boundary |
| `debounce_start` | 6 | Consecutive readings above `hr_sedentary_max` to start a session |
| `debounce_end` | 6 | Consecutive readings below `hr_sedentary_max` to end a session |
| `debounce_transit` | 6 | Consecutive readings in the new zone to switch intensity |
| `min_session_minutes` | 2.0 | Shorter sessions discarded as noise artefacts |
| `max_session_minutes` | 15.0 | Hard cap; sessions split at 15-min boundaries |

### 15-Minute Boundary Splitting

Sessions are capped at 15 minutes and split at 15-min clock boundaries (`:00`, `:15`, `:30`, `:45`). This is applied before the debounce logic on each new sample, so even if a session crosses a boundary mid-sample the split is respected.

Example: activity from 07:42 → 08:30:

```
Session 1  07:42 → 07:45   (3 min, intensity X)
Session 2  07:45 → 08:00  (15 min, intensity X)
Session 3  08:00 → 08:15  (15 min, intensity X)
Session 4  08:15 → 08:30  (15 min, intensity X)
```

Intensity transitions (LIGHT ↔ MODERATE ↔ VIGOROUS) produce additional splits at the debounce boundary, independently of the time-based splits.

### State Machine

The segmenter runs a four-state machine over sorted, normalised samples:

```
States: SEDENTARY ↔ LIGHT ↔ MODERATE ↔ VIGOROUS

SEDENTARY:
  Active zone reading  → add to pending_start
    len(pending_start) >= debounce_start
      → open session at pending_start[0].ts, state = majority zone
  Sedentary reading    → clear pending_start

ACTIVE (LIGHT / MODERATE / VIGOROUS):
  Step A — Check 15-min boundary: while ts >= next_split_boundary
    → _split_at_hour_boundary(); advance next_split_boundary
  Step B — Add sample to current_samples
  Step C — If zone == SEDENTARY:
    → add to pending_end; clear pending_transit
    len(pending_end) >= debounce_end
      → close session at pending_end[0].ts; state = SEDENTARY
  Step D — If zone != state (different active zone):
    → add to pending_transit; clear pending_end
    len(pending_transit) >= debounce_transit
      → close current session; open new session at pending_transit[0].ts
  Step E — Same zone:
    → clear pending_end and pending_transit

End of stream: close any open session
```

**Start time accuracy:** When debounce triggers a session start, `current_start` is set to `pending_start[0].ts` — the *first* reading of the debounce window, not the last. No real exercise time is lost.

**End time accuracy:** Session end is set to `pending_end[0].ts` — the *first* sedentary reading — so the recovery tail is not included in the session duration.

### `session_to_activity_doc(session, user_id, bg_direction) → dict`

Converts a `segment_hr_stream()` result dict into a MongoDB-ready `activities` document. Schema-identical to records from the real-time start/stream/end flow.

**Fix H-2 ✅:** Session statistics (`min(hr_values)`, `max(hr_values)`) are stored under `session_hr_min` / `session_hr_peak` rather than `hr_base` / `hr_max`. Before this fix, the ODE reader was treating the lowest HR observed during a run (e.g. 62 bpm in the recovery phase of an interval workout) as the patient's resting HR. This corrupted the HR-reserve fraction and systematically underestimated exercise intensity.

**Level mapping:**

```
light    → level = 0
moderate → level = 1
vigorous → level = 2
```

### Output Schema per Session

```json
{
  "start_time":        "2025-05-01T07:42:00",
  "end_time":          "2025-05-01T07:45:00",
  "duration_minutes":  3.0,
  "intensity":         "moderate",
  "hr_trace":          [{"t_min": 0.5, "hr_bpm": 115.2}],
  "hr_trace_raw":      [{"t_sec": 5.0, "hr_bpm": 112.0}, "..."],
  "hr_base":           null,
  "hr_max":            null,
  "sample_count":      18
}
```

Note: `hr_base` and `hr_max` in this output are null (session stats are stored as `session_hr_min` / `session_hr_peak` in the Mongo doc by `session_to_activity_doc`). Patient-level `hr_base` / `hr_max` for ODE use must be supplied separately via the `hr_base` / `hr_max` fields on the upload request body.

---

## 6. API Service Layer

**File:** `mobile/services/api/activity-pharmacodynamics.ts`
**Version:** 2.4

### Functions

| Function | Method | Endpoint | Notes |
|---|---|---|---|
| `fetchActivityPD(targetTime?)` | GET | `/api/activity/pharmacodynamics` | Passes `target_time` query param if supplied. |
| `fetchActivityOnBoard(targetTime?)` | GET | `/api/activity/pharmacodynamics/aob` | Per-session AOB breakdown. |
| `previewActivityEffect(body)` | POST | `/api/activity/pharmacodynamics/preview` | Sends intensity, duration, optional hr_trace. |
| `fetchStackedActivityEffectSafe(targetTime?)` | GET | (same as fetchActivityPD) | **Non-throwing wrapper (fix C-1 / 11.5).** Catches all errors and returns `null`. Use inside `Promise.all()` chains where the activity fetch is non-fatal. A `null` result is treated as zero effect throughout the pipeline and must never break BG estimation. |

### Key Response Fields (`ActivityPDResult`)

| Field | Type | Notes |
|---|---|---|
| `cumulative_activity_effect` | float | Signed net BG shift. ADD to BG estimate — never subtract. Already signed negative for aerobic. |
| `sensitivity_multiplier` | float ≥ 1.0 | Max across sessions. Do not multiply sessions together. |
| `activity_on_board` | float | Unsigned remaining acute drop. Analogous to IOB. |
| `effective_correction_factor` | float | Pre-multiplied by backend. Do NOT re-apply `sensitivity_multiplier` locally. |
| `effective_carb_to_bg_ratio` | float | Pre-divided by backend. Do NOT re-divide locally. |
| `cached` | bool | Observability only. Do NOT branch on this field. |
| `activity_contributions` | list | Per-session breakdown including `model: "hr_ode" \| "synthetic_hr"`. |

### Frontend ODE Mirror (`insulinCalculationService.ts`)

The frontend mirrors the backend ODE for manually-entered form activities that have not yet been persisted to the database. Both `computeSyntheticSensitivityMultiplier` (W-state) and `computeSyntheticAOB` (Z-state) implement the same ODE system described in §1. Key properties verified against the backend:

- Z is a binary saturation gate, not a smooth curve. ✅
- W accumulates ∫Y dt during exercise (not a×Z). ✅
- W decay applies only in recovery (not during exercise). ✅
- Integration window extends to `now` — the W-state is evaluated at the moment the form is filled, so the multiplier correctly decays as time elapses post-exercise. ✅
- Multiple sessions: `max()` across W-states for the sensitivity multiplier. ✅
- Multiple sessions: summed independently for AOB. ✅
- **Sensitivity multiplier formula: `min(α × W × (1 + Z), max_boost)`. ✅** *(Previously `α × W` — the missing `(1 + Z)` factor caused up to 50% underestimation during active exercise. Fixed in v2.3; see changelog and §9.)*

---

## 7. Sign Convention

**This convention applies everywhere in the stack without exception.**

`cumulative_activity_effect` is always **added** to the BG estimate, never subtracted. The value is pre-signed:

```
Aerobic session  → bg_direction = -1  → cumulative_activity_effect is negative
                 → adding it to BG lowers BG  ✓

Anaerobic/stress → bg_direction = +1  → cumulative_activity_effect is positive
                 → adding it to BG raises BG  ✓
```

`effective_correction_factor` and `effective_carb_to_bg_ratio` from the PD endpoint response are **already multiplied/divided** by `sensitivity_multiplier` on the backend. Re-applying `sensitivity_multiplier` locally would double-scale these values — **do not do this**.

Integration point in `net-effect.ts`:

```typescript
// ADD, never subtract — value is already signed negative for aerobic
estimatedBG = (core meal+insulin result) + cumulative_activity_effect
```

---

## 8. Data Flow Diagrams

### Stacked Endpoint Request Flow

```
Client GET /api/activity/pharmacodynamics
  │
  ├─ explicit target_time OR force_refresh=1?
  │     YES → skip cache
  │     NO  → check _pd_cache["{user_id}|{reset_date}"]
  │               HIT  → return cached_payload + cached:true
  │               MISS → continue
  │
  ├─ _resolve_reset_time(patient_constants, target_time)
  │     → daily_reset_hour + timezone_offset_minutes → reset_utc
  │
  ├─ _fetch_activities(user_id, reset_time, target_time)
  │     → mongo.db.activities.find({type:"completed", time in window})
  │     → normalize_activity_record() for each → filter None
  │
  ├─ calculate_stacked_activity_effect(activities, target_time, pc)
  │     → for each activity:
  │         calculate_activity_cumulative_effect()
  │           → bg_drop_override? → linear model
  │           → else → _get_trace_from_activity() → Z-state ODE integration
  │         get_activity_on_board()
  │           → same two paths, returns absorbed_fraction
  │     → SUM cumulative effects, MAX sensitivity across sessions
  │
  ├─ apply_activity_sensitivity(pc, activities, target_time)
  │     → calculate_activity_sensitivity_multiplier()
  │         → Y/Z/W ODE per session → W_at_now (decayed to reference time)
  │         → 1.0 + max(α × W × (1+Z)) across sessions, capped
  │     → scale correction_factor, carb_to_bg_ratio
  │
  ├─ _cache_set(cache_key, payload)
  │
  └─ return jsonify({...payload, cached: false})
```

### Watch Session → PD Pipeline

```
Watch app
  │
  ├─ startWatchSession()  →  POST /api/watch/activity/start
  │     mongo.insert({type:"in_progress", hr_trace_raw:[], hr_trace:[]})
  │
  ├─ streamHrSamples() every ~5 s  →  POST /api/watch/hr/stream
  │     normalise timing → t_sec
  │     $push into hr_trace_raw
  │     recompute hr_trace (_downsample_to_minutes)
  │
  └─ endWatchSession()  →  POST /api/watch/activity/end
        infer intensity from HR reserve fraction (if not overridden)
        update type → "completed", write level, intensity, hr_base, hr_max
        invalidate_pd_cache(user_id)  ← clears 60 s cache immediately
              │
              ▼
        Next GET /api/activity/pharmacodynamics
          _fetch_activities sees new "completed" record
          Y/Z/W ODE runs on hr_trace (per-minute averages)
          Result returned with cumulative_activity_effect, sensitivity_multiplier
```

### Continuous Upload Flow

```
Wearable app / CSV file
  │
  ├─ parseWearableCsv(csvText)
  │     auto-detect layout (timestamp_iso / t_sec / t_min)
  │     validate hr_bpm in [20, 300]
  │     return [{timestamp_iso, hr_bpm}, ...]
  │
  └─ uploadContinuousHr({samples, config?})
        POST /api/watch/hr/continuous
          │
          ├─ segment_hr_stream(samples, config_override)
          │     sort by timestamp
          │     state machine: SEDENTARY ↔ LIGHT ↔ MODERATE ↔ VIGOROUS
          │       debounce_start / debounce_end / debounce_transit
          │       15-min boundary splits
          │     _finalise_session() → discard < min_session_minutes
          │     return [{start_time, end_time, intensity, hr_trace, ...}]
          │
          └─ for each session:
                session_to_activity_doc(sess, user_id)
                  rename hr_min→session_hr_min, hr_max→session_hr_peak (H-2)
                  write level integer (0/1/2)
                mongo.insert_one(doc)
```

### Manual Form Activity → Dose Pipeline

```
User enters activity in MealForm
  │
  ├─ computeSyntheticSensitivityMultiplier(activities, constants, now)
  │     Per session:
  │       Euler integrate Y/Z/W over [0, durationMins + recoveryMins]
  │       W accumulates ∫Y dt during exercise
  │       W decays with τ_W during recovery to reference time (now)
  │       sessionBoost = min(α × W × (1 + Z), max_boost)
  │     maxBoost = max(sessionBoost_1, sessionBoost_2, ...)   ← max, not sum
  │     multiplier = 1 + maxBoost
  │
  ├─ computeSyntheticAOB(activities, constants, now)
  │     Per session:
  │       Z-state ODE over [0, durationMins + 4·τ_Z]
  │       elapsedDrop = integral capped at elapsed time
  │       remaining = totalDrop × (1 − elapsedDrop/totalDrop)
  │     totalAOB = sum(remaining_1, remaining_2, ...)           ← additive
  │
  └─ effectiveMult = max(syntheticMult, backendMult)
     effectiveAOB  = syntheticAOB + backendAOB
           │
           ▼
     calculateInsulinDose()
       adjustedInsulin = baseInsulin / effectiveMult
       effectiveCF     = CF × effectiveMult
       aobDeduction    = effectiveAOB / effectiveCF
```

---

## 9. Known Gaps & Open Issues

| ID | Severity | Location | Description |
|---|---|---|---|
| **D-3** | Medium | `ActiveEffectsDisplay.tsx` | `ActiveEffectsDisplay` and `EffectsVisualizationChart` can both independently fetch the PD endpoint on the same screen if `activityPDResult` is not prop-drilled from a common parent. Two simultaneous ODE runs will both hit the cache after the first warms it, but during the 60-second window after a new session ends both callers fire a cache-miss run. Fix: prop-drill `activityPDResult` from the parent that owns `useActiveEffects`. |
| **D-4** | Low | `ActiveEffectsDisplay.tsx` L577–578 | `simpleProjectedFinalBG` is computed identically to `projectedFinalBG`. The distinction between the two was never implemented. |
| **D-1** | Medium | `insulinCalculationService.ts` | `computeSyntheticAOB()` skips the `bg_drop_override` linear absorption path that exists in the Python backend (`calculate_activity_cumulative_effect`). AOB values for CGM-confirmed sessions will be inconsistent between the backend API response and any TypeScript-side recalculation. Affects only sessions where a CGM-measured drop magnitude was logged — ODE-path sessions are consistent. |
| **H-2** | Closed ✅ | `watch_hr_autosegment.py` | Fixed in v2.1: session `min(hr_values)` / `max(hr_values)` renamed from `hr_base`/`hr_max` to `session_hr_min`/`session_hr_peak` in `session_to_activity_doc()`, preventing the ODE from treating session-observed HR statistics as patient resting/max HR constants. |
| **H-3** | Closed ✅ | `activity_pharmacodynamics.py` | Fixed in v2.2 → v2.3: daily reset-boundary guard added to `calculate_activity_sensitivity_multiplier()` so yesterday's sessions don't contribute to today's sensitivity multiplier. |
| **M-4** | Closed ✅ | `watch_hr_routes.py` | Fixed in v2.1: `end_watch_activity` now writes the correct `level` integer from `final_intensity`, not hard-coded `1`. |
| **Bug 1/2/13** | Closed ✅ | `insulinCalculationService.ts` | Fixed in v2.3: `computeSyntheticSensitivityMultiplier` ODE rewritten. Z is now a binary gate; W accumulates ∫Y dt; W decay is recovery-only; elapsed recovery time is integrated through to the reference timestamp so the multiplier correctly decays as time passes post-exercise. |
| **Bug 16** | Closed ✅ | `insulinCalculationService.ts` | Fixed in v2.3: multiple sessions now use `max()` across W-states for the sensitivity multiplier, not additive sum. Matches backend behaviour. |
| **TS-α** | Closed ✅ | `insulinCalculationService.ts` | Fixed in v2.3 (cross-file audit): `computeSyntheticSensitivityMultiplier` used `α × W` instead of `α × W × (1 + Z)`. The Python backend and `activity-pharmacodynamics.ts` both used `(1 + Z)` correctly. During active exercise (Z ≈ 1) this caused up to 50% underestimation of the sensitivity boost, producing meal dose suggestions that were too high. Corrected to match the Python ground truth. |
| **Bug 6** | Closed ✅ | `meal-pharmacodynamics.ts` | Fixed in v2.3: `FIBER_FACTOR` corrected from 0.1 to 1.0. Dietary fiber is now fully subtracted from gross carbs when computing net carb equivalents, matching ADA net-carbs clinical standard. |
| **Bug 5** | Closed ✅ | `EffectsVisualizationChart.tsx` | Fixed in v2.3: `carb_to_bg_factor` null-state fallback corrected from `?? 20` to `?? 4.0`. Prevents a 5× over-estimated meal area on first render when patient constants have not yet loaded. |
| **Bug 3/8** | Closed ✅ | `blood-glucose-estimation.ts` | Fixed in v2.3: trend arrow now derives `currentNetEffect` from `totalActiveEffect` (instantaneous gamma-PDF rate) rather than `totalBGElevation` (cumulative absorbed amount). A fully-absorbed meal now correctly shows `stable` rather than `rising_rapidly`. |
| **Bug 7** | Closed ✅ | `EffectsVisualizationChart.tsx` | Fixed in v2.3: teal activity line decays with τ_Z = 10 min immediately when exercise ends. The τ_W = 90 min plateau is now isolated to the sensitivity multiplier overlay. The two lines correctly diverge after exercise ends. |
| **11.3** | Closed ✅ | `watch_hr_routes.py` | Fixed: 1,800-sample hard cap on `hr_trace_raw` prevents unbounded document growth. |
| **11.5 / C-1** | Closed ✅ | `activity-pharmacodynamics.ts` | Fixed: per-user 60 s TTL cache on the stacked endpoint; explicit invalidation on session end; `fetchStackedActivityEffectSafe()` non-throwing wrapper added. |
| **Goal-4** | Closed ✅ | `ActiveEffectsDisplay.tsx` ~line 818 | `calculateNetEffect` (Step 9) was receiving `resetHour` (a number) as its 7th argument — the `activityPD` slot in the `net-effect.ts` wrapper — with `tzOffset` passed as a silent 8th. The wrapper only accepts 7 params and reads `resetHour`/`tzOffset` from `patientConstants` internally, so both values were silently discarded and the trend arrow never saw exercise data. A vigorous run could show `↗ rising` while BG was actually falling. Fixed by passing `activityPDValid ? activityPDData : null` as the 7th argument and removing the two incorrect positional args. |
| **Goal-5** | Closed ✅ | `EffectsVisualizationChart.tsx` ~line 942/1315 | `usePatientConstants()` only destructured `constants`, not `hasLoadedFromAPI`. The `generateChartData` guard `if (!patientConstants) return` was always false because `patient.store` pre-populates from cache or `DEFAULT_PATIENT_CONSTANTS` immediately on mount — so the chart rendered with `CF=40 / carb=4` on every load, producing a visible line discontinuity when real constants arrived (e.g. `CF=70`, `carb=10`). Fixed by destructuring `hasLoadedFromAPI` (aliased `patientConstantsReady`), adding `!patientConstantsReady` to the early-exit guard in `generateChartData`, and including it in the `useCallback` dep array so the chart re-runs exactly once when real API data arrives. *(Distinct from Bug 5, which fixed the `?? 20 → ?? 4.0` fallback value. Goal-5 prevents default-constant renders entirely.)* |

---

## References

- Dalla Man C, Breton M, Cobelli C — *J Diabetes Sci Technol* 2009;3(1):56–67
- Romeres D, Dalla Man C et al. — *Am J Physiol Endocrinol Metab* 2021;321:E122
- Breton MD — *J Diabetes Sci Technol* 2008;2(1):169–174
