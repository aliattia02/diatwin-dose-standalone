"""
food_routes.py
Location: backend/routes/food_routes.py

FIXES vs original
─────────────────
FIX #1 – Query parameter name mismatch (root cause of the N-fan-out)
  Before: search_food_api read request.args.get('q', '').
          The mobile frontend sends ?query=... (see food.ts → searchFoods).
          Because 'q' was always empty, the backend ignored the query text
          and returned all items from the default 'basic' category — so the
          frontend worked around it by firing one request per category (16×).

  After:  Reads 'query' first, falls back to 'q' for any legacy callers:
            (request.args.get('query') or request.args.get('q', '')).lower()
          Now a single request with ?query=chicken finds results across all
          categories correctly, making the frontend fan-out unnecessary.
"""

from flask import Blueprint, request, jsonify, current_app
from services.food_service import get_food_details, search_food
from utils.auth import token_required
from config import mongo
from datetime import datetime
from constants import Constants  # still used by get_nutritional_summary
from models.food_data import (
    FOOD_DATABASE, STARCH_LIST, STARCHY_VEGETABLES, PULSES,
    FRUITS, MILK_AND_DAIRY, SWEETS_AND_DESSERTS, SNACKS,
    COMMON_SNACKS, HIGH_PROTEIN_FOODS, HIGH_FAT_FOODS,
    EGYPTIAN_DISHES, INTERNATIONAL_DISHES, GERMAN_DISHES,
    SALADS_AND_CONDIMENTS, BEVERAGES
)

food_routes = Blueprint('food_routes', __name__)


@food_routes.route('/api/food/categories', methods=['GET'])
@token_required
def get_categories(current_user):
    try:
        # get_supported_measurements() is a @classmethod returning static data —
        # no patient-specific DB lookup needed. Use the already-initialised
        # app-level instance to avoid creating a new Constants object (and a
        # potential MongoDB round-trip) on every request.
        measurements_data = current_app.constants.get_supported_measurements()

        response = {
            'measurements': {
                'volume': measurements_data['volume'],
                'weight': measurements_data['weight']
            },
            'standard_portions': measurements_data['standard_portions'],
            'categories': {
                'basic': list(FOOD_DATABASE.keys()),
                'starch': list(STARCH_LIST.keys()),
                'starchy_vegetables': list(STARCHY_VEGETABLES.keys()),
                'pulses': list(PULSES.keys()),
                'fruits': list(FRUITS.keys()),
                'dairy': list(MILK_AND_DAIRY.keys()),
                'sweets': list(SWEETS_AND_DESSERTS.keys()),
                'snacks': list(SNACKS.keys()),
                'common_snacks': list(COMMON_SNACKS.keys()),
                'high_protein': list(HIGH_PROTEIN_FOODS.keys()),
                'high_fat': list(HIGH_FAT_FOODS.keys()),
                'egyptian': list(EGYPTIAN_DISHES.keys()),
                'international': list(INTERNATIONAL_DISHES.keys()),
                'german': list(GERMAN_DISHES.keys()),
                'salads_condiments': list(SALADS_AND_CONDIMENTS.keys()),
                'beverages': list(BEVERAGES.keys()),
                'custom': []  # Populated from database below
            }
        }

        # Add custom foods if available
        try:
            custom_foods = list(mongo.db.custom_foods.find(
                {'user_id': str(current_user['_id'])},
                {'name': 1, '_id': 0}
            ))
            response['categories']['custom'] = [food['name'] for food in custom_foods]
        except Exception as e:
            print(f"Error fetching custom foods: {str(e)}")
            # Continue without custom foods rather than failing the whole request

        return jsonify(response), 200

    except Exception as e:
        print(f"Error in get_categories: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@food_routes.route('/api/food/search', methods=['GET'])
@token_required
def search_food_api(current_user):
    # ── FIX #1: accept 'query' (frontend) with 'q' as legacy fallback ────────
    # The mobile frontend (food.ts → searchFoods) sends ?query=<text>.
    # The original code read ?q= so the query was always treated as empty,
    # which caused the frontend to work around it with 16 parallel per-category
    # requests. Fixing the param name here eliminates that fan-out entirely.
    query    = (request.args.get('query') or request.args.get('q', '')).lower()
    category = request.args.get('category') or None

    results = search_food(query, category)

    # Filter custom foods to the requesting user only
    user_id = str(current_user['_id'])
    filtered = []
    for r in results:
        if r.get('category') != 'custom':
            filtered.append(r)
            continue
        # Verify this custom food belongs to the current user
        try:
            owned = mongo.db.custom_foods.find_one({
                'name': r['name'],
                'user_id': user_id,
            })
            if owned:
                filtered.append(r)
        except Exception:
            pass  # Skip on DB error rather than exposing other users' foods

    return jsonify(filtered)


@food_routes.route('/api/food/custom', methods=['POST'])
@token_required
def add_custom_food(current_user):
    custom_foods = mongo.db.custom_foods
    data = request.json

    required_fields = ['name', 'serving_size', 'carbs', 'protein', 'fat']
    if not all(field in data for field in required_fields):
        return jsonify({'error': 'Missing required fields'}), 400

    food_data = {
        'user_id': str(current_user['_id']),
        'name': data['name'],
        'serving_size': {
            'amount':   float(data['serving_size']['amount']),
            'unit':     data['serving_size']['unit'],
            'w_amount': float(data['serving_size'].get('w_amount', data['serving_size']['amount'])),
            'w_unit':   data['serving_size'].get('w_unit', data['serving_size']['unit'])
        },
        'carbs':           float(data['carbs']),
        'protein':         float(data['protein']),
        'fat':             float(data['fat']),
        'description':     data.get('description', ''),
        'absorption_type': data.get('absorption_type', 'medium'),
        'created_at':      datetime.utcnow()
    }

    result = custom_foods.insert_one(food_data)
    return jsonify({'message': 'Custom food added successfully', 'id': str(result.inserted_id)}), 201


@food_routes.route('/api/food/custom', methods=['GET'])
@token_required
def get_custom_foods(current_user):
    custom_foods = list(mongo.db.custom_foods.find({'user_id': str(current_user['_id'])}))
    return jsonify([{
        'id':              str(food['_id']),
        'name':            food['name'],
        'serving_size':    food['serving_size'],
        'carbs':           food['carbs'],
        'protein':         food['protein'],
        'fat':             food['fat'],
        'description':     food.get('description', ''),
        'absorption_type': food.get('absorption_type', 'unknown')
    } for food in custom_foods])


@food_routes.route('/api/food/favorite', methods=['POST'])
@token_required
def add_favorite_food(current_user):
    data = request.json
    food_name = data.get('food_name')

    if not food_name:
        return jsonify({'error': 'Food name is required'}), 400

    mongo.db.favorite_foods.update_one(
        {'user_id': str(current_user['_id']), 'food_name': food_name},
        {'$set': {'food_name': food_name}},
        upsert=True
    )

    return jsonify({'message': 'Food added to favorites'}), 200


@food_routes.route('/api/food/favorite', methods=['GET'])
@token_required
def get_favorite_foods(current_user):
    favorites = list(mongo.db.favorite_foods.find({'user_id': str(current_user['_id'])}))
    favorite_foods = []

    for fav in favorites:
        food_details = get_food_details(fav['food_name'])
        if food_details:
            favorite_foods.append({
                'name':     fav['food_name'],
                'details':  food_details['details'],
                'category': food_details['category']
            })

    return jsonify(favorite_foods)


@food_routes.route('/api/food/favorite', methods=['DELETE'])
@token_required
def remove_favorite_food(current_user):
    data = request.json
    food_name = data.get('food_name') if data else None

    if not food_name:
        return jsonify({'error': 'Food name is required'}), 400

    mongo.db.favorite_foods.delete_one({
        'user_id':   str(current_user['_id']),
        'food_name': food_name
    })

    return jsonify({'message': 'Food removed from favorites'}), 200


@food_routes.route('/api/food/measurements', methods=['GET'])
@token_required
def get_measurements(current_user):
    """Get all supported measurement types and standard portions."""
    try:
        measurements = current_app.constants.get_supported_measurements()

        return jsonify({
            "volume":           measurements["volume"],
            "weight":           measurements["weight"],
            "standard_portions": measurements["standard_portions"]
        }), 200

    except Exception as e:
        print(f"Error in get_measurements: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@food_routes.route('/api/food/nutritional-summary', methods=['POST'])
@token_required
def get_nutritional_summary(current_user):
    data = request.json
    meal_items = data.get('meal_items', [])

    if not meal_items:
        return jsonify({'error': 'No meal items provided'}), 400

    # Initialize Constants with patient_id for patient-specific settings
    patient_constants = Constants(str(current_user['_id']))
    total_carbs   = 0
    total_protein = 0
    total_fat     = 0

    for item in meal_items:
        if not all(k in item for k in ['name', 'portion', 'measurement']):
            return jsonify({'error': f'Invalid meal item format: {item}'}), 400

        food_details = get_food_details(item['name'])
        if not food_details:
            continue

        converted_amount = patient_constants.convert_to_standard(
            item['portion'],
            item['measurement']
        )

        if converted_amount is not None:
            ratio = converted_amount / food_details['details']['serving_size']['amount']
            total_carbs   += food_details['details']['carbs']   * ratio
            total_protein += food_details['details']['protein'] * ratio
            total_fat     += food_details['details']['fat']     * ratio

    return jsonify({
        'total_carbs':    round(total_carbs,   1),
        'total_protein':  round(total_protein, 1),
        'total_fat':      round(total_fat,     1),
        'total_calories': round((total_carbs * 4) + (total_protein * 4) + (total_fat * 9), 1)
    })