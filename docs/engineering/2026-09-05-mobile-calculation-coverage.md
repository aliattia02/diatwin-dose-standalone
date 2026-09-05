# Session report — mobile calculation coverage

**Date:** 5 September 2026
**Base:** `b8964b6`, working tree as left by [`2026-09-05-verification-pass.md`](./2026-09-05-verification-pass.md)
**Scope:** the three uncovered mobile calculation modules, and the parity harness

---

## What this was

Three modules in the mobile client computed numbers that reach the dashboard
and had no tests at all:

| Module | Lines |
|---|---:|
| `mobile/utils/glucose/blood-glucose-estimation.ts` | 1,059 |
| `mobile/utils/glucose/meal-pharmacodynamics.ts` | 747 |
| `mobile/utils/activity/activity-pharmacodynamics.ts` | 733 |

They feed the same displays as the code that *was* covered, which is the
argument for covering them: the tested and untested halves of the calculation
stack were not distinguishable from the outside.

Two of the three mirror Python in `backend/utils/`. Per Arm 5 rule 11, exact
cross-language agreement is the parity harness's job and is not asserted inside
the TypeScript tests. Both were added to the harness as new case families
instead.

---

## Results

| | Before | After |
|---|---:|---:|
| Backend tests | 280 | 280 |
| Mobile tests | 148 | **317** |
| Foundation tests | 40 | **59** |
| **Total** | **468** | **656** |
| Parity cases | 966 | **1,578** |
| Parity families | 2 | **6** |
| Mobile typecheck errors | 194 | 194 (see note) |

All green. The typecheck figure is unchanged: `npx tsc --noEmit` now reports
198, of which 4 are in `__tests__/time-manager.test.ts`, written in the
previous session and not counted in the 194 recorded then. The three new suites
and the rewritten parity test contribute **zero** typecheck errors.

Four defects — D10, D11, D12 and D13 — were characterised and then **fixed**.
D9 is characterised and left open; it changes what a patient sees and lands in
four places, so it is a decision rather than a cleanup.

Every one of the seven tests that assert a fix was run against the pre-fix code
and **fails there**. A regression test that passes either way is not evidence,
and one such test was found and deleted rather than kept (see D13).

---

## New parity families

The harness previously compared only the insulin model. It now compares four
more things, all with their inputs embedded per rule 12:

| Family | Compares | Cases | Worst delta |
|---|---|---:|---|
| `meal_act` | `calculate_gamma_absorption` | 108 | 2.8e-14 |
| `meal_abs` | `calculate_absorbed_fraction` | 108 | 5.6e-16 |
| `act_bg` | acute exercise BG effect (Y/Z/W ODE) | 198 | **0.0** |
| `act_aob` | activity on board (Y/Z/W ODE) | 198 | **0.0** |

**All four agree exactly.** The activity families are bit-identical across 396
cases spanning three intensity tiers, four durations, nine elapsed times, four
patient weights, non-default heart-rate reserves, both BG directions, the
wearable-trace path and the CGM-override path. The meal families agree to
machine precision, which is what should happen given Python evaluates
`t**(k-1)` and TypeScript evaluates `exp((k-1)·ln t)`.

That is a real result rather than a formality: the meal and activity ports were
never checked against the backend before, and they are correct.

The `HR_MODEL` ODE parameters cannot be embedded as case *inputs* — neither
implementation accepts them as arguments; both read their own constants. They
are embedded as a checksum instead, and each side asserts its own copy matches
before evaluating, so a stale constants export fails as a sync problem rather
than surfacing as a model difference.

### The baseline gate now exists

Arm 5 §5.1 said "CI fails on any *new* divergence, and the current 205 stand as
a recorded baseline." That was the intent; it was not implemented. `compare`
failed unconditionally on the 205, so the parity CI job would have been red on
its first run and would have stayed red — which is how a gate stops being read.

`compare` now loads `fixtures/baseline_divergences.json` and fails only on
divergence that is not recorded there. It also reports baselined cases that
have *started* agreeing, which is the signal to shrink the file. A new
`baseline` subcommand re-records it.

The gate was verified in both directions, not just asserted: perturbing one
case in each of the four new families makes `compare` exit 1; restoring them
makes it exit 0. `diatwin/tests/test_parity_harness.py` (19 tests) covers the
machinery — including that baselining one case does not excuse the next, that a
family disappearing from the case file is reported as a set mismatch rather
than as agreement, and that missing result files exit 2 rather than passing.

One test there asserts the committed baseline contains **only** insulin cases.
If a meal or activity case ever appears in it, something was baselined instead
of fixed, and that has to be a deliberate act.

---

## Defects

Five, each measured before being called a defect. Four are fixed; D9 is
characterised and left open.

| | | |
|---|---|---|
| **D9** | Daily reset 24 h stale east of +07:00 | **Open**, pinned |
| **D10** | `calculateMealActivity` bypasses its own timestamp parser | **Fixed** |
| **D11** | A dose with no timestamp throws and blanks the calculation | **Fixed** |
| **D12** | Unknown absorption type has two contradictory fallbacks | **Fixed** |
| **D13** | Insulin timeline resets on the device clock | **Fixed** |

### D9 — the daily reset boundary is 24 h stale east of +07:00

`getDailyResetTime` in `blood-glucose-estimation.ts` takes the **UTC** midnight
of the supplied instant and shifts it by the patient's offset, so the calendar
day it anchors on is the UTC one. `getLastResetTime` then only ever rolls that
candidate *back*, never forward. Once the patient's local date runs ahead of the
UTC date, the boundary returned is exactly one day early.

`TimeManager.getDailyResetTime`, the Python backend (which delegates to Python
TimeManager) and `activity-pharmacodynamics.ts` all anchor on the patient's
**local** date and are correct.

Condition: `timezone_offset_minutes > daily_reset_hour × 60`. The affected slice
of each day is `offset_hours − reset_hour` hours long. Measured:

| Offset | +08:00 | +09:00 | +10:00 | +12:00 | +13:00 | +14:00 |
|---|---:|---:|---:|---:|---:|---:|
| Stale hours per day | 1 | 2 | 3 | 5 | 6 | 7 |

The error is always exactly 24 h, never a partial shift. Offsets at or west of
+07:00 are never affected, which is why this has not surfaced in use.

**Effect.** Yesterday's meals and doses are counted in today's cumulative
baseline. Measured: a 60 g meal from the previous window contributes
213.6 mg/dL at +13:00 and 0 at −05:00, same clock, same meal.

**Spread.** Six reset implementations exist in the mobile client, in three
shapes:

| Site | Anchors on | |
|---|---|---|
| `utils/time/TimeManager.ts:1042` | patient-local date | correct |
| `utils/activity/activity-pharmacodynamics.ts:596` | patient-local date | correct |
| `utils/glucose/blood-glucose-estimation.ts:439` | **UTC date** | D9 |
| `utils/glucose/meal-pharmacodynamics.ts:541` (inline) | **UTC date** | D9 |
| `hooks/useActiveEffects.ts:1712` (inline) | **UTC date** | D9 |
| `utils/calculations/cumulative-effects.ts:368` | re-exports the above | D9, inherited |
| `utils/insulin/timeline-generator.ts:233` | patient-local date | **D13, fixed** — now delegates to TimeManager |

Pinned by `PINS D9` in the blood-glucose-estimation and meal-pharmacodynamics
suites. The activity suite asserts the *opposite* — that its own reset agrees
with TimeManager at twelve offsets from −12:00 to +13:00 — which is what makes
the comparison evidence rather than opinion.

### D10 — `calculateMealActivity` ignores the module's own timestamp parser

`calculateStackedMealEffect` normalises the meal timestamp before its reset
guard: a numeric-string fast path, and a `Z` appended to bare ISO. Its own
comment records that numeric strings were breaking the guard. The fix landed in
the guard only. `calculateMealActivity` (line 403) and `isMealActive`
(line 660) then do a plain `new Date(meal.timestamp)` on the same field.

Two live shapes are affected:

- **Numeric string** (`"1772366400000"`) → `Invalid Date` → `hoursSinceMeal` is
  `NaN`. Because `NaN < 0` is false, the result falls into the *expired* branch:
  a meal two hours into a four-hour absorption is reported fully absorbed, MOB 0.
- **Bare ISO with no zone**, which the backend "frequently" sends — the
  `parseUTCDate` docstring in `blood-glucose-estimation.ts` says so. `new Date`
  reads it as device-local, so every absorption figure shifts by the device's
  UTC offset. Measured on a UTC+1 device: MOB 6.6 g instead of 21.6 g,
  elevation 213.6 instead of 153.6 mg/dL.

This is the third appearance of a bug the repository has already fixed twice
(TimeManager v4.3, and `parseUTCDate`).

**Fixed.** The parser that existed inside `calculateStackedMealEffect` is now a
module-level `parseMealTimestamp`, used at all three sites. It returns `NaN`
for input it cannot place, so a bad row is dropped rather than mis-timed
(rule 5). Two tests assert it; both fail against the pre-fix code.

### D11 — one dose with no timestamp takes down the whole calculation

`getDoseTimestamp` throws for a dose carrying none of `administrationTime` /
`taken_at` / `takenAt` / `timestamp`, and nothing between it and
`calculateTotalCumulativeEffects` catches. A single malformed row in an API
payload loses every other meal and dose in the same call.

Every other record path in the module degrades instead: `parseUTCDate` returns
an invalid `Date` for junk, meals with no carbs return 0, and
`calculateStackedMealEffect` skips a meal it cannot parse. This was the only
path that threw.

**Fixed.** `getDoseTimestamp` returns an Invalid Date, and the four call sites
drop the record through a new `isUsableDate` guard. A malformed dose now
contributes 0 and every other record in the same call is unaffected —
asserted by comparing against the same call without the bad row. Three tests,
all failing against the pre-fix code.

### D12 — an unknown absorption type has two different fallbacks in one file

For a meal whose `absorption_type` is not a profile key:

- `calculateMealCumulativeEffect` falls back to **full** absorption,
  `totalCarbs × carb_to_bg_factor`
- `calculateStableBaselineFromReading` `continue`s, contributing **0**

Both are reached from `calculateNetEffect` on the same data. The baseline is
computed without the meal, then the cumulative term adds all of it, so the meal
is counted once with nothing subtracted. Measured: 200 mg/dL of divergence from
a single mislabelled 50 g meal.

**Fixed, and the backend settled which way.** Both Python functions call
`get_meal_absorption_profile`, which does
`absorption_profiles.get(absorption_type, absorption_profiles['medium'])` — an
unknown type is absorbed on the **medium curve**. Neither TypeScript branch
matched that; both do now.

So the answer was not "full" or "skip" but a third thing, and reading the
backend rather than picking one is what found it. The test asserts the
mislabelled meal now produces results identical to the same meal declared
`medium`, and that the baseline subtracts exactly what the cumulative term
adds — the property that was actually broken.

### D13 — the insulin timeline resets on the device clock, not the patient's

`utils/insulin/timeline-generator.ts:233` reads `daily_reset_hour` but never
reads `timezone_offset_minutes`, and uses `setHours` / `getHours` rather than
their UTC counterparts. It therefore resets at the reset hour in the *device's*
timezone.

Arm 1 §2.2 states: "All reset-time calculations use UTC Date methods
exclusively, making them immune to device OS timezone." That sentence was false
as written.

**Fixed.** The function now delegates to `TimeManager.getDailyResetTime`, so
there is one definition of the boundary rather than a re-derivation (rule 16),
and the `isExactlyAtReset` check compares in the patient's local time by
shifting and reading UTC fields. Arm 1 §2.2 is now true here.

`mobile/__tests__/insulin-timeline-generator.test.ts` is new (7 tests) and
covers the boundary across ten offsets from −12:00 to +13:00; two of its tests
fail against the pre-fix code.

One test was written, measured, and **deleted**: a test that flips
`process.env.TZ` between runs and asserts the output is unchanged. Under jest
that assignment does not reset V8's cached timezone, so it passed against the
broken code too. It would have asserted device-independence without checking
it, which is worse than not having it. The two multi-offset tests carry that
weight instead.

---

## Measured, and not defects

Four behaviours looked wrong and turned out to be correct-but-undocumented once
measured. Each is pinned so it is not rediscovered, and each is shared with the
Python implementation — the parity harness agrees on all of them, which is what
establishes they are properties of the model rather than of the port.

**The acute exercise effect does not depend on intensity.** A light 45-minute
walk and a vigorous 45-minute interval session produce byte-identical numbers at
every elapsed time. `Z` obeys `dZ/dt = (1 − Z)` while in-exercise, so with
`dt = 1 min` it saturates to 1 in a single step for any intensity clearing the
onset gate, and the acute integral is `Z × acute_rate_per_min`. Intensity only
changes peak HR, which feeds `Y` and `W` — so it reaches the *sensitivity
multiplier* and nothing else.

`docs/documentation/activity-pd-implementation.md` describes the gate ("Z is not
a smooth curve — it saturates to 1 within approximately one integration step")
but never states this consequence, and its intensity-fraction table implies the
acute drop scales with effort. Intensity is not ignored — it is a step function:
a patient whose HR reserve is too small for the tier to lift `Y` past
`a·hr_base` gets no acute effect at all, which is asserted as the counterpart.

**The sensitivity multiplier saturates for any session of 15 minutes or more.**
`max_sensitivity_boost` is 0.60 and `W` grows fast enough that a 15-minute
*light* session is already at the cap when it ends; for a 30-minute session all
three tiers sit at exactly 1.6 for the next 90 minutes. Combined with the above:
for realistic session lengths the model does not distinguish a gentle walk from
a hard interval session in either channel.

**The meal curve's maximum is a plateau, not a point.** The gamma density has
its mode before the configured `peak_hours` for every shipped profile, so
normalising by the value at `peak_hours` pushes an interval above 100 and the
clamp flattens it. The plateau ends exactly at `peak_hours`. For `medium` it
opens at ~0.83 h and runs to 1.5 h. `peak_hours` is where the curve is
normalised, not where it peaks.

**Absorbed fraction is not strictly monotone.** The integral from 0 to *h* uses
`dt = h/steps`, so the quadrature grid changes with *h*, and a left-Riemann sum
over a shifting grid is not monotone even for a non-negative integrand.
Measured worst backward step: 1.4e-3 (`very_fast`), 1.1e-3 (`fast`), 6.7e-4
(`medium`); `slow`, `very_slow` and `mixed` are monotone. This is the same
artefact as D6 in the previous session, now measured on the meal side. It is
asserted as a bound rather than fixed: raising `steps` would move every
absorbed-carb figure in the app for no clinical gain, and would have to move on
both sides of the parity harness simultaneously.

---

## What was not done, and why

**D9 was not fixed.** It is characterised by tests in two suites and left in
place.

The reasoning is the repository's own precedent. Arm 5 §5.1 records 205 parity
divergences as "not yet fixed — correcting it changes clinical behaviour and
deserves a deliberate decision", and D2 is kept by explicit decision. D9 changes
what a patient east of +07:00 sees on the dashboard, and the fix lands in four
places — one of them (`hooks/useActiveEffects.ts`) outside the modules in
scope, and one (`utils/calculations/cumulative-effects.ts`) a re-export that
would inherit it. Consolidating all four onto `TimeManager` is the right shape
of change and is a decision to take deliberately, not a cleanup to slip in
alongside test coverage.

The pinning tests are written so that fixing it is a one-line edit to the
expectation, and each carries a note naming the line to change.

D10, D11, D12 and D13 were fixed because none of them is a modelling choice:
D10 and D13 are timestamp handling with a correct implementation already in the
repository to call, D11 is a robustness failure with no upside, and D12 was
settled by reading the backend rather than by picking a side.

**Non-parity coverage of the insulin module was not extended.** It was already
covered by the parity harness and by `cumulative-effects.test.ts`.
`insulin-timeline-generator.test.ts` covers only the reset boundary, which is
what D13 touched.

---

## Suggested next

In this order:

1. **Decide D9.** Six reset implementations, three behaviours, one of them
   contradicted by an arm document until this session. Consolidating the
   remaining three onto `TimeManager` — as `timeline-generator.ts` now is —
   would remove the class of bug rather than an instance of it.
2. Correct Arm 1 §2.2's route-count and reset claims where the audit still
   lists them, and re-check §2.2 now that D13 has made its central sentence
   true.
3. Everything still open from the previous session: run
   `sweep_orphaned_meals.py`, push CI, apply audit §6 items 1–3, decide the 205
   parity divergences, rotate the AZT1D credentials.

---

## Files

Tests

```
mobile/__tests__/meal-pharmacodynamics.test.ts        new — 48 tests
mobile/__tests__/activity-pharmacodynamics.test.ts    new — 58 tests
mobile/__tests__/blood-glucose-estimation.test.ts     new — 54 tests
mobile/__tests__/insulin-timeline-generator.test.ts   new —  7 tests (D13)
mobile/__tests__/parity.test.ts                       rewritten — 6 families, 4 tests
diatwin/tests/test_parity_harness.py                  new — 19 tests
```

Source

```
mobile/utils/glucose/meal-pharmacodynamics.ts    D10 — parseMealTimestamp, used at 3 sites
                                                 export calculateGammaAbsorption
mobile/utils/glucose/blood-glucose-estimation.ts D11 — getDoseTimestamp degrades, isUsableDate
                                                 D12 — fall back to the medium profile
mobile/utils/insulin/timeline-generator.ts       D13 — delegate to TimeManager
diatwin/verify/parity.py                         4 new families, baseline gate
```

Fixtures

```
diatwin/verify/fixtures/cases.json                regenerated — 1,578 cases
diatwin/verify/fixtures/baseline_divergences.json new — the 205 insulin cases
```

Nothing was committed or pushed.

---

## Verify

```
cd backend && venv/Scripts/python -m pytest tests -q          # 280 passed, 1 skipped
venv/Scripts/python -m pytest diatwin/tests -q                # 59 passed
cd mobile && npx jest                                         # 317 passed
cd mobile && npx tsc --noEmit                                 # 198 (194 app + 4 pre-existing test)

python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
python -m diatwin.verify.parity compare                       # exit 0, 205 baselined
```
