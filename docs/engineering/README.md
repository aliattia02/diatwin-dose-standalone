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

*Last updated 5 September 2026 · HEAD `624e6e2` (working tree)*

| | |
|---|---|
| Tests passing | 662 — 280 backend, 317 mobile, 65 foundation |
| Backend routes | 94 registered, 65 documented (69%) |
| Mobile typecheck | 197 errors; not yet a gate |
| Cross-language parity | **3 implementations**, 1,578 cases across 6 families, compared **pairwise**. 205 diverging on two pairs — the same 205, all insulin, all the mobile client against the other two. `python\|frontend` diverges **nowhere**. |
| Open defects | D2 (kept by decision), D3, D4, D5, D9 |
| CI | Written **and pushed** — tracked at `624e6e2`, `master` level with `origin/master` |

**Known open items**, in the order they should be taken:

1. **Decide the α = 4.5 branch** behind the 205 baselined divergences. The
   evidence is now as strong as code can make it: Python and the web frontend
   agree to 1.4e-14 across all 966 insulin cases, and the mobile client stands
   alone. What is left is the pharmacokinetics of a platykurtic
   intermediate-acting curve.
2. **Decide the meal curve's onset discontinuity.** Absorption rate steps down
   by ~5 percentage points exactly at `onset_hours` in all three
   implementations, so parity will never flag it. It is also what makes the
   choice of quadrature rule inconclusive.
3. Decide **D9** — the daily reset boundary is 24 h stale for UTC offsets east
   of +07:00, in three of the six mobile reset implementations. Consolidating
   them onto `TimeManager` would remove the class of bug rather than an
   instance of it.
4. Run `backend/sweep_orphaned_meals.py` — orphaned records are in the live
   database and inflate IOB
5. Apply audit §6 items 1–3 — three statements in the arm documents are still
   false. (Two more were found and corrected on 5 September: Arm 2's
   `calculate_absorbed_fraction` row said "trapezoidal" when it never was, and
   `activity-pd-implementation.md`'s gap D-1 named the wrong file.)
6. Rotate the AZT1D study-account credentials

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
