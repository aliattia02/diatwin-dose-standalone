from routes.auth_routes import auth_routes
from routes.doctor_routes import doctor_routes
from routes.food_routes import food_routes
from routes.test_routes import test_routes

# Export all route blueprints
__all__ = [
    'auth_routes',
    'doctor_routes',
    'food_routes',
    'test_routes'
]