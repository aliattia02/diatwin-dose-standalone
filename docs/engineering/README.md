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

*Last updated 5 September 2026 · HEAD `b8964b6` (working tree)*

| | |
|---|---|
| Tests passing | 656 — 280 backend, 317 mobile, 59 foundation |
| Backend routes | 94 registered, 65 documented (69%) |
| Mobile typecheck | 198 errors — 194 application, 4 in a test file; not yet a gate |
| Cross-language parity | 1,578 cases across 6 families; 205 diverging, all insulin, baselined and gated |
| Open defects | D2 (kept by decision), D3, D4, D5, D9 |
| CI | Written, **not pushed** |

**Known open items**, in the order they should be taken:

1. Decide **D9** — the daily reset boundary is 24 h stale for UTC offsets east
   of +07:00, in three of the six mobile reset implementations. The other three
   are correct; consolidating all of them onto `TimeManager` would remove the
   class of bug rather than an instance of it.
2. Run `backend/sweep_orphaned_meals.py` — orphaned records are in the live
   database and inflate IOB
3. Push `.github/workflows/ci.yml`
4. Apply audit §6 items 1–3 — three statements in the arm documents are still
   false. (Arm 1 §2.2's claim about device-timezone immunity was a fourth; it
   is now true, because D13 was fixed rather than documented.)
5. Decide the parity divergence (7 of 20 insulin types)
6. Rotate the AZT1D study-account credentials

**Fixed this session:** D10 (`calculateMealActivity` bypassed its own timestamp
parser), D11 (a dose with no timestamp threw and blanked the whole cumulative
calculation), D12 (an unknown absorption type had two contradictory fallbacks
in one file), D13 (the insulin timeline reset on the device clock).

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
