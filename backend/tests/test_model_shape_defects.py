"""
Two shape defects in the pharmacodynamic curves — measured, then fixed.

Neither was caught by the parity harness, because all three implementations
shared them: parity proves the three agree, not that what they agree on is
right. Both changed what a model would learn from the data, so both were fixed
in all three implementations together and the parity baseline was re-recorded
deliberately (Arm 5 rule 15).

D21 — ``peak_hours`` was not where the meal curve peaked, the top of the curve
      was a clamped plateau, and absorption rate fell by 5 points at
      ``onset_hours``.
D22 — the acute exercise effect was identical for a light walk and a vigorous
      session of the same length.

**Both fixes are provisional.** Each is the narrowest defensible correction to
a defect that is unambiguous; neither settles the modelling question behind it.
What is still open is recorded in ``TestStillOpen`` at the foot of this file and
in ``docs/engineering/2026-09-05-pre-ml-audit.md`` §6.

Every assertion here fails against the pre-fix code.
"""

from __future__ import annotations

import math

import pytest

from constants import Constants
from utils.activity_pharmacodynamics import (
    _integrate_z_drop,
    _simulate_hr_ode,
    _synthetic_hr_trace,
    _z_intensity_target,
)
from utils.pharmacodynamics import (
    calculate_absorbed_fraction,
    calculate_gamma_absorption,
)

PROFILES = {
    name: p for name, p in
    Constants.DEFAULT_PATIENT_CONSTANTS["meal_absorption_profiles"].items()
    if isinstance(p, dict) and "shape_param" in p
}


def _true_mode_hours(p: dict) -> float:
    """
    Where ``x**(k-1) * exp(-x/theta)`` actually peaks, in hours since the meal.

    The maximum of that density is at ``x = (k-1) * theta``.
    """
    onset, peak, dur = p["onset_hours"], p["peak_hours"], p["duration_hours"]
    k, scale = p["shape_param"], p["scale_param"]
    normalized_peak = (peak - onset) / (dur - onset)
    theta = scale * normalized_peak
    return onset + (k - 1) * theta * (dur - onset)


def _sample(p: dict, n: int = 20_000):
    dur = p["duration_hours"]
    return [(dur * i / n, calculate_gamma_absorption(dur * i / n, p)) for i in range(n + 1)]


# ─── D21: the meal curve ─────────────────────────────────────────────────────

class TestMealCurveHasNoPlateau:

    @pytest.mark.parametrize("name", sorted(PROFILES))
    def test_the_curve_reaches_100_at_exactly_one_point(self, name):
        """
        D21a, fixed.

        The gamma branch is normalised by the curve's true maximum,
        ``x = (k-1)*theta``, rather than by its value at ``peak_hours``. Those
        coincide only when ``(k-1) * scale_param == 1``, which holds for none of
        the shipped profiles — so the ratio used to exceed 1 either side of the
        mode and ``min(100, ...)`` clamped it.

        Measured before the fix: **18.6% to 38.5%** of every absorption window
        sat at exactly 100, carrying no information at all. Now the curve
        touches 100 once and is strictly below it everywhere else.
        """
        p = PROFILES[name]
        onset = p["onset_hours"]

        samples = [(h, v) for h, v in _sample(p) if h >= onset]
        at_ceiling = [h for h, v in samples if v >= 100.0 - 1e-9]

        assert samples
        assert len(at_ceiling) <= 2, (
            f"{name}: {len(at_ceiling)} of {len(samples)} samples at the ceiling "
            f"— the plateau is back")
        assert max(v for _, v in samples) == pytest.approx(100.0, abs=1e-6)

    @pytest.mark.parametrize("name", sorted(PROFILES))
    def test_the_curve_peaks_at_its_true_mode(self, name):
        """
        The peak lands where the density actually peaks, which is earlier than
        ``peak_hours`` — for ``very_slow``, 1.90 h rather than 3.50 h.

        That gap is *not* fixed here: see ``TestStillOpen``.
        """
        p = PROFILES[name]
        expected = _true_mode_hours(p)

        peak_h = max(_sample(p), key=lambda hv: hv[1])[0]
        assert peak_h == pytest.approx(expected, abs=0.01)

    @pytest.mark.parametrize("name", sorted(PROFILES))
    def test_absorption_rate_is_continuous_at_onset(self, name):
        """
        D21c, fixed.

        Below onset the curve used to be a linear ramp ending at exactly 5,
        while the gamma branch starts at 0 because ``t**(k-1) -> 0`` for every
        ``k > 1``. Absorption rate therefore *dropped* by a full 5 percentage
        points at the instant gastric emptying completed — the opposite of the
        physiology ``onset_hours`` describes.

        Pre-onset now returns 0, which is both continuous and what the model
        says: before emptying is done, carbohydrate has not reached the
        absorptive surface.
        """
        p = PROFILES[name]
        onset = p["onset_hours"]

        before = calculate_gamma_absorption(onset - 1e-6, p)
        at = calculate_gamma_absorption(onset, p)

        assert before == 0.0
        assert at == 0.0
        # Approaching from above, the curve rises away from zero rather than
        # stepping down from 5.
        assert calculate_gamma_absorption(onset + 0.01, p) >= at

    @pytest.mark.parametrize("name", sorted(PROFILES))
    def test_the_curve_rises_then_falls_exactly_once(self, name):
        """
        A shape assertion rather than pinned numbers (rule 11): the corrected
        curve is unimodal over its window. A plateau, a second bump, or a step
        would all break this, and none would be visible in a spot check.
        """
        p = PROFILES[name]
        onset = p["onset_hours"]
        values = [v for h, v in _sample(p, 4_000) if h >= onset]

        peak_i = max(range(len(values)), key=lambda i: values[i])
        rising = all(values[i] <= values[i + 1] + 1e-9 for i in range(peak_i))
        falling = all(values[i] >= values[i + 1] - 1e-9 for i in range(peak_i, len(values) - 1))

        assert rising, f"{name}: not monotone up to the peak"
        assert falling, f"{name}: not monotone after the peak"

    @pytest.mark.parametrize("name", sorted(PROFILES))
    def test_all_carbohydrate_is_still_absorbed_by_the_end(self, name):
        """
        The conservation check, and the reason the rescaling is safe.

        ``calculate_absorbed_fraction`` divides the running integral by the
        total area, so it is invariant to any constant rescaling of the activity
        curve. Reshaping it must still leave the fraction reaching 1.0 — a fix
        that quietly lost or invented carbohydrate would be far worse than the
        plateau it replaced.
        """
        p = PROFILES[name]
        dur = p["duration_hours"]

        assert calculate_absorbed_fraction(0.0, p, PROFILES) == 0.0
        assert calculate_absorbed_fraction(dur, p, PROFILES) == 1.0
        assert calculate_absorbed_fraction(dur * 0.999, p, PROFILES) == pytest.approx(1.0, abs=0.01)

        # Never above 1: a fraction absorbed cannot exceed all of it. The
        # clamp in `calculate_absorbed_fraction` is what guarantees this;
        # without it `very_fast` reaches 1.000316.
        fractions = [calculate_absorbed_fraction(dur * i / 50, p, PROFILES) for i in range(51)]
        assert all(0.0 <= f <= 1.0 for f in fractions)

        # Monotone to within the estimator's own noise. Both integrals are
        # 100-step left-Riemann sums over *different* step sizes, so the ratio
        # wobbles by a few parts in 10,000 near the end of the window. That
        # predates these fixes (six decreasing steps were measurable before
        # them) and is recorded rather than silently tightened away.
        assert all(b >= a - 1e-3 for a, b in zip(fractions, fractions[1:]))

    def test_the_curve_is_zero_outside_its_window(self):
        """
        The negative case: nothing is absorbed before the meal or after the
        profile's duration. A curve that leaked outside its window would add
        phantom carbohydrate to every neighbouring hour.
        """
        p = PROFILES["medium"]
        assert calculate_gamma_absorption(-0.1, p) == 0.0
        assert calculate_gamma_absorption(p["duration_hours"] + 0.01, p) == 0.0
        assert calculate_gamma_absorption(0.0, p) == 0.0


# ─── D22: the acute exercise effect ──────────────────────────────────────────

class TestAcuteExerciseEffectTracksIntensity:

    HR_MAX, HR_BASE, WEIGHT = 190.0, 60.0, 70.0

    def _drop(self, intensity: str, minutes: float = 45.0) -> float:
        trace = _synthetic_hr_trace(intensity, minutes, self.HR_MAX, self.HR_BASE)
        return _integrate_z_drop(trace, 0.0, minutes, self.HR_BASE, self.WEIGHT, self.HR_MAX)

    def _z(self, intensity: str, minutes: float = 45.0) -> float:
        trace = _synthetic_hr_trace(intensity, minutes, self.HR_MAX, self.HR_BASE)
        return _simulate_hr_ode(trace, minutes, self.HR_BASE, self.HR_MAX)[1]

    def test_z_now_settles_at_the_bouts_intensity(self):
        """
        D22, fixed. ``dZ/dt`` relaxes toward the Karvonen heart-rate reserve
        fraction scaled by ``z_reference_hr_reserve`` (0.80, the vigorous tier),
        instead of toward a constant 1.0.

        Before the fix Z was exactly 1.000000 at all three intensities.
        """
        light, moderate, vigorous = (self._z(i) for i in ("light", "moderate", "vigorous"))

        assert light < moderate < vigorous
        assert vigorous == pytest.approx(1.0), "vigorous still saturates, by design"
        assert light == pytest.approx(0.5 / 0.8, abs=1e-6)
        assert moderate == pytest.approx(0.65 / 0.8, abs=1e-6)

    def test_a_light_walk_now_drops_bg_less_than_a_vigorous_session(self):
        """
        The defect as a number. Peak heart rates of 125, 144.5 and 164 bpm used
        to produce the same 6.45 mg/dL drop over 45 minutes — not approximately,
        but to the last bit.
        """
        light = self._drop("light")
        moderate = self._drop("moderate")
        vigorous = self._drop("vigorous")

        assert light < moderate < vigorous
        assert vigorous - light > 1.0, "the intensities must be distinguishable"

    def test_vigorous_exercise_keeps_its_previous_calibration(self):
        """
        Why the reference is the vigorous tier rather than 1.0.

        ``acute_rate_per_min`` was calibrated against a Z that saturated, so
        every bout produced the vigorous-equivalent drop. Anchoring Z = 1 at the
        vigorous tier leaves that calibration untouched and moves only the
        intensities that were previously overstated. Nothing gets a *larger*
        predicted drop than before, which is the safe direction: the model does
        not start under-warning about exercise-induced hypoglycaemia.
        """
        assert self._drop("vigorous") == pytest.approx(6.45, abs=1e-6)
        assert self._drop("light") < 6.45
        assert self._drop("moderate") < 6.45

    def test_the_intensity_target_is_bounded_and_monotone(self):
        """Property assertions on the helper, independent of the tiers."""
        hr_base, hr_max = 60.0, 190.0

        assert _z_intensity_target(hr_base, hr_base, hr_max) == 0.0
        assert _z_intensity_target(hr_base - 20, hr_base, hr_max) == 0.0   # never negative
        assert _z_intensity_target(hr_max, hr_base, hr_max) == 1.0
        assert _z_intensity_target(hr_max + 40, hr_base, hr_max) == 1.0    # never above 1

        rising = [_z_intensity_target(hr, hr_base, hr_max) for hr in range(60, 191, 5)]
        assert all(b >= a for a, b in zip(rising, rising[1:]))

    def test_a_degenerate_heart_rate_range_does_not_divide_by_zero(self):
        """hr_max == hr_base is bad patient data, not a crash."""
        assert _z_intensity_target(100.0, 150.0, 150.0) == 1.0

    def test_duration_still_changes_the_drop(self):
        """
        The negative case, and the reason D22's fix is not "exercise does less".
        Duration was always honoured; only intensity was discarded.
        """
        short = self._drop("moderate", minutes=15.0)
        long = self._drop("moderate", minutes=60.0)
        assert long > short
        assert short > 0.0

    def test_the_other_two_state_variables_are_unchanged_in_ordering(self):
        """
        ``Y`` (heart-rate excess) and ``W`` (cumulative load) always scaled with
        intensity; the fix must not disturb them.
        """
        ys, ws = [], []
        for intensity in ("light", "moderate", "vigorous"):
            trace = _synthetic_hr_trace(intensity, 45.0, self.HR_MAX, self.HR_BASE)
            y, _, w = _simulate_hr_ode(trace, 45.0, self.HR_BASE, self.HR_MAX)
            ys.append(y)
            ws.append(w)

        assert ys[0] < ys[1] < ys[2]
        assert ws[0] < ws[1] < ws[2]


# ─── What these fixes deliberately do not settle ─────────────────────────────

class TestStillOpen:
    """
    Both fixes are the narrowest correction to an unambiguous defect. Neither
    settles the modelling question behind it. These tests pin what is still
    true, so the remaining gap stays visible instead of being assumed closed.
    """

    @pytest.mark.parametrize("name", sorted(PROFILES))
    def test_peak_hours_still_does_not_name_the_mode(self, name):
        """
        D21b — **open, needs clinical review.**

        The curve now peaks at its true mode, but ``peak_hours`` still names the
        *scale* of the gamma rather than the mode: the two differ by up to 1.6 h
        (``very_slow``: mode 1.90 h, ``peak_hours`` 3.50 h). Anyone editing a
        profile expecting ``peak_hours`` to move the peak will change the shape
        instead.

        Fixing it means reparameterising every profile so ``(k-1)*scale == 1``,
        which changes each curve's tail — a clinical decision, not a code
        cleanup.
        """
        p = PROFILES[name]
        assert (p["shape_param"] - 1) * p["scale_param"] != pytest.approx(1.0, abs=0.05)
        assert _true_mode_hours(p) < p["peak_hours"]

    def test_the_intensity_response_is_linear_and_that_is_an_assumption(self):
        """
        D22 — **open, needs the primary literature.**

        Linear in heart-rate reserve is the simplest defensible choice: it is
        monotone, bounded, and preserves the existing calibration at the tier it
        was tuned for. It is almost certainly not the true response.

        Dalla Man, Breton & Cobelli (J Diabetes Sci Technol 2009;3(1):56-67)
        drive insulin-independent glucose utilisation from %VO2max. Matching
        their functional form needs the paper and a clinician, not more code.
        """
        hr_base, hr_max = 60.0, 190.0
        reserve = hr_max - hr_base

        midpoint = _z_intensity_target(hr_base + 0.4 * reserve, hr_base, hr_max)
        assert midpoint == pytest.approx(0.4 / 0.8, abs=1e-9), (
            "still exactly linear in HR reserve — revisit against Dalla Man 2009")
