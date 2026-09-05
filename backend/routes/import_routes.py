from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename
import os
import json
import csv
import io
from datetime import datetime, timezone, timedelta
from bson.objectid import ObjectId
import logging
from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from constants import Constants

# Initialize logger
logger = logging.getLogger(__name__)
import_routes = Blueprint('import_routes', __name__)

# Define allowed file extensions
ALLOWED_EXTENSIONS = {'csv', 'json'}


def allowed_file(filename):
    """Check if the uploaded file has an allowed extension"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


@import_routes.route('/api/import/validate', methods=['POST'])
@token_required
def validate_import_data(current_user):
    """
    Validate import data without saving it to the database
    """
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400

        if not allowed_file(file.filename):
            return jsonify({'error': f'File type not allowed. Please use {", ".join(ALLOWED_EXTENSIONS)}'}), 400

        import_type = request.form.get('type', 'all')
        if import_type not in ['all', 'meals', 'blood_sugar', 'activities', 'insulin']:
            return jsonify({'error': 'Invalid import type specified'}), 400

        # Read and validate file content
        validation_result = validate_file_content(file, import_type)

        # Add total counts to help the user understand the data
        file.seek(0)  # Reset file pointer to beginning
        counts = count_records(file, import_type)
        validation_result.update(counts)

        return jsonify(validation_result)

    except Exception as e:
        logger.error(f"Error validating import data: {str(e)}")
        return jsonify({'error': f'Validation error: {str(e)}'}), 500


@import_routes.route('/api/import', methods=['POST'])
@token_required
def import_data(current_user):
    """
    Import data from a file (CSV or JSON) into the database
    """
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400

        if not allowed_file(file.filename):
            return jsonify({'error': f'File type not allowed. Please use {", ".join(ALLOWED_EXTENSIONS)}'}), 400

        filename = secure_filename(file.filename)
        import_type = request.form.get('type', 'all')

        # Validate first
        validation_result = validate_file_content(file, import_type)
        if validation_result.get('errors', []):
            return jsonify({
                'error': 'Validation failed',
                'details': validation_result
            }), 400

        # Process and import data
        file.seek(0)  # Reset file pointer to beginning
        import_result = process_import(file, import_type, current_user['_id'])

        return jsonify({
            'success': True,
            'message': 'Data imported successfully',
            'results': import_result
        })

    except Exception as e:
        logger.error(f"Error importing data: {str(e)}")
        return jsonify({'error': f'Import error: {str(e)}'}), 500


def validate_file_content(file, import_type):
    """
    Validate the content of the uploaded file using built-in CSV and JSON modules
    """
    file_ext = file.filename.rsplit('.', 1)[1].lower()
    validation_results = {
        'valid': True,
        'errors': [],
        'warnings': []
    }

    try:
        # Parse the file based on its type
        if file_ext == 'csv':
            file.seek(0)
            # Read CSV data
            csv_content = file.read().decode('utf-8')
            reader = csv.DictReader(io.StringIO(csv_content))

            # Convert to list to count records and check headers
            records = list(reader)

            if not records:
                validation_results['errors'].append("File appears to be empty or has no valid data rows")
                validation_results['valid'] = False
                return validation_results

            # Check headers based on import type
            headers = reader.fieldnames

            if import_type == 'blood_sugar' or import_type == 'all':
                if 'bloodSugar' not in headers and 'blood_sugar' not in headers:
                    validation_results['errors'].append("Blood sugar data is missing required column 'bloodSugar'")
                if 'timestamp' not in headers and 'bloodSugarTimestamp' not in headers:
                    validation_results['errors'].append("Blood sugar data is missing timestamp column")

                # Validate blood sugar values
                for i, row in enumerate(records):
                    blood_sugar = row.get('bloodSugar', row.get('blood_sugar'))
                    if blood_sugar:
                        try:
                            bs_value = float(blood_sugar)
                            if bs_value < 0:
                                validation_results['warnings'].append(f"Row {i + 2}: Blood sugar cannot be negative")
                            elif bs_value > 600:
                                validation_results['warnings'].append(f"Row {i + 2}: Blood sugar value seems very high")
                        except ValueError:
                            validation_results['errors'].append(
                                f"Row {i + 2}: Blood sugar value '{blood_sugar}' is not a number")

            if import_type == 'meals' or import_type == 'all':
                if 'timestamp' not in headers:
                    validation_results['errors'].append("Meal data is missing required 'timestamp' column")
                if 'mealType' not in headers and 'meal_type' not in headers:
                    validation_results['warnings'].append(
                        "Meal data is missing 'mealType' column - will default to 'normal'")

            if import_type == 'activities' or import_type == 'all':
                if 'level' not in headers:
                    validation_results['errors'].append("Activity data is missing required 'level' column")
                if 'duration' not in headers and ('startTime' not in headers or 'endTime' not in headers):
                    validation_results['errors'].append(
                        "Activity data needs either 'duration' or both 'startTime' and 'endTime'")

            if import_type == 'insulin' or import_type == 'all':
                if 'dose' not in headers:
                    validation_results['errors'].append("Insulin data is missing required 'dose' column")
                if 'medication' not in headers and 'insulinType' not in headers and 'insulin_type' not in headers:
                    validation_results['errors'].append("Insulin data is missing required insulin type column")

        elif file_ext == 'json':
            # Parse JSON data
            file.seek(0)  # Reset file pointer
            content = file.read().decode('utf-8')
            data = json.loads(content)

            # Check if the data is an array
            if not isinstance(data, list):
                if 'data' in data and isinstance(data['data'], list):
                    data = data['data']
                else:
                    validation_results['errors'].append("JSON file should contain an array of records")
                    validation_results['valid'] = False
                    return validation_results

            if not data:
                validation_results['errors'].append("JSON file contains no records")
                validation_results['valid'] = False
                return validation_results

            # Validate each record based on type
            for i, record in enumerate(data):
                if import_type == 'blood_sugar' or import_type == 'all':
                    if 'bloodSugar' not in record and 'blood_sugar' not in record:
                        validation_results['errors'].append(f"Record #{i + 1}: Blood sugar value missing")
                    else:
                        # Validate blood sugar value
                        blood_sugar = record.get('bloodSugar', record.get('blood_sugar'))
                        if not isinstance(blood_sugar, (int, float)):
                            validation_results['errors'].append(f"Record #{i + 1}: Blood sugar value must be a number")
                        elif blood_sugar < 0:
                            validation_results['warnings'].append(f"Record #{i + 1}: Blood sugar cannot be negative")
                        elif blood_sugar > 600:
                            validation_results['warnings'].append(f"Record #{i + 1}: Blood sugar value seems very high")

                    if 'timestamp' not in record and 'bloodSugarTimestamp' not in record:
                        validation_results['errors'].append(f"Record #{i + 1}: Timestamp missing")

                if import_type == 'meals' or import_type == 'all':
                    if 'timestamp' not in record:
                        validation_results['errors'].append(f"Record #{i + 1}: Timestamp missing for meal")
                    if 'mealType' not in record and 'meal_type' not in record:
                        validation_results['warnings'].append(
                            f"Record #{i + 1}: Meal type missing - will default to 'normal'")

                if import_type == 'activities' or import_type == 'all':
                    if 'level' not in record:
                        validation_results['errors'].append(f"Record #{i + 1}: Activity level missing")
                    if 'duration' not in record and ('startTime' not in record or 'endTime' not in record):
                        validation_results['errors'].append(
                            f"Record #{i + 1}: Activity needs either duration or start/end times")

                if import_type == 'insulin' or import_type == 'all':
                    if 'dose' not in record:
                        validation_results['errors'].append(f"Record #{i + 1}: Insulin dose missing")
                    else:
                        # Validate dose
                        dose = record.get('dose')
                        if not isinstance(dose, (int, float)):
                            validation_results['errors'].append(f"Record #{i + 1}: Insulin dose must be a number")
                        elif dose < 0:
                            validation_results['warnings'].append(f"Record #{i + 1}: Insulin dose cannot be negative")

                    if 'medication' not in record and 'insulinType' not in record and 'insulin_type' not in record:
                        validation_results['errors'].append(f"Record #{i + 1}: Insulin type missing")

        # Check if there are any validation errors
        if validation_results['errors']:
            validation_results['valid'] = False

        return validation_results

    except Exception as e:
        validation_results['valid'] = False
        validation_results['errors'].append(f"File parsing error: {str(e)}")
        return validation_results


def count_records(file, import_type):
    """
    Count the number of records of each type in the file
    """
    file_ext = file.filename.rsplit('.', 1)[1].lower()
    counts = {
        'total_records': 0,
        'blood_sugar_records': 0,
        'meal_records': 0,
        'activity_records': 0,
        'insulin_records': 0
    }

    try:
        if file_ext == 'csv':
            file.seek(0)
            csv_content = file.read().decode('utf-8')
            reader = csv.DictReader(io.StringIO(csv_content))
            records = list(reader)

            counts['total_records'] = len(records)

            # Count types based on columns and values
            for record in records:
                if 'bloodSugar' in record or 'blood_sugar' in record:
                    counts['blood_sugar_records'] += 1

                if 'mealType' in record or 'meal_type' in record or 'foodItems' in record or 'food_items' in record:
                    counts['meal_records'] += 1

                if 'level' in record:
                    counts['activity_records'] += 1

                if 'dose' in record and ('medication' in record or 'insulinType' in record or 'insulin_type' in record):
                    counts['insulin_records'] += 1

        elif file_ext == 'json':
            file.seek(0)
            content = file.read().decode('utf-8')
            data = json.loads(content)

            if not isinstance(data, list):
                if 'data' in data and isinstance(data['data'], list):
                    data = data['data']
                else:
                    return counts

            counts['total_records'] = len(data)

            # Count types based on JSON fields
            for record in data:
                if 'bloodSugar' in record or 'blood_sugar' in record:
                    counts['blood_sugar_records'] += 1

                if 'mealType' in record or 'meal_type' in record or 'foodItems' in record or 'food_items' in record:
                    counts['meal_records'] += 1

                if 'level' in record:
                    counts['activity_records'] += 1

                if 'dose' in record and ('medication' in record or 'insulinType' in record or 'insulin_type' in record):
                    counts['insulin_records'] += 1

        return counts

    except Exception as e:
        logger.error(f"Error counting records: {str(e)}")
        return counts


def process_import(file, import_type, user_id):
    """
    Process the import file and save data to the database
    """
    file_ext = file.filename.rsplit('.', 1)[1].lower()
    results = {
        'meals_imported': 0,
        'blood_sugar_imported': 0,
        'activities_imported': 0,
        'insulin_imported': 0,
        'errors': []
    }

    try:
        # Parse the file based on its type
        if file_ext == 'csv':
            file.seek(0)
            csv_content = file.read().decode('utf-8')
            reader = csv.DictReader(io.StringIO(csv_content))
            records = list(reader)
        elif file_ext == 'json':
            file.seek(0)
            content = file.read().decode('utf-8')
            data = json.loads(content)
            if not isinstance(data, list):
                if 'data' in data and isinstance(data['data'], list):
                    records = data['data']
                else:
                    results['errors'].append("Invalid JSON format: expected array of records")
                    return results
            else:
                records = data

        # Process records based on import type
        if import_type == 'all':
            # Sort records by type and process each
            blood_sugar_records = []
            meal_records = []
            activity_records = []
            insulin_records = []

            for record in records:
                # Try to determine record type
                record_type = record.get('type', '').lower() if 'type' in record else ''

                if record_type == 'blood_sugar' or ('bloodSugar' in record or 'blood_sugar' in record):
                    blood_sugar_records.append(record)
                elif record_type == 'meal' or 'foodItems' in record or 'food_items' in record:
                    meal_records.append(record)
                elif record_type == 'activity' or 'level' in record:
                    activity_records.append(record)
                elif record_type == 'insulin' or ('dose' in record and
                                                  (
                                                          'medication' in record or 'insulinType' in record or 'insulin_type' in record)):
                    insulin_records.append(record)

            # Import each type
            if blood_sugar_records:
                bs_result = import_blood_sugar(blood_sugar_records, user_id)
                results['blood_sugar_imported'] = bs_result.get('imported', 0)
                results['errors'].extend(bs_result.get('errors', []))

            if meal_records:
                meal_result = import_meals(meal_records, user_id)
                results['meals_imported'] = meal_result.get('imported', 0)
                results['errors'].extend(meal_result.get('errors', []))

            if activity_records:
                activity_result = import_activities(activity_records, user_id)
                results['activities_imported'] = activity_result.get('imported', 0)
                results['errors'].extend(activity_result.get('errors', []))

            if insulin_records:
                insulin_result = import_insulin(insulin_records, user_id)
                results['insulin_imported'] = insulin_result.get('imported', 0)
                results['errors'].extend(insulin_result.get('errors', []))

        elif import_type == 'blood_sugar':
            bs_result = import_blood_sugar(records, user_id)
            results['blood_sugar_imported'] = bs_result.get('imported', 0)
            results['errors'].extend(bs_result.get('errors', []))

        elif import_type == 'meals':
            meal_result = import_meals(records, user_id)
            results['meals_imported'] = meal_result.get('imported', 0)
            results['errors'].extend(meal_result.get('errors', []))

        elif import_type == 'activities':
            activity_result = import_activities(records, user_id)
            results['activities_imported'] = activity_result.get('imported', 0)
            results['errors'].extend(activity_result.get('errors', []))

        elif import_type == 'insulin':
            insulin_result = import_insulin(records, user_id)
            results['insulin_imported'] = insulin_result.get('imported', 0)
            results['errors'].extend(insulin_result.get('errors', []))

        return results

    except Exception as e:
        logger.error(f"Error processing import: {str(e)}")
        results['errors'].append(f"Processing error: {str(e)}")
        return results


def import_blood_sugar(records, user_id):
    """
    Import blood sugar records
    """
    result = {'imported': 0, 'errors': []}
    imported_ids = []

    for i, record in enumerate(records):
        try:
            # Normalize field names
            blood_sugar = record.get('bloodSugar', record.get('blood_sugar'))
            if blood_sugar is None:
                result['errors'].append(f"Record #{i + 1}: Missing blood sugar value")
                continue

            # Convert to float if needed
            try:
                blood_sugar = float(blood_sugar)
            except (ValueError, TypeError):
                result['errors'].append(f"Record #{i + 1}: Invalid blood sugar value")
                continue

            # Normalize timestamps
            timestamp = standardize_timestamp(
                record.get('timestamp', record.get('bloodSugarTimestamp', record.get('blood_sugar_timestamp')))
            )

            if not timestamp:
                timestamp = datetime.now(timezone.utc)

            # Create blood sugar document
            # I-1: Use the canonical constants accessor — same pattern as every other route.
            # This fixes: wrong collection, wrong target_glucose default (120→100),
            # wrong insulin_to_carb_ratio (15→10), and wrong activity_coefficients keys.
            user_constants = Constants(user_id).get_patient_constants()
            target_glucose = user_constants.get('target_glucose', 100)

            # Determine status
            if blood_sugar < target_glucose * 0.7:
                status = "low"
            elif blood_sugar > target_glucose * 1.3:
                status = "high"
            else:
                status = "normal"

            bs_doc = {
                'user_id': str(user_id),
                'bloodSugar': float(blood_sugar),
                'status': status,
                'target': target_glucose,
                'timestamp': datetime.now(timezone.utc),  # When the record was created
                'bloodSugarTimestamp': timestamp,  # When the reading was taken
                'notes': record.get('notes', ''),
                'source': 'imported',
                'imported_at': datetime.now(timezone.utc)
            }

            # Insert into blood_sugar collection
            bs_result = mongo.db.blood_sugar.insert_one(bs_doc)
            blood_sugar_id = str(bs_result.inserted_id)

            # Also create a meal record for blood sugar integration
            meal_doc = {
                'user_id': str(user_id),
                'timestamp': datetime.now(timezone.utc),
                'mealType': 'blood_sugar_only',
                'foodItems': [],
                'activities': [],
                'nutrition': {
                    'calories': 0,
                    'carbs': 0,
                    'protein': 0,
                    'fat': 0,
                    'absorption_factor': 1.0
                },
                'bloodSugar': float(blood_sugar),
                'bloodSugarTimestamp': timestamp,
                'bloodSugarSource': 'imported',
                'notes': record.get('notes', ''),
                'isStandaloneReading': True,
                'suggestedInsulin': 0,
                'insulinCalculation': {},
                'blood_sugar_id': blood_sugar_id,
                'imported_at': datetime.now(timezone.utc)
            }

            # Insert into meals collection
            meal_result = mongo.db.meals.insert_one(meal_doc)
            meal_id = str(meal_result.inserted_id)

            # Update the blood sugar record with the meal reference
            mongo.db.blood_sugar.update_one(
                {"_id": bs_result.inserted_id},
                {"$set": {"meal_id": meal_id}}
            )

            imported_ids.append(blood_sugar_id)
            result['imported'] += 1

        except Exception as e:
            logger.error(f"Error importing blood sugar record #{i + 1}: {str(e)}")
            result['errors'].append(f"Record #{i + 1}: {str(e)}")

    return result


def import_meals(records, user_id):
    """Import meal records with simplified processing"""
    result = {'imported': 0, 'errors': []}

    try:
        for i, record in enumerate(records):
            try:
                # Process for the main meals collection
                record['user_id'] = str(user_id)

                # Normalize timestamp
                if 'timestamp' not in record:
                    record['timestamp'] = datetime.now(timezone.utc)
                elif isinstance(record['timestamp'], str):
                    try:
                        if record['timestamp'].endswith('Z'):
                            record['timestamp'] = record['timestamp'][:-1] + '+00:00'
                        record['timestamp'] = datetime.fromisoformat(record['timestamp'])
                    except ValueError:
                        record['timestamp'] = datetime.now(timezone.utc)

                # Handle required fields
                if 'suggestedInsulin' not in record:
                    record['suggestedInsulin'] = 0.0

                for field in ['foodItems', 'activities']:
                    if field not in record:
                        record[field] = []

                if 'mealType' not in record:
                    record['mealType'] = 'unknown'

                # FIXED: Simple nutrition processing - preserve CSV values
                if 'nutrition' not in record:
                    if all(key in record for key in ['carbs', 'protein', 'fat']):
                        # Use the CSV values directly - DON'T override them
                        carbs = float(record.get('carbs', 0))
                        protein = float(record.get('protein', 0))
                        fat = float(record.get('fat', 0))
                        calories = (carbs * 4) + (protein * 4) + (fat * 9)

                        # Get absorption type from CSV
                        absorption_type = record.get('absorption_type', 'medium')

                        # SIMPLIFIED: Create basic food item from notes without database lookup
                        food_items = []
                        notes = record.get('notes', '')

                        if notes:
                            # Extract just the food name without database lookup
                            food_name_parts = notes.split(' - ')
                            food_name = food_name_parts[0].strip() if food_name_parts else 'Unknown food'
                            food_description = food_name_parts[1].strip() if len(food_name_parts) > 1 else ''

                            # Create simple food item using CSV nutrition values
                            food_items = [{
                                'name': food_name,
                                'portion': {
                                    'amount': 1,
                                    'unit': 'serving',
                                    'measurement_type': 'volume'
                                },
                                'details': {
                                    'carbs': carbs,  # Use CSV carbs, not database lookup
                                    'protein': protein,  # Use CSV protein
                                    'fat': fat,  # Use CSV fat
                                    'absorption_type': absorption_type,
                                    'serving_size': {
                                        'amount': 1,
                                        'unit': 'serving'
                                    }
                                }
                            }]

                        record['foodItems'] = food_items

                        record['nutrition'] = {
                            'calories': round(calories, 1),
                            'carbs': round(carbs, 1),  # Preserve CSV carbs
                            'protein': round(protein, 1),  # Preserve CSV protein
                            'fat': round(fat, 1),  # Preserve CSV fat
                            'absorption_factor': 1.0,
                            'absorption_type': absorption_type
                        }
                    else:
                        record['nutrition'] = {
                            'calories': 0,
                            'carbs': 0,
                            'protein': 0,
                            'fat': 0,
                            'absorption_factor': 1.0,
                            'absorption_type': 'medium'
                        }

                # SIMPLIFIED: Create basic calculation summary without complex backend logic
                if record.get('nutrition') and record['nutrition'].get('carbs', 0) > 0:
                    carbs = record['nutrition']['carbs']
                    absorption_factor = 1.0  # Simple default

                    # Map absorption types to factors
                    absorption_factors = {
                        'very_fast': 1.4,
                        'fast': 1.2,
                        'medium': 1.0,
                        'slow': 0.8,
                        'very_slow': 0.6
                    }

                    absorption_type = record['nutrition'].get('absorption_type', 'medium')
                    absorption_factor = absorption_factors.get(absorption_type, 1.0)

                    base_insulin = carbs / 10  # Simple 1:10 ratio
                    adjusted_insulin = base_insulin * absorption_factor

                    record['calculation_summary'] = {
                        'base_insulin': base_insulin,
                        'adjustment_factors': {
                            'absorption_rate': absorption_factor,
                            'meal_timing': 1.0
                        },
                        'meal_only_suggested_insulin': adjusted_insulin,
                        'absorption_type': absorption_type,
                        'absorption_metadata': {
                            'weighted_type': absorption_type,
                            'patient_modifier': absorption_factor
                        }
                    }

                # Insert into meals collection
                meal_result = mongo.db.meals.insert_one(record)
                meal_id = str(meal_result.inserted_id)

                # Create corresponding meals_only record
                meals_only_record = {
                    'user_id': str(user_id),
                    'meal_id': meal_id,
                    'timestamp': record['timestamp'],
                    'mealType': record['mealType'],
                    'foodItems': record['foodItems'],
                    'nutrition': record['nutrition'],
                    'notes': record.get('notes', ''),
                    'imported_at': datetime.now(timezone.utc)
                }

                # Add calculation_summary if available
                if 'calculation_summary' in record:
                    meals_only_record['calculation_summary'] = record['calculation_summary']

                # Insert into meals_only collection
                mongo.db.meals_only.insert_one(meals_only_record)

                # Update counter
                result['imported'] += 1
                logger.info(
                    f"Imported meal record #{i + 1} with ID {meal_id}, carbs: {record['nutrition'].get('carbs', 0)}g, absorption: {record['nutrition'].get('absorption_type', 'unknown')}")

            except Exception as e:
                logger.error(f"Error importing meal record #{i + 1}: {str(e)}")
                result['errors'].append(f"Record #{i + 1}: {str(e)}")

        return result

    except Exception as e:
        logger.error(f"Error in import_meals: {str(e)}")
        result['errors'].append(f"Import error: {str(e)}")
        return result

def import_activities(records, user_id):
    """
    Import activity records
    """
    result = {'imported': 0, 'errors': []}
    imported_activity_ids = []

    for i, record in enumerate(records):
        try:
            # Get activity level
            level = record.get('level')
            if level is None:
                result['errors'].append(f"Record #{i + 1}: Missing activity level")
                continue

            # Convert level to int if possible
            try:
                level = int(level)
            except (ValueError, TypeError):
                result['errors'].append(f"Record #{i + 1}: Activity level must be a number")
                continue

            # Get activity type
            activity_type = record.get('type', 'expected')

            # Process timestamps
            timestamp = standardize_timestamp(record.get('timestamp', datetime.now(timezone.utc)))
            start_time = standardize_timestamp(record.get('startTime', record.get('start_time', timestamp)))

            # Handle end time
            if 'endTime' in record or 'end_time' in record:
                end_time = standardize_timestamp(record.get('endTime', record.get('end_time')))
            elif 'duration' in record:
                # Calculate end time from duration
                duration = record['duration']
                if isinstance(duration, str) and ':' in duration:
                    hours, minutes = map(int, duration.split(':'))
                    duration_hours = hours + (minutes / 60)
                else:
                    duration_hours = float(duration)

                if isinstance(start_time, datetime):
                    end_time = start_time + timedelta(hours=duration_hours)
                else:
                    # Default to 1 hour later if start_time isn't a datetime
                    end_time = datetime.now(timezone.utc) + timedelta(hours=1)
            else:
                # Default to 1 hour activity
                if isinstance(start_time, datetime):
                    end_time = start_time + timedelta(hours=1)
                else:
                    end_time = datetime.now(timezone.utc) + timedelta(hours=1)

            # Calculate duration string
            if isinstance(start_time, datetime) and isinstance(end_time, datetime):
                hours_diff = (end_time - start_time).total_seconds() / 3600
                hours = int(hours_diff)
                minutes = int((hours_diff % 1) * 60)
                duration_str = f"{hours:02d}:{minutes:02d}"
            else:
                duration_str = "01:00"  # Default 1 hour

            # Create activity document
            activity_doc = {
                'user_id': str(user_id),
                'timestamp': timestamp if isinstance(timestamp, datetime) else datetime.now(timezone.utc),
                'type': activity_type,
                'level': level,
                # I-22: source tag required for audit queries and CGM detection pattern
                # (mirrors 'manual' / 'google_fit' / 'watch' on other paths)
                'source': 'imported',
                'startTime': start_time if isinstance(start_time, datetime) else datetime.now(timezone.utc),
                'endTime': end_time if isinstance(end_time, datetime) else datetime.now(timezone.utc) + timedelta(
                    hours=1),
                'duration': duration_str,
                'notes': record.get('notes', ''),
                'impact': float(record.get('impact', 1.0)),
                'imported_at': datetime.now(timezone.utc)
            }

            # Add expected/completed time based on type
            if activity_type == 'expected':
                activity_doc['expectedTime'] = activity_doc['startTime']
            else:
                activity_doc['completedTime'] = activity_doc['startTime']

            # Insert into activities collection
            activity_result = mongo.db.activities.insert_one(activity_doc)
            activity_id = str(activity_result.inserted_id)
            imported_activity_ids.append(activity_id)

            result['imported'] += 1

        except Exception as e:
            logger.error(f"Error importing activity record #{i + 1}: {str(e)}")
            result['errors'].append(f"Record #{i + 1}: {str(e)}")

    # If activities were imported, create a meal record to link them
    if imported_activity_ids:
        try:
            # Create meal document with references to activities
            meal_doc = {
                'user_id': str(user_id),
                'timestamp': datetime.now(timezone.utc),
                'mealType': 'activity_only',
                'foodItems': [],
                'activities': [str(id) for id in imported_activity_ids],
                'notes': 'Imported activities',
                'recordingType': 'standalone_activity_recording',
                'calculationFactors': {
                    'activityImpact': 1.0,
                    'healthMultiplier': 0.0
                },
                'skipActivityDuplication': True,
                'activityIds': imported_activity_ids,
                'imported_at': datetime.now(timezone.utc),
                'suggestedInsulin': 0  # Default
            }

            mongo.db.meals.insert_one(meal_doc)
        except Exception as e:
            logger.error(f"Error creating meal record for activities: {str(e)}")

    return result


def import_insulin(records, user_id):
    """
    Import insulin records
    """
    result = {'imported': 0, 'errors': []}

    for i, record in enumerate(records):
        try:
            # Get insulin dose
            dose = record.get('dose')
            if dose is None:
                result['errors'].append(f"Record #{i + 1}: Missing insulin dose")
                continue

            try:
                dose = float(dose)
            except (ValueError, TypeError):
                result['errors'].append(f"Record #{i + 1}: Insulin dose must be a number")
                continue

            # Get insulin type
            insulin_type = record.get('medication',
                                      record.get('insulinType',
                                                 record.get('insulin_type', 'regular_insulin')))

            # Process timestamp
            timestamp = standardize_timestamp(record.get('timestamp',
                                                         record.get('scheduled_time',
                                                                    record.get('administrationTime'))))
            if not timestamp:
                timestamp = datetime.now(timezone.utc)

            # Create medication log entry
            medication_log = {
                'patient_id': str(user_id),
                'medication': insulin_type,
                'dose': dose,
                'scheduled_time': timestamp if isinstance(timestamp, datetime) else datetime.now(timezone.utc),
                'taken_at': timestamp if isinstance(timestamp, datetime) else datetime.now(timezone.utc),
                'status': 'taken',
                'created_at': datetime.now(timezone.utc),
                'created_by': str(user_id),
                'notes': record.get('notes', 'Imported insulin dose'),
                'is_insulin': True,
                'imported_at': datetime.now(timezone.utc)
            }

            # Insert into medication_logs
            log_result = mongo.db.medication_logs.insert_one(medication_log)

            # Create a corresponding meal record for integration
            meal_doc = {
                'user_id': str(user_id),
                'timestamp': timestamp if isinstance(timestamp, datetime) else datetime.now(timezone.utc),
                'mealType': 'insulin_only',
                'recordingType': 'insulin',
                'foodItems': [],
                'activities': [],
                'bloodSugar': None,
                'bloodSugarSource': 'none',
                'intendedInsulin': dose,
                'intendedInsulinType': insulin_type,
                'notes': record.get('notes', 'Imported insulin dose'),
                'medicationLog': {
                    'is_insulin': True,
                    'dose': dose,
                    'medication': insulin_type,
                    'scheduled_time': timestamp if isinstance(timestamp, datetime) else datetime.now(timezone.utc),
                    'notes': record.get('notes', '')
                },
                'imported_at': datetime.now(timezone.utc),
                'suggestedInsulin': 0  # Default
            }

            meal_result = mongo.db.meals.insert_one(meal_doc)

            # Update the medication log with the meal reference
            mongo.db.medication_logs.update_one(
                {"_id": log_result.inserted_id},
                {"$set": {"meal_id": str(meal_result.inserted_id)}}
            )

            result['imported'] += 1

        except Exception as e:
            logger.error(f"Error importing insulin record #{i + 1}: {str(e)}")
            result['errors'].append(f"Record #{i + 1}: {str(e)}")

    return result


def standardize_timestamp(timestamp):
    """
    Convert various timestamp formats to datetime object with UTC timezone
    """
    if not timestamp:
        return None

    if isinstance(timestamp, datetime):
        # Ensure it has timezone info
        if timestamp.tzinfo is None:
            return timestamp.replace(tzinfo=timezone.utc)
        return timestamp

    if isinstance(timestamp, str):
        try:
            # Try ISO format
            if timestamp.endswith('Z'):
                timestamp = timestamp[:-1] + '+00:00'

            if '+' in timestamp or '-' in timestamp[-6:]:
                # Parse the timestamp with timezone info
                dt = datetime.fromisoformat(timestamp)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt

            # Handle ISO format without timezone
            if 'T' in timestamp:
                dt = datetime.fromisoformat(timestamp)
                return dt.replace(tzinfo=timezone.utc)

            # Try common date formats
            formats = [
                '%Y-%m-%d %H:%M:%S',
                '%Y-%m-%d %H:%M',
                '%Y-%m-%d',
                '%m/%d/%Y %H:%M:%S',
                '%m/%d/%Y %H:%M',
                '%m/%d/%Y'
            ]

            for fmt in formats:
                try:
                    dt = datetime.strptime(timestamp, fmt)
                    return dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    continue

            # Final fallback: use current UTC time rather than a hardcoded date
            return datetime.now(timezone.utc)

        except Exception as e:
            logger.error(f"Error parsing timestamp {timestamp}: {e}")
            return datetime.now(timezone.utc)

    return datetime.now(timezone.utc)



@import_routes.route('/api/import/export-template', methods=['GET'])
@token_required
def export_template(current_user):
    """
    Export a template CSV or JSON file for user to fill with data
    """
    try:
        format_type = request.args.get('format', 'csv')
        data_type = request.args.get('type', 'all')

        if format_type not in ['csv', 'json']:
            return jsonify({'error': 'Invalid format type'}), 400

        if data_type not in ['all', 'blood_sugar', 'meals', 'activities', 'insulin']:
            return jsonify({'error': 'Invalid data type'}), 400

        # Generate appropriate template based on type and format
        if format_type == 'csv':
            # Create CSV template
            output = io.StringIO()
            writer = csv.writer(output)

            if data_type == 'blood_sugar':
                writer.writerow(['timestamp', 'bloodSugar', 'notes'])
                writer.writerow(['2025-05-04T10:15:00Z', '120', 'Example reading'])

            elif data_type == 'meals':
                writer.writerow(['timestamp', 'mealType', 'foodItems', 'carbs', 'protein', 'fat', 'notes'])
                writer.writerow(['2025-05-04T12:30:00Z', 'lunch', 'Sandwich, Apple', '45', '15', '8', 'Example meal'])

            elif data_type == 'activities':
                writer.writerow(['timestamp', 'type', 'level', 'duration', 'startTime', 'endTime', 'notes'])
                writer.writerow(
                    ['2025-05-04T15:00:00Z', 'completed', '2', '01:30', '2025-05-04T15:00:00Z', '2025-05-04T16:30:00Z',
                     'Example activity'])

            elif data_type == 'insulin':
                writer.writerow(['timestamp', 'dose', 'medication', 'notes'])
                writer.writerow(['2025-05-04T18:00:00Z', '5.5', 'rapid_acting', 'Example insulin dose'])

            else:  # all
                writer.writerow(['type', 'timestamp', 'bloodSugar', 'mealType', 'foodItems', 'carbs', 'protein', 'fat',
                                 'activityLevel', 'duration', 'insulinDose', 'insulinType', 'notes'])
                writer.writerow(['blood_sugar', '2025-05-04T10:15:00Z', '120', '', '', '', '', '', '', '', '', '',
                                 'Example blood sugar'])
                writer.writerow(
                    ['meal', '2025-05-04T12:30:00Z', '', 'lunch', 'Sandwich, Apple', '45', '15', '8', '', '', '', '',
                     'Example meal'])
                writer.writerow(['activity', '2025-05-04T15:00:00Z', '', '', '', '', '', '', '2', '01:30', '', '',
                                 'Example activity'])
                writer.writerow(
                    ['insulin', '2025-05-04T18:00:00Z', '', '', '', '', '', '', '', '', '5.5', 'rapid_acting',
                     'Example insulin'])

            output.seek(0)
            return output.getvalue(), 200, {
                'Content-Type': 'text/csv',
                'Content-Disposition': f'attachment; filename=diabetes_import_template_{data_type}.csv'
            }

        else:  # JSON format
            # Create JSON template
            template = []

            if data_type == 'blood_sugar':
                template = [
                    {
                        "timestamp": "2025-05-04T10:15:00Z",
                        "bloodSugar": 120,
                        "notes": "Example reading"
                    }
                ]

            elif data_type == 'meals':
                template = [
                    {
                        "timestamp": "2025-05-04T12:30:00Z",
                        "mealType": "lunch",
                        "foodItems": [
                            {
                                "name": "Sandwich",
                                "portion": {
                                    "amount": 1,
                                    "unit": "serving"
                                },
                                "details": {
                                    "carbs": 30,
                                    "protein": 12,
                                    "fat": 6
                                }
                            },
                            {
                                "name": "Apple",
                                "portion": {
                                    "amount": 1,
                                    "unit": "medium"
                                },
                                "details": {
                                    "carbs": 15,
                                    "protein": 0,
                                    "fat": 0
                                }
                            }
                        ],
                        "notes": "Example meal"
                    }
                ]

            elif data_type == 'activities':
                template = [
                    {
                        "timestamp": "2025-05-04T15:00:00Z",
                        "type": "completed",
                        "level": 2,
                        "duration": "01:30",
                        "startTime": "2025-05-04T15:00:00Z",
                        "endTime": "2025-05-04T16:30:00Z",
                        "notes": "Example activity"
                    }
                ]

            elif data_type == 'insulin':
                template = [
                    {
                        "timestamp": "2025-05-04T18:00:00Z",
                        "dose": 5.5,
                        "medication": "rapid_acting",
                        "notes": "Example insulin dose"
                    }
                ]

            else:  # all
                template = [
                    {
                        "type": "blood_sugar",
                        "timestamp": "2025-05-04T10:15:00Z",
                        "bloodSugar": 120,
                        "notes": "Example blood sugar"
                    },
                    {
                        "type": "meal",
                        "timestamp": "2025-05-04T12:30:00Z",
                        "mealType": "lunch",
                        "foodItems": [
                            {
                                "name": "Sandwich",
                                "details": {
                                    "carbs": 30,
                                    "protein": 12,
                                    "fat": 6
                                }
                            },
                            {
                                "name": "Apple",
                                "details": {
                                    "carbs": 15,
                                    "protein": 0,
                                    "fat": 0
                                }
                            }
                        ],
                        "notes": "Example meal"
                    },
                    {
                        "type": "activity",
                        "timestamp": "2025-05-04T15:00:00Z",
                        "level": 2,
                        "duration": "01:30",
                        "notes": "Example activity"
                    },
                    {
                        "type": "insulin",
                        "timestamp": "2025-05-04T18:00:00Z",
                        "dose": 5.5,
                        "medication": "rapid_acting",
                        "notes": "Example insulin"
                    }
                ]

            return jsonify(template), 200, {
                'Content-Disposition': f'attachment; filename=diabetes_import_template_{data_type}.json'
            }

    except Exception as e:
        logger.error(f"Error creating template: {str(e)}")
        return jsonify({'error': f'Error creating template: {str(e)}'}), 500


@import_routes.route('/api/import/download-data', methods=['GET'])
@token_required
def download_data(current_user):
    """
    Download user's data in CSV or JSON format
    """
    try:
        format_type = request.args.get('format', 'json')
        data_type = request.args.get('type', 'all')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')

        if format_type not in ['csv', 'json']:
            return jsonify({'error': 'Invalid format type'}), 400

        if data_type not in ['all', 'blood_sugar', 'meals', 'activities', 'insulin']:
            return jsonify({'error': 'Invalid data type'}), 400

        # Build date filter
        date_filter = {}
        if start_date:
            try:
                start_datetime = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
                date_filter['$gte'] = start_datetime
            except ValueError:
                return jsonify({'error': 'Invalid start_date format'}), 400

        if end_date:
            try:
                end_datetime = datetime.fromisoformat(end_date.replace('Z', '+00:00'))
                date_filter['$lte'] = end_datetime
            except ValueError:
                return jsonify({'error': 'Invalid end_date format'}), 400

        # Fetch data based on type
        user_id_str = str(current_user['_id'])

        if data_type == 'blood_sugar' or data_type == 'all':
            query = {'user_id': user_id_str}
            if date_filter:
                query['timestamp'] = date_filter

            blood_sugar_data = list(mongo.db.blood_sugar.find(query).sort('timestamp', -1))

            # Convert ObjectId to strings for JSON serialization
            for record in blood_sugar_data:
                record['_id'] = str(record['_id'])
                if 'meal_id' in record:
                    record['meal_id'] = str(record['meal_id'])
                # Format dates for serialization
                for key in record:
                    if isinstance(record[key], datetime):
                        record[key] = record[key].isoformat()
        else:
            blood_sugar_data = []

        if data_type == 'meals' or data_type == 'all':
            query = {'user_id': user_id_str}
            if date_filter:
                query['timestamp'] = date_filter

            meal_data = list(mongo.db.meals.find(query).sort('timestamp', -1))

            # Convert ObjectId to strings
            for record in meal_data:
                record['_id'] = str(record['_id'])
                if 'blood_sugar_id' in record:
                    record['blood_sugar_id'] = str(record['blood_sugar_id'])
                # Format dates for serialization
                for key in record:
                    if isinstance(record[key], datetime):
                        record[key] = record[key].isoformat()
        else:
            meal_data = []

        if data_type == 'activities' or data_type == 'all':
            query = {'user_id': user_id_str}
            if date_filter:
                query['timestamp'] = date_filter

            activity_data = list(mongo.db.activities.find(query).sort('timestamp', -1))

            # Convert ObjectId to strings
            for record in activity_data:
                record['_id'] = str(record['_id'])
                if 'meal_id' in record:
                    record['meal_id'] = str(record['meal_id'])
                # Format dates for serialization
                for key in record:
                    if isinstance(record[key], datetime):
                        record[key] = record[key].isoformat()
        else:
            activity_data = []

        if data_type == 'insulin' or data_type == 'all':
            query = {'patient_id': user_id_str, 'is_insulin': True}
            if date_filter:
                query['taken_at'] = date_filter

            insulin_data = list(mongo.db.medication_logs.find(query).sort('taken_at', -1))

            # Convert ObjectId to strings
            for record in insulin_data:
                record['_id'] = str(record['_id'])
                if 'meal_id' in record:
                    record['meal_id'] = str(record['meal_id'])
                # Format dates for serialization
                for key in record:
                    if isinstance(record[key], datetime):
                        record[key] = record[key].isoformat()
        else:
            insulin_data = []

        # Format and return data
        if format_type == 'json':
            # Combine all data into one JSON structure
            result = {
                'user_id': user_id_str,
                'export_date': datetime.now(timezone.utc).isoformat(),
                'data': {
                    'blood_sugar': blood_sugar_data,
                    'meals': meal_data,
                    'activities': activity_data,
                    'insulin': insulin_data
                }
            }

            if data_type != 'all':
                # Return only requested data type
                return jsonify(result['data'][data_type]), 200, {
                    'Content-Disposition': f'attachment; filename=diabetes_data_{data_type}_{datetime.now().strftime("%Y%m%d")}.json'
                }
            else:
                # Return all data
                return jsonify(result), 200, {
                    'Content-Disposition': f'attachment; filename=diabetes_data_all_{datetime.now().strftime("%Y%m%d")}.json'
                }

        else:  # CSV format
            if data_type == 'blood_sugar':
                # Format blood sugar data for CSV
                output = io.StringIO()
                writer = csv.writer(output)

                # Write header
                writer.writerow(['timestamp', 'bloodSugar', 'status', 'target', 'notes', 'source'])

                # Write data rows
                for record in blood_sugar_data:
                    writer.writerow([
                        record['timestamp'],
                        record['bloodSugar'],
                        record.get('status', ''),
                        record.get('target', ''),
                        record.get('notes', ''),
                        record.get('source', '')
                    ])

                output.seek(0)
                return output.getvalue(), 200, {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': f'attachment; filename=diabetes_blood_sugar_{datetime.now().strftime("%Y%m%d")}.csv'
                }

            elif data_type == 'meals':
                # Format meal data for CSV
                output = io.StringIO()
                writer = csv.writer(output)

                # Write header
                writer.writerow(
                    ['timestamp', 'mealType', 'foodItems', 'carbs', 'protein', 'fat', 'bloodSugar', 'notes'])

                # Write data rows
                for record in meal_data:
                    # Format food items
                    food_items_str = json.dumps(record.get('foodItems', []))

                    writer.writerow([
                        record['timestamp'],
                        record.get('mealType', ''),
                        food_items_str,
                        record.get('nutrition', {}).get('carbs', ''),
                        record.get('nutrition', {}).get('protein', ''),
                        record.get('nutrition', {}).get('fat', ''),
                        record.get('bloodSugar', ''),
                        record.get('notes', '')
                    ])

                output.seek(0)
                return output.getvalue(), 200, {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': f'attachment; filename=diabetes_meals_{datetime.now().strftime("%Y%m%d")}.csv'
                }

            elif data_type == 'activities':
                # Format activity data for CSV
                output = io.StringIO()
                writer = csv.writer(output)

                # Write header — includes ODE model fields and HR baselines
                writer.writerow([
                    'timestamp', 'type', 'level', 'intensity', 'duration',
                    'duration_minutes', 'startTime', 'endTime', 'impact',
                    'bg_direction', 'source', 'hr_base', 'hr_max', 'notes',
                ])

                # Write data rows
                for record in activity_data:
                    writer.writerow([
                        record.get('timestamp', ''),
                        record.get('type', ''),
                        record.get('level', ''),
                        record.get('intensity', ''),
                        record.get('duration', ''),
                        record.get('duration_minutes', ''),
                        record.get('startTime', ''),
                        record.get('endTime', ''),
                        record.get('impact', ''),
                        record.get('bg_direction', ''),
                        record.get('source', ''),
                        record.get('hr_base', ''),
                        record.get('hr_max', ''),
                        record.get('notes', ''),
                    ])

                output.seek(0)
                return output.getvalue(), 200, {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': f'attachment; filename=diabetes_activities_{datetime.now().strftime("%Y%m%d")}.csv'
                }

            elif data_type == 'insulin':
                # Format insulin data for CSV
                output = io.StringIO()
                writer = csv.writer(output)

                # Write header
                writer.writerow(['timestamp', 'dose', 'medication', 'scheduled_time', 'taken_at', 'status', 'notes'])

                # Write data rows
                for record in insulin_data:
                    writer.writerow([
                        record.get('created_at', ''),
                        record.get('dose', ''),
                        record.get('medication', ''),
                        record.get('scheduled_time', ''),
                        record.get('taken_at', ''),
                        record.get('status', ''),
                        record.get('notes', '')
                    ])

                output.seek(0)
                return output.getvalue(), 200, {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': f'attachment; filename=diabetes_insulin_{datetime.now().strftime("%Y%m%d")}.csv'
                }

            else:  # all data types in CSV
                # Create a ZIP file with multiple CSVs
                from io import BytesIO
                import zipfile

                memory_file = BytesIO()
                with zipfile.ZipFile(memory_file, 'w') as zf:
                    # Add blood sugar data
                    if blood_sugar_data:
                        bs_output = io.StringIO()
                        writer = csv.writer(bs_output)
                        writer.writerow(['timestamp', 'bloodSugar', 'status', 'target', 'notes', 'source'])

                        for record in blood_sugar_data:
                            writer.writerow([
                                record['timestamp'],
                                record['bloodSugar'],
                                record.get('status', ''),
                                record.get('target', ''),
                                record.get('notes', ''),
                                record.get('source', '')
                            ])

                        zf.writestr('blood_sugar.csv', bs_output.getvalue())

                    # Add meal data
                    if meal_data:
                        meal_output = io.StringIO()
                        writer = csv.writer(meal_output)
                        writer.writerow(
                            ['timestamp', 'mealType', 'foodItems', 'carbs', 'protein', 'fat', 'bloodSugar', 'notes'])

                        for record in meal_data:
                            food_items_str = json.dumps(record.get('foodItems', []))

                            writer.writerow([
                                record['timestamp'],
                                record.get('mealType', ''),
                                food_items_str,
                                record.get('nutrition', {}).get('carbs', ''),
                                record.get('nutrition', {}).get('protein', ''),
                                record.get('nutrition', {}).get('fat', ''),
                                record.get('bloodSugar', ''),
                                record.get('notes', '')
                            ])

                        zf.writestr('meals.csv', meal_output.getvalue())

                    # Add activity data
                    if activity_data:
                        activity_output = io.StringIO()
                        writer = csv.writer(activity_output)
                        # Header includes ODE model fields and HR baselines
                        writer.writerow([
                            'timestamp', 'type', 'level', 'intensity', 'duration',
                            'duration_minutes', 'startTime', 'endTime', 'impact',
                            'bg_direction', 'source', 'hr_base', 'hr_max', 'notes',
                        ])

                        for record in activity_data:
                            writer.writerow([
                                record.get('timestamp', ''),
                                record.get('type', ''),
                                record.get('level', ''),
                                record.get('intensity', ''),
                                record.get('duration', ''),
                                record.get('duration_minutes', ''),
                                record.get('startTime', ''),
                                record.get('endTime', ''),
                                record.get('impact', ''),
                                record.get('bg_direction', ''),
                                record.get('source', ''),
                                record.get('hr_base', ''),
                                record.get('hr_max', ''),
                                record.get('notes', ''),
                            ])

                        zf.writestr('activities.csv', activity_output.getvalue())

                    # Add insulin data
                    if insulin_data:
                        insulin_output = io.StringIO()
                        writer = csv.writer(insulin_output)
                        writer.writerow(
                            ['timestamp', 'dose', 'medication', 'scheduled_time', 'taken_at', 'status', 'notes'])

                        for record in insulin_data:
                            writer.writerow([
                                record.get('created_at', ''),
                                record.get('dose', ''),
                                record.get('medication', ''),
                                record.get('scheduled_time', ''),
                                record.get('taken_at', ''),
                                record.get('status', ''),
                                record.get('notes', '')
                            ])

                        zf.writestr('insulin.csv', insulin_output.getvalue())

                # Prepare the zip file for download
                memory_file.seek(0)
                return memory_file.getvalue(), 200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': f'attachment; filename=diabetes_data_all_{datetime.now().strftime("%Y%m%d")}.zip'
                }

    except Exception as e:
        logger.error(f"Error downloading data: {str(e)}")

        return jsonify({'error': f'Error downloading data: {str(e)}'}), 500


@import_routes.route('/api/bulk-import', methods=['POST'])
def bulk_import_data():
    """
    Bulk import endpoint for scripts - no auth required
    """
    try:
        data = request.get_json()
        username = data.get('username')
        records = data.get('records', [])

        # Find user by username
        user = current_app.mongo.db.users.find_one({"username": username})
        if not user:
            return jsonify({'error': 'User not found'}), 404

        # Process import using existing logic
        import_result = process_import_from_data(records, user['_id'])

        return jsonify({
            'success': True,
            'message': 'Data imported successfully',
            'results': import_result
        })

    except Exception as e:
        logger.error(f"Error in bulk import: {str(e)}")
        return jsonify({'error': f'Import error: {str(e)}'}), 500
        return jsonify({'error': f'Error downloading data: {str(e)}'}), 500