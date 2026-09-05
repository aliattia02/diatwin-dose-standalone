/**
 * Activity pharmacodynamics — the Dalla Man / Breton Y-Z-W exercise model.
 *
 * 733 lines with no coverage. A TypeScript port of
 * `backend/utils/activity_pharmacodynamics.py`, so exact cross-language values
 * belong to the parity harness (`diatwin/verify/parity.py`, case families
 * `activity_effect` and `activity_aob`), not to this file. What belongs here
 * are the properties, and the two places where the model's behaviour is not
 * what its own inputs suggest:
 *
 *   - Sign discipline. `bg_direction` is the only thing that decides whether an
 *     effect lowers or raises BG; every magnitude in the module is unsigned.
 *   - Saturation. The acute effect grows while the session runs, then settles;
 *     it never runs away, and it is bounded by duration × acute_rate_per_min.
 *   - AOB conservation: absorbed_fraction and remaining_bg_drop describe the
 *     same session, and remaining reaches zero.
 *   - The reset guard admits today's sessions and nothing older — and, unlike
 *     the other two modules audited in this pass, this one gets the timezone
 *     arithmetic right. That agreement is asserted against TimeManager.
 *
 * The headline finding is pinned below: the acute BG drop does not depend on
 * intensity at all. Z is a binary gate, so a light 45-minute walk and a
 * vigorous 45-minute interval session produce the identical number. Intensity
 * reaches the model only through W, i.e. only through the sensitivity
 * multiplier. Shared with the Python implementation — a property of the model,
 * not of this port.
 */

import {
  applyActivitySensitivity,
  calculateActivityCumulativeEffect,
  calculateActivitySensitivityMultiplier,
  calculateStackedActivityEffect,
  getActivityOnBoard,
  normalizeActivityRecord,
  parseDt,
  HR_MODEL,
  INTENSITY_HR_FRACTION,
  LEVEL_TO_INTENSITY,
  type NormalizedActivity,
} from '../utils/activity/activity-pharmacodynamics';
import { getDailyResetTime as timeManagerReset } from '../utils/time/TimeManager';

/** 2026-03-01T12:00:00Z */
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const MIN = 60_000;

const PC: any = {
  hr_base: 70,
  hr_max: 190,
  weight_kg: 70,
  daily_reset_hour: 7,
  timezone_offset_minutes: 0,
};

function session(
  overrides: Partial<NormalizedActivity> = {},
): NormalizedActivity {
  return {
    _id: 'act-1',
    timestamp: T0,
    duration_minutes: 45,
    intensity: 'moderate',
    bg_direction: -1,
    ...overrides,
  } as NormalizedActivity;
}

/** Minutes after T0, as a Date. */
const at = (minutes: number) => new Date(T0 + minutes * MIN);

describe('parseDt', () => {
  it('maps every shape the backend sends to the same instant', () => {
    const shapes: Array<[string, any]> = [
      ['epoch millis', T0],
      ['Date object', new Date(T0)],
      ['ISO with Z', '2026-03-01T12:00:00Z'],
      ['ISO with offset', '2026-03-01T12:00:00+00:00'],
      ['bare ISO (Z appended)', '2026-03-01T12:00:00'],
      ['bare ISO with millis', '2026-03-01T12:00:00.000'],
    ];
    for (const [label, input] of shapes) {
      expect([label, parseDt(input)]).toEqual([label, T0]);
    }
  });

  it('treats a bare ISO string as UTC, not as device-local time', () => {
    // This is the whole reason parseDt exists rather than `new Date(s)`. The
    // assertion is written against the device's own offset so it holds in any
    // timezone, including a UTC CI runner.
    const bare = '2026-03-01T12:00:00';
    expect(parseDt(bare)).toBe(Date.UTC(2026, 2, 1, 12, 0, 0));
    if (new Date(bare).getTimezoneOffset() !== 0) {
      expect(parseDt(bare)).not.toBe(new Date(bare).getTime());
    }
  });

  it('returns null for unparseable input rather than the current time', () => {
    // Arm 5 rule 5: a bad row silently becoming the newest record on a
    // timeline is worse than dropping it.
    for (const bad of [null, undefined, '', 'not a date', new Date(NaN), {}, []]) {
      expect([bad, parseDt(bad as any)]).toEqual([bad, null]);
    }
  });

  it('accepts epoch 0 rather than rejecting it as falsy', () => {
    expect(parseDt(0)).toBe(0);
  });
});

describe('normalizeActivityRecord', () => {
  it('maps every legacy level, and drops the sedentary ones', () => {
    // LEVEL_TO_INTENSITY is the contract; the record is dropped wherever it
    // maps to null, so callers never have to filter sedentary rows themselves.
    for (const [level, expected] of Object.entries(LEVEL_TO_INTENSITY)) {
      const r = normalizeActivityRecord({ level, startTime: '2026-03-01T12:00:00' });
      expect([level, r === null ? null : r.intensity]).toEqual([level, expected]);
    }
  });

  it('drops a level that is not in the map at all', () => {
    for (const level of [3, 99, -7]) {
      expect([level, normalizeActivityRecord({ level, startTime: '2026-03-01T12:00:00' })])
        .toEqual([level, null]);
    }
  });

  it('prefers an explicit intensity string over the legacy level', () => {
    const r = normalizeActivityRecord({
      intensity: 'vigorous', level: 0, startTime: '2026-03-01T12:00:00',
    });
    expect(r!.intensity).toBe('vigorous');
  });

  it('falls back to the level when the intensity string is not a known tier', () => {
    const r = normalizeActivityRecord({
      intensity: 'extreme', level: 1, startTime: '2026-03-01T12:00:00',
    });
    expect(r!.intensity).toBe('moderate');
  });

  it('resolves the start time through startTime, completedTime, then timestamp', () => {
    const a = normalizeActivityRecord({
      level: 1, startTime: '2026-03-01T12:00:00',
      completedTime: '2026-03-01T18:00:00', timestamp: '2026-03-01T20:00:00',
    });
    const b = normalizeActivityRecord({
      level: 1, completedTime: '2026-03-01T18:00:00', timestamp: '2026-03-01T20:00:00',
    });
    const c = normalizeActivityRecord({ level: 1, timestamp: '2026-03-01T20:00:00' });
    expect(a!.timestamp).toBe(T0);
    expect(b!.timestamp).toBe(Date.UTC(2026, 2, 1, 18, 0, 0));
    expect(c!.timestamp).toBe(Date.UTC(2026, 2, 1, 20, 0, 0));
  });

  it('drops a record with no usable start time', () => {
    expect(normalizeActivityRecord({ level: 1 })).toBeNull();
    expect(normalizeActivityRecord({ level: 1, startTime: 'garbage' })).toBeNull();
    expect(normalizeActivityRecord(null as any)).toBeNull();
  });

  it('resolves duration through duration_minutes, then endTime, then HH:MM', () => {
    const base = { level: 1, startTime: '2026-03-01T12:00:00' };
    expect(normalizeActivityRecord({ ...base, duration_minutes: 90 })!.duration_minutes).toBe(90);
    expect(normalizeActivityRecord({ ...base, endTime: '2026-03-01T13:30:00' })!.duration_minutes).toBe(90);
    expect(normalizeActivityRecord({ ...base, duration: '01:30' })!.duration_minutes).toBe(90);
    expect(normalizeActivityRecord({ ...base, duration: '2' })!.duration_minutes).toBe(120);
    expect(normalizeActivityRecord(base)!.duration_minutes).toBe(30);   // documented default
  });

  it('ignores an endTime that is not after the start, and falls back', () => {
    const r = normalizeActivityRecord({
      level: 1, startTime: '2026-03-01T12:00:00',
      endTime: '2026-03-01T11:00:00', duration: '00:20',
    });
    expect(r!.duration_minutes).toBe(20);
  });

  it('floors duration at one minute, never zero or negative', () => {
    for (const d of [0, -5, 0.2]) {
      const r = normalizeActivityRecord({
        level: 1, startTime: '2026-03-01T12:00:00', duration_minutes: d,
      });
      expect([d, r!.duration_minutes >= 1]).toEqual([d, true]);
    }
  });

  it('carries the wearable fields through only when they are present', () => {
    const bare = normalizeActivityRecord({ level: 1, startTime: '2026-03-01T12:00:00' })!;
    expect('hr_trace' in bare).toBe(false);
    expect('bg_drop_override' in bare).toBe(false);

    const rich = normalizeActivityRecord({
      level: 1, startTime: '2026-03-01T12:00:00',
      hr_trace: [{ t_min: 0, hr_bpm: 70 }], hr_base: 55, hr_max: 200, bg_drop_override: 30,
    })!;
    expect([rich.hr_base, rich.hr_max, rich.bg_drop_override]).toEqual([55, 200, 30]);
    expect(rich.hr_trace).toHaveLength(1);
  });

  it('defaults bg_direction to BG-lowering', () => {
    expect(normalizeActivityRecord({ level: 1, startTime: '2026-03-01T12:00:00' })!.bg_direction).toBe(-1);
    expect(normalizeActivityRecord({ level: 1, startTime: '2026-03-01T12:00:00', bg_direction: 1 })!.bg_direction).toBe(1);
  });
});

describe('calculateActivityCumulativeEffect — sign, growth and saturation', () => {
  it('is zero at the session start and for a session in the future', () => {
    // A zero magnitude signed by bg_direction = -1 comes back as -0. It renders
    // and serialises as 0, so this is noted rather than treated as a defect.
    expect(calculateActivityCumulativeEffect(session(), PC, at(0))).toBeCloseTo(0, 12);
    expect(calculateActivityCumulativeEffect(session(), PC, at(-30))).toBe(0);
  });

  it('lowers BG by default and raises it only when bg_direction says so', () => {
    const down = calculateActivityCumulativeEffect(session({ bg_direction: -1 }), PC, at(240));
    const up = calculateActivityCumulativeEffect(session({ bg_direction: 1 }), PC, at(240));
    expect(down).toBeLessThan(0);
    expect(up).toBeGreaterThan(0);
    expect(up).toBe(-down);   // the magnitude is unsigned; only the sign differs
  });

  it('grows monotonically in magnitude and then settles', () => {
    let prev = 0;
    for (const m of [5, 15, 30, 45, 60, 85, 120, 240, 600]) {
      const magnitude = Math.abs(calculateActivityCumulativeEffect(session(), PC, at(m)));
      expect([m, magnitude >= prev]).toEqual([m, true]);
      prev = magnitude;
    }
    // Settled: the scan window is duration + 4·tau_Z, so nothing changes after.
    const settleAt = 45 + 4 * HR_MODEL.tau_Z;
    expect(calculateActivityCumulativeEffect(session(), PC, at(settleAt + 1)))
      .toBe(calculateActivityCumulativeEffect(session(), PC, at(10_000)));
  });

  it('is bounded by duration + tail times the acute rate', () => {
    // Z is clamped to 1, so the integral cannot exceed the scan window times
    // acute_rate_per_min. This is the guarantee that a long session cannot
    // produce an unbounded predicted drop.
    for (const duration of [5, 30, 45, 120, 480]) {
      const window = duration + 4 * HR_MODEL.tau_Z;
      const magnitude = Math.abs(calculateActivityCumulativeEffect(
        session({ duration_minutes: duration }), PC, at(10_000)));
      expect([duration, magnitude <= window * HR_MODEL.acute_rate_per_min])
        .toEqual([duration, true]);
      expect([duration, magnitude > 0]).toEqual([duration, true]);
    }
  });

  it('grows with session duration', () => {
    const magnitudes = [10, 30, 60, 120].map(d =>
      Math.abs(calculateActivityCumulativeEffect(session({ duration_minutes: d }), PC, at(10_000))));
    for (let i = 1; i < magnitudes.length; i++) {
      expect([i, magnitudes[i] > magnitudes[i - 1]]).toEqual([i, true]);
    }
  });

  it('applies allometric weight scaling in the documented direction', () => {
    // drop x (70 / weight)^0.25 — a heavier patient gets a smaller per-kg drop.
    const light = Math.abs(calculateActivityCumulativeEffect(session(), { ...PC, weight_kg: 50 }, at(240)));
    const ref = Math.abs(calculateActivityCumulativeEffect(session(), { ...PC, weight_kg: 70 }, at(240)));
    const heavy = Math.abs(calculateActivityCumulativeEffect(session(), { ...PC, weight_kg: 100 }, at(240)));
    expect(light).toBeGreaterThan(ref);
    expect(ref).toBeGreaterThan(heavy);
    expect(light / ref).toBeCloseTo(Math.pow(70 / 50, 0.25), 2);
  });

  it('leaves the result unscaled when no weight is recorded', () => {
    const noWeight = calculateActivityCumulativeEffect(session(), { hr_base: 70, hr_max: 190 } as any, at(240));
    const atSeventy = calculateActivityCumulativeEffect(session(), { ...PC, weight_kg: 70 }, at(240));
    expect(noWeight).toBe(atSeventy);
    for (const bad of [0, null, undefined]) {
      expect([bad, calculateActivityCumulativeEffect(session(), { ...PC, weight_kg: bad } as any, at(240))])
        .toEqual([bad, noWeight]);
    }
  });

  it('PINS: the acute effect does not depend on intensity', () => {
    // MEASURED. light, moderate and vigorous produce byte-identical numbers at
    // every elapsed time. The cause is in the model, not the port: Z obeys
    // dZ/dt = (1 - Z) while in-exercise, so with dt = 1 min it saturates to 1
    // in a single step for any intensity that clears the onset gate, and the
    // acute integral is Z x acute_rate_per_min. Intensity only changes the peak
    // HR, which feeds Y and W — so it reaches the sensitivity multiplier and
    // nothing else.
    //
    // `docs/documentation/activity-pd-implementation.md` describes the gate
    // ("Z is not a smooth curve — it saturates to 1 within approximately one
    // integration step") but never states this consequence, and lists intensity
    // fractions in a way that implies the acute drop scales with effort. It
    // does not.
    //
    // Identical in backend/utils/activity_pharmacodynamics.py, so the parity
    // harness agrees; this is a model property to decide about, not a port bug.
    for (const m of [5, 15, 30, 45, 60, 120, 240]) {
      const byTier = (['light', 'moderate', 'vigorous'] as const).map(intensity =>
        calculateActivityCumulativeEffect(session({ intensity }), PC, at(m)));
      expect([m, byTier[1], byTier[2]]).toEqual([m, byTier[0], byTier[0]]);
    }
  });

  it('produces no effect at all when the session never clears the onset gate', () => {
    // The counterpart to the pin above: intensity is not *ignored*, it is a
    // step function. A patient whose HR reserve is too small for the tier's
    // fraction to lift Y past a x hr_base gets Z = 0 and no acute effect.
    const noReserve = { hr_base: 100, hr_max: 104, weight_kg: 70 };
    expect(calculateActivityCumulativeEffect(session({ intensity: 'light' }), noReserve as any, at(240))).toBeCloseTo(0, 12);
    // Widen the reserve and the effect appears.
    expect(Math.abs(calculateActivityCumulativeEffect(
      session({ intensity: 'light' }), { hr_base: 100, hr_max: 200, weight_kg: 70 } as any, at(240))))
      .toBeGreaterThan(0);
  });

  it('uses a wearable trace in preference to the synthetic one', () => {
    const flat: NormalizedActivity = session({
      hr_trace: [{ t_min: 0, hr_bpm: 70 }, { t_min: 45, hr_bpm: 70 }],
    });
    // A trace that never rises above resting cannot open the gate.
    expect(calculateActivityCumulativeEffect(flat, PC, at(240))).toBeCloseTo(0, 12);
    // while the synthetic trace for the same record does.
    expect(calculateActivityCumulativeEffect(session(), PC, at(240))).toBeLessThan(0);
  });

  it('takes the linear CGM-override path instead of the ODE when one is recorded', () => {
    // bg_drop_override is a measured drop; it must be delivered linearly over
    // duration + a 40 % tail and must not be re-derived from heart rate.
    const measured = session({ bg_drop_override: 50, duration_minutes: 60 });
    const full = 60 * 1.4;
    expect(calculateActivityCumulativeEffect(measured, PC, at(0))).toBeCloseTo(0, 12);
    expect(calculateActivityCumulativeEffect(measured, PC, at(full / 2))).toBeCloseTo(-25, 6);
    expect(calculateActivityCumulativeEffect(measured, PC, at(full))).toBeCloseTo(-50, 6);
    // and it saturates rather than overshooting
    expect(calculateActivityCumulativeEffect(measured, PC, at(full * 10))).toBeCloseTo(-50, 6);
    // the sign still comes from bg_direction alone
    expect(calculateActivityCumulativeEffect(
      session({ bg_drop_override: 50, duration_minutes: 60, bg_direction: 1 }), PC, at(full)))
      .toBeCloseTo(50, 6);
  });
});

describe('getActivityOnBoard', () => {
  it('starts fully unabsorbed and ends fully absorbed', () => {
    const start = getActivityOnBoard(session(), PC, at(0));
    expect(start.sessions[0].absorbed_fraction).toBe(0);
    expect(start.sessions[0].remaining_bg_drop).toBeGreaterThan(0);

    const end = getActivityOnBoard(session(), PC, at(10_000));
    expect(end.sessions[0].absorbed_fraction).toBe(1);
    expect(end.sessions[0].remaining_bg_drop).toBe(0);
    expect(end.total_aob).toBe(0);
  });

  it('absorbed_fraction is non-decreasing and stays within [0, 1]', () => {
    let prev = -1;
    for (let m = 0; m <= 200; m += 5) {
      const f = getActivityOnBoard(session(), PC, at(m)).sessions[0].absorbed_fraction;
      expect([m, f >= 0 && f <= 1]).toEqual([m, true]);
      expect([m, f >= prev]).toEqual([m, true]);
      prev = f;
    }
  });

  it('reports remaining as the unabsorbed share of the session total', () => {
    const total = Math.abs(calculateActivityCumulativeEffect(session(), PC, at(10_000)));
    for (const m of [10, 30, 60, 90]) {
      const s = getActivityOnBoard(session(), PC, at(m)).sessions[0];
      expect([m, s.remaining_bg_drop])
        .toEqual([m, Math.round(total * (1 - s.absorbed_fraction) * 10) / 10]);
    }
  });

  it('is unsigned regardless of bg_direction', () => {
    // AOB is a magnitude; the sign lives on cumulative_activity_effect.
    const down = getActivityOnBoard(session({ bg_direction: -1 }), PC, at(20));
    const up = getActivityOnBoard(session({ bg_direction: 1 }), PC, at(20));
    expect(up.total_aob).toBe(down.total_aob);
    expect(up.total_aob).toBeGreaterThan(0);
  });

  it('is unsigned on the CGM-override path too, even for a negative override', () => {
    const negative = session({ bg_drop_override: -40, duration_minutes: 60 });
    const s = getActivityOnBoard(negative, PC, at(0)).sessions[0];
    expect(s.remaining_bg_drop).toBe(40);
  });

  it('marks a session active only while it is running', () => {
    expect(getActivityOnBoard(session(), PC, at(44)).sessions[0].is_active).toBe(true);
    expect(getActivityOnBoard(session(), PC, at(45)).sessions[0].is_active).toBe(false);
    expect(getActivityOnBoard(session(), PC, at(46)).sessions[0].is_active).toBe(false);
  });

  it('sums across sessions and keeps them individually addressable', () => {
    const two = [session({ _id: 'a' }), session({ _id: 'b', timestamp: T0 + 30 * MIN })];
    const r = getActivityOnBoard(two, PC, at(40));
    expect(r.sessions.map(s => s.activity_id)).toEqual(['a', 'b']);
    expect(r.total_aob).toBeCloseTo(
      Math.round((r.sessions[0].remaining_bg_drop + r.sessions[1].remaining_bg_drop) * 10) / 10, 6);
  });

  it('returns a zeroed session rather than throwing for a record with no start', () => {
    const s = getActivityOnBoard({ ...session(), timestamp: 0 } as any, PC, at(60)).sessions[0];
    expect([s.remaining_bg_drop, s.absorbed_fraction, s.is_active]).toEqual([0, 0, false]);
  });

  it('never reports negative absorption for a session in the future', () => {
    const s = getActivityOnBoard(session(), PC, at(-60)).sessions[0];
    expect(s.absorbed_fraction).toBe(0);
    expect(s.remaining_bg_drop).toBeGreaterThanOrEqual(0);
  });
});

describe('calculateActivitySensitivityMultiplier', () => {
  it('is exactly 1.0 with no sessions, and never drops below 1.0', () => {
    expect(calculateActivitySensitivityMultiplier([], PC, at(60))).toBe(1.0);
    for (const m of [0, 1, 5, 30, 60, 120, 300, 470]) {
      expect([m, calculateActivitySensitivityMultiplier([session()], PC, at(m)) >= 1.0])
        .toEqual([m, true]);
    }
  });

  it('is capped at 1 + max_sensitivity_boost however long the session runs', () => {
    const cap = 1 + HR_MODEL.max_sensitivity_boost;
    for (const duration of [45, 120, 240, 480]) {
      for (const m of [30, 60, 120, 240]) {
        const v = calculateActivitySensitivityMultiplier(
          [session({ duration_minutes: duration })], PC, at(m));
        expect([duration, m, v <= cap]).toEqual([duration, m, true]);
      }
    }
  });

  it('does rise with intensity — this is the one channel intensity reaches', () => {
    // The counterpart to the acute-effect pin: W integrates Y, and Y tracks HR
    // above resting, so the sensitivity boost is where effort shows up. It is
    // only *visible* below the cap — see the saturation pin immediately below,
    // which is why this uses a short session.
    const short = { duration_minutes: 5 };
    for (const m of [5, 15, 35, 65, 125]) {
      const tiers = (['light', 'moderate', 'vigorous'] as const).map(intensity =>
        calculateActivitySensitivityMultiplier([session({ ...short, intensity })], PC, at(m)));
      expect([m, tiers[0] < tiers[1], tiers[1] < tiers[2]]).toEqual([m, true, true]);
      expect([m, tiers.map(t => t > 1)]).toEqual([m, [true, true, true]]);
    }
  });

  it('PINS: the boost saturates at its cap for any session of 15 minutes or more', () => {
    // MEASURED. max_sensitivity_boost is 0.60 and W grows fast enough that a
    // 15-minute session at *light* intensity is already at the cap when it
    // ends. For a 30-minute session all three tiers sit at exactly 1.6 for the
    // following hour and a half.
    //
    // Combined with the acute-effect pin in the other describe block, this is
    // the practical statement: for realistic session lengths the model's output
    // does not distinguish a gentle walk from a hard interval session in either
    // channel. Intensity is only observable for sessions under about ten
    // minutes, or deep into recovery.
    //
    // Shared with backend/utils/activity_pharmacodynamics.py. A model decision
    // to make deliberately, not a port defect — pinned so it is visible.
    const cap = 1 + HR_MODEL.max_sensitivity_boost;
    for (const intensity of ['light', 'moderate', 'vigorous'] as const) {
      expect([intensity, calculateActivitySensitivityMultiplier(
        [session({ duration_minutes: 15, intensity })], PC, at(15))]).toEqual([intensity, cap]);
      for (const m of [30, 40, 60, 90]) {
        expect([intensity, m, calculateActivitySensitivityMultiplier(
          [session({ duration_minutes: 30, intensity })], PC, at(m))]).toEqual([intensity, m, cap]);
      }
    }
  });

  it('takes the maximum across sessions, not the sum', () => {
    // GLUT4 upregulation does not stack: a second session cannot push the boost
    // past what the strongest one already achieved.
    // Short sessions, so the two differ and max() is actually being tested
    // rather than both arguments sitting at the cap.
    const a = session({ _id: 'a', intensity: 'light', duration_minutes: 5 });
    const b = session({ _id: 'b', intensity: 'vigorous', duration_minutes: 5 });
    const only = [a, b].map(s => calculateActivitySensitivityMultiplier([s], PC, at(15)));
    expect(only[0]).toBeLessThan(only[1]);
    const both = calculateActivitySensitivityMultiplier([a, b], PC, at(15));
    expect(both).toBe(Math.max(...only));
    expect(both).toBeLessThan(only[0] + only[1] - 1);
  });

  it('ignores a session that has not started yet', () => {
    expect(calculateActivitySensitivityMultiplier([session()], PC, at(-1))).toBe(1.0);
  });

  it('ignores a session more than eight hours old', () => {
    expect(calculateActivitySensitivityMultiplier([session()], PC, at(8 * 60 - 1))).toBeGreaterThan(1);
    expect(calculateActivitySensitivityMultiplier([session()], PC, at(8 * 60 + 1))).toBe(1.0);
  });

  it('skips sessions from before the daily reset boundary (H-3)', () => {
    const now = new Date(Date.UTC(2026, 2, 1, 12, 0, 0));
    const reset = timeManagerReset(now.getTime(), 7, 0);
    const after = calculateActivitySensitivityMultiplier(
      [session({ timestamp: reset + MIN })], PC, now);
    const before = calculateActivitySensitivityMultiplier(
      [session({ timestamp: reset - MIN })], PC, now);
    expect(after).toBeGreaterThan(1);
    expect(before).toBe(1.0);
  });

  it('agrees with TimeManager on the reset boundary at every offset, including east of +07:00', () => {
    // This module derives the reset from the patient's *local* calendar date,
    // which is what TimeManager and the Python backend do. The other two
    // modules audited in this pass anchor on the UTC date and are 24 h stale
    // east of +07:00 (see the D9 pins in the other two suites). This test is
    // what says the difference is real and which side is right.
    for (const tzOffset of [-720, -480, -300, 0, 120, 330, 345, 480, 540, 720, 765, 780]) {
      for (const utcHour of [0, 6, 11, 12, 18, 21, 23]) {
        const now = new Date(Date.UTC(2026, 2, 1, utcHour, 0, 0));
        const reset = timeManagerReset(now.getTime(), 7, tzOffset);
        const constants = { ...PC, daily_reset_hour: 7, timezone_offset_minutes: tzOffset };
        // Evaluate one hour after the boundary so both sessions are in the past
        // and inside the 8 h decay window.
        const evalAt = new Date(reset + 60 * MIN);
        const label = `tz=${tzOffset} utc=${utcHour}`;
        expect([label, calculateActivitySensitivityMultiplier(
          [session({ timestamp: reset + MIN })], constants, evalAt) > 1]).toEqual([label, true]);
        expect([label, calculateActivitySensitivityMultiplier(
          [session({ timestamp: reset - MIN })], constants, evalAt)]).toEqual([label, 1.0]);
      }
    }
  });

  it('defaults to a 07:00 reset at UTC when the patient declares neither', () => {
    const now = new Date(Date.UTC(2026, 2, 1, 12, 0, 0));
    const reset = timeManagerReset(now.getTime(), 7, 0);
    const bare = { hr_base: 70, hr_max: 190, weight_kg: 70 } as any;
    expect(calculateActivitySensitivityMultiplier([session({ timestamp: reset - MIN })], bare, now)).toBe(1.0);
    expect(calculateActivitySensitivityMultiplier([session({ timestamp: reset + MIN })], bare, now)).toBeGreaterThan(1);
  });
});

describe('applyActivitySensitivity', () => {
  it('returns the original object untouched when there is no boost', () => {
    const constants = { ...PC, correction_factor: 40, carb_to_bg_ratio: 10 };
    const out = applyActivitySensitivity(constants, [], at(60));
    expect(out).toBe(constants);
  });

  it('raises ISF and lowers the carb ratio, and does not mutate the input', () => {
    // Post-exercise the patient is more insulin-sensitive: one unit moves BG
    // further (higher correction_factor) and one gram of carbohydrate needs
    // proportionally less cover (lower carb ratio).
    const constants: any = { ...PC, correction_factor: 40, carb_to_bg_ratio: 10, carb_to_bg_factor: 4 };
    const snapshot = JSON.stringify(constants);
    const multiplier = calculateActivitySensitivityMultiplier([session()], constants, at(50));
    expect(multiplier).toBeGreaterThan(1);

    const out: any = applyActivitySensitivity(constants, [session()], at(50));
    expect(JSON.stringify(constants)).toBe(snapshot);          // input untouched
    expect(out.correction_factor).toBe(Math.round(40 * multiplier * 100) / 100);
    expect(out.carb_to_bg_ratio).toBe(Math.round((10 / multiplier) * 100) / 100);
    expect(out.carb_to_bg_factor).toBe(Math.round((4 / multiplier) * 100) / 100);
    expect(out.correction_factor).toBeGreaterThan(40);
    expect(out.carb_to_bg_ratio).toBeLessThan(10);
  });

  it('leaves fields it was not given alone rather than inventing them', () => {
    const out: any = applyActivitySensitivity({ ...PC }, [session()], at(50));
    expect('correction_factor' in out).toBe(false);
    expect('carb_to_bg_ratio' in out).toBe(false);
    expect(out.hr_base).toBe(70);
  });

  it('leaves a null field null rather than turning it into NaN', () => {
    const out: any = applyActivitySensitivity(
      { ...PC, correction_factor: null, carb_to_bg_ratio: null } as any, [session()], at(50));
    expect(out.correction_factor).toBeNull();
    expect(out.carb_to_bg_ratio).toBeNull();
  });
});

describe('calculateStackedActivityEffect', () => {
  it('sums the acute effects and takes the max sensitivity', () => {
    const acts = [session({ _id: 'a', intensity: 'light' }),
                  session({ _id: 'b', intensity: 'vigorous' })];
    const r = calculateStackedActivityEffect(acts, PC, at(60));
    const each = acts.map(a => calculateActivityCumulativeEffect(a, PC, at(60)));
    expect(r.cumulative_activity_effect).toBeCloseTo(
      Math.round((each[0] + each[1]) * 10) / 10, 6);
    expect(r.sensitivity_multiplier).toBe(
      Math.round(calculateActivitySensitivityMultiplier(acts, PC, at(60)) * 10000) / 10000);
  });

  it('returns a well-formed empty result for no sessions', () => {
    const r = calculateStackedActivityEffect([], PC, at(60));
    expect(r.cumulative_activity_effect).toBe(0);
    expect(r.activity_on_board).toBe(0);
    expect(r.sensitivity_multiplier).toBe(1);
    expect(r.active_sessions).toBe(0);
    expect(r.activity_contributions).toEqual([]);
  });

  it('counts only the sessions still running as active', () => {
    const running = session({ _id: 'running', timestamp: T0 + 50 * MIN });
    const finished = session({ _id: 'finished', timestamp: T0 });
    const r = calculateStackedActivityEffect([running, finished], PC, at(60));
    expect(r.active_sessions).toBe(1);
    expect(r.activity_contributions.find(c => c.activity_id === 'running')!.is_active).toBe(true);
    expect(r.activity_contributions.find(c => c.activity_id === 'finished')!.is_active).toBe(false);
  });

  it('labels each contribution with the HR path it actually took', () => {
    const withTrace = session({ _id: 'w', hr_trace: [{ t_min: 0, hr_bpm: 70 }, { t_min: 45, hr_bpm: 150 }] });
    const withoutTrace = session({ _id: 'x' });
    const r = calculateStackedActivityEffect([withTrace, withoutTrace], PC, at(60));
    expect(r.activity_contributions.map(c => c.model)).toEqual(['hr_ode', 'synthetic_hr']);
  });

  it('keeps the aggregate consistent with the per-session numbers', () => {
    const acts = [session({ _id: 'a' }), session({ _id: 'b', timestamp: T0 + 20 * MIN })];
    const r = calculateStackedActivityEffect(acts, PC, at(50));
    const summedAob = r.activity_contributions.reduce((s, c) => s + c.remaining_bg_drop, 0);
    expect(r.activity_on_board).toBeCloseTo(Math.round(summedAob * 10) / 10, 6);
    expect(r.cumulative_activity_effect).toBeLessThanOrEqual(0);   // aerobic default
  });

  it('emits an ISO start time for every contribution', () => {
    const r = calculateStackedActivityEffect([session()], PC, at(60));
    expect(r.activity_contributions[0].start_time).toBe(new Date(T0).toISOString());
  });
});

describe('shared constants are used, not re-declared', () => {
  it('reads the ODE parameters straight from SHARED_CONSTANTS', () => {
    // Arm 5 rule 1 in spirit: a local copy of these would drift silently, and
    // the parity harness would report it as a model difference.
    expect(Object.keys(HR_MODEL).sort()).toEqual([
      'a', 'acute_rate_per_min', 'alpha', 'dt', 'hr_base_pop', 'hr_max_pop',
      'max_sensitivity_boost', 'tau_HR', 'tau_W', 'tau_Z',
    ]);
    expect(HR_MODEL.dt).toBe(1.0);
    expect(INTENSITY_HR_FRACTION.light).toBeLessThan(INTENSITY_HR_FRACTION.moderate);
    expect(INTENSITY_HR_FRACTION.moderate).toBeLessThan(INTENSITY_HR_FRACTION.vigorous);
  });

  it('falls back to the population HR defaults when the patient has none', () => {
    const populationDefault = calculateActivityCumulativeEffect(session(), {} as any, at(240));
    const explicit = calculateActivityCumulativeEffect(
      session(), { hr_base: HR_MODEL.hr_base_pop, hr_max: HR_MODEL.hr_max_pop } as any, at(240));
    expect(populationDefault).toBe(explicit);
  });

  it('lets an activity-level hr_base override the patient default', () => {
    const patientLevel = calculateActivityCumulativeEffect(session(), { ...PC, hr_base: 45 }, at(240));
    const activityLevel = calculateActivityCumulativeEffect(session({ hr_base: 45 }), PC, at(240));
    expect(activityLevel).toBe(patientLevel);
  });
});
