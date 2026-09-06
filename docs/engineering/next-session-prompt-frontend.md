# Next session — the web frontend as the clinician's ML/RL review surface

*Written 5 September 2026. Paste the whole of this file into a fresh session.*

---

This is the DiaTwin repository — a Type 1 diabetes digital twin. Flask + MongoDB
backend, Expo/React Native mobile client (also deployed to the web), a React web
frontend, and a pharmacodynamic kernel modelling insulin, carbohydrate and
exercise effects on blood glucose.

## What this session is for

**The React frontend (`frontend/`) is to become the surface where a doctor
reviews machine-learning output and reinforcement-learning suggestions.** Not a
second patient app. The mobile client is the patient's; the web is the
clinician's.

That distinction decides what is in scope. Most of the mobile/web feature gap is
**deliberately not** the target — see "Standing decisions".

## Start here

Read `docs/engineering/README.md` first, then the documents listed under
"Documents to attach" at the foot of this file.

## Current state

**Verify this table before trusting it.** A previous session was started against
a handoff whose task was already finished. Commands are at the bottom.

| | |
|---|---|
| Tests | 864 — 401 backend, 101 foundation, 362 mobile. **Frontend: 0.** |
| Parity | 3 implementations, 1,578 cases, 6 families, 410 baselined, exit 0 |
| Mobile typecheck | 185 errors, gated by a **ratchet** (may only go down) |
| Frontend | 51,080 lines JS. **Not in CI, not deployed, no tests, untyped.** Builds clean: 439.87 kB gzipped |
| Deployment | Render `diatwin.onrender.com` · Vercel = the **mobile** app built for web · Atlas `cluster0.99xtyir` |
| Database contents | Essentially empty — one test user, no clinical data |
| Open defects | D2 (kept), D4, D5, D21b, **D24**, **D25** |

### The single most important fact

**There is no machine learning yet.** `diatwin/ml/` contains exactly one file,
`export.py`. Measured this session:

- no training code, no model artifact, no `.fit(`, no `predict(`
- no prediction or recommendation endpoint anywhere in `backend/routes/`
- no RL code; `d3rlpy` is listed in `requirements-ml.txt` but commented out
- `pyarrow` is declared but was not installed until this session — `export_snapshot`
  had never executed before

So **the frontend cannot display model output, because there is none.** Any plan
that starts with "render the predictions" is blocked on work that does not exist.

### What makes this session possible anyway

There is already a suggestion signal in the data, and it is the exact one the RL
step will train against:

- `backend/meal_insulin.py:795` writes `suggestedInsulin` — what the app's
  existing **rules-based** engine proposed — onto every meal document.
- `diatwin/data/normalize.py::normalize_insulin_from_meal` reads it into
  `InsulinDose.suggested_units`.
- `diatwin/data/schema.py:113` says why it matters: *"suggested_units vs units is
  the behavioural-cloning target and the single most valuable column for the
  later RL step: it is a logged record of where the patient disagreed with the
  model."*

**A clinician review surface built against the rules-based engine today is the
same surface a learned model plugs into later.** Same contract, same views, same
disagreement analysis. That is the way in.

## Standing decisions — do not re-litigate

- **The three implementations of the models are deliberate.** Python
  (`backend/utils/`), mobile (`mobile/utils/`) and web (`frontend/src/utils/`)
  each implement the PD models independently, for cross-validation. Do not
  propose merging or deleting any. The parity harness turns the duplication into
  verification.
- **Feature parity with the mobile client is NOT the goal.** Neither client is a
  superset of the other, and the frontend already has things mobile lacks (the
  whole `/api/import/*` subsystem, manual HR sessions, raw/continuous HR upload).
  Do not port food scanning to the web. Do not port the import subsystem to
  mobile.
- **Training does not read from any client.** Models train against immutable,
  content-hashed Parquet snapshots from `diatwin/ml/export.py`. The frontend is a
  *consumer* of results, never part of the data path.
- **Stay on MongoDB.** Decided 5 September with six trigger conditions; see the
  storage-layer decision record.
- The deployment is a **closed test environment**. Access-control findings are
  recorded in tests, not escalated.
- The password policy is deliberately relaxed for testing
  (`mobile/utils/validation.ts`, 6 chars). `__tests__/password-policy.test.ts`
  pins it.
- Do not commit or push anything unless asked.

## The task

Four parts, in this order. The order is by risk removed per unit of effort, and
Part A is not optional — the rest is unsafe without it.

### Part A — make the frontend safe to change

It is 51,080 lines with nothing checking any of it. Everything below is small.

**A1. Put it in CI.** Add a `frontend` job to `.github/workflows/ci.yml`:
`npm ci && npm run build`. The build works today (verified: exit 0, 439.87 kB
gzipped), so this locks in a state nothing currently protects. Follow the
existing jobs' shape; they pin Node 22.

**A2. Give it a test suite.** Delete `frontend/src/App.test.js` — it is
unmodified Create-React-App boilerplate asserting the page renders "learn react",
which `App.js` does not render, so it fails if it is ever run. Then cover
`frontend/src/utils/`. Three of its sixteen files are exercised by the parity
harness; the other thirteen by nothing, including:

| File | Lines |
|---|---:|
| `netEffectCalculationService.js` | 1,768 |
| `bloodGlucoseEstimationService.js` | 1,729 |
| `ChartUtils.js` | 1,450 |
| `TimeManager.js` | 1,355 |
| `insulinStackingAnalyzer.js` | 1,117 |
| `mealCalculationService.js` | 897 |

`mobile/__tests__/` is the model to follow — property assertions over pinned
magic numbers (Arm 5 rule 11), and negative cases that prove the code leaves
legitimate data alone.

**A3. Fix D25 — three dashboard tabs are 0-byte files.**

```
frontend/src/components/ClinicalValidationDashboard.js   0 bytes
frontend/src/components/GlycemicResponseTracker.js       0 bytes
frontend/src/components/Test.js                          0 bytes
frontend/src/components/EnhancedPatientConstants.js      0 bytes  (orphaned)
```

The first three are imported *and rendered as tabs* by `PatientDashboard.js`
(lines 123, 99, 135 respectively), including one labelled "Clinical Validation
Dashboard". The build succeeds — webpack bundles an empty module happily — so
the failure is deferred to render: a 0-byte module's default export is
`undefined`, and `React.createElement(undefined)` throws.

*Note: the audit inferred this from file size and render site and did not
exercise the tabs in a browser. Confirm it before writing the fix.*

Decide per component: implement, or remove from the tab list.
`ClinicalValidationDashboard` is the one that matters — a clinical validation
view is exactly what Part C needs, and the file is empty.

**A4. Fix D24 — the frontend uses the browser's timezone, not the patient's.**

`TimeManager.getDailyResetTime(currentTimestamp, resetHour, tzOffsetMinutes)`
falls back to `-(new Date(...).getTimezoneOffset())` when the third argument is
null. Six call sites omit it:

```
frontend/src/utils/bloodGlucoseEstimationService.js:176, 208, 392, 915, 1020
frontend/src/contexts/BloodSugarDataContext.js:1504
```

The chart components and `netEffectCalculationService.js` all pass it correctly,
so within one screen the baseline estimation and the charts can disagree about
where the day starts.

**This is worse for a doctor than for a patient**, which is why it belongs in
this session: a clinician in London reviewing a patient in Cairo gets the
*clinician's* offset applied to the *patient's* reset boundary. The patient's own
device would never surface it, because for them the two usually agree.

Same class as D13 and D9. The frontend's `TimeManager` arithmetic is already
correct — it consolidated in its v3.1 refactor, ahead of the mobile client — so
this is only the missing argument. Port
`mobile/__tests__/daily-reset-consolidation.test.ts`: it asserts every reset path
equals `TimeManager` across nineteen offsets at every hour and every reset hour,
which is what keeps the *class* of bug fixed rather than the instance.

### Part B — the doctor dashboard

Today a doctor sees **one chart**. Measured:

| | Frontend | Mobile |
|---|---:|---:|
| Doctor UI | 535 lines total | 5,081 lines |
| Per patient | one `BloodSugarChart` | `PatientDataView` (1,348), `DoctorBGVisualization` (1,346), `DoctorEffectsChart` (1,143), `DoctorBGChart` (574) |

The eight `/api/doctor/patient/:id/*` endpoints already exist and are exercised
by the mobile client, so **this is client work only** — no backend needed.
`mobile/components/doctor/PatientDataView.tsx` is the reference to port from.

Do not port it literally: a phone layout is not a clinic layout. What must carry
over is the endpoint usage and the calculation calls, not the component tree.

### Part C — the ML/RL review surface

This is the point of the session. Build it against the **existing rules-based
suggestion engine**, because that makes it useful immediately and makes it the
scaffold a learned model drops into unchanged.

**C1. Design the contract first, and write it down.** Before any component: what
shape does a "suggestion + its justification" have? It has to serve both the
current rules engine and a future model, which means it needs at minimum a
suggested value, the observed value, a timestamp, the patient state it was
computed from, and a provenance field naming what produced it. Put it in
`docs/engineering/` as a dated document. Getting this wrong is expensive; getting
it written down is cheap.

**C2. The disagreement view.** `suggested_units` vs `units` per dose, over time,
per patient. This is the single most valuable column for RL and nothing displays
it today. A clinician should be able to see where the patient systematically
overrode the algorithm, and in which direction.

**C3. The cohort quality view.** `scripts/measure_drop_rates.py` produces the
table the pre-ML audit says to read before training anything, and it currently
only exists as terminal output. Per-stream fetched/kept/dropped, per patient,
with the source-coverage table beside it. **Read the audit's §4 before building
this** — it explains why the drop rate alone is a misleading number and what has
to sit next to it.

**C4. Snapshot provenance.** Every view should name the `snapshot_id` it came
from. `diatwin/ml/export.py` already produces content-hashed snapshots with the
drop report embedded in the manifest. A clinical claim that cannot name its data
is not reviewable.

**C5. Only then, model output.** Error grids, predicted-vs-actual, calibration.
Blocked until a model exists — do not start here.

### Part D — decide the watch split, or record it

Neither client can do the other's job:

- **Mobile owns the connection**: Google Fit OAuth, settings, status, background
  sync (`/api/watch/{oauth-url,connect,disconnect,settings,status,sync}`).
- **Frontend owns the data**: manual sessions (`/api/watch/activity/*`) and
  continuous/raw HR upload (`/api/watch/hr/*`).

A patient cannot connect their watch from the web. Either bring connection to the
web or write down that connecting is phone-only. Right now it is neither decided
nor documented.

## What is blocking the ML work itself (context, not this session's task)

Do not try to fix these here, but know they exist, because Part C's usefulness
depends on them:

- **200,889 AZT1D basal-insulin rows are unrepresented** by the conversion
  pipeline. This is an automated-insulin-delivery cohort; basal is a large
  fraction of total insulin, so IOB from that data is wrong and **no drop rate
  says so**. Largest single data-fidelity gap.
- **1,858 `DeviceMode == "exercise"` rows** are not converted, so the activity
  stream loads empty.
- **70 extended/dual-wave boluses** have no representation in the canonical
  schema; each is loaded as one instantaneous dose.
- **`export_windows` is O(n²)** — `as_of` is O(n) and is called once per window.
  Measured: 500 readings → 0.04 s; 8,000 → 9.21 s; a 25-patient verification took
  607 s. Fine for an audit, too slow for a training loop.

## Working style

- **Measure before you claim.** Several findings in recent sessions looked like
  bugs and turned out to be correct-but-undocumented once measured. In the
  session that produced this handoff, a naive endpoint grep suggested the
  frontend lacked Libre and FHIR; it has both, and the grep pattern was wrong.
  Check each apparent gap individually.
- **A regression test that passes against the pre-fix code is not evidence.**
  Revert the fix, watch it fail, restore.
- **Negative cases matter more than positive ones.** A test proving the code
  leaves legitimate data alone is worth more than one proving the happy path.
- When you find a real defect, characterise it with a test before fixing it, and
  check whether it appears in `docs/3 Arms Doc/` — several sessions running have
  each found a live bug sitting in the documentation as a contradiction.
- **Report honestly.** If something is uncovered or unresolved, say so rather
  than padding.

## Verify

```
cd backend && pytest tests -q            # 401 passed, 1 skipped
pytest diatwin/tests -q                  # 101 passed
cd mobile && npx jest                    # 362 passed
cd mobile && node scripts/typecheck-ratchet.mjs   # 185, must not rise

python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
node diatwin/verify/frontend_eval.mjs    # needs Node >= 22.15
python -m diatwin.verify.parity compare  # exit 0, 410 baselined

cd frontend && npm ci && npm run build   # currently passes; not yet in CI
```

Use `backend/venv/Scripts/python.exe`, not a bare interpreter — `diatwin/tests`
looks stdlib-only but is not (`diatwin/sim/patient.py` → `backend/constants.py` →
`bson`), and seven tests error without the backend stack.

`SETUP.md` takes a clean clone to a green run. Two gotchas: install
`backend/requirements.txt` + `requirements-dev.txt` (**not** the root
`requirements.txt`, which is an unrelated `pip freeze` sharing 18 of 64 packages
and containing no Flask, pymongo or gunicorn), and copy `backend/.env.example` to
`backend/.env` first.

`parity baseline` re-records accepted divergences. Rule 15: run it only after a
deliberate decision, never to quiet a red build.

## When you finish

Add a dated session report to `docs/engineering/` following the conventions in
its README, and update the "Current state" table there. If you change a model's
behaviour, update `arm5_verification_and_modelling.md` too — it is a reference
document and must describe the present, not the past.

---

## Documents to attach

Attach these five, in this order. They are the minimum for the task above.

| # | Document | Why |
|---|---|---|
| 1 | **`docs/engineering/2026-09-05-web-frontend-parity-audit.md`** | **The brief.** Every measurement Parts A, B and D rest on: the endpoint diff, the doctor line counts, D24 and D25 in full, and §5 on what ML/RL actually needs from the web surface. |
| 2 | **`docs/engineering/README.md`** | The index and the current-state table. Read first for orientation. |
| 3 | **`docs/engineering/arm5_verification_and_modelling.md`** | **§10 is the project's invariants.** Read before writing code. Rules 1, 2, 6, 7, 11, 15 and 16 all bear on this work. |
| 4 | **`docs/engineering/2026-09-05-pre-ml-audit.md`** | Needed for Part C. §4 explains why drop rate is a misleading number and what must sit beside it; §3 covers the leakage guard the snapshot views depend on. |
| 5 | **`docs/engineering/2026-09-05-storage-layer-decision.md`** | Needed for C1 and C4. §1 and §3.5 describe the Parquet snapshot contract the provenance view reads from. |

**Also useful, attach if the session goes deep:**

- `docs/engineering/2026-09-05-defect-fix-pass.md` — §5 is the D9 fix the Part A4
  work mirrors, and §6 records the two provisional model decisions a clinician
  may revisit.
- `docs/3 Arms Doc/arm3_visualization.md` — the visualisation layer's intent.
  Treat as intent, not fact; `arm-docs-audit.md` records where the arm docs are
  known to be wrong.
- `REPOSITORIES.md` — read before assuming any file's history. There are two
  copies of DiaTwin on disk.

**Do not attach** the other session reports (`2026-09-05-verification-pass.md`,
`-mobile-calculation-coverage.md`, `-three-way-parity.md`) or the older handoffs
(`next-session-prompt.md`, `next-session-prompt-audit.md`). They are historical
and their open items are superseded by the README's current-state table.
