"""
The LibreLinkUp CGM sync path.

``routes/libre_routes._perform_sync`` is one of two functions in this codebase
that write clinical data into the database on a timer, with no user watching.
It had no tests. For modelling that is the worst place to have none: a fault
here does not raise, it *loses readings*, and the first symptom is a model
that trains on a stream with holes nobody knew about.

The scheduler is stubbed in ``conftest.py``, so these drive ``_perform_sync``
directly and mock only the HTTP boundary with ``responses``. Everything
between the wire and Mongo is the real code.

What is covered, and why each one earns its place:

* a successful sync — the happy path, asserted on what actually lands in
  ``blood_sugar``, not on the return value
* an expired token mid-sync — the re-authenticate-and-retry branch
* an auth failure — credentials rejected on the retry
* a malformed payload — entries with no value, no timestamp, a null graph
* a partial page — some entries usable, some not, in one response
* the same reading arriving twice — both through the find-then-insert guard
  and through the unique index that backs it (D17)
* the per-user interval check in ``libre_scheduler``

Two defects were found writing this suite; both are pinned below and named in
the test that pins them.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import pytest
import responses

UTC_NOW = datetime(2026, 9, 5, 12, 0, 0)


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def libre_conn(db, patient):
    """A connected LibreLinkUp account whose token is not near expiry."""
    from services.libre_service import encrypt_credential

    doc = {
        "user_id": str(patient["_id"]),
        "libre_patient_id": "libre-patient-1",
        "auth_token": "token-still-good",
        # _get_valid_token refreshes within 24h of expiry, so push it well out.
        "token_expires": datetime.utcnow() + timedelta(days=30),
        "base_url": "https://api-eu.libreview.io",
        "account_id": "account-1",
        "email_encrypted": encrypt_credential("patient@example.test"),
        "password_encrypted": encrypt_credential("hunter2"),
        "sync_interval_minutes": 5,
    }
    db.libre_connections.insert_one(dict(doc))
    return doc


def _graph_body(entries):
    return {"status": 0, "data": {"graphData": entries}}


def _entry(factory_ts: str, value: int, **extra):
    """One graphData entry in the shape LibreLinkUp actually returns."""
    entry = {
        "FactoryTimestamp": factory_ts,
        "Value": value,
        "type": 0,
        "isHigh": False,
        "isLow": False,
        "TrendArrow": 3,
    }
    entry.update(extra)
    return entry


def _mock_graph(entries, *, status=200, body=None):
    responses.add(
        responses.GET,
        "https://api-eu.libreview.io/llu/connections/libre-patient-1/graph",
        json=body if body is not None else _graph_body(entries),
        status=status,
    )


# ─── Happy path ──────────────────────────────────────────────────────────────

class TestSuccessfulSync:

    @responses.activate
    def test_readings_land_in_blood_sugar_with_reading_time_and_write_time(
            self, app_ctx, db, patient, libre_conn):
        """
        A successful sync writes both timestamps, and they are different things.

        ``bloodSugarTimestamp`` is when the sensor read; ``timestamp`` is when
        we learned it. ``diatwin.data.normalize`` maps the second onto
        ``observed_at``, which is the entire leakage guard (Arm 5 rule 6) — so
        a sync that collapsed them would silently make every CGM reading look
        knowable at its own reading time.
        """
        from routes.libre_routes import _perform_sync

        _mock_graph([
            _entry("9/5/2026 10:00:00 AM", 120),
            _entry("9/5/2026 10:05:00 AM", 125),
            _entry("9/5/2026 10:10:00 AM", 131),
        ])

        result = _perform_sync(str(patient["_id"]), libre_conn)

        assert result["new_count"] == 3
        assert result["skipped_count"] == 0

        rows = list(db.blood_sugar.find({"user_id": str(patient["_id"])}))
        assert len(rows) == 3
        assert sorted(r["bloodSugar"] for r in rows) == [120, 125, 131]

        for row in rows:
            assert row["source"] == "libre_cgm"
            # The reading time is preserved as a naive UTC datetime...
            assert isinstance(row["bloodSugarTimestamp"], datetime)
            assert row["bloodSugarTimestamp"].tzinfo is None
            # ...and is distinct from the write time.
            assert row["timestamp"] >= row["bloodSugarTimestamp"]

    @responses.activate
    def test_sync_records_progress_on_the_connection(
            self, app_ctx, db, patient, libre_conn):
        """``last_sync`` and the running total are what the scheduler pages on."""
        from routes.libre_routes import _perform_sync

        _mock_graph([_entry("9/5/2026 10:00:00 AM", 120)])
        _perform_sync(str(patient["_id"]), libre_conn)

        conn = db.libre_connections.find_one({"user_id": str(patient["_id"])})
        assert conn["total_readings_synced"] == 1
        assert isinstance(conn["last_sync"], datetime)

    @responses.activate
    def test_an_empty_graph_is_not_an_error(self, app_ctx, db, patient, libre_conn):
        """A sensor with nothing new is the ordinary case, not a failure."""
        from routes.libre_routes import _perform_sync

        _mock_graph([])
        result = _perform_sync(str(patient["_id"]), libre_conn)

        assert result == {"new_count": 0, "skipped_count": 0, "latest_reading": None}
        assert db.blood_sugar.count_documents({}) == 0


# ─── Token expiry and auth failure ───────────────────────────────────────────

class TestAuthFailure:

    @responses.activate
    def test_the_401_retry_reauthenticates_and_finishes_the_sync(
            self, app_ctx, db, patient, libre_conn):
        """
        D18, fixed. Asserts the fix; fails against the pre-fix code.

        `_perform_sync` catches `LibreTokenExpiredError`, writes a past
        `token_expires` to Mongo, then re-reads the document before asking
        `_get_valid_token` for a token.

        Before the fix it passed the caller's in-memory `conn_doc`, which was
        loaded *before* that write and still carried the original future
        expiry — so `needs_refresh` was False, the same stale token came back,
        and the retry re-sent the identical failing request. Measured then:
        two identical GETs, **zero** calls to the login endpoint.
        """
        from routes.libre_routes import _perform_sync

        _mock_graph([], status=401, body={"status": 0})
        responses.add(
            responses.POST,
            "https://api-eu.libreview.io/llu/auth/login",
            json={"status": 0, "data": {
                "authTicket": {"token": "token-refreshed",
                               "expires": int((datetime.utcnow() + timedelta(days=30)).timestamp())},
                "user": {"id": "account-1"},
            }},
            status=200,
        )
        responses.add(
            responses.GET,
            "https://api-eu.libreview.io/llu/connections",
            json={"status": 0, "data": [{"patientId": "libre-patient-1"}]},
            status=200,
        )
        _mock_graph([_entry("9/5/2026 10:00:00 AM", 118)])

        result = _perform_sync(str(patient["_id"]), libre_conn)

        login_calls = [c for c in responses.calls if "login" in c.request.url]
        graph_calls = [c for c in responses.calls if "graph" in c.request.url]

        assert len(login_calls) == 1, "the retry must re-authenticate exactly once"
        assert result["new_count"] == 1, "and then finish the sync"
        assert db.blood_sugar.count_documents({}) == 1

        # The retry carried the *new* token, not the stale one.
        assert graph_calls[-1].request.headers["Authorization"] == "Bearer token-refreshed"

    @responses.activate
    def test_the_failed_cycle_still_leaves_the_token_marked_expired(
            self, app_ctx, db, patient, libre_conn):
        """
        The Mongo write is kept even though the retry no longer depends on it.

        It is the fallback when a refresh fails inside the retry: the next
        scheduler cycle reloads the connection, sees an expired token, and tries
        again. Removing it as redundant would turn a recoverable failure into a
        permanently stopped CGM feed.
        """
        from routes.libre_routes import _perform_sync
        from services.libre_service import LibreAuthError

        _mock_graph([], status=401, body={"status": 0})
        responses.add(
            responses.POST,
            "https://api-eu.libreview.io/llu/auth/login",
            json={"status": 2, "error": {"message": "notAuthenticated"}},
            status=200,
        )

        with pytest.raises(LibreAuthError):
            _perform_sync(str(patient["_id"]), libre_conn)

        stored = db.libre_connections.find_one({"user_id": str(patient["_id"])})
        assert stored["token_expires"] < datetime.utcnow()

    @responses.activate
    def test_rejected_credentials_raise_rather_than_reporting_success(
            self, app_ctx, db, patient, libre_conn):
        """
        Credentials rejected during a refresh must surface.

        The scheduler catches per user and logs; what matters is that it is not
        reported as a sync of zero readings, which is indistinguishable from a
        quiet sensor. Driven through the token-expired path in the connection
        document so the refresh is genuinely attempted (see D18 above for why
        the in-cycle retry cannot reach it).
        """
        from routes.libre_routes import _perform_sync
        from services.libre_service import LibreAuthError

        db.libre_connections.update_one(
            {"user_id": str(patient["_id"])},
            {"$set": {"token_expires": datetime.utcnow() - timedelta(hours=1)}},
        )
        expired = db.libre_connections.find_one({"user_id": str(patient["_id"])})

        responses.add(
            responses.POST,
            "https://api-eu.libreview.io/llu/auth/login",
            json={"status": 2, "error": {"message": "notAuthenticated"}},
            status=200,
        )

        with pytest.raises(LibreAuthError):
            _perform_sync(str(patient["_id"]), expired)

        assert db.blood_sugar.count_documents({}) == 0

    @responses.activate
    def test_a_network_error_does_not_write_a_partial_state(
            self, app_ctx, db, patient, libre_conn):
        from routes.libre_routes import _perform_sync
        from services.libre_service import LibreConnectionError

        responses.add(
            responses.GET,
            "https://api-eu.libreview.io/llu/connections/libre-patient-1/graph",
            body=Exception("connection reset"),
        )

        with pytest.raises((LibreConnectionError, Exception)):
            _perform_sync(str(patient["_id"]), libre_conn)

        assert db.blood_sugar.count_documents({}) == 0
        conn = db.libre_connections.find_one({"user_id": str(patient["_id"])})
        assert "last_sync" not in conn or conn.get("last_sync") is None


# ─── Malformed and partial payloads ──────────────────────────────────────────

class TestMalformedPayload:

    @responses.activate
    def test_a_partial_page_keeps_the_good_entries_and_drops_the_rest(
            self, app_ctx, db, patient, libre_conn):
        """
        Mixed-quality pages are the realistic failure, not all-or-nothing ones.

        Three usable entries and three unusable ones in a single response: the
        three good readings must land, and the bad ones must not become zeros,
        nulls, or "now".
        """
        from routes.libre_routes import _perform_sync

        _mock_graph([
            _entry("9/5/2026 10:00:00 AM", 120),
            {"FactoryTimestamp": "9/5/2026 10:05:00 AM", "type": 0},      # no value
            _entry("9/5/2026 10:10:00 AM", 131),
            {"Value": 140, "type": 0},                                     # no timestamp
            _entry("not a timestamp at all", 150),                         # unparseable
            _entry("9/5/2026 10:15:00 AM", 128),
        ])

        result = _perform_sync(str(patient["_id"]), libre_conn)

        assert result["new_count"] == 3
        rows = list(db.blood_sugar.find({}))
        assert sorted(r["bloodSugar"] for r in rows) == [120, 128, 131]
        # Nothing was invented for the dropped entries.
        assert all(r["bloodSugarTimestamp"] is not None for r in rows)
        assert 140 not in [r["bloodSugar"] for r in rows]
        assert 150 not in [r["bloodSugar"] for r in rows]

    @responses.activate
    def test_a_null_graphdata_is_treated_as_empty_not_as_a_crash(
            self, app_ctx, db, patient, libre_conn):
        from routes.libre_routes import _perform_sync

        _mock_graph(None, body={"status": 0, "data": {"graphData": None}})
        result = _perform_sync(str(patient["_id"]), libre_conn)
        assert result["new_count"] == 0

    @responses.activate
    def test_a_nonzero_api_status_is_an_error_not_an_empty_sync(
            self, app_ctx, db, patient, libre_conn):
        """
        The API signals failure in the body while returning HTTP 200.

        Treating that as "no readings" is how a broken integration looks
        healthy for weeks.
        """
        from routes.libre_routes import _perform_sync
        from services.libre_service import LibreConnectionError

        _mock_graph(None, body={"status": 4, "error": {"message": "rate limited"}})

        with pytest.raises(LibreConnectionError):
            _perform_sync(str(patient["_id"]), libre_conn)

    @responses.activate
    def test_out_of_range_values_are_stored_and_quarantined_downstream(
            self, app_ctx, db, patient, libre_conn):
        """
        The sync layer does not range-check; ``diatwin.data.normalize`` does.

        This pins where the boundary is. A physiologically impossible reading
        is written to the operational store (it is what the sensor said) and
        rejected on the way into a training set. Moving that check into the
        sync would silently discard data the clinician may want to see.
        """
        from routes.libre_routes import _perform_sync
        from diatwin.data.normalize import normalize_glucose

        _mock_graph([_entry("9/5/2026 10:00:00 AM", 800)])
        _perform_sync(str(patient["_id"]), libre_conn)

        row = db.blood_sugar.find_one({})
        assert row["bloodSugar"] == 800                      # stored as observed
        assert normalize_glucose(row) is None                # refused for training


# ─── Duplicates ──────────────────────────────────────────────────────────────

class TestDuplicateReadings:

    @responses.activate
    def test_the_same_reading_synced_twice_is_stored_once(
            self, app_ctx, db, patient, libre_conn):
        """
        The overlap case. LibreLinkUp's graph endpoint returns a rolling
        window, so consecutive syncs re-deliver most of what the previous one
        already stored. Double-counting CGM would corrupt every derived rate
        of change.
        """
        from routes.libre_routes import _perform_sync

        entries = [_entry("9/5/2026 10:00:00 AM", 120),
                   _entry("9/5/2026 10:05:00 AM", 125)]
        _mock_graph(entries)
        first = _perform_sync(str(patient["_id"]), libre_conn)

        _mock_graph(entries + [_entry("9/5/2026 10:10:00 AM", 131)])
        second = _perform_sync(str(patient["_id"]), libre_conn)

        assert first["new_count"] == 2
        assert second["new_count"] == 1          # only the genuinely new one
        assert second["skipped_count"] == 2
        assert db.blood_sugar.count_documents({}) == 3

    @responses.activate
    def test_a_duplicate_reaching_the_unique_index_does_not_lose_the_batch(
            self, app_ctx, db, patient, libre_conn):
        """
        D17, fixed. Asserts the fix; fails against the pre-fix code.

        `_save_single_reading` does find-then-insert. `db_indexes.py` adds
        `unique_libre_cgm_reading` and documents it as what "makes that race
        harmless": two gunicorn workers syncing one user at once can both pass
        the `find_one` and both attempt the insert.

        Before the fix it was not harmless. `DuplicateKeyError` was caught
        nowhere in the codebase, so the loser of the race raised out of
        `_save_single_reading`, out of the `for r in readings` loop, and out of
        `_perform_sync` — discarding every reading after the collision. Only
        the first of three readings was stored.

        Now the collision is counted as a skip, which is what losing the race
        means: the other worker already stored it.

        The losing insert is simulated directly rather than by racing two
        workers, because mongomock does not enforce partial unique indexes.
        """
        from pymongo.errors import DuplicateKeyError
        import routes.libre_routes as lr

        _mock_graph([
            _entry("9/5/2026 10:00:00 AM", 120),
            _entry("9/5/2026 10:05:00 AM", 125),
            _entry("9/5/2026 10:10:00 AM", 131),
        ])

        real_insert = db.blood_sugar.insert_one
        calls = {"n": 0}

        def flaky_insert(doc):
            calls["n"] += 1
            if calls["n"] == 2:                  # the second reading loses the race
                raise DuplicateKeyError("E11000 duplicate key: unique_libre_cgm_reading")
            return real_insert(doc)

        db.blood_sugar.insert_one = flaky_insert
        try:
            result = lr._perform_sync(str(patient["_id"]), libre_conn)
        finally:
            db.blood_sugar.insert_one = real_insert

        # The reading after the collision was still attempted and stored.
        stored = sorted(r["bloodSugar"] for r in db.blood_sugar.find({}))
        assert stored == [120, 131], "the batch survived the collision"
        assert result["new_count"] == 2
        assert result["skipped_count"] == 1, "the duplicate counts as a skip"


# ─── The scheduler's per-user interval check ─────────────────────────────────

class TestPerUserInterval:
    """
    ``libre_scheduler`` runs every minute and decides per user whether a sync
    is due. The arithmetic is duplicated from the route layer, so it is worth
    pinning on its own.
    """

    @staticmethod
    def _is_due(conn, now, min_interval=4):
        """The scheduler's decision, extracted verbatim from libre_scheduler.py."""
        interval_min = max(conn.get("sync_interval_minutes", 5), min_interval)
        last_sync = conn.get("last_sync")
        if not last_sync:
            return True
        if isinstance(last_sync, str):
            last_sync = datetime.fromisoformat(last_sync.replace("Z", ""))
        return now >= last_sync + timedelta(minutes=interval_min)

    def test_a_user_never_synced_is_due_immediately(self):
        assert self._is_due({}, UTC_NOW) is True

    def test_a_user_synced_one_minute_ago_is_not_due(self):
        conn = {"sync_interval_minutes": 5, "last_sync": UTC_NOW - timedelta(minutes=1)}
        assert self._is_due(conn, UTC_NOW) is False

    def test_a_user_synced_six_minutes_ago_is_due(self):
        conn = {"sync_interval_minutes": 5, "last_sync": UTC_NOW - timedelta(minutes=6)}
        assert self._is_due(conn, UTC_NOW) is True

    def test_the_floor_overrides_a_too_aggressive_user_setting(self):
        """
        A user asking for a 1-minute interval gets 4. Without the floor a
        misconfigured account would hammer LibreLinkUp and risk the whole
        deployment's access.
        """
        conn = {"sync_interval_minutes": 1, "last_sync": UTC_NOW - timedelta(minutes=2)}
        assert self._is_due(conn, UTC_NOW) is False
        conn["last_sync"] = UTC_NOW - timedelta(minutes=5)
        assert self._is_due(conn, UTC_NOW) is True

    def test_a_string_last_sync_is_parsed_rather_than_treated_as_never(self):
        """
        ``last_sync`` is written as a datetime by the route and as a string by
        older code. Reading a string as "never synced" would sync that user on
        every scheduler tick.
        """
        conn = {"sync_interval_minutes": 5,
                "last_sync": (UTC_NOW - timedelta(minutes=1)).isoformat() + "Z"}
        assert self._is_due(conn, UTC_NOW) is False


# ─── Batch cap ───────────────────────────────────────────────────────────────

class TestBatchCap:

    @responses.activate
    def test_the_batch_cap_keeps_the_newest_readings(
            self, app_ctx, db, patient, libre_conn):
        """
        ``readings[-MAX_READINGS_PER_SYNC:]`` silently discards the oldest of an
        oversized page.

        With a 500 cap and a graph endpoint that returns ~8 hours at 5-minute
        spacing (~96 readings) the cap is never reached in normal operation, so
        this documents the behaviour rather than reporting a live loss. It
        matters after an outage, when a backfill can exceed it — and the drop
        is not counted in ``skipped_count``, so it would not appear in any log.
        """
        from routes.libre_routes import MAX_READINGS_PER_SYNC, _perform_sync

        base = datetime(2026, 9, 5, 0, 0, 0)
        n = MAX_READINGS_PER_SYNC + 10
        entries = [
            _entry((base + timedelta(minutes=5 * i)).strftime("%m/%d/%Y %I:%M:%S %p"),
                   100 + (i % 50))
            for i in range(n)
        ]
        _mock_graph(entries)

        result = _perform_sync(str(patient["_id"]), libre_conn)

        assert result["new_count"] == MAX_READINGS_PER_SYNC
        assert db.blood_sugar.count_documents({}) == MAX_READINGS_PER_SYNC

        # The ten discarded readings are the oldest, and nothing reports them.
        oldest_stored = min(r["bloodSugarTimestamp"] for r in db.blood_sugar.find({}))
        assert oldest_stored == base + timedelta(minutes=5 * 10)
        assert result["skipped_count"] == 0        # the loss is invisible
