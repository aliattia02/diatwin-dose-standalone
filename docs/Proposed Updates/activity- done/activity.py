from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from datetime import datetime, timedelta
from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from constants import Constants
import logging

logger = logging.getLogger(__name__)
activity_bp = Blueprint('activity', __name__)

# ─── Valid intensity values (matches ACTIVITY_INTENSITY_LEVELS in constants.py) ─
VALID_INTENSITIES = {'light', 'moderate', 'vigorous'}


def validate_activity_level(level):
    """Validate activity level against Constants"""
    valid_levels = [level['value'] for level in Constants.ACTIVITY_LEVELS]
    if level not in valid_levels:
        return False, f"Invalid activity level. Must be one of {valid_levels}"
    return True, None


def get_activity_impact(level):
    """Get activity impact coefficient from Constants"""
    for activity in Constants.ACTIVITY_LEVELS:
        if activity['value'] == level:
            return activity['impact']
    return 0


def parse_duration(duration):
    try:
        if isinstance(duration, str):
            hours, minutes = map(int, duration.split(':'))
            return hours + minutes / 60
        elif isinstance(duration, (int, float)):
            return duration
        else:
            return 1.0
    except Exception as e:
        logger.warning(f"Error parsing duration {duration}: {e}")
        return 1.0


def format_duration(duration):
    try:
        hours = int(duration)
        minutes = int((duration - hours) * 60)
        return f"{hours:02d}:{minutes:02d}"
    except Exception as e:
        logger.warning(f"Error formatting duration {duration}: {e}")
        return "01:00"


def format_time(time_value):
    try:
        if isinstance(time_value, str):
            return time_value
        elif isinstance(time_value, datetime):
            return time_value.isoformat()
        else:
            return None
    except Exception as e:
        logger.warning(f"Error formatting time value: {time_value}, {e}")
        return None


# ─── Record activities ────────────────────────────────────────────────────────

@activity_bp.route('/api/record-activities', methods=['POST'])
@token_required
def record_activities(current_user):
    """
    Record expected and/or completed activities.

    Payload fields (per activity object):
        level            (int, optional)  — −2..2 integer (legacy)
        intensity        (str, optional)  — 'light' | 'moderate' | 'vigorous'
                          When provided, stored directly and used by the ODE model.
                          When absent, derived from the legacy `level` field.
        duration_minutes (float, optional) — session length in minutes.
                          Preferred over the legacy 'duration' HH:MM string.
        startTime        (str, optional)  — ISO-8601 exercise start
        endTime          (str, optional)  — ISO-8601 exercise end
        completedTime    (str, optional)  — ISO-8601 completion time
        duration         (str, optional)  — legacy 'HH:MM' string
        hr_trace         (list, optional) — [{t_min, hr_bpm}, ...] from wearable.
                          If absent, the ODE model builds a synthetic HR trace
                          from intensity + duration_minutes automatically.
        hr_base          (float, optional) — resting HR override for this session
        hr_max           (float, optional) — max HR override for this session
        bg_direction     (int, optional)  — −1 (lowers BG, default) | +1 (raises BG)
        notes            (str, optional)
    """
    data = request.json
    expected_activities  = data.get('expectedActivities', [])
    completed_activities = data.get('completedActivities', [])

    user_id   = str(current_user['_id'])
    timestamp = datetime.utcnow()

    user_constants        = Constants(user_id)
    activities_collection = mongo.db.activities

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _resolve_intensity(activity: dict) -> str:
        """
        Resolve the intensity string for storage.
        Priority: explicit 'intensity' field → derived from legacy 'level'.
        """
        if activity.get('intensity') in VALID_INTENSITIES:
            return activity['intensity']
        level = activity.get('level')
        if level is not None:
            from utils.activity_pharmacodynamics import LEVEL_TO_INTENSITY
            mapped = LEVEL_TO_INTENSITY.get(int(level))
            if mapped:
                return mapped
        return 'moderate'   # safe fallback

    def _resolve_duration_minutes(activity: dict, record: dict) -> float:
        """
        Resolve session duration in minutes.
        Priority: duration_minutes → endTime−startTime → duration HH:MM → 30 min.
        """
        if activity.get('duration_minutes'):
            return float(activity['duration_minutes'])

        start = record.get('startTime') or record.get('completedTime')
        end   = record.get('endTime')
        if start and end:
            try:
                if isinstance(start, str):
                    start = datetime.fromisoformat(start.replace('Z', '+00:00'))
                if isinstance(end, str):
                    end   = datetime.fromisoformat(end.replace('Z', '+00:00'))
                diff = (end - start).total_seconds() / 60.0
                if diff > 0:
                    return round(diff, 1)
            except Exception:
                pass

        duration_str = activity.get('duration', '00:30')
        try:
            parts = str(duration_str).split(':')
            if len(parts) == 2:
                return int(parts[0]) * 60.0 + int(parts[1])
        except Exception:
            pass
        return 30.0

    # ── Activity builder ──────────────────────────────────────────────────────

    def process_activity(activity: dict, activity_type: str) -> dict:
        try:
            # Validate legacy integer level when present (level is now optional)
            if 'level' in activity:
                is_valid, error_message = validate_activity_level(activity['level'])
                if not is_valid:
                    raise ValueError(error_message)

            activity_record = {
                'user_id':      user_id,
                'timestamp':    timestamp,
                'type':         activity_type,
                'level':        activity.get('level', 0),
                'impact':       get_activity_impact(activity.get('level', 0)),
                # ── ODE model fields ─────────────────────────────────────────
                # intensity is always resolved and stored so the model can skip
                # the level lookup on every calculation.
                'intensity':    _resolve_intensity(activity),
                # bg_direction: -1 = lowers BG (default aerobic), +1 = raises BG.
                'bg_direction': int(activity.get('bg_direction', -1)),
            }

            # ── Time fields ───────────────────────────────────────────────────
            for tf in ('startTime', 'endTime', 'duration'):
                if tf in activity:
                    activity_record[tf] = activity[tf]

            if activity_type == 'expected':
                expected_time = activity.get('expectedTime') or activity.get('startTime')
                if expected_time:
                    activity_record['expectedTime'] = expected_time
            else:
                completed_time = activity.get('completedTime') or activity.get('startTime')
                if completed_time:
                    activity_record['completedTime'] = completed_time

            # ── Duration ──────────────────────────────────────────────────────
            # Store both the legacy HH:MM string (backward compat) and the
            # float minutes field (used by the ODE model).
            if 'duration' not in activity_record:
                activity_record['duration'] = format_duration(
                    parse_duration(activity.get('duration', '00:30'))
                )

            duration_minutes = _resolve_duration_minutes(activity, activity_record)
            activity_record['duration_minutes'] = round(duration_minutes, 1)

            # ── Optional wearable / HR fields ─────────────────────────────────
            # hr_trace: list of {t_min, hr_bpm} dicts from a connected wearable.
            # When absent the ODE model builds a synthetic trace from
            # intensity + duration_minutes automatically — no wearable required.
            for opt in ('hr_trace', 'hr_base', 'hr_max'):
                if opt in activity:
                    activity_record[opt] = activity[opt]

            # ── Notes ─────────────────────────────────────────────────────────
            if 'notes' in activity:
                activity_record['notes'] = activity['notes']

            return activity_record

        except Exception as e:
            logger.error(f"Error processing activity: {str(e)}")
            raise

    try:
        expected_ids = []
        for activity in expected_activities:
            record = process_activity(activity, 'expected')
            result = activities_collection.insert_one(record)
            expected_ids.append(str(result.inserted_id))

        completed_ids = []
        for activity in completed_activities:
            record = process_activity(activity, 'completed')
            result = activities_collection.insert_one(record)
            completed_ids.append(str(result.inserted_id))

        all_activity_ids = expected_ids + completed_ids

        return jsonify({
            "message":                "Activities recorded successfully",
            "expected_activity_ids":  expected_ids,
            "completed_activity_ids": completed_ids,
            "activity_ids":           all_activity_ids,
        }), 201

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.error(f"Error recording activities: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


# ─── Activity history / lookup routes ─────────────────────────────────────────

@activity_bp.route('/api/activity-history', methods=['GET'])
@token_required
def get_activity_history(current_user):
    try:
        user_id = str(current_user['_id'])
        logger.info(f"Fetching activity history for user {user_id}")

        start_date_str  = request.args.get('start_date')
        end_date_str    = request.args.get('end_date')
        start_time_str  = request.args.get('start_time')
        end_time_str    = request.args.get('end_time')
        filter_by       = request.args.get('filter_by', 'timestamp')
        include_details = request.args.get('include_meal_details') == 'true'

        logger.debug(
            f"Filter parameters: start_date={start_date_str}, end_date={end_date_str}, "
            f"start_time={start_time_str}, end_time={end_time_str}, filter_by={filter_by}"
        )

        query = {"user_id": user_id}

        start_datetime = None
        end_datetime   = None

        if start_time_str:
            try:
                if start_time_str.endswith('Z'):
                    start_time_str = start_time_str[:-1] + '+00:00'
                start_datetime = datetime.fromisoformat(start_time_str)
                logger.debug(f"Using exact start time: {start_datetime}")
            except Exception as e:
                logger.error(f"Error parsing start_time '{start_time_str}': {e}")
                return jsonify({"error": f"Invalid start_time format: {start_time_str}"}), 400

        if end_time_str:
            try:
                if end_time_str.endswith('Z'):
                    end_time_str = end_time_str[:-1] + '+00:00'
                end_datetime = datetime.fromisoformat(end_time_str)
                logger.debug(f"Using exact end time: {end_datetime}")
            except Exception as e:
                logger.error(f"Error parsing end_time '{end_time_str}': {e}")
                return jsonify({"error": f"Invalid end_time format: {end_time_str}"}), 400

        if not start_datetime and start_date_str:
            try:
                start_datetime = datetime.strptime(start_date_str, '%Y-%m-%d')
            except Exception as e:
                logger.error(f"Error parsing start_date '{start_date_str}': {e}")
                return jsonify({"error": f"Invalid start_date format: {start_date_str}"}), 400

        if not end_datetime and end_date_str:
            try:
                end_datetime = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
            except Exception as e:
                logger.error(f"Error parsing end_date '{end_date_str}': {e}")
                return jsonify({"error": f"Invalid end_date format: {end_date_str}"}), 400

        if start_datetime or end_datetime:
            if filter_by == 'startTime':
                filter_fields = ['startTime', 'expectedTime']
            elif filter_by == 'endTime':
                filter_fields = ['endTime']
            else:
                filter_fields = ['timestamp']

            time_conditions = []
            for field in filter_fields:
                field_condition = {}
                if start_datetime:
                    field_condition["$gte"] = start_datetime
                if end_datetime:
                    field_condition["$lt"] = end_datetime
                if field_condition:
                    time_conditions.append({field: field_condition})

            if start_datetime and end_datetime and 'startTime' in filter_fields:
                time_conditions.append({
                    "startTime": {"$lte": start_datetime},
                    "endTime":   {"$gte": end_datetime},
                })

            if time_conditions:
                query["$or"] = time_conditions

        logger.debug(f"Final activity query: {query}")
        user_activities = list(mongo.db.activities.find(query).sort("timestamp", -1))
        logger.debug(f"Found {len(user_activities)} activities")

        activity_level_map = {level['value']: level['label'] for level in Constants.ACTIVITY_LEVELS}

        formatted_activities = []
        for activity in user_activities:
            try:
                formatted_activity = {
                    "id":           str(activity['_id']),
                    "type":         activity.get('type', 'unknown'),
                    "level":        activity.get('level', 0),
                    "levelLabel":   activity_level_map.get(activity.get('level', 0), "Unknown"),
                    "impact":       activity.get('impact', get_activity_impact(activity.get('level', 0))),
                    "duration":     activity.get('duration', '01:00'),
                    "timestamp":    format_time(activity.get('timestamp', datetime.utcnow())),
                    # ── ODE model fields ─────────────────────────────────────
                    "intensity":        activity.get('intensity', 'moderate'),
                    "duration_minutes": activity.get('duration_minutes'),
                    "bg_direction":     activity.get('bg_direction', -1),
                }

                for tf in ('startTime', 'endTime', 'expectedTime', 'completedTime'):
                    if tf in activity:
                        formatted_activity[tf] = format_time(activity[tf])

                if 'notes' in activity:
                    formatted_activity["notes"] = activity['notes']

                if 'meal_id' in activity:
                    formatted_activity["meal_id"] = activity['meal_id']
                    if include_details and activity['meal_id']:
                        try:
                            meal = mongo.db.meals.find_one({'_id': ObjectId(activity['meal_id'])})
                            if meal:
                                formatted_activity["meal_details"] = {
                                    "mealType":       meal.get('mealType', 'unknown'),
                                    "timestamp":      format_time(meal.get('timestamp')),
                                    "nutrition":      meal.get('nutrition'),
                                    "bloodSugar":     meal.get('bloodSugar'),
                                    "intendedInsulin": meal.get('intendedInsulin'),
                                }
                        except Exception as e:
                            logger.error(f"Error fetching meal details for activity {activity['_id']}: {e}")

                if include_details:
                    for opt in ('hr_base', 'hr_max'):
                        if opt in activity:
                            formatted_activity[opt] = activity[opt]

                formatted_activities.append(formatted_activity)
            except Exception as e:
                logger.error(f"Error formatting activity {activity.get('_id', 'unknown')}: {e}")

        return jsonify(formatted_activities), 200

    except Exception as e:
        logger.error(f"Error fetching activity history: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@activity_bp.route('/api/patient/<patient_id>/activity-history', methods=['GET'])
@token_required
def get_patient_activity_history(current_user, patient_id):
    if current_user['user_type'] != 'doctor':
        return jsonify({"error": "Unauthorized access"}), 403

    try:
        logger.info(f"Doctor {str(current_user['_id'])} fetching activity history for patient {patient_id}")

        start_date_str = request.args.get('start_date')
        end_date_str   = request.args.get('end_date')

        query = {"user_id": patient_id}

        if start_date_str or end_date_str:
            start_date = None
            end_date   = None

            if start_date_str:
                try:
                    start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
                except Exception as e:
                    logger.error(f"Error parsing start date '{start_date_str}': {e}")
                    return jsonify({"error": f"Invalid start date format: {start_date_str}"}), 400

            if end_date_str:
                try:
                    end_date = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
                except Exception as e:
                    logger.error(f"Error parsing end date '{end_date_str}': {e}")
                    return jsonify({"error": f"Invalid end date format: {end_date_str}"}), 400

            time_conditions = []

            timestamp_condition = {}
            if start_date:
                timestamp_condition["$gte"] = start_date
            if end_date:
                timestamp_condition["$lt"] = end_date
            if timestamp_condition:
                time_conditions.append({"timestamp": timestamp_condition})

            for time_field in ["startTime", "expectedTime", "completedTime"]:
                cond = {}
                if start_date:
                    cond["$gte"] = start_date
                if end_date:
                    cond["$lt"] = end_date
                if cond:
                    time_conditions.append({time_field: cond})

            if start_date and end_date:
                time_conditions.append({
                    "startTime": {"$lte": start_date},
                    "endTime":   {"$gte": end_date},
                })

            if time_conditions:
                query["$or"] = time_conditions

        patient_activities = list(mongo.db.activities.find(query).sort("timestamp", -1))
        logger.debug(f"Found {len(patient_activities)} activities for patient {patient_id}")

        activity_level_map = {level['value']: level['label'] for level in Constants.ACTIVITY_LEVELS}

        formatted_activities = []
        for activity in patient_activities:
            try:
                formatted_activity = {
                    "id":           str(activity['_id']),
                    "type":         activity.get('type', 'unknown'),
                    "level":        activity.get('level', 0),
                    "levelLabel":   activity_level_map.get(activity.get('level', 0), "Unknown"),
                    "impact":       activity.get('impact', get_activity_impact(activity.get('level', 0))),
                    "duration":     activity.get('duration', '01:00'),
                    "timestamp":    format_time(activity.get('timestamp', datetime.utcnow())),
                    # ── ODE model fields ─────────────────────────────────────
                    "intensity":        activity.get('intensity', 'moderate'),
                    "duration_minutes": activity.get('duration_minutes'),
                    "bg_direction":     activity.get('bg_direction', -1),
                }

                for tf in ('startTime', 'endTime', 'expectedTime', 'completedTime'):
                    if tf in activity:
                        formatted_activity[tf] = format_time(activity[tf])

                if 'meal_id' in activity:
                    formatted_activity["meal_id"] = activity['meal_id']
                if 'notes' in activity:
                    formatted_activity["notes"] = activity.get('notes', '')

                formatted_activities.append(formatted_activity)
            except Exception as e:
                logger.error(f"Error formatting patient activity {activity.get('_id', 'unknown')}: {e}")

        return jsonify(formatted_activities), 200

    except Exception as e:
        logger.error(f"Error fetching patient activity history: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@activity_bp.route('/api/activity', methods=['GET'])
@token_required
def get_activity(current_user):
    """
    Get activity data with optional filtering by date range.
    Used by the ActivityVisualization component.
    """
    try:
        start_date_str  = request.args.get('start_date')
        end_date_str    = request.args.get('end_date')
        include_details = request.args.get('include_details') == 'true'
        limit           = int(request.args.get('limit', 1000))

        user_id = str(current_user['_id'])
        logger.info(f"Fetching activity data for user {user_id} from {start_date_str} to {end_date_str}")

        query      = {"user_id": user_id}
        projection = {
            "_id": 1, "type": 1, "level": 1, "impact": 1,
            "duration": 1, "timestamp": 1, "startTime": 1, "endTime": 1,
            # ODE model fields always projected
            "intensity": 1, "duration_minutes": 1, "bg_direction": 1,
        }

        if include_details:
            projection.update({
                "expectedTime": 1, "completedTime": 1,
                "notes": 1, "meal_id": 1,
                "hr_base": 1, "hr_max": 1,
            })

        if start_date_str or end_date_str:
            start_date = None
            end_date   = None

            if start_date_str:
                try:
                    start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
                except Exception as e:
                    logger.error(f"Error parsing start date '{start_date_str}': {e}")
                    return jsonify({"error": f"Invalid start date format: {start_date_str}"}), 400

            if end_date_str:
                try:
                    end_date = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
                except Exception as e:
                    logger.error(f"Error parsing end date '{end_date_str}': {e}")
                    return jsonify({"error": f"Invalid end date format: {end_date_str}"}), 400

            time_conditions = []
            for field in ('timestamp', 'startTime'):
                cond = {}
                if start_date:
                    cond["$gte"] = start_date
                if end_date:
                    cond["$lt"] = end_date
                if cond:
                    time_conditions.append({field: cond})

            if time_conditions:
                query["$or"] = time_conditions

        user_activities = list(
            mongo.db.activities.find(query, projection).sort("timestamp", -1).limit(limit)
        )
        logger.debug(f"Found {len(user_activities)} activities")

        formatted_activities = []
        for activity in user_activities:
            try:
                formatted_activity = {
                    "_id":            str(activity['_id']),
                    "type":           activity.get('type', 'unknown'),
                    "level":          activity.get('level', 0),
                    "impact":         activity.get('impact', 1.0),
                    "duration":       activity.get('duration', '01:00'),
                    # ── ODE model fields ─────────────────────────────────────
                    "intensity":        activity.get('intensity', 'moderate'),
                    "duration_minutes": activity.get('duration_minutes'),
                    "bg_direction":     activity.get('bg_direction', -1),
                }

                for time_field in ("timestamp", "startTime", "endTime", "expectedTime", "completedTime"):
                    if time_field in activity and activity[time_field]:
                        formatted_activity[time_field] = (
                            activity[time_field].isoformat()
                            if isinstance(activity[time_field], datetime)
                            else activity[time_field]
                        )

                if include_details:
                    for opt in ('notes', 'meal_id', 'hr_base', 'hr_max'):
                        if opt in activity:
                            formatted_activity[opt] = activity[opt]

                formatted_activities.append(formatted_activity)
            except Exception as e:
                logger.error(f"Error formatting activity {activity.get('_id', 'unknown')}: {e}")

        return jsonify(formatted_activities), 200

    except Exception as e:
        logger.error(f"Error in get_activity: {str(e)}")
        return jsonify({"error": str(e)}), 500


@activity_bp.route('/api/activities', methods=['GET'])
@token_required
def get_activities(current_user):
    """Get recent activities for the current user with pagination and sorting."""
    try:
        limit      = int(request.args.get('limit', 10))
        skip       = int(request.args.get('skip', 0))
        sort_field = request.args.get('sort', '-timestamp')

        sort_direction = -1
        if sort_field.startswith('-'):
            sort_field = sort_field[1:]
        else:
            sort_direction = 1

        total_activities = mongo.db.activities.count_documents(
            {"user_id": str(current_user['_id'])}
        )

        activities = list(mongo.db.activities.find(
            {"user_id": str(current_user['_id'])}
        ).sort(sort_field, sort_direction).skip(skip).limit(limit))

        formatted_activities = []
        for activity in activities:
            activity['_id'] = str(activity['_id'])

            for key in ('timestamp', 'startTime', 'endTime', 'expectedTime', 'completedTime'):
                if key in activity and isinstance(activity[key], datetime):
                    activity[key] = activity[key].isoformat()

            if 'type' not in activity:
                activity['type'] = 'expected' if activity.get('expectedTime') else 'completed'

            if 'level' in activity:
                for level_info in Constants.ACTIVITY_LEVELS:
                    if level_info['value'] == activity['level']:
                        activity['levelLabel'] = level_info['label']
                        break

            # Ensure ODE model fields are always present with safe defaults
            activity.setdefault('intensity', 'moderate')
            activity.setdefault('bg_direction', -1)

            formatted_activities.append(activity)

        return jsonify(formatted_activities), 200

    except Exception as e:
        logger.error(f"Error getting activities: {str(e)}")
        return jsonify({"error": str(e)}), 500


@activity_bp.route('/api/activity/<activity_id>', methods=['GET'])
@token_required
@api_error_handler
def get_activity_by_id(current_user, activity_id):
    try:
        activity = mongo.db.activities.find_one({'_id': ObjectId(activity_id)})

        if not activity:
            return jsonify({"error": "Activity not found"}), 404

        if activity.get('user_id') != str(current_user['_id']) and current_user.get('user_type') != 'doctor':
            return jsonify({"error": "Unauthorized access"}), 403

        formatted_activity = {
            "id":             str(activity['_id']),
            "type":           activity.get('type', 'unknown'),
            "level":          activity.get('level', 0),
            "impact":         activity.get('impact', 1.0),
            "duration":       activity.get('duration', '01:00'),
            "timestamp":      format_time(activity.get('timestamp', datetime.utcnow())),
            # ── ODE model fields ─────────────────────────────────────────────
            "intensity":        activity.get('intensity', 'moderate'),
            "duration_minutes": activity.get('duration_minutes'),
            "bg_direction":     activity.get('bg_direction', -1),
        }

        for field in ("startTime", "endTime", "expectedTime", "completedTime", "notes"):
            if field in activity:
                formatted_activity[field] = (
                    format_time(activity[field])
                    if isinstance(activity[field], datetime)
                    else activity[field]
                )

        for opt in ('hr_base', 'hr_max'):
            if opt in activity:
                formatted_activity[opt] = activity[opt]

        return jsonify(formatted_activity), 200

    except Exception as e:
        logger.error(f"Error fetching activity by ID: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500
