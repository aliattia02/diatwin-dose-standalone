from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo
from constants import Constants, ConstantConfig
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)
doctor_routes = Blueprint('doctor_routes', __name__)


def check_doctor_patient_access(current_user, patient_id):
    """
    Check if the current user has access to the patient's data.
    Returns (has_access, error_response, status_code)
    """
    user_type = current_user.get('user_type')

    # Admins have access to all patients
    if user_type == 'admin':
        return True, None, None

    # Must be a doctor
    if user_type != 'doctor':
        return False, {'message': 'Unauthorized access'}, 403

    # Check if doctor is authorized by this patient
    doctor_id = str(current_user['_id'])
    patient = mongo.db.users.find_one({"_id": ObjectId(patient_id)})

    if not patient:
        return False, {'message': 'Patient not found'}, 404

    authorized_doctors = patient.get('authorized_doctors', [])

    if doctor_id not in authorized_doctors:
        return False, {'message': 'You are not authorized to view this patient\'s data'}, 403

    return True, None, None


@doctor_routes.route('/api/doctor/patients', methods=['GET'])
@token_required
@api_error_handler
def get_doctor_patients(current_user):
    """
    Get list of patients.
    - Admins see all patients
    - Doctors only see patients who have authorized them
    """
    user_type = current_user.get('user_type')
    logger.debug(f"Attempting to fetch patients for user: {current_user.get('_id')} (type: {user_type})")

    # Check user type
    if user_type not in ['doctor', 'admin']:
        logger.warning(f"Unauthorized access attempt by user: {current_user.get('_id')}")
        return jsonify({'message': 'Unauthorized access'}), 403

    doctor_id = str(current_user['_id'])

    # Build query based on user type
    if user_type == 'admin':
        query = {"user_type": "patient"}
    else:
        query = {
            "user_type": "patient",
            "authorized_doctors": doctor_id
        }

    patients = list(mongo.db.users.find(query, {"password": 0}))

    patient_list = []
    for patient in patients:
        try:
            patient_data = {
                'id': str(patient['_id']),
                'firstName': patient.get('first_name', ''),
                'lastName': patient.get('last_name', ''),
                'email': patient.get('email', ''),
                'activeConditions': patient.get('active_conditions', []),
                'activeMedications': patient.get('active_medications', [])
            }
            patient_list.append(patient_data)
        except Exception as e:
            logger.error(f"Error processing patient data: {str(e)}")
            continue

    return jsonify(patient_list), 200


@doctor_routes.route('/api/doctor/patient/<patient_id>/constants', methods=['GET'])
@token_required
@api_error_handler
def get_patient_constants(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        patient = mongo.db.users.find_one({"_id": ObjectId(patient_id)})
        if not patient:
            return jsonify({'message': 'Patient not found'}), 404

        default_constants = Constants.DEFAULT_PATIENT_CONSTANTS

        medication_factors = {
            **default_constants['medication_factors'],
            **(patient.get('medication_factors', {}))
        }

        constants = {
            'insulin_to_carb_ratio': patient.get('insulin_to_carb_ratio', default_constants['insulin_to_carb_ratio']),
            'correction_factor': patient.get('correction_factor', default_constants['correction_factor']),
            'target_glucose': patient.get('target_glucose', default_constants['target_glucose']),
            'protein_factor': patient.get('protein_factor', default_constants['protein_factor']),
            'fat_factor': patient.get('fat_factor', default_constants['fat_factor']),
            'carb_to_bg_factor': patient.get('carb_to_bg_factor', default_constants['carb_to_bg_factor']),
            'daily_reset_hour': patient.get('daily_reset_hour', default_constants.get('daily_reset_hour', 7)),
            'activity_coefficients': patient.get('activity_coefficients', default_constants['activity_coefficients']),
            'absorption_modifiers': patient.get('absorption_modifiers', default_constants['absorption_modifiers']),
            'insulin_timing_guidelines': patient.get('insulin_timing_guidelines',
                                                     default_constants['insulin_timing_guidelines']),
            'disease_factors': patient.get('disease_factors', default_constants['disease_factors']),
            'medication_factors': medication_factors,
            'active_conditions': patient.get('active_conditions', []),
            'active_medications': patient.get('active_medications', [])
        }

        return jsonify({'constants': constants}), 200
    except Exception as e:
        logger.error(f"Error fetching patient constants: {str(e)}")
        return jsonify({'message': 'Error fetching patient constants'}), 500


@doctor_routes.route('/api/doctor/patient/<patient_id>/constants/reset', methods=['POST'])
@token_required
@api_error_handler
def reset_patient_constants(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        default_config = ConstantConfig()
        default_constants = {
            'insulin_to_carb_ratio': default_config.insulin_to_carb_ratio,
            'correction_factor': default_config.correction_factor,
            'target_glucose': default_config.target_glucose,
            'protein_factor': default_config.protein_factor,
            'fat_factor': default_config.fat_factor,
            'carb_to_bg_factor': default_config.carb_to_bg_factor,
            'daily_reset_hour': default_config.daily_reset_hour,
            'activity_coefficients': default_config.activity_coefficients,
            'absorption_modifiers': default_config.absorption_modifiers,
            'insulin_timing_guidelines': default_config.insulin_timing_guidelines,
            'disease_factors': default_config.disease_factors,
            'medication_factors': default_config.medication_factors,
            'active_conditions': [],
            'active_medications': []
        }

        result = mongo.db.users.update_one(
            {"_id": ObjectId(patient_id)},
            {"$set": default_constants}
        )

        if result.matched_count == 0:
            return jsonify({'message': 'Patient not found'}), 404

        # FIX: Invalidate cache so calculation engine reads fresh default values
        # immediately rather than waiting up to 60 s for the TTL to expire.
        try:
            from constants import Constants as _C
            _C.invalidate_patient_cache(patient_id)
        except Exception:
            pass

        return jsonify({
            'message': 'Constants reset to defaults successfully',
            'constants': default_constants
        }), 200
    except Exception as e:
        logger.error(f"Error resetting patient constants: {str(e)}")
        return jsonify({'message': 'Error resetting patient constants'}), 500


@doctor_routes.route('/api/doctor/patient/<patient_id>/constants', methods=['PUT'])
@token_required
@api_error_handler
def update_patient_constants(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        data = request.json
        constants = data.get('constants', {})

        required_fields = [
            'insulin_to_carb_ratio', 'correction_factor', 'target_glucose',
            'protein_factor', 'fat_factor', 'carb_to_bg_factor',
            'daily_reset_hour', 'activity_coefficients', 'absorption_modifiers',
            'insulin_timing_guidelines', 'disease_factors', 'medication_factors',
            'active_conditions', 'active_medications'
        ]

        update_data = {}
        numeric_fields = ['insulin_to_carb_ratio', 'correction_factor', 'target_glucose',
                          'protein_factor', 'fat_factor', 'carb_to_bg_factor']

        for field in numeric_fields:
            if field in constants:
                value = constants[field]
                if not isinstance(value, (int, float)) or value <= 0:
                    return jsonify({'message': f'Invalid {field}. Must be a positive number'}), 400
                update_data[field] = value

        for field in ['activity_coefficients', 'absorption_modifiers',
                      'insulin_timing_guidelines', 'disease_factors', 'medication_factors',
                      'active_conditions', 'active_medications']:
            if field in constants:
                update_data[field] = constants[field]

        if not update_data:
            return jsonify({'message': 'No valid constants provided'}), 400

        # Validate daily_reset_hour if provided
        if 'daily_reset_hour' in constants:
            daily_reset_hour = constants['daily_reset_hour']
            if not isinstance(daily_reset_hour, int) or daily_reset_hour < 0 or daily_reset_hour > 23:
                return jsonify({
                    'message': 'Invalid daily_reset_hour. Must be an integer between 0 and 23'
                }), 400
            update_data['daily_reset_hour'] = daily_reset_hour

        # Validate disease factors
        if 'disease_factors' in update_data:
            default_diseases = Constants.DEFAULT_PATIENT_CONSTANTS['disease_factors']
            for disease in update_data['disease_factors']:
                if disease not in default_diseases:
                    return jsonify({
                        'message': f'Invalid disease type: {disease}',
                        'valid_diseases': list(default_diseases.keys())
                    }), 400

        # Validate medication factors
        if 'medication_factors' in update_data:
            default_medications = Constants.DEFAULT_PATIENT_CONSTANTS['medication_factors']
            for medication in update_data['medication_factors']:
                if medication not in default_medications:
                    return jsonify({
                        'message': f'Invalid medication type: {medication}',
                        'valid_medications': list(default_medications.keys())
                    }), 400

        result = mongo.db.users.update_one(
            {"_id": ObjectId(patient_id)},
            {"$set": update_data}
        )

        if result.matched_count == 0:
            return jsonify({'message': 'Patient not found'}), 404

        # FIX: Doctor routes never cleared the process-level constants cache.
        # Without this the calculation engine serves stale values for up to 60 s
        # after a doctor edits a patient's constants.
        try:
            from constants import Constants as _C
            _C.invalidate_patient_cache(patient_id)
        except Exception:
            pass

        updated_user = mongo.db.users.find_one({"_id": ObjectId(patient_id)})
        updated_constants = {field: updated_user.get(field) for field in required_fields}

        return jsonify({
            'message': 'Constants updated successfully',
            'constants': updated_constants
        }), 200
    except Exception as e:
        logger.error(f"Error updating patient constants: {str(e)}")
        return jsonify({'message': 'Error updating patient constants'}), 500


@doctor_routes.route('/api/doctor/patient/<patient_id>/conditions', methods=['PUT'])
@token_required
@api_error_handler
def update_patient_conditions(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        data = request.json
        conditions = data.get('conditions', [])

        valid_conditions = Constants.DEFAULT_PATIENT_CONSTANTS['disease_factors'].keys()
        invalid_conditions = [c for c in conditions if c not in valid_conditions]

        if invalid_conditions:
            return jsonify({
                'message': f'Invalid conditions: {invalid_conditions}',
                'valid_conditions': list(valid_conditions)
            }), 400

        result = mongo.db.users.update_one(
            {"_id": ObjectId(patient_id)},
            {"$set": {"active_conditions": conditions}}
        )

        if result.matched_count == 0:
            return jsonify({'message': 'Patient not found'}), 404

        return jsonify({
            'message': 'Patient conditions updated successfully',
            'active_conditions': conditions
        }), 200
    except Exception as e:
        logger.error(f"Error updating patient conditions: {str(e)}")
        return jsonify({'message': 'Error updating patient conditions'}), 500


@doctor_routes.route('/api/doctor/patient/<patient_id>/medications', methods=['PUT'])
@token_required
@api_error_handler
def update_patient_medications(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        data = request.json
        medications = data.get('medications', [])

        valid_medications = Constants.DEFAULT_PATIENT_CONSTANTS['medication_factors'].keys()
        invalid_medications = [m for m in medications if m not in valid_medications]

        if invalid_medications:
            return jsonify({
                'message': f'Invalid medications: {invalid_medications}',
                'valid_medications': list(valid_medications)
            }), 400

        result = mongo.db.users.update_one(
            {"_id": ObjectId(patient_id)},
            {"$set": {"active_medications": medications}}
        )

        if result.matched_count == 0:
            return jsonify({'message': 'Patient not found'}), 404

        return jsonify({
            'message': 'Patient medications updated successfully',
            'active_medications': medications
        }), 200
    except Exception as e:
        logger.error(f"Error updating patient medications: {str(e)}")
        return jsonify({'message': 'Error updating patient medications'}), 500


@doctor_routes.route('/api/doctor/patient/<patient_id>/medication-log', methods=['POST'])
@token_required
@api_error_handler
def log_medication(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        data = request.json
        medication_log = {
            'patient_id': patient_id,
            'medication': data.get('medication'),
            'taken_at': datetime.fromisoformat(data.get('taken_at')),
            'next_dose': datetime.fromisoformat(data.get('next_dose')),
            'created_by': str(current_user['_id']),
            'created_at': datetime.utcnow()
        }

        result = mongo.db.medication_logs.insert_one(medication_log)

        return jsonify({
            'message': 'Medication log created successfully',
            'id': str(result.inserted_id)
        }), 201
    except Exception as e:
        logger.error(f"Error logging medication: {str(e)}")
        return jsonify({'message': 'Error logging medication'}), 500


@doctor_routes.route('/api/doctor/patient/<patient_id>/medication-log', methods=['GET'])
@token_required
@api_error_handler
def get_medication_logs(current_user, patient_id):
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        logs = list(mongo.db.medication_logs.find(
            {'patient_id': patient_id}
        ).sort('taken_at', -1))

        return jsonify({
            'logs': [{
                'id': str(log['_id']),
                'medication': log['medication'],
                'taken_at': log['taken_at'].isoformat(),
                'next_dose': log['next_dose'].isoformat()
            } for log in logs]
        }), 200
    except Exception as e:
        logger.error(f"Error fetching medication logs: {str(e)}")
        return jsonify({'message': 'Error fetching medication logs'}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Blood sugar history for doctor view
# GET /api/doctor/patient/<patient_id>/blood-sugar
# ─────────────────────────────────────────────────────────────────────────────

@doctor_routes.route('/api/doctor/patient/<patient_id>/blood-sugar', methods=['GET'])
@token_required
@api_error_handler
def get_patient_blood_sugar(current_user, patient_id):
    """
    Fetch blood sugar reading history for an authorized patient.

    Query params:
      limit       (int, default 100)  — max readings to return
      start_date  (YYYY-MM-DD)        — inclusive lower bound
      end_date    (YYYY-MM-DD)        — inclusive upper bound

    Returns a JSON array of blood sugar readings matching the
    BloodSugarResponse type expected by the mobile frontend.

    Data lives in: mongo.db.blood_sugar  with field user_id == patient_id
    """
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        start_date_str = request.args.get('start_date')
        end_date_str   = request.args.get('end_date')
        start_time_str = request.args.get('start_time')         # ISO datetime — preferred over start_date
        end_time_str   = request.args.get('end_time')           # ISO datetime — preferred over end_date

        query = {'user_id': patient_id}

        # FIX: Accept start_time / end_time (ISO, sent by the mobile frontend) in
        # addition to the legacy start_date / end_date (YYYY-MM-DD) params.
        # Previously only start_date/end_date were read; start_time was silently
        # ignored, so the query ran with NO date filter and returned only the 100
        # most-recent readings — causing week/month chart views to appear empty.
        if start_date_str or end_date_str or start_time_str or end_time_str:
            start_datetime = None
            end_datetime   = None

            # Prefer ISO datetime over date-only string
            if start_time_str:
                try:
                    start_datetime = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
                except ValueError:
                    return jsonify({'message': f'Invalid start_time format: {start_time_str}'}), 400
            elif start_date_str:
                try:
                    start_datetime = datetime.strptime(start_date_str, '%Y-%m-%d')
                except ValueError:
                    return jsonify({'message': f'Invalid start_date format: {start_date_str}'}), 400

            if end_time_str:
                try:
                    end_datetime = datetime.fromisoformat(end_time_str.replace('Z', '+00:00'))
                except ValueError:
                    return jsonify({'message': f'Invalid end_time format: {end_time_str}'}), 400
            elif end_date_str:
                try:
                    end_datetime = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
                except ValueError:
                    return jsonify({'message': f'Invalid end_date format: {end_date_str}'}), 400

            time_filter = {}
            if start_datetime:
                time_filter['$gte'] = start_datetime
            if end_datetime:
                time_filter['$lt'] = end_datetime
            if time_filter:
                query['timestamp'] = time_filter

        # No .limit() — the date filter already bounds the result set.
        # Mirrors the patient-facing route in blood_sugar.py which returns
        # all readings in the requested window without a cap.
        raw_readings = list(mongo.db.blood_sugar.find(query).sort('timestamp', -1))

        # Serialise to the BloodSugarResponse shape the frontend expects.
        # All ObjectId / datetime fields must be converted to plain strings.
        formatted = []
        for r in raw_readings:
            entry = {
                '_id':    str(r['_id']),
                'bloodSugar': r.get('bloodSugar'),
                'status': r.get('status', 'unknown'),
                'target': r.get('target', 100),
                'notes':  r.get('notes', ''),
                'timestamp': (
                    r['timestamp'].isoformat() + 'Z'
                    if isinstance(r.get('timestamp'), datetime)
                    else str(r.get('timestamp', ''))
                ),
            }

            # Include the more-precise bloodSugarTimestamp when available
            bst = r.get('bloodSugarTimestamp')
            if bst:
                entry['bloodSugarTimestamp'] = (
                    bst.isoformat() + 'Z' if isinstance(bst, datetime) else str(bst)
                )
            else:
                entry['bloodSugarTimestamp'] = entry['timestamp']

            formatted.append(entry)

        logger.debug(
            f"Doctor {current_user.get('_id')} retrieved {len(formatted)} "
            f"blood sugar readings for patient {patient_id}"
        )
        return jsonify(formatted), 200

    except Exception as e:
        logger.error(f"Error fetching patient blood sugar: {str(e)}")
        return jsonify({'message': 'Error fetching blood sugar data'}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Activity history for doctor view
# GET /api/doctor/patient/<patient_id>/activity-history
# ─────────────────────────────────────────────────────────────────────────────

@doctor_routes.route('/api/doctor/patient/<patient_id>/activity-history', methods=['GET'])
@token_required
@api_error_handler
def get_patient_activity_history(current_user, patient_id):
    """
    Fetch activity history for an authorized patient.

    Query params:
      limit  (int, default 50)  — max records to return
      skip   (int, default 0)   — pagination offset

    Returns a JSON array of activity records matching the
    ActivityResponse type expected by the mobile frontend.

    Data lives in: mongo.db.activities  with field user_id == patient_id
    The route name matches ACTIVITIES.PATIENT_HISTORY in endpoints.ts:
      /api/doctor/patient/<patient_id>/activity-history
    """
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        limit = int(request.args.get('limit', 50))
        skip  = int(request.args.get('skip', 0))

        # Activities are stored with user_id == patient_id (string)
        query = {'user_id': patient_id}

        raw_activities = list(
            mongo.db.activities.find(query)
            .sort('timestamp', -1)
            .skip(skip)
            .limit(limit)
        )

        formatted = []
        for a in raw_activities:
            entry = {
                'id':            str(a['_id']),
                'activityType':  a.get('activityType') or a.get('activity_type', 'unknown'),
                'activityLevel': a.get('activityLevel') or a.get('activity_level', ''),
                'duration':      a.get('duration', 0),
                'notes':         a.get('notes', ''),
                'timestamp': (
                    a['timestamp'].isoformat() + 'Z'
                    if isinstance(a.get('timestamp'), datetime)
                    else str(a.get('timestamp', ''))
                ),
            }

            # Include optional metabolic-impact fields if present
            for opt in ('caloriesBurned', 'calories_burned', 'intensityLevel',
                        'heartRate', 'heart_rate'):
                if a.get(opt) is not None:
                    entry[opt] = a[opt]

            formatted.append(entry)

        logger.debug(
            f"Doctor {current_user.get('_id')} retrieved {len(formatted)} "
            f"activities for patient {patient_id}"
        )
        return jsonify(formatted), 200

    except Exception as e:
        logger.error(f"Error fetching patient activity history: {str(e)}")
        return jsonify({'message': 'Error fetching activity history'}), 500


# ─────────────────────────────────────────────────────────────────────────────
# NEW: Insulin dose history for doctor view
# ─────────────────────────────────────────────────────────────────────────────

@doctor_routes.route('/api/doctor/patient/<patient_id>/insulin', methods=['GET'])
@token_required
@api_error_handler
def get_patient_insulin_doses(current_user, patient_id):
    """
    Fetch insulin dose history for an authorized patient.

    Query params:
      limit       (int, default 100) — max doses to return
      start_date  (ISO string)       — inclusive lower bound on dose timestamp
      end_date    (ISO string)       — inclusive upper bound on dose timestamp

    Returns:
      { "doses": [ { id, insulinType, units, timestamp, notes, iobContribution? }, ... ] }

    Searches the following collections in order of priority:
      1. insulin_doses   — dedicated insulin-dose collection (preferred)
      2. medication_logs — fallback in case insulin is stored there
    """
    has_access, error_response, status_code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(error_response), status_code

    try:
        limit = int(request.args.get('limit', 100))
        start_date_str = request.args.get('start_date')
        end_date_str   = request.args.get('end_date')

        # ── Build date filter ──────────────────────────────────────────────
        date_filter = {}
        if start_date_str:
            try:
                date_filter['$gte'] = datetime.fromisoformat(start_date_str.replace('Z', '+00:00'))
            except ValueError:
                return jsonify({'message': f'Invalid start_date format: {start_date_str}'}), 400
        if end_date_str:
            try:
                date_filter['$lte'] = datetime.fromisoformat(end_date_str.replace('Z', '+00:00'))
            except ValueError:
                return jsonify({'message': f'Invalid end_date format: {end_date_str}'}), 400

        # ── Query medication_logs — the ONLY collection insulin is written to ──
        # All insulin doses land here with is_insulin=True, written by both:
        #   POST /api/insulin/log          (medication_routes.py ~line 818)
        #   POST /api/medication-log/<id>  (medication_routes.py ~line 477)
        # The insulin_doses collection is never populated anywhere in the codebase.
        # The timestamp field used here is `taken_at` (not `timestamp`).
        query: dict = {
            'patient_id': patient_id,
            'is_insulin': True,
        }
        if date_filter:
            query['taken_at'] = date_filter

        raw_doses = list(
            mongo.db.medication_logs.find(query)
            .sort('taken_at', -1)
            .limit(limit)
        )

        # ── Normalise each dose record ─────────────────────────────────────
        def _ts(doc):
            """Extract taken_at (primary) or created_at as ISO string."""
            for field in ('taken_at', 'created_at'):
                val = doc.get(field)
                if val:
                    return val.isoformat() if isinstance(val, datetime) else str(val)
            return None

        def _normalise(doc):
            """Map DB document → frontend InsulinDoseResponse shape."""
            return {
                'id':          str(doc['_id']),
                # medication_routes stores the insulin type in the `medication` field
                'insulinType': doc.get('medication') or doc.get('insulin_type') or doc.get('insulinType') or 'unknown',
                'units':       doc.get('dose', doc.get('units', 0)),
                'timestamp':   _ts(doc),
                'doseTime':    _ts(doc),   # alias expected by some frontend paths
                'notes':       doc.get('notes'),
                'iobContribution': doc.get('iob_contribution') or doc.get('iobContribution'),
            }

        doses = [_normalise(d) for d in raw_doses]

        logger.debug(f"Doctor {current_user.get('_id')} retrieved {len(doses)} insulin doses for patient {patient_id}")
        return jsonify({'doses': doses}), 200

    except Exception as e:
        logger.error(f"Error fetching patient insulin doses: {str(e)}")
        return jsonify({'message': 'Error fetching insulin doses'}), 500