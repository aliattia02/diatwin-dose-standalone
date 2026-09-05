"""
setup_libre_indexes.py
============================================================================
Create the MongoDB indexes the LibreLinkUp integration depends on.

    python setup_libre_indexes.py

You do NOT normally need to run this: `create_app()` calls `ensure_indexes()`
at startup and `create_index` is idempotent. Run it when you want a failure to
stop you rather than land in a log — it uses strict=True, so a unique index
blocked by existing duplicates exits non-zero instead of being reported and
skipped.

The index definitions live in `db_indexes.py`, once, so the app and this script
cannot drift apart.
============================================================================
"""

import logging
import os
import sys

from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.server_api import ServerApi

from db_indexes import LIBRE_INDEXES, ensure_indexes

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def setup_indexes():
    """Create all indexes required for the LibreLinkUp integration."""
    uri = os.environ.get("MONGO_URI")
    if not uri:
        raise ValueError("MONGO_URI not set")

    client = MongoClient(uri, server_api=ServerApi("1"))
    try:
        result = ensure_indexes(client.get_default_database(),
                                LIBRE_INDEXES, strict=True)
        logger.info("All LibreLinkUp indexes created successfully")
        return result
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(0 if setup_indexes().ok else 1)
