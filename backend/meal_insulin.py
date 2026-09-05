"""
meal_insulin.py - Refactored Version
============================================================================
Meal submission, insulin calculation, and meal management endpoints.

Uses shared pharmacodynamics engine for predictive overlap calculations.
Duplicate /api/meals-only endpoint REMOVED (canonical in meal_routes.py).

Endpoints:
  POST /api/meal              - Submit a meal with insulin calculation
  GET  /api/meals             - Get meal history
  POST /api/meal/calculate    - Calculate meal nutrition & insulin (preview)
  POST /api/repair-imported-meals - Repair imported records
  GET  /api/doctor/meal-history/<id> - Doctor view of patient meals
  POST /api/import-meals      - Import meals
  DELETE /api/meal/<id>       - Delete a meal and related records

Author: DiaTwin Team
Version: 4.0 (Refactored)
============================================================================
"""

from flask import Blueprint, request, jsonify, current_app
from bson.objectid import ObjectId
import json
import traceback
from flask_cors import cross_origin
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.pharmacodynamics import (
    project_mob_at_time,
    project_iob_at_time,
)
from constants import Constants
from services.food_service import get_food_details
from config import mongo
from datetime import datetime, timedelta, timezone
import logging
import math

logger = logging.getLogger(__name__)
meal_insulin_bp = Blueprint('meal_insulin', __name__)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def safe_float_conversion(value, default=0.0):
    """Safely convert a value to float, returning default if conversion fails."""
    try:
        if value is None:
            return default
        return float(value)
    except (ValueError, TypeError):
        return default


def calculate_weighted_absorption_type(food_items):
    """
    Calculate weighted average absorption type based on carbohydrate content.
    Ensures mixed meals have accurate absorption profiles.

    Handles scanned foods (not in DB) by using their inline nutrition data.
    """
    if not food_items or len(food_items) == 0:
        return 'medium'

    absorption_values = {
        'very_fast': 5, 'fast': 4, 'medium': 3, 'slow': 2, 'very_slow': 1
    }
    reverse_map = {
        5: 'very_fast', 4: 'fast', 3: 'medium', 2: 'slow', 1: 'very_slow'
    }

    total_weight = 0
    weighted_sum = 0

    for food in food_items:
        food_details = get_food_details(food['name'])
        details = food.get('details', {})

        if not food_details:
            # ── Scanned food not in DB — use inline nutrition from Gemini ──
            carbs = safe_float_conversion(details.get('carbs', 0))
            if carbs > 0:
                absorption_type = details.get('absorption_type', 'medium')
                absorption_value = absorption_values.get(absorption_type, 3)
                weighted_sum += absorption_value * carbs
                total_weight += carbs
            continue

        portion_data = food.get('portion', {})
        measurement_type = portion_data.get('measurement_type', 'volume')
        constants = current_app.constants

        if measurement_type == 'weight':
            amount = portion_data.get('amount', 1)
            unit = portion_data.get('unit', 'g')
            serving_size = details.get('serving_size', {})
            base_w_amount = serving_size.get('w_amount', 200)
            base_w_unit = serving_size.get('w_unit', 'g')
            portion_in_grams = constants.convert_to_standard(amount, unit)
            base_in_grams = constants.convert_to_standard(base_w_amount, base_w_unit)
            if base_in_grams and base_in_grams > 0:
                ratio = portion_in_grams / base_in_grams
            else:
                continue
        else:
            amount = portion_data.get('amount', 1)
            unit = portion_data.get('unit', 'serving')
            serving_size = details.get('serving_size', {})
            base_amount = constants.convert_to_standard(
                serving_size.get('amount', 1), serving_size.get('unit', 'serving')
            )
            standard_amount = constants.convert_to_standard(amount, unit)
            if standard_amount is None or base_amount is None or base_amount == 0:
                continue
            ratio = standard_amount / base_amount

        carbs = details.get('carbs', 0) * ratio
        if carbs > 0:
            absorption_type = details.get('absorption_type', 'medium')
            absorption_value = absorption_values.get(absorption_type, 3)
            weighted_sum += absorption_value * carbs
            total_weight += carbs

    if total_weight == 0:
        return 'medium'

    average_value = round(weighted_sum / total_weight)
    return reverse_map.get(average_value, 'medium')


def apply_patient_absorption_modifiers(base_absorption_type, patient_constants):
    """Apply patient-specific absorption modifiers to the food-derived absorption type."""
    absorption_modifiers = patient_constants.get('absorption_modifiers', {
        'very_fast': 1.4, 'fast': 1.2, 'medium': 1.0, 'slow': 0.8, 'very_slow': 0.6
    })
    return absorption_modifiers.get(base_absorption_type, 1.0)


def _calculate_medication_timing_factor(current_time, daily_times, med_data, med_factor):
    """Helper function to calculate medication timing factor."""
    try:
        today_doses = [
            current_time.replace(hour=int(time_str.split(':')[0]),
                                 minute=int(time_str.split(':')[1]))
            for time_str in daily_times
        ]
        today_doses = [dose if dose <= current_time else dose - timedelta(days=1)
                       for dose in today_doses]

        if not today_doses:
            return med_factor

        last_dose = max(today_doses)
        hours_since_dose = (current_time - last_dose).total_seconds() / 3600

        onset_hours = safe_float_conversion(med_data.get('onset_hours'), 1)
        peak_hours = safe_float_conversion(med_data.get('peak_hours'), 2)
        duration_hours = safe_float_conversion(med_data.get('duration_hours'), 24)

        if hours_since_dose < onset_hours:
            return med_factor * (hours_since_dose / onset_hours)
        elif hours_since_dose < peak_hours:
            return med_factor
        elif hours_since_dose < duration_hours:
            remaining_effect = max(0, (duration_hours - hours_since_dose) / (duration_hours - peak_hours))
            return max(1.0, med_factor * remaining_effect)

        return 1.0
    except Exception as e:
        logger.warning(f"Error in timing factor calculation: {e}")
        return med_factor


def get_time_of_day_factor(time=None):
    """Get time of day factor based on current hour."""
    if time is None:
        time = datetime.now()
    hour = time.hour
    time_of_day_factors = current_app.constants.get_constant('time_of_day_factors')
    for period, data in time_of_day_factors.items():
        start_hour, end_hour = data['hours']
        if start_hour <= hour < end_hour:
            return data['factor']
    return time_of_day_factors['daytime']['factor']


def calculate_activity_impact(activities):
    """Calculate the total activity impact coefficient."""
    if not activities:
        return 1.0

    total_impact = 1.0
    for activity in activities:
        level = activity.get('level', 0)
        duration = activity.get('duration', 0)

        if isinstance(duration, str):
            try:
                hours, minutes = map(int, duration.split(':'))
                duration = hours + minutes / 60
            except Exception as e:
                logger.warning(f"Error parsing activity duration '{duration}': {e}")
                duration = 0

        activity_coefficients = current_app.constants.get_constant('activity_coefficients')
        coefficient = activity_coefficients.get(str(level), 1.0)
        duration_weight = min(duration / 2, 1)
        weighted_impact = 1.0 + ((coefficient - 1.0) * duration_weight)
        total_impact *= weighted_impact

    return total_impact


def get_meal_timing_factor(meal_type, time=None):
    """Get timing factor based on meal type and time of day."""
    if time is None:
        time = datetime.now()
    hour = time.hour
    constants = current_app.constants
    meal_timing_factors = constants.get_constant('meal_timing_factors')
    time_of_day_factors = constants.get_constant('time_of_day_factors')
    base_factor = meal_timing_factors.get(meal_type, 1.0)
    for period, data in time_of_day_factors.items():
        start_hour, end_hour = data['hours']
        if start_hour <= hour < end_hour:
            return base_factor * data['factor']
    return base_factor * time_of_day_factors['daytime']['factor']


def calculate_health_factors(user_id):
    """
    Calculate health multiplier from active conditions and medications.
    Module-level function (not nested).
    """
    try:
        user = mongo.db.users.find_one({"_id": ObjectId(user_id)})
        if not user:
            logger.warning(f"User {user_id} not found, using default health multiplier")
            return 1.0

        constants = Constants(user_id)
        patient_constants = constants.get_patient_constants()

        disease_multiplier = 1.0
        active_conditions = user.get('active_conditions', [])
        for condition in active_conditions:
            condition_data = patient_constants.get('disease_factors', {}).get(condition, {})
            if condition_data and 'factor' in condition_data:
                try:
                    disease_multiplier *= float(condition_data['factor'])
                except (ValueError, TypeError) as e:
                    logger.error(f"Invalid disease factor for condition {condition}: {e}")

        medication_multiplier = 1.0
        active_medications = user.get('active_medications', [])
        for medication in active_medications:
            med_data = patient_constants.get('medication_factors', {}).get(medication, {})
            if med_data and 'factor' in med_data:
                try:
                    medication_multiplier *= float(med_data['factor'])
                except (ValueError, TypeError) as e:
                    logger.error(f"Invalid medication factor for medication {medication}: {e}")

        return disease_multiplier * medication_multiplier

    except Exception as e:
        logger.error(f"Error calculating health factors: {str(e)}")
        return 1.0


def calculate_meal_nutrition(food_items):
    """
    Calculate total nutrition for all food items using dual measurement system.

    Handles scanned foods (not in DB) by using their inline nutrition data
    provided by Gemini rather than skipping them entirely.
    """
    total_calories = 0
    total_carbs = 0
    total_protein = 0
    total_fat = 0
    total_fiber = 0  # Bug 6 fix: track fiber so callers can subtract it (ADA net-carb standard)
    absorption_factors = []
    constants = current_app.constants

    for food in food_items:
        food_details = get_food_details(food['name'])
        details = food.get('details', {})

        if not food_details:
            # ── Scanned food not in DB — use inline nutrition from Gemini ──
            carbs   = safe_float_conversion(details.get('carbs', 0))
            protein = safe_float_conversion(details.get('protein', 0))
            fat     = safe_float_conversion(details.get('fat', 0))
            fiber   = safe_float_conversion(details.get('fiber', 0))
            total_carbs   += carbs
            total_protein += protein
            total_fat     += fat
            total_fiber   += fiber
            total_calories += (carbs * 4) + (protein * 4) + (fat * 9)
            absorption_factors.append(details.get('absorption_type', 'medium'))
            continue

        portion_data = food.get('portion', {})
        measurement_type = portion_data.get('measurement_type', 'volume')

        if measurement_type == 'weight':
            amount = portion_data.get('amount', 1)
            unit = portion_data.get('unit', 'g')
            serving_size = details.get('serving_size', {})
            base_w_amount = serving_size.get('w_amount', 200)
            base_w_unit = serving_size.get('w_unit', 'g')
            portion_in_grams = constants.convert_to_standard(amount, unit)
            base_in_grams = constants.convert_to_standard(base_w_amount, base_w_unit)
            if base_in_grams and base_in_grams > 0:
                ratio = portion_in_grams / base_in_grams
            else:
                continue
        else:
            amount = portion_data.get('amount', 1)
            unit = portion_data.get('unit', 'serving')
            serving_size = details.get('serving_size', {})
            base_amount = constants.convert_to_standard(
                serving_size.get('amount', 1), serving_size.get('unit', 'serving')
            )
            standard_amount = constants.convert_to_standard(amount, unit)
            if standard_amount is None or base_amount is None or base_amount == 0:
                continue
            ratio = standard_amount / base_amount

        carbs = details.get('carbs', 0) * ratio
        protein = details.get('protein', 0) * ratio
        fat = details.get('fat', 0) * ratio
        fiber = details.get('fiber', 0) * ratio  # Bug 6 fix: track fiber

        total_carbs += carbs
        total_protein += protein
        total_fat += fat
        total_fiber += fiber  # Bug 6 fix
        total_calories += (carbs * 4) + (protein * 4) + (fat * 9)
        absorption_factors.append(details.get('absorption_type', 'medium'))

    weighted_absorption_type = calculate_weighted_absorption_type(food_items)

    absorption_types = current_app.constants.get_constant('absorption_modifiers', {
        'very_fast': 1.4, 'fast': 1.2, 'medium': 1.0, 'slow': 0.8, 'very_slow': 0.6
    })

    weighted_absorption_factor = apply_patient_absorption_modifiers(
        weighted_absorption_type, {'absorption_modifiers': absorption_types}
    )

    return {
        'calories': round(total_calories, 1),
        'carbs': round(total_carbs, 1),
        'protein': round(total_protein, 1),
        'fat': round(total_fat, 1),
        'fiber': round(total_fiber, 1),  # Bug 6 fix: exposed so callers can subtract it
        'absorption_factor': round(weighted_absorption_factor, 2),
        'absorption_type': weighted_absorption_type,
        'absorption_metadata': {
            'weighted_type': weighted_absorption_type,
            'patient_modifier': weighted_absorption_factor,
            'food_types': absorption_factors
        }
    }


# ============================================================================
# INSULIN CALCULATION
# ============================================================================

def calculate_suggested_insulin(user_id, nutrition, activities, blood_glucose=None,
                                meal_type='normal', calculation_factors=None):
    """
    Calculate suggested insulin dose.

    Uses shared pharmacodynamics for predictive overlap instead of
    simplified linear/exponential approximations.
    """
    try:
        constants = Constants(user_id)
        patient_constants = constants.get_patient_constants()
        absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES

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
                return calculate_default_factors(nutrition, activities, meal_type, user_id)
        else:
            absorption_factor = 1.0
            meal_timing_factor = 1.0
            activity_coefficient = calculate_activity_impact(activities)
            health_multiplier = calculate_health_factors(user_id)
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

        # max(0, ...) only at FINAL step
        total_insulin = max(0, round(final_insulin, 1))

        # Safety threshold
        if pre_active_total > 0 and total_insulin < 0.5:
            total_insulin = 0.5

        peak_time_map = {
            'very_fast': 0.5, 'fast': 1.0, 'medium': 1.5, 'slow': 2.5, 'very_slow': 3.5
        }
        peak_time = peak_time_map.get(new_absorption_type, 1.5)

        result = {
            'total': total_insulin,
            'breakdown': {
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

    except Exception as e:
        logger.error(f"Error in calculate_suggested_insulin: {str(e)}")
        raise


# ============================================================================
# API ENDPOINTS
# ============================================================================

@meal_insulin_bp.route('/api/meal', methods=['POST'])
@token_required
@api_error_handler
def submit_meal(current_user):
    # I-12: `bloodSugar` in the request payload is ALWAYS expected in mg/dL.
    # The frontend (MealForm.tsx) converts mmol/L → mg/dL before submission.
    # `bloodSugarUnit` is forwarded for logging/debugging only and is ignored
    # for all storage and calculation purposes.
    try:
        data = request.json
        required_fields = ['mealType', 'foodItems']
        if not all(field in data for field in required_fields):
            return jsonify({"error": "Missing required fields"}), 400

        supported_measurements = current_app.constants.get_supported_measurements()

        for item in data['foodItems']:
            portion = item.get('portion', {})
            unit = portion.get('unit')
            measurement_type = portion.get('measurement_type', 'volume')

            if not portion or not unit:
                continue

            if measurement_type == 'weight':
                if unit not in supported_measurements['weight']:
                    return jsonify({
                        "error": f"Unsupported weight measurement: {unit}",
                        "supported_measurements": supported_measurements
                    }), 400
            elif measurement_type == 'volume':
                if unit not in supported_measurements['volume']:
                    return jsonify({
                        "error": f"Unsupported volume measurement: {unit}",
                        "supported_measurements": supported_measurements
                    }), 400
            else:
                if unit not in supported_measurements['standard_portions']:
                    return jsonify({
                        "error": f"Unsupported standard portion: {unit}",
                        "supported_measurements": supported_measurements
                    }), 400

        nutrition = calculate_meal_nutrition(data['foodItems'])

        constants = Constants(str(current_user['_id']))
        patient_constants = constants.get_patient_constants()

        protein_factor = patient_constants.get('protein_factor', 0.5)
        fat_factor = patient_constants.get('fat_factor', 0.2)

        # Bug 6 fix: subtract fiber fully — ADA net-carb standard (fiber_factor = 1.0).
        # calculate_meal_nutrition now returns 'fiber'; fall back to 0 for legacy records.
        nutrition['total_carb_equiv'] = round(
            max(0,
                nutrition['carbs'] +
                (nutrition['protein'] * protein_factor) +
                (nutrition['fat'] * fat_factor) -
                nutrition.get('fiber', 0)
            ), 1
        )

        logger.info(f"Calculated total_carb_equiv: {nutrition['total_carb_equiv']}g")

        calculation_factors = data.get('calculationFactors')

        # ✅ FIX: When the user did not type a BG directly (estimated / target-fallback),
        # the frontend sends null for top-level `bloodSugar` to avoid creating a DB record,
        # but it always includes the actual BG used in calculationFactors.bloodSugarUsed.
        # Fall back to that value so correction insulin is calculated correctly.
        blood_glucose_for_calc = data.get('bloodSugar')
        if blood_glucose_for_calc is None and calculation_factors:
            bg_used = calculation_factors.get('bloodSugarUsed')
            if bg_used is not None:
                try:
                    blood_glucose_for_calc = float(bg_used)
                    logger.info(
                        f"Using calculationFactors.bloodSugarUsed={blood_glucose_for_calc} "
                        f"(source: {calculation_factors.get('bloodSugarSource', 'unknown')})"
                    )
                except (ValueError, TypeError):
                    pass

        meal_timestamp = datetime.utcnow()
        if data.get('mealTime'):
            try:
                time_str = data['mealTime'].replace('Z', '+00:00')
                meal_timestamp = datetime.fromisoformat(time_str)
                if meal_timestamp.tzinfo is not None:
                    meal_timestamp = meal_timestamp.replace(tzinfo=None)
            except (ValueError, TypeError) as e:
                logger.warning(f"Error parsing meal time: {e}. Using current time.")

        record_created_at = datetime.utcnow()

        insulin_calc = calculate_suggested_insulin(
            str(current_user['_id']),
            nutrition,
            data.get('activities', []),
            blood_glucose_for_calc,   # ✅ FIX: uses estimated BG when no direct reading
            data['mealType'],
            calculation_factors
        )

        user = mongo.db.users.find_one({"_id": current_user['_id']})
        active_conditions = user.get('active_conditions', [])
        active_medications = user.get('active_medications', [])

        administration_time = meal_timestamp
        if data.get('insulinTimestamp'):
            # Frontend sends the actual time the user took insulin as `insulinTimestamp`.
            # This is distinct from `mealTime` (which is meal_timestamp, potentially
            # snapped forward by the timing offset). Always prefer insulinTimestamp
            # when present so scheduled_time/taken_at reflect when the dose was given,
            # not when the meal will be eaten.
            try:
                time_str = data['insulinTimestamp'].replace('Z', '+00:00')
                administration_time = datetime.fromisoformat(time_str)
                if administration_time.tzinfo is not None:
                    administration_time = administration_time.replace(tzinfo=None)
            except (ValueError, TypeError) as e:
                logger.warning(f"Error parsing insulinTimestamp: {e}. Falling back to meal time.")
        elif data.get('medicationLog', {}).get('scheduled_time'):
            try:
                time_str = data['medicationLog']['scheduled_time'].replace('Z', '+00:00')
                administration_time = datetime.fromisoformat(time_str)
                if administration_time.tzinfo is not None:
                    administration_time = administration_time.replace(tzinfo=None)
            except (ValueError, TypeError) as e:
                logger.warning(f"Error parsing administration time: {e}. Using meal time.")

        blood_sugar_timestamp = None
        if data.get('bloodSugarTimestamp'):
            try:
                bst_str = data['bloodSugarTimestamp']
                if bst_str.endswith('Z'):
                    bst_str = bst_str[:-1] + '+00:00'
                elif not ('+' in bst_str or '-' in bst_str[-6:]):
                    bst_str = bst_str + '+00:00'
                # ✅ FIX: Store as a naive UTC datetime (not a string).
                # blood_sugar.py always stores parsed_timestamp (a datetime).
                # meal_insulin.py was storing the raw ISO string, causing BSON type
                # mismatches when MongoDB range queries compared datetimes to strings.
                blood_sugar_timestamp = datetime.fromisoformat(bst_str).replace(tzinfo=None)
            except (ValueError, TypeError) as e:
                logger.warning(f"Error parsing blood sugar timestamp: {e}.")
                blood_sugar_timestamp = meal_timestamp
        else:
            blood_sugar_timestamp = meal_timestamp

        activity_ids = []

        meal_doc = {
            'user_id': str(current_user['_id']),
            'timestamp': meal_timestamp,
            'created_at': record_created_at,
            'mealType': data['mealType'],
            'foodItems': data['foodItems'],
            'nutrition': nutrition,
            'activity_ids': [],
            'bloodSugar': data.get('bloodSugar'),
            'bloodSugarTimestamp': blood_sugar_timestamp,
            'bloodSugarSource': data.get('bloodSugarSource', 'direct'),
            'intendedInsulin': data.get('intendedInsulin'),
            'intendedInsulinType': data.get('intendedInsulinType'),
            'suggestedInsulin': insulin_calc['total'],
            'suggestedInsulinType': data.get('suggestedInsulinType', 'regular_insulin'),
            'insulinCalculation': insulin_calc['breakdown'],
            'notes': data.get('notes', ''),
            'activeConditions': active_conditions,
            'activeMedications': active_medications,
            'healthMultiplier': insulin_calc['breakdown']['health_multiplier'],
            'calculationFactors': calculation_factors
        }

        if data.get('intendedInsulin') and data.get('intendedInsulinType'):
            meal_doc['insulinAdministrationTime'] = administration_time

        result = mongo.db.meals.insert_one(meal_doc)
        meal_id = str(result.inserted_id)
        logger.info(f"Meal document created with ID: {meal_id}")

        base_insulin = insulin_calc['breakdown'].get('base_insulin', 0)
        calc_absorption_factor = insulin_calc['breakdown'].get('absorption_factor', 1.0)
        calc_meal_timing_factor = insulin_calc['breakdown'].get('meal_timing_factor', 1.0)
        meal_only_suggested_insulin = base_insulin * calc_absorption_factor * calc_meal_timing_factor

        calculation_summary = {
            'base_insulin': base_insulin,
            'adjustment_factors': {
                'absorption_rate': calc_absorption_factor,
                'meal_timing': calc_meal_timing_factor
            },
            'meal_only_suggested_insulin': round(meal_only_suggested_insulin, 1),
            'absorption_type': nutrition.get('absorption_type', 'medium')
        }

        meals_only_id = None
        if (data.get('foodItems') and len(data.get('foodItems')) > 0 and
                data.get('mealType') not in ['blood_sugar_only', 'activity_only', 'insulin_only']):

            meals_only_doc = {
                'user_id': str(current_user['_id']),
                'timestamp': meal_timestamp,
                'created_at': record_created_at,
                'mealType': data['mealType'],
                'foodItems': data['foodItems'],
                'nutrition': nutrition,
                'notes': data.get('notes', ''),
                'meal_id': meal_id,
                'source': 'meal_submission',
                'calculation_summary': calculation_summary
            }

            meals_only_result = mongo.db.meals_only.insert_one(meals_only_doc)
            meals_only_id = str(meals_only_result.inserted_id)

            mongo.db.meals.update_one(
                {"_id": result.inserted_id},
                {"$set": {"meals_only_id": meals_only_id}}
            )

            # Process activities
            activities_with_details = []
            activities_collection = mongo.db.activities

            try:
                if 'activityIds' in data and data['activityIds']:
                    for activity_id in data['activityIds']:
                        try:
                            activity = activities_collection.find_one({'_id': ObjectId(activity_id)})
                            if activity:
                                activities_collection.update_one(
                                    {'_id': ObjectId(activity_id)},
                                    {'$set': {'meal_id': meal_id}}
                                )
                                activity_ids.append(activity_id)
                                activities_with_details.append({
                                    'activity_id': activity_id,
                                    'level': activity.get('level', 0),
                                    'type': activity.get('type', 'expected'),
                                    'startTime': activity.get('startTime'),
                                    'endTime': activity.get('endTime'),
                                    'duration': activity.get('duration', '01:00'),
                                    'impact': activity.get('impact', 1.0),
                                    'notes': activity.get('notes', '')
                                })
                        except Exception as e:
                            logger.warning(f"Failed to link existing activity {activity_id}: {e}")

                elif data.get('activities'):
                    for activity in data['activities']:
                        try:
                            activity_record = {
                                'user_id': str(current_user['_id']),
                                'timestamp': meal_timestamp,
                                'created_at': record_created_at,
                                'type': activity.get('type', 'expected'),
                                'level': activity.get('level', 0),
                                'impact': activity.get('impact', 1.0),
                                'duration': activity.get('duration', '00:00'),
                                'meal_id': meal_id,
                                # N-2 FIX: Inline activities created alongside a meal
                                # submission were missing a source tag.  Standalone
                                # activities (activity.py record_activities path) carry
                                # 'manual'; watch-sync activities carry 'google_fit'.
                                # Use 'meal_submission' here so all three paths are
                                # distinguishable in queries and audits.
                                'source': 'meal_submission',
                            }

                            if activity.get('startTime') and activity.get('endTime'):
                                activity_record['startTime'] = activity['startTime']
                                activity_record['endTime'] = activity['endTime']
                                if activity.get('type') == 'expected':
                                    activity_record['expectedTime'] = activity['startTime']
                                else:
                                    activity_record['completedTime'] = activity['startTime']

                            if 'notes' in activity:
                                activity_record['notes'] = activity['notes']

                            activity_result = activities_collection.insert_one(activity_record)
                            activity_id = str(activity_result.inserted_id)
                            activity_ids.append(activity_id)
                            activities_with_details.append({
                                'activity_id': activity_id,
                                'level': activity.get('level', 0),
                                'type': activity.get('type', 'expected'),
                                'startTime': activity.get('startTime'),
                                'endTime': activity.get('endTime'),
                                'duration': activity.get('duration', '01:00'),
                                'impact': activity.get('impact', 1.0),
                                'notes': activity.get('notes', '')
                            })
                        except Exception as e:
                            logger.warning(f"Failed to save activity: {e}")

                if activity_ids:
                    mongo.db.meals.update_one(
                        {"_id": result.inserted_id},
                        {"$set": {
                            "activity_ids": activity_ids,
                            "activities": activities_with_details
                        }}
                    )
            except Exception as e:
                logger.error(f"Error processing activities: {e}")

        # Save blood sugar to separate collection ONLY when the user explicitly
        # entered a reading. Sources 'estimated' and 'target_fallback' are used
        # for insulin calculation only and must never create a DB record.
        blood_sugar_id = None
        _bs_source = data.get('bloodSugarSource') or ''
        _user_entered_sources = {'actual', 'direct', 'standalone', 'meal_form'}
        if data.get('bloodSugar') is not None and _bs_source in _user_entered_sources:
            try:
                user_constants = Constants(str(current_user['_id']))
                target_glucose = user_constants.get_constant('target_glucose')

                blood_sugar_value = data.get('bloodSugar')
                if blood_sugar_value < target_glucose * 0.7:
                    status = "low"
                elif blood_sugar_value > target_glucose * 1.3:
                    status = "high"
                else:
                    status = "normal"

                blood_sugar_doc = {
                    'user_id': str(current_user['_id']),
                    'bloodSugar': blood_sugar_value,
                    'status': status,
                    'target': target_glucose,
                    'timestamp': meal_timestamp,
                    'created_at': record_created_at,
                    'bloodSugarTimestamp': blood_sugar_timestamp,
                    'notes': data.get('notes', ''),
                    'source': 'meal_record',
                    'meal_id': meal_id,
                    'mealType': data['mealType']
                }

                bs_result = mongo.db.blood_sugar.insert_one(blood_sugar_doc)
                blood_sugar_id = str(bs_result.inserted_id)

                mongo.db.meals.update_one(
                    {"_id": result.inserted_id},
                    {"$set": {"blood_sugar_id": blood_sugar_id}}
                )
            except Exception as e:
                logger.warning(f"Error saving blood sugar: {e}")

        # Handle insulin logging in medication system
        if data.get('intendedInsulin') and data.get('intendedInsulinType'):
            try:
                insulin_type = data['intendedInsulinType']
                app_constants = current_app.constants
                app_patient_constants = app_constants.get_patient_constants()
                insulin_profile = app_patient_constants.get('medication_factors', {}).get(insulin_type, {})

                onset_hours = insulin_profile.get('onset_hours', 0.5)
                duration_hours = insulin_profile.get('duration_hours', 4.0)
                is_peakless = insulin_profile.get('is_peakless', False)
                peak_hours = insulin_profile.get('peak_hours')
                curve_type = insulin_profile.get('curve_type', 'gamma_moderate')

                if peak_hours is None or is_peakless:
                    peak_hours = duration_hours / 2

                medication_log = {
                    'patient_id': str(current_user['_id']),
                    'medication': data['intendedInsulinType'],
                    'dose': float(data['intendedInsulin']),
                    'scheduled_time': administration_time,
                    'taken_at': administration_time,
                    'status': 'taken',
                    'created_at': record_created_at,
                    'created_by': str(current_user['_id']),
                    'notes': data.get('notes', ''),
                    'is_insulin': True,
                    'meal_id': meal_id,
                    'meal_type': data['mealType'],
                    'blood_sugar': data.get('bloodSugar'),
                    'blood_sugar_timestamp': blood_sugar_timestamp,
                    'blood_sugar_id': blood_sugar_id,
                    'suggested_dose': insulin_calc['total'],
                    'effect_start_time': administration_time,
                    'onset_time': administration_time + timedelta(hours=onset_hours),
                    'peak_time': administration_time + timedelta(hours=peak_hours),
                    'effect_end_time': administration_time + timedelta(hours=duration_hours),
                    'effect_profile': {
                        'onset_hours': onset_hours,
                        'peak_hours': peak_hours,
                        'duration_hours': duration_hours,
                        'is_peakless': is_peakless,
                        'curve_type': curve_type,
                        'type': insulin_profile.get('type', 'rapid_acting')
                    }
                }

                log_result = mongo.db.medication_logs.insert_one(medication_log)
                medication_log_id = str(log_result.inserted_id)

                mongo.db.meals.update_one(
                    {"_id": result.inserted_id},
                    {"$set": {"medication_log_id": medication_log_id}}
                )

                if data['intendedInsulinType'] not in user.get('active_medications', []):
                    mongo.db.users.update_one(
                        {'_id': current_user['_id']},
                        {'$addToSet': {'active_medications': data['intendedInsulinType']}}
                    )

                logger.info(f"Logged insulin: {medication_log['dose']}u of "
                            f"{medication_log['medication']} at {administration_time}")

            except Exception as e:
                logger.error(f"Error updating medication records: {str(e)}")

        return jsonify({
            "message": "Meal logged successfully",
            "id": meal_id,
            "meals_only_id": meals_only_id,
            "blood_sugar_id": blood_sugar_id,
            "activity_ids": activity_ids,
            "nutrition": nutrition,
            "insulinCalculation": insulin_calc,
            "timestamp": (meal_timestamp.isoformat() + 'Z'),
            "created_at": (record_created_at.isoformat() + 'Z'),
            "bloodSugarTimestamp": blood_sugar_timestamp.isoformat() + 'Z'
                                    if isinstance(blood_sugar_timestamp, datetime)
                                    else blood_sugar_timestamp,
            "insulinAdministrationTime": (administration_time.isoformat() + 'Z')
                                         if administration_time else None,
            "healthFactors": {
                "activeConditions": active_conditions,
                "activeMedications": active_medications,
                "healthMultiplier": insulin_calc['breakdown']['health_multiplier']
            }
        }), 201

    except Exception as e:
        logger.error(f"Error in submit_meal: {str(e)}")
        logger.error(f"Full traceback: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 400


# ============================================================================
# GET /api/meals - Meal History
# ============================================================================

@meal_insulin_bp.route('/api/meals', methods=['GET'])
@token_required
@api_error_handler
def get_meals(current_user):
    try:
        limit = int(request.args.get('limit', 10))
        skip = int(request.args.get('skip', 0))

        total_meals = mongo.db.meals.count_documents({"user_id": str(current_user['_id'])})

        meals = list(mongo.db.meals.find(
            {"user_id": str(current_user['_id'])}
        ).sort("timestamp", -1).skip(skip).limit(limit))

        formatted_meals = []
        for meal in meals:
            try:
                formatted_meal = {
                    "id": str(meal.get('_id')),
                    "mealType": meal.get('mealType', 'unknown'),
                    "foodItems": meal.get('foodItems', []),
                    "nutrition": meal.get('nutrition', {}),
                    "activities": meal.get('activities', []),
                    "bloodSugar": meal.get('bloodSugar'),
                    "bloodSugarTimestamp": meal.get('bloodSugarTimestamp'),
                    "bloodSugarSource": meal.get('bloodSugarSource', 'direct'),
                    "intendedInsulin": meal.get('intendedInsulin'),
                    "intendedInsulinType": meal.get('intendedInsulinType'),
                    "suggestedInsulin": meal.get('suggestedInsulin', 0),
                    "suggestedInsulinType": meal.get('suggestedInsulinType', 'regular_insulin'),
                    "insulinCalculation": meal.get('insulinCalculation', {}),
                    "notes": meal.get('notes', ''),
                    "timestamp": (meal['timestamp'].isoformat() + 'Z')
                                if isinstance(meal['timestamp'], datetime) else meal['timestamp']
                }

                if 'created_at' in meal:
                    formatted_meal["created_at"] = (meal['created_at'].isoformat() + 'Z') \
                        if isinstance(meal['created_at'], datetime) else meal['created_at']

                if 'imported_at' in meal:
                    formatted_meal["imported_at"] = (meal['imported_at'].isoformat() + 'Z') \
                        if isinstance(meal['imported_at'], datetime) else meal['imported_at']

                formatted_meals.append(formatted_meal)
            except Exception as e:
                logger.error(f"Error processing meal {meal.get('_id')}: {str(e)}")

        return jsonify({
            "meals": formatted_meals,
            "pagination": {"total": total_meals, "limit": limit, "skip": skip}
        }), 200

    except Exception as e:
        logger.error(f"Error in get_meals: {str(e)}")
        return jsonify({"error": str(e)}), 400


# ============================================================================
# POST /api/meal/calculate - Preview Calculation
# ============================================================================

@meal_insulin_bp.route('/api/meal/calculate', methods=['POST'])
@token_required
def calculate_meal(current_user):
    try:
        data = request.json
        nutrition = calculate_meal_nutrition(data['foodItems'])

        insulin_calc = calculate_suggested_insulin(
            str(current_user['_id']),
            nutrition,
            data['activities'],
            data.get('bloodSugar'),
            data['mealType'],
            data.get('calculationFactors')
        )

        user = mongo.db.users.find_one({"_id": current_user['_id']})
        constants = Constants(str(current_user['_id']))
        patient_constants = constants.get_patient_constants()

        return jsonify({
            "calculations": {
                "nutrition": nutrition,
                "insulin": insulin_calc,
                "constants": {
                    "insulin_to_carb_ratio": patient_constants['insulin_to_carb_ratio'],
                    "correction_factor": patient_constants['correction_factor'],
                    "target_glucose": patient_constants['target_glucose'],
                    "protein_factor": patient_constants['protein_factor'],
                    "fat_factor": patient_constants['fat_factor']
                },
                "conditions": user.get('active_conditions', []),
                "medications": user.get('active_medications', [])
            }
        })

    except Exception as e:
        logger.error(f"Error in calculate_meal: {str(e)}")
        return jsonify({"error": str(e)}), 400


# ============================================================================
# POST /api/repair-imported-meals - Repair Imported Records
# ============================================================================

@meal_insulin_bp.route('/api/repair-imported-meals', methods=['POST'])
@token_required
@api_error_handler
def repair_imported_meals(current_user):
    """Repair imported meal records by adding missing required fields."""
    try:
        if current_user.get('user_type') not in ['doctor', 'admin']:
            return jsonify({"error": "Unauthorized"}), 403

        patient_id = request.json.get('patient_id', str(current_user['_id']))

        imported_meals = mongo.db.meals.find({
            "user_id": patient_id,
            "imported_at": {"$exists": True}
        })
        count = 0

        for meal in imported_meals:
            updates = {}
            if 'suggestedInsulin' not in meal:
                updates['suggestedInsulin'] = 0
            if 'suggestedInsulinType' not in meal:
                updates['suggestedInsulinType'] = 'regular_insulin'
            if 'insulinCalculation' not in meal:
                updates['insulinCalculation'] = {}
            if 'activities' not in meal:
                updates['activities'] = []

            if updates:
                mongo.db.meals.update_one({"_id": meal['_id']}, {"$set": updates})
                count += 1

        return jsonify({
            "message": f"Repaired {count} imported meal records",
            "patient_id": patient_id
        }), 200

    except Exception as e:
        logger.error(f"Error in repair_imported_meals: {str(e)}")
        return jsonify({"error": str(e)}), 400


# ============================================================================
# GET /api/doctor/meal-history/<patient_id> - Doctor View
# ============================================================================

@meal_insulin_bp.route('/api/doctor/meal-history/<patient_id>', methods=['GET'])
@token_required
@api_error_handler
def get_patient_meal_history(current_user, patient_id):
    if current_user.get('user_type') != 'doctor':
        return jsonify({'message': 'Unauthorized access'}), 403

    try:
        limit = int(request.args.get('limit', 10))
        skip = int(request.args.get('skip', 0))

        total_meals = mongo.db.meals.count_documents({"user_id": patient_id})

        meals = list(mongo.db.meals.find(
            {'user_id': patient_id}
        ).sort('timestamp', -1).skip(skip).limit(limit))

        formatted_meals = []
        for meal in meals:
            formatted_meal = {
                "id": str(meal['_id']),
                "mealType": meal['mealType'],
                "foodItems": meal['foodItems'],
                "activities": meal.get('activities', []),
                "nutrition": meal['nutrition'],
                "bloodSugar": meal.get('bloodSugar'),
                "intendedInsulin": meal.get('intendedInsulin'),
                "suggestedInsulin": meal.get('suggestedInsulin', 0),
                "insulinCalculation": meal.get('insulinCalculation', {}),
                "notes": meal.get('notes', ''),
                "timestamp": (meal['timestamp'].isoformat() + 'Z')
                            if isinstance(meal['timestamp'], datetime) else meal['timestamp']
            }

            if 'mealTime' in meal:
                formatted_meal["mealTime"] = meal['mealTime'].isoformat()
            else:
                formatted_meal["mealTime"] = formatted_meal["timestamp"]

            formatted_meals.append(formatted_meal)

        return jsonify({
            "meals": formatted_meals,
            "pagination": {"total": total_meals, "limit": limit, "skip": skip}
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================================
# POST /api/import-meals - Import Meals (module-level, not nested)
# ============================================================================

@meal_insulin_bp.route('/api/import-meals', methods=['POST', 'OPTIONS'])
@cross_origin(origins=["http://localhost:3000"], methods=['POST', 'OPTIONS'],
              allow_headers=['Authorization', 'Content-Type'])
@token_required
@api_error_handler
def import_meals(current_user):
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    try:
        data = request.json
        meals = data.get('meals', [])

        if not meals:
            return jsonify({"error": "No meals provided"}), 400

        result = mongo.db.meals.insert_many(meals)

        return jsonify({
            "message": "Successfully imported meals",
            "count": len(result.inserted_ids)
        }), 201

    except Exception as e:
        logger.error(f"Error importing meals: {str(e)}")
        return jsonify({"error": str(e)}), 500


# ============================================================================
# DELETE /api/meal/<meal_id> - Delete Meal (module-level, not nested)
# ============================================================================

def _resolve_meal(meal_obj_id):
    """
    Find the authoritative ``meals`` document from either of its two ids.

    A meal is stored twice: the full record in ``meals`` and a projection in
    ``meals_only``, linked both ways (``meals_only.meal_id`` and
    ``meals.meals_only_id``). The mobile client lists from
    ``/api/meals-only``, so the id it holds — and sends to DELETE — is the
    *projection's*. Doctor views and older callers hold the ``meals`` id.

    Accepting either is what lets one handler own this route. Resolving to
    ``meals`` is what makes the delete complete: previously the projection
    was removed and the record it pointed at was left behind, still carrying
    its insulin dose into every IOB and cumulative-effects calculation.
    """
    meal = mongo.db.meals.find_one({"_id": meal_obj_id})
    if meal:
        return meal

    projection = mongo.db.meals_only.find_one({"_id": meal_obj_id})
    if not projection:
        return None

    parent_id = projection.get('meal_id')
    if parent_id:
        try:
            meal = mongo.db.meals.find_one({"_id": ObjectId(parent_id)})
        except Exception:
            meal = None
        if meal:
            return meal

    # Projection with no reachable parent — an orphan, most likely left by
    # the delete this function replaces. Return it so the caller can still
    # clean it up rather than refusing forever.
    logger.warning(f"meals_only {meal_obj_id} has no reachable parent meal; deleting the orphan")
    return projection


@meal_insulin_bp.route('/api/meal/<meal_id>', methods=['DELETE'])
@token_required
def delete_meal(current_user, meal_id):
    """
    Delete a meal and everything written alongside it.

    Accepts either the ``meals`` id or the ``meals_only`` id — see
    :func:`_resolve_meal`.
    """
    try:
        try:
            meal_obj_id = ObjectId(meal_id)
        except Exception as e:
            logger.warning(f"Invalid meal ID format '{meal_id}': {e}")
            return jsonify({"error": "Invalid meal ID format"}), 400

        meal = _resolve_meal(meal_obj_id)
        if not meal:
            return jsonify({"error": "Meal not found"}), 404

        meal_obj_id = meal["_id"]

        if meal.get('user_id') != str(current_user['_id']):
            if current_user.get('user_type') != 'doctor':
                return jsonify({"error": "Unauthorized - you do not have permission to delete this record"}), 403

        deletion_results = {"meal": None, "activities": 0, "blood_sugar": None, "medication_log": None}

        # 1. Delete associated activities
        if 'activity_ids' in meal and meal['activity_ids']:
            activity_obj_ids = [ObjectId(aid) for aid in meal['activity_ids']]
            activities_result = mongo.db.activities.delete_many({"_id": {"$in": activity_obj_ids}})
            deletion_results["activities"] = activities_result.deleted_count

        # 2. Delete blood sugar record
        if 'blood_sugar_id' in meal and meal['blood_sugar_id']:
            try:
                bs_result = mongo.db.blood_sugar.delete_one({"_id": ObjectId(meal['blood_sugar_id'])})
                deletion_results["blood_sugar"] = bs_result.deleted_count
            except Exception as e:
                logger.warning(f"Error deleting blood sugar record: {e}")

        # 3. Delete medication log
        if 'medication_log_id' in meal and meal['medication_log_id']:
            try:
                med_result = mongo.db.medication_logs.delete_one(
                    {"_id": ObjectId(meal['medication_log_id'])}
                )
                deletion_results["medication_log"] = med_result.deleted_count
            except Exception as e:
                logger.warning(f"Error deleting medication log: {e}")

        # 4. Delete the meals_only projection.
        #    Three ways in, because the forward link was not always written:
        #    the recorded id, a reverse lookup on meal_id, and — when the
        #    caller handed us an orphaned projection — its own id.
        removed_projections = 0
        if meal.get('meals_only_id'):
            try:
                removed_projections += mongo.db.meals_only.delete_one(
                    {"_id": ObjectId(meal['meals_only_id'])}).deleted_count
            except Exception as e:
                logger.warning(f"Error deleting meals_only record: {e}")

        removed_projections += mongo.db.meals_only.delete_many(
            {"meal_id": str(meal_obj_id)}).deleted_count
        removed_projections += mongo.db.meals_only.delete_one(
            {"_id": meal_obj_id}).deleted_count

        deletion_results["meals_only"] = removed_projections

        # 5. Delete the meal itself
        meal_result = mongo.db.meals.delete_one({"_id": meal_obj_id})
        deletion_results["meal"] = meal_result.deleted_count

        logger.info(f"Deleted meal {meal_id} and related records: {deletion_results}")

        return jsonify({
            "message": "Record deleted successfully",
            "deleted": deletion_results
        }), 200

    except Exception as e:
        logger.error(f"Error deleting meal: {str(e)}")
        return jsonify({"error": f"Failed to delete record: {str(e)}"}), 500