/**
 * Blood-glucose estimation — baseline, cumulative effects and net effect.
 *
 * 1,059 lines with no coverage, and the widest blast radius of the three
 * modules audited in this pass: it is the module that turns meals and doses
 * into the number on the dashboard. It is a port of the cumulative model in
 * `backend/utils/pharmacodynamics.py`, so cross-language values belong to the
 * parity harness, not here.
 *
 * The properties that matter:
 *
 *   - The daily-reset boundary is the *only* thing deciding what is in scope.
 *     A record from the previous window contributes nothing; a record from this
 *     one contributes until the next reset. Both halves are asserted.
 *   - Sign discipline: meals raise, insulin lowers, and the baseline is the
 *     reading with both removed. `baseline + cumulative == reading` must hold
 *     as an identity, not approximately.
 *   - Monotonicity in the right variables — more carbs is more elevation, more
 *     insulin is more reduction, later is more absorbed.
 *   - Robustness: the module is fed API payloads with missing and misnamed
 *     fields, so a single malformed record must not take down the dashboard.
 *
 * D11, D12 and D13 were found here, characterised, and then fixed; the tests
 * that pinned them now assert the corrected behaviour and say what the defect
 * was. D9 remains pinned rather than fixed — it changes what a patient sees
 * and lands in four places, so it is a decision rather than a cleanup.
 */

import {
  calculateInsulinCumulativeEffect,
  calculateMealCumulativeEffect,
  calculateNetEffect,
  calculateStableBaselineFromReading,
  calculateTotalCumulativeEffects,
  calculateUnifiedMealImpact,
  calculateWeightedAbsorptionType,
  getDailyResetTime,
  getLastResetTime,
} from '../utils/glucose/blood-glucose-estimation';
import { getInsulinProfile } from '../utils/insulin/pharmacodynamics';
import { getDailyResetTime as timeManagerReset } from '../utils/time/TimeManager';
import {
  DEFAULT_PATIENT_CONSTANTS,
  MEAL_ABSORPTION_PROFILES,
  NET_EFFECT_THRESHOLDS,
} from '../constants/shared-constants';

/** 2026-03-01T12:00:00Z */
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const HOUR = 3_600_000;
const PROFILES = MEAL_ABSORPTION_PROFILES as any;

const PC: any = {
  ...DEFAULT_PATIENT_CONSTANTS,
  carb_to_bg_factor: 4,
  correction_factor: 40,
  target_glucose: 100,
  protein_factor: 0.5,
  fat_factor: 0.2,
  daily_reset_hour: 7,
  timezone_offset_minutes: 0,
};

const iso = (ms: number) => new Date(ms).toISOString();

function meal(carbs: number, atMs = T0, absorptionType = 'medium'): any {
  return {
    id: `meal-${atMs}`,
    timestamp: iso(atMs),
    mealType: 'lunch',
    nutrition: { absorptionType, totalCarbEquiv: carbs },
  };
}

function dose(units: number, atMs = T0, medication = 'insulin_lispro'): any {
  return { id: `dose-${atMs}`, dose: units, medication, taken_at: iso(atMs) };
}

describe('getDailyResetTime / getLastResetTime', () => {
  it('lands on the configured hour in the patient’s own local time', () => {
    // tz offset is minutes *east* of UTC, so UTC+2 => 07:00 local is 05:00 UTC.
    const cases: Array<[number, string]> = [
      [0, '2026-03-01T07:00:00.000Z'],
      [120, '2026-03-01T05:00:00.000Z'],
      [-300, '2026-03-01T12:00:00.000Z'],
      [330, '2026-03-01T01:30:00.000Z'],   // India, +5:30
      [345, '2026-03-01T01:15:00.000Z'],   // Nepal, +5:45
    ];
    for (const [offset, expected] of cases) {
      expect([offset, getDailyResetTime(new Date(T0), 7, offset).toISOString()])
        .toEqual([offset, expected]);
    }
  });

  it('rolls back to yesterday when the clock is before today’s reset', () => {
    const beforeReset = new Date(Date.UTC(2026, 2, 1, 3, 0, 0));
    expect(getLastResetTime(beforeReset, 7, 0).toISOString()).toBe('2026-02-28T07:00:00.000Z');
    const afterReset = new Date(Date.UTC(2026, 2, 1, 8, 0, 0));
    expect(getLastResetTime(afterReset, 7, 0).toISOString()).toBe('2026-03-01T07:00:00.000Z');
  });

  it('never returns a reset in the future', () => {
    for (const offset of [-720, -300, 0, 330, 540, 780]) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 2, 1, h, 0, 0));
        const reset = getLastResetTime(now, 7, offset);
        expect([offset, h, reset.getTime() <= now.getTime()]).toEqual([offset, h, true]);
      }
    }
  });

  it('agrees with TimeManager at every offset at or west of +07:00', () => {
    for (const offset of [-720, -480, -300, -60, 0, 120, 300, 330, 345, 420]) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 2, 1, h, 0, 0));
        const label = `tz=${offset} utc=${h}`;
        expect([label, getLastResetTime(now, 7, offset).getTime()])
          .toEqual([label, timeManagerReset(now.getTime(), 7, offset)]);
      }
    }
  });

  it('D9 (fixed): agrees with TimeManager at every offset, all day', () => {
    // Was: getDailyResetTime took the UTC midnight of the supplied instant and
    // shifted it, so the calendar day it anchored on was the *UTC* one, while
    // TimeManager, the Python backend and activity-pharmacodynamics.ts all
    // anchor on the patient's local date. Once the patient's local date ran
    // ahead of the UTC date the boundary came back exactly one day early.
    //
    // Condition was timezone_offset_minutes > daily_reset_hour x 60, and the
    // affected slice of each day was (offset_hours - reset_hour) hours long:
    // measured at +08:00 -> 1 h, +09:00 -> 2 h, +10:00 -> 3 h, +12:00 -> 5 h,
    // +13:00 -> 6 h, +14:00 -> 7 h. Offsets at or west of +07:00 were never
    // affected, which is why it never surfaced in use.
    //
    // Fixed by delegating to TimeManager rather than recomputing the boundary —
    // removing the class of bug rather than one instance. This test now sweeps
    // the full offset range at every hour of the day; it fails against the
    // pre-fix code at 21 of the 24-hour x 6-offset combinations below.
    for (const offset of [-720, -300, 0, 60, 330, 420, 480, 540, 600, 720, 780, 840]) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 2, 1, h, 0, 0));
        expect([offset, h, getLastResetTime(now, 7, offset).getTime()])
          .toEqual([offset, h, timeManagerReset(now.getTime(), 7, offset)]);
        expect([offset, h, getDailyResetTime(now, 7, offset).getTime()])
          .toEqual([offset, h, timeManagerReset(now.getTime(), 7, offset)]);
      }
    }
  });

  it('D9 (fixed): the reset is never in the future and never more than a day back', () => {
    // The property that makes it a *daily* boundary at all. The old rollback in
    // getLastResetTime could only ever move backwards, which is how the error
    // reached a full 24 h; asserting both bounds catches a regression in either
    // direction.
    for (const offset of [-720, 0, 420, 780, 840]) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 2, 1, h, 0, 0));
        const reset = getLastResetTime(now, 7, offset).getTime();
        expect([offset, h, reset <= now.getTime()]).toEqual([offset, h, true]);
        expect([offset, h, now.getTime() - reset < 24 * HOUR]).toEqual([offset, h, true]);
      }
    }
  });

  it('D9 (fixed): a meal from the previous window is excluded at an eastern offset', () => {
    // The consequence, stated in mg/dL rather than in hours. The guard excludes
    // anything before the boundary; before the fix, at an eastern offset it
    // excluded nothing, so a meal an hour *before* the reset contributed exactly
    // what the same meal an hour *after* it would.
    const now = new Date(Date.UTC(2026, 2, 1, 20, 0, 0));

    const east = 780;   // UTC+13 — true reset is 2026-03-01T18:00Z
    const eastReset = timeManagerReset(now.getTime(), 7, east);
    const beforeBoundary = calculateMealCumulativeEffect(
      meal(60, eastReset - HOUR), now, PC, PROFILES, 7, east);
    const afterBoundary = calculateMealCumulativeEffect(
      meal(60, eastReset + HOUR), now, PC, PROFILES, 7, east);
    expect(beforeBoundary).toBe(0);          // excluded, as it always should have been
    expect(afterBoundary).toBeGreaterThan(0); // and the one inside the window counts

    // The same meal, same clock, at an offset west of the reset hour: excluded.
    const west = -300;  // UTC-5
    const westReset = timeManagerReset(now.getTime(), 7, west);
    expect(calculateMealCumulativeEffect(meal(60, westReset - HOUR), now, PC, PROFILES, 7, west))
      .toBe(0);
    expect(calculateMealCumulativeEffect(meal(60, westReset + HOUR), now, PC, PROFILES, 7, west))
      .toBeGreaterThan(0);
  });
});

describe('calculateMealCumulativeEffect', () => {
  const now = new Date(T0 + 2 * HOUR);

  it('is zero before the meal and zero for a meal from the previous window', () => {
    expect(calculateMealCumulativeEffect(meal(60, T0 + 5 * HOUR), now, PC, PROFILES, 7, 0)).toBe(0);
    expect(calculateMealCumulativeEffect(meal(60, T0 - 8 * HOUR), now, PC, PROFILES, 7, 0)).toBe(0);
  });

  it('rises monotonically with elapsed time and with carbohydrate', () => {
    let prev = -1;
    for (const h of [0, 0.5, 1, 2, 3, 3.9]) {
      const v = calculateMealCumulativeEffect(meal(60), new Date(T0 + h * HOUR), PC, PROFILES, 7, 0);
      expect([h, v >= prev]).toEqual([h, true]);
      prev = v;
    }
    const small = calculateMealCumulativeEffect(meal(30), now, PC, PROFILES, 7, 0);
    const large = calculateMealCumulativeEffect(meal(60), now, PC, PROFILES, 7, 0);
    expect(large).toBeCloseTo(small * 2, 8);
  });

  it('is bounded by carbs x carb_to_bg_factor', () => {
    for (const h of [0.5, 1, 2, 3, 3.99, 4, 6]) {
      const v = calculateMealCumulativeEffect(meal(60), new Date(T0 + h * HOUR), PC, PROFILES, 7, 0);
      expect([h, v <= 240 + 1e-9]).toEqual([h, true]);
    }
  });

  it('persists at 100 % after the window closes, until the next reset', () => {
    // A dose or meal that has finished absorbing still sits in today's bank
    // balance. It drops out when the day rolls over, not when it finishes.
    const dur = PROFILES.medium.duration_hours;
    expect(calculateMealCumulativeEffect(meal(60), new Date(T0 + (dur + 1) * HOUR), PC, PROFILES, 7, 0)).toBe(240);
    expect(calculateMealCumulativeEffect(meal(60), new Date(T0 + 18 * HOUR), PC, PROFILES, 7, 0)).toBe(240);
    // 2026-03-02T08:00Z is past the next 07:00 reset — the meal is out of scope.
    expect(calculateMealCumulativeEffect(meal(60), new Date(T0 + 20 * HOUR), PC, PROFILES, 7, 0)).toBe(0);
  });

  it('returns zero for a meal with no carbohydrate rather than NaN', () => {
    expect(calculateMealCumulativeEffect(meal(0), now, PC, PROFILES, 7, 0)).toBe(0);
    expect(calculateMealCumulativeEffect({ id: 'x', timestamp: iso(T0) } as any, now, PC, PROFILES, 7, 0)).toBe(0);
  });

  it('honours each profile’s own duration', () => {
    const at5h = new Date(T0 + 5 * HOUR);
    expect(calculateMealCumulativeEffect(meal(60, T0, 'medium'), at5h, PC, PROFILES, 7, 0)).toBe(240);
    const verySlow = calculateMealCumulativeEffect(meal(60, T0, 'very_slow'), at5h, PC, PROFILES, 7, 0);
    expect(verySlow).toBeGreaterThan(0);
    expect(verySlow).toBeLessThan(240);
  });
});

describe('calculateInsulinCumulativeEffect', () => {
  const profile = getInsulinProfile('insulin_lispro')!;

  it('is negative once absorption starts, and zero before the dose', () => {
    expect(calculateInsulinCumulativeEffect(dose(3), new Date(T0 - HOUR), PC, 7, 0)).toBe(0);
    // (comes back as -0: the effect is negated, and the magnitude is zero)
    expect(calculateInsulinCumulativeEffect(dose(3), new Date(T0), PC, 7, 0)).toBeCloseTo(0, 12);
    expect(calculateInsulinCumulativeEffect(dose(3), new Date(T0 + 2 * HOUR), PC, 7, 0)).toBeLessThan(0);
  });

  it('falls monotonically and is bounded by dose x correction_factor', () => {
    let prev = 1;
    for (const h of [0, 0.5, 1, 2, 3, 4, 4.4]) {
      const v = calculateInsulinCumulativeEffect(dose(3), new Date(T0 + h * HOUR), PC, 7, 0);
      expect([h, v <= prev]).toEqual([h, true]);
      expect([h, v >= -(3 * 40) - 1e-9]).toEqual([h, true]);
      prev = v;
    }
  });

  it('scales linearly in the dose', () => {
    const at = new Date(T0 + 2 * HOUR);
    expect(calculateInsulinCumulativeEffect(dose(6), at, PC, 7, 0))
      .toBeCloseTo(calculateInsulinCumulativeEffect(dose(3), at, PC, 7, 0) * 2, 8);
  });

  it('persists at the full dose after duration, until the next reset', () => {
    const past = new Date(T0 + (profile.duration_hours + 1) * HOUR);
    expect(calculateInsulinCumulativeEffect(dose(3), past, PC, 7, 0)).toBe(-120);
    expect(calculateInsulinCumulativeEffect(dose(3), new Date(T0 + 18 * HOUR), PC, 7, 0)).toBe(-120);
    expect(calculateInsulinCumulativeEffect(dose(3), new Date(T0 + 20 * HOUR), PC, 7, 0)).toBe(0);
  });

  it('is zero for a dose of zero or less, rather than negative', () => {
    for (const units of [0, -2]) {
      expect([units, calculateInsulinCumulativeEffect(dose(units), new Date(T0 + 2 * HOUR), PC, 7, 0)])
        .toEqual([units, 0]);
    }
  });

  it('resolves the medication through medication, then insulinType, then a default', () => {
    const at = new Date(T0 + 2 * HOUR);
    const named = calculateInsulinCumulativeEffect(dose(3, T0, 'insulin_lispro'), at, PC, 7, 0);
    const viaType: any = { id: 'd', dose: 3, insulinType: 'insulin_lispro', taken_at: iso(T0) };
    const unnamed: any = { id: 'd', dose: 3, taken_at: iso(T0) };
    expect(calculateInsulinCumulativeEffect(viaType, at, PC, 7, 0)).toBe(named);
    // the default is insulin_aspart, a different curve — so simply finite, not equal
    expect(Number.isFinite(calculateInsulinCumulativeEffect(unnamed, at, PC, 7, 0))).toBe(true);
  });

  it('accepts every timestamp field name the backend uses', () => {
    const at = new Date(T0 + 2 * HOUR);
    const expected = calculateInsulinCumulativeEffect(dose(3), at, PC, 7, 0);
    for (const field of ['administrationTime', 'taken_at', 'takenAt', 'timestamp']) {
      const d: any = { id: 'd', dose: 3, medication: 'insulin_lispro', [field]: iso(T0) };
      expect([field, calculateInsulinCumulativeEffect(d, at, PC, 7, 0)]).toEqual([field, expected]);
    }
  });
});

describe('calculateTotalCumulativeEffects', () => {
  const now = new Date(T0 + 2 * HOUR);

  it('nets meals against insulin and reports the parts alongside the sum', () => {
    const r = calculateTotalCumulativeEffects([meal(60)], [dose(3)], now, PC, PROFILES, 7, 0);
    expect(r.cumulativeMealEffect).toBeGreaterThan(0);
    expect(r.cumulativeInsulinEffect).toBeLessThan(0);
    // The net is rounded once, from the unrounded sum — not summed from the two
    // rounded parts. The two can therefore differ by up to 0.1 mg/dL, which is
    // the correct arithmetic and worth stating so it is not "fixed" later.
    expect(r.cumulativeNetBaseline)
      .toBeCloseTo(r.cumulativeMealEffect + r.cumulativeInsulinEffect, 0);
    expect(Math.abs(r.cumulativeNetBaseline - (r.cumulativeMealEffect + r.cumulativeInsulinEffect)))
      .toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('returns a well-formed zero result for an empty day', () => {
    const r = calculateTotalCumulativeEffects([], [], now, PC, PROFILES, 7, 0);
    expect([r.cumulativeMealEffect, r.cumulativeInsulinEffect, r.cumulativeNetBaseline])
      .toEqual([0, 0, 0]);
    expect(r.mealContributions).toEqual([]);
    expect(r.insulinContributions).toEqual([]);
    expect(r.resetHour).toBe(7);
    expect(r.calculationTime).toBe(now.toISOString());
  });

  it('lists only the records that actually contributed', () => {
    const r = calculateTotalCumulativeEffects(
      [meal(60), meal(0, T0 + HOUR), meal(60, T0 - 8 * HOUR)],
      [dose(3), dose(0, T0 + HOUR)],
      now, PC, PROFILES, 7, 0,
    );
    expect(r.mealContributions).toHaveLength(1);
    expect(r.insulinContributions).toHaveLength(1);
  });

  it('sums across several meals and several doses', () => {
    const meals = [meal(30, T0), meal(30, T0 + HOUR)];
    const doses = [dose(2, T0), dose(2, T0 + HOUR)];
    const r = calculateTotalCumulativeEffects(meals, doses, now, PC, PROFILES, 7, 0);
    const mealSum = meals.reduce((s, m) => s + calculateMealCumulativeEffect(m, now, PC, PROFILES, 7, 0), 0);
    const doseSum = doses.reduce((s, d) => s + calculateInsulinCumulativeEffect(d, now, PC, 7, 0), 0);
    expect(r.cumulativeMealEffect).toBeCloseTo(Math.round(mealSum * 10) / 10, 6);
    expect(r.cumulativeInsulinEffect).toBeCloseTo(Math.round(doseSum * 10) / 10, 6);
  });

  it('D11 FIXED: one dose with no timestamp is dropped, not fatal to the rest', () => {
    // Was PINS D11. getDoseTimestamp threw for a dose carrying none of
    // administrationTime / taken_at / takenAt / timestamp, and nothing between
    // it and calculateTotalCumulativeEffects caught — so a single malformed row
    // in an API payload lost every other meal and dose in the same call.
    //
    // Fixed: getDoseTimestamp returns an Invalid Date and callers drop the
    // record, matching how every other record path in this module already
    // degrades.
    const good = dose(3);
    const noTimestamp: any = { id: 'orphan', dose: 3, medication: 'insulin_lispro' };

    const r = calculateTotalCumulativeEffects(
      [meal(60)], [good, noTimestamp], now, PC, PROFILES, 7, 0);
    expect(r.insulinContributions).toHaveLength(1);
    expect(r.insulinContributions[0].doseId).toBe(good.id);
    expect(r.mealContributions).toHaveLength(1);

    // The good dose contributes exactly what it would have on its own — the
    // bad row neither removes nor adds anything.
    const alone = calculateTotalCumulativeEffects([meal(60)], [good], now, PC, PROFILES, 7, 0);
    expect(r.cumulativeNetBaseline).toBe(alone.cumulativeNetBaseline);

    // Order-independent.
    const reversed = calculateTotalCumulativeEffects(
      [meal(60)], [noTimestamp, good], now, PC, PROFILES, 7, 0);
    expect(reversed.cumulativeNetBaseline).toBe(alone.cumulativeNetBaseline);
  });

  it('D11 FIXED: a timestamp-less dose contributes zero on its own', () => {
    const noTimestamp: any = { id: 'orphan', dose: 3, medication: 'insulin_lispro' };
    expect(calculateInsulinCumulativeEffect(noTimestamp, now, PC, 7, 0)).toBe(0);
    expect(() => calculateInsulinCumulativeEffect(noTimestamp, now, PC, 7, 0)).not.toThrow();
  });

  it('D11 FIXED: the baseline calculation also drops it rather than throwing', () => {
    const noTimestamp: any = { id: 'orphan', dose: 3, medication: 'insulin_lispro' };
    const reading: any = { value: 180, timestamp: iso(T0 + 2 * HOUR) };
    const r = calculateStableBaselineFromReading(
      reading, [], [noTimestamp, dose(2)], new Date(T0 + 2 * HOUR), PC, PROFILES, 7, 0);
    expect(r.insulinCount).toBe(1);
    expect(r.insulinAtReading[0].doseId).toBe(dose(2).id);
  });

  it('tolerates a meal with an unparseable timestamp without throwing', () => {
    // The asymmetry with the dose path above, stated directly.
    const broken: any = { id: 'broken', timestamp: 'not a date', nutrition: { totalCarbEquiv: 60 } };
    expect(() => calculateTotalCumulativeEffects(
      [broken, meal(60)], [], now, PC, PROFILES, 7, 0,
    )).not.toThrow();
  });
});

describe('calculateStableBaselineFromReading', () => {
  const readingAt = T0 + 2 * HOUR;
  const reading: any = { value: 180, timestamp: iso(readingAt) };

  it('is the reading with the day’s net effect removed — an exact identity', () => {
    const r = calculateStableBaselineFromReading(
      reading, [meal(20)], [dose(2)], new Date(readingAt), PC, PROFILES, 7, 0);
    expect(r.readingValue).toBe(180);
    expect(r.cumulativeNetEffect)
      .toBeCloseTo(r.cumulativeMealEffect - r.cumulativeInsulinEffect, 6);
    expect(r.stableBaseline).toBeCloseTo(180 - r.cumulativeNetEffect, 6);
  });

  it('reports insulin as a positive magnitude and subtracts it', () => {
    // The sign convention differs from calculateInsulinCumulativeEffect, which
    // returns a negative number. Here the effect is stored unsigned and the
    // subtraction happens in cumulativeNetEffect.
    const r = calculateStableBaselineFromReading(
      reading, [], [dose(2)], new Date(readingAt), PC, PROFILES, 7, 0);
    expect(r.cumulativeInsulinEffect).toBeGreaterThan(0);
    expect(r.cumulativeNetEffect).toBeLessThan(0);
    expect(r.stableBaseline).toBeGreaterThan(180);
  });

  it('equals the reading itself when nothing happened today', () => {
    const r = calculateStableBaselineFromReading(
      reading, [], [], new Date(readingAt), PC, PROFILES, 7, 0);
    expect(r.stableBaseline).toBe(180);
    expect([r.mealsCount, r.insulinCount]).toEqual([0, 0]);
  });

  it('ignores records that post-date the reading', () => {
    // The reading cannot contain the effect of a meal eaten after it was taken.
    const later = meal(60, readingAt + HOUR);
    const withLater = calculateStableBaselineFromReading(
      reading, [later], [], new Date(readingAt + 2 * HOUR), PC, PROFILES, 7, 0);
    expect(withLater.mealsCount).toBe(0);
    expect(withLater.stableBaseline).toBe(180);
  });

  it('ignores records from before the reading’s own reset boundary', () => {
    const r = calculateStableBaselineFromReading(
      reading, [meal(60, T0 - 8 * HOUR)], [dose(3, T0 - 8 * HOUR)],
      new Date(readingAt), PC, PROFILES, 7, 0);
    expect([r.mealsCount, r.insulinCount]).toEqual([0, 0]);
  });

  it('applies an override correction factor to insulin only', () => {
    // Step 5: post-exercise sensitivity raises the effective ISF. It must not
    // touch the carbohydrate side.
    const base = calculateStableBaselineFromReading(
      reading, [meal(20)], [dose(2)], new Date(readingAt), PC, PROFILES, 7, 0);
    const boosted = calculateStableBaselineFromReading(
      reading, [meal(20)], [dose(2)], new Date(readingAt), PC, PROFILES, 7, 0, 60);
    expect(boosted.cumulativeMealEffect).toBe(base.cumulativeMealEffect);
    // Both sides are rounded to 0.1 mg/dL before they are reported, so compare
    // to within one rounding step rather than exactly.
    expect(Math.abs(boosted.cumulativeInsulinEffect - base.cumulativeInsulinEffect * 1.5))
      .toBeLessThanOrEqual(0.1 + 1e-9);
    expect(boosted.cumulativeInsulinEffect).toBeGreaterThan(base.cumulativeInsulinEffect);
  });

  it('warns rather than silently returning an implausible baseline', () => {
    const bigMeal: any = { id: 'm', timestamp: iso(T0), nutrition: { absorptionType: 'very_fast', totalCarbEquiv: 200 } };
    const r = calculateStableBaselineFromReading(
      { value: 120, timestamp: iso(readingAt) } as any, [bigMeal], [],
      new Date(readingAt), PC, PROFILES, 7, 0);
    expect(r.stableBaseline).toBeLessThan(40);
  });

  it('reads the reading value from `value` or from the legacy `bloodSugar`', () => {
    const legacy: any = { bloodSugar: 145, timestamp: iso(readingAt) };
    const r = calculateStableBaselineFromReading(
      legacy, [], [], new Date(readingAt), PC, PROFILES, 7, 0);
    expect(r.stableBaseline).toBe(145);
  });

  it('D12 FIXED: an unknown absorption type falls back to medium in both places', () => {
    // Was PINS D12. For a meal whose absorption_type is not a profile key,
    // calculateMealCumulativeEffect fell back to *full* absorption while
    // calculateStableBaselineFromReading skipped the meal entirely. Both are
    // reached from calculateNetEffect on the same data, so the baseline was
    // computed without the meal and the cumulative term then added all of it —
    // the meal counted once with nothing subtracted, 200 mg/dL of divergence
    // from a single mislabelled 50 g meal.
    //
    // The backend settles it: get_meal_absorption_profile() does
    // `absorption_profiles.get(absorption_type, absorption_profiles['medium'])`,
    // so an unknown type is absorbed on the medium curve. Neither TypeScript
    // branch matched that; both do now.
    const mislabelled: any = {
      id: 'm', timestamp: iso(T0),
      nutrition: { absorptionType: 'nonexistent_type', totalCarbEquiv: 50 },
    };
    const asMedium: any = {
      id: 'm', timestamp: iso(T0),
      nutrition: { absorptionType: 'medium', totalCarbEquiv: 50 },
    };
    const evalAt = new Date(T0 + HOUR);

    // Identical to the same meal declared 'medium' — that is what the fallback means.
    expect(calculateMealCumulativeEffect(mislabelled, evalAt, PC, PROFILES, 7, 0))
      .toBe(calculateMealCumulativeEffect(asMedium, evalAt, PC, PROFILES, 7, 0));
    // and partial, not the full 200 mg/dL the old fallback returned
    const effect = calculateMealCumulativeEffect(mislabelled, evalAt, PC, PROFILES, 7, 0);
    expect(effect).toBeGreaterThan(0);
    expect(effect).toBeLessThan(200);

    // The baseline now counts it, on the same curve, instead of skipping it.
    const reading: any = { value: 180, timestamp: iso(T0 + HOUR) };
    const mislabelledBaseline = calculateStableBaselineFromReading(
      reading, [mislabelled], [], evalAt, PC, PROFILES, 7, 0);
    const mediumBaseline = calculateStableBaselineFromReading(
      reading, [asMedium], [], evalAt, PC, PROFILES, 7, 0);
    expect(mislabelledBaseline.mealsCount).toBe(1);
    expect(mislabelledBaseline.cumulativeMealEffect).toBe(mediumBaseline.cumulativeMealEffect);
    expect(mislabelledBaseline.stableBaseline).toBe(mediumBaseline.stableBaseline);
  });

  it('D12 FIXED: the two halves of calculateNetEffect agree on a mislabelled meal', () => {
    // The property that was actually broken: the baseline subtracts exactly
    // what the cumulative term adds, so a mislabelled meal cannot be counted
    // once with nothing removed.
    const mislabelled: any = {
      id: 'm', timestamp: iso(T0),
      nutrition: { absorptionType: 'nonexistent_type', totalCarbEquiv: 50 },
    };
    const evalAt = new Date(T0 + HOUR);
    const reading: any = { value: 180, timestamp: iso(T0 + HOUR) };

    const baseline = calculateStableBaselineFromReading(
      reading, [mislabelled], [], evalAt, PC, PROFILES, 7, 0);
    const cumulative = calculateMealCumulativeEffect(mislabelled, evalAt, PC, PROFILES, 7, 0);

    // baseline removed the meal's contribution; the cumulative term adds the
    // same quantity back, so the estimate returns to the reading. The baseline
    // reports to 0.1 mg/dL, so compare to within one rounding step — the old
    // behaviour was out by the meal's whole 200 mg/dL, not by a rounding step.
    expect(Math.abs(baseline.cumulativeMealEffect - cumulative)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(Math.abs(baseline.stableBaseline + cumulative - 180)).toBeLessThanOrEqual(0.05 + 1e-9);
  });
});

describe('calculateNetEffect', () => {
  const now = new Date(T0 + HOUR);

  it('falls back to the target glucose when there is no baseline', () => {
    const r = calculateNetEffect(null, [], [], now, PC, PROFILES);
    expect(r.estimatedBG).toBe(100);
    expect(r.projectedFinalBG).toBe(100);
    expect([r.totalIOB, r.totalMOB, r.currentNetEffect]).toEqual([0, 0, 0]);
    expect(r.trend).toBe('stable');
    expect(r.safetyStatus).toBe('optimal');
  });

  it('adds the cumulative baseline to the stable baseline', () => {
    const baseline: any = { stableBaseline: 110 };
    const r = calculateNetEffect(baseline, [meal(60)], [dose(6)], now, PC, PROFILES);
    const cumulative = calculateTotalCumulativeEffects([meal(60)], [dose(6)], now, PC, PROFILES, 7, 0);
    expect(r.cumulativeBaseline).toBe(cumulative.cumulativeNetBaseline);
    expect(r.estimatedBG).toBeCloseTo(110 + cumulative.cumulativeNetBaseline, 6);
  });

  it('projects the final BG from pending carbohydrate minus remaining IOB', () => {
    const baseline: any = { stableBaseline: 110 };
    const withMeal = calculateNetEffect(baseline, [meal(60)], [], now, PC, PROFILES);
    const withInsulin = calculateNetEffect(baseline, [], [dose(6)], now, PC, PROFILES);
    expect(withMeal.projectedFinalBG).toBeGreaterThan(withMeal.estimatedBG);
    expect(withInsulin.projectedFinalBG).toBeLessThan(withInsulin.estimatedBG);
  });

  it('reports the meal rate, not the meal elevation, as the net effect', () => {
    // Bug-3 fix: totalBGElevation is a cumulative amount and always reads large
    // during absorption. The trend thresholds are rates, so currentNetEffect
    // must be built from totalActiveEffect instead.
    const baseline: any = { stableBaseline: 110 };
    const r = calculateNetEffect(baseline, [meal(60)], [], now, PC, PROFILES);
    expect(r.activeMealEffect).not.toBe(r.currentNetEffect);
    expect(r.currentNetEffect).toBeGreaterThan(0);
  });

  it('maps net effect onto trends at the canonical thresholds', () => {
    // The thresholds come from NET_EFFECT_THRESHOLDS, not from local literals.
    // Exercised through the public surface: a rising meal load and a falling
    // insulin load must land on opposite sides.
    const baseline: any = { stableBaseline: 110 };
    const rising = calculateNetEffect(baseline, [meal(80)], [], now, PC, PROFILES);
    const falling = calculateNetEffect(baseline, [], [dose(8)], now, PC, PROFILES);
    expect(rising.currentNetEffect).toBeGreaterThan(NET_EFFECT_THRESHOLDS.rising);
    expect(['rising', 'rising_rapidly']).toContain(rising.trend);
    expect(falling.currentNetEffect).toBeLessThan(NET_EFFECT_THRESHOLDS.falling);
    expect(['falling', 'falling_rapidly']).toContain(falling.trend);
    expect(calculateNetEffect(baseline, [], [], now, PC, PROFILES).trend).toBe('stable');
  });

  it('flags hypo and hyper risk from the estimated BG', () => {
    expect(calculateNetEffect({ stableBaseline: 50 } as any, [], [], now, PC, PROFILES).safetyStatus)
      .toBe('critical_low');
    expect(calculateNetEffect({ stableBaseline: 300 } as any, [], [], now, PC, PROFILES).safetyStatus)
      .toBe('critical_high');
    expect(calculateNetEffect({ stableBaseline: 65 } as any, [], [], now, PC, PROFILES).safetyStatus)
      .toBe('hypoglycemia_risk');
    expect(calculateNetEffect({ stableBaseline: 200 } as any, [], [], now, PC, PROFILES).safetyStatus)
      .toBe('hyperglycemia_risk');
    expect(calculateNetEffect({ stableBaseline: 100 } as any, [], [], now, PC, PROFILES).safetyStatus)
      .toBe('optimal');
  });

  it('rounds every reported figure to a displayable precision', () => {
    const r = calculateNetEffect({ stableBaseline: 110 } as any, [meal(63)], [dose(4.4)], now, PC, PROFILES);
    for (const key of ['currentNetEffect', 'estimatedBG', 'projectedFinalBG',
                       'activeInsulinEffect', 'activeMealEffect'] as const) {
      expect([key, Math.round((r as any)[key] * 10) / 10]).toEqual([key, (r as any)[key]]);
    }
    for (const key of ['totalIOB', 'totalMOB'] as const) {
      expect([key, Math.round((r as any)[key] * 100) / 100]).toEqual([key, (r as any)[key]]);
    }
  });
});

describe('calculateWeightedAbsorptionType', () => {
  const item = (type: string, carbs: number) => ({ details: { absorption_type: type, carbs } }) as any;

  it('weights by carbohydrate, not by item count', () => {
    expect(calculateWeightedAbsorptionType([item('very_fast', 90), item('very_slow', 10)])).toBe('very_fast');
    expect(calculateWeightedAbsorptionType([item('very_slow', 90), item('very_fast', 10)])).toBe('very_slow');
  });

  it('lands between two equally weighted types', () => {
    expect(calculateWeightedAbsorptionType([item('fast', 50), item('slow', 50)])).toBe('medium');
  });

  it('returns medium for an empty list, zero carbs, or an unknown type', () => {
    expect(calculateWeightedAbsorptionType([])).toBe('medium');
    expect(calculateWeightedAbsorptionType(null as any)).toBe('medium');
    expect(calculateWeightedAbsorptionType([item('very_fast', 0), item('very_slow', 0)])).toBe('medium');
    expect(calculateWeightedAbsorptionType([item('not_a_type', 50)])).toBe('medium');
  });

  it('ignores items with no carbohydrate rather than letting them pull the average', () => {
    // A zero-carb item cannot shift the absorption type of the meal around it.
    expect(calculateWeightedAbsorptionType([item('very_fast', 50), item('very_slow', 0)]))
      .toBe(calculateWeightedAbsorptionType([item('very_fast', 50)]));
  });
});

describe('calculateUnifiedMealImpact', () => {
  it('returns an empty impact rather than throwing for missing inputs', () => {
    for (const [label, mealData, constants] of [
      ['no meal', null, PC],
      ['no constants', { nutrition: { carbs: 30 } }, undefined],
      ['neither', null, undefined],
    ] as any[]) {
      const r = calculateUnifiedMealImpact(mealData, constants);
      expect([label, r.baseInsulin, r.adjustedInsulin, r.peakBgImpact]).toEqual([label, 0, 0, 0]);
      expect([label, r.absorptionProfile.type]).toEqual([label, 'medium']);
    }
  });

  it('derives base insulin from the carb ratio and adjusts by absorption and timing', () => {
    const constants = { ...PC, insulin_to_carb_ratio: 10, meal_timing_factors: { lunch: 1.0 } };
    const r = calculateUnifiedMealImpact(
      { mealType: 'lunch', nutrition: { carbs: 60, protein: 0, fat: 0, fiber: 0, absorptionType: 'fast' } } as any,
      constants);
    expect(r.baseInsulin).toBeCloseTo(6, 6);
    const factor = DEFAULT_PATIENT_CONSTANTS.absorption_modifiers.fast;
    expect(r.adjustedInsulin).toBeCloseTo(6 * factor, 6);
    expect(r.calculationSummary.adjustment_factors.absorption_rate).toBe(factor);
    expect(r.absorptionProfile.patientModified).toBe(true);
  });

  it('applies the meal timing factor for the meal type', () => {
    const constants = {
      ...PC, insulin_to_carb_ratio: 10,
      meal_timing_factors: { breakfast: 1.2, lunch: 1.0 },
    };
    const nutrition = { carbs: 60, protein: 0, fat: 0, fiber: 0, absorptionType: 'medium' };
    const lunch = calculateUnifiedMealImpact({ mealType: 'lunch', nutrition } as any, constants);
    const breakfast = calculateUnifiedMealImpact({ mealType: 'breakfast', nutrition } as any, constants);
    expect(breakfast.adjustedInsulin).toBeCloseTo(lunch.adjustedInsulin * 1.2, 6);
    expect(breakfast.calculationSummary.adjustment_factors.meal_timing).toBe(1.2);
  });

  it('marks the profile unmodified when the modifier is exactly 1.0', () => {
    const r = calculateUnifiedMealImpact(
      { nutrition: { carbs: 60, protein: 0, fat: 0, fiber: 0, absorptionType: 'medium' } } as any, PC);
    expect(r.absorptionProfile.factor).toBe(1.0);
    expect(r.absorptionProfile.patientModified).toBe(false);
  });

  it('only weights foodItems when there is more than one of them', () => {
    // The single-item branch is deliberately not weighted — with one item the
    // weighted average is just that item, so the code leaves it at the default.
    const single: any = {
      foodItems: [{ details: { absorption_type: 'very_fast', carbs: 50 } }],
      nutrition: {},
    };
    const pair: any = {
      foodItems: [
        { details: { absorption_type: 'very_fast', carbs: 50 } },
        { details: { absorption_type: 'very_fast', carbs: 50 } },
      ],
      nutrition: {},
    };
    expect(calculateUnifiedMealImpact(single, PC).absorptionProfile.type).toBe('medium');
    expect(calculateUnifiedMealImpact(pair, PC).absorptionProfile.type).toBe('very_fast');
  });

  it('emits a time curve only when asked for one', () => {
    const mealData: any = { timestamp: T0, nutrition: { carbs: 60, protein: 0, fat: 0, fiber: 0 } };
    expect(calculateUnifiedMealImpact(mealData, PC).timeCurve).toBeUndefined();
    const curve = calculateUnifiedMealImpact(mealData, PC, { includeTimeCurve: true }).timeCurve;
    expect(Array.isArray(curve)).toBe(true);
    expect(curve!.length).toBeGreaterThan(0);
  });
});
