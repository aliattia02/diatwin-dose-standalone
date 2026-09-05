"""
Tests for the orphaned-meal sweep.

The classification is the whole safety story. Nine call sites write to
``meals`` and most never create a projection, so the difference between "this
meal is an orphan" and "this meal is a CGM reading" is the difference between
a cleanup and a data loss incident.

The negative cases below matter more than the positive one. Each names a
legitimate record shape the sweep must leave alone.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from bson import ObjectId

from sweep_orphaned_meals import (
    apply_deletions,
    build_backup,
    cascade_targets,
    classify,
)

NOW = datetime(2026, 3, 1, 12, 0, 0)


# ─── Builders ────────────────────────────────────────────────────────────────

def add_meal(db, *, user="p1", meal_type="lunch", food=True, projection="linked", **extra):
    """
    Insert a meal, optionally with its projection.

    ``projection``:
      "linked"  — projection exists and both ids point at each other
      "deleted" — meals_only_id recorded, projection gone (category A)
      "none"    — no projection and none recorded
    """
    meal = {
        "user_id": user,
        "timestamp": NOW,
        "created_at": NOW,
        "mealType": meal_type,
        "foodItems": [{"name": "Rice"}] if food else [],
        "nutrition": {"carbs": 60.0, "protein": 0.0, "fat": 0.0,
                      "absorption_type": "medium", "total_carb_equiv": 60.0},
    }
    meal.update(extra)
    meal["_id"] = db.meals.insert_one(meal).inserted_id

    if projection == "linked":
        projection_id = db.meals_only.insert_one({
            "user_id": user, "timestamp": NOW, "mealType": meal_type,
            "foodItems": meal["foodItems"], "nutrition": meal["nutrition"],
            "meal_id": str(meal["_id"]), "source": "meal_submission",
        }).inserted_id
        db.meals.update_one({"_id": meal["_id"]},
                            {"$set": {"meals_only_id": str(projection_id)}})
        meal["meals_only_id"] = str(projection_id)
    elif projection == "deleted":
        # What the old handler left behind: the id is recorded, the document
        # it names is gone.
        db.meals.update_one({"_id": meal["_id"]},
                            {"$set": {"meals_only_id": str(ObjectId())}})
        meal["meals_only_id"] = db.meals.find_one({"_id": meal["_id"]})["meals_only_id"]

    return meal


# ─── The one thing it deletes ────────────────────────────────────────────────

class TestCategoryA:
    def test_finds_a_meal_whose_projection_was_deleted(self, db):
        add_meal(db, projection="deleted")
        found = classify(db)
        assert len(found["orphaned_meals"]) == 1

    def test_leaves_a_healthy_meal_alone(self, db):
        add_meal(db, projection="linked")
        assert classify(db)["orphaned_meals"] == []

    def test_a_malformed_meals_only_id_counts_as_orphaned(self, db):
        meal = add_meal(db, projection="none")
        db.meals.update_one({"_id": meal["_id"]}, {"$set": {"meals_only_id": "not-an-objectid"}})
        assert len(classify(db)["orphaned_meals"]) == 1


# ─── Everything it must not touch ────────────────────────────────────────────

class TestLegitimateRecordsAreSafe:
    """
    Each of these is a real shape written by a real call site. A sweep keyed
    on "meal without a projection" would delete every one of them.
    """

    @pytest.mark.parametrize("meal_type,source", [
        ("blood_sugar_only", "blood_sugar.py:198 and libre_routes.py:192"),
        ("insulin_only", "medication_routes.py:504 and 852"),
        ("activity_only", "activity logging"),
    ])
    def test_projectionless_meal_types_are_not_orphans(self, db, meal_type, source):
        add_meal(db, meal_type=meal_type, food=False, projection="none")
        found = classify(db)
        assert found["orphaned_meals"] == [], f"would have deleted a {meal_type} record ({source})"
        assert found["unlinked_meals"] == []

    def test_a_meal_with_no_food_items_is_not_an_orphan(self, db):
        add_meal(db, food=False, projection="none")
        assert classify(db)["orphaned_meals"] == []

    def test_a_qualifying_meal_with_no_recorded_projection_is_only_reported(self, db):
        """Category C — predates meals_only_id, or came from an import."""
        add_meal(db, projection="none")
        found = classify(db)
        assert found["orphaned_meals"] == []
        assert len(found["unlinked_meals"]) == 1

    def test_a_meal_referenced_by_a_projection_is_not_unlinked(self, db):
        """The projection points back even though the meal never recorded it."""
        meal = add_meal(db, projection="none")
        db.meals_only.insert_one({"user_id": "p1", "timestamp": NOW,
                                  "meal_id": str(meal["_id"])})
        assert classify(db)["unlinked_meals"] == []

    def test_a_stray_projection_is_reported_not_deleted(self, db):
        """Category B — most likely libre_routes bulk-deleting its own meals."""
        db.meals_only.insert_one({"user_id": "p1", "timestamp": NOW,
                                  "meal_id": str(ObjectId())})
        found = classify(db)
        assert len(found["orphaned_projections"]) == 1
        assert found["orphaned_meals"] == []

    def test_an_empty_database_yields_nothing(self, db):
        found = classify(db)
        assert found["orphaned_meals"] == []
        assert found["orphaned_projections"] == []
        assert found["unlinked_meals"] == []


# ─── Scoping ─────────────────────────────────────────────────────────────────

class TestPatientScope:
    def test_scoping_excludes_other_patients(self, db):
        add_meal(db, user="p1", projection="deleted")
        add_meal(db, user="p2", projection="deleted")

        assert len(classify(db)["orphaned_meals"]) == 2
        scoped = classify(db, patient_id="p1")["orphaned_meals"]
        assert len(scoped) == 1
        assert scoped[0]["user_id"] == "p1"


# ─── Cascade ─────────────────────────────────────────────────────────────────

class TestCascade:
    @pytest.fixture
    def orphan_with_links(self, db):
        activity_id = db.activities.insert_one(
            {"user_id": "p1", "intensity": "moderate", "duration_minutes": 30,
             "startTime": NOW}).inserted_id
        reading_id = db.blood_sugar.insert_one(
            {"user_id": "p1", "bloodSugar": 130, "bloodSugarTimestamp": NOW}).inserted_id
        log_id = db.medication_logs.insert_one(
            {"patient_id": "p1", "medication": "insulin_lispro", "dose": 6.0,
             "taken_at": NOW, "is_insulin": True}).inserted_id

        meal = add_meal(db, projection="deleted",
                        activity_ids=[str(activity_id)],
                        blood_sugar_id=str(reading_id),
                        medication_log_id=str(log_id))
        return {"meal": meal, "activity": activity_id, "reading": reading_id, "log": log_id}

    def test_cascade_finds_all_three_linked_records(self, db, orphan_with_links):
        meal = db.meals.find_one({"_id": orphan_with_links["meal"]["_id"]})
        linked = cascade_targets(db, meal)
        assert len(linked["activities"]) == 1
        assert len(linked["blood_sugar"]) == 1
        assert len(linked["medication_logs"]) == 1

    def test_apply_removes_the_medication_log_that_inflates_iob(self, db, orphan_with_links):
        apply_deletions(db, classify(db))
        assert db.medication_logs.count_documents({"_id": orphan_with_links["log"]}) == 0

    def test_apply_removes_meal_and_all_links(self, db, orphan_with_links):
        apply_deletions(db, classify(db))
        assert db.meals.count_documents({}) == 0
        assert db.activities.count_documents({}) == 0
        assert db.blood_sugar.count_documents({}) == 0
        assert db.medication_logs.count_documents({}) == 0

    def test_no_cascade_leaves_the_links_in_place(self, db, orphan_with_links):
        apply_deletions(db, classify(db), cascade=False)
        assert db.meals.count_documents({}) == 0
        assert db.medication_logs.count_documents({}) == 1

    def test_cascade_does_not_reach_unrelated_records(self, db, orphan_with_links):
        other = db.medication_logs.insert_one(
            {"patient_id": "p1", "medication": "insulin_lispro", "dose": 3.0,
             "taken_at": NOW + timedelta(hours=2), "is_insulin": True}).inserted_id

        apply_deletions(db, classify(db))
        assert db.medication_logs.count_documents({"_id": other}) == 1


# ─── Safety ──────────────────────────────────────────────────────────────────

class TestSafety:
    def test_classify_does_not_modify_anything(self, db):
        add_meal(db, projection="deleted")
        add_meal(db, projection="linked")
        before = (db.meals.count_documents({}), db.meals_only.count_documents({}))

        classify(db)
        classify(db, patient_id="p1")

        assert (db.meals.count_documents({}), db.meals_only.count_documents({})) == before

    def test_backup_contains_every_document_that_gets_deleted(self, db):
        activity_id = db.activities.insert_one(
            {"user_id": "p1", "intensity": "light", "startTime": NOW}).inserted_id
        add_meal(db, projection="deleted", activity_ids=[str(activity_id)])

        findings = classify(db)
        backup = build_backup(db, findings)
        removed = apply_deletions(db, findings)

        assert len(backup["meals"]) == removed["meals"] == 1
        assert len(backup["activities"]) == removed["activities"] == 1

    def test_backup_is_json_serializable(self, db):
        import json
        from sweep_orphaned_meals import _json_default

        add_meal(db, projection="deleted")
        backup = build_backup(db, classify(db))
        text = json.dumps(backup, default=_json_default)
        assert "meals" in json.loads(text)

    def test_apply_refuses_without_export(self):
        """The CLI guard, checked directly rather than trusted."""
        from sweep_orphaned_meals import main
        with pytest.raises(SystemExit) as excinfo:
            main(["--apply"])
        assert excinfo.value.code == 2

    def test_running_twice_is_a_no_op_the_second_time(self, db):
        add_meal(db, projection="deleted")
        assert apply_deletions(db, classify(db))["meals"] == 1
        assert classify(db)["orphaned_meals"] == []
