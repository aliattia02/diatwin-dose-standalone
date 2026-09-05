# Arm Documentation — Accuracy Audit
**Audit Document — 5 September 2026**

```
================================================================
Subject
  docs/3 Arms Doc/arm0_app_infrastructure_reference.md      785 lines
  docs/3 Arms Doc/arm1_constants_ingestion_reference.md   1,356 lines
  docs/3 Arms Doc/arm2_data_operations_reference.md       1,749 lines
  docs/3 Arms Doc/diatwin_arm3_visualization.md           1,843 lines
  docs/3 Arms Doc/diatwin_arm4_mobile_client_layer.md     1,793 lines
                                                          ─────────────
                                                          7,526 lines

Method
  Every claim checked against the code as of commit b8964b6, and against
  the 468-test suite added on 2026-09-05. Route coverage measured by
  extracting the live Flask URL map and grepping each rule.

Verdict
  Accurate where it reaches. Reaches 69% of the API surface.
  One contradiction found — and that contradiction was a live bug.
================================================================
```

---

## Table of Contents

- [§0 Summary](#0-summary)
- [§1 The contradiction that was a bug](#1-the-contradiction-that-was-a-bug)
- [§2 Corrections required by the 2026-09-05 changes](#2-corrections-required-by-the-2026-09-05-changes)
- [§3 Undocumented API surface](#3-undocumented-api-surface)
- [§4 Undocumented behaviour in documented areas](#4-undocumented-behaviour-in-documented-areas)
- [§5 What the arms get right](#5-what-the-arms-get-right)
- [§6 Recommended edits, in order](#6-recommended-edits-in-order)

---

## §0 Summary

The arm documents are a real asset. They are precise, they name file and line
locations, they separate ownership cleanly across five arms, and they end each
arm with permanent invariants rather than change history. A new engineer could
onboard from them. Very little of what follows is a criticism of how they are
written.

What the audit found is a coverage boundary and one contradiction:

| Finding | Severity | Where |
|---|---|---|
| Two sections describe the same route doing two different things — this *was* D1 | **High** | Arm 1 §5-A vs §6-A |
| 29 of 94 routes undocumented, including whole subsystems | **High** | all arms |
| The second, looser authorization model is undocumented | Medium | Arm 0 §7 |
| `user_type` is client-supplied at registration; not stated | Medium | Arm 0 §3.3 |
| Delete-cascade description now correct but collection table now wrong | Medium | Arm 1 §5-A |
| Dead-code inventory misses two functions, one of them buggy | Low | Arm 2 §10 |
| `peak_hours` semantics undocumented | Low | Arm 2 §2 |
| Two similarly-named kernel functions on different scales | Low | Arm 2 §2 |
| No arm covers testing, and none can — there was nothing to cover | — | new Arm 5 |

---

## §1 The contradiction that was a bug

This is the most important finding in the audit, and it is worth stating at
length because of what it demonstrates.

**Arm 1, line 404** — the patient history delete-route table:

| Route | Collection |
|---|---|
| `DELETE /api/meal/<meal_id>` | `meals_only` |

**Arm 1, line 917** — five hundred lines later, the same route:

> ### `DELETE /api/meal/<meal_id>` — cascading delete
>
> When a `meals` document is deleted, the handler also deletes:
> - Associated `activities` documents (by `activity_ids`)
> - The linked `blood_sugar` document (by `blood_sugar_id`)
> - The linked `medication_logs` document (by `medication_log_id`)
> - The linked `meals_only` document (by `meals_only_id`)

One route. Two descriptions. They cannot both be true.

**Both were true, of different handlers.** The route was registered twice —
`patient_routes.delete_meal` against `meals_only`, and
`meal_insulin.delete_meal` with the full cascade. Flask accepted both because
the endpoint names differ, and routed to whichever blueprint registered first.
`patient_routes` sits at index 3 of the list in `main.py`; `meal_insulin` at
index 5. So the `meals_only` handler won, the cascade never ran, and every
deleted meal left its `meals` record and its `medication_logs` row behind —
still feeding IOB.

Each author documented a real handler correctly. Neither knew the other
existed. The contradiction sat in the document for months and nobody read the
two sections side by side, because there is no reason to.

The lesson is not that the documentation was wrong. It is that **a document
long enough to contradict itself needs a check that reads it as a whole**.
Arm 5's route-inventory test is that check: it fails the build on any
duplicate rule-and-method registration, which is the same defect expressed in
a form nobody has to notice.

Fixed 2026-09-05. `patient_routes.delete_meal` removed;
`meal_insulin.delete_meal` now resolves either id and cascades.

---

## §2 Corrections required by the 2026-09-05 changes

### Arm 1 §5-A — delete route

**Line 404, collection table.** Now wrong. Replace with:

| Route | Collections |
|---|---|
| `DELETE /api/meal/<meal_id>` | `meals` · `meals_only` · `activities` · `blood_sugar` · `medication_logs` |

**Line 917, cascading delete.** Now correct, but incomplete. Add:

> The handler accepts **either** the `meals` `_id` or the `meals_only` `_id`.
> The mobile client lists meals from `/api/meals-only` and therefore holds
> the projection's id; doctor views hold the meal's. `_resolve_meal()` looks
> in `meals` first, then follows `meals_only.meal_id` to the parent.
>
> Projection removal is attempted three ways — by the recorded
> `meals_only_id`, by reverse lookup on `meal_id`, and by the supplied id
> itself — because the forward link was not written by every historical code
> path.
>
> A projection whose parent is already gone is deleted on its own rather than
> refused, so records orphaned before 2026-09-05 remain removable.

### Arm 0 §2 — app bootstrap

Blueprint registration order is now load-bearing and should say so. The order
in `main.py` decides which handler wins a duplicate rule. Add to §9 Developer
Rules:

> Two blueprints must never register the same rule and method. Flask permits
> it when the endpoint names differ and silently routes to whichever
> registered first, which makes the second handler unreachable without any
> error. Enforced by
> `backend/tests/test_route_inventory.py::test_no_new_duplicate_rule_and_method`.

### Arm 2 §10 — dead code inventory

Add two entries, and note that one is not merely dead:

| Function | File | Status |
|---|---|---|
| `getAvailableInsulinTypes()` | `insulin/pharmacodynamics.ts` | Exported, no caller. **Also buggy** — reads `value.onsetHours` / `peakHours` / `durationHours` / `isPeakless` from objects that use snake_case, so all four fields are `undefined` (TS2551, lines 1368-1371). Latent only because nothing calls it. |
| `getInsulinTypesByCategory()` | `insulin/pharmacodynamics.ts` | Exported, no caller. Delegates to the above, so inherits the defect. |

---

## §3 Undocumented API surface

94 rules are registered, excluding the `/api/v1` proxy and static files.
**65 appear in the arm documents. 29 do not.**

These are not edge cases — they are whole subsystems.

**Food and nutrition (7 routes)** — no arm owns this area at all.

```
/api/food/search          /api/food/categories      /api/food/custom
/api/food/favorite        /api/food/measurements    /api/food/nutritional-summary
/api/food/scan            /api/food/scan/test
```

`/api/food/scan` runs the Gemini image-recognition path
(`services/food_scan_service.py`, 390 lines). `/api/food/scan/test` is public
and reports a missing `GEMINI_API_KEY` as a 500.

**Import and export (5 routes)**

```
/api/bulk-import          /api/import-meals         /api/import/validate
/api/import/download-data /api/import/export-template
/api/repair-imported-meals
```

`/api/bulk-import` deserves its own note: it carries **no `@token_required`**,
writes records against a username taken from the request body, and has never
worked — `routes/import_routes.py` never imports `current_app`, and line 1548
is its only use, so every call raises `NameError`. Kept deliberately as of
2026-09-05; see the session report. It appears in no arm document.

**Medication schedules (6 routes)**

```
/api/medication-schedule/<patient_id>
/api/medication-schedule/<patient_id>/<medication>
/api/medication-schedule/<patient_id>/<schedule_id>
/api/medication-log/<patient_id>
/api/medication-logs/recent
/api/my-medication-schedule
/api/insulin-schedule/summary
```

`medication_routes.py` is 971 lines and largely undocumented.

**Remaining (11 routes)**

```
/api/activity-history              /api/doctor/meal-history/<patient_id>
/api/meal/calculate                /api/libre/purge_readings
/api/watch/hr/continuous           /api/watch/hr/raw/<session_id>
/api/watch/test/inject             /api/watch/test/status
```

`/api/meal/calculate` is the dose-calculation preview endpoint — arguably the
single most clinically significant route in the API, and it is not described
anywhere.

---

## §4 Undocumented behaviour in documented areas

### 4.1 There are two authorization models, not one

Arm 0 §0 states:

> `/api/doctor/*` → `check_doctor_patient_access()` guard on every route

True, and Arm 0 §7.1 documents that function properly: it verifies the
requester appears in the patient's `authorized_doctors` list.

What no arm documents is that **three other route modules accept a
`patient_id` query parameter and check only the caller's `user_type`**:

```python
# meal_routes.py:204, 346, 404, 502
# cumulative_effects_routes.py:79, 240
# medication_routes.py:274, 303, 415, 457, 565
if patient_id and current_user.get('user_type') != 'doctor':
    return jsonify({'error': 'Unauthorized access'}), 403
user_id = patient_id if patient_id else str(current_user['_id'])
```

No `authorized_doctors` check. Any account with `user_type == 'doctor'` reads
any patient's meals, cumulative effects and medication schedules.

This is recorded, not raised as an alarm — the deployment is a closed test
environment and the project owner has said so. It belongs in the documentation
because the two models are genuinely different and a reader of Arm 0 would
reasonably conclude there is only one.

Characterized by `backend/tests/test_data_flows.py::TestDoctorAccess`, which
asserts both behaviours so that unifying them produces a visible failure.

**Related:** `medication_routes.py:691` checks `current_user.get('role')`
where every other site checks `user_type`. The field does not exist, so the
branch always denies. Fail-closed, and therefore harmless — but it is a coin
flip that happened to land safely, and it is not documented anywhere.

### 4.2 `user_type` is supplied by the client at registration

Arm 0 §3.3 lists `user_type` among the required registration fields and notes
that invalid values return 400. It does not state that the valid set is
`['patient', 'doctor', 'admin']` and that the value is taken from the request
body with no invitation, verification or approval step. A registration request
may therefore create an `admin`.

### 4.3 `peak_hours` is not where the activity curve peaks

Arm 2 §2 lists `peak_hours: 2.25` among the profile fields without saying what
it denotes. Measured across all eleven peaked insulins, the activity curve is
clamped at 100% and holds a plateau, and `peak_hours` marks the **end** of
that plateau, not its centre or the curve's mode:

| Insulin | Declared `peak_hours` | Actual plateau |
|---|---|---|
| `insulin_lispro` | 2.25 h | 1.57 – 2.26 h |
| `regular_insulin` | 3.00 h | 1.24 – 3.02 h |
| `nph_insulin` | 6.50 h | **2.69** – 6.54 h |

Self-consistent, so not a defect — but a trap for anyone building features
from the value, which is precisely what the ML work will do.

### 4.4 Two kernel functions, two scales

`calculate_gamma_absorption()` returns an activity **percentage** (0–100).
`calculate_absorbed_fraction()` returns a **fraction** (0–1). Similar names,
adjacent in the file, different units. Arm 2 §2 documents neither's range.

### 4.5 MOB and the cumulative meal effect disagree on incomplete records

`calculate_meal_active_carbs()` falls back to `carbs + protein + fat` when
`nutrition.total_carb_equiv` is absent. `calculate_meal_cumulative_effect()`
has no such fallback and returns `0.0`. The same meal can therefore report
47.6 g still absorbing and a 0.0 mg/dL cumulative effect.

Meals written by `submit_meal()` always carry the field (Arm 1 §6-A documents
the formula correctly), so this only surfaces on imported or hand-built
records — which is exactly what a dataset build produces.

### 4.6 IOB and MOB are not strictly monotonic

Both come from fixed-step numerical integration. Measured worst cases:

- NPH IOB rises by 0.045 U at t ≈ 0.98 h (0.91% of a 5 U dose), and peaks at
  5.015 U for a 5 U dose
- `very_fast` MOB rises by 0.108 g at t ≈ 1.63 h (0.18% of a 60 g meal)

Far below clinical visibility. It matters because Arm 2 §9 states sign and
direction conventions that downstream code relies on, and "IOB never
increases" is an invariant a reader would reasonably infer. Bounds are pinned
by `backend/tests/test_pharmacodynamics.py::TestIntegrationArtifacts`.

### 4.7 The `shared/` package does not exist

`mobile/package.json` declares `"@native/shared": "file:../shared"`, and
`mobile/types/api.ts` and `mobile/types/food.ts` import from
`../../shared/src/types`. There is no `shared/` directory. A clean
`npm install` fails, and `tsc --noEmit` reports the missing module. Arm 4 §2
documents the API client foundation without mentioning it.

---

## §5 What the arms get right

Worth recording, because the corrections above are a small fraction of 7,526
lines and the ratio matters.

Verified accurate against the code and the new test suite:

- **Arm 0 §3.1–3.2** — token generation and the `@token_required` decorator,
  including the 90-day mobile / 24-hour web split keyed on `X-Client-Type`,
  and the OPTIONS bypass for CORS preflight. Confirmed by
  `test_route_inventory.py::TestTokenHandling` (8 tests).
- **Arm 0 §7.1** — `check_doctor_patient_access()`. Confirmed by
  `TestDoctorAccess` (5 tests).
- **Arm 0 §6** — FHIR export and GDPR erasure, including the
  `_PATIENT_DATA_COLLECTIONS` inventory rule.
- **Arm 1 §1** — the constants system and its generation into TypeScript.
  Confirmed byte-identical between the login payload and the constants
  endpoint by `TestPatientConstants`.
- **Arm 1 §6-A** — the `total_carb_equiv` formula, matching
  `meal_insulin.py:683` exactly including the full fibre subtraction.
- **Arm 1 §12** — stored document schemas, including the `meals` ↔
  `meals_only` link fields. These were the basis for the orphan sweep's
  classification and proved correct.
- **Arm 2 §1** — the Y/Z/W ODE ground truth.
- **Arm 2 §9** — sign conventions. Confirmed by `TestCumulativeEffects`.
- **Arm 3 §2–3** — `useActiveEffects` and `useBloodGlucoseEstimation`.
- **Arm 4 §3** — the auth service and token validity handling.

The documents' habit of citing file and line is what made this audit possible
at all. Every claim above was checkable in one grep.

---

## §6 Recommended edits, in order

1. **Arm 1 §5-A, line 404 table** — correct the collection list for
   `DELETE /api/meal/<meal_id>`. It is now actively misleading.
2. **Arm 1 §5-A, line 917** — extend the cascade description with dual-id
   resolution and orphan handling.
3. **Arm 0 §9** — add the duplicate-registration rule.
4. **Arm 0 §7** — add §7.5 documenting the second authorization model and
   which modules use it.
5. **Arm 0 §3.3** — state that `user_type` is client-supplied and that the
   valid set includes `doctor` and `admin`.
6. **Arm 2 §2** — document `peak_hours` semantics, the percentage/fraction
   split, the `total_carb_equiv` fallback asymmetry, and the integration
   bounds.
7. **Arm 2 §10** — add the two missing dead-code entries.
8. **New arm document for the food subsystem** — 7 routes, a 390-line Gemini
   service and a 2,688-line food database with no owner.
9. **Extend Arm 1 §11** to cover the five import/export routes.
10. **Extend Arm 0 or Arm 1** to cover the medication-schedule routes.

Items 1–3 are corrections of statements that are now false. Items 4–7 are
additions. Items 8–10 are new coverage and are the larger job.

Arm 5 (`arm5_verification_and_modelling.md`) covers the testing and modelling
foundation and requires no edits to the existing arms beyond the
cross-references already added there.
