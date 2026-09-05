"""
activity_pharmacodynamics_routes.py — HR ODE Exercise Model API
==============================================================================
Standalone Flask Blueprint exposing the Dalla Man / Breton pharmacodynamic
exercise model.  Does NOT duplicate or replace activity.py — that file handles
recording activity events.  This Blueprint handles *reading* the computed PD
effects of recorded activities.

Endpoints
─────────
  GET  /api/activity/pharmacodynamics       — stacked effect for the current window
  GET  /api/activity/pharmacodynamics/aob   — Activity On Board per session
  POST /api/activity/pharmacodynamics/preview  — simulate effect without persisting

References:
  Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
  Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
  Breton MD                       — J Diabetes Sci Technol 2008;2(1):169-174

Author:  DiaTwin Team
Version: 1.0 (initial standalone Blueprint)
==============================================================================
"""

import logging
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request
from bson.objectid import ObjectId

from config import mongo
from constants import Constants
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.activity_pharmacodynamics import (
    normalize_activity_record,
    calculate_stacked_activity_effect,
    get_activity_on_board,
    apply_activity_sensitivity,
)

logger = logging.getLogger(__name__)

activity_pd_bp = Blueprint("activity_pharmacodynamics", __name__)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _resolve_target_time(request_args: dict) -> datetime:
    """
    Parse ?target_time=ISO8601 from query params.
    Falls back to UTC now when absent or unparseable.
    """
    raw = request_args.get("target_time")
    if raw:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return dt.replace(tzinfo=None)
        except ValueError:
            pass
    return datetime.utcnow()


def _resolve_reset_time(patient_constants: dict, target_time: datetime) -> datetime:
    """
    Calculate today's reset time from daily_reset_hour + timezone_offset_minutes.
    Mirrors the logic in cumulative_effects_routes.py.
    """
    reset_hour      = patient_constants.get("daily_reset_hour", 7)
    tz_offset_min   = patient_constants.get("timezone_offset_minutes", 0)
    local_now       = target_time + timedelta(minutes=tz_offset_min)
    reset_local     = local_now.replace(hour=reset_hour, minute=0, second=0, microsecond=0)
    if local_now < reset_local:
        reset_local -= timedelta(days=1)
    return reset_local - timedelta(minutes=tz_offset_min)


def _fetch_activities(user_id: str, reset_time: datetime, target_time: datetime) -> list:
    """
    Query completed activity records within the [reset_time, target_time] window,
    normalize them, and return only exercise sessions (sedentary records filtered out).
    """
    raw_records = list(mongo.db.activities.find({
        "user_id": user_id,
        "type":    "completed",
        "$or": [
            {"startTime":     {"$gte": reset_time, "$lte": target_time}},
            {"completedTime": {"$gte": reset_time, "$lte": target_time}},
            {"timestamp":     {"$gte": reset_time, "$lte": target_time}},
        ],
    }).sort("startTime", -1))

    activities = []
    for raw in raw_records:
        norm = normalize_activity_record(raw)
        if norm is not None:
            activities.append(norm)

    logger.debug(
        f"[activity_pd] user={user_id} — {len(raw_records)} raw → "
        f"{len(activities)} exercise sessions"
    )
    return activities


# ─── Routes ──────────────────────────────────────────────────────────────────

@activity_pd_bp.route("/api/activity/pharmacodynamics", methods=["GET"])
@token_required
@api_error_handler
def get_activity_pharmacodynamics(current_user):
    """
    Stacked pharmacodynamic effect of all exercise sessions in today's window.

    Query params:
        target_time  (ISO-8601, optional) — calculation reference time; defaults to now

    Response fields:
        cumulative_activity_effect   (float, signed mg/dL — negative = BG-lowering)
        sensitivity_multiplier       (float ≥ 1.0 — post-exercise ISF/CR boost)
        activity_on_board            (float, unsigned — remaining drop still to come)
        activity_contributions       (list  — per-session breakdown)
        active_sessions              (int)
        effective_correction_factor  (float — ISF after sensitivity adjustment)
        effective_carb_to_bg_ratio   (float — CR after sensitivity adjustment)
        window_start                 (ISO-8601)
        window_end                   (ISO-8601)
        calculated_at                (ISO-8601)
    """
    user_id        = str(current_user["_id"])
    target_time    = _resolve_target_time(request.args)
    user_constants = Constants(user_id)
    pc             = user_constants.get_patient_constants()

    reset_time = _resolve_reset_time(pc, target_time)
    activities = _fetch_activities(user_id, reset_time, target_time)

    stacked = calculate_stacked_activity_effect(
        activities=activities,
        current_time=target_time,
        patient_constants=pc,
    )

    # Compute sensitivity-adjusted constants for the frontend to display
    effective = apply_activity_sensitivity(pc, activities, target_time)

    return jsonify({
        **stacked,
        "effective_correction_factor": round(effective.get("correction_factor", 0), 2),
        "effective_carb_to_bg_ratio":  round(
            effective.get("carb_to_bg_ratio") or effective.get("carb_to_bg_factor", 4.0), 2
        ),
        "window_start":  reset_time.isoformat(),
        "window_end":    target_time.isoformat(),
        "calculated_at": datetime.utcnow().isoformat(),
    }), 200


@activity_pd_bp.route("/api/activity/pharmacodynamics/aob", methods=["GET"])
@token_required
@api_error_handler
def get_activity_on_board_summary(current_user):
    """
    Per-session Activity On Board (AOB) breakdown.

    Analogous to IOB — shows how much BG-lowering effect is still outstanding
    for each exercise session in today's window, useful for hypoglycaemia prediction.

    Query params:
        target_time  (ISO-8601, optional)

    Response:
        sessions  — list of AOB dicts per session
        total_aob — summed remaining drop (unsigned mg/dL)
    """
    user_id        = str(current_user["_id"])
    target_time    = _resolve_target_time(request.args)
    user_constants = Constants(user_id)
    pc             = user_constants.get_patient_constants()

    reset_time = _resolve_reset_time(pc, target_time)
    activities = _fetch_activities(user_id, reset_time, target_time)

    sessions   = []
    total_aob  = 0.0

    for activity in activities:
        aob = get_activity_on_board(activity, target_time, pc)
        sessions.append({
            "activity_id":      activity.get("_id", ""),
            "intensity":        activity.get("intensity"),
            "duration_minutes": activity.get("duration_minutes"),
            **aob,
        })
        total_aob += aob["remaining_bg_drop"]

    return jsonify({
        "sessions":   sessions,
        "total_aob":  round(total_aob, 1),
        "calculated_at": datetime.utcnow().isoformat(),
    }), 200


@activity_pd_bp.route("/api/activity/pharmacodynamics/preview", methods=["POST"])
@token_required
@api_error_handler
def preview_activity_effect(current_user):
    """
    Simulate the pharmacodynamic effect of a planned or hypothetical activity
    WITHOUT persisting anything to the database.

    Useful for the frontend to show the user a preview of how an activity
    would affect their BG before they log it.

    Request body (JSON):
        intensity        (str)   — 'light' | 'moderate' | 'vigorous'  [required]
        duration_minutes (float) — session length in minutes            [required]
        start_time       (str)   — ISO-8601 start; defaults to now
        hr_trace         (list)  — [{t_min, hr_bpm}, ...]  [optional]
        hr_base          (float) — resting HR override     [optional]
        hr_max           (float) — max HR override         [optional]

    Response:
        cumulative_activity_effect   (float, signed mg/dL)
        sensitivity_multiplier       (float)
        activity_on_board            (float)
        activity_contributions       (list)
    """
    body = request.get_json(silent=True) or {}

    intensity        = body.get("intensity", "moderate")
    duration_minutes = float(body.get("duration_minutes", 30))
    start_raw        = body.get("start_time")

    if start_raw:
        try:
            start_time = datetime.fromisoformat(start_raw.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            start_time = datetime.utcnow()
    else:
        start_time = datetime.utcnow()

    # Build a synthetic normalized activity for simulation only
    synthetic_activity = {
        "_id":              "preview",
        "timestamp":        start_time,
        "duration_minutes": duration_minutes,
        "intensity":        intensity,
        "bg_direction":     -1,
    }
    for key in ("hr_trace", "hr_base", "hr_max"):
        if key in body:
            synthetic_activity[key] = body[key]

    user_id        = str(current_user["_id"])
    user_constants = Constants(user_id)
    pc             = user_constants.get_patient_constants()
    target_time    = datetime.utcnow()

    result = calculate_stacked_activity_effect(
        activities=[synthetic_activity],
        current_time=target_time,
        patient_constants=pc,
    )

    return jsonify({
        **result,
        "simulated": True,
        "calculated_at": target_time.isoformat(),
    }), 200
