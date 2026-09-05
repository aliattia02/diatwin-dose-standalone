# The two repositories

There are two copies of DiaTwin on disk, and they are not the same thing. This
document says what each one is for, so nobody has to guess which to open.

| | `native3` | `diatwin` (this one) |
|---|---|---|
| **Path** | `C:\Users\aliat\Projects\native3` | `C:\Users\aliat\Projects\diatwin` |
| **Remote** | `aliattia11/native` | `ClidaTech/diatwin` (private) |
| **History** | 752 commits | 1 commit — fresh start |
| **Role** | The original. Left untouched as a reference. | The working copy. Test and build here. |
| **Tests** | 468 | **656** |
| **Parity families** | 2 (insulin only) | **6** (insulin, meal, activity) |
| **Parity cases** | 966 | **1,578** |
| **`parity compare`** | exits **1** — no baseline mechanism | exits **0** — baselined and gated |
| **Clinical subject data** | present | **excluded** |
| **Credentials in history** | **yes** — see below | no |

---

## Why there are two

`native3` accumulated 752 commits, and two of them (`17ff371`, `2f7b5ff`)
committed `azt1d_patient_credentials.json` and
`hupa_patient_credentials_simple.json` — plaintext passwords and JWTs for 25
study accounts. They were later gitignored, but git history keeps what it is
given, and that history is already on `aliattia11/native`.

Cloning that history into a new repository would have carried the credentials
into a second location. So this repository starts fresh instead: one commit,
containing the working tree and nothing else. The old history stays where it
already is, and nothing new is published.

**The 25 study accounts still need rotating.** Starting fresh here does not
undo the earlier exposure.

---

## What is in this repository that is not in `native3`

Four defects were found, characterised with tests, and fixed here. `native3`
still has all of them.

| | What it was | Effect |
|---|---|---|
| **D10** | `calculateMealActivity` and `isMealActive` used a bare `new Date(meal.timestamp)` while the reset guard three functions away normalised the same field | A numeric-string timestamp read as a fully-absorbed meal; a bare ISO string shifted every absorption figure by the device's UTC offset (MOB 6.6 g instead of 21.6 g on a UTC+1 device) |
| **D11** | `getDoseTimestamp` threw for a dose with no timestamp field | One malformed row in an API payload lost every other meal and dose in the same call — the whole dashboard |
| **D12** | An unknown absorption type fell back to *full* absorption in one function and *skipped the meal* in another, both reached from `calculateNetEffect` | The baseline was computed without the meal and the cumulative term added all of it: 200 mg/dL from one mislabelled 50 g meal |
| **D13** | The insulin timeline used `setHours`/`getHours` and ignored `timezone_offset_minutes` | A patient's day rolled over at their *phone's* reset hour, not their own |

Every test asserting one of these fixes was run against the pre-fix code and
fails there. A regression test that passes either way is not evidence.

**Also here and not in `native3`:**

- Test coverage for the three calculation modules that had none —
  `blood-glucose-estimation.ts` (1,059 lines), `meal-pharmacodynamics.ts`
  (747), `activity-pharmacodynamics.ts` (733).
- Four new cross-language parity families. The meal and activity models had
  never been compared against the Python backend before. **They agree exactly**
  — the activity families are bit-identical across 396 cases.
- A working baseline gate for the parity harness. Arm 5 §5.1 described one; it
  had not been implemented, so `compare` failed unconditionally on the 205
  known insulin divergences and the CI job would have been red from its first
  run.
- `SETUP.md` and `backend/.env.example`. A clean clone of `native3` cannot run
  the backend suite: `backend/__init__.py` imports `config` as the parent
  package, so `conftest.py`'s `MONGO_URI` default never gets a chance to apply.

---

## What is in `native3` that is not here

Deliberately excluded, and gitignored so it cannot be swept back in:

- **`docs/Clinical Validation/`** — 110 files including 57 per-subject CGM
  records from AZT1D 2025. Real human-subject health data. Nothing in any test
  suite reads it. Copy the folder in locally if you need the conversion
  pipeline.
- **`*credentials*.json`** — the study-account files described above.
- **`.env` files** and **`backend/old.env`** (a stale localhost dev config).
- **`docs/_draft/`** and `backend/config-draft local.py`.
- **`security-reports/`** — six strategy and audit markdown files, excluded by
  the repository's own `.gitignore` rule. They are not tracked in `native3`
  either, so nothing was lost. `git add -f security-reports/` if you want them.

---

## One defect is still open in both

**D9 — the daily reset boundary is 24 hours stale for UTC offsets east of
+07:00.** `getDailyResetTime` in `blood-glucose-estimation.ts` anchors the reset
day on the *UTC* calendar date rather than the patient's local one, and
`getLastResetTime` only ever rolls that candidate back, never forward.

Condition: `timezone_offset_minutes > daily_reset_hour × 60`. The affected slice
of each day is `offset_hours − reset_hour` hours long — one hour at +08:00,
six at +13:00. The error is always exactly 24 h. Offsets at or west of +07:00
are never affected, which is why it has not surfaced in use.

Effect: yesterday's meals and doses are counted in today's cumulative baseline.
Measured at +13:00, a 60 g meal from the previous window contributes
213.6 mg/dL that should be 0.

It is characterised by tests in two suites and **left unfixed on purpose**. It
changes what a patient sees, and the fix lands in four places —
`blood-glucose-estimation.ts`, the inline guard in `meal-pharmacodynamics.ts`,
`hooks/useActiveEffects.ts`, and `cumulative-effects.ts` which re-exports the
first. Consolidating all four onto `TimeManager` is the right shape of change
and deserves a deliberate decision, not a cleanup slipped in alongside test
coverage.

`utils/insulin/timeline-generator.ts` was the fifth site and is already
consolidated, which is what D13's fix did.

---

## Which one to use

**Use this repository.** It is the tested one, and it is where new work goes.

Keep `native3` as the reference for anything the exclusions removed — the
clinical validation data and the full commit history. Its code is at the
pre-session state, so do not compare behaviour against it and expect a match:
the four fixes above are not there.

A note on `native3/docs/engineering/`: those documents were updated during the
session that produced this repository, so they describe **this** repository's
state — 656 tests, six parity families, D10–D13 fixed — not the code sitting
next to them. The same documents are here, where they are accurate.

## Getting set up

See [`SETUP.md`](./SETUP.md) — clone to a green test run, verified end to end.
