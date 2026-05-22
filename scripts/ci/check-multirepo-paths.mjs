#!/usr/bin/env node
/**
 * AST-grep CI gate: detect raw .omc path constructions that bypass
 * resolveSessionStatePaths() / getOmcRoot() / resolveOmcStateRoot().
 *
 * Exits non-zero if any match is found outside the whitelist.
 * Run: node scripts/ci/check-multirepo-paths.mjs [--root <dir>]
 */
import { createRequire } from 'node:module';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync, readFileSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Parse --root argument
const rootArgIdx = process.argv.indexOf('--root');
const searchRoot = rootArgIdx !== -1 ? resolve(process.argv[rootArgIdx + 1]) : REPO_ROOT;

// Files/dirs that are intentionally allowed to contain raw .omc constructions.
// Canonical delegators own the path logic; test files assert on constructed paths;
// scripts/* uses homedir()/.omc for global config (intentional, not workspace state).
const WHITELIST_FILES = new Set([
  'src/lib/worktree-paths.ts',
  'scripts/lib/state-root.mjs',
  'scripts/lib/state-root.cjs',
  'scripts/ci/check-multirepo-paths.mjs',
].map(p => resolve(REPO_ROOT, p)));

// Entire directories whitelisted (raw paths are legitimate in these contexts)
const WHITELIST_DIRS = [
  resolve(REPO_ROOT, 'tests'),
  resolve(REPO_ROOT, 'scripts'),          // scripts use homedir()/.omc for global config
  resolve(REPO_ROOT, 'src', 'lib'),       // worktree-paths.ts is the canonical source
  resolve(REPO_ROOT, 'src'),              // __tests__ under src/ construct raw paths for assertions
  resolve(REPO_ROOT, 'templates'),        // hook templates use homedir()/.omc for global config/update-check (intentional)
];

function isWhitelisted(filePath) {
  const abs = resolve(filePath);
  if (WHITELIST_FILES.has(abs)) return true;
  for (const dir of WHITELIST_DIRS) {
    if (abs.startsWith(dir + sep) || abs.startsWith(dir + '/')) return true;
  }
  // Any __tests__ directory anywhere in the repo
  if (abs.includes(`${sep}__tests__${sep}`) || abs.includes('/__tests__/')) return true;
  return false;
}

const req = createRequire(resolve(REPO_ROOT, 'package.json'));
let sg;
try {
  sg = req('@ast-grep/napi');
} catch (e) {
  console.error('ERROR: @ast-grep/napi not found. Run npm ci first.');
  process.exit(2);
}

const { parse, Lang } = sg;

// Patterns to search — (language, pattern string) pairs
const TS_PATTERNS = [
  "join($_, '.omc', $$$)",
  'join($_, ".omc", $$$)',
  "path.join($_, '.omc', $$$)",
];
const JS_PATTERNS = [
  "join($_, '.omc', $$$)",
  'join($_, ".omc", $$$)',
  "path.join($_, '.omc', $$$)",
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'bridge', 'coverage', '.omc']);

function* walkFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

let totalHits = 0;
const hitLines = [];

for (const filePath of walkFiles(searchRoot)) {
  const ext = filePath.split('.').pop();
  let lang, patterns;
  if (ext === 'ts' || ext === 'tsx') {
    lang = Lang.TypeScript;
    patterns = TS_PATTERNS;
  } else if (ext === 'mjs' || ext === 'cjs' || ext === 'js') {
    lang = Lang.JavaScript;
    patterns = JS_PATTERNS;
  } else {
    continue;
  }

  if (isWhitelisted(filePath)) continue;

  let src;
  try { src = readFileSync(filePath, 'utf-8'); } catch { continue; }

  let root;
  try { root = parse(lang, src); } catch { continue; }

  const sgRoot = root.root();
  for (const pat of patterns) {
    let matches;
    try { matches = sgRoot.findAll(pat); } catch { continue; }
    for (const match of matches) {
      const pos = match.range().start;
      const rel = relative(REPO_ROOT, filePath);
      const line = pos?.line ?? '?';
      const text = match.text().trim().slice(0, 80);
      hitLines.push(`  ${rel}:${line}  ${text}`);
      totalHits++;
    }
  }
}

if (totalHits === 0) {
  console.log('multirepo-paths gate: OK (no raw .omc constructions found outside whitelist)');
  process.exit(0);
} else {
  console.error(`multirepo-paths gate: FAIL — ${totalHits} raw .omc construction(s) found:\n`);
  for (const line of hitLines) {
    console.error(line);
  }
  console.error('\nFix: use resolveSessionStatePaths() / getOmcRoot() / resolveOmcStateRoot() instead.');
  process.exit(1);
}
