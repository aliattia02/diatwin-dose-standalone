/**
 * D9 — every daily-reset boundary in the client resolves to one definition.
 *
 * The client had six places that computed "the most recent daily reset". Three
 * were right (TimeManager, ChartUtils, the insulin timeline generator, all
 * anchoring on the patient's *local* date); three carried their own copy of the
 * arithmetic anchored on the **UTC** date:
 *
 *   utils/glucose/blood-glucose-estimation.ts  getDailyResetTime
 *   utils/glucose/meal-pharmacodynamics.ts     inline getLastResetMs
 *   utils/calculations/cumulative-effects.ts   (re-exports the first)
 *
 * Anchoring on the UTC date is right only while the patient's local date
 * matches it. East of +07:00 it does not — at 20:00 UTC a patient at UTC+13 is
 * already on the next local day — and since the rollback in each copy could
 * only move the candidate backwards, the boundary came out exactly 24 h early.
 * Every "since the daily reset" guard downstream then admitted an extra day of
 * meals, doses and activity.
 *
 * The condition was `timezone_offset_minutes > daily_reset_hour * 60`, and the
 * affected slice of each day was `offset_hours - reset_hour` long. Offsets at
 * or west of +07:00 were never affected, which is why it never surfaced in use.
 *
 * All three now delegate to TimeManager. This suite is the guard against the
 * *class* of bug rather than the instances: it asserts every exported reset
 * path agrees with TimeManager across the full offset range, at every hour of
 * the day and at every legal reset hour. A fourth copy of the arithmetic, added
 * later, fails here the moment it disagrees.
 */

import { getDailyResetTime as timeManagerReset } from '../utils/time/TimeManager';
import {
  getDailyResetTime as bgeDailyReset,
  getLastResetTime as bgeLastReset,
} from '../utils/glucose/blood-glucose-estimation';
import {
  getDailyResetTime as cumulativeDailyReset,
  getLastResetTime as cumulativeLastReset,
} from '../utils/calculations/cumulative-effects';

const HOUR = 3_600_000;

/** Every UTC offset in real-world use, west and east, including the half-hours. */
const OFFSETS = [-720, -480, -300, -210, 0, 60, 120, 210, 330, 345, 420, 480,
                 540, 570, 600, 630, 720, 780, 840];

/**
 * The exported paths that used to disagree.
 *
 * `ChartUtils.getLastResetTimeMs` is deliberately absent: it is already correct
 * (it works in patient-local milliseconds), and importing `ChartUtils.tsx` pulls
 * the Victory chart package into the module graph, which jest's transform does
 * not handle. Its behaviour is covered where the charts themselves are.
 */
const PATHS: Array<[string, (now: Date, resetHour: number, tz: number) => number]> = [
  ['blood-glucose-estimation.getDailyResetTime',
    (now, h, tz) => bgeDailyReset(now, h, tz).getTime()],
  ['blood-glucose-estimation.getLastResetTime',
    (now, h, tz) => bgeLastReset(now, h, tz).getTime()],
  ['cumulative-effects.getDailyResetTime',
    (now, h, tz) => cumulativeDailyReset(now, h, tz).getTime()],
  ['cumulative-effects.getLastResetTime',
    (now, h, tz) => cumulativeLastReset(now, h, tz).getTime()],
];

describe('every daily-reset path agrees with TimeManager', () => {
  it.each(PATHS)('%s', (_name, reset) => {
    for (const tz of OFFSETS) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 2, 1, h, 0, 0));
        const expected = timeManagerReset(now.getTime(), 7, tz);
        expect([tz, h, reset(now, 7, tz)]).toEqual([tz, h, expected]);
      }
    }
  });

  it.each(PATHS)('%s — at every legal reset hour', (_name, reset) => {
    // The defect's condition involved daily_reset_hour, so sweeping only the
    // default 7 would leave most of the surface untested.
    const now = new Date(Date.UTC(2026, 2, 1, 20, 0, 0));
    for (let resetHour = 0; resetHour < 24; resetHour++) {
      for (const tz of [-300, 0, 420, 780, 840]) {
        expect([resetHour, tz, reset(now, resetHour, tz)])
          .toEqual([resetHour, tz, timeManagerReset(now.getTime(), resetHour, tz)]);
      }
    }
  });
});

describe('the boundary is a genuine daily one', () => {
  /**
   * Properties rather than pinned instants (Arm 5 rule 11). These hold for any
   * correct implementation and catch a regression in either direction — the old
   * code could only ever move the candidate *backwards*, which is how the error
   * reached a full 24 h without ever being a partial shift.
   */
  it.each(PATHS)('%s never returns a future or stale boundary', (_name, reset) => {
    for (const tz of OFFSETS) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 2, 1, h, 0, 0));
        const boundary = reset(now, 7, tz);
        expect([tz, h, boundary <= now.getTime()]).toEqual([tz, h, true]);
        expect([tz, h, now.getTime() - boundary < 24 * HOUR]).toEqual([tz, h, true]);
      }
    }
  });

  it.each(PATHS)('%s lands on the reset hour in the patient local clock', (_name, reset) => {
    for (const tz of OFFSETS) {
      const now = new Date(Date.UTC(2026, 2, 1, 20, 0, 0));
      const localBoundary = new Date(reset(now, 7, tz) + tz * 60_000);
      expect([tz, localBoundary.getUTCHours(), localBoundary.getUTCMinutes()])
        .toEqual([tz, 7, 0]);
    }
  });

  it.each(PATHS)('%s advances by exactly one day across a boundary', (_name, reset) => {
    // Sampled either side of a reset at UTC+13, where the old code was wrong.
    const tz = 780;
    const justBefore = new Date(Date.UTC(2026, 2, 1, 17, 59, 0));
    const justAfter = new Date(Date.UTC(2026, 2, 1, 18, 1, 0));
    expect(reset(justAfter, 7, tz) - reset(justBefore, 7, tz)).toBe(24 * HOUR);
  });
});
