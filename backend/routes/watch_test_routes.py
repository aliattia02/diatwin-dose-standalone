"""
watch_test_routes.py — Dev-only Test Data Injection
==============================================================================
Provides three endpoints used by the mobile watch.tsx test-data UI and the
seed_test_hr.py script.  Blocked entirely on Render (production).

Endpoints
─────────
  POST   /api/watch/test/inject  — accept HR samples, run through real pipeline
  DELETE /api/watch/test/inject  — remove test sessions + fake connection doc
  GET    /api/watch/test/status  — return test-mode status for current user

How it fits in:
  • Samples arrive as [{ timestamp_iso, hr_bpm }] — same shape fetch_google_fit_hr()
    returns in watch_sync_service.py.
  • segment_hr_stream() + session_to_activity_doc() are called UNCHANGED —
    exactly as the real scheduler calls them.
  • A fake watch_connections doc (test_mode=True) is upserted so that
    GET /api/watch/status returns connected=True with test_mode=True.

Register in main.py (already shown in previous step):
    if not os.environ.get('RENDER'):
        from routes.watch_test_routes import watch_test_bp
        app.register_blueprint(watch_test_bp, url_prefix='')

One small addition needed in watch_sync_routes.py _build_status():
    "test_mode": conn.get("test_mode", False),   # ← add this line
==============================================================================
"""

import logging
import os
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.watch_hr_autosegment import segment_hr_stream, session_to_activity_doc

logger = logging.getLogger(__name__)

watch_test_bp = Blueprint("watch_test", __name__)

TEST_SOURCE      = "fitbit_test_harness"
TEST_GOOGLE_NAME  = "Test Dataset (Fitbit)"
TEST_GOOGLE_EMAIL = "test@diatwin.dev"
MAX_SAMPLES       = 5_000   # safety cap


# ─────────────────────────────────────────────────────────────────────────────
# Guard — refuse all requests when running on Render
# ─────────────────────────────────────────────────────────────────────────────

def _assert_dev():
    if os.environ.get("RENDER"):
        from flask import abort
        abort(403, description="Test endpoints are disabled in production.")


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/watch/test/inject
# ─────────────────────────────────────────────────────────────────────────────

@watch_test_bp.route("/api/watch/test/inject", methods=["POST"])
@token_required
@api_error_handler
def inject_test_data(current_user):
    """
    Accept synthetic HR samples, run them through segment_hr_stream() and
    session_to_activity_doc() (both unchanged), then insert the resulting
    activity docs with source="fitbit_test_harness".

    Also upserts a fake watch_connections doc so GET /api/watch/status
    returns connected=True, test_mode=True — the mobile UI switches to the
    amber "🧪 Test Data" badge automatically.

    Request body:
        {
          "samples": [
            { "timestamp_iso": "2026-05-03T07:10:00+00:00", "hr_bpm": 122 },
            ...
          ]
        }

    Response:
        {
          "new_count":    3,
          "skipped_count": 0,
          "sessions": [
            { "session_id": "...", "intensity": "vigorous",
              "start_time": "...", "duration_minutes": 17.0 }
          ]
        }
    """
    _assert_dev()

    user_id = str(current_user["_id"])
    body    = request.get_json(force=True) or {}
    raw     = body.get("samples", [])

    if not raw:
        return jsonify({"error": "No samples provided"}), 400

    # ── Validate + filter ─────────────────────────────────────────────────────
    clean = []
    for s in raw[:MAX_SAMPLES]:
        try:
            hr = int(s["hr_bpm"])
            if not (20 <= hr <= 300):
                continue
            clean.append({
                "timestamp_iso": str(s["timestamp_iso"]),
                "hr_bpm":        hr,
            })
        except (KeyError, ValueError, TypeError):
            continue

    if not clean:
        return jsonify({"error": "No valid samples after filtering (hr_bpm must be 20–300)"}), 400

    logger.info("[watch_test] user=%s injecting %d samples", user_id, len(clean))

    # ── Run through the unchanged segmentation pipeline ───────────────────────
    sessions = segment_hr_stream(clean)

    if not sessions:
        return jsonify({
            "new_count":    0,
            "skipped_count": len(clean),
            "sessions":     [],
            "message":      "No activity sessions detected — check HR values and thresholds",
        }), 200

    # ── Insert activity docs ──────────────────────────────────────────────────
    inserted = []
    for sess in sessions:
        doc = session_to_activity_doc(sess, user_id)
        doc["source"] = TEST_SOURCE      # override "watch_continuous" → test source

        # ── Normalise doc to match the shape the visualisation layer expects ──
        # 1. startTime / endTime: convert BSON Dates → ISO-8601 strings ending in "Z"
        for field in ("startTime", "endTime"):
            v = doc.get(field)
            if isinstance(v, datetime):
                doc[field] = v.strftime("%Y-%m-%dT%H:%M:%S.000Z")

        # 2. completedTime must equal startTime, not endTime
        doc["completedTime"] = doc.get("startTime")

        # 3. notes must be present (empty string) so queries / UI don't miss it
        doc.setdefault("notes", "")

        # 4. level and impact are already set by session_to_activity_doc()
        #    using the canonical mapping (light=0, moderate=1, vigorous=2).
        #    No override needed here.

        # 5. timestamp field (insertion wall-clock time) - used by time-range queries
        doc.setdefault("timestamp", datetime.now(timezone.utc))

        result = mongo.db.activities.insert_one(doc)
        inserted.append({
            "session_id":       str(result.inserted_id),
            "intensity":        sess["intensity"],
            "start_time":       sess["start_time"].isoformat(),
            "duration_minutes": sess["duration_minutes"],
        })

    # ── Upsert fake watch_connections doc ─────────────────────────────────────
    now = datetime.now(timezone.utc).isoformat()
    mongo.db.watch_connections.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id":               user_id,
            "test_mode":             True,
            "google_name":           TEST_GOOGLE_NAME,
            "google_email":          TEST_GOOGLE_EMAIL,
            "auto_sync_enabled":     False,
            "sync_interval_minutes": 15,
            "last_sync":             now,
            "connected_at":          now,
            # No real tokens — scheduler will skip this doc (auto_sync_enabled=False)
            "access_token":          None,
            "refresh_token":         None,
        }},
        upsert=True,
    )

    logger.info(
        "[watch_test] user=%s → %d session(s) inserted (source=%s)",
        user_id, len(inserted), TEST_SOURCE,
    )

    return jsonify({
        "new_count":    len(inserted),
        "skipped_count": len(clean) - sum(
            int(s["duration_minutes"]) for s in sessions
        ),
        "sessions": inserted,
    }), 201


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/watch/test/inject
# ─────────────────────────────────────────────────────────────────────────────

@watch_test_bp.route("/api/watch/test/inject", methods=["DELETE"])
@token_required
@api_error_handler
def clear_test_data(current_user):
    """
    Remove all test-injected activity docs and the fake watch_connections entry.

    Response:
        { "deleted_sessions": 7, "message": "Test data cleared" }
    """
    _assert_dev()

    user_id = str(current_user["_id"])

    result = mongo.db.activities.delete_many({
        "user_id": user_id,
        "source":  TEST_SOURCE,
    })

    mongo.db.watch_connections.delete_one({
        "user_id":   user_id,
        "test_mode": True,
    })

    logger.info(
        "[watch_test] user=%s cleared %d test session(s)",
        user_id, result.deleted_count,
    )

    return jsonify({
        "deleted_sessions": result.deleted_count,
        "message":          "Test data cleared",
    }), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/watch/test/status
# ─────────────────────────────────────────────────────────────────────────────

@watch_test_bp.route("/api/watch/test/status", methods=["GET"])
@token_required
@api_error_handler
def test_status(current_user):
    """
    Return whether test data is currently active for this user.

    Response:
        {
          "test_mode":     true,
          "session_count": 3,
          "oldest_session": "2026-05-03T07:10:00",
          "newest_session": "2026-05-03T17:30:00"
        }
    """
    _assert_dev()

    user_id = str(current_user["_id"])

    conn = mongo.db.watch_connections.find_one({
        "user_id":   user_id,
        "test_mode": True,
    })

    if not conn:
        return jsonify({"test_mode": False, "session_count": 0}), 200

    sessions = list(mongo.db.activities.find(
        {"user_id": user_id, "source": TEST_SOURCE},
        {"startTime": 1}
    ).sort("startTime", 1))

    oldest = sessions[0]["startTime"].isoformat()  if sessions else None
    newest = sessions[-1]["startTime"].isoformat() if sessions else None

    return jsonify({
        "test_mode":     True,
        "session_count": len(sessions),
        "oldest_session": oldest,
        "newest_session": newest,
    }), 200