DiaTwin — Comprehensive Documentation Brief
1. PROJECT OVERVIEW
DiaTwin is a Type 1 Diabetes (T1D) management platform that combines a Flask REST API backend, a React web frontend (PWA), and a React Native mobile app (Expo) to help patients track insulin doses, meals, blood glucose readings, and physical activity — and to predict future glycaemic trajectories using proprietary pharmacokinetic/pharmacodynamic (PK/PD) models.

Problem it solves / Audience: People living with T1D (and their treating physicians) need real-time awareness of how much insulin and how many carbohydrates are currently "on board" — i.e., still active in the body — so they can make safer dosing decisions. DiaTwin automates these calculations and also integrates with the Abbott FreeStyle Libre continuous glucose monitor (CGM) via the unofficial LibreLinkUp API.

Maturity level: Late beta / pre-production. Core features are functional and deployed on Render (free tier), but the codebase carries active development artefacts (multiple *_SUMMARY.md files, comparison component variants, scaffolding scripts) and no formal versioning/release process is evident.

2. TECH STACK & DEPENDENCIES
Languages & Runtimes
Layer	Language / Runtime	Notes
Backend	Python 3.x	Flask microframework
Web frontend	JavaScript (React 18)	Create React App (CRA)
Mobile app	TypeScript / React Native	Expo SDK ~54, Expo Router v6
Backend Dependencies (backend/requirements.txt)
Package	Version	Role
Flask	3.1.1	Web framework
flask-cors	6.0.1	Cross-origin request headers
Flask-PyMongo	3.0.1	MongoDB ORM wrapper
pymongo	4.13.2	MongoDB driver
PyJWT	2.10.1	JWT token generation/validation
python-dotenv	1.2.1	.env file loading
gunicorn	25.1.0	Production WSGI server (Render)
APScheduler	3.11.2	Background job scheduler (Libre auto-sync)
anthropic	0.86.0	Claude Vision SDK (food scanning)
google-genai	latest	Gemini 2.5-flash Vision (food scanning, replaces google-generativeai)
cryptography	45.0.5	Fernet symmetric encryption (Libre credentials at rest)
tzlocal	5.3.1	Timezone detection
pydantic	2.12.5	Data validation
requests	2.32.5	Outbound HTTP (Libre API, keep-alive ping)
Werkzeug	3.1.3	WSGI utilities
Mobile Dependencies (mobile/package.json)
Package	Version	Role
expo	~54.0.0	Managed workflow framework
expo-router	~6.0.15	File-system based navigation
react-native	0.81.5	Native UI layer
zustand	^5.0.0	Global state management
axios	^1.7.9	HTTP client
expo-secure-store	~15.0.7	Encrypted token/credential storage
expo-notifications	~0.32.13	Push notifications
expo-image-picker	~17.0.10	Camera / gallery access (food scanning)
victory-native	^37.3.6	Charts
react-native-chart-kit	^6.12.0	Charts (secondary)
date-fns	^4.1.0	Date formatting
@react-native-async-storage/async-storage	2.2.0	Offline data persistence
@react-native-community/netinfo	11.4.1	Network state detection
Web Frontend Dependencies (frontend/package.json)
Package	Version	Role
react	^18.3.1	UI library
react-router-dom	^6.26.2	Client-side routing
axios	^1.7.7	HTTP client
chart.js + react-chartjs-2	^4.4.7 / ^5.2.0	Charts
recharts	^2.12.7	Secondary charts
moment	^2.30.1	Date utilities
date-fns	^4.1.0	Date utilities
regression	^2.0.1	Trend-line calculations
Non-obvious tooling choices
APScheduler inside the Flask process — used to periodically ping the deployed Render URL (/api/health) because Render free-tier dynos hibernate after 15 minutes of inactivity. The scheduler is simultaneously a background sync worker and a keep-alive mechanism.
google-genai (not google-generativeai) — the codebase migrated to the newer SDK; the comment in food_scan_service.py explicitly flags the old package as deprecated.
Expo Router (file-system routing) — rather than React Navigation's configuration-based approach, routes are inferred from the mobile/app/ directory tree.
3. ARCHITECTURE & STRUCTURE
Top-level layout
Code
native/
├── backend/              Flask REST API (Python)
│   ├── main.py           Application factory + blueprint registration
│   ├── config.py         Flask config, MongoDB, CORS, secrets
│   ├── constants.py      Centralized PK/PD constants (single source of truth)
│   ├── time_manager.py   Timezone-aware time utilities
│   ├── blood_sugar.py    Blood-sugar CRUD + baseline calculations
│   ├── meal_insulin.py   Legacy meal+insulin endpoints (Blueprint)
│   ├── activity.py       Activity recording endpoints
│   ├── libre_scheduler.py APScheduler background job
│   ├── models/           Pydantic-style data helpers (food_data.py)
│   ├── routes/           Flask Blueprints
│   │   ├── auth_routes.py
│   │   ├── meal_routes.py
│   │   ├── medication_routes.py  (also hosts all insulin endpoints)
│   │   ├── patient_routes.py
│   │   ├── doctor_routes.py
│   │   ├── food_routes.py
│   │   ├── food_scan_routes.py
│   │   ├── libre_routes.py
│   │   ├── cumulative_effects_routes.py
│   │   ├── import_routes.py
│   │   └── test_routes.py
│   ├── services/
│   │   ├── libre_service.py      LibreLinkUp API client
│   │   ├── food_scan_service.py  Gemini Vision food analysis
│   │   └── food_service.py       Food database queries
│   ├── utils/
│   │   ├── auth.py               JWT decorator + token generation
│   │   ├── error_handler.py      Decorator wrapping routes in try/except
│   │   └── pharmacodynamics.py   Core PK/PD calculation engine
│   └── tests/
│       └── test_mob_iob_integration.py
│
├── mobile/               React Native / Expo application (TypeScript)
│   ├── app/              Expo Router pages (file-system routes)
│   │   ├── index.tsx     Root redirect (auth guard)
│   │   ├── _layout.tsx   Root layout
│   │   ├── (auth)/       Login, register, forgot-password
│   │   └── (app)/        Authenticated area
│   │       ├── (tabs)/   Bottom tab navigator
│   │       │   ├── index.tsx         Dashboard
│   │       │   ├── log.tsx           Log entry selector
│   │       │   ├── history.tsx       History view
│   │       │   ├── visualization.tsx Charts
│   │       │   ├── profile.tsx       User profile
│   │       │   └── doctor-dashboard.tsx
│   │       ├── log/      Logging sub-screens (meal, insulin, glucose, activity)
│   │       ├── meal/     Meal detail ([id].tsx dynamic route)
│   │       └── settings/ (libre, medications, doctors, export, food-database, constants)
│   ├── components/       Reusable UI components (charts, dashboard, forms, meal, ui, doctor, debug)
│   ├── services/api/     API service layer (one file per resource)
│   ├── store/            Zustand stores (auth, patient, meal, offline)
│   ├── hooks/            Custom React hooks
│   ├── types/            TypeScript interfaces
│   ├── utils/            Helpers (storage, calculations, glucose, insulin, time, validation)
│   └── constants/        Theme, shared-constants, index
│
├── frontend/             React web app (JavaScript/CRA)
│   └── src/
│       ├── App.js        Root router
│       └── components/   ~30 components (Dashboard, Doctor, Charts, etc.)
│
├── scripts/              Utility scripts (food database import, food-scan scaffolding)
└── security-reports/     Architecture and strategy documents
Architectural pattern
The project is a monorepo with three independent tiers:

Backend — classic Flask "Blueprint" architecture. Each domain has its own blueprint file. No ORM — raw PyMongo is used against MongoDB Atlas.
Mobile — file-system-routed React Native with a Zustand global store and a custom hook layer that sits between the store and the UI.
Web frontend — standard CRA React SPA; uses React Context + local state (no Redux/Zustand).
Main entry points
Tier	Entry point	Notes
Backend (dev)	backend/main.py	app.run() on port 5000
Backend (prod)	gunicorn backend.main:app	Render runs this via Procfile or Render service config
Mobile	mobile/app/index.tsx	Expo Router root; redirects to (auth)/login or (app)
Web	frontend/src/App.js	React Router with <BrowserRouter>
Data flow (typical patient session)
Code
Mobile App (React Native)
  │  POST /login  →  JWT token returned
  ▼
useAuthStore (Zustand)  →  stores token in expo-secure-store
  │
  ├─ GET /api/patient/constants  →  patient PK/PD parameters cached in usePatientStore
  │
  ├─ POST /api/meal              →  meal logged, stored in MongoDB `meals` collection
  │
  ├─ GET /api/meal-on-board      →  backend walks recent meals, runs gamma absorption
  │       integration → returns MOB (active_carbs) + absorbed_carbs
  │
  ├─ POST /api/insulin/log       →  dose logged in `medication_logs`
  │
  ├─ GET /api/insulin/active-effect  →  backend runs IOB trapezoidal integration
  │                                     returns IOB + absorbed_insulin
  │
  └─ POST /api/blood-sugar       →  reading stored; backend computes
                                     baseline = BG − (meal_impact − insulin_impact)
                                     and attaches `baseline_calculation` metadata
4. CORE MODULES & KEY FILES
Backend
backend/main.py
Application factory (create_app()). Registers all 14 blueprints, starts the LibreLinkUp scheduler, sets up global error handlers (404, 500), and exposes a /api/health HEAD/GET endpoint used by both the mobile cold-start poller and external keep-alive cron services.

backend/config.py
Calls test_mongo_connection() on startup (Atlas ping).
Sets Flask config: MONGO_URI, SECRET_KEY, TOKEN_EXPIRY (24h web / 90d mobile).
Configures CORS with an allowlist of localhost ports + Render + Vercel origins.
Initialises Flask-PyMongo (mongo module-level singleton used by all route files).
Exposes create_app_config(app).
backend/constants.py — Most complex file
Single source of truth for all PK/PD parameters:

Insulin profiles (Novorapid, Fiasp, Humalog, Levemir, Tresiba, etc.) sourced from German S3 guideline.
Meal absorption profiles (very_slow → very_fast), each with gamma distribution parameters (shape_param, scale_param, onset_hours, peak_hours, duration_hours).
DEFAULT_PATIENT_CONSTANTS dictionary (default insulin_to_carb_ratio, correction_factor, target_glucose, carb_to_bg_factor, etc.).
Circadian baseline profile (get_default_circadian_profile()) encoding Somogyi nadir (~3 AM), dawn phenomenon (5–8 AM) and daytime plateau.
60-second in-process LRU cache (_PATIENT_CONSTANTS_CACHE) to avoid repeated MongoDB hits during mobile app startup bursts.
Constants.export_all_constants_safe() — writes a TypeScript constants file to mobile/constants/ on non-Render environments.
Constants.get_shared_constants_json() — returns PK/PD constants as JSON; injected into every POST /login response.
backend/utils/pharmacodynamics.py
Central PK/PD engine (version 4.0). Key exported functions:

Function	Description
calculate_gamma_absorption(hours, profile)	Gamma distribution activity % for meals
calculate_insulin_activity(hours, params)	Gamma distribution activity % for insulin (aligned with frontend)
calculate_iob(hours, initial_dose, profile)	IOB via 100-step trapezoidal integration
calculate_absorbed_fraction(hours, profile, ...)	Fraction of carbs absorbed by time t
calculate_meal_active_carbs(meal, patient_constants, ...)	Returns {active_carbs, absorbed_carbs, activity_percent, ...}
calculate_stacked_insulin_effect(patient_id, ...)	Aggregates all active doses → totalIOB, totalBGImpact, contributions
calculate_stable_baseline_from_reading(...)	Derives fasting-equivalent baseline from a BG reading + meal/insulin context
backend/utils/auth.py
generate_token(user_id, user_type) — emits a HS256 JWT; duration 24h (web) or 90d (mobile, detected via X-Client-Type: mobile header).
token_required — function decorator; decodes JWT, fetches user from MongoDB, rejects expired/invalid tokens with 401.
backend/routes/auth_routes.py
POST /login, POST /register, POST /logout. Login embeds shared_constants (the full PK/PD constants JSON) in the response so the mobile app never needs a separate constants fetch on cold start.

backend/routes/meal_routes.py (v5.0)
GET /api/meal-on-board (MOB), GET /api/meal-timing-assessment, GET /api/active-meals, GET /api/meals-only, GET /api/patient/<id>/meals-only.
Returns both absorbed_carbs (past) and active_carbs / total_active_carbs (future) with current_bg_elevation and pending_bg_rise for the frontend's ActiveEffectsDisplay.

backend/routes/medication_routes.py
All insulin endpoints (merged from the now-deleted insulin_routes.py): POST /api/insulin/log, GET /api/insulin/active-effect, GET /api/insulin-data, GET /api/insulin-analytics. Also hosts calculate_stacked_insulin_effect().

backend/blood_sugar.py
Blueprint for GET /api/blood-sugar, POST /api/blood-sugar, DELETE /api/blood-sugar/<id>. The POST handler calculates and stores a baseline_calculation sub-document with each reading.

backend/services/libre_service.py
Full LibreLinkUp API client:

Supports 9 regional endpoints (US, EU, EU2, DE, FR, JP, AP, AU, AE).
Credentials encrypted at rest with Fernet (key derived from app SECRET_KEY).
Token cached with 24-hour refresh buffer.
Converts mmol/L → mg/dL automatically.
Deduplicates readings by (user_id, bloodSugarTimestamp).
backend/services/food_scan_service.py
Wraps Gemini 2.5-flash Vision API. Accepts a food photo and returns structured food items (name, carbs, protein, fat, portion size, category, confidence score) ready for the mobile MealForm.

Mobile
mobile/app/index.tsx
Root redirect: authenticated users → (app), unauthenticated → (auth)/login.

mobile/store/auth.store.ts
Zustand store — useAuthStore. Manages user, token, isAuthenticated, isLoading, sharedConstants. Calls wakeUpServer() before login to handle Render cold-starts. Client-side JWT expiry check via decodeTokenPayload() / isTokenValid().

mobile/store/patient.store.ts
usePatientStore — caches patient constants (5-minute TTL), exposes loadConstants(), updateConstants(), getConstant<K>().

mobile/services/api/client.ts
Axios instance with 90-second timeout, 4-retry exponential back-off (capped at 15 s), JWT header injection, 401 auto-logout, and wakeUpServer() progress callback for cold-start UX.

mobile/services/api/endpoints.ts
Single source of truth for all API paths (API.AUTH.*, API.MEALS.*, API.MOB.*, API.INSULIN.*, API.LIBRE.*, etc.). Supports optional /api/v1/ versioning via USE_VERSIONED_API flag (currently false).

Five most important files for a new developer
backend/constants.py — all PK/PD parameters and defaults live here
backend/utils/pharmacodynamics.py — the core calculation engine
backend/main.py — how the app is assembled
mobile/services/api/client.ts — API communication layer
mobile/services/api/endpoints.ts — all route constants
Other must-reads: backend/utils/auth.py, backend/config.py, mobile/store/auth.store.ts, backend/routes/meal_routes.py, backend/API_CHANGES.md.

5. API & INTERFACES
Authentication
All routes except POST /login, POST /register, and GET /api/health require a JWT in the Authorization: ****** header. The @token_requireddecorator handles validation. Mobile clients should also sendX-Client-Type: mobile` to receive a 90-day token.

Auth Routes (no /api/ prefix)
Method	Path	Body	Response
POST	/login	{username, password, user_type}	{token, user_type, firstName, lastName, shared_constants}
POST	/register	{username, email, password, firstName, lastName, user_type}	{message, token, user_type}
POST	/logout	—	{message}
Patient Routes
Method	Path	Response
GET	/api/patient/constants	Full patient constants object
PUT	/api/patient/constants	Updated constants
GET	/api/patient/profile	Patient profile
GET	/api/patient/authorized-doctors	List of authorized doctors
POST	/api/patient/authorize-doctor	{doctor_id} → grants access
DELETE	/api/patient/revoke-doctor	{doctor_id} → revokes access
GET	/api/patient/export	Full data export
Meal Routes
Method	Path	Notes
GET	/api/meals-only	Paginated meal list
POST	/api/meal	Log a meal with food items + nutrition
GET	/api/meal/<id>	Single meal detail
DELETE	/api/meal/<id>	Delete meal
POST	/api/meal/calculate	Calculate insulin dose for a meal
GET	/api/meal-on-board	MOB — active + absorbed carbs, BG impact
GET	/api/meal-timing-assessment	Insulin pre-bolus timing recommendation
GET	/api/active-meals	All currently active meals with breakdown
GET	/api/patient/<id>/meals-only	Doctor view of patient meals
MOB Response shape
JSON
{
  "total_active_carbs": 25.5,
  "total_absorbed_carbs": 18.3,
  "current_bg_elevation": 73.2,
  "pending_bg_rise": 102.0,
  "expected_bg_impact": 102.0,
  "active_meal_count": 2,
  "contributions": [{ "meal_id", "total_carbs", "active_carbs", "absorbed_carbs", "activity_percent", "hours_elapsed", ... }],
  "calculation_time": "ISO8601",
  "calculation_timezone": "UTC"
}
Insulin / Medication Routes
Method	Path	Notes
POST	/api/insulin/log	Log an insulin dose {medication, dose, taken_at}
DELETE	/api/insulin/log/<id>	Delete a dose log
GET	/api/insulin/active-effect	IOB — active + absorbed insulin, BG impact
GET	/api/insulin-data	Historical dose data for visualization
GET	/api/insulin-analytics	Aggregate insulin analytics
GET	/api/medication-logs	All medication logs
GET	/api/medication-schedule	Active schedules
POST	/api/medication-log	Log a medication dose
IOB Response shape (key fields)
JSON
{
  "total_active_insulin": 2.5,
  "total_absorbed_insulin": 2.5,
  "current_bg_reduction": 125.0,
  "pending_bg_reduction": 125.0,
  "bg_impact": -125.0,
  "active_doses": 2,
  "insulin_contributions": [{ "dose_id", "medication", "initial_dose", "active_units", "absorbed_units", "activity_percent", "hours_since_dose", ... }]
}
Blood Sugar Routes
Method	Path	Notes
GET	/api/blood-sugar	List readings (recent first)
POST	/api/blood-sugar	Log reading; computes baseline_calculation
DELETE	/api/blood-sugar/<id>	Delete reading
GET	/api/doctor/patient/<id>/blood-sugar	Doctor view (auth-checked)
Activity Routes
Method	Path	Notes
GET	/api/activities	List logged activities
POST	/api/record-activities	Record activity {activity_level, duration_minutes, timestamp}
GET	/api/activity-history	Historical activity data
DELETE	/api/activity/<id>	Delete activity
GET	/api/doctor/patient/<id>/activity-history	Doctor view
LibreLinkUp CGM Routes
Method	Path	Notes
POST	/api/libre/connect	{email, password, region} — store encrypted credentials
DELETE	/api/libre/disconnect	?delete_readings=true to also purge readings
GET	/api/libre/status	Connection status + optional live reading (?fetch_latest=true)
POST	/api/libre/sync	Manual pull of ~8 hours of readings
PUT	/api/libre/settings	{auto_sync_enabled, sync_interval_minutes}
GET	/api/libre/readings	Stored CGM readings (?hours=&start_time=&end_time=)
Food Routes
Method	Path	Notes
GET	/api/food/search	?q= text search across Egyptian + international food DB
GET	/api/food/categories	Available categories
GET/POST	/api/food/custom	Custom food items
GET/POST	/api/food/favorite	Favourites list
POST	/api/food/scan	Gemini Vision food analysis (multipart or base64)
Doctor Routes
Method	Path	Notes
GET	/api/doctors	List all doctors
GET	/api/doctor/patients	Patients authorized for this doctor
GET/PUT	/api/doctor/patient/<id>/constants	View/edit patient constants
POST	/api/doctor/patient/<id>/constants/reset	Reset to defaults
GET	/api/doctor/patient/<id>/conditions	Active conditions
GET	/api/doctor/patient/<id>/medications	Active medications
Cumulative Effects Routes
Method	Path	Notes
GET	/api/active-effects-full	Full combined MOB+IOB breakdown
GET	/api/cumulative-effects	Net cumulative glucose impact
GET	/api/net-effect	Simple net effect number
Health
Method	Path
GET / HEAD	/api/health
API Versioning
GET /api/v1/<path> is proxied transparently to /api/<path> via api_v1_proxy() in main.py. The USE_VERSIONED_API flag in mobile/services/api/endpoints.ts is currently false.

6. DATA MODELS & SCHEMAS
MongoDB Atlas is used. There is no ORM or migration framework — collections are created implicitly on first write.

users collection
Code
{
  _id: ObjectId,
  username: str,
  email: str,
  password: str (bcrypt hash),
  user_type: "patient" | "doctor" | "admin",
  first_name: str,
  last_name: str,
  authorized_doctors: [str],   // patient: list of doctor _id strings
  // Patient-specific constants (overrides defaults):
  insulin_to_carb_ratio: float,
  correction_factor: float,
  target_glucose: float,
  carb_to_bg_factor: float,
  protein_factor: float,
  fat_factor: float,
  // ...more PK/PD fields from constants.py
  circadian_profile: { anchors: [{hour, value}], source: str },
  baseline_mode: "circadian" | "static",
  timezone_offset_minutes: int,
  daily_reset_hour: int,
}
meals collection
Code
{
  _id: ObjectId,
  user_id: str,
  meal_type: "breakfast" | "lunch" | "dinner" | "snack",
  meal_time: datetime (UTC),
  food_items: [{ name, carbs, protein, fat, portion_size, category, ... }],
  nutrition: { total_carbs, total_protein, total_fat, absorption_type },
  calculation_summary: { total_carbs, absorption_type, recommended_insulin, ... },
  insulin_dose: float | null,
  notes: str,
}
medication_logs collection
Code
{
  _id: ObjectId,
  patient_id: str,
  medication: str,   // e.g. "novorapid", "fiasp"
  dose: float,
  taken_at: datetime (UTC),
  notes: str,
}
blood_sugar collection
Code
{
  _id: ObjectId,
  user_id: str,
  bloodSugar: float (mg/dL),
  bloodSugarTimestamp: datetime (UTC),
  status: "low" | "normal" | "high" | "very_high",
  target: float,
  source: "fingerstick" | "libre_cgm" | ...,
  notes: str,
  baseline_calculation: {           // optional, added on POST
    baseline: float,
    net_effect: float,
    meal_impact: float,
    insulin_impact: float,
    confidence: "high" | "medium" | "low",
    calculation_time: datetime,
  }
}
activities collection
Code
{
  _id: ObjectId,
  user_id: str,
  activity_level: int,   // -2 to 2 (very sedentary → very active)
  duration_minutes: float,
  timestamp: datetime (UTC),
  notes: str,
}
libre_connections collection
Code
{
  _id: ObjectId,
  user_id: str,
  email_encrypted: str (Fernet),
  password_encrypted: str (Fernet),
  auth_token: str,
  token_expires: datetime,
  base_url: str,
  region: str,
  auto_sync_enabled: bool,
  sync_interval_minutes: int,
  last_sync: datetime | null,
}
medication_schedules collection
Code
{
  _id: ObjectId,
  patient_id: str,
  medication: str,
  startDate: datetime,
  endDate: datetime,
  dailyTimes: [str],   // ["08:00", "20:00"]
}
Relationships
One users document → many meals, medication_logs, blood_sugar, activities, libre_connections.
users.authorized_doctors is a list of doctor _id strings (soft foreign key, no referential integrity enforcement).
No migrations framework — the backend/migrate_timezone_offset.py script is a one-shot manual migration for adding the timezone_offset_minutes field.
7. CONFIGURATION & ENVIRONMENT
Backend (backend/ — loaded via python-dotenv)
Variable	Required	Default	Description
MONGO_URI	✅	—	MongoDB Atlas connection string
SECRET_KEY	✅	—	Flask secret key; also used to derive Fernet encryption key for Libre credentials
GEMINI_API_KEY	Optional	—	Google Gemini API key for food scanning; service raises RuntimeError if missing at scan time
RENDER	Optional	—	Set by Render platform; suppresses the Constants.export_all_constants_safe() file-write
RENDER_EXTERNAL_URL	Optional	—	Used by libre_scheduler._ping_self() to construct the keep-alive URL
A sample is in backend/old.env:

Code
MONGO_URI=mongodb://localhost:27017/native_new
SECRET_KEY=your_secret_key
Mobile (mobile/.env, gitignored — use mobile/.env.example as template)
Variable	Required	Default	Description
EXPO_PUBLIC_API_URL	✅	http://localhost:5000	Backend base URL
EXPO_PUBLIC_API_VERSION	Optional	v1	API version prefix (not currently used)
GEMINI_API_KEY	Optional	—	Present in .env but currently used server-side only
⚠️ Note: The .env file in the repo contains a live GEMINI_API_KEY value. This should be rotated and removed from the file — credentials should never be committed. The file is in .gitignore for the mobile directory, but the key was apparently committed at some point.

8. SETUP & INSTALLATION
Prerequisites
Python 3.10+
Node.js 18+ and npm
MongoDB Atlas account (or local MongoDB 6+)
Android Studio or Xcode (for mobile device emulation)
Expo CLI: npm install -g expo-cli
Backend
bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Create .env file
cat > .env << 'EOF'
MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority
SECRET_KEY=<your-random-secret-key>
GEMINI_API_KEY=<your-gemini-key>   # optional
EOF

python main.py
# Server starts on http://localhost:5000
# Verify: curl http://localhost:5000/api/health
Web Frontend
bash
cd frontend
npm install
npm start
# Opens http://localhost:3000
Mobile App
bash
cd mobile
npm install

# Create .env
cat > .env << 'EOF'
EXPO_PUBLIC_API_URL=http://localhost:5000
EXPO_PUBLIC_API_VERSION=v1
EOF

npx expo start
# Scan QR with Expo Go (iOS/Android) or press 'a' for Android emulator / 'i' for iOS simulator
Verify it worked
Hit http://localhost:5000/api/health → {"status":"ok"}.
Register a patient account via POST http://localhost:5000/register.
Log in and receive a JWT.
On mobile, the login screen shows a "Server starting up" banner while the backend warms up.
Platform notes
Windows: Use .venv\Scripts\activate and ensure Python is on PATH. Expo may require enabling Developer Mode.
macOS/Linux: Standard workflow, no platform gotchas noted.
Android emulator: Use EXPO_PUBLIC_API_URL=http://10.0.2.2:5000 (Android's loopback alias for host machine).
9. DEVELOPMENT WORKFLOW
Dev server
bash
# Backend (with auto-reload)
cd backend && python main.py      # or: flask run --reload

# Frontend
cd frontend && npm start

# Mobile
cd mobile && npx expo start
Running tests
bash
# Backend — pytest
cd backend
python -m pytest tests/ -v

# Or run the manual integration structure validator:
python tests/test_mob_iob_integration.py

# Web frontend
cd frontend && npm test

# Mobile — no test suite exists currently
Backend tests (tests/test_mob_iob_integration.py) are structural validation tests — they verify expected response shapes without a running server or database. They do not use fixtures or mocking.

Linting / type-checking
bash
# Mobile TypeScript
cd mobile && npm run typecheck   # tsc --noEmit
cd mobile && npm run lint        # eslint . --ext .ts,.tsx

# Backend — no linter config found; ad-hoc usage assumed
# Frontend — CRA's default eslint config (react-app)
CI/CD
No .github/workflows/ directory was found in the repository. There is no automated CI pipeline. Deployment appears to be triggered manually via Render's Git integration.

Deployment / branching
No explicit branching strategy is documented. The codebase shows evidence of a single working branch. Multiple *_SUMMARY.md files suggest a PR-per-feature workflow was used historically with GitHub Copilot Workspace.

10. DEPLOYMENT
Backend
Deployed on Render.com (free tier):

Runtime: Python, WSGI via gunicorn
Start command: gunicorn backend.main:app (inferred from gunicorn dependency and main.py module-level app = create_app())
Public URL: https://native-3y3j.onrender.com
Environment variables set via Render dashboard: MONGO_URI, SECRET_KEY, GEMINI_API_KEY, RENDER, RENDER_EXTERNAL_URL
Web Frontend
Deployed on Vercel:

Framework: Create React App
Known URLs: https://diatwin-phi.vercel.app, https://dia-twin.vercel.app, https://diatwin.vercel.app
Mobile
Development: Expo Go app
Production: built via expo run:android / expo run:ios, or EAS Build (not configured in repo)
OTA updates: expo-updates package is included
Infrastructure dependencies
Service	Purpose
MongoDB Atlas	Primary database
Render.com	Backend hosting
Vercel	Web frontend hosting
Google Gemini API	Food photo analysis
Abbott LibreLinkUp API	CGM readings (unofficial)
cron-job.org	External keep-alive ping for Render free tier
Build artifacts
Backend: no build step; Python source is run directly
Frontend: npm run build → frontend/build/ static files
Mobile: expo run:android / expo run:ios or EAS build
11. SECURITY CONSIDERATIONS
Authentication & Authorization
JWT (HS256) signed with SECRET_KEY. Short-lived (24h) for web; long-lived (90d) for mobile.
@token_required decorator on all protected routes.
CORS allowlist in config.py — currently includes specific localhost ports and production origins.
Doctor→patient access is enforced via check_doctor_patient_access() in doctor_routes.py, which verifies the patient has explicitly authorized the doctor in their authorized_doctors list.
Sensitive data handling
LibreLinkUp credentials (email + password) are encrypted at rest using Fernet symmetric encryption; the key is derived from SECRET_KEY using SHA-256. Passwords are never returned in API responses.
JWT tokens on mobile are stored in expo-secure-store (iOS Keychain / Android Keystore). On web they fall back to localStorage — this is less secure and could be improved with httpOnly cookies.
backend/old.env contains plaintext MONGO_URI / SECRET_KEY placeholder values — the filename suggests it is intentionally historical, but it should be removed from the repo to avoid confusion.
⚠️ mobile/.env contains a live GEMINI_API_KEY — this file should be confirmed gitignored and the key rotated.
Known security patterns / concerns
CORS is wide during development (8 localhost origins). Review before widening to "*".
The /api/v1/<path> proxy in main.py uses werkzeug.routing to look up endpoints — take care that new internal-only routes are not inadvertently exposed through it.
Token expiry on mobile (90 days) means a stolen token remains valid for a long period; consider adding refresh-token rotation.
The food scan endpoint (POST /api/food/scan) validates content type and enforces a 5 MB limit, but does not validate that the uploaded file is actually an image at the byte level.
12. TESTING STRATEGY
Current state
Backend: One test file (backend/tests/test_mob_iob_integration.py). Six test functions (structure validation only — no HTTP calls, no database). Run with pytest.
Web frontend: CRA's default App.test.js (renders <App /> without crashing). No meaningful tests.
Mobile: No test files found.
Test types present
Type	Location	Notes
Structure validation	backend/tests/test_mob_iob_integration.py	Asserts expected keys in response dicts; no mocking
Smoke test	frontend/src/App.test.js	React Testing Library render check
Coverage posture
Very low. The codebase explicitly notes "6/6 test suites passed (100% success rate)" in IMPLEMENTATION_SUMMARY.md, but these tests only validate dictionary key counts, not actual calculation correctness or endpoint integration.

Mocking / fixtures
None. Backend tests avoid requiring a running server by checking schema shapes against Python dicts rather than making HTTP requests.

13. KNOWN ISSUES, TODOS & TECH DEBT
Found in code comments / documentation
backend/routes/medication_routes.py (merged from insulin_routes.py): The file was the result of a consolidation; the previous insulin_routes.py was deleted. Any references to it in older documentation are stale.
mobile/services/api/endpoints.ts — multiple // FIX: comments documenting previously broken routes:
ACTIVITIES.PATIENT_HISTORY used to call a non-existent endpoint (/api/patient/${patientId}/activity-history), silently returning [].
BLOOD_SUGAR.BY_PATIENT used to call an unauthenticated, crash-prone route.
backend/main.py — comment explains why Constants.export_all_constants_safe() is skipped on Render: the mobile constants/ directory exists on the server filesystem and triggers an infinite redeploy loop.
components/dashboard/ActiveEffectsDisplay_comparison.tsx — a comparison/experimental variant of the main component; not used in production routing but committed to the repo.
backend/routes/food_scan_routes.py — the food_scan_service.py comment notes the _MODEL variable is set to "gemini-2.5-flash" but an older comment references "gemini-2.0-flash" and "free tier" — the model name should be confirmed against the current Gemini API pricing.
mobile/app/(app)/settings/libre-connect.tsx and libre.tsx — two separate settings screens for Libre; likely one is an older version.
USE_VERSIONED_API = false in endpoints.ts — the API versioning infrastructure is built but not yet enabled.
No CI pipeline — all quality gates are manual.
No migration framework — backend/migrate_timezone_offset.py is a one-off script; future schema changes will need the same manual approach.
backend/old.env and several *_SUMMARY.md files at repo root are development artefacts that should be cleaned up.
mobile/components - Shortcut.lnk, utils - Shortcut.lnk, native3 - Shortcut.lnk — Windows shortcut files committed to the repo.
Root package.json / requirements.txt / tsconfig.json — appear to be placeholder or scaffolding files at repo root; the real configs are in backend/, mobile/, and frontend/.
scripts/food_scan_routes.py and scripts/food_scan_service.py — duplicate copies of the backend food-scanning code in the scripts/ directory; may be outdated.
14. GLOSSARY
Term	Definition
T1D	Type 1 Diabetes — an autoimmune condition requiring exogenous insulin for blood glucose regulation
BG / Blood Glucose	Blood glucose concentration, measured in mg/dL (US) or mmol/L (international). DiaTwin uses mg/dL internally
IOB	Insulin on Board — the quantity of insulin (in units) still actively lowering blood glucose, calculated by integrating the remaining area under the activity-time curve
MOB	Meal on Board (also "Carbs on Board / COB") — the grams of carbohydrate still being absorbed from a recent meal
PK / Pharmacokinetics	How a drug (or carbohydrate) is absorbed, distributed, metabolised, and excreted over time
PD / Pharmacodynamics	The biological effect of a drug or nutrient — here, how insulin or carbs affect blood glucose
Gamma distribution	A probability distribution used to model absorption curves; parameterised by shape_param (k) and scale_param (θ)
Absorption type	Classification of meal absorption speed: very_slow, slow, medium, fast, very_fast
Correction factor (ISF)	Insulin Sensitivity Factor — how much 1 unit of insulin lowers BG (default 50 mg/dL/unit)
Carb ratio (ICR)	Insulin-to-Carb Ratio — how many grams of carbs 1 unit of insulin covers (e.g. 1:10)
Carb-to-BG factor	How much 1 g of carbs raises BG (default 4.0 mg/dL/g; derived from ICR × ISF ÷ 100)
Baseline BG	The estimated fasting (no-meal, no-insulin effect) blood glucose level; calculated as reading − (meal_impact − insulin_impact)
Circadian profile	A 24-hour curve of expected baseline BG, encoding physiological patterns like the dawn phenomenon and Somogyi effect
Dawn phenomenon	A natural rise in BG in the early morning (~5–8 AM) caused by counter-regulatory hormones
Somogyi nadir	A physiological low point in overnight BG (~3 AM), also encoded in the circadian profile
LibreLinkUp	Abbott's cloud sharing service for FreeStyle Libre CGM data; DiaTwin uses an unofficial reverse-engineered API
CGM	Continuous Glucose Monitor — a sensor worn on the body that measures interstitial glucose every few minutes
DiaTwin	The project/platform name (from "diabetes" + "digital twin")
Render	Cloud PaaS hosting the Flask backend on a free-tier dyno
Expo Router	File-system-based routing library for React Native, modelled after Next.js
Zustand	Lightweight React state management library used in the mobile app
Fernet	Symmetric authenticated encryption scheme (from Python cryptography library) used to encrypt LibreLinkUp credentials at rest
Stacking risk	The danger of overlapping insulin doses; assessed by calculate_stacked_insulin_effect()
Trapezoidal integration	Numerical method used to compute IOB/MOB — the remaining area under an activity curve is approximated using 100 equal-width trapezoids