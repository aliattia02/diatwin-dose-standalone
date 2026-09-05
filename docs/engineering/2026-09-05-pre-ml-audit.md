# Pre-ML audit: what would poison a training set

*Session report · 5 September 2026 · immutable once written*

---

## What this session was for

The infrastructure works. That is not the same as the data being trustworthy,
and a model trained on untrustworthy data looks excellent and is worthless. The
task was to find the gaps and errors that would corrupt a training set, before
anything is trained — and then to decide whether MongoDB should remain the
foundation for ML and RL.

The storage decision is a separate document:
[`2026-09-05-storage-layer-decision.md`](./2026-09-05-storage-layer-decision.md).
Short version: **stay on Mongo, keep training on Parquet snapshots, add DuckDB,
do not migrate.**

**The headline finding is not a bug. It is that the instrument this project
built to detect data loss cannot see the kind of data loss that actually
happens.** §4 is the evidence, and it is the section to read if you read only
one.

---

## 1. Baseline, verified before anything else

The handoff asked for this to be checked rather than trusted. It was accurate.

| | Claimed | Measured |
|---|---|---|
| Backend tests | 314 | 314 passed, 1 skipped ✅ |
| Foundation tests | 88 | 88 ✅ |
| Mobile tests | 328 | 328 ✅ |
| Mobile typecheck | 191 errors | 191 ✅ |
| Parity | 410 baselined, exit 0 | 410 baselined, exit 0, 0 new ✅ |

One environment note that cost ten minutes and is worth recording: the ambient
`python` on this machine has neither `flask` nor `bson`. Both suites need
`backend/venv/Scripts/python.exe`. `diatwin/tests` appears to be stdlib-only but
is not: `test_foundation.py::TestPatientSim` imports `diatwin/sim/patient.py`,
which imports `backend/constants.py`, which imports `bson`. Seven tests error
out under a bare interpreter. **Arm 5 rule 1 is violated transitively through
`diatwin/sim/`** — `data`, `core` and `verify` are clean; `sim` is not.

### State after this session

| | |
|---|---|
| Tests | **816** — 375 backend, 101 foundation, 340 mobile (was 730) |
| Parity | unchanged: 1,578 cases, 410 baselined, exit 0 |
| Mobile typecheck | **185** errors, now a **ratchet gate** in CI (was 191, always-red) |
| Drop rates | **measured** — §4 |
| Leakage | **verified over real data** — 286,195 windows, 0 violations |
| New defects | D17–D23; D20, D23 fixed |

---

## 2. Coverage: the two timed writers (A1)

`libre_service` / `libre_routes._perform_sync` and
`watch_sync_service._perform_sync` are the two paths that write clinical data on
a timer with nobody watching. Both had no tests. **38 were added**, mocking only
the HTTP boundary with `responses` (added to `requirements-dev.txt`), driving
`_perform_sync` directly since the schedulers are stubbed in `conftest.py`.

Three defects came out of writing them.

### D17 — the unique index turns a benign duplicate into a lost batch

`_save_single_reading` does find-then-insert. `db_indexes.py` adds
`unique_libre_cgm_reading` and documents it as what "makes that race harmless":

> the deduplication guarantee. `_save_single_reading` does a find-then-insert,
> which races when two processes sync the same user at once — and the scheduler
> runs once per gunicorn worker. This index is what makes that race harmless

It is not harmless. **`DuplicateKeyError` is caught nowhere in the codebase.**
The loser of the race raises out of `_save_single_reading`, out of the
`for r in readings` loop, and out of `_perform_sync`, discarding every reading
after the collision. The scheduler logs one warning per user and moves on.

Bounded, not catastrophic: the next cycle re-fetches and recovers, because
LibreLinkUp's graph endpoint returns a rolling window. But it is a documented
guarantee that does the opposite of what its docstring says.

Pinned: `test_libre_sync.py::test_a_duplicate_that_reaches_the_unique_index_aborts_the_batch`.

### D18 — the 401 retry never re-authenticates

`_perform_sync` catches `LibreTokenExpiredError`, writes a past `token_expires`
to Mongo, then calls `_get_valid_token(conn_doc, user_id)` and retries.

It passes the **in-memory** `conn_doc`, which the caller loaded *before* that
write and which still carries the original future expiry. So `needs_refresh` is
`False`, the same stale token comes straight back, and the retry re-sends the
identical failing request.

Measured, not inferred: **zero calls to the login endpoint**, two identical GETs
carrying `Bearer token-still-good`.

The saving grace is accidental. The Mongo write is the *only* useful effect, and
the next scheduler cycle reloads the connection, sees an expired token, and
refreshes properly. So a token expiry costs one cycle rather than the stream.
That write looks like dead code — the line after it ignores the result — and
deleting it would turn a one-cycle delay into a permanently stopped CGM feed.
Both halves are pinned, deliberately.

### D19 — the watch sync duplicates every overlapping activity session

`_perform_sync` re-fetches an overlapping window (`since = last_sync - 5 min`,
"to avoid gap on clock skew"), re-segments the overlap, and calls `insert_one`
unconditionally. There is no find-then-insert guard, and
`WATCH_INDEXES`'s `google_fit_activities_time_range` is **not** `unique`.

So a bout falling in the overlap is written once per sync that sees it. Not a
race — the ordinary path, every cycle.

This is the worst of the three for modelling. Activity is the smallest stream and
the one with the most leverage per row: two copies of one 20-minute bout read as
two bouts, and the exercise term is applied twice over the same interval.

Pinned: `test_watch_sync.py::test_the_same_window_synced_twice_duplicates_every_session`
(and a structural companion asserting no unique index exists, which will fail
loudly when D19 is fixed).

### Also found, not defects

- `get_readings` drops entries with no value and no parseable timestamp with a
  bare `continue` and **no counter and no log**. A malformed page is
  indistinguishable from a short one.
- `readings[-MAX_READINGS_PER_SYNC:]` silently discards the oldest of an
  oversized page, and the discard is **not** counted in `skipped_count`. The cap
  is 500 against a ~96-reading window, so it never fires in normal operation —
  it fires after an outage, when a backfill exceeds it, which is exactly when
  the data matters most.

---

## 3. Leakage discipline, executed rather than read (A3)

Rule 6 says anything producing a training row for time *T* must read
`timeline.as_of(T)`, which filters on `observed_at`.

**Verified over the real cohort**: 24 patients with glucose, **286,195 windows
built, 5,735 fully audited, 0 rule-6 violations**, in 607 s. A further 13 tests
in `diatwin/tests/test_leakage.py` cover the invariant, the late-entered-meal
case, and rule 7's gap handling.

The invariant holds. Two things about *why* it holds are not what the code
suggests.

**The `export_windows` guard is a tautology.** It raises when a target reading is
visible at its own decision time — i.e. when `observed_at < t`. Every normalizer
sets `observed_at = max(observed, t)`, so that condition **cannot hold for
anything that came through `normalize.py`**. The check is unreachable on its only
realistic input. It is worth keeping (it catches a hand-built timeline, and the
test proves it fires there) but it must not be read as evidence that the pipeline
was verified. The verification is the window loop.

**The guard's real dependency is `created_at`.** `normalize_meal` reads
`observed_at` from `created_at` and falls back to the event time when absent. The
backend does write it (`meal_insulin.py:785`), so this is latent — but it means
the leakage guard is exactly as good as that field's presence, and **nothing
checks**. Any future write path, bulk import or migration that omits `created_at`
silently converts a late-entered meal into one knowable when it was eaten, and no
test downstream would notice.

Rule 7 holds: no interpolation beyond `MAX_INTERPOLATION_GAP` (verified at the
boundary in both directions — 20 minutes exactly *is* interpolated, one step more
is not), no extrapolation outside the observed span, and `lag`/`lead` pad with
`None`, never zero.

---

## 4. Drop rates — measured, and the metric is the finding (A4)

This was the blocking item. `LoadReport` and `aggregate_reports` had never run
against real data because the deployed database holds one test user.

Both routes offered in the handoff were taken. `scripts/measure_drop_rates.py`
runs two passes and is stdlib-only — `MongoRepository` takes a database *handle*,
so a 30-line fake replaces a driver.

The AZT1D data is real subject data and is **not** in this repository. It was
read in place from the `native3` checkout via `--azt1d`; nothing was copied in
and nothing was committed.

### Pass 1 — the historical quirks, against known expectations

A synthetic corpus written deliberately in the shapes the collections have held:
all four `bloodSugarTimestamp` encodings, the insulin dual write, the
`meals`/`meals_only` split, and records that *should* be refused.

| stream | fetched | kept | dropped | expected | |
|---|---:|---:|---:|---:|---|
| glucose | 4,049 | 4,032 | 17 | 17 | ✅ (12 no-timestamp + 5 out-of-range) |
| insulin | 126 | 56 | 28 | — | 42 dual writes collapsed ✅ |
| meals | 84 | 42 | 42 | 42 | ✅ (14 zero-carb + 28 marker docs) |
| activity | 42 | 28 | 14 | 14 | ✅ (sedentary) |

**Every expectation matched exactly.** The quarantine boundary does what it
claims against input chosen to break it.

But note the shape of that table. `aggregate_reports` flags anything above 5%
with `<-- investigate`, and it flagged meals (50%), activity (33%) and insulin
(22%) — **all of which are entirely correct behaviour**. Marker documents and
sedentary rows *must* be refused. The 5% threshold is only meaningful for
glucose; for the other three streams the normal drop rate is dominated by
by-design refusals, so the flag is noise.

### Pass 2 — AZT1D 2025, 25 subjects, 306,712 rows

| stream | fetched | kept | norm-drop | fail% |
|---|---:|---:|---:|---:|
| glucose | 306,712 | 306,712 | 0 | 0.00% |
| insulin | 11,135 | 10,518 | 17 | 0.15% |
| meals | 4,471 | 4,471 | 0 | 0.00% |
| activity | 0 | 0 | 0 | 0.00% |

600 dual writes collapsed. A hypothesis that those 600 were *distinct* doses
merged by a 2-minute window matching only on `(patient, insulin_type)` was
tested and **was wrong**: all 600 pairs carry identical units, so they are true
duplicates in the source and `dedupe_insulin` handled them correctly. The latent
risk remains — the window ignores `units` — but it does not fire on this corpus.

### The finding

Getting to that table required writing a converter, and **the converter had two
bugs that the drop rate could not see.**

**Bug 1 — 60% of the insulin signal.** The first version branched on
`if bolus and not carbs:`. AZT1D writes a literal `"0"` in `CarbSize` on 14,463
rows, and `"0"` is a truthy string, so every one of those rows went down the meal
branch, where a zero-carb meal is discarded — taking its bolus with it.

**6,664 of 11,118 boluses lost. The `LoadReport` reported a 0.38% insulin drop
rate.** After the fix, insulin fetched went 4,471 → 11,135 and the reported drop
rate *fell* to 0.15%.

**Bug 2 — an entire subject.** 24 of the 25 AZT1D files name the glucose column
`CGM`. Subject 14 alone names it `Readings (CGM / BGM)` and orders its columns
differently. A converter keying on `CGM` produced **zero** glucose rows for that
subject — 13,003 rows, 4% of the cohort — with no error. **The glucose drop rate
read 0.00%** throughout, because a record that is never emitted cannot be counted
as dropped. Fixing it moved glucose from 293,709 to 306,712, exactly the missing
13,003.

Two independent losses — 60% of one stream, 4% of another — and every quality
metric read green for both.

**The conclusion is not that the converter was bad. It is that drop rate is the
wrong instrument for the failure that actually happens.** `LoadReport` measures
the ratio of records refused to records *offered*. Real data loss happens
upstream of "offered": a column named differently, a sentinel misread, a stream
never converted. A perfect drop rate for a stream is the most dangerous possible
reading, because it is what you get when nothing arrives at all.

`measure_drop_rates.py` therefore audits the **source** alongside the load, and
prints what the converter offers next to what is there. That table is the
artifact to read before training, not the drop rates.

### What the source audit shows

| column | rows with signal | converted? |
|---|---:|---|
| CGM | 306,712 | yes |
| CarbSize | 10,991 | yes |
| TotalBolusInsulinDelivered | 18,934 | yes |
| **Basal** | **200,889** | **NO** |
| **CorrectionDelivered** | **18,934** | **NO** |

- **200,889 basal rows are not represented at all.** This is an automated
  insulin delivery cohort: basal is modulated continuously by the pump algorithm
  and is a large fraction of total insulin. Any IOB computed from this
  conversion is badly wrong. This is the largest single data-fidelity gap and it
  is *not* a drop — it is an absence.
- **1,858 `DeviceMode == "exercise"` rows** are not converted, which is why the
  activity stream loads empty.
- **70 extended / dual-wave boluses** (`Extended 50.00%/15.49` and ~60 other
  spellings). The canonical schema has no representation for these: `InsulinDose`
  carries `units`, `insulin_type`, `dose_class`. Each is loaded as a single
  instantaneous dose, which front-loads its modelled action.
- **`sleepsleep`** appears 33 times as a `DeviceMode` — a corrupt enum in real
  data.
- Literal `"0"` strings: 5,262 in `DeviceMode`, 7,789 in `BolusType`. The trap
  that caused bug 1.

None of these are defects *in DiaTwin*. They are what a real corpus looks like,
and they are what has to be handled before this data trains anything.

---

## 5. The 191 TypeScript errors (A2)

### Triage, by root cause

| Cluster | Count | Kind | Order |
|---|---:|---|---|
| Victory chart `defined` prop not in the library's types | 13 | noise — one module augmentation | 1st (cheapest) |
| `Module has no exported member` (TS2305/TS2614) | 17 | mixed — imports that resolve to `undefined` at runtime | 2nd |
| `Property does not exist … Did you mean` (TS2551) | 12 | **real bugs** — see below | **do first anyway** |
| `Cannot find name 'InsulinDoseForStacking'` | 5 | type-only, erased at runtime | low |
| `Cannot find module` (TS2307) | 6 | mixed — includes `./mob`, which does not exist | 2nd |
| `Type not assignable` (TS2322/TS2345) | 44 | mostly shape drift between hand-written types and API responses | last, largest |
| `Object literal may only specify known properties` | 11 | shape drift | last |
| everything else | ~83 | assorted | last |

The 12 `TS2551` are the highest-yield cluster and the reason to read this list at
all: **each one names its own fix in the message**, and the register.tsx bug
reported six times today was one of them.

### D20 — the same `ValidationResult` bug in two more files (fixed)

`ValidationResult` carries `errors: string[]`. There is no `error`. Three call
sites read `validation.error`:

- `app/(auth)/register.tsx` — fixed earlier today; the reported bug
- `app/(auth)/forgot-password.tsx:42` — **still live**
- `components/forms/UnifiedInsulinInput.tsx:1017` — **still live**

Both remaining ones write `validation.error || '<generic>'`, so they are quieter
and in one respect worse than the register case: nothing looks broken, the
specific message is just silently replaced by a generic one.

In `UnifiedInsulinInput` that message is a dose-safety message. A patient
entering 150 units is told **"Invalid dose"**, when `validateInsulinDose`
composed **"Insulin dose 150 units exceeds maximum (100 units)"**. The
`warnings` channel ("unusually high. Please verify.") is not read at all by
either form.

Fixed in both, using the `errors.join('. ')` pattern register.tsx now uses.
6 tests in `mobile/__tests__/validation-result-shape.test.ts`.

### D23 — `getAvailableInsulinTypes` reads camelCase off snake_case (fixed)

`pharmacodynamics.ts:1368-1371` reads `value.onsetHours`, `peakHours`,
`durationHours`, `isPeakless` from an object declaring `onset_hours`,
`peak_hours`, `duration_hours`, `is_peakless`. All four are `undefined` at
runtime, while `id`, `name`, `displayName` and `type` are correct — which is why
it would survive a glance at the rendered list.

Latent: the only caller is `getInsulinTypesByCategory`, which nothing calls.
Fixed, with 6 tests that were **run against the pre-fix code and fail there**
(4 of 6 failed, `Expected "number", Received "undefined"`).

### The typecheck is now a ratchet, and was already a broken gate

The handoff recorded the typecheck as "not a gate". It was already a gate:
`.github/workflows/ci.yml` ran `npx tsc --noEmit` with no `continue-on-error`.
With 191 errors the mobile job **could not pass**.

A gate that can only ever be red is worse than no gate — it trains everyone to
ignore the job, which is precisely how a bug reported six times with the fix in
the message survived to reach a user.

`mobile/scripts/typecheck-ratchet.mjs` replaces it. It fails when the count
rises above `typecheck-baseline.json`, **and** when it falls without the baseline
being lowered, so the number can only go down. It attributes regressions per
file. Verified in both directions: a deliberately introduced error is caught and
named.

Count is now **185** (191 − 6 fixed), recorded as the baseline.

---

## 6. Model-level questions (A5), measured

Neither is caught by parity: all three implementations share both, so parity
proves the three agree, not that what they agree on is right. 23 tests in
`backend/tests/test_model_shape_defects.py`. **Nothing was changed** — both fixes
alter clinical behaviour and need a decision.

### D21 — `peak_hours` is not where the meal curve peaks

The gamma branch is `x**(k-1) * exp(-x/θ)` with `θ = scale_param × normalized_peak`,
normalised at `x = normalized_peak`. That density's mode is at `x = (k-1)θ`, so
mode and normalisation point coincide only when `(k-1) × scale_param == 1`.

Measured across all six shipped profiles:

| profile | onset | `peak_hours` | **true mode** | window clamped at 100 | jump at onset |
|---|---:|---:|---:|---:|---:|
| very_fast | 0.08 | 0.50 | **0.27** | 18.6% | −5.00 |
| fast | 0.25 | 1.00 | **0.62** | 21.7% | −5.00 |
| medium | 0.42 | 1.50 | **1.11** | 18.7% | −5.00 |
| slow | 0.75 | 2.50 | **1.80** | 24.9% | −4.99 |
| very_slow | 1.00 | 3.50 | **1.90** | **38.5%** | −2.70 |
| mixed | 0.25 | 2.00 | **1.23** | 22.1% | −4.96 |

`(k-1) × scale_param < 1` for every profile, so the mode always falls short of
`peak_hours` — by 1.6 h for `very_slow`.

Consequently the normalised curve exceeds 100 either side of the mode and is
clamped: **18.6% to 38.5% of every absorption window sits at exactly 100**, over
which absorption rate carries no information at all. (The handoff recorded
18–33%; `very_slow` measures 38.5%.)

**The discontinuity is confirmed and is a full 5 points.** Below onset the curve
is a linear ramp ending at exactly 5; at onset the gamma branch takes over and
starts at ~0, because `t**(k-1) → 0` for every `k > 1`. Absorption rate *drops*
by 5 percentage points at the instant gastric emptying completes — the opposite
of the physiology the profile describes.

### D22 — the acute exercise effect ignores intensity entirely

`dZ/dt = (1 − Z)` integrated with `dt = 1.0` minute sets `Z` to exactly 1 in a
single step, from any starting value. The equation has no intensity term: heart
rate decides only *whether* the gate opens, never how far.

Measured at 45 minutes, `hr_base` 60, `hr_max` 190:

| intensity | peak HR | Y | **Z** | W | **acute BG drop** |
|---|---:|---:|---:|---:|---:|
| light | 125.0 | 65.00 | **1.000000** | 2,567 | **6.4500000000** |
| moderate | 144.5 | 84.49 | **1.000000** | 3,338 | **6.4500000000** |
| vigorous | 164.0 | 103.99 | **1.000000** | 4,108 | **6.4500000000** |

Byte-identical. `light == moderate == vigorous`, difference exactly `0.0`.

Duration *is* honoured (15 min → smaller drop than 60 min), so this is not
"exercise does nothing" — it is specifically that intensity is discarded.

The information is present and unused: **Y and W both scale cleanly with
intensity**, so a fix has them to work from and needs no new input.

Dalla Man, Breton & Cobelli (*J Diabetes Sci Technol* 2009;3(1):56-67) drive
insulin-independent glucose utilisation from exercise intensity as %VO₂max above
rest, not from a binary gate. **Reshaping Z against that paper is a clinical
decision, not a code cleanup, and needs the primary literature and a clinician —
not more code.**

---

## 7. Smaller items (A6)

**`patch-zustand.js` — fixed.** It resolved `__dirname/../node_modules/zustand`,
which from `mobile/` is the *repository root*, which has no zustand. It ran on
every `npm install` as a `postinstall` hook and silently patched nothing.

The prior session's note that it is "currently unnecessary" needs one
correction: **zustand 5.0.9 does still contain `import.meta`**, in
`esm/middleware.mjs`. The web bundle is clean because Metro resolves the CJS
entry, not because the file is clean. Path fixed rather than deleted — the
failure it prevents is an opaque Hermes load error and the cost is one idempotent
scan per install. Mobile suite re-run after patching: 340 pass.

**The CORS-vs-cold-start message — fixed.** `client.ts` reported every
no-response error as a Render cold start. A CORS block is indistinguishable to
axios: no `error.response`, `code === 'ERR_NETWORK'`.

They *can* be told apart. A `fetch(..., { mode: 'no-cors' })` is dispatched
without requiring CORS response headers and resolves whenever the server is
reachable. So: probe resolves → the server answered and the CORS headers are the
problem; probe rejects → nothing answered, cold start or offline. Native keeps
the cold-start message, since there is no CORS there. The probe is diagnostic
only, runs after the request has already failed, and never throws.

**Root `requirements.txt` — left in place, and the prior finding stands.** I
initially read `README.md:12` as referencing it; that was wrong — `cd backend`
precedes it, so it resolves to `backend/requirements.txt` correctly. Nothing
references the root file. Confirmed unrelated: it shares 18 of 64 packages with
the backend manifest and contains **none** of flask, pymongo, gunicorn,
flask-cors, pyjwt, cryptography or apscheduler.

Two things found while checking:

- **`README.md` said `python app.py`; the file is `main.py`.** Fixed, and the
  venv and `.env` steps added to match `SETUP.md`.
- **`backend/requirements.txt` is UTF-16LE with a BOM**, as is the root file.
  `pip` handles it, so nothing is broken — but grep, diff, and most dependency
  scanners do not. `security-reports/supply-chain-audit-v2.md` says the root file
  "mirrors `backend/requirements.txt` exactly", which is false (18 of 64); that
  audit is dated and superseded rather than edited, so it is corrected here
  rather than there.

---

## 8. Defects

| | What | Status |
|---|---|---|
| **D17** | `DuplicateKeyError` uncaught; a CGM duplicate aborts the rest of the batch. The index's docstring calls the race "harmless". | **open**, pinned |
| **D18** | The `LibreTokenExpiredError` retry re-reads the stale in-memory `conn_doc` and never re-authenticates — measured, 0 logins. Recovers next cycle by accident. | **open**, pinned |
| **D19** | The watch sync has no deduplication and no unique index; the deliberate 5-min overlap duplicates every activity session in it, every cycle. | **open**, pinned |
| **D20** | `ValidationResult.error` read in `forgot-password.tsx` and `UnifiedInsulinInput.tsx`; the specific dose-safety message is replaced by "Invalid dose". | **fixed** |
| **D21** | `peak_hours` is not the curve's mode; 18.6–38.5% of each window is clamped at 100; a −5 pp jump at `onset_hours`. | **open**, pinned, needs a decision |
| **D22** | The acute exercise effect is byte-identical for light and vigorous. | **open**, pinned, needs a clinician |
| **D23** | `getAvailableInsulinTypes` reads camelCase off snake_case; four fields `undefined`. | **fixed** |

Still open from before: D2 (kept by decision), D3, D4, D5, D9.

---

## 9. What to do next, in order

1. **Fix D17 and D19.** Catch `DuplicateKeyError` and count it as a skip; add a
   unique index plus an upsert to the activity write path. ~10 lines, and it is
   the only thing the storage-layer analysis found Postgres scoring strictly
   higher on.
2. **Install `pyarrow` in the environment that actually runs.** It is declared in
   `requirements-ml.txt` and was not installed — `export_snapshot` had never
   executed before this session. It works: 25 subjects → 4.8 MB in 4.5 s.
3. **Handle basal insulin.** 200,889 AZT1D rows are unrepresented. Until basal is
   in the timeline, IOB from this cohort is wrong, and no drop rate will say so.
4. **Decide D21 and D22.** Both are shape errors in the models, both are shared
   by all three implementations, and both change what a model learns. D22 needs
   the Dalla Man paper and a clinician.
5. **Check `created_at` presence in the normalizer** and surface it in
   `LoadReport`, closing the one real gap in the leakage guard.
6. **Fix D18**, or delete the retry branch and rely on the next cycle — but
   deliberately, and keep the Mongo write either way.
7. Work the typecheck ratchet down. Cheapest first: the 13 Victory `defined`
   errors are one module augmentation.
8. Carried, still unresolved: **D9**, the α = 4.5 insulin branch behind the 205
   baselined divergences, and `sweep_orphaned_meals.py`.

---

## 10. Honest limits of this audit

- **The live database is still empty.** Every drop rate above is measured against
  AZT1D via a converter written this session. It measures the normalizer and the
  converter, not the app's own write paths, which have never had real volume
  through them.
- **The 0.00% glucose drop rate is a statement about clean source data**, not
  evidence that the sync paths are lossless. D17 and D19 are the evidence that
  they are not.
- **`export_windows` is O(n²)** — `as_of` is O(n) and is called once per window.
  Measured: 500 → 0.04 s, 8,000 → 9.21 s, and the full 25-subject verification
  took 607 s. Fine for an audit, too slow for iterating on features. It needs a
  cursor-based `as_of` before it is used in a training loop.
- **Activity has no real-data coverage at all.** 1,858 exercise rows exist in the
  source and none are converted, so D19's duplication has not been measured
  against real bouts.
- **D22 cannot be resolved by code.** It needs the primary literature and someone
  qualified to say what the acute intensity response should be.
