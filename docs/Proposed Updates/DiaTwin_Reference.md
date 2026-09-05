# DiaTwin — Quick Reference (Paste into new chats)

## What it is
Full-stack diabetes management platform with a physiological "Digital Twin" model of each patient's blood glucose. Primary focus: T1D. Built by a solo/small team.

**Stack:** Python/Flask + MongoDB backend · React JS web frontend · React Native/Expo mobile (TypeScript) · Deployed on Render.com free tier.

**Clinical reference:** German S3 Guideline AWMF-Registry 057-013 (Table 9 insulin profiles) — gamma distribution curves for all pharmacokinetics.

---

## Backend (Python/Flask)

### Core Files
`main.py` · `constants.py` (single source of truth for all PK params) · `blood_sugar.py` · `meal_insulin.py` · `activity.py` · `time_manager.py` · `libre_scheduler.py` (APScheduler, every 4 min, coalesce=True)

### Routes
`auth_routes.py` · `blood_sugar` · `meal_routes.py` · `medication_routes.py` · `patient_routes.py` · `doctor_routes.py` · `cumulative_effects_routes.py` · `food_routes.py` · `libre_routes.py` · `import_routes.py`

### Key Logic
- **Baseline calc:** `baseline = BG − (meal_impact − insulin_impact)` stored with every reading
- **Daily reset:** configurable hour, timezone-aware via `timezone_offset_minutes`
- **IOB engine:** all S3 insulin types (ultra-rapid Fiasp/Lyumjev, rapid NovoRapid/Humalog/Apidra, short Regular, intermediate NPH, long Toujeo/Tresiba/Levemir, mixed 70/30)
- **MOB engine:** 5 absorption profiles (very slow → very fast, gamma distribution)
- **Meal calc:** 12-factor insulin dose (ICR, protein, fat, timing, time-of-day, absorption modifier, activity coefficient, disease factor, medication factor, IOB correction, correction dose, health multiplier)
- **CGM:** Abbott LibreLinkUp, Fernet-encrypted credentials, 10+ regions, auto-refresh tokens 24h before expiry
- **Security:** bcrypt passwords, PyJWT (24h web / 90d mobile), Fernet AES-128-CBC, RBAC (patient/doctor/admin), consent-based doctor sharing

### Shared Constants System
On every login, full `constants.py` params are embedded in the response as `shared_constants` — used by both web and mobile so all platforms are always in sync without file writes (important for Render.com ephemeral filesystem).

---

## Web Frontend (React JS)

### Key Components
`PatientDashboard` · `DoctorDashboard` · `AdminDashboard` · `BloodSugarChart` · `BloodSugarVisualization` · `EffectsVisualization` · `ActiveEffectsDisplay` · `MealInput` · `InsulinInput` · `MedicationSchedule` · `PatientConstants` / `EnhancedPatientConstants` · `CGMMonitoringDashboard` · `ClinicalValidationDashboard` · `GlycemicResponseTracker` · `FoodDatabase` · `ImportExport`

### State
Context API: `BloodSugarDataContext` · `ConstantsContext` · `LibreContext` · `TimeContext`

### Utils
`insulinCalculationService.js` · `mealCalculationService.js` · `bloodGlucoseEstimationService.js` · `insulinPharmacodynamics.js` · `mealPharmacodynamics.js` · `insulinStackingAnalyzer.js` · `mealStackingAnalyzer.js` · `netEffectCalculationService.js` · `SMBGAnalysisService.js` · `validationMetrics.js` · `confidenceVisualization.js` · `ChartUtils.js` · `TimeManager.js`

---

## Mobile (React Native / Expo Router — TypeScript)

### Navigation (6 tabs)
1. **Home** — dashboard
2. **Log** — quick entry
3. **History** — unified feed
4. **Visualization** — full-screen charts
5. **Profile** — settings
6. **Doctor Dashboard** — doctor-only

### Key Screens
- `(tabs)/index.tsx` — Patient Dashboard
- `(tabs)/visualization.tsx` — 3-chart explorer (📈 Glucose / ⚡ Effects / 🩸 BG Projected), dynamic legend, technical details panel, all 3 charts mounted with display:none toggle
- `(tabs)/history.tsx` — unified feed, 5-type filter, Unix-sort, inline delete
- `(tabs)/profile.tsx` — dual patient/doctor layout
- `(tabs)/doctor-dashboard.tsx` — patient list → PatientDataView (7 tabs)
- `log/glucose.tsx` — standalone BG log
- `log/insulin.tsx` — standalone insulin log
- `log/meal.tsx` — full MealForm
- `log/activity.tsx` — dual expected/completed, also creates activity_only meal record for timeline
- `meal/[id].tsx` — meal detail, dual patient/doctor mode, InsulinBreakdown audit trail
- `(auth)/login.tsx` — Patient/Doctor toggle, WakeUpBanner cold-start progress bar, Render.com wake detection

### Key Components
**Charts:** `BloodGlucoseChart.tsx` · `EffectsVisualizationChart.tsx` · `BloodGlucoseVisualization.tsx`  
**Dashboard:** `GlucoseSummary.tsx` (status colour, mini trend, estimated BG/IOB) · `ActiveEffectsDisplay.tsx` · `QuickActions.tsx` · `RecentMeals.tsx`  
**Forms:** `MealForm.tsx` (full) · `QuickMealForm.tsx` (no activity/BG/insulin fields, FoodSearch inlined, no modal) · `UnifiedBloodSugarInput.tsx` · `UnifiedInsulinInput.tsx` · `UnifiedActivityInput.tsx` · `UnifiedTimePicker.tsx`  
**Meal:** `FoodSearch.tsx` (module-level cache, pre-seeded from shared-constants, separate search/initial spinners) · `InsulinBreakdown.tsx` (expandable, shows full formula) · `SelectedFoodsList.tsx`  
**Doctor:** `PatientDataView.tsx` (7 tabs) · `DoctorBGChart.tsx` · `DoctorBGVisualization.tsx` · `DoctorEffectsChart.tsx` · `PatientList.tsx`

### On-Device Insulin Calculation (insulinCalculationService.ts)
9-step pipeline — no API call needed:
1. Total nutrients · 2. Protein/fat → carb equivalents · 3. Base insulin (ICR) · 4. Activity impact · 5. Correction dose · 6. IOB/MOB deduction · 7. Peak-overlap adjustment · 8. Health multipliers · 9. Safety floor (0.5u min) + 0.1u rounding

### Hooks
`useAuth` · `usePatientConstants` (60s cache) · `useActiveEffects` · `useBloodGlucoseEstimation` · `useLibre` · `useOffline` (queue + auto-sync + persist) · `useTimeSyncValidation` (>6 min discrepancy → console error, patient safety guard) · `useApi` · `useTimeSyncValidation`

### Stores (Zustand)
`auth.store.ts` · `meal.store.ts` · `offline.store.ts` · `patient.store.ts`

### Utils (mobile)
`utils/insulin/pharmacodynamics.ts` · `utils/glucose/blood-glucose-estimation.ts` · `utils/glucose/meal-pharmacodynamics.ts` · `utils/glucose/meal-impact-curves.ts` · `utils/calculations/` (baseline, cumulative-effects, net-effect) · `ChartUtils.tsx` (RN port: View/Text tooltips, elevation shadows, touch interaction) · `TimeManager.ts`

### Offline Architecture
`useOffline` → `offline.store` → queue persisted via AsyncStorage. Actions: pending → syncing → failed. `retryFailed()` resets and re-processes. `pendingCount` / `failedCount` surface to UI badge.

### API Endpoints (endpoints.ts — source of truth)
AUTH (root, no /api): `/login` `/register` `/logout`  
PATIENT: `/api/patient/constants` `/profile` `/authorized-doctors` `/authorize-doctor` `/revoke-doctor` `/export`  
BLOOD_SUGAR: `/api/blood-sugar` + doctor route `/api/doctor/patient/{id}/blood-sugar`  
MEALS: `/api/meal` `/api/meals-only` `/api/meal/{id}` `/api/meal/calculate`  
MOB: `/api/meal-on-board` `/api/active-meals` `/api/meal-timing-assessment`  
INSULIN: `/api/insulin/log` `/api/insulin/active-effect` `/api/insulin-data` `/api/insulin-analytics`  
MEDICATION: `/api/medication-logs` `/api/medication-schedule` `/api/medication-log`  
CUMULATIVE: `/api/cumulative-effects` `/api/net-effect` `/api/active-effects-full`  
ACTIVITIES: `/api/activities` `/api/record-activities` `/api/activity-history` + doctor route  
DOCTOR: `/api/doctor/patients` + per-patient constants/conditions/medications/medication-log  
FOOD: `/api/food/search` `/categories` `/custom` `/favorite` `/measurements` `/nutritional-summary`  
LIBRE: `/api/libre/connect` `/disconnect` `/status` `/sync` `/settings` `/readings`  
IMPORT/EXPORT: `/api/import/validate` `/api/import` `/api/patient/export`  
HEALTH: `/test`

### Food Database
15 categories: basic, starch, starchy veg, pulses, fruits, dairy, sweets, snacks, common snacks, high protein, high fat, Indian, Chinese, Italian, Egyptian. Custom foods + favourites per user.

### Settings Screens (mobile)
`settings/constants.tsx` · `settings/medications.tsx` · `settings/doctors.tsx` · `settings/food-database.tsx` · `settings/libre.tsx` (CGM readings SectionList) · `settings/libre-connect.tsx` (region selector, Fernet notice) · `settings/export.tsx` (GDPR)
