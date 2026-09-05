# DiaTwin — Complete Documentation

> **Clinical & Technical Reference**  |  TRL 4–5  |  [dia-twin.vercel.app](https://dia-twin.vercel.app)
>
> **Contact:** Ali Attia  |  aliattia2@gmail.com  |  [LinkedIn](https://linkedin.com/in/ali-attia-74748bb4)  |  [GitHub](https://github.com/aliattia2)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Research Concept Brief (DE)](#2-research-concept-brief)
3. [Core Technical Components](#3-core-technical-components)
4. [Activity Integration — ODE Engine](#4-activity-integration--ode-engine)
5. [Platform Architecture & Stack](#5-platform-architecture--stack)
6. [Patient-Facing Features](#6-patient-facing-features)
7. [Healthcare Provider Features](#7-healthcare-provider-features)
8. [Mobile Application](#8-mobile-application)
9. [Platform & Community Features](#9-platform--community-features)
10. [API Endpoint Index](#10-api-endpoint-index)
11. [Proposed Research Agenda](#11-proposed-research-agenda)
12. [Positioning vs. Existing Solutions](#12-positioning-vs-existing-solutions)
13. [Lead Researcher Profile](#13-lead-researcher-profile)
14. [Acknowledgements](#14-acknowledgements)

---

## 1. Executive Summary

### Clinical Problem

Type 1 Diabetes (T1D) patients using standard insulin pens lack tools to translate continuous glucose data into actionable dosing decisions. Despite the widespread adoption of CGM sensors and finger-prick testing, no affordable software-based decision support exists that models both insulin activity and meal absorption simultaneously in real time. The result: chronic under- and overdosing, high hypoglycaemia risk, and significant cognitive burden on patients and clinicians.

### System Overview

DiaTwin is a clinically supervised decision-support platform for T1D management. It creates a personalised physiological model — a **Digital Twin** — of each patient's blood glucose behaviour. It is designed primarily for T1D, where the complete absence of endogenous insulin production means that glucose effects persist and stack rather than self-correct, requiring a fundamentally different computational model from conventional diabetes apps.

The platform models the pharmacodynamics of insulin and meal absorption in real time, enabling personalised dosing guidance for patients using standard insulin pens — without requiring an insulin pump.

**Platform:** Web application (React/TypeScript) + Android app + REST API (Python/Flask, MongoDB)

**Live demo:** [dia-twin.vercel.app](https://dia-twin.vercel.app)  |  Doctor login: `doctor / 4444`  |  Patient: `ahmed / 4444`

**Development status:** TRL 4–5. Core algorithms validated. Web + mobile prototypes operational.

**Academic basis:** M.Sc. thesis, DIT Germany (grade 1.6 "Excellent"), clinical supervision: Prof. Dr. Klaus Parhofer, LMU Munich. External evaluation: Excellent. Clinical Utility Score: 8.7/10.

The platform combines three layers of technology:

1. A mathematically rigorous pharmacodynamics engine grounded in the **German S3 clinical guidelines** (AWMF-Registry 057-013, Table 9 insulin characteristics), using gamma-distribution curves to model both carbohydrate absorption and insulin activity with physiological accuracy.
2. A **real-time glucose estimation and prediction system** that uses logged meals, insulin doses, and activity data to estimate glucose between fingerstick readings — and optionally fuses this with live CGM data from Abbott LibreLinkUp.
3. A **multi-role clinical platform** where patients manage their own day-to-day diabetes care while authorised physicians review trends, meal histories, and glucose visualisations across their entire patient panel.

---

## 2. Research Concept Brief

> *Forschungskonzept-Brief  |  Personalisierte Insulindosierung durch zirkadian-bewusstes Reinforcement Learning*

### Das Problem

Über 8 Millionen Menschen mit Typ-1-Diabetes weltweit sind auf Insulinpens angewiesen. Trotz weit verbreiteter CGM-Nutzung existiert kein bezahlbares Entscheidungsunterstützungstool, das gleichzeitig Insulin-Pharmakodynamik, Mahlzeitenabsorption, körperliche Aktivität und zirkadiane Variabilität berücksichtigt. Starre Korrekturfaktoren führen zu chronischen Dosierungsfehlern, erhöhtem Hypoglykämierisiko und hoher kognitiver Belastung.

### Funktionsweise — Kontextuelle Dosierungspipeline

| Schritt | Beschreibung |
|---|---|
| **Mahlzeitenfoto → KH** | Kamerabasierte Lebensmittelerkennung extrahiert Makronährstoffe (KH, Eiweiß, Fett) und weist automatisch ein Absorptionsprofil zu (sehr schnell → sehr langsam) |
| **PK/PD-Modellierung** | IOB (Insulin on Board) und MOB (Meal on Board) werden über Gamma-Verteilungskurven berechnet; kumulative Tageseffekte und prädiktive Peaküberschneidungen eingeschlossen |
| **Aktivitätsanpassung** | Protokollierte und wearable-basierte Aktivität modifiziert die Insulinsensitivität in Echtzeit — akute Aufnahme (GLUT4-unabhängig) und prolongierter Post-Exercise-Effekt |
| **BZ + zirkadianer Ausgangswert** | Aktueller Glukosewert (CGM oder Fingerstich) korrigiert gegen 24-Stunden-Anker: nächtliches Nadir, Dawn-Phänomen, Tagesplateau |
| **Dosis + Insulintyp** | Empfohlene Einheiten (0,1 IE gerundet, Untergrenze 0,5 IE) plus passendes Analogon (schnellwirkend vs. Standard) entsprechend Absorptionsprofil |
| **Kliniker-geführte Personalisierung** | Alle Mahlzeit–Insulin–Aktivität–Ergebnis-Tupel protokolliert und in Patientenakten für betreuende Ärzte sichtbar. Direktes ISF/ICR-Update möglich. Vollautomatische ML-Parameterrefinierung pro 2-Stunden-Block in nächster Phase geplant. |

### Alleinstellungsmerkmale

| Feature | Beschreibung |
|---|---|
| **Foto-zur-Dosis** | Kamera auf Mahlzeit → KH-Schätzung → Insulinempfehlung. Keine manuelle Eingabe |
| **Vollst. Kontextfenster** | Mahlzeiten, Dosen, Aktivität und BZ-Werte fließen in jede Empfehlung ein |
| **Zirkadiane Anpassung** | Tageszeit-ISF/ICR-Personalisierung via RL – in keinem aktuellen Pen-Tool vorhanden |
| **Kein Pumpe nötig** | Funktioniert mit Standard-Insulinpens und Fingerstich- oder CGM-Daten |
| **Equity by Design** | Konzipiert für Umgebungen mit eingeschränktem CGM-Zugang – LMIC-Arm geplant |

### Aktueller Stand & Qualifikationen

| | |
|---|---|
| **Prototyp** | Live Web-App + Android-App – einsatzbereit, demo-fähig ([dia-twin.vercel.app](https://dia-twin.vercel.app)) |
| **Akademisch** | M.Sc. Digital Health, DIT Deutschland – Note 1,6 (Ausgezeichnet, 2025) |
| **Klin. Beratung** | Prof. Dr. Klaus Parhofer, LMU München (Medizinische Klinik IV) – Betreuer |
| **Trainingsdaten** | RL-Engine vortrainiert auf 50.000+ reale Mahlzeit-Ergebnis-Datenpaare; Out-of-Sample-Stresstests mit dem AZT1D-Datensatz (25 T1D-Patienten, CGM + Bolusdaten + Kohlenhydrataufnahme) |
| **Forscher** | Apotheker (§11 BApO), M.Sc. Digital Health, Senior Clinical Informatics (HL7-FHIR R4) |

### Vorgeschlagene Zusammenarbeit

Konzipierung und Durchführung einer prospektiven Pilot-RCT (N = 30, 6 Monate), die die zirkadiane ML-Anpassung gegen die Standard-Versorgung mit Insulinpens validiert. Gesprächsbereit zu Betreuung, klinischer Studieninfrastruktur und gemeinsamer Förderantragsentwicklung.

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
| **CGM Integration** | Direct sensor connection (Abbott/Dexcom API discussions ongoing); automatic glucose data ingestion. |

---

## 4. Activity Integration — ODE Engine

> *DiaTwin Research Summary, Section 3 — Updated Technical Description*

### Overview

Physical activity is incorporated as a real-time, session-aware modifier of predicted blood glucose, adjusting for both the acute insulin-independent glucose uptake during exercise (IIRd) and the prolonged post-exercise enhancement of insulin sensitivity (IDRd). The system operates end-to-end: from raw heart rate ingestion through auto-segmentation and ODE pharmacodynamics to a signed cumulative BG effect and a sensitivity multiplier applied to ISF and carbohydrate ratio.

### 4.1 ODE Model — Y / Z / W System

Activity pharmacodynamics are modelled via a three-state ODE system (Dalla Man, Breton & Cobelli, 2009; Breton, 2008; Romeres et al., 2021), numerically integrated at 1-minute Euler steps. The system is implemented identically in both the Python backend (`activity_pharmacodynamics.py`) and a JavaScript frontend port (`activityPharmacodynamics.js`) for offline-capable calculation.

#### State Variables

**Y — HR Filter (Energy Expenditure Proxy)**
First-order low-pass filter of heart rate above the patient's resting baseline (τ_HR = 5 min). `dY/dt = (HR_above / τ_HR) − (Y / τ_HR)`. Captures the physiologically meaningful fraction of HR response, smoothing out beat-to-beat variability.

**Z — Acute IIRd Signal**
Encodes direct, insulin-independent muscle glucose uptake via contractile GLUT4 activation. Z rises toward 1 while the patient is in the exercise window and Y exceeds the onset threshold (a · HR_base, a = 0.05); it decays exponentially with τ_Z = 10 min after exercise ends. The cumulative integral of Z × 0.15 mg/dL/min constitutes the acute BG-lowering effect (IIRd pathway), with an allometric weight correction of (70 / weight_kg)^0.25 applied to account for inter-patient body-mass variation.

**W — Cumulative Load Integral**
Integrates Y during exercise (`dW/dt = Y`), then decays with τ_W = 90 min in recovery. W encodes the joint intensity × duration load that drives prolonged GLUT4 receptor upregulation. The post-exercise ISF/CR sensitivity multiplier is computed as `1 + α · W · (1 + Z)`, with α = 0.0008 and a hard cap of 60% above baseline. Because GLUT4 upregulation is not linearly additive across concurrent sessions, the maximum multiplier across all active sessions in the current window is applied rather than their arithmetic sum.

#### Derived Clinical Outputs

- **Signed cumulative BG effect** (mg/dL): Controlled by a `bg_direction` field per session — `-1` = aerobic/BG-lowering (default); `+1` = BG-raising for specific session types. Effects are summed across all sessions within the current daily reset window.
- **Sensitivity multiplier** applied directly to dosing parameters: `correction_factor` (ISF) is multiplied; `carb_to_bg_ratio` (ICR) is divided, producing activity-adjusted constants active for the duration of the post-exercise window.
- **Activity-on-Board (AOB)** — analogous to IOB. Tracks the remaining undelivered BG-drop magnitude and absorbed fraction for each session in real time, exposed both per-session and as a total via the `/api/activity/pharmacodynamics/aob` endpoint.
- **Daily reset boundary** — both the cumulative BG effect and the sensitivity multiplier reset at the patient's configurable daily reset hour (default 07:00), using the patient's timezone offset to resolve the correct UTC boundary.

### 4.2 Heart Rate Input Pipeline

Heart rate serves as the primary exercise intensity signal. Three ingestion pathways are fully implemented, ordered by physiological precision. All three produce identically normalised activity records, ensuring consistent ODE output regardless of data source. A `model` field in the per-session breakdown records whether real HR data or a synthetic trace was used (`"hr_ode"` vs. `"synthetic_hr"`).

#### 4.2.1 Real-Time Session Recording (Wearable Streaming)

Designed for live workout tracking where the wearable or companion app streams samples to the backend during exercise:

- `POST /api/watch/activity/start` — opens a session and returns a `session_id`
- `POST /api/watch/hr/stream` — accepts batched per-second HR samples (`{t_sec, hr_bpm}`), called every ~5 seconds
- `POST /api/watch/activity/end` — finalises the session; raw per-second trace (`hr_trace_raw`) stored for full-resolution visualisation; independently downsampled to per-minute averages (`hr_trace`) for ODE input
- `GET /api/watch/activity/status` — crash-recovery endpoint; detects in-progress sessions on app restart
- `GET /api/watch/hr/raw/<session_id>` — returns full per-second trace for completed or in-progress sessions

#### 4.2.2 Continuous All-Day Upload and Swim-Lane Auto-Segmentation

Designed for end-of-day sync from any wearable supporting CSV or JSON export (e.g. Garmin, Fitbit, Apple Health):

- `POST /api/watch/hr/continuous` — accepts `{timestamp_iso, hr_bpm}` samples

The backend auto-segmentation module (`watch_hr_autosegment.py`) converts the continuous stream into discrete activity session records using a swim-lane state machine:

- **Zone classification** uses absolute BPM thresholds: HR < 50 bpm → sedentary; 50–100 bpm → light; 100–140 bpm → moderate; > 140 bpm → vigorous. All thresholds are configurable per call.
- **Debounce logic** requires 6 consecutive readings in the target zone before a session starts, ends, or transitions. Session start time is anchored to the first reading of the debounce window.
- **Temporal splitting** caps sessions at 15-minute intervals, split at aligned clock boundaries (:00, :15, :30, :45).
- **Minimum duration filter** discards sessions shorter than 2 minutes as noise artefacts.
- **HR trace construction** — each accepted segment carries a full per-minute `hr_trace` and a `hr_trace_raw` array. Session minimum and peak HR stored under display-only keys (`session_hr_min` / `session_hr_peak`) and explicitly not forwarded to the ODE.

#### 4.2.3 Categorical Fallback — No Wearable Required

When no HR trace is available, the model constructs a synthetic HR trace from the patient's stored `hr_base` and `hr_max` combined with the user-selected categorical intensity tier. The trace follows a 2-minute linear ramp to a plateau:

| Intensity | HR Reserve Fraction | Approx. BPM (population defaults) |
|---|---|---|
| Light | 50% above resting | ~130 bpm |
| Moderate | 65% above resting | ~154 bpm |
| Vigorous | 80% above resting | ~178 bpm |

### 4.3 Implementation Status

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

### References

- Dalla Man C, Breton M, Cobelli C. Physical activity into the meal glucose–insulin model of type 1 diabetes. *J Diabetes Sci Technol.* 2009;3(1):56–67.
- Breton MD. Physical activity — the major unaccounted impediment to closed loop control. *J Diabetes Sci Technol.* 2008;2(1):169–174.
- Romeres D, Dalla Man C, Vella A, et al. Effect of walking on glucose metabolism in subjects with different degrees of glucose tolerance. *Am J Physiol Endocrinol Metab.* 2021;321:E122–E130.

---

## 5. Platform Architecture & Stack

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

`main.py` · `constants.py` (single source of truth for all PK params) · `blood_sugar.py` · `meal_insulin.py` · `activity.py` · `time_manager.py` · `libre_scheduler.py` (APScheduler, every 4 min, coalesce=True)

**Routes:** `auth_routes.py` · `blood_sugar` · `meal_routes.py` · `medication_routes.py` · `patient_routes.py` · `doctor_routes.py` · `cumulative_effects_routes.py` · `food_routes.py` · `libre_routes.py` · `import_routes.py`

### Key Backend Logic

- **Baseline calc:** `baseline = BG − (meal_impact − insulin_impact)` stored with every reading
- **Daily reset:** configurable hour, timezone-aware via `timezone_offset_minutes`
- **IOB engine:** all S3 insulin types (ultra-rapid Fiasp/Lyumjev, rapid NovoRapid/Humalog/Apidra, short Regular, intermediate NPH, long Toujeo/Tresiba/Levemir, mixed 70/30)
- **MOB engine:** 5 absorption profiles (very slow → very fast, gamma distribution)
- **Meal calc:** 12-factor insulin dose (ICR, protein, fat, timing, time-of-day, absorption modifier, activity coefficient, disease factor, medication factor, IOB correction, correction dose, health multiplier)
- **CGM:** Abbott LibreLinkUp, Fernet-encrypted credentials, 10+ regions, auto-refresh tokens 24h before expiry
- **Security:** bcrypt passwords, PyJWT (24h web / 90d mobile), Fernet AES-128-CBC, RBAC (patient/doctor/admin), consent-based doctor sharing

### Shared Constants System

A single `constants.py` file serves as the source of truth for all pharmacokinetic parameters, absorption profiles, and dose-adjustment factors. On every login, the full constant set is serialised and embedded in the login response payload (`shared_constants`), ensuring all platforms are always in sync without file writes — critical for Render.com's ephemeral filesystem.

---

## 6. Patient-Facing Features

### 6.1 Blood Glucose Management

#### 6.1.1 Manual Blood Glucose Logging (SMBG)

Patients can log fingerstick blood glucose readings at any time. Each reading is validated (0–600 mg/dL range), timestamped, tagged with a source flag, and optionally annotated with free-text notes. When saved, the backend immediately calculates a stable baseline by subtracting the net pharmacodynamic effect (meal absorption minus insulin activity) from the raw glucose value.

Key behaviours:
- Supports both real-time logging and back-dated entries via a custom timestamp picker
- Readings cross-linked between `blood_sugar` and `meals` collections for unified timeline queries
- Status classification (low / normal / high) computed against the patient's personal target glucose, not a fixed threshold
- Doctors can query glucose history with configurable date/time range filters

#### 6.1.2 CGM Integration — Abbott LibreLinkUp

DiaTwin integrates with the Abbott LibreLinkUp API to automatically import CGM readings from FreeStyle Libre sensors. Credentials are encrypted using Fernet symmetric encryption before storage, and the authentication token is refreshed automatically before expiry.

- Multi-region support: EU, US, AUS, CA, JP, DE, FR, NL, SE, SE2, and global fallback
- Token auto-refresh: up to 24 hours before expiry
- Connection status, last sync time, sync interval, and patient name surfaced to the app

**CGM Auto-Sync Scheduler:** A background APScheduler job runs inside the Flask process, waking every 4 minutes to sync due patients. Features: per-patient configurable sync interval (min. 4 min, default 5 min), coalesced runs, max 1 concurrent instance, 60-second misfire grace period, error isolation per patient. Also doubles as a Render.com free-tier keep-alive. Each sync imports up to 500 readings with duplicate prevention.

#### 6.1.3 Blood Glucose Visualization

- Range selectors: 24 hours, 7 days, 30 days
- Target range band at patient's configured target glucose ± tolerance
- Colour-coded status: low (red), normal (green), high (orange)
- CGM data points visually distinguished from manual fingerstick readings
- Estimated values rendered with reduced opacity/confidence weighting

### 6.2 Meal Tracking & Insulin Calculation

#### 6.2.1 Meal Logging

Full meal logging with individual food items, portion sizes, meal type (breakfast, lunch, dinner, snack), and timing.

Supported measurement units: ml, l, fl_oz, cup, tbsp, tsp, g, kg, oz, lb, plate (300 g), palm (85 g), handful (30 g), fist (150 g), bowl (400 ml)

#### 6.2.2 Food Database

DiaTwin ships with a comprehensive built-in food database covering 15 food categories:

| Category | Contents |
|---|---|
| Basic Foods | Core staples — bread, rice, pasta, potatoes, eggs, etc. |
| Starch List | Cereals, grains, starchy sides |
| Starchy Vegetables | Corn, sweet potato, parsnip, etc. |
| Pulses | Lentils, chickpeas, beans, peas |
| Fruits | Fresh and dried fruits with glycaemic index context |
| Milk & Dairy | Milk, yoghurt, cheese, cream |
| Sweets & Desserts | Biscuits, cakes, chocolate, ice cream |
| Snacks | Crisps, crackers, popcorn, granola bars |
| Common Snacks | Fast-moving convenience snacks |
| High Protein Foods | Meat, fish, eggs, tofu |
| High Fat Foods | Nuts, oils, butter |
| Indian Dishes | Dal, biryani, samosa, curries, naan, etc. |
| Chinese Dishes | Fried rice, noodles, dim sum, dumplings |
| Italian Dishes | Pasta varieties, pizza, risotto, focaccia |
| Egyptian Dishes | Ful medames, koshari, feteer, om ali, kunafa |

Patients can also add custom food items with their own nutritional data, absorption type, and serving size.

#### 6.2.3 Insulin Dose Calculation Engine

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

Insulin timing guidance is also provided based on meal absorption speed.

#### 6.2.4 Meal Absorption Profiles (Pharmacodynamics)

| Profile | Onset | Peak | Duration | Examples |
|---|---|---|---|---|
| Very Slow | ~20 min | ~3 h | ~8 h | Legumes, fatty meals |
| Slow | ~15 min | ~2 h | ~6 h | Whole grains, dairy |
| Medium | ~10 min | ~1.5 h | ~4 h | Standard mixed meals |
| Fast | ~5 min | ~1 h | ~3 h | White bread, fruit |
| Very Fast | ~2 min | ~0.5 h | ~2 h | Glucose tablets, juice |

### 6.3 Insulin & Medication Management

#### 6.3.1 Insulin Pharmacodynamics (IOB Engine)

DiaTwin models all major insulin types with pharmacokinetic parameters from Table 9 of the German S3 Guideline (AWMF-Registry 057-013):

- **Ultra-rapid:** Fiasp (insulin aspart faster), Lyumjev (lispro-aabc)
- **Rapid-acting:** NovoRapid / Humalog / Apidra / Admelog
- **Short-acting:** Regular insulin (Humulin R, Novolin R)
- **Intermediate:** NPH insulin (Humulin N, Novolin N)
- **Long-acting:** Toujeo, Tresiba (degludec, 42+ h duration), Levemir
- **Mixed:** 70/30, 50/50 combinations

The stacked insulin effect calculator aggregates IOB across all doses taken within the last 24 hours, computing a total current BG reduction estimate.

#### 6.3.2 Medication Scheduling

Patients can set recurring medication schedules with start/end dates and daily administration times. Active schedules are returned as part of the patient constants response for timely medication reminders. Doctors can also view and manage patient medication schedules.

### 6.4 Cumulative Effects & Baseline Tracking

#### 6.4.1 Daily Baseline Reset

DiaTwin maintains a cumulative baseline shift — the net blood glucose change accumulated since the patient's configured daily reset time (default: 7:00 AM). The reset hour is user-configurable (0–23 h) and applied in the patient's local timezone using a stored offset in minutes.

#### 6.4.2 Cumulative Effects API

The `/api/cumulative-effects` endpoint returns:
- `cumulative_meal_effect`: total BG elevation from all absorbed carbohydrates since reset
- `cumulative_insulin_effect`: total BG reduction from all absorbed insulin since reset
- `cumulative_net_baseline`: net shift = meal effect + activity effect − insulin effect
- Individual meal and insulin contributions with timing details
- Next reset time in the patient's local timezone

The `/api/active-effects-full` endpoint returns the complete picture: cumulative effects, current IOB, current MOB, and estimated current glucose.

#### 6.4.3 Meal on Board (MOB)

The `/api/meal-on-board` endpoint returns per-meal:
- Active carbs (MOB) still being absorbed
- Absorbed carbs contributing to current glucose elevation
- Pending BG rise from carbs not yet absorbed
- Absorption percentage and time-to-completion
- Is-past-peak flag

### 6.5 Activity Tracking

#### 6.5.1 Activity Level — Dose Adjustment Scale

| Level | Coefficient | Insulin Impact |
|---|---|---|
| Very Sedentary (−2) | ×1.2 | 20% increase in insulin need |
| Sedentary (−1) | ×1.1 | 10% increase |
| Normal Activity (0) | ×1.0 | No adjustment |
| High Activity (+1) | ×0.9 | 10% reduction |
| Vigorous Activity (+2) | ×0.8 | 20% reduction |

#### 6.5.2 Activity Pharmacodynamics — ODE Engine

See [Section 4](#4-activity-integration--ode-engine) for full technical detail.

### 6.6 Patient Constants & Personalisation

| Parameter | Description | Default |
|---|---|---|
| `insulin_to_carb_ratio` | Units of insulin per gram of carbohydrate | 10 |
| `correction_factor` | mg/dL glucose drop per unit of insulin | 40 |
| `target_glucose` | Personal target blood glucose (mg/dL) | 100 |
| `protein_factor` | Fraction of protein treated as carb equivalent | 0.5 |
| `fat_factor` | Fraction of fat treated as carb equivalent | 0.2 |
| `carb_to_bg_factor` | mg/dL rise per gram of absorbed carbohydrate | 4.0 |
| `daily_reset_hour` | Hour of day (local time) for cumulative effects reset | 7 |
| `timezone_offset_minutes` | UTC offset (e.g. UTC+2 = 120) | — |
| `activity_coefficients` | Five-level activity scale adjustments | — |
| `absorption_modifiers` | Per-speed multipliers for dose calculation | — |
| `insulin_timing_guidelines` | Pre-meal insulin timing recommendations | — |
| `meal_timing_factors` | Per-meal-type dose multipliers | — |
| `time_of_day_factors` | Hourly insulin resistance modulation | — |
| `disease_factors` | Per-condition dose multipliers | — |
| `medication_factors` | Per-insulin-type PK parameters and dose adjustments | — |

A 60-second in-memory cache ensures mobile app startup (6+ parallel API calls) only hits the database once per patient.

---

## 7. Healthcare Provider Features

### 7.1 Patient Panel

Each doctor sees only patients who have explicitly authorised them, ensuring privacy and consent-based access. Admins can view all patients. The patient list includes name, email, active conditions, and active medications.

### 7.2 Patient Data Views

Authorised doctors can access:
- Full glucose history with date/time range filtering (readings + CGM data)
- Complete meal history with nutritional breakdown and insulin calculations
- Medication logs and active insulin schedules
- Patient constants (ICR, correction factor, target glucose, and all other parameters)
- Activity logs
- Cumulative and active pharmacodynamic effects at any chosen point in time

### 7.3 Constants Management

Doctors can read and update patient constants — insulin-to-carb ratio, correction factor, target glucose, and all other parameters — on behalf of the patient. Changes take effect immediately.

### 7.4 Access Control Model

| Role | Permissions |
|---|---|
| **Patient** | View and manage own data only. Grant and revoke doctor access. |
| **Doctor** | View all data of authorised patients. Update patient constants and medication schedules. Cannot access non-authorised patients. |
| **Admin** | Full read access to all patients. Platform oversight. |

The doctor–patient relationship is patient-initiated; patients can revoke access at any time.

### 7.5 Clinical Glucose Visualization (Doctor View)

The `ClinicalValidationDashboard` and `DoctorBGVisualization` components give clinicians an overlay of actual readings against model-predicted glucose trajectories, useful for:
- Identifying patterns of persistent hyperglycaemia or hypoglycaemia
- Comparing model predictions to actual outcomes — surfacing calibration issues
- Reviewing how meals and insulin interact over multi-day periods
- Tracking glycaemic variability across time of day

---

## 8. Mobile Application

### 8.1 Overview

The DiaTwin mobile app is a fully featured iOS and Android application built with React Native and Expo Router. Every patient feature available on the web is replicated on mobile, with mobile-native UX patterns including pull-to-refresh, modal pickers, swipe-to-confirm delete, and touch-optimised chart tooltips. JWT tokens issued to mobile clients have a 90-day lifetime vs. 24-hour for web.

### 8.2 Tab Navigation Structure

| Tab | Description |
|---|---|
| **Home** | Primary patient dashboard — charts, active effects, quick actions, recent meals |
| **Log** | Quick multi-mode data entry (glucose / insulin / meal / activity) |
| **History** | Unified chronological feed of all health events |
| **Visualization** | Dedicated full-screen chart explorer with three chart modes and interactive legends |
| **Profile** | Account settings, patient constants, device management, data export |
| **Doctor Dashboard** | Doctor-only: patient list and deep per-patient clinical view |

### 8.3 Patient Dashboard (Home Tab)

#### Glucose Summary Widget

- Latest reading in large type, colour-coded: green (normal 70–180 mg/dL), orange (low 54–70 / high 180–250), red (very low <54 / very high >250)
- Status badge with named label and coloured dot
- Relative timestamp: 'Just now', 'Xm ago', 'Xh ago', or full date
- Mini trend strip: last four readings as coloured dots with numeric values
- Optional Estimated BG and Active Insulin (IOB) metrics

#### Three-Chart Visualization Panel

| Chart | Description |
|---|---|
| **Glucose Chart** (`BloodGlucoseChart`) | Raw-glucose signal. Five view windows: 3H, 6H, 12H, 24H, 3D. Stats: current, average, min, max, TIR%, count. |
| **Effects Chart** (`EffectsVisualizationChart`) | Six pharmacodynamic series: Meal Effect (orange), Insulin Effect (purple), Net Effect (blue dashed), Cumulative Baseline Shift (green), Meal dose markers, Insulin dose markers. Each series individually toggleable. |
| **BG Projected** (`BloodGlucoseVisualization`) | Full Digital Twin: actual readings, estimates between readings, cumulative effects area, and net-effect curve on a single timeline. |

#### Active Effects Display

All seven values calculated entirely on-device — no network round-trip required:
- **IOB:** active insulin units, estimated BG reduction, per-dose contribution breakdown
- **MOB:** grams of carbohydrate still being absorbed, equivalent pending BG rise
- **Stable Baseline:** derived from last actual BG reading minus cumulative net pharmacodynamic effects
- **Estimated Current BG:** baseline plus net effect from all meals and insulin since daily reset
- **Projected Final BG:** estimated glucose when all current MOB and IOB fully resolve
- **Trend:** rising / stable / falling with colour-coded safety status (safe / caution / warning)
- **Meal Timing Assessment:** safety check indicating whether it is safe to eat now given current IOB/MOB

### 8.4 Log Tab — Quick Entry & Dedicated Log Screens

#### Quick Log Modes

| Mode | Features |
|---|---|
| **Glucose** | Numeric entry, unit selector (mg/dL / mmol/L), timestamp picker, status indicator, reference range display |
| **Insulin** | Type selector (all S3-guideline profiles), dose entry, optional meal type pairing, BG at injection, timestamp picker, notes |
| **Meal (QuickMealForm)** | Single-screen streamlined logger with FoodSearch inlined, meal type selector, time picker |
| **Activity** | Level selector (−2 to +2), type (expected/completed), start/end time, duration, notes |

#### Full Meal Screen — 9-Step On-Device Calculation Pipeline

1. Total nutrients
2. Protein & fat → carb equivalents
3. Base insulin (ICR)
4. Activity impact
5. Correction dose
6. IOB/MOB deduction
7. Peak-overlap adjustment
8. Health multipliers
9. Safety floor (0.5u min) + 0.1u rounding

The `InsulinBreakdown` panel shows the full expandable audit trail of each step.

### 8.5 Visualization Tab

#### Interactive Chart Legend

- **Glucose mode:** Target Zone (70–180 mg/dL, green), High/Low (orange), Very High/Very Low (red), Now Line (grey dashed)
- **Effects mode:** Meal Effect MOB (orange), Insulin Effect IOB (purple), Net Effect (blue dashed), Cumulative Baseline (green solid), Dose Markers
- **BG Projected mode:** High-confidence projected BG (purple solid), Low-confidence (purple dashed), T1D Baseline (blue dashed step-line), Cumulative Meal Effect (orange fill)

#### Technical Details

- Glucose mode: CGM → dense continuous trace; SMBG → smoothstep (S-curve) interpolation. TIR target ≥70% for most T1D adults.
- Effects mode: Gamma distribution curves per S3 guideline. MOB/IOB lookback 8–48 hours depending on view mode.
- BG Projected: Projected BG = stable baseline + cumulative net effect. Confidence degrades with reading age: 30 min → high; 90 min → medium; 3h+ → low.

### 8.6 History Tab

A unified chronological feed of all health events — meals, glucose, insulin, activities — in a single infinite-scrolling list.
- Filter bar: All / Meals / Glucose / Insulin / Activities
- Sorted by Unix timestamp for sub-second precision
- Per-item inline delete with inline confirm row
- Pull-to-refresh reloads all data sources in parallel

### 8.7 Profile & Settings

| Screen | Contents |
|---|---|
| **Patient Constants** | Read-only display of all 15 patient constants |
| **Medications** | Active medications with PK profiles (onset / peak / duration) and schedules |
| **Manage Doctors** | Browse available doctors; authorise / revoke access |
| **Food Database** | Search (300ms debounce), category filter, favourites, custom food entry |
| **LibreLinkUp CGM** | Day-grouped CGM readings, manual sync, auto-sync toggle with interval selector |
| **Connect LibreLinkUp** | Email + password form, 10+ region chip selector, Fernet encryption notice |
| **Data Export (GDPR)** | One-tap JSON export, full GDPR rights disclosure, account deletion request |

### 8.8 Doctor Dashboard (Mobile)

Seven-tab clinical deep-dive per patient:

| Tab | Contents |
|---|---|
| **Overview** | Summary stats, active conditions, active medications |
| **Charts** | `DoctorBGChart` + `DoctorEffectsChart` + `DoctorBGVisualization` |
| **Blood Sugar** | Readings list with date-range filter, average glucose, and TIR statistics |
| **Insulin** | Dose history with per-dose details and daily totals |
| **Meals** | Full meal history with nutritional averages header |
| **Activities** | Activity log with type, level, duration, and impact factor |
| **Settings** | Edit patient constants inline, manage conditions and medications, reset to defaults |

### 8.9 Authentication & Onboarding

- User type toggle: Patient / Doctor
- Cold-start detection: `useAuth` detects `ERR_NETWORK` responses and activates a `WakeUpBanner` with an animated progress bar until the server responds
- Registration: username, email, password, user type, with validation
- Forgot password: email entry, backend sends reset link

### 8.10 Offline Architecture & Time-Sync Safety

#### Offline Queue (`useOffline` hook)

- Real-time network monitoring via `Network.addEventListener`
- Action queue: `queueAction(action)` enqueues any API call; each action gets a UUID, status (pending / syncing / failed), and retryCount
- Auto-sync: `processQueue()` runs automatically when `isOnline` becomes true
- Queue persistence via `AsyncStorage` on app launch
- `pendingCount` and `failedCount` exposed for UI indicators

#### Time-Sync Validation (`useTimeSyncValidation` hook)

- Runs on every update to MOB and IOB data
- Computes client-side `hours_elapsed` and compares against backend's value
- Discrepancy threshold: >6 minutes triggers `console.error` with full diagnostic table
- `validateTimestamp()` utility returns `{ valid: boolean, discrepancyMinutes: number }`

### 8.11 Key Components Reference

**Web Frontend Utils:** `insulinCalculationService.js` · `mealCalculationService.js` · `bloodGlucoseEstimationService.js` · `insulinPharmacodynamics.js` · `mealPharmacodynamics.js` · `insulinStackingAnalyzer.js` · `mealStackingAnalyzer.js` · `netEffectCalculationService.js` · `SMBGAnalysisService.js` · `validationMetrics.js` · `confidenceVisualization.js` · `ChartUtils.js` · `TimeManager.js`

**Mobile Hooks:** `useAuth` · `usePatientConstants` (60s cache) · `useActiveEffects` · `useBloodGlucoseEstimation` · `useLibre` · `useOffline` · `useTimeSyncValidation` · `useApi`

**Mobile Stores (Zustand):** `auth.store.ts` · `meal.store.ts` · `offline.store.ts` · `patient.store.ts`

---

## 9. Platform & Community Features

### 9.1 Data Import & Export

- **Import:** upload CSV or JSON → validate endpoint reports row counts and errors → confirmed import writes to `meals`, `blood_sugar`, `activities`, and `insulin` collections
- Selective import by data type: all, meals, blood_sugar, activities, or insulin only
- **Export:** one-tap JSON download of complete patient history — suitable for backup, migration, or clinical sharing
- **GDPR compliance:** full data portability, account deletion request, and rights disclosure

### 9.2 Food Community Features

- **Custom Food Database:** any patient can add custom food items — local dishes, branded products, or any food not covered by the built-in categories
- **Favourite Foods:** frequently eaten foods marked for rapid access; `FoodSearch` maintains a module-level cache (`_cachedFavorites`) for instant rendering
- **Global Cuisine Coverage:** four ethnic cuisine categories (Indian, Chinese, Italian, Egyptian) for a globally usable tool

### 9.3 Security & Privacy

| Measure | Implementation |
|---|---|
| **Password Security** | bcrypt hashing via Werkzeug — passwords never stored in plaintext |
| **JWT Authentication** | Signed tokens with role claim; 24-hour expiry for web, 90 days for mobile |
| **Credential Encryption** | LibreLinkUp credentials encrypted with Fernet (AES-128-CBC) before MongoDB storage |
| **Role-Based Access** | Patient / Doctor / Admin roles enforced on every API endpoint |
| **Consent-Based Sharing** | Patients explicitly authorise individual doctors; revocable at any time |
| **Input Validation** | All glucose values, timestamps, and food data validated before persistence |
| **No Cross-Patient Leakage** | Doctor queries always scoped to authorised patient list |

---

## 10. API Endpoint Index

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
| GET | `/api/doctor/patient/{id}/blood-sugar` | Secure doctor-namespaced route |

### Meals

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/meal` | Log a meal with full server-side insulin calculation |
| GET | `/api/meals-only` | Retrieve meal history |
| GET | `/api/meal/{id}` | Single meal detail |
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
| GET/PUT | `/api/insulin-analytics` | Analytics |
| GET/POST | `/api/medication-schedule` | Manage recurring schedules |
| GET/POST | `/api/medication-logs` | Medication log entries |

### Cumulative Effects

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/cumulative-effects` | Daily cumulative baseline shift |
| GET | `/api/net-effect` | Current net pharmacodynamic effect |
| GET | `/api/active-effects-full` | Complete real-time picture (IOB + MOB + cumulative + baseline) |

### Activities

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/activities` | Activity list |
| POST | `/api/record-activities` | Log expected and/or completed activities |
| GET | `/api/activity/pharmacodynamics` | Stacked ODE effect |
| GET | `/api/activity/pharmacodynamics/aob` | Activity-on-Board (AOB) |
| POST | `/api/watch/activity/start` | Open a real-time wearable session |
| POST | `/api/watch/hr/stream` | Push batched per-second HR samples |
| POST | `/api/watch/activity/end` | Finalise session |
| GET | `/api/watch/activity/status` | Crash-recovery status |
| GET | `/api/watch/hr/raw/<session_id>` | Full per-second HR trace |
| POST | `/api/watch/hr/continuous` | Upload all-day HR stream for auto-segmentation |

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
| POST | `/api/libre/sync` | Manual sync, pulls latest ~8 h of readings |
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

## 11. Proposed Research Agenda

- **Clinical validation:** Prospective trial (N=100 T1D patients, 6 months) to assess safety and efficacy of PK/PD-guided dosing support vs. standard care. Primary endpoint: time-in-range improvement.
- **Circadian ML validation (Phase 2 RCT):** Prospective pilot RCT (N=30, 6 months) validating circadian RL-based ISF/ICR adjustment against standard pen-user care.
- **Model refinement:** Integration of individual physiological parameters (ISF, ICR, DIA) derived from longitudinal CGM + insulin logs to improve personalisation of gamma-distribution curves.
- **Regulatory pathway:** CE Class IIa SaMD classification + DiGA fast-track evaluation (§139e SGB V) — bridging clinical evidence generation with reimbursement strategy.
- **Equity dimension:** Validation of pen-user mode (finger-prick only) for settings where CGM access is limited — addressing a global precision gap (LMIC arm planned).

---

## 12. Positioning vs. Existing Solutions

| Feature | DiaTwin | CGM-only / Basic apps |
|---|---|---|
| **Real-time IOB + MOB tracking** | ✓ (gamma distribution, S3-referenced) | ✗ |
| **Works with insulin pens** | ✓ | ✗ (pumps only for closed-loop) |
| **Physician-set parameters** | ✓ (remote validation) | ✗ |
| **Future glucose projection** | ✓ (4-hour IOB + MOB) | Trend only |
| **Personalisation over time** | ✓ (RL from outcomes) | ✗ |
| **Circadian ISF/ICR adjustment** | ✓ (RL, time-of-day blocks) | ✗ |
| **Activity ODE pharmacodynamics** | ✓ (Y/Z/W, wearable or categorical) | ✗ |
| **Cost to patient** | ~€100/year | €3,000–16,000/year |

---

## 13. Lead Researcher Profile

| | |
|---|---|
| **Academic** | M.Sc. Digital Health, DIT Germany (1.6 "Excellent"); B.Sc. Pharmacy, Zagazig University (1.5 "Excellent") |
| **Licence** | German Pharmacist Licence (Berufserlaubnis §11 BApO, Upper Bavaria 2025); Fachsprachenprüfung passed |
| **Clinical Informatics** | Senior Clinical Data Specialist, Egypt Healthcare Authority (2021–2023): national EHR rollout, FHIR R4, ICD-10, SNOMED CT, 500+ staff trained |
| **Technical** | Python, ML/RL (Scikit-learn, TensorFlow), full-stack (React, Flask, MongoDB), HL7-FHIR R4 implementation |
| **Clinical Advisory** | Prof. Dr. Klaus Parhofer (LMU Munich) — protocol advisor; Prof. Dr. Katarina Braune (Charité/HPI) — clinical trial co-PI |

**GitHub:** [github.com/aliattia2](https://github.com/aliattia2)  |  **LinkedIn:** [linkedin.com/in/ali-attia-74748bb4](https://linkedin.com/in/ali-attia-74748bb4)  |  **Demo:** [dia-twin.vercel.app](https://dia-twin.vercel.app)

---

## 14. Acknowledgements

Insulin pharmacokinetic parameters are based on the **German S3 Guideline** *'Therapie des Typ-1-Diabetes'*, Version 5.0 (AWMF-Registry: 057-013), published in *Diabetologie und Stoffwechsel* 2024; 19: S155–S166. DOI: 10.1055/a-2312-0276.

CGM integration is provided via the Abbott LibreLinkUp API. Abbott and FreeStyle Libre are trademarks of Abbott Laboratories.

---

*DiaTwin — Empowering patients. Supporting clinicians. Built on science.*
