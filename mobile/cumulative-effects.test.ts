// @ts-nocheck
/**
 * cumulative-effects.test.ts
 *
 * Unit + Integration Tests for the cumulative-effects bank-balance invariant.
 *
 * End-to-end invariant under test:
 *   When `calculateInsulinDose()` returns a suggested dose for a meal, and that
 *   dose is persisted and fully absorbed (Phase 3), calling
 *   `calculateTotalCumulativeEffects()` with that dose and meal produces a
 *   `cumulativeNetBaseline` that — when added to `stableBaseline` — equals the
 *   patient's `target_glucose` (within ±2 mg/dL tolerance).
 *
 * Mathematical relationship verified:
 *   estimatedBG = stableBaseline + cumulativeNetBaseline
 *   In Phase 3: stableBaseline + cumulativeNetBaseline ≈ target_glucose
 *
 * Run: jest --testPathPattern=cumulative-effects
 */

// ─── Module Mocks (must precede all imports) ──────────────────────────────────

jest.mock('@/constants/shared-constants', () => {
  // Define constants once so both SHARED_CONSTANTS and top-level exports
  // (used by insulinCalculationService) receive the same values.
  const HR_MODEL = {
    tau_HR: 3,
    tau_Z: 15,
    tau_W: 90,
    a: 0.05,
    alpha: 0.0132,
    max_sensitivity_boost: 0.60,
    dt: 1,
    acute_rate_per_min: 0.15,
    hr_base_pop: 70,
    hr_max_pop: 190,
  };
  const LEVEL_TO_INTENSITY = {
    '-2': null,
    '-1': null,
    '0': 'light',
    '1': 'moderate',
    '2': 'vigorous',
  };
  const INTENSITY_HR_FRACTION = {
    light: 0.50,
    moderate: 0.65,
    vigorous: 0.80,
  };
  const INTENSITY_PEAK_BOOST = {
    light: 0.10,
    moderate: 0.25,
    vigorous: 0.40,
  };
  const MEAL_ABSORPTION_PROFILES = {
    medium: {
      onset_hours: 0.25,
      peak_hours: 1.0,
      duration_hours: 4.0,
      shape_param: 2.0,
      scale_param: 0.5,
    },
    fast: {
      onset_hours: 0.1,
      peak_hours: 0.75,
      duration_hours: 2.5,
      shape_param: 2.0,
      scale_param: 0.375,
    },
    slow: {
      onset_hours: 0.5,
      peak_hours: 1.5,
      duration_hours: 6.0,
      shape_param: 2.0,
      scale_param: 0.75,
    },
  };
  return {
    SHARED_CONSTANTS: {
      HR_MODEL,
      LEVEL_TO_INTENSITY,
      INTENSITY_HR_FRACTION,
      INTENSITY_PEAK_BOOST,
    },
    MEAL_ABSORPTION_PROFILES,
    DEFAULT_PATIENT_CONSTANTS: {
      correction_factor: 40,
      carb_to_bg_factor: 4.0,
      target_glucose: 100,
      daily_reset_hour: 7,
      timezone_offset_minutes: 0,
      insulin_to_carb_ratio: 10,
      protein_factor: 0.5,
      fat_factor: 0.2,
    },
    getCumulativeLookbackHours: jest.fn(() => 6),
    getCircadianBaseline: jest.fn(() => 110),
    // Top-level re-exports consumed by insulinCalculationService
    HR_MODEL,
    LEVEL_TO_INTENSITY,
    INTENSITY_HR_FRACTION,
    INTENSITY_PEAK_BOOST,
    BASELINE_HARD_MIN: 55,
    BASELINE_HARD_MAX: 220,
  };
});

// convertToGrams / convertToMl are used only inside calculateNutrients() which is
// not exercised here (we pass raw macros, not FoodItem objects).
jest.mock('@/constants', () => ({
  convertToGrams: jest.fn((amount) => amount),
  convertToMl: jest.fn((amount) => amount),
}));

// blood-glucose-estimation helpers used by cumulative-effects.ts for reset math.
jest.mock('@/utils/glucose/blood-glucose-estimation', () => ({
  getDailyResetTime: jest.fn((date, resetHour, _tzOffsetMin) => {
    const d = new Date(date);
    d.setUTCHours(resetHour, 0, 0, 0);
    return d;
  }),
  getLastResetTime: jest.fn((date, resetHour, _tzOffsetMin) => {
    const d = new Date(date);
    d.setUTCHours(resetHour, 0, 0, 0);
    // If the reset time is in the future relative to `date`, use yesterday's reset.
    if (date < d) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }),
}));

// Meal absorption profile converter and fraction calculator.
// Linear ramp (simple; testable by inspection):
//   absorbedFraction = hoursSince / durationHours  for 0 < hoursSince < duration
jest.mock('@/utils/glucose/meal-pharmacodynamics', () => ({
  calculateAbsorbedFraction: jest.fn((hoursSince, profile) => {
    if (hoursSince <= 0) return 0;
    if (hoursSince >= profile.durationHours) return 1.0;
    return Math.min(1.0, hoursSince / profile.durationHours);
  }),
  toPharmacodynamicProfile: jest.fn((raw) => ({
    durationHours: raw.duration_hours ?? raw.durationHours ?? 4,
    peakHours: raw.peak_hours ?? raw.peakHours ?? 1,
    onsetHours: raw.onset_hours ?? raw.onsetHours ?? 0.25,
  })),
}));

// Insulin IOB calculator and profile resolver.
// Linear decay (IOB decreases linearly to 0 over durationHours):
//   iobFraction = 1 − hoursSince / durationHours
// absorptionFraction = 1 − iobFraction = hoursSince / durationHours  (linear ramp)
jest.mock('@/utils/insulin/pharmacodynamics', () => ({
  calculateIOB: jest.fn((hoursSince, doseUnits, profile) => {
    const durationHours = profile?.duration_hours ?? 4;
    if (hoursSince <= 0) return doseUnits;
    if (hoursSince >= durationHours) return 0;
    return doseUnits * (1 - hoursSince / durationHours);
  }),
  getInsulinProfile: jest.fn(() => ({
    duration_hours: 4,
    peak_hours: 1.5,
    onset_hours: 0.25,
  })),
}));

// Activity pharmacodynamics — zero effect for all non-exercise scenarios.
jest.mock('@/utils/activity/activity-pharmacodynamics', () => ({
  calculateStackedActivityEffect: jest.fn(() => ({
    cumulative_activity_effect: 0,
    sensitivity_multiplier: 1.0,
    activity_on_board: 0,
    activity_contributions: [],
    active_sessions: 0,
  })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  calculateMealCumulativeEffect,
  calculateInsulinCumulativeEffect,
  calculateTotalCumulativeEffects,
  calculateActivityEffectForCumulative,
  applyInsulinCumulativeFloor,
  getDailyResetTime,
  getLastResetTime,
} from '@/utils/calculations/cumulative-effects';

import { calculateInsulinDose } from '@/services/insulinCalculationService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Reference time: 2 PM UTC on 2025-06-01 (7 hours after the 7 AM daily reset).
const NOW_MS = new Date('2025-06-01T14:00:00Z').getTime();
const RESET_MS = new Date('2025-06-01T07:00:00Z').getTime();
const NOW = new Date(NOW_MS);
const RESET_HR = 7;
const TZ_OFFSET = 0;

const PATIENT_CONSTANTS = {
  correction_factor: 40,
  carb_to_bg_factor: 4.0,
  target_glucose: 100,
  daily_reset_hour: 7,
  timezone_offset_minutes: 0,
  insulin_to_carb_ratio: 10,
  protein_factor: 0.5,
  fat_factor: 0.2,
  medication_factors: {
    regular_insulin: { durationHours: 4, duration_hours: 4 },
  },
} as any;

// Medium-profile absorption map used as the `absorptionProfiles` argument.
const ABSORPTION_PROFILES = {
  medium: {
    onset_hours: 0.25,
    peak_hours: 1.0,
    duration_hours: 4.0,
    durationHours: 4.0,
  },
};

/**
 * Build a minimal Meal object whose timestamp falls inside the current reset window.
 * `carbEquiv` is set in both `calculation_summary` and `nutrition` to satisfy all
 * field-name fallback chains inside calculateMealCumulativeEffect.
 */
function buildMeal(carbEquiv: number, mealTimestamp: string): any {
  return {
    id: 'meal-1',
    timestamp: mealTimestamp,
    calculation_summary: { total_carb_equiv: carbEquiv },
    nutrition: { total_carb_equiv: carbEquiv },
  };
}

/**
 * Build a minimal InsulinDose object for the `regular_insulin` medication type.
 */
function buildDose(units: number, administrationTime: string): any {
  return {
    id: 'dose-1',
    insulinType: 'regular_insulin',
    medication: 'regular_insulin',
    units,
    dose: units,
    administrationTime,
  };
}

// ─── Integration Helper ───────────────────────────────────────────────────────

/**
 * Wires calculateInsulinDose() → buildDose() → calculateTotalCumulativeEffects()
 * in a single call and returns the key outputs needed by Suite 3 assertions.
 *
 * `stableBaseline` is set to `bloodSugar` (the patient's actual BG at the moment
 * of dosing), which is the correct mathematical identity:
 *
 *   estimatedBG = stableBaseline + cumulativeNetBaseline
 *
 * When BG equals `target_glucose` (3a, 3c, 3d) stableBaseline = 100.
 * When BG is elevated (3b, stableBaseline = 160) the correction term in the dose
 * drives cumulativeNetBaseline negative by exactly the same amount, restoring
 * estimatedBG to 100.
 */
function runIntegrationScenario(opts: {
  carbEquiv: number;
  bloodSugar: number;
  activeInsulin?: number;
  activeMealCarbs?: number;
  activitySensitivityMultiplier?: number;
  activityOnBoard?: number;
  cumulativeActivityEffect?: number;
  hoursUntilCheck?: number;
  effectiveCorrectionFactor?: number;
  overrideCarbToBGFactor?: number;
}): {
  suggestedDose: number;
  cumulativeMealEffect: number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline: number;
  estimatedBG: number;
} {
  const {
    carbEquiv,
    bloodSugar,
    activeInsulin = 0,
    activeMealCarbs = 0,
    activitySensitivityMultiplier = 1.0,
    activityOnBoard = 0,
    cumulativeActivityEffect = 0,
    hoursUntilCheck = 6,
    effectiveCorrectionFactor,
    overrideCarbToBGFactor,
  } = opts;

  // Step 1: Calculate the suggested dose (pure synchronous, no network).
  const calcResult = calculateInsulinDose({
    carbs: carbEquiv,
    protein: 0,
    fat: 0,
    bloodSugar,
    bloodSugarSource: 'actual',
    patientConstants: PATIENT_CONSTANTS,
    activeInsulinValue: activeInsulin,
    activeMealCarbs,
    activitySensitivityMultiplier,
    activityOnBoard,
    cumulativeActivityEffect,
  });

  const suggestedDose = calcResult.total;

  // Step 2: Place both the meal and dose `hoursUntilCheck` hours in the past.
  //         hoursUntilCheck ≥ 4 → Phase 3 (fully absorbed, persist-at-100%).
  //         hoursUntilCheck < 4 → Phase 1/2 (still absorbing, uses effectiveCF override).
  const mealTime = new Date(NOW_MS - hoursUntilCheck * 3_600_000).toISOString();
  const meal = buildMeal(carbEquiv, mealTime);
  const dose = buildDose(suggestedDose, mealTime);

  // Step 3: Compute cumulative effects at NOW.
  //         effectiveCorrectionFactor is the Phase 1/2 override; Phase 3 always
  //         uses the base correction_factor from PATIENT_CONSTANTS.
  const result = calculateTotalCumulativeEffects(
    [meal],
    [dose],
    NOW,
    PATIENT_CONSTANTS,
    ABSORPTION_PROFILES,
    RESET_HR,
    TZ_OFFSET,
    undefined,                // activities (no stacked ODE sessions)
    effectiveCorrectionFactor, // Phase 1/2 CF override (v4.5 behaviour)
    overrideCarbToBGFactor,   // Phase 1/2 C2B override (v4.6 behaviour)
  );

  // stableBaseline = patient's actual blood glucose at the moment of dosing.
  // This is what the reading-derived baseline calculation would produce if no
  // meal/insulin activity had yet occurred.
  const stableBaseline = bloodSugar;
  const estimatedBG = stableBaseline + result.cumulativeNetBaseline;

  return {
    suggestedDose,
    cumulativeMealEffect: result.cumulativeMealEffect,
    cumulativeInsulinEffect: result.cumulativeInsulinEffect,
    cumulativeNetBaseline: result.cumulativeNetBaseline,
    estimatedBG,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — calculateMealCumulativeEffect Phase 3 persist-at-100%
// ─────────────────────────────────────────────────────────────────────────────

describe('Suite 1 — calculateMealCumulativeEffect Phase 3 persist-at-100%', () => {
  const carbs30g = 30;
  const expectedFullEffect = carbs30g * PATIENT_CONSTANTS.carb_to_bg_factor; // 120

  it('returns a partial positive value during Phase 1/2 absorption (1h after meal)', () => {
    // 1 h after eating: absorbedFraction = 1/4 = 0.25 → effect = 30 × 0.25 × 4 = 30
    const meal = buildMeal(carbs30g, new Date(NOW_MS - 1 * 3_600_000).toISOString());
    const effect = calculateMealCumulativeEffect(
      meal, NOW, PATIENT_CONSTANTS, ABSORPTION_PROFILES, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBeGreaterThan(0);
    expect(effect).toBeLessThan(expectedFullEffect);
    expect(effect).toBeCloseTo(30, 0); // 30 × 0.25 × 4
  });

  it('persists at totalCarbs × C2B at Phase 3 boundary (exactly 4h after meal)', () => {
    // 4h = exactly the medium profile duration → Phase 3 fires.
    const meal = buildMeal(carbs30g, new Date(NOW_MS - 4 * 3_600_000).toISOString());
    const effect = calculateMealCumulativeEffect(
      meal, NOW, PATIENT_CONSTANTS, ABSORPTION_PROFILES, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBeCloseTo(expectedFullEffect, 0); // ≈ 120
  });

  it('holds at the full Phase 3 value well past absorption end (6h after meal)', () => {
    // 6h >> 4h duration: fully persisted Phase 3 value, no decay.
    const meal = buildMeal(carbs30g, new Date(NOW_MS - 6 * 3_600_000).toISOString());
    const effect = calculateMealCumulativeEffect(
      meal, NOW, PATIENT_CONSTANTS, ABSORPTION_PROFILES, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBeCloseTo(expectedFullEffect, 0); // ≈ 120
  });

  it('returns 0 for a meal eaten before the daily reset (previous accounting window)', () => {
    // ~8h before the 7AM reset = ~11PM the night before.
    // The daily reset guard must exclude meals outside today's window even if fully absorbed.
    const beforeReset = new Date(RESET_MS - 8 * 3_600_000).toISOString();
    const meal = buildMeal(carbs30g, beforeReset);
    const effect = calculateMealCumulativeEffect(
      meal, NOW, PATIENT_CONSTANTS, ABSORPTION_PROFILES, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBe(0);
  });

  it('returns 0 for a meal timestamped in the future', () => {
    // A meal 2h in the future: future guard returns 0 immediately.
    const futureMeal = buildMeal(carbs30g, new Date(NOW_MS + 2 * 3_600_000).toISOString());
    const effect = calculateMealCumulativeEffect(
      futureMeal, NOW, PATIENT_CONSTANTS, ABSORPTION_PROFILES, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — calculateInsulinCumulativeEffect Phase 3 persist-at-100%
// ─────────────────────────────────────────────────────────────────────────────

describe('Suite 2 — calculateInsulinCumulativeEffect Phase 3 persist-at-100%', () => {
  const doseUnits = 3;
  const expectedFullEffect = -(doseUnits * PATIENT_CONSTANTS.correction_factor); // −120

  it('returns a partial negative value during active absorption (2h old dose)', () => {
    // 2h into a 4h absorption: iobFraction=0.5, absorptionFraction=0.5
    // effect = −(3 × 0.5 × 40) = −60
    const dose = buildDose(doseUnits, new Date(NOW_MS - 2 * 3_600_000).toISOString());
    const effect = calculateInsulinCumulativeEffect(
      dose, NOW, PATIENT_CONSTANTS, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBeLessThan(0);
    expect(effect).toBeGreaterThan(expectedFullEffect); // magnitude < 120
    expect(effect).toBeCloseTo(-60, 0);
  });

  it('persists at −(units × baseCF) at Phase 3 boundary (exactly 4h old)', () => {
    // v4.5 FIX: Phase 3 uses baseCF=40, never the exercise override.
    const dose = buildDose(doseUnits, new Date(NOW_MS - 4 * 3_600_000).toISOString());
    const effect = calculateInsulinCumulativeEffect(
      dose, NOW, PATIENT_CONSTANTS, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBeCloseTo(expectedFullEffect, 0); // ≈ −120
  });

  it('holds at the full Phase 3 value well past absorption end (6h old dose)', () => {
    const dose = buildDose(doseUnits, new Date(NOW_MS - 6 * 3_600_000).toISOString());
    const effect = calculateInsulinCumulativeEffect(
      dose, NOW, PATIENT_CONSTANTS, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBeCloseTo(expectedFullEffect, 0); // ≈ −120
  });

  it('returns 0 for a dose administered before the daily reset', () => {
    const beforeReset = new Date(RESET_MS - 8 * 3_600_000).toISOString();
    const dose = buildDose(doseUnits, beforeReset);
    const effect = calculateInsulinCumulativeEffect(
      dose, NOW, PATIENT_CONSTANTS, RESET_HR, TZ_OFFSET,
    );
    expect(effect).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — calculateTotalCumulativeEffects bank-balance invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('Suite 3 — calculateTotalCumulativeEffects bank-balance invariant', () => {
  /**
   * 3a — Perfect meal-at-target scenario (BG = target, no correction, Phase 3)
   *
   * dose = totalCarbEquiv / ICR = (30 × 4.0) / 40 = 3.0 u
   * cumulativeMealEffect   = 30 × 4.0 = 120
   * cumulativeInsulinEffect = −(3.0 × 40) = −120
   * cumulativeNetBaseline  = 0
   * estimatedBG = 100 + 0 = 100 ✓
   */
  it('3a: estimatedBG converges to target_glucose after Phase 3 (pure meal, BG at target)', () => {
    const result = runIntegrationScenario({
      carbEquiv: 30,
      bloodSugar: PATIENT_CONSTANTS.target_glucose,
      hoursUntilCheck: 6,
    });

    expect(result.cumulativeMealEffect).toBeCloseTo(120, 0);   // 30g × 4.0
    expect(result.cumulativeInsulinEffect).toBeCloseTo(-120, 0); // dose × 40
    expect(result.cumulativeNetBaseline).toBeCloseTo(0, 1);

    expect(
      Math.abs(result.estimatedBG - PATIENT_CONSTANTS.target_glucose),
    ).toBeLessThanOrEqual(2);
  });

  /**
   * 3b — Correction dose scenario (BG elevated 60 mg/dL above target)
   *
   * dose = 50/10 + (160−100)/40 = 5.0 + 1.5 = 6.5 u
   * stableBaseline = bloodSugar = 160
   * cumulativeMealEffect   = 50 × 4.0 = 200
   * cumulativeInsulinEffect = −(6.5 × 40) = −260
   * cumulativeNetBaseline  = −60
   * estimatedBG = 160 + (−60) = 100 ✓
   */
  it('3b: estimatedBG converges to target_glucose after Phase 3 (correction dose, BG=160)', () => {
    const result = runIntegrationScenario({
      carbEquiv: 50,
      bloodSugar: 160,
      hoursUntilCheck: 6,
    });

    expect(result.cumulativeMealEffect).toBeCloseTo(200, 0);
    expect(result.cumulativeInsulinEffect).toBeCloseTo(-260, 0);
    expect(result.cumulativeNetBaseline).toBeCloseTo(-60, 1);

    // stableBaseline = 160; estimatedBG = 160 + (−60) = 100
    expect(
      Math.abs(result.estimatedBG - PATIENT_CONSTANTS.target_glucose),
    ).toBeLessThanOrEqual(2);
  });

  /**
   * 3c — Post-exercise sensitivity scenario (sensitivityMultiplier = 1.3)
   *
   * This suite verifies two distinct properties:
   *
   * Part i — Phase 2 convergence with effectiveCF override:
   *   The dose is reduced by ÷1.3 due to GLUT4 sensitivity.
   *   With effectiveCorrectionFactor=52 passed as the Phase 1/2 override,
   *   the insulin and meal absorption fractions cancel at every Phase 2 point.
   *
   * Part ii — Phase 3 always uses base CF (v4.5 fix):
   *   After full absorption (Phase 3) the insulin contribution is locked at
   *   −(dose × baseCF=40), not −(dose × effectiveCF=52).
   *   This tests the regression guard documented in the v4.5 changelog.
   */
  describe('3c — post-exercise sensitivity (sensitivityMultiplier = 1.3)', () => {
    const SENSITIVITY_MULT = 1.3;
    const EFFECTIVE_CF = PATIENT_CONSTANTS.correction_factor * SENSITIVITY_MULT; // 52

    it('Phase 2 with effectiveCF override: net BG converges to target (within ±2 mg/dL)', () => {
      // hoursUntilCheck = 3.5 < 4h duration → Phase 2 (still absorbing).
      // With effectiveCF override passed, both meal and dose scale together so
      // the cancellation identity holds: meal×C2B = dose×effectiveCF at every fraction.
      //
      // absorbedFraction = 3.5/4 = 0.875
      // dose ≈ 30/10 / 1.3 ≈ 2.3 u  (rounded to 0.1u)
      // cumulativeMealEffect   ≈ 30 × 0.875 × 4.0     = 105
      // cumulativeInsulinEffect ≈ −(2.3 × 0.875 × 52) ≈ −104.65  (rounds to −104.6)
      // net ≈ 0.4 → estimatedBG ≈ 100.4 ✓
      const result = runIntegrationScenario({
        carbEquiv: 30,
        bloodSugar: PATIENT_CONSTANTS.target_glucose,
        activitySensitivityMultiplier: SENSITIVITY_MULT,
        hoursUntilCheck: 3.5,
        effectiveCorrectionFactor: EFFECTIVE_CF,
      });

      expect(
        Math.abs(result.estimatedBG - PATIENT_CONSTANTS.target_glucose),
      ).toBeLessThanOrEqual(2);
    });

    it('Phase 3 uses base correction_factor=40, not the boosted effectiveCF (v4.5 fix)', () => {
      // hoursUntilCheck = 6 ≥ 4h → Phase 3.
      // dose = 30/10 / 1.3 ≈ 2.3 u
      // Phase 3 MUST lock in at −(dose × baseCF=40) = −92, not −(dose × 52=120).
      const result = runIntegrationScenario({
        carbEquiv: 30,
        bloodSugar: PATIENT_CONSTANTS.target_glucose,
        activitySensitivityMultiplier: SENSITIVITY_MULT,
        hoursUntilCheck: 6,
      });

      // The Phase 3 assertion: cumulativeInsulinEffect uses baseCF=40 exclusively.
      expect(result.cumulativeInsulinEffect).toBeCloseTo(
        -(result.suggestedDose * PATIENT_CONSTANTS.correction_factor),
        0,
      );

      // NOTE: In Phase 3 with a sensitivity-adjusted dose (dose < fullMealDose/CF),
      // the net does NOT cancel to 0. This is correct, expected behaviour: the v4.5
      // fix prevents retroactive sensitivity re-scaling of fully-absorbed events.
      // The bank-balance is off by (sensitivityMult − 1) × dose × baseCF until the
      // next reset — exactly the physiological reality of reduced insulin need.
      // Verify the Phase 3 component is at least more negative than the Phase 2 exit
      // would be without an override, confirming no leakage of effectiveCF.
      const basePhase3 = -(result.suggestedDose * PATIENT_CONSTANTS.correction_factor);
      const boostedPhase3 = -(result.suggestedDose * EFFECTIVE_CF);
      expect(result.cumulativeInsulinEffect).toBeCloseTo(basePhase3, 0);
      expect(result.cumulativeInsulinEffect).toBeGreaterThan(boostedPhase3); // less negative
    });
  });

  /**
   * 3d — Multiple meals and doses (additive bank-balance)
   *
   * Two fully-absorbed meals (30g + 20g = 50g total) plus one covering dose.
   * dose = 50/10 = 5.0 u  (at target, no correction)
   * cumulativeMealEffect   = (30 + 20) × 4 = 200
   * cumulativeInsulinEffect = −(5.0 × 40) = −200
   * cumulativeNetBaseline  = 0
   * estimatedBG = 100 ✓
   */
  it('3d: multiple meals produce additive bank-balance that cancels to target', () => {
    const sixHoursAgo = new Date(NOW_MS - 6 * 3_600_000).toISOString();

    const meal1 = buildMeal(30, sixHoursAgo);
    const meal2 = { ...buildMeal(20, sixHoursAgo), id: 'meal-2' };

    // One dose calculated to cover both meals (carbEquiv = 50g total).
    const calcResult = calculateInsulinDose({
      carbs: 50,
      protein: 0,
      fat: 0,
      bloodSugar: PATIENT_CONSTANTS.target_glucose,
      bloodSugarSource: 'actual',
      patientConstants: PATIENT_CONSTANTS,
    });
    const dose = buildDose(calcResult.total, sixHoursAgo);

    const result = calculateTotalCumulativeEffects(
      [meal1, meal2],
      [dose],
      NOW,
      PATIENT_CONSTANTS,
      ABSORPTION_PROFILES,
      RESET_HR,
      TZ_OFFSET,
    );

    const stableBaseline = PATIENT_CONSTANTS.target_glucose;
    const estimatedBG = stableBaseline + result.cumulativeNetBaseline;

    expect(result.cumulativeMealEffect).toBeCloseTo(200, 0);   // 50g × 4
    expect(result.cumulativeInsulinEffect).toBeCloseTo(-200, 0); // dose × 40
    expect(result.cumulativeNetBaseline).toBeCloseTo(0, 1);

    expect(
      Math.abs(estimatedBG - PATIENT_CONSTANTS.target_glucose),
    ).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — calculateActivityEffectForCumulative lock-in model
// ─────────────────────────────────────────────────────────────────────────────

describe('Suite 4 — calculateActivityEffectForCumulative lock-in model', () => {
  // Shared session: 10:00–10:30 AM UTC on the reference day.
  const SESSION_START_ISO = '2025-06-01T10:00:00Z';
  const SESSION_START_MS = new Date(SESSION_START_ISO).getTime();
  const SESSION_DURATION_MIN = 30;
  const SESSION_END_MS = SESSION_START_MS + SESSION_DURATION_MIN * 60_000;

  // Aerobic session that delivered −10 mg/dL so far with −5 mg/dL still pending.
  // fullEffect = −10 + (−1)(5) = −15 mg/dL
  const aerobicContribution = {
    start_time: SESSION_START_ISO,
    duration_minutes: SESSION_DURATION_MIN,
    cumulative_bg_effect: -10,
    remaining_bg_drop: 5,
    bg_direction: -1 as const,
  };

  const lastResetMs = getLastResetTime(NOW, RESET_HR, TZ_OFFSET).getTime(); // 7 AM today

  it('locks in at fullEffect permanently once the session has ended (post-session)', () => {
    // targetMs = 11 AM (session ended at 10:30 AM).
    const targetMs = SESSION_END_MS + 30 * 60_000; // 11 AM
    const result = calculateActivityEffectForCumulative(
      targetMs,
      [aerobicContribution],
      lastResetMs,
      NOW_MS,
    );
    // fullEffect = cumulative_bg_effect + bg_direction × remaining_bg_drop = −10 + (−1)(5) = −15
    expect(result).toBeCloseTo(-15, 1);
  });

  it('returns 0 when targetMs is before the session start', () => {
    // 9 AM < 10 AM start → the contribution is skipped.
    const targetMs = SESSION_START_MS - 60 * 60_000; // 9 AM
    const result = calculateActivityEffectForCumulative(
      targetMs,
      [aerobicContribution],
      lastResetMs,
      NOW_MS,
    );
    expect(result).toBe(0);
  });

  it('returns 0 for a session whose start_time is before the daily reset', () => {
    // Session starts at 6 AM, which is before the 7 AM daily reset.
    const preResetContribution = {
      ...aerobicContribution,
      start_time: '2025-06-01T06:00:00Z',
    };
    // Target is well after the session; if the reset guard were absent, result would be non-zero.
    const targetMs = NOW_MS;
    const result = calculateActivityEffectForCumulative(
      targetMs,
      [preResetContribution],
      lastResetMs,
      NOW_MS,
    );
    expect(result).toBe(0);
  });

  it('back-scales historical mid-session ramp (v4.8 fix: effectAtTarget = delivered × fracRatio)', () => {
    // Session: 1:30 PM → 2:30 PM (60 min), still in progress at nowMs (2:00 PM).
    // targetMs = 1:45 PM (15 min into a 60-min session)
    // fracAtTarget = 15/60 = 0.25
    // fracAtNow    = 30/60 = 0.5   (30 min elapsed at 2:00 PM)
    // effectAtTarget = cumulative_bg_effect × (0.25 / 0.5) = −10 × 0.5 = −5
    const sessionStart = new Date('2025-06-01T13:30:00Z').getTime();
    const midSessionContrib = {
      start_time: '2025-06-01T13:30:00Z',
      duration_minutes: 60,
      cumulative_bg_effect: -10,
      remaining_bg_drop: 5,
      bg_direction: -1 as const,
    };
    const targetMs = new Date('2025-06-01T13:45:00Z').getTime(); // 1:45 PM
    const result = calculateActivityEffectForCumulative(
      targetMs,
      [midSessionContrib],
      lastResetMs,
      NOW_MS, // 2:00 PM
    );
    expect(result).toBeCloseTo(-5, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5 — applyInsulinCumulativeFloor ratchet
// ─────────────────────────────────────────────────────────────────────────────

describe('Suite 5 — applyInsulinCumulativeFloor ratchet', () => {
  it('floors any point that rises above the running minimum and propagates the delta to cumulativeNetBaseline', () => {
    // Running-min trace:
    //   p[0]: floor → min(0, −50) = −50  |  delta = 0         → no clamp
    //   p[1]: floor still −50           |  delta = −50−(−45) = −5 < −0.01 → clamp
    //           cumulativeInsulinEffect = −50
    //           cumulativeNetBaseline   = 85 + (−5) = 80
    //   p[2]: floor still −50           |  delta = −50−(−40) = −10 < −0.01 → clamp
    //           cumulativeInsulinEffect = −50
    //           cumulativeNetBaseline   = 90 + (−10) = 80
    const points = [
      { cumulativeInsulinEffect: -50, cumulativeNetBaseline: 80 },
      { cumulativeInsulinEffect: -45, cumulativeNetBaseline: 85 }, // ← should be floored
      { cumulativeInsulinEffect: -40, cumulativeNetBaseline: 90 }, // ← should be floored
    ];

    applyInsulinCumulativeFloor(points);

    expect(points[0].cumulativeInsulinEffect).toBe(-50);
    expect(points[0].cumulativeNetBaseline).toBe(80);  // unchanged

    expect(points[1].cumulativeInsulinEffect).toBe(-50);
    expect(points[1].cumulativeNetBaseline).toBe(80);  // 85 + delta(−5) = 80

    expect(points[2].cumulativeInsulinEffect).toBe(-50);
    expect(points[2].cumulativeNetBaseline).toBe(80);  // 90 + delta(−10) = 80
  });

  it('resets the floor at a daily-reset boundary (|cumulativeInsulinEffect| < 0.1) so the next dose cycle starts fresh', () => {
    // Reset boundary at index 1 (value ≈ 0) clears the −50 floor.
    // New cycle:
    //   p[2]: floor = min(0, −30) = −30  |  delta = 0 → no clamp
    //   p[3]: floor still −30            |  delta = −30−(−25) = −5 → clamp
    const points = [
      { cumulativeInsulinEffect: -50, cumulativeNetBaseline: 80 },
      { cumulativeInsulinEffect: -0.05, cumulativeNetBaseline: 20 }, // reset boundary
      { cumulativeInsulinEffect: -30, cumulativeNetBaseline: 50 },   // new cycle start
      { cumulativeInsulinEffect: -25, cumulativeNetBaseline: 55 },   // should be floored at −30
    ];

    applyInsulinCumulativeFloor(points);

    // Reset point: untouched (abs < 0.1, floor cleared but no clamp applied)
    expect(points[1].cumulativeInsulinEffect).toBeCloseTo(-0.05, 2);

    // New cycle: p[2] sets the floor, p[3] is floored.
    expect(points[2].cumulativeInsulinEffect).toBe(-30); // floor anchor, no clamp
    expect(points[3].cumulativeInsulinEffect).toBe(-30); // clamped to floor

    // Delta at p[3] = −30 − (−25) = −5 → propagated to cumulativeNetBaseline
    expect(points[3].cumulativeNetBaseline).toBe(50); // 55 + (−5) = 50
  });

  it('does not clamp points that are already at or below the running minimum', () => {
    // Monotonically deepening series: every point is more negative than the last.
    // The floor ratchets down but never triggers a clamp — all values unchanged.
    const original = [
      { cumulativeInsulinEffect: -30, cumulativeNetBaseline: 60 },
      { cumulativeInsulinEffect: -60, cumulativeNetBaseline: 30 },
      { cumulativeInsulinEffect: -90, cumulativeNetBaseline: 0  },
    ];
    const points = original.map((p) => ({ ...p })); // shallow copy

    applyInsulinCumulativeFloor(points);

    expect(points[0].cumulativeInsulinEffect).toBe(-30);
    expect(points[0].cumulativeNetBaseline).toBe(60);

    expect(points[1].cumulativeInsulinEffect).toBe(-60);
    expect(points[1].cumulativeNetBaseline).toBe(30);

    expect(points[2].cumulativeInsulinEffect).toBe(-90);
    expect(points[2].cumulativeNetBaseline).toBe(0);
  });

  it('returns the same array reference (in-place mutation)', () => {
    const points = [
      { cumulativeInsulinEffect: -50, cumulativeNetBaseline: 80 },
    ];
    const returned = applyInsulinCumulativeFloor(points);
    expect(returned).toBe(points); // strict reference equality
  });
});
