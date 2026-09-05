"""
Every MongoDB index this application depends on, declared once.

Indexes used to live in two standalone scripts that had to be remembered and
run by hand against each new database. That works exactly until someone forgets
— and the one that matters most, ``unique_libre_cgm_reading``, is what stops a
CGM reading being written twice. Without it, duplicate readings inflate IOB and
poison anything trained on the data, silently and after the fact.

So the definitions live here, and there are two ways to apply them:

*   ``ensure_indexes(db)`` is called at application startup, non-fatally. It is
    idempotent — MongoDB creates an index that is missing and does nothing for
    one that already exists with the same specification.
*   ``setup_libre_indexes.py`` and ``setup_watch_indexes.py`` still work and
    now call straight into this module, so there is one definition rather than
    two that can drift.

Why startup is non-fatal
------------------------
Creating a **unique** index on a collection that already contains duplicates
fails, and that failure is a real finding — it means data needs cleaning. But
it must not take the web service down: a backend that refuses to boot because
of historical duplicates is worse than one that runs and logs loudly. So
``ensure_indexes`` catches per-index failures, reports them, and returns a
result the caller can inspect.

Run the scripts when you want the opposite behaviour. They pass
``strict=True``, so a duplicate stops them with a non-zero exit and you find
out on purpose rather than in a log you were not reading.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from pymongo import ASCENDING, DESCENDING

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IndexSpec:
    """One index, and why it exists."""

    collection: str
    keys: List[tuple]
    name: str
    unique: bool = False
    partial: Optional[Dict[str, Any]] = None
    why: str = ""

    def create_on(self, db) -> None:
        kwargs: Dict[str, Any] = {"name": self.name}
        if self.unique:
            kwargs["unique"] = True
        if self.partial:
            kwargs["partialFilterExpression"] = self.partial
        db[self.collection].create_index(self.keys, **kwargs)


#: LibreLinkUp CGM integration.
LIBRE_INDEXES: List[IndexSpec] = [
    IndexSpec(
        collection="libre_connections",
        keys=[("user_id", ASCENDING)],
        name="unique_user_libre_connection",
        unique=True,
        why="one LibreLinkUp connection document per user",
    ),
    IndexSpec(
        collection="blood_sugar",
        keys=[("user_id", ASCENDING),
              ("source", ASCENDING),
              ("bloodSugarTimestamp", ASCENDING)],
        name="unique_libre_cgm_reading",
        unique=True,
        partial={"source": "libre_cgm"},
        why=("the deduplication guarantee. _save_single_reading does a "
             "find-then-insert, which races when two processes sync the same "
             "user at once — and the scheduler runs once per gunicorn worker. "
             "This index is what makes that race harmless"),
    ),
    IndexSpec(
        collection="blood_sugar",
        keys=[("user_id", ASCENDING),
              ("source", ASCENDING),
              ("bloodSugarTimestamp", DESCENDING)],
        name="libre_cgm_time_range_query",
        why="GET /api/libre/readings filters by user and time window",
    ),
]

#: Google Fit watch heart-rate sync.
WATCH_INDEXES: List[IndexSpec] = [
    IndexSpec(
        collection="watch_connections",
        keys=[("user_id", ASCENDING)],
        name="unique_user_watch_connection",
        unique=True,
        why="one watch connection document per user",
    ),
    IndexSpec(
        collection="activities",
        keys=[("user_id", ASCENDING),
              ("source", ASCENDING),
              ("startTime", DESCENDING)],
        name="google_fit_activities_time_range",
        why="activity queries filtered by source, user and time",
    ),
]

ALL_INDEXES: List[IndexSpec] = LIBRE_INDEXES + WATCH_INDEXES


@dataclass
class IndexResult:
    """What :func:`ensure_indexes` managed to do."""

    created: List[str] = field(default_factory=list)
    failed: List[tuple] = field(default_factory=list)   # (name, error message)

    @property
    def ok(self) -> bool:
        return not self.failed

    def summary(self) -> str:
        if self.ok:
            return f"indexes ok ({len(self.created)} ensured)"
        names = ", ".join(name for name, _ in self.failed)
        return f"{len(self.failed)} index(es) FAILED: {names}"


def ensure_indexes(db, specs: Optional[List[IndexSpec]] = None,
                   *, strict: bool = False) -> IndexResult:
    """
    Create every index that is missing. Safe to call on every startup.

    ``create_index`` is idempotent, so this is cheap on a database that is
    already set up: MongoDB compares the specification and does nothing when it
    matches.

    With ``strict=False`` (the default, and what application startup uses) a
    failure is logged and collected rather than raised — the service still
    boots. With ``strict=True`` the first failure propagates, which is what the
    command-line scripts want.
    """
    result = IndexResult()
    for spec in specs if specs is not None else ALL_INDEXES:
        try:
            spec.create_on(db)
            result.created.append(spec.name)
            logger.info("index ok: %s.%s", spec.collection, spec.name)
        except Exception as exc:
            result.failed.append((spec.name, str(exc)))
            logger.error(
                "index FAILED: %s.%s — %s\n  purpose: %s",
                spec.collection, spec.name, exc, spec.why or "(undocumented)")
            if spec.unique:
                logger.error(
                    "  this is a UNIQUE index; the usual cause is existing "
                    "duplicate documents. Data needs cleaning before it can "
                    "be created, and until then nothing prevents more.")
            if strict:
                raise
    return result
