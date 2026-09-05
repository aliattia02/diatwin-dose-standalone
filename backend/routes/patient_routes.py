from flask import Blueprint, jsonify, request
from datetime import datetime
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo
import logging

logger = logging.getLogger(__name__)

patient_routes = Blueprint('patient_routes', __name__)

# ─── Cache DEFAULT_PATIENT_CONSTANTS at module load time ──────────────────────
# Previously this `from constants import Constants` was inside every route
# handler, causing it to re-evaluate on every request. With 6+ parallel API
# calls on mobile startup that meant 10+ DB-touching constant loads per second.
# Loading once at import time costs nothing and is safe — these defaults never
# change at runtime.
try:
    from constants import Constants as _Constants
    _DEFAULT_CONSTANTS = _Constants.DEFAULT_PATIENT_CONSTANTS
    logger.info("Patient constants defaults loaded at module init")
except Exception as _e:
    logger.error(f"Failed to load default constants at module init: {_e}")
    _DEFAULT_CONSTANTS = {}
# ──────────────────────────────────────────────────────────────────────────────


@patient_routes.route('/api/patient/constants', methods=['GET'])
@token_required
@api_error_handler
def get_constants(current_user):
    try:
        if not current_user or '_id' not in current_user:
            logger.error("No valid user found in token")
            return jsonify({'error': 'Invalid user token'}), 401

        user_id = str(current_user['_id'])
        logger.debug(f"Fetching constants for user: {user_id}")

        try:
            user = mongo.db.users.find_one({"_id": ObjectId(user_id)})
            if not user:
                logger.error(f"User not found: {user_id}")
                return jsonify({'error': 'User not found'}), 404
        except Exception as e:
            logger.error(f"Database error finding user: {str(e)}")
            return jsonify({'error': 'Database error'}), 500

        from constants import get_default_circadian_profile

        try:
            # Get active medication schedules
            active_schedules = list(mongo.db.medication_schedules.find({
                'patient_id': user_id,
                'endDate': {'$gte': datetime.utcnow()}
            }))

            medication_schedules = {}
            for schedule in active_schedules:
                try:
                    medication_schedules[schedule['medication']] = {
                        'id': str(schedule['_id']),
                        'startDate': schedule['startDate'].isoformat(),
                        'endDate': schedule['endDate'].isoformat(),
                        'dailyTimes': schedule['dailyTimes']
                    }
                except Exception as e:
                    logger.error(f"Error formatting schedule: {str(e)}")
                    continue

            # Use module-level cached defaults — no import/DB hit here
            d = _DEFAULT_CONSTANTS

            constants = {
                'patient_id':              user_id,
                'insulin_to_carb_ratio':   user.get('insulin_to_carb_ratio',  d.get('insulin_to_carb_ratio')),
                'correction_factor':       user.get('correction_factor',       d.get('correction_factor')),
                'target_glucose':          user.get('target_glucose',          d.get('target_glucose')),
                'protein_factor':          user.get('protein_factor',          d.get('protein_factor')),
                'fat_factor':              user.get('fat_factor',              d.get('fat_factor')),
                'carb_to_bg_factor':       user.get('carb_to_bg_factor',       d.get('carb_to_bg_factor')),
                'carb_to_bg_ratio':        user.get('carb_to_bg_ratio',
                                                    d.get('carb_to_bg_ratio',
                                                          d.get('carb_to_bg_factor'))),
                'weight_kg':               user.get('weight_kg',               d.get('weight_kg')),
                'hr_base':                 user.get('hr_base',                  d.get('hr_base')),
                'hr_max':                  user.get('hr_max',                   d.get('hr_max')),
                'daily_reset_hour':        user.get('daily_reset_hour',        d.get('daily_reset_hour', 7)),
                'timezone_offset_minutes': user.get('timezone_offset_minutes',
                                                    d.get('timezone_offset_minutes', 0)),
                # ── v4.3: Circadian baseline ─────────────────────────────────
                'baseline_mode':           user.get('baseline_mode',           d.get('baseline_mode', 'dynamic')),
                'circadian_profile': user.get('circadian_profile') or
                                     d.get('circadian_profile') or
                                     get_default_circadian_profile(
                                         user.get('target_glucose', d.get('target_glucose', 100))
                                     ),
                # ────────────────────────────────────────────────────────────
                'activity_coefficients':   user.get('activity_coefficients',   d.get('activity_coefficients')),
                'absorption_modifiers':    user.get('absorption_modifiers',    d.get('absorption_modifiers')),
                'insulin_timing_guidelines': user.get('insulin_timing_guidelines', d.get('insulin_timing_guidelines')),
                'meal_timing_factors':     user.get('meal_timing_factors',
                                                    d.get('meal_timing_factors')),
                'time_of_day_factors':     user.get('time_of_day_factors',
                                                    d.get('time_of_day_factors')),
                'meal_absorption_profiles': user.get('meal_absorption_profiles',
                                                     d.get('meal_absorption_profiles')),
                'disease_factors':         user.get('disease_factors',         d.get('disease_factors')),
                'medication_factors':      user.get('medication_factors',      d.get('medication_factors')),
                'active_conditions':       user.get('active_conditions',       []),
                'active_medications':      user.get('active_medications',      []),
                'medication_schedules':    medication_schedules,
            }

            logger.debug(f"Successfully fetched patient constants for {user_id}")
            return jsonify({'constants': constants}), 200

        except Exception as e:
            logger.error(f"Error processing constants/schedules: {str(e)}")
            return jsonify({'error': 'Error processing constants'}), 500

    except Exception as e:
        logger.error(f"Unexpected error in get_constants: {str(e)}")
        return jsonify({'error': str(e)}), 500


@patient_routes.route('/api/patient/constants', methods=['PUT'])
@token_required
@api_error_handler
def update_constants(current_user):
    """Allow patients to update their own constants including daily_reset_hour"""
    try:
        if not current_user or '_id' not in current_user:
            logger.error("No valid user found in token")
            return jsonify({'error': 'Invalid user token'}), 401

        if current_user.get('user_type') != 'patient':
            return jsonify({'error': 'Only patients can update their own constants'}), 403

        user_id = str(current_user['_id'])

        data = request.get_json()
        if not data or 'constants' not in data:
            return jsonify({'error': 'Missing constants data'}), 400

        constants = data.get('constants')

        updatable_fields = [
            'insulin_to_carb_ratio',
            'correction_factor',
            'target_glucose',
            'protein_factor',
            'fat_factor',
            'carb_to_bg_factor',
            # carb_to_bg_ratio is an alias for carb_to_bg_factor used by the HR
            # ODE activity model. Including it here allows a direct PATCH of only
            # this field without it being silently dropped.
            'carb_to_bg_ratio',
            'daily_reset_hour',
            'timezone_offset_minutes',
            'activity_coefficients',
            'absorption_modifiers',
            'insulin_timing_guidelines',
            # ── v4.3: Circadian baseline mode ────────────────────────────────
            'baseline_mode',
            'circadian_profile',
        ]

        update_data = {f: constants[f] for f in updatable_fields if f in constants}
        if not update_data:
            return jsonify({'error': 'No valid constants provided'}), 400

        # Validate daily_reset_hour
        if 'daily_reset_hour' in update_data:
            h = update_data['daily_reset_hour']
            if not isinstance(h, int) or h < 0 or h > 23:
                return jsonify({
                    'error': 'Invalid daily_reset_hour. Must be an integer between 0 and 23',
                    'details': 'For example, 7 means 7:00 AM.',
                }), 400
            logger.info(f"Patient {user_id} updating daily_reset_hour to {h}")

        # Validate baseline_mode
        if 'baseline_mode' in update_data:
            mode = update_data['baseline_mode']
            if mode not in ('dynamic', 'preset'):
                return jsonify({
                    'error': "Invalid baseline_mode. Must be 'dynamic' or 'preset'",
                }), 400
            logger.info(f"Patient {user_id} switching baseline_mode to '{mode}'")

        # Validate numeric fields
        for field in ['insulin_to_carb_ratio', 'correction_factor', 'target_glucose',
                      'protein_factor', 'fat_factor', 'carb_to_bg_factor', 'carb_to_bg_ratio']:
            if field in update_data:
                if not isinstance(update_data[field], (int, float)) or update_data[field] <= 0:
                    return jsonify({'error': f'Invalid {field}. Must be a positive number'}), 400

        # N-1 FIX: Keep carb_to_bg_factor and carb_to_bg_ratio in sync.
        # constants.py::update_patient_constants() applies this same logic when
        # constants are written via that code path, but this PUT endpoint writes
        # directly via $set and bypasses that function.  Without this block, a
        # PUT of only carb_to_bg_factor leaves carb_to_bg_ratio stale (and vice
        # versa), causing the HR ODE activity model to diverge from the insulin
        # calculator which reads carb_to_bg_factor.
        if 'carb_to_bg_factor' in update_data and 'carb_to_bg_ratio' not in update_data:
            update_data['carb_to_bg_ratio'] = update_data['carb_to_bg_factor']
        elif 'carb_to_bg_ratio' in update_data and 'carb_to_bg_factor' not in update_data:
            update_data['carb_to_bg_factor'] = update_data['carb_to_bg_ratio']

        try:
            result = mongo.db.users.update_one(
                {"_id": ObjectId(user_id)},
                {"$set": update_data}
            )

            if result.matched_count == 0:
                return jsonify({'error': 'User not found'}), 404

            if result.modified_count == 0:
                return jsonify({'message': 'No changes made', 'constants': update_data}), 200

            logger.info(f"Updated constants for user {user_id}: {list(update_data.keys())}")

            # FIX: _patient_config_cache is a non-existent attribute — AttributeError
            # was silently swallowed, leaving _PATIENT_CONSTANTS_CACHE stale for up to
            # 60 s. invalidate_patient_cache() correctly clears the module-level cache.
            try:
                from constants import Constants as _C
                _C.invalidate_patient_cache(user_id)
            except Exception:
                pass

            updated_user = mongo.db.users.find_one({"_id": ObjectId(user_id)})
            d = _DEFAULT_CONSTANTS  # use cached defaults here too
            updated_constants = {
                f: updated_user.get(f, d.get(f))
                for f in updatable_fields
            }

            return jsonify({
                'message': 'Constants updated successfully',
                'constants': updated_constants,
            }), 200

        except Exception as e:
            logger.error(f"Database error updating constants: {str(e)}")
            return jsonify({'error': 'Database error updating constants'}), 500

    except Exception as e:
        logger.error(f"Unexpected error in update_constants: {str(e)}")
        return jsonify({'error': str(e)}), 500


@patient_routes.route('/api/patient/constants', methods=['PATCH'])
@token_required
@api_error_handler
def patch_constants(current_user):
    """
    Lightweight partial update — accepts a flat JSON dict of fields to update.
    Used by App.js on startup to silently save timezone_offset_minutes.
    """
    try:
        if not current_user or '_id' not in current_user:
            return jsonify({'error': 'Invalid user token'}), 401

        user_id = str(current_user['_id'])
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided'}), 400

        patchable_fields = ['timezone_offset_minutes', 'daily_reset_hour', 'baseline_mode']
        update_data = {k: v for k, v in data.items() if k in patchable_fields}

        if not update_data:
            return jsonify({'error': 'No patchable fields provided'}), 400

        if 'timezone_offset_minutes' in update_data:
            tz = update_data['timezone_offset_minutes']
            if not isinstance(tz, (int, float)) or tz < -840 or tz > 840:
                return jsonify({'error': 'timezone_offset_minutes must be between -840 and 840'}), 400
            update_data['timezone_offset_minutes'] = int(tz)

        if 'daily_reset_hour' in update_data:
            h = update_data['daily_reset_hour']
            if not isinstance(h, int) or h < 0 or h > 23:
                return jsonify({'error': 'daily_reset_hour must be 0-23'}), 400

        if 'baseline_mode' in update_data:
            mode = update_data['baseline_mode']
            if mode not in ('dynamic', 'preset'):
                return jsonify({'error': "baseline_mode must be 'dynamic' or 'preset'"}), 400
            logger.info(f"PATCH baseline_mode for user {user_id}: '{mode}'")

        mongo.db.users.update_one({"_id": ObjectId(user_id)}, {"$set": update_data})
        # FIX: same incorrect cache attribute — now uses invalidate_patient_cache()
        # which correctly clears _PATIENT_CONSTANTS_CACHE immediately.
        try:
            from constants import Constants as _C
            _C.invalidate_patient_cache(user_id)
        except Exception:
            pass
        logger.info(f"PATCH constants for user {user_id}: {update_data}")
        return jsonify({'message': 'Updated', 'updated': update_data}), 200

    except Exception as e:
        logger.error(f"Unexpected error in patch_constants: {str(e)}")
        return jsonify({'error': str(e)}), 500

# ─── Patient History Delete Routes ───────────────────────────────────────────
# These routes let a patient permanently delete their own history records.
# Each handler:
#   1. Validates the record ID is a legal ObjectId
#   2. Looks up the record — returns 404 if absent
#   3. Checks ownership — returns 403 if not the requesting patient
#   4. Deletes and returns 200
#
# Collection-name reference (match your actual MongoDB collection names):
#   meals          → meals_only
#   blood sugar    → blood_sugar
#   activities     → activities             (adjust if yours differs)
#   insulin logs   → medication_logs

def _parse_oid(raw_id: str):
    """Return ObjectId or None for invalid strings."""
    try:
        return ObjectId(raw_id)
    except Exception:
        return None


# DELETE /api/meal/<meal_id> deliberately lives in meal_insulin.py.
#
# It used to be defined here as well. Flask kept both — the endpoint names
# differed — and routed to whichever blueprint registered first, which was
# this one. That handler only removed the `meals_only` projection, so the
# authoritative `meals` record survived every delete, still carrying its
# insulin dose into IOB and cumulative effects.
#
# `meal_insulin.delete_meal` now accepts either id and cascades to the
# activities, blood sugar reading, medication log and projection as well as
# the meal itself.


@patient_routes.route('/api/blood-sugar/<reading_id>', methods=['DELETE'])
@token_required
@api_error_handler
def delete_blood_sugar_reading(current_user, reading_id):
    """DELETE /api/blood-sugar/<reading_id> — patient deletes their own reading."""
    oid = _parse_oid(reading_id)
    if not oid:
        return jsonify({'error': 'Invalid reading ID'}), 400

    uid = str(current_user['_id'])
    reading = mongo.db.blood_sugar.find_one({'_id': oid})
    if not reading:
        return jsonify({'error': 'Blood sugar reading not found'}), 404

    owner = str(reading.get('patient_id') or reading.get('user_id') or '')
    if owner != uid:
        logger.warning(f"User {uid} tried to delete reading {reading_id} owned by {owner}")
        return jsonify({'error': 'Not authorized to delete this item'}), 403

    mongo.db.blood_sugar.delete_one({'_id': oid})
    logger.info(f"Blood sugar reading {reading_id} deleted by patient {uid}")
    return jsonify({'message': 'Reading deleted', 'deleted_id': reading_id}), 200


@patient_routes.route('/api/activity/<activity_id>', methods=['DELETE'])
@token_required
@api_error_handler
def delete_activity(current_user, activity_id):
    """DELETE /api/activity/<activity_id> — patient deletes their own activity."""
    oid = _parse_oid(activity_id)
    if not oid:
        return jsonify({'error': 'Invalid activity ID'}), 400

    uid = str(current_user['_id'])
    activity = mongo.db.activities.find_one({'_id': oid})
    if not activity:
        return jsonify({'error': 'Activity not found'}), 404

    owner = str(activity.get('patient_id') or activity.get('user_id') or '')
    if owner != uid:
        logger.warning(f"User {uid} tried to delete activity {activity_id} owned by {owner}")
        return jsonify({'error': 'Not authorized to delete this item'}), 403

    mongo.db.activities.delete_one({'_id': oid})
    logger.info(f"Activity {activity_id} deleted by patient {uid}")
    return jsonify({'message': 'Activity deleted', 'deleted_id': activity_id}), 200


@patient_routes.route('/api/insulin/log/<log_id>', methods=['DELETE'])
@token_required
@api_error_handler
def delete_insulin_log(current_user, log_id):
    """DELETE /api/insulin/log/<log_id> — patient deletes their own insulin dose log."""
    oid = _parse_oid(log_id)
    if not oid:
        return jsonify({'error': 'Invalid log ID'}), 400

    uid = str(current_user['_id'])
    log_entry = mongo.db.medication_logs.find_one({'_id': oid})
    if not log_entry:
        return jsonify({'error': 'Insulin log not found'}), 404

    owner = str(log_entry.get('patient_id') or log_entry.get('user_id') or '')
    if owner != uid:
        logger.warning(f"User {uid} tried to delete insulin log {log_id} owned by {owner}")
        return jsonify({'error': 'Not authorized to delete this item'}), 403

    mongo.db.medication_logs.delete_one({'_id': oid})
    logger.info(f"Insulin log {log_id} deleted by patient {uid}")
    return jsonify({'message': 'Insulin log deleted', 'deleted_id': log_id}), 200


# ─── GDPR Data Export ─────────────────────────────────────────────────────────

def _serialize(doc: dict) -> dict:
    """
    Convert a MongoDB document to a JSON-safe dict.
    - ObjectId  → str
    - datetime  → ISO-8601 str
    - Lists containing dicts are recursed automatically.
    Intentionally shallow: nested dicts inside known list fields
    (e.g. hr_trace, foodItems) are handled by the list walk.
    """
    out = {}
    for k, v in doc.items():
        if hasattr(v, 'binary'):          # ObjectId / Decimal128 / etc.
            out[k] = str(v)
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, list):
            out[k] = [
                _serialize(i) if isinstance(i, dict) else
                str(i) if hasattr(i, 'binary') else i
                for i in v
            ]
        elif isinstance(v, dict):
            out[k] = _serialize(v)
        else:
            out[k] = v
    return out


@patient_routes.route('/api/patient/export', methods=['GET'])
@token_required
@api_error_handler
def export_patient_data(current_user):
    """
    GDPR Article 20 — Data Portability.

    Returns a single JSON object containing every piece of data stored for
    the authenticated patient, across all collections.  No data is omitted —
    hr_trace, hr_trace_raw, nutrition macros, CGM readings, watch sessions,
    medication schedules, and personal constants are all included.

    Response shape:
    {
      "export_date":    "<ISO-8601>",
      "schema_version": "2.0",
      "account": { … },          ← profile fields, no password hash
      "constants": { … },        ← insulin ratios, targets, circadian profile
      "blood_sugar": [ … ],
      "meals": [ … ],
      "activities": [ … ],       ← includes intensity, duration_minutes, hr_trace
      "insulin_logs": [ … ],
      "medication_schedules": [ … ],
      "cgm_readings": [ … ],     ← LibreLinkUp CGM data
      "watch_sessions": [ … ],   ← Google Fit synced sessions
      "summary": { counts }
    }
    """
    try:
        uid = str(current_user['_id'])
        now_iso = datetime.utcnow().isoformat()

        # ── Account profile (no password hash, no tokens) ─────────────────
        user_doc = mongo.db.users.find_one({'_id': current_user['_id']}) or {}
        _SENSITIVE = {'password', 'password_hash', 'hashed_password',
                      'token', 'refresh_token', 'google_access_token',
                      'google_refresh_token'}
        account = {
            k: (v.isoformat() if isinstance(v, datetime) else str(v) if hasattr(v, 'binary') else v)
            for k, v in user_doc.items()
            if k not in _SENSITIVE
        }

        # ── Personal constants (already surfaced via /api/patient/constants,
        #    duplicated here so the export is self-contained) ───────────────
        constants = {
            'insulin_to_carb_ratio':     user_doc.get('insulin_to_carb_ratio'),
            'correction_factor':         user_doc.get('correction_factor'),
            'target_glucose':            user_doc.get('target_glucose'),
            'protein_factor':            user_doc.get('protein_factor'),
            'fat_factor':                user_doc.get('fat_factor'),
            'carb_to_bg_factor':         user_doc.get('carb_to_bg_factor'),
            'daily_reset_hour':          user_doc.get('daily_reset_hour'),
            'timezone_offset_minutes':   user_doc.get('timezone_offset_minutes'),
            'baseline_mode':             user_doc.get('baseline_mode'),
            'circadian_profile':         user_doc.get('circadian_profile'),
            'activity_coefficients':     user_doc.get('activity_coefficients'),
            'absorption_modifiers':      user_doc.get('absorption_modifiers'),
            'active_conditions':         user_doc.get('active_conditions', []),
            'active_medications':        user_doc.get('active_medications', []),
        }

        # ── Blood glucose ─────────────────────────────────────────────────
        blood_sugar = [
            _serialize(r)
            for r in mongo.db.blood_sugar.find({'user_id': uid}).sort('timestamp', -1)
        ]

        # ── Meals (with full nutrition + food items) ───────────────────────
        meals = [
            _serialize(r)
            for r in mongo.db.meals.find({'user_id': uid}).sort('timestamp', -1)
        ]

        # ── Activities — all fields including ODE model and HR trace ──────
        # hr_trace_raw (per-second) is included for full GDPR portability.
        # Consumers that only need the per-minute averages should use hr_trace.
        activities = [
            _serialize(r)
            for r in mongo.db.activities.find({'user_id': uid}).sort('timestamp', -1)
        ]

        # ── Insulin logs ──────────────────────────────────────────────────
        insulin_logs = [
            _serialize(r)
            for r in mongo.db.medication_logs.find(
                {'patient_id': uid, 'is_insulin': True}
            ).sort('taken_at', -1)
        ]

        # ── Medication schedules ──────────────────────────────────────────
        medication_schedules = [
            _serialize(r)
            for r in mongo.db.medication_schedules.find(
                {'patient_id': uid}
            ).sort('startDate', -1)
        ]

        # ── LibreLinkUp CGM readings ──────────────────────────────────────
        cgm_readings = [
            _serialize(r)
            for r in mongo.db.cgm_readings.find({'user_id': uid}).sort('timestamp', -1)
        ]

        # ── Google Fit watch sessions (separate collection if present) ────
        watch_sessions = [
            _serialize(r)
            for r in mongo.db.watch_activity_sessions.find(
                {'user_id': uid}
            ).sort('start_time', -1)
        ]

        summary = {
            'blood_sugar_readings':   len(blood_sugar),
            'meal_records':           len(meals),
            'activity_sessions':      len(activities),
            'insulin_logs':           len(insulin_logs),
            'medication_schedules':   len(medication_schedules),
            'cgm_readings':           len(cgm_readings),
            'watch_sessions':         len(watch_sessions),
        }

        logger.info(f"GDPR export: user={uid} {summary}")

        return jsonify({
            'export_date':    now_iso,
            'schema_version': '2.0',
            'account':        account,
            'constants':      constants,
            'blood_sugar':    blood_sugar,
            'meals':          meals,
            'activities':     activities,
            'insulin_logs':   insulin_logs,
            'medication_schedules': medication_schedules,
            'cgm_readings':   cgm_readings,
            'watch_sessions': watch_sessions,
            'summary':        summary,
        }), 200

    except Exception as e:
        logger.error(f"Patient export error: {e}")
        return jsonify({'error': 'Export failed', 'details': str(e)}), 500