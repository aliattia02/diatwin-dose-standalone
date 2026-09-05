/**
 * Meal pharmacodynamics — the gamma absorption model.
 *
 * 747 lines with no coverage, feeding the same MOB display that the tested
 * cumulative-effects stack feeds. This module is a direct port of
 * `backend/utils/pharmacodynamics.py::calculate_gamma_absorption` and
 * `calculate_absorbed_fraction`, so exact cross-language values belong to the
 * parity harness (`diatwin/verify/parity.py`, families `meal_activity` and
 * `meal_absorbed`), not here. What belongs here are the properties the model
 * must have for the displays to mean anything:
 *
 *   - Conservation: absorbed + remaining == the meal's carb equivalents, at
 *     every point in the window, for every profile.
 *   - The curve is bounded, starts at zero, and reaches full absorption by
 *     duration_hours.
 *   - Carb extraction is *total* over the shapes the backend sends, and — more
 *     important — leaves legitimate data alone: a pre-computed
 *     `total_carb_equiv` is never recomputed, and a fibre-heavy item never eats
 *     another item's carbohydrate.
 *   - The daily-reset guard excludes the previous window and nothing else.
 *
 * Three behaviours here are surprising enough to be pinned explicitly rather
 * than left to be rediscovered: the 100 % plateau, the truncation at
 * duration_hours, and the non-monotone step in `calculateAbsorbedFraction`.
 * Each is measured, and each is shared with the Python implementation — they
 * are properties of the model, not of this port.
 */

import {
  calculateAbsorbedFraction,
  calculateGammaAbsorption,
  calculateMealActivity,
  calculateStackedMealEffect,
  generateMealAbsorptionCurve,
  getAbsorptionType,
  getMealAbsorptionProfile,
  getTotalCarbsFromMeal,
  isMealActive,
  parseMealTimestamp,
  toPharmacodynamicProfile,
} from '../utils/glucose/meal-pharmacodynamics';
import { getDailyResetTime as timeManagerReset } from '../utils/time/TimeManager';
import {
  DEFAULT_PATIENT_CONSTANTS,
  MEAL_ABSORPTION_PROFILES,
} from '../constants/shared-constants';

/** 2026-03-01T12:00:00Z — a fixed instant, so nothing depends on the clock. */
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const HOUR = 3_600_000;

const PROFILE_KEYS = Object.keys(MEAL_ABSORPTION_PROFILES);

const PC: any = {
  ...DEFAULT_PATIENT_CONSTANTS,
  carb_to_bg_factor: 4,
  protein_factor: 0.5,
  fat_factor: 0.2,
  daily_reset_hour: 7,
  timezone_offset_minutes: 0,
};

/** A meal with its carb equivalents already resolved, so tests isolate the curve. */
function mealOf(absorptionType: string, carbs: number, atMs: number = T0): any {
  return {
    id: `meal-${absorptionType}`,
    timestamp: atMs,
    mealType: 'lunch',
    nutrition: { absorptionType, totalCarbEquiv: carbs },
  };
}

function profileOf(key: string) {
  return toPharmacodynamicProfile((MEAL_ABSORPTION_PROFILES as any)[key]);
}

describe('toPharmacodynamicProfile', () => {
  it('converts every shipped snake_case profile without losing a field', () => {
    for (const key of PROFILE_KEYS) {
      const raw: any = (MEAL_ABSORPTION_PROFILES as any)[key];
      const p = toPharmacodynamicProfile(raw);
      expect([key, p.onsetHours, p.peakHours, p.durationHours, p.shapeParam, p.scaleParam])
        .toEqual([key, raw.onset_hours, raw.peak_hours, raw.duration_hours, raw.shape_param, raw.scale_param]);
    }
  });

  it('passes a camelCase profile through unchanged rather than re-deriving it', () => {
    // The guard keys on `onsetHours` being a number. A profile that already
    // arrived in camelCase must come back identical — not merged with defaults.
    const already = {
      onsetHours: 0.1, peakHours: 0.2, durationHours: 0.3,
      curveType: 'gamma_steep', shapeParam: 9, scaleParam: 8,
    };
    expect(toPharmacodynamicProfile(already as any)).toBe(already);
  });

  it('returns a usable profile for input that is not an object at all', () => {
    // Bug-3 defence: `absorptionProfiles[type]` returning undefined must not
    // produce a profile of NaNs that silently zeroes every downstream number.
    for (const bad of [undefined, null, 'medium', 42]) {
      const p = toPharmacodynamicProfile(bad as any);
      expect([bad, Number.isFinite(p.durationHours)]).toEqual([bad, true]);
      expect([bad, p.durationHours > 0]).toEqual([bad, true]);
    }
  });
});

describe('calculateGammaAbsorption — curve shape', () => {
  it('is bounded to [0, 100] across the whole window, for every profile', () => {
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      for (let i = 0; i <= 400; i++) {
        const h = (i / 400) * p.durationHours;
        const a = calculateGammaAbsorption(h, p);
        expect([key, h, a >= 0 && a <= 100]).toEqual([key, h, true]);
      }
    }
  });

  it('is zero before the meal and zero past duration_hours', () => {
    const p = profileOf('medium');
    expect(calculateGammaAbsorption(-0.001, p)).toBe(0);
    expect(calculateGammaAbsorption(-5, p)).toBe(0);
    expect(calculateGammaAbsorption(p.durationHours + 1e-9, p)).toBe(0);
  });

  it('ramps linearly to 5 % over the onset window and joins continuously', () => {
    const p = profileOf('medium');
    expect(calculateGammaAbsorption(p.onsetHours / 2, p)).toBeCloseTo(2.5, 10);
    // The pre-onset ramp ends at 5 and the main branch opens at 5 — the two
    // pieces must meet, or the curve has a step at onset.
    expect(calculateGammaAbsorption(p.onsetHours - 1e-9, p)).toBeCloseTo(5, 6);
    expect(calculateGammaAbsorption(p.onsetHours, p)).toBeCloseTo(5, 6);
  });

  it('reaches exactly 100 % at peak_hours, for every profile', () => {
    // The curve is normalised by its own value at peak_hours, so this is an
    // identity of the formula rather than a fitted number.
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      expect([key, calculateGammaAbsorption(p.peakHours, p)]).toEqual([key, 100]);
    }
  });

  it('never rises again after peak_hours', () => {
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      let prev = 100;
      for (let h = p.peakHours; h < p.durationHours; h += 0.01) {
        const a = calculateGammaAbsorption(h, p);
        expect([key, h, a <= prev + 1e-9]).toEqual([key, h, true]);
        prev = a;
      }
    }
  });

  it('PINS: the maximum is a plateau ending at peak_hours, not a point at it', () => {
    // Measured, not assumed. The gamma density t^(k-1)·e^(-t/theta) has its mode
    // at (k-1)·theta, which for every shipped profile lies *before* the
    // configured peak_hours. Normalising by the value at peak_hours therefore
    // pushes an interval of the curve above 100, and the min(100, …) clamp
    // flattens it. The plateau ends exactly at peak_hours because that is the
    // normalisation point.
    //
    // Shared with backend/utils/pharmacodynamics.py — same formula, same clamp.
    // Not a port defect. Pinned so that "peak_hours is where the curve peaks"
    // is never assumed by a caller.
    const plateauStart: Record<string, number> = {};
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      let first = Infinity;
      for (let i = 0; i <= 4000; i++) {
        const h = (i / 4000) * p.durationHours;
        if (calculateGammaAbsorption(h, p) >= 100) { first = h; break; }
      }
      plateauStart[key] = first;
      expect([key, first < p.peakHours]).toEqual([key, true]);
    }
    // The plateau is a substantial share of the window, not a rounding artefact:
    // for `medium` it opens at ~0.83 h and runs to peak_hours = 1.5 h.
    expect(plateauStart.medium).toBeGreaterThan(0.8);
    expect(plateauStart.medium).toBeLessThan(0.9);
  });

  it('PINS: activity is truncated at duration_hours, not tapered to zero', () => {
    // very_slow still carries more than half its peak activity when the window
    // closes, and drops to 0 in one step. Absorbed *fraction* is renormalised
    // so no carbohydrate is lost, but the instantaneous rate — which feeds the
    // trend arrow through calculateNetEffect — has a cliff there. Shared with
    // the Python model.
    const p = profileOf('very_slow');
    expect(calculateGammaAbsorption(p.durationHours - 1e-6, p)).toBeGreaterThan(50);
    expect(calculateGammaAbsorption(p.durationHours + 1e-6, p)).toBe(0);
  });
});

describe('calculateAbsorbedFraction', () => {
  it('is 0 at or before the meal and exactly 1 at duration_hours', () => {
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      expect([key, calculateAbsorbedFraction(0, p)]).toEqual([key, 0]);
      expect([key, calculateAbsorbedFraction(-1, p)]).toEqual([key, 0]);
      expect([key, calculateAbsorbedFraction(p.durationHours, p)]).toEqual([key, 1]);
      expect([key, calculateAbsorbedFraction(p.durationHours * 10, p)]).toEqual([key, 1]);
    }
  });

  it('stays within [0, 1] everywhere inside the window', () => {
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      for (let i = 0; i <= 200; i++) {
        const h = (i / 200) * p.durationHours;
        const f = calculateAbsorbedFraction(h, p);
        expect([key, h, f >= 0 && f <= 1]).toEqual([key, h, true]);
      }
    }
  });

  it('a faster profile has absorbed more than a slower one at the same hour', () => {
    // The ordering of the shipped profiles is the whole point of having five of
    // them; if it inverted, "fast" and "slow" would be labels on nothing.
    const order = ['very_fast', 'fast', 'medium', 'slow', 'very_slow'];
    for (const h of [0.5, 1.0, 1.5, 2.0]) {
      const fractions = order.map(k => calculateAbsorbedFraction(h, profileOf(k)));
      for (let i = 1; i < fractions.length; i++) {
        expect([h, order[i], fractions[i - 1] >= fractions[i]]).toEqual([h, order[i], true]);
      }
    }
  });

  it('PINS: the discrete integral takes a small backward step near the tail', () => {
    // Measured: worst backward step is 1.4e-3 (very_fast, h≈1.60), 1.1e-3
    // (fast) and 6.7e-4 (medium); slow, very_slow and mixed are monotone.
    //
    // Cause: the integral from 0 to h uses dt = h/steps, so the quadrature grid
    // changes with h. A left-Riemann sum over a shifting grid is not monotone in
    // h even though the integrand is non-negative. Identical code — and
    // therefore identical artefact — in backend/utils/pharmacodynamics.py.
    //
    // This sits well below display precision (carbs render to 0.1 g, so 1.4e-3
    // of a 100 g meal is 0.14 g). Asserted as a bound rather than fixed: raising
    // `steps` would move every absorbed-carb number in the app for no clinical
    // gain, and would have to move on both sides of the parity harness at once.
    const worst: Record<string, number> = {};
    for (const key of PROFILE_KEYS) {
      const p = profileOf(key);
      let prev = -1;
      let backstep = 0;
      for (let i = 0; i <= 1000; i++) {
        const h = (i / 1000) * p.durationHours;
        const f = calculateAbsorbedFraction(h, p);
        if (prev >= 0 && f < prev) backstep = Math.max(backstep, prev - f);
        prev = f;
      }
      worst[key] = backstep;
      expect([key, backstep < 2e-3]).toEqual([key, true]);
    }
    // Naming which profiles are affected, so a change to either set is visible.
    expect(worst.slow).toBe(0);
    expect(worst.very_slow).toBe(0);
    expect(worst.mixed).toBe(0);
    expect(worst.very_fast).toBeGreaterThan(0);
  });
});

describe('getTotalCarbsFromMeal — extraction is total, and non-destructive', () => {
  it('prefers a pre-computed total over anything it could recompute', () => {
    const meal: any = {
      calculation_summary: { total_carb_equiv: 99 },
      nutrition: { totalCarbEquiv: 11, totalCarbs: 5 },
      foodItems: [{ details: { carbs: 1 } }],
    };
    expect(getTotalCarbsFromMeal(meal)).toBe(99);
  });

  it('walks the whole fallback chain, one rung at a time', () => {
    expect(getTotalCarbsFromMeal({ nutrition: { totalCarbEquiv: 11 } } as any)).toBe(11);
    expect(getTotalCarbsFromMeal({ nutrition: { totalCarbs: 30, totalProtein: 10, totalFat: 5 } } as any, 0.5, 0.2))
      .toBeCloseTo(36, 10);
    expect(getTotalCarbsFromMeal({ nutrition: { carbs: 30, protein: 10, fat: 5 } } as any, 0.5, 0.2))
      .toBeCloseTo(36, 10);
    expect(getTotalCarbsFromMeal({ foodItems: [{ details: { carbs: 30, protein: 10, fat: 5, fiber: 8 } }] } as any, 0.5, 0.2))
      .toBeCloseTo(28, 10);
  });

  it('reads nutrients from a flat food item as well as from details', () => {
    const nested: any = { foodItems: [{ details: { carbs: 30, protein: 10, fat: 5, fiber: 8 } }] };
    const flat: any = { foodItems: [{ carbs: 30, protein: 10, fat: 5, fiber: 8 }] };
    expect(getTotalCarbsFromMeal(flat, 0.5, 0.2)).toBe(getTotalCarbsFromMeal(nested, 0.5, 0.2));
  });

  it('returns 0 for a meal with nothing in it, rather than NaN', () => {
    for (const empty of [{}, { nutrition: {} }, { foodItems: [] }, { nutrition: {}, foodItems: [] }]) {
      expect([empty, getTotalCarbsFromMeal(empty as any)]).toEqual([empty, 0]);
    }
  });

  it('does not let one fibre-heavy item cancel another item’s carbohydrate', () => {
    // FIBER_FACTOR is 1.0 — net carbs = carbs − fibre. The per-item clamp at 0
    // is what stops a salad from erasing the rice next to it on the plate.
    const meal: any = {
      foodItems: [
        { details: { carbs: 2, protein: 0, fat: 0, fiber: 20 } },  // net −18, clamped to 0
        { details: { carbs: 50, protein: 0, fat: 0, fiber: 0 } },
      ],
    };
    expect(getTotalCarbsFromMeal(meal, 0.5, 0.2)).toBe(50);
    // and a single such item floors at zero rather than going negative
    expect(getTotalCarbsFromMeal({ foodItems: [meal.foodItems[0]] } as any, 0.5, 0.2)).toBe(0);
  });

  it('PINS: a non-positive pre-computed total is treated as absent', () => {
    // The guards are `> 0`, not `!= null`. A backend that wrote
    // total_carb_equiv: 0 for a genuinely zero-carb meal gets it recomputed from
    // nutrition instead of honoured. Harmless while the recompute agrees; it
    // would not be if the two ever disagreed.
    expect(getTotalCarbsFromMeal({
      calculation_summary: { total_carb_equiv: 0 },
      nutrition: { totalCarbs: 20 },
    } as any)).toBe(20);
    expect(getTotalCarbsFromMeal({
      calculation_summary: { total_carb_equiv: -5 },
      nutrition: { totalCarbs: 20 },
    } as any)).toBe(20);
  });
});

describe('getMealAbsorptionProfile — type resolution', () => {
  it('prefers calculation_summary, then nutrition, then foodItems[0].details', () => {
    expect(getMealAbsorptionProfile({
      calculation_summary: { absorption_type: 'fast' },
      nutrition: { absorptionType: 'slow' },
      foodItems: [{ details: { absorption_type: 'very_slow' } }],
    } as any, PC).absorptionType).toBe('fast');

    expect(getMealAbsorptionProfile({
      nutrition: { absorptionType: 'slow' },
      foodItems: [{ details: { absorption_type: 'very_slow' } }],
    } as any, PC).absorptionType).toBe('slow');

    expect(getMealAbsorptionProfile({
      nutrition: {},
      foodItems: [{ details: { absorption_type: 'very_slow' } }],
    } as any, PC).absorptionType).toBe('very_slow');
  });

  it('falls back to medium for a type that is not a real profile key', () => {
    for (const bogus of ['not_a_type', '', null, undefined, 7]) {
      const p = getMealAbsorptionProfile({ calculation_summary: { absorption_type: bogus } } as any, PC);
      expect([bogus, p.absorptionType]).toEqual([bogus, 'medium']);
      expect([bogus, p.durationHours]).toEqual([bogus, MEAL_ABSORPTION_PROFILES.medium.duration_hours]);
    }
  });

  it('carries the patient absorption modifier without applying it to the curve', () => {
    // patientModifier is reported for the caller to use on the insulin dose. It
    // must not silently deform the absorption timings as well.
    const p = getMealAbsorptionProfile(mealOf('fast', 50), PC);
    expect(p.patientModifier).toBe(DEFAULT_PATIENT_CONSTANTS.absorption_modifiers.fast);
    expect(p.durationHours).toBe(MEAL_ABSORPTION_PROFILES.fast.duration_hours);
    expect(p.peakHours).toBe(MEAL_ABSORPTION_PROFILES.fast.peak_hours);
  });

  it('uses the shared default modifiers when the patient has none', () => {
    const p = getMealAbsorptionProfile(mealOf('very_fast', 50), {} as any);
    expect(p.patientModifier).toBe(DEFAULT_PATIENT_CONSTANTS.absorption_modifiers.very_fast);
  });
});

describe('calculateMealActivity — conservation and the three time regimes', () => {
  it('conserves carbohydrate at every point of every window', () => {
    // absorbed + remaining == total. If this ever fails, MOB and the
    // "pending rise" figure are describing different meals.
    for (const key of PROFILE_KEYS) {
      const meal = mealOf(key, 73);
      const p = profileOf(key);
      for (let i = 0; i <= 60; i++) {
        const h = (i / 60) * p.durationHours;
        const r = calculateMealActivity(meal, new Date(T0 + h * HOUR), PC);
        expect([key, h, r.absorbedCarbs + r.remainingCarbs]).toEqual([key, h, 73]);
        expect([key, h, r.mob]).toEqual([key, h, r.remainingCarbs]);
      }
    }
  });

  it('keeps the two BG figures consistent with the carb split', () => {
    const r = calculateMealActivity(mealOf('medium', 60), new Date(T0 + 1.5 * HOUR), PC);
    expect(r.currentBgElevation).toBeCloseTo(r.absorbedCarbs * 4, 10);
    expect(r.pendingBgRise).toBeCloseTo(r.remainingCarbs * 4, 10);
    expect(r.currentBgElevation + r.pendingBgRise).toBeCloseTo(60 * 4, 10);
  });

  it('treats a future meal as entirely pending, not entirely absorbed', () => {
    const r = calculateMealActivity(mealOf('medium', 60), new Date(T0 - HOUR), PC);
    expect(r.isActive).toBe(false);
    expect(r.hoursSinceMeal).toBeCloseTo(-1, 10);
    expect(r.absorbedCarbs).toBe(0);
    expect(r.mob).toBe(60);
    expect(r.pendingBgRise).toBe(240);
    expect(r.currentBgElevation).toBe(0);
  });

  it('PINS: an expired meal reports its full elevation with zero MOB', () => {
    // Phase-3 "persist at 100 %": once absorbed, the meal keeps contributing its
    // whole carb load to currentBgElevation. That value belongs to the
    // cumulative bank balance, not the live rate — calculateStackedMealEffect
    // deliberately excludes it from totalBGElevation for exactly that reason.
    const r = calculateMealActivity(mealOf('medium', 60), new Date(T0 + 5 * HOUR), PC);
    expect(r.isActive).toBe(false);
    expect(r.mob).toBe(0);
    expect(r.remainingCarbs).toBe(0);
    expect(r.absorbedCarbs).toBe(60);
    expect(r.currentBgElevation).toBe(240);
    expect(r.pendingBgRise).toBe(0);
    expect(r.bgImpact).toBe(0);
  });

  it('returns a zeroed but active result for a meal with no carbohydrate', () => {
    const r = calculateMealActivity(mealOf('medium', 0), new Date(T0 + HOUR), PC);
    expect(r.isActive).toBe(true);
    expect([r.mob, r.bgImpact, r.absorbedCarbs, r.currentBgElevation, r.pendingBgRise])
      .toEqual([0, 0, 0, 0, 0]);
  });

  it('scales linearly in the carb load', () => {
    const at = new Date(T0 + 1.2 * HOUR);
    const small = calculateMealActivity(mealOf('medium', 25), at, PC);
    const large = calculateMealActivity(mealOf('medium', 100), at, PC);
    expect(large.absorbedCarbs).toBeCloseTo(small.absorbedCarbs * 4, 10);
    expect(large.bgImpact).toBeCloseTo(small.bgImpact * 4, 10);
    expect(large.cumulativeEffect).toBeCloseTo(small.cumulativeEffect, 12);
  });

  it('defaults carb_to_bg_factor to 4.0 when the patient has none', () => {
    const r = calculateMealActivity(mealOf('medium', 10), new Date(T0 + HOUR), {} as any);
    expect(r.currentBgElevation).toBeCloseTo(r.absorbedCarbs * 4, 10);
  });
});

describe('isMealActive', () => {
  it('is true exactly on [meal, meal + duration] and false outside', () => {
    const meal = mealOf('medium', 40);
    const dur = MEAL_ABSORPTION_PROFILES.medium.duration_hours;
    expect(isMealActive(meal, new Date(T0 - 1), PC)).toBe(false);
    expect(isMealActive(meal, new Date(T0), PC)).toBe(true);
    expect(isMealActive(meal, new Date(T0 + dur * HOUR), PC)).toBe(true);
    expect(isMealActive(meal, new Date(T0 + dur * HOUR + 1), PC)).toBe(false);
  });

  it('uses the meal’s own profile duration, not a fixed window', () => {
    const at = new Date(T0 + 5 * HOUR);
    expect(isMealActive(mealOf('medium', 40), at, PC)).toBe(false);    // 4 h
    expect(isMealActive(mealOf('very_slow', 40), at, PC)).toBe(true);  // 7 h
  });
});

describe('getAbsorptionType', () => {
  it('reports medium for a meal that declares nothing', () => {
    expect(getAbsorptionType({} as any)).toBe('medium');
    expect(getAbsorptionType({ nutrition: {} } as any)).toBe('medium');
  });

  it('PINS: it does not validate, unlike getMealAbsorptionProfile', () => {
    // getMealAbsorptionProfile falls back to 'medium' for a bogus key; this
    // helper hands the bogus string straight back. A caller that feeds the
    // result into MEAL_ABSORPTION_PROFILES gets undefined. The two are
    // inconsistent — see the matching split in blood-glucose-estimation.ts.
    expect(getAbsorptionType({ calculation_summary: { absorption_type: 'nonsense' } } as any))
      .toBe('nonsense');
    expect(getMealAbsorptionProfile({ calculation_summary: { absorption_type: 'nonsense' } } as any, PC)
      .absorptionType).toBe('medium');
  });
});

describe('generateMealAbsorptionCurve', () => {
  it('spans the full window and ends fully absorbed', () => {
    const points = generateMealAbsorptionCurve(mealOf('medium', 50), PC, 5);
    expect(points[0]).toEqual({ time: 0, activity: 0, absorbed: 0 });
    const last = points[points.length - 1];
    expect(last.time).toBeCloseTo(MEAL_ABSORPTION_PROFILES.medium.duration_hours, 10);
    expect(last.absorbed).toBe(1);
  });

  it('absorbed is non-decreasing on the display grid, to within the quadrature artefact', () => {
    // Measured: the 5-minute display grid *does* reach the artefact pinned in
    // calculateAbsorbedFraction — very_fast steps back 1.3e-3 at t = 1.667 h.
    // Every other profile is strictly monotone on this grid. Asserting a bound
    // rather than monotonicity is the honest statement: the rendered curve can
    // dip, by an amount three orders of magnitude below one pixel.
    const worst: Record<string, number> = {};
    for (const key of PROFILE_KEYS) {
      const points = generateMealAbsorptionCurve(mealOf(key, 50), PC, 5);
      let backstep = 0;
      for (let i = 1; i < points.length; i++) {
        if (points[i].absorbed < points[i - 1].absorbed) {
          backstep = Math.max(backstep, points[i - 1].absorbed - points[i].absorbed);
        }
      }
      worst[key] = backstep;
      expect([key, backstep < 2e-3]).toEqual([key, true]);
    }
    expect(worst.very_fast).toBeGreaterThan(0);
    for (const key of ['fast', 'medium', 'slow', 'very_slow', 'mixed']) {
      expect([key, worst[key]]).toEqual([key, 0]);
    }
  });

  it('a finer interval gives more points over the same window', () => {
    const coarse = generateMealAbsorptionCurve(mealOf('medium', 50), PC, 30);
    const fine = generateMealAbsorptionCurve(mealOf('medium', 50), PC, 5);
    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(fine[fine.length - 1].time).toBeCloseTo(coarse[coarse.length - 1].time, 10);
  });
});

describe('calculateStackedMealEffect', () => {
  const at = new Date(T0 + 2 * HOUR);

  it('sums MOB and absorbed carbs across concurrent meals', () => {
    const meals = [mealOf('medium', 30, T0), mealOf('fast', 20, T0 + HOUR)];
    const r = calculateStackedMealEffect(meals, at, PC);
    const each = meals.map(m => calculateMealActivity(m, at, PC));
    expect(r.totalMOB).toBeCloseTo(each[0].mob + each[1].mob, 10);
    expect(r.totalAbsorbedCarbs).toBeCloseTo(each[0].absorbedCarbs + each[1].absorbedCarbs, 10);
    expect(r.contributions).toHaveLength(2);
  });

  it('excludes an expired meal from totalBGElevation', () => {
    // The stated fix: a fully-absorbed meal's Phase-3 persist value is a bank
    // balance, not a live effect. It must not inflate the active metric.
    const expired = mealOf('medium', 60, T0 - 5 * HOUR);   // 7 h old at `at`
    const r = calculateStackedMealEffect([expired], at, {
      ...PC, daily_reset_hour: 0, timezone_offset_minutes: 0,
    });
    expect(r.contributions).toHaveLength(1);
    expect(r.totalBGElevation).toBe(0);
    expect(r.totalMOB).toBe(0);
    expect(r.totalPendingRise).toBe(0);
  });

  it('returns zeros for no meals, without dividing by anything', () => {
    expect(calculateStackedMealEffect([], at, PC)).toEqual({
      totalMOB: 0, totalActiveEffect: 0, totalAbsorbedCarbs: 0,
      totalPendingRise: 0, totalBGElevation: 0, contributions: [],
    });
  });

  it('reads epoch-ms and zone-qualified ISO as the same instant', () => {
    const reference = calculateStackedMealEffect([mealOf('medium', 60, T0)], at, PC);
    expect(reference.totalMOB).toBeGreaterThan(0);
    for (const ts of [T0, new Date(T0).toISOString()]) {
      const meal: any = { ...mealOf('medium', 60), timestamp: ts };
      expect([typeof ts, calculateStackedMealEffect([meal], at, PC).totalMOB])
        .toEqual([typeof ts, reference.totalMOB]);
    }
  });

  it('D10 FIXED: every timestamp shape reaches the same instant in every function', () => {
    // Was PINS D10. calculateStackedMealEffect normalised the meal timestamp
    // before its reset guard while calculateMealActivity (line 403) and
    // isMealActive (line 660) did a plain `new Date(meal.timestamp)` on the
    // same field. Two live shapes broke:
    //
    //  (a) numeric string, e.g. "1772366400000" -> Invalid Date -> NaN hours.
    //      Because `NaN < 0` is false the meal fell into the *expired* branch
    //      and was reported fully absorbed with zero MOB.
    //  (b) bare ISO with no zone, which the backend frequently sends -> read
    //      as device-local, shifting every absorption figure by the device's
    //      UTC offset.
    //
    // Fixed by promoting the module's own parser to `parseMealTimestamp` and
    // using it at all three sites.
    const isoZ = new Date(T0).toISOString();
    const shapes: Array<[string, any]> = [
      ['number', T0],
      ['Date', new Date(T0)],
      ['numeric string', String(T0)],
      ['ISO with Z', isoZ],
      ['bare ISO (UTC implied)', isoZ.replace('Z', '')],
      ['space-separated', isoZ.replace('T', ' ').replace('Z', '')],
    ];

    const reference = calculateMealActivity(mealOf('medium', 60, T0), at, PC);
    expect(reference.hoursSinceMeal).toBe(2);
    expect(reference.isActive).toBe(true);
    expect(reference.mob).toBeGreaterThan(0);

    for (const [label, ts] of shapes) {
      const meal: any = { ...mealOf('medium', 60), timestamp: ts };
      const activity = calculateMealActivity(meal, at, PC);
      expect([label, activity.hoursSinceMeal]).toEqual([label, reference.hoursSinceMeal]);
      expect([label, activity.mob]).toEqual([label, reference.mob]);
      expect([label, activity.isActive]).toEqual([label, true]);
      expect([label, isMealActive(meal, at, PC)]).toEqual([label, true]);
      // and the stacked view agrees with the per-meal view for each shape
      expect([label, calculateStackedMealEffect([meal], at, PC).totalMOB])
        .toEqual([label, reference.mob]);
    }
  });

  it('D10 FIXED: a bare ISO timestamp is read as UTC, not as device-local', () => {
    // Written against the running machine's offset so it holds in any
    // timezone, including a UTC CI runner where the shift would be zero.
    const bare = new Date(T0).toISOString().replace('Z', '');
    const offsetHours = new Date(bare).getTimezoneOffset() / 60;
    const activity = calculateMealActivity(
      { ...mealOf('medium', 60), timestamp: bare } as any, at, PC);
    expect(activity.hoursSinceMeal).toBe(2);
    if (offsetHours !== 0) {
      // The old behaviour would have landed here instead.
      expect(activity.hoursSinceMeal).not.toBe(2 - offsetHours);
    }
  });

  it('parseMealTimestamp returns NaN for input it cannot place, never a guess', () => {
    for (const bad of [null, undefined, '', 'not a date', {}]) {
      expect([bad, Number.isNaN(parseMealTimestamp(bad))]).toEqual([bad, true]);
    }
    expect(parseMealTimestamp(0)).toBe(0);
    expect(parseMealTimestamp(T0)).toBe(T0);
    expect(parseMealTimestamp(new Date(T0))).toBe(T0);
  });

  it('drops a meal whose timestamp cannot be parsed rather than throwing', () => {
    const meals: any[] = [
      { ...mealOf('medium', 60), id: 'broken', timestamp: 'not a date' },
      mealOf('medium', 30, T0),
    ];
    const r = calculateStackedMealEffect(meals, at, PC);
    expect(r.contributions).toHaveLength(1);
    expect(r.contributions[0].mealId).toBe('meal-medium');
  });

  it('excludes meals from before the daily reset and keeps meals after it', () => {
    const now = new Date(Date.UTC(2026, 2, 1, 12, 0, 0));
    const reset = timeManagerReset(now.getTime(), 7, 0);   // 2026-03-01T07:00Z
    expect(calculateStackedMealEffect([mealOf('medium', 60, reset - 60_000)], now, PC)
      .contributions).toHaveLength(0);
    expect(calculateStackedMealEffect([mealOf('medium', 60, reset + 60_000)], now, PC)
      .contributions).toHaveLength(1);
  });

  it('PINS D9: the reset guard is 24 h stale for offsets east of +07:00', () => {
    // MEASURED, not assumed. calculateStackedMealEffect's inline getLastResetMs
    // — like getDailyResetTime in blood-glucose-estimation.ts, and unlike
    // TimeManager, the Python backend and activity-pharmacodynamics.ts —
    // anchors the reset day on the *UTC* calendar date rather than the
    // patient's local one, and only ever rolls that candidate back, never
    // forward. Whenever the patient's local date runs ahead of the UTC date,
    // the boundary it returns is exactly one day early.
    //
    // Condition: timezone_offset_minutes > daily_reset_hour × 60. The affected
    // slice of each day is (offset_hours − reset_hour) hours long: +08:00 → 1 h,
    // +09:00 → 2 h, +12:00 → 5 h, +13:00 → 6 h. Offsets at or west of +07:00 are
    // never affected, which is why this has not surfaced in use.
    //
    // Effect here: a meal from the previous window is admitted and its carbs are
    // counted toward today's totals.
    //
    // When this test starts failing, the defect has been fixed — change the
    // `toHaveLength(1)` below to `toHaveLength(0)` and delete this note.
    const now = new Date(Date.UTC(2026, 2, 1, 20, 0, 0));

    const tzEast = 780;   // UTC+13
    const eastReset = timeManagerReset(now.getTime(), 7, tzEast);
    const east = calculateStackedMealEffect(
      [mealOf('medium', 60, eastReset - 60_000)], now,
      { ...PC, daily_reset_hour: 7, timezone_offset_minutes: tzEast },
    );
    expect(east.contributions).toHaveLength(1);   // ← should be 0

    // The same meal, same clock, at an offset west of the reset hour: excluded.
    const tzWest = -300;  // UTC−5
    const westReset = timeManagerReset(now.getTime(), 7, tzWest);
    const west = calculateStackedMealEffect(
      [mealOf('medium', 60, westReset - 60_000)], now,
      { ...PC, daily_reset_hour: 7, timezone_offset_minutes: tzWest },
    );
    expect(west.contributions).toHaveLength(0);
  });
});
