"""
Shared fixtures for the backend suite.

Three things have to be neutralised before the Flask app is safe to import
in a test process:

1.  **The schedulers.** ``create_app`` unconditionally starts the LibreLinkUp
    and Google Fit pollers. In a test run they would fire real HTTP requests
    on a timer, so both start functions are stubbed before ``main`` is
    imported.

2.  **The database.** ``config`` raises at import time when ``MONGO_URI`` is
    unset, and ``create_app_config`` pings Atlas on startup. The URI is set
    to a dummy value, the ping is stubbed, and ``mongo.db`` is replaced with
    an in-memory ``mongomock`` database afterwards.

3.  **Constants export.** ``create_app`` writes the generated TypeScript
    constants to disk when not on Render. Harmless but slow and noisy, so
    it is stubbed too.

Every test gets a clean database. Fixtures seed the minimum a test needs and
nothing more, so a failure points at one thing.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict

import pytest

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

os.environ.setdefault("MONGO_URI", "mongodb://localhost:27017/diatwin_test")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-anywhere-real")

UTC = timezone.utc


# ─── App ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def flask_app():
    """The real application object, with I/O at the edges stubbed out."""
    import mongomock

    import config
    config.test_mongo_connection = lambda: True

    import libre_scheduler
    import watch_scheduler
    libre_scheduler.start_libre_scheduler = lambda app: None
    watch_scheduler.start_watch_scheduler = lambda app: None

    from constants import Constants
    Constants.export_all_constants_safe = classmethod(lambda cls: True)

    # Loaded by path, not by name. The repository root carries its own
    # main.py — a leftover PyCharm template — and whichever of the two is
    # found first depends on how pytest happens to seed sys.path. Importing
    # the file explicitly removes the ambiguity.
    import importlib.util
    spec = importlib.util.spec_from_file_location("diatwin_backend_main", BACKEND / "main.py")
    backend_main = importlib.util.module_from_spec(spec)
    sys.modules["diatwin_backend_main"] = backend_main
    spec.loader.exec_module(backend_main)

    app = backend_main.create_app()
    app.config.update(TESTING=True)

    # Point every consumer at mongomock. Routes reach the database two ways
    # — `current_app.mongo.db` and a module-level `from config import mongo`
    # — but both resolve to this one object.
    client = mongomock.MongoClient()
    config.mongo.cx = client
    config.mongo.db = client["diatwin_test"]
    app.mongo = config.mongo

    return app


@pytest.fixture
def db(flask_app):
    """A clean database per test."""
    database = flask_app.mongo.db
    for name in database.list_collection_names():
        database.drop_collection(name)
    return database


@pytest.fixture
def client(flask_app, db):
    """Flask test client sharing the per-test clean database."""
    return flask_app.test_client()


@pytest.fixture
def app_ctx(flask_app, db):
    with flask_app.app_context():
        yield flask_app


# ─── Users ───────────────────────────────────────────────────────────────────

def _make_user(db, *, username: str, user_type: str, password: str = "correct-horse",
               **extra: Any) -> Dict[str, Any]:
    from werkzeug.security import generate_password_hash

    doc = {
        "username": username,
        "email": f"{username}@example.test",
        "password": generate_password_hash(password),
        "first_name": username.title(),
        "last_name": "Test",
        "date_of_birth": "1990-01-01",
        "user_type": user_type,
        "created_at": datetime.now(UTC),
    }
    if user_type == "patient":
        from constants import Constants
        for key, value in Constants.DEFAULT_PATIENT_CONSTANTS.items():
            if key != "meal_absorption_profiles":
                doc[key] = value
        doc["authorized_doctors"] = []
    doc.update(extra)
    doc["_id"] = db.users.insert_one(doc).inserted_id
    doc["_plaintext_password"] = password
    return doc


@pytest.fixture
def patient(db):
    return _make_user(db, username="patient1", user_type="patient")


@pytest.fixture
def other_patient(db):
    """A second patient, to check that data does not cross between them."""
    return _make_user(db, username="patient2", user_type="patient")


@pytest.fixture
def doctor(db):
    return _make_user(db, username="doctor1", user_type="doctor")


@pytest.fixture
def admin(db):
    return _make_user(db, username="admin1", user_type="admin")


@pytest.fixture
def authorized_doctor(db, doctor, patient):
    """A doctor the patient has explicitly added to ``authorized_doctors``."""
    db.users.update_one(
        {"_id": patient["_id"]},
        {"$set": {"authorized_doctors": [str(doctor["_id"])]}},
    )
    return doctor


# ─── Tokens ──────────────────────────────────────────────────────────────────

def make_token(flask_app, user, *, mobile: bool = False, expired: bool = False) -> str:
    """
    Mint a token directly rather than going through ``/login``.

    ``generate_token`` reads the request headers, so it needs a request
    context; encoding here keeps token construction independent of whether
    the login route happens to be working.
    """
    import jwt

    delta = timedelta(days=90) if mobile else timedelta(hours=24)
    exp = datetime.now(UTC) - timedelta(hours=1) if expired else datetime.now(UTC) + delta
    payload = {
        "user_id": str(user["_id"]),
        "user_type": user["user_type"],
        "exp": exp,
        "mobile": mobile,
    }
    return jwt.encode(payload, flask_app.config["SECRET_KEY"], algorithm="HS256")


@pytest.fixture
def auth(flask_app):
    """``auth(user)`` → headers dict carrying a valid bearer token."""
    def _auth(user, *, mobile: bool = False, expired: bool = False) -> Dict[str, str]:
        token = make_token(flask_app, user, mobile=mobile, expired=expired)
        headers = {"Authorization": f"Bearer {token}"}
        if mobile:
            headers["X-Client-Type"] = "mobile"
        return headers
    return _auth


# ─── Domain data ─────────────────────────────────────────────────────────────

@pytest.fixture
def now():
    """A fixed instant, so nothing in the suite depends on wall-clock time."""
    return datetime(2026, 3, 1, 12, 0, 0)


@pytest.fixture
def seed(db, now):
    """
    ``seed(patient)`` populates one patient with a realistic day of records.

    Deliberately writes insulin the way the app does — to ``medication_logs``
    *and* to ``meals`` as ``insulin_only`` — so tests exercise the real dual
    write rather than a tidied-up version of it.
    """
    def _seed(user) -> Dict[str, Any]:
        uid = str(user["_id"])

        readings = []
        for i in range(24):
            t = now - timedelta(hours=12) + timedelta(minutes=30 * i)
            readings.append({
                "user_id": uid,
                "bloodSugar": 110 + (i % 7) * 8,
                "bloodSugarTimestamp": t,
                "timestamp": t,
                "created_at": t,
                "bloodSugarSource": "libre",
            })
        db.blood_sugar.insert_many(readings)

        meal = {
            "user_id": uid,
            "timestamp": now - timedelta(hours=2),
            "created_at": now - timedelta(hours=2),
            "mealType": "lunch",
            "foodItems": [{"name": "Rice", "portion": {"amount": 150, "unit": "g"}}],
            "nutrition": {"carbs": 60.0, "protein": 20.0, "fat": 15.0,
                          "fiber": 3.0, "absorption_type": "medium",
                          "total_carb_equiv": 70.0},
            "bloodSugar": 132,
            "intendedInsulin": 6.0,
            "intendedInsulinType": "insulin_lispro",
            "suggestedInsulin": 5.4,
            "insulinAdministrationTime": now - timedelta(hours=2),
            "activity_ids": [],
        }
        meal["_id"] = db.meals.insert_one(meal).inserted_id

        # The projection links back with `meal_id`, and the meal is updated
        # with `meals_only_id` — mirroring meal_insulin.py:830-850 exactly.
        # The delete cascade walks both directions, so a fixture that gets
        # the field names wrong would test a shape the app never writes.
        projection_id = db.meals_only.insert_one({
            "user_id": uid,
            "timestamp": meal["timestamp"],
            "created_at": meal["created_at"],
            "mealType": "lunch",
            "foodItems": meal["foodItems"],
            "nutrition": meal["nutrition"],
            "notes": "",
            "meal_id": str(meal["_id"]),
            "source": "meal_submission",
        }).inserted_id

        db.meals.update_one({"_id": meal["_id"]},
                            {"$set": {"meals_only_id": str(projection_id)}})
        meal["meals_only_id"] = str(projection_id)

        db.medication_logs.insert_one({
            "patient_id": uid,
            "medication": "insulin_lispro",
            "dose": 6.0,
            "scheduled_time": now - timedelta(hours=2),
            "taken_at": now - timedelta(hours=2),
            "created_at": now - timedelta(hours=2),
            "status": "taken",
            "is_insulin": True,
            "notes": "",
        })

        db.activities.insert_one({
            "user_id": uid,
            "intensity": "moderate",
            "level": 2,
            "duration_minutes": 45,
            "startTime": now - timedelta(hours=5),
            "timestamp": now - timedelta(hours=5),
            "created_at": now - timedelta(hours=5),
            "type": "completed",
        })

        return {
            "patient_id": uid,
            "meal_id": str(meal["_id"]),
            "meals_only_id": str(projection_id),
            "readings": len(readings),
        }

    return _seed
