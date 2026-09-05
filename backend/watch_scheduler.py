"""
watch_scheduler.py — Background Auto-Sync Scheduler for Google Fit HR
==============================================================================
Mirrors libre_scheduler.py exactly.

Every SCHEDULER_INTERVAL_MINUTES:
  1. Sends a keep-alive ping to prevent Render free-tier hibernation.
  2. Finds all watch_connections where auto_sync_enabled=True and a sync
     is due (based on sync_interval_minutes per user).
  3. Calls _perform_sync() from watch_sync_service.py — which polls
     Google Fit → runs segment_hr_stream() → writes activity docs.

Usage (add to main.py after blueprints are registered):

    from watch_scheduler import start_watch_scheduler
    start_watch_scheduler(app)

Requirements:
    pip install APScheduler>=3.10 requests

Author: DiaTwin Team
==============================================================================
"""

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

# Wake up every 15 minutes — Google Fit 1-min bucket granularity means
# polling more often gives no benefit; every 15 min is fine for activity PD.
SCHEDULER_INTERVAL_MINUTES = 15

# Never sync a single user more often than this
MIN_SYNC_INTERVAL_MINUTES = 15


def _ping_self():
    """
    Identical to libre_scheduler._ping_self() — keeps Render free tier alive.
    APScheduler jobs are invisible to Render's hibernation timer; only a real
    inbound HTTP request resets the clock.
    """
    import os
    try:
        import requests as _requests
        url = os.environ.get(
            "RENDER_EXTERNAL_URL",
            "https://native-3y3j.onrender.com",
        ).rstrip("/")
        _requests.get(f"{url}/api/health", timeout=10)
        logger.debug("WatchScheduler: keep-alive ping sent")
    except Exception as e:
        logger.debug("WatchScheduler: keep-alive ping failed (non-fatal): %s", e)


def _run_watch_syncs(app):
    """
    Core APScheduler job — runs inside a Flask app context.
    """
    _ping_self()

    with app.app_context():
        try:
            from config import mongo
            from services.watch_sync_service import _perform_sync

            now = datetime.utcnow()

            connections = list(
                mongo.db.watch_connections.find({"auto_sync_enabled": True})
            )

            if not connections:
                logger.debug("WatchScheduler: no users with auto_sync_enabled=True")
                return

            synced_users = 0
            for conn in connections:
                user_id = conn.get("user_id", "")
                if not user_id:
                    continue

                interval_min = max(
                    conn.get("sync_interval_minutes", 15),
                    MIN_SYNC_INTERVAL_MINUTES,
                )

                last_sync = conn.get("last_sync")
                if last_sync:
                    if isinstance(last_sync, str):
                        last_sync = datetime.fromisoformat(
                            last_sync.replace("Z", "")
                        )
                    due_at = last_sync + timedelta(minutes=interval_min)
                    if now < due_at:
                        continue  # Not due yet

                try:
                    result = _perform_sync(user_id, conn)
                    synced_users += 1
                    logger.info(
                        "WatchScheduler ✓ user=%s sessions_created=%d",
                        user_id, result["new_count"],
                    )
                except Exception as user_err:
                    logger.warning(
                        "WatchScheduler ✗ user=%s error: %s", user_id, user_err
                    )

            if synced_users:
                logger.info("WatchScheduler: synced %d user(s)", synced_users)

        except Exception as e:
            logger.error(
                "WatchScheduler: unexpected error in job: %s", e, exc_info=True
            )


def start_watch_scheduler(app) -> BackgroundScheduler:
    """
    Create and start the background scheduler.
    Call ONCE in main.py after all blueprints are registered.

    Returns the scheduler instance (useful for testing / graceful shutdown).
    """
    scheduler = BackgroundScheduler(
        job_defaults={
            "coalesce":          True,
            "max_instances":     1,
            "misfire_grace_time": 120,
        },
        timezone="UTC",
    )

    scheduler.add_job(
        func=_run_watch_syncs,
        args=[app],
        trigger=IntervalTrigger(minutes=SCHEDULER_INTERVAL_MINUTES),
        id="watch_auto_sync",
        name="Google Fit HR Auto-Sync + Render Keep-Alive",
        replace_existing=True,
    )

    scheduler.start()
    logger.info(
        "✅ WatchScheduler started — polling every %d min",
        SCHEDULER_INTERVAL_MINUTES,
    )
    return scheduler
