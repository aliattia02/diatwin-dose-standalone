"""
watch_sync_routes.py — Google Fit OAuth Integration Endpoints
==============================================================================
Blueprint that handles the full connection lifecycle for Google Fit HR syncing.

Mirrors libre_routes.py — the existing watch_hr_routes.py is NOT modified.
This blueprint handles OAuth; watch_hr_routes.py handles live HR streaming.

Endpoints
─────────
  POST   /api/watch/connect      — exchange OAuth code, store tokens, first sync
  GET    /api/watch/status       — connection status + latest session info
  POST   /api/watch/sync         — manual sync on demand
  PUT    /api/watch/settings     — update auto_sync_enabled / sync_interval
  DELETE /api/watch/disconnect   — remove tokens (+ optionally delete activity data)

  GET    /api/watch/oauth-url    — helper: returns the Google OAuth consent URL
                                   (so mobile never hard-codes the URL)

Register in main.py:
    from routes.watch_sync_routes import watch_sync_bp
    app.register_blueprint(watch_sync_bp)

Author: DiaTwin Team
==============================================================================
"""

import logging
import os
from datetime import datetime

from flask import Blueprint, jsonify, request

from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler

logger = logging.getLogger(__name__)

watch_sync_bp = Blueprint("watch_sync", __name__)

# ── Google OAuth scopes needed ────────────────────────────────────────────────
_SCOPES = " ".join([
    "https://www.googleapis.com/auth/fitness.heart_rate.read",
    "https://www.googleapis.com/auth/fitness.activity.read",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
])


# ─────────────────────────────────────────────────────────────────────────────
# Helper: build connection status dict (mirrors libre _status_doc())
# ─────────────────────────────────────────────────────────────────────────────

def _build_status(conn: dict) -> dict:
    """Serialize a watch_connections document into a safe API response."""
    return {
        "connected":             True,
        "google_email":          conn.get("google_email"),
        "google_name":           conn.get("google_name"),
        "auto_sync_enabled":     conn.get("auto_sync_enabled", True),
        "sync_interval_minutes": conn.get("sync_interval_minutes", 15),
        "last_sync":             conn.get("last_sync"),
        "connected_at":          conn.get("connected_at"),
        # Never expose tokens
    }


# ─────────────────────────────────────────────────────────────────────────────
# 1. OAuth URL helper
# ─────────────────────────────────────────────────────────────────────────────

@watch_sync_bp.route("/api/watch/oauth-url", methods=["GET"])
@token_required
@api_error_handler
def get_oauth_url(current_user):
    """
    Return the Google OAuth consent URL.
    Mobile opens this in a WebView; after consent Google redirects to
    GOOGLE_REDIRECT_URI with ?code=<auth_code>.

    Response:
        url  (str)  — full consent URL to open in WebView
    """
    client_id    = os.environ.get("GOOGLE_CLIENT_ID", "")
    redirect_uri = os.environ.get(
        "GOOGLE_REDIRECT_URI", "com.diatwin.mobile://auth/watch"
    )

    if not client_id:
        return jsonify({"error": "Google OAuth is not configured on the server."}), 503

    params = (
        f"https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope={_SCOPES.replace(' ', '%20')}"
        f"&access_type=offline"
        f"&prompt=consent"          # force consent so we always get refresh_token
    )

    return jsonify({"url": params}), 200


# ─────────────────────────────────────────────────────────────────────────────
# 2. Connect — exchange auth code, store tokens, run first sync
# ─────────────────────────────────────────────────────────────────────────────

@watch_sync_bp.route("/api/watch/connect", methods=["POST"])
@token_required
@api_error_handler
def connect_watch(current_user):
    """
    Exchange a Google OAuth authorisation code for tokens and run first sync.

    Request body (JSON):
        code  (str, required) — the auth code returned by Google's consent page

    Response:
        message      (str)
        status       (dict)  — connection details (no tokens)
        sync_result  (dict)  — { new_count, skipped_count, latest_session }
    """
    body    = request.get_json(silent=True) or {}
    user_id = str(current_user["_id"])
    code    = body.get("code", "").strip()

    if not code:
        return jsonify({"error": "code is required"}), 400

    from services.watch_sync_service import connect_watch as _connect

    result = _connect(user_id, code)

    conn = mongo.db.watch_connections.find_one({"user_id": user_id})
    status = _build_status(conn) if conn else {"connected": False}

    return jsonify({
        "message":     "Google Fit connected successfully",
        "status":      status,
        "sync_result": result["sync_result"],
    }), 201


# ─────────────────────────────────────────────────────────────────────────────
# 3. Status
# ─────────────────────────────────────────────────────────────────────────────

@watch_sync_bp.route("/api/watch/status", methods=["GET"])
@token_required
@api_error_handler
def watch_status(current_user):
    """
    Return current connection status.

    Response:
        connected  (bool)
        + fields from _build_status() when connected
    """
    user_id = str(current_user["_id"])
    conn    = mongo.db.watch_connections.find_one({"user_id": user_id})

    if not conn:
        return jsonify({"connected": False}), 200

    return jsonify(_build_status(conn)), 200


# ─────────────────────────────────────────────────────────────────────────────
# 4. Manual sync
# ─────────────────────────────────────────────────────────────────────────────

@watch_sync_bp.route("/api/watch/sync", methods=["POST"])
@token_required
@api_error_handler
def manual_sync(current_user):
    """
    Trigger an on-demand sync from Google Fit.

    Response:
        message      (str)
        new_count    (int)  — activity sessions created
        skipped_count (int)
        latest_session (dict | null)
    """
    user_id = str(current_user["_id"])
    conn    = mongo.db.watch_connections.find_one({"user_id": user_id})

    if not conn:
        return jsonify({"error": "Google Fit is not connected. Connect first."}), 400

    from services.watch_sync_service import _perform_sync

    result = _perform_sync(user_id, conn)

    return jsonify({
        "message":       f"Sync complete — {result['new_count']} session(s) created",
        "new_count":     result["new_count"],
        "skipped_count": result["skipped_count"],
        "latest_session": result["latest_session"],
    }), 200


# ─────────────────────────────────────────────────────────────────────────────
# 5. Update settings
# ─────────────────────────────────────────────────────────────────────────────

@watch_sync_bp.route("/api/watch/settings", methods=["PUT"])
@token_required
@api_error_handler
def update_watch_settings(current_user):
    """
    Update auto_sync_enabled and/or sync_interval_minutes.
    Optionally store patient-level hr_base / hr_max (used as ODE inputs).

    Request body (JSON — all optional):
        auto_sync_enabled      (bool)
        sync_interval_minutes  (int, min 15)
        hr_base                (float)
        hr_max                 (float)
    """
    body    = request.get_json(silent=True) or {}
    user_id = str(current_user["_id"])

    conn = mongo.db.watch_connections.find_one({"user_id": user_id})
    if not conn:
        return jsonify({"error": "Google Fit is not connected."}), 400

    updates = {}
    if "auto_sync_enabled" in body:
        updates["auto_sync_enabled"] = bool(body["auto_sync_enabled"])
    if "sync_interval_minutes" in body:
        updates["sync_interval_minutes"] = max(15, int(body["sync_interval_minutes"]))
    if "hr_base" in body:
        updates["hr_base"] = float(body["hr_base"])
    if "hr_max" in body:
        updates["hr_max"] = float(body["hr_max"])

    if updates:
        mongo.db.watch_connections.update_one(
            {"user_id": user_id}, {"$set": updates}
        )

    return jsonify({"message": "Settings updated", "settings": updates}), 200


# ─────────────────────────────────────────────────────────────────────────────
# 6. Disconnect
# ─────────────────────────────────────────────────────────────────────────────

@watch_sync_bp.route("/api/watch/disconnect", methods=["DELETE"])
@token_required
@api_error_handler
def disconnect_watch(current_user):
    """
    Remove the stored Google tokens.

    Query params:
        delete_activities (bool, optional) — also delete synced activity sessions

    Response:
        message             (str)
        deleted_activities  (int)
    """
    user_id = str(current_user["_id"])

    conn = mongo.db.watch_connections.find_one({"user_id": user_id})
    if not conn:
        return jsonify({"error": "Google Fit is not connected."}), 400

    deleted_activities = 0
    if request.args.get("delete_activities", "").lower() in ("true", "1"):
        result = mongo.db.activities.delete_many(
            {"user_id": user_id, "source": "google_fit"}
        )
        deleted_activities = result.deleted_count

    mongo.db.watch_connections.delete_one({"user_id": user_id})

    logger.info(
        "[watch_sync] user=%s disconnected; deleted_activities=%d",
        user_id, deleted_activities,
    )

    return jsonify({
        "message":            "Google Fit disconnected",
        "deleted_activities": deleted_activities,
    }), 200
