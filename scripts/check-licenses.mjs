/**
 * Dependency licence check.
 *
 * Enforces the project's zero-cost, permissively-licensed policy. This is a hard CI
 * gate rather than an advisory report, because the failure mode it guards against is
 * silent: a transitive dependency can pick up a source-available or non-commercial
 * licence in a patch release, and nothing about the build changes.
 *
 * Policy, in short:
 *   - Permissive licences only. Permissive is what keeps Adnota MIT-compatible and
 *     lets it be redistributed without obligations.
 *   - No source-available licences, ever. SSPL, BUSL, Elastic and similar terms
 *     forbid exactly the things this project promises its users.
 *   - No unknown or unmarked licences. An unrecognised licence cannot be assumed
 *     compatible, so it is treated as a failure.
 *
 * Usage: node scripts/check-licenses.mjs [--json]
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Licences that are safe for an MIT project. */
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
]);

/**
 * Licences that are known-incompatible, listed separately so the failure message can
 * say why rather than only "not in allowlist".
 */
const REJECTED = new Map([
  ['GPL-2.0', 'copyleft with no exception; incompatible with permissive distribution'],
  ['GPL-3.0', 'strong copyleft; incompatible with permissive distribution'],
  ['AGPL-3.0', 'network copyleft; incompatible with permissive distribution'],
  ['SSPL-1.0', 'source-available; forbids hosted competition'],
  ['BUSL-1.1', 'source-available; converts to an open licence after a change window'],
  ['Elastic-2.0', 'source-available; forbids competing services'],
  ['CC-BY-NC-4.0', 'non-commercial; incompatible with a project that promises to stay free'],
  ['CC-BY-NC-SA-4.0', 'non-commercial and copyleft'],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tryReadJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

/** Every workspace package.json, excluding node_modules. */
function workspacePackages() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.name === 'packages' || entry.name === 'apps') {
        walk(full, depth + 1);
        continue;
      }
      const manifest = tryReadJson(join(full, 'package.json'));
      if (manifest) found.push({ name: entry.name, dir: full, manifest });
    }
  };
  walk(ROOT, 0);
  return found;
}

/** Pull a licence out of a manifest, handling the object form. */
function licenceOf(manifest) {
  const value = manifest.licence ?? manifest.license;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type;
  return null;
}

/**
 * Resolve a dependency's declared licence.
 *
 * Walks up from the depending package the way Node's own resolution does. This
 * matters because pnpm uses an isolated layout: a dependency of `@adnota/scene` is
 * not present at the workspace root, only under `packages/scene/node_modules`. A
 * resolver that looks only at the root reports every dependency as unlicensed.
 */
function declaredLicence(fromDir, name) {
  const segments = name.split('/');

  for (let dir = fromDir; ; dir = dirname(dir)) {
    const direct = tryReadJson(join(dir, 'node_modules', ...segments, 'package.json'));
    if (direct) {
      const found = licenceOf(direct);
      if (found) return found;
    }

    const link = join(dir, 'node_modules', ...segments);
    try {
      const manifest = tryReadJson(join(realpathSync(link), 'package.json'));
      if (manifest) {
        const found = licenceOf(manifest);
        if (found) return found;
      }
    } catch {
      /* Not a link, or it does not resolve. */
    }

    const parent = dirname(dir);
    if (parent === dir) break;
  }

  return null;
}

/**
 * Normalise the many spellings of the same licence, and resolve dual licensing.
 *
 * A dual-licensed dependency is fine as long as one arm is permissive, because we
 * can simply choose that arm and owe nothing. Several popular packages ship as
 * "MIT or GPL-3.0", which would otherwise be reported as unknown and force a
 * pointless manual allowlist entry.
 */
function normalise(licence) {
  if (!licence) return null;

  // Strip only the wrapping parentheses, never their contents. Stripping the content
  // is how `(MIT OR GPL-3.0-or-later)` silently becomes the empty string, which is
  // exactly how JSZip declares itself.
  const value = licence.trim().replace(/^\((.*)\)$/s, '$1').trim();

  // Pick the most permissive arm of a dual licence. `OR` is the SPDX operator; some
  // packages spell it lowercase.
  if (/\s+(?:OR|or)\s+/.test(value)) {
    const arms = value.split(/\s+(?:OR|or)\s+/).map((arm) => canonicalise(arm));
    const permissive = arms.find((arm) => ALLOWED.has(arm));
    return permissive ?? arms[0] ?? value;
  }

  return canonicalise(value);
}

function canonicalise(value) {
  const lower = value.trim().toLowerCase();
  if (lower === 'mit') return 'MIT';
  if (lower === 'isc') return 'ISC';
  if (lower.startsWith('apache')) return 'Apache-2.0';
  if (lower === 'new bsd' || lower === 'bsd') return 'BSD-3-Clause';
  if (lower.startsWith('bsd-3')) return 'BSD-3-Clause';
  if (lower.startsWith('bsd-2')) return 'BSD-2-Clause';
  if (lower === '0bsd') return '0BSD';
  if (lower === 'unlicense') return 'Unlicense';
  if (lower.startsWith('cc0')) return 'CC0-1.0';
  return value.trim();
}

const found = new Map();
const problems = [];

for (const pkg of workspacePackages()) {
  const deps = {
    ...(pkg.manifest.dependencies ?? {}),
    ...(pkg.manifest.devDependencies ?? {}),
  };

  for (const [name, range] of Object.entries(deps)) {
    if (String(range).startsWith('workspace:')) continue;
    if (found.has(name)) continue;

    const licence = normalise(declaredLicence(pkg.dir, name));
    found.set(name, licence ?? 'UNKNOWN');

    if (licence === null) {
      problems.push({ name, licence: 'UNKNOWN', reason: 'no readable licence field' });
      continue;
    }

    if (ALLOWED.has(licence)) continue;

    problems.push({
      name,
      licence,
      reason: REJECTED.get(licence) ?? 'not on the permissive allowlist',
    });
  }
}

const byLicence = new Map();
for (const [name, licence] of found) {
  if (!byLicence.has(licence)) byLicence.set(licence, []);
  byLicence.get(licence).push(name);
}

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify({ checked: Object.fromEntries(found), problems }, null, 2),
  );
} else {
  console.log(`Checked ${found.size} direct dependencies across the workspace.`);
  for (const [licence, names] of [...byLicence].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${licence.padEnd(14)} ${names.length}`);
  }

  if (problems.length === 0) {
    console.log('\nAll declared licences are permissive.');
  } else {
    console.error(`\n${problems.length} licence problem(s):\n`);
    for (const problem of problems) {
      console.error(`  ${problem.name}@${problem.licence} - ${problem.reason}`);
    }
    console.error(
      '\nAdnota ships MIT and promises to stay free. A dependency outside the\n' +
        'permissive allowlist breaks that promise even if the build still succeeds.',
    );
  }
}

process.exit(problems.length === 0 ? 0 : 1);
