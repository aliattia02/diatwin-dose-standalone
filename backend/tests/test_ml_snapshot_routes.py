"""
The cohort-quality endpoints, against a real manifest.

The manifest here is produced the same way a real one is: a synthetic corpus
through ``MongoRepository.load_many``, then ``export_snapshot``. Nothing about
these endpoints is faked — they read exactly the file
``diatwin/ml/export.py`` writes, at whatever directory
``ML_SNAPSHOTS_DIR`` names.

Access is restricted to admins because a snapshot's ``load_reports`` names
every patient in the cohort, not just the ones calling doctor is authorized
for. That is tested here rather than assumed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from diatwin.data.repository import MongoRepository
from diatwin.ml.export import export_snapshot


class _FakeCollection:
    def __init__(self, docs=()):
        self.docs = list(docs)

    def find(self, query=None):
        query = query or {}
        uid = query.get("user_id") or query.get("patient_id")
        return [d for d in self.docs
                if uid is None or d.get("user_id") == uid or d.get("patient_id") == uid]

    def find_one(self, query=None):
        for d in self.find(query):
            if all(d.get(k) == v for k, v in (query or {}).items()
                   if k not in ("user_id", "patient_id")):
                return d
        return None

    def distinct(self, field):
        return sorted({d[field] for d in self.docs if field in d})


class _FakeDB:
    def __init__(self):
        self._c = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _FakeCollection())


def _write_snapshot(out_dir: Path, *, patient_ids=("patient-a", "patient-b")) -> str:
    """Build a tiny real corpus and export it. Returns the snapshot_id."""
    from datetime import datetime, timedelta, timezone
    UTC = timezone.utc
    db = _FakeDB()
    base = datetime(2026, 1, 1, tzinfo=UTC)
    for pid in patient_ids:
        db["glucose"].docs.extend([
            {"user_id": pid, "value": 120, "timestamp": base + timedelta(hours=i),
             "observed_at": base + timedelta(hours=i)}
            for i in range(5)
        ])
    repo = MongoRepository(db)
    loaded = repo.load_many(list(patient_ids))
    snapshot = export_snapshot(loaded, out_dir=out_dir, note="test corpus")
    return snapshot.snapshot_id


@pytest.fixture
def snapshots_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("ML_SNAPSHOTS_DIR", str(tmp_path))
    return tmp_path


class TestListSnapshots:

    def test_admin_sees_the_written_snapshot(self, client, admin, auth, snapshots_dir):
        snapshot_id = _write_snapshot(snapshots_dir)

        response = client.get("/api/ml/snapshots", headers=auth(admin))
        assert response.status_code == 200

        snapshots = response.get_json()["snapshots"]
        ids = [s["snapshot_id"] for s in snapshots]
        assert snapshot_id in ids

    def test_lists_row_counts_and_patient_count(self, client, admin, auth, snapshots_dir):
        _write_snapshot(snapshots_dir, patient_ids=("p1", "p2", "p3"))

        response = client.get("/api/ml/snapshots", headers=auth(admin))
        snap = response.get_json()["snapshots"][0]
        assert snap["patients"] == 3
        assert "glucose" in snap["row_counts"]

    def test_an_empty_or_missing_directory_is_an_empty_list_not_an_error(
        self, client, admin, auth, tmp_path, monkeypatch
    ):
        # Negative case: no snapshots directory at all (the common case in this
        # deployment — the DB holds no clinical data) must not 500.
        monkeypatch.setenv("ML_SNAPSHOTS_DIR", str(tmp_path / "does-not-exist"))
        response = client.get("/api/ml/snapshots", headers=auth(admin))
        assert response.status_code == 200
        assert response.get_json()["snapshots"] == []

    def test_a_directory_with_a_corrupt_manifest_does_not_hide_the_others(
        self, client, admin, auth, snapshots_dir
    ):
        good_id = _write_snapshot(snapshots_dir, patient_ids=("only",))
        bad_dir = snapshots_dir / "broken-snapshot"
        bad_dir.mkdir()
        (bad_dir / "manifest.json").write_text("{not valid json", encoding="utf-8")

        response = client.get("/api/ml/snapshots", headers=auth(admin))
        assert response.status_code == 200
        ids = [s["snapshot_id"] for s in response.get_json()["snapshots"]]
        assert good_id in ids
        assert "broken-snapshot" in ids

    def test_a_doctor_cannot_list_snapshots(self, client, doctor, auth, snapshots_dir):
        _write_snapshot(snapshots_dir)
        response = client.get("/api/ml/snapshots", headers=auth(doctor))
        assert response.status_code == 403

    def test_unauthenticated_is_401_not_500(self, client, snapshots_dir):
        _write_snapshot(snapshots_dir)
        response = client.get("/api/ml/snapshots")
        assert response.status_code == 401


class TestGetManifest:

    def test_admin_reads_the_full_manifest(self, client, admin, auth, snapshots_dir):
        snapshot_id = _write_snapshot(snapshots_dir, patient_ids=("patient-a", "patient-b"))

        response = client.get(
            f"/api/ml/snapshots/{snapshot_id}/manifest", headers=auth(admin))
        assert response.status_code == 200

        manifest = response.get_json()["manifest"]
        assert manifest["snapshot_id"] == snapshot_id
        assert manifest["patients"] == 2
        assert len(manifest["load_reports"]) == 2
        assert "drop_summary" in manifest
        assert "leakage_note" in manifest

    def test_load_reports_name_every_patient(self, client, admin, auth, snapshots_dir):
        snapshot_id = _write_snapshot(snapshots_dir, patient_ids=("alice", "bob"))
        response = client.get(
            f"/api/ml/snapshots/{snapshot_id}/manifest", headers=auth(admin))
        patient_ids = {r["patient_id"] for r in response.get_json()["manifest"]["load_reports"]}
        assert patient_ids == {"alice", "bob"}

    def test_unknown_snapshot_id_is_404_not_500(self, client, admin, auth, snapshots_dir):
        _write_snapshot(snapshots_dir)
        response = client.get(
            "/api/ml/snapshots/does-not-exist/manifest", headers=auth(admin))
        assert response.status_code == 404

    @pytest.mark.parametrize("hostile_id", ["../etc", "..%2f..", "a/b", "a\\b"])
    def test_path_traversal_in_the_id_is_rejected(
        self, client, admin, auth, snapshots_dir, hostile_id
    ):
        # The id becomes a directory name read straight off disk. A caller
        # trying to walk out of the snapshots root must get a clean 4xx, not a
        # file from somewhere else on the server.
        response = client.get(
            f"/api/ml/snapshots/{hostile_id}/manifest", headers=auth(admin))
        assert response.status_code in (400, 404)

    def test_a_doctor_cannot_read_a_manifest(self, client, doctor, auth, snapshots_dir):
        snapshot_id = _write_snapshot(snapshots_dir)
        response = client.get(
            f"/api/ml/snapshots/{snapshot_id}/manifest", headers=auth(doctor))
        assert response.status_code == 403
        # The cohort's patient ids must not leak into an unauthorized response.
        assert "patient-a" not in response.get_data(as_text=True)

    def test_a_patient_cannot_read_a_manifest(self, client, patient, auth, snapshots_dir):
        snapshot_id = _write_snapshot(snapshots_dir)
        response = client.get(
            f"/api/ml/snapshots/{snapshot_id}/manifest", headers=auth(patient))
        assert response.status_code == 403

    def test_a_manifest_naming_a_directory_that_lost_its_file_is_404(
        self, client, admin, auth, snapshots_dir
    ):
        # A directory can exist without a readable manifest (e.g. deleted mid
        # read) — this must read as "not found", not crash the request.
        ghost = snapshots_dir / "ghost-snapshot"
        ghost.mkdir()
        response = client.get(
            "/api/ml/snapshots/ghost-snapshot/manifest", headers=auth(admin))
        assert response.status_code == 404
