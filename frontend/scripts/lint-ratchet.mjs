#!/usr/bin/env node
/**
 * A frontend lint gate that can actually be met, and the production build in
 * one pass.
 *
 * `react-scripts build` with `CI=true` treats every eslint warning as an error.
 * Measured on this tree: **126 warnings**, so the build exits 1 and a CI job
 * written the obvious way would be red from the day it was added. That is the
 * same trap the mobile typecheck fell into, and the same answer applies — see
 * `mobile/scripts/typecheck-ratchet.mjs` and the pre-ML audit §2. A gate that
 * can only be red trains everyone to ignore the job.
 *
 * So this runs the build *without* CI=true — the build must still succeed, and
 * a genuine compile error still fails the job — then counts the warnings the
 * build reported and ratchets on that count. It can only go down.
 *
 *     node scripts/lint-ratchet.mjs            # build + check
 *     node scripts/lint-ratchet.mjs --update   # re-record after fixing some
 *
 * Running the build once for both purposes matters: the build is the slow step
 * in CI, and invoking it twice to lint and then build would double the job.
 *
 * Node >= 18, no npm packages.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const BASELINE = join(FRONTEND, 'lint-baseline.json');

const update = process.argv.includes('--update');

function runBuild() {
  // CI is deliberately cleared: with CI=true react-scripts turns warnings into
  // errors and we would never get a warning list to count, only a failure.
  const env = { ...process.env, CI: '' };
  try {
    const stdout = execFileSync('npm', ['run', 'build'], {
      cwd: FRONTEND,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const { ok, output } = runBuild();

if (!ok) {
  console.error('build FAILED — this is a compile error, not a lint warning:\n');
  console.error(output.slice(-4000));
  process.exit(1);
}

/**
 * react-scripts prints each warning as an indented `Line <n>:<col>  <message>
 * <rule>` under a file heading. Counting the rule-bearing lines is stable
 * across CRA's warning formatting and does not depend on the summary text.
 */
const lines = output.split(/\r?\n/);
const warnings = [];
let currentFile = null;
for (const line of lines) {
  const fileMatch = /^\s*(src[\\/][^\s]+\.(?:js|jsx|css))\s*$/.exec(line);
  if (fileMatch) {
    currentFile = fileMatch[1].replace(/\\/g, '/');
    continue;
  }
  if (/^\s*Line \d+:\d+:\s+\S/.test(line) && currentFile) {
    warnings.push(currentFile);
  }
}

const count = warnings.length;

/** Warnings per file, so a regression can be attributed rather than just counted. */
const byFile = {};
for (const file of warnings) byFile[file] = (byFile[file] || 0) + 1;

if (update) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ count, byFile, updated: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
    'utf8',
  );
  console.log(`lint baseline updated: ${count} warnings across ${Object.keys(byFile).length} files`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`No baseline at ${BASELINE}. Create one with:\n    node scripts/lint-ratchet.mjs --update`);
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

if (count > baseline.count) {
  console.error(`lint REGRESSED: ${count} warnings, baseline is ${baseline.count} (+${count - baseline.count})`);
  const worse = Object.entries(byFile)
    .filter(([f, n]) => n > (baseline.byFile[f] || 0))
    .sort((a, b) => b[1] - a[1]);
  console.error('\nfiles that got worse:');
  for (const [file, n] of worse) {
    console.error(`  ${file}: ${baseline.byFile[file] || 0} -> ${n}`);
  }
  console.error('\nThe count may only go down. Fix the new warnings, or if the');
  console.error('trade is deliberate, say so in the PR and re-record with:');
  console.error('    node scripts/lint-ratchet.mjs --update');
  process.exit(1);
}

if (count < baseline.count) {
  console.error(`lint IMPROVED: ${count} warnings, baseline says ${baseline.count} (-${baseline.count - count}).`);
  console.error('Lock the improvement in so it cannot be lost:');
  console.error('    node scripts/lint-ratchet.mjs --update');
  process.exit(1);
}

console.log(`build ok, lint ok: ${count} warnings, matching the baseline (not yet zero — see docs/engineering)`);
process.exit(0);
