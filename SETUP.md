# Setup

Fresh clone to a green test run. Tested end to end on 5 September 2026.

## 1. Backend

```bash
cd backend
python -m venv venv
venv/Scripts/activate          # Windows;  source venv/bin/activate on macOS/Linux
pip install -r ../requirements.txt -r ../requirements-dev.txt
cp .env.example .env           # required: see the note in that file
pytest tests -q                # expect: 280 passed, 1 skipped
```

`backend/.env` is gitignored and is **not** in this repository. `.env.example`
holds throwaway values; the test suite never connects to a real database
(`conftest.py` swaps in mongomock), but `config.py` raises at import time if
`MONGO_URI` is unset, so the file has to exist.

## 2. Modelling foundation

```bash
pytest diatwin/tests -q        # from the repository root
```

Expect **59 passed** once the parity fixtures have been generated (step 4).
Before that, 49 pass and 10 skip — those ten compare the two languages' result
files, which are derived artifacts and deliberately not committed.

## 3. Mobile

```bash
cd mobile
npm install
npx jest                       # expect: 317 passed, 8 suites
npx tsc --noEmit               # 198 errors, pre-existing, not yet a gate
```

## 4. Cross-language parity

The insulin, meal and activity models are implemented independently in Python
and TypeScript on purpose. This is what checks they agree:

```bash
python -m diatwin.verify.parity generate
python -m diatwin.verify.parity python
cd mobile && npx jest __tests__/parity
cd .. && python -m diatwin.verify.parity compare    # exit 0
```

`compare` fails only on divergence not recorded in
`diatwin/verify/fixtures/baseline_divergences.json`. That file holds 205 known
insulin-curve divergences — see Arm 5 §5.1 for why they are accepted. Every
meal and activity case agrees exactly.

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
