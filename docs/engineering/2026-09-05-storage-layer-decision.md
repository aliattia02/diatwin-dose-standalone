# Choosing the storage layer for ML and RL

*Decision record · 5 September 2026 · supersedes nothing; revisit under the
trigger conditions in §7.*

---

## Scope

Whether MongoDB should remain the foundation for supervised learning now and
reinforcement learning later, or whether the project should move to Postgres
(Neon, Supabase, Timescale) or something else.

This is a decision record, not a survey. §2 states the requirements, §3 scores
four candidates against them, §4 gives the recommendation, §5 the migration
cost that was avoided, §6 what is being given up, and §7 the conditions that
should make this be reopened.

Every number below was measured during the pre-ml audit
([`2026-09-05-pre-ml-audit.md`](./2026-09-05-pre-ml-audit.md)) against the
AZT1D 2025 cohort — 25 subjects, 306,712 rows. None of them are estimates.

---

## 1. What is already settled, and is not re-argued here

Four things were already true before this question was asked. They constrain
the answer more than any benchmark does.

**The storage engine is already behind an interface.** `diatwin/data/repository.py`
is the only file under `diatwin/` that touches a database handle, and it takes
one by injection rather than importing a driver. Arm 5 rule 2 forbids raw Mongo
documents travelling past `diatwin/data/normalize.py`. Swapping engines *for the
modelling path* is one file.

**Training does not read the OLTP store.** `diatwin/ml/export.py` writes
immutable, content-hashed Parquet snapshots with the drop report embedded in the
manifest. Models train against a snapshot, never against the live database.

**Offline RL wants trajectories, not tables.** `requirements-ml.txt` lists
`d3rlpy` for CQL/IQL. Those consume `(state, action, reward, next_state)` arrays
built offline from logged data. The engine that served the logs is invisible to
them.

**The three model implementations are deliberate.** Not in scope here.

---

## 2. Requirements

Stated before the candidates, so the scoring cannot be fitted to a preferred
answer.

| # | Requirement | Why it is a requirement and not a preference |
|---|---|---|
| **R1** | **Point-in-time correctness must be cheap and hard to get wrong.** | Rule 6: a training row for time *T* may read only records with `observed_at <= T`. This is the single failure that produces an excellent-looking, worthless model. |
| **R2** | **Reproducible snapshots.** A published result must name the data it came from and get the same numbers back. | Without it, "the model was worse this month" is unanswerable. |
| **R3** | **Windowed aggregation** — 5-minute grids with explicit gaps, lags and leads, where missing stays missing. | Rule 7. A grid that silently fills gaps teaches the model to predict the mean during sensor dropouts. |
| **R4** | **A write path with a deduplication guarantee.** | Two schedulers, per-user syncs, one gunicorn worker per process. Duplicate CGM corrupts every derived rate of change. |
| **R5** | **Migration must be affordable on live clinical data.** | 106 route decorators, 29 files touching `mongo.db`, a mongomock harness behind 375 backend tests, the insulin dual write, four historical timestamp encodings, the `meals` / `meals_only` split. |
| **R6** | **Operational reality.** Free-tier limits, cold starts, backups, and who maintains it. | This is a one-maintainer project. An engine nobody has time to operate is not a candidate. |

---

## 3. The candidates, scored

### 3.1 Volume does not decide this

Measured on the AZT1D cohort (25 subjects, ~9 months, 306,712 rows):

| Representation | Size | Per CGM row |
|---|---:|---:|
| BSON, as the app writes it | **55.0 MB** | 170 B |
| Parquet snapshot, zstd (all five streams + manifest) | **4.8 MB** | ~14 B |

Parquet is **11.4× smaller**, measured, not estimated. Extrapolating the
handoff's scenario — 25 patients × CGM at 5-minute intervals × 1 year ≈ 2.6M
readings — gives ~442 MB BSON and ~37 MB Parquet.

The Atlas free tier is 512 MB. So a full year of the current cohort fits with
room to spare, and the **compressed export is the answer to volume regardless of
which engine holds the operational store**. Volume is not an argument for
migrating; it is an argument for exporting, which is already built.

### 3.2 R1 — point-in-time correctness

This is the requirement that most tempts a Postgres answer, and it is the one
where the measurement was most surprising.

The claim "SQL makes leakage structurally difficult" does not survive contact
with the detail. A SQL schema makes `observed_at` a *column*; it does not make
`WHERE observed_at <= :t` mandatory. Nothing in Postgres refuses a query that
filters on event time. The structural protection has to live in the code that
builds windows, wherever the rows come from.

That code exists: `PatientTimeline.as_of()`. It was verified this session over
the real cohort — **286,195 windows built across 24 patients, 0 rule-6
violations** (`test_leakage.py`, and the run recorded in the audit §3).

Two qualifications, both found by measuring rather than reading:

- `export_windows`'s `raise` is **unreachable** for normalizer-produced data,
  because every normalizer clamps `observed_at = max(observed, t)`. It is a
  tautology on its only realistic input. The guard's strength is `as_of`, not
  that assertion.
- The guard's real dependency is that `created_at` is present on the source
  document. It is — but nothing checks, and any future write path that omits it
  silently converts a late-entered record into one knowable when it happened.

Neither is fixed by changing engines. Both are fixed by a check in the
normalizer, which is one file either way.

**Verdict: no engine wins R1. It is an application-layer property.** Timescale's
continuous aggregates and Neon's branching are attractive, but neither prevents
a feature builder from selecting on `t`.

### 3.3 R3 — windowed aggregation

`diatwin/core/grid.py` is 200 lines, stdlib-only, and now has its own tests
(13 in `test_leakage.py`, covering the `MAX_INTERPOLATION_GAP` boundary in both
directions and the None-padding of `lag`/`lead`).

The SQL alternative is `generate_series` + `LEFT JOIN`, which is genuinely
elegant — and which would have to reimplement "do not interpolate across a gap
longer than 20 minutes" and "never zero-pad a lag" in a dialect that makes both
easy to write wrong. Replacing tested Python with untested SQL to obtain a
property the Python already has is a cost with no matching benefit.

**Verdict: current implementation wins.** Postgres is capable; it is not better
here.

### 3.4 R4 — the write path

Mongo's partial unique index (`unique_libre_cgm_reading`) is the current
guarantee, and Postgres's equivalent — a partial `UNIQUE` index plus
`ON CONFLICT DO NOTHING` — is genuinely better in one specific way: it makes the
insert idempotent in a single statement.

That matters, because this session measured the current arrangement failing:

- **D17** — `_save_single_reading` does find-then-insert; `DuplicateKeyError` is
  caught nowhere in the codebase, so the loser of a race aborts the rest of the
  batch. The index's own docstring calls the race "harmless". It is not.
- **D19** — the watch sync has *no* deduplication at all, and
  `google_fit_activities_time_range` is not unique, so the deliberate 5-minute
  overlap duplicates every activity session that falls in it, on every cycle.

`ON CONFLICT DO NOTHING` would fix D17 for free and would have made D19 harder to
write. This is the one requirement where Postgres scores strictly higher.

But both defects are also fixed by ~10 lines of Python (catch
`DuplicateKeyError`; add a unique index and an upsert on `activities`). Buying a
migration to get an idempotent insert is not proportionate.

**Verdict: Postgres wins R4 on merit, by a margin far smaller than the migration
cost.**

### 3.5 R2 — reproducible snapshots

Neon's branching gives a database frozen at a point in time per training run.
That is a real capability and the strongest single argument for moving.

Versioned Parquet gives the same guarantee more cheaply, and it was verified
working this session: a 25-subject snapshot exports in **4.5 s** to **4.8 MB**,
identified by `<UTC date>-<12 hex of the content hash>`, with the per-stream drop
report and all 25 `LoadReport`s embedded in the manifest. A re-run over identical
data produces the same `snapshot_id` and refuses to overwrite.

A Neon branch cannot do the last part. It freezes bytes; it does not record what
was dropped on the way in, which is the thing an audit six months later actually
needs.

**Verdict: current implementation wins, and by more than expected.** Branching is
not worth an engine change on its own.

### 3.6 R5 — migration cost, honestly

| What would have to move | Measured |
|---|---|
| Route decorators | 106 |
| Files touching `mongo.db` | 29 |
| Backend tests behind the mongomock harness | 375 |
| `.aggregate()` pipelines in the entire codebase | **1** |

That last number is the interesting one, and it cuts *both* ways.

Only one aggregation pipeline exists. The operational store is used almost
entirely as a document key–value store addressed by `find`. So Mongo's query
model is earning very little — which weakens the case for keeping it on its
merits.

But it equally means the *schema* is doing the work, and the schema is where the
cost is: four historical timestamp encodings, the insulin dual write, the
`meals` / `meals_only` split, and heterogeneous documents where `mealType`
switches which fields are present. Normalising that into relational tables is
precisely the migration, and it would have to be done against live clinical data
with 375 tests pinned to a mongomock harness that has no Postgres equivalent.

**Verdict: high cost, and the cost is in the schema, not the driver.**

### 3.7 DuckDB

Worth naming because it is the candidate that is not a migration.

DuckDB reads Parquet directly with no server, no free tier, and no operational
burden. `SELECT ... FROM 'snapshots/<id>/glucose.parquet'` works today against
the 4.8 MB snapshot already produced. It gives the SQL windowing ergonomics that
make Postgres attractive for feature engineering, over the immutable snapshot
rather than over the live store — which is where that work belongs anyway.

It satisfies R6 completely: nothing to operate.

**Verdict: adopt as an analytical layer. It is additive and costs nothing.**

### 3.8 ClickHouse

Not a candidate at 55 MB. Reconsider at the volume in §7.

---

## 4. Recommendation

**Stay on MongoDB for the operational store. Keep training on versioned Parquet
snapshots. Add DuckDB as a local analytical layer over those snapshots. Do not
migrate.**

In priority order, the work this implies:

1. **Fix D17 and D19 in place** — catch `DuplicateKeyError` and count it as a
   skip; add a unique index plus an upsert to the activity write path. This buys
   the only thing Postgres scored strictly higher on, for about ten lines.
2. **Add `pyarrow` to the environment that actually runs.** It is declared in
   `requirements-ml.txt` and was **not installed**; `export_snapshot` had
   therefore never executed before this session. A foundation nobody has run is
   not a foundation.
3. **Check `created_at` presence in the normalizer** and record its absence in
   the `LoadReport`, closing the one real gap in the leakage guard (§3.2).
4. **Use DuckDB over the snapshots** for feature engineering, rather than
   writing a second query layer against Mongo.

The reasoning in one sentence: the modelling path already does not read the
operational store, so the engine under the operational store is not on the
critical path for ML — and the two things a migration would genuinely buy
(idempotent inserts, SQL windowing) are available for ten lines of Python and one
zero-cost dependency respectively.

---

## 5. What this decision does not claim

- **Not** that MongoDB is the better engine on merit. §3.6 shows the document
  model is earning almost nothing: one aggregation pipeline in the whole
  codebase. If this project were starting today with no data and no routes,
  Postgres would be the better default.
- **Not** that the current write path is correct. D17 and D19 are real, measured,
  and pinned by tests.
- **Not** that Parquet snapshots are sufficient for RL. They are sufficient for
  *offline* RL from logged data, which is the declared first step. An online
  loop with a live environment is a different question and is out of scope here.

---

## 6. What is given up

- **Idempotent inserts by construction.** Fixed by hand instead; the fix can
  regress, where `ON CONFLICT` could not.
- **Neon-style branching.** Replaced by content-hashed snapshots, which are
  better for audit and worse for "give me the whole database as it was".
- **SQL over live data.** Deliberately: feature engineering belongs over the
  snapshot, not the OLTP store.
- **Referential integrity.** Nothing prevents an orphaned meal today — and
  `backend/sweep_orphaned_meals.py` exists because orphans are already in the
  live database. A relational store would have prevented that class outright.
  This is the most substantive thing being given up.

---

## 7. Trigger conditions — revisit when any of these becomes true

| # | Trigger | Why it changes the answer |
|---|---|---|
| **T1** | The operational store passes **~350 MB** (measured, not estimated — 170 B per CGM document). | Approaching the 512 MB free tier. At that point the choice is a paid Atlas tier or an engine with a larger free tier, and migration is being paid for anyway. |
| **T2** | More than **5** distinct `.aggregate()` pipelines appear. | Today there is one. Real analytical load against the OLTP store means the document model has started costing rather than merely not helping. |
| **T3** | A second writer needs **transactional** multi-collection consistency. | The insulin dual write is currently reconciled after the fact by `dedupe_insulin`. A second such pattern should be a transaction, not another reconciliation. |
| **T4** | Orphaned or referentially broken records recur after `sweep_orphaned_meals.py` has been run. | Would demonstrate that the class of bug needs to be prevented structurally rather than swept. This is the trigger most likely to fire. |
| **T5** | RL moves from offline (d3rlpy over logged trajectories) to an online loop needing low-latency state reads. | Changes the read pattern the OLTP store must serve. |
| **T6** | The cohort passes roughly **500 patients**, or CGM sampling goes below 5 minutes. | ClickHouse and Timescale start earning their operational cost; today they do not. |

None of these is close to true. **T4 is the one to watch**, because the orphaned
records that motivate it are already in the live database.

---

## 8. Cross-references

- [`2026-09-05-pre-ml-audit.md`](./2026-09-05-pre-ml-audit.md) — the audit this
  decision rests on: the drop-rate measurement, the leakage verification, and
  D17–D22.
- [`arm5_verification_and_modelling.md`](./arm5_verification_and_modelling.md) —
  §10 rules 1, 2, 6 and 7, which are the constraints this decision honours.
