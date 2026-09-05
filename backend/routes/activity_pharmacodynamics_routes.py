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

Caching (fix 11.5)
──────────────────
  GET /api/activity/pharmacodynamics runs a full ODE simulation across all of
  today's sessions on every call.  calculateActiveEffects() in the frontend
  calls this on every 60-second poll cycle, plus on every view-mode change and
  retroactive-data event — meaning a busy dashboard can fire 5-10 ODE runs per
  minute with identical inputs.

  A lightweight per-user in-memory TTL cache (60 s, thread-safe) is added to
  the stacked endpoint only.  The AOB and preview endpoints are excluded:
    • /aob   — less frequently called, already fast (no sensitivity calculation)
    • /preview — always synthetic input, should never be cached

  Cache key:  "{user_id}|{reset_date_iso}"
    Including the reset date means the cache auto-invalidates across the daily
    reset boundary with zero explicit logic.

  Explicit target_time requests (historical/debug queries) bypass the cache
  entirely so they always reflect the exact requested moment.

  Explicit invalidation:
    • Call invalidate_pd_cache(user_id) from watch_hr_routes when a session
      ends, so the new session appears on the very next poll.
    • Pass ?force_refresh=1 from the frontend after ending a session.

References:
  Dalla Man C, Breton M, Cobelli C — J Diabetes Sci Technol 2009;3(1):56-67
  Romeres D, Dalla Man C et al.   — Am J Physiol Endocrinol Metab 2021;321:E122
  Breton MD                       — J Diabetes Sci Technol 2008;2(1):169-174

Author:  DiaTwin Team
Version: 1.1 (11.5: per-user TTL cache on stacked endpoint)
==============================================================================
"""

import logging
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from flask import Blueprint, jsonify, request
from bson.objectid import ObjectId

from config import mongo
from constants import Constants
from utils.auth import token_required
from utils.error_handler import api_error_handler
# B-8 fix: import get_daily_reset_time so _resolve_reset_time local copy can be removed.
# The local copy carried a comment saying it "must remain identical" to pharmacodynamics.py —
# importing directly eliminates that maintenance liability.
from utils.pharmacodynamics import get_daily_reset_time
from utils.activity_pharmacodynamics import (
    normalize_activity_record,
    calculate_stacked_activity_effect,
    get_activity_on_board,
    apply_activity_sensitivity,
)

logger = logging.getLogger(__name__)

activity_pd_bp = Blueprint("activity_pharmacodynamics", __name__)


# ─── Per-user TTL cache (fix 11.5) ───────────────────────────────────────────
#
# Simple dict-based cache — no external dependency required.
# Thread-safe via a single RLock (re-entrant so helpers can call each other).
#
# Scope: in-process only.  On Render (single Gunicorn worker) this covers 100%
# of requests.  Multi-worker deployments each maintain their own cache; the
# worst case is one extra ODE run per worker per TTL window, which is fine.
# If true cross-process caching is required, swap the dict for Flask-Caching
# with a Redis backend — the public API (get/set/invalidate) stays identical.

_PD_CACHE_TTL_SECONDS = 60   # matches the frontend poll interval

_cache_lock: threading.RLock = threading.RLock()
_pd_cache: dict[str, dict[str, Any]] = {}   # {cache_key: {payload, expires_at}}


def _make_cache_key(user_id: str, reset_time: datetime) -> str:
    """
    Build a cache key that auto-invalidates when the daily reset rolls over.
    reset_time is naive UTC; .date() gives the UTC calendar date of the reset.
    """
    return f"{user_id}|{reset_time.date().isoformat()}"


def _cache_get(key: str) -> Optional[dict]:
    """Return cached payload if still within TTL, else None."""
    with _cache_lock:
        entry = _pd_cache.get(key)
        if entry and datetime.utcnow() < entry["expires_at"]:
            return entry["payload"]
        # Expired entry — evict lazily
        _pd_cache.pop(key, None)
        return None


def _cache_set(key: str, payload: dict) -> None:
    """Store payload under key with a fresh TTL."""
    with _cache_lock:
        _pd_cache[key] = {
            "payload":    payload,
            "expires_at": datetime.utcnow() + timedelta(seconds=_PD_CACHE_TTL_SECONDS),
        }


def invalidate_pd_cache(user_id: str) -> None:
    """
    Explicitly evict ALL cache entries for a user.

    Call this from watch_hr_routes.end_watch_activity() after a session is
    finalised so the very next poll sees the new session immediately, without
    waiting up to 60 s for the TTL to expire.

    Safe to call even if no entry exists — no-op in that case.
    """
    with _cache_lock:
        stale_keys = [k for k in _pd_cache if k.startswith(f"{user_id}|")]
        for k in stale_keys:
            del _pd_cache[k]
    if stale_keys:
        logger.debug(
            "[activity_pd_cache] invalidated %d entr%s for user=%s",
            len(stale_keys),
            "y" if len(stale_keys) == 1 else "ies",
            user_id,
        )


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

    B-8 fix: previously duplicated the arithmetic from pharmacodynamics.py with
    a comment requiring both copies to stay in sync. Now delegates directly to
    get_daily_reset_time() — a single source of truth that handles DST edge
    cases, UTC sign convention, and TimeManager precision internally.
    """
    reset_hour    = patient_constants.get("daily_reset_hour", 7)
    tz_offset_min = patient_constants.get("timezone_offset_minutes", 0)
    return get_daily_reset_time(target_time, reset_hour, tz_offset_min)


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
        "[activity_pd] user=%s — %d raw → %d exercise sessions",
        user_id, len(raw_records), len(activities),
    )
    return activities


def _build_stacked_response(
    user_id: str,
    target_time: datetime,
    pc: dict,
) -> dict:
    """
    Run the full ODE pipeline and return the response payload dict.
    Separated from the route handler so the cache can store/return this dict
    without touching Flask's request/response objects.
    """
    reset_time = _resolve_reset_time(pc, target_time)
    activities = _fetch_activities(user_id, reset_time, target_time)

    stacked   = calculate_stacked_activity_effect(
        activities=activities,
        current_time=target_time,
        patient_constants=pc,
    )
    effective = apply_activity_sensitivity(pc, activities, target_time)

    return {
        **stacked,
        "effective_correction_factor": round(effective.get("correction_factor", 40), 2),  # FIX N-4: was 0; 40 matches §11-B-1 standard default
        "effective_carb_to_bg_ratio":  round(
            effective.get("carb_to_bg_ratio") or effective.get("carb_to_bg_factor", 4.0), 2
        ),
        "window_start":  reset_time.isoformat(),
        "window_end":    target_time.isoformat(),
        "calculated_at": datetime.utcnow().isoformat(),
    }


# ─── Routes ──────────────────────────────────────────────────────────────────

@activity_pd_bp.route("/api/activity/pharmacodynamics", methods=["GET"])
@token_required
@api_error_handler
def get_activity_pharmacodynamics(current_user):
    """
    Stacked pharmacodynamic effect of all exercise sessions in today's window.

    Query params:
        target_time    (ISO-8601, optional) — calculation reference time; defaults to now.
                        When supplied the cache is bypassed (historical / debug query).
        force_refresh  (0|1, optional)      — set to 1 to bypass and repopulate the cache.
                        Use after ending a session if you need the new session to appear
                        immediately without waiting for the backend invalidation signal.

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
        cached                       (bool  — True when result served from cache)
    """
    user_id        = str(current_user["_id"])
    user_constants = Constants(user_id)
    pc             = user_constants.get_patient_constants()

    # ── Cache bypass conditions ────────────────────────────────────────────
    #   1. Caller supplied an explicit target_time  →  historical/debug query
    #   2. Caller passed ?force_refresh=1           →  post-session invalidation
    explicit_target  = bool(request.args.get("target_time"))
    force_refresh    = request.args.get("force_refresh", "0") == "1"
    use_cache        = not explicit_target and not force_refresh

    target_time = _resolve_target_time(request.args)
    reset_time  = _resolve_reset_time(pc, target_time)
    cache_key   = _make_cache_key(user_id, reset_time)

    # ── Serve from cache if available ─────────────────────────────────────
    if use_cache:
        cached_payload = _cache_get(cache_key)
        if cached_payload is not None:
            logger.debug(
                "[activity_pd] cache HIT — user=%s key=%s", user_id, cache_key
            )
            return jsonify({**cached_payload, "cached": True}), 200

    # ── Cache miss (or bypassed): run the ODE ─────────────────────────────
    logger.debug(
        "[activity_pd] cache MISS — user=%s use_cache=%s force=%s",
        user_id, use_cache, force_refresh,
    )
    payload = _build_stacked_response(user_id, target_time, pc)

    if use_cache:
        _cache_set(cache_key, payload)

    return jsonify({**payload, "cached": False}), 200


@activity_pd_bp.route("/api/activity/pharmacodynamics/aob", methods=["GET"])
@token_required
@api_error_handler
def get_activity_on_board_summary(current_user):
    """
    Per-session Activity On Board (AOB) breakdown.

    Analogous to IOB — shows how much BG-lowering effect is still outstanding
    for each exercise session in today's window, useful for hypoglycaemia prediction.

    Not cached: called less frequently than the main stacked endpoint, and the
    AOB values change every minute — a 60 s cache would make the progress bar
    appear to freeze.

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
            "duration_minutes": activity.get("duration_minutes"),
            # FIX N-8: removed redundant explicit 'intensity' key — **aob spread
            # already carries intensity and bg_direction from get_activity_on_board().
            # The explicit key was dead code: **aob silently overwrote it with the
            # identical value, masking that bg_direction also arrives via the spread.
            **aob,   # carries: remaining_bg_drop, absorbed_fraction, minutes_elapsed,
                     #           is_active, intensity, bg_direction
        })
        total_aob += aob["remaining_bg_drop"]

    return jsonify({
        "sessions":      sessions,
        "total_aob":     round(total_aob, 1),
        "calculated_at": datetime.utcnow().isoformat(),
    }), 200


@activity_pd_bp.route("/api/activity/pharmacodynamics/preview", methods=["POST"])
@token_required
@api_error_handler
def preview_activity_effect(current_user):
    """
    Simulate the pharmacodynamic effect of a planned or hypothetical activity
    WITHOUT persisting anything to the database.

    Not cached: every call has different synthetic inputs supplied by the caller.

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
        simulated                    (bool — always True)
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
        "simulated":     True,
        "calculated_at": target_time.isoformat(),
    }), 200