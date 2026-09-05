/**
 * patch-zustand.js
 *
 * Patches zustand's middleware files to replace `import.meta.env`
 * with a Metro/Hermes-compatible equivalent. Hermes has no `import.meta`,
 * so a bundle that reaches that expression throws at load.
 *
 * Run manually:  node patch-zustand.js
 * Auto-runs via: "postinstall" in package.json
 *
 * The script lives in `mobile/`, not `mobile/scripts/`. It was written for
 * `scripts/` and later moved up a level without its path being updated, so
 * `__dirname/../node_modules/zustand` resolved to the *repository root*, which
 * has no zustand — the script ran on every `npm install` and silently patched
 * nothing. Resolving from `__dirname` directly is what makes it do its job.
 *
 * Whether that job is still needed: zustand 5.0.9 does contain `import.meta`,
 * but only in `esm/middleware.mjs`, which Metro does not resolve (it takes the
 * CJS entry). So the current web bundle is clean either way and this is a
 * belt-and-braces guard, not a live fix. It is kept because the failure it
 * prevents is an opaque Hermes load error, and the cost of keeping it is one
 * idempotent file scan per install.
 */

const fs   = require('fs');
const path = require('path');

const zustandDir = path.join(__dirname, 'node_modules', 'zustand');

let patchedCount = 0;

function replaceInFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('import.meta')) return;

    const patched = content.replace(
      /import\.meta\.env/g,
      '(typeof process !== "undefined" ? process.env : {})'
    );

    if (patched !== content) {
      fs.writeFileSync(filePath, patched, 'utf8');
      console.log('  patched:', path.relative(process.cwd(), filePath));
      patchedCount++;
    }
  } catch {
    // skip unreadable files
  }
}

function walkDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      walkDir(full);
    } else if (/\.(js|mjs|cjs)$/.test(entry)) {
      replaceInFile(full);
    }
  }
}

console.log('\nPatching zustand for Metro/Hermes web compatibility...');

if (fs.existsSync(zustandDir)) {
  walkDir(zustandDir);
  console.log(`Done. ${patchedCount} file(s) patched.\n`);
} else {
  console.warn('Warning: zustand not found in node_modules — skipping.\n');
}
