"""
The doctor's view of a patient's constants must carry the patient's timezone.

`GET /api/doctor/patient/<id>/constants` returned `daily_reset_hour` but not
`timezone_offset_minutes`. Both are stored on the patient document — the field
is declared at `constants.py:285` and backfilled by `migrate_timezone_offset.py`
— and only this response dropped one of them.

That is a real gap rather than a cosmetic one. `daily_reset_hour` means nothing
without the offset it is anchored in: a reset hour of 07:00 is a different
instant for a patient in Cairo and one in Auckland. With the offset missing, a
doctor's client has no way to learn it and falls back to the browser's own —
which is D24, the defect the web frontend was carrying at seven call sites, but
arriving from the API side where no amount of client work could fix it.

These tests pin the field's presence and, more importantly, its *value*: a
response that always returned 0 would satisfy a presence check while still
telling a clinician the wrong thing.
"""

import pytest


ENDPOINT = "/api/doctor/patient/{}/constants"


class TestPatientConstantsCarryTheTimezone:

    def test_response_includes_timezone_offset_minutes(
        self, client, authorized_doctor, patient, auth
    ):
        response = client.get(
            ENDPOINT.format(str(patient["_id"])),
            headers=auth(authorized_doctor),
        )
        assert response.status_code == 200

        constants = response.get_json()["constants"]
        assert "timezone_offset_minutes" in constants, (
            "the doctor cannot anchor daily_reset_hour without the offset"
        )

    def test_reset_hour_and_offset_travel_together(
        self, client, authorized_doctor, patient, auth
    ):
        """Neither is useful alone, so neither may be dropped alone."""
        response = client.get(
            ENDPOINT.format(str(patient["_id"])),
            headers=auth(authorized_doctor),
        )
        constants = response.get_json()["constants"]

        assert "daily_reset_hour" in constants
        assert "timezone_offset_minutes" in constants

    @pytest.mark.parametrize("offset", [-720, -300, 0, 330, 345, 780, 840])
    def test_the_patient_stored_offset_is_returned_not_a_default(
        self, client, db, authorized_doctor, patient, auth, offset
    ):
        """
        The value must be the patient's own.

        A response hard-coding 0 would pass a presence check and still hand the
        clinician a boundary a day out for anyone east of +07:00 — which is
        exactly the shape D9 took in the mobile client. The half-hour and
        quarter-hour offsets are included because they are real and are where
        an implementation that stores whole hours would break.
        """
        db.users.update_one(
            {"_id": patient["_id"]},
            {"$set": {"timezone_offset_minutes": offset}},
        )

        response = client.get(
            ENDPOINT.format(str(patient["_id"])),
            headers=auth(authorized_doctor),
        )
        assert response.status_code == 200
        assert response.get_json()["constants"]["timezone_offset_minutes"] == offset

    def test_a_patient_with_no_stored_offset_gets_the_default(
        self, client, db, authorized_doctor, patient, auth
    ):
        """
        The negative case: absent must not become an error or a null.

        A patient predating the migration has no field at all, and the endpoint
        should answer with the documented default rather than omitting the key
        and pushing the caller back onto the browser.
        """
        db.users.update_one(
            {"_id": patient["_id"]},
            {"$unset": {"timezone_offset_minutes": ""}},
        )

        response = client.get(
            ENDPOINT.format(str(patient["_id"])),
            headers=auth(authorized_doctor),
        )
        assert response.status_code == 200

        constants = response.get_json()["constants"]
        assert constants["timezone_offset_minutes"] == 0

    def test_an_unauthorized_doctor_still_gets_nothing(
        self, client, doctor, patient, auth
    ):
        """
        Adding a field must not widen who can read the document.

        `doctor` here is deliberately not the `authorized_doctor` fixture — the
        patient has not listed them.
        """
        response = client.get(
            ENDPOINT.format(str(patient["_id"])),
            headers=auth(doctor),
        )
        assert response.status_code in (403, 404)
        assert "timezone_offset_minutes" not in response.get_data(as_text=True)
