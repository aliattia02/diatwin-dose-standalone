"""Dose arithmetic of the rules engine, with no database, no Flask and no Constants lookup (pure given its inputs).

Extracted verbatim from meal_insulin.calculate_suggested_insulin on 26 Sep 2026 (dose-wrapper branch). That function now
loads the patient's constants and calls compute_suggested_insulin(); tests/test_dose_math.py proves every value on a
2,592-case grid is unchanged. The hub's dose tool (tools/dose_cli.py) calls the same function with constants it is given.
"""
import logging
import math

from utils.pharmacodynamics import project_iob_at_time, project_mob_at_time

logger = logging.getLogger(__name__)


DELIVERY_STEPS = {'pen': 0.5, 'pump': 0.1}


def dose_step(patient_constants) -> float:
    step = patient_constants.get('dose_step_units')
    if step is None:
        step = DELIVERY_STEPS.get(patient_constants.get('insulin_delivery', 'pen'), 0.5)
    return float(step)


def finalise_dose(raw_total: float, patient_constants) -> float:
    """Clinician decision 26 Sep 2026: below min_dose_units → 0 U; otherwise round DOWN to the device step."""
    if raw_total < float(patient_constants.get('min_dose_units', 0.5)):
        return 0.0
    step = dose_step(patient_constants)
    return round(math.floor(raw_total / step + 1e-9) * step, 2)


class InvalidCalculationFactors(ValueError):
    """calculation_factors contained a value that is not a number; the caller falls back to its default factors."""


def compute_suggested_insulin(patient_constants, absorption_profiles, nutrition, blood_glucose=None,
                              calculation_factors=None, default_activity_coefficient=1.0, default_health_multiplier=1.0):
    """Suggested insulin from explicit inputs. `patient_constants` is what Constants(...).get_patient_constants() returns.
    default_* are used only when calculation_factors is empty (the caller derives them from activities / the user)."""
    total_carbs = nutrition['carbs']
    protein_carb_equiv = nutrition['protein'] * patient_constants['protein_factor']
    fat_carb_equiv = nutrition['fat'] * patient_constants['fat_factor']
    # Bug 6 fix: subtract fiber fully — ADA net-carb standard (fiber_factor = 1.0).
    # Mirrors pharmacodynamics.py::calculate_meal_active_carbs fallback and
    # the mobile carb-equivalents.ts fiberFactor 0.1 → 1.0 fix.
    fiber = nutrition.get('fiber', 0)
    total_carb_equiv = max(0, total_carbs + protein_carb_equiv + fat_carb_equiv - fiber)

    base_insulin = total_carb_equiv / patient_constants['insulin_to_carb_ratio']

    # Pharmacodynamic adjustments disabled (neutral 1.0)
    absorption_factor = 1.0
    meal_timing_factor = 1.0

    if calculation_factors:
        try:
            absorption_factor = 1.0
            meal_timing_factor = 1.0
            activity_coefficient = float(calculation_factors.get('activityImpact', 1.0))
            active_insulin = float(calculation_factors.get('activeInsulin', 0.0))
            active_meal_carbs = float(calculation_factors.get('activeMealCarbs', 0.0))
            cumulative_meal_effect = float(calculation_factors.get('cumulativeMealEffect', 0.0))
            cumulative_insulin_effect = float(calculation_factors.get('cumulativeInsulinEffect', 0.0))
            cumulative_net_baseline = float(calculation_factors.get('cumulativeNetBaseline', 0.0))
            absorbed_carbs = float(calculation_factors.get('absorbedCarbs', 0.0))
            absorbed_insulin = float(calculation_factors.get('absorbedInsulin', 0.0))
            pending_meal_rise = float(calculation_factors.get('pendingMealRise', 0.0))
            pending_insulin_reduction = float(calculation_factors.get('pendingInsulinReduction', 0.0))
            blood_sugar_source = calculation_factors.get('bloodSugarSource', 'unknown')
            blood_sugar_confidence = calculation_factors.get('bloodSugarConfidence', 'unknown')
            minutes_since_reading = float(calculation_factors.get('minutesSinceReading', 0))

            if 'healthMultiplier' in calculation_factors:
                health_multiplier = float(calculation_factors['healthMultiplier'])
            else:
                health_multiplier = 1.0
                medications = calculation_factors.get('medications', [])
                conditions = calculation_factors.get('conditions', [])
                for med in medications:
                    health_multiplier *= float(med['factor'])
                for condition in conditions:
                    health_multiplier *= float(condition['factor'])
        except (ValueError, TypeError) as e:
            logger.error(f"Error processing calculation factors: {e}")
            raise InvalidCalculationFactors(str(e)) from e
    else:
        absorption_factor = 1.0
        meal_timing_factor = 1.0
        activity_coefficient = default_activity_coefficient
        health_multiplier = default_health_multiplier
        active_insulin = 0.0
        active_meal_carbs = 0.0
        cumulative_meal_effect = 0.0
        cumulative_insulin_effect = 0.0
        cumulative_net_baseline = 0.0
        absorbed_carbs = 0.0
        absorbed_insulin = 0.0
        pending_meal_rise = 0.0
        pending_insulin_reduction = 0.0
        blood_sugar_source = 'unknown'
        blood_sugar_confidence = 'unknown'
        minutes_since_reading = 0

    # Apply activity impact to base_insulin directly
    adjusted_insulin = base_insulin * absorption_factor * meal_timing_factor * activity_coefficient

    # Correction insulin allows NEGATIVE values
    correction_insulin = 0
    correction_note = ''
    if blood_glucose is not None:
        correction_insulin = (blood_glucose - patient_constants['target_glucose']) / \
                             patient_constants['correction_factor']
        if blood_sugar_source == 'estimated':
            correction_note = (f'Based on estimated BG (confidence: {blood_sugar_confidence}, '
                               f'{minutes_since_reading} min since reading)')
        elif blood_sugar_source == 'target_fallback':
            correction_note = 'Based on target glucose - no recent reading available'
        else:
            correction_note = 'Based on actual BG reading'

    pre_active_total = adjusted_insulin + correction_insulin

    # ============================================================
    # PREDICTIVE OVERLAP - Using shared pharmacodynamics engine
    # ============================================================
    mob_insulin_equivalent = 0.0
    overlap_adjustment = 1.0
    projected_mob_at_peak = 0.0
    projected_iob_at_peak = 0.0
    net_bg_impact_at_peak = 0.0

    new_absorption_type = nutrition.get('absorption_type', 'medium')
    new_meal_profile = absorption_profiles.get(
        new_absorption_type, absorption_profiles['medium']
    )
    new_meal_peak = new_meal_profile.get('peak_hours', 1.5)

    if active_meal_carbs > 0 or active_insulin > 0:
        mob_insulin_equivalent = active_meal_carbs / patient_constants['insulin_to_carb_ratio']

        # Use real absorption model for MOB projection
        if active_meal_carbs > 0:
            existing_absorption_type = calculation_factors.get(
                'existingMealAbsorptionType', 'medium'
            ) if calculation_factors else 'medium'
            estimated_elapsed = 1.0  # Conservative estimate

            projected_mob_at_peak = project_mob_at_time(
                active_meal_carbs,
                estimated_elapsed,
                new_meal_peak,
                existing_absorption_type,
                absorption_profiles
            )

        # Use real insulin model for IOB projection
        if active_insulin > 0:
            estimated_insulin_elapsed = 1.5  # Conservative estimate

            # Build a default rapid-acting profile for projection
            default_insulin_profile = patient_constants.get('medication_factors', {}).get(
                'insulin_aspart', {
                    'onset_hours': 0.375,
                    'peak_hours': 2.25,
                    'duration_hours': 4.5,
                    'is_peakless': False,
                    'curve_type': 'gamma_steep',
                    'type': 'rapid_acting'
                }
            )

            projected_iob_at_peak = project_iob_at_time(
                active_insulin,
                estimated_insulin_elapsed,
                new_meal_peak,
                default_insulin_profile
            )

        # Calculate net BG impact at peak
        carb_to_bg_factor = patient_constants.get('carb_to_bg_factor', 4.0)
        correction_factor_val = patient_constants.get('correction_factor', 40)  # FIX N-2: was 50, standardised to 40 (matches pharmacodynamics.py L927 and TS layer ?? 40)
        mob_bg_impact = projected_mob_at_peak * carb_to_bg_factor
        iob_bg_impact = -projected_iob_at_peak * correction_factor_val
        net_bg_impact_at_peak = mob_bg_impact + iob_bg_impact

        # Calculate overlap adjustment factor
        if projected_mob_at_peak > 10:
            overlap_adjustment *= (1 + (projected_mob_at_peak / 100) * 0.1)
        if projected_iob_at_peak > 1:
            overlap_adjustment *= (1 - (projected_iob_at_peak / 10) * 0.2)
        overlap_adjustment = max(0.5, min(1.5, overlap_adjustment))

    # Cumulative & pending adjustments (display only)
    cumulative_adjustment = cumulative_net_baseline / patient_constants['correction_factor']
    pending_net_change = pending_meal_rise - pending_insulin_reduction
    pending_adjustment = pending_net_change / patient_constants['correction_factor']

    # MOB insulin equivalent ADDED back (carbs still need coverage)
    post_active_total = pre_active_total - active_insulin + mob_insulin_equivalent

    # Apply predictive overlap adjustment
    predictive_adjusted_total = post_active_total * overlap_adjustment

    # Apply health multiplier
    final_insulin = predictive_adjusted_total * health_multiplier

    # max(0, ...) only at FINAL step; then the minimum-dose and device-step rules (finalise_dose)
    raw_total = max(0.0, final_insulin)
    total_insulin = finalise_dose(raw_total, patient_constants)

    peak_time_map = {
        'very_fast': 0.5, 'fast': 1.0, 'medium': 1.5, 'slow': 2.5, 'very_slow': 3.5
    }
    peak_time = peak_time_map.get(new_absorption_type, 1.5)

    result = {
        'total': total_insulin,
        'breakdown': {
            'raw_total': raw_total,  # unrounded: the dose rule is applied to exactly this
            'insulin_delivery': patient_constants.get('insulin_delivery', 'pen'),
            'dose_step_units': dose_step(patient_constants),
            'min_dose_units': float(patient_constants.get('min_dose_units', 0.5)),
            'rounding': 'down_to_step',
            'carbs': round(total_carbs, 2) if total_carbs is not None else 0,
            'protein_carb_equiv': round(protein_carb_equiv, 2) if protein_carb_equiv is not None else 0,
            'fat_carb_equiv': round(fat_carb_equiv, 2) if fat_carb_equiv is not None else 0,
            'total_carb_equiv': round(total_carb_equiv, 2) if total_carb_equiv is not None else 0,
            'base_insulin': round(base_insulin, 2),
            'adjusted_insulin': round(adjusted_insulin, 2),
            'correction_insulin': round(correction_insulin, 2),
            'correction_note': correction_note,
            'pre_active_total': round(pre_active_total, 2),
            'active_insulin': round(active_insulin, 2),
            'active_meal_carbs': round(active_meal_carbs, 2),
            'mob_insulin_equivalent': round(mob_insulin_equivalent, 2),
            'post_active_total': round(post_active_total, 2),
            'overlap_adjustment': round(overlap_adjustment, 2),
            'projected_mob_at_peak': round(projected_mob_at_peak, 2),
            'projected_iob_at_peak': round(projected_iob_at_peak, 2),
            'net_bg_impact_at_peak': round(net_bg_impact_at_peak),
            'peak_time': peak_time,
            'activity_coefficient': round(activity_coefficient, 2),
            'health_multiplier': round(health_multiplier, 2),
            'absorption_factor': absorption_factor,
            'meal_timing_factor': meal_timing_factor,
            'blood_sugar_used': blood_glucose,
            'blood_sugar_source': blood_sugar_source,
            'blood_sugar_confidence': blood_sugar_confidence,
            'minutes_since_reading': round(minutes_since_reading),
            'cumulative_meal_effect': round(cumulative_meal_effect, 2),
            'cumulative_insulin_effect': round(cumulative_insulin_effect, 2),
            'cumulative_net_baseline': round(cumulative_net_baseline, 2),
            'cumulative_adjustment': round(cumulative_adjustment, 2),
            'absorbed_carbs': round(absorbed_carbs, 2),
            'absorbed_insulin': round(absorbed_insulin, 2),
            'pending_meal_rise': round(pending_meal_rise, 2),
            'pending_insulin_reduction': round(pending_insulin_reduction, 2),
            'pending_net_change': round(pending_net_change, 2),
            'pending_adjustment': round(pending_adjustment, 2),
            'total_adjustments': {
                'cumulative': round(-cumulative_adjustment, 2),
                'active': round(-(active_insulin - mob_insulin_equivalent), 2),
                'pending': round(-pending_adjustment, 2),
                'total': round(-(cumulative_adjustment + active_insulin -
                                 mob_insulin_equivalent + pending_adjustment), 2)
            }
        }
    }

    logger.debug(f"Final calculation result: {result}")
    return result
