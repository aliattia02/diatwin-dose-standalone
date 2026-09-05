# `diatwin` — modelling package

The importable core of DiaTwin: canonical data types, the time grid, the
pharmacodynamic kernel as a forward simulator, and the cross-language parity
harness. No Flask, no Mongo driver at import time, no ML dependency below the
`ml/` layer.

The Flask app under `backend/` keeps serving requests exactly as it does now.
This package sits alongside it and is what the ML and RL work is built on.

```
diatwin/
├── data/
│   ├── schema.py      canonical events — one UTC axis, explicit observed_at
│   └── normalize.py   raw Mongo documents → canonical events
├── core/
│   └── grid.py        the 5-minute grid: alignment, resampling, missingness
├── sim/
│   └── patient.py     the PD kernel as a forward simulator
├── verify/
│   └── parity.py      Python ↔ TypeScript cross-check
├── ml/                (features, datasets, models — next)
└── tests/             40 tests, stdlib only, run in under a second
```

## Why this shape

The pharmacodynamic kernel — `backend/utils/pharmacodynamics.py` and
`activity_pharmacodynamics.py` — imports **no database code**. It is already a
pure function of `(events, patient_constants, time)`. That is the expensive
precondition for both supervised modelling and reinforcement learning, and it
was already satisfied. What was missing was everything around it.

Three things this package adds, in dependency order:

**One time axis.** `bloodSugarTimestamp` has been written as a naive
`datetime`, an ISO string, an ISO string with a `Z`, and not at all — the
`$or` fan-out at `backend/blood_sugar.py:341` exists to paper over exactly
that. `normalize.parse_time` collapses all of them. Any dataset built without
this step is silently misaligned.

**One insulin record per dose.** A bolus is written to `medication_logs` *and*
to `meals` as `mealType='insulin_only'` (`medication_routes.py:488`). Loading
both doubles every dose. `normalize.dedupe_insulin` collapses the pair and
keeps whichever copy carries `suggestedInsulin` — that column is the
difference between what the app proposed and what the patient actually took,
which is the single most valuable signal for the RL step.

**A leakage guard.** Every event carries `observed_at` as well as `t`. A meal
eaten at 14:00 but entered at 19:00 must be invisible to a 15:00 prediction.
`PatientTimeline.as_of(t)` filters on observation time, not event time. Get
this wrong and offline results look excellent and deployment does not.

## Quick start

```bash
pip install -r requirements-dev.txt
pytest diatwin/tests -q
```

Forward-simulate a meal and a bolus:

```python
from datetime import datetime, timedelta, timezone
from diatwin.core.grid import build_grid
from diatwin.data.schema import MealEvent, InsulinDose, PatientProfile, Source
from diatwin.sim.patient import PatientSim

t0 = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
sim = PatientSim(profile=PatientProfile(patient_id="p1", valid_from=t0))
sim.apply(MealEvent(patient_id="p1", t=t0, observed_at=t0,
                    source=Source.PATIENT_LOG, carbs_g=60, protein_g=20,
                    fat_g=15, absorption_type="medium"))
sim.apply(InsulinDose(patient_id="p1", t=t0, observed_at=t0,
                      source=Source.PATIENT_LOG, units=6.0,
                      insulin_type="insulin_lispro"))

for s in sim.trajectory(build_grid(t0, t0 + timedelta(hours=6)))[::12]:
    print(f"{s.t:%H:%M}  IOB {s.iob:5.2f}  MOB {s.mob:5.1f}  BG {s.predicted_bg:6.1f}")
```

`state.as_features()` returns the flat float dict that becomes a feature row.
The same object, branched with `sim.copy()`, is the transition function an RL
environment steps.

## The parity harness

The insulin model is implemented independently in Python and TypeScript as a
deliberate cross-verification strategy. That only *is* verification when
something compares the two — otherwise it is two chances to be wrong.

```bash
python -m diatwin.verify.parity generate    # shared case file
python -m diatwin.verify.parity python      # Python side
cd mobile && npx jest __tests__/parity      # TypeScript side
python -m diatwin.verify.parity compare     # exit 1 on divergence
```

Both sides read the *same* `cases.json` with pharmacokinetic profiles
embedded, so a stale constants export cannot be mistaken for a model
difference. 966 cases across seven insulin types, chosen to span every curve
family and to sit on the onset, peak and duration boundaries where the two
implementations are most likely to part company.

### First run: 205 of 966 cases diverged

Four of seven insulin types agree to machine precision (worst delta 1.8e-15).
Three diverge, and the split tracks `curve_type` rather than insulin, which
localised both causes immediately.

| Cause | Python | TypeScript | Affected |
|---|---|---|---|
| Gamma middle branch keys on disjoint name sets | `curve_type in ['gamma_moderate','gamma_standard']` → α 4.5 | `curveType === 'gamma_broad'` → α 4.5 | 5 insulins |
| Ultra-long detection | `insulin_type == 'ultra_long'` | `type === 'long_acting' && duration > 30` | 2 insulins |

Both are Python-side defects, and the constants prove it: **no insulin
carries `curve_type` `gamma_moderate` or `gamma_standard`** — those are *meal*
absorption curve names, so the Python branch is dead and all five
`gamma_broad` insulins fall through to α 3.0 instead of α 4.5. Likewise **no
insulin has `type == 'ultra_long'`**, so Python's ultra-long branch can never
be taken and degludec (42 h) gets the standard phase timings instead of the
ultra-long ones.

Net effect: for `regular_insulin`, the three mixed insulins,
`combination_degludec_aspart`, `insulin_degludec` and `insulin_glargine_u300`,
the backend and the mobile app compute **different activity curves for the
same dose**. Seven of twenty insulin types.

Fixing them is a change to clinical behaviour, so it wants a deliberate
decision rather than a quiet patch — but the harness now holds the line, and
`.github/workflows/ci.yml` fails the build on any new divergence.

## Where this is going

`ml/` is empty on purpose. The eleven zero-byte files under
`docs/Clinical Validation/data files/ML/` are what happens when structure gets
committed before it does anything; nothing lands here until it runs and is
tested.

The intended first model is a **residual** on top of the kernel: the PD engine
predicts, and the model learns its error. That keeps the physics interpretable
and auditable, keeps a validated fallback when the model is unsure, and is a
far more defensible position than another black-box glucose predictor. The
kernel's own output is already exposed as the `pd_predicted_bg` feature for
exactly this.
