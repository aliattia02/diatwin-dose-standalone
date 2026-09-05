/**
 * Frontend half of the cross-language parity harness — the third side.
 *
 * The pharmacodynamic models are implemented three times, independently and on
 * purpose (Arm 5 §5): Python under `backend/utils/`, TypeScript under
 * `mobile/utils/`, and JavaScript under `frontend/src/utils/`. The harness
 * compared the first two. This file brings in the third.
 *
 *     python -m diatwin.verify.parity generate
 *     python -m diatwin.verify.parity python
 *     cd mobile && npx jest __tests__/parity
 *     node diatwin/verify/frontend_eval.mjs        # <- this file
 *     python -m diatwin.verify.parity compare
 *
 * Like the other two evaluators it does not judge agreement: it reads the same
 * `cases.json`, evaluates, and writes `results_frontend.json` keyed by case id.
 * `compare` is the single definition of "these agree" (Arm 5 rule 11).
 *
 * Why a bare Node script rather than a test file
 * ----------------------------------------------
 * The mobile side rides on jest, which mobile already has. `frontend/` is a
 * Create React App project whose only runner is `react-scripts test`, and
 * installing that toolchain to evaluate 1,578 arithmetic cases would make the
 * third side the most expensive one to run — in CI most of all. The frontend
 * modules are plain ES modules with no React in them, so Node runs them
 * directly. `diatwin/verify` may import nothing outside the Python standard
 * library (Arm 5 rule 1); that rule is about the Python foundation, and this
 * file adds no Python dependency and no npm dependency either.
 *
 * Two shims are needed, both narrow and both asserted below rather than
 * assumed:
 *
 *   1. `activityPharmacodynamics.js` imports `'../constants/shared_constants'`
 *      with no extension. Webpack resolves that; Node's ESM resolver does not.
 *      A resolve hook appends `.js` on ERR_MODULE_NOT_FOUND rather than
 *      editing the shipped source, so the harness adapts to the code under
 *      test and not the other way round.
 *
 *   2. `mealPharmacodynamics.js` reads `window.DEBUG_ABSORPTION_PROFILE` at
 *      the top of `calculateAbsorbedFraction`. `globalThis.window = {}` makes
 *      that read `undefined`, which is exactly what a browser with the flag
 *      unset gives. It gates a `console.log` and nothing else — verified by
 *      reading it, and the debug branch has no return.
 *
 * Neither shim touches a number.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node 22.15 introduced `module.registerHooks`, and 22.7 made ES module syntax
// detection the default for `.js` files in a package with no `"type"` field —
// which `frontend/package.json` is. Both are load-bearing here, and on an older
// runtime the failure is an opaque `SyntaxError: Unexpected token 'export'`
// from inside a shipped source file. Say what is actually wrong instead.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  console.error(
    `node ${process.versions.node} is too old for the frontend evaluator (needs >= 22.15).\n` +
    '  The frontend modules are ES modules in a package.json with no "type" field,\n' +
    '  which older runtimes try to parse as CommonJS.');
  process.exit(2);
}

const { registerHooks } = await import('node:module');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const CASES_FILE = path.join(FIXTURES, 'cases.json');
const OUT_FILE = path.join(FIXTURES, 'results_frontend.json');
const UTILS = pathToFileURL(path.join(REPO, 'frontend', 'src', 'utils') + path.sep).href;

// Shim 1: webpack-style extension-less relative imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw err;
      return nextResolve(`${specifier}.js`, context);
    }
  },
});

// Shim 2: the debug-flag read in calculateAbsorbedFraction.
if (typeof globalThis.window === 'undefined') globalThis.window = {};

const insulin = await import(`${UTILS}insulinPharmacodynamics.js`);
const meal = await import(`${UTILS}mealPharmacodynamics.js`);
const activity = await import(`${UTILS}activityPharmacodynamics.js`);

/** Naive-UTC ISO string -> epoch ms. The case file's clock convention. */
function parseNaiveUtc(s) {
  return Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`);
}

function evaluateCase(c) {
  switch (c.fn) {
    case 'insulin_activity':
      // The frontend reads snake_case profile keys directly, the same shape
      // the case file embeds, so nothing is converted on the way in.
      return insulin.calculateInsulinActivity(c.hours_since_dose, c.profile);

    case 'iob':
      return insulin.calculateIOB(c.hours_since_dose, c.dose, c.profile);

    case 'meal_activity':
      return meal.calculateMealActivity(c.hours_since_meal, c.profile);

    case 'meal_absorbed':
      return meal.calculateAbsorbedFraction(c.hours_since_meal, c.profile);

    case 'activity_effect':
    case 'activity_aob': {
      const startMs = parseNaiveUtc(c.start_time);
      const currentMs = startMs + c.elapsed_minutes * 60_000;
      // The frontend takes (activity, currentTimeMs, pc) — the clock second,
      // as a number — where the mobile client takes (activity, pc, Date).
      // Same inputs, different call shape; that is the port's business, not
      // the model's.
      const record = { _id: c.id, timestamp: startMs, ...c.activity };
      if (c.fn === 'activity_effect') {
        return activity.calculateActivityCumulativeEffect(record, currentMs, c.patient_constants);
      }
      return activity.getActivityOnBoard(record, currentMs, c.patient_constants).remaining_bg_drop;
    }

    default:
      throw new Error(`unknown fn: ${c.fn}`);
  }
}

function main() {
  if (!fs.existsSync(CASES_FILE)) {
    console.error(`missing case file: ${CASES_FILE}`);
    console.error('  run:  python -m diatwin.verify.parity generate');
    return 2;
  }
  const raw = JSON.parse(fs.readFileSync(CASES_FILE, 'utf-8'));

  // The Y/Z/W parameters are not an input to any implementation — each reads
  // its own copy — so they cannot be embedded as case data the way the
  // pharmacokinetic profiles are. Checking them here is what stops a stale
  // constants export being reported as a model difference (Arm 5 rule 12).
  if (raw.hr_model) {
    const mine = {};
    for (const [k, v] of Object.entries(activity.HR_MODEL)) mine[k] = Number(v);
    const theirs = {};
    for (const [k, v] of Object.entries(raw.hr_model)) theirs[k] = Number(v);
    const drift = Object.keys(theirs)
      .filter((k) => !Object.is(mine[k], theirs[k]))
      .map((k) => `${k}: case file ${theirs[k]}, frontend ${mine[k]}`);
    if (drift.length) {
      console.error('HR_MODEL does not match the case file — a constants export is stale:');
      for (const line of drift) console.error(`  ${line}`);
      return 2;
    }
  }

  const results = {};
  const bad = [];
  for (const c of raw.cases) {
    let value;
    try {
      value = evaluateCase(c);
    } catch (err) {
      bad.push(`${c.id} -> threw ${err.message}`);
      continue;
    }
    // Report every offender, not just the first — a whole curve family
    // returning NaN is one bug, and seeing all of it at once says so.
    if (!Number.isFinite(value)) bad.push(`${c.id} -> ${value}`);
    results[c.id] = value;
  }

  if (bad.length) {
    console.error(`${bad.length} case(s) did not produce a finite number:`);
    for (const line of bad.slice(0, 20)) console.error(`  ${line}`);
    if (bad.length > 20) console.error(`  ... and ${bad.length - 20} more`);
    return 1;
  }

  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`evaluated ${Object.keys(results).length} cases (frontend) -> ${OUT_FILE}`);
  return 0;
}

process.exit(main());
