/**
 * OMC HUD - Multi-Repo Element
 *
 * Renders a multi-repo workspace indicator when the cwd is a parent
 * directory holding multiple sibling git repos (e.g. `bidchex-repos/`
 * containing `bidchex-backend/`, `bidchex-frontend/`, …).
 *
 * Two modes:
 *  - Marker present (`.omc-workspace` at cwd): show
 *      mr:<parent> | repos:N | sessions:M
 *  - Marker missing: show a one-line suggestion to create it.
 *
 * When the cwd IS itself a git repo (single-repo case) this element
 * returns null and the normal repo/branch/status elements take over.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { cyan, dim, green, yellow } from '../colors.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';

interface SessionMeta {
  pid?: number;
  startedAt?: string;
  platform?: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 throws if the process does not exist or is unreachable.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSessionMeta(sessionDir: string): SessionMeta | null {
  const metaPath = join(sessionDir, '_session-meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface MultiRepoInfo {
  isMultiRepo: boolean;
  hasMarker: boolean;
  parentName: string;
  subrepoCount: number;
  activeSessions: number;
}

const multiRepoCache = new Map<string, CacheEntry<MultiRepoInfo | null>>();

/** For tests. */
export function resetMultiRepoCache(): void {
  multiRepoCache.clear();
}

function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

function looksLikeRepo(entryPath: string): boolean {
  // .git can be a directory (normal clone) or a file (worktree / submodule).
  return existsSync(join(entryPath, '.git'));
}

/**
 * Count session directories under `<cwd>/.omc/state/sessions/`.
 * A session is "active" if any file under it was modified within the
 * last 30 minutes. Cheap heuristic — stale dirs from past runs are
 * filtered out so the HUD reflects what's actually live.
 */
function countActiveSessions(cwd: string): number {
  // cwd here is verified to be the workspace anchor (marker present),
  // so getOmcRoot resolves to <cwd>/.omc. Route through the canonical
  // helper so OMC_STATE_DIR and OMC_DISABLE_MULTIREPO are honored.
  const sessionsDir = join(getOmcRoot(cwd), 'state', 'sessions');
  if (!existsSync(sessionsDir)) return 0;

  // Authoritative: PID liveness via _session-meta.json. A session dir
  // without a meta file is not counted — every active session is
  // expected to have been opened by a session-start hook that wrote
  // the marker.
  let active = 0;
  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = readSessionMeta(join(sessionsDir, entry.name));
      if (!meta || typeof meta.pid !== 'number') continue;
      if (isPidAlive(meta.pid)) active++;
    }
  } catch {
    return 0;
  }
  return active;
}

/**
 * Detect multi-repo workspace state for the given cwd.
 *
 * Returns null when:
 *  - cwd is itself a git repo (single-repo case — let the normal git
 *    elements handle it)
 *  - cwd has fewer than 2 git-repo children (not actually multi-repo)
 *
 * Returns a populated MultiRepoInfo otherwise.
 */
export function detectMultiRepo(cwd?: string): MultiRepoInfo | null {
  const key = cwd ? resolve(cwd) : process.cwd();
  const cached = multiRepoCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  let result: MultiRepoInfo | null = null;
  try {
    // If cwd is inside a git repo, skip — that's the single-repo path.
    if (isGitRepo(key)) {
      multiRepoCache.set(key, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    // Scan one level for sub-repos.
    let subrepoCount = 0;
    try {
      const entries = readdirSync(key, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (looksLikeRepo(join(key, entry.name))) subrepoCount++;
      }
    } catch {
      // unreadable cwd — nothing to report
    }

    if (subrepoCount < 2) {
      multiRepoCache.set(key, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const hasMarker = existsSync(join(key, '.omc-workspace'));
    const activeSessions = hasMarker ? countActiveSessions(key) : 0;
    result = {
      isMultiRepo: true,
      hasMarker,
      parentName: basename(key),
      subrepoCount,
      activeSessions,
    };
  } catch {
    result = null;
  }

  multiRepoCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Render the multi-repo chip. Returns null when not in a multi-repo
 * parent (the caller should fall through to renderGitRepo/Branch/Status).
 *
 * Examples:
 *   mr:bidchex-repos repos:11 sessions:2
 *   multi-repo detected — create .omc-workspace to enable shared state
 */
export function renderMultiRepo(cwd?: string): string | null {
  const info = detectMultiRepo(cwd);
  if (!info || !info.isMultiRepo) return null;

  if (!info.hasMarker) {
    return (
      yellow('⚠ multi-repo detected') +
      dim(' — run: ') +
      cyan(`echo {} > "${info.parentName}/.omc-workspace"`) +
      dim(' to enable shared state')
    );
  }

  // ~ prefix signals the count is best-effort: new sessions use PID
  // liveness (accurate), legacy sessions fall back to mtime (heuristic).
  const sessionsPart =
    info.activeSessions > 0
      ? ` ${dim('sessions:~')}${green(String(info.activeSessions))}`
      : ` ${dim('sessions:~')}${dim('0')}`;

  return (
    `${dim('mr:')}${cyan(info.parentName)}` +
    ` ${dim('repos:')}${cyan(String(info.subrepoCount))}` +
    sessionsPart
  );
}
