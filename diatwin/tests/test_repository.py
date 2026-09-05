"""
Tests for the Mongo read path.

No database anywhere. :class:`MongoRepository` takes a database *handle* rather
than importing a driver, so the fake below is thirty lines and the suite stays
stdlib-only (Arm 5 rule 1). That is not a shortcut — it means the documents in
these tests carry the exact historical quirks
:mod:`diatwin.data.normalize` exists to absorb, written out in full where a
reader can see them, instead of whatever a fixture generator happened to emit.

What carries the weight here:

  - The window is applied *after* normalization, so a record whose timestamp is
    an ISO string is treated identically to one whose timestamp is a datetime.
    A server-side range query would silently drop the strings.
  - Drop counts are surfaced, per stream, and a stream that normalizes nothing
    is visible as a rate rather than as an empty list.
  - The insulin dual write is collapsed exactly once.
  - `meals_only` cannot be read, even deliberately.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from diatwin.data.repository import (
    MEALS_PROJECTION_COLLECTION,
    LoadReport,
    MongoRepository,
    StreamReport,
    aggregate_reports,
)


UTC = timezone.utc
T0 = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
PID = "507f1f77bcf86cd799439011"


# ─── A database that is a dict ───────────────────────────────────────────────

class FakeCollection:
    def __init__(self, docs):
        self.docs = list(docs)
        self.queries = []

    def find(self, query=None):
        self.queries.append(query)
        query = query or {}
        uid = query.get("user_id")
        return [d for d in self.docs if uid is None or d.get("user_id") == uid]

    def find_one(self, query=None):
        for d in self.find_all_matching(query or {}):
            return d
        return None

    def find_all_matching(self, query):
        out = []
        for d in self.docs:
            if all(d.get(k) == v for k, v in query.items()):
                out.append(d)
        return out

    def distinct(self, field):
        return list({d.get(field) for d in self.docs if d.get(field)})


class FakeDB:
    def __init__(self, **collections):
        self._c = {name: FakeCollection(docs) for name, docs in collections.items()}

    def __getitem__(self, name):
        return self._c.setdefault(name, FakeCollection([]))


def make_db(*, glucose=(), meals=(), medication_logs=(), activities=(), users=None):
    return FakeDB(
        blood_sugar=glucose,
        meals=meals,
        medication_logs=medication_logs,
        activities=activities,
        users=users if users is not None else [{
            "_id": PID,
            "patient_constants": {"timezone_offset_minutes": 60, "daily_reset_hour": 7},
        }],
    )


def bg(minutes, value=120.0, *, ts_style="datetime", user=PID):
    """A blood_sugar document, in one of the four historical encodings."""
    t = T0 + timedelta(minutes=minutes)
    naive = t.replace(tzinfo=None)
    stamp = {
        "datetime": naive,
        "iso": naive.isoformat(),
        "iso_z": naive.isoformat() + "Z",
        "missing": None,
    }[ts_style]
    doc = {"_id": f"bg{minutes}", "user_id": user, "bloodSugar": value,
           "created_at": naive}
    if stamp is not None:
        doc["bloodSugarTimestamp"] = stamp
    return doc


# ─── The window ──────────────────────────────────────────────────────────────

class TestWindowing:
    def test_all_four_timestamp_encodings_land_in_the_same_window(self):
        # The point of filtering after normalization. A server-side
        # {"$gte": datetime} matches the first of these and none of the others.
        db = make_db(glucose=[
            bg(0, ts_style="datetime"),
            bg(10, ts_style="iso"),
            bg(20, ts_style="iso_z"),
        ])
        tl, report = MongoRepository(db).load(PID, T0, T0 + timedelta(minutes=30))
        assert len(tl.glucose) == 3
        assert report.streams["glucose"].dropped_window == 0

    def test_records_outside_the_window_are_counted_separately_from_failures(self):
        # A record dropped for being out of range says nothing about data
        # quality; conflating the two would make every narrow query look like
        # a normalizer problem.
        db = make_db(glucose=[bg(0), bg(600), bg(1200)])
        _, report = MongoRepository(db).load(PID, T0, T0 + timedelta(minutes=30))
        g = report.streams["glucose"]
        assert g.dropped_window == 2
        assert g.dropped_normalize == 0
        assert g.normalize_failure_rate == 0.0

    def test_no_window_loads_everything(self):
        db = make_db(glucose=[bg(0), bg(100_000)])
        tl, _ = MongoRepository(db).load(PID)
        assert len(tl.glucose) == 2

    def test_a_naive_bound_is_refused(self):
        # Rule 3: one time axis. Accepting a naive bound would compare it
        # against aware timestamps and raise deep inside a comprehension, or
        # worse, silently mean something local.
        db = make_db(glucose=[bg(0)])
        with pytest.raises(ValueError, match="timezone-aware"):
            MongoRepository(db).load(PID, T0.replace(tzinfo=None))

    def test_another_patients_records_are_not_returned(self):
        # The negative case that matters most: a query that leaks one patient's
        # readings into another's timeline would be invisible in aggregate.
        db = make_db(glucose=[bg(0), bg(5, user="someone-else")])
        tl, report = MongoRepository(db).load(PID)
        assert len(tl.glucose) == 1
        assert report.streams["glucose"].fetched == 1


# ─── Drop accounting ─────────────────────────────────────────────────────────

class TestDropRates:
    def test_a_record_with_no_usable_timestamp_is_dropped_and_counted(self):
        db = make_db(glucose=[bg(0), bg(10, ts_style="missing")])
        tl, report = MongoRepository(db).load(PID)
        g = report.streams["glucose"]
        # created_at is a fallback the normalizer accepts, so this row survives
        # — the assertion is that whatever happens is *counted*, not guessed.
        assert g.fetched == 2
        assert g.kept + g.dropped == g.fetched

    def test_an_unparseable_row_is_dropped_not_mistimed(self):
        # Rule 5. A bad row silently becoming the newest record on a timeline
        # is worse than losing it.
        bad = {"_id": "x", "user_id": PID, "bloodSugar": 120,
               "bloodSugarTimestamp": "not a date", "created_at": "also not a date"}
        db = make_db(glucose=[bg(0), bad])
        tl, report = MongoRepository(db).load(PID)
        assert len(tl.glucose) == 1
        assert report.streams["glucose"].dropped_normalize == 1
        assert report.streams["glucose"].normalize_failure_rate == 0.5

    def test_a_stream_that_normalizes_nothing_shows_as_a_rate_not_an_absence(self):
        # An empty list looks the same whether the collection was empty or
        # every row failed. The rate distinguishes them.
        rubbish = [{"_id": f"r{i}", "user_id": PID} for i in range(10)]
        db = make_db(activities=rubbish)
        tl, report = MongoRepository(db).load(PID)
        a = report.streams["activity"]
        assert tl.activity == []
        assert a.fetched == 10 and a.kept == 0
        assert a.normalize_failure_rate == 1.0

    def test_empty_collection_reports_zero_rate_not_a_division_error(self):
        db = make_db()
        _, report = MongoRepository(db).load(PID)
        for s in report.streams.values():
            assert s.fetched == 0
            assert s.drop_rate == 0.0 and s.normalize_failure_rate == 0.0

    def test_worst_stream_names_the_one_to_investigate(self):
        db = make_db(
            glucose=[bg(i) for i in range(10)],
            activities=[{"_id": f"r{i}", "user_id": PID} for i in range(4)],
        )
        _, report = MongoRepository(db).load(PID)
        assert report.worst_stream.stream == "activity"


# ─── The insulin dual write ──────────────────────────────────────────────────

class TestInsulinDualWrite:
    """Rule 8: reading medication_logs and meals together doubles every bolus."""

    def _dose_pair(self):
        # The exact shapes the two write paths produce. `is_insulin` gates the
        # medication_logs branch; the meals branch reads `intendedInsulin` and
        # carries `suggestedInsulin`, which the log copy does not have.
        naive = T0.replace(tzinfo=None)
        log = {"_id": "m1", "user_id": PID, "medication": "insulin_lispro",
               "is_insulin": True, "dose": 6.0, "taken_at": naive}
        meal = {"_id": "x1", "user_id": PID, "mealType": "insulin_only",
                "timestamp": naive,
                "intendedInsulin": 6.0, "intendedInsulinType": "insulin_lispro",
                "suggestedInsulin": 5.5}
        return log, meal

    def test_the_same_dose_in_both_collections_is_counted_once(self):
        log, meal = self._dose_pair()
        db = make_db(medication_logs=[log], meals=[meal])
        tl, report = MongoRepository(db).load(PID)
        assert len(tl.insulin) == 1, "the dual write was not collapsed"
        assert report.insulin_deduped == 1

    def test_two_genuinely_different_doses_are_both_kept(self):
        # The negative case. A deduper that collapses distinct doses would pass
        # the test above and halve a patient's real insulin.
        log, meal = self._dose_pair()
        meal = dict(meal, _id="x2",
                    timestamp=(T0 + timedelta(hours=4)).replace(tzinfo=None))
        db = make_db(medication_logs=[log], meals=[meal])
        tl, report = MongoRepository(db).load(PID)
        assert len(tl.insulin) == 2
        assert report.insulin_deduped == 0


# ─── meals vs meals_only ─────────────────────────────────────────────────────

class TestMealsAuthority:
    def test_the_repository_refuses_to_read_the_projection(self):
        # Pointing the loader at meals_only would look like it worked: fewer
        # rows, no error, and no insulin at all.
        with pytest.raises(ValueError, match="refusing to read meals"):
            MongoRepository(make_db(), collections={"meals": MEALS_PROJECTION_COLLECTION})

    def test_the_refusal_explains_itself(self):
        with pytest.raises(ValueError) as exc:
            MongoRepository(make_db(), collections={"meals": MEALS_PROJECTION_COLLECTION})
        message = str(exc.value)
        assert "strict subset" in message
        assert "no insulin" in message.lower()

    def test_meals_only_is_never_queried(self):
        db = make_db(meals=[{"_id": "m", "user_id": PID, "mealType": "normal",
                             "timestamp": T0.replace(tzinfo=None),
                             "nutrition": {"carbs": 40}}])
        MongoRepository(db).load(PID)
        assert db[MEALS_PROJECTION_COLLECTION].queries == []


# ─── Profile ─────────────────────────────────────────────────────────────────

class TestProfile:
    def test_timezone_offset_comes_from_the_profile(self):
        db = make_db(glucose=[bg(0)])
        tl, report = MongoRepository(db).load(PID)
        assert report.profile_found is True
        assert tl.profile.tz_offset_min == 60
        assert tl.glucose[0].tz_offset_min == 60

    def test_a_missing_profile_is_reported_not_invented(self):
        # tz_offset_min drives every local-time feature. Defaulting it silently
        # shifts a patient's whole circadian signal by their UTC offset — D9
        # arriving through the data layer.
        db = make_db(glucose=[bg(0)], users=[])
        tl, report = MongoRepository(db).load(PID)
        assert report.profile_found is False
        assert tl.profile.tz_offset_min == 0
        assert "NOT FOUND" in report.format()


# ─── Reporting ───────────────────────────────────────────────────────────────

class TestReporting:
    def test_aggregate_flags_a_high_failure_rate(self):
        reports = [LoadReport(
            patient_id="p1",
            streams={"activity": StreamReport("activity", "activities",
                                              fetched=100, kept=50,
                                              dropped_normalize=50)},
        )]
        text = aggregate_reports(reports)
        assert "investigate" in text
        assert "50.00%" in text

    def test_aggregate_does_not_flag_a_clean_load(self):
        reports = [LoadReport(
            patient_id="p1",
            streams={"glucose": StreamReport("glucose", "blood_sugar",
                                             fetched=100, kept=100)},
        )]
        assert "investigate" not in aggregate_reports(reports)

    def test_aggregate_warns_when_the_dual_write_looks_unread(self):
        # Zero deduplication across a large insulin load means only one of the
        # two collections is being read — which halves the signal rather than
        # doubling it, and looks like clean data.
        reports = [LoadReport(
            patient_id="p1",
            insulin_deduped=0,
            streams={"insulin": StreamReport("insulin", "medication_logs+meals",
                                             fetched=500, kept=500)},
        )]
        assert "rule 8" in aggregate_reports(reports)

    def test_report_round_trips_to_json_shape(self):
        db = make_db(glucose=[bg(0)])
        _, report = MongoRepository(db).load(PID)
        d = report.to_dict()
        assert d["patient_id"] == PID
        assert d["streams"]["glucose"]["collection"] == "blood_sugar"


# ─── Discovery ───────────────────────────────────────────────────────────────

class TestDiscovery:
    def test_patient_ids_come_from_readings_not_accounts(self):
        # An account with no readings contributes nothing and would appear as a
        # 100 % drop rate — noise in a report about drop rates.
        db = make_db(glucose=[bg(0), bg(1, user="other")],
                     users=[{"_id": "ghost"}])
        assert MongoRepository(db).patient_ids() == sorted([PID, "other"])

    def test_load_many_returns_a_report_per_patient(self):
        db = make_db(glucose=[bg(0), bg(1, user="other")])
        loaded = MongoRepository(db).load_many()
        assert len(loaded) == 2
        assert all(isinstance(rep, LoadReport) for _, rep in loaded)
