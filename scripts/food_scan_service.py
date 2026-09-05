"""
food_scan_service.py
============================================================================
Claude Vision-powered food scanning service for DiaTwin.

Uses Anthropic's claude-opus-4-5 (vision) to:
  1. Identify foods in an image (including Egyptian & German dishes)
  2. Estimate portion sizes
  3. Fuzzy-match detections against FOOD_CATEGORIES from food_data.py
     → if matched: use your own verified nutrition DB
     → if unmatched: fall back to Claude's own nutrition estimate

All results are shaped to match the existing FoodItem / FoodDetails types
used throughout the mobile app and food_routes.py.

Author: DiaTwin Team
============================================================================
"""

import base64
import json
import logging
import re
from typing import Optional
import anthropic
from models.food_data import FOOD_CATEGORIES

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Anthropic client — picks up ANTHROPIC_API_KEY from environment automatically
# ---------------------------------------------------------------------------
_anthropic_client = anthropic.Anthropic()

# ---------------------------------------------------------------------------
# Supported MIME types
# ---------------------------------------------------------------------------
SUPPORTED_MIME_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# ---------------------------------------------------------------------------
# System prompt — gives Claude full context about your food database and
# the exact JSON schema it must return.
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """You are a clinical nutrition AI assistant for a diabetes management app called DiaTwin,
used by patients in Egypt and Germany.

Your task is to analyze food images and identify every food item visible,
then estimate portion sizes and nutritional content.

## Food database context
The app has a built-in database covering:
- Egyptian dishes: كشري (koshari), ملوخية (molokhia), فول مدمس (ful medames),
  طعمية (ta'amiya/falafel), كباب, كفتة, محشي, بامية, رز بلبن, أم علي, بسبوسة,
  كنافة, and many more
- German dishes: Schnitzel, Bratwurst, Kartoffelsalat, Sauerkraut, Döner,
  Leberkäse, Brezel, Käsespätzle, Rouladen, etc.
- International dishes, starches, vegetables, fruits, dairy, snacks, beverages

## Instructions
1. Identify ALL distinct food items visible in the image
2. For each item provide your best portion estimate in grams or ml
3. Estimate carbs, protein, fat per identified portion
4. Set absorption_type based on glycemic speed:
   - "fast": white rice, bread, sugary foods, fruits, white potatoes
   - "medium": mixed meals, legumes, pasta, most cooked dishes
   - "slow": high-fat/protein meals, nuts, dairy, low-GI foods
5. Set confidence 0.0–1.0 per item (lower if obscured or ambiguous)
6. If you cannot identify an item at all, skip it

## Output format — return ONLY valid JSON, no markdown, no preamble:
{
  "detected_items": [
    {
      "name": "food name in English",
      "name_ar": "Arabic name if applicable (optional)",
      "name_de": "German name if applicable (optional)",
      "estimated_grams": 200,
      "carbs": 45.0,
      "protein": 8.0,
      "fat": 3.0,
      "fiber": 2.0,
      "absorption_type": "medium",
      "confidence": 0.85,
      "notes": "optional clarification"
    }
  ],
  "scene_description": "brief description of the overall meal",
  "overall_confidence": 0.80
}"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scan_food_image(
    image_data: bytes,
    mime_type: str,
    user_note: Optional[str] = None,
) -> dict:
    """
    Analyse a food image with Claude and return structured nutrition data.

    The result is matched against FOOD_CATEGORIES so that verified DB
    nutrition values take precedence over Claude's estimates wherever possible.

    Args:
        image_data:  Raw image bytes (JPEG / PNG / GIF / WEBP)
        mime_type:   One of the SUPPORTED_MIME_TYPES
        user_note:   Optional free-text hint from the user ("this is koshari")

    Returns:
        {
            "items": [ <FoodItem-shaped dicts> ],
            "scene_description": str,
            "overall_confidence": float,
            "db_matched": int,   # how many items were matched to your DB
            "llm_estimated": int # how many relied on Claude's own estimates
        }

    Raises:
        ValueError  – unsupported MIME type or Claude returned unparseable JSON
        RuntimeError – Anthropic API error
    """
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise ValueError(
            f"Unsupported image type '{mime_type}'. "
            f"Allowed: {', '.join(SUPPORTED_MIME_TYPES)}"
        )

    # 1. Build the user message
    user_content = []

    # Attach the image
    user_content.append({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": mime_type,
            "data": base64.b64encode(image_data).decode("utf-8"),
        },
    })

    # Add a text prompt (optionally include user's hint)
    prompt_text = (
        "Please analyse this food image and return the JSON as specified."
    )
    if user_note:
        prompt_text += f"\n\nUser note: {user_note}"

    user_content.append({"type": "text", "text": prompt_text})

    # 2. Call Claude
    try:
        response = _anthropic_client.messages.create(
            model="claude-sonnet-4-6",        # vision-capable model
            max_tokens=1500,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
        )
    except anthropic.APIError as exc:
        logger.error(f"Anthropic API error during food scan: {exc}")
        raise RuntimeError(f"Claude API error: {exc}") from exc

    # 3. Parse Claude's JSON response
    raw_text = response.content[0].text.strip()
    claude_result = _parse_claude_json(raw_text)

    # 4. Match against your food database and build final items
    items, db_matched, llm_estimated = _match_and_build_items(
        claude_result.get("detected_items", [])
    )

    return {
        "items": items,
        "scene_description": claude_result.get("scene_description", ""),
        "overall_confidence": claude_result.get("overall_confidence", 0.0),
        "db_matched": db_matched,
        "llm_estimated": llm_estimated,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_claude_json(raw_text: str) -> dict:
    """Strip any accidental markdown fences and parse JSON."""
    # Remove ```json ... ``` wrappers if Claude added them despite instructions
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.MULTILINE)
    cleaned = re.sub(r"\s*```$", "", cleaned, flags=re.MULTILINE).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.error(f"Claude returned non-JSON response: {raw_text[:300]}")
        raise ValueError(f"Claude returned unparseable response: {exc}") from exc


def _match_and_build_items(detected_items: list) -> tuple[list, int, int]:
    """
    For each detected item try to find it in FOOD_CATEGORIES.
    If found → use DB nutrition (more accurate for T1D dosing).
    If not   → use Claude's own estimate as fallback.

    Returns:
        (items_list, db_matched_count, llm_estimated_count)
    """
    items = []
    db_matched = 0
    llm_estimated = 0

    for detection in detected_items:
        detected_name: str = detection.get("name", "").strip()
        estimated_grams: float = float(detection.get("estimated_grams", 100))
        confidence: float = float(detection.get("confidence", 0.5))

        # --- Try fuzzy DB match ---
        db_match = _fuzzy_match_food(detected_name)

        if db_match:
            category, db_name, db_details = db_match
            serving = db_details.get("serving_size", {"amount": 100, "unit": "g"})
            ratio = estimated_grams / max(serving.get("amount", 100), 1)

            item = {
                "name": db_name,
                "category": category,
                "details": {
                    "carbs":           round(db_details.get("carbs", 0) * ratio, 1),
                    "protein":         round(db_details.get("protein", 0) * ratio, 1),
                    "fat":             round(db_details.get("fat", 0) * ratio, 1),
                    "fiber":           round(db_details.get("fiber", 0) * ratio, 1),
                    "absorption_type": db_details.get("absorption_type", "medium"),
                    "serving_size": {
                        "amount": estimated_grams,
                        "unit":   "g",
                    },
                },
                "scan_meta": {
                    "source":           "database",
                    "detected_name":    detected_name,
                    "confidence":       confidence,
                    "estimated_grams":  estimated_grams,
                    "notes":            detection.get("notes", ""),
                    "name_ar":          detection.get("name_ar"),
                    "name_de":          detection.get("name_de"),
                },
            }
            db_matched += 1

        else:
            # Fall back to Claude's own nutrition estimate
            item = {
                "name":     detected_name,
                "category": "scanned",
                "details": {
                    "carbs":           round(float(detection.get("carbs", 0)), 1),
                    "protein":         round(float(detection.get("protein", 0)), 1),
                    "fat":             round(float(detection.get("fat", 0)), 1),
                    "fiber":           round(float(detection.get("fiber", 0)), 1),
                    "absorption_type": detection.get("absorption_type", "medium"),
                    "serving_size": {
                        "amount": estimated_grams,
                        "unit":   "g",
                    },
                },
                "scan_meta": {
                    "source":          "llm_estimate",
                    "detected_name":   detected_name,
                    "confidence":      confidence,
                    "estimated_grams": estimated_grams,
                    "notes":           detection.get("notes", ""),
                    "name_ar":         detection.get("name_ar"),
                    "name_de":         detection.get("name_de"),
                },
            }
            llm_estimated += 1

        items.append(item)

    return items, db_matched, llm_estimated


def _fuzzy_match_food(query: str) -> Optional[tuple]:
    """
    Case-insensitive substring match against all food names in FOOD_CATEGORIES.

    Tries exact match first, then substring in both directions so that
    "koshari" matches "Koshari (كشري)" and vice versa.

    Returns (category_key, food_name, food_details) or None.
    """
    query_lower = query.lower()

    # Pass 1 — exact match
    for category, foods in FOOD_CATEGORIES.items():
        for food_name, details in foods.items():
            if query_lower == food_name.lower():
                return category, food_name, details

    # Pass 2 — substring match (query in food_name OR food_name in query)
    for category, foods in FOOD_CATEGORIES.items():
        for food_name, details in foods.items():
            food_lower = food_name.lower()
            if query_lower in food_lower or food_lower in query_lower:
                return category, food_name, details

    return None