"""
Timeline → Parquet. One immutable, hash-stamped snapshot per training run.

Models do not train against the live database. They train against a snapshot
that can be named, hashed, and handed to someone else who will get the same
numbers back. A CGM sync landing mid-epoch is not a reproducibility problem you
want to debug six months later.

    from diatwin.data.repository import MongoRepository
    from diatwin.ml.export import export_snapshot

    repo = MongoRepository(db, object_id=ObjectId)
    loaded = repo.load_many(start=..., end=...)
    manifest = export_snapshot(loaded, out_dir="snapshots")

Layout::

    snapshots/<snapshot_id>/
        glucose.parquet
        insulin.parquet
        meals.parquet
        activity.parquet
        profiles.parquet
        manifest.json

``snapshot_id`` is ``<UTC date>-<12 hex of the content hash>``. The hash covers
the row content of every stream, not the file bytes — Parquet embeds a writer
version and timestamps, so byte hashes differ between runs that hold identical
data, and a hash that changes when nothing changed teaches people to ignore it.

Leakage
-------
:func:`export_snapshot` writes ``observed_at`` for every row and refuses to
write a row without one. That column is the whole leakage guard (rule 6): a
training row for time ``T`` may only use records with ``observed_at <= T``,
which is what :meth:`PatientTimeline.as_of` enforces. Dropping the column at
export would make every downstream check impossible while leaving the data
looking complete — so it is required here rather than optional.

:func:`export_windows` goes further and builds the training rows themselves
through ``as_of``, so the discipline is enforced in code rather than left as a
convention for whoever writes the feature builder.

This module is the ML layer: it may import pyarrow (rule 1 confines that to
``diatwin/ml/``). Nothing under ``diatwin/data``, ``core``, ``sim`` or
``verify`` imports this file.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from ..data.repository import LoadReport, aggregate_reports
from ..data.schema import PatientTimeline

logger = logging.getLogger(__name__)

STREAMS = ("glucose", "insulin", "meals", "activity")

#: Columns written for every stream. ``observed_at`` is not optional — see the
#: module docstring.
_COMMON = ("patient_id", "t", "observed_at", "source", "source_id", "tz_offset_min")

_STREAM_COLUMNS: Dict[str, Tuple[str, ...]] = {
    "glucose": _COMMON + ("mg_dl", "trend"),
    "insulin": _COMMON + ("units", "insulin_type", "dose_class", "suggested_units"),
    "meals": _COMMON + ("carbs_g", "protein_g", "fat_g", "absorption_type",
                        "meal_type", "announced"),
    "activity": _COMMON + ("duration_min", "intensity", "mean_hr",
                           "bg_direction", "auto_segmented"),
}


def _require_pyarrow():
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise ImportError(
            "pyarrow is required for snapshot export.\n"
            "    pip install -r requirements-ml.txt\n"
            "It is deliberately not a dependency of diatwin.data / core / sim / "
            "verify, which stay stdlib-only so CI gates every commit cheaply "
            "(Arm 5 rule 1).") from exc
    return pa, pq


# ─── Rows ────────────────────────────────────────────────────────────────────

def _value(event: Any, column: str) -> Any:
    v = getattr(event, column, None)
    if isinstance(v, datetime):
        # Epoch microseconds: an integer round-trips exactly, where a float
        # second count loses sub-millisecond detail on CGM timestamps.
        return int(v.timestamp() * 1_000_000)
    if hasattr(v, "value"):          # str-valued Enum
        return v.value
    return v


def stream_rows(timeline: PatientTimeline, stream: str) -> List[Dict[str, Any]]:
    """One stream of one timeline as plain dicts, in declared column order."""
    columns = _STREAM_COLUMNS[stream]
    rows = []
    for event in getattr(timeline, stream):
        if event.observed_at is None:
            raise ValueError(
                f"{stream} record {event.source_id!r} has no observed_at; "
                "refusing to export a row that cannot be leakage-checked")
        rows.append({c: _value(event, c) for c in columns})
    return rows


def profile_rows(timelines: Sequence[PatientTimeline]) -> List[Dict[str, Any]]:
    """
    One row per patient profile.

    ``constants`` is JSON rather than exploded columns: it is a wide, sparse,
    schema-drifting dict, and one column per key would make every snapshot's
    schema depend on which patients happened to be in it.
    """
    return [{
        "patient_id": tl.profile.patient_id,
        "valid_from": int(tl.profile.valid_from.timestamp() * 1_000_000),
        "tz_offset_min": tl.profile.tz_offset_min,
        "daily_reset_hour": tl.profile.daily_reset_hour,
        "constants_json": json.dumps(tl.profile.constants, sort_keys=True, default=str),
    } for tl in timelines]


def _content_hash(tables: Dict[str, List[Dict[str, Any]]]) -> str:
    """
    Hash the row content, deterministically.

    Not the file bytes: Parquet embeds a writer version and creation metadata,
    so two runs over identical data produce different files. A hash that moves
    when nothing moved is a hash nobody checks.
    """
    h = hashlib.sha256()
    for name in sorted(tables):
        h.update(name.encode())
        for row in tables[name]:
            h.update(json.dumps(row, sort_keys=True, default=str).encode())
    return h.hexdigest()


# ─── Snapshot ────────────────────────────────────────────────────────────────

@dataclass
class Snapshot:
    """What :func:`export_snapshot` produced."""

    snapshot_id: str
    path: Path
    content_hash: str
    row_counts: Dict[str, int] = field(default_factory=dict)
    patients: int = 0
    created_at: str = ""
    manifest: Dict[str, Any] = field(default_factory=dict)


def export_snapshot(
    loaded: Sequence[Tuple[PatientTimeline, LoadReport]],
    out_dir: str | Path,
    *,
    note: str = "",
    compression: str = "zstd",
) -> Snapshot:
    """
    Write one immutable snapshot and return its manifest.

    ``loaded`` is what :meth:`MongoRepository.load_many` returns — timelines
    *and* their reports. The reports are written into the manifest rather than
    discarded: a snapshot that does not record what was dropped on the way in
    cannot be audited later, and "the model was worse this month" is not a
    question you can answer without it.

    Refuses to overwrite an existing snapshot directory. Same content gives the
    same ``snapshot_id``, so a re-run is a no-op you can detect rather than a
    silent overwrite of the thing a published result points at.
    """
    pa, pq = _require_pyarrow()

    timelines = [tl for tl, _ in loaded]
    reports = [rep for _, rep in loaded]

    tables: Dict[str, List[Dict[str, Any]]] = {
        stream: [r for tl in timelines for r in stream_rows(tl, stream)]
        for stream in STREAMS
    }
    tables["profiles"] = profile_rows(timelines)

    content_hash = _content_hash(tables)
    created = datetime.now(timezone.utc)
    snapshot_id = f"{created:%Y%m%d}-{content_hash[:12]}"

    root = Path(out_dir) / snapshot_id
    if root.exists():
        raise FileExistsError(
            f"snapshot {snapshot_id} already exists at {root}.\n"
            "The id is the content hash, so this is the same data. Delete it "
            "deliberately if you mean to replace it — snapshots are immutable "
            "so that a result can name the data it came from.")
    root.mkdir(parents=True)

    row_counts: Dict[str, int] = {}
    for name, rows in tables.items():
        columns = (_STREAM_COLUMNS[name] if name in _STREAM_COLUMNS
                   else tuple(rows[0].keys()) if rows
                   else ("patient_id",))
        # Build column-wise so an empty stream still writes a typed, readable
        # file. A missing file and an empty one are different findings.
        data = {c: [row.get(c) for row in rows] for c in columns}
        pq.write_table(pa.table(data), root / f"{name}.parquet", compression=compression)
        row_counts[name] = len(rows)

    spans = [tl.span for tl in timelines if tl.span]
    manifest = {
        "snapshot_id": snapshot_id,
        "content_hash": content_hash,
        "created_at": created.isoformat(),
        "note": note,
        "patients": len(timelines),
        "row_counts": row_counts,
        "span": {
            "from": min(s[0] for s in spans).isoformat() if spans else None,
            "to": max(s[1] for s in spans).isoformat() if spans else None,
        },
        "columns": {n: list(_STREAM_COLUMNS.get(n, ())) for n in STREAMS},
        "compression": compression,
        # The drop accounting travels with the data, permanently.
        "load_reports": [r.to_dict() for r in reports],
        "drop_summary": aggregate_reports(reports),
        "leakage_note": (
            "Every row carries observed_at. A training row for time T may read "
            "only records with observed_at <= T (Arm 5 rule 6). Filtering on t "
            "admits records that did not exist when the decision was made."
        ),
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")

    logger.info("snapshot %s written to %s (%d rows)",
                snapshot_id, root, sum(row_counts.values()))
    return Snapshot(
        snapshot_id=snapshot_id,
        path=root,
        content_hash=content_hash,
        row_counts=row_counts,
        patients=len(timelines),
        created_at=created.isoformat(),
        manifest=manifest,
    )


def load_manifest(snapshot_dir: str | Path) -> Dict[str, Any]:
    """Read a snapshot's manifest without needing pyarrow."""
    return json.loads((Path(snapshot_dir) / "manifest.json").read_text(encoding="utf-8"))


# ─── Leakage-safe windowing ──────────────────────────────────────────────────

@dataclass(frozen=True)
class Window:
    """
    One training example's provenance.

    ``as_of`` is the decision time. Everything the row may use was known then;
    ``target_t`` is in the future relative to it and is a label, never a
    feature.
    """

    patient_id: str
    as_of: datetime
    target_t: datetime
    target_mg_dl: float
    n_glucose: int
    n_insulin: int
    n_meals: int
    n_activity: int


def export_windows(
    timeline: PatientTimeline,
    *,
    horizon: timedelta = timedelta(minutes=30),
    stride: timedelta = timedelta(minutes=5),
    min_history: timedelta = timedelta(hours=3),
) -> List[Window]:
    """
    Enumerate leakage-safe prediction points over one timeline.

    For each candidate decision time ``T`` this calls ``timeline.as_of(T)`` and
    counts what was *knowable* then. The target is the first glucose reading at
    or after ``T + horizon``.

    The point of building it this way is that the leakage guard is executed
    rather than documented. A feature builder that slices ``timeline.glucose``
    directly by ``t`` would look almost identical, pass every test, and train
    on meals entered hours after the fact — the exact case ``schema.py``'s
    docstring warns about, a meal logged at 14:00 and entered at 19:00.

    Rule 7 holds here too: no window is emitted where the target is missing.
    A gap stays a gap; it is not filled with the last value.
    """
    if not timeline.glucose:
        return []

    readings = timeline.glucose            # already sorted by __post_init__
    first_t, last_t = readings[0].t, readings[-1].t
    windows: List[Window] = []

    # Index by t for the target lookup. Bisect over a prebuilt list beats
    # rescanning the stream per candidate.
    import bisect
    times = [r.t for r in readings]

    cursor = first_t + min_history
    while cursor + horizon <= last_t:
        idx = bisect.bisect_left(times, cursor + horizon)
        if idx >= len(readings):
            break
        target = readings[idx]

        # Rule 7: a target more than one stride past the requested horizon is
        # a gap, not a late reading. Emitting it would silently stretch the
        # prediction horizon and flatter the model.
        if target.t - (cursor + horizon) > stride:
            cursor += stride
            continue

        known = timeline.as_of(cursor)
        # The target must not be visible to its own features. It is a future
        # reading, so as_of already excludes it unless observed_at was written
        # earlier than t — which would be a normalizer bug, and is worth
        # catching here rather than in a model that mysteriously works.
        if any(r.source_id == target.source_id and r.source_id for r in known.glucose):
            raise ValueError(
                f"target reading {target.source_id!r} is visible at as_of="
                f"{cursor.isoformat()}; observed_at precedes t, which breaks "
                "the leakage guard (rule 6)")

        windows.append(Window(
            patient_id=timeline.patient_id,
            as_of=cursor,
            target_t=target.t,
            target_mg_dl=target.mg_dl,
            n_glucose=len(known.glucose),
            n_insulin=len(known.insulin),
            n_meals=len(known.meals),
            n_activity=len(known.activity),
        ))
        cursor += stride

    return windows
