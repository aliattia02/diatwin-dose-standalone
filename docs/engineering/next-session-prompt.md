# Handoff Prompt — Next Testing & Analysis Session

Copy the block below into a fresh session. It is self-contained: a session with
no memory of 5 September 2026 can act on it.

Swap the **Task** section for one of the [variants](#variants) when you want to
push on something else.

---

## The prompt

```
This is the DiaTwin / native3 repo — a Type 1 diabetes digital twin. Flask +
MongoDB backend, Expo/React Native mobile client, and a pharmacodynamic kernel
that models insulin and carbohydrate absorption.

Read docs/engineering/README.md first. It is the entry point to the current
engineering state and links to Arm 5 (the verification and modelling
reference), an accuracy audit of the older arm docs, and a session report from
5 September 2026. Read Arm 5 §10 before writing any code — those are the
project's invariants.

CURRENT STATE
- 468 tests pass: 280 backend (backend/tests), 148 mobile (mobile, jest),
  40 foundation (diatwin/tests). All green.
- backend/tests/conftest.py has a working harness: mongomock, stubbed
  schedulers, and fixtures for patients/doctors/tokens/seeded data.
- diatwin/ is a stdlib-only package: canonical event schema, a normalizer that
  absorbs four historical timestamp encodings and the insulin dual write, a
  5-minute grid with explicit missingness, and the PD kernel wrapped as a
  forward simulator.
- diatwin/verify/parity.py compares the Python and TypeScript insulin models
  over 966 shared cases. 205 currently diverge — that is a recorded baseline,
  not a regression.
- mobile typecheck reports 194 errors and is not yet a gate.

STANDING DECISIONS — do not re-litigate these
- The deployment is a closed test environment. Access-control findings are
  recorded in tests, not escalated.
- The Python/TypeScript duplication of the insulin model is DELIBERATE —
  independent implementations for cross-verification. Do not propose merging
  them. The parity harness is what makes the design pay off.
- /api/bulk-import is kept but intentionally left non-functional (it raises
  NameError; routes/import_routes.py never imports current_app). Fixing it
  would activate a dormant unauthenticated bulk-write endpoint — a separate
  decision for later.
- The 205 parity divergences are baselined. CI fails on NEW divergence only.
- Do not commit or push anything unless I ask.

CONVENTIONS
- diatwin/data, diatwin/core, diatwin/sim, diatwin/verify import stdlib only.
  Modelling dependencies go in diatwin/ml/ and requirements-ml.txt.
- The kernel takes timezone-NAIVE UTC. The canonical schema uses AWARE UTC.
  Conversion happens only in diatwin/sim/patient.py.
- Tests that pin current (wrong) behaviour must say so in the docstring and
  name the defect. Tests that assert a fix must say that instead.
- Prefer property assertions over pinned magic numbers for the kernel —
  conservation, monotonicity, sign, boundedness. Exact cross-language values
  are the parity harness's job.
- Reference docs (armN_*.md) describe current state and carry no history.
  Session reports are dated and immutable.

TASK
Extend test coverage to the three uncovered mobile calculation modules, which
are ~2,500 lines with zero tests and feed the same displays the tested code
feeds:

  mobile/utils/glucose/blood-glucose-estimation.ts   1,059 lines
  mobile/utils/glucose/meal-pharmacodynamics.ts        747 lines
  mobile/utils/activity/activity-pharmacodynamics.ts   733 lines

For each: read it, work out what its invariants actually are, then write tests
in mobile/__tests__/ following the style of __tests__/time-manager.test.ts.
Where a module mirrors backend logic, check the two agree and extend
diatwin/verify/parity.py with a new case family rather than asserting
agreement inside the TypeScript test.

WORKING STYLE
- Measure before you claim. Several findings in the last session looked like
  bugs and turned out to be correct-but-undocumented behaviour once measured.
  If a test fails, first establish whether the code or your assumption is
  wrong, then say which.
- Negative cases matter more than positive ones. A test that proves the code
  leaves legitimate data alone is worth more than one proving it handles the
  happy path.
- When you find a real defect, characterize it with a test before fixing it,
  and check whether it appears in docs/3 Arms Doc/ — the last session found a
  live bug that had been sitting in the documentation as a contradiction.
- Report honestly. If something is uncovered, say so rather than padding.

VERIFY
  cd backend && pytest tests -q
  pytest diatwin/tests -q
  cd mobile && npx jest
  cd mobile && npx tsc --noEmit          # 194 errors, not yet a gate

When you finish, add a dated session report to docs/engineering/ following the
conventions in its README, and update the "Current state" table there.
```

---

## Variants

Replace the **TASK** block with one of these.

### A — Extend the parity harness

```
TASK
diatwin/verify/parity.py currently covers only the insulin model
(calculate_insulin_activity and calculate_iob). Extend it to the two other
surfaces where Python and TypeScript both implement the same mathematics:

  1. Meal absorption — calculate_meal_active_carbs / calculate_absorbed_fraction
     against mobile/utils/glucose/meal-pharmacodynamics.ts
  2. Cumulative effects and the daily reset —
     calculate_total_cumulative_effects against
     mobile/utils/calculations/cumulative-effects.ts

Keep the existing design: one shared cases.json with all inputs embedded (never
looked up by name on either side), each language evaluating and writing
results, and compare as the single definition of agreement. Add a tolerance
entry per new quantity in its own units.

Expect to find divergence. Report it the way the insulin result was reported:
group by whatever dimension the split tracks, then find the root cause in the
source rather than listing failing cases. Do not fix divergence without asking
— it changes clinical behaviour.
```

### B — Triage the TypeScript errors

```
TASK
mobile currently has 194 TypeScript errors, which is why `tsc --noEmit` is not
a CI gate. Triage them:

  1. Group by root cause, not by error code. Many will trace to a handful of
     shared type-shape problems.
  2. Separate real runtime bugs from type-shape noise. At least one is real:
     getAvailableInsulinTypes() at utils/insulin/pharmacodynamics.ts:1368-1371
     reads camelCase keys off snake_case objects, so four fields are undefined
     at runtime. It is currently latent because nothing calls it.
  3. Resolve the phantom shared/ package — mobile/package.json declares
     "@native/shared": "file:../shared" and two type files import from
     ../../shared/src/types, but no shared/ directory exists, so a clean
     npm install fails. Either restore it or remove the dependency.
  4. Propose an order that gets to zero, with the count each step removes.

Fix the real bugs. For the type-shape work, show me the plan before doing it
in bulk.
```

### C — Cover the sync services

```
TASK
backend/services/libre_service.py (587 lines) and
backend/services/watch_sync_service.py (447 lines) have no tests. They are the
two paths that write CGM and heart-rate data into the database on a timer, so
a fault in either is silent until a patient reports missing data.

Both make outbound HTTP calls, so this needs request mocking (responses or
respx against the existing pytest harness — add it to requirements-dev.txt).
Cover at minimum: a successful sync, an auth failure, a malformed payload, a
partial page, a duplicate reading arriving twice, and the per-user interval
check that stops the scheduler hammering the upstream.

The schedulers themselves are stubbed in conftest.py — test the _perform_sync
functions directly rather than through the scheduler.
```

### D — Start the ML data layer

```
TASK
Write diatwin/data/repository.py — the single Mongo read path for modelling.
Input: a patient id and a time range. Output: a PatientTimeline (see
diatwin/data/schema.py). Nothing else under diatwin/ may touch the driver.

It must use normalize_all() so the dual write is deduplicated and the four
timestamp encodings are collapsed, and it must surface the per-stream `dropped`
counts rather than swallowing them.

Then run it over the AZT1D 25 (docs/Clinical Validation/) and report the drop
rates per stream. A high drop rate is the finding, not an error — it says which
stream needs attention before any model is trained.

Open question to answer with evidence, not assumption: `meals` and `meals_only`
hold overlapping data. Work out which is authoritative for modelling, write the
reasoning down, and make the repository enforce it.

Note: this needs numpy/pandas only at the ml/ layer. The repository itself
should stay stdlib + pymongo.
```

---

## Before any of these

Two operational items from the last session are still open and are worth
clearing first, because both affect what the tests read:

1. **Run the orphan sweep.** Meals deleted before the 5 September fix left
   `meals` records and `medication_logs` rows behind, still inflating IOB.

   ```bash
   cd backend && python sweep_orphaned_meals.py                      # report
   cd backend && python sweep_orphaned_meals.py --export backup.json
   cd backend && python sweep_orphaned_meals.py --export backup.json --apply
   ```

2. **Push `.github/workflows/ci.yml`.** 468 tests that nothing runs are 468
   tests you will stop trusting.
