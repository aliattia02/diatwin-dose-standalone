"""
Characterization tests for defects found by the first full test pass.

Each test here asserts what the code does *today*, not what it should do,
and says so. That is deliberate: a characterization test locks current
behaviour in place so a fix produces a visible, reviewable failure rather
than a silent change. When one of these starts failing, that is the signal
to update it to the new expectation and delete the note.

Discovered 2026-09-05 by ``test_route_inventory.py``. Severity ordering is
by clinical impact, not by how easy each is to fix.
"""

from __future__ import annotations

import pytest
from bson import ObjectId


# ─── 1. Deleting a meal leaves its insulin behind ────────────────────────────

class TestDeleteMealCascade:
    """
    Regression tests for D1, fixed 2026-09-05.

    ``DELETE /api/meal/<meal_id>`` used to be registered twice against
    different collections. Flask kept both — the endpoint names differ — and
    routed to whichever blueprint registered first, which was
    ``patient_routes`` at index 3, ahead of ``meal_insulin`` at index 5. That
    handler deleted only the ``meals_only`` projection, so the authoritative
    record survived every delete and kept contributing its insulin dose to
    IOB and cumulative effects.

    Removing the duplicate on its own would have broken the client: the
    mobile app lists meals from ``/api/meals-only`` and therefore deletes by
    the *projection's* id, which the surviving handler did not recognise. So
    the handler now resolves either id and cascades.
    """

    def test_only_one_handler_owns_the_route(self, flask_app):
        endpoints = {
            rule.endpoint
            for rule in flask_app.url_map.iter_rules()
            if rule.rule == "/api/meal/<meal_id>" and "DELETE" in rule.methods
        }
        assert endpoints == {"meal_insulin.delete_meal"}

    def test_delete_by_projection_id_removes_both(self, client, db, patient, auth, seed):
        """The path the mobile client actually takes."""
        info = seed(patient)

        response = client.delete(f"/api/meal/{info['meals_only_id']}", headers=auth(patient))

        assert response.status_code == 200, response.get_data(as_text=True)[:300]
        assert db.meals_only.count_documents({}) == 0
        assert db.meals.count_documents({}) == 0, "the meal record must not survive"

    def test_delete_by_meal_id_removes_both(self, client, db, patient, auth, seed):
        """The path a doctor view or an older caller takes."""
        info = seed(patient)

        response = client.delete(f"/api/meal/{info['meal_id']}", headers=auth(patient))

        assert response.status_code == 200, response.get_data(as_text=True)[:300]
        assert db.meals.count_documents({}) == 0
        assert db.meals_only.count_documents({}) == 0

    def test_deleted_meal_no_longer_carries_insulin(self, client, db, patient, auth, seed):
        """The clinically relevant consequence, inverted from the defect."""
        info = seed(patient)
        client.delete(f"/api/meal/{info['meals_only_id']}", headers=auth(patient))

        assert db.meals.find_one({"intendedInsulin": {"$gt": 0}}) is None, (
            "a deleted meal's insulin dose is still on the books"
        )

    def test_cascade_removes_the_linked_activity(self, client, db, patient, auth, seed):
        info = seed(patient)
        activity_id = db.activities.find_one({})["_id"]
        db.meals.update_one({"_id": ObjectId(info["meal_id"])},
                            {"$set": {"activity_ids": [str(activity_id)]}})

        client.delete(f"/api/meal/{info['meal_id']}", headers=auth(patient))
        assert db.activities.count_documents({"_id": activity_id}) == 0

    def test_cascade_removes_the_linked_medication_log(self, client, db, patient, auth, seed):
        info = seed(patient)
        log_id = db.medication_logs.find_one({"is_insulin": True})["_id"]
        db.meals.update_one({"_id": ObjectId(info["meal_id"])},
                            {"$set": {"medication_log_id": str(log_id)}})

        client.delete(f"/api/meal/{info['meal_id']}", headers=auth(patient))
        assert db.medication_logs.count_documents({"_id": log_id}) == 0

    def test_an_orphan_projection_can_still_be_cleaned_up(self, client, db, patient, auth, seed):
        """
        Records left behind by the old handler must remain deletable.

        Every meal deleted before this fix left a ``meals`` document with no
        projection; the reverse case — a projection whose parent is gone —
        must not become a permanently undeletable row.
        """
        info = seed(patient)
        db.meals.delete_one({"_id": ObjectId(info["meal_id"])})

        response = client.delete(f"/api/meal/{info['meals_only_id']}", headers=auth(patient))
        assert response.status_code == 200
        assert db.meals_only.count_documents({}) == 0

    def test_another_patient_cannot_delete_the_meal(
            self, client, db, patient, other_patient, auth, seed):
        info = seed(patient)
        response = client.delete(f"/api/meal/{info['meal_id']}", headers=auth(other_patient))
        assert response.status_code == 403
        assert db.meals.count_documents({}) == 1

    def test_unknown_id_is_a_404(self, client, patient, auth):
        response = client.delete(f"/api/meal/{ObjectId()}", headers=auth(patient))
        assert response.status_code == 404

    def test_malformed_id_is_a_400(self, client, patient, auth):
        response = client.delete("/api/meal/not-an-objectid", headers=auth(patient))
        assert response.status_code == 400


# ─── 2. Malformed JSON becomes a 500 ─────────────────────────────────────────

class TestMalformedJsonHandling:
    """
    ``blood_sugar.py:46`` logs ``request.json`` before validating anything.
    On a malformed body that raises ``BadRequest``, which the handler's own
    ``except Exception`` converts into a 500.

    A client sending bad JSON should get a 400. Returning 500 also means the
    error is logged as a server fault, which hides real faults in the noise.
    """

    def test_malformed_body_returns_500_not_400(self, client, patient, auth):
        response = client.post(
            "/api/blood-sugar",
            data="{not json",
            content_type="application/json",
            headers=auth(patient),
        )
        assert response.status_code == 500, "DEFECT: should be 400"

    def test_wellformed_body_still_works(self, client, patient, auth):
        response = client.post(
            "/api/blood-sugar",
            json={"bloodSugar": 120, "bloodSugarTimestamp": "2026-03-01T12:00:00Z"},
            headers=auth(patient),
        )
        assert response.status_code < 400


# ─── 3. Unauthenticated bulk import ──────────────────────────────────────────

class TestBulkImportIsCompletelyBroken:
    """
    ``/api/bulk-import`` raises ``NameError`` on every call and always has.

    ``routes/import_routes.py`` imports ``Blueprint, request, jsonify`` from
    flask but never ``current_app``, and line 1548 is the file's only use of
    it. The handler's broad ``except Exception`` swallows the NameError and
    returns it as a 500, so the endpoint looks like it is failing on the
    data rather than failing to exist.

    **Decision 2026-09-05: kept, not deleted — it may be needed later.**

    "Kept" currently means kept non-functional, which is a deliberate resting
    state rather than an oversight. The missing import is a one-line change,
    but applying it would turn a dormant unauthenticated bulk-write endpoint
    into a live one, and that is a separate call to make when the import
    pipeline actually needs it.

    These tests hold the current state in place. When the endpoint is
    revived, they fail — which is the prompt to decide what authentication
    it should carry at the same time.
    """

    def test_route_has_no_auth_decorator(self, client):
        response = client.post("/api/bulk-import", json={"username": "nobody", "records": []})
        assert response.status_code != 401

    def test_every_call_fails_with_a_name_error(self, client, patient):
        """Even a valid username and an empty record set cannot succeed."""
        response = client.post(
            "/api/bulk-import",
            json={"username": patient["username"], "records": []},
        )
        assert response.status_code == 500
        assert "current_app" in response.get_json()["error"], (
            "DEFECT: NameError from the missing flask import"
        )

    def test_empty_body_also_500s(self, client):
        """A separate fault: ``data.get`` runs before the ``None`` check."""
        response = client.post("/api/bulk-import", data="", content_type="application/json")
        assert response.status_code == 500, "DEFECT: should be 400"


# ─── 4. Dead code in the mobile insulin module ───────────────────────────────

def test_note_mobile_get_available_insulin_types_reads_wrong_keys():
    """
    Not a backend test — recorded here so the finding has one home.

    ``mobile/utils/insulin/pharmacodynamics.ts:1368-1371`` builds its result
    from ``value.onsetHours`` / ``peakHours`` / ``durationHours`` /
    ``isPeakless``, but the profile objects use snake_case. Every entry
    returned by ``getAvailableInsulinTypes()`` therefore carries four
    ``undefined`` fields.

    Currently latent: neither ``getAvailableInsulinTypes`` nor
    ``getInsulinTypesByCategory`` is called anywhere in the app. It becomes
    a live bug the moment an insulin picker is wired to them.

    ``npx tsc --noEmit`` reports it as TS2551. It is one of 194 type errors
    the typecheck currently surfaces.
    """
    pytest.skip("documented finding; enforced by mobile typecheck, not pytest")
