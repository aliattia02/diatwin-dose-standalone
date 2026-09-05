# Setup

Fresh clone to a green test run. Tested end to end on 5 September 2026.

## 1. Backend

```bash
cd backend
python -m venv venv
venv/Scripts/activate          # Windows;  source venv/bin/activate on macOS/Linux
pip install -r requirements.txt -r ../requirements-dev.txt
cp .env.example .env           # required: see the note in that file
pytest tests -q                # expect: 280 passed, 1 skipped
```

The manifest is `backend/requirements.txt` — the runtime stack — plus the root
`requirements-dev.txt`. The root `requirements.txt` is **not** part of this: it
is an unrelated `pip freeze` (OpenCV, pikepdf, SQLAlchemy, uvicorn) that pins
`pytest==7.4.3`, so installing it alongside `requirements-dev.txt`
(`pytest==8.3.4`) fails with `ResolutionImpossible`, and it contains neither
Flask nor pymongo. `.github/workflows/ci.yml` has always used the correct pair.

`backend/.env` is gitignored and is **not** in this repository. `.env.example`
holds throwaway values; the test suite never connects to a real database
(`conftest.py` swaps in mongomock), but `config.py` raises at import time if
`MONGO_URI` is unset, so the file has to exist.

## 2. Modelling foundation

```bash
pytest diatwin/tests -q        # from the repository root
```

Expect **65 passed** once the parity fixtures have been generated (step 4).
Before that, 50 pass and 15 skip — those fifteen read the three languages'
result files, which are derived artifacts and deliberately not committed.

## 3. Mobile

```bash
cd mobile
npm install
npx jest                       # expect: 317 passed, 8 suites
npx tsc --noEmit               # 197 errors, pre-existing, not yet a gate
```

The web frontend needs no install for the test run: the parity harness drives
`frontend/src/utils/` with plain Node (see step 4), and `react-scripts` is
required only to run the app itself.

## 4. Cross-language parity

The insulin, meal and activity models are implemented independently three
times — Python, the mobile client, and the web frontend — on purpose. This is
what checks they agree:

```bash
python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
cd .. && node diatwin/verify/frontend_eval.mjs
python -m diatwin.verify.parity compare            # exit 0
```

The frontend evaluator needs **Node 22.15 or newer** and no npm packages at
all; it tells you so and exits 2 on an older runtime rather than failing with a
syntax error from inside a shipped source file.

`compare` fails only on divergence not recorded in
`diatwin/verify/fixtures/baseline_divergences.json`. That file holds the same
205 known insulin-curve divergences on two pairs — see Arm 5 §5.1 for why they
are accepted. Python and the frontend agree on **every one of the 1,578 cases**;
the mobile client is the side that stands alone.

## What is not in this repository

- **`docs/Clinical Validation/`** — the AZT1D 2025 CGM records are real
  human-subject data and are deliberately not published here. Nothing in any
  test suite reads them. Copy the folder in locally if you need the conversion
  pipeline.
- **Study-account credentials** — `*_credentials.json` files hold plaintext
  passwords and JWTs. They are gitignored here and must never be committed.
- **`.env` files** and **`docs/_draft/`**.

## Where to start reading

`docs/engineering/README.md` is the entry point: current state, open defects,
and links to Arm 5 (the verification and modelling reference) and the session
reports.
