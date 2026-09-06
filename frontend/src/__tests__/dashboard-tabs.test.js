/**
 * D25 — no dashboard tab may point at an empty module.
 *
 * Four components under `src/components/` were 0 bytes, and three of them were
 * imported and rendered as named tabs by `PatientDashboard.js`:
 *
 *   ClinicalValidationDashboard.js   rendered at line 123, "Clinical Validation Dashboard"
 *   GlycemicResponseTracker.js       rendered at line  99, "Combined Meal Analytics"
 *   Test.js                          rendered at line 135, "🧪 Test Component"
 *   EnhancedPatientConstants.js      orphaned — nothing imported it
 *
 * The build was green throughout: webpack bundles an empty module without
 * complaint, so the failure was deferred to whoever clicked the tab.
 *
 * The audit predicted the mechanism as "the default export is `undefined`, and
 * `React.createElement(undefined)` throws". Measured here, the consequence is
 * right and the mechanism is not: under the CRA babel interop an empty module
 * imports as an empty *namespace object*, not `undefined`, and React rejects it
 * with "Element type is invalid ... but got: object". Either way the tab throws
 * at render; it is worth stating correctly because `toBeUndefined()` would be
 * the natural assertion to reach for and it does not hold.
 *
 * These tests guard the *class* rather than the three instances. A 0-byte
 * component added later — the same way these arrived, as structure committed
 * before it did anything (Arm 5 rule 9) — fails here rather than in front of a
 * clinician.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const COMPONENTS = path.join(SRC, 'components');

/** Every `.js` file under src/, recursively, as absolute paths. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('no source module is empty', () => {
  it('every .js file under src/ has content', () => {
    const empty = sourceFiles(SRC)
      .filter((f) => fs.statSync(f).size === 0)
      .map((f) => path.relative(SRC, f));

    // Named rather than counted, so a failure says which file to look at.
    expect(empty).toEqual([]);
  });
});

describe('every component PatientDashboard imports is renderable', () => {
  /**
   * Read the import list out of the dashboard source rather than hard-coding
   * it, so a component added to the dashboard later is covered automatically
   * and this test cannot silently fall behind the file it is guarding.
   */
  const dashboardSource = fs.readFileSync(
    path.join(COMPONENTS, 'PatientDashboard.js'), 'utf8');

  const localImports = [...dashboardSource.matchAll(
    /^import\s+(\w+)\s+from\s+'(\.\/[^']+)'/gm)]
    .map(([, name, spec]) => [name, spec]);

  it('finds the dashboard imports at all', () => {
    // A guard on the guard: if the regex stops matching, the suite below would
    // pass vacuously by iterating an empty list.
    expect(localImports.length).toBeGreaterThan(15);
  });

  it.each(localImports)('%s resolves to a React component type', (name, spec) => {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(path.join(COMPONENTS, spec.replace('./', '')));
    const exported = mod.default ?? mod;

    // React accepts a function (function or class component) or an object
    // carrying a $$typeof brand (memo, forwardRef, lazy). An empty module is
    // an object with neither, which is exactly what used to reach createElement.
    const renderable =
      typeof exported === 'function' ||
      (exported != null && typeof exported === 'object' && '$$typeof' in exported);

    expect([name, renderable]).toEqual([name, true]);
  });
});
