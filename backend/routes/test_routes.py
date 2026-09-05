from flask import Blueprint, jsonify

test_routes = Blueprint('test_routes', __name__)

@test_routes.route('/test', methods=['GET'])
def test_route():
    return jsonify({"message": "Backend is running"}), 200