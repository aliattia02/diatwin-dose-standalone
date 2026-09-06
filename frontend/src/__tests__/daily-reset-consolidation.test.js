/**
 * D24 — every daily-reset boundary in the web frontend uses the *patient's*
 * timezone, not the browser's.
 *
 * `TimeManager.getDailyResetTime(currentTimestamp, resetHour, tzOffsetMinutes)`
 * falls back to `-(new Date(...).getTimezoneOffset())` — the browser's own
 * offset — when `tzOffsetMinutes` is null. The chart components and
 * `netEffectCalculationService` all pass the patient's offset; the baseline
 * estimation path did not, at seven call sites across two files:
 *
 *   utils/bloodGlucoseEstimationService.js  176  getDailyResetTime
 *   utils/bloodGlucoseEstimationService.js  208  isWithinCurrentDay  (meals)
 *   utils/bloodGlucoseEstimationService.js  392  isWithinCurrentDay  (insulin)
 *   utils/bloodGlucoseEstimationService.js  844  isAtResetTime
 *   utils/bloodGlucoseEstimationService.js  915  isWithinCurrentDay  (meals)
 *   utils/bloodGlucoseEstimationService.js 1020  isWithinCurrentDay  (insulin)
 *   contexts/BloodSugarDataContext.js      1504  getDailyResetTime
 *
 * The consequence is worse for a clinician than for a patient. Within one
 * screen the baseline estimation and the charts could disagree about where the
 * day starts; and a doctor in London reviewing a patient in Cairo got the
 * *doctor's* offset applied to the *patient's* reset boundary. The patient's
 * own device never surfaced it, because for them the two offsets agree.
 *
 * `isAtResetTime` was a deeper instance of the same defect and is recorded
 * separately as **D24b**: it had no `tzOffsetMinutes` parameter at all and read
 * the wall clock through `getHours()`/`getMinutes()`, so no call site could
 * have passed the patient's offset. It now derives the boundary from
 * `getDailyResetTime`, which is what Arm 5 rule 16 requires — one definition of
 * the daily reset, anchored on the patient's local calendar date.
 *
 * Same class as D13 and D9 in the mobile client. This suite is the frontend
 * counterpart of `mobile/__tests__/daily-reset-consolidation.test.ts` and
 * guards the *class* rather than the instances: it asserts the reset boundary
 * is a function of the patient's offset across the full offset range, and that
 * the calculation paths downstream actually respond to it.
 */

import TimeManager from '../utils/TimeManager';
import {
  calculateStableBaseline,
  estimateGlucoseAtTime,
} from '../utils/bloodGlucoseEstimationService';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Every UTC offset in real-world use, west and east, including the half-hours. */
const OFFSETS = [-720, -480, -300, -210, 0, 60, 120, 210, 330, 345, 420, 480,
                 540, 570, 600, 630, 720, 780, 840];

// ---------------------------------------------------------------------------
// The boundary itself
// ---------------------------------------------------------------------------

describe('getDailyResetTime is anchored on the patient local calendar date', () => {
  /**
   * Properties rather than pinned instants (Arm 5 rule 11). These hold for any
   * correct implementation, in any browser timezone — nothing here reads the
   * host clock, so the suite gives the same verdict on a developer machine at
   * UTC+02:00 and on a CI runner at UTC.
   */
  it('never returns a future or a stale boundary', () => {
    for (const tz of OFFSETS) {
      for (let h = 0; h < 24; h++) {
        const now = Date.UTC(2026, 2, 1, h, 0, 0);
        const boundary = TimeManager.getDailyResetTime(now, 7, tz);
        expect([tz, h, boundary <= now]).toEqual([tz, h, true]);
        expect([tz, h, now - boundary < 24 * HOUR]).toEqual([tz, h, true]);
      }
    }
  });

  it('lands on the reset hour in the patient local clock', () => {
    for (const tz of OFFSETS) {
      for (let resetHour = 0; resetHour < 24; resetHour++) {
        const now = Date.UTC(2026, 2, 1, 20, 0, 0);
        const local = new Date(TimeManager.getDailyResetTime(now, resetHour, tz) + tz * MINUTE);
        expect([tz, resetHour, local.getUTCHours(), local.getUTCMinutes()])
          .toEqual([tz, resetHour, resetHour, 0]);
      }
    }
  });

  it('advances by exactly one day across a boundary', () => {
    for (const tz of OFFSETS) {
      // 07:00 patient-local expressed in UTC, then sampled either side of it.
      const boundaryUtc = Date.UTC(2026, 2, 1, 7, 0, 0) - tz * MINUTE;
      const before = TimeManager.getDailyResetTime(boundaryUtc - MINUTE, 7, tz);
      const after = TimeManager.getDailyResetTime(boundaryUtc + MINUTE, 7, tz);
      expect([tz, after - before]).toEqual([tz, 24 * HOUR]);
    }
  });

  it('shifts with the patient offset rather than staying put', () => {
    // The regression this pins: if the offset argument were ignored, every
    // offset would produce the same boundary. Two offsets a day apart in local
    // date must not agree.
    const now = Date.UTC(2026, 2, 1, 20, 0, 0);
    const west = TimeManager.getDailyResetTime(now, 7, -300);
    const east = TimeManager.getDailyResetTime(now, 7, 780);
    expect(west).not.toEqual(east);
  });
});

// ---------------------------------------------------------------------------
// D24b — isAtResetTime had no offset parameter at all
// ---------------------------------------------------------------------------

describe('isAtResetTime honours the patient timezone (D24b)', () => {
  it('is true on the minute the patient local clock reaches the reset hour', () => {
    for (const tz of OFFSETS) {
      const boundaryUtc = Date.UTC(2026, 2, 1, 7, 0, 0) - tz * MINUTE;
      expect([tz, TimeManager.isAtResetTime(boundaryUtc, 7, tz)]).toEqual([tz, true]);
      expect([tz, TimeManager.isAtResetTime(boundaryUtc + 59 * 1000, 7, tz)])
        .toEqual([tz, true]);
    }
  });

  it('is false a minute either side of it', () => {
    for (const tz of OFFSETS) {
      const boundaryUtc = Date.UTC(2026, 2, 1, 7, 0, 0) - tz * MINUTE;
      expect([tz, TimeManager.isAtResetTime(boundaryUtc - MINUTE, 7, tz)])
        .toEqual([tz, false]);
      expect([tz, TimeManager.isAtResetTime(boundaryUtc + MINUTE, 7, tz)])
        .toEqual([tz, false]);
    }
  });

  it('agrees with getDailyResetTime, which is the one definition (rule 16)', () => {
    // isAtResetTime must not carry its own copy of the boundary arithmetic.
    for (const tz of [-300, 0, 420, 780]) {
      for (let resetHour = 0; resetHour < 24; resetHour++) {
        for (let step = 0; step < 24 * 4; step++) {
          const now = Date.UTC(2026, 2, 1, 0, 0, 0) + step * 15 * MINUTE;
          const viaBoundary =
            now - TimeManager.getDailyResetTime(now, resetHour, tz) < MINUTE;
          expect([tz, resetHour, step, TimeManager.isAtResetTime(now, resetHour, tz)])
            .toEqual([tz, resetHour, step, viaBoundary]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The calculation paths downstream must actually respond to the offset
// ---------------------------------------------------------------------------

/**
 * Two patients, same instant, 07:00 reset, whose local days began either side
 * of one meal.
 *
 *   at UTC-05:00 the 07:00 boundary falls at 12:00Z
 *   at UTC+13:00 it falls at 18:00Z
 *
 * A meal at 17:00Z is therefore inside the western patient's day and before
 * the eastern patient's day began. It is also three hours before `NOW`, which
 * keeps it inside a medium absorption profile so it registers on both the
 * absorbed and the still-active terms.
 */
const NOW = Date.UTC(2026, 2, 1, 20, 0, 0);
const MEAL_IN_THE_GAP = Date.UTC(2026, 2, 1, 17, 0, 0);

const constantsAt = (tz) => ({
  daily_reset_hour: 7,
  timezone_offset_minutes: tz,
  carb_to_bg_factor: 4.0,
  correction_factor: 50,
  target_glucose: 100,
});

// `carbEquiv` is the field both calculation paths read; `nutrition` mirrors
// the stored meal document so the fixture matches what the app really passes.
const MEALS = [{
  id: 'meal-in-the-gap',
  timestamp: MEAL_IN_THE_GAP,
  carbEquiv: 60,
  absorptionType: 'medium',
  nutrition: { totalCarbEquiv: 60, absorptionType: 'medium' },
}];

describe('the baseline path uses the patient offset, not the browser offset', () => {
  /**
   * Stated as a dependency rather than a pinned number: whatever the model
   * computes, it must not compute the *same* thing for two patients whose local
   * day started on opposite sides of the meal. If the offset is ignored, both
   * calls take the identical branch and the two results are equal — which is
   * exactly the pre-fix behaviour and what makes this test fail before the fix.
   */
  it('calculateStableBaseline responds to timezone_offset_minutes', () => {
    const west = calculateStableBaseline(120, NOW, MEALS, [], constantsAt(-300));
    const east = calculateStableBaseline(120, NOW, MEALS, [], constantsAt(780));

    // West of the meal's boundary the meal counts toward the day; east of it
    // the patient's day began after the meal, so it must not.
    expect(west.cumulativeTotalCarbsEaten).toBeGreaterThan(0);
    expect(east.cumulativeTotalCarbsEaten).toBe(0);
  });

  it('estimateGlucoseAtTime responds to timezone_offset_minutes', () => {
    const west = estimateGlucoseAtTime(
      120, NOW, MEAL_IN_THE_GAP, MEALS, [], constantsAt(-300));
    const east = estimateGlucoseAtTime(
      120, NOW, MEAL_IN_THE_GAP, MEALS, [], constantsAt(780));

    expect(west.cumulativeMealEffect).toBeGreaterThan(0);
    expect(east.cumulativeMealEffect).toBe(0);
  });

  it('leaves a patient whose offset matches the browser exactly as they were', () => {
    // The negative case: the fix must not move the boundary for the common
    // patient, only for the one whose offset differs from the device's.
    const browserOffset = -(new Date(NOW).getTimezoneOffset());
    const explicit = calculateStableBaseline(
      120, NOW, MEALS, [], constantsAt(browserOffset));
    const implicit = calculateStableBaseline(120, NOW, MEALS, [], {
      daily_reset_hour: 7,
      carb_to_bg_factor: 4.0,
      correction_factor: 50,
      target_glucose: 100,
    });
    expect(explicit.cumulativeTotalCarbsEaten)
      .toEqual(implicit.cumulativeTotalCarbsEaten);
  });
});
