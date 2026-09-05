# Session Report — Verification Pass & Modelling Foundation
**5 September 2026** · working tree only, nothing committed · HEAD `b8964b6`

```
================================================================
Objective
  1. Assess the project after ~3 years of development
  2. Clean the documentation folder
  3. Prepare the codebase for an ML step, and later an RL step
  4. Test current backend and mobile functionality rigorously
  5. Establish this engineering documentation area

Outcome
  468 tests passing, from 106
  8 defects found, 3 fixed
  New diatwin package: canonical data layer, grid, simulator, parity
  docs/ reduced from 2,933 files to 298 active
================================================================
```

---

## Table of Contents

- [§1 What was done](#1-what-was-done)
- [§2 Defects found](#2-defects-found)
- [§3 The parity result](#3-the-parity-result)
- [§4 Decisions taken](#4-decisions-taken)
- [§5 What is suggested next](#5-what-is-suggested-next)
- [§6 Files added and changed](#6-files-added-and-changed)

---

## §1 What was done

### 1.1 Documentation cleanup

`docs/` went from **2,933 files / 2.9 GB** to **298 active files / 165 MB**.
Nothing was deleted — 2,635 files moved to `docs/_draft/`, now gitignored,
with directory structure intact.

| Moved | Files | Size | Reason |
|---|---:|---:|---|
| `__MACOSX`, `.DS_Store`, `desktop.ini`, `~$` locks | 1,333 | — | Extraction and Office lock artifacts |
| Converted AZT1D JSON | ~100 | 1.15 GB | Regenerable via `scripts/step1…step4` |
| Per-day `Readings_*` renders | 1,159 | 862 MB | Regenerable; `Full_*` summaries kept |
| Two `.zip` archives | 2 | 749 MB | Content already extracted in place |
| Hash-verified duplicates | 4 | — | Canonical filename kept |
| Superseded `(1)`, `(2)`, `- Copy` versions | 10 | — | Newer sibling retained |
| `New folder/`, `unneded/`, `last update/`, `__pycache__/` | ~30 | — | Untitled working directories |
| Empty scaffolding — the whole `ML/` tree | 16 | 0 B | Zero-byte placeholders |

Added `docs/README.md` as an index. Added `.gitignore` rules for
`docs/_draft/`, the bulk research assets, and `*credentials*.json`.

> **Flagged, not resolved:** `azt1d_patient_credentials.json` and
> `hupa_patient_credentials_simple.json` contain plaintext passwords and JWTs
> for 25 study accounts. Now gitignored. The accounts still need rotating.

### 1.2 The modelling foundation

The key finding: **the pharmacodynamic kernel imports no database code.**
`pharmacodynamics.py` and `activity_pharmacodynamics.py` pull in `math`,
`logging`, `datetime`, `constants` and `time_manager` — nothing else. The
`mongo.db` references in them are docstrings. It runs standalone.

That is the expensive precondition for both supervised learning and RL, and it
was already met. What was missing sat underneath it, and is now built:

- `diatwin/data/schema.py` — canonical events, one UTC axis, `observed_at`
  separate from `t`
- `diatwin/data/normalize.py` — raw Mongo → events; absorbs four timestamp
  encodings and the insulin dual write
- `diatwin/core/grid.py` — the 5-minute axis, epoch-aligned, explicit
  missingness
- `diatwin/sim/patient.py` — the kernel as a forward simulator
- `diatwin/verify/parity.py` — Python ↔ TypeScript comparison

Full reference: [`arm5_verification_and_modelling.md`](./arm5_verification_and_modelling.md).

### 1.3 Test suites

| Suite | Before | After |
|---|---:|---:|
| Backend | 4, and not real (§2, D8) | 280 |
| Mobile | 106 | 148 |
| `diatwin` foundation | — | 40 |
| **Total** | **106** | **468** |

The backend had no harness at all. Three things had to be neutralised before
the Flask app could be imported in a test process: the schedulers start
unconditionally and would poll live APIs, `config` pings Atlas at import, and
the repository root's leftover PyCharm `main.py` shadows the real entrypoint.

`.github/workflows/ci.yml` written — foundation, backend, parity gate, mobile
typecheck and tests. **Not pushed**, by decision.

---

## §2 Defects found

| # | Severity | Finding | State |
|---|---|---|---|
| D1 | High | A deleted meal keeps giving insulin | **Fixed** |
| D2 | High | `/api/bulk-import` has never worked | Kept, by decision |
| D3 | Medium | Malformed JSON returns 500, not 400 | Open |
| D4 | Medium | 194 TypeScript errors, one a real bug | Open |
| D5 | Medium | MOB and cumulative meal effect disagree | Open |
| D6 | Low | Monotonicity breaks under numerical integration | Pinned |
| D7 | Low | Two naming traps in the kernel | Documented |
| D8 | Medium | The backend's only test file asserted nothing | **Fixed** |

### D1 — a deleted meal keeps giving insulin

`DELETE /api/meal/<meal_id>` was registered twice, against different
collections. Flask kept both because the endpoint names differ, and routed to
whichever blueprint registered first — `patient_routes` at index 3, ahead of
`meal_insulin` at index 5. That handler removed only the `meals_only`
projection.

```
BEFORE  meals: 1  meals_only: 1
DELETE by meals_only id -> 200 {'message': 'Meal deleted'}
AFTER   meals: 1  meals_only: 0        <- the record survives
DELETE by meals id      -> 404 {'error': 'Meal not found'}
```

The authoritative record — carrying `intendedInsulin` — was never removed, and
the id the app hands out could not delete it at all. Deleted meals kept
contributing to IOB and cumulative effects.

**This defect was written down in the documentation.** Arm 1 line 404 says the
route touches `meals_only`; Arm 1 line 917 describes it as a full cascading
delete. Two sections, same route, two behaviours — each documenting a real
handler, nobody noticing there were two. See
[`arm-docs-audit.md`](./arm-docs-audit.md) §1.

**Fixed.** Removing the duplicate alone would have broken the client: the app
lists meals from `/api/meals-only` and therefore deletes by the *projection's*
id, which the surviving handler did not recognise. `meal_insulin.delete_meal`
now resolves either id and cascades. Ten regression tests; the client needed
no change.

### D8 — the backend's only test file asserted nothing

`tests/test_mob_iob_integration.py` defined a dictionary of expected field
names inside each test, then asserted on `len()` of that same literal. It
never called an endpoint. One case was `assert True`. All four passed
unconditionally.

Replaced with 16 tests against `/api/active-effects-full` that assert
conservation (active + absorbed insulin equals the delivered dose), that
current + pending BG impact equals the total, that IOB falls over time and
reaches exactly zero after the duration, and that the camelCase and
snake_case aliases the payload ships for two client generations agree.

### D6 and D7 — measured, not assumed

Two findings I initially recorded as defects and then retracted after
measuring:

- **`peak_hours` is not the curve's mode.** The activity curve is clamped at
  100%, so it has no single mode; it rises, saturates, holds a plateau, then
  declines. `peak_hours` sits at the *end* of the plateau in all eleven peaked
  insulins. Self-consistent — a naming trap, not a bug.
- **The monotonicity wobble is real but sub-clinical.** NPH IOB rises by
  0.045 U on a 5 U dose (0.91%); `very_fast` MOB rises by 0.108 g on 60 g
  (0.18%). Both now pinned with exact bounds rather than waived.

---

## §3 The parity result

The dual-language implementation is deliberate — independent implementations
of the same mathematics, for cross-verification. That only *is* verification
when something compares them. The harness is that comparison, and it found two
real defects on its first run.

966 cases, seven insulin types, profiles embedded so a stale constants export
cannot masquerade as a model difference. **205 diverged.**

Four of seven types agree to machine precision. Three do not, and the split
tracks `curve_type`:

| Cause | Python | TypeScript |
|---|---|---|
| Gamma middle branch | `curve_type in ['gamma_moderate','gamma_standard']` | `curveType === 'gamma_broad'` |
| Ultra-long detection | `insulin_type == 'ultra_long'` | `type === 'long_acting' && duration > 30` |

The constants settle both. No insulin uses `gamma_moderate` or
`gamma_standard` — those are *meal* curve names, so the Python branch is dead
and all five `gamma_broad` insulins get α 3.0 instead of α 4.5. No insulin has
`type == 'ultra_long'`, so Python's branch never fires and degludec (42 h)
gets standard phase timings. Glargine at 23.5 h is under the threshold either
way, which is why it agrees.

**7 of 20 insulin types: backend and mobile compute different activity curves
for the same dose.** Rapid-acting analogues are unaffected, which is
presumably why it never surfaced. Not fixed — correcting it changes clinical
behaviour and is a decision to take deliberately. CI fails on any *new*
divergence; the 205 stand as a recorded baseline.

---

## §4 Decisions taken

| Decision | Rationale |
|---|---|
| Access-control findings recorded, not escalated | Closed test environment, per project owner |
| Dual-language implementation kept and formalised | Deliberate cross-verification; the harness realises its value |
| `/api/bulk-import` kept, not deleted | May be needed later |
| `/api/bulk-import` left non-functional | Applying the one-line fix would turn a dormant unauthenticated bulk-write endpoint into a live one. A separate decision, to take when the import pipeline needs it. |
| Parity divergence baselined, not fixed | Changes clinical behaviour |
| Nothing committed or pushed | Per instruction |

---

## §5 What is suggested next

Ordered by dependency. Items 1–3 are small and unblock everything after them.

### Immediate

1. **Run the orphan sweep.** Every meal deleted while the old handler was live
   left a `meals` record and a `medication_logs` row behind, still inflating
   IOB. Those records are in the database now, and any dataset build reads
   them.

   ```bash
   cd backend && python sweep_orphaned_meals.py                     # report
   cd backend && python sweep_orphaned_meals.py --export backup.json
   cd backend && python sweep_orphaned_meals.py --export backup.json --apply
   ```

   Dry run by default; `--apply` refuses without `--export`. Only one category
   is deleted, and the reasoning for that is in
   [`arm5_verification_and_modelling.md`](./arm5_verification_and_modelling.md) §7.

2. **Push the CI workflow.** 468 tests that nothing runs are 468 tests you
   will stop trusting within a month. This is one commit.

3. **Apply the documentation corrections** in
   [`arm-docs-audit.md`](./arm-docs-audit.md) §6 items 1–3. Three statements in
   the arm documents are now false as a result of the D1 fix.

### Short term

4. **Decide the parity divergence.** The evidence says TypeScript is correct
   for both causes. Confirm against clinical intent for regular and mixed
   insulins, fix one side, and let the harness prove it.

5. **Cover the three uncovered mobile calculators** — `blood-glucose-estimation`
   (1,059 lines), `meal-pharmacodynamics` (747), `activity-pharmacodynamics`
   (733). About 2,500 lines with no tests, feeding the same displays the
   tested code feeds.

6. **Make the typecheck a gate.** 194 errors today. Fixing
   `getAvailableInsulinTypes` (D4) and restoring or removing the phantom
   `shared/` package are the two that matter.

### Then the ML step

7. **Write `diatwin/data/repository.py`** — the single Mongo read path for
   modelling. Input: patient id and a time range. Output: a `PatientTimeline`.
   Nothing else in `diatwin/` touches the driver.

8. **Run it over the AZT1D 25 and report the drop counts.** `normalize_all()`
   already returns a per-stream `dropped` breakdown. A high drop rate on real
   data is the finding, not an error.

9. **Decide the `meals` / `meals_only` question.** Two collections hold
   overlapping meal data. Pick the authoritative one, write it down, make the
   repository enforce it.

10. **Then features and the first model.** Learn the *residual* on top of the
    kernel rather than glucose directly: the physics stays interpretable, there
    is always a validated fallback, and where a well-specified PD model misses
    is a more publishable result than a marginally better RMSE.
    `state.as_features()` already exposes `pd_predicted_bg` for this.

### Standing

11. **Rotate the study-account credentials** (§1.1).

---

## §6 Files added and changed

**Added — modelling foundation**

```
diatwin/data/schema.py            diatwin/core/grid.py
diatwin/data/normalize.py         diatwin/sim/patient.py
diatwin/verify/parity.py          diatwin/tests/test_foundation.py
diatwin/README.md
```

**Added — tests**

```
backend/tests/conftest.py                    backend/tests/test_smoke.py
backend/tests/test_route_inventory.py        backend/tests/test_data_flows.py
backend/tests/test_pharmacodynamics.py       backend/tests/test_known_defects.py
backend/tests/test_sweep_orphaned_meals.py   backend/pytest.ini
mobile/__tests__/time-manager.test.ts        mobile/__tests__/parity.test.ts
```

**Added — tooling and docs**

```
backend/sweep_orphaned_meals.py    .github/workflows/ci.yml
requirements-dev.txt               requirements-ml.txt
docs/README.md                     docs/engineering/*
```

**Changed**

```
backend/meal_insulin.py                    D1 fix — _resolve_meal + cascade
backend/routes/patient_routes.py           D1 fix — duplicate handler removed
backend/tests/test_mob_iob_integration.py  D8 fix — rewritten
.gitignore                                 docs rules
```

Nothing committed. `git log` still ends at `b8964b6`.
