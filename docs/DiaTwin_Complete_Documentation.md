# DiaTwin — Complete Technical & Clinical Documentation

> **Clinical & Technical Reference** | TRL 4–5 | [dia-twin.vercel.app](https://dia-twin.vercel.app)
>
> **Contact:** Ali Attia | aliattia2@gmail.com | [LinkedIn](https://linkedin.com/in/ali-attia-74748bb4) | [GitHub](https://github.com/aliattia2)
>
> **Last updated:** 2026-05

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Research Concept Brief](#2-research-concept-brief)
3. [Core Technical Components](#3-core-technical-components)
4. [Activity Integration — ODE Engine](#4-activity-integration--ode-engine)
5. [Google Fit Watch HR Sync](#5-google-fit-watch-hr-sync)
6. [Dual Baseline System — Technical Deep-Dive](#6-dual-baseline-system--technical-deep-dive)
7. [ActiveEffectsDisplay — Component Reference](#7-activeeffectsdisplay--component-reference)
8. [Insulin Suggestion Logic](#8-insulin-suggestion-logic)
9. [Platform Architecture & Stack](#9-platform-architecture--stack)
10. [Patient-Facing Features](#10-patient-facing-features)
11. [Healthcare Provider Features](#11-healthcare-provider-features)
12. [Mobile Application](#12-mobile-application)
13. [Platform & Community Features](#13-platform--community-features)
14. [API Endpoint Index](#14-api-endpoint-index)
15. [Proposed Research Agenda](#15-proposed-research-agenda)
16. [Positioning vs. Existing Solutions](#16-positioning-vs-existing-solutions)
17. [Lead Researcher Profile](#17-lead-researcher-profile)
18. [Acknowledgements](#18-acknowledgements)

---

## 1. Executive Summary

### Clinical Problem

Type 1 Diabetes (T1D) patients using standard insulin pens lack tools to translate continuous glucose data into actionable dosing decisions. Despite the widespread adoption of CGM sensors and finger-prick testing, no affordable software-based decision support exists that models both insulin activity and meal absorption simultaneously in real time. The result: chronic under- and overdosing, high hypoglycaemia risk, and significant cognitive burden on patients and clinicians.

Over 8 million people with T1D worldwide rely on insulin pens. Static correction ratios (ISF, ICR) prescribed by clinicians cannot adapt to inter- and intra-patient circadian variability, leading to chronic dosing errors, elevated hypoglycaemia risk, and high cognitive burden. A further gap is the absence of an individualised, continuously-updated blood glucose baseline — the anchor from which every dosing recommendation is calculated.

### System Overview

DiaTwin is a clinically supervised decision-support platform for T1D management. It creates a personalised physiological model — a **Digital Twin** — of each patient's blood glucose behaviour. It is designed primarily for T1D, where the complete absence of endogenous insulin production means that glucose effects persist and stack rather than self-correct, requiring a fundamentally different computational model from conventional diabetes apps.

The platform models the pharmacodynamics of insulin and meal absorption in real time, enabling personalised dosing guidance for patients using standard insulin pens — without requiring an insulin pump.

**Platform:** Web application (React/TypeScript) + Android app + REST API (Python/Flask, MongoDB)

**Live demo:** [dia-twin.vercel.app](https://dia-twin.vercel.app) | Doctor login: `doctor / 4444` | Patient: `ahmed / 4444`

**Development status:** TRL 4–5. Core algorithms validated. Web + mobile prototypes operational.

**Academic basis:** M.Sc. thesis, DIT Germany (grade 1.6 "Excellent"), clinical supervision: Prof. Dr. Klaus Parhofer, LMU Munich. External evaluation: Excellent. Clinical Utility Score: 8.7/10.

The platform combines three layers of technology:

1. A mathematically rigorous pharmacodynamics engine grounded in the **German S3 clinical guidelines** (AWMF-Registry 057-013, Table 9 insulin characteristics), using gamma-distribution curves to model both carbohydrate absorption and insulin activity with physiological accuracy.
2. A **real-time glucose estimation and prediction system** that uses logged meals, insulin doses, and activity data to estimate glucose between fingerstick readings — and optionally fuses this with live CGM data from Abbott LibreLinkUp.
3. A **multi-role clinical platform** where patients manage their own day-to-day diabetes care while authorised physicians review trends, meal histories, and glucose visualisations across their entire patient panel.

### Contextual Dosing Pipeline

| Icon | Module | Description |
|---|---|---|
| 📷 | **Meal photo → carbs** | Camera-based food recognition extracts macronutrients and assigns an absorption profile (very fast → very slow) automatically. Carb-equivalent load computed as carbs + 0.5×protein + 0.2×fat, consistent with the UVA/Padova S2008 GI subsystem (Dalla Man et al., 2006; 2014). |
| 🍽 | **PK/PD modelling** | IOB and MOB modelled via gamma-distribution curves referenced to the German S3 Guideline (AWMF 057-013, Table 9). Five absorption profiles from very slow to very fast; cumulative daily effects and predictive peak-overlap stacking included. Phase 3 persist-at-100% ensures fully-absorbed events continue to contribute to the cumulative ledger until the daily reset. |
| 💓 | **HR + Activity ODE** | Wearable HR stream (real-time or end-of-day upload with swim-lane auto-segmentation) feeds a Y/Z/W ODE system: Y low-pass filters HR above resting; Z models acute insulin-independent GLUT4 uptake (IIRd, τ = 10 min); W integrates exercise load driving a prolonged ISF/ICR sensitivity multiplier capped at +60% (IDRd, τ = 90 min). Categorical fallback synthesises HR from resting/max HR when no wearable is available. Activity-on-Board (AOB) tracked in real time. The baseline system automatically applies the exercise-enhanced correction factor during post-exercise windows (sensitivityMultiplier > 1.005) to both the dynamic unwind and current-time estimates. |
| 📡 | **CGM integration** | Abbott LibreLinkUp auto-sync (4-min scheduler, 10+ regions, Fernet-encrypted credentials) fuses continuous sensor readings with SMBG on a unified timeline, feeding the Dynamic Baseline Estimator with fresh readings every ~5 minutes. Dexcom integration planned. |
| 📈 | **Dual Baseline Estimator** | Two mutually exclusive modes anchor every BG estimate: **Dynamic Mode** (CGM / frequent SMBG) reverse-engineers the stable fasting baseline from the most recent BG reading by unwinding cumulative PK/PD effects; **Preset Mode** (circadian profile, CGM-less) uses a clinically-modelled 24-hour circadian profile encoding overnight nadir, dawn phenomenon rise, morning plateau, and evening taper. |
| 💉 | **Dose + insulin type** | Suggested units (0.1 u rounding, 0.5 u safety floor) plus appropriate insulin analogue (rapid vs standard) matched to the meal's absorption profile and current IOB, MOB, and AOB. Correction component accounts for the activity-adjusted effective ISF when the sensitivityMultiplier is elevated. |
| 🤖 | **Clinician-guided personalisation** | All meal–insulin–activity–outcome tuples logged and visible to supervising clinicians for ISF/ICR review. Full RL-driven automated parameter refinement per 2-hour circadian block (ISFₜ, ICRₜ) planned for the next phase. |

---

## 2. Research Concept Brief

### The Problem

Over 8 million people with Type 1 Diabetes (T1D) worldwide rely on insulin pens. Despite widespread CGM adoption, no affordable decision-support tool simultaneously accounts for insulin pharmacodynamics, meal absorption, physical activity, and circadian variation in insulin sensitivity. Static correction ratios (ISF, ICR) prescribed by clinicians cannot adapt to inter- and intra-patient circadian variability, leading to chronic dosing errors, elevated hypoglycaemia risk, and high cognitive burden.

### What Sets DiaTwin Apart

| Differentiator | Detail |
|---|---|
| **Photo-to-dose** | Camera → carb estimate → insulin suggestion. No manual entry. |
| **Full context window** | Meals, doses, wearable activity, and BG all feed every recommendation. |
| **Dual Baseline Estimator** | Dynamic mode back-calculates a personalised fasting BG anchor from each reading; Preset mode uses a circadian profile with reading-residual patient correction — automatically selected per patient profile and logging behaviour. |
| **Circadian ISF/ICR adaptation** | Time-of-day parameter personalisation via RL — absent from all current pen-user tools. |
| **Wearable HR → ODE pharmacodynamics** | Live or end-of-day HR drives the Y/Z/W engine; auto-segmentation converts continuous HR to discrete exercise sessions. Post-exercise sensitivity multiplier propagates into the baseline unwind. |
| **CGM → closed feedback loop** | LibreLinkUp fusion keeps the glucose baseline current, reducing estimation error between SMBG readings. Fresh readings every ~5 min drive the dynamic baseline recalibration. |
| **RL from longitudinal outcomes** | Engine pre-trained on 50,000+ meal-outcome pairs; stress-tested on AZT1D dataset (25 T1D patients, CGM + bolus + carb data). |
| **No pump required** | Operates with standard insulin pens and finger-prick or CGM data. SMBG-only mode for limited-resource settings. |

### Current Status & Credentials

| Area | Detail |
|---|---|
| **Prototype** | Live web app + Android app — deployable, demo-ready (dia-twin.vercel.app). Doctor login: doctor/4444 │ Patient: ahmed/4444 |
| **Academic** | M.Sc. Digital Health, DIT Germany — grade 1.6 (Excellent, 2025); B.Sc. Pharmacy, Zagazig University (1.5 — Excellent, 2019). |
| **Licence** | German Pharmacist Licence (Berufserlaubnis §11 BApO, Upper Bavaria 2025); Fachsprachenprüfung passed (Bavarian Chamber of Pharmacists). |
| **Clinical advisory** | Prof. Dr. Klaus Parhofer (LMU Munich, Medizinische Klinik IV) — thesis supervisor, clinical utility assessor. Prof. Dr. Katarina Braune (HPI Potsdam / Charité) — prospective PhD supervisor. |
| **Training data** | RL engine pre-trained on 50,000+ real meal–outcome pairs; out-of-sample stress-tested against the AZT1D dataset (25 T1D patients, CGM + bolus + carbohydrate data spanning pen-based MDI and automated insulin delivery therapy periods). |
| **Clinical informatics** | Senior Clinical Data Specialist, Egypt Healthcare Authority (2021–2023): national EHR rollout, HL7-FHIR R4, ICD-10, SNOMED CT, 500+ staff trained. |

### Proposed Research & Collaboration

Seeking a PhD supervision context to design and execute a prospective, randomised, open-label Pilot RCT (N = 100, 6 months) — Arm A: DiaTwin with RL-derived circadian parameter adaptation (ISFₜ, ICRₜ updated weekly); Arm B: standard-of-care pen dosing with static clinician-set parameters.

**Primary endpoint:** Time-in-Range (70–180 mg/dL) at 12 and 24 weeks.

**Secondary endpoints:** Hypoglycaemia frequency, HbA1c, time-below-range, cognitive burden (CGI-S adapted).

**Baseline system sub-study:** Comparative accuracy of dynamic vs preset mode against gold-standard CGM continuous readings across circadian blocks — enabling prospective validation of the bimodal estimator against a continuous BG truth reference.

*Open to discussion on supervision, clinical trial infrastructure, and grant co-development.*

---

## 3. Core Technical Components

| Component | Description |
|---|---|
| **PK/PD Engine** | Models Insulin-on-Board (IOB) and Meal-on-Board (MOB) using gamma distribution curves, referenced to German S3 clinical guidelines. Tracks cumulative daily effects with configurable reset. |
| **Glucose Estimation** | Physiology-based interpolation between readings. Accounts for T1D-specific persistence of glucose effects after absorption. Supports both CGM and SMBG (finger-prick) inputs. |
| **Dosing Recommendations** | Calculates required insulin dose from carbohydrate content, protein, fat, meal type, absorption speed, and time-of-day. Provides pre-meal timing guidance. |
| **Future Glucose Projection** | 4-hour glucose trajectory combining active IOB + MOB curves with current trend. |
| **ML / RL Layer** | Reinforcement learning engine learns from meal-outcome pairs to personalise dosing parameters over time. Trained on 50,000+ real clinical data pairs. |
| **Food Photo Recognition** | Camera-based carbohydrate estimation with automatic insulin dose calculation. |
| **Physician Dashboard** | Remote parameter setting, patient monitoring, clinical timeline, multi-patient view. |
| **CGM Integration** | Abbott LibreLinkUp direct sensor connection; Dexcom integration planned. |

---

## 4. Activity Integration — ODE Engine

### Overview

Physical activity is incorporated as a real-time, session-aware modifier of predicted blood glucose, adjusting for both the acute insulin-independent glucose uptake during exercise (IIRd) and the prolonged post-exercise enhancement of insulin sensitivity (IDRd). The system operates end-to-end: from raw heart rate ingestion through auto-segmentation and ODE pharmacodynamics to a signed cumulative BG effect and a sensitivity multiplier applied to ISF and carbohydrate ratio.

### 4.1 ODE Model — Y / Z / W System

Activity pharmacodynamics are modelled via a three-state ODE system (Dalla Man, Breton & Cobelli, 2009; Breton, 2008; Romeres et al., 2021), numerically integrated at 1-minute Euler steps. The system is implemented identically in both the Python backend (`activity_pharmacodynamics.py`) and a JavaScript frontend port (`activityPharmacodynamics.js`) for offline-capable calculation.

#### State Variables

**Y — HR Filter (Energy Expenditure Proxy)**
First-order low-pass filter of heart rate above the patient's resting baseline (τ_HR = 5 min). `dY/dt = (HR_above / τ_HR) − (Y / τ_HR)`. Captures the physiologically meaningful fraction of HR response, smoothing out beat-to-beat variability.

**Z — Acute IIRd Signal**
Encodes direct, insulin-independent muscle glucose uptake via contractile GLUT4 activation. Z rises toward 1 while the patient is in the exercise window and Y exceeds the onset threshold (a · HR_base, a = 0.05); it decays exponentially with τ_Z = 10 min after exercise ends. The cumulative integral of Z × 0.15 mg/dL/min constitutes the acute BG-lowering effect (IIRd pathway), with an allometric weight correction of (70 / weight_kg)^0.25.

**W — Cumulative Load Integral**
Integrates Y during exercise (`dW/dt = Y`), then decays with τ_W = 90 min in recovery. W encodes the joint intensity × duration load that drives prolonged GLUT4 receptor upregulation. The post-exercise ISF/CR sensitivity multiplier is computed as `1 + α · W · (1 + Z)`, with α = 0.0008 and a hard cap of 60% above baseline.

#### Fixed ODE Parameters

```python
HR_MODEL = {
    "tau_HR":                5.0,    # Y low-pass filter (min)
    "tau_Z":                10.0,    # Z post-exercise decay (min)
    "tau_W":                90.0,    # W sensitivity recovery (min)
    "a":                    0.05,    # exercise-onset threshold (fraction of HR_base)
    "alpha":                0.0008,  # W·Z → sensitivity multiplier scaling
    "max_sensitivity_boost": 0.60,   # hard cap at +60% ISF/CR boost
    "dt":                   1.0,     # Euler step (min)
    "acute_rate_per_min":   0.15,    # mg/dL drop per minute at Z = 1
    "hr_max_pop":          190.0,    # population reference HRmax
    "hr_base_pop":          70.0,    # population resting HR
}
```

#### Derived Clinical Outputs

- **Signed cumulative BG effect** (mg/dL): Controlled by a `bg_direction` field per session — `-1` = aerobic/BG-lowering (default); `+1` = BG-raising for specific session types.
- **Sensitivity multiplier** applied directly to dosing parameters: `correction_factor` (ISF) is multiplied; `carb_to_bg_ratio` (ICR) is divided.
- **Activity-on-Board (AOB)** — analogous to IOB. Tracks remaining undelivered BG-drop magnitude and absorbed fraction per session.
- **Daily reset boundary** — both the cumulative BG effect and the sensitivity multiplier reset at the patient's configurable daily reset hour (default 07:00), using the patient's timezone offset.

### 4.2 Heart Rate Input Pipeline

Three ingestion pathways are fully implemented. All three produce identically normalised activity records, ensuring consistent ODE output. A `model` field in the per-session breakdown records whether real HR data or a synthetic trace was used (`"hr_ode"` vs. `"synthetic_hr"`).

#### 4.2.1 Real-Time Session Recording (Wearable Streaming)

- `POST /api/watch/activity/start` — opens a session and returns a `session_id`
- `POST /api/watch/hr/stream` — accepts batched per-second HR samples (`{t_sec, hr_bpm}`), called every ~5 seconds
- `POST /api/watch/activity/end` — finalises the session; raw per-second trace (`hr_trace_raw`) stored for full-resolution visualisation; independently downsampled to per-minute averages (`hr_trace`) for ODE input
- `GET /api/watch/activity/status` — crash-recovery endpoint; detects in-progress sessions on app restart
- `GET /api/watch/hr/raw/<session_id>` — returns full per-second trace for completed or in-progress sessions

#### 4.2.2 Continuous All-Day Upload and Swim-Lane Auto-Segmentation

`POST /api/watch/hr/continuous` — accepts `{timestamp_iso, hr_bpm}` samples. The backend auto-segmentation module (`watch_hr_autosegment.py`) converts the continuous stream into discrete sessions using a swim-lane state machine:

- **Zone classification** uses absolute BPM thresholds: HR < 50 bpm → sedentary; 50–100 bpm → light; 100–140 bpm → moderate; > 140 bpm → vigorous. All thresholds configurable.
- **Debounce logic** requires 6 consecutive readings in the target zone before a session starts, ends, or transitions.
- **Temporal splitting** caps sessions at 15-minute intervals, split at aligned clock boundaries (:00, :15, :30, :45).
- **Minimum duration filter** discards sessions shorter than 2 minutes as noise artefacts.

#### 4.2.3 Categorical Fallback — No Wearable Required

| Intensity | HR Reserve Fraction | Approx. BPM (population defaults) |
|---|---|---|
| Light | 50% above resting | ~130 bpm |
| Moderate | 65% above resting | ~154 bpm |
| Vigorous | 80% above resting | ~178 bpm |

### 4.3 Flask API — `activity_pharmacodynamics_routes.py`

**Per-User TTL Cache:** A lightweight in-process dict-based TTL cache (60 s, thread-safe via `threading.RLock`) is applied to the stacked endpoint only. Cache key: `"{user_id}|{reset_date_iso}"` — automatically invalidates at the daily reset boundary. `invalidate_pd_cache(user_id)` is called by `watch_hr_routes.end_watch_activity()` when a session is finalized.

#### `GET /api/activity/pharmacodynamics`

Stacked pharmacodynamic effect for all exercise sessions in today's window.

| Field | Type | Description |
|---|---|---|
| `cumulative_activity_effect` | float | Signed net BG shift in mg/dL. Negative = aerobic/lowering. |
| `sensitivity_multiplier` | float ≥ 1.0 | Post-exercise ISF/CR boost factor. |
| `activity_on_board` | float | Unsigned remaining acute BG drop still to be delivered (mg/dL). |
| `activity_contributions` | list | Per-session breakdown. |
| `effective_correction_factor` | float | ISF after sensitivity adjustment. **Do not re-apply the multiplier locally.** |
| `effective_carb_to_bg_ratio` | float | CR after sensitivity adjustment. **Do not re-apply the multiplier locally.** |
| `cached` | bool | `true` when result was served from the 60 s cache. |

#### `GET /api/activity/pharmacodynamics/aob`

Per-session Activity On Board breakdown. Useful for hypoglycaemia risk prediction.

#### `POST /api/activity/pharmacodynamics/preview`

Simulate the pharmacodynamic effect of a planned/hypothetical activity without persisting anything to the database.

### 4.4 Auto-Segmentation Detail — `watch_hr_autosegment.py`

**Swim-Lane Configuration:**

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

**Fix H-2 (v2.1):** Session statistics (`min(hr_values)`, `max(hr_values)`) are now stored under `session_hr_min` / `session_hr_peak` rather than `hr_base` / `hr_max`, preventing the ODE from treating session-observed HR statistics as patient resting/max HR constants.

**Fix H-3 (v2.2):** Daily reset-boundary guard added to `calculate_activity_sensitivity_multiplier()` so yesterday's sessions don't contribute to today's sensitivity multiplier.

### 4.5 Known Gaps & Open Issues

| ID | Severity | Location | Description |
|---|---|---|---|
| **D-3** | Medium | `ActiveEffectsDisplay.tsx` | `ActiveEffectsDisplay` and `EffectsVisualizationChart` can both independently fetch the PD endpoint on the same screen if `activityPDResult` is not prop-drilled from a common parent. Fix: prop-drill `activityPDResult` from the parent that owns `useActiveEffects`. |
| **D-4** | Low | `ActiveEffectsDisplay.tsx` L577–578 | `simpleProjectedFinalBG` is computed identically to `projectedFinalBG`. The distinction between the two was never implemented. |
| **React D-1** | Medium | `activityPharmacodynamics.js` (React frontend) | `getActivityOnBoard()` skips the `bg_drop_override` linear absorption path that exists in the Python backend. AOB values for CGM-confirmed sessions will be inconsistent between backend API and React-side recalculation. |
| **H-2** | ✅ Closed | `watch_hr_autosegment.py` | Fixed in v2.1: session min/max HR renamed from `hr_base`/`hr_max` to `session_hr_min`/`session_hr_peak`. |
| **H-3** | ✅ Closed | `activity_pharmacodynamics.py` | Fixed in v2.2: daily reset-boundary guard added to sensitivity multiplier calculation. |
| **M-4** | ✅ Closed | `watch_hr_routes.py` | Fixed in v2.1: `end_watch_activity` now writes the correct `level` integer from `final_intensity`. |
| **11.3** | ✅ Closed | `watch_hr_routes.py` | Fixed: 1,800-sample hard cap on `hr_trace_raw`. |
| **11.5** | ✅ Closed | `activity_pharmacodynamics_routes.py` | Fixed: per-user 60 s TTL cache on the stacked endpoint; explicit invalidation on session end. |

### 4.6 Implementation Status

| Claimed Capability | Status |
|---|---|
| Y/Z/W ODE system (Dalla Man et al.) | ✅ Fully implemented (Python + JS) |
| Z → acute IIRd / BG-lowering effect | ✅ Z × 0.15 mg/dL/min with allometric scaling |
| W → prolonged GLUT4 / IDRd sensitivity multiplier | ✅ Applied to ISF and CR in real time |
| HR from wearables as primary signal | ✅ Real-time streaming + continuous upload |
| Categorical fallback (no wearable) | ✅ Synthetic HR trace from intensity tier |
| Auto-segmentation of continuous HR stream | ✅ Swim-lane FSM, debounce, 15-min splits |
| Activity-on-Board (AOB) | ✅ Per-session and total; exposed via API |
| Daily reset boundary | ✅ Mirrors IOB/MOB reset with tz offset |
| Stacking across multiple sessions | ✅ Signed sum (BG effect); max (sensitivity) |
| bg_direction (+1 / −1) | ✅ Implemented |
| Allometric weight scaling | ✅ (70/weight_kg)^0.25 applied to Z-integral |

---

## 5. Google Fit Watch HR Sync

**Feature:** Background heart-rate polling from Google Fit (or any Wear OS / Galaxy Watch / Pixel Watch that syncs to Google Fit), automatically converted into DiaTwin activity sessions that feed the ODE pharmacodynamics model.

**Pattern:** Mirrors the LibreLinkUp CGM integration exactly — one-time OAuth handshake, backend scheduler owns all subsequent syncing, mobile app is only involved at setup.

### 5.1 Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Mobile App (Expo)                 │
│  profile.tsx          WatchSyncWidget               │
│  /(settings)/watch    → watch-connect.tsx (OAuth)   │
│  services/api/        → watch-sync.ts               │
│                       → endpoints.ts  (API.WATCH.*) │
│  hooks/               → useActiveEffects.ts         │
└─────────────┬───────────────────────────────────────┘
              │  POST /api/watch/connect  { code }
              │  (one time only)
              ▼
┌─────────────────────────────────────────────────────┐
│                Flask Backend (Render)               │
│  watch_sync_routes.py    ← new blueprint            │
│  watch_sync_service.py   ← OAuth + Fit polling      │
│  watch_scheduler.py      ← APScheduler 15-min job   │
│                                                     │
│  [existing, unchanged]                              │
│  watch_hr_routes.py      ← live streaming           │
│  watch_hr_autosegment.py ← segment_hr_stream()      │
│  activity_pharmacodynamics_routes.py ← ODE          │
└─────────────┬───────────────────────────────────────┘
              │  GET  /fitness/v1/users/me/dataset:aggregate
              │  (every 15 min per connected user)
              ▼
┌─────────────────────────────────────────────────────┐
│             Google Fit REST API                     │
│  (aggregates HR from Pixel Watch, Galaxy Watch,     │
│   Wear OS, Fitbit-via-Health-Connect, etc.)         │
└─────────────────────────────────────────────────────┘
```

### 5.2 File Tree

Files marked `[NEW]` were created by this implementation. Files marked `[UPDATED]` received targeted additions.

```
native3/
├── backend/
│   ├── routes/
│   │   ├── watch_sync_routes.py        [NEW] OAuth connect/status/sync endpoints
│   │   └── watch_test_routes.py        [NEW] Dev-only test data injection (blocked on Render)
│   ├── services/
│   │   └── watch_sync_service.py       [NEW] Google OAuth + Fit REST polling
│   ├── utils/
│   │   └── watch_hr_autosegment.py     (existing — segment_hr_stream(), unchanged)
│   ├── main.py                         [UPDATED] +watch_sync_bp, +watch_scheduler
│   ├── watch_scheduler.py              [NEW] APScheduler 15-min background job
│   └── setup_watch_indexes.py          [NEW] MongoDB index creation script
│
├── mobile/
│   ├── app/(app)/settings/
│   │   ├── watch-connect.tsx           [NEW] Google OAuth WebView screen
│   │   └── watch.tsx                   [NEW] Settings/status screen + DEV test data UI
│   ├── components/(tabs)/
│   │   └── profile.tsx                 [UPDATED] +WatchSyncWidget, +onWatch handler
│   ├── hooks/
│   │   └── useActiveEffects.ts         [UPDATED] +Activity PD fetch integration
│   ├── services/api/
│   │   ├── watch-sync.ts               [NEW] API service (mirrors libre.ts)
│   │   └── endpoints.ts                [UPDATED] +API.WATCH block, +API.ACTIVITY_PD block
│   └── types/
│       └── watch.types.ts              [NEW] TypeScript types (mirrors libre.types.ts)
```

### 5.3 One-Time OAuth Connect Flow

```
User taps "Connect Google Fit"
    │
    ▼
GET /api/watch/oauth-url  (API.WATCH.OAUTH_URL)
    │  returns Google consent URL
    ▼
WebView opens accounts.google.com/o/oauth2/v2/auth
  ?scope=fitness.heart_rate.read fitness.activity.read
  &access_type=offline
  &prompt=consent          ← forces refresh_token on every connect
    │  User grants access
    ▼
Google redirects to com.diatwin.mobile://auth/watch?code=<auth_code>
    │  WebView intercepts redirect URI
    ▼
POST /api/watch/connect  { "code": "<auth_code>" }
    │
    ▼
watch_sync_service.connect_watch()
  1. exchange_auth_code()    → access_token + refresh_token from Google
  2. fetch_google_user_info() → name + email for display
  3. upsert watch_connections document
  4. _perform_sync()          → first sync immediately
```

> **Why `prompt=consent`?** Google only returns a `refresh_token` on the very first authorization per user. Adding `prompt=consent` forces the consent screen every time, guaranteeing a fresh `refresh_token`. Without this, reconnecting after a disconnect would fail silently within 1 hour.

### 5.4 Background Auto-Sync (Every 15 Minutes)

```
APScheduler wakes up (watch_scheduler.py)
    │  ├── _ping_self()   GET /api/health  ← Render free-tier keep-alive
    ▼
mongo.db.watch_connections.find({ auto_sync_enabled: True })
    │  for each connected user:
    ▼
_ensure_valid_token()
  if access_token expired → POST /o/oauth2/token (refresh_token grant)
    │
    ▼
fetch_google_fit_hr(access_token, since=last_sync-5min, until=now)
  POST https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate
  { aggregateBy: [heart_rate.bpm], bucketByTime: 60000ms }
  Filters out physiologically impossible values (< 20 or > 300 bpm).
  Safety cap: MAX_HR_SAMPLES_PER_SYNC = 3,600 samples per call.
    │
    ▼
segment_hr_stream(samples)         ← EXISTING function, unchanged
    │
    ▼
session_to_activity_doc()          ← field normalisation applied
    │
    ▼
mongo.db.activities.insert_one()   source: "google_fit"
    │
    ▼
update watch_connections.last_sync = now
```

### 5.5 API Endpoint Reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/watch/oauth-url` | GET | ✅ token | Returns Google consent URL for WebView |
| `/api/watch/connect` | POST | ✅ token | Exchange auth code; store tokens; first sync |
| `/api/watch/status` | GET | ✅ token | Connection status (no tokens exposed) |
| `/api/watch/sync` | POST | ✅ token | Manual on-demand sync |
| `/api/watch/settings` | PUT | ✅ token | Toggle auto_sync, set interval, set hr_base/hr_max |
| `/api/watch/disconnect` | DELETE | ✅ token | Remove tokens; optionally delete activity data |

**`API.ACTIVITY_PD` endpoints** (added to `endpoints.ts`):

| Key | Path | HTTP |
|---|---|---|
| `STACKED` | `/api/activity/pharmacodynamics` | GET |
| `AOB` | `/api/activity/pharmacodynamics/aob` | GET |
| `PREVIEW` | `/api/activity/pharmacodynamics/preview` | POST |

### 5.6 MongoDB Schema — `watch_connections`

```json
{
  "user_id":               "string (unique)",
  "access_token":          "string (short-lived, ~1 hour)",
  "refresh_token":         "string (long-lived, stored encrypted in production)",
  "token_expires_at":      "float (Unix timestamp)",
  "google_email":          "string",
  "google_name":           "string",
  "auto_sync_enabled":     "bool (default true)",
  "sync_interval_minutes": "int (default 15, min 15)",
  "hr_base":               "float (optional)",
  "hr_max":                "float (optional)",
  "autosegment_config":    "dict (optional)",
  "connected_at":          "ISO string",
  "last_sync":             "ISO string | null"
}
```

New `activities` docs written by this feature are schema-identical to existing watch-streaming docs, with one additional field: `"source": "google_fit"`.

### 5.7 Environment Variables

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `com.diatwin.mobile://auth/watch` — must match exactly |

### 5.8 Google Cloud Console Setup

1. **APIs & Services → Enable APIs** → enable **Fitness API**
2. **Credentials → Create OAuth 2.0 Client ID** → Application type: Android, Package name: `com.diatwin.mobile`
3. **Authorised redirect URIs**: add `com.diatwin.mobile://auth/watch`
4. **OAuth consent screen scopes**: `fitness.heart_rate.read`, `fitness.activity.read`, `userinfo.email`, `userinfo.profile`
5. Publishing status: **In testing** for dev; submit for **Production** before wider release

### 5.9 Parallel with LibreLinkUp

| Libre | Watch HR | Notes |
|---|---|---|
| `libre_routes.py` | `watch_sync_routes.py` | Same Blueprint structure |
| `libre_service.py` | `watch_sync_service.py` | Same service module layout |
| `libre_scheduler.py` | `watch_scheduler.py` | Same APScheduler pattern |
| `libre-connect.tsx` | `watch-connect.tsx` | Credentials form → OAuth WebView |
| `libre.ts` | `watch-sync.ts` | Identical Axios wrapper pattern |
| `libre.types.ts` | `watch.types.ts` | Same type shape |
| `API.LIBRE.*` | `API.WATCH.*` | Both blocks use `v()` helper |
| `LibreLiveWidget` | `WatchSyncWidget` | Same render-only-when-connected pattern |
| 4-min scheduler interval | 15-min scheduler interval | Google Fit granularity is 1-min buckets |

The one structural difference: Libre stores **credentials** (email + encrypted password) while Watch stores **OAuth tokens** (access + refresh).

### 5.10 Dev Test Harness

The `watch_test_routes.py` blueprint (dev only — HTTP 403 on Render) allows testing the full HR segmentation + ODE pipeline on a device or simulator without a real Google Fit account. It generates ~129 synthetic one-minute samples across three sessions (morning run, lunch walk, evening gym) and pipes them through the unchanged `segment_hr_stream()` → `session_to_activity_doc()` pipeline.

**Production safety:** `_assert_dev()` checks `os.environ.get("RENDER")` at the top of every handler. All three endpoints return HTTP 403 on Render regardless of any other conditions.

### 5.11 Wiring Checklist

```
Backend
  [ ] Copy watch_sync_service.py  → backend/services/
  [ ] Copy watch_sync_routes.py   → backend/routes/
  [ ] Copy watch_scheduler.py     → backend/
  [ ] Copy setup_watch_indexes.py → backend/
  [ ] Replace main.py with updated version
  [ ] python setup_watch_indexes.py   (run once)

Mobile
  [ ] Copy watch-connect.tsx  → mobile/app/(app)/settings/
  [ ] Copy watch.tsx          → mobile/app/(app)/settings/
  [ ] Copy watch-sync.ts      → mobile/services/api/
  [ ] Copy watch.types.ts     → mobile/types/          ← note: dot, not underscore
  [ ] Replace endpoints.ts with updated version
  [ ] Replace useActiveEffects.ts with updated version
  [ ] Replace profile.tsx with updated version
  [ ] expo install react-native-webview  (if not already installed)
```

---

## 6. Dual Baseline System — Technical Deep-Dive

**Primary consumer:** `ActiveEffectsDisplay.tsx`

### 6.1 What is the Baseline?

The *stable baseline* is the estimated blood glucose value the patient would have if every meal and every insulin dose they logged today had already fully resolved — in other words, their effective fasting level for the current daily window.

It is the anchor point of the bank-balance BG model:

```
estimatedBG = stableBaseline
            + cumulativeNetBaseline   (Σmeal − Σinsulin since reset)
            + activityDeltaSinceReading
```

### 6.2 Two Modes

The system implements two mutually exclusive strategies controlled by the `baseline_mode` field on `PatientConstants`:

| Mode | Value | Source |
|---|---|---|
| **Dynamic** | `'dynamic'` | Latest BG reading → unwind active effects → derive fasting BG |
| **Preset** | `'preset'` | Pre-loaded 24-hour circadian profile → look up current hour |

`'dynamic'` is the default when the field is absent. The mode persists across sessions because it lives on the server-stored `PatientConstants` object.

```typescript
const resolvedMode: 'dynamic' | 'preset' =
  (constants?.baseline_mode === 'preset') ? 'preset' : 'dynamic';
```

### 6.3 The Daily Reset Window

Both modes operate within a *daily window* — only events logged after the most recent daily reset are considered.

```typescript
const resetHour: number = constants?.daily_reset_hour ?? 7;      // default 7 AM
const tzOffset:  number = constants?.timezone_offset_minutes ?? 0;
const lastResetMs = getLastResetTimeMs(currentTime, resetHour, tzOffset);
```

All meal and dose arrays are filtered against this boundary before any calculation runs. **Critical:** The baseline and cumulative-effects functions receive `allMealsInWindow` / `allDosesInWindow`, not just still-absorbing events. Fully absorbed events must be included because their Phase 3 (persist-at-100%) contributions are still part of the cumulative sum.

### 6.4 Dynamic Mode

#### Concept

Dynamic mode derives the baseline by *reverse-engineering* a recent blood glucose reading:

```
stableBaseline = reading − cumulativeMealEffect(at reading time)
                          + cumulativeInsulinEffect(at reading time)
```

This "unwinds" whatever meals and doses were active at the exact moment the reading was taken, revealing the underlying fasting level.

#### Phase 3: Persist-at-100%

Both `calculateMealCumulativeEffect` and `calculateInsulinCumulativeEffect` implement Phase 3 behaviour: once a meal or dose has fully absorbed (hours since event ≥ PK duration), its BG contribution is locked at its maximum value and held there until the next daily reset.

```python
# pharmacodynamics.py — meal
if current_time >= end_time:
    return total_carbs * carb_to_bg_factor   # PERSISTS

# pharmacodynamics.py — insulin
if current_time >= end_time:
    return -(dose_amount * correction_factor) # PERSISTS
```

#### Post-exercise Correction Factor Override

When `sensitivityMultiplier > 1.005`, the effective correction factor from the backend is passed to the unwind function:

```typescript
sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined
```

The 0.5% dead-band suppresses floating-point noise that would otherwise cause the override to apply spuriously when no exercise has occurred.

#### Sanitization (Clamping)

After `calculateStableBaselineFromReading` returns, the raw `stableBaseline` value is passed through `sanitizeBaseline`:

| Condition | Action | Warning shown |
|---|---|---|
| `stableBaseline < 55 mg/dL` | Clamp to 55 | "Likely unlogged insulin dose" |
| `stableBaseline > 220 mg/dL` | Clamp to 220 | "Likely unlogged meal" |
| Within bounds | Pass through unchanged | None |

The raw value before clamping is preserved in `_rawBaselineValue` for display transparency. When `clampStatus === 'hard_clamped'`, `ActiveEffectsDisplay` renders a prominent orange banner.

#### No-Reading Fallback

If there is no blood glucose reading in the current window, dynamic mode falls back to `target_glucose`:

```typescript
const stableBaseline = frontendBaseline?.stableBaseline ?? targetGlucose;
// metadata.usingTargetFallback = !frontendBaseline
```

### 6.5 Preset Mode

#### Concept

Preset mode bypasses all reading-based derivation and uses a clinically-modelled 24-hour circadian profile:

- Overnight nadir (~3–5 AM, ~85 mg/dL)
- Dawn phenomenon rise (4–8 AM)
- Morning plateau (~8–12 AM, ~103–105 mg/dL)
- Post-lunch gentle peak (~13:00, ~100 mg/dL)
- Evening taper (21–23, ~91–95 mg/dL)

```typescript
export const getCircadianBaseline = (hourFloat: number, profile?: CircadianProfile): number => {
  const anchors = profile?.anchors ?? SHARED_CONSTANTS.DEFAULT_CIRCADIAN_PROFILE.anchors;
  // Linear interpolation between bounding anchor points
  // Handles midnight wraparound (hour 23 → hour 0)
  return Math.round((lower.value + t * (upper.value - lower.value)) * 10) / 10;
};
```

A patient-specific override can be stored in `constants.circadian_profile.anchors`. The reading-residual correction (`readingResidual = reading − circadianProfile(readingHour) − Σnet_at_reading`) anchors the population profile to the individual.

### 6.6 Estimated BG Assembly (Both Modes)

#### Step 10 — Corrected Cumulative Effects

```typescript
const correctedCumulative = calculateTotalCumulativeEffects(
  allMealsInWindow, allDosesInWindow, currentTime, constants,
  MEAL_ABSORPTION_PROFILES, resetHour, tzOffset, undefined,
  sensitivityMultiplier > 1.005 ? effectiveCorrectionFactor : undefined,
);
```

#### Activity Delta Since Reading

To prevent double-counting exercise that was already baked into the reading:

```typescript
const activityDeltaSinceReading = cumulativeActivityEffect - activityEffectAtReading;
// activityEffectAtReading = sum of sessions fully completed BEFORE the reading
```

#### Final Formula Summary

**Dynamic mode:**
```
stableBaseline       = reading − Σmeal_at_reading + Σinsulin_at_reading
correctedEstimatedBG = stableBaseline
                      + (Σmeal_now − Σinsulin_now)
                      + activityDeltaSinceReading
```

**Preset mode:**
```
stableBaseline       = circadianProfile(currentHour)
readingResidual      = reading − circadianProfile(readingHour) − Σnet_at_reading
correctedEstimatedBG = stableBaseline
                      + (Σmeal_now − Σinsulin_now)
                      + activityDeltaSinceReading
                      + readingResidual
```

### 6.7 Dynamic vs Preset Mode Comparison

| Aspect | 🔵 Dynamic Mode | 🟢 Preset Mode |
|---|---|---|
| **Baseline source** | Reverse-engineered from most recent BG reading | 24-hour circadian profile (population + custom anchors) |
| **Best suited for** | CGM users; frequent finger-stick checkers; post-exercise periods | CGM-less sessions; irregular loggers; testing & clinical validation |
| **Individual adaptation** | Continuous — every new reading recalibrates the baseline | Reading residual added at current time; custom anchor override by clinician |
| **Safety bounds** | [55, 220] mg/dL hard clamp; pre-clamp value retained for display | Profile is clinically bounded; no clamping required |
| **Post-exercise correction** | Effective CF override applied to the unwind when sensitivityMultiplier > 1.005 | Not applied — sensitivity not unwound from circadian profile |
| **No-reading fallback** | Falls back to target_glucose; usingTargetFallback flag shown in UI | Profile always available; no fallback needed |

### 6.8 Mode Selection Guide

| Situation | Recommended Mode |
|---|---|
| Patient checks BG frequently (manual or CGM) | **Dynamic** — the unwind gives an individualised baseline for every reading |
| Testing / development without real readings | **Preset** — produces stable numbers without needing data |
| Patient consistently deviates from population average | **Preset** with custom `circadian_profile` anchors set by a doctor |
| CGM data available | **Dynamic** — fresh readings every 5 min keep the baseline very accurate |
| Patient has irregular logging habits | **Preset** — avoids stale-reading drift that would corrupt dynamic mode |
| Post-exercise window (sensitivityMultiplier > 1) | **Dynamic** preferred — the effective CF override is applied to the unwind |

### 6.9 Configuration Reference

```typescript
// Controls mode selection
baseline_mode?: 'dynamic' | 'preset'            // default: 'dynamic'

// Used by preset mode
circadian_profile?: {
  anchors: Array<{ hour: number; value: number }>;
  source?: 'preset' | 'custom';
}

// Used by both modes
daily_reset_hour?: number                        // default: 7 (7 AM)
timezone_offset_minutes?: number                 // default: 0 (UTC)
target_glucose: number                           // fallback when no baseline

// Used by dynamic mode for unwind calculations
carb_to_bg_factor: number                        // e.g. 4.0 mg/dL per g carb
correction_factor: number                        // e.g. 40 mg/dL per unit insulin

// Hard clamp bounds (from SHARED_CONSTANTS — not patient-configurable)
BASELINE_HARD_MIN = 55   // mg/dL
BASELINE_HARD_MAX = 220  // mg/dL
```

### 6.10 Key Invariants

1. **Both modes use the same cumulative-effects calculation at step 10.** The difference is only in how `stableBaseline` is obtained.
2. **Activity delta (not full activity effect) is added to `estimatedBG`.** Sessions fully absorbed before the reading were already captured in the reading value.
3. **The clamping only applies in dynamic mode.** Preset values come from a bounded clinically-modelled table.
4. **Phase 3 persist-at-100% is always active.** Both calculation functions hold absorbed events at their maximum contribution until the next daily reset.
5. **`target_glucose` is the last resort.** `metadata.usingTargetFallback` flags this state for the UI.
6. **`sensitivityMultiplier` threshold is 1.005.** This 0.5% dead-band suppresses floating-point noise.

---

## 7. ActiveEffectsDisplay — Component Reference

**File:** `mobile/components/ActiveEffectDisplay.tsx`

`ActiveEffectsDisplay` is the primary real-time glucose management panel in DiaTwin. It synthesises every logged data source — meals, insulin doses, BG readings, and exercise sessions — into a single, continuously-updated view. The component re-fetches and recalculates every 60 seconds and supports pull-to-refresh.

### 7.1 Component Architecture

```
ActiveEffectDisplay
├─ State
│   ├─ data: ActiveEffectData | null
│   ├─ loading / error / refreshing
│   └─ UI expand flags (iobExpanded, mobExpanded, aobExpanded, …)
│
├─ fetchAndCalculate()  — runs on mount + every 60 s
│   ├─ Parallel: meals, insulin, blood-sugar, activity PD (24-h window)
│   ├─ Normalise → filter to daily window → compute IOB / MOB / AOB
│   ├─ Derive baseline (dynamic or preset)
│   └─ Assemble: estimatedBG, projectedFinalBG, per-dose/meal breakdowns
│
└─ Render
    ├─ Header — mode badge, last update timestamp
    ├─ Safety banners (clamp / low baseline / unreliable estimate)
    ├─ Three-card BG strip (Last Reading → Estimated Now → Projected)
    ├─ Two-column: IOB card (left) + MOB card (right)
    ├─ AOB card (exercise — conditional on activity data)
    ├─ Net effect card (cumulative breakdown)
    └─ Baseline details card (collapsible)
```

`ActiveEffectDisplay` accepts an optional `activityPDResult` prop. When a parent screen already holds a freshly-fetched `ActivityPDResult`, passing it as a prop eliminates a redundant ODE run.

### 7.2 Patient-Facing UI Features

| UI Panel / Feature | Patient-Facing Description |
|---|---|
| **Three-card BG strip** | Last Reading → Estimated Now → Projected Final BG. Directional arrows with signed deltas between cards. Full formula strip revealed on expand. Replaced by unreliable-estimate banner if computed BG < 10 mg/dL. |
| **Insulin On Board (IOB)** | Total active insulin units, pending BG reduction (still to arrive), absorbed BG reduction (already delivered). Per-dose breakdown with status pills (Active / Absorbed / Future). Effective CF auto-scaled when post-exercise sensitivity is elevated. |
| **Meal On Board (MOB)** | Active carbs still digesting, pending BG rise vs absorbed elevation. Per-meal breakdown: absorption type, carb count, BG effect absorbed vs pending. |
| **Activity On Board (AOB)** | Remaining acute BG drop from exercise. Sensitivity multiplier, effective ISF & CR. Per-session breakdown with teal-highlighted BG effect lines. Only displayed when valid activity PD data is present. |
| **Net Effect card** | Cumulative meal vs insulin BG displacement, net baseline, qualitative trend (rising fast / stable / falling fast), colour-coded safety status (NORMAL / CAUTION / ALERT). |
| **Baseline Details card** | Mode badge (🔵 Dynamic / 🟢 Preset), derived baseline value, reading age, meals/insulin count at reading time, pre-clamp value. Preset fields: circadian value at reading hour, net PK at reading, reading residual. |
| **Safety banners** | Baseline Capped (hard clamp, orange) — shows raw vs clamped + likely cause. Low Baseline Detected (soft warning, amber, 55–74 mg/dL). Estimation Unreliable (< 10 mg/dL) — interactive checklist with live ✓/✗ indicators. |
| **Activity–Reading overlap warning** | Amber italic warning when most recent reading was taken inside an active exercise PD window. |
| **Daily reset countdown** | Shown in IOB absorbed state and net effect footer: Xh Ym to next reset. |
| **Auto-refresh & pull-to-refresh** | 60-second polling aligned to wall-clock minute boundary. React Native RefreshControl for immediate on-demand recalculation. |

### 7.3 `useActiveEffects.ts` Updates

| Fix | Description |
|---|---|
| Activity PD fetch | `GET API.ACTIVITY_PD.STACKED` fetched concurrently alongside meals, insulin, and blood sugar. |
| 30-second debounce (D-6) | `lastActivityPDFetchMs` ref prevents hammering the ODE endpoint on rapid re-renders. Manual `refresh()` resets the debounce to 0. |
| `calculateNetEffect` (D-2) | Now imported from the canonical `@/utils/calculations/net-effect` wrapper, which accepts `activityPD` as a 7th argument. |
| Dynamic mode projection fix | `projectedFinalBG` rebuilt from `estimatedBG + pendingNetEffect` to avoid double-counting IOB. Uses sensitivity-adjusted factors when `sensitivityMultiplier > 1.0`. |
| Preset mode correction | `calculateTotalCumulativeEffects` (Phase 3-fixed version) run after `calculateNetEffect`. `cumulativeActivityEffect` added as a third signed term. |
| New public fields | `activityEffect`, `sensitivityMultiplier`, `activityOnBoard`, `activityContributions`, `activityPDResult` returned by the hook. |

### 7.4 Safety Banners

**Baseline Capped (hard clamp):** Shown in orange when dynamic baseline was forced to [55, 220] mg/dL bounds. Shows raw pre-clamp value, clamped value, and likely cause.

**Low Baseline Detected (soft warning):** Shown in amber when baseline is 55–74 mg/dL. Lists likely causes: unlogged insulin, unrecorded exercise, fewer meals logged than eaten. Suppressed in preset mode.

**Estimation Unreliable:** Shown when computed `estimatedBG` falls below 10 mg/dL. Replaces the three-card BG strip with an interactive checklist with real-time ✓/✗ status indicators for meals, doses, and BG readings.

### 7.5 Data Scope and Limitations

All values are derived exclusively from frontend pharmacodynamic calculations using patient-logged data. Accuracy is bounded by:
- The completeness and correctness of patient logs.
- The accuracy of PK parameters in `PatientConstants`.
- The recency of the most recent blood glucose reading in dynamic mode.
- The absence of factors not modelled (illness, stress hormones, site absorption variation).

---

## 8. Insulin Suggestion Logic

**Files:** `insulinCalculationService.ts` · `MealForm.tsx` · `UnifiedInsulinInput.tsx`

### 8.1 Overview

The insulin suggestion system has two distinct modes:

| Mode | Where | Input | Output |
|---|---|---|---|
| **Meal dose** | `MealForm` + `UnifiedInsulinInput` (with `suggestedDose` prop) | Foods, BG, activities, active effects | Total dose in units + insulin type + timing strategy |
| **Correction-only** | `UnifiedInsulinInput` standalone (`standalone=true`) | BG estimate, IOB, MOB | Correction dose recommendation card |

Both modes run entirely on-device — no backend round-trip for the dose calculation itself.

### 8.2 Meal Dose Pipeline (`insulinCalculationService.ts`)

#### Step 1 — Nutrition Aggregation

- **Portion scaling** — converts user's portion to a ratio against the food's reference serving size. All household units resolve through shared constants.
- **Weighted absorption type** — carb-weight-averaged absorption score, rounded and mapped to type string.

```
weightedAvg = Σ(ABSORPTION_VALUES[type] × carbs) / Σ(carbs)
absorptionType = ABSORPTION_REVERSE[round(weightedAvg)]
```

#### Step 2 — Carb Equivalents

```
proteinCarbEquiv = protein × protein_factor   (default 0.5)
fatCarbEquiv     = fat × fat_factor           (default 0.2)
totalCarbEquiv   = carbs + proteinCarbEquiv + fatCarbEquiv
```

#### Step 3a — Base Insulin & Manual Activity

```
baseInsulin     = totalCarbEquiv / ICR
activityImpact  = calculateActivityImpact(activities, constants)
manualAdjusted  = baseInsulin × activityImpact
```

> **Note:** In the unified activity pathway, `activities=[]` is always passed so `activityImpact` stays at `1.0`. The actual dose reduction comes from the sensitivity multiplier in Step 3b.

#### Step 3b — Post-Exercise Sensitivity (`computeSyntheticSensitivityMultiplier`)

ODE system (W-state, Euler integration, dt = HR_MODEL.dt minutes):
```
dHR/dt = (HR_target − HR) / τ_HR
dZ/dt  = (HR − HR_base)  / τ_Z − Z / τ_Z
dW/dt  = a × Z − W / τ_W

boost       = min(α × totalW, max_sensitivity_boost)
multiplier  = 1 + boost
effectiveCF     = CF × sensitivityMultiplier
adjustedInsulin = manualAdjusted / sensitivityMultiplier
```

| Source | How multiplier is computed |
|---|---|
| Pre-logged (backend) | `activityPD.sensitivity_multiplier` from `GET /api/activity/pharmacodynamics` |
| Manual form entry | `computeSyntheticSensitivityMultiplier(savedActivities, constants)` |
| Both present | `max(syntheticMult, backendMult)` — stronger effect wins |

#### Step 4 — Correction Insulin

```
bgForCorrection = (bgSource !== 'actual' && cumulativeActivityEffect ≠ 0)
                  ? max(40, bloodSugar + cumulativeActivityEffect)
                  : bloodSugar

correctionInsulin = (bgForCorrection − target) / effectiveCF
```

The `cumulativeActivityEffect` (signed, usually negative for aerobic) is only applied when the BG estimate was built without it already baked in.

#### Step 5 — IOB / MOB / AOB Deduction

```
mobInsulinEquivalent = activeMealCarbs / ICR
aobInsulinEquivalent = activityOnBoard  / effectiveCF

postActiveTotal = preActiveTotal − activeInsulin + mobInsulinEquivalent − aobInsulinEquivalent
```

**AOB for manual form activities (`computeSyntheticAOB`):** Uses the Z-state arm of the Breton ODE (acute drop arm, separate from W-state). Integration runs over `durationMins + 4×τ_Z`.

#### Step 5b — IOB Surplus Warning

When `postActiveTotal < −0.5u`, the patient's existing IOB already exceeds their total meal + correction need. The UI hides the dose number and instead tells the patient to eat fast carbs:

```
iobSurplusWarning = {
  surplusUnits:     round2(|postActiveTotal|),
  extraCarbsNeeded: round(|postActiveTotal| × ICR),
}
```

#### Step 6 — Predictive Peak Overlap

```
adjustmentFactor = calculateAdjustmentFromOverlap(mobAtPeak, iobAtPeak)
                 ∈ [0.5, 1.5]
predictiveTotal  = postActiveTotal × adjustmentFactor
```

#### Step 7 — Health Multiplier

Multiplies all active disease conditions and medications into a single scalar. Duration-based medications use time-modulated effect profiles.

#### Step 8 — Rounding + Safety Floor

```
totalInsulin = round(totalInsulin × 10) / 10   // 0.1 u precision
if (adjustedInsulin > 0 && postActiveTotal > 0 && totalInsulin < 0.5):
    totalInsulin = 0.5
```

### 8.3 BG Source Resolution

| Priority | Condition | `bgSource` | `bgConfidence` |
|---|---|---|---|
| 1 | Patient just entered a meter reading | `actual` | `very_high` |
| 2 | Backend estimated BG ≤ 360 min old | `estimated` | medium/high |
| 3 | Backend estimated BG > 360 min old | `estimated` | `very_low` |
| 4 | No reading, but cumulative effects available | `estimated` | `very_low` |
| 5 | Absolute fallback | `target_fallback` | `very_low` |

**Circadian preset mode (Case 2 variant):** When `baseline_mode === 'preset'`, the backend's `current_estimated_bg` is bypassed and replaced with `circadianBG + pkNet`.

### 8.4 Insulin Type Suggestion

**Dominant absorption type:** The **slowest food drives the suggestion** (worst-case timing risk). This differs intentionally from `calculateTotalNutrients`, which uses a carb-weighted average.

**Mixed meal detection:** When the meal contains both slow-group and fast-group items (pizza-effect scenario), a biphasic dosing strategy card overrides the single dominant-type suggestion.

Brand names are resolved at render time via `getInsulinBrandNames`, which reads `medication_factors` from the patient's constants — keeping brand names in sync with `constants.py` automatically.

### 8.5 Timing & Dosing Strategy

**Fast / Medium / Very Fast:** Single line: *Inject your bolus insulin, then eat your [Meal] [N] min later.*

**Slow / Very Slow — Three Options:**

| Option | Insulin | Strategy |
|---|---|---|
| **A** | Rapid-acting | `firstDose (50%) now → eat in [mins] min`, `secondDose (50%) at +90 min` |
| **B** | Short-acting (Regular) | Full dose at meal time — no wait, no split |
| **C** | Rapid-acting | Start eating → inject full dose after `afterMealMins` min |

**Mixed Meal — Two Options:**

| Option | Insulin | Strategy |
|---|---|---|
| **A** | Rapid-acting dual split | `60% (5 min before eating)` + `40% at +2.5 h after meal start` |
| **B** | Short-acting (Regular) | Full dose at meal time |

A BG check reminder is appended: *Check BG at +2 h and +5–6 h* to catch the fat-delayed peak.

### 8.6 Standalone Correction Suggestion — `buildSuggestion` Decision Tree

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
    dose ≠ null → "Suggested correction is ~{dose}u Rapid-Acting"
    dose = null → "Correction is small, no dose needed"
```

`projectedBG` already incorporates both `pendingMealRise` and `pendingInsulinReduction`, so the correction formula does **not** double-subtract IOB.

### 8.7 IOB Surplus Warning (Both Modes)

What the patient sees:
- "⚠️ IOB Covers This Meal" banner
- "No dose needed, injecting risks a low. Eat glucose tablets, juice, or fruit to offset."
- Surplus Xu pill and "Eat Yg" pill (fast carbs needed to absorb the incoming insulin)

What is hidden when the warning is active:
- The bolus insulin type recommendation
- All timing and dosing strategy cards

### 8.8 Data Flow Summary

```
Foods selected
    ▼
calculateTotalNutrients()
    ├─ Portion scaling → macro accumulation → weighted absorption type
    ▼
BG source resolution (priority 1–5)
    ▼
Unified Activity Pathway
    ├─ Manual activities → computeSyntheticSensitivityMultiplier (W-state ODE)
    ├─ Manual activities → computeSyntheticAOB (Z-state ODE)
    └─ max(syntheticMult, backendMult),  pdAOB + syntheticAOB
    ▼
calculateInsulinDose()
    ├─ Step 1: carb equivalents (protein × 0.5, fat × 0.2)
    ├─ Step 2: baseInsulin = totalCarbEquiv / ICR
    ├─ Step 3a: × activityImpact (always 1.0 in unified pathway)
    ├─ Step 3b: ÷ sensitivityMultiplier, effectiveCF = CF × mult
    ├─ Step 4: correctionInsulin = (BG − target) / effectiveCF
    ├─ Step 5: − IOB + MOB_equiv − AOB_equiv → postActiveTotal
    ├─ Step 5b: iobSurplusWarning if postActiveTotal < −0.5
    ├─ Step 6: × overlapAdjustmentFactor [0.5–1.5]
    ├─ Step 7: × healthMultiplier (conditions + medications)
    └─ Step 8: round to 0.1u, floor at 0.5u if needed
    ▼
Dose card render
    ├─ IOB surplus banner ──→ hide type + timing, show "Eat Xg" instead
    ├─ Line 1: dose value + absorption type label
    ├─ Line 2: 💉 Bolus insulin type
    └─ Line 3+4: Timing strategy
           ├─ fast/medium/very_fast → single timing line
           ├─ slow/very_slow        → Options A (split) / B (Regular) / C (post-meal)
           └─ mixed meal            → Options A (dual 60/40 split) / B (Regular)
```

---

## 9. Platform Architecture & Stack

### Technology Stack

| Layer | Technology |
|---|---|
| **Backend Language** | Python 3.x with Flask microframework |
| **Database** | MongoDB (via Flask-PyMongo) — document-based, schema-flexible |
| **Background Jobs** | APScheduler 3.10+ (BackgroundScheduler + IntervalTrigger, coalesce=True, max_instances=1) |
| **Authentication** | PyJWT — signed JWT tokens |
| **Encryption** | cryptography library (Fernet symmetric encryption for CGM credentials) |
| **Web Frontend** | React JS (JavaScript) — recharts for visualization, Context API for state |
| **Mobile Frontend** | React Native with Expo Router — TypeScript, victory-native for charting |
| **Mobile State** | Zustand stores (auth, meal, offline, patient) |
| **HTTP Client** | Axios (mobile + web), versioned API endpoint constants (`endpoints.ts`) |
| **Deployment** | Render.com (free tier with APScheduler keep-alive every 4 min) |
| **Clinical Reference** | German S3 Guideline AWMF 057-013 — Table 9 insulin profiles |

### Backend Core Files

`main.py` · `constants.py` (single source of truth for all PK params) · `blood_sugar.py` · `meal_insulin.py` · `activity.py` · `time_manager.py` · `libre_scheduler.py` · `watch_scheduler.py`

**Routes:** `auth_routes.py` · `blood_sugar` · `meal_routes.py` · `medication_routes.py` · `patient_routes.py` · `doctor_routes.py` · `cumulative_effects_routes.py` · `food_routes.py` · `libre_routes.py` · `watch_sync_routes.py` · `activity_pharmacodynamics_routes.py` · `import_routes.py`

### Key Backend Logic

- **Baseline calc:** `baseline = BG − (meal_impact − insulin_impact)` stored with every reading
- **Daily reset:** configurable hour, timezone-aware via `timezone_offset_minutes`
- **IOB engine:** all S3 insulin types (ultra-rapid Fiasp/Lyumjev, rapid NovoRapid/Humalog/Apidra, short Regular, intermediate NPH, long Toujeo/Tresiba/Levemir, mixed 70/30)
- **MOB engine:** 5 absorption profiles (very slow → very fast, gamma distribution)
- **Meal calc:** 12-factor insulin dose (ICR, protein, fat, timing, time-of-day, absorption modifier, activity coefficient, disease factor, medication factor, IOB correction, correction dose, health multiplier)
- **CGM:** Abbott LibreLinkUp, Fernet-encrypted credentials, 10+ regions, auto-refresh tokens 24h before expiry
- **Watch HR:** Google Fit OAuth, APScheduler 15-min background sync, swim-lane auto-segmentation
- **Security:** bcrypt passwords, PyJWT (24h web / 90d mobile), Fernet AES-128-CBC, RBAC (patient/doctor/admin), consent-based doctor sharing

### Shared Constants System

A single `constants.py` file serves as the source of truth for all pharmacokinetic parameters, absorption profiles, and dose-adjustment factors. On every login, the full constant set is serialised and embedded in the login response payload (`shared_constants`), ensuring all platforms are always in sync without file writes — critical for Render.com's ephemeral filesystem.

---

## 10. Patient-Facing Features

### 10.1 Blood Glucose Management

#### Manual Blood Glucose Logging (SMBG)

Patients log fingerstick readings with validation (0–600 mg/dL), timestamp, source flag, and optional free-text notes. On save, the backend immediately calculates a stable baseline. Supports real-time logging and back-dated entries via a custom timestamp picker.

#### CGM Integration — Abbott LibreLinkUp

- Multi-region support: EU, US, AUS, CA, JP, DE, FR, NL, SE, SE2, and global fallback
- Token auto-refresh: up to 24 hours before expiry
- Background APScheduler: per-patient configurable sync interval (min 4 min, default 5 min), coalesced runs, max 1 concurrent instance. Also doubles as Render.com free-tier keep-alive. Each sync imports up to 500 readings with duplicate prevention.

### 10.2 Meal Tracking & Insulin Calculation

#### Food Database — 15 Categories

| Category | Contents |
|---|---|
| Basic Foods | Core staples — bread, rice, pasta, potatoes, eggs |
| Starch List | Cereals, grains, starchy sides |
| Starchy Vegetables | Corn, sweet potato, parsnip |
| Pulses | Lentils, chickpeas, beans, peas |
| Fruits | Fresh and dried fruits with glycaemic index context |
| Milk & Dairy | Milk, yoghurt, cheese, cream |
| Sweets & Desserts | Biscuits, cakes, chocolate, ice cream |
| Snacks | Crisps, crackers, popcorn, granola bars |
| High Protein Foods | Meat, fish, eggs, tofu |
| High Fat Foods | Nuts, oils, butter |
| Indian Dishes | Dal, biryani, samosa, curries, naan |
| Chinese Dishes | Fried rice, noodles, dim sum, dumplings |
| Italian Dishes | Pasta varieties, pizza, risotto, focaccia |
| Egyptian Dishes | Ful medames, koshari, feteer, om ali, kunafa |

#### Meal Absorption Profiles

| Profile | Onset | Peak | Duration | Examples |
|---|---|---|---|---|
| Very Slow | ~20 min | ~3 h | ~8 h | Legumes, fatty meals |
| Slow | ~15 min | ~2 h | ~6 h | Whole grains, dairy |
| Medium | ~10 min | ~1.5 h | ~4 h | Standard mixed meals |
| Fast | ~5 min | ~1 h | ~3 h | White bread, fruit |
| Very Fast | ~2 min | ~0.5 h | ~2 h | Glucose tablets, juice |

#### Insulin Dose Calculation Engine — 12 Factors

| Factor | Description |
|---|---|
| Carbohydrate Dose | Total carbs ÷ insulin-to-carb ratio (ICR) |
| Protein Correction | Protein × protein_factor (delayed glucose effect) |
| Fat Correction | Fat × fat_factor (slows absorption, extends insulin need) |
| Meal Timing Factor | Breakfast +20%, dinner −10% — reflects dawn phenomenon |
| Time-of-Day Factor | Morning 6–10h: +20%; daytime: ×1.0; late night: −10% |
| Absorption Modifier | Very slow ×0.6 → very fast ×1.4 |
| Activity Coefficient | Vigorous −20% to sedentary +20% |
| Disease Factor | T1D ×1.0; T2D ×0.8; gestational ×1.2; insulin resistance ×0.7 |
| IOB Correction | Active insulin on board subtracted to prevent stacking |
| Correction Dose | (current BG − target BG) ÷ correction factor |
| AOB Correction | Activity-on-Board subtracted as insulin equivalent |
| Health Multiplier | Active conditions + medications composite factor |

### 10.3 Insulin & Medication Management

#### IOB Engine — S3-Referenced Insulin Types

- **Ultra-rapid:** Fiasp (insulin aspart faster), Lyumjev (lispro-aabc)
- **Rapid-acting:** NovoRapid / Humalog / Apidra / Admelog
- **Short-acting:** Regular insulin (Humulin R, Novolin R)
- **Intermediate:** NPH insulin (Humulin N, Novolin N)
- **Long-acting:** Toujeo, Tresiba (degludec, 42+ h duration), Levemir
- **Mixed:** 70/30, 50/50 combinations

### 10.4 Activity Tracking

#### Activity Level — Dose Adjustment Scale

| Level | Coefficient | Insulin Impact |
|---|---|---|
| Very Sedentary (−2) | ×1.2 | 20% increase in insulin need |
| Sedentary (−1) | ×1.1 | 10% increase |
| Normal Activity (0) | ×1.0 | No adjustment |
| High Activity (+1) | ×0.9 | 10% reduction |
| Vigorous Activity (+2) | ×0.8 | 20% reduction |

### 10.5 Patient Constants & Personalisation

| Parameter | Description | Default |
|---|---|---|
| `insulin_to_carb_ratio` | Units of insulin per gram of carbohydrate | 10 |
| `correction_factor` | mg/dL glucose drop per unit of insulin | 40 |
| `target_glucose` | Personal target blood glucose (mg/dL) | 100 |
| `protein_factor` | Fraction of protein treated as carb equivalent | 0.5 |
| `fat_factor` | Fraction of fat treated as carb equivalent | 0.2 |
| `carb_to_bg_factor` | mg/dL rise per gram of absorbed carbohydrate | 4.0 |
| `daily_reset_hour` | Hour of day (local time) for cumulative effects reset | 7 |
| `baseline_mode` | `'dynamic'` or `'preset'` | `'dynamic'` |
| `timezone_offset_minutes` | UTC offset (e.g. UTC+2 = 120) | — |

---

## 11. Healthcare Provider Features

### 11.1 Patient Panel

Each doctor sees only patients who have explicitly authorised them. Patients can revoke access at any time. The patient list includes name, email, active conditions, and active medications.

### 11.2 Patient Data Views

Authorised doctors can access:
- Full glucose history with date/time range filtering (readings + CGM data)
- Complete meal history with nutritional breakdown and insulin calculations
- Medication logs and active insulin schedules
- Patient constants (ICR, correction factor, target glucose, and all other parameters)
- Activity logs
- Cumulative and active pharmacodynamic effects at any chosen point in time

### 11.3 Access Control Model

| Role | Permissions |
|---|---|
| **Patient** | View and manage own data only. Grant and revoke doctor access. |
| **Doctor** | View all data of authorised patients. Update patient constants and medication schedules. Cannot access non-authorised patients. |
| **Admin** | Full read access to all patients. Platform oversight. |

### 11.4 Clinical Glucose Visualization (Doctor View)

The `ClinicalValidationDashboard` and `DoctorBGVisualization` components give clinicians an overlay of actual readings against model-predicted glucose trajectories.

---

## 12. Mobile Application

### 12.1 Overview

The DiaTwin mobile app is a fully featured iOS and Android application built with React Native and Expo Router. JWT tokens issued to mobile clients have a 90-day lifetime vs. 24-hour for web.

### 12.2 Tab Navigation Structure

| Tab | Description |
|---|---|
| **Home** | Primary patient dashboard — charts, active effects, quick actions, recent meals |
| **Log** | Quick multi-mode data entry (glucose / insulin / meal / activity) |
| **History** | Unified chronological feed of all health events |
| **Visualization** | Dedicated full-screen chart explorer with three chart modes and interactive legends |
| **Profile** | Account settings, patient constants, device management (CGM + Watch HR), data export |
| **Doctor Dashboard** | Doctor-only: patient list and deep per-patient clinical view |

### 12.3 Active Effects Display

All seven values calculated entirely on-device — no network round-trip required:
- **IOB:** active insulin units, estimated BG reduction, per-dose contribution breakdown
- **MOB:** grams of carbohydrate still being absorbed, equivalent pending BG rise
- **AOB:** remaining acute BG drop from exercise, session breakdown, sensitivity multiplier
- **Stable Baseline:** derived from last actual BG reading minus cumulative net pharmacodynamic effects (dynamic) or circadian profile with reading residual (preset)
- **Estimated Current BG:** baseline plus net effect from all meals and insulin since daily reset
- **Projected Final BG:** estimated glucose when all current MOB and IOB fully resolve
- **Trend:** rising / stable / falling with colour-coded safety status (safe / caution / warning)

### 12.4 Full Meal Screen — 9-Step On-Device Calculation Pipeline

1. Total nutrients
2. Protein & fat → carb equivalents
3. Base insulin (ICR)
4. Activity impact (sensitivity multiplier pathway)
5. Correction dose
6. IOB / MOB / AOB deduction
7. Peak-overlap adjustment
8. Health multipliers
9. Safety floor (0.5u min) + 0.1u rounding

### 12.5 Profile & Settings

| Screen | Contents |
|---|---|
| **Patient Constants** | Read-only display of all 15 patient constants |
| **Medications** | Active medications with PK profiles (onset / peak / duration) and schedules |
| **Manage Doctors** | Browse available doctors; authorise / revoke access |
| **Food Database** | Search (300ms debounce), category filter, favourites, custom food entry |
| **LibreLinkUp CGM** | Day-grouped CGM readings, manual sync, auto-sync toggle |
| **Connect LibreLinkUp** | Email + password form, 10+ region chip selector |
| **Google Fit / Watch HR** | OAuth connect flow, sync status, sync interval, hr_base/hr_max settings, test harness (dev) |
| **Data Export (GDPR)** | One-tap JSON export, full GDPR rights disclosure, account deletion request |

### 12.6 Offline Architecture

- Real-time network monitoring via `Network.addEventListener`
- Action queue with UUID, status (pending / syncing / failed), and retryCount
- Auto-sync: `processQueue()` runs automatically when `isOnline` becomes true
- Queue persistence via `AsyncStorage` on app launch

### 12.7 Authentication & Onboarding

- User type toggle: Patient / Doctor
- Cold-start detection: `useAuth` detects `ERR_NETWORK` and activates `WakeUpBanner` with animated progress bar
- Registration: username, email, password, user type, with validation
- Forgot password: email entry, backend sends reset link

---

## 13. Platform & Community Features

### 13.1 Data Import & Export

- **Import:** upload CSV or JSON → validate endpoint reports row counts and errors → confirmed import writes to `meals`, `blood_sugar`, `activities`, and `insulin` collections
- Selective import by data type: all, meals, blood_sugar, activities, or insulin only
- **Export:** one-tap JSON download of complete patient history
- **GDPR compliance:** full data portability, account deletion request, and rights disclosure

### 13.2 Food Community Features

- **Custom Food Database:** any patient can add custom food items
- **Favourite Foods:** frequently eaten foods marked for rapid access; `FoodSearch` maintains a module-level cache for instant rendering
- **Global Cuisine Coverage:** four ethnic cuisine categories (Indian, Chinese, Italian, Egyptian)

### 13.3 Security & Privacy

| Measure | Implementation |
|---|---|
| **Password Security** | bcrypt hashing via Werkzeug |
| **JWT Authentication** | Signed tokens with role claim; 24-hour expiry for web, 90 days for mobile |
| **Credential Encryption** | LibreLinkUp credentials encrypted with Fernet (AES-128-CBC) before MongoDB storage |
| **OAuth Token Storage** | Google Fit tokens stored with encryption; `refresh_token` protected |
| **Role-Based Access** | Patient / Doctor / Admin roles enforced on every API endpoint |
| **Consent-Based Sharing** | Patients explicitly authorise individual doctors; revocable at any time |
| **No Cross-Patient Leakage** | Doctor queries always scoped to authorised patient list |

---

## 14. API Endpoint Index

> *Source of truth: `endpoints.ts`*

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/login` | Sign in, returns JWT + role + `shared_constants` payload |
| POST | `/register` | Create patient/doctor/admin account |
| POST | `/logout` | Sign out |

### Patient

| Method | Endpoint | Description |
|---|---|---|
| GET/PUT | `/api/patient/constants` | Retrieve and update all patient parameters |
| GET | `/api/patient/profile` | Patient profile |
| GET | `/api/patient/authorized-doctors` | List of authorised doctors |
| POST | `/api/patient/authorize-doctor` | Grant doctor access |
| DELETE | `/api/patient/revoke-doctor` | Revoke doctor access |
| GET | `/api/patient/export` | Full GDPR data export |

### Blood Glucose

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/blood-sugar` | Log a reading (automatic baseline calculation) |
| GET | `/api/blood-sugar` | Retrieve readings with date/time range filter |
| DELETE | `/api/blood-sugar/{id}` | Delete a reading |

### Meals

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/meal` | Log a meal with full server-side insulin calculation |
| GET | `/api/meals-only` | Retrieve meal history |
| DELETE | `/api/meal/{id}` | Delete a meal |
| POST | `/api/meal/calculate` | Calculate insulin without logging |

### MOB (Meal on Board)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/meal-on-board` | Current MOB with absorption breakdown |
| GET | `/api/active-meals` | All currently absorbing meals |
| GET | `/api/meal-timing-assessment` | Pre-meal safety check |

### Insulin & Medication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/insulin/log` | Log a standalone insulin dose |
| GET | `/api/insulin/active-effect` | Current IOB |
| GET | `/api/insulin-data` | Dose history |
| GET/POST | `/api/medication-schedule` | Manage recurring schedules |

### Cumulative Effects

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/cumulative-effects` | Daily cumulative baseline shift |
| GET | `/api/net-effect` | Current net pharmacodynamic effect |
| GET | `/api/active-effects-full` | Complete real-time picture (IOB + MOB + cumulative + baseline) |

### Activities & Activity Pharmacodynamics

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/activities` | Activity list |
| POST | `/api/record-activities` | Log expected and/or completed activities |
| GET | `/api/activity/pharmacodynamics` | Stacked ODE effect (60 s TTL cache) |
| GET | `/api/activity/pharmacodynamics/aob` | Activity-on-Board (AOB) per session |
| POST | `/api/activity/pharmacodynamics/preview` | Simulate planned activity effect |
| POST | `/api/watch/activity/start` | Open a real-time wearable session |
| POST | `/api/watch/hr/stream` | Push batched per-second HR samples |
| POST | `/api/watch/activity/end` | Finalise session (invalidates PD cache) |
| GET | `/api/watch/activity/status` | Crash-recovery status |
| GET | `/api/watch/hr/raw/<session_id>` | Full per-second HR trace |
| POST | `/api/watch/hr/continuous` | Upload all-day HR stream for auto-segmentation |

### Google Fit Watch HR Sync

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/watch/oauth-url` | Returns Google consent URL |
| POST | `/api/watch/connect` | Exchange auth code; first sync |
| GET | `/api/watch/status` | Connection status |
| POST | `/api/watch/sync` | Manual on-demand sync |
| PUT | `/api/watch/settings` | Toggle auto_sync, interval, hr_base/hr_max |
| DELETE | `/api/watch/disconnect` | Remove tokens; optionally delete activity data |

### Doctor

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/doctor/patients` | Authorised patient list |
| GET/PUT | `/api/doctor/patient/{id}/constants` | Read and update patient constants |
| POST | `/api/doctor/patient/{id}/constants/reset` | Reset to defaults |

### Food

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/food/categories` | Full category list with measurements |
| GET | `/api/food/search?q=&category=` | Unified search (built-in + custom) |
| GET/POST/DELETE | `/api/food/custom` | Manage custom foods |
| GET/POST/DELETE | `/api/food/favorite` | Manage favourites |

### LibreLinkUp CGM

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/libre/connect` | Store encrypted Abbott credentials and connect |
| DELETE | `/api/libre/disconnect` | Disconnect |
| GET | `/api/libre/status` | Connection status, last sync time |
| POST | `/api/libre/sync` | Manual sync |
| PUT | `/api/libre/settings` | Update `auto_sync_enabled` / `sync_interval_minutes` |
| GET | `/api/libre/readings` | Stored CGM readings |

### Import / Export

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/import/validate` | Validate import file |
| POST | `/api/import` | Confirmed import |
| GET | `/api/patient/export` | Full GDPR data export |

### Health

| Method | Endpoint | Description |
|---|---|---|
| GET | `/test` | Health check / keep-alive |

---

## 15. Proposed Research Agenda

- **Clinical validation:** Prospective trial (N=100 T1D patients, 6 months) to assess safety and efficacy of PK/PD-guided dosing support vs. standard care. Primary endpoint: time-in-range improvement.
- **Circadian ML validation (Phase 2 RCT):** Prospective pilot RCT (N=30, 6 months) validating circadian RL-based ISF/ICR adjustment against standard pen-user care.
- **Baseline system sub-study:** Comparative accuracy of dynamic vs preset mode against gold-standard CGM continuous readings across circadian blocks — enabling prospective validation of the bimodal estimator.
- **Model refinement:** Integration of individual physiological parameters derived from longitudinal CGM + insulin logs.
- **Regulatory pathway:** CE Class IIa SaMD classification + DiGA fast-track evaluation (§139e SGB V).
- **Equity dimension:** Validation of pen-user mode (finger-prick only) for settings where CGM access is limited (LMIC arm planned).

---

## 16. Positioning vs. Existing Solutions

| Feature | DiaTwin | CGM-only / Basic apps |
|---|---|---|
| **Real-time IOB + MOB + AOB tracking** | ✓ (gamma distribution + ODE, S3-referenced) | ✗ |
| **Works with insulin pens** | ✓ | ✗ (pumps only for closed-loop) |
| **Physician-set parameters** | ✓ (remote validation) | ✗ |
| **Future glucose projection** | ✓ (4-hour IOB + MOB) | Trend only |
| **Personalisation over time** | ✓ (RL from outcomes) | ✗ |
| **Circadian ISF/ICR adjustment** | ✓ (RL, time-of-day blocks) | ✗ |
| **Activity ODE pharmacodynamics** | ✓ (Y/Z/W, wearable or categorical) | ✗ |
| **Dual baseline estimator** | ✓ (dynamic + preset modes) | ✗ |
| **Google Fit background sync** | ✓ (15-min scheduler, OAuth) | ✗ |
| **Cost to patient** | ~€100/year | €3,000–16,000/year |

---

## 17. Lead Researcher Profile

| | |
|---|---|
| **Academic** | M.Sc. Digital Health, DIT Germany (1.6 "Excellent"); B.Sc. Pharmacy, Zagazig University (1.5 "Excellent") |
| **Licence** | German Pharmacist Licence (Berufserlaubnis §11 BApO, Upper Bavaria 2025); Fachsprachenprüfung passed |
| **Clinical Informatics** | Senior Clinical Data Specialist, Egypt Healthcare Authority (2021–2023): national EHR rollout, FHIR R4, ICD-10, SNOMED CT, 500+ staff trained |
| **Technical** | Python, ML/RL (Scikit-learn, TensorFlow), full-stack (React, Flask, MongoDB), HL7-FHIR R4 implementation |
| **Clinical Advisory** | Prof. Dr. Klaus Parhofer (LMU Munich) — protocol advisor; Prof. Dr. Katarina Braune (Charité/HPI) — clinical trial co-PI |

**GitHub:** [github.com/aliattia2](https://github.com/aliattia2) | **LinkedIn:** [linkedin.com/in/ali-attia-74748bb4](https://linkedin.com/in/ali-attia-74748bb4) | **Demo:** [dia-twin.vercel.app](https://dia-twin.vercel.app) | **Email:** aliattia2@gmail.com

---

## 18. Acknowledgements

Insulin pharmacokinetic parameters are based on the **German S3 Guideline** *'Therapie des Typ-1-Diabetes'*, Version 5.0 (AWMF-Registry: 057-013), published in *Diabetologie und Stoffwechsel* 2024; 19: S155–S166. DOI: 10.1055/a-2312-0276.

CGM integration is provided via the Abbott LibreLinkUp API. Abbott and FreeStyle Libre are trademarks of Abbott Laboratories.

### Key References

- Dalla Man C, Raimondo DM, Rizza RA, Cobelli C. GIM, Simulation Software of Meal Glucose-Insulin Model. *J Diabetes Sci Technol.* 2007.
- Dalla Man C et al. Meal Simulation Model of the Glucose-Insulin System. *IEEE Trans Biomed Eng.* 2014.
- Dalla Man C, Breton MD, Cobelli C. Physical Activity into the Meal Glucose-Insulin Model of Type 1 Diabetes. *Diabetes Technol Ther.* 2009;3(1):56–67.
- Breton MD. Physical activity — the major unaccounted impediment to closed loop control. *J Diabetes Sci Technol.* 2008;2(1):169–174.
- Romeres D, Dalla Man C et al. Effect of walking on glucose metabolism in subjects with different degrees of glucose tolerance. *Am J Physiol Endocrinol Metab.* 2021;321:E122–E130.
- Kovatchev BP et al. Evaluating the accuracy of continuous glucose monitoring sensors. *Diabetes Care.* 2009.
- AWMF S3-Leitlinie Therapie des Typ-1-Diabetes, Register-Nr. 057-013, Table 9 — Insulin action profiles.

---

*DiaTwin — Empowering patients. Supporting clinicians. Built on science.*
