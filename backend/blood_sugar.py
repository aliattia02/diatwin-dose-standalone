from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from datetime import datetime, timedelta
from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from constants import Constants
from utils.pharmacodynamics import calculate_meal_active_carbs  # ✅ NEW IMPORT LOCATION
from routes.medication_routes import calculate_stacked_insulin_effect
import logging
import traceback

from werkzeug.exceptions import HTTPException

logger = logging.getLogger(__name__)
blood_sugar_bp = Blueprint('blood_sugar', __name__)


def validate_blood_sugar_mgdl(value):
    """Validate blood sugar value in mg/dL"""
    if not isinstance(value, (int, float)):
        return False, "Invalid blood sugar value"
    if value < 0:
        return False, "Blood sugar cannot be negative"
    if value > 600:
        return False, "Blood sugar value seems too high"
    return True, None


def get_blood_sugar_status(blood_sugar, target_glucose):
    """Determine blood sugar status based on target glucose"""
    if blood_sugar < target_glucose * 0.7:
        return "low"
    elif blood_sugar > target_glucose * 1.3:
        return "high"
    return "normal"


@blood_sugar_bp.route('/api/blood-sugar', methods=['POST'])
@token_required
@api_error_handler
def add_blood_sugar(current_user):
    try:
        logger.info("=" * 80)
        logger.info("🩸 BLOOD SUGAR POST ENDPOINT CALLED")
        logger.info(f"📍 Route: /api/blood-sugar")
        logger.info(f"👤 User ID: {current_user.get('_id')}")
        # get_json(silent=True) rather than `request.json`: a malformed body
        # must not raise from inside a *log* statement.
        logger.info(f"📦 Request JSON: {request.get_json(silent=True)}")
        logger.info(f"🌐 Request Origin: {request.headers.get('Origin', 'Unknown')}")
        logger.info(f"🔑 Authorization: {request.headers.get('Authorization', 'None')[:50]}...")
        logger.info("=" * 80)

        user_constants = Constants(str(current_user['_id']))

        blood_sugar = request.json.get('bloodSugar')
        blood_sugar_timestamp = request.json.get('bloodSugarTimestamp')
        notes = request.json.get('notes', '')
        source = request.json.get('bloodSugarSource', 'standalone')

        logger.info(f"📊 Blood Sugar Value: {blood_sugar} mg/dL")
        logger.info(f"⏰ Timestamp: {blood_sugar_timestamp}")
        logger.info(f"📝 Notes: {notes}")
        logger.info(f"🔖 Source: {source}")

        if blood_sugar is None:
            logger.error("❌ Blood sugar value is missing!")
            return jsonify({'error': 'Blood sugar value is required'}), 400

        is_valid, error_message = validate_blood_sugar_mgdl(blood_sugar)
        if not is_valid:
            logger.error(f"❌ Validation failed: {error_message}")
            return jsonify({'error': error_message}), 400

        target_glucose = user_constants.get_constant('target_glucose')
        status = get_blood_sugar_status(blood_sugar, target_glucose)

        logger.info(f"🎯 Target Glucose: {target_glucose}")
        logger.info(f"📈 Status: {status}")

        current_time = datetime.utcnow()

        if not blood_sugar_timestamp:
            blood_sugar_timestamp = current_time.isoformat()

        try:
            if blood_sugar_timestamp.endswith('Z'):
                blood_sugar_timestamp = blood_sugar_timestamp[:-1] + '+00:00'
            elif not ('+' in blood_sugar_timestamp or '-' in blood_sugar_timestamp[-6:]):
                blood_sugar_timestamp = blood_sugar_timestamp + '+00:00'

            parsed_timestamp = datetime.fromisoformat(blood_sugar_timestamp)
            logger.info(f"✅ Parsed timestamp: {parsed_timestamp}")
        except Exception as e:
            logger.error(f"❌ Error parsing blood sugar timestamp: {e}")
            parsed_timestamp = current_time

        calc_timestamp = parsed_timestamp.replace(tzinfo=None) if hasattr(parsed_timestamp, 'tzinfo') and parsed_timestamp.tzinfo else parsed_timestamp

        patient_constants = user_constants.get_patient_constants()
        carb_to_bg_factor = patient_constants.get('carb_to_bg_factor', 4.0)
        correction_factor = patient_constants.get('correction_factor', 40)  # canonical default from constants.py::ConstantConfig
        absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES  # ✅ GET PROFILES

        # Calculate meal impact (absorbed carbs effect on current BG)
        try:
            cutoff_time = calc_timestamp - timedelta(hours=12)
            recent_meals = list(mongo.db.meals.find({
                'user_id': str(current_user['_id']),
                'timestamp': {'$gte': cutoff_time, '$lte': calc_timestamp},
                'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
            }))

            total_absorbed_carbs = 0
            for meal in recent_meals:
                # ✅ FIXED: Pass absorption_profiles as 4th argument
                carb_data = calculate_meal_active_carbs(
                    meal, calc_timestamp, patient_constants, absorption_profiles
                )
                total_absorbed_carbs += carb_data.get('absorbed_carbs', 0)

            meal_impact = total_absorbed_carbs * carb_to_bg_factor
        except Exception as e:
            logger.warning(f"Error calculating meal impact for baseline: {e}")
            meal_impact = 0

        # Calculate insulin impact (absorbed insulin effect on current BG)
        try:
            iob_data = calculate_stacked_insulin_effect(
                patient_id=str(current_user['_id']),
                target_time=calc_timestamp
            )
            insulin_impact = iob_data.get('current_bg_reduction', 0)
        except Exception as e:
            logger.warning(f"Error calculating insulin impact for baseline: {e}")
            insulin_impact = 0

        net_effect = meal_impact - insulin_impact
        baseline = blood_sugar - net_effect

        logger.info(f"Baseline calculation: BG={blood_sugar}, meal_impact={meal_impact:.1f}, insulin_impact={insulin_impact:.1f}, baseline={baseline:.0f}")

        new_reading = {
            'user_id': str(current_user['_id']),
            'bloodSugar': blood_sugar,
            'status': status,
            'target': target_glucose,
            'timestamp': current_time,
            'bloodSugarTimestamp': parsed_timestamp,
            'notes': notes,
            'source': source,
            'baseline_calculation': {
                'baseline': round(baseline),
                'net_effect': round(net_effect, 1),
                'meal_impact': round(meal_impact, 1),
                'insulin_impact': round(insulin_impact, 1),
                'confidence': 'high',
                'calculation_time': calc_timestamp.isoformat()
            }
        }

        logger.info("=" * 80)
        logger.info("💾 INSERTING INTO blood_sugar DATABASE...")
        logger.info(f"📄 Document: {new_reading}")

        bs_result = mongo.db.blood_sugar.insert_one(new_reading)
        blood_sugar_id = str(bs_result.inserted_id)

        logger.info(f"✅ SUCCESS! Blood sugar record created with ID: {blood_sugar_id}")

        verify_bs = mongo.db.blood_sugar.find_one({"_id": bs_result.inserted_id})
        if verify_bs:
            logger.info(f"✅ VERIFIED: Record exists in blood_sugar database")
        else:
            logger.error(f"❌ ERROR: Record NOT found in blood_sugar database!")

        meal_doc = {
            'user_id': str(current_user['_id']),
            'timestamp': current_time,
            'mealType': 'blood_sugar_only',
            'foodItems': [],
            'activities': [],
            'nutrition': {
                'calories': 0, 'carbs': 0, 'protein': 0, 'fat': 0,
                'absorption_factor': 1.0
            },
            'bloodSugar': blood_sugar,
            'bloodSugarTimestamp': parsed_timestamp.replace(tzinfo=None),  # I-10: store as datetime (consistent with blood_sugar collection)
            'bloodSugarSource': source,
            'notes': notes,
            'isStandaloneReading': True,
            'suggestedInsulin': 0,
            'insulinCalculation': {},
            'blood_sugar_id': blood_sugar_id
        }

        logger.info("=" * 80)
        logger.info("💾 INSERTING INTO meals DATABASE...")
        logger.info(f"📄 Document: {meal_doc}")

        meal_result = mongo.db.meals.insert_one(meal_doc)
        meal_id = str(meal_result.inserted_id)

        logger.info(f"✅ SUCCESS! Meal record created with ID: {meal_id}")

        verify_meal = mongo.db.meals.find_one({"_id": meal_result.inserted_id})
        if verify_meal:
            logger.info(f"✅ VERIFIED: Record exists in meals database")
        else:
            logger.error(f"❌ ERROR: Record NOT found in meals database!")

        logger.info(f"🔗 LINKING: Updating blood_sugar record {blood_sugar_id} with meal_id {meal_id}")
        update_result = mongo.db.blood_sugar.update_one(
            {"_id": bs_result.inserted_id},
            {"$set": {"meal_id": meal_id}}
        )

        if update_result.modified_count > 0:
            logger.info(f"✅ LINKED: Blood sugar record updated successfully")
        else:
            logger.warning(f"⚠️ WARNING: Update did not modify any documents")

        logger.info("=" * 80)
        logger.info("🔍 FINAL VERIFICATION:")
        final_bs = mongo.db.blood_sugar.find_one({"_id": bs_result.inserted_id})
        final_meal = mongo.db.meals.find_one({"_id": meal_result.inserted_id})

        logger.info(f"✅ blood_sugar DB - Record exists: {final_bs is not None}")
        if final_bs:
            logger.info(f"   - Has meal_id: {final_bs.get('meal_id') is not None}")
            logger.info(f"   - meal_id value: {final_bs.get('meal_id')}")

        logger.info(f"✅ meals DB - Record exists: {final_meal is not None}")
        if final_meal:
            logger.info(f"   - Has blood_sugar_id: {final_meal.get('blood_sugar_id') is not None}")
            logger.info(f"   - blood_sugar_id value: {final_meal.get('blood_sugar_id')}")

        logger.info("=" * 80)
        logger.info("🎉 BLOOD SUGAR RECORDING COMPLETE!")
        logger.info("=" * 80)

        return jsonify({
            'message': 'Blood sugar reading recorded successfully',
            'id': blood_sugar_id,
            'meal_id': meal_id,
            'status': status,
            'bloodSugarTimestamp': parsed_timestamp.isoformat()
        }), 201

    except HTTPException:
        # D3: a malformed request body makes `request.json` raise BadRequest.
        # Catching it here turned a client error into a 500 — reported to the
        # caller as a server fault and logged at error level, where it hid real
        # faults in the noise. Re-raise so `@api_error_handler` returns the
        # status the exception already carries.
        raise
    except Exception as e:
        logger.error("=" * 80)
        logger.error(f"💥 EXCEPTION in add_blood_sugar!")
        logger.error(f"❌ Error: {str(e)}")
        logger.error(f"📋 Exception type: {type(e).__name__}")
        logger.error(f"📚 Traceback:")
        logger.error(traceback.format_exc())
        logger.error("=" * 80)
        # The message is logged above, not returned: `str(e)` on an unexpected
        # fault can carry connection strings, query fragments or file paths.
        return jsonify({'error': 'An unexpected error occurred'}), 500


def normalize_timestamp(timestamp_str):
    """Convert any timestamp format to UTC datetime object"""
    if not timestamp_str:
        return datetime.utcnow()

    if timestamp_str.endswith('Z'):
        timestamp_str = timestamp_str[:-1] + '+00:00'
    elif not ('+' in timestamp_str or '-' in timestamp_str[-6:]):
        timestamp_str = timestamp_str + '+00:00'

    parsed = datetime.fromisoformat(timestamp_str)
    return parsed.replace(tzinfo=None)


@blood_sugar_bp.route('/api/blood-sugar', methods=['GET'])
@token_required
@api_error_handler
def get_blood_sugar_data(current_user):
    try:
        logger.info("=" * 50)
        logger.info("📖 BLOOD SUGAR GET ENDPOINT CALLED")
        logger.info(f"👤 User ID: {current_user.get('_id')}")

        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        start_time = request.args.get('start_time')
        end_time = request.args.get('end_time')
        # I-21: 'timestamp' = server write time (when the record was created).
        # 'bloodSugarTimestamp' = patient reading time (when the reading was taken).
        # For time-range queries that reflect when readings occurred,
        # callers should pass filter_by=reading_time (maps to bloodSugarTimestamp).
        # The default 'timestamp' is retained for backward compatibility but is
        # semantically incorrect for patient-facing time-range queries.
        filter_by = request.args.get('filter_by', 'timestamp')

        logger.info(f"📅 Date range: {start_date_str} to {end_date_str}")
        logger.info(f"⏰ Time range: {start_time} to {end_time}")
        logger.info(f"🔍 Filter by: {filter_by}")

        patient_id = request.args.get('patient_id')
        if patient_id and current_user.get('user_type') != 'doctor':
            return jsonify({"error": "Unauthorized to view patient data"}), 403

        user_id = patient_id if patient_id else str(current_user['_id'])

        query = {"user_id": user_id}

        if start_time or end_time or start_date_str or end_date_str:
            start_datetime = None
            end_datetime = None

            if start_time:
                try:
                    start_datetime = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                except ValueError:
                    return jsonify({"error": "Invalid start_time format"}), 400

            if end_time:
                try:
                    end_datetime = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
                except ValueError:
                    return jsonify({"error": "Invalid end_time format"}), 400

            if not start_datetime and start_date_str:
                try:
                    start_datetime = datetime.strptime(start_date_str, '%Y-%m-%d')
                except ValueError:
                    return jsonify({"error": "Invalid start_date format"}), 400

            if not end_datetime and end_date_str:
                try:
                    end_datetime = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
                except ValueError:
                    return jsonify({"error": "Invalid end_date format"}), 400

            time_filter = {}
            if start_datetime:
                time_filter["$gte"] = start_datetime
            if end_datetime:
                time_filter["$lt"] = end_datetime

            if time_filter:
                if filter_by == 'reading_time':
                    # Match readings that HAVE bloodSugarTimestamp (all three storage
                    # formats used across client versions: datetime, ISO string, ISO+Z).
                    or_conditions = []
                    or_conditions.append({"bloodSugarTimestamp": time_filter})

                    string_filter = {}
                    if "$gte" in time_filter:
                        string_filter["$gte"] = time_filter["$gte"].isoformat()
                    if "$lt" in time_filter:
                        string_filter["$lt"] = time_filter["$lt"].isoformat()
                    or_conditions.append({"bloodSugarTimestamp": string_filter})

                    z_string_filter = {}
                    if "$gte" in time_filter:
                        z_string_filter["$gte"] = time_filter["$gte"].isoformat() + 'Z'
                    if "$lt" in time_filter:
                        z_string_filter["$lt"] = time_filter["$lt"].isoformat() + 'Z'
                    or_conditions.append({"bloodSugarTimestamp": z_string_filter})

                    # Also include readings saved WITHOUT bloodSugarTimestamp
                    # (readings logged before that field was introduced).
                    or_conditions.append({
                        "bloodSugarTimestamp": {"$exists": False},
                        "timestamp": time_filter,
                    })

                    query["$or"] = or_conditions
                else:
                    query["timestamp"] = time_filter

        else:
            # ── Safety net: no time params supplied ───────────────────────────
            # Without a limit, fetching all readings for a patient with 2000+
            # CGM entries returns 400–500 KB per request and blocks the single
            # gunicorn worker long enough to starve the health-check endpoint,
            # causing Render free-tier timeouts.
            # Default: last 30 days, which covers every legitimate use-case
            # (charts, baselines, export). Callers that genuinely need older
            # data must pass explicit start_date / start_time params.
            default_start = datetime.utcnow() - timedelta(days=30)
            query["timestamp"] = {"$gte": default_start}
            logger.info(f"⚠️  No time params — defaulting to last 30 days (from {default_start.date()})")

        logger.info(f"🔎 Query: {query}")

        blood_sugar_readings = list(mongo.db.blood_sugar.find(query).sort("timestamp", -1))
        logger.info(f"📊 Found {len(blood_sugar_readings)} blood sugar readings")

        formatted_readings = []
        for reading in blood_sugar_readings:
            formatted_reading = {
                "_id": str(reading["_id"]),
                "bloodSugar": reading["bloodSugar"],
                "timestamp": reading["timestamp"].isoformat() + "Z",
                "status": reading.get("status", "unknown"),
                "notes": reading.get("notes", ""),
                "target": reading.get("target", 100)
            }

            if "bloodSugarTimestamp" in reading:
                blood_sugar_ts = reading["bloodSugarTimestamp"]
                if isinstance(blood_sugar_ts, datetime):
                    formatted_reading["bloodSugarTimestamp"] = blood_sugar_ts.isoformat() + "Z"
                else:
                    if isinstance(blood_sugar_ts, str):
                        if not blood_sugar_ts.endswith('Z') and '+' not in blood_sugar_ts and blood_sugar_ts.count('-') == 2:
                            formatted_reading["bloodSugarTimestamp"] = blood_sugar_ts + "Z"
                        else:
                            formatted_reading["bloodSugarTimestamp"] = blood_sugar_ts
                    else:
                        formatted_reading["bloodSugarTimestamp"] = formatted_reading["timestamp"]

            formatted_readings.append(formatted_reading)

        logger.info(f"✅ Returning {len(formatted_readings)} formatted blood sugar readings")
        logger.info("=" * 50)
        return jsonify(formatted_readings), 200

    except Exception as e:
        logger.error(f"Error retrieving blood sugar data: {str(e)}")
        return jsonify({"error": str(e)}), 500


@blood_sugar_bp.route('/api/blood-sugar/<patient_id>', methods=['GET'])
@token_required
@api_error_handler
def get_patient_blood_sugar_data(current_user, patient_id):
    if current_user.get('user_type') != 'doctor':
        return jsonify({'error': 'Unauthorized'}), 403

    range_param = request.args.get('range', 'week')
    if range_param == 'day':
        start_date = datetime.utcnow() - timedelta(days=1)
    elif range_param == 'week':
        start_date = datetime.utcnow() - timedelta(weeks=1)
    else:
        start_date = datetime.utcnow() - timedelta(days=30)

    docs = list(mongo.db.blood_sugar.find({
        'user_id': patient_id,
        'timestamp': {'$gte': start_date}
    }).sort('timestamp', 1))

    for d in docs:
        d['_id'] = str(d['_id'])
        if 'timestamp' in d and isinstance(d['timestamp'], datetime):
            d['timestamp'] = d['timestamp'].isoformat() + 'Z'
        if 'bloodSugarTimestamp' in d and isinstance(d['bloodSugarTimestamp'], datetime):
            d['bloodSugarTimestamp'] = d['bloodSugarTimestamp'].isoformat() + 'Z'

    return jsonify(docs), 200