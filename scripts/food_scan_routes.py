"""
food_scan_routes.py
============================================================================
Flask Blueprint for the Claude Vision food-scanning endpoint.

Endpoint:
    POST /api/food/scan

Accepts:
    - multipart/form-data  with field "image" (file upload)   — from camera
    - application/json     with field "image_base64" + "mime_type" — from gallery

Both paths forward to food_scan_service.scan_food_image() and return
FoodItem-shaped JSON ready to be consumed by the mobile MealForm.

Author: DiaTwin Team
============================================================================
"""

import base64
import logging
from flask import Blueprint, request, jsonify
from utils.auth import token_required
from services.food_scan_service import scan_food_image, SUPPORTED_MIME_TYPES

logger = logging.getLogger(__name__)

food_scan_routes = Blueprint("food_scan_routes", __name__)

# Max image size: 5 MB (Anthropic's limit for base64 images in a message)
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@food_scan_routes.route("/api/food/scan", methods=["POST"])
@token_required
def scan_food(current_user):
    """
    Analyse a food photo with Claude Vision and return structured food items.

    ── Multipart upload (camera / gallery file picker) ─────────────────────
    Content-Type: multipart/form-data
    Fields:
        image        (file)    Required. JPEG / PNG / WEBP / GIF
        user_note    (string)  Optional. Free-text hint ("this is koshari")

    ── JSON with base64 payload ─────────────────────────────────────────────
    Content-Type: application/json
    Body:
        {
            "image_base64": "<base64 string>",
            "mime_type":    "image/jpeg",
            "user_note":    "optional hint"
        }

    ── Success response 200 ─────────────────────────────────────────────────
    {
        "items": [
            {
                "name": "Koshari",
                "category": "egyptian",
                "details": {
                    "carbs": 68.0,
                    "protein": 12.0,
                    "fat": 5.0,
                    "fiber": 4.0,
                    "absorption_type": "medium",
                    "serving_size": { "amount": 300, "unit": "g" }
                },
                "scan_meta": {
                    "source": "database",
                    "detected_name": "koshari",
                    "confidence": 0.92,
                    "estimated_grams": 300,
                    "notes": "",
                    "name_ar": "كشري",
                    "name_de": null
                }
            }
        ],
        "scene_description": "A plate of Egyptian koshari with tomato sauce",
        "overall_confidence": 0.88,
        "db_matched": 1,
        "llm_estimated": 0
    }

    ── Error responses ───────────────────────────────────────────────────────
    400  Missing / invalid image
    413  Image too large (> 5 MB)
    415  Unsupported MIME type
    500  Internal / Claude API error
    """
    try:
        image_bytes: bytes | None = None
        mime_type: str | None = None
        user_note: str | None = None

        # ── Branch A: multipart file upload ──────────────────────────────────
        if request.content_type and "multipart/form-data" in request.content_type:
            if "image" not in request.files:
                return jsonify({"error": "No image file provided"}), 400

            file = request.files["image"]
            mime_type = file.content_type or "image/jpeg"
            image_bytes = file.read()
            user_note = request.form.get("user_note")

        # ── Branch B: JSON with base64 payload ────────────────────────────────
        elif request.is_json:
            data = request.get_json(silent=True) or {}
            b64 = data.get("image_base64")
            if not b64:
                return jsonify({"error": "Missing 'image_base64' in request body"}), 400

            mime_type = data.get("mime_type", "image/jpeg")
            user_note = data.get("user_note")

            try:
                image_bytes = base64.b64decode(b64)
            except Exception:
                return jsonify({"error": "Invalid base64 encoding"}), 400

        else:
            return jsonify({
                "error": "Request must be multipart/form-data or application/json"
            }), 400

        # ── Validate ──────────────────────────────────────────────────────────
        if not image_bytes:
            return jsonify({"error": "Empty image data"}), 400

        if len(image_bytes) > MAX_IMAGE_BYTES:
            return jsonify({
                "error": f"Image too large ({len(image_bytes) // 1024} KB). Max 5 MB."
            }), 413

        if mime_type not in SUPPORTED_MIME_TYPES:
            return jsonify({
                "error": f"Unsupported image type '{mime_type}'. "
                         f"Allowed: {', '.join(SUPPORTED_MIME_TYPES)}"
            }), 415

        # ── Call the Claude-powered service ───────────────────────────────────
        logger.info(
            f"Food scan requested by user {current_user['_id']} | "
            f"mime={mime_type} | size={len(image_bytes)} bytes"
        )

        result = scan_food_image(
            image_data=image_bytes,
            mime_type=mime_type,
            user_note=user_note,
        )

        logger.info(
            f"Food scan complete | "
            f"items={len(result['items'])} | "
            f"db_matched={result['db_matched']} | "
            f"llm_estimated={result['llm_estimated']}"
        )

        return jsonify(result), 200

    except ValueError as exc:
        logger.warning(f"Food scan validation error: {exc}")
        return jsonify({"error": str(exc)}), 400

    except RuntimeError as exc:
        error_msg = str(exc)
        logger.error(f"Food scan Claude API error: {error_msg}")
        return jsonify({"error": f"AI analysis failed: {error_msg}"}), 500

    except Exception as exc:
        error_msg = str(exc)
        logger.exception(f"Unexpected food scan error: {error_msg}")
        return jsonify({"error": f"Internal server error: {error_msg}"}), 500


@food_scan_routes.route("/api/food/scan/test", methods=["GET"])
@token_required
def test_scan_connection(current_user):
    """
    Connectivity test — verifies Anthropic API key and network without sending
    an image. Hit GET /api/food/scan/test to diagnose 500s on the scan endpoint.
    """
    import anthropic as _anthropic
    try:
        client = _anthropic.Anthropic()
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=10,
            messages=[{"role": "user", "content": "ping"}],
        )
        return jsonify({
            "status": "ok",
            "model": "claude-sonnet-4-6",
            "response": resp.content[0].text,
        }), 200
    except Exception as exc:
        return jsonify({"status": "error", "detail": str(exc)}), 500