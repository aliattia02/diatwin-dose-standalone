# main.py
# Updated to include:
#   - LibreLinkUp CGM integration (libre_bp) + background auto-sync scheduler
#   - Google Fit Watch HR integration (watch_sync_bp) + background sync scheduler
#   - Dev-only test data injection (watch_test_bp) — local only, blocked on Render
#   - FHIR R4 export + GDPR erasure (fhir_bp)
# Both schedulers also act as Render free-tier keep-alive pings.

from flask import Flask, request, jsonify
import logging
import os
from config import create_app_config, mongo
from constants import Constants


def create_app():
    app = Flask(__name__)

    app.logger.setLevel(logging.INFO)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    logging.getLogger('pymongo').setLevel(logging.WARNING)

    app, _, logger = create_app_config(app)

    constants = Constants()
    app.constants = constants

    if not os.environ.get('RENDER'):
        Constants.export_all_constants_safe()

    @app.route('/api/health', methods=['GET', 'HEAD'])
    def health_check():
        response = jsonify({"status": "ok"})
        response.headers['Cache-Control'] = 'no-store'
        return response, 200

    @app.errorhandler(404)
    def not_found(error):
        return jsonify({"error": "Resource not found"}), 404

    @app.errorhandler(500)
    def internal_error(error):
        logger.error(f"Internal server error: {str(error)}")
        return jsonify({"error": "Internal server error"}), 500

    @app.route('/api/v1/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    def api_v1_proxy(path):
        """Proxy /api/v1/* requests to /api/* for mobile app compatibility"""
        from werkzeug.exceptions import NotFound
        legacy_path = f'/api/{path}'
        adapter = app.url_map.bind('')
        try:
            endpoint, values = adapter.match(legacy_path, method=request.method)
            view_func = app.view_functions[endpoint]
            return view_func(**values)
        except NotFound:
            return jsonify({"error": "Resource not found"}), 404
        except Exception as e:
            logger.error(f"Error in API v1 proxy: {str(e)}")
            return jsonify({"error": "Internal server error"}), 500

    try:
        from routes.food_routes import food_routes
        from routes.auth_routes import auth_routes
        from routes.doctor_routes import doctor_routes
        from routes.patient_routes import patient_routes
        from routes.test_routes import test_routes
        from meal_insulin import meal_insulin_bp
        from activity import activity_bp
        from blood_sugar import blood_sugar_bp
        from routes.medication_routes import medication_routes
        from routes.meal_routes import meal_bp
        from routes.import_routes import import_routes
        from routes.cumulative_effects_routes import cumulative_bp
        from routes.activity_pharmacodynamics_routes import activity_pd_bp
        from routes.libre_routes import libre_bp
        from routes.food_scan_routes import food_scan_routes as food_scan_bp
        from routes.watch_hr_routes import watch_hr_bp
        from routes.watch_sync_routes import watch_sync_bp
        from routes.fhir_routes import fhir_bp          # ← ADDED

        blueprints = [
            (food_routes,      ''),
            (auth_routes,      ''),
            (doctor_routes,    ''),
            (patient_routes,   ''),
            (test_routes,      ''),
            (meal_insulin_bp,  ''),
            (activity_bp,      ''),
            (blood_sugar_bp,   ''),
            (medication_routes,''),
            (import_routes,    ''),
            (meal_bp,          ''),
            (cumulative_bp,    ''),
            (activity_pd_bp,   ''),
            (libre_bp,         ''),
            (food_scan_bp,     ''),
            (watch_hr_bp,      ''),
            (watch_sync_bp,    ''),
            (fhir_bp,          ''),                      # ← ADDED
        ]

        for blueprint, url_prefix in blueprints:
            app.register_blueprint(blueprint, url_prefix=url_prefix)
            logger.info(f"Registered blueprint: {blueprint.name}")

    except Exception as e:
        logger.error(f"Error registering blueprints: {str(e)}")
        raise

    if not os.environ.get('RENDER'):
        try:
            from routes.watch_test_routes import watch_test_bp
            app.register_blueprint(watch_test_bp, url_prefix='')
            logger.info("Registered blueprint: watch_test (dev only)")
        except Exception as e:
            logger.warning(f"watch_test_bp not loaded (non-fatal): {e}")

    try:
        from libre_scheduler import start_libre_scheduler
        start_libre_scheduler(app)
    except Exception as e:
        logger.error(f"Failed to start Libre scheduler: {e}")

    try:
        from watch_scheduler import start_watch_scheduler
        start_watch_scheduler(app)
    except Exception as e:
        logger.error(f"Failed to start Watch scheduler: {e}")

    return app


app = create_app()

if __name__ == '__main__':
    app.logger.info("Starting Flask application...")
    app.run(debug=False, host='0.0.0.0', port=5000)