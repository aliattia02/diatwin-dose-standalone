/**
 * TypeScript half of the cross-language parity harness.
 *
 * The insulin, meal and activity models are implemented independently in
 * Python (`backend/utils/pharmacodynamics.py`,
 * `backend/utils/activity_pharmacodynamics.py`) and TypeScript
 * (`mobile/utils/insulin/pharmacodynamics.ts`,
 * `mobile/utils/glucose/meal-pharmacodynamics.ts`,
 * `mobile/utils/activity/activity-pharmacodynamics.ts`). Two independent
 * implementations of the same mathematics is a verification strategy — but
 * only when something compares them.
 *
 * This test evaluates the shared case file and writes its answers next to the
 * Python ones. It does not judge agreement itself: comparison lives in
 * `diatwin/verify/parity.py compare`, so there is exactly one definition of
 * "these agree" rather than one per language (Arm 5 rule 11).
 *
 *     python -m diatwin.verify.parity generate
 *     python -m diatwin.verify.parity python
 *     cd mobile && npx jest __tests__/parity
 *     python -m diatwin.verify.parity compare
 *
 * The assertions here cover only this side's own sanity — that every case
 * produced a finite number, and that this build's HR_MODEL matches the one the
 * case file was generated from. A NaN reaching the comparison step would show
 * up as a tolerance failure with no indication of which side produced it, and
 * a stale constants export would show up as a model difference when it is
 * really a sync problem.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  calculateIOB,
  calculateInsulinActivity,
} from '../utils/insulin/pharmacodynamics';
import {
  calculateAbsorbedFraction,
  calculateGammaAbsorption,
  toPharmacodynamicProfile,
} from '../utils/glucose/meal-pharmacodynamics';
import {
  calculateActivityCumulativeEffect,
  getActivityOnBoard,
  HR_MODEL,
  type NormalizedActivity,
} from '../utils/activity/activity-pharmacodynamics';

const FIXTURES = path.resolve(__dirname, '..', '..', 'diatwin', 'verify', 'fixtures');
const CASES_FILE = path.join(FIXTURES, 'cases.json');
const OUT_FILE = path.join(FIXTURES, 'results_typescript.json');

/** Naive-UTC ISO string -> epoch ms. The case file's clock convention. */
function parseNaiveUtc(s: string): number {
  return Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`);
}

interface ParityCase {
  id: string;
  fn: 'insulin_activity' | 'iob' | 'meal_activity' | 'meal_absorbed'
    | 'activity_effect' | 'activity_aob';
  hours_since_dose?: number;
  hours_since_meal?: number;
  dose?: number;
  profile?: Record<string, any>;
  start_time?: string;
  elapsed_minutes?: number;
  activity?: Record<string, any>;
  patient_constants?: Record<string, any>;
}

function evaluateCase(c: ParityCase): number {
  switch (c.fn) {
    case 'insulin_activity':
      return calculateInsulinActivity(c.hours_since_dose as number, c.profile as any);

    case 'iob':
      return calculateIOB(c.hours_since_dose as number, c.dose as number, c.profile as any);

    case 'meal_activity':
      // The profile arrives snake_case, exactly as the constants define it;
      // converting here rather than in the case file keeps a single embedded
      // representation for both languages.
      return calculateGammaAbsorption(
        c.hours_since_meal as number, toPharmacodynamicProfile(c.profile as any));

    case 'meal_absorbed':
      return calculateAbsorbedFraction(
        c.hours_since_meal as number, toPharmacodynamicProfile(c.profile as any));

    case 'activity_effect':
    case 'activity_aob': {
      const startMs = parseNaiveUtc(c.start_time as string);
      const target = new Date(startMs + (c.elapsed_minutes as number) * 60_000);
      const activity = {
        _id: c.id,
        timestamp: startMs,
        ...(c.activity as any),
      } as NormalizedActivity;
      if (c.fn === 'activity_effect') {
        return calculateActivityCumulativeEffect(activity, c.patient_constants as any, target);
      }
      return getActivityOnBoard(activity, c.patient_constants as any, target)
        .sessions[0].remaining_bg_drop;
    }

    default:
      throw new Error(`unknown fn: ${(c as ParityCase).fn}`);
  }
}

describe('cross-language parity harness', () => {
  const raw = fs.existsSync(CASES_FILE)
    ? JSON.parse(fs.readFileSync(CASES_FILE, 'utf-8'))
    : null;

  it('has a generated case file', () => {
    expect(raw).not.toBeNull();
    expect(Array.isArray(raw.cases)).toBe(true);
    expect(raw.cases.length).toBeGreaterThan(0);
  });

  it('this build’s HR_MODEL matches the one the cases were generated from', () => {
    // The Y/Z/W parameters are not an input to either implementation — both
    // read their own copy — so they cannot be embedded as case data the way
    // the pharmacokinetic profiles are. Checking them here is what stops a
    // stale constants export being reported as a model difference.
    if (!raw?.hr_model) return;   // pre-v2 case file
    const mine: Record<string, number> = {};
    for (const [k, v] of Object.entries(HR_MODEL)) mine[k] = Number(v);
    const theirs: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.hr_model)) theirs[k] = Number(v);
    expect(mine).toEqual(theirs);
  });

  it('evaluates every case to a finite number and writes results', () => {
    const cases: ParityCase[] = raw.cases;
    const results: Record<string, number> = {};
    const bad: string[] = [];

    for (const c of cases) {
      const value = evaluateCase(c);
      if (!Number.isFinite(value)) bad.push(`${c.id} -> ${value}`);
      results[c.id] = value;
    }

    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf-8');

    // Report every offender, not just the first — a whole curve family
    // returning NaN is one bug, and seeing all of it at once says so.
    expect(bad).toEqual([]);
    expect(Object.keys(results).length).toBe(cases.length);
  });

  it('covers every case family the generator emits', () => {
    // A family silently dropping out of the case file would make `compare`
    // pass by evaluating nothing, which is the one failure mode the harness
    // cannot detect on its own.
    const families = new Set((raw.cases as ParityCase[]).map(c => c.id.split('::')[0]));
    expect([...families].sort()).toEqual(
      ['act_aob', 'act_bg', 'activity', 'iob', 'meal_abs', 'meal_act']);
  });
});
