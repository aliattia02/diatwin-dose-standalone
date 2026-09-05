/**
 * Calculations API service - IOB, MOB, Cumulative Effects, Net Effect
 * Location: mobile/services/api/calculations.ts
 *
 * This is the single source of truth for all active-effect calculations.
 * mob.ts has been consolidated here; it now re-exports from this file.
 *
 * Endpoint groups:
 *   IOB    → GET /api/insulin/active-effect
 *   MOB    → GET /api/meal-on-board
 *          → GET /api/active-meals
 *          → GET /api/meal-timing-assessment
 *   COMBO  → GET /api/active-effects-full
 *   CUMUL  → GET /api/cumulative-effects
 */

import apiClient from './client';
import API from './endpoints';

// ─────────────────────────────────────────────────────────────────────────────
// IOB TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Per-dose breakdown returned by /api/insulin/active-effect */
export interface InsulinContribution {
  dose_id: string;
  medication: string;
  initial_dose: number;
  taken_at: string;
  hours_since_dose: number;
  activity_percent: number;
  active_units: number;
}

/** Full IOB result from /api/insulin/active-effect */
export interface ActiveInsulinResult {
  total_active_insulin: number;
  calculation_time: string;
  calculation_timezone: string;
  active_doses: number;
  insulin_contributions: InsulinContribution[];
}

// ─────────────────────────────────────────────────────────────────────────────
// MOB TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-meal contribution returned by /api/meal-on-board.
 *
 * NOTE: This is distinct from MealContributionDetail (below) which comes from
 * /api/active-effects-full. The two endpoints use different field names for
 * the same conceptual data because they were built at different times.
 */
export interface MealContribution {
  meal_id: string;
  meal_type: string;
  meal_time: string;
  total_carbs: number;
  active_carbs: number;
  absorbed_carbs: number;
  activity_percent: number;
  hours_elapsed: number;
  absorption_type: string;
  duration_remaining: number;
}

/** Full MOB result from /api/meal-on-board */
export interface MealOnBoardResult {
  total_active_carbs: number;
  expected_bg_impact: number;
  contributions: MealContribution[];
  active_meal_count: number;
  calculation_time: string;
  calculation_timezone: string;
}

/** Query params accepted by getMealOnBoard() and getActiveMeals() */
export interface GetMOBParams {
  patient_id?: string;
  /** ISO timestamp string — pass directly if you have it */
  target_time?: string;
  max_hours_back?: number;
}

/** Single active meal entry from /api/active-meals */
export interface ActiveMealData {
  meal_id: string;
  meal_type: string;
  timestamp: string;
  food_items: any[];
  mob_data: {
    active_carbs: number;
    total_carbs: number;
    absorbed_carbs: number;
    activity_percent: number;
    hours_elapsed: number;
    absorption_type: string;
    duration_remaining: number;
  };
}

/** Full response from /api/active-meals */
export interface ActiveMealsResponse {
  active_meals: ActiveMealData[];
  count: number;
}

/** Response from /api/meal-timing-assessment */
export interface MealTimingAssessment {
  safety: 'safe' | 'caution' | 'risky';
  recommendation: string;
  warning: string | null;
  active_carbs: number;
  should_wait: boolean;
  active_meals: Array<{
    meal_type: string;
    hours_elapsed: number;
    active_carbs: number;
    absorption_type: string;
    activity_percent: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CUMULATIVE / ACTIVE-EFFECTS-FULL TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-meal contribution inside ActiveEffectsFullResult.mob.
 * Field names differ from MealContribution because this comes from a different
 * endpoint (/api/active-effects-full vs /api/meal-on-board).
 */
export interface MealContributionDetail {
  meal_id: string;
  meal_type: string;
  carbs: number;
  meal_time: string;
  hours_since_meal: number;
  absorbed_fraction: number;
  remaining_carbs: number;
  active_carb_equivalents: number;
}

/** Cumulative daily effects from /api/cumulative-effects */
export interface CumulativeEffectsResult {
  cumulative_meal_effect: number;
  cumulative_insulin_effect: number;
  cumulative_net_baseline: number;
  meal_contributions: Array<{
    meal_id: string;
    meal_time: string;
    /** FIX N-3: backend field is meal_type, not present in old interface */
    meal_type: string;
    /** FIX N-3: was 'carbs' — backend returns 'total_carbs' */
    total_carbs: number;
    /** FIX N-3: was 'bg_elevation' — backend returns 'cumulative_bg_effect' (signed) */
    cumulative_bg_effect: number;
  }>;
  insulin_contributions: Array<{
    dose_id: string;
    /** FIX N-3: was 'taken_at' — backend returns 'dose_time' */
    dose_time: string;
    /** FIX N-3: backend field is medication, not present in old interface */
    medication: string;
    dose: number;
    /** FIX N-3: was 'bg_reduction' — backend returns 'cumulative_bg_effect' (negative Convention A) */
    cumulative_bg_effect: number;
  }>;
  reset_hour: number;
  calculation_time: string;
  next_reset: string;
  // B-3 fix: four activity fields the backend serializes into cumulative_data
  // (via PATCH 3 in cumulative_effects_routes.py) but were absent from this interface.
  // TypeScript consumers reading these fields silently received `undefined` before this fix.
  /** Signed BG contribution from exercise (negative = aerobic BG-lowering). */
  cumulative_activity_effect: number;
  /** Unsigned remaining acute BG drop still to come (analogous to IOB). */
  activity_on_board: number;
  /**
   * Post-exercise ISF/CR sensitivity multiplier (≥ 1.0).
   * Key renamed from 'activity_sensitivity_multiplier' to 'sensitivity_multiplier'
   * in the backend (B-3 backend fix) to match the primary PD endpoint.
   */
  sensitivity_multiplier: number;
  /** Per-session breakdown — same shape as ActivityPDResult.activity_contributions. */
  activity_contributions: Array<{
    activity_id: string;
    start_time: string;
    intensity: string;
    duration_minutes: number;
    bg_direction: -1 | 1;
    cumulative_bg_effect: number;
    remaining_bg_drop: number;
    absorbed_fraction: number;
    is_active: boolean;
    model: 'hr_ode' | 'synthetic_hr';
  }>;
}

/** BG estimates section inside ActiveEffectsFullResult */
export interface BGEstimates {
  stable_baseline: number;
  current_estimated_bg: number;
  projected_final_bg: number;
  /** Meal + insulin cumulative net (Convention A: insulin negative). Excludes activity. */
  cumulative_net_baseline: number;
  pending_net_effect: number;
  pending_mob_rise: number;
  pending_iob_reduction: number;
  // Reading-present fields — null in the target_fallback path (no reading today)
  reading_value: number | null;
  reading_timestamp: string | null;
  minutes_since_reading: number | null;
  cumulative_meal_effect_at_reading: number | null;
  cumulative_insulin_effect_at_reading: number | null;
  /**
   * Meal + insulin + activity net at reading time (Convention B: insulin magnitude subtracted).
   * Numerically equivalent to Convention A net. Used by reading-anchored BG formula.
   */
  cumulative_net_effect_at_reading: number | null;
  meals_at_reading_count: number | null;
  insulin_at_reading_count: number | null;
  // Activity fields (default 0 when no sessions logged)
  /** Signed BG contribution from exercise now (negative = aerobic BG-lowering). */
  cumulative_activity_effect: number;
  /** Activity effect at the reading moment (already included in cumulative_net_effect_at_reading). */
  activity_effect_at_reading: number | null;
  activity_on_board: number;
  /** Post-exercise ISF/CR sensitivity multiplier (≥ 1.0). Renamed from activity_sensitivity_mult (B-PD-4). */
  sensitivity_multiplier: number;
  /**
   * FIX N-6: Per-session breakdown — same shape as ActivityPDResult.activity_contributions.
   * Returned by the backend on both the reading-anchored and target-fallback paths.
   * Import ActivityContribution from activity-pharmacodynamics to type call-sites.
   */
  activity_contributions: Array<{
    activity_id: string;
    start_time: string;
    intensity: string;
    duration_minutes: number;
    bg_direction: -1 | 1;
    cumulative_bg_effect: number;
    remaining_bg_drop: number;
    absorbed_fraction: number;
    is_active: boolean;
    model: 'hr_ode' | 'synthetic_hr';
  }>;
}

/** Full response from /api/active-effects-full */
export interface ActiveEffectsFullResult {
  iob: {
    totalIOB: number;
    total_active_insulin?: number;
    active_doses?: number;
    pending_bg_reduction?: number;
    insulin_contributions?: InsulinContribution[];
  };
  mob: {
    totalActiveCarbs: number;
    total_active_carbs?: number;
    total_absorbed_carbs?: number;
    active_meals?: number;
    current_bg_elevation?: number;
    expected_bg_impact?: number;
    pending_bg_rise?: number;
    meal_contributions?: MealContributionDetail[];
  };
  cumulative: CumulativeEffectsResult;
  bg_estimates: BGEstimates | null;
  totalIOB: number;
  totalActiveCarbs: number;
  cumulative_meal_effect: number;
  cumulative_insulin_effect: number;
  cumulative_net_baseline: number;
  instantaneous_meal_effect: number;
  calculation_time: string;
  patient_id: string;
  reset_hour: number;
  next_reset: string;
  // B-4 fix: three top-level activity fields the backend serializes at the result root
  // (PATCH 6 in cumulative_effects_routes.py) but were absent from this interface.
  // These are safe top-level fallbacks when bg_estimates is null (e.g. on exception).
  /** Signed BG contribution from exercise now (negative = aerobic BG-lowering). */
  cumulative_activity_effect: number;
  /** Unsigned remaining acute BG drop still to come. */
  activity_on_board: number;
  /** Post-exercise ISF/CR sensitivity multiplier (≥ 1.0). Matches bg_estimates.sensitivity_multiplier. Renamed from activity_sensitivity_mult (B-PD-4). */
  sensitivity_multiplier: number;
}

/** Legacy shape — kept for backward compat with getNetEffect() callers */
export interface NetEffectResult {
  netEffect: number;
  insulin: {
    totalActive: number;
    expectedBGImpact: number;
    contributions: Array<{
      doseId: string;
      medication: string;
      activeUnits: number;
      bgImpact: number;
    }>;
  };
  meals: {
    totalMOB: number;
    expectedBGImpact: number;
    contributions: Array<{
      mealId: string;
      mealType: string;
      activeCarbEquivalents: number;
      bgImpact: number;
    }>;
  };
  calculationTime: string;
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// IOB API FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get active insulin on board (IOB).
 *
 * @param time - Optional calculation time as a JS timestamp (ms). Omit for "now".
 */
export const getActiveInsulin = async (time?: number): Promise<ActiveInsulinResult> => {
  // B-6 fix: backend reads request.args.get('target_time') — not 'time'.
  // Passing { time: ... } silently returned current IOB for every historical query.
  const params = time ? { target_time: new Date(time).toISOString() } : {};
  const response = await apiClient.get<ActiveInsulinResult>(API.CALCULATIONS.IOB, { params });
  return response.data;
};

// ─────────────────────────────────────────────────────────────────────────────
// MOB API FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get Meal On Board — active carbs still being absorbed from recent meals.
 *
 * Accepts either a structured GetMOBParams object or a bare millisecond
 * timestamp for backward compatibility with old calculations.ts callers.
 *
 * @example
 * // Rich params (from mob.ts callers)
 * getMealOnBoard({ patient_id: '123', max_hours_back: 6 })
 *
 * // Legacy timestamp (from old calculations.ts callers)
 * getMealOnBoard(Date.now())
 */
export const getMealOnBoard = async (
  paramsOrTime?: GetMOBParams | number
): Promise<MealOnBoardResult> => {
  const queryParams: Record<string, string> = {};

  if (typeof paramsOrTime === 'number') {
    // Legacy call: getMealOnBoard(timestampMs)
    queryParams.target_time = new Date(paramsOrTime).toISOString();
  } else if (paramsOrTime) {
    if (paramsOrTime.patient_id) {
      queryParams.patient_id = paramsOrTime.patient_id;
    }
    if (paramsOrTime.target_time) {
      queryParams.target_time = paramsOrTime.target_time;
    }
    if (paramsOrTime.max_hours_back !== undefined) {
      queryParams.max_hours_back = paramsOrTime.max_hours_back.toString();
    }
  }

  const response = await apiClient.get<MealOnBoardResult>(API.MOB.GET, { params: queryParams });
  return response.data;
};

/**
 * Get list of meals that are currently still absorbing.
 */
export const getActiveMeals = async (params: GetMOBParams = {}): Promise<ActiveMealsResponse> => {
  const queryParams: Record<string, string> = {};

  if (params.patient_id) {
    queryParams.patient_id = params.patient_id;
  }
  if (params.max_hours_back !== undefined) {
    queryParams.max_hours_back = params.max_hours_back.toString();
  }

  const response = await apiClient.get<ActiveMealsResponse>(API.MOB.ACTIVE_MEALS, { params: queryParams });
  return response.data;
};

/**
 * Get meal timing safety assessment — "is it safe to eat right now?"
 */
export const getMealTimingAssessment = async (
  params: { patient_id?: string } = {}
): Promise<MealTimingAssessment> => {
  const queryParams: Record<string, string> = {};

  if (params.patient_id) {
    queryParams.patient_id = params.patient_id;
  }

  const response = await apiClient.get<MealTimingAssessment>(
    API.MOB.TIMING_ASSESSMENT,
    { params: queryParams }
  );

  // Defensive extraction — backend may nest payload under 'assessment' or 'data',
  // or return it flat. Previously response.data.safety was always undefined because
  // the actual data was one level deeper.
  const raw = response.data as any;

  const assessment: MealTimingAssessment =
    raw?.safety             !== undefined ? raw            :
    raw?.assessment?.safety !== undefined ? raw.assessment :
    raw?.data?.safety       !== undefined ? raw.data       :
    raw;

  return assessment;
};

// ─────────────────────────────────────────────────────────────────────────────
// CUMULATIVE / COMBO API FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get cumulative daily effects — the baseline shift from all of today's meals
 * and insulin doses since the last daily reset.
 *
 * @param time - Optional calculation time as a JS timestamp (ms).
 * @param patientId - Optional; for doctors viewing a specific patient.
 * @param timezoneOffsetMinutes - Patient's UTC offset in minutes (e.g. +120 for EET).
 */
export const getCumulativeEffects = async (
  time?: number,
  patientId?: string,
  timezoneOffsetMinutes?: number
): Promise<CumulativeEffectsResult> => {
  const params: Record<string, any> = {};
  if (time) params.target_time = new Date(time).toISOString();
  if (patientId) params.patient_id = patientId;
  if (timezoneOffsetMinutes !== undefined) params.timezone_offset_minutes = timezoneOffsetMinutes;

  // Runtime guard: if timezone_offset_minutes is 0 but the device is not in
  // UTC, the stored timestamps may not have been UTC-converted, which will
  // cause the cumulative window (daily reset) to be mis-anchored.
  // JS getTimezoneOffset() returns NEGATIVE for east-of-UTC — flip the sign.
  if (timezoneOffsetMinutes !== undefined) {
    const deviceOffset = -new Date().getTimezoneOffset();
    const storedOffset = timezoneOffsetMinutes;
    if (storedOffset === 0 && deviceOffset !== 0) {
      console.warn(
        `[calculations] getCumulativeEffects: timezone_offset_minutes=0 but device offset=${deviceOffset}min. ` +
        `CGM timestamps may not have been UTC-converted. ` +
        `Set timezone_offset_minutes in patient constants (positive = east of UTC, e.g. Egypt = 120).`
      );
    } else if (Math.abs(deviceOffset - storedOffset) > 60) {
      console.warn(
        `[calculations] getCumulativeEffects: timezone mismatch — ` +
        `stored=${storedOffset}min, device=${deviceOffset}min (diff=${Math.abs(deviceOffset - storedOffset)}min). ` +
        `CGM timestamps and cumulative effects window may be offset.`
      );
    }
  }

  const response = await apiClient.get<CumulativeEffectsResult>(
    API.CALCULATIONS.CUMULATIVE_EFFECTS,
    { params }
  );
  return response.data;
};

/**
 * Get the full active-effects snapshot: IOB + MOB + Cumulative + BG Estimates.
 *
 * Prefer this over calling getActiveInsulin / getMealOnBoard / getCumulativeEffects
 * separately whenever you need more than one of them — it's a single round trip.
 *
 * @param time - Optional calculation time as a JS timestamp (ms).
 * @param patientId - Optional; for doctors viewing a specific patient.
 * @param timezoneOffsetMinutes - Patient's UTC offset in minutes.
 *
 * @example
 * const effects = await getActiveEffectsFull(undefined, undefined, 120); // EET
 * console.log('Current BG:', effects.bg_estimates?.current_estimated_bg);
 * console.log('IOB:', effects.totalIOB);
 * console.log('MOB:', effects.totalActiveCarbs);
 */
export const getActiveEffectsFull = async (
  time?: number,
  patientId?: string,
  timezoneOffsetMinutes?: number
): Promise<ActiveEffectsFullResult> => {
  const params: Record<string, any> = {};
  if (time) params.target_time = new Date(time).toISOString();
  if (patientId) params.patient_id = patientId;
  if (timezoneOffsetMinutes !== undefined) params.timezone_offset_minutes = timezoneOffsetMinutes;

  // Runtime guard: warn when the stored offset is misconfigured relative to
  // the device. JS getTimezoneOffset() returns NEGATIVE for east-of-UTC.
  if (timezoneOffsetMinutes !== undefined) {
    const deviceOffset = -new Date().getTimezoneOffset();
    const storedOffset = timezoneOffsetMinutes;
    if (storedOffset === 0 && deviceOffset !== 0) {
      console.warn(
        `[calculations] getActiveEffectsFull: timezone_offset_minutes=0 but device offset=${deviceOffset}min. ` +
        `CGM timestamps may not have been UTC-converted. ` +
        `Set timezone_offset_minutes in patient constants (positive = east of UTC, e.g. Egypt = 120).`
      );
    } else if (Math.abs(deviceOffset - storedOffset) > 60) {
      console.warn(
        `[calculations] getActiveEffectsFull: timezone mismatch — ` +
        `stored=${storedOffset}min, device=${deviceOffset}min (diff=${Math.abs(deviceOffset - storedOffset)}min). ` +
        `CGM timestamps and active-effects window may be offset.`
      );
    }
  }

  const response = await apiClient.get<ActiveEffectsFullResult>(
    API.CALCULATIONS.ACTIVE_EFFECTS_FULL,
    { params }
  );
  return response.data;
};

/**
 * Get net effect calculation.
 *
 * ⚠️  B-10: The backend route /api/net-effect does NOT exist in the current
 * codebase. This function throws immediately so misuse is surfaced at
 * development time rather than silently swallowed as an empty response.
 *
 * Use getActiveEffectsFull() instead — it returns the same data via the
 * live /api/active-effects-full endpoint.
 *
 * @deprecated — no backend route exists. Throws on every call.
 */
export const getNetEffect = async (_time?: number): Promise<never> => {
  throw new Error(
    '[calculations] getNetEffect(): /api/net-effect has no backend route. ' +
    'Use getActiveEffectsFull() instead.'
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS (no network calls)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the expected blood glucose rise from a given active-carb load.
 *
 * @param activeCarbs - Active carbs in grams (from MealOnBoardResult.total_active_carbs)
 * @param carbToBgFactor - Patient's carb-to-BG factor from patientConstants.carb_to_bg_factor
 */
export const calculateMOBBgImpact = (
  activeCarbs: number,
  carbToBgFactor: number
): number => {
  return Math.round(activeCarbs * carbToBgFactor);
};

/**
 * Classify MOB data into a safety level and human-readable message.
 *
 * Thresholds:
 *   < 5 g active carbs  → safe
 *   5–29 g              → caution (account for active carbs)
 *   ≥ 30 g              → risky (consider waiting)
 */
export const assessMealSafety = (
  mobData: MealOnBoardResult
): { isSafe: boolean; level: 'safe' | 'caution' | 'risky'; message: string } => {
  const { total_active_carbs } = mobData;

  if (total_active_carbs < 5) {
    return { isSafe: true, level: 'safe', message: 'Safe to eat now' };
  }
  if (total_active_carbs < 30) {
    return {
      isSafe: true,
      level: 'caution',
      message: 'Account for active carbs in insulin calculation',
    };
  }
  return {
    isSafe: false,
    level: 'risky',
    message: 'Consider waiting 30-60 minutes before eating',
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default {
  // IOB
  getActiveInsulin,
  // MOB
  getMealOnBoard,
  getActiveMeals,
  getMealTimingAssessment,
  calculateMOBBgImpact,
  assessMealSafety,
  // Cumulative / combo
  getCumulativeEffects,
  getActiveEffectsFull,
  // ⚠️  B-10: getNetEffect intentionally excluded from default export.
  // It is still named-exported above for call-site discovery, but throws
  // immediately to surface misuse. Use getActiveEffectsFull() instead.
};