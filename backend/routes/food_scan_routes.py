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
        # Check for an actual uploaded file — NOT just the Content-Type header.
        # Expo Web / axios can send "multipart/form-data" as the Content-Type
        # even for a plain JSON body (e.g. when a custom transformRequest is
        # active), which would cause the old header-only check to enter this
        # branch and fail with "No image file provided" → 400.
        if request.content_type and "multipart/form-data" in request.content_type and "image" in request.files:
            file = request.files["image"]
            mime_type = file.content_type or "image/jpeg"
            image_bytes = file.read()
            user_note = request.form.get("user_note")

        # ── Branch B: JSON with base64 payload ────────────────────────────────
        else:
            # Use force=True so Flask parses the body as JSON regardless of the
            # exact Content-Type string.  Expo Web / axios on browsers may send
            # "application/json; charset=utf-8" or similar variants that make
            # request.is_json return False even though the body is valid JSON.
            data = request.get_json(force=True, silent=True)
            if not data:
                ct = request.content_type or "(no content-type)"
                logger.warning(
                    f"Food scan: could not parse request body as JSON "
                    f"(Content-Type: {ct}, body length: {request.content_length})"
                )
                return jsonify({
                    "error": (
                        "Request body could not be parsed. "
                        "Send multipart/form-data with an 'image' file field, "
                        "or application/json with 'image_base64' and 'mime_type'."
                    )
                }), 400

            b64 = data.get("image_base64")
            if not b64:
                return jsonify({"error": "Missing 'image_base64' in JSON body"}), 400

            mime_type = data.get("mime_type", "image/jpeg")
            user_note = data.get("user_note")

            try:
                image_bytes = base64.b64decode(b64)
            except Exception:
                return jsonify({"error": "Invalid base64 encoding in 'image_base64'"}), 400

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
        logger.error(f"Food scan Gemini API error: {error_msg}")
        return jsonify({"error": f"AI analysis failed: {error_msg}"}), 500

    except Exception as exc:
        error_msg = str(exc)
        logger.exception(f"Unexpected food scan error: {error_msg}")
        return jsonify({"error": f"Internal server error: {error_msg}"}), 500


@food_scan_routes.route("/api/food/scan/test", methods=["GET"])
def test_scan_connection():
    """
    Connectivity test — verifies GEMINI_API_KEY is set and working.
    No auth required — safe to hit directly in a browser.
    """
    import os
    from google import genai as _genai
    from google.genai import types as _types
    try:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return jsonify({"status": "error", "detail": "GEMINI_API_KEY is not set in environment"}), 500
        client = _genai.Client(api_key=api_key)
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[_types.Part.from_text(text="ping - reply with one word: ok")],
        )
        return jsonify({"status": "ok", "model": "gemini-2.5-flash", "response": resp.text.strip()}), 200
    except Exception as exc:
        return jsonify({"status": "error", "detail": str(exc)}), 500