/**
 * scripts/patch-zustand.js
 *
 * Patches zustand's middleware files to replace `import.meta.env`
 * with a Metro/Hermes-compatible equivalent.
 *
 * Run manually:  node scripts/patch-zustand.js
 * Auto-runs via: "postinstall" in package.json
 */

const fs   = require('fs');
const path = require('path');

const zustandDir = path.join(__dirname, '..', 'node_modules', 'zustand');

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
