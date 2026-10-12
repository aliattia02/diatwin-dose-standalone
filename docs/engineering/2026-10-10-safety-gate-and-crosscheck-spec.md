# Safety gate and SimGlucose cross-check: specification (10 Oct 2026)

**Status: specification only. Nothing here is validated for clinical use. Research use only.**
No dose logic, constant, pharmacodynamic parameter or clinical rule was changed. No gate code and no adapter code
was written. All data is synthetic; no database was connected (`MONGO_URI` pointed at an unreachable host).
A language model never produces, changes or rounds a dose: every dose number comes from
`backend/utils/dose_math.py` through `backend/tools/dose_cli.py`.

Labels: **[V]** read in the code or measured here · **[C]** stated in a document, not run · **[E]** my estimate.

Branch `dose-crosscheck-spec`, from `main`. Background and decision log live in the AI-agent repository
(`docs/07-Decision-Log.md` K100, K101; `docs/15`, `docs/16`, `docs/25` section 6, `docs/26` section 1).

---

## 0. Open questions for the owner (answer these first)

Every limit and threshold the gate or the cross-check needs is a question. I chose none. "Where the repo already
states a value" gives the file and line; that value is quoted, not recommended. Values written as "e.g." are only
there to make an option concrete.

### 0.1 Safety gate

| # | Question | Options | What each would change | Already stated in the repo |
|---|---|---|---|---|
| G1 | **Maximum single dose** (U): the largest suggestion the gate lets through | (a) one fixed number for everyone; (b) per patient, from a patient constant the clinician sets (a new field); (c) a multiple of the patient's own typical dose or total daily dose; (d) no maximum (today's behaviour) | (a) is simple and the same for a child and an adult; (b) puts the number with the clinician and needs a constants field and an API range check; (c) needs a trusted history or TDI input; (d) leaves the 500 g meal case at 53.5 U (probe F) | **None.** No maximum exists in `dose_math.py` or `dose_cli.py` [V]. The only dose-related ranges are `min_dose_units` 0 to 2 and `dose_step_units` above 0 up to 1 in `backend/routes/doctor_routes.py:241-250` [V], which are API validation, not a dose limit |
| G2 | **Reading too old** (minutes): above this the gate vetoes a correction dose | (a) a fixed age; (b) a multiple of the reading interval (CGM 5 min); (c) different ages for meter and CGM; (d) never veto, caveat only | smaller age = more vetoes at night or on sensor gaps; (d) is today's behaviour | Mobile marks an estimate older than **360 min** as `very_low` confidence, not a veto: `docs/documentation/insulin-suggestion-logic.md:282` [C]. Python only passes `minutes_since_reading` through for display: `dose_math.py:72,250` [V] |
| G3 | **No reading at all**: veto, or allow meal-only dose with a caveat | (a) veto any dose; (b) allow carb-only dose (no correction) with a caveat; (c) veto only when `blood_glucose` is null and the dose would include a correction | (b) matches today's output (probe E: 6.0 U for 60 g with no BG); (a) removes meal boluses when the sensor is off | `dose_math.py:109-111`: no BG means correction 0, the meal dose is still given [V] |
| G4 | **Low glucose now** (mg/dL): veto insulin below this reading | (a) one threshold; (b) two tiers (caveat, then veto); (c) per patient | lower = fewer vetoes, a dose can be suggested into a low; higher = more refusals | Related values only: 55 and 220 are hard clamps on the *estimated baseline*, `backend/constants.py:171-172` [V]; mobile snack message below `target - 10`, `docs/.../insulin-suggestion-logic.md:484` [C]; 40 is the display floor in `docs/15` [C, AI-agent repo] and the lower bound of the mobile BG used for correction, `mobile/services/insulinCalculationService.ts:1000` [V]. The widely published hypoglycaemia levels (70 and 54 mg/dL) are general knowledge, **not** in this repo [E] |
| G5 | **Forecast low**: horizon (min), threshold (mg/dL), and which forecast value is compared (point forecast, or lower bound of an interval) | combinations of: horizon e.g. 60, 120, 240 min; threshold same as G4 or its own; point value or the lower bound | longer horizon and lower-bound comparison veto more; the kernel forecast is not calibrated to a person (`diatwin/README.md`, "residual" section [C]) | Kernel forecast exists (`PatientSim.trajectory`, `diatwin/sim/patient.py:297-304` [V]); `docs/15` says a forecast below about 40 is shown as `<40` [C] |
| G6 | **Falling fast**: rate (mg/dL per min or per 5 min) and the window it is measured over | (a) rate over the last 2 readings; (b) over a fixed window (e.g. 15 or 30 min); (c) a smoothed slope | short window = noisy CGM triggers vetoes; long window = misses fast falls | **None** in the dose path [V]. The version note of `docs/.../insulin-suggestion-logic.md:8-10` mentions a trend rate in the mobile engine [C] |
| G7 | **Insulin stacking**: when does active insulin veto a new dose? | (a) active insulin above a fixed number of units; (b) active insulin above a fraction of the proposed dose; (c) active plus proposed dose above a ceiling; (d) veto when `post_active_total` is below a threshold (the mobile surplus warning, which is a message, not a veto) | (d) re-uses a number the app already shows; (a)-(c) are new numbers | Mobile surplus warning at `post_active_total < -0.5 U`, `insulinCalculationService.ts:1036-1043` [V]. Python subtracts active insulin and clamps at 0 (`dose_math.py:200,209`) [V] but never vetoes |
| G8 | **Plausibility range for inputs** (BG, carbs, active insulin, dose): outside it the gate vetoes as "invalid input" | (a) a range per quantity; (b) only reject non-numbers/negatives; (c) none | today BG 0, BG -50 and 500 g are all accepted (probes F, G, H, J) | CGM sensor range in SimGlucose's own file: 39 to 600 mg/dL, `external/simglucose/simglucose/params/sensor_params.csv` [V]. Repo clamp 55 to 220 is for a baseline, not an input range |
| G9 | **What counts as a caveat** on an allowed dose (list) | e.g. reading estimated (`blood_sugar_source` = `estimated` or `target_fallback`, `dose_math.py:114-120`), dose lowered by rounding, near a limit (how near?), forecast unavailable | more caveats = more noise for the reviewing clinician | `breakdown.blood_sugar_source`, `minutes_since_reading`, `raw_total` vs `total` already returned [V] |
| G10 | **Where the gate lives** | (a) new package `diatwin/safety/` as `docs/15` describes (stdlib plus kernel only, per Arm 5 rule 1 [C]); (b) next to `dose_cli` in `backend/tools/` | (a) matches the hub's rules; (b) is closer to the one dose function | `docs/15` says `diatwin/safety/constraints.py` [C]; it **does not exist** here [V] |
| G11 | **Mobile and web**: they compute doses on the device. Does the gate also exist there (a third and fourth implementation, with the parity harness), or only in the Python path that the hub and any RL step use? | (a) Python only; (b) Python plus parity cases for mobile and web | (b) is the only way a person using the app is covered; it is also the most work and adds two more places to diverge (`diatwin/README.md` records 205 divergences found by the harness [C]) | `docs/.../insulin-suggestion-logic.md:26`: dose calculation runs on-device [C] |

### 0.2 Cross-check with SimGlucose

| # | Question | Options | What each would change |
|---|---|---|---|
| X1 | **Python for SimGlucose.** The packaged install builds but does not import on Ubuntu's system Python 3.12 (section 4: `No module named 'distutils'`, raised by `gym==0.9.4`). | (a) stop here; (b) allow a separate Python 3.11 (needs a download: source and size to be named before I fetch it); (c) allow `setuptools` into that venv (restores `distutils` on 3.12; that is a change to the environment, not to simglucose, but I did not try it because you asked for no patching); (d) use the maintainer's newer line if one exists on PyPI (not checked) | (a) no cross-check possible now; (b)-(d) each need your approval; each changes what "unmodified" means and has to be recorded |
| X2 | **Target glucose** for each virtual patient | (a) 140, SimGlucose's own `BBController` default; (b) our default 100 (`constants.py:234`); (c) a fixed clinician-chosen value; (d) each patient's `Gb` (basal glucose, 133 to 153 mg/dL in the shipped file) | moves every correction dose; SimGlucose ships **no** per-patient target [V] |
| X3 | **Pen or pump** (dose step 0.5 or 0.1 U) | (a) pump; (b) pen; (c) both as two arms | with pen, small meals round to 0 below 0.5 U; step is applied in our code, SimGlucose does not quantise to a device step |
| X4 | **Which patients**: all 30, only adults, a subset | 30 (10 adults, 10 adolescents, 10 children) or fewer | children and adolescents have much lower CR and CF ranges (section 5.2); a dose rule that works for adults may not for children |
| X5 | **Glucose input to dose_cli**: true glucose (`Gsub`) or the simulated CGM | (a) `Gsub`; (b) Dexcom 3 min (noise, 3-min grid); (c) GuardianRT 5 min (noise, matches our grid) | (b)/(c) include sensor noise and lag, closer to the app; (a) isolates the dose rule |
| X6 | **Active insulin source** in the loop | (a) our kernel's IOB from the doses already given in the run (what the app would use); (b) SimGlucose's subcutaneous insulin compartments | (a) tests the whole app chain, including kernel IOB errors; (b) tests only the arithmetic |
| X7 | **Pass or fail thresholds** for every outcome measure in section 5.4 (time in range, time below range, lowest glucose, time above range, agreement with the kernel forecast) | numbers or "report only, no threshold" | I propose none; without them the run produces numbers and no verdict |
| X8 | **Scenarios** (meals per day, sizes, missed meal, BG high at the start, exercise is not available) | list in section 5.4 as a start | more meals and extremes find more failure modes and cost wall time (one simulated day was 13.6 s on one patient in docs/26 [C]) |
| X9 | **Comparator policies** | (a) no bolus; (b) SimGlucose `BBController`; (c) dose_cli only; (d) dose_cli plus gate | (c) vs (d) is the only place the gate's own effect shows; (a)/(b) give scale |
| X10 | **Insulin type used by our kernel** for the virtual patient's forecast | the kernel default is `insulin_aspart` (`dose_math.py:162-171`) [V]; SimGlucose has no insulin types, one kinetic model per patient [V] | the forecast comparison (section 5.4, B) depends on this choice |

### 0.3 Defects and disagreements I found and did **not** change (for your triage)

| # | Finding | Where | Label |
|---|---|---|---|
| D1 | `dose_cli` accepts `dose_step_units: 0` and then crashes with `ZeroDivisionError`, exit code 1, no JSON. The API range check (above 0, up to 1) is not applied in the CLI | `dose_cli.py:42-46,59-66`; `dose_math.py:30`; `doctor_routes.py:241-245` | [V] probe K |
| D2 | A JSON body that is not an object (e.g. `[1,2]`) gives a traceback, exit 1, no JSON; only `ValueError`, `TypeError`, `KeyError` give `{"error"}` and exit 2 | `dose_cli.py:62` | [V] probe T |
| D3 | `blood_glucose` of 0 or a negative number is accepted and lowers the dose (BG 0 with 60 g gives 3.5 U instead of 6.0 U). The mobile engine only computes a correction when BG is above 0 | `dose_math.py:111-113` vs `insulinCalculationService.ts:1002` | [V] probes G, H |
| D4 | Negative `active_insulin` raises the dose (-3 U gives 3.0 U at BG 100); nothing checks the sign | `dose_math.py:200` | [V] probe J |
| D5 | `health_multiplier` is unbounded (x5 gives 18.5 U for BG 250 only) | `dose_math.py:206` | [V] probe M |
| D6 | `insulin-suggestion-logic.md` Step 8 says "round to 0.1 u, floor at 0.5 u" (and the flow chart at line 592). The code (all three languages) rounds **down to the device step** and gives **0 U** below the minimum, per the 26 Sep 2026 decision | doc `:248-258,592`; code `dose_math.py:25-30`, `dose-rules.ts`, `insulinCalculationService.ts:1070-1074` | [V] |
| D7 | The same document says the IOB surplus warning exists "in both modes"; the Python path has none (`grep surplus backend` finds nothing) | doc `:507`; `backend/` | [V] |
| D8 | `docs/15` (AI-agent) and `docs/25` state a `SafetyGate` in `diatwin/safety/`; this repository has no `diatwin/safety/` and no mention of `SafetyGate` in any `.py`, `.md`, `.ts` or `.js` file | `diatwin/` | [V] |
| D9 | `docs/16` findings F1 (0.5 U floor stacks insulin) and F2 (implicit rounding) are resolved in the code by the 26 Sep rule; F3 (refuse missing constants) is implemented in `dose_cli.py:42-44` | `dose_math.py:25-30`, `dose_cli.py` | [V] |
| D10 | `SETUP.md` expects 280 passed + 1 skipped (backend) and 65 passed (`diatwin/tests`); the suites now have more tests (section 1). The ten backend failures need packages that `SETUP.md` does not install (section 1) | `SETUP.md` | [V] |

---

## 1. Baseline

Where: the Windows system Python 3.14.8 has no venv for this repo and lacks Flask, PyJWT and mongomock. I asked
before installing; the answer was a venv in WSL (Ubuntu 24.04, Python 3.12.3), outside both repos:
`~/venvs/dose-backend`, 114 MB, from `backend/requirements.txt` (a UTF-16 file; converted to UTF-8 in a scratch
folder, not in the repo) and `requirements-dev.txt`. `MONGO_URI=mongodb://unreachable.invalid:27017/none`, no
`backend/.env` created, `PYTHONDONTWRITEBYTECODE=1`, `-p no:cacheprovider`. No key was read or printed.

| Run | Result [V] | SETUP.md says |
|---|---|---|
| `backend/tests`, WSL venv | **449 passed, 1 skipped, 10 failed** in 399 s | 280 passed, 1 skipped |
| `diatwin/tests`, WSL venv, fixtures from the repo | **86 passed, 15 skipped** | 65 passed (after step 4) |
| `diatwin/tests` after `parity generate` and `parity python` | 86 passed, 15 skipped (the 15 need the mobile results file as well) | 65 passed |
| `diatwin/tests`, Windows system Python 3.14 (before any install) | 79 passed, 15 skipped, **7 errors** (`No module named 'jwt'`, `TestPatientSim`) | |
| `node diatwin/verify/frontend_eval.mjs` (Windows Node 24.18.0) | evaluated 1730 cases (frontend) | |
| `mobile` jest, `parity compare`, `tsc` | **not run** (needs `npm install`; not approved, not needed for this task) | |

The ten failures are all in `backend/tests/test_ml_snapshot_routes.py` (`TestListSnapshots`, `TestGetManifest`).
Those tests write snapshots through `diatwin/ml/export.py`; the venv has no `pandas`, `pyarrow`, `numpy` or
scikit-learn, which `requirements-ml.txt` lists and `SETUP.md` does not mention [V: the packages are absent; the
failure traceback is in section 1.1]. I did not install `requirements-ml.txt` (not approved) and did not edit any test.

Side effects of the run: `parity generate` rewrote the tracked `diatwin/verify/fixtures/cases.json`
(line endings only); I restored it with `git checkout`. Two untracked-and-ignored result files remain under
`diatwin/verify/fixtures/`. The working tree of the branch is otherwise unchanged.

### 1.1 Cause of the ten failures

One failing test was re-run alone with a full traceback [V]
(`test_unauthenticated_is_401_not_500`): `ImportError: pyarrow is required for snapshot export. pip install -r
requirements-ml.txt` (`diatwin/ml/export.py:85`). The message says this is deliberate. So the ten failures are the
ten tests that need the modelling packages, not a dose or safety regression; I inferred the same cause for the other
nine from the shared fixture and the identical test class, not from nine separate tracebacks [E]. The same run
took 366 s in test setup: the app fixture tries to create database indexes against the unreachable `MONGO_URI` and
each attempt waits for a timeout (`db_indexes` errors in the log), which would explain the 399 s of the whole suite [E]. I left it as it is.

---

## 2. Inventory of what exists (read only)

### 2.1 `dose_cli` interface [V]

`backend/tools/dose_cli.py`: reads one JSON object on stdin, writes JSON on stdout.

| | |
|---|---|
| Input | `constants` (required keys: `insulin_to_carb_ratio`, `correction_factor`, `target_glucose`, each a number above 0 and not a boolean, `:24,42-44`; optional: `insulin_delivery` `pen` or `pump` `:45`, `dose_step_units`, `min_dose_units`, `protein_factor`, `fat_factor`, ...), `nutrition` `{carbs, protein, fat, fiber, absorption_type}` (missing numbers 0, `:49`), `blood_glucose` (mg/dL or null), `active_insulin` (U), `active_meal_carbs` (g), `activity_impact`, `health_multiplier` (`:50-51`) |
| Output | `{"total", "breakdown", "provenance"}`; `total` is the dose in units after the minimum-dose and step rules; `breakdown.raw_total` is the unrounded number; `provenance.producer` = `rules:utils.dose_math.compute_suggested_insulin`, `version` = git short hash or `unknown` (`:54-55`) |
| Errors | `{"error": ...}` and exit 2 for `ValueError`, `TypeError`, `KeyError` (`:59-66`); anything else is a traceback with exit 1 (D1, D2) |
| State | none; no database, no clock, no network. It reads **no patient history**: active insulin and active meal carbs are numbers the caller supplies |

### 2.2 Safety-relevant rules already in the code

| # | Rule | File:line | Label |
|---|---|---|---|
| R1 | Refuses missing or non-positive ICR, CF, target (no defaults) | `dose_cli.py:24,42-44` | [V] probe S |
| R2 | `insulin_delivery` must be `pen` or `pump` | `dose_cli.py:45`; API `doctor_routes.py` (`insulin_delivery` check just above `:241`) | [V] |
| R3 | Below `min_dose_units` (default 0.5) the dose is **0 U** | `dose_math.py:25-27`; default `constants.py:261` | [V] probes B, R |
| R4 | Otherwise rounded **down** to the device step: pen 0.5 U, pump 0.1 U, or `dose_step_units` | `dose_math.py:15,18-22,29-30`; `constants.py:260` | [V] probes A, P, Q (3.75 gives 3.5 pen, 3.7 pump; 1.1 gives 1.0) |
| R5 | Never negative: `max(0.0, final)` before the rules | `dose_math.py:209` | [V] probes B, D |
| R6 | Active insulin subtracted from the need; active meal carbs added back as insulin | `dose_math.py:139-140,200` | [V] |
| R7 | Overlap adjustment between 0.5 and 1.5 when meal or insulin is on board (uses fixed 1.0 h and 1.5 h elapsed estimates) | `dose_math.py:147,159,187-192` | [V] |
| R8 | Correction may be negative (BG below target lowers the dose) | `dose_math.py:108-113` | [V] probe C |
| R9 | No BG: correction is 0, meal dose still given; the note says "target_fallback" or similar | `dose_math.py:109-111,114-120` | [V] probe E |
| R10 | Invalid calculation factors raise `InvalidCalculationFactors`; the app wrapper falls back to default factors | `dose_math.py:33,84-86`; `meal_insulin.py:395-399` | [V] (code read) |
| R11 | Estimated-baseline hard clamp to 55 to 220 mg/dL with a CRITICAL warning | `constants.py:171-203`; used `pharmacodynamics.py:1148` | [V] (affects estimated BG, not `dose_cli` input) |
| R12 | Log warning if the calculated baseline is below 40 | `pharmacodynamics.py:1156` | [V] log only |
| R13 | Mobile: surplus warning when `post_active_total < -0.5 U`; the doc says the UI hides the dose and offers carbs | `insulinCalculationService.ts:1036-1043`; doc `:206-217` | [V] code, [C] UI |
| R14 | Mobile: BG used for the activity-adjusted correction is floored at 40 | `insulinCalculationService.ts:1000` | [V] |
| R15 | Mobile UI: "blood sugar going low, take a snack" below `target - 10` | doc `:484-486` | [C] |
| R16 | Mobile timing floors for slow meals (20 and 30 min) | doc `:398-401` | [C] (timing, not amount) |
| R17 | API range checks: `min_dose_units` 0 to 2; `dose_step_units` above 0, up to 1; `insulin_delivery` pen or pump | `doctor_routes.py:236-250` | [V] |

### 2.3 Gate checks of `docs/15` against this code

| Check | Implemented here? | Evidence |
|---|---|---|
| No reading | **No veto.** Dose is still given without correction | R9 |
| Stale reading | **No.** Age is passed through for display only (mobile lowers confidence at 360 min [C]) | `dose_math.py:72,250` |
| Maximum dose | **No** | section 0 G1; probe F: 500 g gives 53.5 U |
| Insulin stacking | **Partly**: subtraction and clamp at 0 (R5, R6); mobile warning (R13); no veto, and nothing limits active plus new | |
| Low glucose now | **No.** BG 40 with 60 g gives 4.5 U (probe C); BG 55 and no food gives 0 only because the correction is negative (probe D) | |
| Low glucose forecast | **No.** A kernel forecast exists (`PatientSim.trajectory`) but nothing reads it before a dose | |
| Falling fast | **No** in the dose path | |
| Doing nothing never vetoed / food never vetoed in a low | **N/A**: there is no gate; `total` 0 is simply 0 | |

### 2.4 Probe results (synthetic, `dose_cli` as shipped, constants ICR 10, CF 40, target 100 unless stated) [V]

| # | Input | Output |
|---|---|---|
| A | BG 250, IOB 1.5, CF 50, target 120 | 1.0 U (raw 1.10) |
| B | BG 115, IOB 2.0, no carbs | 0.0 U (post-active -1.62) |
| C | BG 40, 60 g carbs | **4.5 U** |
| D | BG 55, no carbs, no insulin | 0.0 U (correction -1.12) |
| E | BG null, 60 g carbs | 6.0 U |
| F | BG 250, 500 g carbs | **53.5 U** |
| G | BG 0, 60 g | 3.5 U |
| H | BG -50, 60 g | 2.0 U |
| I | BG `"abc"` | error (message from Python, `unsupported operand type(s)`) |
| J | IOB -3, BG 100 | **3.0 U** |
| K | `dose_step_units` 0 | crash, exit 1 |
| L | `min_dose_units` -1, BG 101 | 0.0 U (raw 0.025 rounds down to 0) |
| M | `health_multiplier` 5, BG 250 | 18.5 U |
| N | `activity_impact` 0, 60 g | 0.0 U |
| O | carbs -50, BG 100 | 0.0 U |
| P / Q | BG 250 only, pump / pen | 3.7 U / 3.5 U |
| R | 4.9 g carbs | 0.0 U (raw 0.49 below 0.5) |
| S | no constants | error, exit 2 |
| T | body `[1,2]` | crash, exit 1 |

Script: `probe_cli.py` (kept in the session scratch folder, not in the repo; it only calls `dose_cli.py` as a
subprocess). These are inputs of mine, not patient data.

---

## 3. Safety gate specification (no code)

### 3.1 Purpose and non-goals

A pure function that decides whether a **dose suggestion that `dose_cli` already produced** may be shown. It
never creates, changes or rounds a number; it only returns allow or veto. It imports nothing learned: no
`diatwin.ml`, no hub code, no model client, no network, no clock, no randomness, no file or database access.
Nothing it receives from a learned component can change what it allows (`docs/15` rule "nothing learned may
change what is allowed").

### 3.2 Inputs

| Input | Content | Source |
|---|---|---|
| `suggestion` | the full `dose_cli` output: `total`, `breakdown`, `provenance` | `dose_cli` only |
| `action_kind` | `dose`, `carbs` (food), or `nothing` | caller |
| `now` | UTC time of the decision (a value, never read from a clock) | caller |
| `readings` | the most recent glucose readings: time, mg/dL, source (`meter`, `cgm`, `estimated`) | patient timeline |
| `active_insulin` | units on board, **the same number that was given to `dose_cli`** | kernel, via the caller |
| `forecast` | optional list of (time, mg/dL) for the horizon, from the kernel's `PatientSim` | kernel, not a learned model |
| `limits` | the table of section 0.1 as data (G1 to G9) | clinician, via configuration |

`limits` has **no defaults in the gate**. A missing limit is an error ("limits not configured"), not a silent
default, in the same spirit as `dose_cli` refusing missing constants (R1).

### 3.3 Output

One of:

- **Allow** with `caveats`: a list of fixed codes, each with a fixed text and the values behind it.
- **Veto** with `reasons`: an ordered list (all that fired, fixed order), each a fixed code, a fixed text written
  in code (not model text), and the numbers that triggered it; plus `caveats`.

The dose in `suggestion.total` is never edited. A veto means "do not show this dose as a suggestion". The text is
produced by code, so the explanation layer (the hub) can quote it verbatim and cannot soften it.

### 3.4 Checks, in fixed order

Reason codes below are names for this specification, not final identifiers.

| Order | Code | Fires when | Limit |
|---|---|---|---|
| 0a | `NOT_FROM_DOSE_ENGINE` | `provenance.producer` is not `rules:utils.dose_math.compute_suggested_insulin` | none (exact string) |
| 0b | `INVALID_INPUT` | any input is missing, not finite, or outside the plausibility range | G8 |
| 1 | `NO_READING` | no reading at all | G3 |
| 2 | `STALE_READING` | newest reading older than the limit | G2 |
| 3 | `DOSE_ABOVE_MAX` | `total` above the maximum | G1 |
| 4 | `STACKING` | active insulin (and/or active plus proposed) beyond the limit | G7 |
| 5 | `LOW_NOW` | newest reading below the threshold | G4 |
| 6 | `LOW_FORECAST` | forecast within the horizon falls below the threshold | G5 |
| 7 | `FALLING_FAST` | slope over the window steeper than the limit | G6 |

Checks 0a to 0b are additions to the list in `docs/15`; they are there so that a number that did not come from
the dose engine, or inputs that cannot be judged, are never passed (fail closed). They need your agreement.

### 3.5 Two fixed rules (from `docs/15`, not questions)

1. **Doing nothing is never vetoed.** If `action_kind` is `nothing`, or the suggestion's `total` is 0 U, the
   result is allow, whatever the other checks say. Caveats may still be attached (for example "reading is old").
2. **Food is never vetoed during a low.** If `action_kind` is `carbs`, the result is allow in every case,
   including `LOW_NOW` and `LOW_FORECAST`. A meal with insulin is **two actions** and is judged as two: the eating
   is allowed, the bolus goes through checks 0 to 7.

### 3.6 Placement

```
inputs from the patient timeline (synthetic here)
        │
        ▼
dose_cli  ──►  suggestion {total, breakdown, provenance}      (the only source of a dose number)
        │
        ▼
SAFETY GATE (pure, stdlib only)  ──►  allow(+caveats)  |  veto(+reasons)
        │
        ▼
review surface / explanation layer: shows number + producer + gate verdict (read-only)
```

Nothing is displayed or logged as a suggestion between `dose_cli` and the gate. Any later policy (behavioural
cloning, offline RL) produces candidate actions that also pass through the same gate unchanged (`docs/25`
section 6). Question G10 decides the package; G11 decides whether the mobile and web engines need a copy.

### 3.7 Test plan

Table-driven, synthetic, deterministic (no clock, no network, no database):

1. **One boundary test per check**: just below, exactly at, and just above the limit (value, not my choice; the
   test reads the number from the configured table), for the check firing and not firing.
2. **Fixed rule 1**: for every combination of the other checks firing, `action_kind=nothing` and `total == 0`
   give allow (property-style over a grid).
3. **Fixed rule 2**: for every low state (now, forecast, both), `action_kind=carbs` gives allow; a meal with
   insulin returns allow for the food and veto for the dose.
4. **Purity**: same input gives equal output; the input object is not mutated (deep-copy compare); `now` is the
   only time source (a test with two different `now` values).
5. **No learned imports**: parse the module's imports; assert none from `diatwin.ml`, any hub package, an LLM
   SDK or a network library.
6. **Fail closed**: `None`, NaN, a string, a missing limit, a missing `breakdown` give veto or error, never allow.
7. **Number integrity**: the allowed output's dose is bit-equal to `suggestion.total`; no rounding.
8. **Ordering**: when several checks fire, reasons come in the fixed order and the first is the primary reason.
9. **Replay of section 2.4**: run probes A to T through `dose_cli`, then the gate with a configured table; record
   the verdicts (this is also the first regression pack for D1 to D5 if they are fixed later).
10. **Mutation check** (as the hub's SWE-smith step in `docs/26` section 2): disabling any single check must make
    at least one test fail.
11. **Parity** (only if G11 says yes): the harness gets a `gate` case family compared across Python, mobile, web.

---

## 4. SimGlucose, unmodified: install result

Clone: `C:\Users\attia20\Projects\external\simglucose`, commit `a6f6777` (`git status` clean, nothing edited).
Environment: Ubuntu 24.04.5 (WSL), system Python **3.12.3**, venv `~/venvs/simglucose-pkg` outside both
repositories. Command: `pip install /mnt/c/Users/attia20/Projects/external/simglucose` (the clone's own
`setup.py`). No stubs, no patches. Approved by you (including the `gym==0.9.4` source archive, which pip built).

| Step | Result [V] |
|---|---|
| `pip install` | **Succeeded.** Built `simglucose-0.2.11` and `gym-0.9.4` wheels. Installed: numpy 2.5.3, scipy 1.18.1, pandas 3.0.6, matplotlib 3.11.2, gymnasium 0.29.1, pathos 0.3.5, pyglet 2.1.16 and others |
| `import simglucose` | **Fails.** `simglucose/__init__.py` line 1 imports `gym.envs.registration`; `gym/__init__.py` line 1 is `import distutils.version`; error: `ModuleNotFoundError: No module named 'distutils'` |
| One-day smoke test (`smoke_simglucose.py` from AI-agent `docs/evidence/reuse-eval-2026-10-10/`) | **Not run**; it stops at the same import |

`distutils` was removed from the standard library in Python 3.12 [E: from the Python 3.12 release notes, not
re-read here]. So the packaged install does not work on the system Python of this PC's Ubuntu, and also not on
3.14 (docs/26). I stopped here as instructed and tried nothing else. Options are question X1. Not tested: whether
`pkg_resources` (used by five modules, `docs/26`) would be the next failure.

---

## 5. Adapter specification (no code)

### 5.1 Conversions

| What | Our side | SimGlucose side | Rule |
|---|---|---|---|
| Bolus amount | `dose_cli` `total`, units (U) | `Action(basal, bolus)` in **U/min**, applied each minute of an environment step (`env.py` `mini_step`, loop of `int(sample_time)` minutes; patient step is 1 min, `t1dpatient.py:20`) [V] | At the decision step set `bolus = total / sample_time`, so the step delivers exactly `total`; set `bolus = 0` for every other step |
| Pump quantisation | device step 0.5 or 0.1 applied by our rule R4 | `InsulinPump.bolus` rounds to `inc_bolus` 0.05 **in pmol/min** before converting back (`pump.py` `bolus`) [V], i.e. about 8e-6 U/min: effectively no quantisation; maximum 30 U/min | the adapter must not re-round; the dose that arrives is the dose that `dose_cli` returned |
| Basal | not produced by `dose_cli` | the controller supplies it; the shipped `BBController` uses `u2ss * BW / 6000` U/min (`basal_bolus_ctrller.py`) [V] | the adapter supplies the same basal for **every** policy arm so only the bolus differs |
| Meal | `nutrition.carbs` g (plus protein, fat, fiber through the kernel's carb equivalent, `dose_math.py:41-50`) | `CustomScenario([(time, grams)])`; the patient eats at 5 g/min (`t1dpatient.py:21,222-233`) [V] | grams in the scenario = carbs eaten. SimGlucose has **no protein, fat or fiber**; it sees grams only. Question: whether to pass the kernel's carb-equivalent grams instead (the dose then covers protein and fat the virtual patient does not absorb) |
| Time step | 5-minute grid (`diatwin/README.md`, `core/grid.py`) [C] | environment step = sensor `sample_time`: Dexcom 3, GuardianRT 5, Navigator 1 min (`sensor_params.csv`) [V]; internal patient step 1 min | decisions are event-driven (a meal, or a correction check at a chosen interval), not per tick; compare trajectories on the 15-minute grid (common to 3 and 5), or choose GuardianRT (X5) so steps are 5 minutes |
| Glucose value | `blood_glucose` mg/dL | `info["bg"]` is `Gsub` (subcutaneous), `observation.CGM` is the sensor value with noise and delay [V] | question X5 |
| Insulin type | `insulin_type` (kernel profile, default `insulin_aspart`) | one subcutaneous kinetic model per patient (`kd`, `ka1`, `ka2` in `vpatient_params.csv`); no insulin types [V] | kernel curve for the forecast is an assumption (X10) |
| Active insulin (`active_insulin` input) | caller number | not provided as a clean "IOB" | X6 |
| Body weight | `weight_kg` constant (default 70, `constants.py`) | `BW` per patient | set `weight_kg = BW` for the kernel forecast [E: only matters for allometric scaling of the BG drop, `constants.py` comment] |

### 5.2 Where a virtual patient's parameters come from

| Quantity | Source in SimGlucose | Label |
|---|---|---|
| Carb ratio **CR** (g per U) | `params/Quest.csv`, column `CR`; used by `BBController` as `meal_g / CR` | [V] |
| Correction factor **CF** (mg/dL per U) | `params/Quest.csv`, column `CF`; used as `(glucose - target) / CF` | [V] |
| Target glucose | **not shipped per patient.** `BBController(target=140)` is a constructor default and it corrects only when the sensor reads above 150 (`(glucose > 150) * ...`) | [V] |
| Body weight, basal steady state | `vpatient_params.csv`: `BW`, `u2ss`, `Gb` (basal glucose) | [V] |
| Total daily insulin, age | `Quest.csv`: `TDI`, `Age` | [V] |

Ranges in the shipped files [V, computed here]: adolescents CR 4 to 23 g/U, CF 11.9 to 33.5 mg/dL/U, BW 37.9 to
68.7 kg; adults CR 5 to 22, CF 7.6 to 42.7, BW 63.0 to 111.1; children CR 7 to 25, CF 25.0 to 42.7, BW 23.7 to
45.5; `Gb` 133 to 153 mg/dL in all groups. How the authors derived `CR` and `CF` is not stated in the files
[E: I did not find it]. The fallback "Average" patient in `BBController` has `CR = 1/15`, `CF = 1/50`, which
look inverted; it is used only for names not in `Quest.csv` and is irrelevant for the 30 named patients [V code,
E reading].

The three constants `dose_cli` requires map as: `insulin_to_carb_ratio` = `CR`, `correction_factor` = `CF`,
`target_glucose` = answer to X2. Everything else uses the kernel defaults (`constants.py:232-261`) unless X3 sets
`insulin_delivery`.

### 5.3 The cross-check question

SimGlucose is an independent model (UVa/Padova 2008 virtual patients, [C] from its README); our kernel was not
built from it. Two separate questions, to be kept separate:

- **A. Outcome.** *When a virtual patient eats a meal and receives the dose that `dose_cli` suggests (with
  inputs that the app could really have: reading, kernel-derived active insulin, patient CR/CF/target), what
  does the glucose do in an independent simulator, compared with doing nothing and with SimGlucose's own
  basal-bolus rule?*
- **B. Forecast agreement.** *Given the same event stream, how close is our kernel's glucose forecast
  (`PatientSim.trajectory`, `predicted_bg`) to SimGlucose's glucose?*

### 5.4 Outcome measures (computed per patient and scenario, then summarised)

| Measure | Definition |
|---|---|
| Time in range | share of minutes with glucose in the range; **range bounds are an open question (X7)** |
| Time below range | share below the low threshold; one or two tiers (X7) |
| Lowest glucose | minimum over the run and over the 4 hours after each dose |
| Time above range | share above the high threshold (X7) |
| Dose per scenario | total bolus U (for context) |
| B: forecast error | bias, RMSE and maximum absolute error of `predicted_bg - Gsub` at 15-minute points for 4 hours after each meal; lag of the peak and of the nadir |

Scenarios to start from (X8): one day, three meals (45, 70, 80 g as in docs/26 [C]); high start (BG 250 at
meal); low start (a BG chosen from the answer to G4, at a meal; arm d shows the gate's verdict); stacked meals 2 hours apart; a missed meal
after a dose; a large meal. Each across the patients of X4 and the arms of X9.

### 5.5 What agreement would and would not show

| Would show | Would **not** show |
|---|---|
| A suggestion does not lead to a low in an independent model, for these scenarios and 30 virtual patients | That the dose is right or safe for a person: the virtual patients are not our patient and not calibrated to anyone (docs/26 [C], SimGlucose README: research use) |
| Our forecast is not an artefact of our own kernel (answer to B) | That the kernel's constants (insulin curve, `carb_to_bg_factor`, CF) are correct; SimGlucose has its own insulin and meal kinetics |
| That the gate's vetoes (arm d against c) remove the hypoglycaemic episodes in the model | That the gate's limits are clinically right (they are the owner's table of section 0) |
| Where the kernel and SimGlucose disagree most (by patient group, meal size, time since dose) | That disagreement is a kernel fault: it can equally be a property of the virtual patient |
| | Anything about exercise, illness, sensor failure, behaviour, or the three engines' parity (not in SimGlucose's scenario set used here) |

Pass or fail thresholds are open (X7). Without them the run reports the measures and states the comparison;
it does not declare a pass.

### 5.6 Risks and limits [E]

- `dose_cli` is a **bolus calculator for an event**, not a controller; the cross-check judges single boluses in a
  fixed schedule, not closed-loop behaviour.
- Basal is not modelled by our code; the choice of basal in the arm dominates low-glucose risk. The adapter uses
  SimGlucose's own steady-state basal for all arms.
- Meal absorption in SimGlucose is carbs only at a patient-specific rate; our dose includes protein and fat
  equivalents. The scenario may therefore over-dose by construction, which would look like a "failure" of the
  rule although it is a mismatch of inputs (see the first row of 5.1 on the meal).
- The install does not currently import (section 4); everything in this section is unrun.
- Wall time: [C] 13.6 s for one patient-day in docs/26; thirty patients and several scenarios and arms are
  roughly tens of minutes [E].

---

## 6. What was and was not done

Done: baseline runs (section 1), read-only inventory with 20 probe calls of `dose_cli` as shipped, gate and
adapter specifications, the packaged install attempt of SimGlucose. Not done, by instruction or by lack of
approval: no code written (gate, adapter), no dose logic, constant, pharmacodynamic parameter or clinical rule
changed, no test edited, no `requirements-ml.txt` install, no `npm install`, no mobile jest, no database
connection, no provider call, `KEYS.txt` not read. No commit to `main`; nothing pushed.

---

## 7. Device paths: what a mobile or web user is shown (read-only check, 12 Oct 2026)

**Until a gate exists in the mobile and web engines (owner decision G11: Python first, then mobile and web), app
users are not covered by any gate.** Everything below was read in the code; **none of it was run**. The parity
harness covers insulin curves, meal absorption, activity and `dose_finalise` (`diatwin/verify/parity.py:372-434`)
but not the dose pipeline with glucose, carbs and active insulin as inputs, and both dose functions import
`config`, `axios` or the `@/` path alias (`insulinCalculationService.ts:127-158`,
`EnhancedPatientConstantsCalc.js:1-63`), so they cannot be called from plain Node without new shims or installs.
The arithmetic numbers below are my hand calculation with the default constants (ICR 10, CF 40, target 100) [E].

| Case | Mobile (`mobile/`) | Web (`frontend/src/`) | Dose shown? |
|---|---|---|---|
| **Glucose 40, 60 g meal** | Value saved (it is above 0): `MealForm.tsx:1469-1471`. Used as an actual reading: `:1125`. Correction goes negative, meal dose stays: `insulinCalculationService.ts:1002-1005`. The input only shows a coloured "Below target range" badge below 0.7 x target: `UnifiedBloodSugarInput.tsx:83-84,116-118,243-245,254-256`. Dose card: "X units" with no low-glucose banner: `MealForm.tsx:2022`. Hand result 6.0 - 1.5 = **4.5 U** [E] | `BloodSugarInput.js:48-60` rejects only below 0 and above 600 (no low warning); used as `actual`: `MealInput.js:140-146`; negative correction allowed: `EnhancedPatientConstantsCalc.js:892-895`; shown as "{N} units": `MealInput.js:1439,1528`. No hypo or low text in `MealInput.js` or `BloodSugarInput.js` (grep) | **Displayed**, no warning, in both |
| **500 g meal** | No upper bound: text accepts digits (`SelectedFoodsList.tsx:189-194`), blur only enforces a minimum of 0.5 (`:197-215`), plus/minus buttons add 0.5 (`:381-388`). Dose shown as computed. The 100 U maximum and 30 U warning of `INSULIN_LIMITS` (`utils/validation/input-validators.ts:42-46`) are applied to the *typed* dose (`UnifiedInsulinInput.tsx:1009-1018`), while the suggestion pre-fills the field through `useState` (`:637`) and is not validated | No upper bound found on the amount (`MealInput.js`); the same unconditional "units" display | **Displayed**, no warning, in both. Python equivalent: 500 g at BG 250 gives 53.5 U ([V] probe F) |
| **Glucose 0 or negative** | Cannot be saved: `MealForm.tsx:1469-1471` needs a value above 0; if it were present, `:1125` (`userEnteredBG > 0`) skips it. The dose then uses the estimate or the target fallback, with a banner such as "Using target glucose - no blood sugar data available" (`:1186-1200`, fallback block) | Negative is rejected on blur with "Blood sugar cannot be negative" (`BloodSugarInput.js:51`); **0 is accepted** by that check, then `parseFloat(...) || 0` and `> 0` (`MealInput.js:140-146`) treat it as no reading and use the estimate, silently | **Displayed**, computed from an estimate or the target, not from the 0 |
| **Negative active insulin** | Not user-enterable: it is computed (`MealForm.tsx` `activeInsulinValue = r.activeInsulinUnits \|\| activeInsulin`). `calculateInsulinDose` does not clamp it: `insulinCalculationService.ts:1022`. A logged dose below 0 is flagged on the typed field (`input-validators.ts:111-113`) | Not user-enterable: from `fetchActiveInsulin` or the caller, no clamp (`EnhancedPatientConstantsCalc.js:810-816`); dose field has `min="0"` (`InsulinInput.js:633`) | **Displayed**; whether the kernel can return a negative IOB I did not find a path for [E: `calculate_iob` returns 0 outside its window, `pharmacodynamics.py:512-513`] |

### What this shows [V read]

- The only protective behaviour on the device in these four cases is the **surplus warning** (mobile only,
  `insulinCalculationService.ts:1036-1043`, banner `MealForm.tsx:1959-1990`): it replaces the type and timing
  guidance and tells the user to eat, **but the dose number is still shown** (0.0 units, `:2022`). It fires on
  excess active insulin, not on low glucose or a large meal. **The web engine has no such warning** (no
  `iobSurplus` in `frontend/src`; D7).
- The mobile app has glucose limits that are never used: `GLUCOSE_LIMITS` (MIN 20, MAX 600, LOW_WARNING 70,
  HIGH_WARNING 250) and `validateGlucoseReading` exist in `input-validators.ts:32-37,54-82`, but a search of
  `mobile/` (excluding tests) finds no caller outside the re-export in `validation.ts`. I quote these values
  because they exist, not as a recommendation; they bear on questions G4, G8 and G1 (`INSULIN_LIMITS.MAX` 100).
- A low reading changes **a colour and a label**, never the suggestion.
