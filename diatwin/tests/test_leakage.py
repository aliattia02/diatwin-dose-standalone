"""
Rule 6 and rule 7, executed rather than asserted.

``schema.py`` documents the leakage guard, ``repository.py`` preserves
``observed_at``, and ``export_windows`` raises if a target is visible at its own
decision time. All three had been read and none had been *measured* over a
built dataset. This suite builds windows and checks the invariant on every one
of them.

It also records where the guard's strength actually comes from, which is not
where the code suggests. Two findings are pinned below:

*   ``export_windows``'s ``raise`` cannot fire for data that came through
    ``normalize.py``, because the normalizer clamps ``observed_at`` to
    ``max(observed, t)``. The check is a tautology on the only input it will
    ever see.
*   The guard's real dependency is that ``created_at`` is present on the
    source document. Where it is absent, ``observed_at`` falls back to the
    event time and a late-entered record becomes visible at the moment it
    describes — the exact case ``schema.py``'s docstring warns about.

Stdlib only.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from diatwin.core.grid import (
    MAX_INTERPOLATION_GAP,
    STEP,
    GridSeries,
    grid_range,
    resample,
)
from diatwin.data.normalize import normalize_glucose, normalize_meal
from diatwin.data.schema import (
    GlucoseReading,
    MealEvent,
    PatientProfile,
    PatientTimeline,
    Source,
)
from diatwin.ml.export import export_windows

UTC = timezone.utc
T0 = datetime(2026, 3, 1, 0, 0, tzinfo=UTC)
PID = "patient-1"


def _profile() -> PatientProfile:
    return PatientProfile(patient_id=PID, valid_from=T0)


def _cgm_series(hours: int = 12, *, observed_delay=timedelta(seconds=30)):
    """A dense CGM stream, observed a beat after each reading was taken."""
    out = []
    for i in range(hours * 12):
        t = T0 + timedelta(minutes=5 * i)
        out.append(GlucoseReading(
            patient_id=PID, t=t, observed_at=t + observed_delay,
            source=Source.CGM_LIBRE, source_id=f"bg{i}",
            mg_dl=120.0 + 30.0 * ((i % 24) / 24.0),
        ))
    return out


# ─── Rule 6, over a built dataset ────────────────────────────────────────────

class TestWindowsAreLeakageFree:

    def test_every_window_sees_only_what_was_observable(self):
        """
        The invariant itself, checked on each emitted row rather than trusted.

        For every window: nothing counted as knowable may have an
        ``observed_at`` after the decision time, and the target must lie
        strictly in the future of it.
        """
        timeline = PatientTimeline(
            patient_id=PID, profile=_profile(), glucose=_cgm_series(12))
        windows = export_windows(timeline, horizon=timedelta(minutes=30))

        assert windows, "the fixture must produce windows or this proves nothing"

        for w in windows:
            known = timeline.as_of(w.as_of)
            assert all(r.observed_at <= w.as_of for r in known.glucose)
            assert w.target_t > w.as_of
            assert w.n_glucose == len(known.glucose)

    def test_a_late_entered_meal_is_invisible_to_an_earlier_decision(self):
        """
        The case ``schema.py`` names: a meal eaten at 14:00 and entered at
        19:00. A 15:00 decision must not see it; a 20:00 decision must.

        This is the leakage that actually matters — filtering on ``t`` would
        admit it, and the resulting model would appear to predict post-meal
        excursions it was simply told about.
        """
        eaten = T0 + timedelta(hours=14)
        entered = T0 + timedelta(hours=19)
        meal = MealEvent(
            patient_id=PID, t=eaten, observed_at=entered,
            source=Source.PATIENT_LOG, source_id="m1", carbs_g=60.0)

        timeline = PatientTimeline(
            patient_id=PID, profile=_profile(),
            glucose=_cgm_series(24), meals=[meal])

        assert timeline.as_of(T0 + timedelta(hours=15)).meals == []
        assert timeline.as_of(T0 + timedelta(hours=18, minutes=59)).meals == []
        assert len(timeline.as_of(T0 + timedelta(hours=20)).meals) == 1

        # And no window before the entry time counts it.
        for w in export_windows(timeline, horizon=timedelta(minutes=30)):
            if w.as_of < entered:
                assert w.n_meals == 0

    def test_a_target_is_never_among_its_own_features(self):
        timeline = PatientTimeline(
            patient_id=PID, profile=_profile(), glucose=_cgm_series(12))
        by_id = {r.source_id: r for r in timeline.glucose}

        for w in export_windows(timeline, horizon=timedelta(minutes=30)):
            known_ids = {r.source_id for r in timeline.as_of(w.as_of).glucose}
            target = next(r for r in timeline.glucose if r.t == w.target_t)
            assert target.source_id not in known_ids
            assert by_id[target.source_id].mg_dl == w.target_mg_dl

    def test_no_window_is_emitted_across_a_gap(self):
        """
        Rule 7 at the window level. A dropout must reduce the number of
        training rows, not be papered over by accepting a much later reading
        as the target.
        """
        dense = _cgm_series(12)
        # Remove two hours in the middle.
        gap_start = T0 + timedelta(hours=5)
        gap_end = T0 + timedelta(hours=7)
        holed = [r for r in dense if not (gap_start <= r.t < gap_end)]

        timeline = PatientTimeline(
            patient_id=PID, profile=_profile(), glucose=holed)
        windows = export_windows(timeline, horizon=timedelta(minutes=30))

        for w in windows:
            assert not (gap_start <= w.target_t < gap_end)
            # The target is at most one stride past the requested horizon.
            assert w.target_t - (w.as_of + timedelta(minutes=30)) <= STEP

        full = export_windows(
            PatientTimeline(patient_id=PID, profile=_profile(), glucose=dense),
            horizon=timedelta(minutes=30))
        assert len(windows) < len(full), "the gap must cost windows"


# ─── Where the guard's strength actually comes from ──────────────────────────

class TestTheGuardsRealDependency:

    def test_the_export_windows_raise_is_unreachable_for_normalized_data(self):
        """
        Pinned finding, not a defect on its own.

        ``export_windows`` raises when a target reading is visible at its own
        decision time — i.e. when ``observed_at < t``. Every normalizer sets
        ``observed_at = max(observed, t)``, so that condition cannot hold for
        anything that came through ``normalize.py``.

        The check is therefore a tautology on its only realistic input. It is
        worth keeping — it catches a hand-built timeline — but it must not be
        read as evidence that the pipeline was verified. The verification is
        the window loop above.
        """
        doc = {
            "_id": "bg1", "user_id": PID, "bloodSugar": 120,
            # created_at deliberately *earlier* than the reading time
            "bloodSugarTimestamp": datetime(2026, 3, 1, 12, 0),
            "created_at": datetime(2026, 3, 1, 6, 0),
        }
        reading = normalize_glucose(doc)
        assert reading is not None
        assert reading.observed_at == reading.t, \
            "the normalizer clamps observed_at forward; it never precedes t"

        # Constructed directly — bypassing the normalizer — the guard does fire.
        bad = GlucoseReading(
            patient_id=PID, t=T0 + timedelta(hours=4),
            observed_at=T0, source=Source.CGM_LIBRE, source_id="leaky",
            mg_dl=200.0)
        timeline = PatientTimeline(
            patient_id=PID, profile=_profile(),
            glucose=sorted(_cgm_series(4) + [bad], key=lambda r: r.t))
        with pytest.raises(ValueError, match="leakage guard"):
            export_windows(timeline, horizon=timedelta(minutes=30),
                           min_history=timedelta(minutes=30))

    def test_a_meal_without_created_at_becomes_visible_at_its_own_event_time(self):
        """
        The gap the guard depends on, stated as a measurement.

        ``normalize_meal`` reads ``observed_at`` from ``created_at`` and falls
        back to the event time when it is absent. The backend does write
        ``created_at`` on meals (``meal_insulin.py:785``), so this is latent
        rather than live — but it means the leakage guard is only as good as
        that field's presence, and nothing checks for it.

        Any future write path, bulk import, or migration that omits
        ``created_at`` silently converts a late-entered meal into one that was
        knowable when it was eaten, and no test downstream would notice.
        """
        eaten = datetime(2026, 3, 1, 14, 0)

        with_created = normalize_meal({
            "_id": "m1", "user_id": PID, "timestamp": eaten,
            "created_at": datetime(2026, 3, 1, 19, 0),
            "mealType": "normal", "nutrition": {"carbs": 60},
        })
        without_created = normalize_meal({
            "_id": "m2", "user_id": PID, "timestamp": eaten,
            "mealType": "normal", "nutrition": {"carbs": 60},
        })

        assert with_created.observed_at > with_created.t     # correctly late
        assert without_created.observed_at == without_created.t

        # The consequence, spelled out: a 15:00 decision sees one and not the
        # other, though they describe the same meal.
        cutoff = datetime(2026, 3, 1, 15, 0, tzinfo=UTC)
        tl = PatientTimeline(patient_id=PID, profile=_profile(),
                             meals=[with_created, without_created])
        visible = tl.as_of(cutoff).meals
        assert [m.source_id for m in visible] == ["m2"]

    def test_as_of_includes_a_record_observed_exactly_at_the_cutoff(self):
        """
        The boundary is ``<=``. A record learned at exactly the decision time
        is knowable at it. Pinned because flipping it to ``<`` would silently
        drop one sample per window and look like nothing.
        """
        r = GlucoseReading(patient_id=PID, t=T0, observed_at=T0,
                           source=Source.CGM_LIBRE, source_id="x", mg_dl=100.0)
        tl = PatientTimeline(patient_id=PID, profile=_profile(), glucose=[r])
        assert len(tl.as_of(T0).glucose) == 1
        assert len(tl.as_of(T0 - timedelta(microseconds=1)).glucose) == 0


# ─── Rule 7: missing stays missing ───────────────────────────────────────────

class TestMissingStaysMissing:

    def test_a_gap_longer_than_the_maximum_is_never_interpolated(self):
        before = T0
        after = T0 + MAX_INTERPOLATION_GAP + STEP
        series = resample([before, after], [100.0, 200.0],
                          grid_range(before, after))

        assert series.values[0] == 100.0
        assert series.values[-1] == 200.0
        assert all(v is None for v in series.values[1:-1]), \
            "a dropout must not be bridged"

    def test_a_gap_at_exactly_the_maximum_is_interpolated(self):
        """
        The boundary, in the other direction. ``MAX_INTERPOLATION_GAP`` is
        inclusive; four missed samples is a dropout, exactly twenty minutes is
        not. Pinned so the comparison cannot drift from ``>`` to ``>=``
        unnoticed.
        """
        before = T0
        after = T0 + MAX_INTERPOLATION_GAP
        series = resample([before, after], [100.0, 200.0],
                          grid_range(before, after))
        assert all(v is not None for v in series.values)
        assert series.values[2] == pytest.approx(150.0)

    def test_nothing_is_extrapolated_outside_the_observed_span(self):
        observed_from = T0 + timedelta(hours=1)
        observed_to = T0 + timedelta(hours=2)
        grid = grid_range(T0, T0 + timedelta(hours=3))
        series = resample([observed_from, observed_to], [100.0, 120.0], grid)

        for t, v in zip(series.times, series.values):
            if t < observed_from or t > observed_to:
                assert v is None, f"extrapolated at {t}"

    def test_lag_and_lead_pad_with_none_never_with_zero(self):
        """
        A zero-padded lag is a fabricated observation of perfect euglycaemia at
        0 mg/dL, which is both impossible and exactly the kind of value a model
        will happily fit.
        """
        series = GridSeries(times=[T0 + i * STEP for i in range(5)],
                            values=[100.0, 110.0, 120.0, 130.0, 140.0])

        assert series.lag(2)[:2] == [None, None]
        assert series.lag(2)[2:] == [100.0, 110.0, 120.0]
        assert series.lead(2)[-2:] == [None, None]
        assert series.lead(2)[:3] == [120.0, 130.0, 140.0]
        assert 0 not in series.lag(2) and 0 not in series.lead(2)

    def test_coverage_and_longest_gap_describe_the_hole_honestly(self):
        values = [100.0, None, None, None, 140.0]
        series = GridSeries(times=[T0 + i * STEP for i in range(5)], values=values)

        assert series.coverage == pytest.approx(0.4)
        assert series.longest_gap() == 3 * STEP

    def test_an_empty_observation_set_yields_an_all_missing_series(self):
        grid = grid_range(T0, T0 + timedelta(hours=1))
        series = resample([], [], grid)
        assert len(series) == len(grid)
        assert series.coverage == 0.0
        assert all(v is None for v in series.values)
