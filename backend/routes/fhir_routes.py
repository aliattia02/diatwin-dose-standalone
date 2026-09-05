# routes/fhir_routes.py
#
# FHIR R4 Export  — GET  /api/export/fhir
# GDPR Delete     — DELETE /api/patient/data    (wipe all medical data, keep account)
#                   DELETE /api/patient/account  (wipe everything + delete account)
#
# Compatible with MII Treuhandstelle workflows (pseudonymised identifiers).

from flask import Blueprint, request, jsonify, current_app
from datetime import datetime, timezone, timedelta
from bson.objectid import ObjectId
import hashlib
import uuid
import logging

from config import mongo
from utils.auth import token_required

logger = logging.getLogger(__name__)
fhir_bp = Blueprint('fhir_bp', __name__)


# ─── Pseudonym helper ─────────────────────────────────────────────────────────

def generate_pseudonym(user_id: str) -> str:
    """
    Deterministic pseudonym from MongoDB ObjectId string.
    Format: DIATWIN-PT-XXXXX  (5-digit zero-padded integer)
    Same user always receives the same pseudonym — safe to log.
    Never exposes PII.
    """
    digest = int(hashlib.sha256(user_id.encode()).hexdigest(), 16)
    return f"DIATWIN-PT-{digest % 99999:05d}"


# ─── FHIR R4 Export ───────────────────────────────────────────────────────────

@fhir_bp.route('/api/export/fhir', methods=['GET'])
@token_required
def export_fhir(current_user):
    """
    Export patient data as a valid FHIR R4 Bundle (application/fhir+json).

    Query params:
      days  int  (default 30, max 90)  — look-back window

    Returns a Bundle of type 'collection' containing:
      - 1  Patient resource  (pseudonymised, no PII)
      - N  Observation       (blood glucose, LOINC 15074-8)
      - N  MedicationAdministration  (insulin doses, SNOMED 67866001)
      - N  Observation       (meal carb intake, LOINC 9059-7)
      - N  Observation       (activity sessions, LOINC 55423-8 + SNOMED 229070002)
      - N  Observation       (exercise heart rate mean/peak, LOINC 8867-4 + 8873-2)

    Response headers:
      Content-Type: application/fhir+json
      X-DiaTwin-Pseudonymized: true
      X-DiaTwin-Export-Version: 1.0
    """
    try:
        # ── Parse & validate ?days param ──────────────────────────────────
        try:
            days = int(request.args.get('days', 30))
        except (ValueError, TypeError):
            return jsonify({"error": "days must be an integer"}), 400

        if days < 1 or days > 90:
            return jsonify({"error": "days must be between 1 and 90"}), 400

        user_id_str = str(current_user['_id'])
        pseudonym   = generate_pseudonym(user_id_str)
        cutoff      = datetime.now(timezone.utc) - timedelta(days=days)
        now_iso     = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        entries = []

        # ── 1. Patient resource ───────────────────────────────────────────
        patient_resource = {
            "resourceType": "Patient",
            "id": pseudonym,
            "meta": {
                "profile": [
                    "https://www.medizininformatik-initiative.de/fhir/core/modul-person/StructureDefinition/Patient"
                ],
                "tag": [{
                    "system":  "https://diatwin.app/tags",
                    "code":    "pseudonymized",
                    "display": "Pseudonymized — compatible with MII Treuhandstelle workflows"
                }]
            },
            "identifier": [{
                "system": "https://diatwin.app/patient-id",
                "value":  pseudonym
            }]
            # Intentionally omitting: name, birthDate, email, address — no PII
        }
        entries.append({"resource": patient_resource})

        # ── 2. Blood glucose Observations ─────────────────────────────────
        bg_records = list(mongo.db.blood_sugar.find({
            'user_id':   user_id_str,
            'timestamp': {'$gte': cutoff}
        }).sort('timestamp', -1))

        for record in bg_records:
            ts = record.get('timestamp')
            if isinstance(ts, datetime):
                ts_iso = ts.strftime('%Y-%m-%dT%H:%M:%SZ')
            else:
                ts_iso = str(ts)

            bg_value = record.get('bloodSugar')
            if bg_value is None:
                continue

            obs = {
                "resourceType": "Observation",
                "id": str(record['_id']),
                "status": "final",
                "category": [{
                    "coding": [{
                        "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code":    "laboratory",
                        "display": "Laboratory"
                    }]
                }],
                "code": {
                    "coding": [{
                        "system":  "http://loinc.org",
                        "code":    "15074-8",
                        "display": "Glucose [Moles/volume] in Blood"
                    }],
                    "text": "Blood Glucose"
                },
                "subject": {"reference": f"Patient/{pseudonym}"},
                "effectiveDateTime": ts_iso,
                "valueQuantity": {
                    "value":  float(bg_value),
                    "unit":   "mg/dL",
                    "system": "http://unitsofmeasure.org",
                    "code":   "mg/dL"
                }
            }

            # Optional: tag CGM vs finger-prick source
            source = record.get('source', '')
            if source:
                obs["method"] = {
                    "text": source  # e.g. "libre", "fingerprick"
                }

            entries.append({"resource": obs})

        # ── 3. MedicationAdministration — insulin doses ───────────────────
        insulin_records = list(mongo.db.medication_logs.find({
            'patient_id': user_id_str,
            'is_insulin':  True,
            'taken_at':   {'$gte': cutoff}
        }).sort('taken_at', -1))

        for record in insulin_records:
            ts = record.get('taken_at') or record.get('created_at')
            if isinstance(ts, datetime):
                ts_iso = ts.strftime('%Y-%m-%dT%H:%M:%SZ')
            else:
                ts_iso = str(ts) if ts else now_iso

            dose = record.get('dose')
            if dose is None:
                continue

            med_admin = {
                "resourceType": "MedicationAdministration",
                "id": str(record['_id']),
                "status": "completed",
                "medication": {
                    "concept": {
                        "coding": [{
                            "system":  "http://snomed.info/sct",
                            "code":    "67866001",
                            "display": "Insulin (substance)"
                        }],
                        "text": record.get('medication', 'Insulin')
                    }
                },
                "subject":           {"reference": f"Patient/{pseudonym}"},
                "occurenceDateTime": ts_iso,
                "dosage": {
                    "text": f"{dose} U {record.get('medication', '')}".strip(),
                    "dose": {
                        "value":  float(dose),
                        "unit":   "U",
                        "system": "http://unitsofmeasure.org",
                        "code":   "U"
                    }
                }
            }
            entries.append({"resource": med_admin})

        # ── 4. Meal carbohydrate Observations ─────────────────────────────
        meal_records = list(mongo.db.meals.find({
            'user_id':   user_id_str,
            'timestamp': {'$gte': cutoff}
        }).sort('timestamp', -1))

        for record in meal_records:
            ts = record.get('timestamp')
            if isinstance(ts, datetime):
                ts_iso = ts.strftime('%Y-%m-%dT%H:%M:%SZ')
            else:
                ts_iso = str(ts)

            nutrition = record.get('nutrition', {})
            carbs   = nutrition.get('carbs')   if nutrition else record.get('carbs')
            protein = nutrition.get('protein') if nutrition else record.get('protein')
            fat     = nutrition.get('fat')     if nutrition else record.get('fat')

            if carbs is None:
                continue

            obs = {
                "resourceType": "Observation",
                "id": str(record['_id']),
                "status": "final",
                "category": [{
                    "coding": [{
                        "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code":    "survey",
                        "display": "Survey"
                    }]
                }],
                "code": {
                    "coding": [{
                        "system":  "http://loinc.org",
                        "code":    "9059-7",
                        "display": "Carbohydrate intake 24 hour"
                    }],
                    "text": "Carbohydrate intake"
                },
                "subject":          {"reference": f"Patient/{pseudonym}"},
                "effectiveDateTime": ts_iso,
                "valueQuantity": {
                    "value":  float(carbs),
                    "unit":   "g",
                    "system": "http://unitsofmeasure.org",
                    "code":   "g"
                }
            }

            # Optional macro components
            components = []
            if protein is not None:
                components.append({
                    "code": {
                        "coding": [{
                            "system":  "http://loinc.org",
                            "code":    "9067-0",
                            "display": "Protein intake 24 hour"
                        }]
                    },
                    "valueQuantity": {
                        "value": float(protein), "unit": "g",
                        "system": "http://unitsofmeasure.org", "code": "g"
                    }
                })
            if fat is not None:
                components.append({
                    "code": {
                        "coding": [{
                            "system":  "http://loinc.org",
                            "code":    "9065-4",
                            "display": "Fat intake 24 hour"
                        }]
                    },
                    "valueQuantity": {
                        "value": float(fat), "unit": "g",
                        "system": "http://unitsofmeasure.org", "code": "g"
                    }
                })
            if components:
                obs["component"] = components

            entries.append({"resource": obs})

        # ── 5. Activity sessions (LOINC 55423-8) ──────────────────────────
        # Only export completed sessions — skip expected, in_progress, abandoned.
        # Accept activities matched on either `timestamp` or `startTime` so that
        # both manually-logged and watch-synced sessions are included.
        activity_records = list(mongo.db.activities.find({
            'user_id': user_id_str,
            'type':    'completed',
            '$or': [
                {'timestamp': {'$gte': cutoff}},
                {'startTime': {'$gte': cutoff}},
            ]
        }).sort('timestamp', -1))

        hr_observations = []   # built in this loop, appended after activity obs

        for record in activity_records:
            # ── Resolve effective period ───────────────────────────────────
            start = record.get('startTime') or record.get('timestamp')
            end   = record.get('endTime')

            if isinstance(start, datetime):
                start_iso = start.strftime('%Y-%m-%dT%H:%M:%SZ')
            else:
                start_iso = str(start) if start else now_iso

            if isinstance(end, datetime):
                end_iso = end.strftime('%Y-%m-%dT%H:%M:%SZ')
            else:
                end_iso = str(end) if end else None

            duration_min = record.get('duration_minutes')
            intensity    = record.get('intensity', 'moderate')   # light | moderate | vigorous
            source       = record.get('source', '')              # google_fit | watch | manual
            record_id    = str(record['_id'])

            # ── Map intensity → SNOMED exercise concept ────────────────────
            # 229070002 Physical activity (observable entity) — used as fallback.
            # 415510000 Walking exercise / 415510000 used for light intentionally
            # kept simple; intensity detail lives in the component below.
            _intensity_snomed = {
                'light':    ('229070002', 'Physical activity, low intensity'),
                'moderate': ('229070002', 'Physical activity, moderate intensity'),
                'vigorous': ('229070002', 'Physical activity, vigorous intensity'),
            }
            snomed_code, snomed_display = _intensity_snomed.get(
                intensity, ('229070002', 'Physical activity')
            )

            act_obs: dict = {
                "resourceType": "Observation",
                "id":           f"act-{record_id}",
                "status":       "final",
                "category": [{
                    "coding": [{
                        "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code":    "activity",
                        "display": "Activity"
                    }]
                }],
                "code": {
                    "coding": [
                        {
                            "system":  "http://loinc.org",
                            "code":    "55423-8",
                            "display": "Number of steps in unspecified time Pedometer"
                        },
                        {
                            "system":  "http://snomed.info/sct",
                            "code":    snomed_code,
                            "display": snomed_display
                        }
                    ],
                    "text": f"Physical activity — {intensity}"
                },
                "subject": {"reference": f"Patient/{pseudonym}"},
                "effectivePeriod": {"start": start_iso},
                "component": [
                    # Intensity as free-text; no universally adopted LOINC panel
                    # for exercise intensity exists at FHIR R4 — plain text is
                    # interoperable and unambiguous.
                    {
                        "code": {
                            "coding": [{
                                "system":  "http://loinc.org",
                                "code":    "74008-4",
                                "display": "Exercise intensity"
                            }]
                        },
                        "valueString": intensity
                    }
                ]
            }

            if end_iso:
                act_obs["effectivePeriod"]["end"] = end_iso

            if duration_min is not None:
                act_obs["component"].append({
                    "code": {
                        "coding": [{
                            "system":  "http://loinc.org",
                            "code":    "55411-3",
                            "display": "Exercise duration"
                        }]
                    },
                    "valueQuantity": {
                        "value":  round(float(duration_min), 1),
                        "unit":   "min",
                        "system": "http://unitsofmeasure.org",
                        "code":   "min"
                    }
                })

            if source:
                act_obs["method"] = {"text": source}

            entries.append({"resource": act_obs})

            # ── 6. Heart-rate Observation derived from hr_trace ────────────
            # hr_trace is [{t_min, hr_bpm}] — per-minute bucket averages built
            # by _downsample_to_minutes() in watch_hr_routes.py.
            # We export the mean HR for the session as a single FHIR Observation
            # rather than one resource per minute to keep the bundle compact.
            # The full trace is available via GET /api/watch/hr/raw/<session_id>.
            hr_trace = record.get('hr_trace') or []
            if hr_trace:
                hr_values = [
                    pt['hr_bpm'] for pt in hr_trace
                    if isinstance(pt, dict) and pt.get('hr_bpm') is not None
                ]
                if hr_values:
                    mean_hr  = round(sum(hr_values) / len(hr_values), 1)
                    peak_hr  = round(max(hr_values), 1)

                    hr_obs: dict = {
                        "resourceType": "Observation",
                        "id":           f"hr-{record_id}",
                        "status":       "final",
                        "category": [{
                            "coding": [{
                                "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                                "code":    "vital-signs",
                                "display": "Vital Signs"
                            }]
                        }],
                        "code": {
                            "coding": [{
                                "system":  "http://loinc.org",
                                "code":    "8867-4",
                                "display": "Heart rate"
                            }],
                            "text": "Heart rate (exercise session mean)"
                        },
                        "subject":          {"reference": f"Patient/{pseudonym}"},
                        "effectiveDateTime": start_iso,
                        # Primary value: mean HR across the session
                        "valueQuantity": {
                            "value":  mean_hr,
                            "unit":   "beats/min",
                            "system": "http://unitsofmeasure.org",
                            "code":   "/min"
                        },
                        # Peak HR as a component — useful for intensity validation
                        "component": [{
                            "code": {
                                "coding": [{
                                    "system":  "http://loinc.org",
                                    "code":    "8873-2",
                                    "display": "Heart rate --peak exercise"
                                }]
                            },
                            "valueQuantity": {
                                "value":  peak_hr,
                                "unit":   "beats/min",
                                "system": "http://unitsofmeasure.org",
                                "code":   "/min"
                            }
                        }],
                        # Link back to the parent activity observation
                        "derivedFrom": [{"reference": f"Observation/act-{record_id}"}]
                    }

                    # Carry resting / max HR baselines when stored
                    hr_base = record.get('hr_base')
                    hr_max  = record.get('hr_max')
                    if hr_base is not None:
                        hr_obs["component"].append({
                            "code": {
                                "coding": [{
                                    "system":  "http://loinc.org",
                                    "code":    "40443-4",
                                    "display": "Heart rate --resting"
                                }]
                            },
                            "valueQuantity": {
                                "value":  round(float(hr_base), 1),
                                "unit":   "beats/min",
                                "system": "http://unitsofmeasure.org",
                                "code":   "/min"
                            }
                        })
                    if hr_max is not None:
                        hr_obs["component"].append({
                            "code": {
                                "coding": [{
                                    "system":  "http://loinc.org",
                                    "code":    "8873-2",
                                    "display": "Heart rate --max"
                                }]
                            },
                            "valueQuantity": {
                                "value":  round(float(hr_max), 1),
                                "unit":   "beats/min",
                                "system": "http://unitsofmeasure.org",
                                "code":   "/min"
                            }
                        })

                    hr_observations.append({"resource": hr_obs})

        # Append HR observations after all activity observations so the bundle
        # groups activity → HR pairs logically (activity obs first, then HR obs).
        entries.extend(hr_observations)

        # ── Assemble Bundle ───────────────────────────────────────────────
        bundle = {
            "resourceType": "Bundle",
            "id":           str(uuid.uuid4()),
            "type":         "collection",
            "timestamp":    now_iso,
            "meta": {
                "tag": [{
                    "system":  "https://diatwin.app/tags",
                    "code":    "pseudonymized",
                    "display": "Pseudonymized — compatible with MII Treuhandstelle workflows"
                }]
            },
            "entry": entries
        }

        counts = {
            "total_entries":    len(entries),
            "bg_readings":      len(bg_records),
            "insulin_doses":    len(insulin_records),
            "meal_records":     len(meal_records),
            "activity_sessions": len(activity_records),
            "hr_observations":   len(hr_observations),
            "days_exported":    days,
            "pseudonym":        pseudonym
        }
        logger.info(f"FHIR export: user={pseudonym} {counts}")

        response = current_app.response_class(
            response=__import__('json').dumps(bundle, default=str),
            status=200,
            mimetype='application/fhir+json'
        )
        response.headers['X-DiaTwin-Export-Version'] = '1.0'
        response.headers['X-DiaTwin-Pseudonymized']  = 'true'
        response.headers['X-DiaTwin-Entry-Count']    = str(len(entries))
        return response

    except Exception as e:
        logger.error(f"FHIR export error: {e}")
        return jsonify({"error": "FHIR export failed", "details": str(e)}), 500


# ─── GDPR Article 17 — Right to Erasure ──────────────────────────────────────

# All collections that hold patient medical/activity data
_PATIENT_DATA_COLLECTIONS = [
    # collection_name,  query_field
    ('blood_sugar',                'user_id'),
    ('meals',                      'user_id'),
    ('activities',                 'user_id'),
    ('medication_logs',            'patient_id'),
    ('medication_schedules',       'patient_id'),
    ('cgm_readings',               'user_id'),   # LibreLinkUp
    ('libre_connections',          'user_id'),
    ('watch_connections',          'user_id'),
    ('watch_activity_sessions',    'user_id'),
    ('custom_foods',               'user_id'),
]


def _delete_patient_data(user_id_str: str) -> dict:
    """
    Delete all medical data for a user across every collection.
    Returns a summary dict of deleted counts.
    """
    summary = {}
    for collection_name, field in _PATIENT_DATA_COLLECTIONS:
        try:
            result = mongo.db[collection_name].delete_many({field: user_id_str})
            summary[collection_name] = result.deleted_count
        except Exception as e:
            logger.warning(f"GDPR delete: could not clear {collection_name}: {e}")
            summary[collection_name] = 0
    return summary


@fhir_bp.route('/api/patient/data', methods=['DELETE'])
@token_required
def delete_all_data(current_user):
    """
    GDPR Article 17 — Delete all medical data, keep the user account.

    Body (JSON):
      { "confirm": "DELETE MY DATA" }

    Returns deletion summary per collection.
    """
    try:
        body = request.get_json(silent=True) or {}
        if body.get('confirm') != 'DELETE MY DATA':
            return jsonify({
                "error":   "Confirmation required",
                "message": 'Send { "confirm": "DELETE MY DATA" } to proceed'
            }), 400

        user_id_str = str(current_user['_id'])
        summary = _delete_patient_data(user_id_str)
        total   = sum(summary.values())

        logger.info(f"GDPR data delete: user={user_id_str} total_deleted={total}")
        return jsonify({
            "message":          "All medical data deleted. Your account remains active.",
            "gdpr_article":     "Article 17 — Right to Erasure",
            "deleted_counts":   summary,
            "total_deleted":    total,
            "account_status":   "active",
            "deleted_at":       datetime.now(timezone.utc).isoformat()
        }), 200

    except Exception as e:
        logger.error(f"GDPR data delete error: {e}")
        return jsonify({"error": "Data deletion failed", "details": str(e)}), 500


@fhir_bp.route('/api/patient/account', methods=['DELETE'])
@token_required
def delete_account(current_user):
    """
    GDPR Article 17 — Delete all medical data AND the user account entirely.

    Body (JSON):
      { "confirm": "DELETE MY ACCOUNT" }
    """
    try:
        body = request.get_json(silent=True) or {}
        if body.get('confirm') != 'DELETE MY ACCOUNT':
            return jsonify({
                "error":   "Confirmation required",
                "message": 'Send { "confirm": "DELETE MY ACCOUNT" } to proceed'
            }), 400

        user_id_str = str(current_user['_id'])

        # 1. Delete all medical data first
        summary = _delete_patient_data(user_id_str)

        # 2. Delete the user account document
        result = mongo.db.users.delete_one({"_id": current_user['_id']})
        summary['user_account'] = result.deleted_count

        total = sum(summary.values())
        logger.info(f"GDPR full account delete: user={user_id_str} total_deleted={total}")

        return jsonify({
            "message":        "Account and all associated data permanently deleted.",
            "gdpr_article":   "Article 17 — Right to Erasure",
            "deleted_counts": summary,
            "total_deleted":  total,
            "deleted_at":     datetime.now(timezone.utc).isoformat()
        }), 200

    except Exception as e:
        logger.error(f"GDPR account delete error: {e}")
        return jsonify({"error": "Account deletion failed", "details": str(e)}), 500