#!/usr/bin/env python
"""
Find — and optionally remove — meals orphaned by the old delete handler.

Background
----------
``DELETE /api/meal/<id>`` used to resolve to a handler that removed only the
``meals_only`` projection. The authoritative ``meals`` document survived, and
with it the ``medication_logs`` row that drives IOB. Every meal a patient
deleted before 2026-09-05 is still contributing insulin to the cumulative
effects calculation.

What counts as an orphan
------------------------
Being careful here matters more than being thorough. **Most meals legitimately
have no projection.** Nine call sites write to ``meals``; only
``meal_insulin.py:830`` creates a ``meals_only`` document, and only when the
meal has food items and is not a ``blood_sugar_only`` / ``activity_only`` /
``insulin_only`` record. A sweep that deleted "meals without a projection"
would destroy every CGM reading, every standalone insulin dose and every
imported record in the database.

There is exactly one unambiguous signal:

    meals.meals_only_id IS SET  and  no meals_only document has that _id

``meals_only_id`` is written in one place, immediately after the projection is
created (``meal_insulin.py:849``). The only code that deletes from
``meals_only`` is the repaired handler, which deletes the meal in the same
breath. So a meal that recorded a projection which is now gone can only have
come from the old handler. That is category A, and it is the only category
this script will delete.

Two other patterns are *reported and never touched*:

    B  a projection whose meal_id points at a meal that no longer exists
    C  a meal that qualifies for a projection but never recorded one

B is most likely from ``libre_routes`` bulk-deleting Libre-sourced meals. C is
most likely records that predate the ``meals_only_id`` field, or bulk imports.
Neither is safely distinguishable from legitimate data, so neither is deleted.

Usage
-----
    python sweep_orphaned_meals.py                          # report only
    python sweep_orphaned_meals.py --patient <user_id>      # scope to one patient
    python sweep_orphaned_meals.py --export backup.json     # report + write backup
    python sweep_orphaned_meals.py --apply --export backup.json

``--apply`` refuses to run without ``--export``. Nothing is deleted unless you
ask for it twice.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from bson import ObjectId

#: Meal types that never get a projection — see meal_insulin.py:829.
NON_MEAL_TYPES = {"blood_sugar_only", "activity_only", "insulin_only"}


# ─── Classification (pure — unit tested in tests/test_sweep_orphaned_meals.py) ──

def _as_object_id(value: Any) -> Optional[ObjectId]:
    try:
        return ObjectId(value)
    except Exception:
        return None


def _qualifies_for_projection(meal: Dict[str, Any]) -> bool:
    """Whether this meal would have had a ``meals_only`` document written."""
    food_items = meal.get("foodItems") or []
    return bool(food_items) and str(meal.get("mealType", "")) not in NON_MEAL_TYPES


def classify(db, *, patient_id: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    """
    Sort every meal and projection into the three categories above.

    Reads only. Returns plain dicts so the caller can report, export or
    delete without a second pass over the database.
    """
    meal_query: Dict[str, Any] = {}
    projection_query: Dict[str, Any] = {}
    if patient_id:
        meal_query["user_id"] = patient_id
        projection_query["user_id"] = patient_id

    meals = list(db.meals.find(meal_query))
    projections = list(db.meals_only.find(projection_query))

    projection_ids = {p["_id"] for p in projections}
    meal_ids = {m["_id"] for m in meals}
    referenced_meal_ids = {
        oid for oid in (_as_object_id(p.get("meal_id")) for p in projections) if oid
    }

    orphaned_meals: List[Dict[str, Any]] = []
    unlinked_meals: List[Dict[str, Any]] = []

    for meal in meals:
        recorded = meal.get("meals_only_id")
        if recorded:
            recorded_oid = _as_object_id(recorded)
            if recorded_oid is None or recorded_oid not in projection_ids:
                orphaned_meals.append(meal)          # A — deleted by the old handler
            continue

        # No projection ever recorded. Only interesting if one was due.
        if _qualifies_for_projection(meal) and meal["_id"] not in referenced_meal_ids:
            unlinked_meals.append(meal)              # C — report only

    orphaned_projections = [
        p for p in projections
        if (oid := _as_object_id(p.get("meal_id"))) is not None and oid not in meal_ids
    ]                                                # B — report only

    return {
        "orphaned_meals": orphaned_meals,
        "orphaned_projections": orphaned_projections,
        "unlinked_meals": unlinked_meals,
        "totals": {"meals": len(meals), "projections": len(projections)},
    }


def cascade_targets(db, meal: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Everything that would be removed alongside ``meal``.

    Mirrors the repaired handler in ``meal_insulin.delete_meal``. The
    medication log matters most: cumulative effects reads IOB from
    ``medication_logs``, so leaving that row behind would keep the phantom
    insulin even after the meal is gone.
    """
    activities: List[Dict[str, Any]] = []
    activity_ids = [oid for oid in (_as_object_id(a) for a in meal.get("activity_ids") or []) if oid]
    if activity_ids:
        activities = list(db.activities.find({"_id": {"$in": activity_ids}}))

    blood_sugar: List[Dict[str, Any]] = []
    if bs_id := _as_object_id(meal.get("blood_sugar_id")):
        blood_sugar = list(db.blood_sugar.find({"_id": bs_id}))

    medication_logs: List[Dict[str, Any]] = []
    if log_id := _as_object_id(meal.get("medication_log_id")):
        medication_logs = list(db.medication_logs.find({"_id": log_id}))

    return {
        "activities": activities,
        "blood_sugar": blood_sugar,
        "medication_logs": medication_logs,
    }


# ─── Reporting ────────────────────────────────────────────────────────────────

def _fmt_time(value: Any) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    return str(value)[:16] if value else "-"


def _describe(meal: Dict[str, Any]) -> str:
    nutrition = meal.get("nutrition") or {}
    carbs = nutrition.get("carbs")
    insulin = meal.get("intendedInsulin")
    bits = [f"{meal.get('mealType', '?'):<16}"]
    bits.append(f"carbs {carbs:>5.1f}g" if isinstance(carbs, (int, float)) else " " * 12)
    bits.append(f"insulin {insulin:>4.1f}U" if isinstance(insulin, (int, float)) else " " * 13)
    return "  ".join(bits)


def report(db, findings: Dict[str, Any], *, cascade: bool = True, verbose: bool = True) -> Dict[str, int]:
    """Print what was found and what a subsequent --apply would remove."""
    orphans = findings["orphaned_meals"]
    totals = findings["totals"]

    print()
    print("=" * 78)
    print("ORPHANED MEAL SWEEP")
    print("=" * 78)
    print(f"  meals scanned          {totals['meals']:>7}")
    print(f"  projections scanned    {totals['projections']:>7}")
    print()

    counts = Counter()
    counts["meals"] = len(orphans)

    print("-" * 78)
    print("A. WILL BE DELETED - meals whose projection was removed by the old handler")
    print("-" * 78)

    if not orphans:
        print("  none found.")
    else:
        for meal in orphans:
            print(f"  meal {meal['_id']}  {_fmt_time(meal.get('timestamp'))}  {_describe(meal)}")
            if not cascade:
                continue
            linked = cascade_targets(db, meal)
            for activity in linked["activities"]:
                counts["activities"] += 1
                print(f"       + activity        {activity['_id']}  "
                      f"{activity.get('intensity', activity.get('level', '?'))}")
            for reading in linked["blood_sugar"]:
                counts["blood_sugar"] += 1
                print(f"       + blood sugar     {reading['_id']}  {reading.get('bloodSugar')} mg/dL")
            for log in linked["medication_logs"]:
                counts["medication_logs"] += 1
                print(f"       + medication log  {log['_id']}  "
                      f"{log.get('dose')}U {log.get('medication')}   <- this is what inflates IOB")
        print()
        print(f"  totals:  {counts['meals']} meals, {counts['activities']} activities, "
              f"{counts['blood_sugar']} readings, {counts['medication_logs']} medication logs")

    if verbose:
        print()
        print("-" * 78)
        print("B. REPORT ONLY - projections whose meal is already gone")
        print("-" * 78)
        stray = findings["orphaned_projections"]
        print(f"  {len(stray)} found." if stray else "  none found.")
        for projection in stray[:20]:
            print(f"  meals_only {projection['_id']}  {_fmt_time(projection.get('timestamp'))}  "
                  f"-> missing meal {projection.get('meal_id')}")
        if len(stray) > 20:
            print(f"  ... and {len(stray) - 20} more")

        print()
        print("-" * 78)
        print("C. REPORT ONLY - meals that qualified for a projection but never recorded one")
        print("-" * 78)
        print("     (most likely records predating meals_only_id, or bulk imports -")
        print("      not safely distinguishable from legitimate data, so never deleted)")
        unlinked = findings["unlinked_meals"]
        print(f"  {len(unlinked)} found." if unlinked else "  none found.")
        for meal in unlinked[:20]:
            print(f"  meal {meal['_id']}  {_fmt_time(meal.get('timestamp'))}  {_describe(meal)}")
        if len(unlinked) > 20:
            print(f"  ... and {len(unlinked) - 20} more")

    print()
    return dict(counts)


# ─── Export and delete ────────────────────────────────────────────────────────

def build_backup(db, findings: Dict[str, Any], *, cascade: bool = True) -> Dict[str, Any]:
    """Every document that would be deleted, serialized for restore."""
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "category": "A - meals orphaned by the pre-2026-09-05 delete handler",
        "meals": [], "activities": [], "blood_sugar": [], "medication_logs": [],
    }
    for meal in findings["orphaned_meals"]:
        payload["meals"].append(meal)
        if cascade:
            for key, docs in cascade_targets(db, meal).items():
                payload[key].extend(docs)
    return payload


def apply_deletions(db, findings: Dict[str, Any], *, cascade: bool = True) -> Dict[str, int]:
    """Delete category A and, when asked, everything linked to it."""
    removed = Counter()

    for meal in findings["orphaned_meals"]:
        if cascade:
            linked = cascade_targets(db, meal)
            if ids := [a["_id"] for a in linked["activities"]]:
                removed["activities"] += db.activities.delete_many({"_id": {"$in": ids}}).deleted_count
            for reading in linked["blood_sugar"]:
                removed["blood_sugar"] += db.blood_sugar.delete_one({"_id": reading["_id"]}).deleted_count
            for log in linked["medication_logs"]:
                removed["medication_logs"] += db.medication_logs.delete_one({"_id": log["_id"]}).deleted_count

        removed["meals"] += db.meals.delete_one({"_id": meal["_id"]}).deleted_count

    return dict(removed)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def _json_default(value: Any) -> str:
    if isinstance(value, (ObjectId, datetime)):
        return str(value)
    return repr(value)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Find and optionally remove meals orphaned by the old delete handler.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Dry run by default. --apply requires --export.",
    )
    parser.add_argument("--patient", help="limit to one user_id")
    parser.add_argument("--export", metavar="FILE", help="write a JSON backup of what would be deleted")
    parser.add_argument("--apply", action="store_true", help="actually delete (requires --export)")
    parser.add_argument("--no-cascade", action="store_true",
                        help="delete only the meal, leaving its activity, reading and medication log")
    parser.add_argument("--quiet", action="store_true", help="skip the report-only sections")
    args = parser.parse_args(argv)

    if args.apply and not args.export:
        parser.error("--apply requires --export: never delete without a backup")

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if not os.environ.get("MONGO_URI"):
        print("MONGO_URI is not set.", file=sys.stderr)
        return 2

    from pymongo import MongoClient
    uri = os.environ["MONGO_URI"]
    client = MongoClient(uri)
    db = client.get_default_database()
    if db is None:
        print("MONGO_URI has no database name in its path.", file=sys.stderr)
        return 2

    print(f"database: {db.name}" + (f"   patient: {args.patient}" if args.patient else ""))

    cascade = not args.no_cascade
    findings = classify(db, patient_id=args.patient)
    counts = report(db, findings, cascade=cascade, verbose=not args.quiet)

    if args.export:
        payload = build_backup(db, findings, cascade=cascade)
        with open(args.export, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, default=_json_default)
        print(f"backup written to {args.export} "
              f"({sum(len(payload[k]) for k in ('meals', 'activities', 'blood_sugar', 'medication_logs'))} documents)")

    if not args.apply:
        print()
        print("DRY RUN - nothing was deleted.")
        print("To delete category A:  python sweep_orphaned_meals.py --export backup.json --apply")
        return 0

    if not findings["orphaned_meals"]:
        print("nothing to delete.")
        return 0

    removed = apply_deletions(db, findings, cascade=cascade)
    print()
    print("DELETED: " + ", ".join(f"{v} {k}" for k, v in sorted(removed.items())) or "nothing")
    print(f"restore from {args.export} if this was not what you wanted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
