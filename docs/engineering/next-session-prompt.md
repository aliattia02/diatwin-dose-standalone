# Next session — rigorous analysis of the logic and mathematics

*Written 5 September 2026. Paste the whole of this file into a fresh session.*

---

This is the DiaTwin repository — a Type 1 diabetes digital twin. Flask +
MongoDB backend, Expo/React Native mobile client, a React web frontend, and a
pharmacodynamic kernel that models insulin, carbohydrate and exercise effects
on blood glucose.

## Start here

Read `docs/engineering/README.md` first. It is the entry point: current state,
open defects, and links to everything else. Then:

- `REPOSITORIES.md` (root) — what this repository is and how it differs from
  the older `native3` copy. Read this before assuming any file's history.
- `docs/engineering/arm5_verification_and_modelling.md` — the verification
  reference. **§10 is the project's invariants. Read it before writing code.**
- `docs/engineering/2026-09-05-three-way-parity.md` — the most recent session:
  the frontend joined the parity harness, the 205 divergences resolved
  two-against-one, and D14–D16. Read this before the leads below; several are
  partly answered in it.
- `docs/engineering/2026-09-05-mobile-calculation-coverage.md` — the session
  before that: what was measured, what was fixed, what was deliberately not.
- `docs/3 Arms Doc/` — Arms 0–4, what the system *is*. Treat them as a
  statement of intent; `docs/engineering/arm-docs-audit.md` records where they
  are already known to be wrong.

`SETUP.md` takes a clean clone to a green test run. One gotcha: copy
`backend/.env.example` to `backend/.env` first, or the backend suite cannot
even collect.

## Current state

*This table goes stale. Verify it before trusting it — the run commands are at
the bottom of this file, and a session has already been started against a
handoff whose task was long finished.*

| | |
|---|---|
| Tests | 662 — 280 backend, 317 mobile, 65 foundation. All green. |
| Parity | **3 implementations**, 1,578 cases, 6 families, compared pairwise. 205 baselined on two pairs — the same 205, all insulin, all the mobile client against the other two. `python\|frontend` diverges nowhere. `compare` exits 0. |
| Mobile typecheck | 197 errors. Not a gate. |
| Open defects | D9 (below), plus D2–D5 from the earlier session. D14–D16 were found and fixed on 5 September. |
| CI | Pushed. `master` is level with `origin/master`. |

## Standing decisions — do not re-litigate

- The deployment is a **closed test environment**. Access-control findings are
  recorded in tests, not escalated.
- **The multiple implementations of the models are deliberate architecture.**
  The Python backend, the React web frontend (`frontend/src/utils/`) and the
  React Native mobile client each implement the pharmacodynamic models
  independently. This is for cross-validation, and to make later machine
  learning and reinforcement learning work easier to integrate — a model can be
  swapped or instrumented on one surface without disturbing the others. **Do
  not propose merging or deleting any of them.** The parity harness is what
  turns the duplication into verification rather than three chances to be
  wrong.
- `/api/bulk-import` is kept but intentionally non-functional. Fixing it would
  activate a dormant unauthenticated bulk-write endpoint.
- The 205 insulin parity divergences are **baselined**, not accepted as
  correct. `compare` fails on new divergence only.
- **The 25 AZT1D/HUPA study accounts still need rotating.** Their plaintext
  credentials are in `aliattia11/native`'s history. Not fixable from here.
- Do not commit or push anything unless asked.

## Conventions

- `diatwin/data`, `diatwin/core`, `diatwin/sim`, `diatwin/verify` import stdlib
  only. Modelling dependencies go in `diatwin/ml/` and `requirements-ml.txt`,
  and nothing is added there until it runs and is tested (rule 9).
- The kernel takes timezone-**naive** UTC. The canonical schema uses **aware**
  UTC. Conversion happens only in `diatwin/sim/patient.py`.
- A test that pins current (wrong) behaviour must say so in its docstring and
  name the defect. A test that asserts a fix must say that instead, and must be
  shown to fail against the pre-fix code.
- Prefer property assertions over pinned magic numbers — conservation,
  monotonicity, sign, boundedness. Exact cross-language values are the parity
  harness's job (rule 11: neither language asserts agreement on its own).
- Reference docs (`armN_*.md`) describe current state and carry no history.
  Session reports are dated and immutable.

---

# The task

**Attack the mathematics, not the plumbing.** The previous session established
that the code does what it says. This session asks whether what it says is
*right*: are the models dimensionally sound, numerically stable, internally
consistent across the three implementations, and faithful to the literature
they cite?

Coverage exists now. Correctness has not been established.

## Concrete leads, in priority order

These were found and measured but not resolved. Each is a real question with a
findable answer — start here rather than surveying.

### 1. Make the parity harness three-way

> **Done, 5 September 2026.** See
> [`2026-09-05-three-way-parity.md`](./2026-09-05-three-way-parity.md). The
> frontend agrees with Python on all 1,578 cases; the mobile client stands
> alone on the 205. Leads 2 and 3 below are partly answered there too — what
> remains of both is the onset discontinuity, which is a modelling decision.
> Leads 4 and 5 are untouched.

`frontend/src/utils/` holds the third independent implementation —
`insulinPharmacodynamics.js` (991 lines), `mealPharmacodynamics.js` (682),
`activityPharmacodynamics.js`. **The parity harness does not touch any of
them** (zero references). Two of three surfaces are cross-checked; the web
frontend is not checked against anything.

That gap is currently hiding evidence. The 205 baselined divergences come down
to a branch condition, and the third implementation breaks the tie:

| | α = 4.5 branch condition |
|---|---|
| Python `backend/utils/pharmacodynamics.py:404` | `curve_type in ['gamma_moderate','gamma_standard']` |
| Frontend `insulinPharmacodynamics.js:146` | `curveType === 'gamma_moderate' \|\| === 'gamma_standard'` |
| Mobile `mobile/utils/insulin/pharmacodynamics.ts:497` | `curveType === 'gamma_broad'` |

Python and the frontend agree **exactly**; the mobile client stands alone. And
per Arm 5 §5.1 **no insulin carries `gamma_moderate` or `gamma_standard`** —
those are *meal* curve names — so in Python and the frontend that branch is
dead and all five `gamma_broad` insulins fall through to α 3.0, where mobile
gives them α 4.5.

Two votes against one is evidence about where the edit belongs, not proof of
what is right. The question to answer is what α *should* be for a platykurtic
intermediate-acting curve, from the pharmacokinetics. But extending the harness
to three sides is worth doing regardless: it is the mechanism the architecture
was built for, and it currently covers two thirds of the surface.

The harness is designed for this — `diatwin/verify/parity.py` reads and writes
per-side result files keyed by case id, and `compare` is the single definition
of agreement. Adding a third evaluator means a third results file and a
three-way comparison, not a redesign.

### 2. `peak_hours` is not where the meal curve peaks

Measured: for every shipped absorption profile, the gamma activity curve
saturates at 100 % over a *plateau* ending exactly at `peak_hours`, opening
well before it (for `medium`, ~0.83 h against a configured peak of 1.5 h). The
gamma density's mode is at `(k−1)·θ`, always left of the normalisation point,
so normalising by the value at `peak_hours` pushes an interval above 100 and
the clamp flattens it. 18–33 % of each absorption window is clamped.

Is the normalisation wrong, or is `peak_hours` mis-named? All three
implementations agree, so parity will not catch it — this needs the
mathematics. The frontend was checked on 5 September and does **not** differ:
`calculateMealActivity` is line-for-line the same algorithm as Python's
`calculate_gamma_absorption`, and `meal_act` agrees to 2.8e-14 on every pair.

Related and newly measured: the curve has a **jump discontinuity of ~5
percentage points exactly at `onset_hours`** — the pre-onset ramp ends at 5 and
the gamma density starts at 0 because `t^(k-1) → 0` for `k > 1`, so absorption
rate falls at the moment onset completes. Shared by all three. Resolve it
alongside this lead; they are the same normalisation.

### 3. The absorbed-fraction integral is a left-Riemann sum on a moving grid

`calculate_absorbed_fraction` integrates 0→h with `dt = h/steps`, so the
quadrature grid changes with the integration limit. The result is not monotone
in h: measured backward steps of 1.4e-3 (`very_fast`), 1.1e-3 (`fast`),
6.7e-4 (`medium`).

**Substantially answered on 5 September.** Measured against composite Simpson
at 200,000 intervals, the left-Riemann sum is within **3.9e-03** of the true
absorbed fraction on the worst profile, and a 100-step trapezoid is within
6.3e-03. Neither rule dominates: the trapezoid wins on four profiles (13.9× on
`medium`) and loses on `very_slow` and `mixed`.

`steps = 100` is **not** the binding constraint. The integrand is not smooth —
see the onset discontinuity under lead 2 — and that is worth more than the
choice of rule. Raising `steps` would not fix a discontinuity.

The frontend had implemented a trapezoid, following a description of Python
that was wrong in three places; it was aligned to left-Riemann (D16) so the
question stays one decision applied to all three sides at once. What remains is
the discontinuity, which is lead 2's.

### 4. The acute exercise effect does not depend on intensity

`Z` obeys `dZ/dt = (1 − Z)` while in-exercise, so with `dt = 1 min` it
saturates to 1 in a single Euler step for any intensity clearing the onset
gate. The acute integral is `Z × acute_rate_per_min`, so a light 45-minute walk
and a vigorous 45-minute interval session produce **byte-identical** BG drops.
Intensity reaches only the sensitivity multiplier — which itself caps at +60 %
for any session of 15 minutes or more, at every tier.

For realistic session lengths the model cannot distinguish a stroll from a hard
workout in either channel.

Check against Dalla Man, Breton & Cobelli (J Diabetes Sci Technol 2009;
3(1):56-67), cited by `docs/documentation/activity-pd-implementation.md`. In
the source model, is the acute insulin-independent uptake term a binary gate,
or proportional to `Y`? Is `dt = 1 min` adequate for a rate constant of
1 min⁻¹, or is the Euler step aliasing a continuous rise into a step?

### 5. D9 — the daily reset is 24 h stale east of +07:00

Still open, characterised by tests in two suites. `getDailyResetTime` in
`blood-glucose-estimation.ts` anchors on the *UTC* calendar date rather than
the patient's local one; `getLastResetTime` only rolls back, never forward.
Condition: `timezone_offset_minutes > daily_reset_hour × 60`, affecting
`offset_hours − reset_hour` hours of each day.

Three of six mobile reset implementations have it. The fix is to consolidate on
`TimeManager` — `utils/insulin/timeline-generator.ts` already is, from D13's
fix. Remaining: `blood-glucose-estimation.ts`, the inline guard in
`meal-pharmacodynamics.ts`, `hooks/useActiveEffects.ts`, and
`utils/calculations/cumulative-effects.ts` (which re-exports the first).

Left open because it changes what a patient sees. **Ask before fixing.**

## Beyond the leads

- **Dimensional analysis.** Trace units end to end: `carb_to_bg_factor`
  (mg/dL per g), `correction_factor` (mg/dL per U), `acute_rate_per_min`
  (mg/dL per min), `alpha`. `calculateNetEffect` mixes an instantaneous *rate*
  (`totalActiveEffect`) with a cumulative *amount* (`totalBGElevation`); the
  code comments record two past bugs from exactly that confusion. Are the
  remaining uses consistent, on all three surfaces?
- **Conservation and boundedness** across the composed model, not per module.
  Can `estimatedBG` or `projectedFinalBG` go negative, or leave physiological
  range, under any admissible input?
- **Numerical stability.** Euler at `dt = 1 min` for Y/Z/W; the gamma log-form
  `exp((k−1)·ln t − t/θ)` near t→0; cancellation in `1 − IOB_fraction` for
  large doses.
- **Uncovered calculation code**: `mobile/utils/calculations/cumulative-effects.ts`,
  `hooks/useActiveEffects.ts`, `diatwin/core/grid.py`,
  `diatwin/data/normalize.py`, and the whole `frontend/src/utils/` tree.
- **ML/RL readiness.** The architecture exists partly to support later learning
  work, so the leakage discipline matters now, not later: rule 6 requires
  anything producing a prediction or training row for time `T` to read
  `timeline.as_of(T)`, which filters on `observed_at`, not `t`. Check that the
  canonical layer actually enforces it and that `resample()`/`lag()`/`lead()`
  honour rule 7 (missing stays missing; no interpolation across a gap longer
  than `MAX_INTERPOLATION_GAP`; no zero-padding). A model trained on leaked
  data will look excellent and be worthless.
- **Clinical plausibility.** Do the composed outputs land where a
  diabetologist would accept? `docs/Clinical Validation/` is **not in this
  repository** (real subject data, deliberately excluded) — copy it in locally
  from `native3` if needed, and do not commit it.

## Working style

- **Measure before you claim.** Several findings last session looked like bugs
  and turned out to be correct-but-undocumented once measured. If a test fails,
  first establish whether the code or your assumption is wrong, then say which.
- **Negative cases matter more than positive ones.** A test proving the code
  leaves legitimate data alone is worth more than one proving the happy path.
- **A regression test that passes against the pre-fix code is not evidence.**
  Revert the fix, watch the test fail, restore. Last session one such test was
  written, measured, found inert, and deleted rather than kept.
- When you find a real defect, characterize it with a test before fixing it,
  and check whether it appears in `docs/3 Arms Doc/` — the last two sessions
  each found a live bug sitting in the documentation as a contradiction.
- **Report honestly.** If something is uncovered or unresolved, say so rather
  than padding. If a question needs a clinician or the primary literature
  rather than more code, say that.

## Verify

```bash
cd backend && pytest tests -q            # 280 passed, 1 skipped
pytest diatwin/tests -q                  # 65 passed
cd mobile && npx jest                    # 317 passed
cd mobile && npx tsc --noEmit            # 197 errors, not yet a gate

python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
node diatwin/verify/frontend_eval.mjs    # needs Node >= 22.15, no npm packages
python -m diatwin.verify.parity compare  # exit 0
```

`parity baseline` re-records the accepted divergences. Rule 15: run it only
after a deliberate decision, never to quiet a red build.

## When you finish

Add a dated session report to `docs/engineering/` following the conventions in
its README, and update the "Current state" table there. If you change a model's
behaviour, update `arm5_verification_and_modelling.md` too — it is a reference
document and must describe the present, not the past.
