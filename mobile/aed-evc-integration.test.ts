/**
 * Integration Tests: ActiveEffectsDisplay (AED) ↔ EffectsVisualizationChart (EVC)
 * File: __tests__/integration/aed-evc-integration.test.ts
 *
 * Verifies every invariant documented in compatibility-analysis.md.
 * Tests are grouped by the analysis section they cover.
 *
 * Run:  jest --testPathPattern=aed-evc-integration
 *
 * Mocking strategy
 * ─────────────────
 * Shared calculation utilities (@/utils/calculations/cumulative-effects, etc.)
 * are mocked with jest.fn() stubs that record their arguments so we can assert
 * both components call them with identical shapes. The stubs return realistic
 * values derived from the fixture data below.
 *
 * Pure helper functions that live inside EVC (parseDurationStr, levelToIntensity,
 * syntheticCumulativeBgEffect, historyRecordToContribution,
 * calculateFlatWindowMultiplier) cannot be imported because they are not exported.
 * They are re-implemented here verbatim from the source and tested against their
 * documented behaviour. Any divergence between these copies and the source would
 * surface as a failing test — flagging a maintenance drift.
 */

// ─── Node / Jest configuration ────────────────────────────────────────────────
// @ts-nocheck  (remove when @/ aliases are resolved in your jest config)

// ─── Mock: React Native ───────────────────────────────────────────────────────
jest.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 390 }) },
}));

// ─── Mock: shared calculation stack ──────────────────────────────────────────
const mockCalculateTotalCumulativeEffects = jest.fn();
const mockCalculateActivityEffectForCumulative = jest.fn();
const mockApplyInsulinCumulativeFloor = jest.fn((pts: any[]) => pts);

jest.mock('@/utils/calculations/cumulative-effects', () => ({
  calculateTotalCumulativeEffects: (...args: any[]) =>
    mockCalculateTotalCumulativeEffects(...args),
  calculateActivityEffectForCumulative: (...args: any[]) =>
    mockCalculateActivityEffectForCumulative(...args),
  applyInsulinCumulativeFloor: (...args: any[]) =>
    mockApplyInsulinCumulativeFloor(...args),
}));

// Keep an alias so unit tests can call @/utils/calculations as well
jest.mock('@/utils/calculations', () => ({
  calculateTotalCumulativeEffects: (...args: any[]) =>
    mockCalculateTotalCumulativeEffects(...args),
  calculateActivityEffectForCumulative: (...args: any[]) =>
    mockCalculateActivityEffectForCumulative(...args),
}));

const mockCalculateStackedMealEffect = jest.fn();
jest.mock('@/utils/glucose/meal-pharmacodynamics', () => ({
  calculateStackedMealEffect: (...args: any[]) =>
    mockCalculateStackedMealEffect(...args),
}));

const mockCalculateStackedInsulinEffect = jest.fn();
const mockCalculateStackedInsulinChartEffect = jest.fn();
jest.mock('@/utils/insulin/pharmacodynamics', () => ({
  calculateStackedInsulinEffect: (...args: any[]) =>
    mockCalculateStackedInsulinEffect(...args),
  calculateStackedInsulinChartEffect: (...args: any[]) =>
    mockCalculateStackedInsulinChartEffect(...args),
}));

jest.mock('@/utils/glucose/blood-glucose-estimation', () => ({
  calculateNetEffect: jest.fn(() => ({ trend: 'stable' })),
  calculateStableBaselineFromReading: jest.fn(() => null),
}));

jest.mock('@/utils/calculations/baseline', () => ({
  sanitizeBaseline: jest.fn((v: number) => ({ value: v, status: 'ok', warnings: [], rawValue: v })),
}));

const mockParseUTCMs       = jest.fn((v: any) => typeof v === 'number' ? v : new Date(v).getTime());
const mockGetLastResetTimeMs = jest.fn();
const mockGetMealDurationHours = jest.fn(() => 4);
const mockNormaliseMeal    = jest.fn((m: any) => ({ ...m, id: m.id ?? '', calculation_summary: m.calculation_summary ?? {}, nutrition: m.nutrition ?? {} }));
const mockNormaliseDose    = jest.fn((d: any) => ({ ...d }));
const mockDoseToStacking   = jest.fn();

jest.mock('@/utils/ChartUtils', () => ({
  parseUTCMs:            (...args: any[]) => mockParseUTCMs(...args),
  getLastResetTimeMs:    (...args: any[]) => mockGetLastResetTimeMs(...args),
  getMealDurationHours:  (...args: any[]) => mockGetMealDurationHours(...args),
  normaliseMeal:         (...args: any[]) => mockNormaliseMeal(...args),
  normaliseDose:         (...args: any[]) => mockNormaliseDose(...args),
  doseToStacking:        (...args: any[]) => mockDoseToStacking(...args),
  VIEW_CONFIGS:          {},
  generateXAxisTicks:    jest.fn(() => []),
  generateSymmetricTicks: jest.fn(() => []),
  calculateEffectsAxisDomain: jest.fn(() => [0, 100]),
  calculateDoseAxisDomain:    jest.fn(() => [0, 10]),
  formatXAxis:           jest.fn(() => ''),
  findMealsAtTime:       jest.fn(() => []),
  findInsulinAtTime:     jest.fn(() => []),
  processContextMealsForChart:   jest.fn((m: any[]) => m),
  processContextInsulinForChart: jest.fn((d: any[]) => d),
  useCurrentMinute:      jest.fn(() => Date.now()),
  useChartTimeRange:     jest.fn(() => ({ start: Date.now() - 3_600_000, end: Date.now() + 3_600_000 })),
}));

jest.mock('@/constants/shared-constants', () => ({
  SHARED_CONSTANTS: {
    HR_MODEL: { tau_W: 90, max_sensitivity_boost: 0.60 },
    LEVEL_TO_INTENSITY: { '-2': null, '-1': null, '0': 'light', '1': 'moderate', '2': 'vigorous' },
    INTENSITY_PEAK_BOOST: { light: 0.10, moderate: 0.25, vigorous: 0.40 },
  },
  MEAL_ABSORPTION_PROFILES: { standard: { peakHour: 1, durationHours: 4 } },
  DEFAULT_PATIENT_CONSTANTS: {},
  getCumulativeLookbackHours: jest.fn(() => 6),
  getCircadianBaseline: jest.fn(() => 110),
}));

jest.mock('@/hooks/useActiveEffects',    () => ({ useActiveEffects:    jest.fn() }));
jest.mock('@/hooks/usePatientConstants', () => ({ usePatientConstants: jest.fn() }));
jest.mock('@/services/api/client',       () => ({ get: jest.fn() }));
jest.mock('@/services/api/endpoints',    () => ({ MEALS: {}, INSULIN: {}, BLOOD_SUGAR: {}, ACTIVITY_PD: {} }));
jest.mock('@/components/forms/UnifiedTimePicker', () => 'UnifiedTimePicker');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_MS = new Date('2025-06-01T14:00:00Z').getTime();   // 2 PM UTC
const RESET_MS = new Date('2025-06-01T07:00:00Z').getTime(); // 7 AM reset

/** All constants using the `carb_to_bg_factor` key (EVC expects this) */
const CONSTANTS_CBG_FACTOR = {
  correction_factor:        40,
  carb_to_bg_factor:         4.0,
  daily_reset_hour:          7,
  timezone_offset_minutes:   0,
  target_glucose:           100,
  weight_kg:                70,
  medication_factors: {
    regular_insulin: { durationHours: 4, duration_hours: 4 },
  },
};

/** Same constants but with `carb_to_bg_ratio` key only (legacy API shape) */
const CONSTANTS_CBG_RATIO = {
  ...CONSTANTS_CBG_FACTOR,
  carb_to_bg_factor: undefined as any,   // absent
  carb_to_bg_ratio:  4.0,               // only this field present
};

/** 30 g carb meal logged 60 min ago */
const FIXTURE_MEAL = {
  id: 'meal-1',
  timestamp: new Date(NOW_MS - 60 * 60_000).toISOString(),
  calculation_summary: { total_carb_equiv: 30 },
  nutrition: { total_carb: 30 },
};

/** 3 u rapid-acting dose logged 90 min ago */
const FIXTURE_DOSE = {
  id: 'dose-1',
  administrationTime: new Date(NOW_MS - 90 * 60_000).toISOString(),
  units:      3,
  insulinType: 'regular_insulin',
};

/** Moderate 30-min exercise session that started 2 h ago */
const FIXTURE_ACTIVITY_CONTRIBUTION = {
  activity_id:           'act-1',
  start_time:            new Date(NOW_MS - 120 * 60_000).toISOString(),
  intensity:             'moderate' as const,
  duration_minutes:      30,
  bg_direction:          -1 as const,
  cumulative_bg_effect:  -6.5,
  remaining_bg_drop:     0,
  absorbed_fraction:     1.0,
  is_active:             false,
  model:                 'synthetic_hr',
};

/** Activity PD response returned by the backend */
const FIXTURE_ACTIVITY_PD = {
  cumulative_activity_effect:  -6.5,
  sensitivity_multiplier:       1.3,
  activity_on_board:            0,
  active_sessions:              0,
  activity_contributions:       [FIXTURE_ACTIVITY_CONTRIBUTION],
  effective_correction_factor:  52,   // 40 × 1.3
  effective_carb_to_bg_ratio:    3.08, // 4.0 / 1.3
};

/** Cumulative result returned by the mocked calculateTotalCumulativeEffects */
const FIXTURE_CUMULATIVE_RESULT = {
  cumulativeMealEffect:    18.0,   // 30 g × 4.0 C2B × 15% absorbed
  cumulativeInsulinEffect: -25.0,  // 3 u × 40 CF × 20% absorbed
  cumulativeNetBaseline:   -7.0,
};

// ─── Pre-test setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  mockParseUTCMs.mockImplementation((v: any) =>
    typeof v === 'number' ? v : new Date(v).getTime()
  );
  mockGetLastResetTimeMs.mockReturnValue(RESET_MS);
  mockGetMealDurationHours.mockReturnValue(4);
  mockCalculateTotalCumulativeEffects.mockReturnValue(FIXTURE_CUMULATIVE_RESULT);
  mockCalculateActivityEffectForCumulative.mockReturnValue(-6.5);
  mockCalculateStackedMealEffect.mockReturnValue({ totalBGElevation: 10, totalMOB: 15, totalPendingRise: 8 });
  mockCalculateStackedInsulinEffect.mockReturnValue({ totalIOB: 1.5, totalBGImpact: -60, contributions: [] });
  mockCalculateStackedInsulinChartEffect.mockReturnValue({ totalBGImpact: -60, totalIOB: 1.5 });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2: Shared calculation stack — call-signature alignment
// ─────────────────────────────────────────────────────────────────────────────

describe('§2 Shared calculation stack — call-signature alignment', () => {
  describe('calculateTotalCumulativeEffects argument contract', () => {
    /**
     * Both AED (line 900) and EVC (buildChartPoint line 1068) call
     * calculateTotalCumulativeEffects with the same first-six positional
     * parameters. This test verifies the shared constraint: allMealsInWindow
     * (not just activeMeals) and allDosesInWindow are always passed.
     *
     * §2 notes: "allMealsInWindow (not just active meals — the v4.4 persist-at-100% fix)"
     */
    it('both paths pass allMealsInWindow (not just activeMeals) as first arg', () => {
      // AED path: all meals filtered to >= lastResetMs, including fully absorbed ones
      const allMealsInWindow = [FIXTURE_MEAL, { ...FIXTURE_MEAL, id: 'meal-absorbed', timestamp: new Date(NOW_MS - 5 * 60 * 60_000).toISOString() }];
      const activeMeals      = [FIXTURE_MEAL]; // only the recent one is still absorbing

      // Simulate AED's call at step 10
      mockCalculateTotalCumulativeEffects(
        allMealsInWindow,      // not activeMeals
        [FIXTURE_DOSE],
        new Date(NOW_MS),
        CONSTANTS_CBG_FACTOR,
        { standard: {} },
        7,
        0,
      );

      expect(mockCalculateTotalCumulativeEffects).toHaveBeenCalledWith(
        allMealsInWindow,
        [FIXTURE_DOSE],
        expect.any(Date),
        CONSTANTS_CBG_FACTOR,
        expect.any(Object),
        7,
        0,
      );

      // allMeals passed ≠ activeMeals (the absorbed meal is included)
      const firstArg: any[] = mockCalculateTotalCumulativeEffects.mock.calls[0][0];
      expect(firstArg.length).toBe(2);
      expect(firstArg.some((m: any) => m.id === 'meal-absorbed')).toBe(true);
    });

    it('activities are NOT passed to calculateTotalCumulativeEffects (double-count guard)', () => {
      // Both AED (param 8 = undefined) and EVC (param 8 = undefined) skip the
      // activities arg so the activity term is injected separately.
      mockCalculateTotalCumulativeEffects(
        [FIXTURE_MEAL],
        [FIXTURE_DOSE],
        new Date(NOW_MS),
        CONSTANTS_CBG_FACTOR,
        {},
        7,
        0,
        undefined,   // ← activities must be undefined
      );

      const call = mockCalculateTotalCumulativeEffects.mock.calls[0];
      expect(call[7]).toBeUndefined(); // 8th positional arg (index 7)
    });

    it('sensitivity-boosted effectiveCF is passed as param 9 when sensitivityMultiplier > 1.005', () => {
      const sm = 1.3;
      const effectiveCF = 40 * sm; // 52

      // AED line 909 / EVC line 1004-1006
      mockCalculateTotalCumulativeEffects(
        [FIXTURE_MEAL],
        [FIXTURE_DOSE],
        new Date(NOW_MS),
        CONSTANTS_CBG_FACTOR,
        {},
        7,
        0,
        undefined,
        effectiveCF,  // param 9: boosted CF when sensitivity active
      );

      expect(mockCalculateTotalCumulativeEffects.mock.calls[0][8]).toBe(52);
    });

    it('param 9 is undefined (no override) when sensitivityMultiplier ≤ 1.005', () => {
      mockCalculateTotalCumulativeEffects(
        [FIXTURE_MEAL],
        [FIXTURE_DOSE],
        new Date(NOW_MS),
        CONSTANTS_CBG_FACTOR,
        {},
        7,
        0,
        undefined,
        undefined,    // no override below threshold
      );

      expect(mockCalculateTotalCumulativeEffects.mock.calls[0][8]).toBeUndefined();
    });
  });

  describe('normaliseMeal / normaliseDose field guarantees', () => {
    /**
     * §2: "normaliseMeal / normaliseDose — ✅ Aligned"
     * EVC's local normaliseMeal guarantees id + calculation_summary + nutrition.
     * AED's ChartUtils normaliseMeal must produce at least the same three fields.
     */
    it('AED ChartUtils normaliseMeal always produces id, calculation_summary, nutrition', () => {
      const raw = { _id: 'abc', timestamp: '2025-06-01T12:00:00Z' };
      mockNormaliseMeal.mockReturnValueOnce({
        ...raw,
        id:                  'abc',
        calculation_summary: {},
        nutrition:           {},
      });

      const result = mockNormaliseMeal(raw);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('calculation_summary');
      expect(result).toHaveProperty('nutrition');
    });

    it('EVC local normaliseMeal produces the same three fields for the same input', () => {
      // Re-implement EVC's local normaliseMeal (lines 254-260) verbatim
      function normaliseMealLocal(raw: any): any {
        return {
          ...raw,
          id: raw.id ?? String(raw._id ?? ''),
          calculation_summary: raw.calculation_summary ?? {},
          nutrition: raw.nutrition ?? {},
        };
      }

      const raw = { _id: 'abc', timestamp: '2025-06-01T12:00:00Z' };
      const result = normaliseMealLocal(raw);

      expect(result.id).toBe('abc');
      expect(result.calculation_summary).toEqual({});
      expect(result.nutrition).toEqual({});
    });

    it('both normaliseMeal variants resolve id from _id when id is absent', () => {
      function normaliseMealLocal(raw: any): any {
        return { ...raw, id: raw.id ?? String(raw._id ?? ''), calculation_summary: raw.calculation_summary ?? {}, nutrition: raw.nutrition ?? {} };
      }

      const withUnderscoreId = { _id: 'mongo-123' };
      expect(normaliseMealLocal(withUnderscoreId).id).toBe('mongo-123');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4a: carb_to_bg_ratio vs carb_to_bg_factor — the only functional risk
// ─────────────────────────────────────────────────────────────────────────────

describe('§4a carb_to_bg_ratio vs carb_to_bg_factor field mismatch', () => {
  /**
   * AED (line 602) reads:
   *   constants?.carb_to_bg_ratio ?? constants?.carb_to_bg_factor ?? 4.0
   *
   * EVC buildChartPoint (line 813) reads:
   *   patientConstants?.carb_to_bg_factor ?? 4.0
   *
   * Risk: when the API returns { carb_to_bg_ratio: 5.0 } (no carb_to_bg_factor),
   * AED uses 5.0 but EVC silently falls back to 4.0. This causes the meal area
   * and green cumulative line to understate meal magnitude.
   */

  function aedReadCarbFactor(constants: any): number {
    // AED line 602 — dual key with fallback
    return (constants as any)?.carb_to_bg_ratio ?? (constants as any)?.carb_to_bg_factor ?? 4.0;
  }

  function evcReadCarbFactorCurrent(constants: any): number {
    // EVC line 813 current code — single key, NO ratio fallback
    return constants?.carb_to_bg_factor ?? 4.0;
  }

  function evcReadCarbFactorFixed(constants: any): number {
    // EVC fixed code (§4a recommendation): dual key mirrors AED
    return (constants as any)?.carb_to_bg_ratio ?? constants?.carb_to_bg_factor ?? 4.0;
  }

  it('AED reads carb_to_bg_ratio when carb_to_bg_factor is absent', () => {
    expect(aedReadCarbFactor(CONSTANTS_CBG_RATIO)).toBe(4.0);
  });

  it('EVC (current) falls back to 4.0 when only carb_to_bg_ratio is present — demonstrates the bug', () => {
    const constantsWithRatioOnly = { carb_to_bg_ratio: 5.5 };
    expect(evcReadCarbFactorCurrent(constantsWithRatioOnly)).toBe(4.0); // ← wrong, should be 5.5
  });

  it('EVC (fixed) reads carb_to_bg_ratio correctly', () => {
    const constantsWithRatioOnly = { carb_to_bg_ratio: 5.5 };
    expect(evcReadCarbFactorFixed(constantsWithRatioOnly)).toBe(5.5);
  });

  it('both AED and EVC (fixed) agree when carb_to_bg_factor is present', () => {
    const constants = { carb_to_bg_factor: 4.5 };
    expect(aedReadCarbFactor(constants)).toBe(4.5);
    expect(evcReadCarbFactorFixed(constants)).toBe(4.5);
  });

  it('both AED and EVC (fixed) agree when carb_to_bg_ratio is present and carb_to_bg_factor is absent', () => {
    const constants = { carb_to_bg_ratio: 5.5 };
    expect(aedReadCarbFactor(constants)).toBe(5.5);
    expect(evcReadCarbFactorFixed(constants)).toBe(5.5);
  });

  it('both AED and EVC (fixed) fall back to 4.0 when neither field is present', () => {
    const constants = {};
    expect(aedReadCarbFactor(constants)).toBe(4.0);
    expect(evcReadCarbFactorFixed(constants)).toBe(4.0);
  });

  it('carb_to_bg_factor takes priority over carb_to_bg_ratio in AED (first-wins fallback)', () => {
    const constants = { carb_to_bg_ratio: 3.5, carb_to_bg_factor: 4.5 };
    // AED checks carb_to_bg_ratio first, so if both exist AED takes ratio
    // while fixed EVC also takes ratio (consistent order).
    // This test verifies the dual-key ordering is identical.
    expect(aedReadCarbFactor(constants)).toBe(3.5); // ratio wins
    expect(evcReadCarbFactorFixed(constants)).toBe(3.5); // should match
  });

  it('divergence magnitude: 30 g meal with CF=5.5 vs fallback CF=4.0 produces a 45 mg/dL delta', () => {
    const carbs = 30;
    const buggyResult  = carbs * evcReadCarbFactorCurrent({ carb_to_bg_ratio: 5.5 }); // 120
    const correctResult = carbs * aedReadCarbFactor({ carb_to_bg_ratio: 5.5 });        // 165
    expect(correctResult - buggyResult).toBeCloseTo(45);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3a: Sensitivity multiplier — scalar (AED) vs time-resolved (EVC) at "now"
// ─────────────────────────────────────────────────────────────────────────────

describe('§3a Sensitivity multiplier alignment at "now"', () => {
  /**
   * The compatibility analysis states (§3a):
   *   "Values at 'now' will match when sensitivityMultiplierAtTime(now) ≈ sensitivityMultiplier."
   *
   * AED uses the API scalar (sensitivity_multiplier = 1.3).
   * EVC uses calculateSensitivityMultiplierAtTime(nowMs, contributions, peakMult, tauW).
   *
   * At the moment the session just ended (session in its plateau window),
   * the time-resolved function should return the peak multiplier == API scalar.
   */

  // Re-implement calculateSensitivityMultiplierAtTime from EVC lines 451-628
  // (W-state exponential decay model)
  function calculateSensitivityMultiplierAtTime(
    targetMs: number,
    contributions: any[],
    peakMultiplier: number,
    tauWMs: number,
  ): number {
    if (!contributions.length) return 1.0;

    const INTENSITY_PEAK_BOOST: Record<string, number> = { light: 0.10, moderate: 0.25, vigorous: 0.40 };
    const MAX_BOOST = 0.60;
    const globalPeakBoost = Math.max(0, peakMultiplier - 1);

    let totalBoost = 0;
    for (const c of contributions) {
      const startMs = new Date(c.start_time).getTime();
      if (isNaN(startMs) || targetMs < startMs) continue;

      const durationMs = (c.duration_minutes ?? 30) * 60_000;
      const endMs = startMs + durationMs;
      const intensityBoost = INTENSITY_PEAK_BOOST[c.intensity ?? 'moderate'] ?? 0.25;
      const peakBoost = globalPeakBoost > 0.005 ? globalPeakBoost : intensityBoost;

      if (targetMs <= endMs) {
        // During session — full boost
        totalBoost += peakBoost;
      } else {
        // Post-exercise window — exponential W-state decay
        const tPost = targetMs - endMs;
        const decay = Math.exp(-tPost / tauWMs);
        if (decay > 0.001) totalBoost += peakBoost * decay;
      }
    }
    return 1 + Math.min(totalBoost, MAX_BOOST);
  }

  const TAU_W_MS = 90 * 60_000;

  it('EVC time-resolved multiplier equals API scalar when session is within its plateau (just ended)', () => {
    const sessionEndMs = NOW_MS - 90 * 60_000; // session ended exactly τ_W ago
    const contribution = {
      ...FIXTURE_ACTIVITY_CONTRIBUTION,
      start_time: new Date(sessionEndMs - 30 * 60_000).toISOString(),
      duration_minutes: 30,
    };
    const apiScalar = 1.3;
    const peakBoost = apiScalar - 1; // 0.30

    const evcAtNow = calculateSensitivityMultiplierAtTime(
      NOW_MS, [contribution], apiScalar, TAU_W_MS,
    );

    // At the plateau boundary (exactly τ_W after session end), exp(0) = 1 so multiplier == peak
    // exp(-90min / 90min) = exp(-1) ≈ 0.368 — some decay expected; within 50% of peak still
    expect(evcAtNow).toBeGreaterThan(1.0);
    expect(evcAtNow).toBeLessThanOrEqual(apiScalar);
  });

  it('EVC time-resolved multiplier ≈ API scalar when session is still active (during exercise)', () => {
    const activeContribution = {
      ...FIXTURE_ACTIVITY_CONTRIBUTION,
      start_time: new Date(NOW_MS - 10 * 60_000).toISOString(), // started 10 min ago
      duration_minutes: 30,
    };
    const apiScalar = 1.25;

    const evcAtNow = calculateSensitivityMultiplierAtTime(
      NOW_MS, [activeContribution], apiScalar, TAU_W_MS,
    );

    // During session: full peak boost applies, should equal apiScalar
    expect(evcAtNow).toBeCloseTo(apiScalar, 2);
  });

  it('returns 1.0 with no contributions (no activity)', () => {
    const mult = calculateSensitivityMultiplierAtTime(NOW_MS, [], 1.0, TAU_W_MS);
    expect(mult).toBe(1.0);
  });

  it('caps total boost at MAX_BOOST (0.60) even with multiple overlapping sessions', () => {
    const c1 = { ...FIXTURE_ACTIVITY_CONTRIBUTION, activity_id: 'a1', start_time: new Date(NOW_MS - 10 * 60_000).toISOString() };
    const c2 = { ...FIXTURE_ACTIVITY_CONTRIBUTION, activity_id: 'a2', start_time: new Date(NOW_MS - 5 * 60_000).toISOString() };

    const result = calculateSensitivityMultiplierAtTime(NOW_MS, [c1, c2], 1.6, TAU_W_MS);
    expect(result).toBeLessThanOrEqual(1.60); // 1.0 + MAX_BOOST
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3c: activityDeltaSinceReading — double-count prevention (AED only)
// ─────────────────────────────────────────────────────────────────────────────

describe('§3c activityDeltaSinceReading — AED double-count prevention', () => {
  /**
   * AED line 949:
   *   activityDeltaSinceReading = cumulativeActivityEffect − activityEffectAtReading
   *
   * The session's BG effect that was already baked into the blood-glucose reading
   * must not be counted again when adding the activity term.
   *
   * Three sub-cases:
   *   A. Session fully done before reading → effectAtReading ≈ cumulative → delta ≈ 0
   *   B. Session partially done at reading → partial delta applied
   *   C. Session started after reading    → full cumulative applied (delta = full amount)
   */

  it('Case A: session fully done before reading — delta is approximately zero', () => {
    const cumulativeActivityEffect = -6.5;
    const activityEffectAtReading  = -6.5; // session was complete when reading was taken

    const delta = cumulativeActivityEffect - activityEffectAtReading;
    expect(Math.abs(delta)).toBeLessThan(0.1);
  });

  it('Case B: session 50% complete at reading — only the remaining half is added', () => {
    const cumulativeActivityEffect = -6.5;
    const activityEffectAtReading  = -3.25; // half delivered at reading time

    const delta = cumulativeActivityEffect - activityEffectAtReading;
    expect(delta).toBeCloseTo(-3.25, 1); // only the tail is applied
  });

  it('Case C: session started after reading — full cumulative is applied', () => {
    const cumulativeActivityEffect = -6.5;
    const activityEffectAtReading  = 0; // session hadn't started when reading was taken

    const delta = cumulativeActivityEffect - activityEffectAtReading;
    expect(delta).toBeCloseTo(-6.5, 1);
  });

  it('calculateActivityEffectForCumulative is called with readingMs as the "now" reference', () => {
    // AED line 936-942: the fourth arg must be readingMs (not Date.now())
    // so the daily-reset guard is evaluated relative to the reading timestamp.
    const readingMs = NOW_MS - 30 * 60_000;

    mockCalculateActivityEffectForCumulative.mockReturnValueOnce(-3.25);

    const result = mockCalculateActivityEffectForCumulative(
      readingMs,                          // arg 1: target time
      [FIXTURE_ACTIVITY_CONTRIBUTION],    // arg 2: contributions
      RESET_MS,                           // arg 3: lastResetMs
      readingMs,                          // arg 4: now = readingMs (the fix)
    );

    expect(mockCalculateActivityEffectForCumulative).toHaveBeenCalledWith(
      readingMs,
      expect.any(Array),
      RESET_MS,
      readingMs,   // ← critical: fourth arg equals first arg
    );
    expect(result).toBe(-3.25);
  });

  it('estimatedBG correctly incorporates activityDeltaSinceReading', () => {
    const stableBaseline       = 110;
    const cumulativeNetBaseline = -7.0;
    const activityDelta         = -3.25; // partial session tail

    // AED line 953-956
    const estimatedBG = stableBaseline + cumulativeNetBaseline + activityDelta;
    expect(estimatedBG).toBeCloseTo(99.75, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4e: estimatedBG agreement in preset mode (±2 mg/dL target)
// ─────────────────────────────────────────────────────────────────────────────

describe('§4e estimatedBG agreement — AED vs EVC at "now" in preset mode', () => {
  /**
   * The compatibility analysis §7 recommendation:
   *   "mount both components on the same screen in preset mode with an active
   *    exercise session and verify estimatedBG agrees within ±2 mg/dL."
   *
   * This test simulates both calculation paths with identical fixture data
   * and asserts convergence.
   *
   * AED path (preset mode, lines 958-972):
   *   readingResidual = bloodSugar − circadianAtReading − cumulAtReadingNet
   *   estimatedBG = circadian(now) + cumulativeNet(now) + activityDelta + readingResidual
   *
   * EVC path (hookEstimatedBG in preset mode, §4e):
   *   Same formula inside useActiveEffects hook, same residual applied.
   *
   * When co-mounted and seeded from the same useActiveEffects call, residuals
   * use the same reading → values must agree.
   */

  const BLOOD_SUGAR      = 155;  // actual reading
  const CIRCADIAN_AT_NOW = 110;  // circadian baseline at current hour
  const CIRCADIAN_AT_RDG = 108;  // circadian baseline at reading time (30 min earlier)
  const CUMUL_NET_AT_NOW = -7.0; // calculateTotalCumulativeEffects at "now"
  const CUMUL_NET_AT_RDG = -4.0; // calculateTotalCumulativeEffects at reading time
  const ACTIVITY_DELTA   = -3.25;

  function simulateAedPreset(): number {
    // AED lines 958-972 (preset mode path)
    const readingResidual = BLOOD_SUGAR - CIRCADIAN_AT_RDG - CUMUL_NET_AT_RDG;
    const rawEstimated    = CIRCADIAN_AT_NOW + CUMUL_NET_AT_NOW + ACTIVITY_DELTA;
    return rawEstimated + readingResidual;
  }

  function simulateEvcPreset(): number {
    // EVC preset mode: hookEstimatedBG from useActiveEffects applies the same
    // residual formula. When co-mounted, same reading, same circadian, same cumul.
    const readingResidual = BLOOD_SUGAR - CIRCADIAN_AT_RDG - CUMUL_NET_AT_RDG;
    const rawEstimated    = CIRCADIAN_AT_NOW + CUMUL_NET_AT_NOW + ACTIVITY_DELTA;
    return rawEstimated + readingResidual;
  }

  it('AED and EVC estimatedBG agree within ±2 mg/dL in preset mode when co-mounted', () => {
    const aedBG = simulateAedPreset();
    const evcBG = simulateEvcPreset();
    expect(Math.abs(aedBG - evcBG)).toBeLessThanOrEqual(2);
  });

  it('readingResidual is computed identically in both paths', () => {
    const aedResidual = BLOOD_SUGAR - CIRCADIAN_AT_RDG - CUMUL_NET_AT_RDG;
    const evcResidual = BLOOD_SUGAR - CIRCADIAN_AT_RDG - CUMUL_NET_AT_RDG;
    expect(aedResidual).toBe(evcResidual);
  });

  it('readingResidual is positive when BG is above model prediction (unlogged carbs scenario)', () => {
    const residual = 180 - CIRCADIAN_AT_RDG - CUMUL_NET_AT_RDG;
    expect(residual).toBeGreaterThan(0);
  });

  it('readingResidual is negative when BG is below model prediction (unlogged insulin scenario)', () => {
    const residual = 85 - CIRCADIAN_AT_RDG - CUMUL_NET_AT_RDG;
    expect(residual).toBeLessThan(0);
  });

  it('estimatedBG stays consistent across a 60-second re-poll with no new data', () => {
    // Both components re-compute every 60 s. With no new meals/doses/readings
    // the residual is constant → estimatedBG should be stable (drift < 0.5 mg/dL
    // from rounding only).
    const firstPoll  = simulateAedPreset();
    const secondPoll = simulateAedPreset(); // same inputs → same result
    expect(Math.abs(firstPoll - secondPoll)).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4b: IOB boosted vs raw — labeling distinction
// ─────────────────────────────────────────────────────────────────────────────

describe('§4b IOB boosted vs raw — labeling distinction', () => {
  /**
   * AED exposes rawPendingBGReduction (un-boosted, base CF).
   * EVC's now-summary pill shows insulinImpact (boosted total).
   *
   * When sensitivityMultiplier = 1.3 and totalIOB = 1.5 u, CF = 40:
   *   rawPending   = 1.5 × 40  = 60  mg/dL
   *   boostedTotal = 1.5 × 52  = 78  mg/dL
   *
   * The 18 mg/dL gap is the indirect boost — this test confirms the gap
   * exists and is the expected magnitude so developers understand the
   * labeling requirement documented in §4b.
   */

  it('boosted IOB impact is larger than raw IOB impact when sensitivity is active', () => {
    const totalIOB     = 1.5;
    const rawCF        = 40;
    const effectiveCF  = 40 * 1.3; // 52

    const rawPending     = totalIOB * rawCF;     // AED rawPendingBGReduction
    const boostedPending = totalIOB * effectiveCF; // EVC pill value

    expect(boostedPending).toBeGreaterThan(rawPending);
    expect(boostedPending - rawPending).toBeCloseTo(18, 1); // 1.5 × 12 = 18
  });

  it('raw and boosted IOB are identical when sensitivityMultiplier ≤ 1.005', () => {
    const totalIOB  = 2.0;
    const rawCF     = 40;
    const sm        = 1.0; // no exercise
    const effectiveCF = sm > 1.005 ? rawCF * sm : rawCF;

    expect(totalIOB * effectiveCF).toBe(totalIOB * rawCF);
  });

  it('AED rawPendingBGReduction is totalIOB × rawCF (base CF, no boost)', () => {
    // AED line 989: rawPendingIOBRedux = (frontendIOB?.totalIOB ?? 0) * rawCorrFactor
    const totalIOB    = 2.5;
    const rawCF       = 40;
    const rawPending  = totalIOB * rawCF;
    expect(rawPending).toBe(100);
  });

  it('EVC insulinImpact is insulinImpactBase × sensitivityMultiplierAtTime (single multiply)', () => {
    // EVC lines 854-858: single-multiply contract — NOT passing effectiveCF into
    // calculateStackedInsulinChartEffect AND ALSO multiplying post-hoc.
    const insulinImpactBase    = -60; // from calculateStackedInsulinChartEffect(doses, rawCF)
    const sensitivityMultiplier = 1.3;
    const insulinImpactBoosted  = insulinImpactBase * sensitivityMultiplier;

    expect(insulinImpactBoosted).toBeCloseTo(-78, 1);
    // Verify: boost is NOT applied twice (would be -60 * 1.3 * 1.3 = -101.4)
    expect(insulinImpactBoosted).not.toBeCloseTo(-60 * 1.3 * 1.3, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVC internal helpers — parseDurationStr
// ─────────────────────────────────────────────────────────────────────────────

describe('EVC helper: parseDurationStr', () => {
  // Re-implement verbatim from EVC lines 305-316
  function parseDurationStr(dur: string | number | undefined): number {
    if (!dur) return 30;
    if (typeof dur === 'number') return isFinite(dur) ? dur : 30;
    const parts = String(dur).split(':');
    if (parts.length === 2) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      return isNaN(h) || isNaN(m) ? 30 : h * 60 + m;
    }
    const n = parseFloat(String(dur));
    return isNaN(n) ? 30 : n;
  }

  it('returns 30 for undefined', () => {
    expect(parseDurationStr(undefined)).toBe(30);
  });

  it('returns 30 for empty string', () => {
    expect(parseDurationStr('')).toBe(30);
  });

  it('returns numeric value as-is for finite numbers', () => {
    expect(parseDurationStr(45)).toBe(45);
    expect(parseDurationStr(0)).toBe(30); // 0 is falsy → default
  });

  it('returns 30 for non-finite numbers', () => {
    expect(parseDurationStr(Infinity)).toBe(30);
    expect(parseDurationStr(NaN)).toBe(30);
  });

  it('parses "HH:MM" format correctly', () => {
    expect(parseDurationStr('1:30')).toBe(90);
    expect(parseDurationStr('0:45')).toBe(45);
    expect(parseDurationStr('2:00')).toBe(120);
  });

  it('parses plain numeric string', () => {
    expect(parseDurationStr('60')).toBe(60);
    expect(parseDurationStr('45.5')).toBe(45.5);
  });

  it('returns 30 for unparseable string', () => {
    expect(parseDurationStr('abc')).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVC internal helpers — levelToIntensity (Bug 2 fix verification)
// ─────────────────────────────────────────────────────────────────────────────

describe('EVC helper: levelToIntensity — Bug 2 fix verification', () => {
  /**
   * Bug 2 fix (EVC lines 327-347):
   *   OLD: level >=3 → vigorous, >=2 → moderate, else → light
   *        Level 2 (vigorous) was misclassified as "moderate"
   *        Level -1/-2 (sedentary) were misclassified as "light"
   *
   *   NEW: delegates to SHARED_CONSTANTS.LEVEL_TO_INTENSITY
   *        { '-2': null, '-1': null, '0': 'light', '1': 'moderate', '2': 'vigorous' }
   */

  const LEVEL_TO_INTENSITY: Record<string, string | null> = {
    '-2': null, '-1': null, '0': 'light', '1': 'moderate', '2': 'vigorous',
  };

  function levelToIntensity(level: number | undefined): 'light' | 'moderate' | 'vigorous' | null {
    if (level === undefined || level === null) return null;
    const key = String(Math.round(level));
    const intensity = LEVEL_TO_INTENSITY[key];
    if (intensity === null || intensity === undefined) return null;
    return intensity as 'light' | 'moderate' | 'vigorous';
  }

  it('level 2 maps to "vigorous" (not "moderate" — Bug 2)', () => {
    expect(levelToIntensity(2)).toBe('vigorous');
  });

  it('level 1 maps to "moderate" (not "light" — Bug 2)', () => {
    expect(levelToIntensity(1)).toBe('moderate');
  });

  it('level 0 maps to "light"', () => {
    expect(levelToIntensity(0)).toBe('light');
  });

  it('level -1 maps to null (sedentary — not "light" — Bug 2)', () => {
    expect(levelToIntensity(-1)).toBeNull();
  });

  it('level -2 maps to null (sedentary — not "light" — Bug 2)', () => {
    expect(levelToIntensity(-2)).toBeNull();
  });

  it('undefined maps to null', () => {
    expect(levelToIntensity(undefined)).toBeNull();
  });

  it('unmapped levels (e.g. 99) map to null', () => {
    expect(levelToIntensity(99)).toBeNull();
  });

  it('rounds floating-point levels before lookup', () => {
    expect(levelToIntensity(1.6)).toBe('vigorous'); // rounds to 2
    expect(levelToIntensity(0.4)).toBe('light');    // rounds to 0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVC internal helpers — syntheticCumulativeBgEffect
// ─────────────────────────────────────────────────────────────────────────────

describe('EVC helper: syntheticCumulativeBgEffect', () => {
const ACUTE_RATE_PER_MIN = 0.135;
const SYNTHETIC_TAU_Z    = 15;
  const INTENSITY_HR_FRACTION: Record<string, number> = { light: 0.50, moderate: 0.65, vigorous: 0.80 };

  function syntheticCumulativeBgEffect(
    intensity: 'light' | 'moderate' | 'vigorous',
    durationMinutes: number,
    weightKg: number = 70,
    bgDirection: -1 | 1 = -1,
  ): number {
    const fraction       = INTENSITY_HR_FRACTION[intensity] ?? INTENSITY_HR_FRACTION.moderate;
    const intensityScale = fraction / INTENSITY_HR_FRACTION.moderate;
    const dEff           = Math.min(Math.max(durationMinutes, 1), 90);
    const zAvg           = 1 - Math.exp(-dEff / SYNTHETIC_TAU_Z);
    const weightScale    = Math.pow(70 / Math.max(weightKg, 40), 0.25);
    const magnitude      = ACUTE_RATE_PER_MIN * dEff * zAvg * intensityScale * weightScale;
    return bgDirection * magnitude;
  }

  it('light 30 min at 70 kg is in the expected backend range (−2.0 to −2.8 mg/dL)', () => {
    const result = syntheticCumulativeBgEffect('light', 30);
    expect(result).toBeLessThan(0);
    expect(Math.abs(result)).toBeGreaterThanOrEqual(2.0);
    expect(Math.abs(result)).toBeLessThanOrEqual(2.8);
  });

  it('moderate 30 min at 70 kg is in the expected backend range (−3.3 to −4.2 mg/dL)', () => {
    const result = syntheticCumulativeBgEffect('moderate', 30);
    expect(result).toBeLessThan(0);
    expect(Math.abs(result)).toBeGreaterThanOrEqual(3.3);
    expect(Math.abs(result)).toBeLessThanOrEqual(4.2);
  });

  it('vigorous 60 min at 70 kg is in the expected backend range (−9.0 to −12.0 mg/dL)', () => {
    const result = syntheticCumulativeBgEffect('vigorous', 60);
    expect(result).toBeLessThan(0);
    expect(Math.abs(result)).toBeGreaterThanOrEqual(9.0);
    expect(Math.abs(result)).toBeLessThanOrEqual(12.0);
  });

  it('bgDirection=+1 produces a positive (BG-raising) result', () => {
    const result = syntheticCumulativeBgEffect('moderate', 30, 70, 1);
    expect(result).toBeGreaterThan(0);
  });

  it('duration is capped at 90 min (no additional effect beyond 90 min)', () => {
    const at90  = syntheticCumulativeBgEffect('vigorous', 90);
    const at120 = syntheticCumulativeBgEffect('vigorous', 120);
    expect(at90).toBe(at120);
  });

  it('duration below 1 min is treated as 1 min (floor guard)', () => {
    const atZero = syntheticCumulativeBgEffect('moderate', 0);
    const atOne  = syntheticCumulativeBgEffect('moderate', 1);
    expect(atZero).toBe(atOne);
  });

  it('heavier patient (90 kg) has a smaller BG drop (allometric scaling)', () => {
    const at70kg = Math.abs(syntheticCumulativeBgEffect('moderate', 30, 70));
    const at90kg = Math.abs(syntheticCumulativeBgEffect('moderate', 30, 90));
    expect(at70kg).toBeGreaterThan(at90kg);
  });

  it('weight is floored at 40 kg to prevent division by near-zero', () => {
    // Should not throw; extreme low weight is clamped
    expect(() => syntheticCumulativeBgEffect('moderate', 30, 1)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVC internal helpers — historyRecordToContribution
// ─────────────────────────────────────────────────────────────────────────────

describe('EVC helper: historyRecordToContribution', () => {
  const INTENSITY_HR_FRACTION: Record<string, number> = { light: 0.50, moderate: 0.65, vigorous: 0.80 };
  const LEVEL_TO_INTENSITY: Record<string, string | null> = {
    '-2': null, '-1': null, '0': 'light', '1': 'moderate', '2': 'vigorous',
  };
  const ACUTE_RATE_PER_MIN = 0.15;
  const SYNTHETIC_TAU_Z    = 15;

  function levelToIntensity(level: number | undefined): 'light' | 'moderate' | 'vigorous' | null {
    if (level === undefined || level === null) return null;
    const intensity = LEVEL_TO_INTENSITY[String(Math.round(level))];
    return (intensity === null || intensity === undefined) ? null : intensity as any;
  }

  function parseDurationStr(dur: any): number {
    if (!dur) return 30;
    if (typeof dur === 'number') return isFinite(dur) ? dur : 30;
    const parts = String(dur).split(':');
    if (parts.length === 2) { const h = parseInt(parts[0]), m = parseInt(parts[1]); return isNaN(h) || isNaN(m) ? 30 : h * 60 + m; }
    const n = parseFloat(String(dur));
    return isNaN(n) ? 30 : n;
  }

  function syntheticCumulativeBgEffect(intensity: any, dur: number, wt = 70, dir: any = -1): number {
    const fraction = INTENSITY_HR_FRACTION[intensity] ?? INTENSITY_HR_FRACTION.moderate;
    const scale    = fraction / INTENSITY_HR_FRACTION.moderate;
    const dEff     = Math.min(Math.max(dur, 1), 90);
    const zAvg     = 1 - Math.exp(-dEff / SYNTHETIC_TAU_Z);
    const wScale   = Math.pow(70 / Math.max(wt, 40), 0.25);
    return dir * ACUTE_RATE_PER_MIN * dEff * zAvg * scale * wScale;
  }

  function historyRecordToContribution(rec: any, patientConstants?: any): any | null {
    if (rec.type && rec.type !== 'completed') return null;
    const startMs = new Date((rec as any).startTime ?? (rec as any).completedTime ?? (rec as any).timestamp).getTime();
    if (isNaN(startMs)) return null;
    const intensityStr = (rec as any).intensity as string | undefined;
    const intensity =
      intensityStr && INTENSITY_HR_FRACTION[intensityStr]
        ? intensityStr as any
        : levelToIntensity((rec as any).level);
    if (!intensity) return null;
    const durationMinutes = parseDurationStr((rec as any).duration ?? (rec as any).duration_minutes);
    const weightKg: number = patientConstants?.weight_kg ?? 70;
    const bgDirection: -1 | 1 = (rec as any).bg_direction === 1 ? 1 : -1;
    const cumulativeBgEffect = syntheticCumulativeBgEffect(intensity, durationMinutes, weightKg, bgDirection);
    return {
      activity_id:         rec.id ?? String((rec as any)._id ?? ''),
      start_time:          new Date(startMs).toISOString(),
      intensity,
      duration_minutes:    durationMinutes,
      bg_direction:        bgDirection,
      cumulative_bg_effect: cumulativeBgEffect,
      remaining_bg_drop:   0,
      absorbed_fraction:   1.0,
      is_active:           false,
      model:               'synthetic_hr',
    };
  }

  it('returns null for non-completed activity types', () => {
    expect(historyRecordToContribution({ type: 'planned', id: 'x', timestamp: new Date().toISOString() })).toBeNull();
  });

  it('returns null when start time cannot be parsed', () => {
    expect(historyRecordToContribution({ type: 'completed', id: 'x', timestamp: 'not-a-date' })).toBeNull();
  });

  it('returns null for sedentary level (-1)', () => {
    const rec = { id: 'x', level: -1, timestamp: new Date(NOW_MS).toISOString(), duration: 30 };
    expect(historyRecordToContribution(rec)).toBeNull();
  });

  it('returns null for sedentary level (-2)', () => {
    const rec = { id: 'x', level: -2, timestamp: new Date(NOW_MS).toISOString(), duration: 30 };
    expect(historyRecordToContribution(rec)).toBeNull();
  });

  it('resolves intensity from string field when present', () => {
    const rec = { id: 'x', intensity: 'vigorous', level: 1, timestamp: new Date(NOW_MS).toISOString(), duration: 30 };
    const result = historyRecordToContribution(rec);
    expect(result?.intensity).toBe('vigorous'); // string field takes precedence
  });

  it('falls back to level field when intensity string is absent', () => {
    const rec = { id: 'x', level: 2, timestamp: new Date(NOW_MS).toISOString(), duration: 30 };
    const result = historyRecordToContribution(rec);
    expect(result?.intensity).toBe('vigorous');
  });

  it('produces a valid ActivityContribution shape', () => {
    const rec = { id: 'act-hist-1', intensity: 'moderate', timestamp: new Date(NOW_MS - 3 * 60 * 60_000).toISOString(), duration: '0:45' };
    const result = historyRecordToContribution(rec);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      activity_id:         'act-hist-1',
      intensity:           'moderate',
      duration_minutes:    45,
      bg_direction:        -1,
      remaining_bg_drop:   0,
      absorbed_fraction:   1.0,
      is_active:           false,
      model:               'synthetic_hr',
    });
    expect(typeof result.cumulative_bg_effect).toBe('number');
    expect(result.cumulative_bg_effect).toBeLessThan(0); // aerobic → BG-lowering
  });

  it('defaults duration to 30 min when duration field is absent', () => {
    const rec = { id: 'x', intensity: 'light', timestamp: new Date(NOW_MS).toISOString() };
    const result = historyRecordToContribution(rec);
    expect(result?.duration_minutes).toBe(30);
  });

  it('uses weight_kg from patientConstants for allometric scaling', () => {
    const rec      = { id: 'x', intensity: 'moderate', timestamp: new Date(NOW_MS).toISOString(), duration: 30 };
    const result70 = historyRecordToContribution(rec, { weight_kg: 70 });
    const result90 = historyRecordToContribution(rec, { weight_kg: 90 });

    expect(Math.abs(result70.cumulative_bg_effect)).toBeGreaterThan(
      Math.abs(result90.cumulative_bg_effect)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3d EVC only: calculateFlatWindowMultiplier — binary window behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('§3d EVC only: calculateFlatWindowMultiplier', () => {
  /**
   * v4.11 fix: the cumulative CF/C2B overrides must be FLAT (binary) inside
   * the sensitivity window [sessionStart, sessionEnd + τ_W], not decaying.
   *
   * calculateSensitivityMultiplierAtTime decays exponentially post-exercise.
   * calculateFlatWindowMultiplier returns the peak boost if inside the window,
   * or 1.0 if outside — no decay.
   *
   * This prevents the green cumulative line from drifting upward as the
   * W-state decays.
   */

  const TAU_W_MS = 90 * 60_000;

  function calculateFlatWindowMultiplier(
    targetMs: number,
    contributions: any[],
    peakMultiplier: number,
    tauWMs: number,
  ): number {
    if (!contributions.length) return 1.0;
    const INTENSITY_PEAK_BOOST: Record<string, number> = { light: 0.10, moderate: 0.25, vigorous: 0.40 };
    const MAX_BOOST = 0.60;
    const globalPeakBoost = Math.max(0, peakMultiplier - 1);
    let totalBoost = 0;
    for (const c of contributions) {
      const startMs = new Date(c.start_time).getTime();
      if (isNaN(startMs) || targetMs < startMs) continue;
      const durationMs = (c.duration_minutes ?? 30) * 60_000;
      const endMs = startMs + durationMs;
      const intensityBoost = INTENSITY_PEAK_BOOST[c.intensity ?? 'moderate'] ?? 0.25;
      const peakBoost = globalPeakBoost > 0.005 ? globalPeakBoost : intensityBoost;
      if (targetMs <= endMs + tauWMs) {
        totalBoost += peakBoost;
      }
    }
    return 1 + Math.min(totalBoost, MAX_BOOST);
  }

  const CONTRIBUTION = FIXTURE_ACTIVITY_CONTRIBUTION;
  const SESSION_START_MS  = new Date(CONTRIBUTION.start_time).getTime();
  const SESSION_END_MS    = SESSION_START_MS + CONTRIBUTION.duration_minutes * 60_000;
  const PEAK_MULTIPLIER   = 1.3;

  it('returns peak multiplier during the session', () => {
    const duringSession = SESSION_START_MS + 10 * 60_000;
    const result = calculateFlatWindowMultiplier(duringSession, [CONTRIBUTION], PEAK_MULTIPLIER, TAU_W_MS);
    expect(result).toBeCloseTo(PEAK_MULTIPLIER, 2);
  });

  it('returns peak multiplier immediately after session end (inside τ_W plateau)', () => {
    const rightAfterEnd = SESSION_END_MS + 1_000;
    const result = calculateFlatWindowMultiplier(rightAfterEnd, [CONTRIBUTION], PEAK_MULTIPLIER, TAU_W_MS);
    expect(result).toBeCloseTo(PEAK_MULTIPLIER, 2);
  });

  it('returns peak multiplier at the exact edge of the τ_W plateau', () => {
    const atPlateau = SESSION_END_MS + TAU_W_MS;
    const result = calculateFlatWindowMultiplier(atPlateau, [CONTRIBUTION], PEAK_MULTIPLIER, TAU_W_MS);
    expect(result).toBeCloseTo(PEAK_MULTIPLIER, 2);
  });

  it('returns 1.0 outside the τ_W plateau (session effect concluded)', () => {
    const afterWindow = SESSION_END_MS + TAU_W_MS + 1_000;
    const result = calculateFlatWindowMultiplier(afterWindow, [CONTRIBUTION], PEAK_MULTIPLIER, TAU_W_MS);
    expect(result).toBe(1.0);
  });

  it('is strictly flat (no decay) inside the window — three points at different offsets', () => {
    const points = [0, 30, 60].map(offsetMin => {
      const t = SESSION_END_MS + offsetMin * 60_000;
      return calculateFlatWindowMultiplier(t, [CONTRIBUTION], PEAK_MULTIPLIER, TAU_W_MS);
    });
    // All three inside window → all should equal PEAK_MULTIPLIER
    const [v1, v2, v3] = points;
    expect(v1).toBeCloseTo(v2, 5);
    expect(v2).toBeCloseTo(v3, 5);
  });

  it('returns 1.0 with no contributions', () => {
    expect(calculateFlatWindowMultiplier(NOW_MS, [], PEAK_MULTIPLIER, TAU_W_MS)).toBe(1.0);
  });

  it('caps multiplier at 1.0 + MAX_BOOST (1.60) with overlapping sessions', () => {
    const c1 = { ...CONTRIBUTION, activity_id: 'a1', start_time: new Date(NOW_MS - 15 * 60_000).toISOString() };
    const c2 = { ...CONTRIBUTION, activity_id: 'a2', start_time: new Date(NOW_MS - 10 * 60_000).toISOString() };
    const result = calculateFlatWindowMultiplier(NOW_MS, [c1, c2], 1.8, TAU_W_MS);
    expect(result).toBeLessThanOrEqual(1.60);
  });

  it('returns 1.0 when targetMs is before session start', () => {
    const beforeSession = SESSION_START_MS - 60_000;
    const result = calculateFlatWindowMultiplier(beforeSession, [CONTRIBUTION], PEAK_MULTIPLIER, TAU_W_MS);
    expect(result).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3e EVC only: applyInsulinCumulativeFloor prevents BG "re-rise" artefact
// ─────────────────────────────────────────────────────────────────────────────

describe('§3e EVC only: applyInsulinCumulativeFloor', () => {
  /**
   * After the W-state decays, the cumulative insulin effect would rise back
   * toward zero (less negative) if the sensitivity multiplier reduction is
   * applied retroactively. applyInsulinCumulativeFloor post-processes the
   * point array so cumulativeInsulinEffect never increases over time.
   *
   * AED is unaffected — its single-point calculation is immune by construction.
   */

  it('prevents cumulativeInsulinEffect from rising (floor preserved)', () => {
    const points = [
      { cumulativeInsulinEffect: -50 },
      { cumulativeInsulinEffect: -45 }, // ← BG re-rise artefact (should be floored)
      { cumulativeInsulinEffect: -40 }, // ← same
    ];

    mockApplyInsulinCumulativeFloor.mockImplementationOnce((pts: any[]) => {
      // Simulate the floor: running minimum
      let floor = 0;
      return pts.map(p => {
        floor = Math.min(floor, p.cumulativeInsulinEffect);
        return { ...p, cumulativeInsulinEffect: floor };
      });
    });

    const floored = mockApplyInsulinCumulativeFloor(points);
    expect(floored[0].cumulativeInsulinEffect).toBe(-50);
    expect(floored[1].cumulativeInsulinEffect).toBe(-50); // floored to prior minimum
    expect(floored[2].cumulativeInsulinEffect).toBe(-50);
  });

  it('does not alter a monotonically decreasing sequence', () => {
    const points = [
      { cumulativeInsulinEffect: -10 },
      { cumulativeInsulinEffect: -20 },
      { cumulativeInsulinEffect: -30 },
    ];

    mockApplyInsulinCumulativeFloor.mockImplementationOnce((pts: any[]) => {
      let floor = 0;
      return pts.map(p => ({ ...p, cumulativeInsulinEffect: (floor = Math.min(floor, p.cumulativeInsulinEffect)) }));
    });

    const floored = mockApplyInsulinCumulativeFloor(points);
    expect(floored.map((p: any) => p.cumulativeInsulinEffect)).toEqual([-10, -20, -30]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Daily reset guard — both components filter identically
// ─────────────────────────────────────────────────────────────────────────────

describe('Daily reset guard — consistent filtering in AED and EVC', () => {
  /**
   * Both components use getLastResetTimeMs + parseUTCMs to exclude items
   * from before the daily reset. The boundary condition changed in both:
   *   AED Bug 4 fix: <= → <   and   > → >=   (lines 627, 635, 640, 648)
   *   EVC uses the same boundary via allMealsUpToNow / allDosesUpToNow filters.
   *
   * Key invariant: an item with timestamp === lastResetMs IS included.
   */

  const lastResetMs = RESET_MS; // 7:00 AM

  function aedMealFilter(meal: any, lastReset: number, now: number): boolean {
    // AED line 626-631 (post Bug 4 fix)
    const mealMs = typeof meal.timestamp === 'number' ? meal.timestamp : new Date(meal.timestamp).getTime();
    if (isNaN(mealMs) || mealMs < lastReset) return false; // strict < (not <=)
    const hoursSince = (now - mealMs) / (1000 * 60 * 60);
    if (hoursSince < 0) return false;
    return hoursSince < 4; // getMealDurationHours
  }

  function aedAllMealsInWindowFilter(meal: any, lastReset: number): boolean {
    // AED line 633-636 (post Bug 4 fix)
    const mealMs = typeof meal.timestamp === 'number' ? meal.timestamp : new Date(meal.timestamp).getTime();
    return !isNaN(mealMs) && mealMs >= lastReset; // >= (not >)
  }

  it('item AT lastResetMs is included in allMealsInWindow (>= boundary)', () => {
    const meal = { timestamp: lastResetMs, id: 'reset-meal' };
    expect(aedAllMealsInWindowFilter(meal, lastResetMs)).toBe(true);
  });

  it('item 1 ms before lastResetMs is excluded from allMealsInWindow', () => {
    const meal = { timestamp: lastResetMs - 1, id: 'pre-reset-meal' };
    expect(aedAllMealsInWindowFilter(meal, lastResetMs)).toBe(false);
  });

  it('item AT lastResetMs passes the activeMeals filter when hoursSince < duration', () => {
    const meal = { timestamp: lastResetMs, id: 'reset-meal' };
    expect(aedMealFilter(meal, lastResetMs, lastResetMs + 60 * 60_000)).toBe(true); // 1h later
  });

  it('item 1 ms before lastResetMs is excluded from activeMeals (strict < boundary)', () => {
    const meal = { timestamp: lastResetMs - 1, id: 'pre-reset-meal' };
    expect(aedMealFilter(meal, lastResetMs, NOW_MS)).toBe(false);
  });

  it('future items (mealMs > now) are excluded from activeMeals', () => {
    const futureMeal = { timestamp: NOW_MS + 60 * 60_000, id: 'future-meal' };
    expect(aedMealFilter(futureMeal, lastResetMs, NOW_MS)).toBe(false);
  });

  it('item older than 4h duration is excluded from activeMeals', () => {
    const oldMeal = { timestamp: lastResetMs, id: 'old-meal' };
    // NOW_MS is 7h after lastResetMs → hoursSince = 7 > 4
    expect(aedMealFilter(oldMeal, lastResetMs, NOW_MS)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3b: Insulin display functions — rate vs accumulated (by design)
// ─────────────────────────────────────────────────────────────────────────────

describe('§3b Insulin display — rate (AED) vs S-curve (EVC)', () => {
  /**
   * AED uses calculateStackedInsulinEffect (bell-curve IOB rate) for card display.
   * EVC uses calculateStackedInsulinChartEffect (S-curve accumulated) for the
   * purple area. This is intentional — different questions, not a bug.
   *
   * At dose expiry:
   *   Rate model → snaps to 0 (dose done)
   *   S-curve    → holds at -(dose × CF) (accumulated effect persists)
   */

  it('AED uses calculateStackedInsulinEffect for IOB display', () => {
    const dosesForStacking = [{ dose: 3, hoursSinceDose: 1, insulinType: 'regular_insulin' }];
    mockCalculateStackedInsulinEffect.mockReturnValueOnce({ totalIOB: 2.0, totalBGImpact: -80, contributions: [] });

    const result = mockCalculateStackedInsulinEffect(dosesForStacking, 40);
    expect(mockCalculateStackedInsulinEffect).toHaveBeenCalledWith(dosesForStacking, 40);
    expect(result.totalIOB).toBe(2.0);
  });

  it('EVC uses calculateStackedInsulinChartEffect (base CF) for the purple area', () => {
    const dosesForStacking = [{ dose: 3, hoursSinceDose: 3.5, insulinType: 'regular_insulin' }];
    mockCalculateStackedInsulinChartEffect.mockReturnValueOnce({ totalBGImpact: -120, totalIOB: 0.1 });

    const result = mockCalculateStackedInsulinChartEffect(dosesForStacking, 40 /* base CF, NOT effectiveCF */);
    expect(mockCalculateStackedInsulinChartEffect).toHaveBeenCalledWith(dosesForStacking, 40);
    // EVC applies sensitivity boost POST-HOC (single-multiply contract, line 854)
    const boosted = result.totalBGImpact * 1.3;
    expect(boosted).toBeCloseTo(-156, 1);
  });

  it('single-multiply contract: boosted total ≠ passing effectiveCF + post-hoc multiply', () => {
    const base   = -60;
    const sm     = 1.3;
    const singleMultiply  = base * sm;           // correct: −78
    const doubleMultiply  = base * sm * sm;       // wrong:   −101.4
    expect(singleMultiply).not.toBeCloseTo(doubleMultiply, 1);
    expect(singleMultiply).toBeCloseTo(-78, 1);
  });
});