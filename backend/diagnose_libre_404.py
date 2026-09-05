"""
diagnose_libre_404.py
─────────────────────────────────────────────────────────────────────────────
Run this from your backend/ directory to diagnose why /api/libre/readings
returns 404. It checks all three possible causes in order.

Usage:
    cd native3/backend
    python diagnose_libre_404.py
─────────────────────────────────────────────────────────────────────────────
"""

import sys
import importlib

print("=" * 60)
print("DiaTwin — LibreLinkUp 404 Diagnostic")
print("=" * 60)

# ── Check 1: cryptography package ────────────────────────────────────────────
print("\n[1/3] Checking 'cryptography' package...")
try:
    from cryptography.fernet import Fernet
    print("  ✅ cryptography is installed")
except ImportError:
    print("  ❌ cryptography is NOT installed — this is your 404 cause")
    print()
    print("  Fix: run this command in your backend directory:")
    print()
    print("    pip install cryptography")
    print()
    print("  Then add 'cryptography' to requirements.txt and restart Flask.")
    sys.exit(1)

# ── Check 2: libre_service import ────────────────────────────────────────────
print("\n[2/3] Checking services/libre_service.py import...")
try:
    from services.libre_service import LibreLinkUpService, encrypt_credential
    print("  ✅ services/libre_service.py imports correctly")
except ImportError as e:
    print(f"  ❌ Import failed: {e}")
    print()
    print("  Fix: make sure libre_service.py is at backend/services/libre_service.py")
    sys.exit(1)

# ── Check 3: libre_routes blueprint import ───────────────────────────────────
print("\n[3/3] Checking routes/libre_routes.py blueprint...")
try:
    from routes.libre_routes import libre_bp
    print(f"  ✅ libre_bp imported. Blueprint name: '{libre_bp.name}'")

    # Show all registered routes
    rules = [str(r) for r in libre_bp.deferred_functions]
    print(f"  ✅ Blueprint has {len(libre_bp.deferred_functions)} deferred registrations")
except ImportError as e:
    print(f"  ❌ Import failed: {e}")
    sys.exit(1)
except Exception as e:
    print(f"  ❌ Unexpected error: {e}")
    sys.exit(1)

# ── Check 4: main.py has libre_bp ────────────────────────────────────────────
print("\n[4/4] Checking main.py registers libre_bp...")
try:
    with open("main.py", encoding="utf-8") as f:
        content = f.read()
    if "libre_bp" in content:
        print("  ✅ main.py contains libre_bp registration")
    else:
        print("  ❌ main.py does NOT register libre_bp")
        print()
        print("  Fix: add these two lines to main.py:")
        print()
        print("    Import section:")
        print("      from routes.libre_routes import libre_bp")
        print()
        print("    Blueprints list:")
        print("      (libre_bp, ''),")
        print()
        print("  Then restart Flask.")
        sys.exit(1)
except FileNotFoundError:
    print("  ⚠️  Run this script from the backend/ directory")
    sys.exit(1)

print()
print("=" * 60)
print("✅ All checks passed.")
print()
print("If you still get 404, the Flask server needs to be restarted.")
print("The running process is serving old code without libre_bp.")
print()
print("  Kill and restart:")
print("    Ctrl+C  (stop current server)")
print("    python main.py  (or gunicorn command)")
print("=" * 60)