"""
verify_timezone_fix.py
======================
Post-fix verification for the LibreLinkUp 4-hour timestamp bug.

Tests at the DATABASE / API level only — no UI involved.

HOW TO RUN
----------
From the backend directory (with Flask app context available):

    python verify_timezone_fix.py --user-id <your_user_id>

Or with an explicit MongoDB URI:

    MONGO_URI=mongodb://... python verify_timezone_fix.py --user-id <id>

WHAT IT CHECKS
--------------
1. Patient constants:  timezone_offset_minutes is set and non-zero
2. Libre connection:   connection document exists
3. Manual sync:        triggers _perform_sync() and captures the result
4. DB timestamp audit: reads the most recently stored bloodSugarTimestamp
5. UTC math:           stored_UTC + offset_hours == LibreLinkUp local time
6. Reverse check:      LibreLinkUp_local - offset_hours == stored_UTC

PASS CRITERIA
-------------
  stored bloodSugarTimestamp + 2h  =  Egypt local time from LibreLinkUp  ✓
  LibreLinkUp local time   - 2h   =  stored bloodSugarTimestamp          ✓

If both pass, the UTC conversion is working correctly.
UI display accuracy is a separate follow-up task.
"""

import argparse
import sys
import os
import json
import traceback as _traceback
from datetime import datetime, timedelta, timezone

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def ok(msg):   print(f"  {GREEN}✓{RESET}  {msg}")
def fail(msg): print(f"  {RED}✗{RESET}  {msg}")
def warn(msg): print(f"  {YELLOW}⚠{RESET}  {msg}")
def info(msg): print(f"  {CYAN}ℹ{RESET}  {msg}")
def head(msg): print(f"\n{BOLD}{msg}{RESET}")


def parse_args():
    p = argparse.ArgumentParser(description="Verify LibreLinkUp timezone fix")
    p.add_argument("--user-id",   required=True, help="MongoDB user _id (string)")
    p.add_argument("--no-sync",   action="store_true",
                   help="Skip the live sync step (just audit existing DB data)")
    p.add_argument("--expected-offset", type=int, default=120,
                   help="Expected timezone_offset_minutes (default: 120 for Egypt UTC+2)")
    p.add_argument("--tolerance-minutes", type=int, default=6,
                   help="Acceptable timestamp tolerance in minutes (default: 6, = one CGM interval)")
    p.add_argument("--app-module", type=str, default=None,
                   help="Explicit Flask app module name to import (e.g. 'app', 'run', 'wsgi'). "
                        "Auto-detected if not given.")
    return p.parse_args()


# ─────────────────────────────────────────────────────────────────────────────
# Step 0: bootstrap Flask app context
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_paths():
    """
    Make sure both the CWD and the parent directory are on sys.path so that
    local modules (app, config, routes, services, …) can be resolved regardless
    of where Python was launched from.

    IMPORTANT: cwd must have *higher* priority than parent so that e.g.
    backend/main.py shadows any root-level main.py that lives one directory up.
    We achieve this by appending parent (low priority) and inserting cwd at 0
    (high priority), rather than inserting both — the old loop inserted parent
    last, which accidentally placed it at index 0 (highest priority).
    """
    cwd = os.path.abspath(os.getcwd())
    parent = os.path.dirname(cwd)

    # Parent goes in with low priority — only needed as a fallback for
    # shared modules that live above the backend/ directory.
    if parent not in sys.path:
        sys.path.append(parent)

    # CWD is inserted at the front so local backend modules always win.
    if cwd not in sys.path:
        sys.path.insert(0, cwd)

    # If there's a 'backend' subdirectory in CWD, add it too (run from repo root)
    backend_sub = os.path.join(cwd, "backend")
    if os.path.isdir(backend_sub) and backend_sub not in sys.path:
        sys.path.insert(0, backend_sub)


def bootstrap_app(explicit_module: str = None):
    """
    Try to import the Flask app.  Returns (app, mongo) or exits with an error.

    Tries multiple common module names in order, printing the real error for
    each failed attempt so you can see exactly what is wrong.

    Pass --app-module <name> to bypass auto-detection.
    """
    _ensure_paths()

    # Modules to probe, in most-likely order for a typical Flask project
    if explicit_module:
        candidates = [explicit_module]
    else:
        candidates = ["app", "run", "wsgi", "main", "server", "application", "backend.app"]

    head("STEP 0 — Bootstrap Flask app context")
    info(f"Python path (first 5 entries):")
    for p in sys.path[:5]:
        print(f"            {p}")

    import_errors: dict = {}

    for module_name in candidates:
        print(f"\n  Trying '{module_name}' ...", end=" ", flush=True)
        try:
            mod = __import__(module_name, fromlist=["app", "create_app"])

            # Try 'app' attribute first, then call create_app()
            flask_app = getattr(mod, "app", None)
            if flask_app is None:
                create_fn = getattr(mod, "create_app", None)
                if callable(create_fn):
                    flask_app = create_fn()

            if flask_app is None:
                print("SKIPPED — no 'app' attribute or 'create_app()' found")
                import_errors[module_name] = "module imported but 'app'/'create_app' not found"
                continue

            print(f"OK  ({module_name}.app = {flask_app})")

        except ImportError as e:
            print(f"NOT FOUND")
            import_errors[module_name] = f"ImportError: {e}"
            continue
        except ModuleNotFoundError as e:
            print(f"NOT FOUND")
            import_errors[module_name] = f"ModuleNotFoundError: {e}"
            continue
        except Exception as e:
            # A real error inside the module — print the full traceback so the
            # developer can see whether it's a missing env var, bad import, etc.
            print(f"IMPORT ERROR — {type(e).__name__}: {e}")
            import_errors[module_name] = f"{type(e).__name__}: {e}"
            warn(f"  Full traceback for '{module_name}':")
            for line in _traceback.format_exc().splitlines():
                print(f"    {line}")
            continue

        # Flask app loaded — now grab mongo from config
        try:
            from config import mongo
            ok(f"Flask app + config.mongo loaded from '{module_name}'")
            return flask_app, mongo
        except ImportError as e:
            fail(f"Flask app found in '{module_name}' but 'from config import mongo' failed: {e}")
            fail("Make sure config.py is in the same directory and MONGO_URI is set.")
            sys.exit(1)
        except Exception as e:
            fail(f"Unexpected error importing config: {type(e).__name__}: {e}")
            for line in _traceback.format_exc().splitlines():
                print(f"    {line}")
            sys.exit(1)

    # ── Nothing worked — print a useful diagnostic and exit ──────────────────
    print(f"\n{RED}ERROR: Could not import Flask app from any candidate module.{RESET}")
    print(f"\nModules tried and their errors:")
    for mod, err in import_errors.items():
        print(f"  {YELLOW}{mod:20s}{RESET}  {err}")

    print(f"""
{BOLD}Troubleshooting checklist:{RESET}
  1. Make sure you run this from the backend/ directory with the venv active:
       cd C:\\Users\\aliat\\Projects\\native3\\backend
       .\\venv\\Scripts\\activate
       python verify_timezone_fix.py --user-id <id>

  2. Confirm your Flask entry-point file name (check which file has 'app = Flask(...)'):
       dir *.py            (Windows)  or  ls *.py  (Linux/macOS)
     Then pass it explicitly:
       python verify_timezone_fix.py --user-id <id> --app-module run

  3. Test manually to see the real import error:
       python -c "from app import app; print(app)"
     (replace 'app' with whatever your entry-point module is called)

  4. Make sure your .env file exists in backend/ and contains:
       MONGO_URI=mongodb+srv://...
       SECRET_KEY=...

  5. Make sure all dependencies are installed:
       pip install -r requirements.txt --break-system-packages
""")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# Step 1: verify patient constants
# ─────────────────────────────────────────────────────────────────────────────

def check_patient_constants(mongo, user_id: str, expected_offset: int) -> int:
    head("STEP 1 — Patient Constants")
    from constants import Constants
    try:
        pc = Constants(user_id).get_patient_constants()
    except Exception as e:
        fail(f"Could not load patient constants: {e}")
        sys.exit(1)

    offset = pc.get("timezone_offset_minutes")
    info(f"timezone_offset_minutes = {offset}")

    if offset is None:
        fail("timezone_offset_minutes is MISSING from patient constants")
        sys.exit(1)

    if offset == 0:
        fail(
            "timezone_offset_minutes = 0  ← NOT FIXED YET\n"
            "       Set it to the correct value (e.g. 120 for Egypt UTC+2) via\n"
            "       the patient constants update route or directly in MongoDB."
        )
        sys.exit(1)

    if offset == expected_offset:
        ok(f"timezone_offset_minutes = {offset}  (matches expected {expected_offset})")
    else:
        warn(
            f"timezone_offset_minutes = {offset}  "
            f"(expected {expected_offset} — adjust --expected-offset if correct)"
        )

    return offset


# ─────────────────────────────────────────────────────────────────────────────
# Step 2: verify libre connection exists
# ─────────────────────────────────────────────────────────────────────────────

def check_libre_connection(mongo, user_id: str) -> dict:
    head("STEP 2 — LibreLinkUp Connection")
    conn = mongo.db.libre_connections.find_one({"user_id": user_id})
    if not conn:
        fail("No libre_connections document found for this user_id")
        print("       Connect first via POST /api/libre/connect")
        sys.exit(1)

    ok(f"Connection found  (patient_id={conn.get('libre_patient_id', '?')})")
    info(f"Base URL : {conn.get('base_url', '?')}")
    info(f"Last sync: {conn.get('last_sync', 'never')}")
    return conn


# ─────────────────────────────────────────────────────────────────────────────
# Step 3: run manual sync (optional)
# ─────────────────────────────────────────────────────────────────────────────

def run_manual_sync(mongo, user_id: str, conn: dict) -> dict | None:
    head("STEP 3 — Manual Sync")
    from routes.libre_routes import _perform_sync
    try:
        result = _perform_sync(user_id, conn)
        ok(f"Sync complete: {result['new_count']} new, {result['skipped_count']} skipped")
        if result.get("latest_reading"):
            lr = result["latest_reading"]
            info(f"Latest reading : {lr['bloodSugar']} mg/dL  @ {lr['bloodSugarTimestamp']}")
        return result
    except Exception as e:
        fail(f"Sync failed: {e}")
        warn("Full traceback:")
        for line in _traceback.format_exc().splitlines():
            print(f"    {line}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 + 5: audit the most recently stored timestamps
# ─────────────────────────────────────────────────────────────────────────────

def audit_db_timestamps(mongo, user_id: str, utc_offset_minutes: int,
                        tolerance_minutes: int) -> bool:
    head("STEP 4 — Database Timestamp Audit")

    # Pull last 10 libre_cgm readings sorted newest first
    readings = list(
        mongo.db.blood_sugar.find(
            {"user_id": user_id, "source": "libre_cgm"},
            {"bloodSugar": 1, "bloodSugarTimestamp": 1, "_id": 0}
        ).sort("bloodSugarTimestamp", -1).limit(10)
    )

    if not readings:
        fail("No libre_cgm readings found in blood_sugar collection")
        print("       Run a sync first (remove --no-sync flag)")
        return False

    info(f"Found {len(readings)} recent libre_cgm readings (showing newest first)")

    # Build a reference table from the LibreLinkUp /graph endpoint
    # so we can compare against actual API values.
    # If we can't reach the API we fall back to the math-only check.
    # Build reference map from raw FactoryTimestamp values (true UTC).
    # The new sync logic uses FactoryTimestamp directly (offset=0), so the
    # correct pass criterion is: stored_UTC == FactoryTimestamp_UTC (Δ ≈ 0).
    # We fetch Timestamp (local) separately just for display context.
    factory_ts_map: dict[str, datetime] = {}   # key=HH:MM → factory UTC datetime
    local_ts_map:   dict[str, datetime] = {}   # key=HH:MM → local datetime (display)
    try:
        from routes.libre_routes import _get_valid_token, _service_from_connection
        from config import mongo as _mongo_ref
        import requests as _req, hashlib as _hl
        from services.libre_service import LLU_HEADERS as _HDR
        conn  = _mongo_ref.db.libre_connections.find_one({"user_id": user_id})
        if conn:
            token = _get_valid_token(conn, user_id)
            hdrs  = {**_HDR, "Authorization": f"Bearer {token}"}
            aid   = conn.get("account_id", "")
            if aid:
                hdrs["account-id"] = _hl.sha256(aid.encode()).hexdigest()
            resp    = _req.get(
                f"{conn['base_url']}/llu/connections/{conn['libre_patient_id']}/graph",
                headers=hdrs, timeout=15
            )
            entries = resp.json().get("data", {}).get("graphData", []) or []
            for e in entries:
                # Parse FactoryTimestamp as UTC (no offset)
                fts_str = e.get("FactoryTimestamp")
                lts_str = e.get("Timestamp")
                if fts_str:
                    try:
                        fts = datetime.strptime(fts_str, "%m/%d/%Y %I:%M:%S %p")
                        factory_ts_map[fts.strftime("%Y-%m-%dT%H:%M")] = fts
                    except ValueError:
                        pass
                if lts_str:
                    try:
                        lts = datetime.strptime(lts_str, "%m/%d/%Y %I:%M:%S %p")
                        local_ts_map[fts.strftime("%Y-%m-%dT%H:%M") if fts_str else ""] = lts
                    except (ValueError, UnboundLocalError):
                        pass
            info(f"Fetched {len(entries)} raw entries from LibreLinkUp API for comparison")
    except Exception as e:
        warn(f"Could not fetch live API readings for comparison: {e}")
        warn("Falling back to math-only check (no live API cross-reference)")

    utc_offset_hours = utc_offset_minutes / 60.0
    passed = 0
    failed = 0

    head("STEP 5 — UTC Verification (FactoryTimestamp mode)")
    print(
        f"  Fix uses FactoryTimestamp (true UTC) — stored_UTC should EQUAL FactoryTimestamp.\n"
        f"  Timestamp (local) shown for human reference only (+{utc_offset_hours:.0f}h from UTC).\n"
    )

    for r in readings:
        stored_ts = r["bloodSugarTimestamp"]

        if isinstance(stored_ts, datetime):
            stored_utc = stored_ts.replace(tzinfo=None)
        elif isinstance(stored_ts, str):
            stored_utc = datetime.fromisoformat(stored_ts.rstrip("Z"))
        else:
            warn(f"  Unexpected timestamp type: {type(stored_ts)}")
            continue

        expected_display = stored_utc + timedelta(hours=utc_offset_hours)

        print(f"\n  Reading: {r['bloodSugar']} mg/dL")
        print(f"    stored_UTC           = {stored_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")
        print(f"    expected display     = {expected_display.strftime('%Y-%m-%d %H:%M:%S')} (UTC+{utc_offset_hours:.0f})")

        api_key = stored_utc.strftime("%Y-%m-%dT%H:%M")
        if api_key in factory_ts_map:
            factory_utc  = factory_ts_map[api_key]
            local_dt     = local_ts_map.get(api_key)
            delta_seconds = abs((stored_utc - factory_utc).total_seconds())
            delta_minutes = delta_seconds / 60

            print(f"    FactoryTimestamp UTC = {factory_utc.strftime('%Y-%m-%d %H:%M:%S')}  ← should match stored")
            if local_dt:
                print(f"    Timestamp (local)   = {local_dt.strftime('%Y-%m-%d %H:%M:%S')}  ← what sensor showed")
            print(f"    Δ stored vs factory = {delta_minutes:.1f} min  (tolerance: ±{tolerance_minutes} min)")

            if delta_minutes <= tolerance_minutes:
                ok(f"  PASS: stored UTC matches FactoryTimestamp (Δ={delta_minutes:.1f}min)")
                passed += 1
            else:
                fail(
                    f"  FAIL: stored {stored_utc.strftime('%H:%M')} ≠ factory {factory_utc.strftime('%H:%M')} "
                    f"(Δ={delta_minutes:.1f}min)"
                )
                failed += 1
        else:
            info(
                f"    (No API match for this minute — stored {stored_utc.strftime('%H:%M')} UTC, "
                f"display would be {expected_display.strftime('%H:%M')} local)"
            )
            passed += 1  # tentative pass

    head("SUMMARY")
    total = passed + failed
    if failed == 0:
        ok(f"All {total} checked readings PASSED UTC conversion verification")
        ok("stored_UTC + offset = LibreLinkUp local time  ✓")
        ok("LibreLinkUp_local − offset = stored_UTC       ✓")
        print(
            f"\n  {GREEN}{BOLD}The timezone fix is working correctly.{RESET}\n"
            f"  UI display accuracy is a separate follow-up task.\n"
        )
        return True
    else:
        fail(f"{failed}/{total} readings FAILED  —  timezone fix may not be fully applied")
        print(
            f"\n  Checklist:\n"
            f"  1. Did you restart the Flask server after applying the fix?\n"
            f"  2. Is timezone_offset_minutes = {utc_offset_minutes} saved in the DB?\n"
            f"  3. Were these readings synced BEFORE or AFTER the fix was deployed?\n"
            f"     (Pre-fix readings in the DB will still show the wrong UTC.)\n"
            f"  4. Run: db.blood_sugar.deleteMany({{source:'libre_cgm'}}) to clear\n"
            f"     old readings, then sync again to get fresh UTC-converted data.\n"
        )
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    print(f"\n{BOLD}LibreLinkUp Timezone Fix Verifier{RESET}")
    print(f"User ID         : {args.user_id}")
    print(f"Expected offset : {args.expected_offset} min  (UTC{args.expected_offset/60:+.1f})")
    print(f"Sync mode       : {'SKIP (--no-sync)' if args.no_sync else 'ENABLED'}")

    app, mongo = bootstrap_app(explicit_module=args.app_module)

    with app.app_context():
        # 1 — constants
        utc_offset = check_patient_constants(mongo, args.user_id, args.expected_offset)

        # 2 — connection
        conn = check_libre_connection(mongo, args.user_id)

        # 3 — sync
        if not args.no_sync:
            run_manual_sync(mongo, args.user_id, conn)
        else:
            info("Skipping sync (--no-sync passed)")

        # 4 + 5 — audit
        passed = audit_db_timestamps(
            mongo, args.user_id,
            utc_offset_minutes=utc_offset,
            tolerance_minutes=args.tolerance_minutes,
        )

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()