from typing import Dict, Any
from constants import Constants

# Initialize constants for use throughout the module
base_constants = Constants()

# =============================================================================
# DiaTwin Food Database — Egyptian-Focused Edition
# =============================================================================
# Carb values cross-referenced with:
#   - Medtronic "Quick Guide to Carbohydrate Counting" (Arabic, v2.0)
#   - Standard food composition tables for Egyptian foods
#   - GI values from the International Tables of Glycemic Index (Atkinson et al.)
#
# Key reference: 15g carbs = 1 carbohydrate exchange/unit (book standard)
# Absorption types: very_fast | fast | medium | slow | very_slow
# =============================================================================

# ------------------------------------------------------------------------------
# BASIC STAPLES
# Cooked grains — typical Egyptian household portions
# ------------------------------------------------------------------------------
FOOD_DATABASE = {
    "white_rice_cooked": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 44.0,
        "protein": 5.0,
        "fat": 0.4,
        "fiber": 0.6,
        "absorption_type": "fast",
        "gi_index": 73,
        "description": "Cooked white rice (plain)"
    },
    "egyptian_rice_cooked": {
        # Book ref: 4 tablespoons (~60g) = 15g carbs → 200g serving = ~50g carbs
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 43.0,
        "protein": 4.5,
        "fat": 2.5,
        "fiber": 0.8,
        "absorption_type": "fast",
        "gi_index": 72,
        "description": "Egyptian-style short-grain white rice, cooked with oil or vermicelli"
    },
    "brown_rice_cooked": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 42.0,
        "protein": 5.0,
        "fat": 1.6,
        "fiber": 3.5,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Cooked brown rice — healthier alternative, lower GI"
    },
    "pasta_cooked": {
        # Book ref: 6 tablespoons (~90g) = 15g carbs → 200g serving = ~33g carbs
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 40.0,
        "protein": 7.0,
        "fat": 1.5,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Cooked plain pasta (macaroni/spaghetti)"
    },
    "oats_cooked": {
        # Book ref: half cup cooked = 15g carbs
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 240,
            "w_unit": "g"
        },
        "carbs": 27.0,
        "protein": 5.0,
        "fat": 3.0,
        "fiber": 4.0,
        "absorption_type": "slow",
        "gi_index": 55,
        "description": "Cooked oatmeal (porridge) — popular Egyptian breakfast"
    }
}

# ------------------------------------------------------------------------------
# BREAD & STARCH LIST
# Book ref: 30g of most bread types = 15g carbs (1 exchange)
# ------------------------------------------------------------------------------
STARCH_LIST = {
    "white_bread_slice": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 15.0,
        "protein": 2.5,
        "fat": 1.0,
        "fiber": 0.6,
        "absorption_type": "fast",
        "gi_index": 75,
        "description": "One slice of white toast bread (30g = 1 carb exchange)"
    },
    "aish_baladi_egyptian_flatbread": {
        # Book ref: 1 whole baladi bread (~80g) = ~38g carbs (~2.5 exchanges)
        # 30g (half a small baladi) = 15g carbs per book
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 80,
            "w_unit": "g"
        },
        "carbs": 38.0,
        "protein": 7.0,
        "fat": 1.5,
        "fiber": 5.5,
        "absorption_type": "medium",
        "gi_index": 57,
        "description": "Egyptian whole-wheat flatbread (baladi bread) — high fiber, moderate GI"
    },
    "aish_fino_white_roll": {
        # Book: 30g = 15g carbs (1 exchange); a fino roll is ~60g = 2 exchanges
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 32.0,
        "protein": 5.0,
        "fat": 2.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 74,
        "description": "Egyptian soft white fino roll — common breakfast bread"
    },
    "aish_shams_round_bread": {
        # Similar to fino but larger, softer, round
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 46.0,
        "protein": 7.5,
        "fat": 2.5,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 73,
        "description": "Egyptian round soft white bread (aish shams) — larger than fino, very common"
    },
    "aish_toast_loaf_slice": {
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 5.0,
        "fat": 2.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 75,
        "description": "Egyptian toast bread (2 slices from standard loaf)"
    },
    "pita_bread_whole_wheat": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 65,
            "w_unit": "g"
        },
        "carbs": 35.0,
        "protein": 6.0,
        "fat": 1.5,
        "fiber": 4.0,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "Whole-wheat pita bread — healthier option, higher fiber"
    },
    "hamburger_bun": {
        # Book ref: half bun = 1 exchange (30g = 15g carbs)
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 4.5,
        "fat": 2.5,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 72,
        "description": "Standard hamburger bun (full bun = 2 exchanges)"
    },
    "hot_dog_bun": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 55,
            "w_unit": "g"
        },
        "carbs": 27.0,
        "protein": 4.0,
        "fat": 2.0,
        "fiber": 0.8,
        "absorption_type": "fast",
        "gi_index": 72,
        "description": "Standard hot dog bun"
    },
    "simit_sesame_bread_ring": {
        # Popular in Egypt — sesame-covered circular bread
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 52.0,
        "protein": 8.0,
        "fat": 5.0,
        "fiber": 3.0,
        "absorption_type": "fast",
        "gi_index": 68,
        "description": "Sesame-crusted circular bread ring (simit) — very popular Egyptian street breakfast"
    },
    "croissant": {
        # Book ref: 1 croissant = 1 exchange (15g carbs)
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 24.0,
        "protein": 4.0,
        "fat": 12.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 67,
        "description": "Plain butter croissant — widely available in Egyptian bakeries"
    },
    "pancakes_small": {
        # Book ref: 1 pancake (10cm × 0.5cm) = 1 exchange (30g = 15g carbs)
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 4.5,
        "fat": 3.0,
        "fiber": 0.8,
        "absorption_type": "fast",
        "gi_index": 67,
        "description": "Small pancakes (2 pieces, 10cm diameter each)"
    },
    "crackers_plain": {
        "serving_size": {
            "amount": 4,
            "unit": "v_plate",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 22.0,
        "protein": 2.5,
        "fat": 3.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 72,
        "description": "Plain salted crackers (4 biscuits)"
    },
    "corn_flakes_cereal": {
        # Book ref: 6 tablespoons = 15g carbs; bowl ~30g = 25g carbs
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 25.0,
        "protein": 2.0,
        "fat": 0.3,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 81,
        "description": "Corn flakes breakfast cereal (dry, 30g serving = about 1.5 exchanges)"
    },
    "bran_flakes_cereal": {
        # Book ref: half cup = 1 exchange (15g carbs)
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 40,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 4.0,
        "fat": 1.5,
        "fiber": 7.0,
        "absorption_type": "slow",
        "gi_index": 42,
        "description": "Bran-based breakfast cereal — high fiber, much lower GI than corn flakes"
    }
}

# ------------------------------------------------------------------------------
# STARCHY VEGETABLES
# Book ref: ½ cup cooked starchy veg = 15g carbs (1 exchange)
# ------------------------------------------------------------------------------
STARCHY_VEGETABLES = {
    "potato_boiled": {
        # Book: ½ cup boiled potato (90g) = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 17.0,
        "protein": 2.0,
        "fat": 0.1,
        "fiber": 2.2,
        "absorption_type": "medium",
        "gi_index": 78,
        "description": "Boiled white potato (medium)"
    },
    "sweet_potato_boiled": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 20.0,
        "protein": 1.5,
        "fat": 0.1,
        "fiber": 3.3,
        "absorption_type": "medium",
        "gi_index": 63,
        "description": "Boiled sweet potato — popular in Egyptian winter street food"
    },
    "corn_on_the_cob": {
        # Book: 15cm corn cob = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 19.0,
        "protein": 3.5,
        "fat": 1.5,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 52,
        "description": "Corn on the cob (15cm) — common Egyptian street food, often grilled"
    },
    "green_peas_cooked": {
        # Book: ½ cup = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 80,
            "w_unit": "g"
        },
        "carbs": 11.0,
        "protein": 4.0,
        "fat": 0.2,
        "fiber": 3.5,
        "absorption_type": "slow",
        "gi_index": 48,
        "description": "Cooked green peas — common in Egyptian stews and rice dishes"
    },
    "pumpkin_cooked": {
        # Book: 1 cup = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 12.0,
        "protein": 1.0,
        "fat": 0.1,
        "fiber": 0.5,
        "absorption_type": "fast",
        "gi_index": 75,
        "description": "Cooked pumpkin/squash"
    },
    "popcorn_plain": {
        # Book: 3 cups = 1 exchange (15g carbs)
        "serving_size": {
            "amount": 3,
            "unit": "cup",
            "w_amount": 24,
            "w_unit": "g"
        },
        "carbs": 15.0,
        "protein": 1.5,
        "fat": 1.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Plain air-popped popcorn (3 cups = 1 carb exchange)"
    }
}

# ------------------------------------------------------------------------------
# PULSES (Legumes)
# Book note: Legumes release glucose slowly — consider extending bolus duration
# when they form the main part of a meal.
# Reference: ½ cup cooked pulses = ~15g carbs
# ------------------------------------------------------------------------------
PULSES = {
    "red_lentils_cooked": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 240,
            "w_unit": "g"
        },
        "carbs": 40.0,
        "protein": 18.0,
        "fat": 1.5,
        "fiber": 10.0,
        "absorption_type": "slow",
        "gi_index": 25,
        "description": "Cooked red lentils — base of Egyptian lentil soup (shorbet ads)"
    },
    "yellow_lentils_cooked": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 240,
            "w_unit": "g"
        },
        "carbs": 45.0,
        "protein": 27.0,
        "fat": 2.4,
        "fiber": 15.0,
        "absorption_type": "slow",
        "gi_index": 25,
        "description": "Cooked yellow split lentils"
    },
    "stewed_fava_beans": {
        # Egyptian breakfast staple; book ref: ½ cup = ~1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 240,
            "w_unit": "g"
        },
        "carbs": 34.0,
        "protein": 13.0,
        "fat": 5.0,
        "fiber": 9.0,
        "absorption_type": "slow",
        "gi_index": 40,
        "description": "Egyptian stewed fava beans (ful medames) with olive oil, lemon and cumin"
    },
    "chickpeas_cooked": {
        # Book: hummus bil tahini = ½ cup (1/3 cup = 1 exchange)
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 130,
            "w_unit": "g"
        },
        "carbs": 22.0,
        "protein": 7.0,
        "fat": 2.0,
        "fiber": 6.0,
        "absorption_type": "slow",
        "gi_index": 28,
        "description": "Cooked chickpeas (plain) — ingredient in koshari and hummus"
    },
    "hummus_with_tahini": {
        # Book ref: hummus bi tahini ⅓ cup = 1 exchange (15g carbs)
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 14.0,
        "protein": 6.0,
        "fat": 8.0,
        "fiber": 3.5,
        "absorption_type": "slow",
        "gi_index": 28,
        "description": "Chickpea and tahini dip (hummus) — popular Egyptian mezze and breakfast"
    },
    "black_eyed_peas_cooked": {
        # Book: ½ cup cooked = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 130,
            "w_unit": "g"
        },
        "carbs": 20.0,
        "protein": 6.5,
        "fat": 0.5,
        "fiber": 5.5,
        "absorption_type": "slow",
        "gi_index": 33,
        "description": "Cooked black-eyed peas (lubya) — used in Egyptian stews"
    },
    "red_lentil_soup": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 12.0,
        "fat": 3.0,
        "fiber": 7.0,
        "absorption_type": "slow",
        "gi_index": 30,
        "description": "Egyptian red lentil soup (shorbet ads) with cumin and lemon"
    }
}

# ------------------------------------------------------------------------------
# FRUITS
# Book ref: 1 fruit exchange = 15g carbs = 60 kcal
# Weights include skin, seeds and peel (total weight as purchased)
# ------------------------------------------------------------------------------
FRUITS = {
    "apple_medium": {
        # Book: 1 small apple (120g) = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 21.0,
        "protein": 0.5,
        "fat": 0.3,
        "fiber": 3.6,
        "absorption_type": "medium",
        "gi_index": 36,
        "description": "Medium apple with skin (1 piece)"
    },
    "banana_small": {
        # Book: 1 small banana (120g) = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 23.0,
        "protein": 1.1,
        "fat": 0.3,
        "fiber": 2.6,
        "absorption_type": "medium",
        "gi_index": 51,
        "description": "Small banana — very common in Egypt, eaten daily"
    },
    "egyptian_mango": {
        # Book: ½ small mango (150g) = 1 exchange; ½ cup cubed = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 165,
            "w_unit": "g"
        },
        "carbs": 25.0,
        "protein": 1.4,
        "fat": 0.6,
        "fiber": 2.6,
        "absorption_type": "medium",
        "gi_index": 51,
        "description": "Egyptian mango — a prized summer fruit, very sweet"
    },
    "watermelon_slice": {
        # Book: 1 slice (360g with rind) = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 280,
            "w_unit": "g"
        },
        "carbs": 21.0,
        "protein": 1.7,
        "fat": 0.2,
        "fiber": 1.1,
        "absorption_type": "fast",
        "gi_index": 76,
        "description": "Watermelon slice (without rind, ~280g) — Egypt's most popular summer fruit"
    },
    "orange_medium": {
        # Book: 1 small orange = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 18.0,
        "protein": 1.3,
        "fat": 0.2,
        "fiber": 3.1,
        "absorption_type": "medium",
        "gi_index": 42,
        "description": "Medium orange — Egypt is a major citrus producer; very common"
    },
    "strawberry": {
        # Book: 7 medium strawberries (¼ cup) = 1 exchange
        "serving_size": {
            "amount": 10,
            "unit": "cup",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 17.0,
        "protein": 1.1,
        "fat": 0.4,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 40,
        "description": "Fresh strawberries (10 medium) — widely grown in Egyptian Delta region"
    },
    "grapes_medium": {
        # Book: 12 medium grapes (90g) = 1 exchange
        "serving_size": {
            "amount": 15,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 20.0,
        "protein": 0.8,
        "fat": 0.2,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 53,
        "description": "Fresh grapes (about 15 medium grapes) — grown extensively in Egypt"
    },
    "guava_fresh": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 14.0,
        "protein": 2.7,
        "fat": 0.9,
        "fiber": 8.9,
        "absorption_type": "medium",
        "gi_index": 31,
        "description": "Fresh Egyptian guava — very high fiber, relatively low GI"
    },
    "peach_medium": {
        # Book: 2 small peaches (150g) = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 14.0,
        "protein": 1.4,
        "fat": 0.4,
        "fiber": 2.3,
        "absorption_type": "medium",
        "gi_index": 42,
        "description": "Fresh peach — popular Egyptian summer fruit"
    },
    "pear_medium": {
        # Book: 1 small pear (120g) = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 25.0,
        "protein": 0.4,
        "fat": 0.1,
        "fiber": 5.5,
        "absorption_type": "slow",
        "gi_index": 38,
        "description": "Medium pear — low GI despite moderate carbs due to high fiber"
    },
    "tangerine_small": {
        # Book: 2 small tangerines = 1 exchange
        "serving_size": {
            "amount": 2,
            "unit": "cup",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 18.0,
        "protein": 1.0,
        "fat": 0.3,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 30,
        "description": "Two small tangerines (yusufi) — very popular Egyptian winter citrus"
    },
    "dates_fresh": {
        # Book: 3 fresh dates = 1 exchange; 2 dried dates = 1 exchange
        "serving_size": {
            "amount": 3,
            "unit": "cup",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 36.0,
        "protein": 1.8,
        "fat": 0.1,
        "fiber": 3.2,
        "absorption_type": "fast",
        "gi_index": 42,
        "description": "Fresh dates (3 medium dates) — staple in Egyptian diet, especially in Ramadan"
    },
    "dates_dried": {
        "serving_size": {
            "amount": 2,
            "unit": "cup",
            "w_amount": 40,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 1.0,
        "fat": 0.1,
        "fiber": 2.8,
        "absorption_type": "fast",
        "gi_index": 42,
        "description": "Dried dates (2 dates, 40g) — concentrated carbs, fast acting"
    },
    "fig_fresh": {
        # Book: 2 medium fresh figs (100g) = 1 exchange
        "serving_size": {
            "amount": 2,
            "unit": "cup",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 19.0,
        "protein": 0.8,
        "fat": 0.3,
        "fiber": 2.9,
        "absorption_type": "medium",
        "gi_index": 35,
        "description": "Fresh figs (2 medium) — abundant in Egypt during summer"
    },
    "pomegranate_seeds": {
        # Book: 1 small pomegranate = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 19.0,
        "protein": 1.7,
        "fat": 1.2,
        "fiber": 4.0,
        "absorption_type": "medium",
        "gi_index": 53,
        "description": "Pomegranate seeds (arils) — popular Egyptian fruit and juice ingredient"
    },
    # Juices — note the book stresses juice is low-fiber; always prefer whole fruit
    "apple_juice_unsweetened": {
        # Book: ½ cup = 1 exchange (15g carbs)
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "ml"
        },
        "carbs": 14.0,
        "protein": 0.1,
        "fat": 0.1,
        "fiber": 0.0,
        "absorption_type": "fast",
        "gi_index": 40,
        "description": "Unsweetened apple juice (½ cup) — book warns: low fiber, prefer whole fruit"
    },
    "orange_juice_fresh": {
        # Book: ½ cup = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "ml"
        },
        "carbs": 13.0,
        "protein": 0.9,
        "fat": 0.2,
        "fiber": 0.0,
        "absorption_type": "fast",
        "gi_index": 50,
        "description": "Freshly squeezed orange juice (½ cup = 1 exchange)"
    }
}

# ------------------------------------------------------------------------------
# DAIRY & MILK PRODUCTS
# Book ref: 1 milk exchange = 12g carbs + 8g protein
# ------------------------------------------------------------------------------
MILK_AND_DAIRY = {
    "full_fat_milk": {
        # Book: 1 cup whole milk = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 240,
            "w_unit": "ml"
        },
        "carbs": 12.0,
        "protein": 8.0,
        "fat": 8.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 27,
        "description": "Full-fat cow's milk — book recommends low-fat alternatives to reduce saturated fat"
    },
    "low_fat_milk": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 240,
            "w_unit": "ml"
        },
        "carbs": 12.0,
        "protein": 8.0,
        "fat": 2.5,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 27,
        "description": "Low-fat (2%) cow's milk"
    },
    "skim_milk": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 240,
            "w_unit": "ml"
        },
        "carbs": 12.0,
        "protein": 8.0,
        "fat": 0.5,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 27,
        "description": "Skimmed milk — lowest-fat option recommended by the book"
    },
    "zabadi_plain_yogurt": {
        # Book ref: ¾ cup plain yogurt (full fat) = 1 exchange
        # ⅔ cup low-fat = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 11.0,
        "protein": 6.5,
        "fat": 5.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 36,
        "description": "Egyptian plain yogurt (zabadi) — made from buffalo or cow's milk, thicker than Western yogurt"
    },
    "zabadi_low_fat": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 180,
            "w_unit": "g"
        },
        "carbs": 12.0,
        "protein": 8.0,
        "fat": 1.5,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 33,
        "description": "Low-fat plain yogurt (¾ cup = 1 exchange per book)"
    },
    "zabadi_with_fruit": {
        # Book: low-fat flavoured yogurt ⅔ cup = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 180,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 6.5,
        "fat": 2.0,
        "fiber": 0.5,
        "absorption_type": "medium",
        "gi_index": 33,
        "description": "Fruit-flavoured yogurt (low-fat) — much higher carbs due to added sugar and fruit"
    },
    "egyptian_white_cheese": {
        # Very low carb — does not affect insulin requirements significantly
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 85,
            "w_unit": "g"
        },
        "carbs": 2.0,
        "protein": 13.0,
        "fat": 18.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Egyptian white brined cheese (gibna beyda) — similar to feta, negligible carbs"
    },
    "egyptian_areesh_cheese": {
        # Cottage cheese variant — lower fat
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 3.5,
        "protein": 14.0,
        "fat": 5.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Egyptian soft fresh cheese (gibna areesh) — low fat, drained yogurt-style cheese"
    },
    "egyptian_rumi_cheese": {
        # Aged hard cheese — very low carbs
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 50,
            "w_unit": "g"
        },
        "carbs": 0.5,
        "protein": 12.0,
        "fat": 15.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Egyptian aged hard cheese (gibna rumi) — salty, strong flavour, very low carbs"
    },
    "egyptian_cultured_milk": {
        # Laban rayeb / kishk
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 240,
            "w_unit": "ml"
        },
        "carbs": 11.0,
        "protein": 8.0,
        "fat": 4.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 36,
        "description": "Egyptian cultured buttermilk / drinking yogurt (laban) — 1 cup = ~1 exchange"
    },
    "eshta_clotted_cream": {
        # Very low carbs, very high fat — book note: fat delays glucose absorption
        "serving_size": {
            "amount": 2,
            "unit": "tablespoon",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 1.5,
        "protein": 1.5,
        "fat": 12.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Egyptian clotted cream (eshta/qeshta) — used on feteer, konafa; very high fat"
    }
}

# ------------------------------------------------------------------------------
# SWEETS & DESSERTS
# Book values from Arabic sweets section (per 100g servings):
#   kanafeh: 30g | jazariya: 75g | othmaleya: 37g
#   mafruka: 32g | baqlawa: 50g | barama bil jawz: 36g
# General note: these are high-GI, fast-acting; book recommends extended bolus
# ------------------------------------------------------------------------------
SWEETS_AND_DESSERTS = {
    "white_sugar": {
        # Book: 1 tablespoon = 1 exchange (15g carbs)
        "serving_size": {
            "amount": 1,
            "unit": "tablespoon",
            "w_amount": 15,
            "w_unit": "g"
        },
        "carbs": 15.0,
        "protein": 0.0,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "very_fast",
        "gi_index": 65,
        "description": "White granulated sugar (1 tablespoon = 1 carb exchange)"
    },
    "honey": {
        # Book: 1 tablespoon = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "tablespoon",
            "w_amount": 21,
            "w_unit": "g"
        },
        "carbs": 17.0,
        "protein": 0.1,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "fast",
        "gi_index": 61,
        "description": "Honey — common Egyptian condiment for feteer and breakfast"
    },
    "basbousa_semolina_cake": {
        # Standard Egyptian piece (~80g), syrup soaked
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 80,
            "w_unit": "g"
        },
        "carbs": 48.0,
        "protein": 5.0,
        "fat": 10.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 68,
        "description": "Egyptian semolina cake (basbousa) soaked in sugar syrup — ~3 exchanges per piece"
    },
    "om_ali_bread_pudding": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 55.0,
        "protein": 7.0,
        "fat": 18.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Egyptian bread pudding (Om Ali) with nuts, coconut and cream — high carb AND high fat; use extended bolus"
    },
    "konafa_with_cheese": {
        # Book: kanafeh 100g = 30g carbs (2 exchanges); typical serving is 150g
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 45.0,
        "protein": 9.0,
        "fat": 16.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 70,
        "description": "Shredded wheat pastry (konafa) filled with cheese or cream, soaked in syrup — 3 exchanges per serving"
    },
    "baklava_with_nuts": {
        # Book: baqlawa 100g = 50g carbs (3+ exchanges); serving is ~50g (2–3 pieces)
        "serving_size": {
            "amount": 3,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 3.5,
        "fat": 14.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 60,
        "description": "Baklava with nuts (3 small pieces, 60g) — book ref: 50g carbs/100g; fat slows absorption slightly"
    },
    "zalabia_fried_dough": {
        # Egyptian fried dough balls soaked in syrup (similar to loukoumades)
        "serving_size": {
            "amount": 5,
            "unit": "v_plate",
            "w_amount": 80,
            "w_unit": "g"
        },
        "carbs": 42.0,
        "protein": 4.0,
        "fat": 10.0,
        "fiber": 0.5,
        "absorption_type": "fast",
        "gi_index": 74,
        "description": "Egyptian fried dough balls in syrup (zalabia) — 5 pieces, very fast glucose rise"
    },
    "qatayef_stuffed_pancakes": {
        # Ramadan pancakes, stuffed with nuts or cream
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 40.0,
        "protein": 6.0,
        "fat": 8.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Qatayef — stuffed Ramadan pancakes with nuts/cream, fried or baked (2 pieces)"
    },
    "mahalabia_milk_pudding": {
        # Cornstarch-based milk pudding
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 5.5,
        "fat": 4.0,
        "fiber": 0.0,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Egyptian milk pudding (mahalabia) with rosewater and pistachios"
    },
    "harissa_semolina_coconut_sweet": {
        # Similar to basbousa but with coconut — book ref: similar macros
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 80,
            "w_unit": "g"
        },
        "carbs": 44.0,
        "protein": 4.5,
        "fat": 11.0,
        "fiber": 2.0,
        "absorption_type": "fast",
        "gi_index": 66,
        "description": "Harissa — Egyptian semolina and coconut sweet soaked in syrup (similar to basbousa)"
    },
    "halawa_tahini_sesame_sweet": {
        # Sesame halva — book: halawa saada 2 tablespoons (25g) = 1 exchange
        "serving_size": {
            "amount": 2,
            "unit": "tablespoon",
            "w_amount": 25,
            "w_unit": "g"
        },
        "carbs": 15.0,
        "protein": 3.5,
        "fat": 8.0,
        "fiber": 1.5,
        "absorption_type": "slow",
        "gi_index": 55,
        "description": "Sesame-based tahini sweet (halawa) — 2 tablespoons = 1 exchange; fat content slows absorption"
    },
    "roz_bil_laban_rice_pudding": {
        # Very popular Egyptian dessert — rice + milk + sugar
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 35.0,
        "protein": 5.0,
        "fat": 5.0,
        "fiber": 0.3,
        "absorption_type": "medium",
        "gi_index": 62,
        "description": "Egyptian rice pudding (roz bil laban) with milk, sugar and rosewater"
    },
    "feteer_bil_assal_with_honey": {
        # Layered pastry served with honey and clotted cream
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 55.0,
        "protein": 7.0,
        "fat": 20.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Feteer meshaltet with honey and eshta — very high fat AND carbs; use extended/dual-wave bolus"
    },
    "jazariya_carrot_sweet": {
        # Book: jazariya 100g = 75g carbs (5 exchanges!) — very high carb confection
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 50,
            "w_unit": "g"
        },
        "carbs": 37.0,
        "protein": 1.0,
        "fat": 2.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 70,
        "description": "Carrot confection (jazariya) — book ref: 75g carbs/100g; extremely high carb, small portions only"
    },
    "chocolate_bar_standard": {
        # Book ref: standard chocolate 30g = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 17.0,
        "protein": 2.0,
        "fat": 9.0,
        "fiber": 1.0,
        "absorption_type": "medium",
        "gi_index": 40,
        "description": "Standard milk chocolate bar (30g) — fat delays absorption; book: 1 exchange per 30g"
    }
}

# ------------------------------------------------------------------------------
# SNACKS
# Egyptian snacks — mostly pastry-based, moderate-to-high carbs
# ------------------------------------------------------------------------------
SNACKS = {
    "pizza_slice": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 35.0,
        "protein": 14.0,
        "fat": 12.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 60,
        "description": "One slice of standard cheese pizza"
    },
    "falafel_taameya": {
        # Egyptian falafel made from fava beans (not chickpeas like Lebanese)
        "serving_size": {
            "amount": 3,
            "unit": "v_plate",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 18.0,
        "protein": 7.0,
        "fat": 8.0,
        "fiber": 4.5,
        "absorption_type": "medium",
        "gi_index": 40,
        "description": "Egyptian fava bean falafel (taameya) — 3 pieces; lower GI due to legume base and fiber"
    },
    "hawawshi_spiced_meat_bread": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 20.0,
        "fat": 22.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 52,
        "description": "Hawawshi — Egyptian spiced minced meat stuffed in bread and baked; high fat → extended bolus"
    },
    "spinach_pastry": {
        # Fattayer bi sabanekh — triangular pastries
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 6.0,
        "fat": 8.0,
        "fiber": 3.0,
        "absorption_type": "medium",
        "gi_index": 52,
        "description": "Spinach-filled pastry triangles (fattayer bi sabanekh) — 2 pieces"
    },
    "cheese_pastry": {
        # Fatayer bi gibna
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 26.0,
        "protein": 9.0,
        "fat": 11.0,
        "fiber": 1.0,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Cheese-filled pastry triangles (fattayer bi gibna) — 2 pieces"
    },
    "liver_sandwich": {
        # Kebda sandwich — extremely popular Egyptian street food
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 180,
            "w_unit": "g"
        },
        "carbs": 34.0,
        "protein": 22.0,
        "fat": 10.0,
        "fiber": 3.0,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Egyptian grilled liver sandwich (kebda) in baladi bread with peppers and chili — street food staple"
    },
    "arayes_meat_bread": {
        # Meat-stuffed pita grilled on griddle
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 180,
            "w_unit": "g"
        },
        "carbs": 32.0,
        "protein": 18.0,
        "fat": 14.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 53,
        "description": "Arayes — pita bread stuffed with spiced minced meat and grilled"
    },
    "sambousek_meat": {
        # Deep-fried meat-filled pastry triangles
        "serving_size": {
            "amount": 3,
            "unit": "v_plate",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 22.0,
        "protein": 9.0,
        "fat": 12.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 60,
        "description": "Meat-filled fried pastry triangles (sambousek bil lahma) — 3 pieces; high fat → extend bolus"
    },
    "sambousek_cheese": {
        "serving_size": {
            "amount": 3,
            "unit": "v_plate",
            "w_amount": 90,
            "w_unit": "g"
        },
        "carbs": 20.0,
        "protein": 8.0,
        "fat": 13.0,
        "fiber": 0.5,
        "absorption_type": "fast",
        "gi_index": 60,
        "description": "Cheese-filled fried pastry triangles (sambousek bil gibna) — 3 pieces"
    },
    "feteer_meshaltet_plain": {
        # Layered flaky pastry — very popular Egyptian snack
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 38.0,
        "protein": 6.0,
        "fat": 18.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Egyptian flaky layered pastry (feteer meshaltet) — very high fat; dual-wave bolus recommended"
    },
    "goulash_meat_pastry": {
        # Egyptian filo/puff pastry with meat filling
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 32.0,
        "protein": 14.0,
        "fat": 18.0,
        "fiber": 1.5,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "Egyptian filo-style pastry (goulash) with spiced meat filling"
    },
    "kahk_eid_cookies_plain": {
        # Traditional Eid cookies with powdered sugar
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 35.0,
        "protein": 4.0,
        "fat": 12.0,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Egyptian Eid cookies (kahk) plain with powdered sugar — 2 pieces; only eaten at Eid El Fitr"
    },
    "kahk_with_dates": {
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 70,
            "w_unit": "g"
        },
        "carbs": 42.0,
        "protein": 4.5,
        "fat": 12.0,
        "fiber": 2.0,
        "absorption_type": "fast",
        "gi_index": 63,
        "description": "Egyptian Eid cookies (kahk) stuffed with date paste — 2 pieces"
    }
}

# ------------------------------------------------------------------------------
# COMMON SNACKS (Street food & quick bites)
# ------------------------------------------------------------------------------
COMMON_SNACKS = {
    "fava_bean_sandwich": {
        # Book ref: entire ful sandwich in baladi bread (~160g) = ~42g carbs
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 160,
            "w_unit": "g"
        },
        "carbs": 42.0,
        "protein": 11.0,
        "fat": 6.0,
        "fiber": 6.5,
        "absorption_type": "medium",
        "gi_index": 48,
        "description": "Egyptian street food fava bean sandwich (ful) in baladi bread — very common breakfast"
    },
    "falafel_sandwich": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 40.0,
        "protein": 10.0,
        "fat": 10.0,
        "fiber": 5.0,
        "absorption_type": "medium",
        "gi_index": 45,
        "description": "Egyptian falafel sandwich (taameya) in baladi bread with tahini and salad"
    },
    "liver_sandwich_small": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 22.0,
        "protein": 15.0,
        "fat": 7.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 48,
        "description": "Small liver sandwich (half portion) in fino roll — popular Egyptian street snack"
    },
    "feteer_plain_snack": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 100,
            "w_unit": "g"
        },
        "carbs": 32.0,
        "protein": 5.0,
        "fat": 14.0,
        "fiber": 0.8,
        "absorption_type": "fast",
        "gi_index": 63,
        "description": "Plain feteer meshaltet snack portion — common Egyptian street/café food"
    },
    "potato_chips_regular": {
        # Book: regular chips 30g = 1 exchange
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 16.0,
        "protein": 1.8,
        "fat": 9.0,
        "fiber": 1.2,
        "absorption_type": "fast",
        "gi_index": 70,
        "description": "Regular potato chips/crisps (small bag, 30g) — 1 exchange per book"
    },
    "cheese_triangle_processed": {
        # La Vache Qui Rit (Laughing Cow) — ubiquitous in Egypt
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 35,
            "w_unit": "g"
        },
        "carbs": 3.0,
        "protein": 4.0,
        "fat": 5.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Processed cheese triangles (2 wedges) — very low carb, popular Egyptian breakfast item"
    },
    "petit_beurre_biscuits": {
        # Very popular Egyptian biscuits (Bisco Misr brand etc.)
        "serving_size": {
            "amount": 4,
            "unit": "v_plate",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 22.0,
        "protein": 2.0,
        "fat": 4.0,
        "fiber": 0.5,
        "absorption_type": "fast",
        "gi_index": 70,
        "description": "Plain petit beurre / tea biscuits (4 pieces, 30g) — standard Egyptian breakfast biscuit"
    },
    "digestive_biscuits": {
        # Book: digestive biscuit = 1 exchange per piece
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 22.0,
        "protein": 2.5,
        "fat": 6.0,
        "fiber": 1.5,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "Digestive biscuits (2 pieces, 30g) — widely sold in Egypt"
    }
}

# ------------------------------------------------------------------------------
# HIGH PROTEIN FOODS
# Note: Book states protein has minimal glucose effect unless >300g portions.
# Large protein servings may delay then elevate glucose — monitor and adjust bolus.
# ------------------------------------------------------------------------------
HIGH_PROTEIN_FOODS = {
    "beef_burger_with_bun": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 31.0,
        "protein": 29.0,
        "fat": 17.0,
        "fiber": 1.4,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Beef burger with bun and vegetables — moderate carbs (bun), high protein and fat"
    },
    "kofta_grilled": {
        # Egyptian minced meat skewers — almost no carbs
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 6.0,
        "protein": 22.0,
        "fat": 16.0,
        "fiber": 0.8,
        "absorption_type": "slow",
        "gi_index": 20,
        "description": "Egyptian grilled minced meat skewers (kofta) with herbs — very low carb, very high protein"
    },
    "grilled_chicken_half": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 0.0,
        "protein": 55.0,
        "fat": 14.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Half grilled chicken (farouj meshwi) — zero carbs; eat with rice or bread to track full meal"
    },
    "grilled_fish_medium": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 0.0,
        "protein": 45.0,
        "fat": 8.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Grilled fish (bolti/sea bass) — zero carbs; very common Egyptian meal, especially Friday"
    },
    "grilled_liver_with_peppers": {
        # Kebda ma' filfil — zero carbs for the liver, some from peppers
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 8.0,
        "protein": 28.0,
        "fat": 10.0,
        "fiber": 2.0,
        "absorption_type": "slow",
        "gi_index": 20,
        "description": "Grilled beef liver with peppers and chili (kebda bil filfil) — very popular Egyptian dish"
    },
    "mixed_grill_mashawi": {
        # Assorted grilled meats (kofta, kebab, chicken pieces)
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 5.0,
        "protein": 50.0,
        "fat": 22.0,
        "fiber": 0.5,
        "absorption_type": "slow",
        "gi_index": 15,
        "description": "Egyptian mixed grill (mashawi) — kofta, kebab, chicken; very low carb, very high protein and fat"
    },
    "stuffed_pigeon_with_rice": {
        # Hamam mahshi — Egyptian delicacy
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 32.0,
        "fat": 14.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 45,
        "description": "Egyptian stuffed pigeon with freekeh or rice and herbs (hamam mahshi) — traditional delicacy"
    },
    "roasted_chicken_with_potatoes": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 400,
            "w_unit": "g"
        },
        "carbs": 25.0,
        "protein": 40.0,
        "fat": 18.0,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Oven-roasted chicken with potatoes (farouj fil forn) — common Egyptian family dinner"
    }
}

# ------------------------------------------------------------------------------
# HIGH FAT FOODS
# Book note: Fat significantly slows carb absorption.
# Dual-wave or extended bolus strongly recommended for these items.
# ------------------------------------------------------------------------------
HIGH_FAT_FOODS = {
    "french_fries_medium": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 3.0,
        "fat": 14.0,
        "fiber": 2.5,
        "absorption_type": "fast",
        "gi_index": 75,
        "description": "Medium french fries — high fat delays initial glucose rise but causes late spike"
    },
    "fried_eggplant": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 14.0,
        "protein": 2.0,
        "fat": 14.0,
        "fiber": 4.5,
        "absorption_type": "medium",
        "gi_index": 35,
        "description": "Egyptian deep-fried eggplant (betingan maqliy) — common side dish and sandwich filling"
    },
    "fried_potatoes": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 2.5,
        "fat": 12.0,
        "fiber": 2.5,
        "absorption_type": "fast",
        "gi_index": 75,
        "description": "Egyptian-style fried potato slices — home cooking staple"
    },
    "fried_fish_battered": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 18.0,
        "protein": 30.0,
        "fat": 16.0,
        "fiber": 0.8,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Battered fried fish — carbs come from the batter; fat causes delayed glucose rise"
    },
    "feteer_with_cheese_filling": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 48.0,
        "protein": 14.0,
        "fat": 24.0,
        "fiber": 1.0,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "Feteer with cheese filling — extremely high fat AND carbs; strongly recommend dual-wave bolus"
    },
    "tahini_sauce": {
        # Pure sesame paste — almost no carbs
        "serving_size": {
            "amount": 2,
            "unit": "tablespoon",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 6.0,
        "protein": 5.0,
        "fat": 16.0,
        "fiber": 1.5,
        "absorption_type": "slow",
        "gi_index": 35,
        "description": "Tahini (sesame paste) — used extensively in Egyptian food; low carb, high fat"
    }
}

# ------------------------------------------------------------------------------
# EGYPTIAN MAIN DISHES
# The core of Egyptian daily cooking — nutritionally cross-referenced with the book
# ------------------------------------------------------------------------------
EGYPTIAN_DISHES = {
    "koshari": {
        # Egypt's national dish — complex carb mix, slower absorption than pure starch
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 350,
            "w_unit": "g"
        },
        "carbs": 75.0,
        "protein": 14.0,
        "fat": 5.0,
        "fiber": 8.0,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Koshari — Egypt's national dish: rice, lentils, macaroni, chickpeas and tomato sauce (5 carb exchanges)",
        "components": {
            "rice_and_lentils": {
                "carbs": 40,
                "serving": "bowl",
                "w_amount": 150,
                "w_unit": "g"
            },
            "macaroni": {
                "carbs": 20,
                "serving": "bowl",
                "w_amount": 80,
                "w_unit": "g"
            },
            "tomato_sauce": {
                "carbs": 10,
                "serving": "bowl",
                "w_amount": 80,
                "w_unit": "g"
            },
            "crispy_fried_onions": {
                "carbs": 5,
                "serving": "tablespoon",
                "w_amount": 20,
                "w_unit": "g"
            }
        }
    },
    "molokhia_with_chicken": {
        # Jute leaf stew — very low carb for the stew itself
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 12.0,
        "protein": 20.0,
        "fat": 8.0,
        "fiber": 5.0,
        "absorption_type": "slow",
        "gi_index": 25,
        "description": "Egyptian jute leaf stew (molokhia) with chicken — very low carb; always served with rice"
    },
    "mahshi_stuffed_vegetables": {
        # Stuffed peppers, zucchini, grape leaves — rice is the main carb source
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 48.0,
        "protein": 8.0,
        "fat": 6.0,
        "fiber": 5.0,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Egyptian stuffed vegetables (mahshi) — peppers, zucchini, grape leaves filled with herbed rice"
    },
    "macarona_bechamel_baked_pasta": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 45.0,
        "protein": 18.0,
        "fat": 16.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Egyptian baked pasta (macarona bechamel) with spiced ground meat and béchamel — high fat delays peak"
    },
    "fatta_rice_bread_lamb": {
        # Festive dish — rice + toasted bread in tomato-garlic broth
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 350,
            "w_unit": "g"
        },
        "carbs": 52.0,
        "protein": 20.0,
        "fat": 14.0,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "Egyptian festive dish (fatta) — rice, toasted bread, lamb in tomato-garlic broth; ~3.5 exchanges"
    },
    "beef_shawarma_wrap": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 35.0,
        "protein": 25.0,
        "fat": 18.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Egyptian beef shawarma wrap with tahini, pickles and garlic sauce"
    },
    "chicken_shawarma_wrap": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 230,
            "w_unit": "g"
        },
        "carbs": 33.0,
        "protein": 28.0,
        "fat": 12.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Egyptian chicken shawarma wrap — slightly lower fat than beef version"
    },
    "bamia_okra_stew": {
        # Low carb vegetable stew — often served with rice
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 15.0,
        "protein": 12.0,
        "fat": 6.0,
        "fiber": 4.5,
        "absorption_type": "slow",
        "gi_index": 20,
        "description": "Egyptian okra stew with tomato and meat (bamia) — low carb from stew itself; track rice separately"
    },
    "daoud_basha_meatballs": {
        # Meatballs in tomato sauce
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 14.0,
        "protein": 28.0,
        "fat": 14.0,
        "fiber": 2.5,
        "absorption_type": "slow",
        "gi_index": 30,
        "description": "Egyptian meatballs in tomato-pine nut sauce (daoud basha) — low carb; track rice separately"
    },
    "sayadeya_fish_with_rice": {
        # Alexandrian fish and rice
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 400,
            "w_unit": "g"
        },
        "carbs": 55.0,
        "protein": 38.0,
        "fat": 10.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "Sayadeya — Alexandrian spiced fish over rice with caramelised onion sauce"
    },
    "shakshuka_eggs_in_tomato": {
        # Popular Egyptian brunch — very low carb
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 10.0,
        "protein": 16.0,
        "fat": 14.0,
        "fiber": 2.5,
        "absorption_type": "slow",
        "gi_index": 35,
        "description": "Shakshuka — eggs poached in spiced tomato sauce; very low carb, eat with bread for full meal"
    },
    "stuffed_grape_leaves": {
        # Wara enab — rice-stuffed; book shows wara enab in visuals
        "serving_size": {
            "amount": 6,
            "unit": "v_plate",
            "w_amount": 180,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 6.0,
        "fat": 5.0,
        "fiber": 3.5,
        "absorption_type": "medium",
        "gi_index": 48,
        "description": "Stuffed grape leaves with rice and herbs (wara enab) — 6 pieces; book reference item"
    },
    "mulukhiya_with_rice_full_meal": {
        # Full meal accounting for both molokhia and rice together
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 500,
            "w_unit": "g"
        },
        "carbs": 55.0,
        "protein": 24.0,
        "fat": 10.0,
        "fiber": 6.0,
        "absorption_type": "medium",
        "gi_index": 50,
        "description": "Full molokhia meal — stew + 1 bowl rice + chicken; track as complete meal"
    },
    "hawawshi_full": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 30.0,
        "protein": 20.0,
        "fat": 22.0,
        "fiber": 2.0,
        "absorption_type": "medium",
        "gi_index": 52,
        "description": "Hawawshi — spiced minced meat stuffed in bread, baked; very high fat → extended bolus"
    },
    "fattah_full_meal": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 400,
            "w_unit": "g"
        },
        "carbs": 62.0,
        "protein": 25.0,
        "fat": 16.0,
        "fiber": 3.0,
        "absorption_type": "medium",
        "gi_index": 57,
        "description": "Full fattah meal — rice + toasted bread + lamb + tomato-garlic broth; Eid and celebration dish"
    }
}

# ------------------------------------------------------------------------------
# SALADS & CONDIMENTS
# Most are low-carb but important context for full-meal bolus calculation
# ------------------------------------------------------------------------------
SALADS_AND_CONDIMENTS = {
    "salata_baladi_egyptian_salad": {
        # Tomato, cucumber, pepper, onion — very low carb
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 8.0,
        "protein": 2.0,
        "fat": 3.0,
        "fiber": 3.0,
        "absorption_type": "slow",
        "gi_index": 25,
        "description": "Egyptian salad (salata baladi) — tomato, cucumber, peppers, onion with lemon and olive oil"
    },
    "baba_ghanoush": {
        "serving_size": {
            "amount": 3,
            "unit": "tablespoon",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 8.0,
        "protein": 2.5,
        "fat": 5.0,
        "fiber": 2.5,
        "absorption_type": "slow",
        "gi_index": 25,
        "description": "Smoked eggplant dip with tahini (baba ghanoush) — low carb mezze"
    },
    "tahini_dip": {
        "serving_size": {
            "amount": 2,
            "unit": "tablespoon",
            "w_amount": 30,
            "w_unit": "g"
        },
        "carbs": 6.0,
        "protein": 5.0,
        "fat": 16.0,
        "fiber": 1.5,
        "absorption_type": "slow",
        "gi_index": 35,
        "description": "Tahini dressing/dip — almost always served with Egyptian grills and sandwiches"
    },
    "pickles_torshi": {
        # Virtually zero carbs
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 50,
            "w_unit": "g"
        },
        "carbs": 2.0,
        "protein": 0.5,
        "fat": 0.1,
        "fiber": 1.0,
        "absorption_type": "slow",
        "gi_index": 10,
        "description": "Egyptian mixed pickles (torshi/mekhalel) — negligible carbs, eaten with almost every meal"
    },
    "tomato_sauce_daqqus": {
        "serving_size": {
            "amount": 3,
            "unit": "tablespoon",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 6.0,
        "protein": 1.5,
        "fat": 2.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 35,
        "description": "Egyptian spiced tomato sauce — used in koshari, bamia and other dishes"
    }
}

# ------------------------------------------------------------------------------
# BEVERAGES
# Note: Sweetened drinks are fast-acting carbs — treated like a rapid bolus trigger
# Unsweetened/natural beverages have minimal glycaemic impact
# ------------------------------------------------------------------------------
BEVERAGES = {
    "sugarcane_juice_fresh": {
        # Very fast acting — virtually pure sucrose
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 300,
            "w_unit": "ml"
        },
        "carbs": 36.0,
        "protein": 0.3,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "very_fast",
        "gi_index": 70,
        "description": "Fresh sugarcane juice (aseer asab) — extremely common Egyptian street drink; very rapid glucose rise"
    },
    "hibiscus_drink_sweetened": {
        # Karkade with sugar — Egyptian national drink
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 300,
            "w_unit": "ml"
        },
        "carbs": 28.0,
        "protein": 0.2,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "fast",
        "gi_index": 55,
        "description": "Sweetened hibiscus drink (karkade) — made with dried hibiscus flowers and sugar"
    },
    "hibiscus_drink_unsweetened": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 300,
            "w_unit": "ml"
        },
        "carbs": 3.0,
        "protein": 0.2,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 15,
        "description": "Unsweetened hibiscus drink (karkade) — negligible carbs; best option for T1D"
    },
    "sahlab_warm_drink": {
        # Orchid-flour milk drink, thickened with starch, topped with nuts
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 300,
            "w_unit": "ml"
        },
        "carbs": 35.0,
        "protein": 7.0,
        "fat": 5.0,
        "fiber": 0.5,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Sahlab — warm Egyptian winter drink made from starch, milk, sugar and topped with nuts"
    },
    "tamarind_drink_sweetened": {
        # Tamar hindi — popular Ramadan drink
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 300,
            "w_unit": "ml"
        },
        "carbs": 30.0,
        "protein": 0.5,
        "fat": 0.0,
        "fiber": 0.5,
        "absorption_type": "fast",
        "gi_index": 60,
        "description": "Sweetened tamarind drink (tamar hindi) — popular Ramadan beverage"
    },
    "mango_juice_fresh": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 250,
            "w_unit": "ml"
        },
        "carbs": 30.0,
        "protein": 1.0,
        "fat": 0.5,
        "fiber": 0.5,
        "absorption_type": "fast",
        "gi_index": 55,
        "description": "Fresh mango juice (aseer manga) — popular Egyptian summer drink; low fiber despite being 'fresh'"
    },
    "guava_juice_fresh": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 250,
            "w_unit": "ml"
        },
        "carbs": 22.0,
        "protein": 1.5,
        "fat": 0.5,
        "fiber": 1.0,
        "absorption_type": "fast",
        "gi_index": 40,
        "description": "Fresh guava juice — somewhat lower GI than mango juice"
    },
    "tea_with_sugar": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 200,
            "w_unit": "ml"
        },
        "carbs": 20.0,
        "protein": 0.0,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "very_fast",
        "gi_index": 65,
        "description": "Egyptian black tea with 2 teaspoons sugar (shay) — Egyptians typically drink tea very sweet"
    },
    "tea_no_sugar": {
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 200,
            "w_unit": "ml"
        },
        "carbs": 0.5,
        "protein": 0.0,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Egyptian black tea without sugar — negligible carbs, safe beverage for T1D"
    },
    "soft_drink_cola": {
        # Fast-acting carbs — book lists regular soda as NOT a free food
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 330,
            "w_unit": "ml"
        },
        "carbs": 35.0,
        "protein": 0.0,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "very_fast",
        "gi_index": 65,
        "description": "Regular cola/soft drink (330ml can) — pure fast-acting carbs; book marks as NOT a free food"
    },
    "diet_soft_drink": {
        # Book categorises sugar-free sodas as 'free foods' (<5g carbs per serving)
        "serving_size": {
            "amount": 1,
            "unit": "cup",
            "w_amount": 330,
            "w_unit": "ml"
        },
        "carbs": 0.0,
        "protein": 0.0,
        "fat": 0.0,
        "fiber": 0.0,
        "absorption_type": "slow",
        "gi_index": 0,
        "description": "Diet/sugar-free soft drink — book classifies as 'free food'; negligible carb impact"
    }
}

# ------------------------------------------------------------------------------
# INTERNATIONAL DISHES (kept minimal; DiaTwin is Egypt-focused)
# ------------------------------------------------------------------------------
INTERNATIONAL_DISHES = {
    "lasagna": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 35.0,
        "protein": 18.0,
        "fat": 14.0,
        "fiber": 2.8,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Layered pasta with meat sauce and cheese"
    },
    "fried_rice_chinese": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 250,
            "w_unit": "g"
        },
        "carbs": 45.0,
        "protein": 6.0,
        "fat": 12.0,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 65,
        "description": "Chinese-style stir-fried rice with vegetables and egg"
    },
    "spicy_chickpea_curry_with_fried_bread": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 300,
            "w_unit": "g"
        },
        "carbs": 65.0,
        "protein": 15.0,
        "fat": 22.0,
        "fiber": 12.0,
        "absorption_type": "medium",
        "gi_index": 45,
        "description": "Spicy chickpea curry with fried bread (chole bhature)",
        "components": {
            "chickpea_curry": {
                "carbs": 30,
                "serving": "bowl",
                "w_amount": 200,
                "w_unit": "g"
            },
            "fried_bread": {
                "carbs": 35,
                "serving": "v_plate",
                "w_amount": 100,
                "w_unit": "g"
            }
        }
    }
}

# ------------------------------------------------------------------------------
# GERMAN DISHES
# Common German meals with carb/protein/fat values
# Absorption types reflect typical macronutrient composition
# ------------------------------------------------------------------------------
GERMAN_DISHES = {
    "bratwurst_with_bread": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 18.0,
        "fat": 22.0,
        "fiber": 1.0,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Grilled pork bratwurst served in a bread roll — classic German street food"
    },
    "schnitzel_wiener": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 18.0,
        "protein": 32.0,
        "fat": 20.0,
        "fiber": 0.5,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Breaded and pan-fried veal or pork cutlet — typically served with lemon and potato salad"
    },
    "kartoffelsalat_potato_salad": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 4.0,
        "fat": 8.0,
        "fiber": 2.5,
        "absorption_type": "medium",
        "gi_index": 58,
        "description": "German potato salad — vinegar-based (Bavarian style) or mayo-based; common side dish"
    },
    "spaetzle": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 200,
            "w_unit": "g"
        },
        "carbs": 42.0,
        "protein": 8.0,
        "fat": 6.0,
        "fiber": 1.5,
        "absorption_type": "fast",
        "gi_index": 65,
        "description": "Soft egg noodle/dumpling — popular Swabian pasta side dish, often served with gravy"
    },
    "sauerbraten_with_potato_dumpling": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 350,
            "w_unit": "g"
        },
        "carbs": 38.0,
        "protein": 30.0,
        "fat": 14.0,
        "fiber": 2.0,
        "absorption_type": "slow",
        "gi_index": 50,
        "description": "Marinated pot roast with sweet-sour sauce, served with potato dumpling (Kloß)"
    },
    "currywurst_with_fries": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 350,
            "w_unit": "g"
        },
        "carbs": 52.0,
        "protein": 16.0,
        "fat": 24.0,
        "fiber": 3.5,
        "absorption_type": "fast",
        "gi_index": 68,
        "description": "Sliced pork sausage with curry-spiced ketchup, served with fries — Berlin street food staple"
    },
    "pretzel_brezel": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 120,
            "w_unit": "g"
        },
        "carbs": 65.0,
        "protein": 8.0,
        "fat": 3.0,
        "fiber": 2.0,
        "absorption_type": "fast",
        "gi_index": 72,
        "description": "Baked lye pretzel (Brezel) — salted, chewy crust; popular Bavarian snack/bread"
    },
    "schwarzbrot_dark_rye_bread": {
        "serving_size": {
            "amount": 2,
            "unit": "v_plate",
            "w_amount": 60,
            "w_unit": "g"
        },
        "carbs": 28.0,
        "protein": 5.0,
        "fat": 1.5,
        "fiber": 5.0,
        "absorption_type": "slow",
        "gi_index": 41,
        "description": "German dark rye bread (Schwarzbrot) — very high fiber, low GI; 2 slices (60g)"
    },
    "apfelstrudel": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 45.0,
        "protein": 4.0,
        "fat": 10.0,
        "fiber": 2.5,
        "absorption_type": "fast",
        "gi_index": 60,
        "description": "Apple strudel — thin pastry filled with cinnamon apples, raisins, and breadcrumbs"
    },
    "doner_kebab": {
        "serving_size": {
            "amount": 1,
            "unit": "v_plate",
            "w_amount": 350,
            "w_unit": "g"
        },
        "carbs": 48.0,
        "protein": 28.0,
        "fat": 18.0,
        "fiber": 3.0,
        "absorption_type": "medium",
        "gi_index": 55,
        "description": "Döner kebab in flatbread with salad and sauce — enormously popular German fast food (Turkish origin)"
    },
    "lentil_soup_linsensuppe": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 300,
            "w_unit": "ml"
        },
        "carbs": 30.0,
        "protein": 12.0,
        "fat": 4.0,
        "fiber": 8.0,
        "absorption_type": "slow",
        "gi_index": 30,
        "description": "German lentil soup with sausage slices and vinegar — hearty winter staple"
    },
    "rotkohl_red_cabbage": {
        "serving_size": {
            "amount": 1,
            "unit": "bowl",
            "w_amount": 150,
            "w_unit": "g"
        },
        "carbs": 14.0,
        "protein": 1.5,
        "fat": 2.0,
        "fiber": 3.0,
        "absorption_type": "slow",
        "gi_index": 30,
        "description": "Braised red cabbage with apple and vinegar — classic German side dish"
    }
}

# ------------------------------------------------------------------------------
# FOOD CATEGORIES MAPPING
# All dictionaries aggregated for lookup by category key
# ------------------------------------------------------------------------------
FOOD_CATEGORIES = {
    'basic': FOOD_DATABASE,
    'starch': STARCH_LIST,
    'starchy_vegetables': STARCHY_VEGETABLES,
    'pulses': PULSES,
    'fruits': FRUITS,
    'dairy': MILK_AND_DAIRY,
    'sweets': SWEETS_AND_DESSERTS,
    'snacks': SNACKS,
    'common_snacks': COMMON_SNACKS,
    'high_protein': HIGH_PROTEIN_FOODS,
    'high_fat': HIGH_FAT_FOODS,
    'egyptian': EGYPTIAN_DISHES,
    'salads_condiments': SALADS_AND_CONDIMENTS,
    'beverages': BEVERAGES,
    'international': INTERNATIONAL_DISHES,
    'german': GERMAN_DISHES
}


def validate_food_measurements(food_data: Dict[str, Any]) -> bool:
    """
    Validate that food measurements use supported units from Constants.
    Returns True if both the primary serving unit and weight unit are supported.
    """
    constants = Constants()
    supported_measurements = constants.get_supported_measurements()

    serving_size = food_data.get('serving_size', {})
    unit = serving_size.get('unit')
    w_unit = serving_size.get('w_unit')

    if unit not in supported_measurements['volume'] and unit not in supported_measurements['weight']:
        return False

    if w_unit and w_unit not in supported_measurements['weight']:
        return False

    return True


def get_all_food_items() -> Dict[str, Any]:
    """
    Returns a flat dictionary of all food items across all categories.
    Useful for search and autocomplete features.
    """
    all_items = {}
    for category_items in FOOD_CATEGORIES.values():
        all_items.update(category_items)
    return all_items


def get_food_by_key(food_key: str) -> Dict[str, Any]:
    """
    Look up a single food item by its key across all categories.
    Returns the food dict or None if not found.
    """
    return get_all_food_items().get(food_key)


def get_carb_exchanges(food_key: str) -> float:
    """
    Returns the number of 15g carbohydrate exchanges for one serving of a food.
    Per book standard: 1 exchange = 1 carb unit = 15g carbohydrates.
    """
    food = get_food_by_key(food_key)
    if food is None:
        return 0.0
    return round(food.get('carbs', 0) / 15.0, 2)