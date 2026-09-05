from flask import Flask
from flask_cors import CORS
import logging
from config import mongo, logger

def create_app(config_name=None):
    """
    Application factory function that creates and configures the Flask app
    """
    import os

    # Initialize Flask app
    app = Flask(__name__)

    # Configure logging
    logging.basicConfig(level=logging.INFO)
    app.logger = logging.getLogger(__name__)
    logging.getLogger('pymongo').setLevel(logging.WARNING)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    logging.getLogger('mongodb').setLevel(logging.WARNING)

    # Load configuration from environment variables
    if config_name == 'testing':
        app.config.from_object('config.TestingConfig')
    else:
        app.config.update(
            MONGO_URI=os.environ.get('MONGO_URI'),
            SECRET_KEY=os.environ.get('SECRET_KEY'),
            APP_TIMEZONE='UTC',
            TOKEN_EXPIRY=24,
            ALLOWED_ORIGINS=[
                "http://localhost:3000",
                "http://localhost:8081",
                "https://native-3y3j.onrender.com",
            ]
        )

    # Configure CORS
    CORS(app, resources={r"/*": {"origins": app.config['ALLOWED_ORIGINS']}})

    # Initialize MongoDB
    app.mongo = mongo

    return app