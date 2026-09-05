"""
setup_libre_indexes.py
============================================================================
Run this once after deploying the LibreLinkUp integration to create
the necessary MongoDB indexes.

Usage:
    python setup_libre_indexes.py

Or call setup_indexes() from your app startup if you prefer.
============================================================================
"""

import os
import logging
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.server_api import ServerApi
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def setup_indexes():
    """Create all indexes required for the LibreLinkUp integration."""
    uri = os.environ.get("MONGO_URI")
    if not uri:
        raise ValueError("MONGO_URI not set")

    client = MongoClient(uri, server_api=ServerApi("1"))
    db = client.get_default_database()

    # ── libre_connections ────────────────────────────────────────────────────
    # One connection document per user
    db.libre_connections.create_index(
        [("user_id", ASCENDING)],
        unique=True,
        name="unique_user_libre_connection",
    )
    logger.info("✅ libre_connections: unique index on user_id")

    # ── blood_sugar ──────────────────────────────────────────────────────────
    # Deduplication: prevent the same CGM reading being inserted twice.
    # (user_id, source, bloodSugarTimestamp) must be unique for CGM readings.
    db.blood_sugar.create_index(
        [
            ("user_id",             ASCENDING),
            ("source",              ASCENDING),
            ("bloodSugarTimestamp", ASCENDING),
        ],
        unique=True,
        partialFilterExpression={"source": "libre_cgm"},
        name="unique_libre_cgm_reading",
    )
    logger.info("✅ blood_sugar: unique partial index on (user_id, source='libre_cgm', bloodSugarTimestamp)")

    # Fast query by user + time window (used by GET /api/libre/readings)
    db.blood_sugar.create_index(
        [
            ("user_id",             ASCENDING),
            ("source",              ASCENDING),
            ("bloodSugarTimestamp", DESCENDING),
        ],
        name="libre_cgm_time_range_query",
    )
    logger.info("✅ blood_sugar: compound index for CGM time range queries")

    client.close()
    logger.info("🎉 All LibreLinkUp indexes created successfully")


if __name__ == "__main__":
    setup_indexes()
