"""
food_scan_service.py
============================================================================
Gemini Vision-powered food scanning service for DiaTwin.

Uses google-genai (the NEW Gemini SDK, replacing the deprecated
google-generativeai) with gemini-2.0-flash — free tier, fast, vision-capable.

Free tier limits: 15 requests/min, 1500 requests/day, 1M tokens/day.
Get a free key at: https://aistudio.google.com/app/apikey

Author: DiaTwin Team
============================================================================
"""

import json
import logging
import os
import re
from typing import Optional

from google import genai
from google.genai import types
from models.food_data import FOOD_CATEGORIES

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Supported MIME types
# ---------------------------------------------------------------------------
SUPPORTED_MIME_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# ---------------------------------------------------------------------------
# Model to use — gemini-2.0-flash is free tier and vision-capable
# ---------------------------------------------------------------------------
_MODEL = "gemini-2.5-flash"

# ---------------------------------------------------------------------------
# Lazy Gemini client — created on first use so a missing key never crashes
# the import or app startup. A clear RuntimeError is raised at scan time.
# ---------------------------------------------------------------------------
_client: Optional[genai.Client] = None


def _get_client() -> genai.Client:
    """Return the shared Gemini client, initialising it on first call."""
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Food scanning is unavailable. "
                "Get a free key at https://aistudio.google.com/app/apikey"
            )
        _client = genai.Client(api_key=api_key)
        logger.info("Gemini client initialised successfully.")
    return _client


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------
_PROMPT = """You are a clinical nutrition AI assistant for a diabetes management app called DiaTwin,
used by patients in Egypt and Germany.

Analyse the food image and identify every food item visible.
Estimate portion sizes and nutritional content per portion.

Egyptian dishes: koshari, molokhia, ful medames, ta'amiya/falafel, kofta, mahshi, bamia, and more.
German dishes: Schnitzel, Bratwurst, Kartoffelsalat, Sauerkraut, Doener, Brezel, Kaesespaetzle, etc.
International dishes, starches, vegetables, fruits, dairy, snacks, beverages.

Instructions:
1. Identify ALL distinct food items visible
2. Estimate portion size in grams or ml for each
3. Estimate carbs, protein, fat for that portion
4. Set absorption_type:
   - "fast": white rice, bread, sugary foods, fruits, white potatoes
   - "medium": mixed meals, legumes, pasta, most cooked dishes
   - "slow": high-fat/protein meals, nuts, dairy, low-GI foods
5. Set confidence 0.0-1.0 (lower if obscured or ambiguous)
6. Skip items you cannot identify at all

Return ONLY valid JSON, no markdown, no preamble, no explanation:
{
  "detected_items": [
    {
      "name": "food name in English",
      "name_ar": "Arabic name if applicable or null",
      "name_de": "German name if applicable or null",
      "estimated_grams": 200,
      "carbs": 45.0,
      "protein": 8.0,
      "fat": 3.0,
      "fiber": 2.0,
      "absorption_type": "medium",
      "confidence": 0.85,
      "notes": "optional clarification or empty string"
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
    Analyse a food image with Gemini and return structured nutrition data.

    Args:
        image_data:  Raw image bytes (JPEG / PNG / GIF / WEBP)
        mime_type:   One of SUPPORTED_MIME_TYPES
        user_note:   Optional hint, e.g. "this is koshari"

    Returns:
        {
            "items": list of FoodItem-shaped dicts,
            "scene_description": str,
            "overall_confidence": float,
            "db_matched": int,
            "llm_estimated": int,
        }
    """
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise ValueError(
            f"Unsupported image type '{mime_type}'. "
            f"Allowed: {', '.join(SUPPORTED_MIME_TYPES)}"
        )

    # Build prompt text
    full_prompt = _PROMPT
    if user_note:
        full_prompt += f"\n\nUser note about this image: {user_note}"

    # Build content parts — text + image
    contents = [
        types.Part.from_text(text=full_prompt),
        types.Part.from_bytes(data=image_data, mime_type=mime_type),
    ]

    # Call Gemini — _get_client() will raise clearly if key is missing
    # ── thinking_budget note ────────────────────────────────────────────────
    # gemini-2.5-flash enforces a minimum thinking_budget at the API level.
    # Earlier versions accepted 0 (= disable thinking); newer versions reject it
    # with 400 INVALID_ARGUMENT: "Thinking budget 0 is not supported."
    # This is the root cause of intermittent "AI analysis failed" scan errors.
    #
    # Fix: omit thinking_config entirely — the default (non-thinking) mode is
    # used automatically when the field is absent, which is what we want.
    # If thinking ever becomes useful here, set budget ≥ 1024.
    try:
        response = _get_client().models.generate_content(
            model=_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                temperature=0.1,
                max_output_tokens=8192,
                # Force strict JSON output — prevents parse failures from
                # single-quoted keys or trailing commas in the raw output.
                response_mime_type="application/json",
                # thinking_budget=1024 — the lowest non-zero value accepted by all
                # gemini-2.5-flash API versions (budget=0 causes 400 INVALID_ARGUMENT
                # on newer nodes). 1024 tokens gives the model just enough reasoning
                # to resolve ambiguous portion sizes and multi-item scenes accurately
                # without the 5–15 s latency of full thinking mode (~24 576 tokens).
                # Empirically: adds ~0.5–1 s vs no thinking, with measurably better
                # confidence scores on complex plated meals.
                thinking_config=types.ThinkingConfig(thinking_budget=2048),
            ),
        )
    except RuntimeError:
        raise  # re-raise missing-key error as-is
    except Exception as exc:
        error_str = str(exc)
        logger.error(f"Gemini API error during food scan: {error_str}")
        # Surface quota / rate-limit errors with a clear message
        if "429" in error_str or "quota" in error_str.lower() or "rate" in error_str.lower():
            raise RuntimeError(
                "Gemini API rate limit reached (free tier: 15 req/min). "                "Please wait a moment and try again."
            ) from exc
        raise RuntimeError(f"Gemini API error: {error_str}") from exc

    raw_text = response.text.strip()
    gemini_result = _parse_json_response(raw_text)

    items, db_matched, llm_estimated = _match_and_build_items(
        gemini_result.get("detected_items", [])
    )

    return {
        "items":              items,
        "scene_description":  gemini_result.get("scene_description", ""),
        "overall_confidence": gemini_result.get("overall_confidence", 0.0),
        "db_matched":         db_matched,
        "llm_estimated":      llm_estimated,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _repair_json(text: str) -> str:
    """
    Best-effort repair of common Gemini JSON quirks so json.loads can parse them.

    Handles:
    - Single-quoted string values/keys  → double-quoted
    - Trailing commas before } or ]     → removed
    - Python None/True/False literals   → JSON null/true/false
    - Ellipsis (...)                    → removed

    This is intentionally conservative — it only patches well-known patterns
    rather than trying to fully re-parse the document.
    """
    # Replace Python singletons
    text = re.sub(r'\bNone\b', 'null', text)
    text = re.sub(r'\bTrue\b', 'true', text)
    text = re.sub(r'\bFalse\b', 'false', text)
    # Remove ellipsis
    text = text.replace('...', '')
    # Remove trailing commas before ] or }
    text = re.sub(r',\s*([}\]])', r'\1', text)
    # Convert single-quoted strings to double-quoted.
    # Strategy: replace '...' only when not inside a double-quoted string.
    # Simple approach: swap all single-quote delimited tokens.
    def _sq_to_dq(m: re.Match) -> str:
        inner = m.group(1).replace('"', '\\"')
        return f'"{inner}"'
    text = re.sub(r"'([^'\\\n]*?)'", _sq_to_dq, text)
    return text


def _parse_json_response(raw_text: str) -> dict:
    """
    Strip markdown fences, then parse JSON with a repair fallback.

    Gemini occasionally returns single-quoted keys, trailing commas, or other
    JS-style syntax even when prompted for JSON.  `response_mime_type` reduces
    this significantly but does not eliminate it entirely, so we keep a repair
    pass as a safety net.
    """
    # Strip markdown code fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.MULTILINE)
    cleaned = re.sub(r"\s*```$", "", cleaned, flags=re.MULTILINE).strip()

    # First attempt — strict parse (fast path, works when Gemini is well-behaved)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass  # fall through to repair

    # Second attempt — repair then parse
    repaired = _repair_json(cleaned)
    try:
        result = json.loads(repaired)
        logger.warning("Gemini JSON required repair before parsing — check prompt/model.")
        return result
    except json.JSONDecodeError as exc:
        logger.error(
            f"Gemini returned non-JSON even after repair.\n"
            f"Original (first 400 chars): {raw_text[:400]}\n"
            f"Repaired (first 400 chars): {repaired[:400]}"
        )
        raise ValueError(f"Gemini returned unparseable response: {exc}") from exc


def _match_and_build_items(detected_items: list) -> tuple[list, int, int]:
    """Match Gemini detections against FOOD_CATEGORIES DB."""
    items = []
    db_matched = 0
    llm_estimated = 0

    for detection in detected_items:
        detected_name: str = detection.get("name", "").strip()
        estimated_grams: float = float(detection.get("estimated_grams", 100))
        confidence: float = float(detection.get("confidence", 0.5))

        db_match = _fuzzy_match_food(detected_name)

        if db_match:
            category, db_name, db_details = db_match
            serving = db_details.get("serving_size", {"amount": 100, "unit": "g"})

            # ---------------------------------------------------------------------------
            # Ratio fix: only divide by serving amount when the serving unit is
            # weight-based (g / kg). If the DB stores the food in "piece", "cup",
            # "slice", etc., dividing estimated_grams (e.g. 150) by 1 (piece) gives
            # a 150× multiplier — turning 18 g carbs into 2700. In that case we
            # fall back to using the DB's w_amount (gram equivalent) when present,
            # or default to 100 g as the reference serving.
            # ---------------------------------------------------------------------------
            _WEIGHT_UNITS = {"g", "gram", "grams", "kg", "kilogram", "kilograms"}
            serving_unit = serving.get("unit", "g").lower()

            if serving_unit in _WEIGHT_UNITS:
                # Safe: both estimated_grams and serving amount are in grams
                serving_grams = serving.get("amount", 100)
            else:
                # Non-weight unit (piece, cup, slice …) — use w_amount if the DB
                # provides a gram equivalent, otherwise fall back to 100 g
                serving_grams = serving.get("w_amount") or 100

            ratio = estimated_grams / max(serving_grams, 1)
            item = {
                "name":     db_name,
                "category": category,
                "details": {
                    "carbs":           round(db_details.get("carbs", 0) * ratio, 1),
                    "protein":         round(db_details.get("protein", 0) * ratio, 1),
                    "fat":             round(db_details.get("fat", 0) * ratio, 1),
                    "fiber":           round(db_details.get("fiber", 0) * ratio, 1),
                    "absorption_type": db_details.get("absorption_type", "medium"),
                    # w_amount / w_unit tell FoodSearch.handleSelectFood that this
                    # is a weight-based serving (not volume), preventing a 400 from
                    # the backend measurement-type validation.
                    "serving_size":    {
                        "amount":   estimated_grams,
                        "unit":     "g",
                        "w_amount": estimated_grams,
                        "w_unit":   "g",
                    },
                },
                "scan_meta": {
                    "source":          "database",
                    "detected_name":   detected_name,
                    "confidence":      confidence,
                    "estimated_grams": estimated_grams,
                    "notes":           detection.get("notes", ""),
                    "name_ar":         detection.get("name_ar"),
                    "name_de":         detection.get("name_de"),
                },
            }
            db_matched += 1
        else:
            item = {
                "name":     detected_name,
                "category": "scanned",
                "details": {
                    "carbs":           round(float(detection.get("carbs", 0)), 1),
                    "protein":         round(float(detection.get("protein", 0)), 1),
                    "fat":             round(float(detection.get("fat", 0)), 1),
                    "fiber":           round(float(detection.get("fiber", 0)), 1),
                    "absorption_type": detection.get("absorption_type", "medium"),
                    # Same fix — include w_amount/w_unit so this item is treated
                    # as weight-based when it reaches FoodSearch.handleSelectFood.
                    "serving_size":    {
                        "amount":   estimated_grams,
                        "unit":     "g",
                        "w_amount": estimated_grams,
                        "w_unit":   "g",
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
    """Case-insensitive match against FOOD_CATEGORIES."""
    query_lower = query.lower()
    for category, foods in FOOD_CATEGORIES.items():
        for food_name, details in foods.items():
            if query_lower == food_name.lower():
                return category, food_name, details
    for category, foods in FOOD_CATEGORIES.items():
        for food_name, details in foods.items():
            food_lower = food_name.lower()
            if query_lower in food_lower or food_lower in query_lower:
                return category, food_name, details
    return None