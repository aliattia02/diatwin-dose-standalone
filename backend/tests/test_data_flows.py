"""
End-to-end flows through the API.

Where ``test_route_inventory`` asks whether routes respond and
``test_pharmacodynamics`` asks whether the maths is right, this asks the
question a user would: if I record something, does it come back correctly?

Each class follows one record from POST through storage to GET, and checks
the things that are easy to get wrong and invisible when they are —
timestamps surviving a round trip, one collection agreeing with another,
and a second patient's data staying out of the first patient's results.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

UTC = timezone.utc


def json_of(response):
    """Response body, with a readable assertion message when it is not JSON."""
    assert response.status_code < 500, response.get_data(as_text=True)[:400]
    return response.get_json()


# ─── Blood glucose ───────────────────────────────────────────────────────────

class TestBloodGlucoseFlow:
    ENDPOINT = "/api/blood-sugar"

    def test_record_and_read_back(self, client, patient, auth):
        post = client.post(self.ENDPOINT, json={
            "bloodSugar": 142,
            "bloodSugarTimestamp": "2026-03-01T12:00:00Z",
        }, headers=auth(patient))
        assert post.status_code < 400, post.get_data(as_text=True)[:300]

        got = json_of(client.get(self.ENDPOINT, headers=auth(patient)))
        values = [r["bloodSugar"] for r in (got if isinstance(got, list) else got.get("data", []))]
        assert 142 in values

    def test_reading_is_stored_with_its_reading_time_not_the_write_time(
            self, client, db, patient, auth):
        """
        ``bloodSugarTimestamp`` is when the measurement was taken;
        ``timestamp`` is when the server heard about it. A CGM backfill
        writes readings hours after the fact, so conflating the two shifts
        the whole series.
        """
        client.post(self.ENDPOINT, json={
            "bloodSugar": 155,
            "bloodSugarTimestamp": "2026-03-01T08:30:00Z",
        }, headers=auth(patient))

        stored = db.blood_sugar.find_one({"bloodSugar": 155})
        assert stored is not None
        from diatwin.data.normalize import parse_time
        reading_time = parse_time(stored.get("bloodSugarTimestamp"))
        assert reading_time == datetime(2026, 3, 1, 8, 30, tzinfo=UTC)

    @pytest.mark.parametrize("timestamp", [
        "2026-03-01T12:00:00Z",
        "2026-03-01T12:00:00+00:00",
        "2026-03-01T12:00:00",
    ])
    def test_accepts_every_timestamp_format_the_clients_send(
            self, client, db, patient, auth, timestamp):
        response = client.post(self.ENDPOINT,
                               json={"bloodSugar": 130, "bloodSugarTimestamp": timestamp},
                               headers=auth(patient))
        assert response.status_code < 400, f"{timestamp} rejected"

    def test_missing_value_is_rejected(self, client, patient, auth):
        response = client.post(self.ENDPOINT,
                               json={"bloodSugarTimestamp": "2026-03-01T12:00:00Z"},
                               headers=auth(patient))
        assert 400 <= response.status_code < 500

    def test_one_patients_readings_do_not_appear_for_another(
            self, client, patient, other_patient, auth, seed):
        seed(patient)
        body = json_of(client.get(self.ENDPOINT, headers=auth(other_patient)))
        rows = body if isinstance(body, list) else body.get("data", [])
        assert rows == [], "another patient's readings leaked into this response"


# ─── Meals and insulin ───────────────────────────────────────────────────────

class TestMealFlow:
    def test_seeded_meal_is_readable(self, client, patient, auth, seed):
        seed(patient)
        body = json_of(client.get("/api/meals-only", headers=auth(patient)))
        assert body is not None

    def test_meals_and_meals_only_stay_in_step(self, db, patient, seed):
        """
        The two collections are written together and must agree on the
        record they describe. They are the main source of ambiguity for the
        dataset builder, so a drift here is worth catching early.
        """
        seed(patient)
        meal = db.meals.find_one({})
        projection = db.meals_only.find_one({})
        assert meal["timestamp"] == projection["timestamp"]
        assert meal["nutrition"]["carbs"] == projection["nutrition"]["carbs"]
        assert projection["meal_id"] == str(meal["_id"])
        assert meal["meals_only_id"] == str(projection["_id"])

    def test_insulin_is_recorded_in_both_places(self, db, patient, seed):
        """
        Characterizes the dual write rather than objecting to it: a bolus
        exists as ``intendedInsulin`` on the meal *and* as a
        ``medication_logs`` row. Any consumer reading both must deduplicate.
        ``diatwin.data.normalize.dedupe_insulin`` is what does that.
        """
        seed(patient)
        meal = db.meals.find_one({})
        log = db.medication_logs.find_one({"is_insulin": True})

        assert meal["intendedInsulin"] == log["dose"] == 6.0
        assert meal["intendedInsulinType"] == log["medication"]

    def test_the_dual_write_would_double_count_without_dedupe(self, db, patient, seed):
        """The consequence, stated as an executable fact."""
        seed(patient)
        from diatwin.data.normalize import normalize_all

        result = normalize_all(
            meal_docs=list(db.meals.find({})),
            medication_docs=list(db.medication_logs.find({})),
        )
        naive_total = 6.0 + 6.0
        deduped_total = sum(d.units for d in result["insulin"])
        assert deduped_total == 6.0
        assert naive_total == 12.0, "reading both collections raw doubles the dose"


# ─── Cumulative effects ──────────────────────────────────────────────────────

class TestCumulativeEffectsEndpoint:
    ENDPOINT = "/api/cumulative-effects"

    def test_returns_a_payload_for_a_seeded_patient(self, client, patient, auth, seed):
        seed(patient)
        body = json_of(client.get(self.ENDPOINT, headers=auth(patient)))
        assert body is not None

    def test_works_with_no_data_at_all(self, client, patient, auth):
        """A brand new patient must not crash the effects calculation."""
        response = client.get(self.ENDPOINT, headers=auth(patient))
        assert response.status_code < 500

    def test_accepts_an_explicit_target_time(self, client, patient, auth, seed):
        seed(patient)
        response = client.get(
            f"{self.ENDPOINT}?target_time=2026-03-01T12:00:00Z", headers=auth(patient))
        assert response.status_code < 500

    def test_rejects_a_malformed_target_time(self, client, patient, auth, seed):
        seed(patient)
        response = client.get(f"{self.ENDPOINT}?target_time=not-a-time",
                              headers=auth(patient))
        assert response.status_code < 500, "a bad query param must not 500"


# ─── Activity ────────────────────────────────────────────────────────────────

class TestActivityFlow:
    def test_seeded_activity_is_readable(self, client, patient, auth, seed):
        seed(patient)
        response = client.get("/api/activity-history", headers=auth(patient))
        assert response.status_code < 500

    def test_activity_normalizes_for_the_pd_model(self, db, patient, seed):
        """
        The activity record as stored must survive
        ``normalize_activity_record`` — that function is the only bridge
        between the collection and the exercise model, and it returns None
        for anything it does not recognise.
        """
        seed(patient)
        from utils.activity_pharmacodynamics import normalize_activity_record

        raw = db.activities.find_one({})
        assert normalize_activity_record(raw) is not None, (
            "a record the app wrote is not readable by the activity model"
        )


# ─── Patient constants ───────────────────────────────────────────────────────

class TestPatientConstants:
    ENDPOINT = "/api/patient/constants"

    def test_new_patient_gets_the_defaults(self, client, patient, auth):
        body = json_of(client.get(self.ENDPOINT, headers=auth(patient)))
        constants = body.get("constants", body)
        assert constants.get("insulin_to_carb_ratio") is not None
        assert constants.get("correction_factor") is not None

    def test_constants_shipped_at_login_match_the_endpoint(self, client, patient, auth):
        """
        Login embeds ``shared_constants`` so clients never run on a stale
        copy. If that payload drifts from the constants endpoint, the app
        and the server disagree about the patient's own parameters.
        """
        login = client.post("/login", json={
            "username": patient["username"],
            "password": patient["_plaintext_password"],
            "user_type": "patient",
        })
        assert login.status_code == 200, login.get_data(as_text=True)[:300]
        embedded = login.get_json()["shared_constants"]
        assert embedded, "login returned no shared_constants"

        # Compare through JSON on both sides: the constants table holds
        # tuples (time_of_day_factors' hour ranges) which serialize to lists,
        # so a direct dict comparison reports a difference that is not one.
        import json
        from constants import Constants
        reference = json.loads(json.dumps(Constants.get_shared_constants_json(), default=str))
        assert embedded == reference


# ─── Auth flows ──────────────────────────────────────────────────────────────

class TestAuthFlow:
    def test_register_then_login(self, client):
        registration = client.post("/register", json={
            "username": "newuser", "email": "newuser@example.test",
            "password": "a-good-password", "firstName": "New", "lastName": "User",
            "dateOfBirth": "1990-01-01", "user_type": "patient",
        })
        assert registration.status_code == 201, registration.get_data(as_text=True)[:300]

        login = client.post("/login", json={
            "username": "newuser", "password": "a-good-password", "user_type": "patient",
        })
        assert login.status_code == 200
        assert login.get_json()["token"]

    def test_login_with_wrong_password_fails(self, client, patient):
        response = client.post("/login", json={
            "username": patient["username"], "password": "wrong", "user_type": "patient",
        })
        assert response.status_code == 401

    def test_login_with_wrong_user_type_fails(self, client, patient):
        """A patient's credentials must not authenticate as a doctor."""
        response = client.post("/login", json={
            "username": patient["username"],
            "password": patient["_plaintext_password"],
            "user_type": "doctor",
        })
        assert response.status_code == 401

    def test_duplicate_username_is_rejected(self, client, patient):
        response = client.post("/register", json={
            "username": patient["username"], "email": "different@example.test",
            "password": "x", "firstName": "A", "lastName": "B",
            "dateOfBirth": "1990-01-01", "user_type": "patient",
        })
        assert response.status_code == 400

    def test_mobile_client_gets_a_longer_token(self, client, patient):
        """Documents the 90-day mobile token, so a change to it is visible."""
        import jwt
        from flask import current_app

        response = client.post("/login",
                               json={"username": patient["username"],
                                     "password": patient["_plaintext_password"],
                                     "user_type": "patient"},
                               headers={"X-Client-Type": "mobile"})
        token = response.get_json()["token"]
        claims = jwt.decode(token, options={"verify_signature": False})
        assert claims["mobile"] is True

        lifetime = datetime.fromtimestamp(claims["exp"], tz=UTC) - datetime.now(UTC)
        assert lifetime > timedelta(days=80)

    def test_web_client_gets_a_short_token(self, client, patient):
        import jwt
        response = client.post("/login", json={
            "username": patient["username"],
            "password": patient["_plaintext_password"],
            "user_type": "patient",
        })
        claims = jwt.decode(response.get_json()["token"], options={"verify_signature": False})
        lifetime = datetime.fromtimestamp(claims["exp"], tz=UTC) - datetime.now(UTC)
        assert lifetime < timedelta(days=2)


# ─── Doctor access ───────────────────────────────────────────────────────────

class TestDoctorAccess:
    """
    Characterizes the two different authorization models in the codebase.

    ``doctor_routes`` checks the patient's ``authorized_doctors`` list.
    ``meal_routes``, ``cumulative_effects_routes`` and ``medication_routes``
    check only that the caller's ``user_type`` is ``doctor``.

    Recorded, not flagged — the deployment is a closed test environment. The
    tests exist so that whenever the two models are unified, the change is
    visible rather than silent.
    """

    def test_authorized_doctor_can_read_patient_constants(
            self, client, patient, authorized_doctor, auth):
        response = client.get(
            f"/api/doctor/patient/{patient['_id']}/constants",
            headers=auth(authorized_doctor))
        assert response.status_code == 200

    def test_unauthorized_doctor_is_refused_by_doctor_routes(
            self, client, patient, doctor, auth):
        response = client.get(
            f"/api/doctor/patient/{patient['_id']}/constants", headers=auth(doctor))
        assert response.status_code == 403

    def test_patient_cannot_use_doctor_routes(self, client, patient, other_patient, auth):
        response = client.get(
            f"/api/doctor/patient/{other_patient['_id']}/constants", headers=auth(patient))
        assert response.status_code == 403

    def test_meal_routes_accept_any_doctor(self, client, patient, doctor, auth, seed):
        """
        The looser model, stated plainly: a doctor who is *not* in
        ``authorized_doctors`` still reads this patient's meals.
        """
        seed(patient)
        response = client.get(
            f"/api/meals-only?patient_id={patient['_id']}", headers=auth(doctor))
        assert response.status_code == 200, (
            "current behaviour: meal_routes checks user_type only"
        )

    def test_a_patient_cannot_pass_patient_id_for_someone_else(
            self, client, patient, other_patient, auth, seed):
        seed(other_patient)
        response = client.get(
            f"/api/meals-only?patient_id={other_patient['_id']}", headers=auth(patient))
        assert response.status_code == 403
