"""
meal_routes.py - Updated Version
============================================================================
MOB endpoints optimized for ActiveEffectsDisplay frontend component.

KEY IMPROVEMENTS:
1. ✅ Aligned field names with frontend expectations (camelCase)
2. ✅ Added comprehensive breakdown fields for UI display
3. ✅ Includes both snake_case and camelCase for compatibility
4. ✅ Enhanced timing and absorption metrics
5. ✅ Detailed pharmacodynamic profile data

Endpoints:
  /api/meal-on-board          - Complete MOB with T1D model (ENHANCED)
  /api/meal-timing-assessment - Safety check for meal timing
  /api/active-meals           - Active meals with complete breakdown (ENHANCED)
  /api/meals-only             - Meal retrieval (canonical endpoint)
  /api/patient/<id>/meals-only - Doctor view of patient meals

Author: DiaTwin Team
Version: 5.0 (ActiveEffectsDisplay Alignment)
============================================================================
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.pharmacodynamics import (
    calculate_meal_active_carbs,
    get_daily_reset_time,
)
from constants import Constants
from config import mongo
from time_manager import TimeManager
import logging

logger = logging.getLogger(__name__)
meal_bp = Blueprint('meal_routes', __name__)


# ============================================================================
# HELPER FUNCTION: Format Meal Contribution for Frontend
# ============================================================================

def format_meal_contribution(meal, carb_data, patient_constants):
    """
    Format meal contribution with all fields expected by ActiveEffectsDisplay.

    Returns both snake_case (backend standard) and camelCase (frontend preference)
    for maximum compatibility.
    """
    # B-PD-6b: Guard both field names so legacy documents that only have
    # 'carb_to_bg_ratio' (and not 'carb_to_bg_factor') don't silently fall
    # back to the hardcoded 4.0 default. Mirrors the dual-key guard already
    # present in cumulative_effects_routes.py.
    carb_to_bg_factor = (
        patient_constants.get('carb_to_bg_factor')
        or patient_constants.get('carb_to_bg_ratio', 4.0)
    )

    # Extract absorption profile details
    absorption_type = carb_data.get('absorption_type', 'medium')
    profile = carb_data.get('profile', {})

    # Calculate all timing metrics
    hours_elapsed = carb_data.get('hours_elapsed', 0)
    duration_remaining = carb_data.get('duration_remaining', 0)
    total_duration = profile.get('duration_hours', 4.0)
    peak_time = profile.get('peak_hours', 1.5)
    onset_time = profile.get('onset_hours', 0.25)

    # Calculate absorption percentages
    total_carbs = carb_data.get('total_carbs', 0)
    absorbed_carbs = carb_data.get('absorbed_carbs', 0)
    active_carbs = carb_data.get('active_carbs', 0)

    absorbed_percent = (absorbed_carbs / total_carbs * 100) if total_carbs > 0 else 0
    active_percent = (active_carbs / total_carbs * 100) if total_carbs > 0 else 0

    # BG impact calculations
    bg_elevation = absorbed_carbs * carb_to_bg_factor
    pending_bg_rise = active_carbs * carb_to_bg_factor

    # Activity metrics
    activity_percent = carb_data.get('activity_percent', 0)
    is_past_peak = hours_elapsed > peak_time

    return {
        # Basic meal info
        'meal_id': str(meal.get('_id')),
        'mealId': str(meal.get('_id')),
        'meal_type': meal.get('mealType', 'unknown'),
        'mealType': meal.get('mealType', 'unknown'),

        # Timing info (both formats)
        'meal_time': (meal['timestamp'].isoformat() + 'Z')
                    if isinstance(meal['timestamp'], datetime) else meal['timestamp'],
        'mealTime': (meal['timestamp'].isoformat() + 'Z')
                   if isinstance(meal['timestamp'], datetime) else meal['timestamp'],
        'hours_elapsed': round(hours_elapsed, 1),
        'hoursSinceMeal': round(hours_elapsed, 1),
        'hoursElapsed': round(hours_elapsed, 1),

        # Carb totals (both formats)
        'total_carbs': round(total_carbs, 1),
        'totalCarbs': round(total_carbs, 1),
        'carbEquiv': round(total_carbs, 1),

        # Active carbs - MOB (both formats)
        'active_carbs': round(active_carbs, 1),
        'activeCarbs': round(active_carbs, 1),
        'mob': round(active_carbs, 1),

        # Absorbed carbs (both formats)
        'absorbed_carbs': round(absorbed_carbs, 1),
        'absorbedCarbs': round(absorbed_carbs, 1),

        # Percentages (both formats)
        'absorbed_percent': round(absorbed_percent, 1),
        'absorbedPercent': round(absorbed_percent, 1),
        'active_percent': round(active_percent, 1),
        'activePercent': round(active_percent, 1),
        'activity_percent': round(activity_percent, 1),
        'activityPercent': round(activity_percent, 1),

        # BG Impact (both formats)
        'current_bg_elevation': round(bg_elevation, 1),
        'currentBgElevation': round(bg_elevation, 1),
        'bgElevation': round(bg_elevation, 1),
        'bgImpact': round(bg_elevation, 1),

        'pending_bg_rise': round(pending_bg_rise, 1),
        'pendingBGRise': round(pending_bg_rise, 1),
        'pendingBgRise': round(pending_bg_rise, 1),

        # Absorption type (both formats)
        'absorption_type': absorption_type,
        'absorptionType': absorption_type,

        # Duration (both formats)
        'duration_remaining': round(duration_remaining, 1),
        'durationRemaining': round(duration_remaining, 1),

        # Status flags
        'is_past_peak': is_past_peak,
        'isPastPeak': is_past_peak,

        # Pharmacodynamic profile with ALL needed fields
        'profile': {
            'onset_hours': round(onset_time, 2),
            'onsetHours': round(onset_time, 2),
            'onset': round(onset_time, 2),

            'peak_hours': round(peak_time, 2),
            'peakHours': round(peak_time, 2),
            'peak': round(peak_time, 2),

            'duration_hours': round(total_duration, 2),
            'durationHours': round(total_duration, 2),
            'duration': round(total_duration, 2),

            'absorption_type': absorption_type,
            'absorptionType': absorption_type,
            'type': absorption_type
        }
    }


# ============================================================================
# /api/meal-on-board - ENHANCED FOR ACTIVEEFFECTSDISPLAY
# ============================================================================

@meal_bp.route('/api/meal-on-board', methods=['GET'])
@token_required
@api_error_handler
def get_meal_on_board(current_user):
    """
    Calculate total Meal On Board (MOB) with complete T1D breakdown.

    ENHANCED for ActiveEffectsDisplay:
    - Dual field naming (snake_case + camelCase)
    - Complete pharmacodynamic profiles
    - Detailed absorption metrics
    - Rich timing information

    Returns:
    - total_active_carbs / totalActiveCarbs: MOB (future BG rise)
    - total_absorbed_carbs / totalAbsorbedCarbs: Already in bloodstream
    - current_bg_elevation / currentBgElevation: Current BG impact from absorbed
    - pending_bg_rise / pendingBgRise: Expected BG impact from MOB
    - contributions: Array of detailed meal contributions

    Query Parameters:
        - patient_id: For doctors viewing patient data
        - target_time: Calculate MOB at specific time (default: now)
        - max_hours_back: How far back to look for meals (default: 12)
    """
    patient_id = request.args.get('patient_id')
    target_time_str = request.args.get('target_time')
    max_hours_back = int(request.args.get('max_hours_back', 12))

    # Authorization check
    if patient_id and current_user.get('user_type') != 'doctor':
        return jsonify({'error': 'Unauthorized access'}), 403

    user_id = patient_id if patient_id else str(current_user['_id'])

    # Parse target time
    if target_time_str:
        try:
            target_time = TimeManager.parse_timestamp(
                target_time_str, TimeManager.PRECISION_SECOND
            )
            target_time = TimeManager.to_datetime(target_time, TimeManager.PRECISION_SECOND)
        except ValueError:
            return jsonify({'error': 'Invalid target_time format'}), 400
    else:
        target_time = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)

    logger.info(f"📊 MOB Calculation - Target time: {target_time.isoformat()}")

    # Get patient constants and profiles
    constants = Constants(user_id)
    patient_constants = constants.get_patient_constants()
    carb_to_bg_factor = patient_constants.get('carb_to_bg_factor', 4.0)
    absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES

    # B-PD-6a: Use reset-time guard so meals from before today's daily reset
    # are excluded, matching the behaviour of get_active_effects_full's MOB
    # block. Without this guard, a late reset hour (e.g. 22:00) causes meals
    # eaten before the previous reset to appear in this endpoint but not in
    # active-effects-full, producing inconsistent MOB values.
    reset_hour = patient_constants.get('daily_reset_hour', 7)
    tz_offset  = patient_constants.get('timezone_offset_minutes', 0)
    reset_time   = get_daily_reset_time(target_time, reset_hour, tz_offset)
    cutoff_time  = target_time - timedelta(hours=max_hours_back)
    effective_cutoff = max(reset_time, cutoff_time)

    logger.info(
        f"📊 MOB Calculation — reset={reset_time.isoformat()}, "
        f"12h cutoff={cutoff_time.isoformat()}, "
        f"effective={effective_cutoff.isoformat()}"
    )

    # Fetch meals from database
    meals = list(mongo.db.meals_only.find({
        'user_id': user_id,
        'timestamp': {'$gte': effective_cutoff, '$lte': target_time},
        'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
    }).sort('timestamp', -1))

    logger.info(f"Found {len(meals)} meals for MOB calculation")

    # Initialize totals
    contributions = []
    total_active_carbs = 0
    total_absorbed_carbs = 0
    total_current_bg_elevation = 0
    total_pending_bg_rise = 0

    # Process each meal
    for meal in meals:
        # Calculate active carbs using pharmacodynamics engine
        carb_data = calculate_meal_active_carbs(
            meal, target_time, patient_constants, absorption_profiles
        )

        # Only include meals with active or absorbed carbs
        if carb_data['active_carbs'] > 0 or carb_data['absorbed_carbs'] > 0:
            # Format contribution with all expected fields
            contribution = format_meal_contribution(meal, carb_data, patient_constants)
            contributions.append(contribution)

            # Update totals
            total_active_carbs += carb_data['active_carbs']
            total_absorbed_carbs += carb_data['absorbed_carbs']
            total_current_bg_elevation += carb_data['current_bg_elevation']
            total_pending_bg_rise += carb_data['pending_bg_rise']

    logger.info(f"✅ MOB Complete: Active={total_active_carbs:.1f}g, "
                f"Absorbed={total_absorbed_carbs:.1f}g, "
                f"BG Elev=+{total_current_bg_elevation:.1f}, "
                f"Pending=+{total_pending_bg_rise:.1f}")

    # Return with dual field naming
    return jsonify({
        # Totals - snake_case
        'total_active_carbs': round(total_active_carbs, 1),
        'total_absorbed_carbs': round(total_absorbed_carbs, 1),
        'current_bg_elevation': round(total_current_bg_elevation, 1),
        'pending_bg_rise': round(total_pending_bg_rise, 1),

        # Totals - camelCase
        'totalActiveCarbs': round(total_active_carbs, 1),
        'totalAbsorbedCarbs': round(total_absorbed_carbs, 1),
        'currentBgElevation': round(total_current_bg_elevation, 1),
        'pendingBgRise': round(total_pending_bg_rise, 1),

        # Legacy support
        'expected_bg_impact': round(total_pending_bg_rise, 1),
        'expectedBgImpact': round(total_pending_bg_rise, 1),

        # Detailed contributions
        'contributions': contributions,
        'active_meal_count': len(contributions),
        'activeMealCount': len(contributions),

        # Metadata
        'calculation_time': target_time.isoformat(),
        'calculationTime': target_time.isoformat(),
        'calculation_timezone': 'UTC',
        'calculationTimezone': 'UTC',
        'carb_to_bg_factor': carb_to_bg_factor,
        'carbToBgFactor': carb_to_bg_factor
    }), 200



# ============================================================================
# /api/active-meals - ENHANCED FOR ACTIVEEFFECTSDISPLAY
# ============================================================================

@meal_bp.route('/api/active-meals', methods=['GET'])
@token_required
@api_error_handler
def get_active_meals(current_user):
    """
    Get list of currently active meals with complete breakdown.

    ENHANCED for ActiveEffectsDisplay:
    - Complete pharmacodynamic data
    - Dual field naming
    - Rich absorption metrics

    Returns array of meals with:
    - Basic meal info
    - Timing metrics
    - Absorption progress
    - BG impact projections
    - Pharmacodynamic profile
    """
    patient_id = request.args.get('patient_id')
    max_hours_back = int(request.args.get('max_hours_back', 12))

    if patient_id and current_user.get('user_type') != 'doctor':
        return jsonify({'error': 'Unauthorized access'}), 403

    user_id = patient_id if patient_id else str(current_user['_id'])
    target_time = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)
    cutoff_time = target_time - timedelta(hours=max_hours_back)

    # Get constants
    constants = Constants(user_id)
    patient_constants = constants.get_patient_constants()
    absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES

    # Fetch meals
    meals = list(mongo.db.meals_only.find({
        'user_id': user_id,
        'timestamp': {'$gte': cutoff_time, '$lte': target_time},
        'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
    }).sort('timestamp', -1))

    active_meals = []

    for meal in meals:
        carb_data = calculate_meal_active_carbs(
            meal, target_time, patient_constants, absorption_profiles
        )

        if carb_data['active_carbs'] > 0 or carb_data['absorbed_carbs'] > 0:
            # Use the helper function for consistent formatting
            meal_data = format_meal_contribution(meal, carb_data, patient_constants)

            # Add food items for display
            meal_data['foodItems'] = meal.get('foodItems', [])
            meal_data['food_items'] = meal.get('foodItems', [])

            active_meals.append(meal_data)

    return jsonify({
        'active_meals': active_meals,
        'activeMeals': active_meals,
        'count': len(active_meals)
    }), 200



# ============================================================================
# /api/meal-timing-assessment - Safety Check
# ============================================================================

@meal_bp.route('/api/meal-timing-assessment', methods=['GET'])
@token_required
@api_error_handler
def assess_meal_timing(current_user):
    """
    Assess whether it's safe to eat based on current MOB.
    Clinical decision support endpoint.
    """
    patient_id = request.args.get('patient_id')

    if patient_id and current_user.get('user_type') != 'doctor':
        return jsonify({'error': 'Unauthorized access'}), 403

    user_id = patient_id if patient_id else str(current_user['_id'])

    target_time = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)
    cutoff_time = target_time - timedelta(hours=12)

    constants = Constants(user_id)
    patient_constants = constants.get_patient_constants()
    absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES

    meals = list(mongo.db.meals_only.find({
        'user_id': user_id,
        'timestamp': {'$gte': cutoff_time, '$lte': target_time},
        'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
    }))

    contributions = []
    total_active_carbs = 0
    highest_activity = 0

    for meal in meals:
        carb_data = calculate_meal_active_carbs(
            meal, target_time, patient_constants, absorption_profiles
        )

        if carb_data['active_carbs'] > 0:
            activity_percent = carb_data.get('activity_percent', 0)
            total_active_carbs += carb_data['active_carbs']
            highest_activity = max(highest_activity, activity_percent)

            contributions.append(format_meal_contribution(
                meal, carb_data, patient_constants
            ))

    # Safety assessment
    is_safe = True
    safety_level = 'safe'
    warnings = []

    if total_active_carbs > 60:
        is_safe = False
        safety_level = 'unsafe'
        warnings.append(f'High active carbs: {total_active_carbs:.1f}g')
    elif total_active_carbs > 40:
        safety_level = 'caution'
        warnings.append(f'Moderate active carbs: {total_active_carbs:.1f}g')

    if highest_activity > 70:
        safety_level = 'caution' if safety_level == 'safe' else 'unsafe'
        warnings.append(f'Recent meal still highly active ({highest_activity:.0f}%)')

    recommendation = 'Safe to eat' if is_safe else 'Wait for absorption'
    if safety_level == 'caution':
        recommendation = 'Consider waiting or eating light meal'

    return jsonify({
        'is_safe': is_safe,
        'isSafe': is_safe,
        'safety_level': safety_level,
        'safetyLevel': safety_level,
        'recommendation': recommendation,
        'warnings': warnings,
        'total_active_carbs': round(total_active_carbs, 1),
        'totalActiveCarbs': round(total_active_carbs, 1),
        'highest_activity': round(highest_activity, 1),
        'highestActivity': round(highest_activity, 1),
        'active_meal_count': len(contributions),
        'activeMealCount': len(contributions),
        'contributions': contributions
    }), 200



# ============================================================================
# /api/meals-only - Canonical Meal Retrieval Endpoint
# ============================================================================

@meal_bp.route('/api/meals-only', methods=['GET'])
@token_required
@api_error_handler
def get_meals_only(current_user):
    """
    Get meals without insulin/activity data.
    This is the CANONICAL /api/meals-only endpoint.
    """
    # ✅ FIX (Bug #2): Raised default from 10 → 100 so a month-view fetch
    # (which may not pass an explicit limit) does not silently truncate results.
    # The frontend passes explicit limits (50/100/300/1000) per view mode, but
    # the higher default prevents data loss if the parameter is ever omitted.
    limit = int(request.args.get('limit', 100))
    skip = int(request.args.get('skip', 0))
    start_date_str = request.args.get('start_date')
    end_date_str = request.args.get('end_date')
    filter_by = request.args.get('filter_by', 'timestamp')

    patient_id = request.args.get('patient_id')
    if patient_id and current_user.get('user_type') != 'doctor':
        return jsonify({"error": "Unauthorized to view patient data"}), 403

    user_id = patient_id if patient_id else str(current_user['_id'])

    query = {"user_id": user_id}

    if start_date_str or end_date_str:
        start_datetime = None
        end_datetime = None

        if start_date_str:
            try:
                start_datetime = datetime.strptime(start_date_str, '%Y-%m-%d')
            except Exception as e:
                logger.error(f"Error parsing start date '{start_date_str}': {e}")
                return jsonify({"error": f"Invalid start_date format: {start_date_str}"}), 400

        if end_date_str:
            try:
                end_datetime = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
            except Exception as e:
                logger.error(f"Error parsing end date '{end_date_str}': {e}")
                return jsonify({"error": f"Invalid end_date format: {end_date_str}"}), 400

        time_filter = {}
        if start_datetime:
            time_filter["$gte"] = start_datetime
        if end_datetime:
            time_filter["$lt"] = end_datetime

        if time_filter:
            query[filter_by] = time_filter

    total_meals = mongo.db.meals_only.count_documents(query)
    meals = list(mongo.db.meals_only.find(query).sort("timestamp", -1).skip(skip).limit(limit))

    formatted_meals = []
    for meal in meals:
        formatted_meal = {
            "id": str(meal["_id"]),
            "timestamp": (meal["timestamp"].isoformat() + 'Z')
                        if isinstance(meal["timestamp"], datetime) else meal["timestamp"],
            "mealType": meal.get("mealType", "normal"),
            "foodItems": meal.get("foodItems", []),
            "nutrition": meal.get("nutrition", {}),
            "notes": meal.get("notes", "")
        }

        if "mealTime" in meal:
            formatted_meal["mealTime"] = meal["mealTime"].isoformat()
        else:
            formatted_meal["mealTime"] = formatted_meal["timestamp"]

        if "calculation_summary" in meal:
            formatted_meal["calculation_summary"] = meal["calculation_summary"]

        if "meal_id" in meal:
            formatted_meal["meal_id"] = meal["meal_id"]

        formatted_meals.append(formatted_meal)

    return jsonify({
        "meals": formatted_meals,
        "pagination": {
            "total": total_meals,
            "limit": limit,
            "skip": skip
        }
    }), 200



@meal_bp.route('/api/patient/<patient_id>/meals-only', methods=['GET'])
@token_required
@api_error_handler
def get_patient_meals_only(current_user, patient_id):
    """Get patient meals (for doctors)."""
    if current_user.get('user_type') != 'doctor':
        return jsonify({"error": "Unauthorized access"}), 403

    # ✅ FIX (Bug #2): Raised default from 10 → 100 (mirrors get_meals_only fix).
    limit = int(request.args.get('limit', 100))
    skip = int(request.args.get('skip', 0))
    start_date_str = request.args.get('start_date')
    end_date_str = request.args.get('end_date')
    filter_by = request.args.get('filter_by', 'timestamp')

    query = {"user_id": patient_id}

    if start_date_str or end_date_str:
        start_datetime = None
        end_datetime = None

        if start_date_str:
            try:
                start_datetime = datetime.strptime(start_date_str, '%Y-%m-%d')
            except Exception as e:
                logger.error(f"Error parsing start date '{start_date_str}': {e}")
                return jsonify({"error": f"Invalid start_date format: {start_date_str}"}), 400

        if end_date_str:
            try:
                end_datetime = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
            except Exception as e:
                logger.error(f"Error parsing end date '{end_date_str}': {e}")
                return jsonify({"error": f"Invalid end_date format: {end_date_str}"}), 400

        time_filter = {}
        if start_datetime:
            time_filter["$gte"] = start_datetime
        if end_datetime:
            time_filter["$lt"] = end_datetime

        if time_filter:
            query[filter_by] = time_filter

    total_meals = mongo.db.meals_only.count_documents(query)
    meals = list(mongo.db.meals_only.find(query).sort("timestamp", -1).skip(skip).limit(limit))

    formatted_meals = []
    for meal in meals:
        formatted_meal = {
            "id": str(meal["_id"]),
            "timestamp": (meal["timestamp"].isoformat() + 'Z')
                        if isinstance(meal["timestamp"], datetime) else meal["timestamp"],
            "mealType": meal.get("mealType", "normal"),
            "foodItems": meal.get("foodItems", []),
            "nutrition": meal.get("nutrition", {}),
            "notes": meal.get("notes", ""),
            "calculation_summary": meal.get("calculation_summary", {})
        }

        if "mealTime" in meal:
            formatted_meal["mealTime"] = meal["mealTime"].isoformat()
        else:
            formatted_meal["mealTime"] = formatted_meal["timestamp"]

        formatted_meals.append(formatted_meal)

    return jsonify({
        "meals": formatted_meals,
        "pagination": {
            "total": total_meals,
            "limit": limit,
            "skip": skip
        }
    }), 200