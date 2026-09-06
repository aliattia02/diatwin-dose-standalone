# The web frontend gets a safety net, and a review surface

*Session report · 6 September 2026*

---

## What this session was for

Making the React frontend the surface where a clinician reviews machine-learning
and reinforcement-learning output. The
[frontend parity audit](./2026-09-05-web-frontend-parity-audit.md) is the brief.

The order was fixed by risk removed per unit of effort: the frontend was 51,080
lines with nothing checking any of it, so everything else was premature. That
turned out to matter more than expected — putting a test around the tree was
what surfaced the two largest findings below.

---

## 1. What was found that the audit did not

Three of these change the picture materially. All were measured, not inferred.

### 1.1 The doctor dashboard was not thin — it was broken

The audit measured the doctor UI at 535 lines against the mobile client's 5,081
and called it a 9.5× deficit. That is true and it is not the finding.

`GlycemicResponseTracker.js` was 0 bytes, and the audit found three render sites
for the four empty components. There were **five**, and the audit's search missed
the two that matter most:

| Render site | When it runs |
|---|---|
| `DoctorDashboard.js:245` | **as soon as a doctor selects a patient** |
| `AdminDashboard.js:254` | as soon as an admin selects a patient |
| `App.js:121` | the `/meal-history` route |
| `App.js:125` | the `/patient/:patientId/meal-history` route |
| `PatientDashboard.js:99` | the "Combined Meal Analytics" tab |

The doctor render is inside `selectedPatient ? (…)`, so it is unconditional
once a patient is chosen, and there is **no error boundary anywhere above it** —
the only `componentDidCatch` in the tree is local to
`CombinedGlucoseInsulinChart`. Selecting a patient took the whole view down.

So the doctor dashboard did not have one working chart and a lot of missing
features. Its main chart area threw, and the two routes named "meal history"
threw with it.

### 1.2 The API could not tell a doctor what timezone their patient is in

`GET /api/doctor/patient/<id>/constants` returned `daily_reset_hour` and **not**
`timezone_offset_minutes` (`doctor_routes.py:113`). The field is stored — it is
declared at `constants.py:285` and backfilled by `migrate_timezone_offset.py` —
and only this response dropped it.

That makes the reset hour meaningless to the caller. 07:00 is a different
instant in Cairo and in Auckland, and with the offset missing a doctor's client
has no way to learn which, so it falls back to the browser's. That is D24
arriving from the API side, where no amount of client work could have fixed it.

The audit could not have found this: it diffed *endpoint sets*, and this
endpoint exists on both clients. The gap was inside the response body.

### 1.3 `isAtResetTime` had no timezone parameter at all — D24b

The audit listed six D24 call sites, all described as omitting
`tzOffsetMinutes`. Checked one at a time, they were **three different functions**,
and the list was both slightly wrong and an undercount:

| Site | Function | Actually |
|---|---|---|
| `bloodGlucoseEstimationService.js:176` | `getDailyResetTime` | argument omitted |
| `…:208, 392, 915, 1020` | `isWithinCurrentDay` | argument omitted |
| `…:844` | `isAtResetTime` | **no such argument existed** |
| `BloodSugarDataContext.js:1504` | `getDailyResetTime` | argument omitted |

`isAtResetTime` read `getHours()`/`getMinutes()` off the browser's wall clock and
took no offset, so no call site could have passed one. It was a second,
independent definition of the reset boundary — which is what **rule 16**
forbids — and all five of its call sites were wrong for any patient not in the
viewer's timezone. Recorded as **D24b**.

There is a display-side counterpart too: every formatter in `TimeManager`
read the browser's clock, so a doctor in London reviewing an Auckland patient saw
that patient's breakfast stamped 20:00 the previous day.

### 1.4 The audit's watch split is wrong in one row

§2.3 lists manual HR session recording (`/api/watch/activity/{start,end,status}`)
and `/api/watch/hr/stream` as frontend-only. The mobile client has all four, in
`services/api/watch-hr.ts`, wired to `components/forms/UnifiedActivityInput.tsx`.
The measured split is in §5 below, and it is far smaller than the audit
suggested.

### 1.5 D25's mechanism is not what the audit predicted

The audit said the default export of a 0-byte module is `undefined`, so
`React.createElement(undefined)` throws. The consequence is right; the mechanism
is not. Measured under the CRA babel interop, an empty module imports as an
empty *namespace object*, and React rejects it with "Element type is invalid …
but got: **object**". Worth stating because `toBeUndefined()` is the natural
assertion to reach for and it does not hold.

---

## 2. Part A — the frontend is now checked

### 2.1 It is in CI

A `frontend` job runs `npm ci`, the jest suite, and a combined build-and-lint
step. Two things had to be got right for it to be a gate rather than decoration:

**The workflow never ran on push.** `on.push.branches` was `[main]`; the default
branch is `master`. Only `pull_request` was ever triggering it. Both are listed
now.

**`CI=true npm run build` fails on this tree.** react-scripts turns every eslint
warning into an error under `CI=true`, and there are **175** of them, so the
obvious job would have been red the day it was added — the exact trap the mobile
typecheck fell into, described in the pre-ML audit §2. So `frontend/scripts/lint-ratchet.mjs`
follows the established pattern: it runs the build once (a compile error still
fails), counts the warnings, and fails if the count rises, or falls without the
baseline being re-recorded. Running the build once serves both purposes, because
the build is the slow step.

The count is **174** after this session's changes: the work added no new warnings
and removed one.

### 2.2 It has a test suite

`App.test.js` — Create React App boilerplate asserting the page renders "learn
react", which `App.js` does not render — is deleted. In its place, **78 tests**
across five suites:

| Suite | Tests | What it holds |
|---|---:|---|
| `daily-reset-consolidation.test.js` | 10 | D24/D24b, ported from the mobile suite of the same name |
| `time-manager-format.test.js` | 10 | the formatter refactor is exactly equivalent; the new zone-aware path |
| `suggestion-review.test.js` | 28 | the review contract's four rules, as executable rules |
| `dashboard-tabs.test.js` | 21 | D25, guarding the class rather than the instances |
| `clinical-validation-dashboard.test.js` | 9 | the tab that used to throw now renders and says what it shows |

Two pieces of infrastructure were needed and are worth knowing about:

- **`axios` v1 resolves to an ES module** at its package entry, and CRA's jest
  does not transform `node_modules`. Every component test failed with "Cannot
  use import statement outside a module" until `jest.moduleNameMapper` pointed
  `^axios$` at the CommonJS build axios also ships.
- **jsdom has no `ResizeObserver`** and no element layout, and recharts'
  `ResponsiveContainer` needs both. Two shims in `setupTests.js`. The observer
  never fires, deliberately: these tests assert on the numbers and labels around
  a chart, not on SVG geometry, and a stub that invented sizes would make them
  depend on made-up layout.

`dashboard-tabs.test.js` is the one shaped to outlive its defect. It scans for
any 0-byte source file, and reads `PatientDashboard.js`'s import list out of the
source rather than hard-coding it, so a component added to the dashboard later is
covered without anyone remembering to add it — with a guard test on the regex, so
the suite cannot pass vacuously if the parse stops matching.

### 2.3 D25 — fixed, one decision per component

Checked in `native3`'s 752-commit history first, because "was this ever
implemented?" changes the answer:

| Component | History | Decision |
|---|---|---|
| `ClinicalValidationDashboard.js` | **never had content** — committed 0 bytes at `ff33b63` | **Implemented.** See §4 |
| `GlycemicResponseTracker.js` | 45,334 bytes at `9c32f5e`, truncated at `e562c82` | **Removed.** See below |
| `Test.js` | never had content | Deleted; a scratch tab in a clinical app |
| `EnhancedPatientConstants.js` | 7,113 bytes, truncated, orphaned | Deleted; nothing imported it |

`GlycemicResponseTracker` is the one that needed a judgement call. A real 45 KB
implementation exists in the other repository's history, so "restore it" looks
obvious — but it imports `../utils/BG_Effect` and `../utils/MealChartUtils`, and
**neither module exists in this codebase any more**. Restoring it is a port onto
the current calculation stack, not a revert, and porting 1,333 lines of
unreviewed clinical charting was not something to do inside a session about
making the tree safe. Its capability is also substantially covered by working
components: `EffectsVisualization` and `CombinedGlucoseInsulinChart` both exist
and both render.

So the five render sites were dealt with individually rather than deleted
wholesale:

- The two `App.js` routes now render `MealHistory`, the working component for the
  same data. The doctor route reads `patientId` off the URL through `useParams`,
  which the old route never did — it passed `isDoctor` alone, so even a working
  component would have had no patient to fetch.
- The doctor and admin dashboards' chart slot now holds the clinical validation
  surface (§4), which owns its own time-range control.
- The patient dashboard's tab is removed.

**What this costs:** the "Combined Meal Analytics" tab is gone rather than fixed.
It rendered nothing before, so nothing that worked was lost, but the *intent* was
real and is recorded here rather than dropped. Recovering it means porting
`native3` `9c32f5e:frontend/src/components/GlycemicResponseTracker.js` onto
`netEffectCalculationService` and `ChartUtils`.

### 2.4 D24 and D24b — fixed

All seven call sites now pass the patient's offset, using the idiom already
established in `netEffectCalculationService.js:486`. `isAtResetTime` gained a
`tzOffsetMinutes` parameter and now derives its answer from
`getDailyResetTime`, so there is one definition of the boundary (rule 16) rather
than two. Its four chart call sites pass the offset they already had in scope.
`netEffectCalculationService`'s `isAtResetTime` wrapper was swallowing both
`resetHour` and the offset; it forwards them now, like the two wrappers beside it.

For the display side, `TimeManager.formatDateInZone(date, format, tzOffsetMinutes)`
is new and `formatDate` delegates to it with a null offset. The equivalence is
tested against a copy of the pre-refactor implementation across five instants
spanning both DST transitions and all eleven formats — a refactor that shifted
every timestamp in the app by an hour would look fine in a screenshot.

**Verified by reverting.** The four D24 tests fail against the pre-fix frontend;
ten of the eleven backend tests fail against the pre-fix `doctor_routes.py`.
Parity is unchanged: `frontend|python` still agrees to 0 across all 1,578 cases,
so none of this moved a model output.

---

## 3. The API fix, and why it is in a client session

`/api/doctor/patient/<id>/constants` now returns `timezone_offset_minutes`
alongside `daily_reset_hour`. Eleven tests in
`backend/tests/test_doctor_patient_constants.py` pin it, and they test the
*value* rather than the key's presence: a response hard-coding 0 would satisfy a
presence check and still hand a clinician a boundary a day out for anyone east of
+07:00, which is the shape D9 took. The half-hour and quarter-hour offsets are in
the parameter list because they are real and are where a whole-hours
implementation breaks.

The audit said Part B was "client work only — no backend needed". That is true of
the eight endpoints' *existence* and false of this field. It is one line, and
without it the clinician surface cannot be correct at all.

---

## 3A. Part B — the doctor dashboard was not thin, it was broken

Picked up after §1–§3 landed, in the same session. The audit measured the
doctor dashboard as a 9.5× line-count deficit against the mobile client and
recommended porting the missing endpoint usage. Reading the four components
`DoctorDashboard.js` actually renders turned up three defects that a line
count cannot see: one dead link, and two components that ignore the
`isDoctor`/`patientId` props the dashboard already passes them and silently
render the **doctor's own** data — or nothing — under the selected patient's
name and header. All three are fixed; none needed new UI, only correct wiring.

### D26 — `BloodSugarChart`'s doctor-mode request was missing `/api`

```js
url = `${API_BASE_URL}/doctor/patient/${patientId}/blood-sugar?...`
```

Every route in this backend is registered under `/api/*`. This 404'd on every
call, and landed in a `catch` block that sets a generic "Failed to fetch blood
sugar data" string — which reads exactly like "this patient has no data".
`BloodSugarChart` is one of the very few doctor-facing charts the audit found
at all, and it never worked. One character short of `/api`; fixed by adding it.

### D27 — a doctor endpoint with no per-patient authorization check

Looking for a fix for D28 (below) surfaced a second, working
activity-history route this session had not been looking for:
`GET /api/patient/<patient_id>/activity-history` (`backend/activity.py`),
distinct from `GET /api/doctor/patient/<id>/activity-history`
(`doctor_routes.py`). It checked only `current_user['user_type'] == 'doctor'`
— **any** doctor account, authorized or not, could read **any** patient's
activity history by guessing or enumerating a patient id. Every other
`/api/doctor/patient/<id>/*` route calls `check_doctor_patient_access`, which
confirms the caller is actually on that patient's `authorized_doctors` list
first; this route never did. Fixed by importing and calling the same check —
which also, as a side effect matching every sibling endpoint, gives admins
access they did not have before. Nine tests in
`backend/tests/test_patient_activity_history_route.py` pin the authorization
boundary, the response shape, and that a second patient's data never leaks
into the wrong list.

A `mobile/services/api/endpoints.ts` comment says this route "did NOT exist in
any backend file" and explains why mobile calls the other one instead. It
exists now and returns a materially different, better-suited shape (below) —
the comment is stale, not a warning to route around it, and one of the new
tests pins that directly so it cannot be rediscovered the hard way twice.

### D28 — `ActivityVisualization` and `BloodSugarVisualization` ignored `isDoctor`/`patientId` entirely

Both components are called from `DoctorDashboard.js` and `AdminDashboard.js`
as `<Component isDoctor={true} patientId={selectedPatient.id} />`. Neither
prop reached anything.

**`ActivityVisualization`** always fetched `/api/activity-history` — the
*caller's* activities, i.e. the doctor's — and always read `patientConstants`
from `useConstants()`, the doctor's own reset hour, HR base and HR max, which
every effect calculation in the file depends on
(`calculateActivityCumulativeEffect`, `getActivityOnBoard`). The obvious fix —
switch the URL to `/api/doctor/patient/<id>/activity-history` — would have
made this worse: that route returns `activityType`/`activityLevel`, a shape
`normalizeActivityRecord` cannot read at all (it needs `level`, `intensity`,
`duration_minutes`, `bg_direction`), so every record from it maps to `null`
and is silently dropped. D27's route returns the matching shape instead. Fixed:

* `fetchActivities` branches to `/api/patient/<id>/activity-history` in doctor
  mode.
* A `patientConstants` local variable shadows the context value with one
  fetched from `/api/doctor/patient/<id>/constants` in doctor mode — the ~15
  downstream reads of `patientConstants` needed no changes.
* The two calls that write into `BloodSugarDataContext`
  (`fetchLast24hData`, `handleViewModeChange`) are now guarded behind
  `!isDoctor`, because that context is scoped to the logged-in user and a
  doctor triggering it would push the doctor's own glucose data into state
  that `BloodSugarVisualization` — rendered right beside it — also reads.

Six tests in `frontend/src/__tests__/activity-visualization-doctor-mode.test.js`
assert on the axios calls made in each mode, including a negative case
pinning that the incompatible sibling endpoint is never called.

**`BloodSugarVisualization`** could not be fixed the same way. Every value it
renders — `combinedData`, `targetGlucose`, `activeEffects`, `recentMealsData`,
`recentInsulinData`, `last24hData`, `adjustedBaselineForProjection` — comes
from `BloodSugarDataContext`, a single-tenant, 2,400-line context with no
patient-scoped variant. Retrofitting one is a separate piece of work, not a
wiring fix. Applied the same judgment as D25: an early return when
`isDoctor && patientId`, showing an honest "not yet available in doctor view"
message and pointing at `BloodSugarChart` (fixed as D26, and *not*
context-coupled) rather than silently rendering the doctor's own empty
context under the patient's header. Five tests in
`bloodsugar-visualization-doctor-mode.test.js` pin the gap message in doctor
mode and confirm patient mode is untouched.

All three defects were verified by reverting the fix, confirming the specific
tests failed against the pre-fix code, and restoring it — not just written
against passing code.

**What Part B still does not have**: the five other unused
`/api/doctor/patient/<id>/*` endpoints (medications, medication-log,
conditions, insulin, and blood-sugar's PUT/reset siblings on constants) have
no doctor-facing view at all. This pass fixed what was wired wrong; it did not
build what was never built. See §7.

---

## 4. Part C — the review surface

### 4.1 The contract came first

[`2026-09-05-suggestion-review-contract.md`](./2026-09-05-suggestion-review-contract.md)
defines what a reviewable suggestion is before any component was written, because
the surface has to serve both today's rules engine and a model that does not
exist yet.

The thing that makes this buildable now: **there is no machine learning** —
`diatwin/ml/` holds one file, `export.py`, with no training code, no artifact, no
prediction endpoint and no RL code. But there *is* a suggestion signal, and it is
the one the RL step will train against. `meal_insulin.py:795` writes
`suggestedInsulin` onto every meal beside `intendedInsulin`, and
`diatwin/data/schema.py:113` calls that pair "the behavioural-cloning target and
the single most valuable column for the later RL step".

Better still, and not stated in the audit: **`GET /api/doctor/meal-history/<id>`
already returns both fields**, along with `insulinCalculation` for the
justification. The disagreement view needed no new endpoint.

The contract's four rules are the ones that are easy to violate invisibly: the
sign and the nulls survive to the display; a displayed suggestion names its
producer; `decided_at` and `observed_at` are both stored; a view naming a
snapshot names it.

### 4.2 The disagreement view — C2

`utils/suggestionReview.js` is the arithmetic, deliberately with no React in it
so a clinical claim's numbers can be tested without a DOM, a chart library or a
network. `components/InsulinDisagreementView.js` fetches and draws.

What it shows: signed `taken − suggested` per meal over a window, the over/under/
within split at a half-unit tolerance, median beside mean, and the largest
overrides as a table. Median is the headline because one mistyped dose (5.5
entered as 55) moves a mean over a small cohort, and a clinician reads the
headline — there is a test for exactly that.

The choices worth defending are all about not destroying the finding:

- **Nothing is folded to a magnitude.** A cohort that splits evenly over and
  under would otherwise look identical to one that consistently over-doses, and
  the second is a clinical problem while the first is noise.
- **A missing decision is never a zero.** A meal with no recorded dose read as
  "took 0 U" renders as a large negative override that never happened. Pending,
  unadvised and none are counted separately and shown.
- **A recorded zero is a real decision** — "no insulin for this meal" — and is
  not swept in with absent data. That negative case has its own test.
- **`overrideRate` is null, not 0, when there is nothing to divide by.** "No
  data" and "never overrode" are different answers.
- **Timestamps render in the patient's timezone**, using §3's new field, and the
  footer says which clock it used. A client talking to an older backend degrades
  to the browser and says so rather than silently claiming patient time.

### 4.3 The clinical validation dashboard — C4

`ClinicalValidationDashboard.js`, the 0-byte file, is now the surface: the
disagreement view, the cohort-quality view (§4.4), and a provenance panel
naming the producer, the data, and the comparison in words.

It also names **what is not there**: error grids, predicted-vs-actual and
calibration need a model and are listed as absent rather than shown as empty
charts. A clinical surface displaying a plausible-looking empty chart is worse
than one that says what it does not have.

**C5 was not built. It is blocked on a model existing.**

### 4.4 The cohort quality view — C3

This was left open at the first pass and picked up in the same session.
`scripts/measure_drop_rates.py` and `diatwin/ml/export.py` have produced the
per-patient, per-stream `LoadReport` accounting since they were written, and
`export_snapshot` writes it into every snapshot's `manifest.json` permanently
(§0's finding, restated: this data already existed, nothing served it). Two
new endpoints in `backend/routes/ml_routes.py` are the whole of what was
missing:

```
GET /api/ml/snapshots
GET /api/ml/snapshots/<snapshot_id>/manifest
```

Both read `manifest.json` off disk from a directory named by `ML_SNAPSHOTS_DIR`
(default: `snapshots/` at the repo root, matching `export_snapshot`'s own
default `out_dir` in `diatwin/ml/export.py`). Nothing is written, nothing
trains, and neither endpoint touches Mongo — this is a read of a file
`diatwin/ml/export.py` already produces from `MongoRepository`, which keeps it
off the training data path the storage-layer decision describes.

**Restricted to admins**, not doctors. A snapshot's `load_reports` list names
every patient in the cohort, not the subset a given doctor is authorized for —
`check_doctor_patient_access` has no meaning here, since there is no single
patient to check access against. Tested directly: a doctor and a patient token
both get 403, and the patient ids in the manifest are asserted absent from that
403 response body.

`frontend/src/utils/cohortQuality.js` aggregates a manifest into cohort-wide
per-stream totals and a per-patient table — pure functions, tested with no DOM,
following the same shape as `suggestionReview.js`. `CohortQualityView.js`
fetches and renders.

**The audit's actual finding drove what gets flagged automatically.** §4 of the
pre-ML audit found two real losses — 60% of the insulin signal and an entire
subject's glucose stream — that a drop-rate threshold could not see, because
both showed as a *clean* drop rate: a record that is never fetched cannot be
counted as dropped. So `zeroFetchedWarnings` is the one verdict this view
renders automatically and prominently, ahead of the drop-rate table: a
canonical stream with **zero rows fetched** across the whole cohort. Everything
else — the per-stream fail rates — is shown as numbers with a caption, not an
automatic flag, because the audit also found that the naive 5% "investigate"
threshold `aggregate_reports` applies is noise for three of the four streams
(meals, activity, and often insulin, where a high normalize-drop rate is
correct by-design behaviour — zero-carb meals and sedentary rows are *supposed*
to be refused). Inventing a second heuristic to replace the one already shown
to mislead would have been worse than showing the raw numbers plainly.

Also carried through: the insulin dual-write check (`insulin_deduped == 0` on a
large load means the dual write is not being read from both collections, which
would *halve* the signal — the opposite failure dedup exists to guard against),
and per-patient visibility into which patients have no constants profile
(`profile_found: false`, which silently defaults `tz_offset_min` to 0).

**Verified against a real, unmocked chain**, not just the test suite: a
synthetic corpus through `MongoRepository.load_many`, `export_snapshot` writing
an actual `manifest.json` to disk, and the real Flask app (register_blueprint,
mongomock, a minted admin JWT) serving it back over HTTP. `_snapshots_root()`'s
default resolved to the real snapshot directory with no environment override,
confirming the convention actually works rather than only working in a test
fixture that sets `ML_SNAPSHOTS_DIR` explicitly. The snapshot was deleted after
verification — `snapshots/` is now gitignored so this cannot recur by accident.

---

## 5. Part D — the watch split, decided

The audit's §3 said neither client can do the other's job. Measured directly
against both source trees, the overlap is much larger than that and the genuine
split much smaller:

| Endpoint | Mobile | Frontend |
|---|:--:|:--:|
| `/api/watch/activity/{start,end,status}` | ✅ | ✅ |
| `/api/watch/hr/stream` | ✅ | ✅ |
| `/api/watch/{oauth-url,connect,disconnect,settings,status,sync}` | ✅ | — |
| `/api/watch/hr/continuous`, `/api/watch/hr/raw/<id>` | — | ✅ |

Manual session recording is on **both** — mobile through
`services/api/watch-hr.ts` into `components/forms/UnifiedActivityInput.tsx`.
The audit listed it as frontend-only.

**Decision: connecting a watch is phone-only, and that is recorded rather than
changed.** Two reasons, neither of which is effort. The connection is Google Fit
OAuth, and the data source is the phone — a web consent flow would authorise a
session on a device that has no sensor attached to it. And the background sync
(`/api/watch/sync`) is a timed job on the device that holds the data; there is no
equivalent for a browser tab that is closed.

**The converse is also decided: bulk HR upload stays web-only.**
`/api/watch/hr/continuous` takes an all-day trace for auto-segmentation and
`/api/watch/hr/raw/<id>` returns a per-second trace for visualisation. Both are
file- and screen-shaped, which is a desktop task.

So the split is: **the phone owns the connection, the browser owns the bulk
data, and both can record a session.** No work follows from this; it needed
writing down.

---

## 6. Verification

Everything below was run at the end of the session on `master`.

| | Before | After |
|---|---:|---:|
| Backend | 401 passed, 1 skipped | **437 passed, 1 skipped** |
| Foundation | 101 | **101** |
| Mobile | 362 (358 + 4 parity) | **362** |
| **Frontend** | **0** (1 broken boilerplate) | **117** |
| **Total** | 864 | **1,017** |
| Mobile typecheck | 185, ratcheted | **185**, unchanged |
| Frontend lint | unmeasured | **174**, ratcheted |
| Parity | exit 0, 410 baselined | **exit 0, 410 baselined, 0 NEW** |
| Frontend build | passes, not in CI | passes, **in CI** |
| Backend routes | 94 registered | **96** (`/api/ml/snapshots`, `/api/ml/snapshots/<id>/manifest`) |

(437 + 101 + 362 + 117 = 1,017.)

`frontend|python` remains 0 diverging across all 1,578 cases, which is the
evidence that the D24 work changed no model output. The 205 `typescript`
divergences are the pre-existing baselined ones (the α = 4.5 branch).

---

## 7. What is left, in the order it should be taken

1. **Decide whether to port `GlycemicResponseTracker`.** §2.3 has the recovery
   path and the reason it is a port rather than a revert.
2. **Five doctor endpoints still have no view at all**: medications,
   medication-log (POST/GET), conditions, insulin dose history, and the
   constants PUT/reset actions (currently read-only via
   `EnhancedPatientConstantsUI`). §3A fixed what was wired *wrong* — the crash,
   the 404, and the two components silently rendering the doctor's own data —
   it did not build what was never built. `mobile/components/doctor/PatientDataView.tsx`
   remains the reference — for its endpoint usage and calculation calls, not
   its component tree.
3. **`BloodSugarVisualization` still has no doctor-mode implementation**, only
   an honest placeholder (§3A). Building one means giving
   `BloodSugarDataContext` a patient-scoped variant, which is a context
   refactor, not a wiring fix.
4. **No snapshot exists to look at.** C3's endpoints and view are built and
   verified against a manually-produced manifest; the deployed database holds
   no clinical data, so `GET /api/ml/snapshots` returns an honest empty list in
   production today. The view is ready for the day a real snapshot is exported;
   nothing about running `diatwin/ml/export.py` against real data was done here.
5. **Everything the previous handoff listed** is unchanged: the α = 4.5 branch,
   the two provisional model decisions, D21b, basal insulin, and the AZT1D
   credential rotation.

## 8. What this session did not do

- **No browser run.** The components are tested under jsdom with mocked
  endpoints; nothing was exercised against a live backend or looked at on a
  screen. The D25 crash was reproduced in a test, not observed in a browser.
  The one exception is C3: its backend chain (§4.4) was run for real, once,
  against a manually-built snapshot, and the artifact was deleted afterward.
  D26–D28 (§3A) were each verified by reverting the fix and confirming the
  new test failed against the pre-fix code, which is stronger evidence than a
  test written and passed only once — but it is still not a browser.
- **The 174 lint warnings are baselined, not fixed.** The ratchet stops them
  growing; it does not reduce them.
- **`InsulinDisagreementView` fetches a flat 500 meals and windows client-side**,
  because the meal endpoints page by `skip`/`limit` and take no date bound. That
  is fine for the current database and will not be at cohort scale.
- **`CohortQualityView` loads one manifest in full into the browser.** A
  cohort's `load_reports` list scales with patient count, not with data volume,
  so this is fine well past any cohort size this system has seen and would need
  paging only at a scale nothing here approaches yet.
- **Permissions were mostly still not audited**, per the standing decision
  that this is a closed test environment — D27's missing authorization check
  was found while chasing a different defect (D28), not by a deliberate sweep.
  No route beyond the ones this session happened to touch was checked for the
  same gap. The one new backend test on the doctor constants field checks that
  adding it did not widen access.
