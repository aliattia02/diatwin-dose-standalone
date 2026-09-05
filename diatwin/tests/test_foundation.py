"""
Foundation tests for the diatwin package.

These cover the layer everything else is built on: timestamp normalization,
the dual-write collapse, grid alignment and missingness, leakage prevention,
and that the PD kernel still evaluates as a forward simulator.

Stdlib + pytest only — deliberately runnable before any ML dependency is
installed, so this suite can gate every commit rather than only the ones
that touch modelling code.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from diatwin.core.grid import (
    STEP,
    accumulate,
    build_grid,
    ceil_to_grid,
    floor_to_grid,
    resample,
)
from diatwin.data.normalize import dedupe_insulin, normalize_all, parse_time
from diatwin.data.schema import (
    ActivityEvent,
    InsulinDose,
    MealEvent,
    PatientProfile,
    PatientTimeline,
    Source,
)

UTC = timezone.utc
T0 = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


# ─── Timestamps ──────────────────────────────────────────────────────────────

class TestParseTime:
    """Every encoding the database has ever held must land on one instant."""

    @pytest.mark.parametrize("raw", [
        datetime(2026, 3, 1, 12, 0),                 # naive, as the backend writes
        datetime(2026, 3, 1, 12, 0, tzinfo=UTC),     # aware
        "2026-03-01T12:00:00",                       # ISO, no zone
        "2026-03-01T12:00:00Z",                      # ISO with Z
        "2026-03-01T12:00:00+00:00",                 # ISO with offset
        "2026-03-01 12:00:00",                       # space separator
        1772366400,                                  # epoch seconds
        1772366400000,                               # epoch milliseconds
    ])
    def test_all_encodings_agree(self, raw):
        assert parse_time(raw) == T0

    @pytest.mark.parametrize("raw", [None, "", "garbage", {}, []])
    def test_unparseable_returns_none_rather_than_now(self, raw):
        # Returning "now" for a bad row would silently place a stale record
        # at the head of the timeline, which is worse than dropping it.
        assert parse_time(raw) is None

    def test_result_is_always_utc_aware(self):
        assert parse_time("2026-03-01T14:00:00+02:00") == T0


# ─── Normalization ───────────────────────────────────────────────────────────

class TestNormalizeAll:
    def _payload(self, **overrides):
        base = dict(
            glucose_docs=[{"user_id": "p1", "bloodSugar": 142,
                           "bloodSugarTimestamp": T0, "created_at": T0}],
            meal_docs=[{"user_id": "p1", "timestamp": T0, "created_at": T0,
                        "mealType": "lunch",
                        "nutrition": {"carbs": 60, "protein": 20, "fat": 15,
                                      "absorption_type": "medium"},
                        "intendedInsulin": 6.0,
                        "intendedInsulinType": "insulin_lispro",
                        "suggestedInsulin": 5.4,
                        "insulinAdministrationTime": T0}],
            medication_docs=[{"patient_id": "p1", "medication": "insulin_lispro",
                              "dose": 6.0, "taken_at": T0, "is_insulin": True,
                              "created_at": T0}],
            activity_docs=[{"user_id": "p1", "intensity": "moderate",
                            "duration_minutes": 45, "startTime": T0,
                            "created_at": T0}],
        )
        base.update(overrides)
        return normalize_all(**base)

    def test_dual_write_collapses_to_one_dose(self):
        # The same bolus is written to medication_logs and to meals. Loading
        # both without dedupe would double IOB.
        result = self._payload()
        assert len(result["insulin"]) == 1
        assert result["dropped"]["insulin_deduped"] == 1

    def test_dedupe_keeps_the_record_carrying_suggested_units(self):
        # suggested_units only exists on the meals copy, and it is the
        # behavioural-cloning target for the RL step.
        result = self._payload()
        assert result["insulin"][0].suggested_units == 5.4

    def test_out_of_range_glucose_is_dropped(self):
        result = self._payload(glucose_docs=[
            {"user_id": "p1", "bloodSugar": 142, "bloodSugarTimestamp": T0},
            {"user_id": "p1", "bloodSugar": 9999, "bloodSugarTimestamp": T0},
            {"user_id": "p1", "bloodSugar": 3, "bloodSugarTimestamp": T0},
        ])
        assert len(result["glucose"]) == 1
        assert result["dropped"]["glucose"] == 2

    def test_insulin_only_meals_do_not_become_meal_events(self):
        result = self._payload(meal_docs=[{
            "user_id": "p1", "timestamp": T0, "mealType": "insulin_only",
            "nutrition": {"carbs": 0}, "intendedInsulin": 4.0,
            "intendedInsulinType": "insulin_lispro",
        }])
        assert result["meals"] == []
        assert len(result["insulin"]) == 1        # still counted as a dose

    def test_sedentary_activity_is_not_a_bout(self):
        # level <= 0 modulates sensitivity elsewhere; emitting it as a bout
        # would double-count.
        result = self._payload(activity_docs=[
            {"user_id": "p1", "level": 0, "duration_minutes": 60, "startTime": T0},
            {"user_id": "p1", "level": 2, "duration_minutes": 30, "startTime": T0},
        ])
        assert len(result["activity"]) == 1
        assert result["activity"][0].intensity == "moderate"

    def test_legacy_hhmm_duration_parses(self):
        result = self._payload(activity_docs=[
            {"user_id": "p1", "intensity": "light", "duration": "1:30", "startTime": T0},
        ])
        assert result["activity"][0].duration_min == 90.0


class TestDedupeInsulin:
    def _dose(self, minutes: float, units: float = 4.0, suggested=None, itype="insulin_lispro"):
        t = T0 + timedelta(minutes=minutes)
        return InsulinDose(patient_id="p1", t=t, observed_at=t, source=Source.PATIENT_LOG,
                           units=units, insulin_type=itype, suggested_units=suggested)

    def test_distinct_doses_survive(self):
        # Ten minutes apart is a real second injection, not a duplicate.
        assert len(dedupe_insulin([self._dose(0), self._dose(10)])) == 2

    def test_different_insulin_types_never_merge(self):
        doses = [self._dose(0, itype="insulin_lispro"),
                 self._dose(0, itype="insulin_glargine")]
        assert len(dedupe_insulin(doses)) == 2

    def test_within_window_merges(self):
        assert len(dedupe_insulin([self._dose(0), self._dose(1)])) == 1


# ─── Grid ────────────────────────────────────────────────────────────────────

class TestGrid:
    def test_alignment_is_absolute_not_relative(self):
        # Two patients whose data starts at different minutes must still land
        # on the same grid points, or cross-patient models compare apples to
        # oranges.
        assert floor_to_grid(datetime(2026, 3, 1, 12, 3, 17, tzinfo=UTC)) == T0
        assert ceil_to_grid(datetime(2026, 3, 1, 12, 3, 17, tzinfo=UTC)) == T0 + STEP

    def test_grid_is_inclusive_of_both_ends(self):
        grid = build_grid(T0, T0 + timedelta(hours=1))
        assert grid[0] == T0
        assert grid[-1] == T0 + timedelta(hours=1)
        assert len(grid) == 13

    def test_interpolates_small_gaps(self):
        times = [T0, T0 + timedelta(minutes=10)]
        series = resample(times, [100.0, 120.0], build_grid(T0, T0 + timedelta(minutes=10)))
        assert series.values == [100.0, 110.0, 120.0]

    def test_does_not_interpolate_across_a_dropout(self):
        # A 30-minute CGM outage must read as missing, not as a smooth ramp.
        times = [T0, T0 + timedelta(minutes=30)]
        series = resample(times, [100.0, 200.0], build_grid(T0, T0 + timedelta(minutes=30)))
        assert series.values[0] == 100.0
        assert series.values[-1] == 200.0
        assert all(v is None for v in series.values[1:-1])
        assert series.longest_gap() == timedelta(minutes=25)

    def test_never_extrapolates_beyond_observations(self):
        grid = build_grid(T0 - timedelta(minutes=15), T0 + timedelta(minutes=15))
        series = resample([T0], [100.0], grid)
        assert series.values.count(None) == len(grid) - 1

    def test_lags_are_none_padded_not_zero_padded(self):
        # A zero at the start of a lag column is a fabricated observation
        # that a model will happily learn from.
        series = resample([T0, T0 + STEP], [100.0, 110.0], build_grid(T0, T0 + STEP))
        assert series.lag(1) == [None, 100.0]
        assert series.lead(1) == [110.0, None]

    def test_accumulate_buckets_on_the_left_open_interval(self):
        grid = build_grid(T0, T0 + timedelta(minutes=10))

        class E:
            def __init__(self, t, g):
                self.t, self.g = t, g

        events = [E(T0 + timedelta(minutes=3), 40.0), E(T0 + timedelta(minutes=5), 20.0)]
        totals = accumulate(events, grid, time_of=lambda e: e.t, amount_of=lambda e: e.g)
        assert totals == [0.0, 60.0, 0.0]      # both land in (12:00, 12:05]


# ─── Leakage ─────────────────────────────────────────────────────────────────

class TestLeakageGuard:
    def test_as_of_filters_on_observation_not_event_time(self):
        """
        A meal eaten at 14:00 but entered at 19:00 must be invisible to a
        15:00 prediction. Filtering on ``t`` would let it through; the guard
        filters on ``observed_at``.
        """
        eaten, entered = T0, T0 + timedelta(hours=5)
        late = MealEvent(patient_id="p1", t=eaten, observed_at=entered,
                         source=Source.PATIENT_LOG, carbs_g=60)
        timeline = PatientTimeline(
            patient_id="p1",
            profile=PatientProfile(patient_id="p1", valid_from=T0),
            meals=[late],
        )
        assert timeline.as_of(T0 + timedelta(hours=1)).meals == []
        assert len(timeline.as_of(T0 + timedelta(hours=6)).meals) == 1

    def test_timeline_is_sorted_on_construction(self):
        late = MealEvent(patient_id="p1", t=T0 + timedelta(hours=2),
                         observed_at=T0, source=Source.PATIENT_LOG, carbs_g=10)
        early = MealEvent(patient_id="p1", t=T0, observed_at=T0,
                          source=Source.PATIENT_LOG, carbs_g=20)
        timeline = PatientTimeline(
            patient_id="p1",
            profile=PatientProfile(patient_id="p1", valid_from=T0),
            meals=[late, early],
        )
        assert [m.carbs_g for m in timeline.meals] == [20, 10]

    def test_naive_datetimes_are_rejected_at_the_boundary(self):
        with pytest.raises(ValueError, match="timezone-aware"):
            MealEvent(patient_id="p1", t=datetime(2026, 3, 1, 12, 0),
                      observed_at=T0, source=Source.PATIENT_LOG, carbs_g=10)


# ─── Simulator ───────────────────────────────────────────────────────────────

class TestPatientSim:
    """
    Behavioural checks on the kernel-as-simulator. Exact numeric agreement
    between the two language implementations is the parity harness's job;
    these assert the physics is wired up the right way round.
    """

    @pytest.fixture
    def sim(self):
        from diatwin.sim.patient import PatientSim
        profile = PatientProfile(patient_id="p1", valid_from=T0,
                                 tz_offset_min=0, daily_reset_hour=7)
        s = PatientSim(profile=profile)
        s.apply(MealEvent(patient_id="p1", t=T0, observed_at=T0,
                          source=Source.PATIENT_LOG, carbs_g=60, protein_g=20,
                          fat_g=15, absorption_type="medium", meal_type="lunch"))
        s.apply(InsulinDose(patient_id="p1", t=T0, observed_at=T0,
                            source=Source.PATIENT_LOG, units=6.0,
                            insulin_type="insulin_lispro"))
        return s

    def test_carb_equivalent_applies_protein_and_fat_factors(self, sim):
        # 60 carb + 20 protein x 0.5 + 15 fat x 0.2 = 73 g
        state = sim.state_at(T0)
        assert state.mob == pytest.approx(73.0, abs=0.5)

    def test_iob_starts_at_the_dose_and_decays_to_zero(self, sim):
        assert sim.state_at(T0).iob == pytest.approx(6.0, abs=0.1)
        # lispro duration is 4.5 h
        assert sim.state_at(T0 + timedelta(hours=5)).iob == pytest.approx(0.0, abs=1e-6)

    def test_effects_have_the_right_signs(self, sim):
        state = sim.state_at(T0 + timedelta(hours=2))
        assert state.insulin_effect < 0, "insulin must lower BG"
        assert state.meal_effect > 0, "carbs must raise BG"

    def test_future_events_are_invisible(self, sim):
        # state_at(t) must not see a dose delivered after t.
        sim.apply(InsulinDose(patient_id="p1", t=T0 + timedelta(hours=3),
                              observed_at=T0, source=Source.PATIENT_LOG,
                              units=10.0, insulin_type="insulin_lispro"))
        assert sim.state_at(T0 + timedelta(hours=1)).iob < 6.0

    def test_copy_branches_independently(self, sim):
        branch = sim.copy()
        branch.apply(InsulinDose(patient_id="p1", t=T0, observed_at=T0,
                                 source=Source.PATIENT_LOG, units=4.0,
                                 insulin_type="insulin_lispro"))
        assert branch.state_at(T0).iob > sim.state_at(T0).iob

    def test_trajectory_covers_the_whole_grid(self, sim):
        grid = build_grid(T0, T0 + timedelta(hours=2))
        assert len(sim.trajectory(grid)) == len(grid)

    def test_state_exposes_a_flat_feature_row(self, sim):
        features = sim.state_at(T0).as_features()
        assert "pd_predicted_bg" in features
        assert all(isinstance(v, float) for v in features.values())
