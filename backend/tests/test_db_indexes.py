"""
Index declarations and the startup guarantee.

The index that matters is ``unique_libre_cgm_reading``. ``_save_single_reading``
does a find-then-insert, which races whenever two processes sync the same user
at once — and the LibreLinkUp scheduler starts once per gunicorn worker. The
unique index is what makes that race harmless rather than a source of duplicate
CGM readings, which inflate IOB and poison anything trained on the data.

It used to be created by a script someone had to remember to run against each
new database. These tests cover the two properties that replaced that:

  - the declarations are correct and complete
  - ``ensure_indexes`` is idempotent, and reports a failure instead of raising
    it, so a duplicate-blocked unique index cannot stop the web service booting
"""

import pytest

from db_indexes import (
    ALL_INDEXES,
    LIBRE_INDEXES,
    WATCH_INDEXES,
    IndexSpec,
    ensure_indexes,
)


# ─── A collection that records what it was asked to do ───────────────────────

class FakeCollection:
    def __init__(self, fail_with=None):
        self.calls = []
        self.fail_with = fail_with

    def create_index(self, keys, **kwargs):
        self.calls.append((keys, kwargs))
        if self.fail_with:
            raise self.fail_with
        return kwargs.get("name")


class FakeDB:
    def __init__(self, failing=()):
        self.failing = set(failing)
        self.collections = {}

    def __getitem__(self, name):
        if name not in self.collections:
            err = (Exception(f"E11000 duplicate key error on {name}")
                   if name in self.failing else None)
            self.collections[name] = FakeCollection(fail_with=err)
        return self.collections[name]


# ─── Declarations ────────────────────────────────────────────────────────────

class TestDeclarations:
    def test_the_cgm_dedupe_index_exists_and_is_unique_and_partial(self):
        # If this ever stops being unique, duplicate CGM readings become
        # possible again and nothing else in the system would notice.
        spec = next(s for s in ALL_INDEXES if s.name == "unique_libre_cgm_reading")
        assert spec.unique is True
        assert spec.partial == {"source": "libre_cgm"}
        assert spec.collection == "blood_sugar"
        assert [k for k, _ in spec.keys] == [
            "user_id", "source", "bloodSugarTimestamp"]

    def test_the_partial_filter_keeps_the_index_off_non_cgm_readings(self):
        # Without partialFilterExpression this would also apply to fingersticks
        # and manual entries, where two readings at the same second are
        # legitimate and would start being rejected.
        spec = next(s for s in ALL_INDEXES if s.name == "unique_libre_cgm_reading")
        assert spec.partial is not None, "a unique index over ALL sources would " \
            "reject legitimate duplicate manual readings"

    def test_every_index_is_named(self):
        # An unnamed index gets a generated name, which makes it impossible to
        # tell whether it already exists or to drop it deliberately.
        for spec in ALL_INDEXES:
            assert spec.name, spec.collection

    def test_index_names_are_unique(self):
        names = [s.name for s in ALL_INDEXES]
        assert len(names) == len(set(names))

    def test_every_unique_index_says_why_it_exists(self):
        # A unique constraint is a data-model decision. One with no recorded
        # reason is one nobody can safely change later.
        for spec in ALL_INDEXES:
            if spec.unique:
                assert spec.why.strip(), spec.name

    def test_all_indexes_is_the_union_of_the_two_groups(self):
        assert ALL_INDEXES == LIBRE_INDEXES + WATCH_INDEXES


# ─── ensure_indexes ──────────────────────────────────────────────────────────

class TestEnsureIndexes:
    def test_every_declared_index_is_created(self):
        db = FakeDB()
        result = ensure_indexes(db)
        assert result.ok
        assert sorted(result.created) == sorted(s.name for s in ALL_INDEXES)

    def test_unique_and_partial_are_passed_through(self):
        db = FakeDB()
        ensure_indexes(db, LIBRE_INDEXES)
        _, kwargs = next(
            call for call in db["blood_sugar"].calls
            if call[1]["name"] == "unique_libre_cgm_reading")
        assert kwargs["unique"] is True
        assert kwargs["partialFilterExpression"] == {"source": "libre_cgm"}

    def test_a_non_unique_index_does_not_get_a_unique_flag(self):
        # Passing unique=False would still be accepted by MongoDB, but sending
        # only what is meant keeps the specification comparison exact — which
        # is what makes create_index a no-op on an existing index.
        db = FakeDB()
        ensure_indexes(db, LIBRE_INDEXES)
        _, kwargs = next(
            call for call in db["blood_sugar"].calls
            if call[1]["name"] == "libre_cgm_time_range_query")
        assert "unique" not in kwargs
        assert "partialFilterExpression" not in kwargs

    def test_a_failure_is_reported_not_raised(self):
        # The property that lets this run at startup. A duplicate-blocked
        # unique index must not stop the web service booting.
        db = FakeDB(failing={"blood_sugar"})
        result = ensure_indexes(db)
        assert not result.ok
        assert any(name == "unique_libre_cgm_reading" for name, _ in result.failed)
        assert "FAILED" in result.summary()

    def test_one_failure_does_not_stop_the_others(self):
        # Otherwise a single bad collection would silently leave every
        # subsequent index uncreated.
        db = FakeDB(failing={"blood_sugar"})
        result = ensure_indexes(db)
        assert "unique_user_libre_connection" in result.created
        assert "unique_user_watch_connection" in result.created

    def test_strict_mode_raises(self):
        # What the command-line scripts want: find out on purpose.
        db = FakeDB(failing={"blood_sugar"})
        with pytest.raises(Exception, match="duplicate key"):
            ensure_indexes(db, strict=True)

    def test_calling_twice_is_harmless(self):
        # create_index is idempotent server-side; this asserts the wrapper does
        # not add state that breaks on a second call, since startup runs it
        # once per worker on every deploy.
        db = FakeDB()
        first = ensure_indexes(db)
        second = ensure_indexes(db)
        assert first.created == second.created
        assert second.ok

    def test_an_empty_spec_list_is_a_no_op(self):
        db = FakeDB()
        result = ensure_indexes(db, [])
        assert result.ok and result.created == []
