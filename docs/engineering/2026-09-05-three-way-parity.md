# Session report — the third implementation

**Date:** 5 September 2026
**Base:** `624e6e2`, clean working tree
**Scope:** lead 1 of [`next-session-prompt.md`](./next-session-prompt.md) — make the parity harness three-way

---

## What this was

`frontend/src/utils/` holds a third independent implementation of the
pharmacodynamic models — `insulinPharmacodynamics.js` (991 lines),
`mealPharmacodynamics.js` (682 at the start of this session, 696 now),
`activityPharmacodynamics.js` (517, now 545). The
parity harness had **zero references to any of them**. Two of three surfaces
were cross-checked; the web frontend was checked against nothing, and it has no
tests of its own.

That gap was hiding evidence. The 205 baselined insulin divergences come down
to two branch conditions, and the third implementation breaks the tie — but
only if something evaluates it.

---

## Results

| | Before | After |
|---|---:|---:|
| Backend tests | 280 | 280 |
| Mobile tests | 317 | 317 |
| Foundation tests | 59 | **65** |
| **Total** | **656** | **662** |
| Parity implementations | 2 | **3** |
| Parity comparisons | 1 pair | **3 pairs** |
| Parity evaluations | 3,156 | **4,734** |
| Mobile typecheck errors | 198 | 197 (see note) |

All green. `compare` exits 0.

The typecheck figure is 197 measured today, against 198 recorded on 5
September. Nothing in this session touched a mobile source or test file, and
the environment was installed fresh from `mobile/package-lock.json`, so the
difference is a dependency resolution, not work done here. It is recorded as
measured rather than reconciled.

Two defects were found by the new side, characterised, and — with a decision
taken first, because both change a displayed number — **fixed**. Two false
statements in documentation were corrected, one of which is the likely cause of
one of the defects. A third defect, in `SETUP.md`, blocked a clean clone
outright and is fixed.

---

## The tie-break, measured

```
where the disagreement sits:
    205  typescript disagrees with the other two              [activity, iob]
```

| Family | py\|ts | **py\|fe** | ts\|fe |
|---|---|---|---|
| `activity` | 3.9e+01 (baselined) | **1.4e-14** | 3.9e+01 (baselined) |
| `iob` | 1.2e+00 (baselined) | **7.1e-15** | 1.2e+00 (baselined) |
| `meal_act` | 2.8e-14 | 2.8e-14 | 2.8e-14 |
| `meal_abs` | 5.6e-16 | 2.2e-16 | 5.6e-16 |
| `act_bg` | 0.0 | 0.0 | 0.0 |
| `act_aob` | 0.0 | 0.0 | 0.0 |

**Python and the frontend agree on all 1,578 cases**, to machine precision.
Every divergence in the harness is the mobile client against the other two, and
the diverging case ids on `typescript|frontend` are *the same 205* as on
`python|typescript` — set equality, not merely the same count.

Arm 5 §5.1 inferred this from reading two branch conditions. It is now measured
over an embedded case file with no side judging itself. That does not establish
what α *should* be for a platykurtic intermediate-acting curve — that is a
pharmacokinetics question and still open — but it settles which file is the
outlier.

There were **no three-way splits and no tolerance-straddles**. Every
disagreement in 4,734 evaluations is one side against two, which is the
cleanest possible shape for this result.

---

## Design

The harness kept its existing shape: one shared `cases.json` with inputs
embedded, each side evaluating and writing results keyed by case id, and
`compare` as the single definition of agreement (rule 11). A third side meant a
third results file, not a redesign.

**All three pairs are compared** rather than nominating Python as the
reference. Choosing a reference in advance assumes the answer; comparing
pairwise and then reporting which side stands alone is what turns three
implementations into evidence rather than three chances to be wrong.

**The baseline is now keyed by pair.** Divergence is a property of a pair, not
of a case: a case accepted between Python and mobile says nothing about the
frontend, and keying on case id alone would silently grant one decision to all
three pairs. A file written in the two-sided shape — a flat `cases` list — is
still read as the only thing it could have meant, so the 205 remain evidence of
the Arm 5 §5.1 decision rather than something a tool restated.

### The frontend evaluator

`diatwin/verify/frontend_eval.mjs`, a plain Node script with **no npm
dependencies**.

`frontend/` is a Create React App project whose only runner is `react-scripts
test`. Installing that toolchain to evaluate 1,578 arithmetic cases would make
the third side the most expensive one to run, in CI most of all. The three
modules contain no React, so Node runs them directly, with two shims:

- `activityPharmacodynamics.js` imports `'../constants/shared_constants'` with
  no extension. Webpack resolves that; Node's ESM resolver does not. A
  `module.registerHooks` resolve hook appends `.js` **rather than editing the
  shipped source**, so the harness adapts to the code under test and not the
  reverse.
- `mealPharmacodynamics.js` reads `window.DEBUG_ABSORPTION_PROFILE`.
  `globalThis.window = {}` makes that `undefined`, exactly as a browser with
  the flag unset does. It gates a `console.log` and has no return.

Neither shim touches a number. Both need Node ≥ 22.15; the evaluator checks the
version and says so, because the failure otherwise is an opaque
`SyntaxError: Unexpected token 'export'` raised from inside a shipped source
file. Both CI Node jobs move from 20 to 22.

The `HR_MODEL` checksum assertion is implemented on this side too, so a stale
frontend constants export fails as a sync problem rather than surfacing as a
model difference (rule 12).

### The gate was verified in both directions

`test_every_pair_is_compared_not_just_two` perturbs one case on the TypeScript
side and then on the frontend side, and asserts that exactly the two pairs
containing the changed side report it. A three-way harness that quietly
compared only `python|typescript` would look identical from the outside until
the day the frontend drifted.

`test_a_missing_frontend_alone_exits_two` covers the failure this change could
have introduced: the third side going quiet while the other two still agree,
and the run looking green.

`test_the_odd_one_out_names_the_side_that_stands_alone` and
`test_three_mutually_different_values_are_not_blamed_on_one_side` cover the
summary in both directions — naming a culprit when there is none would be worse
than saying nothing, because it would send someone to edit an arbitrary file.

---

## Defects

Three. All three were measured before being called defects, and all three are
fixed.

| | | |
|---|---|---|
| **D14** | `SETUP.md` step 1 cannot succeed on a clean clone | **Fixed** |
| **D15** | Frontend `getActivityOnBoard` discards `bg_drop_override` | **Fixed** |
| **D16** | Frontend absorbed fraction uses a different quadrature rule | **Fixed** |

### D14 — the documented backend install fails

`SETUP.md` §1 said:

```bash
pip install -r ../requirements.txt -r ../requirements-dev.txt
```

That command **cannot succeed**. It exits with:

```
ERROR: Cannot install pytest==7.4.3 and pytest==8.3.4 because these package
versions have conflicting dependencies.
ERROR: ResolutionImpossible
```

The root `requirements.txt` is an unrelated `pip freeze` — OpenCV, pikepdf,
pytesseract, SQLAlchemy, uvicorn, starlette, trio — that pins `pytest==7.4.3`
against `requirements-dev.txt`'s `8.3.4`. It is also UTF-16LE encoded, which is
what a PowerShell `pip freeze >` produces, and it contains **neither Flask nor
pymongo**: even had it resolved, the backend could not have imported.

The correct manifest is `backend/requirements.txt`. `requirements-dev.txt`'s
own header comment says so ("Kept separate from `backend/requirements.txt`"),
and `.github/workflows/ci.yml` has always used the correct pair. `SETUP.md` was
the only place that pointed at the wrong file, and `SETUP.md` is the file a new
contributor runs first.

`SETUP.md` was marked "Tested end to end on 5 September 2026". It was not — or
not from an empty environment, which is the only test that counts for a setup
document.

**Fixed**, with a note naming the trap so the root file is not reinstated. The
root `requirements.txt` is left in place: nothing references it, and deleting
it is a separate decision.

### D15 — the frontend discards the CGM-measured drop

`frontend/src/utils/activityPharmacodynamics.js` `getActivityOnBoard()` had no
`bg_drop_override` branch, so CGM-confirmed sessions took the ODE path and the
measured magnitude was thrown away. Measured:

```
override=null  AOB at t=0,15,30,60min:  10.0  8.1  5.8  1.3
override=  25  AOB at t=0,15,30,60min:  10.0  8.1  5.8  1.3
override=  60  AOB at t=0,15,30,60min:  10.0  8.1  5.8  1.3
```

Byte-identical. A CGM-confirmed 60 mg/dL drop displayed as 10 mg/dL of activity
on board, while the backend API and the mobile app both said 60.

The stronger evidence is internal rather than cross-language.
`calculateActivityCumulativeEffect` **in the same file** does honour the
override. The two are complements — delivered plus remaining is the total:

| t (min) | delivered | remaining | sum | should be |
|---:|---:|---:|---:|---:|
| 0 | 0.00 | 10.0 | 10.00 | 60 |
| 15 | 10.71 | 8.1 | 18.81 | 60 |
| 30 | 21.43 | 5.8 | 27.23 | 60 |
| 45 | 32.14 | 3.6 | 35.74 | 60 |
| 60 | 42.86 | 1.3 | 44.16 | 60 |

**It was sitting in the documentation as a contradiction**, which is now the
third session running that this has happened.
`docs/documentation/activity-pd-implementation.md` §9 listed gap **D-1** as
open, located in `insulinCalculationService.ts`. Both halves were wrong:

- `mobile/utils/activity/activity-pharmacodynamics.ts` v1.2-ts records a
  **"React D-1 fix"** applied to *itself*. The gap was found in the React code,
  fixed on the mobile side, and the frontend was left alone.
- `computeSyntheticAOB()` in `mobile/services/insulinCalculationService.ts`,
  the function the doc names, consumes manually-entered `ActivityEntry`
  records, which carry no `bg_drop_override` field. There is nothing there to
  skip.

**Fixed** — an eleven-line branch, ported from the copy Python and mobile
already carry identically, so this is a missing port rather than a modelling
choice. `delivered + remaining` now holds to rounding:

| t (min) | delivered | remaining | sum |
|---:|---:|---:|---:|
| 0 | 0.00 | 60.0 | 60.00 |
| 30 | 21.43 | 38.6 | 60.03 |
| 60 | 42.86 | 17.1 | 59.96 |
| 84 | 60.00 | 0.0 | 60.00 |

12 of the harness's 198 `act_aob` cases failed against the pre-fix code and
pass now. The doc's D-1 entry is corrected and closed.

### D16 — three implementations, two quadrature rules

`calculate_absorbed_fraction` integrates the absorption curve with a **100-step
left-Riemann sum** in Python and in the mobile client, and used the
**trapezoidal rule** in the frontend — under a comment reading
`Uses trapezoidal rule (matches Python implementation)`, which was false. 84 of
108 `meal_abs` cases diverged.

**Where the frontend got it from.** Three places said Python was trapezoidal:

- `backend/utils/pharmacodynamics.py`'s own module docstring —
  "MOB (Meal On Board) / absorbed carbs via trapezoidal integration"
- `docs/3 Arms Doc/arm2_data_operations_reference.md` §, the
  `calculate_absorbed_fraction` row — "100-step trapezoidal integration"
- the frontend comment, presumably written from one of those

The confusion has a cause. `calculate_iob` in that same Python file **is**
trapezoidal — it weights its endpoints by 0.5 and sums `range(steps + 1)`.
`calculate_absorbed_fraction` does neither, and sums `range(steps)`. Two
integrals of the same kind in one file, two different rules, one docstring
claiming they are the same. Someone porting from the description rather than
the code would write exactly what the frontend had.

**Which rule is actually better — measured, not assumed.** Against composite
Simpson at 200,000 intervals on the same curve function:

| profile | left-Riemann | trapezoid | |
|---|---:|---:|---|
| very_fast | 3.85e-03 | 1.35e-03 | trapezoid 2.8× better |
| fast | 3.81e-03 | 7.15e-04 | 5.3× |
| medium | 2.90e-03 | 2.08e-04 | 13.9× |
| slow | 2.28e-03 | 8.72e-04 | 2.6× |
| **very_slow** | 2.42e-03 | **6.25e-03** | Riemann 2.6× better |
| **mixed** | 1.13e-03 | **1.26e-03** | Riemann better |

**Neither rule dominates.** That is not what "the trapezoid is the better rule"
would predict, and the reason is the finding below.

Worst practical effect of the divergence: 3.86e-03 in absorbed fraction —
0.386 percentage points of a meal, **0.93 mg/dL on a 60 g meal** at
`carb_to_bg_factor` 4.0. Below display precision, which is why nobody saw it.

**Fixed by aligning the frontend to the other two.** The alternative — moving
Python and mobile to the trapezoid — would change a clinical number on two
surfaces to gain under 1 mg/dL, and would be wrong on two of six profiles. The
alternative of baselining it would have blinded the gate on 84 of 108
`meal_abs` cases permanently, which is the worst of the three. Aligning makes
the accuracy question one deliberate decision applied to all three sides at
once, instead of an accident of which file you read.

The false statements in the Python docstring and Arm 2 are corrected.

---

## Measured, and not a defect

**The meal absorption curve has a jump discontinuity at `onset_hours`.**

| profile | very_fast | fast | medium | slow | very_slow | mixed |
|---|---:|---:|---:|---:|---:|---:|
| `A(onset)` | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 | 5.00 |
| `A(onset⁺)` | 0.00 | 0.00 | 0.00 | 0.01 | 2.30 | 0.04 |
| **jump** | **5.00** | **5.00** | **5.00** | **4.99** | **2.70** | **4.96** |

The pre-onset phase ramps linearly to 5 % (`(h / onset) * 5`). At `onset` the
gamma branch takes over, and `normalized_t <= 0` returns 5 — continuous so far.
One instant later `t^(k-1) → 0` for every profile with `k > 1`, so the curve
falls to zero. Absorption rate **drops** at the moment onset completes, which
is backwards for a model whose pre-onset ramp is meant to lead into absorption.

All three implementations share it — `meal_act` agrees to 2.8e-14 on every
pair — so it is a property of the model, not of any port. It is documented
nowhere.

It also explains D16's inconclusive result: the trapezoidal rule's advantage
assumes a smooth integrand, so which rule wins depends on where the
discontinuity falls relative to the grid. `very_slow` has the smallest jump
(k = 1.2) but the steepest rise afterwards — `d/dt t^0.2 → ∞` at the origin —
which is the other thing a trapezoid handles badly, and it is the profile where
the trapezoid loses by the widest margin.

This is the answer to lead 3's question "is `steps = 100` adequate": the step
count is not the binding constraint. Both rules sit within 6.3e-3 of the true
value, and the integrand's discontinuity is worth more than the choice of rule.
Raising `steps` would not fix a discontinuity.

---

## What was not done, and why

**D9 is untouched.** Still open, still characterised by tests in two suites.
Nothing in this session bore on it.

**The α = 4.5 branch is not changed.** The harness now shows two independent
implementations agreeing against the mobile client, which is evidence about
where an edit belongs — not about what the value should be. That needs the
pharmacokinetics of a platykurtic intermediate-acting curve, and possibly a
clinician. The 205 stay baselined.

**The quadrature rule is not changed on Python or mobile.** Only the frontend
moved, and it moved to match them, not because left-Riemann was judged correct.
Lead 3 is now answered as far as measurement can answer it, and what remains is
a decision about the discontinuity, which is a modelling question.

**The root `requirements.txt` is not deleted.** Nothing references it; removing
it is a separate decision from making `SETUP.md` correct.

**`frontend/src/utils/` still has no tests of its own.** The harness now covers
the three pharmacodynamic modules across 1,578 cases each. The other thirteen
files in that directory — `netEffectCalculationService.js` at 65 KB,
`bloodGlucoseEstimationService.js` at 63 KB, `ChartUtils.js` at 48 KB — remain
entirely uncovered.

---

## Suggested next

1. **Decide the α = 4.5 branch.** The evidence is now as strong as code can
   make it: two implementations against one, on 205 cases, with the branch
   conditions keying on disjoint name sets. What is left is the
   pharmacokinetics.
2. **Decide the onset discontinuity.** A 5-point step down in absorption rate
   at the end of the onset ramp is a model artefact, not a design. It is shared
   by all three implementations, so parity will never flag it. Resolving it
   would also settle the quadrature question, which is downstream of it.
3. **Decide D9**, unchanged from the previous session's recommendation.
4. Everything still open: run `sweep_orphaned_meals.py`, apply audit §6
   items 1–3, rotate the AZT1D credentials.

`.github/workflows/ci.yml` is **already pushed** — it is tracked at `624e6e2`
and `master` is level with `origin/master`. The previous two session reports
list "push CI" as open; it is not.

---

## Files

New

```
diatwin/verify/frontend_eval.mjs                  new — the third evaluator
docs/engineering/2026-09-05-three-way-parity.md   this report
```

Changed — harness

```
diatwin/verify/parity.py                 three sides, pairwise compare,
                                         per-pair baseline, odd-one-out summary,
                                         `frontend` subcommand
diatwin/tests/test_parity_harness.py     +6 tests (59 -> 65 foundation)
diatwin/verify/fixtures/
  baseline_divergences.json              per-pair shape; same 205 ids on two pairs
  cases.json                             regenerated, unchanged content
.github/workflows/ci.yml                 frontend step; Node 20 -> 22
```

Changed — source

```
frontend/src/utils/activityPharmacodynamics.js   D15 — override branch in
                                                 getActivityOnBoard; v1.1 -> v1.2
frontend/src/utils/mealPharmacodynamics.js       D16 — left-Riemann; v2.0 -> v2.1
backend/utils/pharmacodynamics.py                docstring corrected (no behaviour
                                                 change)
```

Changed — documentation

```
SETUP.md                                         D14; frontend parity step
docs/engineering/arm5_verification_and_modelling.md  §0 scope, §5, §5.0, §5.1, §8
docs/engineering/README.md                       current-state table
docs/3 Arms Doc/arm2_data_operations_reference.md    absorbed-fraction rule
docs/documentation/activity-pd-implementation.md     D-1 corrected and closed
```

Nothing was committed or pushed.

---

## Verify

```bash
cd backend && venv/Scripts/python -m pytest tests -q     # 280 passed, 1 skipped
venv/Scripts/python -m pytest diatwin/tests -q           # 65 passed
cd mobile && npx jest                                    # 317 passed
cd mobile && npx tsc --noEmit                            # 197, not a gate

python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
node diatwin/verify/frontend_eval.mjs
python -m diatwin.verify.parity compare                  # exit 0, 410 baselined
```

`parity baseline` re-records the accepted divergences per pair. Rule 15: run it
only after a deliberate decision, never to quiet a red build. The re-record
done in this session added the *same 205 case ids* to a second pair, verified
by set equality against the committed list, because the frontend agreeing with
Python necessarily makes them visible there too. No new case was accepted.
