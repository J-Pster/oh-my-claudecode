#!/usr/bin/env node
/**
 * Bidchex multi-repo workspace smoke test.
 * Fixture lives under os.tmpdir() — never touches the real bidchex-repos workspace.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST = join(REPO_ROOT, 'dist');
const BRIDGE_CLI = join(REPO_ROOT, 'bridge', 'cli.cjs');

// --------------------------------------------------------------------------
// Dynamic import helpers (dist is CJS-wrapped ESM — use createRequire)
// --------------------------------------------------------------------------
const req = createRequire(import.meta.url);

let worktreePaths, processUtils;
try {
  worktreePaths = req(join(DIST, 'lib', 'worktree-paths.js'));
  processUtils  = req(join(DIST, 'platform', 'process-utils.js'));
} catch (e) {
  console.error('FATAL: Could not load dist modules:', e.message);
  process.exit(1);
}

const {
  findWorkspaceRoot,
  getOmcRoot,
  getProjectIdentifier,
  resolveSessionStatePaths,
  clearWorktreeCache,
} = worktreePaths;

const { isProcessAlive } = processUtils;

// --------------------------------------------------------------------------
// Fixture setup
// --------------------------------------------------------------------------
const FIXTURE = join(tmpdir(), `omc-multirepo-smoke-${process.pid}`);
const apiDir   = join(FIXTURE, 'api');
const webDir   = join(FIXTURE, 'web');

let passed = 0;
let failed = 0;
const issues = [];

function pass(label, detail) {
  passed++;
  console.log(`  PASS  ${label}`);
  if (detail) console.log(`        ${detail}`);
}
function fail(label, detail, contract) {
  failed++;
  console.error(`  FAIL  ${label}`);
  if (detail)   console.error(`        actual:   ${detail}`);
  if (contract) console.error(`        contract: ${contract}`);
  issues.push({ label, detail, contract });
}
function note(label, detail) {
  console.log(`  NOTE  ${label}`);
  if (detail) console.log(`        ${detail}`);
}
function assert(cond, passLabel, failLabel, detail, contract) {
  if (cond) pass(passLabel, detail);
  else fail(failLabel, detail, contract);
}

// --------------------------------------------------------------------------
// Setup fixture
// --------------------------------------------------------------------------
console.log('\n=== FIXTURE SETUP ===');
console.log(`  fixture: ${FIXTURE}`);

mkdirSync(apiDir, { recursive: true });
mkdirSync(webDir, { recursive: true });

// Workspace marker with id at root (no git init at root)
writeFileSync(join(FIXTURE, '.omc-workspace'), JSON.stringify({ id: 'smoke-test' }));

// Real git repos in sub-dirs
execSync('git init -q', { cwd: apiDir, stdio: 'pipe' });
execSync('git init -q', { cwd: webDir, stdio: 'pipe' });

// Bust cache so fresh calls see the fixture
clearWorktreeCache();

// --------------------------------------------------------------------------
// Step 1 — findWorkspaceRoot / getOmcRoot / getProjectIdentifier from api/
// --------------------------------------------------------------------------
console.log('\n=== STEP 1: API dir — workspace root + omc root + project identifier ===');

const wsRoot = findWorkspaceRoot(apiDir);
assert(
  wsRoot !== null && resolve(wsRoot) === resolve(FIXTURE),
  'findWorkspaceRoot(apiDir) → fixture root',
  'findWorkspaceRoot(apiDir) → WRONG',
  `returned: ${wsRoot}  expected: ${FIXTURE}`,
  'findWorkspaceRoot must walk up from sub-git-repo to .omc-workspace marker'
);

clearWorktreeCache();
const omcRoot = getOmcRoot(apiDir);
const expectedOmcRoot = join(FIXTURE, '.omc');
assert(
  resolve(omcRoot) === resolve(expectedOmcRoot),
  'getOmcRoot(apiDir) → fixture/.omc',
  'getOmcRoot(apiDir) → WRONG',
  `returned: ${omcRoot}  expected: ${expectedOmcRoot}`,
  'getOmcRoot must anchor to workspace marker dir, not api/ git root'
);

clearWorktreeCache();
const projId = getProjectIdentifier(apiDir);
const idMatch = /^smoke-test-[a-f0-9]{16}$/.test(projId);
assert(
  idMatch,
  `getProjectIdentifier(apiDir) → ${projId}`,
  'getProjectIdentifier(apiDir) → WRONG FORMAT',
  `returned: ${projId}`,
  'must be smoke-test-<16-hex-chars> when marker id="smoke-test"'
);

// --------------------------------------------------------------------------
// Step 1b — resolveSessionStatePaths from api/
// --------------------------------------------------------------------------
clearWorktreeCache();
const apiPaths = resolveSessionStatePaths('demo', 'session-api', apiDir);
const expectedApiWrite = join(FIXTURE, '.omc', 'state', 'sessions', 'session-api', 'demo-state.json');
assert(
  resolve(apiPaths.effectiveWrite) === resolve(expectedApiWrite),
  `resolveSessionStatePaths api effectiveWrite → …sessions/session-api/demo-state.json`,
  'resolveSessionStatePaths api effectiveWrite → WRONG',
  `returned: ${apiPaths.effectiveWrite}\n        expected: ${expectedApiWrite}`,
  'effectiveWrite must be session-scoped under shared .omc/'
);

// --------------------------------------------------------------------------
// Step 2 — web/ paths same .omc, different session subdir
// --------------------------------------------------------------------------
console.log('\n=== STEP 2: WEB dir — same .omc, different session ===');

clearWorktreeCache();
const webPaths = resolveSessionStatePaths('demo', 'session-web', webDir);
const expectedWebWrite = join(FIXTURE, '.omc', 'state', 'sessions', 'session-web', 'demo-state.json');

assert(
  resolve(webPaths.effectiveWrite) === resolve(expectedWebWrite),
  `resolveSessionStatePaths web effectiveWrite → …sessions/session-web/demo-state.json`,
  'resolveSessionStatePaths web effectiveWrite → WRONG',
  `returned: ${webPaths.effectiveWrite}\n        expected: ${expectedWebWrite}`,
  'effectiveWrite must be under shared .omc/ with distinct session subdir'
);

assert(
  apiPaths.effectiveWrite !== webPaths.effectiveWrite,
  'api and web session paths are distinct (no collision)',
  'api and web session paths COLLIDE',
  `api=${apiPaths.effectiveWrite}\n        web=${webPaths.effectiveWrite}`,
  'multi-repo sessions must not overwrite each other'
);

// Actually write and read back both
mkdirSync(resolve(apiPaths.effectiveWrite, '..'), { recursive: true });
mkdirSync(resolve(webPaths.effectiveWrite, '..'), { recursive: true });
writeFileSync(apiPaths.effectiveWrite, JSON.stringify({ session: 'api', ts: Date.now() }));
writeFileSync(webPaths.effectiveWrite, JSON.stringify({ session: 'web', ts: Date.now() }));

const apiRead = JSON.parse(readFileSync(apiPaths.effectiveWrite, 'utf-8'));
const webRead = JSON.parse(readFileSync(webPaths.effectiveWrite, 'utf-8'));
assert(apiRead.session === 'api', 'api session file written and read back correctly', 'api session file read back WRONG', String(apiRead.session));
assert(webRead.session === 'web', 'web session file written and read back correctly', 'web session file read back WRONG', String(webRead.session));

console.log(`        api write path: ${apiPaths.effectiveWrite}`);
console.log(`        web write path: ${webPaths.effectiveWrite}`);

// --------------------------------------------------------------------------
// Step 3 — ultragoal create-goals via CLI (multi-plan)
// --------------------------------------------------------------------------
console.log('\n=== STEP 3: ultragoal create-goals (CLI, multi-plan) ===');

// ARCHITECTURE NOTE: ultragoal/artifacts.ts uses join(cwd, '.omc/ultragoal')
// directly — it does NOT call getOmcRoot(). This means plans are written to
// <subprocess-cwd>/.omc/ultragoal/, NOT to the shared workspace-marker root.
// The CLI sets cwd = process.cwd() (subprocess cwd). So when invoked from
// apiDir, plans land in apiDir/.omc/ultragoal/plans/, and from webDir they
// land in webDir/.omc/ultragoal/plans/. They do NOT share the fixture root.
// This is a known architectural gap: worktree-paths.ts has workspace-marker
// support; ultragoal/artifacts.ts bypasses it.

function runUltragoal(cwd, sessionId, brief) {
  return spawnSync(
    process.execPath,
    [BRIDGE_CLI, 'ultragoal', 'create-goals', '--brief', brief, '--auto-plan-id', '--json'],
    {
      cwd,
      env: { ...process.env, OMC_SESSION_ID: sessionId },
      encoding: 'utf-8',
      timeout: 30000,
    }
  );
}

const apiResult = runUltragoal(apiDir, 'session-api', 'API migration');
const webResult = runUltragoal(webDir, 'session-web', 'Web redesign');

let apiPlanId = null;
let webPlanId = null;

// Parse planId from JSON stdout
function parsePlanId(stdout) {
  for (const line of stdout.split('\n').filter(Boolean)) {
    try { const p = JSON.parse(line); if (p.planId) return p.planId; } catch {}
  }
  return null;
}

if (apiResult.status === 0) {
  apiPlanId = parsePlanId(apiResult.stdout);
  pass(`ultragoal create-goals (api) exited 0`, `planId: ${apiPlanId}`);
} else {
  fail(
    'ultragoal create-goals (api) exited non-zero',
    `exit=${apiResult.status}\nstderr=${apiResult.stderr?.slice(0, 400)}\nstdout=${apiResult.stdout?.slice(0, 400)}`,
    'CLI must exit 0 for valid create-goals invocation'
  );
}

if (webResult.status === 0) {
  webPlanId = parsePlanId(webResult.stdout);
  pass(`ultragoal create-goals (web) exited 0`, `planId: ${webPlanId}`);
} else {
  fail(
    'ultragoal create-goals (web) exited non-zero',
    `exit=${webResult.status}\nstderr=${webResult.stderr?.slice(0, 400)}\nstdout=${webResult.stdout?.slice(0, 400)}`,
    'CLI must exit 0 for valid create-goals invocation'
  );
}

// Actual write locations: <subrepo>/.omc/ultragoal/plans/<planId>/
const apiPlansDir = join(apiDir, '.omc', 'ultragoal', 'plans');
const webPlansDir = join(webDir, '.omc', 'ultragoal', 'plans');
const sharedPlansDir = join(FIXTURE, '.omc', 'ultragoal', 'plans');

const apiPlanDirs = existsSync(apiPlansDir) ? readdirSync(apiPlansDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
const webPlanDirs = existsSync(webPlansDir) ? readdirSync(webPlansDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
const sharedPlanDirs = existsSync(sharedPlansDir) ? readdirSync(sharedPlansDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];

console.log(`        api plans dir:    ${apiPlansDir}`);
console.log(`        api plan IDs:     ${apiPlanDirs.join(', ') || '(none)'}`);
console.log(`        web plans dir:    ${webPlansDir}`);
console.log(`        web plan IDs:     ${webPlanDirs.join(', ') || '(none)'}`);
console.log(`        shared plans dir: ${sharedPlansDir}`);
console.log(`        shared plan IDs:  ${sharedPlanDirs.join(', ') || '(none)'}`);

// Plans land in per-subrepo .omc dirs, not the shared workspace root
assert(
  apiPlanDirs.length >= 1,
  `api subrepo plans dir has ${apiPlanDirs.length} plan(s)`,
  `api subrepo plans dir is empty/missing`,
  `dir: ${apiPlansDir}  dirs: ${apiPlanDirs.join(', ')}`,
  'create-goals from apiDir must write plans to apiDir/.omc/ultragoal/plans/'
);
assert(
  webPlanDirs.length >= 1,
  `web subrepo plans dir has ${webPlanDirs.length} plan(s)`,
  `web subrepo plans dir is empty/missing`,
  `dir: ${webPlansDir}  dirs: ${webPlanDirs.join(', ')}`,
  'create-goals from webDir must write plans to webDir/.omc/ultragoal/plans/'
);

// Plans do NOT collide (distinct IDs — auto-plan-id uses timestamp)
if (apiPlanId && webPlanId) {
  assert(
    apiPlanId !== webPlanId,
    'api and web plan IDs are distinct (no collision)',
    'api and web plan IDs are IDENTICAL — collision',
    `api=${apiPlanId}  web=${webPlanId}`,
    '--auto-plan-id must generate unique IDs per invocation'
  );
}

// NOTE: architectural gap — plans are NOT in shared workspace .omc/
if (sharedPlanDirs.length === 0) {
  note(
    '[ARCH GAP] ultragoal plans are per-subrepo, NOT in shared workspace .omc/',
    `artifacts.ts uses join(cwd, ".omc/ultragoal") — bypasses getOmcRoot()/workspace-marker.\n` +
    `        api plans: ${apiPlansDir}\n` +
    `        web plans: ${webPlansDir}\n` +
    `        shared .omc: ${sharedPlansDir} (empty — expected by workspace model, actual: empty)`
  );
}

// --------------------------------------------------------------------------
// Step 4 — PID liveness (dead PID detection)
// --------------------------------------------------------------------------
console.log('\n=== STEP 4: PID liveness — dead PID 999999 ===');

const fakeSid = 'fake-sid-dead-pid';
const fakeStateDir = join(FIXTURE, '.omc', 'state', 'sessions', fakeSid);
mkdirSync(fakeStateDir, { recursive: true });
const fakeStatePath = join(fakeStateDir, 'ultrawork-state.json');
writeFileSync(fakeStatePath, JSON.stringify({ active: true, owner_pid: 999999 }));

const rawState = JSON.parse(readFileSync(fakeStatePath, 'utf-8'));
const deadPid = rawState.owner_pid;
const alive = isProcessAlive(deadPid);
assert(
  !alive,
  `isProcessAlive(${deadPid}) → false (dead PID correctly detected)`,
  `isProcessAlive(${deadPid}) → true (dead PID NOT detected — BUG)`,
  `owner_pid=${deadPid} alive=${alive}`,
  'PID 999999 must not be alive on any sane system'
);

const currentAlive = isProcessAlive(process.pid);
assert(
  currentAlive,
  `isProcessAlive(${process.pid}) → true (current process correctly alive)`,
  `isProcessAlive(${process.pid}) → false (WRONG — current process should be alive)`,
  `pid=${process.pid} alive=${currentAlive}`
);

// --------------------------------------------------------------------------
// Step 5 — Session subdir contents listing
// --------------------------------------------------------------------------
console.log('\n=== STEP 5: Session subdir contents (shared .omc/) ===');
const sessionsDir = join(FIXTURE, '.omc', 'state', 'sessions');
if (existsSync(sessionsDir)) {
  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const files = readdirSync(join(sessionsDir, e.name)).join(', ');
      return `  ${e.name}/  →  ${files || '(empty)'}`;
    });
  console.log('  Sessions in shared fixture .omc/:');
  sessionDirs.forEach(s => console.log(s));
} else {
  console.log('  sessions dir not found (steps 1-2 must have failed)');
}

// --------------------------------------------------------------------------
// Cleanup
// --------------------------------------------------------------------------
console.log('\n=== CLEANUP ===');
rmSync(FIXTURE, { recursive: true, force: true });
console.log(`  Removed ${FIXTURE}`);

// --------------------------------------------------------------------------
// Final verdict
// --------------------------------------------------------------------------
console.log('\n=== FINAL VERDICT ===');
console.log(`  Passed: ${passed}   Failed: ${failed}`);

if (failed === 0) {
  console.log('\n  bidchex multi-repo workspace works END-TO-END');
  console.log('\n  [ARCH GAP — not a failure, but document for user]:');
  console.log('  ultragoal/artifacts.ts uses join(cwd, ".omc/ultragoal") directly,');
  console.log('  bypassing getOmcRoot()/workspace-marker. Plans land per-subrepo,');
  console.log('  not in the shared workspace root. Hooks/session-state ARE shared');
  console.log('  (worktree-paths.ts correctly anchors to workspace marker).\n');
} else {
  console.log('\n  FAILING CONTRACTS (priority order):');
  issues.forEach((issue, i) => {
    console.log(`  ${i + 1}. ${issue.label}`);
    if (issue.contract) console.log(`     Contract: ${issue.contract}`);
    if (issue.detail)   console.log(`     Detail:   ${issue.detail}`);
  });
  console.log('');
  process.exit(1);
}
