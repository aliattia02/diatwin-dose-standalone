/**
 * TimeManager — the mobile time axis.
 *
 * This module had no coverage, and the last five commits on the repository
 * were all timezone adjustments. That combination is the argument for these
 * tests: the code has been changed repeatedly under pressure, with nothing
 * pinning what "correct" means.
 *
 * Two properties matter more than any individual formatting helper:
 *
 *   - Parsing must be *total* over the shapes the backend actually sends,
 *     which include naive ISO strings, Z-suffixed strings, epoch millis and
 *     Date objects, and must map all of them to the same instant.
 *   - The daily reset boundary must land at the configured hour in the
 *     patient's own timezone, for every offset — that boundary decides which
 *     doses and meals count toward today's cumulative effects.
 *
 * Tests are written against UTC where the assertion would otherwise depend
 * on the machine's timezone; the ones that are intentionally local-dependent
 * say so.
 */

import {
  addHours,
  calculateHoursSince,
  calculateMinutesSince,
  durationToHours,
  getDailyResetTime,
  hoursToTimeString,
  isTimeInRange,
  isValidTimestamp,
  isWithinCurrentDay,
  normalize,
  normalizeToHourBoundary,
  normalizeToMinuteBoundary,
  normalizeToSecondBoundary,
  parseTimestamp,
  precision,
} from '../utils/time/TimeManager';

/** 2026-03-01T12:00:00Z */
const T0_MS = Date.UTC(2026, 2, 1, 12, 0, 0, 0);
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('parseTimestamp', () => {
  it('maps every shape the backend sends to the same instant', () => {
    const shapes: Array<[string, unknown]> = [
      ['epoch millis', T0_MS],
      ['Date object', new Date(T0_MS)],
      ['ISO with Z', '2026-03-01T12:00:00Z'],
      ['ISO with offset', '2026-03-01T12:00:00+00:00'],
      ['ISO with millis', '2026-03-01T12:00:00.000Z'],
    ];

    for (const [label, input] of shapes) {
      expect([label, parseTimestamp(input as any)]).toEqual([label, T0_MS]);
    }
  });

  it('is total over null-ish input rather than throwing', () => {
    // A single unparseable row must not take down a whole chart render.
    for (const bad of [null, undefined, '', 'not a date', NaN]) {
      expect(() => parseTimestamp(bad as any)).not.toThrow();
    }
  });

  it('round-trips through normalize without drifting', () => {
    const parsed = parseTimestamp('2026-03-01T12:00:00Z');
    expect(normalize(parsed, precision.SECOND)).toBe(parsed);
  });
});

describe('isValidTimestamp', () => {
  it('accepts real timestamps', () => {
    expect(isValidTimestamp(T0_MS)).toBe(true);
    expect(isValidTimestamp(new Date(T0_MS))).toBe(true);
  });

  it('rejects the values that reach it from bad rows', () => {
    expect(isValidTimestamp(null)).toBe(false);
    expect(isValidTimestamp(undefined)).toBe(false);
    expect(isValidTimestamp('nonsense')).toBe(false);
    expect(isValidTimestamp(NaN)).toBe(false);
  });
});

describe('normalization boundaries', () => {
  const withOddParts = Date.UTC(2026, 2, 1, 12, 34, 56, 789);

  it('truncates to the second', () => {
    expect(normalizeToSecondBoundary(withOddParts))
      .toBe(Date.UTC(2026, 2, 1, 12, 34, 56, 0));
  });

  it('truncates to the minute', () => {
    expect(normalizeToMinuteBoundary(withOddParts))
      .toBe(Date.UTC(2026, 2, 1, 12, 34, 0, 0));
  });

  it('truncates to the hour', () => {
    expect(normalizeToHourBoundary(withOddParts))
      .toBe(Date.UTC(2026, 2, 1, 12, 0, 0, 0));
  });

  it('never rounds up — normalization must not move an event into the future', () => {
    for (const level of [precision.SECOND, precision.MINUTE, precision.HOUR]) {
      expect(normalize(withOddParts, level)).toBeLessThanOrEqual(withOddParts);
    }
  });

  it('is idempotent', () => {
    for (const level of [precision.SECOND, precision.MINUTE, precision.HOUR]) {
      const once = normalize(withOddParts, level);
      expect(normalize(once, level)).toBe(once);
    }
  });
});

describe('elapsed time', () => {
  it('measures hours since an earlier event', () => {
    expect(calculateHoursSince(T0_MS + 2 * HOUR, T0_MS)).toBeCloseTo(2, 6);
  });

  it('measures minutes since an earlier event', () => {
    expect(calculateMinutesSince(T0_MS + 90 * MINUTE, T0_MS)).toBeCloseTo(90, 6);
  });

  it('is zero for simultaneous events', () => {
    expect(calculateHoursSince(T0_MS, T0_MS)).toBe(0);
  });

  it('goes negative for an event in the future', () => {
    // Callers depend on the sign to decide whether a dose has been given
    // yet. Clamping here would silently make future doses look active.
    expect(calculateHoursSince(T0_MS, T0_MS + HOUR)).toBeLessThan(0);
  });

  it('handles fractional hours precisely', () => {
    expect(calculateHoursSince(T0_MS + 30 * MINUTE, T0_MS)).toBeCloseTo(0.5, 6);
  });
});

describe('addHours', () => {
  it('adds whole and fractional hours', () => {
    expect(addHours(T0_MS, 3).getTime()).toBe(T0_MS + 3 * HOUR);
    expect(addHours(T0_MS, 0.5).getTime()).toBe(T0_MS + 30 * MINUTE);
  });

  it('subtracts on a negative argument', () => {
    expect(addHours(T0_MS, -2).getTime()).toBe(T0_MS - 2 * HOUR);
  });
});

describe('duration helpers', () => {
  it('parses HH:MM strings, the legacy activity duration format', () => {
    expect(durationToHours('1:30')).toBeCloseTo(1.5, 6);
    expect(durationToHours('0:45')).toBeCloseTo(0.75, 6);
    expect(durationToHours('2:00')).toBeCloseTo(2, 6);
  });

  it('passes numeric hours through', () => {
    expect(durationToHours(1.5)).toBeCloseTo(1.5, 6);
  });

  it('formats hours back to a zero-padded duration string', () => {
    // Note the convention: output is padded ("01:30"), input need not be
    // ("1:30" parses). Worth pinning because the two are not string-identical.
    expect(hoursToTimeString(1.5)).toBe('01:30');
    expect(hoursToTimeString(0.25)).toBe('00:15');
  });

  it('round-trips through hours without losing the value', () => {
    // Asserted on the numeric value, since formatting pads and parsing does
    // not — the invariant that matters is that no time is lost.
    for (const value of ['0:15', '1:30', '2:45', '12:00']) {
      const hours = durationToHours(value);
      expect(durationToHours(hoursToTimeString(hours))).toBeCloseTo(hours, 6);
    }
  });
});

describe('isTimeInRange', () => {
  const start = T0_MS;
  const end = T0_MS + 4 * HOUR;

  it('includes points inside the window', () => {
    expect(isTimeInRange(T0_MS + 2 * HOUR, start, end)).toBe(true);
  });

  it('excludes points outside it', () => {
    expect(isTimeInRange(T0_MS - HOUR, start, end)).toBe(false);
    expect(isTimeInRange(T0_MS + 5 * HOUR, start, end)).toBe(false);
  });

  it('includes both endpoints', () => {
    expect(isTimeInRange(start, start, end)).toBe(true);
    expect(isTimeInRange(end, start, end)).toBe(true);
  });

  it('is false for a null timestamp rather than throwing', () => {
    expect(isTimeInRange(null, start, end)).toBe(false);
  });
});

/**
 * The daily reset decides which meals and doses count toward today's
 * cumulative effects. Getting it wrong by an hour moves a bolus in or out of
 * the running total, which changes the displayed IOB and every downstream
 * suggestion. It has to hold for every timezone offset a patient can have,
 * including the half-hour and three-quarter-hour ones.
 */
describe('daily reset boundary', () => {
  const RESET_HOUR = 7;

  const OFFSETS = [
    ['UTC', 0],
    ['Berlin (winter)', 60],
    ['Berlin (summer)', 120],
    ['Cairo', 120],
    ['India (half hour)', 330],
    ['Nepal (three quarters)', 345],
    ['New York', -300],
    ['Los Angeles', -480],
    ['Chatham Islands', 765],
  ] as const;

  it.each(OFFSETS)('lands at 07:00 local for %s', (_label, offsetMinutes) => {
    const reset = getDailyResetTime(T0_MS, RESET_HOUR, offsetMinutes as number);
    const resetMs = reset instanceof Date ? reset.getTime() : (reset as number);

    const localMinutes =
      (new Date(resetMs).getUTCHours() * 60 +
        new Date(resetMs).getUTCMinutes() +
        (offsetMinutes as number) +
        1440 * 3) %
      1440;

    expect(localMinutes / 60).toBeCloseTo(RESET_HOUR, 5);
  });

  it('never returns a reset in the future', () => {
    for (const [, offsetMinutes] of OFFSETS) {
      const reset = getDailyResetTime(T0_MS, RESET_HOUR, offsetMinutes as number);
      const resetMs = reset instanceof Date ? reset.getTime() : (reset as number);
      expect(resetMs).toBeLessThanOrEqual(T0_MS);
    }
  });

  it('is within the previous 24 hours', () => {
    for (const [, offsetMinutes] of OFFSETS) {
      const reset = getDailyResetTime(T0_MS, RESET_HOUR, offsetMinutes as number);
      const resetMs = reset instanceof Date ? reset.getTime() : (reset as number);
      expect(T0_MS - resetMs).toBeLessThan(24 * HOUR + 1000);
    }
  });
});

describe('isWithinCurrentDay', () => {
  const RESET_HOUR = 7;

  it('includes an event after the most recent reset', () => {
    const afterReset = Date.UTC(2026, 2, 1, 8, 0);
    expect(isWithinCurrentDay(afterReset, T0_MS, RESET_HOUR, 0)).toBe(true);
  });

  it('excludes an event from before it', () => {
    const beforeReset = Date.UTC(2026, 2, 1, 6, 0);
    expect(isWithinCurrentDay(beforeReset, T0_MS, RESET_HOUR, 0)).toBe(false);
  });

  it('excludes yesterday entirely', () => {
    const yesterday = T0_MS - 24 * HOUR;
    expect(isWithinCurrentDay(yesterday, T0_MS, RESET_HOUR, 0)).toBe(false);
  });

  it('agrees with the reset boundary it is derived from', () => {
    // Anything at or after getDailyResetTime must be "within the day", and
    // anything a minute before it must not. These two functions disagreeing
    // is exactly the class of bug the timezone commits were chasing.
    for (const offset of [0, 120, 330, -300]) {
      const reset = getDailyResetTime(T0_MS, RESET_HOUR, offset);
      const resetMs = reset instanceof Date ? reset.getTime() : (reset as number);

      expect(isWithinCurrentDay(resetMs + MINUTE, T0_MS, RESET_HOUR, offset)).toBe(true);
      expect(isWithinCurrentDay(resetMs - MINUTE, T0_MS, RESET_HOUR, offset)).toBe(false);
    }
  });
});
