# DiaTwin — Arm 5: Verification & Modelling Foundation
**Reference Document — Current State**

```
================================================================
Scope
  Python:     diatwin/data/schema.py · diatwin/data/normalize.py
              diatwin/core/grid.py · diatwin/sim/patient.py
              diatwin/verify/parity.py
              backend/tests/* · diatwin/tests/*
              backend/sweep_orphaned_meals.py
  TypeScript: mobile/__tests__/parity.test.ts
              mobile/__tests__/time-manager.test.ts
  JavaScript: diatwin/verify/frontend_eval.mjs
  CI:         .github/workflows/ci.yml

Cross-references
  Arm 0 (Infrastructure) owns: main.py · config.py · auth
         → §2 stubs its schedulers and Atlas ping to make the app testable
  Arm 1 (Constants & Ingestion) owns: constants.py · stored schemas
         → §3 normalizes the shapes Arm 1 writes; §5 embeds Arm 1 profiles
  Arm 2 (Data Operations) owns: pharmacodynamics.py · the TS calculation stack
         → §4 wraps Arm 2's kernel as a simulator; §5 compares its three
           implementations against each other, pairwise
  Arm 3 (Visualization) owns: frontend/src/utils/ — the third implementation
         → §5 evaluates it as the harness's third side; it has no tests of
           its own, so the harness is its only coverage
  Arm 4 (Mobile Client)  owns: TimeManager · services
         → §6 covers the TimeManager suite
================================================================
```

---

## Table of Contents

- [§0 Architecture Overview](#0-architecture-overview)
- [§1 The `diatwin` package](#1-the-diatwin-package)
- [§2 Backend test harness](#2-backend-test-harness)
- [§3 Canonical data layer](#3-canonical-data-layer)
- [§4 The kernel as a simulator](#4-the-kernel-as-a-simulator)
- [§5 Cross-language parity](#5-cross-language-parity)
- [§6 Mobile suites](#6-mobile-suites)
- [§7 Maintenance scripts](#7-maintenance-scripts)
- [§8 Continuous integration](#8-continuous-integration)
- [§9 Cross-Arm References](#9-cross-arm-references)
- [§10 Developer Rules](#10-developer-rules)

---

## §0 Architecture Overview

Arms 0–4 describe what the system does. Arm 5 describes what holds it to that
description, and supplies the foundation the ML and RL work will be built on.

```
================================================================
  backend/utils/pharmacodynamics.py          ← Arm 2, unchanged
  backend/utils/activity_pharmacodynamics.py    imports math, logging,
                                                datetime, constants,
                                                time_manager. No DB.
        │
        ├── diatwin/data/schema.py       canonical events, one UTC axis
        ├── diatwin/data/normalize.py    raw Mongo → events
        ├── diatwin/core/grid.py         the 5-minute axis
        ├── diatwin/sim/patient.py       kernel as forward simulator
        └── diatwin/verify/parity.py     Python ↔ TypeScript comparison
                                         ── all stdlib only ──
        │
        └── diatwin/ml/                  (empty — see §10 rule 9)
================================================================
```

**Test counts as of 2026-09-05**

| Suite | Tests | Runtime | Command |
|---|---:|---:|---|
| `backend/tests` | 280 | 21 s | `cd backend && pytest tests -q` |
| `diatwin/tests` | 65 | 1.6 s | `pytest diatwin/tests -q` |
| `mobile` (8 suites) | 317 | 7 s | `cd mobile && npx jest` |
| **Total** | **662** | | |

`frontend/src/utils/` has no test suite of its own. Its three pharmacodynamic
modules are covered by the parity harness (§5) across 1,578 cases each; the
other thirteen files in that directory are uncovered.

`mobile/` typecheck is not yet a gate: `npx tsc --noEmit` reports 197 errors.

---

## §1 The `diatwin` package

A Python package at the repository root, importable independently of Flask.
It exists because the ML and RL work needs the pharmacodynamic kernel without
the request path, and needs one definition of "an event" that is not a raw
Mongo document.

The layering rule is strict and load-bearing: **everything through
`sim/patient.py` depends on the standard library alone.** That is what lets
the whole foundation run in CI in under a second, before any modelling
dependency is installed, and it is what makes the parity harness runnable on
a machine with no numpy.

`requirements-ml.txt` holds the modelling stack and is installed only for work
under `diatwin/ml/`.

---

## §2 Backend test harness

`backend/tests/conftest.py`. Three things must be neutralised before the Flask
app can be imported in a test process, and all three are non-obvious:

1. **The schedulers.** `create_app()` starts the LibreLinkUp and Google Fit
   pollers unconditionally (Arm 0 §4, §5). In a test run they fire real HTTP
   requests on a timer. Both start functions are replaced with no-ops before
   `main` is imported.
2. **The Atlas ping.** `config.create_app_config()` calls
   `test_mongo_connection()` at startup, and `config` raises at import time
   when `MONGO_URI` is unset. The URI is set to a dummy value and the ping is
   stubbed; `mongo.db` is then replaced with an in-memory `mongomock`
   database.
3. **The entrypoint collision.** The repository root carries its own
   `main.py` — a leftover PyCharm template — which shadows
   `backend/main.py` depending on how pytest seeds `sys.path`. `conftest`
   loads the backend module by explicit file path via `importlib`.

Constants export to disk is stubbed as well: harmless, but slow and noisy.

**Fixtures.** `flask_app` (session-scoped), `db` (dropped per test), `client`,
`patient` / `other_patient` / `doctor` / `admin` / `authorized_doctor`,
`auth(user, mobile=, expired=)` for bearer headers, and `seed(user)` which
writes a realistic day: 24 CGM readings, one meal with its projection and
insulin, one medication log, one activity.

`seed` deliberately reproduces the **dual write** — insulin lands in
`medication_logs` *and* on the meal — so tests exercise the real shape rather
than a tidied one. It also sets both link fields (`meals_only.meal_id` and
`meals.meals_only_id`) exactly as `meal_insulin.py:830-850` does.

**Suites**

| File | Tests | Covers |
|---|---:|---|
| `test_pharmacodynamics.py` | 172 | The kernel: activity curves, IOB, absorption, cumulative effects, daily reset, integration artifacts |
| `test_data_flows.py` | 30 | Round trips: BG, meals, activity, auth, constants, doctor access |
| `test_route_inventory.py` | 19 | Every route: auth coverage, 5xx, duplicate registration, `/api/v1` proxy |
| `test_mob_iob_integration.py` | 16 | `/api/active-effects-full` conservation and aliases |
| `test_known_defects.py` | 16 | D1 regression, D2/D3 characterization |
| `test_sweep_orphaned_meals.py` | 22 | Orphan classification (§7) |
| `test_smoke.py` | 6 | Harness sanity |

**The route inventory is the highest-leverage file.** It discovers rules from
the live URL map rather than listing them, so a new blueprint is covered the
moment it registers. It asserts that every non-public route rejects an
unauthenticated call, that no route 5xx's without a token, and that no two
handlers claim the same rule and method — the last of which is the check that
would have caught D1 (see `arm-docs-audit.md` §1).

---

## §3 Canonical data layer

`diatwin/data/`. Three rules hold for every record:

1. `t` is a timezone-aware UTC datetime. One time axis. Local wall-clock is
   derived from `tz_offset_min`, never stored as a second source of truth.
2. `observed_at` is when the system first learned the fact — never later than
   the moment a model may use the record.
3. Records are immutable value objects. Corrections arrive as a new record
   with a later `observed_at`.

### 3.1 Why this layer exists

Three properties of the stored data make a naive dataset build wrong, and all
three are invisible from the app because the request path works around each.

**Four timestamp encodings.** `bloodSugarTimestamp` has been written as a
naive `datetime`, an ISO string, an ISO string with `Z`, and not at all. The
`$or` fan-out at `blood_sugar.py:341-363` exists to catch all four at query
time. `normalize.parse_time()` collapses them, and also accepts epoch seconds
and milliseconds. Unparseable input returns `None`, never *now* — a bad row
must not silently become the newest record on the timeline.

**Every bolus is written twice.** Once to `medication_logs` and once onto the
`meals` document as `intendedInsulin` (Arm 1 §12). Reading both without
deduplication doubles every dose. `normalize.dedupe_insulin()` collapses
matches within a two-minute window and keeps whichever copy carries
`suggestedInsulin` — the difference between what the app proposed and what the
patient took, which is the behavioural-cloning target for the RL step.

**Records are mutable, so the past moves.** A meal eaten at 14:00 can be
entered at 19:00. `PatientTimeline.as_of(t)` filters on `observed_at`, not
`t`. Without it, offline results look excellent and do not deploy.

### 3.2 The grid

`diatwin/core/grid.py`. Step is 5 minutes, matching the LibreLinkUp sampling
interval. Grid points align to absolute UTC epoch multiples, not to the first
reading, so two patients' grids line up and re-running over a longer window
reproduces the earlier window's points exactly.

Missingness is carried, never filled. Beyond a 20-minute gap the series is
treated as interrupted and points are emitted as `None` rather than
interpolated — "the sensor was off" and "glucose was 100" are different facts.
`lag()` and `lead()` pad with `None`, never zero: a zero at the head of a lag
column is a fabricated observation a model will happily learn from.

---

## §4 The kernel as a simulator

`diatwin/sim/patient.py`. The Arm 2 kernel is already a pure function of
`(events, patient_constants, time)`, so this module supplies only what it
lacks: an adapter and a state object.

**The adapter** converts canonical events to the Mongo-shaped dicts the kernel
reads, and — critically — strips `tzinfo`, because the kernel's convention is
**timezone-naive UTC** throughout. One place converts.

`carb_equivalent()` always supplies `nutrition.total_carb_equiv`, computed as
`meal_insulin.py:683` does. This is not optional: without the field,
`calculate_meal_active_carbs()` falls back to an unweighted sum while
`calculate_meal_cumulative_effect()` returns `0.0`, producing a meal that is
absorbing but has no BG effect (audit §4.5).

**`PatientState`** names what the kernel returns — `iob`, `mob`,
`insulin_effect`, `meal_effect`, `activity_effect`, `net_effect`,
`baseline_bg`, `predicted_bg`, `sensitivity_multiplier` — so downstream code
reads as physiology rather than as dictionary keys. `as_features()` returns
the flat float dict that becomes a feature row, including `pd_predicted_bg`,
which is the kernel's own prediction and the baseline the ML residual is
learned against.

**Two uses, one object.** `state_at(t)` over a grid produces the physics
feature block. `copy()` + `apply()` + `state_at()` is the transition function
an RL environment steps. `state_at` only ever sees events at or before `t`, so
it is safe to call across a whole grid without leaking the future.

Deliberately **not** here: a `gymnasium.Env`. That belongs in `sim/env.py`
once a reward is agreed, and should be thin. Keeping the dynamics importable
without an RL dependency is what lets the same code serve feature generation
and CI.

---

## §5 Cross-language parity

`diatwin/verify/parity.py` + `mobile/__tests__/parity.test.ts` +
`diatwin/verify/frontend_eval.mjs`.

The insulin, meal and activity models are implemented independently **three
times** — in Python (`backend/utils/pharmacodynamics.py`,
`backend/utils/activity_pharmacodynamics.py`), in TypeScript
(`mobile/utils/insulin/pharmacodynamics.ts`,
`mobile/utils/glucose/meal-pharmacodynamics.ts`,
`mobile/utils/activity/activity-pharmacodynamics.ts`) and in JavaScript
(`frontend/src/utils/insulinPharmacodynamics.js`,
`frontend/src/utils/mealPharmacodynamics.js`,
`frontend/src/utils/activityPharmacodynamics.js`) — **by design**. That is a
recognised verification strategy, but it only *is* verification when something
compares them.

```
python -m diatwin.verify.parity generate    # shared case file
python -m diatwin.verify.parity python      # Python side
cd mobile && npx jest __tests__/parity      # TypeScript side
node diatwin/verify/frontend_eval.mjs       # frontend side
python -m diatwin.verify.parity compare     # exit 1 on NEW divergence
python -m diatwin.verify.parity baseline    # re-record known divergences
```

Every side reads the same `cases.json` with profiles **embedded**, so a stale
constants export cannot be mistaken for a model difference. 1,578 cases across
six families, evaluated by all three. No side judges; `compare` is the single
definition of agreement.

All three **pairs** are compared rather than nominating a reference
implementation. This is what the third side buys: with two implementations a
disagreement says only that they differ, and picking which to edit is an
opinion. With three, a case where two agree and one does not names the side
that stands alone.

| Family | Compares | Cases | py\|ts | py\|fe | ts\|fe |
|---|---|---:|---|---|---|
| `activity` | `calculate_insulin_activity` | 161 | 3.9e+01 (baselined) | 1.4e-14 | 3.9e+01 (baselined) |
| `iob` | `calculate_iob` | 805 | 1.2e+00 (baselined) | 7.1e-15 | 1.2e+00 (baselined) |
| `meal_act` | `calculate_gamma_absorption` | 108 | 2.8e-14 | 2.8e-14 | 2.8e-14 |
| `meal_abs` | `calculate_absorbed_fraction` | 108 | 5.6e-16 | 2.2e-16 | 5.6e-16 |
| `act_bg` | acute exercise BG effect (Y/Z/W ODE) | 198 | 0.0 | 0.0 | 0.0 |
| `act_aob` | activity on board (Y/Z/W ODE) | 198 | 0.0 | 0.0 | 0.0 |

**Python and the frontend agree on every one of the 1,578 cases**, to machine
precision. Every divergence in the harness is the mobile client against the
other two, and all of it is the insulin split in §5.1. The activity cases span
three intensity tiers, four durations, nine elapsed times, four patient
weights, non-default heart-rate reserves, both BG directions, the
wearable-trace path and the CGM-override path.

`HR_MODEL` cannot be embedded as a case *input* — no implementation accepts the
ODE parameters as arguments; each reads its own constants. It is embedded as a
checksum instead, and every side asserts its own copy matches before
evaluating. A desync then fails as a sync problem rather than surfacing as a
model difference.

### 5.0.1 The frontend evaluator

`frontend/` is a Create React App project whose only test runner is
`react-scripts test`. Installing that toolchain to evaluate 1,578 arithmetic
cases would make the third side the most expensive to run, in CI most of all.
The three frontend modules contain no React, so Node runs them directly, with
no npm packages and two narrow shims:

- `activityPharmacodynamics.js` imports `'../constants/shared_constants'` with
  no extension. Webpack resolves that; Node's ESM resolver does not. A
  `module.registerHooks` resolve hook appends `.js` rather than editing the
  shipped source, so the harness adapts to the code under test.
- `mealPharmacodynamics.js` reads `window.DEBUG_ABSORPTION_PROFILE`.
  `globalThis.window = {}` makes that `undefined`, exactly as a browser with
  the flag unset does. It gates a `console.log` and nothing else.

Neither shim touches a number. Both need **Node ≥ 22.15**, which the evaluator
checks and reports before it reaches a syntax error inside a source file.

### 5.0 The baseline gate

`fixtures/baseline_divergences.json` records the case ids known to diverge,
**keyed by pair**. `compare` exits non-zero only for divergence **not** listed
under that pair, and reports baselined cases that have started agreeing so the
file can shrink. Without it the job would be red on every run because of §5.1,
and a gate that is always red stops being read.

Divergence is a property of a pair, not of a case. A case accepted between
Python and the mobile client says nothing about the frontend, and keying the
file on case id alone would silently grant one decision to all three pairs. A
file written before the frontend existed — a flat `cases` list — is still read
as exactly what it could only have meant, python-versus-typescript.

`diatwin/tests/test_parity_harness.py` covers the machinery — that baselining
one case does not excuse another, that baselining a case for one pair does not
excuse it on another, that every pair really is compared, that the odd-one-out
summary names a side only when there is one to name, that a family disappearing
from the case file is reported as a set mismatch rather than as agreement, that
a missing frontend result exits 2 rather than passing on the two sides that did
run, and that the committed baseline contains only insulin cases.

### 5.1 Current state: 205 of 1,578 diverge, all of them insulin

Four of seven insulin types agree to machine precision (worst 1.8e-15). Three
do not, and the split tracks `curve_type` rather than insulin.

| Cause | Python | TypeScript | Affected |
|---|---|---|---|
| Gamma middle branch keys on disjoint name sets | `curve_type in ['gamma_moderate','gamma_standard']` → α 4.5 | `curveType === 'gamma_broad'` → α 4.5 | 5 insulins |
| Ultra-long detection | `insulin_type == 'ultra_long'` | `type === 'long_acting' && duration > 30` | 2 insulins |

The constants settle both. **No insulin carries `gamma_moderate` or
`gamma_standard`** — those are *meal* absorption curve names, so the Python
branch is dead and all five `gamma_broad` insulins fall through to α 3.0 where
TypeScript uses α 4.5. **No insulin has `type == 'ultra_long'`**, so Python's
ultra-long branch can never fire and degludec (42 h) receives standard phase
timings. Glargine at 23.5 h sits under the threshold either way, which is
exactly why it agrees.

Net effect: for `regular_insulin`, the three mixed insulins,
`combination_degludec_aspart`, `insulin_degludec` and
`insulin_glargine_u300` — 7 of 20 types — the backend and the mobile app
compute different activity curves for the same dose. Rapid-acting analogues
are unaffected, which is presumably why it never surfaced in use.

**The third implementation breaks the tie.** `frontend/src/utils/` agrees with
Python **exactly** on all 966 insulin cases — worst delta 1.4e-14 on the
activity curve and 7.1e-15 on IOB. Two independent implementations take the
Python reading of both branch conditions; the mobile client stands alone on
both. That is evidence about where an edit belongs, not proof of what is
clinically right — the α for a platykurtic intermediate-acting curve is a
pharmacokinetics question — but it settles which file is the outlier.

**Not yet fixed.** Correcting it changes clinical behaviour and deserves a
deliberate decision. The harness holds the line meanwhile: the same 205 case
ids are recorded under `python|typescript` and `typescript|frontend` in
`fixtures/baseline_divergences.json`, and `compare` fails on any divergence
outside it (§5.0). They are the only baselined cases, on any pair — every meal
and activity case agrees exactly, and `python|frontend` has **zero** divergence
across all 1,578.

---

## §6 Mobile suites

| Suite | Tests | Covers |
|---|---:|---|
| `cumulative-effects.test.ts` | pre-existing | The TS cumulative-effects stack |
| `aed-evc-integration.test.ts` | pre-existing | ActiveEffectsDisplay ↔ EffectsVisualizationChart |
| `__tests__/time-manager.test.ts` | 40 | TimeManager (§6.1) |
| `__tests__/meal-pharmacodynamics.test.ts` | 48 | The gamma absorption model (§6.2) |
| `__tests__/activity-pharmacodynamics.test.ts` | 58 | The Y/Z/W exercise model (§6.3) |
| `__tests__/blood-glucose-estimation.test.ts` | 54 | Baseline, cumulative and net effect (§6.4) |
| `__tests__/insulin-timeline-generator.test.ts` | 7 | The timeline's daily reset boundary (§6.5) |
| `__tests__/parity.test.ts` | 4 | The TypeScript half of §5 |

### 6.1 TimeManager

`mobile/utils/time/TimeManager.ts` had no coverage, and the five commits
preceding this work were all timezone adjustments. Two properties matter more
than any formatting helper:

- **Parsing is total** over the shapes the backend sends — epoch millis,
  `Date`, and three ISO variants all map to one instant, and junk never
  throws.
- **The daily reset lands at the configured hour in the patient's own
  timezone**, for every offset. That boundary decides which doses and meals
  count toward today's cumulative effects.

The reset is verified across nine offsets including India (+5:30), Nepal
(+5:45) and Chatham (+12:45), and `isWithinCurrentDay` is checked to agree
with `getDailyResetTime` to the minute on both sides of the boundary. All
pass.

### 6.2 Meal pharmacodynamics

`mobile/utils/glucose/meal-pharmacodynamics.ts`. Property assertions —
conservation (`absorbed + remaining == total` at every point of every profile),
boundedness, the ordering of the five shipped profiles, and that carb
extraction is total over the shapes the backend sends while leaving legitimate
data alone: a pre-computed `total_carb_equiv` is never recomputed, and a
fibre-heavy item never eats another item's carbohydrate.

`parseMealTimestamp` is the module's single timestamp parser, used by
`calculateMealActivity`, `isMealActive` and `calculateStackedMealEffect`. It
accepts epoch ms, `Date`, numeric strings, and ISO with or without a zone, and
returns `NaN` for anything else. **D10** was the absence of exactly this: the
logic existed inside the stacked-effect reset guard while the other two sites
did a plain `new Date(meal.timestamp)`, so a numeric string read as a fully
absorbed meal and a bare ISO string shifted every figure by the device's UTC
offset. Fixed.

Three model properties are pinned because they are surprising and shared with
Python: the activity curve's maximum is a **plateau ending at `peak_hours`**,
not a point at it; activity is **truncated** at `duration_hours` rather than
tapering (`very_slow` still carries more than half its peak when the window
closes); and `calculateAbsorbedFraction` takes a **backward step of up to
1.4e-3** near the tail, because the quadrature grid changes with the
integration limit.

### 6.3 Activity pharmacodynamics

`mobile/utils/activity/activity-pharmacodynamics.ts`. Sign discipline
(`bg_direction` is the only thing that decides direction; every magnitude is
unsigned), saturation bounds, AOB conservation, and the allometric weight
scaling.

Two model properties are pinned. **The acute BG effect does not depend on
intensity** — `Z` is a binary gate that saturates in one Euler step, so
intensity reaches only the sensitivity multiplier. And **that multiplier
saturates at its cap for any session of 15 minutes or more**. Together: for
realistic session lengths the model does not distinguish a gentle walk from a
hard interval session in either channel. Both are shared with the Python
implementation and confirmed by the `act_bg` / `act_aob` parity families.

This module derives the daily reset from the patient's **local** calendar date
and agrees with TimeManager at every offset from −12:00 to +13:00. That is
asserted, and it is what makes the D9 comparison in §6.4 evidence rather than
opinion.

### 6.4 Blood-glucose estimation

`mobile/utils/glucose/blood-glucose-estimation.ts`. The reset boundary as the
sole scope rule, sign discipline, `baseline + cumulative == reading` as an
identity, monotonicity in elapsed time and in dose, and robustness against the
malformed API payloads the module is actually fed.

`getDoseTimestamp` returns an Invalid Date for a dose carrying none of the four
timestamp aliases, and callers drop the record through `isUsableDate`. An
unknown absorption type falls back to the **medium** profile in both
`calculateMealCumulativeEffect` and `calculateStableBaselineFromReading`,
matching `get_meal_absorption_profile()` in the backend.

Both were defects (**D11**, **D12**) and are fixed. D11 used to *throw*, losing
every other meal and dose in the same call — the whole dashboard rather than one
bad row. D12 used to fall back to *full* absorption in one function and *skip*
the meal in the other; since both are reached from `calculateNetEffect` on the
same data, the baseline was computed without the meal and the cumulative term
then added all of it.

One defect remains characterised rather than fixed, naming the line to change
when it is (rule 13):

| | |
|---|---|
| **D9** | `getDailyResetTime` anchors the reset day on the **UTC** calendar date, so for `timezone_offset_minutes > daily_reset_hour × 60` it returns a boundary exactly 24 h early for `offset_hours − reset_hour` hours of each day. Yesterday's meals and doses are counted in today's baseline. Same shape in the inline reset inside `calculateStackedMealEffect` and in `hooks/useActiveEffects.ts`. |

### 6.5 Insulin timeline generator

`mobile/utils/insulin/timeline-generator.ts`. Narrow by design: the daily reset
boundary and the cumulative "bank balance" that depends on it.

**D13** was here. The timeline computed its reset with `setHours` / `getHours`
and never read `timezone_offset_minutes`, so a patient's day rolled over at
their *phone's* reset hour. It now delegates to `TimeManager` (rule 16), which
makes Arm 1 §2.2's claim of device-timezone immunity true where it was not.

The suite asserts the boundary across ten offsets from −12:00 to +13:00, and
that two patients an hour apart get boundaries an hour apart — a difference the
old implementation could not represent at all. Both tests fail against the
pre-fix code, which is what makes them evidence.

There is deliberately **no** test that flips `process.env.TZ` and asserts the
output is unchanged. Under jest that assignment does not reset V8's cached
timezone, so such a test passes against the broken code as well — measured, and
deleted rather than kept.

---

---

## §7 Maintenance scripts

### 7.1 `backend/sweep_orphaned_meals.py`

Finds — and optionally removes — meals orphaned by the pre-2026-09-05 delete
handler (audit §1). Dry run by default; `--apply` refuses without `--export`.

**Most meals legitimately have no projection.** Nine call sites write to
`meals`; only `meal_insulin.py:830` creates a `meals_only` document, and only
for meals with food items that are not `blood_sugar_only` / `activity_only` /
`insulin_only`. A sweep keyed on "meal without a projection" would delete
every CGM reading, every standalone basal dose and every imported record.

One signal is unambiguous:

> `meals.meals_only_id` is **set**, and no `meals_only` document has that `_id`

`meals_only_id` is written in exactly one place, immediately after the
projection is created. The only code that deletes from `meals_only` also
deletes the meal. So a meal that recorded a projection which is now gone can
only have come from the old handler.

| Category | Meaning | Action |
|---|---|---|
| A | Recorded a projection; projection missing | **Deleted**, with cascade |
| B | Projection whose `meal_id` names a missing meal | Reported only |
| C | Qualified for a projection, never recorded one | Reported only |

The cascade removes the linked activity, blood sugar reading and medication
log. The medication log matters most: cumulative effects reads IOB from
`medication_logs`, so leaving that row would keep the phantom insulin.

22 tests cover the classification, most of them negative cases naming a
legitimate record shape the sweep must not touch.

---

## §8 Continuous integration

`.github/workflows/ci.yml`. Four jobs:

| Job | Runs |
|---|---|
| `foundation` | `pytest diatwin/tests -q` |
| `backend` | `pytest tests -q` with dummy `MONGO_URI` / `SECRET_KEY` |
| `parity` | generate → Python → TypeScript → frontend → compare |
| `mobile` | `tsc --noEmit`, then `jest` excluding parity |

Both Node jobs pin **Node 22**: the frontend evaluator needs
`module.registerHooks` (22.15) and ES module syntax detection for a package
with no `"type"` field (22.7), and on Node 20 it fails with a syntax error
raised from inside a shipped source file.

`pytest` and `mongomock` are declared in `requirements-dev.txt`, kept separate
from `backend/requirements.txt` so the foundation suite runs without the Flask
stack. The install pair is `backend/requirements.txt` + `requirements-dev.txt`.
The **root** `requirements.txt` is an unrelated `pip freeze` that pins a
conflicting `pytest` and contains neither Flask nor pymongo; CI has always used
the correct pair, and `SETUP.md` no longer points at the wrong one (D14).

---

## §9 Cross-Arm References

| Arm | Owns | Arm 5 relationship |
|---|---|---|
| Arm 0 | `main.py`, `config.py`, auth, schedulers | §2 stubs the schedulers and the Atlas ping. The blueprint registration order in `main.py` is enforced by the route-inventory duplicate check. |
| Arm 1 | `constants.py`, stored schemas, ingestion | §3 normalizes the shapes Arm 1 writes. §5 embeds Arm 1's pharmacokinetic profiles in the case file. §7's classification depends on the link fields documented in Arm 1 §12. |
| Arm 2 | `pharmacodynamics.py`, the TS calculation stack | §4 wraps Arm 2's kernel unchanged. §5 compares its three implementations pairwise. `test_pharmacodynamics.py` asserts Arm 2 §9's sign conventions. |
| Arm 3 | Charts, `useActiveEffects` | No dependency. Arm 3's components remain untested. |
| Arm 4 | `TimeManager`, services, stores | §6.1 covers `TimeManager`. The other services remain untested. |

---

## §10 Developer Rules

These are permanent invariants. They are stated as rules, not history.

**Layering**

1. `diatwin/data`, `diatwin/core`, `diatwin/sim` and `diatwin/verify` must
   import nothing outside the standard library and the Arm 2 kernel. Modelling
   dependencies belong under `diatwin/ml/` and in `requirements-ml.txt`. This
   is what keeps the whole foundation runnable in CI in under a second.

2. Raw Mongo documents must not travel past `diatwin/data/normalize.py`.
   Everything downstream consumes the types in `schema.py`.

**Time**

3. There is one time axis: aware UTC. `Event.__post_init__` rejects naive
   datetimes at the boundary. Local wall-clock is derived from
   `tz_offset_min` and never stored as a second source of truth.

4. The kernel's convention is timezone-*naive* UTC. Conversion happens only in
   `diatwin/sim/patient.py`. No other module may strip or attach `tzinfo` on
   the way into the kernel.

5. `parse_time()` must return `None` for unparseable input, never the current
   time. A bad row silently becoming the newest record on a timeline is worse
   than dropping it.

**Leakage**

6. Any code producing a prediction or a training row for time `T` must read
   `timeline.as_of(T)`, which filters on `observed_at`. Filtering on `t`
   admits records that did not exist when the decision was made.

7. Missing values stay missing. `resample()` must not interpolate across a gap
   longer than `MAX_INTERPOLATION_GAP`, and `lag()` / `lead()` must not
   zero-pad.

**Insulin**

8. `dedupe_insulin()` must be applied to any load that reads both
   `medication_logs` and `meals`. Reading both raw doubles every bolus.

**Modelling**

9. Nothing is added to `diatwin/ml/` until it runs and is tested. The eleven
   zero-byte files under `docs/Clinical Validation/data files/ML/` are what
   happens when structure is committed before it does anything.

**Verification**

10. Two blueprints must never register the same rule and method. Flask permits
    it when endpoint names differ and silently routes to whichever registered
    first, leaving the second unreachable without any error.

11. The parity comparison is the single definition of agreement between the
    Python and TypeScript models. Neither language's test file may assert
    agreement on its own — each evaluates the shared cases and writes results;
    `compare` judges.

12. Pharmacokinetic profiles must be **embedded** in the parity case file, not
    looked up by name on each side. A stale constants export would otherwise
    be reported as a model difference.

13. A test that characterizes current behaviour must say so in its docstring
    and name the defect it pins. When it starts failing, that is the signal to
    update it to the new expectation — not to weaken it.

14. `sweep_orphaned_meals.py --apply` must never be made to work without
    `--export`. Deleting patient records without a backup is not an operation
    this repository offers.

15. `parity baseline` is run only after a deliberate decision about the
    divergence it records — accepting it, or confirming it is gone. Running it
    to quiet a red build converts the gate into a rubber stamp, silently and
    permanently. The baseline file is evidence of a decision, not a snapshot of
    the current state.

**Time**

16. There is one definition of the daily reset boundary:
    `TimeManager.getDailyResetTime`. It anchors on the patient's **local**
    calendar date, derived from `timezone_offset_minutes` — never on the UTC
    date and never on the device clock. The mobile client holds six
    implementations; three of them still anchor on the UTC date and are wrong
    east of +07:00 (D9). A reset computed any other way silently changes which
    day's doses and meals count, and no display makes that visible.
