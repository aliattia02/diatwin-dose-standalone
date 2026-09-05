"""
food_service.py
Location: backend/services/food_service.py

FIXES vs original
─────────────────
FIX #1 – O(N²) search eliminated
  Before: search_food() called nested dict iteration across every category on
  every request. With 16 categories × N foods, each request re-scanned the
  entire database. With 16 parallel fan-out requests from the frontend this
  was 16 × O(N²) per keystroke.

  After: _FOOD_INDEX and _FOOD_DETAIL_MAP are built ONCE at module import time.
  search_food()  → single O(N) pass through the flat list.
  get_food_details() → O(1) dict lookup (was O(N) nested loop).

FIX #2 – Custom food search de-duplicated
  Before: custom foods were appended in two separate code paths and could
  appear twice in results when no category was selected.
  After: custom food query runs in exactly one place.
"""

from models.food_data import FOOD_CATEGORIES


# ============================================================================
# Module-level flat index — built ONCE on import, never rebuilt
# ============================================================================

def _build_index():
    """
    Flatten all static category dicts into:
      _index       – list of {name, category, details, absorption_type}
      _detail_map  – {food_name: {category, details}} for O(1) lookups
    """
    index = []
    detail_map = {}

    for category, foods in FOOD_CATEGORIES.items():
        for food_name, details in foods.items():
            entry = {
                'name': food_name,
                'category': category,
                'details': details,
                'absorption_type': details.get('absorption_type', 'unknown'),
            }
            index.append(entry)
            # Only keep first occurrence so duplicate-named foods across
            # categories resolve predictably (first category wins).
            if food_name not in detail_map:
                detail_map[food_name] = {'category': category, 'details': details}

    return index, detail_map


# These are module globals — initialised once when Python imports this module.
_FOOD_INDEX: list
_FOOD_DETAIL_MAP: dict
_FOOD_INDEX, _FOOD_DETAIL_MAP = _build_index()


# ============================================================================
# Public API
# ============================================================================

def get_food_details(food_name: str):
    """
    Return {category, details} for food_name, or None if not found.
    O(1) — uses the pre-built detail map.
    """
    return _FOOD_DETAIL_MAP.get(food_name)


def search_food(query: str, category: str | None = None) -> list:
    """
    Search for food items across all (or one) category.

    Parameters
    ----------
    query    : substring to match against food names (case-insensitive).
               Empty string returns all items in the selected category.
    category : restrict results to this category key.
               Pass None / '' to search all static categories.
               Pass 'custom' to query only MongoDB custom foods.

    Returns a list of result dicts compatible with the existing API shape.
    """
    results = []
    q = (query or '').lower().strip()

    # ── Custom-only search ────────────────────────────────────────────────────
    if category == 'custom':
        return _search_custom_foods(q)

    # ── Static food index search (O(N) single pass) ───────────────────────────
    for entry in _FOOD_INDEX:
        # Category filter
        if category and entry['category'] != category:
            continue
        # Text filter (skip when query is empty — return all in category)
        if q and q not in entry['name'].lower():
            continue
        results.append({
            'name': entry['name'],
            'category': entry['category'],
            'details': entry['details'],
            'absorption_type': entry['absorption_type'],
        })

    # ── Append custom foods when searching across all categories ─────────────
    # (not when a specific non-custom category is selected)
    if not category:
        results.extend(_search_custom_foods(q))

    return results


# ============================================================================
# Internal helpers
# ============================================================================

def _search_custom_foods(q: str) -> list:
    """
    Query MongoDB custom_foods collection.
    q is already lowercased by the caller; pass '' to return all custom foods.
    """
    try:
        from config import mongo

        mongo_query = {}
        if q:
            mongo_query = {'name': {'$regex': q, '$options': 'i'}}

        custom_foods = mongo.db.custom_foods.find(mongo_query)

        return [
            {
                'name': food['name'],
                'category': 'custom',
                'details': {
                    'serving_size': food.get('serving_size', {'amount': 1, 'unit': 'g'}),
                    'carbs': food['carbs'],
                    'protein': food['protein'],
                    'fat': food['fat'],
                    'description': food.get('description', ''),
                    'absorption_type': food.get('absorption_type', 'medium'),
                },
                'absorption_type': food.get('absorption_type', 'medium'),
            }
            for food in custom_foods
        ]
    except Exception as e:
        print(f"[food_service] Error searching custom foods: {e}")
        return []


# ============================================================================
# Utility functions (unchanged from original — kept for callers)
# ============================================================================

def calculate_absorption_factor(absorption_type, meal_timing):
    """Calculate absorption factor based on food type and meal timing."""
    return (
        ABSORPTION_FACTORS.get(absorption_type, ABSORPTION_FACTORS['unknown'])
        * TIMING_FACTORS.get(meal_timing, TIMING_FACTORS['normal'])
    )


def convert_to_standard_nutrients(portion_size, measurement_type, food_details, converter):
    """
    Convert nutrients based on portion size and measurement type with proper
    unit conversion.
    """
    details = food_details['details']
    serving_size = details.get('serving_size', {'amount': 100, 'unit': 'g'})

    special_portions = {
        'plate':    300,
        'palm':      85,
        'handful':   30,
        'fist':     150,
        'bowl':     400,
    }

    if measurement_type in special_portions:
        standard_amount = special_portions[measurement_type] * portion_size
        standard_unit = 'g' if measurement_type != 'bowl' else 'ml'
    else:
        standard_amount, standard_unit = converter.convert_to_standard(
            portion_size, measurement_type
        )

    serving_amount, serving_unit = converter.convert_to_standard(
        serving_size['amount'], serving_size['unit']
    )