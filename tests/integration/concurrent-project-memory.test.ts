/**
 * E.4 — Concurrent project-memory writes (Wave E)
 *
 * Verifies that two concurrent writers each appending to project-memory.json
 * via withProjectMemoryLock do not lose each other's data (no lost updates).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withProjectMemoryLock } from '../../src/hooks/project-memory/storage.js';

describe('concurrent project-memory writes (E.4)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Read the raw notes array from project-memory.json.
   * Returns [] if file is absent or malformed.
   */
  function readNotes(projectRoot: string): string[] {
    const memPath = join(projectRoot, '.omc', 'project-memory.json');
    try {
      if (!existsSync(memPath)) return [];
      const raw = JSON.parse(readFileSync(memPath, 'utf-8'));
      return Array.isArray(raw.notes) ? raw.notes : [];
    } catch {
      return [];
    }
  }

  /**
   * Append a note to project-memory.json under the advisory lock.
   * Mirrors a real read-modify-write cycle.
   */
  async function appendNote(projectRoot: string, note: string): Promise<void> {
    const memPath = join(projectRoot, '.omc', 'project-memory.json');
    await withProjectMemoryLock(projectRoot, () => {
      const current = (() => {
        try {
          if (!existsSync(memPath)) return { notes: [] as string[] };
          return JSON.parse(readFileSync(memPath, 'utf-8')) as { notes: string[] };
        } catch {
          return { notes: [] as string[] };
        }
      })();

      current.notes = [...(current.notes ?? []), note];
      const dir = join(memPath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(memPath, JSON.stringify(current, null, 2), 'utf-8');
    });
  }

  it('two concurrent writers preserve both notes (no lost updates)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-pmem-concurrent-'));
    mkdirSync(join(tempDir, '.omc'), { recursive: true });

    await Promise.all([
      appendNote(tempDir, 'note-from-writer-A'),
      appendNote(tempDir, 'note-from-writer-B'),
    ]);

    const notes = readNotes(tempDir);
    expect(notes).toContain('note-from-writer-A');
    expect(notes).toContain('note-from-writer-B');
    expect(notes.length).toBe(2);
  });

  it('three concurrent writers each preserve their note', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-pmem-three-'));
    mkdirSync(join(tempDir, '.omc'), { recursive: true });

    await Promise.all([
      appendNote(tempDir, 'note-A'),
      appendNote(tempDir, 'note-B'),
      appendNote(tempDir, 'note-C'),
    ]);

    const notes = readNotes(tempDir);
    expect(notes).toContain('note-A');
    expect(notes).toContain('note-B');
    expect(notes).toContain('note-C');
    expect(notes.length).toBe(3);
  });
});
