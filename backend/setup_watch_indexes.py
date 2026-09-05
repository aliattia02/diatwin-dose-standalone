"""
setup_watch_indexes.py
==============================================================================
Run once after deploying the Google Fit integration to create MongoDB indexes.

Usage:
    python setup_watch_indexes.py

==============================================================================
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
    uri = os.environ.get("MONGO_URI")
    if not uri:
        raise ValueError("MONGO_URI not set")

    client = MongoClient(uri, server_api=ServerApi("1"))
    db = client.get_default_database()

    # ── watch_connections ─────────────────────────────────────────────────────
    # One connection doc per user (same pattern as libre_connections)
    db.watch_connections.create_index(
        [("user_id", ASCENDING)],
        unique=True,
        name="unique_user_watch_connection",
    )
    logger.info("✅ watch_connections: unique index on user_id")

    # ── activities (google_fit source) ────────────────────────────────────────
    # Fast queries filtered by source + user + time
    db.activities.create_index(
        [
            ("user_id",  ASCENDING),
            ("source",   ASCENDING),
            ("startTime", DESCENDING),
        ],
        name="google_fit_activities_time_range",
    )
    logger.info("✅ activities: compound index for google_fit time range queries")

    client.close()
    logger.info("🎉 All Watch Sync indexes created successfully")


if __name__ == "__main__":
    setup_indexes()
