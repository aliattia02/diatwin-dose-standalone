"""
libre_scheduler.py — Background Auto-Sync Scheduler for LibreLinkUp
============================================================================
Runs a background APScheduler job inside the Flask process that:

  1. Every SCHEDULER_INTERVAL_MINUTES, finds all users with:
       auto_sync_enabled = True
       AND last_sync is None OR older than their sync_interval_minutes

  2. Calls _perform_sync() for each eligible user (the same logic as
     POST /api/libre/sync), saving new CGM readings to blood_sugar + meals.

  3. Acts as a FREE-TIER KEEP-ALIVE for Render.com — the scheduler fires
     every few minutes, preventing the dyno from spinning down.

Usage (add to main.py, after blueprints are registered):

    from libre_scheduler import start_libre_scheduler
    start_libre_scheduler(app)

Requirements:
    pip install APScheduler>=3.10

Author: DiaTwin Team
============================================================================
"""

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

# How often the scheduler wakes up and checks for due syncs.
# Keep this ≤ the shortest sync_interval_minutes any user sets (default 5 min).
# Also acts as the Render keep-alive ping interval.
SCHEDULER_INTERVAL_MINUTES = 4   # Wake up every 4 minutes

# Hard cap: never hammer the Libre API more often than this per user
MIN_SYNC_INTERVAL_MINUTES = 4


def _ping_self():
    """
    Make a real outbound HTTP GET to our own /api/health endpoint.

    WHY THIS EXISTS:
    APScheduler jobs run inside the process — Render does NOT count them
    as external traffic. The free-tier hibernation timer only resets on
    real inbound HTTP requests to the public URL. Without this ping,
    the instance sleeps after 15 minutes of user inactivity even though
    the scheduler is running, causing 503 hibernate-wake-errors on cron jobs.
    """
    import os
    try:
        import requests as _requests
        url = os.environ.get(
            'RENDER_EXTERNAL_URL',
            'https://native-3y3j.onrender.com'
        ).rstrip('/')
        _requests.get(f"{url}/api/health", timeout=10)
        logger.debug("LibreScheduler: keep-alive ping sent")
    except Exception as ping_err:
        logger.debug(f"LibreScheduler: keep-alive ping failed (non-fatal): {ping_err}")


def _run_auto_syncs(app):
    """
    Core job function executed by APScheduler.
    Runs inside a Flask app context so mongo / config are available.
    """
    # Ping our own public URL FIRST — this resets Render's hibernation timer.
    # Without this, APScheduler jobs are invisible to Render and the instance
    # sleeps after 15 minutes of user inactivity despite the scheduler running.
    _ping_self()

    with app.app_context():
        try:
            from config import mongo
            from routes.libre_routes import _perform_sync

            now = datetime.utcnow()

            # Find all connections where auto-sync is enabled
            connections = list(
                mongo.db.libre_connections.find({"auto_sync_enabled": True})
            )

            if not connections:
                logger.debug("LibreScheduler: no users with auto_sync_enabled=True")
                return

            synced_users = 0
            for conn in connections:
                user_id = conn.get("user_id", "")
                if not user_id:
                    continue

                # Determine how often this user wants syncs (minimum enforced)
                interval_min = max(
                    conn.get("sync_interval_minutes", 5),
                    MIN_SYNC_INTERVAL_MINUTES,
                )

                last_sync = conn.get("last_sync")
                if last_sync:
                    if isinstance(last_sync, str):
                        last_sync = datetime.fromisoformat(last_sync.replace("Z", ""))
                    due_at = last_sync + timedelta(minutes=interval_min)
                    if now < due_at:
                        # Not due yet for this user — skip quietly
                        continue

                # Sync is due — run it
                try:
                    result = _perform_sync(user_id, conn)
                    synced_users += 1
                    logger.info(
                        f"LibreScheduler ✓ user={user_id} "
                        f"new={result['new_count']} skipped={result['skipped_count']}"
                    )
                except Exception as user_err:
                    # Don't let one user's error stop other users' syncs
                    logger.warning(
                        f"LibreScheduler ✗ user={user_id} error: {user_err}"
                    )

            if synced_users:
                logger.info(f"LibreScheduler: synced {synced_users} user(s)")

        except Exception as e:
            logger.error(f"LibreScheduler: unexpected error in job: {e}", exc_info=True)


def start_libre_scheduler(app) -> BackgroundScheduler:
    """
    Create and start the background scheduler.
    Call this ONCE in create_app(), after all blueprints are registered.

    Returns the scheduler instance (useful for testing / graceful shutdown).
    """
    scheduler = BackgroundScheduler(
        job_defaults={
            "coalesce": True,          # Merge missed runs into one
            "max_instances": 1,        # Never run two sync jobs in parallel
            "misfire_grace_time": 60,  # If delayed up to 60 s, still run
        },
        timezone="UTC",
    )

    scheduler.add_job(
        func=_run_auto_syncs,
        args=[app],
        trigger=IntervalTrigger(minutes=SCHEDULER_INTERVAL_MINUTES),
        id="libre_auto_sync",
        name="LibreLinkUp Auto-Sync + Render Keep-Alive",
        replace_existing=True,
    )

    scheduler.start()
    logger.info(
        f"✅ LibreScheduler started — polling every {SCHEDULER_INTERVAL_MINUTES} min "
        f"(also keeps Render free tier alive)"
    )
    return scheduler