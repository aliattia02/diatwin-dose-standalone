"""
libre_service.py — LibreLinkUp Unofficial API Client
============================================================================
Integrates with the LibreLinkUp CGM sharing platform to pull blood glucose
readings from Abbott FreeStyle Libre sensors into DiaTwin.

API Reference:
  - Based on the LibreLinkUp reverse-engineered API (unofficial)
  - Compatible with LibreLinkUp app v4.7+
  - Supports all regional endpoints (EU, US, DE, FR, JP, AP, AU, AE)

Security Model:
  - Credentials are encrypted at rest using Fernet symmetric encryption
  - The encryption key is derived from the app's SECRET_KEY
  - Auth tokens are cached and refreshed automatically
  - Passwords are never returned in API responses

Data Model:
  - CGM readings are stored with source='libre_cgm' in the blood_sugar collection
  - Deduplication is enforced via (user_id, bloodSugarTimestamp) uniqueness
  - Readings are stored as mg/dL (converted from mmol/L if needed)
  - Baseline calculations are skipped for bulk CGM imports (performance)

Author: DiaTwin Team
Version: 1.0
============================================================================
"""

import requests
import logging
import os
import base64
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Tuple, Any
from cryptography.fernet import Fernet
import hashlib

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SIGN CONVENTION (mirrors constants.py and time_manager.py)
# ─────────────────────────────────────────────────────────────────────────────
# timezone_offset_minutes = local_minutes_ahead_of_UTC
#
#   Egypt   (UTC+2) → +120   ← data source / logging timezone
#   Germany (UTC+1) →  +60   ← viewer timezone
#   UTC             →    0
#
# Conversion: utc = local - offset_hours
# Code:       dt  = dt - timedelta(hours=timezone_offset_minutes / 60)
#
# NOTE: timezone_offset_minutes MUST reflect the LOGGING device's timezone
# (e.g. Egypt = +120).  The viewer's timezone offset is handled automatically
# by the browser's local Date parsing — do NOT double-apply it.
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# Regional endpoint registry
# LibreLinkUp routes logins to the correct regional server.
# On first login, a redirect (HTTP 451) may be returned containing the correct URL.
# ─────────────────────────────────────────────────────────────────────────────
LIBRE_REGIONS: Dict[str, str] = {
    "US":  "https://api.libreview.io",
    "EU":  "https://api-eu.libreview.io",
    "EU2": "https://api-eu2.libreview.io",
    "DE":  "https://api-de.libreview.io",
    "FR":  "https://api-fr.libreview.io",
    "JP":  "https://api-jp.libreview.io",
    "AP":  "https://api-ap.libreview.io",
    "AU":  "https://api-au.libreview.io",
    "AE":  "https://api-ae.libreview.io",
}

# Default base URL (EU is the most common for international users)
DEFAULT_BASE_URL = LIBRE_REGIONS["EU"]

# LibreLinkUp app headers (required — the API refuses requests without these)
LLU_HEADERS = {
    "product":         "llu.android",
    "version":         "4.16.0",
    "Content-Type": "application/json",
    "Accept":       "application/json",
    "cache-control":   "no-cache",
    "connection":      "keep-alive",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent":      "Mozilla/5.0",
}

# How long before an auth token is considered stale (tokens last ~180 days)
TOKEN_REFRESH_BUFFER_HOURS = 24

# Reading type constants from LibreLinkUp API
READING_TYPE_CGM   = 0   # Automatic CGM sensor reading
READING_TYPE_SCAN  = 1   # Manual NFC scan
READING_TYPE_STRIP = 2   # Fingerstick calibration

# ─────────────────────────────────────────────────────────────────────────────
# Encryption helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_fernet() -> Fernet:
    """
    Derive a Fernet encryption key from the app's SECRET_KEY.

    Checks in order:
      1. os.environ['SECRET_KEY']               -- production / Render deployments
      2. Flask current_app.config['SECRET_KEY'] -- local dev (set in config.py)
    """
    secret = os.environ.get("SECRET_KEY", "")

    if not secret:
        # Fallback: read from Flask app.config (used in local dev where
        # config.py hard-codes the key rather than loading from .env)
        try:
            from flask import current_app
            secret = current_app.config.get("SECRET_KEY", "")
        except RuntimeError:
            # current_app not available outside request/app context
            pass

    if not secret:
        raise RuntimeError(
            "SECRET_KEY not found in os.environ or Flask app.config. "
            "Set SECRET_KEY in your .env file or config.py."
        )

    # Fernet requires a 32-byte URL-safe base64 key
    key_bytes = hashlib.sha256(secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key_bytes))


def encrypt_credential(plaintext: str) -> str:
    """Encrypt a credential string for storage in MongoDB."""
    f = _get_fernet()
    return f.encrypt(plaintext.encode()).decode()


def decrypt_credential(ciphertext: str) -> str:
    """Decrypt a stored credential string."""
    f = _get_fernet()
    return f.decrypt(ciphertext.encode()).decode()


# ─────────────────────────────────────────────────────────────────────────────
# LibreLinkUp API Client
# ─────────────────────────────────────────────────────────────────────────────

class LibreLinkUpService:
    """
    Client for the unofficial LibreLinkUp API.

    Each instance is scoped to a single user's connection.
    Connection state is persisted in MongoDB by the route layer.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update(LLU_HEADERS)

    # ─────────────────────────────────────────────────────────────────────
    # Authentication
    # ─────────────────────────────────────────────────────────────────────

    def authenticate(self, email: str, password: str) -> Dict[str, Any]:
        """
        Authenticate with LibreLinkUp and return connection details.

        Handles the regional redirect flow automatically:
          1. Try login on current base_url
          2. If HTTP 451 returned, follow redirect to correct regional server
          3. Retry login on the correct server

        Returns:
            {
                "auth_token":   str,          # Bearer token
                "token_expires": datetime,    # When token expires
                "patient_id":   str,          # LibreLinkUp patient/connection ID
                "region":       str,          # Region code (e.g. "EU")
                "base_url":     str,          # Resolved regional base URL
                "first_name":   str,
                "last_name":    str,
                "country":      str,
            }

        Raises:
            LibreAuthError: on invalid credentials
            LibreConnectionError: on network/API failures
        """
        url = f"{self.base_url}/llu/auth/login"
        payload = {"email": email, "password": password}

        try:
            resp = self.session.post(url, json=payload, timeout=15)
        except requests.RequestException as e:
            raise LibreConnectionError(f"Network error during authentication: {e}")

        # ── Regional redirect (HTTP 451) ──────────────────────────────────
        if resp.status_code == 451:
            redirect_data = resp.json().get("data", {})
            redirect_url = redirect_data.get("redirect")
            if redirect_url:
                # The redirect URL itself is the new base URL
                # e.g. "https://api-eu.libreview.io"
                self.base_url = redirect_url.rstrip("/")
                logger.info(f"LibreLinkUp regional redirect → {self.base_url}")
                return self.authenticate(email, password)
            raise LibreConnectionError("Got HTTP 451 but no redirect URL in response")

        # ── Authentication error ──────────────────────────────────────────
        if resp.status_code == 401 or resp.status_code == 403:
            raise LibreAuthError("Invalid LibreLinkUp email or password")

        if not resp.ok:
            raise LibreConnectionError(
                f"LibreLinkUp login failed: HTTP {resp.status_code} — {resp.text[:200]}"
            )

        body = resp.json()
        logger.debug(f"LibreLinkUp login response data keys: {list(body.get('data', {}).keys())}")

        if body.get("status") != 0:
            raise LibreAuthError(
                f"LibreLinkUp login rejected (status={body.get('status')}): "
                f"{body.get('error', {}).get('message', 'Unknown error')}"
            )

        data = body.get("data", {})

        # Data-level redirect: status=0 but data={"redirect": true, "region": "XY"}
        if data.get("redirect") is True or isinstance(data.get("redirect"), str):
            redirect_region = data.get("region", "").upper()
            redirect_url = data.get("redirectUrl", "") or LIBRE_REGIONS.get(redirect_region, "")
            if redirect_url:
                self.base_url = redirect_url.rstrip("/")
                logger.info(f"LibreLinkUp data-redirect → {self.base_url} (region={redirect_region})")
                return self.authenticate(email, password)
            raise LibreConnectionError(f"LibreLinkUp redirect=true but no target URL. data={data}")

        # Terms-of-use step
        if "authTicket" not in data:
            step = data.get("step", "")
            if step or "tou" in str(data).lower() or "terms" in str(data).lower():
                raise LibreAuthError(
                    "LibreLinkUp requires you to accept the Terms of Use. "
                    "Open the official LibreLinkUp app, log in, accept any pending terms, then retry."
                )
            raise LibreAuthError(
                f"LibreLinkUp login: unexpected response (no authTicket). "
                f"data keys={list(data.keys())}. data={str(data)[:300]}"
            )

        auth_ticket = data["authTicket"]
        token       = auth_ticket["token"]
        expires_ts  = auth_ticket.get("expires")
        duration    = auth_ticket.get("duration", 15552000)  # default 180 days

        if expires_ts:
            token_expires = datetime.utcfromtimestamp(expires_ts)
        else:
            token_expires = datetime.utcnow() + timedelta(seconds=duration)

        # Extract account ID (needed for connections/readings headers)
        raw_account_id = data.get("user", {}).get("id", "") or data.get("accountId", "")

        # Fetch connections to get the patient_id
        connections = self._get_connections(token, account_id=raw_account_id)
        if not connections:
            raise LibreConnectionError(
                "Authentication succeeded but no LibreLinkUp connections found. "
                "Make sure you have a follower/sharing connection set up in the LibreLinkUp app."
            )

        # Use the first (primary) connection
        primary = connections[0]
        patient_id = primary.get("patientId") or primary.get("id", "")

        # Determine region code from base URL
        region = self._region_from_url(self.base_url)

        return {
            "auth_token":    token,
            "token_expires": token_expires,
            "patient_id":    patient_id,
            "account_id":    raw_account_id,
            "region":        region,
            "base_url":      self.base_url,
            "first_name":    primary.get("firstName", ""),
            "last_name":     primary.get("lastName", ""),
            "country":       primary.get("country", ""),
            "target_low":    primary.get("targetLow"),
            "target_high":   primary.get("targetHigh"),
            "all_connections": [
                {
                    "patient_id": c.get("patientId") or c.get("id"),
                    "first_name": c.get("firstName", ""),
                    "last_name":  c.get("lastName", ""),
                    "country":    c.get("country", ""),
                }
                for c in connections
            ],
        }

    # ─────────────────────────────────────────────────────────────────────
    # Connections
    # ─────────────────────────────────────────────────────────────────────

    def _get_connections(self, token: str, account_id: str = "") -> List[Dict]:
        """Internal: fetch the list of LibreLinkUp connections using a token."""
        url = f"{self.base_url}/llu/connections"
        headers = {**LLU_HEADERS, "Authorization": f"Bearer {token}"}
        if account_id:
            import hashlib
            headers["account-id"] = hashlib.sha256(account_id.encode()).hexdigest()

        try:
            resp = self.session.get(url, headers=headers, timeout=15)
        except requests.RequestException as e:
            raise LibreConnectionError(f"Network error fetching connections: {e}")

        if resp.status_code == 403:
            raise LibreConnectionError(
                f"LibreLinkUp connections endpoint returned 403. "
                f"Verify the patient has shared their sensor in the LibreLinkUp app."
            )

        if not resp.ok:
            raise LibreConnectionError(
                f"Failed to fetch connections: HTTP {resp.status_code} — {resp.text[:200]}"
            )

        body = resp.json()
        if body.get("status") != 0:
            raise LibreConnectionError(
                f"Connections endpoint error (status={body.get('status')})"
            )

        return body.get("data", []) or []

    def get_connections(self, token: str) -> List[Dict]:
        """Public: get list of all LibreLinkUp connections for this account."""
        raw = self._get_connections(token)
        return [
            {
                "patient_id": c.get("patientId") or c.get("id"),
                "first_name": c.get("firstName", ""),
                "last_name":  c.get("lastName", ""),
                "country":    c.get("country", ""),
                "status":     c.get("status"),
            }
            for c in raw
        ]

    # ─────────────────────────────────────────────────────────────────────
    # Reading retrieval
    # ─────────────────────────────────────────────────────────────────────

    def get_latest_reading(
        self,
        token: str,
        patient_id: str,
        account_id: str = "",
        utc_offset_hours: float = 0.0,
    ) -> Optional[Dict]:
        """
        Get the most recent glucose reading for a connection.
        Uses the /llu/connections/{id}/graph endpoint which returns
        the last ~8 hours of readings.

        Args:
            utc_offset_hours: Patient's UTC offset in hours (e.g. 2.0 for UTC+2).
                Must match the value used in _perform_sync — derive from
                patient_constants['timezone_offset_minutes'] / 60.
                Defaults to 0.0 (UTC). Passing the wrong value here causes
                duplicate readings in the DB (the zigzag chart bug).
        """
        readings = self.get_readings(
            token, patient_id,
            account_id=account_id,
            utc_offset_hours=utc_offset_hours,
        )
        if not readings:
            return None
        return readings[-1]  # Last entry is most recent

    def get_readings(
        self,
        token: str,
        patient_id: str,
        include_scans: bool = True,
        account_id: str = "",
        utc_offset_hours: float = 0.0,
    ) -> List[Dict]:
        """
        Fetch graph data (last ~8 hours of readings) for a connection.

        Args:
            utc_offset_hours: Patient's UTC offset in hours (e.g. 2.0 for UTC+2).
                Derive from patient_constants['timezone_offset_minutes'] / 60.
                Defaults to 0.0 (UTC) — callers must supply the correct value;
                the old hardcoded default of +2 (Egypt) was removed in I-8.

        Returns a list of normalized reading dicts:
            {
                "value_mgdl":  int,          # Blood glucose in mg/dL
                "timestamp":   datetime,     # UTC datetime
                "reading_type": int,         # 0=CGM, 1=scan, 2=strip
                "is_high":     bool,
                "is_low":      bool,
                "trend":       Optional[int], # 1–5 trend arrow (if present)
            }
        """
        url = f"{self.base_url}/llu/connections/{patient_id}/graph"
        headers = {**LLU_HEADERS, "Authorization": f"Bearer {token}"}
        if account_id:
            import hashlib
            headers["account-id"] = hashlib.sha256(account_id.encode()).hexdigest()

        try:
            resp = self.session.get(url, headers=headers, timeout=15)
        except requests.RequestException as e:
            raise LibreConnectionError(f"Network error fetching readings: {e}")

        if resp.status_code == 401:
            raise LibreTokenExpiredError("Auth token expired — re-authentication required")

        if not resp.ok:
            raise LibreConnectionError(
                f"Failed to fetch readings: HTTP {resp.status_code} — {resp.text[:200]}"
            )

        body = resp.json()
        if body.get("status") != 0:
            raise LibreConnectionError(
                f"Readings endpoint error (status={body.get('status')})"
            )

        graph_data = body.get("data", {}).get("graphData", []) or []
        normalized = []

        for entry in graph_data:
            reading_type = entry.get("type", READING_TYPE_CGM)
            if not include_scans and reading_type == READING_TYPE_SCAN:
                continue

            value_mgdl = self._extract_mgdl(entry)
            if value_mgdl is None:
                continue

            # Prefer FactoryTimestamp — LibreLinkUp documents this as UTC.
            # Fall back to Timestamp (local AM/PM format) only if absent,
            # applying utc_offset_hours to convert local → UTC.
            factory_ts = entry.get("FactoryTimestamp")
            local_ts   = entry.get("Timestamp")
            if factory_ts:
                timestamp = self._parse_libre_timestamp(
                    factory_ts, utc_offset_hours=0.0  # already UTC
                )
            else:
                timestamp = self._parse_libre_timestamp(
                    local_ts, utc_offset_hours=utc_offset_hours
                )
            if timestamp is None:
                continue

            normalized.append({
                "value_mgdl":   value_mgdl,
                "timestamp":    timestamp,
                "reading_type": reading_type,
                "is_high":      bool(entry.get("isHigh", False)),
                "is_low":       bool(entry.get("isLow", False)),
                "trend":        entry.get("TrendArrow"),
                "raw":          entry,  # Keep original for debugging
            })

        # Sort ascending by time
        normalized.sort(key=lambda r: r["timestamp"])
        return normalized

    # ─────────────────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _extract_mgdl(entry: Dict) -> Optional[int]:
        """Extract mg/dL value, converting from mmol/L if necessary."""
        # Direct mg/dL field
        if "ValueInMgPerDl" in entry and entry["ValueInMgPerDl"] is not None:
            return int(round(entry["ValueInMgPerDl"]))

        # mmol/L field (GlucoseUnits=1 means mmol/L)
        value = entry.get("Value")
        if value is None:
            return None

        glucose_units = entry.get("GlucoseUnits", 0)
        if glucose_units == 1:
            # Convert mmol/L → mg/dL
            return int(round(float(value) * 18.0182))

        # Assume mg/dL if units unclear but value > 35 (plausible mg/dL)
        if float(value) > 35:
            return int(round(float(value)))

        # Value looks like mmol/L even though units says 0
        return int(round(float(value) * 18.0182))

    @staticmethod
    def _parse_libre_timestamp(ts_str: Optional[str], utc_offset_hours: float = 0.0) -> Optional[datetime]:
        """
        Parse LibreLinkUp timestamp strings and convert to UTC.

        The API returns timestamps in the patient's LOCAL time (not UTC).
        utc_offset_hours must be supplied by the caller — derive it from
        patient_constants['timezone_offset_minutes'] / 60.

        Default is 0.0 (UTC) as a safe no-op; the old default of +2.0
        (Egypt Standard Time) was removed in fix I-8 to support all patients.

        SIGN CONVENTION: positive = east of UTC (e.g. Egypt UTC+2 = +2.0).
        Formula: utc_datetime = local_datetime - timedelta(hours=utc_offset_hours)
        """
        if not ts_str:
            return None

        # ── Validation / diagnostic logging ──────────────────────────────────
        # Always log the raw string and the offset being applied so timestamp
        # drift can be diagnosed from the server logs without guessing.
        logger.debug(
            f"_parse_libre_timestamp: raw={ts_str!r}, utc_offset_hours={utc_offset_hours}"
        )

        # Guard: offset of exactly 0 almost certainly means the patient constant
        # was never configured (default value) rather than genuinely being in UTC.
        # A real UTC patient is rare; any real-world patient returning UTC+2 data
        # will silently get a 2-hour shift if this goes unnoticed.
        if utc_offset_hours == 0:
            logger.warning(
                f"_parse_libre_timestamp: utc_offset_hours=0 — timestamps will be "
                f"stored AS-IS (no UTC conversion). If the patient is NOT in UTC, "
                f"set timezone_offset_minutes in patient constants "
                f"(positive = east of UTC, e.g. Egypt UTC+2 = 120)."
            )

        formats = [
            ("%m/%d/%Y %I:%M:%S %p", True),   # 1/15/2025 2:30:00 PM  — local
            ("%m/%d/%Y %H:%M:%S",    True),    # 1/15/2025 14:30:00    — local
            ("%Y-%m-%dT%H:%M:%S",    True),    # ISO 8601 naive        — local
            ("%Y-%m-%dT%H:%M:%SZ",   False),   # ISO 8601 with Z       — already UTC
        ]

        for fmt, is_local in formats:
            try:
                dt = datetime.strptime(ts_str, fmt)
                if is_local:
                    dt = dt - timedelta(hours=utc_offset_hours)
                logger.debug(
                    f"_parse_libre_timestamp: parsed {ts_str!r} → UTC {dt.isoformat()} "
                    f"(offset_applied={utc_offset_hours if is_local else 0})"
                )
                return dt
            except ValueError:
                continue

        logger.warning(f"Could not parse LibreLinkUp timestamp: {ts_str!r}")
        return None

    @staticmethod
    def _region_from_url(url: str) -> str:
        """Map a base URL back to its region code."""
        for region, base in LIBRE_REGIONS.items():
            if url.rstrip("/") == base.rstrip("/"):
                return region
        return "EU"  # Fallback


# ─────────────────────────────────────────────────────────────────────────────
# Custom Exceptions
# ─────────────────────────────────────────────────────────────────────────────

class LibreAuthError(Exception):
    """Invalid credentials or authentication rejected."""

class LibreTokenExpiredError(Exception):
    """Auth token has expired — re-authentication needed."""

class LibreConnectionError(Exception):
    """Network or API-level error."""