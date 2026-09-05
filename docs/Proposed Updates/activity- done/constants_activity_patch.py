"""
constants_activity_patch.py
=============================================================================
Exact additions required in constants.py to support activity_pharmacodynamics.
Apply each PATCH in the order shown.  Search for the anchor line, then insert
or replace as marked.

No existing fields are renamed or removed — backward-compatible.
=============================================================================
"""


# ════════════════════════════════════════════════════════════════════════════
# PATCH 1 — ConstantConfig dataclass
# ANCHOR: after the existing line:
#     fat_factor: float = 0.2
#     carb_to_bg_factor: float = 4.0
#
# INSERT the following block immediately after carb_to_bg_factor:
# ════════════════════════════════════════════════════════════════════════════

    # ── Activity / exercise model constants ──────────────────────────────────
    # weight_kg is used for allometric scaling of the BG-drop magnitude.
    # Formula: drop *= (70 / weight_kg) ** 0.25  (Dalla Man 2009 convention).
    # Default 70 kg — overridden from patient profile when available.
    weight_kg: float = 70.0

    # Patient resting and maximum heart rate (bpm).
    # Used to normalise wearable HR traces and to build the synthetic trace
    # for the intensity-only fallback path (no wearable connected).
    # hr_max is also used to compute %HRmax for each intensity tier.
    hr_base: float = 70.0
    hr_max: float = 190.0

    # carb_to_bg_ratio — same semantics as carb_to_bg_factor (1 g carbs → N mg/dL).
    # Added as a second name so the activity pharmacodynamics module can use a
    # single key without having to know which name the caller stored.
    # Keep both fields in sync: if a patient edits one, mirror it to the other
    # in update_patient_constants() (see PATCH 4 below).
    carb_to_bg_ratio: float = 4.0


# ════════════════════════════════════════════════════════════════════════════
# PATCH 2 — DEFAULT_PATIENT_CONSTANTS dict  (inside the Constants class body)
# ANCHOR: the existing line:
#     'carb_to_bg_factor': config.carb_to_bg_factor,
#
# INSERT after it:
# ════════════════════════════════════════════════════════════════════════════

        'carb_to_bg_ratio':  config.carb_to_bg_ratio,   # activity model alias
        'weight_kg':         config.weight_kg,
        'hr_base':           config.hr_base,
        'hr_max':            config.hr_max,


# ════════════════════════════════════════════════════════════════════════════
# PATCH 3 — Constants class body  (after ACTIVITY_LEVELS list)
# ANCHOR: the existing ACTIVITY_LEVELS list
#
# INSERT the following class attribute immediately after ACTIVITY_LEVELS:
# ════════════════════════════════════════════════════════════════════════════

    # Maps the string intensity labels used by activity_pharmacodynamics to
    # their HR fraction above resting and to the legacy integer level.
    # Exported to the frontend so the activity-entry form can display
    # human-readable labels without hard-coding them in JavaScript/TypeScript.
    ACTIVITY_INTENSITY_LEVELS = {
        'light': {
            'hr_fraction': 0.50,   # ~50 % HRmax, ≈130 bpm at population values
            'label':       'Light',
            'level':        0,     # matches ACTIVITY_LEVELS integer value
        },
        'moderate': {
            'hr_fraction': 0.65,   # ~65 % HRmax, ≈154 bpm
            'label':       'Moderate',
            'level':        1,
        },
        'vigorous': {
            'hr_fraction': 0.80,   # ~80 % HRmax, ≈178 bpm
            'label':       'Vigorous',
            'level':        2,
        },
    }


# ════════════════════════════════════════════════════════════════════════════
# PATCH 4 — update_patient_constants()
# ANCHOR: inside the existing valid_constants filtering block:
#     valid_constants = {k: v for k, v in new_constants.items()
#                        if hasattr(self.default_config, k)}
#
# INSERT after the valid_constants assignment:
# ════════════════════════════════════════════════════════════════════════════

            # Keep carb_to_bg_factor and carb_to_bg_ratio in sync so both
            # the legacy calculation path and the activity model see the same value.
            if 'carb_to_bg_factor' in valid_constants and 'carb_to_bg_ratio' not in valid_constants:
                valid_constants['carb_to_bg_ratio'] = valid_constants['carb_to_bg_factor']
            elif 'carb_to_bg_ratio' in valid_constants and 'carb_to_bg_factor' not in valid_constants:
                valid_constants['carb_to_bg_factor'] = valid_constants['carb_to_bg_ratio']


# ════════════════════════════════════════════════════════════════════════════
# PATCH 5 — get_all_constants()
# ANCHOR: the existing return dict inside get_all_constants(), after:
#     'BASELINE_HARD_MAX': cls.BASELINE_HARD_MAX,
#
# INSERT:
# ════════════════════════════════════════════════════════════════════════════

            # ── Activity intensity label map ──────────────────────────────
            'ACTIVITY_INTENSITY_LEVELS': cls.ACTIVITY_INTENSITY_LEVELS,


# ════════════════════════════════════════════════════════════════════════════
# PATCH 6 — _load_patient_constants()
# ANCHOR: the legacy-field fallback dict:
#     constants_data = {
#         'insulin_to_carb_ratio': patient.get('insulin_to_carb_ratio'),
#         ...
#         'absorption_modifiers': patient.get('absorption_modifiers'),
#         'insulin_timing_guidelines': patient.get('insulin_timing_guidelines')
#     }
#
# REPLACE with (adds the new fields to the legacy fallback path):
# ════════════════════════════════════════════════════════════════════════════

                    constants_data = {
                        'insulin_to_carb_ratio':    patient.get('insulin_to_carb_ratio'),
                        'correction_factor':         patient.get('correction_factor'),
                        'target_glucose':            patient.get('target_glucose'),
                        'protein_factor':            patient.get('protein_factor'),
                        'fat_factor':                patient.get('fat_factor'),
                        'activity_coefficients':     patient.get('activity_coefficients'),
                        'absorption_modifiers':      patient.get('absorption_modifiers'),
                        'insulin_timing_guidelines': patient.get('insulin_timing_guidelines'),
                        # ── activity model fields ─────────────────────────
                        'weight_kg':                 patient.get('weight_kg'),
                        'hr_base':                   patient.get('hr_base'),
                        'hr_max':                    patient.get('hr_max'),
                        'carb_to_bg_ratio':          patient.get('carb_to_bg_ratio'),
                    }
