from flask import Blueprint, request, jsonify, current_app
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
from datetime import datetime, timedelta, timezone
from bson.objectid import ObjectId
from utils.auth import token_required, generate_token

auth_routes = Blueprint('auth_routes', __name__)

# Valid user types
VALID_USER_TYPES = ['patient', 'doctor', 'admin']


@auth_routes.route('/login', methods=['POST'])
def login():
    try:
        # Get logger and mongo instances
        logger = current_app.logger
        users = current_app.mongo.db.users

        # Log login attempt
        logger.debug("Processing login request")

        # Extract data from request
        data = request.get_json()
        if not data:
            logger.error("No JSON data in request")
            return jsonify({"error": "Missing request data"}), 400

        username = data.get('username')
        password = data.get('password')
        user_type = data.get('user_type')

        if not all([username, password, user_type]):
            logger.error("Missing required fields")
            return jsonify({"error": "Missing required fields"}), 400

        # Validate user type
        if user_type not in VALID_USER_TYPES:
            logger.error(f"Invalid user type: {user_type}")
            return jsonify({"error": f"Invalid user type.  Must be one of: {', '.join(VALID_USER_TYPES)}"}), 400

        # Find user
        user = users.find_one({"username": username, "user_type": user_type})
        logger.debug(f"User lookup completed for username: {username}")

        if user and check_password_hash(user['password'], password):
            # Generate token — mobile clients (X-Client-Type: mobile) get 90 days,
            # web clients get the standard 24 hours.
            token = generate_token(str(user['_id']), user['user_type'])

            # Prepare response.
            # shared_constants is embedded so both the React web app and
            # React Native mobile app always receive the latest constants
            # from the backend on every sign-in — replaces the file-write
            # approach that silently fails on Render (no frontend/mobile
            # directories exist on the server filesystem).
            try:
                from constants import Constants
                shared_constants = Constants.get_shared_constants_json()
            except Exception as _ce:
                logger.warning(f"Could not load shared constants: {_ce}")
                shared_constants = {}

            response = {
                "message": "Logged in successfully",
                "token": token,
                "user_type": user['user_type'],
                "firstName": user.get('first_name', ''),
                "lastName": user.get('last_name', ''),
                "shared_constants": shared_constants,
            }

            logger.debug("Login successful")
            return jsonify(response), 200

        logger.warning("Invalid credentials provided")
        return jsonify({"error": "Invalid credentials"}), 401

    except Exception as e:
        logger.error(f"Login error: {str(e)}")
        return jsonify({"error": "Login failed", "details": str(e)}), 500


@auth_routes.route('/register', methods=['POST'])
def register():
    try:
        logger = current_app.logger
        users = current_app.mongo.db.users

        logger.debug("Processing registration request")

        # Extract data from request
        data = request.get_json()
        if not data:
            logger.error("No JSON data in request")
            return jsonify({"error": "Missing request data"}), 400

        # Required fields
        required_fields = ['username', 'email', 'password', 'firstName',
                           'lastName', 'dateOfBirth', 'user_type']

        # Check if all required fields are present
        for field in required_fields:
            if field not in data:
                logger.error(f"Missing required field: {field}")
                return jsonify({"error": f"Missing required field: {field}"}), 400

        # Validate user type
        if data['user_type'] not in VALID_USER_TYPES:
            logger.error(f"Invalid user type: {data['user_type']}")
            return jsonify({"error": f"Invalid user type. Must be one of: {', '.join(VALID_USER_TYPES)}"}), 400

        # Check if username or email already exists
        if users.find_one({"username": data['username']}):
            logger.warning("Username already exists")
            return jsonify({"error": "Username already exists"}), 400

        if users.find_one({"email": data['email']}):
            logger.warning("Email already exists")
            return jsonify({"error": "Email already exists"}), 400

        # Prepare user data
        user_data = {
            'username': data['username'],
            'email': data['email'],
            'password': generate_password_hash(data['password']),
            'first_name': data['firstName'],
            'last_name': data['lastName'],
            'date_of_birth': data['dateOfBirth'],
            'user_type': data['user_type'],
            'created_at': datetime.now(timezone.utc)
        }

        # Add patient-specific fields
        if data['user_type'] == 'patient':
            # Add default patient constants from Constants class
            try:
                from constants import Constants
                default_constants = Constants.DEFAULT_PATIENT_CONSTANTS
                # Update user data with default constants (excluding nested dicts like meal_absorption_profiles)
                for key, value in default_constants.items():
                    if key != 'meal_absorption_profiles':  # Skip non-patient-modifiable constants
                        user_data[key] = value
                logger.debug(
                    f"Added default constants including daily_reset_hour={default_constants.get('daily_reset_hour', 7)}")
            except Exception as e:
                logger.warning(f"Could not load default constants: {str(e)}")

            # Initialize authorized doctors list (empty by default)
            user_data['authorized_doctors'] = []

        # Insert user
        user_id = users.insert_one(user_data).inserted_id
        logger.info(f"User registered successfully: {user_id}")

        return jsonify({
            "message": "User registered successfully",
            "id": str(user_id)
        }), 201

    except Exception as e:
        logger.error(f"Registration error: {str(e)}")
        return jsonify({"error": "Registration failed", "details": str(e)}), 500


@auth_routes.route('/api/doctors', methods=['GET'])
@token_required
def get_available_doctors(current_user):
    """Get list of all doctors (for patients to select from)"""
    try:
        logger = current_app.logger
        users = current_app.mongo.db.users

        # Only patients can view and select doctors
        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can view available doctors'}), 403

        # Find all doctors
        doctors = list(users.find(
            {"user_type": "doctor"},
            {"password": 0}  # Exclude password
        ))

        doctor_list = []
        for doctor in doctors:
            doctor_data = {
                'id': str(doctor['_id']),
                'firstName': doctor.get('first_name', ''),
                'lastName': doctor.get('last_name', ''),
                'email': doctor.get('email', '')
            }
            doctor_list.append(doctor_data)

        return jsonify(doctor_list), 200

    except Exception as e:
        logger.error(f"Error fetching doctors: {str(e)}")
        return jsonify({"error": "Failed to fetch doctors"}), 500


@auth_routes.route('/api/patient/authorized-doctors', methods=['GET'])
@token_required
def get_authorized_doctors(current_user):
    """Get list of doctors authorized by the current patient"""
    try:
        logger = current_app.logger
        users = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can view their authorized doctors'}), 403

        # Get patient's authorized doctors
        patient = users.find_one({"_id": current_user['_id']})
        authorized_doctor_ids = patient.get('authorized_doctors', [])

        # Fetch doctor details
        authorized_doctors = []
        for doctor_id in authorized_doctor_ids:
            try:
                doctor = users.find_one({"_id": ObjectId(doctor_id)})
                if doctor:
                    authorized_doctors.append({
                        'id': str(doctor['_id']),
                        'firstName': doctor.get('first_name', ''),
                        'lastName': doctor.get('last_name', ''),
                        'email': doctor.get('email', '')
                    })
            except Exception as e:
                logger.error(f"Error fetching doctor {doctor_id}: {str(e)}")
                continue

        return jsonify(authorized_doctors), 200

    except Exception as e:
        logger.error(f"Error fetching authorized doctors: {str(e)}")
        return jsonify({"error": "Failed to fetch authorized doctors"}), 500


@auth_routes.route('/api/patient/authorize-doctor', methods=['POST'])
@token_required
def authorize_doctor(current_user):
    """Add a doctor to patient's authorized list"""
    try:
        logger = current_app.logger
        users = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can authorize doctors'}), 403

        data = request.get_json()
        doctor_id = data.get('doctor_id')

        if not doctor_id:
            return jsonify({'error': 'Doctor ID is required'}), 400

        # Verify doctor exists
        doctor = users.find_one({"_id": ObjectId(doctor_id), "user_type": "doctor"})
        if not doctor:
            return jsonify({'error': 'Doctor not found'}), 404

        # Add doctor to authorized list (avoid duplicates)
        result = users.update_one(
            {"_id": current_user['_id']},
            {"$addToSet": {"authorized_doctors": doctor_id}}
        )

        if result.modified_count > 0 or result.matched_count > 0:
            logger.info(f"Patient {current_user['_id']} authorized doctor {doctor_id}")
            return jsonify({
                'message': 'Doctor authorized successfully',
                'doctor': {
                    'id': str(doctor['_id']),
                    'firstName': doctor.get('first_name', ''),
                    'lastName': doctor.get('last_name', '')
                }
            }), 200

        return jsonify({'error': 'Failed to authorize doctor'}), 500

    except Exception as e:
        logger.error(f"Error authorizing doctor: {str(e)}")
        return jsonify({"error": "Failed to authorize doctor"}), 500


@auth_routes.route('/api/patient/revoke-doctor', methods=['POST'])
@token_required
def revoke_doctor(current_user):
    """Remove a doctor from patient's authorized list"""
    try:
        logger = current_app.logger
        users = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can revoke doctor access'}), 403

        data = request.get_json()
        doctor_id = data.get('doctor_id')

        if not doctor_id:
            return jsonify({'error': 'Doctor ID is required'}), 400

        # Remove doctor from authorized list
        result = users.update_one(
            {"_id": current_user['_id']},
            {"$pull": {"authorized_doctors": doctor_id}}
        )

        if result.modified_count > 0:
            logger.info(f"Patient {current_user['_id']} revoked access for doctor {doctor_id}")
            return jsonify({'message': 'Doctor access revoked successfully'}), 200

        return jsonify({'message': 'Doctor was not in authorized list'}), 200

    except Exception as e:
        logger.error(f"Error revoking doctor access: {str(e)}")
        return jsonify({"error": "Failed to revoke doctor access"}), 500