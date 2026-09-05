/**
 * Insulin timeline generator — the daily reset boundary.
 *
 * This suite exists for one defect. `generateInsulinTimelineData` computed its
 * daily reset with `setHours` / `getHours` and never read
 * `timezone_offset_minutes`, so a patient's day rolled over at their *phone's*
 * reset hour rather than their own (D13). Arm 1 §2.2 states that all
 * reset-time calculations use UTC Date methods and are immune to the device
 * timezone; that sentence was false here.
 *
 * The tests below are written so they hold in any timezone — a UTC CI runner
 * included — by deriving the expected boundary from `TimeManager`, which is the
 * single definition of that boundary (Arm 5 rule 16). A test that only passed
 * on the machine that wrote it would be no evidence at all for a timezone bug.
 *
 * There is deliberately no test that flips `process.env.TZ` between runs and
 * asserts the output is unchanged. Under jest that assignment does not reset
 * V8's cached timezone, so such a test passes against the *broken* code as
 * well — measured, not assumed. It would assert device-independence without
 * checking it. The two multi-offset tests below carry that weight instead:
 * both fail against the pre-fix implementation.
 *
 * Coverage here is deliberately narrow: the reset boundary and the cumulative
 * "bank balance" that depends on it. The rest of the module's insulin maths is
 * covered by the parity harness and by `cumulative-effects.test.ts`.
 */

import { generateInsulinTimelineData } from '../utils/insulin/timeline-generator';
import { getDailyResetTime as timeManagerReset } from '../utils/time/TimeManager';

/** 2026-03-01T12:00:00Z */
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const HOUR = 3_600_000;

const CONSTANTS = (tzOffsetMinutes: number) => ({
  correction_factor: 40,
  daily_reset_hour: 7,
  timezone_offset_minutes: tzOffsetMinutes,
}) as any;

function doseAt(atMs: number, units = 4, id = 'd1') {
  return {
    id,
    dose: units,
    medication: 'insulin_lispro',
    taken_at: new Date(atMs).toISOString(),
  } as any;
}

/** The cumulative effect at the point nearest `atMs`. */
function cumulativeAt(points: any[], atMs: number): number {
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.timestamp - atMs) < Math.abs(best.timestamp - atMs)) best = p;
  }
  return best.cumulativeInsulinEffect;
}

function timeline(doses: any[], from: number, to: number, tzOffset: number) {
  return generateInsulinTimelineData(doses, {
    timeScale: { start: from, end: to },
    patientConstants: CONSTANTS(tzOffset),
  });
}

describe('generateInsulinTimelineData — the daily reset boundary', () => {
  it('returns nothing for no doses, rather than an empty-shaped timeline', () => {
    expect(generateInsulinTimelineData([], { timeScale: { start: T0, end: T0 + HOUR } }))
      .toEqual([]);
  });

  it('accumulates a dose taken after the reset', () => {
    const reset = timeManagerReset(T0, 7, 0);
    const points = timeline([doseAt(reset + HOUR)], reset, reset + 12 * HOUR, 0);
    // Well past lispro's 4.5 h duration, the bank balance persists at -(dose x ISF)
    expect(cumulativeAt(points, reset + 10 * HOUR)).toBeCloseTo(-(4 * 40), 6);
  });

  it('drops a dose from before the reset', () => {
    const reset = timeManagerReset(T0, 7, 0);
    const points = timeline([doseAt(reset - HOUR)], reset, reset + 12 * HOUR, 0);
    expect(cumulativeAt(points, reset + 10 * HOUR)).toBe(0);
  });

  it('D13 FIXED: the boundary follows the patient’s timezone, not the device’s', () => {
    // The regression test proper. For each offset, a dose one hour *after* that
    // patient's reset must count and one hour *before* it must not — with the
    // boundary taken from TimeManager, so the assertion is independent of
    // whatever timezone this process happens to run in.
    //
    // Before the fix the boundary came from `setHours`, which resolves against
    // the device clock and ignores timezone_offset_minutes entirely, so these
    // offsets all collapsed onto the same instant.
    for (const tzOffset of [-720, -480, -300, 0, 120, 330, 345, 480, 540, 780]) {
      const reset = timeManagerReset(T0, 7, tzOffset);
      const evalAt = reset + 10 * HOUR;
      const window: [number, number] = [reset - 6 * HOUR, evalAt + HOUR];

      const after = timeline([doseAt(reset + HOUR)], window[0], window[1], tzOffset);
      const before = timeline([doseAt(reset - HOUR)], window[0], window[1], tzOffset);

      expect([tzOffset, cumulativeAt(after, evalAt)]).toEqual([tzOffset, -(4 * 40)]);
      expect([tzOffset, cumulativeAt(before, evalAt)]).toEqual([tzOffset, 0]);
    }
  });

  it('D13 FIXED: two patients an hour apart get boundaries an hour apart', () => {
    // A dose placed between the two patients' resets counts for exactly one of
    // them. This is the difference the old code could not represent at all.
    const east = 480;   // UTC+08:00 -> reset 2026-02-28T23:00Z
    const west = 420;   // UTC+07:00 -> reset 2026-03-01T00:00Z
    const eastReset = timeManagerReset(T0, 7, east);
    const westReset = timeManagerReset(T0, 7, west);
    expect(westReset - eastReset).toBe(HOUR);

    const between = doseAt(eastReset + HOUR / 2);
    const evalAt = westReset + 10 * HOUR;
    const window: [number, number] = [eastReset - 2 * HOUR, evalAt + HOUR];

    expect(cumulativeAt(timeline([between], window[0], window[1], east), evalAt))
      .toBeCloseTo(-(4 * 40), 6);
    expect(cumulativeAt(timeline([between], window[0], window[1], west), evalAt))
      .toBe(0);
  });

  it('defaults to a 07:00 UTC reset when the patient declares no offset', () => {
    const reset = timeManagerReset(T0, 7, 0);
    const points = generateInsulinTimelineData([doseAt(reset + HOUR)], {
      timeScale: { start: reset, end: reset + 12 * HOUR },
      patientConstants: { correction_factor: 40 } as any,
    });
    expect(cumulativeAt(points, reset + 10 * HOUR)).toBeCloseTo(-(4 * 40), 6);
  });

  it('honours a non-default reset hour', () => {
    const reset = timeManagerReset(T0, 3, 0);
    const points = generateInsulinTimelineData([doseAt(reset - HOUR)], {
      timeScale: { start: reset - 6 * HOUR, end: reset + 12 * HOUR },
      patientConstants: { correction_factor: 40, daily_reset_hour: 3, timezone_offset_minutes: 0 } as any,
    });
    expect(cumulativeAt(points, reset + 10 * HOUR)).toBe(0);
  });
});
