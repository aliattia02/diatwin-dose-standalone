/**
 * Insulin Calculation Service
 * Location: mobile/services/insulinCalculationService.ts
 *
 * Ports the full insulin calculation pipeline from EnhancedPatientConstantsCalc.js
 * to TypeScript so all calculations run on-device (no backend call needed).
 *
 * Mirrors exactly the logic in MealInput.jsx → calculateInsulinNeeds()
 * which calls calculateInsulinDose() from EnhancedPatientConstantsCalc.js.
 *
 * Calculation pipeline (same order as JS):
 *   1. calculateTotalNutrients()   – carbs/protein/fat + weighted absorption type
 *   2. calculateCarbEquivalents()  – protein & fat → carb-equivalent grams
 *   3. calculateUnifiedMealImpact()– base insulin from carb equivalents / ICR
 *   4. calculateActivityImpact()   – scale insulin by activity level & duration
 *   5. correctionInsulin           – (BG − target) / correction_factor
 *   6. IOB/MOB deduction           – subtract active insulin, add MOB equivalent
 *   7. peakOverlapAdjustment       – predictive overlap of existing MOB/IOB
 *   8. calculateHealthFactors()    – disease + medication multipliers
 *   9. Round to 0.1u, apply 0.5u safety floor
 *
 * Author: DiaTwin Team (TS port)
 * Version: 1.0
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AbsorptionType = 'very_fast' | 'fast' | 'medium' | 'slow' | 'very_slow' | 'mixed';

export interface FoodItem {
  name?: string;
  details?: {
    carbs?: number;
    protein?: number;
    fat?: number;
    absorption_type?: AbsorptionType;
    serving_size?: {
      w_amount?: number;
      w_unit?: string;
      amount?: number;
      unit?: string;
    };
  };
  portion?: {
    activeMeasurement?: 'weight' | 'volume';
    w_amount?: number;
    w_unit?: string;
    amount?: number;
    unit?: string;
  };
}

export interface TotalNutrition {
  carbs: number;
  protein: number;
  fat: number;
  absorptionType: AbsorptionType;
  absorptionMetadata?: {
    weightedType: AbsorptionType;
    foodTypes: Array<{ food: string; type: AbsorptionType; carbs: number }>;
    totalCarbWeight: number;
  };
}

export interface CarbEquivalents {
  carbsActual: number;
  proteinCarbEquiv: number;
  fatCarbEquiv: number;
  totalCarbEquiv: number;
}

export interface ActivityEntry {
  level: number | string;   // −2..+2 or string key
  startTime?: string;       // ISO UTC
  endTime?: string;         // ISO UTC
  duration?: number | string; // hours or "H:MM"
}

export interface PatientConstants {
  insulin_to_carb_ratio?: number;
  correction_factor?: number;
  target_glucose?: number;
  protein_factor?: number;
  fat_factor?: number;
  carb_to_bg_factor?: number;
  /** Legacy alias for carb_to_bg_factor — present in older MongoDB documents. Dual-key guard applies wherever this is read. */
  carb_to_bg_ratio?: number;
  activity_coefficients?: Record<string, number>;
  absorption_modifiers?: Record<string, number>;
  active_conditions?: string[];
  active_medications?: string[];
  disease_factors?: Record<string, { factor?: number; description?: string }>;
  medication_factors?: Record<string, MedicationFactor>;
  medication_schedules?: Record<string, MedicationSchedule>;
}

export interface MedicationFactor {
  factor?: number;
  duration_based?: boolean;
  peak_hours?: number;
  duration_hours?: number;
  description?: string;
}

export interface MedicationSchedule {
  last_taken?: string;
  daily_times?: string[];
}

export interface AbsorptionProfile {
  onset_hours: number;
  peak_hours: number;
  duration_hours: number;
  shape_param?: number;
  scale_param?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HR / EXERCISE ODE MODEL  (mirrors activity_pharmacodynamics.py)
// ─────────────────────────────────────────────────────────────────────────────
import {
  HR_MODEL,
  LEVEL_TO_INTENSITY,
  INTENSITY_HR_FRACTION,
  MEAL_ABSORPTION_PROFILES,
} from '@/constants/shared-constants';

// ─────────────────────────────────────────────────────────────────────────────
// ABSORPTION PROFILES  (sourced from SHARED_CONSTANTS — TS-C-10)
// ─────────────────────────────────────────────────────────────────────────────

/** Return absorption profile for a given type (falls back to 'medium'). */
export function getAbsorptionProfile(type: AbsorptionType): AbsorptionProfile {
  const p = MEAL_ABSORPTION_PROFILES[type] ?? MEAL_ABSORPTION_PROFILES.medium;
  return {
    onset_hours:    p.onset_hours,
    peak_hours:     p.peak_hours,
    duration_hours: p.duration_hours,
    shape_param:    p.shape_param,
    scale_param:    p.scale_param,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NUTRIENT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Use the canonical conversion functions from shared constants so that all
// household/custom units (palm, handful, fist, bowl, half_cup, etc.) are
// resolved correctly — matching exactly what SelectedFoodsList displays.
import { convertToGrams, convertToMl } from '@/constants';

/**
 * Calculate the scaled nutrients for a single food item based on portion size.
 * Mirrors calculateNutrients() in EnhancedPatientConstantsCalc.js.
 */
export function calculateNutrients(food: FoodItem): {
  carbs: number; protein: number; fat: number; absorptionType: AbsorptionType;
} {
  if (!food.details) return { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };

  let conversionRatio = 1;
  const portion = food.portion ?? {};
  const serving = food.details.serving_size ?? {};

  if (portion.activeMeasurement === 'weight') {
    const portionGrams = convertToGrams(portion.w_amount ?? 100, portion.w_unit ?? 'g');
    const servingGrams = convertToGrams(serving.w_amount ?? 100, serving.w_unit ?? 'g');
    conversionRatio = servingGrams > 0 ? portionGrams / servingGrams : 1;
  } else {
    const portionMl = convertToMl(portion.amount ?? 1, portion.unit ?? 'serving');
    const servingMl  = convertToMl(serving.amount ?? 1, serving.unit ?? 'serving');
    conversionRatio = servingMl > 0 ? portionMl / servingMl : 1;
  }

  return {
    carbs:  (food.details.carbs   ?? 0) * conversionRatio,
    protein:(food.details.protein ?? 0) * conversionRatio,
    fat:    (food.details.fat     ?? 0) * conversionRatio,
    absorptionType: (food.details.absorption_type ?? 'medium') as AbsorptionType,
  };
}

// Absorption type numeric values for weighted average
const ABSORPTION_VALUES: Record<AbsorptionType, number> = {
  very_fast: 5, fast: 4, medium: 3, slow: 2, very_slow: 1,
};
const ABSORPTION_REVERSE: Record<number, AbsorptionType> = {
  5: 'very_fast', 4: 'fast', 3: 'medium', 2: 'slow', 1: 'very_slow',
};

/**
 * Sum nutrients across all selected food items and compute weighted absorption type.
 * Mirrors calculateTotalNutrients() in EnhancedPatientConstantsCalc.js.
 */
export function calculateTotalNutrients(selectedFoods: FoodItem[]): TotalNutrition {
  const total: TotalNutrition = { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };
  if (!selectedFoods?.length) return total;

  let totalWeight = 0;
  let weightedSum = 0;
  const foodTypes: TotalNutrition['absorptionMetadata'] extends undefined ? never : NonNullable<TotalNutrition['absorptionMetadata']>['foodTypes'] = [];

  for (const food of selectedFoods) {
    const n = calculateNutrients(food);
    total.carbs   += n.carbs;
    total.protein += n.protein;
    total.fat     += n.fat;

    if (n.carbs > 0) {
      const val = ABSORPTION_VALUES[n.absorptionType] ?? 3;
      weightedSum += val * n.carbs;
      totalWeight += n.carbs;
      foodTypes.push({ food: food.name ?? 'Unknown', type: n.absorptionType, carbs: n.carbs });
    }
  }

  if (totalWeight > 0) {
    const avg = Math.round(weightedSum / totalWeight);
    total.absorptionType = ABSORPTION_REVERSE[avg] ?? 'medium';
  }

  total.absorptionMetadata = {
    weightedType: total.absorptionType,
    foodTypes,
    totalCarbWeight: totalWeight,
  };
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARB EQUIVALENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert protein & fat grams into their carbohydrate-equivalent impact
 * using patient-specific protein_factor and fat_factor.
 * Mirrors calculateCarbEquivalents() in EnhancedPatientConstantsCalc.js.
 */
export function calculateCarbEquivalents(
  carbs: number,
  protein: number,
  fat: number,
  constants: PatientConstants,
): CarbEquivalents {
  const proteinFactor = constants.protein_factor ?? 0.5;
  const fatFactor     = constants.fat_factor     ?? 0.2;

  const carbsActual      = carbs   ?? 0;
  const proteinCarbEquiv = (protein ?? 0) * proteinFactor;
  const fatCarbEquiv     = (fat    ?? 0) * fatFactor;
  const totalCarbEquiv   = carbsActual + proteinCarbEquiv + fatCarbEquiv;

  return { carbsActual, proteinCarbEquiv, fatCarbEquiv, totalCarbEquiv };
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH FACTORS  (disease conditions + medications)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the pharmacokinetic effect of a duration-based medication.
 * Mirrors calculateMedicationEffect() in EnhancedPatientConstantsCalc.js.
 */
function calculateMedicationEffect(
  medData: MedicationFactor,
  schedule: MedicationSchedule | undefined,
  currentDate: Date,
): { factor: number } {
  const baseFactor = medData.factor ?? 1.0;
  if (!medData.duration_based) return { factor: baseFactor };
  if (!schedule) return { factor: baseFactor };

  let lastDoseTime: Date | null = null;

  if (schedule.last_taken) {
    lastDoseTime = new Date(schedule.last_taken);
  } else if (schedule.daily_times?.length) {
    const today = new Date(currentDate);
    for (const timeStr of [...schedule.daily_times].sort().reverse()) {
      const [h, m] = timeStr.split(':').map(Number);
      const t = new Date(today);
      t.setHours(h, m, 0, 0);
      if (t <= currentDate) { lastDoseTime = t; break; }
    }
    if (!lastDoseTime) {
      const lastStr = [...schedule.daily_times].sort().reverse()[0];
      const [h, m] = lastStr.split(':').map(Number);
      const yesterday = new Date(currentDate);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(h, m, 0, 0);
      lastDoseTime = yesterday;
    }
  }

  if (!lastDoseTime) return { factor: baseFactor };

  const hoursSince = (currentDate.getTime() - lastDoseTime.getTime()) / 3_600_000;
  const peakHours  = medData.peak_hours     ?? 2;
  const durationH  = medData.duration_hours ?? 8;

  let multiplier: number;
  if (hoursSince < 0) {
    multiplier = 0;
  } else if (hoursSince <= peakHours) {
    multiplier = hoursSince / peakHours;
  } else if (hoursSince <= durationH) {
    const decay = (hoursSince - peakHours) / (durationH - peakHours);
    multiplier = Math.exp(-2.0 * decay);
  } else {
    multiplier = 0;
  }

  return { factor: 1.0 + (baseFactor - 1.0) * multiplier };
}

/**
 * Compute the combined health multiplier from all active conditions & medications.
 * Mirrors calculateHealthFactors() in EnhancedPatientConstantsCalc.js.
 */
export function calculateHealthFactors(
  constants: PatientConstants,
  currentDate: Date = new Date(),
): number {
  if (!constants) return 1.0;
  let multiplier = 1.0;

  // Conditions
  for (const condition of constants.active_conditions ?? []) {
    const data = constants.disease_factors?.[condition];
    if (data?.factor) multiplier *= data.factor;
  }

  // Medications
  for (const med of constants.active_medications ?? []) {
    const medData  = constants.medication_factors?.[med];
    if (!medData?.factor) continue;
    const schedule = constants.medication_schedules?.[med];

    if (medData.duration_based) {
      const effect = calculateMedicationEffect(medData, schedule, currentDate);
      multiplier *= effect.factor;
    } else {
      multiplier *= medData.factor;
    }
  }

  return multiplier;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY IMPACT
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "H:MM" or numeric duration string → total hours. */
function parseDurationHours(duration: string | number | undefined): number {
  if (duration === undefined || duration === null) return 0;
  if (typeof duration === 'number') return duration;
  if (duration.includes(':')) {
    const [h, m] = duration.split(':').map(Number);
    return h + m / 60;
  }
  return parseFloat(duration) || 0;
}

/** Calculate duration in hours between two UTC ISO strings. */
function durationBetween(startISO?: string, endISO?: string): number {
  if (!startISO || !endISO) return 0;
  return (new Date(endISO).getTime() - new Date(startISO).getTime()) / 3_600_000;
}

/**
 * Compute the combined activity impact coefficient.
 * Mirrors calculateActivityImpact() in EnhancedPatientConstantsCalc.js.
 */
export function calculateActivityImpact(
  activities: ActivityEntry[],
  constants: PatientConstants,
): number {
  if (!activities?.length || !constants?.activity_coefficients) return 1.0;

  let totalImpact = 1.0;
  for (const activity of activities) {
    const level = activity.level.toString();
    const coefficient = constants.activity_coefficients[level] ?? 1.0;

    let hours: number;
    if (activity.startTime && activity.endTime) {
      hours = durationBetween(activity.startTime, activity.endTime);
    } else {
      hours = parseDurationHours(activity.duration);
    }

    const durationWeight    = Math.min(hours / 2, 1);
    const weightedImpact    = 1.0 + (coefficient - 1.0) * durationWeight;
    totalImpact            *= weightedImpact;
  }

  return 1.0 + (totalImpact - 1.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC SENSITIVITY MULTIPLIER  (unifies manual-form activities with PD pathway)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intensity label → HR fraction of (hrMax − hrBase).
 * Sourced from SHARED_CONSTANTS.INTENSITY_HR_FRACTION — TS-C-11.
 * (const re-bound locally for readability; do not redeclare values here.)
 */

/**
 * Activity level (numeric string) → intensity label.
 * Sourced from SHARED_CONSTANTS.LEVEL_TO_INTENSITY — TS-C-9.
 * Levels ≤ −1 are sedentary/sick days → null (no BG-lowering ODE run).
 * Levels 0 / 1 / 2 map to light / moderate / vigorous.
 */

/**
 * Simulate the Dalla Man / Breton HR exercise ODE (W-state) for a set of
 * manually-entered form activities and return the equivalent post-exercise
 * insulin sensitivity multiplier (≥ 1.0).
 *
 * This is the same model the backend runs for pre-logged PD sessions.
 * By routing manual activities through this function instead of the legacy
 * coefficient system, both pathways produce comparable dose reductions.
 *
 * ODE (Euler, dt = HR_MODEL.dt minutes) — matches activity-pharmacodynamics.ts
 * and the Python backend exactly:
 *
 *   dY/dt = (hrAboveFull − Y) / τ_HR      Y = low-pass filter of excess HR (bpm)
 *   dZ/dt = (1 − Z)   if exercising AND Y > a·hrBase   (Z saturates to 1)
 *         = (−Z / τ_Z)  otherwise                       (Z decays back to 0)
 *   dW/dt = Y          if exercising       (W accumulates area under Y)
 *         = (−W / τ_W)  otherwise          (W decays in recovery)
 *
 * Sensitivity multiplier (per session):
 *   boost = min(alpha × W_at_now, max_sensitivity_boost)
 *
 * Multiple sessions use max() across sessions, not additive sum, because
 * GLUT4 up-regulation does not stack additively (matches backend behaviour).
 *
 * @param now  Reference timestamp in ms — used to integrate the W-state decay
 *             from exercise-end up to the moment the meal form is being filled.
 *             Defaults to Date.now(). Pass a fixed value in tests.
 */
export function computeSyntheticSensitivityMultiplier(
  activities: ActivityEntry[],
  constants: PatientConstants,
  now: number = Date.now(),
): number {
  if (!activities?.length) return 1.0;

  const hrBase = (constants as any).hr_base ?? HR_MODEL.hr_base_pop;
  const hrMax  = (constants as any).hr_max  ?? HR_MODEL.hr_max_pop;
  const {
    tau_HR,
    tau_Z,
    tau_W,
    a,
    alpha,
    max_sensitivity_boost,
    dt,
  } = HR_MODEL;

  // Y must exceed this before Z and W gates open (mirrors Python `onset_active`)
  const onsetThreshold = a * hrBase; // e.g. 0.05 × 70 = 3.5 bpm

  // Backend uses max() across sessions: GLUT4 receptors don't stack additively.
  let maxBoost = 0;

  for (const activity of activities) {
    const intensityKey = LEVEL_TO_INTENSITY[activity.level.toString()];
    // Levels -2/-1 map to null in SHARED_CONSTANTS → sedentary/sick, no BG-lowering ODE
    if (intensityKey === null || intensityKey === undefined) continue;
    const hrFraction   = INTENSITY_HR_FRACTION[intensityKey] ?? 0.65;
    const hrTarget     = hrBase + hrFraction * (hrMax - hrBase);
    const hrAboveFull  = hrTarget - hrBase; // excess HR during exercise (bpm)

    let durationMins: number;
    let recoveryMins: number;

    if (activity.startTime && activity.endTime) {
      const startMs = new Date(activity.startTime).getTime();
      const endMs   = new Date(activity.endTime).getTime();
      durationMins  = Math.max(0, (endMs - startMs) / 60_000);
      // Time since exercise ended — W decays over this window.
      recoveryMins  = Math.max(0, (now - endMs) / 60_000);
    } else {
      // Duration-only entry: assume exercise just ended; no recovery elapsed yet.
      durationMins = parseDurationHours(activity.duration) * 60;
      recoveryMins = 0;
    }

    // Cap recovery at 4 × τ_W — beyond this W has decayed to < 1 % of peak.
    recoveryMins = Math.min(recoveryMins, 4 * tau_W);

    // ── Euler integration: exercise window then recovery window ─────────────
    let Y = 0, Z = 0, W = 0;
    const totalMins  = durationMins + recoveryMins;
    const totalSteps = Math.ceil(totalMins / dt);

    for (let i = 0; i < totalSteps; i++) {
      const t          = i * dt;
      const inExercise = t < durationMins;

      // Excess HR: full during exercise, 0 afterwards
      const hrAbove = inExercise ? hrAboveFull : 0;

      // Y: low-pass filter of excess HR
      const dY = (hrAbove - Y) / tau_HR;
      Y = Math.max(0, Y + dY * dt);

      // Z: binary saturation gate (rises to 1 during exercise, decays after)
      const onsetActive = Y > onsetThreshold;
      const dZ = (inExercise && onsetActive) ? (1.0 - Z) : (-Z / tau_Z);
      Z = Math.min(1, Math.max(0, Z + dZ * dt));

      // W: integrates Y during exercise, decays with τ_W during recovery
      const dW = inExercise ? Y : (-W / tau_W);
      W = Math.max(0, W + dW * dt);
    }

    // TODO (resolved): align with Python ground truth — must use alpha * W * (1 + Z).
    // During active exercise (Z ≈ 1) the old alpha * W formula underestimated
    // sensitivity by up to 50% vs both activity-pharmacodynamics.ts and the Python
    // backend.  Z here is the post-integration Z value (decayed if recovery elapsed).
    const sessionBoost = Math.min(alpha * W * (1 + Z), max_sensitivity_boost);
    maxBoost = Math.max(maxBoost, sessionBoost);
  }

  return 1 + maxBoost;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC ACTIVITY ON BOARD  (AOB — mirrors Python get_activity_on_board)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the synthetic Activity On Board (AOB) for manually-entered form
 * activities that have not yet been persisted to the backend.
 *
 * Ports Python's `_integrate_z_drop()` + `get_activity_on_board()` using the
 * Z-state arm of the Dalla Man / Breton ODE model (the *acute* BG-drop arm,
 * distinct from the W-state used for post-exercise insulin sensitivity).
 *
 * AOB semantics (mirrors IOB):
 *   - "Total drop" = full ODE integral over [0, durationMins + 4·τ_Z] (exercise
 *     window + exponential decay tail).
 *   - "Elapsed drop" = same integral capped at the minutes that have already
 *     passed since the session started.
 *   - remaining = totalDrop × (1 − elapsed/total)     (unsigned, mg/dL)
 *
 * Z-state ODE (Euler, dt = 1 min):
 *   Y′ = (hrAbove − Y) / τ_HR              // excess-HR approach
 *   Z′ = (1 − Z)  if in_exercise & Y > threshold
 *        (-Z / τ_Z) otherwise              // Z → 1 in ~1 step; decays after
 *   acute_drop += Z × acute_rate_per_min × dt
 *
 * When only a `duration` is available (no timestamps), the activity is assumed
 * to have just ended — only the tail AOB is outstanding.
 *
 * Multiple sessions are summed independently (each session delivers its own
 * remaining drop — same additive behaviour as the backend's total_aob).
 *
 * @param activities  Manually-entered activity entries from the meal form
 * @param constants   Patient constants (hr_base, hr_max used if present)
 * @param now         Reference timestamp in ms (defaults to Date.now())
 * @returns           Total unsigned AOB in mg/dL
 */
export function computeSyntheticAOB(
  activities: ActivityEntry[],
  constants: PatientConstants,
  now: number = Date.now(),
): number {
  if (!activities?.length) return 0;

  const hrBase = (constants as any).hr_base ?? HR_MODEL.hr_base_pop;
  const hrMax  = (constants as any).hr_max  ?? HR_MODEL.hr_max_pop;
  const { tau_HR, tau_Z, a, acute_rate_per_min, dt } = HR_MODEL;

  // Y must exceed this before Z starts rising (mirrors Python `onset_active`)
  const onsetThreshold = a * hrBase;  // e.g. 0.05 × 70 = 3.5

  let totalRemainingDrop = 0;

  for (const activity of activities) {
    const intensityKey = LEVEL_TO_INTENSITY[activity.level.toString()];
    // Levels -2/-1 map to null in SHARED_CONSTANTS → sedentary/sick, no AOB
    if (intensityKey === null || intensityKey === undefined) continue;
    const hrFraction   = INTENSITY_HR_FRACTION[intensityKey] ?? 0.65;
    const hrTarget     = hrBase + hrFraction * (hrMax - hrBase);
    const hrAboveFull  = hrTarget - hrBase; // constant during exercise (synthetic trace)

    let durationMins: number;
    let elapsedMins: number;

    if (activity.startTime && activity.endTime) {
      const startMs = new Date(activity.startTime).getTime();
      durationMins  = (new Date(activity.endTime).getTime() - startMs) / 60_000;
      elapsedMins   = (now - startMs) / 60_000;
    } else {
      // Duration-only entry: assume activity just ended; only tail AOB remains
      durationMins = parseDurationHours(activity.duration) * 60;
      elapsedMins  = durationMins;
    }

    durationMins = Math.max(0, durationMins);
    elapsedMins  = Math.max(0, elapsedMins);

    // Full integration window: exercise + exponential decay tail (4 × τ_Z)
    const fullWindow = durationMins + 4.0 * tau_Z;

    // Activity not yet started or fully absorbed — contributes zero AOB
    if (durationMins === 0 || elapsedMins >= fullWindow) continue;

    // ── Euler ODE integration ────────────────────────────────────────────────
    // Mirrors Python _integrate_z_drop() with a synthetic (constant) HR trace.
    let Y = 0, Z = 0;
    let totalDrop   = 0;
    let elapsedDrop = 0;
    const steps = Math.ceil(fullWindow / dt);

    for (let i = 0; i < steps; i++) {
      const t          = i * dt;
      const inExercise = t < durationMins;

      // Synthetic HR trace: hrTarget during exercise, hrBase after
      const hrEx = inExercise ? hrAboveFull : 0;

      // Y: exponential approach to hrAboveFull (or decay back to 0)
      const dY = (hrEx - Y) / tau_HR;
      Y = Math.max(0, Y + dY * dt);

      // Z: saturation variable
      //   • Rises instantly to 1 on the first step Y > threshold (dt=1 → ΔZ = 1−Z ≈ 1)
      //   • Decays with τ_Z after exercise ends
      const onsetActive = Y > onsetThreshold;
      const dZ = (inExercise && onsetActive) ? (1.0 - Z) : (-Z / tau_Z);
      Z = Math.min(1, Math.max(0, Z + dZ * dt));

      const stepDrop = Z * acute_rate_per_min * dt;
      totalDrop += stepDrop;
      if (t < elapsedMins) elapsedDrop += stepDrop;
    }

    if (totalDrop <= 0) continue;

    const absorbedFraction = Math.min(1, elapsedDrop / totalDrop);
    const remaining        = Math.max(0, totalDrop * (1 - absorbedFraction));
    totalRemainingDrop    += remaining;
  }

  return Math.round(totalRemainingDrop * 10) / 10; // round to 0.1 mg/dL (mirrors backend)
}

// ─────────────────────────────────────────────────────────────────────────────
// PEAK OVERLAP PREDICTION  (mirrors projectMOBEffect/IOBEffect + calculatePeakOverlap)
// ─────────────────────────────────────────────────────────────────────────────

interface OverlapData {
  adjustmentFactor: number;
  existingMobAtPeak: number;
  existingIobAtPeak: number;
  netBgImpactAtPeak: number;
}

function calculateAdjustmentFromOverlap(
  mobAtPeak: number,
  iobAtPeak: number,
): number {
  let adj = 1.0;
  if (mobAtPeak > 10)  adj *= 1 + (mobAtPeak / 100) * 0.1;
  if (iobAtPeak > 1)   adj *= 1 - (iobAtPeak / 10)  * 0.2;
  return Math.max(0.5, Math.min(1.5, adj));
}

/**
 * Estimate remaining active carbs at a future time point using a simple
 * trapezoidal approximation (avoids importing the full gamma PK engine).
 */
function estimateMobAtPeak(
  activeCarbs: number,
  peakHours: number,
  profile: AbsorptionProfile,
): number {
  if (activeCarbs <= 0) return 0;
  const remaining = Math.max(0, profile.duration_hours - 1.0); // assume 1h already elapsed
  if (remaining <= 0) return 0;
  const fractionLeft = Math.max(0, 1 - peakHours / remaining);
  return activeCarbs * fractionLeft;
}

/**
 * Estimate remaining IOB at a future time point (linear decay approximation).
 */
function estimateIobAtPeak(
  activeInsulin: number,
  peakHours: number,
  insulinDurationHours = 4.0,
): number {
  if (activeInsulin <= 0) return 0;
  const elapsed = 1.5; // assume 1.5h already elapsed for current IOB
  const remaining = insulinDurationHours - elapsed;
  if (remaining <= 0) return 0;
  const fraction = Math.max(0, 1 - peakHours / remaining);
  return activeInsulin * fraction;
}

/**
 * Compute predictive peak overlap between this meal and currently active MOB/IOB.
 * Mirrors calculatePeakOverlap() in EnhancedPatientConstantsCalc.js.
 */
function calculatePeakOverlap(
  newMealProfile: AbsorptionProfile,
  activeMealCarbs: number,
  activeInsulin: number,
  constants: PatientConstants,
): OverlapData {
  const peakHours    = newMealProfile.peak_hours ?? 1.5;
  const carbToBg     = constants.carb_to_bg_factor ?? constants.carb_to_bg_ratio ?? 4.0;
  const corrFactor   = constants.correction_factor  ?? 40;

  const mobAtPeak    = estimateMobAtPeak(activeMealCarbs, peakHours, newMealProfile);
  const iobAtPeak    = estimateIobAtPeak(activeInsulin, peakHours);

  const mobBgImpact  =  mobAtPeak * carbToBg;
  const iobBgImpact  = -iobAtPeak * corrFactor;
  const netBgImpact  = mobBgImpact + iobBgImpact;

  return {
    adjustmentFactor:   calculateAdjustmentFromOverlap(mobAtPeak, iobAtPeak),
    existingMobAtPeak:  mobAtPeak,
    existingIobAtPeak:  iobAtPeak,
    netBgImpactAtPeak:  netBgImpact,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CALCULATION RESULT
// ─────────────────────────────────────────────────────────────────────────────

export interface InsulinCalculationBreakdown {
  // Carb breakdown
  carbsActual:       number;
  proteinCarbEquiv:  number;
  fatCarbEquiv:      number;
  totalCarbEquiv:    number;

  // Insulin steps
  baseInsulin:       number;   // totalCarbEquiv / ICR
  adjustedInsulin:   number;   // after manual activity (from form)
  correctionInsulin: number;   // (BG_adjusted − target) / effectiveCF
  preActiveTotal:    number;   // adjustedInsulin + correctionInsulin

  // IOB / MOB / AOB
  activeInsulin:     number;
  activeMealCarbs:   number;
  mobInsulinEquivalent: number;
  postActiveTotal:   number;   // preActiveTotal − IOB + MOB_equiv − AOB_equiv

  // Overlap & health
  overlapAdjustment: number;
  healthMultiplier:  number;
  activityImpact:    number;

  // ── Activity PD ──────────────────────────────────────────────────────────
  /** Sensitivity multiplier applied (≥ 1.0). 1.0 means no active exercise effect. */
  activitySensitivityMultiplier: number;
  /** Effective CF after sensitivity scaling (= CF × sensitivityMultiplier). */
  effectiveCF: number;
  /** Signed cumulative BG effect from exercise today (mg/dL). Negative = aerobic. */
  cumulativeActivityEffect: number;
  /** BG value actually used in correction after applying cumulativeActivityEffect. */
  bgUsedForCorrection: number;
  /** Unsigned pending BG drop from exercise still to arrive (mg/dL). */
  activityOnBoard: number;
  /** AOB converted to insulin units using effectiveCF. Subtracted from postActiveTotal. */
  aobInsulinEquivalent: number;

  // Pharmacodynamic factors (kept at 1.0 — see JS source)
  absorptionFactor:  number;
  mealTimingFactor:  number;

  // Peak overlap details
  projectedMobAtPeak: number;
  projectedIobAtPeak: number;
  netBgImpactAtPeak:  number;
  peakTime:           number;

  // Blood sugar metadata
  bloodSugarUsed:       number;
  bloodSugarSource:     string;
  bloodSugarConfidence: string;
  minutesSinceReading:  number;
  correctionNote:       string;

  // Cumulative day effects
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline:   number;
  cumulativeAdjustment:    number;

  // Absorbed amounts
  absorbedCarbs:   number;
  absorbedInsulin: number;

  // Pending adjustments
  pendingMealRise:         number;
  pendingInsulinReduction: number;
  pendingNetChange:        number;
  pendingAdjustment:       number;

  // Summary of total adjustments
  totalAdjustments: {
    cumulative: number;
    active:     number;
    activity:   number;
    pending:    number;
    total:      number;
  };

  /**
   * Present when the net IOB surplus exceeds the meal + correction need by > 0.5 u.
   * Means the patient should NOT dose — and may need extra fast carbs to offset
   * the incoming insulin and avoid a low.
   */
  iobSurplusWarning?: {
    /** Units of IOB that exceed the total meal + correction need. */
    surplusUnits:     number;
    /** Grams of fast carbs suggested to absorb the surplus (surplusUnits × ICR). */
    extraCarbsNeeded: number;
  };
}

export interface InsulinCalculationResult {
  total:     number;
  breakdown: InsulinCalculationBreakdown;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export interface CalculateInsulinDoseParams {
  // Macronutrients
  carbs:   number;
  protein: number;
  fat:     number;

  // Blood glucose
  bloodSugar:           number;
  bloodSugarSource?:    string;   // 'actual' | 'estimated' | 'target_fallback'
  bloodSugarConfidence?: string;
  minutesSinceReading?: number;

  // Context
  activities?:          ActivityEntry[];
  patientConstants:     PatientConstants;
  mealType?:            string;
  absorptionType?:      AbsorptionType;
  currentTime?:         Date;

  // Active effects (IOB / MOB)
  activeInsulinValue?:  number;
  activeMealCarbs?:     number;

  // Cumulative day effects (from active-effects-full or frontend calculation)
  cumulativeMealEffect?:    number;  // total BG rise from meals today (absorbed)
  cumulativeInsulinEffect?: number;  // total BG reduction from insulin today (absorbed)
  cumulativeNetBaseline?:   number;  // net cumulative shift from reset

  // Absorbed amounts at time of reading
  absorbedCarbs?:    number;
  absorbedInsulin?:  number;

  // Pending effects (still in pipeline)
  pendingMealRise?:         number;  // MOB-based future BG rise in mg/dL
  pendingInsulinReduction?: number;  // IOB-based future BG reduction in mg/dL

  // ── Activity PD (from GET /api/activity/pharmacodynamics) ─────────────────
  /**
   * Post-exercise GLUT4 sensitivity multiplier from the W state variable.
   * ≥ 1.0 (e.g. 1.30 = 30% more insulin-sensitive than baseline).
   * Reduces both base dose and correction dose proportionally.
   * Default: 1.0 (no exercise effect).
   */
  activitySensitivityMultiplier?: number;
  /**
   * Unsigned pending BG drop from ongoing exercise still to arrive (mg/dL).
   * Analogous to IOB — reduces the correction dose to avoid over-dosing.
   * Default: 0.
   */
  activityOnBoard?: number;
  /**
   * Signed cumulative BG effect of all today's exercise (mg/dL).
   * Negative for aerobic (lowers BG). Applied to non-actual BG estimates only —
   * mirrors the same addition in useActiveEffects / net-effect.ts.
   * Only applied when bloodSugarSource !== 'actual' to avoid double-counting
   * with a fresh meter reading.
   * Default: 0.
   */
  cumulativeActivityEffect?: number;
}

/**
 * Calculate the suggested insulin dose from meal nutrition, blood sugar,
 * activity, and active effects.
 *
 * Exactly mirrors calculateInsulinDose() in EnhancedPatientConstantsCalc.js —
 * pure synchronous, no network calls.
 */
export function calculateInsulinDose(params: CalculateInsulinDoseParams): InsulinCalculationResult {
  const {
    carbs, protein, fat,
    bloodSugar = 0,
    bloodSugarSource     = 'unknown',
    bloodSugarConfidence = 'unknown',
    minutesSinceReading  = 0,
    activities           = [],
    patientConstants,
    absorptionType       = 'medium',
    currentTime          = new Date(),
    activeInsulinValue   = 0,
    activeMealCarbs      = 0,
    cumulativeMealEffect    = 0,
    cumulativeInsulinEffect = 0,
    cumulativeNetBaseline   = 0,
    absorbedCarbs           = 0,
    absorbedInsulin         = 0,
    pendingMealRise         = 0,
    pendingInsulinReduction = 0,
    // ── Activity PD ──────────────────────────────────────────────────────────
    activitySensitivityMultiplier = 1.0,
    activityOnBoard               = 0,
    cumulativeActivityEffect      = 0,
  } = params;

  const constants = patientConstants;

  // ── Step 1: Carb equivalents ──────────────────────────────────────────────
  const carbEquiv = calculateCarbEquivalents(carbs, protein, fat, constants);
  const { totalCarbEquiv } = carbEquiv;

  // ── Step 2: Base insulin  (pharmacodynamic factors DISABLED → 1.0) ────────
  const ICR          = constants.insulin_to_carb_ratio ?? 10;
  const baseInsulin  = totalCarbEquiv / ICR;
  const absorptionFactor  = 1.0; // kept at 1.0 per JS source comment
  const mealTimingFactor  = 1.0;

  // ── Step 3: Manual activity adjustment (from form entries) ────────────────
  const activityImpact  = calculateActivityImpact(activities, constants);
  const manualActivityAdjusted = baseInsulin * activityImpact;

  // ── Step 3b: Post-exercise sensitivity (GLUT4 upregulation from activity PD) ─
  // sensitivity_multiplier ≥ 1.0 → patient is more insulin-sensitive → needs less
  // insulin.  Both the base dose AND the correction dose are scaled by dividing by /
  // multiplying the correction factor by sensitivityMultiplier.
  //
  // effectiveCF = CF × sensitivityMultiplier  (e.g. CF=40 + 1.3× → effectiveCF=52)
  //   • A larger CF means a smaller correction dose for the same BG delta  ✓
  //   • effectiveCF is pre-computed by the backend's effective_correction_factor
  //     field, but we recompute it here from the raw multiplier to keep the logic
  //     transparent and avoid depending on the backend serialisation.
  //
  // adjustedInsulin = manualActivityAdjusted / sensitivityMultiplier
  //   • 1.3× sensitivity → 30% less base dose required  ✓
  const sensitivityMult = Math.max(1.0, activitySensitivityMultiplier);
  const target          = constants.target_glucose    ?? 100;
  const CF              = constants.correction_factor ?? 40;
  const effectiveCF     = CF * sensitivityMult;

  const adjustedInsulin = manualActivityAdjusted / sensitivityMult;

  // ── Step 4: Correction insulin ────────────────────────────────────────────
  // For non-actual readings the estimatedBG from active-effects-full does NOT
  // include the activity BG contribution (separate endpoint).  We apply
  // cumulativeActivityEffect (signed, already negative for aerobic) to get the
  // best current BG estimate before computing correction — mirroring what
  // useActiveEffects / net-effect.ts does.
  //
  // For actual meter readings (bgSource === 'actual') we leave the BG as-is:
  // the meter truth already reflects the patient's current state.
  let correctionInsulin = 0;
  let correctionNote    = '';

  const bgForCorrection = (bloodSugarSource !== 'actual' && cumulativeActivityEffect !== 0)
    ? Math.max(40, bloodSugar + cumulativeActivityEffect)
    : bloodSugar;

  if (typeof bgForCorrection === 'number' && !isNaN(bgForCorrection) && bgForCorrection > 0) {
    correctionInsulin = (bgForCorrection - target) / effectiveCF;

    if      (bloodSugarSource === 'estimated')       correctionNote = `Based on estimated BG (confidence: ${bloodSugarConfidence}, ${minutesSinceReading} min since reading)`;
    else if (bloodSugarSource === 'target_fallback') correctionNote = 'Based on target glucose — no recent reading available';
    else                                              correctionNote = 'Based on actual BG reading';

    if (cumulativeActivityEffect !== 0 && bloodSugarSource !== 'actual') {
      correctionNote += ` · Activity-adjusted BG: ${Math.round(bgForCorrection)} mg/dL (${cumulativeActivityEffect > 0 ? '+' : ''}${Math.round(cumulativeActivityEffect)} from exercise)`;
    }
  }

  const preActiveTotal = adjustedInsulin + correctionInsulin;

  // ── Step 5: IOB / MOB / AOB deduction ─────────────────────────────────────
  // AOB (Activity On Board) = pending BG drop from exercise still to arrive.
  // Treated like a pending insulin effect: subtract from the dose to avoid
  // over-correcting for a BG that will drop on its own.
  // Converted to insulin units using effectiveCF (sensitivity-scaled).
  const activeInsulin        = activeInsulinValue ?? 0;
  const mobInsulinEquivalent = activeMealCarbs > 0
    ? activeMealCarbs / ICR
    : 0;
  const aobInsulinEquivalent = activityOnBoard > 0
    ? activityOnBoard / effectiveCF
    : 0;

  const postActiveTotal = preActiveTotal - activeInsulin + mobInsulinEquivalent - aobInsulinEquivalent;

  // ── IOB surplus warning ────────────────────────────────────────────────────
  // When existing IOB exceeds the net meal + correction need by more than 0.5 u,
  // the patient should take 0 u and instead eat extra fast carbs to prevent a low.
  // Threshold of 0.5 u avoids false alarms from rounding noise.
  const iobSurplusWarning: InsulinCalculationBreakdown['iobSurplusWarning'] =
    postActiveTotal < -0.5
      ? {
          surplusUnits:     round2(Math.abs(postActiveTotal)),
          extraCarbsNeeded: Math.round(Math.abs(postActiveTotal) * ICR),
        }
      : undefined;

  // ── Step 5b: Cumulative & pending adjustments (display only, mirrors JS) ──
  // Use effectiveCF (sensitivity-scaled) so the breakdown panel shows values
  // consistent with the actual dose calculation when the patient has exercised.
  // Previously used base CF, which caused the breakdown to overstate these
  // figures relative to what was actually computed (bug: display-only mismatch
  // when sensitivityMultiplier > 1.005).
  const cumulativeAdjustment = cumulativeNetBaseline / effectiveCF;
  const pendingNetChange     = pendingMealRise - pendingInsulinReduction;
  const pendingAdjustment    = pendingNetChange / effectiveCF;

  // ── Step 6: Predictive peak overlap ───────────────────────────────────────
  let overlapData: OverlapData = {
    adjustmentFactor: 1.0, existingMobAtPeak: 0, existingIobAtPeak: 0, netBgImpactAtPeak: 0,
  };

  if (activeMealCarbs > 0 || activeInsulin > 0) {
    const profile = getAbsorptionProfile(absorptionType);
    overlapData = calculatePeakOverlap(profile, activeMealCarbs, activeInsulin, constants);
  }

  const predictiveAdjustedTotal = postActiveTotal * overlapData.adjustmentFactor;

  // ── Step 7: Health multiplier ─────────────────────────────────────────────
  const healthMultiplier = calculateHealthFactors(constants, currentTime);
  let totalInsulin = Math.max(0, predictiveAdjustedTotal * healthMultiplier);

  // ── Step 8: Round + safety floor ─────────────────────────────────────────
  totalInsulin = Math.round(totalInsulin * 10) / 10;
  // Guard with adjustedInsulin (base meal dose) not preActiveTotal — correction
  // insulin can make preActiveTotal negative for low BG, wrongly skipping the floor.
  // Also gate on postActiveTotal > 0: if IOB already exceeds the need, the correct
  // answer is 0 u — forcing 0.5 u would stack on top of excess insulin.
  if (adjustedInsulin > 0 && postActiveTotal > 0 && totalInsulin < 0.5) totalInsulin = 0.5;

  // ── Build breakdown ───────────────────────────────────────────────────────
  const profile = getAbsorptionProfile(absorptionType);

  const breakdown: InsulinCalculationBreakdown = {
    carbsActual:      round2(carbEquiv.carbsActual),
    proteinCarbEquiv: round2(carbEquiv.proteinCarbEquiv),
    fatCarbEquiv:     round2(carbEquiv.fatCarbEquiv),
    totalCarbEquiv:   round2(totalCarbEquiv),
    baseInsulin:      round2(baseInsulin),
    adjustedInsulin:  round2(adjustedInsulin),
    correctionInsulin:round2(correctionInsulin),
    preActiveTotal:   round2(preActiveTotal),
    activeInsulin:    round2(activeInsulin),
    activeMealCarbs:  round2(activeMealCarbs),
    mobInsulinEquivalent: round2(mobInsulinEquivalent),
    postActiveTotal:  round2(postActiveTotal),
    overlapAdjustment:round2(overlapData.adjustmentFactor),
    healthMultiplier: round2(healthMultiplier),
    activityImpact:   round2(activityImpact),
    // ── Activity PD ──────────────────────────────────────────────────────────
    activitySensitivityMultiplier: round2(sensitivityMult),
    effectiveCF:              round2(effectiveCF),
    cumulativeActivityEffect: round2(cumulativeActivityEffect),
    bgUsedForCorrection:      round2(bgForCorrection),
    activityOnBoard:          round2(activityOnBoard),
    aobInsulinEquivalent:     round2(aobInsulinEquivalent),
    // ─────────────────────────────────────────────────────────────────────────
    absorptionFactor,
    mealTimingFactor,
    projectedMobAtPeak: round2(overlapData.existingMobAtPeak),
    projectedIobAtPeak: round2(overlapData.existingIobAtPeak),
    netBgImpactAtPeak:  Math.round(overlapData.netBgImpactAtPeak),
    peakTime: profile.peak_hours,
    bloodSugarUsed:       round2(bgForCorrection),   // activity-adjusted if non-actual source
    bloodSugarSource,
    bloodSugarConfidence,
    minutesSinceReading,
    correctionNote,

    // Cumulative day effects
    cumulativeMealEffect,
    cumulativeInsulinEffect,
    cumulativeNetBaseline,
    cumulativeAdjustment: round2(cumulativeAdjustment),

    // Absorbed amounts
    absorbedCarbs,
    absorbedInsulin,

    // Pending adjustments
    pendingMealRise,
    pendingInsulinReduction,
    pendingNetChange: round2(pendingNetChange),
    pendingAdjustment: round2(pendingAdjustment),

    // Summary of total adjustments (mirrors JS breakdown.totalAdjustments)
    totalAdjustments: {
      cumulative: round2(-cumulativeAdjustment),
      active:     round2(-(activeInsulin - mobInsulinEquivalent)),
      activity:   round2(-aobInsulinEquivalent),
      pending:    round2(-pendingAdjustment),
      total:      round2(-(cumulativeAdjustment + activeInsulin - mobInsulinEquivalent + aobInsulinEquivalent + pendingAdjustment)),
    },

    iobSurplusWarning,
  };

  return { total: totalInsulin, breakdown };
}

/**
 * Convenience wrapper — accepts selected food items directly.
 * Drop-in equivalent of calculateInsulinNeeds() in EnhancedPatientConstantsCalc.js.
 */
export function calculateInsulinNeeds(
  selectedFoods: FoodItem[],
  bloodSugar: number,
  activities: ActivityEntry[],
  patientConstants: PatientConstants,
  mealType?: string,
  currentTime: Date = new Date(),
  activeInsulinValue = 0,
  activeMealCarbs    = 0,
  // Extended context (mirrors MealInput.js smart BG + cumulative effects)
  options?: {
    bloodSugarSource?:      string;
    bloodSugarConfidence?:  string;
    minutesSinceReading?:   number;
    cumulativeMealEffect?:    number;
    cumulativeInsulinEffect?: number;
    cumulativeNetBaseline?:   number;
    absorbedCarbs?:           number;
    absorbedInsulin?:         number;
    pendingMealRise?:         number;
    pendingInsulinReduction?: number;
    // ── Activity PD ────────────────────────────────────────────────────────
    /** Post-exercise sensitivity multiplier ≥ 1.0 (from ActivityPDResult). */
    activitySensitivityMultiplier?: number;
    /** Unsigned pending BG drop from exercise still to arrive (mg/dL). */
    activityOnBoard?: number;
    /** Signed cumulative BG effect from today's exercise (mg/dL). Applied to non-actual BG estimates. */
    cumulativeActivityEffect?: number;
  },
): InsulinCalculationResult | null {
  if (!selectedFoods?.length || !patientConstants) return null;

  const nutrition = calculateTotalNutrients(selectedFoods);
  return calculateInsulinDose({
    carbs:   nutrition.carbs,
    protein: nutrition.protein,
    fat:     nutrition.fat,
    absorptionType: nutrition.absorptionType,
    bloodSugar,
    activities,
    patientConstants,
    mealType,
    currentTime,
    activeInsulinValue,
    activeMealCarbs,
    ...(options ?? {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function round2(v: number): number { return Math.round(v * 100) / 100; }