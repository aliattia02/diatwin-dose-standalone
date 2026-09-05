# utils/error_handler.py
from functools import wraps
from flask import jsonify
import logging

logger = logging.getLogger(__name__)

def api_error_handler(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except Exception as e:
            logger.error(f"API Error: {str(e)}")
            return jsonify({'error': 'An unexpected error occurred'}), 500
    return decorated