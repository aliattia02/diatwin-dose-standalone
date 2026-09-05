"""
watch_sync_service.py — Google Fit REST API OAuth + HR Polling Service
==============================================================================
Mirrors libre_service.py exactly in structure:

  connect()   — exchange OAuth code for tokens, store in watch_connections
  _perform_sync() — poll Google Fit, run autosegmentation, save to activities

Google Fit REST API reference:
  https://developers.google.com/fit/rest/v1/reference/users/dataset/aggregate

OAuth scopes required:
  https://www.googleapis.com/auth/fitness.heart_rate.read
  https://www.googleapis.com/auth/fitness.activity.read

Env vars needed (add to .env / Render):
  GOOGLE_CLIENT_ID       — from Google Cloud Console OAuth 2.0 client
  GOOGLE_CLIENT_SECRET   — from Google Cloud Console OAuth 2.0 client
  GOOGLE_REDIRECT_URI    — must match what is registered in Google Cloud Console
                           For mobile deep-link: com.diatwin.mobile://auth/watch
                           For web:              https://<your-domain>/auth/watch/callback

Author: DiaTwin Team
==============================================================================
"""

import logging
import os
import time
from datetime import datetime, timedelta, timezone

import requests
from pymongo.errors import DuplicateKeyError

logger = logging.getLogger(__name__)

# ── Google OAuth constants ────────────────────────────────────────────────────
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_FIT_AGGREGATE_URL = (
    "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate"
)

# Google Fit data source ID for heart rate
HR_DATA_TYPE = "com.google.heart_rate.bpm"

# How far back to fetch on each sync (minutes)
SYNC_WINDOW_MINUTES = 60

# Hard cap: never ingest more than this many HR samples in one sync call
MAX_HR_SAMPLES_PER_SYNC = 3_600   # 1 Hz × 60 min


# ─────────────────────────────────────────────────────────────────────────────
# 1. OAuth helpers
# ─────────────────────────────────────────────────────────────────────────────

def _client_id() -> str:
    v = os.environ.get("GOOGLE_CLIENT_ID", "")
    if not v:
        raise EnvironmentError("GOOGLE_CLIENT_ID is not set")
    return v


def _client_secret() -> str:
    v = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not v:
        raise EnvironmentError("GOOGLE_CLIENT_SECRET is not set")
    return v


def _redirect_uri() -> str:
    return os.environ.get(
        "GOOGLE_REDIRECT_URI",
        "com.diatwin.mobile://auth/watch",  # mobile deep-link default
    )


def exchange_auth_code(code: str) -> dict:
    """
    Exchange a Google OAuth authorisation code for access + refresh tokens.
    Called once from POST /api/watch/connect.

    Returns dict with keys:
        access_token, refresh_token, expires_in, token_type, scope
    Raises ValueError on failure.
    """
    resp = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "code":          code,
            "client_id":     _client_id(),
            "client_secret": _client_secret(),
            "redirect_uri":  _redirect_uri(),
            "grant_type":    "authorization_code",
        },
        timeout=15,
    )

    if not resp.ok:
        detail = resp.json().get("error_description") or resp.text
        raise ValueError(f"Google token exchange failed: {detail}")

    return resp.json()


def refresh_access_token(refresh_token: str) -> dict:
    """
    Use a stored refresh_token to obtain a new short-lived access_token.
    Returns updated token dict; raises ValueError on failure.
    """
    resp = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "refresh_token": refresh_token,
            "client_id":     _client_id(),
            "client_secret": _client_secret(),
            "grant_type":    "refresh_token",
        },
        timeout=15,
    )

    if not resp.ok:
        detail = resp.json().get("error_description") or resp.text
        raise ValueError(f"Google token refresh failed: {detail}")

    return resp.json()


def _ensure_valid_token(conn: dict) -> str:
    """
    Check whether the stored access_token is still valid.
    Refresh it if it is expired or within 5 minutes of expiry.

    Returns the current valid access_token string.
    Raises ValueError if refresh fails.
    """
    from config import mongo  # late import to avoid circular dependency

    expires_at = conn.get("token_expires_at")
    now_ts = time.time()

    needs_refresh = (
        expires_at is None
        or now_ts >= (float(expires_at) - 300)   # 5-min safety margin
    )

    if not needs_refresh:
        return conn["access_token"]

    refresh_token = conn.get("refresh_token")
    if not refresh_token:
        raise ValueError("No refresh_token stored — user must reconnect.")

    new_tokens = refresh_access_token(refresh_token)

    # Compute new expiry timestamp
    expires_in = int(new_tokens.get("expires_in", 3600))
    new_expires_at = now_ts + expires_in

    # Persist updated tokens
    mongo.db.watch_connections.update_one(
        {"user_id": conn["user_id"]},
        {
            "$set": {
                "access_token":     new_tokens["access_token"],
                "token_expires_at": new_expires_at,
                # refresh_token is only returned by Google when it changes
                **(
                    {"refresh_token": new_tokens["refresh_token"]}
                    if "refresh_token" in new_tokens
                    else {}
                ),
            }
        },
    )

    logger.debug("[watch_sync] access_token refreshed for user=%s", conn["user_id"])
    return new_tokens["access_token"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. Google Fit HR data fetch
# ─────────────────────────────────────────────────────────────────────────────

def fetch_google_fit_hr(
    access_token: str,
    since: datetime,
    until: datetime | None = None,
) -> list[dict]:
    """
    Poll Google Fit Dataset.aggregate for heart_rate.bpm between *since* and
    *until* (defaults to now UTC).

    Returns a list of samples in the format expected by segment_hr_stream():
        [{"timestamp_iso": "<ISO-8601>", "hr_bpm": <float>}, ...]

    Raises requests.HTTPError on HTTP failure.
    """
    if until is None:
        until = datetime.now(timezone.utc)

    # Google Fit uses nanoseconds since epoch
    start_ns = int(since.timestamp() * 1_000_000_000)
    end_ns   = int(until.timestamp() * 1_000_000_000)

    payload = {
        "aggregateBy": [{"dataTypeName": HR_DATA_TYPE}],
        "bucketByTime": {"durationMillis": 60_000},  # 1-min buckets
        "startTimeMillis": start_ns // 1_000_000,
        "endTimeMillis":   end_ns   // 1_000_000,
    }

    resp = requests.post(
        GOOGLE_FIT_AGGREGATE_URL,
        json=payload,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    resp.raise_for_status()

    buckets = resp.json().get("bucket", [])
    samples = []

    for bucket in buckets:
        # Each bucket contains a dataset list
        for dataset in bucket.get("dataset", []):
            for point in dataset.get("point", []):
                # startTimeNanos is the bucket start
                ts_ns  = int(point.get("startTimeNanos", 0))
                values = point.get("value", [])

                if not values or ts_ns == 0:
                    continue

                # Google Fit fpVal = float heart rate average in bucket
                hr_val = values[0].get("fpVal")
                if hr_val is None:
                    continue

                hr_bpm = round(float(hr_val), 1)
                if hr_bpm < 20 or hr_bpm > 300:
                    continue

                ts_dt = datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=timezone.utc)
                samples.append({
                    "timestamp_iso": ts_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "hr_bpm":        hr_bpm,
                })

    # Safety cap
    if len(samples) > MAX_HR_SAMPLES_PER_SYNC:
        logger.warning(
            "[watch_sync] fetch returned %d samples — capping at %d",
            len(samples), MAX_HR_SAMPLES_PER_SYNC,
        )
        samples = samples[-MAX_HR_SAMPLES_PER_SYNC:]

    return samples


def fetch_google_user_info(access_token: str) -> dict:
    """Return basic profile info (name, email) from Google's userinfo endpoint."""
    resp = requests.get(
        GOOGLE_USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────────
# 3. Core sync — mirrors libre_service._perform_sync()
# ─────────────────────────────────────────────────────────────────────────────

def _perform_sync(user_id: str, conn: dict) -> dict:
    """
    Fetch HR data from Google Fit and run the autosegmenter.
    Saves resulting activity sessions to the activities collection.

    Returns:
        {
          "new_count":     int,   # sessions created
          "skipped_count": int,   # samples that fell below sedentary threshold
          "latest_session": dict | None
        }
    """
    from config import mongo
    from utils.watch_hr_autosegment import segment_hr_stream, session_to_activity_doc

    # 1. Ensure we have a live access token
    access_token = _ensure_valid_token(conn)

    # 2. Determine fetch window
    last_sync = conn.get("last_sync")
    if last_sync:
        if isinstance(last_sync, str):
            # Replace trailing Z with +00:00 so fromisoformat returns a
            # timezone-aware datetime (UTC).  Bare strip was brittle — it
            # produced a naive datetime that compared incorrectly against
            # timezone-aware datetimes from datetime.now(timezone.utc).
            last_sync = datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
        elif isinstance(last_sync, datetime) and last_sync.tzinfo is None:
            # Defensive: treat naive datetimes stored by older code as UTC
            last_sync = last_sync.replace(tzinfo=timezone.utc)
        # Always overlap by 5 min to avoid gap on clock skew
        since = last_sync - timedelta(minutes=5)
    else:
        since = datetime.now(timezone.utc) - timedelta(minutes=SYNC_WINDOW_MINUTES)

    until = datetime.now(timezone.utc)

    # 3. Fetch HR samples from Google Fit
    samples = fetch_google_fit_hr(access_token, since=since, until=until)

    if not samples:
        logger.debug("[watch_sync] user=%s — no HR samples in window", user_id)
        # Still update last_sync so we don't re-fetch stale windows forever
        mongo.db.watch_connections.update_one(
            {"user_id": user_id},
            {"$set": {"last_sync": until.strftime("%Y-%m-%dT%H:%M:%SZ")}},
        )
        return {"new_count": 0, "skipped_count": 0,
                "duplicate_count": 0, "latest_session": None}

    # 4. Run autosegmentation — identical to upload_continuous_hr endpoint
    config_override = conn.get("autosegment_config", {})
    sessions = segment_hr_stream(
        samples=samples,
        base_time=None,         # samples carry timestamp_iso
        config_override=config_override,
    )

    skipped = len(samples) - sum(s["sample_count"] for s in sessions)

    # 5. Persist sessions
    created = []
    duplicates = 0
    for sess in sessions:
        doc = session_to_activity_doc(sess, user_id, bg_direction=-1)
        doc["source"] = "google_fit"   # tag so UI can distinguish

        # Apply patient-level HR overrides if stored in connection
        if conn.get("hr_base"):
            doc["hr_base"] = float(conn["hr_base"])
        if conn.get("hr_max"):
            doc["hr_max"] = float(conn["hr_max"])

        # D19: the fetch window deliberately overlaps the previous one by five
        # minutes to survive clock skew, so any bout inside that overlap is
        # re-segmented on the next cycle and would otherwise be written again.
        # Unlike the CGM path there was no guard and no unique index, so this
        # duplicated on every cycle rather than only under a race.
        #
        # A session is identified by (user, source, start_time): the segmenter
        # is deterministic, so the same bout re-segmented yields the same start.
        existing = mongo.db.activities.find_one({
            "user_id":   user_id,
            "source":    "google_fit",
            "startTime": doc["startTime"],
        })
        if existing:
            duplicates += 1
            logger.debug(
                "[watch_sync] user=%s — session at %s already stored, skipping",
                user_id, doc["startTime"],
            )
            continue

        try:
            result = mongo.db.activities.insert_one(doc)
            created.append({
                "session_id":       str(result.inserted_id),
                "intensity":        sess["intensity"],
                "start_time":       sess["start_time"].isoformat(),
                "duration_minutes": sess["duration_minutes"],
            })
        except DuplicateKeyError:
            # `unique_google_fit_session` caught what the find_one above raced
            # past — two workers syncing one user at once. Losing that race
            # means the other worker stored it, which is the same skip.
            duplicates += 1
            logger.debug(
                "[watch_sync] user=%s — session at %s stored concurrently, skipping",
                user_id, doc["startTime"],
            )
        except Exception as insert_err:
            logger.warning("[watch_sync] insert failed: %s", insert_err)

    # 6. Update last_sync timestamp
    mongo.db.watch_connections.update_one(
        {"user_id": user_id},
        {"$set": {"last_sync": until.strftime("%Y-%m-%dT%H:%M:%SZ")}},
    )

    latest = created[-1] if created else None
    logger.info(
        "[watch_sync] user=%s — %d sessions created from %d samples "
        "(%d already stored)",
        user_id, len(created), len(samples), duplicates,
    )

    return {
        "new_count":       len(created),
        "skipped_count":   skipped,
        "duplicate_count": duplicates,
        "latest_session":  latest,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. Connect — called once from POST /api/watch/connect
# ─────────────────────────────────────────────────────────────────────────────

def connect_watch(user_id: str, auth_code: str) -> dict:
    """
    Full connect flow:
      1. Exchange auth code for tokens
      2. Fetch Google profile
      3. Upsert watch_connections document
      4. Run first sync immediately

    Returns a summary dict for the API response.
    """
    from config import mongo

    # Exchange code
    tokens = exchange_auth_code(auth_code)

    access_token  = tokens["access_token"]
    refresh_token = tokens.get("refresh_token")
    expires_in    = int(tokens.get("expires_in", 3600))
    expires_at    = time.time() + expires_in

    if not refresh_token:
        # Without refresh_token the connection is useless after 1 hour
        raise ValueError(
            "Google did not return a refresh_token. "
            "Make sure access_type=offline and prompt=consent are in the auth URL."
        )

    # Fetch profile
    try:
        profile = fetch_google_user_info(access_token)
    except Exception as e:
        logger.warning("[watch_sync] could not fetch user profile: %s", e)
        profile = {}

    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    conn_doc = {
        "user_id":          user_id,
        "access_token":     access_token,
        "refresh_token":    refresh_token,
        "token_expires_at": expires_at,
        "google_email":     profile.get("email"),
        "google_name":      profile.get("name"),
        "auto_sync_enabled":    True,
        "sync_interval_minutes": 15,
        "connected_at":     now_iso,
        "last_sync":        None,
    }

    mongo.db.watch_connections.update_one(
        {"user_id": user_id},
        {"$set": conn_doc},
        upsert=True,
    )

    # Initial sync
    conn_doc_stored = mongo.db.watch_connections.find_one({"user_id": user_id})
    try:
        sync_result = _perform_sync(user_id, conn_doc_stored)
    except Exception as e:
        logger.warning("[watch_sync] initial sync failed (non-fatal): %s", e)
        sync_result = {"new_count": 0, "skipped_count": 0, "latest_session": None}

    return {
        "google_email": profile.get("email"),
        "google_name":  profile.get("name"),
        "sync_result":  sync_result,
    }