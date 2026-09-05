"""
The pharmacodynamic kernel.

These are the tests that matter most for what comes next. The kernel is the
model — everything the ML step learns will be measured against it, and
everything the RL step simulates will be produced by it. If its behaviour
drifts, every downstream result silently moves with it.

No database, no Flask, no fixtures beyond the constants. Properties are
asserted rather than exact values wherever possible: pinning
``calculate_iob(2.0, 5.0, lispro) == 2.4156973598687816`` would fail on any
refinement to the curve, including a correct one. What must not change is
that IOB starts at the dose, decays monotonically, and reaches zero at the
end of the duration.

Exact cross-language agreement is the parity harness's job
(``diatwin/verify/parity.py``); these cover behaviour the harness cannot see
because both implementations would be wrong together.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

import pytest

from constants import Constants
from utils import pharmacodynamics as pk

PROFILES = Constants.MEAL_ABSORPTION_PROFILES
CONSTANTS = Constants.DEFAULT_PATIENT_CONSTANTS
MEDS = CONSTANTS["medication_factors"]

#: ``medication_factors`` holds both insulins and insulin-resistance
#: modifiers (corticosteroids, contraceptives, metformin...). Only the
#: former have a pharmacokinetic curve, so IOB is meaningless for the rest.
INSULIN_TYPES = {"rapid_acting", "short_acting", "intermediate_acting",
                 "long_acting", "mixed"}
INSULINS = {k: v for k, v in MEDS.items() if v.get("type") in INSULIN_TYPES}

RAPID = {k: v for k, v in INSULINS.items() if v["type"] == "rapid_acting"}
PEAKED = {k: v for k, v in INSULINS.items() if not v.get("is_peakless")}
PEAKLESS = {k: v for k, v in INSULINS.items() if v.get("is_peakless")}

#: Both IOB and the absorbed fraction are computed by fixed-step numerical
#: integration, so the steepest curves overshoot their analytic bound by a
#: small amount. Measured at 3.3e-4 relative on the worst profile. The
#: tolerance exists to pin that magnitude, not to excuse it: if a change
#: makes the integrator worse, these tests fail.
#: Both IOB and the absorbed fraction come from fixed-step numerical
#: integration, so the curves are not *strictly* monotone — they wobble by a
#: small amount near onset and near saturation. These bounds are the measured
#: worst cases, kept tight on purpose: they document the artifact rather than
#: excuse it, and a change that makes the integrator worse fails the suite.
#:
#:   NPH IOB        rises up to 0.046 U at t~0.98h  (0.91% of a 5 U dose)
#:   very_fast MOB  rises up to 0.108 g at t~1.63h  (0.18% of a 60 g meal)
#:
#: Both are far below anything a pen can deliver or a label can state, so
#: neither is clinically visible. They matter because downstream code — the
#: stacking calculation, and anything the ML step builds — is entitled to
#: assume IOB never increases.
IOB_MONOTONIC_SLOP = 0.05      # units, on a 5 U dose
IOB_OVERSHOOT_SLOP = 0.02      # units above the delivered dose
MOB_MONOTONIC_SLOP = 0.15      # grams, on a 60 g meal

T0 = datetime(2026, 3, 1, 12, 0, 0)          # naive UTC, the kernel's convention


def profile_of(name: str) -> dict:
    p = MEDS[name]
    return {
        "onset_hours": p["onset_hours"],
        "peak_hours": p["peak_hours"],
        "duration_hours": p["duration_hours"],
        "is_peakless": p.get("is_peakless", False),
        "curve_type": p.get("curve_type"),
        "type": p.get("type"),
    }


# ─── Insulin activity ────────────────────────────────────────────────────────

class TestInsulinActivity:
    """Activity is the rate of action — a percentage, bounded, unimodal."""

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_zero_before_onset(self, name):
        p = profile_of(name)
        assert pk.calculate_insulin_activity(p["onset_hours"] * 0.5, p) == 0

    @pytest.mark.parametrize("name", sorted(INSULINS))
    def test_zero_after_duration(self, name):
        p = profile_of(name)
        if "duration_hours" not in p or p["duration_hours"] is None:
            pytest.skip(f"{name} is not duration-based")
        assert pk.calculate_insulin_activity(p["duration_hours"] + 0.1, p) == 0

    @pytest.mark.parametrize("name", sorted(INSULINS))
    def test_negative_time_is_zero(self, name):
        assert pk.calculate_insulin_activity(-1.0, profile_of(name)) == 0

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_never_exceeds_one_hundred_percent(self, name):
        p = profile_of(name)
        steps = 200
        peak = max(
            pk.calculate_insulin_activity(p["duration_hours"] * i / steps, p)
            for i in range(steps + 1)
        )
        assert peak <= 100.0 + 1e-9, f"{name} activity exceeded 100%: {peak}"

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_peak_hours_marks_the_end_of_peak_activity(self, name):
        """
        Pins what ``peak_hours`` actually means, which is not what the name
        suggests.

        The activity curve is clamped at 100%, so it does not have a single
        mode — it rises, saturates, holds a plateau, then declines. Measured
        across all eleven peaked insulins, ``peak_hours`` sits at the *end*
        of that plateau, not at its centre or its start. For NPH the plateau
        runs 2.69-6.54 h against a declared peak of 6.5 h.

        That is self-consistent and probably deliberate, but a constant
        called ``peak_hours`` that is really "hour at which peak activity
        ends" is a trap for anyone building features from it. The invariant
        worth enforcing is that the declared value lies inside the plateau.
        """
        p = profile_of(name)
        steps = 1000
        times = [p["duration_hours"] * i / steps for i in range(steps + 1)]
        values = [pk.calculate_insulin_activity(t, p) for t in times]
        ceiling = max(values)
        plateau = [t for t, v in zip(times, values) if v >= 0.99 * ceiling]

        assert plateau[0] <= p["peak_hours"] <= plateau[-1] + 0.05, (
            f"{name}: declared peak {p['peak_hours']}h falls outside the "
            f"plateau [{plateau[0]:.2f}, {plateau[-1]:.2f}]h"
        )

    @pytest.mark.parametrize("name", sorted(PEAKLESS))
    def test_peakless_insulins_stay_flat_and_capped(self, name):
        """Basal insulins are capped at 75% by design — they never spike."""
        p = profile_of(name)
        steps = 200
        values = [pk.calculate_insulin_activity(p["duration_hours"] * i / steps, p)
                  for i in range(steps + 1)]
        assert max(values) <= 75.0 + 1e-9, f"{name} exceeded the peakless cap"

    def test_faster_analogues_start_sooner_and_finish_earlier(self):
        """
        Fiasp is formulated to act sooner and clear faster than Humalog.
        This checks the constants table encodes that, since every curve is
        derived from it.
        """
        fiasp, humalog = profile_of("insulin_aspart_faster"), profile_of("insulin_lispro")
        assert fiasp["onset_hours"] < humalog["onset_hours"]
        assert fiasp["duration_hours"] < humalog["duration_hours"]

    def test_activity_is_still_active_at_the_declared_peak(self):
        """Whatever peak_hours means structurally, activity must be high there."""
        for name in sorted(PEAKED):
            p = profile_of(name)
            at_peak = pk.calculate_insulin_activity(p["peak_hours"], p)
            assert at_peak >= 90.0, f"{name}: only {at_peak:.1f}% active at its declared peak"


# ─── IOB ─────────────────────────────────────────────────────────────────────

class TestIOB:
    """IOB is the integral of remaining activity — monotone, bounded by the dose."""

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_starts_at_the_full_dose(self, name):
        assert pk.calculate_iob(0.0, 5.0, profile_of(name)) == pytest.approx(5.0, rel=0.02)

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_reaches_zero_at_end_of_duration(self, name):
        p = profile_of(name)
        assert pk.calculate_iob(p["duration_hours"], 5.0, p) == pytest.approx(0.0, abs=1e-6)
        assert pk.calculate_iob(p["duration_hours"] + 1, 5.0, p) == 0.0

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_decays_monotonically(self, name):
        """
        IOB may never increase. A rise would mean insulin reappearing in the
        body, and would break every stacking calculation built on top.
        """
        p = profile_of(name)
        steps = 100
        values = [pk.calculate_iob(p["duration_hours"] * i / steps, 5.0, p)
                  for i in range(steps + 1)]
        rises = [(i, values[i - 1], values[i]) for i in range(1, len(values))
                 if values[i] > values[i - 1] + IOB_MONOTONIC_SLOP]
        assert rises == [], f"{name}: IOB increased by more than the known artifact at {rises[:3]}"

    @pytest.mark.parametrize("name", sorted(PEAKED))
    def test_never_exceeds_the_dose(self, name):
        p = profile_of(name)
        steps = 100
        peak = max(pk.calculate_iob(p["duration_hours"] * i / steps, 5.0, p)
                   for i in range(steps + 1))
        assert peak <= 5.0 + IOB_OVERSHOOT_SLOP, f"{name}: IOB reached {peak} for a 5 U dose"

    def test_scales_linearly_with_dose(self):
        """Twice the insulin is twice the IOB — the model has no dose ceiling."""
        p = profile_of("insulin_lispro")
        for hours in (0.5, 1.0, 2.0, 3.0):
            single = pk.calculate_iob(hours, 5.0, p)
            double = pk.calculate_iob(hours, 10.0, p)
            assert double == pytest.approx(2 * single, rel=1e-9)

    def test_zero_dose_gives_zero_iob(self):
        assert pk.calculate_iob(1.0, 0.0, profile_of("insulin_lispro")) == 0.0

    def test_long_acting_still_active_when_rapid_is_finished(self):
        rapid = profile_of("insulin_lispro")          # 4.5 h
        basal = profile_of("insulin_glargine")        # 23.5 h
        assert pk.calculate_iob(6.0, 10.0, rapid) == 0.0
        assert pk.calculate_iob(6.0, 10.0, basal) > 0.0


# ─── Meal absorption ─────────────────────────────────────────────────────────

class TestMealAbsorption:
    def meal(self, carbs=60.0, absorption="medium", at=T0, **extra):
        doc = {
            "timestamp": at,
            "mealType": "lunch",
            "nutrition": {"carbs": carbs, "protein": 0.0, "fat": 0.0, "fiber": 0.0,
                          "absorption_type": absorption, "total_carb_equiv": carbs},
        }
        doc.update(extra)
        return doc

    @pytest.mark.parametrize("absorption", sorted(PROFILES))
    def test_absorbed_plus_active_equals_total(self, absorption):
        """
        Conservation. Carbs are either absorbed or still absorbing; they
        cannot go missing or be counted twice.
        """
        meal = self.meal(absorption=absorption)
        for hours in (0.0, 0.5, 1.0, 2.0, 4.0):
            result = pk.calculate_meal_active_carbs(
                meal, T0 + timedelta(hours=hours), CONSTANTS, PROFILES)
            total = result["absorbed_carbs"] + result["active_carbs"]
            assert total == pytest.approx(result["total_carbs"], rel=1e-6), (
                f"{absorption} at {hours}h: {total} != {result['total_carbs']}"
            )

    @pytest.mark.parametrize("absorption", sorted(PROFILES))
    def test_mob_decays_monotonically(self, absorption):
        meal = self.meal(absorption=absorption)
        duration = PROFILES[absorption]["duration_hours"]
        values = [
            pk.calculate_meal_active_carbs(
                meal, T0 + timedelta(hours=duration * i / 60), CONSTANTS, PROFILES)["active_carbs"]
            for i in range(61)
        ]
        rises = [i for i in range(1, len(values)) if values[i] > values[i - 1] + MOB_MONOTONIC_SLOP]
        assert rises == [], f"{absorption}: MOB increased at steps {rises[:3]}"

    def test_nothing_absorbed_at_the_moment_of_eating(self):
        result = pk.calculate_meal_active_carbs(self.meal(), T0, CONSTANTS, PROFILES)
        assert result["absorbed_carbs"] == pytest.approx(0.0, abs=1e-6)
        assert result["active_carbs"] == pytest.approx(60.0, rel=1e-6)

    def test_fast_carbs_absorb_before_slow_ones(self):
        at_one_hour = T0 + timedelta(hours=1)
        fast = pk.calculate_meal_active_carbs(
            self.meal(absorption="very_fast"), at_one_hour, CONSTANTS, PROFILES)
        slow = pk.calculate_meal_active_carbs(
            self.meal(absorption="very_slow"), at_one_hour, CONSTANTS, PROFILES)
        assert fast["absorbed_carbs"] > slow["absorbed_carbs"]

    def test_carb_equivalent_is_used_when_present(self):
        """Protein and fat contribute through ``total_carb_equiv``."""
        meal = self.meal(carbs=60.0)
        meal["nutrition"].update(protein=20.0, fat=15.0, total_carb_equiv=73.0)
        result = pk.calculate_meal_active_carbs(meal, T0, CONSTANTS, PROFILES)
        assert result["total_carbs"] == pytest.approx(73.0)

    def test_cumulative_effect_needs_carb_equivalent(self):
        """
        Characterizes a real inconsistency between two kernel functions.

        ``calculate_meal_active_carbs`` falls back to ``carbs + protein +
        fat`` when ``total_carb_equiv`` is missing, so MOB is computed.
        ``calculate_meal_cumulative_effect`` has no such fallback and returns
        0.0. The same meal therefore has active carbs but no cumulative BG
        effect, which is not a physically coherent state.

        ``diatwin.sim.patient.carb_equivalent`` always supplies the field,
        which is why the simulator does not hit this.
        """
        without = {"timestamp": T0, "mealType": "lunch",
                   "nutrition": {"carbs": 60.0, "protein": 0.0, "fat": 0.0,
                                 "absorption_type": "medium"}}
        at_one_hour = T0 + timedelta(hours=1)

        mob = pk.calculate_meal_active_carbs(without, at_one_hour, CONSTANTS, PROFILES)
        effect = pk.calculate_meal_cumulative_effect(
            without, at_one_hour, CONSTANTS, PROFILES, reset_hour=7)

        assert mob["active_carbs"] > 0, "MOB is computed from the fallback"
        assert effect == 0.0, "DEFECT: but the cumulative effect is not"


# ─── Cumulative effects ──────────────────────────────────────────────────────

class TestCumulativeEffects:
    def meal_doc(self, carbs=60.0, at=T0):
        return {"timestamp": at, "mealType": "lunch",
                "nutrition": {"carbs": carbs, "protein": 0.0, "fat": 0.0,
                              "absorption_type": "medium", "total_carb_equiv": carbs}}

    def dose_doc(self, units=6.0, at=T0, kind="insulin_lispro"):
        return {"taken_at": at, "administrationTime": at, "dose": units,
                "medication": kind, "is_insulin": True}

    def totals(self, meals, doses, at):
        return pk.calculate_total_cumulative_effects(
            meals, doses, at, CONSTANTS, PROFILES, reset_hour=7, timezone_offset_minutes=0)

    def test_signs_are_correct(self):
        result = self.totals([self.meal_doc()], [self.dose_doc()], T0 + timedelta(hours=2))
        assert result["cumulative_meal_effect"] > 0, "carbs raise BG"
        assert result["cumulative_insulin_effect"] < 0, "insulin lowers BG"

    def test_empty_inputs_give_zero(self):
        result = self.totals([], [], T0)
        assert result["cumulative_meal_effect"] == 0.0
        assert result["cumulative_insulin_effect"] == 0.0
        assert result["cumulative_net_baseline"] == 0.0

    def test_net_is_the_sum_of_parts(self):
        result = self.totals([self.meal_doc()], [self.dose_doc()], T0 + timedelta(hours=2))
        assert result["cumulative_net_baseline"] == pytest.approx(
            result["cumulative_meal_effect"] + result["cumulative_insulin_effect"], rel=1e-9)

    def test_effect_saturates_at_the_full_dose(self):
        """
        After absorption completes, the cumulative effect persists at its
        total until the daily reset — it does not decay back toward zero.
        6 U at a correction factor of 40 is a 240 mg/dL reduction.
        """
        result = self.totals([], [self.dose_doc(units=6.0)], T0 + timedelta(hours=4.5))
        assert result["cumulative_insulin_effect"] == pytest.approx(-240.0, rel=0.02)

    def test_two_doses_stack(self):
        one = self.totals([], [self.dose_doc(units=3.0)], T0 + timedelta(hours=4.5))
        two = self.totals([], [self.dose_doc(units=3.0),
                               self.dose_doc(units=3.0, at=T0 + timedelta(minutes=30))],
                          T0 + timedelta(hours=4.5))
        assert two["cumulative_insulin_effect"] < one["cumulative_insulin_effect"]

    def test_doses_before_the_daily_reset_are_excluded(self):
        """
        The cumulative accumulator resets at 07:00 local. A dose from before
        the most recent reset must not carry into today's total.
        """
        yesterday = T0 - timedelta(days=1)
        result = self.totals([], [self.dose_doc(at=yesterday)], T0)
        assert result["cumulative_insulin_effect"] == 0.0

    def test_future_events_do_not_contribute(self):
        future = T0 + timedelta(hours=3)
        result = self.totals([self.meal_doc(at=future)], [self.dose_doc(at=future)], T0)
        assert result["cumulative_meal_effect"] == 0.0
        assert result["cumulative_insulin_effect"] == 0.0


# ─── Daily reset ─────────────────────────────────────────────────────────────

class TestDailyReset:
    """
    The reset boundary decides which events count toward today. It is
    timezone-dependent, and the last five commits on this repository were
    timezone fixes — so it is worth pinning precisely.
    """

    def test_reset_is_at_the_configured_hour(self):
        reset = pk.get_daily_reset_time(datetime(2026, 3, 1, 12, 0), reset_hour=7,
                                        timezone_offset_minutes=0)
        assert reset.hour == 7
        assert reset.date() == datetime(2026, 3, 1).date()

    def test_before_the_reset_hour_belongs_to_the_previous_day(self):
        reset = pk.get_daily_reset_time(datetime(2026, 3, 1, 5, 0), reset_hour=7,
                                        timezone_offset_minutes=0)
        assert reset.date() == datetime(2026, 2, 28).date()

    def test_an_event_after_the_reset_is_within_the_current_day(self):
        assert pk.is_within_current_day(
            datetime(2026, 3, 1, 8, 0), datetime(2026, 3, 1, 12, 0),
            reset_hour=7, timezone_offset_minutes=0) is True

    def test_an_event_before_the_reset_is_not(self):
        assert pk.is_within_current_day(
            datetime(2026, 3, 1, 6, 0), datetime(2026, 3, 1, 12, 0),
            reset_hour=7, timezone_offset_minutes=0) is False

    @pytest.mark.parametrize("offset", [-480, -300, 0, 60, 120, 330, 540])
    def test_reset_shifts_with_timezone(self, offset):
        """
        The reset must land at 07:00 *local*, whatever the offset. Expressed
        in UTC that is 7 - offset/60, wrapped into the day.
        """
        reset = pk.get_daily_reset_time(datetime(2026, 3, 1, 12, 0), reset_hour=7,
                                        timezone_offset_minutes=offset)
        local_hour = (reset.hour * 60 + reset.minute + offset) % 1440 / 60
        assert local_hour == pytest.approx(7.0, abs=1e-6), (
            f"offset {offset}: reset lands at {local_hour:.2f}h local, not 07:00"
        )


# ─── Gamma absorption ────────────────────────────────────────────────────────

class TestGammaAbsorption:
    """The absorption fraction underlying every meal calculation."""

    @pytest.mark.parametrize("absorption", sorted(PROFILES))
    def test_activity_is_bounded_as_a_percentage(self, absorption):
        """
        Note the units. ``calculate_gamma_absorption`` returns an activity
        *percentage* (0-100), while ``calculate_absorbed_fraction`` returns a
        *fraction* (0-1). Two similarly named functions on different scales
        is a standing trap for callers; pinned here so the pair cannot drift
        further apart.
        """
        profile = dict(PROFILES[absorption])
        duration = profile["duration_hours"]
        for i in range(51):
            value = pk.calculate_gamma_absorption(duration * i / 50, profile)
            assert 0.0 <= value <= 100.0 + 1e-9, f"{absorption} out of range: {value}"

    @pytest.mark.parametrize("absorption", sorted(PROFILES))
    def test_fraction_is_non_decreasing(self, absorption):
        """Absorbed fraction is cumulative — it cannot go backwards."""
        profile = dict(PROFILES[absorption])
        duration = profile["duration_hours"]
        values = [pk.calculate_absorbed_fraction(duration * i / 50, profile, PROFILES)
                  for i in range(51)]
        drops = [i for i in range(1, len(values)) if values[i] < values[i - 1] - 0.01]
        assert drops == [], f"{absorption}: absorbed fraction decreased at {drops[:3]}"

    @pytest.mark.parametrize("absorption", sorted(PROFILES))
    def test_complete_by_end_of_duration(self, absorption):
        profile = dict(PROFILES[absorption])
        final = pk.calculate_absorbed_fraction(profile["duration_hours"], profile, PROFILES)
        assert final == pytest.approx(1.0, abs=0.02), (
            f"{absorption} only {final:.1%} absorbed at end of duration"
        )

    def test_no_absorption_before_the_meal(self):
        assert pk.calculate_absorbed_fraction(-1.0, dict(PROFILES["medium"]), PROFILES) == 0.0


# ─── Numerical artifacts, pinned ─────────────────────────────────────────────

class TestIntegrationArtifacts:
    """
    The two places the kernel's monotonicity invariants actually break.

    Recorded as their own tests so the magnitudes are visible and bounded.
    If someone tightens the integrator these will fail and can be tightened
    with it; if someone loosens it they fail loudly instead of silently
    degrading every IOB the app displays.
    """

    def test_nph_iob_wobble_stays_under_one_percent(self):
        p = profile_of("nph_insulin")
        steps = 100
        values = [pk.calculate_iob(p["duration_hours"] * i / steps, 5.0, p)
                  for i in range(steps + 1)]
        worst = max(values[i] - values[i - 1] for i in range(1, len(values)))
        assert 0 < worst < 0.05, f"NPH IOB rise was {worst:.6f} U, expected ~0.045"

    def test_iob_overshoot_stays_under_the_delivered_dose_plus_slop(self):
        p = profile_of("nph_insulin")
        peak = max(pk.calculate_iob(p["duration_hours"] * i / 100, 5.0, p) for i in range(101))
        assert 5.0 < peak < 5.02, f"NPH peak IOB was {peak:.6f} U for a 5 U dose"

    def test_very_fast_mob_wobble_stays_under_a_fifth_of_a_percent(self):
        meal = {"timestamp": T0, "mealType": "lunch",
                "nutrition": {"carbs": 60.0, "protein": 0.0, "fat": 0.0,
                              "absorption_type": "very_fast", "total_carb_equiv": 60.0}}
        values = [
            pk.calculate_meal_active_carbs(
                meal, T0 + timedelta(hours=2.0 * i / 60), CONSTANTS, PROFILES)["active_carbs"]
            for i in range(61)
        ]
        worst = max(values[i] - values[i - 1] for i in range(1, len(values)))
        assert 0 < worst < 0.15, f"very_fast MOB rise was {worst:.6f} g, expected ~0.108"
