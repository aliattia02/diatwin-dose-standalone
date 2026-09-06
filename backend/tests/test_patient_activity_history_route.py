"""
`GET /api/patient/<patient_id>/activity-history` (backend/activity.py) —
D27: it had no authorization check against the calling doctor at all.

Every other `/api/doctor/patient/<id>/*` endpoint calls
`check_doctor_patient_access`, which confirms the doctor is on the patient's
`authorized_doctors` list before returning anything (`doctor_routes.py:14`).
This route only checked `current_user['user_type'] == 'doctor'` — any doctor
account, authorized or not, could read any patient's activity history by
guessing or enumerating patient ids. It is wired into the web frontend's
`ActivityVisualization` in this same session (D28) specifically because it is
the one activity endpoint whose response shape the pharmacodynamic model can
actually consume, which makes it worth reaching this defect deliberately
rather than leaving it for whoever eventually used the route.

This route is also the reason `ActivityVisualization` was previously wired to
`/api/doctor/patient/<id>/activity-history` in the mobile client's history: a
comment in `mobile/services/api/endpoints.ts` says this route "did NOT exist in
any backend file" and that the mobile client switched away from it. It exists
now, and returns the correct shape — the comment is stale, not a warning to
route around it. `test_the_stale_mobile_comment_no_longer_holds` below pins
that directly, so it cannot silently regress again in either direction.
"""

from __future__ import annotations

from datetime import timedelta

import pytest


ENDPOINT = "/api/patient/{}/activity-history"


class TestAuthorization:

    def test_the_authorized_doctor_can_read_it(self, client, authorized_doctor, patient, auth, db):
        db.activities.insert_one({
            "user_id": str(patient["_id"]), "type": "running", "level": 2,
        })
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(authorized_doctor))
        assert response.status_code == 200

    def test_an_unauthorized_doctor_is_rejected(self, client, doctor, patient, auth, db):
        """
        The defect itself. `doctor` here is deliberately not
        `authorized_doctor` — the patient has never listed them.
        """
        db.activities.insert_one({
            "user_id": str(patient["_id"]), "type": "running", "level": 2,
            "notes": "private note",
        })
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(doctor))
        assert response.status_code == 403
        # Nothing about the patient's data reaches an unauthorized caller.
        assert "private note" not in response.get_data(as_text=True)

    def test_admin_can_read_any_patient(self, client, admin, patient, auth, db):
        # check_doctor_patient_access grants admins access to every patient,
        # matching every other doctor-facing endpoint in this codebase.
        db.activities.insert_one({"user_id": str(patient["_id"]), "type": "walking", "level": 1})
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(admin))
        assert response.status_code == 200

    def test_a_patient_cannot_call_it_at_all(self, client, patient, auth):
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(patient))
        assert response.status_code == 403

    def test_an_unknown_patient_id_is_not_confused_with_authorized(
        self, client, doctor, auth
    ):
        # A doctor with no relationship to ANY patient, against an id that
        # does not exist, must not somehow read as authorized.
        response = client.get(ENDPOINT.format("000000000000000000000000"), headers=auth(doctor))
        assert response.status_code in (403, 404)


class TestResponseShape:
    """
    D28's other half: the shape this route returns is what makes it usable by
    the frontend's PD-model activity visualisation at all, unlike the sibling
    `/api/doctor/patient/<id>/activity-history` route, whose narrower field
    names (`activityType`, `activityLevel`) do not include `level`,
    `intensity`, `duration_minutes` or `bg_direction` and so are silently
    unusable by `normalizeActivityRecord` (frontend
    `utils/activityPharmacodynamics.js`) — every record from that route maps
    to `null` and is filtered out.
    """

    def test_the_pd_model_fields_are_present(self, client, authorized_doctor, patient, auth, db):
        db.activities.insert_one({
            "user_id": str(patient["_id"]),
            "type": "running", "level": 2, "impact": -0.5,
            "intensity": "moderate", "duration_minutes": 30, "bg_direction": -1,
        })
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(authorized_doctor))
        record = response.get_json()[0]
        for field in ("type", "level", "impact", "intensity", "duration_minutes", "bg_direction"):
            assert field in record, f"missing {field} — the PD normalizer needs it"

    def test_the_stale_mobile_comment_no_longer_holds(self, client, authorized_doctor, patient, auth):
        """
        `mobile/services/api/endpoints.ts` says this route "did NOT exist in
        any backend file" as the reason mobile calls
        `/api/doctor/patient/<id>/activity-history` instead. That route
        returns a materially different, PD-incompatible shape (see above), so
        the comment matters: if this route ever really does disappear again,
        whoever notices should find this test rather than rediscover the
        history by reading two files against each other.
        """
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(authorized_doctor))
        assert response.status_code != 404


class TestNegative:

    def test_a_second_patients_activity_never_appears(
        self, client, authorized_doctor, patient, other_patient, auth, db
    ):
        db.activities.insert_one({"user_id": str(patient["_id"]), "type": "running", "level": 2})
        db.activities.insert_one({"user_id": str(other_patient["_id"]), "type": "yoga", "level": 1})

        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(authorized_doctor))
        types = [a["type"] for a in response.get_json()]
        assert types == ["running"]

    def test_a_patient_with_no_activities_returns_an_empty_list_not_an_error(
        self, client, authorized_doctor, patient, auth
    ):
        response = client.get(ENDPOINT.format(str(patient["_id"])), headers=auth(authorized_doctor))
        assert response.status_code == 200
        assert response.get_json() == []
