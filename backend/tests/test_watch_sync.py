"""
The Google Fit heart-rate sync path.

``services/watch_sync_service._perform_sync`` is the second of the two timed
writers, and the second one that had no tests. It polls Google Fit, runs the
HR stream through the autosegmenter, and inserts activity sessions.

Activity is the smallest of the four streams and the one with the most
leverage per row: a single spurious 45-minute "vigorous" bout moves the
insulin-sensitivity term for hours. Duplicated or invented bouts are worse
here than missing ones.

The scheduler is stubbed in ``conftest.py``; these call ``_perform_sync``
directly and mock only the Google Fit HTTP boundary.

Covered: a successful sync, token refresh, an auth failure, a malformed
payload, a partial page, the same window synced twice, and the per-user
interval check. One defect (D19) was found and is pinned below.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest
import responses

AGGREGATE_URL = "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate"
TOKEN_URL = "https://oauth2.googleapis.com/token"

UTC = timezone.utc


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def watch_conn(db, patient):
    """A connected watch whose access token is still valid."""
    doc = {
        "user_id": str(patient["_id"]),
        "access_token": "access-still-good",
        "refresh_token": "refresh-1",
        "token_expires_at": time.time() + 3600,
        "connected_at": datetime.now(UTC).isoformat(),
    }
    db.watch_connections.insert_one(dict(doc))
    return doc


def _hr_points(start: datetime, bpm_sequence):
    """Google Fit aggregate response carrying one point per minute."""
    points = []
    for i, bpm in enumerate(bpm_sequence):
        ts = start + timedelta(minutes=i)
        ns = int(ts.timestamp() * 1_000_000_000)
        points.append({
            "startTimeNanos": str(ns),
            "endTimeNanos": str(ns + 60_000_000_000),
            "value": [{"fpVal": float(bpm)}],
        })
    return {"bucket": [{"dataset": [{"point": points}]}]}


def _mock_fit(body, *, status=200):
    responses.add(responses.POST, AGGREGATE_URL, json=body, status=status)


def _active_stream(start: datetime, minutes: int = 20, bpm: int = 120):
    """
    An unambiguously active stretch.

    Long enough to clear ``debounce_start`` (6 samples) and
    ``min_session_minutes`` (2.0), with sedentary tails either side so the
    segmenter sees a start and an end rather than a truncated run.
    """
    return _hr_points(start, [40] * 8 + [bpm] * minutes + [40] * 8)


# ─── Happy path ──────────────────────────────────────────────────────────────

class TestSuccessfulSync:

    @responses.activate
    def test_an_active_stretch_becomes_an_activity_document(
            self, app_ctx, db, patient, watch_conn):
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        _mock_fit(_active_stream(start, minutes=20, bpm=120))

        result = _perform_sync(str(patient["_id"]), watch_conn)

        assert result["new_count"] >= 1
        docs = list(db.activities.find({}))
        assert len(docs) == result["new_count"]
        assert all(d["user_id"] == str(patient["_id"]) for d in docs)
        assert all(d["source"] == "google_fit" for d in docs)
        # A moderate stretch at 120 bpm must not be labelled vigorous.
        assert {d["level"] for d in docs} <= {0, 1}

    @responses.activate
    def test_intensity_follows_the_heart_rate(self, app_ctx, db, patient, watch_conn):
        """
        The zone boundaries are 50 / 100 / 140 bpm. A bout at 160 must come
        back vigorous — if intensity collapsed to a constant, every activity
        feature downstream would be uninformative while looking populated.
        """
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        _mock_fit(_active_stream(start, minutes=20, bpm=160))
        _perform_sync(str(patient["_id"]), watch_conn)

        docs = list(db.activities.find({}))
        assert docs, "a 160 bpm stretch should segment"
        assert any(d["level"] == 2 for d in docs)

    @responses.activate
    def test_a_quiet_window_writes_nothing_but_still_advances_last_sync(
            self, app_ctx, db, patient, watch_conn):
        """
        No samples is the common case overnight. ``last_sync`` must still move,
        or the fetch window grows without bound and every cycle re-requests a
        widening span.
        """
        from services.watch_sync_service import _perform_sync

        _mock_fit({"bucket": []})
        result = _perform_sync(str(patient["_id"]), watch_conn)

        assert result == {"new_count": 0, "skipped_count": 0,
                          "duplicate_count": 0, "latest_session": None}
        assert db.activities.count_documents({}) == 0
        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})
        assert conn["last_sync"]

    @responses.activate
    def test_sedentary_heart_rate_produces_no_activity(
            self, app_ctx, db, patient, watch_conn):
        """
        The negative case, and the one that matters most.

        Resting HR must not become an exercise bout. A segmenter that emitted
        sessions for sleep would add a spurious insulin-sensitivity multiplier
        across the night — the kind of error a model happily learns.
        """
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        _mock_fit(_hr_points(start, [45] * 40))
        result = _perform_sync(str(patient["_id"]), watch_conn)

        assert result["new_count"] == 0
        assert db.activities.count_documents({}) == 0


# ─── Tokens ──────────────────────────────────────────────────────────────────

class TestTokenHandling:

    @pytest.fixture(autouse=True)
    def oauth_env(self, monkeypatch):
        """
        ``refresh_access_token`` reads the OAuth client from the environment and
        raises ``EnvironmentError`` before making any request when it is unset.
        Supplying dummies here keeps these tests on the refresh path rather than
        on the missing-configuration path.
        """
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-client-secret")
        monkeypatch.setenv("GOOGLE_REDIRECT_URI", "https://example.test/callback")

    @responses.activate
    def test_an_expired_access_token_is_refreshed_before_the_fetch(
            self, app_ctx, db, patient, watch_conn):
        from services.watch_sync_service import _perform_sync

        db.watch_connections.update_one(
            {"user_id": str(patient["_id"])},
            {"$set": {"token_expires_at": time.time() - 10}},
        )
        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})

        responses.add(responses.POST, TOKEN_URL,
                      json={"access_token": "access-refreshed", "expires_in": 3600},
                      status=200)
        _mock_fit({"bucket": []})

        _perform_sync(str(patient["_id"]), conn)

        stored = db.watch_connections.find_one({"user_id": str(patient["_id"])})
        assert stored["access_token"] == "access-refreshed"
        assert stored["token_expires_at"] > time.time()
        # The fetch used the new token, not the stale one.
        fit_call = next(c for c in responses.calls if c.request.url.startswith(AGGREGATE_URL))
        assert fit_call.request.headers["Authorization"] == "Bearer access-refreshed"

    def test_a_connection_with_no_refresh_token_fails_loudly(
            self, app_ctx, db, patient):
        """
        A revoked grant must not look like a quiet watch. Raising sends it to
        the scheduler's per-user handler, which logs it.
        """
        from services.watch_sync_service import _perform_sync

        db.watch_connections.insert_one({
            "user_id": str(patient["_id"]),
            "access_token": "stale",
            "token_expires_at": time.time() - 10,
        })
        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})

        with pytest.raises(ValueError, match="reconnect"):
            _perform_sync(str(patient["_id"]), conn)

    @responses.activate
    def test_a_rejected_refresh_raises_rather_than_syncing_nothing(
            self, app_ctx, db, patient, watch_conn):
        from services.watch_sync_service import _perform_sync

        db.watch_connections.update_one(
            {"user_id": str(patient["_id"])},
            {"$set": {"token_expires_at": time.time() - 10}},
        )
        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})

        responses.add(responses.POST, TOKEN_URL,
                      json={"error": "invalid_grant"}, status=400)

        with pytest.raises(Exception):
            _perform_sync(str(patient["_id"]), conn)
        assert db.activities.count_documents({}) == 0


# ─── Malformed and partial payloads ──────────────────────────────────────────

class TestMalformedPayload:

    @responses.activate
    def test_google_fit_http_error_propagates(self, app_ctx, db, patient, watch_conn):
        import requests
        from services.watch_sync_service import _perform_sync

        _mock_fit({"error": {"message": "backend error"}}, status=503)

        with pytest.raises(requests.HTTPError):
            _perform_sync(str(patient["_id"]), watch_conn)
        assert db.activities.count_documents({}) == 0

    @responses.activate
    def test_a_partial_page_keeps_the_usable_samples(
            self, app_ctx, db, patient, watch_conn):
        """
        Points with no value, no timestamp, or a physiologically impossible
        rate are dropped; the rest of the page still segments.
        """
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        body = _active_stream(start, minutes=20, bpm=120)
        points = body["bucket"][0]["dataset"][0]["point"]
        points.insert(4, {"startTimeNanos": "0", "value": [{"fpVal": 120.0}]})   # no time
        points.insert(9, {"startTimeNanos": str(int(start.timestamp() * 1e9)),
                          "value": []})                                          # no value
        points.insert(14, {"startTimeNanos": str(int(start.timestamp() * 1e9)),
                           "value": [{"fpVal": 900.0}]})                         # impossible
        _mock_fit(body)

        result = _perform_sync(str(patient["_id"]), watch_conn)

        assert result["new_count"] >= 1
        # No session inherited the impossible sample.
        for doc in db.activities.find({}):
            assert doc.get("mean_hr", 0) < 300

    @responses.activate
    def test_an_out_of_range_heart_rate_never_reaches_the_segmenter(
            self, app_ctx, db, patient, watch_conn):
        """
        A stream of nothing but impossible values must produce nothing, rather
        than one very vigorous session.
        """
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        _mock_fit(_hr_points(start, [900] * 40))
        result = _perform_sync(str(patient["_id"]), watch_conn)

        assert result["new_count"] == 0
        assert db.activities.count_documents({}) == 0

    @responses.activate
    def test_an_empty_bucket_list_is_not_an_error(self, app_ctx, db, patient, watch_conn):
        from services.watch_sync_service import _perform_sync

        _mock_fit({})
        result = _perform_sync(str(patient["_id"]), watch_conn)
        assert result["new_count"] == 0


# ─── Duplicates ──────────────────────────────────────────────────────────────

class TestDuplicateSessions:

    @responses.activate
    def test_the_same_window_synced_twice_stores_each_session_once(
            self, app_ctx, db, patient, watch_conn):
        """
        D19, fixed. Asserts the fix; fails against the pre-fix code.

        `_perform_sync` deliberately re-fetches an overlapping window
        (`since = last_sync - 5 min`, "to avoid gap on clock skew") and
        re-segments the overlap. Before the fix it then called `insert_one`
        unconditionally: no find-then-insert guard, and
        `db_indexes.WATCH_INDEXES` declared no unique index. So a bout inside
        the overlap was written once per sync that saw it — not a race, the
        ordinary path, every cycle.

        Activity is the stream where a duplicate costs most. Two copies of one
        20-minute bout read as two bouts, and the exercise term is applied
        twice over the same interval.

        This replays one identical window twice, which is what the overlap does
        to any session inside it.
        """
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        body = _active_stream(start, minutes=20, bpm=120)

        _mock_fit(body)
        first = _perform_sync(str(patient["_id"]), watch_conn)

        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})
        _mock_fit(body)
        second = _perform_sync(str(patient["_id"]), conn)

        assert first["new_count"] >= 1
        assert second["new_count"] == 0, "the second sync must create nothing new"
        assert second["duplicate_count"] == first["new_count"]

        docs = list(db.activities.find({}))
        assert len(docs) == first["new_count"], "each session stored exactly once"

        starts = [d["startTime"] for d in docs]
        assert len(set(starts)) == len(starts), "no two sessions share a start time"

    @responses.activate
    def test_a_genuinely_new_bout_in_a_later_window_is_still_stored(
            self, app_ctx, db, patient, watch_conn):
        """
        The negative case, and the one that matters: deduplication must not
        become "ignore everything after the first sync".

        A guard keyed too broadly — on user and source alone, say — would make
        every subsequent sync a no-op and stop the activity stream entirely,
        which is worse than the duplication it replaced.
        """
        from services.watch_sync_service import _perform_sync

        first_bout = datetime.now(UTC) - timedelta(minutes=120)
        _mock_fit(_active_stream(first_bout, minutes=20, bpm=120))
        first = _perform_sync(str(patient["_id"]), watch_conn)
        assert first["new_count"] >= 1

        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})
        later_bout = datetime.now(UTC) - timedelta(minutes=50)
        _mock_fit(_active_stream(later_bout, minutes=20, bpm=140))
        second = _perform_sync(str(patient["_id"]), conn)

        assert second["new_count"] >= 1, "a new bout must still be recorded"
        assert db.activities.count_documents({}) == first["new_count"] + second["new_count"]

    @responses.activate
    def test_a_concurrent_insert_is_skipped_rather_than_losing_the_batch(
            self, app_ctx, db, patient, watch_conn):
        """
        The race behind the guard. Two workers can both pass the `find_one`;
        `unique_google_fit_session` stops the second insert, and the service
        counts it as a duplicate instead of letting it escape.

        Simulated directly — mongomock does not enforce partial unique indexes.
        """
        from pymongo.errors import DuplicateKeyError
        from services.watch_sync_service import _perform_sync

        start = datetime.now(UTC) - timedelta(minutes=50)
        _mock_fit(_active_stream(start, minutes=20, bpm=120))

        real_insert = db.activities.insert_one
        db.activities.insert_one = lambda doc: (_ for _ in ()).throw(
            DuplicateKeyError("E11000 duplicate key: unique_google_fit_session"))
        try:
            result = _perform_sync(str(patient["_id"]), watch_conn)
        finally:
            db.activities.insert_one = real_insert

        assert result["new_count"] == 0
        assert result["duplicate_count"] >= 1
        assert db.activities.count_documents({}) == 0

    def test_the_activities_collection_now_has_a_unique_index(self):
        """
        The structural half of the D19 fix. The CGM path has
        `unique_libre_cgm_reading` as a backstop; the activity path had no
        equivalent, so nothing at any layer prevented the duplicate.
        """
        from db_indexes import ALL_INDEXES

        spec = next(s for s in ALL_INDEXES if s.name == "unique_google_fit_session")
        assert spec.collection == "activities"
        assert spec.unique is True
        # Scoped to google_fit so hand-logged activities are untouched: a
        # patient may legitimately log two activities starting at the same time.
        assert spec.partial == {"source": "google_fit"}


# ─── The scheduler's per-user interval check ─────────────────────────────────

class TestPerUserInterval:

    @staticmethod
    def _is_due(conn, now, default_interval=15):
        """The decision ``watch_scheduler`` makes, expressed over one connection."""
        interval = conn.get("sync_interval_minutes", default_interval)
        last_sync = conn.get("last_sync")
        if not last_sync:
            return True
        if isinstance(last_sync, str):
            last_sync = datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
        if last_sync.tzinfo is None:
            last_sync = last_sync.replace(tzinfo=UTC)
        return now >= last_sync + timedelta(minutes=interval)

    def test_a_never_synced_watch_is_due(self):
        assert self._is_due({}, datetime.now(UTC)) is True

    def test_a_recently_synced_watch_is_not_due(self):
        now = datetime.now(UTC)
        conn = {"sync_interval_minutes": 15, "last_sync": now - timedelta(minutes=2)}
        assert self._is_due(conn, now) is False

    def test_an_overdue_watch_is_due(self):
        now = datetime.now(UTC)
        conn = {"sync_interval_minutes": 15, "last_sync": now - timedelta(minutes=20)}
        assert self._is_due(conn, now) is True

    def test_the_z_suffixed_string_last_sync_parses_as_utc(self):
        """
        ``_perform_sync`` writes ``last_sync`` as ``"...Z"``. Parsing that as a
        naive datetime and comparing it against an aware one raises — which is
        what the ``+00:00`` replacement in the service exists to prevent.
        """
        now = datetime.now(UTC)
        conn = {"sync_interval_minutes": 15,
                "last_sync": (now - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        assert self._is_due(conn, now) is False


# ─── The fetch window ────────────────────────────────────────────────────────

class TestFetchWindow:

    @responses.activate
    def test_the_first_sync_looks_back_one_hour(self, app_ctx, db, patient, watch_conn):
        from services.watch_sync_service import SYNC_WINDOW_MINUTES, _perform_sync
        import json

        _mock_fit({"bucket": []})
        _perform_sync(str(patient["_id"]), watch_conn)

        sent = json.loads(responses.calls[0].request.body)
        span_min = (sent["endTimeMillis"] - sent["startTimeMillis"]) / 60_000
        assert abs(span_min - SYNC_WINDOW_MINUTES) < 1

    @responses.activate
    def test_a_later_sync_overlaps_the_previous_window_by_five_minutes(
            self, app_ctx, db, patient, watch_conn):
        """
        The overlap is deliberate — and it is also what makes D19 fire on every
        cycle rather than only under a race.
        """
        from services.watch_sync_service import _perform_sync
        import json

        last_sync = datetime.now(UTC) - timedelta(minutes=15)
        db.watch_connections.update_one(
            {"user_id": str(patient["_id"])},
            {"$set": {"last_sync": last_sync.strftime("%Y-%m-%dT%H:%M:%SZ")}},
        )
        conn = db.watch_connections.find_one({"user_id": str(patient["_id"])})

        _mock_fit({"bucket": []})
        _perform_sync(str(patient["_id"]), conn)

        sent = json.loads(responses.calls[0].request.body)
        started = datetime.fromtimestamp(sent["startTimeMillis"] / 1000, tz=UTC)
        assert abs((last_sync - started).total_seconds() - 300) < 2
