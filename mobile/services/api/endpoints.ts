/**
 * API Endpoint Constants
 * Location: mobile/services/api/endpoints.ts
 *
 * Main Export: API (default), API (named)
 * Description: Single source of truth for all backend API endpoint paths.
 *              All paths must exactly match the Flask route decorators in the backend.
 *
 * Features:
 * - Versioning support (USE_VERSIONED_API flag)
 * - Helper function for optional /api/v1/ prefix
 * - All endpoint groups: AUTH, PATIENT, CALCULATIONS, ACTIVITIES,
 *   MEALS, BLOOD_SUGAR, INSULIN, MOB, MEDICATION, FOOD, DOCTORS, DOCTOR, EXPORT,
 *   LIBRE (LibreLinkUp CGM integration),
 *   WATCH (Google Fit HR background sync)
 *
 * ⚠️  CRITICAL: Auth routes are at ROOT level (/login, /register) — NO /api prefix.
 *     All other routes use the /api prefix (/api/meals, /api/blood-sugar, etc.)
 *
 * Route → Backend file mapping (for debugging 404s):
 *   INSULIN.ACTIVE      → medication_routes.py  /api/insulin/active-effect
 *   INSULIN.LOG         → medication_routes.py  /api/insulin/log  (POST)
 *   INSULIN.DATA        → medication_routes.py  /api/insulin-data
 *   INSULIN.ANALYTICS   → medication_routes.py  /api/insulin-analytics
 *   MEALS.*             → meal_routes.py
 *   MOB.*               → meal_routes.py
 *   CALCULATIONS.IOB    → same as INSULIN.ACTIVE (aliased)
 *   CALCULATIONS.ACTIVE_EFFECTS_FULL → cumulative_effects_routes.py /api/active-effects-full
 *   CALCULATIONS.CUMULATIVE_EFFECTS  → cumulative_effects_routes.py /api/cumulative-effects
 *   LIBRE.*             → libre_routes.py
 *   WATCH.*             → watch_sync_routes.py   (OAuth + background HR sync)
 *                         NOTE: watch_hr_routes.py handles live streaming separately
 */

// API version configuration
export const API_VERSION = 'v1';
export const USE_VERSIONED_API = false; // Set to true when backend supports /api/v1/

/**
 * Helper to get versioned endpoint.
 * When USE_VERSIONED_API is true, transforms /api/xxx → /api/v1/xxx
 */
const v = (endpoint: string): string => {
  if (!USE_VERSIONED_API) return endpoint;
  if (endpoint.startsWith('/api/')) {
    return endpoint.replace('/api/', `/api/${API_VERSION}/`);
  }
  return endpoint;
};

const API = {
  // ⚠️  CRITICAL: Auth routes are at ROOT level — NO /api prefix
  AUTH: {
    LOGIN: '/login',
    REGISTER: '/register',
    LOGOUT: '/logout',
  },

  PATIENT: {
    CONSTANTS: v('/api/patient/constants'),
    PROFILE: v('/api/patient/profile'),
    AUTHORIZED_DOCTORS: v('/api/patient/authorized-doctors'),
    AUTHORIZE_DOCTOR: v('/api/patient/authorize-doctor'),
    REVOKE_DOCTOR: v('/api/patient/revoke-doctor'),
  },

  CALCULATIONS: {
    NET_EFFECT: v('/api/net-effect'),
    IOB: v('/api/insulin/active-effect'),  // I-24: alias of INSULIN.ACTIVE -- keep in sync
    MOB: v('/api/meal-on-board'),
    CUMULATIVE_EFFECTS: v('/api/cumulative-effects'),
    ACTIVE_EFFECTS_FULL: v('/api/active-effects-full'),
  },

  ACTIVITIES: {
    LIST: v('/api/activities'),
    HISTORY: v('/api/activity-history'),
    CREATE: v('/api/record-activities'),
    BY_ID: (id: string) => v(`/api/activity/${id}`),
    DELETE: (id: string) => v(`/api/activity/${id}`),
    // FIX: Was /api/patient/${patientId}/activity-history — that route did NOT
    // exist in any backend file. Every call from PatientDataView silently 404-ed
    // and fell back to [] via .catch(). The route is now defined in doctor_routes.py.
    PATIENT_HISTORY: (patientId: string) => v(`/api/doctor/patient/${patientId}/activity-history`),
  },

  // ── HR ODE exercise pharmacodynamics ──────────────────────────────────────
  ACTIVITY_PD: {
    /** Stacked PD effect for today's window (GET) */
    STACKED: v('/api/activity/pharmacodynamics'),
    /** Activity On Board per-session breakdown (GET) */
    AOB:     v('/api/activity/pharmacodynamics/aob'),
    /** Simulate effect without persisting (POST) */
    PREVIEW: v('/api/activity/pharmacodynamics/preview'),
  },

  MEALS: {
    LIST: v('/api/meals-only'),
    CREATE: v('/api/meal'),
    CALCULATE: v('/api/meal/calculate'),
    MEALS_ONLY: v('/api/meals-only'),
    BY_ID: (id: string) => v(`/api/meal/${id}`),
    DELETE: (id: string) => v(`/api/meal/${id}`),
    PATIENT_MEALS: (patientId: string) => v(`/api/patient/${patientId}/meals-only`),
  },

  BLOOD_SUGAR: {
    LIST: v('/api/blood-sugar'),
    CREATE: v('/api/blood-sugar'),
    DELETE: (id: string) => v(`/api/blood-sugar/${id}`),
    // FIX: Was /api/blood-sugar/${patientId} — that route had no @token_required
    // (fully unauthenticated!), no doctor authorization check, and crashed with
    // a JSON serialization error on ObjectId/datetime fields.
    // Now uses the secure doctor-namespaced route added to doctor_routes.py.
    BY_PATIENT: (patientId: string) => v(`/api/doctor/patient/${patientId}/blood-sugar`),
  },

  INSULIN: {
    DATA: v('/api/insulin-data'),
    ANALYTICS: v('/api/insulin-analytics'),
    ACTIVE: v('/api/insulin/active-effect'),  // I-24: aliased as CALCULATIONS.IOB -- keep in sync
    LOG: v('/api/insulin/log'),
    DELETE_LOG: (id: string) => v(`/api/insulin/log/${id}`),
  },

  MOB: {
    GET: v('/api/meal-on-board'),
    TIMING_ASSESSMENT: v('/api/meal-timing-assessment'),
    ACTIVE_MEALS: v('/api/active-meals'),
  },

  MEDICATION: {
    LOGS: v('/api/medication-logs'),
    SCHEDULE: v('/api/medication-schedule'),
    CREATE_LOG: v('/api/medication-log'),
    CREATE_LOG_FOR: (patientId: string) => v(`/api/medication-log/${patientId}`),
  },

  FOOD: {
    SEARCH: v('/api/food/search'),
    CATEGORIES: v('/api/food/categories'),
    CUSTOM: v('/api/food/custom'),
    FAVORITE: v('/api/food/favorite'),
    MEASUREMENTS: v('/api/food/measurements'),
    NUTRITIONAL_SUMMARY: v('/api/food/nutritional-summary'),
    SCAN: v('/api/food/scan'),
  },

  DOCTORS: {
    LIST: v('/api/doctors'),
  },

  DOCTOR: {
    PATIENTS: v('/api/doctor/patients'),
    PATIENT_CONSTANTS: (patientId: string) => v(`/api/doctor/patient/${patientId}/constants`),
    PATIENT_CONSTANTS_RESET: (patientId: string) => v(`/api/doctor/patient/${patientId}/constants/reset`),
    PATIENT_CONDITIONS: (patientId: string) => v(`/api/doctor/patient/${patientId}/conditions`),
    PATIENT_MEDICATIONS: (patientId: string) => v(`/api/doctor/patient/${patientId}/medications`),
    PATIENT_MEDICATION_LOG: (patientId: string) => v(`/api/doctor/patient/${patientId}/medication-log`),
  },

  EXPORT: {
    PATIENT_DATA: v('/api/patient/export'),
  },

  // ── LibreLinkUp CGM integration ──────────────────────────────────────────
  // Backend: routes/libre_routes.py
  LIBRE: {
    /** POST   Connect a LibreLinkUp account */
    CONNECT:    v('/api/libre/connect'),
    /** DELETE Remove the connection (?delete_readings=true to also purge readings) */
    DISCONNECT: v('/api/libre/disconnect'),
    /** GET    Connection status + optional live reading (?fetch_latest=true) */
    STATUS:     v('/api/libre/status'),
    /** POST   Manual sync — pulls latest ~8 h of readings */
    SYNC:       v('/api/libre/sync'),
    /** PUT    Update auto_sync_enabled / sync_interval_minutes */
    SETTINGS:   v('/api/libre/settings'),
    /** GET    Stored CGM readings (?hours=&sync=&start_time=&end_time=) */
    READINGS:   v('/api/libre/readings'),
  },

  // ── Google Fit HR background sync ────────────────────────────────────────
  // Backend: routes/watch_sync_routes.py  (Blueprint: watch_sync_bp)
  // NOTE: Live watch streaming is handled by watch_hr_routes.py (unchanged).
  //       These endpoints cover OAuth setup and the scheduled 15-min background sync.
  //
  // Usage in watch-connect.tsx / watch-sync.ts:
  //   import API from '@/services/api/endpoints';
  //   const url  = await apiClient.get(API.WATCH.OAUTH_URL);
  //   const resp = await apiClient.post(API.WATCH.CONNECT, { code });
  WATCH: {
    /** GET    Returns the Google OAuth consent URL for the WebView */
    OAUTH_URL:  v('/api/watch/oauth-url'),
    /** POST   Exchange OAuth code → store tokens → run first sync */
    CONNECT:    v('/api/watch/connect'),
    /** GET    Connection status (no tokens exposed) */
    STATUS:     v('/api/watch/status'),
    /** POST   Trigger an on-demand sync from Google Fit */
    SYNC:       v('/api/watch/sync'),
    /** PUT    Update auto_sync_enabled / sync_interval_minutes / hr_base / hr_max */
    SETTINGS:   v('/api/watch/settings'),
    /** DELETE Remove tokens (?delete_activities=true to also purge synced sessions) */
    DISCONNECT: v('/api/watch/disconnect'),
  },
  // Internal / infrastructure
  // I-23: Single source of truth for internal endpoints (previously hardcoded in client.ts)
  INTERNAL: {
    /** GET  Server liveness probe -- used by wakeUpServer() in client.ts */
    HEALTH: '/api/health',
  },

} as const;

// Named export for direct usage
export { API };

// Default export for convenience
export default API;

// Debug helper — logs all endpoints (useful for troubleshooting 404s)
export const logEndpoints = () => {
  console.log('📋 API Endpoints Configuration:');
  console.log('AUTH.LOGIN:', API.AUTH.LOGIN);
  console.log('AUTH.REGISTER:', API.AUTH.REGISTER);
  console.log('MEALS.CREATE:', API.MEALS.CREATE);
  console.log('MOB.GET:', API.MOB.GET);
  console.log('INSULIN.ACTIVE:', API.INSULIN.ACTIVE);
  console.log('INSULIN.LOG:', API.INSULIN.LOG);
  console.log('CALCULATIONS.IOB:', API.CALCULATIONS.IOB);
  console.log('CALCULATIONS.ACTIVE_EFFECTS_FULL:', API.CALCULATIONS.ACTIVE_EFFECTS_FULL);
  console.log('CALCULATIONS.CUMULATIVE_EFFECTS:', API.CALCULATIONS.CUMULATIVE_EFFECTS);
  console.log('LIBRE.CONNECT:', API.LIBRE.CONNECT);
  console.log('LIBRE.STATUS:', API.LIBRE.STATUS);
  console.log('LIBRE.READINGS:', API.LIBRE.READINGS);
  console.log('WATCH.OAUTH_URL:', API.WATCH.OAUTH_URL);
  console.log('WATCH.CONNECT:', API.WATCH.CONNECT);
  console.log('WATCH.STATUS:', API.WATCH.STATUS);
  console.log('WATCH.SYNC:', API.WATCH.SYNC);
  console.log('FOOD.SCAN:', API.FOOD.SCAN);
};

// ── Standalone export for projects that import ACTIVITY_PD directly ──────────
// (only needed if endpoints.ts re-exports sub-objects individually)
export const ACTIVITY_PD_ENDPOINTS = {
  STACKED: '/api/activity/pharmacodynamics',
  AOB:     '/api/activity/pharmacodynamics/aob',
  PREVIEW: '/api/activity/pharmacodynamics/preview',
} as const;