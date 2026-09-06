"""
Cohort-quality endpoints — the drop-rate table, served rather than only printed.

`scripts/measure_drop_rates.py` and `diatwin/ml/export.py` have produced this
data since they were written; nothing has ever served it. The pre-ML audit §4
is the reason it matters: a stream's drop rate can read 0.00% because nothing
was ever converted into it, which is the most dangerous reading a quality
metric can give. `export_snapshot` already writes that accounting into every
snapshot's `manifest.json` — per-patient, per-stream fetched/kept/dropped,
embedded permanently — and these two endpoints are the whole of what is needed
to read it back.

Deliberately read-only and file-based. Nothing here writes to Mongo, trains
anything, or sits on the path described in the storage-layer decision (§1):
snapshots are produced by `diatwin/ml/export.py` from `MongoRepository`, this
module only reads the `manifest.json` that export step already wrote.

Deliberately admin-only, not doctor-accessible. A snapshot's `load_reports`
list names every patient in the cohort, not just the ones a given doctor is
authorized for (`check_doctor_patient_access` has no meaning here — there is no
single patient to check access to). Admins already see every patient
(`doctor_routes.check_doctor_patient_access`), so this does not widen who can
see what; a doctor scoped to their own patients is the wrong audience for a
cohort-wide table naming other doctors' patients.

    GET /api/ml/snapshots                    — list what is available
    GET /api/ml/snapshots/<snapshot_id>/manifest  — one snapshot's full manifest
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List

from flask import Blueprint, jsonify

from utils.auth import token_required
from utils.error_handler import api_error_handler

logger = logging.getLogger(__name__)
ml_routes = Blueprint('ml_routes', __name__)

#: Where `diatwin.ml.export.export_snapshot` writes snapshot directories.
#: Overridable so a deployment can point this at wherever snapshots actually
#: land — a mounted volume, a synced bucket checkout — without a code change.
#: The default matches `export_snapshot`'s own default `out_dir="snapshots"`
#: (diatwin/ml/export.py) and is resolved relative to the backend package so
#: it does not depend on the process's current working directory.
_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _snapshots_root() -> Path:
    configured = os.environ.get('ML_SNAPSHOTS_DIR')
    if configured:
        return Path(configured)
    return _BACKEND_DIR.parent / 'snapshots'


def _is_admin(current_user: Dict[str, Any]) -> bool:
    return current_user.get('user_type') == 'admin'


def _snapshot_dirs() -> List[Path]:
    root = _snapshots_root()
    if not root.is_dir():
        return []
    # A snapshot directory is anything holding a manifest.json — this does not
    # assume the `YYYYMMDD-<hash>` naming in export.py, so a manually staged
    # or renamed directory is still found.
    return sorted(
        (d for d in root.iterdir() if d.is_dir() and (d / 'manifest.json').is_file()),
        key=lambda d: d.name,
    )


def _read_manifest(directory: Path) -> Dict[str, Any]:
    return json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))


@ml_routes.route('/api/ml/snapshots', methods=['GET'])
@token_required
@api_error_handler
def list_snapshots(current_user):
    """
    One row per snapshot: id, when it was made, how many patients, and its own
    note — not the full per-patient breakdown, which is what the second
    endpoint is for. Kept light so a cohort list with many snapshots stays
    fast to render.
    """
    if not _is_admin(current_user):
        return jsonify({'message': 'Unauthorized access'}), 403

    snapshots = []
    for directory in _snapshot_dirs():
        try:
            manifest = _read_manifest(directory)
        except (json.JSONDecodeError, OSError) as e:
            # A directory that looks like a snapshot but whose manifest cannot
            # be read is a fact worth surfacing, not a reason to 500 the whole
            # list — one bad entry must not hide every good one.
            logger.warning("unreadable manifest at %s: %s", directory, e)
            snapshots.append({
                'snapshot_id': directory.name,
                'error': 'manifest could not be read',
            })
            continue

        snapshots.append({
            'snapshot_id': manifest.get('snapshot_id', directory.name),
            'created_at': manifest.get('created_at'),
            'patients': manifest.get('patients'),
            'note': manifest.get('note', ''),
            'row_counts': manifest.get('row_counts', {}),
        })

    return jsonify({'snapshots': snapshots}), 200


@ml_routes.route('/api/ml/snapshots/<snapshot_id>/manifest', methods=['GET'])
@token_required
@api_error_handler
def get_snapshot_manifest(current_user, snapshot_id):
    """
    The full manifest: per-patient `load_reports`, the cohort `drop_summary`,
    span, columns, and the leakage note. Everything the cohort-quality view
    renders comes from this one document — see
    docs/engineering/2026-09-05-suggestion-review-contract.md §1.4 on why a
    clinical claim must be able to name its data.
    """
    if not _is_admin(current_user):
        return jsonify({'message': 'Unauthorized access'}), 403

    # snapshot_id is a path segment read back as a directory name — reject
    # anything that could walk out of the snapshots root rather than trusting
    # Werkzeug's default string converter alone.
    if not snapshot_id or '/' in snapshot_id or '\\' in snapshot_id or snapshot_id in ('.', '..'):
        return jsonify({'message': 'Invalid snapshot id'}), 400

    directory = _snapshots_root() / snapshot_id
    if not (directory / 'manifest.json').is_file():
        return jsonify({'message': 'Snapshot not found'}), 404

    try:
        manifest = _read_manifest(directory)
    except (json.JSONDecodeError, OSError) as e:
        logger.error("manifest at %s could not be read: %s", directory, e)
        return jsonify({'message': 'Snapshot manifest could not be read'}), 500

    return jsonify({'manifest': manifest}), 200
