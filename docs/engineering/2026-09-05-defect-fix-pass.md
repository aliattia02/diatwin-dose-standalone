# Clearing the open defects

*Session report · 5 September 2026 · immutable once written*

Follows [`2026-09-05-pre-ml-audit.md`](./2026-09-05-pre-ml-audit.md), which
found and characterised D17–D23 but fixed only two of them. This pass fixes the
rest, plus D3 and D9 carried from earlier sessions.

---

## What was asked, and the rule applied

> fix open issues and for that need decision, use logical decision for now and
> mark it as need further decisions in the future

Three of the defects — D21, D22, and part of D3 — were left open in earlier
sessions precisely *because* they needed a judgement call. The rule applied to
each was the same:

**Make the narrowest correction that removes the unambiguous defect, preserve the
existing calibration wherever a number was tuned rather than derived, prefer the
direction that cannot make a clinical warning weaker, and pin what is still open
as a test rather than a comment.**

Every provisional decision is recorded in §5, and each has a test that will fail
if someone later assumes it was settled.

---

## Results

| | Before | After |
|---|---:|---:|
| Backend tests | 375 | **401** |
| Foundation tests | 101 | **101** |
| Mobile tests | 340 | **362** |
| **Total** | 816 | **864** |
| Mobile typecheck | 185 (ratchet) | **185** (ratchet, unchanged) |
| Parity | 410 baselined, exit 0 | **410 baselined, exit 0, 0 new** |

**No parity rebaseline was needed.** Both model changes (D21, D22) were made in
Python, the mobile client and the web frontend together, and the harness reports
zero new divergence across all three pairs. Rule 15 was never invoked.

That is the strongest available evidence the three ports are equivalent: 1,578
cases across six families, and the only remaining disagreements are the same 205
insulin cases that were already baselined.

---

## 1. D17 — a CGM duplicate no longer aborts the batch

`_save_single_reading` does find-then-insert, and `unique_libre_cgm_reading`
exists because that races when two gunicorn workers sync one user at once. The
index's own docstring called the race "harmless"; it was not, because
`DuplicateKeyError` was caught nowhere in the codebase, so the loser raised out
of the `for r in readings` loop and discarded every remaining reading.

Losing that race means the other worker already stored the reading — the same
condition the `find_one` above handles. It is now caught and counted as a skip.

Before: three readings, a collision on the second, **one** stored.
After: three readings, a collision on the second, **two** stored, one skipped.

## 2. D18 — the 401 retry now actually re-authenticates

`_perform_sync` caught `LibreTokenExpiredError`, wrote a past `token_expires` to
Mongo, then called `_get_valid_token(conn_doc, ...)` — passing the caller's
*in-memory* document, loaded before that write and still carrying the original
future expiry. `needs_refresh` was therefore False, the same stale token came
back, and the retry re-sent the identical failing request. Measured: **zero**
calls to the login endpoint, two identical `Bearer token-still-good` GETs.

It now re-reads the connection from Mongo before asking for a token.

The Mongo write is **kept**, and a test pins why. It looks like dead code now
that the retry no longer depends on it, but it is the fallback when the refresh
inside the retry fails: the next scheduler cycle reloads the connection, sees an
expired token, and tries again. Deleting it would turn a recoverable failure into
a permanently stopped CGM feed.

## 3. D19 — the watch sync no longer duplicates every overlapping session

`_perform_sync` deliberately re-fetches an overlapping window
(`since = last_sync - 5 min`, to survive clock skew) and re-segments it. It then
called `insert_one` unconditionally: no guard, and
`google_fit_activities_time_range` was not unique. A bout inside the overlap was
written once per sync that saw it — not a race, the ordinary path, every cycle.

Two changes, matching the shape the CGM path already had:

* a find-then-insert guard on `(user_id, source='google_fit', startTime)`, the
  key a deterministic segmenter re-derives identically;
* `unique_google_fit_session`, a **partial** unique index scoped to
  `source: "google_fit"` — hand-logged activities are untouched, since a patient
  may legitimately log two starting at the same time.

`_perform_sync` now returns `duplicate_count` alongside `new_count` and
`skipped_count`, so the overlap is visible in the logs instead of silent.

A negative test guards the obvious over-correction: a guard keyed too broadly
would make every sync after the first a no-op and stop the activity stream
entirely, which is worse than the duplication it replaced.

## 4. D3 — malformed JSON is a 400, and two things found on the way

`@api_error_handler` had one blanket `except Exception` returning 500. A
malformed body makes `request.json` raise `BadRequest`, so a client's bad JSON
was reported as a server fault and logged at error level, hiding real faults.

`HTTPException` is now re-raised with the status it already carries. That is a
**global** fix — 80 routes carry the decorator — and it also fixes a quieter
case: an `abort(404)` inside a decorated route used to come back as a 500.

Two things surfaced while fixing it:

* **The decorator alone was not enough.** `blood_sugar.py` has its own broad
  `except Exception` that beat it to the exception. That now re-raises
  `HTTPException` too, and `request.json` in the *log* statement became
  `request.get_json(silent=True)` — a malformed body must not raise from inside
  logging.
* **The 500 path leaked internals.** It returned `jsonify({'error': str(e)})`,
  so an unexpected fault could hand a connection string or file path to the
  caller. The message is logged; the response is now generic. A test asserts a
  planted secret does not appear in the body.

`/api/bulk-import` is unaffected — it does not use the decorator, and its
standing decision (kept non-functional) is preserved.

## 5. D9 — every daily reset now resolves to one definition

`getDailyResetTime` anchored the reset day on the **UTC** calendar date, which
is right only while the patient's local date matches it. East of +07:00 it does
not — at 20:00 UTC a patient at UTC+13 is already on the next local day — and
because each copy's rollback could only move the candidate *backwards*, the
boundary came out exactly 24 h early. Every "since the daily reset" guard
downstream then admitted an extra day of meals, doses and activity.

The handoff asked before fixing, because it changes what a patient sees. **The
decision taken is the one the handoff itself suggested: consolidate onto
`TimeManager` rather than patch each site.** That removes the class of bug rather
than an instance, and TimeManager was already the implementation the Python
backend, ChartUtils and the insulin timeline generator agreed with.

The audit said three sites. There were **four** — `hooks/useActiveEffects.ts`
was named in Arm 5 §6.4 and had been missed:

| Site | |
|---|---|
| `blood-glucose-estimation.ts` | `getDailyResetTime`; `getLastResetTime` now forwards, since TimeManager already does the rollback and doing it twice lands 24 h early the other way |
| `meal-pharmacodynamics.ts` | the inline `getLastResetMs`, written that way "to avoid a circular import" — TimeManager imports neither module, so there was never a cycle |
| `calculations/cumulative-effects.ts` | re-exports the first; fixed transitively |
| `hooks/useActiveEffects.ts` | one of its four reset computations; the other three already worked in patient-local milliseconds |

`__tests__/daily-reset-consolidation.test.ts` is the guard against the class:
every exported reset path asserted equal to TimeManager across nineteen offsets
(−12:00 to +14:00, including the half-hours), at every hour of the day and every
legal reset hour, plus four properties — never in the future, never more than a
day back, lands on the reset hour in the patient's local clock, advances by
exactly one day across a boundary. A fifth copy fails the moment it disagrees.

**Patient-visible effect:** for offsets east of +07:00, meals and doses from
before the reset are now correctly excluded from today's totals. Those patients
will see *lower* active-carbohydrate and IOB figures during the affected slice of
each day (1 h at +08:00, rising to 7 h at +14:00). The old figures were wrong.

---

## 6. The two model defects, and the decisions inside them

Neither was caught by parity — all three implementations shared both, so parity
proved they agreed, not that what they agreed on was right. Both were fixed in
all three at once.

### D21 — the meal absorption curve

Three distinct problems sat under one defect number. Two are fixed; one is
deliberately not.

**(a) The plateau — fixed.** The gamma branch was normalised by its value at
`peak_hours`, but the density `x^(k-1)·e^(-x/θ)` peaks at `x = (k-1)·θ`. Those
coincide only when `(k-1)·scale_param == 1`, which held for **none** of the six
shipped profiles — so the ratio exceeded 1 either side of the true mode and
`min(100, …)` clamped it flat. Measured: **18.6% (very_fast) to 38.5%
(very_slow)** of every absorption window sat at exactly 100, carrying no
information at all.

*Decision:* normalise by the curve's true maximum. This removes the plateau
**without changing the curve's shape**, and `calculate_absorbed_fraction`
divides by total area, so it is invariant to the rescaling itself.

The alternative — reparameterising so `(k-1)·scale == 1`, making `peak_hours`
genuinely the mode — was rejected. For `very_slow` (k = 1.2) it forces
`θ = 5·normalized_peak`, leaving the curve at 62% of peak when the window closes
and turning a modest end-of-window truncation into a cliff. That is a bigger
change to every profile's tail than the defect being fixed.

Measured after: clamping **0.0%** on every profile; the peak lands at the true
mode (medium 1.11 h, very_slow 1.90 h); absorbed fraction still reaches 1.000.

**(b) `peak_hours` is not the mode — NOT fixed, open.** The curve now peaks
where the density peaks, but `peak_hours` still names the *normalisation*
parameter. The gap is up to 1.6 h (`very_slow`: mode 1.90 h, `peak_hours`
3.50 h). Anyone editing a profile expecting `peak_hours` to move the peak will
change the shape instead. Closing it means reparameterising every profile, which
changes each tail — a clinical decision. Pinned in
`TestStillOpen::test_peak_hours_still_does_not_name_the_mode`.

**(c) The discontinuity at onset — fixed.** Below onset the curve ramped
linearly to exactly 5, while the gamma branch opens at ~0 because `t^(k-1) → 0`
for every `k > 1`. Absorption rate therefore *dropped* by a full 5 percentage
points at the instant gastric emptying completed — the opposite of the physiology
`onset_hours` describes.

*Decision:* return 0 before onset. This is continuous **and** is what the model
says: before emptying is done, carbohydrate has not reached the absorptive
surface. Keeping the ramp would have required the gamma branch to start at 5,
which no reparameterisation of a gamma density gives you.

**A consequence, caught by parity.** Removing the ramp steepened the curve's
rise, which increased the left-Riemann error in `calculate_absorbed_fraction` —
both integrals are 100-step sums but over *different* step sizes, so their
errors do not cancel. `very_fast` reached **1.000316**: more than all of the
carbohydrate absorbed.

Clamping to [0, 1] is definitional, not cosmetic, and it also removed a
pre-existing backward step on the 5-minute display grid — the dip was the
overshoot coming back down. Making the estimator itself exact would mean a
common fixed grid, which shifts every absorbed value slightly; left open.

Worth recording how this was found: the clamp went into Python first, and the
parity harness immediately reported **three new `meal_abs::very_fast`
divergences** with Python as the odd one out. That is the harness doing exactly
the job it exists for.

### D22 — the acute exercise effect

`dZ/dt = (1 - Z)` integrated with `dt = 1` minute sets `Z` to exactly 1.0 in a
single Euler step from any starting value. Heart rate decided only *whether* the
gate opened, never how far. Measured at 45 minutes, HRbase 60, HRmax 190:

| | peak HR | Z (before) | drop (before) | Z (after) | drop (after) |
|---|---:|---:|---:|---:|---:|
| light | 125.0 | 1.000000 | 6.4500000000 | 0.6250 | 4.0312 |
| moderate | 144.5 | 1.000000 | 6.4500000000 | 0.8125 | 5.2406 |
| vigorous | 164.0 | 1.000000 | 6.4500000000 | 1.0000 | 6.4500 |

*Decision:* `Z` relaxes toward the Karvonen heart-rate reserve fraction
`(HR − HRbase)/(HRmax − HRbase)` — the standard proxy for %VO₂max, which is what
Dalla Man, Breton & Cobelli (*J Diabetes Sci Technol* 2009;3(1):56-67) drive
insulin-independent glucose utilisation from.

Two sub-decisions, both deliberate:

1. **Divide by `z_reference_hr_reserve = 0.80`**, the vigorous tier, rather than
   normalising to 1.0 at HRmax. `acute_rate_per_min` was calibrated against a Z
   that always saturated, so its calibration *is* the vigorous case. Anchoring
   there leaves vigorous byte-identical to before and moves only the intensities
   that were previously overstated. **Nothing gets a larger predicted drop than
   it did**, which is the safe direction: the model does not start under-warning
   about exercise-induced hypoglycaemia.
2. **Linear in HR reserve.** Monotone, bounded, calibration-preserving, and the
   simplest thing that is defensible. It is almost certainly not the true
   response.

**Provisional, and pinned as such** in
`TestStillOpen::test_the_intensity_response_is_linear_and_that_is_an_assumption`,
which asserts the response is *exactly* linear and names the paper. Matching
Dalla Man's functional form needs the literature and a clinician, not more code.

`z_reference_hr_reserve` was added to `Constants.HR_MODEL` and the
mobile/frontend constants regenerated from it, so all three implementations read
one value. A local copy on any side would surface as a parity divergence.

Still open and unchanged: the **sensitivity multiplier** saturates at its cap for
any session of 15 minutes or more, so that channel still does not distinguish a
gentle walk from a hard interval session.

---

## 7. What the ratchet caught

The typecheck ratchet introduced in the audit earned its place within the hour:
editing `meal-pharmacodynamics.test.ts` added two `TS18048` errors
(`p.scaleParam` possibly undefined) and the ratchet failed the run, naming the
file and the count. Fixed rather than re-recorded — the count is still 185.

That is the behaviour the old always-red `tsc --noEmit` gate could not provide.

---

## 8. Still open

| | | |
|---|---|---|
| **D2** | Kept by decision | unchanged |
| **D4** | 191 → 185 typecheck errors, now ratcheted | the remaining 185 are triaged in the audit §5 |
| **D5** | MOB and cumulative meal effect disagree | untouched this pass |
| **D21b** | `peak_hours` names the normalisation parameter, not the mode | needs clinical review |
| **D22 shape** | The intensity response is linear because linear is simple | needs Dalla Man 2009 and a clinician |
| — | The absorbed-fraction quadrature uses two different grids | clamped, not made exact |
| — | Meal activity is truncated at `duration_hours` rather than tapering | `very_slow` carries ~47% of peak at the cliff |
| — | The activity sensitivity multiplier saturates at ≥ 15 min | intensity still invisible in that channel |
| — | The α = 4.5 insulin branch behind the 205 baselined divergences | pharmacokinetics, not code |
| — | `diatwin/sim` violates rule 1 transitively via `backend/constants.py` → `bson` | found in the audit |
| — | 200,889 AZT1D basal rows unrepresented; 1,858 exercise rows unconverted | audit §4 |

The three fixed-by-decision items (D9, D21a/c, D22) all changed clinical output.
Each is provisional in the sense that a clinician may want a different answer —
but none of them is provisional in the sense of being *arbitrary*: each replaced
a measured defect with the narrowest behaviour that is defensible from the
model's own stated physiology.
