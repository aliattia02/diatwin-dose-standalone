"""
watch_hr_routes.py — Digital Watch / Wearable HR Integration
==============================================================================
Single Blueprint that handles the full lifecycle of a watch-driven activity
session and HR streaming, plus all-day continuous HR upload with auto-
segmentation.  No new DB collection is needed — writes into the SAME
activities collection that activity.py uses.

Dual hr_trace storage
─────────────────────
  hr_trace_raw  [{t_sec, hr_bpm}]  — every raw sample at watch resolution
                                      Used by ActivityVisualization "HR Live" tab
  hr_trace      [{t_min, hr_bpm}]  — 1-minute bucket averages, computed from raw
                                      Used by existing ODE pharmacodynamics model

The completed doc is schema-identical to activity.py records (with two extra
additive fields). Zero changes required in activity_pharmacodynamics_routes.py.

Endpoints
─────────
  POST /api/watch/activity/start       — begin session
  POST /api/watch/hr/stream            — stream HR samples (any resolution)
  POST /api/watch/activity/end         — finalise session
  GET  /api/watch/activity/status      — check active session (crash recovery)
  GET  /api/watch/hr/raw/<session_id>  — per-second trace for visualization
  POST /api/watch/hr/continuous        — all-day HR upload with auto-segmentation

Register in main.py:
    from routes.watch_hr_routes import watch_hr_bp
    app.register_blueprint(watch_hr_bp)

SWIM-LANE ZONES (continuous endpoint)
──────────────────────────────────────
  HR < hr_sedentary_max                   → SEDENTARY  (no session created)
  hr_sedentary_max ≤ HR < hr_moderate_low → LIGHT      (walking / low activity)
  hr_moderate_low ≤ HR ≤ hr_moderate_high → MODERATE
  HR > hr_moderate_high                   → VIGOROUS

HOUR-BOUNDARY SPLITTING (continuous endpoint)
──────────────────────────────────────────────
  Sessions are capped at max_session_minutes (default 15 min) and split at
  15-min boundaries (:00, :15, :30, :45 of each hour).  E.g. activity
  07:42 → 08:30 becomes:
      07:42 → 07:45  (3 min)
      07:45 → 08:00  (15 min)
      08:00 → 08:15  (15 min)
      08:15 → 08:30  (15 min)

Version: 2.1
==============================================================================

Changelog
─────────
v2.1 (audit fixes):
  ✅ FIX M-4: end_watch_activity now writes the correct `level` integer
     (0=light, 1=moderate, 2=vigorous) derived from final_intensity, instead of
     hard-coding 1 regardless of intensity. ActivityCard in the frontend reads
     `activity.level` to look up the display label; the hard-coded 1 caused all
     watch sessions to always render as "Moderate" regardless of actual effort.
     Matches the mapping already used correctly in session_to_activity_doc().
  ✅ CLARIFICATION (H-2 context): The explicit hr_base/hr_max body overrides in
     upload_continuous_hr() are patient-level resting/max HR values supplied by
     the caller — NOT session statistics. Writing them as hr_base/hr_max is
     intentional and correct: they ARE valid ODE inputs representing true patient
     resting HR (unlike the session min(hr_values) that watch_hr_autosegment.py
     previously stored under the same keys, which is the H-2 bug fixed there).
==============================================================================
"""

import logging
from datetime import datetime
from collections import defaultdict

from flask import Blueprint, jsonify, request
from bson.objectid import ObjectId

from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.watch_hr_autosegment import segment_hr_stream, session_to_activity_doc

logger = logging.getLogger(__name__)

watch_hr_bp = Blueprint("watch_hr", __name__)

# ─── Constants ────────────────────────────────────────────────────────────────

VALID_INTENSITIES = {"light", "moderate", "vigorous"}
_DEFAULT_INTENSITY = "moderate"
_INTENSITY_THRESHOLDS = {
    "light":    (0.0,  0.50),
    "moderate": (0.50, 0.70),
    "vigorous": (0.70, 1.0),
}
_HR_BASE_POP = 70.0
_HR_MAX_POP  = 185.0

# ── Raw sample cap (fix 11.3) ─────────────────────────────────────────────────
# Max session duration is now 15 min. At 1 Hz that is 900 samples; we allow
# 2× headroom for burst sends and watch-SDK timing jitter before rejecting.
# Beyond 1 800 samples the mongo document grows without clinical benefit —
# the ODE only consumes per-minute averages (hr_trace), not the raw trace.
_MAX_RAW_SAMPLES_PER_SESSION: int = 1_800


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _classify_intensity(mean_fraction: float) -> str:
    for label, (lo, hi) in _INTENSITY_THRESHOLDS.items():
        if lo <= mean_fraction < hi:
            return label
    return "vigorous"


def _fmt_iso(dt: datetime) -> str:
    return dt.isoformat() if dt else None


def _downsample_to_minutes(raw_samples: list) -> list:
    """
    Convert [{t_sec, hr_bpm}] → [{t_min, hr_bpm}] (1-min bucket averages).
    t_min is set to the midpoint of each minute bucket (e.g. 0.5, 1.5, ...).
    This is the format the existing ODE model expects.
    """
    buckets: dict[int, list] = defaultdict(list)
    for s in raw_samples:
        t_sec = s.get("t_sec")
        hr    = s.get("hr_bpm")
        if t_sec is None or hr is None:
            continue
        buckets[int(t_sec) // 60].append(float(hr))

    return [
        {"t_min": round(minute + 0.5, 2), "hr_bpm": round(sum(hrs) / len(hrs), 1)}
        for minute, hrs in sorted(buckets.items())
    ]


def _get_in_progress(user_id: str, session_id: str | None = None):
    query = {"user_id": user_id, "type": "in_progress"}
    if session_id:
        try:
            query["_id"] = ObjectId(session_id)
        except Exception:
            return None
    return mongo.db.activities.find_one(query, sort=[("startTime", -1)])


# ─── 1. Start session ─────────────────────────────────────────────────────────

@watch_hr_bp.route("/api/watch/activity/start", methods=["POST"])
@token_required
@api_error_handler
def start_watch_activity(current_user):
    """
    Begin a new watch-driven activity session.

    Request body (JSON):
        intensity   (str, optional)   — 'light'|'moderate'|'vigorous'; inferred at /end if omitted
        hr_base     (float, optional) — resting HR override (bpm)
        hr_max      (float, optional) — max HR override (bpm)
        start_time  (str, optional)   — ISO-8601; defaults to server UTC now
        notes       (str, optional)

    Response:
        session_id  (str)  — use in subsequent /stream and /end calls
        started_at  (str)  — ISO-8601
        message     (str)
    """
    body    = request.get_json(silent=True) or {}
    user_id = str(current_user["_id"])

    # ── Guard: reject or abandon any already-open session ─────────────────
    existing = _get_in_progress(user_id)
    if existing:
        existing_id = str(existing["_id"])
        logger.warning(
            f"[watch_hr] user={user_id} attempted to start a new session "
            f"while session {existing_id} is still in_progress — "
            f"auto-abandoning the stale session."
        )
        mongo.db.activities.update_one(
            {"_id": existing["_id"]},
            {"$set": {"type": "abandoned", "abandonedAt": datetime.utcnow()}},
        )
    # ──────────────────────────────────────────────────────────────────────

    raw_start = body.get("start_time")
    if raw_start:
        try:
            start_time = datetime.fromisoformat(
                raw_start.replace("Z", "+00:00")
            ).replace(tzinfo=None)
        except ValueError:
            start_time = datetime.utcnow()
    else:
        start_time = datetime.utcnow()

    intensity = body.get("intensity")
    if intensity not in VALID_INTENSITIES:
        intensity = None

    doc = {
        "user_id":      user_id,
        "timestamp":    start_time,
        "startTime":    start_time,
        "type":         "in_progress",
        "hr_trace_raw": [],   # per-second raw — new field
        "hr_trace":     [],   # per-minute averages — ODE model reads this
        "bg_direction": -1,
        "source":       "watch",
    }
    if intensity:            doc["intensity"] = intensity
    if body.get("hr_base"):  doc["hr_base"]   = float(body["hr_base"])
    if body.get("hr_max"):   doc["hr_max"]    = float(body["hr_max"])
    if body.get("notes"):    doc["notes"]     = body["notes"]

    result     = mongo.db.activities.insert_one(doc)
    session_id = str(result.inserted_id)
    logger.info(f"[watch_hr] user={user_id} session started → {session_id}")

    return jsonify({
        "session_id": session_id,
        "started_at": _fmt_iso(start_time),
        "message":    "Watch activity session started",
    }), 201


# ─── 2. Stream HR samples ─────────────────────────────────────────────────────

@watch_hr_bp.route("/api/watch/hr/stream", methods=["POST"])
@token_required
@api_error_handler
def stream_hr(current_user):
    """
    Append one or more HR samples to an in-progress session.

    Accepts any timing resolution — per-second (t_sec), per-minute (t_min), or
    wall-clock ISO timestamp (timestamp_iso).  All are stored in hr_trace_raw as
    {t_sec, hr_bpm}.  hr_trace (per-minute averages) is recomputed after each
    batch so the ODE model always has a consistent minute-level trace.

    Request body (JSON):
        session_id  (str, required)
        samples     (list, required)  — [{t_sec?, t_min?, timestamp_iso?, hr_bpm}]

    Response:
        session_id     (str)
        samples_added  (int)
        total_raw      (int)  — total per-second samples in this session
        total_minutes  (int)  — distinct 1-min buckets in hr_trace
    """
    body        = request.get_json(silent=True) or {}
    user_id     = str(current_user["_id"])
    session_id  = body.get("session_id")
    raw_samples = body.get("samples", [])

    if not session_id:
        return jsonify({"error": "session_id is required"}), 400
    if not raw_samples:
        return jsonify({"error": "samples list is required and must not be empty"}), 400

    session = _get_in_progress(user_id, session_id)
    if not session:
        return jsonify({"error": "No active in-progress session found for this session_id"}), 404

    start_time = session.get("startTime") or session.get("timestamp")

    # ── Normalise all samples → t_sec ─────────────────────────────────────────
    normalised = []
    for s in raw_samples:
        hr = s.get("hr_bpm")
        if hr is None:
            continue
        hr = float(hr)
        if hr < 20 or hr > 300:
            continue

        if "t_sec" in s:
            t_sec = float(s["t_sec"])
        elif "t_min" in s:
            t_sec = float(s["t_min"]) * 60.0
        elif "timestamp_iso" in s and start_time:
            try:
                sample_dt = datetime.fromisoformat(
                    s["timestamp_iso"].replace("Z", "+00:00")
                ).replace(tzinfo=None)
                t_sec = max(0.0, (sample_dt - start_time).total_seconds())
            except Exception:
                continue
        else:
            continue

        if t_sec < 0 or t_sec > 86_400:
            continue

        normalised.append({"t_sec": round(t_sec, 1), "hr_bpm": round(hr, 1)})

    if not normalised:
        return jsonify({"error": "No valid samples could be parsed"}), 400

    # ── Raw sample cap (fix 11.3) ──────────────────────────────────────────────
    # Read the current count in one lightweight projection (no full doc fetch).
    # $size on an array field is O(1) in MongoDB 4.4+ via the document's stored
    # length; for older versions this is still a single-field projection.
    cap_check = mongo.db.activities.find_one(
        {"_id": session["_id"]},
        {"_raw_count": {"$size": "$hr_trace_raw"}}  # synthetic field — count only
    )
    # find_one returns None if missing; fall back to 0 safely
    current_raw_count = (cap_check or {}).get("_raw_count", 0)

    if current_raw_count >= _MAX_RAW_SAMPLES_PER_SESSION:
        logger.warning(
            "[watch_hr] %s — raw sample cap %d reached (current=%d); batch rejected",
            session_id, _MAX_RAW_SAMPLES_PER_SESSION, current_raw_count,
        )
        return jsonify({
            "error": (
                f"Raw sample cap reached ({_MAX_RAW_SAMPLES_PER_SESSION} samples). "
                "Sessions are limited to 15 min; reduce your streaming frequency "
                "or call /end to close the session."
            ),
            "session_id": session_id,
            "total_raw":  current_raw_count,
        }), 429

    # Clamp batch so a single oversized push cannot exceed the cap.
    remaining_slots = _MAX_RAW_SAMPLES_PER_SESSION - current_raw_count
    if len(normalised) > remaining_slots:
        logger.warning(
            "[watch_hr] %s — batch of %d clamped to %d remaining slot(s)",
            session_id, len(normalised), remaining_slots,
        )
        normalised = normalised[:remaining_slots]

    # ── Append raw, recompute per-minute trace ─────────────────────────────────
    mongo.db.activities.update_one(
        {"_id": session["_id"]},
        {"$push": {"hr_trace_raw": {"$each": normalised}}}
    )

    updated  = mongo.db.activities.find_one({"_id": session["_id"]}, {"hr_trace_raw": 1})
    all_raw  = updated.get("hr_trace_raw", []) if updated else normalised
    hr_trace = _downsample_to_minutes(all_raw)

    mongo.db.activities.update_one(
        {"_id": session["_id"]},
        {"$set": {"hr_trace": hr_trace}}
    )

    logger.debug(
        f"[watch_hr] {session_id} +{len(normalised)} raw → "
        f"{len(all_raw)} total, {len(hr_trace)} min buckets"
    )

    return jsonify({
        "session_id":    session_id,
        "samples_added": len(normalised),
        "total_raw":     len(all_raw),
        "total_minutes": len(hr_trace),
    }), 200


# ─── 3. End session ───────────────────────────────────────────────────────────

@watch_hr_bp.route("/api/watch/activity/end", methods=["POST"])
@token_required
@api_error_handler
def end_watch_activity(current_user):
    """
    Finalise the in-progress session.

    Converts to type="completed".  The resulting doc contains:
      hr_trace_raw — full per-second array  → ActivityVisualization HR Live tab
      hr_trace     — per-minute averages    → ODE pharmacodynamics model (unchanged)

    Request body (JSON):
        session_id  (str, required)
        end_time    (str, optional)  — ISO-8601
        intensity   (str, optional)  — override auto-inferred label

    Response:
        session_id / duration_minutes / intensity / total_raw_samples /
        total_min_buckets / hr_base / hr_max / completed_at
    """
    body       = request.get_json(silent=True) or {}
    user_id    = str(current_user["_id"])
    session_id = body.get("session_id")

    if not session_id:
        return jsonify({"error": "session_id is required"}), 400

    session = _get_in_progress(user_id, session_id)
    if not session:
        return jsonify({"error": "No active in-progress session found for this session_id"}), 404

    start_time = session.get("startTime") or session.get("timestamp")

    raw_end = body.get("end_time")
    if raw_end:
        try:
            end_time = datetime.fromisoformat(
                raw_end.replace("Z", "+00:00")
            ).replace(tzinfo=None)
        except ValueError:
            end_time = datetime.utcnow()
    else:
        end_time = datetime.utcnow()

    duration_minutes = max(
        1.0,
        round((end_time - start_time).total_seconds() / 60.0, 1)
    ) if start_time else 30.0

    # ── HR analysis ───────────────────────────────────────────────────────────
    raw_trace = session.get("hr_trace_raw", [])
    hr_values = [s["hr_bpm"] for s in raw_trace if "hr_bpm" in s]

    hr_base_stored = session.get("hr_base", _HR_BASE_POP)
    hr_max_stored  = session.get("hr_max",  _HR_MAX_POP)

    if hr_values:
        hr_base = session.get("hr_base") or min(min(hr_values), hr_base_stored)
        hr_max  = session.get("hr_max")  or max(max(hr_values), hr_max_stored)
        mean_hr = sum(hr_values) / len(hr_values)
        hr_reserve    = max(hr_max - hr_base, 1.0)
        mean_fraction = (mean_hr - hr_base) / hr_reserve
        auto_intensity = _classify_intensity(mean_fraction)
    else:
        hr_base, hr_max = hr_base_stored, hr_max_stored
        auto_intensity  = _DEFAULT_INTENSITY

    final_intensity = body.get("intensity") or session.get("intensity") or auto_intensity
    if final_intensity not in VALID_INTENSITIES:
        final_intensity = auto_intensity

    hr_trace = _downsample_to_minutes(raw_trace) if raw_trace else session.get("hr_trace", [])

    hours        = int(duration_minutes // 60)
    minutes_part = int(duration_minutes % 60)

    mongo.db.activities.update_one(
        {"_id": session["_id"]},
        {"$set": {
            "type":             "completed",
            "completedTime":    end_time,
            "endTime":          end_time,
            "duration_minutes": duration_minutes,
            "duration":         f"{hours:02d}:{minutes_part:02d}",
            "intensity":        final_intensity,
            "hr_base":          round(hr_base, 1),
            "hr_max":           round(hr_max, 1),
            "hr_trace":         hr_trace,
            "bg_direction":     -1,
            # ✅ FIX M-4: map intensity → level integer so ActivityCard can look
            # up the correct display label (Light / Moderate / Vigorous).
            # Previously hard-coded as 1, meaning every watch session was labelled
            # "Moderate" regardless of actual effort.
            # Matches the mapping in session_to_activity_doc() in watch_hr_autosegment.py.
            "level":            {"light": 0, "moderate": 1, "vigorous": 2}.get(final_intensity, 1),
            "impact":           1.0,
        }}
    )

    logger.info(
        f"[watch_hr] {session_id} ended — {duration_minutes} min, "
        f"{final_intensity}, {len(raw_trace)} raw, {len(hr_trace)} min buckets"
    )

    # ── Invalidate PD cache (fix 11.5) ────────────────────────────────────────
    # The stacked PD endpoint caches results for 60 s per user.  Without this
    # call the newly completed session would be invisible to the dashboard for
    # up to 60 s.  Lazy import avoids a circular dependency at module load time.
    try:
        from routes.activity_pharmacodynamics_routes import invalidate_pd_cache
        invalidate_pd_cache(user_id)
        logger.debug("[watch_hr] PD cache invalidated for user=%s after session end", user_id)
    except Exception as exc:
        # Non-fatal — the cache will expire naturally within 60 s
        logger.warning("[watch_hr] Could not invalidate PD cache: %s", exc)
        return jsonify({
        "session_id":        session_id,
        "duration_minutes":  duration_minutes,
        "intensity":         final_intensity,
        "total_raw_samples": len(raw_trace),
        "total_min_buckets": len(hr_trace),
        "hr_base":           round(hr_base, 1),
        "hr_max":            round(hr_max, 1),
        "completed_at":      _fmt_iso(end_time),
        "message":           "Activity session completed and saved",
    }), 200


# ─── 4. Status check ──────────────────────────────────────────────────────────

@watch_hr_bp.route("/api/watch/activity/status", methods=["GET"])
@token_required
@api_error_handler
def get_watch_activity_status(current_user):
    """
    Return the current in-progress session if any — for crash/disconnect recovery.

    Response:
        active / session_id / started_at / total_raw / total_minutes / intensity
    """
    user_id = str(current_user["_id"])
    session = _get_in_progress(user_id)
    if not session:
        return jsonify({"active": False, "session_id": None, "total_raw": 0, "total_minutes": 0}), 200

    return jsonify({
        "active":        True,
        "session_id":    str(session["_id"]),
        "started_at":    _fmt_iso(session.get("startTime") or session.get("timestamp")),
        "total_raw":     len(session.get("hr_trace_raw", [])),
        "total_minutes": len(session.get("hr_trace", [])),
        "intensity":     session.get("intensity"),
    }), 200


# ─── 5. Per-second raw trace for visualization ────────────────────────────────

@watch_hr_bp.route("/api/watch/hr/raw/<session_id>", methods=["GET"])
@token_required
@api_error_handler
def get_raw_hr_trace(current_user, session_id):
    """
    Return the full per-second HR trace for a session (completed or in-progress).
    Called by ActivityVisualization's "HR Live" tab.

    Response:
        session_id / started_at / duration_minutes / intensity /
        hr_base / hr_max / hr_trace_raw / hr_trace / total_raw / source / type
    """
    user_id = str(current_user["_id"])
    try:
        oid = ObjectId(session_id)
    except Exception:
        return jsonify({"error": "Invalid session_id"}), 400

    doc = mongo.db.activities.find_one({"_id": oid, "user_id": user_id})
    if not doc:
        return jsonify({"error": "Session not found"}), 404

    start_time = doc.get("startTime") or doc.get("timestamp")

    return jsonify({
        "session_id":       str(doc["_id"]),
        "started_at":       _fmt_iso(start_time),
        "duration_minutes": doc.get("duration_minutes"),
        "intensity":        doc.get("intensity"),
        "hr_base":          doc.get("hr_base") or doc.get("session_hr_min", _HR_BASE_POP),
        "hr_max":           doc.get("hr_max")  or doc.get("session_hr_peak", _HR_MAX_POP),
        "hr_trace_raw":     doc.get("hr_trace_raw", []),
        "hr_trace":         doc.get("hr_trace",     []),
        "total_raw":        len(doc.get("hr_trace_raw", [])),
        "source":           doc.get("source", "watch"),
        "type":             doc.get("type"),
    }), 200


# ─── 6. Continuous / all-day HR upload with auto-segmentation ─────────────────

@watch_hr_bp.route("/api/watch/hr/continuous", methods=["POST"])
@token_required
@api_error_handler
def upload_continuous_hr(current_user):
    """
    Accept a continuous all-day HR stream and auto-segment into sessions.

    The swim-lane segmentation creates separate session records for each
    intensity block (light / moderate / vigorous), with debouncing to prevent
    noise from creating micro-sessions, and hour-boundary splitting to cap
    each session at 60 minutes.

    All created records are schema-identical to records from the existing
    start/stream/end flow — the ODE pharmacodynamics model picks them up
    automatically with no changes.

    Request body (JSON):
        samples    (list, required)
            Each sample must have hr_bpm plus ONE of:
              timestamp_iso  — ISO-8601 wall-clock (preferred for all-day data)
              t_sec          — seconds elapsed since base_time
              t_min          — minutes elapsed since base_time
        base_time  (str, optional)
            ISO-8601 reference time, required when samples use t_sec / t_min.
        hr_base    (float, optional) — resting HR override for all sessions
        hr_max     (float, optional) — max HR override for all sessions
        config     (dict, optional)  — override swim-lane defaults:
            {
              "hr_sedentary_max":    50,    default — HR below this = no session
              "hr_moderate_low":    100,    default — LIGHT / MODERATE boundary
              "hr_moderate_high":   140,    default — MODERATE / VIGOROUS boundary
              "debounce_start":       6,    default
              "debounce_end":         6,    default
              "debounce_transit":     6,    default
              "min_session_minutes":  2.0   default
              "max_session_minutes": 15.0   default — split at 15-min boundaries
            }

    Response:
        sessions_created  (int)
        sessions          (list) — summary of each created session
        samples_received  (int)
        by_intensity      (dict)
        message           (str)
    """
    body    = request.get_json(silent=True) or {}
    user_id = str(current_user["_id"])

    raw_samples = body.get("samples", [])
    if not raw_samples:
        return jsonify({"error": "samples list is required and must not be empty"}), 400

    # Optional base_time for t_sec / t_min samples
    base_time = None
    raw_base  = body.get("base_time")
    if raw_base:
        try:
            base_time = datetime.fromisoformat(
                raw_base.replace("Z", "+00:00")
            ).replace(tzinfo=None)
        except ValueError:
            pass

    # Optional swim-lane config overrides
    config_override = body.get("config") or {}

    # ── Run segmentation ──────────────────────────────────────────────────────
    sessions = segment_hr_stream(
        samples=raw_samples,
        base_time=base_time,
        config_override=config_override,
    )

    if not sessions:
        return jsonify({
            "sessions_created": 0,
            "sessions":         [],
            "samples_received": len(raw_samples),
            "samples_skipped":  len(raw_samples),
            "message":          "No activity sessions detected in the provided HR stream",
        }), 200

    # ── Persist each session ──────────────────────────────────────────────────
    created = []
    for sess in sessions:
        doc = session_to_activity_doc(sess, user_id, bg_direction=-1)

        # Per-session hr_base / hr_max: use body-level overrides if supplied,
        # otherwise the doc already has the ODE-ready values from session_to_activity_doc().
        #
        # NOTE (H-2 context): these body overrides are the *patient's true resting and
        # max HR* supplied explicitly by the caller — they are valid ODE inputs and
        # should remain as hr_base / hr_max.  This is distinct from the session
        # statistics (min/max of observed HR values) that watch_hr_autosegment.py
        # previously stored under these same keys — that is the H-2 bug fixed in
        # watch_hr_autosegment.py by renaming them to session_hr_min / session_hr_peak.
        if body.get("hr_base"):
            doc["hr_base"] = float(body["hr_base"])
        if body.get("hr_max"):
            doc["hr_max"] = float(body["hr_max"])

        result = mongo.db.activities.insert_one(doc)
        created.append({
            "session_id":       str(result.inserted_id),
            "intensity":        sess["intensity"],
            "start_time":       sess["start_time"].isoformat(),
            "end_time":         sess["end_time"].isoformat(),
            "duration_minutes": sess["duration_minutes"],
            "sample_count":     sess["sample_count"],
        })

    # Build intensity breakdown for the response summary
    by_intensity: dict[str, int] = {}
    for s in created:
        by_intensity[s["intensity"]] = by_intensity.get(s["intensity"], 0) + 1

    logger.info(
        f"[watch_hr_continuous] user={user_id} — "
        f"{len(raw_samples)} samples → {len(created)} sessions "
        f"({by_intensity})"
    )

    return jsonify({
        "sessions_created": len(created),
        "sessions":         created,
        "samples_received": len(raw_samples),
        "by_intensity":     by_intensity,
        "message":          f"Successfully created {len(created)} activity sessions",
    }), 201