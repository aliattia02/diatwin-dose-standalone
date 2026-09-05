"""
medication_routes.py - Refactored Version (INDENTATION FIX)
============================================================================
Medication scheduling, insulin logging, IOB calculation, and analytics.

Uses shared pharmacodynamics engine from utils/pharmacodynamics.py.

Author: DiaTwin Team
Version: 4.1 (Indentation Fix)
============================================================================
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.pharmacodynamics import (
    calculate_insulin_activity,
    calculate_iob,
)
from config import mongo
from time_manager import TimeManager
import pymongo
import logging

logger = logging.getLogger(__name__)
medication_routes = Blueprint('medication_routes', __name__)


# ============================================================================
# STACKED INSULIN EFFECT CALCULATION
# ============================================================================

def calculate_stacked_insulin_effect(patient_id, target_time=None):
    """
    Calculate total stacked insulin effect.

    Args:
        patient_id (str): Patient ID
        target_time (datetime, optional): Time to calculate for (default: now)

    Returns:
        dict: Complete IOB breakdown with T1D model
    """
    if target_time is None:
        target_time = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)
    else:
        if hasattr(target_time, 'tzinfo') and target_time.tzinfo is not None:
            target_time = target_time.replace(tzinfo=None)
        if not isinstance(target_time, datetime):
            target_time = TimeManager.to_datetime(target_time, TimeManager.PRECISION_SECOND)

    logger.debug(f"💉 IOB Calculation - Target time: {target_time.isoformat()}")

    lookback_time = target_time - timedelta(hours=24)

    active_insulin = list(mongo.db.medication_logs.find({
        'patient_id': patient_id,
        'is_insulin': True,
        'taken_at': {'$gte': lookback_time, '$lte': target_time}
    }))

    logger.debug(f"Found {len(active_insulin)} insulin doses in last 24h")

    try:
        from constants import Constants
        patient_constants = Constants(patient_id).get_patient_constants()
        medication_factors = patient_constants.get('medication_factors', {})
        correction_factor = patient_constants.get('correction_factor', 40)  # FIX N-1: was 50, standardised to 40 (matches pharmacodynamics.py L927 and TS layer ?? 40)
    except Exception as e:
        logger.warning(f"Error loading patient constants: {str(e)}")
        medication_factors = {}
        correction_factor = 40  # FIX N-1: was 50, standardised to 40

    total_iob = 0
    total_activity = 0
    total_bg_impact = 0
    total_absorbed_insulin = 0
    insulin_contributions = []

    for dose in active_insulin:
        taken_at = dose.get('taken_at')

        if not taken_at:
            logger.debug(f"Skipping dose {dose.get('_id')} - missing taken_at time")
            continue

        if isinstance(taken_at, str):
            try:
                taken_at = datetime.fromisoformat(taken_at.replace('Z', '+00:00')).replace(tzinfo=None)
            except ValueError:
                logger.warning(f"Could not parse taken_at for dose {dose.get('_id')}: {taken_at}")
                continue

        hours_since_dose = TimeManager.calculate_hours_since(
            target_time, taken_at, TimeManager.PRECISION_SECOND
        )

        # B-PD-3: Default fallback changed from 'regular_insulin' to 'insulin_aspart'.
        # Regular insulin has onset≈0.5h, peak≈2h, duration≈4h (gamma_moderate) and is
        # rarely used in modern T1D management. insulin_aspart (NovoRapid/NovoLog) is the
        # dominant rapid-acting analogue and its profile is the correct fallback when a
        # dose has no medication field or an unrecognised name.
        medication = dose.get('medication', 'insulin_aspart')

        profile = dose.get('effect_profile')

        if not profile:
            profile = medication_factors.get(medication)

        if not profile:
            logger.warning(f"No pharmacokinetics for {medication}, using default")
            # B-PD-3: Profile parameters updated to match insulin_aspart (NovoRapid/NovoLog):
            #   onset=0.375h (22.5 min), peak=2.25h, duration=4.5h, curve=gamma_steep.
            # Previously used regular_insulin values (onset=0.5h, peak=2h, duration=4h,
            # gamma_moderate) which underestimated speed of action for modern analogues.
            profile = {
                'onset_hours': 0.375,
                'peak_hours': 2.25,
                'duration_hours': 4.5,
                'type': 'rapid_acting',
                'is_peakless': False,
                'curve_type': 'gamma_steep'
            }

        if hours_since_dose < 0 or hours_since_dose > profile.get('duration_hours', 4.0):
            continue

        logger.debug(f"Processing dose: {medication}, {dose.get('dose')}u, {hours_since_dose:.2f}h ago")

        activity_percent = calculate_insulin_activity(hours_since_dose, profile)

        initial_dose = dose.get('dose', 0)
        active_units = (initial_dose * activity_percent) / 100

        iob = calculate_iob(hours_since_dose, initial_dose, profile)

        absorbed_units = initial_dose - iob
        total_absorbed_insulin += absorbed_units

        total_iob += iob
        total_activity += activity_percent

        bg_impact = active_units * correction_factor
        total_bg_impact += bg_impact

        logger.debug(
            f"  Activity: {activity_percent:.1f}%, IOB: {iob:.2f}u, Absorbed: {absorbed_units:.2f}u")

        insulin_contributions.append({
            'dose_id': str(dose.get('_id')),
            'medication': medication,
            'initial_dose': initial_dose,
            'taken_at': taken_at.isoformat() if isinstance(taken_at, datetime) else taken_at,
            'hours_since_dose': round(hours_since_dose, 2),
            'activity_percent': round(activity_percent, 1),
            'iob': round(iob, 2),
            'active_units': round(active_units, 2),
            'absorbed_units': round(absorbed_units, 2),
            'bg_impact': round(bg_impact, 1),
            'profile': {
                'onset': profile.get('onset_hours', 0.5),
                'peak': profile.get('peak_hours', 2.0),
                'duration': profile.get('duration_hours', 4.0),
                'type': profile.get('type', 'rapid_acting')
            }
        })

    current_bg_reduction = total_absorbed_insulin * correction_factor
    pending_bg_reduction = total_iob * correction_factor

    stacking_risk = 'low'
    if len(insulin_contributions) > 1:
        peak_overlaps = [c for c in insulin_contributions
                         if c['hours_since_dose'] >= c['profile']['peak'] * 0.5 and
                         c['hours_since_dose'] <= c['profile']['peak'] * 1.5]

        if total_iob > 15 or len(peak_overlaps) >= 3:
            stacking_risk = 'severe'
        elif total_iob > 10 or len(peak_overlaps) >= 2:
            stacking_risk = 'high'
        elif total_iob > 5:
            stacking_risk = 'moderate'

    logger.info(f"✅ IOB Complete: IOB={total_iob:.2f}u, Absorbed={total_absorbed_insulin:.2f}u, "
                f"BG Reduction=-{current_bg_reduction:.0f}/-{pending_bg_reduction:.0f}")

    return {
        'totalIOB': round(total_iob, 2),
        'total_active_insulin': round(total_iob, 2),
        'total_absorbed_insulin': round(total_absorbed_insulin, 2),
        'totalActivity': round(total_activity, 1),
        'totalBGImpact': round(total_bg_impact, 1),
        'current_bg_reduction': round(current_bg_reduction, 1),
        'pending_bg_reduction': round(pending_bg_reduction, 1),
        'calculation_time': target_time.isoformat(),
        'calculation_timezone': 'UTC',
        'activeDoses': len(insulin_contributions),
        'active_doses': len(insulin_contributions),
        'contributions': insulin_contributions,
        'insulin_contributions': insulin_contributions,
        'isStacking': len(insulin_contributions) > 1,
        'stackingRisk': stacking_risk,
        'bg_impact': round(-1 * pending_bg_reduction, 1)
    }


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def validate_time_format(time_str):
    try:
        datetime.strptime(time_str, '%H:%M')
        return True
    except ValueError:
        return False


def format_schedule(schedule):
    """Format schedule for JSON response"""
    return {
        'id': str(schedule['_id']),
        'medication': schedule['medication'],
        'startDate': schedule['startDate'].isoformat(),
        'endDate': schedule['endDate'].isoformat(),
        'dailyTimes': schedule['dailyTimes'],
        'created_at': schedule['created_at'].isoformat(),
        'updated_at': schedule.get('updated_at', '').isoformat() if schedule.get('updated_at') else None
    }


def create_initial_medication_logs(patient_id, medication, schedule):
    """Create initial medication logs for the next occurrence of each daily time."""
    try:
        current_date = datetime.utcnow().date()
        current_datetime = datetime.utcnow()

        for daily_time in schedule['dailyTimes']:
            try:
                time_obj = datetime.strptime(daily_time, '%H:%M').time()
                next_dose_datetime = datetime.combine(current_date, time_obj)

                if next_dose_datetime < current_datetime:
                    next_dose_datetime += timedelta(days=1)

                mongo.db.medication_logs.insert_one({
                    'patient_id': patient_id,
                    'medication': medication,
                    'scheduled_time': next_dose_datetime,
                    'taken_at': None,
                    'status': 'scheduled',
                    'created_at': current_datetime
                })

            except ValueError as e:
                logger.error(f"Error processing time {daily_time}: {str(e)}")
                continue

    except Exception as e:
        logger.error(f"Error creating initial medication logs: {str(e)}")
        raise


# ============================================================================
# MEDICATION SCHEDULE ENDPOINTS
# ============================================================================

@medication_routes.route('/api/medication-schedule/<patient_id>/<medication>', methods=['GET'])
@token_required
@api_error_handler
def get_medication_schedule(current_user, patient_id, medication):
    if current_user.get('user_type') != 'doctor' and str(current_user['_id']) != patient_id:
        return jsonify({'message': 'Unauthorized access'}), 403

    try:
        schedule = mongo.db.medication_schedules.find_one({
            'patient_id': patient_id,
            'medication': medication,
            'endDate': {'$gte': datetime.utcnow()}
        })

        if not schedule:
            return jsonify({'message': 'No active schedule found', 'schedule': None}), 200

        return jsonify({'schedule': format_schedule(schedule)}), 200
    except Exception as e:
        logger.error(f"Error fetching medication schedule: {str(e)}")
        return jsonify({'message': 'Error fetching medication schedule'}), 500


@medication_routes.route('/api/medication-schedule/<patient_id>', methods=['POST'])
@token_required
@api_error_handler
def create_or_update_schedule(current_user, patient_id):
    try:
        logger.info(f"Received schedule update request for patient {patient_id}")
        data = request.json
        if not data:
            return jsonify({'message': 'No data provided'}), 400

        if current_user.get('user_type') != 'doctor' and str(current_user['_id']) != patient_id:
            return jsonify({'message': 'Unauthorized access'}), 403

        medication = data.get('medication')
        schedule_data = data.get('schedule')

        if not all([medication, schedule_data, schedule_data.get('startDate'),
                    schedule_data.get('endDate'), schedule_data.get('dailyTimes')]):
            return jsonify({'message': 'Missing required fields'}), 400

        try:
            start_date = datetime.fromisoformat(schedule_data['startDate'].replace('Z', '+00:00'))
            end_date = datetime.fromisoformat(schedule_data['endDate'].replace('Z', '+00:00'))

            if end_date < start_date:
                return jsonify({'message': 'End date must be after start date'}), 400

        except ValueError as e:
            logger.error(f"Date validation error: {str(e)}")
            return jsonify({'message': 'Invalid date format'}), 400

        daily_times = schedule_data['dailyTimes']
        if not all(isinstance(t, str) and len(t.split(':')) == 2 for t in daily_times):
            return jsonify({'message': 'Invalid time format'}), 400

        daily_times.sort()

        schedule = {
            'patient_id': patient_id,
            'medication': medication,
            'startDate': start_date,
            'endDate': end_date,
            'dailyTimes': daily_times,
            'updated_at': datetime.utcnow(),
            'updated_by': str(current_user['_id'])
        }

        result = mongo.db.medication_schedules.update_one(
            {
                'patient_id': patient_id,
                'medication': medication,
                'endDate': {'$gte': datetime.utcnow()}
            },
            {
                '$set': schedule,
                '$setOnInsert': {
                    'created_at': datetime.utcnow(),
                    'created_by': str(current_user['_id'])
                }
            },
            upsert=True
        )

        mongo.db.users.update_one(
            {'_id': ObjectId(patient_id)},
            {
                '$set': {
                    f'medication_schedules.{medication}': {
                        'id': str(result.upserted_id) if result.upserted_id else None,
                        'startDate': start_date,
                        'endDate': end_date,
                        'dailyTimes': daily_times,
                        'updated_at': datetime.utcnow()
                    }
                }
            }
        )

        if result.upserted_id:
            create_initial_medication_logs(patient_id, medication, schedule)

        updated_schedule = mongo.db.medication_schedules.find_one({
            'patient_id': patient_id,
            'medication': medication,
            'endDate': {'$gte': datetime.utcnow()}
        })

        if not updated_schedule:
            return jsonify({'message': 'Error retrieving updated schedule'}), 500

        return jsonify({
            'message': 'Medication schedule updated successfully',
            'schedule': format_schedule(updated_schedule)
        }), 200

    except Exception as e:
        logger.error(f"Error updating medication schedule: {str(e)}", exc_info=True)
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


@medication_routes.route('/api/my-medication-schedule', methods=['GET'])
@token_required
@api_error_handler
def get_my_schedules(current_user):
    try:
        schedules = list(mongo.db.medication_schedules.find({
            'patient_id': str(current_user['_id']),
            'endDate': {'$gte': datetime.utcnow()}
        }))

        formatted_schedules = [format_schedule(schedule) for schedule in schedules]
        return jsonify({'schedules': formatted_schedules}), 200

    except Exception as e:
        logger.error(f"Error fetching medication schedules: {str(e)}")
        return jsonify({'message': 'Error fetching medication schedules'}), 500


@medication_routes.route('/api/medication-schedule/<patient_id>/<schedule_id>', methods=['DELETE'])
@token_required
@api_error_handler
def delete_medication_schedule(current_user, patient_id, schedule_id):
    if current_user.get('user_type') != 'doctor' and str(current_user['_id']) != patient_id:
        return jsonify({'message': 'Unauthorized access'}), 403

    try:
        schedule = mongo.db.medication_schedules.find_one({
            '_id': ObjectId(schedule_id),
            'patient_id': patient_id
        })

        if not schedule:
            return jsonify({'message': 'Schedule not found'}), 404

        mongo.db.medication_schedules.delete_one({
            '_id': ObjectId(schedule_id),
            'patient_id': patient_id
        })

        mongo.db.medication_logs.delete_many({
            'patient_id': patient_id,
            'medication': schedule['medication'],
            'scheduled_time': {'$gte': datetime.utcnow()},
            'status': 'scheduled'
        })

        return jsonify({
            'message': 'Medication schedule deleted successfully',
            'deleted_schedule_id': schedule_id
        }), 200
    except Exception as e:
        logger.error(f"Error deleting medication schedule: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


# ============================================================================
# MEDICATION LOG ENDPOINTS
# ============================================================================

@medication_routes.route('/api/medication-log/<patient_id>', methods=['POST'])
@token_required
@api_error_handler
def log_medication_dose(current_user, patient_id):
    try:
        if current_user.get('user_type') != 'doctor' and str(current_user['_id']) != patient_id:
            return jsonify({'message': 'Unauthorized access'}), 403

        data = request.json
        if not data:
            return jsonify({'message': 'No data provided'}), 400

        required_fields = ['medication', 'dose', 'scheduled_time']
        if not all(field in data for field in required_fields):
            return jsonify({"error": "Missing required fields"}), 400

        try:
            scheduled_time = datetime.fromisoformat(data['scheduled_time'].replace('Z', '+00:00'))
        except ValueError:
            return jsonify({"error": "Invalid date format"}), 400

        log_doc = {
            'patient_id': patient_id,
            'medication': data['medication'],
            'dose': float(data['dose']),
            'scheduled_time': scheduled_time,
            'taken_at': datetime.utcnow(),
            'status': 'taken',
            'created_at': datetime.utcnow(),
            'created_by': str(current_user['_id']),
            'notes': data.get('notes', ''),
            'is_insulin': data.get('is_insulin', False)
        }

        result = mongo.db.medication_logs.insert_one(log_doc)

        if data.get('is_insulin', False):
            meal_doc = {
                'user_id': patient_id,
                'timestamp': scheduled_time,
                'mealType': 'insulin_only',
                'foodItems': [],
                'activities': [],
                'nutrition': {
                    'calories': 0, 'carbs': 0, 'protein': 0, 'fat': 0,
                    'absorption_factor': 1.0
                },
                'intendedInsulin': float(data['dose']),
                'intendedInsulinType': data['medication'],
                'notes': data.get('notes', ''),
                'medication_log_id': str(result.inserted_id)
            }
            mongo.db.meals.insert_one(meal_doc)

        return jsonify({
            "message": "Medication dose logged successfully",
            "id": str(result.inserted_id)
        }), 201

    except Exception as e:
        logger.error(f"Error logging medication dose: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


# ============================================================================
# ✅ FIX: These were previously NESTED inside log_medication_dose!
# Now they are at MODULE LEVEL where Flask can register them as routes.
# ============================================================================

@medication_routes.route('/api/medication-logs/recent', methods=['GET'])
@token_required
@api_error_handler
def get_recent_medication_logs(current_user):
    try:
        medication_type = request.args.get('medication_type')
        limit = int(request.args.get('limit', 3))

        query_filter = {'patient_id': str(current_user['_id'])}

        if medication_type == 'insulin':
            query_filter['is_insulin'] = True

        recent_logs = list(mongo.db.medication_logs.find(
            query_filter
        ).sort('taken_at', -1).limit(limit))

        formatted_logs = []
        for log in recent_logs:
            formatted_log = {
                'id': str(log['_id']),
                'medication': log['medication'],
                'dose': log['dose'],
                'scheduled_time': log['scheduled_time'].isoformat() + 'Z'
                if isinstance(log['scheduled_time'], datetime) else log['scheduled_time'],
                'taken_at': log['taken_at'].isoformat() + 'Z'
                if isinstance(log['taken_at'], datetime) else log['taken_at'],
                'status': log['status'],
                'notes': log.get('notes', ''),
                'is_insulin': log.get('is_insulin', False)
            }
            formatted_logs.append(formatted_log)

        return jsonify({'logs': formatted_logs})

    except Exception as e:
        logger.error(f"Error retrieving recent medication logs: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


@medication_routes.route('/api/medication-schedule/<patient_id>', methods=['GET'])
@token_required
@api_error_handler
def get_patient_schedules(current_user, patient_id):
    if current_user.get('user_type') != 'doctor' and str(current_user['_id']) != patient_id:
        return jsonify({'message': 'Unauthorized access'}), 403

    try:
        schedules = list(mongo.db.medication_schedules.find({
            'patient_id': patient_id,
            'endDate': {'$gte': datetime.utcnow()}
        }))

        formatted_schedules = []
        for schedule in schedules:
            formatted_schedule = format_schedule(schedule)

            if schedule.get('is_insulin'):
                recent_doses = list(mongo.db.medication_logs.find({
                    'patient_id': patient_id,
                    'medication': schedule['medication'],
                    'is_insulin': True,
                    'taken_at': {'$gte': datetime.utcnow() - timedelta(days=7)}
                }).sort('taken_at', -1).limit(5))

                formatted_schedule['recent_doses'] = [{
                    'dose': dose['dose'],
                    'taken_at': dose['taken_at'].isoformat(),
                    'meal_type': dose.get('meal_type'),
                    'blood_sugar': dose.get('blood_sugar')
                } for dose in recent_doses]

            formatted_schedules.append(formatted_schedule)

        return jsonify({'schedules': formatted_schedules}), 200

    except Exception as e:
        logger.error(f"Error fetching medication schedules: {str(e)}")
        return jsonify({'message': 'Error fetching medication schedules'}), 500


# ============================================================================
# INSULIN-SPECIFIC ENDPOINTS
# ============================================================================

@medication_routes.route('/api/insulin-schedule/summary', methods=['GET'])
@token_required
@api_error_handler
def get_insulin_schedule_summary(current_user):
    try:
        days = int(request.args.get('days', 7))
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=days)

        doses = list(mongo.db.medication_logs.find({
            'patient_id': str(current_user['_id']),
            'is_insulin': True,
            'taken_at': {'$gte': start_date, '$lte': end_date}
        }).sort('taken_at', 1))

        summary = {}
        for dose in doses:
            med_type = dose['medication']
            if med_type not in summary:
                summary[med_type] = {
                    'total_doses': 0, 'avg_dose': 0,
                    'dose_times': {}, 'meal_types': {}
                }

            time_str = dose['taken_at'].strftime('%H:%M')
            meal_type = dose.get('meal_type', 'other')

            summary[med_type]['total_doses'] += 1
            summary[med_type]['avg_dose'] = (
                    (summary[med_type]['avg_dose'] * (summary[med_type]['total_doses'] - 1) +
                     dose['dose']) / summary[med_type]['total_doses']
            )

            if time_str not in summary[med_type]['dose_times']:
                summary[med_type]['dose_times'][time_str] = 0
            summary[med_type]['dose_times'][time_str] += 1

            if meal_type not in summary[med_type]['meal_types']:
                summary[med_type]['meal_types'][meal_type] = 0
            summary[med_type]['meal_types'][meal_type] += 1

        return jsonify({
            'summary': summary,
            'date_range': {
                'start': start_date.isoformat(),
                'end': end_date.isoformat()
            }
        }), 200

    except Exception as e:
        logger.error(f"Error generating insulin schedule summary: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


@medication_routes.route('/api/insulin-data', methods=['GET'])
@token_required
@api_error_handler
def get_insulin_data(current_user):
    """Retrieve insulin data for visualization."""
    try:
        days = int(request.args.get('days', 30))
        end_date_str = request.args.get('end_date')
        patient_id = request.args.get('patient_id')

        end_date = datetime.utcnow()

        if end_date_str:
            try:
                if 'T' in end_date_str:
                    parsed_end = datetime.fromisoformat(end_date_str.replace('Z', '+00:00'))
                    end_date = parsed_end.replace(tzinfo=None)
                else:
                    parsed_end = datetime.strptime(end_date_str, '%Y-%m-%d')
                    end_date = parsed_end.replace(hour=23, minute=59, second=59)
            except ValueError:
                logger.warning(f"Invalid end_date format: {end_date_str}, using current time")
                end_date = datetime.utcnow()

        start_date = end_date - timedelta(days=days)
        start_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)

        logger.info(f"📅 Insulin query: {start_date.isoformat()} to {end_date.isoformat()} ({days} days)")

        target_user_id = patient_id if patient_id else str(current_user['_id'])

        if patient_id and current_user.get('role') != 'doctor':
            return jsonify({'error': 'Unauthorized access to patient data'}), 403

        query = {
            'patient_id': target_user_id,
            'is_insulin': True,
            'taken_at': {'$gte': start_date, '$lte': end_date}
        }

        insulin_logs = list(mongo.db.medication_logs.find(query).sort('taken_at', pymongo.DESCENDING))

        logger.info(f"✅ Found {len(insulin_logs)} insulin doses")

        formatted_logs = []
        for log in insulin_logs:
            taken_at = log.get('taken_at')
            if isinstance(taken_at, str):
                try:
                    taken_at = datetime.fromisoformat(taken_at.replace('Z', '+00:00')).replace(tzinfo=None)
                except ValueError:
                    continue

            insulin_log = {
                'id': str(log['_id']),
                'medication': log['medication'],
                'dose': log['dose'],
                'taken_at': taken_at.isoformat() + 'Z' if isinstance(taken_at, datetime) else taken_at,
                'scheduled_time': log.get('scheduled_time', taken_at).isoformat() + 'Z'
                if isinstance(log.get('scheduled_time', taken_at), datetime)
                else log.get('scheduled_time', taken_at),
                'notes': log.get('notes', ''),
                'status': log.get('status', 'completed'),
                'meal_type': log.get('meal_type', 'insulin_only'),
                'is_insulin': True,
                'blood_sugar': log.get('blood_sugar')
            }

            if log.get('meal_id'):
                insulin_log['meal_id'] = log['meal_id']

            if log.get('effect_profile'):
                insulin_log['pharmacokinetics'] = log['effect_profile']
            else:
                try:
                    from constants import Constants
                    pc = Constants(target_user_id).get_patient_constants()
                    if pc and 'medication_factors' in pc:
                        insulin_type = log['medication']
                        if insulin_type in pc['medication_factors']:
                            insulin_log['pharmacokinetics'] = pc['medication_factors'][insulin_type]
                except Exception as e:
                    logger.warning(f"Error fetching insulin parameters: {str(e)}")

            formatted_logs.append(insulin_log)

        return jsonify({
            'insulin_logs': formatted_logs,
            'meta': {
                'start_date': start_date.isoformat(),
                'end_date': end_date.isoformat(),
                'count': len(formatted_logs),
                'days_requested': days
            }
        })

    except Exception as e:
        logger.error(f"❌ Error retrieving insulin data: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


@medication_routes.route('/api/insulin/log', methods=['POST', 'OPTIONS'])
@token_required
@api_error_handler
def log_insulin_dose(current_user):
    """Log an insulin dose from mobile app or web interface."""
    try:
        data = request.json

        if not data.get('medication'):
            return jsonify({'error': 'Medication type is required'}), 400
        if not data.get('dose'):
            return jsonify({'error': 'Dose is required'}), 400

        try:
            if data.get('taken_at'):
                taken_at_ts = TimeManager.parse_timestamp(
                    data['taken_at'], TimeManager.PRECISION_SECOND
                )
                taken_at = TimeManager.to_datetime(taken_at_ts, TimeManager.PRECISION_SECOND)
            else:
                taken_at = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)
        except Exception as e:
            logger.error(f"Error parsing taken_at time: {e}")
            taken_at = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)

        from constants import Constants
        patient_constants = Constants(str(current_user['_id'])).get_patient_constants()
        insulin_type = data['medication']
        insulin_profile = patient_constants.get('medication_factors', {}).get(insulin_type, {})

        onset_hours = insulin_profile.get('onset_hours', 0.5)
        duration_hours = insulin_profile.get('duration_hours', 4.0)
        is_peakless = insulin_profile.get('is_peakless', False)
        peak_hours = insulin_profile.get('peak_hours')
        curve_type = insulin_profile.get('curve_type', 'gamma_moderate')

        if peak_hours is None or is_peakless:
            peak_hours = duration_hours / 2

        medication_log = {
            'patient_id': str(current_user['_id']),
            'medication': data['medication'],
            'dose': float(data['dose']),
            'scheduled_time': taken_at,
            'taken_at': taken_at,
            'status': 'taken',
            'created_at': datetime.utcnow(),
            'created_by': str(current_user['_id']),
            'notes': data.get('notes', ''),
            'is_insulin': True,
            'meal_type': data.get('meal_type', 'insulin_only'),
            'blood_sugar': data.get('blood_sugar'),
            'effect_start_time': taken_at,
            'onset_time': taken_at + timedelta(hours=onset_hours),
            'peak_time': taken_at + timedelta(hours=peak_hours),
            'effect_end_time': taken_at + timedelta(hours=duration_hours),
            'effect_profile': {
                'onset_hours': onset_hours,
                'peak_hours': peak_hours,
                'duration_hours': duration_hours,
                'is_peakless': is_peakless,
                'curve_type': curve_type,
                'type': insulin_profile.get('type', 'rapid_acting')
            }
        }

        result = mongo.db.medication_logs.insert_one(medication_log)
        medication_log_id = str(result.inserted_id)

        meal_record = {
            'user_id': str(current_user['_id']),
            'meal_type': 'insulin_only',
            'recording_type': 'insulin',
            'timestamp': taken_at,
            'created_at': datetime.utcnow(),
            'foodItems': [],
            'activities': [],
            'nutrition': {
                'calories': 0, 'carbs': 0, 'protein': 0, 'fat': 0,
                'absorption_factor': 1.0
            },
            'blood_sugar': data.get('blood_sugar'),
            'intendedInsulin': float(data['dose']),
            'intendedInsulinType': data['medication'],
            'suggestedInsulin': 0,
            'suggestedInsulinType': data['medication'],
            'insulinCalculation': {},
            'notes': data.get('notes', ''),
            'medication_log_id': medication_log_id
        }

        meal_result = mongo.db.meals.insert_one(meal_record)

        user = mongo.db.users.find_one({'_id': current_user['_id']})
        if data['medication'] not in user.get('active_medications', []):
            mongo.db.users.update_one(
                {'_id': current_user['_id']},
                {'$addToSet': {'active_medications': data['medication']}}
            )

        logger.info(f"Logged insulin dose: {medication_log['dose']}u of {medication_log['medication']}")

        return jsonify({
            'message': 'Insulin dose logged successfully',
            'id': medication_log_id,
            'meal_id': str(meal_result.inserted_id),
            'medication_log': {
                'id': medication_log_id,
                'patient_id': str(current_user['_id']),
                'medication': medication_log['medication'],
                'dose': medication_log['dose'],
                'taken_at': taken_at.isoformat() + 'Z',
                'scheduled_time': taken_at.isoformat() + 'Z',
                'status': medication_log['status'],
                'notes': medication_log['notes'],
                'effect_start_time': medication_log['effect_start_time'].isoformat() + 'Z',
                'onset_time': medication_log['onset_time'].isoformat() + 'Z',
                'peak_time': medication_log['peak_time'].isoformat() + 'Z',
                'effect_end_time': medication_log['effect_end_time'].isoformat() + 'Z'
            }
        }), 201

    except Exception as e:
        logger.error(f"Error logging insulin dose: {str(e)}", exc_info=True)
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


@medication_routes.route('/api/insulin-analytics', methods=['GET'])
@token_required
@api_error_handler
def get_insulin_analytics(current_user):
    """Get insulin analytics including timing patterns and effectiveness."""
    try:
        days = int(request.args.get('days', 30))
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=days)

        patient_id = request.args.get('patient_id')
        if patient_id and current_user.get('user_type') != 'doctor':
            return jsonify({'error': 'Unauthorized access'}), 403

        user_id = patient_id if patient_id else str(current_user['_id'])

        pipeline = [
            {
                '$match': {
                    'patient_id': user_id,
                    'is_insulin': True,
                    'taken_at': {'$gte': start_date, '$lte': end_date}
                }
            },
            {
                '$group': {
                    '_id': '$medication',
                    'total_doses': {'$sum': 1},
                    'avg_dose': {'$avg': '$dose'},
                    'doses': {'$push': {
                        'dose': '$dose',
                        'taken_at': '$taken_at',
                        'blood_sugar': '$blood_sugar',
                        'meal_type': '$meal_type',
                        'meal_id': '$meal_id'
                    }}
                }
            }
        ]

        insulin_analytics = list(mongo.db.medication_logs.aggregate(pipeline))

        return jsonify({
            'insulin_analytics': insulin_analytics,
            'date_range': {
                'start': start_date.isoformat(),
                'end': end_date.isoformat()
            }
        })

    except Exception as e:
        logger.error(f"Error retrieving insulin analytics: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses


@medication_routes.route('/api/insulin/active-effect', methods=['GET'])
@token_required
@api_error_handler
def get_active_insulin_effect(current_user):
    """Get currently active insulin and stacked effect."""
    try:
        patient_id = request.args.get('patient_id')
        if patient_id and current_user.get('user_type') != 'doctor':
            return jsonify({'error': 'Unauthorized access'}), 403

        user_id = patient_id if patient_id else str(current_user['_id'])

        target_time_str = request.args.get('target_time')
        target_time = None
        if target_time_str:
            try:
                target_time_ts = TimeManager.parse_timestamp(
                    target_time_str, TimeManager.PRECISION_SECOND
                )
                target_time = TimeManager.to_datetime(target_time_ts, TimeManager.PRECISION_SECOND)
            except ValueError:
                return jsonify({'error': 'Invalid target time format'}), 400

        active_insulin = calculate_stacked_insulin_effect(user_id, target_time)

        return jsonify(active_insulin)

    except Exception as e:
        logger.error(f"Error calculating active insulin: {str(e)}")
        raise  # OBS-2: let @api_error_handler return a safe generic error; str(e) must not leak into API responses