"""
libre_routes.py — LibreLinkUp Integration Routes  (PATCHED)
============================================================================
Key change in this patch:
  - connect_libre() now has granular try/except blocks that surface the
    *real* error message instead of swallowing everything as HTTP 500.
  - Added step-by-step logging so the Flask terminal shows exactly which
    stage failed (Fernet key, authenticate, upsert, initial sync).
  - All other endpoints are unchanged from the original.
============================================================================
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta

from pymongo.errors import DuplicateKeyError
from bson.objectid import ObjectId
from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from services.libre_service import (
    LibreLinkUpService,
    LibreAuthError,
    LibreTokenExpiredError,
    LibreConnectionError,
    encrypt_credential,
    decrypt_credential,
    LIBRE_REGIONS,
    DEFAULT_BASE_URL,
    READING_TYPE_CGM,
    READING_TYPE_SCAN,
)
import logging
import traceback

logger = logging.getLogger(__name__)
libre_bp = Blueprint("libre", __name__)

DEFAULT_SYNC_INTERVAL_MINUTES = 5
MAX_READINGS_PER_SYNC = 500
LIBRE_SOURCE_TAG = "libre_cgm"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers (unchanged)
# ─────────────────────────────────────────────────────────────────────────────

def _service_from_connection(conn_doc: dict) -> LibreLinkUpService:
    base_url = conn_doc.get("base_url", DEFAULT_BASE_URL)
    return LibreLinkUpService(base_url=base_url)


def _get_valid_token(conn_doc: dict, user_id: str) -> str:
    token_expires = conn_doc.get("token_expires")
    if isinstance(token_expires, str):
        token_expires = datetime.fromisoformat(token_expires)

    needs_refresh = (
        not token_expires
        or datetime.utcnow() >= token_expires - timedelta(hours=24)
    )

    if not needs_refresh:
        return conn_doc["auth_token"]

    logger.info(f"LibreLinkUp token near expiry for user {user_id} — refreshing")
    email    = decrypt_credential(conn_doc["email_encrypted"])
    password = decrypt_credential(conn_doc["password_encrypted"])

    svc = _service_from_connection(conn_doc)
    auth = svc.authenticate(email, password)

    mongo.db.libre_connections.update_one(
        {"user_id": user_id},
        {"$set": {
            "auth_token":    auth["auth_token"],
            "token_expires": auth["token_expires"],
            "base_url":      auth["base_url"],
            "region":        auth["region"],
            "last_token_refresh": datetime.utcnow(),
        }}
    )
    return auth["auth_token"]


def _format_connection_status(conn_doc: dict) -> dict:
    if not conn_doc:
        return {"connected": False}

    token_expires = conn_doc.get("token_expires")
    if isinstance(token_expires, datetime):
        token_expires_str = token_expires.isoformat() + "Z"
    else:
        token_expires_str = None

    last_sync = conn_doc.get("last_sync")
    return {
        "connected":              True,
        "first_name":             conn_doc.get("first_name", ""),
        "last_name":              conn_doc.get("last_name", ""),
        "country":                conn_doc.get("country", ""),
        "region":                 conn_doc.get("region", "EU"),
        "patient_id":             conn_doc.get("libre_patient_id", ""),
        "auto_sync_enabled":      conn_doc.get("auto_sync_enabled", False),
        "sync_interval_minutes":  conn_doc.get("sync_interval_minutes", DEFAULT_SYNC_INTERVAL_MINUTES),
        "last_sync":              last_sync.isoformat() + "Z" if isinstance(last_sync, datetime) else last_sync,
        "total_readings_synced":  conn_doc.get("total_readings_synced", 0),
        "token_expires":          token_expires_str,
        "connected_at":           conn_doc["connected_at"].isoformat() + "Z"
                                  if isinstance(conn_doc.get("connected_at"), datetime)
                                  else conn_doc.get("connected_at", ""),  # I-15: serialize same as last_sync
    }


def _save_single_reading(user_id: str, r: dict, target_glucose: int) -> bool:
    """
    Persist one LibreLinkUp reading to blood_sugar + meals collections.
    Returns True if a new record was inserted, False if it already existed.
    `r` must have: timestamp (datetime), value_mgdl, trend, is_high, is_low, reading_type.
    """
    ts = r["timestamp"]

    # ASSERTION: ts must be a naive UTC datetime (no tzinfo, no local time).
    # _parse_libre_timestamp() converts LibreLinkUp local timestamps to UTC
    # by subtracting utc_offset_hours. Storing anything other than UTC here
    # breaks deduplication and causes the frontend to double-apply the browser's
    # local timezone offset (producing the 4-hour shift bug).
    exists = mongo.db.blood_sugar.find_one({
        "user_id": user_id,
        "source":  LIBRE_SOURCE_TAG,
        "bloodSugarTimestamp": ts,
    })
    if exists:
        return False

    value_mgdl = r["value_mgdl"]

    if value_mgdl < target_glucose * 0.7:
        status = "low"
    elif value_mgdl > target_glucose * 1.3:
        status = "high"
    else:
        status = "normal"

    trend = r.get("trend")
    trend_label = {
        1: "rapidly_rising", 2: "rising", 3: "stable",
        4: "falling",        5: "rapidly_falling",
    }.get(trend, "unknown")

    now = datetime.utcnow()

    bs_doc = {
        "user_id":             user_id,
        "bloodSugar":          value_mgdl,
        "status":              status,
        "target":              target_glucose,
        "timestamp":           now,
        "bloodSugarTimestamp": ts,
        "notes":               "",
        "source":              LIBRE_SOURCE_TAG,
        "reading_type":        r.get("reading_type", 0),
        "trend":               trend,
        "trend_label":         trend_label,
        "is_high":             r["is_high"],
        "is_low":              r["is_low"],
        "baseline_calculation": {
            "baseline":   None,
            "net_effect": None,
            "confidence": "cgm_raw",
            "skipped":    True,
            "reason":     "bulk_cgm_import",
        },
    }
    # D17: the find_one above races when two processes sync the same user at
    # once — and the scheduler runs once per gunicorn worker.
    # `unique_libre_cgm_reading` is what stops the duplicate reaching the
    # collection, but an uncaught DuplicateKeyError propagates out of the
    # caller's `for r in readings` loop and discards every remaining reading in
    # the batch. Losing the race means the other worker already stored this
    # reading — precisely the "already exists" case the find_one handles — so
    # it is a skip, not an error.
    try:
        bs_result = mongo.db.blood_sugar.insert_one(bs_doc)
    except DuplicateKeyError:
        logger.debug(
            "LibreSync user=%s: reading at %s already stored by a concurrent "
            "sync — skipping", user_id, ts,
        )
        return False
    bs_id      = str(bs_result.inserted_id)

    meal_doc = {
        "user_id":             user_id,
        "timestamp":           now,
        "mealType":            "blood_sugar_only",
        "foodItems":           [],
        "activities":          [],
        "nutrition":           {"calories": 0, "carbs": 0, "protein": 0, "fat": 0, "absorption_factor": 1.0},
        "bloodSugar":          value_mgdl,
        "bloodSugarTimestamp": ts.replace(tzinfo=None),  # I-10: store as datetime (consistent with blood_sugar collection)
        "bloodSugarSource":    LIBRE_SOURCE_TAG,
        "notes":               "",
        "isStandaloneReading": True,
        "suggestedInsulin":    0,
        "insulinCalculation":  {},
        "blood_sugar_id":      bs_id,
    }
    meal_result = mongo.db.meals.insert_one(meal_doc)
    mongo.db.blood_sugar.update_one(
        {"_id": bs_result.inserted_id},
        {"$set": {"meal_id": str(meal_result.inserted_id)}}
    )
    return True


def _perform_sync(user_id: str, conn_doc: dict) -> dict:
    from constants import Constants

    token      = _get_valid_token(conn_doc, user_id)
    patient_id = conn_doc["libre_patient_id"]
    svc        = _service_from_connection(conn_doc)

    # Retrieve account_id for API header
    account_id = conn_doc.get("account_id", "")
    if not account_id:
        # Fall back: decode JWT payload to extract account ID
        # JWT format: header.payload.signature (base64url encoded)
        try:
            import base64, json as _json
            jwt_payload = token.split(".")[1]
            # Add padding if needed
            padded = jwt_payload + "=" * (4 - len(jwt_payload) % 4)
            payload_data = _json.loads(base64.urlsafe_b64decode(padded))
            account_id = payload_data.get("id", "") or payload_data.get("sub", "") or payload_data.get("accountId", "")
            if account_id:
                # Cache it back to MongoDB so future syncs don't need to decode
                mongo.db.libre_connections.update_one(
                    {"user_id": user_id},
                    {"$set": {"account_id": account_id}}
                )
                logger.info(f"Extracted and cached account_id from JWT for user {user_id}")
        except Exception as e:
            logger.warning(f"Could not extract account_id from JWT: {e}")

    # I-8: Resolve UTC offset before reading timestamps so _parse_libre_timestamp
    # applies the correct shift for this patient's timezone (fixes non-UTC patients).
    try:
        _pc = Constants(user_id).get_patient_constants()
        utc_offset_hours = _pc.get("timezone_offset_minutes", 0) / 60
    except Exception as _e:
        logger.warning(f"Could not load timezone offset for user {user_id}: {_e}. Defaulting to UTC.")
        utc_offset_hours = 0.0

    if utc_offset_hours == 0:
        logger.warning(
            f"LibreSync user={user_id}: timezone_offset_minutes=0. "
            f"Timestamps will be stored as-is (no UTC conversion). "
            f"If patient is not in UTC, set timezone_offset_minutes in "
            f"patient constants (positive = east of UTC, e.g. Egypt = 120)."
        )

    try:
        readings = svc.get_readings(
            token, patient_id,
            include_scans=True, account_id=account_id,
            utc_offset_hours=utc_offset_hours,
        )
    except LibreTokenExpiredError:
        # D18: mark the token expired, then re-read the document before asking
        # for a token.
        #
        # `_get_valid_token` decides whether to refresh by reading
        # `token_expires` off the dict it is handed. The caller's `conn_doc` was
        # loaded before the update_one above and still carries the original
        # future expiry, so passing it straight back returns the *same stale
        # token* and the retry re-sends the identical failing request — measured
        # as zero calls to the login endpoint. Re-reading is what makes this
        # branch do what it says.
        mongo.db.libre_connections.update_one(
            {"user_id": user_id},
            {"$set": {"token_expires": datetime.utcnow() - timedelta(hours=1)}}
        )
        refreshed_doc = mongo.db.libre_connections.find_one({"user_id": user_id})
        if refreshed_doc is None:
            # The connection was deleted mid-sync. Fall back to the caller's
            # copy with the expiry cleared, so a refresh is still attempted.
            refreshed_doc = {**conn_doc, "token_expires": None}
        token    = _get_valid_token(refreshed_doc, user_id)
        readings = svc.get_readings(
            token, patient_id,
            include_scans=True, account_id=account_id,
            utc_offset_hours=utc_offset_hours,
        )

    if not readings:
        return {"new_count": 0, "skipped_count": 0, "latest_reading": None}

    try:
        user_constants  = Constants(user_id)
        target_glucose  = user_constants.get_constant("target_glucose")
    except Exception:
        target_glucose  = 100

    new_count      = 0
    skipped_count  = 0
    latest_reading = None

    for r in readings[-MAX_READINGS_PER_SYNC:]:
        saved = _save_single_reading(user_id, r, target_glucose)
        if not saved:
            skipped_count += 1
            continue

        new_count += 1
        ts    = r["timestamp"]
        trend = r.get("trend")
        latest_reading = {
            "bloodSugar":          r["value_mgdl"],
            "bloodSugarTimestamp": ts.isoformat() + "Z",
            "status":              ("low"  if r["value_mgdl"] < target_glucose * 0.7
                                    else "high" if r["value_mgdl"] > target_glucose * 1.3
                                    else "normal"),
            "trend":               trend,
            "trend_label":         {1: "rapidly_rising", 2: "rising", 3: "stable",
                                    4: "falling", 5: "rapidly_falling"}.get(trend, "unknown"),
            "is_high":             r["is_high"],
            "is_low":              r["is_low"],
        }

    mongo.db.libre_connections.update_one(
        {"user_id": user_id},
        {"$set": {"last_sync": datetime.utcnow()},
         "$inc": {"total_readings_synced": new_count}}
    )

    logger.info(f"LibreSync user={user_id}: {new_count} new, {skipped_count} skipped")
    return {"new_count": new_count, "skipped_count": skipped_count, "latest_reading": latest_reading}


# ─────────────────────────────────────────────────────────────────────────────
# PATCHED: connect_libre — granular error handling
# ─────────────────────────────────────────────────────────────────────────────

@libre_bp.route("/api/libre/connect", methods=["POST"])
@token_required
def connect_libre(current_user):
    """
    Connect a LibreLinkUp account.
    Patched version: surfaces the real error instead of returning a generic 500.
    """
    user_id = str(current_user["_id"])
    logger.info(f"[libre/connect] Step 1 — received request for user {user_id}")

    # ── 1. Parse request body ─────────────────────────────────────────────
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body required"}), 400

        email    = (data.get("email") or "").strip().lower()
        password = data.get("password", "")
        region   = (data.get("region") or "EU").upper()

        if not email or not password:
            return jsonify({"error": "email and password are required"}), 400

        if region not in LIBRE_REGIONS:
            return jsonify({
                "error": f"Unknown region '{region}'. Valid: {', '.join(LIBRE_REGIONS.keys())}"
            }), 400

        logger.info(f"[libre/connect] Step 2 — email={email}, region={region}")
    except Exception as e:
        logger.error(f"[libre/connect] ❌ Failed parsing request: {e}")
        return jsonify({"error": f"Bad request: {e}"}), 400

    # ── 2. Test Fernet key (encryption) ──────────────────────────────────
    try:
        encrypt_credential("test")
        logger.info("[libre/connect] Step 3 — Fernet key OK")
    except Exception as e:
        logger.error(f"[libre/connect] ❌ Fernet/SECRET_KEY error: {e}")
        return jsonify({
            "error": "Server encryption not configured",
            "detail": str(e),
            "hint": "Set SECRET_KEY in your .env file or config.py"
        }), 500

    # ── 3. Authenticate with LibreLinkUp ──────────────────────────────────
    try:
        base_url = LIBRE_REGIONS[region]
        svc      = LibreLinkUpService(base_url=base_url)
        logger.info(f"[libre/connect] Step 4 — authenticating against {base_url}")
        auth = svc.authenticate(email, password)
        logger.info(f"[libre/connect] Step 5 — auth OK, patient_id={auth.get('patient_id')}")
    except LibreAuthError as e:
        logger.warning(f"[libre/connect] Auth rejected: {e}")
        return jsonify({"error": str(e), "code": "AUTH_FAILED"}), 401
    except LibreConnectionError as e:
        logger.error(f"[libre/connect] Connection error: {e}")
        return jsonify({"error": str(e), "code": "CONNECTION_FAILED"}), 502
    except Exception as e:
        # I-9: log full traceback server-side only — never expose to client
        logger.error(f"[libre/connect] ❌ Unexpected auth error: {traceback.format_exc()}")
        return jsonify({
            "error": "An unexpected error occurred during authentication. Please try again.",
            "code": "UNEXPECTED_AUTH_ERROR",
        }), 500

    # ── 4. Encrypt credentials and save connection ────────────────────────
    try:
        connection_doc = {
            "user_id":               user_id,
            "email_encrypted":       encrypt_credential(email),
            "password_encrypted":    encrypt_credential(password),
            "auth_token":            auth["auth_token"],
            "token_expires":         auth["token_expires"],
            "libre_patient_id":      auth["patient_id"],
            "region":                auth["region"],
            "base_url":              auth["base_url"],
            "first_name":            auth["first_name"],
            "last_name":             auth["last_name"],
            "country":               auth["country"],
            "auto_sync_enabled":     True,
            "sync_interval_minutes": DEFAULT_SYNC_INTERVAL_MINUTES,
            "last_sync":             None,
            "total_readings_synced": 0,
            "connected_at":          datetime.utcnow(),  # I-15: store as datetime (consistent with last_sync)
            "all_connections":       auth.get("all_connections", []),
            "account_id":            auth.get("account_id", ""),
        }

        mongo.db.libre_connections.replace_one(
            {"user_id": user_id},
            connection_doc,
            upsert=True,
        )
        logger.info(f"[libre/connect] Step 6 — connection saved to MongoDB")
    except Exception as e:
        # I-9: log full traceback server-side only — never expose to client
        logger.error(f"[libre/connect] ❌ MongoDB save error: {traceback.format_exc()}")
        return jsonify({
            "error": "Failed to save connection. Please try again.",
            "code": "DB_ERROR",
        }), 500

    # ── 5. Initial sync (non-fatal if it fails) ───────────────────────────
    conn_doc = mongo.db.libre_connections.find_one({"user_id": user_id})
    try:
        logger.info("[libre/connect] Step 7 — running initial sync")
        sync_result = _perform_sync(user_id, conn_doc)
        logger.info(f"[libre/connect] Step 8 — sync done: {sync_result}")
    except Exception as e:
        logger.warning(f"[libre/connect] Initial sync failed (non-fatal): {e}")
        sync_result = {"new_count": 0, "skipped_count": 0, "latest_reading": None, "sync_error": str(e)}

    return jsonify({
        "message":     "LibreLinkUp connected successfully",
        "status":      _format_connection_status(conn_doc),
        "sync_result": sync_result,
    }), 201


# ─────────────────────────────────────────────────────────────────────────────
# All remaining endpoints — unchanged from original
# ─────────────────────────────────────────────────────────────────────────────

@libre_bp.route("/api/libre/disconnect", methods=["DELETE"])
@token_required
@api_error_handler
def disconnect_libre(current_user):
    user_id = str(current_user["_id"])
    conn = mongo.db.libre_connections.find_one({"user_id": user_id})
    if not conn:
        return jsonify({"error": "No LibreLinkUp connection found"}), 404

    mongo.db.libre_connections.delete_one({"user_id": user_id})

    deleted_readings = 0
    if request.args.get("delete_readings", "").lower() == "true":
        result = mongo.db.blood_sugar.delete_many({
            "user_id": user_id,
            "source":  LIBRE_SOURCE_TAG,
        })
        mongo.db.meals.delete_many({
            "user_id":          user_id,
            "bloodSugarSource": LIBRE_SOURCE_TAG,
        })
        deleted_readings = result.deleted_count

    return jsonify({
        "message":          "LibreLinkUp disconnected",
        "deleted_readings": deleted_readings,
    }), 200


@libre_bp.route("/api/libre/status", methods=["GET"])
@token_required
@api_error_handler
def get_libre_status(current_user):
    # NOTE (I-16): Passing ?fetch_and_save_latest=true triggers a live LibreLinkUp
    # API call AND writes the result to the blood_sugar + meals collections via
    # _save_single_reading(). Callers polling for display purposes only should
    # omit this parameter to avoid inadvertent DB writes.
    # (The param was renamed from fetch_latest to make the side-effect explicit.)
    user_id = str(current_user["_id"])
    conn    = mongo.db.libre_connections.find_one({"user_id": user_id})

    if not conn:
        return jsonify({"connected": False}), 200

    status = _format_connection_status(conn)

    latest_reading = None
    if request.args.get("fetch_and_save_latest", "").lower() == "true":  # I-16: renamed from fetch_latest
        try:
            token    = _get_valid_token(conn, user_id)
            svc      = _service_from_connection(conn)
            # Extract account_id from JWT if not stored
            _aid = conn.get("account_id", "")
            if not _aid:
                try:
                    import base64 as _b64, json as _json
                    _p = token.split(".")[1]; _p += "=" * (4 - len(_p) % 4)
                    _aid = _json.loads(_b64.urlsafe_b64decode(_p)).get("id", "")
                except Exception:
                    pass
            # FIX: Load the patient's UTC offset so timestamps are converted
            # identically to _perform_sync. Without this, get_latest_reading
            # defaulted to UTC+0, storing the same reading at a different
            # timestamp and defeating the deduplication check → zigzag chart.
            try:
                from constants import Constants as _Constants
                _pc = _Constants(user_id).get_patient_constants()
                _utc_offset = _pc.get("timezone_offset_minutes", 0) / 60
            except Exception as _tz_err:
                logger.warning(
                    f"Could not load timezone offset for status fetch (user {user_id}): "
                    f"{_tz_err}. Defaulting to UTC."
                )
                _utc_offset = 0.0

            if _utc_offset == 0:
                logger.warning(
                    f"LibreStatus user={user_id}: timezone_offset_minutes=0. "
                    f"Timestamps will be stored as-is (no UTC conversion). "
                    f"If patient is not in UTC, set timezone_offset_minutes in "
                    f"patient constants (positive = east of UTC, e.g. Egypt = 120)."
                )

            latest_r = svc.get_latest_reading(
                token, conn["libre_patient_id"],
                account_id=_aid,
                utc_offset_hours=_utc_offset,
            )
            if latest_r:
                latest_reading = {
                    "bloodSugar":          latest_r["value_mgdl"],
                    "bloodSugarTimestamp": latest_r["timestamp"].isoformat() + "Z",
                    "trend":               latest_r.get("trend"),
                    "trend_label": {
                        1: "rapidly_rising", 2: "rising", 3: "stable",
                        4: "falling", 5: "rapidly_falling"
                    }.get(latest_r.get("trend"), "unknown"),
                    "is_high": latest_r["is_high"],
                    "is_low":  latest_r["is_low"],
                }

                # ── Auto-save to DB if this reading is new ─────────────────
                # This ensures the latest CGM value is available in the
                # blood_sugar collection for ActiveEffectsDisplay / BG
                # estimation even before the user manually triggers a sync.
                try:
                    from constants import Constants
                    try:
                        target_glucose = Constants(user_id).get_constant("target_glucose")
                    except Exception:
                        target_glucose = 100

                    was_saved = _save_single_reading(user_id, latest_r, target_glucose)
                    if was_saved:
                        mongo.db.libre_connections.update_one(
                            {"user_id": user_id},
                            {"$set":  {"last_sync": datetime.utcnow()},
                             "$inc":  {"total_readings_synced": 1}},
                        )
                        logger.info(
                            f"Auto-saved latest Libre reading for user {user_id}: "
                            f"{latest_r['value_mgdl']} mg/dL"
                        )
                except Exception as save_err:
                    # Non-fatal: we still return the reading even if save fails
                    logger.warning(f"Could not auto-save latest reading: {save_err}")
                # ─────────────────────────────────────────────────────────────

        except (LibreAuthError, LibreTokenExpiredError, LibreConnectionError) as e:
            logger.warning(f"Could not fetch live reading for status: {e}")
            status["live_fetch_error"] = str(e)

    return jsonify({
        **status,
        "latest_reading": latest_reading,
        "regions":        list(LIBRE_REGIONS.keys()),
    }), 200


@libre_bp.route("/api/libre/sync", methods=["POST"])
@token_required
@api_error_handler
def sync_libre(current_user):
    user_id = str(current_user["_id"])
    conn    = mongo.db.libre_connections.find_one({"user_id": user_id})

    if not conn:
        return jsonify({
            "error": "No LibreLinkUp connection found. Connect first via POST /api/libre/connect",
            "code":  "NOT_CONNECTED",
        }), 404

    try:
        result = _perform_sync(user_id, conn)
    except LibreAuthError as e:
        return jsonify({"error": str(e), "code": "AUTH_FAILED"}), 401
    except LibreTokenExpiredError:
        return jsonify({
            "error": "LibreLinkUp session expired. Please reconnect.",
            "code":  "TOKEN_EXPIRED",
        }), 401
    except LibreConnectionError as e:
        return jsonify({"error": str(e), "code": "CONNECTION_FAILED"}), 502

    message = (
        f"Sync complete: {result['new_count']} new reading(s) stored"
        if result["new_count"] > 0
        else "Sync complete: no new readings (all already up to date)"
    )

    return jsonify({
        "message":        message,
        "new_count":      result["new_count"],
        "skipped_count":  result["skipped_count"],
        "latest_reading": result["latest_reading"],
    }), 200


@libre_bp.route("/api/libre/settings", methods=["PUT"])
@token_required
@api_error_handler
def update_libre_settings(current_user):
    user_id = str(current_user["_id"])
    conn    = mongo.db.libre_connections.find_one({"user_id": user_id})

    if not conn:
        return jsonify({"error": "No LibreLinkUp connection found"}), 404

    data = request.get_json() or {}
    updates = {}

    if "auto_sync_enabled" in data:
        if not isinstance(data["auto_sync_enabled"], bool):
            return jsonify({"error": "auto_sync_enabled must be a boolean"}), 400
        updates["auto_sync_enabled"] = data["auto_sync_enabled"]

    if "sync_interval_minutes" in data:
        interval = data["sync_interval_minutes"]
        # I-17: minimum is DEFAULT_SYNC_INTERVAL_MINUTES (5) — the LibreLinkUp sensor
        # updates every 5 min, so polling faster provides no new data and risks rate limiting.
        # (Watch sync equivalent enforces 15 min; this is a consistent, sensor-aware floor.)
        if not isinstance(interval, int) or not (DEFAULT_SYNC_INTERVAL_MINUTES <= interval <= 60):
            return jsonify({
                "error": f"sync_interval_minutes must be an integer between {DEFAULT_SYNC_INTERVAL_MINUTES} and 60"
            }), 400
        updates["sync_interval_minutes"] = interval

    if not updates:
        return jsonify({"error": "No valid settings provided"}), 400

    mongo.db.libre_connections.update_one({"user_id": user_id}, {"$set": updates})
    updated = mongo.db.libre_connections.find_one({"user_id": user_id})
    return jsonify({
        "message":  "Settings updated",
        "settings": {
            "auto_sync_enabled":     updated.get("auto_sync_enabled"),
            "sync_interval_minutes": updated.get("sync_interval_minutes"),
        }
    }), 200


@libre_bp.route("/api/libre/purge_readings", methods=["DELETE"])
@token_required
@api_error_handler
def purge_libre_readings(current_user):
    """
    Delete ALL libre_cgm readings for this user from blood_sugar + meals.

    Use this to clear pre-fix readings that were stored with the wrong UTC
    offset (e.g. Egypt local time stored as if it were UTC, producing a 2h
    display error).  After calling this, run a fresh sync — readings will be
    re-fetched and stored with the correct UTC-converted timestamps.

    Requires explicit confirmation:  DELETE /api/libre/purge_readings?confirm=true
    """
    user_id = str(current_user["_id"])

    if request.args.get("confirm", "").lower() != "true":
        return jsonify({
            "error": "Pass ?confirm=true to confirm deletion of all libre_cgm readings.",
            "hint":  "This removes stale pre-fix data. Run a sync afterwards to restore correct data.",
        }), 400

    bs_result   = mongo.db.blood_sugar.delete_many({"user_id": user_id, "source": LIBRE_SOURCE_TAG})
    meal_result = mongo.db.meals.delete_many({"user_id": user_id, "bloodSugarSource": LIBRE_SOURCE_TAG})

    # Reset the synced-count counter so it reflects only post-fix data
    mongo.db.libre_connections.update_one(
        {"user_id": user_id},
        {"$set": {"total_readings_synced": 0, "last_sync": None}},
    )

    logger.info(
        f"purge_libre_readings: user={user_id} "
        f"deleted {bs_result.deleted_count} blood_sugar docs, "
        f"{meal_result.deleted_count} meal docs"
    )
    return jsonify({
        "message":           "Stale libre_cgm readings purged. Run a sync to restore correct data.",
        "deleted_readings":  bs_result.deleted_count,
        "deleted_meals":     meal_result.deleted_count,
    }), 200


@libre_bp.route("/api/libre/readings", methods=["GET"])
@token_required
@api_error_handler
def get_libre_readings(current_user):
    user_id = str(current_user["_id"])
    conn    = mongo.db.libre_connections.find_one({"user_id": user_id})

    if not conn:
        return jsonify({"error": "No LibreLinkUp connection found", "code": "NOT_CONNECTED"}), 404

    sync_result = None
    if request.args.get("sync", "").lower() == "true":
        try:
            sync_result = _perform_sync(user_id, conn)
        except Exception as e:
            logger.warning(f"Sync-before-read failed: {e}")
            sync_result = {"error": str(e)}

    end_time = datetime.utcnow()
    hours    = min(int(request.args.get("hours", 24)), 168)

    start_time_str = request.args.get("start_time")
    end_time_str   = request.args.get("end_time")

    if start_time_str:
        start_time = datetime.fromisoformat(start_time_str.replace("Z", "+00:00")).replace(tzinfo=None)
    else:
        start_time = end_time - timedelta(hours=hours)

    if end_time_str:
        end_time = datetime.fromisoformat(end_time_str.replace("Z", "+00:00")).replace(tzinfo=None)

    readings = list(
        mongo.db.blood_sugar.find({
            "user_id": user_id,
            "source":  LIBRE_SOURCE_TAG,
            "bloodSugarTimestamp": {"$gte": start_time, "$lte": end_time},
        }).sort("bloodSugarTimestamp", 1)
    )

    formatted = []
    for r in readings:
        ts = r.get("bloodSugarTimestamp")
        ts_str = ts.isoformat() + "Z" if isinstance(ts, datetime) else (ts or "")
        formatted.append({
            "_id":                  str(r["_id"]),
            "bloodSugar":           r["bloodSugar"],
            "bloodSugarTimestamp":  ts_str,
            "status":               r.get("status", "unknown"),
            "trend":                r.get("trend"),
            "trend_label":          r.get("trend_label", "unknown"),
            "is_high":              r.get("is_high", False),
            "is_low":               r.get("is_low", False),
            "reading_type":         r.get("reading_type", 0),
            "source":               LIBRE_SOURCE_TAG,
        })

    return jsonify({
        "readings":    formatted,
        "count":       len(formatted),
        "synced":      sync_result is not None,
        "sync_result": sync_result,
    }), 200