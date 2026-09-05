# DiaTwin — Documentation Index

Everything here is reference material for the DiaTwin / native3 project.
Working files, duplicates and regenerable output live in `_draft/`, which is
gitignored.

## Start here

| Path | What it is |
|---|---|
| [`engineering/`](./engineering/) | **The running engineering record.** Session reports, the accuracy audit of Arms 0–4, and Arm 5. Start here for current state and what changed recently. |
| `DiaTwin_Complete_Documentation.md` | Canonical technical + clinical spec (84 KB). The single best overview. |
| `3 Arms Doc/` | Arms 0–4 — the detailed subsystem reference set. |

## `3 Arms Doc/` — subsystem reference (Arms 0–4)

| File | Scope |
|---|---|
| `arm0_app_infrastructure_reference.md` | Config, bootstrap, auth, schedulers, FHIR, doctor routes |
| `arm1_constants_ingestion_reference.md` | Constants system, TimeManager, write paths, stored schemas |
| `arm2_data_operations_reference.md` | The PD kernel, calculation engine, TypeScript calculation stack |
| `diatwin_arm3_visualization.md` | Charts, hooks, dashboard |
| `diatwin_arm4_mobile_client_layer.md` | Services, stores, hooks, storage |

> Arm 5 (verification and modelling) lives in [`engineering/`](./engineering/),
> along with an audit of how accurate Arms 0–4 currently are. Three statements
> in Arm 1 and Arm 0 are known to be out of date — see
> [`engineering/arm-docs-audit.md`](./engineering/arm-docs-audit.md) §6.

## `documentation/` — subsystem deep-dives

| File | Scope |
|---|---|
| `DiaTwin_Full_Documentation.md` | Earlier full spec; superseded, but a fuller narrative on some subsystems |
| `activity-pd-implementation.md` | Activity ODE engine (Y/Z/W model) |
| `dual-baseline-system-ActiveEffectsDisplay.md` | Dynamic vs preset baseline |
| `insulin-suggestion-logic.md` | Dose suggestion decision tree |
| `watch-hr-sync-docs.md` | Google Fit HR sync |
| `reading-residual-alert-plan.md` | Reading/residual alerting design |
| `IMI_Presentation_Script.md` | Presentation script |

## `Clinical Validation/` — AZT1D 2025 study

- `AZT1D 2025/CGM Records/` — raw CGM CSVs, 25 subjects. **Source of truth.**
- `AZT1D 2025/Manuscript.pdf` — study manuscript
- `AZT1D 2025/Visual Statistics/Subject N/Full_*.png` — per-subject summaries
- `data files/scripts/` — conversion and import pipeline (`step1`…`step4`)
- `data files/Azt1d/*.json` — mappings, analysis and validation summaries

> Per-day `Readings_*.png|pdf` renders and the bulk converted JSON were moved
> to `_draft/` — regenerable by re-running `data files/scripts/`.

> ⚠️ `data files/Azt1d/azt1d_patient_credentials.json` and
> `hupa_patient_credentials_simple.json` contain plaintext study-account
> passwords and JWTs. They are gitignored. **Rotate these accounts.**

## Other folders

| Folder | Contents |
|---|---|
| `Proposed Updates/` | Design notes and patches not yet merged |
| `Papers and abstracts/` | BMT2026 abstract, research briefs |
| `thesis/` | Master thesis and HPI excerpts |
| `EXIST/` | EXIST grant application material |
| `artifacts/` | Generated decks, briefs and HTML explainers |
| `Clinical Diabetes/` | Third-party clinical reference PDFs |
| `MISCleanous/` | Presentations and misc collateral |

## `_draft/` (gitignored)

Superseded versions, exact duplicates, `__MACOSX`/`.DS_Store`/`desktop.ini`
junk, `.zip` archives, empty scaffolding and regenerable pipeline output.
Nothing was deleted — remove `_draft/` when you are confident you don't need
it.
