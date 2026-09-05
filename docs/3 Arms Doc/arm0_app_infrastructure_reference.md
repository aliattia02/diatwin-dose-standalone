# DiaTwin — Arm 0: App Infrastructure
**Reference Document — Current State**

```
================================================================
Scope
  Python:     config.py · main.py
              routes/auth_routes.py · utils/auth.py
              libre_scheduler.py · watch_scheduler.py
              routes/fhir_routes.py · routes/doctor_routes.py

Cross-references
  Arm 1 (Constants & Ingestion) owns: constants.py · shared-constants.ts
         · libre_routes._perform_sync() · watch_sync_service._perform_sync()
         → §4 and §5 of this document delegate sync logic there
  Arm 2 (Data Operations)   owns: pharmacodynamics.py · error_handler.py
         → @api_error_handler applied in doctor_routes (§7)
  Arm 3 (Visualization)     owns: chart components · useActiveEffects hook
         → no direct dependency on Arm 0; consumes Arm 1 and Arm 2 APIs
================================================================
```

---

## Table of Contents

- [§0 Architecture Overview](#0-architecture-overview)
- [§1 Configuration (`config.py`)](#1-configuration)
- [§2 App Bootstrap (`main.py`)](#2-app-bootstrap)
- [§3 Authentication (`auth_routes.py` + `auth.py`)](#3-authentication)
  - [§3.1 `generate_token()`](#31-generate_token)
  - [§3.2 `@token_required` decorator](#32-token_required-decorator)
  - [§3.3 Auth endpoints](#33-auth-endpoints)
- [§4 Libre Scheduler (`libre_scheduler.py`)](#4-libre-scheduler)
- [§5 Watch Scheduler (`watch_scheduler.py`)](#5-watch-scheduler)
- [§6 FHIR Routes (`fhir_routes.py`)](#6-fhir-routes)
  - [§6.1 `GET /api/export/fhir`](#61-get-apiexportfhir)
  - [§6.2 `DELETE /api/patient/data`](#62-delete-apipatientdata)
  - [§6.3 `DELETE /api/patient/account`](#63-delete-apipatientaccount)
  - [§6.4 Pseudonym helper](#64-pseudonym-helper)
- [§7 Doctor Routes (`doctor_routes.py`)](#7-doctor-routes)
  - [§7.1 `check_doctor_patient_access()`](#71-check_doctor_patient_access)
  - [§7.2 Patient management endpoints](#72-patient-management-endpoints)
  - [§7.3 Constants management endpoints](#73-constants-management-endpoints)
  - [§7.4 Clinical data endpoints](#74-clinical-data-endpoints)
- [§8 Cross-Arm References](#8-cross-arm-references)
- [§9 Developer Rules](#9-developer-rules)

---

## §0 Architecture Overview

```
FLASK BOOTSTRAP
───────────────
  create_app()  (main.py)
    ├─ create_app_config()      → CORS · MongoDB · secret key · token expiry
    ├─ Constants()              → process-level constant cache (→ Arm 1 §1.1)
    ├─ Blueprint registration   → 18 blueprints (see §2 table)
    ├─ /api/v1/* proxy          → mobile backwards-compatibility shim
    ├─ start_libre_scheduler()  → Arm 1 §9 CGM sync (→ §4)
    └─ start_watch_scheduler()  → Arm 1 §10 Google Fit sync (→ §5)

AUTHENTICATION LAYER
─────────────────────
  POST /login     → generate_token() (mobile=90d / web=24h)
                    + shared_constants embed on success
  POST /register  → hash password · seed DEFAULT_PATIENT_CONSTANTS
  @token_required → Bearer extraction · JWT decode · user lookup
  Patient ↔ Doctor consent endpoints (authorize / revoke)

FHIR / GDPR LAYER
──────────────────
  GET    /api/export/fhir    → pseudonymised FHIR R4 Bundle (application/fhir+json)
  DELETE /api/patient/data   → wipe medical data, keep account
  DELETE /api/patient/account→ wipe everything, delete account

DOCTOR LAYER
─────────────
  /api/doctor/*  → check_doctor_patient_access() guard on every route
                   reads: users · blood_sugar · activities · medication_logs
                   writes: users (constants / conditions / medications)
                           medication_logs (doctor-authored entries)

MONGODB COLLECTIONS (owned by Arm 0 indirectly via auth + doctor writes)
──────────────────────────────────────────────────────────────────────────
  users               accounts, hashed passwords, authorized_doctors list,
                      patient constants (written here; read by Arm 1)
  medication_logs     doctor-authored logs (POST /api/doctor/…/medication-log)
                      + patient insulin doses (written by medication_routes.py)

All other collections (blood_sugar, meals, activities, libre_connections,
watch_connections) are owned by Arm 1 but read by Arm 0 doctor and FHIR routes.
```

---

## §1 Configuration

**File:** `config.py`

### Required environment variables

| Variable | Where used | Notes |
|---|---|---|
| `MONGO_URI` | `PyMongo.init_app()` | MongoDB Atlas connection string. Absence raises `ValueError` at startup — the app will not boot. |
| `SECRET_KEY` | `jwt.encode()` / `jwt.decode()` | JWT signing key. Absence raises `ValueError` at startup. |

Neither value may be hardcoded anywhere in the codebase; they are loaded via `python-dotenv` locally and via Render environment settings in production.

### Token expiry constants

Set on `app.config` inside `create_app_config()`:

| Key | Value | Applied when |
|---|---|---|
| `TOKEN_EXPIRY` | `timedelta(hours=24)` | Default; web clients or any request without `X-Client-Type: mobile` |
| `MOBILE_TOKEN_EXPIRY` | `timedelta(days=90)` | Requests carrying `X-Client-Type: mobile` header |

`generate_token()` (→ §3.1) reads these keys from `current_app.config`. They must not be redeclared inline in `auth.py` or any route handler.

### `ALLOWED_ORIGINS`

Defined as a module-level list in `config.py`. Contains all permitted CORS origins: localhost variants (ports 3000, 5000, 8081–8083, 19000, 19006), the Render backend URL, and all Vercel PWA deployment URLs.

**Rule:** `ALLOWED_ORIGINS` must only be edited in `config.py`. It is the single source of truth for all CORS and preflight decisions. Never add origins in individual blueprints or route handlers.

### CORS setup

`flask_cors.CORS()` is initialised once in `create_app_config()` with `resources={r"/*": {...}}` covering all routes. Permitted methods: `GET POST PUT DELETE OPTIONS PATCH`. Permitted headers: `Content-Type Authorization Accept Origin X-Requested-With X-Client-Type`.

### `after_request` and `before_request` hooks

Both hooks are registered inside `create_app_config()` and apply globally:

`after_request` — runs on every outgoing response. If the request `Origin` is in `ALLOWED_ORIGINS`, it attaches the four standard CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`) plus `Access-Control-Expose-Headers`. This makes CORS explicit on every response rather than relying solely on the Flask-CORS middleware.

`before_request` — intercepts `OPTIONS` preflight requests before they reach any route handler. Returns `200` with all CORS headers immediately, using the request's `Origin` directly (defaulting to `http://localhost:3000` if absent). This prevents preflight from failing on routes decorated with `@token_required`.

### `PyMongo` initialisation chain

```
config.py:      mongo = PyMongo()        ← module-level, not yet bound to an app
create_app_config(app):
    app.config['MONGO_URI'] = MONGO_URI  ← must be set before init_app
    mongo.init_app(app)                  ← binds mongo to the app
    app.mongo = mongo                    ← stored on app for blueprint access
```

All blueprints access the database via `current_app.mongo.db.<collection>` or by importing `mongo` from `config` and using it inside an active app context. The `mongo` module-level object is safe to import anywhere; `mongo.db` is only valid inside an app context.

### `test_mongo_connection()` startup check

Called at the top of `create_app_config()` before any app configuration is applied. Creates a temporary `MongoClient`, issues an `admin.command('ping')`, logs success or failure, and closes the client. This is a diagnostic only — a failed ping logs an error but does not abort startup, allowing the app to boot and serve routes even if Atlas is momentarily unreachable.

---

## §2 App Bootstrap

**File:** `main.py`

### Blueprint registration table

All blueprints are registered with `url_prefix=''` — routes are defined at their full paths inside each blueprint.

| Blueprint object | Module | Key route prefix(es) |
|---|---|---|
| `food_routes` | `routes.food_routes` | `/api/food*` |
| `auth_routes` | `routes.auth_routes` | `/login` `/register` `/api/patient/*` `/api/doctors` |
| `doctor_routes` | `routes.doctor_routes` | `/api/doctor/*` |
| `patient_routes` | `routes.patient_routes` | `/api/patient/*` |
| `test_routes` | `routes.test_routes` | `/api/test/*` |
| `meal_insulin_bp` | `meal_insulin` | `/api/meal*` `/api/insulin*` |
| `activity_bp` | `activity` | `/api/record-activities` |
| `blood_sugar_bp` | `blood_sugar` | `/api/blood-sugar*` |
| `medication_routes` | `routes.medication_routes` | `/api/medication*` `/api/insulin/log` |
| `import_routes` | `routes.import_routes` | `/api/import/*` |
| `meal_bp` | `routes.meal_routes` | `/api/meal-on-board` |
| `cumulative_bp` | `routes.cumulative_effects_routes` | `/api/cumulative-effects` `/api/active-effects-full` |
| `activity_pd_bp` | `routes.activity_pharmacodynamics_routes` | `/api/activity/pharmacodynamics` |
| `libre_bp` | `routes.libre_routes` | `/api/libre/*` |
| `food_scan_bp` | `routes.food_scan_routes` | `/api/food-scan*` |
| `watch_hr_bp` | `routes.watch_hr_routes` | `/api/watch/hr/*` |
| `watch_sync_bp` | `routes.watch_sync_routes` | `/api/watch/sync/*` |
| `fhir_bp` | `routes.fhir_routes` | `/api/export/fhir` `/api/patient/data` `/api/patient/account` |

**Dev-only blueprint:** `watch_test_bp` from `routes.watch_test_routes` is registered only when `os.environ.get('RENDER')` is falsy (i.e., on local development machines). It is never loaded on the Render deployment. Its absence is non-fatal and is logged as a warning.

### `/api/v1/*` proxy

```python
@app.route('/api/v1/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def api_v1_proxy(path):
```

**Why it exists:** The React Native mobile app was initially deployed with all API calls using the `/api/v1/` prefix. The backend never used this prefix natively. Rather than updating all mobile call sites at once, this proxy strips the `/v1` segment and re-dispatches the request to the matching `/api/` route internally. It resolves the endpoint via `url_map.bind('').match()` without issuing a real HTTP redirect, so headers (including `Authorization`) are preserved. Any path that still has no match returns `404`.

This shim must remain until `services/api/endpoints.ts` is fully migrated to non-versioned paths (cross-reference Arm 1 §4.1).

### Scheduler startup sequence

After all blueprints are registered:

```
start_libre_scheduler(app)   ← §4 — CGM auto-sync every 4 min
start_watch_scheduler(app)   ← §5 — Google Fit auto-sync every 15 min
```

Each scheduler is started in a `try/except` block — a scheduler failure is logged as an error but does not prevent the app from serving requests. The two schedulers are independent; failure of one does not affect the other.

### `Constants.export_all_constants_safe()` — local-only behaviour

```python
if not os.environ.get('RENDER'):
    Constants.export_all_constants_safe()
```

This call writes the generated `shared-constants.ts` file to the frontend `constants/` directory on the developer's local machine. On Render, the frontend source tree does not exist and the call is skipped. Constants are delivered to mobile clients at login time via the `shared_constants` field in the login response (→ §3.3, `POST /login`). Cross-reference: Arm 1 §1.2 (shared-constants delivery chain) and Arm 1 Rule 7.

---

## §3 Authentication

**Files:** `routes/auth_routes.py` · `utils/auth.py`

### §3.1 `generate_token()`

**Signature:** `generate_token(user_id: str, user_type: str = "") -> str`

Reads the `X-Client-Type` request header. If its value is `"mobile"` (case-insensitive), it selects `MOBILE_TOKEN_EXPIRY` (90 days) from `current_app.config`; otherwise it selects `TOKEN_EXPIRY` (24 hours). Cross-reference: §1 token expiry constants.

The JWT payload:

```python
{
    "user_id":   str,    # MongoDB ObjectId string
    "user_type": str,    # 'patient' | 'doctor' | 'admin'
    "exp":       datetime,
    "mobile":    bool    # True when X-Client-Type: mobile
}
```

Encoded with `HS256` and `current_app.config["SECRET_KEY"]`. The `mobile` field is informational only — no backend logic branches on it. Token extension or refresh is not implemented; expired tokens require re-login.

`X-Client-Type: mobile` must be sent by `client.ts` on every API request from the React Native app to ensure the 90-day expiry is issued at login. Cross-reference: Arm 1 §4.2 (`client.ts`). Cross-reference Arm 4 (Mobile Auth) when written.

### §3.2 `@token_required` decorator

**File:** `utils/auth.py`

Applied as `@token_required` on all protected route handlers. The decorator wraps the route function, resolves `current_user`, and passes it as the first positional argument.

Full flow:

```
1. OPTIONS request?  → return {"status": "ok"}, 200 immediately
                       (CORS preflight must not trigger auth)

2. Read Authorization header
   → absent: return {"message": "Token is missing!"}, 401

3. Extract token
   → split on " " and take index [1]; fallback to full header value
   (supports both "Bearer <token>" and bare token strings)

4. jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
   → jwt.ExpiredSignatureError : return {"message": "Token has expired!"}, 401
   → jwt.InvalidTokenError     : return {"message": "Invalid token!"}, 401
   → any other Exception       : return {"message": "Token validation failed!"}, 401

5. users.find_one({"_id": ObjectId(data['user_id'])})
   → not found: return {"message": "User not found!"}, 401

6. Pass current_user (full MongoDB document) to the wrapped function
```

The `current_user` document contains all user fields from the `users` collection, including `user_type`, `_id`, `authorized_doctors` (for patients), and patient constants fields. Route handlers must not call `find_one` again to re-fetch fields that are already present on `current_user`.

### §3.3 Auth endpoints

#### `POST /login`

**Auth:** None (public)

Request body:
```json
{
  "username": "string",
  "password": "string",
  "user_type": "patient" | "doctor" | "admin"
}
```

Response `200`:
```json
{
  "message":          "Logged in successfully",
  "token":            "<JWT>",
  "user_type":        "patient" | "doctor" | "admin",
  "firstName":        "string",
  "lastName":         "string",
  "shared_constants": { ... }
}
```

The `shared_constants` field is populated by `Constants.get_shared_constants_json()`. It contains the same payload that `constants.py::export_all_constants_safe()` would write to `shared-constants.ts` — all 22 exported constant keys. This embed is the production mechanism for delivering constant updates to mobile clients: the constants file is not regenerated at runtime on Render, so the login response is the only reliable delivery channel. Cross-reference: Arm 1 §1.2 and Arm 1 Rule 7.

If `Constants.get_shared_constants_json()` raises, the field is set to `{}` and login still succeeds (warning logged).

Error responses: `400` (missing fields or invalid `user_type`), `401` (invalid credentials), `500` (unexpected error).

#### `POST /register`

**Auth:** None (public)

Required fields: `username`, `email`, `password`, `firstName`, `lastName`, `dateOfBirth`, `user_type`.

For `user_type == 'patient'`, all fields from `Constants.DEFAULT_PATIENT_CONSTANTS` (excluding `meal_absorption_profiles`) are seeded into the user document at creation time. `authorized_doctors` is initialised to `[]`.

Password is stored as a `werkzeug`-generated scrypt hash (`generate_password_hash`). Never stored in plaintext.

Response `201`: `{ "message": "User registered successfully", "id": "<ObjectId>" }`

Error responses: `400` (missing field, invalid user_type, duplicate username or email), `500`.

#### `GET /api/doctors`

**Auth:** `@token_required`, patient only (403 for non-patients)

Returns all users with `user_type == "doctor"`. Password field excluded.

Response `200`: array of `{ id, firstName, lastName, email }`.

#### `GET /api/patient/authorized-doctors`

**Auth:** `@token_required`, patient only

Returns details of all doctors in the authenticated patient's `authorized_doctors` list, resolved from the `users` collection.

Response `200`: array of `{ id, firstName, lastName, email }`. Doctors whose ObjectId is no longer valid are silently skipped.

#### `POST /api/patient/authorize-doctor`

**Auth:** `@token_required`, patient only

Request body: `{ "doctor_id": "<ObjectId string>" }`

Verifies the doctor exists in the `users` collection with `user_type == "doctor"`, then:

```python
users.update_one(
    {"_id": current_user['_id']},
    {"$addToSet": {"authorized_doctors": doctor_id}}
)
```

`$addToSet` is used deliberately — the operation is idempotent. Calling this endpoint multiple times for the same doctor does not create duplicate entries. Do not replace with `$push`.

Response `200`: `{ "message": "Doctor authorized successfully", "doctor": { id, firstName, lastName } }`.

Error responses: `400` (missing doctor_id), `403` (non-patient caller), `404` (doctor not found), `500`.

#### `POST /api/patient/revoke-doctor`

**Auth:** `@token_required`, patient only

Request body: `{ "doctor_id": "<ObjectId string>" }`

```python
users.update_one(
    {"_id": current_user['_id']},
    {"$pull": {"authorized_doctors": doctor_id}}
)
```

Returns `200` in both the modified and no-op cases (doctor was not in the list). This is intentional — revoke is idempotent from the caller's perspective.

---

## §4 Libre Scheduler

**File:** `libre_scheduler.py`

### Startup

Called once from `create_app()` after all blueprints are registered:

```python
from libre_scheduler import start_libre_scheduler
start_libre_scheduler(app)
```

Returns a `BackgroundScheduler` instance. Raises on failure (caught by `create_app`'s try/except — non-fatal to app startup). The scheduler must not be started a second time within the same process; APScheduler will raise if `replace_existing=False`. The job is registered with `replace_existing=True` as a safety measure, but `start_libre_scheduler` itself must only be called once.

### Polling interval

`SCHEDULER_INTERVAL_MINUTES = 4`. The job wakes every 4 minutes. This value must be less than or equal to the shortest `sync_interval_minutes` any user can set (minimum 4 minutes, enforced by `MIN_SYNC_INTERVAL_MINUTES = 4`). Users whose sync is not due at wake time are skipped silently.

### Render keep-alive ping

`_ping_self()` is called first in every job execution, before any database work. It makes an outbound `GET` to `{RENDER_EXTERNAL_URL}/api/health` (defaulting to `https://native-3y3j.onrender.com`). This resets Render's 15-minute free-tier hibernation timer. APScheduler jobs execute inside the process and are invisible to Render's inbound traffic detector; without this ping, the instance sleeps regardless of scheduler activity.

### Relationship to `_perform_sync()`

The job calls `libre_routes._perform_sync(user_id, conn)` for each due connection. `_perform_sync` is defined in `routes/libre_routes.py` and owns the full LibreLinkUp API call and database write logic. Cross-reference: Arm 1 §9.

`_perform_sync` must not be called directly from any location other than `_run_auto_syncs()` and the `POST /api/libre/sync` route handler. Calling it outside these two contexts bypasses the per-user interval check and the connection document lookup.

### APScheduler job settings

```python
job_defaults = {
    "coalesce":          True,   # merge missed runs into one
    "max_instances":     1,      # never run two sync jobs in parallel
    "misfire_grace_time": 60,    # if delayed up to 60 s, still run
}
```

---

## §5 Watch Scheduler

**File:** `watch_scheduler.py`

Structure mirrors `libre_scheduler.py` exactly. Key differences:

### Polling interval

`SCHEDULER_INTERVAL_MINUTES = 15`. Google Fit data is delivered in 1-minute bucket granularity by the Fit API; polling more frequently than every 15 minutes provides no new data. `MIN_SYNC_INTERVAL_MINUTES = 15`.

### Misfire grace time

Set to `120` seconds (vs 60 for Libre). Google Fit API calls may be slower; the larger window prevents missed runs from being discarded if the previous job ran long.

### Relationship to `_perform_sync()`

Calls `services.watch_sync_service._perform_sync(user_id, conn)`. Cross-reference: Arm 1 §10.

Same call-site restriction applies as for the Libre scheduler: `_perform_sync` from `watch_sync_service` must not be called directly outside `_run_watch_syncs()` and the watch sync route handler.

### Render keep-alive ping

Identical to §4. Both schedulers independently ping `/api/health`. With Libre polling every 4 minutes, the combined effect is a ping roughly every 4 minutes, which comfortably prevents the 15-minute hibernation timer from expiring.

---

## §6 FHIR Routes

**File:** `routes/fhir_routes.py`

Blueprint: `fhir_bp`. All three routes require `@token_required` (→ §3.2). No role restriction: both patients and doctors can call these endpoints for the authenticated user's own data.

### §6.1 `GET /api/export/fhir`

**Auth:** `@token_required`

**Query parameters:**

| Param | Type | Default | Constraint |
|---|---|---|---|
| `days` | int | 30 | 1–90; values outside this range return 400 |

**Collections read:**

| Collection | Filter |
|---|---|
| `blood_sugar` | `user_id == user_id_str`, `timestamp >= cutoff` |
| `medication_logs` | `patient_id == user_id_str`, `is_insulin == True`, `taken_at >= cutoff` |
| `meals` | `user_id == user_id_str`, `timestamp >= cutoff` |
| `activities` | `user_id == user_id_str`, `type == 'completed'`, `timestamp >= cutoff OR startTime >= cutoff` |

**Encrypted field exclusion:** The `libre_connections` collection is never read by this route. Fields `email_encrypted`, `password_encrypted`, and `auth_token` from `libre_connections` must never appear in FHIR output. Cross-reference: Arm 1 §12 `libre_connections` schema.

**Bundle structure (FHIR R4 `collection` type):**

The response is ordered as follows within `entry[]`:

```
1  × Patient resource          (pseudonymised, no PII)
N  × Observation               (blood glucose, LOINC 15074-8, mg/dL)
N  × MedicationAdministration  (insulin doses, SNOMED 67866001)
N  × Observation               (meal carbs, LOINC 9059-7; protein/fat as components)
N  × Observation               (activity sessions, LOINC 55423-8 + SNOMED 229070002)
N  × Observation               (HR mean/peak per session, LOINC 8867-4; derived from hr_trace)
```

Activity observations are appended before HR observations so each activity entry is logically adjacent to its derived HR entry in the bundle.

**Response headers:**

```
Content-Type:              application/fhir+json
X-DiaTwin-Pseudonymized:   true
X-DiaTwin-Export-Version:  1.0
X-DiaTwin-Entry-Count:     <int>
```

The response is built with `current_app.response_class(...)` to set `mimetype='application/fhir+json'` explicitly (Flask's `jsonify` always returns `application/json`).

**MII Treuhandstelle compatibility:** The Patient resource carries the MII Core Person profile URI in `meta.profile` and a `pseudonymized` tag. The patient's name, birthDate, email, and address are intentionally omitted.

### §6.2 `DELETE /api/patient/data`

**Auth:** `@token_required`

**Body:** `{ "confirm": "DELETE MY DATA" }` — exact string match required. Any other value or missing body returns `400`.

Calls `_delete_patient_data(user_id_str)`, which iterates `_PATIENT_DATA_COLLECTIONS` and calls `delete_many` on each:

| Collection | Query field |
|---|---|
| `blood_sugar` | `user_id` |
| `meals` | `user_id` |
| `activities` | `user_id` |
| `medication_logs` | `patient_id` |
| `medication_schedules` | `patient_id` |
| `cgm_readings` | `user_id` |
| `libre_connections` | `user_id` |
| `watch_connections` | `user_id` |
| `watch_activity_sessions` | `user_id` |
| `custom_foods` | `user_id` |

Failures on individual collections are caught and logged as warnings; a count of `0` is recorded for that collection and processing continues. The user account in `users` is **not** deleted.

Response `200`:
```json
{
  "message":        "All medical data deleted. Your account remains active.",
  "gdpr_article":   "Article 17 — Right to Erasure",
  "deleted_counts": { "<collection>": <int>, ... },
  "total_deleted":  <int>,
  "account_status": "active",
  "deleted_at":     "<ISO UTC>"
}
```

### §6.3 `DELETE /api/patient/account`

**Auth:** `@token_required`

**Body:** `{ "confirm": "DELETE MY ACCOUNT" }` — exact string match required.

Calls `_delete_patient_data(user_id_str)` (same as §6.2) then additionally:

```python
mongo.db.users.delete_one({"_id": current_user['_id']})
```

The deleted count for the user document is recorded under `"user_account"` in the summary. After this endpoint returns, the JWT used to call it is invalidated de facto (the user document no longer exists, so `@token_required` will return 401 on any subsequent request with the same token).

### §6.4 Pseudonym helper

```python
def generate_pseudonym(user_id: str) -> str:
    digest = int(hashlib.sha256(user_id.encode()).hexdigest(), 16)
    return f"DIATWIN-PT-{digest % 99999:05d}"
```

Deterministic: the same `user_id` always produces the same pseudonym. The format `DIATWIN-PT-XXXXX` (5-digit zero-padded) is safe to log and include in FHIR resources. It does not expose PII and cannot be reversed to recover the MongoDB ObjectId without access to the full SHA-256 preimage space.

---

## §7 Doctor Routes

**File:** `routes/doctor_routes.py`

Blueprint: `doctor_routes`. All routes require `@token_required` and `@api_error_handler` (from `utils/error_handler` — cross-reference Arm 2 §2.3). Patient data access is additionally gated by `check_doctor_patient_access()`.

### §7.1 `check_doctor_patient_access()`

```python
def check_doctor_patient_access(current_user, patient_id)
    -> (has_access: bool, error_response: dict | None, status_code: int | None)
```

Access rules:

```
user_type == 'admin'  → True (admin sees all patients)
user_type != 'doctor' → False, 403 "Unauthorized access"
user_type == 'doctor':
    patient = users.find_one({"_id": ObjectId(patient_id)})
    patient not found  → False, 404 "Patient not found"
    doctor_id NOT in patient['authorized_doctors']
                       → False, 403 "You are not authorized..."
    doctor_id IN patient['authorized_doctors']
                       → True
```

`authorized_doctors` is a list of doctor ObjectId strings stored on the patient document in the `users` collection. Cross-reference: §3.3 `POST /api/patient/authorize-doctor` (which populates this list).

Every doctor route handler calls `check_doctor_patient_access()` before any database read or write. Bypassing this call for any new route is a security violation.

### §7.2 Patient management endpoints

#### `GET /api/doctor/patients`

**Auth:** `@token_required`, doctor or admin only (403 for patients)

Admins receive all users with `user_type == "patient"`. Doctors receive only patients whose `authorized_doctors` list contains the doctor's ObjectId string.

Response `200`: array of `{ id, firstName, lastName, email, activeConditions, activeMedications }`. Password field excluded from MongoDB projection.

#### `POST /api/doctor/patient/<patient_id>/medication-log`

**Auth:** `@token_required` + `check_doctor_patient_access`

Request body: `{ "medication": str, "taken_at": ISO string, "next_dose": ISO string }`

Writes to `medication_logs` with `created_by` set to the doctor's ObjectId string and `created_at` set to `datetime.utcnow()`. Returns `201` with the new document ID.

#### `GET /api/doctor/patient/<patient_id>/medication-log`

**Auth:** `@token_required` + `check_doctor_patient_access`

Returns all entries in `medication_logs` where `patient_id` matches, sorted by `taken_at` descending.

Response `200`: `{ "logs": [{ id, medication, taken_at, next_dose }, ...] }`.

### §7.3 Constants management endpoints

All endpoints below gate on `check_doctor_patient_access` and invalidate the process-level constants cache via `Constants.invalidate_patient_cache(patient_id)` after any write. Cross-reference: Arm 1 §1.1 (cache TTL and `invalidate_patient_cache`).

#### `GET /api/doctor/patient/<patient_id>/constants`

Reads the patient document from `users` and merges per-patient values with `Constants.DEFAULT_PATIENT_CONSTANTS` as fallback. Includes `medication_factors` merge (patient values overlay defaults). Returns `{ "constants": { ... } }`.

#### `PUT /api/doctor/patient/<patient_id>/constants`

Validates and writes patient constants. Numeric fields (`insulin_to_carb_ratio`, `correction_factor`, `target_glucose`, `protein_factor`, `fat_factor`, `carb_to_bg_factor`) must be positive numbers. `daily_reset_hour` must be an integer 0–23. `disease_factors` keys must exist in `Constants.DEFAULT_PATIENT_CONSTANTS['disease_factors']`. `medication_factors` keys must exist in `Constants.DEFAULT_PATIENT_CONSTANTS['medication_factors']`.

Writes via `$set` to the patient's `users` document. Returns updated constants.

#### `POST /api/doctor/patient/<patient_id>/constants/reset`

Resets all constants to `ConstantConfig()` defaults using `$set`. Clears `active_conditions` and `active_medications` to `[]`. Invalidates cache. Returns reset constant values.

#### `PUT /api/doctor/patient/<patient_id>/conditions`

Replaces `active_conditions` on the patient document. All supplied condition names must exist as keys in `Constants.DEFAULT_PATIENT_CONSTANTS['disease_factors']`; invalid names return `400` with the list of valid conditions.

#### `PUT /api/doctor/patient/<patient_id>/medications`

Replaces `active_medications` on the patient document. All supplied medication names must exist as keys in `Constants.DEFAULT_PATIENT_CONSTANTS['medication_factors']`; invalid names return `400` with the list of valid medications.

### §7.4 Clinical data endpoints

All endpoints below gate on `check_doctor_patient_access`.

#### `GET /api/doctor/patient/<patient_id>/blood-sugar`

**Collections read:** `blood_sugar` (`user_id == patient_id`)

**Query parameters:**

| Param | Type | Notes |
|---|---|---|
| `start_time` | ISO datetime | Preferred; maps to `timestamp >= start_datetime` |
| `end_time` | ISO datetime | Preferred; maps to `timestamp < end_datetime` |
| `start_date` | `YYYY-MM-DD` | Fallback if `start_time` absent |
| `end_date` | `YYYY-MM-DD` | Fallback if `end_time` absent; upper bound is exclusive (`+ timedelta(days=1)`) |

`start_time` / `end_time` take precedence over `start_date` / `end_date` when both are present. No `.limit()` is applied — the date filter bounds the result set. Results sorted by `timestamp` descending.

Response `200`: array of `{ _id, bloodSugar, status, target, notes, timestamp, bloodSugarTimestamp? }`. `bloodSugarTimestamp` is included only when the field is present on the document (it reflects the patient-measured time vs the server-write `timestamp`).

#### `GET /api/doctor/patient/<patient_id>/activity-history`

**Collections read:** `activities` (`user_id == patient_id`)

**Query parameters:** `limit` (int, default 50), `skip` (int, default 0)

Response `200`: array of `{ id, activityType, activityLevel, duration, notes, timestamp, caloriesBurned?, intensityLevel?, heartRate? }`. Optional fields are included only when present on the document.

#### `GET /api/doctor/patient/<patient_id>/insulin`

**Collections read:** `medication_logs` (`patient_id == patient_id`, `is_insulin == True`)

**Query parameters:** `limit` (int, default 100), `start_date` (ISO), `end_date` (ISO)

Date filter applies to the `taken_at` field. The `insulin_doses` collection is never populated anywhere in the codebase; all insulin doses land in `medication_logs` with `is_insulin=True`.

Response `200`:
```json
{
  "doses": [
    {
      "id":             "<ObjectId>",
      "insulinType":    "string",
      "units":          <float>,
      "timestamp":      "<ISO>",
      "doseTime":       "<ISO>",
      "notes":          "string | null",
      "iobContribution": <float | null>
    }
  ]
}
```

`doseTime` is an alias of `timestamp` provided for compatibility with frontend paths that expect this field name. The `insulinType` field is resolved with priority: `medication` → `insulin_type` → `insulinType` → `"unknown"`.

---

## §8 Cross-Arm References

### Arm 0 owns (this document)

- Flask app factory (`create_app`), blueprint registration, `/api/v1/*` proxy
- All CORS and environment configuration (`config.py`)
- JWT token generation and validation (`auth.py`, `generate_token`, `@token_required`)
- All authentication and consent endpoints (`auth_routes.py`)
- Background scheduler lifecycle management (`libre_scheduler.py`, `watch_scheduler.py`)
- FHIR R4 export and GDPR erasure endpoints (`fhir_routes.py`)
- Doctor–patient access control guard (`check_doctor_patient_access`) and all doctor-facing API routes (`doctor_routes.py`)
- `users` collection writes (registration, constants updates, authorized_doctors management)
- `medication_logs` writes (doctor-authored entries via `POST /api/doctor/…/medication-log`)

### Arm 1 owns (Constants & Ingestion)

- `constants.py`, `Constants` class, `ConstantConfig` dataclass (referenced in §2, §3.3, §7.3)
- `_perform_sync()` for both LibreLinkUp (`libre_routes.py`) and Google Fit (`watch_sync_service.py`) — called by schedulers in §4 and §5
- All ingestion routes (blood sugar, meals, activities, imports, Libre, watch)
- MongoDB document schemas for `blood_sugar`, `meals`, `activities`, `libre_connections`, `watch_connections`

### Arm 2 owns (Data Operations)

- `@api_error_handler` decorator applied on all doctor routes (§7)
- `pharmacodynamics.py` and `activity_pharmacodynamics.py` — no direct dependency from Arm 0
- Doctor-facing TypeScript service layer (`services/api/doctor.ts`, `services/api/doctor-management.ts`)

### Arm 3 owns (Visualization)

- No direct dependency on Arm 0. Arm 3 components consume Arm 1 ingestion APIs and Arm 2 calculation APIs.

---

## §9 Developer Rules

These are permanent invariants. They are stated as rules, not history.

**Secrets and environment**

1. `SECRET_KEY` and `MONGO_URI` must never be hardcoded anywhere in the codebase — not in source files, not in comments, not in test fixtures committed to version control. They are loaded exclusively from environment variables. Absence of either raises `ValueError` at startup by design.

2. `ALLOWED_ORIGINS` must be edited only in `config.py`. No route handler, blueprint, or middleware may add, remove, or override allowed origins. All CORS decisions flow from the single list in `config.py`.

**Schedulers**

3. `start_libre_scheduler(app)` and `start_watch_scheduler(app)` must each be called exactly once, after all blueprints are registered in `create_app()`. Calling either a second time (e.g., from a blueprint or a test fixture that also creates the app) will register a duplicate job. APScheduler's `replace_existing=True` prevents a crash but does not prevent the second scheduler instance from running.

4. `_perform_sync()` (from both `libre_routes` and `watch_sync_service`) must not be called directly from any location other than its scheduler job function and the corresponding manual-trigger route handler (`POST /api/libre/sync` and the watch sync equivalent). Callers outside these two contexts bypass the per-user interval check, the connection document lookup, and the `last_sync` update.

**FHIR and GDPR**

5. FHIR export (`GET /api/export/fhir`) must never include `email_encrypted`, `password_encrypted`, or `auth_token` from the `libre_connections` collection. The route does not read `libre_connections` at all; this invariant must be preserved if the bundle is ever extended. Cross-reference: Arm 1 §12 `libre_connections` schema.

6. The `_PATIENT_DATA_COLLECTIONS` list in `fhir_routes.py` is the authoritative inventory for GDPR erasure. When a new collection storing patient medical data is introduced anywhere in the codebase, it must be added to this list before the feature is deployed.

7. GDPR erasure endpoints (`DELETE /api/patient/data` and `DELETE /api/patient/account`) must always require exact-string confirmation bodies (`"DELETE MY DATA"` / `"DELETE MY ACCOUNT"`). This confirmation check must not be weakened or made optional.

**Authentication**

8. `X-Client-Type: mobile` must be included in every request sent by `client.ts` in the React Native app. Without it, the login endpoint issues a 24-hour token and the user will be logged out unexpectedly. Cross-reference: Arm 1 §4.2 (`client.ts`). Cross-reference Arm 4 (Mobile Auth) when written.

9. The `@token_required` decorator must skip authentication for `OPTIONS` requests. Removing this guard will cause CORS preflight to fail with a 401, breaking all cross-origin API access from the web PWA.

10. `traceback.format_exc()` must never appear in any HTTP response body, including `500` error responses. Error details sent to clients must be limited to `str(e)` at most. Cross-reference: Arm 1 Rule 14.

**Doctor access control**

11. `check_doctor_patient_access(current_user, patient_id)` must be called before any database read or write in every doctor route handler. No new route in `doctor_routes.py` may be added without this guard. The three-tuple return `(has_access, error_response, status_code)` must be checked with `if not has_access: return jsonify(error_response), status_code` as the first statement in the route body.

12. All doctor-facing data retrieval routes must use the `/api/doctor/patient/<patient_id>/…` URL prefix. Doctor tokens will receive 404 from patient-scoped routes (`/api/patient/<id>/…`). Cross-reference: Arm 2 Rule 29.

**Patient consent**

13. `$addToSet` is the required operator for `POST /api/patient/authorize-doctor`. Replacing it with `$push` would allow duplicate entries in `authorized_doctors`, causing `check_doctor_patient_access()` to behave correctly but producing redundant data. The idempotent semantics of `$addToSet` are intentional.

**Constants cache**

14. Any doctor route that writes to a patient's constants fields in `users` (`PUT /api/doctor/patient/<patient_id>/constants`, `POST …/constants/reset`, `PUT …/conditions`, `PUT …/medications`) must call `Constants.invalidate_patient_cache(patient_id)` immediately after the `update_one` call. Without invalidation, the calculation engine serves stale constants for up to 60 seconds (the `_PATIENT_CONSTANTS_CACHE` TTL). Cross-reference: Arm 1 §1.1.

**Blueprint registration**

15. New blueprints must be appended to the `blueprints` list in `create_app()`. Registering a blueprint outside this list (e.g., inline in a module or conditionally inside a route) creates a hidden startup dependency that is invisible to the registration log and cannot be verified by inspection of `main.py` alone. The dev-only `watch_test_bp` is the sole permitted exception, and its exclusion from Render is enforced by the `os.environ.get('RENDER')` guard.
