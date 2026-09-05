# DiaTwin — Engineering Documentation

The running engineering record, continuing from `docs/3 Arms Doc/`.

The arm documents describe **what the system is**. This folder records **what
changes, why, and what state it left things in** — session reports, audits,
and new reference documents that extend the arm series.

---

## Contents

| Document | Type | What it is |
|---|---|---|
| [`arm5_verification_and_modelling.md`](./arm5_verification_and_modelling.md) | Reference | **Arm 5.** The `diatwin` package, the test suites, the parity harness, CI, and the maintenance scripts. Written in the same form as Arms 0–4 and cross-referenced with them. |
| [`arm-docs-audit.md`](./arm-docs-audit.md) | Audit | Accuracy audit of Arms 0–4 against the code at `b8964b6`. Route coverage, one contradiction that turned out to be a live bug, and a prioritised list of edits. |
| [`2026-09-05-verification-pass.md`](./2026-09-05-verification-pass.md) | Session report | Documentation cleanup, the modelling foundation, 468 tests, 8 defects, and what is suggested next. |
| [`2026-09-05-mobile-calculation-coverage.md`](./2026-09-05-mobile-calculation-coverage.md) | Session report | The three uncovered mobile calculation modules, 656 tests, four new parity families, the baseline gate, and defects D9–D13 — four fixed, D9 left open. |
| [`2026-09-05-three-way-parity.md`](./2026-09-05-three-way-parity.md) | Session report | The web frontend joins the parity harness as a third side. The 205 divergences resolve two-against-one, D14–D16 found and fixed, and the meal curve's onset discontinuity measured. |
| [`2026-09-05-pre-ml-audit.md`](./2026-09-05-pre-ml-audit.md) | Session report | **The pre-ML audit.** Coverage for the two timed writers, leakage verified over real data, drop rates measured against AZT1D, the TypeScript triage and ratchet, and D17–D23. Its §4 is the one to read: the drop-rate instrument cannot see the loss that actually happens. |
| [`2026-09-05-storage-layer-decision.md`](./2026-09-05-storage-layer-decision.md) | Decision | **Stay on MongoDB.** Requirements, four candidates scored on measured numbers, the migration cost avoided, what is given up, and six trigger conditions that should reopen it. |
| [`2026-09-05-defect-fix-pass.md`](./2026-09-05-defect-fix-pass.md) | Session report | **Clearing the open defects.** D3, D9, D17, D18, D19, D21 and D22 fixed; the judgement call taken on each of the three that needed one, and what each deliberately leaves open. 864 tests, parity unchanged. |
| [`2026-09-05-web-frontend-parity-audit.md`](./2026-09-05-web-frontend-parity-audit.md) | Audit | **The React frontend measured against the mobile client.** Where each is ahead (neither is a superset), what the doctor dashboard actually has today, D24/D25, and what ML/RL genuinely needs from the web surface. |
| [`next-session-prompt.md`](./next-session-prompt.md) | Handoff | A self-contained prompt for the next session: rigorous analysis of the models' logic and mathematics, with five measured leads. Paste it into a fresh session. |

---

## How this relates to the arm documents

```
================================================================
  docs/3 Arms Doc/                    "what the system is"
    arm0  App Infrastructure          config, bootstrap, auth, schedulers,
                                      FHIR, doctor routes
    arm1  Constants & Ingestion       constants system, TimeManager,
                                      write paths, stored schemas
    arm2  Data Operations             the PD kernel, calculation engine,
                                      TS calculation stack
    arm3  Visualization               charts, hooks, dashboard
    arm4  Mobile Client Layer         services, stores, hooks, storage

  docs/engineering/                   "what holds it to that, and what changed"
    arm5  Verification & Modelling    diatwin package, tests, parity, CI
    audit                             accuracy of arms 0-4
    session reports                   dated, one per significant change
================================================================
```

Arm 5 belongs to the same series and follows the same conventions — scope box,
numbered sections, cross-arm references, and a closing set of permanent
invariants stated as rules rather than history. It lives here rather than in
`3 Arms Doc/` because that folder's name is now a misnomer at five arms, and
because splitting reference documents from the change record keeps each
useful for a different question.

---

## Conventions

**Reference documents** (`armN_*.md`) describe current state. They contain no
history. When behaviour changes, the reference document is edited and the
change is recorded in a session report.

**Session reports** (`YYYY-MM-DD-*.md`) are dated, immutable once written, and
describe one stretch of work: what was done, what was found, what was decided
and why, and what is suggested next. They are the answer to "why is this like
this?" six months later.

**Audits** assess something against evidence and say what should change. They
are dated in their header and superseded rather than edited.

**Developer Rules** sections state permanent invariants. A rule earns its place
by being something a reasonable person would otherwise get wrong, and each one
should say what breaks if it is violated.

---

## Current state, at a glance

*Last updated 5 September 2026, after the defect-fix pass · working tree on `master`*

| | |
|---|---|
| Tests passing | **864** — 401 backend, 362 mobile, 101 foundation |
| Backend routes | 94 registered, 65 documented (69%) |
| Mobile typecheck | **185** errors, gated by a **ratchet** (`mobile/scripts/typecheck-ratchet.mjs`) — the count may only go down |
| Cross-language parity | **3 implementations**, 1,578 cases across 6 families, compared **pairwise**. 205 diverging on two pairs — the same 205, all insulin, all the mobile client against the other two. `python\|frontend` diverges **nowhere**. |
| Drop rates | **Measured** against AZT1D 2025 (25 subjects, 306,712 rows): glucose 0.00%, insulin 0.15%, meals 0.00%. See the audit §4 — the number is not the finding. |
| Leakage (rule 6) | **Verified over real data**: 286,195 windows across 24 patients, 0 violations |
| Storage layer | **Decided: stay on MongoDB**, train on Parquet snapshots, add DuckDB. See the decision record for the six triggers that reopen it. |
| Open defects | D2 (kept by decision), D4 (185 typecheck errors, ratcheted), D5, **D21b** (`peak_hours` names the normalisation parameter, not the mode), **D24** (the web frontend uses the browser's timezone, not the patient's, at six call sites), **D25** (three web dashboard tabs are 0-byte files). D3, D9, D17, D18, D19, D20, D21a/c, D22, D23 all **fixed**. |
| Web frontend | 51,080 lines, **not built in CI, not deployed, 1 broken boilerplate test**. Only 3 of 16 `utils/` files are exercised by anything. See the frontend parity audit. |
| Provisional decisions | D9, D21a/c and D22 changed clinical output. Each replaced a measured defect with the narrowest defensible behaviour and is pinned as provisional in `TestStillOpen` — see the defect-fix-pass report §6. |
| CI | `master` level with `origin/master`; the mobile typecheck step is now a ratchet rather than an always-red gate |

**Known open items**, in the order they should be taken:

1. **Decide the α = 4.5 branch** behind the 205 baselined divergences. The
   evidence is now as strong as code can make it: Python and the web frontend
   agree to 1.4e-14 across all 966 insulin cases, and the mobile client stands
   alone. What is left is the pharmacokinetics of a platykurtic
   intermediate-acting curve.
2. **Review the two provisional model decisions** taken on 5 September, both of
   which changed clinical output and neither of which a clinician has seen:
   **D21a/c** (the meal curve normalises by its true mode and returns 0 before
   onset) and **D22** (the acute exercise effect scales linearly with
   heart-rate reserve). Each replaced a measured defect with the narrowest
   defensible behaviour, and each is pinned as provisional in a `TestStillOpen`
   case naming what is unresolved.
3. **Decide D21b** — `peak_hours` names the gamma's *normalisation* parameter,
   not its mode; they differ by up to 1.6 h. Editing a profile's `peak_hours`
   changes the curve's shape rather than moving its peak. Closing it means
   reparameterising every profile so `(k-1)·scale == 1`, which changes each
   tail.
4. **Handle basal insulin.** 200,889 AZT1D rows are unrepresented by the
   conversion pipeline, so IOB from that cohort is wrong and no drop rate says
   so. Largest single data-fidelity gap before training.
5. Run `backend/sweep_orphaned_meals.py` — orphaned records are in the live
   database and inflate IOB
6. Apply audit §6 items 1–3 — three statements in the arm documents are still
   false. (Corrected on 5 September: Arm 2's `calculate_absorbed_fraction` row
   said "trapezoidal" when it never was; `activity-pd-implementation.md`'s gap
   D-1 named the wrong file; and both that file's Z description and Arm 2's
   gamma row were made current with D21/D22.)
7. Rotate the AZT1D study-account credentials

**Fixed 5 September, defect-fix pass:** D3 (malformed JSON returned 500, and the
500 path leaked `str(e)` to the caller), D9 (the daily reset, consolidated onto
`TimeManager` across **four** sites — one more than the audit found), D17
(`DuplicateKeyError` uncaught, so a CGM duplicate aborted the rest of the batch),
D18 (the 401 retry re-read a stale in-memory document and never
re-authenticated), D19 (the watch sync had no deduplication and no unique index),
D21a/c and D22 (the two model shape defects, provisionally). See
[`2026-09-05-defect-fix-pass.md`](./2026-09-05-defect-fix-pass.md).

**Fixed 5 September, pre-ML audit:** D20 (`ValidationResult.error` read in two
more files, discarding a dose-safety message), D23 (`getAvailableInsulinTypes`
read camelCase off snake_case, leaving four fields `undefined`).

**Fixed 5 September, mobile coverage session:** D10 (`calculateMealActivity`
bypassed its own timestamp parser), D11 (a dose with no timestamp threw and
blanked the whole cumulative calculation), D12 (an unknown absorption type had
two contradictory fallbacks in one file), D13 (the insulin timeline reset on
the device clock).

**Fixed 5 September, three-way parity session:** D14 (`SETUP.md` step 1 could
not succeed on a clean clone — it named the wrong requirements file, and the
one it named pins a conflicting `pytest`), D15 (the web frontend's
`getActivityOnBoard` discarded the CGM-measured drop entirely, so delivered +
remaining did not sum to the total *within one file*), D16 (the web frontend
integrated the absorbed fraction with a different quadrature rule, following a
description of Python that was wrong in three places).

---

## Where else to look

| Path | Contents |
|---|---|
| `docs/DiaTwin_Complete_Documentation.md` | Canonical technical + clinical spec (84 KB) |
| `docs/3 Arms Doc/` | Arms 0–4 reference documents |
| `docs/documentation/` | Subsystem deep-dives — activity PD, dual baseline, insulin suggestion logic, watch HR sync |
| `docs/Clinical Validation/` | AZT1D 2025 study data, conversion pipeline, manuscript |
| `diatwin/README.md` | Quick start for the modelling package |
| `docs/_draft/` | Superseded drafts and regenerable output (gitignored) |
