# The suggestion review contract

*Reference · 5 September 2026 · the shape a reviewable suggestion has*

---

## Scope

This document defines the object a clinician review surface consumes: **one
suggestion, the observation it is compared against, and enough provenance to
say where both came from**.

It exists because the web frontend is becoming the surface where a clinician
reviews machine-learning output, and there is no machine learning yet —
`diatwin/ml/` contains one file, `export.py`. There is no training code, no
model artifact, no prediction endpoint and no RL code. A review surface built
directly against "the model's output" would have nothing to render.

There *is* a suggestion signal, and it is the one the RL step will train
against. `backend/meal_insulin.py:795` writes `suggestedInsulin` — what the
rules-based engine proposed — onto every meal document, alongside
`intendedInsulin`, what the patient actually took.
`diatwin/data/schema.py:113` states why that pair matters:

> `suggested_units` vs `units` is the behavioural-cloning target and the single
> most valuable column for the later RL step: it is a logged record of where the
> patient disagreed with the model.

So the contract below is written once, against the rules engine, and a learned
model becomes a second `provenance.producer`. Nothing in the review surface
changes when it arrives. That is the whole point of writing it down before
building the components rather than after.

---

## 1. The object

```jsonc
{
  "subject_id":  "…",          // the patient this concerns
  "event_id":    "…",          // the meal or dose the suggestion attaches to
  "kind":        "insulin_units",

  "suggested":   6.5,          // what the producer proposed
  "observed":    4.0,          // what actually happened; null if not yet acted on
  "unit":        "U",

  "decided_at":  "2026-03-01T17:04:00Z",   // when the suggestion was produced
  "observed_at": "2026-03-01T17:06:00Z",   // when the observation was recorded

  "state": { … },              // the inputs the suggestion was computed from
  "provenance": { … }          // who produced it, from what data
}
```

### 1.1 `suggested` and `observed` are both required, and both nullable

A suggestion with no observation is a *pending* decision, not an error: it is
what the surface shows for a meal logged minutes ago. An observation with no
suggestion is an *unadvised* action — the patient dosed without asking — and it
is a different clinical fact, not a missing value to be imputed. Both cases must
survive to the display; neither may be silently dropped, because the rate at
which each occurs is itself a finding.

**The disagreement is `observed - suggested`, signed.** The sign carries the
clinical meaning — systematic under-dosing and systematic over-dosing are
different problems with different causes — so nothing in the pipeline may take
an absolute value before the clinician sees it.

### 1.2 `decided_at` is not `observed_at`

They are separate fields because the leakage rule depends on the difference.
Arm 5 rule 6:

> Any code producing a prediction or a training row for time `T` must read
> `timeline.as_of(T)`, which filters on `observed_at`. Filtering on `t` admits
> records that did not exist when the decision was made.

A review surface that sorts or filters on the wrong one shows a clinician a
suggestion justified by data that did not exist when it was made. Storing one
timestamp and deriving the other is what makes that mistake available; storing
both makes it checkable.

### 1.3 `state` is the justification, not a summary of it

`state` carries the inputs the suggestion was computed from — blood glucose and
its source, carbohydrates, IOB, MOB, activity, the constants in force. It must
be the values *used*, not values re-fetched at display time, because re-fetching
is how a justification silently becomes a reconstruction. For the rules engine
this is `insulinCalculation`, which `meal_insulin.py` already stores on the meal
document. For a model it is the feature vector.

The surface should render `state` without knowing its keys. A model's features
will not match the rules engine's, and the contract must not require a schema
migration to display a new producer.

### 1.4 `provenance` is what makes a claim reviewable

```jsonc
"provenance": {
  "producer":     "rules:meal_insulin.calculate_suggested_insulin",
  "version":      "…",         // code version or model artifact id
  "snapshot_id":  "…"          // the Parquet snapshot, when there is one
}
```

`producer` is the field that lets one surface serve both the current engine and
a later model, and lets a clinician tell them apart. It is a string naming what
computed the number, not a boolean `is_model`.

`snapshot_id` is null for a live suggestion computed against MongoDB, and set
for anything computed against a training snapshot. `diatwin/ml/export.py`
already writes content-hashed snapshots with the drop report embedded in the
manifest, so this costs nothing to populate and is the difference between a
clinical claim that can name its data and one that cannot.

**A view that cannot name its producer must say so rather than omit the field.**
An absent provenance renders as "unknown", never as blank.

---

## 2. Where the data comes from today

No backend work is needed to populate this contract for the rules engine.
Measured against the running code:

| Contract field | Source today |
|---|---|
| `suggested` | `suggestedInsulin` on the meal document — `meal_insulin.py:795` |
| `observed` | `intendedInsulin` on the same document |
| `event_id`, `decided_at` | meal `id` and `timestamp` |
| `state` | `insulinCalculation` |
| `provenance.producer` | constant — the rules engine is the only producer |

All five are already returned by **`GET /api/doctor/meal-history/<patient_id>`**
(`meal_insulin.py:1235`), which the web frontend already calls. The disagreement
view is therefore client-side work against an endpoint that exists.

`GET /api/doctor/patient/<id>/insulin` returns `units` but **not** a suggested
value, because insulin doses are read from `medication_logs` where no suggestion
is stored. The meal path is the only place the pair is recorded, so the
disagreement view is meal-anchored. That is a real limitation and it is stated
in the view rather than papered over: a dose given outside a meal has no
suggestion to disagree with.

---

## 3. What this contract deliberately does not do

**It does not define a model-serving API.** There is no model. When there is,
`producer` and `version` are the fields that change and nothing else needs to.

**It does not carry a confidence or an error bar.** The rules engine produces a
point value with no uncertainty attached, and inventing one at the display layer
would be fabricating a clinical quantity. A model that produces one adds a field;
until then the absence is honest.

**It does not aggregate.** Cohort statistics are computed by the view from a
collection of these objects. Storing a pre-aggregated mean would make the
leakage rule unverifiable, because the window it was computed over would not
travel with it.

---

## 4. Developer Rules

1. **`suggested` and `observed` keep their sign and their nulls all the way to
   the display.** Absolute values and zero-filling both destroy the finding: the
   direction of disagreement is the clinical signal, and a null means "no
   decision was made", which is not the same as "no difference".

2. **A displayed suggestion names its producer.** One surface serves the rules
   engine and any later model, and a clinician must be able to tell which
   produced the number in front of them. Unknown renders as "unknown".

3. **`decided_at` and `observed_at` are both stored, never derived from each
   other.** Rule 6's leakage guard is stated in terms of the difference; a
   surface holding one timestamp cannot check it.

4. **Any view that reads a snapshot names its `snapshot_id`.** A clinical claim
   that cannot name its data is not reviewable. Live views say "live", which is
   also naming it.

---

## 5. Cross-references

| | |
|---|---|
| Arm 5 §10 rules 6, 7 | leakage and missing values — why §1.2 and §1.1 are shaped this way |
| `diatwin/data/schema.py:113` | the statement that this pair is the RL target |
| [`2026-09-05-pre-ml-audit.md`](./2026-09-05-pre-ml-audit.md) §4 | why a drop rate alone misleads, and what must sit beside it |
| [`2026-09-05-storage-layer-decision.md`](./2026-09-05-storage-layer-decision.md) §1, §3.5 | the Parquet snapshot contract `snapshot_id` refers to |
| [`2026-09-05-web-frontend-parity-audit.md`](./2026-09-05-web-frontend-parity-audit.md) §5 | what ML/RL needs from the web surface |
