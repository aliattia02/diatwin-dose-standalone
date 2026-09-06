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
| [`2026-09-06-frontend-safety-net-and-review-surface.md`](./2026-09-06-frontend-safety-net-and-review-surface.md) | Session report | **The frontend gets checked.** CI job and a lint ratchet, 117 tests where there were none, D24/D24b/D25 fixed — including a doctor dashboard that threw on every patient selection — the suggestion review surface, the cohort data-quality view (two new admin-only endpoints), the watch split decided, and D26–D28: a dead doctor-mode URL, a doctor endpoint with no per-patient authorization check, and two charts that silently rendered the doctor's own data under a patient's name. |
| [`2026-09-05-suggestion-review-contract.md`](./2026-09-05-suggestion-review-contract.md) | Reference | **What a reviewable suggestion is.** The object a clinician surface consumes, written against the rules engine so a learned model arrives as a second `provenance.producer` and nothing else changes. Four rules about what must not happen to the data on the way to a clinician. |
| [`next-session-prompt-frontend.md`](./next-session-prompt-frontend.md) | Handoff | Superseded by the 6 September session report — Parts A, C1–C4 and D are done. Its Part B remains open; see that report's §7. |
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

*Last updated 6 September 2026, after the frontend safety-net session · working tree on `master`*

| | |
|---|---|
| Tests passing | **1,017** — 437 backend, 362 mobile, 101 foundation, **117 web frontend** |
| Backend routes | 96 registered, 65 documented (68%) — the 2 undocumented additions are `/api/ml/snapshots{,/<id>/manifest}` (6 September) |
| Mobile typecheck | **185** errors, gated by a **ratchet** (`mobile/scripts/typecheck-ratchet.mjs`) — the count may only go down |
| Cross-language parity | **3 implementations**, 1,578 cases across 6 families, compared **pairwise**. 205 diverging on two pairs — the same 205, all insulin, all the mobile client against the other two. `python\|frontend` diverges **nowhere**. |
| Drop rates | **Measured** against AZT1D 2025 (25 subjects, 306,712 rows): glucose 0.00%, insulin 0.15%, meals 0.00%. See the audit §4 — the number is not the finding. |
| Leakage (rule 6) | **Verified over real data**: 286,195 windows across 24 patients, 0 violations |
| Storage layer | **Decided: stay on MongoDB**, train on Parquet snapshots, add DuckDB. See the decision record for the six triggers that reopen it. |
| Open defects | D2 (kept by decision), D4 (185 typecheck errors, ratcheted), D5, **D21b** (`peak_hours` names the normalisation parameter, not the mode). D3, D9, D17–D20, D21a/c, D22, D23, **D24**, **D24b**, **D25**, **D26**, **D27**, **D28** all **fixed** (D28's `BloodSugarVisualization` half gets an honest placeholder, not a real fix — see item 2 above). The D27 pattern recurs at 17 more call sites — see item 1 above. |
| Web frontend | **In CI** — jest suite plus a build-and-lint **ratchet** (`frontend/scripts/lint-ratchet.mjs`) at **174** warnings, which may only go down. **117 tests** where there were none. Still not deployed. |
| Clinician review surface | **Built** against the rules engine: signed `intendedInsulin − suggestedInsulin` per meal, with provenance, plus a **cohort data-quality tab** reading a snapshot's `manifest.json` through two new admin-only endpoints (`GET /api/ml/snapshots`, `GET /api/ml/snapshots/<id>/manifest`). No model exists to review yet — `diatwin/ml/` is one file. See the suggestion review contract. |
| Provisional decisions | D9, D21a/c and D22 changed clinical output. Each replaced a measured defect with the narrowest defensible behaviour and is pinned as provisional in `TestStillOpen` — see the defect-fix-pass report §6. |
| CI | Five jobs: foundation, backend, parity, mobile, **frontend**. Two ratchets rather than always-red gates (mobile typecheck, frontend lint). The `on.push` trigger named `main` and the default branch is `master`, so pushes never triggered it — **fixed**. |

**Known open items**, in the order they should be taken:

1. **Audit the doctor-authorization pattern at 17 more call sites** (spawned
   task, not yet started) — fixing D27 (below) surfaced the same "checks
   `user_type == 'doctor'` but never confirms authorization for *this*
   patient" gap in `blood_sugar.py`, `meal_insulin.py`,
   `cumulative_effects_routes.py`, `meal_routes.py` and
   `medication_routes.py`. See the 6 September report §3A for the exact line
   numbers.
2. **Five doctor endpoints still have no view**: medications, medication-log,
   conditions, insulin dose history, and the constants PUT/reset actions. The
   6 September session fixed what was wired *wrong* (a dead URL, a missing
   authorization check, two charts silently rendering the doctor's own data)
   rather than building what was never built. `BloodSugarVisualization` also
   still has no real doctor-mode implementation, only an honest placeholder —
   that needs a patient-scoped variant of `BloodSugarDataContext`, which is a
   context refactor, not a wiring fix.
3. **Decide the α = 4.5 branch** behind the 205 baselined divergences. The
   evidence is now as strong as code can make it: Python and the web frontend
   agree to 1.4e-14 across all 966 insulin cases, and the mobile client stands
   alone. What is left is the pharmacokinetics of a platykurtic
   intermediate-acting curve.
4. **Review the two provisional model decisions** taken on 5 September, both of
   which changed clinical output and neither of which a clinician has seen:
   **D21a/c** (the meal curve normalises by its true mode and returns 0 before
   onset) and **D22** (the acute exercise effect scales linearly with
   heart-rate reserve). Each replaced a measured defect with the narrowest
   defensible behaviour, and each is pinned as provisional in a `TestStillOpen`
   case naming what is unresolved.
5. **Decide D21b** — `peak_hours` names the gamma's *normalisation* parameter,
   not its mode; they differ by up to 1.6 h. Editing a profile's `peak_hours`
   changes the curve's shape rather than moving its peak. Closing it means
   reparameterising every profile so `(k-1)·scale == 1`, which changes each
   tail.
6. **Handle basal insulin.** 200,889 AZT1D rows are unrepresented by the
   conversion pipeline, so IOB from that cohort is wrong and no drop rate says
   so. Largest single data-fidelity gap before training.
7. Run `backend/sweep_orphaned_meals.py` — orphaned records are in the live
   database and inflate IOB
8. Apply audit §6 items 1–3 — three statements in the arm documents are still
   false. (Corrected on 5 September: Arm 2's `calculate_absorbed_fraction` row
   said "trapezoidal" when it never was; `activity-pd-implementation.md`'s gap
   D-1 named the wrong file; and both that file's Z description and Arm 2's
   gamma row were made current with D21/D22.)
9. Rotate the AZT1D study-account credentials

**Fixed 6 September, frontend safety-net session:** D24 (the daily reset used the
browser's timezone at seven call sites across two files, not the six the audit
found), **D24b** (`isAtResetTime` had no timezone parameter at all and was a
second definition of the reset boundary, against rule 16), D25 (the four 0-byte
components — one implemented, three removed, across **five** render sites rather
than the three the audit found, including the doctor and admin dashboards, where
selecting a patient threw with no error boundary above it). Also: the doctor
constants endpoint returned `daily_reset_hour` without
`timezone_offset_minutes`, so a doctor's client could not learn the patient's
timezone at all.

Fixed the same day, continuing into Part B: **D26** (`BloodSugarChart`'s
doctor-mode request was missing `/api` and 404'd on every call), **D27**
(`/api/patient/<id>/activity-history` checked only that the caller was *a*
doctor, never that they were authorized for *that patient* — any doctor could
read any patient's activity history; fixed, and the same pattern flagged
elsewhere as a follow-up task), **D28** (`ActivityVisualization` and
`BloodSugarVisualization` both accepted `isDoctor`/`patientId` from the doctor
dashboard and used neither, silently rendering the doctor's own data — or a
PD-incompatible response shape from the wrong sibling endpoint — under the
selected patient's name; the first is fixed, the second gets an honest
placeholder pending a context refactor). See
[`2026-09-06-frontend-safety-net-and-review-surface.md`](./2026-09-06-frontend-safety-net-and-review-surface.md).

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
