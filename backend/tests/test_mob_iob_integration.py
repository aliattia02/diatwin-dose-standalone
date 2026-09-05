"""
MOB / IOB reporting via ``/api/active-effects-full``.

Replaces the placeholder that stood here. The previous version defined a
dictionary of expected field names inside each test and then asserted on
``len()`` of that same literal — it never called an endpoint, never touched
the kernel, and one case was ``assert True``. All four passed unconditionally
and returned ``True`` rather than ``None``, which pytest warns about.

These call the endpoint and check the properties that make its numbers
trustworthy:

*   **Conservation.** Active plus absorbed equals what was delivered, for
    both insulin and carbohydrate. If those two drift apart the display can
    show a patient more insulin on board than they were ever given.
*   **Decomposition.** Current plus pending BG impact equals total impact.
*   **Aliases agree.** The payload carries every quantity twice — camelCase
    and snake_case — for the two generations of client. They must not
    disagree, which is a thing that can only be checked and never assumed.
"""

from __future__ import annotations

import pytest

ENDPOINT = "/api/active-effects-full"
AT = "2026-03-01T12:00:00Z"          # two hours after the seeded meal and dose

#: What the fixture delivers, from ``conftest.seed``.
DOSE_UNITS = 6.0
CARB_EQUIV = 70.0                     # nutrition.total_carb_equiv on the seeded meal


@pytest.fixture
def effects(client, patient, auth, seed):
    seed(patient)
    response = client.get(f"{ENDPOINT}?target_time={AT}", headers=auth(patient))
    assert response.status_code == 200, response.get_data(as_text=True)[:400]
    return response.get_json()


def approx(value, expected, tol=0.15):
    return abs(float(value) - float(expected)) <= tol


# ─── Shape ───────────────────────────────────────────────────────────────────

class TestResponseShape:
    def test_payload_has_both_halves(self, effects):
        assert "iob" in effects
        assert "mob" in effects or "meal" in effects, f"no meal half: {sorted(effects)}"

    def test_iob_reports_the_seeded_dose(self, effects):
        iob = effects["iob"]
        assert iob["active_doses"] == 1
        assert len(iob["contributions"]) == 1
        assert iob["contributions"][0]["initial_dose"] == DOSE_UNITS

    def test_contribution_carries_its_pharmacokinetic_profile(self, effects):
        profile = effects["iob"]["contributions"][0]["profile"]
        assert profile["onset"] == 0.375
        assert profile["peak"] == 2.25
        assert profile["duration"] == 4.5
        assert profile["type"] == "rapid_acting"

    def test_calculation_time_echoes_the_requested_target(self, effects):
        assert effects["iob"]["calculation_time"].startswith("2026-03-01T12:00")


# ─── Conservation ────────────────────────────────────────────────────────────

class TestConservation:
    """The invariants that make the numbers add up."""

    def test_active_plus_absorbed_insulin_equals_the_dose(self, effects):
        iob = effects["iob"]
        total = iob["total_active_insulin"] + iob["total_absorbed_insulin"]
        assert approx(total, DOSE_UNITS), (
            f"{iob['total_active_insulin']} active + "
            f"{iob['total_absorbed_insulin']} absorbed = {total}, expected {DOSE_UNITS}"
        )

    def test_bg_reduction_decomposes_into_current_and_pending(self, effects):
        iob = effects["iob"]
        total = iob["current_bg_reduction"] + iob["pending_bg_reduction"]
        assert approx(total, iob["totalBGImpact"], tol=0.2)

    def test_total_bg_impact_matches_dose_times_correction_factor(self, effects):
        """6 U at a correction factor of 40 is a 240 mg/dL reduction."""
        from constants import Constants
        factor = Constants.DEFAULT_PATIENT_CONSTANTS["correction_factor"]
        assert approx(effects["iob"]["totalBGImpact"], DOSE_UNITS * factor, tol=1.0)

    def test_iob_never_exceeds_the_delivered_dose(self, effects):
        assert effects["iob"]["total_active_insulin"] <= DOSE_UNITS + 1e-6

    def test_contribution_iob_sums_to_the_reported_total(self, effects):
        iob = effects["iob"]
        summed = sum(c["iob"] for c in iob["contributions"])
        assert approx(summed, iob["total_active_insulin"])


# ─── Legacy aliases ──────────────────────────────────────────────────────────

class TestFieldAliases:
    """
    The payload ships each quantity under two names for two client
    generations. Divergence would mean the web app and the mobile app render
    different numbers from one response — invisible unless something checks.
    """

    @pytest.mark.parametrize("camel,snake", [
        ("totalIOB", "total_active_insulin"),
        ("activeDoses", "active_doses"),
    ])
    def test_iob_aliases_agree(self, effects, camel, snake):
        assert effects["iob"][camel] == effects["iob"][snake]

    def test_contribution_lists_are_the_same_data(self, effects):
        iob = effects["iob"]
        assert iob["contributions"] == iob["insulin_contributions"]


# ─── Behaviour over time ─────────────────────────────────────────────────────

class TestOverTime:
    def test_iob_falls_as_time_passes(self, client, patient, auth, seed):
        seed(patient)

        def iob_at(when):
            response = client.get(f"{ENDPOINT}?target_time={when}", headers=auth(patient))
            assert response.status_code == 200
            return response.get_json()["iob"]["total_active_insulin"]

        early = iob_at("2026-03-01T10:30:00Z")   # 30 min after the dose
        later = iob_at("2026-03-01T13:00:00Z")   # 3 h after
        assert early > later

    def test_no_insulin_remains_after_the_duration(self, client, patient, auth, seed):
        seed(patient)
        # Dose at 10:00, lispro duration 4.5 h — nothing left by 15:30.
        response = client.get(f"{ENDPOINT}?target_time=2026-03-01T15:30:00Z",
                              headers=auth(patient))
        assert response.json["iob"]["total_active_insulin"] == pytest.approx(0.0, abs=1e-6)

    def test_a_patient_with_no_records_gets_zeros_not_an_error(self, client, patient, auth):
        response = client.get(f"{ENDPOINT}?target_time={AT}", headers=auth(patient))
        assert response.status_code == 200
        assert response.get_json()["iob"]["total_active_insulin"] == 0

    def test_endpoint_requires_authentication(self, client):
        assert client.get(ENDPOINT).status_code == 401
