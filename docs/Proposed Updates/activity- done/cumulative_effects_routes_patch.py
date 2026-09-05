"""
cumulative_effects_routes_patch.py
=============================================================================
Diff-style patch to integrate HR activity pharmacodynamics into
cumulative_effects_routes.py and get_active_effects_full().

Apply these changes in order. Search for the anchor comment/line,
then insert or replace as marked.
=============================================================================
"""

# ════════════════════════════════════════════════════════════════════════════
# PATCH 1 — Add import at the top of cumulative_effects_routes.py
# (after the existing pharmacodynamics imports)
# ════════════════════════════════════════════════════════════════════════════

from utils.activity_pharmacodynamics import (
    normalize_activity_record,
    calculate_stacked_activity_effect,
    apply_activity_sensitivity,
)


# ════════════════════════════════════════════════════════════════════════════
# PATCH 2 — get_cumulative_effects()
# Location: after the `insulin_doses = list(mongo.db.medication_logs.find(...))`
#           block, before `calculate_total_cumulative_effects(...)` is called.
#
# SEARCH FOR this line:
#   logger.info(f"Found {len(meals)} meals, {len(insulin_doses)} insulin doses since reset")
#
# INSERT BEFORE IT:
# ════════════════════════════════════════════════════════════════════════════

        # ── Query completed activities for today's window ─────────────────
        raw_activities = list(mongo.db.activities.find({
            'user_id': user_id,
            'type':    'completed',
            '$or': [
                {'startTime':     {'$gte': reset_time, '$lte': target_time}},
                {'completedTime': {'$gte': reset_time, '$lte': target_time}},
                {'timestamp':     {'$gte': reset_time, '$lte': target_time}},
            ],
        }).sort('startTime', -1))

        # Normalize to ActivityLog format (filters out sedentary records)
        activities = [
            norm for raw in raw_activities
            if (norm := normalize_activity_record(raw)) is not None
        ]

        logger.info(
            f"Found {len(raw_activities)} raw activity records → "
            f"{len(activities)} exercise sessions after normalization"
        )

        # ── Calculate activity effect ─────────────────────────────────────
        activity_data = calculate_stacked_activity_effect(
            activities=activities,
            current_time=target_time,
            patient_constants=patient_constants,
        )
        cumulative_activity_effect = activity_data['cumulative_activity_effect']


# ════════════════════════════════════════════════════════════════════════════
# PATCH 3 — get_cumulative_effects()
# SEARCH FOR:
#   cumulative_net_baseline = cumulative_data['cumulative_net_baseline']
# (or wherever cumulative_net_baseline is built from the pharmacodynamics call)
#
# If calculate_total_cumulative_effects() already returns cumulative_net_baseline,
# add the activity term on top:
# ════════════════════════════════════════════════════════════════════════════

        # BEFORE (original):
        #   cumulative_net_baseline = cumulative_data['cumulative_net_baseline']

        # AFTER — patch cumulative_net_baseline to include activity:
        cumulative_net_baseline = (
            cumulative_data['cumulative_net_baseline']
            + cumulative_activity_effect            # ← new: negative value
        )
        cumulative_data['cumulative_net_baseline'] = round(cumulative_net_baseline, 1)
        cumulative_data['cumulative_activity_effect'] = round(cumulative_activity_effect, 1)
        cumulative_data['activity_on_board'] = activity_data['activity_on_board']
        cumulative_data['activity_sensitivity_multiplier'] = activity_data['sensitivity_multiplier']
        cumulative_data['activity_contributions'] = activity_data['activity_contributions']


# ════════════════════════════════════════════════════════════════════════════
# PATCH 4 — get_active_effects_full()
# BG estimates block: scale carb_to_bg_ratio and correction_factor by
# activity sensitivity so pending IOB/MOB projections are correct.
#
# SEARCH FOR (inside the bg_estimates try block):
#   carb_to_bg_ratio = patient_constants.get('carb_to_bg_ratio', 4.0)
#
# REPLACE THE LINE AND THE TWO FOLLOWING LINES with:
# ════════════════════════════════════════════════════════════════════════════

        # Activities queried for active-effects-full  (same reset window)
        raw_activities_full = list(mongo.db.activities.find({
            'user_id': user_id,
            'type':    'completed',
            '$or': [
                {'startTime':     {'$gte': reset_time, '$lte': target_time}},
                {'completedTime': {'$gte': reset_time, '$lte': target_time}},
                {'timestamp':     {'$gte': reset_time, '$lte': target_time}},
            ],
        }).sort('startTime', -1))

        activities_full = [
            norm for raw in raw_activities_full
            if (norm := normalize_activity_record(raw)) is not None
        ]

        # Activity-adjusted constants for pending effect projections
        effective_constants = apply_activity_sensitivity(
            patient_constants, activities_full, target_time
        )

        # BEFORE (original):
        #   carb_to_bg_ratio = patient_constants.get('carb_to_bg_ratio', 4.0)
        #   pending_mob_rise = total_active_carbs * carb_to_bg_ratio
        #   pending_iob_reduction = iob_data.get('pending_bg_reduction', 0.0)
        #   pending_net_effect = pending_mob_rise - pending_iob_reduction

        # AFTER:
        carb_to_bg_ratio  = effective_constants.get('carb_to_bg_ratio', 4.0)
        pending_mob_rise  = total_active_carbs * carb_to_bg_ratio
        pending_iob_reduction = iob_data.get('pending_bg_reduction', 0.0)
        pending_net_effect = pending_mob_rise - pending_iob_reduction

        # Also add activity stacked effect to current_estimated_bg
        # (reuse activity_data from the cumulative calculation above,
        #  or recalculate here if get_active_effects_full is independent)
        activity_data_full = calculate_stacked_activity_effect(
            activities=activities_full,
            current_time=target_time,
            patient_constants=patient_constants,
        )
        activity_bg_effect = activity_data_full['cumulative_activity_effect']  # negative

        # BEFORE (original):
        #   current_estimated_bg = stable_baseline + cumulative_data['cumulative_net_baseline']
        # AFTER:
        current_estimated_bg = (
            stable_baseline
            + cumulative_data['cumulative_net_baseline']
            + activity_bg_effect   # already negative — lowers estimated BG
        )


# ════════════════════════════════════════════════════════════════════════════
# PATCH 5 — get_active_effects_full() → bg_estimates dict
# ADD these fields to the bg_estimates dict that is returned:
# ════════════════════════════════════════════════════════════════════════════

        bg_estimates = {
            # ... existing fields unchanged ...
            # ADD:
            'cumulative_activity_effect':  round(activity_bg_effect, 1),
            'activity_on_board':           activity_data_full['activity_on_board'],
            'activity_sensitivity_mult':   activity_data_full['sensitivity_multiplier'],
            'activity_contributions':      activity_data_full['activity_contributions'],
        }


# ════════════════════════════════════════════════════════════════════════════
# PATCH 6 — result dict in get_active_effects_full()
# ADD activity fields to the top-level returned dict:
# ════════════════════════════════════════════════════════════════════════════

        result = {
            # ... existing fields unchanged ...
            # ADD:
            'cumulative_activity_effect':  round(activity_bg_effect, 1),
            'activity_on_board':           activity_data_full['activity_on_board'],
            'activity_sensitivity_mult':   activity_data_full['sensitivity_multiplier'],
        }


# ════════════════════════════════════════════════════════════════════════════
# NOTES
# ════════════════════════════════════════════════════════════════════════════
#
# 1. COLLECTION: Activities are in mongo.db.activities (not meals_only).
#    The query uses $or across startTime, completedTime, timestamp to catch
#    all legacy record formats.
#
# 2. WALRUS OPERATOR: The `(norm := normalize_activity_record(raw)) is not None`
#    pattern requires Python ≥ 3.8. If your deployment uses 3.7, replace with:
#
#       activities = []
#       for raw in raw_activities:
#           norm = normalize_activity_record(raw)
#           if norm is not None:
#               activities.append(norm)
#
# 3. HR TRACE: No schema change required for existing records.
#    To support wearable HR import, add hr_trace, hr_base, hr_max to the
#    record-activities POST payload and pass them through in activity.py.
#    The normalize_activity_record() function already forwards these fields.
#
# 4. TIMING: Activities with level ≤ −1 (sedentary / sick days) are
#    intentionally excluded from the BG model. Their impact on insulin dosing
#    is handled separately via activity_coefficients in patient constants.
#
# 5. SENSITIVITY WINDOW: The multiplier is only computed for activities within
#    the past 8 hours (W decays with τ = 90 min, so 8h ≈ 5·τ → <1% remaining).
#    Activities older than 8h from current_time contribute 0 to the multiplier.
#
# 6. CUMULATIVE_NET_BASELINE FORMULA (after patch):
#       cumulative_net_baseline = meal_effect + insulin_effect + activity_effect
#    where activity_effect is negative (BG-lowering).
#    The original calculate_total_cumulative_effects() result is preserved in
#    cumulative_data before the patch rewrites cumulative_net_baseline.
