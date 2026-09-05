#!/usr/bin/env node
/**
 * A typecheck gate that can actually be met.
 *
 * `npx tsc --noEmit` reports 185 errors. The CI workflow already runs it with
 * no `continue-on-error`, so the mobile job cannot pass — and a gate that can
 * only ever be red is worse than no gate at all: it trains everyone to ignore
 * the job. That is how a user-facing bug (`register.tsx` reading
 * `ValidationResult.error`) sat in the output, reported six times, with the fix
 * named in the message, until someone hit it in the app.
 *
 * So this ratchets instead of gating absolutely. It fails when the error count
 * *rises* above the recorded baseline, and fails when the count drops without
 * the baseline being lowered — the second half is what stops the number
 * drifting back up after someone fixes a batch.
 *
 * The count can only go down. Fix errors, run with `--update`, commit the new
 * baseline.
 *
 *     node scripts/typecheck-ratchet.mjs            # check
 *     node scripts/typecheck-ratchet.mjs --update   # re-record after fixing
 *
 * Node >= 18, no npm packages.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const BASELINE = join(MOBILE, 'typecheck-baseline.json');

const update = process.argv.includes('--update');

function runTsc() {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], {
      cwd: MOBILE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return '';
  } catch (err) {
    // tsc exits non-zero when it reports errors; the diagnostics are on stdout.
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

const output = runTsc();
const lines = output.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
const count = lines.length;

/** Errors per file, so a regression can be attributed rather than just counted. */
const byFile = {};
for (const line of lines) {
  const file = line.split('(')[0].trim();
  if (file) byFile[file] = (byFile[file] || 0) + 1;
}

if (update) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ count, byFile, updated: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
    'utf8',
  );
  console.log(`typecheck baseline updated: ${count} errors across ${Object.keys(byFile).length} files`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`No baseline at ${BASELINE}. Create one with:\n    node scripts/typecheck-ratchet.mjs --update`);
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

if (count > baseline.count) {
  console.error(`typecheck REGRESSED: ${count} errors, baseline is ${baseline.count} (+${count - baseline.count})`);
  const worse = Object.entries(byFile)
    .filter(([f, n]) => n > (baseline.byFile[f] || 0))
    .sort((a, b) => b[1] - a[1]);
  console.error('\nfiles that got worse:');
  for (const [file, n] of worse) {
    console.error(`  ${file}: ${baseline.byFile[file] || 0} -> ${n}`);
  }
  console.error('\nThe count may only go down. Fix the new errors, or if you have');
  console.error('deliberately traded one error for several, say so in the PR and');
  console.error('re-record with: node scripts/typecheck-ratchet.mjs --update');
  process.exit(1);
}

if (count < baseline.count) {
  console.error(`typecheck IMPROVED: ${count} errors, baseline says ${baseline.count} (-${baseline.count - count}).`);
  console.error('Lock the improvement in so it cannot be lost:');
  console.error('    node scripts/typecheck-ratchet.mjs --update');
  process.exit(1);
}

console.log(`typecheck ok: ${count} errors, matching the baseline (not yet zero — see docs/engineering)`);
process.exit(0);
