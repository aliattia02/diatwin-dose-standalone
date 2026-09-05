# The React frontend against the mobile client

*Audit · 5 September 2026 · superseded rather than edited*

---

## Why this was asked

The mobile client has had most of the attention; the React frontend has not. The
intent is for the **web frontend to become the doctor dashboard, and the surface
for machine learning and reinforcement learning work**, because a browser is a
better place for dense clinical review than a phone.

This audit measures where the two actually stand. Every number below was
measured this session — endpoint sets extracted from source, line counts from
`wc`, the build actually run.

---

## 0. The three findings that matter most

**1. The doctor dashboard is the *least* developed part of the frontend, and the
gap is not close.**

| | Frontend | Mobile |
|---|---:|---:|
| Doctor UI | `DoctorDashboard.js` **306** + `DoctorMealHistory.js` **229** = **535 lines** | 6 components + 1 screen = **5,081 lines** |
| What a doctor sees per patient | one `BloodSugarChart` | `PatientDataView` (1,348), `DoctorBGVisualization` (1,346), `DoctorEffectsChart` (1,143), `DoctorBGChart` (574) |
| Per-patient endpoints called | `/api/doctor/patients`, `/api/doctor/meal-history/:id` | + `/api/doctor/patient/:id/` × {blood-sugar, insulin, medications, medication-log, conditions, constants, constants/reset, activity-history} |

The capability the plan depends on is the one with a **9.5×** line-count deficit.

**2. The frontend has no safety net at all.** It is not built in CI, not
deployed, and has no tests. Only 3 of its 16 `utils/` files are exercised by
anything (the parity harness). Its single test file is unmodified
Create-React-App boilerplate asserting the page renders "learn react" — which
`App.js` does not render, so it would fail if it were ever run.

**3. Neither client is a superset of the other.** The frontend has a whole
import/export subsystem the mobile client lacks, and owns half the watch
integration. "Bring the frontend up to the mobile client" would *lose* features.

---

## 1. Scale

| | Frontend | Mobile |
|---|---:|---:|
| Source lines | 51,080 (`.js`) | 66,658 (`.ts`/`.tsx`) |
| Language | JavaScript, untyped | TypeScript |
| Components / screens | 40 components, 5 routes | 27 screens, 7 component directories |
| State | 4 React contexts | 5 Zustand stores + 9 hooks |
| API layer | 2 service files + inline `axios` in components | 17 typed service modules behind one `endpoints.ts` |
| Tests | **1** (broken CRA boilerplate) | **362** |
| Typecheck | none (plain JS) | `tsc` + ratchet gate at 185 |
| In CI | parity evaluator only (3 of 16 utils) | typecheck + full jest + parity |
| Deployed | **no** (`vercel.json` exists only under `mobile/`) | Vercel |

The frontend is not small — it is 77% of the mobile client's size. The problem
is not volume; it is that nothing checks any of it.

---

## 2. Feature coverage, measured by endpoint

Endpoint sets extracted from both source trees and diffed. Entries where the
frontend computes locally rather than calling the API are marked, because those
are architectural differences, not gaps.

### 2.1 Parity — both clients have it

Authentication (login, register) · glucose logging · meal logging · insulin
logging · activity recording · meal history · patient constants · food database
(search, categories, custom, favourites, measurements) · doctor authorisation ·
medication *schedule* · **LibreLinkUp CGM** (status, readings, sync, connect) ·
**FHIR R4 export** (`/api/export/fhir`) · **GDPR delete** (`/api/patient/account`,
`/api/patient/data`) · IOB/MOB display via `/api/active-effects-full`.

> Two of these corrected my own first pass: a naive grep suggested the frontend
> lacked Libre and FHIR. It has both — Libre through `contexts/LibreContext.js`,
> FHIR through `components/FHIRExport.js` at `/api/export/fhir`. The endpoint
> diff alone is not a reliable instrument; each apparent gap had to be checked.

### 2.2 Present in mobile, absent from the frontend

| Capability | Endpoints | Real gap? |
|---|---|---|
| **Google Fit connection** | `/api/watch/{connect,disconnect,oauth-url,settings,status,sync}` | **Yes** — see §3 |
| **Medication dose logging** | `/api/medication-log`, `/api/medication-logs` | **Yes.** The frontend manages the *schedule* only; it cannot record that a dose was taken |
| **Food scanning** | `/api/food/scan` | **Yes** (barcode/photo; arguably phone-native) |
| **Nutritional summary** | `/api/food/nutritional-summary` | **Yes** |
| **Patient data export** | `/api/patient/export` | **Yes** |
| **Patient profile** | `/api/patient/profile` | **Yes** |
| **Insulin analytics** | `/api/insulin-analytics`, `/api/insulin/active-effect` | **Yes** — relevant to the doctor view |
| **Insulin dose CRUD** | `/api/insulin/log`, `/api/insulin/log/:id` | Partly — the frontend posts doses through the meal path |
| **Doctor per-patient detail** | `/api/doctor/patient/:id/*` (8 endpoints) | **Yes** — the largest gap, see §0 |
| Net effect / cumulative / MOB / meal-timing | `/api/net-effect`, `/api/cumulative-effects`, `/api/meal-on-board`, `/api/meal-timing-assessment`, `/api/meal/calculate` | **No** — computed locally in `netEffectCalculationService.js`, `mealCalculationService.js`, `insulinCalculationService.js` |

### 2.3 Present in the frontend, absent from mobile

| Capability | Endpoints |
|---|---|
| **Data import subsystem** | `/api/import`, `/api/import/validate`, `/api/import/download-data`, `/api/import/export-template` |
| **Manual HR session recording** | `/api/watch/activity/{start,end,status}` |
| **Continuous / raw HR upload** | `/api/watch/hr/{continuous,raw,raw/:id,stream}` |
| **Recent medication logs** | `/api/medication-logs/recent` |
| **Doctor meal history** | `/api/doctor/meal-history/:id` |

---

## 3. The watch integration is split down the middle

This is the clearest case of neither client being ahead:

* **Mobile owns the connection**: Google Fit OAuth (`/api/watch/oauth-url`,
  `/api/watch/connect`), settings, status, and the timed background sync
  (`/api/watch/sync`) — the path whose defects were D19.
* **Frontend owns the data**: manual session start/stop
  (`/api/watch/activity/start|end|status`) and continuous/raw HR upload and
  streaming (`/api/watch/hr/*`).

Neither can do the other's job. For a doctor dashboard the frontend's half is
the more useful one — but a patient cannot connect their watch from the web.

---

## 4. Defects found in the frontend while auditing

### D24 — the frontend uses the *browser's* timezone, not the patient's

`TimeManager.getDailyResetTime(currentTimestamp, resetHour, tzOffsetMinutes)`
falls back to `-(new Date(...).getTimezoneOffset())` when `tzOffsetMinutes` is
null. Six call sites omit the argument:

```
utils/bloodGlucoseEstimationService.js:176, 208, 392, 915, 1020
contexts/BloodSugarDataContext.js:1504
```

while the chart components (`ActivityVisualization`, `EffectsVisualization`,
`InsulinVisualization`, `MealVisualizationmealsonly`) and
`netEffectCalculationService.js` all pass it correctly.

Two consequences:

1. **Within one screen, the baseline estimation and the charts can disagree
   about where the day starts** — one uses the patient's offset, the other the
   browser's.
2. **For the doctor dashboard this is worse than for a patient.** A clinician in
   London reviewing a patient in Cairo gets the *clinician's* offset applied to
   the *patient's* reset boundary. The patient's own device would never surface
   this, because for them the two offsets usually agree.

This is the same class as **D13** (fixed in the mobile insulin timeline: "a
patient's day rolled over at their phone's reset hour, not their own") and
**D9** (fixed across four mobile sites this session). The frontend's
`TimeManager` arithmetic is *correct* — it already consolidated in its v3.1
refactor, ahead of the mobile client — so this is purely the missing argument at
six call sites, and cheap to fix.

Not fixed here: it changes clinical output, and this document is an audit.

### D25 — three dashboard tabs are empty files

Four components are **0 bytes**:

```
frontend/src/components/ClinicalValidationDashboard.js   0
frontend/src/components/EnhancedPatientConstants.js      0
frontend/src/components/GlycemicResponseTracker.js       0
frontend/src/components/Test.js                          0
```

Three of them are imported *and rendered as tabs* by `PatientDashboard.js`:

| Component | Rendered at | Tab label |
|---|---|---|
| `ClinicalValidationDashboard` | line 123 | "Clinical Validation Dashboard" |
| `GlycemicResponseTracker` | line 99 | "Meal-Visualization" |
| `Test` | line 135 | "🧪 Test Component" |

`EnhancedPatientConstants.js` is orphaned — nothing imports it.

**The build succeeds** — measured: `439.87 kB` gzipped, exit 0. Webpack is happy
to bundle an empty module. The default export of a 0-byte module is `undefined`,
and `React.createElement(undefined)` throws *at render*, so the failure is
deferred to whenever someone selects one of those tabs. I did not exercise the
tabs in a browser, so I am reporting the file sizes and the render sites as
measured and the consequence as standard React behaviour.

`ClinicalValidationDashboard` is the one to care about: a clinical-validation
view is exactly what a doctor dashboard needs, and the file is empty.

---

## 5. What ML and RL actually need from the frontend

Worth stating plainly, because it is easy to over-scope.

**Training does not read from any client.** Per the storage-layer decision,
models train against immutable Parquet snapshots written by
`diatwin/ml/export.py` from `MongoRepository`. Neither the frontend nor the
mobile client is on that path, and nothing about the frontend blocks supervised
learning or offline RL today.

What the frontend *is* the right home for:

1. **Clinician review of model output** — error grids, predicted-vs-actual,
   calibration plots over a snapshot. A browser is the right place; a phone is
   not.
2. **Labelling and correction.** The single most valuable column for the later
   RL step is `suggested_units` vs `units` — a logged record of where the patient
   disagreed with the model. A clinician reviewing and annotating those
   disagreements is a web-shaped task.
3. **Cohort views.** 25 patients side by side, with the drop-rate table from
   `LoadReport` visible. That is the artifact the audit says to read before
   training, and it currently only exists as terminal output.
4. **Snapshot provenance.** Showing which `snapshot_id` a displayed result came
   from, so a clinical claim can name its data.

None of these exist yet in either client. They are new work, not parity work —
and that matters for sequencing: **closing the mobile-parity gap does not move
the ML/RL goal forward.** They are largely disjoint programmes.

---

## 6. Recommendation

The order below is by risk removed per unit of effort, not by feature count.

**First — make the frontend safe to change at all.** Everything else is
premature without this, and none of it is large:

1. Add a `frontend` job to CI: `npm ci && npm run build`. The build works today,
   so this locks in a state that currently nothing protects.
2. Delete `App.test.js` (it is boilerplate that would fail) and add the
   `frontend/src/utils/` modules to a jest suite. Three of the sixteen are
   already parity-covered; the other thirteen — including
   `netEffectCalculationService.js` (1,768 lines) and
   `bloodGlucoseEstimationService.js` (1,729) — have nothing.
3. Fix **D25**: either implement the three empty components or remove them from
   the tab list. An empty file that renders as a named tab is worse than an
   absent feature.
4. Fix **D24**: pass `tzOffsetMinutes` at the six call sites. Add the
   frontend equivalent of `daily-reset-consolidation.test.ts`, which is what
   makes the class of bug stay fixed.

**Second — the doctor dashboard, which is the stated goal.** The eight
`/api/doctor/patient/:id/*` endpoints already exist and are exercised by the
mobile client, so this is client work only. `PatientDataView.tsx` (1,348 lines)
is the reference implementation to port *from*.

**Third — decide the watch split.** Either bring Google Fit connection to the
web, or accept that connecting a watch is a phone-only action and document it.
Right now it is neither decided nor written down.

**Fourth — the ML/RL surfaces in §5**, which are new build rather than parity.

**Not recommended:** porting food scanning to the web (camera-native, low value
in a browser), or porting the import subsystem to mobile (it is a desktop-shaped
task and the frontend already has it).

---

## 7. What this audit did not do

- **No runtime verification.** The frontend was built, not run. The D25 render
  failure is inferred from file size and render site, not observed in a browser.
- **No visual comparison.** Whether the frontend's existing screens are *good* is
  a different question from whether the capability exists; only the latter was
  measured.
- **Permissions not checked.** Whether the frontend's doctor routes enforce the
  same authorisation as the mobile client's was not tested. Given the deployment
  is a closed test environment (standing decision), that is recorded here as
  unmeasured rather than escalated.
- **D24 and D25 are not fixed.** Both change what a user sees, and this is an
  audit. Both are characterised precisely enough to fix in one sitting.
