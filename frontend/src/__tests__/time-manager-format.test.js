/**
 * `formatDate` now delegates to `formatDateInZone`, so the first thing to prove
 * is that nothing changed for existing callers.
 *
 * The new method exists because every display formatter in the frontend read
 * the browser's wall clock. That is right for a patient reading their own data
 * and wrong for a clinician reading someone else's — the display-side
 * counterpart of D24, where a doctor in London sees an Auckland patient's
 * breakfast stamped 20:00 the previous day.
 *
 * The equivalence tests below matter more than the new behaviour: a refactor
 * that quietly shifts every timestamp in the app by an hour would look fine in
 * a screenshot.
 */

import TimeManager from '../utils/TimeManager';

const F = TimeManager.formats;
const MINUTE = 60_000;

/** Instants spread across the year so DST transitions in the host zone are
 *  crossed rather than avoided. */
const INSTANTS = [
  Date.UTC(2026, 0, 15, 3, 7, 9),
  Date.UTC(2026, 2, 29, 1, 30, 0),   // around European DST start
  Date.UTC(2026, 5, 21, 12, 0, 0),
  Date.UTC(2026, 9, 25, 1, 30, 0),   // around European DST end
  Date.UTC(2026, 11, 31, 23, 59, 59),
];

const FORMATS = [
  F.DATE, F.TIME, F.DATETIME, F.DATETIME_DISPLAY, F.DATETIME_FULL,
  F.DATETIME_ISO, F.DATETIME_ISO_SECONDS, F.CHART_TICKS_SHORT,
  F.CHART_TICKS_MEDIUM, F.CHART_TICKS_LONG, F.SYSTEM_TIME,
];

describe('formatDate is unchanged by the delegation', () => {
  it('matches a local-getter reference implementation for every format', () => {
    // The reference is the exact code formatDate used before delegating. If the
    // shift-and-read-UTC approach differs anywhere — DST included — this fails.
    const reference = (date, format) => {
      const d = new Date(date);
      return format
        .replace('YYYY', d.getFullYear())
        .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
        .replace('DD', String(d.getDate()).padStart(2, '0'))
        .replace('HH', String(d.getHours()).padStart(2, '0'))
        .replace('mm', String(d.getMinutes()).padStart(2, '0'))
        .replace('ss', String(d.getSeconds()).padStart(2, '0'))
        .replace('M', (d.getMonth() + 1).toString())
        .replace('D', d.getDate().toString());
    };

    for (const t of INSTANTS) {
      for (const format of FORMATS) {
        expect([t, format, TimeManager.formatDate(t, format)])
          .toEqual([t, format, reference(t, format)]);
      }
    }
  });

  it('still returns empty string for falsy and invalid input', () => {
    expect(TimeManager.formatDate(null, F.DATE)).toBe('');
    expect(TimeManager.formatDate(undefined, F.DATE)).toBe('');
    expect(TimeManager.formatDate('not a date', F.DATE)).toBe('');
  });

  it('still defaults the format when none is given', () => {
    const t = Date.UTC(2026, 5, 21, 12, 0, 0);
    expect(TimeManager.formatDate(t)).toBe(
      TimeManager.formatDate(t, F.DATETIME_DISPLAY));
  });
});

describe('formatDateInZone renders in the offset it is given', () => {
  it('shows the patient local wall clock, not the browser one', () => {
    // 2026-03-01T20:00Z is 09:00 on 2 March at UTC+13.
    const t = Date.UTC(2026, 2, 1, 20, 0, 0);
    expect(TimeManager.formatDateInZone(t, F.DATETIME, 780)).toBe('2026-03-02 09:00');
    expect(TimeManager.formatDateInZone(t, F.DATETIME, -300)).toBe('2026-03-01 15:00');
    expect(TimeManager.formatDateInZone(t, F.DATETIME, 0)).toBe('2026-03-01 20:00');
  });

  it('handles the half-hour and quarter-hour offsets that exist in practice', () => {
    const t = Date.UTC(2026, 2, 1, 20, 0, 0);
    expect(TimeManager.formatDateInZone(t, F.TIME, 330)).toBe('01:30');  // UTC+05:30
    expect(TimeManager.formatDateInZone(t, F.TIME, 345)).toBe('01:45');  // UTC+05:45
    expect(TimeManager.formatDateInZone(t, F.TIME, -210)).toBe('16:30'); // UTC-03:30
  });

  it('rolls the calendar date when the offset crosses midnight', () => {
    // The failure this guards: formatting the time in the patient's zone but
    // leaving the date in the browser's, which reads as plausible and is wrong.
    const t = Date.UTC(2026, 2, 1, 23, 30, 0);
    expect(TimeManager.formatDateInZone(t, F.DATETIME, 60)).toBe('2026-03-02 00:30');
    expect(TimeManager.formatDateInZone(t, F.DATETIME, -60)).toBe('2026-03-01 22:30');
  });

  it('null offset means the browser, matching formatDate exactly', () => {
    for (const t of INSTANTS) {
      expect([t, TimeManager.formatDateInZone(t, F.DATETIME, null)])
        .toEqual([t, TimeManager.formatDate(t, F.DATETIME)]);
    }
  });

  it('an offset of 0 is honoured and is not mistaken for absent', () => {
    // The bug this pins: `tzOffsetMinutes || browserOffset` would send UTC
    // patients to the browser's zone, and UTC+00:00 is a real offset.
    const t = Date.UTC(2026, 5, 21, 12, 0, 0);
    expect(TimeManager.formatDateInZone(t, F.DATETIME, 0)).toBe('2026-06-21 12:00');
  });

  it('formats consistently with the reset boundary it will sit beside', () => {
    // A rendered timestamp and the daily reset must agree about the patient's
    // day, otherwise a meal can appear before a boundary it is actually after.
    for (const tz of [-300, 0, 330, 780]) {
      const boundary = TimeManager.getDailyResetTime(
        Date.UTC(2026, 2, 1, 20, 0, 0), 7, tz);
      expect([tz, TimeManager.formatDateInZone(boundary, F.TIME, tz)])
        .toEqual([tz, '07:00']);
    }
  });

  it('is stable one millisecond either side of a minute boundary', () => {
    const t = Date.UTC(2026, 5, 21, 12, 0, 0);
    expect(TimeManager.formatDateInZone(t - 1, F.DATETIME_FULL, 0))
      .toBe('2026-06-21 11:59:59');
    expect(TimeManager.formatDateInZone(t + MINUTE, F.DATETIME_FULL, 0))
      .toBe('2026-06-21 12:01:00');
  });
});
