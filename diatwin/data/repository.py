"""
The single Mongo read path for modelling.

Input: a patient id and a time range. Output: a :class:`PatientTimeline` and a
:class:`LoadReport` saying what was thrown away getting there.

Nothing else under ``diatwin/`` may touch the database. This module and
:mod:`diatwin.data.normalize` are the quarantine boundary (Arm 5 rule 2): raw
documents stop here, and everything downstream consumes ``schema.py`` types.

Why this file imports no driver
-------------------------------
``diatwin/data`` must import nothing outside the standard library (rule 1), so
that the foundation suite and the parity harness run in CI in under a second
without a Mongo stack. A module-level ``import pymongo`` would forfeit that for
the whole package.

So :class:`MongoRepository` takes a *database handle* rather than importing one.
Anything exposing ``db[name].find(query)`` works — a real
``pymongo.database.Database``, a ``mongomock`` one, or a hand-built fake. The
caller owns the connection; this module owns the queries.

That is not only about CI. It means the repository can be tested against
hand-written documents carrying the exact historical quirks
:mod:`~diatwin.data.normalize` exists to absorb, without a database anywhere
near the test.

Why the time window is applied in Python
----------------------------------------
``bloodSugarTimestamp`` has been written as a naive ``datetime``, an ISO string,
an ISO string with a ``Z`` suffix, and not at all — that is why the ``$or``
fan-out at ``backend/blood_sugar.py:341-363`` exists. A server-side
``{"$gte": <datetime>}`` silently matches none of the string-encoded documents,
so a range query would appear to work and quietly return a biased subset: the
newest rows, written in whichever encoding is current.

The window is therefore applied *after* normalization, where
:func:`~diatwin.data.normalize.parse_time` has already collapsed all four
encodings onto one axis. :func:`parse_time` is the single definition of when a
record happened, and this module does not add a second one.

A coarse server-side pre-filter is available (``server_prefilter=True``) for
large collections. It is a *superset* filter with a safety margin, never an
exact one — see :meth:`MongoRepository._window_query`.

Which meal collection is authoritative
--------------------------------------
``meals``. Not ``meals_only``. This was an open question; it is settled by four
pieces of evidence in the backend, recorded in :data:`MEALS_AUTHORITATIVE_WHY`
and enforced by :meth:`MongoRepository.__init__` refusing to be pointed at the
projection.

Stdlib only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .normalize import normalize_all, parse_time
from .schema import PatientProfile, PatientTimeline

logger = logging.getLogger(__name__)


#: Collection names, overridable for a restore under a different name.
DEFAULT_COLLECTIONS: Dict[str, str] = {
    "glucose": "blood_sugar",
    "meals": "meals",
    "medication": "medication_logs",
    "activity": "activities",
    "users": "users",
}

#: Read by nothing here, on purpose. Named so that the refusal in
#: :meth:`MongoRepository.__init__` has something to point at.
MEALS_PROJECTION_COLLECTION = "meals_only"

MEALS_AUTHORITATIVE_WHY = """\
`meals` is authoritative for modelling; `meals_only` must never be read.

1.  `meals_only` is a strict subset. `backend/meal_insulin.py:828-830` writes it
    only when `foodItems` is non-empty AND `mealType` is not one of
    blood_sugar_only / activity_only / insulin_only. `meals` is written
    unconditionally. Training on the projection would silently drop every
    insulin-only and BG-only record.

2.  It carries no insulin. The projection document
    (`backend/meal_insulin.py:831-843`) holds foodItems, nutrition, notes and
    calculation_summary — and no dose field. `normalize_insulin_from_meal`
    reads the insulin dual write out of `meals`; from `meals_only` it would
    find nothing, and every bolus logged through a meal would vanish.

3.  The backend says so. `_resolve_meal` (`backend/meal_insulin.py:1326`)
    resolves both ids to "the authoritative `meals` document", and its
    docstring records that failing to do so left records behind "still
    carrying its insulin dose into every IOB and cumulative-effects
    calculation".

4.  Projections outlive their parents. `_resolve_meal` handles a `meals_only`
    row "with no reachable parent meal" — an orphan left by a delete. Reading
    the projection would resurrect meals a patient deleted, which is the
    failure `backend/sweep_orphaned_meals.py` exists to clean up.
"""

#: How far outside the requested window the server-side pre-filter reaches.
#: The pre-filter must never exclude a document the Python filter would keep,
#: and the encodings disagree by at most a timezone offset, so a day is ample.
PREFILTER_MARGIN = timedelta(days=1)


# ─── Reports ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StreamReport:
    """
    What happened to one collection on the way to the timeline.

    ``dropped_normalize`` is the number the normalizer refused: no usable
    timestamp, no value, a sedentary activity level, a non-meal meal type. A
    high count is a **finding**, not an error — it says which stream needs
    attention before a model is trained on it (rule 5: a bad row is dropped,
    never mis-timed).
    """

    stream: str
    collection: str
    fetched: int = 0
    kept: int = 0
    dropped_normalize: int = 0
    dropped_window: int = 0

    @property
    def dropped(self) -> int:
        return self.dropped_normalize + self.dropped_window

    @property
    def drop_rate(self) -> float:
        """Fraction of fetched documents that did not reach the timeline."""
        return (self.fetched - self.kept) / self.fetched if self.fetched else 0.0

    @property
    def normalize_failure_rate(self) -> float:
        """
        Fraction the *normalizer* refused, ignoring window trimming.

        This is the number that matters for data quality. ``drop_rate``
        includes records that were simply outside the requested range, which
        is expected and says nothing about the data.
        """
        return self.dropped_normalize / self.fetched if self.fetched else 0.0


@dataclass(frozen=True)
class LoadReport:
    """Per-stream accounting for one :meth:`MongoRepository.load` call."""

    patient_id: str
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    streams: Dict[str, StreamReport] = field(default_factory=dict)
    #: Doses seen twice — once in ``medication_logs``, once as an
    #: ``insulin_only`` meal — and collapsed by ``dedupe_insulin``. Expected to
    #: be non-zero. Zero across a large load means the dual write is not being
    #: read, which would *halve* rather than double the insulin signal.
    insulin_deduped: int = 0
    profile_found: bool = False

    @property
    def total_fetched(self) -> int:
        return sum(s.fetched for s in self.streams.values())

    @property
    def worst_stream(self) -> Optional[StreamReport]:
        """The stream whose normalizer failure rate is highest, if any fetched."""
        candidates = [s for s in self.streams.values() if s.fetched]
        return max(candidates, key=lambda s: s.normalize_failure_rate) if candidates else None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "patient_id": self.patient_id,
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
            "profile_found": self.profile_found,
            "insulin_deduped": self.insulin_deduped,
            "streams": {
                name: {
                    "collection": s.collection,
                    "fetched": s.fetched,
                    "kept": s.kept,
                    "dropped_normalize": s.dropped_normalize,
                    "dropped_window": s.dropped_window,
                    "normalize_failure_rate": round(s.normalize_failure_rate, 6),
                }
                for name, s in sorted(self.streams.items())
            },
        }

    def format(self) -> str:
        """A table for a terminal. Drop rates are the point of this class."""
        head = f"{'stream':10}{'collection':16}{'fetched':>9}{'kept':>8}" \
               f"{'norm-drop':>11}{'win-drop':>10}{'fail%':>8}"
        lines = [f"patient {self.patient_id}", head, "-" * len(head)]
        for name, s in sorted(self.streams.items()):
            lines.append(
                f"{name:10}{s.collection:16}{s.fetched:>9}{s.kept:>8}"
                f"{s.dropped_normalize:>11}{s.dropped_window:>10}"
                f"{s.normalize_failure_rate * 100:>7.2f}%")
        lines.append(f"insulin dual-write collapsed: {self.insulin_deduped}")
        if not self.profile_found:
            lines.append("profile: NOT FOUND — defaults used, tz_offset_min=0")
        return "\n".join(lines)


# ─── Repository ──────────────────────────────────────────────────────────────

class MongoRepository:
    """
    Reads one patient's history out of Mongo and hands back canonical types.

    ``db`` is any mapping-like database handle: ``db[name].find(query)`` must
    return an iterable of documents. No driver is imported here.

    ``object_id`` is optional and only used to look up the patient profile,
    whose ``_id`` is a genuine ``ObjectId``. Pass ``bson.ObjectId`` when you
    have it; without it the profile lookup falls back to a string ``_id`` and,
    failing that, to defaults — recorded as ``profile_found=False`` rather than
    guessed at silently.
    """

    def __init__(
        self,
        db: Any,
        *,
        collections: Optional[Mapping[str, str]] = None,
        object_id: Optional[Any] = None,
        server_prefilter: bool = False,
    ) -> None:
        self.db = db
        self.collections = dict(DEFAULT_COLLECTIONS)
        if collections:
            self.collections.update(collections)
        self.object_id = object_id
        self.server_prefilter = server_prefilter
        # Set per load(); initialised here so a direct _fetch() is not a
        # surprise AttributeError.
        self._start: Optional[datetime] = None
        self._end: Optional[datetime] = None

        # Rule 2 has a specific failure mode here: pointing the loader at the
        # projection would look like it worked and quietly train on a subset
        # with no insulin in it. Refuse rather than trust a config value.
        if self.collections["meals"] == MEALS_PROJECTION_COLLECTION:
            raise ValueError(
                f"refusing to read meals from {MEALS_PROJECTION_COLLECTION!r}.\n\n"
                + MEALS_AUTHORITATIVE_WHY)

    # ── queries ──────────────────────────────────────────────────────────────

    def _window_query(self, fields: Sequence[str]) -> Dict[str, Any]:
        """
        A coarse server-side pre-filter, or ``{}`` when disabled.

        Deliberately a *superset*: it widens the window by
        :data:`PREFILTER_MARGIN` and matches on any of the candidate timestamp
        fields, in both datetime and ISO-string form. ISO-8601 sorts
        lexicographically, so a string comparison is a valid range test — but
        only for strings written in the same shape, which is exactly what is
        not guaranteed here. The margin covers the disagreement; the Python
        filter does the real work.

        If this is ever tightened into an exact filter it will start dropping
        string-encoded documents, and the loss will be invisible: fewer rows,
        no error, a model trained on whatever encoding happened to be current.
        """
        if not self.server_prefilter or (self._start is None and self._end is None):
            return {}
        clauses: List[Dict[str, Any]] = []
        lo = self._start - PREFILTER_MARGIN if self._start else None
        hi = self._end + PREFILTER_MARGIN if self._end else None
        for f in fields:
            bounds: Dict[str, Any] = {}
            if lo is not None:
                bounds["$gte"] = lo
            if hi is not None:
                bounds["$lte"] = hi
            clauses.append({f: bounds})
            iso: Dict[str, Any] = {}
            if lo is not None:
                iso["$gte"] = lo.replace(tzinfo=None).isoformat()
            if hi is not None:
                iso["$lte"] = hi.replace(tzinfo=None).isoformat() + "~"
            clauses.append({f: iso})
            # A document missing the field entirely still has to reach the
            # normalizer, which knows about the fallback fields.
            clauses.append({f: {"$exists": False}})
        return {"$or": clauses}

    def _fetch(self, stream: str, patient_id: str, time_fields: Sequence[str]) -> List[Dict[str, Any]]:
        collection = self.collections[stream]
        query: Dict[str, Any] = {"user_id": patient_id}
        window = self._window_query(time_fields)
        if window:
            query.update(window)
        try:
            return list(self.db[collection].find(query))
        except Exception as exc:            # pragma: no cover - driver-specific
            logger.error("query failed on %s for patient %s: %s", collection, patient_id, exc)
            raise

    # ── profile ──────────────────────────────────────────────────────────────

    def _load_profile(self, patient_id: str) -> Tuple[PatientProfile, bool]:
        """
        The patient's constants, or documented defaults.

        A missing profile is reported, never invented. ``tz_offset_min`` drives
        every local-time feature, so silently defaulting it to 0 would shift a
        patient's whole circadian signal by their UTC offset — the same class of
        bug as D9, arriving through the data layer instead.
        """
        users = self.db[self.collections["users"]]
        doc = None
        for candidate in self._id_candidates(patient_id):
            try:
                doc = users.find_one({"_id": candidate})
            except Exception:               # pragma: no cover - driver-specific
                doc = None
            if doc:
                break
        if doc is None:
            doc = users.find_one({"user_id": patient_id}) or None

        if not doc:
            logger.warning(
                "no profile for patient %s — using defaults, tz_offset_min=0", patient_id)
            return PatientProfile(
                patient_id=patient_id,
                valid_from=datetime(1970, 1, 1, tzinfo=timezone.utc),
            ), False

        constants = dict(doc.get("patient_constants") or doc.get("constants") or {})
        valid_from = (parse_time(doc.get("constants_updated_at"))
                      or parse_time(doc.get("created_at"))
                      or datetime(1970, 1, 1, tzinfo=timezone.utc))
        return PatientProfile(
            patient_id=patient_id,
            valid_from=valid_from,
            constants=constants,
            tz_offset_min=int(constants.get("timezone_offset_minutes")
                              or doc.get("timezone_offset_minutes") or 0),
            daily_reset_hour=int(constants.get("daily_reset_hour")
                                 or doc.get("daily_reset_hour") or 7),
        ), True

    def _id_candidates(self, patient_id: str) -> List[Any]:
        out: List[Any] = []
        if self.object_id is not None:
            try:
                out.append(self.object_id(patient_id))
            except Exception:
                pass
        out.append(patient_id)
        return out

    # ── the public call ──────────────────────────────────────────────────────

    def load(
        self,
        patient_id: str,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> Tuple[PatientTimeline, LoadReport]:
        """
        Load one patient's timeline for ``[start, end]`` (inclusive, aware UTC).

        Both bounds are optional; omitting them loads everything. Returns the
        timeline and a :class:`LoadReport` — the report is not optional, and
        callers are expected to look at it. Swallowing drop counts is how a
        stream that stopped normalizing goes unnoticed for a month.
        """
        for name, value in (("start", start), ("end", end)):
            if value is not None and value.tzinfo is None:
                raise ValueError(
                    f"{name} must be timezone-aware UTC; got naive {value!r}. "
                    "There is one time axis (rule 3).")
        self._start, self._end = start, end

        glucose_docs = self._fetch("glucose", patient_id,
                                   ("bloodSugarTimestamp", "timestamp"))
        meal_docs = self._fetch("meals", patient_id, ("timestamp", "created_at"))
        medication_docs = self._fetch("medication", patient_id,
                                      ("taken_at", "administrationTime", "timestamp"))
        activity_docs = self._fetch("activity", patient_id,
                                    ("startTime", "start_time", "timestamp"))

        profile, profile_found = self._load_profile(patient_id)

        # normalize_all applies dedupe_insulin, which rule 8 requires for any
        # load that reads medication_logs and meals together — as this one does.
        result = normalize_all(
            glucose_docs=glucose_docs,
            meal_docs=meal_docs,
            medication_docs=medication_docs,
            activity_docs=activity_docs,
            tz_offset_min=profile.tz_offset_min,
        )

        streams: Dict[str, StreamReport] = {}
        kept: Dict[str, List[Any]] = {}
        raw_counts = {
            "glucose": len(glucose_docs),
            "insulin": len(medication_docs) + len(meal_docs),
            "meals": len(meal_docs),
            "activity": len(activity_docs),
        }
        collections = {
            "glucose": self.collections["glucose"],
            "insulin": f"{self.collections['medication']}+{self.collections['meals']}",
            "meals": self.collections["meals"],
            "activity": self.collections["activity"],
        }
        for stream in ("glucose", "insulin", "meals", "activity"):
            records = result[stream]
            in_window = [e for e in records if self._in_window(e.t)]
            kept[stream] = in_window
            dropped_norm = result["dropped"].get(stream)
            if dropped_norm is None:        # insulin has no single drop count
                dropped_norm = raw_counts[stream] - len(records) \
                    - result["dropped"]["insulin_deduped"]
            streams[stream] = StreamReport(
                stream=stream,
                collection=collections[stream],
                fetched=raw_counts[stream],
                kept=len(in_window),
                dropped_normalize=max(0, dropped_norm),
                dropped_window=len(records) - len(in_window),
            )

        timeline = PatientTimeline(
            patient_id=patient_id,
            profile=profile,
            glucose=kept["glucose"],
            insulin=kept["insulin"],
            meals=kept["meals"],
            activity=kept["activity"],
        )
        report = LoadReport(
            patient_id=patient_id,
            start=start,
            end=end,
            streams=streams,
            insulin_deduped=result["dropped"]["insulin_deduped"],
            profile_found=profile_found,
        )
        return timeline, report

    def _in_window(self, t: datetime) -> bool:
        if self._start is not None and t < self._start:
            return False
        if self._end is not None and t > self._end:
            return False
        return True

    # ── discovery ────────────────────────────────────────────────────────────

    def patient_ids(self) -> List[str]:
        """
        Every patient id that has at least one glucose reading.

        Deliberately not "every user": an account with no readings contributes
        nothing to training and would show up as a 100 % drop rate, which is
        noise in a report whose whole purpose is to make drop rates legible.
        """
        collection = self.db[self.collections["glucose"]]
        try:
            return sorted(str(v) for v in collection.distinct("user_id") if v)
        except Exception:                   # pragma: no cover - driver-specific
            seen = {str(d.get("user_id")) for d in collection.find({}) if d.get("user_id")}
            return sorted(seen)

    def load_many(
        self,
        patient_ids: Optional[Iterable[str]] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> List[Tuple[PatientTimeline, LoadReport]]:
        """Load several patients. Order follows ``patient_ids``."""
        ids = list(patient_ids) if patient_ids is not None else self.patient_ids()
        return [self.load(pid, start, end) for pid in ids]


# ─── Aggregate reporting ─────────────────────────────────────────────────────

def aggregate_reports(reports: Sequence[LoadReport]) -> str:
    """
    A cohort-wide drop-rate table.

    This is the artifact to read before training anything: it says which stream
    is losing records and how many, across every patient at once.
    """
    if not reports:
        return "no reports"
    totals: Dict[str, Dict[str, int]] = {}
    for r in reports:
        for name, s in r.streams.items():
            acc = totals.setdefault(name, {"fetched": 0, "kept": 0, "norm": 0, "win": 0})
            acc["fetched"] += s.fetched
            acc["kept"] += s.kept
            acc["norm"] += s.dropped_normalize
            acc["win"] += s.dropped_window

    head = f"{'stream':10}{'fetched':>12}{'kept':>12}{'norm-drop':>12}{'fail%':>9}"
    lines = [f"{len(reports)} patient(s)", head, "-" * len(head)]
    for name in ("glucose", "insulin", "meals", "activity"):
        a = totals.get(name)
        if not a:
            continue
        rate = a["norm"] / a["fetched"] * 100 if a["fetched"] else 0.0
        flag = "   <-- investigate" if rate >= 5.0 else ""
        lines.append(f"{name:10}{a['fetched']:>12}{a['kept']:>12}"
                     f"{a['norm']:>12}{rate:>8.2f}%{flag}")
    missing = [r.patient_id for r in reports if not r.profile_found]
    if missing:
        lines.append(f"\n{len(missing)} patient(s) with no profile "
                     f"(tz_offset_min defaulted to 0): {', '.join(missing[:10])}")
    deduped = sum(r.insulin_deduped for r in reports)
    lines.append(f"\ninsulin dual-write collapsed: {deduped}")
    if deduped == 0 and totals.get("insulin", {}).get("fetched", 0) > 100:
        lines.append("  0 across a large load — check that BOTH medication_logs "
                     "and meals are being read (rule 8)")
    return "\n".join(lines)
