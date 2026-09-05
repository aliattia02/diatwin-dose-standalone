# Next session — pre-ML audit, and choosing the storage layer

*Written 5 September 2026. Paste the whole of this file into a fresh session.*

---

This is the DiaTwin repository — a Type 1 diabetes digital twin. Flask +
MongoDB backend, Expo/React Native mobile client (also deployed to the web), a
React web frontend, and a pharmacodynamic kernel modelling insulin,
carbohydrate and exercise effects on blood glucose.

The system is **deployed and working end to end** as of today, on infrastructure
independent of the older `native3` project.

## Start here

Read `docs/engineering/README.md` first, then:

- `REPOSITORIES.md` — what this repository is and how it differs from the older
  copy. Read before assuming any file's history.
- `docs/engineering/arm5_verification_and_modelling.md` — **§10 is the
  project's invariants. Read it before writing code.**
- `docs/engineering/2026-09-05-three-way-parity.md` — the most recent session
  report: the web frontend joined the parity harness, and D14–D16.
- `docs/engineering/next-session-prompt.md` — the *other* open handoff. Its
  leads 2, 4 and 5 (meal-curve normalisation, exercise intensity, D9) are still
  unresolved and are **not** superseded by this one.
- `docs/3 Arms Doc/` — Arms 0–4. Treat as intent; `arm-docs-audit.md` records
  where they are known to be wrong.

## Current state

**Verify this table before trusting it.** A previous session was started
against a handoff whose task was already finished, and half of it was spent
discovering that. The commands are at the bottom of this file.

| | |
|---|---|
| Tests | 730 — 314 backend, 88 foundation, 328 mobile |
| Parity | 3 implementations, 1,578 cases, 6 families. 410 baselined (the same 205 insulin cases on two pairs). `python\|frontend` diverges **nowhere**. |
| Mobile typecheck | 191 errors. Not a gate. |
| Deployment | Render `diatwin.onrender.com` · Vercel `diatwin-ten.vercel.app` (the **mobile** app built for web) · Atlas `cluster0.99xtyir`, database `diatwin` |
| Database contents | **Essentially empty** — one test user, five indexes, no clinical data |
| Open defects | D2 (kept by decision), D3, D4, D5, D9 |

Working, verified today: Render backend, Atlas connection, CORS, the Vercel web
build, registration, login, index creation at startup.

## Standing decisions — do not re-litigate

- The deployment is a **closed test environment**. Access-control findings are
  recorded in tests, not escalated.
- **The three implementations of the models are deliberate architecture.**
  Python (`backend/utils/`), the mobile client (`mobile/utils/`) and the web
  frontend (`frontend/src/utils/`) each implement the pharmacodynamic models
  independently, for cross-validation and to let a model be swapped or
  instrumented on one surface without disturbing the others. **Do not propose
  merging or deleting any of them.** The parity harness is what turns the
  duplication into verification.
- `/api/bulk-import` is kept but intentionally non-functional. Fixing it would
  activate a dormant unauthenticated bulk-write endpoint.
- The 205 insulin parity divergences are **baselined**, not accepted as
  correct. `compare` fails on new divergence only.
- The **password policy is deliberately relaxed** for the testing phase
  (`mobile/utils/validation.ts`: 6 characters, no composition rule). The
  backend enforces nothing, so the client is the only gate.
  `__tests__/password-policy.test.ts` pins it so restoring it fails loudly.
- Do not commit or push anything unless asked.

## Conventions

- `diatwin/data`, `diatwin/core`, `diatwin/sim`, `diatwin/verify` import
  **stdlib only**. ML dependencies live in `diatwin/ml/` and
  `requirements-ml.txt`. `diatwin/data/repository.py` takes an injected database
  handle rather than importing a driver, which is what keeps this true.
- The kernel takes timezone-**naive** UTC; the canonical schema uses **aware**
  UTC. Conversion happens only in `diatwin/sim/patient.py`.
- A test pinning current (wrong) behaviour says so and names the defect. A test
  asserting a fix says that instead, and **must be shown to fail against the
  pre-fix code**.
- Prefer property assertions over pinned magic numbers. Exact cross-language
  values are the parity harness's job (rule 11).
- Reference docs (`armN_*.md`) describe current state and carry no history.
  Session reports are dated and immutable.

---

# The task

Two parts. Do them in order; the second depends on what the first finds.

## Part A — a rigorous audit before any model is trained

The infrastructure works. That is not the same as the data being trustworthy,
and a model trained on untrustworthy data looks excellent and is worthless.
**Find the gaps and errors that would poison training, before training.**

### A1. What is uncovered

Enumerate honestly, then prioritise by what would corrupt a training set rather
than by line count.

**Backend, no tests:**

| Module | Lines |
|---|---:|
| `backend/constants.py` | 2,137 |
| `backend/meal_insulin.py` | 1,444 |
| `backend/services/libre_service.py` | 588 |
| `backend/services/watch_sync_service.py` | 448 |

`libre_service.py` and `watch_sync_service.py` are the two paths that **write
CGM and heart-rate data into the database on a timer**. A fault in either is
silent until a patient reports missing data — and for modelling, silent data
loss is the worst possible failure. Both make outbound HTTP calls, so this
needs request mocking (`responses` or `respx`, added to
`requirements-dev.txt`). Cover at minimum: a successful sync, an auth failure,
a malformed payload, a partial page, a duplicate reading arriving twice, and
the per-user interval check. The schedulers are stubbed in `conftest.py` — test
the `_perform_sync` functions directly.

**Web frontend, no tests at all.** `frontend/src/utils/` is ~10,000 lines.
Three modules are covered by the parity harness; the rest by nothing:
`netEffectCalculationService.js` (1,768), `bloodGlucoseEstimationService.js`
(1,729), `ChartUtils.js` (1,450), `TimeManager.js` (1,355),
`insulinStackingAnalyzer.js` (1,117), `mealCalculationService.js` (897).

**Foundation:** `diatwin/core/grid.py` (200) and `diatwin/data/normalize.py`
(414) are covered indirectly by `test_foundation.py` but have no suite of their
own — and `normalize.py` is the quarantine boundary every training row passes
through.

### A2. The 191 TypeScript errors are hiding live bugs

This is not hypothetical. Today a user-facing bug — the registration form
silently refusing to submit with a blank error message — was sitting in those
errors, reported six times, in a form that named the fix:

```
app/(auth)/register.tsx(82,70): error TS2551: Property 'error' does not exist
    on type 'ValidationResult'. Did you mean 'errors'?
```

Triage them: group by **root cause**, not error code; separate real runtime
bugs from type-shape noise; propose an order to zero with the count each step
removes. At least one more known real one:
`getAvailableInsulinTypes()` at `mobile/utils/insulin/pharmacodynamics.ts:1368`
reads camelCase keys off snake_case objects, so four fields are `undefined` at
runtime. It is latent because nothing calls it.

**Then make `tsc --noEmit` a CI gate.** Today is the evidence for why.

### A3. Leakage discipline is written but not enforced end to end

Rule 6: anything producing a prediction or training row for time `T` must read
`timeline.as_of(T)`, which filters on `observed_at`, not `t`.

`diatwin/data/repository.py` and `diatwin/ml/export.py` were written this
session. `export_windows()` executes the guard rather than documenting it, and
raises if a target reading is visible at its own decision time. **Verify that
actually holds** — build windows over real data and check the invariant, rather
than trusting the code because it has a docstring.

Also check rule 7 in `grid.py`: missing stays missing, no interpolation across
a gap longer than `MAX_INTERPOLATION_GAP`, no zero-padding in `lag()`/`lead()`.

### A4. Drop rates are still unmeasured — and this is now blocking

`MongoRepository.load()` returns a `LoadReport` with per-stream `fetched`,
`kept`, `dropped_normalize` and `normalize_failure_rate`, and
`aggregate_reports()` prints a cohort table flagging anything above 5 %.

**None of it has run against real data, because the database is empty.** One
test user, no clinical records. So either:

- copy `docs/Clinical Validation/` in locally (AZT1D 25, real subject data,
  deliberately **not** in this repository — do not commit it), run the
  conversion pipeline, and measure; or
- generate a realistic synthetic corpus that exercises the four historical
  timestamp encodings, the insulin dual write, and the `meals` /
  `meals_only` split, and measure against that instead.

Say which you did. A high drop rate is the **finding**, not an error: it names
the stream that needs attention before a model is trained.

### A5. Model-level questions still open

Carried from `next-session-prompt.md`, unresolved, and each affects what a
model learns:

- **`peak_hours` is not where the meal curve peaks.** The gamma density's mode
  is always left of the normalisation point, so 18–33 % of each absorption
  window is clamped at 100.
- **The meal curve has a jump discontinuity of ~5 percentage points at
  `onset_hours`** — the pre-onset ramp ends at 5 and the gamma density starts
  at 0 because `t^(k-1) → 0` for `k > 1`. Absorption rate *falls* when onset
  completes. Shared by all three implementations, so parity will never flag it.
- **The acute exercise effect does not depend on intensity.** `Z` saturates in
  one Euler step, so a light 45-minute walk and a vigorous 45-minute session
  produce byte-identical BG drops. Check against Dalla Man, Breton & Cobelli
  (J Diabetes Sci Technol 2009;3(1):56-67).
- **D9** — the daily reset is 24 h stale east of +07:00, in three of six mobile
  reset implementations. **Ask before fixing**; it changes what a patient sees.
- **The α = 4.5 insulin branch** behind the 205 baselined divergences. Two
  implementations agree against the mobile client. What is left is the
  pharmacokinetics of a platykurtic intermediate-acting curve, not more code.

### A6. Smaller, found today and not yet resolved

- `mobile/patch-zustand.js` has **never run**: it looks for
  `<repo>/node_modules/zustand` but zustand is at `mobile/node_modules/zustand`
  (the script was written for `mobile/scripts/` and moved up a level). The web
  bundle contains zero `import.meta`, so it is currently unnecessary — decide
  whether to fix the path or delete the script.
- The API client reports a CORS block as `ERR_NETWORK` and then blames Render's
  cold start. That message cost a full diagnostic round trip today. Make it
  conditional on the absence of an `Access-Control-Allow-Origin` header.
- Root `requirements.txt` is an unrelated `pip freeze` (D14). Nothing
  references it. Deleting it is a separate decision.

## Part B — choose the storage layer for ML and RL

**Do not start here, and do not migrate anything without a written case.**

The question: MongoDB is the operational store. Is it the right foundation for
supervised learning now and reinforcement learning later, or should this move
to Postgres (Neon, Supabase, Timescale) or something else?

### What has already been established — build on it, do not redo it

1. **The storage engine is already behind an interface.** Arm 5 rule 2: raw
   Mongo documents must not travel past `diatwin/data/normalize.py`.
   `repository.py` is the only file that touches a database handle, and it takes
   one by injection rather than importing a driver. Swapping engines is one
   file, not ninety-four routes.
2. **Training does not read the OLTP store.** `requirements-ml.txt` already
   declares `pyarrow  # parquet, for the feature store`, and
   `diatwin/ml/export.py` writes immutable, content-hashed Parquet snapshots
   with the drop report embedded in the manifest.
3. **Volume does not force the decision.** 25 patients × CGM at 5-minute
   intervals × 1 year ≈ 2.6M readings. Estimated at rest: ~800 MB as BSON,
   ~300 MB as Postgres rows, **~10–30 MB as compressed Parquet**. Both free
   tiers are 0.5 GB, so an engine swap buys months; the Parquet export is the
   actual answer.
4. **Offline RL wants trajectories, not tables.** `requirements-ml.txt` lists
   `d3rlpy  # offline RL (CQL/IQL) — train from logged data first`. Those are
   `(state, action, reward, next_state)` arrays built offline.

### What to actually evaluate

State the requirements first, then score candidates against them. At minimum:

- **Point-in-time correctness.** Rule 6 needs `observed_at` filtering to be
  cheap and hard to get wrong. Which engines make leakage *structurally*
  difficult rather than merely possible to avoid?
- **Reproducible snapshots.** Neon's branching gives a database frozen at a
  point in time per training run. Versioned Parquet gives the same guarantee
  more cheaply. Is branching worth an engine change on its own?
- **Windowed aggregation** for feature engineering — 5-minute grids with
  explicit gaps, lags and leads. SQL `generate_series` + `LEFT JOIN` versus
  `diatwin/core/grid.py`, which exists and is tested.
- **Write path.** Two schedulers, per-user syncs, and a unique partial index
  doing the deduplication (`unique_libre_cgm_reading`). What is the equivalent
  guarantee elsewhere, and what would be lost?
- **Migration cost, honestly.** 94 routes, the `mongomock` harness behind 314
  backend tests, the insulin dual write, four historical timestamp encodings,
  the `meals` / `meals_only` split — all on live clinical data.
- **Operational reality.** Free-tier limits, cold starts, backups, and who
  maintains it.

Candidates worth scoring, not a foregone conclusion: **stay on Mongo + Parquet
snapshots**; **Postgres** (Neon / Supabase / Timescale); **DuckDB** as a local
analytical layer over Parquet with no server at all; a **columnar store**
(ClickHouse) if the volume ever justifies it.

Deliver a recommendation with the reasoning, the migration cost if you
recommend moving, and the **trigger conditions** that should make the decision
be revisited. Write it as a dated document in `docs/engineering/`.

## Working style

- **Measure before you claim.** Several findings in recent sessions looked like
  bugs and turned out to be correct-but-undocumented once measured. Today one
  claim of mine ("the mobile app needs a porting project for web") was wrong and
  was corrected by actually running the build. If a test fails, establish
  whether the code or your assumption is wrong, then say which.
- **Negative cases matter more than positive ones.** A test proving the code
  leaves legitimate data alone is worth more than one proving the happy path.
- **A regression test that passes against the pre-fix code is not evidence.**
  Revert the fix, watch it fail, restore.
- When you find a real defect, characterise it with a test before fixing it,
  and check whether it appears in `docs/3 Arms Doc/` — three sessions running
  have each found a live bug sitting in the documentation as a contradiction.
- **Report honestly.** If something is uncovered or unresolved, say so rather
  than padding. If a question needs a clinician or the primary literature
  rather than more code, say that.

## Verify

```bash
cd backend && pytest tests -q            # 314 passed, 1 skipped
pytest diatwin/tests -q                  # 88 passed
cd mobile && npx jest                    # 328 passed
cd mobile && npx tsc --noEmit            # 191 errors, not yet a gate

python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
node diatwin/verify/frontend_eval.mjs    # needs Node >= 22.15, no npm packages
python -m diatwin.verify.parity compare  # exit 0, 410 baselined
```

`SETUP.md` takes a clean clone to a green run. Two gotchas: install
`backend/requirements.txt` + `requirements-dev.txt` (**not** the root
`requirements.txt`), and copy `backend/.env.example` to `backend/.env` first.

`parity baseline` re-records accepted divergences per pair. Rule 15: run it
only after a deliberate decision, never to quiet a red build.

## When you finish

Add a dated session report to `docs/engineering/` following the conventions in
its README, and update the "Current state" table there. If you change a model's
behaviour, update `arm5_verification_and_modelling.md` too — it is a reference
document and must describe the present, not the past.
