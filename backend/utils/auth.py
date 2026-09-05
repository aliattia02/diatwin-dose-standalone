# auth.py
import jwt
from datetime import datetime, timezone
from functools import wraps
from flask import request, jsonify, current_app
from bson.objectid import ObjectId


def generate_token(user_id: str, user_type: str = "") -> str:
    """
    Generate a JWT for the given user.

    Mobile clients send  X-Client-Type: mobile  — they receive a 90-day
    token so users are never unexpectedly logged out on their phone.
    Web clients (or anything else) receive the standard 24-hour token.
    """
    client_type = request.headers.get("X-Client-Type", "web").lower()
    is_mobile   = client_type == "mobile"

    expiry = current_app.config.get(
        "MOBILE_TOKEN_EXPIRY" if is_mobile else "TOKEN_EXPIRY"
    )

    payload = {
        "user_id":   str(user_id),
        "user_type": user_type,
        "exp":       datetime.now(timezone.utc) + expiry,
        "mobile":    is_mobile,
    }

    return jwt.encode(payload, current_app.config["SECRET_KEY"], algorithm="HS256")


def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        logger = current_app.logger

        # CRITICAL FIX: Skip authentication for OPTIONS requests (CORS preflight)
        if request.method == 'OPTIONS':
            return jsonify({'status': 'ok'}), 200

        # Get token from header
        auth_header = request.headers.get('Authorization')

        if not auth_header:
            logger.warning("No Authorization header present")
            return jsonify({'message': 'Token is missing!'}), 401

        try:
            # Extract token from "Bearer <token>"
            token = auth_header.split(" ")[1] if len(auth_header.split(" ")) > 1 else auth_header

            # Decode token
            data = jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])

            # Get user from database
            current_user = current_app.mongo.db.users.find_one(
                {"_id": ObjectId(data['user_id'])}
            )

            if not current_user:
                logger.warning(f"User not found for ID: {data['user_id']}")
                return jsonify({'message': 'User not found!'}), 401

        except jwt.ExpiredSignatureError:
            logger.warning("Token has expired")
            return jsonify({'message': 'Token has expired!'}), 401
        except jwt.InvalidTokenError as e:
            logger.warning(f"Invalid token: {str(e)}")
            return jsonify({'message': 'Invalid token!'}), 401
        except Exception as e:
            logger.error(f"Token validation error: {str(e)}")
            return jsonify({'message': 'Token validation failed!'}), 401

        return f(current_user, *args, **kwargs)

    return decorated